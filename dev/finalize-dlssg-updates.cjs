// Record only observed build/test results. This never scans or updates games.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'audits/2026-09-11/dlssg-updates');
const read = file => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8').replace(/^\uFEFF/, ''));
const build = read('build-result.json');
assert.equal(build.exitCode, 0, 'The portable build has not completed successfully');
const source = read('electron-smoke.json'), packaged = read('packaged-smoke.json');
for (const report of [source, packaged]) {
  assert(!report.fatal, report.fatal);
  assert.equal(report.errors.length, 0);
  assert.equal(report.checks.length, 36);
}
assert.equal(read('packaged-smoke-result.json').exitCode, 0);
const upstream = read('upstream-check.json'), updates = read('update-tests.json');
assert.equal(updates.failed, 0); assert.equal(updates.passed, 20);
const integrity = JSON.parse(fs.readFileSync(path.join(root, 'audits/2026-09-11/dlssg-updater/integrity-results.json'), 'utf8'));
assert.equal(integrity.results.length, 6); assert(integrity.results.every(row => row.ok));
const reliability = read('reliability-results.json'), custom = read('custom-update-results.json');
assert(reliability.results.every(row => row.ok)); assert(custom.results.every(row => row.ok));
const regressions = read('regression-results.json');
assert.equal(regressions.length, 39); assert(regressions.every(row => row.exitCode === 0));
const sources = read('package-source-check.json');
assert(sources.length >= 70); assert(sources.every(row => row.same));
const artifact = path.join(root, 'dist/Librarian 1.1.0.exe');
const info = fs.statSync(artifact);
assert(info.isFile() && info.size > 100 * 1024 * 1024);
assert(info.mtimeMs > Date.parse('2026-09-11T16:30:00Z'), 'The artifact is stale');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {
  completedAt: new Date().toISOString(),
  build,
  portable: { path: artifact, bytes: info.size, modifiedAt: info.mtime.toISOString(), sha256: sha256(artifact) },
  appArchive: { path: path.join(root, 'dist/win-unpacked/resources/app.asar'), sha256: sha256(path.join(root, 'dist/win-unpacked/resources/app.asar')) },
  checks: { updater: updates.passed, additionalIntegrity: integrity.results.length, reliability: reliability.results.length,
    customUpdates: custom.results.length, regressionSuites: regressions.length, sourceElectron: source.checks.length,
    packagedElectron: packaged.checks.length, rendererErrors: 0, packagedSourceFilesMatching: sources.length },
  upstreamCheck: { checkedAt: upstream.checkedAt, commit: upstream.release.commit, newer: upstream.newer,
    payloadDownloaded: upstream.payloadDownloaded, gameFilesChanged: upstream.gameFilesChanged },
  scope: 'Existing Librarian-managed DLSS FG proxy/INI installations across library sources, including Custom games.',
  safety: { actualGameUpdatesRun: false, actualGamesLaunched: false, fixturePayloadsExecutable: false },
  limitations: ['No whole-drive or unmanaged-mod adoption.', 'Native NVIDIA DLSS libraries are preserved, not updated.', 'Actual gameplay compatibility and FPS were not tested.'],
};
fs.writeFileSync(path.join(directory, 'final-validation.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
