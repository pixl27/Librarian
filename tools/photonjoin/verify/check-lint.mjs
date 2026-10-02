// Les ledgers eux-mêmes, passés au juge.
//
// Un oracle qui ne peut pas échouer certifie n'importe quoi. Le linter de la
// discipline attrape la part mécanique de ce défaut — une commande à sortie
// fixe, une attente tirée du vocabulaire des échecs, un titre qui décrit une
// activité plutôt qu'un résultat. Le faire tourner sur tout l'arbre, et pas
// seulement sur le ledger racine, évite qu'une branche verte repose sur un
// enfant complaisant.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCOPE = path.join(ROOT, '.unlazy', 'photonjoin');
const GATES = path.join(SCOPE, 'gates');
const LINTER = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'skills', 'unlazy', 'scripts', 'gate-lint.mjs');

function fail(message) {
  console.error('LEDGER LINT ÉCHEC : ' + message);
  process.exit(1);
}

if (!existsSync(LINTER)) fail('linter introuvable : ' + LINTER);
if (!existsSync(GATES)) fail('aucun ledger : ' + GATES);

const ledgers = [path.join(SCOPE, 'GATES.md'), ...readdirSync(GATES).filter((f) => f.endsWith('.md')).map((f) => path.join(GATES, f))];
if (ledgers.length < 10) fail(`seulement ${ledgers.length} ledgers trouvés : l’arbre est incomplet`);

let warnings = 0;
for (const l of ledgers) {
  let out;
  try {
    out = execFileSync(process.execPath, [LINTER, l], { encoding: 'utf8', timeout: 60_000 });
  } catch (e) {
    fail(`${path.basename(l)} : ${((e.stdout || '') + (e.stderr || e.message)).trim().split('\n').slice(0, 4).join(' / ')}`);
  }
  if (!out.includes('LINT OK')) fail(`${path.basename(l)} n’est pas accepté : ${out.trim().split('\n').slice(-3).join(' / ')}`);
  const m = out.match(/LINT OK \((\d+) warning/);
  if (m) warnings += Number(m[1]);
}

// Témoin positif : le linter doit refuser un ledger volontairement creux. Sans
// cela, « tous acceptés » ne prouverait que sa complaisance.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'unlazy-lint-'));
const bogus = path.join(tmp, 'GATES.md');
writeFileSync(bogus, [
  '# Gates: essai',
  '',
  '- [ ] G1: verifier les choses',
  '  CHECK: echo verification passed',
  '  EXPECT: verification passed',
  '  EVIDENCE: pending',
  '',
].join('\n'), 'utf8');

let refused = false;
try {
  const out = execFileSync(process.execPath, [LINTER, '--strict', bogus], { encoding: 'utf8', timeout: 60_000 });
  refused = !out.includes('LINT OK');
} catch {
  refused = true;   // sortie non nulle : le linter a bien trouvé à redire
}
rmSync(tmp, { recursive: true, force: true });
if (!refused) fail('le linter accepte un oracle à sortie fixe : il ne mesure rien');

console.log(`${ledgers.length} ledgers acceptés, ${warnings} avertissement(s) ; un ledger creux est bien refusé.`);
console.log('LEDGER LINT OK');
