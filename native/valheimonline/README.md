# Librarian Valheim Online

The managed plugin addresses Valheim's App ID check and adapts its PlayFab login call while preserving the game's existing success and error callbacks. It uses the bundled BepInEx/Harmony loader and Librarian's native Steam proxy. It does not include the supplied Online-Fix native DLLs, and it does not rewrite the game's managed assemblies on disk.

## Update handling

- `Compatibility.cs` reads the current game metadata with Mono.Cecil, without loading or running game code. It checks the App ID method, accepted-ID field, PlayFab request/callback signatures and Steam user accessor.
- `src/core/valheimOnline.js` fingerprints the checker and game assemblies. A changed build is re-inspected before online activation or launch.
- The installer repairs missing loader/plugin files from bundled assets. Receipts distinguish owned files from an existing mod loader. Externally edited owned files and foreign proxy conflicts are preserved and reported.
- Turning online mode off removes the owned plugin and leaves the loader and unrelated mods intact. Turning it back on reinstalls the plugin.
- The native proxy export table is rebuilt from the game's current genuine Steam DLL by `steamProxyAdapter.js`.
- An incompatible signature or engine layout stops the online launch with a compatibility error. This mechanism covers compatible file/SDK updates; a changed server protocol or unsupported game API requires a source update.

## Build and check

From the Librarian checkout, pass the installed game's Managed directory:

```powershell
node dev/build-valheim-online.cjs 'E:\Games\steam\steamapps\common\Valheim\valheim_Data\Managed'
node dev/verify-valheim-online.cjs 'E:\Games\steam\steamapps\common\Valheim\valheim_Data\Managed'
npm run test:online-adapter
```

The builder uses the installed .NET SDK for the plugin and the Windows .NET Framework compiler for the standalone metadata checker. Outputs are under `deps/valheim-online` and are included as application resources.

Runtime diagnostics: `BepInEx/LogOutput.log` and `.DepotDownloader/valheim-online-runtime.txt`. Installation receipt: `.DepotDownloader/valheim-online.json`.

## Validation on 2026-09-14

Live Valheim 1.0.12 / Unity 6000.0.75f1 reached Steam initialization and PlayFab authentication with this plugin, both with and without the Steam overlay. The user confirmed that the observed later exits were manual. A session with a second player has not been verified. Ten behavioral checks cover installation, compatible build changes, missing assets, disabling/re-enabling, foreign edits, loader conflicts, incompatible signatures, disabled loaders and engine-layout changes.

The later launcher crash was a separate rendering conflict. WER dumps from
21:31 and 21:35 contain thousands of repeated return addresses alternating
between `librarian_achoverlay.dll+0x1cb5` and
`GameOverlayRenderer64.dll+0x93f6f`, followed by stack exhaustion in exception
handling. A direct launch without the Librarian overlay loaded a world, and
the user confirmed normal graphics after the initial white startup screen.

The shared achievement overlay now skips its render hooks when the Steam
renderer is already loaded or `steam_overlay=1` is configured beside the
executable. Intent is checked before creating a probe device, and module
presence is checked again before mutating its vtable. This covers the
asynchronous Steam overlay load used by Valheim without game version checks.
Steam authentication, the Steam overlay and the achievement watcher continue;
Librarian's in-game toasts, frame limiter and queue controls are unavailable
for that session. Tuning reports `steam-overlay` with no rendering capability
instead of claiming working frame measurements. Launch-time CPU/display
settings remain independent.

`node dev/verify-overlay-conflict.cjs` exercises the built DLL against real
D3D11 Present/Present1 processes: Steam requested before loading, a harmless
loaded-module fixture, no Steam overlay, and an explicitly disabled overlay.
It checks normal process exit, zero hooks/capabilities in conflict cases and
continuing frames in control cases. All four cases passed, as did the 18
reliability checks. The rebuilt portable and unpacked application match all
77 source files and the corrected native DLL.

At 21:51, the rebuilt application's real `window.api.launchGame` path started
Valheim (PID 21416), including online preflight, achievement feed publication
and native injection. Both Steam's renderer and Librarian's corrected DLL
were loaded; the current overlay log reports that its render hooks were
skipped, and its Steam achievement watcher continued normally. The managed
plugin reported `ready`. The user confirmed normal graphics and no crash
on this launch. The probe did not terminate the game, and the temporary
localhost debugger used to trigger the app's normal launch action was closed.
At the final check the game process had ended; no new Valheim Application
Error event or crash dump was recorded after the corrected launch.
