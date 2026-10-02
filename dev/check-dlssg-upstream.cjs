// Read-only live discovery. This command downloads metadata, never a DLL.
const fs = require('fs');
const path = require('path');
const { createUpstream } = require('../src/core/dlssgUpstream');
const baseline = require('../src/core/dlssgRelease.json');
(async () => {
  const upstream = createUpstream(require('node-fetch'));
  const release = await upstream.check();
  const newer = await upstream.isNewer(baseline.commit, release.commit);
  const report = { checkedAt: new Date().toISOString(), baseline: baseline.commit, newer, release, gameFilesChanged: false, payloadDownloaded: false };
  const output = process.env.LIBRARIAN_TEST_OUTPUT || path.resolve('audits/2026-09-11/dlssg-updates');
  fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'upstream-check.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
