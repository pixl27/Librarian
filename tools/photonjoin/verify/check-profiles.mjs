// Le schéma des profils, validé une seconde fois.
//
// Le greffon a son propre lecteur, en C#. Celui-ci est écrit indépendamment, en
// JavaScript : deux implémentations qui tombent d'accord sur les mêmes fichiers
// valent mieux qu'une seule qui se juge elle-même. Le mode --negative passe le
// jeu d'épreuves : douze fichiers dont chacun porte un défaut différent, et
// chacun doit être refusé en nommant le champ fautif.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROFILES = path.join(ROOT, 'tools', 'photonjoin', 'profiles');
const FIXTURES = path.join(ROOT, 'tools', 'photonjoin', 'fixtures');

const STRATEGIES = ['keep', 'prefix-host', 'mirror-host', 'custom'];
const ENTRIES = ['raw', 'native', 'rejoin'];
const SOURCES = ['steam', 'manual'];

/** Les mêmes règles que ProfileStore.FromJson, écrites à part. */
function validate(text) {
  const errors = [];
  let root;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return ['json : ' + e.message];
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return ['racine : un objet JSON est attendu'];

  if (root.schema !== 1) errors.push(`schema : ${root.schema} n'est pas la version attendue (1)`);
  if (typeof root.id !== 'string' || !/^[a-z0-9._-]+$/.test(root.id)) errors.push('id : identifiant vide ou non conforme');
  if (typeof root.name !== 'string' || root.name.length === 0) errors.push('name : nom lisible manquant');

  const match = root.match;
  if (match !== undefined) {
    const appId = typeof match?.appId === 'string' ? match.appId : '';
    const product = typeof match?.product === 'string' ? match.product : '';
    const types = Array.isArray(match?.types) ? match.types.filter((t) => typeof t === 'string' && t) : [];
    if (!appId && !product && types.length === 0) errors.push('match : aucun critère de reconnaissance — appId, product ou types');
  }

  const hotkey = root.hotkey === undefined ? 'F7' : root.hotkey;
  if (typeof hotkey !== 'string' || hotkey.length === 0) errors.push('hotkey : touche vide');

  const friends = root.friends === undefined ? 'steam' : root.friends;
  if (!SOURCES.includes(friends)) errors.push(`friends : « ${friends} » inconnu (steam, manual)`);

  const identity = root.identity || {};
  const strategy = identity.strategy === undefined ? 'keep' : identity.strategy;
  if (!STRATEGIES.includes(strategy)) errors.push(`identity.strategy : « ${strategy} » inconnue`);
  if (strategy === 'prefix-host' && !identity.prefix) errors.push('identity.prefix : vide alors que la stratégie prefix-host en exige un');
  if (strategy === 'custom' && !identity.custom) errors.push('identity.custom : vide alors que la stratégie custom en exige un');

  const entry = root.entry || {};
  const kind = entry.strategy === undefined ? 'raw' : entry.strategy;
  if (!ENTRIES.includes(kind)) errors.push(`entry.strategy : « ${kind} » inconnue`);
  if (kind === 'native') {
    const native = entry.native || {};
    if (!native.type) errors.push('entry.native.type : absent alors que la stratégie native l’exige');
    if (!native.invoke) errors.push('entry.native.invoke : absent alors que la stratégie native l’exige');
  }

  const shield = root.shield;
  if (shield !== undefined && Array.isArray(shield.codes)) {
    shield.codes.forEach((c, i) => {
      if (typeof c !== 'number' || !Number.isInteger(c)) errors.push(`shield.codes[${i}] : un entier est attendu`);
    });
  }

  return errors;
}

function fail(message) {
  console.error('PROFILES ÉCHEC : ' + message);
  process.exit(1);
}

const negative = process.argv.includes('--negative');

if (!negative) {
  if (!existsSync(PROFILES)) fail('dossier des profils absent');
  const files = readdirSync(PROFILES).filter((f) => f.endsWith('.json'));
  if (files.length === 0) fail('aucun profil livré : il n’y aurait rien à valider');

  const ids = new Set();
  for (const f of files) {
    const errors = validate(readFileSync(path.join(PROFILES, f), 'utf8'));
    if (errors.length) fail(`${f} — ${errors.join(' ; ')}`);
    const id = JSON.parse(readFileSync(path.join(PROFILES, f), 'utf8')).id;
    if (ids.has(id)) fail(`identifiant « ${id} » livré deux fois`);
    ids.add(id);
  }

  // Le profil PEAK porte la découverte qui a été vérifiée en partie réelle :
  // c'est la seule valeur du dossier dont la perte serait silencieuse.
  const peak = JSON.parse(readFileSync(path.join(PROFILES, 'peak.json'), 'utf8'));
  if (peak.identity?.strategy !== 'prefix-host') fail('le profil PEAK a perdu sa stratégie d’identité');
  if (!peak.identity?.prefix) fail('le profil PEAK a perdu son préfixe');
  if (!(peak.shield?.codes || []).includes(104)) fail('le profil PEAK n’arme plus le bouclier sur le code observé');

  console.log(`${files.length} profil(s) valides : ${[...ids].join(', ')}`);
  console.log('PROFILES OK');
  process.exit(0);
}

// --- Jeu d'épreuves ---------------------------------------------------------

const EXPECTED = {
  'bad-schema.json': 'schema',
  'bad-id.json': 'id',
  'bad-name.json': 'name',
  'bad-strategy.json': 'identity.strategy',
  'bad-prefix.json': 'identity.prefix',
  'bad-custom.json': 'identity.custom',
  'bad-entry.json': 'entry.strategy',
  'bad-native.json': 'entry.native.type',
  'bad-friends.json': 'friends',
  'bad-codes.json': 'shield.codes',
  'bad-match.json': 'match',
  'bad-json.json': 'json',
};

if (!existsSync(FIXTURES)) fail('jeu d’épreuves absent');
const present = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
const wanted = Object.keys(EXPECTED).sort();
if (present.join(',') !== wanted.join(',')) {
  fail(`le jeu d’épreuves a changé — présents : ${present.join(', ')} / attendus : ${wanted.join(', ')}`);
}

for (const [file, field] of Object.entries(EXPECTED)) {
  const errors = validate(readFileSync(path.join(FIXTURES, file), 'utf8'));
  if (errors.length === 0) fail(`${file} aurait dû être refusé, il ne l’a pas été`);
  if (!errors.some((e) => e.startsWith(field))) {
    fail(`${file} refusé, mais sans nommer « ${field} » — obtenu : ${errors.join(' ; ')}`);
  }
}

// Le contrôle inverse : un profil correct doit passer ce même validateur, sinon
// « tout est refusé » serait une réussite de façade.
const good = readFileSync(path.join(PROFILES, 'peak.json'), 'utf8');
const ok = validate(good);
if (ok.length) fail('le profil livré est refusé par le validateur du mode négatif : ' + ok.join(' ; '));

console.log(`${present.length} défauts distincts refusés, chacun en nommant son champ ; le profil valide passe.`);
console.log('PROFILES REJECT OK');
