const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..'), archive = path.join(root, 'dist/win-unpacked/resources/app.asar');
const files = ['main.js', 'preload.js'];
function walk(directory) {
  for (const item of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) walk(file); else if (item.isFile()) files.push(file);
  }
}
walk('src');
const results = files.map(file => ({ file, same: asar.extractFile(archive, file).equals(fs.readFileSync(path.join(root, file))) }));
assert(results.length > 60);
assert.deepEqual(results.filter(r => !r.same), [], 'Packaged source is stale');
assert(!fs.existsSync(path.join(root, 'dist/win-unpacked/resources/deps/SteamAutoCrack/Goldberg/steamclient_experimental/steamclient_loader_x64.exe')));
const release = JSON.parse(asar.extractFile(archive, path.join('src', 'core', 'dlssgRelease.json')));
assert.equal(release.commit, require('../src/core/dlssgRelease.json').commit);
const output = path.join(process.env.LIBRARIAN_TEST_OUTPUT || path.join(root, 'audits/2026-09-09/dlssg-sm86'), 'package-source-check.json');
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(results, null, 2));
console.log(`PASS ${results.length} packaged source files match; pinned release included; unused blocked loader excluded`);
