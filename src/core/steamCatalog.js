/**
 * Public Steam catalogs, supplying the two things an anonymous
 * session lacks for a paid game.
 *
 * An anonymous Steam session can read most apps' metadata and download free
 * depots, but a paid game withholds two things: the app's PICS **access token**
 * (without which its depot list and current manifest ids cannot be read) and
 * each depot's **decryption key**. Both are published, per app / per depot, as
 * flat JSON documents by catalog sites. The pair found on 2026-09-12 is
 * api.993499094.xyz:
 *
 *   depotkeys.json        { "<depotId>": "<64 hex>" }   ~221k entries, ~17 MB
 *   appaccesstokens.json  { "<appId>":  "<uint64>"  }   ~8k entries
 *
 * Depot keys from this catalog have priority; saved/package keys and Steam
 * are fallbacks for missing or unusable entries (see depotKeys.preferCatalog).
 *
 * Neither has a per-item route, so each document is fetched whole, cached in
 * userData, and refreshed only when the cache is older than a time-to-live.
 * Each URL is a setting and can be cleared to switch that catalog off.
 *
 * These are third parties of unknown operator and retention, so their bodies
 * are untrusted: only a well-formed pair is ever taken (a 64-hex depot key, a
 * non-zero uint64 app token), an oversized body is refused by a hard byte cap,
 * and what they supply is still checked downstream — a token either lets PICS
 * return appinfo or it does not, a depot key either decrypts the depot or the
 * download fails. Every error here is non-fatal: a catalog that cannot be
 * reached simply teaches Librarian nothing new.
 */
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { randomUUID } = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const ID_RE = /^\d{1,10}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const UINT64_RE = /^\d{1,20}$/;
const FETCH_TIMEOUT_MS = 60000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// Each catalog: which setting holds its URL, where it is cached, how big it may
// be, and what a valid value looks like once normalised (or null to drop it).
const KINDS = {
  depotKeys: {
    setting: 'depot_key_catalog',
    file: 'depot_key_catalog.json',
    meta: 'depot_key_catalog.meta.json',
    maxBytes: 96 * 1024 * 1024,
    normalize: (v) => {
      const key = typeof v === 'string' ? v.trim().toLowerCase() : '';
      return HEX64_RE.test(key) ? key : null;
    },
  },
  appTokens: {
    setting: 'app_token_catalog',
    file: 'app_token_catalog.json',
    meta: 'app_token_catalog.meta.json',
    maxBytes: 32 * 1024 * 1024,
    normalize: (v) => {
      const tok = typeof v === 'string' ? v.trim() : (Number.isSafeInteger(v) ? String(v) : '');
      return UINT64_RE.test(tok) && BigInt(tok) > 0n && BigInt(tok) <= 0xffffffffffffffffn ? BigInt(tok).toString() : null;
    },
  },
};

function settingGet(key) {
  try { return require('./settingsStore').get(key); }
  catch { return undefined; }
}

function electronUserData() {
  try {
    const { app } = require('electron');
    return app && typeof app.getPath === 'function' ? app.getPath('userData') : null;
  } catch {
    return null;
  }
}

function urlFor(kind, override) {
  const v = override !== undefined ? override : settingGet(KINDS[kind].setting);
  return typeof v === 'string' ? v.trim() : '';
}

function paths(kind, userData) {
  const base = userData || electronUserData();
  if (!base) throw new Error('no user data directory for the catalog');
  return { data: path.join(base, KINDS[kind].file), meta: path.join(base, KINDS[kind].meta) };
}

function readMeta(p) {
  try { return JSON.parse(fs.readFileSync(p.meta, 'utf8')); }
  catch { return null; }
}

function cleanInto(kind, map, out) {
  if (!map || typeof map !== 'object') return out;
  const normalize = KINDS[kind].normalize;
  for (const [rawId, rawVal] of Object.entries(map)) {
    const id = String(rawId).trim();
    if (!ID_RE.test(id)) continue;
    const value = normalize(rawVal);
    if (value) out[id] = value;
  }
  return out;
}

// One parse per file version (keyed by mtime+size), so a session that fetches
// several games does not re-read a large document each time.
const loaded = new Map();

function loadCache(kind, p) {
  let stat;
  try { stat = fs.statSync(p.data); }
  catch { return null; }
  if (!stat.isFile() || stat.size > KINDS[kind].maxBytes) return null;
  const key = `${p.data}:${stat.mtimeMs}:${stat.size}`;
  const cached = loaded.get(kind);
  if (cached && cached.key === key) return cached.map;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(p.data, 'utf8')); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const map = cleanInto(kind, parsed, Object.create(null));
  loaded.set(kind, { key, map });
  return map;
}

async function download(kind, url, p, etag, { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const { maxBytes } = KINDS[kind];
  const headers = { 'User-Agent': 'Librarian/1.0', Accept: 'application/json' };
  if (etag) headers['If-None-Match'] = etag;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : FETCH_TIMEOUT_MS);
  let res;
  let tmp;
  try {
    res = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'follow' });
    if (res.status === 304) return { status: 304 };
    if (!res.ok) throw new Error(`catalog responded ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`catalog is ${declared} bytes, over the ${maxBytes} cap`);
    tmp = `${p.data}.${randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(p.data), { recursive: true });
    let total = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        total += chunk.length;
        callback(total > maxBytes ? new Error(`catalog exceeded the ${maxBytes} byte cap mid-stream`) : null, chunk);
      },
    });
    // Await closure of every stream before cleanup (Windows cannot unlink
    // an open output). The same deadline covers headers and the full body.
    await pipeline(res.body, limit, fs.createWriteStream(tmp, { flags: 'wx' }), { signal: controller.signal });
    let entries;
    try {
      const parsed = JSON.parse(fs.readFileSync(tmp, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
      entries = Object.keys(parsed).length;
    } catch (err) { throw new Error(`catalog body is not usable: ${err.message}`); }
    fs.renameSync(tmp, p.data);
    loaded.delete(kind);
    return { status: 200, etag: res.headers.get('etag') || '', bytes: total, entries };
  } finally {
    clearTimeout(timer);
    res?.body?.destroy();
    if (tmp) { try { fs.unlinkSync(tmp); } catch { /* renamed or already removed */ } }
  }
}

/** Make one catalog fresh enough to use. Downloads only when missing or stale. */
async function ensureFreshOnce(kind, { url, userData, maxAgeMs, fetchImpl, timeoutMs } = {}) {
  if (!KINDS[kind]) return { available: false, error: `unknown catalog ${kind}` };
  const ttl = Number.isFinite(maxAgeMs) ? maxAgeMs : DEFAULT_TTL_MS;
  const cleanUrl = urlFor(kind, url);
  if (!cleanUrl) return { available: false, refreshed: false, error: 'no catalog URL' };
  let p;
  try { p = paths(kind, userData); }
  catch (err) { return { available: false, refreshed: false, error: err.message }; }

  const meta = readMeta(p);
  const sameUrl = Boolean(meta && meta.url === cleanUrl);
  const haveCache = sameUrl && loadCache(kind, p) !== null;
  const age = sameUrl ? Date.now() - Number(meta.fetchedAt || 0) : Infinity;
  if (haveCache && sameUrl && age < ttl) return { available: true, refreshed: false, entries: meta.entries || 0 };

  try {
    const result = await download(kind, cleanUrl, p, haveCache ? meta.etag : '', { fetchImpl, timeoutMs });
    if (result.status === 304 && !haveCache) throw new Error('catalog returned 304 without a usable cache');
    const next = {
      url: cleanUrl,
      fetchedAt: Date.now(),
      etag: result.status === 304 ? (meta && meta.etag) || '' : result.etag,
      entries: result.status === 304 ? (meta && meta.entries) || 0 : result.entries,
      bytes: result.status === 304 ? (meta && meta.bytes) || 0 : result.bytes,
    };
    try { fs.writeFileSync(p.meta, JSON.stringify(next)); } catch { /* meta is a hint */ }
    return { available: fs.existsSync(p.data), refreshed: result.status !== 304, entries: next.entries };
  } catch (err) {
    if (haveCache) return { available: true, refreshed: false, stale: true, error: err.message, entries: (meta && meta.entries) || 0 };
    return { available: false, refreshed: false, error: err.message };
  }
}

// Concurrent game searches share a catalog fetch. Serialize different URLs
// targeting the same cache file so their data and metadata cannot interleave.
const pending = new Map();
async function ensureFresh(kind, options = {}) {
  if (!KINDS[kind]) return { available: false, error: `unknown catalog ${kind}` };
  let file;
  try { file = paths(kind, options.userData).data; }
  catch (err) { return { available: false, error: err.message }; }
  const url = urlFor(kind, options.url);
  while (pending.has(file)) {
    const running = pending.get(file);
    if (running.url === url) return running.promise;
    await running.promise;
  }
  const promise = ensureFreshOnce(kind, { ...options, url });
  pending.set(file, { url, promise });
  try { return await promise; }
  finally { if (pending.get(file)?.promise === promise) pending.delete(file); }
}

/** Values for the requested ids from one catalog; refreshes if stale, never throws. */
async function lookup(kind, ids, options = {}) {
  const wanted = (Array.isArray(ids) ? ids : [ids]).map(String).filter((id) => ID_RE.test(id));
  if (!wanted.length || !KINDS[kind]) return {};
  const state = await ensureFresh(kind, options);
  if (!state.available) return {};
  let p;
  try { p = paths(kind, options.userData); }
  catch { return {}; }
  const map = loadCache(kind, p);
  if (!map) return {};
  const out = {};
  for (const id of wanted) if (map[id]) out[id] = map[id];
  return out;
}

function statusOf(kind, options = {}) {
  const url = urlFor(kind, options.url);
  const st = { enabled: Boolean(url), url, cached: false, entries: 0, fetchedAt: 0, ageMs: null };
  if (!url) return st;
  let p;
  try { p = paths(kind, options.userData); }
  catch { return st; }
  const meta = readMeta(p);
  st.cached = Boolean(meta && meta.url === url && fs.existsSync(p.data));
  if (meta && meta.url === url) {
    st.entries = meta.entries || 0;
    st.fetchedAt = Number(meta.fetchedAt || 0);
    st.ageMs = st.fetchedAt ? Date.now() - st.fetchedAt : null;
  }
  return st;
}

module.exports = {
  KINDS,
  DEFAULT_TTL_MS,
  ensureFresh,
  lookupDepotKeys: (ids, options) => lookup('depotKeys', ids, options),
  lookupAppTokens: (ids, options) => lookup('appTokens', ids, options),
  status: (options = {}) => ({ depotKeys: statusOf('depotKeys', options), appTokens: statusOf('appTokens', options) }),
  _reset: () => loaded.clear(),
};
