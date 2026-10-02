/**
 * Build the Steam API proxy.
 *
 * Takes a real steam_api64.dll, generates a .def that forwards every export
 * except the handful in generate.js, compiles proxy.c against it, and then
 * verifies the result by reading the produced DLL's own export table — a proxy
 * missing even one symbol is a game that will not start, so "it linked" is not
 * good enough on its own.
 *
 * Usage: node build.js <real steam_api64.dll> [outDir] [--cc <path to gcc>]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { generate, HOOKED, ORIGINAL_STEM } = require('./generate');
const { readExports } = require('../../tools/peExports');

function findCompiler(explicit) {
  if (explicit) return explicit;
  if (process.env.LIBRARIAN_CC) return process.env.LIBRARIAN_CC;
  // Whatever is on PATH, then the toolchain we unpack into the scratch dir.
  for (const cc of ['gcc', 'x86_64-w64-mingw32-gcc', 'clang']) {
    try {
      execFileSync(cc, ['--version'], { stdio: 'ignore' });
      return cc;
    } catch { /* keep looking */ }
  }
  return null;
}

function build(realDll, outDir, ccOverride) {
  const sources = Array.isArray(realDll) ? realDll : String(realDll).split(path.delimiter).filter(Boolean);
  for (const src of sources) {
    if (!fs.existsSync(src)) throw new Error(`real steam_api64.dll not found: ${src}`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const cc = findCompiler(ccOverride);
  if (!cc) throw new Error('no C compiler found (set LIBRARIAN_CC or put gcc on PATH)');

  const defPath = path.join(outDir, 'exports.def');
  const gen = generate(sources, defPath);

  const outDll = path.join(outDir, 'steam_api64.dll');
  const args = [
    '-shared',
    '-O2', '-s',
    '-o', outDll,
    path.join(__dirname, 'proxy.c'),
    path.join(__dirname, '..', 'overlay', 'overlay.c'),
    defPath,
    '-static-libgcc',
    '-Wl,--enable-stdcall-fixup',
  ];
  execFileSync(cc, args, { stdio: 'pipe' });

  // ── Verify against every library it stands in for ──
  // The union, not one source: building from several is the whole point, and
  // checking against just the first would let the others go short unnoticed.
  const originalExports = gen.union || readExports(sources[0]).exports;
  const built = readExports(outDll);
  const originalNames = new Set(originalExports.map(e => e.name));
  const builtNames = new Set(built.exports.map(e => e.name));

  const missing = [...originalNames].filter(n => !builtNames.has(n));
  const hookedSet = new Set(HOOKED);
  const forwarders = built.exports.filter(e => e.forwarder);
  const implemented = built.exports.filter(e => !e.forwarder);
  const wrongTarget = forwarders.filter(e => !e.forwarder.toLowerCase().startsWith(ORIGINAL_STEM.toLowerCase() + '.'));
  const notHooked = implemented.filter(e => !hookedSet.has(e.name));

  return {
    outDll,
    generated: gen,
    originalCount: originalExports.length,
    builtCount: built.exports.length,
    forwarders: forwarders.length,
    implemented: implemented.map(e => e.name),
    missing,
    wrongTarget: wrongTarget.map(e => `${e.name} -> ${e.forwarder}`),
    notHooked: notHooked.map(e => e.name),
    ok: missing.length === 0 && wrongTarget.length === 0 && notHooked.length === 0,
  };
}

module.exports = { build };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const ccIdx = argv.indexOf('--cc');
  const cc = ccIdx >= 0 ? argv[ccIdx + 1] : null;
  // Guard the absent-flag case: with no --cc, ccIdx is -1 and a naive
  // `i !== ccIdx + 1` silently drops argv[0] — the path to the real library.
  const positional = argv.filter((a, i) =>
    !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  const [realDll, outDir = path.join(__dirname, 'build')] = positional;
  if (!realDll) { console.error('usage: node build.js <real steam_api64.dll> [outDir] [--cc gcc]'); process.exit(1); }

  try {
    const r = build(realDll, outDir, cc);
    console.log(`built ${r.outDll}`);
    console.log(`  original exports : ${r.originalCount}`);
    console.log(`  built exports    : ${r.builtCount}  (${r.forwarders} forwarded, ${r.implemented.length} implemented)`);
    console.log(`  implemented      : ${r.implemented.join(', ')}`);
    if (r.missing.length) console.error(`  MISSING ${r.missing.length}: ${r.missing.slice(0, 10).join(', ')}`);
    if (r.wrongTarget.length) console.error(`  BAD FORWARDERS: ${r.wrongTarget.slice(0, 5).join(', ')}`);
    if (r.notHooked.length) console.error(`  UNEXPECTED REAL EXPORTS: ${r.notHooked.slice(0, 10).join(', ')}`);
    console.log(r.ok ? '\nPASS — every export accounted for' : '\nFAIL — see above');
    process.exit(r.ok ? 0 : 1);
  } catch (err) {
    console.error('build failed:', err.message);
    if (err.stderr) console.error(String(err.stderr).slice(0, 2000));
    process.exit(1);
  }
}
