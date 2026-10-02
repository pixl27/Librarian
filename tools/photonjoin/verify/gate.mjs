// Le seul point d'entrée du vérificateur, pour cet arbre.
//
// L'approbation d'un oracle lie la PATH héritée. Lancer le vérificateur
// directement depuis un interpréteur ne donne donc pas le même environnement
// selon l'interpréteur : Git Bash réécrit la variable qu'on lui passe et y
// ajoute ses propres répertoires, si bien qu'une approbation créée à la main ne
// vaut plus pour l'exécution imbriquée, qui hérite d'un environnement construit
// en JavaScript.
//
// Ce lanceur construit l'environnement exactement comme check-children.mjs le
// fait pour ses enfants. Toutes les exécutions de l'arbre partagent alors la
// même identité d'approbation, quel que soit l'endroit d'où elles partent.
//
//   node tools/photonjoin/verify/gate.mjs --approve --reverify <ledgers…>

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_PATH } from './env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CHECKER = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'skills', 'unlazy', 'scripts', 'gate-check.mjs');

/** Le même environnement que celui des exécutions imbriquées, à la clé près. */
function canonicalEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== 'path') env[k] = v;
  env.PATH = CANONICAL_PATH;
  return env;
}

const args = process.argv.slice(2);
const hasRoot = args.includes('--root');
const hasCwd = args.includes('--cwd');
const hasTimeout = args.includes('--timeout');

const full = [
  CHECKER,
  ...(hasRoot ? [] : ['--root', ROOT]),
  ...(hasCwd ? [] : ['--cwd', ROOT]),
  ...(hasTimeout ? [] : ['--timeout', '900']),
  ...args,
];

const r = spawnSync(process.execPath, full, { stdio: 'inherit', cwd: ROOT, env: canonicalEnv() });
process.exit(r.status === null ? 2 : r.status);
