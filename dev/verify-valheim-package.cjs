// Run under Electron's Node mode. Inspects the installed game read-only.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const resources = path.join(root, 'dist/win-unpacked/resources');
const game = process.argv[2];
if (!game) throw new Error('Usage: verify-valheim-package.cjs <game directory>');
process.resourcesPath = resources;
const originalLoad = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { app: { isPackaged: true } };
  return originalLoad.call(this, id, ...args);
};
try {
  const source = path.join(resources, 'app.asar/src/core');
  const managed = require(path.join(source, 'valheimOnline.js')).status(game);
  assert.equal(managed.ok, true, JSON.stringify(managed)); assert.equal(managed.installed, true);
  assert.equal(managed.stale, false); assert.equal(managed.incomplete, false);
  const online = require(path.join(source, 'onlineMode.js')).verifyOnline(game, path.join(game, 'valheim.exe'));
  assert.equal(online.intended, true); assert.equal(online.intact, true);
  for (const file of ['OnlineFix64.dll', 'Custom.dll', 'SteamOverlay64.dll']) assert.equal(fs.existsSync(path.join(game, file)), false);
  const report = { packaged: true, managedCompatibility: true, managedFilesCurrent: true, nativeProxyCurrent: true, suppliedNativePackRemoved: true };
  fs.writeFileSync(path.join(root, 'audits/2026-09-14/valheim-startup/valheim-package.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { Module._load = originalLoad; }
