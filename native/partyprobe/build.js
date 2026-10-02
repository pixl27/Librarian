/**
 * Build the PlayFab Party probe.
 *
 * Unlike the other native modules this one is MSVC-only. The probe re-exports a
 * vendor DLL rather than a system one, and MSVC's linker handles a .def full of
 * `Name=Other.Name` forwarders alongside a few real exports without any of the
 * stdcall-fixup coaxing mingw needs. BuildTools is what is installed here, so
 * there is no second path to keep working.
 *
 * The verification at the end is the point of having a build script at all:
 * PartyWin.dll is a *static* import of MonsterHunterWilds.exe, so a single
 * dropped export is a process that dies before its entry point — and it would
 * look exactly like the crash we are trying to diagnose. "It linked" proves
 * nothing; the built export table is read back and compared name by name.
 *
 * Usage: node build.js <real PartyWin.dll> [outDir]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { generate, ORIGINAL_STEM, IMPLEMENTED } = require('./generate');
const { readExports } = require('../../tools/peExports');

const VCVARS = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat';

function findVcvars(explicit) {
  const candidates = [explicit, process.env.LIBRARIAN_VCVARS, VCVARS].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function build(realDll, outDir, vcvarsOverride) {
  if (!fs.existsSync(realDll)) throw new Error(`real PartyWin.dll not found: ${realDll}`);
  fs.mkdirSync(outDir, { recursive: true });

  const vcvars = findVcvars(vcvarsOverride);
  if (!vcvars) throw new Error('vcvars64.bat not found (set LIBRARIAN_VCVARS)');

  // Generated into outDir and reached via /I; probe.c includes it by name.
  const fwdPath = path.join(outDir, 'forwards.h');
  const gen = generate(realDll, fwdPath);

  const outDll = path.join(outDir, 'PartyWin.dll');
  /*
   * Driven from a .bat rather than `cmd /c "a && b"`.
   *
   * vcvars64.bat lives under "Program Files (x86)", so its path needs quoting,
   * and quoting it inside an already-quoted /c argument is where this stops
   * being worth debugging. A file also keeps the exact compiler invocation
   * around next to the output when something needs to be reproduced by hand.
   * Paths are normalised to backslashes because a trailing "/" before a closing
   * quote reads as an escape to the shell.
   */
  const win = p => path.resolve(p).replace(/\//g, '\\');
  const batPath = path.join(outDir, 'build.bat');
  fs.writeFileSync(batPath, [
    '@echo off',
    `call "${win(vcvars)}" >nul || exit /b 1`,
    [
      'cl /nologo /LD /O2 /W3 /D_CRT_SECURE_NO_WARNINGS',
      `/I"${win(outDir)}"`,
      `"${win(path.join(__dirname, 'probe.c'))}"`,
      `/Fo"${win(outDir)}\\\\"`,
      `/Fe"${win(outDll)}"`,
      '/link', '/OPT:NOREF',
    ].join(' '),
    'exit /b %ERRORLEVEL%',
  ].join('\r\n') + '\r\n');

  execFileSync('cmd.exe', ['/c', win(batPath)], { stdio: 'pipe', cwd: outDir });

  const original = readExports(realDll).exports;
  const built = readExports(outDll).exports;
  const originalNames = new Set(original.map(e => e.name));
  const builtNames = new Set(built.map(e => e.name));

  const missing = [...originalNames].filter(n => !builtNames.has(n));
  const extra = [...builtNames].filter(n => !originalNames.has(n));
  const forwarders = built.filter(e => e.forwarder);
  const real = built.filter(e => !e.forwarder);

  // Every forwarder must point at the renamed genuine copy, and the only
  // non-forwarding exports may be the ones probe.c deliberately implements.
  const wrongTarget = forwarders
    .filter(e => !e.forwarder.toLowerCase().startsWith(ORIGINAL_STEM.toLowerCase() + '.'))
    .map(e => `${e.name} -> ${e.forwarder}`);
  const unexpectedReal = real.map(e => e.name).filter(n => !IMPLEMENTED.includes(n));
  const notImplemented = IMPLEMENTED.filter(n => !real.some(e => e.name === n));

  return {
    outDll,
    generated: gen,
    originalCount: original.length,
    builtCount: built.length,
    forwarders: forwarders.length,
    realExports: real.map(e => e.name),
    missing, extra, wrongTarget, unexpectedReal, notImplemented,
    ok: missing.length === 0 && extra.length === 0 && wrongTarget.length === 0
      && unexpectedReal.length === 0 && notImplemented.length === 0,
  };
}

module.exports = { build };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const realDll = argv[0];
  const outDir = argv[1] || path.join(__dirname, 'build');
  if (!realDll) { console.error('usage: node build.js <real PartyWin.dll> [outDir]'); process.exit(1); }

  try {
    const r = build(realDll, outDir);
    console.log(`built ${r.outDll}`);
    console.log(`  genuine exports : ${r.originalCount}`);
    console.log(`  built exports   : ${r.builtCount}  (${r.forwarders} forwarded, ${r.realExports.length} implemented)`);
    console.log(`  implemented     : ${r.realExports.join(', ') || '(none)'}`);
    if (r.missing.length)        console.error(`  MISSING ${r.missing.length}: ${r.missing.slice(0, 10).join(', ')}`);
    if (r.extra.length)          console.error(`  EXTRA: ${r.extra.slice(0, 10).join(', ')}`);
    if (r.wrongTarget.length)    console.error(`  BAD FORWARDERS: ${r.wrongTarget.slice(0, 5).join(', ')}`);
    if (r.unexpectedReal.length) console.error(`  UNEXPECTED REAL EXPORTS: ${r.unexpectedReal.join(', ')}`);
    if (r.notImplemented.length) console.error(`  PROBE TARGETS FORWARDED INSTEAD: ${r.notImplemented.join(', ')}`);
    console.log(r.ok ? '\nPASS — every export accounted for' : '\nFAIL — see above');
    process.exit(r.ok ? 0 : 1);
  } catch (err) {
    console.error('build failed:', err.message);
    if (err.stdout) console.error(String(err.stdout).slice(0, 3000));
    if (err.stderr) console.error(String(err.stderr).slice(0, 3000));
    process.exit(1);
  }
}
