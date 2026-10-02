// Read-only check under Electron's Node runtime, against the built ASAR.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const resources = path.join(root, 'dist/win-unpacked/resources');
const game = process.argv[2];
if (!game) throw new Error('Usage: verify-online-package.cjs <game directory>');
process.resourcesPath = resources;
const originalLoad = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { app: { isPackaged: true } };
  return originalLoad.call(this, id, ...args);
};
try {
  const online = require(path.join(resources, 'app.asar/src/core/onlineMode.js'));
  const steam = online.getSteamProxyStatus(game);
  assert.ok(steam.length);
  for (const part of steam) {
    assert.equal(part.installed, true);
    assert.equal(part.stale, false);
    assert.equal(online.steamProxyCovers(part.original).ok, true);
  }
  const report = { packaged: true, adapters: steam.length, installed: true, current: true, coverage: true };
  const output = path.join(root, 'audits/2026-09-14/online-adapter');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'packaged-valheim.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { Module._load = originalLoad; }
