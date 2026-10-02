/**
 * Read the export table of a PE (Windows DLL).
 *
 * The proxy has to re-export every symbol the real steam_api64.dll does — a
 * game resolves its calls by name, so a single missing export is a game that
 * fails to start. Rather than hand-maintain a list of ~1500 names against a
 * library Valve keeps changing, the list is read from whatever DLL is actually
 * on disk and the .def file is generated from it.
 *
 * Only the bits of PE needed to walk to the export directory are parsed.
 */

const fs = require('fs');

function readExports(dllPath) {
  const buf = fs.readFileSync(dllPath);

  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE file (no MZ)');
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('not a PE file (no PE\\0\\0)');

  const coff = peOff + 4;
  const numSections = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = buf.readUInt16LE(opt);
  const pe32plus = magic === 0x20b;            // 0x10b = PE32, 0x20b = PE32+
  if (!pe32plus && magic !== 0x10b) throw new Error(`unknown optional header magic 0x${magic.toString(16)}`);

  // The export directory is data directory 0; its position differs between
  // PE32 and PE32+ because of the extra 64-bit fields.
  const dataDirs = opt + (pe32plus ? 112 : 96);
  const exportRva = buf.readUInt32LE(dataDirs);
  const exportSize = buf.readUInt32LE(dataDirs + 4);
  if (!exportRva || !exportSize) return { dllName: '', exports: [] };

  // Section table follows the optional header; needed to map RVA → file offset.
  const sections = [];
  const secBase = opt + optSize;
  for (let i = 0; i < numSections; i++) {
    const s = secBase + i * 40;
    sections.push({
      virtualAddress: buf.readUInt32LE(s + 12),
      virtualSize: buf.readUInt32LE(s + 8),
      rawSize: buf.readUInt32LE(s + 16),
      rawPointer: buf.readUInt32LE(s + 20),
    });
  }
  const toOffset = (rva) => {
    for (const s of sections) {
      const size = Math.max(s.virtualSize, s.rawSize);
      if (rva >= s.virtualAddress && rva < s.virtualAddress + size) {
        return s.rawPointer + (rva - s.virtualAddress);
      }
    }
    throw new Error(`RVA 0x${rva.toString(16)} is outside every section`);
  };
  const cstring = (off) => {
    let end = off;
    while (end < buf.length && buf[end] !== 0) end++;
    return buf.toString('latin1', off, end);
  };

  const ed = toOffset(exportRva);
  const ordinalBase = buf.readUInt32LE(ed + 16);
  const numFunctions = buf.readUInt32LE(ed + 20);
  const numNames = buf.readUInt32LE(ed + 24);
  const addrFunctions = buf.readUInt32LE(ed + 28);
  const addrNames = buf.readUInt32LE(ed + 32);
  const addrOrdinals = buf.readUInt32LE(ed + 36);

  const dllName = cstring(toOffset(buf.readUInt32LE(ed + 12)));
  const namesOff = toOffset(addrNames);
  const ordsOff = toOffset(addrOrdinals);
  const funcsOff = toOffset(addrFunctions);

  const exports = [];
  for (let i = 0; i < numNames; i++) {
    const name = cstring(toOffset(buf.readUInt32LE(namesOff + i * 4)));
    const ordinal = buf.readUInt16LE(ordsOff + i * 2);
    const funcRva = buf.readUInt32LE(funcsOff + ordinal * 4);
    // An address inside the export directory means the export is itself a
    // forwarder ("OTHERDLL.Func") rather than real code.
    const forwarded = funcRva >= exportRva && funcRva < exportRva + exportSize;
    exports.push({
      name,
      ordinal: ordinal + ordinalBase,
      forwarder: forwarded ? cstring(toOffset(funcRva)) : null,
    });
  }

  exports.sort((a, b) => a.ordinal - b.ordinal);
  return { dllName, exports, numFunctions };
}

module.exports = { readExports };

if (require.main === module) {
  const target = process.argv[2];
  if (!target) { console.error('usage: node peExports.js <dll>'); process.exit(1); }
  const { dllName, exports } = readExports(target);
  console.error(`${dllName}: ${exports.length} named exports`);
  for (const e of exports) console.log(e.name);
}
