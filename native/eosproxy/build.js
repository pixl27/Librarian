/**
 * Build the EOS SDK proxy.
 *
 * Same contract as the Steam proxy's build.js: generate a .def forwarding every
 * export to the genuine SDK except the handful proxy.c answers itself, compile,
 * then read the produced DLL's own export table back and check it. A proxy
 * missing one symbol is a game that will not start, so "it linked" is not
 * evidence of anything.
 *
 * The overlay loader (../overlay) is compiled in here rather than kept separate:
 * it needs to run inside the game's process and this is already there.
 *
 * Usage:
 *   node build.js <genuine EOSSDK-Win64-Shipping.dll> [outDir]
 *        --include <EOS SDK Include dir>  [--cc <gcc>]
 *
 * The include directory is Epic's SDK headers (SDK/Include from the EOS SDK
 * download); LIBRARIAN_EOS_INCLUDE works instead of the flag.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { generate, readImplemented, ORIGINAL_STEM } = require('./generate');
const { readExports } = require('../../tools/peExports');

function findCompiler(explicit) {
  if (explicit) return explicit;
  if (process.env.LIBRARIAN_CC) return process.env.LIBRARIAN_CC;
  for (const cc of ['gcc', 'x86_64-w64-mingw32-gcc', 'clang']) {
    try { execFileSync(cc, ['--version'], { stdio: 'ignore' }); return cc; } catch { /* keep looking */ }
  }
  return null;
}

function build(realDll, outDir, opts = {}) {
  if (!fs.existsSync(realDll)) throw new Error(`genuine EOS SDK not found: ${realDll}`);
  const include = opts.include || process.env.LIBRARIAN_EOS_INCLUDE;
  if (!include || !fs.existsSync(include)) {
    throw new Error('EOS SDK headers not found (pass --include <SDK/Include> or set LIBRARIAN_EOS_INCLUDE)');
  }
  const cc = findCompiler(opts.cc);
  if (!cc) throw new Error('no C compiler found (set LIBRARIAN_CC or put gcc on PATH)');

  fs.mkdirSync(outDir, { recursive: true });
  const defPath = path.join(outDir, 'exports.def');
  const gen = generate(realDll, defPath);

  const outDll = path.join(outDir, 'EOSSDK-Win64-Shipping.dll');
  execFileSync(cc, [
    '-shared', '-O2', '-s',
    '-o', outDll,
    path.join(__dirname, 'proxy.c'),
    path.join(__dirname, '..', 'overlay', 'overlay.c'),
    defPath,
    '-I', include,
    '-static-libgcc',
    '-Wl,--enable-stdcall-fixup',
  ], { stdio: 'pipe' });

  // ── Verify against the library it stands in for ──
  const original = readExports(realDll).exports;
  const built = readExports(outDll).exports;
  const originalNames = new Set(original.map(e => e.name));
  const builtNames = new Set(built.map(e => e.name));

  const implemented = built.filter(e => !e.forwarder).map(e => e.name);
  const forwarders = built.filter(e => e.forwarder);
  const expected = readImplemented(path.join(__dirname, 'proxy.c'));

  const missing = [...originalNames].filter(n => !builtNames.has(n));
  // Anything we export that the genuine SDK does not is a symbol no game can
  // ask for — harmless, but it means the .def drifted from its source.
  const extra = [...builtNames].filter(n => !originalNames.has(n));
  const wrongTarget = forwarders
    .filter(e => !e.forwarder.toLowerCase().startsWith(ORIGINAL_STEM.toLowerCase() + '.'))
    .map(e => `${e.name} -> ${e.forwarder}`);
  const unexpected = implemented.filter(n => !expected.has(n));

  return {
    outDll, generated: gen,
    originalCount: original.length,
    builtCount: built.length,
    forwarders: forwarders.length,
    implemented, missing, extra, wrongTarget, unexpected,
    ok: !missing.length && !extra.length && !wrongTarget.length && !unexpected.length,
  };
}

module.exports = { build };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const positional = argv.filter((a, i) =>
    !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  const [realDll, outDir = path.join(__dirname, 'build')] = positional;

  if (!realDll) {
    console.error('usage: node build.js <genuine EOSSDK-Win64-Shipping.dll> [outDir] --include <SDK/Include>');
    process.exit(1);
  }
  try {
    const r = build(realDll, outDir, { include: flag('--include'), cc: flag('--cc') });
    console.log(`built ${r.outDll}`);
    console.log(`  genuine exports : ${r.originalCount}`);
    console.log(`  built exports   : ${r.builtCount}  (${r.forwarders} forwarded, ${r.implemented.length} implemented)`);
    console.log(`  implemented     : ${r.implemented.join(', ')}`);
    if (r.missing.length)    console.error(`  MISSING ${r.missing.length}: ${r.missing.slice(0, 10).join(', ')}`);
    if (r.extra.length)      console.error(`  EXTRA ${r.extra.length}: ${r.extra.slice(0, 10).join(', ')}`);
    if (r.wrongTarget.length) console.error(`  BAD FORWARDERS: ${r.wrongTarget.slice(0, 5).join(', ')}`);
    if (r.unexpected.length) console.error(`  UNDECLARED REAL EXPORTS: ${r.unexpected.join(', ')}`);
    console.log(r.ok ? '\nPASS — every export accounted for' : '\nFAIL — see above');
    process.exit(r.ok ? 0 : 1);
  } catch (err) {
    console.error('build failed:', err.message);
    if (err.stderr) console.error(String(err.stderr).slice(0, 2000));
    process.exit(1);
  }
}
