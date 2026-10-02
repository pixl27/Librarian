const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const source = process.argv[2];
if (!source) throw new Error('Usage: verify-valheim-online.cjs <Valheim Managed directory>');
const manager = require('../src/core/valheimOnline');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-valheim-online-'));
const passed = [];
function test(name, run) { run(); passed.push(name); console.log('PASS ' + name); }
function fixture(name) {
  const game = path.join(temp, name), managed = path.join(game, 'valheim_Data/Managed');
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(game, 'valheim.exe'), 'Fixture executable; never run');
  for (const name of ['assembly_valheim.dll', 'PlayFab.dll', 'com.rlabrecque.steamworks.net.dll']) fs.copyFileSync(path.join(source, name), path.join(managed, name));
  return game;
}
const game = fixture('update');
test('Current Valheim metadata is compatible without loading game assemblies', () => assert.equal(manager.inspect(game).ok, true));
test('Install and repeated repair are deterministic', () => {
  assert.equal(manager.ensure(game).success, true);
  assert.equal(manager.ensure(game).repaired, 0);
  const state = manager.status(game);
  assert.equal(state.installed, true); assert.equal(state.incomplete, false); assert.equal(state.stale, false);
});
test('A changed game build with compatible signatures is accepted', () => {
  const before = manager.inspect(game).signature;
  fs.appendFileSync(path.join(game, 'valheim_Data/Managed/assembly_valheim.dll'), Buffer.from('new build metadata overlay'));
  const after = manager.inspect(game);
  assert.equal(after.ok, true); assert.notEqual(after.signature, before);
});
test('Deleted loader and plugin are repaired; unrelated mods are preserved', () => {
  const mod = path.join(game, 'BepInEx/plugins/UserMod.txt'); fs.writeFileSync(mod, 'Keep this user mod');
  fs.unlinkSync(path.join(game, manager.PLUGIN)); fs.unlinkSync(path.join(game, 'winhttp.dll'));
  assert.equal(manager.status(game).incomplete, true);
  const repair = manager.ensure(game); assert.equal(repair.success, true); assert.equal(repair.repaired, 2);
  assert.equal(manager.status(game).incomplete, false);
  assert.equal(fs.readFileSync(mod, 'utf8'), 'Keep this user mod');
});
test('Disabling removes only the owned plugin and supports re-enabling', () => {
  assert.equal(manager.disable(game).success, true);
  assert.equal(fs.existsSync(path.join(game, manager.PLUGIN)), false);
  assert.equal(fs.existsSync(path.join(game, 'BepInEx/plugins/UserMod.txt')), true);
  assert.equal(fs.existsSync(path.join(game, 'winhttp.dll')), true);
  assert.equal(manager.ensure(game).success, true);
  assert.equal(manager.status(game).incomplete, false);
});
test('Externally edited plugin is preserved and reported', () => {
  const plugin = path.join(game, manager.PLUGIN); fs.appendFileSync(plugin, Buffer.from('user change'));
  const before = fs.readFileSync(plugin);
  assert.equal(manager.ensure(game).success, false);
  assert.equal(manager.disable(game).success, false);
  assert.ok(fs.readFileSync(plugin).equals(before));
});
test('Incompatible game signatures fail before any loader is installed', () => {
  const changed = fixture('incompatible');
  const dll = path.join(changed, 'valheim_Data/Managed/assembly_valheim.dll');
  const bytes = fs.readFileSync(dll), at = bytes.indexOf(Buffer.from('LoadAPPID\0'));
  assert.ok(at >= 0); bytes.write('XoadAPPID', at, 'ascii'); fs.writeFileSync(dll, bytes);
  const state = manager.inspect(changed); assert.equal(state.ok, false); assert.match(state.error, /LoadAPPID/);
  assert.equal(manager.ensure(changed).success, false);
  assert.equal(fs.existsSync(path.join(changed, 'BepInEx')), false);
});
test('An existing foreign winhttp proxy is not overwritten', () => {
  const conflict = fixture('conflict'); fs.writeFileSync(path.join(conflict, 'winhttp.dll'), 'User proxy');
  assert.equal(manager.ensure(conflict).success, false);
  assert.equal(fs.readFileSync(path.join(conflict, 'winhttp.dll'), 'utf8'), 'User proxy');
  assert.equal(fs.existsSync(path.join(conflict, 'BepInEx')), false);
});
test('A disabled loader is rejected before the online configuration changes', () => {
  const disabled = fixture('disabled-loader');
  fs.writeFileSync(path.join(disabled, 'doorstop_config.ini'), '[General]\nenabled=false\ntarget_assembly=BepInEx\\core\\BepInEx.Preloader.dll\n');
  assert.equal(manager.inspect(disabled).ok, false);
  assert.equal(manager.ensure(disabled).success, false);
  assert.equal(fs.existsSync(path.join(disabled, manager.PLUGIN)), false);
});
test('An engine change cannot silently fall back to the unpatched generic mode', () => {
  const changed = fixture('engine-change');
  fs.unlinkSync(path.join(changed, 'valheim_Data/Managed/assembly_valheim.dll'));
  assert.equal(manager.applicable(changed), true);
  assert.equal(manager.inspect(changed).ok, false);
  assert.equal(manager.ensure(changed).success, false);
  assert.equal(fs.existsSync(path.join(changed, 'BepInEx')), false);
});
const output = path.resolve(process.env.LIBRARIAN_TEST_OUTPUT || path.join(root, 'audits/2026-09-14/valheim-startup'));
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'update-resilience-tests.json'), JSON.stringify({ passed, fixtures: temp }, null, 2));
console.log(`${passed.length}/${passed.length} passed`);
