// Measures two write patterns the engine produces, on the drive holding <dir>:
//
//   1. a write far past the bytes a fresh file already holds (what a
//      deduplicated chunk does when its second home is deep inside a file the
//      download has not reached yet)
//   2. a flush per small file (what evicting a dirty handle does)
//
// and replays real manifests through the engine's write order to count how
// many bytes pattern 1 costs on actual games.
//
//   node dev/bench-disk-patterns.cjs <scratch dir> [manifest ...]
const fs = require('fs');
const path = require('path');
const format = require('../deps/steammanifest/re/manifest_format.js');

const dir = process.argv[2];
const manifests = process.argv.slice(3);
const MB = 1024 * 1024;

function timed(fn) { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; }

function farWrite(sizeMb) {
  const chunk = Buffer.alloc(MB, 0xA5);
  const out = {};
  for (const [label, offset] of [['at offset 0', 0], ['at the far end', (sizeMb - 1) * MB]]) {
    const p = path.join(dir, `.bench-far-${process.pid}-${offset}.bin`);
    const fd = fs.openSync(p, 'w+');
    try {
      fs.ftruncateSync(fd, sizeMb * MB);
      const write = timed(() => fs.writeSync(fd, chunk, 0, chunk.length, offset));
      const sync = timed(() => fs.fsyncSync(fd));
      out[label] = { write, sync };
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(p);
    }
  }
  return out;
}

function smallFiles(count, bytes) {
  const body = Buffer.alloc(bytes, 0x5A);
  const sub = path.join(dir, `.bench-small-${process.pid}`);
  const out = {};
  for (const flush of [false, true]) {
    fs.mkdirSync(sub, { recursive: true });
    out[flush ? 'fsync each' : 'no fsync'] = timed(() => {
      for (let i = 0; i < count; i++) {
        const fd = fs.openSync(path.join(sub, `f${i}.bin`), 'w');
        fs.writeSync(fd, body, 0, body.length, 0);
        if (flush) fs.fsyncSync(fd);
        fs.closeSync(fd);
      }
    });
    fs.rmSync(sub, { recursive: true, force: true });
  }
  return out;
}

/**
 * Replay a manifest in the engine's order — groups sorted by their first
 * destination, every destination written when the group is fetched — and count
 * the bytes NTFS would have to zero because a write landed past what the file
 * already held.
 */
function replay(manifestPath) {
  const manifest = format.parseManifest(fs.readFileSync(manifestPath));
  const groups = new Map();
  let total = 0, targets = 0;
  manifest.files.forEach((file, fileIdx) => {
    if (file.flags & 0x40) return;
    for (const c of file.chunks || []) {
      if (!c.sha) continue;
      let g = groups.get(c.sha);
      if (!g) { g = { len: c.cb_original, targets: [] }; groups.set(c.sha, g); }
      g.targets.push({ fileIdx, offset: Number(c.offset) });
      total += c.cb_original;
      targets++;
    }
  });
  const order = [...groups.values()].sort((a, b) =>
    (a.targets[0].fileIdx - b.targets[0].fileIdx) || (a.targets[0].offset - b.targets[0].offset));
  const valid = new Map();   // fileIdx -> bytes the file holds so far
  let zeroed = 0, farWrites = 0;
  for (const g of order) {
    for (const t of g.targets) {
      const have = valid.get(t.fileIdx) || 0;
      if (t.offset > have) { zeroed += t.offset - have; farWrites++; }
      if (t.offset + g.len > have) valid.set(t.fileIdx, t.offset + g.len);
    }
  }
  return { total, targets, duplicates: targets - groups.size, zeroed, farWrites };
}

console.log(`scratch: ${dir}`);
for (const sizeMb of [256, 1024]) {
  const r = farWrite(sizeMb);
  console.log(`1 MB into a fresh ${sizeMb} MB file:`);
  for (const [label, v] of Object.entries(r)) console.log(`  ${label.padEnd(16)} write ${v.write.toFixed(1)} ms, fsync ${v.sync.toFixed(1)} ms`);
}
const small = smallFiles(300, 64 * 1024);
for (const [label, ms] of Object.entries(small)) console.log(`300 files x 64 KB, ${label.padEnd(10)}: ${ms.toFixed(0)} ms (${(ms / 300).toFixed(2)} ms/file)`);

for (const m of manifests) {
  try {
    const r = replay(m);
    console.log(`${path.basename(m)}: install ${(r.total / MB / 1024).toFixed(2)} GB, ${r.targets} chunks, ${r.duplicates} duplicate destinations, `
      + `${r.farWrites} far writes -> ${(r.zeroed / MB / 1024).toFixed(2)} GB zero-filled (${(100 * r.zeroed / r.total).toFixed(1)}% extra)`);
  } catch (err) {
    console.log(`${path.basename(m)}: ${err.message}`);
  }
}
