/**
 * Build the in-game achievement overlay and the loader that puts it there.
 *
 * MSVC rather than mingw: the Direct3D headers and import libraries come with
 * the Windows SDK, which is installed alongside the Build Tools.
 *
 * Both halves are built together on purpose — they are useless apart, and a
 * mismatched pair would be a bug nobody would think to look for.
 *
 * Usage: node native/achoverlay/build.js [outDir]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const VS_ROOTS = [
  process.env.LIBRARIAN_VCVARS,
  // Forward slashes throughout: Node accepts them on Windows, and they survive
  // every layer between here and the shell without being eaten as escapes.
  'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Auxiliary/Build/vcvars64.bat',
  'C:/Program Files/Microsoft Visual Studio/2022/BuildTools/VC/Auxiliary/Build/vcvars64.bat',
  'C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Auxiliary/Build/vcvars64.bat',
  'C:/Program Files/Microsoft Visual Studio/2022/Professional/VC/Auxiliary/Build/vcvars64.bat',
  'C:/Program Files (x86)/Microsoft Visual Studio/2022/Community/VC/Auxiliary/Build/vcvars64.bat',
];

function findVcvars() {
  for (const candidate of VS_ROOTS) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Run one cl invocation through a batch file.
 *
 * A batch file rather than `cmd /c "…"`: the command needs nested quotes for
 * several paths with spaces plus an && between them, and cmd's own quoting
 * rules mangle that combination in ways that fail without saying why.
 */
function compile(vcvars, clArgs, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libach-'));
  const script = path.join(dir, 'build.bat');
  const lines = ['@echo off', `call "${vcvars}" >nul 2>&1 || exit /b 1`, `cl ${clArgs}`];
  fs.writeFileSync(script, lines.join('\r\n'), 'utf-8');

  try {
    execFileSync('cmd', ['/c', script], { cwd: dir, stdio: 'pipe' });
  } catch (err) {
    const detail = [err.stdout, err.stderr].filter(Boolean).map(String).join('\n').trim();
    throw new Error(`${label} compile failed:\n${detail || err.message}`);
  } finally {
    // Best effort: the linker or a virus scanner can still hold the .obj for
    // a moment, and a temp directory left behind is not a failed build.
    for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; }
      catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); }
    }
  }
}

function build(outDir = path.join(__dirname, '..', '..', 'deps', 'librarian')) {
  const vcvars = findVcvars();
  if (!vcvars) throw new Error('vcvars64.bat not found (set LIBRARIAN_VCVARS)');

  fs.mkdirSync(outDir, { recursive: true });

  const dll = path.join(outDir, 'librarian_achoverlay.dll');
  compile(vcvars, [
    '/nologo', '/W3', '/O2', '/LD', '/MT', '/D_CRT_SECURE_NO_WARNINGS',
    `"${path.join(__dirname, 'achoverlay.c')}"`,
    // The tuning half rides the same Present hook; one DLL, one injection.
    `"${path.join(__dirname, 'tuning.c')}"`,
    '/link', `/OUT:"${dll}"`,
    // dxguid carries IID_ID3D11Device and friends; without it the COM casts in
    // the source link against nothing.
    'd3d11.lib', 'dxgi.lib', 'dxguid.lib', 'd3dcompiler.lib', 'user32.lib',
  ].join(' '), 'overlay');
  if (!fs.existsSync(dll)) throw new Error('compiler reported success but produced no DLL');

  const injector = path.join(outDir, 'librarian_inject.exe');
  compile(vcvars, [
    '/nologo', '/W3', '/O2', '/D_CRT_SECURE_NO_WARNINGS',
    `"${path.join(__dirname, 'inject.c')}"`,
    `/Fe:"${injector}"`,
    '/link', 'kernel32.lib',
  ].join(' '), 'injector');
  if (!fs.existsSync(injector)) throw new Error('injector did not build');

  return { dll, injector };
}

if (require.main === module) {
  try {
    const built = build(process.argv[2]);
    for (const [what, file] of Object.entries(built)) {
      console.log('built', what, '-', file, fs.statSync(file).size, 'bytes');
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { build, findVcvars, compile };
