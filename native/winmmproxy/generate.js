/**
 * Generate the linker .def for the winmm proxy.
 *
 * Same shape as the Steam and EOS proxies, one library down: winmm.dll is a
 * standard system DLL that UnityPlayer (and many other engines) import
 * statically, so a copy sitting in the game folder is loaded by the OS at
 * process start — before the game creates its graphics device. That timing is
 * the entire reason this exists: the Steam overlay must attach before the first
 * Present, and loading it when steam_api64 wakes up (much later) is too late.
 *
 * Every export of the real winmm is re-declared as a loader forwarder to
 * winmm_o.dll — our copy of the genuine System32 library, renamed. No thunks,
 * no per-call cost; the proxy is transparent for all 180 calls and does exactly
 * one extra thing, in proxy.c: start the overlay loader, early.
 *
 * Usage: node generate.js <real winmm.dll> <out.def>
 */
const fs = require('fs');
const path = require('path');
const { readExports } = require('../../tools/peExports');

const ORIGINAL_STEM = 'winmm_o';

function generate(realDll, outDef) {
  const { dllName, exports } = readExports(realDll);
  if (!exports.length) throw new Error(`no exports found in ${realDll}`);

  const lines = [
    `; Generated from ${dllName} (${exports.length} exports) — do not edit by hand.`,
    'EXPORTS',
  ];
  let forwarded = 0;
  for (const e of exports) {
    // winmm exports purely by name; forward each to the renamed genuine copy.
    lines.push(`  ${e.name}=${ORIGINAL_STEM}.${e.name}`);
    forwarded++;
  }
  fs.mkdirSync(path.dirname(outDef), { recursive: true });
  fs.writeFileSync(outDef, lines.join('\n') + '\n');
  return { total: exports.length, forwarded, union: exports };
}

module.exports = { generate, ORIGINAL_STEM };

if (require.main === module) {
  const [realDll, outDef] = process.argv.slice(2);
  if (!realDll || !outDef) { console.error('usage: node generate.js <winmm.dll> <out.def>'); process.exit(1); }
  const r = generate(realDll, outDef);
  console.log(`${r.total} exports -> ${r.forwarded} forwarded`);
}
