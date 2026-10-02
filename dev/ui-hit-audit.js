// Page script for dev/ui-shots.cjs --probe: on each screen, every visible
// control must be the thing a click at its centre would land on.
//
//   electron dev/ui-shots.cjs --probe=dev/ui-hit-audit.js
//
// A control that works when triggered from code can still be dead under the
// mouse: the top strip is a window-drag region laid over the pages, and it
// swallowed Back on the game page and on a store page. Nothing that clicks
// through the DOM notices that, so this asks the hit test directly.
const L = window.Librarian;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const label = (e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.classList[0] ? '.' + e.classList[0] : ''}`;

function covered() {
  const out = [];
  const controls = document.querySelectorAll('button, a[href], input, select, textarea, [role="switch"], [role="tab"], .game-tile, .sf-card');
  for (const el of controls) {
    if (el.disabled || el.closest('[inert]') || el.closest('#bp-root')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.pointerEvents === 'none' || Number(style.opacity) < 0.05) continue;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
    // Scrolled out of its own scroller: not on screen, so not a finding.
    let clipped = false;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY;
      if (o === 'visible') continue;
      const b = p.getBoundingClientRect();
      if (y < b.top || y > b.bottom || x < b.left || x > b.right) { clipped = true; break; }
    }
    if (clipped) continue;
    const top = document.elementFromPoint(x, y);
    if (!top || top === el || el.contains(top) || top.contains(el)) continue;
    // A checkbox hidden behind its drawn switch, or an input inside its label.
    if (top.closest('label')?.contains(el)) continue;
    // A toast is there for a few seconds; content scrolled up behind the top
    // strip is out of reach on purpose.
    if (top.closest('#toast-stack')) continue;
    const scroller = el.closest('#flyout-panel, #home-scroll, #sd-scroll');
    if (scroller && scroller.scrollTop > 0 && y < 64) continue;
    out.push(`${label(el)} at ${Math.round(x)},${Math.round(y)} is under ${label(top)}`);
  }
  return out;
}

const game = L.games.find((g) => g.game_name === 'Mortal Shell II') || L.games[0];
const screens = [
  ['home', async () => { L.closeFlyout(); L.navigateTo('home'); }],
  ['library', async () => { L.setLibraryView('all'); }],
  ['game page', async () => { L.navigateTo('library'); L.openFlyout(game); await wait(3000); }],
  ['game page, scrolled', async () => { const p = document.querySelector('#flyout-panel'); p.style.scrollBehavior = 'auto'; p.scrollTop = 420; }],
  ['store', async () => { L.closeFlyout(); L.navigateTo('store'); await wait(4000); }],
  ['store results', async () => { L.searchStore('control'); await wait(6000); }],
  ['store page', async () => { document.querySelector('.store-results .sf-card, .store-results .sf-lead, .store-results [data-appid]')?.click(); await wait(5000); }],
  ['downloads', async () => { L.navigateTo('downloads'); }],
  ['tools', async () => { L.navigateTo('crack'); }],
  ['tuning', async () => { L.navigateTo('tuning'); }],
  ['settings', async () => { L.navigateTo('settings'); }],
];
const report = {};
for (const [name, go] of screens) {
  await go();
  await wait(900);
  report[name] = covered();
}
return { findings: Object.values(report).reduce((n, a) => n + a.length, 0), report };
