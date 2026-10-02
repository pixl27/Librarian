# Gates: emulator compatibility — the crack follows the game's SDK

OWNS: src/core/emuCompat.js, src/core/autoCrack.js, src/core/steamPipe.js,
src/core/settingsStore.js, main.js, preload.js, src/index.html, src/js/app.js,
src/styles/enhance.css, dev/verify-emucompat.mjs, dev/emucompat-realgame.js,
dev/fixtures/**, GATES-emucompat.md

Scope: a generic, robust answer to "the game updated and now the emulator
fails". Every Steam API library names, in clear text, the interface versions
it asks for (SteamUtils011, STEAMUSERSTATS_INTERFACE_VERSION013…), and the
emulator's library names the ones it implements. Before the emulator is ever
placed — after a download, an update or a verify — Librarian compares the two
sets. Compatible: crack as before. Missing interfaces: fetch the newest
gbe_fork release with Librarian's own updater — the archive is downloaded
beside the installed emulator, extracted with the system bsdtar, checked to
be usable and only then swapped in, the previous build kept for rollback;
SteamAutoCrack's updater deletes first and downloads second, and left the
machine without an emulator when Windows Defender refused the archive —
compare again, and crack if the gap closed. Still missing: leave the game's own library in place
and say so, in the game's panel, instead of installing an emulator known to
fail. After a game exits, a fresh EMU_MISSING_INTERFACE.txt in its folder is
read back as the same signal, with a one-click "update the emulator and apply
it again". Verify no longer strips the emulator from a game that had it: the
repair path re-applies it through the same gate. Mortal Shell II is the case
that motivated this (Steamworks 1.65 asks for SteamUtils011; the shipped
gbe_fork build of 2026-08-07 stops at SteamUtils010), but nothing here names a
game: the gate is a set difference between two files.

- [x] G1: The interface extraction and the compatibility decision are right on real libraries and on fixtures: Mortal Shell II's own steam_api64 requests SteamUtils011 and the frozen interface list of the 2026-08-07 gbe_fork build lacks exactly that; Big Walk's steam_api64 (Steamworks 1.53) is fully covered by the same list; synthetic fixtures exercise emulator detection, the online proxy's `_o.dll`, the `.bak` backup and an install with no original library
  CHECK: node dev/verify-emucompat.mjs unit
  EXPECT: OK unit
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=c3c89be565906773d8b1e123ad79d4c501741a3f7254d15dc35045dd1cc00e68; output-bytes=1695

- [x] G2: The emulator update path fetches the newest gbe_fork release with Librarian's own downloader and atomic swap, the installed build changes from the 2026-08-07 commit, the new library names SteamUtils011, the compatibility check for Mortal Shell II then passes, and a second run finds the installed release current without downloading again
  CHECK: node dev/verify-emucompat.mjs update
  EXPECT: OK update
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=cc76134f7c0f299bd0f28965e5497140e2410886b3e8eadc7415d4a8c5c7b62e; output-bytes=725

- [x] G3: With the updated emulator, the gate lets the crack re-apply to Mortal Shell II, and the game then launched through the real launcher initialises Steam through the emulator (the in-game DLL's watch reports it) without writing a new missing-interface entry
  CHECK: node dev/verify-emucompat.mjs realgame
  EXPECT: OK realgame
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=503b7341fdef96cc22d7b0da3fba01ecdcc74e953815966e8bed32900adf6cc5; output-bytes=4484

- [x] G4: A missing-interface report written by a game after launch is read back with its interface names and only when newer than the session start; an older report is ignored
  CHECK: node dev/verify-emucompat.mjs postlaunch
  EXPECT: OK postlaunch
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=5d0d98b6f0d01fe059edac13c98b5a4d9f99f5d4cd67fc910f3ccefc3f4ff8d0; output-bytes=332

- [x] G5: The pipeline decision is what the scope says: a download or update cracks through the gate; a verify re-applies the emulator only when the game had one and the gate passes; a Denuvo title and an online-mode game are left alone; an incompatible emulator is never placed and the block is recorded for the game's panel
  CHECK: node dev/verify-emucompat.mjs pipeline
  EXPECT: OK pipeline
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=dd6176845c5f16de6dc72cf92c59f293307c05df43b7c5d5b231130f52c29c2c; output-bytes=1772

- [x] G6: The sources agree with each other: the flyout panel exists and is rendered beside its neighbours, the Crack page carries the emulator update control, preload exposes every emu channel main.js handles and no more, the settings store declares the new keys, the repair job no longer opts out of the crack, and every touched file parses
  CHECK: node dev/verify-emucompat.mjs integrity
  EXPECT: OK integrity
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=775f4f005312f12f11705676a92bdca46b6be1669838d90d6318d80ef0bce494; output-bytes=50

- [x] G7: The verifier fails when each defect it checks for is reintroduced into a copy of the repository
  CHECK: node dev/verify-emucompat.mjs self-test
  EXPECT: OK self-test
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=a85c7588bdde32a51742258db7217c51d479f953486a428be65f65dcd125be6e; output-bytes=886

- [x] G8: In the running application, the game panel for a blocked game explains the block and offers the update, and the Crack page shows the emulator's build with its update control
  EVIDENCE: manual, 2026-09-07. dev/emucompat-shot.mjs started the real application over CDP with the block Mortal Shell II earned on 2026-09-06 staged in the game meta store (missing SteamInput007, SteamMatchMakingServers003, SteamNetworkingSockets013, SteamUtils011; source update), opened the game's flyout, read the panel back from the DOM — title "Emulator too old for this build", sub "4 interfaces this build needs are missing: SteamInput007, SteamMatchMakingServers003, SteamNetworkingSockets013, SteamUtils011.", note "Noticed 13h ago, after an update. Meanwhile the game uses its own Steam library: no achievements, no DLC. Newest emulator release: 2026-08-23." — pressed "Update & apply", watched the panel turn to class is-ok with "Emulator applied for this build." and SteamAutoCrack's "[INF] [Processor] All process completed." (the block was cleared in the store by the same action), then read the Crack page line "Emulator release-2026_08_23 · 262 interfaces · installed 2026-09-07. This is the newest release." beside the "Update emulator" button; exit 0, "OK shot". Screenshots emu-1-panel.png, emu-2-after-apply.png, emu-3-crack-page.png in the session scratchpad (shots/), reviewed by eye: the first capture of the round showed the panel squeezed to one word per line in the flyout's narrow side column, which was fixed (stacked layout) and re-captured; the final capture shows title, list, full-width button and note within the column, and the Crack page row with text and button on one line. Risk reviewed: this is the only surface where the block is explained, so both a blocked and a resolved state were captured.

- [x] G9: The packaged build carries the new module, the panel and the updated emulator
  CHECK: node dev/verify-emucompat.mjs pack
  EXPECT: OK pack
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=98a5b633cb19a51948b9273140a451f84aee35bd02b027d67bb02438afe0a485; output-bytes=1035
