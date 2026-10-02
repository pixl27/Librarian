/**
 * Generate the linker .def for the Steam API proxy.
 *
 * A game resolves Steamworks calls by name, so the proxy must export every
 * symbol the real library does — 1059 of them. Writing implementations for all
 * of those would be absurd and would break the moment Valve adds one, so all
 * but a handful are declared as *forwarders*:
 *
 *     SteamAPI_Init=steam_api64_o.SteamAPI_Init
 *
 * The Windows loader resolves a forwarder straight to the other DLL. There is
 * no thunk, no code, and no per-call cost — the proxy is genuinely transparent
 * for everything it does not deliberately answer itself.
 *
 * The export list is read from whatever steam_api64.dll is actually on disk
 * rather than hard-coded, so a newer Steamworks stays covered.
 *
 * Usage: node generate.js <real steam_api64.dll> <out.def>
 */

const fs = require('fs');
const path = require('path');
const { readExports } = require('../../tools/peExports');

// The real library, renamed. The proxy takes the original filename.
const ORIGINAL_STEM = 'steam_api64_o';

/**
 * The only functions the proxy answers itself. Everything else is forwarded.
 *
 * Each exists because a Spacewar session answers it for app 480 rather than
 * for the game, and the game asks about itself:
 *   · the ownership calls would say "you don't own this"
 *   · GetAppID would report 480 to game-side logic that expects its own id
 *   · RestartAppIfNecessary would try to relaunch the game through Steam
 */
const HOOKED = [
  'SteamAPI_ISteamApps_BIsSubscribed',
  'SteamAPI_ISteamApps_BIsSubscribedApp',
  'SteamAPI_ISteamApps_BIsSubscribedFromFreeWeekend',
  'SteamAPI_ISteamApps_BIsDlcInstalled',
  'SteamAPI_ISteamUtils_GetAppID',
  'SteamAPI_RestartAppIfNecessary',
  // Lobby scoping — see the note in proxy.c. Under Spacewar every lobby lives
  // in app 480's space, shared with everyone else using this trick, so a lobby
  // search returns strangers' games. These stamp our lobbies with the real App
  // ID and require it when searching.
  //
  // Four stamping points rather than one: a host that never writes lobby data
  // (it only sets the type and the member limit) used to go out unstamped, and
  // RequestLobbyList requires the key — so its lobby was invisible to our own
  // search. Every call a host makes on a fresh lobby is now an opportunity.
  'SteamAPI_ISteamMatchmaking_SetLobbyData',
  'SteamAPI_ISteamMatchmaking_SetLobbyType',
  'SteamAPI_ISteamMatchmaking_SetLobbyJoinable',
  'SteamAPI_ISteamMatchmaking_SetLobbyMemberLimit',
  'SteamAPI_ISteamMatchmaking_RequestLobbyList',
  'SteamAPI_ISteamMatchmaking_JoinLobby',
];

/*
 * Accepts several real libraries and exports the union of what they declare.
 *
 * One version is not enough, and not because newer ones only add. Measured on
 * two installs: PEAK ships a Steamworks with 1089 exports, Big Walk one with
 * 1059, and Big Walk has 19 symbols PEAK's does not — Valve retires names as
 * well as adding them. A proxy built from either alone fails the coverage check
 * on the other, so the game refuses to switch on for a reason the user cannot
 * act on.
 *
 * Exporting a symbol the game's own library lacks is harmless: a forwarder is
 * resolved only when something asks for it, and code compiled against an older
 * SDK never asks. The union is therefore the safe direction to be wrong in.
 */
function generate(realDll, outDef) {
  const sources = Array.isArray(realDll) ? realDll : [realDll];
  const seen = new Map();          // name -> ordinal-ish first-seen order
  let dllName = null;
  for (const src of sources) {
    const r = readExports(src);
    if (!dllName) dllName = r.dllName;
    for (const e of r.exports) if (!seen.has(e.name)) seen.set(e.name, e);
  }
  const exports = [...seen.values()];
  if (!exports.length) throw new Error(`no exports found in ${sources.join(', ')}`);

  const hooked = new Set(HOOKED);
  const present = new Set(exports.map(e => e.name));
  const missing = HOOKED.filter(n => !present.has(n));

  const lines = [
    `; Generated from ${dllName} (${exports.length} exports) — do not edit by hand.`,
    `; Regenerate with: node native/steamproxy/generate.js <steam_api64.dll> <out.def>`,
    'EXPORTS',
  ];

  let forwarded = 0;
  let implemented = 0;
  for (const e of exports) {
    if (hooked.has(e.name)) {
      lines.push(`  ${e.name}`);                    // defined in proxy.c
      implemented++;
    } else {
      lines.push(`  ${e.name}=${ORIGINAL_STEM}.${e.name}`);
      forwarded++;
    }
  }

  fs.mkdirSync(path.dirname(outDef), { recursive: true });
  fs.writeFileSync(outDef, lines.join('\n') + '\n');
  return { total: exports.length, forwarded, implemented, missing, union: exports };
}

module.exports = { generate, HOOKED, ORIGINAL_STEM };

if (require.main === module) {
  const [realDll, outDef] = process.argv.slice(2);
  if (!realDll || !outDef) {
    console.error('usage: node generate.js <real steam_api64.dll> <out.def>');
    process.exit(1);
  }
  const r = generate(realDll, outDef);
  console.log(`${r.total} exports -> ${r.forwarded} forwarded, ${r.implemented} implemented`);
  if (r.missing.length) {
    console.error(`WARNING: these hooks are not exported by this Steamworks build and were skipped:\n  ${r.missing.join('\n  ')}`);
  }
}
