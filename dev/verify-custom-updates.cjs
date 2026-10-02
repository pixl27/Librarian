// Behavior on temporary installs. No remote downloads or real game processes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-custom-update-'));
const results = [];
const plain = value => JSON.parse(JSON.stringify(value));
const realChecker = require('../src/core/updateChecker');
function context(name, overrides = {}) {
  const profile = path.join(temp, name); fs.mkdirSync(profile, { recursive: true });
  const cache = new Map();
  let remote = { remoteBuildId: '200', remoteManifests: { '4201': '9002' }, gameName: 'Fixture game', branch: 'public' };
  const checker = { ...realChecker, fetchRemote: async () => remote };
  function load(file) {
    file = path.resolve(root, file);
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} }; cache.set(file, mod);
    const nativeRequire = Module.createRequire(file);
    const localRequire = id => {
      if (Object.hasOwn(overrides, id)) return overrides[id];
      if (id === 'electron') return { app: { getPath: () => profile } };
      if (id === './updateChecker') return checker;
      if (id.startsWith('.')) { const resolved = nativeRequire.resolve(id); if (resolved.startsWith(path.join(root, 'src/core'))) return load(resolved); }
      return nativeRequire(id);
    };
    const run = vm.runInNewContext(`(function(require,module,exports,__filename,__dirname){${fs.readFileSync(file, 'utf8')}\n})`, { process, Buffer, console, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval }, { filename: file });
    run(localRequire, mod, mod.exports, file, path.dirname(file));
    return mod.exports;
  }
  return { profile, load, checker, remote: value => { remote = value; } };
}
function add(c, folder = 'Game', appid = '42') {
  const dir = path.join(c.profile, folder); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'game.txt'), 'existing fixture');
  const store = c.load('src/core/customGameStore.js');
  return store.add({ game_name: 'My game', install_path: dir, executable: path.join(dir, 'game.txt'), appid });
}
function acf(file, { appid = '42', folder = 'Game', build = '100', manifest = '9001', branch = '' } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `"AppState" { "appid" "${appid}" "installdir" "${folder}" "buildid" "${build}" "SizeOnDisk" "42" "InstalledDepots" { "4201" { "manifest" "${manifest}" } } ${branch ? `"UserConfig" { "BetaKey" "${branch}" }` : ''} }`);
}
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.error(`FAIL ${name}\n${error.stack}`); }
}
(async () => {
  await test('Linking preserves identity and files; unknown local build never becomes remote build', async () => {
    const c = context('unknown'); const game = add(c); const service = c.load('src/core/customGameUpdates.js');
    const before = fs.readdirSync(game.install_path);
    const found = await service.inspect(game.id);
    assert.equal(found.local.buildId, null); assert.equal(found.remote.remoteBuildId, '200'); assert.equal(found.comparison.status, 'unknown');
    const linked = service.associate(game.id, { appid: '42', expectedInstallPath: game.install_path });
    assert.equal(linked.id, game.id); assert.equal(linked.source, 'Custom'); assert.equal(linked.executable, game.executable); assert.equal(linked.buildid, null);
    assert.deepEqual(fs.readdirSync(game.install_path), before);
    assert.equal(context('unknown').load('src/core/customGameStore.js').getById(game.id).update_link.revision, linked.update_link.revision);
  });
  await test('ACF build and depots are read from an existing Steam layout', async () => {
    const c = context('steam'); const game = add(c, 'Library/steamapps/common/Game');
    const file = path.join(c.profile, 'Library/steamapps/appmanifest_42.acf'); acf(file);
    const service = c.load('src/core/customGameUpdates.js'); const found = await service.inspect(game.id);
    assert.equal(found.local.buildId, '100'); assert.equal(found.local.source, 'manifest'); assert.equal(found.local.installedManifests['4201'], '9001');
    assert.equal(found.comparison.status, 'update_available'); assert.equal(found.local.evidencePath, file);
    service.associate(game.id, { appid: '42' }); acf(file, { build: '200', manifest: '9002' });
    assert.equal(service.decorate(c.load('src/core/customGameStore.js').getById(game.id)).buildid, '200');
  });
  await test('Imported manifests reject another game, folder or branch', () => {
    const c = context('invalid-manifests'); const game = add(c); const service = c.load('src/core/customGameUpdates.js');
    const file = path.join(c.profile, 'import.acf');
    for (const [options, reason] of [[{ appid: '99' }, /different AppID/], [{ folder: 'Elsewhere' }, /does not match/], [{ branch: 'beta' }, /Only the public branch/]]) {
      acf(file, options); assert.throws(() => service.associate(game.id, { appid: '42', manifestPath: file }), reason);
    }
    acf(file); const linked = service.associate(game.id, { appid: '42', manifestPath: file }); assert.equal(linked.buildid, '100');
    assert(!fs.existsSync(path.join(game.install_path, '.DepotDownloader')));
  });
  await test('A conflicting app manifest prevents associating the wrong AppID', async () => {
    const c = context('wrong-appid'); const game = add(c, 'Library/steamapps/common/Game');
    acf(path.join(c.profile, 'Library/steamapps/appmanifest_99.acf'), { appid: '99' });
    const service = c.load('src/core/customGameUpdates.js');
    await assert.rejects(service.inspect(game.id, { appid: '42' }), /already has an app manifest for AppID 99/);
    assert.throws(() => service.associate(game.id, { appid: '42' }), /AppID 99/);
    assert.equal(service.associate(game.id, { appid: '99' }).appid, '99');
  });
  await test('Manual build is explicitly declared, numeric and subordinate to local records', () => {
    const c = context('declared'); const game = add(c); const service = c.load('src/core/customGameUpdates.js');
    assert.throws(() => service.associate(game.id, { appid: '42', declaredBuild: '1.2.3' }), /numeric Steam build/);
    const linked = service.associate(game.id, { appid: '42', declaredBuild: '99' }); assert.equal(linked.buildid, '99'); assert.equal(linked.build_source, 'declared');
    acf(service.layout(game.install_path, '42').manifestPath, { build: '200', manifest: '9002' });
    const refreshed = service.decorate(linked); assert.equal(refreshed.buildid, '200'); assert.equal(refreshed.build_source, 'manifest');
  });
  await test('Editing identity invalidates a link; display edits preserve it', () => {
    const c = context('editing'); const game = add(c); const service = c.load('src/core/customGameUpdates.js'), store = c.load('src/core/customGameStore.js');
    const linked = service.associate(game.id, { appid: '42' });
    assert.equal(store.update(game.id, { game_name: 'New title' }).update_link.revision, linked.update_link.revision);
    assert.equal(store.update(game.id, { appid: '99' }).update_link, undefined);
    service.associate(game.id, { appid: '99' }); assert.equal(store.update(game.id, { install_path: game.install_path + '-changed' }).update_link, undefined);
  });
  await test('Build verification refuses stale/wrong depots and resolves the exact existing folder', async () => {
    const c = context('prepare'); const game = add(c); const service = c.load('src/core/customGameUpdates.js'); const linked = service.associate(game.id, { appid: '42' });
    const valid = { appid: '42', manifests: { '4201': '9002' }, buildid: 'invented-by-client', installdir: 'WrongFolder' };
    const prepare = data => service.prepareDownload(game.id, linked.update_link.revision, '200', data, ['4201']);
    await assert.rejects(prepare({ ...valid, appid: '99' }), /different game/);
    await assert.rejects(prepare({ ...valid, manifests: { '4201': '9001' } }), /does not match public build/);
    const prepared = await prepare(valid); assert.equal(prepared.target.installPath, game.install_path); assert.equal(prepared.gameData.buildid, '200'); assert.equal(prepared.gameData.installdir, 'Game'); assert.equal(prepared.target.validateAll, true);
    assert.equal(prepared.gameData.skip_auto_crack, true); assert(!fs.existsSync(path.join(game.install_path, '.DepotDownloader')));
    c.remote({ remoteBuildId: '300', remoteManifests: { '4201': '9003' } }); await assert.rejects(prepare(valid), /public build changed/);
    c.remote({ error: 'Source offline' }); await assert.rejects(prepare(valid), /Source offline/);
  });
  await test('A newer local build cannot silently be downgraded to public', async () => {
    const c = context('newer-build'); const game = add(c); const service = c.load('src/core/customGameUpdates.js');
    const linked = service.associate(game.id, { appid: '42', declaredBuild: '300' });
    await assert.rejects(service.prepareDownload(game.id, linked.update_link.revision, '200', { appid: '42', manifests: { '4201': '9002' } }, ['4201']), /newer than public/);
  });
  await test('A changed association during remote lookup cannot redirect a prepared job', async () => {
    const c = context('race'); const game = add(c); const service = c.load('src/core/customGameUpdates.js'); const linked = service.associate(game.id, { appid: '42' });
    c.checker.fetchRemote = async () => { service.disconnect(game.id); return { remoteBuildId: '200', remoteManifests: { '4201': '9002' } }; };
    await assert.rejects(service.prepareDownload(game.id, linked.update_link.revision, '200', { appid: '42', manifests: { '4201': '9002' } }, ['4201']), /association changed/);
  });
  await test('Metadata junctions and protected root folders are refused', async () => {
    const c = context('junction'); const game = add(c); const service = c.load('src/core/customGameUpdates.js'); const linked = service.associate(game.id, { appid: '42' });
    const other = path.join(c.profile, 'Other'); fs.mkdirSync(other);
    const marker = path.join(game.install_path, '.DepotDownloader');
    assert(path.resolve(marker).startsWith(temp + path.sep) && path.resolve(other).startsWith(temp + path.sep));
    fs.symlinkSync(other, marker, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(service.prepareDownload(game.id, linked.update_link.revision, '200', { appid: '42', manifests: { '4201': '9002' } }, ['4201']), /symbolic link/);
    const rootGame = c.load('src/core/customGameStore.js').add({ game_name: 'Root', appid: '42', install_path: path.parse(temp).root });
    assert.throws(() => service.associate(rootGame.id, { appid: '42' }), /individual game folder/);
  });
  await test('Linked Custom entry wins duplicate scans without losing its playtime key', () => {
    const c = context('merge'); const game = add(c); const service = c.load('src/core/customGameUpdates.js'); service.associate(game.id, { appid: '42' });
    const meta = c.load('src/core/gameMetaStore.js'); meta.setByKey(`custom:${game.id}`, { playtime_seconds: 3600 });
    fs.writeFileSync(path.join(c.profile, 'librarian-library-cache.json'), JSON.stringify({ games: [{ appid: '42', source: 'Librarian', install_path: game.install_path }], warnings: [] }));
    const games = c.load('src/core/libraryService.js').cached().games; assert.equal(games.length, 1); assert.equal(games[0].id, game.id); assert.equal(games[0].playtime_seconds, 3600);
  });
  await test('Two installations of one AppID keep separate update decisions', async () => {
    const c = context('decisions', { 'node-fetch': async () => ({ ok: true, json: async () => ({ status: 'success', data: { '42': { depots: { branches: { public: { buildid: '200' } } } } } }) }) });
    const checker = c.load('src/core/updateChecker.js');
    const found = await checker.checkAllUpdates([{ appid: '42', buildid: '200' }, { appid: '42', buildid: '100', result_key: 'custom:fixture' }]);
    assert.equal(found['42'].status, 'up_to_date'); assert.equal(found['custom:fixture'].status, 'update_available');
  });
  const output = process.env.LIBRARIAN_TEST_OUTPUT || path.join(root, 'audits/2026-09-07/custom-updates'); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'custom-update-results.json'), JSON.stringify({ at: new Date().toISOString(), fixtures: temp, results }, null, 2));
  console.log(`${results.filter(result => result.ok).length}/${results.length} passed`);
  process.exitCode = results.some(result => !result.ok) ? 1 : 0;
})();
