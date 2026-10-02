#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Online mode against installs whose Steam identity is their loader's.
//
//   node dev/verify-online-identity.mjs <suite>
//
// Each suite prints its failures and, only when every assertion passed, the
// line `OK <suite>` and exits 0. The token is produced after the assertions,
// so a crash cannot be mistaken for a pass.
//
// Fixtures are ordinary directories in the system temp folder. Nothing here
// launches a game, loads a driver, or writes to a real install — the one suite
// that touches the live Monster Hunter Wilds folder (`realgame`) only reads it.
// ═══════════════════════════════════════════════════════════════════
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Module from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const WORK = mkdtempSync(join(tmpdir(), 'librarian-online-identity-'));

/*
 * onlineMode reaches valheimOnline -> runtimePaths -> electron on the ordinary
 * path (the `plain` suite exercises exactly that). Electron is not loadable
 * from plain node, so it is stubbed with the two members runtimePaths and
 * settingsStore actually read. The stub is installed before any src/core module
 * is required, and deliberately says isPackaged:false so getDepsRoot resolves
 * to the repository's own deps/ directory.
 */
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => join(WORK, 'userdata') }, safeStorage: { isEncryptionAvailable: () => false } };
  }
  return load.call(this, request, ...rest);
};

const multiplayer = require(join(ROOT, 'src/core/multiplayer.js'));
const onlineMode = require(join(ROOT, 'src/core/onlineMode.js'));
const launcher = require(join(ROOT, 'src/core/launcher.js'));

// ── fixtures ──────────────────────────────────────────────────────
function put(dir, relPath, body = '') {
  const target = join(dir, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  return target;
}

function fixture(name, files) {
  const dir = join(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) put(dir, rel, body);
  return dir;
}

/** The shape this work came from: ColdClient loader, hypervisor, staged token. */
const WILDS_SHAPE = {
  'game.exe': 'MZ not-a-real-pe',
  'version.dll': 'coldclient loader',
  'steamclient64.dll': 'emulated steam client',
  'reflex.dll': 'hypervisor loader',
  'reflex.ini': '[config]\ntarget = game.exe\n',
  'driver_amd/SimpleSvm.sys': 'driver',
  'PartyWin.dll': 'playfab party',
  'steam_settings/steam_appid.txt': '2246340',
  'userdata/1839456983/2246340/94212889276': 'activation token',
};

/** An ordinary cracked game: emulator in place, backup beside it, no loader. */
const GOLDBERG_SHAPE = {
  'game.exe': 'MZ not-a-real-pe',
  'steam_api64.dll': 'emulator',
  'steam_api64.dll.bak': 'genuine',
  'steam_settings/steam_appid.txt': '480000',
};

/** Every file in a tree, as path -> sha256, for proving nothing was touched. */
function snapshot(dir) {
  const out = new Map();
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.set(relative(dir, full), createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

function diff(before, after) {
  const changes = [];
  for (const [file, hash] of after) {
    if (!before.has(file)) changes.push(`added ${file}`);
    else if (before.get(file) !== hash) changes.push(`changed ${file}`);
  }
  for (const file of before.keys()) if (!after.has(file)) changes.push(`removed ${file}`);
  return changes;
}

// ── suites ────────────────────────────────────────────────────────
const SUITES = {
  /* The detector fires on a loader-owned install and stays quiet on a normal
     one. The negative half is the important half: a detector that answered
     "yes" everywhere would satisfy every other suite here. */
  detect(mp = multiplayer) {
    const fail = [];
    const wilds = fixture('detect-wilds', WILDS_SHAPE);
    const plain = fixture('detect-goldberg', GOLDBERG_SHAPE);

    const found = mp.detectDrmLoader(wilds);
    if (!found) return ['loader-owned install was not detected at all'];
    /*
     * version.dll is not among these, although the fixture carries one and it
     * is the real install's actual loader entry point. See DRM_LOADER_FILES in
     * src/core/multiplayer.js: the name is shared with ReShade, ASI loaders and
     * ordinary mods, so it is not evidence on its own. steamclient64.dll is.
     */
    for (const mark of ['reflex.ini', 'reflex.dll', 'steamclient64.dll', 'driver_amd/']) {
      if (!found.marks.includes(mark)) fail.push(`mark not reported: ${mark}`);
    }
    if (found.marks.includes('version.dll')) fail.push('version.dll was treated as a loader marker; it is too common a proxy name');
    if (found.token !== '1839456983/2246340') fail.push(`activation token misread: ${found.token}`);

    if (mp.detectDrmLoader(plain)) fail.push('an ordinary Goldberg install was reported as loader-owned');
    if (mp.detectDrmLoader(join(WORK, 'does-not-exist'))) fail.push('a missing directory was reported as loader-owned');

    // steam_settings alone must never count: that is every cracked game.
    const settingsOnly = fixture('detect-settings-only', { 'game.exe': 'x', 'steam_settings/steam_appid.txt': '1' });
    if (mp.detectDrmLoader(settingsOnly)) fail.push('steam_settings alone was treated as a loader');

    // PlayFab Party is a transport, not an identity owner, and Photon is not
    // disqualifying at all — Librarian supports Photon games deliberately.
    const party = mp.detectForeignTransport(wilds);
    if (!party || !/PlayFab/.test(party.label)) fail.push('PartyWin.dll was not recognised as a non-Steam transport');
    const photon = fixture('detect-photon', { 'game.exe': 'x', 'Photon3Unity3D.dll': 'x' });
    if (mp.detectForeignTransport(photon)) fail.push('Photon was treated as a non-Steam transport; PEAK depends on it not being');
    return fail;
  },

  /* Switching a loader-owned install on must be a record and nothing else. */
  preserve() {
    const fail = [];
    const dir = fixture('preserve', WILDS_SHAPE);
    const before = snapshot(dir);

    const result = onlineMode.enableOnline(dir, join(dir, 'game.exe'), 'Tester');
    if (!result.success) return [`enableOnline refused a loader-owned install: ${result.error}`];
    if (!result.preserved) fail.push('enableOnline did not report that it preserved the identity');

    if (existsSync(join(dir, 'steam_appid.txt'))) fail.push('steam_appid.txt was written into a loader-owned install');
    if (existsSync(join(dir, 'steam_api64_o.dll'))) fail.push('the Steam proxy was installed into a loader-owned install');
    if (existsSync(join(dir, 'librarian_online.ini'))) fail.push('librarian_online.ini was written into a loader-owned install');

    const changes = diff(before, snapshot(dir)).filter((c) => !c.includes('.DepotDownloader'));
    if (changes.length) fail.push(`files outside the marker folder changed: ${changes.join(', ')}`);

    const state = JSON.parse(readFileSync(join(dir, '.DepotDownloader/online-mode.json'), 'utf8'));
    if (state.mode !== 'online') fail.push(`recorded mode is ${state.mode}`);
    if (state.identity !== 'loader') fail.push(`recorded identity is ${state.identity}`);
    if (state.token !== '1839456983/2246340') fail.push('the recorded state does not name the activation token');
    return fail;
  },

  /* The control for "stopped doing it entirely". An ordinary install must
     still get the real switch: the App ID file is the thing that makes a
     Spacewar session happen at all, so its absence would mean the feature was
     removed rather than narrowed. */
  plain() {
    const fail = [];
    const dir = fixture('plain', { 'game.exe': 'MZ not-a-real-pe' });
    const result = onlineMode.enableOnline(dir, join(dir, 'game.exe'), 'Tester');
    if (!result.success) return [`enableOnline failed on an ordinary install: ${result.error}`];
    if (result.preserved) fail.push('an ordinary install was treated as loader-owned');

    const appIdFile = join(dir, 'steam_appid.txt');
    if (!existsSync(appIdFile)) fail.push('steam_appid.txt was not written for an ordinary install');
    else if (readFileSync(appIdFile, 'utf8').trim() !== '480') fail.push('steam_appid.txt does not say 480');

    const state = JSON.parse(readFileSync(join(dir, '.DepotDownloader/online-mode.json'), 'utf8'));
    if (state.identity === 'loader') fail.push('an ordinary install was recorded as loader-owned');
    return fail;
  },

  /* On, off, and the two things launch does every time. */
  roundtrip() {
    const fail = [];
    const dir = fixture('roundtrip', WILDS_SHAPE);
    const exe = join(dir, 'game.exe');

    onlineMode.enableOnline(dir, exe, 'Tester');

    const status = onlineMode.getStatus(dir, exe);
    if (status.mode !== 'online') fail.push(`getStatus reports ${status.mode} straight after switching on`);
    if (status.identity !== 'loader') fail.push('getStatus does not report the identity as the loader\'s');

    const check = onlineMode.verifyOnline(dir, exe);
    if (!check.intended) fail.push('verifyOnline does not see the recorded intent');
    if (!check.intact) fail.push(`verifyOnline wants repairs it cannot make: ${check.reasons.join('; ')}`);

    const before = snapshot(dir);
    const again = onlineMode.reapplyIfNeeded(dir, exe, 'Tester');
    if (again.reapplied) fail.push('launch re-applied the session swap to a loader-owned install');
    const touched = diff(before, snapshot(dir)).filter((c) => !c.includes('.DepotDownloader'));
    if (touched.length) fail.push(`launch changed files: ${touched.join(', ')}`);

    const off = onlineMode.disableOnline(dir, exe);
    if (!off.success) fail.push(`disableOnline failed: ${off.error}`);
    if (onlineMode.getStatus(dir, exe).mode !== 'offline') fail.push('the install did not read back as offline');
    const settled = diff(snapshot(dir), before).filter((c) => !c.includes('.DepotDownloader'));
    if (settled.length) fail.push(`switching off changed files: ${settled.join(', ')}`);
    return fail;
  },

  /* The overlay injector must treat a hypervisor release as guarded from its
     configuration file onwards. Keying only on driver_amd/ left a window: the
     driver folder is staged after the loader is already live, and a Wilds
     launch landed in exactly that window on 2026-09-15. */
  launcher() {
    const fail = [];
    const early = fixture('guard-early', { 'game.exe': 'x', 'reflex.ini': '[config]\n' });
    if (!launcher.isGuardedRelease(early)) fail.push('a reflex release was not guarded before its driver folder existed');

    const staged = fixture('guard-staged', { 'game.exe': 'x', 'driver_amd/SimpleSvm.sys': 'x' });
    if (!launcher.isGuardedRelease(staged)) fail.push('a staged driver folder is no longer guarded');

    const nested = fixture('guard-nested', { 'game.exe': 'x', 'Bin/reflex.dll': 'x' });
    if (!launcher.isGuardedRelease(nested)) fail.push('a loader one level down was not guarded');

    const plain = fixture('guard-plain', GOLDBERG_SHAPE);
    if (launcher.isGuardedRelease(plain)) fail.push('an ordinary install was reported as a guarded release');
    return fail;
  },

  /* The install this work came from. Read-only. */
  realgame(mp = multiplayer) {
    const dir = process.env.LIBRARIAN_WILDS || 'E:\\Games\\steam\\steamapps\\common\\Monster_Hunter_Wilds';
    if (!existsSync(dir)) return [`the install under test is not present: ${dir} (set LIBRARIAN_WILDS)`];

    const fail = [];
    const found = mp.detectDrmLoader(dir);
    if (!found) return [`${dir} was not detected as loader-owned`];
    // Same reasoning as the detect suite: the client loader, not the proxy name.
    for (const mark of ['reflex.ini', 'steamclient64.dll']) {
      if (!found.marks.includes(mark)) fail.push(`mark not reported for the real install: ${mark}`);
    }
    if (!found.token) fail.push('no activation token found in the real install');
    else if (!/^\d+\/2246340$/.test(found.token)) fail.push(`the token is not filed under this game's App ID: ${found.token}`);

    // It must not already be mid-switch: a leftover 480 would mean the install
    // is in the state that crashes, and this suite would be certifying it.
    if (existsSync(join(dir, 'steam_appid.txt'))) {
      const value = readFileSync(join(dir, 'steam_appid.txt'), 'utf8').trim();
      if (value === '480') fail.push('the real install still carries steam_appid.txt = 480');
    }
    if (existsSync(join(dir, 'steam_api64_o.dll'))) fail.push('the real install still carries the Steam proxy');
    return fail;
  },

  /* Negative control: disable the detector in a copy of multiplayer.js and
     require the detect and realgame suites to fail against it. Without this, a
     detector that answered "yes" to everything would certify itself. */
  'self-test'() {
    const fail = [];
    const source = readFileSync(join(ROOT, 'src/core/multiplayer.js'), 'utf8');
    const edits = [
      ['DRM_LOADER_FILES.includes(name)', 'false'],
      ['DRM_LOADER_DIRS.includes(name)', 'false'],
      ['return `${account.name}/${app.name}`;', 'return null;'],
      ['/\\.csrin\\.bak$/i.test(entry.name)', 'false'],
    ];
    let broken = source;
    for (const [from, to] of edits) {
      if (!broken.includes(from)) { fail.push(`self-test anchor missing, the mutation is stale: ${from}`); continue; }
      broken = broken.replace(from, to);
    }
    if (fail.length) return fail;

    const file = join(WORK, 'multiplayer-broken.cjs');
    writeFileSync(file, broken);
    const mutated = require(file);

    if (SUITES.detect(mutated).length === 0) fail.push('the detect suite passed against a disabled detector');
    if (SUITES.realgame(mutated).length === 0) fail.push('the realgame suite passed against a disabled detector');
    return fail;
  },
};

// ════════════════════════════════════════════════════════════════
const suite = process.argv[2];
if (!suite || !SUITES[suite]) {
  console.error(`usage: node dev/verify-online-identity.mjs <${Object.keys(SUITES).join('|')}>`);
  process.exit(2);
}

const failures = SUITES[suite]();
for (const f of failures) console.error(`FAIL ${suite}: ${f}`);
if (failures.length) process.exit(1);
console.log(`OK ${suite}`);
