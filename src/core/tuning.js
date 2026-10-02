// ═══════════════════════════════════════════════════════════════════
// Librarian — Tuning
//
// The launcher side of the performance mode. Two halves, two mechanisms:
//
//   Inside the game.  The DLL the launcher already injects for achievement
//   toasts (native/achoverlay) also carries native/achoverlay/tuning.c: a
//   render-queue cap, a frame limiter and per-frame measurements. It is inert
//   unless a config file named after the game's process id exists when it
//   looks — so this module writes that file *before* the injector runs, keeps
//   it current when the user flips a switch (the DLL reads it every frame),
//   and reads the stats file the DLL writes back. The byte layouts are in
//   native/achoverlay/tuning_shared.h and mirrored here; the two must agree.
//
//   At launch.  Things a process cannot do to itself from inside a game, done
//   from here right after spawn: priority (Node's own os.setPriority), CPU
//   affinity by topology, the display's highest refresh rate, the High
//   performance power plan. The last two change machine state, so what was
//   there before is remembered and put back when the last tuned game exits.
//
// Everything here is best-effort in the same sense as the overlay: a tuning
// failure is logged and never the reason a game did not start.
// ═══════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const json = require('./jsonFile');

// ─── The contract (tuning_shared.h) ──────────────────────────────
const MAGIC = 0x4E54424C;          // 'LBTN'
const STATS_MAGIC = 0x5354424C;    // 'LBTS'
const VERSION = 1;
const CONFIG_BYTES = 64;
const STATS_HEADER = 64;
const FRAME_BYTES = 28;
const RING = 8192;
const STALE_AFTER_MS = 2000;
const FLAGS = { LIMITER: 1, QUEUE_CAP: 2, QUEUE_ULTRA: 4, QUEUE_AUTO: 8 };
const API = { 0: 'unknown', 11: 'D3D11', 12: 'D3D12' };
const CAPS = { LIMIT: 1, QUEUE: 2 };
const DISABLED = { 0: '', 1: 'exception', 2: 'errors', 3: 'gpu-hang', 4: 'steam-overlay' };

const HIGH_PERF_PLAN = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';

function tuningDir() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Librarian', 'tuning');
}
const configPath = (pid) => path.join(tuningDir(), `${Number(pid)}.cfg`);
const statsPath = (pid) => path.join(tuningDir(), `${Number(pid)}.stats`);

/** Config flags and limit for a profile, as the DLL wants them. */
function flagsFor(profile, fps) {
  let flags = 0;
  if (profile.limiter && fps > 0) flags |= FLAGS.LIMITER;
  if (profile.queue === 'auto') flags |= FLAGS.QUEUE_AUTO;
  if (profile.queue === 'one' || profile.queue === 'ultra') flags |= FLAGS.QUEUE_CAP;
  if (profile.queue === 'ultra') flags |= FLAGS.QUEUE_ULTRA;
  return flags;
}

function encodeConfig({ flags = 0, fps = 0, seq = 1 } = {}) {
  const b = Buffer.alloc(CONFIG_BYTES);
  b.writeUInt32LE(MAGIC, 0);
  b.writeUInt32LE(VERSION, 4);
  b.writeUInt32LE(seq >>> 0, 8);
  b.writeUInt32LE(flags >>> 0, 12);
  b.writeFloatLE(Number(fps) || 0, 16);
  return b;
}

/**
 * Write (or rewrite in place) a game's config file. In place matters: the DLL
 * has the file mapped, and a truncating rewrite of a mapped file is refused
 * by Windows. Fields first, `seq` last, the same single-writer discipline as
 * the overlay section.
 */
function writeConfig(pid, cfg) {
  const file = configPath(pid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = encodeConfig(cfg);
  let fd;
  try {
    fd = fs.openSync(file, fs.existsSync(file) ? 'r+' : 'w+');
    fs.writeSync(fd, buf, 12, CONFIG_BYTES - 12, 12);   // flags, fps, reserved
    fs.writeSync(fd, buf, 0, 12, 0);                    // magic, version, seq
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return file;
}

function removeFiles(pid) {
  for (const f of [configPath(pid), statsPath(pid)]) {
    try { fs.unlinkSync(f); } catch { /* the game may still hold it; it is per pid and harmless */ }
  }
}

/** The stats header alone: cheap, and enough to know the API and health. */
function readStatsHeader(pid) {
  let fd;
  try {
    fd = fs.openSync(statsPath(pid), 'r');
    const h = Buffer.alloc(STATS_HEADER);
    const n = fs.readSync(fd, h, 0, STATS_HEADER, 0);
    if (n < STATS_HEADER) return null;
    return decodeHeader(h);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function decodeHeader(h) {
  if (h.readUInt32LE(0) !== STATS_MAGIC || h.readUInt32LE(4) !== VERSION) return null;
  const api = h.readUInt32LE(8);
  const caps = h.readUInt32LE(12);
  const disabled = h.readUInt32LE(24);
  return {
    api: API[api] || `api-${api}`,
    canLimit: Boolean(caps & CAPS.LIMIT),
    canQueue: Boolean(caps & CAPS.QUEUE),
    frames: h.readUInt32LE(16),
    errors: h.readUInt32LE(20),
    disabled: disabled in DISABLED ? DISABLED[disabled] : `reason-${disabled}`,
    appliedFlags: h.readUInt32LE(28),
    maxLatencyPrev: h.readUInt32LE(32),
    hooks: h.readUInt32LE(36),
    // Where the render thread last was inside the DLL (0 = back in the game):
    // the first thing to read when a game stops presenting.
    stage: STAGES[h.readUInt32LE(40)] || `stage-${h.readUInt32LE(40)}`,
    deviceFlags: h.readUInt32LE(44),
  };
}
const STAGES = ['idle', 'before-present', 'signal', 'in-present', 'probe', 'fence', 'cap', 'sweep', 'wait', 'record'];

function decodeFrame(buf, off) {
  return {
    frameMs: buf.readFloatLE(off),
    limiterMs: buf.readFloatLE(off + 4),
    gpuWaitMs: buf.readFloatLE(off + 8),
    gpuLatMs: buf.readFloatLE(off + 12),
    presentMs: buf.readFloatLE(off + 16),
    cpuMs: buf.readFloatLE(off + 20),
    queueDepth: buf.readUInt8(off + 24),
    flags: buf.readUInt8(off + 25),
    // Width of the interval the latency was pinned to, in ms; null when the
    // frame's completion has not been observed yet.
    gpuLatUncMs: (() => { const u = buf.readUInt16LE(off + 26); return u === 0xFFFF ? null : u / 10; })(),
  };
}

/**
 * Frames recorded since `cursor` (a previous header.frames), oldest first.
 * The ring holds RING entries, so a cursor further back than that yields the
 * oldest RING frames and `dropped` says how many were lost.
 */
function readFramesSince(pid, cursor = 0) {
  let fd;
  try {
    fd = fs.openSync(statsPath(pid), 'r');
    const h = Buffer.alloc(STATS_HEADER);
    if (fs.readSync(fd, h, 0, STATS_HEADER, 0) < STATS_HEADER) return null;
    const header = decodeHeader(h);
    if (!header) return null;
    const total = header.frames;
    let from = Math.max(0, cursor > total ? 0 : cursor);
    let dropped = 0;
    if (total - from > RING) { dropped = total - from - RING; from = total - RING; }
    const count = Math.max(0, total - from);
    const frames = new Array(count);
    if (count) {
      // Read the whole ring once rather than one seek per entry.
      const ring = Buffer.alloc(RING * FRAME_BYTES);
      fs.readSync(fd, ring, 0, ring.length, STATS_HEADER);
      for (let i = 0; i < count; i++) {
        const slot = (from + i) % RING;
        frames[i] = decodeFrame(ring, slot * FRAME_BYTES);
      }
    }
    return { header, frames, next: total, dropped };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

/**
 * One number per thing the page shows, from a window of frames.
 *
 *   fps        frames divided by the time they took
 *   avgMs      mean frame time; medianMs/medianFps the typical frame, which a
 *              single hitch cannot move
 *   stalls     frames over 100 ms in the window, and stallMs their total
 *   p99Ms      the frame time 99 percent of frames beat (the "1% low" as a time)
 *   low1Fps    that same figure as a rate, which is how players read it
 *   gpuLatMs   Present to GPU completion, over the frames where it is known,
 *              with gpuLatUncMs the +/- it is known to
 *   presentMs  time the game spent inside Present (blocked on the queue)
 *   cpuMs      time the game spent on its own work between two Presents
 *   queueDepth mean frames still on the GPU right after Present
 *   limiterMs / gpuWaitMs  what the two waits cost per frame
 */
function summarize(frames) {
  // Two minutes is the ceiling for one frame: beyond that it is not a frame
  // but a clock error. A multi-second stall stays in, as the hitch it is.
  const valid = frames.filter((f) => Number.isFinite(f.frameMs) && f.frameMs > 0 && f.frameMs < 120000);
  if (!valid.length) return null;
  const times = valid.map((f) => f.frameMs).sort((a, b) => a - b);
  const total = times.reduce((a, b) => a + b, 0);
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const known = valid.filter((f) => f.gpuLatMs >= 0 && f.gpuLatUncMs !== null);
  const lat = known.map((f) => f.gpuLatMs);
  const unc = known.map((f) => f.gpuLatUncMs);
  const p99 = percentile(times, 0.99);
  const median = percentile(times, 0.5);
  // A loading screen or a shader compile in the window shows up here rather
  // than silently dragging the average down.
  const stalls = valid.filter((f) => f.frameMs > 100);
  return {
    count: valid.length,
    seconds: total / 1000,
    fps: total > 0 ? (valid.length * 1000) / total : 0,
    avgMs: total / valid.length,
    medianMs: median,
    medianFps: median > 0 ? 1000 / median : 0,
    maxMs: times[times.length - 1],
    stalls: stalls.length,
    stallMs: stalls.reduce((a, f) => a + f.frameMs, 0),
    // The three longest frames, with where their time went: the game's own
    // work, blocked in Present, or one of our waits. A stall names its owner.
    worst: valid.slice().sort((a, b) => b.frameMs - a.frameMs).slice(0, 3).map((f) => ({
      frameMs: f.frameMs, cpuMs: f.cpuMs, presentMs: f.presentMs, limiterMs: f.limiterMs, gpuWaitMs: f.gpuWaitMs,
    })),
    p99Ms: p99,
    low1Fps: p99 > 0 ? 1000 / p99 : 0,
    gpuLatMs: lat.length ? mean(lat) : null,
    // Half the mean interval width: the latency is known to about +/- this.
    gpuLatUncMs: unc.length ? mean(unc) / 2 : null,
    gpuLatKnown: lat.length,
    presentMs: mean(valid.map((f) => f.presentMs)),
    cpuMs: mean(valid.map((f) => f.cpuMs)),
    queueDepth: mean(valid.map((f) => f.queueDepth)),
    limiterMs: mean(valid.map((f) => f.limiterMs)),
    gpuWaitMs: mean(valid.map((f) => f.gpuWaitMs)),
    // What was in effect for most of the window.
    flags: mode(valid.map((f) => f.flags)),
  };
}

function mode(values) {
  const counts = new Map();
  let best = 0, bestCount = -1;
  for (const v of values) {
    const c = (counts.get(v) || 0) + 1;
    counts.set(v, c);
    if (c > bestCount) { best = v; bestCount = c; }
  }
  return best;
}

// ─── Tools on disk ───────────────────────────────────────────────
function depsDir() {
  try {
    const { getDepsPath } = require('./runtimePaths');
    return getDepsPath('librarian');
  } catch {
    // Plain Node (the verifier): the repository's own deps folder.
    return path.join(__dirname, '..', '..', 'deps', 'librarian');
  }
}
const helperPath = () => path.join(depsDir(), 'librarian_tune.exe');
const dllPath = () => path.join(depsDir(), 'librarian_achoverlay.dll');
const injectorPath = () => path.join(depsDir(), 'librarian_inject.exe');

function log(line) {
  if (module.exports.onLog) { try { module.exports.onLog(line); } catch { /* listener's problem */ } }
  else console.log('[tuning]', line);
}

/** Run the helper and parse its one JSON line. Never throws. */
function helper(args, { timeout = 8000 } = {}) {
  const exe = helperPath();
  if (process.platform !== 'win32' || !fs.existsSync(exe)) return { error: 'helper missing' };
  try {
    const out = execFileSync(exe, args, { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out.trim().split(/\r?\n/).pop() || '{}');
  } catch (e) {
    // Exit 2 still prints JSON with an error field; anything else is ours.
    const text = String(e.stdout || '').trim().split(/\r?\n/).pop();
    try { if (text) return JSON.parse(text); } catch { /* fall through */ }
    return { error: e.message };
  }
}

let topologyCache = null;
function topology() {
  if (!topologyCache) topologyCache = helper(['topology']);
  return topologyCache;
}

function display() {
  return helper(['display', 'query']);
}

/** The frame rate to hold when the profile says "follow the display". */
function autoFps(profile, disp) {
  if (profile.fps > 0) return profile.fps;
  const hz = disp && Number(disp.max_hz || disp.hz);
  // A 60 Hz display is held at 57: three frames under keeps a VRR panel in
  // range and never fills a V-Sync queue. Below 30 Hz nothing sensible exists.
  return Number.isFinite(hz) && hz >= 30 ? hz - 3 : 0;
}

function powerActiveScheme() {
  try {
    const out = execFileSync('powercfg', ['/getactivescheme'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const m = out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

function powerSchemeExists(guid) {
  try {
    const out = execFileSync('powercfg', ['/list'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return out.toLowerCase().includes(guid.toLowerCase());
  } catch { return false; }
}

function powerSetScheme(guid) {
  try {
    execFileSync('powercfg', ['/setactive', guid], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return true;
  } catch { return false; }
}

// ─── Sessions ────────────────────────────────────────────────────
const sessions = new Map();     // pid -> session
let seq = 0;
let poller = null;
let lastSession = null;         // what the page shows once the game has exited
let machineBefore = null;       // { refreshHz, powerScheme } to restore when the last game exits

function settingsProfile() {
  try {
    const settings = require('./settingsStore');
    return { ...settings.get('tuning') };
  } catch {
    return { enabled: false, queue: 'auto', limiter: true, fps: 0, affinity: 'auto', priority: false, refresh: true, power: false };
  }
}

/** The per-game override: 'inherit' | 'on' | 'off'. */
function overrideFor(key) {
  if (!key) return 'inherit';
  try {
    const meta = require('./gameMetaStore');
    const v = meta.getByKey(key).tuning_override;
    return v === 'on' || v === 'off' ? v : 'inherit';
  } catch { return 'inherit'; }
}

function setOverride(key, value) {
  const meta = require('./gameMetaStore');
  meta.setByKey(key, { tuning_override: value === 'on' || value === 'off' ? value : 'inherit' });
  for (const session of sessions.values()) {
    if (session.key !== key) continue;
    if (abRun?.pid === session.pid) abRun.cancelled = true;
    session.live = null;
    pushConfig(session);
    emit('session', publicSession(session));
  }
  return overrideFor(key);
}

/** Is tuning wanted for this game right now? */
function wantedFor(key, profile = settingsProfile()) {
  const o = overrideFor(key);
  if (o === 'on') return true;
  if (o === 'off') return false;
  return Boolean(profile.enabled);
}

function effectiveConfig(session) {
  const p = session.live || session.profile;
  if (!wantedFor(session.key, p)) return { flags: 0, fps: 0, seq: ++seq };
  const fps = p.limiter ? autoFps(p, session.display) : 0;
  return { flags: flagsFor(p, fps), fps, seq: ++seq };
}

function pushConfig(session) {
  try {
    session.config = effectiveConfig(session);
    writeConfig(session.pid, session.config);
  } catch (e) {
    log(`config for ${session.pid} failed: ${e.message}`);
  }
}

/**
 * Called by the launcher right after spawn and before the injector runs.
 * Returns true when the game is being tuned (so the DLL must go in), false
 * when nothing was written and the launcher's own rules decide the injection.
 */
function onLaunch({ pid, key, name, exe }) {
  if (process.platform !== 'win32' || !pid) return false;
  const profile = settingsProfile();
  if (!wantedFor(key, profile)) return false;

  const session = {
    pid, key, name, exe,
    profile,
    live: null,
    display: display(),
    startedAt: Date.now(),
    cursor: 0,
    lastFrameAt: 0,
    recent: [],          // the last few seconds of frames, for the live tiles
    summary: null,
    header: null,
    applied: { priority: false, affinity: null, refresh: null, power: null },
  };
  pushConfig(session);

  // Launch-time tweaks. Each one independent, each one logged, none fatal.
  if (profile.priority) {
    try { os.setPriority(pid, os.constants.priority.PRIORITY_HIGH); session.applied.priority = true; }
    catch (e) { log(`priority: ${e.message}`); }
  }
  if (profile.affinity !== 'off') {
    const r = helper(['affinity', String(pid), 'auto']);
    session.applied.affinity = r.error ? { error: r.error } : r;
  }
  try {
  if (profile.refresh && !sessions.size) {
    const beforeHz = Number(session.display?.hz);
    if (beforeHz > 0) rememberMachine({ refreshHz: beforeHz });
    const r = beforeHz > 0 ? helper(['display', 'max']) : { error: 'Current refresh rate unavailable; display unchanged.' };
    if (!r.error) {
      session.applied.refresh = r;
      if (r.changed) rememberMachine({ refreshHz: r.from });
    }
  }
  if (profile.power && !sessions.size) {
    const before = powerActiveScheme();
    if (before && before !== HIGH_PERF_PLAN && powerSchemeExists(HIGH_PERF_PLAN)) rememberMachine({ powerScheme: before });
    if (before && before !== HIGH_PERF_PLAN && powerSchemeExists(HIGH_PERF_PLAN) && powerSetScheme(HIGH_PERF_PLAN)) {
      session.applied.power = { from: before, to: HIGH_PERF_PLAN };
      rememberMachine({ powerScheme: before });
    } else if (before === HIGH_PERF_PLAN) {
      session.applied.power = { from: before, to: before, changed: false };
    } else {
      session.applied.power = { error: before ? 'High performance plan not available' : 'powercfg unavailable' };
    }
  }

  } catch (error) { log(`Machine profile could not be fully applied: ${error.message}`); }
  sessions.set(pid, session);
  lastSession = session;
  ensurePoller();
  log(`tuning ${name || exe} (pid ${pid}): flags ${session.config.flags}, fps ${session.config.fps}`);
  emit('session', publicSession(session));
  return true;
}

/** Called by the launcher when the game exits. Restores the machine. */
function onExit(pid) {
  const session = sessions.get(pid);
  if (!session) return;
  sessions.delete(pid);
  // One last read so the page can show the whole run.
  poll(session);
  session.endedAt = Date.now();
  lastSession = session;
  removeFiles(pid);

  if (!sessions.size) recoverMachine();
  if (!sessions.size && poller) { clearInterval(poller); poller = null; }
  emit('session', publicSession(session));
}

const recoveryPath = () => path.join(tuningDir(), 'machine-recovery.json');
function rememberMachine(patch) {
  const next = { ...(machineBefore || {}), ...patch };
  json.write(recoveryPath(), next);
  machineBefore = next;
}
function recoverMachine() {
  const before = machineBefore || json.read(recoveryPath(), {}, value => value && typeof value === 'object' && !Array.isArray(value));
  if (!Object.keys(before).length) return;
  if (Number(before.refreshHz) > 0) {
    const result = helper(['display', 'set', String(Number(before.refreshHz))]);
    if (result.error) throw new Error(`Could not restore display refresh rate: ${result.error}`);
  }
  if (/^[0-9a-f-]{36}$/i.test(before.powerScheme || '') && !powerSetScheme(before.powerScheme)) throw new Error('Could not restore the previous power plan.');
  json.write(recoveryPath(), {});
  machineBefore = null;
}
function shutdown() {
  cancelAB();
  // Games may outlive the launcher. Disable our per-process profile first,
  // then restore shared machine settings while we can still do so.
  for (const session of sessions.values()) {
    writeConfig(session.pid, { flags: 0, fps: 0, seq: (session.config?.seq || 1) + 1 });
  }
  recoverMachine();
  if (poller) { clearInterval(poller); poller = null; }
}

/** Everything the page needs about one game, without internals. */
function publicSession(s) {
  return {
    pid: s.pid,
    key: s.key,
    name: s.name,
    startedAt: s.startedAt,
    endedAt: s.endedAt || 0,
    running: sessions.has(s.pid),
    lastFrameAt: s.lastFrameAt || 0,
    stale: Boolean(sessions.has(s.pid) && s.lastFrameAt && Date.now() - s.lastFrameAt >= STALE_AFTER_MS),
    measurement: 'present-calls',
    config: s.config,
    live: s.live ? { ...s.live } : null,
    header: s.header,
    summary: s.summary,
    applied: s.applied,
    display: s.display,
  };
}

function poll(session) {
  const r = readFramesSince(session.pid, session.cursor);
  if (!r) return;
  session.header = r.header;
  session.cursor = r.next;
  if (r.frames.length) {
    const now = Date.now();
    if (session.lastFrameAt && now - session.lastFrameAt >= STALE_AFTER_MS) session.recent = [];
    session.lastFrameAt = now;
    session.recent.push(...r.frames);
    // Keep about four seconds: enough for a stable average, short enough
    // that a switch shows within a second or two.
    let total = 0;
    let keep = session.recent.length;
    for (let i = session.recent.length - 1; i >= 0; i--) {
      total += session.recent[i].frameMs;
      if (total > 4000) { keep = session.recent.length - i; break; }
    }
    if (keep < session.recent.length) session.recent.splice(0, session.recent.length - keep);
    session.summary = summarize(session.recent);
  }
}

function ensurePoller() {
  if (poller) return;
  poller = setInterval(() => {
    for (const session of sessions.values()) {
      poll(session);
      emit('stats', publicSession(session));
    }
  }, 500);
  if (poller.unref) poller.unref();
}

const listeners = new Set();
function emit(type, payload) {
  for (const fn of listeners) { try { fn(type, payload); } catch { /* listener's problem */ } }
}
function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ─── Control from the page ───────────────────────────────────────
function setProfile(patch) {
  const settings = require('./settingsStore');
  const merged = { ...settings.get('tuning'), ...(patch || {}) };
  settings.set('tuning', merged);
  const profile = settings.get('tuning');
  for (const session of sessions.values()) {
    session.profile = { ...profile };
    if (patch && Object.hasOwn(patch, 'enabled')) {
      if (abRun?.pid === session.pid) abRun.cancelled = true;
      session.live = null;
    }
    if (!session.live) pushConfig(session);
    emit('session', publicSession(session));
  }
  return profile;
}

/**
 * A temporary in-game override that does not touch the saved profile — the
 * A/B test uses it, and so does "try it now" from the page. null clears it.
 */
function setLive(pid, live) {
  const session = sessions.get(Number(pid));
  if (!session) return null;
  session.live = live ? { ...session.profile, ...live } : null;
  pushConfig(session);
  return publicSession(session);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let abRun = null;

/**
 * Before/after on a running game: a phase with every in-game feature off, a
 * phase with the profile on, each measured over `seconds` after a short
 * settle. The saved profile is untouched and the live override is cleared
 * at the end, whatever happened.
 */
async function runAB({ pid, seconds = 15 } = {}) {
  const session = sessions.get(Number(pid));
  if (!session) throw new Error('no tuned game is running');
  if (abRun) throw new Error('a test is already running');
  const secs = Math.max(5, Math.min(60, Number(seconds) || 15));
  const run = { pid: session.pid, cancelled: false };
  abRun = run;
  const phases = [
    { id: 'before', label: 'off', live: { limiter: false, queue: 'off' } },
    { id: 'after', label: 'on', live: null },
  ];
  const result = { pid, seconds: secs, name: session.name, before: null, after: null };
  try {
    for (const phase of phases) {
      if (run.cancelled) break;
      // The "on" phase measures the profile as saved, whatever the page has
      // been trying live; the "off" phase forces everything off.
      setLive(pid, phase.live || { ...session.profile, limiter: session.profile.limiter, queue: session.profile.queue });
      emit('ab', { pid, phase: phase.id, state: 'settling', seconds: secs });
      await sleep(1500);
      if (run.cancelled || !sessions.has(session.pid)) break;
      const start = readFramesSince(pid, 0);
      const cursor = start ? start.next : 0;
      const t0 = Date.now();
      while (Date.now() - t0 < secs * 1000) {
        if (run.cancelled || !sessions.has(session.pid)) break;
        emit('ab', { pid, phase: phase.id, state: 'measuring', seconds: secs, elapsed: (Date.now() - t0) / 1000 });
        await sleep(250);
      }
      const r = readFramesSince(pid, cursor);
      result[phase.id] = r ? summarize(r.frames) : null;
      if (result[phase.id]) result[phase.id].header = r.header;
    }
  } finally {
    if (sessions.has(session.pid)) setLive(pid, null);
    abRun = null;
  }
  result.cancelled = run.cancelled;
  emit('ab', { pid, phase: 'done', state: 'done', result });
  return result;
}

function cancelAB() { if (abRun) abRun.cancelled = true; return Boolean(abRun); }

/** State for the page in one call. */
function getState(gameKey) {
  const profile = settingsProfile();
  return {
    profile,
    available: {
      helper: fs.existsSync(helperPath()),
      dll: fs.existsSync(dllPath()),
      injector: fs.existsSync(injectorPath()),
      platform: process.platform,
    },
    topology: topology(),
    display: display(),
    highPerfPlan: powerSchemeExists(HIGH_PERF_PLAN),
    sessions: [...sessions.values()].map(publicSession),
    last: lastSession && !sessions.has(lastSession.pid) ? publicSession(lastSession) : null,
    override: gameKey ? overrideFor(gameKey) : 'inherit',
    ab: Boolean(abRun),
  };
}

module.exports = {
  // contract
  MAGIC, STATS_MAGIC, VERSION, FLAGS, RING, CONFIG_BYTES, STATS_HEADER, FRAME_BYTES,
  tuningDir, configPath, statsPath, encodeConfig, writeConfig, removeFiles,
  readStatsHeader, readFramesSince, summarize, flagsFor, autoFps,
  // tools
  helper, helperPath, dllPath, injectorPath, topology, display,
  // sessions
  onLaunch, onExit, wantedFor, overrideFor, setOverride, getState, subscribe,
  shutdown, recoverMachine,
  setProfile, setLive, runAB, cancelAB,
  onLog: null,
};
