// Find the rebe /sign parser in the dumped decrypted code by the RIP-relative
// LEAs that reference the JSON key strings. Clusters of key refs = the parser.
const fs = require('fs');
const G = 'E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/';

// section name -> runtime RVA (from the PE section table)
const RVA = { data: 0x1000, sdata: 0xd16b000, rodata: 0x155ed000, srdata: 0x2028e000 };

function load(name) {
  const p = G + 'librarian_dump_' + name + '.bin';
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}
const code = load('data');                       // executable code lives in .data here
const strSecs = ['sdata', 'rodata', 'srdata', 'data']
  .map(n => ({ name: n, rva: RVA[n], buf: load(n) }))
  .filter(s => s.buf);
if (!code) { console.log('no code dump (librarian_dump_data.bin) found'); process.exit(1); }
console.log('code .data bytes:', code.length.toString(16));
strSecs.forEach(s => console.log('str', s.name, 'rva=0x' + s.rva.toString(16), 'bytes=0x' + s.buf.length.toString(16)));

// read a null-terminated ASCII string at a runtime RVA, from whichever section holds it
function strAt(rva) {
  for (const s of strSecs) {
    if (rva >= s.rva && rva < s.rva + s.buf.length) {
      let o = rva - s.rva, e = o;
      while (e < s.buf.length && e - o < 80) { const c = s.buf[e]; if (c === 0) break; if (c < 0x20 || c > 0x7e) return null; e++; }
      if (e > o) return s.buf.toString('latin1', o, e);
      return null;
    }
  }
  return null;
}

// scan code for LEA r64, [rip+disp32]:  REX.W(0x48..0x4F) 8D modrm(mod=00,rm=101) disp32
const KEYRE = /token|expire|rebe|gcp|nsa|_id$|_at$|server|region|session|player|account|open_id|result|data|body|sub|user|steam|capcom|next|auth|sign|jwt|expires/i;
const refs = [];
const dataRva = RVA.data;
for (let i = 0; i + 7 <= code.length; i++) {
  const rex = code[i];
  if (rex < 0x48 || rex > 0x4f) continue;
  if (code[i + 1] !== 0x8d) continue;
  if ((code[i + 2] & 0xc7) !== 0x05) continue;
  const disp = code.readInt32LE(i + 3);
  const instrRva = dataRva + i;
  const target = (instrRva + 7 + disp) >>> 0;
  const str = strAt(target);
  if (str && str.length >= 3 && /^[\x20-\x7e]+$/.test(str)) {
    refs.push({ rva: instrRva, target, str });
    i += 6;
  }
}
console.log('total LEA->string refs:', refs.length);

// keep only key-ish strings, then cluster by code proximity
const keyRefs = refs.filter(r => KEYRE.test(r.str) && /^[a-z][a-z0-9_]{2,40}$/.test(r.str));
console.log('key-ish refs:', keyRefs.length);

// cluster: refs within 0x400 bytes of code of each other
keyRefs.sort((a, b) => a.rva - b.rva);
const clusters = [];
let cur = null;
for (const r of keyRefs) {
  if (cur && r.rva - cur.end <= 0x600) { cur.refs.push(r); cur.end = r.rva; }
  else { cur = { start: r.rva, end: r.rva, refs: [r] }; clusters.push(cur); }
}
// rank clusters by how many of the known sign keys they touch
const SIGN = ['rebe_token', 'gcp_token', 'next_token', 'nsa_id_token', 'gcp_token_expire'];
clusters.forEach(c => { const set = new Set(c.refs.map(r => r.str)); c.signHits = SIGN.filter(k => set.has(k)).length; c.uniq = set; });
clusters.sort((a, b) => b.signHits - a.signHits || b.refs.length - a.refs.length);

// Per-key reference sites
const WANT = ['rebe_token', 'gcp_token', 'gcp_token_expire', 'next_token', 'nsa_id_token', 'expired_at', 'rebe_sub_str', 'result'];
console.log('\n==== reference sites per sign key ====');
const byKey = Object.create(null);
for (const r of refs) { if (!byKey[r.str]) byKey[r.str] = []; byKey[r.str].push(r.rva); }
for (const k of WANT) {
  const sites = byKey[k] || [];
  console.log(`  ${k.padEnd(18)} ${sites.length} site(s): ${sites.slice(0, 8).map(a => '0x' + a.toString(16)).join(', ')}`);
}

// For each rebe_token / gcp_token site, print ALL string refs within +-0x400 in code order
function context(centerRva) {
  const near = refs.filter(r => Math.abs(r.rva - centerRva) <= 0x400).sort((a, b) => a.rva - b.rva);
  return near.map(r => r.str).join('  ');
}
console.log('\n==== context around each rebe_token / gcp_token site ====');
for (const k of ['rebe_token', 'gcp_token']) {
  for (const site of (byKey[k] || [])) {
    console.log(`\n-- ${k} @0x${site.toString(16)} context (+-0x400) --`);
    console.log('  ' + context(site));
  }
}

// Wide context over the rebe_token function region + the expired_at site
console.log('\n==== WIDE region 0xa759000..0xa760000 (rebe_token/expired_at function) ====');
{
  const near = refs.filter(r => r.rva >= 0xa759000 && r.rva <= 0xa760000).sort((a,b)=>a.rva-b.rva);
  console.log('  ' + near.map(r=>r.str).join('  '));
}
console.log('\n==== rebe_sub_str @0x17cd73e context (+-0x600) ====');
{
  const near = refs.filter(r => Math.abs(r.rva-0x17cd73e)<=0x600).sort((a,b)=>a.rva-b.rva);
  console.log('  ' + near.map(r=>r.str).join('  '));
}
