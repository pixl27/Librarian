// One-off installation of the exact package supplied and requested by the user.
// All replaced files are retained with hashes for rollback; no game saves touched.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const source = 'C:/Users/One/Downloads/Compressed/Valheim_Fix_Repair_Steam_V5_Generic';
const game = path.resolve('E:/Games/steam/steamapps/common/Valheim');
const id = crypto.randomUUID();
const backup = path.join(game, '.DepotDownloader', `provided-fix-backup-${id}`);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function list(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Package contains a symbolic link');
    return entry.isDirectory() ? list(file) : [file];
  });
}
const plan = list(source).filter(file => !file.endsWith('.url')).map(from => {
  const relative = path.relative(source, from), to = path.resolve(game, relative);
  if (!to.startsWith(game + path.sep)) throw new Error('Path escapes game directory');
  for (let current = to; current !== game; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Destination contains a symbolic link');
  }
  return { relative, from, to, originalHash: fs.existsSync(to) ? hash(to) : null, installedHash: hash(from) };
});
fs.mkdirSync(backup, { recursive: true });
const receipt = { version: 1, source, game, backup, at: Date.now(), files: plan };
const receiptPath = path.join(backup, 'receipt.json');
fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
for (const item of plan) {
  if (!item.originalHash) continue;
  const saved = path.join(backup, item.relative);
  fs.mkdirSync(path.dirname(saved), { recursive: true });
  fs.copyFileSync(item.to, saved);
  if (hash(saved) !== item.originalHash) throw new Error('Backup hash mismatch');
}
const applied = [];
try {
  for (const item of plan) {
    fs.mkdirSync(path.dirname(item.to), { recursive: true });
    const temporary = item.to + `.${id}.tmp`;
    try {
      fs.copyFileSync(item.from, temporary);
      if (hash(temporary) !== item.installedHash) throw new Error('Installed hash mismatch');
      fs.renameSync(temporary, item.to);
      applied.push(item);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  fs.writeFileSync(path.join(game, '.DepotDownloader', 'provided-online-fix.json'), JSON.stringify(receipt, null, 2));
} catch (error) {
  for (const item of applied.reverse()) {
    if (item.originalHash) fs.copyFileSync(path.join(backup, item.relative), item.to);
    else fs.unlinkSync(item.to);
  }
  throw error;
}
console.log(JSON.stringify({ installed: applied.length, backup, originalsVerified: true }));
