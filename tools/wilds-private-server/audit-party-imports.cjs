#!/usr/bin/env node
'use strict';

// Offline PE inspection only: no LoadLibrary, subprocesses, networking or binary edits.
// peExports.js intentionally has fewer structural checks; this diagnostic needs
// strict file-backed RVA and string bounds before reporting probe coverage.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LOGGED_FUNCTIONS = Object.freeze([
  'PartyInitialize',
  'PartySerializeNetworkDescriptor',
  'PartyDeserializeNetworkDescriptor',
]);
const MAX_ENTRIES = 100_000;

class PeImage {
  constructor(buffer) {
    if (!Buffer.isBuffer(buffer)) throw new Error('PE input must be a Buffer');
    this.buffer = buffer;
    this.range(0, 64, 'DOS header');
    if (buffer.readUInt16LE(0) !== 0x5a4d) throw new Error('Missing MZ signature');
    const pe = buffer.readUInt32LE(0x3c);
    this.range(pe, 24, 'PE/COFF header');
    if (buffer.readUInt32LE(pe) !== 0x4550) throw new Error('Missing PE signature');
    this.machine = buffer.readUInt16LE(pe + 4);
    const count = buffer.readUInt16LE(pe + 6);
    if (!count || count > 96) throw new Error('Invalid PE section count');
    const optionalSize = buffer.readUInt16LE(pe + 20);
    const optional = pe + 24;
    this.range(optional, optionalSize, 'optional header');
    if (optionalSize < 2) throw new Error('Truncated optional header');
    const magic = buffer.readUInt16LE(optional);
    if (magic !== 0x10b && magic !== 0x20b) throw new Error('Unsupported optional header magic');
    this.is64 = magic === 0x20b;
    const directoryOffset = this.is64 ? 112 : 96;
    if (optionalSize < directoryOffset) throw new Error('Truncated optional header fields');
    this.imageBase = this.is64 ? buffer.readBigUInt64LE(optional + 24) : BigInt(buffer.readUInt32LE(optional + 28));
    this.headerSize = buffer.readUInt32LE(optional + 60);
    const sectionTable = optional + optionalSize;
    this.range(sectionTable, count * 40, 'section table');
    if (this.headerSize < sectionTable + count * 40) throw new Error('SizeOfHeaders excludes the section table');
    this.range(0, this.headerSize, 'SizeOfHeaders');
    const directoryCount = buffer.readUInt32LE(optional + directoryOffset - 4);
    if (directoryCount > Math.floor((optionalSize - directoryOffset) / 8)) throw new Error('Data directories exceed optional header');
    this.directories = [];
    for (let i = 0; i < directoryCount; i++) {
      const position = optional + directoryOffset + i * 8;
      this.directories.push({ rva: buffer.readUInt32LE(position), size: buffer.readUInt32LE(position + 4) });
    }
    this.sections = [];
    for (let i = 0; i < count; i++) {
      const position = sectionTable + i * 40;
      const virtualSize = buffer.readUInt32LE(position + 8);
      const rva = buffer.readUInt32LE(position + 12);
      const rawSize = buffer.readUInt32LE(position + 16);
      const raw = buffer.readUInt32LE(position + 20);
      const size = Math.max(virtualSize, rawSize);
      if (rva + size > 0x1_0000_0000) throw new Error('Section RVA range overflows');
      if (rawSize) {
        if (raw < this.headerSize) throw new Error('Section raw data overlaps headers');
        this.range(raw, rawSize, 'section raw data');
      }
      if (size && rva < this.headerSize) throw new Error('Section virtual range overlaps headers');
      const section = { rva, size, raw, rawSize };
      for (const previous of this.sections) {
        if (size && previous.size && rva < previous.rva + previous.size && previous.rva < rva + size) {
          throw new Error('Overlapping section RVA ranges');
        }
      }
      this.sections.push(section);
    }
  }

  range(offset, length, label) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > this.buffer.length - length) {
      throw new Error(`Truncated or invalid ${label}`);
    }
    return offset;
  }

  rvaSpan(rva, length = 1) {
    if (!Number.isInteger(rva) || rva < 0 || rva > 0xffffffff || !Number.isInteger(length) || length < 1 || rva + length > 0x1_0000_0000) {
      throw new Error('Invalid RVA range');
    }
    if (rva < this.headerSize) {
      if (rva + length > this.headerSize) throw new Error('RVA crosses header boundary');
      return { offset: this.range(rva, length, 'header RVA'), available: this.headerSize - rva };
    }
    const section = this.sections.find(s => rva >= s.rva && rva < s.rva + s.size);
    if (!section) throw new Error(`Unmapped RVA 0x${rva.toString(16)}`);
    const delta = rva - section.rva;
    if (delta + length > section.rawSize) throw new Error('RVA enters zero-filled or unmapped section data');
    return { offset: this.range(section.raw + delta, length, 'section RVA'), available: section.rawSize - delta };
  }

  rvaOffset(rva, length = 1) { return this.rvaSpan(rva, length).offset; }

  string(rva, limit = 4096) {
    const span = this.rvaSpan(rva);
    const maximum = Math.min(span.available, limit);
    const relativeEnd = this.buffer.subarray(span.offset, span.offset + maximum).indexOf(0);
    if (relativeEnd < 0) throw new Error('Unterminated or oversized PE name');
    const end = span.offset + relativeEnd;
    const value = this.buffer.toString('latin1', span.offset, end);
    if (!value || /[^\x20-\x7e]/.test(value)) throw new Error('Invalid PE name');
    return value;
  }

  directory(index, minimum) {
    const directory = this.directories[index] || { rva: 0, size: 0 };
    if (!directory.rva && !directory.size) return null;
    if (!directory.rva || directory.size < minimum) throw new Error(`Malformed data directory ${index}`);
    this.rvaOffset(directory.rva, directory.size);
    return directory;
  }

  readThunks(rva, vaBased = false, budget = { remaining: MAX_ENTRIES }) {
    if (!rva) throw new Error('Missing import name table');
    const width = this.is64 ? 8 : 4;
    const ordinalFlag = this.is64 ? 0x8000000000000000n : 0x80000000n;
    const imports = [];
    for (let i = 0; i < MAX_ENTRIES; i++) {
      const offset = this.rvaOffset(rva + i * width, width);
      const value = this.is64 ? this.buffer.readBigUInt64LE(offset) : BigInt(this.buffer.readUInt32LE(offset));
      if (!value) return imports;
      if (--budget.remaining < 0) throw new Error('Import tables exceed inspection limit');
      if (value & ordinalFlag) {
        if (value & ~(ordinalFlag | 0xffffn)) throw new Error('Reserved bits set in ordinal import');
        imports.push({ name: null, ordinal: Number(value & 0xffffn) });
      } else {
        const relative = vaBased ? value - this.imageBase : value;
        if (relative < 0n || relative > 0x7fffffffn) throw new Error('Import name RVA outside supported 31-bit range');
        const nameRva = Number(relative);
        this.rvaOffset(nameRva, 3);
        imports.push({ name: this.string(nameRva + 2), ordinal: null });
      }
    }
    throw new Error('Import name table exceeds inspection limit');
  }

  readImports() {
    const modules = [];
    const budget = { remaining: MAX_ENTRIES };
    for (const [index, width, kind] of [[1, 20, 'normal'], [13, 32, 'delay']]) {
      const directory = this.directory(index, width);
      if (!directory) continue;
      let terminated = false;
      for (let i = 0; i < Math.min(MAX_ENTRIES, Math.floor(directory.size / width)); i++) {
        const offset = this.rvaOffset(directory.rva + i * width, width);
        const fields = Array.from({ length: width / 4 }, (_, j) => this.buffer.readUInt32LE(offset + j * 4));
        if (fields.every(value => value === 0)) { terminated = true; break; }
        if (--budget.remaining < 0) throw new Error('Import tables exceed inspection limit');
        let nameRva, thunkRva, vaBased = false;
        if (kind === 'normal') {
          nameRva = fields[3];
          thunkRva = fields[0] || fields[4];
        } else {
          if (fields[0] !== 0 && fields[0] !== 1) throw new Error('Unsupported delay import attributes');
          vaBased = fields[0] === 0;
          const asRva = value => {
            if (!value || fields[0] === 1) return value;
            const relative = BigInt(value) - this.imageBase;
            if (relative < 0n || relative > 0xffffffffn) throw new Error('Invalid VA in delay import descriptor');
            return Number(relative);
          };
          nameRva = asRva(fields[1]);
          thunkRva = asRva(fields[4] || fields[3]);
        }
        if (!nameRva) throw new Error('Missing import module name');
        modules.push({ dll: this.string(nameRva), kind, imports: this.readThunks(thunkRva, vaBased, budget) });
      }
      if (!terminated) throw new Error(`Unterminated ${kind} import directory`);
    }
    return modules;
  }

  readExports() {
    const directory = this.directory(0, 40);
    if (!directory) return { dll: null, exports: [] };
    const offset = this.rvaOffset(directory.rva, 40);
    const read = delta => this.buffer.readUInt32LE(offset + delta);
    const dll = this.string(read(12));
    const base = read(16), count = read(20), nameCount = read(24);
    if (count > MAX_ENTRIES || nameCount > MAX_ENTRIES || base + count > 0x1_0000_0000) throw new Error('Invalid export table count');
    if (!count && nameCount) throw new Error('Export names without functions');
    if (!count) return { dll, exports: [] };
    if (!read(28) || (nameCount && (!read(32) || !read(36)))) throw new Error('Missing export table pointer');
    const functions = this.rvaOffset(read(28), count * 4);
    const names = nameCount ? this.rvaOffset(read(32), nameCount * 4) : 0;
    const ordinals = nameCount ? this.rvaOffset(read(36), nameCount * 2) : 0;
    const namesByIndex = new Map();
    const seenNames = new Set();
    for (let i = 0; i < nameCount; i++) {
      const index = this.buffer.readUInt16LE(ordinals + i * 2);
      if (index >= count) throw new Error('Export name ordinal exceeds function table');
      const name = this.string(this.buffer.readUInt32LE(names + i * 4));
      if (seenNames.has(name)) throw new Error('Duplicate export name');
      seenNames.add(name);
      const list = namesByIndex.get(index) || [];
      list.push(name);
      namesByIndex.set(index, list);
    }
    const exports = [];
    for (let i = 0; i < count; i++) {
      const rva = this.buffer.readUInt32LE(functions + i * 4);
      const entryNames = namesByIndex.get(i) || [];
      if (!rva) {
        if (entryNames.length) throw new Error('Named export has no target');
        continue;
      }
      const forwarded = rva >= directory.rva && rva < directory.rva + directory.size;
      const forwarder = forwarded ? this.string(rva, Math.min(4096, directory.rva + directory.size - rva)) : null;
      exports.push({ ordinal: base + i, names: entryNames, forwarder });
    }
    return { dll, exports };
  }
}

function sdkStyle(name) {
  if (!name) return 'ordinal';
  if (name.startsWith('?')) return 'cppDecorated';
  return 'cOrUndecorated';
}

function auditBuffers(exeBuffer, partyBuffer) {
  const exe = new PeImage(exeBuffer), party = new PeImage(partyBuffer);
  const modules = exe.readImports();
  const exportTable = party.readExports();
  if (!exportTable.dll || !/^PartyWin(?:_o)?\.dll$/i.test(exportTable.dll)) throw new Error('Provided Party DLL export identity is not PartyWin.dll');
  const exportsByName = new Map(), exportsByOrdinal = new Map();
  for (const entry of exportTable.exports) {
    exportsByOrdinal.set(entry.ordinal, entry);
    for (const name of entry.names) exportsByName.set(name, entry);
  }
  const partyModules = modules.filter(module => /^PartyWin(?:_o)?\.dll$/i.test(module.dll));
  const imports = partyModules.flatMap(module => module.imports.map(entry => {
    const matched = entry.name ? exportsByName.get(entry.name) : exportsByOrdinal.get(entry.ordinal);
    return {
      dll: module.dll, table: module.kind, ...entry, style: sdkStyle(entry.name),
      presentInProvidedDll: Boolean(matched),
      resolvedExportNames: matched ? matched.names : [],
      resolvedOrdinal: matched ? matched.ordinal : null,
      forwarder: matched ? matched.forwarder : null,
      loggedByCurrentProbe: Boolean(matched && matched.names.some(name => LOGGED_FUNCTIONS.includes(name))),
    };
  }));
  const counts = { total: imports.length, normal: 0, delay: 0, cOrUndecorated: 0, cppDecorated: 0, ordinal: 0, unresolved: 0, loggedByCurrentProbe: 0 };
  for (const entry of imports) {
    counts[entry.table]++; counts[entry.style]++;
    if (!entry.presentInProvidedDll) counts.unresolved++;
    if (entry.loggedByCurrentProbe) counts.loggedByCurrentProbe++;
  }
  const importedNames = new Set(imports.flatMap(entry => entry.resolvedExportNames));
  return {
    schemaVersion: 1, status: 'parsed',
    executable: { format: exe.is64 ? 'PE32+' : 'PE32', machine: exe.machine, importedModuleCount: modules.length },
    partyDll: { format: party.is64 ? 'PE32+' : 'PE32', machine: party.machine, exportDllName: exportTable.dll, namedExportCount: exportsByName.size, exportOrdinalCount: exportsByOrdinal.size },
    partyImportCounts: counts,
    loggedFunctions: LOGGED_FUNCTIONS.map(name => ({ name, exportedByProvidedDll: exportsByName.has(name), directlyImported: importedNames.has(name) })),
    partyImports: imports,
    limitations: [
      'Static imports show declared entry points only; dynamic GetProcAddress calls and imports of other DLLs are not inspected.',
      'C++ wrapper internals may call logged C functions; static import coverage does not prove runtime logging coverage.',
      'DLL identity and file hashes do not authenticate vendor provenance or prove runtime multiplayer compatibility.',
    ],
  };
}

function readInput(file, label) {
  if (!file || !path.isAbsolute(file)) throw new Error(`${label} requires an absolute path`);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024 * 1024) throw new Error(`${label} must be a regular file of at most 1 GiB`);
  const buffer = fs.readFileSync(file);
  return { buffer, metadata: { path: fs.realpathSync(file), bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') } };
}

function main(args) {
  let output;
  try {
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--exe', '--party', '--out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(options, args[i])) {
        throw new Error('Usage: node audit-party-imports.cjs --exe <absolute EXE> --party <absolute genuine DLL> [--out <JSON path>]');
      }
      options[args[i]] = args[i + 1];
    }
    const exe = readInput(options['--exe'], '--exe');
    const party = readInput(options['--party'], '--party');
    const report = auditBuffers(exe.buffer, party.buffer);
    Object.assign(report.executable, exe.metadata);
    Object.assign(report.partyDll, party.metadata);
    output = `${JSON.stringify(report, null, 2)}\n`;
    if (options['--out']) {
      // Never overwrite an input, an existing report, or a file behind a symlink.
      fs.writeFileSync(path.resolve(options['--out']), output, { flag: 'wx' });
    }
    process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ schemaVersion: 1, status: 'error', error: error.message })}\n`);
    process.exitCode = 1;
  }
}

module.exports = { PeImage, auditBuffers, LOGGED_FUNCTIONS };
if (require.main === module) main(process.argv.slice(2));
