// Refresh deps/steammanifest from a checkout of the steammanifest project.
//
//   node dev/vendor-steammanifest.cjs [E:\Github\steammanifest]
//
// Copies the first-party files the source needs (src/core/steamManifest.js
// requires re/cm_client, fetch-lua, fetch-manifest, re/xyz_client and
// re/manifest_format; the CLIs come along so the folder is a usable copy of
// the project), the two runtime packages with their dependency closure as the
// checkout's package-lock.json resolves it, and writes VERSION.txt with the
// SHA-256 and size of every first-party file. Nothing the checkout's
// .gitignore excludes is copied: no manifests/, no re/output/live, no
// node_modules beyond the closure. steam-user — the account-login path of
// the CLI — is not a runtime dependency of anything Librarian calls and is
// left out, along with the type-only packages the lockfile lists.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = path.resolve(process.argv[2] || process.env.LIBRARIAN_STEAMMANIFEST_DIR || 'E:\\Github\\steammanifest');
const target = path.join(root, 'deps', 'steammanifest');

const FIRST_PARTY = [
  'package.json',
  'package-lock.json',
  'README.md',
  'depot_keys.json',
  'assemble.js',
  'fetch-lua.js',
  'fetch-manifest.js',
  'fetch-xyz.js',
  're/access_trace.js',
  're/cm_client.js',
  're/cm_wire.js',
  're/http.js',
  're/ids.js',
  're/manifest_format.js',
  're/vdf.js',
  're/xyz_client.js',
  're/PROTOCOL.md',
  're/ACCESS_DENIED.md',
];
const RUNTIME_PACKAGES = ['protobufjs', 'websocket13'];
const TYPE_ONLY = /^node_modules\/(@types\/|undici-types$)/;

function closure(lock) {
  const packages = lock.packages || {};
  const resolve = (from, name) => {
    let base = from;
    for (;;) {
      const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
      if (packages[candidate]) return candidate;
      if (!base) return null;
      const at = base.lastIndexOf('/node_modules/');
      base = at === -1 ? '' : base.slice(0, at);
    }
  };
  const seen = new Set();
  const walk = (p) => {
    if (seen.has(p) || TYPE_ONLY.test(p)) return;
    seen.add(p);
    const deps = { ...(packages[p].dependencies || {}), ...(packages[p].optionalDependencies || {}) };
    for (const name of Object.keys(deps)) {
      const r = resolve(p, name);
      if (r) walk(r);
      else if (!packages[p].optionalDependencies?.[name]) throw new Error(`lockfile cannot resolve ${name} from ${p}`);
    }
  };
  for (const name of RUNTIME_PACKAGES) {
    const r = resolve('', name);
    if (!r) throw new Error(`lockfile has no ${name}`);
    walk(r);
  }
  // A nested node_modules is copied with its parent; only top-most paths are copied explicitly.
  return [...seen].filter((p) => ![...seen].some((q) => q !== p && p.startsWith(q + '/node_modules/'))).sort();
}

function copyTree(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, filter: (f) => !/\.(log|tmp)$/i.test(f) });
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

if (!fs.existsSync(path.join(source, 'package-lock.json'))) {
  console.error(`No steammanifest checkout at ${source}`);
  process.exit(1);
}
for (const rel of FIRST_PARTY) {
  if (!fs.existsSync(path.join(source, rel))) { console.error(`Missing in checkout: ${rel}`); process.exit(1); }
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });

for (const rel of FIRST_PARTY) {
  fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
  fs.copyFileSync(path.join(source, rel), path.join(target, rel));
}

const lock = JSON.parse(fs.readFileSync(path.join(source, 'package-lock.json'), 'utf8'));
const packages = closure(lock);
for (const p of packages) copyTree(path.join(source, p), path.join(target, p));
for (const p of packages) {
  // Nested type-only packages ride along with a parent copy; drop them too.
  const nested = path.join(target, p, 'node_modules');
  if (fs.existsSync(nested)) {
    for (const scope of ['@types', 'undici-types']) fs.rmSync(path.join(nested, scope), { recursive: true, force: true });
  }
}
fs.rmSync(path.join(target, 'node_modules', '.package-lock.json'), { force: true });

const lines = [
  'steammanifest',
  `source ${source}${fs.existsSync(path.join(source, '.git')) ? '' : ' (no git repository; working copy)'}`,
  `copied ${new Date().toISOString()} by dev/vendor-steammanifest.cjs`,
  `runtime packages ${RUNTIME_PACKAGES.map((n) => `${n} ${lock.packages[`node_modules/${n}`].version}`).join(', ')}`,
  `closure ${packages.map((p) => `${p.replace(/^node_modules\//, '')}@${lock.packages[p].version}`).join(' ')}`,
];
for (const rel of FIRST_PARTY) {
  const file = path.join(target, rel);
  lines.push(`${rel} sha256 ${sha256(file)} octets ${fs.statSync(file).size}`);
}
fs.writeFileSync(path.join(target, 'VERSION.txt'), lines.join('\n') + '\n');

let bytes = 0;
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else bytes += fs.statSync(f).size; } };
walk(target);
console.log(`vendored ${FIRST_PARTY.length} files and ${packages.length} packages into ${path.relative(root, target)} (${Math.round(bytes / 1024)} KiB)`);
