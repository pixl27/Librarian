// ─── Game Launcher + Playtime Tracker ────────────────────────────
// Launches games by running their executable directly (rather than routing
// through the Steam client), and records playtime by watching the spawned
// process until it exits.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const meta = require('./gameMetaStore');

// Directories that never contain the game's main executable — skipped during
// the scan so redistributables don't outrank the real game.
const SKIP_DIRS = new Set([
  '_commonredist', 'commonredist', 'directx', 'dotnet', 'dotnetfx',
  'vcredist', 'vc_redist', 'redist', 'redistributable', 'redistributables',
  '__installer', '.depotdownloader', 'steam_settings', 'node_modules',
  '$recycle.bin', 'installers', 'directx_redist', 'openal',
]);

// Executables that are clearly not the game itself.
const EXCLUDE_EXE = [
  /unins/i, /^setup/i, /^install/i, /uninstall/i, /vc_?redist/i, /vcredist/i,
  /dxsetup/i, /dxwebsetup/i, /directx/i, /dotnet/i, /oalinst/i, /^python/i,
  /crashpad/i, /crashhandler/i, /crashreport/i, /crash_reporter/i, /werfault/i,
  /unitycrashhandler/i, /notification_helper/i, /touchup/i, /^dw\.exe$/i,
  /quicksfv/i, /^cleanup/i, /^config\.exe$/i, /activation/i, /^register/i,
  /easyanticheat_setup/i, /^eac/i, /^battleye/i, /^vfw/i, /^7z/i,
];

// Executables that are probably secondary tools — allowed, but ranked lower.
const DEMOTE_EXE = [
  /launcher/i, /editor/i, /server/i, /dedicated/i, /benchmark/i, /config/i,
  /settings/i, /tool/i, /console/i, /report/i, /helper/i, /handler/i,
  /diagnostic/i, /updater/i, /patcher/i,
];

function tokenize(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(t => t.length >= 3);
}

/**
 * Walk an install directory (bounded) and collect candidate .exe files.
 */
function collectExecutables(root, maxDepth = 4, budget = 4000) {
  const found = [];
  let scanned = 0;

  function walk(dir, depth) {
    if (depth > maxDepth || scanned > budget) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (scanned > budget) return;
      scanned++;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        if (entry.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (entry.isFile() && /\.exe$/i.test(entry.name)) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch {}
        found.push({ path: full, name: entry.name, dir, depth, size });
      }
    }
  }

  walk(root, 0);
  return found;
}

/**
 * Rank candidate executables so the real game floats to the top.
 * Returns an array of { path, name, dir, size, score } sorted best-first.
 */
function detectExecutables(installPath, gameName) {
  if (!installPath || !fs.existsSync(installPath)) return [];

  const candidates = collectExecutables(installPath);
  if (!candidates.length) return [];

  const nameTokens = new Set([
    ...tokenize(gameName),
    ...tokenize(path.basename(installPath)),
  ]);
  const maxSize = Math.max(...candidates.map(c => c.size), 1);

  const scored = candidates.map(c => {
    const base = c.name.replace(/\.exe$/i, '');
    let score = 0;

    if (EXCLUDE_EXE.some(re => re.test(c.name))) score -= 1000;
    if (DEMOTE_EXE.some(re => re.test(base))) score -= 40;

    // Name resemblance to the game / folder name is the strongest positive signal.
    const baseTokens = tokenize(base);
    let overlap = 0;
    for (const t of baseTokens) if (nameTokens.has(t)) overlap++;
    if (overlap) score += 60 + overlap * 20;
    if (baseTokens.length && baseTokens.every(t => nameTokens.has(t))) score += 30;

    // Shallow executables are more likely to be the entry point.
    score += Math.max(0, 30 - c.depth * 12);

    // Bigger binaries tend to be the game; small ones tend to be helpers.
    score += (c.size / maxSize) * 40;
    if (c.size < 200 * 1024) score -= 25;

    return { path: c.path, name: c.name, dir: c.dir, size: c.size, score: Math.round(score) };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Resolve the executable to launch for a game:
 *   1. explicit override on the record / meta store
 *   2. auto-detected best candidate
 * Returns an absolute path or null.
 */
function resolveExecutable(game) {
  const override = (game && typeof game.executable === 'string' && game.executable.trim())
    || meta.get(game).executable;
  if (override) {
    const resolved = path.resolve(override);
    if (fs.existsSync(resolved)) return resolved;
  }
  const installPath = game && game.install_path;
  if (!installPath) return null;
  const ranked = detectExecutables(installPath, game.game_name);
  const best = ranked.find(c => c.score > -500);
  return best ? best.path : null;
}

// ─── Running processes / playtime ────────────────────────────────
const running = new Map(); // key -> { pid, startedAt, child, name }
let onSessionChange = null;

function setSessionChangeHandler(fn) {
  onSessionChange = typeof fn === 'function' ? fn : null;
}

/**
 * Put the achievement overlay inside a freshly started game.
 *
 * Deliberately fire-and-forget and deliberately silent on the common failures:
 * a 32-bit game cannot load it, a protected process will refuse, and neither
 * is worth interrupting a launch over. The overlay itself waits for the
 * launcher to publish a frame before it hooks anything, so injecting this
 * early costs nothing if the user has no achievements to show.
 */
function injectAchievementOverlay(pid, { force = false } = {}) {
  if (!pid || process.platform !== 'win32') return;
  try {
    const settings = require('./settingsStore');
    // `force`: tuning wants the DLL in even with toasts off; the DLL itself
    // only draws when a toast section exists, so nothing shows that should not.
    if (!force && settings.get('achievement_popups') === false) return;

    const { getDepsPath } = require('./runtimePaths');
    const injector = getDepsPath('librarian', 'librarian_inject.exe');
    const dll = getDepsPath('librarian', 'librarian_achoverlay.dll');
    if (!fs.existsSync(injector) || !fs.existsSync(dll)) return;

    const child = spawn(injector, [String(pid), dll], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* never worth failing a launch for */ }
}

/**
 * A game running under a member's hypervisor release (coldclient loader,
 * driver_amd / driver_intel, or anything Librarian placed from CS.RIN.RU).
 *
 * Its process is guarded: a thread created from outside — which is what
 * injecting the overlay is — raises an exception the game's own crash
 * handler catches, and the game sits behind a crash-report dialog until it
 * is closed, then dies. Measured on Onimusha: Way of the Sword,
 * 2026-09-04. Nothing of ours goes into such a process.
 */
function isGuardedRelease(installPath) {
  if (!installPath) return false;
  const marks = ['coldclient', 'driver_amd', 'driver_intel'];
  /*
   * The loader's own files, not just its folders.
   *
   * driver_amd / driver_intel only appear once the release has staged its
   * signed driver, and reflex.ini is read long before that happens. On
   * 2026-09-15 a Monster Hunter Wilds install was launched from here while the
   * hypervisor release was live but its driver folder had not been written yet,
   * so this answered false and the overlay was injected into a guarded process.
   * The loader's configuration file is present for the whole of that window.
   */
  const files = [/^reflex\.(dll|ini)$/i, /\.csrin\.bak$/i];
  const has = (dir) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries.some((e) => (e.isDirectory() && marks.includes(e.name.toLowerCase()))
        || (e.isFile() && files.some((re) => re.test(e.name))));
    } catch { return false; }
  };
  if (has(installPath)) return true;
  try {
    return fs.readdirSync(installPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name.toLowerCase()))
      .slice(0, 40)
      .some((e) => has(path.join(installPath, e.name)));
  } catch { return false; }
}

function emitChange(type, key, extra = {}) {
  if (onSessionChange) {
    try { onSessionChange({ type, key, ...extra }); } catch {}
  }
}

function isRunning(key) {
  return running.has(key);
}

function getRunning() {
  return Array.from(running.entries()).map(([key, v]) => ({
    key,
    pid: v.pid,
    startedAt: v.startedAt,
    name: v.name,
    install_path: v.install_path || '',
  }));
}

/**
 * Launch a game directly via its executable and track playtime.
 * Returns { success, method, exe?, error?, alreadyRunning? }.
 */
async function launchDirect(game) {
  const key = meta.gameKey(game);
  if (key && running.has(key)) {
    return { success: true, method: 'executable', alreadyRunning: true, pid: running.get(key).pid };
  }

  const exe = resolveExecutable(game);
  if (!exe) return { success: false, error: 'no-exe' };

  /*
   * The Steam overlay, and what this setting does and does not control.
   *
   * The overlay is injected by Steam into processes Steam itself starts. We
   * start the executable directly, so in most games it never attaches — the
   * genuine steam_api that Online mode restores does not bring it back on its
   * own. (OnlineFix ships a small DLL that force-loads Steam's
   * gameoverlayrenderer from the registry precisely because of this.)
   *
   * So this is an opt-out for the games where it does attach, and where it
   * destabilises a title that was never tested with it. It is not a privacy
   * control: the "playing Spacewar" entry on a friends list comes from
   * SteamAPI_Init binding to app 480, and is unaffected by this.
   *
   * SteamNoOverlayUIDrawing is Steam's own opt-out and only needs to be set on
   * the child, so it changes nothing about Librarian's own process.
   */
  let env = process.env;
  try {
    const settings = require('./settingsStore');
    if (settings.get('online_steam_overlay') === false) {
      env = { ...process.env, SteamNoOverlayUIDrawing: '1' };
    }
  } catch { /* settings unavailable: leave Steam's default behaviour alone */ }

  let child;
  try {
    child = spawn(exe, [], {
      cwd: path.dirname(exe),
      detached: true,
      stdio: 'ignore',
      env,
    });
  } catch (err) {
    return { success: false, error: err.message };
  }

  // Windows reports ENOENT/EACCES asynchronously. A ChildProcess object alone
  // is not proof that a game started.
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  } catch (error) { return { success: false, error: error.message, code: error.code }; }

  const startedAt = Date.now();
  const name = game.game_name || path.basename(exe);

  // The achievement overlay has to run inside the game to reach its swap
  // chain, and for a Goldberg title there is nothing of ours already in the
  // process to start it — steam_api64.dll *is* the emulator. So it is loaded
  // from outside, right after the process exists. Entirely best-effort: a
  // failure here must never be the reason a game did not start — and a
  // hypervisor release is left alone entirely, see isGuardedRelease.
  //
  // Tuning rides the same DLL (src/core/tuning.js). Its config file has to
  // exist before the injector runs, and when it is wanted the DLL goes in
  // whether or not achievement toasts are on.
  const guarded = isGuardedRelease(game.install_path);
  let tuned = false;
  if (!guarded) {
    try {
      tuned = require('./tuning').onLaunch({ pid: child.pid, key, name, exe });
    } catch (e) { console.error('tuning:', e.message); }
    injectAchievementOverlay(child.pid, { force: tuned });
  }

  if (key) {
    running.set(key, { pid: child.pid, startedAt, checkpointAt: startedAt, child, name, appid: game.appid, install_path: game.install_path });
    try { meta.recordLaunch(key); }
    catch (error) { emitChange('warning', key, { error: `Game started, but launch history could not be saved: ${error.message}` }); }
    // appid and install_path travel with the event: the achievement watcher
    // needs both, and the key alone only carries one of them.
    emitChange('started', key, {
      pid: child.pid, name, startedAt,
      appid: String(game.appid || ''),
      install_path: game.install_path || '',
    });
  }

  // Whatever tuning changed on the machine for this game goes back when the
  // game does — display rate, power plan — and its per-pid files go away.
  const untune = () => {
    if (!tuned) return;
    try { require('./tuning').onExit(child.pid); } catch (e) { console.error('tuning:', e.message); }
  };

  child.on('error', (error) => {
    untune();
    if (key && running.has(key)) {
      running.delete(key);
      emitChange('stopped', key, { name, sessionSeconds: 0, pid: child.pid, appid: game.appid, error: error.message });
    }
  });

  child.on('exit', () => {
    untune();
    if (!key || !running.has(key)) return;
    const sessionSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    let entry;
    try { entry = checkpointSession(key, running.get(key)); }
    catch (error) { emitChange('warning', key, { error: `Could not save playtime: ${error.message}` }); }
    running.delete(key);
    emitChange('stopped', key, {
      name,
      pid: child.pid,
      appid: game.appid,
      sessionSeconds,
      playtime_seconds: entry ? entry.playtime_seconds : 0,
    });
  });

  // Let the game outlive Librarian, but keep the reference so the exit
  // listener still fires for as long as the launcher is open.
  child.unref();

  return { success: true, method: 'executable', exe, pid: child.pid };
}

function checkpointSession(key, info) {
  const seconds = Math.max(0, Math.floor((Date.now() - info.checkpointAt) / 1000));
  if (!seconds) return meta.getByKey(key);
  const entry = meta.addPlaytime(key, seconds);
  info.checkpointAt += seconds * 1000;
  return entry;
}

function checkpointSessions() {
  for (const [key, info] of running) checkpointSession(key, info);
}
const checkpointTimer = setInterval(() => {
  try { checkpointSessions(); }
  catch (error) { emitChange('warning', '', { error: `Could not save playtime: ${error.message}` }); }
}, 15000);
checkpointTimer.unref?.();

/** Attempt to stop a running tracked game. */
async function stopGame(key) {
  const info = running.get(key);
  if (!info) return { success: false, error: 'not-running' };
  try {
    if (process.platform === 'win32') {
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      await new Promise((resolve, reject) => {
        const stopping = spawn(taskkill, ['/pid', String(info.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        stopping.once('error', reject);
        stopping.once('close', code => code === 0 ? resolve() : reject(new Error(`Windows could not stop the game (exit ${code}).`)));
      });
    } else {
      try { process.kill(-info.pid, 'SIGTERM'); }
      catch { process.kill(info.pid, 'SIGTERM'); }
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  detectExecutables,
  resolveExecutable,
  launchDirect,
  stopGame,
  isRunning,
  getRunning,
  setSessionChangeHandler,
  isGuardedRelease,
  checkpointSessions,
};
