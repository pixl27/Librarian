// Small, synchronous transactions for user data. Never publish an in-memory
// mutation before rename succeeds, and never mistake an unreadable file for a
// first run. Callers own their cache; this module owns disk durability.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function read(file, fallback, valid = value => value && typeof value === 'object') {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return clone(fallback); throw error; }
  try {
    const value = JSON.parse(raw);
    if (!valid(value)) throw new Error('Invalid document shape');
    return value;
  } catch (error) {
    // If preservation fails, stop here. Continuing could destroy the original.
    const preserved = `${file}.corrupt-${Date.now()}-${randomUUID()}`;
    fs.copyFileSync(file, preserved, fs.constants.COPYFILE_EXCL);
    let recovered = clone(fallback);
    try {
      const backup = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
      if (valid(backup)) recovered = backup;
    } catch (backupError) {
      if (backupError.code && backupError.code !== 'ENOENT') throw backupError;
    }
    // Do not let the next transaction replace a good backup with corrupt bytes.
    write(file, recovered, { backup: false });
    console.warn(`Recovered ${path.basename(file)}; original preserved at ${preserved}`);
    return recovered;
  }
}

function write(file, value, { backup = true } = {}) {
  const tmp = `${file}.${process.pid}-${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    if (backup) {
      try { fs.copyFileSync(file, `${file}.bak`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') console.warn(error.message); }
  }
}

module.exports = { read, write, clone };
