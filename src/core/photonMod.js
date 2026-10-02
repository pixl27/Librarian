/**
 * Rejoindre un ami dans n'importe quel jeu Unity bâti sur Photon.
 *
 * Le greffon PEAK, lui, est taillé pour un seul titre : il est compilé contre
 * Assembly-CSharp, PhotonUnityNetworking et Steamworks.NET, et ne se charge
 * donc nulle part ailleurs. PhotonJoin fait le même travail sans référencer une
 * seule assemblée de jeu — il découvre Photon par réflexion au démarrage et
 * tire ce qui est propre au titre d'un profil JSON posé à côté de lui.
 *
 * Ce module est la moitié Librarian de l'affaire : reconnaître seul qu'un
 * dossier de jeu est concerné, puis y poser ou en retirer le moteur.
 *
 * La reconnaissance ne s'appuie sur aucune liste d'AppID, et c'est le point :
 * une liste ne connaîtrait que les jeux qu'on aurait pensé à y écrire. On
 * regarde donc le dossier lui-même — un jeu Unity a un dossier <Nom>_Data avec
 * un Managed dedans ; un jeu Photon a, quelque part dans ce Managed, une
 * assemblée qui déclare le type PhotonNetwork.
 *
 * Sur PEAK, le greffon dédié reste recommandé : il est le seul à emprunter la
 * machine à états et le chargement de scène du jeu, ce qu'un profil déclaratif
 * ne sait pas exprimer, et il a été vérifié en partie réelle. Voir
 * [[peakMod]] et le champ `preferDedicated` ci-dessous.
 */
const fs = require('fs');
const path = require('path');
const { getDepsPath } = require('./runtimePaths');
const { PEAK_APPID } = require('./peakMod');

const PLUGIN = 'PhotonJoin.dll';
const FOLDER = 'PhotonJoin';            // sous BepInEx/plugins/
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


/** Les profils posés diffèrent-ils de ceux qu'on livre ? */
function profilesDiffer(installedDir) {
  const source = path.join(bundledDir(), 'profiles');
  if (!exists(source)) return false;
  let wanted;
  try { wanted = fs.readdirSync(source).filter((f) => f.endsWith('.json')); } catch { return false; }
  for (const f of wanted) {
    const posed = path.join(installedDir, f);
    if (!exists(posed)) return true;
    if (!sameBytes(path.join(source, f), posed)) return true;
  }
  return false;
}

/** Le moteur tel que Librarian le livre. */
function bundledDir() {
  try { return getDepsPath('photonjoin'); }
  catch { return path.join(__dirname, '..', '..', 'deps', 'photonjoin'); }
}

/** Le chargeur BepInEx, partagé avec le greffon PEAK. */
function bundledLoader() {
  try { return getDepsPath('bepinex'); }
  catch { return path.join(__dirname, '..', '..', 'deps', 'bepinex'); }
}

// ─── Reconnaissance ───────────────────────────────────────────────────────────

// Les assemblées du socle ne contiennent jamais le code du jeu : les écarter
// évite de lire cent mégaoctets pour rien à chaque ouverture de fiche.
const FRAMEWORK = /^(UnityEngine|System|Mono|mscorlib|netstandard|Microsoft|Newtonsoft|Unity\.|com\.unity)/i;

/** Le dossier Managed d'un jeu Unity, s'il y en a un. */
function unityManaged(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith('_Data')) continue;
    const managed = path.join(dir, e.name, 'Managed');
    if (exists(managed)) return managed;
  }
  return '';
}

/**
 * Chercher PUN dans les assemblées d'un jeu.
 *
 * On lit les octets plutôt que les métadonnées : le nom d'un type apparaît tel
 * quel dans le tas de chaînes d'un assembly .NET, et une recherche de sous-
 * chaîne suffit à répondre « ce jeu embarque-t-il PUN ». C'est une heuristique,
 * assumée comme telle — elle décide seulement s'il faut proposer le moteur dans
 * l'interface. Le greffon, lui, tranche pour de bon au démarrage du jeu, et le
 * dit dans le journal de BepInEx quand il n'y arrive pas.
 */
function photonIn(managed) {
  let files;
  try { files = fs.readdirSync(managed); } catch { return null; }
  const dlls = files.filter((f) => f.toLowerCase().endsWith('.dll'));

  // D'abord les assemblées qui s'annoncent : c'est le cas courant et il coûte
  // une seule lecture.
  const named = dlls.filter((f) => /photon/i.test(f));
  for (const f of named) {
    if (declaresPhoton(path.join(managed, f))) return { file: f, how: 'assemblée Photon livrée séparément' };
  }

  // Sinon le code du jeu, où PUN peut avoir été fusionné.
  const own = dlls.filter((f) => !FRAMEWORK.test(f) && !/photon/i.test(f));
  own.sort((a, b) => (a === 'Assembly-CSharp.dll' ? -1 : b === 'Assembly-CSharp.dll' ? 1 : 0));
  for (const f of own.slice(0, 40)) {
    if (declaresPhoton(path.join(managed, f))) return { file: f, how: 'PUN fusionné dans le code du jeu' };
  }
  return null;
}

function declaresPhoton(file) {
  let buf;
  try {
    if (fs.statSync(file).size > 96 * 1024 * 1024) return false;
    buf = fs.readFileSync(file);
  } catch { return false; }
  // Le type ET son espace de noms. « PhotonNetwork » seul se trouve aussi dans
  // des assemblées qui n'en ont gardé qu'une mention ; l'espace de noms de PUN
  // ou de Realtime à côté rend le faux positif nettement moins probable.
  if (!buf.includes('PhotonNetwork', 0, 'latin1')) return false;
  return buf.includes('Photon.Pun', 0, 'latin1')
      || buf.includes('Photon.Realtime', 0, 'latin1')
      || buf.includes('ExitGames.Client.Photon', 0, 'latin1');
}

// La lecture des assemblées est la partie chère ; l'interface rouvre la même
// fiche souvent. On retient le verdict tant que le dossier n'a pas bougé.
const cache = new Map();

function detect(dir) {
  if (!dir || !exists(dir)) return { unity: false, photon: false, managed: '', file: '', evidence: '' };

  const managed = unityManaged(dir);
  if (!managed) return { unity: false, photon: false, managed: '', file: '', evidence: 'aucun dossier <jeu>_Data/Managed' };

  let stamp = 0;
  try { stamp = fs.statSync(managed).mtimeMs; } catch { }
  const key = managed + '|' + stamp;
  if (cache.has(key)) return cache.get(key);

  const hit = photonIn(managed);
  const result = {
    unity: true,
    photon: Boolean(hit),
    managed,
    file: hit ? hit.file : '',
    evidence: hit ? `${hit.file} — ${hit.how}` : 'aucune assemblée ne déclare PhotonNetwork',
  };
  cache.set(key, result);
  return result;
}

// ─── État ─────────────────────────────────────────────────────────────────────

/**
 * Ce qui est en place dans un dossier de jeu.
 *
 * `applies` dit si l'interface a une raison de proposer le moteur ;
 * `preferDedicated` dit qu'un greffon spécifique, déjà éprouvé, vaut mieux ici.
 */
function status(game) {
  const dir = game && game.install_path ? String(game.install_path) : '';
  const appId = String((game && game.appid) || '').trim();

  if (!dir || !exists(dir)) {
    return { ok: false, applies: false, error: 'Dossier du jeu introuvable.' };
  }

  const found = detect(dir);
  const applies = found.unity && found.photon;

  const loader = exists(path.join(dir, LOADER)) && exists(path.join(dir, CORE_MARKER));
  const pluginPath = path.join(dir, 'BepInEx', 'plugins', FOLDER, PLUGIN);
  const installed = exists(pluginPath);

  let stale = false;
  if (installed) {
    // Un moteur périmé échoue en silence quand le jeu change de version de PUN :
    // c'est le pire des cas, donc il doit se voir dans l'interface. Les profils
    // comptent autant que le binaire — un profil corrigé sans nouveau moteur est
    // exactement le genre de mise à jour qu'il faut proposer.
    try {
      stale = !sameBytes(path.join(bundledDir(), PLUGIN), pluginPath)
           || profilesDiffer(path.join(dir, 'BepInEx', 'plugins', FOLDER, 'profiles'));
    } catch { /* pas de comparaison possible : on n'affirme rien */ }
  }

  return {
    ok: true,
    applies,
    unity: found.unity,
    photon: found.photon,
    evidence: found.evidence,
    photonFile: found.file || '',
    loader,
    installed,
    stale,
    bundled: exists(path.join(bundledDir(), PLUGIN)),
    loaderBundled: exists(path.join(bundledLoader(), LOADER)),
    preferDedicated: appId === PEAK_APPID,
    dir,
    reason: loader ? '' : 'BepInEx n’est pas encore installé dans ce jeu.',
  };
}

// ─── Pose et retrait ──────────────────────────────────────────────────────────

/**
 * Poser le moteur et ses profils.
 *
 * Comme pour le greffon PEAK, le drapeau coupe la récursion : installLoader
 * rappelle install, et sans lui une pose de chargeur qui échoue à mi-chemin
 * ferait tourner les deux fonctions l'une dans l'autre.
 */
function install(game, mayInstallLoader = true) {
  const st = status(game);
  if (!st.ok) return { success: false, error: st.error };
  if (!st.bundled) return { success: false, error: `${PLUGIN} manque dans les dépendances de Librarian.` };
  if (!st.applies) {
    return {
      success: false,
      error: st.unity
        ? 'Ce jeu Unity n’embarque pas Photon : le moteur n’y servirait à rien.'
        : 'Ce jeu n’est pas un jeu Unity.',
    };
  }

  if (!st.loader) {
    if (!mayInstallLoader) {
      return { success: false, needsLoader: true, error: 'BepInEx n’a pas pu être posé dans ce jeu.' };
    }
    return installLoader(game);
  }

  const dest = path.join(st.dir, 'BepInEx', 'plugins', FOLDER);
  try {
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(bundledDir(), PLUGIN), path.join(dest, PLUGIN));
    const profiles = path.join(bundledDir(), 'profiles');
    if (exists(profiles)) fs.cpSync(profiles, path.join(dest, 'profiles'), { recursive: true });
  } catch (err) {
    return { success: false, error: `Copie impossible : ${err.message}` };
  }
  return { success: true, path: path.join(dest, PLUGIN) };
}

/** Retirer le moteur, en laissant BepInEx et le reste du jeu intacts. */
function uninstall(game) {
  const st = status(game);
  if (!st.ok) return { success: false, error: st.error };
  try { fs.rmSync(path.join(st.dir, 'BepInEx', 'plugins', FOLDER), { recursive: true, force: true }); }
  catch (err) { return { success: false, error: `Retrait impossible : ${err.message}` }; }
  return { success: true };
}

/**
 * Installer BepInEx, livré avec Librarian.
 *
 * Rien n'est téléchargé : le chargeur voyage dans l'application, comme les
 * autres proxies de deps/. Celui qui reçoit Librarian n'a donc rien à aller
 * chercher.
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

module.exports = {
  status, install, uninstall, installLoader,
  detect, bundledDir, bundledLoader,
  PLUGIN, FOLDER,
};
