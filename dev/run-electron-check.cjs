// Wait for Electron's real exit code on Windows, where invoking the GUI exe
// directly from PowerShell may return before the audit has finished.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const mode = process.argv[2] || 'ui';
if (!['ui', 'smoke'].includes(mode)) throw new Error('Usage: node dev/run-electron-check.cjs ui|smoke [--packaged|--baseline]');
const args = process.argv.slice(3);
if (args.some(arg => !['--packaged', '--baseline'].includes(arg)) || (mode === 'smoke' && args.includes('--baseline'))) throw new Error('Invalid audit options');
const output = path.resolve(process.env.LIBRARIAN_TEST_OUTPUT || path.join(root, 'audits/2026-09-11/ui-optimization'));
fs.mkdirSync(output, { recursive: true });
const name = mode + (args.includes('--packaged') ? '-packaged' : args.includes('--baseline') ? '-baseline' : '-source');
const stdout = fs.openSync(path.join(output, name + '-stdout.log'), 'w');
const stderr = fs.openSync(path.join(output, name + '-stderr.log'), 'w');
const env = { ...process.env, LIBRARIAN_TEST_OUTPUT: output };
delete env.ELECTRON_RUN_AS_NODE;
let run;
const startedAt = new Date().toISOString();
try {
  run = spawnSync(require('electron'), [path.join(__dirname, mode === 'ui' ? 'verify-ui.cjs' : 'electron-smoke.cjs'), ...args], {
    cwd: root, env, windowsHide: true, stdio: ['ignore', stdout, stderr], timeout: 120000,
  });
} finally { fs.closeSync(stdout); fs.closeSync(stderr); }
const result = { startedAt, finishedAt: new Date().toISOString(), exitCode: run.status, signal: run.signal, error: run.error?.message };
fs.writeFileSync(path.join(output, name + '-exit.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ name, ...result }));
if (run.status !== 0) console.error(fs.readFileSync(path.join(output, name + '-stdout.log'), 'utf8').slice(-10000));
process.exitCode = run.status === 0 && !run.error ? 0 : 1;
