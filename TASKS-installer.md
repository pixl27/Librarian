# Installer + updater for friends (2026-10-02)

Goal: friends run one installer, launch Librarian, and Valheim / PEAK come
ready for co-op (online mode + mods) with the owner's settings as defaults.
Decisions from the user: updates on **GitHub Releases**; **no personal
credentials** shipped (no Hubcap key, no CS.RIN.RU account).

## Checklist (tick only with evidence)

- [x] Defaults = owner's real preferences (`generate_achievements`, `tuning`),
      not machine paths / credentials / history. Read back from a fresh
      profile in the installed app (E2E "Fresh profile").
- [x] `game_presets` setting (default on) + toggle in Settings > Co-op.
- [x] Presets are data (`src/core/gamePresets.json`), user asked to add more
      later and have friends see them: Settings > Co-op cards + toast at launch.
- [x] `src/core/gamePresets.js`: Valheim (892970) → online mode (+ Valheim
      adapter); PEAK (3527290) → online mode + PeakJoinFriend. Once per step,
      receipt in `.DepotDownloader/`, never over an existing online-mode choice.
- [x] Hooked after download (steamPipe, after auto-crack) and at launch.
- [x] Verified on copies of real Valheim/PEAK folders: 9/9
      (`dev/verify-game-presets.cjs`), incl. existing choice respected, turned
      off stays off, failed step retried, step added later reaches old installs.
- [x] NSIS target: one-click, per-user, shortcuts, runs after install,
      `Librarian-Setup-<v>.exe` (build A/B/C outputs inspected).
- [x] electron-updater 6.8.9 in deps; `src/core/appUpdater.js` (inert for
      dev/portable/no feed, shown as "Manual updates"); IPC + preload.
- [x] Update UI: chip + Settings "Updates" card + toast. Seen in the installed
      app driven by real updater states (E2E captures 1.2.1-ready,
      1.2.2-ready-chip); downloading/ready also on harness captures.
- [x] `dev/build-installer.cjs` (Electron's Node, PowerShell on PATH;
      `--publish` uploads with GH_TOKEN or %APPDATA%\librarian-release\gh-token;
      `--feed/--version/--out` for test builds via a whole config file, since
      electron-builder deep-merges an option `publish` into the GitHub entry).
- [x] Installer builds; silent install into a test folder works; app starts
      with isolated profile; uninstall clean (no shortcut, registry key or
      updater cache left).
- [x] Updater E2E (`dev/verify-app-update.cjs`, final run 6/6): 1.2.0 → 1.2.1
      on close (silent, no relaunch), 1.2.1 → 1.2.2 from the chip (relaunched
      with --updated), ~1.1 MB of 196 MB each time (differential). Real
      profile md5-identical before/after.
- [x] Regression `dev/verify-reliability.cjs` 20/20 after the changes.
- [x] Docs: RELEASING.md (publish, presets, what friends see), release-notes.md.
- [ ] Needs user: GitHub owner/repo in package.json + token, then the first
      `npm run release` (outward-facing, not done without a go-ahead).

## Findings

- Only two real preferences differed from DEFAULTS (generate_achievements,
  tuning profile). The rest of the owner's file is machine paths (E:\Games),
  credentials (DPAPI-encrypted, unreadable on another PC anyway) and history.
- electron-builder's NSIS "app running" check is scoped to processes under
  $INSTDIR (PowerShell Path.StartsWith), so a friend's portable copy running
  elsewhere is not killed by the installer.
- The NSIS relaunch after an update goes through the shell, so a command-line
  switch (`--user-data-dir`) would not survive it; `LIBRARIAN_PROFILE_DIR`
  (env, read before the instance lock) is what isolates test installs.
- Installer is 201 MB vs 145 MB for the portable: same 648 MB payload,
  different compression.
