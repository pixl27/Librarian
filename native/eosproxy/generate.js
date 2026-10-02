/**
 * Generate the .def for the EOS proxy.
 *
 * Same shape as the Steam proxy: everything the genuine SDK exports is
 * declared as a loader forwarder to it, except the handful proxy.c answers
 * itself. Forwarders cost nothing at runtime — the Windows loader resolves
 * them straight through — so the proxy is transparent for all ~679 calls it
 * does not deliberately intercept.
 *
 * Usage: node generate.js <genuine EOSSDK-Win64-Shipping.dll> <out.def>
 */
const fs = require('fs');
const path = require('path');
const { readExports } = require('../../tools/peExports');

const ORIGINAL_STEM = 'EOSSDK-Win64-Shipping_o';

/** Read what proxy.c implements, so the two can never drift. */
function readImplemented(coreFile) {
  let src;
  try { src = fs.readFileSync(coreFile, 'utf-8'); } catch { return new Set(); }
  const names = new Set();
  for (const m of src.matchAll(/EOS_DECLARE_FUNC\s*\([^)]*\)\s*(EOS_[A-Za-z0-9_]+)\s*\(/g)) names.add(m[1]);
  return names;
}

function generate(sdkPath, outDef, coreFile = path.join(__dirname, 'proxy.c')) {
  const implemented = readImplemented(coreFile);
  const { exports } = readExports(sdkPath);
  if (!exports.length) throw new Error(`no exports in ${sdkPath}`);

  const lines = [`; Generated from the genuine EOSSDK (${exports.length} exports).`, 'EXPORTS'];
  let forwarded = 0;
  for (const e of exports) {
    if (implemented.has(e.name)) lines.push(`  ${e.name}`);
    else { lines.push(`  ${e.name}=${ORIGINAL_STEM}.${e.name}`); forwarded++; }
  }
  fs.mkdirSync(path.dirname(outDef), { recursive: true });
  fs.writeFileSync(outDef, lines.join('\n') + '\n');
  return { total: exports.length, forwarded, implemented: implemented.size };
}

module.exports = { generate, readImplemented, ORIGINAL_STEM };

if (require.main === module) {
  const [sdk, out] = process.argv.slice(2);
  if (!sdk || !out) { console.error('usage: node generate.js <EOSSDK.dll> <out.def>'); process.exit(1); }
  const r = generate(sdk, out);
  console.log(`${r.total} exports -> ${r.forwarded} forwarded, ${r.implemented} intercepted`);
}
