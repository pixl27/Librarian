/**
 * A ZIP writer for the one archive Librarian produces itself: the manifest
 * package the steammanifest source assembles (src/core/steamManifest.js), in
 * the shape Hubcap serves — one .lua, one .manifest per depot. The reader on
 * the other side is yauzl, in src/core/zipProcessor.js.
 *
 * Classic ZIP only: deflate or store per entry, UTF-8 names, no ZIP64, no
 * encryption, no data descriptors. Node has a zlib CRC since 22.2; the table
 * below is for the system Node the verifiers may run under.
 */
const fs = require('fs');
const zlib = require('zlib');

let crcTable = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    day: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * @param {Array<{name: string, data: Buffer|string}>} entries
 * @returns {Buffer} the whole archive
 */
function buildZip(entries, { date = new Date() } = {}) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('A ZIP needs at least one entry');
  if (entries.length > 0xFFFF) throw new Error('Too many entries for a classic ZIP');
  const { time, day } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;
  const seen = new Set();

  for (const entry of entries) {
    const rawName = String(entry?.name ?? '');
    // Flat names only: the package is a handful of files, none in a folder.
    if (!rawName || /[\\/]/.test(rawName) || rawName === '.' || rawName === '..') {
      throw new Error(`Invalid ZIP entry name: ${JSON.stringify(rawName)}`);
    }
    if (seen.has(rawName)) throw new Error(`Duplicate ZIP entry: ${rawName}`);
    seen.add(rawName);
    const name = Buffer.from(rawName, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk
    central.writeUInt16LE(0, 36);        // internal attrs
    central.writeUInt32LE(0, 38);        // external attrs
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  if (offset + centralSize > 0xFFFFFFFF) throw new Error('Archive too large for a classic ZIP');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/** Write the archive; refuses to overwrite, like the Hubcap download does. */
function writeZip(file, entries, options) {
  fs.writeFileSync(file, buildZip(entries, options), { flag: 'wx' });
}

module.exports = { buildZip, writeZip, crc32 };
