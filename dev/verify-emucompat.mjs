#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Gate runner for emulator compatibility (GATES-emucompat.md).
//
//   node dev/verify-emucompat.mjs <suite>
//
//   unit        extraction and decision on real libraries and fixtures
//   update      fetch the newest gbe_fork through SteamAutoCrack; Mortal
//               Shell II then passes the check (mutates deps/, on purpose)
//   realgame    dev/emucompat-realgame.js under the shipped Electron
//   postlaunch  the missing-interface report reader
//   pipeline    the decision table, and the engine's use of it
//   integrity   the sources agree with each other
//   self-test   integrity fails on a copy with each defect reintroduced
//   pack        electron-builder --dir carries the module and the emulator
//
// Prints `OK <suite>` and exits 0 only when every assertion passed.
// ═══════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, writeFileSync, rmSync, mkdirSync, cpSync, mkdtempSync, statSync, utimesSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const ROOT = resolve(opt('--root', join(HERE, '..')));
const suite = args.find((a) => !a.startsWith('--') && a !== opt('--root', ''));
const require = createRequire(import.meta.url);
const read = (root, p) => readFileSync(join(root, p), 'utf8');
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const GAMES = 'E:\\Games\\steam\\steamapps\\common';
const MORTAL = join(GAMES, 'Mortal_Shell_II');
const BIG_WALK = join(GAMES, 'Big_Walk');
const ULTRAKILL = join(GAMES, 'ULTRAKILL');
const FROZEN = join(ROOT, 'dev', 'fixtures', 'gbe-2026-08-07.interfaces.txt');

let failures = 0;
function check(cond, what) {
  if (cond) { console.log(`  ok   ${what}`); return true; }
  failures++;
  console.log(`  FAIL ${what}`);
  return false;
}
function fail(msg) { console.error(`FAIL ${msg}`); process.exit(1); }
function done(name) {
  if (failures) { console.log(`FAILED ${name}: ${failures} check(s)`); process.exit(1); }
  console.log(`OK ${name}`);
  process.exit(0);
}
function run(cmd, cmdArgs, { cwd = ROOT, timeout = 600000 } = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' };
}
const emu = () => require(join(ROOT, 'src', 'core', 'emuCompat.js'));
const frozen = () => readFileSync(FROZEN, 'utf8').trim().split(/\r?\n/);

// Fake libraries: a "game" one is small and names interfaces; an "emulator"
// one is over a megabyte and carries the report-file string.
function fakeGameLib(names) { return Buffer.from(`MZ\0\0${names.join('\0')}\0`, 'latin1'); }
function fakeEmuLib(names) {
  const b = Buffer.alloc(1024 * 1024 + 4096);
  b.write(`MZ\0\0EMU_MISSING_INTERFACE\0${names.join('\0')}\0`, 0, 'latin1');
  return b;
}

// ── unit ─────────────────────────────────────────────────────────
async function suiteUnit() {
  const E = emu();
  const list = frozen();
  check(list.length > 200 && list.includes('SteamUtils010') && !list.includes('SteamUtils011'), `frozen 2026-08-07 emulator list: ${list.length} names, has SteamUtils010, lacks SteamUtils011`);

  // Regex on text.
  const names = E.interfacesInText('x SteamUser023 y STEAMUSERSTATS_INTERFACE_VERSION013 STEAMHTMLSURFACE_INTERFACE_VERSION_005 STEAMINVENTORY_INTERFACE_V003 SteamNetworkingSockets013 SteamAPI_Init Steam_RunCallbacks SteamUser SteamUtils011');
  check(JSON.stringify(names) === JSON.stringify(['STEAMHTMLSURFACE_INTERFACE_VERSION_005', 'STEAMINVENTORY_INTERFACE_V003', 'STEAMUSERSTATS_INTERFACE_VERSION013', 'SteamNetworkingSockets013', 'SteamUser023', 'SteamUtils011']), `regex keeps both spellings and drops function names: ${names.join(' ')}`);

  // Real: Mortal Shell II asks for more than the old emulator has.
  if (existsSync(MORTAL)) {
    const r = E.check(MORTAL, { emulatorInterfaces: { 64: list } });
    console.log(`  info Mortal Shell II: ${r.libraries.length} libraries, ${r.requested.length} requested, missing ${r.missing.join(', ') || 'none'}`);
    check(!r.compatible && !r.unknown, 'Mortal Shell II is judged incompatible with the 2026-08-07 emulator');
    check(r.missing.includes('SteamUtils011'), 'SteamUtils011 is among the missing interfaces (what the game reported)');
    check(r.missing.includes('SteamNetworkingSockets013') && r.missing.includes('SteamInput007'), 'the check finds the interfaces the game never got to ask for');
    const v165 = r.libraries.find((l) => /Steamv165/i.test(l.dll));
    check(v165 && v165.missing.length === 4, `the Steamworks 1.65 library carries the gap (${v165 ? v165.missing.length : '?'} missing)`);
    const v157 = r.libraries.find((l) => /Steamv157/i.test(l.dll));
    check(v157 && v157.missing.length === 0 && v157.kind === 'emulator' && v157.original && /\.bak$/.test(v157.original), 'the old Steamworks 1.57 folder holds an emulator whose backup is fully covered');
  } else {
    check(false, `Mortal Shell II install present at ${MORTAL}`);
  }
  // Real: Big Walk is online (proxy + _o.dll) and fully covered.
  if (existsSync(BIG_WALK)) {
    const libs = E.findGameLibraries(BIG_WALK);
    const px = libs.find((l) => l.kind === 'proxy');
    check(Boolean(px) && /_o\.dll$/i.test(px.original), `Big Walk: online proxy recognised, original taken from ${px ? px.original.split('\\').pop() : '?'}`);
    const r = E.check(BIG_WALK, { emulatorInterfaces: { 64: list } });
    check(r.compatible && r.online, `Big Walk (Steamworks 1.53): compatible=${r.compatible}, online=${r.online}`);
  }
  // Real: ULTRAKILL has the emulator in place with a backup.
  if (existsSync(ULTRAKILL)) {
    const libs = E.findGameLibraries(ULTRAKILL);
    const em = libs.find((l) => l.kind === 'emulator');
    check(Boolean(em) && em.original && /\.bak$/.test(em.original), 'ULTRAKILL: emulator in place, original read from the backup');
    check(E.wasCracked(ULTRAKILL), 'ULTRAKILL counts as cracked');
    check(E.check(ULTRAKILL, { emulatorInterfaces: { 64: list } }).compatible, 'ULTRAKILL is covered by the 2026-08-07 emulator');
  }

  // Fixtures.
  const base = mkdtempSync(join(tmpdir(), 'emucompat-unit-'));
  try {
    const mk = (name) => { const d = join(base, name); mkdirSync(join(d, 'bin'), { recursive: true }); return d; };
    const a = mk('a'); writeFileSync(join(a, 'bin', 'steam_api64.dll'), fakeGameLib(['SteamUser023', 'SteamUtils011']));
    const ra = E.check(a, { emulatorInterfaces: { 64: ['SteamUser023', 'SteamUtils010'] } });
    check(ra.libraries[0].kind === 'game' && JSON.stringify(ra.missing) === '["SteamUtils011"]' && !ra.compatible, 'fixture a: game library, missing SteamUtils011');
    check(!E.wasCracked(a), 'fixture a: never cracked');

    const b = mk('b');
    writeFileSync(join(b, 'bin', 'steam_api64.dll'), fakeEmuLib(['SteamUser023']));
    writeFileSync(join(b, 'bin', 'steam_api64.dll.bak'), fakeGameLib(['SteamUser023']));
    const rb = E.check(b, { emulatorInterfaces: { 64: ['SteamUser023'] } });
    check(rb.libraries[0].kind === 'emulator' && /\.bak$/.test(rb.libraries[0].original) && rb.compatible, 'fixture b: emulator in place, backup read, compatible');
    check(E.wasCracked(b), 'fixture b: counts as cracked');

    const c = mk('c'); writeFileSync(join(c, 'bin', 'steam_api64.dll'), fakeEmuLib(['SteamUser023']));
    const rc = E.check(c, { emulatorInterfaces: { 64: [] } });
    check(rc.unknown && !rc.compatible && rc.libraries[0].original === null, 'fixture c: emulator without a backup is unknown, not judged');

    const d = mk('d');
    writeFileSync(join(d, 'bin', 'steam_api64.dll'), Buffer.from('MZ proxy, names nothing'));
    writeFileSync(join(d, 'bin', 'steam_api64_o.dll'), fakeGameLib(['SteamUser023', 'SteamUtils011']));
    mkdirSync(join(d, '.DepotDownloader')); writeFileSync(join(d, '.DepotDownloader', 'online-mode.json'), JSON.stringify({ mode: 'online' }));
    const rd = E.check(d, { emulatorInterfaces: { 64: ['SteamUser023'] } });
    check(rd.libraries[0].kind === 'proxy' && rd.online && rd.missing.includes('SteamUtils011'), 'fixture d: online proxy recognised, original read from _o.dll, online flagged');

    const e = mk('e'); writeFileSync(join(e, 'bin', 'steam_api.dll'), fakeGameLib(['SteamUser023']));
    const re = E.check(e, { emulatorInterfaces: { 32: ['SteamUser023'], 64: [] } });
    check(re.libraries[0].arch === 32 && re.compatible, 'fixture e: 32-bit library compared with the 32-bit emulator');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  // The updater must never leave the machine without an emulator: a failed
  // download (here, a URL that answers 404) changes nothing on disk.
  const before = E.emulatorInfo();
  if (before.library64) {
    const sig = statSync(before.library64).mtimeMs + ':' + before.interfaces64.length + ':' + before.commit;
    const r = await E.updateEmulator({ onLog: () => {}, assetUrl: 'https://github.com/Detanup01/gbe_fork/releases/download/nonexistent/emu-win-release.7z', release: { tag: 'test', assetName: 'emu-win-release.7z', assetUrl: 'x', publishedAt: 1 } });
    const after = E.emulatorInfo();
    const sig2 = statSync(after.library64).mtimeMs + ':' + after.interfaces64.length + ':' + after.commit;
    check(r.success === false && /HTTP 404|redirect|ENOTFOUND|timeout/i.test(r.error || ''), `a failed download reports its error (${r.error})`);
    check(sig === sig2, 'and leaves the installed emulator byte for byte where it was');
    const parent = dirname(before.dir);
    check(!existsSync(join(parent, 'Goldberg.new')) && !existsSync(join(parent, 'Goldberg.download')), 'and cleans up its working folders');
  } else {
    check(false, 'an emulator is installed to test the updater against');
  }
  done('unit');
}

// ── update ───────────────────────────────────────────────────────
async function suiteUpdate() {
  const E = emu();
  const before = E.emulatorInfo();
  console.log(`  info installed: commit ${before.commit || '?'} dated ${before.date ? new Date(before.date).toISOString().slice(0, 10) : '?'}, ${before.interfaces64.length} interfaces`);
  const latest = await E.latestRelease({ force: true });
  check(latest && latest.publishedAt > 0 && (latest.tag || latest.name), `newest release known: ${latest && (latest.tag || latest.name)} (${latest && new Date(latest.publishedAt).toISOString().slice(0, 10)})`);
  const r = await E.updateEmulator({ onLog: (m) => console.log(`  sac  ${m}`) });
  check(r.success, 'SteamAutoCrack fetched the emulator');
  const after = E.emulatorInfo();
  console.log(`  info now: commit ${after.commit || '?'} dated ${after.date ? new Date(after.date).toISOString().slice(0, 10) : '?'}, ${after.interfaces64.length} interfaces`);
  const oldCommit = readFileSync(join(ROOT, 'dev', 'fixtures', 'gbe-2026-08-07.commit_id'), 'utf8').trim();
  check(after.commit && after.commit !== oldCommit, `installed commit differs from the 2026-08-07 build (${oldCommit.slice(0, 8)} -> ${(after.commit || '?').slice(0, 8)})`);
  check(after.interfaces64.includes('SteamUtils011'), 'the installed emulator now names SteamUtils011');
  check(after.interfaces64.length > before.interfaces64.length || before.interfaces64.includes('SteamUtils011'), `interface count ${before.interfaces64.length} -> ${after.interfaces64.length}`);
  if (existsSync(MORTAL)) {
    const rc = E.check(MORTAL);
    console.log(`  info Mortal Shell II now: missing ${rc.missing.join(', ') || 'none'}`);
    check(rc.compatible, 'Mortal Shell II passes the compatibility check with the installed emulator');
  }
  // The gate itself, offline: nothing left to fetch, answer is immediate.
  const gate = await E.ensureCompatible(MORTAL, { allowNetwork: false, onLog: () => {} });
  check(gate.ok && gate.reason === 'compatible', `gate answers ${gate.reason}`);
  done('update');
}

// ── realgame ─────────────────────────────────────────────────────
function suiteRealgame() {
  if (!existsSync(ELECTRON)) fail('electron is not installed');
  const r = run(ELECTRON, [join(ROOT, 'dev', 'emucompat-realgame.js')], { timeout: 600000 });
  process.stdout.write(r.out);
  try { mkdirSync(join(ROOT, 'dev', 'bin'), { recursive: true }); writeFileSync(join(ROOT, 'dev', 'bin', 'emucompat-realgame-last.log'), r.out); } catch { /* fine */ }
  if (r.status !== 0) fail(`realgame exited ${r.status}`);
  if (!/(^|\n)OK realgame\s*$/.test(r.stdout.trim() + '\n')) fail('realgame did not print its success line');
  console.log('OK realgame');
  process.exit(0);
}

// ── postlaunch ───────────────────────────────────────────────────
function suitePostlaunch() {
  const E = emu();
  const base = mkdtempSync(join(tmpdir(), 'emucompat-post-'));
  try {
    const dir = join(base, 'Engine', 'Binaries', 'ThirdParty', 'Steamworks', 'Steamv165', 'Win64');
    mkdirSync(dir, { recursive: true });
    const fmt = (d) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} - ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const old = new Date(Date.now() - 3 * 3600 * 1000);
    const fresh = new Date(Date.now() - 20 * 1000);
    writeFileSync(join(dir, 'EMU_MISSING_INTERFACE.txt'),
      `INTERFACE=SteamUtils011\nCALLER FN=Steam_Client::GetISteamUtils()\nAPPID=2584270\nTIME=${fmt(old)}\n--------------------\n\n`
      + `INTERFACE=SteamInput007\nCALLER FN=Steam_Client::GetISteamInput()\nAPPID=2584270\nTIME=${fmt(fresh)}\n--------------------\n\n`);
    const all = E.missingInterfaceReports(base);
    check(all.length === 2 && all[0].interface === 'SteamUtils011' && all[1].interface === 'SteamInput007' && all[0].appid === '2584270', `both entries parsed with names and app id (${all.map((r) => r.interface).join(', ')})`);
    const since = E.missingInterfaceReports(base, Date.now() - 10 * 60 * 1000);
    check(since.length === 1 && since[0].interface === 'SteamInput007', 'only the entry newer than the session start is returned');
    const none = E.missingInterfaceReports(base, Date.now() + 60 * 1000);
    check(none.length === 0, 'nothing when the session started after every entry');
    check(E.missingInterfaceReports(join(base, 'nowhere')).length === 0, 'a missing folder yields nothing');
    // The real report, as the game wrote it.
    if (existsSync(MORTAL)) {
      const real = E.missingInterfaceReports(MORTAL);
      check(real.length >= 5 && real.every((r) => r.interface === 'SteamUtils011'), `Mortal Shell II's own report reads back (${real.length} entries, all SteamUtils011)`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  done('postlaunch');
}

// ── pipeline ─────────────────────────────────────────────────────
function suitePipeline() {
  const E = emu();
  const ok = { ok: true, reason: 'compatible', missing: [] };
  const bad = { ok: false, reason: 'incompatible', missing: ['SteamUtils011'] };
  const cases = [
    [{ jobType: 'download', gate: ok }, true],
    [{ jobType: 'update', gate: ok }, true],
    [{ jobType: 'update', gate: bad }, false],
    [{ jobType: 'repair', wasCracked: true, gate: ok }, true],
    [{ jobType: 'repair', wasCracked: false, gate: ok }, false],
    [{ jobType: 'repair', wasCracked: true, gate: bad }, false],
    [{ jobType: 'download', online: true, gate: ok }, false],
    [{ jobType: 'download', skipAutoCrack: true, gate: ok }, false],
    [{ jobType: 'download', autoCrack: false, gate: ok }, false],
    [{ jobType: 'download', gate: null }, true],
  ];
  for (const [facts, expected] of cases) {
    const d = E.decide(facts);
    check(d.apply === expected && typeof d.reason === 'string' && d.reason.length > 0, `decide(${JSON.stringify(facts).replace(/"/g, '')}) -> ${d.apply} (${d.reason})`);
  }
  const bad2 = E.decide({ jobType: 'update', gate: bad });
  check(/SteamUtils011/.test(bad2.reason), 'an incompatible gate names what is missing in the reason');

  const engine = read(ROOT, 'src/core/steamPipe.js');
  check(/emuCompat\.ensureCompatible\(downloadDir/.test(engine), 'the engine runs the gate on the install before cracking');
  check(/emuCompat\.decide\(\{ \.\.\.facts, gate \}\)/.test(engine), 'the engine decides with the gate result');
  check(/emuCompat\.recordBlock\(gameRef/.test(engine) && /emuCompat\.clearBlock\(gameRef\)/.test(engine), 'the engine records and clears the block for the panel');
  check(/wasCracked: emuCompat\.wasCracked\(downloadDir\)/.test(engine), 'the engine tells the decision whether the game had the emulator');
  const appJs = read(ROOT, 'src/js/app.js');
  const repair = appJs.slice(appJs.indexOf('async function queueGameRepair'), appJs.indexOf('async function queueGameRepair') + 4000);
  check(/jobType: 'repair'/.test(repair) && !/skipAutoCrack: true/.test(repair), 'a verify no longer opts out of the emulator step');
  done('pipeline');
}

// ── integrity ────────────────────────────────────────────────────
const FLYOUT_IDS = ['flyout-emu', 'flyout-emu-row', 'flyout-emu-text', 'flyout-emu-title', 'flyout-emu-sub', 'flyout-emu-update', 'flyout-emu-note'];
const CRACK_IDS = ['crack-emu-build', 'crack-emu-build-text', 'crack-emu-update'];
const PARSE = ['main.js', 'preload.js', 'src/core/emuCompat.js', 'src/core/steamPipe.js', 'src/core/settingsStore.js', 'src/js/app.js', 'dev/emucompat-realgame.js'];

function integrity(root) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  const html = read(root, 'src/index.html');
  const appJs = read(root, 'src/js/app.js');
  const css = read(root, 'src/styles/enhance.css');
  const preload = read(root, 'preload.js');
  const main = read(root, 'main.js');
  const store = read(root, 'src/core/settingsStore.js');
  const engine = read(root, 'src/core/steamPipe.js');

  for (const id of [...FLYOUT_IDS, ...CRACK_IDS]) need(html.includes(`id="${id}"`), `index.html: #${id} missing`);
  need(/id="flyout-emu"\s+class="hidden"/.test(html), 'index.html: the panel does not start hidden');
  need(/async function renderEmuCompat\(/.test(appJs), 'app.js: renderEmuCompat not defined');
  need(/renderDlcPanel\(game\);\s*\n\s*renderEmuCompat\(game\);/.test(appJs), 'app.js: renderEmuCompat not rendered beside its neighbours');
  for (const id of ['flyout-emu-sub', 'flyout-emu-note', 'flyout-emu-update']) need(appJs.includes(`#${id}`), `app.js: #${id} never addressed`);
  need(/api\.onEmuIncompatible\?\.\(/.test(appJs), 'app.js: the post-launch event is not listened to');
  need(/api\.emuRecrack\(game\)/.test(appJs), 'app.js: the panel button does not call emuRecrack');
  need(/api\.emuUpdate\(\)/.test(appJs) && appJs.includes('#crack-emu-update') && appJs.includes('#crack-emu-build-text'), 'app.js: the Crack page update control is not wired');
  need(css.includes('#flyout-emu {') && css.includes('#flyout-emu-note'), 'enhance.css: no rules for the panel');
  need(css.split('{').length === css.split('}').length, 'enhance.css: unbalanced braces');

  const invoked = [...preload.matchAll(/ipcRenderer\.invoke\('(emu:[^']+)'/g)].map((m) => m[1]).sort();
  const handled = [...main.matchAll(/ipcMain\.handle\('(emu:[^']+)'/g)].map((m) => m[1]).sort();
  need(JSON.stringify(invoked) === JSON.stringify(['emu:recrack', 'emu:status', 'emu:update']), `preload.js: emu channels are ${invoked.join(', ')}`);
  need(JSON.stringify(handled) === JSON.stringify(invoked), `main.js: handlers ${handled.join(', ')} do not match preload`);
  need(/onIpc\('emu:incompatible'/.test(preload) && /(?:webContents\.send|sendToRenderer)\('emu:incompatible'/.test(main), 'the emu:incompatible event is not carried end to end');
  need(/missingInterfaceReports\(s\.install_path, s\.startedAt\)/.test(main), 'main.js: the post-launch check does not use the session start');
  need(/^\s{2}emu_auto_update: true,/m.test(store) && /^\s{2}emu_release_cache: \{\},/m.test(store), 'settingsStore.js: new keys not declared');
  need(/key === 'emu_release_cache'/.test(store), 'settingsStore.js: the release cache is not sanitised');
  need(/require\('\.\/emuCompat'\)/.test(engine), 'steamPipe.js: the gate module is not used');
  const repairAt = appJs.indexOf('async function queueGameRepair');
  const repairBlock = repairAt >= 0 ? appJs.slice(repairAt, repairAt + 4000) : '';
  need(repairAt >= 0 && /jobType: 'repair'/.test(repairBlock) && !/skipAutoCrack: true/.test(repairBlock), 'app.js: the repair job still opts out of the emulator');

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
  console.log(`  ${FLYOUT_IDS.length + CRACK_IDS.length} ids, 3 channels, ${PARSE.length} files parsed`);
  console.log('OK integrity');
  process.exit(0);
}

// ── self-test ────────────────────────────────────────────────────
const CHECKED_FILES = ['src/index.html', 'src/js/app.js', 'src/styles/enhance.css', 'preload.js', 'main.js', 'src/core/settingsStore.js', 'src/core/steamPipe.js', 'src/core/emuCompat.js', 'dev/emucompat-realgame.js'];
function suiteSelfTest() {
  const base = mkdtempSync(join(tmpdir(), 'emucompat-selftest-'));
  const copy = (name) => { const dir = join(base, name); for (const f of CHECKED_FILES) { mkdirSync(dirname(join(dir, f)), { recursive: true }); cpSync(join(ROOT, f), join(dir, f)); } return dir; };
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
    if (integrity(copy('clean')).length) fail('self-test: the clean copy does not pass integrity');
    sabotage('panel id removed', 'src/index.html', 'id="flyout-emu-update"', 'id="flyout-emu-update-x"');
    // Single-line anchors throughout: the sources may carry either line ending.
    sabotage('panel not rendered', 'src/js/app.js', '    renderEmuCompat(game);', '');
    sabotage('event not listened', 'src/js/app.js', 'api.onEmuIncompatible?.((info) => {', 'api.onEmuIncompatible_?.((info) => {');
    sabotage('handler removed', 'main.js', "ipcMain.handle('emu:recrack'", "ipcMain.handle('emu:recrack-gone'");
    sabotage('bridge call removed', 'preload.js', "emuUpdate: () => ipcRenderer.invoke('emu:update'),", '');
    sabotage('repair opts out again', 'src/js/app.js', "        jobType: 'repair',", "        jobType: 'repair', skipAutoCrack: true,");
    sabotage('setting default removed', 'src/core/settingsStore.js', '  emu_auto_update: true,', '  emu_auto_update_: true,');
    sabotage('engine ignores the gate', 'src/core/steamPipe.js', "require('./emuCompat')", "require('./emuCompat_')");
    sabotage('module broken', 'src/core/emuCompat.js', "const fs = require('fs');", "const fs = require('fs');\nlet let;");
    sabotage('css unbalanced', 'src/styles/enhance.css', '#flyout-emu {', '#flyout-emu {{');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  console.log('OK self-test');
  process.exit(0);
}

// ── pack ─────────────────────────────────────────────────────────
function suitePack() {
  const outDir = join(ROOT, 'dist', 'tuning-check');
  const r = run('cmd', ['/c', 'npm', 'run', 'pack', '--', `--config.directories.output=${outDir}`], { timeout: 900000 });
  process.stdout.write(r.out.split('\n').slice(-8).join('\n'));
  if (r.status !== 0) fail(`electron-builder --dir exited ${r.status}`);
  const unpacked = join(outDir, 'win-unpacked');
  const asar = join(unpacked, 'resources', 'app.asar');
  if (!existsSync(asar)) fail('no app.asar produced');
  const head = readFileSync(asar).subarray(0, 4 * 1024 * 1024).toString('latin1');
  if (!head.includes('"emuCompat.js"')) fail('asar does not list emuCompat.js');
  const dll = join(unpacked, 'resources', 'deps', 'SteamAutoCrack', 'Goldberg', 'x64', 'steam_api64.dll');
  if (!existsSync(dll)) fail('packaged emulator library missing');
  if (!readFileSync(dll).toString('latin1').includes('SteamUtils011')) fail('packaged emulator does not name SteamUtils011');
  console.log('OK pack');
  process.exit(0);
}

const SUITES = { unit: suiteUnit, update: suiteUpdate, realgame: suiteRealgame, postlaunch: suitePostlaunch, pipeline: suitePipeline, integrity: suiteIntegrity, 'self-test': suiteSelfTest, pack: suitePack };
if (!SUITES[suite]) { console.error(`usage: node dev/verify-emucompat.mjs <${Object.keys(SUITES).join('|')}>`); process.exit(2); }
await SUITES[suite]();
