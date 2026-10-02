const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const { createManager } = require('../src/core/dlssg');
const { createUpstream, sha256 } = require('../src/core/dlssgUpstream');
const { createBatch } = require('../src/core/dlssgBatch');
const json = require('../src/core/jsonFile');
const { executable } = require('./dlssg-fixture.cjs');
const { updateFixture, OLD, NEXT } = require('./dlssg-update-fixture.cjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-fg-updates-'));
const output = process.env.LIBRARIAN_TEST_OUTPUT || path.resolve('audits/2026-09-11/dlssg-updates');
const results = [];
let sequence = 0;
function gameFixture(source = 'Steam') {
  const install_path = path.join(base, `game-${++sequence}`), exe = path.join(install_path, 'Game/Binaries/Win64/Game.exe');
  executable(exe);
  const target = path.dirname(exe);
  fs.writeFileSync(path.join(target, 'nvngx_dlssg.dll'), 'Native NVIDIA FG; preserve.');
  fs.writeFileSync(path.join(target, 'nvngx_dlss.dll'), 'Native NVIDIA SR; preserve.');
  return { game: { id: String(sequence), appid: String(sequence), source, game_name: `${source} fixture ${sequence}`, install_path }, exe, target };
}
function fixture(options = {}) {
  const f = gameFixture(), pkg = updateFixture(), dataPath = path.join(base, `profile-${sequence}`);
  const settings = { dataPath, release: pkg.release, fetch: pkg.fetch, hardware: async () => ({ supported: true, name: 'Fixture GPU' }), ensureIdle: async () => {}, ...options };
  return { ...f, ...pkg, dataPath, settings, manager: createManager(settings) };
}
const receiptPath = f => path.join(f.dataPath, 'installs', fs.readdirSync(path.join(f.dataPath, 'installs'))[0]);
const receipt = f => JSON.parse(fs.readFileSync(receiptPath(f)));
function filesAt(directory) {
  const found = {};
  function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else found[path.relative(directory, file)] = sha256(fs.readFileSync(file));
  } }
  walk(directory); return found;
}
async function installed(options) { const f = fixture(options); await f.manager.setEnabled(f.game, true); return f; }
async function ready(options) { const f = await installed(options); await f.manager.checkUpdates([f.game]); return f; }
async function test(name, run) {
  try { await run(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); throw error; }
}
(async () => {
  await test('status and launch inspection do not contact GitHub or update files', async () => {
    const f = await installed(), before = filesAt(f.game.install_path); f.calls.length = 0;
    await f.manager.status(f.game); await f.manager.checkLaunch(f.game);
    assert.equal(f.calls.length, 0); assert.deepEqual(filesAt(f.game.install_path), before);
    assert(!fs.existsSync(path.join(f.dataPath, 'active-release.json')));
  });
  await test('check resolves an immutable revision using metadata only and preserves all game bytes', async () => {
    const f = await installed(), before = filesAt(f.game.install_path); f.calls.length = 0;
    const plan = await f.manager.checkUpdates([f.game]);
    assert.equal(plan.release.commit, NEXT); assert.equal(plan.games[0].state, 'available');
    assert(f.calls.every(call => !call.url.includes('/contents/') && !call.url.endsWith('.dll')));
    assert(f.calls.every(call => call.options.redirect === 'error'));
    assert.deepEqual(filesAt(f.game.install_path), before); assert.equal(receipt(f).commit, OLD);
  });
  await test('all library sources are included, aliases are deduplicated, unmanaged games remain off', async () => {
    const f = await installed(), custom = gameFixture('Custom'), other = gameFixture('Other'), off = gameFixture('Custom');
    await f.manager.setEnabled(custom.game, true); await f.manager.setEnabled(other.game, true);
    const plan = await f.manager.checkUpdates([f.game, custom.game, other.game, { ...custom.game, id: 'alias' }, off.game]);
    assert.equal(plan.games.length, 3); assert.equal(plan.unmanaged, 1);
    assert.deepEqual(plan.games.map(row => row.source), ['Steam', 'Custom', 'Other']);
    assert(plan.games.every(row => row.state === 'available'));
    assert(!fs.existsSync(path.join(off.target, 'version.dll')));
  });
  await test('unchecked revisions cannot update a game', async () => {
    const f = await installed(), before = filesAt(f.game.install_path);
    await assert.rejects(f.manager.updateGame(f.game, NEXT), /Check for/);
    assert.deepEqual(filesAt(f.game.install_path), before);
  });
  await test('upgrade backs up both old files, preserves native DLLs and records the installed revision', async () => {
    const f = await ready();
    const result = await f.manager.updateGame(f.game, NEXT);
    assert.equal(result.state, 'updated'); assert.equal(result.version, '0.2.4');
    for (const name of ['version.dll', 'dlssg_sm86.ini']) {
      assert(fs.readFileSync(path.join(f.target, name)).equals(f.newPayload[name]));
      assert(fs.readFileSync(path.join(result.backup, name)).equals(f.oldPayload[name]));
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(result.backup, 'receipt.json'))).commit, OLD);
    assert.equal(fs.readFileSync(path.join(f.target, 'nvngx_dlss.dll'), 'utf8'), 'Native NVIDIA SR; preserve.');
    assert.equal(receipt(f).commit, NEXT); assert.equal(receipt(f).update, undefined);
    const status = await f.manager.status(f.game); assert.equal(status.enabled, true); assert.equal(status.commit, NEXT);
    await f.manager.checkLaunch(f.game);
    assert.equal((await f.manager.checkUpdates([f.game])).games[0].state, 'current');
    assert.equal((await f.manager.updateGame(f.game, NEXT)).state, 'current');
  });
  await test('after explicit update the verified selection survives restart and works offline for new installs', async () => {
    const f = await ready(); await f.manager.updateGame(f.game, NEXT);
    const nextGame = gameFixture('Custom');
    const restarted = createManager({ ...f.settings, fetch: async () => { throw new Error('Network must not be used'); } });
    await restarted.setEnabled(nextGame.game, true);
    assert(fs.readFileSync(path.join(nextGame.target, 'version.dll')).equals(f.newPayload['version.dll']));
    assert.equal((await restarted.status(nextGame.game)).commit, NEXT);
    await restarted.setEnabled(f.game, false);
    assert(!fs.existsSync(path.join(f.target, 'version.dll'))); assert(fs.existsSync(path.join(f.target, 'nvngx_dlssg.dll')));
  });
  await test('bad payload hashes never touch the previous installation', async () => {
    const f = fixture(); f.settings.fetch = async (url, opts) => url.includes(NEXT) && url.includes('version.dll')
      ? { ok: true, buffer: async () => Buffer.alloc(f.newPayload['version.dll'].length, 7) } : f.fetch(url, opts);
    f.manager = createManager(f.settings); await f.manager.setEnabled(f.game, true); await f.manager.checkUpdates([f.game]);
    const before = filesAt(f.game.install_path), record = receipt(f);
    await assert.rejects(f.manager.updateGame(f.game, NEXT), /Integrity|download failed/);
    assert.deepEqual(filesAt(f.game.install_path), before); assert.deepEqual(receipt(f), record);
  });
  await test('modified configuration is blocked during checks and rechecked before an update', async () => {
    const f = await ready(); fs.writeFileSync(path.join(f.target, 'dlssg_sm86.ini'), 'User custom settings');
    const before = filesAt(f.game.install_path);
    assert.equal((await f.manager.checkUpdates([f.game])).games[0].state, 'blocked');
    await assert.rejects(f.manager.updateGame(f.game, NEXT), /changed|incomplete/);
    assert.deepEqual(filesAt(f.game.install_path), before);
  });
  await test('a game started during download prevents replacement', async () => {
    let running = false; const f = fixture({ ensureIdle: async () => { if (running) throw new Error('Game is running'); } });
    const originalFetch = f.settings.fetch;
    f.settings.fetch = async (url, opts) => { if (url.includes(NEXT) && url.includes('version.dll')) running = true; return originalFetch(url, opts); };
    f.manager = createManager(f.settings); await f.manager.setEnabled(f.game, true); await f.manager.checkUpdates([f.game]);
    const before = filesAt(f.game.install_path);
    await assert.rejects(f.manager.updateGame(f.game, NEXT), /running/);
    assert.deepEqual(filesAt(f.game.install_path), before);
  });
  await test('failure publishing the new DLL rolls back the original pair and receipt', async () => {
    const f = await ready(), before = filesAt(f.game.install_path), record = receipt(f), link = fsp.link;
    let injected = false;
    fsp.link = async (source, target) => { if (!injected && target === path.join(f.target, 'version.dll')) { injected = true; throw new Error('Simulated sharing violation'); } return link(source, target); };
    try { await assert.rejects(f.manager.updateGame(f.game, NEXT), /previous.*restored/); } finally { fsp.link = link; }
    assert(injected); assert.deepEqual(filesAt(f.game.install_path), before); assert.deepEqual(receipt(f), record);
    assert.equal((await f.manager.status(f.game)).enabled, true);
  });
  await test('failed rollback retains recoverable ownership across restart', async () => {
    const f = await ready(), link = fsp.link;
    fsp.link = async (source, target) => { if (target === path.join(f.target, 'version.dll')) throw new Error('Persistently locked'); return link(source, target); };
    try { await assert.rejects(f.manager.updateGame(f.game, NEXT), error => error.code === 'DLSSG_UPDATE_RECOVERY'); } finally { fsp.link = link; }
    assert(receipt(f).update);
    const restarted = createManager(f.settings), status = await restarted.status(f.game);
    assert.equal(status.enabled, false); assert.equal(status.canDisable, true);
    await assert.rejects(restarted.checkLaunch(f.game), /incomplete/);
    await restarted.setEnabled(f.game, false); assert(!fs.existsSync(path.join(f.target, 'dlssg_sm86.ini')));
    assert(fs.existsSync(path.join(f.target, 'nvngx_dlssg.dll')));
  });
  await test('foreign files arriving during publication are preserved even during rollback', async () => {
    const f = await ready(), link = fsp.link; let injected = false;
    fsp.link = async (source, target) => {
      if (!injected && target === path.join(f.target, 'version.dll')) { injected = true; fs.writeFileSync(target, 'Foreign proxy arrived'); }
      return link(source, target);
    };
    try { await assert.rejects(f.manager.updateGame(f.game, NEXT), error => error.code === 'DLSSG_UPDATE_RECOVERY'); } finally { fsp.link = link; }
    assert.equal(fs.readFileSync(path.join(f.target, 'version.dll'), 'utf8'), 'Foreign proxy arrived');
    assert.equal((await f.manager.status(f.game)).canDisable, false);
  });
  await test('receipt publication failure rolls back the game bytes', async () => {
    const f = await ready(), before = filesAt(f.game.install_path), write = json.write; let injected = false;
    json.write = (file, value, options) => {
      if (!injected && file === receiptPath(f) && value.commit === NEXT && !value.update) { injected = true; throw new Error('Receipt write blocked'); }
      return write(file, value, options);
    };
    try { await assert.rejects(f.manager.updateGame(f.game, NEXT), /restored/); } finally { json.write = write; }
    assert(injected); assert.deepEqual(filesAt(f.game.install_path), before); assert.equal(receipt(f).commit, OLD);
  });
  await test('concurrent update, toggle and launch requests cannot overlap the same installation', async () => {
    const f = await ready(); let entered, releaseGate;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { releaseGate = resolve; });
    const manager = createManager({ ...f.settings, ensureIdle: async () => { entered(); await gate; } });
    await manager.checkUpdates([f.game]);
    const operation = manager.updateGame(f.game, NEXT); await started;
    try {
      await assert.rejects(manager.updateGame(f.game, NEXT), /already being changed/);
      await assert.rejects(manager.setEnabled(f.game, false), /already being changed/);
      await assert.rejects(manager.checkLaunch(f.game), /Wait for/);
    } finally { releaseGate(); }
    await operation;
  });
  await test('newer or divergent installations are never silently downgraded', async () => {
    const f = fixture(); f.settings.fetch = async (url, opts) => url.includes('/compare/')
      ? { ok: true, json: async () => ({ status: 'behind' }) } : f.fetch(url, opts);
    f.manager = createManager(f.settings); await f.manager.setEnabled(f.game, true);
    assert.equal((await f.manager.checkUpdates([f.game])).games[0].state, 'blocked');
    await assert.rejects(f.manager.updateGame(f.game, NEXT), /downgrade/);
    assert.equal(receipt(f).commit, OLD);
  });
  await test('unsupported upstream layouts, linked blobs and oversized files are rejected', async () => {
    for (const mutate of [tree => { tree.truncated = true; }, tree => { tree.tree.pop(); }, tree => { tree.tree[0].mode = '120000'; }, tree => { tree.tree[0].size = 128 * 1024 * 1024; }, tree => { tree.tree[0].sha = 'invalid'; }]) {
      const pkg = updateFixture(); mutate(pkg.tree);
      await assert.rejects(createUpstream(pkg.fetch).check(), /package|tree|format/);
    }
  });
  await test('GitHub rate limits produce an actionable error', async () => {
    await assert.rejects(createUpstream(async () => ({ ok: false, status: 403 })).check(), /limited.*Try again/);
  });
  await test('bulk updates continue after a failed game and retain per-game results', async () => {
    const events = [], calls = [], games = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];
    const manager = { explainError: e => e.message, checkUpdates: async input => {
      assert.deepEqual(input, games); return { release: { commit: NEXT }, unmanaged: 1, games: games.map((game, index) => ({ game, name: game.id, source: index ? 'Custom' : 'Steam', state: 'available' })) };
    } };
    const batch = createBatch({ manager, getGames: () => games, onProgress: value => events.push(value), runUpdate: async (game, commit) => {
      calls.push(game.id); assert.equal(commit, NEXT); if (game.id === 'two') throw new Error('Game is locked'); return { success: true, state: 'updated' };
    } });
    assert.equal(calls.length, 0); const checked = await batch.check(); assert.equal(calls.length, 0);
    await assert.rejects(batch.update('invented-check'), /Check for/);
    const result = await batch.update(checked.checkId);
    assert.deepEqual(calls, ['one', 'two', 'three']); assert.equal(result.counts.updated, 2); assert.equal(result.counts.failed, 1);
    assert.equal(result.completed, 3); assert.equal(result.phase, 'done'); assert(events.some(event => event.phase === 'updating'));
    result.games[0].state = 'tampered'; assert.equal(batch.snapshot().games[0].state, 'updated');
  });
  await test('double-clicks and checks during a batch cannot start duplicate work', async () => {
    let releaseGate, entered; const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { releaseGate = resolve; }); let calls = 0;
    const batch = createBatch({ manager: { explainError: e => e.message, checkUpdates: async () => ({ release: { commit: NEXT }, games: [{ game: {}, state: 'available' }] }) },
      getGames: () => [], runUpdate: async () => { calls++; entered(); await gate; return { success: true, state: 'updated' }; } });
    const checked = await batch.check(), update = batch.update(checked.checkId); await started;
    try { await assert.rejects(batch.update(checked.checkId), /already in progress/); await assert.rejects(batch.check(), /already in progress/); }
    finally { releaseGate(); }
    await update; assert.equal(calls, 1);
  });
  await test('a failed recheck invalidates the earlier update plan', async () => {
    let failed = false, calls = 0;
    const batch = createBatch({ manager: { explainError: e => e.message, checkUpdates: async () => {
      if (failed) throw new Error('Offline'); return { release: { commit: NEXT }, games: [{ game: {}, state: 'available' }] };
    } }, getGames: () => [], runUpdate: async () => { calls++; } });
    const checked = await batch.check(); failed = true; assert.equal((await batch.check()).phase, 'error');
    await assert.rejects(batch.update(checked.checkId), /Check for/); assert.equal(calls, 0);
  });
  console.log(`${results.length}/${results.length} DLSS FG update checks passed. Only temporary inert game fixtures were modified.`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'update-tests.json'), JSON.stringify({ results, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length }, null, 2));
  assert(path.resolve(base).startsWith(path.join(path.resolve(os.tmpdir()), 'librarian-fg-updates-')));
  fs.rmSync(base, { recursive: true, force: true });
});
