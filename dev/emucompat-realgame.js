// ═══════════════════════════════════════════════════════════════════
// Emulator compatibility against the real game that motivated it.
//
// Runs as an Electron main script (settings store, launcher and crack need
// `app`): points the gate at Mortal Shell II, lets it update the emulator if
// needed and apply it, then launches the game through the real launcher and
// watches the in-game DLL's own log for the one line that settles the
// question — "[steam] game initialised Steam" — while the emulator's
// missing-interface report must not gain an entry. Then stops the game.
//
//   electron dev/emucompat-realgame.js [--game <name>] [--path <install>] [--appid <id>]
//
// Prints `OK realgame` and exits 0 only when every check passed.
// ═══════════════════════════════════════════════════════════════════
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const GAME_NAME = opt('--game', 'Mortal Shell II');
const INSTALL = opt('--path', 'E:\\Games\\steam\\steamapps\\common\\Mortal_Shell_II');
const APPID = opt('--appid', '2584270');

let failures = 0;
function check(cond, what) {
  if (cond) { console.log(`  ok   ${what}`); return true; }
  failures++;
  console.log(`  FAIL ${what}`);
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readLog(exeDir) {
  try { return fs.readFileSync(path.join(exeDir, 'librarian_achoverlay.log'), 'utf-8'); } catch { return ''; }
}

// A throwaway profile store: the user's settings are neither read nor written.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-emucompat-realgame-')));

app.whenReady().then(async () => {
  console.log(`realgame: ${GAME_NAME} at ${INSTALL}`);
  const settings = require('../src/core/settingsStore');
  const emuCompat = require('../src/core/emuCompat');
  const launcher = require('../src/core/launcher');
  const { crackGame } = require('../src/core/autoCrack');
  settings.set('tuning', { ...settings.get('tuning'), enabled: false });
  settings.set('achievement_popups', true);     // the DLL's Steam watch is the witness

  // 1. The gate, with the emulator as installed (updated by the `update`
  //    suite if it had to be).
  const log = (m) => console.log(`  gate ${m}`);
  const gate = await emuCompat.ensureCompatible(INSTALL, { onLog: log });
  console.log(`  info gate: ${JSON.stringify({ ok: gate.ok, reason: gate.reason, missing: gate.missing, updated: gate.updated })}`);
  if (!check(gate.ok, `emulator compatible with this build (${gate.reason})`)) return finish();

  // 2. Apply it, as the download pipeline would.
  const r = await crackGame({ gamePath: INSTALL, appId: APPID, onLog: (m) => console.log(`  sac  ${m}`) });
  check(r && r.success, `SteamAutoCrack applied the emulator (${r && (r.error || `exit ${r.exitCode}`)})`);
  const libs = emuCompat.findGameLibraries(INSTALL);
  const emulated = libs.filter((l) => l.kind === 'emulator');
  check(emulated.length > 0, `emulator now in place for ${emulated.length} of ${libs.length} Steam libraries`);
  const after = emuCompat.check(INSTALL);
  check(after.compatible, `installed emulator covers every interface the game asks for (${after.requested.length} names)`);

  // 3. Launch, and let the in-game DLL tell us whether Steam initialised.
  const game = { appid: APPID, game_name: GAME_NAME, install_path: INSTALL, source: 'Steam' };
  const key = require('../src/core/gameMetaStore').gameKey(game);
  const exe = launcher.resolveExecutable(game);
  check(Boolean(exe), `executable resolved: ${exe}`);
  const exeDir = path.dirname(exe || INSTALL);
  const reportsBefore = emuCompat.missingInterfaceReports(INSTALL).length;
  const logBefore = readLog(exeDir).length;

  const exited = new Promise((resolve) => {
    launcher.setSessionChangeHandler((p) => { if (p.type === 'stopped' && p.key === key) resolve(p); });
  });
  const launched = launcher.launchDirect(game);
  if (!check(launched.success && launched.pid, `launched: ${JSON.stringify(launched)}`)) return finish();
  const pid = launched.pid;
  const focus = () => {
    try { execFileSync('powershell', ['-NoProfile', '-Command', `(New-Object -ComObject WScript.Shell).AppActivate(${pid})`], { windowsHide: true, timeout: 5000, stdio: 'ignore' }); }
    catch { /* not a window yet */ }
  };

  let initialised = false;
  let refused = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    await sleep(1000);
    if ((Date.now() - t0) < 8000) focus();
    const fresh = readLog(exeDir).slice(logBefore);
    if (/\[steam\] game initialised Steam/.test(fresh)) { initialised = true; break; }
    if (/never called SteamAPI_Init/.test(fresh)) { refused = true; break; }
    if (!launcher.isRunning(key)) break;
  }
  const fresh = readLog(exeDir).slice(logBefore);
  for (const line of fresh.split(/\r?\n/).filter((l) => /\[steam\]/.test(l)).slice(0, 8)) console.log(`  dll  ${line}`);
  check(initialised, `the game initialised Steam through the emulator within ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  check(!refused, 'the game did not run with Steam integration off');
  const reportsAfter = emuCompat.missingInterfaceReports(INSTALL).length;
  check(reportsAfter === reportsBefore, `no new missing-interface entry (${reportsBefore} before, ${reportsAfter} after)`);
  const sinceLaunch = emuCompat.missingInterfaceReports(INSTALL, t0);
  check(sinceLaunch.length === 0, 'the post-launch detector sees nothing new for this launch');
  check(launcher.isRunning(key), 'the game is still running (no crash)');

  // 4. Stop it.
  const stop = launcher.stopGame(key);
  check(stop.success, 'stop requested');
  const stopped = await Promise.race([exited, sleep(30000).then(() => null)]);
  check(Boolean(stopped), 'game exit observed by the launcher');
  finish();
}).catch((e) => { console.log(`  FAIL threw: ${e.stack || e.message}`); failures++; finish(); });

function finish() {
  if (failures) { console.log(`FAILED realgame: ${failures} check(s)`); app.exit(1); return; }
  console.log('OK realgame');
  app.exit(0);
}
