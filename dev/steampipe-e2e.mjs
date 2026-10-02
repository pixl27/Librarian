#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// End-to-end harness for the SteamPipe engine.
//
// The failure that matters for a downloader is a corrupt install, and no
// structural assertion about the source detects one. So this builds real
// depots — real Valve chunk framing, real AES, real manifests — serves them
// from a real HTTPS origin, drives the real startNativeDownload(), and
// compares the bytes on disk against the bytes it started from.
//
// Run through dev/verify-steampipe-engine.mjs, which re-executes it under the
// shipped Electron runtime (ELECTRON_RUN_AS_NODE). That runtime has zstd and
// the native LZMA decoder; the system Node on this machine has neither, and a
// test that silently skipped the codec most depots use would be worthless.
//
//   node dev/steampipe-e2e.mjs <suite>
//
// Prints `OK <suite>` and exits 0 only when every assertion in the suite has
// passed. Lives in dev/, which electron-builder does not ship.
// ═══════════════════════════════════════════════════════════════════
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The origin is a throwaway self-signed certificate for 127.0.0.1, generated
// per run. Nothing else in the process talks to the network during a test.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ════════════════════════════════════════════════════════════════
// Assertions
// ════════════════════════════════════════════════════════════════

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
  return Boolean(condition);
}
function checkEqual(actual, expected, message) {
  return check(actual === expected, `${message} (expected ${expected}, got ${actual})`);
}

// ════════════════════════════════════════════════════════════════
// Protobuf writers — enough of the wire format to emit a depot manifest
// ════════════════════════════════════════════════════════════════

function varint(value) {
  const out = [];
  let n = BigInt(value);
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) byte |= 0x80;
    out.push(byte);
  } while (n > 0n);
  return Buffer.from(out);
}
const tagOf = (field, wire) => varint((field << 3) | wire);
const fieldVarint = (field, n) => Buffer.concat([tagOf(field, 0), varint(n)]);
const fieldBytes = (field, buf) => Buffer.concat([tagOf(field, 2), varint(buf.length), buf]);
function fieldFixed32(field, n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return Buffer.concat([tagOf(field, 5), b]);
}

function encodeChunkEntry(c) {
  return Buffer.concat([
    fieldBytes(1, c.sha),
    // crc is wire type 5 in the real format. The parser has a comment about
    // exactly this, so emitting it correctly is part of what is being tested.
    fieldFixed32(2, c.crc >>> 0),
    fieldVarint(3, c.offset),
    fieldVarint(4, c.cbOriginal),
    fieldVarint(5, c.cbCompressed),
  ]);
}

function encodeFileEntry(f) {
  const parts = [
    fieldBytes(1, Buffer.from(f.filename, 'utf8')),
    fieldVarint(2, f.size ?? 0),
    fieldVarint(3, f.flags ?? 0),
  ];
  if (f.shaContent) parts.push(fieldBytes(5, f.shaContent));
  for (const c of f.chunks ?? []) parts.push(fieldBytes(6, encodeChunkEntry(c)));
  if (f.linktarget) parts.push(fieldBytes(7, Buffer.from(f.linktarget, 'utf8')));
  return Buffer.concat(parts);
}

const PAYLOAD_MAGIC = 0x71F617D0;
function encodeManifest(files, encrypted = null) {
  if (encrypted !== null) {
    const encodeName = name => encryptChunk(Buffer.from(name + '\0'), DEPOT_KEY).toString('base64').replace(/(.{32})/g, '$1\n') + '\n';
    const entries = encrypted ? files.map(file => ({ ...file, filename: encodeName(file.filename), linktarget: file.linktarget ? encodeName(file.linktarget) : '' })) : files;
    const section = (magic, body) => {
      const head = Buffer.alloc(8);
      head.writeUInt32LE(magic); head.writeUInt32LE(body.length, 4);
      return Buffer.concat([head, body]);
    };
    const end = Buffer.alloc(4); end.writeUInt32LE(0x32c415ab);
    return Buffer.concat([
      section(PAYLOAD_MAGIC, Buffer.concat(entries.map(file => fieldBytes(1, encodeFileEntry(file))))),
      section(0x1f4812be, fieldVarint(4, encrypted ? 1 : 0)),
      section(0x1b81b817, Buffer.alloc(0)), end,
    ]);
  }
  const payload = Buffer.concat(files.map(f => fieldBytes(1, encodeFileEntry(f))));
  const compressed = zlib.deflateSync(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(PAYLOAD_MAGIC, 0);
  head.writeUInt32LE(compressed.length, 4);
  return Buffer.concat([head, compressed]);
}

// ════════════════════════════════════════════════════════════════
// Valve chunk containers
// ════════════════════════════════════════════════════════════════

function frameZip(data) {
  const body = zlib.deflateRawSync(data);
  const head = Buffer.alloc(30);
  head.write('PK\x03\x04', 0, 'latin1');
  head.writeUInt16LE(8, 8);            // method: deflate
  head.writeUInt32LE(data.length, 22); // uncompressed size
  head.writeUInt16LE(0, 26);           // name length
  head.writeUInt16LE(0, 28);           // extra length
  return Buffer.concat([head, body]);
}

/** "VSZ" + 8-byte header, a zstd frame, then crc(4) + size(8) + "zsv". */
function frameVsz(data) {
  if (typeof zlib.zstdCompressSync !== 'function') return null;
  const head = Buffer.alloc(8);
  head.write('VSZ', 0, 'latin1');
  head[3] = 0x61;
  const body = zlib.zstdCompressSync(data);
  const foot = Buffer.alloc(15);
  foot.writeUInt32LE(0, 0);
  foot.writeBigUInt64LE(BigInt(data.length), 4);
  foot.write('zsv', 12, 'latin1');
  return Buffer.concat([head, body, foot]);
}

/** "VZ" + ver + crc(4) + props(5) + LZMA data + crc(4) + size(4) + "zv". */
function frameVz(data) {
  let alone;
  try {
    alone = Buffer.from(require('@napi-rs/lzma').lzma.compressSync(data));
  } catch {
    return null;
  }
  const props = alone.subarray(0, 5);
  const body = alone.subarray(13);      // skip props(5) + the 8-byte size field
  const head = Buffer.alloc(7);
  head.write('VZ', 0, 'latin1');
  head[2] = 0x61;
  head.writeUInt32LE(0, 3);
  const foot = Buffer.alloc(10);
  foot.writeUInt32LE(0, 0);
  foot.writeUInt32LE(data.length, 4);
  foot.write('zv', 8, 'latin1');
  return Buffer.concat([head, props, body, foot]);
}

/** A ZIP container holding the bytes uncompressed — the cheapest chunk to decode. */
function frameStore(data) {
  const head = Buffer.alloc(30);
  head.write('PK\x03\x04', 0, 'latin1');
  head.writeUInt16LE(0, 8);            // method: stored
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(0, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, data]);
}

const CODECS = { zip: frameZip, vsz: frameVsz, vz: frameVz, store: frameStore };

function encryptChunk(framed, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(16);
  const ecb = crypto.createCipheriv('aes-256-ecb', key, null);
  ecb.setAutoPadding(false);
  const encIv = Buffer.concat([ecb.update(iv), ecb.final()]);
  const cbc = crypto.createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([encIv, cbc.update(framed), cbc.final()]);
}

// ════════════════════════════════════════════════════════════════
// Depot construction
// ════════════════════════════════════════════════════════════════

const DEPOT_KEY = 'a'.repeat(64);
const CHUNK = 64 * 1024;

/**
 * Deterministic pseudo-random bytes. Real enough not to compress to nothing,
 * and repeatable so a "build B" can deliberately share content with build A.
 */
function blob(seed, length) {
  const out = Buffer.alloc(length);
  let h = crypto.createHash('sha256').update(String(seed)).digest();
  for (let i = 0; i < length; i += 32) {
    h.copy(out, i, 0, Math.min(32, length - i));
    h = crypto.createHash('sha256').update(h).digest();
  }
  return out;
}

/**
 * @param files  Map<relative path, Buffer>
 * @param codecFor  (index) => 'zip' | 'vsz' | 'vz'
 */
function buildDepot({ depotId, files, dirs = [], keyHex = DEPOT_KEY, codecFor = () => 'zip', chunkSize = CHUNK }) {
  const chunkStore = new Map();     // shaHex -> encrypted body
  const manifestFiles = [];
  let chunkIndex = 0;

  // Directory entries, as real manifests carry them: a name, the directory
  // flag, and no chunks.
  for (const dir of dirs) {
    manifestFiles.push({ filename: dir.replace(/\//g, '\\'), size: 0, flags: 0x40, chunks: [] });
  }

  for (const [name, content] of files) {
    const chunks = [];
    for (let off = 0; off < content.length; off += chunkSize) {
      const slice = content.subarray(off, Math.min(off + chunkSize, content.length));
      const sha = crypto.createHash('sha1').update(slice).digest();
      const hex = sha.toString('hex');
      if (!chunkStore.has(hex)) {
        const codec = codecFor(chunkIndex);
        const framer = CODECS[codec] ?? frameZip;
        const framed = framer(slice) ?? frameZip(slice);
        chunkStore.set(hex, encryptChunk(framed, keyHex));
      }
      chunks.push({
        sha,
        crc: 0,
        offset: off,
        cbOriginal: slice.length,
        cbCompressed: chunkStore.get(hex).length,
      });
      chunkIndex++;
    }
    manifestFiles.push({
      filename: name.replace(/\//g, '\\'),   // depots use Windows separators
      size: content.length,
      flags: 0,
      shaContent: crypto.createHash('sha1').update(content).digest(),
      chunks,
    });
  }

  return { depotId, manifest: encodeManifest(manifestFiles), chunkStore, files };
}

// ════════════════════════════════════════════════════════════════
// The origin
// ════════════════════════════════════════════════════════════════

let cachedTls = null;
function selfSignedTls() {
  if (cachedTls) return cachedTls;
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'librarian-e2e-tls-'));
  const keyPath = join(dir, 'k.pem');
  const certPath = join(dir, 'c.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });
  cachedTls = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), dir };
  return cachedTls;
}

/**
 * One content server.
 *
 * `behaviour(ctx)` may return a directive to misbehave, which is how the mirror
 * tests produce a rate limit or a mirror that answers far too slowly.
 */
async function startOrigin(depots, behaviour = null) {
  const tls = selfSignedTls();
  const byDepot = new Map(depots.map(d => [String(d.depotId), d.chunkStore]));
  const log = { requests: [], aborted: [] };

  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const m = /^\/depot\/(\d+)\/chunk\/([0-9a-f]{40})$/.exec(req.url || '');
    const at = Date.now();
    if (req.method === 'HEAD' || !m) { res.writeHead(404); res.end(); return; }

    const [, depotId, shaHex] = m;
    const entry = { depotId, shaHex, at, host: server._label };
    log.requests.push(entry);

    const directive = behaviour ? behaviour({ depotId, shaHex, count: log.requests.length, log }) : null;

    if (directive?.status) {
      res.writeHead(directive.status, directive.headers || {});
      res.end('');
      return;
    }

    const body = byDepot.get(depotId)?.get(shaHex);
    if (!body) { res.writeHead(404); res.end(); return; }

    if (directive?.corrupt) {
      // A well-formed 200 carrying the wrong bytes: the ciphertext keeps its
      // length, so nothing short of decrypting and hashing can tell.
      const bad = Buffer.from(body);
      bad[bad.length >> 1] ^= 0xff;
      res.writeHead(200, { 'content-length': String(bad.length) });
      res.end(bad);
      return;
    }

    if (directive?.hangMs) {
      // Answer far too slowly, and record whether the client gave up. Nothing
      // else can close this socket: the hang is shorter than the engine's own
      // 30 s request timeout, so an abort here can only be the stall detector.
      let done = false;
      const finish = () => { if (!done) { done = true; res.end(body); } };
      const timer = setTimeout(finish, directive.hangMs);
      req.on('close', () => {
        if (!res.writableEnded) {
          log.aborted.push({ shaHex, afterMs: Date.now() - at });
          clearTimeout(timer);
          done = true;
        }
      });
      return;
    }

    if (directive?.trickle) {
      // A slow line, not a broken mirror: the body keeps arriving, in pieces,
      // and takes far longer in total than any one gap between them.
      const { pieces, everyMs } = directive.trickle;
      res.writeHead(200, { 'content-length': String(body.length) });
      const size = Math.ceil(body.length / pieces);
      let sent = 0;
      const timer = setInterval(() => {
        res.write(body.subarray(sent, sent + size));
        sent += size;
        if (sent >= body.length) { clearInterval(timer); res.end(); }
      }, everyMs);
      req.on('close', () => {
        clearInterval(timer);
        if (!res.writableEnded) log.aborted.push({ shaHex, afterMs: Date.now() - at });
      });
      return;
    }

    if (directive?.silentAfter !== undefined) {
      // Starts the body and then says nothing more, ever. Only the client
      // giving up can end this request.
      res.writeHead(200, { 'content-length': String(body.length) });
      res.write(body.subarray(0, directive.silentAfter));
      req.on('close', () => { log.aborted.push({ shaHex, afterMs: Date.now() - at }); });
      return;
    }

    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  server._label = `127.0.0.1:${port}`;
  return {
    host: `127.0.0.1:${port}`,
    log,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * A stand-in for Steam's content-server directory.
 *
 * Answers each request with the next list in `lists` (the last one repeats),
 * in the JSON shape the real service uses, so resolveCdn() runs unmodified.
 */
async function startDirectory(lists) {
  const tls = selfSignedTls();
  const log = { requests: 0 };
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const list = lists[Math.min(log.requests, lists.length - 1)];
    log.requests++;
    const servers = list.map(host => ({ host, vhost: host, https_support: 'mandatory', type: 'CDN' }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ response: { servers } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `https://127.0.0.1:${server.address().port}/directory`,
    log,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ════════════════════════════════════════════════════════════════
// Engine harness
// ════════════════════════════════════════════════════════════════

let sandboxSeq = 0;
const liveSandboxes = new Set();

/**
 * Remove anything an earlier run left behind, and everything this one made.
 *
 * A suite that throws part-way skips its own cleanup, and these directories sit
 * inside the repository (they have to, so node_modules still resolves), where
 * they would otherwise accumulate and be picked up by file searches.
 */
function sweepSandboxes() {
  for (const box of liveSandboxes) box.dispose();
  liveSandboxes.clear();
  let entries = [];
  try { entries = fs.readdirSync(ROOT); } catch { return; }
  for (const name of entries) {
    if (!name.startsWith('.e2e-sandbox-')) continue;
    try { fs.rmSync(join(ROOT, name), { recursive: true, force: true }); } catch {}
  }
}

/**
 * A private copy of src/core the engine is loaded from.
 *
 * Two reasons. Tests must be able to sabotage the engine — that is the whole
 * point of the negative control — without touching the working tree. And a
 * fresh module registry per scenario keeps one test's settings and lazily
 * created state out of the next one's. The copy lives inside the repository so
 * that `@napi-rs/lzma` and `node-fetch` still resolve from node_modules.
 */
function makeSandbox(mutate = null) {
  const dir = join(ROOT, `.e2e-sandbox-${process.pid}-${sandboxSeq++}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(join(dir, 'src', 'core'), { recursive: true });
  for (const name of fs.readdirSync(join(ROOT, 'src', 'core'))) {
    if (!name.endsWith('.js')) continue;
    fs.copyFileSync(join(ROOT, 'src', 'core', name), join(dir, 'src', 'core', name));
  }
  if (mutate) mutate(join(dir, 'src', 'core'));
  const box = {
    dir,
    corePath: (name) => join(dir, 'src', 'core', name),
    dispose() {
      liveSandboxes.delete(box);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
  liveSandboxes.add(box);
  return box;
}

/** Load a sandboxed engine with `electron` stubbed and settings pre-seeded. */
function loadEngine(sandbox, settings = {}) {
  const userData = fs.mkdtempSync(join(os.tmpdir(), 'librarian-e2e-cfg-'));
  const electronId = require.resolve('electron');
  require.cache[electronId] = {
    id: electronId,
    filename: electronId,
    loaded: true,
    exports: { app: { getPath: () => userData } },
  };

  // Defaults that keep a test from reaching outside itself: no GreenLuma
  // injection into a real Steam config, no auto-crack subprocess, no DNS.
  const merged = {
    slssteam_mode: false,
    auto_crack: false,
    use_lancache: false,
    download_adaptive: false,
    download_max_downloads: 4,
    download_speed_limit: 0,
    validate_fresh_downloads: false,
    ...settings,
  };
  fs.writeFileSync(join(userData, 'librarian-settings.json'),
    JSON.stringify({ ...merged, settings_version: 99 }), 'utf-8');

  // Drop any previously-loaded copy of these modules so each sandbox is fresh.
  for (const id of Object.keys(require.cache)) {
    if (id.includes('.e2e-sandbox-')) delete require.cache[id];
  }
  // Sandboxes copy application sources, while dependencies stay in ROOT.
  const pathsId = sandbox.corePath('runtimePaths.js');
  require.cache[pathsId] = { id: pathsId, filename: pathsId, loaded: true,
    exports: { getDepsRoot: () => join(ROOT, 'deps'), getDepsPath: (...parts) => join(ROOT, 'deps', ...parts) } };
  const engine = require(sandbox.corePath('steamPipe.js'));
  return { engine, userData };
}

/**
 * Drive one job to completion (or to the stop the caller asks for).
 *
 * @returns {{ok:boolean, error:string|null, log:string[], plan:object|null, handle:object}}
 */
function runJob(engine, { gameData, depots, destPath, onTick = null, target = null }) {
  return new Promise((resolve) => {
    const log = [];
    let plan = null;
    let handle = null;
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, log, plan, handle });
    };

    const callbacks = {
      onProgress: (m) => {
        log.push(String(m));
        if (onTick) { try { onTick({ kind: 'progress', message: String(m), handle, log }); } catch {} }
      },
      onPercentage: (p) => { if (onTick) { try { onTick({ kind: 'pct', pct: p, handle, log }); } catch {} } },
      onSpeed: () => {},
      onDiskSpeed: () => {},
      onTransferred: () => {},
      onPlan: (p) => { plan = p; },
      onComplete: () => done({ ok: true, error: null }),
      onError: (e) => done({ ok: false, error: String(e) }),
    };

    try {
      handle = engine.startNativeDownload(gameData, depots, destPath, callbacks, target);
    } catch (err) {
      done({ ok: false, error: String(err.message || err) });
      return;
    }
    // A stopped job neither completes nor errors, so give the caller a way out.
    if (onTick) { try { onTick({ kind: 'started', handle, log, resolveEarly: () => done({ ok: false, error: 'stopped', stopped: true }) }); } catch {} }
  });
}

/** Lay out a workspace: library root, manifest dir, and a manifest per depot. */
function makeWorkspace(depots) {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'librarian-e2e-'));
  const manifestDir = join(root, 'manifests');
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifests = {};
  const depotMap = {};
  for (const d of depots) {
    const manifestId = String(1000000 + Number(d.depotId));
    manifests[String(d.depotId)] = manifestId;
    depotMap[String(d.depotId)] = { key: DEPOT_KEY, size: '0' };
    fs.writeFileSync(join(manifestDir, `${d.depotId}_${manifestId}.manifest`), d.manifest);
  }
  return { root, manifestDir, manifests, depotMap };
}

function gameDataFor(ws, depots, hosts, extra = {}) {
  return {
    appid: '480',
    game_name: 'E2E Test Game',
    installdir: 'E2ETestGame',
    buildid: '1',
    depots: ws.depotMap,
    manifests: ws.manifests,
    manifest_dir: ws.manifestDir,
    cdn_hosts: hosts,
    skip_auto_crack: true,
    ...extra,
  };
}

const installDirOf = (ws) => join(ws.root, 'steamapps', 'common', 'E2ETestGame');

/** Compare every file a depot declares against what landed on disk. */
function verifyInstall(installDir, depots, label = 'install') {
  let checkedFiles = 0;
  for (const d of depots) {
    for (const [name, content] of d.files) {
      const p = join(installDir, ...name.split('/'));
      if (!fs.existsSync(p)) { check(false, `${label}: ${name} is missing`); continue; }
      const actual = fs.readFileSync(p);
      if (actual.length !== content.length) {
        check(false, `${label}: ${name} is ${actual.length} bytes, manifest declares ${content.length}`);
        continue;
      }
      if (!actual.equals(content)) {
        check(false, `${label}: ${name} does not match the source bytes`);
        continue;
      }
      checkedFiles++;
    }
  }
  return checkedFiles;
}

const MARKER_DIR = '.DepotDownloader';
const STATE_FILE = '.librarian-pipe-state.json';
const statePath = (installDir) => join(installDir, MARKER_DIR, STATE_FILE);

function readState(installDir) {
  try { return JSON.parse(fs.readFileSync(statePath(installDir), 'utf-8')); }
  catch { return null; }
}

/** Which target indices a state file claims are finished. */
function claimedIndices(state) {
  if (!state || typeof state.bits !== 'string') return new Set();
  const bits = Buffer.from(state.bits, 'base64');
  const out = new Set();
  for (let i = 0; i < (state.total || 0); i++) {
    if ((bits[i >> 3] >> (i & 7)) & 1) out.add(i);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// Scenario content
// ════════════════════════════════════════════════════════════════

/** Build A: the install a test starts from. */
function buildA(depotId = 1001) {
  return buildDepot({
    depotId,
    // Deliberately spans all three container formats, several chunks per file,
    // an exactly-chunk-sized file, a file smaller than one chunk, and an empty
    // one — every branch the enumeration loop has.
    files: new Map([
      ['bin/game.exe', blob('exe-a', CHUNK * 3 + 517)],
      ['data/pak0.pak', blob('pak0', CHUNK * 2)],
      ['data/pak1.pak', blob('pak1-a', CHUNK + 4096)],
      ['data/dropped.pak', blob('dropped', CHUNK)],
      ['config/settings.ini', Buffer.from('[Video]\nWidth=1920\n', 'utf8')],
      ['config/empty.dat', Buffer.alloc(0)],
    ]),
    codecFor: (i) => (i % 3 === 0 ? 'vsz' : i % 3 === 1 ? 'vz' : 'zip'),
  });
}

/**
 * Build B: what an update installs.
 *
 * Every kind of change an update has to cope with, in one build:
 *
 *   pak0.pak      identical, same offsets — nothing to do at all
 *   game.exe      same content, shifted by a prefix — recoverable only by
 *                 hash, and its source is the very file being rewritten, so
 *                 those bytes have to be staged before the first write
 *   pak2.pak      new file whose content already exists inside pak0, which
 *                 this update never touches — recoverable in place, with no
 *                 staging needed
 *   pak1.pak      shortened, so the tail of the old file has to be trimmed
 *   settings.ini  genuinely new content: a real download
 *   dropped.pak   gone from the build entirely, so it must be deleted
 */
function buildB(depotId = 1001) {
  const exe = blob('exe-a', CHUNK * 3 + 517);
  const pak0 = blob('pak0', CHUNK * 2);
  return buildDepot({
    depotId,
    files: new Map([
      ['bin/game.exe', Buffer.concat([blob('prefix-b', CHUNK), exe])],
      ['data/pak0.pak', pak0],
      ['data/pak1.pak', blob('pak1-a', CHUNK)],          // shortened
      ['data/pak2.pak', pak0],                           // new, but already on disk
      ['config/settings.ini', Buffer.from('[Video]\nWidth=2560\n', 'utf8')],
      ['config/empty.dat', Buffer.alloc(0)],
    ]),
    codecFor: (i) => (i % 3 === 0 ? 'vsz' : i % 3 === 1 ? 'vz' : 'zip'),
  });
}

/** Install build A the ordinary way, and leave the workspace ready for more. */
async function installBuild(depots, { settings = {}, sandbox = null, ws = null, extraGameData = {} } = {}) {
  const box = sandbox ?? makeSandbox();
  const workspace = ws ?? makeWorkspace(depots);
  const origin = await startOrigin(depots);
  const { engine } = loadEngine(box, settings);
  const result = await runJob(engine, {
    engine,
    gameData: gameDataFor(workspace, depots, [origin.host], extraGameData),
    depots: depots.map(d => String(d.depotId)),
    destPath: workspace.root,
  });
  await origin.close();
  return { box, ws: workspace, origin, result, engine };
}

/**
 * Re-seed a workspace's manifest directory for a new build.
 *
 * A real update arrives with fresh manifests in a scratch directory; the engine
 * archives the ones it installs into <library>/depotcache on success. This
 * reproduces the arrival half.
 */
function stageManifests(ws, depots) {
  fs.mkdirSync(ws.manifestDir, { recursive: true });
  for (const d of depots) {
    const manifestId = String(2000000 + Number(d.depotId));
    ws.manifests[String(d.depotId)] = manifestId;
    fs.writeFileSync(join(ws.manifestDir, `${d.depotId}_${manifestId}.manifest`), d.manifest);
  }
}

/**
 * Put the *current* build's manifests back where a job expects to find them.
 *
 * A completed install moves them into <library>/depotcache and deletes the
 * scratch copies, which is exactly right for the app and means any second run
 * over the same workspace — a repair, or a re-run of the same build — has to
 * be handed them again, just as the caller would.
 */
function restageManifests(ws, depots) {
  fs.mkdirSync(ws.manifestDir, { recursive: true });
  for (const d of depots) {
    const manifestId = ws.manifests[String(d.depotId)];
    fs.writeFileSync(join(ws.manifestDir, `${d.depotId}_${manifestId}.manifest`), d.manifest);
  }
}

// ════════════════════════════════════════════════════════════════
// Suites
// ════════════════════════════════════════════════════════════════

const suites = {};

function encryptDepotManifest(depot) {
  const legacy = depot.manifest;
  const files = require(join(ROOT, 'src/core/steamPipe.js')).readManifestFile;
  const temp = fs.mkdtempSync(join(os.tmpdir(), 'librarian-encrypted-manifest-'));
  const manifestPath = join(temp, 'fixture.manifest');
  fs.writeFileSync(manifestPath, legacy);
  depot.manifest = encodeManifest(files(manifestPath), true);
  fs.unlinkSync(manifestPath); fs.rmdirSync(temp);
  return depot;
}

suites['e2e-encrypted'] = async () => {
  const depot = encryptDepotManifest(buildA());
  const ws = makeWorkspace([depot]);
  const box = makeSandbox();
  const { engine } = loadEngine(box);
  const manifestPath = join(ws.manifestDir, `1001_${ws.manifests['1001']}.manifest`);
  try {
    for (const key of [undefined, 'bad', 'b'.repeat(64)]) {
      let rejected = false;
      try { engine.readManifestFile(manifestPath, key); } catch { rejected = true; }
      check(rejected, 'encrypted manifest accepted a missing or incorrect key');
    }
    const entries = engine.readManifestFile(manifestPath, DEPOT_KEY);
    check(entries.some(file => file.filename === 'config/empty.dat'), 'encrypted empty filename was not decoded');
    const inventory = require(box.corePath('depotInventory.js')).buildInventory(gameDataFor(ws, [depot], []), ['1001']);
    checkEqual(inventory.totalBytes, [...depot.files.values()].reduce((sum, bytes) => sum + bytes.length, 0), 'encrypted inventory size');
    const clearPath = join(ws.root, 'clear.manifest');
    fs.writeFileSync(clearPath, encodeManifest(entries, false));
    checkEqual(engine.readManifestFile(clearPath).length, entries.length, 'full plaintext manifest support');
    const invalid = await installBuild([depot], { sandbox: box, ws, extraGameData: { depots: { '1001': { key: 'b'.repeat(64) } } } });
    check(!invalid.result.ok && /decrypt manifest filenames/.test(invalid.result.error), 'wrong key did not produce a decryption error');
    checkEqual(fs.readdirSync(installDirOf(ws)).filter(name => name !== MARKER_DIR).length, 0, 'wrong key created game files');
    fs.mkdirSync(ws.manifestDir, { recursive: true });
    fs.writeFileSync(manifestPath, depot.manifest);
    const valid = await installBuild([depot], { sandbox: box, ws });
    check(valid.result.ok, `encrypted download failed: ${valid.result.error}`);
    checkEqual(verifyInstall(installDirOf(ws), [depot], 'encrypted'), 6, 'encrypted install verified file count');
  } finally { box.dispose(); }
  await suites['e2e-update'](true);
};

// ── A fresh download is byte-exact across all three codecs ──────
suites['e2e-fresh'] = async () => {
  const depots = [buildA()];
  const { box, ws, result } = await installBuild(depots);
  try {
    check(result.ok, `download failed: ${result.error}`);
    const installDir = installDirOf(ws);
    const verified = verifyInstall(installDir, depots, 'fresh');
    check(verified === 6, `expected 6 files verified, got ${verified}`);

    // The empty file has a name and no chunks: it must exist, at zero bytes.
    const empty = join(installDir, 'config', 'empty.dat');
    check(fs.existsSync(empty) && fs.statSync(empty).size === 0,
      'the zero-chunk file was not created as an empty file');

    // A finished install registers itself and archives its manifests.
    check(fs.existsSync(join(ws.root, 'steamapps', 'appmanifest_480.acf')),
      'no ACF was written for the completed install');
    check(fs.existsSync(join(ws.root, 'depotcache', '1001_1001001.manifest')),
      'the installed manifest was not archived to depotcache');
    check(!fs.existsSync(statePath(installDir)),
      'the resume state file outlived a completed download');

    // Nothing may be left in the way of the game.
    check(!fs.existsSync(join(installDir, MARKER_DIR, '.librarian-reuse.bin')),
      'the staging scratch file was left behind');
  } finally {
    box.dispose();
  }
};

// ── Stop mid-flight, restart, and land byte-exact ───────────────
suites['e2e-resume'] = async () => {
  const depots = [buildA()];
  const box = makeSandbox();
  const ws = makeWorkspace(depots);
  const installDir = installDirOf(ws);

  try {
    // First run: stopped as soon as it has real progress to lose.
    const origin1 = await startOrigin(depots);
    const { engine } = loadEngine(box, { download_max_downloads: 2 });
    let stopHandle = null;
    await runJob(engine, {
      gameData: gameDataFor(ws, depots, [origin1.host]),
      depots: ['1001'],
      destPath: ws.root,
      onTick: (ev) => {
        if (ev.kind === 'started') { stopHandle = ev.resolveEarly; return; }
        if (ev.kind === 'pct' && ev.pct >= 25 && ev.handle && !ev.handle.stopped) {
          ev.handle.stop();
          setTimeout(() => stopHandle && stopHandle(), 300);
        }
      },
    });
    await origin1.close();

    // The state file is the contract with the next run. Every chunk it claims
    // must actually be on disk — that is the property the durable frontier
    // exists to guarantee, and the one a page-cache write cannot promise.
    const state = readState(installDir);
    check(state !== null, 'no resume state was written when the download was stopped');
    const claimed = claimedIndices(state);
    check(claimed.size > 0, 'the resume state claims no progress at all');
    check(claimed.size < (state?.total ?? 0), 'the download was not actually interrupted');
    check(fs.existsSync(join(installDir, MARKER_DIR)),
      'the marker directory is missing');
    check(!fs.existsSync(join(installDir, STATE_FILE)),
      'the state file is still in the install directory, where it counts as a game file');

    // Second run: same manifests, so the signature matches and it resumes.
    const origin2 = await startOrigin(depots);
    const result2 = await runJob(engine, {
      gameData: gameDataFor(ws, depots, [origin2.host]),
      depots: ['1001'],
      destPath: ws.root,
    });
    const resumeLine = result2.log.find(l => /Resuming: \d+\//.test(l));
    check(Boolean(resumeLine), 'the second run did not report resuming from saved state');
    // It must have skipped what the first run finished, not started over.
    const resumedCount = Number(/Resuming: (\d+)\//.exec(resumeLine || '')?.[1] || 0);
    check(resumedCount === claimed.size,
      `resumed ${resumedCount} chunks but the state file claimed ${claimed.size}`);
    check(origin2.log.requests.length < (state?.total ?? 0),
      'the resumed run fetched as many chunks as a fresh download');
    await origin2.close();

    check(result2.ok, `resumed download failed: ${result2.error}`);
    const verified = verifyInstall(installDir, depots, 'resume');
    check(verified === 6, `expected 6 files verified after resume, got ${verified}`);
  } finally {
    box.dispose();
  }
};

// ── An update patches, trims and prunes ─────────────────────────
suites['e2e-update'] = async (encrypted = false) => {
  const a = [buildA()];
  const b = [buildB()];
  if (encrypted) for (const depot of [...a, ...b]) encryptDepotManifest(depot);
  const { box, ws, result: first } = await installBuild(a);
  try {
    check(first.ok, `initial install failed: ${first.error}`);
    const installDir = installDirOf(ws);

    // How much a from-scratch install of build B would cost, for comparison.
    const scratchWs = makeWorkspace(b);
    const scratchOrigin = await startOrigin(b);
    const { engine: scratchEngine } = loadEngine(makeSandbox(), {});
    const scratch = await runJob(scratchEngine, {
      gameData: gameDataFor(scratchWs, b, [scratchOrigin.host]),
      depots: ['1001'],
      destPath: scratchWs.root,
    });
    const scratchBytes = scratchOrigin.log.requests.length;
    await scratchOrigin.close();
    check(scratch.ok, `control install of build B failed: ${scratch.error}`);

    // Now update the existing install in place.
    stageManifests(ws, b);
    const origin = await startOrigin(b);
    const { engine } = loadEngine(box, {});
    const update = await runJob(engine, {
      gameData: gameDataFor(ws, b, [origin.host], { job_type: 'update' }),
      depots: ['1001'],
      destPath: ws.root,
    });
    await origin.close();
    check(update.ok, `update failed: ${update.error}`);

    const verified = verifyInstall(installDir, b, 'update');
    check(verified === 6, `expected 6 files verified after update, got ${verified}`);

    // The file build B drops must be gone — leaving it is how a game ends up
    // mounting an old archive alongside the new ones.
    check(!fs.existsSync(join(installDir, 'data', 'dropped.pak')),
      'data/dropped.pak survived an update that no longer declares it');

    // The file build B shortens must be exactly its declared length.
    checkEqual(fs.statSync(join(installDir, 'data', 'pak1.pak')).size, CHUNK,
      'data/pak1.pak was not trimmed to the length build B declares');

    // And the patch has to be smaller than the install, or none of this helped.
    check(origin.log.requests.length < scratchBytes,
      `the update fetched ${origin.log.requests.length} chunks, no fewer than the ${scratchBytes} a fresh install needs`);
    check(update.plan !== null, 'the update produced no plan for the UI');
    check((update.plan?.unchangedBytes ?? 0) > 0,
      'the plan found nothing unchanged, though pak0 is identical in both builds');
  } finally {
    box.dispose();
  }
};

// ── An update does not trust a file that was replaced since the last build ──
// pak0.pak is identical in builds A and B, so the plan calls it "unchanged"
// without reading it. Swapped for something longer beforehand — what the
// emulator does to steam_api64.dll — it used to pass that test, keep the
// foreign bytes, and then be cut to B's length: CONTROL Resonant's Goldberg
// DLL, truncated to Valve's 317,080 bytes, refused by Windows (0xc000007b).
suites['e2e-update-replaced-file'] = async () => {
  const a = [buildA()];
  const b = [buildB()];
  const { box, ws, result: first } = await installBuild(a);
  try {
    check(first.ok, `initial install failed: ${first.error}`);
    const installDir = installDirOf(ws);
    const replaced = join(installDir, 'data', 'pak0.pak');
    const original = fs.readFileSync(replaced);
    fs.writeFileSync(replaced, blob('emulator', original.length * 3 + 101));

    stageManifests(ws, b);
    const origin = await startOrigin(b);
    const { engine } = loadEngine(box, {});
    const update = await runJob(engine, {
      gameData: gameDataFor(ws, b, [origin.host], { job_type: 'update' }),
      depots: ['1001'],
      destPath: ws.root,
    });
    await origin.close();
    check(update.ok, `update failed: ${update.error}`);
    checkEqual(verifyInstall(installDir, b, 'update over a replaced file'), 6,
      'every file of build B must match its source bytes, the replaced one included');
  } finally {
    box.dispose();
  }
};

suites['e2e-custom-update'] = async () => {
  for (const hasRecord of [true, false]) {
  const a = [buildA()], b = [buildB()];
  const ws = makeWorkspace(a), box = makeSandbox();
  const installPath = join(ws.root, 'Custom', 'Chosen Name');
  const marker = join(installPath, '.DepotDownloader');
  const target = { installPath, manifestPath: join(marker, 'appmanifest_480.acf'), cacheDir: join(marker, 'depotcache'), validateAll: true };
  fs.mkdirSync(target.cacheDir, { recursive: true });
  for (const [name, data] of a[0].files) {
    const file = join(installPath, name); fs.mkdirSync(dirname(file), { recursive: true }); fs.writeFileSync(file, data);
  }
  fs.writeFileSync(join(installPath, 'user-notes.txt'), 'Keep this untracked file');
  // A valid old record is not proof that unchanged files are still intact.
  fs.writeFileSync(join(installPath, 'data/pak0.pak'), Buffer.alloc(CHUNK * 2, 7));
  if (hasRecord) {
    fs.writeFileSync(target.manifestPath, `"AppState"\n{\n\t"appid"\t"480"\n\t"installdir"\t"Chosen Name"\n\t"buildid"\t"1"\n\t"InstalledDepots"\n\t{\n\t\t"1001"\n\t\t{\n\t\t\t"manifest"\t"${ws.manifests['1001']}"\n\t\t}\n\t}\n}\n`);
    fs.copyFileSync(join(ws.manifestDir, `1001_${ws.manifests['1001']}.manifest`), join(target.cacheDir, `1001_${ws.manifests['1001']}.manifest`));
  }
  stageManifests(ws, b);
  const count = [...b[0].files.values()].reduce((sum, data) => sum + Math.ceil(data.length / CHUNK), 0);
  fs.writeFileSync(statePath(installPath), JSON.stringify({ v: 2, sig: `1001:${ws.manifests['1001']}`, total: count, bits: Buffer.alloc(Math.ceil(count / 8), 255).toString('base64') }));
  const origin = await startOrigin(b);
  try {
    let checkedBeforeWrite = false;
    const update = await runJob(loadEngine(box, {}).engine, {
      gameData: gameDataFor(ws, b, [origin.host], { job_type: 'update', buildid: '2', installdir: 'Wrong client folder' }),
      depots: ['1001'], destPath: ws.root, target,
      onTick: tick => {
        if (tick.kind === 'progress' && tick.message.includes('Applying update')) {
          checkedBeforeWrite = true;
          check(hasRecord ? /"buildid"\s+"1"/.test(fs.readFileSync(target.manifestPath, 'utf8')) : !fs.existsSync(target.manifestPath), 'new build was recorded before update completed');
        }
      },
    });
    await update.handle?.done;
    check(update.ok, `custom update failed: ${update.error}`);
    check(checkedBeforeWrite, 'the pre-completion record check did not run');
    checkEqual(verifyInstall(installPath, b, 'custom update'), 6, 'custom files must match the complete target build');
    checkEqual(fs.existsSync(join(installPath, 'data/dropped.pak')), !hasRecord, 'only a file known to the prior manifest may be pruned');
    checkEqual(fs.readFileSync(join(installPath, 'user-notes.txt'), 'utf8'), 'Keep this untracked file', 'untracked files were changed');
    check(!fs.existsSync(join(ws.root, 'steamapps')) && !fs.existsSync(join(installPath, 'steamapps')), 'a second installation was created');
    check(/"buildid"\s+"2"/.test(fs.readFileSync(target.manifestPath, 'utf8')), 'the completed build was not recorded in the custom folder');
    check(fs.existsSync(join(target.cacheDir, `1001_${ws.manifests['1001']}.manifest`)), 'custom depot inventory was not archived');
  } finally { await origin.close(); box.dispose(); }
  }
};

// ── A repair restores damage without re-downloading everything ──
suites['e2e-repair'] = async () => {
  const depots = [buildA()];
  const { box, ws, result } = await installBuild(depots);
  try {
    check(result.ok, `initial install failed: ${result.error}`);
    const installDir = installDirOf(ws);

    // Three kinds of damage, all of which a repair has to notice.
    const corrupt = join(installDir, 'data', 'pak0.pak');
    const buf = fs.readFileSync(corrupt);
    buf.fill(0, 1000, 3000);
    fs.writeFileSync(corrupt, buf);
    fs.truncateSync(join(installDir, 'data', 'pak1.pak'), 100);
    fs.unlinkSync(join(installDir, 'config', 'settings.ini'));

    restageManifests(ws, depots);
    const origin = await startOrigin(depots);
    const { engine } = loadEngine(box, {});
    const repair = await runJob(engine, {
      gameData: gameDataFor(ws, depots, [origin.host], { job_type: 'repair' }),
      depots: ['1001'],
      destPath: ws.root,
    });
    await origin.close();
    check(repair.ok, `repair failed: ${repair.error}`);

    const verified = verifyInstall(installDir, depots, 'repair');
    check(verified === 6, `expected 6 files verified after repair, got ${verified}`);

    // A repair that re-downloads the whole game is a reinstall with a nicer
    // name. The decisive figure is how many chunks it recognised as already
    // correct *in place* — not merely how little it downloaded, because
    // content-addressed recovery off the same disk would also keep that low
    // while skipping the verification a repair exists to perform.
    const summary = repair.log.find(l => /Reused \d+ unchanged chunk\(s\) in place/.test(l));
    check(Boolean(summary), 'the repair never reported verifying anything in place');
    const reused = Number(/Reused (\d+) unchanged/.exec(summary || '')?.[1] ?? 0);
    check(reused >= 5,
      `the repair verified only ${reused} chunks in place; most of this install was undamaged`);
    check(origin.log.requests.length > 0, 'the repair downloaded nothing, so it did not fix the damage');
    const totalChunks = depots[0].chunkStore.size;
    check(origin.log.requests.length < totalChunks,
      `repair fetched ${origin.log.requests.length} of ${totalChunks} chunks — it is not reusing what was intact`);
  } finally {
    box.dispose();
  }
};

// ── The two guards the state file used to disable ───────────────
suites['e2e-guards'] = async () => {
  const depots = [buildA()];
  const box = makeSandbox();

  try {
    // (1) Disk-space preflight. A fresh install whose directory already holds
    // engine scratch from an interrupted attempt must still be checked. The
    // requirement is 1.05x the payload, so an impossible free-space figure
    // proves the check ran; a real one proves it passed on its own terms.
    {
      const ws = makeWorkspace(depots);
      const installDir = installDirOf(ws);
      fs.mkdirSync(join(installDir, MARKER_DIR), { recursive: true });
      fs.writeFileSync(statePath(installDir), JSON.stringify({ v: 2, sig: 'stale', total: 1, bits: 'AA==' }));

      const origin = await startOrigin(depots);
      const { engine } = loadEngine(box, {});
      const res = await runJob(engine, {
        gameData: gameDataFor(ws, depots, [origin.host]),
        depots: ['1001'],
        destPath: ws.root,
      });
      await origin.close();
      check(res.ok, `a fresh install with leftover scratch failed outright: ${res.error}`);
      check(res.log.some(l => /Disk space OK/.test(l)),
        'the disk-space preflight did not run for a fresh install that had been interrupted before');
    }

    // (2) Finalisation guard. A resume state that says the job is finished,
    // over a directory whose payload has been deleted, must not be registered
    // as an install — the ACF would announce a game that cannot launch.
    {
      const ws = makeWorkspace(depots);
      const origin = await startOrigin(depots);
      const { engine } = loadEngine(box, {});
      const first = await runJob(engine, {
        gameData: gameDataFor(ws, depots, [origin.host]),
        depots: ['1001'],
        destPath: ws.root,
      });
      check(first.ok, `setup install failed: ${first.error}`);
      const installDir = installDirOf(ws);
      const acf = join(ws.root, 'steamapps', 'appmanifest_480.acf');
      fs.rmSync(acf, { force: true });

      // Wipe the payload, keeping only our own scratch — the shape a user
      // produces by clearing the folder while a download is stopped.
      for (const entry of fs.readdirSync(installDir)) {
        if (entry === MARKER_DIR) continue;
        fs.rmSync(join(installDir, entry), { recursive: true, force: true });
      }

      // Then claim every chunk is finished, for the exact manifest set the next
      // run will use, so the engine has no work to do and goes straight to the
      // guard.
      const sig = `1001:${ws.manifests['1001']}`;
      const chunkTotal = [...depots[0].files.values()]
        .reduce((n, c) => n + Math.ceil(c.length / CHUNK), 0);
      fs.mkdirSync(join(installDir, MARKER_DIR), { recursive: true });
      fs.writeFileSync(statePath(installDir), JSON.stringify({
        v: 2, sig, total: chunkTotal,
        bits: Buffer.alloc(Math.ceil(chunkTotal / 8), 0xff).toString('base64'),
      }));

      restageManifests(ws, depots);
      const res = await runJob(engine, {
        gameData: gameDataFor(ws, depots, [origin.host]),
        depots: ['1001'],
        destPath: ws.root,
      });
      await origin.close();
      check(!res.ok, 'an install whose payload was deleted was registered as complete');
      check(/No game files are present/.test(res.error || ''),
        `expected the missing-payload error, got: ${res.error}`);
      check(!fs.existsSync(acf), 'an ACF was written for an install with no files');
    }
  } finally {
    box.dispose();
  }
};

// ── Decoding happens on worker threads, and survives losing them ─
suites['e2e-offthread'] = async () => {
  const depots = [buildA()];

  // (1) Instrumented worker: prove the chunks really go through it.
  const witness = join(os.tmpdir(), `librarian-e2e-witness-${process.pid}.log`);
  fs.rmSync(witness, { force: true });
  const instrumented = makeSandbox((coreDir) => {
    const p = join(coreDir, 'chunkWorker.js');
    const src = fs.readFileSync(p, 'utf-8').replace(
      "const { processChunk, shaVerify } = require('./chunkCodec');",
      "const { processChunk, shaVerify } = require('./chunkCodec');\n"
      + `const WITNESS = ${JSON.stringify(witness)};`);
    fs.writeFileSync(p, src.replace(
      'const out = await processChunk(',
      'require("fs").appendFileSync(WITNESS, "x"); const out = await processChunk('));
  });

  try {
    const { ws, result } = await installBuild(depots, { sandbox: instrumented });
    check(result.ok, `download with worker threads failed: ${result.error}`);
    check(verifyInstall(installDirOf(ws), depots, 'offthread') === 6, 'worker-decoded install is not byte-exact');
    const decoded = fs.existsSync(witness) ? fs.readFileSync(witness, 'utf-8').length : 0;
    check(decoded === depots[0].chunkStore.size,
      `expected all ${depots[0].chunkStore.size} chunks to be decoded on a worker thread, got ${decoded}`);
  } finally {
    instrumented.dispose();
    fs.rmSync(witness, { force: true });
  }

  // (2) No worker file at all: the engine must say so and fall back inline.
  const broken = makeSandbox((coreDir) => fs.rmSync(join(coreDir, 'chunkWorker.js'), { force: true }));
  try {
    const { ws, result } = await installBuild(depots, { sandbox: broken });
    check(result.ok, `download without worker threads failed: ${result.error}`);
    check(result.log.some(l => /decoding in-process/.test(l)),
      'the engine did not report falling back to in-process decoding');
    check(verifyInstall(installDirOf(ws), depots, 'inline') === 6,
      'the inline fallback did not produce a byte-exact install');
  } finally {
    broken.dispose();
  }
};

// ── The concurrency controller, exercised directly ──────────────
suites['ramp'] = async () => {
  const box = makeSandbox();
  try {
    const { engine } = loadEngine(box, {});
    const { createRampController } = engine;
    check(typeof createRampController === 'function', 'createRampController is not exported');
    if (typeof createRampController !== 'function') return;

    const REMAINING = 100000;

    // Climbs while throughput improves.
    {
      const ramp = createRampController({ floor: 4, hardCap: 32 });
      let live = 4;
      let added = 0;
      for (const rate of [1e6, 2e6, 4e6, 8e6]) {
        const { add } = ramp.sample(rate, live, REMAINING);
        live += add;
        added += add;
      }
      check(added > 0, 'the ramp never added a connection while throughput was improving');
      check(live > 4, 'the ramp stayed at the floor while throughput was improving');
    }

    // Hands connections back when an increase makes things worse.
    {
      const ramp = createRampController({ floor: 4, hardCap: 32 });
      let live = 4;
      const first = ramp.sample(1e6, live, REMAINING);   // establishes a baseline
      live += first.add;
      const second = ramp.sample(2e6, live, REMAINING);  // improved: add more
      live += second.add;
      check(second.add > 0, 'the ramp did not add on a clear improvement');
      const third = ramp.sample(1.0e6, live, REMAINING); // the increase hurt
      check(third.remove > 0, 'the ramp kept connections that had made throughput worse');
      check(third.remove <= second.add, 'the ramp removed more than it had added');
      live -= third.remove;
      check(live >= 4, 'the ramp went below the floor the user configured');
    }

    // Never below the floor, however bad it gets.
    {
      const ramp = createRampController({ floor: 8, hardCap: 32 });
      let live = 8;
      const a = ramp.sample(1e6, live, REMAINING);
      live += a.add;
      const b = ramp.sample(2e6, live, REMAINING);
      live += b.add;
      const c = ramp.sample(1, live, REMAINING);
      check(live - c.remove >= 8, 'a collapse in throughput pushed concurrency below the floor');
    }

    // Settles after two flat samples, then keeps watching — and climbs again
    // when the line itself frees up.
    {
      const ramp = createRampController({ floor: 4, hardCap: 32 });
      let live = 4;
      const first = ramp.sample(1e6, live, REMAINING);
      live += first.add;
      ramp.sample(1e6, live, REMAINING);
      ramp.sample(1e6, live, REMAINING);
      check(ramp.settled, 'the ramp did not settle after repeated flat samples');
      const revived = ramp.sample(5e6, live, REMAINING);
      check(revived.add > 0 && revived.resumed,
        'the ramp ignored throughput improving on its own after it had settled');
      check(!ramp.settled, 'the ramp stayed settled after deciding to climb again');
    }

    // A dead transfer is not evidence about concurrency.
    {
      const ramp = createRampController({ floor: 4, hardCap: 32 });
      const r = ramp.sample(0, 8, REMAINING);
      checkEqual(r.add, 0, 'a zero-rate sample added connections');
      checkEqual(r.remove, 0, 'a zero-rate sample removed connections');
    }

    // The cap is respected.
    {
      const ramp = createRampController({ floor: 4, hardCap: 6 });
      let live = 4;
      for (let i = 0; i < 10; i++) live += ramp.sample(1e6 * (i + 1), live, REMAINING).add;
      check(live <= 6, `the ramp exceeded its hard cap: ${live} > 6`);
    }
  } finally {
    box.dispose();
  }
};

// ── Lancache preference and the address rule ────────────────────
suites['lancache'] = async () => {
  const box = makeSandbox();
  try {
    const { engine } = loadEngine(box, {});
    const { HostPool, isPrivateAddress } = engine;

    for (const addr of ['10.0.0.5', '192.168.1.10', '172.16.4.1', '172.31.255.254', '127.0.0.1', '169.254.1.1', '::1']) {
      check(isPrivateAddress(addr), `${addr} should count as a local address`);
    }
    for (const addr of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '203.0.113.9', '', null]) {
      check(!isPrivateAddress(addr), `${addr} should not count as a local address`);
    }

    // A preferred host wins every pick while it is healthy...
    const pool = new HostPool(['cdn1.example', 'cdn2.example', 'cdn3.example']);
    const lan = pool.addPreferred('lancache.steamcontent.com');
    for (let i = 0; i < 20; i++) {
      if (pool.pick() !== lan) { check(false, 'a healthy Lancache was passed over for a CDN mirror'); break; }
    }
    // ...and stops being used once it has proved unreliable.
    for (let i = 0; i < 8; i++) pool.failed(lan);
    let sawCdn = false;
    for (let i = 0; i < 10; i++) if (pool.pick() !== lan) sawCdn = true;
    check(sawCdn, 'a Lancache that failed repeatedly still monopolised the pool');

    // Latency seeding orders the rest, and leaves the preferred host in front.
    const ranked = new HostPool(['slow.example', 'fast.example', 'dead.example']);
    ranked.seedLatency([
      { host: 'slow.example', ms: 400 },
      { host: 'fast.example', ms: 8 },
      { host: 'dead.example', ms: null },
    ]);
    checkEqual(ranked.entries[0].host, 'fast.example', 'latency seeding did not put the fastest mirror first');
    checkEqual(ranked.entries[2].host, 'dead.example', 'an unreachable mirror was not sorted to the back');

    // The engine must not adopt a Lancache that is really just public DNS.
    const noLan = new HostPool(['cdn1.example']);
    checkEqual(noLan.entries.filter(e => e.preferred).length, 0,
      'a pool with no Lancache reported a preferred host');
  } finally {
    box.dispose();
  }
};

// ── A bad mirror is dropped; a rate limit stands the pool down ──
suites['e2e-mirrors'] = async () => {
  // Enough chunks that both mirrors establish a throughput history before the
  // bad one starts misbehaving — "too slow" is a comparison, and the pool needs
  // something to compare against.
  const depots = [buildDepot({
    depotId: 1001,
    files: new Map([['data/big.pak', blob('mirrors', 16384 * 40)]]),
    chunkSize: 16384,
    codecFor: () => 'zip',
  })];
  const box = makeSandbox();
  const ws = makeWorkspace(depots);

  try {
    let ratelimited = 0;
    let hung = 0;
    // The bad mirror: healthy at first, then one rate limit, then one response
    // so slow it can only be ended by the stall detector, then plain failures.
    const bad = await startOrigin(depots, ({ count }) => {
      if (count <= 6) return null;
      if (count === 7) { ratelimited++; return { status: 429, headers: { 'retry-after': '1' } }; }
      if (count === 8) { hung++; return { hangMs: 20000 }; }
      return { status: 500 };
    });
    const good = await startOrigin(depots);

    // One connection at a time, so "the pool stood down" is unambiguous: there
    // is exactly one worker, and its next request is the next request.
    const { engine } = loadEngine(box, { download_max_downloads: 1, download_adaptive: false });
    const started = Date.now();
    const result = await runJob(engine, {
      gameData: gameDataFor(ws, depots, [bad.host, good.host]),
      depots: ['1001'],
      destPath: ws.root,
    });
    const elapsed = Date.now() - started;

    check(result.ok, `a download with one bad mirror failed: ${result.error}`);
    check(verifyInstall(installDirOf(ws), depots, 'mirrors') === 1,
      'the install is not byte-exact after routing around a bad mirror');

    checkEqual(ratelimited, 1, 'the rate-limit response was never served');
    checkEqual(hung, 1, 'the slow response was never served');

    // The stall detector, not the 30 s request timeout, ended the slow request:
    // the hang is 20 s, so nothing else could have closed that socket early.
    check(bad.log.aborted.length >= 1,
      'the engine waited out a mirror that had stopped sending, instead of abandoning it');
    const abortedAfter = bad.log.aborted[0]?.afterMs ?? 0;
    check(abortedAfter >= 3000 && abortedAfter < 19000,
      `the slow request was abandoned after ${abortedAfter} ms, which is not the stall budget`);

    // The pool paused after being asked to. With a single worker, the gap
    // between the 429 and the next request anywhere is that pause.
    const all = [...bad.log.requests, ...good.log.requests].sort((a, b) => a.at - b.at);
    const rateLimitAt = bad.log.requests[6].at;
    const next = all.find(r => r.at > rateLimitAt);
    check(next && (next.at - rateLimitAt) >= 900,
      `the next request came ${next ? next.at - rateLimitAt : '?'} ms after a Retry-After of 1 s`);

    // The bad mirror is benched rather than retried forever.
    check(bad.log.requests.length <= 25,
      `the failing mirror was asked for ${bad.log.requests.length} chunks; it should have been benched`);
    check(good.log.requests.length > bad.log.requests.length,
      'the healthy mirror did not take over the download');
    check(elapsed < 120000, `the download took ${elapsed} ms, far longer than the failures justify`);

    await bad.close();
    await good.close();
  } finally {
    box.dispose();
  }
};

// ── Staging copies only what is in danger ───────────────────────
suites['e2e-staging'] = async () => {
  const a = [buildA()];
  const b = [buildB()];
  const { box, ws, result: first } = await installBuild(a);
  try {
    check(first.ok, `initial install failed: ${first.error}`);
    const installDir = installDirOf(ws);

    stageManifests(ws, b);
    const origin = await startOrigin(b);
    const { engine } = loadEngine(box, {});
    const update = await runJob(engine, {
      gameData: gameDataFor(ws, b, [origin.host], { job_type: 'update' }),
      depots: ['1001'],
      destPath: ws.root,
    });
    await origin.close();
    check(update.ok, `update failed: ${update.error}`);

    // pak0 is identical in both builds and nothing writes to it, so its chunks
    // are reusable but never in danger. game.exe is rewritten from offset zero,
    // so the copies of its content that live inside it are.
    const inPlace = update.log.find(l => /reusable chunk\(s\) are not in the way/.test(l));
    check(Boolean(inPlace), 'the update staged everything, without noticing what was safe where it was');
    const staged = update.log.find(l => /Staged .* that this update would have overwritten/.test(l));
    check(Boolean(staged), 'nothing was staged, though game.exe is rewritten over its own reusable content');

    check(verifyInstall(installDir, b, 'staging') === 6,
      'selective staging did not produce a byte-exact install');
    check(!fs.existsSync(join(installDir, MARKER_DIR, '.librarian-reuse.bin')),
      'the staging scratch file was left behind');
  } finally {
    box.dispose();
  }
};

// ── One unresolvable depot does not cost the others their diff ──
suites['e2e-perdepot'] = async () => {
  const a = [buildA(1001), buildDepot({
    depotId: 1002,
    files: new Map([['lang/en.pak', blob('lang-a', CHUNK * 2)]]),
    codecFor: () => 'zip',
  })];
  const b = [buildB(1001), buildDepot({
    depotId: 1002,
    files: new Map([['lang/en.pak', blob('lang-a', CHUNK * 2)]]),
    codecFor: () => 'zip',
  })];

  const { box, ws, result: first } = await installBuild(a);
  try {
    check(first.ok, `initial two-depot install failed: ${first.error}`);

    // Lose depot 1002's archived manifest. It alone must fall back to
    // validation; depot 1001 must still patch from its previous build.
    const cache = join(ws.root, 'depotcache');
    const lost = fs.readdirSync(cache).find(n => n.startsWith('1002_'));
    check(Boolean(lost), 'the second depot never archived a manifest');
    if (lost) fs.unlinkSync(join(cache, lost));

    stageManifests(ws, b);
    const origin = await startOrigin(b);
    const { engine } = loadEngine(box, {});
    const update = await runJob(engine, {
      gameData: gameDataFor(ws, b, [origin.host], { job_type: 'update' }),
      depots: ['1001', '1002'],
      destPath: ws.root,
    });
    await origin.close();
    check(update.ok, `mixed update failed: ${update.error}`);

    check(update.log.some(l => /Depot 1002: .*verifying its files/.test(l)),
      'the depot with no cached manifest was not singled out for verification');
    check(update.log.some(l => /Depot 1001: patching from installed build/.test(l)),
      'the depot that could be pinned did not patch');
    check(update.log.some(l => /Patching 1 of 2 depots/.test(l)),
      'the engine did not report a partial patch');
    check(update.plan !== null && (update.plan.unchangedBytes ?? 0) > 0,
      'the resolvable depot produced no diff, so the fallback was not per-depot');

    check(verifyInstall(installDirOf(ws), b, 'perdepot') === 7,
      'the mixed update did not produce a byte-exact install');
  } finally {
    box.dispose();
  }
};

// ── A modified first source does not cost the chunk ─────────────
suites['e2e-multiloc'] = async () => {
  // The same content in two files. An update rewrites one of them; the other
  // still holds those bytes, and recovery has to find it.
  const shared = blob('shared-block', CHUNK * 2);
  const a = [buildDepot({
    depotId: 1001,
    files: new Map([
      ['bin/first.bin', shared],
      ['bin/second.bin', shared],
      ['bin/filler.bin', blob('filler', CHUNK)],
    ]),
    codecFor: () => 'zip',
  })];
  const b = [buildDepot({
    depotId: 1001,
    files: new Map([
      // first.bin is replaced outright; second.bin keeps the shared content
      // and moves it, so it can only be recovered by hash.
      ['bin/first.bin', blob('replaced', CHUNK * 2)],
      ['bin/second.bin', Buffer.concat([blob('pad', CHUNK), shared])],
      ['bin/filler.bin', blob('filler', CHUNK)],
    ]),
    codecFor: () => 'zip',
  })];

  const { box, ws, result: first } = await installBuild(a);
  try {
    check(first.ok, `initial install failed: ${first.error}`);
    const installDir = installDirOf(ws);

    // Damage the copy the index would have recorded first, exactly as a crack
    // or a user edit would. The engine must fall through to the other one.
    const firstFile = join(installDir, 'bin', 'first.bin');
    const damaged = fs.readFileSync(firstFile);
    damaged.fill(0x5a, 0, 4096);
    fs.writeFileSync(firstFile, damaged);

    stageManifests(ws, b);
    const origin = await startOrigin(b);
    const { engine } = loadEngine(box, {});
    const update = await runJob(engine, {
      gameData: gameDataFor(ws, b, [origin.host], { job_type: 'update' }),
      depots: ['1001'],
      destPath: ws.root,
    });
    await origin.close();
    check(update.ok, `update failed: ${update.error}`);
    check(verifyInstall(installDir, b, 'multiloc') === 3,
      'the update is not byte-exact after the first recovery source was damaged');

    // The shared block must have come off the disk, not the network — and not
    // "mostly off the disk". Every one of its chunks is still present, intact,
    // in second.bin, so a request for any of them means recovery gave up at the
    // first damaged location instead of trying the others.
    const sharedShas = new Set();
    for (let off = 0; off < shared.length; off += CHUNK) {
      sharedShas.add(crypto.createHash('sha1')
        .update(shared.subarray(off, Math.min(off + CHUNK, shared.length))).digest('hex'));
    }
    const downloadedShared = origin.log.requests.filter(r => sharedShas.has(r.shaHex));
    checkEqual(downloadedShared.length, 0,
      `${downloadedShared.length} of ${sharedShas.size} shared chunks were downloaded despite an intact copy on disk`);
    check(update.log.some(l => /recovered \d+/.test(l) || /from previous build on disk/.test(l)),
      'the engine reported no local recovery at all');
  } finally {
    box.dispose();
  }
};

// ── Pausing and cancelling persist progress there and then ──────
suites['e2e-persist'] = async () => {
  const depots = [buildA()];

  for (const action of ['pause', 'cancel']) {
    const box = makeSandbox();
    const ws = makeWorkspace(depots);
    const installDir = installDirOf(ws);
    const origin = await startOrigin(depots);
    try {
      const { engine } = loadEngine(box, { download_max_downloads: 2 });
      let finish = null;
      let acted = false;
      await runJob(engine, {
        gameData: gameDataFor(ws, depots, [origin.host]),
        depots: ['1001'],
        destPath: ws.root,
        onTick: (ev) => {
          if (ev.kind === 'started') { finish = ev.resolveEarly; return; }
          if (acted || ev.kind !== 'pct' || ev.pct < 20 || !ev.handle) return;
          acted = true;
          // The state file must exist the moment the call returns — not after
          // the workers unwind, which on quit they may never get to do.
          if (action === 'pause') ev.handle.markPaused();
          else ev.handle.stop();
          const written = fs.existsSync(statePath(installDir));
          check(written, `${action} did not persist the resume state synchronously`);
          const claimed = claimedIndices(readState(installDir));
          check(claimed.size > 0, `${action} wrote a state file claiming no progress`);
          if (action === 'pause') ev.handle.stop();
          setTimeout(() => finish && finish(), 300);
        },
      });
      check(acted, `the download finished before it could be ${action}d`);
    } finally {
      await origin.close();
      box.dispose();
    }
  }
};

// ── Checkpoints fire on volume, not only on elapsed time ────────
suites['e2e-checkpoint'] = async () => {
  // Checkpoints fire on elapsed time (every 3 s) or on volume (every 512
  // chunks), and the point of the second rule is a fast link, where three
  // seconds is a great deal of progress to lose.
  //
  // So the measurement is *when* the first state file appears. Many tiny
  // uncompressed chunks pass 512 well inside three seconds; if the file is on
  // disk before the timer could possibly have fired, only the count rule can
  // have put it there.
  const depots = [buildDepot({
    depotId: 1001,
    files: new Map([['data/big.pak', blob('many-chunks', 1024 * 1500)]]),
    chunkSize: 1024,
    codecFor: () => 'store',
  })];

  const box = makeSandbox();
  const ws = makeWorkspace(depots);
  const installDir = installDirOf(ws);
  const origin = await startOrigin(depots);
  let poller = null;
  try {
    const { engine } = loadEngine(box, { download_max_downloads: 16 });
    let finish = null;
    let stoppedAt = 0;
    let firstSeenMs = Infinity;
    let claimedAtFirstSight = 0;
    const started = Date.now();

    await runJob(engine, {
      gameData: gameDataFor(ws, depots, [origin.host]),
      depots: ['1001'],
      destPath: ws.root,
      onTick: (ev) => {
        if (ev.kind === 'started') {
          finish = ev.resolveEarly;
          poller = setInterval(() => {
            // Only what a *checkpoint* wrote counts. Stopping the job persists
            // too, deliberately and synchronously, and watching past that point
            // would let e2e-persist's guarantee stand in for this one.
            if (stoppedAt || firstSeenMs !== Infinity) return;
            if (!fs.existsSync(statePath(installDir))) return;
            const state = readState(installDir);
            if (!state) return;               // caught mid-rename
            firstSeenMs = Date.now() - started;
            claimedAtFirstSight = claimedIndices(state).size;
          }, 5);
          return;
        }
        if (stoppedAt || ev.kind !== 'pct' || ev.pct < 70 || !ev.handle) return;
        stoppedAt = Date.now() - started;
        ev.handle.stop();
        setTimeout(() => finish && finish(), 200);
      },
    });

    check(stoppedAt > 0, 'the download completed before it could be interrupted');
    check(firstSeenMs < Math.min(2800, stoppedAt),
      `a checkpoint first persisted progress after ${firstSeenMs === Infinity ? 'never' : Math.round(firstSeenMs) + ' ms'}, with the job stopped at ${Math.round(stoppedAt)} ms — nothing here that the 3 s timer does not already explain, so the count-based checkpoint is doing nothing`);
    check(claimedAtFirstSight >= 512,
      `the first checkpoint claimed ${claimedAtFirstSight} chunks, fewer than the ${512} the count rule waits for`);
  } finally {
    if (poller) clearInterval(poller);
    await origin.close();
    box.dispose();
  }
};

// ════════════════════════════════════════════════════════════════
// Round two
// ════════════════════════════════════════════════════════════════

const installSizeOf = (depots) => depots.reduce((n, d) => n + [...d.files.values()].reduce((s, c) => s + c.length, 0), 0);

function readAcfSize(ws) {
  const acf = fs.readFileSync(join(ws.root, 'steamapps', 'appmanifest_480.acf'), 'utf-8');
  return Number(/"SizeOnDisk"\s+"(\d+)"/.exec(acf)?.[1] ?? -1);
}

// ── The ACF records the install, not the patch ──────────────────
suites['e2e-acfsize'] = async () => {
  const a = [buildA()];
  const b = [buildB()];
  const { box, ws, result: first } = await installBuild(a);
  try {
    check(first.ok, `initial install failed: ${first.error}`);
    checkEqual(readAcfSize(ws), installSizeOf(a), 'a fresh install wrote the wrong SizeOnDisk');

    stageManifests(ws, b);
    const origin = await startOrigin(b);
    const { engine } = loadEngine(box, {});
    const update = await runJob(engine, {
      gameData: gameDataFor(ws, b, [origin.host], { job_type: 'update' }),
      depots: ['1001'],
      destPath: ws.root,
    });
    await origin.close();
    check(update.ok, `update failed: ${update.error}`);

    // The whole of build B, not the slice of it this patch had to touch.
    const expected = installSizeOf(b);
    const written = readAcfSize(ws);
    checkEqual(written, expected, 'after an update, SizeOnDisk is the patch size rather than the install size');
    // And the library reads exactly this field into size_on_disk.
    const gm = fs.readFileSync(join(box.dir, 'src', 'core', 'gameManager.js'), 'utf-8');
    check(/"SizeOnDisk"\\s\+"\(\[\^"\]\+\)"/.test(gm) && /size_on_disk = s/.test(gm),
      'gameManager no longer reads SizeOnDisk into size_on_disk — the figure this test protects is unused');
  } finally {
    box.dispose();
  }
};

// ── A mirror that serves garbage is benched ─────────────────────
suites['e2e-corrupt'] = async () => {
  const depots = [buildDepot({
    depotId: 1001,
    files: new Map([['data/big.pak', blob('corrupt-mirror', 16384 * 60)]]),
    chunkSize: 16384,
    codecFor: () => 'zip',
  })];
  const box = makeSandbox();
  const ws = makeWorkspace(depots);
  try {
    // Every body from this mirror is a well-formed 200 with one byte wrong.
    const bad = await startOrigin(depots, () => ({ corrupt: true }));
    const good = await startOrigin(depots);
    const { engine } = loadEngine(box, { download_max_downloads: 2 });
    const result = await runJob(engine, {
      gameData: gameDataFor(ws, depots, [bad.host, good.host]),
      depots: ['1001'],
      destPath: ws.root,
    });
    check(result.ok, `download with a corrupting mirror failed: ${result.error}`);
    check(verifyInstall(installDirOf(ws), depots, 'corrupt') === 1,
      'the install is not byte-exact after routing around a corrupting mirror');

    // It served a handful of bad bodies and was then left alone. Without a
    // penalty for corruption it would have taken every other chunk for the
    // whole download — thirty of sixty here, each one fetched twice.
    check(bad.log.requests.length <= 14,
      `the corrupting mirror was asked for ${bad.log.requests.length} chunks; it should have been benched after a few`);
    check(good.log.requests.length > bad.log.requests.length,
      'the healthy mirror did not take over from the corrupting one');
    await bad.close();
    await good.close();
  } finally {
    box.dispose();
  }
};

// ── Disk-space arithmetic for updates and repairs ───────────────
suites['e2e-growth'] = async () => {
  const box = makeSandbox();
  try {
    const { engine } = loadEngine(box, {});
    const { estimateGrowth } = engine;
    check(typeof estimateGrowth === 'function', 'estimateGrowth is not exported');

    const declared = new Map([
      ['new.pak', 1000],      // absent: counts in full
      ['grown.pak', 1000],    // exists at 400: counts 600
      ['shrunk.pak', 1000],   // exists at 5000: counts nothing
      ['same.pak', 1000],     // exists at 1000: counts nothing
    ]);
    const sizes = { 'new.pak': -1, 'grown.pak': 400, 'shrunk.pak': 5000, 'same.pak': 1000 };
    checkEqual(estimateGrowth(declared, (p) => sizes[p]), 1600, 'growth arithmetic is wrong');
    checkEqual(estimateGrowth(declared, (p) => sizes[p], 250), 1850, 'the staging area is not added to the requirement');
    checkEqual(estimateGrowth(new Map(), () => -1), 0, 'an empty manifest needs space');

    // Wired in: an update reports the check, and so does a repair.
    const a = [buildA()];
    const b = [buildB()];
    const first = await installBuild(a, { sandbox: box });
    check(first.result.ok, `initial install failed: ${first.result.error}`);
    stageManifests(first.ws, b);
    const origin = await startOrigin(b);
    const update = await runJob(loadEngine(box, {}).engine, {
      gameData: gameDataFor(first.ws, b, [origin.host], { job_type: 'update' }),
      depots: ['1001'],
      destPath: first.ws.root,
    });
    await origin.close();
    check(update.ok, `update failed: ${update.error}`);
    check(update.log.some(l => /Disk space OK for this update: needs ~/.test(l)),
      'the update path never ran the growth check');

    restageManifests(first.ws, b);
    const origin2 = await startOrigin(b);
    const repair = await runJob(loadEngine(box, {}).engine, {
      gameData: gameDataFor(first.ws, b, [origin2.host], { job_type: 'repair' }),
      depots: ['1001'],
      destPath: first.ws.root,
    });
    await origin2.close();
    check(repair.ok, `repair failed: ${repair.error}`);
    check(repair.log.some(l => /Disk space OK for this repair: needs ~/.test(l)),
      'the repair path never ran the growth check');
  } finally {
    box.dispose();
  }
};

// ── On-disk verification happens on worker threads ──────────────
suites['e2e-offthread-hash'] = async () => {
  const depots = [buildA()];
  const witness = join(os.tmpdir(), `librarian-e2e-hash-witness-${process.pid}.log`);
  fs.rmSync(witness, { force: true });
  const instrumented = makeSandbox((coreDir) => {
    const p = join(coreDir, 'chunkWorker.js');
    let src = fs.readFileSync(p, 'utf-8');
    src = src.replace(
      "const { processChunk, shaVerify } = require('./chunkCodec');",
      "const { processChunk, shaVerify } = require('./chunkCodec');\n"
      + `const WITNESS = ${JSON.stringify(witness)};`);
    src = src.replace(
      "if (msg.op === 'hash') {",
      "if (msg.op === 'hash') {\n      require('fs').appendFileSync(WITNESS, 'h');");
    fs.writeFileSync(p, src);
  });

  try {
    const { ws, result } = await installBuild(depots, { sandbox: instrumented });
    check(result.ok, `initial install failed: ${result.error}`);
    const installDir = installDirOf(ws);
    const downloadedHashes = fs.existsSync(witness) ? fs.readFileSync(witness, 'utf-8').length : 0;
    checkEqual(downloadedHashes, 0, 'a fresh download hashed on-disk data it had no reason to read');

    // Damage one chunk. A repair reads and hashes every intact chunk — nine of
    // the ten — and every one of those hashes has to have run on a worker.
    const pak0 = join(installDir, 'data', 'pak0.pak');
    const buf = fs.readFileSync(pak0);
    buf.fill(0, 100, 200);
    fs.writeFileSync(pak0, buf);

    restageManifests(ws, depots);
    const origin = await startOrigin(depots);
    const repair = await runJob(loadEngine(instrumented, {}).engine, {
      gameData: gameDataFor(ws, depots, [origin.host], { job_type: 'repair' }),
      depots: ['1001'],
      destPath: ws.root,
    });
    await origin.close();
    check(repair.ok, `repair failed: ${repair.error}`);
    check(verifyInstall(installDir, depots, 'offthread-hash') === 6, 'repair is not byte-exact');

    const hashed = fs.existsSync(witness) ? fs.readFileSync(witness, 'utf-8').length : 0;
    const totalTargets = [...depots[0].files.values()].reduce((n, c) => n + Math.ceil(c.length / CHUNK), 0);
    check(hashed >= totalTargets - 1,
      `only ${hashed} of ${totalTargets} on-disk verifications ran on a worker thread; the rest ran on the calling thread`);
  } finally {
    instrumented.dispose();
    fs.rmSync(witness, { force: true });
  }
};

// ── Files are reserved at their declared length ─────────────────
suites['e2e-prealloc'] = async () => {
  const declared = 16384 * 40;
  const depots = [buildDepot({
    depotId: 1001,
    files: new Map([['data/big.pak', blob('prealloc', declared)]]),
    chunkSize: 16384,
    codecFor: () => 'zip',
  })];
  const box = makeSandbox();
  const ws = makeWorkspace(depots);
  const origin = await startOrigin(depots);
  try {
    const { engine } = loadEngine(box, { download_max_downloads: 2 });
    let finish = null;
    let stoppedPct = 0;
    await runJob(engine, {
      gameData: gameDataFor(ws, depots, [origin.host]),
      depots: ['1001'],
      destPath: ws.root,
      onTick: (ev) => {
        if (ev.kind === 'started') { finish = ev.resolveEarly; return; }
        if (stoppedPct || ev.kind !== 'pct' || ev.pct < 30 || !ev.handle) return;
        stoppedPct = ev.pct;
        ev.handle.stop();
        setTimeout(() => finish && finish(), 300);
      },
    });
    check(stoppedPct > 0, 'the download finished before it could be interrupted');
    check(stoppedPct < 95, `stopped at ${stoppedPct}% — too late to tell reservation from completion`);

    // A third of the way in, the file is already its full declared length.
    const p = join(installDir(ws), 'data', 'big.pak');
    check(fs.existsSync(p), 'the file was never created');
    checkEqual(fs.statSync(p).size, declared,
      `the file is not reserved at its declared length ${stoppedPct}% of the way through`);
  } finally {
    await origin.close();
    box.dispose();
  }
  function installDir(w) { return installDirOf(w); }
};

// ── The mirror list is refreshed when it runs dry ───────────────
suites['e2e-cdnrefresh'] = async () => {
  const depots = [buildDepot({
    depotId: 1001,
    files: new Map([['data/big.pak', blob('cdnrefresh', 16384 * 10)]]),
    chunkSize: 16384,
    codecFor: () => 'zip',
  })];
  const box = makeSandbox();
  const ws = makeWorkspace(depots);
  const dead1 = await startOrigin(depots, () => ({ status: 500 }));
  const dead2 = await startOrigin(depots, () => ({ status: 500 }));
  const good = await startOrigin(depots);
  // First answer: two dead edges. Every answer after that adds a live one.
  const directory = await startDirectory([[dead1.host, dead2.host], [dead1.host, dead2.host, good.host]]);
  try {
    const { engine } = loadEngine(box, { download_max_downloads: 4 });
    const result = await runJob(engine, {
      gameData: gameDataFor(ws, depots, null, { cdn_directory_url: directory.url, cdn_hosts: undefined }),
      depots: ['1001'],
      destPath: ws.root,
    });
    check(result.ok, `download failed instead of refreshing the mirror list: ${result.error}`);
    check(verifyInstall(installDirOf(ws), depots, 'cdnrefresh') === 1, 'install is not byte-exact after a mirror refresh');
    check(directory.log.requests >= 2,
      `the directory was asked ${directory.log.requests} time(s); it should have been asked again once the mirrors died`);
    check(good.log.requests.length > 0, 'the mirror the refresh added was never used');
    check(result.log.some(l => /asked the directory again/.test(l)), 'the refresh was not reported');
  } finally {
    await directory.close();
    await dead1.close();
    await dead2.close();
    await good.close();
    box.dispose();
  }
};

// ── Staged data survives an interruption and is reused ──────────
suites['e2e-stagereuse'] = async () => {
  const a = [buildA()];
  const b = [buildB()];
  const { box, ws, result: first } = await installBuild(a);
  try {
    check(first.ok, `initial install failed: ${first.error}`);
    const installDir = installDirOf(ws);
    const bin = join(installDir, MARKER_DIR, '.librarian-reuse.bin');
    const index = join(installDir, MARKER_DIR, '.librarian-reuse.bin.json');

    // Start the update, let it stage, stop it at the first written chunk.
    stageManifests(ws, b);
    const origin1 = await startOrigin(b);
    const { engine } = loadEngine(box, { download_max_downloads: 1 });
    let finish = null;
    let staged = false;
    let stopped = false;
    await runJob(engine, {
      gameData: gameDataFor(ws, b, [origin1.host], { job_type: 'update' }),
      depots: ['1001'],
      destPath: ws.root,
      onTick: (ev) => {
        if (ev.kind === 'started') { finish = ev.resolveEarly; return; }
        if (ev.kind === 'progress' && /Staged .* would have overwritten/.test(ev.message)) staged = true;
        if (stopped || !staged || ev.kind !== 'pct' || !ev.handle) return;
        stopped = true;
        ev.handle.stop();
        setTimeout(() => finish && finish(), 300);
      },
    });
    await origin1.close();
    check(staged, 'the first run never staged anything, so there is nothing to reuse');
    check(stopped, 'the update finished before it could be interrupted');
    check(fs.existsSync(bin) && fs.existsSync(index), 'the staging area did not survive the stop');

    // Resume: the staged data must be picked up, not rebuilt.
    const origin2 = await startOrigin(b);
    const resumed = await runJob(engine, {
      gameData: gameDataFor(ws, b, [origin2.host], { job_type: 'update' }),
      depots: ['1001'],
      destPath: ws.root,
    });
    await origin2.close();
    check(resumed.ok, `resumed update failed: ${resumed.error}`);
    check(resumed.log.some(l => /Reusing \d+ chunk\(s\) .* staged by the interrupted update/.test(l)),
      'the resumed update did not reuse the staged data');
    check(!resumed.log.some(l => /Staging reusable data|Staged .* would have overwritten/.test(l)),
      'the resumed update staged everything again');
    check(verifyInstall(installDir, b, 'stagereuse') === 6, 'the resumed update is not byte-exact');
    check(!fs.existsSync(bin) && !fs.existsSync(index), 'staging scratch was left behind after completion');
  } finally {
    box.dispose();
  }
};

// ── No folders for content the install plan left out ────────────
suites['e2e-excludedirs'] = async () => {
  const depots = [buildDepot({
    depotId: 1001,
    dirs: ['movies', 'data', 'data/hd', 'saves'],
    files: new Map([
      ['movies/intro.bik', blob('intro', CHUNK)],      // group: video
      ['data/core.pak', blob('core', CHUNK)],          // group: core
      ['data/hd/tex.pak', blob('hd-tex', CHUNK)],      // group: hd
    ]),
    codecFor: () => 'zip',
  })];
  const { box, ws, result } = await installBuild(depots, {
    extraGameData: { exclude_groups: ['video', 'hd'] },
  });
  try {
    check(result.ok, `download with exclusions failed: ${result.error}`);
    const installDir = installDirOf(ws);
    check(fs.existsSync(join(installDir, 'data', 'core.pak')), 'the included file was not installed');
    check(!fs.existsSync(join(installDir, 'movies', 'intro.bik')), 'an excluded file was installed');
    check(!fs.existsSync(join(installDir, 'movies')),
      'movies/ was created although everything in it was excluded');
    check(!fs.existsSync(join(installDir, 'data', 'hd')),
      'data/hd/ was created although everything in it was excluded');
    check(fs.existsSync(join(installDir, 'data')), 'data/ was not created although core.pak lives in it');
    check(fs.existsSync(join(installDir, 'saves')),
      'saves/ — a directory the build declares with nothing in it — was not created');
    check(result.log.some(l => /folder\(s\) left uncreated/.test(l)), 'the skipped folders were not reported');
  } finally {
    box.dispose();
  }
};

// ── Sampler bound and adaptive flush interval ───────────────────
suites['tuning'] = async () => {
  const box = makeSandbox();
  try {
    const { engine } = loadEngine(box, {});
    const { SpeedTracker, nextCheckpointInterval } = engine;
    check(typeof SpeedTracker === 'function', 'SpeedTracker is not exported');
    check(typeof nextCheckpointInterval === 'function', 'nextCheckpointInterval is not exported');

    const t = new SpeedTracker();
    for (let i = 0; i < 20000; i++) t.record(i * 1024);
    check(t.samples.length <= 62,
      `the sampler holds ${t.samples.length} samples after 20,000 records in one burst; it should be bounded by the window`);
    check(t.samples[t.samples.length - 1].b === 19999 * 1024, 'the latest byte count was lost to the throttle');

    checkEqual(nextCheckpointInterval(3000, 2000), 6000, 'a slow flush did not back the interval off');
    checkEqual(nextCheckpointInterval(6000, 100), 3000, 'a quick flush did not bring the interval back down');
    checkEqual(nextCheckpointInterval(3000, 100), 3000, 'the interval went below its base');
    checkEqual(nextCheckpointInterval(12000, 20000), 12000, 'the interval exceeded its cap');
    checkEqual(nextCheckpointInterval(6000, 2000), 6000, 'a middling flush changed the interval');
  } finally {
    box.dispose();
  }
};

// ── Update check falls back to manifest ids ─────────────────────
suites['updatecheck'] = async () => {
  const box = makeSandbox();
  try {
    const checker = require(box.corePath('updateChecker.js'));
    const { decideUpdate, extractPublicManifests } = checker;
    check(typeof decideUpdate === 'function', 'decideUpdate is not exported');

    // Build ids decide when both exist — unchanged behaviour.
    checkEqual(decideUpdate({ localBuildId: '10', remoteBuildId: '11' }).status, 'update_available', 'newer remote build not detected');
    checkEqual(decideUpdate({ localBuildId: '11', remoteBuildId: '11' }).status, 'up_to_date', 'equal builds not up to date');
    // ...and manifests do not override them.
    checkEqual(decideUpdate({
      localBuildId: '11', remoteBuildId: '11',
      installedManifests: { '1001': '5' }, remoteManifests: { '1001': '6' },
    }).status, 'up_to_date', 'a lagging manifest table overrode equal build ids');

    // No local build id: manifests decide, for installed depots only.
    checkEqual(decideUpdate({
      localBuildId: null, remoteBuildId: '11',
      installedManifests: { '1001': '5' }, remoteManifests: { '1001': '6', '1002': '9' },
    }).status, 'update_available', 'a changed installed manifest was not reported as an update');
    checkEqual(decideUpdate({
      localBuildId: null, remoteBuildId: '11',
      installedManifests: { '1001': '5' }, remoteManifests: { '1001': '5', '1002': '9' },
    }).status, 'up_to_date', 'matching installed manifests were not reported as up to date');
    checkEqual(decideUpdate({
      localBuildId: null, remoteBuildId: '11',
      installedManifests: { '1001': '5' }, remoteManifests: { '1002': '9' },
    }).status, 'unknown', 'a depot the API does not describe should be unknown');
    checkEqual(decideUpdate({ localBuildId: null, remoteBuildId: '11' }).status, 'unknown', 'nothing to compare should be unknown');
    checkEqual(decideUpdate({
      localBuildId: null, remoteBuildId: null,
      installedManifests: { '1001': '5' }, remoteManifests: { '1001': '6' },
    }).status, 'update_available', 'with no build ids at all, manifests should still decide');

    // Both shapes the API has used for the public manifest.
    const m = extractPublicManifests({ depots: {
      '1001': { manifests: { public: { gid: '111' } } },
      '1002': { manifests: { public: '222' } },
      'branches': { public: { buildid: '9' } },
    } });
    checkEqual(m['1001'], '111', 'object-shaped public manifest not read');
    checkEqual(m['1002'], '222', 'string-shaped public manifest not read');
    check(!('branches' in m), 'the branches key was mistaken for a depot');

    // Wiring: the installed manifests reach the decision through checkForUpdate.
    const fetchId = require.resolve('node-fetch');
    const realFetch = require.cache[fetchId];
    require.cache[fetchId] = {
      id: fetchId, filename: fetchId, loaded: true,
      exports: async () => ({
        ok: true, status: 200,
        json: async () => ({ status: 'success', data: { '480': {
          depots: { '1001': { manifests: { public: { gid: '777' } } }, branches: { public: {} } },
        } } }),
      }),
    };
    try {
      for (const id of Object.keys(require.cache)) if (id.includes('.e2e-sandbox-')) delete require.cache[id];
      const fresh = require(box.corePath('updateChecker.js'));
      const viaManifest = await fresh.checkForUpdate('480', null, { force: true, installedManifests: { '1001': '5' } });
      checkEqual(viaManifest.status, 'update_available', 'installed manifests did not reach the decision through checkForUpdate');
      const all = await fresh.checkAllUpdates([{ appid: '480', buildid: null, installed_manifests: { '1001': '777' } }], { force: true });
      checkEqual(all['480']?.status, 'up_to_date', 'checkAllUpdates did not pass each game\'s installed manifests through');
    } finally {
      if (realFetch) require.cache[fetchId] = realFetch; else delete require.cache[fetchId];
    }
  } finally {
    box.dispose();
  }
};

// ════════════════════════════════════════════════════════════════
// Round three
// ════════════════════════════════════════════════════════════════

const SMALL = 16384;
const shaHexOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

/** Replace one line of a sandboxed source file; the anchor has to be there. */
function rewrite(coreDir, file, from, to) {
  const p = join(coreDir, file);
  const src = fs.readFileSync(p, 'utf-8');
  if (!src.includes(from)) throw new Error(`instrumentation anchor missing in ${file}: ${from.slice(0, 50)}`);
  fs.writeFileSync(p, src.split(from).join(to));
}

/** A job that never settles is a failure, not a hung test run. */
function settleWithin(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: `no result after ${ms} ms`, hung: true, log: [] }), ms)),
  ]);
}

// ── Every file fills front to back, and a duplicate is fetched once ──
suites['e2e-writeorder'] = async () => {
  // Repeated content placed where the old order hurt: a block that first
  // appears at the start of one file and again deep inside a much later one,
  // and a run of the same block back to back.
  const shared = blob('shared-block', SMALL);
  const pad = blob('padding-block', SMALL);
  const depots = [buildDepot({
    depotId: 1001,
    files: new Map([
      ['a/first.pak', Buffer.concat([shared, blob('first-rest', SMALL * 3)])],
      ['m/pad.pak', Buffer.concat([pad, pad, pad, pad, blob('pad-tail', SMALL)])],
      ['z/big.pak', Buffer.concat([blob('big-head', SMALL * 40), shared, blob('big-tail', SMALL)])],
    ]),
    chunkSize: SMALL,
    codecFor: (i) => (i % 2 ? 'zip' : 'vsz'),
  })];

  const witness = join(os.tmpdir(), `librarian-e2e-writes-${process.pid}.log`);
  fs.rmSync(witness, { force: true });
  const box = makeSandbox((coreDir) => rewrite(coreDir, 'steamPipe.js',
    'await handle.write(data, 0, data.length, target.offset);',
    `require('fs').appendFileSync(${JSON.stringify(witness)}, JSON.stringify([filePath, target.offset, data.length]) + '\\n'); await handle.write(data, 0, data.length, target.offset);`));
  const ws = makeWorkspace(depots);
  const origin = await startOrigin(depots);
  try {
    const { engine } = loadEngine(box, { download_max_downloads: 2 });
    const result = await runJob(engine, {
      gameData: gameDataFor(ws, depots, [origin.host]),
      depots: ['1001'],
      destPath: ws.root,
    });
    check(result.ok, `download failed: ${result.error}`);
    checkEqual(verifyInstall(installDirOf(ws), depots, 'writeorder'), 3, 'files verified byte-exact');

    // Replay the writes in the order they were issued. A write may run ahead
    // of what its file already holds only by what the concurrent connections
    // account for — never by the dozens of chunks a far duplicate jumps.
    const writes = fs.readFileSync(witness, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const totalChunks = [...depots[0].files.values()].reduce((n, c) => n + Math.ceil(c.length / SMALL), 0);
    checkEqual(writes.length, totalChunks, 'writes issued');
    const slack = SMALL * 4;
    const held = new Map();
    let worstGap = 0;
    for (const [file, offset, len] of writes) {
      const have = held.get(file) || 0;
      if (offset - have > worstGap) worstGap = offset - have;
      if (offset + len > have) held.set(file, offset + len);
    }
    check(worstGap <= slack,
      `a write landed ${worstGap} bytes past what its file already held (allowed ${slack}) — the gap is zero-filled by the filesystem and written twice`);

    // Deduplication survived the reordering: each repeated block crossed the
    // network exactly once.
    for (const [label, block] of [['the far duplicate', shared], ['the adjacent run', pad]]) {
      const asked = origin.log.requests.filter(r => r.shaHex === shaHexOf(block)).length;
      checkEqual(asked, 1, `requests for ${label}`);
    }
    checkEqual(origin.log.requests.length, depots[0].chunkStore.size, 'requests in total');
  } finally {
    await origin.close();
    box.dispose();
    fs.rmSync(witness, { force: true });
  }
};

// ── A resumed duplicate comes from the copy already on disk ─────
suites['e2e-home'] = async () => {
  const shared = blob('home-block', SMALL);
  const depots = [buildDepot({
    depotId: 1001,
    files: new Map([
      ['a/first.pak', Buffer.concat([shared, blob('home-first', SMALL * 20)])],
      ['z/last.pak', Buffer.concat([blob('home-last', SMALL * 20), shared])],
    ]),
    chunkSize: SMALL,
    codecFor: () => 'zip',
  })];
  const sharedHex = shaHexOf(shared);
  const box = makeSandbox();
  const ws = makeWorkspace(depots);
  try {
    // First run: interrupted after the shared block reached first.pak and long
    // before the download gets to the end of last.pak.
    const origin1 = await startOrigin(depots);
    let finish = null;
    let stoppedPct = 0;
    await runJob(loadEngine(box, { download_max_downloads: 2 }).engine, {
      gameData: gameDataFor(ws, depots, [origin1.host]),
      depots: ['1001'],
      destPath: ws.root,
      onTick: (ev) => {
        if (ev.kind === 'started') { finish = ev.resolveEarly; return; }
        if (stoppedPct || ev.kind !== 'pct' || ev.pct < 25 || !ev.handle) return;
        stoppedPct = ev.pct;
        ev.handle.stop();
        setTimeout(() => finish && finish(), 300);
      },
    });
    await origin1.close();
    check(stoppedPct > 0 && stoppedPct < 80, `the first run was not interrupted mid-way (stopped at ${stoppedPct}%)`);
    checkEqual(origin1.log.requests.filter(r => r.shaHex === sharedHex).length, 1, 'first-run requests for the shared block');

    // Second run: the block's other destination is still owed. Its bytes are
    // sitting in first.pak, so asking the network for them again is waste.
    const origin2 = await startOrigin(depots);
    const resumed = await runJob(loadEngine(box, { download_max_downloads: 2 }).engine, {
      gameData: gameDataFor(ws, depots, [origin2.host]),
      depots: ['1001'],
      destPath: ws.root,
    });
    await origin2.close();
    check(resumed.ok, `resume failed: ${resumed.error}`);
    check(resumed.log.some(l => /Resuming: \d+\/\d+ chunks already done/.test(l)), 'the second run did not resume');
    checkEqual(verifyInstall(installDirOf(ws), depots, 'home'), 2, 'files verified byte-exact');
    checkEqual(origin2.log.requests.filter(r => r.shaHex === sharedHex).length, 0,
      'second-run requests for a block already on disk');
  } finally {
    box.dispose();
  }
};

// ── A slow line is not a dead mirror; a silent one is ───────────
suites['e2e-slowlink'] = async () => {
  const depots = [buildDepot({
    depotId: 1001,
    files: new Map([['data/slow.pak', blob('slow-link', SMALL * 3)]]),
    chunkSize: SMALL,
    codecFor: () => 'store',
  })];
  // The silence limit shortened from thirty seconds so the test fits in a
  // few; the rule under test — silence, not duration — is unchanged by that.
  const SILENCE = 1500;
  const shorten = (coreDir) => rewrite(coreDir, 'steamPipe.js',
    'const CHUNK_TIMEOUT = 30000;', `const CHUNK_TIMEOUT = ${SILENCE};`);

  // (1) Every body takes more than twice the silence limit to arrive, with
  // gaps well inside it. One mirror, so nothing to be "slower than".
  {
    const box = makeSandbox(shorten);
    const ws = makeWorkspace(depots);
    const origin = await startOrigin(depots, () => ({ trickle: { pieces: 8, everyMs: 450 } }));
    try {
      const { engine } = loadEngine(box, { download_max_downloads: 3 });
      const result = await settleWithin(runJob(engine, {
        gameData: gameDataFor(ws, depots, [origin.host]),
        depots: ['1001'],
        destPath: ws.root,
      }), 90000);
      check(result.ok, `a steadily arriving download was abandoned: ${result.error}`);
      checkEqual(verifyInstall(installDirOf(ws), depots, 'slowlink'), 1, 'files verified byte-exact');
      checkEqual(origin.log.aborted.length, 0, 'requests abandoned while still receiving');
      checkEqual(origin.log.requests.length, 3, 'requests made for three chunks');
    } finally {
      await origin.close();
      box.dispose();
    }
  }

  // (2) A body that starts and then stops is given up on after the silence
  // limit, and the chunk is fetched again.
  {
    const box = makeSandbox(shorten);
    const ws = makeWorkspace(depots);
    const origin = await startOrigin(depots, ({ count }) => (count === 1 ? { silentAfter: 4096 } : null));
    try {
      const { engine } = loadEngine(box, { download_max_downloads: 1 });
      const result = await settleWithin(runJob(engine, {
        gameData: gameDataFor(ws, depots, [origin.host]),
        depots: ['1001'],
        destPath: ws.root,
      }), 90000);
      check(result.ok, `the download did not recover from a mirror that went silent: ${result.error}`);
      checkEqual(verifyInstall(installDirOf(ws), depots, 'silent'), 1, 'files verified byte-exact');
      checkEqual(origin.log.aborted.length, 1, 'silent requests abandoned');
      const after = origin.log.aborted[0]?.afterMs ?? 0;
      check(after >= SILENCE - 200 && after < SILENCE * 4,
        `the silent request was abandoned after ${after} ms, not around the ${SILENCE} ms limit`);
    } finally {
      await origin.close();
      box.dispose();
    }
  }
};

// ── A full disk stops the job instead of wasting the download ───
suites['e2e-diskfull'] = async () => {
  const depots = [buildDepot({
    depotId: 1001,
    files: new Map([['data/big.pak', blob('disk-full', SMALL * 60)]]),
    chunkSize: SMALL,
    codecFor: () => 'zip',
  })];
  const FIT = 12;
  // The disk "fills" after a dozen chunks: every write from then on fails the
  // way a real one does.
  const box = makeSandbox((coreDir) => rewrite(coreDir, 'steamPipe.js',
    'await handle.write(data, 0, data.length, target.offset);',
    `if ((globalThis.__writes = (globalThis.__writes || 0) + 1) > ${FIT}) { const e = new Error('ENOSPC: no space left on device, write'); e.code = 'ENOSPC'; throw e; } await handle.write(data, 0, data.length, target.offset);`));
  const ws = makeWorkspace(depots);
  const origin = await startOrigin(depots);
  try {
    globalThis.__writes = 0;
    const { engine } = loadEngine(box, { download_max_downloads: 2 });
    const result = await settleWithin(runJob(engine, {
      gameData: gameDataFor(ws, depots, [origin.host]),
      depots: ['1001'],
      destPath: ws.root,
    }), 120000);
    check(!result.ok, 'a download onto a full disk reported success');
    check(/disk is full/i.test(result.error || ''), `the error does not say the disk is full: ${result.error}`);

    // It stopped. Sixty chunks, twelve that fit: anything near sixty means it
    // went on downloading data it had nowhere to put.
    check(origin.log.requests.length <= FIT + 6,
      `${origin.log.requests.length} chunks were downloaded after only ${FIT} could be written`);

    // And what did fit is kept, with the manifests, so a resume is possible.
    const claimed = claimedIndices(readState(installDirOf(ws)));
    check(claimed.size >= FIT - 2 && claimed.size <= FIT,
      `the resume state claims ${claimed.size} chunks; ${FIT} were written`);
    check(fs.existsSync(join(ws.manifestDir, `1001_${ws.manifests['1001']}.manifest`)),
      'the manifest was thrown away, so the download cannot be resumed');
  } finally {
    await origin.close();
    box.dispose();
  }
};

// ── A decoder thread that dies does not hang the download ───────
suites['e2e-workerexit'] = async () => {
  const depots = [buildA()];
  // One thread, the third time it is handed a chunk, simply ends — no error
  // raised, which is how a thread killed for memory goes.
  const flag = join(os.tmpdir(), `librarian-e2e-exit-${process.pid}.flag`);
  fs.rmSync(flag, { force: true });
  const box = makeSandbox((coreDir) => rewrite(coreDir, 'chunkWorker.js',
    'const { id } = msg;',
    `const { id } = msg; if (!msg.op && (globalThis.__seen = (globalThis.__seen || 0) + 1) === 3 && !require('fs').existsSync(${JSON.stringify(flag)})) { require('fs').writeFileSync(${JSON.stringify(flag)}, 'x'); process.exit(7); }`));
  const ws = makeWorkspace(depots);
  const origin = await startOrigin(depots);
  try {
    const { engine } = loadEngine(box, { download_max_downloads: 1 });
    let running = null;
    const result = await settleWithin(runJob(engine, {
      gameData: gameDataFor(ws, depots, [origin.host]),
      depots: ['1001'],
      destPath: ws.root,
      onTick: (ev) => { if (ev.kind === 'started') running = ev.handle; },
    }), 60000);
    // A hung job still holds its sockets; let go of them so the origin can close.
    if (result.hung) running?.stop?.();
    check(fs.existsSync(flag), 'no decoder thread was made to exit; the scenario did not run');
    check(!result.hung, 'the download hung after a decoder thread exited');
    check(result.ok, `the download failed after a decoder thread exited: ${result.error}`);
    if (result.ok) checkEqual(verifyInstall(installDirOf(ws), depots, 'workerexit'), 6, 'files verified byte-exact');
    check(!result.log.some(l => /decoding in-process/.test(l)),
      'losing one thread sent all decoding back to the calling thread');
  } finally {
    await origin.close();
    box.dispose();
    fs.rmSync(flag, { force: true });
  }
};

// ── Mirror selection, and how a Lancache is spoken to ───────────
suites['hostpool'] = async () => {
  const box = makeSandbox();
  try {
    const { engine } = loadEngine(box, {});
    const { HostPool, chunkUrl, fetchChunk } = engine;
    const names = Array.from({ length: 40 }, (_, i) => `m${i}.example`);
    const seeded = () => {
      const pool = new HostPool(names);
      pool.seedLatency(names.map((host, i) => ({ host, ms: 20 + i * 10 })));
      return pool;
    };

    // The download rides on a few mirrors, sized to the connections in use.
    for (const [workers, expected] of [[4, 2], [16, 3], [48, 4]]) {
      const pool = seeded();
      pool.setWorkers(workers);
      const counts = new Map();
      for (let i = 0; i < 40; i++) {
        const e = pool.pick();
        counts.set(e.host, (counts.get(e.host) || 0) + 1);
      }
      checkEqual(counts.size, expected, `mirrors in rotation for ${workers} connections`);
      check(names.slice(0, expected).every(h => counts.has(h)),
        `with ${workers} connections the rotation is not the ${expected} best-ranked mirrors`);
    }

    // One failure does not cost a fast mirror its place.
    {
      const pool = seeded();
      pool.setWorkers(16);
      const [a, b, c] = pool.entries;
      for (const e of [a, b, c]) pool.succeeded(e, 1 << 20, 100);
      pool.failed(a);
      for (let i = 0; i < 40; i++) pool.pick();   // long enough to re-rank
      const after = new Set();
      for (let i = 0; i < 12; i++) after.add(pool.pick().host);
      check(after.has(a.host), 'a fast mirror with a single failure dropped out of the rotation');
    }

    // A mirror outside the rotation gets a real request eventually, and takes
    // a place when that request shows it is faster.
    {
      const pool = seeded();
      pool.setWorkers(16);
      const inRotation = new Set(names.slice(0, 3));
      for (const e of pool.entries.slice(0, 3)) pool.succeeded(e, 1 << 20, 1000);
      let trial = null;
      let trials = 0;
      for (let i = 0; i < 120; i++) {
        const e = pool.pick();
        if (!inRotation.has(e.host)) { trials++; trial = trial || e; }
      }
      check(trial !== null, 'no mirror outside the rotation was ever tried');
      check(trials <= 4, `${trials} requests went to untested mirrors in 120 picks; a trial should be occasional`);
      if (trial) {
        pool.succeeded(trial, 1 << 20, 50);       // twenty times the others
        for (let i = 0; i < 40; i++) pool.pick();
        const now = new Set();
        for (let i = 0; i < 12; i++) now.add(pool.pick().host);
        check(now.has(trial.host), 'a mirror that proved faster on trial was not promoted into the rotation');
      }
    }

    // A Lancache is asked in the clear; everything else stays on TLS.
    checkEqual(chunkUrl({ host: 'cdn.example' }, '1001', 'ab'), 'https://cdn.example/depot/1001/chunk/ab', 'CDN chunk URL');
    {
      const http = require('node:http');
      const seen = [];
      const body = crypto.randomBytes(2048);
      const server = http.createServer((req, res) => {
        seen.push({ url: req.url, agent: req.headers['user-agent'] });
        res.writeHead(200, { 'content-length': String(body.length) });
        res.end(body);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const pool = new HostPool(['cdn.example']);
        pool.addPreferred(`127.0.0.1:${server.address().port}`, 'http');
        const sha = 'c'.repeat(40);
        let counted = 0;
        const { ab } = await fetchChunk(pool, '1001', sha, undefined, undefined, { onBytes: (n) => { counted += n; } });
        check(Buffer.from(ab).equals(body), 'the body fetched from a plain-HTTP cache is not the body it served');
        checkEqual(counted, body.length, 'bytes reported as they arrived');
        checkEqual(seen.length, 1, 'requests the cache received');
        checkEqual(seen[0]?.url, `/depot/1001/chunk/${sha}`, 'path asked of the cache');
        checkEqual(seen[0]?.agent, 'Valve/Steam HTTP Client 1.0', 'user agent sent to the cache');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  } finally {
    box.dispose();
  }
};

// ── Staging reads several chunks at once ────────────────────────
suites['e2e-stage-parallel'] = async () => {
  // A file whose whole content moves one chunk along: every chunk's source is
  // about to be overwritten, so every one has to be staged first.
  const body = blob('stage-body', SMALL * 24);
  const build = (prefix) => [buildDepot({
    depotId: 1001,
    files: new Map([['bin/shifted.bin', prefix ? Buffer.concat([blob('stage-prefix', SMALL), body]) : body]]),
    chunkSize: SMALL,
    codecFor: () => 'zip',
  })];
  const a = build(false);
  const b = build(true);

  const witness = join(os.tmpdir(), `librarian-e2e-stage-${process.pid}.log`);
  fs.rmSync(witness, { force: true });
  const mark = (tag) => `require('fs').appendFileSync(${JSON.stringify(witness)}, '${tag}');`;
  const box = makeSandbox((coreDir) => {
    rewrite(coreDir, 'steamPipe.js',
      'try { handle = await files.acquire(src.path); } catch { return; }',
      `${mark('+')} try { handle = await files.acquire(src.path); } catch { return; }`);
    rewrite(coreDir, 'steamPipe.js',
      'map.set(shaHex, { offset: at, len: src.len });',
      `map.set(shaHex, { offset: at, len: src.len }); ${mark('-')}`);
  });
  try {
    const first = await installBuild(a, { sandbox: box });
    check(first.result.ok, `initial install failed: ${first.result.error}`);
    stageManifests(first.ws, b);
    const origin = await startOrigin(b);
    const update = await runJob(loadEngine(box, {}).engine, {
      gameData: gameDataFor(first.ws, b, [origin.host], { job_type: 'update' }),
      depots: ['1001'],
      destPath: first.ws.root,
    });
    await origin.close();
    check(update.ok, `update failed: ${update.error}`);
    checkEqual(verifyInstall(installDirOf(first.ws), b, 'stage-parallel'), 1, 'files verified byte-exact');

    const events = fs.existsSync(witness) ? fs.readFileSync(witness, 'utf-8') : '';
    let inFlight = 0, peak = 0, staged = 0;
    for (const ch of events) {
      if (ch === '+') { inFlight++; if (inFlight > peak) peak = inFlight; }
      else { inFlight--; staged++; }
    }
    checkEqual(staged, 24, 'chunks staged');
    check(peak >= 4, `at most ${peak} chunk(s) were being staged at once; staging is running one at a time`);
    // Only the new prefix is new content.
    checkEqual(origin.log.requests.length, 1, 'chunks downloaded by the update');
  } finally {
    box.dispose();
    fs.rmSync(witness, { force: true });
  }
};

// ════════════════════════════════════════════════════════════════

const name = process.argv[2];
if (!name || !suites[name]) {
  console.error(`usage: node dev/steampipe-e2e.mjs <${Object.keys(suites).join('|')}>`);
  process.exit(2);
}

try {
  await suites[name]();
} catch (err) {
  console.error(`FAIL ${name}: threw ${err && err.stack ? err.stack : err}`);
  sweepSandboxes();
  process.exit(1);
} finally {
  sweepSandboxes();
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log(`OK ${name}`);
process.exit(0);
