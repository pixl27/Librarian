/**
 * Generate the export forwarders for the WinHTTP probe.
 *
 * Same pragma-forwarder trick as native/partyprobe: MSVC reads `name=target` in
 * a .def as an alias to a local symbol, so a genuine forwarder has to come from
 * /EXPORT: on the linker command line, and a generated header of
 * #pragma comment(linker, ...) is how you get a hundred of them there.
 *
 * winhttp.dll is not in HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\
 * KnownDLLs, which is the only reason this works at all — a KnownDLL is mapped
 * from System32 no matter what sits in the application directory, and the proxy
 * would simply never load. Check that again before pointing this at some other
 * system library.
 *
 * Usage: node generate.js <real winhttp.dll> <forwards.h>
 */
const fs = require('fs');
const path = require('path');
const { readExports } = require('../../tools/peExports');

const ORIGINAL_STEM = 'winhttp_o';

/*
 * The three calls that reconstruct a request end to end.
 *
 * Monster Hunter Wilds loads webio.dll, schannel and ncryptsslp about forty
 * seconds into a launch and then reports "connexion impossible". That is a real
 * outbound HTTPS request being refused, and the machine itself can reach
 * Capcom's endpoints fine, so the refusal is at the application layer. These
 * three say which endpoint and with what status:
 *
 *   Connect         -> the host
 *   OpenRequest     -> the verb and path
 *   ReceiveResponse -> the status code, queried from the real library afterwards
 *
 * Unlike the Party probe these use their true documented signatures rather than
 * four opaque registers, because WinHTTP is public Win32 whose prototypes are in
 * winhttp.h and do not move. Several of them take more than four arguments, so
 * the opaque trick would corrupt their stack arguments.
 */
const IMPLEMENTED = [
  'WinHttpConnect',
  'WinHttpOpenRequest',
  'WinHttpReceiveResponse',
  // A 401 says refused, not why. These four reconstruct the exchange itself —
  // the headers and body the game sent to /sign, and the error body Capcom sent
  // back — which is what separates "ticket rejected" from a region gate, a
  // missing account link, or a malformed request.
  'WinHttpAddRequestHeaders',
  'WinHttpSendRequest',
  'WinHttpWriteData',
  'WinHttpReadData',
  // Stub mode: to learn whether the game will proceed past the auth gate at all,
  // a configured request (e.g. /sign) can be answered with a synthetic 200 and
  // body without ever reaching Capcom. Overriding the status query and the
  // available-byte count, alongside ReadData above, is what makes the fake
  // response coherent to the caller. Everything is gated behind librarian_http.ini
  // so an ordinary run is still a pure pass-through.
  'WinHttpQueryHeaders',
  'WinHttpQueryDataAvailable',
  // The game uses async WinHTTP (WinHttpSetStatusCallback present, no ReadDataEx),
  // so a correct fake must drive the completion callbacks, not just return values.
  'WinHttpSetStatusCallback',
  'WinHttpOpen',   // read the session flags to confirm async vs sync
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
    if (IMPLEMENTED.includes(e.name)) { implemented++; continue; }
    lines.push(`#pragma comment(linker, "/EXPORT:${e.name}=${ORIGINAL_STEM}.${e.name}")`);
    forwarded++;
  }
  fs.mkdirSync(path.dirname(outHeader), { recursive: true });
  fs.writeFileSync(outHeader, lines.join('\n') + '\n');
  return { total: exports.length, forwarded, implemented };
}

module.exports = { generate, ORIGINAL_STEM, IMPLEMENTED };

if (require.main === module) {
  const [realDll, outHeader] = process.argv.slice(2);
  if (!realDll || !outHeader) { console.error('usage: node generate.js <winhttp.dll> <forwards.h>'); process.exit(1); }
  const r = generate(realDll, outHeader);
  console.log(`${r.total} exports -> ${r.forwarded} forwarded, ${r.implemented} implemented`);
}
