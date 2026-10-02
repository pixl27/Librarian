// Use the installed Electron's Node runtime for electron-builder. The host's
// Node 20 is older than the packaging tools require. Never publish a release.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.LIBRARIAN_TEST_OUTPUT || path.join(root, 'audits/2026-09-11/ui-optimization'));
if (process.argv.includes('--builder-child')) {
  process.noAsar = true;
  process.chdir(root);
  const builder = require('electron-builder');
  builder.build({ targets: builder.Platform.WINDOWS.createTarget('portable', builder.Arch.x64), publish: 'never' })
    .then(artifacts => console.log(JSON.stringify({ artifacts })))
    .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
} else {
  fs.mkdirSync(output, { recursive: true });
  const startedAt = new Date().toISOString();
  const log = fs.openSync(path.join(output, 'build.log'), 'w');
  let run;
  try {
    run = spawnSync(require('electron'), [__filename, '--builder-child'], {
      cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true,
      stdio: ['ignore', log, log], timeout: 600000,
    });
  } finally { fs.closeSync(log); }
  const result = { startedAt, finishedAt: new Date().toISOString(), exitCode: run.status, signal: run.signal, error: run.error?.message, publish: 'never' };
  fs.writeFileSync(path.join(output, 'build-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  process.exitCode = run.status === 0 && !run.error ? 0 : 1;
}
