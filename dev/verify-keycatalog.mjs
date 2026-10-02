#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Verifier for the depot-key / app-token catalogs (src/core/steamCatalog.js)
// and the request-code mirror path (src/core/steamManifest.js).
//
//   node dev/verify-keycatalog.mjs <suite>
//
//   catalog     the catalog module: download-and-cache, time-to-live refresh,
//               keep-on-failure, and untrusted-body validation
//   keyorder    XYZ catalog first for generated/imported Lua, then local and
//               Steam fallbacks for missing/invalid keys or catalog failures
//   reqcode     the mirror issues a request code (never bytes) and the manifest
//               is fetched from the Steam CDN with it and validated
//   paid        a fully gated paid app — no metadata, no key, no code from an
//               anonymous session — packaged from the token + key + code paths
//   wiring      settings, preload, main, markup and the renderer agree
//   self-test   each defect the verifier checks for is caught
//   regressions the steammanifest ledger, the reliability suite and the smoke
//   live        the real catalog and mirror against the Steam CDN (not in `all`)
//   all         every offline suite above
//
// Prints `OK <suite>` and exits 0 only after every assertion in it passed.
// No game, injector or real download runs except in `live` and `regressions`.
// ═══════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p, root = ROOT) => readFileSync(join(root, p), 'utf8');
const requireFrom = createRequire(join(ROOT, 'package.json'));
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);
const FIXTURE_DIR = join(ROOT, 'dev', 'fixtures', 'steammanifest');

let fakeUserData = mkdtempSync(join(tmpdir(), 'keycatalog-ud-'));
function installFakeElectron() {
  const id = requireFrom.resolve('electron');
  requireFrom.cache[id] = {
    id, filename: id, loaded: true, children: [], paths: [],
    exports: {
      app: { getPath: () => fakeUserData, isPackaged: false },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (v) => Buffer.from(`c:${Buffer.from(String(v)).toString('base64')}`),
        decryptString: (v) => Buffer.from(String(v).replace(/^c:/, ''), 'base64').toString(),
      },
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
const temp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); cleanups.push(() => { try { rmSync(d, { recursive: true, force: true }); } catch {} }); return d; };
process.on('exit', () => { for (const fn of cleanups) fn(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Synthetic manifests, built with the vendored decoder's own definitions ──
const MAGIC = { PAYLOAD: 0x71f617d0, METADATA: 0x1f4812be, SIGNATURE: 0x1b81b817, END: 0x32c415ab };
let messages = null;
function manifestMessages(dir) {
  if (messages) return messages;
  const req = createRequire(join(dir, 'package.json'));
  const protobuf = req('protobufjs');
  const src = /const MANIFEST_PROTO = `([\s\S]*?)`;/.exec(readFileSync(join(dir, 're', 'manifest_format.js'), 'utf8'))[1];
  const root = protobuf.parse(src, { keepCase: true }).root.resolveAll();
  messages = { payload: root.lookupType('ContentManifestPayload'), metadata: root.lookupType('ContentManifestMetadata'), signature: root.lookupType('ContentManifestSignature') };
  return messages;
}
function section(magic, body) { const h = Buffer.alloc(8); h.writeUInt32LE(magic, 0); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body]); }
function makeManifest(dir, depotId, manifestId) {
  const { payload, metadata, signature } = manifestMessages(dir);
  const sha = createHash('sha1').update(`${depotId}/${manifestId}`).digest();
  const body = payload.encode(payload.create({ mappings: [{ filename: 'game.bin', size: 2048, flags: 0, sha_filename: sha, sha_content: sha, chunks: [{ sha, crc: 0x2233, offset: 0, cb_original: 2048, cb_compressed: 2048 }] }] })).finish();
  const meta = metadata.encode(metadata.create({ depot_id: Number(depotId), gid_manifest: String(manifestId), creation_time: 1700000000, filenames_encrypted: false, cb_disk_original: 2048, cb_disk_compressed: 2048, unique_chunks: 1, crc_encrypted: 0, crc_clear: 0 })).finish();
  const sig = signature.encode(signature.create({ signature: Buffer.alloc(0) })).finish();
  const end = Buffer.alloc(4); end.writeUInt32LE(MAGIC.END, 0);
  return Buffer.concat([section(MAGIC.PAYLOAD, Buffer.from(body)), section(MAGIC.METADATA, Buffer.from(meta)), section(MAGIC.SIGNATURE, Buffer.from(sig)), end]);
}
function asCdnZip(bytes) { return core('zipWriter.js').buildZip([{ name: 'manifest', data: bytes }]); }

// ── Mock Steam CM ───────────────────────────────────────────────
function mockClient({ apps, cdnHost, keys = {}, denyKey = new Set(), denyCode = new Set(), tokenGated = {} }) {
  const calls = { productInfo: [], codes: [], keys: [], tokensSeen: [] };
  return {
    calls,
    async connect() {},
    logOff() {},
    async getProductInfo(req) {
      const out = {};
      for (const entry of req) {
        const id = String(typeof entry === 'object' ? entry.appid : entry);
        const token = typeof entry === 'object' ? String(entry.access_token || '') : '';
        calls.productInfo.push(id);
        if (token) calls.tokensSeen.push(`${id}:${token}`);
        // A gated app returns appinfo only when the right token is supplied.
        if (tokenGated[id] && token !== tokenGated[id]) continue;
        if (apps[id]) out[id] = { appinfo: apps[id] };
      }
      return { apps: out, packages: {}, unknownApps: [], unknownPackages: [] };
    },
    async getContentServers() { return { servers: [{ Host: cdnHost, host: cdnHost, https_support: 'disabled', weightedload: 1 }] }; },
    async getManifestRequestCode(appid, depotId, manifestId) {
      calls.codes.push(`${appid}/${depotId}/${manifestId}`);
      if (denyCode.has(String(depotId))) throw Object.assign(new Error('AccessDenied (15)'), { eresult: 15 });
      return { requestCode: '12312312312312312312' };
    },
    async getDepotDecryptionKey(appid, depotId) {
      calls.keys.push(`${appid}/${depotId}`);
      if (denyKey.has(String(depotId)) || !keys[String(depotId)]) throw Object.assign(new Error('AccessDenied (15)'), { eresult: 15 });
      return { key: Buffer.from(keys[String(depotId)], 'hex') };
    },
  };
}
function appinfo({ name, type = 'Game', depots = {}, buildid = '900' }) {
  const rec = { common: { name, type }, extended: {}, depots: { branches: { public: { buildid } } } };
  for (const [id, d] of Object.entries(depots)) rec.depots[id] = { manifests: d.gid ? { public: { gid: d.gid, size: String(d.size ?? 2048), download: String(d.download ?? 1024) } } : undefined, config: d.oslist ? { oslist: d.oslist } : undefined };
  return rec;
}
async function startCdn(bodies) {
  const hits = [];
  const server = createServer((req, res) => {
    const m = /^\/depot\/(\d+)\/manifest\/(\d+)\/5\/(\d+)/.exec(req.url || '');
    if (!m) { res.writeHead(400); res.end('bad'); return; }
    hits.push({ depot: m[1], manifest: m[2], code: m[3] });
    const body = bodies[`${m[1]}_${m[2]}`];
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Length': body.length }); res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => server.close());
  return { host: `127.0.0.1:${server.address().port}`, hits };
}
/** A request-code mirror: /manifest/<depot>/<manifest> -> a bare uint64. */
async function startMirror(codes, { garbage = false } = {}) {
  const hits = [];
  const server = createServer((req, res) => {
    const m = /^\/manifest\/(\d+)\/(\d+)/.exec(req.url || '');
    if (!m) { res.writeHead(400); res.end('Invalid Depot ID'); return; }
    hits.push(`${m[1]}_${m[2]}`);
    if (garbage) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('<html>not a code</html>'); return; }
    const code = codes[`${m[1]}_${m[2]}`];
    if (!code) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('Unauthorized'); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(String(code));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => server.close());
  return { endpoint: `http://127.0.0.1:${server.address().port}`, hits };
}
/** A JSON catalog document server, so a real download+cache is exercised. */
async function startCatalog(doc) {
  let served = 0;
  const body = Buffer.from(JSON.stringify(doc));
  const server = createServer((req, res) => { served++; res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length, ETag: '"x"' }); res.end(body); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/depotkeys.json`, get served() { return served; } };
}

// ── catalog ─────────────────────────────────────────────────────
async function catalog() {
  const fails = [];
  const cat = core('steamCatalog.js');

  // Download and cache, look up only the ids asked for.
  const server = await startCatalog({ '1004': KEY_A, '1005': KEY_B, notanid: KEY_A, '1006': 'zz', '1007': ['array'], '1008': KEY_C.toUpperCase() });
  const ud = temp('keycatalog-a-');
  cat._reset();
  const got = await cat.lookupDepotKeys(['1004', '1006', '1008', '9999'], { url: server.url, userData: ud });
  if (got['1004'] !== KEY_A) fails.push(`did not return the key for 1004: ${JSON.stringify(got)}`);
  if (got['1008'] !== KEY_C) fails.push('an uppercase key was not normalised');
  if ('1006' in got) fails.push('a non-hex value was taken as a key');
  if ('9999' in got) fails.push('an unrequested/absent id appeared');
  if (Object.keys(got).length !== 2) fails.push(`returned ${Object.keys(got).length} keys, expected 2 (1004, 1008)`);
  if (server.served !== 1) fails.push(`downloaded ${server.served} times for the first lookup`);

  // A second lookup inside the TTL does not re-download.
  await cat.lookupDepotKeys(['1005'], { url: server.url, userData: ud });
  if (server.served !== 1) fails.push(`re-downloaded within the TTL (served ${server.served})`);
  // A zero TTL forces a refresh.
  await cat.lookupDepotKeys(['1005'], { url: server.url, userData: ud, maxAgeMs: 0 });
  if (server.served !== 2) fails.push(`a zero TTL did not refresh (served ${server.served})`);

  // Unreachable source keeps the cache rather than losing it.
  cat._reset();
  const dead = 'http://127.0.0.1:1/depotkeys.json';
  const afterDead = await cat.lookupDepotKeys(['1004'], { url: server.url, userData: ud, maxAgeMs: 0, fetchImpl: async () => { throw new Error('offline'); } });
  if (afterDead['1004'] !== KEY_A) fails.push('an unreachable refresh lost the cached keys');

  // No cache and unreachable: empty, not thrown.
  const ud2 = temp('keycatalog-dead-');
  const none = await cat.lookupDepotKeys(['1004'], { url: dead, userData: ud2, fetchImpl: async () => { throw new Error('offline'); } });
  if (Object.keys(none).length) fails.push('an unreachable first fetch returned keys');

  // A hostile oversized body is refused by the byte cap (declared length).
  const ud3 = temp('keycatalog-big-');
  const bigFetch = async () => ({ status: 200, ok: true, headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(cat.KINDS.depotKeys.maxBytes + 1) : null) }, body: null });
  const big = await cat.lookupDepotKeys(['1004'], { url: 'http://cap.test/x.json', userData: ud3, fetchImpl: bigFetch });
  if (Object.keys(big).length) fails.push('an oversized catalog was accepted');

  // App tokens: uint64 kept, "0" and non-numeric dropped.
  const tokenServer = await startCatalog({ '600': '12345678901234567890', '601': '0', '602': 'abc', '603': 42 });
  const ud4 = temp('keycatalog-tok-');
  cat._reset();
  const toks = await cat.lookupAppTokens(['600', '601', '602', '603'], { url: tokenServer.url, userData: ud4 });
  if (toks['600'] !== '12345678901234567890') fails.push(`a valid token was dropped: ${JSON.stringify(toks)}`);
  if ('601' in toks) fails.push('the sentinel "0" token was kept');
  if ('602' in toks) fails.push('a non-numeric token was kept');
  if (toks['603'] !== '42') fails.push('a numeric token value was not coerced');

  // Disabled when the URL is empty.
  const off = await cat.lookupDepotKeys(['1004'], { url: '', userData: ud });
  if (Object.keys(off).length) fails.push('the catalog answered with no URL set');
  const st = cat.status({ url: '', userData: ud });
  if (st.depotKeys.enabled) fails.push('status reports an empty-URL catalog as enabled');
  const concurrentServer = await startCatalog({ '1004': KEY_A });
  const concurrentData = temp('keycatalog-concurrent-');
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => cat.lookupDepotKeys(['1004'], { url: concurrentServer.url, userData: concurrentData })));
  if (concurrentServer.served !== 1 || concurrent.some((m) => m['1004'] !== KEY_A)) fails.push(`concurrent readers did not share one successful download (${concurrentServer.served} requests)`);
  const changedSource = await cat.lookupDepotKeys(['1004'], { url: dead, userData: ud, fetchImpl: async () => { throw new Error('offline'); } });
  if (Object.keys(changedSource).length) fails.push('switching catalog URLs reused data from the old source');
  writeFileSync(join(ud, cat.KINDS.depotKeys.file), '{broken');
  cat._reset();
  const repaired = await cat.lookupDepotKeys(['1004'], { url: server.url, userData: ud });
  if (repaired['1004'] !== KEY_A) fails.push('a corrupt cache stayed unusable until its TTL expired');
  rmSync(join(ud, cat.KINDS.depotKeys.file));
  let sentEtag = false;
  const recovered = await cat.lookupDepotKeys(['1004'], { url: server.url, userData: ud, fetchImpl: async (url, opts) => {
    sentEtag = Boolean(opts.headers['If-None-Match']);
    if (sentEtag) return { status: 304 };
    return requireFrom('node-fetch')(url, opts);
  } });
  if (sentEtag || recovered['1004'] !== KEY_A) fails.push('a missing cache sent an ETag and could not recover from 304');
  const slowServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{');
    const timer = setTimeout(() => res.end('}'), 650);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => slowServer.close());
  const slowData = temp('keycatalog-slow-');
  const started = Date.now();
  const slow = await cat.ensureFresh('depotKeys', { url: `http://127.0.0.1:${slowServer.address().port}/slow`, userData: slowData, timeoutMs: 80 });
  if (slow.available || Date.now() - started > 500) fails.push('catalog timeout did not cover the response body');
  if (readdirSync(slowData).some((f) => f.endsWith('.tmp'))) fails.push('an aborted catalog left a temporary file');
  const invalidTokenServer = await startCatalog({ '700': '18446744073709551616', '701': '000', '702': 9007199254740992, '703': '18446744073709551615' });
  const validTokens = await cat.lookupAppTokens(['700', '701', '702', '703'], { url: invalidTokenServer.url, userData: temp('keycatalog-uint64-') });
  if (Object.keys(validTokens).join(',') !== '703') fails.push('out-of-range, zero or lossy numeric app tokens were accepted');
  return fails;
}

// ── keyorder ────────────────────────────────────────────────────
async function keyorder() {
  const fails = [];
  const sm = core('steamManifest.js');
  const dir = sm.resolveDir().dir;
  const mods = sm.load(dir);
  const man = { d1: makeManifest(dir, '11', '111'), d2: makeManifest(dir, '12', '222'), d3: makeManifest(dir, '13', '333'), d4: makeManifest(dir, '14', '444') };
  const cdn = await startCdn({ '11_111': asCdnZip(man.d1), '12_222': asCdnZip(man.d2), '13_333': asCdnZip(man.d3), '14_444': asCdnZip(man.d4) });
  const apps = { '500': appinfo({ name: 'Mixed', depots: { 11: { gid: '111' }, 12: { gid: '222' }, 13: { gid: '333' }, 14: { gid: '444' } } }) };
  const relay = await startMirror({ '11_111': '12345678901234567890', '12_222': '12345678901234567890', '13_333': '12345678901234567890' });
  // A Steam key method exists on this fixture but must never be called.
  const client = mockClient({ apps, cdnHost: cdn.host, keys: { 12: KEY_B }, denyKey: new Set(['13', '14']) });

  const catalogAsked = [], events = [];
  const getSteamKey = client.getDepotDecryptionKey.bind(client);
  client.getDepotDecryptionKey = async (...args) => { events.push('steam'); return getSteamKey(...args); };
  const resolveCatalogKeys = async (ids) => {
    events.push('catalog'); catalogAsked.push(...ids);
    return { 11: KEY_C.toUpperCase(), 12: 'invalid', 13: KEY_C, 99: KEY_A };
  };

  const result = await sm.assemble(mods, client, {
    appid: '500',
    keys: { 11: KEY_A, 12: KEY_B },
    mirrorFallbacks: [], mirror: relay.endpoint,
    userData: temp('keyorder-'),
    resolveCatalogKeys,
  });

  const packaged = result.packaged.map((d) => d.id).sort();
  if (packaged.join(',') !== '11,12,13') fails.push(`packaged ${packaged.join(',')}, expected 11,12,13`);
  const byId = Object.fromEntries(result.packaged.map((d) => [d.id, d.key]));
  if (byId['11'] !== KEY_C) fails.push('depot 11 did not prefer XYZ over its locally-known key');
  if (byId['12'] !== KEY_B) fails.push('depot 12 did not use its saved fallback key');
  if (byId['13'] !== KEY_C) fails.push('depot 13 was not filled from the catalog');
  if (catalogAsked.join(',') !== '11,12,13,14') fails.push(`catalog was not asked once for every depot: ${catalogAsked.join(',')}`);
  if (events[0] !== 'catalog' || events.filter(e => e === 'catalog').length !== 1) fails.push(`wrong key lookup order: ${events.join(',')}`);
  if (client.calls.keys.length || client.calls.codes.length) fails.push('a direct Steam key or request-code attempt was made');
  if (result.keys['99']) fails.push('an unrequested catalog key was retained');
  // Steam is never asked for a key it will not give twice; depot 14 stays out.
  const out14 = result.leftOut.find((d) => d.id === '14');
  if (!out14 || out14.reason !== sm.NO_KEY) fails.push('depot 14 (no key anywhere) was not left out for want of a key');

  // With the catalog disabled, the paid depots both drop out.
  const client2 = mockClient({ apps, cdnHost: cdn.host, keys: { 12: KEY_B }, denyKey: new Set(['13', '14']) });
  const noCat = await sm.assemble(mods, client2, { appid: '500', keys: { 11: KEY_A, 12: KEY_B }, mirrorFallbacks: [], mirror: relay.endpoint, userData: temp('keyorder2-'), resolveCatalogKeys: null });
  if (noCat.packaged.map((d) => d.id).sort().join(',') !== '11,12') fails.push('a disabled catalog still filled a paid depot');

  const keyStore = core('depotKeys.js');
  for (const resolver of [async () => { throw new Error('offline'); }, () => { throw new Error('sync failure'); }, async () => ({ 11: 'broken' })]) {
    const selection = await keyStore.preferCatalog(['11'], { 11: KEY_A }, { resolveCatalogKeys: resolver });
    if (selection.keys['11'] !== KEY_A) fails.push('catalog failure or invalid key lost the fallback');
  }

  // The generated Lua carries the selected XYZ key through the actual reader.
  const processor = core('zipProcessor.js');
  const file = await sm.writePackage('500', result, temp('keyorder-zip-'));
  const built = await processor.readGameArchive(file, '500');
  if (built.gameData.depots['11'].key !== KEY_C) fails.push('generated Lua did not contain the XYZ key');
  // Importing an older Lua must apply the same priority, while retaining
  // archive identity, metadata and the other depot's fallback key.
  const api = core('steamApi.js');
  const originalInfo = api.getDepotInfoFromApi;
  api.getDepotInfoFromApi = async () => ({});
  try {
    for (const [resolver, expected] of [[async () => ({ 11: KEY_B, 12: 'invalid' }), KEY_B], [async () => { throw new Error('offline'); }, KEY_C], [false, KEY_C]]) {
      const ud = temp('keyorder-import-');
      const imported = await processor.processZip(file, '500', { userData: ud, resolveCatalogKeys: resolver });
      try {
        if (imported.depots['11'].key !== expected || imported.depots['12'].key !== KEY_B) fails.push('imported Lua did not honor catalog priority with per-depot fallback');
        if (imported.appid !== '500' || imported.manifests['11'] !== '111') fails.push('key priority changed archive identity or manifest selection');
        if (keyStore.load(ud)['11'] !== expected) fails.push('the selected import key was not remembered');
      } finally { processor.cleanupManifestDir(imported.manifest_dir); }
    }
  } finally { api.getDepotInfoFromApi = originalInfo; }
  return fails;
}

// ── reqcode ─────────────────────────────────────────────────────
async function reqcode() {
  const fails = [];
  const sm = core('steamManifest.js');
  const dir = sm.resolveDir().dir;
  const mods = sm.load(dir);
  const manifest = makeManifest(dir, '20', '200');
  const cdn = await startCdn({ '20_200': asCdnZip(manifest) });

  // requestCodeFromMirror returns the bare code.
  const good = await startMirror({ '20_200': '12345678901234567890' });
  const code = await sm.requestCodeFromMirror(mods, good.endpoint, '500', '20', '200');
  if (code !== '12345678901234567890') fails.push(`requestCodeFromMirror returned ${JSON.stringify(code)}`);
  // A non-numeric body is refused, not treated as a code.
  const junk = await startMirror({}, { garbage: true });
  let refused = '';
  try { await sm.requestCodeFromMirror(mods, junk.endpoint, '500', '20', '200'); } catch (e) { refused = e.message; }
  if (!/not a request code/.test(refused)) fails.push(`a non-code mirror body was not refused: "${refused}"`);

  // cdnFetchWithCode downloads and returns manifest bytes.
  const client = mockClient({ apps: {}, cdnHost: cdn.host });
  const fetched = await sm.cdnFetchWithCode(mods, client, '500', '20', '200', code);
  if (!fetched.data || !fetched.data.length) fails.push('cdnFetchWithCode returned no data');
  if (cdn.hits[cdn.hits.length - 1].code !== code) fails.push('the CDN was not called with the mirror code');

  // acquireManifest: Steam refuses the code, the mirror supplies one, the CDN serves the bytes.
  const denyClient = mockClient({ apps: {}, cdnHost: cdn.host, denyCode: new Set(['20']) });
  const got = await sm.acquireManifest(mods, denyClient, { id: '20', manifestId: '200', app: '500', shared: false }, { appid: '500', prior: null, mirrorFallbacks: [], mirror: good.endpoint });
  if (got.source !== 'mirror') fails.push(`acquireManifest source was ${got.source}, expected mirror`);
  const parsed = mods.manifest.parseManifest(got.data);
  if (String(parsed.depot_id) !== '20' || String(parsed.gid_manifest) !== '200') fails.push('the mirror-code manifest did not validate to the requested ids');

  // A mirror code that yields the wrong depot's manifest is rejected.
  const wrongCdn = await startCdn({ '21_201': asCdnZip(makeManifest(dir, '99', '1')) });
  const wrongClient = mockClient({ apps: {}, cdnHost: wrongCdn.host, denyCode: new Set(['21']) });
  const wrongMirror = await startMirror({ '21_201': '17000000000000000000' });
  let wrongErr = '';
  try { await sm.acquireManifest(mods, wrongClient, { id: '21', manifestId: '201', app: '500', shared: false }, { appid: '500', prior: null, mirrorFallbacks: [], mirror: wrongMirror.endpoint }); } catch (e) { wrongErr = e.message; }
  if (!wrongErr) fails.push('a manifest for the wrong depot from the mirror code was accepted');
  const expectedOrder = 'https://20770407.xyz/enone,https://20770407.xyz';
  for (const input of ['', 'https://20770407.xyz', 'https://20770407.xyz/enone/manifest/x/x']) {
    if (sm.mirrorEndpoints(input).join(',') !== expectedOrder) fails.push(`incorrect primary/backup order for ${input}`);
  }
  let mode = 'success';
  let calls = [];
  const ordered = createServer((req, res) => {
    const primary = req.url.startsWith('/enone/manifest/');
    calls.push(primary ? 'primary' : 'backup');
    if (!/^\/(enone\/)?manifest\/20\/200\?appid=500$/.test(req.url)) { res.writeHead(400); res.end('bad route'); return; }
    if (primary && mode === 'network') { req.socket.destroy(); return; }
    if (primary && mode === 'http') { res.writeHead(503); res.end('unavailable'); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(primary && mode === 'garbage' ? '<html>error</html>' : primary && mode === 'cdn' ? '1' : '12345678901234567890');
  });
  await new Promise(resolve => ordered.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => ordered.close());
  const base = `http://127.0.0.1:${ordered.address().port}`;
  const checkedMods = { ...mods, http: { ...mods.http, httpGet: async (url, options) =>
    String(url).endsWith('/1') ? { status: 403 } : mods.http.httpGet(url, options) } };
  for (mode of ['success', 'http', 'network', 'garbage', 'cdn']) {
    calls = [];
    const result = await sm.acquireManifest(checkedMods, denyClient, { id: '20', manifestId: '200', app: '500', shared: false }, {
      appid: '500', mirror: `${base}/enone/manifest/x/x`, mirrorFallbacks: [base], proxies: [],
    });
    if (!result.data.equals(manifest)) fails.push(`${mode}: no valid manifest from the API chain`);
    if (calls[0] !== 'primary') fails.push(`${mode}: backup used before primary`);
    if (mode === 'success' && calls.join(',') !== 'primary') fails.push('backup contacted after primary succeeded');
    if (mode !== 'success' && calls[calls.length - 1] !== 'backup') fails.push(`${mode}: backup was not used`);
  }
  return fails;
}

// ── proxy ───────────────────────────────────────────────────────
async function proxySuite() {
  const fails = [];
  const sm = core('steamManifest.js');
  const dir = sm.resolveDir().dir;
  const mods = sm.load(dir);

  // The pool setting is parsed to valid http(s) proxy URLs; junk and SOCKS drop.
  const pool = sm.mirrorProxies('http://a.example:8080, https://user:pass@b.example:3128 socks5://c.example:1080\nnot-a-url');
  if (pool.join(',') !== 'http://a.example:8080,https://user:pass@b.example:3128') fails.push(`mirrorProxies parsed ${JSON.stringify(pool)}`);
  if (sm.mirrorProxies('').length) fails.push('an empty proxy setting produced proxies');
  // A usable agent is built for an http(s) proxy, none for SOCKS or junk.
  if (!sm.proxyAgent('http://a.example:8080')) fails.push('no agent for a valid http proxy');
  if (sm.proxyAgent('socks5://c.example:1080')) fails.push('an agent was built for an unsupported SOCKS proxy');
  if (sm.proxyAgent('not-a-url')) fails.push('an agent was built for a malformed proxy URL');

  // Insisting through the pool: direct is rate-limited (401); the request
  // succeeds only once a proxy is tried. The stub reads the agent to tell
  // which "IP" the call came from.
  const seen = [];
  const stubFetch = async (url, opts) => {
    const viaProxy = Boolean(opts.agent);
    seen.push(viaProxy ? 'proxy' : 'direct');
    if (!viaProxy) return { status: 401, ok: false, text: async () => 'Unauthorized' };
    return { status: 200, ok: true, text: async () => '12345678901234567890' };
  };
  const code = await sm.requestCodeFromMirror(mods, 'https://mirror.test', '500', '20', '200', {
    proxies: ['http://p1.example:8080'], fetchImpl: stubFetch, backoffMs: 1,
  });
  if (code !== '12345678901234567890') fails.push(`the pool did not obtain a code: ${JSON.stringify(code)}`);
  if (!seen.includes('direct') || !seen.includes('proxy')) fails.push(`the pool did not try direct then proxy: ${seen.join(',')}`);

  // Insisting over rounds: everything 401s, so it retries direct+proxy across
  // two rounds (four attempts) before giving up.
  const attempts = [];
  const allDenied = async (url, opts) => { attempts.push(opts.agent ? 'proxy' : 'direct'); return { status: 401, ok: false, text: async () => 'Unauthorized' }; };
  let deniedErr = '';
  try {
    await sm.requestCodeFromMirror(mods, 'https://mirror.test', '500', '20', '200', { proxies: ['http://p1.example:8080'], fetchImpl: allDenied, rounds: 2, backoffMs: 1 });
  } catch (e) { deniedErr = e.message; }
  if (!deniedErr) fails.push('an all-401 pool did not fail');
  if (attempts.length !== 4) fails.push(`insisted ${attempts.length} times, expected 4 (direct+proxy over 2 rounds)`);
  if (!/HTTP 401/.test(deniedErr)) fails.push(`the failure did not report the 401s: ${deniedErr}`);

  // A 200 that is not a code is a hard refusal — no insisting.
  const garbage = [];
  const garbageFetch = async (url, opts) => { garbage.push(opts.agent ? 'proxy' : 'direct'); return { status: 200, ok: true, text: async () => '<html>blocked</html>' }; };
  let hard = '';
  try { await sm.requestCodeFromMirror(mods, 'https://mirror.test', '500', '20', '200', { proxies: ['http://p1.example:8080'], fetchImpl: garbageFetch, rounds: 3, backoffMs: 1 }); } catch (e) { hard = e.message; }
  if (!/not a request code/.test(hard)) fails.push(`a non-code 200 was not a hard refusal: ${hard}`);
  if (garbage.length !== 1) fails.push(`a non-code 200 was retried ${garbage.length} times instead of failing at once`);

  // resolveMirrorPool precedence: explicit array verbatim; pinned setting; then
  // auto-source only on a real run, never with an injected client.
  const explicit = await sm.resolveMirrorPool({ proxies: ['http://z.example:9'], autoSource: true });
  if (explicit.join(',') !== 'http://z.example:9') fails.push('an explicit proxy array was not used verbatim');
  const offNoAuto = await sm.resolveMirrorPool({ autoSource: false });
  if (offNoAuto.length) fails.push('a non-real run auto-sourced proxies');

  // The provider: proxifly JSON is ranked (https first, score desc), a window
  // probed, and only responders returned, fastest first.
  const provider = requireFrom(join(ROOT, 'src', 'core', 'manifestProxies.js'));
  const parsedJson = provider.parseList(JSON.stringify([
    { proxy: 'http://slow.example:1', protocol: 'http', https: false, score: 9 },
    { proxy: 'http://fast.example:2', protocol: 'http', https: true, score: 1 },
    { proxy: 'socks5://nope.example:3', protocol: 'socks5', score: 99 },
  ]));
  if (parsedJson[0] !== 'http://fast.example:2') fails.push(`proxifly ranking put ${parsedJson[0]} first; https-capable should lead`);
  if (parsedJson.includes('socks5://nope.example:3')) fails.push('a SOCKS proxy survived parsing');
  if (provider.parseList('http://a.example:8080\nhttp://b.example:8080\n').length !== 2) fails.push('a plain-text proxy list was not parsed');

  provider._reset();
  const health = 'https://health.test/generate_204';
  const listUrl = 'https://list.test/proxies.json';
  const catalogDoc = JSON.stringify([
    { proxy: 'http://good1.example:8080', protocol: 'http', https: true, score: 5 },
    { proxy: 'http://dead.example:8080', protocol: 'http', https: true, score: 4 },
    { proxy: 'http://good2.example:8080', protocol: 'http', https: true, score: 3 },
  ]);
  const provFetch = async (url, opts) => {
    if (url === listUrl) return { ok: true, status: 200, headers: { get: () => null }, text: async () => catalogDoc };
    if (url === health) {
      const p = opts.agent; // stubbed agentFactory returns the proxy string
      if (p === 'http://dead.example:8080') throw new Error('ECONNREFUSED');
      await new Promise((r) => setTimeout(r, p === 'http://good1.example:8080' ? 5 : 25));
      return { status: 204 };
    }
    throw new Error(`unexpected url ${url}`);
  };
  const probed = await provider.resolvePool({
    source: listUrl, userData: temp('proxysrc-'), fetchImpl: provFetch,
    agentFactory: (p) => p, healthUrl: health, probeTimeoutMs: 500, limit: 5, force: true,
  });
  if (probed.includes("http://dead.example:8080")) fails.push("a proxy that failed the probe was kept");
  if (probed[0] !== "http://good1.example:8080") fails.push(`the fastest proxy did not lead: ${JSON.stringify(probed)}`);
  if (probed.length !== 2) fails.push(`kept ${probed.length} proxies, expected the 2 that responded`);

  provider._reset();
  const off = await provider.resolvePool({ source: '', userData: temp('proxysrc2-') });
  if (off.length) fails.push('an empty proxy source produced proxies');
  return fails;
}

// ── paid ────────────────────────────────────────────────────────
async function paid() {
  const fails = [];
  const sm = core('steamManifest.js');
  const dir = sm.resolveDir().dir;
  const manifest = makeManifest(dir, '601', '6010');
  const cdn = await startCdn({ '601_6010': asCdnZip(manifest) });
  const mirror = await startMirror({ '601_6010': '12312312312312312312' });
  const apps = { '600': appinfo({ name: 'Fully Gated Paid Game', depots: { 601: { gid: '6010' } } }) };
  const client = mockClient({ apps, cdnHost: cdn.host, keys: {}, denyKey: new Set(['601']), denyCode: new Set(['601']) });
  const ud = temp('paid-');

  const res = await sm.downloadManifest('600', {
    client, userData: ud, steamPath: '', keyFiles: [], mirrorFallbacks: [], mirror: mirror.endpoint,
    resolveTokens: async () => { throw new Error('Session token lookup must not run'); },
    resolveCatalogKeys: async (ids) => (ids.includes('601') ? { '601': KEY_C } : {}),
    onLog: () => {},
  });
  if (res.error) { fails.push(`the gated paid app was not packaged: ${res.error}`); return fails; }
  if (client.calls.tokensSeen.length || client.calls.keys.length || client.calls.codes.length) fails.push('a direct Steam token, key or request-code attempt occurred');
  const { readGameArchive } = core('zipProcessor.js');
  const archive = await readGameArchive(res.filepath, '600');
  if (archive.gameData.depots['601']?.key !== KEY_C) fails.push('the catalog depot key is not in the package');
  if (!archive.manifestFiles['601_6010.manifest']?.equals(manifest)) fails.push('the packaged manifest is not the one the CDN served via the mirror code');
  if (!mirror.hits.includes('601_6010')) fails.push('the mirror was never asked for a request code');
  if (res.counts?.mirror !== 1) fails.push(`counts ${JSON.stringify(res.counts)}, expected one via the mirror`);

  // An endpoint that has no metadata must fail without a direct Steam fallback.
  const client2 = mockClient({ apps: {}, cdnHost: cdn.host, keys: {}, denyKey: new Set(['601']), denyCode: new Set(['601']) });
  const denied = await sm.downloadManifest('600', { client: client2, userData: temp('paid2-'), steamPath: '', keyFiles: [], mirrorFallbacks: [], mirror: mirror.endpoint, resolveTokens: async () => ({}), resolveCatalogKeys: async () => ({}), onLog: () => {} });
  if (!/metadata/.test(denied.error || '')) fails.push('missing endpoint metadata did not produce a clear error');
  if (client2.calls.keys.length || client2.calls.codes.length) fails.push('metadata failure fell back to direct Steam');
  return fails;
}

// ── wiring ──────────────────────────────────────────────────────
function wiring(root = ROOT) {
  const fails = [];
  const settings = read('src/core/settingsStore.js', root);
  const preload = read('preload.js', root);
  const main = read('main.js', root);
  const html = read('src/index.html', root);
  const app = read('src/js/app.js', root);
  const sm = read('src/core/steamManifest.js', root);

  const defaults = settings.slice(settings.indexOf('const DEFAULTS = {'), settings.indexOf('const ENUMS = {'));
  for (const key of ['depot_key_catalog', 'app_token_catalog', 'manifest_mirror_proxies', 'manifest_proxy_source']) {
    if (!new RegExp(`^\\s*${key}: '`, 'm').test(defaults)) fails.push(`settingsStore DEFAULTS has no ${key}`);
  }
  // The proxy pool feeds the mirror request-code call, resolved lazily and
  // auto-sourced only on a real run (no injected client).
  if (!/const proxies = typeof opts\.getProxies === 'function'/.test(sm)) fails.push('acquireManifest does not resolve the proxy pool lazily');
  if (!/requestCodeFromMirror\(mods, endpoint, app, depot\.id, depot\.manifestId, \{ proxies/.test(sm)) fails.push('the mirror request does not receive the proxy pool');
  if (!/getProxies = \(\) => \(poolPromise \|\|= resolveMirrorPool\(/.test(sm)) fails.push('assemble does not build a lazy proxy resolver');
  if (!/require\('\.\/manifestProxies'\)\.resolvePool/.test(sm)) fails.push('resolveMirrorPool does not auto-source from the proxy list');
  if ((sm.match(/autoSource: !options\.client/g) || []).length < 2) fails.push('the entry points do not auto-source only on a real run');
  for (const id of ['inp-manifest-proxies', 'inp-manifest-proxy-source']) {
    if (!html.includes(`id="${id}"`)) fails.push(`the markup has no #${id}`);
    if (!app.includes(`#${id}`)) fails.push(`the renderer never addresses #${id}`);
  }
  if (!/values\.manifest_mirror_proxies = /.test(app)) fails.push('the renderer never saves manifest_mirror_proxies');
  if (!/values\.manifest_proxy_source = /.test(app)) fails.push('the renderer never saves manifest_proxy_source');
  // The proxy agent must be a declared dependency, or electron-builder prunes
  // it and the pool silently no-ops in the packaged app.
  const pkg = JSON.parse(read('package.json', root));
  if (!(pkg.dependencies && pkg.dependencies['https-proxy-agent'])) fails.push('package.json does not declare https-proxy-agent, so the proxy pool would be pruned from the packaged app');
  // The status the renderer reads carries the catalogs.
  if (!/catalogs: catalogStatus\(options\)/.test(sm)) fails.push('steamManifest status does not include the catalogs');
  if (!/steamManifestStatus: \(\) => ipcRenderer\.invoke\('steammanifest:status'\)/.test(preload)) fails.push('preload does not expose the status channel that carries catalog state');
  if (!/ipcMain\.handle\('steammanifest:status'/.test(main)) fails.push('main does not handle steammanifest:status');

  for (const id of ['inp-depot-key-catalog', 'inp-app-token-catalog']) {
    if (!html.includes(`id="${id}"`)) fails.push(`the markup has no #${id}`);
    if (!app.includes(`#${id}`)) fails.push(`the renderer never addresses #${id}`);
  }
  if (!/values\.depot_key_catalog = /.test(app)) fails.push('the renderer never saves depot_key_catalog');
  if (!/values\.app_token_catalog = /.test(app)) fails.push('the renderer never saves app_token_catalog');
  if (!/\$\('#inp-depot-key-catalog'\)\.value = /.test(app)) fails.push('the renderer never loads depot_key_catalog into its field');

  // The mirror is a request-code service, not a bytes mirror: acquireManifest
  // fetches a code and downloads from the CDN with it, and nothing in the
  // module calls a mirror client's .fetchManifest (which returns bytes).
  if (!/code = await requestCodeFromMirror\(mods, endpoint, app/.test(sm)) fails.push('acquireManifest does not obtain a request code from the mirror');
  if (!/const \{ data, host \} = await cdnFetchWithCode\(mods, client, app, depot\.id, depot\.manifestId, code\)/.test(sm)) fails.push('acquireManifest does not download from the CDN with the mirror code');
  if (/\.fetchManifest\(/.test(sm)) fails.push('steamManifest still asks the mirror for manifest bytes');

  // The catalog is off when its URL is cleared (behavioural, cheap).
  const cat = core('steamCatalog.js');
  if (cat.status({ url: '', userData: fakeUserData }).depotKeys.enabled) fails.push('the depot-key catalog is enabled with no URL');
  return fails;
}

// ── integrity across touched files ──────────────────────────────
function parseAll(root = ROOT) {
  const fails = [];
  for (const rel of ['src/core/steamCatalog.js', 'src/core/steamManifest.js', 'src/core/depotKeys.js', 'src/core/settingsStore.js', 'main.js', 'preload.js', 'src/js/app.js']) {
    try { new (requireFrom('node:vm').Script)(readFileSync(join(root, rel), 'utf8'), { filename: rel }); }
    catch (e) { fails.push(`${rel} does not parse: ${e.message}`); }
  }
  return fails;
}

// ── self-test ───────────────────────────────────────────────────
const CHECKED = ['package.json', 'src/core/settingsStore.js', 'preload.js', 'main.js', 'src/index.html', 'src/js/app.js', 'src/core/steamManifest.js', 'src/core/steamCatalog.js', 'src/core/manifestProxies.js', 'src/core/depotKeys.js', 'src/core/zipProcessor.js', 'src/core/zipWriter.js'];
function selfTest() {
  const fails = [];
  const base = mkdtempSync(join(tmpdir(), 'keycatalog-selftest-'));
  const copy = (name) => {
    const d = join(base, name.replace(/[^a-z0-9]+/gi, '-'));
    for (const f of CHECKED) { mkdirSync(dirname(join(d, f)), { recursive: true }); cpSync(join(ROOT, f), join(d, f)); }
    cpSync(join(ROOT, 'deps', 'steammanifest'), join(d, 'deps', 'steammanifest'), { recursive: true });
    return d;
  };
  const sabotage = (label, file, from, to) => {
    const d = copy(label); const p = join(d, file); const text = readFileSync(p, 'utf8');
    if (!text.includes(from)) { fails.push(`cannot sabotage '${label}': ${JSON.stringify(from)} absent from ${file}`); return; }
    writeFileSync(p, text.replace(from, to));
    const caught = wiring(d);
    if (!caught.length) fails.push(`the verifier did not catch '${label}'`);
    else console.log(`  caught ${label}: ${caught[0]}`);
  };
  try {
    if (wiring(copy('clean')).length) fails.push(`the clean copy fails wiring: ${wiring(copy('clean'))[0]}`);
    sabotage('depot_key_catalog default removed', 'src/core/settingsStore.js', "  depot_key_catalog: 'https://api.993499094.xyz/depotkeys.json',", '');
    sabotage('app_token_catalog default removed', 'src/core/settingsStore.js', "  app_token_catalog: 'https://api.993499094.xyz/appaccesstokens.json',", '');
    sabotage('status drops the catalogs', 'src/core/steamManifest.js', 'catalogs: catalogStatus(options)', 'catalogs_: catalogStatus(options)');
    sabotage('catalog field removed from the markup', 'src/index.html', 'id="inp-depot-key-catalog"', 'id="inp-depot-key-catalog-x"');
    sabotage('renderer stops saving the catalog', 'src/js/app.js', 'values.depot_key_catalog = ', 'values.depot_key_catalog_ = ');
    sabotage('mirror reverts to a bytes mirror', 'src/core/steamManifest.js', 'const { data, host } = await cdnFetchWithCode(mods, client, app, depot.id, depot.manifestId, code);', 'const { data, host } = { data: (await new mods.xyz.XyzClient({ endpoint }).fetchManifest(Number(depot.id), depot.manifestId, { appid: Number(app) })).data, host: endpoint };');
    sabotage('proxy pool no longer resolved lazily', 'src/core/steamManifest.js', "const proxies = typeof opts.getProxies === 'function'", "const proxies = typeof opts.getProxies_ === 'function'");
    sabotage('auto-source no longer gated on a real run', 'src/core/steamManifest.js', 'autoSource: !options.client,', 'autoSource: true,');
    sabotage('proxy field removed from the markup', 'src/index.html', 'id="inp-manifest-proxies"', 'id="inp-manifest-proxies-x"');
    sabotage('proxy source field removed from the markup', 'src/index.html', 'id="inp-manifest-proxy-source"', 'id="inp-manifest-proxy-source-x"');
    sabotage('proxy agent dependency dropped', 'package.json', '"https-proxy-agent": "^7.0.0",', '');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const integ = parseAll();
  for (const f of integ) fails.push(f);
  if (!integ.length) console.log('  every touched file parses');
  return fails;
}

// ── regressions ─────────────────────────────────────────────────
function regressions() {
  const fails = [];
  const runs = [
    ['steammanifest ledger', process.execPath, ['dev/verify-steammanifest.mjs', 'all'], 300000],
    ['reliability', process.execPath, ['dev/verify-reliability.cjs'], 300000],
    ['electron smoke', process.execPath, ['dev/run-electron-check.cjs', 'smoke'], 300000],
  ];
  for (const [label, cmd, args, timeout] of runs) {
    const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 });
    const tail = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-4).join(' | ');
    if (r.status !== 0) fails.push(`${label} exited ${r.status}: ${tail}`);
    else console.log(`  ${label} passed`);
  }
  return fails;
}

// ── live ────────────────────────────────────────────────────────
async function live() {
  const fails = [];
  const sm = core('steamManifest.js');
  const cat = core('steamCatalog.js');
  const dir = sm.resolveDir().dir;
  const mods = sm.load(dir);
  const ud = temp('keycatalog-live-');

  // 1. The depot-key catalog supplies a known paid depot's key. BALL x PIT
  //    depot 2062431's real key is public and fixed; the catalog must match it.
  const KNOWN = '5d28ee4226eb2240f32250a615d7cdf1e5beebec25073151597d734fc48d547c';
  const keys = await cat.lookupDepotKeys(['2062431'], { url: 'https://api.993499094.xyz/depotkeys.json', userData: ud });
  if (keys['2062431'] !== KNOWN) fails.push(`the catalog key for depot 2062431 is ${keys['2062431']}, expected the known ${KNOWN.slice(0, 12)}…`);
  else console.log('  catalog supplied depot 2062431 key, matching the known value');

  // 2. cdnFetchWithCode — the path Librarian uses with a code obtained
  //    elsewhere — proven live and deterministically: a code Steam itself
  //    issues anonymously for the free depot 1004, then the manifest fetched
  //    from the Steam CDN with that supplied code, decoded and validated.
  const FREE = { appid: 1007, depot: 1004, manifest: '5612541580377302256' };
  const client = sm.createEndpointClient();
  try {
    const requestCode = await sm.requestCodeFromMirror(mods, sm.DEFAULT_MIRROR, FREE.appid, FREE.depot, FREE.manifest, { proxies: [] });
    if (!/^\d{1,20}$/.test(String(requestCode))) { fails.push('The configured endpoint did not issue a request code'); }
    else {
      const { data, host } = await sm.cdnFetchWithCode(mods, client, FREE.appid, FREE.depot, FREE.manifest, String(requestCode));
      const m = mods.manifest.parseManifest(data);
      if (String(m.depot_id) !== String(FREE.depot) || String(m.gid_manifest) !== FREE.manifest) fails.push('cdnFetchWithCode returned a manifest that did not validate to the requested ids');
      else console.log(`  cdnFetchWithCode: endpoint-issued code + CDN (${host}) decoded depot 1004: ${m.files.length} files`);
    }
  } catch (error) { fails.push(`endpoint live check: ${error.message}`); }

  // 3. The proxy pool against the mirror's per-IP 401, best effort: source a
  //    live pool from the configured list, then ask the mirror for a paid
  //    depot's code through it. Free proxies are flaky, so this is reported,
  //    not gated.
  try {
    const provider = requireFrom(join(ROOT, 'src', 'core', 'manifestProxies.js'));
    provider._reset();
    const pool = await provider.resolvePool({ userData: temp('keycatalog-live-proxies-'), limit: 5, onLog: (l) => console.log(`  ${l}`) });
    if (!pool.length) console.log('  no live proxies available right now (source empty or none responded)');
    else {
      const masked = pool.map((p) => p.replace(/\/\/[^/@]*@/, '//'));
      console.log(`  proxy pool sourced ${pool.length}: ${masked.join(', ')}`);
      try {
        const code = await sm.requestCodeFromMirror(mods, sm.DEFAULT_MIRROR, '2062430', '2062431', '2150634036720804574', { proxies: pool, rounds: 1, timeoutMs: 12000 });
        console.log(`  paid depot 2062431 request code obtained through the proxy pool: ${code}`);
      } catch (err) {
        console.log(`  the pool did not land a paid code this run (${err.message.slice(0, 120)}); the pool mechanism itself is proven offline`);
      }
    }
  } catch (err) {
    console.log(`  proxy pool step skipped (${err.message})`);
  }
  return fails;
}

// ── dispatch ────────────────────────────────────────────────────
const SUITES = { catalog, keyorder, reqcode, proxy: proxySuite, paid, wiring: () => wiring(), 'self-test': selfTest, regressions, live };
const OFFLINE = ['catalog', 'keyorder', 'reqcode', 'proxy', 'paid', 'wiring', 'self-test'];
const name = process.argv[2] || 'all';
const run = name === 'all' ? OFFLINE : [name];
let failed = false;
for (const suite of run) {
  if (!SUITES[suite]) { console.error(`unknown suite: ${suite}`); process.exit(2); }
  let problems;
  try { problems = await SUITES[suite](); }
  catch (e) { problems = [`the suite threw: ${e.stack || e.message}`]; }
  for (const f of problems) console.error(`FAIL ${suite}: ${f}`);
  if (problems.length) failed = true;
  else console.log(`OK ${suite}`);
}
await sleep(50);
process.exit(failed ? 1 : 0);
