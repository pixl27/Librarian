// Read-only check of an existing game archive, including the packaged reader.
// Run with Electron's Node mode for --packaged (ASAR resolution is required).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const archive = process.argv[2];
if (!archive || archive.startsWith('--')) throw new Error('Usage: verify-manifest-filenames.cjs <game.zip> [--packaged]');
const resources = path.join(root, 'dist/win-unpacked/resources');
const appRoot = packaged ? path.join(resources, 'app.asar') : root;
const originalLoad = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { app: { isPackaged: packaged } };
  return originalLoad.call(this, id, ...args);
};
if (packaged) process.resourcesPath = resources;

(async () => {
  const { gameData, manifestFiles } = await require(path.join(appRoot, 'src/core/zipProcessor.js')).readGameArchive(archive);
  const { readManifestFile } = require(path.join(appRoot, 'src/core/steamPipe.js'));
  const format = require(path.join(packaged ? resources : root, 'deps/steammanifest/re/manifest_format.js'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-manifest-check-'));
  const report = { packaged, appid: gameData.appid, depots: [] };
  try {
    for (const [name, raw] of Object.entries(manifestFiles)) {
      const depot = name.split('_')[0];
      const file = path.join(temp, path.basename(name));
      fs.writeFileSync(file, raw);
      try {
        const before = format.parseManifest(raw);
        const decoded = readManifestFile(file, gameData.depots[depot]?.key);
        assert.equal(decoded.length, before.files.length);
        for (const entry of decoded) {
          assert.ok(entry.filename && !/[\x00-\x1f]/.test(entry.filename), 'invalid decoded filename');
          const resolved = path.resolve(temp, entry.filename);
          assert.ok(resolved.startsWith(temp + path.sep), 'decoded path escaped fixture');
        }
        report.depots.push({ depot, encrypted: before.filenames_encrypted, files: decoded.length, validPaths: true });
      } finally { fs.unlinkSync(file); }
    }
    assert.ok(report.depots.length > 0);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    fs.rmdirSync(temp);
    Module._load = originalLoad;
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
