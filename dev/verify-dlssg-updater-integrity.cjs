// Focused update-boundary regression tests. All files are temporary inert game
// fixtures; no payload is executed and no live library or network is accessed.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const vm = require('vm');
const assert = require('assert/strict');
const crypto = require('crypto');
const { createManager } = require('../src/core/dlssg');
const { createBatch } = require('../src/core/dlssgBatch');
const upstream = require('../src/core/dlssgUpstream');
const json = require('../src/core/jsonFile');
const { executable } = require('./dlssg-fixture.cjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-dlssg-integrity-'));
const output = path.resolve(__dirname, '../audits/2026-09-11/dlssg-updater');
const oldCommit = 'a'.repeat(40), nextCommit = 'b'.repeat(40);
const results = [];
let sequence = 0;
const clone = value => JSON.parse(JSON.stringify(value));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const directory = path.join(base, String(++sequence));
  const root = path.join(directory, 'Game'), exe = path.join(root, 'Binaries/Win64/Game.exe');
  executable(exe);
  const target = path.dirname(exe);
  fs.writeFileSync(path.join(target, 'nvngx_dlssg.dll'), 'Native game file: preserve exactly.');
  const payload = version => ({
    'version.dll': Buffer.from(`Inert owned proxy ${version}. This file is never loaded.`),
    'dlssg_sm86.ini': Buffer.from(`[General]\nFixtureVersion=${version}\n`),
    'README.en.md': Buffer.from(`# DLSSG Native ${version}\nFixture instructions.`),
    'THIRD_PARTY_NOTICES.txt': Buffer.from('Fixture notice. No distributed binary.'),
  });
  const old = payload('0.1.0'), next = payload('0.2.4');
  const manifest = (commit, bytes, pinned) => ({ repository: upstream.REPOSITORY, commit, runtime: '310.1',
    files: Object.entries(bytes).map(([name, data]) => ({ name, size: data.length, blobSha1: upstream.blobSha1(data),
      ...(pinned ? { sha256: sha256(data) } : {}), deploy: ['version.dll', 'dlssg_sm86.ini'].includes(name) })) });
  const release = manifest(oldCommit, old, true), candidate = manifest(nextCommit, next, false);
  const fetches = [];
  const dataPath = path.join(directory, 'Profile');
  const options = { dataPath, release, hardware: async () => ({ supported: true, name: 'Fixture RTX 3060 Ti' }),
    ensureIdle: async () => {}, upstream: { check: async () => clone(candidate), isNewer: async (a, b) => a === oldCommit && b === nextCommit },
    fetch: async url => {
      fetches.push(url);
      const parsed = new URL(url), name = parsed.pathname.split('/').at(-1);
      const current = url.includes(oldCommit) ? old : next;
      assert(current[name], `Unexpected fixture request: ${url}`);
      return { ok: true, status: 200, buffer: async () => current[name] };
    } };
  const manager = createManager(options);
  const game = { source: 'Custom', id: `fixture-${sequence}`, game_name: 'Integrity fixture', install_path: root };
  const receiptPath = path.join(dataPath, 'installs', `${sha256(root.toLowerCase())}.json`);
  return { root, target, exe, game, dataPath, options, manager, old, next, fetches, receiptPath };
}
async function test(name, run) {
  try { await run(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.error(`FAIL ${name}: ${error.message}`); }
}

(async () => {
  await test('a manual check preserves payloads and does not opt into a new default', async () => {
    const f = fixture(); await f.manager.setEnabled(f.game, true);
    const before = fs.readFileSync(f.receiptPath); f.fetches.length = 0;
    const plan = await f.manager.checkUpdates([f.game]);
    assert.equal(plan.games[0].state, 'available'); assert.equal(f.fetches.length, 0);
    assert(fs.readFileSync(f.receiptPath).equals(before));
    assert(fs.readFileSync(path.join(f.target, 'version.dll')).equals(f.old['version.dll']));
    assert(!fs.existsSync(path.join(f.dataPath, 'active-release.json')));
  });
  await test('successful replacement backs up originals and survives restart/removal', async () => {
    const f = fixture(); await f.manager.setEnabled(f.game, true); await f.manager.checkUpdates([f.game]);
    const result = await f.manager.updateGame(f.game, nextCommit);
    assert.equal(result.state, 'updated');
    for (const name of ['version.dll', 'dlssg_sm86.ini']) {
      assert(fs.readFileSync(path.join(f.target, name)).equals(f.next[name]));
      assert(fs.readFileSync(path.join(result.backup, name)).equals(f.old[name]));
    }
    assert.equal(fs.readFileSync(path.join(f.target, 'nvngx_dlssg.dll'), 'utf8'), 'Native game file: preserve exactly.');
    const restarted = createManager(f.options);
    assert.equal((await restarted.status(f.game)).commit, nextCommit);
    await restarted.checkLaunch(f.game); await restarted.setEnabled(f.game, false);
    assert(!fs.existsSync(path.join(f.target, 'version.dll')));
  });
  await test('a second copy of the candidate proxy blocks upgrade before replacing the old installation', async () => {
    const f = fixture(); await f.manager.setEnabled(f.game, true);
    fs.writeFileSync(path.join(f.target, 'winmm.dll'), f.next['version.dll']);
    const originalReceipt = fs.readFileSync(f.receiptPath);
    await f.manager.checkUpdates([f.game]);
    await assert.rejects(f.manager.updateGame(f.game, nextCommit), /copy|duplicate|entry point|proxy/i);
    assert(fs.readFileSync(path.join(f.target, 'version.dll')).equals(f.old['version.dll']));
    assert(fs.readFileSync(path.join(f.target, 'winmm.dll')).equals(f.next['version.dll']));
    assert(fs.readFileSync(f.receiptPath).equals(originalReceipt));
  });
  await test('mutation after publication cannot be reported as a successful verified update', async () => {
    const f = fixture(); await f.manager.setEnabled(f.game, true); await f.manager.checkUpdates([f.game]);
    const originalLink = fsp.link;
    let tampered = false;
    fsp.link = async (source, target) => {
      const result = await originalLink(source, target);
      if (!tampered && target === path.join(f.target, 'version.dll')) {
        tampered = true; fs.writeFileSync(target, 'Changed by another program after publication.');
      }
      return result;
    };
    try { await assert.rejects(f.manager.updateGame(f.game, nextCommit), /incomplete|recover|verif|changed/i); }
    finally { fsp.link = originalLink; }
    assert(tampered);
    assert.equal(fs.readFileSync(path.join(f.target, 'version.dll'), 'utf8'), 'Changed by another program after publication.');
    assert.equal((await f.manager.status(f.game)).enabled, false);
    await assert.rejects(f.manager.checkLaunch(f.game), /changed|incomplete/);
  });
  await test('failure to commit the final receipt restores the exact prior pair', async () => {
    const f = fixture(); await f.manager.setEnabled(f.game, true); await f.manager.checkUpdates([f.game]);
    const write = json.write;
    json.write = (file, record, ...args) => {
      if (file === f.receiptPath && record.commit === nextCommit && !record.update) throw new Error('Simulated receipt commit failure');
      return write(file, record, ...args);
    };
    try { await assert.rejects(f.manager.updateGame(f.game, nextCommit), /previous.*restored/i); }
    finally { json.write = write; }
    assert.equal(JSON.parse(fs.readFileSync(f.receiptPath)).commit, oldCommit);
    for (const name of ['version.dll', 'dlssg_sm86.ini']) assert(fs.readFileSync(path.join(f.target, name)).equals(f.old[name]));
    await f.manager.checkLaunch(f.game);
  });
  await test('main-process application rejects a game moved since its checked plan', async () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
    const start = source.indexOf('let dlssgBatch;');
    const end = source.indexOf("ipcMain.handle('dlssg:updates-state'", start);
    assert(start >= 0 && end > start, 'Could not locate the production batch factory');
    const original = { id: 'stable-id', source: 'Custom', install_path: path.join(base, 'CheckedGame') };
    let current = original;
    const calls = [];
    const manager = { explainError: error => error.message,
      checkUpdates: async () => ({ release: { commit: nextCommit }, unmanaged: 0,
        games: [{ game: clone(original), name: 'Checked fixture', state: 'available' }] }),
      updateGame: async game => { calls.push(game.install_path); return { success: true, state: 'updated' }; } };
    const context = { require: id => {
      if (id === './src/core/dlssg') return manager;
      if (id === './src/core/dlssgBatch') return { createBatch };
      if (id === './src/core/libraryService') return { cached: () => ({ games: [current] }) };
      throw new Error(`Unexpected production dependency ${id}`);
    }, path, fs, dlssgGame: () => current, assertGameIdle() {}, gameOperations: new Set(),
      operationKey: game => `install:${path.resolve(game.install_path).toLowerCase()}`,
      sendToRenderer() {}, isQuitting: false, quitPending: false };
    const batch = vm.runInNewContext(`${source.slice(start, end)}\ngetDlssgBatch();`, context, { filename: 'production-batch-factory.js' });
    const plan = await batch.check();
    current = { ...original, install_path: path.join(base, 'DifferentManagedGame') };
    const result = await batch.update(plan.checkId);
    assert.deepEqual(calls, [], 'A stale checked plan must never reach the newly selected game folder');
    assert(['failed', 'skipped'].includes(result.games[0].state));
  });
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'integrity-results.json'), JSON.stringify({ completedAt: new Date().toISOString(), results }, null, 2));
  if (results.some(result => !result.ok)) process.exitCode = 1;
  console.log(`${results.filter(result => result.ok).length}/${results.length} updater integrity checks passed.`);
  assert(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep + 'librarian-dlssg-integrity-'));
  fs.rmSync(base, { recursive: true, force: true });
});
