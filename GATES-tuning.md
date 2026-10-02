# Gates: Tuning mode — render queue, frame limiter, launch-time tweaks, dedicated page

OWNS: native/achoverlay/tuning.c, native/achoverlay/tuning.h,
native/achoverlay/tuning_shared.h, native/achoverlay/build.js, native/tune/**,
src/core/tuning.js, src/core/launcher.js, src/core/settingsStore.js, main.js,
preload.js, src/index.html, src/js/app.js, src/js/tuning.js, src/js/kinetic.js,
src/styles/tuning.css, dev/verify-tuning.mjs, dev/tuning-e2e.mjs,
dev/tuning-realgame.js, dev/bin/**, GATES-tuning.md

Shared, not owned: native/achoverlay/achoverlay.c is co-edited with the
session fixing the Steam achievement watch (its own verifier is
dev/verify-achoverlay.mjs). This round touches only the hook and the startup
thread there, by targeted edits, never by rewriting the file; the built DLL
in deps/librarian carries both sets of changes.

Scope: a first-party "Tuning" mode for Librarian. Inside the game, the DLL that
already hooks Present (and now Present1) gains a render-queue control — a
just-in-time scheduler by default, which holds the game after Present so its
next frame is built as late as possible and never waits in Present; plus the
fixed "one frame" and "ultra" waits — built on a fence signalled ahead of
Present (ID3D11Fence on D3D11, the game's own direct queue on D3D12, caught by
hooking ExecuteCommandLists) and a watcher thread that stamps every frame's
GPU completion; and a low-latency frame limiter. Each is switchable live from
Librarian through a per-process config file, and the DLL publishes per-frame
measurements (frame time, CPU time, time blocked in Present, limiter wait,
queue wait, present-to-GPU-completion latency with its uncertainty, render
queue depth) through a per-process stats file. At launch the launcher applies
CPU topology-aware affinity, optionally high priority and a performance power
plan, and the display's maximum refresh rate, and restores what it changed at
exit. A dedicated Tuning page (not the overlay) carries the on/off switches,
live measurements and a before/after A/B test that attributes the longest
frame of each phase to its owner. Nothing crashes the game: the in-game half
fails safe for the session on any error, exactly like the overlay. The
governing rule, from the user: a lever with no measured gain does not ship as
a default.

Verification runs the code. dev/tuning-e2e.mjs builds a synthetic GPU-bound
D3D11 application, injects the real DLL with the real injector, drives the real
config file and reads the real stats file. dev/tuning-realgame.js does the same
against ULTRAKILL through the real launcher module under the shipped Electron.

- [x] G1: The in-game DLL, the injector, the tune helper and the synthetic D3D11 test application all compile with the MSVC toolchain the project already requires, and the artefacts land where the launcher looks for them
  CHECK: node dev/verify-tuning.mjs build
  EXPECT: OK build
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=98be5ec36630a9357c075668315db116e21479f950208a5fa398317cf875c37c; output-bytes=487

- [x] G2: Injected into a GPU-bound D3D11 process with tuning off, the DLL reports frames on the stats file, identifies the API as D3D11, and the process stays alive
  CHECK: node dev/verify-tuning.mjs e2e-stats
  EXPECT: OK e2e-stats
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=5e65454c1ac97ced05ebc6fcde1e60a0f68021d08ecb2dff225ac39be1d687da; output-bytes=545

- [x] G3: The frame limiter, switched on live through the config file, holds the synthetic application within 5 percent of the requested rate, and switching it off live releases it
  CHECK: node dev/verify-tuning.mjs e2e-limiter
  EXPECT: OK e2e-limiter
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=cfeec41d947fec54bbbc8734fffc78da992d04a44a59d5d3944379c0494044ac; output-bytes=755

- [x] G4: On the same GPU-bound process in the same run, the render-queue modes switched on live behave as claimed: one-frame never adds latency or costs more than a tenth of the frame rate; ultra cuts present-to-GPU-completion latency by at least half a frame while moving the wait out of Present and keeping the frame rate within 15 percent; just-in-time (the default) cuts latency by at least half a frame, empties the wait in Present and keeps the frame rate within 5 percent; and on a CPU-bound control just-in-time never engages, adds no wait and leaves the frame rate within 3 percent; the latency itself is pinned to better than half a millisecond
  CHECK: node dev/verify-tuning.mjs e2e-queue
  EXPECT: OK e2e-queue
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=982cf6420650dc3e22aff3e1b13a66cd709a09f3ffab97e34a4ba3da227a3fad; output-bytes=2352

- [x] G5: A config file carrying an unknown version, or a stats file the DLL cannot create, leaves the game running with tuning inert rather than crashing it
  CHECK: node dev/verify-tuning.mjs e2e-failsafe
  EXPECT: OK e2e-failsafe
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=d42b6e69671cb84cac022151f10fcc802a28f5ed85ade002ad8051e67b00c193; output-bytes=328

- [x] G6: The tune helper describes this machine's CPU topology and display modes as JSON, applies an affinity to a live process that the process then reports and clears it again, switches the primary display to another rate it offers and back, and targets the highest rate on request
  CHECK: node dev/verify-tuning.mjs helper
  EXPECT: OK helper
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=fc0eb4a339319f0f1c6b9b06b6ba027992f5db4a58aea1bf466a678f5d8a1814; output-bytes=761

- [x] G7: ULTRAKILL, launched through the real launcher module under the shipped Electron with tuning on, reaches its first frames without crashing, reports D3D11 stats, survives a live before/after A/B cycle of the render-queue cap and limiter, and the display and power plan are restored after it exits
  CHECK: node dev/verify-tuning.mjs realgame
  EXPECT: OK realgame
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=6d66482009f0352ef24564b1971a7c081befb69dd712a1906ef4692410fc996c; output-bytes=3267

- [x] G8: The Tuning page is wired end to end in the shipped sources: nav tab, page markup, script and stylesheet linked, NAV_ORDER and the kinetic stagger table know the page, every control id the page script addresses exists in the markup, the settings store declares and sanitises the tuning profile, preload exposes every channel main.js handles, and every renderer and main-process file parses
  CHECK: node dev/verify-tuning.mjs integrity
  EXPECT: OK integrity
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=733079615663ba4ff790bd0dd9552f056532e7a424f21900d28459cf14dfc4a6; output-bytes=55

- [x] G9: The verifier itself fails when each defect it checks for is reintroduced into a copy of the repository
  CHECK: node dev/verify-tuning.mjs self-test
  EXPECT: OK self-test
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=2798345e32aae807345bf9d72a5f34f4b059ce377834c9e4818121f6d5de871f; output-bytes=1157

- [x] G10: In the running application, the Tuning page renders with its switches, the live measurement tiles fill while ULTRAKILL runs, and the A/B test produces a before/after table
  EVIDENCE: manual, 2026-09-06. dev/tuning-shot.mjs started the real application (electron . --remote-debugging-port=9333), attached over CDP, navigated to the page, switched Tuning mode on through its own switch, started ULTRAKILL through window.Librarian.launchGame, activated the game window, waited for the tiles, clicked "Run the test" (10 s each), read the table back, stopped the game and switched the mode off again; exit 0, "OK shot". Read back from the DOM: tiles "97.0 | 97.0 | 10.31 ms | 0.4 ms | 0.20 ms | 9.8 · 0.0", status "ULTRAKILL · D3D11 · 97.0 fps", A/B rows before/after "Frame rate (mean) 100.0 → 89.6", "Frame rate (typical frame) 100 → 97.0", "Limiter wait 0.00 → 8.93 ms", "GPU latency 0.4 → 0.4 ms no change", "Hitches 0 → 1", footer "1015 then 913 frames · D3D11 · Longest frame — after: 670 ms in the game's own work", in-effect line "limiter on (97 fps) · just in time: armed, nothing to gain right now". Screenshots tuning-1-idle.png, tuning-2-live.png, tuning-3-ab.png, tuning-4-after-exit.png in the session scratchpad (shots/), reviewed by eye: the segmented control shows Just in time / Driver default / Ultra, every tile carries a value, the table carries the four columns with better/worse colouring, the notes section renders. Risk reviewed: the page is the only user-facing surface of the round, so the run was repeated three times during the round after each UI change; the earlier run that showed empty tiles was traced to the game losing the foreground (Unity pauses), not to the page.

- [x] G11: The packaged build contains this round's work: the page script and stylesheet inside the asar, the rebuilt DLL and the tune helper under resources/deps/librarian
  CHECK: node dev/verify-tuning.mjs pack
  EXPECT: OK pack
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\One\Downloads\Compressed\Accela-main\Librarian; path=b5250e3c5a6c/8 entries; EXPECT=matched; output-sha256=fb83118aea4ff568f1b1cd35836cbb3dd959a0d80c81efc6c01aad5afeadddc4; output-bytes=1864
