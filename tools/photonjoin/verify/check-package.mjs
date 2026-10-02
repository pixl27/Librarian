// Ce que l'application construite contient réellement.
//
// Tout le reste peut être vrai — le moteur compilé, le module écrit, le panneau
// habillé — et l'application livrée peut malgré tout ne rien embarquer de tout
// cela. C'est le seul contrôle qui regarde le paquet plutôt que l'arbre source.
//
//   node tools/photonjoin/verify/check-package.mjs --deps
//   node tools/photonjoin/verify/check-package.mjs
//   node tools/photonjoin/verify/check-package.mjs --full

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEPS = path.join(ROOT, 'deps', 'photonjoin');
const BUILT = path.join(ROOT, 'tools', 'photonjoin', 'bin', 'Release', 'PhotonJoin.dll');
/**
 * Le dossier de construction à examiner.
 *
 * `dist` d'ordinaire. Mais electron-builder vide win-unpacked avant de le
 * remplir, et un jeu lancé par Librarian garde l'overlay de succès chargé
 * depuis ce dossier : la construction échoue alors à mi-chemin et laisse un
 * `dist` mutilé. Construire ailleurs est la seule sortie qui n'exige pas de
 * tuer le jeu de quelqu'un, donc on accepte de trouver le paquet dans un
 * `dist-*` frère, et on dit lequel on a lu.
 */
function buildDir() {
  const candidates = ['dist', ...readdirSync(ROOT).filter((d) => /^dist[-.]/.test(d))];
  const complete = candidates.filter((d) => existsSync(path.join(ROOT, d, 'win-unpacked', 'resources', 'app.asar')));
  if (complete.length === 0) return path.join(ROOT, 'dist');
  complete.sort((a, b) =>
    statSync(path.join(ROOT, b, 'win-unpacked', 'resources', 'app.asar')).mtimeMs -
    statSync(path.join(ROOT, a, 'win-unpacked', 'resources', 'app.asar')).mtimeMs);
  return path.join(ROOT, complete[0]);
}

const DIST = buildDir();
const UNPACKED = path.join(DIST, 'win-unpacked');
const RES = path.join(UNPACKED, 'resources');

/** La source modifiée le plus récemment, parmi tout ce que le paquet embarque. */
function newestSource() {
  let newest = { path: '', at: 0 };
  const visit = (p) => {
    let s;
    try { s = statSync(p); } catch { return; }
    if (s.isDirectory()) {
      if (/[\\/](node_modules|dist|dist-new|bin|obj|\.git)$/.test(p)) return;
      for (const e of readdirSync(p)) visit(path.join(p, e));
      return;
    }
    if (s.mtimeMs > newest.at) newest = { path: p, at: s.mtimeMs };
  };
  for (const rel of ['main.js', 'preload.js', 'package.json', 'src', path.join('deps', 'photonjoin')]) {
    visit(path.join(ROOT, rel));
  }
  return newest;
}

const mode = process.argv.includes('--deps') ? 'deps'
           : process.argv.includes('--full') ? 'full' : 'base';
const MARK = mode === 'deps' ? 'DEPS' : mode === 'full' ? 'PACKAGE FULL' : 'PACKAGE';

function fail(message) {
  console.error(`${MARK} ÉCHEC : ${message}`);
  process.exit(1);
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// --- deps/ : ce que Librarian emporte avec lui ------------------------------

if (mode === 'deps') {
  if (!existsSync(DEPS)) fail('deps/photonjoin est absent — lancer build-plugin.mjs');
  const dll = path.join(DEPS, 'PhotonJoin.dll');
  if (!existsSync(dll)) fail('le moteur est absent de deps/');
  if (!existsSync(BUILT)) fail('aucun binaire compilé à comparer');
  if (sha(dll) !== sha(BUILT)) fail('le moteur de deps/ diffère de celui qui vient d’être compilé');

  const profiles = path.join(DEPS, 'profiles');
  if (!existsSync(profiles)) fail('aucun profil dans deps/photonjoin');
  const files = readdirSync(profiles).filter((f) => f.endsWith('.json'));
  if (files.length === 0) fail('dossier de profils vide : un jeu inconnu n’aurait rien à lire');
  for (const f of files) JSON.parse(readFileSync(path.join(profiles, f), 'utf8'));

  // Le chargeur voyage aussi : sans lui, poser le moteur exigerait un
  // téléchargement, ce qui est précisément ce qu'on veut éviter.
  const loader = path.join(ROOT, 'deps', 'bepinex');
  for (const f of ['winhttp.dll', 'doorstop_config.ini', path.join('BepInEx', 'core', 'BepInEx.dll')]) {
    if (!existsSync(path.join(loader, f))) fail('BepInEx incomplet dans deps/ : ' + f);
  }

  console.log(`deps/photonjoin : moteur ${statSync(dll).size} o identique au binaire compilé, ${files.length} profil(s), BepInEx complet.`);
  console.log('DEPS OK');
  process.exit(0);
}

// --- Le paquet construit -----------------------------------------------------

if (!existsSync(UNPACKED)) fail(`${path.basename(DIST)}/win-unpacked est absent — lancer « npm run dist »`);

const asarPath = path.join(RES, 'app.asar');
if (!existsSync(asarPath)) fail('app.asar est absent du paquet');
const asar = readFileSync(asarPath);

// Le paquet doit être postérieur à ce qu'il embarque.
//
// Sans cette mesure, le contrôle répondait « OK » sur un paquet vieux d'une
// construction ratée : les marqueurs cherchés y étaient déjà, et rien ne disait
// que les corrections apportées depuis n'y étaient pas. Vérifier la présence
// d'un contenu ne dit jamais qu'il est à jour.
const source = newestSource();
const builtAt = statSync(asarPath).mtimeMs;
if (source.at > builtAt + 2000) {
  fail(`le paquet est plus ancien que les sources : ${path.relative(ROOT, source.path)} `
     + `date du ${new Date(source.at).toLocaleString('fr-FR')}, app.asar du ${new Date(builtAt).toLocaleString('fr-FR')}`);
}

/** Le contenu des fichiers, lui, est stocké tel quel : une recherche d'octets suffit. */
const inAsar = (needle) => asar.includes(needle, 0, 'utf8');

/**
 * Les chemins, en revanche, sont un arbre JSON en tête d'archive : « a/b.js »
 * n'y apparaît jamais d'un seul tenant. Chercher la chaîne complète dans les
 * octets répondrait toujours « absent », et l'assertion inverse — « aucune
 * sortie de compilation » — serait vraie sans rien mesurer. Il faut donc lire
 * l'en-tête pour de bon.
 */
function asarPaths(buf) {
  const size = buf.readUInt32LE(12);
  let header;
  try { header = JSON.parse(buf.subarray(16, 16 + size).toString('utf8')); }
  catch (e) { fail("l'en-tête de app.asar est illisible : " + e.message); }

  const out = [];
  (function walk(node, prefix) {
    for (const [name, child] of Object.entries(node.files || {})) {
      const p = prefix ? prefix + '/' + name : name;
      if (child.files) walk(child, p);
      else out.push(p);
    }
  })(header, '');
  return out;
}

const paths = asarPaths(asar);
if (paths.length < 20) fail(`app.asar ne déclare que ${paths.length} fichiers : lecture suspecte`);

// Le moteur et ses profils, côté ressources.
const shipped = path.join(RES, 'deps', 'photonjoin', 'PhotonJoin.dll');
if (!existsSync(shipped)) fail('le moteur est absent du paquet : ' + path.relative(ROOT, shipped));
if (sha(shipped) !== sha(path.join(DEPS, 'PhotonJoin.dll'))) fail('le moteur du paquet diffère de celui de deps/');

const packedProfiles = path.join(RES, 'deps', 'photonjoin', 'profiles');
if (!existsSync(packedProfiles) || readdirSync(packedProfiles).filter((f) => f.endsWith('.json')).length === 0)
  fail('aucun profil dans le paquet');

// Le chargeur, sans lequel il n'y a rien à télécharger mais rien à charger non plus.
for (const f of ['winhttp.dll', 'doorstop_config.ini']) {
  if (!existsSync(path.join(RES, 'deps', 'bepinex', f))) fail('BepInEx incomplet dans le paquet : ' + f);
}

// Le code qui les sert.
for (const marker of ['photonMod', 'photonmod:status', 'photonmod:set', 'renderPhotonMod', 'flyout-photonmod']) {
  if (!inAsar(marker)) fail(`« ${marker} » est absent de app.asar : le paquet ne sait pas servir le moteur`);
}

// Et ce qui marchait déjà.
for (const marker of ['peakMod', 'peakmod:status', 'renderPeakMod', 'flyout-peakmod']) {
  if (!inAsar(marker)) fail(`« ${marker} » a disparu du paquet : régression sur le greffon éprouvé`);
}
if (!existsSync(path.join(RES, 'deps', 'librarian', 'PeakJoinFriend.dll'))) fail('le greffon éprouvé a disparu du paquet');

if (mode === 'full') {
  // Le paquet ne doit pas emporter les sorties de compilation : elles pèsent
  // plus lourd que tout le reste et ne servent à personne à l'exécution.
  const stray = paths.filter((p) => /^tools\/.*\/(bin|obj)\//.test(p));
  if (stray.length) fail(`le paquet emporte ${stray.length} fichiers de sortie de compilation, par exemple ${stray[0]}`);

  // Le seul fichier de tools/ dont l'exécution a besoin doit, lui, être là.
  if (!paths.includes('tools/peExports.js')) fail('tools/peExports.js manque au paquet, alors que le code le charge');

  // Et il doit être le seul : c'est ce qui garde l'installeur léger.
  const fromTools = paths.filter((p) => p.startsWith('tools/'));
  if (fromTools.length !== 1) fail(`le paquet emporte ${fromTools.length} fichiers de tools/ au lieu du seul qui serve : ${fromTools.slice(0, 5).join(', ')}`);

  const portable = readdirSync(DIST).filter((f) => f.endsWith('.exe'));
  if (portable.length === 0) fail('aucun exécutable portable produit');
  const biggest = portable
    .map((f) => ({ f, size: statSync(path.join(DIST, f)).size }))
    .sort((a, b) => b.size - a.size)[0];
  console.log(`Exécutable : ${biggest.f} — ${biggest.size.toLocaleString('fr-FR')} octets`);
  console.log(`asar : ${asar.length.toLocaleString('fr-FR')} octets`);
  console.log('PACKAGE FULL OK');
  process.exit(0);
}

console.log(`Paquet ${path.basename(DIST)} : moteur ${statSync(shipped).size} o + profils + BepInEx dans resources/deps, et les cinq marqueurs de code dans app.asar.`);
console.log('PACKAGE OK');
