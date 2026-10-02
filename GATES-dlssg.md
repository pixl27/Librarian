# Per-game DLSSG SM86 integration

The manual bulk updater is documented in `GATES-dlssg-updates.md`. Its explicit
successful update can select a newer verified package for future installations;
the original fallback pin described below remains unchanged.

Open an installed game's details, then **Graphics**. This dedicated section
contains the DLSS Frame Generation switch; it is separate from Overview and
the existing switch rail. Games without DLSSG files or a previous installation
do not receive the section. A detected but unsupported installation explains
why its switch is unavailable.

The integration inspects Windows x64 executable imports and their engine
dependencies, including normal and delayed imports resolved through Unreal
Engine/project/plugin Binaries directories. Sibling DLLs are resolved beside
their importer; ambiguous remote basenames are never guessed. It requires
DirectX 12 and the upstream VERSION proxy entry point,
checks the GPU's SM capability with NVIDIA's tool, and distinguishes detected
support from upstream gameplay reports. It does not infer compatibility from
DLSS upscaling alone. Multiple rendering candidates require an explicit choice.

The first activation downloads the upstream DLL, INI, instructions and notices
from revision `a4760d4a49d6c791bba88f24378a56c0dd1c57b0`. Every file has a pinned
size and SHA-256 in `src/core/dlssgRelease.json`. Download failures fall through
GitHub raw, GitHub's raw Contents API and jsDelivr at the same pinned revision.
The successful route is reused for remaining files; every response must pass
the same size/hash checks. Redirects are refused and a full cache works offline.
The app installer does not redistribute the payload.

Deployment adds only `version.dll` and `dlssg_sm86.ini` beside the chosen EXE.
Existing `version.dll` or `dlssg_sm86.ini` files and duplicate copies of the
SM86 payload block installation. Other loader filenames, including `winmm.dll`,
are preserved and shown as coexistence warnings, without claiming runtime
compatibility. Librarian
never replaces the game's original NVIDIA DLL. A receipt in the user's
Librarian data directory records ownership before publication; an exclusive
hard link publishes each completely written file. Disabling removes only
unchanged files identified by that receipt. Missing files are recoverable;
externally changed files are preserved with an explanation. An abrupt OS
shutdown can leave a uniquely named `.librarian-*.tmp` staging file; it is inert
and never loaded as the game's proxy.

The main process resolves the installation from the library, serializes changes
against launch/download/uninstall, checks external running processes before
writing, rechecks after downloading, and waits for transactions when quitting.
Launch rechecks an installed mod's integrity and compatibility. Neither scans
nor tests load the downloaded DLL.

## Validation

- `node dev/verify-dlssg.cjs`: 37 behavioral checks, including nested/indirect
  executable detection, GPU and anti-cheat gates, selection, existing mods,
  install/restart/remove, independent games, cache corruption, CDN retries,
  partial failure recovery, launch after game changes, running-game races,
  concurrent requests, junctions and manipulated receipts. Added checks cover
  referenced dynamic DX12 renderers, missing VERSION routes, multiple blockers,
  unrelated loaders, duplicate payloads, actionable errors and sharing-violation
  recovery. Scans read PE metadata and bounded byte ranges without loading DLLs.
- Production Electron smoke: keyboard toggle through preload/IPC, dedicated
  Graphics section outside Overview/rail, trusted library paths, multiple
  installations of one AppID, download locks, renderer reload, stale responses,
  file conflicts, 1024px at 125% zoom, and quit during a graphics transaction.
- Actual upstream package downloaded and hash-verified. Its real 10,522,624-byte
  DLL was installed and removed in a temporary fixture using live NVIDIA and
  Windows process checks. Original fixture files were preserved.
- Existing reliability, Custom-update and regression suites are rerun. Build
  with the bundled Node 24 runtime: the system Node 20.10 cannot load the
  current electron-builder dependency graph. TLS regression fixtures need
  `C:\Program Files\Git\usr\bin` on PATH for OpenSSL.

Initial evidence and screenshots: `audits/2026-09-09/dlssg-sm86/`.
Error audit evidence and screenshots: `audits/2026-09-09/dlssg-errors/`.
Dependency-resolution correction: `audits/2026-09-09/dlssg-dependencies/`.
Download recovery and live-network proof: `audits/2026-09-09/dlssg-download/`.
Original edited files: `audits/2026-09-09/dlssg-sm86/before/`.
Current build results and SHA-256 are recorded in `final-validation.json`
in the download recovery evidence folder. The portable is `dist/Librarian 1.1.0.exe`.

The corrected read-only audit inspected 12 installed games. Six meet the file and
hardware checks: Crimson Desert Enhanced, Onimusha, 007 First Light, The Sinking
City 2, Dying Light The Beast and Mortal Shell II. Dying Light requires detecting its referenced
dynamic DX12 provider; the selected in-game renderer remains unknown. The first
three contain another `winmm.dll`, so coexistence is explicitly unverified.
Mortal Shell II imports NVAftermath, XAudio2 and CEF from separate engine
directories, which in turn import VERSION. The earlier EXE-directory-only scan
missed these paths and incorrectly blocked the toggle. The current diagnostics
show the concrete dependency chains. This supersedes the earlier audit's
conclusion that Mortal Shell II needed a different proxy. The other six games have no DLSSG
files and do not receive the Graphics section.

The Graphics tab lists every blocker and warning, exposes compatibility checks,
and provides folder/recheck actions. Missing files can be removed through the
recovery button; externally changed files remain protected. Disk, permission,
sharing, drive, process-check and download errors explain the relevant next step.

The portable package excludes the unused `steamclient_experimental` standalone
loader executables. Defender blocked reading the existing x64 loader while
archiving. Librarian does not reference these standalone helpers; the emulator
files required by its existing code remain included. Source dependencies and
Windows security settings were not changed.

No installed user game was modified or launched. Frame generation, FPS,
latency and gameplay stability on this PC remain untested. File detection is
not evidence of successful in-game frame generation. The upstream repository
references a winmm alternative that is absent from the pinned tree; this
integration uses the provided VERSION proxy only.
