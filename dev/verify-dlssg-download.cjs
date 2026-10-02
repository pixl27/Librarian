// Optional live-network check: downloads/validates a fresh cache, never a game DLL load.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');
const fetch = require('node-fetch');
const { createManager } = require('../src/core/dlssg');
const pins = require('../src/core/dlssgRelease.json');
async function run() {
  const output = process.env.LIBRARIAN_TEST_OUTPUT || path.resolve('audits/2026-09-09/dlssg-download');
  fs.mkdirSync(output, { recursive: true });
  const dataPath = fs.mkdtempSync(path.join(output, 'live-cache-'));
  const requests = [];
  const manager = createManager({ dataPath, fetch: async (url, options) => {
    const request = { url, started: Date.now() }; requests.push(request);
    try { const response = await fetch(url, options); request.status = response.status; return response; }
    catch (error) { request.error = error.message; throw error; }
    finally { request.milliseconds = Date.now() - request.started; }
  } });
  const cache = await manager.ensurePackage();
  const files = pins.files.map(file => {
    const bytes = fs.readFileSync(path.join(cache, file.name));
    const verified = bytes.length === file.size && crypto.createHash('sha256').update(bytes).digest('hex') === file.sha256;
    assert(verified, file.name); return { name: file.name, bytes: bytes.length, verified };
  });
  const offline = createManager({ dataPath, fetch: async () => { throw new Error('A complete verified cache must work offline'); } });
  assert.equal(await offline.ensurePackage(), cache);
  const report = { cache, versions: process.versions, requests, files, offlineReuse: true, gameFilesChanged: false };
  fs.writeFileSync(path.join(output, 'live-download.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
if (process.versions.electron) {
  const { app } = require('electron');
  app.whenReady().then(run).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
} else run().catch(error => { console.error(error); process.exitCode = 1; });
