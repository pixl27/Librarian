// clearStaleBackups against the three states an update can leave a steam_api64
// in. Fixtures are real files: CONTROL Resonant's Valve library (the .bak) and
// the emulator SteamAutoCrack ships; "damaged" is that emulator cut to Valve's
// length, which is what the update did to CONTROL Resonant on 2026-10-01.
// Usage: node dev/verify-stale-backups.cjs <valve steam_api64.dll>
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { clearStaleBackups, checkSacStatus } = require('../src/core/autoCrack');

const valve = process.argv[2];
const emulator = path.join(checkSacStatus().goldbergDir, 'x64', 'steam_api64.dll');
const sha = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };

function game(live) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-bak-'));
  fs.writeFileSync(path.join(dir, 'steam_api64.dll'), live);
  fs.copyFileSync(valve, path.join(dir, 'steam_api64.dll.bak'));
  return dir;
}
const valveBytes = fs.readFileSync(valve);
const emuBytes = fs.readFileSync(emulator);

// 1. Damaged: the emulator truncated to Valve's length.
let dir = game(emuBytes.subarray(0, valveBytes.length));
let logs = [];
check(clearStaleBackups(dir, (m) => logs.push(m)) === 1, 'damaged library: one entry handled');
check(sha(path.join(dir, 'steam_api64.dll')) === sha(valve), 'damaged library: Valve copy restored from the backup');
check(!fs.existsSync(path.join(dir, 'steam_api64.dll.bak')), 'damaged library: backup consumed, so the crack starts clean');
console.log('     log:', logs.join(' | '));

// 2. Intact emulator: nothing to do.
dir = game(emuBytes);
check(clearStaleBackups(dir) === 0, 'intact emulator: untouched');
check(sha(path.join(dir, 'steam_api64.dll')) === sha(emulator) && fs.existsSync(path.join(dir, 'steam_api64.dll.bak')), 'intact emulator: both files kept');

// 3. Valve's library back in place (an update rewrote it): stale backup cleared.
dir = game(valveBytes);
check(clearStaleBackups(dir) === 1, 'genuine library: stale backup cleared');
check(sha(path.join(dir, 'steam_api64.dll')) === sha(valve) && !fs.existsSync(path.join(dir, 'steam_api64.dll.bak')), 'genuine library: live file kept, backup gone');

// 4. Damaged library whose "backup" is itself an emulator: never promote it.
dir = game(emuBytes.subarray(0, valveBytes.length));
fs.copyFileSync(emulator, path.join(dir, 'steam_api64.dll.bak'));
check(clearStaleBackups(dir) === 0, 'emulator backup: not restored over a damaged file');

console.log(failures ? `FAIL ${failures}` : 'OK stale-backups');
process.exit(failures ? 1 : 0);
