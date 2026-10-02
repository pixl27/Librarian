# Releasing Librarian to friends

Friends install Librarian once with `Librarian-Setup-<version>.exe`. From then
on the app updates itself from the GitHub releases of the repository named in
`package.json` → `build.publish` (`owner` / `repo`).

## What a friend gets

- A one-click, per-user install (no administrator prompt) into
  `%LOCALAPPDATA%\Programs\Librarian`, with Start menu and desktop shortcuts.
  Librarian starts when the installer finishes.
- The settings in `src/core/settingsStore.js` → `DEFAULTS`. No personal
  account is shipped: no Hubcap key, no CS.RIN.RU login, no Steam login.
- Co-op presets from `src/core/gamePresets.json`: Valheim and PEAK switch to
  online mode (plus the Valheim adapter / PEAK join-a-friend plugin) the first
  time they finish downloading or are launched. Visible in Settings › Co-op.
- Updates: checked 8 s after start and every 4 hours, downloaded in the
  background (only the changed blocks), installed when Librarian closes, or at
  once from the title-bar chip / Settings › Updates.
- The first run of an unsigned installer shows Windows SmartScreen ("Windows
  protected your PC"): **More info → Run anyway**. Antivirus software may flag
  the crack tools shipped in `deps/` (SteamAutoCrack, Steamless).

## One-time setup

1. Create the repository on GitHub (public, so friends need no token) and put
   its owner and name in `package.json` → `build.publish[0]`.
2. Create a fine-grained token limited to that repository with
   **Contents: Read and write**. Store it in `%APPDATA%\librarian-release\gh-token`
   (the file holds only the token) or in the `GH_TOKEN` environment variable.
   It is never written into the project.

## Publishing a version

1. Raise `"version"` in `package.json` (updates only go upwards: 1.2.0 → 1.2.1).
2. Write what changed in `release-notes.md` (shown in the app under
   "What's new").
3. Run `npm run release`. It builds with Electron's own Node, then uploads
   `Librarian-Setup-<version>.exe`, its `.blockmap` and `latest.yml` to the
   GitHub release `v<version>`, published (not a draft) so updaters see it.
4. Give new friends the link to the latest release; existing installs update
   themselves.

`npm run installer` builds the same thing without uploading (output in `dist/`).

## Adding a co-op preset

Add an entry to `src/core/gamePresets.json` (Steam App ID, name, steps, a
one-line note), then publish a version. Steps: `online`, `peakMod`,
`photonMod`. A new preset reaches games friends already have at their next
launch; a step added to an existing preset reaches installs that had the
others. A game whose online mode someone already set by hand is left alone.

## Checks

- `npm run test:presets` — presets against copies of the real Valheim/PEAK
  folders (`node dev/verify-game-presets.cjs <Valheim dir> <PEAK dir>`).
- `dev/verify-app-update.cjs` — install, fresh-profile defaults, update on
  close and restart-to-update, end to end on a local feed (see its header).
- `LIBRARIAN_PROFILE_DIR=<empty folder>` starts any build on a separate
  profile, i.e. exactly as a friend's first launch looks.
