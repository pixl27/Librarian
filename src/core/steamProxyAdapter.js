// Rebuild the export directory of our x64 proxy from the game's current DLL.
// No game code is copied or loaded. Existing proxy implementations keep their
// RVAs; all other exports are Windows loader forwarders to the genuine library.
// Format: https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
const crypto = require('crypto');
const cache = new Map();

function parsePe(buf) {
  if (!Buffer.isBuffer(buf) || buf.length > 64 * 1024 * 1024) throw new Error('Invalid PE input size');
  const need = (offset, size) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || size < 0 || offset + size > buf.length) throw new Error('Truncated PE data');
  };
  need(0, 64);
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('Not a PE library');
  const pe = buf.readUInt32LE(60); need(pe, 24);
  if (buf.readUInt32LE(pe) !== 0x4550 || buf.readUInt16LE(pe + 4) !== 0x8664) throw new Error('Expected an x64 PE library');
  const opt = pe + 24, optSize = buf.readUInt16LE(pe + 20), count = buf.readUInt16LE(pe + 6);
  need(opt, optSize);
  if (optSize < 152 || buf.readUInt16LE(opt) !== 0x20b || !(buf.readUInt16LE(pe + 22) & 0x2000)) throw new Error('Expected a PE32+ DLL');
  if (!count || count >= 96) throw new Error('Invalid PE section count');
  const headers = buf.readUInt32LE(opt + 60), sectionTable = opt + optSize;
  need(sectionTable, count * 40); need(0, headers);
  const sections = Array.from({ length: count }, (_, i) => {
    const at = sectionTable + i * 40;
    const s = { at, va: buf.readUInt32LE(at + 12), virtualSize: buf.readUInt32LE(at + 8), rawSize: buf.readUInt32LE(at + 16), raw: buf.readUInt32LE(at + 20) };
    if (s.rawSize) need(s.raw, s.rawSize);
    return s;
  });
  const offsetOf = (rva, size = 1) => {
    const section = sections.find(s => rva >= s.va && rva + size <= s.va + s.rawSize);
    if (!section) throw new Error('PE export points outside file-backed sections');
    const offset = section.raw + rva - section.va; need(offset, size); return offset;
  };
  const stringAt = rva => {
    const offset = offsetOf(rva), end = buf.indexOf(0, offset);
    if (end < 0 || end - offset > 4096) throw new Error('Invalid PE export string');
    offsetOf(rva, end - offset + 1);
    const text = buf.toString('latin1', offset, end);
    if (!text || /[^\x21-\x7e]/.test(text)) throw new Error('Invalid PE export name');
    return text;
  };
  const dir = opt + 112, exportRva = buf.readUInt32LE(dir), exportSize = buf.readUInt32LE(dir + 4);
  if (!exportRva || exportSize < 40) throw new Error('Library has no export table');
  const ed = offsetOf(exportRva, 40);
  const base = buf.readUInt32LE(ed + 16), functions = buf.readUInt32LE(ed + 20), names = buf.readUInt32LE(ed + 24);
  if (!functions || functions > 65536 || base + functions > 65536 || names > 65536) throw new Error('Unsupported PE export count or ordinals');
  const funcsAt = offsetOf(buf.readUInt32LE(ed + 28), functions * 4);
  const namesAt = names ? offsetOf(buf.readUInt32LE(ed + 32), names * 4) : 0;
  const ordsAt = names ? offsetOf(buf.readUInt32LE(ed + 36), names * 2) : 0;
  const entries = Array.from({ length: functions }, (_, i) => {
    const rva = buf.readUInt32LE(funcsAt + i * 4);
    const forwarder = rva >= exportRva && rva < exportRva + exportSize ? stringAt(rva) : null;
    // Exported data may live in zero-initialized memory beyond the raw bytes.
    if (rva && !forwarder && !sections.some(s => rva >= s.va && rva < s.va + Math.max(s.virtualSize, s.rawSize))) throw new Error('Export RVA is outside the image');
    return { rva, forwarder, ordinal: base + i, names: [] };
  });
  const byName = new Map();
  for (let i = 0; i < names; i++) {
    const name = stringAt(buf.readUInt32LE(namesAt + i * 4)), index = buf.readUInt16LE(ordsAt + i * 2);
    if (index >= functions || !entries[index].rva || byName.has(name)) throw new Error('Invalid PE name/ordinal mapping');
    entries[index].names.push(name); byName.set(name, entries[index]);
  }
  return { buf, pe, opt, count, sections, sectionTable, headers, dir, base, entries, byName };
}

const align = (n, alignment) => Math.ceil(n / alignment) * alignment;
function adaptProxy(template, genuine) {
  const hash = crypto.createHash('sha256').update(template).update(genuine).digest('hex');
  if (cache.has(hash)) return cache.get(hash);
  const proxy = parsePe(template), game = parsePe(genuine);
  if (game.entries.some(e => e.forwarder?.toLowerCase().startsWith('steam_api64_o.'))) throw new Error('Original library is itself a Librarian proxy');
  const sectionAlignment = template.readUInt32LE(proxy.opt + 32), fileAlignment = template.readUInt32LE(proxy.opt + 36);
  for (const n of [sectionAlignment, fileAlignment]) if (!n || (n & (n - 1))) throw new Error('Invalid PE alignment');
  if (sectionAlignment < 4096 || fileAlignment > sectionAlignment) throw new Error('Unsupported PE alignment');
  const headerAt = proxy.sectionTable + proxy.count * 40;
  const firstRaw = Math.min(...proxy.sections.filter(s => s.rawSize).map(s => s.raw));
  if (headerAt + 40 > Math.min(proxy.headers, firstRaw) || template.subarray(headerAt, headerAt + 40).some(b => b !== 0)) throw new Error('Proxy template has no room for an export section');
  const va = align(Math.max(...proxy.sections.map(s => s.va + Math.max(s.virtualSize, s.rawSize))), sectionAlignment);
  const rawAt = align(template.length, fileAlignment);
  const named = [...game.byName.keys()].sort();
  const eat = 40, namesAt = eat + game.entries.length * 4, ordsAt = namesAt + named.length * 4;
  let size = ordsAt + named.length * 2;
  const strings = [];
  const addString = value => {
    const bytes = Buffer.from(value + '\0', 'ascii'), rva = va + size;
    strings.push({ offset: size, bytes }); size += bytes.length; return rva;
  };
  const dllName = addString('steam_api64.dll');
  const functionRvas = game.entries.map(entry => {
    if (!entry.rva) return 0;
    const implementations = new Set(entry.names.map(name => proxy.byName.get(name)).filter(e => e && !e.forwarder).map(e => e.rva));
    if (implementations.size > 1) throw new Error('Conflicting proxy implementations for an export ordinal');
    return implementations.size ? [...implementations][0] : addString(`steam_api64_o.#${entry.ordinal}`);
  });
  const nameRvas = named.map(addString);
  const rawSize = align(size, fileAlignment);
  if (rawAt + rawSize > 64 * 1024 * 1024 || va + rawSize > 0xffffffff) throw new Error('Adapted proxy exceeds size limit');
  const output = Buffer.alloc(rawAt + rawSize); template.copy(output);
  const body = output.subarray(rawAt);
  body.writeUInt32LE(dllName, 12); body.writeUInt32LE(game.base, 16);
  body.writeUInt32LE(game.entries.length, 20); body.writeUInt32LE(named.length, 24);
  body.writeUInt32LE(va + eat, 28); body.writeUInt32LE(va + namesAt, 32); body.writeUInt32LE(va + ordsAt, 36);
  functionRvas.forEach((rva, i) => body.writeUInt32LE(rva, eat + i * 4));
  named.forEach((name, i) => {
    body.writeUInt32LE(nameRvas[i], namesAt + i * 4);
    body.writeUInt16LE(game.byName.get(name).ordinal - game.base, ordsAt + i * 2);
  });
  for (const part of strings) part.bytes.copy(body, part.offset);
  output.write('.lexport', headerAt, 'ascii');
  output.writeUInt32LE(size, headerAt + 8); output.writeUInt32LE(va, headerAt + 12);
  output.writeUInt32LE(rawSize, headerAt + 16); output.writeUInt32LE(rawAt, headerAt + 20);
  output.writeUInt32LE(0x40000040, headerAt + 36); // initialized read-only data
  output.writeUInt16LE(proxy.count + 1, proxy.pe + 6);
  output.writeUInt32LE(align(va + size, sectionAlignment), proxy.opt + 56);
  output.writeUInt32LE(template.readUInt32LE(proxy.opt + 8) + rawSize, proxy.opt + 8);
  output.writeUInt32LE(0, proxy.opt + 64); // checksum must not describe old bytes
  output.fill(0, proxy.dir + 4 * 8, proxy.dir + 5 * 8); // old Authenticode directory
  output.writeUInt32LE(va, proxy.dir); output.writeUInt32LE(size, proxy.dir + 4);
  const result = parsePe(output);
  for (const [name, entry] of game.byName) {
    if (result.byName.get(name)?.ordinal !== entry.ordinal) throw new Error('Adapted export verification failed');
  }
  if (cache.size >= 32) cache.delete(cache.keys().next().value);
  cache.set(hash, output);
  return output;
}

module.exports = { adaptProxy, parsePe };
