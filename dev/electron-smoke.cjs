// Exercise the production main/preload/renderer in an invisible Electron window.
// The user-data directory and library are temporary. Native game helpers are
// stubbed, network requests are blocked, and no real executable is launched.
const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const assert = require('assert/strict');
const { Worker } = require('worker_threads');
const root = path.resolve(__dirname, '..');
const target = process.argv.includes('--packaged') ? path.resolve(process.env.LIBRARIAN_TEST_PACKAGE || path.join(root, 'dist/win-unpacked/resources/app.asar')) : root;
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-electron-smoke-'));
const library = path.join(fixture, 'Library');
const output = process.env.LIBRARIAN_TEST_OUTPUT || path.join(root, 'audits/2026-09-07/fixes');
fs.mkdirSync(output, { recursive: true });
const report = { target, fixture, checks: [], errors: [], versions: process.versions };
app.setPath('userData', fixture);
process.env.LOCALAPPDATA = fixture;
process.env.LIBRARIAN_NO_GOLDBERG = '1';
fs.writeFileSync(path.join(fixture, 'librarian-settings.json'), JSON.stringify({ settings_version: 5, onboarded: true, news_enabled: false, notify_on_complete: false, auto_crack: false, manifest_source: 'hubcap', slssteam_mode: false, hero_rotate: false, reduce_motion: true, ui_kinetic: false, ui_tilt: false, steam_path: library, install_locations: [library], default_install_path: library }));
fs.mkdirSync(path.join(library, 'steamapps/common/Fixture/.DepotDownloader'), { recursive: true });
fs.writeFileSync(path.join(library, 'steamapps/common/Fixture/fixture.txt'), 'Test data. Not executable.');
fs.writeFileSync(path.join(library, 'steamapps/appmanifest_4242.acf'), '"AppState" { "appid" "4242" "installdir" "Fixture" "name" "Smoke fixture" "SizeOnDisk" "32" "InstalledDepots" { "4243" { "manifest" "99" } } }');

let mainWindow;
class InvisibleWindow extends BrowserWindow {
  constructor(options) {
    super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
    if (!mainWindow) mainWindow = this;
    this.webContents.setFrameRate(10); this.webContents.on('paint', () => {});
    this.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    this.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
  }
  show() {}
  focus() {}
  flashFrame() {}
}
const tuning = { recoverMachine() {}, shutdown() {}, subscribe() {}, getState: () => ({ profile: {}, available: {}, sessions: [], topology: {}, display: {} }) };
// The main process must retain ownership until the engine's done promise
// settles. Hold it open to exercise completion/cancellation without a network
// connection, a native downloader or any executable in the fixture library.
const engineRuns = [];
const manifestFixtures = new Map(), manifestRequests = [];
const engine = {
  checkNativeEngineSupport: () => ({ ok: true, missing: [] }),
  startNativeDownload(game, depots, destination, callbacks, target) {
    let release;
    const done = new Promise(resolve => { release = resolve; });
    const run = { game, depots, destination, target, callbacks, done, release, stops: 0, stop() { this.stops++; }, markPaused() { return true; }, markResumed() { return true; } };
    engineRuns.push(run);
    return run;
  },
};
const originalLoad = Module._load;
const { updateFixture } = require('./dlssg-update-fixture.cjs');
const updatePackage = updateFixture();
const dlssg = require(path.join(target, 'src/core/dlssg.js')).createManager({
  dataPath: path.join(fixture, 'dlssg-sm86'), hardware: async () => ({ supported: true, name: 'NVIDIA GeForce RTX 3060 Ti' }),
  ensureIdle: async () => {}, release: updatePackage.release, fetch: updatePackage.fetch,
});
Module._load = function(id, parent, isMain) {
  if (id === 'electron') return { ...electron, BrowserWindow: InvisibleWindow };
  if (id === 'worker_threads') return { ...originalLoad.call(this, id, parent, isMain), Worker: class extends Worker {
    constructor(file, options) { super(file, { ...options, workerData: { ...options?.workerData, libraries: [library] } }); }
  }, isMainThread: true };
  if (id.endsWith('/core/tuning') || id === './tuning') return tuning;
  if (id.endsWith('/core/dlssg')) return dlssg;
  if (id.endsWith('/core/steamPipe')) return engine;
  if (id.endsWith('/core/achievements')) return { init() {}, watch() {}, unwatch() {}, snapshot: () => ({ total: 0, unlocked: 0, items: [] }), getGameAchievements: async () => ({ total: 0, unlocked: 0, items: [] }) };
  if (id.endsWith('/core/autoCrack')) return { checkSacStatus: () => ({ cliExists: false, goldbergExists: false }), getSacDir: () => fixture };
  if (id === 'node-fetch') return async url => {
    const manifestId = String(url).match(/^https:\/\/hubcapmanifest\.com\/api\/v1\/manifest\/(\d+)$/)?.[1];
    if (manifestId && manifestFixtures.has(manifestId)) {
      manifestRequests.push(manifestId);
      const body = manifestFixtures.get(manifestId);
      return { ok: true, status: 200, body: require('stream').Readable.from([body]), headers: { get: key => key === 'content-length' ? String(body.length) : null } };
    }
    return String(url) === 'https://api.steamcmd.net/v1/info/4242'
    ? { ok: true, status: 200, json: async () => ({ status: 'success', data: { '4242': { common: { name: 'Public fixture title' }, depots: { branches: { public: { buildid: '200' } }, '4243': { manifests: { public: { gid: '100' } } } } } } }) }
    : { ok: false, status: 503, json: async () => ({}), text: async () => '' };
  };
  if (id === 'child_process') return { ...originalLoad.call(this, id, parent, isMain), execFileSync() { throw new Error('Native helper blocked by isolated smoke test'); } };
  return originalLoad.call(this, id, parent, isMain);
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => mainWindow.webContents.executeJavaScript(code, true);
process.on('uncaughtException', error => { report.fatal = error.stack; finish(1); });
function finish(code) {
  fs.writeFileSync(path.join(output, process.argv.includes('--packaged') ? 'packaged-smoke.json' : 'electron-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks, fatal: report.fatal, errors: report.errors }, null, 2));
  app.exit(code);
}
if (process.argv.includes('--packaged')) {
  Object.defineProperty(app, 'isPackaged', { value: true });
  Object.defineProperty(process, 'resourcesPath', { value: path.dirname(target) });
  app.getAppPath = () => target;
}
require(path.join(target, 'main.js'));
app.whenReady().then(async () => {
  for (let n = 0; n < 200; n++) {
    if (mainWindow && !mainWindow.webContents.isLoading() && await evaluate('Boolean(window.Librarian?.state.queueReady && Librarian.games.length)').catch(() => false)) break;
    await wait(100);
  }
  const games = await evaluate('api.scanGames()');
  assert.equal(games.length, 1); assert.equal(games[0].installed_manifests['4243'], '99'); assert(games[0].first_seen > 0);
  report.checks.push('Production scan IPC -> real worker -> metadata -> renderer');
  const apiDefaults = await evaluate('api.getAllSettings()');
  assert.equal(apiDefaults.secrets_present.hubcap_api_key, false);
  assert.equal(apiDefaults.secrets_present.steam_web_api_key, true);
  assert.equal(apiDefaults.steam_web_api_key, '');
  assert.equal((await evaluate('api.setSettings({achievement_popups:false})')).achievement_popups, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, 'librarian-settings.json'))).achievement_popups, false);
  await evaluate('api.setSetting("achievement_popups",true)');
  assert.equal(await evaluate('api.getSetting("achievement_popups")'), true);
  report.checks.push('Shared API defaults and overlay toggle through production settings IPC');
  const publicSettings = await evaluate('api.setSettings({steam_password:"smoke-secret-only",favorites:["steam:4242"]})');
  assert.equal(publicSettings.steam_password, ''); assert.equal(publicSettings.secrets_present.steam_password, true);
  assert(!fs.readFileSync(path.join(fixture, 'librarian-settings.json'), 'utf8').includes('smoke-secret-only'));
  report.checks.push('Real OS safeStorage round trip; secret absent from disk and public IPC');
  await evaluate('api.addQueueJob({id:777,name:"Saved smoke task",path:"C:/fixture.zip",destPath:"D:/Games",selectedDepots:["4243"]})');
  mainWindow.webContents.reload(); await new Promise(resolve => mainWindow.webContents.once('did-finish-load', resolve));
  for (let n = 0; n < 100 && !await evaluate('Boolean(window.Librarian?.state.queueReady)'); n++) await wait(100);
  const jobs = await evaluate('Librarian.state.queue'); assert.equal(jobs[0].id, 777); assert.equal(jobs[0].destPath, 'D:/Games');
  report.checks.push('Production queue survives renderer reload');
  const queue = require(path.join(target, 'src/core/downloadQueue.js'));
  queue.begin(777, { gameData: { ...games[0], installdir: 'Fixture' }, selectedDepots: ['4243'], destPath: library });
  queue.pause(true); queue.progress('percent', 35);
  const blocked = await evaluate('api.uninstallGame(Librarian.games[0])'); assert.equal(blocked.success, false); assert(blocked.error.includes('download'));
  const launchBlocked = await evaluate('api.launchGame(Librarian.games[0])'); assert.equal(launchBlocked.success, false); assert(launchBlocked.error.includes('download'));
  report.checks.push('Backend blocks uninstall and launch while this installation is being downloaded');
  mainWindow.webContents.reload(); await new Promise(resolve => mainWindow.webContents.once('did-finish-load', resolve));
  for (let n = 0; n < 100 && !await evaluate('Boolean(window.Librarian?.state.queueReady)'); n++) await wait(100);
  const resumed = await evaluate('({active:Librarian.state.isProcessing,paused:Librarian.state.isPaused,percent:Librarian.state.currentPercent})');
  assert(resumed.active && resumed.paused); assert.equal(resumed.percent, 35);
  report.checks.push('Active paused download reattaches after renderer reload');
  queue.finish('complete'); mainWindow.webContents.send('depot:complete');
  for (let n = 0; n < 100 && (await evaluate('api.getQueue()')).jobs.length; n++) await wait(50);
  assert.equal((await evaluate('api.getQueue()')).jobs.length, 0);
  report.checks.push('Completion removes the durable job through production IPC');
  const rogue = new InvisibleWindow({ webPreferences: { preload: path.join(target, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await rogue.loadURL('about:blank');
  const rejected = await rogue.webContents.executeJavaScript('api.getAllSettings().then(()=>false, error=>error.message.includes("Untrusted IPC sender"))');
  assert.equal(rejected, true); rogue.destroy();
  report.checks.push('IPC from a second renderer is rejected');
  const location = await evaluate('api.listInstallLocations()'); assert.equal(location.find(entry => entry.path === library).kind, 'custom');
  report.checks.push('Configured location stays removable in the destinations list');

  const customPath = path.join(fixture, 'Custom', 'My fixture game');
  fs.mkdirSync(customPath, { recursive: true }); fs.writeFileSync(path.join(customPath, 'fixture.txt'), 'Custom test data. Not executable.');
  const custom = await evaluate(`api.addCustomGame(${JSON.stringify({ game_name: 'My custom fixture', appid: '4242', install_path: customPath, executable: path.join(customPath, 'fixture.txt') })})`);
  await evaluate(`api.setSettings({favorites:["steam:4242",${JSON.stringify('custom:' + custom.id)}]})`);
  await evaluate('Librarian.scanAndRender()');
  await evaluate(`window.customFixtureId = ${JSON.stringify(custom.id)}; Librarian.openFlyout(Librarian.games.find(g => g.id === customFixtureId)); document.querySelector('#flyout-link-updates').click(); document.querySelector('#cu-inspect').click(); true;`);
  for (let n = 0; n < 100 && await evaluate('document.querySelector("#cu-save").disabled'); n++) await wait(30);
  const preview = await evaluate('document.querySelector("#cu-result").innerText');
  assert(preview.includes('Public fixture title') && preview.includes('200') && preview.includes('Unknown') && preview.includes(customPath), preview);
  assert.equal(await evaluate('document.querySelector("#cu-save").disabled'), false);
  const capture = async name => {
    for (let n = 0; n < 5; n++) {
      mainWindow.webContents.invalidate(); await wait(250);
      try {
        const shot = await mainWindow.webContents.capturePage();
        assert(!shot.isEmpty(), 'empty capture');
        fs.writeFileSync(path.join(output, `${process.argv.includes('--packaged') ? 'packaged-' : ''}${name}.png`), shot.toPNG()); return;
      } catch (error) { if (n === 4) throw new Error(`Capture ${name}: ${error.message}`); }
    }
  };
  mainWindow.setSize(1024, 600); await wait(120); await capture('custom-association-1024');
  await evaluate('document.querySelector("#cu-save").scrollIntoView({block:"end"}); true;'); await capture('custom-build-comparison');
  mainWindow.webContents.setZoomFactor(1.25); await wait(120); await capture('custom-association-zoom');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'association causes horizontal page overflow');
  mainWindow.webContents.setZoomFactor(1); mainWindow.setSize(1280, 800);
  await evaluate('document.querySelector("#cu-build").value = "100"; document.querySelector("#cu-build").dispatchEvent(new Event("input")); true;');
  assert.equal(await evaluate('document.querySelector("#cu-save").disabled'), true, 'editing evidence must invalidate the preview');
  await evaluate('document.querySelector("#cu-build").value = ""; document.querySelector("#cu-inspect").click(); true;');
  for (let n = 0; n < 100 && await evaluate('document.querySelector("#cu-save").disabled'); n++) await wait(30);
  await evaluate('document.querySelector("#cu-save").click(); true;');
  for (let n = 0; n < 100 && !await evaluate('Boolean(Librarian.games.find(g => g.id === customFixtureId)?.update_link)'); n++) await wait(30);
  const linked = await evaluate('Librarian.games.find(g => g.id === customFixtureId)');
  assert.equal(linked.source, 'Custom'); assert.equal(linked.executable, custom.executable); assert.equal(linked.buildid, null);
  assert((await evaluate('api.getAllSettings()')).favorites.includes('custom:' + custom.id));
  assert.equal(await evaluate('Boolean(document.querySelector("#flyout-update-now"))'), true);
  assert(!fs.existsSync(path.join(customPath, '.DepotDownloader')));
  report.checks.push('Custom association UI shows real local/remote evidence, invalidates edited previews and preserves identity/favorites');

  await evaluate('window.customOutcome = null; Librarian.queueGameUpdate(Librarian.games.find(g => g.id === customFixtureId)).then(v => { customOutcome = v; }); true;');
  for (let n = 0; n < 100 && !await evaluate('Boolean(document.querySelector("#confirm-cancel"))'); n++) await wait(30);
  const confirmation = await evaluate('document.querySelector("#modal-body").innerText');
  assert(confirmation.includes('Installed build: Unknown') && confirmation.includes('public build 200') && confirmation.includes(customPath), confirmation);
  await capture('custom-update-confirmation');
  await evaluate('document.querySelector("#confirm-cancel").click(); true;');
  for (let n = 0; n < 100 && !await evaluate('customOutcome'); n++) await wait(30);
  assert.equal((await evaluate('customOutcome')).reason, 'cancelled');
  assert.equal(queue.snapshot().jobs.length, 0);
  report.checks.push('Custom Update confirmation identifies the public build and exact existing folder; cancel starts no work');

  const customJob = { id: 750, name: 'Custom fixture update', customGameId: custom.id, updateRevision: linked.update_link.revision, targetBuildId: '200' };
  await evaluate(`api.addQueueJob(${JSON.stringify(customJob)})`);
  const payload = { jobId: 750, gameData: { appid: '4242', manifests: { '4243': '99' }, installdir: 'Wrong folder', buildid: '999' }, selectedDepots: ['4243'], destPath: path.join(fixture, 'Wrong destination') };
  const refused = await evaluate(`api.startDownload(${JSON.stringify(payload)})`);
  assert.equal(refused.success, false); assert(refused.error.includes('does not match public build')); assert.equal(engineRuns.length, 0);
  payload.gameData.manifests['4243'] = '100';
  const accepted = await evaluate(`api.startDownload(${JSON.stringify(payload)})`);
  assert.equal(accepted.success, true, accepted.error);
  const customRun = engineRuns.at(-1);
  assert.equal(customRun.target.installPath, customPath); assert.equal(customRun.destination, customPath);
  assert.equal(customRun.game.buildid, '200'); assert.equal(customRun.game.installdir, path.basename(customPath));
  assert.equal(customRun.game.skip_auto_crack, true); assert.equal(customRun.target.validateAll, true);
  const unlinkLocked = await evaluate('api.disconnectCustomUpdates(customFixtureId).then(()=>false, error=>error.message.includes("download"))');
  assert.equal(unlinkLocked, true);
  customRun.callbacks.onComplete(); customRun.release();
  for (let n = 0; n < 100 && queue.snapshot().active; n++) await wait(20);
  await evaluate('api.removeQueueJob(750)');
  report.checks.push('Production Custom download IPC rejects stale manifests, overrides client build/folder and locks its association until cleanup');
  // Simulate the engine result here; e2e-custom-update verifies the real writer.
  fs.mkdirSync(path.dirname(customRun.target.manifestPath), { recursive: true });
  fs.writeFileSync(customRun.target.manifestPath, '"AppState" { "appid" "4242" "installdir" "My fixture game" "buildid" "200" "InstalledDepots" { "4243" { "manifest" "100" } } }');
  const refreshed = await evaluate('api.refreshCustomUpdates(customFixtureId)');
  assert.equal(refreshed.buildid, '200'); assert.equal(refreshed.build_source, 'manifest');
  fs.writeFileSync(customRun.target.manifestPath, fs.readFileSync(customRun.target.manifestPath, 'utf8').replace('"buildid" "200"', '"buildid" "300"'));
  await evaluate('Librarian.scanAndRender()');
  await evaluate('Librarian.checkUpdateFor(Librarian.games.find(g => g.id === customFixtureId))');
  await evaluate('Librarian.openFlyout(Librarian.games.find(g => g.id === customFixtureId)); true;');
  const newerBadge = await evaluate('document.querySelector("#flyout-update-status").innerText');
  assert(newerBadge.includes('300') && newerBadge.includes('200') && newerBadge.includes('check the branch'), newerBadge);
  report.checks.push('A newer local build displays both distinct build IDs and never claims they match');
  await evaluate('api.disconnectCustomUpdates(customFixtureId)');
  assert(fs.existsSync(path.join(customPath, 'fixture.txt')));
  await evaluate('api.removeCustomGame(customFixtureId)'); await evaluate('Librarian.scanAndRender()');
  report.checks.push('A completed Custom record is reread from disk; unlinking preserves the game files');

  await require('./dlssg-smoke.cjs')({ evaluate, fixture, capture, mainWindow, wait, report, queue, dlssg, target });
  await require('./update-identity-smoke.cjs')({ evaluate, fixture, library, capture, wait, report, queue, target, engineRuns, manifestFixtures, manifestRequests });
  await require('./tuning-fps-smoke.cjs')({ evaluate, mainWindow, capture, wait, report });
  await require('./dlssg-updates-smoke.cjs')({ evaluate, fixture, capture, mainWindow, wait, report, dlssg, updatePackage });

  await evaluate('window.smokeEvents = []; api.onDownloadComplete(() => smokeEvents.push("complete")); api.onDownloadError(() => smokeEvents.push("error")); true;');
  const startHeldDownload = async id => {
    await evaluate(`api.addQueueJob({id:${id},name:"Held engine fixture"})`);
    const started = await evaluate(`api.startDownload(${JSON.stringify({ jobId: id, gameData: { ...games[0], installdir: 'Fixture' }, selectedDepots: ['4243'], destPath: library })})`);
    assert.equal(started.success, true, started.error);
    return engineRuns.at(-1);
  };
  const assertInstallationLocked = async id => {
    assert.equal(queue.snapshot().active?.jobId, id);
    const denied = await evaluate('api.uninstallGame(Librarian.games[0])');
    assert.equal(denied.success, false); assert(denied.error.includes('download'));
  };
  const completedEngine = await startHeldDownload(901);
  completedEngine.callbacks.onComplete();
  await wait(80);
  await assertInstallationLocked(901);
  assert.deepEqual(await evaluate('smokeEvents'), []);
  completedEngine.release();
  for (let n = 0; n < 100 && queue.snapshot().active; n++) await wait(20);
  assert.equal(queue.snapshot().active, null);
  assert.equal(queue.snapshot().jobs.find(job => job.id === 901).status, 'complete');
  for (let n = 0; n < 100 && !(await evaluate('smokeEvents.length')); n++) await wait(20);
  assert.deepEqual(await evaluate('smokeEvents'), ['complete']);
  await evaluate('api.removeQueueJob(901)');
  report.checks.push('Completion retains the installation lock and emits no event until engine cleanup finishes');

  const cancelledEngine = await startHeldDownload(902);
  await evaluate('window.smokeCancel = null; api.cancelDownload().then(value => { smokeCancel = {value}; }, error => { smokeCancel = {error:error.message}; }); true;');
  for (let n = 0; n < 100 && !cancelledEngine.stops; n++) await wait(20);
  assert.equal(cancelledEngine.stops, 1);
  await assertInstallationLocked(902);
  assert.equal(await evaluate('smokeCancel'), null);
  cancelledEngine.callbacks.onComplete(); cancelledEngine.callbacks.onError('Late cancelled callback');
  cancelledEngine.release();
  for (let n = 0; n < 100 && !(await evaluate('smokeCancel')); n++) await wait(20);
  assert.deepEqual(await evaluate('smokeCancel'), { value: true });
  assert.equal(queue.snapshot().active, null);
  assert.equal(queue.snapshot().jobs.find(job => job.id === 902).status, 'interrupted');
  assert.deepEqual(await evaluate('smokeEvents'), ['complete']);
  await evaluate('api.removeQueueJob(902)');
  report.checks.push('Cancel waits for cleanup, keeps the installation locked and ignores late callbacks');

  const fullDiskEngine = await startHeldDownload(903);
  const json = require(path.join(target, 'src/core/jsonFile.js'));
  const originalWrite = json.write;
  json.write = function(file, ...args) {
    if (file === path.join(fixture, 'librarian-download-queue.json')) throw Object.assign(new Error('ENOSPC: simulated full disk'), { code: 'ENOSPC' });
    return originalWrite.call(this, file, ...args);
  };
  try {
    await evaluate('window.smokeCancel = null; api.cancelDownload().then(value => { smokeCancel = {value}; }, error => { smokeCancel = {error:error.message}; }); true;');
    for (let n = 0; n < 100 && !fullDiskEngine.stops; n++) await wait(20);
    assert.equal(fullDiskEngine.stops, 1);
    await assertInstallationLocked(903);
    fullDiskEngine.release();
    for (let n = 0; n < 100 && !(await evaluate('smokeCancel')); n++) await wait(20);
    assert((await evaluate('smokeCancel')).error.includes('ENOSPC'));
    assert.equal(queue.snapshot().active, null);
  } finally { json.write = originalWrite; }
  await evaluate('api.removeQueueJob(903)');
  report.checks.push('A full disk does not prevent engine cancellation; the persistence error reaches the renderer');

  const closingEngine = await startHeldDownload(904);
  const closingGame = await evaluate(`api.addCustomGame(${JSON.stringify({ game_name: 'Closing graphics fixture', install_path: customPath, executable: path.join(customPath, 'fixture.txt') })})`);
  let releaseGraphics, graphicsStarted = false;
  const originalSetDlssg = dlssg.setEnabled;
  dlssg.setEnabled = () => new Promise(resolve => { graphicsStarted = true; releaseGraphics = () => resolve({ success: true }); });
  await evaluate(`api.setDlssg({game:${JSON.stringify(closingGame)},enabled:true}); true;`);
  for (let n = 0; n < 100 && !graphicsStarted; n++) await wait(10);
  assert(graphicsStarted);
  const willQuit = new Promise(resolve => app.once('will-quit', event => { event.preventDefault(); resolve(); }));
  app.quit();
  await wait(80);
  assert.equal(closingEngine.stops, 1);
  assert.equal(mainWindow.isDestroyed(), false);
  await assertInstallationLocked(904);
  app.quit(); // Repeated Close / Alt+F4 must not bypass the pending drain.
  await wait(80);
  assert.equal(mainWindow.isDestroyed(), false, 'A repeated quit destroyed the window before engine cleanup');
  assert.equal(closingEngine.stops, 1);
  closingEngine.release();
  await wait(80);
  assert.equal(mainWindow.isDestroyed(), false, 'Quit interrupted the graphics file operation');
  const closingToggle = await evaluate(`api.setDlssg({game:${JSON.stringify(closingGame)},enabled:false})`);
  assert.equal(closingToggle.success, false); assert(closingToggle.error.includes('closing'));
  releaseGraphics(); dlssg.setEnabled = originalSetDlssg;
  await willQuit;
  assert.equal(queue.snapshot().active, null);
  assert.equal(queue.snapshot().jobs.find(job => job.id === 904).status, 'interrupted');
  report.checks.push('Repeated app.quit keeps the window alive until the download drains and saves interrupted intent');
  report.checks.push('Quit also waits for the DLSSG file transaction and refuses new graphics changes while closing');
  finish(0);
}).catch(error => { report.fatal = error.stack; finish(1); });
setTimeout(() => { report.fatal = 'Smoke test timed out'; finish(1); }, 90000).unref();
