// Read-only live probe: endpoint-issued manifest codes, no Steam session or game install.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-manifest-live-'));
const electronId = require.resolve('electron');
require.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: {
  app: { getPath: () => fixture, isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
} };
const output = path.resolve(process.env.LIBRARIAN_TEST_OUTPUT || path.join(root, 'audits/2026-09-13/steammanifest'));
const report = { startedAt: new Date().toISOString(), appid: '1007', passed: false };
const watchdog = setTimeout(() => { console.error('Live manifest probe exceeded 150 seconds'); process.exit(1); }, 150000);
(async () => {
  const sm = require('../src/core/steamManifest');
  const result = await sm.downloadManifest(report.appid, {
    userData: fixture, steamPath: '', keyFiles: [], appTokens: false, depotKeyCatalog: false, proxies: [],
    onLog: console.log,
  });
  assert.equal(result.error, null, result.error);
  assert.equal(result.counts.steam, 0, 'Direct Steam acquisition must not run');
  assert.ok(result.counts.mirror > 0, 'The configured relay must supply the manifest code');
  const archive = await require('../src/core/zipProcessor').readGameArchive(result.filepath, report.appid);
  const decoder = sm.load(sm.resolveDir().dir).manifest;
  const depots = Object.keys(archive.gameData.depots);
  assert.ok(depots.length);
  for (const id of depots) {
    const gid = archive.gameData.manifests[id];
    const manifest = decoder.parseManifest(archive.manifestFiles[`${id}_${gid}.manifest`]);
    assert.equal(String(manifest.depot_id), id);
    assert.equal(String(manifest.gid_manifest), gid);
    assert.match(archive.gameData.depots[id].key, /^[0-9a-f]{64}$/);
  }
  Object.assign(report, { passed: true, depots, buildid: result.buildid, counts: result.counts, note: result.note });
})().catch(error => { report.error = error.message; process.exitCode = 1; }).finally(() => {
  clearTimeout(watchdog);
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'live-steam.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  const resolved = fs.realpathSync(fixture);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith('librarian-manifest-live-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
