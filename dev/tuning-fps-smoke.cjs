const assert = require('assert/strict');

module.exports = async ({ evaluate, mainWindow, capture, wait, report }) => {
  await evaluate('Librarian.closeFlyout(); Librarian.navigateTo("tuning"); true;');
  await wait(100);
  const session = {
    pid: 456789, key: 'steam:2584270', name: 'Mortal Shell II · measurement fixture', running: true,
    startedAt: Date.now() - 20000, lastFrameAt: Date.now(), stale: false, measurement: 'present-calls',
    config: { flags: 8, fps: 0 }, header: { api: 'D3D12', frames: 240, canQueue: true, hooks: 4 },
    summary: { fps: 60, count: 240, seconds: 4, low1Fps: 58, avgMs: 16.67, p99Ms: 17.2, gpuLatMs: null, presentMs: 1, cpuMs: 4, queueDepth: 1, limiterMs: 0, gpuWaitMs: 2, flags: 8 },
  };
  const send = async () => { mainWindow.webContents.send('tuning:stats', session); await wait(60); };
  await send();
  assert.equal(await evaluate('document.querySelector("#tn-m-fps").textContent'), '60.0');
  assert((await evaluate('document.querySelector("#tn-measurement-note").textContent')).includes('DLSS Frame Generation'));
  await evaluate('document.querySelector("#tn-live").scrollIntoView({block:"center"}); true;');
  await wait(80);
  await capture('tuning-measured-fps');
  session.stale = true; session.lastFrameAt -= 4000;
  const historyCount = await evaluate('LibrarianTuning.state.history.length');
  await send();
  assert.equal(await evaluate('document.querySelector("#tn-m-fps").textContent'), '—');
  assert((await evaluate('document.querySelector("#tn-status").textContent')).includes('no recent frame measurements'));
  assert.equal(await evaluate('document.querySelector("#tn-ab-run").disabled'), true);
  assert.equal(await evaluate('LibrarianTuning.state.history.length'), historyCount);
  await capture('tuning-stale-fps');
  session.stale = false; session.lastFrameAt = Date.now(); session.summary.fps = 100;
  await send();
  assert.equal(await evaluate('document.querySelector("#tn-m-fps").textContent'), '100');
  assert.equal(await evaluate('document.querySelector("#tn-ab-run").disabled'), false);
  report.checks.push('Tuning labels Present-based FPS, clears frozen readings, pauses its history/A-B button and resumes when fresh measurements arrive');
  mainWindow.webContents.send('tuning:session', { ...session, running: false, endedAt: Date.now() });
  await wait(60);
};
