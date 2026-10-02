/**
 * Build the window-border helper.
 *
 * Separate from the achievement overlay's build because it shares nothing with
 * it but the compiler: this is a forty-line program against dwmapi, and pairing
 * it with a Direct3D hook would only make both harder to reason about. The
 * toolchain lookup is reused rather than copied.
 *
 * Usage: node native/winborder/build.js [outDir]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { findVcvars } = require('../achoverlay/build');

function build(outDir = path.join(__dirname, '..', '..', 'deps', 'librarian')) {
  const vcvars = findVcvars();
  if (!vcvars) throw new Error('vcvars64.bat not found (set LIBRARIAN_VCVARS)');

  fs.mkdirSync(outDir, { recursive: true });
  const exe = path.join(outDir, 'librarian_winborder.exe');

  // A batch file rather than `cmd /c "…"`: the command needs nested quotes for
  // paths with spaces plus an && between them, and cmd's own quoting rules
  // mangle that combination in ways that fail without saying why.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libwb-'));
  const script = path.join(dir, 'build.bat');
  const args = [
    '/nologo', '/W3', '/O2', '/D_CRT_SECURE_NO_WARNINGS',
    `"${path.join(__dirname, 'winborder.c')}"`,
    `/Fe:"${exe}"`,
    '/link', 'user32.lib',
  ].join(' ');
  fs.writeFileSync(script, ['@echo off', `call "${vcvars}" >nul 2>&1 || exit /b 1`, `cl ${args}`].join('\r\n'), 'utf-8');

  try {
    execFileSync('cmd', ['/c', script], { cwd: dir, stdio: 'pipe' });
  } catch (err) {
    const detail = [err.stdout, err.stderr].filter(Boolean).map(String).join('\n').trim();
    throw new Error(`winborder compile failed:\n${detail || err.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (!fs.existsSync(exe)) throw new Error('compiler reported success but produced no exe');
  return exe;
}

if (require.main === module) {
  try {
    const exe = build(process.argv[2]);
    console.log('built', exe, fs.statSync(exe).size, 'bytes');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { build };
