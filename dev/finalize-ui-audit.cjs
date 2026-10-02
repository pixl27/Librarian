// Verify observed results and the exact packaged sources, then write the audit.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.LIBRARIAN_TEST_OUTPUT || path.join(root, 'audits/2026-09-11/ui-optimization'));
const read = name => JSON.parse(fs.readFileSync(path.join(output, name), 'utf8').replace(/^\uFEFF/, ''));
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function main() {
  const build = read('build-result.json');
  assert.equal(build.exitCode, 0);
  const before = read('before-ui.json'), after = read('after-ui.json'), packaged = read('packaged-ui.json');
  for (const report of [after, packaged]) {
    assert(!report.fatal, report.fatal);
    assert.equal(report.errors.length, 0);
    assert(report.checks.length >= 40 && report.checks.every(check => check.ok));
  }
  const sourceSmoke = read('electron-smoke.json'), packagedSmoke = read('packaged-smoke.json');
  for (const report of [sourceSmoke, packagedSmoke]) {
    assert(!report.fatal, report.fatal);
    assert.equal(report.errors.length, 0);
    assert.equal(report.checks.length, 36);
  }
  for (const name of ['ui-source', 'smoke-source', 'ui-packaged', 'smoke-packaged']) assert.equal(read(name + '-exit.json').exitCode, 0);
  const reliability = read('reliability-results.json');
  assert(reliability.results.length && reliability.results.every(check => check.ok));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const archive = path.join(root, 'dist/win-unpacked/resources/app.asar');
  const executable = path.join(root, `dist/Librarian ${manifest.version}.exe`);
  const sources = ['main.js', 'preload.js', ...walk(path.join(root, 'src')).map(file => path.relative(root, file))];
  const mismatches = sources.filter(file => !fs.readFileSync(path.join(root, file)).equals(asar.extractFile(archive, file)));
  assert.deepEqual(mismatches, []);
  const packagedManifest = JSON.parse(asar.extractFile(archive, 'package.json'));
  assert.equal(packagedManifest.version, manifest.version);
  assert.equal(packagedManifest.main, manifest.main);
  const info = fs.statSync(executable);
  assert(info.size > 100 * 1024 * 1024);
  assert(info.mtimeMs >= Date.parse(build.startedAt));
  assert(info.mtimeMs >= fs.statSync(archive).mtimeMs);
  const changed = walk(path.join(output, 'before')).map(file => path.relative(path.join(output, 'before'), file))
    .filter(file => !fs.readFileSync(path.join(output, 'before', file)).equals(fs.readFileSync(path.join(root, file))));
  const layouts = after.layouts.map(layout => {
    const old = before.layouts.find(item => item.width === layout.width && item.height === layout.height && item.zoom === layout.zoom);
    return { window: `${layout.width}x${layout.height}`, zoom: layout.zoom, beforeGridHeightCssPx: old.gridHeight, afterGridHeightCssPx: layout.gridHeight, gainPercent: (layout.gridHeight / old.gridHeight - 1) * 100 };
  });
  const report = {
    completedAt: new Date().toISOString(), build,
    portable: { path: executable, bytes: info.size, modifiedAt: info.mtime.toISOString(), sha256: await hash(executable) },
    archive: { path: archive, sha256: await hash(archive), matchedSourceFiles: sources.length, mismatches },
    checks: { sourceUi: after.checks.length, packagedUi: packaged.checks.length, sourceElectron: sourceSmoke.checks.length, packagedElectron: packagedSmoke.checks.length, reliability: reliability.results.length, rendererErrors: 0 },
    measurements: { before: before.metrics, after: after.metrics, layouts },
    changedFiles: changed,
    scope: 'Renderer performance, library controls, keyboard/dialog focus, desktop and Big Picture controller lifecycle. Backend algorithms unchanged.',
    limits: ['Synthetic controller input, not physical controller hardware validation.', 'Renderer timing fixture excludes scanning, networking, artwork downloads and gameplay. No FPS or whole-process CPU benchmark.', 'Original baseline DLSS errors came from an incomplete mock status response, corrected in the test backend; they are not classified as production defects.', 'Native DLSS payloads, real games, actual downloads and real user settings were not modified by validation.'],
  };
  fs.writeFileSync(path.join(output, 'final-validation.json'), JSON.stringify(report, null, 2));
  const r = value => Number(value).toFixed(1);
  const markdown = `# Librarian UI and performance audit — 11 September 2026

Implemented and built in the existing Librarian workspace. Source snapshots are in \`before/\`; this workspace does not have Git metadata.

## Changes

- Reorganized the library into a compact heading/action row and a separate filter/display toolbar, retaining its existing visual theme. Scan is a secondary action; Add Game remains primary.
- Added Ctrl+F, an accessible clear-filter button, helpful no-match states for favorites and collections, explicit layout/density toggle states, and result announcements.
- Moved pagination out of the scrolling cover grid. The page range and Previous/Next controls stay reachable, clamp correctly when the collection shrinks, and focus the first game on page changes.
- Preserved keyed card reuse and the existing 160-card bound. Removed redundant favorite DOM writes, unchanged count animations, repeated cascade indexing, and an unused peak-playtime dependency from tile signatures.
- Fixed Shift+Enter to launch once without opening details. Nested button activation stays independent. Added dialog ownership to global shortcuts and controller navigation; shortcut help now traps focus, has a close button and restores focus on dismissal.
- Fixed rapid command-palette reopen and pending input timers. Controller A now activates its selected result.
- Stopped desktop and Big Picture controller polling when no controller is connected or the document is hidden. Connection, visibility, preference and Big Picture transitions restart only the appropriate loop.
- Made burst-animation cleanup idempotent so timeout and animation completion cannot decrement the active count twice.

## Measured comparison

Real Electron ${after.versions.electron}, isolated backend, 1,000 synthetic games, 160 rendered cards. Twenty unchanged refreshes per sample. These are renderer timings, not gameplay FPS or whole-app CPU measurements.

| Measurement | Before | After |
| --- | ---: | ---: |
| Tile subtree mutations across 20 unchanged refreshes | ${before.metrics.library.refreshMutations} | ${after.metrics.library.refreshMutations} |
| Median unchanged grid refresh | ${r(before.metrics.library.refreshMedianMs)} ms | ${r(after.metrics.library.refreshMedianMs)} ms |
| First 1,000-game fixture render | ${r(before.metrics.library.initialMs)} ms | ${r(after.metrics.library.initialMs)} ms |
| Controller polls over 350 ms with no controller after a preference change | ${before.metrics.idleControllerPolls} | ${after.metrics.idleControllerPolls} |

| Window / zoom | Game area before (CSS px high) | After | Gain |
| --- | ---: | ---: | ---: |
${layouts.map(layout => `| ${layout.window} / ${layout.zoom * 100}% | ${r(layout.beforeGridHeightCssPx)} | ${r(layout.afterGridHeightCssPx)} | ${r(layout.gainPercent)}% |`).join('\n')}

## Verification

${report.checks.sourceUi} source UI checks and ${report.checks.packagedUi} packaged UI checks passed. ${report.checks.sourceElectron} production Electron smoke checks passed on each of the source and packaged app, including the existing DLSS FG updater. ${report.checks.reliability} reliability checks passed. Zero renderer errors in the final source and packaged runs. ${sources.length} packaged source files match the working sources byte-for-byte.

Screenshots: \`before-library-*.png\`, \`after-library-*.png\`, \`after-library-list-1024-125.png\`, \`after-settings.png\`, and \`after-bigpicture.png\`. The original baseline's null DLSS status errors were a missing mock response, not an identified production defect; the fixture was corrected before the final detail-view tests.

Reproduce from the project root:

\`npm run test:ui\` — source renderer checks.\n
\`node dev/run-electron-check.cjs smoke\` — production Electron smoke.\n
\`node dev/build-portable.cjs\` — Windows x64 portable build, publish disabled.\n
\`node dev/run-electron-check.cjs ui --packaged\` and \`node dev/run-electron-check.cjs smoke --packaged\` — packaged checks.\n
\`node dev/finalize-ui-audit.cjs\` — verify evidence and packaged source identity.

The baseline mode of \`dev/verify-ui.cjs\` is for recording the source state before an edit; it does not restore snapshots.

## Artifact

\`${executable}\`\n
${info.size} bytes. SHA-256: \`${report.portable.sha256}\`.

## Practical limits

Controller events were simulated. Physical controller mapping and in-game FPS were not benchmarked. Tests used local generated artwork and blocked external requests. No real games were launched or updated. Settings and backend behavior beyond the tested flows have not been claimed to be fully audited.
`;
  fs.writeFileSync(path.join(output, 'README.md'), markdown);
  console.log(JSON.stringify({ portable: report.portable, checks: report.checks, matchedSourceFiles: sources.length, changedFiles: changed }, null, 2));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
