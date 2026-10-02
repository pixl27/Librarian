// Native regression: real D3D11 Present/Present1, shipped overlay and injector.
// A harmless DLL bearing Steam's renderer name tests loaded-module detection;
// the actual Steam renderer is covered by the separate Valheim launch check.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const tuning = require('../src/core/tuning');
const { compile, findVcvars } = require('../native/achoverlay/build');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-overlay-conflict-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const dll = path.join(root, 'deps/librarian/librarian_achoverlay.dll');
const injector = path.join(root, 'deps/librarian/librarian_inject.exe');
const reports = [];
async function run(mode, config, loaded, present1) {
  const dir = path.join(work, mode); fs.mkdirSync(dir);
  const exe = path.join(dir, 'render-test.exe');
  fs.copyFileSync(path.join(root, 'dev/bin/librarian_d3d11test.exe'), exe);
  if (config !== null) fs.writeFileSync(path.join(dir, 'librarian_online.ini'), `steam_overlay=${config}\n`);
  const child = spawn(exe, ['200', '7', ...(present1 ? ['--present1'] : [])], { cwd: dir, windowsHide: true, stdio: 'ignore' });
  const exit = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    tuning.writeConfig(child.pid, { flags: 0, fps: 0 });
    if (loaded) execFileSync(injector, [String(child.pid), path.join(work, 'GameOverlayRenderer64.dll')], { windowsHide: true });
    execFileSync(injector, [String(child.pid), dll], { windowsHide: true });
    let header;
    for (let i = 0; i < 45; i++) {
      header = tuning.readStatsHeader(child.pid);
      if (header && (header.disabled || header.frames >= 20)) break;
      await sleep(100);
    }
    assert(header, `${mode}: no telemetry header`);
    if (loaded || config === 1) {
      assert.equal(header.disabled, 'steam-overlay', mode);
      assert.equal(header.hooks, 0, mode);
      assert.equal(header.canLimit, false, mode);
      assert.equal(header.canQueue, false, mode);
      assert.equal(header.frames, 0, mode);
    } else {
      assert.equal(header.disabled, '', mode);
      assert(header.frames >= 20, `${mode}: renderer stalled`);
      assert(header.hooks & (present1 ? 2 : 1), `${mode}: expected Present hook absent`);
    }
    assert.equal(await exit, 0, `${mode}: native target crashed`);
    reports.push({ mode, passed: true, header });
    console.log(`PASS ${mode}`);
  } finally {
    if (child.exitCode === null) child.kill();
    await exit.catch(() => {});
    for (const file of [tuning.configPath(child.pid), tuning.statsPath(child.pid)]) { try { fs.unlinkSync(file); } catch {} }
  }
}
(async () => {
  const stub = path.join(work, 'renderer-stub.c');
  fs.writeFileSync(stub, '#include <windows.h>\nBOOL WINAPI DllMain(HINSTANCE i,DWORD r,LPVOID p){return TRUE;}\n');
  compile(findVcvars(), `/nologo /LD /MT "${stub}" /link /OUT:"${path.join(work, 'GameOverlayRenderer64.dll')}"`, 'Steam renderer presence fixture');
  await run('overlay-requested-before-load', 1, false, false);
  await run('overlay-already-loaded-present1', null, true, true);
  await run('no-steam-overlay-present', null, false, false);
  await run('steam-overlay-off-present1', 0, false, true);
  const output = path.resolve(process.env.LIBRARIAN_TEST_OUTPUT || work);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'overlay-conflict-tests.json'), JSON.stringify({ tests: reports, work }, null, 2));
  console.log('4 native overlay conflict checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
