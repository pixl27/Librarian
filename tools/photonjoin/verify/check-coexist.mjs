// Les deux greffons dans le même jeu, sans se marcher dessus.
//
// PhotonJoin est générique et non éprouvé en partie réelle ; PeakJoinFriend est
// spécifique à PEAK et l'a été. Sur PEAK, c'est donc le second qui doit rester
// recommandé — c'est ce que dit `preferDedicated`, et c'est ce que l'interface
// affiche. Rien n'empêche pour autant de les avoir tous les deux : ils occupent
// des chemins distincts, et retirer l'un ne doit pas emporter l'autre.
//
//   node tools/photonjoin/verify/check-coexist.mjs
//   node tools/photonjoin/verify/check-coexist.mjs --both

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require_ = createRequire(import.meta.url);
const photonMod = require_(path.join(ROOT, 'src', 'core', 'photonMod.js'));
const peakMod = require_(path.join(ROOT, 'src', 'core', 'peakMod.js'));

const both = process.argv.includes('--both');
const MARK = both ? 'COEXIST BOTH' : 'COEXIST';
const STEAM = 'e:\\games\\steam\\steamapps\\common';

let sandbox = '';

function fail(message) {
  if (sandbox) { try { rmSync(sandbox, { recursive: true, force: true }); } catch { } }
  console.error(`${MARK} ÉCHEC : ${message}`);
  process.exit(1);
}

function makePeakLike() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'librarian-coexist-'));
  const managed = path.join(dir, 'Jeu_Data', 'Managed');
  mkdirSync(managed, { recursive: true });
  writeFileSync(path.join(managed, 'PhotonUnityNetworking.dll'), 'Photon.Pun PhotonNetwork');
  return dir;
}

if (!both) {
  // Sur PEAK, le greffon dédié doit rester le choix recommandé.
  const peakDir = path.join(STEAM, 'PEAK');
  if (!existsSync(peakDir)) fail('PEAK n’est pas installé : le contrôle ne prouverait rien');

  const game = { install_path: peakDir, appid: peakMod.PEAK_APPID };
  const gen = photonMod.status(game);
  const ded = peakMod.status(game);

  if (!gen.ok || !ded.ok) fail('statut illisible');
  if (!gen.applies) fail('le moteur générique ne reconnaît pas PEAK, alors qu’il est bien Photon');
  if (!ded.applies) fail('le greffon dédié ne reconnaît plus PEAK');
  if (!gen.preferDedicated) fail('le moteur générique ne cède pas la place au greffon éprouvé sur PEAK');

  // Et ailleurs, il ne doit pas céder la place à un greffon qui ne s'y charge pas.
  const ailleurs = photonMod.status({ install_path: peakDir, appid: '999999' });
  if (ailleurs.preferDedicated) fail('le greffon dédié est recommandé hors de son titre');

  // Le profil livré doit dire pourquoi, sinon la recommandation reste opaque.
  const profil = require_('node:fs').readFileSync(path.join(ROOT, 'tools', 'photonjoin', 'profiles', 'peak.json'), 'utf8');
  if (!/PeakJoinFriend/.test(profil)) fail('le profil PEAK ne renvoie pas vers le greffon dédié');

  console.log('Sur PEAK : les deux s’appliquent, le greffon dédié reste recommandé ; ailleurs, non.');
  console.log('COEXIST OK');
  process.exit(0);
}

// --- Les deux posés dans le même jeu ----------------------------------------

sandbox = makePeakLike();
const game = { install_path: sandbox, appid: peakMod.PEAK_APPID };

const a = photonMod.install(game);
if (!a.success) fail('pose du moteur générique refusée : ' + a.error);
const b = peakMod.install(game);
if (!b.success) fail('pose du greffon dédié refusée : ' + b.error);

const plugins = path.join(sandbox, 'BepInEx', 'plugins');
if (!existsSync(path.join(plugins, 'PeakJoinFriend.dll'))) fail('le greffon dédié n’est pas à sa place');
if (!existsSync(path.join(plugins, 'PhotonJoin', 'PhotonJoin.dll'))) fail('le moteur générique n’est pas à sa place');

// Chemins distincts : c'est ce qui permet à BepInEx de charger les deux sans
// qu'aucun n'écrase le fichier de l'autre.
const top = readdirSync(plugins).sort();
if (top.join(',') !== 'PeakJoinFriend.dll,PhotonJoin') fail('contenu inattendu de plugins/ : ' + top.join(', '));

// Retirer l'un ne doit pas emporter l'autre — c'est la seule façon d'essayer le
// moteur générique sans perdre le greffon qui fonctionne.
photonMod.uninstall(game);
if (!existsSync(path.join(plugins, 'PeakJoinFriend.dll'))) fail('le retrait du moteur générique a emporté le greffon dédié');
if (existsSync(path.join(plugins, 'PhotonJoin'))) fail('le moteur générique n’a pas été retiré');

photonMod.install(game);
peakMod.uninstall(game);
if (!existsSync(path.join(plugins, 'PhotonJoin', 'PhotonJoin.dll'))) fail('le retrait du greffon dédié a emporté le moteur générique');
if (existsSync(path.join(plugins, 'PeakJoinFriend.dll'))) fail('le greffon dédié n’a pas été retiré');

// Et les identités BepInEx diffèrent, sans quoi le second chargé serait ignoré.
const { readFileSync } = require_('node:fs');
const genGuid = readFileSync(path.join(ROOT, 'tools', 'photonjoin', 'src', 'unity', 'Plugin.cs'), 'utf8').match(/Guid\s*=\s*"([^"]+)"/);
const dedGuid = readFileSync(path.join(ROOT, 'tools', 'peak-joinfriend', 'Plugin.cs'), 'utf8').match(/GUID\s*=\s*"([^"]+)"/);
if (!genGuid || !dedGuid) fail('identité BepInEx illisible dans l’un des deux greffons');
if (genGuid[1] === dedGuid[1]) fail('les deux greffons partagent le même identifiant BepInEx : un seul serait chargé');

rmSync(sandbox, { recursive: true, force: true });

console.log(`Identités distinctes : ${genGuid[1]} et ${dedGuid[1]} ; chacun se retire sans emporter l’autre.`);
console.log('COEXIST BOTH OK');
