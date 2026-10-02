/**
 * Build the launch-time tuning helper, and the D3D11 test application.
 *
 * Same toolchain and the same batch-file compile as the overlay (see
 * native/achoverlay/build.js, which this reuses): MSVC from the Build Tools,
 * because the Direct3D headers the test application needs ship with the
 * Windows SDK beside it.
 *
 *   node native/tune/build.js [outDir]             → librarian_tune.exe (ships)
 *   node native/tune/build.js --testapp <outDir>   → librarian_d3d11test.exe (never ships)
 */
const fs = require('fs');
const path = require('path');
const { findVcvars, compile } = require('../achoverlay/build.js');

function build(outDir = path.join(__dirname, "..", "..", "deps", "librarian")) {
  outDir = path.resolve(outDir);   // the compile runs from a temp dir; relative paths would land there
  const vcvars = findVcvars();
  if (!vcvars) throw new Error('vcvars64.bat not found (set LIBRARIAN_VCVARS)');
  fs.mkdirSync(outDir, { recursive: true });

  const exe = path.join(outDir, 'librarian_tune.exe');
  compile(vcvars, [
    '/nologo', '/W3', '/O2', '/MT', '/D_CRT_SECURE_NO_WARNINGS',
    `"${path.join(__dirname, 'tune.c')}"`,
    `/Fe:"${exe}"`,
    '/link', 'kernel32.lib', 'user32.lib',
  ].join(' '), 'tune helper');
  if (!fs.existsSync(exe)) throw new Error('compiler reported success but produced no helper');
  return { helper: exe };
}

function buildTestApp(outDir) {
  outDir = path.resolve(outDir);
  const vcvars = findVcvars();
  if (!vcvars) throw new Error('vcvars64.bat not found (set LIBRARIAN_VCVARS)');
  fs.mkdirSync(outDir, { recursive: true });

  const exe = path.join(outDir, 'librarian_d3d11test.exe');
  compile(vcvars, [
    '/nologo', '/W3', '/O2', '/MT', '/D_CRT_SECURE_NO_WARNINGS',
    `"${path.join(__dirname, 'd3d11test.c')}"`,
    `/Fe:"${exe}"`,
    '/link', 'd3d11.lib', 'dxgi.lib', 'dxguid.lib', 'd3dcompiler.lib', 'user32.lib',
  ].join(' '), 'd3d11 test app');
  if (!fs.existsSync(exe)) throw new Error('compiler reported success but produced no test app');
  return { testapp: exe };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const built = args[0] === '--testapp'
      ? buildTestApp(args[1] || path.join(__dirname, '..', '..', 'dev', 'bin'))
      : build(args[0]);
    for (const [what, file] of Object.entries(built)) {
      console.log('built', what, '-', file, fs.statSync(file).size, 'bytes');
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { build, buildTestApp };
