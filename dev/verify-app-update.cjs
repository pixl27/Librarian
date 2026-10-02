// The installer and the self-updater, end to end, on this machine but off the
// real profile.
//
//   set ELECTRON_RUN_AS_NODE=1
//   node_modules/electron/dist/electron.exe dev/verify-app-update.cjs <A> <B> [<C>] [--out=<dir>]
//
// A, B, C are output folders of `dev/build-installer.cjs --feed=http://127.0.0.1:8765/
// --version=<v>` for three increasing versions. The script:
//   1. serves B on a local feed (with HTTP range requests, single and multiple,
//      so the differential download is exercised as GitHub serves it);
//   2. installs A silently into a scratch folder;
//   3. starts it on a fresh profile (LIBRARIAN_PROFILE_DIR) and reads, through
//      the DevTools protocol, the settings a friend starts with;
//   4. waits for the update to download, closes the window like the X button,
//      and checks that the installer ran on the way out (version B, no relaunch);
//   5. with C: serves C, starts B, waits for the update, presses the title-bar
//      chip, and checks the restart path (version C, relaunched);
//   6. uninstalls, and removes what the test created.
// It needs Electron's Node (global WebSocket and fetch). Screenshots of each
// state land in --out.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const outArg = process.argv.find(a => a.startsWith('--out='));
const [A, B, C] = positional.map(p => path.resolve(p));
if (!A || !B) throw new Error('Usage: verify-app-update.cjs <build A> <build B> [<build C>] [--out=dir]');

const PORT = 8765;
// A fresh DevTools port per start: the one a closing copy just released can
// still refuse a new listener for a while, and the second start then ran blind.
let debugPort = 9332;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-update-e2e-'));
const out = outArg ? path.resolve(outArg.slice(6)) : path.join(os.tmpdir(), 'librarian-update-shots');
fs.mkdirSync(out, { recursive: true });
const feed = path.join(temp, 'feed');
const installDir = path.join(temp, 'Librarian');
const profile = path.join(temp, 'profile');
const exe = path.join(installDir, 'Librarian.exe');
const updaterCache = path.join(process.env.LOCALAPPDATA, 'librarian-updater');
const cacheExisted = fs.existsSync(updaterCache);
const realUpdaterLog = path.join(process.env.APPDATA, 'librarian', 'logs', 'updater.log');
const realLogBefore = fs.existsSync(realUpdaterLog) ? fs.statSync(realUpdaterLog).size : -1;

const results = [];
const step = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(what, fn, timeoutMs, everyMs = 1000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

// ── The feed ────────────────────────────────────────────────────
const served = { full: 0, ranged: 0, rangeRequests: 0, files: {} };
function publishFeed(build, previous) {
  fs.rmSync(feed, { recursive: true, force: true });
  fs.mkdirSync(feed, { recursive: true });
  for (const name of fs.readdirSync(build)) {
    if (/\.(exe|blockmap)$/.test(name) || name === 'latest.yml') fs.copyFileSync(path.join(build, name), path.join(feed, name));
  }
  // The differential download asks for the installed version's blockmap too.
  for (const name of fs.readdirSync(previous)) {
    if (name.endsWith('.blockmap')) fs.copyFileSync(path.join(previous, name), path.join(feed, name));
  }
}
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://feed').pathname).replace(/^\/+/, '');
  const file = path.join(feed, name);
  if (!file.startsWith(feed + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  const size = fs.statSync(file).size;
  served.files[name] = (served.files[name] || 0) + 1;
  const range = req.headers.range;
  if (!range) {
    served.full += size;
    res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  served.rangeRequests++;
  const parts = range.replace(/^bytes=/, '').split(',').map(s => s.trim()).filter(Boolean).map((s) => {
    const [a, b] = s.split('-');
    const start = a === '' ? size - Number(b) : Number(a);
    const end = a === '' || b === '' ? size - 1 : Math.min(Number(b), size - 1);
    return [start, end];
  });
  if (parts.length === 1) {
    const [s, e] = parts[0];
    served.ranged += e - s + 1;
    res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/${size}`, 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' });
    fs.createReadStream(file, { start: s, end: e }).pipe(res);
    return;
  }
  const boundary = 'LibrarianFeedBoundary';
  const fd = fs.openSync(file, 'r');
  const chunks = [];
  parts.forEach(([s, e], i) => {
    chunks.push(Buffer.from(`${i ? '\r\n' : ''}--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${s}-${e}/${size}\r\n\r\n`));
    const data = Buffer.alloc(e - s + 1);
    fs.readSync(fd, data, 0, data.length, s);
    chunks.push(data);
    served.ranged += data.length;
  });
  fs.closeSync(fd);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  res.writeHead(206, { 'Content-Type': `multipart/byteranges; boundary=${boundary}`, 'Content-Length': body.length });
  res.end(body);
});

// ── The installed app ───────────────────────────────────────────
function childEnv() {
  const env = { ...process.env, LIBRARIAN_PROFILE_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
function installedVersion() {
  if (!fs.existsSync(exe)) return '';
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${exe}').VersionInfo.ProductVersion`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

/**
 * The relaunch after an update goes through the Windows shell, which drops
 * LIBRARIAN_PROFILE_DIR, so the new copy would open the real profile. A guard
 * holding that profile's instance lock makes it quit on its first line, and
 * the second-instance event it receives is the proof the relaunch happened.
 * If the user's own Librarian already holds the lock, it plays the same part.
 */
function startGuard() {
  const dir = path.join(temp, 'guard');
  const report = path.join(dir, 'second-instance.json');
  const noLock = path.join(dir, 'no-lock');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'librarian-e2e-guard', main: 'main.js' }));
  fs.writeFileSync(path.join(dir, 'main.js'), [
    "const { app } = require('electron');",
    "const fs = require('fs');",
    `app.setPath('userData', ${JSON.stringify(path.join(process.env.APPDATA, 'librarian'))});`,
    `if (!app.requestSingleInstanceLock()) { fs.writeFileSync(${JSON.stringify(noLock)}, '1'); app.exit(0); }`,
    `app.on('second-instance', (_e, argv) => fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ argv, at: Date.now() })));`,
    "app.on('window-all-closed', () => {});",
    'setTimeout(() => app.exit(0), 10 * 60 * 1000);',
  ].join('\n'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [dir], { env, stdio: 'ignore' });
  return { child, report, noLock };
}
function runningFromInstall() {
  try {
    const outText = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | ? { $_.Path -and $_.Path.StartsWith('${installDir}', 'CurrentCultureIgnoreCase') } | % { $_.ProcessId }`], { encoding: 'utf8' });
    return outText.split(/\s+/).filter(Boolean).map(Number);
  } catch { return []; }
}
function killInstalled() {
  for (const pid of runningFromInstall()) { try { process.kill(pid); } catch { /* gone */ } }
}

async function devtools() {
  const page = await until('the DevTools endpoint', async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      return list.find(t => t.type === 'page' && /index\.html/.test(t.url));
    } catch { return null; }
  }, 60000);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const i = ++id;
    const timer = setTimeout(() => { pending.delete(i); reject(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(i, (msg) => { clearTimeout(timer); resolve(msg); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const shot = async (name) => {
    try {
      const r = await send('Page.captureScreenshot', { format: 'png' }, 15000);
      fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    } catch (err) { console.log(`(no screenshot for ${name}: ${err.message})`); }
  };
  return { evaluate, shot, close: () => { try { ws.close(); } catch { /* closed */ } } };
}

function launch() {
  debugPort++;
  const child = spawn(exe, [`--remote-debugging-port=${debugPort}`], { env: childEnv(), detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

async function waitForReady(page, label) {
  const seen = new Set();
  let shotDownloading = false;
  const state = await until(`update ${label} to be ready`, async () => {
    const s = await page.evaluate('window.api.getAppUpdate()').catch(() => null);
    if (!s) return null;
    seen.add(s.status);
    if (s.status === 'error') throw new Error(`Updater error: ${s.error}`);
    if (s.status === 'downloading' && !shotDownloading && s.percent > 5) {
      shotDownloading = true;
      await page.shot(`${label}-downloading`);
    }
    return s.status === 'ready' ? s : null;
  }, 6 * 60 * 1000, 400);
  return { state, seen: [...seen] };
}

async function main() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const vA = fs.readFileSync(path.join(A, 'latest.yml'), 'utf8').match(/^version: (.+)$/m)[1];
  const vB = fs.readFileSync(path.join(B, 'latest.yml'), 'utf8').match(/^version: (.+)$/m)[1];
  const vC = C ? fs.readFileSync(path.join(C, 'latest.yml'), 'utf8').match(/^version: (.+)$/m)[1] : '';
  const setup = (dir, v) => path.join(dir, `Librarian-Setup-${v}.exe`);

  // 2 ── silent install of A
  const install = spawnSync(setup(A, vA), ['/S', `/D=${installDir}`], { timeout: 10 * 60 * 1000 });
  assert.equal(install.status, 0, `installer exit ${install.status}`);
  assert.ok(fs.existsSync(exe), 'Librarian.exe installed');
  assert.ok(fs.existsSync(path.join(installDir, 'resources', 'app-update.yml')), 'update channel installed');
  assert.ok(fs.existsSync(path.join(installDir, 'resources', 'deps', 'bepinex', 'winhttp.dll')), 'BepInEx shipped');
  assert.ok(fs.existsSync(path.join(installDir, 'resources', 'deps', 'librarian', 'PeakJoinFriend.dll')), 'PEAK plugin shipped');
  assert.ok(fs.existsSync(path.join(installDir, 'resources', 'deps', 'valheim-online', 'Librarian.ValheimOnline.dll')), 'Valheim adapter shipped');
  assert.ok(installedVersion().startsWith(vA), `installed ${installedVersion()}`);
  step('Silent install', `${vA} into ${installDir}, mods and update channel included`);

  // 3 ── first start on a fresh profile
  publishFeed(B, A);
  launch();
  let page = await devtools();
  await until('the renderer', () => page.evaluate('Boolean(window.Librarian && window.Librarian.settings && window.Librarian.settings.tuning)'), 60000);
  const first = await page.evaluate(`(async () => {
    const s = window.Librarian.settings;
    await new Promise(r => setTimeout(r, 1500));
    return {
      version: await window.api.getVersion(),
      generate_achievements: s.generate_achievements, tuning: s.tuning, game_presets: s.game_presets,
      secrets: s.secrets_present, csrin_username: s.csrin_username, steam_path: s.steam_path,
      default_install_path: s.default_install_path, onboarded: s.onboarded,
      onboardingShown: !document.getElementById('onboard').classList.contains('hidden'),
      presets: (await window.api.listPresets([])).map(p => p.name + ':' + p.steps.join('+')),
    };
  })()`);
  assert.equal(first.version, vA);
  assert.equal(first.generate_achievements, true);
  assert.deepEqual(first.tuning, { enabled: false, queue: 'auto', limiter: false, fps: 0, affinity: 'auto', priority: true, refresh: true, power: true });
  assert.equal(first.game_presets, true);
  assert.deepEqual(first.secrets, { steam_password: false, csrin_password: false, hubcap_api_key: false, steam_web_api_key: true });
  assert.equal(first.csrin_username, '');
  assert.equal(first.default_install_path, '');
  assert.equal(first.onboarded, false);
  assert.deepEqual(first.presets, ['Valheim:online', 'PEAK:online+peakMod']);
  await page.shot('first-start');
  // Out of the way of the later captures, as a friend would.
  await page.evaluate(`document.getElementById('onboard-skip')?.click()`);
  step('Fresh profile', `defaults as shipped, no personal credentials, onboarding ${first.onboardingShown ? 'shown' : 'hidden'}, presets ${first.presets.join(', ')}`);

  // 4 ── update downloads, then installs on the way out
  const toB = await waitForReady(page, vB);
  assert.equal(toB.state.available, vB);
  assert.match(toB.state.notes, /Test update/);
  await page.evaluate(`(async () => {
    window.Librarian.navigateTo('settings');
    await new Promise(r => setTimeout(r, 800));
    [...document.querySelectorAll('#settings-nav button')].find(b => b.textContent === 'Updates')?.click();
    await new Promise(r => setTimeout(r, 1200));
  })()`);
  await page.shot(`${vB}-ready`);
  const chip = await page.evaluate(`({ hidden: document.getElementById('top-app-update').classList.contains('hidden'), text: document.getElementById('top-app-update-text').textContent, card: document.getElementById('au-card').dataset.status })`);
  assert.equal(chip.hidden, false);
  assert.equal(chip.text, 'Restart to update');
  assert.equal(chip.card, 'ready');
  const log = fs.readFileSync(path.join(profile, 'logs', 'updater.log'), 'utf8');
  const differential = /Download block maps|differential/i.test(log) && !/fallback to full download/i.test(log);
  step('Update found and downloaded', `${toB.seen.join(' → ')}; served ${(served.ranged / 1048576).toFixed(1)} MB in ${served.rangeRequests} range requests + ${(served.full / 1048576).toFixed(1)} MB whole files; ${differential ? 'differential' : 'full download'}`);

  await page.evaluate('window.api.close()').catch(() => {});
  page.close();
  await until(`version ${vB} on disk`, () => installedVersion().startsWith(vB), 5 * 60 * 1000, 2000);
  await sleep(8000);
  const relaunched = runningFromInstall();
  assert.equal(relaunched.length, 0, 'closing installs silently, without starting Librarian again');
  step('Installed on close', `${vA} → ${installedVersion()}, not relaunched`);

  // 5 ── restart from the chip
  if (C) {
    publishFeed(C, B);
    launch();
    page = await devtools();
    await until('the renderer', () => page.evaluate('Boolean(window.Librarian && window.Librarian.settings)'), 60000);
    assert.equal(await page.evaluate('window.api.getVersion()'), vB);
    const toC = await waitForReady(page, vC);
    await page.shot(`${vC}-ready-chip`);
    const guard = startGuard();
    await sleep(3000);
    await page.evaluate(`document.getElementById('top-app-update').click()`);
    page.close();
    await until(`version ${vC} on disk`, () => installedVersion().startsWith(vC), 5 * 60 * 1000, 2000);
    let relaunch = 'by your running Librarian (it held the profile lock)';
    if (!fs.existsSync(guard.noLock)) {
      const seen = await until('the relaunched copy', () => (fs.existsSync(guard.report) ? JSON.parse(fs.readFileSync(guard.report, 'utf8')) : null), 120000, 1000);
      assert.ok(seen.argv.includes('--updated'), `relaunch argv: ${seen.argv.join(' ')}`);
      relaunch = `with --updated, stopped by the guard before touching the real profile`;
    }
    try { guard.child.kill(); } catch { /* gone */ }
    const realLogTouched = fs.existsSync(realUpdaterLog) && fs.statSync(realUpdaterLog).size !== realLogBefore;
    assert.equal(realLogTouched, false, 'the relaunched copy must not have run on the real profile');
    step('Restart from the title-bar chip', `${toC.seen.join(' → ')}; ${vB} → ${installedVersion()}, relaunched ${relaunch}`);
    killInstalled();
    await sleep(3000);
  }
}

main()
  .catch((err) => { console.error('FAIL', err.stack || err.message); process.exitCode = 1; })
  .finally(async () => {
    try { killInstalled(); } catch { /* none */ }
    await sleep(2000);
    // 6 ── uninstall and tidy up
    const uninstaller = path.join(installDir, 'Uninstall Librarian.exe');
    if (fs.existsSync(uninstaller)) {
      const r = spawnSync(uninstaller, ['/S'], { timeout: 5 * 60 * 1000 });
      // The uninstaller copies itself to %TEMP% and returns at once; wait for the folder.
      try { await until('the uninstaller', () => !fs.existsSync(exe), 120000, 1500); console.log(`PASS Uninstall — exit ${r.status}, Librarian.exe removed`); }
      catch (e) { console.log(`FAIL Uninstall — ${e.message}`); process.exitCode = 1; }
    }
    if (!cacheExisted) fs.rmSync(updaterCache, { recursive: true, force: true });
    server.close();
    console.log(JSON.stringify({ passed: results.length, out, served: { ...served, files: served.files } }, null, 1));
    // About 200 MB of feed and install: kept only when something failed.
    if (process.exitCode) console.log(`(scratch folder kept for inspection: ${temp})`);
    else fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  });
