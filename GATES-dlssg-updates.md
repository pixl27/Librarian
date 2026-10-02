# Manual DLSS Frame Generation updates

Open **Settings > Graphics**, choose **Check for updates**, then **Update all
DLSS FG**. Each game's Graphics tab also links to this panel. Opening the app or
this panel does not check GitHub, download a package, or update a game. Checking
reads only GitHub metadata and installation ownership/integrity. Replacement is
separate and requires the explicit Update button and a checked main-process plan.

## Coverage

The updater considers every installation in Librarian's library, regardless of
its source, including manually added Custom games. It deduplicates aliases of
the same real folder. Only installations with a valid Librarian DLSS FG receipt
are updated; games without the mod remain unchanged. This does not recursively
search all drives or adopt unknown manually installed mods. Add external games
to the library and manage the mod through their Graphics tab first.

The integration updates the upstream `version.dll` proxy together with its
`dlssg_sm86.ini`. It preserves native NVIDIA Super Resolution, Ray Reconstruction
and Frame Generation DLLs and unrelated mods. Existing Windows x64, SM 8.6,
DirectX 12, VERSION-loading-route and anti-cheat checks still apply. Upstream's
additional GPU routes and alternate proxy names are not automatically enabled.

## Discovery and integrity

The official source is https://github.com/sdli1995/dlssg_for_sm86. The read-only
check on 2026-09-11 resolved commit
`5f62ff44a9c08f9841fa605e7b7160f79ccd2c40`, ahead of the original pinned revision
`a4760d4a49d6c791bba88f24378a56c0dd1c57b0`. The upstream documentation identifies
the package as Native 0.2.4. The updater does not hardcode this as the latest:
it resolves the immutable main-branch commit and tree on each explicit check.

The four supported files are size-bounded, type-checked Git blobs. Downloads use
that immutable commit and verify Git blob hashes, then retain SHA-256 hashes for
cache and ownership checks. Downloads can retry raw GitHub, the GitHub Contents
API and jsDelivr at the same revision. Redirects, changed layouts, missing files,
oversized payloads, bad hashes and downgrades/divergent histories are rejected.
README and third-party notices are cached alongside the package, not deployed
to the game. No downloaded DLL is executed during inspection or validation.

## Transactions and results

Managed files changed outside Librarian, including a customized INI, are blocked
rather than overwritten. Each eligible game is re-resolved from the authoritative
library and checked again for moved paths, running processes, downloads, missing
files and compatibility before replacement. Checked plans cannot redirect an
update to a moved game. A duplicate candidate proxy under another loader name
blocks the update.

Both original files and their receipt are backed up under Librarian's user-data
`dlssg-sm86/backups` folder. Staged files are flushed before exclusive publication;
the DLL is published last. The receipt records both old and new owned hashes
before replacement and final file verification precedes committing success.
Failure restores the old pair where possible. Interrupted or externally changed
installations keep recovery information; foreign files are preserved. The per-game
Graphics panel offers incomplete-installation recovery, and successful update rows
provide **Open backup folder**.

The batch continues after a failed game and retains per-game success, failure,
blocked or skipped results. State and progress survive renderer reloads. Duplicate
requests cannot start parallel updates. Closing the application waits for tracked
transactions and prevents new graphics work. Only an explicit successful update
selects the new verified package for future opt-in installations; the shipped
fallback pin itself remains unchanged.

## Validation

`dev/verify-dlssg.cjs` covers the original per-game integration.
`dev/verify-dlssg-updates.cjs` contains 20 updater checks;
`dev/verify-dlssg-updater-integrity.cjs` adds six ownership/publication regressions.
All use temporary inert fixtures. `dev/check-dlssg-upstream.cjs` is metadata-only.

`dev/electron-smoke.cjs` exercises production main/preload/renderer code with an
isolated profile and network fixtures. The added `dev/dlssg-updates-smoke.cjs`
covers settings navigation, keyboard activation, read-only checking, library and
Custom coverage, modified-file protection, bulk results, backups, renderer reload,
duplicate requests, failed checks and retries. It runs against source and, with
`--packaged`, the actual built app archive. `dev/verify-dlssg-package.cjs` verifies
packaged source byte-for-byte against the workspace.

Evidence is in `audits/2026-09-11/dlssg-updates/` and the focused review results in
`audits/2026-09-11/dlssg-updater/`. No real installed game was updated or launched
for this task. Actual frame generation, FPS and gameplay stability are untested.

## Build on this workstation

The system Node version is older than the installed build dependencies require.
The bundled Electron can run its Node 24 runtime. For packaging only, set
`ELECTRON_RUN_AS_NODE=1`, set `process.noAsar=true` before requiring the builder,
and call `require('electron-builder').build({win:['portable'],x64:true,publish:'never'})`.
The API avoids CLI argument detection treating Node-mode Electron as a packaged
application; `noAsar` allows writing archives as ordinary files during packaging.
Neither adjustment changes the production app's archive loading or security.
Remove `ELECTRON_RUN_AS_NODE` when running the GUI smoke test.

After all checks and the build complete, `dev/finalize-dlssg-updates.cjs` validates
the recorded results and writes artifact hashes and counts to `final-validation.json`.
