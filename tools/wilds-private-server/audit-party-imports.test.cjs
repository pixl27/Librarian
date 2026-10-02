'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PeImage, auditBuffers } = require('./audit-party-imports.cjs');

// Synthetic bytes, not an executable sample. One file-backed section plus a
// virtual zero-filled tail makes invalid RVA reads visible to the tests.
function fixture(is64 = true) {
  const buffer = Buffer.alloc(0x1200);
  const pe = 0x80, optional = pe + 24, optionalSize = is64 ? 240 : 224;
  const directories = optional + (is64 ? 112 : 96), sections = optional + optionalSize;
  const imageBase = is64 ? 0x140000000n : 0x400000n;
  buffer.writeUInt16LE(0x5a4d, 0);
  buffer.writeUInt32LE(pe, 0x3c);
  buffer.writeUInt32LE(0x4550, pe);
  buffer.writeUInt16LE(is64 ? 0x8664 : 0x14c, pe + 4);
  buffer.writeUInt16LE(1, pe + 6);
  buffer.writeUInt16LE(optionalSize, pe + 20);
  buffer.writeUInt16LE(is64 ? 0x20b : 0x10b, optional);
  if (is64) buffer.writeBigUInt64LE(imageBase, optional + 24);
  else buffer.writeUInt32LE(Number(imageBase), optional + 28);
  buffer.writeUInt32LE(0x200, optional + 60);
  buffer.writeUInt32LE(16, directories - 4);
  buffer.write('.rdata', sections, 'ascii');
  buffer.writeUInt32LE(0x1800, sections + 8);
  buffer.writeUInt32LE(0x1000, sections + 12);
  buffer.writeUInt32LE(0x1000, sections + 16);
  buffer.writeUInt32LE(0x200, sections + 20);
  const fileOffset = rva => rva - 0x1000 + 0x200;
  const u32 = (rva, value) => buffer.writeUInt32LE(value, fileOffset(rva));
  const u16 = (rva, value) => buffer.writeUInt16LE(value, fileOffset(rva));
  const string = (rva, value) => buffer.write(`${value}\0`, fileOffset(rva), 'ascii');
  const directory = (index, rva, size) => {
    buffer.writeUInt32LE(rva, directories + index * 8);
    buffer.writeUInt32LE(size, directories + index * 8 + 4);
  };
  const thunk = (rva, value) => {
    if (is64) buffer.writeBigUInt64LE(BigInt(value), fileOffset(rva));
    else u32(rva, Number(value));
  };
  return { buffer, pe, optional, directories, sections, imageBase, fileOffset, u32, u16, string, directory, thunk, width: is64 ? 8 : 4, flag: is64 ? 0x8000000000000000n : 0x80000000n };
}

function imports(is64 = true, legacyDelay = false) {
  const f = fixture(is64);
  f.directory(1, 0x1000, 40);
  f.u32(0x1000, 0x1100); f.u32(0x100c, 0x1080); f.u32(0x1010, 0x1100);
  f.string(0x1080, 'PartyWin.dll');
  f.thunk(0x1100, 0x1180); f.thunk(0x1100 + f.width, f.flag | 9n);
  f.string(0x1182, 'PartyInitialize');
  f.directory(13, 0x1200, 64);
  f.u32(0x1200, legacyDelay ? 0 : 1);
  const address = rva => legacyDelay ? Number(f.imageBase) + rva : rva;
  f.u32(0x1204, address(0x1280)); f.u32(0x120c, address(0x1300)); f.u32(0x1210, address(0x1300));
  f.string(0x1280, 'PartyWin.dll');
  f.thunk(0x1300, address(0x1380)); f.thunk(0x1300 + f.width, f.flag | 10n);
  f.string(0x1382, '?CreateNetwork@PartyManager@Party@@QEAAHXZ');
  return f;
}

function exportsFixture(is64 = true) {
  const f = fixture(is64);
  f.directory(0, 0x1400, 0x300);
  f.u32(0x140c, 0x1500); f.string(0x1500, 'PartyWin.dll');
  f.u32(0x1410, 7); f.u32(0x1414, 4); f.u32(0x1418, 3);
  f.u32(0x141c, 0x1480); f.u32(0x1420, 0x14a0); f.u32(0x1424, 0x14c0);
  for (let i = 0; i < 4; i++) f.u32(0x1480 + i * 4, 0x1800 + i * 16);
  const names = ['PartyInitialize', '?CreateNetwork@PartyManager@Party@@QEAAHXZ', 'PartySerializeNetworkDescriptor'];
  for (let i = 0; i < names.length; i++) {
    f.u32(0x14a0 + i * 4, 0x1540 + i * 64); f.u16(0x14c0 + i * 2, i); f.string(0x1540 + i * 64, names[i]);
  }
  return f;
}

for (const is64 of [true, false]) {
  test(`${is64 ? 'PE32+' : 'PE32'} normal/delay named and ordinal imports resolve correctly`, () => {
    const report = auditBuffers(imports(is64).buffer, exportsFixture(is64).buffer);
    assert.deepEqual(report.partyImportCounts, { total: 4, normal: 2, delay: 2, cOrUndecorated: 1, cppDecorated: 1, ordinal: 2, unresolved: 0, loggedByCurrentProbe: 2 });
    assert.deepEqual(report.partyImports.map(entry => entry.resolvedOrdinal), [7, 9, 8, 10]);
    assert.deepEqual(report.partyImports[3].resolvedExportNames, []);
    assert.equal(report.loggedFunctions[0].directlyImported, true);
    assert.equal(report.loggedFunctions[1].directlyImported, true); // Via ordinal 9.
    assert.equal(report.loggedFunctions[2].directlyImported, false);
  });
}

test('PE32 legacy delay descriptors and name thunks use VA addresses', () => {
  const parsed = new PeImage(imports(false, true).buffer).readImports();
  assert.equal(parsed[1].imports[0].name, '?CreateNetwork@PartyManager@Party@@QEAAHXZ');
  assert.equal(parsed[1].imports[1].ordinal, 10);
});

test('file-backed header/section RVAs resolve; zero-fill, unmapped and crossing spans fail', () => {
  const pe = new PeImage(fixture().buffer);
  assert.equal(pe.rvaOffset(0x80, 4), 0x80);
  assert.equal(pe.rvaOffset(0x1000, 16), 0x200);
  assert.equal(pe.rvaOffset(0x1fff), 0x11ff);
  assert.throws(() => pe.rvaOffset(0x2000), /zero-filled/);
  assert.throws(() => pe.rvaOffset(0x1fff, 2), /zero-filled/);
  assert.throws(() => pe.rvaOffset(0x3000), /Unmapped/);
  assert.throws(() => pe.rvaOffset(0x1ff, 2), /header boundary/);
  assert.throws(() => pe.rvaOffset(0xffffffff, 2), /Invalid RVA/);
});

test('missing and unresolved imports are reported without inventing compatibility', () => {
  const exe = imports();
  exe.string(0x1182, 'PartyAbsent');
  const report = auditBuffers(exe.buffer, exportsFixture().buffer);
  assert.equal(report.partyImportCounts.unresolved, 1);
  assert.equal(report.partyImports[0].presentInProvidedDll, false);
  assert.equal(report.partyImports[0].resolvedOrdinal, null);
  assert.equal(auditBuffers(fixture().buffer, exportsFixture().buffer).partyImportCounts.total, 0);
});

test('normal imports use IAT when OriginalFirstThunk is absent', () => {
  const f = imports(); f.u32(0x1000, 0);
  assert.equal(new PeImage(f.buffer).readImports()[0].imports[0].name, 'PartyInitialize');
});

test('forwarded exports are reported as forwarders', () => {
  const f = exportsFixture(); f.u32(0x1480, 0x1600); f.string(0x1600, 'OTHER.PartyInitialize');
  assert.equal(new PeImage(f.buffer).readExports().exports[0].forwarder, 'OTHER.PartyInitialize');
});

test('truncated headers, section bytes and optional directories fail closed', () => {
  const f = fixture();
  for (const length of [0, 63, 0x90, 0x150, f.buffer.length - 1]) assert.throws(() => new PeImage(f.buffer.subarray(0, length)), /Truncated/);
  const count = fixture(); count.buffer.writeUInt32LE(17, count.directories - 4);
  assert.throws(() => new PeImage(count.buffer), /exceed optional/);
  const small = fixture(); small.buffer.writeUInt16LE(1, small.pe + 20);
  assert.throws(() => new PeImage(small.buffer), /Truncated optional/);
});

test('ambiguous or overflowing section mappings fail closed', () => {
  const overlap = fixture(); overlap.buffer.writeUInt16LE(2, overlap.pe + 6);
  overlap.buffer.copy(overlap.buffer, overlap.sections + 40, overlap.sections, overlap.sections + 40);
  assert.throws(() => new PeImage(overlap.buffer), /Overlapping/);
  const overflow = fixture(); overflow.buffer.writeUInt32LE(0xfffff000, overflow.sections + 12);
  assert.throws(() => new PeImage(overflow.buffer), /overflows/);
});

test('unmapped and zero-filled import names are rejected', () => {
  for (const rva of [0x2000, 0x3000]) {
    const f = imports(); f.u32(0x100c, rva);
    assert.throws(() => new PeImage(f.buffer).readImports(), /zero-filled|Unmapped/);
  }
});

test('C strings cannot run into zero-filled data or bytes after the raw section', () => {
  const f = imports(); f.u32(0x100c, 0x1ffe);
  f.buffer.fill(0x41, f.fileOffset(0x1ffe));
  assert.throws(() => new PeImage(f.buffer).readImports(), /Unterminated/);
  const extended = Buffer.concat([f.buffer, Buffer.from([0])]);
  assert.throws(() => new PeImage(extended).readImports(), /Unterminated/);
});

test('import directories and thunk arrays require bounded terminators', () => {
  const normal = imports(); normal.directory(1, 0x1000, 20);
  assert.throws(() => new PeImage(normal.buffer).readImports(), /Unterminated normal/);
  const delay = imports(); delay.directory(13, 0x1200, 32);
  assert.throws(() => new PeImage(delay.buffer).readImports(), /Unterminated delay/);
  const thunk = imports(); thunk.u32(0x1000, 0x1ff8); thunk.thunk(0x1ff8, thunk.flag | 7n);
  assert.throws(() => new PeImage(thunk.buffer).readImports(), /zero-filled/);
});

test('repeated thunk walks share a finite import-entry budget', () => {
  const f = imports();
  const pe = new PeImage(f.buffer), budget = { remaining: 3 };
  assert.equal(pe.readThunks(0x1100, false, budget).length, 2);
  assert.throws(() => pe.readThunks(0x1100, false, budget), /inspection limit/);
});

test('malformed directory pairs, reserved attributes and import bits fail closed', () => {
  const pair = imports(); pair.directory(1, 0, 40);
  assert.throws(() => new PeImage(pair.buffer).readImports(), /Malformed/);
  const attribute = imports(); attribute.u32(0x1200, 2);
  assert.throws(() => new PeImage(attribute.buffer).readImports(), /attributes/);
  const ordinal = imports(); ordinal.thunk(0x1100, ordinal.flag | 0x10007n);
  assert.throws(() => new PeImage(ordinal.buffer).readImports(), /Reserved bits/);
  const name = imports(); name.thunk(0x1100, 0x80000000n);
  assert.throws(() => new PeImage(name.buffer).readImports(), /31-bit/);
  const legacy = imports(); legacy.u32(0x1200, 0);
  assert.throws(() => new PeImage(legacy.buffer).readImports(), /Invalid VA/);
});

test('invalid export counts, ordinal indexes, name pointers and forwarders fail closed', () => {
  const cases = [
    [f => f.u32(0x1414, 1_000_001), /count/],
    [f => f.u16(0x14c0, 4), /ordinal/],
    [f => f.u32(0x14a0, 0x3000), /Unmapped/],
    [f => f.u32(0x1480, 0), /no target/],
    [f => f.u32(0x141c, 0), /Missing export/],
    [f => { f.u32(0x1480, 0x16ff); f.buffer[f.fileOffset(0x16ff)] = 65; }, /Unterminated/],
  ];
  for (const [mutate, expected] of cases) {
    const f = exportsFixture(); mutate(f);
    assert.throws(() => new PeImage(f.buffer).readExports(), expected);
  }
});

test('CLI rejects malformed inputs with exit 1, no success report and no input changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'party-import-audit-'));
  try {
    const exePath = path.join(dir, 'fixture.exe'), partyPath = path.join(dir, 'fixture.dll'), out = path.join(dir, 'audit.json');
    const exe = imports().buffer, party = exportsFixture().buffer;
    fs.writeFileSync(exePath, exe); fs.writeFileSync(partyPath, party);
    const command = path.join(__dirname, 'audit-party-imports.cjs');
    const run = (...args) => spawnSync(process.execPath, [command, '--exe', exePath, '--party', partyPath, ...args], { encoding: 'utf8' });
    const success = run('--out', out);
    assert.equal(success.status, 0, success.stderr);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).partyImportCounts.total, 4);
    const overwrite = run('--out', exePath);
    assert.equal(overwrite.status, 1); assert.equal(overwrite.stdout, '');
    assert.deepEqual(fs.readFileSync(exePath), exe);
    fs.writeFileSync(exePath, exe.subarray(0, 80));
    const badOutput = path.join(dir, 'bad.json');
    const failure = run('--out', badOutput);
    assert.equal(failure.status, 1); assert.equal(failure.stdout, '');
    assert.equal(JSON.parse(failure.stderr).status, 'error');
    assert.equal(fs.existsSync(badOutput), false);
    assert.deepEqual(fs.readFileSync(partyPath), party);
  } finally {
    for (const entry of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, entry));
    fs.rmdirSync(dir);
  }
});
