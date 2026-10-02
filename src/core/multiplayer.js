/**
 * Does this game actually use Steam's networking?
 *
 * Online mode is only meaningful for games whose multiplayer runs through
 * Steam — lobbies, P2P sessions, NetworkingSockets. Store metadata ("Co-op",
 * "Multi-player") is a marketing tag and lies in both directions: it covers
 * splitscreen and it misses games whose co-op is a mode rather than a category.
 * The binary is the truth. A game that calls ISteamMatchmaking has the symbol
 * names sitting in it as ASCII, because that is how the import is resolved.
 *
 * The one trap: steam_api64.dll *exports* every one of these names, so scanning
 * it would mark every Steam game on disk as multiplayer. Only the consumers are
 * scanned — the game's own code.
 */

const fs = require('fs');
const path = require('path');

// Two families, because there are two ways to reach Steamworks and a game
// shows only one of them.
//
//  · Flat C API — "SteamAPI_ISteamMatchmaking_CreateLobby". Emitted by C#
//    bindings and IL2CPP builds, which resolve every call by name.
//  · Interface version strings — "SteamMatchMaking009". A native C++ game asks
//    SteamInternal_FindOrCreateUserInterface for an interface by version and
//    then calls through the vtable, so no per-method name ever appears. This is
//    the only trace Source 2 and C++ Unreal titles leave, and without it Dota 2
//    and Master Duel both read as single-player.
//
// Version suffixes are digits, so matching the trailing "0" of "009"/"012"
// keeps "SteamNetworking0" from colliding with "SteamNetworkingSockets012".
const MARKERS = [
  { key: 'sockets', needles: ['SteamAPI_ISteamNetworkingSockets_', 'SteamNetworkingSockets0'], label: 'NetworkingSockets / SDR' },
  { key: 'invites', needles: ['ActivateGameOverlayInviteDialog'], label: 'Friend invites' },
  { key: 'lobbies', needles: ['SteamAPI_ISteamMatchmaking_', 'SteamMatchMaking0'], label: 'Lobbies / matchmaking' },
  { key: 'p2p', needles: ['SteamAPI_ISteamNetworking_', 'SteamNetworking0', 'SteamNetworkingMessages0'], label: 'P2P sessions' },
];
const OVERLAP = Math.max(...MARKERS.flatMap(m => m.needles.map(n => n.length))) - 1;

// The emulator and Steam's own libraries export these names; they say nothing
// about the game. Scanning them would make everything look multiplayer.
const EXCLUDE_FILE = /^(steam_api(64)?|steamclient(64)?|steamnetworkingsockets(64)?|gameoverlayrenderer(64)?|tier0_s(64)?|vstdlib_s(64)?)\.dll$/i;
const EXCLUDE_DIR = /^(_commonredist|redist|directx|dotnet|vcredist|__pycache__|node_modules|\.git)$/i;

const SCAN_EXT = /\.(exe|dll|so)$/i;
/*
 * Files worth reading before the big ones.
 *
 * Ordering purely by size looks sensible and quietly loses whole engines. A
 * Unity game keeps its Steam calls in the Steamworks.NET wrapper — 417 KB in
 * PEAK — while the install is full of multi-megabyte engine libraries that
 * mention Steam nowhere. Twelve files sorted by size never reached it, so a
 * game doing Steam lobbies over Photon transport was reported as using no
 * networking at all and the toggle silently vanished.
 *
 * Size is still the right tiebreak; it just cannot be the only rule. These are
 * the places the answer actually lives: the SDK wrappers, and the game's own
 * code under whichever name its engine gives it.
 */
const PRIORITY_FILE = /(steamworks|facepunch|assembly-csharp|gameassembly)/i;
const MAX_FILES = 24;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;   // a 61 MB IL2CPP blob is normal; a whole install is not
const CHUNK = 4 * 1024 * 1024;

/** Every candidate binary, biggest first — game code outweighs launchers. */
function collectBinaries(gamePath, depth = 0, out = []) {
  if (depth > 8 || out.length > 400) return out;
  let entries;
  try { entries = fs.readdirSync(gamePath, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(gamePath, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIR.test(entry.name) || entry.name.startsWith('.')) continue;
      collectBinaries(full, depth + 1, out);
    } else if (entry.isFile() && SCAN_EXT.test(entry.name) && !EXCLUDE_FILE.test(entry.name)) {
      let size = 0;
      try { size = fs.statSync(full).size; } catch { continue; }
      out.push({ file: full, size });
    }
  }
  return out;
}

/** Search one file for the markers without ever holding it all in memory. */
async function scanFile(file, found, markers = MARKERS) {
  let handle;
  try { handle = await fs.promises.open(file, 'r'); } catch { return; }
  try {
    const buf = Buffer.allocUnsafe(CHUNK + OVERLAP);
    let carry = 0;              // bytes retained from the previous chunk
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, carry, CHUNK, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      const view = buf.subarray(0, carry + bytesRead);
      for (const marker of markers) {
        if (found[marker.key]) continue;            // one hit is enough
        if (marker.needles.some(n => view.includes(n, 0, 'latin1'))) found[marker.key] = true;
      }
      if (markers.every(m => found[m.key])) return; // nothing left to learn
      // Carry the tail so a marker split across the boundary is still seen.
      carry = Math.min(OVERLAP, view.length);
      view.subarray(view.length - carry).copy(buf, 0);
    }
  } catch {
    /* unreadable file tells us nothing; keep going */
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * @returns {Promise<{multiplayer: boolean, signals: object, evidence: string[], scanned: number}>}
 */
async function detectSteamMultiplayer(gamePath) {
  const empty = { multiplayer: false, signals: {}, evidence: [], scanned: 0 };
  if (!gamePath || !fs.existsSync(gamePath)) return empty;

  // Likely first, then biggest. Both halves stay size-ordered, so the budget is
  // still spent on substantial files rather than on stubs.
  const candidates = collectBinaries(gamePath)
    .sort((a, b) => {
      const pa = PRIORITY_FILE.test(path.basename(a.file)) ? 0 : 1;
      const pb = PRIORITY_FILE.test(path.basename(b.file)) ? 0 : 1;
      return pa - pb || b.size - a.size;
    });

  const found = {};
  let scanned = 0;
  let budget = MAX_TOTAL_BYTES;
  for (const candidate of candidates) {
    if (scanned >= MAX_FILES || budget <= 0) break;
    if (candidate.size > budget) continue;
    budget -= candidate.size;
    scanned++;
    await scanFile(candidate.file, found);
    if (MARKERS.every(m => found[m.key])) break;
  }

  // Lobbies or a P2P transport is what Online mode can actually help with.
  // An invite dialog alone is not enough — plenty of single-player games link
  // the overlay.
  const steamNet = !!(found.lobbies || found.p2p || found.sockets);

  // EOS is decided by a file the developer had to ship, then confirmed by the
  // game actually referencing its lobby/P2P entry points.
  const eosSdk = findEosSdk(gamePath);
  let eosSymbols = false;
  if (eosSdk) {
    const eosFound = {};
    const probe = [{ key: 'eos', needles: EOS_MARKERS }];
    for (const candidate of candidates.slice(0, MAX_FILES)) {
      if (eosFound.eos) break;
      await scanFile(candidate.file, eosFound, probe);
    }
    eosSymbols = !!eosFound.eos;
  }

  const backend = (eosSdk && eosSymbols) ? 'eos' : (steamNet ? 'steam' : 'none');
  return {
    multiplayer: steamNet || (eosSdk && eosSymbols),
    backend,
    steamNetworking: steamNet,
    eos: { sdk: eosSdk, symbols: eosSymbols },
    signals: found,
    evidence: MARKERS.filter(m => found[m.key]).map(m => m.label),
    canInvite: !!found.invites,
    scanned,
  };
}

/**
 * Which backend actually carries this game's multiplayer?
 *
 * "Sold on Steam" and "uses Steam's multiplayer" are different things. Epic
 * Online Services is free and cross-platform, so a Steam game advertising
 * cross-play almost always runs its lobbies and P2P through EOS and uses Steam
 * only for ownership and achievements. Big Walk is exactly that: an 8 MB
 * EOSSDK beside a 288 KB steam_api64.
 *
 * Two asymmetries matter when reading the evidence:
 *
 *  · The EOS SDK is a *separate file*. Its presence is hard evidence, because
 *    a game does not ship an 8 MB SDK it never calls.
 *  · Steam symbols in a C# / IL2CPP game are weak evidence. IL2CPP compiles in
 *    every P/Invoke declaration from Steamworks.NET whether or not the game
 *    calls it, so a purely single-player Unity title can carry the whole flat
 *    API. Interface *version strings* stay trustworthy: a native C++ game only
 *    emits "SteamMatchMaking009" where it actually asks for that interface.
 *
 * So when both appear, EOS wins — it is the one backed by a file the developer
 * had to deliberately ship.
 */
const EOS_SDK_FILE = /^EOSSDK-Win64-Shipping\.dll$/i;
const EOS_MARKERS = ['EOS_Lobby_', 'EOS_P2P_', 'EOS_Connect_Login', 'EOS_Sessions_'];

function findEosSdk(gamePath, depth = 0) {
  if (depth > 8) return null;
  let entries;
  try { entries = fs.readdirSync(gamePath, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const full = path.join(gamePath, entry.name);
    if (entry.isFile() && EOS_SDK_FILE.test(entry.name)) return full;
    if (entry.isDirectory() && !EXCLUDE_DIR.test(entry.name) && !entry.name.startsWith('.')) {
      const hit = findEosSdk(full, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

// Anti-cheat ships as its own service alongside the game and is unmissable on
// disk. It validates the session server-side, so a spoofed one is rejected by
// design — no client-side change reaches that check.
const ANTI_CHEAT = /^(easyanticheat|easyanticheat_eos|battleye|beservice|eac|anticheat)/i;

function detectAntiCheat(gamePath) {
  const found = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3 || found.length) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const base = entry.name.replace(/\.(exe|dll|sys|so)$/i, '');
      if (ANTI_CHEAT.test(base)) { found.push(entry.name); return; }
      if (entry.isDirectory() && !EXCLUDE_DIR.test(entry.name)) walk(path.join(dir, entry.name), depth + 1);
    }
  };
  try { walk(gamePath); } catch { /* best effort */ }
  return found[0] || null;
}

/**
 * Should Online mode be offered for this game at all?
 *
 * The tempting rule — "exclude anything without a single-player mode" — is
 * wrong, and Big Walk is the proof: Steam lists it as Multi-player | Co-op |
 * Online Co-op with no solo mode whatsoever, yet it is pure P2P co-op and is
 * exactly the case a Steam session serves. Excluding it would have removed the
 * one game this was built for.
 *
 * What actually decides it is *who runs the match*:
 *
 *  1. The game's own code must use Steam networking. Master Duel is the worked
 *     counter-example — it links Steamworks, but every networking symbol lives
 *     in steam_api64.dll rather than in the game, because its matchmaking is
 *     Konami's. Nothing here can reach that.
 *  2. No anti-cheat. VAC/EAC/BattlEye validate the session server-side; a
 *     spoofed one is refused by design. This is the real "only multiplayer,
 *     official servers" signal, and Dota 2 carries it explicitly.
 *  3. Not free-to-play. You already own those legitimately, so there is nothing
 *     to spoof and no reason to put an account near it.
 *
 * Store metadata needs the network. When it can't be fetched the binary scan
 * and the on-disk anti-cheat check still decide, because failing closed would
 * make the feature vanish offline, and the worst case of failing open is a
 * toggle that turns out to be pointless rather than one that does harm.
 *
 * @param {object} media - result of steamApi.getGameMedia, or null
 */
/* ── Installs whose Steam identity already belongs to something else ──
 *
 * Online mode is two changes at once: it puts a genuine steam_api64 back (with
 * our proxy in front of it) and writes `steam_appid.txt = 480` beside the
 * executable, so the game opens a real Steam session under Spacewar. For an
 * ordinary Goldberg install that is exactly right. For a release that runs
 * through a loader of its own it is destructive, because that loader has
 * already decided who the player is and the DRM's activation is bound to that
 * answer.
 *
 * Monster Hunter Wilds is the measured case (2026-09-15). The install carries a
 * ColdClient loader — `version.dll`, a local `steamclient64.dll`, and
 * `steam_settings/configs.user.ini` naming account 76561199799722711 — plus a
 * Denuvo activation token at `userdata/1839456983/2246340/94212889276`, where
 * 1839456983 is that same account. Every launch with online mode on died about
 * three seconds in, inside the executable itself, at an offset that moved
 * between runs, immediately after Denuvo's PathFileExistsW on that token path.
 * The same install launched without online mode reached gameplay.
 *
 * The crash dumps settle which change did it: the only Librarian module in the
 * failing process was `steam_api64_o.dll` — the proxy chain — and it is absent
 * from the working run's dump. Nothing else differed.
 *
 * So the rule is not "Denuvo" and not "cracked". It is: something in this
 * folder already owns the Steam identity, and online mode would replace it.
 */
const DRM_LOADER_FILES = [
  // DenuvOwO / reflex: a hypervisor loader chained in from a winmm or version
  // proxy. reflex.ini alone is enough — the driver folder is staged later, so
  // keying only on the folder leaves a window where the release is live and
  // unrecognised.
  'reflex.dll', 'reflex.ini',
  // A client loader brings its own Steam client. A game never ships one, so
  // this file beside the executable means the session is somebody else's.
  'steamclient64.dll', 'steamclient.dll',
  /*
   * Deliberately absent: version.dll, winmm.dll, dinput8.dll.
   *
   * Those are the names a loader actually hooks through — the Wilds install
   * this came from boots through version.dll, and its winmm.dll is the loader's
   * 242-export proxy. They are also ReShade, ASI loaders, REFramework and any
   * number of ordinary mods. Treating them as evidence would take the session
   * swap away from games that handle it perfectly well today, silently, which
   * is both a worse failure than the one this prevents and a harder one to
   * notice. The client's own steamclient64.dll is the unambiguous marker, and
   * an activation token under userdata/ is better still.
   */
];
const DRM_LOADER_DIRS = ['coldclient', 'driver_amd', 'driver_intel'];

/**
 * A DRM activation token staged inside the install, as
 * `userdata/<steam account id>/<app id>/<token>`.
 *
 * The account id in that path is the one the loader's emulator reports, so the
 * token only validates while that identity is the one the game sees. It is the
 * most direct evidence available that changing the session would break startup,
 * and it needs no list of loader names to find.
 */
function findActivationToken(gamePath) {
  const id = /^\d{4,}$/;
  const dirs = (at) => fs.readdirSync(at, { withFileTypes: true }).filter(e => e.isDirectory() && id.test(e.name));
  try {
    const root = path.join(gamePath, 'userdata');
    for (const account of dirs(root)) {
      for (const app of dirs(path.join(root, account.name))) {
        const held = fs.readdirSync(path.join(root, account.name, app.name), { withFileTypes: true });
        if (held.some(e => e.isFile())) return `${account.name}/${app.name}`;
      }
    }
  } catch { /* no userdata tree here, which is the ordinary case */ }
  return null;
}

/**
 * Does this install run through a Steam loader of its own?
 *
 * Only the top level is read. Every marker is something a release drops beside
 * the executable, and walking deeper would start matching engine folders that
 * legitimately carry a steamclient for their own reasons.
 *
 * @returns {{marks: string[], token: string|null}|null} null when the install
 *          is an ordinary one and online mode is free to act.
 */
function detectDrmLoader(gamePath) {
  if (!gamePath) return null;
  let entries;
  try { entries = fs.readdirSync(gamePath, { withFileTypes: true }); } catch { return null; }

  const marks = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    if (entry.isFile() && DRM_LOADER_FILES.includes(name)) marks.push(entry.name);
    else if (entry.isDirectory() && DRM_LOADER_DIRS.includes(name)) marks.push(`${entry.name}/`);
    else if (entry.isFile() && /\.csrin\.bak$/i.test(entry.name)) marks.push('a .csrin.bak backup');
  }

  const token = findActivationToken(gamePath);
  if (token) marks.push(`an activation token under userdata/${token}`);

  return marks.length ? { marks, token } : null;
}

/*
 * A transport that is not Valve's, shipped as its own library.
 *
 * Deliberately only PlayFab Party. Photon is *not* listed, and that is a
 * decision rather than an omission: Librarian supports Photon games on purpose
 * (src/core/photonMod.js, PEAK), because those use a Steam lobby for discovery
 * and Photon only for the packets — a Spacewar session carries that perfectly
 * well. PlayFab Party does not work that way. The host creates its own network,
 * serialises a descriptor, and relays through Azure, with the publisher's title
 * service deciding who may join; Valve is nowhere in that path.
 *
 * This is also the answer to the false positive that made Wilds look eligible.
 * The RE Engine links the whole Steamworks interface table whether or not it
 * uses it, so `SteamMatchMaking0` and `SteamNetworkingSockets0` sit in the
 * game's own exe and the binary scan believes them. A shipped transport library
 * is the harder evidence and outranks the strings.
 */
const FOREIGN_TRANSPORT = [{ file: 'partywin.dll', label: 'PlayFab Party (PartyWin.dll)' }];

function detectForeignTransport(gamePath) {
  if (!gamePath) return null;
  let entries;
  try { entries = fs.readdirSync(gamePath, { withFileTypes: true }); } catch { return null; }
  const names = new Set(entries.filter(e => e.isFile()).map(e => e.name.toLowerCase()));
  return FOREIGN_TRANSPORT.find(t => names.has(t.file)) || null;
}

function evaluateOnlineEligibility(scan, media, antiCheatFile, gamePath) {
  const reasons = [];
  const backend = (scan && scan.backend) || 'none';

  if (backend === 'none') reasons.push("this game doesn't use Steam or EOS networking");
  // EOS was unsupported until the proxy existed. It is now the better-proven
  // of the two paths: the Spacewar session gets the game as far as an EOS
  // login, and the proxy swaps the Steam ticket Epic rejects for the anonymous
  // Device ID credential it accepts. Verified end to end on two engines.
  if (antiCheatFile) reasons.push(`anti-cheat present (${antiCheatFile}) — it validates the session server-side`);

  const known = !!(media && Array.isArray(media.categories) && media.categories.length);
  if (known) {
    if (media.is_free) reasons.push('free-to-play — you already own it');
    if (media.categories.some(c => /anti-?cheat/i.test(String(c)))) {
      reasons.push('anti-cheat enabled — it validates the session server-side');
    }
  }

  /*
   * identityOwner is reported, never used to refuse.
   *
   * A loader-owned install is still eligible: online mode switches it on by
   * recording the choice and leaving the identity alone (src/core/onlineMode.js
   * enableOnline). The field exists so the flyout can say that rather than
   * promise a session swap that would stop the game starting.
   */
  return {
    eligible: reasons.length === 0,
    reasons,
    backend,
    metadataKnown: known,
    evidence: scan ? scan.evidence : [],
    canInvite: !!(scan && scan.canInvite),
    identityOwner: detectDrmLoader(gamePath),
    foreignTransport: backend === 'steam' && detectForeignTransport(gamePath)
      ? detectForeignTransport(gamePath).label
      : null,
  };
}

module.exports = {
  detectSteamMultiplayer,
  detectAntiCheat,
  evaluateOnlineEligibility,
  detectDrmLoader,
  detectForeignTransport,
};
