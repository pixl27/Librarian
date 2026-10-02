// Read PE headers/imports without loading code or reading a large game EXE into RAM.
const fs = require('fs/promises');

async function inspectPe(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const read = async (offset, length) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > size) throw new Error('Invalid PE offset');
      const bytes = Buffer.alloc(length);
      if ((await handle.read(bytes, 0, length, offset)).bytesRead !== length) throw new Error('Truncated PE');
      return bytes;
    };
    const dos = await read(0, 64);
    if (dos.readUInt16LE(0) !== 0x5a4d) return null;
    const peOffset = dos.readUInt32LE(60);
    const coff = await read(peOffset, 24);
    if (coff.readUInt32LE(0) !== 0x4550) return null;
    const x64 = coff.readUInt16LE(4) === 0x8664;
    const sectionCount = coff.readUInt16LE(6), optionalSize = coff.readUInt16LE(20);
    if (sectionCount > 96 || optionalSize < 112 || optionalSize > 4096) return null;
    const header = await read(peOffset + 24, optionalSize + sectionCount * 40);
    if (!x64 || header.readUInt16LE(0) !== 0x20b) return { x64: false, imports: [] };
    const offsetFor = rva => {
      for (let i = 0; i < sectionCount; i++) {
        const s = optionalSize + i * 40;
        const start = header.readUInt32LE(s + 12), length = header.readUInt32LE(s + 16);
        if (rva >= start && rva - start < length) return header.readUInt32LE(s + 20) + rva - start;
      }
      throw new Error('PE import outside file sections');
    };
    const imports = [];
    // Normal and delay-load import descriptors. Modern MSVC delay imports use RVAs.
    for (const [index, stride, nameOffset] of [[1, 20, 12], [13, 32, 4]]) {
      const entry = 112 + index * 8;
      if (entry + 8 > optionalSize || header.readUInt32LE(108) <= index) continue;
      const rva = header.readUInt32LE(entry), length = header.readUInt32LE(entry + 4);
      if (!rva || !length) continue;
      const base = offsetFor(rva);
      for (let i = 0; i < Math.min(512, Math.floor(length / stride)); i++) {
        const descriptor = await read(base + i * stride, stride);
        const nameRva = descriptor.readUInt32LE(nameOffset);
        if (!nameRva) break;
        if (index === 13 && !(descriptor.readUInt32LE(0) & 1)) continue;
        const namePosition = offsetFor(nameRva);
        const bytes = await read(namePosition, Math.min(256, size - namePosition));
        const end = bytes.indexOf(0);
        if (end < 0) throw new Error('Invalid PE import name');
        imports.push(bytes.toString('ascii', 0, end).toLowerCase());
      }
    }
    return { x64, imports };
  } catch { return null; }
  finally { await handle.close(); }
}

module.exports = { inspectPe };
