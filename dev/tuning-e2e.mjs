#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// End-to-end harness for the in-game tuning half, against a control.
//
// A real game gives one data point. This gives a process whose behaviour is
// known: dev/bin/librarian_d3d11test.exe, a window that saturates the GPU
// with a pixel shader and spends nothing on the CPU, so DXGI's render queue
// fills to its default depth and a frame limiter has something to hold. The
// real DLL goes in with the real injector, driven by the real config file,
// and the real stats file comes back — the same three pieces the launcher
// uses, and the same reader (src/core/tuning.js).
//
//   node dev/tuning-e2e.mjs <suite>
//
//   e2e-stats      frames arrive, API is D3D11, the process is still alive
//   e2e-limiter    a live-switched limiter holds the rate; switching off frees it
//   e2e-queue      a live-switched queue cap lowers GPU latency and queue depth
//   e2e-failsafe   a wrong config version, or an uncreatable stats file, keeps
//                  the process alive with tuning inert
//   e2e-present1   the same stats arrive through the Present1 (flip model) path
//   helper         topology and display JSON, affinity applied and read back,
//                  refresh rate switched to another available rate and back
//
// Prints `OK <suite>` and exits 0 only when every assertion passed.
// ═══════════════════════════════════════════════════════════════════
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tuning = require(join(ROOT, 'src', 'core', 'tuning.js'));

const TESTAPP = join(ROOT, 'dev', 'bin', 'librarian_d3d11test.exe');
const INJECTOR = join(ROOT, 'deps', 'librarian', 'librarian_inject.exe');
const DLL = join(ROOT, 'deps', 'librarian', 'librarian_achoverlay.dll');
const HELPER = join(ROOT, 'deps', 'librarian', 'librarian_tune.exe');

// Enough shader work to be GPU-bound on anything from an iGPU to a 4090 while
// still producing a usable frame count in a few seconds.
const ITERATIONS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond, what) {
  if (cond) { console.log(`  ok   ${what}`); return true; }
  failures++;
  console.log(`  FAIL ${what}`);
  return false;
}
function fmt(s) {
  if (!s) return 'none';
  return `${s.count} frames, ${s.fps.toFixed(1)} fps, avg ${s.avgMs.toFixed(2)} ms, p99 ${s.p99Ms.toFixed(2)} ms, `
    + `gpuLat ${s.gpuLatMs === null ? '?' : s.gpuLatMs.toFixed(2)} ms (${s.gpuLatKnown}), depth ${s.queueDepth.toFixed(2)}, `
    + `limiter ${s.limiterMs.toFixed(2)} ms, gpuWait ${s.gpuWaitMs.toFixed(2)} ms`;
}

function alive(pid) {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' });
  return new RegExp(`\\s${pid}\\s`).test(r.stdout || '');
}

/** Start the test app, optionally write its config first, inject, wait for frames. */
async function startTarget({ config, present1 = false, seconds = 90, inject = true, beforeInject, cpu = 0 } = {}) {
  const args = [String(ITERATIONS), String(seconds)];
  if (present1) args.push('--present1');
  if (cpu > 0) args.push('--cpu', String(cpu));
  const child = spawn(TESTAPP, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  const pid = child.pid;
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));

  if (config) tuning.writeConfig(pid, config);
  if (beforeInject) await beforeInject(pid);
  if (inject) {
    const r = spawnSync(INJECTOR, [String(pid), DLL], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`injector exit ${r.status}: ${r.stderr}`);
  }
  return {
    pid, child, exited,
    output: () => out,
    kill() { try { process.kill(pid); } catch { /* already gone */ } },
  };
}

async function waitFrames(pid, min = 100, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const h = tuning.readStatsHeader(pid);
    if (h && h.frames >= min) return h;
    await sleep(200);
  }
  return tuning.readStatsHeader(pid);
}

/** Measure a window of `ms` after a settle, from the stats ring. */
async function measure(pid, ms, settle = 1200) {
  await sleep(settle);
  const start = tuning.readFramesSince(pid, 0);
  const cursor = start ? start.next : 0;
  await sleep(ms);
  const r = tuning.readFramesSince(pid, cursor);
  return r ? { ...tuning.summarize(r.frames), header: r.header } : null;
}

async function suiteStats() {
  const t = await startTarget({ config: { flags: 0, fps: 0, seq: 1 } });
  try {
    const h = await waitFrames(t.pid, 200);
    check(h && h.frames >= 200, `frames recorded: ${h ? h.frames : 'no stats'}`);
    check(h && h.api === 'D3D11', `API identified: ${h && h.api}`);
    check(h && h.canQueue, 'queue cap available (D3D11 device answered)');
    check(h && h.disabled === '', `tuning healthy: disabled='${h && h.disabled}' errors=${h && h.errors}`);
    check(h && (h.hooks & 1) === 1, `Present hooked (hooks=${h && h.hooks})`);
    const s = await measure(t.pid, 2000);
    console.log(`  info ${fmt(s)}`);
    check(s && s.fps > 30 && s.fps < 2000, 'frame rate in a GPU-bound band with tuning off');
    check(s && s.queueDepth >= 1, `queue depth measured (${s && s.queueDepth.toFixed(2)})`);
    check(s && s.gpuLatKnown > 0, 'present-to-completion latency resolved for some frames');
    check(alive(t.pid), 'target process alive after measuring');
  } finally {
    t.kill();
    await t.exited;
    tuning.removeFiles(t.pid);
  }
}

async function suiteLimiter() {
  const t = await startTarget({ config: { flags: 0, fps: 0, seq: 1 } });
  try {
    await waitFrames(t.pid, 200);
    const free = await measure(t.pid, 2000);
    console.log(`  info free: ${fmt(free)}`);
    check(free && free.fps > 40, `unlimited rate high enough to limit (${free && free.fps.toFixed(1)} fps)`);
    // Hold at a rate well under what it does on its own.
    const target = Math.max(30, Math.min(120, Math.floor(free.fps / 2)));
    tuning.writeConfig(t.pid, { flags: tuning.FLAGS.LIMITER, fps: target, seq: 2 });
    const held = await measure(t.pid, 3000);
    console.log(`  info held @${target}: ${fmt(held)}`);
    check(held && Math.abs(held.fps - target) / target <= 0.05, `limiter holds within 5% of ${target} fps (${held && held.fps.toFixed(2)})`);
    check(held && held.limiterMs > 0.5, `limiter is what does the holding (${held && held.limiterMs.toFixed(2)} ms/frame in the wait)`);
    check(held && (held.flags & tuning.FLAGS.LIMITER) !== 0, 'frames tagged with the limiter flag');
    tuning.writeConfig(t.pid, { flags: 0, fps: 0, seq: 3 });
    const freed = await measure(t.pid, 2000);
    console.log(`  info freed: ${fmt(freed)}`);
    check(freed && freed.fps > target * 1.5, `switching off live releases the rate (${freed && freed.fps.toFixed(1)} fps)`);
    check(alive(t.pid), 'target process alive throughout');
  } finally {
    t.kill();
    await t.exited;
    tuning.removeFiles(t.pid);
  }
}

async function suiteQueue() {
  const t = await startTarget({ config: { flags: 0, fps: 0, seq: 1 } });
  try {
    await waitFrames(t.pid, 200);
    const off = await measure(t.pid, 3000);
    console.log(`  info cap off: ${fmt(off)}`);
    check(off && off.gpuLatKnown > 50, 'latency known for enough frames to compare');
    check(off && off.gpuLatUncMs !== null && off.gpuLatUncMs < 0.5, `latency pinned to better than half a millisecond (±${off && off.gpuLatUncMs && off.gpuLatUncMs.toFixed(2)})`);
    // GPU-bound and uncapped: the frame presented now finishes about a frame
    // after the one before it, so present-to-completion spans two frames.
    check(off && off.gpuLatMs > off.avgMs * 1.5, `uncapped latency spans more than one and a half frames (${off && off.gpuLatMs.toFixed(2)} ms vs ${off && off.avgMs.toFixed(2)} ms frames)`);

    // "One frame in flight" may already be how the driver runs the queue, so
    // it must at least never make things worse.
    tuning.writeConfig(t.pid, { flags: tuning.FLAGS.QUEUE_CAP, fps: 0, seq: 2 });
    const one = await measure(t.pid, 3000);
    console.log(`  info cap one: ${fmt(one)}`);
    check(one && one.header.appliedFlags & tuning.FLAGS.QUEUE_CAP, 'DLL reports the cap in effect');
    check(one && one.gpuLatMs <= off.gpuLatMs * 1.05, `one-frame cap never adds latency (${one && one.gpuLatMs.toFixed(2)} vs ${off.gpuLatMs.toFixed(2)} ms)`);
    check(one && one.fps > off.fps * 0.9, `one-frame cap keeps the frame rate within 10% (${one && one.fps.toFixed(1)} vs ${off.fps.toFixed(1)})`);

    // Ultra waits for the frame itself: the wait moves from inside Present to
    // our fence, and the frame is done a full frame earlier than uncapped.
    tuning.writeConfig(t.pid, { flags: tuning.FLAGS.QUEUE_CAP | tuning.FLAGS.QUEUE_ULTRA, fps: 0, seq: 3 });
    const ultra = await measure(t.pid, 3000);
    console.log(`  info ultra: ${fmt(ultra)}`);
    check(ultra && (ultra.header.appliedFlags & tuning.FLAGS.QUEUE_ULTRA) !== 0, 'DLL reports ultra in effect');
    check(ultra && ultra.gpuLatMs < off.gpuLatMs - 0.5 * off.avgMs, `ultra cuts present-to-completion latency by at least half a frame (${ultra && ultra.gpuLatMs.toFixed(2)} vs ${off.gpuLatMs.toFixed(2)} ms)`);
    check(ultra && ultra.gpuWaitMs > 1, `ultra is doing the waiting (${ultra && ultra.gpuWaitMs.toFixed(2)} ms/frame)`);
    check(ultra && ultra.presentMs < off.presentMs * 0.5, `the wait left Present (${ultra && ultra.presentMs.toFixed(2)} vs ${off.presentMs.toFixed(2)} ms inside Present)`);
    check(ultra && ultra.fps > off.fps * 0.85, `ultra keeps the frame rate within 15% on a GPU-bound control (${ultra && ultra.fps.toFixed(1)} vs ${off.fps.toFixed(1)})`);

    // Just in time: the default. On a GPU-bound control it must take most of
    // ultra's latency gain and none of its frame-rate cost.
    tuning.writeConfig(t.pid, { flags: tuning.FLAGS.QUEUE_AUTO, fps: 0, seq: 4 });
    const jit = await measure(t.pid, 3000);
    console.log(`  info just in time: ${fmt(jit)}`);
    check(jit && (jit.header.appliedFlags & tuning.FLAGS.QUEUE_AUTO) !== 0, 'DLL reports just-in-time armed');
    check(jit && (jit.flags & tuning.FLAGS.QUEUE_CAP) !== 0, 'just in time engaged on the GPU-bound control (frames carry the wait bit)');
    check(jit && jit.gpuLatMs < off.gpuLatMs - 0.5 * off.avgMs, `just in time cuts latency by at least half a frame (${jit && jit.gpuLatMs.toFixed(2)} vs ${off.gpuLatMs.toFixed(2)} ms)`);
    check(jit && jit.presentMs < off.presentMs * 0.5, `the game no longer waits in Present (${jit && jit.presentMs.toFixed(2)} vs ${off.presentMs.toFixed(2)} ms)`);
    check(jit && jit.fps > off.fps * 0.95, `just in time keeps the frame rate within 5% (${jit && jit.fps.toFixed(1)} vs ${off.fps.toFixed(1)})`);

    tuning.writeConfig(t.pid, { flags: 0, fps: 0, seq: 5 });
    const back = await measure(t.pid, 2000);
    console.log(`  info back off: ${fmt(back)}`);
    check(back && back.header.appliedFlags === 0, 'cap released live');
    check(back && back.header.disabled === '', `no fault along the way (errors=${back && back.header.errors})`);
    check(alive(t.pid), 'target process alive throughout');
  } finally {
    t.kill();
    await t.exited;
    tuning.removeFiles(t.pid);
  }

  // The other half of "no gain, no cost": a CPU-bound control, where there is
  // nothing to gain, must be left exactly as it was.
  const c = await startTarget({ config: { flags: 0, fps: 0, seq: 1 }, cpu: 8 });
  try {
    await waitFrames(c.pid, 200);
    const off = await measure(c.pid, 2500);
    console.log(`  info cpu-bound off: ${fmt(off)}`);
    check(off && off.cpuMs > off.avgMs * 0.6, `control is CPU-bound (${off && off.cpuMs.toFixed(2)} ms of ${off && off.avgMs.toFixed(2)} ms is CPU work)`);
    tuning.writeConfig(c.pid, { flags: tuning.FLAGS.QUEUE_AUTO, fps: 0, seq: 2 });
    const jit = await measure(c.pid, 2500);
    console.log(`  info cpu-bound jit: ${fmt(jit)}`);
    check(jit && (jit.flags & tuning.FLAGS.QUEUE_CAP) === 0, 'just in time never engages when the CPU is the bottleneck');
    check(jit && Math.abs(jit.fps - off.fps) / off.fps < 0.03, `frame rate untouched (${jit && jit.fps.toFixed(1)} vs ${off.fps.toFixed(1)})`);
    check(jit && jit.gpuWaitMs < 0.05, `no wait added (${jit && jit.gpuWaitMs.toFixed(3)} ms/frame)`);
    check(alive(c.pid), 'CPU-bound control alive');
  } finally {
    c.kill();
    await c.exited;
    tuning.removeFiles(c.pid);
  }
}

async function suiteFailsafe() {
  // 1. A config from the future: right magic, wrong version.
  {
    const t = await startTarget({
      beforeInject: async (pid) => {
        const b = tuning.encodeConfig({ flags: 7, fps: 60, seq: 1 });
        b.writeUInt32LE(99, 4);
        fs.mkdirSync(tuning.tuningDir(), { recursive: true });
        fs.writeFileSync(tuning.configPath(pid), b);
      },
    });
    try {
      await sleep(4000);
      check(alive(t.pid), 'process alive with an unknown config version');
      check(!fs.existsSync(tuning.statsPath(t.pid)), 'no stats file created: tuning stayed inert');
    } finally {
      t.kill(); await t.exited; tuning.removeFiles(t.pid);
    }
  }
  // 2. A stats path that cannot be a file: a directory already sits there.
  {
    const t = await startTarget({
      config: { flags: 7, fps: 60, seq: 1 },
      beforeInject: async (pid) => { fs.mkdirSync(tuning.statsPath(pid), { recursive: true }); },
    });
    try {
      await sleep(4000);
      check(alive(t.pid), 'process alive when the stats file cannot be created');
      check(fs.statSync(tuning.statsPath(t.pid)).isDirectory(), 'the obstacle is still a directory (nothing forced)');
    } finally {
      t.kill(); await t.exited;
      try { fs.rmdirSync(tuning.statsPath(t.pid)); } catch { /* fine */ }
      tuning.removeFiles(t.pid);
    }
  }
  // 3. Positive control for the alive check: a killed process reads as dead.
  {
    const t = await startTarget({ inject: false });
    t.kill(); await t.exited;
    check(!alive(t.pid), 'alive() reports a killed process as gone (control)');
  }
}

async function suitePresent1() {
  const t = await startTarget({ config: { flags: 0, fps: 0, seq: 1 }, present1: true });
  try {
    const h = await waitFrames(t.pid, 100);
    check(h && h.frames >= 100, `frames recorded through Present1: ${h ? h.frames : 'no stats'}`);
    check(h && (h.hooks & 2) === 2, `Present1 hooked (hooks=${h && h.hooks})`);
    check(h && h.api === 'D3D11', `API identified: ${h && h.api}`);
    const s = await measure(t.pid, 2000);
    console.log(`  info ${fmt(s)}`);
    check(s && s.count > 50, 'frame timing flows through the flip-model path');
    check(alive(t.pid), 'target process alive');
  } finally {
    t.kill(); await t.exited; tuning.removeFiles(t.pid);
  }
}

async function suiteHelper() {
  const run = (args) => {
    const r = spawnSync(HELPER, args, { encoding: 'utf8' });
    let json = null;
    try { json = JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop()); } catch { /* not json */ }
    return { status: r.status, json, raw: r.stdout };
  };
  const topo = run(['topology']);
  check(topo.status === 0 && topo.json && topo.json.cores > 0, `topology: ${topo.json ? `${topo.json.cores} cores, ${topo.json.logical} logical, hybrid=${topo.json.hybrid}, l3=${topo.json.l3.length}` : topo.raw}`);
  check(topo.json && ['none', 'pcores', 'vcache'].includes(topo.json.recommend.mode), `recommendation is one of the three modes: ${topo.json && topo.json.recommend.mode}`);
  const disp = run(['display', 'query']);
  check(disp.status === 0 && disp.json && disp.json.hz > 0 && Array.isArray(disp.json.rates), `display: ${disp.json ? `${disp.json.width}x${disp.json.height} @ ${disp.json.hz} Hz, rates ${disp.json.rates.join('/')}` : disp.raw}`);

  // Affinity on a live process, read back.
  const t = await startTarget({ inject: false });
  try {
    const before = run(['affinity-get', String(t.pid)]);
    check(before.status === 0 && before.json && before.json.cpusets.length === 0, `no default CPU set before (${before.json && before.json.cpusets.length})`);
    const apply = run(['affinity', String(t.pid), 'mask:0x3']);
    check(apply.status === 0 && apply.json && apply.json.applied, `mask applied: ${apply.raw.trim()}`);
    const after = run(['affinity-get', String(t.pid)]);
    const viaCpusets = after.json && after.json.cpusets.length === 2;
    const viaMask = after.json && after.json.affinity.toLowerCase() === '0x3';
    check(after.status === 0 && (viaCpusets || viaMask), `process reports it: ${after.raw.trim()}`);
    const clear = run(['affinity', String(t.pid), 'none']);
    check(clear.status === 0 && clear.json && clear.json.applied === false, `cleared: ${clear.raw.trim()}`);
    const auto = run(['affinity', String(t.pid), 'auto']);
    check(auto.status === 0 && auto.json && auto.json.mode === topo.json.recommend.mode, `auto follows the recommendation (${auto.json && auto.json.mode})`);
  } finally {
    t.kill(); await t.exited;
  }

  // Refresh rate: to another rate this display offers, then back.
  if (disp.json && disp.json.rates.length >= 2) {
    const from = disp.json.hz;
    const other = disp.json.rates.find((r) => r !== from && r >= 50) || disp.json.rates.find((r) => r !== from);
    const set = run(['display', 'set', String(other)]);
    check(set.status === 0 && set.json && set.json.changed && set.json.to === other, `switched ${from} -> ${other} Hz: ${set.raw.trim()}`);
    await sleep(1500);
    const mid = run(['display', 'query']);
    check(mid.json && mid.json.hz === other, `display reports ${mid.json && mid.json.hz} Hz`);
    const back = run(['display', 'set', String(from)]);
    check(back.status === 0 && back.json && back.json.to === from, `restored to ${from} Hz: ${back.raw.trim()}`);
    await sleep(1500);
    const end = run(['display', 'query']);
    check(end.json && end.json.hz === from, `display back at ${end.json && end.json.hz} Hz`);
    const max = run(['display', 'max']);
    check(max.status === 0 && max.json && max.json.to === disp.json.max_hz, `'max' targets the highest rate (${max.json && max.json.to})`);
    if (max.json && max.json.changed) { run(['display', 'set', String(from)]); await sleep(1000); }
  } else {
    check(false, 'display offers at least two refresh rates at this resolution');
  }
}

const SUITES = {
  'e2e-stats': suiteStats,
  'e2e-limiter': suiteLimiter,
  'e2e-queue': suiteQueue,
  'e2e-failsafe': suiteFailsafe,
  'e2e-present1': suitePresent1,
  'helper': suiteHelper,
};

const suite = process.argv[2];
if (!SUITES[suite]) {
  console.error(`unknown suite: ${suite}\nsuites: ${Object.keys(SUITES).join(', ')}`);
  process.exit(2);
}
for (const f of [TESTAPP, INJECTOR, DLL, HELPER]) {
  if (!fs.existsSync(f)) { console.error(`missing: ${f} (run the build suite first)`); process.exit(2); }
}
console.log(`suite ${suite}`);
try {
  await SUITES[suite]();
} catch (e) {
  failures++;
  console.log(`  FAIL threw: ${e.stack || e.message}`);
}
if (failures) { console.log(`FAILED ${suite}: ${failures} check(s)`); process.exit(1); }
console.log(`OK ${suite}`);
