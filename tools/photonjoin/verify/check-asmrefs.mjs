// La table AssemblyRef du binaire livré : la seule mesure objective de
// « générique ».
//
// Un greffon qui référence Assembly-CSharp, PhotonUnityNetworking ou
// Steamworks.NET ne peut pas être chargé dans un autre jeu que celui contre
// lequel il a été compilé — ces assemblées n'y existent pas, ou pas avec les
// mêmes types. Un greffon qui ne référence que le socle .NET, BepInEx et les
// modules Unity se charge partout.
//
//   node tools/photonjoin/verify/check-asmrefs.mjs
//   node tools/photonjoin/verify/check-asmrefs.mjs --control
//
// Le second mode est le témoin positif : il applique la même règle au greffon
// PEAK, qui dépend bel et bien du jeu, et exige qu'elle le refuse. Sans lui,
// « aucune référence interdite » pourrait tout aussi bien vouloir dire « le
// lecteur ne lit rien ».

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const READER = path.join(ROOT, 'tools', 'photonjoin-tests', 'bin', 'Release', 'net9.0', 'PhotonJoinTests.dll');
const SHIPPED = path.join(ROOT, 'deps', 'photonjoin', 'PhotonJoin.dll');
const CONTROL = path.join(ROOT, 'deps', 'librarian', 'PeakJoinFriend.dll');

// Ce qu'un greffon universel a le droit d'exiger : le socle .NET du jeu, le
// chargeur qui l'exécute, et les deux modules Unity présents partout.
const ALLOWED = new Set([
  'mscorlib', 'System', 'System.Core', 'netstandard',
  'BepInEx', '0Harmony',
  'UnityEngine', 'UnityEngine.CoreModule', 'UnityEngine.IMGUIModule',
]);

function fail(message) {
  console.error('ASMREF ÉCHEC : ' + message);
  process.exit(1);
}

function refsOf(dll) {
  if (!existsSync(READER)) fail(`le lecteur de métadonnées manque (${path.relative(ROOT, READER)}). Construire tools/photonjoin-tests d'abord.`);
  if (!existsSync(dll)) fail(`binaire absent : ${path.relative(ROOT, dll)}`);

  let out;
  try {
    out = execFileSync('dotnet', [READER, 'asmrefs', dll], { encoding: 'utf8', timeout: 90_000 });
  } catch (e) {
    fail(`lecture impossible de ${path.basename(dll)} : ${(e.stdout || '') + (e.stderr || e.message)}`);
  }
  if (!out.includes('ASMREFS READ')) fail(`le lecteur n'a pas confirmé sa lecture de ${path.basename(dll)}`);

  const refs = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('REF ')).map((l) => l.slice(4).trim());
  if (refs.length === 0) fail(`aucune référence lue dans ${path.basename(dll)} : lecture suspecte`);
  return refs;
}

const forbidden = (refs) => refs.filter((r) => !ALLOWED.has(r));

const control = process.argv.includes('--control');

if (!control) {
  const refs = refsOf(SHIPPED);
  const bad = forbidden(refs);
  if (bad.length) fail(`le binaire livré dépend d'assemblées qui n'existent pas dans un autre jeu : ${bad.join(', ')}`);

  // Un binaire qui ne référencerait presque rien passerait la règle sans rien
  // prouver : il doit au moins dépendre du chargeur et d'Unity, sans quoi ce
  // n'est pas un greffon.
  for (const needed of ['BepInEx', 'UnityEngine.CoreModule']) {
    if (!refs.includes(needed)) fail(`référence attendue absente : ${needed} — ce binaire n'est pas un greffon Unity`);
  }

  console.log(`Références de PhotonJoin.dll (${refs.length}) : ${refs.join(', ')}`);
  console.log('Aucune assemblée de jeu. ASMREF OK');
  process.exit(0);
}

// --- Témoin positif ---------------------------------------------------------

const refs = refsOf(CONTROL);
const bad = forbidden(refs);
if (bad.length === 0) {
  fail('le greffon PEAK devrait être refusé par cette règle — soit la règle ne mesure rien, soit le témoin a changé');
}

// Et il doit être refusé pour les bonnes raisons, pas par hasard.
for (const expected of ['Assembly-CSharp', 'PhotonUnityNetworking']) {
  if (!bad.includes(expected)) fail(`le témoin devait faire apparaître ${expected} parmi les références interdites, or il n'y est pas`);
}

console.log(`Témoin PeakJoinFriend.dll : ${bad.length} références de jeu détectées — ${bad.join(', ')}`);
console.log('La règle sait refuser. ASMREF CONTROL OK');
