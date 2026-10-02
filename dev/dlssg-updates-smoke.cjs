// Production renderer -> preload -> IPC -> batch -> manager, with inert payloads
// and a temporary library supplied by electron-smoke.cjs. No live game or network.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { executable } = require('./dlssg-fixture.cjs');
const { OLD, NEXT } = require('./dlssg-update-fixture.cjs');
const { sha256 } = require('../src/core/dlssgUpstream');

module.exports = async ({ evaluate, fixture, capture, mainWindow, wait, report, dlssg, updatePackage }) => {
  const assertFixture = file => {
    const rel = path.relative(path.resolve(fixture), path.resolve(file));
    assert(rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel), `Non-fixture target refused: ${file}`);
  };
  const waitFor = async (predicate, description) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(predicate)) return;
      await wait(25);
    }
    throw new Error(`Timed out: ${description}`);
  };
  const snapshot = directory => {
    assertFixture(directory);
    const result = {};
    const walk = dir => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, item.name);
        assert(!item.isSymbolicLink(), 'Fixture must not contain links');
        if (item.isDirectory()) walk(file);
        else result[path.relative(directory, file)] = sha256(fs.readFileSync(file));
      }
    };
    walk(directory); return result;
  };
  const addRenderer = directory => {
    assertFixture(directory);
    const exe = path.join(directory, 'BulkFixture.exe');
    executable(exe);
    fs.writeFileSync(path.join(directory, 'nvngx_dlssg.dll'), 'Native FG fixture: preserve.');
    fs.writeFileSync(path.join(directory, 'nvngx_dlss.dll'), 'Native SR fixture: preserve.');
    return exe;
  };
  const initial = await evaluate('api.getDlssgUpdates()');
  assert.equal(initial.phase, 'idle');
  assert(!updatePackage.calls.some(call => call.url.includes('/commits/main')));
  assert(!fs.existsSync(path.join(fixture, 'dlssg-sm86/active-release.json')));
  const steam = await evaluate('Librarian.games.find(g => g.source === "Librarian" && String(g.appid) === "4242")');
  assert(steam, 'Missing isolated Steam fixture'); assertFixture(steam.install_path);
  const steamDirectory = path.join(steam.install_path, 'BulkGraphics');
  addRenderer(steamDirectory);
  const customs = [];
  for (const name of ['Custom update fixture', 'Locked update fixture', 'Modified settings fixture', 'Disabled FG fixture']) {
    const directory = path.join(fixture, 'BulkGames', name), exe = addRenderer(directory);
    const game = await evaluate(`api.addCustomGame(${JSON.stringify({ game_name: name, install_path: directory, executable: exe })})`);
    customs.push(game);
  }
  const [custom, locked, modified, disabled] = customs;
  const managed = [steam, custom, locked, modified];
  for (const game of managed) await dlssg.setEnabled(game, true);
  fs.writeFileSync(path.join(modified.install_path, 'dlssg_sm86.ini'), 'User configuration: preserve.');
  await evaluate('Librarian.scanAndRender()');
  const before = new Map([...managed, disabled].map(game => [game.install_path, snapshot(game.install_path)]));
  await evaluate(`Librarian.openFlyout(Librarian.games.find(g => g.id === ${JSON.stringify(custom.id)})); true;`);
  await waitFor('Boolean(document.querySelector("#fg-open-updates"))', 'Graphics updater shortcut');
  await evaluate('document.querySelector("#fg-open-updates").click(); true;');
  await waitFor('document.querySelector("#page-settings").classList.contains("active")', 'Settings navigation');
  assert.equal(await evaluate('document.querySelector("#fg-updates-apply").disabled'), true);
  assert.equal(await evaluate('document.activeElement.id'), 'fg-updates-check');
  assert(!updatePackage.calls.some(call => call.url.includes('/commits/main')));
  report.checks.push('Opening Settings/Graphics or its per-game shortcut neither checks GitHub nor updates a game');

  const firstCheckCall = updatePackage.calls.length;
  mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await waitFor('document.querySelector("#fg-updates").getAttribute("aria-busy") === "false" && !document.querySelector("#fg-updates-apply").disabled', 'keyboard update check');
  const plan = await evaluate('api.getDlssgUpdates()');
  assert.equal(plan.phase, 'ready'); assert.equal(plan.counts.available, 3); assert.equal(plan.counts.blocked, 1);
  assert(plan.games.some(row => row.source === 'Librarian')); assert(plan.games.some(row => row.source === 'Custom'));
  assert(updatePackage.calls.slice(firstCheckCall).every(call => !call.url.includes('/contents/') && !call.url.endsWith('.dll')));
  for (const game of [...managed, disabled]) assert.deepEqual(snapshot(game.install_path), before.get(game.install_path));
  assert(!fs.existsSync(path.join(fixture, 'dlssg-sm86/active-release.json')));
  await evaluate('document.querySelector("#toast-stack").replaceChildren(); true;');
  await capture('dlssg-updates-ready-1280');
  mainWindow.setSize(1024, 600); mainWindow.webContents.setZoomFactor(1.25); await wait(100);
  await evaluate('document.querySelector("#fg-updates-apply").scrollIntoView({block:"center"}); true;');
  const bounds = await evaluate('(()=>{const b=document.querySelector("#fg-updates-apply").getBoundingClientRect();return {visible:b.top>=0&&b.bottom<=innerHeight&&b.left>=0&&b.right<=innerWidth,overflow:document.documentElement.scrollWidth>innerWidth};})()');
  assert(bounds.visible && !bounds.overflow, JSON.stringify(bounds));
  await capture('dlssg-updates-1024-125percent');
  mainWindow.webContents.setZoomFactor(1); mainWindow.setSize(1280, 800);
  report.checks.push('Keyboard check lists Steam-library and Custom updates, blocks modified INI, preserves every fixture byte and fits 1024px at 125% zoom');

  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const update = dlssg.updateGame, calls = [];
  dlssg.updateGame = async (game, ...args) => {
    assertFixture(game.install_path); calls.push(game.install_path);
    if (calls.length === 1) await gate;
    if (game.id === locked.id && game.source === 'Custom') throw new Error('Simulated locked fixture: close the game and retry.');
    return update(game, ...args);
  };
  try {
    await evaluate('document.querySelector("#fg-updates-apply").focus(); true;');
    mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await waitFor('!document.querySelector("#fg-updates-progress").classList.contains("hidden")', 'bulk update started');
    assert.equal(await evaluate('document.querySelector("#fg-updates-check").disabled && document.querySelector("#fg-updates-apply").disabled'), true);
    const duplicate = await evaluate(`api.updateAllDlssg(${JSON.stringify(plan.checkId)})`);
    assert.equal(duplicate.ok, false); assert.match(duplicate.error, /already in progress/);
    mainWindow.webContents.reload();
    await new Promise(resolve => mainWindow.webContents.once('did-finish-load', resolve));
    await waitFor('Boolean(window.Librarian?.state.queueReady && window.LibrarianDlssgUpdates)', 'renderer reload');
    await evaluate('LibrarianDlssgUpdates.open(); true;');
    await waitFor('!document.querySelector("#fg-updates-progress").classList.contains("hidden")', 'reattached batch progress');
    assert.equal(calls.length, 1);
    assert.equal(await evaluate('document.querySelector("#fg-updates-check").disabled && document.querySelector("#fg-updates-apply").disabled'), true);
    await capture('dlssg-updates-reload-progress');
    releaseGate();
    await waitFor('document.querySelector("#fg-updates").getAttribute("aria-busy") === "false" && document.querySelector("#fg-updates-message").textContent.includes("failed")', 'completed batch');
  } finally { releaseGate(); dlssg.updateGame = update; }
  const done = await evaluate('api.getDlssgUpdates()');
  assert.equal(done.phase, 'done'); assert.equal(done.counts.updated, 2); assert.equal(done.counts.failed, 1); assert.equal(done.counts.blocked, 1);
  assert.equal(done.completed, 3); assert.equal(calls.length, 3);
  assert.equal(await evaluate('document.querySelectorAll(".fg-update-backup").length'), 2);
  for (const [game, directory] of [[steam, steamDirectory], [custom, custom.install_path]]) {
    const expected = { ...before.get(game.install_path) };
    for (const name of ['version.dll', 'dlssg_sm86.ini']) expected[path.relative(game.install_path, path.join(directory, name))] = sha256(updatePackage.newPayload[name]);
    assert.deepEqual(snapshot(game.install_path), expected);
    const row = done.games.find(item => item.game.install_path === game.install_path);
    assertFixture(row.backup);
    for (const name of ['version.dll', 'dlssg_sm86.ini']) assert(fs.readFileSync(path.join(row.backup, name)).equals(updatePackage.oldPayload[name]));
    assert.equal((await dlssg.status(game)).commit, NEXT);
  }
  for (const game of [locked, modified, disabled]) assert.deepEqual(snapshot(game.install_path), before.get(game.install_path));
  assert.equal((await dlssg.status(locked)).commit, OLD);
  await capture('dlssg-updates-results-1280');
  report.checks.push('Keyboard Update all reaches real batch/manager; reload and duplicate requests do not duplicate work; success, failure, backups and protected game bytes are verified');

  const checkUpdates = dlssg.checkUpdates;
  dlssg.checkUpdates = async () => { throw new Error('Simulated offline GitHub check. Try again.'); };
  try {
    await evaluate('document.querySelector("#fg-updates-check").click(); true;');
    await waitFor('document.querySelector("#fg-updates-message").classList.contains("fg-error") && document.querySelector("#fg-updates").getAttribute("aria-busy") === "false"', 'actionable check failure');
    assert.match(await evaluate('document.querySelector("#fg-updates-message").textContent'), /offline.*Try again/);
    assert.equal(await evaluate('document.querySelector("#fg-updates-apply").disabled'), true);
    const stale = await evaluate(`api.updateAllDlssg(${JSON.stringify(plan.checkId)})`);
    assert.equal(stale.ok, false); assert.match(stale.error, /Check for updates again/);
    await capture('dlssg-updates-check-error');
  } finally { dlssg.checkUpdates = checkUpdates; }
  await evaluate('document.querySelector("#fg-updates-check").click(); true;');
  await waitFor('document.querySelector("#fg-updates").getAttribute("aria-busy") === "false" && !document.querySelector("#fg-updates-apply").disabled', 'retry check');
  assert.equal((await evaluate('api.getDlssgUpdates()')).counts.current, 2);
  report.checks.push('Failed GitHub check shows a retryable error and invalidates the old plan; retry recognizes already-updated games');

  // Remove only our temporary setup so subsequent production smoke checks keep
  // their original library. The user's installation paths never enter this test.
  fs.writeFileSync(path.join(modified.install_path, 'dlssg_sm86.ini'), updatePackage.oldPayload['dlssg_sm86.ini']);
  for (const game of managed) await dlssg.setEnabled(game, false);
  await evaluate('Librarian.closeFlyout(); true;');
  for (const game of customs) await evaluate(`api.removeCustomGame(${JSON.stringify(game.id)})`);
  assertFixture(steamDirectory); fs.rmSync(steamDirectory, { recursive: true, force: true });
  await evaluate('Librarian.scanAndRender()');
};
