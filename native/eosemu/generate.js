/**
 * Generate the EOS emulator's export surface from a real EOSSDK.
 *
 * Unlike the Steam proxy, nothing can be forwarded here: there is no real
 * backend to forward *to*. Every one of the ~679 exports has to exist in our
 * own DLL or the game hits a missing entry point the moment it calls one.
 *
 * The saving grace is that most of them never need to work. Big Walk
 * references 637 EOS symbols across 50 interfaces — RTCAudio, Ecom,
 * Leaderboards, AntiCheat — but its co-op only needs Platform, Connect, Lobby
 * and P2P. The rest can answer "not implemented" and the game carries on. That
 * is not a guess: the reference emulator answers all 54 anti-cheat calls as
 * stubs and Big Walk runs anyway.
 *
 * So this emits two things from whatever EOSSDK is on disk:
 *   · exports.def  — every symbol, so the DLL is a drop-in replacement
 *   · stubs.c      — a default implementation for everything not hand-written
 *
 * Reading the list off the real SDK rather than hard-coding it means a game
 * shipping a newer EOS stays covered without touching this file.
 *
 * Usage: node generate.js <real EOSSDK-Win64-Shipping.dll> <outDir>
 */

const fs = require('fs');
const path = require('path');
const { readExports } = require('../../tools/peExports');

/**
 * What core.c actually implements, read from core.c itself.
 *
 * This used to be a hand-written list of what we *intended* to implement, and
 * the two drifted immediately: the list named 35 functions, core.c defined 21,
 * and the 14 in between were excluded from the stubs while having no
 * definition anywhere — so the DLL would not link. Deriving the set from the
 * source removes the possibility: a function is implemented or it is stubbed,
 * and adding one to core.c is the only step needed.
 */
function readImplemented(coreFile) {
  let src;
  try { src = fs.readFileSync(coreFile, 'utf-8'); } catch { return new Set(); }
  const names = new Set();
  // EOS_DECLARE_FUNC(<return type>) EOS_Something(
  const re = /EOS_DECLARE_FUNC\s*\([^)]*\)\s*(EOS_[A-Za-z0-9_]+)\s*\(/g;
  for (const m of src.matchAll(re)) names.add(m[1]);
  return names;
}

/* EOS_EResult values we hand back from stubs. 0 = Success, 21 = NotImplemented. */
const EOS_SUCCESS = 0;
const EOS_NOTIMPLEMENTED = 21;

/**
 * A stub's return type cannot be read from the export table, so it is inferred
 * from EOS's own naming conventions — which are consistent enough to rely on:
 *
 *   EOS_*_Release / _Free        -> void
 *   EOS_*_Copy* / _Get* / _Add*  -> EOS_EResult or a handle
 *   EOS_*_Is*                    -> EOS_Bool
 *
 * Anything returning a pointer must return NULL rather than a made-up value,
 * and anything returning a result code says "not implemented" rather than
 * "success" — a false success makes a game wait forever for a callback that
 * will never arrive, which is far harder to diagnose than an honest failure.
 */
function classify(name) {
  if (/_(Release|Free|Shutdown)$/.test(name)) return 'void';
  if (/_Is[A-Z]/.test(name)) return 'bool';
  if (/_(Copy|Get)[A-Z]/.test(name)) return 'ptr_or_result';
  return 'result';
}

function generate(sdkPath, outDir, coreFile = path.join(__dirname, 'core.c')) {
  const IMPLEMENTED = readImplemented(coreFile);
  const { exports } = readExports(sdkPath);
  if (!exports.length) throw new Error(`no exports found in ${sdkPath}`);

  fs.mkdirSync(outDir, { recursive: true });

  const stubs = exports.filter(e => !IMPLEMENTED.has(e.name));
  const missing = [...IMPLEMENTED].filter(n => !exports.some(e => e.name === n));

  // ── exports.def ──
  const def = ['; Generated from the real EOSSDK — do not edit by hand.', 'EXPORTS'];
  for (const e of exports) def.push(`  ${e.name}`);
  fs.writeFileSync(path.join(outDir, 'exports.def'), def.join('\n') + '\n');

  // ── stubs.c ──
  const c = [
    '/* Generated: default answers for every EOS entry point we do not implement.',
    ' * See generate.js for why "not implemented" beats a fake success. */',
    '#include <stdint.h>',
    '#include <stddef.h>',
    '',
    `#define EOS_NOTIMPLEMENTED ${EOS_NOTIMPLEMENTED}`,
    '',
  ];
  for (const e of stubs) {
    const kind = classify(e.name);
    if (kind === 'void') {
      c.push(`void ${e.name}(void) { }`);
    } else if (kind === 'bool') {
      c.push(`int32_t ${e.name}(void) { return 0; }`);
    } else if (kind === 'ptr_or_result') {
      // Callers treat a null handle as "unavailable", which is the truth here.
      c.push(`void* ${e.name}(void) { return NULL; }`);
    } else {
      c.push(`int32_t ${e.name}(void) { return EOS_NOTIMPLEMENTED; }`);
    }
  }
  fs.writeFileSync(path.join(outDir, 'stubs.c'), c.join('\n') + '\n');

  return { total: exports.length, implemented: exports.length - stubs.length, stubs: stubs.length, missing };
}

module.exports = { generate, readImplemented, EOS_SUCCESS, EOS_NOTIMPLEMENTED };

if (require.main === module) {
  const [sdk, outDir] = process.argv.slice(2);
  if (!sdk || !outDir) { console.error('usage: node generate.js <EOSSDK-Win64-Shipping.dll> <outDir>'); process.exit(1); }
  const r = generate(sdk, outDir);
  console.log(`${r.total} exports -> ${r.implemented} hand-written, ${r.stubs} stubbed`);
  if (r.missing.length) {
    console.error(`\nWARNING: this SDK does not export ${r.missing.length} symbol(s) we planned to implement:`);
    console.error('  ' + r.missing.join('\n  '));
    console.error('(harmless — the game cannot call what its own SDK never had)');
  }
}
