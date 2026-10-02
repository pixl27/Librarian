/**
 * Build the winmm proxy.
 *
 * Takes the genuine System32 winmm.dll, generates a .def forwarding every export
 * to winmm_o, compiles proxy.c + overlay.c against it, then reads the produced
 * DLL's own export table back to confirm nothing was dropped. A winmm proxy
 * missing one export is a game that will not start — winmm is imported
 * statically — so "it linked" is not evidence on its own.
 *
 * Usage: node build.js [real winmm.dll] [outDir] [--cc <gcc>]
 *   Defaults to C:\Windows\System32\winmm.dll.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { generate, ORIGINAL_STEM } = require('./generate');
const { readExports } = require('../../tools/peExports');

function findCompiler(explicit) {
  if (explicit) return explicit;
  if (process.env.LIBRARIAN_CC) return process.env.LIBRARIAN_CC;
  for (const cc of ['gcc', 'x86_64-w64-mingw32-gcc', 'clang']) {
    try { execFileSync(cc, ['--version'], { stdio: 'ignore' }); return cc; } catch { /* keep looking */ }
  }
  return null;
}

function build(realDll, outDir, ccOverride) {
  if (!fs.existsSync(realDll)) throw new Error(`real winmm.dll not found: ${realDll}`);
  fs.mkdirSync(outDir, { recursive: true });

  const cc = findCompiler(ccOverride);
  if (!cc) throw new Error('no C compiler found (set LIBRARIAN_CC or put gcc on PATH)');

  const defPath = path.join(outDir, 'winmm.def');
  const gen = generate(realDll, defPath);

  const outDll = path.join(outDir, 'winmm.dll');
  execFileSync(cc, [
    '-shared', '-O2', '-s',
    '-o', outDll,
    path.join(__dirname, 'proxy.c'),
    path.join(__dirname, '..', 'overlay', 'overlay.c'),
    defPath,
    '-static-libgcc',
    '-Wl,--enable-stdcall-fixup',
  ], { stdio: 'pipe' });

  const original = readExports(realDll).exports;
  const built = readExports(outDll).exports;
  const originalNames = new Set(original.map(e => e.name));
  const builtNames = new Set(built.map(e => e.name));

  const missing = [...originalNames].filter(n => !builtNames.has(n));
  const forwarders = built.filter(e => e.forwarder);
  const implemented = built.filter(e => !e.forwarder);   // expected: none
  const wrongTarget = forwarders.filter(e => !e.forwarder.toLowerCase().startsWith(ORIGINAL_STEM.toLowerCase() + '.'));

  return {
    outDll, generated: gen,
    originalCount: original.length,
    builtCount: built.length,
    forwarders: forwarders.length,
    implemented: implemented.map(e => e.name),
    missing,
    wrongTarget: wrongTarget.map(e => `${e.name} -> ${e.forwarder}`),
    ok: missing.length === 0 && wrongTarget.length === 0 && implemented.length === 0,
  };
}

module.exports = { build };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const ccIdx = argv.indexOf('--cc');
  const cc = ccIdx >= 0 ? argv[ccIdx + 1] : null;
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  const realDll = positional[0] || 'C:\Windows\System32\winmm.dll';
  const outDir = positional[1] || path.join(__dirname, 'build');

  try {
    const r = build(realDll, outDir, cc);
    console.log(`built ${r.outDll}`);
    console.log(`  genuine exports : ${r.originalCount}`);
    console.log(`  built exports   : ${r.builtCount}  (${r.forwarders} forwarded)`);
    if (r.missing.length) console.error(`  MISSING ${r.missing.length}: ${r.missing.slice(0, 10).join(', ')}`);
    if (r.wrongTarget.length) console.error(`  BAD FORWARDERS: ${r.wrongTarget.slice(0, 5).join(', ')}`);
    if (r.implemented.length) console.error(`  UNEXPECTED REAL EXPORTS: ${r.implemented.join(', ')}`);
    console.log(r.ok ? '\nPASS — every export accounted for' : '\nFAIL — see above');
    process.exit(r.ok ? 0 : 1);
  } catch (err) {
    console.error('build failed:', err.message);
    if (err.stderr) console.error(String(err.stderr).slice(0, 2000));
    process.exit(1);
  }
}
