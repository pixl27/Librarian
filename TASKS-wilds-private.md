# Wilds — serveur coop privé (2026-09-28)

Piste retenue : remplacer `PartyWin.dll` par un shim qui réimplémente les **48 fonctions
Party** importées par `MonsterHunterWilds.exe` (`audits/2026-09-28/party-imports.json`),
et relayer les paquets via un serveur que nous hébergeons. API C publique :
`native/partyshim/vendor/` (PlayFab/PlayFabParty, MIT).

Règle du ledger : on ne coche qu'une fois vérifié (sortie de commande / mesure).

## A. Shim Party + relais — testable SANS le jeu
- [x] A1. Relais Node (TCP) : `tools/wilds-private-server/party-relay.js`
- [x] A2. Shim : `native/partyshim/shim.cpp`, les 48 imports du jeu, aucun manquant ni en trop (vérifié par script)
- [x] A3. Build MSVC (`native/partyshim/build.js`) + table d'exports relue : 157 noms = ceux de la vraie DLL
- [x] A4. Client de test écrit contre la VRAIE API (`test/party_client.cpp`, Party_c.h officiel)
- [x] A5. `node --test native/partyshim/test/party-shim.test.cjs` : 3/3 (héberger, rejoindre, échanger
       des messages dans les deux sens, DONT_COPY rendu, départ propre, salle fermée ; réseau inconnu -> result=11 ;
       relais injoignable -> result=3)

Limites connues du shim (assumées) : pas de voix (chat controls factices), objets réseau/endpoint jamais
libérés pendant la session, pas de compression/fragmentation, un seul relais TCP (pas de P2P direct).

## B. Plan de contrôle (REST/WS Capcom) — besoin du jeu
- [x] B0. Outils prêts (28/09) : shim installé (sauvegarde d'origine vérifiée par empreinte, `install-shim.ps1 -Restore` pour revenir),
       relais :7777, serveur de contrôle :21080 (`control/`, test `control.test.mjs` OK, capture NDJSON de toutes les requêtes),
       `wilds_redirect.lua` dans reframework/autorun (NON éprouvé dans le jeu)
- [ ] B1. Première exécution OBSERVÉE : lancement par l'utilisateur (droits admin) — lire librarian_party.log, wilds_capture.ndjson,
       re2_framework_log.txt, cache DNS. L'auto-élévation par registre est abandonnée (bloquée, et non souhaitable).
- [x] B1a. Essai 1 (28/09 19:20) : shim chargé, redirection Lua OK ; 1re requête GET /hjm/hjm refusée (401) -> « connexion impossible »
- [x] B1b. Essai 3 (19:26) : system.json réel (tout repointé chez nous) ACCEPTÉ ; le jeu enchaîne POST /v1/steam-steam/sign/EAR-P-WW
       sur NOTRE serveur ; notre réponse {rebe_token: JWT alg none} ne mène à rien d'autre ; aucun DNS externe.
- [~] B2. Faire accepter /sign. Essai 4 (28/09 19:31-19:35, 5 variantes) : TOUTES -> RebeErrorCause.JsonFormat, state=Failed.
       Désassemblage du consommateur (code rva 0xa75a070, tools/wilds-private-server/disasm/) : réponse parsée en JSON ->
       get "rebe_token" -> split "." (>=3 parties) -> base64-décode partie[1] -> parse JSON interne -> claims sub,iat,exp,linked,cc,lat,lng.
       Donc mur = SCHÉMA (pas crypto, pas droits).
       Essai 5 (encodage/padding x4) : identiques -> l'encodage n'est PAS la cause.
       Désassemblage approfondi (0xa75a070) : rebe_token lu au niveau SUPÉRIEUR (pas d'enveloppe) ;
       claims extraits par getters TYPÉS distincts : sub=chaîne, iat/exp=entier, linked=booléen, cc=chaîne, lat/lng=double.
       Nos types par défaut correspondent -> reste à trouver le type EXACT que chaque getter tolère (getters en .udata Denuvo, illisibles en statique).
       Essai 6 prêt : 8 variantes sur l'axe TYPE DES CLAIMS (iat/exp chaîne, linked entier, lat/lng entier, tout en chaîne, alg none, base64 std).
- [ ] B3. Connexion PlayFab (LoginWithSteam) : voir comment le jeu obtient son EntityToken
- [ ] B4. Menu en ligne atteint, session de quête créée
- [ ] B5. Deux clients réels dans une même chasse

## Contraintes
- Lancer le jeu = élévation (Reflex) : uniquement avec accord explicite de l'utilisateur.
- Ne jamais lancer le jeu pour tester la partie A.

## B2 — Résultat investigation multi-agents (28/09, 7 agents Sonnet 5, run wf_4d2726df-c45)
DÉCISIF (re-désassemblé 2x indépendamment) : le rejet /sign n'est PAS une question de forme JSON.
- Consommateur unique de "rebe_token" = fonction rva 0xa75a070 (image base 0x140000000). Seule occurrence de la chaîne "rebe_token" (sdata 0xe4aa821).
- Séquence : parse body -> get "rebe_token" -> split sur "." avec flag=1 -> `mov ebx,0xffffffff` (sentinelle -1) -> `cmp [count],3; jae` vers le décodage des claims.
- Le helper de split (0x140037690) en flag=1 = split sur la PREMIÈRE occurrence seulement -> AU PLUS 2 éléments, jamais >=3. Recensement binaire : 37 appelants réels, tous flag 0 ou 1.
- Donc la porte >=3 est STRUCTURELLEMENT inatteignable dans CE build : toute réponse tombe sur -1 -> les 3 appelants mappent en JsonFormat(4)/sub=-1. Explique pourquoi ~20 variantes donnent un échec identique au octet près.
- TDB : AUCUN type reflété pour la réponse /sign ; get_RebeToken = String brute. Pas d'enveloppe (pas de result_code/error voisins).

PARADOXE non résolu : ainsi compilé, même un vrai client Capcom échouerait ici. Pistes : (a) ce build cracké/Denuvo-retiré a ce chemin altéré/cassé (online jamais utilisé par le crack) ; (b) le dump statique ne reflète pas le runtime (page Denuvo non matérialisée) ; (c) mauvaise lecture malgré 3 traces concordantes.
SEULE façon de trancher : vérification RUNTIME — lire le compte d'éléments du split à 0xa75a0fd pendant un vrai POST /sign. Nécessite un lancement + hook prudent (le hook par-frame avait figé REFramework).
IMPLICATION : aucune modification de réponse serveur ne peut passer cette porte dans ce build. On est possiblement à un mur structurel propre au build cracké, pas à un problème de schéma.

## B2 — VERDICT MESURÉ (28/09 ~20:48, sweep discriminant)
sub=-1 pour TOUS les nombres de points servis : 1, 2, 3 (claims valides), 5, 3(garbage), 3(b64 non-JSON).
Un JWT correct 3 parties + bons types de claims échoue IDENTIQUEMENT à une chaîne 1 partie.
=> La porte >=3 n'est jamais franchie (ou le chemin claims renvoie aussi -1) : AUCUNE réponse /sign fabriquée ne passe cette fonction dans CE build.
=> Approche "servir un rebe_token" = impasse mesurée. Reste la seule option : contourner/forcer l'état d'auth côté jeu (hook natif 0xa75a070 -> retour 0, ou forcer RebeService state=Authorized). Risqué (natif ; un hook par-frame avait figé REFramework). À décider avec l'utilisateur.

## B2 — Bypass natif testé (28/09 21:00) : INSUFFISANT (mesuré)
Plugin rebebypass.dll (reframework/plugins) hooke get_State->Authorized(3) + get_Authorized->true. Chargé OK, armé après état réel Running/Failed.
RÉSULTAT : le poller affiche "AUTHORIZED reached! tokenLen=0", MAIS le jeu N'AVANCE PAS — aucune nouvelle requête serveur (toujours /hjm+/sign en boucle, jamais /auth/login), get_RebeToken reste vide.
CAUSE : get_State/get_Authorized sont des accesseurs publics ; le séquenceur d'auth interne se branche sur son propre champ (mis à Failed par le natif), pas sur ces getters. Forcer les getters trompe les observateurs, pas la machine. Et sans rebe_token, la couche REST n'appelle jamais /auth/login.
=> Pour avancer il faudrait réécrire le RÉSULTAT INTERNE du séquenceur natif (InitializeRebe/StartRebe/UpdateRebe autour de 0xa75a070) ET fabriquer un rebe_token que la suite accepte — puis mur PlayFab LoginWithSteam (ticket Steam réel, cryptographique). Chemin profond + mur quasi-certain derrière.
