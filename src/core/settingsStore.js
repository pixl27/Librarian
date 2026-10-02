const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const json = require('./jsonFile');
const SECRET_KEYS = new Set(['steam_password', 'csrin_password', 'hubcap_api_key', 'steam_web_api_key']);

const DEFAULTS = {
  accent_color: '#7C8CFF',
  background_color: '#10131F',
  launch_mode: 'exe',
  reduce_motion: false,
  slssteam_mode: true,
  library_mode: false,
  generate_achievements: true,
  use_steamless: false,
  auto_crack: true,
  download_max_downloads: 16,
  download_adaptive: true,
  online_player_name: '',
  online_steam_overlay: true,
  // Valheim and PEAK are set up for co-op the first time they are downloaded
  // or launched: online mode, plus PEAK's join-a-friend plugin. Once per
  // install, never over a choice already made. See src/core/gamePresets.js.
  game_presets: true,
  validate_fresh_downloads: false,
  steam_cell_id: '',
  // Look for a content cache on the local network (lancache.steamcontent.com,
  // the name Valve publishes for it) and prefer it over the CDN. On by
  // default, as it is in Steam: it only engages when the name resolves to a
  // private address, so a machine without one pays a single DNS lookup.
  use_lancache: true,
  // Megabytes per second, 0 for unlimited. A download that saturates the link
  // makes everything else on it unusable, which is why Steam has had this
  // setting for years.
  download_speed_limit: 0,
  // The native SteamPipe engine is the default; DepotDownloader remains available
  // as a fallback. See applyMigrations() for how existing installs are moved over.
  // Bumped by applyMigrations when a stored settings file needs reshaping.
  settings_version: 0,
  hubcap_api_key: '',
  // ─── Manifest source ──────────────────────────────────────────
  // Where a manifest package comes from: Hubcap (needs the key above), the
  // steammanifest decoder vendored under deps/steammanifest (public metadata
  // and configured relay endpoints), or Auto: Hubcap when a key
  // is set, its package checked against Steam's current manifests and
  // re-assembled from Steam when a depot is behind; the local source alone
  // when there is no key or Hubcap fails. The folder points at a checkout
  // instead of the vendored copy; empty means the vendored copy. The mirror
  // issues a Steam manifest request code; no direct Steam session is attempted.
  // The manifest itself is still downloaded from
  // the Steam CDN with that code. Empty uses 20770407.xyz/enone first,
  // then the original 20770407.xyz relay as backup.
  manifest_source: 'auto',
  steammanifest_dir: '',
  steammanifest_mirror: '',
  // The request-code mirror rate-limits per IP (a 401 once it has seen enough
  // requests from one address). A pool of HTTP/HTTPS proxies is rotated
  // through so a refusal on one address retries from another; empty means
  // direct only. Comma- or newline-separated http(s) proxy URLs
  // (http://user:pass@host:port). SOCKS is not supported.
  manifest_mirror_proxies: '',
  // When no proxy is pinned above, a live pool is drawn from this public,
  // GitHub-published proxy list (proxifly, over the jsDelivr CDN), ranked and
  // probed so the few that actually respond are used and refreshed each
  // session — free proxies die fast, so a fixed list would not do. Clearing
  // this turns auto-sourcing off, leaving the mirror to be tried directly.
  // See src/core/manifestProxies.js.
  manifest_proxy_source: 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.json',
  // ─── Depot-key and app-token catalogs ─────────────────────────
  // Public flat-JSON catalogs of the two things an anonymous session lacks for
  // a paid game (see src/core/steamCatalog.js): each depot's decryption key,
  // and each app's PICS access token (without which its depot list cannot be
  // read). The key catalog is consulted first, including for imported Lua;
  // saved/package keys fill missing entries. Each is a URL; clear
  // it to switch that catalog off.
  depot_key_catalog: 'https://api.993499094.xyz/depotkeys.json',
  app_token_catalog: 'https://api.993499094.xyz/appaccesstokens.json',
  // Steam's own Web API key, only used to look up achievement schemas. The
  // keyless routes that once existed are gone: Xan105's public API no longer
  // resolves, and GetGlobalAchievementPercentagesForApp now answers anonymous
  // callers with an empty document.
  // Shared API default for this portable build; saved overrides can still clear it.
  steam_web_api_key: "BC0D238CD293C0FD3FA6CB99F31407F3",
  steam_username: '',
  steam_password: '',
  // The Steam folder the registry last gave. A launch on which reg.exe
  // cannot be asked (a portable build with a bare PATH, a busy machine)
  // falls back to it, instead of scanning no library at all.
  steam_path: '',

  // ─── CS.RIN.RU ────────────────────────────────────────────────
  // A second source beside Hubcap; see src/core/csrin.js. The forum hides
  // download links from guests, so without an account a search finds the
  // post but not the file. The author is who to look for in a topic — the
  // default is the one that posts Denuvo releases.
  csrin_username: '',
  csrin_password: '',
  csrin_author: 'ARTIFACT',
  // Where the archive lands; empty means the Downloads folder. Whether a
  // Denuvo title then gets its release placed over the install follows
  // auto_crack above — this is part of that feature, not a second switch.
  csrin_download_dir: '',

  // ─── What's new ───────────────────────────────────────────────
  // Denuvo titles arriving on Steam and the followed member's posts on
  // CS.RIN.RU (src/core/newsFeed.js). Seen ids keep the dialog from
  // repeating itself; it shows at launch only when there is something new.
  news_enabled: true,
  news_seen: [],
  news_checked_at: 0,
  font_family: 'Fredoka',
  font_size: 13,
  favorites: [],
  update_results: {},
  update_checked_at: 0,

  // ─── Achievements ─────────────────────────────────────────────
  // Read from the offline emulator's save file; see src/core/achievements.js.
  achievement_popups: true,
  // Height of the in-game toast as a share of the frame. 0.15 is roughly a
  // seventh of the screen, which reads at couch distance without covering play.
  achievement_popup_scale: 0.15,

  // ─── Emulator compatibility ───────────────────────────────────
  // Before the emulator is placed, its library is compared with the game's
  // own (src/core/emuCompat.js). When interfaces are missing and a newer
  // gbe_fork release exists, it is fetched first; this switch governs that.
  emu_auto_update: true,
  // The newest release as GitHub last described it, kept for a day so the
  // check is one request per day, not one per download.
  emu_release_cache: {},

  // ─── Tuning ───────────────────────────────────────────────────
  // The in-game and launch-time performance profile; see src/core/tuning.js.
  // `enabled` is the master switch: off, nothing is written for the game and
  // nothing is injected for tuning's sake. The other fields only matter once
  // it is on. A per-game override lives in the game meta store. The profile
  // below is the one the installer build ships with — the owner's own — so a
  // friend who switches tuning on starts from it.
  tuning: {
    enabled: false,
    queue: 'auto',       // 'auto' (just in time) | 'off' | 'one' (one frame in flight) | 'ultra' (none)
    limiter: false,
    fps: 0,              // 0 = the display's refresh rate minus 3
    affinity: 'auto',    // 'auto' (topology says) | 'off'
    priority: true,      // raise the game's priority class while playing
    refresh: true,       // switch the display to its highest rate while playing
    power: true,         // switch to the High performance plan while playing
  },

  // ─── Interface / experience ───────────────────────────────────
  ui_sounds: false,
  ui_sound_volume: 0.35,
  ui_tilt: true,
  // The kinetic motion layer (src/styles/kinetic.css + src/js/kinetic.js).
  // Read everywhere as `!== false`, so an existing settings file written
  // before this key existed still gets the animations without a migration.
  ui_kinetic: true,
  dynamic_accent: true,
  gamepad_nav: true,
  hero_rotate: true,
  notify_on_complete: true,
  grid_density: 'cozy',
  library_view_mode: 'grid',

  // ─── Big Picture ──────────────────────────────────────────────
  // The couch/controller front-end (src/js/bigpicture.js). Defaults mirror the
  // Playnite "Modern UI" theme it is modelled on: horizontal shelf, teal
  // accent, wordmark logos and rounded covers on.
  bigpicture_layout: 'horizontal',
  bigpicture_fullscreen: true,
  bigpicture_logos: true,
  bigpicture_rounded: true,
  bigpicture_sounds: true,
  bigpicture_trailers: true,
  // The shelf background video, separate from the details-view trailer: it
  // plays unprompted while browsing, so it needs its own switch.
  bigpicture_trailer_bg: true,
  // The shelf background video, separate from the details-view trailer: it
  // plays unprompted while browsing, so it needs its own switch.
  bigpicture_trailer_bg: true,
  bigpicture_accent: '#17C8B6',
  // Big Picture is fullscreen, so it sits in front of whatever it just
  // launched. Step aside on Play and come back when the game exits.
  bigpicture_minimize_on_play: true,

  library_sort: 'name',
  collections: {},
  recent_searches: [],
  onboarded: false,

  // ─── Install destinations ─────────────────────────────────────
  // Extra folders (beyond detected Steam libraries) the user can install into,
  // the one used by default, and whether to prompt on every download.
  install_locations: [],
  default_install_path: '',
  ask_install_location: true,

  // ─── Window state (restored on next launch) ───────────────────
  window_bounds: {},
  window_maximized: false,
};

const ENUMS = {
  manifest_source: ['auto', 'hubcap', 'steammanifest'],
  bigpicture_layout: ['horizontal', 'grid'],
  grid_density: ['compact', 'cozy', 'large'],
  library_view_mode: ['grid', 'list'],
  library_sort: ['name', 'recent', 'playtime', 'size', 'added'],
  launch_mode: ['exe', 'steam', 'greenluma'],
};

let _data = null;
let _filePath = null;

function normalizeHex(hex, fallback) {
  if (typeof hex !== 'string') return fallback;
  const raw = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw.split('').map(ch => ch + ch).join('').toUpperCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toUpperCase()}`;
  return fallback;
}

function cleanTokenList(value, { max = 500, maxLength = 260 } = {}) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const cleaned = [];
  for (const entry of value) {
    const token = String(entry ?? '').trim().slice(0, maxLength);
    if (token && !seen.has(token)) {
      seen.add(token);
      cleaned.push(token);
    }
    if (cleaned.length >= max) break;
  }
  return cleaned;
}

function coerceValue(key, value) {
  const defaultValue = DEFAULTS[key];

  if (ENUMS[key]) {
    const raw = String(value ?? '').trim();
    return ENUMS[key].includes(raw) ? raw : defaultValue;
  }

  // { "Collection name": ["steam:570", "custom:ab12"] }
  if (key === 'collections') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out = {};
    let count = 0;
    for (const [name, members] of Object.entries(value)) {
      const label = String(name).trim().slice(0, 60);
      if (!label || count >= 60) continue;
      out[label] = cleanTokenList(members, { max: 2000 });
      count++;
    }
    return out;
  }

  if (key === 'recent_searches') {
    return cleanTokenList(value, { max: 12, maxLength: 80 });
  }

  if (key === 'install_locations') {
    return cleanTokenList(value, { max: 24, maxLength: 400 });
  }

  // Newest last; the oldest fall off the front once the list is full.
  if (key === 'news_seen') {
    const list = cleanTokenList(value, { max: 5000, maxLength: 80 });
    return list.slice(-800);
  }

  if (key === 'emu_release_cache') {
    const v = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
    const num = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0);
    return {
      at: num(v.at),
      publishedAt: num(v.publishedAt),
      tag: String(v.tag ?? '').slice(0, 80),
      name: String(v.name ?? '').slice(0, 120),
      url: String(v.url ?? '').slice(0, 300),
    };
  }

  if (key === 'tuning') {
    const d = DEFAULTS.tuning;
    const v = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
    const fps = Number(v.fps);
    return {
      enabled: Boolean(v.enabled),
      queue: ['auto', 'off', 'one', 'ultra'].includes(v.queue) ? v.queue : d.queue,
      limiter: v.limiter !== false,
      // 0 means "follow the display"; anything else is clamped to what a
      // display could plausibly show.
      fps: Number.isFinite(fps) && fps > 0 ? Math.max(20, Math.min(1000, Math.round(fps))) : 0,
      affinity: v.affinity === 'off' ? 'off' : 'auto',
      priority: Boolean(v.priority),
      refresh: v.refresh !== false,
      power: Boolean(v.power),
    };
  }

  if (key === 'window_bounds') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out = {};
    for (const axis of ['x', 'y', 'width', 'height']) {
      const numberValue = Math.round(Number(value[axis]));
      if (Number.isFinite(numberValue)) out[axis] = numberValue;
    }
    // A minimised window on Windows reports about -32000,-32000. Keeping that
    // would mean restoring the app somewhere no display can show it.
    if (Math.abs(out.x) > 10000 || Math.abs(out.y) > 10000) { delete out.x; delete out.y; }
    // Width/height are the only fields we insist on; a missing x/y just means "centre it".
    if (!Number.isFinite(out.width) || !Number.isFinite(out.height)) return {};
    out.width = Math.max(1024, Math.min(10000, out.width));
    out.height = Math.max(600, Math.min(10000, out.height));
    return out;
  }

  if (key === 'ui_sound_volume') {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) return defaultValue;
    return Math.max(0, Math.min(1, numberValue));
  }

  if (key === 'favorites') {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const cleaned = [];
    for (const entry of value) {
      const token = String(entry ?? '').trim().slice(0, 260);
      if (token && !seen.has(token)) {
        seen.add(token);
        cleaned.push(token);
      }
    }
    return cleaned;
  }
  if (key === 'update_results') {
    return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
  }
  if (key === 'online_steam_overlay') return value !== false;
  if (key === 'online_player_name') return String(value ?? '').trim().slice(0, 48);
  if (key === 'csrin_author') return String(value ?? '').trim().slice(0, 64) || defaultValue;
  if (key === 'csrin_username') return String(value ?? '').trim().slice(0, 64);
  if (key === 'csrin_download_dir') return String(value ?? '').trim().slice(0, 400);
  if (key === 'download_adaptive') return value !== false;
  if (key === 'use_lancache') return value !== false;
  if (key === 'download_max_downloads') {
    const numberValue = Math.round(Number(value));
    if (!Number.isFinite(numberValue)) return defaultValue;
    return Math.max(1, Math.min(32, numberValue));
  }
  if (key === 'download_speed_limit') {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || numberValue <= 0) return 0;
    // 10 GB/s is not a limit anyone means; it is a typo or a bad unit.
    return Math.min(10240, Math.round(numberValue * 100) / 100);
  }
  if (key === 'steam_cell_id') {
    const raw = String(value ?? '').trim();
    return /^\d{1,10}$/.test(raw) ? raw : '';
  }
  if (typeof defaultValue === 'boolean') return Boolean(value);
  if (typeof defaultValue === 'number') {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : defaultValue;
  }
  if (key === 'accent_color' || key === 'background_color' || key === 'bigpicture_accent') {
    return normalizeHex(value, defaultValue);
  }
  if (typeof defaultValue === 'string') {
    return typeof value === 'string' ? value : String(value ?? '');
  }
  return value;
}

function sanitizeSettings(raw = {}) {
  if ('morrenus_api_key' in raw && !('hubcap_api_key' in raw)) {
    raw.hubcap_api_key = raw.morrenus_api_key;
    delete raw.morrenus_api_key;
  }

  const data = { ...DEFAULTS };
  // Clone array/object defaults so callers never mutate the shared DEFAULTS.
  for (const [key, defaultValue] of Object.entries(DEFAULTS)) {
    if (Array.isArray(defaultValue)) data[key] = [...defaultValue];
    else if (defaultValue && typeof defaultValue === 'object') data[key] = { ...defaultValue };
  }
  for (const key of Object.keys(DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      data[key] = coerceValue(key, raw[key]);
    }
  }
  return data;
}

const SETTINGS_VERSION = 7;

/**
 * Reshape a settings object loaded from disk.
 *
 * Changing a value in DEFAULTS only affects fresh installs — every existing user
 * already has the old value written to their settings file. Migrations are how a
 * changed default actually reaches them.
 *
 * @returns true when something changed and the file should be rewritten.
 */
function applyMigrations(data) {
  const from = Number(data.settings_version) || 0;
  if (from >= SETTINGS_VERSION) return false;

  // v2 moved everyone onto the native SteamPipe engine. That engine is now the
  // only one, so the flag it set no longer exists; the migration is kept as a
  // version marker so an old settings file still lands on the current version.

  // v3 turns three things on by default: auto-crack after download, SLSsteam /
  // GreenLuma wrapper mode, and 16-way "Turbo" concurrency. Editing DEFAULTS
  // only reaches fresh installs; every existing settings file already has the
  // old values written, so they are reset here — once. Because the version is
  // stamped at the end, a user who later turns any of these back off is never
  // re-migrated. The boolean flips run only from below v3, so this cannot
  // reappear after the first launch.
  if (from < 3) {
    data.auto_crack = true;
    data.slssteam_mode = true;
    // Only move the ones still on the previous default (8). A deliberate 4 or a
    // Maximum-32 choice is left alone — "the default changed", not "your pick
    // is overridden".
    if (Number(data.download_max_downloads) === 8 || data.download_max_downloads == null) {
      data.download_max_downloads = 16;
    }
  }

  // v4 adds Big Picture. Its keys are new, so sanitizeSettings already fills
  // them from DEFAULTS on load — but an existing file has no bigpicture_accent
  // written, and normalizeHex would happily keep a stale lowercase value from a
  // pre-release build. Stamping the canonical default once keeps every install
  // on the reference teal until the user picks something else.
  if (from < 4) {
    if (!/^#[0-9A-F]{6}$/.test(String(data.bigpicture_accent || ''))) {
      data.bigpicture_accent = DEFAULTS.bigpicture_accent;
    }
  }

  // v5 turns Lancache detection on. Until now the toggle was stored and shown
  // but never read by the download engine, so nobody's stored value expresses a
  // preference about a feature that did anything — there is no user choice here
  // to preserve, and the false everyone is carrying is the old dead default.
  // Anyone who turns it off after this keeps it off: the flip runs only from
  // below v5.
  if (from < 5) {
    data.use_lancache = true;
  }

  // v6 follows ARTIFACT, who posts the Denuvo releases now. Only a file still
  // on the old default moves: any other member is somebody's choice.
  if (from < 6) {
    if (String(data.csrin_author || '').trim().toLowerCase() === 'denuvowo') data.csrin_author = 'ARTIFACT';
  }

  // v7 is the redrawn interface: periwinkle on night blue instead of brass on
  // ink. Only a file still carrying the old defaults moves — an accent or a
  // background somebody picked is theirs and stays.
  if (from < 7) {
    if (String(data.accent_color || '').toUpperCase() === '#D2A65C') data.accent_color = DEFAULTS.accent_color;
    if (String(data.background_color || '').toUpperCase() === '#0C0D10') data.background_color = DEFAULTS.background_color;
  }

  data.settings_version = SETTINGS_VERSION;
  return true;
}

function getPreferredFilePath() {
  return path.join(app.getPath('userData'), 'librarian-settings.json');
}

function getLegacyFilePath() {
  return path.join(app.getPath('userData'), 'accela-settings.json');
}

function getFilePath() {
  if (!_filePath) {
    _filePath = getPreferredFilePath();
  }
  return _filePath;
}

function secureStorageAvailable() {
  return safeStorage?.isEncryptionAvailable()
    && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend?.() !== 'basic_text');
}

function encodeSecrets(data) {
  const disk = json.clone(data);
  for (const key of SECRET_KEYS) {
    if (!disk[key]) continue;
    if (!secureStorageAvailable()) throw new Error('Secure credential storage is unavailable. Settings were not saved.');
    disk[key] = { encrypted: safeStorage.encryptString(disk[key]).toString('base64') };
  }
  return disk;
}

function decodeSecrets(disk) {
  const data = json.clone(disk);
  for (const key of SECRET_KEYS) {
    if (!data[key] || typeof data[key] !== 'object') continue;
    if (typeof data[key].encrypted !== 'string' || !secureStorageAvailable()) {
      throw new Error('Cannot unlock saved credentials for this OS account. The settings file has been preserved.');
    }
    data[key] = safeStorage.decryptString(Buffer.from(data[key].encrypted, 'base64'));
  }
  return data;
}

function protectLegacyCopy(file) {
  let disk;
  try { disk = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
  if (!disk || typeof disk !== 'object' || Array.isArray(disk)) return;
  let changed = false;
  for (const key of SECRET_KEYS) {
    if (typeof disk[key] !== 'string' || !disk[key]) continue;
    if (!secureStorageAvailable()) throw new Error('Secure credential storage is unavailable. Legacy settings have been preserved.');
    disk[key] = { encrypted: safeStorage.encryptString(disk[key]).toString('base64') };
    changed = true;
  }
  if (changed) json.write(file, disk, { backup: false });
}

function load() {
  if (_data) return _data;
  const candidates = [getPreferredFilePath(), getLegacyFilePath()];

  for (const candidate of candidates) {
    const disk = json.read(candidate, null, value => value && typeof value === 'object' && !Array.isArray(value));
    if (disk === null) continue;
    const data = sanitizeSettings(decodeSecrets(disk));
    const migrated = applyMigrations(data);
    const plaintext = [...SECRET_KEYS].some(key => typeof disk[key] === 'string' && disk[key]);
    if (migrated || plaintext || candidate !== getPreferredFilePath()) {
      const secured = encodeSecrets(data);
      // Migration must not create another plaintext credential copy.
      json.write(getPreferredFilePath(), secured, { backup: !plaintext });
      if (plaintext && candidate !== getPreferredFilePath()) json.write(candidate, secured, { backup: false });
      if (plaintext && fs.existsSync(`${candidate}.bak`)) json.write(`${candidate}.bak`, secured, { backup: false });
    }
    for (const copy of [getLegacyFilePath(), `${getLegacyFilePath()}.bak`, `${getPreferredFilePath()}.bak`]) protectLegacyCopy(copy);
    _filePath = getPreferredFilePath();
    _data = data;
    return _data;
  }

  // First run: nothing to migrate, but stamp the version so the next upgrade
  // doesn't re-apply migrations against a file that was already born current.
  _filePath = getPreferredFilePath();
  _data = sanitizeSettings({});
  _data.settings_version = SETTINGS_VERSION;
  return _data;
}

function save(next) {
  const data = sanitizeSettings(next);
  json.write(getPreferredFilePath(), encodeSecrets(data));
  _data = data;
  _filePath = getPreferredFilePath();
}

function get(key) {
  const data = load();
  return json.clone(key ? data[key] : data);
}

function set(key, value) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
    throw new Error(`Unknown setting: ${key}`);
  }
  save({ ...load(), [key]: coerceValue(key, value) });
}

function getAll() {
  return json.clone(load());
}

function setMany(updates) {
  const data = getAll();
  for (const [key, value] of Object.entries(updates || {})) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) throw new Error(`Unknown setting: ${key}`);
    data[key] = coerceValue(key, value);
  }
  save(data);
}

function getPublic(key) {
  const data = getAll();
  const secrets_present = {};
  for (const secret of SECRET_KEYS) { secrets_present[secret] = Boolean(data[secret]); data[secret] = ''; }
  data.secrets_present = secrets_present;
  return key ? data[key] : data;
}

module.exports = { get, set, setMany, getAll, getPublic, DEFAULTS };
