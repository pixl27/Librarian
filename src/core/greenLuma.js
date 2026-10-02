/**
 * GreenLuma launch mode — play as if you owned it, through the real client.
 *
 * The Spacewar path (see onlineMode.js) opens a session under app 480 so two
 * cracked copies can meet. It cannot join a friend who *owns* the game: Steam's
 * overlay-join license gate asks whether you hold a license for the real app,
 * and a 480 session never can — hence "invalid license".
 *
 * GreenLuma answers a different question, one layer down. It is injected into
 * the Steam *client* and patches the client's own ownership calls
 * (CheckAppOwnership, BIsSubscribedApp, the ownership ticket) so the client
 * reports that your account owns whatever App IDs are listed in <Steam>/AppList.
 * The game then runs under its real App ID with a genuine session, and the
 * license gate — a client-side check — passes.
 *
 * Librarian does not ship or reimplement GreenLuma. Reproducing it means
 * injecting into and patching Valve's running client, forging ownership
 * tickets, and chasing every Steam update with fresh byte signatures — the
 * fragile, high-risk client-hook category this project deliberately stays out
 * of. And it does not manage the user's GreenLuma either — an earlier version
 * that ran their injector and edited its ini broke a working setup. This module
 * only lists the App ID, puts the game into a genuine-steam_api state, and
 * launches through Steam once the user has started their own client through
 * GreenLuma. The injector and its config are theirs, untouched.
 *
 * This is the opposite mode to Spacewar and mutually exclusive with it, so
 * enabling it here first clears any Spacewar state the game was left in.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { findSteamInstall } = require('./steamHelpers');
const onlineMode = require('./onlineMode');

const INJECTOR = 'DLLInjector.exe';
const STEAM_API_64 = /^steam_api64\.dll$/i;
const MARKER_DIR = '.DepotDownloader';
const STATE_FILE = 'online-mode.json';

const exists = p => { try { return fs.existsSync(p); } catch { return false; } };

/** Is GreenLuma installed in the Steam folder? */
function detect() {
  const steamPath = findSteamInstall();
  if (!steamPath) return { installed: false, reason: 'Steam installation not found.' };
  const injector = path.join(steamPath, INJECTOR);
  if (!exists(injector)) {
    return {
      installed: false, steamPath,
      reason: `GreenLuma is not in your Steam folder. Put DLLInjector.exe and a GreenLuma_*.dll in ${steamPath}, then try again.`,
    };
  }
  let hasDll = false;
  try { hasDll = fs.readdirSync(steamPath).some(f => /^GreenLuma.*\.dll$/i.test(f)); } catch { /* ignore */ }
  return { installed: true, steamPath, injector, hasDll };
}

/**
 * Whether a running process by that image name exists. tasklist rather than a
 * library so this needs no native dependency; the filter keeps it cheap.
 */
function processRunning(image) {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${image}" /NH`, { encoding: 'utf8', windowsHide: true });
    return new RegExp(image.replace('.', '\\.'), 'i').test(out);
  } catch { return false; }
}

/* The injector stays alive as the client's parent (WaitForProcessTermination),
 * so its presence is a reliable "GreenLuma is currently injected" signal. */
const greenLumaActive = () => processRunning(INJECTOR);
const steamRunning = () => processRunning('steam.exe');

/**
 * The genuine Valve steam_api64.dll for a live file, or null.
 *
 * `.bak` is SteamAutoCrack's untouched copy; `_o.dll` is what our own Steam
 * proxy forwards to — both genuine. The live file itself counts only if it is
 * already genuine. Told apart by the export table: genuine has no forwarders
 * and ~1000+ exports at ~300 KB, the proxy is forwarders at ~140 KB, and
 * Goldberg is ~11 MB — so a size ceiling excludes the emulator.
 */
function isGenuine(p) {
  try {
    const { readExports } = require('../../tools/peExports');
    const ex = readExports(p).exports;
    const forwarders = ex.filter(e => e.forwarder).length;
    const size = fs.statSync(p).size;
    return forwarders === 0 && ex.length > 1000 && size < 2 * 1024 * 1024;
  } catch { return false; }
}

function genuineSource(dll) {
  const bak = dll + '.bak';
  const o = path.join(path.dirname(dll), 'steam_api64_o.dll');
  if (exists(bak) && isGenuine(bak)) return bak;
  if (exists(o) && isGenuine(o)) return o;
  if (isGenuine(dll)) return dll;   // already genuine, nothing to do
  return null;
}

function sameFile(a, b) {
  try {
    const crypto = require('crypto');
    const h = p => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    return h(a) === h(b);
  } catch { return false; }
}

function copyVerified(from, to) {
  fs.copyFileSync(from, to);
  if (fs.statSync(from).size !== fs.statSync(to).size) {
    throw new Error(`copy verification failed for ${path.basename(to)}`);
  }
}

/**
 * Put a game into the state a GreenLuma owned-launch needs: the genuine
 * steam_api64 in place (not our Spacewar proxy, not Goldberg), the game's real
 * App ID in steam_appid.txt, and the online-mode record set so the launch path
 * does not re-apply Spacewar underneath us. Reversible — every original is kept.
 */
function prepareOwnedLaunch(gamePath, exePath, appId) {
  const changed = { dlls: [], appid: 0 };

  // 1. genuine steam_api64 (x64 only; a 32-bit game keeps what it shipped).
  for (const dll of onlineMode.findSteamApiDlls(gamePath)) {
    if (!STEAM_API_64.test(path.basename(dll))) continue;
    const src = genuineSource(dll);
    if (src && !sameFile(dll, src)) {
      // Keep whatever is there now (our proxy) recoverable before overwriting.
      if (!exists(dll + '.spacewar') && !isGenuine(dll)) {
        try { fs.copyFileSync(dll, dll + '.spacewar'); } catch { /* best effort */ }
      }
      copyVerified(src, dll);
      changed.dlls.push(path.basename(path.dirname(dll)) + '/' + path.basename(dll));
    }
  }

  // 2. steam_appid.txt = the real App ID, at the root and beside every exe.
  const write = (dir) => {
    try { fs.writeFileSync(path.join(dir, 'steam_appid.txt'), String(appId)); changed.appid++; } catch { /* ignore */ }
  };
  write(gamePath);
  if (exePath) write(path.dirname(exePath));

  // 3. online-mode record → a non-online mode so reapplyIfNeeded() leaves the
  //    files alone rather than forcing Spacewar back on at launch.
  try {
    const dir = path.join(gamePath, MARKER_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const statePath = path.join(dir, STATE_FILE);
    if (exists(statePath) && !exists(statePath + '.spacewar-backup')) {
      try { fs.copyFileSync(statePath, statePath + '.spacewar-backup'); } catch { /* ignore */ }
    }
    fs.writeFileSync(statePath, JSON.stringify({ mode: 'greenluma', realAppId: String(appId), at: 0 }, null, 2));
  } catch { /* the files on disk are the truth; the record is a convenience */ }

  // 4. Make sure the App ID (and its content depots) are in GreenLuma's AppList
  //    so the injected client reports ownership of it.
  try {
    const { addGreenLumaFiles } = require('./gameManager');
    addGreenLumaFiles(appId, []);
  } catch { /* AppList may already have it; a warning is not worth failing over */ }

  return changed;
}



/**
 * Launch a game through GreenLuma.
 *
 * @param {object} game     the game record (install_path, appid, ...)
 * @param {string} exePath  resolved executable, for locating steam_appid.txt dirs
 * @returns {Promise<{success:boolean, ...}>}
 */
async function launch(game, exePath) {
  const d = detect();
  if (!d.installed) return { success: false, error: d.reason, needsGreenLuma: true, steamPath: d.steamPath };

  const appId = onlineMode.realAppId(game.install_path) || String(game.appid || '').trim();
  if (!/^\d{1,20}$/.test(appId) || appId === '0') {
    return { success: false, error: 'Could not determine the game’s real App ID.' };
  }

  try {
    prepareOwnedLaunch(game.install_path, exePath, appId);
  } catch (err) {
    return { success: false, error: `Could not prepare the game for GreenLuma: ${err.message}` };
  }

  // GreenLuma only spoofs ownership when the client was started through the
  // injector. We do NOT start it or touch its config: it is the user's tool,
  // launched their way, and an earlier version of this driving it (wrong
  // working directory, then editing DLLInjector.ini) broke a setup that worked.
  // If it is not already active, prep the game and tell the user to start Steam
  // through GreenLuma themselves — never restart their client from under them.
  if (!greenLumaActive()) {
    return {
      success: false,
      needsGreenLumaRunning: true,
      error: 'Start Steam through your GreenLuma injector (DLLInjector.exe) first, then press Play again. The game is ready.',
    };
  }

  const { shell } = require('electron');
  await shell.openExternal(`steam://rungameid/${appId}`);
  return { success: true, method: 'greenluma', appId };
}

module.exports = { detect, greenLumaActive, steamRunning, prepareOwnedLaunch, launch };
