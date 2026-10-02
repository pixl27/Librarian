// ─── Store artwork resolver ──────────────────────────────────────
//
// Steam serves capsule art from two different schemes:
//
//   legacy  cdn.cloudflare.steamstatic.com/steam/apps/<id>/header.jpg
//   current shared.akamai.steamstatic.com/store_item_assets/steam/apps/<id>/<hash>/header.jpg
//
// The legacy path still works for most of the back catalogue, but newer apps
// (Beast of Reincarnation, appid 2001760, among them) return 404 for header.jpg
// AND library_600x900.jpg — their art only exists under the content-hashed path,
// which is discoverable solely through the store's appdetails API.
//
// This module probes the cheap legacy URLs first and only falls back to the API
// when something is genuinely missing, then caches the answer on disk so the
// lookup happens once per game rather than once per render.
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { app } = require('electron');

const LEGACY_BASE = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
const CACHE_FILE = 'librarian-art-cache.json';
// Art rarely changes; a miss is retried sooner in case a game gets art later.
const TTL_HIT = 30 * 24 * 60 * 60 * 1000;
const TTL_MISS = 12 * 60 * 60 * 1000;
const PROBE_TIMEOUT = 8000;

let _cache = null;
let _saveTimer = null;
// Collapses concurrent requests for the same app into one network round trip —
// a grid of tiles all failing at once would otherwise stampede the store API.
const inFlight = new Map();

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
      const tmp = `${target}.tmp`;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(_cache), 'utf-8');
      fs.renameSync(tmp, target);
    } catch { /* the cache is an optimisation; losing it costs one lookup */ }
  }, 1200);
}

function normalizeAppId(appId) {
  const id = String(appId || '').trim();
  return /^\d{1,20}$/.test(id) && id !== '0' ? id : null;
}

/** HEAD the URL; true only for a real 2xx. */
async function exists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', timeout: PROBE_TIMEOUT, redirect: 'follow' });
    return res.ok;
  } catch {
    return false;
  }
}

async function firstThatExists(urls) {
  for (const url of urls) {
    if (url && await exists(url)) return url;
  }
  return null;
}

/** Ask the store for the content-hashed asset URLs. */
async function fromStoreApi(appId) {
  try {
    const res = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${appId}`,
      { timeout: 15000 }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const entry = json?.[appId];
    if (!entry?.success || !entry.data) return null;
    const d = entry.data;
    return {
      header: d.header_image || d.capsule_image || null,
      hero: d.background_raw || d.background || null,
      // A screenshot is a real image of the game, and a far better last resort
      // than a coloured plate when nothing else exists.
      shot: (d.screenshots || [])[0]?.path_full || null,
    };
  } catch {
    return null;
  }
}

/**
 * Ask Steam's store-browse service for the content-hashed asset names.
 *
 * This is the one that finds posters nobody else can. Newer apps do not have
 * art at the predictable path — cdn…/steam/apps/<id>/library_600x900.jpg is a
 * 404 for them, and appdetails has no portrait field at all, which is why this
 * resolver used to give up and let the renderer frame a landscape banner
 * instead. Their art does exist; it is just stored under a hash:
 *
 *   library_capsule = 480bd879…21/library_600x900.jpg
 *
 * Verified against three games that had no poster by any other route — PEAK,
 * MECCHA CHAMELEON and Beast of Reincarnation — all three return a real
 * 55–70 KB JPEG here. No API key, no third-party service.
 */
const ASSET_BASE = 'https://shared.cloudflare.steamstatic.com/store_item_assets/';

async function fromStoreAssets(appId) {
  try {
    const input = JSON.stringify({
      ids: [{ appid: Number(appId) }],
      context: { language: 'english', country_code: 'US' },
      data_request: { include_assets: true },
    });
    const res = await fetch(
      'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=' + encodeURIComponent(input),
      { timeout: 15000 }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const assets = json?.response?.store_items?.[0]?.assets;
    // asset_url_format is "steam/apps/<id>/${FILENAME}?t=…"; the hash lives in
    // the per-asset value, so the two are joined rather than either used alone.
    const fmt = assets?.asset_url_format;
    if (!assets || !fmt) return null;
    const url = (name) => (name ? ASSET_BASE + fmt.replace('${FILENAME}', name) : null);
    return {
      // _2x is the same poster at twice the resolution; tiles are rendered on
      // high-DPI displays and it costs the same round trip.
      portrait: url(assets.library_capsule_2x || assets.library_capsule),
      header: url(assets.header || assets.main_capsule),
      hero: url(assets.library_hero || assets.page_background),
    };
  } catch {
    return null;
  }
}

async function probe(appId) {
  const legacy = {
    portrait: `${LEGACY_BASE}/${appId}/library_600x900.jpg`,
    header: `${LEGACY_BASE}/${appId}/header.jpg`,
    hero: `${LEGACY_BASE}/${appId}/library_hero.jpg`,
  };

  // Probe the cheap paths in parallel — most games resolve entirely from here.
  const [portrait, header, hero] = await Promise.all([
    firstThatExists([legacy.portrait]),
    firstThatExists([legacy.header, `${LEGACY_BASE}/${appId}/capsule_616x353.jpg`]),
    firstThatExists([legacy.hero]),
  ]);

  const result = { portrait, header, hero, source: 'legacy' };

  // The hashed assets answer both questions the legacy paths leave open: a
  // missing poster (common on anything recent) and a missing capsule. Asked for
  // whenever either is absent, and never when both already resolved.
  if (!result.portrait || !result.header) {
    const assets = await fromStoreAssets(appId);
    if (assets) {
      result.source = result.portrait || result.header ? 'legacy+assets' : 'assets';
      result.portrait = result.portrait || assets.portrait;
      result.header = result.header || assets.header;
      result.hero = result.hero || assets.hero;
    }
  }

  // Only pay for the appdetails call when the landscape capsule — the one every
  // tile needs — is still missing after that.
  if (!result.header) {
    const store = await fromStoreApi(appId);
    if (store) {
      result.source = 'store';
      result.header = store.header || store.shot || result.header;
      result.hero = result.hero || store.hero || store.shot;
      // No portrait endpoint exists in appdetails; the renderer frames the
      // landscape art instead of cropping a poster out of it.
      result.portrait = result.portrait || null;
    }
  }

  result.found = Boolean(result.portrait || result.header || result.hero);
  return result;
}

/**
 * Resolve the best available artwork for an app.
 * @returns {Promise<{portrait:string|null, header:string|null, hero:string|null, found:boolean}>}
 */
async function resolveArt(appId) {
  const id = normalizeAppId(appId);
  const empty = { portrait: null, header: null, hero: null, found: false };
  if (!id) return empty;

  const cache = loadCache();
  const hit = cache[id];
  if (hit && typeof hit === 'object') {
    const age = Date.now() - (Number(hit.ts) || 0);
    if (age < (hit.found ? TTL_HIT : TTL_MISS)) {
      return { portrait: hit.portrait || null, header: hit.header || null, hero: hit.hero || null, found: Boolean(hit.found) };
    }
  }

  if (inFlight.has(id)) return inFlight.get(id);

  const task = (async () => {
    let result;
    try {
      result = await probe(id);
    } catch {
      result = { ...empty };
    }
    cache[id] = { ...result, ts: Date.now() };
    saveCacheSoon();
    return result;
  })().finally(() => inFlight.delete(id));

  inFlight.set(id, task);
  return task;
}

function clearArtCache() {
  _cache = {};
  try { fs.unlinkSync(cachePath()); } catch {}
  return true;
}

module.exports = { resolveArt, clearArtCache };
