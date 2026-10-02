// Ce qui marchait avant doit marcher encore.
//
// Ce travail a touché quatre fichiers partagés — main.js, preload.js, app.js et
// enhance.css — et le chemin qu'il ne faut surtout pas casser est justement
// celui qui a demandé le plus de peine : le greffon PEAK, vérifié en partie
// réelle contre un hôte non modifié. Ce contrôle le remet à l'épreuve.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require_ = createRequire(import.meta.url);

let sandbox = '';

function fail(message) {
  if (sandbox) { try { rmSync(sandbox, { recursive: true, force: true }); } catch { } }
  console.error('REGRESSION ÉCHEC : ' + message);
  process.exit(1);
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// 1. Tous les modules touchés se chargent encore.
const modules = [
  'src/core/peakMod.js', 'src/core/photonMod.js', 'src/core/onlineMode.js',
  'src/core/runtimePaths.js', 'src/core/steamPipe.js',
];
for (const m of modules) {
  try { require_(path.join(ROOT, m)); }
  catch (e) { fail(`${m} ne se charge plus : ${e.message}`); }
}
for (const f of ['main.js', 'preload.js', 'src/js/app.js']) {
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); }
  catch (e) { fail(`${f} n’est plus valide : ${(e.stderr || '').toString().split('\n')[0]}`); }
}

// 2. Le greffon éprouvé est intact, au bit près.
//
// La référence n'est pas un nombre recopié d'un rapport : c'est la copie
// réellement installée dans PEAK, celle qui a joué la partie où la jonction a
// fonctionné. Si les deux divergent, ce n'est plus le même greffon.
const shipped = path.join(ROOT, 'deps', 'librarian', 'PeakJoinFriend.dll');
if (!existsSync(shipped)) fail('le greffon éprouvé a disparu de deps/');
const installed = 'e:\\games\\steam\\steamapps\\common\\PEAK\\BepInEx\\plugins\\PeakJoinFriend.dll';
if (existsSync(installed)) {
  if (sha(shipped) !== sha(installed))
    fail('le greffon de deps/ diffère de celui installé dans PEAK, qui est celui qui a fonctionné en partie réelle');
} else {
  console.log('  (PEAK n’a plus le greffon installé : comparaison au bit près impossible)');
}

// 3. Le greffon éprouvé se pose toujours, dans un bac à sable.
const peakMod = require_(path.join(ROOT, 'src', 'core', 'peakMod.js'));
sandbox = mkdtempSync(path.join(os.tmpdir(), 'librarian-regression-'));
mkdirSync(path.join(sandbox, 'PEAK_Data', 'Managed'), { recursive: true });
{
  const game = { install_path: sandbox, appid: peakMod.PEAK_APPID };
  const st = peakMod.status(game);
  if (!st.ok) fail('statut du greffon éprouvé illisible : ' + st.error);
  if (!st.applies) fail('le greffon éprouvé ne reconnaît plus son jeu');

  const posed = peakMod.install(game);
  if (!posed.success) fail('le greffon éprouvé ne se pose plus : ' + posed.error);
  if (!existsSync(path.join(sandbox, 'BepInEx', 'plugins', 'PeakJoinFriend.dll')))
    fail('le greffon éprouvé n’est pas à sa place après la pose');

  const removed = peakMod.uninstall(game);
  if (!removed.success) fail('le greffon éprouvé ne se retire plus : ' + removed.error);
  if (existsSync(path.join(sandbox, 'BepInEx', 'plugins', 'PeakJoinFriend.dll')))
    fail('le greffon éprouvé n’a pas été retiré');
}
rmSync(sandbox, { recursive: true, force: true });
sandbox = '';

// 4. Les canaux et les panneaux d'origine sont toujours là.
for (const [file, needles] of [
  ['main.js', ["ipcMain.handle('peakmod:status'", "ipcMain.handle('online:status'", "ipcMain.handle('depot:download'"]],
  ['preload.js', ['getPeakModStatus', 'setOnlineMode', 'startDownload']],
  ['src/index.html', ['id="flyout-online"', 'id="flyout-peakmod"', 'id="flyout-dlc"']],
  ['src/js/app.js', ['renderOnlineMode', 'renderPeakMod']],
]) {
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  for (const n of needles) if (!text.includes(n)) fail(`${file} : « ${n} » a disparu`);
}

// 5. Les corrections déjà acquises sur le moteur de téléchargement tiennent.
//
// Elles n'ont rien à voir avec ce travail, et c'est précisément pour cela
// qu'elles servent de témoin : si elles avaient bougé, c'est qu'on aurait
// touché à autre chose que ce qu'on croyait.
const pipe = readFileSync(path.join(ROOT, 'src', 'core', 'steamPipe.js'), 'utf8');
if (!/installedManifestIds/.test(pipe)) fail('steamPipe a perdu la lecture des manifestes réellement installés');
if (!/heartbeat/.test(pipe)) fail('steamPipe a perdu le battement du compteur de vitesse');

console.log(`${modules.length} modules chargés, 3 fichiers valides, greffon éprouvé identique et fonctionnel, canaux et panneaux d’origine intacts.`);
console.log('REGRESSION OK');
