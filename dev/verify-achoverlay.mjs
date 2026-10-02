#!/usr/bin/env node
/**
 * Verify the achievement watch in librarian_achoverlay.dll against a real
 * Steamworks library — the Big Walk crash of 2026-09-05, reproduced and
 * checked without launching a game.
 *
 * What went wrong then: the watch asked the Steam client for
 * STEAMUSERSTATS_INTERFACE_VERSION013 while the game's steam_api64_o.dll
 * (Steamworks 1.53a) had its flat exports compiled for VERSION012, so every
 * call landed one vtable slot off, "GetNumAchievements" returned a pointer,
 * and "GetAchievementName" returned a status code that was then read as a
 * string. The watch now asks the library which version it was built for
 * (its SteamAPI_SteamUserStats_vNNN accessor, then the version string in its
 * image), refuses anything that does not look like a count or a name, and
 * runs under a handler. This script exercises each of those paths by
 * pinning LIBRARIAN_ACH_STATS and reading the overlay's log.
 *
 * Builds native/achoverlay/verify/host.c with MSVC (same toolchain as the
 * overlay), then for each mode loads <plugins>\steam_api64.dll, initialises
 * Steam from <root> (its steam_appid.txt picks the app — 480 is what online
 * mode uses), loads the overlay, waits, shuts down. Steam must be running
 * and logged in unless <plugins> holds an emulator.
 *
 *   node dev/verify-achoverlay.mjs [--root <game root>] [--plugins <dir>]
 *                                  [--dll <librarian_achoverlay.dll>] [--seconds N]
 *
 * Defaults: Big Walk under E:\Games\steam\steamapps\common and the overlay
 * in deps/librarian. Point --plugins at another steam_api64.dll (a bare
 * Valve library from a newer SDK, an emulator) to cover that shape too; keep
 * --root on a folder whose steam_appid.txt says 480 for a Valve library.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const { findVcvars } = require(path.join(repo, 'native', 'achoverlay', 'build.js'));

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const BIG_WALK = 'E:\\Games\\steam\\steamapps\\common\\Big_Walk';
const root = opt('--root', BIG_WALK);
const plugins = opt('--plugins', path.join(BIG_WALK, 'Big Walk_Data', 'Plugins', 'x86_64'));
const dll = opt('--dll', path.join(repo, 'deps', 'librarian', 'librarian_achoverlay.dll'));
const seconds = Number(opt('--seconds', '8'));
const MODES = ['default', 'accessor', 'string', 'guess'];

for (const [what, p] of [['game root', root], ['plugin dir', plugins], ['overlay', dll]]) {
  if (!fs.existsSync(p)) { console.error(`${what} not found: ${p}`); process.exit(2); }
}
if (!fs.existsSync(path.join(plugins, 'steam_api64.dll'))) {
  console.error(`no steam_api64.dll in ${plugins}`); process.exit(2);
}

// ── Build the host ────────────────────────────────────────────────
const vcvars = findVcvars();
if (!vcvars) { console.error('vcvars64.bat not found (set LIBRARIAN_VCVARS)'); process.exit(2); }
const work = path.join(os.tmpdir(), 'librarian-achoverlay-verify');
fs.mkdirSync(work, { recursive: true });
const host = path.join(work, 'host.exe');
{
  const bat = path.join(work, 'build.bat');
  fs.writeFileSync(bat, [
    '@echo off',
    `call "${vcvars}" >nul 2>&1 || exit /b 1`,
    `cl /nologo /W3 /O2 /D_CRT_SECURE_NO_WARNINGS "${path.join(repo, 'native', 'achoverlay', 'verify', 'host.c')}" /Fe:"${host}" /link kernel32.lib`,
  ].join('\r\n'));
  try {
    execFileSync('cmd', ['/c', bat], { cwd: work, stdio: 'pipe' });
  } catch (err) {
    console.error('host build failed:\n' + [err.stdout, err.stderr].filter(Boolean).map(String).join('\n'));
    process.exit(2);
  }
}
const log = path.join(work, 'librarian_achoverlay.log');   // ov_log writes beside the executable

// ── Run each mode ─────────────────────────────────────────────────
console.log(`overlay : ${dll}`);
console.log(`library : ${path.join(plugins, 'steam_api64.dll')}`);
console.log(`app     : ${fs.existsSync(path.join(root, 'steam_appid.txt')) ? fs.readFileSync(path.join(root, 'steam_appid.txt'), 'utf8').trim() : '(no steam_appid.txt in root)'}`);

let failed = 0;
for (const mode of MODES) {
  fs.rmSync(log, { force: true });
  const env = { ...process.env };
  delete env.LIBRARIAN_ACH_STATS;
  if (mode !== 'default') env.LIBRARIAN_ACH_STATS = mode;

  const r = spawnSync(host, [root, plugins, dll, String(seconds)], { env, encoding: 'utf8', timeout: (seconds + 60) * 1000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(l => l.startsWith('[steam]')) : [];
  const text = lines.join('\n');
  const problems = [];

  const crashed = r.status !== 0;
  if (crashed) problems.push(`host exited with ${r.status === null ? r.signal : '0x' + (r.status >>> 0).toString(16)} — the overlay took the process down`);
  if (/SteamAPI_Init failed/.test(out)) problems.push('SteamAPI_Init failed: is Steam running and logged in, and does steam_appid.txt name an app you can run?');

  const via = text.match(/user stats via (.+)/)?.[1] ?? null;
  const count = text.match(/(\d+) achievement definition\(s\)/)?.[1];
  const refused = /is not a count|not readable/.test(text);
  const exportsAccessor = /SteamAPI_SteamUserStats_v\d+: exported/.test(out);

  if (!crashed && !/SteamAPI_Init failed/.test(out)) {
    if (!via) problems.push('the watch never resolved an interface');
    if (mode === 'accessor' && exportsAccessor && !/own accessor/.test(via || '')) problems.push(`accessor mode did not use the accessor: ${via}`);
    if (mode === 'default' && exportsAccessor && !/own accessor/.test(via || '')) problems.push(`default did not prefer the accessor: ${via}`);
    if (mode === 'string' && via && !/named in/.test(via)) problems.push(`string mode did not scan the image: ${via}`);
    if (mode === 'guess' && via && !/a guess/.test(via)) problems.push(`guess mode did not guess: ${via}`);
    if (count !== undefined && Number(count) > 5000) problems.push(`insane count accepted: ${count}`);
    if (mode !== 'guess' && !count && !refused) problems.push('no definitions read and nothing refused (library may report none; check the log)');
    if (mode === 'guess' && !count && !refused) problems.push('guess neither produced definitions nor refused');
  }

  const status = problems.length ? 'FAIL' : 'ok';
  if (problems.length) failed++;
  console.log(`\n[${status}] mode=${mode}${via ? `  via ${via}` : ''}${count !== undefined ? `  count=${count}` : ''}${refused ? '  (refused a mismatched interface)' : ''}`);
  for (const p of problems) console.log(`   ! ${p}`);
  for (const l of lines) console.log(`   ${l}`);
  if (problems.length) {
    console.log('   --- host output ---');
    for (const l of out.trim().split(/\r?\n/)) console.log(`   ${l}`);
  }
}

console.log(`\n${failed ? `${failed} mode(s) failed` : 'all modes passed'}`);
process.exit(failed ? 1 : 0);
