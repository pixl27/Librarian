#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Claim verifier for the SteamPipe engine audit.
//
// The audit report says things like "the completion guard is dead" and "the
// adaptive ramp never backs off". Advice built on a wrong reading of the code
// is worse than no advice, so every load-bearing factual claim in that report
// has an assertion here that reads the shipped source and would fail if the
// claim were false.
//
//   node dev/verify-steampipe-audit.mjs <suite>
//
// Each suite prints its failures and, only when every assertion in it passed,
// the line `OK <suite>` and exits 0. The success token is printed after the
// assertions run, never before, so a crash cannot read as a pass.
//
// Several suites assert that a DEFECT is present. That is deliberate: they are
// the evidence for the report's "current behaviour" claims, and they are meant
// to start failing the moment the defect is fixed.
//
// Lives in dev/ deliberately: electron-builder ships main.js, preload.js,
// src/**, tools/**, res/** and package.json, so nothing here reaches a user.
// ═══════════════════════════════════════════════════════════════════
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── Source helpers ──────────────────────────────────────────────

/** Strip line and block comments so prose about a behaviour is never mistaken
 *  for the behaviour. This engine is heavily commented; almost every false
 *  positive in an early draft of this file came from matching a comment. */
function stripComments(js) {
  let out = '';
  let i = 0;
  let mode = 'code';
  while (i < js.length) {
    const c = js[i], d = js[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { mode = 'block'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { mode = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += '\n'; } i++; continue; }
    if (mode === 'block') { if (c === '*' && d === '/') { mode = 'code'; i += 2; } else { i++; } continue; }
    // inside a string literal
    if (c === '\\') { out += js.slice(i, i + 2); i += 2; continue; }
    out += c;
    if (c === mode) mode = 'code';
    i++;
  }
  return out;
}

/** Full text of a `function name(...) { ... }` declaration, braces matched. */
function fnText(js, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(js);
  if (!m) return null;
  const open = js.indexOf('{', m.index + m[0].length - 1);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < js.length; i++) {
    if (js[i] === '{') depth++;
    else if (js[i] === '}') { depth--; if (depth === 0) return js.slice(m.index, i + 1); }
  }
  return null;
}

/** Full text of an object-literal method `name(...) { ... }` (e.g. stop, markPaused). */
function methodText(js, name) {
  const re = new RegExp(`(?:^|[\\s,{])${name}\\s*\\(([^)]*)\\)\\s*\\{`, 'm');
  const m = re.exec(js);
  if (!m) return null;
  const open = js.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (let i = open; i < js.length; i++) {
    if (js[i] === '{') depth++;
    else if (js[i] === '}') { depth--; if (depth === 0) return js.slice(m.index, i + 1); }
  }
  return null;
}

const count = (hay, needle) => hay.split(needle).length - 1;

// ════════════════════════════════════════════════════════════════
// Suites. Each takes its sources as arguments so the self-test can feed
// deliberately altered copies. Each returns an array of failure strings.
// ════════════════════════════════════════════════════════════════

/**
 * CLAIM: a chunk is recorded as permanently done in the resume bitmap without
 * its bytes ever being flushed to stable storage, and neither pausing nor
 * stopping writes the bitmap out at that moment.
 */
function suiteResumeDurability(pipeSrc) {
  const fail = [];
  const code = stripComments(pipeSrc);

  // FileHandle.sync() / .datasync() are the async forms, fs.fsyncSync the sync
  // one. Matched case-sensitively on the lowercase `.sync(` so the many
  // `readFileSync(`/`renameSync(` calls in this file are not false positives.
  if (/\bfsync\b|\bfdatasync\b|\.datasync\(|\.sync\(/.test(code)) {
    fail.push('resume-durability: engine now flushes to stable storage (fsync/datasync present) — the durability claim is stale.');
  }

  const complete = fnText(code, 'completeTarget');
  if (!complete) fail.push('resume-durability: completeTarget() not found.');
  else {
    if (!/bitSet\(bits,\s*target\.index\)/.test(complete)) {
      fail.push('resume-durability: completeTarget() no longer marks the bit directly.');
    }
    if (!/checkpoint\(\)/.test(complete)) {
      fail.push('resume-durability: completeTarget() no longer checkpoints.');
    }
    if (/await|flush|sync/i.test(complete)) {
      fail.push('resume-durability: completeTarget() now waits on something — re-read it before repeating the claim.');
    }
  }

  const paused = methodText(code, 'markPaused');
  if (!paused) fail.push('resume-durability: markPaused() not found.');
  else if (/saveState/.test(paused)) {
    fail.push('resume-durability: markPaused() now persists state — the claim is stale.');
  }

  const stop = methodText(code, 'stop');
  if (!stop) fail.push('resume-durability: stop() not found.');
  else if (/saveState/.test(stop)) {
    fail.push('resume-durability: stop() now persists state itself — the claim is stale.');
  }

  // The only synchronous save sits on the stopped path *inside* run(), i.e. it
  // requires every worker to unwind first. That is what makes the 400 ms quit
  // deadline in main.js load-bearing.
  if (!/if \(stopped\) \{\s*saveState\(downloadDir, manifestSig, targetCount, bits\);/.test(code)) {
    fail.push('resume-durability: the stopped-path saveState inside run() was not found where the claim expects it.');
  }
  const quit = stripComments(read('main.js'));
  if (!/before-quit[\s\S]{0,600}?currentDownload\.stop\(\)[\s\S]{0,300}?setTimeout\(\(\) => app\.quit\(\), 400\)/.test(quit)) {
    fail.push('resume-durability: main.js no longer stops the download and quits on a 400 ms timer — re-read the quit path.');
  }
  return fail;
}

/**
 * CLAIM: the resume state file counts as a "game file", so the end-of-run guard
 * that refuses to register an install whose payload vanished can never fire,
 * and an interrupted fresh download silently loses its disk-space preflight.
 *
 * This one is behavioural: the shipped directoryHasFiles() is extracted and run
 * against real directories on disk.
 */
function suiteResumeGuard(pipeSrc) {
  const fail = [];
  const code = stripComments(pipeSrc);

  const stateName = /STATE_FILENAME\s*=\s*'([^']+)'/.exec(code)?.[1];
  const markerName = /MARKER_DIR\s*=\s*'([^']+)'/.exec(code)?.[1];
  if (!stateName || !markerName) return ['resume-guard: STATE_FILENAME / MARKER_DIR constants not found.'];

  // The state file is written to the install dir itself, not into the marker dir.
  if (!/function stateFilePath\(dir\) \{ return path\.join\(dir, STATE_FILENAME\); \}/.test(code)) {
    fail.push('resume-guard: stateFilePath() no longer joins the install dir directly — the collision may be gone.');
  }

  const dhf = fnText(code, 'directoryHasFiles');
  if (!dhf) return [...fail, 'resume-guard: directoryHasFiles() not found.'];

  let directoryHasFiles;
  try {
    directoryHasFiles = new Function('fs', 'path', 'MARKER_DIR', `${dhf}; return directoryHasFiles;`)(
      nodeFs, nodePath, markerName);
  } catch (err) {
    return [...fail, `resume-guard: could not evaluate directoryHasFiles(): ${err.message}`];
  }

  const tmp = mkdtempSync(join(tmpdir(), 'librarian-audit-'));
  try {
    // A download that was started and stopped before a single game file landed:
    // the marker dir and the resume state file, and nothing else.
    const a = join(tmp, 'interrupted');
    mkdirSync(join(a, markerName), { recursive: true });
    writeFileSync(join(a, stateName), '{"v":2}');
    if (directoryHasFiles(a) !== true) {
      fail.push('resume-guard: the state file no longer counts as a game file — the dead-guard claim is stale.');
    }

    // Control: the marker dir alone must NOT count, or the check above would be
    // proving nothing about the state file specifically.
    const b = join(tmp, 'marker-only');
    mkdirSync(join(b, markerName), { recursive: true });
    writeFileSync(join(b, markerName, 'scratch.bin'), 'x');
    if (directoryHasFiles(b) !== false) {
      fail.push('resume-guard: the marker directory now counts as a game file — the control is invalid.');
    }

    // Control: a real payload file must count, or the function is simply broken
    // and the first assertion would pass for the wrong reason.
    const c = join(tmp, 'real');
    mkdirSync(join(c, 'sub'), { recursive: true });
    writeFileSync(join(c, 'sub', 'game.pak'), 'x');
    if (directoryHasFiles(c) !== true) {
      fail.push('resume-guard: a real payload file no longer counts — directoryHasFiles is broken.');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // The guard runs before the state file is cleared, so the file is still there.
  const guardAt = code.indexOf('if (!directoryHasFiles(downloadDir))');
  const clearAt = code.indexOf('\n    clearState(downloadDir);');
  if (guardAt === -1 || clearAt === -1 || clearAt < guardAt) {
    fail.push('resume-guard: the completion guard / clearState ordering changed — re-read the finalisation path.');
  }

  // Same function decides whether the disk-space preflight runs at all.
  if (!/const priorInstallExists = directoryHasFiles\(downloadDir\)/.test(code)) {
    fail.push('resume-guard: priorInstallExists is no longer derived from directoryHasFiles().');
  }
  if (!/const isFreshInstall = !priorInstallExists && jobType !== 'update' && jobType !== 'repair'/.test(code)) {
    fail.push('resume-guard: isFreshInstall is no longer derived from priorInstallExists.');
  }
  if (!/if \(isFreshInstall\) \{[\s\S]{0,400}?getFreeDiskBytes\(downloadDir\)/.test(code)) {
    fail.push('resume-guard: the disk-space preflight is no longer gated on isFreshInstall.');
  }
  return fail;
}

/**
 * CLAIM: the adaptive concurrency controller only ever adds connections, gives
 * up permanently after two non-improving samples, and never restarts.
 */
function suiteSpeedRamp(pipeSrc) {
  const fail = [];
  const code = stripComments(pipeSrc);
  const pass = fnText(code, 'runPass');
  if (!pass) return ['speed-ramp: runPass() not found.'];

  if (count(pass, 'setInterval(') !== 1) {
    fail.push('speed-ramp: runPass() no longer has exactly one probe interval — the "never restarts" claim needs re-reading.');
  }
  if (!/if \(\+\+flat >= 2\) \{ clearInterval\(probe\); probe = null; \}/.test(pass)) {
    fail.push('speed-ramp: the two-flat-samples-and-stop rule is no longer written as the claim describes.');
  }
  // Nothing in the probe retires a worker: the only place `live` goes down is
  // the finally of a worker that ran out of queue.
  if (count(pass, 'live--') !== 1) {
    fail.push('speed-ramp: `live` is now decremented somewhere other than the worker exit — the one-way claim is stale.');
  }
  if (/hardCap = Math\.max|retire|shrink|removeWorker/.test(pass)) {
    fail.push('speed-ramp: runPass() now appears to reduce concurrency — the one-way claim is stale.');
  }
  const probeMs = Number(/ADAPTIVE_PROBE_MS = (\d+)/.exec(code)?.[1]);
  if (probeMs !== 4000) {
    fail.push(`speed-ramp: ADAPTIVE_PROBE_MS is ${probeMs}, not the 4000 the report quotes.`);
  }
  // The ramp is measured against wireBytes, which does not move while the
  // update is still staging or validating — that is why it can stop early.
  if (!/const rate = \(wireBytes - lastWire\) \/ dt/.test(pass)) {
    fail.push('speed-ramp: the probe no longer measures wireBytes — re-read the sampling basis.');
  }
  if (!/if \(rate <= 0\) return;/.test(pass)) {
    fail.push('speed-ramp: the zero-rate early return is gone — the stall-blindness claim needs re-reading.');
  }
  return fail;
}

/**
 * CLAIM: AES decryption and SHA-1 verification of every chunk run synchronously
 * on the calling (Electron main) thread; only LZMA is offloaded.
 */
function suiteSpeedCpu(pipeSrc) {
  const fail = [];
  const code = stripComments(pipeSrc);

  if (!/^function decryptChunk\(enc, keyHex\) \{/m.test(code)) {
    fail.push('speed-cpu: decryptChunk is no longer a plain synchronous function.');
  }
  if (!/function shaVerify\(data, expected\) \{\s*return crypto\.createHash\('sha1'\)/.test(code)) {
    fail.push('speed-cpu: shaVerify is no longer a synchronous SHA-1 over the whole buffer.');
  }
  const group = fnText(code, 'processGroup');
  if (!group) return [...fail, 'speed-cpu: processGroup() not found.'];

  if (!/const decrypted = decryptChunk\(encrypted, group\.depotKey\);/.test(group)) {
    fail.push('speed-cpu: processGroup no longer decrypts inline (no await) — the claim is stale.');
  }
  if (!/if \(!shaVerify\(raw, group\.sha\)\)/.test(group)) {
    fail.push('speed-cpu: processGroup no longer verifies inline — the claim is stale.');
  }
  // The worker pool exists, but only VZ/LZMA is routed to it.
  if (count(group, 'lzmaPool.decode(') !== 1 || !/if \(isVZ\(decrypted\)\)/.test(group)) {
    fail.push('speed-cpu: the worker pool is no longer LZMA-only — re-read what is offloaded.');
  }
  // targetMatchesOnDisk (repair) hashes on the calling thread too.
  const match = fnText(code, 'targetMatchesOnDisk');
  if (!match || !/crypto\.createHash\('sha1'\)\.update\(buf\)\.digest\(\)\.equals\(group\.sha\)/.test(match)) {
    fail.push('speed-cpu: targetMatchesOnDisk no longer hashes synchronously — the repair-cost claim is stale.');
  }
  return fail;
}

/**
 * CLAIM: mirrors start unranked, the server list is resolved exactly once for
 * the life of a job, and a mirror is only ever dropped for hard failures —
 * never for being slow, rate-limited, or asking us to back off.
 */
function suiteHosts(pipeSrc) {
  const fail = [];
  const code = stripComments(pipeSrc);

  if (!/this\.entries = hosts\.map\(host => \(\{ host, fails: 0, ok: 0, ewma: 0 \}\)\)/.test(code)) {
    fail.push('hosts: HostPool no longer seeds every mirror with ewma 0 — the "unranked start" claim is stale.');
  }
  if (count(code, 'resolveCdn(') !== 2) {  // the declaration and one call site
    fail.push('hosts: resolveCdn is no longer called exactly once — the "resolved once" claim is stale.');
  }
  const fetchFn = fnText(code, 'fetchChunk');
  if (!fetchFn) return [...fail, 'hosts: fetchChunk() not found.'];

  if (/429|503|[Rr]etry-?[Aa]fter/.test(fetchFn)) {
    fail.push('hosts: fetchChunk now handles rate-limit responses — the claim is stale.');
  }
  if (/AbortController|slow|stall|median|minRate/i.test(fetchFn)) {
    fail.push('hosts: fetchChunk now has its own stall/slow-mirror control — the claim is stale.');
  }
  if (!/await new Promise\(r => setTimeout\(r, 400 \* \(i \+ 1\)\)\)/.test(fetchFn)) {
    fail.push('hosts: the fixed linear backoff the report describes is gone.');
  }
  // Success is recorded regardless of how slow it was; only throws count as failure.
  if (!/pool\.succeeded\(entry, buf\.length, Date\.now\(\) - started\)/.test(fetchFn)) {
    fail.push('hosts: throughput bookkeeping changed — re-read how a mirror earns its rank.');
  }
  // The fetched body is never checked against the manifest's compressed size.
  if (/cbCompressed/.test(fetchFn)) {
    fail.push('hosts: fetchChunk now knows the expected compressed size — the claim is stale.');
  }
  return fail;
}

/**
 * CLAIM: "Use Lancache" is a real, persisted, user-visible setting that the
 * download engine never reads.
 */
function suiteLancache(pipeSrc, settingsSrc, htmlSrc, appSrc) {
  const fail = [];
  if (!/use_lancache:\s*false/.test(settingsSrc)) {
    fail.push('lancache: use_lancache is no longer a stored setting.');
  }
  if (!/id="chk-lancache"/.test(htmlSrc)) {
    fail.push('lancache: the Use Lancache checkbox is no longer in the settings UI.');
  }
  if (!/setSetting\('use_lancache'/.test(appSrc)) {
    fail.push('lancache: the renderer no longer persists the toggle.');
  }
  if (/lancache/i.test(pipeSrc)) {
    fail.push('lancache: the engine now references lancache — the dead-switch claim is stale.');
  }
  return fail;
}

/**
 * CLAIM: an update never removes a file that the previous build had and the new
 * build does not, even though the engine holds both file lists.
 */
function suiteUpdateOrphans(pipeSrc) {
  const fail = [];
  const code = stripComments(pipeSrc);

  // Every destructive filesystem call in the engine, and what it targets. If a
  // deletion pass is ever added, one of these will stop matching the allow-list
  // and this suite will fail — which is exactly when the claim stops being true.
  const allowed = [
    "fs.unlinkSync(stateFilePath(dir))",
    "fs.unlinkSync(path.join(markerDir, RECOVERY_CACHE))",
    "fs.rmSync(manifestDir, { recursive: true, force: true })",
    "fs.unlinkSync(tmp)",
    "fs.unlinkSync(cachePath)",
    "fs.unlinkSync(src)",
    "fs.promises.unlink(tmp)",
  ];
  const calls = [...code.matchAll(/fs\.(?:promises\.)?(?:unlinkSync|unlink|rmSync|rm|rmdirSync)\([^;\n]*/g)]
    .map(m => m[0].trim().replace(/\)\.catch.*$/, ')'));
  for (const call of calls) {
    if (!allowed.some(a => call.startsWith(a))) {
      fail.push(`update-orphans: unrecognised deletion \`${call}\` — a stale-file sweep may now exist.`);
    }
  }
  if (!calls.length) fail.push('update-orphans: no deletions found at all — the scan is broken.');

  // The information a sweep would need is already assembled.
  if (!/const priorAtPath = new Map\(\)/.test(code) || !/priorAtPath\.set\(abs, byOffset\)/.test(code)) {
    fail.push('update-orphans: priorAtPath is gone — the "data is already there" recommendation needs re-checking.');
  }
  if (!/const declaredSize = new Map\(\)/.test(code) || !/declaredSize\.set\(absPath/.test(code)) {
    fail.push('update-orphans: declaredSize is gone — the new build\'s file list is no longer assembled.');
  }
  // Truncation of shortened files exists; deletion of dropped files does not.
  if (!/fs\.truncateSync\(absPath, declared\)/.test(code)) {
    fail.push('update-orphans: the trim pass is gone — re-read what finalisation does.');
  }
  return fail;
}

/**
 * CLAIM: staging copies every reusable chunk to a scratch file, whether or not
 * that chunk's source region was ever at risk of being overwritten.
 */
function suiteUpdateStaging(pipeSrc) {
  const fail = [];
  const code = stripComments(pipeSrc);
  const stage = fnText(code, 'stageReusableData');
  if (!stage) return ['update-staging: stageReusableData() not found.'];

  if (!/for \(const \[shaHex, src\] of recoverPlan\)/.test(stage)) {
    fail.push('update-staging: the staging loop no longer walks the whole recovery plan.');
  }
  // No notion of "will anything actually write over this source?" — the give-up
  // condition is disk space, nothing else.
  if (/declaredSize|filePaths|willWrite|atRisk|overlap|intersect/.test(stage)) {
    fail.push('update-staging: staging now consults the planned writes — the claim is stale.');
  }
  if (!/free < wanted \* 1\.05/.test(stage)) {
    fail.push('update-staging: the disk-space fallback changed — re-read the staging preconditions.');
  }
  const plan = fnText(code, 'planUpdate');
  if (!plan) return [...fail, 'update-staging: planUpdate() not found.'];
  if (!/if \(!recoverPlan\.has\(group\.shaHex\)\) recoverPlan\.set\(group\.shaHex, priorIndex\.get\(group\.shaHex\)\);/.test(plan)) {
    fail.push('update-staging: the recovery plan is no longer filled unconditionally from priorIndex.');
  }
  // Every staged byte is read once and written once before the update writes it
  // a second time — that is the write amplification the report quantifies.
  if (!/await out\.write\(buf, 0, src\.len, pos\)/.test(stage)) {
    fail.push('update-staging: staged bytes are no longer written to a scratch file.');
  }
  return fail;
}

/** CLAIM: only the first on-disk location of a given chunk hash is remembered. */
function suitePriorIndex(pipeSrc) {
  const fail = [];
  const code = stripComments(pipeSrc);
  const build = fnText(code, 'buildPriorIndex');
  if (!build) return ['prior-index: buildPriorIndex() not found.'];
  if (!/if \(index\.has\(hex\)\) continue;/.test(build)) {
    fail.push('prior-index: more than one location per hash may now be kept — the claim is stale.');
  }
  if (!/index\.set\(hex, \{ path: abs, offset: Number\(chunk\.offset\), len: chunk\.cbOriginal \}\)/.test(build)) {
    fail.push('prior-index: the index entry shape changed — re-read the recovery source model.');
  }
  // The index is abandoned wholesale when any depot cannot be pinned.
  if (!/const abandon = \(why\) => \{/.test(build) || !/priorAtPath\.clear\(\)/.test(build)) {
    fail.push('prior-index: the all-or-nothing abandonment is gone — re-read the update fallback.');
  }
  if (!/const cacheDir = path\.join\(destPath, 'depotcache'\)/.test(build)) {
    fail.push('prior-index: the prior manifest is no longer sourced from the library depotcache.');
  }
  return fail;
}

// ════════════════════════════════════════════════════════════════
// Negative control
//
// Every suite above is only worth its exit code if it can fail. Each entry
// mutates the source so that the specific fact the suite asserts stops being
// true, and requires the suite to notice.
// ════════════════════════════════════════════════════════════════
function suiteSelfTest(src) {
  const fail = [];
  const cases = [
    ['resume-durability', () => suiteResumeDurability(
      src.pipe.replace('await handle.write(data, 0, data.length, target.offset);',
        'await handle.write(data, 0, data.length, target.offset); await handle.sync();'))],
    ['resume-guard', () => suiteResumeGuard(
      src.pipe.replace("if (entry.name === MARKER_DIR) continue;",
        "if (entry.name === MARKER_DIR || entry.name === '.librarian-pipe-state.json') continue;"))],
    ['speed-ramp', () => suiteSpeedRamp(
      src.pipe.replace('if (++flat >= 2) { clearInterval(probe); probe = null; }',
        'if (++flat >= 2) { flat = 0; }'))],
    ['speed-cpu', () => suiteSpeedCpu(
      src.pipe.replace('const decrypted = decryptChunk(encrypted, group.depotKey);',
        'const decrypted = await cryptoPool.decrypt(encrypted, group.depotKey);'))],
    ['hosts', () => suiteHosts(
      src.pipe.replace('if (!res.ok) throw new Error(`HTTP ${res.status} from ${entry.host}`);',
        'if (res.status === 429) await honourRetryAfter(res); if (!res.ok) throw new Error(`HTTP ${res.status} from ${entry.host}`);'))],
    ['lancache', () => suiteLancache(
      `${src.pipe}\nconst lancacheHost = 'lancache.steamcontent.com';\n`,
      src.settings, src.html, src.app)],
    ['update-orphans', () => suiteUpdateOrphans(
      src.pipe.replace('let trimmed = 0;', 'for (const p of orphans) fs.unlinkSync(p);\n    let trimmed = 0;'))],
    ['update-staging', () => suiteUpdateStaging(
      src.pipe.replace('for (const [shaHex, src] of recoverPlan) {',
        'for (const [shaHex, src] of recoverPlan) {\n          if (!atRisk(src)) continue;'))],
    ['prior-index', () => suitePriorIndex(
      src.pipe.replace('if (index.has(hex)) continue;', 'if ((index.get(hex)?.length ?? 0) >= 3) continue;'))],
  ];

  for (const [name, run] of cases) {
    let result;
    try { result = run(); } catch (err) { result = [`threw: ${err.message}`]; }
    if (!result.length) {
      fail.push(`self-test: suite "${name}" still passed after its subject was changed — it cannot fail.`);
    }
  }
  return fail;
}

// ════════════════════════════════════════════════════════════════

const SOURCES = () => ({
  pipe: read('src/core/steamPipe.js'),
  settings: read('src/core/settingsStore.js'),
  html: read('src/index.html'),
  app: read('src/js/app.js'),
});

const SUITES = {
  'resume-durability': (s) => suiteResumeDurability(s.pipe),
  'resume-guard': (s) => suiteResumeGuard(s.pipe),
  'speed-ramp': (s) => suiteSpeedRamp(s.pipe),
  'speed-cpu': (s) => suiteSpeedCpu(s.pipe),
  'hosts': (s) => suiteHosts(s.pipe),
  'lancache': (s) => suiteLancache(s.pipe, s.settings, s.html, s.app),
  'update-orphans': (s) => suiteUpdateOrphans(s.pipe),
  'update-staging': (s) => suiteUpdateStaging(s.pipe),
  'prior-index': (s) => suitePriorIndex(s.pipe),
  'self-test': (s) => suiteSelfTest(s),
};

const name = process.argv[2];
if (!name || !SUITES[name]) {
  console.error(`usage: node dev/verify-steampipe-audit.mjs <${Object.keys(SUITES).join('|')}>`);
  process.exit(2);
}

let failures;
try {
  failures = SUITES[name](SOURCES());
} catch (err) {
  console.error(`${name}: verifier crashed: ${err.stack}`);
  process.exit(1);
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log(`OK ${name}`);
