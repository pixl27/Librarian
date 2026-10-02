/**
 * Print the exact C signature of every PartyWin function the game imports,
 * straight from the vendored Party_c.h, so the shim is written against the
 * header and not against memory.
 *
 * Usage: node extract-signatures.js [party-imports.json]
 */
const fs = require('fs');
const path = require('path');

const header = fs.readFileSync(path.join(__dirname, 'vendor', 'Party_c.h'), 'utf8').replace(/\r/g, '');
const importsPath = process.argv[2] || path.join(__dirname, '..', '..', 'audits', '2026-09-28', 'party-imports.json');
const names = JSON.parse(fs.readFileSync(importsPath, 'utf8')).partyImports.map(i => i.name);

for (const name of names) {
  const at = header.indexOf(`\nPARTY_API\n${name}(`);
  if (at < 0) { console.log(`!! ${name}`); continue; }
  const retStart = header.lastIndexOf('PARTY_API_ATTRIBUTES\n', at);
  const ret = header.slice(retStart + 'PARTY_API_ATTRIBUTES\n'.length, at).trim();
  const end = header.indexOf(');', at);
  const args = header.slice(at + `\nPARTY_API\n${name}(`.length, end).replace(/\s+/g, ' ').trim();
  console.log(`${ret} ${name}(${args})`);
}
