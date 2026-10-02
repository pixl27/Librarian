/**
 * steammanifest as a source.
 *
 * Hubcap answers a search and hands back a package: one .lua naming the game,
 * its depots with their decryption keys, its DLCs and manifest sizes, and one
 * .manifest per depot. Everything after that — zipProcessor, the queue,
 * SteamPipe — reads that package and nothing else. This module builds the
 * same package from Steam itself, through the steammanifest project
 * vendored under deps/steammanifest: only its manifest decoder and HTTP
 * helper are used. Public metadata comes from api.steamcmd.net. There is
 * no Steam session, key request or direct manifest request-code attempt.
 * Request codes come from 20770407.xyz/enone, with the original
 * 20770407.xyz relay as backup (the relays return codes, not manifest bytes), and the
 * manifest is downloaded from the Steam CDN with it, verified by depot and
 * manifest id after decoding.
 *
 * Two uses:
 *
 *   downloadManifest(appId)    the package, from Steam, with keys from the
 *                              XYZ catalog first, then saved/package keys
 *                              and local key files
 *   refresh(appId, hubcapZip)  Hubcap's package checked against Steam's
 *                              current manifests; when a depot is behind, a
 *                              fresh package assembled from the two — keys
 *                              and unchanged manifests from Hubcap's,
 *                              changed manifests from Steam or the mirror
 *
 * Hubcap's packages are made in batches, so a game that updated this morning
 * comes back as last week's build; the second use is why this source exists.
 * Depot keys are the crux of the first: a paid game needs a key from
 * somewhere — an earlier package, the Steam client's config, the project's
 * key file, or the public depot-key catalog (src/core/steamCatalog.js) — and
 * when none is known the fetch is refused with that message rather than a
 * package the engine would fail on at download time. An app that even
 * withholds its depot list from an anonymous session is read with a PICS
 * access token from that same catalog.
 *
 * The Lua is written in the Morrenus/Hubcap style so zipProcessor parses it
 * like any other. A depot is listed only when both its key and its manifest
 * were obtained; the rest are named in a comment, never as addappid lines,
 * because parseLua matches addappid( anywhere on a line.
 */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { randomUUID } = require('crypto');
const fetch = require('node-fetch');
const { getDepsPath } = require('./runtimePaths');
const depotKeys = require('./depotKeys');
const { buildZip } = require('./zipWriter');

const STORE_SEARCH = 'https://store.steampowered.com/api/storesearch/';
const APP_DETAILS = 'https://store.steampowered.com/api/appdetails';
const APP_METADATA = 'https://api.steamcmd.net/v1/info/';
// Shared with hubcapApi.js so manifest:cleanupFetched treats both alike.
const MANIFEST_DIR = 'hubcap_manifests';
const KEY_FILE = 'depot_keys.json';
const BRANCH = 'public';
const BUDGET_MS = 5 * 60 * 1000;
const CDN_ATTEMPTS = 5;
const FALLBACK_CDN_HOSTS = ['steampipe.akamaized.net', 'cache1-lhr1.steamcontent.com'];
const DEFAULT_MIRROR = 'https://20770407.xyz/enone';
const BACKUP_MIRROR = 'https://20770407.xyz';

const NO_KEY = 'no key';
const NO_MANIFEST = 'no manifest';

function normalizeAppId(appId) {
  const id = String(appId || '').trim();
  return /^\d{1,10}$/.test(id) ? id : null;
}

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

/** The Steam folder, quietly: the registry when it answers, else what was remembered. */
function steamPathQuiet() {
  try { return require('./steamHelpers').findSteamInstall() || settingGet('steam_path') || ''; }
  catch { return settingGet('steam_path') || ''; }
}

// ── Where the project is ────────────────────────────────────────

function isCheckout(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, 're', 'manifest_format.js')) && fs.existsSync(path.join(dir, 're', 'http.js'));
}

/**
 * LIBRARIAN_STEAMMANIFEST_DIR for development, then the folder set in
 * Settings, then the vendored copy. A configured folder that is not a
 * checkout is reported, and the next candidate used, so a stale setting
 * cannot switch the source off.
 */
function resolveDir(options = {}) {
  const env = String(process.env.LIBRARIAN_STEAMMANIFEST_DIR || '').trim();
  const configured = String(options.dir ?? settingGet('steammanifest_dir') ?? '').trim();
  const bundled = getDepsPath('steammanifest');
  const candidates = [['env', env], ['setting', configured], ['bundled', bundled]].filter(([, dir]) => dir);
  const base = { configured, configuredMissing: Boolean(configured) && !isCheckout(configured), bundled };
  for (const [from, dir] of candidates) {
    if (isCheckout(dir)) return { ...base, dir: path.resolve(dir), from, missing: false };
  }
  return { ...base, dir: path.resolve(candidates[0][1]), from: candidates[0][0], missing: true };
}

const loaded = new Map();
function load(dir) {
  if (loaded.has(dir)) return loaded.get(dir);
  const req = createRequire(path.join(dir, 'package.json'));
  const mods = {
    xyz: req('./re/xyz_client'),             // XyzClient, XyzError, DEFAULT_ENDPOINT
    manifest: req('./re/manifest_format'),   // parseManifest, decompress
    http: req('./re/http'),                  // httpGet — for a CDN fetch with a supplied code
  };
  for (const [name, mod] of [['re/manifest_format', mods.manifest.parseManifest], ['re/http', mods.http.httpGet]]) {
    if (typeof mod !== 'function') throw new Error(`${name} does not export what Librarian needs`);
  }
  loaded.set(dir, mods);
  return mods;
}

function version(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'VERSION.txt'), 'utf8');
    return {
      copied: /^copied (\S+)/m.exec(text)?.[1] || '',
      source: /^source (.+)$/m.exec(text)?.[1] || '',
      packages: /^runtime packages (.+)$/m.exec(text)?.[1] || '',
    };
  } catch {
    return null;
  }
}

/** Accept a relay base or the /manifest/x/x template shown by the API. */
function mirrorEndpoint(override) {
  const value = String(override ?? settingGet('steammanifest_mirror') ?? '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return '';
    return url.origin + url.pathname.replace(/\/+$/, '').replace(/\/manifest\/x\/x$/i, '');
  } catch {
    return '';
  }
}

function mirrorEndpoints(override, fallbacks = [BACKUP_MIRROR]) {
  const configured = mirrorEndpoint(override);
  // Upgrade an explicitly saved old default too; it is now the backup.
  const primary = !configured || configured === BACKUP_MIRROR ? DEFAULT_MIRROR : configured;
  return [...new Set([primary, ...fallbacks.map((url) => mirrorEndpoint(url)).filter(Boolean)])];
}

function status(options = {}) {
  const where = resolveDir(options);
  const st = {
    available: !where.missing,
    dir: where.dir,
    from: where.from,
    configured: where.configured,
    configuredMissing: where.configuredMissing,
    bundled: where.bundled,
    version: where.missing ? null : version(where.dir),
    mirror: mirrorEndpoint(options.mirror),
    mirrors: mirrorEndpoints(options.mirror),
    keysKnown: 0,
    catalogs: catalogStatus(options),
    error: '',
  };
  if (!st.available) {
    st.error = `steammanifest not found at ${where.dir}`;
    return st;
  }
  try { load(where.dir); }
  catch (err) {
    st.available = false;
    st.error = `steammanifest at ${where.dir} could not be loaded: ${err.message}`;
    return st;
  }
  try {
    st.keysKnown = Object.keys(depotKeys.collect({
      userData: options.userData,
      steamPath: options.steamPath ?? settingGet('steam_path'),
      files: [path.join(where.dir, KEY_FILE)],
    })).length;
  } catch {
    st.keysKnown = 0;
  }
  return st;
}

/** The depot-key and app-token catalogs, for the status panel. Never throws. */
function catalogStatus(options = {}) {
  try { return require('./steamCatalog').status({ userData: options.userData }); }
  catch { return { depotKeys: { enabled: false }, appTokens: { enabled: false } }; }
}

/**
 * Which sources a request goes to, in order. Auto: Hubcap when there is a
 * key, then the local source; either alone when only one is possible.
 */
function sourceOrder({ mode, hasKey, available }) {
  if (mode === 'hubcap') return ['hubcap'];
  if (mode === 'steammanifest') return ['steammanifest'];
  const order = [];
  if (hasKey) order.push('hubcap');
  if (available) order.push('steammanifest');
  return order;
}

// ── Search ──────────────────────────────────────────────────────

/** Steam's own store search, in Hubcap's result shape; a number is looked up as an AppID. */
async function searchGames(query, { fetchImpl = fetch } = {}) {
  const term = String(query || '').trim().slice(0, 120);
  if (term.length < 2) return { error: 'Search for at least two characters.', results: [] };
  // These endpoints fail independently. Start both together and preserve
  // either answer across HTTP, connection and JSON errors from the other.
  const byIdRequest = async () => {
    if (!/^\d{1,10}$/.test(term)) return [];
    const res = await fetchImpl(`${APP_DETAILS}?appids=${term}&filters=basic&l=english`, { timeout: 10000 });
    if (!res.ok) throw new Error(`Steam app lookup answered ${res.status}.`);
    const json = await res.json();
    const data = json && json[term] && json[term].success ? json[term].data : null;
    return data && data.name ? [{ game_id: term, game_name: String(data.name) }] : [];
  };
  const byNameRequest = async () => {
    const res = await fetchImpl(`${STORE_SEARCH}?term=${encodeURIComponent(term)}&l=english&cc=US`, { timeout: 10000 });
    if (!res.ok) throw new Error(`Steam's store answered ${res.status}.`);
    const json = await res.json();
    return (Array.isArray(json && json.items) ? json.items : [])
      .filter((item) => item && item.type === 'app' && /^\d{1,10}$/.test(String(item.id)))
      .map((item) => ({ game_id: String(item.id), game_name: String(item.name || '') }));
  };
  const answers = await Promise.allSettled([byIdRequest(), byNameRequest()]);
  const results = unionResults(...answers.map((a) => a.status === 'fulfilled' ? a.value : []));
  const warning = answers.filter((a) => a.status === 'rejected').map((a) => a.reason?.message || String(a.reason)).join(' · ');
  if (warning && !results.length) return { error: `Steam store search failed: ${warning}`, results };
  return warning ? { results, warning } : { results };
}

/** Auto searches both: Hubcap's order first, Steam's extras after, one entry per app. */
function unionResults(primary, secondary) {
  const seen = new Set();
  const results = [];
  for (const list of [primary, secondary]) {
    for (const g of Array.isArray(list) ? list : []) {
      const id = String(g && g.game_id != null ? g.game_id : '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      results.push({ game_id: id, game_name: String((g && g.game_name) || '') });
    }
  }
  return results;
}

// ── Public metadata endpoint: depots and current manifests ──────

function createEndpointClient({ fetchImpl = fetch, metadataEndpoint = APP_METADATA, cdnHosts = FALLBACK_CDN_HOSTS } = {}) {
  const requests = new Map();
  const appInfo = (id) => {
    if (!requests.has(id)) requests.set(id, (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetchImpl(`${metadataEndpoint.replace(/\/+$/, '')}/${id}`, {
          signal: controller.signal, size: 16 * 1024 * 1024,
          headers: { Accept: 'application/json', 'User-Agent': 'Librarian/1.1' },
        });
        if (!response.ok) throw new Error(`Metadata endpoint returned HTTP ${response.status} for app ${id}`);
        const json = await response.json();
        if (json?.status !== 'success' || !json.data?.[id]?.common) throw new Error(`Metadata endpoint has no usable record for app ${id}`);
        return json.data[id];
      } finally { clearTimeout(timer); }
    })());
    return requests.get(id);
  };
  return {
    async getProductInfo(ids) {
      const apps = {};
      const unique = [...new Set(ids.map((id) => normalizeAppId(id)))];
      if (unique.includes(null)) throw new Error('Invalid metadata AppID.');
      // Shared parent apps are normally few; cap each batch to avoid a burst.
      for (let i = 0; i < unique.length; i += 5) {
        await Promise.all(unique.slice(i, i + 5).map(async (id) => { apps[id] = { appinfo: await appInfo(id) }; }));
      }
      return { apps };
    },
    async getContentServers() {
      return { servers: cdnHosts.map((host) => typeof host === 'string' ? { host, https_support: 'optional' } : host) };
    },
  };
}

function manifestOf(entry) {
  const m = entry && entry.manifests && entry.manifests[BRANCH];
  if (!m) return null;
  if (typeof m === 'object') return { id: String(m.gid || ''), size: Number(m.size) || 0, download: Number(m.download) || 0 };
  return { id: String(m), size: 0, download: 0 };
}

/**
 * The depots of an app that have a manifest on the public branch, shared
 * ones (depotfromapp) resolved through the app that owns them, with the
 * DLC list. `skip` holds depots nobody wants packaged (the redistributables
 * zipProcessor drops anyway).
 */
async function readDepots(client, appid, { skip = new Set() } = {}) {
  const productInfo = (ids) => client.getProductInfo(ids);
  const { apps } = await productInfo([Number(appid)]);
  const appinfo = apps && apps[appid] && apps[appid].appinfo;
  if (!appinfo || !appinfo.common) throw new Error(`The metadata endpoint has no usable record for app ${appid}.`);
  const name = String(appinfo.common.name || `App ${appid}`);
  const dlcs = new Map();
  for (const id of String((appinfo.extended && appinfo.extended.listofdlc) || '').split(',').map((s) => s.trim())) {
    if (/^\d{1,10}$/.test(id)) dlcs.set(id, '');
  }
  const depots = [];
  const shared = [];
  for (const [id, depot] of Object.entries(appinfo.depots || {})) {
    if (!/^\d{1,10}$/.test(id) || !depot || typeof depot !== 'object') continue;
    const dlcApp = String(depot.dlcappid || '');
    if (/^\d{1,10}$/.test(dlcApp) && !dlcs.get(dlcApp)) dlcs.set(dlcApp, String(depot.name || ''));
    if (skip.has(id)) continue;
    const fromApp = String(depot.depotfromapp || '');
    if (/^\d{1,10}$/.test(fromApp) && fromApp !== String(appid)) {
      shared.push({ id, fromApp, name: String(depot.name || ''), oslist: String((depot.config && depot.config.oslist) || '') });
      continue;
    }
    const m = manifestOf(depot);
    if (!m || !/^\d+$/.test(m.id)) continue;
    depots.push({ id, manifestId: m.id, size: m.size, download: m.download, name: String(depot.name || ''), oslist: String((depot.config && depot.config.oslist) || ''), app: String(appid), shared: false });
  }
  const parents = [...new Set(shared.map((s) => s.fromApp))];
  if (parents.length) {
    const { apps: parentApps } = await productInfo(parents.map(Number));
    for (const s of shared) {
      const parent = parentApps && parentApps[s.fromApp] && parentApps[s.fromApp].appinfo;
      const entry = parent && parent.depots && parent.depots[s.id];
      const m = manifestOf(entry);
      if (!m || !/^\d+$/.test(m.id)) continue;
      depots.push({ id: s.id, manifestId: m.id, size: m.size, download: m.download, name: s.name || String(entry.name || ''), oslist: s.oslist || String((entry.config && entry.config.oslist) || ''), app: s.fromApp, shared: true });
    }
  }
  const branches = appinfo.depots && appinfo.depots.branches;
  const buildid = String((branches && branches[BRANCH] && branches[BRANCH].buildid) || '');
  return { appid: String(appid), name, buildid, depots, dlcs: [...dlcs].map(([id, dlcName]) => ({ id, name: dlcName })) };
}

// ── The Lua ─────────────────────────────────────────────────────

function oneLine(text) {
  return String(text || '').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Morrenus/Hubcap style. The first addappid names the app (its comment is
 * the game's name), a keyed addappid plus setManifestid per depot (its
 * comment "Depot N", which zipProcessor swaps for Steam's depot name), a
 * bare addappid per DLC. Depots left out are named in comments that never
 * contain "addappid(".
 */
function buildLua({ appid, name, buildid = '', depots = [], dlcs = [], leftOut = [], createdAt = new Date() }) {
  const lines = [
    `-- ${appid}'s Lua and Manifest assembled by Librarian from Steam (steammanifest)`,
    `-- ${oneLine(name)}`,
    `-- Created: ${createdAt.toISOString()}`,
  ];
  if (buildid) lines.push(`-- Build: ${buildid}`);
  lines.push(`-- Total Depots: ${depots.length}`, `-- Total DLCs: ${dlcs.length}`, '', '-- MAIN APPLICATION', `addappid(${appid}) -- ${oneLine(name) || `App ${appid}`}`);
  if (dlcs.length) {
    lines.push('-- DLC');
    for (const d of dlcs) lines.push(`addappid(${d.id}) -- ${oneLine(d.name) || `DLC ${d.id}`}`);
  }
  const push = (d) => {
    lines.push(`addappid(${d.id}, 1, "${d.key}") -- Depot ${d.id}`);
    lines.push(`setManifestid(${d.id}, "${d.manifestId}", ${Number(d.size) || Number(d.download) || 0})`);
  };
  const main = depots.filter((d) => !d.shared);
  const shared = depots.filter((d) => d.shared);
  if (main.length) { lines.push('-- MAIN APP DEPOTS'); main.forEach(push); }
  if (shared.length) { lines.push('-- SHARED DEPOTS'); shared.forEach(push); }
  if (leftOut.length) {
    lines.push('-- DEPOTS LEFT OUT');
    for (const d of leftOut) lines.push(`-- depot ${d.id}: ${oneLine(d.reason).replace(/addappid\(/gi, 'addappid ')}`);
  }
  return lines.join('\n') + '\n';
}

// ── Acquiring one manifest ──────────────────────────────────────

/**
 * Hubcap's copy when it is the same manifest; otherwise the configured
 * request-code endpoints, in order. Every copy is decoded and its IDs compared
 * with what was asked for before it is accepted.
 */
async function acquireManifest(mods, client, depot, opts = {}) {
  const { appid, prior, mirror } = opts;
  const check = (data, source) => {
    const parsed = mods.manifest.parseManifest(data);
    if (String(parsed.depot_id) !== String(depot.id) || String(parsed.gid_manifest) !== String(depot.manifestId)) {
      throw new Error(`${source} returned manifest ${parsed.gid_manifest} of depot ${parsed.depot_id}, not ${depot.manifestId} of ${depot.id}`);
    }
    return data;
  };
  const errors = [];
  if (prior) {
    try { return { data: check(prior, 'the Hubcap package'), source: 'hubcap', host: 'hubcap' }; }
    catch (err) { errors.push(err.message); }
  }
  const apps = depot.shared && depot.app !== String(appid) ? [String(appid), depot.app] : [String(appid)];
  // The mirror (20770407.xyz and compatibles) does not serve manifest bytes —
  // it issues a Steam manifest *request code*, which works for a depot the
  // anonymous session was refused one for. The bytes still come from the
  // Steam CDN, fetched with that code.
  const endpoints = mirrorEndpoints(mirror, opts.mirrorFallbacks);
  // Only now that the mirror is actually needed is the proxy pool resolved.
  const proxies = typeof opts.getProxies === 'function'
    ? await opts.getProxies()
    : (Array.isArray(opts.proxies) ? opts.proxies : mirrorProxies());
  for (const [index, endpoint] of endpoints.entries()) {
    if (index) opts.onLog?.(`🔁 Trying the backup manifest API: ${endpoint}.`);
    for (const app of apps) {
      let code;
      try {
        code = await requestCodeFromMirror(mods, endpoint, app, depot.id, depot.manifestId, { proxies, onLog: opts.onLog });
      } catch (err) {
        errors.push(`mirror ${endpoint} (app ${app}): ${err.message}`);
        continue;
      }
      try {
        const { data, host } = await cdnFetchWithCode(mods, client, app, depot.id, depot.manifestId, code);
        return { data: check(data, 'the Steam CDN via the mirror code'), source: 'mirror', host };
      } catch (err) {
        errors.push(`Steam CDN with the mirror's code (app ${app}): ${err.message}`);
      }
    }
  }
  throw new Error(errors.join('; ') || 'No configured endpoint supplied this manifest');
}

/** The proxy pool for the mirror, from the setting: valid http(s) proxy URLs. */
function mirrorProxies(override) {
  const raw = String(override ?? settingGet('manifest_mirror_proxies') ?? '');
  const out = [];
  for (const token of raw.split(/[\s,]+/)) {
    const p = token.trim();
    if (!p) continue;
    try { if (/^https?:$/.test(new URL(p).protocol)) out.push(p); } catch { /* not a URL */ }
  }
  return out;
}

/**
 * The proxy pool for one assemble: an explicit array (tests) verbatim, then
 * proxies the user pinned in Settings, then — only for a real run (autoSource)
 * with none pinned — a live pool auto-sourced and probed from the configured
 * list (src/core/manifestProxies.js). Never throws.
 */
async function resolveMirrorPool({ proxies, autoSource = false, userData, onLog } = {}) {
  if (Array.isArray(proxies)) return proxies;
  const pinned = mirrorProxies();
  if (pinned.length) return pinned;
  if (!autoSource) return [];
  try { return await require('./manifestProxies').resolvePool({ userData, onLog }); }
  catch { return []; }
}

/** An agent that tunnels through one http(s) proxy, or null if unusable. */
function proxyAgent(proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null; // SOCKS unsupported
    const { HttpsProxyAgent } = require('https-proxy-agent'); // the mirror is https
    return new HttpsProxyAgent(proxyUrl);
  } catch {
    return null;
  }
}

/** A proxy URL with its credentials masked, for logs. */
function redactProxy(p) { return p.replace(/\/\/[^/@]*@/, '//***@'); }

/**
 * Ask the mirror for a Steam manifest request code. The route returns the code
 * as a bare uint64 in plain text; anything else is refused rather than treated
 * as one. The mirror rate-limits per IP, so this insists a little: it tries
 * the direct connection and then each proxy in the pool, over a couple of
 * rounds with backoff, until one returns a code. A 200 that is not a code is a
 * hard refusal (the mirror answered; the pair is not available), not retried.
 */
async function requestCodeFromMirror(mods, endpoint, appid, depotId, manifestId, options = {}) {
  const url = `${endpoint.replace(/\/+$/, '')}/manifest/${encodeURIComponent(depotId)}/${encodeURIComponent(manifestId)}?appid=${encodeURIComponent(appid)}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Librarian/1.0',
    Accept: 'text/plain, */*',
    Referer: `${new URL(endpoint).origin}/`,
  };
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
  const backoffMs = Number.isFinite(options.backoffMs) ? options.backoffMs : 500;
  const rounds = Math.max(1, options.rounds || 2);
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};

  const targets = [{ label: 'direct', agent: null }];
  for (const p of options.proxies || []) {
    const agent = proxyAgent(p);
    if (agent) targets.push({ label: `proxy ${redactProxy(p)}`, agent });
    else onLog(`⚠ Ignoring an unusable manifest proxy (${redactProxy(p)}); only http(s) proxies are supported.`);
  }

  const errors = [];
  for (let round = 0; round < rounds; round++) {
    for (const target of targets) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, { headers, agent: target.agent || undefined, signal: controller.signal, redirect: 'follow' });
        const text = (await res.text()).trim();
        if (res.status === 200 && /^\d{1,20}$/.test(text)) {
          if (target.label !== 'direct') onLog(`🔁 Request code obtained via ${target.label}.`);
          return text;
        }
        if (res.status === 200) throw Object.assign(new Error(`response was not a request code: ${JSON.stringify(text.slice(0, 60))}`), { fatal: true });
        errors.push(`${target.label}: HTTP ${res.status}`);
      } catch (err) {
        if (err.fatal) throw err; // the mirror answered; do not insist
        errors.push(`${target.label}: ${err.message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    if (round + 1 < rounds) await new Promise((r) => setTimeout(r, backoffMs * (round + 1)));
  }
  throw new Error(errors.join('; ') || 'no code');
}

/**
 * Download a depot manifest from the Steam CDN with a request code obtained
 * elsewhere. The CDN checks the code, not ownership, so a mirror-issued code
 * for a paid depot works here. The endpoint adapter supplies public CDN
 * hosts without making a Steam session or directory request.
 */
async function cdnFetchWithCode(mods, client, appid, depotId, manifestId, code) {
  let servers = [];
  try {
    const list = await client.getContentServers(Number(appid));
    servers = (list.servers || []).slice(0, CDN_ATTEMPTS);
  } catch { /* fall back to a public edge below */ }
  const hosts = servers.length
    ? servers.map((s) => ({ host: s.vhost || s.Host || s.host, https: s.https_support === 'mandatory' || s.https_support === 'optional' }))
    : FALLBACK_CDN_HOSTS.map((host) => ({ host, https: false }));
  let lastError;
  for (const { host, https } of hosts) {
    if (!host) continue;
    const url = `${https ? 'https' : 'http'}://${host}/depot/${depotId}/manifest/${manifestId}/5/${code}`;
    try {
      const res = await mods.http.httpGet(url, { headers: { 'User-Agent': 'Valve/Steam HTTP Client 1.0' }, timeoutMs: 30000 });
      if (res.status !== 200) throw new Error(`HTTP ${res.status} from ${host}`);
      return { data: mods.manifest.decompress(res.body).data, host };
    } catch (err) { lastError = err; }
  }
  throw new Error(`no CDN edge served the manifest${lastError ? `: ${lastError.message}` : ''}`);
}

// ── Assembling a package ────────────────────────────────────────

function collectKeys(dir, options = {}) {
  return {
    ...depotKeys.collect({
      userData: options.userData,
      steamPath: options.steamPath ?? steamPathQuiet(),
      files: [path.join(dir, KEY_FILE), ...(Array.isArray(options.keyFiles) ? options.keyFiles : [])],
    }),
    ...depotKeys.clean(options.keys),
  };
}

/**
 * A best-effort resolver for app PICS access tokens from the catalog, used when
 * an app withholds its metadata from an anonymous session. `false` or an
 * explicit override disables it; failures resolve to no tokens.
 */
function tokenResolver(options = {}) {
  if (options.appTokens === false || options.resolveTokens === false) return async () => ({});
  if (typeof options.resolveTokens === 'function') return options.resolveTokens;
  return async (ids) => {
    try { return await require('./steamCatalog').lookupAppTokens(ids, { userData: options.userData }); }
    catch { return {}; }
  };
}

/** The same, for depot decryption keys; passed to assemble as resolveCatalogKeys. */
function keyResolver(options = {}) {
  if (options.depotKeyCatalog === false || options.resolveCatalogKeys === false) return null;
  if (typeof options.resolveCatalogKeys === 'function') return options.resolveCatalogKeys;
  return async (ids) => {
    try { return await require('./steamCatalog').lookupDepotKeys(ids, { userData: options.userData }); }
    catch { return {}; }
  };
}

function keyMessage(name, count) {
  return `There is no key for ${count} depot${count === 1 ? '' : 's'} of ${name} in the configured catalog or local sources. `
    + 'Keys come from a Hubcap package of this game, from the Steam client of an account that owns it (its config.vdf), from steammanifest\'s depot_keys.json, or from the depot-key catalog in Settings.';
}

/**
 * The work: the depots from PICS (or `info` when the caller has read it),
 * a key for each — XYZ first, then saved/package keys — then a manifest for each with
 * a key. Depots missing either are left out and said so.
 */
async function assemble(mods, client, { appid, info, keys = {}, prior = {}, mirror = '', mirrorFallbacks, proxies, autoSource = false, onLog = () => {}, deadline = 0, userData, resolveCatalogKeys = null, resolveTokens, appTokens }) {
  // The proxy pool is resolved lazily and once: a free game never reaches the
  // mirror, so it should never pay for fetching or probing proxies.
  let poolPromise = null;
  const getProxies = () => (poolPromise ||= resolveMirrorPool({ proxies, autoSource, userData, onLog }));
  const { DEPOT_BLACKLIST } = require('./zipProcessor');
  const current = info || await readDepots(client, appid, { skip: DEPOT_BLACKLIST });
  onLog(`🔎 Public metadata lists ${current.depots.length} depot(s) for ${current.name} (${appid})${current.buildid ? `, build ${current.buildid}` : ''}.`);
  const { keys: known, catalogIds } = await depotKeys.preferCatalog(current.depots.map((d) => d.id), keys, { resolveCatalogKeys, userData });
  if (catalogIds.length) {
    depotKeys.remember(Object.fromEntries(catalogIds.map((id) => [id, known[id]])), userData);
    onLog(`🔑 Depot-key catalog supplied ${catalogIds.length} key(s); other sources will fill any gaps.`);
  }
  const packaged = [];
  const leftOut = [];
  const manifests = {};
  const counts = { hubcap: 0, steam: 0, mirror: 0 };
  for (const depot of current.depots) {
    if (deadline && Date.now() > deadline) throw new Error('assembling the package took too long; try again');
    if (!known[depot.id]) {
      leftOut.push({ id: depot.id, name: depot.name, reason: NO_KEY });
      continue;
    }
    const before = prior[depot.id];
    try {
      const got = await acquireManifest(mods, client, depot, {
        appid,
        prior: before && before.manifestId === depot.manifestId ? before.data : null,
        mirror,
        mirrorFallbacks,
        getProxies,
        onLog,
      });
      manifests[`${depot.id}_${depot.manifestId}.manifest`] = got.data;
      counts[got.source]++;
      const how = got.source === 'hubcap' ? 'unchanged, kept from the Hubcap package'
        : got.source === 'steam' ? `from the Steam CDN (${got.host})`
          : `from the mirror (${got.host})`;
      onLog(`📄 Depot ${depot.id}${depot.name ? ` (${depot.name})` : ''}: manifest ${depot.manifestId} ${how}.`);
      packaged.push({ ...depot, key: known[depot.id] });
    } catch (err) {
      leftOut.push({ id: depot.id, name: depot.name, reason: `${NO_MANIFEST}: ${err.message}` });
      onLog(`⚠ Depot ${depot.id}: no manifest — ${err.message}`);
    }
  }
  return { info: current, packaged, leftOut, manifests, counts, keys: known };
}

function packageDir(userData) {
  const base = userData || electronUserData();
  if (!base) throw new Error('no user data directory');
  const dir = path.join(base, MANIFEST_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The package on disk, in Hubcap's folder and naming, checked the way a Hubcap download is. */
async function writePackage(appid, result, userData) {
  if (!result.packaged.length) {
    const noKey = result.leftOut.filter((d) => d.reason === NO_KEY);
    if (noKey.length === result.leftOut.length && noKey.length) throw new Error(keyMessage(result.info.name, noKey.length));
    const reasons = result.leftOut.map((d) => `${d.id}: ${d.reason}`).join('; ');
    throw new Error(`no depot of ${result.info.name} could be packaged — ${reasons || 'Steam lists no depot with a manifest'}`);
  }
  const lua = buildLua({ appid, name: result.info.name, buildid: result.info.buildid, depots: result.packaged, dlcs: result.info.dlcs, leftOut: result.leftOut });
  const file = path.join(packageDir(userData), `librarian_fetch_${appid}_${randomUUID()}.zip`);
  const entries = [{ name: `${appid}.lua`, data: lua }, ...Object.entries(result.manifests).map(([name, data]) => ({ name, data }))];
  fs.writeFileSync(file, buildZip(entries), { flag: 'wx' });
  try {
    await require('./zipProcessor').inspectArchiveAppId(file, appid);
  } catch (err) {
    try { fs.unlinkSync(file); } catch { /* nothing to keep */ }
    throw err;
  }
  return file;
}

function describe(result) {
  const parts = [];
  if (result.counts.steam) parts.push(`${result.counts.steam} from Steam`);
  if (result.counts.mirror) parts.push(`${result.counts.mirror} from the mirror`);
  if (result.counts.hubcap) parts.push(`${result.counts.hubcap} kept from Hubcap`);
  const out = `${result.packaged.length} depot${result.packaged.length === 1 ? '' : 's'} (${parts.join(', ')})`;
  const left = result.leftOut.length ? `; ${result.leftOut.length} left out (${result.leftOut.map((d) => `${d.id}: ${d.reason.split(':')[0]}`).join(', ')})` : '';
  return out + left;
}

/**
 * The package, from Steam. Same contract as hubcapApi.downloadManifest:
 * { filepath, appid, error }, plus what was done for the log.
 */
async function downloadManifest(appId, options = {}) {
  const appid = normalizeAppId(appId);
  if (!appid) return { filepath: null, error: 'Invalid AppID.' };
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const where = resolveDir(options);
  if (where.missing) return { filepath: null, error: `steammanifest not found at ${where.dir}. Set its folder in Settings, or restore deps/steammanifest.` };
  let mods;
  try { mods = load(where.dir); }
  catch (err) { return { filepath: null, error: `steammanifest could not be loaded: ${err.message}` }; }

  const client = options.client || createEndpointClient(options);
  try {
    onLog('🔎 Reading public metadata; using configured endpoints for manifests and keys…');
    const result = await assemble(mods, client, {
      appid,
      keys: collectKeys(where.dir, options),
      prior: options.prior || {},
      mirror: mirrorEndpoint(options.mirror),
      mirrorFallbacks: options.mirrorFallbacks,
      onLog,
      deadline: Date.now() + BUDGET_MS,
      userData: options.userData,
      resolveCatalogKeys: keyResolver(options),
      proxies: options.proxies,
      autoSource: !options.client,
      resolveTokens: options.resolveTokens,
      appTokens: options.appTokens,
    });
    const filepath = await writePackage(appid, result, options.userData);
    return {
      filepath, appid, error: null, source: 'steammanifest',
      note: `assembled from Steam: ${describe(result)}`,
      name: result.info.name, buildid: result.info.buildid,
      depots: result.packaged.length, leftOut: result.leftOut, counts: result.counts,
    };
  } catch (err) {
    return { filepath: null, error: `steammanifest: ${err.message}` };
  }
}

/**
 * Hubcap's package against Steam. Reads the package, keeps its keys, asks
 * PICS for the current manifests, compares depot by depot. Current: says so.
 * Behind: assembles the latest, reusing Hubcap's copies of the unchanged
 * manifests and Hubcap's keys; a fresh package is returned only when every
 * depot that was behind got its new manifest, so a stale-but-complete
 * package is never replaced by a fresh-but-partial one.
 *
 * { checked, stale, behind, filepath, error, compared, buildid, note }
 */
async function refresh(appId, zipPath, options = {}) {
  const appid = normalizeAppId(appId);
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const out = { checked: false, stale: false, behind: [], filepath: null, error: '', compared: 0, buildid: '', note: '' };
  if (!appid) return { ...out, error: 'Invalid AppID.' };
  const where = resolveDir(options);
  if (where.missing) return { ...out, error: `steammanifest not found at ${where.dir}` };
  let mods;
  try { mods = load(where.dir); }
  catch (err) { return { ...out, error: `steammanifest could not be loaded: ${err.message}` }; }

  let archive;
  try { archive = await require('./zipProcessor').readGameArchive(zipPath, appid); }
  catch (err) { return { ...out, error: `Hubcap's package could not be read: ${err.message}` }; }
  const hubKeys = depotKeys.clean(archive.gameData.depots);
  depotKeys.remember(hubKeys, options.userData);
  const have = archive.gameData.manifests || {};

  const client = options.client || createEndpointClient(options);
  try {
    onLog('🔎 Checking Hubcap\'s package against the public metadata endpoint…');
    const { DEPOT_BLACKLIST } = require('./zipProcessor');
    const info = await readDepots(client, appid, { skip: DEPOT_BLACKLIST });
    out.buildid = info.buildid;
    const behind = [];
    const compared = [];
    let current = 0;
    for (const d of info.depots) {
      if (!have[d.id]) continue;
      compared.push(d.id);
      if (have[d.id] === d.manifestId) current++;
      else behind.push({ id: d.id, name: d.name, have: have[d.id], latest: d.manifestId });
    }
    out.compared = current + behind.length;
    if (!out.compared) {
      onLog('ℹ Hubcap\'s package lists none of the depots Steam lists for this app, so it cannot be checked.');
      return { ...out, checked: false };
    }
    out.stale = behind.length > 0;
    out.behind = behind;
    // PICS can omit depots (including shared depots that need an access
    // token). The intersection is not proof that the entire archive is
    // current, and must not become permission to discard the rest.
    const required = [...new Set([...Object.keys(have), ...Object.keys(archive.gameData.depots || {})])]
      .filter((id) => !DEPOT_BLACKLIST.has(id));
    const unverified = required.filter((id) => !compared.includes(id));
    if (unverified.length) {
      out.error = `Steam did not provide comparable public manifests for depot(s) ${unverified.join(', ')}; keeping the complete Hubcap package`;
      onLog(`⚠ ${out.error}.`);
      return out;
    }
    out.checked = true;
    if (!behind.length) {
      out.note = `Hubcap's package is current: ${current} depot${current === 1 ? '' : 's'} at Steam's latest manifest${current === 1 ? '' : 's'}${info.buildid ? ` (build ${info.buildid})` : ''}`;
      onLog(`✅ ${out.note}.`);
      return out;
    }
    out.stale = true;
    out.behind = behind;
    onLog(`⏫ Hubcap's package is behind Steam on ${behind.length} of ${out.compared} depot(s): ${behind.map((b) => `${b.id} ${b.have} → ${b.latest}`).join(', ')}. Assembling the latest…`);

    const prior = {};
    for (const [name, data] of Object.entries(archive.manifestFiles || {})) {
      const m = /^(\d+)_(\d+)\.manifest$/.exec(name);
      if (m) prior[m[1]] = { manifestId: m[2], data };
    }
    const result = await assemble(mods, client, {
      appid, info,
      keys: { ...collectKeys(where.dir, options), ...hubKeys },
      prior,
      mirror: mirrorEndpoint(options.mirror),
      mirrorFallbacks: options.mirrorFallbacks,
      onLog,
      deadline: Date.now() + BUDGET_MS,
      userData: options.userData,
      resolveCatalogKeys: keyResolver(options),
      proxies: options.proxies,
      autoSource: !options.client,
      resolveTokens: options.resolveTokens,
      appTokens: options.appTokens,
    });
    // The replacement has to cover everything Hubcap's package covered, not
    // merely the depots that were behind. A depot that was already current
    // can still fail to be re-packaged — its copy in the archive may be
    // unreadable and every source down — and a package missing a depot the
    // game needs is worse than an old one that has it.
    const missing = required.filter((id) => !result.packaged.some((d) => d.id === id));
    if (missing.length) {
      const stillBehind = missing.filter((id) => behind.some((b) => b.id === id));
      out.error = stillBehind.length === missing.length
        ? `the latest manifest of depot${missing.length === 1 ? '' : 's'} ${missing.join(', ')} is not available yet from Steam or the mirror`
        : `depot${missing.length === 1 ? '' : 's'} ${missing.join(', ')} could not be re-packaged, and a package missing ${missing.length === 1 ? 'it' : 'them'} would be worse than the older one`;
      onLog(`⚠ ${out.error}; keeping Hubcap's package.`);
      return out;
    }
    out.filepath = await writePackage(appid, result, options.userData);
    out.note = `assembled from Steam — Hubcap was behind on ${behind.length} of ${out.compared} depot${out.compared === 1 ? '' : 's'}: ${describe(result)}`;
    return out;
  } catch (err) {
    out.error = err.message;
    return out;
  }
}

module.exports = {
  MANIFEST_DIR,
  DEFAULT_MIRROR,
  BACKUP_MIRROR,
  KEY_FILE,
  NO_KEY,
  NO_MANIFEST,
  normalizeAppId,
  resolveDir,
  isCheckout,
  load,
  status,
  sourceOrder,
  mirrorEndpoint,
  mirrorEndpoints,
  searchGames,
  unionResults,
  readDepots,
  createEndpointClient,
  buildLua,
  acquireManifest,
  requestCodeFromMirror,
  mirrorProxies,
  proxyAgent,
  resolveMirrorPool,
  cdnFetchWithCode,
  tokenResolver,
  keyResolver,
  catalogStatus,
  assemble,
  writePackage,
  downloadManifest,
  refresh,
};
