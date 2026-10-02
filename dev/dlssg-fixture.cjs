const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function executable(file, imports = ['version.dll', 'd3d12.dll'], x64 = true, delayImports = []) {
  const bytes = Buffer.alloc(8192);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(x64 ? 0x8664 : 0x14c, 132);
  bytes.writeUInt16LE(1, 134); bytes.writeUInt16LE(240, 148);
  const opt = 152, sec = opt + 240;
  bytes.writeUInt16LE(x64 ? 0x20b : 0x10b, opt); bytes.writeUInt32LE(16, opt + 108);
  bytes.writeUInt32LE(0x1100, opt + 120); bytes.writeUInt32LE((imports.length + 1) * 20, opt + 124);
  bytes.writeUInt32LE(0x1000, sec + 12); bytes.writeUInt32LE(0x1800, sec + 16); bytes.writeUInt32LE(512, sec + 20);
  imports.forEach((name, i) => { bytes.writeUInt32LE(0x1400 + i * 128, 768 + i * 20 + 12); bytes.write(name + '\0', 1536 + i * 128, 'ascii'); });
  if (delayImports.length) {
    bytes.writeUInt32LE(0x1800, opt + 216); bytes.writeUInt32LE((delayImports.length + 1) * 32, opt + 220);
    delayImports.forEach((name, i) => { bytes.writeUInt32LE(1, 2560 + i * 32); bytes.writeUInt32LE(0x1c00 + i * 128, 2564 + i * 32); bytes.write(name + '\0', 3584 + i * 128, 'ascii'); });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
}
function packageFixture() {
  const payload = { 'version.dll': Buffer.from('Inert fixture proxy; never executed.'), 'dlssg_sm86.ini': Buffer.from('[General]\nEnabled=1\n'), 'README.en.md': Buffer.from('Fixture instructions') };
  const release = { repository: 'https://github.com/sdli1995/dlssg_for_sm86', commit: 'fixture', runtime: '310.1', files: Object.entries(payload).map(([name, bytes]) => ({ name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), deploy: name !== 'README.en.md' })) };
  const fetch = async url => ({ ok: true, buffer: async () => payload[new URL(url).pathname.split('/').at(-1)] });
  return { release, fetch, payload };
}
module.exports = { executable, packageFixture };
