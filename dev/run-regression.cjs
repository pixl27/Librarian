// Run behavioral engine fixtures sequentially: their sandbox cleanup is shared.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(process.env.LIBRARIAN_TEST_OUTPUT || path.join(root, 'audits/2026-09-07/fixes'), 'regression-results.json');
const suites = [
  ['steampipe-engine','e2e-encrypted'],
  ['steampipe-engine','e2e-custom-update'],
  ...['desktop-clip','bp-clip','bp-scroll-clip','desktop-search-cards','bp-search-cards','search-routing','bp-front-improvements','bp-page-improvements','integrity','self-test'].map(s => ['store',s]),
  ['news','all'], ['steampipe-engine','integrity'], ['tuning','integrity'], ['emucompat','integrity'],
  ...['deps','zip','lua','keys','fetch','stale','endpoint','search','wiring','integrity','self-test'].map(s => ['steammanifest',s]),
  ...['catalog','keyorder','reqcode','proxy','paid','wiring','self-test'].map(s => ['keycatalog',s]),
  ...['e2e-fresh','e2e-resume','e2e-update','e2e-repair','e2e-guards','e2e-persist','e2e-checkpoint','e2e-corrupt','e2e-acfsize','e2e-multiloc','updatecheck','e2e-offthread','ramp','lancache','e2e-mirrors','e2e-staging','e2e-perdepot','e2e-growth','e2e-offthread-hash','e2e-prealloc','e2e-cdnrefresh','e2e-stagereuse','e2e-excludedirs','tuning'].map(s => ['steampipe-engine',s]),
];
// verify-steampipe-audit/lancache described the old *dead* switch. Its current
// replacement is verify-steampipe-engine/lancache above (includes opt-out).
if (process.argv.includes('--packaged')) suites.push(['store','packaged'], ['tuning','packaged']);
const prior = process.argv.includes('--failed-only') && fs.existsSync(output) ? JSON.parse(fs.readFileSync(output)) : [];
const results = prior.filter(r => r.exitCode === 0);
fs.mkdirSync(path.dirname(output), { recursive: true });
for (const [file, suite] of suites) {
  if (results.some(r => r.file === file && r.suite === suite)) continue;
  const start = Date.now();
  const run = spawnSync(process.execPath, [`dev/verify-${file}.mjs`, suite], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  const row = { file, suite, exitCode: run.status, seconds: (Date.now() - start) / 1000, stdout: run.stdout, stderr: run.stderr, error: run.error?.message };
  results.push(row); fs.writeFileSync(output, JSON.stringify(results, null, 2));
  console.log(`${run.status === 0 ? 'PASS' : 'FAIL'} ${file}/${suite} (${row.seconds}s)`);
  if (run.status !== 0) console.log(String(run.stdout).slice(-2500) + String(run.stderr).slice(-2500));
}
process.exitCode = results.some(r => r.exitCode !== 0) ? 1 : 0;
