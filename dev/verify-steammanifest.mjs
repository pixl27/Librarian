#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Verifier for the steammanifest source (src/core/steamManifest.js and its
// wiring), the vendored copy under deps/steammanifest, and the two pieces
// written for it: src/core/zipWriter.js and src/core/depotKeys.js.
//
//   node dev/verify-steammanifest.mjs <suite>
//
//   deps        the vendored copy matches VERSION.txt, resolves its two
//               runtime packages from inside itself, ships no account-login
//               package and nothing the checkout's .gitignore excludes
//   zip         an archive this writes is read back by yauzl (through
//               zipProcessor) and by Windows' own bsdtar, and both reject a
//               corrupted copy
//   lua         the Lua written here parses, through zipProcessor, to the
//               shape a real Hubcap Lua gives; a keyless depot is never
//               emitted as one the engine would decrypt
//   keys        the depot key store: harvesting, precedence, validation,
//               durability
//   fetch       assembling a package against a mock CM client and local CDN
//               and mirror servers, with the project's own 1007/1004 fixture
//   stale       Hubcap's package checked against Steam: current, behind and
//               replaced, behind and unreplaceable
//   search      Steam's store search in Hubcap's shape, and the source order
//   wiring      preload, main, settings, markup, renderer and harnesses agree
//   integrity   every production and vendored file parses; the stylesheet and
//               the new markup agree
//   self-test   each source-level defect the verifier checks for is caught
//   regressions the existing reliability suite and the Electron smoke
//   endpoint    metadata adapter and generation without direct Steam attempts
//   live        configured endpoints and Steam CDN (not part of `all`)
//   pack        electron-builder --dir carries the copy and the modules
//   all         every offline suite above
//
// Prints `OK <suite>` and exits 0 only after every assertion in it passed.
// No game, injector or real download is run; only `live` and `pack` leave
// the machine or build.
// ═══════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, mkdtempSync, rmSync, readdirSync, cpSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p, root = ROOT) => readFileSync(join(root, p), 'utf8');
const requireFrom = createRequire(join(ROOT, 'package.json'));
const BSDTAR = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const FIXTURE_DIR = join(ROOT, 'dev', 'fixtures', 'steammanifest');
const FIXTURE_RAW = join(FIXTURE_DIR, '1004_5612541580377302256.raw');
const FIXTURE_MANIFEST = join(FIXTURE_DIR, '1004_5612541580377302256.manifest');
const FIXTURE_APP = '1007';
const FIXTURE_DEPOT = '1004';
const FIXTURE_GID = '5612541580377302256';
const HUBCAP_ZIP = join(ROOT, 'morrenus_manifests', 'librarian_fetch_2062430.zip');
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);
const APP_DETAILS_URL = 'https://store.steampowered.com/api/appdetails';

// Modules under test are loaded with a fake Electron in place, so the user
// data directory is a temporary folder and nothing reads the real settings.
let fakeUserData = mkdtempSync(join(tmpdir(), 'steammanifest-userdata-'));
function installFakeElectron() {
  const id = requireFrom.resolve('electron');
  requireFrom.cache[id] = {
    id, filename: id, loaded: true, children: [], paths: [],
    exports: {
      app: { getPath: () => fakeUserData, isPackaged: false },
      safeStorage: { isEncryptionAvailable: () => false },
    },
  };
}
installFakeElectron();

const core = (name) => requireFrom(join(ROOT, 'src', 'core', name));
if (process.argv[2] !== 'live') {
  core('settingsStore.js').set('depot_key_catalog', '');
  core('settingsStore.js').set('app_token_catalog', '');
}
const cleanups = [];
const temp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
  return dir;
};
process.on('exit', () => { for (const fn of cleanups) fn(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Synthetic manifests ─────────────────────────────────────────
// The project ships one real manifest (depot 1004). The freshness tests need
// manifests for other depots and other manifest ids, so they are built with
// the vendored decoder's own protobuf definitions and framed the way Valve
// frames them; the decoder is then the judge of whether they are well formed.
const MAGIC = { PAYLOAD: 0x71f617d0, METADATA: 0x1f4812be, SIGNATURE: 0x1b81b817, END: 0x32c415ab };
let protobufRoot = null;
function manifestMessages(dir) {
  if (protobufRoot) return protobufRoot;
  const req = createRequire(join(dir, 'package.json'));
  const protobuf = req('protobufjs');
  const source = /const MANIFEST_PROTO = `([\s\S]*?)`;/.exec(readFileSync(join(dir, 're', 'manifest_format.js'), 'utf8'))[1];
  const root = protobuf.parse(source, { keepCase: true }).root.resolveAll();
  protobufRoot = {
    payload: root.lookupType('ContentManifestPayload'),
    metadata: root.lookupType('ContentManifestMetadata'),
    signature: root.lookupType('ContentManifestSignature'),
  };
  return protobufRoot;
}

function section(magic, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(magic, 0);
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** A decompressed .manifest for one file, as the CDN's ZIP would hold it. */
function makeManifest(dir, depotId, manifestId, { filename = 'data.bin', size = 1024 } = {}) {
  const { payload, metadata, signature } = manifestMessages(dir);
  const sha = createHash('sha1').update(`${depotId}/${manifestId}/${filename}`).digest();
  const body = payload.encode(payload.create({
    mappings: [{
      filename, size, flags: 0, sha_filename: sha, sha_content: sha,
      chunks: [{ sha, crc: 0x1234, offset: 0, cb_original: size, cb_compressed: size }],
    }],
  })).finish();
  const meta = metadata.encode(metadata.create({
    depot_id: Number(depotId), gid_manifest: String(manifestId), creation_time: 1700000000,
    filenames_encrypted: false, cb_disk_original: size, cb_disk_compressed: size, unique_chunks: 1,
    crc_encrypted: 0, crc_clear: 0,
  })).finish();
  const sig = signature.encode(signature.create({ signature: Buffer.alloc(0) })).finish();
  const end = Buffer.alloc(4);
  end.writeUInt32LE(MAGIC.END, 0);
  return Buffer.concat([
    section(MAGIC.PAYLOAD, Buffer.from(body)),
    section(MAGIC.METADATA, Buffer.from(meta)),
    section(MAGIC.SIGNATURE, Buffer.from(sig)),
    end,
  ]);
}

/** The CDN serves manifests inside a one-entry classic ZIP. */
function asCdnZip(manifestBytes) {
  const { buildZip } = core('zipWriter.js');
  return buildZip([{ name: 'manifest', data: manifestBytes }]);
}

// ── Mock Steam ──────────────────────────────────────────────────
/**
 * The surface src/core/steamManifest.js and the vendored fetch-manifest use:
 * PICS product info, the content-server list, manifest request codes and
 * depot keys. `denied` depots refuse a request code the way Steam does for
 * content the session does not own.
 */
function mockClient({ apps, cdnHost, keys = {}, denied = new Set(), noCode = new Set() }) {
  const calls = { productInfo: [], codes: [], keys: [], servers: 0 };
  return {
    calls,
    connected: false,
    async connect() { this.connected = true; },
    logOff() { this.connected = false; },
    async getProductInfo(ids) {
      calls.productInfo.push(ids.map(String));
      const out = {};
      for (const id of ids) if (apps[String(id)]) out[String(id)] = { appinfo: apps[String(id)] };
      return { apps: out, packages: {}, unknownApps: [], unknownPackages: [] };
    },
    async getContentServers() {
      calls.servers++;
      return { servers: [{ Host: cdnHost, host: cdnHost, https_support: 'disabled', weightedload: 1 }] };
    },
    async getManifestRequestCode(appid, depotId, manifestId) {
      calls.codes.push(`${appid}/${depotId}/${manifestId}`);
      if (denied.has(String(depotId))) throw Object.assign(new Error('Manifest request code: AccessDenied (15)'), { eresult: 15 });
      if (noCode.has(String(depotId))) throw new Error('Malformed manifest request-code response');
      return { requestCode: '12345678901234567890' };
    },
    async getDepotDecryptionKey(appid, depotId) {
      calls.keys.push(`${appid}/${depotId}`);
      const key = keys[String(depotId)];
      if (!key) throw Object.assign(new Error('Depot decryption key: AccessDenied (15)'), { eresult: 15 });
      return { key: Buffer.from(key, 'hex') };
    },
  };
}

/** A CDN: GET /depot/<depot>/manifest/<manifest>/5/<code> → the ZIP container. */
async function startCdn(bodies) {
  const hits = [];
  const server = createServer((req, res) => {
    const m = /^\/depot\/(\d+)\/manifest\/(\d+)\/5\/(\d+)/.exec(req.url || '');
    if (!m) { res.writeHead(400); res.end('bad'); return; }
    hits.push(`${m[1]}_${m[2]}`);
    const body = bodies[`${m[1]}_${m[2]}`];
    if (!body) { res.writeHead(404); res.end('no such manifest'); return; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  cleanups.push(() => server.close());
  return { host: `127.0.0.1:${port}`, hits, close: () => server.close() };
}

/**
 * A request-code mirror: GET /manifest/<depot>/<manifest> → a bare uint64
 * request code (the real 20770407.xyz contract). The manifest bytes still
 * come from the Steam CDN, fetched with that code.
 */
async function startMirror(codes) {
  const hits = [];
  const server = createServer((req, res) => {
    const m = /^\/manifest\/(\d+)\/(\d+)/.exec(req.url || '');
    if (!m) { res.writeHead(400); res.end('Invalid Depot ID'); return; }
    hits.push(`${m[1]}_${m[2]}`);
    const code = codes[`${m[1]}_${m[2]}`];
    if (!code) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('Unauthorized'); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(String(code));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  cleanups.push(() => server.close());
  return { endpoint: `http://127.0.0.1:${port}`, hits, close: () => server.close() };
}

function appinfo({ name, type = 'Game', depots = {}, buildid = '900', dlcs = '' }) {
  const record = { common: { name, type }, extended: {}, depots: { branches: { public: { buildid } } } };
  if (dlcs) record.extended.listofdlc = dlcs;
  for (const [id, d] of Object.entries(depots)) {
    record.depots[id] = {
      manifests: d.gid ? { public: { gid: d.gid, size: String(d.size ?? 4096), download: String(d.download ?? 2048) } } : undefined,
      config: d.oslist ? { oslist: d.oslist } : undefined,
      ...(d.depotfromapp ? { depotfromapp: d.depotfromapp } : {}),
      ...(d.dlcappid ? { dlcappid: d.dlcappid } : {}),
      ...(d.name ? { name: d.name } : {}),
    };
  }
  return record;
}

// ── deps ────────────────────────────────────────────────────────
function deps(root = ROOT) {
  const fails = [];
  const dir = join(root, 'deps', 'steammanifest');
  const versionPath = join(dir, 'VERSION.txt');
  if (!existsSync(versionPath)) return [`missing ${versionPath}`];
  const version = readFileSync(versionPath, 'utf8');
  const listed = [...version.matchAll(/^(\S+) sha256 ([0-9a-f]{64}) octets (\d+)$/gm)];
  if (listed.length < 15) fails.push(`VERSION.txt lists only ${listed.length} first-party files`);
  for (const [, rel, sha, size] of listed) {
    const file = join(dir, rel);
    if (!existsSync(file)) { fails.push(`missing ${rel}`); continue; }
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (actual !== sha) fails.push(`${rel}: sha256 ${actual} != ${sha} in VERSION.txt`);
    if (statSync(file).size !== Number(size)) fails.push(`${rel}: ${statSync(file).size} bytes != ${size} in VERSION.txt`);
  }
  for (const rel of ['re/cm_client.js', 'fetch-manifest.js', 're/xyz_client.js', 're/manifest_format.js', 're/http.js', 're/ids.js', 'fetch-lua.js']) {
    if (!listed.some(([, name]) => name === rel)) fails.push(`VERSION.txt does not record ${rel}`);
  }
  if (!/^source /m.test(version)) fails.push('VERSION.txt records no source checkout');
  if (!/^runtime packages /m.test(version)) fails.push('VERSION.txt records no runtime package versions');

  // The two packages must resolve from inside the vendored folder, so the
  // copy works wherever it is unpacked and never borrows Librarian's own.
  for (const pkg of ['protobufjs', 'websocket13']) {
    if (!existsSync(join(dir, 'node_modules', pkg, 'package.json'))) { fails.push(`${pkg} is not inside the vendored copy`); continue; }
    try {
      const resolved = createRequire(join(dir, 'package.json')).resolve(pkg);
      if (!resolve(resolved).toLowerCase().startsWith(resolve(join(dir, 'node_modules')).toLowerCase())) {
        fails.push(`${pkg} resolves outside the copy: ${resolved}`);
      }
    } catch (err) { fails.push(`${pkg} does not resolve: ${err.message}`); }
  }
  // steam-user is the CLI's account-login path; nothing Librarian calls loads it.
  if (existsSync(join(dir, 'node_modules', 'steam-user'))) fails.push('the account-login package steam-user is shipped');
  for (const rel of ['manifests', 're/output', 'node_modules/.package-lock.json', 'tests', 'portal', 'portal.js']) {
    if (existsSync(join(dir, rel))) fails.push(`${rel} should not be vendored`);
  }
  if (root === ROOT) {
    try {
      const mods = core('steamManifest.js').load(dir);
      for (const [name, fn] of [['http.httpGet', mods.http.httpGet], ['manifest.parseManifest', mods.manifest.parseManifest]]) {
        if (typeof fn !== 'function') fails.push(`the copy does not export ${name}`);
      }
    } catch (err) { fails.push(`the copy does not load: ${err.message}`); }
  }
  return fails;
}

// ── zip ─────────────────────────────────────────────────────────
async function zip() {
  const fails = [];
  const { buildZip, crc32 } = core('zipWriter.js');
  const { readGameArchive } = core('zipProcessor.js');
  const { buildLua } = core('steamManifest.js');
  const dir = temp('steammanifest-zip-');
  const manifest = readFileSync(FIXTURE_MANIFEST);
  const lua = buildLua({
    appid: FIXTURE_APP, name: 'Steamworks SDK Redist', buildid: '1',
    depots: [{ id: FIXTURE_DEPOT, manifestId: FIXTURE_GID, size: 22986368, key: KEY_A, shared: false }],
  });
  const entries = [
    { name: `${FIXTURE_APP}.lua`, data: lua },
    { name: `${FIXTURE_DEPOT}_${FIXTURE_GID}.manifest`, data: manifest },
  ];
  const bytes = buildZip(entries);
  const file = join(dir, 'package.zip');
  writeFileSync(file, bytes);

  if (bytes.readUInt32LE(0) !== 0x04034b50) fails.push('the archive does not start with a local file header');

  // yauzl, through the reader the queue uses.
  try {
    const archive = await readGameArchive(file, FIXTURE_APP);
    const names = Object.keys(archive.manifestFiles);
    if (names.length !== 1 || names[0] !== `${FIXTURE_DEPOT}_${FIXTURE_GID}.manifest`) fails.push(`yauzl read manifests ${JSON.stringify(names)}`);
    if (!archive.manifestFiles[names[0]].equals(manifest)) fails.push('yauzl read the manifest back with different bytes');
    if (archive.gameData.appid !== FIXTURE_APP) fails.push(`yauzl read app ${archive.gameData.appid}`);
  } catch (err) { fails.push(`yauzl could not read the archive: ${err.message}`); }

  // bsdtar: extraction verifies each entry's CRC against the header.
  if (!existsSync(BSDTAR)) fails.push(`bsdtar not found at ${BSDTAR}`);
  else {
    const out = join(dir, 'extracted');
    mkdirSync(out, { recursive: true });
    try {
      execFileSync(BSDTAR, ['-xf', file, '-C', out], { windowsHide: true, timeout: 30000 });
      const got = readdirSync(out).sort();
      const want = [`${FIXTURE_APP}.lua`, `${FIXTURE_DEPOT}_${FIXTURE_GID}.manifest`].sort();
      if (got.join(',') !== want.join(',')) fails.push(`bsdtar extracted ${got.join(',')}, expected ${want.join(',')}`);
      if (!readFileSync(join(out, `${FIXTURE_DEPOT}_${FIXTURE_GID}.manifest`)).equals(manifest)) fails.push('bsdtar extracted different manifest bytes');
      if (readFileSync(join(out, `${FIXTURE_APP}.lua`), 'utf8') !== lua) fails.push('bsdtar extracted a different Lua');
    } catch (err) { fails.push(`bsdtar could not extract the archive: ${err.message}`); }
  }

  // Corruption must be refused by both readers. The byte is inside the
  // second entry's body, so the CRC of that entry no longer matches.
  const bodyAt = 30 + `${FIXTURE_APP}.lua`.length + 40;
  const bad = Buffer.from(bytes);
  bad[bodyAt] = bad[bodyAt] ^ 0xff;
  if (bad.equals(bytes)) fails.push('the corrupted copy is identical to the original');
  const badFile = join(dir, 'corrupt.zip');
  writeFileSync(badFile, bad);
  let yauzlRefused = '';
  try { await readGameArchive(badFile, FIXTURE_APP); }
  catch (err) { yauzlRefused = err.message; }
  if (!yauzlRefused) fails.push('yauzl accepted a corrupted archive');
  // Corrupt an uncompressed entry without changing its size or breaking Lua.
  // Inflation/identity checks alone cannot catch this; the reader must check CRC.
  const storedBytes = buildZip([
    { name: '1007.lua', data: lua },
    { name: '1004_1.manifest', data: Buffer.from([1, 2, 3, 4]) },
  ]);
  const next = 30 + storedBytes.readUInt16LE(26) + storedBytes.readUInt16LE(28) + storedBytes.readUInt32LE(18);
  if (storedBytes.readUInt16LE(next + 8) !== 0) fails.push('CRC fixture is not stored');
  storedBytes[next + 30 + storedBytes.readUInt16LE(next + 26)] ^= 1;
  const storedFile = join(dir, 'corrupt-stored.zip');
  writeFileSync(storedFile, storedBytes);
  try { await readGameArchive(storedFile, FIXTURE_APP); fails.push('same-size stored-entry corruption was accepted'); }
  catch (err) { if (!/CRC/i.test(err.message)) fails.push(`stored corruption failed for another reason: ${err.message}`); }
  let tarRefused = false;
  if (existsSync(BSDTAR)) {
    const out2 = join(dir, 'extracted-bad');
    mkdirSync(out2, { recursive: true });
    const r = spawnSync(BSDTAR, ['-xf', badFile, '-C', out2], { windowsHide: true, timeout: 30000, encoding: 'utf8' });
    tarRefused = r.status !== 0;
    if (!tarRefused) fails.push('bsdtar accepted a corrupted archive');
  }

  // The CRC helper is the one thing both readers check against; measure it
  // against a value computed here rather than trusting the implementation.
  const known = Buffer.from('The quick brown fox jumps over the lazy dog');
  if (crc32(known) !== 0x414fa339) fails.push(`crc32 of the known vector is 0x${crc32(known).toString(16)}, expected 0x414fa339`);

  // Names that would escape the archive, and duplicates, are refused.
  for (const name of ['../evil.lua', 'sub/dir.lua', '', '.']) {
    let refused = false;
    try { buildZip([{ name, data: 'x' }]); } catch { refused = true; }
    if (!refused) fails.push(`buildZip accepted the entry name ${JSON.stringify(name)}`);
  }
  let dupRefused = false;
  try { buildZip([{ name: 'a.lua', data: '1' }, { name: 'a.lua', data: '2' }]); } catch { dupRefused = true; }
  if (!dupRefused) fails.push('buildZip accepted a duplicate entry name');
  return fails;
}

// ── lua ─────────────────────────────────────────────────────────
async function lua() {
  const fails = [];
  const { buildZip } = core('zipWriter.js');
  const { readGameArchive } = core('zipProcessor.js');
  const sm = core('steamManifest.js');
  const dir = temp('steammanifest-lua-');
  const manifest = readFileSync(FIXTURE_MANIFEST);

  // A real Hubcap package, read by the same code, is the shape to match.
  let hub;
  try { hub = await readGameArchive(HUBCAP_ZIP, '2062430'); }
  catch (err) { return [`the reference Hubcap package could not be read: ${err.message}`]; }
  const hubShape = Object.keys(hub.gameData).sort().join(',');

  const text = sm.buildLua({
    appid: FIXTURE_APP,
    name: 'Steamworks SDK Redist',
    buildid: '1234',
    depots: [
      { id: FIXTURE_DEPOT, manifestId: FIXTURE_GID, size: 22986368, download: 22986368, key: KEY_A, shared: false },
      { id: '1005', manifestId: '777', size: 0, download: 4096, key: KEY_B, shared: true },
    ],
    dlcs: [{ id: '1008', name: 'Extra' }],
    leftOut: [
      { id: '1006', reason: `${sm.NO_KEY}` },
      // A reason that tries to smuggle a depot in: it must not survive as one.
      { id: '1009', reason: 'no manifest: addappid(1009, 1, "deadbeef")\nsetManifestid(1009, "1", 1)' },
    ],
  });
  const file = join(dir, 'built.zip');
  writeFileSync(file, buildZip([
    { name: `${FIXTURE_APP}.lua`, data: text },
    { name: `${FIXTURE_DEPOT}_${FIXTURE_GID}.manifest`, data: manifest },
    { name: `1005_777.manifest`, data: manifest },
  ]));

  let mine;
  try { mine = await readGameArchive(file, FIXTURE_APP); }
  catch (err) { return [...fails, `the assembled package could not be read: ${err.message}`]; }
  const g = mine.gameData;
  if (Object.keys(g).sort().join(',') !== hubShape) fails.push(`parsed shape ${Object.keys(g).sort().join(',')} != Hubcap's ${hubShape}`);
  if (g.appid !== FIXTURE_APP) fails.push(`appid ${g.appid}`);
  if (g.game_name !== 'Steamworks SDK Redist') fails.push(`game name "${g.game_name}"`);
  const depotIds = Object.keys(g.depots).sort();
  if (depotIds.join(',') !== `${FIXTURE_DEPOT},1005`) fails.push(`depots ${depotIds.join(',')}`);
  if (g.depots[FIXTURE_DEPOT].key !== KEY_A || g.depots['1005'].key !== KEY_B) fails.push('depot keys did not survive the round trip');
  if (g.manifests[FIXTURE_DEPOT] !== FIXTURE_GID || g.manifests['1005'] !== '777') fails.push(`manifest ids ${JSON.stringify(g.manifests)}`);
  if (g.manifest_sizes[FIXTURE_DEPOT] !== '22986368') fails.push(`manifest size ${g.manifest_sizes[FIXTURE_DEPOT]}`);
  if (g.manifest_sizes['1005'] !== '4096') fails.push(`a depot whose PICS size is 0 took ${g.manifest_sizes['1005']} instead of its download size`);
  if (!g.dlcs['1008']) fails.push('the DLC was not parsed');
  // Left-out depots must not be parsed as depots or DLCs at all.
  for (const id of ['1006', '1009']) {
    if (g.depots[id]) fails.push(`depot ${id} was left out but parsed as a depot`);
    if (g.dlcs[id]) fails.push(`depot ${id} was left out but parsed as a DLC`);
  }
  if (!/-- depot 1006: no key/.test(text)) fails.push('the Lua does not say why depot 1006 was left out');
  if (/\naddappid\(1009/.test(text)) fails.push('a left-out reason was emitted as an addappid line');
  if (/[\r\n]/.test(text.split('\n').find((l) => l.startsWith('-- depot 1009:')) || '\n')) fails.push('a left-out reason spans lines');

  // Every depot in the Lua is one SteamPipe will be asked to decrypt, so a
  // keyless depot must never appear: build with no key at all.
  const keyless = sm.buildLua({ appid: FIXTURE_APP, name: 'X', depots: [], dlcs: [], leftOut: [{ id: '1', reason: sm.NO_KEY }] });
  if (/^addappid\((?!1007\b)/m.test(keyless.replace(/^addappid\(1007\).*$/m, ''))) fails.push('a package with no keyed depot still emits depot lines');
  const commented = join(dir, 'comments.zip');
  writeFileSync(commented, buildZip([{ name: '1007.lua', data:
    `-- addappid(999) is documentation\n--[[\naddappid(998)\n]]\n`
    + sm.buildLua({ appid: FIXTURE_APP, name: 'A game about addappid(123)', depots: [] })
    + '\n-- setManifestid(999, "1", 123)\n' }]));
  try {
    const parsed = (await readGameArchive(commented, FIXTURE_APP)).gameData;
    if (Object.keys(parsed.dlcs).length || Object.keys(parsed.manifest_sizes).length) fails.push('Lua comments became package metadata');
    if (parsed.game_name !== 'A game about addappid(123)') fails.push('a game title containing Lua syntax was changed');
  } catch (err) { fails.push(`Lua comments changed the archive identity: ${err.message}`); }
  const bomFile = join(dir, 'bom.zip');
  writeFileSync(bomFile, buildZip([{ name: '1007.lua', data: '\uFEFFaddappid(1007) -- App\n' }]));
  try { await readGameArchive(bomFile, FIXTURE_APP); }
  catch (err) { fails.push(`UTF-8 BOM was not accepted: ${err.message}`); }

  // The engine's own key check is what would fail later; assert the shape it wants.
  for (const [id, d] of Object.entries(g.depots)) {
    if (!/^[0-9a-f]{64}$/i.test(d.key)) fails.push(`depot ${id} key is not 64 hex characters`);
  }
  // Enrichment describes today's public build. It must not relabel an older
  // package as that build, which would persist a false version in the ACF.
  const steamApi = core('steamApi.js');
  const originalInfo = steamApi.getDepotInfoFromApi;
  const processor = core('zipProcessor.js');
  try {
    for (const [latest, expected] of [['777', '9000'], ['888', undefined], [null, undefined]]) {
      steamApi.getDepotInfoFromApi = async () => ({ buildid: '9000', depotConfigs: {
        [FIXTURE_DEPOT]: { manifestId: FIXTURE_GID }, '1005': { manifestId: latest },
      } });
      const processed = await processor.processZip(file, FIXTURE_APP);
      try { if (processed.buildid !== expected) fails.push(`public manifest ${latest}: package build ${processed.buildid}, expected ${expected}`); }
      finally { processor.cleanupManifestDir(processed.manifest_dir); }
    }
  } finally { steamApi.getDepotInfoFromApi = originalInfo; }
  return fails;
}

// ── keys ────────────────────────────────────────────────────────
async function keys() {
  const fails = [];
  const depotKeys = core('depotKeys.js');
  const { processZip, cleanupManifestDir } = core('zipProcessor.js');
  const store = temp('steammanifest-keys-');

  // Harvest from a real Hubcap package, through the code the queue runs.
  const previous = fakeUserData;
  fakeUserData = store;
  let data;
  try { data = await processZip(HUBCAP_ZIP, '2062430'); }
  catch (err) { fails.push(`processZip failed on the reference package: ${err.message}`); }
  finally { if (data?.manifest_dir) cleanupManifestDir(data.manifest_dir); fakeUserData = previous; }
  const harvested = depotKeys.load(store);
  if (!harvested['2062431'] || !harvested['2062432']) fails.push(`processZip did not remember the package's keys: ${JSON.stringify(Object.keys(harvested))}`);
  if (data) {
    for (const [id, d] of Object.entries(data.depots || {})) {
      if (harvested[id] !== String(d.key).toLowerCase()) fails.push(`depot ${id}: stored ${harvested[id]} != package ${d.key}`);
    }
  }

  // Validation: ids and keys that are not ids and keys are dropped.
  const dirty = temp('steammanifest-keys-dirty-');
  const added = depotKeys.remember({
    '1004': KEY_A.toUpperCase(),
    '1005': { key: KEY_B },
    'notanid': KEY_A,
    '1006': 'zz',
    '1007': '',
    '12345678901': KEY_A,
    '1008': KEY_A + 'a',
  }, dirty);
  const cleaned = depotKeys.load(dirty);
  if (added !== 2) fails.push(`remember reported ${added} new keys, expected 2`);
  if (Object.keys(cleaned).sort().join(',') !== '1004,1005') fails.push(`stored ${JSON.stringify(cleaned)}`);
  if (cleaned['1004'] !== KEY_A) fails.push('an uppercase key was not normalised');
  if (depotKeys.remember({ '1004': KEY_A }, dirty) !== 0) fails.push('re-remembering a known key counted as new');
  if (depotKeys.remember({ '1004': KEY_C }, dirty) !== 1 || depotKeys.load(dirty)['1004'] !== KEY_C) fails.push('a changed key did not replace the old one');

  // Precedence: a key file is the weakest, then the store, then the Steam
  // client's own config — the account that owns the game.
  const mix = temp('steammanifest-keys-mix-');
  const keyFile = join(mix, 'depot_keys.json');
  writeFileSync(keyFile, JSON.stringify({ '1004': KEY_A, '2001': KEY_A, '3001': KEY_A }));
  depotKeys.remember({ '1004': KEY_B, '2001': KEY_B }, mix);
  const steamDir = join(mix, 'steam');
  mkdirSync(join(steamDir, 'config'), { recursive: true });
  writeFileSync(join(steamDir, 'config', 'config.vdf'), `"InstallConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"depots"\n\t\t\t\t{\n\t\t\t\t\t"1004"\n\t\t\t\t\t{\n\t\t\t\t\t\t"DecryptionKey"\t\t"${KEY_C.toUpperCase()}"\n\t\t\t\t\t}\n\t\t\t\t\t"4001"\n\t\t\t\t\t{\n\t\t\t\t\t\t"DecryptionKey"\t\t"${KEY_C}"\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n`);
  const merged = depotKeys.collect({ userData: mix, steamPath: steamDir, files: [keyFile] });
  if (merged['1004'] !== KEY_C) fails.push(`Steam's own config did not win for 1004: ${merged['1004']}`);
  if (merged['2001'] !== KEY_B) fails.push(`the store did not win over the key file for 2001: ${merged['2001']}`);
  if (merged['3001'] !== KEY_A) fails.push(`the key file was not read for 3001: ${merged['3001']}`);
  if (merged['4001'] !== KEY_C) fails.push('a key only Steam knows was not collected');
  const fromSteam = depotKeys.fromSteamConfig(steamDir);
  if (fromSteam['1004'] !== KEY_C) fails.push('config.vdf keys are not lower-cased');
  if (Object.keys(depotKeys.fromSteamConfig(join(mix, 'nowhere'))).length) fails.push('a missing Steam folder yielded keys');

  // Durability: the same transaction the queue uses, and a corrupt file is
  // recovered rather than treated as a first run.
  const durable = temp('steammanifest-keys-durable-');
  depotKeys.remember({ '1004': KEY_A }, durable);
  const file = depotKeys.filePath(durable);
  if (!existsSync(`${file}.bak`)) {
    depotKeys.remember({ '1005': KEY_B }, durable);
    if (!existsSync(`${file}.bak`)) fails.push('no backup is written beside the key store');
  }
  writeFileSync(file, '{ this is not json');
  const recovered = depotKeys.load(durable);
  if (!recovered['1004']) fails.push(`a corrupt key store lost every key: ${JSON.stringify(recovered)}`);
  if (!readdirSync(durable).some((f) => f.includes('.corrupt-'))) fails.push('the corrupt key store was not preserved');
  if (depotKeys.remember({ '1006': KEY_C }, durable) !== 1 || !depotKeys.load(durable)['1006']) fails.push('the store did not accept a write after recovery');
  // A store that cannot be written must not throw into a download: a file
  // where the folder should be is the case that cannot be created on demand.
  const blocked = join(durable, 'blocked');
  writeFileSync(blocked, 'not a directory');
  if (depotKeys.remember({ '1004': KEY_A }, blocked) !== 0) fails.push('an unwritable store reported success');
  if (Object.keys(depotKeys.load(blocked)).length) fails.push('an unwritable store returned keys');
  return fails;
}

// ── fetch ───────────────────────────────────────────────────────
async function fetchSuite() {
  const fails = [];
  const sm = core('steamManifest.js');
  const depotKeys = core('depotKeys.js');
  const dir = sm.resolveDir().dir;
  const manifest = readFileSync(FIXTURE_MANIFEST);
  const raw = readFileSync(FIXTURE_RAW);
  const other = makeManifest(dir, '1005', '888');

  const cdn = await startCdn({
    [`${FIXTURE_DEPOT}_${FIXTURE_GID}`]: raw,
    '1005_888': asCdnZip(other),
  });
  // The mirror issues a request code; the CDN above serves the fixture bytes
  // when that code is used, so the denied-CDN path still lands the manifest.
  const mirror = await startMirror({
    [`${FIXTURE_DEPOT}_${FIXTURE_GID}`]: '12345678901234567890',
    '1005_888': '12345678901234567890',
    '601_999': '12345678901234567890',
  });

  const apps = {
    [FIXTURE_APP]: appinfo({
      name: 'Steamworks SDK Redist', type: 'Tool', buildid: '4242',
      depots: { [FIXTURE_DEPOT]: { gid: FIXTURE_GID, size: 22986368, oslist: 'windows' }, '228989': { gid: '1', size: 1 } },
      dlcs: '1008',
    }),
    '600': appinfo({ name: 'Paid Game', depots: { '601': { gid: '999', size: 10 } } }),
    '700': appinfo({ name: 'Partly Available', depots: { [FIXTURE_DEPOT]: { gid: FIXTURE_GID, size: 5 }, '1005': { gid: '888', size: 6 }, '1006': { gid: '404', size: 7 } } }),
  };

  // (a) A free app: the key is already in the project's own key file, so that
  // is the key the package must carry, without asking Steam for one.
  const fileKey = JSON.parse(readFileSync(join(dir, 'depot_keys.json'), 'utf8'))[FIXTURE_DEPOT];
  if (!/^[0-9a-f]{64}$/.test(String(fileKey || ''))) fails.push(`the vendored key file has no usable key for depot ${FIXTURE_DEPOT}`);
  const userData = temp('steammanifest-fetch-a-');
  const client = mockClient({ apps, cdnHost: cdn.host, keys: { [FIXTURE_DEPOT]: KEY_A } });
  const res = await sm.downloadManifest(FIXTURE_APP, { client, userData, steamPath: '', mirrorFallbacks: [], mirror: mirror.endpoint, keys: {}, keyFiles: [] });
  if (res.error) fails.push(`the free app was refused: ${res.error}`);
  else {
    if (!res.filepath || !existsSync(res.filepath)) fails.push('no package was written');
    else {
      if (relative(join(userData, sm.MANIFEST_DIR), res.filepath).startsWith('..')) fails.push(`the package was written outside ${sm.MANIFEST_DIR}: ${res.filepath}`);
      const { readGameArchive } = core('zipProcessor.js');
      const archive = await readGameArchive(res.filepath, FIXTURE_APP);
      if (!archive.manifestFiles[`${FIXTURE_DEPOT}_${FIXTURE_GID}.manifest`]?.equals(manifest)) fails.push('the packaged manifest is not the fixture, byte for byte');
      if (archive.gameData.depots[FIXTURE_DEPOT]?.key !== fileKey) fails.push(`the packaged Lua carries ${archive.gameData.depots[FIXTURE_DEPOT]?.key}, not the key from the project key file`);
      if (client.calls.keys.length) fails.push(`Steam was asked for a key it did not need: ${client.calls.keys.join(',')}`);
      if (archive.gameData.buildid && archive.gameData.buildid !== '4242') fails.push('the package carries a different build');
      if (archive.gameData.depots['228989']) fails.push('a blacklisted redistributable depot was packaged');
      if (client.calls.codes.length) fails.push('a direct Steam request-code attempt was made');
    }
    if (res.counts?.mirror !== 1 || res.counts?.steam !== 0) fails.push(`counts ${JSON.stringify(res.counts)}, expected the relay only`);
    if (depotKeys.load(userData)[FIXTURE_DEPOT]) fails.push('a key that was already known was written to the store again');
    if (!/assembled from Steam/.test(res.note || '')) fails.push(`note "${res.note}"`);
  }

  // (b) Steam refuses the request code: the mirror issues one, and the manifest
  //     is downloaded from the Steam CDN with it.
  const userDataB = temp('steammanifest-fetch-b-');
  const clientB = mockClient({ apps, cdnHost: cdn.host, keys: { [FIXTURE_DEPOT]: KEY_A }, denied: new Set([FIXTURE_DEPOT]) });
  const before = mirror.hits.length;
  const resB = await sm.downloadManifest(FIXTURE_APP, { client: clientB, userData: userDataB, steamPath: '', mirrorFallbacks: [], mirror: mirror.endpoint, keys: {}, keyFiles: [] });
  if (resB.error) fails.push(`the denied app was not served from the mirror: ${resB.error}`);
  else {
    if (resB.counts?.mirror !== 1) fails.push(`counts ${JSON.stringify(resB.counts)}, expected one from the mirror`);
    if (mirror.hits.length <= before) fails.push('the mirror was never asked');
    const { readGameArchive } = core('zipProcessor.js');
    const archive = await readGameArchive(resB.filepath, FIXTURE_APP);
    if (!archive.manifestFiles[`${FIXTURE_DEPOT}_${FIXTURE_GID}.manifest`]?.equals(manifest)) fails.push('the mirror package holds different manifest bytes');
  }

  // (c) A paid app with no key anywhere: refused, with the message that says
  // where keys come from, and nothing left on disk.
  const userDataC = temp('steammanifest-fetch-c-');
  const clientC = mockClient({ apps, cdnHost: cdn.host, keys: {} });
  const resC = await sm.downloadManifest('600', { client: clientC, userData: userDataC, steamPath: '', mirrorFallbacks: [], mirror: mirror.endpoint, keys: {}, keyFiles: [] });
  if (!resC.error) fails.push('a paid app with no key was packaged anyway');
  else {
    if (!/no key/i.test(resC.error) || !/config\.vdf/.test(resC.error) || !/Hubcap/.test(resC.error)) fails.push(`the refusal does not say where keys come from: ${resC.error}`);
    if (resC.filepath) fails.push('a refused fetch still returned a file');
  }
  const leftBehind = existsSync(join(userDataC, sm.MANIFEST_DIR)) ? readdirSync(join(userDataC, sm.MANIFEST_DIR)) : [];
  if (leftBehind.length) fails.push(`a refused fetch left ${leftBehind.join(',')} on disk`);

  // (c2) The same app once its key is known from elsewhere: packaged.
  depotKeys.remember({ '601': KEY_B }, userDataC);
  const cdn2 = await startCdn({ '601_999': asCdnZip(makeManifest(dir, '601', '999')) });
  const clientC2 = mockClient({ apps, cdnHost: cdn2.host, keys: {} });
  const resC2 = await sm.downloadManifest('600', { client: clientC2, userData: userDataC, steamPath: '', mirrorFallbacks: [], mirror: mirror.endpoint, keyFiles: [] });
  if (resC2.error) fails.push(`a paid app with a stored key was still refused: ${resC2.error}`);
  else {
    const { readGameArchive } = core('zipProcessor.js');
    const archive = await readGameArchive(resC2.filepath, '600');
    if (archive.gameData.depots['601']?.key !== KEY_B) fails.push('the stored key was not used for the paid app');
  }

  // (d) One depot nobody can serve: left out and reported, the rest packaged.
  const userDataD = temp('steammanifest-fetch-d-');
  const clientD = mockClient({ apps, cdnHost: cdn.host, keys: { [FIXTURE_DEPOT]: KEY_A, '1005': KEY_B, '1006': KEY_C } });
  const resD = await sm.downloadManifest('700', { client: clientD, userData: userDataD, steamPath: '', mirrorFallbacks: [], mirror: mirror.endpoint, keys: {}, keyFiles: [], resolveCatalogKeys: async () => ({ '1005': KEY_B, '1006': KEY_C }) });
  if (resD.error) fails.push(`a partly available app was refused outright: ${resD.error}`);
  else {
    if (resD.depots !== 2) fails.push(`packaged ${resD.depots} depots, expected 2`);
    const out = (resD.leftOut || []).map((d) => d.id).join(',');
    if (out !== '1006') fails.push(`left out ${out}, expected 1006`);
    if (!/no manifest/.test((resD.leftOut || [])[0]?.reason || '')) fails.push(`the reason is "${(resD.leftOut || [])[0]?.reason}"`);
    const { readGameArchive } = core('zipProcessor.js');
    const archive = await readGameArchive(resD.filepath, '700');
    if (Object.keys(archive.gameData.depots).sort().join(',') !== `${FIXTURE_DEPOT},1005`) fails.push(`the package lists ${Object.keys(archive.gameData.depots).join(',')}`);
    if (!archive.manifestFiles['1005_888.manifest']?.equals(other)) fails.push('the second depot\'s manifest is not what the CDN served');
    if (archive.gameData.depots['1005']?.key !== KEY_B) fails.push('the catalog key for depot 1005 is not in the package');
    if (clientD.calls.keys.length) fails.push('Steam was asked for a depot key');
    if (depotKeys.load(userDataD)['1005'] !== KEY_B) fails.push('the catalog key was not remembered for later');
  }

  // (e) A manifest that is not the one asked for is refused, not packaged.
  const liar = await startCdn({ [`${FIXTURE_DEPOT}_${FIXTURE_GID}`]: asCdnZip(makeManifest(dir, '9999', '1')) });
  const userDataE = temp('steammanifest-fetch-e-');
  const clientE = mockClient({ apps, cdnHost: liar.host, keys: { [FIXTURE_DEPOT]: KEY_A } });
  const resE = await sm.downloadManifest(FIXTURE_APP, { client: clientE, userData: userDataE, steamPath: '', mirrorFallbacks: [], mirror: mirror.endpoint, keys: {}, keyFiles: [] });
  if (!resE.error) fails.push('a manifest for the wrong depot was accepted');
  else if (!/no depot|could be packaged/i.test(resE.error)) fails.push(`the wrong-manifest refusal reads "${resE.error}"`);

  // (f) An invalid AppID never reaches Steam.
  const resF = await sm.downloadManifest('not-an-id', { client, userData, steamPath: '' });
  if (!/Invalid AppID/.test(resF.error || '')) fails.push(`an invalid AppID gave "${resF.error}"`);
  return fails;
}

// ── stale ───────────────────────────────────────────────────────
async function stale() {
  const fails = [];
  const sm = core('steamManifest.js');
  const depotKeys = core('depotKeys.js');
  const { buildZip } = core('zipWriter.js');
  const { readGameArchive } = core('zipProcessor.js');
  const dir = sm.resolveDir().dir;
  const work = temp('steammanifest-stale-');

  const OLD = '1111111111111111111';
  const NEW_1005 = '2222222222222222222';
  const manifest1004 = readFileSync(FIXTURE_MANIFEST);           // depot 1004, current
  const manifest1005old = makeManifest(dir, '1005', OLD);        // depot 1005, what Hubcap has
  const manifest1005new = makeManifest(dir, '1005', NEW_1005);   // depot 1005, what Steam serves

  /** A Hubcap package for app 1007: depot 1004 current, depot 1005 as given. */
  const hubcapPackage = (name, depot1005ManifestId, depot1005Bytes, depot1004Bytes = manifest1004) => {
    const lua = [
      "-- 1007's Lua and Manifest Created by Morrenus",
      '-- Steamworks SDK Redist',
      'addappid(1007) -- Steamworks SDK Redist',
      `addappid(${FIXTURE_DEPOT}, 1, "${KEY_A}") -- Depot ${FIXTURE_DEPOT}`,
      `setManifestid(${FIXTURE_DEPOT}, "${FIXTURE_GID}", 22986368)`,
      `addappid(1005, 1, "${KEY_B}") -- Depot 1005`,
      `setManifestid(1005, "${depot1005ManifestId}", 4096)`,
      '',
    ].join('\n');
    const file = join(work, name);
    writeFileSync(file, buildZip([
      { name: '1007.lua', data: lua },
      { name: `${FIXTURE_DEPOT}_${FIXTURE_GID}.manifest`, data: depot1004Bytes },
      { name: `1005_${depot1005ManifestId}.manifest`, data: depot1005Bytes },
    ]));
    return file;
  };

  const apps = {
    [FIXTURE_APP]: appinfo({
      name: 'Steamworks SDK Redist', type: 'Tool', buildid: '5000',
      depots: { [FIXTURE_DEPOT]: { gid: FIXTURE_GID, size: 22986368 }, '1005': { gid: NEW_1005, size: 4096 } },
    }),
  };
  const cdn = await startCdn({ [`1005_${NEW_1005}`]: asCdnZip(manifest1005new) });
  const emptyCdn = await startCdn({});
  const relay = await startMirror({ ['1005_' + NEW_1005]: '12345678901234567890', [FIXTURE_DEPOT + '_' + FIXTURE_GID]: '12345678901234567890' });

  // (a) Behind on one depot: the latest is assembled, Hubcap's key kept and
  // its copy of the unchanged manifest reused rather than downloaded again.
  const userData = temp('steammanifest-stale-a-');
  const behindZip = hubcapPackage('behind.zip', OLD, manifest1005old);
  const client = mockClient({ apps, cdnHost: cdn.host, keys: {} });
  const out = await sm.refresh(FIXTURE_APP, behindZip, { client, userData, steamPath: '', mirrorFallbacks: [], mirror: relay.endpoint, keyFiles: [] });
  if (!out.checked) fails.push(`the package was not checked: ${out.error}`);
  if (!out.stale) fails.push('a package a build behind was reported current');
  if (out.compared !== 2) fails.push(`compared ${out.compared} depots, expected 2`);
  const behindIds = (out.behind || []).map((b) => `${b.id}:${b.have}->${b.latest}`).join(',');
  if (behindIds !== `1005:${OLD}->${NEW_1005}`) fails.push(`behind ${behindIds}`);
  if (out.buildid !== '5000') fails.push(`build ${out.buildid}`);
  if (!out.filepath || !existsSync(out.filepath)) fails.push(`no replacement package was written: ${out.error}`);
  else {
    const archive = await readGameArchive(out.filepath, FIXTURE_APP);
    if (archive.gameData.manifests['1005'] !== NEW_1005) fails.push(`the replacement still points at manifest ${archive.gameData.manifests['1005']}`);
    if (archive.gameData.manifests[FIXTURE_DEPOT] !== FIXTURE_GID) fails.push('the unchanged depot changed manifest');
    if (archive.gameData.depots['1005']?.key !== KEY_B || archive.gameData.depots[FIXTURE_DEPOT]?.key !== KEY_A) fails.push('the replacement did not carry Hubcap\'s keys');
    if (!archive.manifestFiles[`1005_${NEW_1005}.manifest`]?.equals(manifest1005new)) fails.push('the new manifest is not what Steam served');
    if (!archive.manifestFiles[`${FIXTURE_DEPOT}_${FIXTURE_GID}.manifest`]?.equals(manifest1004)) fails.push('the reused manifest is not Hubcap\'s copy');
    if (cdn.hits.includes(`${FIXTURE_DEPOT}_${FIXTURE_GID}`)) fails.push('the unchanged manifest was downloaded again instead of reused');
    if (!/behind on 1 of 2/.test(out.note || '')) fails.push(`note "${out.note}"`);
    if (!/kept from Hubcap/.test(out.note || '')) fails.push(`the note does not say a manifest was reused: "${out.note}"`);
  }
  // Hubcap's keys are worth keeping even when only the check ran.
  if (depotKeys.load(userData)[FIXTURE_DEPOT] !== KEY_A) fails.push('the checked package\'s keys were not remembered');

  // (b) Already current: reported so, nothing written.
  const userDataB = temp('steammanifest-stale-b-');
  const currentZip = hubcapPackage('current.zip', NEW_1005, manifest1005new);
  const clientB = mockClient({ apps, cdnHost: emptyCdn.host, keys: {} });
  const outB = await sm.refresh(FIXTURE_APP, currentZip, { client: clientB, userData: userDataB, steamPath: '', mirrorFallbacks: [], mirror: relay.endpoint, keyFiles: [] });
  if (!outB.checked) fails.push(`a current package was not checked: ${outB.error}`);
  if (outB.stale) fails.push('a current package was reported behind');
  if (outB.filepath) fails.push('a current package was replaced anyway');
  if (outB.behind.length) fails.push(`a current package listed ${outB.behind.length} behind`);
  if (!/current/.test(outB.note || '')) fails.push(`note "${outB.note}"`);
  if (existsSync(join(userDataB, sm.MANIFEST_DIR)) && readdirSync(join(userDataB, sm.MANIFEST_DIR)).length) fails.push('a current package still produced a file');
  if (clientB.calls.codes.length) fails.push('a current package still asked Steam for manifests');

  // (c) Behind, but the newer manifest is nowhere: Hubcap's package is kept
  // whole and the staleness reported. A partial package is worse than an old one.
  const userDataC = temp('steammanifest-stale-c-');
  const behindZipC = hubcapPackage('behind2.zip', OLD, manifest1005old);
  const sizeBefore = statSync(behindZipC).size;
  const clientC = mockClient({ apps, cdnHost: emptyCdn.host, keys: {} });
  const outC = await sm.refresh(FIXTURE_APP, behindZipC, { client: clientC, userData: userDataC, steamPath: '', mirrorFallbacks: [], mirror: relay.endpoint, keyFiles: [] });
  if (!outC.stale) fails.push('the unreplaceable case did not report staleness');
  if (outC.filepath) fails.push('a partial package was written when the newer manifest was unavailable');
  if (!/not available yet/.test(outC.error || '')) fails.push(`the unreplaceable case says "${outC.error}"`);
  if (!existsSync(behindZipC) || statSync(behindZipC).size !== sizeBefore) fails.push('Hubcap\'s package was not left intact');
  const wrote = existsSync(join(userDataC, sm.MANIFEST_DIR)) ? readdirSync(join(userDataC, sm.MANIFEST_DIR)) : [];
  if (wrote.length) fails.push(`the unreplaceable case left ${wrote.join(',')} behind`);

  // (c2) Behind on one depot, and a depot that was *current* cannot be
  // re-packaged either — its copy in the archive is unreadable and no source
  // has it. The replacement would be missing a depot the game needs, so
  // Hubcap's package is kept whole instead.
  const userDataC2 = temp('steammanifest-stale-c2-');
  const gappy = hubcapPackage('gappy.zip', OLD, manifest1005old, Buffer.from('not a manifest at all'));
  const onlyNewCdn = await startCdn({ [`1005_${NEW_1005}`]: asCdnZip(manifest1005new) });
  const clientC2 = mockClient({ apps, cdnHost: onlyNewCdn.host, keys: {} });
  const outC2 = await sm.refresh(FIXTURE_APP, gappy, { client: clientC2, userData: userDataC2, steamPath: '', mirrorFallbacks: [], mirror: relay.endpoint, keyFiles: [] });
  if (!outC2.stale) fails.push('the gappy case did not report staleness');
  if (outC2.filepath) fails.push('a package missing a depot Hubcap covered was written');
  if (!/could not be re-packaged/.test(outC2.error || '')) fails.push(`the gappy case says "${outC2.error}"`);
  if (!new RegExp(`\\b${FIXTURE_DEPOT}\\b`).test(outC2.error || '')) fails.push(`the gappy case does not name depot ${FIXTURE_DEPOT}: "${outC2.error}"`);
  const wroteC2 = existsSync(join(userDataC2, sm.MANIFEST_DIR)) ? readdirSync(join(userDataC2, sm.MANIFEST_DIR)) : [];
  if (wroteC2.length) fails.push(`the gappy case left ${wroteC2.join(',')} behind`);

  // (d) A package for an app whose depots Steam does not list cannot be
  // judged, and says so rather than claiming currency.
  const userDataD = temp('steammanifest-stale-d-');
  const strangerApps = { [FIXTURE_APP]: appinfo({ name: 'Steamworks SDK Redist', depots: { '4444': { gid: '1', size: 1 } } }) };
  const outD = await sm.refresh(FIXTURE_APP, currentZip, { client: mockClient({ apps: strangerApps, cdnHost: emptyCdn.host }), userData: userDataD, steamPath: '', keyFiles: [] });
  if (outD.checked) fails.push('a package sharing no depot with Steam was reported as checked');
  if (outD.stale || outD.filepath) fails.push('an uncheckable package was replaced');

  // (e) An unreadable package is reported, not thrown.
  const outE = await sm.refresh(FIXTURE_APP, join(work, 'nope.zip'), { client: mockClient({ apps, cdnHost: emptyCdn.host }), userData: temp('steammanifest-stale-e-'), steamPath: '' });
  if (!/could not be read/.test(outE.error || '')) fails.push(`a missing package gave "${outE.error}"`);
  // PICS may hide a shared depot. Comparing only the intersection must not
  // permit a replacement to silently discard it, or label the whole ZIP current.
  const partialApps = { [FIXTURE_APP]: appinfo({ name: 'Steamworks SDK Redist', depots: { '1005': { gid: NEW_1005 } } }) };
  for (const [zip, label] of [[behindZip, 'stale'], [currentZip, 'current']]) {
    const res = await sm.refresh(FIXTURE_APP, zip, { client: mockClient({ apps: partialApps, cdnHost: cdn.host }), userData: temp('steammanifest-partial-'), steamPath: '', appTokens: false, depotKeyCatalog: false });
    if (res.filepath) fails.push(`${label}: a depot missing from PICS was discarded by the replacement`);
    if (res.checked) fails.push(`${label}: incomplete PICS coverage was reported fully checked`);
    if (!res.error?.includes(FIXTURE_DEPOT)) fails.push(`${label}: the unchecked depot was not identified`);
  }
  return fails;
}

// ── endpoint-only production entry point ─────────────────────────
async function endpoint() {
  const fails = [];
  const sm = core('steamManifest.js');
  const source = read('src/core/steamManifest.js');
  if (/AnonymousCMClient|downloadFromCdn|getDepotDecryptionKey|getManifestRequestCode|client\.(?:connect|logOff)\(/.test(source)) {
    fails.push('the production source contains a direct Steam session/key/code path');
  }
  const dir = sm.resolveDir().dir;
  const sdk = appinfo({ name: 'Endpoint fixture', depots: {
    [FIXTURE_DEPOT]: { gid: FIXTURE_GID }, '1005': { depotfromapp: '2000' },
  } });
  const apps = { [FIXTURE_APP]: sdk, '2000': appinfo({ name: 'Shared parent', depots: { '1005': { gid: '777' } } }) };
  const requests = [];
  const server = createServer((req, res) => {
    const id = /\/v1\/info\/(\d+)$/.exec(req.url)?.[1];
    requests.push(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', data: id && apps[id] ? { [id]: apps[id] } : {} }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => server.close());
  const metadataEndpoint = `http://127.0.0.1:${server.address().port}/v1/info/`;
  const adapter = sm.createEndpointClient({ metadataEndpoint });
  const info = await sm.readDepots(adapter, FIXTURE_APP, { resolveTokens: () => { throw new Error('must not request session tokens'); } });
  if (info.depots.length !== 2 || info.depots.find(d => d.id === '1005')?.app !== '2000') fails.push('shared depot metadata was not resolved through the endpoint');
  await adapter.getProductInfo([1007, 1007, 2000]);
  if (requests.join(',') !== '1007,2000') fails.push(`metadata requests were not deduplicated: ${requests}`);
  if (adapter.connect || adapter.getDepotDecryptionKey || adapter.getManifestRequestCode) fails.push('the endpoint adapter exposes Steam session methods');
  const cdn = await startCdn({
    [`${FIXTURE_DEPOT}_${FIXTURE_GID}`]: readFileSync(FIXTURE_RAW),
    '1005_777': asCdnZip(makeManifest(dir, '1005', '777')),
  });
  const relay = await startMirror({ [`${FIXTURE_DEPOT}_${FIXTURE_GID}`]: '12345678901234567890', '1005_777': '12345678901234567890' });
  const output = await sm.downloadManifest(FIXTURE_APP, {
    metadataEndpoint, cdnHosts: [{ host: cdn.host, https_support: 'disabled' }],
    userData: temp('endpoint-entry-'), steamPath: '', proxies: [],
    mirror: relay.endpoint, mirrorFallbacks: [],
    resolveCatalogKeys: async () => ({ [FIXTURE_DEPOT]: KEY_A, '1005': KEY_B }),
  });
  if (output.error || output.depots !== 2 || output.counts?.steam !== 0 || output.counts?.mirror !== 2) fails.push(`default entry point did not use endpoints only: ${output.error || JSON.stringify(output.counts)}`);
  if (output.filepath) await core('zipProcessor.js').readGameArchive(output.filepath, FIXTURE_APP);
  for (const response of [{ ok: false, status: 503 }, { ok: true, json: async () => ({ status: 'success', data: {} }) }]) {
    const failed = await sm.downloadManifest(FIXTURE_APP, { userData: temp('endpoint-failure-'), fetchImpl: async () => response, proxies: [] });
    if (failed.filepath || !/Metadata endpoint/.test(failed.error || '')) fails.push('metadata failure did not stop without a Steam fallback');
  }
  return fails;
}

// ── search ──────────────────────────────────────────────────────
async function search() {
  const fails = [];
  const sm = core('steamManifest.js');

  const answer = (payload, ok = true, status = 200) => async () => ({ ok, status, json: async () => payload });
  const byName = await sm.searchGames('portal', {
    fetchImpl: answer({
      total: 3,
      items: [
        { type: 'app', id: 620, name: 'Portal 2' },
        { type: 'bundle', id: 999, name: 'Portal Bundle' },
        { type: 'app', id: 'x', name: 'Broken' },
        { type: 'app', id: 400, name: 'Portal' },
      ],
    }),
  });
  if (byName.error) fails.push(`a name search errored: ${byName.error}`);
  const shape = (byName.results || []).map((r) => `${r.game_id}:${r.game_name}`).join(',');
  if (shape !== '620:Portal 2,400:Portal') fails.push(`a name search gave ${shape}`);
  for (const r of byName.results || []) {
    if (typeof r.game_id !== 'string' || typeof r.game_name !== 'string') fails.push('a result is not in Hubcap\'s { game_id, game_name } shape');
  }

  // A bare number: the app with that id first, then anything with the number
  // in its title — "2077" is both an AppID and part of a name.
  const numericFetch = (details, items) => async (url) => (String(url).startsWith(APP_DETAILS_URL)
    ? { ok: true, status: 200, json: async () => details }
    : { ok: true, status: 200, json: async () => ({ items }) });
  const byId = await sm.searchGames('1007', {
    fetchImpl: numericFetch(
      { 1007: { success: true, data: { name: 'Steamworks SDK Redist' } } },
      [{ type: 'app', id: 220, name: 'Half-Life 2' }, { type: 'app', id: 1007, name: 'Steamworks SDK Redist' }],
    ),
  });
  const byIdShape = (byId.results || []).map((r) => r.game_id).join(',');
  if (byIdShape !== '1007,220') fails.push(`an AppID search gave ${byIdShape}, expected the app itself first then name matches`);
  if ((byId.results || [])[0]?.game_name !== 'Steamworks SDK Redist') fails.push('the AppID hit lost its name');
  const unknownId = await sm.searchGames('99999999', { fetchImpl: numericFetch({ 99999999: { success: false } }, []) });
  if ((unknownId.results || []).length) fails.push('an unknown AppID returned a result');
  // The name search failing does not lose an AppID that did resolve.
  const halfDown = await sm.searchGames('1007', {
    fetchImpl: async (url) => (String(url).startsWith(APP_DETAILS_URL)
      ? { ok: true, status: 200, json: async () => ({ 1007: { success: true, data: { name: 'Steamworks SDK Redist' } } }) }
      : { ok: false, status: 503, json: async () => ({}) }),
  });
  if ((halfDown.results || []).length !== 1 || halfDown.error) fails.push(`an AppID hit was lost when the name search failed: ${JSON.stringify(halfDown)}`);
  for (const failedEndpoint of ['details', 'search']) {
    for (const failure of ['network', 'json']) {
      const partial = await sm.searchGames('1007', { fetchImpl: async (url) => {
        const details = String(url).startsWith(APP_DETAILS_URL);
        if (details === (failedEndpoint === 'details')) {
          if (failure === 'network') throw new Error('connection reset');
          return { ok: true, json: async () => { throw new Error('invalid JSON'); } };
        }
        return { ok: true, json: async () => details ? { 1007: { success: true, data: { name: 'Redist' } } } : { items: [{ type: 'app', id: 220, name: 'Half-Life 2' }] } };
      } });
      if (partial.error || partial.results?.[0]?.game_id !== (failedEndpoint === 'details' ? '220' : '1007')) fails.push(`${failedEndpoint}/${failure} discarded the other search result`);
    }
  }
  const tooShort = await sm.searchGames('a', { fetchImpl: answer({}) });
  if (!tooShort.error) fails.push('a one-character query was not refused');
  const httpError = await sm.searchGames('portal', { fetchImpl: answer({}, false, 503) });
  if (!/503/.test(httpError.error || '')) fails.push(`an HTTP failure gave "${httpError.error}"`);
  const thrown = await sm.searchGames('portal', { fetchImpl: async () => { throw new Error('offline'); } });
  if (!/offline/.test(thrown.error || '')) fails.push(`a thrown request gave "${thrown.error}"`);

  // Auto unions both answers, Hubcap's order first, one entry per app.
  const union = sm.unionResults(
    [{ game_id: '620', game_name: 'Portal 2 (Hubcap)' }, { game_id: '400', game_name: 'Portal' }],
    [{ game_id: '400', game_name: 'Portal (Steam)' }, { game_id: '70', game_name: 'Half-Life' }],
  );
  if (union.map((r) => r.game_id).join(',') !== '620,400,70') fails.push(`the union is ${union.map((r) => r.game_id).join(',')}`);
  if (union[1].game_name !== 'Portal') fails.push('the union did not keep the first source\'s name');

  // The source order, for every combination that can occur.
  const cases = [
    [{ mode: 'auto', hasKey: true, available: true }, 'hubcap,steammanifest'],
    [{ mode: 'auto', hasKey: false, available: true }, 'steammanifest'],
    [{ mode: 'auto', hasKey: true, available: false }, 'hubcap'],
    [{ mode: 'auto', hasKey: false, available: false }, ''],
    [{ mode: 'hubcap', hasKey: true, available: true }, 'hubcap'],
    [{ mode: 'hubcap', hasKey: false, available: true }, 'hubcap'],
    [{ mode: 'steammanifest', hasKey: true, available: true }, 'steammanifest'],
    [{ mode: 'steammanifest', hasKey: true, available: false }, 'steammanifest'],
  ];
  for (const [input, expected] of cases) {
    const got = sm.sourceOrder(input).join(',');
    if (got !== expected) fails.push(`sourceOrder(${JSON.stringify(input)}) = "${got}", expected "${expected}"`);
  }

  // The mirror setting: an address is kept, nonsense is ignored rather than
  // becoming a request to somewhere unintended.
  for (const [input, expected] of [
    ['', ''], ['https://mirror.example/', 'https://mirror.example'], ['http://127.0.0.1:3000/relay/', 'http://127.0.0.1:3000/relay'],
    ['not a url', ''], ['file:///etc/passwd', ''], ['ftp://mirror.example', ''],
  ]) {
    const got = sm.mirrorEndpoint(input);
    if (got !== expected) fails.push(`mirrorEndpoint(${JSON.stringify(input)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }

  // Where the project is: a configured folder that is not a checkout must
  // not switch the source off.
  const where = sm.resolveDir({ dir: join(tmpdir(), 'definitely-not-a-checkout') });
  if (where.missing) fails.push('a bad folder setting disabled the source instead of falling back');
  if (!where.configuredMissing) fails.push('a bad folder setting was not reported');
  if (resolve(where.dir) !== resolve(where.bundled)) fails.push(`the fallback is ${where.dir}, not the bundled copy`);
  const good = sm.resolveDir({ dir: '' });
  if (good.missing) fails.push(`the bundled copy is not a checkout: ${good.dir}`);
  if (good.from !== 'bundled') fails.push(`with no setting the source came from ${good.from}`);

  const st = sm.status({ steamPath: '' });
  if (!st.available) fails.push(`status says the source is unavailable: ${st.error}`);
  if (!st.version?.copied) fails.push('status does not report the vendored copy\'s version');
  return fails;
}

// ── wiring ──────────────────────────────────────────────────────
function wiring(root = ROOT) {
  const fails = [];
  const main = read('main.js', root);
  const preload = read('preload.js', root);
  const settings = read('src/core/settingsStore.js', root);
  const html = read('src/index.html', root);
  const app = read('src/js/app.js', root);
  const zipProcessor = read('src/core/zipProcessor.js', root);
  const smoke = read('dev/electron-smoke.cjs', root);
  const regression = read('dev/run-regression.cjs', root);
  const pkg = JSON.parse(read('package.json', root));

  // Channels: preload and main must agree, in both directions.
  for (const ch of ['steammanifest:status']) {
    if (!preload.includes(`'${ch}'`)) fails.push(`preload does not invoke ${ch}`);
    if (!main.includes(`ipcMain.handle('${ch}'`)) fails.push(`main has no handler for ${ch}`);
  }
  if (!preload.includes("'steammanifest:log'")) fails.push('preload does not listen on steammanifest:log');
  if (!/sendToRenderer\('steammanifest:log'/.test(main)) fails.push('main never sends steammanifest:log');
  const invoked = new Set([...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]));
  const handled = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]));
  for (const ch of invoked) if (!handled.has(ch)) fails.push(`preload invokes ${ch}, which main does not handle`);
  for (const ch of handled) {
    if (!invoked.has(ch) && !preload.includes(`'${ch}'`)) fails.push(`main handles ${ch}, which preload never invokes`);
  }

  // Settings: the keys exist in DEFAULTS — settings.set() throws on a key that
  // does not — with the enum that constrains the picker. Measured inside the
  // DEFAULTS block, because ENUMS names the same key further down the file.
  const defaults = settings.slice(settings.indexOf('const DEFAULTS = {'), settings.indexOf('const ENUMS = {'));
  if (defaults.length < 500) fails.push('settingsStore no longer has a DEFAULTS block before ENUMS');
  for (const key of ['manifest_source', 'steammanifest_dir', 'steammanifest_mirror']) {
    if (!new RegExp(`^\\s*${key}: '`, 'm').test(defaults)) fails.push(`settingsStore DEFAULTS has no ${key}`);
  }
  if (!/manifest_source: \['auto', 'hubcap', 'steammanifest'\]/.test(settings)) fails.push('settingsStore does not constrain manifest_source to the three sources');

  // Markup the renderer reads and writes.
  for (const id of ['sel-manifest-source', 'inp-steammanifest-mirror', 'steammanifest-dir-label', 'btn-steammanifest-browse', 'btn-steammanifest-dir-reset', 'steammanifest-tools-line']) {
    if (!html.includes(`id="${id}"`)) fails.push(`the markup has no #${id}`);
    if (!app.includes(`#${id}`)) fails.push(`the renderer never addresses #${id}`);
  }
  for (const value of ['auto', 'hubcap', 'steammanifest']) {
    if (!new RegExp(`<option value="${value}"`).test(html)) fails.push(`the picker has no ${value} option`);
  }

  // The renderer saves and reloads the setting, and refreshes what is in effect.
  if (!/values\.manifest_source = \$\('#sel-manifest-source'\)\.value/.test(app)) fails.push('the renderer never saves manifest_source');
  if (!/values\.steammanifest_mirror = /.test(app)) fails.push('the renderer never saves steammanifest_mirror');
  if (!/setSetting\('steammanifest_dir'/.test(app)) fails.push('the renderer never saves steammanifest_dir');
  if (!/refreshSteamManifestStatus\(\)/.test(app)) fails.push('the renderer never asks which sources are in effect');
  if (!/\['steammanifest', setupSteamManifest\]/.test(app)) fails.push('setupSteamManifest is not one of the renderer\'s setup steps');

  // The Store gates on the sources in effect, not on the Hubcap key.
  if (!/if \(!storeSourcesReady\(\)\) \{/.test(app)) fails.push('the store catalog does not gate on the sources in effect');
  if (/A Hubcap API key is required/.test(app)) fails.push('the store still refuses to search without a Hubcap key');
  if (!/onSteamManifestLog\?\.\(\(line\) => \{ if \(typeof line === 'string' && line\) log\(line\); \}\)/.test(app)) fails.push('the source\'s progress lines are not relayed to the download log');
  if (!/function manifestReadyLine/.test(app) || !/log\(manifestReadyLine\(res\)/.test(app)) fails.push('the log does not say what the source did');
  // Auto asks both sources: one failing while the other answers must be said,
  // or a half-covered search looks complete.
  if (!/return failed\.length \? \{ results, warning: failed\.join\(' · '\) \} : \{ results \}/.test(main)) fails.push('main does not report a source that failed while the other answered');
  if (!/function noteSearchWarning\(warning\) \{/.test(app) || (app.match(/noteSearchWarning\(res\.warning\)/g) || []).length < 2) fails.push('the renderer does not show which source failed');

  // Both sources are one pipeline: one search door, one fetch door, and the
  // freshness check between them.
  if (!/ipcMain\.handle\('hubcap:search', \(_, query\) => searchManifestSources\(query\)\)/.test(main)) fails.push('search does not go through the shared source door');
  if (!/game:suggestAppId', \(_, gameName\) => searchManifestSources\(gameName\)/.test(main)) fails.push('AppID suggestions do not go through the shared source door');
  if (!/local\.refresh\(appId, hub\.filepath/.test(main)) fails.push('main never checks Hubcap\'s package against Steam');
  if (!/if \(hub\.error\) \{[\s\S]{0,200}local\.downloadManifest/.test(main)) fails.push('main does not fall back to the local source when Hubcap fails');
  // Every fetch owns its own file: a queue job deletes its package when it
  // finishes, so two jobs must never be handed the same path.
  if (/manifestFetches/.test(main)) fails.push('manifest fetches are coalesced per app, so two jobs can share one file');
  if (!/ipcMain\.handle\('hubcap:download', \(_, appId\) => fetchManifestPackage\(appId\)\)/.test(main)) fails.push('the download door does not go straight to the source pipeline');
  if (!/function manifestSourceState/.test(main) || !/sourceOrder\(\{ mode, hasKey, available: status\.available \}\)/.test(main)) fails.push('main does not derive the source order from the setting, the key and availability');
  if (!/fs\.unlinkSync\(hub\.filepath\)/.test(main)) fails.push('a replaced Hubcap package is left on disk');

  // Keys are harvested wherever a package is read.
  if (!/require\('\.\/depotKeys'\)\.remember\(gameData\.depots, options\.userData\)/.test(zipProcessor)) fails.push('zipProcessor does not remember a package\'s depot keys');
  if (!/readGameArchive/.test(zipProcessor.slice(zipProcessor.indexOf('module.exports')))) fails.push('zipProcessor does not export readGameArchive for the freshness check');
  if (!/DEPOT_BLACKLIST/.test(zipProcessor.slice(zipProcessor.indexOf('module.exports')))) fails.push('zipProcessor does not export its depot blacklist');

  // Harnesses: the smoke pins the source it stubs, and the runner lists the suites.
  if (!/manifest_source: 'hubcap'/.test(smoke)) fails.push('the Electron smoke does not pin its manifest source');
  for (const suite of ['deps', 'zip', 'lua', 'keys', 'fetch', 'stale', 'search', 'wiring', 'integrity', 'self-test']) {
    if (!new RegExp(`'${suite}'`).test(regression.slice(regression.indexOf('steammanifest') - 400, regression.indexOf('steammanifest') + 40))) {
      fails.push(`the regression runner does not list the ${suite} suite`);
    }
  }
  if (!(pkg.build.extraResources || []).some((r) => r.from === 'deps')) fails.push('package.json no longer ships deps/ as resources');
  return fails;
}

// ── integrity ───────────────────────────────────────────────────
function integrity(root = ROOT) {
  const fails = [];
  const files = ['main.js', 'preload.js'];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'vendor') walk(file); }
      else if (/\.js$/.test(entry.name)) files.push(relative(root, file));
    }
  };
  walk(join(root, 'src'));
  for (const rel of ['re/cm_client.js', 're/manifest_format.js', 're/xyz_client.js', 're/http.js', 're/ids.js', 're/vdf.js', 'fetch-manifest.js', 'fetch-lua.js', 'assemble.js', 'fetch-xyz.js']) {
    const file = join(root, 'deps', 'steammanifest', rel);
    if (existsSync(file)) files.push(relative(root, file));
  }
  for (const rel of files) {
    try { new (requireFrom('node:vm').Script)(readFileSync(join(root, rel), 'utf8'), { filename: rel }); }
    catch (err) { fails.push(`${rel} does not parse: ${err.message}`); }
  }
  if (!files.some((f) => f.endsWith('steamManifest.js'))) fails.push('src/core/steamManifest.js is missing');
  if (!files.some((f) => f.endsWith('depotKeys.js'))) fails.push('src/core/depotKeys.js is missing');
  if (!files.some((f) => f.endsWith('zipWriter.js'))) fails.push('src/core/zipWriter.js is missing');

  // Every stylesheet must stay balanced, and the classes the new markup uses
  // are looked for across all of them: they are layered, not one file.
  const sheets = readdirSync(join(root, 'src', 'styles')).filter((f) => f.endsWith('.css'));
  let stripped = '';
  for (const sheet of sheets) {
    const text = read(join('src', 'styles', sheet), root).replace(/\/\*[\s\S]*?\*\//g, '');
    const open = (text.match(/\{/g) || []).length;
    const close = (text.match(/\}/g) || []).length;
    if (open !== close) fails.push(`src/styles/${sheet} is unbalanced: ${open} { vs ${close} }`);
    stripped += `
${text}`;
  }
  const css = stripped;

  // The new markup borrows the folder row; the rule must address it by class,
  // not by the other source's id, or the path does not ellipsise.
  const html = read('src/index.html', root);
  const row = /<div class="csrin-dir-row">\s*<span class="font-mono text-dim" id="steammanifest-dir-label"/.test(html);
  if (!row) fails.push('the steammanifest folder row is not the shared folder row');
  if (!/\.csrin-dir-row > \.font-mono \{/.test(css)) fails.push('the folder row styles only one source\'s label');
  for (const cls of ['setting-hint', 'form-input', 'form-group', 'csrin-dir-row']) {
    if (!new RegExp(`\\.${cls}[\\s,{>:.]`).test(stripped)) fails.push(`the markup uses .${cls}, which no stylesheet defines`);
  }
  return fails;
}

// ── self-test ───────────────────────────────────────────────────
const CHECKED_FILES = [
  'main.js', 'preload.js', 'package.json', 'src/index.html', 'src/js/app.js',
  'src/core/settingsStore.js', 'src/core/zipProcessor.js', 'src/core/steamManifest.js',
  'src/core/depotKeys.js', 'src/core/zipWriter.js', 'src/styles/main.css',
  'dev/electron-smoke.cjs', 'dev/run-regression.cjs',
];
function selfTest() {
  const fails = [];
  const base = mkdtempSync(join(tmpdir(), 'steammanifest-selftest-'));
  const copy = (name) => {
    const dir = join(base, name);
    for (const f of CHECKED_FILES) { mkdirSync(dirname(join(dir, f)), { recursive: true }); cpSync(join(ROOT, f), join(dir, f)); }
    for (const f of ['src/core', 'src/js', 'src/styles']) {
      mkdirSync(join(dir, f), { recursive: true });
      for (const entry of readdirSync(join(ROOT, f))) if (/\.(js|css)$/.test(entry)) cpSync(join(ROOT, f, entry), join(dir, f, entry));
    }
    cpSync(join(ROOT, 'deps', 'steammanifest'), join(dir, 'deps', 'steammanifest'), { recursive: true });
    return dir;
  };
  const sabotage = (label, file, from, to, suite = wiring) => {
    const dir = copy(label.replace(/[^a-z0-9]+/gi, '-'));
    const p = join(dir, file);
    const text = readFileSync(p, 'utf8');
    if (!text.includes(from)) { fails.push(`cannot sabotage '${label}': ${JSON.stringify(from)} not in ${file}`); return; }
    writeFileSync(p, text.replace(from, to));
    const caught = suite(dir);
    if (!caught.length) fails.push(`the verifier did not notice '${label}'`);
    else console.log(`  caught ${label}: ${caught[0]}`);
  };
  try {
    for (const [name, suite] of [['wiring', wiring], ['integrity', integrity], ['deps', deps]]) {
      const problems = suite(copy(`clean-${name}`));
      if (problems.length) fails.push(`the clean copy fails ${name}: ${problems[0]}`);
    }
    sabotage('status channel removed from preload', 'preload.js', "steamManifestStatus: () => ipcRenderer.invoke('steammanifest:status'),", '');
    sabotage('log channel not relayed', 'src/js/app.js', "api.onSteamManifestLog?.((line) =>", 'api.onSteamManifestLog_?.((line) =>');
    sabotage('freshness check removed', 'main.js', 'const fresh = await local.refresh(appId, hub.filepath', 'const fresh = { stale: false, checked: false };  //(appId, hub.filepath');
    sabotage('no fallback when Hubcap fails', 'main.js', '    onLog(`⚠ Hubcap: ${hub.error} — asking Steam through steammanifest instead.`);\n    return local.downloadManifest(appId, { onLog });', '    return hub;');
    sabotage('replaced package left on disk', 'main.js', 'try { fs.unlinkSync(hub.filepath); }', 'try { /* unlinkSync */ }');
    sabotage('fetches coalesced per app again', 'main.js', "ipcMain.handle('hubcap:download', (_, appId) => fetchManifestPackage(appId));", "const manifestFetches = new Map();\nipcMain.handle('hubcap:download', (_, appId) => manifestFetches.get(appId) || fetchManifestPackage(appId));");
    sabotage('a failed source no longer reported', 'src/js/app.js', '    function noteSearchWarning(warning) {', '    function noteSearchWarning_(warning) {');
    sabotage('store gated on the Hubcap key again', 'src/js/app.js', '    if (!storeSourcesReady()) {\n      return { error: \'No manifest source is set up: add a Hubcap API key in Settings, or restore the steammanifest folder.\', results: [] };', "    if (!state.settings.secrets_present?.hubcap_api_key) {\n      return { error: 'A Hubcap API key is required to search the store. Add one in Settings.', results: [] };");
    sabotage('setting removed', 'src/core/settingsStore.js', "  manifest_source: 'auto',", "  manifest_source_: 'auto',");
    sabotage('enum removed', 'src/core/settingsStore.js', "  manifest_source: ['auto', 'hubcap', 'steammanifest'],", '');
    sabotage('picker removed from the markup', 'src/index.html', 'id="sel-manifest-source"', 'id="sel-manifest-source-x"');
    sabotage('keys no longer harvested', 'src/core/zipProcessor.js', "require('./depotKeys').remember(gameData.depots, options.userData)", "require('./depotKeys').remember_(gameData.depots, options.userData)");
    sabotage('smoke source unpinned', 'dev/electron-smoke.cjs', "manifest_source: 'hubcap',", '');
    sabotage('suite dropped from the runner', 'dev/run-regression.cjs', "'stale',", '');
    sabotage('module broken', 'src/core/steamManifest.js', "const fs = require('fs');", "const fs = require('fs');\nlet let;", integrity);
    sabotage('stylesheet unbalanced', 'src/styles/main.css', '.csrin-dir-row { display: flex;', '.csrin-dir-row { { display: flex;', integrity);
    sabotage('folder row style narrowed to one source', 'src/styles/main.css', '.csrin-dir-row > .font-mono {', '.csrin-dir-row #csrin-dir-label {', integrity);
    sabotage('vendored file changed without VERSION.txt', 'deps/steammanifest/re/cm_client.js', "'use strict';", "'use strict';\n// edited", deps);
    sabotage('VERSION.txt no longer records the client', 'deps/steammanifest/VERSION.txt', 're/cm_client.js sha256 ', 're/cm_client_.js sha256 ', deps);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  // The steam-user check needs a directory, not a text edit: prove it fires.
  const withSteamUser = mkdtempSync(join(tmpdir(), 'steammanifest-selftest-su-'));
  try {
    cpSync(join(ROOT, 'deps', 'steammanifest'), join(withSteamUser, 'deps', 'steammanifest'), { recursive: true });
    mkdirSync(join(withSteamUser, 'deps', 'steammanifest', 'node_modules', 'steam-user'), { recursive: true });
    const caught = deps(withSteamUser);
    if (!caught.some((f) => /steam-user/.test(f))) fails.push('the verifier did not notice the account-login package being shipped');
    else console.log('  caught account-login package shipped: ' + caught.find((f) => /steam-user/.test(f)));
  } finally {
    rmSync(withSteamUser, { recursive: true, force: true });
  }
  return fails;
}

// ── regressions ─────────────────────────────────────────────────
function regressions() {
  const fails = [];
  const runs = [
    ['reliability', process.execPath, ['dev/verify-reliability.cjs'], 300000],
    ['electron smoke', process.execPath, ['dev/run-electron-check.cjs', 'smoke'], 300000],
  ];
  for (const [label, cmd, args, timeout] of runs) {
    const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 });
    const tail = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-6).join('\n');
    if (r.status !== 0) fails.push(`${label} exited ${r.status}: ${tail}`);
    else console.log(`  ${label} passed: ${tail.split('\n').slice(-1)[0]}`);
  }
  return fails;
}

// ── live ────────────────────────────────────────────────────────
async function live() {
  const fails = [];
  const sm = core('steamManifest.js');
  const depotKeys = core('depotKeys.js');
  const userData = temp('steammanifest-live-');

  const res = await sm.downloadManifest(FIXTURE_APP, { userData, steamPath: '', keyFiles: [], onLog: (l) => console.log(`  ${l}`) });
  if (res.error) fails.push(`app ${FIXTURE_APP} was not packaged from Steam: ${res.error}`);
  else {
    const { readGameArchive } = core('zipProcessor.js');
    try {
      const archive = await readGameArchive(res.filepath, FIXTURE_APP);
      const ids = Object.keys(archive.gameData.depots);
      if (!ids.length) fails.push('the live package lists no depot');
      for (const id of ids) {
        if (!depotKeys.KEY_RE.test(archive.gameData.depots[id].key)) fails.push(`depot ${id} has no usable key`);
        const name = `${id}_${archive.gameData.manifests[id]}.manifest`;
        if (!archive.manifestFiles[name]) fails.push(`the package has no ${name}`);
      }
      // Every packaged key came either from the project's key file or from
      // Steam itself, and the ones Steam handed out are kept for later — that
      // is what lets a paid game be packaged after a Hubcap package taught
      // Librarian its keys.
      const stored = depotKeys.load(userData);
      const fromFile = depotKeys.fromFile(join(sm.resolveDir().dir, sm.KEY_FILE));
      for (const id of ids) {
        if (!stored[id] && !fromFile[id]) fails.push(`depot ${id} was packaged with a key from neither the key file nor the store`);
      }
      const fromCatalog = ids.filter((id) => !fromFile[id]);
      for (const id of fromCatalog) {
        if (stored[id] !== archive.gameData.depots[id].key) fails.push(`the catalog key for depot ${id} was not remembered`);
      }
      console.log(`  packaged ${res.name} (${ids.length} depot(s), build ${res.buildid}): ${res.note}`);
    } catch (err) { fails.push(`the live package does not read back: ${err.message}`); }
  }

  // A paid game with no key: refused, with the message that explains it. The
  // depot-key catalog is disabled here so this tests steammanifest's own
  // refusal in isolation — with the catalog on, it would (correctly) supply
  // this game's keys, which the keycatalog ledger covers instead.
  const paidUserData = temp('steammanifest-live-paid-');
  const paid = await sm.downloadManifest('2062430', { userData: paidUserData, steamPath: '', keyFiles: [], onLog: () => {}, resolveCatalogKeys: async () => ({}) });
  if (!paid.error) fails.push('a paid game with no key stored was packaged anyway');
  else if (!/no key/i.test(paid.error) || !/config\.vdf/.test(paid.error)) fails.push(`the live refusal reads "${paid.error}"`);
  else console.log(`  refused a paid game for want of a key (catalog disabled for this check): ${paid.error.slice(0, 120)}…`);
  return fails;
}

// ── pack ────────────────────────────────────────────────────────
/**
 * electron-builder runs under Electron's own Node, never the host's: the
 * packaging tools now load ES modules that Node 20 cannot require, which is
 * why dev/build-portable.cjs does the same. The `dir` target is enough here —
 * the question is what the payload carries, not whether a launcher is built.
 */
function pack() {
  const fails = [];
  const outDir = join(ROOT, 'dist', 'steammanifest-check');
  // Not require('electron'): this verifier seeds a fake one for its own tests.
  const electron = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!existsSync(electron)) return [`no Electron runtime at ${electron}`];
  // electron-builder's module collector runs npm through PowerShell, so the
  // check declares that directory itself rather than depending on the PATH it
  // happens to inherit: a verification PATH without it fails with a bare
  // "spawn powershell.exe ENOENT" long after the build has started.
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0');
  if (!existsSync(join(powershell, 'powershell.exe'))) return [`no PowerShell at ${powershell}; electron-builder cannot collect node modules`];
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = `${powershell};${process.env.PATH || ''}`;
  const r = spawnSync(electron, [fileURLToPath(import.meta.url), 'pack-child', outDir], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 900000, maxBuffer: 32 * 1024 * 1024, env,
  });
  process.stdout.write(`${r.stdout || ''}`.split('\n').slice(-4).join('\n') + '\n');
  if (r.status !== 0) return [`electron-builder exited ${r.status}: ${`${r.stdout || ''}${r.stderr || ''}`.trim().slice(-1500)}`];
  const unpacked = join(outDir, 'win-unpacked');
  const asar = join(unpacked, 'resources', 'app.asar');
  if (!existsSync(asar)) return ['no app.asar was produced'];
  const head = readFileSync(asar).subarray(0, 4 * 1024 * 1024).toString('latin1');
  for (const name of ['steamManifest.js', 'depotKeys.js', 'zipWriter.js']) {
    if (!head.includes(`"${name}"`)) fails.push(`the asar does not list ${name}`);
  }
  const packed = join(unpacked, 'resources', 'deps', 'steammanifest');
  for (const rel of ['VERSION.txt', 're/cm_client.js', 'fetch-manifest.js', 're/xyz_client.js', 'node_modules/protobufjs/package.json', 'node_modules/websocket13/package.json']) {
    if (!existsSync(join(packed, rel))) fails.push(`the packaged copy is missing ${rel}`);
  }
  if (existsSync(packed)) {
    // deps() expects <root>/deps/steammanifest, and resources/ is that root.
    const problems = deps(join(unpacked, 'resources'));
    for (const p of problems.filter((x) => !/does not load/.test(x))) fails.push(`the packaged copy: ${p}`);
  }
  return fails;
}

// ── dispatch ────────────────────────────────────────────────────
// The packaging child: electron-builder, in process, under Electron's Node.
if (process.argv[2] === 'pack-child') {
  process.noAsar = true;
  process.chdir(ROOT);
  const builder = requireFrom('electron-builder');
  const outDir = process.argv[3] || join(ROOT, 'dist', 'steammanifest-check');
  try {
    await builder.build({
      targets: builder.Platform.WINDOWS.createTarget('dir', builder.Arch.x64),
      config: { directories: { output: outDir } },
      publish: 'never',
    });
    console.log(`built into ${outDir}`);
    process.exit(0);
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(1);
  }
}

const SUITES = {
  deps: () => deps(), zip, lua, keys, fetch: fetchSuite, stale, endpoint, search,
  wiring: () => wiring(), integrity: () => integrity(), 'self-test': selfTest,
  regressions, live, pack,
};
const OFFLINE = ['deps', 'zip', 'lua', 'keys', 'fetch', 'stale', 'endpoint', 'search', 'wiring', 'integrity', 'self-test'];
const name = process.argv[2] || 'all';
const run = name === 'all' ? OFFLINE : [name];
let failed = false;
for (const suite of run) {
  if (!SUITES[suite]) { console.error(`unknown suite: ${suite}`); process.exit(2); }
  let problems;
  try { problems = await SUITES[suite](); }
  catch (err) { problems = [`the suite threw: ${err.stack || err.message}`]; }
  for (const f of problems) console.error(`FAIL ${suite}: ${f}`);
  if (problems.length) failed = true;
  else console.log(`OK ${suite}`);
}
await sleep(50);
process.exit(failed ? 1 : 0);
