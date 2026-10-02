// La séparation qui rend le moteur testable hors jeu.
//
// Tout ce qui vit dans src/ doit être exempt d'Unity, de BepInEx et de Harmony :
// c'est ce qui permet à l'hôte de test .NET 9 de compiler ces mêmes fichiers et
// de les lier contre un Photon fabriqué pour l'occasion. Le jour où un « using
// UnityEngine » se glisse dans src/, l'hôte de test cesse de compiler — mais il
// vaut mieux le dire ici, avec le nom du fichier fautif.
//
// La règle inverse compte tout autant : src/unity/ doit bien contenir la couche
// Unity, sans quoi ce contrôle passerait sur une arborescence vide.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC = path.join(ROOT, 'tools', 'photonjoin', 'src');
const UNITY = path.join(SRC, 'unity');
const TESTPROJ = path.join(ROOT, 'tools', 'photonjoin-tests', 'PhotonJoinTests.csproj');

const FORBIDDEN = ['UnityEngine', 'BepInEx', 'HarmonyLib', 'MonoMod', 'Steamworks.'];

function fail(message) {
  console.error('PURE ÉCHEC : ' + message);
  process.exit(1);
}

if (!existsSync(SRC)) fail('arborescence source absente : ' + path.relative(ROOT, SRC));
if (!existsSync(UNITY)) fail('la couche Unity est absente : ' + path.relative(ROOT, UNITY));

const pure = readdirSync(SRC, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.cs'))
  .map((e) => e.name);
const unity = readdirSync(UNITY).filter((f) => f.endsWith('.cs'));

if (pure.length < 8) fail(`seulement ${pure.length} fichiers purs trouvés : arborescence inattendue`);
if (unity.length === 0) fail('aucun fichier dans src/unity/ : la séparation ne prouverait rien');

/**
 * Ne garder que ce que le compilateur lie réellement.
 *
 * Les commentaires expliquent souvent pourquoi telle dépendance est refusée, et
 * les littéraux de chaîne portent précisément les noms que le moteur cherche par
 * réflexion — « Steamworks.SteamFriends » dans SteamBridge, la liste des espaces
 * de noms que la sonde écarte dans Probe. Ce sont des données, pas des
 * dépendances : les compter comme telles ferait échouer le contrôle sur du code
 * dont la pureté est justement le sujet.
 */
function code(text) {
  return text
    .replace(/@"(?:[^"]|"")*"/g, '""')      // chaînes verbatim
    .replace(/"(?:\\.|[^"\\])*"/g, '""')    // chaînes ordinaires
    .replace(/'(?:\\.|[^'\\])'/g, "' '")    // caractères
    .replace(/\/\*[\s\S]*?\*\//g, ' ')      // commentaires de bloc
    .replace(/\/\/[^\n]*/g, ' ');           // commentaires de ligne
}

const guilty = [];
for (const name of pure) {
  const body = code(readFileSync(path.join(SRC, name), 'utf8'));
  for (const word of FORBIDDEN) {
    if (body.includes(word)) guilty.push(`${name} → ${word}`);
  }
  const uses = body.match(/^\s*using\s+([A-Za-z0-9_.]+)\s*;/gm) || [];
  for (const u of uses) {
    const ns = u.replace(/^\s*using\s+/, '').replace(/\s*;\s*$/, '');
    if (FORBIDDEN.some((w) => ns === w.replace(/\.$/, '') || ns.startsWith(w.replace(/\.$/, '') + '.')))
      guilty.push(`${name} → using ${ns}`);
  }
}
if (guilty.length) fail('dépendances interdites dans la couche pure : ' + guilty.join(', '));

// Le témoin positif : appliqué à la couche Unity, le même détecteur doit
// accuser. S'il ne trouvait rien là où les dépendances sont certaines, c'est
// que le filtrage des chaînes et des commentaires l'aurait rendu aveugle, et
// le verdict sur la couche pure ne vaudrait rien.
const unityBody = unity.map((f) => code(readFileSync(path.join(UNITY, f), 'utf8'))).join('\n');
const caught = FORBIDDEN.filter((w) => unityBody.includes(w));
if (!caught.includes('UnityEngine')) fail('le détecteur ne voit pas UnityEngine dans src/unity/ : il est aveugle');
if (!caught.includes('BepInEx')) fail('le détecteur ne voit pas BepInEx dans src/unity/ : il est aveugle');
if (!/^\s*using\s+UnityEngine\s*;/m.test(unityBody)) fail('src/unity/ ne déclare pas using UnityEngine : la séparation est illusoire');

// Et l'hôte de test doit compiler la couche pure sans balayer les sous-dossiers,
// faute de quoi la couche Unity y entrerait et ne compilerait pas.
const proj = readFileSync(TESTPROJ, 'utf8');
if (!proj.includes('../photonjoin/src/*.cs')) fail("l'hôte de test ne compile plus src/*.cs tel quel");
if (/photonjoin\/src\/\*\*/.test(proj)) fail("l'hôte de test balaie les sous-dossiers : la couche Unity y entrerait");

console.log(`${pure.length} fichiers purs, ${unity.length} fichiers Unity, séparation respectée.`);
console.log('PURE OK');
