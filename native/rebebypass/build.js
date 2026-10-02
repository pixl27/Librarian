/**
 * Build the Rebe auth-bypass REFramework plugin.
 *
 * A REFramework plugin is a plain DLL exporting reframework_plugin_required_version and
 * reframework_plugin_initialize; it is loaded from <game>/reframework/plugins/ after the game
 * is up, and hooks managed methods through the plugin SDK (reframework/API.hpp, vendored at the
 * exact commit of the installed build for ABI match).
 *
 * The header is C++ and pulls in <windows.h> transitively via the game types; /MT to avoid a
 * runtime-DLL dependency, /EHsc for the API's exceptions. We verify the two required exports are
 * present in the built DLL, because a plugin missing an export is silently ignored by REFramework.
 *
 * Usage: node native/rebebypass/build.js [outDir]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readExports } = require('../../tools/peExports');

const VCVARS = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat';
const REQUIRED = ['reframework_plugin_required_version', 'reframework_plugin_initialize'];

function build(outDir) {
  const vcvars = [process.env.LIBRARIAN_VCVARS, VCVARS].filter(Boolean).find(p => fs.existsSync(p));
  if (!vcvars) throw new Error('vcvars64.bat not found (set LIBRARIAN_VCVARS)');
  fs.mkdirSync(outDir, { recursive: true });

  const win = p => path.resolve(p).replace(/\//g, '\\');
  const outDll = path.join(outDir, 'rebebypass.dll');
  const batPath = path.join(outDir, 'build.bat');
  fs.writeFileSync(batPath, [
    '@echo off',
    `call "${win(vcvars)}" >nul || exit /b 1`,
    [
      'cl /nologo /LD /MT /O2 /W3 /EHsc /std:c++20 /D_CRT_SECURE_NO_WARNINGS',
      `/I"${win(path.join(__dirname))}"`,
      `"${win(path.join(__dirname, 'rebebypass.cpp'))}"`,
      `/Fo"${win(outDir)}\\\\"`,
      `/Fe"${win(outDll)}"`,
    ].join(' '),
    'exit /b %ERRORLEVEL%',
  ].join('\r\n') + '\r\n');

  let output = '';
  try {
    output = execFileSync('cmd.exe', ['/c', win(batPath)], { cwd: outDir, encoding: 'utf8' });
  } catch (e) {
    throw new Error(`compile failed:\n${e.stdout || ''}${e.stderr || ''}`);
  }

  const exports = readExports(outDll).exports.map(e => e.name);
  const missing = REQUIRED.filter(n => !exports.includes(n));
  if (missing.length) throw new Error(`built DLL missing required exports: ${missing.join(', ')}`);
  return { outDll, exports };
}

module.exports = { build };

if (require.main === module) {
  const outDir = process.argv[2] || path.join(__dirname, 'out');
  const r = build(outDir);
  console.log(`${r.outDll}: exports OK [${r.exports.join(', ')}]`);
}
