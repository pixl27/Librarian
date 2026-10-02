// Co-op presets (src/core/gamePresets.js) against copies of real installs.
//
// Each fixture is put in the state a friend's install is in right after a
// download: the game's own executable and managed assemblies, Goldberg in the
// steam_api slot and Valve's library beside it as .bak, which is what
// auto-crack leaves. Nothing here touches the source folders.
//
// Usage: node dev/verify-game-presets.cjs [<Valheim dir> <PEAK dir>]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const common = 'E:\\Games\\steam\\steamapps\\common';
const VALHEIM = process.argv[2] || path.join(common, 'Valheim');
const PEAK = process.argv[3] || path.join(common, 'PEAK');
const presets = require('../src/core/gamePresets');
const onlineMode = require('../src/core/onlineMode');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-presets-'));
const passed = [];
function test(name, run) { run(); passed.push(name); console.log('PASS ' + name); }
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
const read = (file) => fs.readFileSync(file, 'utf8');
const receipt = (dir) => JSON.parse(read(path.join(dir, '.DepotDownloader', presets.RECEIPT)));

/** A just-downloaded, auto-cracked install of `source` under `name`. */
function fixture(name, source, exeName, dataDir, { managed = [], extraPlugins = [] } = {}) {
  const game = path.join(temp, name);
  copy(path.join(source, exeName), path.join(game, exeName));
  const plugins = path.join(dataDir, 'Plugins', 'x86_64');
  const sourcePlugins = path.join(source, plugins);
  copy(path.join(sourcePlugins, 'steam_api64.dll.goldberg'), path.join(game, plugins, 'steam_api64.dll'));
  copy(path.join(sourcePlugins, 'steam_api64.dll.bak'), path.join(game, plugins, 'steam_api64.dll.bak'));
  for (const file of extraPlugins) copy(path.join(sourcePlugins, file), path.join(game, plugins, file));
  const managedDir = path.join(source, dataDir, 'Managed');
  const names = managed === '*' ? fs.readdirSync(managedDir).filter(f => f.endsWith('.dll')) : managed;
  for (const file of names) copy(path.join(managedDir, file), path.join(game, dataDir, 'Managed', file));
  return { appid: name.startsWith('peak') ? '3527290' : '892970', game_name: name, install_path: game, exe: path.join(game, exeName) };
}
const valheim = (name) => fixture(name, VALHEIM, 'valheim.exe', 'valheim_Data',
  { managed: ['assembly_valheim.dll', 'PlayFab.dll', 'com.rlabrecque.steamworks.net.dll'] });
const peak = (name) => fixture(name, PEAK, 'PEAK.exe', 'PEAK_Data',
  { managed: '*', extraPlugins: ['EOSSDK-Win64-Shipping.dll'] });

test('The shipped catalog lists Valheim and PEAK with their steps', () => {
  const byId = Object.fromEntries(presets.list().map(p => [p.appid, p.steps]));
  assert.deepEqual(byId['892970'], ['online']);
  assert.deepEqual(byId['3527290'], ['online', 'peakMod']);
  assert.equal(presets.presetFor('570'), null);
});

const v = valheim('valheim-fresh');
test('Valheim: a fresh install is pending, then gets online mode and its adapter', () => {
  assert.equal(presets.pending(v), true);
  assert.equal(presets.stateOf(v), 'pending');
  const r = presets.apply(v, { exe: v.exe });
  assert.equal(presets.stateOf(v), 'ready');
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.applied, true);
  assert.deepEqual(r.steps, ['online']);
  assert.equal(onlineMode.getStatus(v.install_path, v.exe).mode, 'online');
  assert.equal(read(path.join(v.install_path, 'steam_appid.txt')).trim(), '480');
  assert.ok(fs.existsSync(path.join(v.install_path, 'BepInEx/plugins/Librarian.ValheimOnline/Librarian.ValheimOnline.dll')));
  assert.ok(fs.existsSync(path.join(v.install_path, 'winhttp.dll')));
  // Valve's library is live again (behind our proxy) and Goldberg is kept aside.
  assert.ok(fs.existsSync(path.join(v.install_path, 'valheim_Data/Plugins/x86_64/steam_api64.dll.goldberg')));
  assert.deepEqual(receipt(v.install_path).steps, ['online']);
  assert.equal(presets.pending(v), false);
});

test('Valheim: applying again does nothing', () => {
  assert.equal(presets.apply(v, { exe: v.exe }).skipped, 'done');
});

test('Valheim: online mode turned off by the player stays off', () => {
  assert.equal(onlineMode.disableOnline(v.install_path, v.exe).success, true);
  assert.equal(presets.pending(v), false);
  assert.equal(presets.stateOf(v), 'off');
  assert.equal(presets.apply(v, { exe: v.exe }).skipped, 'done');
  assert.equal(onlineMode.getStatus(v.install_path, v.exe).mode, 'offline');
});

const p = peak('peak-fresh');
test('PEAK: a fresh install gets online mode and the join-a-friend plugin', () => {
  const r = presets.apply(p, { exe: p.exe });
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.steps, ['online', 'peakMod']);
  assert.equal(onlineMode.getStatus(p.install_path, p.exe).mode, 'online');
  assert.ok(fs.existsSync(path.join(p.install_path, 'BepInEx/plugins/PeakJoinFriend.dll')));
  assert.ok(fs.existsSync(path.join(p.install_path, 'BepInEx/core/BepInEx.dll')));
  assert.ok(fs.existsSync(path.join(p.install_path, 'winhttp.dll')));
  assert.deepEqual(receipt(p.install_path).steps, ['online', 'peakMod']);
});

test('An earlier online-mode choice is respected and only a receipt is written', () => {
  const g = peak('peak-chosen');
  const marker = path.join(g.install_path, '.DepotDownloader');
  fs.mkdirSync(marker, { recursive: true });
  fs.writeFileSync(path.join(marker, 'online-mode.json'), JSON.stringify({ mode: 'offline', restored: [], at: 1 }));
  const before = fs.readFileSync(path.join(g.install_path, 'PEAK_Data/Plugins/x86_64/steam_api64.dll'));
  assert.equal(presets.stateOf(g), 'off', 'a recorded choice is not shown as waiting');
  const r = presets.apply(g, { exe: g.exe });
  assert.equal(r.skipped, 'existing-choice');
  assert.equal(receipt(g.install_path).respected, true);
  assert.ok(fs.readFileSync(path.join(g.install_path, 'PEAK_Data/Plugins/x86_64/steam_api64.dll')).equals(before));
  assert.equal(fs.existsSync(path.join(g.install_path, 'BepInEx')), false);
  assert.equal(fs.existsSync(path.join(g.install_path, 'steam_appid.txt')), false);
  assert.equal(presets.pending(g), false);
});

test('A failed step is retried later without redoing the ones that worked', () => {
  const g = peak('peak-partial');
  // A file where the plugins folder belongs makes the plugin copy fail.
  fs.mkdirSync(path.join(g.install_path, 'BepInEx'), { recursive: true });
  fs.writeFileSync(path.join(g.install_path, 'BepInEx', 'plugins'), 'not a folder');
  const first = presets.apply(g, { exe: g.exe });
  assert.ok(first.error, 'the plugin step should have failed');
  assert.deepEqual(first.steps, ['online']);
  assert.deepEqual(receipt(g.install_path).steps, ['online']);
  assert.equal(presets.pending(g), true);
  assert.equal(presets.stateOf(g), 'pending');
  fs.unlinkSync(path.join(g.install_path, 'BepInEx', 'plugins'));
  const second = presets.apply(g, { exe: g.exe });
  assert.equal(second.error, undefined, second.error);
  assert.deepEqual(second.steps, ['peakMod']);
  assert.deepEqual(receipt(g.install_path).steps, ['online', 'peakMod']);
  assert.ok(fs.existsSync(path.join(g.install_path, 'BepInEx/plugins/PeakJoinFriend.dll')));
});

test('A step added to a preset in a later release reaches installs that had the others', () => {
  const entry = presets.presetFor('3527290');
  entry.steps.push('photonMod');
  try {
    assert.equal(presets.pending(p), true);
    const r = presets.apply(p, { exe: p.exe });
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(r.steps, ['photonMod']);
    assert.ok(fs.existsSync(path.join(p.install_path, 'BepInEx/plugins/PhotonJoin/PhotonJoin.dll')));
    assert.deepEqual(receipt(p.install_path).steps, ['online', 'peakMod', 'photonMod']);
  } finally { entry.steps.pop(); }
});

test('Games without a preset and missing folders are left alone', () => {
  assert.equal(presets.apply({ appid: '570', install_path: temp }).skipped, 'no-preset');
  assert.equal(presets.apply({ appid: '892970', install_path: path.join(temp, 'missing') }).skipped, 'no-preset');
  assert.equal(presets.pending({ appid: '892970', install_path: path.join(temp, 'missing') }), false);
});

fs.rmSync(temp, { recursive: true, force: true });
console.log(JSON.stringify({ passed: passed.length }));
