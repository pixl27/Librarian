// Screenshot the real application, page by page, without showing a window.
//
//   electron dev/ui-shots.cjs [--only=home,library] [--out=design/shots]
//
// The production main process, preload and renderer run unmodified against a
// COPY of the user's Librarian data (settings, library cache, metadata), so
// the pictures show the real library and nothing in the real profile is
// written. Games are never launched and nothing is downloaded: the download
// view is fed synthetic progress events.
const electron = require('electron');
const { app, BrowserWindow } = electron;
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const OUT = path.resolve(root, arg('out', 'design/shots'));
const ONLY = arg('only', '').split(',').filter(Boolean);
const WIDTH = Number(arg('width', 1440));
const HEIGHT = Number(arg('height', 900));
const FOCUS_GAME = arg('game', 'Mortal Shell II');

// ── A private copy of the profile ────────────────────────────────
const realData = path.join(process.env.APPDATA || '', 'librarian');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-shots-'));
for (const name of fs.existsSync(realData) ? fs.readdirSync(realData) : []) {
  // 'Local State' holds the key that saved credentials are encrypted under;
  // without it the settings store refuses to open.
  if (!name.endsWith('.json') && name !== 'Local State') continue;
  try { fs.copyFileSync(path.join(realData, name), path.join(profile, name)); } catch {}
}
try {
  const p = path.join(profile, 'librarian-settings.json');
  const settings = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  Object.assign(settings, { onboarded: true, news_enabled: false, hero_rotate: false, notify_on_complete: false, window_maximized: false });
  fs.writeFileSync(p, JSON.stringify(settings));
} catch {}
app.setPath('userData', profile);
process.env.LIBRARIAN_NO_GOLDBERG = '1';

let win = null;
class HiddenWindow extends BrowserWindow {
  constructor(options) {
    super({
      ...options, width: WIDTH, height: HEIGHT, x: undefined, y: undefined, show: false, useContentSize: true,
      webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false },
    });
    // Only the launcher window is photographed; the achievement overlay is not.
    if (!win && !options.transparent) win = this;
    this.webContents.setFrameRate(30);
    this.webContents.on('paint', () => {});
  }
  show() {}
  focus() {}
  maximize() {}
  flashFrame() {}
}
const originalLoad = Module._load;
// A startup failure is shown in a dialog nobody can see here; print it instead.
const quietDialog = { ...electron.dialog, showErrorBox: (title, body) => console.log(`FAIL ${title}: ${body}`) };
Module._load = function (id, parent, isMain) {
  if (id === 'electron') return { ...electron, BrowserWindow: HiddenWindow, dialog: quietDialog };
  return originalLoad.call(this, id, parent, isMain);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (js) => win.webContents.executeJavaScript(`(async () => { ${js} })()`, true);
const settle = () => run(`
  await Promise.all([...document.images].filter(i => i.offsetParent !== null).map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; setTimeout(r, 4000); })));
  await new Promise(r => setTimeout(r, 500));`);

const pick = `window.Librarian.games.find(g => g.game_name === ${JSON.stringify(FOCUS_GAME)}) || window.Librarian.games[0]`;

// A believable download in flight: the same events app.js broadcasts.
const fakeDownload = `
  const L = window.Librarian;
  L.closeFlyout();
  L.navigateTo('downloads');
  const game = L.games.find(g => g.game_name === 'The Sinking City 2') || L.games[0];
  window.__shotDownload && window.__shotDownload(game);
`;

// Opens the game page unless it is already showing that game, so a tab scene
// can be captured on its own.
const openGame = `if (!document.querySelector('#game-flyout.flyout-open')) { window.Librarian.navigateTo('library'); window.Librarian.openFlyout(${pick}); await new Promise(r => setTimeout(r, 4500)); }`;

const bpKey = (key) => `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));`;

const SCENES = [
  { name: 'home', js: `window.Librarian.closeFlyout(); window.Librarian.navigateTo('home');` },
  { name: 'library', js: `window.Librarian.setLibraryView('all');` },
  { name: 'library-list', js: `window.Librarian.setLibraryView('all'); document.querySelector('#lib-view-seg [data-view="list"]')?.click();`, after: `document.querySelector('#lib-view-seg [data-view="grid"]')?.click();` },
  { name: 'game', js: `window.Librarian.navigateTo('library'); window.Librarian.openFlyout(${pick});`, wait: 5000 },
  { name: 'game-achievements', js: `${openGame} document.querySelector('.dtab[data-tab="achievements"]')?.click();` },
  { name: 'game-media', js: `${openGame} document.querySelector('.dtab[data-tab="media"]')?.click();` },
  { name: 'game-patch', js: `${openGame} document.querySelector('.dtab[data-tab="patch"]')?.click();` },
  { name: 'game-files', js: `${openGame} document.querySelector('.dtab[data-tab="files"]')?.click();` },
  { name: 'context-menu', js: `window.Librarian.closeFlyout(); window.Librarian.setLibraryView('all'); await new Promise(r => setTimeout(r, 400)); window.Librarian.showContextMenu(520, 300, ${pick});`, after: `document.body.click();` },
  { name: 'store', js: `window.Librarian.navigateTo('store');`, wait: 6000 },
  { name: 'downloads-idle', js: `window.Librarian.navigateTo('downloads');` },
  { name: 'downloads', js: fakeDownload, wait: 3500 },
  { name: 'tools', js: `window.__shotDownloadStop && window.__shotDownloadStop(); window.Librarian.navigateTo('crack');` },
  { name: 'tuning', js: `window.Librarian.navigateTo('tuning');` },
  { name: 'settings', js: `window.Librarian.navigateTo('settings');` },
  { name: 'palette', js: `window.Librarian.navigateTo('home'); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));`, after: `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));` },
  { name: 'modal-add-game', js: `window.Librarian.addCustomGame();`, after: `window.Librarian.closeModal();` },
  { name: 'modal-confirm', js: `window.Librarian.showConfirm('Uninstall Game', 'This removes Mortal Shell II and its 68.1 GB from E:\\\\Games\\\\steam. Saves kept in your user folder are not touched.', { confirmLabel: 'Uninstall' });`, after: `window.Librarian.closeModal();` },
  // Big Picture is driven with its own keys. Never Enter or P here: they launch the game.
  { name: 'bigpicture', js: `window.Librarian.closeModal(); window.LibrarianBigPicture.open();`, wait: 5000 },
  { name: 'bp-details', js: `if (!window.LibrarianBigPicture.isOpen) { window.LibrarianBigPicture.open(); await new Promise(r => setTimeout(r, 3000)); } ${bpKey('x')}`, wait: 4000, after: bpKey('Escape') },
  { name: 'bp-menu', js: `if (!window.LibrarianBigPicture.isOpen) { window.LibrarianBigPicture.open(); await new Promise(r => setTimeout(r, 3000)); } ${bpKey('m')}`, wait: 2000, after: bpKey('Escape') },
  { name: 'bp-search', js: `if (!window.LibrarianBigPicture.isOpen) { window.LibrarianBigPicture.open(); await new Promise(r => setTimeout(r, 3000)); } ${bpKey('y')}`, wait: 2500, after: bpKey('Escape') },
  { name: 'bp-grid', js: `if (!window.LibrarianBigPicture.isOpen) { window.LibrarianBigPicture.open(); await new Promise(r => setTimeout(r, 3000)); } ${bpKey('g')}`, wait: 3000, after: `${bpKey('g')} await new Promise(r => setTimeout(r, 500));` },
  { name: 'bp-close', js: `window.LibrarianBigPicture.close();`, wait: 800 },
  { name: 'toasts', js: `window.Librarian.toast('Mortal Shell II favorited', 'success'); window.Librarian.toast('Update check failed: network unreachable', 'error'); window.Librarian.toast('Checking for updates...');`, wait: 700, quick: true },

  // ── The surfaces behind a click ──
  { name: 'home-shelves', js: `window.Librarian.navigateTo('home'); await new Promise(r => setTimeout(r, 500)); const p = document.querySelector('#page-home'); const s = [p, ...p.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY !== 'visible' && getComputedStyle(e).overflowY !== 'hidden'); if (s) s.scrollTop = s.scrollHeight;` },
  { name: 'library-favorites', js: `window.Librarian.setLibraryView('favorites');` },
  { name: 'game-graphics', js: `${openGame} document.querySelector('.dtab[data-tab="graphics"]')?.click();`, wait: 2500 },
  { name: 'game-side', js: `${openGame} document.querySelector('.dtab[data-tab="overview"]')?.click(); await new Promise(r => setTimeout(r, 600)); const p = document.querySelector('#flyout-panel'); p.style.scrollBehavior = 'auto'; p.scrollTop = 420;`, wait: 1500 },
  { name: 'game-bottom', js: `${openGame} const p = document.querySelector('#flyout-panel'); p.style.scrollBehavior = 'auto'; p.scrollTop = p.scrollHeight;`, wait: 1500 },
  { name: 'lightbox', js: `${openGame} document.querySelector('.dtab[data-tab="media"]')?.click(); await new Promise(r => setTimeout(r, 1500)); document.querySelector('#game-flyout .shot')?.click();`, wait: 2500, after: `document.querySelector('#lightbox')?.click();` },
  { name: 'collection-picker', js: `window.Librarian.closeFlyout(); window.Librarian.setLibraryView('all'); window.Librarian.showCollectionPicker(${pick});`, after: `window.Librarian.closeModal();` },
  { name: 'exe-picker', js: `window.Librarian.showContextMenu(520, 300, ${pick}); await new Promise(r => setTimeout(r, 300)); [...document.querySelectorAll('.ctx-item')].find(b => /executable/i.test(b.textContent))?.click();`, wait: 2500, after: `window.Librarian.closeModal();` },
  { name: 'plan', js: `const g = ${pick}; const ids = ['2584271', '2584272', '2584273', '2584274', '2584275'];
      window.Librarian.showInstallSheet({ game_name: g.game_name, appid: String(g.appid),
        depots: { 2584271: { size: 61.3e9, desc: g.game_name + ' Content' }, 2584272: { size: 3.4e9, desc: 'French', tags: [{ type: 'lang', label: 'French' }] },
          2584273: { size: 3.2e9, desc: 'German', tags: [{ type: 'lang', label: 'German' }] }, 2584274: { size: 2.9e9, desc: 'Japanese', tags: [{ type: 'lang', label: 'Japanese' }] },
          2584275: { size: 9.8e9, desc: '4K Texture Pack' } },
        manifests: Object.fromEntries(ids.map(i => [i, '1'])) });`, wait: 2500, after: `document.querySelector('#plan-cancel, #plan-close, #plan [data-act="cancel"]')?.click(); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));` },
  { name: 'news', js: `window.Librarian.openNews();`, wait: 2500, after: `window.Librarian.closeModal();` },
  { name: 'shortcuts', js: `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));`, after: `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));` },
  { name: 'onboarding', js: `window.Librarian.navigateTo('home'); document.getElementById('onboard').classList.remove('hidden');`, after: `document.getElementById('onboard').classList.add('hidden');` },
  { name: 'tour', js: `window.Librarian.navigateTo('settings'); document.getElementById('btn-replay-tour').click();`, wait: 2500 },
  { name: 'tour-library', js: `for (let i = 0; i < 6; i++) { document.getElementById('tour-next')?.click(); await new Promise(r => setTimeout(r, 700)); }`, wait: 1500, after: `document.getElementById('tour-skip')?.click(); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));` },
  { name: 'store-search', js: `window.Librarian.searchStore('control');`, wait: 7000 },
  { name: 'store-detail', js: `document.querySelector('.store-results .sf-card, .store-results .sf-lead, .store-results [data-appid]')?.click();`, wait: 7000 },
  ...Array.from({ length: 11 }, (_, i) => ({
    name: `settings-${i + 1}`,
    js: `window.Librarian.navigateTo('settings'); await new Promise(r => setTimeout(r, 300)); document.querySelector('.settings-panel').style.scrollBehavior = 'auto'; document.querySelectorAll('#settings-nav button')[${i}]?.click();`,
  })),
];

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // Wait for main.js to create the launcher window and for the first render.
  for (let i = 0; i < 200 && !win; i++) await sleep(50);
  if (!win) { console.error('FAIL the launcher window was never created'); app.exit(1); return; }
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });
  await new Promise((resolve) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', resolve) : resolve()));
  for (let i = 0; i < 120; i++) {
    const ready = await win.webContents.executeJavaScript('Boolean(window.Librarian && window.Librarian.games && window.Librarian.games.length)').catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  await sleep(2500);

  // Lets a scene put the download view in motion without a real job.
  await run(`
    let timer = null;
    window.__shotDownload = (game) => {
      const others = window.Librarian.games.filter(g => g !== game).slice(0, 2);
      const startedAt = Date.now() - 1268000;
      const state = window.Librarian.state;
      state.speedHistory = Array.from({ length: 60 }, (_, i) => 7.5e6 + Math.sin(i / 5) * 2.2e6 + ((i * 37) % 11) * 2.4e5 - (i > 38 && i < 44 ? 3e6 : 0));
      const emitState = (pct, speed) => {
        window.dispatchEvent(new CustomEvent('librarian:download', { detail: {
          active: true, paused: false, name: game.game_name, appid: String(game.appid), percent: pct, speed, diskSpeed: '10.6 MB/s',
          eta: '14m 02s', sizeText: '28.4 GB / 45.9 GB', jobType: 'download', dest: 'E:\\\\Games\\\\steam',
          totalBytes: 45.9 * 1073741824, startedAt, csrinExtract: false, csrinPhase: '',
          upNext: others.map(g => ({ name: g.game_name, appid: String(g.appid) })),
        } }));
        window.dispatchEvent(new CustomEvent('librarian:redraw'));
      };
      let pct = 61.4;
      emitState(pct, '9.4 MB/s');
      timer = setInterval(() => { pct += 0.05; emitState(pct, (9 + Math.random()).toFixed(1) + ' MB/s'); }, 400);
    };
    window.__shotDownloadStop = () => { clearInterval(timer); window.dispatchEvent(new CustomEvent('librarian:download', { detail: { active: false } })); };
  `);

  // --probe=file.js runs that script in the page instead of taking pictures
  // and prints what it returns: a way to measure the live renderer.
  const probe = arg('probe', '');
  if (probe) {
    try { console.log(JSON.stringify(await run(fs.readFileSync(path.resolve(probe), 'utf8')), null, 1)); }
    catch (err) { console.log('FAIL probe', err.message); }
    // --probe-shot=name also photographs whatever the probe left on screen.
    const probeShot = arg('probe-shot', '');
    if (probeShot) { await sleep(600); fs.writeFileSync(path.join(OUT, `${probeShot}.png`), (await win.webContents.capturePage()).toPNG()); }
    if (errors.length) console.log('renderer errors:\n' + [...new Set(errors)].slice(0, 20).join('\n'));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    app.exit(0);
    return;
  }

  for (const scene of SCENES) {
    if (ONLY.length && !ONLY.includes(scene.name)) continue;
    try {
      await run(scene.js);
      await sleep(scene.wait || 1200);
      // A toast is gone before slow artwork would settle.
      if (!scene.quick) await settle();
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, `${scene.name}.png`), image.toPNG());
      console.log('shot', scene.name);
      if (scene.after) { await run(scene.after); await sleep(300); }
    } catch (err) {
      console.log('FAIL', scene.name, err.message);
    }
  }
  if (errors.length) console.log('renderer errors:\n' + [...new Set(errors)].slice(0, 20).join('\n'));
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  app.exit(0);
});

require(path.join(root, 'main.js'));
