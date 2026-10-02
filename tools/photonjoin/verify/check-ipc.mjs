// Les canaux entre le rendu et le processus principal.
//
// Un canal exposé sans gestionnaire ne se voit qu'à l'usage : l'appel reste en
// attente et l'interface fige un interrupteur. Un gestionnaire qui appelle une
// fonction absente du module se voit encore plus tard. Ces deux fautes ne sont
// pas rattrapables par la relecture, donc on les mesure.
//
//   node tools/photonjoin/verify/check-ipc.mjs
//   node tools/photonjoin/verify/check-ipc.mjs --regression
//   node tools/photonjoin/verify/check-ipc.mjs --wire

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require_ = createRequire(import.meta.url);

const mode = process.argv.includes('--regression') ? 'regression'
           : process.argv.includes('--wire') ? 'wire' : 'base';
const MARK = mode === 'regression' ? 'IPC REGRESSION' : mode === 'wire' ? 'WIRE' : 'IPC';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const main = read('main.js');
const preload = read('preload.js');

function fail(message) {
  console.error(`${MARK} ÉCHEC : ${message}`);
  process.exit(1);
}

/** Les canaux qu'un fichier enregistre, et ceux qu'il appelle. */
const handled = (src) => [...src.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]);
const invoked = (src) => [...src.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map((m) => m[1]);

if (mode === 'base') {
  const wanted = ['photonmod:status', 'photonmod:set'];
  const has = handled(main);
  for (const c of wanted) if (!has.includes(c)) fail(`canal non enregistré côté principal : ${c}`);

  const exposed = invoked(preload);
  for (const c of wanted) if (!exposed.includes(c)) fail(`canal non exposé au rendu : ${c}`);

  for (const name of ['getPhotonModStatus', 'setPhotonMod']) {
    if (!new RegExp(`\\b${name}\\s*:`).test(preload)) fail(`méthode absente du préchargement : ${name}`);
  }

  // Le rendu ne doit appeler que des méthodes que le préchargement expose.
  const app = read('src/js/app.js');
  for (const call of [...app.matchAll(/api\.(get|set)PhotonMod\w*/g)].map((m) => m[0])) {
    const name = call.slice(4);
    if (!new RegExp(`\\b${name}\\s*:`).test(preload)) fail(`le rendu appelle api.${name}, absent du préchargement`);
  }

  console.log(`Canaux : ${wanted.join(', ')} — enregistrés, exposés, appelés.`);
  console.log('IPC OK');
  process.exit(0);
}

if (mode === 'wire') {
  const photonMod = require_(path.join(ROOT, 'src', 'core', 'photonMod.js'));

  // Chaque appel photonMod.xxx( trouvé dans main.js doit exister à l'exécution.
  const used = new Set([...main.matchAll(/photonMod\.(\w+)\s*\(/g)].map((m) => m[1]));
  if (used.size === 0) fail('main.js n’appelle aucune fonction du module : le câblage serait vide');
  for (const name of used) {
    if (typeof photonMod[name] !== 'function') fail(`main.js appelle photonMod.${name}(), que le module n’exporte pas`);
  }

  // Et chaque canal exposé au rendu doit avoir son gestionnaire.
  const has = new Set(handled(main));
  for (const c of invoked(preload).filter((c) => c.startsWith('photonmod:'))) {
    if (!has.has(c)) fail(`canal exposé sans gestionnaire : ${c}`);
  }

  // Le témoin négatif : un nom qui n'existe pas doit bien être vu comme absent,
  // sinon ce contrôle serait vrai quoi qu'il arrive.
  if (typeof photonMod.fonctionQuiNExistePas === 'function') fail('le module expose une fonction inventée');

  console.log(`Câblage : ${[...used].sort().join(', ')} — toutes exportées ; ${[...has].filter((c) => c.startsWith('photonmod:')).length} canaux servis.`);
  console.log('WIRE OK');
  process.exit(0);
}

// --- Régression --------------------------------------------------------------

const files = ['main.js', 'preload.js', 'src/js/app.js', 'src/core/photonMod.js', 'src/core/peakMod.js', 'src/core/onlineMode.js'];
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); }
  catch (e) { fail(`${f} n’est plus du JavaScript valide : ${(e.stderr || '').toString().split('\n')[0]}`); }
}

// Les canaux qui existaient avant doivent exister encore : c'est tout l'objet
// d'un contrôle de régression sur un fichier partagé.
const preexisting = ['peakmod:status', 'peakmod:set', 'online:status', 'online:set'];
const has = handled(main);
for (const c of preexisting) if (!has.includes(c)) fail(`canal préexistant disparu de main.js : ${c}`);
const exposed = invoked(preload);
for (const c of preexisting) if (!exposed.includes(c)) fail(`canal préexistant disparu du préchargement : ${c}`);

for (const name of ['getPeakModStatus', 'setPeakMod', 'getOnlineStatus', 'setOnlineMode']) {
  if (!new RegExp(`\\b${name}\\s*:`).test(preload)) fail(`méthode préexistante disparue : ${name}`);
}

// Aucun canal ne doit avoir été enregistré deux fois : le second écraserait le
// premier en silence.
const seen = new Map();
for (const c of has) seen.set(c, (seen.get(c) || 0) + 1);
const doubled = [...seen].filter(([, n]) => n > 1).map(([c]) => c);
if (doubled.length) fail('canaux enregistrés deux fois : ' + doubled.join(', '));

console.log(`${files.length} fichiers valides, ${preexisting.length} canaux préexistants intacts, ${has.length} canaux au total, aucun doublon.`);
console.log('IPC REGRESSION OK');
