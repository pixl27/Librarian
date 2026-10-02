// Behavioral regressions against the real modules, with temporary user data.
// No game, registry, tuning helper, injector or remote downloader is executed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const assert = require('assert/strict');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-reliability-'));
const results = [];
const plain = value => JSON.parse(JSON.stringify(value));

function context(name, overrides = {}) {
  const dir = path.join(temp, name); fs.mkdirSync(dir, { recursive: true });
  const electron = { app: { getPath: () => dir }, safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`test-cipher:${Buffer.from(value).toString('base64')}`),
    decryptString: value => Buffer.from(value.toString().replace(/^test-cipher:/, ''), 'base64').toString(),
  } };
  const cache = new Map();
  function load(file) {
    file = path.resolve(root, file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const nativeRequire = Module.createRequire(file);
    const localRequire = id => {
      if (Object.hasOwn(overrides, id)) return overrides[id];
      if (id === 'electron') return electron;
      if (id.startsWith('.')) {
        const resolved = nativeRequire.resolve(id);
        if (resolved.startsWith(path.join(root, 'src', 'core'))) return load(resolved);
      }
      return nativeRequire(id);
    };
    const run = vm.runInNewContext(`(function(require,module,exports,__filename,__dirname){${fs.readFileSync(file, 'utf8')}\n})`, {
      Buffer, process: overrides.process || process, Date: overrides.Date || Date, console, setTimeout, clearTimeout, setInterval: overrides.setInterval || (() => ({ unref() {} })), clearInterval, URL, AbortController,
    }, { filename: file });
    run(localRequire, module, module.exports, file, path.dirname(file));
    return module.exports;
  }
  return { dir, load, electron };
}

async function test(name, fn) {
  const start = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - start }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.error(`FAIL ${name}\n${error.stack}`); }
}

(async () => {
  await test('All production JavaScript parses', () => {
    const files = ['main.js', 'preload.js'];
    const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (/\.js$/.test(file) && !file.includes(`${path.sep}vendor${path.sep}`)) files.push(file);
    } };
    walk(path.join(root, 'src'));
    for (const file of files) new vm.Script(fs.readFileSync(path.resolve(root, file), 'utf8'), { filename: file });
  });
  await test('Settings commit is atomic, copied on read, and rejects disk-full writes', () => {
    let fail = false;
    const c = context('settings', { fs: { ...fs, writeFileSync(...args) { if (fail) throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }); return fs.writeFileSync(...args); } } });
    const settings = c.load('src/core/settingsStore.js');
    settings.set('library_sort', 'recent');
    fail = true;
    assert.throws(() => settings.set('library_sort', 'size'), /Disk full/);
    assert.equal(settings.get('library_sort'), 'recent');
    assert.equal(JSON.parse(fs.readFileSync(path.join(c.dir, 'librarian-settings.json'))).library_sort, 'recent');
    settings.get('favorites').push('steam:9'); assert.deepEqual(plain(settings.get('favorites')), []);
  });
  await test('Shared defaults leave Hubcap empty and preserve cleared keys and overlay preferences', () => {
    const c = context('shared-defaults');
    const settings = c.load('src/core/settingsStore.js');
    assert.equal(settings.get('hubcap_api_key'), '');
    assert.equal(settings.getPublic().secrets_present.steam_web_api_key, true);
    assert.equal(settings.getPublic('steam_web_api_key'), '');
    settings.setMany({ achievement_popups: false, steam_web_api_key: '' });
    const saved = JSON.parse(fs.readFileSync(path.join(c.dir, 'librarian-settings.json')));
    const reopened = context('shared-defaults-reopened');
    fs.writeFileSync(path.join(reopened.dir, 'librarian-settings.json'), JSON.stringify(saved));
    const fresh = reopened.load('src/core/settingsStore.js');
    assert.equal(fresh.get('achievement_popups'), false);
    assert.equal(fresh.get('steam_web_api_key'), '');
    fresh.set('achievement_popups', true);
    assert.equal(fresh.get('achievement_popups'), true);
  });
  await test('Disabling the overlay hides the mapped frame and blocks queued paints and unlocks', () => {
    let enabled = true, renderer;
    class Window extends EventEmitter {
      constructor() {
        super(); renderer = this; this.dead = false;
        this.webContents = new EventEmitter();
        Object.assign(this.webContents, { setFrameRate() {}, setBackgroundThrottling() {}, isLoading: () => true, send() { throw new Error('Disabled overlay sent a queued popup'); } });
      }
      loadFile() {}
      isDestroyed() { return this.dead; }
      destroy() { this.dead = true; this.emit('closed'); }
    }
    const c = context('overlay-toggle', { './settingsStore': { get: key => key === 'achievement_popups' ? enabled : 0.15 } });
    c.electron.BrowserWindow = Window;
    const feed = c.load('src/core/overlayFeed.js');
    const mapping = feed.open(1234);
    try {
      feed.show({ name: 'Fixture' });
      const paint = () => renderer.webContents.emit('paint', null, null, { getSize: () => ({ width: 1, height: 1 }), toBitmap: () => Buffer.alloc(4) });
      const visible = () => { const bytes = Buffer.alloc(4); fs.readSync(mapping.fd, bytes, 0, 4, 12); return bytes.readUInt32LE(); };
      paint(); assert.equal(visible(), 1);
      enabled = false; feed.dismiss();
      assert.equal(visible(), 0);
      paint(); assert.equal(visible(), 0);
      renderer.webContents.emit('did-finish-load');
      feed.show({ name: 'Ignored' }); assert(renderer.dead);
      enabled = true; feed.show({ name: 'Enabled again' }); assert(!renderer.dead);
    } finally { feed.stop(); }
  });
  await test('Credential migration encrypts on disk and redacts all renderer reads', () => {
    const c = context('secrets');
    fs.writeFileSync(path.join(c.dir, 'librarian-settings.json'), JSON.stringify({ settings_version: 5, steam_password: 'fake-password-123', hubcap_api_key: 'fake-key-987' }));
    fs.writeFileSync(path.join(c.dir, 'accela-settings.json'), JSON.stringify({ steam_password: 'fake-password-123', legacy_field: 'keep' }));
    const settings = c.load('src/core/settingsStore.js');
    assert.equal(settings.get('steam_password'), 'fake-password-123');
    assert.equal(settings.getPublic('steam_password'), '');
    assert.equal(settings.getPublic().secrets_present.hubcap_api_key, true);
    settings.setMany({ steam_username: 'test', library_sort: 'size' });
    for (const file of fs.readdirSync(c.dir)) {
      const bytes = fs.readFileSync(path.join(c.dir, file), 'utf8');
      assert(!bytes.includes('fake-password-123') && !bytes.includes('fake-key-987'));
    }
    settings.set('steam_password', ''); assert.equal(settings.getPublic().secrets_present.steam_password, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(c.dir, 'accela-settings.json'))).legacy_field, 'keep');
  });
  await test('Unavailable OS encryption never writes a plaintext secret', () => {
    const c = context('no-encryption'); c.electron.safeStorage.isEncryptionAvailable = () => false;
    const settings = c.load('src/core/settingsStore.js');
    assert.throws(() => settings.set('steam_password', 'fake-secret'), /Secure credential/);
    assert.equal(settings.get('steam_password'), '');
    assert.equal(fs.existsSync(path.join(c.dir, 'librarian-settings.json')), false);
  });
  await test('Corrupt metadata is preserved and the last good backup is recovered', () => {
    const c = context('corrupt'); const file = path.join(c.dir, 'librarian-game-meta.json');
    fs.writeFileSync(file, '{"steam:10":{"playtime_seconds":3600');
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ 'steam:10': { playtime_seconds: 3600 } }));
    const meta = c.load('src/core/gameMetaStore.js');
    assert.equal(meta.getByKey('steam:10').playtime_seconds, 3600);
    meta.setExecutable('steam:11', 'C:\\fake.exe');
    assert(fs.readdirSync(c.dir).some(name => name.includes('.corrupt-')));
    assert.equal(JSON.parse(fs.readFileSync(file))['steam:10'].playtime_seconds, 3600);
  });
  await test('Unreadable stores are never treated as empty first runs', () => {
    const c = context('unreadable', { fs: { ...fs, readFileSync() { throw Object.assign(new Error('Access denied'), { code: 'EACCES' }); } } });
    for (const file of ['settingsStore', 'customGameStore', 'gameMetaStore']) assert.throws(() => c.load(`src/core/${file}.js`).getAll(), /Access denied/);
  });
  await test('Custom games and metadata roll back failed writes', () => {
    let fail = false;
    const c = context('rollback', { fs: { ...fs, renameSync(...args) { if (fail) throw new Error('Rename denied'); return fs.renameSync(...args); } } });
    const custom = c.load('src/core/customGameStore.js'); const game = custom.add({ game_name: 'Before' });
    const meta = c.load('src/core/gameMetaStore.js'); meta.setByKey('steam:10', { playtime_seconds: 42 });
    fail = true;
    assert.throws(() => custom.update(game.id, { game_name: 'After' }), /Rename denied/);
    assert.equal(custom.getById(game.id).game_name, 'Before');
    assert.throws(() => custom.remove(game.id), /Rename denied/); assert.equal(custom.getAll().length, 1);
    assert.throws(() => meta.addPlaytime('steam:10', 99), /Rename denied/); assert.equal(meta.getByKey('steam:10').playtime_seconds, 42);
  });
  await test('Date added is discovery time and respects manual imports', () => {
    const c = context('discovery'); const meta = c.load('src/core/gameMetaStore.js');
    const game = { appid: '10' }; const custom = { id: 'x', source: 'Custom', added_at: '2025-01-02T12:00:00Z' };
    meta.recordDiscovery([game, custom]); const first = meta.decorate(game).first_seen;
    assert(first > 0); meta.recordDiscovery([game]); meta.recordLaunch('steam:10'); assert.equal(meta.decorate(game).first_seen, first);
    assert.equal(meta.decorate(custom).first_seen, Date.parse(custom.added_at));
  });
  await test('Library scan reads N manifests for N games and returns manifest identities', () => {
    const lib = path.join(temp, 'library'); const steamapps = path.join(lib, 'steamapps');
    for (let i = 1; i <= 100; i++) {
      const dir = path.join(steamapps, 'common', `Game${i}`); fs.mkdirSync(path.join(dir, '.DepotDownloader'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'game.txt'), 'fixture');
      fs.writeFileSync(path.join(steamapps, `appmanifest_${i}.acf`), `"AppState" { "appid" "${i}" "installdir" "Game${i}" "name" "Game ${i}" "SizeOnDisk" "7" "InstalledDepots" { "${i}01" { "manifest" "900${i}" } } }`);
    }
    let reads = 0;
    const c = context('scan', { './steamHelpers': { getSteamLibraries: () => [lib] }, fs: { ...fs, readFileSync(file, ...args) { if (/\.acf$/.test(String(file))) reads++; return fs.readFileSync(file, ...args); } } });
    const games = c.load('src/core/gameManager.js').scanSteamLibraries();
    assert.equal(games.length, 100); assert.equal(reads, 100); assert.equal(games.find(g => g.appid === '42').installed_manifests['4201'], '90042');
    const decision = c.load('src/core/updateChecker.js').decideUpdate({ installedManifests: games.find(g => g.appid === '42').installed_manifests, remoteManifests: { '4201': '90042' } });
    assert.equal(decision.status, 'up_to_date');
  });
  await test('Real worker scans without blocking main and keeps games on a missing drive', async () => {
    const { Worker } = require('worker_threads');
    const library = path.join(temp, 'library');
    const c = context('worker', { worker_threads: { Worker: class extends Worker {
      constructor(file, options) { super(file, { ...options, workerData: { ...options.workerData, libraries: [library] } }); }
    } } });
    const service = c.load('src/core/libraryService.js');
    const first = service.scan(); assert.equal(first, service.scan());
    assert.equal((await first).games.length, 100);
    const source = path.resolve(library, 'steamapps/common'); const target = path.resolve(library, 'steamapps/common-unavailable');
    assert(source.startsWith(temp + path.sep) && target.startsWith(temp + path.sep)); fs.renameSync(source, target);
    const offline = await service.scan(); assert.equal(offline.games.length, 100); assert(offline.games.every(g => g.unavailable)); assert.equal(offline.warnings.length, 1);
    fs.renameSync(target, source);
    assert.equal((await service.scan()).games.filter(g => g.unavailable).length, 0);
  });
  await test('Extra locations survive a valid Steam registry result and missing drives', () => {
    const steam = path.join(temp, 'main-steam'); const extra = path.join(temp, 'extra-steam'); fs.mkdirSync(path.join(steam, 'steamapps'), { recursive: true });
    const c = context('locations', { './settingsStore': { get: key => ({ steam_path: steam, default_install_path: extra, install_locations: [steam, extra] })[key], set() {} }, child_process: { execFileSync: () => `SteamPath    REG_SZ    ${steam}` } });
    const libraries = c.load('src/core/steamHelpers.js').getSteamLibraries();
    assert(libraries.includes(extra)); assert.equal(libraries.filter(v => v === extra).length, 1);
  });
  await test('Async spawn failure never announces or records a successful launch', async () => {
    const events = []; const launches = [];
    const c = context('launch-error', { './gameMetaStore': { gameKey: () => 'steam:10', get: () => ({}), recordLaunch: key => launches.push(key) }, child_process: { spawn() { const child = new EventEmitter(); process.nextTick(() => child.emit('error', Object.assign(new Error('Access denied'), { code: 'EACCES' }))); return child; } } });
    const exe = path.join(c.dir, 'game.exe'); fs.writeFileSync(exe, 'fixture, never executed');
    const launcher = c.load('src/core/launcher.js'); launcher.setSessionChangeHandler(value => events.push(value));
    const result = await launcher.launchDirect({ appid: '10', executable: exe });
    assert.equal(result.success, false); assert.equal(result.code, 'EACCES'); assert.equal(launches.length, 0); assert.equal(events.length, 0); assert.equal(launcher.getRunning().length, 0);
  });
  await test('Download intent, active snapshot, errors and restart recovery are durable', () => {
    const c = context('queue'); const queue = c.load('src/core/downloadQueue.js');
    queue.add({ id: 123, name: 'Test', path: 'C:\\fixture.zip', destPath: 'D:\\Games', selectedDepots: ['10'] });
    queue.add({ id: 124, name: 'Next' });
    queue.begin(123, { destPath: 'D:\\Games', selectedDepots: ['10'], gameData: { appid: '10' } });
    queue.progress('percent', 35); queue.pause(true);
    const snapshot = queue.snapshot(); assert.equal(snapshot.active.paused, true); assert.equal(snapshot.active.percent, 35);
    assert.throws(() => queue.remove(123), /Cancel/);
    const disk = JSON.parse(fs.readFileSync(path.join(c.dir, 'librarian-download-queue.json')));
    assert.equal(disk[0].status, 'paused');
    const restarted = context('queue');
    const restored = restarted.load('src/core/downloadQueue.js').snapshot(); assert.equal(restored.jobs[0].status, 'interrupted'); assert.equal(restored.jobs[1].status, 'queued');
    queue.finish('failed', 'Connection lost'); assert.equal(queue.snapshot().jobs[0].error, 'Connection lost'); assert.equal(queue.snapshot().active, null);
    queue.patch(123, { status: 'queued', error: '' }); queue.begin(123, {}); queue.finish('complete'); queue.remove(123); assert.equal(queue.snapshot().jobs.length, 1);
  });
  await test('Direct sessions checkpoint only new time and report async stop failure', async () => {
    let now = Date.now(); const child = new EventEmitter(); child.pid = 424242; child.unref = () => {};
    const c = context('session', {
      Date: class extends Date { static now() { return now; } },
      './tuning': { onLaunch: () => false, onExit() {} },
      './settingsStore': { get: () => false },
      child_process: { spawn(exe) {
        if (exe.endsWith('taskkill.exe')) { const stopping = new EventEmitter(); process.nextTick(() => stopping.emit('error', new Error('Stop denied'))); return stopping; }
        process.nextTick(() => child.emit('spawn')); return child;
      } },
    });
    const exe = path.join(c.dir, 'fixture.exe'); fs.writeFileSync(exe, 'Not executable');
    const launcher = c.load('src/core/launcher.js'); const meta = c.load('src/core/gameMetaStore.js');
    const events = []; launcher.setSessionChangeHandler(event => events.push(event));
    assert.equal((await launcher.launchDirect({ appid: '10', executable: exe, install_path: c.dir })).success, true);
    assert.equal(meta.getByKey('steam:10').launch_count, 1);
    assert.equal((await launcher.stopGame('steam:10')).success, false);
    now += 18000; launcher.checkpointSessions(); assert.equal(meta.getByKey('steam:10').playtime_seconds, 18);
    now += 5000; child.emit('exit', 0); child.emit('exit', 0);
    assert.equal(meta.getByKey('steam:10').playtime_seconds, 23); assert.equal(events.filter(e => e.type === 'stopped').length, 1);
    assert.equal(events.at(-1).pid, 424242); assert.equal(events.at(-1).appid, '10');
  });
  await test('Tuning journals before changing machine settings and restores on shutdown', () => {
    const local = path.join(temp, 'tuning-fixture'); const calls = [];
    const before = '381b4222-f694-41f0-9685-ff5bb260df2e'; const high = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';
    const journal = path.join(local, 'Librarian/tuning/machine-recovery.json');
    const c = context('tuning', {
      process: { ...process, env: { ...process.env, LOCALAPPDATA: local } },
      './settingsStore': { get: () => ({ enabled: true, queue: 'auto', limiter: true, fps: 0, affinity: 'off', priority: false, refresh: true, power: true }) },
      fs: { ...fs, existsSync: file => String(file).endsWith('librarian_tune.exe') || fs.existsSync(file) },
      child_process: { execFileSync(exe, args) {
        calls.push(args.join(' '));
        if (args[0] === '/getactivescheme') return before;
        if (args[0] === '/list') return `${before}\n${high}`;
        if (args[0] === '/setactive') {
          assert.equal(JSON.parse(fs.readFileSync(journal)).powerScheme, before); return '';
        }
        if (args[1] === 'query') return JSON.stringify({ hz: 60, max_hz: 144 });
        if (args[1] === 'max') { assert.equal(JSON.parse(fs.readFileSync(journal)).refreshHz, 60); return JSON.stringify({ changed: true, from: 60, to: 144 }); }
        return '{}';
      } },
    });
    const tuning = c.load('src/core/tuning.js'); assert.equal(tuning.onLaunch({ pid: 424242, key: 'steam:10', name: 'Fixture' }), true);
    tuning.shutdown(); assert(calls.includes('display set 60')); assert(calls.includes(`/setactive ${before}`));
    assert.deepEqual(JSON.parse(fs.readFileSync(journal)), {});
    assert.equal(fs.readFileSync(path.join(local, 'Librarian/tuning/424242.cfg')).readUInt32LE(12), 0);
  });
  await test('Tuning clears stale FPS, resumes with new samples and applies Off to a running session', () => {
    let now = 10000, tick;
    let profile = { enabled: true, queue: 'auto', limiter: true, fps: 97, affinity: 'off', priority: false, refresh: false, power: false };
    const local = path.join(temp, 'tuning-live');
    const c = context('tuning-live', {
      process: { ...process, platform: 'win32', env: { ...process.env, LOCALAPPDATA: local } },
      Date: class extends Date { static now() { return now; } },
      setInterval: callback => { tick = callback; return { unref() {} }; },
      './settingsStore': { get: () => ({ ...profile }), set: (_key, value) => { profile = value; } },
      child_process: { execFileSync: () => '{}' },
    });
    const tuning = c.load('src/core/tuning.js');
    const pid = 456789, key = 'steam:2584270'; let latest;
    tuning.subscribe((_type, session) => { latest = session; });
    assert.equal(tuning.onLaunch({ pid, key, name: 'Mortal Shell II fixture' }), true);
    const stats = Buffer.alloc(tuning.STATS_HEADER + tuning.RING * tuning.FRAME_BYTES);
    stats.writeUInt32LE(tuning.STATS_MAGIC, 0); stats.writeUInt32LE(tuning.VERSION, 4); stats.writeUInt32LE(12, 8);
    const sample = (count, ms) => {
      stats.writeUInt32LE(count, 16);
      for (let n = 0; n < count; n++) stats.writeFloatLE(ms, tuning.STATS_HEADER + n * tuning.FRAME_BYTES);
      fs.writeFileSync(tuning.statsPath(pid), stats); tick();
    };
    sample(240, 1000 / 60); assert.equal(Math.round(latest.summary.fps), 60); assert.equal(latest.stale, false);
    now += 2100; tick(); assert.equal(latest.stale, true); assert.equal(latest.lastFrameAt, 10000);
    now += 500; sample(300, 10); assert.equal(latest.stale, false); assert.equal(Math.round(latest.summary.fps), 100);
    now += 2100; sample(60, 1000 / 90); assert.equal(latest.header.frames, 60); assert.equal(latest.stale, false); assert.equal(Math.round(latest.summary.fps), 90);
    const flags = () => fs.readFileSync(tuning.configPath(pid)).readUInt32LE(12);
    assert.equal(flags(), 9);
    tuning.setProfile({ enabled: false }); assert.equal(flags(), 0);
    tuning.setOverride(key, 'on'); assert.equal(flags(), 9);
    tuning.setOverride(key, 'off'); assert.equal(flags(), 0);
    tuning.setProfile({ enabled: true }); assert.equal(flags(), 0);
    tuning.setOverride(key, 'inherit'); assert.equal(flags(), 9);
    tuning.shutdown();
  });
  await test('IPC boundary, singleton, CSP and packaging guardrails are present', () => {
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8'); const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
    assert(main.includes('requestSingleInstanceLock()')); assert(main.includes('event.senderFrame === mainWindow.webContents.mainFrame'));
    assert(html.includes("script-src 'self';"));
    for (const f of ['src/index.html', 'src/js/app.js', 'src/js/enhance.js', 'src/js/bigpicture.js']) assert(!/\bon(?:error|load|click)="/.test(fs.readFileSync(path.join(root, f), 'utf8')));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))); assert(!pkg.dependencies['electron-store']); assert(pkg.build.extraResources[0].filter.includes('!**/*.prev/**/*'));
  });
  await test('A failed news source keeps its last items with an explicit stale flag', () => {
    const c = context('news'); const news = c.load('src/core/newsFeed.js');
    const cached = { items: [{ id: 'test:1' }], cachedAt: 123 };
    const result = news.retainFeed({ ok: false, items: [], error: 'Timed out' }, cached);
    assert.equal(result.items[0].id, 'test:1'); assert.equal(result.stale, true); assert.equal(result.error, 'Timed out');
    assert.equal(news.retainFeed({ ok: true, items: [] }, cached).items.length, 0);
  });
  const report = process.env.LIBRARIAN_TEST_OUTPUT || path.join(root, 'audits/2026-09-07/fixes'); fs.mkdirSync(report, { recursive: true });
  fs.writeFileSync(path.join(report, 'reliability-results.json'), JSON.stringify({ at: new Date().toISOString(), fixtures: temp, results }, null, 2));
  console.log(`${results.filter(r => r.ok).length}/${results.length} passed. Temporary fixtures: ${temp}`);
  process.exitCode = results.some(r => !r.ok) ? 1 : 0;
})();
