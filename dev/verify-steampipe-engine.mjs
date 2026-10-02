#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Gate runner for the SteamPipe engine work.
//
//   node dev/verify-steampipe-engine.mjs <suite>
//
// Most suites are end-to-end and live in dev/steampipe-e2e.mjs; this launches
// them under the runtime the application actually ships — Electron's Node, via
// ELECTRON_RUN_AS_NODE — because the system Node on this machine has neither
// zstd nor a loadable @napi-rs/lzma, and a test that quietly skipped the codec
// most depots use would be measuring nothing.
//
// `integrity` and `self-test` run here, in plain Node: one reads the sources,
// the other sabotages copies of them and requires the e2e suites to notice.
// ═══════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, writeFileSync, rmSync, mkdirSync, cpSync, mkdtempSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ELECTRON_POSIX = join(ROOT, 'node_modules', 'electron', 'dist', 'electron');

function electronBinary() {
  if (existsSync(ELECTRON)) return ELECTRON;
  if (existsSync(ELECTRON_POSIX)) return ELECTRON_POSIX;
  return null;
}

/** Run one e2e suite, optionally against a sabotaged copy of the repository. */
function runE2E(suite, { root = ROOT, timeout = 300000 } = {}) {
  const bin = electronBinary();
  if (!bin) {
    return { ok: false, output: 'electron is not installed; run npm install before verifying' };
  }
  const res = spawnSync(bin, [join(root, 'dev', 'steampipe-e2e.mjs'), suite], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  return {
    ok: res.status === 0 && new RegExp(`(^|\\n)OK ${suite}\\s*$`).test((res.stdout || '').trim() + '\n'),
    output,
    status: res.status,
  };
}

const E2E_SUITES = [
  'e2e-fresh', 'e2e-resume', 'e2e-update', 'e2e-repair', 'e2e-guards', 'e2e-encrypted',
  'e2e-offthread', 'ramp', 'lancache', 'e2e-mirrors', 'e2e-staging',
  'e2e-perdepot', 'e2e-multiloc', 'e2e-persist', 'e2e-checkpoint',
  'e2e-update-replaced-file',
];

const ROUND2_SUITES = [
  'e2e-custom-update',
  'e2e-acfsize', 'e2e-corrupt', 'e2e-growth', 'e2e-offthread-hash', 'e2e-prealloc',
  'e2e-cdnrefresh', 'e2e-stagereuse', 'e2e-excludedirs', 'tuning', 'updatecheck',
];

const ROUND3_SUITES = [
  'e2e-writeorder', 'e2e-home', 'e2e-slowlink', 'e2e-diskfull', 'e2e-workerexit',
  'hostpool', 'e2e-stage-parallel',
];

// ════════════════════════════════════════════════════════════════
// integrity — properties of the tree itself
// ════════════════════════════════════════════════════════════════

function suiteIntegrity() {
  const fail = [];

  // Every source file the work touched has to parse.
  const parsed = [
    'src/core/steamPipe.js', 'src/core/chunkCodec.js', 'src/core/chunkWorker.js',
    'src/core/settingsStore.js', 'src/core/updateChecker.js', 'src/js/app.js',
    'main.js', 'preload.js',
  ];
  for (const rel of parsed) {
    const res = spawnSync(process.execPath, ['--check', join(ROOT, rel)], { encoding: 'utf8' });
    if (res.status !== 0) fail.push(`integrity: ${rel} does not parse — ${(res.stderr || '').split('\n')[0]}`);
  }

  const pkg = JSON.parse(read('package.json'));
  const unpack = pkg.build?.asarUnpack || [];

  // A worker thread cannot be spawned from inside the asar, which is why the
  // old LZMA worker was unpacked. The same has to hold for its replacement and
  // for the codec it requires.
  for (const needed of ['src/core/chunkWorker.js', 'src/core/chunkCodec.js']) {
    if (!unpack.includes(needed)) {
      fail.push(`integrity: ${needed} is not in asarUnpack, so it will not exist as a real file in a packaged build`);
    }
  }
  if (unpack.includes('src/core/lzmaWorker.js') && !existsSync(join(ROOT, 'src/core/lzmaWorker.js'))) {
    fail.push('integrity: asarUnpack still lists src/core/lzmaWorker.js, which no longer exists');
  }

  // The engine must not reference a worker file that is not shipped.
  const pipe = read('src/core/steamPipe.js');
  const workerRefs = [...pipe.matchAll(/__dirname,\s*'([^']+\.js)'/g)].map(m => m[1]);
  for (const ref of workerRefs) {
    if (!existsSync(join(ROOT, 'src/core', ref))) {
      fail.push(`integrity: steamPipe spawns ${ref}, which does not exist`);
    }
  }

  // Any download setting the UI writes must be read by something. A stored,
  // displayed toggle that no code consults is exactly the bug that made "Use
  // Lancache" do nothing for as long as it existed.
  const app = read('src/js/app.js');
  const core = ['src/core/steamPipe.js', 'src/core/settingsStore.js', 'src/core/gameManager.js']
    .map((p) => { try { return read(p); } catch { return ''; } }).join('\n');
  const written = [...app.matchAll(/setSetting\('(download_[a-z_]+|use_lancache|steam_cell_id|validate_fresh_downloads)'/g)]
    .map(m => m[1]);
  for (const key of [...new Set(written)]) {
    if (!new RegExp(`get\\('${key}'\\)`).test(core)) {
      fail.push(`integrity: the settings UI writes ${key}, but no engine code ever reads it`);
    }
  }

  // The settings default and the migration have to agree, or existing users
  // and new ones end up on different behaviour.
  const settings = read('src/core/settingsStore.js');
  if (!/use_lancache:\s*true/.test(settings)) {
    fail.push('integrity: use_lancache no longer defaults on, so new installs and migrated ones would differ');
  }
  if (!/from < 5[\s\S]{0,200}?data\.use_lancache = true/.test(settings)) {
    fail.push('integrity: no migration turns Lancache on for an existing settings file, so the new default never reaches them');
  }
  const version = Number(/const SETTINGS_VERSION = (\d+)/.exec(settings)?.[1]);
  if (!(version >= 5)) fail.push(`integrity: SETTINGS_VERSION is ${version}; the Lancache migration will never run`);

  // The bandwidth limit has to exist end to end, or it is another dead toggle.
  if (!/id="inp-speed-limit"/.test(read('src/index.html'))) {
    fail.push('integrity: the bandwidth limit has no control in the settings UI');
  }
  if (!/download_speed_limit/.test(settings)) {
    fail.push('integrity: download_speed_limit is not a stored setting');
  }

  return fail;
}

// ════════════════════════════════════════════════════════════════
// self-test — every e2e suite must fail against a broken engine
//
// Each entry copies the repository, breaks one specific thing, and requires the
// named suite to notice. A test that passes against a sabotaged engine is not
// measuring what its gate claims.
// ════════════════════════════════════════════════════════════════

const SABOTAGE = [
  {
    suite: 'e2e-fresh',
    what: 'writes each chunk one byte past its offset',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'await handle.write(data, 0, data.length, target.offset);',
      'await handle.write(data, 0, data.length, target.offset + 1);'),
  },
  {
    suite: 'e2e-resume',
    what: 'persists chunks before their bytes are flushed',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'const batch = pendingDurable.splice(0);',
      'const batch = pendingDurable.splice(0); for (let i = 0; i < 40; i++) batch.push(Math.floor(total * 0.99));'),
  },
  {
    suite: 'e2e-update',
    what: 'leaves behind the files the new build drops',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'if (priorDepotPaths.size && !unresolvedDepots.size) {',
      'if (false && priorDepotPaths.size && !unresolvedDepots.size) {'),
  },
  {
    suite: 'e2e-repair',
    what: 'stops verifying what is already on disk',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'if (validateExisting || unresolvedDepots.has(group.depotId)) {',
      'if (false) {'),
  },
  {
    suite: 'e2e-guards',
    what: 'counts engine scratch as a game file again',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'function stateFilePath(dir) { return path.join(dir, MARKER_DIR, STATE_FILENAME); }',
      'function stateFilePath(dir) { return path.join(dir, STATE_FILENAME); }'),
  },
  {
    suite: 'e2e-offthread',
    what: 'decodes on the calling thread instead of a worker',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'if (!chunkPool && !chunkPoolFailed) {',
      'if (false) {'),
  },
  {
    suite: 'ramp',
    what: 'restores the one-way ramp that could never back off',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'if (lastAdd > 0 && rate < rateBeforeAdd * regressRatio) {',
      'if (false) {'),
  },
  {
    suite: 'lancache',
    what: 'stops preferring a detected Lancache',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'const preferred = this.entries.find(e => e.preferred && e.fails < HOST_FAIL_LIMIT);',
      'const preferred = null;'),
  },
  {
    suite: 'e2e-mirrors',
    what: 'ignores Retry-After and never abandons a stalled request',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'const stallTimer = setTimeout(() => { stalled = true; ac.abort(); }, budgetMs);',
      'const stallTimer = setTimeout(() => {}, budgetMs);'),
  },
  {
    suite: 'e2e-staging',
    what: 'stages every reusable chunk again, in danger or not',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'const threatened = sources.find(sourceAtRisk);',
      'const threatened = sources[0];'),
  },
  {
    suite: 'e2e-perdepot',
    what: 'abandons the whole diff when any one depot cannot be pinned',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'if (index.size) priorIndex = index;',
      'if (index.size && !unresolvedDepots.size) priorIndex = index;'),
  },
  {
    suite: 'e2e-multiloc',
    what: 'keeps only the first recorded location for each chunk',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'if (sources.length < MAX_SOURCES) {',
      'if (sources.length < 1) {'),
  },
  {
    suite: 'e2e-persist',
    what: 'defers persistence to the workers unwinding, as it used to',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'persistNow = () => {',
      'persistNow = null && (() => {'),
  },
  {
    suite: 'e2e-checkpoint',
    what: 'checkpoints on elapsed time only',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      '|| (pendingDurable.length >= STATE_SAVE_CHUNKS);',
      '|| false;'),
  },
];

const SABOTAGE2 = [
  {
    suite: 'e2e-acfsize',
    what: 'writes the patch size into the ACF again',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'writeAcf(gameData, selectedDepots, destPath, installFolder, totalOriginalBytes, acfPath);',
      'writeAcf(gameData, selectedDepots, destPath, installFolder, totalBytes, acfPath);'),
  },
  {
    suite: 'e2e-corrupt',
    what: 'no longer holds a corrupt body against the mirror that served it',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'hosts.failed(servedBy, 2);',
      'void servedBy;'),
  },
  {
    suite: 'e2e-growth',
    what: 'skips the disk-space check for updates and repairs',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'checkGrowth(stagingPlan ? stagingPlan.wanted : 0);',
      'void stagingPlan;'),
  },
  {
    suite: 'e2e-offthread-hash',
    what: 'hashes on-disk data on the calling thread',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'return await chunkPool.verify(buf, sha);',
      'return { ok: shaVerify(buf, sha), data: buf };'),
  },
  {
    suite: 'e2e-prealloc',
    what: 'stops reserving files at their declared length',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'if (size < sizeHint) await handle.truncate(sizeHint);',
      'void size;'),
  },
  {
    suite: 'e2e-cdnrefresh',
    what: 'never asks the directory service again',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'void maybeRefreshHosts();',
      'void 0;'),
  },
  {
    suite: 'e2e-stagereuse',
    what: 'ignores the staging area an interrupted update left',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      "if (json.v !== 1 || json.sig !== manifestSig || !Array.isArray(json.entries)) return false;",
      'return false;'),
  },
  {
    suite: 'e2e-excludedirs',
    what: 'creates every declared directory whether or not anything in it survived the plan',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'if (excludedAncestors.has(dir) && !includedAncestors.has(dir)) { skippedDirs++; continue; }',
      'void 0;'),
  },
  {
    suite: 'tuning',
    what: 'never backs the checkpoint interval off',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'if (lastFlushMs > current / 2) return Math.min(max, current * 2);',
      'if (lastFlushMs > current / 2) return current;'),
  },
  {
    suite: 'updatecheck',
    what: 'ignores installed manifests when build ids cannot decide',
    apply: (root) => patch(root, 'src/core/updateChecker.js',
      "if (installed.length && remoteManifests && typeof remoteManifests === 'object') {",
      'if (false) {'),
  },
];

const SABOTAGE3 = [
  {
    suite: 'e2e-writeorder',
    what: 'writes every destination of a chunk the moment it arrives, however far ahead',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'work.sort((a, b) => (a.fileIdx - b.fileIdx) || (a.offset - b.offset));',
      'work.sort((a, b) => (a.group.targets[0].fileIdx - b.group.targets[0].fileIdx) || (a.group.targets[0].offset - b.group.targets[0].offset));'),
  },
  {
    suite: 'e2e-home',
    what: 'never reads a chunk back from a destination that already holds it',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'const held = await readHome(group);',
      'const held = null;'),
  },
  {
    suite: 'e2e-slowlink',
    what: 'times a request out on its total duration instead of on silence',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'const ab = await readBody(res, (n) => { idleTimer.refresh(); if (onBytes) onBytes(n); });',
      'const ab = await readBody(res, (n) => { if (onBytes) onBytes(n); });'),
  },
  {
    suite: 'e2e-diskfull',
    what: 'treats a full disk as one more failed chunk',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'if (err && DISK_HALT_CODES.has(err.code)) { fatal = diskHalt(err); return; }',
      'void 0;'),
  },
  {
    suite: 'e2e-workerexit',
    what: 'does not notice a decoder thread that exits without an error',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      "worker.on('exit', (code) => {",
      "worker.on('never-emitted', (code) => {"),
  },
  {
    suite: 'hostpool',
    what: 'spreads the download over the healthiest third of the mirrors again',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'const top = Math.min(pool.length, Math.max(2, this.activeHosts));',
      'const top = Math.min(pool.length, Math.max(2, Math.ceil(pool.length / 3)));'),
  },
  {
    suite: 'e2e-stage-parallel',
    what: 'stages one chunk at a time',
    apply: (root) => patch(root, 'src/core/steamPipe.js',
      'const STAGING_CONCURRENCY = 8;',
      'const STAGING_CONCURRENCY = 1;'),
  },
];

function patch(root, rel, from, to) {
  const p = join(root, rel);
  const src = readFileSync(p, 'utf8');
  if (!src.includes(from)) throw new Error(`sabotage anchor not found in ${rel}: ${from.slice(0, 60)}`);
  writeFileSync(p, src.split(from).join(to), 'utf8');
}

/** A throwaway copy of everything the engine and the harness need. */
function cloneRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'librarian-sabotage-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'dev'), join(dir, 'dev'), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
  // node_modules is large; a junction/symlink is enough for module resolution.
  try {
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction');
  } catch {
    return { dir, ok: false, dispose: () => rmSync(dir, { recursive: true, force: true }) };
  }
  return { dir, ok: true, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Every round-one suite, in sequence, against the engine as it is now. */
function suiteAllRound1() {
  const fail = [];
  for (const suite of E2E_SUITES) {
    const res = runE2E(suite);
    if (!res.ok) {
      fail.push(`all-round1: ${suite} no longer passes — ${res.output.split('\n').filter(l => l.startsWith('FAIL')).slice(0, 3).join(' | ')}`);
    }
  }
  const integrity = suiteIntegrity();
  for (const f of integrity) fail.push(`all-round1: ${f}`);
  return fail;
}

/** Every suite from the first two rounds, against the engine as it is now. */
function suiteAllEarlier() {
  const fail = suiteAllRound1().map(f => f.replace(/^all-round1/, 'all-earlier'));
  for (const suite of ROUND2_SUITES) {
    const res = runE2E(suite);
    if (!res.ok) {
      fail.push(`all-earlier: ${suite} no longer passes — ${res.output.split('\n').filter(l => l.startsWith('FAIL')).slice(0, 3).join(' | ')}`);
    }
  }
  return fail;
}

function suiteSelfTest(only = null, table = SABOTAGE) {
  const fail = [];
  const cases = only ? table.filter(s => s.suite === only) : table;
  for (const item of cases) {
    const clone = cloneRepo();
    if (!clone.ok) {
      clone.dispose();
      fail.push('self-test: could not create a sabotage clone (symlinking node_modules failed)');
      break;
    }
    try {
      item.apply(clone.dir);
      const res = runE2E(item.suite, { root: clone.dir });
      if (res.ok) {
        fail.push(`self-test: "${item.suite}" still passed against an engine that ${item.what} — it cannot fail.`);
      }
    } catch (err) {
      fail.push(`self-test: could not sabotage for "${item.suite}": ${err.message}`);
    } finally {
      clone.dispose();
    }
  }
  return fail;
}

// ════════════════════════════════════════════════════════════════

const name = process.argv[2];
const all = [...E2E_SUITES, ...ROUND2_SUITES, ...ROUND3_SUITES, 'integrity', 'self-test', 'all-round1', 'self-test-round2', 'all-earlier', 'self-test-round3'];
if (!name || !all.includes(name)) {
  console.error(`usage: node dev/verify-steampipe-engine.mjs <${all.join('|')}>`);
  process.exit(2);
}

let failures = [];
if (name === 'integrity') {
  failures = suiteIntegrity();
} else if (name === 'self-test') {
  failures = suiteSelfTest(process.argv[3] || null, SABOTAGE);
} else if (name === 'self-test-round2') {
  failures = suiteSelfTest(process.argv[3] || null, SABOTAGE2);
} else if (name === 'self-test-round3') {
  failures = suiteSelfTest(process.argv[3] || null, SABOTAGE3);
} else if (name === 'all-round1') {
  failures = suiteAllRound1();
} else if (name === 'all-earlier') {
  failures = suiteAllEarlier();
} else {
  const res = runE2E(name);
  if (!res.ok) {
    process.stderr.write(res.output);
    failures.push(`${name}: the end-to-end suite did not pass (exit ${res.status})`);
  }
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log(`OK ${name}`);
