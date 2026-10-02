// ─── Patch numbers ───────────────────────────────────────────────
//
// A CS.RIN.RU release names the patch it was made for — ARTIFACT writes
// "Crimson.Desert.Enhanced.Update.v2.03.02.Crack.Only-ARTIFACT" and states no
// Steam build id at all — so a release is matched to a game by patch number.
// Steam does not record one for an installed game, and the executable's own
// version resource is no help (Crimson Desert's says 1.0.0.2625 on patch
// 2.03.02). What does carry it is the developer's announcement: "Patch Notes
// Version 2.03.02", "Game Update 1.4.0".
//
// So the installed patch is read off two dates: when the installed depot
// manifest was created (Steam stamps it when the build is uploaded) and when
// each versioned announcement was posted. A build goes up first and its notes
// follow within hours to two days (Crimson Desert 2.00.00: 8.5 h; CONTROL
// Resonant 1.4.0: 45 h), so the first versioned post after the build is its
// patch. A build with no notes of its own (a silent hotfix) keeps the number
// of the last patch before it — unless the build is under two days old, when
// its notes may simply not be out yet and the patch is reported unknown. It
// is an inference and is labelled as one; the picker lets the user state the
// patch instead, and that wins.
//
// The public build an update would land on is dated by when it went live
// (steamcmd.net). Notes can come a little before that moment (Crimson Desert
// 2.03.02: notes 04:48, live 08:26 UTC) or two days after (CONTROL Resonant
// 1.4.0: live 09-29 10:41, notes 10-01 07:47), so the window opens six hours
// earlier and the same first-notes rule applies.
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const NEWS_URL = 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/';
const CACHE_TTL = 60 * 60 * 1000;
const H = 60 * 60 * 1000;
const NOTES_BEFORE_BUILD = 2 * H;   // clocks, and notes posted as the upload finishes
const NOTES_AFTER_BUILD = 48 * H;
const NOTES_BEFORE_LIVE = 6 * H;

const cache = new Map();
const inFlight = new Map();

// ─── Version strings ─────────────────────────────────────────────

/** The patch number a title or release name states, or ''. */
function versionFromText(text) {
  const s = String(text || '');
  const m = /\b(?:version|ver\.?|update|patch|hotfix|build)\s*[:#.]?\s*v?\.?\s*(\d+(?:\.\d+)+)/i.exec(s)
    || /(?:^|[\s._(\[-])v(\d+(?:\.\d+)+)\b/i.exec(s);
  return m ? m[1] : '';
}

/**
 * The comparable form of a patch number: "2.03.02" and "2.3.2" are the same
 * patch, and so are "1.4" and "1.4.0". Anything that is not dotted numbers
 * gives '' and never matches.
 */
function versionKey(v) {
  const s = String(v || '').trim().replace(/^v\.?/i, '');
  if (!/^\d+(?:\.\d+)*$/.test(s)) return '';
  const parts = s.split('.').map((p) => String(Number(p)));
  while (parts.length > 1 && parts[parts.length - 1] === '0') parts.pop();
  return parts.join('.');
}

function sameVersion(a, b) {
  const ka = versionKey(a);
  return Boolean(ka) && ka === versionKey(b);
}

// ─── Steam announcements ─────────────────────────────────────────

/** Every versioned announcement for an app, newest first. */
async function timeline(appId) {
  const id = String(appId || '').trim();
  if (!/^\d{1,20}$/.test(id) || id === '0') return { items: [], error: 'no AppID' };
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.result;
  if (inFlight.has(id)) return inFlight.get(id);
  const task = (async () => {
    let result;
    try {
      // Titles only (maxlength=1): the number is in the title, and a hundred
      // posts reach back past any build a game is likely to be on.
      const res = await fetch(`${NEWS_URL}?appid=${id}&count=100&maxlength=1&feeds=steam_community_announcements&format=json`, { timeout: 12000 });
      if (!res.ok) throw new Error(`Steam news returned ${res.status}`);
      const json = await res.json();
      const items = (json?.appnews?.newsitems || [])
        .map((n) => ({ version: versionFromText(n.title), date: (Number(n.date) || 0) * 1000, title: String(n.title || '').trim(), url: typeof n.url === 'string' ? n.url : '' }))
        .filter((n) => versionKey(n.version) && n.date)
        .sort((a, b) => b.date - a.date);
      result = { items, error: null };
    } catch (err) {
      result = { items: [], error: err.message };
    }
    cache.set(id, { at: result.error ? Date.now() - CACHE_TTL + 60000 : Date.now(), result });
    return result;
  })().finally(() => inFlight.delete(id));
  inFlight.set(id, task);
  return task;
}

// ─── The installed build ─────────────────────────────────────────

function readAcf(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const depots = {};
  const block = /"InstalledDepots"\s*\{([\s\S]*?)\r?\n\t\}/i.exec(text);
  if (block) {
    const re = /"(\d+)"\s*\{[^}]*?"manifest"\s+"(\d+)"/g;
    let m;
    while ((m = re.exec(block[1]))) depots[m[1]] = m[2];
  }
  const field = (name) => (new RegExp(`"${name}"\\s+"([^"]*)"`, 'i').exec(text) || [])[1] || '';
  return { depots, buildid: field('buildid'), lastUpdated: Number(field('LastUpdated')) * 1000 || 0 };
}

/**
 * When the installed build was made: the newest creation time among the
 * installed depot manifests. Steam libraries keep the record in
 * <library>/steamapps and the manifests in <library>/depotcache; a custom
 * folder keeps both under its own .DepotDownloader.
 */
function installedBuildTime(installPath, appId) {
  if (!installPath) return null;
  const install = path.resolve(installPath);
  const steamapps = path.resolve(install, '..', '..');
  const marker = path.join(install, '.DepotDownloader');
  const acfFile = [path.join(steamapps, `appmanifest_${appId}.acf`), path.join(marker, `appmanifest_${appId}.acf`)]
    .find((f) => fs.existsSync(f));
  if (!acfFile) return null;
  const acf = readAcf(acfFile);
  if (!acf) return null;
  const caches = [path.join(steamapps, '..', 'depotcache'), path.join(steamapps, 'depotcache'), path.join(marker, 'depotcache')];
  let format = null;
  try { format = require(require('./runtimePaths').getDepsPath('steammanifest', 're', 'manifest_format.js')); } catch {}
  let newest = 0;
  for (const [depot, manifest] of Object.entries(acf.depots)) {
    const file = caches.map((d) => path.join(d, `${depot}_${manifest}.manifest`)).find((f) => fs.existsSync(f));
    if (!file || !format) continue;
    try {
      const t = Number(format.parseManifest(fs.readFileSync(file)).creation_time) * 1000;
      if (t > newest) newest = t;
    } catch { /* unreadable manifest: the next depot may still say */ }
  }
  return { buildTime: newest, buildid: acf.buildid, lastUpdated: acf.lastUpdated };
}

/**
 * The patch a build dated `buildTime` most likely is, from the announcements.
 * The first versioned notes in [buildTime - before, buildTime + after] name
 * it. A build younger than `after` with no notes yet is { rule: 'pending' }.
 */
function inferAt(items, buildTime, { before = NOTES_BEFORE_BUILD, after = NOTES_AFTER_BUILD, now = Date.now() } = {}) {
  if (!buildTime || !items.length) return null;
  const pick = items
    .filter((n) => n.date >= buildTime - before && n.date <= buildTime + after)
    .sort((a, b) => a.date - b.date)[0];
  if (pick) return { ...pick, rule: 'notes' };
  if (now - buildTime < after) return { version: '', rule: 'pending' };
  const prior = items.find((n) => n.date < buildTime);
  return prior ? { ...prior, rule: 'previous' } : null;
}

/**
 * The installed patch, inferred.
 * Resolves { version, source, title, date, buildTime, error? }; version is ''
 * when nothing could be inferred.
 */
async function installedPatch({ appid, installPath }) {
  const build = installedBuildTime(installPath, appid);
  if (!build || !build.buildTime) {
    return { version: '', source: 'unknown', error: 'the installed build has no cached depot manifest to date it' };
  }
  const { items, error } = await timeline(appid);
  if (error) return { version: '', source: 'unknown', buildTime: build.buildTime, error };
  const hit = inferAt(items, build.buildTime);
  if (!hit) return { version: '', source: 'unknown', buildTime: build.buildTime, error: 'no versioned Steam announcement near that build' };
  if (hit.rule === 'pending') return { version: '', source: 'pending', buildTime: build.buildTime, error: 'Steam has not posted patch notes for this build yet' };
  return { version: hit.version, source: hit.rule === 'notes' ? 'steam-notes' : 'steam-previous', title: hit.title, date: hit.date, url: hit.url, buildTime: build.buildTime, buildid: build.buildid };
}

/**
 * The patch of the public build an update or download would land on, from
 * when it went live (steamcmd.net). Without that date, the newest notes.
 */
async function targetPatch(appid, liveTime) {
  if (!liveTime) return latestPatch(appid);
  const { items, error } = await timeline(appid);
  if (error) return { version: '', source: 'unknown', error };
  const hit = inferAt(items, liveTime, { before: NOTES_BEFORE_LIVE });
  if (!hit) return { version: '', source: 'unknown', error: 'no versioned Steam announcement near the public build' };
  if (hit.rule === 'pending') return { version: '', source: 'pending', liveTime, error: 'the public build is new and Steam has no patch notes for it yet' };
  return { version: hit.version, source: hit.rule === 'notes' ? 'steam-notes' : 'steam-previous', title: hit.title, date: hit.date, url: hit.url, liveTime };
}

/** The newest patch the developer has announced. */
async function latestPatch(appid) {
  const { items, error } = await timeline(appid);
  const top = items[0];
  return top ? { version: top.version, source: 'steam-latest', title: top.title, date: top.date, url: top.url } : { version: '', source: 'unknown', error: error || 'no versioned Steam announcement' };
}

module.exports = {
  versionFromText,
  versionKey,
  sameVersion,
  timeline,
  installedBuildTime,
  inferAt,
  installedPatch,
  targetPatch,
  latestPatch,
};
