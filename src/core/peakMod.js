/**
 * Rejoindre un ami sur PEAK depuis une session Spacewar.
 *
 * PEAK filtre ses arrivants chez l'hôte. Dans GameUtils::OnPlayerEnteredRoom :
 *
 *     if (!NetCode.Matchmaking.PlayerIsInLobby(joueur.UserId)) {
 *         LogError("… is not in our Steam lobby. That's too sussy to allow. Kicking them.");
 *         NetCode.Session.Kick(joueur.UserId);
 *         return;                                   // saute la synchronisation
 *     }
 *
 * Un invité venu par Photon plutôt que par le lobby Steam échoue à ce test, se
 * fait couper par le serveur Photon, et n'a de toute façon jamais reçu son
 * personnage. Les lobbys Steam étant cloisonnés par application, une session
 * sous 480 ne peut pas rejoindre celui d'un hôte sous 3527290 : le test est
 * imperdable par la voie normale.
 *
 * Ce que le mod exploite, c'est que les deux vérifications en jeu ne comparent
 * pas la même chose :
 *
 *   · chez l'hôte, PlayerIsInLobby fait UInt64.TryParse(userId) puis compare des
 *     CSteamID — donc des NOMBRES, et les zéros de tête sont des chiffres
 *     ordinaires ;
 *   · chez Photon, l'unicité imposée par CheckUserOnJoin compare des CHAÎNES.
 *
 * Se présenter sous « 0 » + le SteamID64 de l'hôte satisfait donc le premier
 * (le nombre retombe sur un membre de son lobby : lui-même) sans déclencher le
 * second (le texte diffère, pas de collision). Vérifié en partie réelle :
 * « état=Joined joueurs=2 personnages=2 » vingt secondes durant, sans aucune
 * trame de coupure.
 *
 * Le reste suit tout seul : CharacterSpawner::HostUpdate envoie
 * RPC_NewPlayerSpawn toutes les deux secondes à tout acteur sans personnage,
 * sans jamais consulter PlayerIsInLobby. L'hôte fait naître l'invité de
 * lui-même — il joue en version d'origine et n'installe rien.
 *
 * Ce module pose et retire le greffon, et avec lui le chargeur BepInEx dont il
 * dépend — les deux voyagent dans deps/, comme les autres proxies. Rien n'est
 * téléchargé : celui qui reçoit Librarian n'a donc rien à aller chercher, ce qui
 * est tout l'intérêt de les embarquer. Le mod est réversible en un clic et ne
 * touche qu'au dossier du jeu.
 */
const fs = require('fs');
const path = require('path');
const { getDepsPath } = require('./runtimePaths');

/** Le seul jeu que ce greffon connaisse. */
const PEAK_APPID = '3527290';

const PLUGIN = 'PeakJoinFriend.dll';
const LOADER = 'winhttp.dll';           // le doorstop que Unity charge au démarrage
const DOORSTOP = 'doorstop_config.ini';
const CORE_MARKER = path.join('BepInEx', 'core', 'BepInEx.dll');

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

/**
 * Deux fichiers ont-ils exactement le même contenu ?
 *
 * Comparer les dates ne répond pas à cette question : une copie récente d'un
 * fichier identique porte une date neuve, et l'interface réclamait alors une
 * mise à jour qui n'aurait rien changé. On compare donc la taille, puis les
 * octets — quelques dizaines de kilo-octets, lus une fois par ouverture de
 * fiche.
 */
function sameBytes(a, b) {
  const sa = fs.statSync(a);
  const sb = fs.statSync(b);
  if (sa.size !== sb.size) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}


/** Le chargeur BepInEx tel que Librarian le livre. */
function bundledLoader() {
  try { return getDepsPath('bepinex'); }
  catch { return path.join(__dirname, '..', '..', 'deps', 'bepinex'); }
}

/** Le greffon tel que Librarian le livre. */
function bundledPlugin() {
  try { return getDepsPath('librarian', PLUGIN); }
  catch { return path.join(__dirname, '..', '..', 'deps', 'librarian', PLUGIN); }
}

/**
 * Ce qui est en place dans un dossier de jeu.
 *
 * `applies` distingue « ce jeu n'est pas concerné » de « rien n'est installé » :
 * l'interface n'a aucune raison de proposer le greffon ailleurs que sur PEAK.
 */
function status(game) {
  const dir = game && game.install_path ? String(game.install_path) : '';
  const appId = String((game && game.appid) || '').trim();
  const applies = appId === PEAK_APPID;

  if (!dir || !exists(dir)) {
    return { ok: false, applies, error: 'Dossier du jeu introuvable.' };
  }

  const loader = exists(path.join(dir, LOADER)) && exists(path.join(dir, CORE_MARKER));
  const pluginPath = path.join(dir, 'BepInEx', 'plugins', PLUGIN);
  const installed = exists(pluginPath);

  let stale = false;
  if (installed) {
    // Une version livrée différente de celle posée doit se voir : un greffon
    // périmé échoue en silence quand le jeu change, ce qui est le pire des cas.
    try { stale = !sameBytes(bundledPlugin(), pluginPath); }
    catch { /* pas de comparaison possible : on n'affirme rien */ }
  }

  return {
    ok: true,
    applies,
    loader,                       // BepInEx est là
    installed,                    // notre greffon est posé
    stale,                        // …mais dans une version dépassée
    bundled: exists(bundledPlugin()),
    loaderBundled: exists(path.join(bundledLoader(), 'winhttp.dll')),
    dir,
    reason: loader ? '' : 'BepInEx n’est pas encore installé dans ce jeu.',
  };
}

/**
 * Poser le greffon. Requiert BepInEx : sans chargeur, un plugin n'est qu'un
 * fichier inerte, et le dire tout de suite vaut mieux qu'un « installé » qui ne
 * produit rien.
 */
function install(game, mayInstallLoader = true) {
  const st = status(game);
  if (!st.ok) return { success: false, error: st.error };
  if (!st.bundled) return { success: false, error: `${PLUGIN} manque dans les dépendances de Librarian.` };

  // Le chargeur voyage avec Librarian : plutôt que de renvoyer l'utilisateur
  // vers une tâche préalable, on la fait. Le drapeau coupe la récursion —
  // installLoader rappelle install, et sans lui une pose de chargeur qui échoue
  // à mi-chemin ferait tourner les deux fonctions l'une dans l'autre.
  if (!st.loader) {
    if (!mayInstallLoader) {
      return { success: false, needsLoader: true, error: 'BepInEx n’a pas pu être posé dans ce jeu.' };
    }
    return installLoader(game);
  }

  const dest = path.join(st.dir, 'BepInEx', 'plugins');
  try {
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(bundledPlugin(), path.join(dest, PLUGIN));
  } catch (err) {
    return { success: false, error: `Copie impossible : ${err.message}` };
  }
  return { success: true, path: path.join(dest, PLUGIN) };
}

/** Retirer le greffon, en laissant BepInEx et le reste du jeu intacts. */
function uninstall(game) {
  const st = status(game);
  if (!st.ok) return { success: false, error: st.error };
  try { fs.unlinkSync(path.join(st.dir, 'BepInEx', 'plugins', PLUGIN)); }
  catch { /* déjà absent */ }
  return { success: true };
}

/**
 * Installer BepInEx, livré avec Librarian.
 *
 * Rien n'est téléchargé au moment de l'installation : le chargeur voyage dans
 * l'application, comme les autres proxies de deps/. Celui qui reçoit Librarian
 * n'a donc rien à aller chercher — c'était tout l'intérêt de l'embarquer.
 *
 * `sourceDir` reste accepté pour le cas où quelqu'un veut poser sa propre
 * version, mais il n'est plus nécessaire.
 */
function installLoader(game, sourceDir) {
  const st = status(game);
  if (!st.ok) return { success: false, error: st.error };
  if (!sourceDir) sourceDir = bundledLoader();
  if (!exists(sourceDir)) return { success: false, error: 'BepInEx manque dans les dépendances de Librarian.' };

  const needed = [LOADER, DOORSTOP, path.join('BepInEx', 'core')];
  const missing = needed.filter((f) => !exists(path.join(sourceDir, f)));
  if (missing.length) {
    return {
      success: false,
      error: `Ce dossier ne ressemble pas à BepInEx x64 (manque : ${missing.join(', ')}).`,
    };
  }

  try {
    fs.cpSync(path.join(sourceDir, 'BepInEx'), path.join(st.dir, 'BepInEx'), { recursive: true });
    for (const f of [LOADER, DOORSTOP, '.doorstop_version']) {
      const src = path.join(sourceDir, f);
      if (exists(src)) fs.copyFileSync(src, path.join(st.dir, f));
    }
  } catch (err) {
    return { success: false, error: `Installation de BepInEx impossible : ${err.message}` };
  }

  return { ...install(game, false), loaderInstalled: true };
}

module.exports = { status, install, uninstall, installLoader, bundledLoader, PEAK_APPID };
