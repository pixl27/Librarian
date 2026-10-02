// La reconnaissance des jeux, éprouvée sur les jeux réellement installés.
//
// L'enjeu n'est pas de trouver PEAK : c'est de ne pas proposer le moteur là où
// il ne servirait à rien, et de le proposer sans qu'aucune liste d'AppID ait eu
// à prévoir le titre. Les témoins négatifs comptent donc autant que le positif,
// et deux d'entre eux sont des jeux Unity — s'ils passaient, la détection ne
// mesurerait que « Unity », pas « Photon ».
//
//   node tools/photonjoin/verify/check-detect.mjs
//   node tools/photonjoin/verify/check-detect.mjs --no-appid-table

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require_ = createRequire(import.meta.url);
const photonMod = require_(path.join(ROOT, 'src', 'core', 'photonMod.js'));

const STEAM = 'e:\\games\\steam\\steamapps\\common';

// Ce que chaque jeu installé doit produire. Les deux Unity sans Photon sont le
// cœur du contrôle : ce sont eux qui distinguent « détecte Unity » de
// « détecte Photon ».
const CASES = [
  { name: 'PEAK', unity: true, photon: true, role: 'témoin positif' },
  { name: 'Hollow_Knight_Silksong', unity: true, photon: false, role: 'Unity sans Photon' },
  { name: 'ULTRAKILL', unity: true, photon: false, role: 'Unity sans Photon' },
  { name: 'BlackMythWukong', unity: false, photon: false, role: 'jeu non Unity' },
];

function fail(message) {
  console.error('DETECT ÉCHEC : ' + message);
  process.exit(1);
}

const noTable = process.argv.includes('--no-appid-table');
const available = CASES.filter((c) => existsSync(path.join(STEAM, c.name)));

if (!noTable) {
  if (available.length < 3) fail(`seulement ${available.length} jeux de référence installés : le contrôle ne prouverait rien`);
  if (!available.some((c) => c.photon)) fail('aucun témoin positif installé');
  if (!available.some((c) => c.unity && !c.photon)) fail('aucun témoin Unity-sans-Photon installé : la détection ne serait pas distinguée d’un simple test Unity');

  for (const c of available) {
    const dir = path.join(STEAM, c.name);
    const got = photonMod.detect(dir);
    if (got.unity !== c.unity) fail(`${c.name} (${c.role}) : Unity attendu ${c.unity}, obtenu ${got.unity} — ${got.evidence}`);
    if (got.photon !== c.photon) fail(`${c.name} (${c.role}) : Photon attendu ${c.photon}, obtenu ${got.photon} — ${got.evidence}`);

    const st = photonMod.status({ install_path: dir, appid: '0' });
    if (!st.ok) fail(`${c.name} : statut illisible — ${st.error}`);
    if (st.applies !== (c.unity && c.photon)) fail(`${c.name} : applies=${st.applies} incohérent avec la détection`);
    console.log(`  ${c.name.padEnd(24)} unity=${got.unity} photon=${got.photon}  ${got.evidence}`);
  }

  // Un dossier qui n'existe pas ne doit pas produire un faux positif.
  const nowhere = photonMod.detect(path.join(STEAM, 'NExistePas_' + Date.now()));
  if (nowhere.unity || nowhere.photon) fail('un dossier absent est reconnu comme un jeu');

  console.log(`${available.length} jeux examinés, dont ${available.filter((c) => c.photon).length} avec Photon.`);
  console.log('DETECT OK');
  process.exit(0);
}

// --- La reconnaissance ne consulte aucune table d'AppID ----------------------

const peak = available.find((c) => c.name === 'PEAK');
const unityOnly = available.find((c) => c.unity && !c.photon);
if (!peak || !unityOnly) fail('les deux jeux nécessaires à ce contrôle ne sont pas tous installés');

// Le même dossier, sous trois identités d'application différentes : si le
// verdict changeait, c'est que l'AppID pèserait sur la détection.
const dir = path.join(STEAM, peak.name);
for (const appid of ['3527290', '480', '', '999999999']) {
  const st = photonMod.status({ install_path: dir, appid });
  if (!st.applies) fail(`PEAK sous AppID « ${appid} » n’est plus reconnu : la détection dépend de l’AppID`);
}

// Et l'inverse : donner à un jeu sans Photon l'AppID de PEAK ne doit pas le
// faire passer pour un jeu Photon.
const st = photonMod.status({ install_path: path.join(STEAM, unityOnly.name), appid: '3527290' });
if (st.applies) fail(`${unityOnly.name} déguisé en PEAK est reconnu : la détection suit l’AppID, pas le contenu`);

// L'AppID sert tout de même à une chose, et à une seule : savoir qu'un greffon
// dédié, déjà éprouvé, existe pour ce titre.
if (!photonMod.status({ install_path: dir, appid: '3527290' }).preferDedicated)
  fail('le greffon dédié n’est plus recommandé sur PEAK');
if (photonMod.status({ install_path: dir, appid: '480' }).preferDedicated)
  fail('le greffon dédié est recommandé hors de son titre');

// Le code lui-même : une seule constante d'AppID, celle du greffon dédié.
const source = readFileSync(path.join(ROOT, 'src', 'core', 'photonMod.js'), 'utf8');
const digits = source.match(/['"`]\d{5,8}['"`]/g) || [];
if (digits.length) fail('des identifiants d’application sont écrits en dur : ' + digits.join(', '));

console.log('Verdict inchangé sous quatre AppID différents ; un jeu sans Photon déguisé en PEAK reste refusé.');
console.log('DETECT GENERIC OK');
