// Le panneau du volet : présent, habillé, rendu.
//
// Un panneau sans règle de style s'affiche nu au milieu de ses voisins, et
// personne ne le remarque avant de l'avoir sous les yeux. Un panneau dont la
// fonction de rendu n'est jamais appelée reste caché pour toujours. Les deux
// fautes sont invisibles à la relecture et évidentes à la mesure.
//
//   node tools/photonjoin/verify/check-ui.mjs
//   node tools/photonjoin/verify/check-ui.mjs --styles
//   node tools/photonjoin/verify/check-ui.mjs --regression

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const mode = process.argv.includes('--styles') ? 'styles'
           : process.argv.includes('--regression') ? 'regression' : 'base';
const MARK = mode === 'styles' ? 'UI STYLES' : mode === 'regression' ? 'UI REGRESSION' : 'UI';

const html = read('src/index.html');
const css = read('src/styles/enhance.css');
const app = read('src/js/app.js');

function fail(message) {
  console.error(`${MARK} ÉCHEC : ${message}`);
  process.exit(1);
}

const IDS = [
  'flyout-photonmod', 'flyout-photonmod-row', 'flyout-photonmod-text',
  'flyout-photonmod-title', 'flyout-photonmod-sub', 'flyout-photonmod-toggle',
  'flyout-photonmod-note',
];

if (mode === 'base') {
  for (const id of IDS) {
    if (!html.includes(`id="${id}"`)) fail(`élément absent du document : #${id}`);
  }

  // Le panneau part caché : sans cela il clignoterait sur les jeux non concernés.
  if (!/id="flyout-photonmod"\s+class="hidden"/.test(html)) fail('le panneau ne part pas caché');

  // L'interrupteur doit être un interrupteur pour les technologies d'assistance.
  const toggle = html.match(/<button id="flyout-photonmod-toggle"[^>]*>/);
  if (!toggle) fail('interrupteur introuvable');
  if (!/role="switch"/.test(toggle[0])) fail('l’interrupteur n’annonce pas son rôle');
  if (!/aria-labelledby="flyout-photonmod-title"/.test(toggle[0])) fail('l’interrupteur n’est pas relié à son intitulé');

  if (!/async function renderPhotonMod\(/.test(app)) fail('renderPhotonMod n’est pas définie');
  if (!/^\s*renderPhotonMod\(game\);/m.test(app)) fail('renderPhotonMod n’est jamais appelée');

  // Elle doit être appelée là où le volet se peuple, à côté de ses voisines.
  const near = app.match(/renderOnlineMode\(game\);[\s\S]{0,200}?renderPhotonMod\(game\);/);
  if (!near) fail('renderPhotonMod n’est pas appelée avec les autres panneaux du volet');

  // Et elle doit se cacher tant que le jeu n'est pas concerné.
  const body = app.slice(app.indexOf('async function renderPhotonMod('));
  if (!/panel\.classList\.add\('hidden'\)/.test(body.slice(0, 900))) fail('le panneau ne se recache pas au rendu');
  if (!/st\.applies/.test(body.slice(0, 1400))) fail('le rendu ne consulte pas la reconnaissance du jeu');

  console.log(`${IDS.length} éléments présents, rendu appelé avec les panneaux voisins.`);
  console.log('UI OK');
  process.exit(0);
}

if (mode === 'styles') {
  // Chaque identifiant du panneau doit être visé par au moins une règle. On
  // découpe les listes de sélecteurs pour ne pas confondre « visé » et
  // « mentionné quelque part dans le fichier ».
  const selectors = [...css.matchAll(/(^|\})([^{}]+)\{/g)].map((m) => m[2]);
  const targeted = new Set();
  for (const list of selectors) {
    for (const part of list.split(',')) {
      const m = part.match(/#([A-Za-z0-9_-]+)/g) || [];
      for (const id of m) targeted.add(id.slice(1));
    }
  }

  const missing = IDS.filter((id) => !targeted.has(id));
  if (missing.length) fail('identifiants sans règle de style : ' + missing.join(', '));

  // Témoin négatif : un identifiant qui n'existe nulle part ne doit surtout pas
  // être trouvé, sinon la mesure ci-dessus serait vraie pour n'importe quoi.
  if (targeted.has('flyout-photonmod-nexistepas')) fail('le relevé des sélecteurs trouve un identifiant inventé');

  // Le panneau doit partager l'habillage de ses voisins : c'est ce qui fait
  // qu'il ne détonne pas dans le volet.
  const shared = selectors.filter((s) => s.includes('#flyout-photonmod') && s.includes('#flyout-online')).length;
  if (shared < 8) fail(`seulement ${shared} règles partagées avec les panneaux voisins : l’habillage divergerait`);

  console.log(`${IDS.length} identifiants habillés, ${shared} règles partagées avec les panneaux voisins.`);
  console.log('UI STYLES OK');
  process.exit(0);
}

// --- Régression --------------------------------------------------------------

for (const f of ['src/js/app.js']) {
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); }
  catch (e) { fail(`${f} n’est plus valide : ${(e.stderr || '').toString().split('\n')[0]}`); }
}

// Les panneaux préexistants sont toujours là, dans leur ordre d'origine.
const order = ['flyout-online', 'flyout-peakmod', 'flyout-photonmod', 'flyout-dlc'];
let at = -1;
for (const id of order) {
  const i = html.indexOf(`<div id="${id}"`);
  if (i < 0) fail(`panneau disparu du document : #${id}`);
  if (i < at) fail(`#${id} n’est plus à sa place dans le volet`);
  at = i;
}

for (const fn of ['renderOnlineMode', 'renderPeakMod', 'renderPhotonMod']) {
  if (!new RegExp(`function ${fn}\\(`).test(app)) fail(`fonction de rendu disparue : ${fn}`);
  if (!new RegExp(`^\\s*${fn}\\(game\\);`, 'm').test(app)) fail(`${fn} n’est plus appelée`);
}

// Les règles des panneaux voisins n'ont pas été perdues en étendant les listes.
for (const id of ['flyout-online-toggle', 'flyout-peakmod-toggle', 'flyout-dlc-toggle']) {
  if (!css.includes('#' + id)) fail(`règles perdues pour #${id}`);
}

// Une liste de sélecteurs mal recomposée laisserait des virgules en trop.
if (/,\s*,/.test(css) || /,\s*\{/.test(css)) fail('la feuille de style contient une liste de sélecteurs malformée');

console.log(`${order.length} panneaux dans l’ordre, 3 rendus appelés, habillage voisin intact.`);
console.log('UI REGRESSION OK');
