const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { adaptProxy, parsePe } = require('../src/core/steamProxyAdapter');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-online-adapter-'));
const vcvars = process.env.LIBRARIAN_VCVARS || 'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Auxiliary/Build/vcvars64.bat';
const template = fs.readFileSync(path.join(root, 'deps/librarian/steam_api64.dll'));
const write = (name, text) => fs.writeFileSync(path.join(temp, name), text);
const report = [];
function test(name, fn) { fn(); report.push(name); console.log(`PASS ${name}`); }
write('fixture.c', `
int SteamAPI_SteamUGC_v017(void) { return 17017; }
int SteamAPI_SteamGameServerUGC_v017(void) { return 17018; }
int FutureEntry(void) { return 123456; }
int OrdinalOnly(void) { return 808; }
int SteamAPI_ISteamUtils_GetAppID(void *p) { return 999; }
int ExportedData = 42;
`);
write('v1.def', 'EXPORTS\n SteamAPI_SteamUGC_v017 @10\n SteamAPI_SteamGameServerUGC_v017 @12\n SteamAPI_ISteamUtils_GetAppID @20\n ExportedData @31 DATA\n OrdinalOnly @77 NONAME\n');
write('v2.def', 'EXPORTS\n SteamAPI_SteamUGC_v017 @15\n SteamAPI_SteamGameServerUGC_v017 @16\n SteamAPI_ISteamUtils_GetAppID @23\n ExportedData @31 DATA\n FutureEntry @44\n OrdinalOnly @77 NONAME\n');
write('host.c', `
#include <windows.h>
#include <stdio.h>
#include <string.h>
typedef int (*fn)(void);
typedef int (*hookfn)(void*);
int main(int argc, char **argv) {
 HMODULE h=LoadLibraryExA(argv[1],NULL,LOAD_WITH_ALTERED_SEARCH_PATH);
 if(!h) { printf("LoadLibrary error %lu\\n",GetLastError()); return 1; }
 if(argc>2 && !strcmp(argv[2],"--resolve-only")) {
  HMODULE original=GetModuleHandleA("steam_api64_o.dll");
  const char *names[]={"SteamAPI_SteamUGC_v017","SteamAPI_SteamGameServerUGC_v017"};
  for(int i=0;i<2;i++) { FARPROC p=GetProcAddress(h,names[i]); if(!p||p!=GetProcAddress(original,names[i])) return 5; }
  printf("Both missing Valheim exports resolve to the genuine SDK\\n"); return 0;
 }
 fn a=(fn)GetProcAddress(h,"SteamAPI_SteamUGC_v017");
 fn b=(fn)GetProcAddress(h,"SteamAPI_SteamGameServerUGC_v017");
 fn ordinal=(fn)GetProcAddress(h,(LPCSTR)77);
 hookfn hook=(hookfn)GetProcAddress(h,"SteamAPI_ISteamUtils_GetAppID");
 int *data=(int*)GetProcAddress(h,"ExportedData");
 if(!a||!b||!ordinal||!hook||!data) { printf("Missing resolved export\\n"); return 2; }
 if(a()!=17017||b()!=17018||ordinal()!=808||hook(NULL)!=892970||*data!=42) return 3;
 if(argc>2) { fn future=(fn)GetProcAddress(h,"FutureEntry"); if(!future||future()!=123456) return 4; }
 printf("Native forwarding, ordinal, data and existing hook OK\\n"); return 0;
}
`);
write('build.bat', `@echo off\r\ncall "${vcvars}" >nul 2>&1 || exit /b 1\r\ncl /nologo /LD /O2 fixture.c /link /DEF:v1.def /OUT:v1.dll >build-v1.log 2>&1 || exit /b 1\r\ncl /nologo /LD /O2 fixture.c /link /DEF:v2.def /OUT:v2.dll >build-v2.log 2>&1 || exit /b 1\r\ncl /nologo /O2 host.c /Fe:host.exe >build-host.log 2>&1\r\n`);
execFileSync('cmd.exe', ['/d', '/c', path.join(temp, 'build.bat')], { cwd: temp, windowsHide: true });
const v1 = fs.readFileSync(path.join(temp, 'v1.dll')), v2 = fs.readFileSync(path.join(temp, 'v2.dll'));
if (process.argv[2]) test('Actual game exports resolve to the genuine SDK without starting Steam or the game', () => {
  const dir = path.join(temp, 'actual'); fs.mkdirSync(dir);
  const genuine = fs.readFileSync(process.argv[2]);
  fs.writeFileSync(path.join(dir, 'steam_api64_o.dll'), genuine);
  fs.writeFileSync(path.join(dir, 'steam_api64.dll'), adaptProxy(template, genuine));
  fs.writeFileSync(path.join(dir, 'librarian_online.ini'), 'appid=892970\nsteam_overlay=0\n');
  execFileSync(path.join(temp, 'host.exe'), [path.join(dir, 'steam_api64.dll'), '--resolve-only'], { windowsHide: true, timeout: 15000 });
});
test('Native Windows loader resolves names, ordinals, data and retained hooks across SDK versions', () => {
  for (const [i, genuine] of [v1, v2].entries()) {
    const dir = path.join(temp, `native-${i}`); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'steam_api64_o.dll'), genuine);
    fs.writeFileSync(path.join(dir, 'steam_api64.dll'), adaptProxy(template, genuine));
    fs.writeFileSync(path.join(dir, 'librarian_online.ini'), 'appid=892970\nsteam_overlay=0\n');
    execFileSync(path.join(temp, 'host.exe'), [path.join(dir, 'steam_api64.dll'), ...(i ? ['future'] : [])], { windowsHide: true, timeout: 15000 });
  }
});
test('Corrupt, truncated and wrong-architecture originals fail closed', () => {
  for (const length of [0, 63, 128, 512]) assert.throws(() => adaptProxy(template, v1.subarray(0, length)));
  const x86 = Buffer.from(v1); x86.writeUInt16LE(0x14c, x86.readUInt32LE(60) + 4);
  assert.throws(() => adaptProxy(template, x86), /x64/);
  assert.throws(() => adaptProxy(template, adaptProxy(template, v1)), /itself a Librarian proxy/);
});
test('The adapter preserves code sections and the exact original name/ordinal surface', () => {
  const result = adaptProxy(template, v2), pe = parsePe(template), adapted = parsePe(result), genuine = parsePe(v2);
  assert.deepEqual([...adapted.byName.keys()], [...genuine.byName.keys()].sort());
  for (const section of pe.sections) assert.ok(template.subarray(section.raw, section.raw + section.rawSize).equals(result.subarray(section.raw, section.raw + section.rawSize)));
  for (const [name, entry] of genuine.byName) assert.equal(adapted.byName.get(name).ordinal, entry.ordinal);
});
const settingsId = require.resolve('../src/core/settingsStore');
require.cache[settingsId] = { id: settingsId, filename: settingsId, loaded: true, exports: { get: () => false } };
const online = require('../src/core/onlineMode');
const game = path.join(temp, 'game'); fs.mkdirSync(game);
const exe = path.join(game, 'game.exe'), dll = path.join(game, 'steam_api64.dll');
const emu = Buffer.from('EMU_MISSING_INTERFACE fixture emulator');
fs.writeFileSync(exe, 'fixture'); fs.writeFileSync(dll, emu); fs.writeFileSync(dll + '.bak', v1);
fs.writeFileSync(path.join(game, 'steam_appid.txt'), '892970');
fs.mkdirSync(path.join(game, '.DepotDownloader'));
fs.writeFileSync(path.join(game, '.DepotDownloader', 'appmanifest_892970.acf'), '"AppState" { "appid" "892970" }');
test('Enable is idempotent and disable restores the original offline state', () => {
  assert.equal(online.enableOnline(game, exe, 'Fixture').success, true);
  assert.equal(online.getSteamProxyStatus(game)[0].stale, false);
  const before = fs.readFileSync(dll);
  assert.equal(online.enableOnline(game, exe, 'Fixture').success, true);
  assert.ok(fs.readFileSync(dll).equals(before));
  assert.equal(online.disableOnline(game, exe).success, true);
  assert.ok(fs.readFileSync(dll).equals(emu));
  assert.equal(fs.readFileSync(path.join(game, 'steam_appid.txt'), 'utf8'), '892970');
});
test('An update keeps the newest genuine DLL despite stale .bak and _o files', () => {
  assert.equal(online.enableOnline(game, exe, 'Fixture').success, true);
  fs.writeFileSync(dll, v2); // publisher overwrites live SDK, leaves old backups
  assert.equal(online.verifyOnline(game, exe).intact, false);
  const reapply = online.reapplyIfNeeded(game, exe, 'Fixture');
  assert.equal(reapply.result?.success, true);
  assert.ok(fs.readFileSync(path.join(game, 'steam_api64_o.dll')).equals(v2));
  assert.ok(fs.readFileSync(dll + '.bak').equals(v2));
  assert.equal(online.getSteamProxyStatus(game)[0].stale, false);
  assert.equal(online.disableOnline(game, exe).success, true);
  assert.equal(online.enableOnline(game, exe, 'Fixture').success, true);
  assert.ok(fs.readFileSync(path.join(game, 'steam_api64_o.dll')).equals(v2));
});
test('Preflight failures leave App ID, live DLL and emulator backup unchanged', () => {
  online.disableOnline(game, exe);
  fs.writeFileSync(dll + '.bak', 'invalid original');
  const before = [dll, dll + '.goldberg', path.join(game, 'steam_appid.txt')].map(file => fs.readFileSync(file));
  assert.equal(online.enableOnline(game, exe, 'Fixture').success, false);
  [dll, dll + '.goldberg', path.join(game, 'steam_appid.txt')].forEach((file, i) => assert.ok(fs.readFileSync(file).equals(before[i])));
});
test('Disabling twice preserves the restored real game App ID', () => {
  fs.writeFileSync(path.join(game, 'steam_appid.txt'), '892970');
  assert.equal(online.disableOnline(game, exe).success, true);
  assert.equal(online.disableOnline(game, exe).success, true);
  assert.equal(fs.readFileSync(path.join(game, 'steam_appid.txt'), 'utf8'), '892970');
});
test('A confirmed startup rejection prevents reactivation before any files change', () => {
  fs.writeFileSync(dll + '.bak', v2);
  const marker = path.join(game, '.DepotDownloader', 'online-startup-block.json');
  fs.writeFileSync(marker, JSON.stringify({ version: 1, kind: 'app-id-rejected', sessionAppId: '480', at: 1 }));
  const before = fs.readFileSync(dll);
  assert.match(online.getStartupBlock(game).reason, /rejected/);
  const result = online.enableOnline(game, exe, 'Fixture');
  assert.equal(result.success, false);
  assert.match(result.error, /rejected/);
  assert.ok(fs.readFileSync(dll).equals(before));
  assert.equal(fs.readFileSync(path.join(game, 'steam_appid.txt'), 'utf8'), '892970');
  online.disableOnline(game, exe);
  assert.ok(online.getStartupBlock(game), 'disabling erased the compatibility evidence');
});
const output = path.resolve(process.env.LIBRARIAN_TEST_OUTPUT || path.join(root, 'audits/2026-09-14/online-adapter'));
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'tests.json'), JSON.stringify({ passed: report, fixtures: temp }, null, 2));
console.log(`${report.length}/${report.length} passed; native fixtures: ${temp}`);
