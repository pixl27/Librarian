// Real Electron renderer, isolated fixture backend. No games or user settings
// are touched. --baseline records defects without treating them as passing QA.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const packaged = process.argv.includes('--packaged');
const target = packaged ? path.join(root, 'dist/win-unpacked/resources/app.asar') : root;
const output = path.resolve(process.env.LIBRARIAN_TEST_OUTPUT || path.join(root, 'audits/2026-09-11/ui-optimization'));
const label = baseline ? 'before' : packaged ? 'packaged' : 'after';
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-ui-')));
const report = { target, baseline, versions: process.versions, checks: [], errors: [], metrics: {}, layouts: [], scope: 'Actual renderer with mock IPC, synthetic controller input, local generated artwork. Timings exclude scanning, network and gameplay.' };
const calls = {};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const evaluate = code => win.webContents.executeJavaScript(code, true);
const check = (name, ok, actual) => { report.checks.push({ name, ok: !!ok, ...(actual === undefined ? {} : { actual }) }); };
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await wait(35);
}
async function capture(name) {
  win.webContents.invalidate(); await wait(150);
  const shot = await win.webContents.capturePage();
  if (shot.isEmpty()) throw new Error('Empty screenshot: ' + name);
  fs.writeFileSync(path.join(output, `${label}-${name}.png`), shot.toPNG());
}
async function reset() {
  await evaluate(`Librarian.closeModal(); Librarian.closeFlyout(); document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); true;`);
  await wait(250);
}
async function pad(buttons = []) {
  await evaluate(`window.__qaPad.buttons.forEach((b,i) => b.pressed = ${JSON.stringify(buttons)}.includes(i)); true;`);
  await wait(120);
}
app.whenReady().then(async () => {
  const defaults = require(path.join(target, 'src/core/settingsStore.js')).DEFAULTS;
  const settings = { ...defaults, onboarded: true, news_enabled: false, hero_rotate: false, dynamic_accent: false, ui_sounds: false, bigpicture_sounds: false, bigpicture_trailer_bg: false, bigpicture_fullscreen: false, reduce_motion: true, ui_kinetic: false, ui_tilt: false };
  const names = ['Amber Atlas', 'Beyond the Horizon', 'Cloud Gardens', 'Driftwood', 'Echoes of Tomorrow', 'Forest Tales', 'Golden Hour', 'Hidden Valley', 'Island Explorer', 'Juniper', 'Kindred Spirits', 'Lantern Quest', 'Moonrise', 'Northern Lights', 'Ocean Stories', 'Paper Trails', 'Quiet Harbor', 'Riverbound'];
  const games = names.map((game_name, i) => ({ source: 'Custom', id: 'ui-' + i, appid: '0', game_name, install_path: 'C:/ui-fixture/' + i, size_on_disk: (i + 1) * 1024 ** 3, playtime_seconds: i * 1800, last_played: i ? Date.now() - i * 86400000 : 0, launch_count: i }));
  ipcMain.on('ui-audit:fixture', e => { e.returnValue = { settings, games, apiNames: [...fs.readFileSync(path.join(target, 'preload.js'), 'utf8').matchAll(/^  (\w+):/gm)].map(m => m[1]) }; });
  ipcMain.on('ui-audit:call', (_e, name) => { calls[name] = (calls[name] || 0) + 1; });
  win = new BrowserWindow({ width: 1280, height: 800, frame: false, show: false, webPreferences: { preload: path.join(__dirname, 'ui-audit-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  win.webContents.setFrameRate(60);
  win.webContents.on('paint', () => {});
  win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  await win.loadFile(path.join(target, 'src/index.html'));
  for (let i = 0; i < 100 && !await evaluate('Boolean(window.Librarian?.state.queueReady && Librarian.games.length)'); i++) await wait(50);
  await wait(400);
  await evaluate(`window.__qaGames = Librarian.games; window.__qaFlyouts = 0; window.addEventListener('librarian:flyout', e => { if (e.detail?.open) __qaFlyouts++; }); Librarian.navigateTo('library'); true;`);
  for (const [width, height, zoom] of [[1280,800,1],[1024,600,1],[1024,600,1.25]]) {
    win.setSize(width, height); win.webContents.setZoomFactor(zoom); await wait(200);
    const layout = await evaluate(`(() => { const r=document.getElementById('lib-grid').getBoundingClientRect(); const controls=[...document.querySelectorAll('#page-library button,#lib-filter,#lib-sort')].filter(e=>!e.closest('#lib-grid')&&e.getClientRects().length); return {viewport:[innerWidth,innerHeight],gridHeight:r.height,gridTop:r.top,overflow:controls.filter(e=>{const b=e.getBoundingClientRect();return b.right>innerWidth+1||b.left<0||b.bottom>innerHeight+1}).map(e=>e.id),pageOverflow:document.documentElement.scrollWidth>innerWidth}; })()`);
    report.layouts.push({ width, height, zoom, ...layout });
    check(`Library controls fit ${width}x${height} at ${zoom * 100}%`, !layout.overflow.length && !layout.pageOverflow, layout.overflow);
    await capture(`library-${width}-${zoom * 100}`);
  }
  win.setSize(1280,800); win.webContents.setZoomFactor(1); await wait(100);
  // A no-op refresh must keep the focused tile and avoid rewriting its subtree.
  report.metrics.library = await evaluate(`(() => {
    Librarian.state.games = Array.from({length:1000},(_,i)=>({source:'Custom',id:'large-'+i,appid:'0',game_name:'Library game '+String(i).padStart(4,'0'),install_path:'C:/ui-fixture/'+i,size_on_disk:1024}));
    const start=performance.now(); Librarian.renderLibraryGrid(); const initialMs=performance.now()-start;
    const grid=document.getElementById('lib-grid'),tile=grid.querySelector('.game-tile'); tile.focus();
    const observer=new MutationObserver(()=>{});observer.observe(grid,{subtree:true,childList:true,attributes:true,characterData:true});
    const times=[];for(let i=0;i<20;i++){const t=performance.now();Librarian.renderLibraryGrid();times.push(performance.now()-t);}
    const mutations=observer.takeRecords().length;observer.disconnect();times.sort((a,b)=>a-b);
    return {games:1000,cards:grid.querySelectorAll('.game-tile').length,initialMs,refreshMedianMs:times[10],refreshMutations:mutations,keptFocus:document.activeElement===tile&&tile.isConnected};
  })()`);
  check('Large library remains bounded to 160 cards and preserves focus', report.metrics.library.cards <= 160 && report.metrics.library.keptFocus);
  check('Repeated unchanged library refreshes cause no tile mutations', report.metrics.library.refreshMutations === 0, report.metrics.library.refreshMutations);
  const pager = await evaluate(`(() => {const p=document.getElementById('lib-pagination');return !!p&&!p.hidden&&p.getBoundingClientRect().bottom<=innerHeight;})()`);
  check('Large-library page controls are reachable without scrolling through 160 covers', pager);
  if (pager) {
    await evaluate(`document.getElementById('lib-page-next').click(); true;`);
    check('Next page shows the next 160 games', await evaluate(`document.querySelector('#lib-grid .game-tile').dataset.key.includes('large-160')`));
    await evaluate(`for(let i=0;i<5;i++)document.getElementById('lib-page-next').click();true;`);
    check('Last page has 40 games and disables Next', await evaluate(`document.querySelectorAll('#lib-grid .game-tile').length===40 && document.getElementById('lib-page-next').disabled`));
    await evaluate(`Librarian.state.games=Librarian.games.slice(0,12);Librarian.renderLibraryGrid();true;`);
    check('Shrinking a library clamps the page and hides pagination', await evaluate(`document.querySelectorAll('#lib-grid .game-tile').length===12 && document.getElementById('lib-pagination').hidden`));
  }
  await evaluate(`Librarian.state.games=__qaGames; Librarian.state.favorites=['custom:ui-0']; Librarian.setLibraryView('favorites'); document.getElementById('lib-filter').value='zzzznotfound'; Librarian.renderLibraryGrid(); true;`);
  const empty = await evaluate(`document.getElementById('lib-grid').innerText`);
  check('Filtered favorites explain no matches instead of claiming no favorites exist', empty.includes('No games match'), empty);
  const clear = await evaluate(`Boolean(document.getElementById('lib-clear-filter'))`);
  if (clear) {
    await evaluate(`document.getElementById('lib-clear-filter').click(); true;`);
    check('Clear filter restores favorites and focuses the search field', await evaluate(`document.querySelectorAll('#lib-grid .game-tile').length===1 && document.activeElement.id==='lib-filter' && !document.getElementById('lib-filter').value`));
  } else check('Clear filter restores favorites and focuses the search field', false);
  await evaluate(`document.getElementById('lib-filter').value=''; Librarian.setLibraryView('all'); document.querySelector('#lib-grid .game-tile').focus(); true;`);
  await key('f', ['control']);
  check('Ctrl+F focuses the library filter', await evaluate(`document.activeElement.id==='lib-filter'`));
  await evaluate(`document.querySelector('#lib-grid .game-tile').focus(); __qaFlyouts=0; true;`);
  const launches = calls.launchGame || 0;
  await key('Enter', ['shift']); await wait(100);
  check('Shift+Enter launches exactly once without opening details', (calls.launchGame || 0) - launches === 1 && await evaluate('__qaFlyouts===0'), { launches: (calls.launchGame || 0) - launches, flyouts: await evaluate('__qaFlyouts') });
  await reset();
  await evaluate(`document.querySelector('#lib-grid .game-tile').focus();true;`);
  await key('Enter');
  check('Enter still opens details and focuses its controls', await evaluate(`document.getElementById('game-flyout').classList.contains('flyout-open') && !!document.activeElement.closest('#game-flyout')`));
  await evaluate(`window.__qaDetailGame=Librarian.state.flyoutGame;Librarian.openModal('Nested confirmation','<button id="qa-primary">Continue</button><button id="qa-last">Cancel</button>');document.getElementById('qa-last').focus();true;`);
  await key('Tab');
  check('Tab wraps inside a nested modal', await evaluate(`document.activeElement.id==='modal-close'`));
  await key('Tab', ['shift']);
  check('Shift+Tab wraps to the last modal control', await evaluate(`document.activeElement.id==='qa-last'`));
  await key('ArrowRight'); await key('p');
  check('Detail shortcuts are blocked by a nested confirmation', await evaluate('Librarian.state.flyoutGame===__qaDetailGame') && (calls.launchGame || 0) - launches === 1);
  await key('Escape');
  check('Closing the nested modal returns focus to details', await evaluate(`!!document.activeElement.closest('#game-flyout') && !document.getElementById('game-flyout').inert`));
  await reset();
  await evaluate(`Librarian.navigateTo('home'); Librarian.openModal('Fixture dialog','<button id="qa-primary">Continue</button>'); document.getElementById('qa-primary').focus(); true;`);
  await key('2');
  check('Page shortcuts do not navigate behind a dialog', await evaluate(`Librarian.state.currentPage==='home'`));
  const scans = calls.scanGames || 0;
  await key('F5'); await wait(100);
  check('F5 does not rescan behind a dialog', (calls.scanGames || 0) === scans);
  await key('k', ['control']);
  check('Command palette does not cover a pending dialog', await evaluate(`document.getElementById('palette').classList.contains('hidden')`));
  await reset();
  await evaluate(`Librarian.setLibraryView('all'); window.__qaCaller=document.querySelector('#lib-grid .game-tile'); __qaCaller.focus(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'?',bubbles:true})); true;`);
  await wait(50);
  check('Shortcut help receives focus and makes the background inert', await evaluate(`!!document.activeElement.closest('#shortcut-sheet') && document.getElementById('page-container').closest('[inert]')!==null`));
  await key('1');
  check('Shortcut help owns navigation until dismissed', await evaluate(`Librarian.state.currentPage==='library'`));
  await key('Escape');
  check('Closing shortcut help restores its caller', await evaluate('document.activeElement===__qaCaller'));
  await evaluate(`document.documentElement.classList.remove('reduce-motion');true;`);
  await key('k', ['control']); await key('Escape'); await key('k', ['control']); await wait(250);
  check('Rapidly reopening the palette survives its previous close timer', await evaluate(`!document.getElementById('palette').classList.contains('hidden') && document.activeElement.id==='palette-input'`));
  await key('Escape'); await wait(250);
  await evaluate(`document.documentElement.classList.add('reduce-motion');true;`);
  // Count actual polls after a preference update, with no physical controller.
  await evaluate(`window.__qaPolls=0; window.__qaConnected=false; window.__qaHidden=false;
    window.__qaPad={id:'Fixture controller',axes:[0,0,0,0],buttons:Array.from({length:16},()=>({pressed:false}))};
    Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>{__qaPolls++;return __qaConnected?[__qaPad]:[];}});
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>__qaHidden});
    Librarian.state.settings.gamepad_nav=true; window.dispatchEvent(new CustomEvent('librarian:prefs')); true;`);
  await wait(100); await evaluate('__qaPolls=0'); await wait(350);
  report.metrics.idleControllerPolls = await evaluate('__qaPolls');
  check('No controller polling while none is connected', report.metrics.idleControllerPolls === 0, report.metrics.idleControllerPolls);
  await evaluate(`__qaConnected=true;{const event=new Event('gamepadconnected');event.gamepad=__qaPad;window.dispatchEvent(event);} true;`); await wait(100);
  await evaluate('__qaPolls=0'); await wait(200);
  check('Connecting a controller starts navigation', await evaluate('__qaPolls>0'));
  await evaluate(`Librarian.navigateTo('home'); Librarian.openModal('Controller dialog','<button id="qa-primary">Continue</button>'); document.getElementById('qa-primary').focus(); true;`);
  const padLaunches = calls.launchGame || 0;
  await pad([5]); await pad([]);
  check('Controller shoulder buttons do not change pages behind a dialog', await evaluate(`Librarian.state.currentPage==='home'`));
  await pad([2]); await pad([]);
  check('Controller play shortcut does not launch behind a dialog', (calls.launchGame || 0) === padLaunches);
  await pad([1]); await pad([]);
  check('Controller Back dismisses the active dialog', await evaluate(`document.getElementById('modal-overlay').classList.contains('hidden')`));
  await pad([3]); await pad([]);
  await evaluate(`document.getElementById('palette-input').value='Amber Atlas';document.getElementById('palette-input').dispatchEvent(new Event('input',{bubbles:true}));true;`); await wait(100);
  await pad([0]); await pad([]);
  check('Controller A activates the selected palette result', await evaluate(`document.getElementById('game-flyout').classList.contains('flyout-open') && Librarian.state.flyoutGame?.game_name==='Amber Atlas'`));
  await pad([1]); await pad([]);
  await evaluate(`__qaHidden=true;document.dispatchEvent(new Event('visibilitychange'));__qaPolls=0;true;`); await wait(250);
  check('Hidden desktop stops polling', await evaluate('__qaPolls===0'));
  await evaluate(`__qaHidden=false;document.dispatchEvent(new Event('visibilitychange'));true;`); await wait(100);
  await evaluate('__qaPolls=0'); await wait(120);
  check('Returning to the visible desktop resumes connected input', await evaluate('__qaPolls>0'));
  await evaluate(`Librarian.state.settings.gamepad_nav=false;window.dispatchEvent(new CustomEvent('librarian:prefs'));__qaPolls=0;true;`); await wait(120);
  check('Disabling controller navigation cancels its loop', await evaluate('__qaPolls===0'));
  await evaluate(`Librarian.state.settings.gamepad_nav=true;window.dispatchEvent(new CustomEvent('librarian:prefs'));true;`); await wait(100);
  await evaluate(`__qaConnected=false;window.dispatchEvent(new Event('gamepaddisconnected'));__qaPolls=0;true;`); await wait(250);
  check('Disconnecting the last controller stops polling', await evaluate('__qaPolls===0'));
  await evaluate(`Librarian.navigateTo('library'); LibrarianBigPicture.open();true;`); await wait(200);
  check('Big Picture still opens', await evaluate('LibrarianBigPicture.isOpen'));
  await evaluate('__qaPolls=0'); await wait(150);
  check('Big Picture does not poll absent controllers', await evaluate('__qaPolls===0'));
  await capture('bigpicture');
  await evaluate(`__qaConnected=true;{const event=new Event('gamepadconnected');event.gamepad=__qaPad;window.dispatchEvent(event);}true;`); await wait(100);
  await evaluate('__qaPolls=0'); await wait(150);
  check('Connecting a controller while in Big Picture starts its input', await evaluate('__qaPolls>0'));
  await evaluate(`__qaHidden=true;document.dispatchEvent(new Event('visibilitychange'));__qaPolls=0;true;`); await wait(150);
  check('Hidden Big Picture stops input polling', await evaluate('__qaPolls===0'));
  await evaluate(`__qaHidden=false;document.dispatchEvent(new Event('visibilitychange'));true;`); await wait(100);
  await evaluate('LibrarianBigPicture.close();true;'); await wait(400);
  check('Returning from Big Picture restores desktop control', await evaluate(`!LibrarianBigPicture.isOpen && !document.documentElement.dataset.bp`));
  await evaluate('__qaPolls=0'); await wait(150);
  check('Desktop controller navigation resumes after Big Picture closes', await evaluate('__qaPolls>0'));
  await evaluate(`__qaConnected=false;window.dispatchEvent(new Event('gamepaddisconnected'));document.querySelector('#lib-view-seg [data-view="list"]').click();true;`); await wait(100);
  win.setSize(1024,600); win.webContents.setZoomFactor(1.25); await wait(150);
  check('List view stays inside the narrow viewport and exposes its selected state', await evaluate(`document.querySelector('#lib-view-seg [data-view="list"]').getAttribute('aria-pressed')==='true' && [...document.querySelectorAll('#lib-grid .game-tile')].every(e=>e.getBoundingClientRect().right<=innerWidth)`));
  await capture('library-list-1024-125');
  win.setSize(1280,800); win.webContents.setZoomFactor(1);
  await evaluate(`Librarian.navigateTo('settings'); true;`); await wait(200); await capture('settings');
  check('Achievement overlay defaults to enabled', await evaluate(`document.getElementById('chk-achievement-popups').checked`));
  await evaluate(`document.getElementById('chk-achievement-popups').click(); true;`); await wait(200);
  check('Achievement overlay can be disabled and saved', await evaluate(`Librarian.state.settings.achievement_popups === false`));
  await evaluate(`Librarian.navigateTo('library'); Librarian.navigateTo('settings'); true;`); await wait(200);
  check('Achievement overlay stays disabled when settings reopen', await evaluate(`!document.getElementById('chk-achievement-popups').checked`));
  await evaluate(`document.getElementById('chk-achievement-popups').click(); true;`); await wait(200);
  check('Achievement overlay can be enabled again', await evaluate(`Librarian.state.settings.achievement_popups === true`));
  await evaluate(`[...document.querySelectorAll('#settings-nav button')].find(b => b.textContent === 'Achievements').click(); true;`);
  await wait(250); await capture('achievement-settings');
  check('No renderer errors', report.errors.length === 0, report.errors);
}).catch(error => { report.fatal = error.stack; }).finally(() => {
  report.completedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, `${label}-ui.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ label, checks: report.checks, metrics: report.metrics, fatal: report.fatal }, null, 2));
  app.exit(report.fatal || (!baseline && report.checks.some(c => !c.ok)) ? 1 : 0);
});
setTimeout(() => { report.fatal = 'UI audit timed out'; fs.writeFileSync(path.join(output, `${label}-ui.json`), JSON.stringify(report,null,2)); app.exit(2); }, 90000).unref();
