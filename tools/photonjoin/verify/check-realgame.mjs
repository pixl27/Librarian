// Le moteur, mis face à un vrai PUN2.
//
// Tous les autres contrôles lient le moteur à des assemblées Photon fabriquées
// pour l'occasion. C'est ce qui prouve qu'il ne connaît aucun jeu par cœur,
// mais cela ne prouve pas qu'il reconnaisse le vrai PUN — un faux ressemble
// toujours un peu trop à ce qu'on attendait de lui.
//
// Ce contrôle pose le greffon dans un jeu réellement installé, lance le jeu,
// lit ce que BepInEx a journalisé, puis retire le greffon et laisse le dossier
// tel qu'il l'a trouvé. Il ne joue pas : il vérifie que la liaison aboutit sur
// le Photon du jeu, avec sa version et ses types à lui.
//
//   node tools/photonjoin/verify/check-realgame.mjs [--game <dossier>]
//
// Le jeu de référence est PEAK parce que c'est le seul titre PUN2 installé ici.

import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEPS = path.join(ROOT, 'deps', 'photonjoin');

const argGame = process.argv.indexOf('--game');
const GAME = argGame > 0 ? process.argv[argGame + 1] : 'e:\\games\\steam\\steamapps\\common\\PEAK';
const PLUGINS = path.join(GAME, 'BepInEx', 'plugins');
const MINE = path.join(PLUGINS, 'PhotonJoin');
const LOG = path.join(GAME, 'BepInEx', 'LogOutput.log');
const CFG = path.join(GAME, 'BepInEx', 'config', 'com.librarian.photonjoin.cfg');

const WAIT_MS = 55_000;
const POLL_MS = 1_000;

let exe = '';
let installed = false;
let wroteConfig = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Attendre sans rendre la main : cleanup est appelé depuis fail(), qui sort aussitôt. */
function pause(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { }
}

/**
 * Rendre le jeu tel qu'on l'a trouvé.
 *
 * taskkill rend la main avant que Windows n'ait libéré les fichiers que le
 * processus tenait : une suppression immédiate échoue en silence et laisse le
 * greffon en place, ce qui fait échouer le contrôle suivant sur un dossier
 * « déjà présent » sans rapport avec ce qu'il mesure. On réessaie donc.
 */
function cleanup() {
  if (exe) { try { execFileSync('taskkill', ['/IM', path.basename(exe), '/F'], { stdio: 'ignore' }); } catch { } }

  for (let attempt = 0; attempt < 12; attempt++) {
    let left = false;
    if (installed && existsSync(MINE)) { try { rmSync(MINE, { recursive: true, force: true }); } catch { } left ||= existsSync(MINE); }
    if (wroteConfig && existsSync(CFG)) { try { rmSync(CFG, { force: true }); } catch { } left ||= existsSync(CFG); }
    if (!left) return;
    pause(500);
  }
  console.error(`AVERTISSEMENT : ${MINE} n'a pas pu être retiré — le jeu tient peut-être encore le fichier.`);
}

function fail(message) {
  cleanup();
  console.error('REALGAME ÉCHEC : ' + message);
  process.exit(1);
}

if (!existsSync(GAME)) fail('jeu introuvable : ' + GAME);
if (!existsSync(PLUGINS)) fail('BepInEx n’est pas installé dans ce jeu : ' + PLUGINS);
if (!existsSync(path.join(DEPS, 'PhotonJoin.dll'))) fail('le moteur n’est pas dans deps/ — lancer build-plugin.mjs d’abord');

exe = path.join(GAME, 'PEAK.exe');
if (!existsSync(exe)) {
  const found = readdirSync(GAME).find((f) => f.endsWith('.exe') && !/crash|handler|unins/i.test(f));
  if (!found) fail('aucun exécutable de jeu trouvé dans ' + GAME);
  exe = path.join(GAME, found);
}

// 1. Poser le greffon, sans rien écraser de ce qui est déjà là.
if (existsSync(MINE)) fail('un dossier PhotonJoin existe déjà dans ce jeu : contrôle refusé pour ne rien écraser');
mkdirSync(MINE, { recursive: true });
installed = true;
cpSync(path.join(DEPS, 'PhotonJoin.dll'), path.join(MINE, 'PhotonJoin.dll'));
cpSync(path.join(DEPS, 'profiles'), path.join(MINE, 'profiles'), { recursive: true });

// 1 bis. Demander l'ouverture au demarrage : c'est le seul moyen d'observer la
// fenetre sans appuyer sur une touche, et c'est de toute facon le recours prevu
// pour les jeux ou l'entree clavier heritee est absente.
if (existsSync(CFG)) fail('une configuration PhotonJoin existe deja dans ce jeu : controle refuse pour ne rien ecraser');
mkdirSync(path.dirname(CFG), { recursive: true });
writeFileSync(CFG, ['[général]', '', 'ouvrir au démarrage = true', ''].join('\n'), 'utf8');
wroteConfig = true;

// 2. Lancer, attendre que le greffon se manifeste, arrêter.
const logBefore = existsSync(LOG) ? statSync(LOG).mtimeMs : 0;
try {
  const child = spawn(exe, [], { cwd: GAME, detached: true, stdio: 'ignore' });
  child.unref();
} catch (e) {
  fail('lancement impossible : ' + e.message);
}

const started = Date.now();
let text = '';
while (Date.now() - started < WAIT_MS) {
  await sleep(POLL_MS);
  if (!existsSync(LOG) || statSync(LOG).mtimeMs <= logBefore) continue;
  try { text = readFileSync(LOG, 'utf8'); } catch { continue; }
  if (text.includes('PhotonJoin') && /Fenetre dessinee|NON LIÉ|introuvable/.test(text)) {
    await sleep(1500);   // laisser le reste de l'initialisation s'écrire
    try { text = readFileSync(LOG, 'utf8'); } catch { }
    break;
  }
}

const lines = text.split('\n').filter((l) => l.includes('PhotonJoin'));
cleanup();

// 3. Juger sur ce que le journal dit.
if (lines.length === 0) fail(`le greffon n'a rien journalisé en ${WAIT_MS / 1000} s — journal de ${text.length} octets`);

const joined = lines.join('\n');
const bound = joined.match(/PUN2?\s*([0-9.]*)\s*lié\./);
if (!bound) fail('la liaison à Photon n’a pas abouti dans le vrai jeu :\n' + joined);

const version = bound[1] || '(sans version)';
const profile = joined.match(/Profil\s*:\s*([^\n\r]+)/);
if (!profile) fail('aucun profil n’a été choisi :\n' + joined);
if (!/PEAK/i.test(profile[1])) fail('le profil retenu n’est pas celui du jeu : ' + profile[1].trim());

// Le bouclier doit s'être posé sur une méthode réelle du jeu, pas sur rien.
if (!/Bouclier posé sur/.test(joined)) fail('le bouclier ne s’est pas posé dans le vrai jeu :\n' + joined);

// Et la fenêtre doit avoir été réellement disposée par IMGUI, pas seulement
// construite en mémoire : c'est la seule façon de savoir qu'elle s'affiche.
const drawn = joined.match(/Fenetre dessinee\s*:\s*([^\n\r]+)/);
if (!drawn) fail('la fenêtre n’a jamais été dessinée dans le vrai jeu :\n' + joined);
if (/\[\s*(Error|Fatal)[^\]]*\][^\n]*PhotonJoin/i.test(text)) fail('le greffon a journalisé une erreur :\n' + joined);

console.log(`Jeu : ${path.basename(GAME)} — PUN ${version} lié sur le Photon réel du jeu.`);
for (const l of lines.slice(0, 14)) console.log('  ' + l.replace(/\r/g, '').trim());
console.log('REALGAME OK');
