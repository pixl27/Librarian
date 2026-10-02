const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { zip } = require('./update-identity-fixture.cjs');

module.exports = async ({ evaluate, fixture, library, capture, wait, report, queue, target, engineRuns, manifestFixtures, manifestRequests }) => {
  const meccha = '4704690', crimson = '3321460';
  const titles = { [meccha]: 'MECCHA CHAMELEON', [crimson]: 'Crimson Desert Enhanced' };
  const folders = { [meccha]: 'MECCHA_CHAMELEON', [crimson]: 'Crimson_Desert' };
  const archive = id => zip({ [`${id}.lua`]: `addappid(${id}) -- ${titles[id]}\naddappid(${Number(id) + 1}, 1, "inert-fixture-key") -- Windows game\n`, [`${Number(id) + 1}_100.manifest`]: 'Inert manifest fixture' });
  for (const id of [meccha, crimson]) {
    const install = path.join(library, 'steamapps/common', folders[id]);
    fs.mkdirSync(path.join(install, '.DepotDownloader'), { recursive: true }); fs.writeFileSync(path.join(install, 'fixture.txt'), titles[id]);
    fs.writeFileSync(path.join(library, `steamapps/appmanifest_${id}.acf`), `"AppState" { "appid" "${id}" "installdir" "${folders[id]}" "name" "${titles[id]}" "buildid" "100" "InstalledDepots" { "${Number(id) + 1}" { "manifest" "99" } } }`);
    manifestFixtures.set(id, archive(id));
  }
  const until = async predicate => { for (let n = 0; n < 150; n++) { if (await predicate()) return; await wait(20); } throw new Error('Update identity check timed out'); };
  await evaluate('api.setSetting("hubcap_api_key", "isolated-fixture-key")');
  await evaluate('Librarian.scanAndRender()');
  await evaluate(`window.mecchaFixture = Librarian.games.find(g=>g.appid==='${meccha}'); window.crimsonFixture = Librarian.games.find(g=>g.appid==='${crimson}'); true;`);
  const checker = require(path.join(target, 'src/core/updateChecker.js'));
  const originalCheck = checker.checkForUpdate;
  const info = id => ({ status: 'update_available', localBuildId: '100', remoteBuildId: id === meccha ? '200' : '300' });
  checker.checkForUpdate = async id => info(String(id));
  const originalRuns = engineRuns.length;
  try {
    // The remote endpoint can return a perfectly well-formed ZIP for the wrong game.
    manifestFixtures.set(meccha, archive(crimson));
    const wrong = await evaluate(`api.downloadManifest('${meccha}')`);
    assert.equal(wrong.filepath, null); assert.match(wrong.error, /4704690.*3321460/);
    assert.equal(fs.readdirSync(path.join(fixture, 'hubcap_manifests')).length, 0);
    report.checks.push('Manifest service returning Crimson Desert for MECCHA is rejected and removed before queueing');
    manifestFixtures.set(meccha, archive(meccha));
    const files = await evaluate(`Promise.all([api.downloadManifest('${meccha}'), api.downloadManifest('${meccha}')])`);
    assert(files.every(result => result.filepath && !result.error)); assert.notEqual(files[0].filepath, files[1].filepath);
    for (const file of files) await evaluate(`api.cleanupFetchedZip(${JSON.stringify(file.filepath)})`);
    report.checks.push('Concurrent manifest fetches use independent verified files');

    const wrongPath = path.join(fixture, 'wrong-game.zip'); fs.writeFileSync(wrongPath, archive(crimson));
    const parsed = await evaluate(`api.processZip(${JSON.stringify(wrongPath)}, '${meccha}')`);
    assert.equal(parsed.success, false); assert.match(parsed.error, /4704690.*3321460/);
    const mixedPath = path.join(fixture, 'mixed-games.zip'); fs.writeFileSync(mixedPath, zip({ 'a.lua': `addappid(${meccha})`, 'b.lua': `addappid(${crimson})` }));
    const mixed = await evaluate(`api.processZip(${JSON.stringify(mixedPath)}, '${meccha}')`);
    assert.equal(mixed.success, false); assert.match(mixed.error, /4704690.*3321460/);
    report.checks.push('ZIP processing rejects wrong or mixed AppIDs before enrichment or game writes');

    const job = { id: 811, name: titles[meccha], appid: meccha, jobType: 'update', destPath: library, installDir: folders[meccha], installPath: path.join(library, 'steamapps/common', folders[meccha]) };
    await evaluate(`api.addQueueJob(${JSON.stringify(job)})`);
    const changed = await evaluate(`api.patchQueueJob(811,{appid:'${crimson}'}).then(()=>false,error=>error.message)`);
    assert.match(changed, /Cannot change/);
    const payload = { jobId: 811, gameData: { appid: crimson, installdir: folders[crimson] }, selectedDepots: ['3321461'], destPath: library };
    const blocked = await evaluate(`api.startDownload(${JSON.stringify(payload)})`);
    assert.equal(blocked.success, false); assert.match(blocked.error, /4704690.*3321460/);
    payload.gameData.appid = meccha; payload.destPath = path.join(fixture, 'Wrong library');
    const redirected = await evaluate(`api.startDownload(${JSON.stringify(payload)})`);
    assert.equal(redirected.success, false); assert.match(redirected.error, /destination changed/);
    assert.equal(engineRuns.length, originalRuns);
    await evaluate('api.removeQueueJob(811)');
    report.checks.push('Production download IPC rejects changed AppIDs and update destinations before starting the engine');

    let releaseCheck, started = false;
    checker.checkForUpdate = id => { started = true; return new Promise(resolve => { releaseCheck = () => resolve(info(String(id))); }); };
    await evaluate(`Librarian.state.updateResults['${meccha}']=${JSON.stringify(info(meccha))}; Librarian.openFlyout(crimsonFixture); document.querySelector('#flyout-update-check').click(); true;`);
    await until(() => started);
    await evaluate('Librarian.openFlyout(mecchaFixture); true;');
    releaseCheck(); await wait(80);
    assert.equal(await evaluate('document.querySelector("#flyout-title").textContent'), titles[meccha]);
    assert(!(await evaluate('document.querySelector("#flyout-update-status").textContent')).includes('300'));
    report.checks.push('A late Crimson Desert update check cannot replace MECCHA detail status');

    started = false; const beforeRequest = manifestRequests.length;
    await evaluate('document.querySelector("#flyout-update-primary").click(); true;');
    await until(() => started);
    await evaluate('Librarian.openFlyout(crimsonFixture); true;');
    releaseCheck();
    await until(() => engineRuns.length > originalRuns || queue.snapshot().jobs.some(j => j.status === 'failed'));
    assert.equal(engineRuns.length, originalRuns + 1, JSON.stringify(queue.snapshot()));
    assert.deepEqual(manifestRequests.slice(beforeRequest), [meccha]);
    const run = engineRuns.at(-1);
    assert.equal(run.game.appid, meccha); assert.equal(run.game.game_name, titles[meccha]); assert.equal(run.game.installdir, folders[meccha]);
    assert.equal(run.destination, library); assert.deepEqual(run.depots, ['4704691']);
    assert.equal(queue.snapshot().active.gameData.appid, meccha);
    await capture('meccha-update-identity');
    run.callbacks.onComplete(); run.release();
    await until(() => !queue.snapshot().active);
    await until(async () => !(await evaluate('Librarian.state.isProcessing')));
    report.checks.push('Clicking MECCHA Update then opening Crimson details still requests only MECCHA, its depot and its existing folder');
    assert.equal(fs.readFileSync(path.join(job.installPath, 'fixture.txt'), 'utf8'), titles[meccha]);
    assert.equal(fs.readFileSync(path.join(library, 'steamapps/common', folders[crimson], 'fixture.txt'), 'utf8'), titles[crimson]);
  } finally {
    checker.checkForUpdate = originalCheck;
    for (const id of [meccha, crimson]) fs.unlinkSync(path.join(library, `steamapps/appmanifest_${id}.acf`));
    await evaluate('Librarian.scanAndRender()');
  }
};
