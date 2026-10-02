# Gates: steammanifest — a second manifest source beside Hubcap

OWNS: src/core/steamManifest.js, src/core/depotKeys.js, src/core/zipWriter.js,
src/core/zipProcessor.js, src/core/settingsStore.js, main.js, preload.js,
src/index.html, src/js/app.js, src/js/enhance.js, src/js/bigpicture.js,
src/styles/main.css, deps/steammanifest/**, dev/verify-steammanifest.mjs,
dev/vendor-steammanifest.cjs, dev/steammanifest-shot.mjs,
dev/fixtures/steammanifest/**, dev/electron-smoke.cjs, dev/run-regression.cjs,
GATES-steammanifest.md

Scope: E:\Github\steammanifest — the user's own anonymous Steam CM client,
PICS reader, CDN manifest fetcher and mirror client — becomes a source of
manifest packages in Librarian, beside Hubcap. A package from it has the
shape Hubcap serves (one .lua naming the game, its depots with their keys,
its DLCs and manifest sizes; one .manifest per depot) and lands in the same
folder, so the queue, zipProcessor and SteamPipe need no second path. The
project is vendored under deps/steammanifest with its two runtime packages
and a VERSION.txt of hashes, refreshed by a repo-owned script; a folder set
in Settings or LIBRARIAN_STEAMMANIFEST_DIR points at a live checkout instead.
A Manifest source setting chooses Hubcap, steammanifest, or Auto: Hubcap when
a key is set, the local source when there is none or Hubcap fails; in Auto
the Store searches both and unions the results. Hubcap builds its packages in
batches, so a game that updated today can come back as last week's build:
in Auto every Hubcap package is compared with the manifest Steam serves for
each depot right now, and when one is behind the latest package is assembled
from Steam — Hubcap's keys and its copies of the unchanged manifests kept,
the changed manifests taken from Steam or the mirror. That check is the
reason this source exists. Depot keys are the crux —
Steam hands them out anonymously only for free apps — so every key that
passes through Librarian (a Hubcap package, the Steam client's own config,
the key file the project keeps) is remembered in userData and used when the
local source writes its Lua; a paid game with no key known is refused with a
message that says where keys come from, never queued to fail later.

- [x] G0: this ledger states outcomes that can fail
  CHECK: node C:\Users\One\.claude\skills\unlazy\scripts\gate-lint.mjs GATES-steammanifest.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=1fabf2838841f8a5de66c14f90193eed511fe1aa2f6425c83c14030293c41f35; output-bytes=165

- [x] G1: deps/steammanifest is a faithful copy of the checkout: every first-party file listed in VERSION.txt is present with its recorded SHA-256 and size, both runtime packages resolve from inside the vendored folder, the account-login package is not shipped, and the copy carries no file the checkout's .gitignore excludes
  CHECK: node dev/verify-steammanifest.mjs deps
  EXPECT: OK deps
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=996011f29c3d261c0f84e96619d9c321b52444d5620a7f51e18ec5d0a3687cf9; output-bytes=8

- [x] G2: an archive written by zipWriter is read back entry for entry by yauzl through zipProcessor and by Windows' own bsdtar with its CRCs verified, and the same readers reject a copy with one byte corrupted
  CHECK: node dev/verify-steammanifest.mjs zip
  EXPECT: OK zip
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=d839866283e850f952c18982b054115930b3cd4c05857ee1de5142b0a256f1f2; output-bytes=7

- [x] G3: the Lua the local source writes parses through zipProcessor into the shape a Hubcap Lua gives — app id, game name, keyed depots with their manifest sizes, DLCs — a real Hubcap Lua parses to the same shape through the same code, and a depot without a key never becomes a depot the engine would be asked to decrypt
  CHECK: node dev/verify-steammanifest.mjs lua
  EXPECT: OK lua
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=10d68c49a86ab4709892897cfa2b645c4bfbf72ef9a38a723199004734bb700a; output-bytes=7

- [x] G4: depot keys are harvested from a package that passes through zipProcessor, from the Steam client's config.vdf and from a steammanifest key file; the merge prefers Steam's own config, then the store, then files; malformed ids and keys are dropped; the store is written through the same durable path as the queue and survives a corrupt file
  CHECK: node dev/verify-steammanifest.mjs keys
  EXPECT: OK keys
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=67ec46381178f1b172bd0f0d789901f18e7451e93530d19889c07b61a35fac24; output-bytes=341

- [x] G5: offline, against a mock CM client and local CDN and mirror servers serving the project's own 1007/1004 fixture: a free app yields a ZIP in hubcap_manifests that inspectArchiveAppId accepts, whose manifest bytes equal the fixture and whose key was obtained anonymously and remembered; a CDN denial is served from the mirror; a paid app with no key known is refused with a message naming where keys come from and leaves nothing on disk; a depot whose manifest no source can supply is left out and reported, the others still packaged
  CHECK: node dev/verify-steammanifest.mjs fetch
  EXPECT: OK fetch
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=9fdaccf286eff4953d642d722eb230353cc7bf72ea0b9e02b01c16aaf229bdea; output-bytes=9

- [x] G6: the freshness check is what makes this a second source: a Hubcap package whose depot is behind Steam's current manifest is detected as behind and replaced by a package assembled from Steam that carries Hubcap's keys and reuses Hubcap's copy of every unchanged manifest; a package already at Steam's manifests is reported current and left alone; and a replacement is written only when it covers every depot Hubcap's package covered — whether the gap is a newer manifest no source can supply or a depot that was current and could not be re-packaged, Hubcap's package is kept intact and the staleness reported instead
  CHECK: node dev/verify-steammanifest.mjs stale
  EXPECT: OK stale
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=6a825d1bf763e904f1f3d77e24b2bc4651e07e46d1d4160a5973ee2f929c192b; output-bytes=9

- [x] G7: a Steam store search answer is mapped to Hubcap's result shape; a numeric query returns the app with that id first and the titles containing the number after it, keeping the id hit even when the name search fails; and the source order is what the scope says for every combination of setting, key and availability, with Auto unioning both searches Hubcap first
  CHECK: node dev/verify-steammanifest.mjs search
  EXPECT: OK search
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=b2f095d2db1546e9ba7116eade5e7fe8e29d9f57313ec078ab3c77dc48f74172; output-bytes=10

- [x] G8: the sources agree with each other: preload invokes every channel main.js handles and no more, the settings store declares the new keys with the enum, the markup carries the picker, folder, mirror and status line the renderer reads and writes, the Store gates on the effective sources rather than on the Hubcap key alone, the Store log relays the source's lines, zipProcessor remembers keys, the smoke pins its source, and the regression runner lists the suites
  CHECK: node dev/verify-steammanifest.mjs wiring
  EXPECT: OK wiring
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=cda507d2dc6289431c953d13aee1e4866932c4875977a970ec7f876ffba9b194; output-bytes=10

- [x] G9: every production JavaScript file, including the vendored first-party files, parses under Node, the touched stylesheet stays balanced, and every class and id the new markup uses is addressed by a stylesheet or the renderer
  CHECK: node dev/verify-steammanifest.mjs integrity
  EXPECT: OK integrity
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=283ac8ca26755dffa8830b4a6231614bad473af63f22bf9e5309390dd1c7d258; output-bytes=13

- [x] G10: the verifier fails when each defect it checks for is reintroduced into a copy of the repository
  CHECK: node dev/verify-steammanifest.mjs self-test
  EXPECT: OK self-test
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=92a609c61c750d122e1e0eacac23e73f1e019f9282f9700575b1e28caf7cbe12; output-bytes=1963

- [x] G11: the existing reliability suite and the isolated Electron smoke still pass with the source wired in
  CHECK: node dev/verify-steammanifest.mjs regressions
  EXPECT: OK regressions
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=e3123c223cca5734a7d1e5fb14f0ce6e5a4a627e1338ede2e447bc567e90ab1b; output-bytes=403

- [x] G12: against Steam itself, anonymously, the module packages app 1007 through the vendored copy: a ZIP that inspectArchiveAppId accepts, its depot key obtained from Steam and remembered, and the same call for a paid app with no key known refused with the key message
  CHECK: node dev/verify-steammanifest.mjs live
  EXPECT: OK live
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=0cf8868de106a74630718ca65b173b312e9f6c58a084c4c04a07c7ded2cbfb82; output-bytes=873

- [x] G13: the packaged build carries deps/steammanifest with its packages beside the other deps and the new core modules inside the asar
  CHECK: node dev/verify-steammanifest.mjs pack
  EXPECT: OK pack
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=34ef80f9e24f796784c5afc098228c143c489bc06e5e19aadfee0bac07e4b82e; output-bytes=360

- [x] G14: in the running application, the Settings API section shows the Manifest source picker with the vendored copy reported found, and the Store's subtitle names the source in effect for the setting chosen
  EVIDENCE: manual, 2026-09-12. dev/steammanifest-shot.mjs started the real application over CDP, read the Settings API card back from the DOM and photographed it, then moved the Manifest source setting through its three values and photographed the Store for each, putting the setting back to "auto" at the end; exit 0, "OK shot". The card read: options auto/hubcap/steammanifest with "auto" selected; folder "C:\Users\One\Downloads\Compressed\Accela-main\Librarian\deps\steammanifest (bundled)"; mirror placeholder "Default — the relay steammanifest uses"; status line "steammanifest found · C:\Users\One\Downloads\Compressed\Accela-main\Librarian\deps\steammanifest · copied 2026-09-12 · 76 depot keys known · sources in effect: Hubcap → steammanifest". The Store subtitle read "Search Hubcap and Steam by name or AppID." under auto (root data-manifest-source "hubcap+steammanifest"), "Search Steam by name or AppID." under steammanifest, and "Search Hubcap by name or AppID." under hubcap. Screenshots sm-1-settings.png, sm-1b-settings-status.png, sm-2-store-auto.png, sm-3-store-steammanifest.png, sm-4-store-hubcap.png and steammanifest-shot.json in the session scratchpad (shots/), reviewed by eye: the first round showed the picker's selected label truncated at the column width and the status line touching the next field's label; the option labels were shortened and the status line given bottom margin, and the re-captured shots show the full label "Auto — Hubcap, checked against Steam" and the status line separated from "STEAM WEB API KEY". Risk reviewed: this card is the only place the source in effect and the vendored copy's health are visible, so both the picker state and the resolved status line were read from the DOM as well as photographed.
