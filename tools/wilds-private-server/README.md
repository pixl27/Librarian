# Raccordement d'un serveur privé à Wilds

État : outils d'inspection préparés ; aucun serveur Wilds jouable implémenté.
La réussite finale reste une chasse entre deux clients réels.

## Résultats actuels

- L'exécutable inspecté importe 48 fonctions de `PartyWin.dll`, dont la création
  de réseau, la connexion, les endpoints et l'envoi de messages. Toutes sont
  résolues dans la DLL Microsoft conservée avec cette installation.
- Les trois points observés par l'ancienne sonde sont bien importés. Ses logs
  vides ne viennent donc pas d'un simple décalage entre API C et API C++.
  Une importation statique ne prouve toutefois pas qu'une fonction a été appelée.
- L'analyse des identifiants a produit 490 candidats, dont des classes de
  session et des interfaces déduites de noms de membres. Seul le moteur en
  exécution peut confirmer lesquels sont présents dans sa base de types.

Les rapports JSON et la préparation locale sont sous
`audits/2026-09-22/wilds-private-server/`.

## Export au prochain lancement

`librarian_network_metadata.lua` a été installé puis retiré après l'échec de
démarrage décrit ci-dessous. Il reste disponible dans ce dossier du projet.
Il lit uniquement des descripteurs de types et de méthodes, au
maximum deux types par image, puis écrit une seule fois :

`E:\Games\steam\steamapps\common\Monster_Hunter_Wilds\reframework\data\librarian_network_metadata.json`

Le menu principal suffit ; aucune tentative de connexion n'est nécessaire.
L'export ne lit aucune instance, valeur de champ, identité, ticket ou adresse.
Il n'appelle pas les fonctions du jeu et ne modifie aucun endpoint.
Les limites, éléments absents, erreurs et troncatures figurent dans le JSON.

Lorsqu'il est installé, le menu principal suffit pour générer le fichier.
La présence d'un setter d'URL dans les métadonnées ne démontre ni sa validité
dans ce build ni la compatibilité du protocole avec un service de remplacement.

## État du jeu après préparation

La préparation vérifie les empreintes de chaque ancien fichier avant action.
Les sondes Party/WinHTTP, la configuration de réponses synthétiques, leurs logs
et l'ancien script de lecture d'authentification ont été sauvegardés dans
`client-backup-20260922-182228/`, puis retirés de l'installation active.
`PartyWin.dll` a été restauré depuis la copie originale Microsoft signée.
WinHTTP provient désormais du système selon la résolution normale des DLL.
La résolution réelle en jeu reste à vérifier lors d'un lancement.
37 autres exécutables, DLL, configurations et le statut Librarian contrôlés
ont conservé leurs empreintes. Les sauvegardes du joueur n'ont pas été ciblées.

Le reçu `client-backup-20260922-182228/receipt.json` décrit exactement les
changements. Le script de préparation refuse de s'appliquer à un état différent
et n'est pas un installateur universel.

### Échec du lancement à 18:23 et retrait de l'exporteur

Le lancement effectué par l'utilisateur s'est arrêté avec le message Reflex
« Blocked deletion of token file ». Le journal annonce préalablement
« Hypervisor initialized successfully ». Cela n'établit ni la validité de
l'activation ni la cause précise du rejet. Aucun export JSON n'a été généré.
Les 37 fichiers surveillés hors des changements restent identiques au reçu.

La restauration complète des huit anciens fichiers a été refusée par la revue
automatique avec « blocked by policy » ; la commande n'a pas été exécutée.
L'exporteur nouvellement ajouté a ensuite été retiré séparément après contrôle
de son empreinte. Les anciennes sondes restent archivées ; PartyWin reste la
bibliothèque Microsoft d'origine et le proxy WinHTTP local reste absent.
Les fichiers d'activation et les réglages de sécurité n'ont pas été modifiés.

État actuel : aucun exporteur installé, aucun export réel disponible, nouveau
démarrage non vérifié. La cause de l'échec n'est pas isolée par un retour complet
à l'état précédent. Le travail de raccordement au serveur privé reste incomplet.

## Outils et vérification

```powershell
node --test tools/wilds-private-server/audit-party-imports.test.cjs
python tools/wilds-private-server/test_discover_network_types.py
python tools/wilds-private-server/test_metadata_export.py
```

Le dernier test requiert `lupa` uniquement dans l'environnement Python de test.
Il exécute le vrai script Lua avec des API de métadonnées simulées, sans jeu,
réseau ni accès aux fichiers. Les 25 tests ont réussi pendant la préparation.
Ces tests ne prouvent pas l'exécution du script dans Wilds.

Commandes de lecture des binaires, à exécuter depuis le projet et avec des noms
de sortie encore inexistants :

```powershell
node tools/wilds-private-server/audit-party-imports.cjs --exe 'E:\Games\steam\steamapps\common\Monster_Hunter_Wilds\MonsterHunterWilds.exe' --party 'E:\Games\steam\steamapps\common\Monster_Hunter_Wilds\PartyWin.dll' --out party-imports-new.json
python tools/wilds-private-server/discover-network-types.py --input 'E:\Games\steam\steamapps\common\Monster_Hunter_Wilds\MonsterHunterWilds.exe' --out network-types-new.json
```

## Prochaine décision

Examiner l'export réel pour établir les signatures de création, recherche,
jointure et sortie des sessions, et les types de données associés. Ces signatures
décrivent le côté client ; le protocole réseau et un point d'intégration utilisable
restent à vérifier avant de construire un serveur compatible.

API de métadonnées utilisées :
[SDK REFramework](https://cursey.github.io/reframework-book/api/sdk.html),
[types](https://cursey.github.io/reframework-book/api/types/RETypeDefinition.html),
[méthodes](https://cursey.github.io/reframework-book/api/types/REMethodDefinition.html),
[champs](https://cursey.github.io/reframework-book/api/types/REField.html),
[export JSON](https://cursey.github.io/reframework-book/api/json.html).
