// Une PATH stable pour toutes les vérifications.
//
// L'approbation d'un oracle lie la PATH héritée dans son intégralité — c'est
// voulu : un même contrôle lancé avec d'autres outils au chemin n'est pas le
// même contrôle. Mais la PATH de cette session contient des entrées
// régénérées à chaque appel (répertoires de greffons sous
// local-agent-mode-sessions), ce qui invaliderait chaque approbation à la
// seconde suivante et rendrait toute vérification impossible.
//
// On fixe donc la PATH sur les seuls outils dont les contrôles ont besoin :
// node, dotnet, l'interpréteur de commandes et les utilitaires système. Ce
// n'est pas un contournement de l'approbation — chaque oracle est toujours
// approuvé explicitement — c'est ce qui rend l'environnement reproductible,
// condition sans laquelle l'approbation ne veut rien dire.
//
//   node tools/photonjoin/verify/env.mjs        → écrit la PATH canonique
//   PATH=$(node tools/photonjoin/verify/env.mjs) node <checker> …

export const CANONICAL_PATH = [
  'C:\\Program Files\\nodejs',
  'C:\\Program Files\\dotnet',
  'C:\\WINDOWS\\system32',
  'C:\\WINDOWS',
  'C:\\WINDOWS\\System32\\Wbem',
  'C:\\Program Files\\Git\\cmd',
  'C:\\Program Files\\Git\\usr\\bin',
  'C:\\Program Files\\Git\\mingw64\\bin',
].join(';');

import { pathToFileURL } from 'node:url';

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.stdout.write(CANONICAL_PATH);
}
