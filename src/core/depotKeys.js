/**
 * Depot decryption keys Librarian has come across, kept for the day a
 * manifest arrives without them.
 *
 * Generated and imported packages prefer the configured XYZ key catalog.
 * Hubcap/Lua packages, this store and local key files provide fallbacks
 * when that catalog cannot supply a depot. A depot's key
 * never changes, so a key seen once — in an earlier Hubcap package for the
 * same game, in the Steam client's own config for a game the account owns,
 * in the key file the steammanifest project keeps beside its scripts — is
 * usable for later builds of that depot. This store is the union: read
 * when the local source writes its Lua, added to whenever a package passes
 * through zipProcessor.
 *
 * userData/depot_keys.json is { "<depotId>": "<64 hex>" }, written through
 * jsonFile like the queue, so a crash mid-write cannot lose it.
 */
const fs = require('fs');
const path = require('path');
const json = require('./jsonFile');

const KEY_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^\d{1,10}$/;
const FILE_NAME = 'depot_keys.json';

function electronUserData() {
  try {
    const { app } = require('electron');
    return app && typeof app.getPath === 'function' ? app.getPath('userData') : null;
  } catch {
    return null;
  }
}

function filePath(userData = electronUserData()) {
  if (!userData) throw new Error('No user data directory for the depot key store');
  return path.join(userData, FILE_NAME);
}

/**
 * Keep only well-formed pairs. Accepts { id: "hex" } and the zipProcessor
 * shape { id: { key: "hex", ... } }; ids and keys are normalised.
 */
function clean(map) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [rawId, value] of Object.entries(map)) {
    const id = String(rawId).trim();
    const key = typeof value === 'string'
      ? value.trim().toLowerCase()
      : (value && typeof value === 'object' && typeof value.key === 'string' ? value.key.trim().toLowerCase() : '');
    if (ID_RE.test(id) && KEY_RE.test(key)) out[id] = key;
  }
  return out;
}

function load(userData) {
  try { return clean(json.read(filePath(userData), {})); }
  catch { return {}; }
}

/** Merge keys into the store. Returns how many were new; never throws. */
function remember(map, userData) {
  const incoming = clean(map);
  if (!Object.keys(incoming).length) return 0;
  try {
    const file = filePath(userData);
    const current = clean(json.read(file, {}));
    let added = 0;
    for (const [id, key] of Object.entries(incoming)) {
      if (current[id] === key) continue;
      current[id] = key;
      added++;
    }
    if (added) json.write(file, current);
    return added;
  } catch (err) {
    console.warn(`Could not remember depot keys: ${err.message}`);
    return 0;
  }
}

/**
 * The Steam client's own config.vdf lists, under "depots", the key of every
 * depot it has installed or been given — the games the account owns.
 */
function fromSteamConfig(steamPath) {
  const out = {};
  if (!steamPath) return out;
  let text;
  try { text = fs.readFileSync(path.join(steamPath, 'config', 'config.vdf'), 'utf8'); }
  catch { return out; }
  const re = /"(\d{1,10})"\s*\{\s*"DecryptionKey"\s*"([0-9a-fA-F]{64})"\s*\}/g;
  for (const m of text.matchAll(re)) out[m[1]] = m[2].toLowerCase();
  return out;
}

/** A { "<depotId>": "<hex>" } file, such as steammanifest's depot_keys.json. */
function fromFile(file) {
  try { return clean(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { return {}; }
}

/**
 * Everything known, most trusted last so it wins: key files, then the
 * store, then the Steam client's own config.
 */
function collect({ userData, steamPath, files = [] } = {}) {
  const merged = {};
  for (const file of files) Object.assign(merged, fromFile(file));
  Object.assign(merged, load(userData));
  Object.assign(merged, fromSteamConfig(steamPath));
  return merged;
}

/** XYZ's configured catalog wins per depot; other sources fill only gaps. */
async function preferCatalog(ids, fallbackKeys = {}, { resolveCatalogKeys, userData } = {}) {
  const wanted = [...new Set(ids.map(String).filter((id) => ID_RE.test(id)))];
  const fallback = clean(fallbackKeys);
  let primary = {};
  if (wanted.length && resolveCatalogKeys !== false && resolveCatalogKeys !== null) {
    const resolve = resolveCatalogKeys || ((requested) => require('./steamCatalog').lookupDepotKeys(requested, { userData }));
    try { primary = clean(await resolve(wanted)); }
    catch { /* unavailable catalog: keep the fallback keys */ }
  }
  const keys = {};
  const catalogIds = [];
  for (const id of wanted) {
    if (primary[id]) { keys[id] = primary[id]; catalogIds.push(id); }
    else if (fallback[id]) keys[id] = fallback[id];
  }
  return { keys, catalogIds };
}

module.exports = { FILE_NAME, KEY_RE, filePath, clean, load, remember, fromSteamConfig, fromFile, collect, preferCatalog };
