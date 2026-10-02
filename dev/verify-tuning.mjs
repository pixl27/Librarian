#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Gate runner for the Tuning round (GATES-tuning.md).
//
//   node dev/verify-tuning.mjs <suite>
//
//   build        compile the DLL, injector, tune helper and D3D11 test app
//   e2e-stats    e2e-limiter  e2e-queue  e2e-failsafe  e2e-present1  helper
//                the synthetic suites in dev/tuning-e2e.mjs, plain Node
//   realgame     dev/tuning-realgame.js under the shipped Electron
//   integrity    the shipped sources agree with each other
//   self-test    integrity fails on a copy with each defect reintroduced
//   pack         electron-builder --dir; the asar and resources carry the work
//
// Prints `OK <suite>` and exits 0 only when every assertion passed. The
// English gate titles describe the outcome; this file is the oracle, and
// every check below says what it actually measures.
// ═══════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, writeFileSync, rmSync, mkdirSync, cpSync, mkdtempSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const ROOT = resolve(opt('--root', join(HERE, '..')));
const suite = args.find((a) => !a.startsWith('--') && a !== opt('--root', ''));

const read = (root, p) => readFileSync(join(root, p), 'utf8');
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

function fail(msg) { console.error(`FAIL ${msg}`); process.exit(1); }
function ok(suiteName) { console.log(`OK ${suiteName}`); process.exit(0); }

function run(cmd, cmdArgs, { cwd = ROOT, timeout = 600000, env = process.env } = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8', timeout, env, maxBuffer: 64 * 1024 * 1024, shell: false });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' };
}

// ── build ──────────────────────────────────────────────────────────
function suiteBuild() {
  for (const [label, script, extra] of [
    ['dll + injector', 'native/achoverlay/build.js', []],
    ['tune helper', 'native/tune/build.js', []],
    ['d3d11 test app', 'native/tune/build.js', ['--testapp', 'dev/bin']],
  ]) {
    const r = run(process.execPath, [join(ROOT, script), ...extra]);
    process.stdout.write(r.out);
    if (r.status !== 0) fail(`${label} did not build`);
  }
  for (const f of [
    'deps/librarian/librarian_achoverlay.dll', 'deps/librarian/librarian_inject.exe',
    'deps/librarian/librarian_tune.exe', 'dev/bin/librarian_d3d11test.exe',
  ]) {
    if (!existsSync(join(ROOT, f))) fail(`missing artefact ${f}`);
    if (statSync(join(ROOT, f)).size < 20000) fail(`artefact suspiciously small: ${f}`);
  }
  // The DLL must carry the tuning half: its export table is the overlay's,
  // but the strings it logs are unmistakable.
  const dll = readFileSync(join(ROOT, 'deps/librarian/librarian_achoverlay.dll'), 'latin1');
  if (!dll.includes('[tuning] on: flags')) fail('the built DLL does not contain the tuning half');
  if (!dll.includes('ExecuteCommandLists hooked')) fail('the built DLL does not contain the D3D12 queue hook');
  ok('build');
}

// ── synthetic suites ───────────────────────────────────────────────
function suiteE2E(name) {
  const r = run(process.execPath, [join(ROOT, 'dev', 'tuning-e2e.mjs'), name], { timeout: 420000 });
  process.stdout.write(r.out);
  if (r.status !== 0) fail(`${name} exited ${r.status}`);
  if (!new RegExp(`(^|\\n)OK ${name}\\s*$`).test(r.stdout.trim() + '\n')) fail(`${name} did not print its success line`);
  ok(name);
}

// ── real game ──────────────────────────────────────────────────────
function suiteRealgame() {
  if (!existsSync(ELECTRON)) fail('electron is not installed; run npm install first');
  const r = run(ELECTRON, [join(ROOT, 'dev', 'tuning-realgame.js'), ...args.filter((a) => a !== 'realgame')], { timeout: 600000 });
  process.stdout.write(r.out);
  // The gate checker keeps only a prefix of the output; the whole run stays
  // readable here, so a failure under it can still be diagnosed.
  try { mkdirSync(join(ROOT, 'dev', 'bin'), { recursive: true }); writeFileSync(join(ROOT, 'dev', 'bin', 'realgame-last.log'), r.out); } catch { /* not worth failing over */ }
  if (r.status !== 0) fail(`realgame exited ${r.status}`);
  if (!/(^|\n)OK realgame\s*$/.test(r.stdout.trim() + '\n')) fail('realgame did not print its success line');
  ok('realgame');
}

// ── integrity ──────────────────────────────────────────────────────
// Every id the page script addresses. Kept here, in the markup and in the
// script; the check is that all three agree.
const TN_IDS = [
  'tn-enabled', 'tn-status', 'tn-queue', 'tn-queue-hint', 'tn-limiter', 'tn-fps', 'tn-fps-hint',
  'tn-affinity', 'tn-topology', 'tn-priority', 'tn-refresh', 'tn-display', 'tn-power', 'tn-power-hint',
  'tn-game-select', 'tn-override', 'tn-live-api', 'tn-m-fps', 'tn-m-fps-sub', 'tn-m-low1', 'tn-m-low1-sub',
  'tn-m-frame', 'tn-m-frame-sub', 'tn-m-lat', 'tn-m-lat-sub', 'tn-m-present', 'tn-m-present-sub',
  'tn-m-waits', 'tn-m-waits-sub', 'tn-spark', 'tn-applied', 'tn-ab-seconds', 'tn-ab-run', 'tn-ab-cancel',
  'tn-ab-progress', 'tn-ab-bar-fill', 'tn-ab-phase', 'tn-ab-body', 'tn-ab-note',
];
const BRIDGE = ['tuningState', 'tuningSetProfile', 'tuningSetOverride', 'tuningSetLive', 'tuningRunAB', 'tuningCancelAB', 'onTuningStats', 'onTuningSession', 'onTuningAB'];
const PARSE = [
  'main.js', 'preload.js', 'src/core/tuning.js', 'src/core/launcher.js', 'src/core/settingsStore.js',
  'src/js/app.js', 'src/js/enhance.js', 'src/js/store.js', 'src/js/bigpicture.js', 'src/js/kinetic.js', 'src/js/trailer.js', 'src/js/tuning.js',
];

function integrity(root) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };

  const html = read(root, 'src/index.html');
  const appJs = read(root, 'src/js/app.js');
  const kinetic = read(root, 'src/js/kinetic.js');
  const page = read(root, 'src/js/tuning.js');
  const css = read(root, 'src/styles/tuning.css');
  const store = read(root, 'src/core/settingsStore.js');
  const preload = read(root, 'preload.js');
  const main = read(root, 'main.js');
  const launcher = read(root, 'src/core/launcher.js');
  const core = read(root, 'src/core/tuning.js');
  const shared = read(root, 'native/achoverlay/tuning_shared.h');

  // Markup and wiring.
  need(/data-page="tuning"/.test(html), 'index.html: no nav tab for the tuning page');
  need(html.indexOf('data-page="tuning"') < html.indexOf('data-page="settings"'), 'index.html: tuning tab is not before settings');
  need(/id="page-tuning"/.test(html), 'index.html: no #page-tuning');
  need(/href="styles\/tuning\.css"/.test(html), 'index.html: tuning.css not linked');
  need(/src="js\/tuning\.js"/.test(html), 'index.html: tuning.js not loaded');
  need(html.indexOf('<script src="js/app.js">') < html.indexOf('<script src="js/tuning.js">'), 'index.html: tuning.js loads before app.js');
  for (const id of TN_IDS) {
    need(html.includes(`id="${id}"`), `index.html: #${id} missing`);
    need(page.includes(`#${id}`) || page.includes(`'${id}'`), `tuning.js: #${id} never addressed`);
  }
  need(/NAV_ORDER = \[[^\]]*'tuning'/.test(appJs), 'app.js: NAV_ORDER does not know the tuning page');
  need(kinetic.includes('#page-tuning'), 'kinetic.js: stagger table does not know the page');
  for (const cls of ['.tn-tile', '.tn-seg', '.tn-status', '.tn-table', '.tn-spark', '.tn-ab-bar']) {
    need(css.includes(cls), `tuning.css: no rule for ${cls}`);
  }
  need(css.split('{').length === css.split('}').length, 'tuning.css: unbalanced braces');

  // Settings.
  need(/^\s{2}tuning: \{/m.test(store), 'settingsStore.js: DEFAULTS has no tuning profile');
  need(/key === 'tuning'/.test(store), 'settingsStore.js: no sanitiser branch for tuning');
  for (const k of ['enabled', 'queue', 'limiter', 'fps', 'affinity', 'priority', 'refresh', 'power']) {
    need(new RegExp(`\\b${k}:`).test(store), `settingsStore.js: tuning.${k} absent`);
  }

  // Bridge: preload ↔ main, both directions.
  for (const b of BRIDGE) need(preload.includes(`${b}:`), `preload.js: ${b} not exposed`);
  const invoked = [...preload.matchAll(/ipcRenderer\.invoke\('(tuning:[^']+)'/g)].map((m) => m[1]);
  const handled = [...main.matchAll(/ipcMain\.handle\('(tuning:[^']+)'/g)].map((m) => m[1]);
  need(invoked.length >= 6, `preload.js: only ${invoked.length} tuning channels invoked`);
  for (const ch of invoked) need(handled.includes(ch), `main.js: no handler for ${ch}`);
  for (const ch of handled) need(invoked.includes(ch), `preload.js: handler ${ch} has no caller`);
  const events = [...preload.matchAll(/onIpc\('(tuning:[^']+)'/g)].map((m) => m[1]);
  for (const ev of ['tuning:stats', 'tuning:session', 'tuning:ab']) need(events.includes(ev), `preload.js: event ${ev} not exposed`);
  need(/webContents\.send\(`tuning:\$\{type\}`/.test(main), 'main.js: tuning events are not forwarded to the renderer');

  // Launcher.
  need(/require\('\.\/tuning'\)\.onLaunch\(/.test(launcher), 'launcher.js: tuning.onLaunch not called at spawn');
  need(/require\('\.\/tuning'\)\.onExit\(/.test(launcher), 'launcher.js: tuning.onExit not called at exit');
  need(launcher.indexOf('.onLaunch(') < launcher.indexOf('injectAchievementOverlay(child.pid'), 'launcher.js: config is not written before injection');
  need(/injectAchievementOverlay\(child\.pid, \{ force: tuned \}\)/.test(launcher), 'launcher.js: injection does not honour tuning');
  need(/if \(!force && settings\.get\('achievement_popups'\) === false\) return;/.test(launcher), 'launcher.js: forced injection is not honoured');

  // The two halves of the contract agree.
  const num = (re, text, what) => { const m = text.match(re); if (!m) { problems.push(`contract: ${what} not found`); return NaN; } return Number(m[1]); };
  need(num(/#define LIBRARIAN_TUNE_RING (\d+)/, shared, 'ring size (C)') === num(/const RING = (\d+);/, core, 'ring size (JS)'), 'contract: ring size differs');
  need(num(/#define LIBRARIAN_TUNE_VERSION\s+(\d+)/, shared, 'version (C)') === num(/const VERSION = (\d+);/, core, 'version (JS)'), 'contract: version differs');
  need(num(/#define LIBRARIAN_TUNE_STATS_HEADER (\d+)/, shared, 'header size (C)') === num(/const STATS_HEADER = (\d+);/, core, 'header size (JS)'), 'contract: header size differs');
  // Anchored to the struct right before the name: the header holds three.
  const frameFields = (shared.match(/typedef struct \{((?:(?!typedef struct)[\s\S])*?)\} librarian_tune_frame_t;\s*\/\* (\d+) bytes \*\//) || []);
  need(frameFields[2] && Number(frameFields[2]) === num(/const FRAME_BYTES = (\d+);/, core, 'frame bytes (JS)'), 'contract: frame entry size differs');
  if (frameFields[1]) {
    const floats = (frameFields[1].match(/^\s*float\s/gm) || []).length;
    const u8 = (frameFields[1].match(/^\s*uint8_t\s/gm) || []).length;
    const u16 = (frameFields[1].match(/^\s*uint16_t\s/gm) || []).length;
    need(floats * 4 + u8 + u16 * 2 === Number(frameFields[2]), `contract: frame struct fields sum to ${floats * 4 + u8 + u16 * 2}, comment says ${frameFields[2]}`);
  }
  need(/0x4E54424C/.test(shared) && /0x4E54424C/.test(core), 'contract: config magic differs');
  need(/0x5354424C/.test(shared) && /0x5354424C/.test(core), 'contract: stats magic differs');

  // Everything parses.
  for (const f of PARSE) {
    const r = spawnSync(process.execPath, ['--check', join(root, f)], { encoding: 'utf8' });
    if (r.status !== 0) problems.push(`${f} does not parse: ${(r.stderr || '').split('\n')[0]}`);
  }
  return problems;
}

function suiteIntegrity() {
  const problems = integrity(ROOT);
  for (const p of problems) console.error(`  ${p}`);
  if (problems.length) fail(`${problems.length} integrity problem(s)`);
  console.log(`  ${TN_IDS.length} ids, ${BRIDGE.length} bridge calls, ${PARSE.length} files parsed`);
  ok('integrity');
}

// ── self-test ──────────────────────────────────────────────────────
const CHECKED_FILES = [
  'src/index.html', 'src/js/app.js', 'src/js/kinetic.js', 'src/js/tuning.js', 'src/styles/tuning.css',
  'src/core/settingsStore.js', 'src/core/tuning.js', 'src/core/launcher.js', 'preload.js', 'main.js',
  'native/achoverlay/tuning_shared.h',
  'src/js/enhance.js', 'src/js/store.js', 'src/js/bigpicture.js', 'src/js/trailer.js',
];

function suiteSelfTest() {
  const base = mkdtempSync(join(tmpdir(), 'librarian-tuning-selftest-'));
  const copy = (name) => {
    const dir = join(base, name);
    for (const f of CHECKED_FILES) { mkdirSync(dirname(join(dir, f)), { recursive: true }); cpSync(join(ROOT, f), join(dir, f)); }
    return dir;
  };
  const sabotage = (label, file, from, to) => {
    const dir = copy(label);
    const p = join(dir, file);
    const text = readFileSync(p, 'utf8');
    if (!text.includes(from)) fail(`self-test: cannot sabotage '${label}' — '${from}' not in ${file}`);
    writeFileSync(p, text.replace(from, to));
    const problems = integrity(dir);
    if (!problems.length) fail(`self-test: integrity did not notice '${label}'`);
    console.log(`  caught ${label}: ${problems[0]}`);
  };
  try {
    const clean = copy('clean');
    if (integrity(clean).length) fail('self-test: the clean copy does not pass integrity');
    sabotage('missing nav tab', 'src/index.html', 'data-page="tuning"', 'data-page="tuning-gone"');
    sabotage('script not loaded', 'src/index.html', '<script src="js/tuning.js"></script>', '');
    sabotage('stylesheet not linked', 'src/index.html', '<link rel="stylesheet" href="styles/tuning.css">', '');
    sabotage('control id removed', 'src/index.html', 'id="tn-ab-run"', 'id="tn-ab-run-x"');
    sabotage('NAV_ORDER forgets the page', 'src/js/app.js', "'tuning', 'settings'", "'settings'");
    sabotage('kinetic forgets the page', 'src/js/kinetic.js', "['#page-tuning .settings-panel', '.settings-section'],", '');
    sabotage('handler removed', 'main.js', "ipcMain.handle('tuning:runAB'", "ipcMain.handle('tuning:runAB-gone'");
    sabotage('bridge call removed', 'preload.js', 'tuningCancelAB:', 'tuningCancelAB_:');
    sabotage('profile default removed', 'src/core/settingsStore.js', '  tuning: {', '  tuning_: {');
    sabotage('ring size drift', 'src/core/tuning.js', 'const RING = 8192;', 'const RING = 4096;');
    sabotage('frame size drift', 'src/core/tuning.js', 'const FRAME_BYTES = 28;', 'const FRAME_BYTES = 20;');
    sabotage('config not written before injection', 'src/core/launcher.js', "injectAchievementOverlay(child.pid, { force: tuned });", 'injectAchievementOverlay(child.pid);');
    sabotage('exit hook removed', 'src/core/launcher.js', "require('./tuning').onExit(child.pid);", '');
    sabotage('page script broken', 'src/js/tuning.js', "(function () {\n  'use strict';", "(function () {\n  'use strict';\n  let let;");
    sabotage('css unbalanced', 'src/styles/tuning.css', '#page-tuning .tn-panel {', '#page-tuning .tn-panel {{');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  ok('self-test');
}

// ── pack ───────────────────────────────────────────────────────────
function suitePack() {
  // Into its own folder: dist/win-unpacked is where the user's installed copy
  // runs from, and a build cannot replace files under a running application.
  // What is checked is the same either way — that the packaged tree carries
  // this round's work.
  const outDir = join(ROOT, 'dist', 'tuning-check');
  const r = run('cmd', ['/c', 'npm', 'run', 'pack', '--', `--config.directories.output=${outDir}`], { timeout: 900000 });
  process.stdout.write(r.out.split('\n').slice(-15).join('\n'));
  if (r.status !== 0) fail(`electron-builder --dir exited ${r.status}`);
  const unpacked = join(outDir, 'win-unpacked');
  verifyPackagedTree(unpacked);
  ok('pack');
}

function verifyPackagedTree(unpacked) {
  const asar = join(unpacked, 'resources', 'app.asar');
  if (!existsSync(asar)) fail('no app.asar produced');
  // The asar header is a JSON directory at the front of the file; the file
  // names appear there verbatim.
  const head = readFileSync(asar).subarray(0, 4 * 1024 * 1024).toString('latin1');
  for (const name of ['"tuning.js"', '"tuning.css"']) if (!head.includes(name)) fail(`asar does not list ${name}`);
  for (const f of ['librarian_achoverlay.dll', 'librarian_inject.exe', 'librarian_tune.exe']) {
    const p = join(unpacked, 'resources', 'deps', 'librarian', f);
    if (!existsSync(p)) fail(`packaged resources lack ${f}`);
    const src = statSync(join(ROOT, 'deps', 'librarian', f));
    if (statSync(p).size !== src.size) fail(`packaged ${f} differs in size from the built one`);
  }
  const dll = readFileSync(join(unpacked, 'resources', 'deps', 'librarian', 'librarian_achoverlay.dll'), 'latin1');
  if (!dll.includes('[tuning] on: flags')) fail('packaged DLL lacks the tuning half');
}

const SUITES = {
  build: suiteBuild,
  'e2e-stats': () => suiteE2E('e2e-stats'),
  'e2e-limiter': () => suiteE2E('e2e-limiter'),
  'e2e-queue': () => suiteE2E('e2e-queue'),
  'e2e-failsafe': () => suiteE2E('e2e-failsafe'),
  'e2e-present1': () => suiteE2E('e2e-present1'),
  helper: () => suiteE2E('helper'),
  realgame: suiteRealgame,
  integrity: suiteIntegrity,
  'self-test': suiteSelfTest,
  pack: suitePack,
  packaged: () => { verifyPackagedTree(join(ROOT, 'dist', 'win-unpacked')); ok('packaged'); },
};

if (!SUITES[suite]) {
  console.error(`usage: node dev/verify-tuning.mjs <${Object.keys(SUITES).join('|')}>`);
  process.exit(2);
}
SUITES[suite]();
