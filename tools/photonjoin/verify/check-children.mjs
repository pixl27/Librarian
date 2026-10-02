// Réexécuter les ledgers d'un nœud : la vérification par le parent.
//
// Un enfant qui coche ses propres cases se certifie lui-même. Ce script fait
// repasser ses oracles pour de vrai — `--reverify`, pas `--status` — de sorte
// qu'un nœud ne puisse pas hériter d'une preuve périmée.
//
//   node tools/photonjoin/verify/check-children.mjs node-1.1

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_PATH } from './env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GATES = path.join(ROOT, '.unlazy', 'photonjoin', 'gates');
const CHECKER = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'skills', 'unlazy', 'scripts', 'gate-check.mjs');

/** Le delai commun a tout l'arbre. Voir le commentaire pres de l'appel imbrique. */
const TIMEOUT = 900;

/**
 * L'environnement du processus imbrique, avec une seule variable de chemin.
 *
 * Windows compare les noms de variables sans egard a la casse, mais un objet
 * JavaScript non : recopier process.env puis y ajouter PATH laisse deux cles
 * concurrentes, Path et PATH, dont une seule survivra au lancement — et rien
 * ne dit laquelle. L'approbation liant la PATH heritee, cette indetermination
 * suffisait a la rendre invalide une fois sur deux.
 */
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== 'path') env[k] = v;
  env.PATH = CANONICAL_PATH;
  return env;
}

const TREE = {
  'node-1.1.1': ['leaf-1.1.1.1', 'leaf-1.1.1.2'],
  'node-1.1.2': ['leaf-1.1.2.1', 'leaf-1.1.2.2', 'leaf-1.1.2.3', 'leaf-1.1.2.4'],
  'node-1.1.3': ['leaf-1.1.3.1', 'leaf-1.1.3.2'],
  'node-1.1': ['node-1.1.1', 'node-1.1.2', 'node-1.1.3'],
  'node-1.2.1': ['leaf-1.2.1.1', 'leaf-1.2.1.2'],
  'node-1.2.2': ['leaf-1.2.2.1', 'leaf-1.2.2.2'],
  'node-1.2': ['node-1.2.1', 'node-1.2.2'],
  'node-1': ['node-1.1', 'node-1.2'],
};

function fail(message) {
  console.error('CHILDREN ÉCHEC : ' + message);
  process.exit(1);
}

const node = process.argv[2];
if (!node) fail('usage : check-children.mjs <node-x.y>');
const children = TREE[node];
if (!children) fail(`nœud inconnu : ${node} — connus : ${Object.keys(TREE).join(', ')}`);
if (!existsSync(CHECKER)) fail('vérificateur unlazy introuvable : ' + CHECKER);

const ledgers = children.map((c) => path.join(GATES, c + '.md'));
for (const l of ledgers) if (!existsSync(l)) fail('ledger manquant : ' + path.relative(ROOT, l));

let out;
let code = 0;
try {
  // Le délai fait partie de l'identité d'une approbation : une exécution
  // imbriquée qui n'annoncerait pas le même délai que l'exécution directe
  // n'aurait pas d'approbation valide et refuserait de lancer quoi que ce soit.
  // Tout l'arbre est donc conduit avec le même délai, ici comme en surface.
  // La PATH fait aussi partie de l'identite d'une approbation, et celle de cette
  // session change a chaque appel. On impose donc la meme PATH canonique ici et
  // en surface, sans quoi l'execution imbriquee n'aurait jamais d'approbation.
  out = execFileSync('node', [CHECKER, '--root', ROOT, '--cwd', ROOT, '--timeout', String(TIMEOUT), '--reverify', ...ledgers],
                     { encoding: 'utf8', timeout: (TIMEOUT + 120) * 1000, cwd: ROOT, env: childEnv() });
} catch (e) {
  out = (e.stdout || '') + (e.stderr || '');
  code = typeof e.status === 'number' ? e.status : 1;
}

const tail = out.split('\n').filter((l) => l.trim()).slice(-14).join('\n');

if (out.includes('HANDOFF REQUIRED')) fail(`un enfant de ${node} porte une remise :\n${tail}`);
if (code !== 0) fail(`la réexécution des enfants de ${node} n'aboutit pas (code ${code}) :\n${tail}`);
if (!out.includes('ALL MET')) fail(`la réexécution ne conclut pas à « ALL MET » :\n${tail}`);

console.log(`${node} : ${children.length} enfant(s) réexécutés — ${children.join(', ')}`);
console.log('CHILDREN OK');
