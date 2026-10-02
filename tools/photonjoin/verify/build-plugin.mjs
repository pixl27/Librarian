// Construire le moteur et le poser dans deps/, en vérifiant que le binaire
// livré correspond bien aux sources présentes.
//
// Un greffon périmé dans deps/ est le pire des cas : Librarian l'installerait,
// le jeu le chargerait, et le comportement observé ne correspondrait à aucune
// source lisible. On refuse donc de conclure sans avoir comparé.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROJECT = path.join(ROOT, 'tools', 'photonjoin', 'PhotonJoin.csproj');
const BUILT = path.join(ROOT, 'tools', 'photonjoin', 'bin', 'Release', 'PhotonJoin.dll');
const SRC = path.join(ROOT, 'tools', 'photonjoin', 'src');
const PROFILES = path.join(ROOT, 'tools', 'photonjoin', 'profiles');
const DEST = path.join(ROOT, 'deps', 'photonjoin');

function fail(message) {
  console.error('BUILD ÉCHEC : ' + message);
  process.exit(1);
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (entry.name.endsWith('.cs')) out.push(full);
  }
  return out;
}

// 1. Compiler.
let out;
try {
  out = execFileSync('dotnet', ['build', PROJECT, '-c', 'Release', '--nologo', '-v', 'q'],
                     { encoding: 'utf8', timeout: 300_000, cwd: ROOT });
} catch (e) {
  fail('la compilation a échoué :\n' + ((e.stdout || '') + (e.stderr || e.message)).trim());
}
if (/\berror\b/i.test(out)) fail('la compilation signale des erreurs :\n' + out.trim());
if (!existsSync(BUILT)) fail('aucun binaire produit : ' + path.relative(ROOT, BUILT));

// 2. Le binaire doit être postérieur à chacune de ses sources.
const builtAt = statSync(BUILT).mtimeMs;
const files = sources(SRC);
if (files.length < 8) fail(`seulement ${files.length} fichiers source trouvés : arborescence inattendue`);
const stale = files.filter((f) => statSync(f).mtimeMs > builtAt + 2000);
if (stale.length) fail('sources plus récentes que le binaire : ' + stale.map((f) => path.basename(f)).join(', '));

// 3. Poser le moteur et ses profils dans deps/, puis vérifier l'identité.
//
// Recopier sans regarder daterait de neuf des fichiers identiques, et tout ce
// qui juge la fraîcheur en aval — le contrôle de paquet, l'indicateur « périmé »
// de l'interface — croirait à une nouveauté. On n'écrit donc que ce qui change.
function place(src, dst) {
  if (existsSync(dst) && sha(src) === sha(dst)) return false;
  cpSync(src, dst);
  return true;
}

mkdirSync(path.join(DEST, 'profiles'), { recursive: true });
let placed = 0;
if (place(BUILT, path.join(DEST, 'PhotonJoin.dll'))) placed++;
for (const f of readdirSync(PROFILES).filter((f) => f.endsWith('.json'))) {
  if (place(path.join(PROFILES, f), path.join(DEST, 'profiles', f))) placed++;
}

const shipped = path.join(DEST, 'PhotonJoin.dll');
if (sha(shipped) !== sha(BUILT)) fail('le binaire posé dans deps/ diffère de celui qui vient d’être compilé');

const shippedProfiles = readdirSync(path.join(DEST, 'profiles')).filter((f) => f.endsWith('.json'));
const sourceProfiles = readdirSync(PROFILES).filter((f) => f.endsWith('.json'));
if (shippedProfiles.length !== sourceProfiles.length)
  fail(`profils livrés (${shippedProfiles.length}) et profils source (${sourceProfiles.length}) ne concordent pas`);
for (const f of sourceProfiles) {
  if (sha(path.join(PROFILES, f)) !== sha(path.join(DEST, 'profiles', f))) fail('profil divergent : ' + f);
}

// 4. Une empreinte lisible, pour que deux exécutions se comparent à l'œil.
const digest = sha(shipped).slice(0, 16);
const stamp = `PhotonJoin\nsha256 ${sha(shipped)}\noctets ${statSync(shipped).size}\nsources ${files.length}\nprofils ${sourceProfiles.length}\n`;
const stampPath = path.join(DEST, 'VERSION.txt');
let previous = '';
try { previous = readFileSync(stampPath, 'utf8'); } catch { }
if (previous !== stamp) writeFileSync(stampPath, stamp);

console.log(`PhotonJoin.dll : ${statSync(shipped).size} octets, sha256 ${digest}…`);
console.log(`${files.length} sources compilées, ${sourceProfiles.length} profil(s) livré(s), ${placed} fichier(s) réécrit(s) dans deps/.`);
console.log('PLUGIN BUILD OK');
