#!/usr/bin/env node
'use strict';

/*
 * Party relay: the server half of the PartyWin.dll replacement.
 *
 * A "network" in PlayFab Party is a room of devices; each device owns endpoints,
 * and a message is sent from one endpoint to a set of endpoints. Everything the
 * game needs from Azure's relay is that and nothing else, so this is a room
 * table plus a fan-out. The client half is native/partyshim/shim.cpp.
 *
 * Wire format (little-endian), one frame = u32 length | u8 type | payload, where
 * length counts the type byte and the payload. Strings are u8 length + bytes,
 * blobs are u32 length + bytes.
 *
 *   client -> relay
 *     1 JOIN            u8 create | str networkId | str entityId | config(6 x u32)
 *     2 CREATE_ENDPOINT u32 req | u16 propCount | { str key, blob value }*
 *     3 DESTROY_ENDPOINT u32 endpointId
 *     4 MESSAGE         u32 srcEndpoint | u16 n | u32 target*n | u32 options | blob
 *     5 LEAVE
 *   relay -> client
 *     101 JOIN_OK          u32 deviceId | config(6 x u32)
 *     102 JOIN_ERR         u8 code (1 no such network, 2 network full)
 *     103 DEVICE_JOINED    u32 deviceId | str entityId
 *     104 DEVICE_LEFT      u32 deviceId
 *     105 ENDPOINT_CREATED u32 endpointId | u32 deviceId | str entityId | u16 propCount | props
 *     106 ENDPOINT_DESTROYED u32 endpointId
 *     107 MESSAGE          u32 srcEndpoint | u16 n | u32 receiver*n | u32 options | blob
 *     108 ENDPOINT_ASSIGNED u32 req | u32 endpointId
 *
 * The relay is deliberately dumb: it never interprets a message body, so a game
 * patch that changes the game protocol cannot break it.
 */

const net = require('node:net');

const T = Object.freeze({
  JOIN: 1, CREATE_ENDPOINT: 2, DESTROY_ENDPOINT: 3, MESSAGE: 4, LEAVE: 5,
  JOIN_OK: 101, JOIN_ERR: 102, DEVICE_JOINED: 103, DEVICE_LEFT: 104,
  ENDPOINT_CREATED: 105, ENDPOINT_DESTROYED: 106, MESSAGE_OUT: 107, ENDPOINT_ASSIGNED: 108,
});
const MAX_FRAME = 8 * 1024 * 1024;
const CONFIG_WORDS = 6;

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  need(n) { if (this.pos + n > this.buf.length) throw new RangeError('truncated frame'); }
  u8() { this.need(1); return this.buf[this.pos++]; }
  u16() { this.need(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  str() { const n = this.u8(); this.need(n); const s = this.buf.toString('utf8', this.pos, this.pos + n); this.pos += n; return s; }
  blob() { const n = this.u32(); this.need(n); const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
}

class Writer {
  constructor() { this.parts = []; }
  u8(v) { const b = Buffer.alloc(1); b[0] = v; this.parts.push(b); return this; }
  u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); this.parts.push(b); return this; }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this.parts.push(b); return this; }
  str(s) { const b = Buffer.from(s, 'utf8'); if (b.length > 255) throw new RangeError('string too long'); this.u8(b.length); this.parts.push(b); return this; }
  blob(b) { this.u32(b.length); this.parts.push(b); return this; }
  frame(type) {
    const body = Buffer.concat(this.parts);
    const head = Buffer.alloc(5);
    head.writeUInt32LE(body.length + 1, 0);
    head[4] = type;
    return Buffer.concat([head, body]);
  }
}

function createRelay({ log = () => {} } = {}) {
  const rooms = new Map();     // networkId -> Room
  let nextDevice = 1;
  let nextEndpoint = 1;

  const send = (dev, type, w) => { if (!dev.socket.destroyed) dev.socket.write(w.frame(type)); };

  function endpointCreatedFrame(ep) {
    const w = new Writer().u32(ep.id).u32(ep.device.id).str(ep.entityId).u16(ep.props.length);
    for (const p of ep.props) w.str(p.key).blob(p.value);
    return w;
  }

  function removeDevice(dev, reason) {
    const room = dev.room;
    if (!room) return;
    dev.room = null;
    room.devices.delete(dev.id);
    for (const ep of [...dev.endpoints]) {
      room.endpoints.delete(ep.id);
      for (const other of room.devices.values()) send(other, T.ENDPOINT_DESTROYED, new Writer().u32(ep.id));
    }
    dev.endpoints.length = 0;
    for (const other of room.devices.values()) send(other, T.DEVICE_LEFT, new Writer().u32(dev.id));
    log(`device ${dev.id} left ${room.id} (${reason}); ${room.devices.size} remain`);
    if (!room.devices.size) { rooms.delete(room.id); log(`network ${room.id} closed`); }
  }

  function handle(dev, type, r) {
    switch (type) {
      case T.JOIN: {
        if (dev.room) return dev.socket.destroy();
        const create = r.u8() === 1;
        const networkId = r.str();
        const entityId = r.str();
        const config = []; for (let i = 0; i < CONFIG_WORDS; i++) config.push(r.u32());
        let room = rooms.get(networkId);
        if (!room) {
          if (!create) { send(dev, T.JOIN_ERR, new Writer().u8(1)); return; }
          room = { id: networkId, config, devices: new Map(), endpoints: new Map() };
          rooms.set(networkId, room);
          log(`network ${networkId} created`);
        }
        if (room.devices.size >= Math.max(1, room.config[1] || 32)) { send(dev, T.JOIN_ERR, new Writer().u8(2)); return; }
        dev.id = nextDevice++;
        dev.entityId = entityId;
        dev.room = room;
        const existing = [...room.devices.values()];
        room.devices.set(dev.id, dev);
        const ok = new Writer().u32(dev.id);
        for (const c of room.config) ok.u32(c);
        send(dev, T.JOIN_OK, ok);
        // Order matters to the client: devices first, then their endpoints.
        for (const other of existing) send(dev, T.DEVICE_JOINED, new Writer().u32(other.id).str(other.entityId));
        for (const other of existing) for (const ep of other.endpoints) send(dev, T.ENDPOINT_CREATED, endpointCreatedFrame(ep));
        for (const other of existing) send(other, T.DEVICE_JOINED, new Writer().u32(dev.id).str(entityId));
        log(`device ${dev.id} (${entityId}) joined ${networkId}; ${room.devices.size} in room`);
        return;
      }
      case T.CREATE_ENDPOINT: {
        if (!dev.room) return dev.socket.destroy();
        const req = r.u32();
        const n = r.u16();
        const props = [];
        for (let i = 0; i < n; i++) props.push({ key: r.str(), value: Buffer.from(r.blob()) });
        const ep = { id: nextEndpoint++, device: dev, entityId: dev.entityId, props };
        dev.endpoints.push(ep);
        dev.room.endpoints.set(ep.id, ep);
        send(dev, T.ENDPOINT_ASSIGNED, new Writer().u32(req).u32(ep.id));
        for (const other of dev.room.devices.values()) if (other !== dev) send(other, T.ENDPOINT_CREATED, endpointCreatedFrame(ep));
        return;
      }
      case T.DESTROY_ENDPOINT: {
        if (!dev.room) return;
        const id = r.u32();
        const ep = dev.room.endpoints.get(id);
        if (!ep || ep.device !== dev) return;
        dev.room.endpoints.delete(id);
        dev.endpoints.splice(dev.endpoints.indexOf(ep), 1);
        for (const other of dev.room.devices.values()) send(other, T.ENDPOINT_DESTROYED, new Writer().u32(id));
        return;
      }
      case T.MESSAGE: {
        if (!dev.room) return dev.socket.destroy();
        const src = r.u32();
        const n = r.u16();
        const targets = []; for (let i = 0; i < n; i++) targets.push(r.u32());
        const options = r.u32();
        const body = r.blob();
        const from = dev.room.endpoints.get(src);
        if (!from || from.device !== dev) return; // cannot speak for someone else's endpoint
        // One delivery per receiving device, listing that device's targeted endpoints.
        const perDevice = new Map();
        for (const id of targets) {
          const ep = dev.room.endpoints.get(id);
          if (!ep) continue;
          if (!perDevice.has(ep.device)) perDevice.set(ep.device, []);
          perDevice.get(ep.device).push(id);
        }
        for (const [target, ids] of perDevice) {
          const w = new Writer().u32(src).u16(ids.length);
          for (const id of ids) w.u32(id);
          w.u32(options).blob(body);
          send(target, T.MESSAGE_OUT, w);
        }
        return;
      }
      case T.LEAVE:
        removeDevice(dev, 'leave');
        dev.socket.end();
        return;
      default:
        log(`unknown frame type ${type} from device ${dev.id}`);
        dev.socket.destroy();
    }
  }

  const server = net.createServer(socket => {
    socket.setNoDelay(true);
    const dev = { socket, id: 0, entityId: '', room: null, endpoints: [] };
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      try {
        for (;;) {
          if (pending.length < 4) break;
          const len = pending.readUInt32LE(0);
          if (len < 1 || len > MAX_FRAME) throw new RangeError(`bad frame length ${len}`);
          if (pending.length < 4 + len) break;
          const type = pending[4];
          const r = new Reader(pending.subarray(5, 4 + len));
          pending = pending.subarray(4 + len);
          handle(dev, type, r);
        }
      } catch (e) {
        log(`protocol error from device ${dev.id}: ${e.message}`);
        socket.destroy();
      }
    });
    socket.on('close', () => removeDevice(dev, 'disconnect'));
    socket.on('error', () => {});
  });

  return { server, rooms, T, Reader, Writer };
}

module.exports = { createRelay, T, Reader, Writer };

if (require.main === module) {
  const port = Number(process.argv[2] || process.env.PARTY_RELAY_PORT || 7777);
  const host = process.argv[3] || '0.0.0.0';
  const stamp = () => new Date().toISOString().slice(11, 23);
  const { server } = createRelay({ log: m => console.log(`[${stamp()}] ${m}`) });
  server.listen(port, host, () => console.log(`[${stamp()}] party relay listening on ${host}:${port}`));
}
