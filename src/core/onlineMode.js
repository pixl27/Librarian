/**
 * Online mode — play through a real Steam session instead of the emulator.
 *
 * Steamworks resolves an App ID from `steam_appid.txt` in the working
 * directory when a game isn't started by Steam. That is documented Valve
 * behaviour for developers, and it is also what makes
 * SteamAPI_RestartAppIfNecessary return false instead of bouncing the game
 * back through the client. Every account owns Spacewar (480), so a game
 * reporting 480 to a running, logged-in client gets a valid session — and with
 * it Valve's real lobbies, P2P and relay rather than an emulation of them.
 *
 * That means the *original* steam_api DLL has to be back in place: the whole
 * point is to talk to Steam, not to Goldberg. So this is a mode switch, not an
 * addition, and it is reversible — the emulator DLLs are kept beside the
 * originals so a game can be flipped back without re-cracking.
 *
 * What it does not do: defeat anti-cheat, or help a game whose matchmaking is
 * the publisher's rather than Valve's. `multiplayer.js` decides eligibility;
 * this module only performs the switch.
 */

const fs = require('fs');
const path = require('path');

const SPACEWAR_APPID = '480';
const MARKER_DIR = '.DepotDownloader';
const STATE_FILE = 'online-mode.json';
const STARTUP_BLOCK_FILE = 'online-startup-block.json';

// SteamAutoCrack leaves the untouched original beside the one it installed.
const ORIGINAL_SUFFIX = '.bak';
// Our own copy of the emulator, so switching back needs no re-crack.
const EMU_SUFFIX = '.goldberg';
// Whatever steam_appid.txt was there before we wrote 480 over it.
const APPID_BACKUP = 'steam_appid.librarian.bak';

const STEAM_API = /^steam_api(64)?\.dll$/i;
const SKIP_DIR = /^(_commonredist|redist|directx|dotnet|vcredist|__pycache__|node_modules)$/i;

function markerDir(gamePath) { return path.join(gamePath, MARKER_DIR); }
function statePath(gamePath) { return path.join(markerDir(gamePath), STATE_FILE); }

// Confirmed startup failures are per-install evidence, separate from the
// requested mode. Turning the mode off must not erase why it failed.
function getStartupBlock(gamePath) {
  try {
    const block = JSON.parse(fs.readFileSync(path.join(markerDir(gamePath), STARTUP_BLOCK_FILE), 'utf8'));
    if (block.version !== 1 || block.sessionAppId !== SPACEWAR_APPID || block.kind !== 'app-id-rejected') return null;
    return { reason: 'This game rejected online mode\'s Steam App ID at startup. Keep offline mode enabled or use its normal Steam installation.', at: block.at };
  } catch { return null; }
}

function readState(gamePath) {
  try { return JSON.parse(fs.readFileSync(statePath(gamePath), 'utf-8')); } catch { return null; }
}

function writeState(gamePath, state) {
  try {
    fs.mkdirSync(markerDir(gamePath), { recursive: true });
    fs.writeFileSync(statePath(gamePath), JSON.stringify(state, null, 2));
  } catch { /* state is a convenience; the files on disk are the truth */ }
}

/**
 * Every live steam_api DLL in the install (never the backups).
 *
 * The depth limit used to be 4, which was enough for Unity — it keeps the
 * library two levels down in `<Game>_Data/Plugins/x86_64`. Unreal buries it at
 * `Engine/Binaries/ThirdParty/Steamworks/Steamv157/Win64`, six levels down, so
 * the scan silently found nothing and the swap reported success having done
 * nothing at all. Engine layouts vary more than any fixed small number allows.
 */
function findSteamApiDlls(gamePath, depth = 0, out = []) {
  if (depth > 8) return out;
  let entries;
  try { entries = fs.readdirSync(gamePath, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(gamePath, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR.test(entry.name) || entry.name.startsWith('.')) continue;
      findSteamApiDlls(full, depth + 1, out);
    } else if (entry.isFile() && STEAM_API.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const exists = p => { try { return fs.existsSync(p); } catch { return false; } };

/**
 * Copy and prove it landed. A half-written steam_api DLL is a game that will
 * not start, so every swap is size-checked before it counts as done.
 */
function copyVerified(from, to) {
  fs.copyFileSync(from, to);
  const a = fs.statSync(from).size;
  const b = fs.statSync(to).size;
  if (a !== b) throw new Error(`copy verification failed for ${path.basename(to)} (${a} vs ${b} bytes)`);
}

/**
 * What state is this install in, and can it be switched?
 * @param {string} gamePath
 * @param {string} exePath - the executable Librarian would launch; its folder
 *                           is the working directory Steamworks reads from.
 */
function getStatus(gamePath, exePath) {
  const dlls = findSteamApiDlls(gamePath);
  const parts = dlls.map(dll => ({
    dll,
    hasOriginal: exists(dll + ORIGINAL_SUFFIX),
    hasEmulator: exists(dll + EMU_SUFFIX),
  }));

  const appIdFile = exePath ? path.join(path.dirname(exePath), 'steam_appid.txt') : null;
  let appIdValue = null;
  if (appIdFile && exists(appIdFile)) {
    try { appIdValue = fs.readFileSync(appIdFile, 'utf-8').trim(); } catch { /* unreadable */ }
  }

  const state = readState(gamePath);
  /*
   * The files decide, not the bookkeeping: the state file can be stale if a
   * game was re-cracked or restored outside Librarian.
   *
   * One shape is exempt. An install whose identity belongs to its own loader is
   * switched on by writing no files at all — that is the whole point, see
   * enableOnline — so there is nothing on disk to read back and the record is
   * the state. Reading files there would report "offline" the instant after the
   * player switched it on.
   */
  const preserved = !!(state && state.mode === 'online' && state.identity === 'loader');
  const online = preserved || appIdValue === SPACEWAR_APPID;

  return {
    mode: online ? 'online' : 'offline',
    identity: preserved ? 'loader' : null,
    appId: appIdValue,
    appIdFile,
    dlls: parts,
    // Nothing to restore means the game was never cracked; the live DLL is
    // already the real one, so only the App ID file is needed.
    canEnable: !!appIdFile && (parts.length === 0 || parts.some(p => p.hasOriginal) || parts.length > 0),
    canDisable: online && parts.some(p => p.hasEmulator),
    recordedAt: state ? state.at : null,
  };
}

/*
 * Installs whose Steam identity already belongs to their own loader.
 *
 * Measured on Monster Hunter Wilds (2246340), 2026-09-15. That install runs
 * through a ColdClient loader — `version.dll`, a local `steamclient64.dll`, and
 * `steam_settings/configs.user.ini` naming account 76561199799722711 — and it
 * carries a Denuvo activation token at `userdata/1839456983/2246340/…`, where
 * 1839456983 is that same account. The token is checked against the identity
 * the live session reports.
 *
 * Switching it on did what this module does everywhere else: put our proxy in
 * front of steam_api64 and write `steam_appid.txt = 480`. The game then died
 * about three seconds into every launch, inside the executable itself, at an
 * offset that moved between runs — Denuvo's mutated code taking the failure
 * path — immediately after its PathFileExistsW on that token. The same install
 * launched without the switch reached gameplay, and the crash dumps name the
 * difference exactly: the only Librarian module in the failing process was
 * `steam_api64_o.dll`, and it is absent from the working run's dump.
 *
 * Refusing the toggle would be the easy answer and it is the wrong one — the
 * player asked for online mode, not for an explanation. What is actually true
 * is narrower: for this shape of install the *session swap* is impossible, not
 * the mode. So the mode is recorded and the identity is left exactly as the
 * loader set it. The game launches, `autoCrack.wantsOnline` and
 * `emuCompat.decide` both read the recorded state and leave the install alone,
 * and nothing here ever writes 480 into a folder that would die on it.
 *
 * What it cannot do is conjure a Steam session this account is not entitled to.
 * For Wilds specifically the publisher's own sign-in refuses it anyway: the
 * probe caught `POST mtm.rebe.capcom.com/v1/steam-steam/sign/EAR-P-WW` coming
 * back 401.
 */
function identityOwner(gamePath) {
  try { return require('./multiplayer').detectDrmLoader(gamePath); }
  catch { return null; }
}

/** Switch to a real Steam session under Spacewar. */
function enableOnline(gamePath, exePath, playerName) {
  if (!exePath) return { success: false, error: 'No executable resolved for this game.' };

  // Before anything is resolved or copied: this shape of install is switched on
  // by recording it, never by swapping libraries. Deliberately ahead of the
  // valheimOnline require as well, so the path stays free of Electron-only
  // dependencies and can be exercised by dev/verify-online-identity.mjs.
  const owner = identityOwner(gamePath);
  if (owner) {
    writeState(gamePath, {
      mode: 'online', identity: 'loader', loader: owner.marks, token: owner.token, at: Date.now(),
    });
    return { success: true, preserved: owner, swapped: 0 };
  }

  const valheim = require('./valheimOnline');
  const block = getStartupBlock(gamePath);
  if (block && !valheim.applicable(gamePath)) return { success: false, error: block.reason };
  const status = getStatus(gamePath, exePath);
  const swapped = [];

  try {
    // Resolve every original and generate every export table before changing
    // the App ID or any game DLL. A compatibility failure must leave mode alone.
    for (const part of getSteamProxyStatus(gamePath)) {
      if (!part.genuine) throw new Error(`cannot find an untouched ${path.basename(part.dll)}`);
      prepareSteamProxy(part.genuine);
    }
    const managed = valheim.ensure(gamePath);
    if (!managed.success) return managed;
    for (const part of status.dlls) {
      if (!part.hasOriginal) continue;      // never cracked — already the real DLL
      // A game update can leave an old .bak beside a newer genuine DLL.
      // Never restore that old backup over the newly downloaded Steamworks.
      if (STEAM_API_64.test(path.basename(part.dll)) && genuineSteamSource(part.dll) === part.dll) continue;

      /*
       * Already the genuine library, so there is nothing to swap.
       *
       * Skipping is not just an optimisation. The copy would rewrite a file the
       * game holds open whenever it is running, failing with EBUSY and taking
       * the whole switch down over work that would have changed nothing. It
       * also protects the backup below: with no .goldberg yet, copying the live
       * file would file the *genuine* DLL away as the emulator, and switching
       * back would then restore the wrong one.
       */
      if (sameFile(part.dll, part.dll + ORIGINAL_SUFFIX)) continue;

      /*
       * Our own proxy is already in that slot, which is the online state, not
       * something to undo. Restoring over it would also file the proxy away as
       * the emulator below, so switching back would install a forwarder with
       * nothing to forward to.
       */
      if (isOurSteamProxy(part.dll)) continue;

      if (!part.hasEmulator) copyVerified(part.dll, part.dll + EMU_SUFFIX);
      copyVerified(part.dll + ORIGINAL_SUFFIX, part.dll);
      swapped.push(part.dll);
    }

    // Preserve anything already there before claiming the filename.
    const appIdFile = status.appIdFile;
    const backup = path.join(markerDir(gamePath), APPID_BACKUP);
    fs.mkdirSync(markerDir(gamePath), { recursive: true });
    if (exists(appIdFile) && !exists(backup)) {
      const current = fs.readFileSync(appIdFile, 'utf-8').trim();
      if (current !== SPACEWAR_APPID) fs.writeFileSync(backup, current);
    }
    fs.writeFileSync(appIdFile, SPACEWAR_APPID);

    const appId = realAppId(gamePath);

    // EOS games need the proxy as well; Steam-only games skip it harmlessly.
    const eos = enableEos(gamePath, playerName, appId);
    if (!eos.success) return { success: false, error: eos.error, swapped: swapped.length };

    // And the mirror image: the answers a Spacewar session gets wrong about the
    // game itself. Harmless for an EOS title, which simply never asks.
    const steam = enableSteamProxy(gamePath, appId, playerName);
    if (!steam.success) return { success: false, error: steam.error, swapped: swapped.length };

    // The overlay needs to load before the graphics device; the proxies above
    // load it too late in a Unity game. A winmm proxy beside the exe fixes the
    // timing. Failure here never fails the switch — the session and lobbies are
    // what matter; the overlay is a convenience on top.
    const overlay = enableWinmmOverlay(exePath, playerName, appId);

    writeState(gamePath, {
      mode: 'online', appId: SPACEWAR_APPID, realAppId: appId, swapped, appIdFile,
      eos: !eos.skipped, steam: !steam.skipped, winmm: !!overlay.installed || !!overlay.alreadyInstalled,
      at: Date.now(),
    });
    // The old 480 startup rejection has been addressed by the managed adapter.
    if (!managed.skipped && block) {
      fs.renameSync(path.join(markerDir(gamePath), STARTUP_BLOCK_FILE), path.join(markerDir(gamePath), STARTUP_BLOCK_FILE + '.resolved'));
    }
    return { success: true, swapped: swapped.length, appIdFile, eos, steam, overlay };
  } catch (err) {
    return { success: false, error: err.message, swapped: swapped.length };
  }
}

/** Put the emulator back and stop reporting Spacewar. */
function disableOnline(gamePath, exePath) {
  const status = getStatus(gamePath, exePath);
  const restored = [];

  try {
    // Before the emulator goes back, so a game with no emulator to return to
    // still gets its genuine library out of _o.dll rather than keeping a proxy.
    const steam = disableSteamProxy(gamePath);
    disableWinmmOverlay(exePath);

    for (const part of status.dlls) {
      if (!part.hasEmulator) continue;
      copyVerified(part.dll + EMU_SUFFIX, part.dll);
      restored.push(part.dll);
    }

    const appIdFile = status.appIdFile;
    const backup = path.join(markerDir(gamePath), APPID_BACKUP);
    if (appIdFile && exists(appIdFile)) {
      if (exists(backup)) {
        fs.writeFileSync(appIdFile, fs.readFileSync(backup, 'utf-8').trim());
        fs.unlinkSync(backup);
      } else if (fs.readFileSync(appIdFile, 'utf8').trim() === SPACEWAR_APPID) {
        // We introduced this file; remove it rather than leave a stray 480.
        fs.unlinkSync(appIdFile);
      }
    }

    const eos = disableEos(gamePath);

    /*
     * Take our own ini back out.
     *
     * Nothing used to remove it: refreshOnlineConfig early-returns once the
     * mode is off, so every game switched online and back kept a
     * librarian_online.ini reading session_appid=480, spoof_appid=1 forever.
     * That is not cosmetic — it is an offline install carrying a file that says
     * it is online, and it sent a Monster Hunter Wilds investigation looking for
     * a session swap that had already been undone.
     *
     * Only files bearing our own header are removed; a name collision with
     * something else's config must survive untouched.
     */
    const ours = '; Written by Librarian';
    const inis = new Set([exePath ? path.dirname(exePath) : null, gamePath]);
    for (const part of getSteamProxyStatus(gamePath)) inis.add(path.dirname(part.dll));
    for (const dir of inis) {
      if (!dir) continue;
      const ini = path.join(dir, 'librarian_online.ini');
      try {
        if (exists(ini) && fs.readFileSync(ini, 'utf8').startsWith(ours)) fs.unlinkSync(ini);
      } catch { /* leaving a stale ini is better than failing the switch back */ }
    }

    const managed = require('./valheimOnline').disable(gamePath);
    if (!managed.success) return managed;

    writeState(gamePath, { mode: 'offline', restored, at: Date.now() });
    return { success: true, restored: restored.length, eos, steam };
  } catch (err) {
    return { success: false, error: err.message, restored: restored.length };
  }
}

/* ── EOS side ─────────────────────────────────────────────────────
 * Games whose multiplayer runs on Epic Online Services need a second piece.
 * The Spacewar session gets them as far as asking EOS to log in, but the Steam
 * ticket they present is issued for app 480 while Epic validates it against
 * the game's real id — so Epic answers 7000,
 * EOS_Connect_ExternalTokenValidationFailed, and co-op never starts. That is
 * measured, not assumed: it is what the trace showed on both games tested.
 *
 * The proxy re-exports every SDK symbol as a loader forwarder to the genuine
 * library (renamed _o.dll) and intercepts exactly one call, swapping the
 * doomed Steam ticket for EOS's own anonymous Device ID credential. Epic
 * accepts it, and the session it returns is real — which is why the Join Code
 * a host shares works over the internet rather than only on a LAN.
 */
const EOS_SDK_NAME = 'EOSSDK-Win64-Shipping.dll';
const EOS_ORIGINAL = 'EOSSDK-Win64-Shipping_o.dll';

function findEosSdk(gamePath, depth = 0) {
  if (depth > 8) return null;
  let entries;
  try { entries = fs.readdirSync(gamePath, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const full = path.join(gamePath, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === EOS_SDK_NAME.toLowerCase()) return full;
    if (entry.isDirectory() && !SKIP_DIR.test(entry.name) && !entry.name.startsWith('.')) {
      const hit = findEosSdk(full, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Where Librarian keeps the proxies it built. */
function proxyPath(name) {
  try {
    const { getDepsPath } = require('./runtimePaths');
    return getDepsPath('librarian', name);
  } catch {
    return path.join(__dirname, '..', '..', 'deps', 'librarian', name);
  }
}

/**
 * A proxy must export everything the game's own SDK does, or the first missing
 * entry point takes the game down. The shipped binary is built against one SDK
 * version; a game with a newer one may want symbols it lacks, so this is
 * checked before anything is swapped rather than discovered at runtime.
 */
function eosProxyCovers(gameSdk) {
  const proxy = proxyPath(EOS_SDK_NAME);
  if (!exists(proxy)) return { ok: false, reason: 'the EOS proxy is missing from this build' };
  try {
    const { readExports } = require('../../tools/peExports');
    const have = new Set(readExports(proxy).exports.map(e => e.name));
    const need = readExports(gameSdk).exports.map(e => e.name);
    const missing = need.filter(n => !have.has(n));
    if (missing.length) {
      return { ok: false, reason: `this game ships a newer EOS SDK (${missing.length} symbols the proxy lacks)`, missing };
    }
    return { ok: true, exports: need.length };
  } catch (err) {
    return { ok: false, reason: `could not compare the SDKs: ${err.message}` };
  }
}

/**
 * Is the live SDK ours?
 *
 * `_o.dll` exists` was the old test, and it is not the same question. A game
 * update overwrites the SDK in place and leaves the backup untouched, so the
 * pair reads as installed while the proxy is gone — which is exactly the case
 * this is here to catch. Forwarders pointing at _o.dll are only ever something
 * we generated.
 */
function isOurProxy(file) {
  try {
    const { readExports } = require('../../tools/peExports');
    return readExports(file).exports
      .some(e => e.forwarder && e.forwarder.toLowerCase().startsWith(EOS_ORIGINAL.replace(/\.dll$/i, '').toLowerCase() + '.'));
  } catch {
    /*
     * The export reader could not run — a packaging slip has done this once
     * already. Answering "no" would be a wrong answer rather than a missing
     * one: it makes an installed proxy look absent, which sends the caller
     * into a coverage check it cannot pass, and the toggle fails with the
     * internal error as its reason.
     *
     * Size settles it nearly as well. A genuine EOS SDK is ~18 MB; the proxy
     * is under 100 KB, because it is forwarders and five functions.
     */
    try { return fs.statSync(file).size < 1024 * 1024; } catch { return false; }
  }
}

function sameFile(a, b) {
  try {
    const crypto = require('crypto');
    const h = p => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    return h(a) === h(b);
  } catch { return false; }
}

function getEosStatus(gamePath) {
  const sdk = findEosSdk(gamePath);
  if (!sdk) return { present: false };
  const dir = path.dirname(sdk);
  const original = path.join(dir, EOS_ORIGINAL);
  const installed = exists(original) && isOurProxy(sdk);
  // Librarian ships proxy improvements; a game switched on last month is still
  // running whatever was current then, and nothing would ever tell it otherwise.
  const stale = installed && !sameFile(sdk, proxyPath(EOS_SDK_NAME));
  return {
    present: true,
    sdk,
    original,
    installed,
    stale,
    coverage: installed ? { ok: true } : eosProxyCovers(sdk),
  };
}

/**
 * Whether to pull Steam's overlay in — see native/overlay/overlay.c.
 *
 * Off when the setting cannot be read at all: a game that runs today should
 * not acquire an extra library because a lookup failed.
 */
function overlayEnabled() {
  try { return require('./settingsStore').get('online_steam_overlay') !== false; }
  catch { return false; }
}

/**
 * The proxies' only channel back from Librarian.
 *
 * Device ID auth is anonymous, so EOS has no name to show and every player in a
 * lobby appears identically — that is what player_name is for. The overlay flag
 * is here rather than compiled in so the Settings checkbox reaches a game that
 * is already switched on, without needing a toggle off and back.
 */
function writeOnlineIni(dir, playerName, appId) {
  const name = String(playerName || '').trim().slice(0, 48) || 'Player';
  let body = '; Written by Librarian on every launch — edits here will be overwritten.\n'
    + `player_name=${name}\n`
    + `steam_overlay=${overlayEnabled() ? 1 : 0}\n`
    + `session_appid=${SPACEWAR_APPID}\n`;
  /*
   * The game's own App ID, for the Steam proxy only.
   *
   * Without it the proxy cannot answer "what app am I?" with anything but 480,
   * and lobby scoping has no key to stamp — so every lobby lands in Spacewar's
   * shared space alongside every other game doing this. session_appid above is
   * the opposite number: the app the *session* belongs to.
   */
  if (appId && /^\d+$/.test(String(appId))) {
    body += `appid=${appId}\n`
      + 'own_everything=1\n'
      + 'spoof_appid=1\n';
  }
  try { fs.writeFileSync(path.join(dir, 'librarian_online.ini'), body); }
  catch { /* a missing name only costs a default, never the session */ }
  return name;
}

/** The game's real App ID, for the Steam proxy's answers. */
function realAppId(gamePath) {
  try {
    const { appIdFromLibraryManifest } = require('./autoCrack');
    const hit = appIdFromLibraryManifest(gamePath);
    return hit ? hit.appId : null;
  } catch { return null; }
}

/**
 * Push current settings to a game that is already online.
 *
 * enableOnline writes this file, but a game only passes through there when it
 * is switched on or has drifted. Changing your name or the overlay setting has
 * to reach the ones already running too, and launch is when that can happen.
 */
function refreshOnlineConfig(gamePath, playerName, exePath) {
  const state = readState(gamePath);
  if (!state || state.mode !== 'online') return { refreshed: false };

  // One file per proxy directory, not one per game: each DLL reads the ini
  // beside itself, and the EOS SDK, steam_api64 and the winmm loader rarely
  // share a folder.
  const appId = state.realAppId || realAppId(gamePath);
  const dirs = new Set();
  const eos = getEosStatus(gamePath);
  if (eos.present && eos.installed) dirs.add(path.dirname(eos.sdk));
  for (const part of getSteamProxyStatus(gamePath)) {
    if (part.installed) dirs.add(path.dirname(part.dll));
  }
  // The winmm loader sits beside the exe and reads the overlay flag from there.
  if (exePath && getWinmmStatus(exePath).installed) dirs.add(path.dirname(exePath));
  for (const dir of dirs) writeOnlineIni(dir, playerName, appId);
  return { refreshed: dirs.size > 0, dirs: dirs.size };
}

function enableEos(gamePath, playerName, appId) {
  const st = getEosStatus(gamePath);
  if (!st.present) return { success: true, skipped: 'no EOS SDK in this game' };
  if (st.installed && !st.stale) {
    // Already installed, but the name may have changed since.
    writeOnlineIni(path.dirname(st.sdk), playerName, appId);
    return { success: true, alreadyInstalled: true };
  }
  if (st.installed && st.stale) {
    // Only the proxy is replaced. The genuine SDK is already safe under _o and
    // must not be touched — copying the live file over it now would bury it
    // under our own proxy and leave the forwarders pointing at themselves.
    try {
      copyVerified(proxyPath(EOS_SDK_NAME), st.sdk);
      writeOnlineIni(path.dirname(st.sdk), playerName, appId);
      return { success: true, refreshed: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  if (!st.coverage.ok) return { success: false, error: st.coverage.reason };

  try {
    // Keep the genuine library under the name the proxy forwards to, then take
    // its place. Order matters: never overwrite before the original is safe.
    fs.copyFileSync(st.sdk, st.original);
    copyVerified(proxyPath(EOS_SDK_NAME), st.sdk);
    writeOnlineIni(path.dirname(st.sdk), playerName, appId);
    return { success: true, sdk: st.sdk };
  } catch (err) {
    // Put it back rather than leaving a game with no SDK at all.
    try { if (exists(st.original)) fs.copyFileSync(st.original, st.sdk); } catch {}
    return { success: false, error: err.message };
  }
}

function disableEos(gamePath) {
  const st = getEosStatus(gamePath);
  if (!st.present || !st.installed) return { success: true };
  try {
    copyVerified(st.original, st.sdk);
    fs.unlinkSync(st.original);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/* ── Steam side ───────────────────────────────────────────────────
 * Restoring the genuine steam_api64.dll gets a real Spacewar session, and for
 * a game whose multiplayer runs on Epic that is enough — the EOS proxy does the
 * rest. For a game whose multiplayer is Valve's own it is not, because the
 * session belongs to app 480 and the game keeps asking about itself:
 *
 *     "do I own 2661300?"   -> Steam answers no
 *     "what app am I?"      -> Steam answers 480
 *
 * A text file cannot change those answers; only something in the call path can.
 * That is native/steamproxy: a small set of implementations plus Windows
 * loader forwarders to the genuine library renamed _o.dll. steamProxyAdapter
 * generates the exact name/ordinal surface from each game's current SDK.
 *
 * OnlineFix reaches the same place from the other side: it leaves steam_api64
 * alone and substitutes steamclient64 underneath it, listing the interfaces it
 * serves in an ini. Same questions, one layer down.
 *
 * Only ever x64. The proxy is a 64-bit binary and a 32-bit game loading
 * steam_api.dll must keep the library it shipped with.
 */
const STEAM_PROXY_NAME = 'steam_api64.dll';
const STEAM_PROXY_ORIGINAL = 'steam_api64_o.dll';
const STEAM_API_64 = /^steam_api64\.dll$/i;

function isOurSteamProxy(file) {
  const stem = STEAM_PROXY_ORIGINAL.replace(/\.dll$/i, '').toLowerCase();
  try {
    const { readExports } = require('../../tools/peExports');
    return readExports(file).exports
      .some(e => e.forwarder && e.forwarder.toLowerCase().startsWith(stem + '.'));
  } catch {
    // No size heuristic here: the proxy (137 KB) and the genuine library
    // (295 KB) are the same order of magnitude, so guessing by size could
    // mistake the real one for ours and bury it. An exact match against the
    // shipped copy only recognises the current build, which is the safe way to
    // be wrong — the worst case is reinstalling a proxy that was already fine.
    return sameFile(file, proxyPath(STEAM_PROXY_NAME));
  }
}

function prepareSteamProxy(genuine) {
  const { adaptProxy } = require('./steamProxyAdapter');
  return adaptProxy(fs.readFileSync(proxyPath(STEAM_PROXY_NAME)), fs.readFileSync(genuine));
}

function writeProxyVerified(bytes, destination) {
  const temp = `${destination}.librarian-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx' });
    if (!fs.readFileSync(temp).equals(bytes)) throw new Error('Steam proxy write verification failed');
    fs.renameSync(temp, destination);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

/** Generate and verify the game's exact exports, including ordinal-only APIs. */
function steamProxyCovers(genuine) {
  const proxy = proxyPath(STEAM_PROXY_NAME);
  if (!exists(proxy)) return { ok: false, reason: 'the Steam proxy is missing from this build' };
  try {
    prepareSteamProxy(genuine);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `could not compare the libraries: ${err.message}` };
  }
}

/**
 * Where to get the untouched library from, for a given live steam_api64.dll.
 *
 * A live original wins over stale backups after an update. An installed proxy
 * uses _o.dll; an emulator uses .bak. Never use the proxy as its own original.
 */
function genuineSteamSource(dll) {
  const original = path.join(path.dirname(dll), STEAM_PROXY_ORIGINAL);
  if (isOurSteamProxy(dll)) return exists(original) ? original : null;
  const { looksLikeEmulator } = require('./emuCompat');
  if (!looksLikeEmulator(dll) && !sameFile(dll, dll + EMU_SUFFIX)) return dll;
  const backup = dll + ORIGINAL_SUFFIX;
  if (exists(backup) && !isOurSteamProxy(backup) && !looksLikeEmulator(backup)) return backup;
  return null;
}

function getSteamProxyStatus(gamePath) {
  const parts = [];
  for (const dll of findSteamApiDlls(gamePath)) {
    if (!STEAM_API_64.test(path.basename(dll))) continue;   // 32-bit: leave alone
    const original = path.join(path.dirname(dll), STEAM_PROXY_ORIGINAL);
    const installed = exists(original) && isOurSteamProxy(dll);
    const genuine = genuineSteamSource(dll);
    let stale = false;
    if (installed) {
      try { stale = !fs.readFileSync(dll).equals(prepareSteamProxy(genuine)); }
      catch { stale = true; }
    }
    parts.push({
      dll,
      original,
      installed,
      stale,
      genuine,
    });
  }
  return parts;
}

function enableSteamProxy(gamePath, appId, playerName) {
  const parts = getSteamProxyStatus(gamePath);
  if (!parts.length) return { success: true, skipped: 'no 64-bit steam_api in this game' };

  const prepared = new Map();
  try {
    for (const part of parts) {
      if (!part.genuine) throw new Error(`cannot find an untouched ${path.basename(part.dll)} to fall back on`);
      prepared.set(part.dll, prepareSteamProxy(part.genuine));
    }
  } catch (err) { return { success: false, error: err.message }; }
  let installed = 0, refreshed = 0;
  for (const part of parts) {
    try {
      if (part.installed && !part.stale) { writeOnlineIni(path.dirname(part.dll), playerName, appId); continue; }

      if (part.installed && part.stale) {
        // The genuine library is already safe under _o.dll; only swap the proxy.
        writeProxyVerified(prepared.get(part.dll), part.dll);
        writeOnlineIni(path.dirname(part.dll), playerName, appId);
        refreshed++;
        continue;
      }

      if (!part.genuine) {
        return { success: false, error: `cannot find an untouched ${path.basename(part.dll)} to fall back on` };
      }
      // Order matters: the original has to be safe before its name is taken.
      copyVerified(part.genuine, part.original);
      // Refresh the old offline backup too: future toggles must not resurrect
      // the Steamworks version from before the game's update.
      if (part.genuine === part.dll && exists(part.dll + ORIGINAL_SUFFIX)) copyVerified(part.genuine, part.dll + ORIGINAL_SUFFIX);
      writeProxyVerified(prepared.get(part.dll), part.dll);
      writeOnlineIni(path.dirname(part.dll), playerName, appId);
      installed++;
    } catch (err) {
      // Put the game back rather than leave it with no Steam library at all.
      try { if (exists(part.original)) fs.copyFileSync(part.original, part.dll); } catch {}
      return { success: false, error: err.message };
    }
  }
  return { success: true, installed, refreshed };
}

function disableSteamProxy(gamePath) {
  const restored = [];
  for (const part of getSteamProxyStatus(gamePath)) {
    if (!exists(part.original)) continue;
    try {
      // The caller restores the emulator over the live file for a cracked game;
      // this only has to matter when there is no emulator to go back to.
      if (!exists(part.dll + EMU_SUFFIX)) copyVerified(part.original, part.dll);
      fs.unlinkSync(part.original);
      restored.push(part.dll);
    } catch { /* leave it; the next enable will sort it out */ }
  }
  return { success: true, restored: restored.length };
}

/* ── Overlay early-load (winmm) ────────────────────────────────────
 * Restoring the genuine steam_api64 and setting Spacewar gets a real session,
 * but not the overlay. Steam injects that when *it* launches a game; we launch
 * the exe directly, so the game's own steam_api64 (or EOS SDK) can load the
 * renderer — only when the game first calls into it, which in a Unity title is
 * after the D3D device already exists. The renderer loads, finds the swapchain
 * built, and gives up. Measured on PEAK: loaded, never attached.
 *
 * winmm.dll is imported statically by UnityPlayer and most engines, so a copy
 * in the exe's own directory is mapped at process start, before any graphics
 * device. Planting our winmm proxy there gets the overlay loaded early enough
 * to attach. This is the one mechanism OnlineFix and we share by necessity —
 * but where their winmm pulls in a game-specific patch, ours only starts the
 * same overlay loader the other proxies use, and forwards all 180 exports to a
 * byte copy of the genuine library.
 */
const WINMM_PROXY = 'winmm.dll';
const WINMM_ORIGINAL = 'winmm_o.dll';
const SYSTEM_WINMM = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'winmm.dll');

/** A live winmm.dll whose exports forward to winmm_o is one we installed. */
function isOurWinmmProxy(file) {
  try {
    const { readExports } = require('../../tools/peExports');
    return readExports(file).exports
      .some(e => e.forwarder && e.forwarder.toLowerCase().startsWith('winmm_o.'));
  } catch { return false; }
}

/**
 * Is this a 64-bit executable? The proxy is x64, and planting it beside a
 * 32-bit game would make the game's winmm import fail to load and the process
 * die at start — the opposite of harmless. A game we cannot read is treated as
 * "not safe to plant", because guessing wrong here breaks the launch.
 */
function exeIsX64(exePath) {
  try {
    const fd = fs.openSync(exePath, 'r');
    const buf = Buffer.alloc(0x40);
    fs.readSync(fd, buf, 0, 0x40, 0);
    const peOff = buf.readUInt32LE(0x3c);
    const machine = Buffer.alloc(2);
    fs.readSync(fd, machine, 0, 2, peOff + 4);
    fs.closeSync(fd);
    return machine.readUInt16LE(0) === 0x8664;   // IMAGE_FILE_MACHINE_AMD64
  } catch { return false; }
}

function winmmProxyPath() { return proxyPath(WINMM_PROXY); }

/**
 * Plant the winmm proxy beside the executable so the overlay loads early.
 *
 * Refuses in the cases where it would do harm rather than nothing:
 *   · overlay turned off — there is no reason to add a library
 *   · a 32-bit game — wrong-architecture winmm is a failed launch
 *   · a winmm.dll already there that is not ours — a ReShade or mod loader
 *     chains through winmm too, and clobbering it breaks the user's setup
 */
function enableWinmmOverlay(exePath, playerName, appId) {
  if (!exePath || !overlayEnabled()) return { success: true, skipped: 'overlay off' };
  if (!exists(winmmProxyPath())) return { success: true, skipped: 'winmm proxy missing from build' };
  if (!exeIsX64(exePath)) return { success: true, skipped: '32-bit game' };

  const dir = path.dirname(exePath);
  const live = path.join(dir, WINMM_PROXY);
  const original = path.join(dir, WINMM_ORIGINAL);

  if (exists(live) && !isOurWinmmProxy(live)) {
    return { success: true, skipped: 'a foreign winmm.dll is already present' };
  }

  const stale = exists(live) && isOurWinmmProxy(live) && !sameFile(live, winmmProxyPath());
  if (exists(live) && !stale) {
    // Already ours and current; only the config beside it may have moved on.
    writeOnlineIni(dir, playerName, appId);
    return { success: true, alreadyInstalled: true };
  }

  try {
    // The genuine System32 winmm becomes the forward target. Copy it first;
    // never take the winmm.dll name before winmm_o is in place, or a forwarder
    // could resolve to nothing.
    if (!exists(original)) copyVerified(SYSTEM_WINMM, original);
    copyVerified(winmmProxyPath(), live);
    writeOnlineIni(dir, playerName, appId);   // overlay.c reads this beside itself
    return { success: true, installed: true, stale };
  } catch (err) {
    // Back out rather than leave a game importing a half-written winmm.
    try { if (exists(original)) { fs.copyFileSync(original, live); } } catch {}
    return { success: false, error: err.message };
  }
}

function disableWinmmOverlay(exePath) {
  if (!exePath) return { success: true };
  const dir = path.dirname(exePath);
  const live = path.join(dir, WINMM_PROXY);
  const original = path.join(dir, WINMM_ORIGINAL);
  // Only ever remove our own. A foreign winmm.dll we declined to touch on the
  // way in must be left exactly as it was.
  if (!exists(live) || !isOurWinmmProxy(live)) return { success: true, skipped: true };
  try {
    fs.unlinkSync(live);
    // We introduced winmm_o as a copy of System32; it has no other owner.
    if (exists(original)) fs.unlinkSync(original);
    return { success: true, removed: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** Is our winmm proxy in place and current, for verifyOnline. */
function getWinmmStatus(exePath) {
  if (!exePath) return { applicable: false };
  const dir = path.dirname(exePath);
  const live = path.join(dir, WINMM_PROXY);
  const installed = exists(live) && isOurWinmmProxy(live);
  return {
    applicable: overlayEnabled() && exeIsX64(exePath),
    foreign: exists(live) && !isOurWinmmProxy(live),
    installed,
    stale: installed && !sameFile(live, winmmProxyPath()),
  };
}

/**
 * Is online mode still actually in place?
 *
 * A game update rewrites whatever it shipped — steam_api64.dll and the EOS SDK
 * both come back as the publisher's originals, and steam_appid.txt is often
 * deleted outright. Nothing announces this. The toggle would keep saying "on"
 * while the install had quietly reverted, and the player would find out when
 * co-op stopped working for no visible reason.
 *
 * So the state file is treated as an *intent*, and the files on disk as the
 * truth. Where they disagree, the intent is reapplied.
 */
function verifyOnline(gamePath, exePath) {
  const state = readState(gamePath);
  const intended = state && state.mode === 'online';
  if (!intended) return { intended: false, intact: true, reasons: [] };

  /*
   * A loader-owned install has nothing on disk that can drift, because
   * enableOnline deliberately put nothing there: no App ID file, no proxy, no
   * ini. Every check below would therefore report all of them missing, and
   * reapplyIfNeeded would answer by running the full switch — turning the
   * repair path into the crash it exists to avoid, on every single launch.
   *
   * The record is the whole state here. If the folder ever stops being
   * loader-owned, the next switch-on takes the ordinary path on its own.
   */
  if (state.identity === 'loader') {
    return { intended: true, intact: true, reasons: [], identity: 'loader' };
  }

  const reasons = [];
  const managed = require('./valheimOnline').status(gamePath);
  if (managed.applicable) {
    if (!managed.ok) reasons.push(`Valheim online compatibility check: ${managed.error}`);
    else if (!managed.installed || managed.stale || managed.incomplete) reasons.push('The Valheim online adapter needs repair');
  }
  const status = getStatus(gamePath, exePath);

  if (status.appId !== SPACEWAR_APPID) reasons.push('steam_appid.txt is missing or no longer 480');

  // A live DLL that matches its own .goldberg copy means the emulator is back.
  for (const part of status.dlls) {
    if (!part.hasEmulator) continue;
    try {
      const live = fs.statSync(part.dll).size;
      const emu = fs.statSync(part.dll + EMU_SUFFIX).size;
      if (live === emu) reasons.push(`${path.basename(part.dll)} was replaced by the offline emulator`);
    } catch { /* unreadable: leave it to the reapply */ }
  }

  /*
   * Deliberately not gated on state.eos.
   *
   * That field was added after the first games were switched on, so the records
   * that most need checking are precisely the ones that lack it — and a missing
   * field reads as false, silently disabling the check for them. The install
   * itself answers the question anyway: if the game has an EOS SDK and online
   * mode is on, the proxy belongs there, whatever the bookkeeping remembers.
   */
  const eos = getEosStatus(gamePath);
  if (eos.present && !eos.installed) {
    reasons.push('the EOS proxy was overwritten (most likely by a game update)');
  } else if (eos.stale) {
    reasons.push('the EOS proxy is from an older Librarian build');
  }

  // Same reasoning for the Steam side: a game update rewrites steam_api64.dll
  // with the publisher's own, which leaves _o.dll orphaned and the ownership
  // answers gone, with nothing to announce it.
  for (const part of getSteamProxyStatus(gamePath)) {
    if (!part.installed) {
      // Only a complaint where the proxy was ever wanted: a game with no
      // untouched library to fall back on was never a candidate.
      if (exists(part.original) || part.genuine) {
        reasons.push(`the Steam proxy is not in place for ${path.basename(part.dll)}`);
      }
    } else if (part.stale) {
      reasons.push(`the Steam proxy for ${path.basename(part.dll)} is from an older Librarian build`);
    }
  }

  // The overlay's early-load winmm. Only a drift signal where it applies and
  // was wanted — an update can drop the proxy, and a Librarian update can leave
  // an older one. A foreign winmm we deliberately declined to touch is not drift.
  const winmm = getWinmmStatus(exePath);
  if (winmm.applicable && !winmm.foreign) {
    if (state.winmm && !winmm.installed) {
      reasons.push('the Steam overlay loader (winmm.dll) is no longer in place');
    } else if (winmm.stale) {
      reasons.push('the Steam overlay loader (winmm.dll) is from an older Librarian build');
    }
  }

  return { intended: true, intact: reasons.length === 0, reasons };
}

/**
 * Put online mode back if the install drifted out from under it. Safe to call
 * on every launch: when nothing has changed it does nothing.
 */
function reapplyIfNeeded(gamePath, exePath, playerName) {
  const check = verifyOnline(gamePath, exePath);
  if (!check.intended) return { reapplied: false, ...check };
  if (check.intact) {
    // Nothing to repair, but settings may have moved since the last launch.
    refreshOnlineConfig(gamePath, playerName, exePath);
    return { reapplied: false, ...check };
  }
  const result = enableOnline(gamePath, exePath, playerName);
  return { reapplied: true, ...check, result };
}

module.exports = {
  SPACEWAR_APPID,
  getStatus,
  getStartupBlock,
  verifyOnline,
  reapplyIfNeeded,
  enableOnline,
  disableOnline,
  refreshOnlineConfig,
  findSteamApiDlls,
  findEosSdk,
  getEosStatus,
  enableEos,
  disableEos,
  eosProxyCovers,
  getSteamProxyStatus,
  enableSteamProxy,
  disableSteamProxy,
  enableWinmmOverlay,
  disableWinmmOverlay,
  getWinmmStatus,
  steamProxyCovers,
  realAppId,
};
