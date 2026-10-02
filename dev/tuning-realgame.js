// ═══════════════════════════════════════════════════════════════════
// Tuning against a real game, through the real launcher.
//
// The synthetic harness (dev/tuning-e2e.mjs) proves the mechanism; this
// proves it on a shipped engine. It runs as an Electron *main* script so
// that src/core/launcher.js and src/core/tuning.js execute exactly as they
// do under Librarian — same settings store (pointed at a throwaway
// userData), same injection path, same restore-at-exit — against a game
// installed on this machine.
//
//   electron dev/tuning-realgame.js [--game <name>] [--exe <path>] [--seconds N]
//
// Default: ULTRAKILL (Unity, Direct3D 11) under E:\Games\steam. The game is
// started, its first frames awaited, a live A/B run, then the game is
// stopped and the display rate and power plan are checked against what
// they were before. Prints `OK realgame` and exits 0 only when every check
// passed. Never shipped: dev/ is outside electron-builder's file list.
// ═══════════════════════════════════════════════════════════════════
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const GAME_NAME = opt('--game', 'ULTRAKILL');
const INSTALL = opt('--exe', 'E:\\Games\\steam\\steamapps\\common\\ULTRAKILL');
const APPID = opt('--appid', '1229490');
const SECONDS = Number(opt('--seconds', '10'));

let failures = 0;
function check(cond, what) {
  if (cond) { console.log(`  ok   ${what}`); return true; }
  failures++;
  console.log(`  FAIL ${what}`);
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (s) => s
  ? `${s.count} frames, ${s.fps.toFixed(1)} fps (median ${s.medianFps.toFixed(1)}, ${s.stalls} stall(s) ${s.stallMs.toFixed(0)} ms), avg ${s.avgMs.toFixed(2)} ms, p99 ${s.p99Ms.toFixed(2)} ms, gpuLat ${s.gpuLatMs === null ? '?' : s.gpuLatMs.toFixed(2)} ms ±${s.gpuLatUncMs === null ? '?' : s.gpuLatUncMs.toFixed(2)}, present ${s.presentMs.toFixed(2)} ms, cpu ${s.cpuMs.toFixed(2)} ms, limiter ${s.limiterMs.toFixed(2)}, gpuWait ${s.gpuWaitMs.toFixed(2)}`
  : 'none';

function powerActive() {
  try {
    const out = execFileSync('powercfg', ['/getactivescheme'], { encoding: 'utf8', windowsHide: true });
    const m = out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

// A throwaway profile store: nothing of the user's is read or written.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-tuning-realgame-')));

app.whenReady().then(async () => {
  console.log(`realgame: ${GAME_NAME} at ${INSTALL}`);
  const settings = require('../src/core/settingsStore');
  const tuning = require('../src/core/tuning');
  const launcher = require('../src/core/launcher');
  tuning.onLog = (line) => console.log(`  log  ${line}`);

  // The shipped default profile, plus the two launch-time switches that are
  // off by default, so that their apply-and-restore path is exercised too.
  settings.set('tuning', { enabled: true, queue: 'auto', limiter: true, fps: 0, affinity: 'auto', priority: true, refresh: true, power: true });
  check(settings.get('tuning').enabled === true, 'profile stored with the mode on');

  const displayBefore = tuning.display();
  const powerBefore = powerActive();
  console.log(`  info display before: ${JSON.stringify(displayBefore)}; power ${powerBefore}`);

  const game = { appid: APPID, game_name: GAME_NAME, install_path: INSTALL, source: 'Steam' };
  const key = require('../src/core/gameMetaStore').gameKey(game);
  const exited = new Promise((resolve) => {
    launcher.setSessionChangeHandler((p) => { if (p.type === 'stopped' && p.key === key) resolve(p); });
  });

  const r = launcher.launchDirect(game);
  if (!check(r.success && r.pid, `launched: ${JSON.stringify(r)}`)) return finish();
  const pid = r.pid;
  check(fs.existsSync(tuning.configPath(pid)), 'config written for the game before injection');

  // A Unity game pauses its whole loop when its window is not in the
  // foreground, and Windows does not always let a process started from a
  // background script take the foreground. A user's click on Play does not
  // have this problem; a test does, so the window is activated by hand.
  const focus = () => {
    try {
      execFileSync('powershell', ['-NoProfile', '-Command', `(New-Object -ComObject WScript.Shell).AppActivate(${pid})`], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
    } catch { /* not yet a window, or refused; tried again below */ }
  };
  for (let i = 0; i < 6; i++) { await sleep(1000); focus(); }

  // First frames: a Unity title reaches its splash within seconds, the menu a
  // while later. Stats begin at the first Present either way.
  let header = null;
  let gone = false;
  let stuck = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    header = tuning.readStatsHeader(pid);
    if (header && header.frames >= 300) break;
    if (!launcher.isRunning(key)) { gone = true; break; }
    // Hooked but not a single frame recorded after half a minute: the render
    // thread is stuck somewhere, and the stage says where.
    if (header && header.frames === 0 && Date.now() - t0 > 30000) { stuck = true; break; }
    // Few frames and the thread back in the game: most likely unfocused and
    // paused; ask for the foreground again.
    if (header && header.stage === 'idle' && ((Date.now() - t0) / 500 | 0) % 8 === 0) focus();
    await sleep(500);
  }
  console.log(`  info header after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${JSON.stringify(header)}${gone ? ' — the game exited on its own' : stuck ? ' — no frame recorded' : ''}`);
  if (stuck) {
    check(false, `no frame recorded after 30 s while the game is alive; render thread last seen at stage '${header.stage}' (device flags 0x${header.deviceFlags.toString(16)})`);
  }
  if (gone || stuck) {
    if (gone) check(false, `the game exited ${((Date.now() - t0) / 1000).toFixed(1)} s after launch, before 300 frames`);
    try {
      const log = fs.readFileSync(path.join(INSTALL, 'librarian_achoverlay.log'), 'utf8').split(/\r?\n/).slice(-8);
      for (const l of log) console.log(`  dll  ${l}`);
    } catch { /* nothing to show */ }
  }
  check(header && header.frames >= 300, `frames flowing from the game (${header ? header.frames : 'no stats'})`);
  check(header && (header.api === 'D3D11' || header.api === 'D3D12'), `API identified: ${header && header.api}`);
  check(header && header.canQueue, 'queue cap available (fence created on the game\'s device)');
  check(header && header.disabled === '', `tuning healthy: disabled='${header && header.disabled}' errors=${header && header.errors}`);

  const st = tuning.getState();
  const sess = st.sessions.find((s) => s.pid === pid);
  check(Boolean(sess), 'session known to the tuning module');
  if (sess) {
    console.log(`  info applied at launch: ${JSON.stringify(sess.applied)}`);
    check(sess.applied.priority === true, 'high priority applied');
    check(sess.applied.affinity && !sess.applied.affinity.error, `affinity handled: ${JSON.stringify(sess.applied.affinity)}`);
  }

  // Let it settle past the splash, then measure with the profile as saved.
  await sleep(8000);
  const live = tuning.getState().sessions.find((s) => s.pid === pid);
  console.log(`  info live: ${fmt(live && live.summary)}`);
  check(live && live.summary && live.summary.count > 30, 'live summary has frames');

  // Before/after on the real game. A phase that comes back with almost no
  // frames means the game stopped presenting — on this machine that is the
  // user clicking elsewhere while the test runs, which pauses a Unity title.
  // The window is activated again and the test is given one more go; a
  // second empty phase is a failure, whoever caused it.
  let ab = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`  info A/B ${SECONDS} s per phase (attempt ${attempt})…`);
    focus();
    await sleep(500);
    try { ab = await tuning.runAB({ pid, seconds: SECONDS }); }
    catch (e) { check(false, `A/B threw: ${e.message}`); break; }
    const thin = (s) => !s || s.count < 100;
    if (!thin(ab.before) && !thin(ab.after)) break;
    console.log(`  info a phase came back thin (before ${ab.before ? ab.before.count : 0}, after ${ab.after ? ab.after.count : 0} frames): the game stopped presenting`);
  }
  if (ab) {
    console.log(`  info before: ${fmt(ab.before)}`);
    console.log(`  info after : ${fmt(ab.after)}`);
    const worst = (s) => s && s.worst ? s.worst.map((w) => `${w.frameMs.toFixed(0)}ms[cpu ${w.cpuMs.toFixed(0)} present ${w.presentMs.toFixed(0)} lim ${w.limiterMs.toFixed(0)} gpu ${w.gpuWaitMs.toFixed(0)}]`).join(' ') : '';
    console.log(`  info worst before: ${worst(ab.before)}`);
    console.log(`  info worst after : ${worst(ab.after)}`);
    check(ab.before && ab.before.count > 50, 'before phase measured');
    check(ab.after && ab.after.count > 50, 'after phase measured');
    if (ab.before && ab.after) {
      check((ab.after.flags & tuning.FLAGS.LIMITER) !== 0 || (ab.after.flags & tuning.FLAGS.QUEUE_CAP) !== 0, `after phase ran with the profile (flags ${ab.after.flags})`);
      check((ab.before.flags & 7) === 0, `before phase ran with everything off (flags ${ab.before.flags})`);
      if (ab.after.limiterMs > 0.2 && ab.before.fps > 0) {
        const target = live && live.config ? live.config.fps : 0;
        // The typical frame, not the mean: a menu load landing in the window is a
        // hitch, reported as such, not a limiter miss.
        check(target > 0 && Math.abs(ab.after.medianFps - target) / target < 0.06, `limiter held the game's typical frame near ${target} fps (median ${ab.after.medianFps.toFixed(1)}, mean ${ab.after.fps.toFixed(1)}, ${ab.after.stalls} stall(s))`);
      } else {
        console.log('  info the game did not exceed the limiter target; limiter wait not exercised');
      }
    }
  }
  const afterHeader = tuning.readStatsHeader(pid);
  check(afterHeader && afterHeader.disabled === '', `still healthy after the A/B (errors=${afterHeader && afterHeader.errors})`);

  // The DLL's own log beside the game, for the record.
  try {
    const log = fs.readFileSync(path.join(INSTALL, 'librarian_achoverlay.log'), 'utf8').split(/\r?\n/).filter((l) => l.includes('[tuning]')).slice(-6);
    for (const l of log) console.log(`  dll  ${l}`);
  } catch { /* no log, no matter */ }

  // Stop it and see the machine put back.
  const stop = launcher.stopGame(key);
  check(stop.success, 'stop requested');
  const stopped = await Promise.race([exited, sleep(30000).then(() => null)]);
  check(Boolean(stopped), 'game exit observed by the launcher');
  await sleep(1500);
  const displayAfter = tuning.display();
  const powerAfter = powerActive();
  console.log(`  info display after: ${JSON.stringify(displayAfter)}; power ${powerAfter}`);
  check(displayAfter && displayBefore && displayAfter.hz === displayBefore.hz, `display back at ${displayBefore && displayBefore.hz} Hz`);
  check(powerAfter === powerBefore, `power plan back to ${powerBefore}`);
  check(!fs.existsSync(tuning.configPath(pid)) && !fs.existsSync(tuning.statsPath(pid)), 'per-pid files removed');
  const final = tuning.getState();
  check(final.sessions.length === 0 && final.last && final.last.pid === pid, 'session closed, kept as the last one for the page');

  finish();
}).catch((e) => { console.log(`  FAIL threw: ${e.stack || e.message}`); failures++; finish(); });

function finish() {
  if (failures) { console.log(`FAILED realgame: ${failures} check(s)`); app.exit(1); return; }
  console.log('OK realgame');
  app.exit(0);
}
