const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const managed = process.argv[2];
if (!managed) throw new Error('Usage: build-valheim-online.cjs <Valheim Managed directory>');
const core = path.join(root, 'deps/bepinex/BepInEx/core');
const output = path.join(root, 'deps/valheim-online');
fs.mkdirSync(output, { recursive: true });
const sdk = execFileSync('dotnet', ['--list-sdks'], { encoding: 'utf8' }).trim().split(/\r?\n/).pop();
const match = /^(\S+) \[(.+)\]/.exec(sdk);
const csc = path.join(match[2], match[1], 'Roslyn/bincore/csc.dll');
const references = ['mscorlib.dll', 'netstandard.dll', 'System.dll', 'System.Core.dll', 'UnityEngine.dll', 'UnityEngine.CoreModule.dll'].map(name => path.join(managed, name));
references.push(...['BepInEx.dll', '0Harmony.dll'].map(name => path.join(core, name)));
const dll = path.join(output, 'Librarian.ValheimOnline.dll');
execFileSync('dotnet', [csc, '/nologo', '/noconfig', '/nostdlib+', '/target:library', '/optimize+', '/deterministic+', '/langversion:7.3', `/out:${dll}`,
  ...references.map(file => `/reference:${file}`), path.join(root, 'native/valheimonline/Librarian.ValheimOnline.cs')], { stdio: 'inherit', windowsHide: true });
console.log(dll);
const frameworkCsc = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const cecil = path.join(core, 'Mono.Cecil.dll');
fs.copyFileSync(cecil, path.join(output, 'Mono.Cecil.dll'));
execFileSync(frameworkCsc, ['/nologo', '/target:exe', '/optimize+', `/out:${path.join(output, 'ValheimCompatibility.exe')}`, `/reference:${cecil}`,
  path.join(root, 'native/valheimonline/Compatibility.cs')], { stdio: 'inherit', windowsHide: true });
