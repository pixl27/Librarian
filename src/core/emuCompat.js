// ═══════════════════════════════════════════════════════════════════
// Librarian — emulator compatibility
//
// The failure this exists for: a game updates to a newer Steamworks SDK, the
// emulator that replaced its steam_api does not implement an interface the
// new build asks for, SteamAPI_Init fails, and the player sees a Steam error
// at launch. Nothing in the download told anyone. (Mortal Shell II, 2026-09:
// Steamworks 1.65 wants SteamUtils011; the gbe_fork build of 2026-08-07
// stops at SteamUtils010. A verify "fixed" it by putting Valve's library back
// — and with it took the achievements and the DLC.)
//
// The generic answer is a set difference. Every Steam API library names the
// interface versions it requests, in clear text: SteamUtils011,
// STEAMUSERSTATS_INTERFACE_VERSION013, SteamNetworkingSockets013. The
// emulator's library names the versions it implements the same way. Read both,
// subtract, and the answer is exact, offline, and knows no game by name:
//
//   requested(game's own library) − implemented(emulator) = missing
//
// Empty: crack as always. Not empty: fetch the newest emulator release and
// look again; still not empty: leave the game's own library alone and say so,
// because an emulator known to fail is worse than no emulator.
//
// The game's own library is found where the crack keeps it: `<dll>.bak`
// beside an applied emulator (SteamAutoCrack's backup), `<name>_o.dll` beside
// our online-mode proxy, or the live file when nothing has replaced it yet.
// ═══════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const https = require('https');

// Two spellings Valve has used for interface version strings. The first is
// the ISteam* family (SteamUser023, SteamNetworkingSockets013), the second
// the macro family (STEAMUSERSTATS_INTERFACE_VERSION013,
// STEAMINVENTORY_INTERFACE_V003, STEAMHTMLSURFACE_INTERFACE_VERSION_005).
const INTERFACE_RE = /\b(?:Steam[A-Z][A-Za-z]*\d{3}|STEAM[A-Z_]+_INTERFACE_V(?:ERSION)?_?\d{3})\b/g;

const STEAM_API_DLL = /^steam_api(64)?\.dll$/i;
const REPORT_FILE = 'EMU_MISSING_INTERFACE.txt';
const GENUINE_MAX_BYTES = 1024 * 1024;         // every Valve steam_api64 measured is under 320 KB
const RELEASES_URL = 'https://api.github.com/repos/Detanup01/gbe_fork/releases/latest';
const CACHE_TTL_MS = 24 * 3600 * 1000;
const SKIP_DIRS = new Set(['.depotdownloader', 'node_modules', '$recycle.bin']);

/** Interface version names found in a text. */
function interfacesInText(text) {
  const found = new Set(text.match(INTERFACE_RE) || []);
  return [...found].sort();
}

/** Interface version names found in a binary (they are stored as ASCII). */
function interfacesIn(file) {
  return interfacesInText(fs.readFileSync(file).toString('latin1'));
}

/**
 * An emulator's steam_api is megabytes and carries the string it writes its
 * missing-interface report under; Valve's is a few hundred kilobytes and
 * carries neither. Unreadable answers false: the point is to act only when
 * sure.
 */
function looksLikeEmulator(file) {
  try {
    const size = fs.statSync(file).size;
    if (size > GENUINE_MAX_BYTES) return true;
    return fs.readFileSync(file).toString('latin1').includes(REPORT_FILE.replace('.txt', ''));
  } catch { return false; }
}

function walk(root, depth, out) {
  if (depth > 8) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
      walk(path.join(root, e.name), depth + 1, out);
    } else if (STEAM_API_DLL.test(e.name)) {
      out.push(path.join(root, e.name));
    }
  }
}

/**
 * Every Steam API library under an install, with the file that is the game's
 * own version of it — the one that says what the game asks for.
 *
 *   kind      what sits at the game's path now: 'game' (its own library),
 *             'emulator', or 'proxy' (our online-mode steam_api64)
 *   original  the game's own library, wherever it is kept; null when nothing
 *             of the game's remains (cracked without a backup)
 */
function findGameLibraries(installPath) {
  const out = [];
  if (!installPath || !fs.existsSync(installPath)) return out;
  const dlls = [];
  walk(installPath, 0, dlls);
  for (const dll of dlls) {
    const arch = /64\.dll$/i.test(dll) ? 64 : 32;
    const bak = `${dll}.bak`;
    const proxied = dll.replace(/\.dll$/i, '_o.dll');
    let kind = 'game';
    let original = dll;
    if (fs.existsSync(proxied)) { kind = 'proxy'; original = proxied; }
    else if (looksLikeEmulator(dll)) { kind = 'emulator'; original = fs.existsSync(bak) ? bak : null; }
    else if (fs.existsSync(bak) && looksLikeEmulator(bak) === false) {
      // A live game library with a backup beside it: an update put the game's
      // own file back, or a verify did. The backup is the older copy of the
      // same thing; the live file is the one that counts.
      original = dll;
    }
    out.push({ dll, original, arch, kind });
  }
  return out;
}

/** True when this install has had the emulator applied at some point. */
function wasCracked(installPath) {
  return findGameLibraries(installPath).some((l) => l.kind === 'emulator' || (l.kind === 'game' && fs.existsSync(`${l.dll}.bak`)));
}

function isOnline(installPath) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(installPath, '.DepotDownloader', 'online-mode.json'), 'utf-8'));
    return Boolean(st && st.mode === 'online');
  } catch { return false; }
}

// ─── The emulator on this machine ────────────────────────────────
function emulatorDir() {
  try { return require('./autoCrack').checkSacStatus().goldbergDir; }
  catch { return null; }
}

/** The library SteamAutoCrack copies into a game of this architecture. */
function emulatorLibrary(arch, dir = emulatorDir()) {
  if (!dir) return null;
  const p = arch === 64 ? path.join(dir, 'x64', 'steam_api64.dll') : path.join(dir, 'x32', 'steam_api.dll');
  return fs.existsSync(p) ? p : null;
}

/** What is installed: where, which commit, how old, what it implements. */
function emulatorInfo() {
  const dir = emulatorDir();
  const info = { dir, commit: '', date: 0, library64: null, library32: null, interfaces64: [], interfaces32: [] };
  if (!dir || !fs.existsSync(dir)) return info;
  try { info.commit = fs.readFileSync(path.join(dir, 'commit_id'), 'utf-8').trim(); } catch { /* older layouts */ }
  const stamp = ['commit_id', path.join('x64', 'steam_api64.dll')].map((f) => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch { return 0; } });
  info.date = Math.max(...stamp);
  info.library64 = emulatorLibrary(64, dir);
  info.library32 = emulatorLibrary(32, dir);
  if (info.library64) info.interfaces64 = interfacesIn(info.library64);
  if (info.library32) info.interfaces32 = interfacesIn(info.library32);
  return info;
}

// ─── The check ───────────────────────────────────────────────────
/**
 * Compare what the game asks for with what the emulator implements.
 *
 *   compatible  every interface every one of the game's libraries requests is
 *               implemented by the emulator for that architecture
 *   unknown     no library of the game's own could be found to ask
 *   missing     the union of what is missing, sorted
 *
 * `emulatorInterfaces` lets a caller supply the implemented sets (tests do,
 * with a frozen list) instead of reading the installed emulator.
 */
function check(installPath, { emulatorInterfaces } = {}) {
  const libraries = findGameLibraries(installPath);
  const online = isOnline(installPath);
  const info = emulatorInterfaces ? null : emulatorInfo();
  const implemented = (arch) => {
    if (emulatorInterfaces) return new Set(emulatorInterfaces[arch] || emulatorInterfaces[String(arch)] || []);
    return new Set(arch === 64 ? info.interfaces64 : info.interfaces32);
  };
  const missing = new Set();
  const requested = new Set();
  let known = 0;
  const detail = libraries.map((l) => {
    const entry = { ...l, requested: [], missing: [] };
    if (!l.original || !fs.existsSync(l.original)) return entry;
    let names;
    try { names = interfacesIn(l.original); } catch { return entry; }
    if (!names.length) return entry;                 // a proxy, or not a Steam library at all
    known++;
    const have = implemented(l.arch);
    entry.requested = names;
    entry.missing = names.filter((n) => !have.has(n));
    for (const n of names) requested.add(n);
    for (const n of entry.missing) missing.add(n);
    return entry;
  });
  return {
    libraries: detail,
    requested: [...requested].sort(),
    missing: [...missing].sort(),
    compatible: known > 0 && missing.size === 0,
    unknown: known === 0,
    online,
    emulatorDate: info ? info.date : 0,
    emulatorCommit: info ? info.commit : '',
  };
}

// ─── The newest release ──────────────────────────────────────────
// The settings store needs Electron's `app`; under plain Node (the verifier)
// it loads but cannot read. Both directions are best effort here: a missing
// cache means one more request, a failed write means one more tomorrow.
function readSetting(key, fallback) {
  try { const v = require('./settingsStore').get(key); return v === undefined ? fallback : v; }
  catch { return fallback; }
}
function writeSetting(key, value) {
  try { require('./settingsStore').set(key, value); } catch { /* plain Node, or a read-only store */ }
}

function fetchJson(url, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Librarian', Accept: 'application/vnd.github+json' },
      timeout,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * The newest gbe_fork release, from GitHub, remembered for a day. Null when
 * offline and nothing is remembered; never throws.
 */
async function latestRelease({ force = false } = {}) {
  const cached = readSetting('emu_release_cache', null);
  if (!force && cached && cached.at && Date.now() - cached.at < CACHE_TTL_MS && cached.publishedAt) {
    return { ...cached, cached: true };
  }
  try {
    const r = await fetchJson(RELEASES_URL);
    const asset = pickAsset(r.assets || []);
    const rel = {
      at: Date.now(),
      tag: String(r.tag_name || ''),
      name: String(r.name || ''),
      publishedAt: Date.parse(r.published_at) || 0,
      url: String(r.html_url || ''),
      // A release built by CI names its commit; a tag alone is the fallback.
      commit: /^[0-9a-f]{40}$/i.test(String(r.target_commitish || '')) ? String(r.target_commitish).toLowerCase() : '',
      assetName: asset ? String(asset.name) : '',
      assetUrl: asset ? String(asset.browser_download_url) : '',
      assetSize: asset ? Number(asset.size) || 0 : 0,
    };
    writeSetting('emu_release_cache', rel);
    return { ...rel, cached: false };
  } catch (e) {
    return cached && cached.publishedAt ? { ...cached, cached: true, stale: true, error: e.message } : null;
  }
}

/** The Windows release archive among a release's assets. */
function pickAsset(assets) {
  const names = assets.filter((a) => a && /\.7z$/i.test(a.name || ''));
  return names.find((a) => /^emu-win-release\.7z$/i.test(a.name))
    || names.find((a) => /win/i.test(a.name) && /release/i.test(a.name) && !/debug|experimental|linux/i.test(a.name))
    || null;
}

/** GET to a file, following GitHub's redirect to its object store. */
function download(url, dest, { timeout = 120000, hops = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (hops > 5) { reject(new Error('too many redirects')); return; }
    const req = https.get(url, { headers: { 'User-Agent': 'Librarian', Accept: 'application/octet-stream' }, timeout }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        download(res.headers.location, dest, { timeout, hops: hops + 1 }).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let out;
      try { out = fs.createWriteStream(dest); } catch (e) { reject(e); return; }
      let bytes = 0;
      res.on('data', (d) => { bytes += d.length; });
      res.on('error', (e) => { out.destroy(); reject(e); });
      out.on('error', reject);
      out.on('finish', () => resolve(bytes));
      res.pipe(out);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** Windows Defender's refusal, in whichever language it speaks. */
function looksBlocked(err) {
  const m = String(err && err.message || err || '').toLowerCase();
  return /virus|potentially unwanted|ind[ée]sirable|eperm|operation not permitted|access is denied|acc[èe]s refus/i.test(m);
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }

/**
 * Fetch the newest emulator release and install it — without ever being
 * without one. The archive is downloaded beside the installed folder,
 * extracted into a sibling, checked to be usable, and only then swapped in;
 * the previous folder is kept one generation for rollback. Anything that
 * fails on the way leaves the installed emulator exactly as it was. (SAC's
 * own updater deletes first and downloads second; when Windows Defender
 * refused the archive on this machine, that left no emulator at all.)
 *
 * `assetUrl` and `release` are for tests, to point at a bad URL or a fixed
 * release without touching the network twice.
 */
async function updateEmulator({ onLog = () => {}, assetUrl, release, force = false } = {}) {
  const before = emulatorInfo();
  const dir = before.dir || emulatorDir();
  if (!dir) return { success: false, error: 'SteamAutoCrack folder not found', before, after: before, changed: false };
  const parent = path.dirname(dir);
  const work = path.join(parent, 'Goldberg.download');
  const fresh = path.join(parent, 'Goldberg.new');
  const prev = path.join(parent, 'Goldberg.prev');
  onLog(`⬇ Updating the emulator (installed build ${before.commit ? before.commit.slice(0, 8) : 'unknown'}, ${before.date ? new Date(before.date).toISOString().slice(0, 10) : 'undated'})…`);

  let rel = release || await latestRelease({ force: true });
  if (!rel || (!rel.assetUrl && !assetUrl)) {
    onLog('⚠ Could not find the release archive on GitHub.');
    return { success: false, error: rel ? 'no Windows release archive in the newest release' : 'GitHub unreachable', before, after: before, changed: false };
  }
  // Already this release: nothing to fetch. `force` re-installs it anyway,
  // which is what the Crack page's button means when a copy is damaged.
  const stamp = rel.commit || rel.tag || '';
  if (!force && stamp && before.commit === stamp && before.interfaces64.length > 0) {
    onLog(`ℹ The installed emulator is already ${stamp}.`);
    return { success: true, before, after: before, changed: false, upToDate: true, release: rel };
  }
  const url = assetUrl || rel.assetUrl;
  const archive = path.join(work, rel.assetName || 'emu-win-release.7z');
  rmrf(work); rmrf(fresh);
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(fresh, { recursive: true });

  const failed = (error, blocked = false) => {
    rmrf(work); rmrf(fresh);
    onLog(blocked
      ? `⛔ Windows Defender refused the emulator archive (it flags Steam emulators as potentially unwanted). The installed emulator is untouched. Allow it in Windows Security → Protection history, or exclude ${parent}, then try again.`
      : `⚠ Emulator update failed: ${error}. The installed emulator is untouched.`);
    return { success: false, error, blocked, before, after: emulatorInfo(), changed: false };
  };

  try {
    onLog(`   ${rel.tag || rel.name || 'release'} (${rel.publishedAt ? new Date(rel.publishedAt).toISOString().slice(0, 10) : 'undated'}): downloading ${rel.assetName || path.basename(url)}…`);
    const bytes = await download(url, archive);
    // Defender can let the write finish and quarantine the file right after.
    if (!fs.existsSync(archive) || fs.statSync(archive).size === 0) return failed('the archive vanished after download', true);
    onLog(`   ${(bytes / 1048576).toFixed(1)} MB received; extracting…`);
  } catch (e) {
    return failed(e.message, looksBlocked(e));
  }

  // bsdtar reads 7-Zip archives; the system copy, by absolute path.
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const { spawnSync } = require('child_process');
  const x = spawnSync(tar, ['-xf', archive, '-C', fresh], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
  if (x.status !== 0) return failed(`extraction failed: ${(x.stderr || x.stdout || '').trim().split('\n')[0] || `tar exit ${x.status}`}`, looksBlocked(x.stderr));

  // The extracted tree may have one top-level folder; look inside it.
  let root = fresh;
  try {
    const entries = fs.readdirSync(fresh, { withFileTypes: true });
    if (entries.length === 1 && entries[0].isDirectory()) root = path.join(fresh, entries[0].name);
  } catch { /* leave root */ }
  const { goldbergFolderUsable } = require('./autoCrack');
  if (!goldbergFolderUsable(root)) return failed('the extracted archive does not contain an emulator SteamAutoCrack can use');
  if (root !== fresh) {
    // Hoist the single folder so the layout is the one SAC expects.
    const hoisted = path.join(parent, 'Goldberg.hoist');
    rmrf(hoisted);
    fs.renameSync(root, hoisted);
    rmrf(fresh);
    fs.renameSync(hoisted, fresh);
  }
  try { fs.writeFileSync(path.join(fresh, 'commit_id'), (rel.commit || rel.tag || 'unknown') + '\n'); } catch { /* not fatal */ }
  const candidate = interfacesIn(path.join(fresh, 'x64', 'steam_api64.dll'));
  if (!candidate.length) return failed('the new library names no Steam interface at all');

  // Swap: installed -> prev, new -> installed. Both renames on one volume.
  rmrf(prev);
  try {
    if (fs.existsSync(dir)) fs.renameSync(dir, prev);
    fs.renameSync(fresh, dir);
  } catch (e) {
    // Put the installed one back if the first rename went through.
    if (!fs.existsSync(dir) && fs.existsSync(prev)) { try { fs.renameSync(prev, dir); } catch { /* worst case: prev holds it */ } }
    return failed(`could not swap folders: ${e.message}`, looksBlocked(e));
  }
  rmrf(work);
  const after = emulatorInfo();
  const changed = after.commit !== before.commit || after.interfaces64.length !== before.interfaces64.length;
  onLog(`✅ Emulator updated: ${rel.tag || rel.name || 'release'}, ${after.interfaces64.length} interfaces implemented (previous build kept in Goldberg.prev).`);
  return { success: true, before, after, changed, release: rel };
}

/**
 * The gate. Compatible, or made compatible by an update: ok. Otherwise not
 * ok, with what is missing, and nothing was placed in the game.
 */
async function ensureCompatible(installPath, { onLog = () => {}, allowNetwork = true } = {}) {
  let r = check(installPath);
  if (r.online) return { ok: false, reason: 'online', missing: [], check: r };
  if (r.unknown) { onLog('ℹ No Steam library of the game\'s own to compare against; applying the emulator as before.'); return { ok: true, reason: 'unknown', missing: [], check: r }; }
  if (r.compatible) return { ok: true, reason: 'compatible', missing: [], check: r };

  onLog(`⚠ The installed emulator does not implement ${r.missing.length} interface(s) this game asks for: ${r.missing.join(', ')}.`);
  const autoUpdate = readSetting('emu_auto_update', true) !== false;
  let updated = false;
  let blocked = false;
  let updateError = '';
  if (allowNetwork && autoUpdate) {
    const latest = await latestRelease();
    if (latest && latest.publishedAt && latest.publishedAt > r.emulatorDate + 60 * 1000) {
      onLog(`   A newer emulator release exists (${latest.tag || latest.name}, ${new Date(latest.publishedAt).toISOString().slice(0, 10)}); fetching it.`);
      const u = await updateEmulator({ onLog, release: latest.assetUrl ? latest : undefined });
      updated = Boolean(u.success && u.changed);
      blocked = Boolean(u.blocked);
      updateError = u.success ? '' : String(u.error || '');
      r = check(installPath);
      if (r.compatible) return { ok: true, reason: 'updated', missing: [], updated, blocked: false, check: r };
      if (u.success) onLog(`⚠ Still missing after the update: ${r.missing.join(', ')}.`);
    } else if (latest) {
      onLog(`   No newer emulator release than the installed one (${latest.tag || latest.name}).`);
    } else {
      onLog('   Could not reach GitHub to look for a newer emulator.');
    }
  }
  onLog('⏹ The emulator is not applied: the game keeps its own Steam library and will run without Steam features until an emulator release covers this SDK.');
  return { ok: false, reason: 'incompatible', missing: r.missing, updated, blocked, updateError, check: r };
}

// ─── The pipeline decision ───────────────────────────────────────
/**
 * Whether the post-download step should place the emulator. Pure: every
 * input is a fact the caller already has, so it is testable without a game.
 *
 *   jobType        'download' | 'update' | 'repair'
 *   skipAutoCrack  the job opted out (a Denuvo title, or the user)
 *   autoCrack      the setting
 *   online         the game is in online mode
 *   wasCracked     the game had the emulator before this job
 *   gate           the result of ensureCompatible, or null when not run yet
 */
function decide({ jobType = 'download', skipAutoCrack = false, autoCrack = true, online = false, wasCracked: had = false, gate = null }) {
  if (!autoCrack) return { apply: false, reason: 'auto-crack is off' };
  if (skipAutoCrack) return { apply: false, reason: 'this job opted out of the emulator (Denuvo title or per-job choice)' };
  if (online) return { apply: false, reason: 'the game is in online mode; its Steam library is left alone' };
  if (jobType === 'repair' && !had) return { apply: false, reason: 'the game had no emulator before the verify; nothing to re-apply' };
  if (gate && !gate.ok) return { apply: false, reason: gate.reason === 'incompatible' ? `the emulator lacks ${gate.missing.join(', ')}` : gate.reason };
  return { apply: true, reason: jobType === 'repair' ? 're-applying the emulator the verify removed' : 'emulator compatible with this build' };
}

// ─── After a launch ──────────────────────────────────────────────
/**
 * Missing-interface reports the emulator wrote under an install, parsed.
 * With `sinceMs`, only entries stamped after that moment (the emulator writes
 * local time; a minute of slack covers the clock and the launcher's delay).
 */
function missingInterfaceReports(installPath, sinceMs = 0) {
  const out = [];
  if (!installPath || !fs.existsSync(installPath)) return out;
  const files = [];
  const seek = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name.toLowerCase())) seek(path.join(dir, e.name), depth + 1); }
      else if (e.name === REPORT_FILE) files.push(path.join(dir, e.name));
    }
  };
  seek(installPath, 0);
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    for (const block of text.split(/-{6,}/)) {
      const iface = block.match(/INTERFACE=(\S+)/);
      if (!iface) continue;
      const t = block.match(/TIME=(\d{4})\/(\d{2})\/(\d{2})\s*-\s*(\d{2}):(\d{2}):(\d{2})/);
      const time = t ? new Date(+t[1], +t[2] - 1, +t[3], +t[4], +t[5], +t[6]).getTime() : 0;
      const appid = (block.match(/APPID=(\d+)/) || [])[1] || '';
      if (sinceMs && time && time < sinceMs - 60 * 1000) continue;
      if (sinceMs && !time) continue;
      out.push({ file, interface: iface[1], time, appid });
    }
  }
  return out;
}

// ─── What the panel reads ────────────────────────────────────────
function metaKey(game) {
  try { return require('./gameMetaStore').gameKey(game); } catch { return ''; }
}

function recordBlock(game, info) {
  const key = metaKey(game);
  if (!key) return;
  try { require('./gameMetaStore').setByKey(key, { emu_block: { ...info, at: Date.now() } }); } catch { /* best effort */ }
}

function clearBlock(game) {
  const key = metaKey(game);
  if (!key) return;
  try { require('./gameMetaStore').setByKey(key, { emu_block: null }); } catch { /* best effort */ }
}

function blockFor(game) {
  const key = metaKey(game);
  if (!key) return null;
  try { return require('./gameMetaStore').getByKey(key).emu_block || null; } catch { return null; }
}

module.exports = {
  INTERFACE_RE, REPORT_FILE, RELEASES_URL,
  interfacesInText, interfacesIn, looksLikeEmulator,
  findGameLibraries, wasCracked, isOnline,
  emulatorDir, emulatorLibrary, emulatorInfo,
  check, latestRelease, updateEmulator, ensureCompatible, decide,
  missingInterfaceReports,
  recordBlock, clearBlock, blockFor,
};
