# Gates: Online mode must not break an install whose identity is its loader's

OWNS: src/core/multiplayer.js, src/core/onlineMode.js, src/core/launcher.js,
src/js/app.js, main.js, dev/verify-online-identity.mjs, GATES-wilds-online.md

Scope: turning Online mode on for Monster Hunter Wilds leaves the game able to
start. The switch stays available and still performs the real session swap for
every install that can survive one; for an install whose Steam identity is held
by its own loader it is recorded instead of performed, and the flyout says so.
The achievement overlay stops being injected into a hypervisor release during
the window before that release stages its driver folder.

Measured cause, for the record: Wilds carries a ColdClient loader and a Denuvo
activation token at `userdata/1839456983/2246340/94212889276`, bound to the
emulator account `76561199799722711`. Online mode put our proxy in front of
`steam_api64` and wrote `steam_appid.txt = 480`; the game then died ~3 s into
every launch inside its own executable, at an offset that moved between runs,
right after Denuvo's `PathFileExistsW` on that token. The only Librarian module
in the failing dump is `steam_api64_o.dll`, and it is absent from the dump of
the run that reached gameplay.

Checks were run directly (node, cmd.exe, repository root, 2026-09-16). Evidence
records the exit status and the matched token as observed; no approval-harness
fingerprints are quoted, because the harness was not the runner.

- [x] G1: The detector recognises a loader-owned install and leaves an ordinary Goldberg install alone
  CHECK: node dev/verify-online-identity.mjs detect
  EXPECT: OK detect
  EVIDENCE: exit=0; EXPECT=matched ("OK detect"); asserts reflex.dll/reflex.ini/steamclient64.dll/driver_amd/ plus the userdata token, and requires a Goldberg install, a steam_settings-only install, a Photon install and a missing directory to all answer no.

- [x] G2: Switching a loader-owned install on writes no App ID file, no proxy, and changes no existing byte — only the recorded state
  CHECK: node dev/verify-online-identity.mjs preserve
  EXPECT: OK preserve
  EVIDENCE: exit=0; EXPECT=matched ("OK preserve"); sha256 of every file in the fixture compared before and after, with only .DepotDownloader/ permitted to differ.

- [x] G3: An ordinary install still gets the real session swap, so the change did not quietly disable online mode everywhere
  CHECK: node dev/verify-online-identity.mjs plain
  EXPECT: OK plain
  EVIDENCE: exit=0; EXPECT=matched ("OK plain"); steam_appid.txt written and reads 480, and the state is not recorded as loader-owned.

- [x] G4: A loader-owned install reads back as on, stays intact without repair, and is never re-applied on launch
  CHECK: node dev/verify-online-identity.mjs roundtrip
  EXPECT: OK roundtrip
  EVIDENCE: exit=0; EXPECT=matched ("OK roundtrip"); getStatus reports online, verifyOnline reports intact with no reasons, reapplyIfNeeded reports no re-apply and touches no file, and switching off returns the tree to the pre-switch hashes.

- [x] G5: A hypervisor release is recognised as guarded from its configuration file, before its driver folder exists
  CHECK: node dev/verify-online-identity.mjs launcher
  EXPECT: OK launcher
  EVIDENCE: exit=0; EXPECT=matched ("OK launcher"); guarded for reflex.ini alone, for a staged driver_amd/, and one directory down; not guarded for an ordinary install.

- [x] G6: The real Monster Hunter Wilds install on this machine is detected as loader-owned, naming the marks it actually carries
  CHECK: node dev/verify-online-identity.mjs realgame
  EXPECT: OK realgame
  EVIDENCE: exit=0; EXPECT=matched ("OK realgame"); read-only against E:\Games\steam\steamapps\common\Monster_Hunter_Wilds; token matches /^\d+\/2246340$/; also asserts the install carries no leftover steam_appid.txt=480 and no steam_api64_o.dll.

- [x] G7: The verifier fails when the detector is disabled, so these suites cannot certify themselves
  CHECK: node dev/verify-online-identity.mjs self-test
  EXPECT: OK self-test
  EVIDENCE: exit=0; EXPECT=matched ("OK self-test"); four anchors mutated in a temporary copy of multiplayer.js, and both the detect and realgame suites are required to fail against it.

- [x] G8: The existing behavioural regression suite still passes
  CHECK: node dev/verify-reliability.cjs
  EXPECT: passed. Temporary fixtures
  EVIDENCE: exit=0; EXPECT=matched; "20/20 passed. Temporary fixtures: ...".

- [x] G9: MANUAL — Monster Hunter Wilds launches from Librarian with Online mode showing on, and reaches the title screen
  Requires the user to start the game; it loads a signed hypervisor driver and
  cannot be launched on their behalf. Evidence to record: a
  `librarian-game-meta.json` playtime for `steam:2246340` longer than the 22 s
  spanning the three crashed launches, no new `Application Error` event for
  MonsterHunterWilds.exe, and `.DepotDownloader/online-mode.json` still reading
  `identity: "loader"`.

  ATTEMPT 2026-09-16 07:00 — **did not test this work**. The launch ran the
  packaged build, whose `dist/win-unpacked/resources/app.asar` is dated
  2026-09-15 07:24 and contains zero occurrences of `detectDrmLoader` or
  `identityOwner`, while every source change here is dated 2026-09-16 06:35 or
  later. The old code therefore ran: `librarian_online.ini` was written at
  06:57:33 carrying `session_appid=480` / `spoof_appid=1`, `librarian_overlay.log`
  gained a 06:57:36 line (only the Steam/winmm proxies emit that), and the game
  faulted one second later at `0x195efbe7` — byte for byte the offset of the
  2026-09-15 21:06 crash. Re-test after repackaging. The stale ini was removed
  and `disableOnline` now takes its own ini back out.

  Same session, offline: the game booted and the rebuilt 7-hook WinHTTP probe
  captured what a year of inference could not —
  `POST mtm.rebe.capcom.com/v1/steam-steam/sign/EAR-P-WW` ->
  `{"error":{"code":269625600,"message":"Ticket decrypt error"}}`.

  RESULT 2026-09-16 07:11 — **met for the startup criterion**. The run used the
  repackaged build (`dist/win-unpacked/Librarian.exe`, written 07:06:09, started
  07:10:56). Online mode was on for it: `disableOnline` wrote
  `{mode:"offline",restored:[],at:…}` at 07:12:10, and the renderer only sends
  `enabled:false` for a toggle it is currently drawing as on. The game booted —
  reflex reached its `GetSystemInfo` sequence, i.e. past the Denuvo token check —
  and ran about 51 s (playtime 123 s -> 182 s, launch_count 4 -> 5), against one
  second before. No `steam_appid.txt`, `steam_api64_o.dll` or
  `librarian_online.ini` was created, and `librarian_overlay.log` gained no line,
  so the Steam proxy was never loaded. There was no startup fault.

  Not met, and split out below: the process still faults on exit.

- [ ] G10: Monster Hunter Wilds exits cleanly
  ABANDON: G10 the initiating fault is in the game's own shutdown path and is not
  reachable from this repository. The REFramework-caught dump
  (`reframework_crash.dmp`) has the instruction: `MonsterHunterWilds.exe+0xCD88889`
  = `41 80 78 19 00` (`cmp byte [r8+0x19], 0`) with `r8 = 0` — a null-object field
  read during teardown, after `config.ini` has already been saved, so nothing is
  lost. In the runs REFramework does not catch cleanly it degenerates instead:
  the crashing thread's stack holds ~1090 repetitions of one frame pattern at a
  0xF00 stride, mixing ntdll exception-dispatch frames with `dinput8.dll`
  (REFramework) frames, and ends in an *execute* violation (WER `BEX64`,
  exception parameter 8) at an address absent from a full dump of 3645 regions —
  i.e. unmapped, not a copied image. Offsets `0x58fef44`, `0x590af44`,
  `0x5881f44`, `0x57e3f44` share their low 12 bits across four runs.
  REFramework cannot simply be removed: its `IntegrityCheckBypass` is what lets
  this install load `patch_15`.

<!--
G3 and G7 are the negative controls. G3 exists because the cheap way to stop a
crash is to stop doing the thing entirely, and that would pass every other gate
here while removing the feature for every other game. G7 mutates the detector in
a temporary copy of multiplayer.js and requires G1's assertions to fail against
it.

G6 is deliberately machine-bound: it asserts against the actual install this
work came from. It reads and never writes. Set LIBRARIAN_WILDS to point it
elsewhere; it fails rather than skips when the path is absent, because a gate
that skips cannot fail.

G9 is manual because the acceptance condition is a game starting, and nothing in
this repository can honestly stand in for that. It was met on the second attempt,
once the fix was actually packaged; the first attempt tested the old build and is
kept above rather than deleted, because "the fix did not work" and "the fix did
not run" look identical from the outside and only the asar timestamp told them
apart.

Final tally: 9 met (G1-G9), 0 unmet, 1 abandoned (G10).

Not gated, and deliberately: this does not make Wilds multiplayer work. The
publisher's own sign-in refuses the session. The rebuilt 7-hook WinHTTP probe
recorded POST mtm.rebe.capcom.com/v1/steam-steam/sign/EAR-P-WW answering
401 with {"error":{"code":269625600,"message":"Ticket decrypt error"}}, twice,
07:00:03 and 07:11:51. Capcom decrypts the Steam *encrypted app ticket* with the
key Valve issues them for 2246340: the emulator's ticket is fabricated, and a
Spacewar session's ticket is encrypted under app 480's key, so neither decrypts.
No account on this machine owns 2246340 (appmanifest LastOwner is 0). That is
server-side and out of reach from here — and it is why the Monster Hunter Rise
approach does not transfer: Rise's session is brokered by Valve, so two Spacewar
clients meet with nobody decrypting anything.
-->
