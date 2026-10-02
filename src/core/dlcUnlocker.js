// ═══════════════════════════════════════════════════════════════════
// Librarian — DLC
//
// The emulator already answers the ownership questions a game asks about its
// DLC; it just answers "no" to all of them unless it is told otherwise. That
// lives in `steam_settings/configs.app.ini`:
//
//   [app::dlcs]
//   unlock_all=1
//   4711720=Mortal Shell II: Devout Edition Upgrade
//
// Both halves matter. `unlock_all` covers a game that asks "do I own <id>"
// about ids we never listed, and the list covers a game that enumerates its
// DLC by index — GetDLCCount, BGetDLCDataByIndex — and shows the names it gets
// back in its own menus. Writing only the switch leaves those menus empty.
//
// The ids and names come from the storefront, so they are the game's real DLC
// rather than a guess. Steam's appdetails refuses a batched request with
// filters (measured: HTTP 400), so names are fetched one at a time with a small
// concurrency cap and cached.
// ═══════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const https = require('https');
const { app } = require('electron');

const SECTION = 'app::dlcs';
const CONFIG_FILE = 'configs.app.ini';
const CACHE_FILE = 'librarian-dlc-cache.json';
const TTL = 7 * 24 * 60 * 60 * 1000;
const LOOKUP_CONCURRENCY = 4;

let _cache = null;
let _saveTimer = null;

function cachePath() {
  return path.join(app.getPath('userData'), CACHE_FILE);
}

function loadCache() {
  if (_cache) return _cache;
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), 'utf-8'));
    _cache = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch {
    _cache = {};
  }
  return _cache;
}

function saveCacheSoon() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      const target = cachePath();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(`${target}.tmp`, JSON.stringify(_cache), 'utf-8');
      fs.renameSync(`${target}.tmp`, target);
    } catch { /* the cache is a convenience */ }
  }, 1200);
  if (_saveTimer.unref) _saveTimer.unref();
}

function getJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 12000, headers: { Accept: 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function nameOf(dlcId) {
  const cache = loadCache();
  const hit = cache[dlcId];
  if (hit && Date.now() - (hit.ts || 0) < TTL) return hit.name || '';

  const json = await getJson(`https://store.steampowered.com/api/appdetails?appids=${dlcId}&filters=basic`);
  const name = String(json?.[dlcId]?.data?.name || '').trim();
  // Recorded either way: a DLC with no store page is not going to grow one
  // between two launches, and re-asking every time is what makes this slow.
  cache[dlcId] = { name, ts: Date.now() };
  saveCacheSoon();
  return name;
}

/**
 * The game's real DLC, ids and names, from the storefront.
 *
 * The id list is cached alongside the names. Most games have no DLC at all, and
 * that is the answer the interface needs before it can decide whether to offer
 * the switch — asking Steam again every time a game panel opened would put a
 * network round trip in front of a card the user is already looking at.
 */
async function listDlc(appId) {
  const id = String(appId || '').trim();
  if (!/^\d{1,20}$/.test(id)) return { items: [], error: 'no app id' };

  const cache = loadCache();
  const known = cache[`app:${id}`];
  let ids;

  if (known && Date.now() - (known.ts || 0) < TTL) {
    ids = Array.isArray(known.ids) ? known.ids : [];
  } else {
    const json = await getJson(`https://store.steampowered.com/api/appdetails?appids=${id}`);
    const data = json?.[id]?.data;
    if (!json) return { items: [], error: 'Steam did not answer', unknown: true };
    if (!data) return { items: [], error: 'no store page for this app', unknown: true };

    ids = Array.isArray(data.dlc) ? data.dlc.map((n) => String(n)).filter((n) => /^\d+$/.test(n)) : [];
    cache[`app:${id}`] = { ids, ts: Date.now() };
    saveCacheSoon();
  }

  if (!ids.length) return { items: [], error: null };

  const items = new Array(ids.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= ids.length) return;
      items[i] = { appid: ids[i], name: await nameOf(ids[i]) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, ids.length) }, worker));

  return { items: items.filter(Boolean), error: null };
}

// ─── The ini file ─────────────────────────────────────────────────
// Hand-rolled rather than a dependency: the emulator owns this file and writes
// sections we know nothing about, so everything outside [app::dlcs] is carried
// through byte for byte instead of being re-serialised by a parser that might
// have its own opinions about ordering, comments or quoting.

function splitSections(text) {
  const lines = String(text || '').split(/\r?\n/);
  const before = [];
  const inside = [];
  const after = [];
  let where = 'before';

  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      const name = header[1].trim().toLowerCase();
      if (name === SECTION) { where = 'inside'; continue; }
      if (where === 'inside') where = 'after';
    }
    (where === 'before' ? before : where === 'inside' ? inside : after).push(line);
  }
  return { before, inside, after, found: inside.length > 0 || where !== 'before' };
}

function readSection(text) {
  const { inside } = splitSections(text);
  let unlockAll = false;
  const items = [];
  for (const line of inside) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key.toLowerCase() === 'unlock_all') unlockAll = /^(1|true|yes|on)$/i.test(value);
    else if (/^\d+$/.test(key)) items.push({ appid: key, name: value });
  }
  return { unlockAll, items };
}

function settingsDirFor(gamePath) {
  const { findSettingsDir } = require('./achievements');
  return findSettingsDir(gamePath);
}

/**
 * A member's hypervisor release brings its own emulator settings, with the
 * DLC list written out and unlock_all=0 on purpose: RE Engine games probe a
 * fake DLC id and never finish "searching for DLC" when everything answers
 * yes. Measured on Onimusha: Way of the Sword, 2026-09-04. That list is the
 * release's to manage; this panel keeps its hands off it.
 */
function managedByRelease(gamePath) {
  try { return require('./launcher').isGuardedRelease(gamePath); } catch { return false; }
}

const RELEASE_REASON = 'This game runs on a CS.RIN.RU release that manages its own DLC list; changing it would stall the game\'s DLC check.';

/** What the emulator is currently told about this game's DLC. */
function status(gamePath) {
  if (managedByRelease(gamePath)) return { ready: false, managed: 'release', reason: RELEASE_REASON, unlockAll: false, items: [] };
  const dir = settingsDirFor(gamePath);
  if (!dir) return { ready: false, reason: 'This game is not cracked, so there is no emulator to tell.', unlockAll: false, items: [] };

  const file = path.join(dir, CONFIG_FILE);
  let text = '';
  try { text = fs.readFileSync(file, 'utf-8'); } catch { /* absent is simply "nothing set" */ }
  return { ready: true, file, ...readSection(text) };
}

/**
 * Write the DLC section, leaving every other section exactly as it was.
 *
 * `items` is optional: the switch alone is enough for a game that only ever
 * asks about ids it already knows, and the list is what fills in the ones that
 * enumerate.
 */
function apply(gamePath, { unlockAll = true, items = [] } = {}) {
  if (managedByRelease(gamePath)) return { success: false, error: RELEASE_REASON };
  const dir = settingsDirFor(gamePath);
  if (!dir) return { success: false, error: 'No steam_settings folder — crack the game first.' };

  const file = path.join(dir, CONFIG_FILE);
  let text = '';
  try { text = fs.readFileSync(file, 'utf-8'); } catch { /* new file */ }
  const { before, after } = splitSections(text);

  const body = [`[${SECTION}]`, `unlock_all=${unlockAll ? 1 : 0}`];
  for (const item of items) {
    if (!/^\d+$/.test(String(item?.appid || ''))) continue;
    // The name is what the game prints in its own DLC menu, so an empty one is
    // better than the word "undefined" showing up in a store page.
    body.push(`${item.appid}=${String(item.name || '').replace(/[\r\n]+/g, ' ').trim()}`);
  }

  const out = [...trimTrailingBlanks(before), '', ...body, '', ...trimLeadingBlanks(after)]
    .join('\r\n')
    .replace(/(\r\n){3,}/g, '\r\n\r\n')
    .trim() + '\r\n';

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, out, 'utf-8');
  } catch (e) {
    return { success: false, error: e.message };
  }
  return { success: true, file, unlockAll, count: body.length - 2 };
}

/** Back to locked: the switch off and the list dropped. */
function disable(gamePath) {
  return apply(gamePath, { unlockAll: false, items: [] });
}

function trimTrailingBlanks(lines) {
  const out = [...lines];
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

function trimLeadingBlanks(lines) {
  const out = [...lines];
  while (out.length && !out[0].trim()) out.shift();
  return out;
}

module.exports = { listDlc, status, apply, disable };
