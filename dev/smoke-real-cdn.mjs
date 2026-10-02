#!/usr/bin/env node
// Drive the real engine against Steam's real content servers for a few
// seconds, into a scratch directory that is deleted afterwards.
//
// The end-to-end harness proves the engine against a local origin; this is the
// check that the same code talks to the actual CDN — real mirrors, real
// headers, real zstd chunks. It is a smoke test, not a benchmark: the line's
// own speed varies far too much between runs to compare two of them.
//
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe dev/smoke-real-cdn.mjs [seconds=25]
//
// With no manifest given it picks, from the Steam depotcache, a depot between
// 300 MB and 3 GB whose key is in Librarian's own key store.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECONDS = Number(process.argv[2]) || 25;
const DEPOTCACHE = process.argv[3] || 'E:/Games/steam/depotcache';

const format = require(join(ROOT, 'deps', 'steammanifest', 're', 'manifest_format.js'));
const keys = JSON.parse(fs.readFileSync(join(process.env.APPDATA, 'librarian', 'depot_keys.json'), 'utf-8').replace(/^\uFEFF/, ''));

function pickManifest() {
  const candidates = fs.readdirSync(DEPOTCACHE)
    .filter(n => /^\d+_\d+\.manifest$/.test(n) && keys[n.split('_')[0]])
    .map(n => ({ name: n, mtime: fs.statSync(join(DEPOTCACHE, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates) {
    let manifest;
    try { manifest = format.parseManifest(fs.readFileSync(join(DEPOTCACHE, c.name))); } catch { continue; }
    let total = 0;
    for (const f of manifest.files) for (const ch of f.chunks || []) total += ch.cb_original;
    if (total > 300 * 1048576 && total < 3 * 1073741824) return { ...c, total };
  }
  return null;
}

const picked = pickManifest();
if (!picked) { console.error('FAIL no suitable manifest with a known key'); process.exit(1); }
const [depotId, manifestId] = basename(picked.name, '.manifest').split('_');
console.log(`depot ${depotId}, manifest ${manifestId}, ${(picked.total / 1048576).toFixed(0)} MB install`);

const scratch = fs.mkdtempSync(join(os.tmpdir(), 'librarian-smoke-'));
const manifestDir = join(scratch, 'manifests');
fs.mkdirSync(manifestDir, { recursive: true });
fs.copyFileSync(join(DEPOTCACHE, picked.name), join(manifestDir, picked.name));
const userData = join(scratch, 'userdata');
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(join(userData, 'librarian-settings.json'), JSON.stringify({
  slssteam_mode: false, auto_crack: false, use_lancache: true,
  download_adaptive: true, download_max_downloads: 16, download_speed_limit: 0,
  validate_fresh_downloads: false, settings_version: 99,
}));

const electronId = require.resolve('electron');
require.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: { app: { getPath: () => userData } } };
const engine = require(join(ROOT, 'src', 'core', 'steamPipe.js'));

const log = [];
let transferred = 0;
let pct = 0;
const started = Date.now();
let failure = null;
const handle = engine.startNativeDownload({
  appid: '480', game_name: 'Smoke', installdir: 'Smoke', buildid: '1',
  depots: { [depotId]: { key: keys[depotId], size: '0' } },
  manifests: { [depotId]: manifestId },
  manifest_dir: manifestDir,
  skip_auto_crack: true,
}, [depotId], join(scratch, 'lib'), {
  onProgress: (m) => { log.push(String(m)); console.log(`  ${m}`); },
  onPercentage: (p) => { pct = p; },
  onSpeed: () => {},
  onDiskSpeed: () => {},
  onTransferred: (b) => { transferred = b; },
  onPlan: () => {},
  onComplete: () => {},
  onError: (e) => { failure = String(e); },
});

await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
handle.stop();
await handle.done;
const elapsed = (Date.now() - started) / 1000;

// What landed has to be real: hash every chunk the state file claims.
const installDir = join(scratch, 'lib', 'steamapps', 'common', 'Smoke');
let verified = 0, bad = 0;
try {
  const state = JSON.parse(fs.readFileSync(join(installDir, '.DepotDownloader', '.librarian-pipe-state.json'), 'utf-8'));
  const bits = Buffer.from(state.bits, 'base64');
  const crypto = require('node:crypto');
  const manifest = format.parseManifest(fs.readFileSync(join(manifestDir, picked.name)));
  if (manifest.filenames_encrypted) format.decryptFilenames(manifest, Buffer.from(keys[depotId], 'hex'));
  // Same enumeration order as the engine: files in manifest order, chunks in file order.
  let index = 0;
  for (const file of manifest.files) {
    if (!file.filename || (file.flags & 0x40) || file.linktarget || !(file.chunks || []).length) continue;
    const p = join(installDir, ...file.filename.split(/[\\/]+/));
    let fd = null;
    for (const ch of file.chunks) {
      const claimed = (bits[index >> 3] >> (index & 7)) & 1;
      index++;
      if (!claimed) continue;
      if (fd === null) fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(ch.cb_original);
      fs.readSync(fd, buf, 0, buf.length, Number(ch.offset));
      if (crypto.createHash('sha1').update(buf).digest('hex') === ch.sha) verified++; else bad++;
    }
    if (fd !== null) fs.closeSync(fd);
  }
} catch (err) {
  failure = failure || `could not verify what was written: ${err.message}`;
}

fs.rmSync(scratch, { recursive: true, force: true });

console.log(`\n${(transferred / 1048576).toFixed(1)} MB off the wire in ${elapsed.toFixed(1)} s (setup included) = ${(transferred / 1048576 / elapsed).toFixed(2)} MB/s, ${pct}% of the depot`);
console.log(`${verified} chunk(s) claimed in the resume state re-hashed from disk, ${bad} mismatched`);
if (failure) { console.error(`FAIL ${failure}`); process.exit(1); }
if (!verified || bad) { console.error('FAIL nothing verified, or a claimed chunk does not match its hash'); process.exit(1); }
console.log('OK smoke-real-cdn');
process.exit(0);
