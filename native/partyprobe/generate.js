/**
 * Generate the export forwarders for the PlayFab Party probe.
 *
 * Same shape as the winmm and Steam proxies: read the real DLL's export table
 * and re-declare every name, so nothing a statically-importing game asks for
 * can go missing. PartyWin.dll is a static import of MonsterHunterWilds.exe, so
 * one absent export is a process that never reaches its entry point.
 *
 * Emitted as a C header of linker pragmas rather than a .def, because MSVC
 * reads `name=target` in a .def as an alias to a *local* symbol and fails the
 * link with 154 unresolved externals. /EXPORT: on the linker command line is
 * the form that produces a genuine forwarder, and a pragma is how you get it
 * there without a 154-argument command.
 *
 * The difference from the other proxies is that this one is not fully
 * transparent. A handful of names are *implemented* rather than forwarded, so a
 * call passes through probe.c and gets logged on the way. Those are listed in
 * IMPLEMENTED; everything else becomes a loader forwarder to PartyWin_o.dll —
 * no thunk, no per-call cost.
 *
 * Why so few: a forwarder is safe regardless of a function's signature, but an
 * implemented export is not. The thunks in probe.c take four register
 * arguments and pass all four along, which is correct only for functions that
 * take at most four. Every name below was checked against the PlayFab Party C
 * API for that. Adding a fifth-argument function here would corrupt its stack
 * arguments, so keep this list short and checked.
 *
 * Usage: node generate.js <real PartyWin.dll> <forwards.h>
 */
const fs = require('fs');
const path = require('path');
const { readExports } = require('../../tools/peExports');

const ORIGINAL_STEM = 'PartyWin_o';

/*
 * The three calls that answer "where does the network descriptor travel?".
 *
 * PlayFab Party's documented join flow is: the host creates a network,
 * serializes its descriptor to a printable string, hands that string to some
 * out-of-band channel of the title's choosing, and the joiner deserializes it
 * and connects. That out-of-band channel is the whole question — it is either a
 * Steam lobby, which gbe_fork already emulates, or Capcom's own session
 * service, which it does not.
 *
 * Logging the string at both ends is what tells them apart, and both functions
 * take exactly two arguments, one of which is the char buffer.
 */
const IMPLEMENTED = [
  // (handle, titleId) — titleId is the PlayFab title, logged once at startup.
  'PartyInitialize',
  // (descriptor, outString) — the host's descriptor, readable after the call.
  'PartySerializeNetworkDescriptor',
  // (inString, descriptor) — what a joiner was handed, readable before it.
  'PartyDeserializeNetworkDescriptor',
];

function generate(realDll, outHeader) {
  const { dllName, exports } = readExports(realDll);
  if (!exports.length) throw new Error(`no exports found in ${realDll}`);

  const names = new Set(exports.map(e => e.name));
  const missing = IMPLEMENTED.filter(n => !names.has(n));
  if (missing.length) throw new Error(`probe targets absent from ${dllName}: ${missing.join(', ')}`);

  const lines = [
    `/* Generated from ${dllName} (${exports.length} exports) — do not edit by hand. */`,
    '#pragma once',
  ];
  let forwarded = 0;
  let implemented = 0;
  for (const e of exports) {
    if (IMPLEMENTED.includes(e.name)) {
      // Ours: probe.c defines and exports it with __declspec(dllexport).
      implemented++;
    } else {
      lines.push(`#pragma comment(linker, "/EXPORT:${e.name}=${ORIGINAL_STEM}.${e.name}")`);
      forwarded++;
    }
  }
  fs.mkdirSync(path.dirname(outHeader), { recursive: true });
  fs.writeFileSync(outHeader, lines.join('\n') + '\n');
  return { total: exports.length, forwarded, implemented };
}

module.exports = { generate, ORIGINAL_STEM, IMPLEMENTED };

if (require.main === module) {
  const [realDll, outHeader] = process.argv.slice(2);
  if (!realDll || !outHeader) { console.error('usage: node generate.js <PartyWin.dll> <forwards.h>'); process.exit(1); }
  const r = generate(realDll, outHeader);
  console.log(`${r.total} exports -> ${r.forwarded} forwarded, ${r.implemented} implemented`);
}
