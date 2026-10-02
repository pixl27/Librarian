// ═══════════════════════════════════════════════════════════════════
// Librarian — kinetic layer
//
// The behaviour half of styles/kinetic.css. Like js/enhance.js it is purely
// additive: it reads the app through the window.Librarian bridge and the
// librarian:* events, writes nothing but custom properties and short-lived
// classes, and every entry point is wrapped so a failure in here cannot take
// the launcher down.
//
//   · Cascade indices      stamps --k-i so lists deal in one item at a time
//   · Impact bursts        the ring a click leaves at the pointer
//   · Value reactions      readouts flinch when their number changes
//   · Count-ups            the sidebar ledger counts to its total
//   · Replays              the hero re-runs its entrance when it rotates
//
// ── The one hard rule ──────────────────────────────────────────────
// A hidden renderer stops being served animation frames. An entrance that
// fills `backwards` or `both` would then hold its first keyframe — which is
// transparent — for as long as the window stayed hidden, and the interface
// would come back blank. So the whole layer switches itself off while the
// document is hidden: with data-kinetic gone, every rule in kinetic.css is
// inert and the interface renders at its own resting state. Nothing in this
// file may ever be the only thing standing between content and the screen.
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const root = document.documentElement;
  const $ = (s, r = document) => r.querySelector(s);

  const app = () => window.Librarian || null;
  const prefs = () => app()?.settings || {};

  function safely(label, fn) {
    try { return fn(); } catch (e) { console.error(`[kinetic] ${label} failed:`, e); return null; }
  }

  const reduceMotion = () => root.classList.contains('reduce-motion')
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Undefined counts as on: a settings file written before this existed
   *  should still get the animations, not silently opt out of them. */
  const wanted = () => prefs().ui_kinetic !== false && !reduceMotion();

  /** Frames stop arriving to a hidden renderer; see the header note. */
  const hidden = () => document.visibilityState === 'hidden';

  const on = () => root.dataset.kinetic === 'on';

  function sync() {
    if (wanted() && !hidden()) root.dataset.kinetic = 'on';
    else delete root.dataset.kinetic;
  }

  /**
   * Restart an animation that is already running.
   *
   * Changing a class alone does nothing when the animation-name does not
   * change; the reflow between the two writes is what makes the engine treat
   * it as a new animation. offsetWidth is read rather than rAF because a
   * hidden renderer never delivers the frame.
   */
  function replay(el) {
    if (!el) return;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  }

  // ════════════════════════════════════════════════════════════════
  // Cascade indices
  //
  // kinetic.css derives every stagger delay from --k-i. Stamping it from
  // here rather than from each renderer means app.js and bigpicture.js stay
  // unaware of the effect, and a list that starts being rendered somewhere
  // new only has to be added to the table below.
  //
  // Containers are observed individually rather than watching the whole
  // document: these lists are rebuilt by innerHTML assignment, so childList
  // on the container is exactly the signal, and a library of two hundred
  // tiles never enters the picture.
  // ════════════════════════════════════════════════════════════════
  const CASCADES = [
    // ── Desktop ──────────────────────────────────────────────────
    ['#palette-list', '.cmd-item'],
    ['#context-menu', '.ctx-item'],
    ['#search-recent', '.store-chip'],
    ['#plan-legend', ':scope > *'],
    ['#plan-groups', ':scope > *'],
    ['#shortcut-grid', ':scope > *'],
    ['#install-locations', ':scope > *'],
    ['#crack-scan-results', ':scope > *'],
    ['#settings-nav', 'button'],

    // ── Store ────────────────────────────────────────────────────
    // Built once when the front page loads and once per store page, never
    // on a tick, so an entrance here plays exactly as many times as it
    // should.
    ['#sf-rails', '.sf-rail'],
    ['#sd-facts', '.sd-fact'],
    ['#sd-tag-list', '.sd-tag'],
    ['#sd-depot-list', '.sd-depot'],
    ['#sd-strip', '.sd-shot'],
    ['#page-settings .settings-panel', '.settings-section'],
    ['#page-tuning .settings-panel', '.settings-section'],
    ['#tn-tiles', '.tn-tile'],
    ['#onboard-steps', '.ob-step'],

    // ── Big Picture ──────────────────────────────────────────────
    ['#bp-rail-list', '.bp-rail-item'],
    ['#bp-menu-rows', '.bp-row'],
    ['#bp-system-rows', '.bp-row'],
    ['#bp-filter-rows', '.bp-row'],
    ['#bp-det-actions', '.bp-act'],
    ['#bp-det-shots', '.bp-shot'],
    ['#bp-det-tags', ':scope > *'],
    ['#bp-keys', '.bp-key'],
    ['#bp-results', '.bp-card'],
    ['#bp-meta', '.bp-pill'],
    ['#bp-ach-list', ':scope > *'],
    ['#bp-news-list', ':scope > *'],
    ['#bp-det-news .bp-detnews-list', ':scope > *'],
    ['#bp-empty-actions', ':scope > *'],
    ['#bp-sf-meta', '.bp-sf-pill'],
    ['#bp-store-tags', '.bp-store-tag'],
    ['#bp-store-shots', 'img'],
    // The shelf and the grid are deliberately absent. bigpicture.js already
    // staggers their cards with its own --d, and custom properties inherit:
    // stamping --k-i on a cover would hand that index down to the flags
    // inside it, delaying a card badge by however far along the shelf its
    // card happened to sit.
  ];

  /**
   * Containers there are many of, each of which stamps its own children.
   *
   * The single-container table above takes the first match; a store front has
   * six shelves and Big Picture has as many again, and every one of them has
   * to count from zero. It matters more than it looks: --k-i is a custom
   * property and custom properties inherit, so a shelf stamped with its own
   * index would hand that number down to every cover inside it and the whole
   * row would deal in on one beat, late.
   */
  const MULTI = [
    ['.sf-rail-scroll', '.sf-card'],
    ['#bp-sf-rails .bp-sf-strip', '.bp-sf-card'],
  ];

  /* Past this the cascade has hit its ceiling in CSS anyway, so stamping
     further indices would be pure cost. */
  const INDEX_LIMIT = 64;

  function stamp(container, selector) {
    if (!container) return;
    let i = 0;
    for (const el of container.querySelectorAll(selector)) {
      if (i >= INDEX_LIMIT) break;
      const value = String(i++);
      if (el.style.getPropertyValue('--k-i') !== value) el.style.setProperty('--k-i', value);
    }
  }

  const watched = new WeakSet();

  function watch(container, childSel) {
    if (watched.has(container)) return;
    watched.add(container);
    stamp(container, childSel);
    new MutationObserver(() => safely('stamp', () => stamp(container, childSel)))
      .observe(container, { childList: true });
  }

  function attachCascades() {
    if (typeof MutationObserver !== 'function') return;
    for (const [containerSel, childSel] of CASCADES) {
      const container = $(containerSel);
      if (container) watch(container, childSel);
    }
    for (const [containerSel, childSel] of MULTI) {
      for (const container of document.querySelectorAll(containerSel)) watch(container, childSel);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // Impact bursts
  //
  // A ring expanding from the pointer. Capped, because a held mouse button
  // on a repeating control would otherwise leave a trail of live nodes.
  // ════════════════════════════════════════════════════════════════
  const BURST_TARGETS = [
    '.xbox-btn', '.tour-btn', '.nav-tab', '.sidebar-link', '.seg button',
    '.store-chip', '.cmd-item', '.ctx-item', '.dtab', '.row-see-all',
    '.toggle-row', '#settings-nav button', '.queue-card-remove',
    '.tile-play-btn', '.tile-fav-btn', '.result-card-add', '#dl-hud',
    '.collection-link', '#window-controls button',
  ].join(',');

  const MAX_BURSTS = 5;
  let live = 0;

  function burst(x, y, source) {
    if (!on() || live >= MAX_BURSTS) return;
    const ring = document.createElement('div');
    ring.className = 'k-burst';

    // Sized from what was clicked, so a title-bar button gets a small ring
    // and a hero button gets one that reaches its own corners.
    const rect = source?.getBoundingClientRect?.();
    const size = rect
      ? Math.min(260, Math.max(64, Math.hypot(rect.width, rect.height) * 1.15))
      : 120;
    ring.style.setProperty('--k-burst-size', `${Math.round(size)}px`);
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;

    live++;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(cleanup);
      ring.remove();
      live = Math.max(0, live - 1);
    };
    ring.addEventListener('animationend', done, { once: true });
    // Same reasoning as the wipe: animationend is not guaranteed to arrive.
    const cleanup = setTimeout(done, 900);
    document.body.appendChild(ring);
  }

  function setupBursts() {
    document.addEventListener('pointerdown', (e) => {
      if (!on() || e.button !== 0) return;
      const target = e.target.closest?.(BURST_TARGETS);
      if (target) safely('burst', () => burst(e.clientX, e.clientY, target));
    }, { passive: true, capture: true });
  }

  // ════════════════════════════════════════════════════════════════
  // Value reactions
  //
  // A readout flinches when its number changes — but only where the change is
  // news. Nothing on a download or an update screen qualifies: those numbers
  // are rewritten about once a second for the length of the job, and a figure
  // that bounces every second is not feedback, it is a twitch you cannot look
  // away from. They keep tabular-nums, and the progress bars carry the motion
  // instead.
  //
  // What is left changes only when the user made it change: the ledger after
  // a rescan, the install plan as depots are toggled.
  // ════════════════════════════════════════════════════════════════
  const POP_TARGETS = [
    '#plan-size-num', '#plan-size',
    '#ledger-games', '#ledger-hours', '#ledger-size',
  ];

  function popOnChange(el) {
    if (!el || typeof MutationObserver !== 'function' || el.dataset.kPop) return;
    el.dataset.kPop = '1';
    let last = el.textContent;
    let cooling = 0;

    new MutationObserver(() => safely('pop', () => {
      const now = el.textContent;
      if (now === last) return;
      last = now;
      if (!on()) return;
      // A count-up rewrites the text thirty times on its way to the total.
      // Reacting to each of those would fight the animation that is the
      // reaction. The final value is the only one worth flinching at.
      if (el.dataset.kCounting) return;
      // One reaction per beat: several observers can fire for a single
      // textContent write (the old node out, the new node in).
      const stamp = Date.now();
      if (stamp - cooling < 220) return;
      cooling = stamp;
      el.classList.remove('k-roll');
      void el.offsetWidth;
      el.classList.add('k-roll');
      setTimeout(() => el.classList.remove('k-roll'), 400);
    })).observe(el, { childList: true, characterData: true, subtree: true });
  }

  function setupPops() {
    POP_TARGETS.forEach((sel) => popOnChange($(sel)));
  }

  // ════════════════════════════════════════════════════════════════
  // Search busy state
  //
  // app.js announces nothing when a store search starts, but it does put
  // skeletons on screen for exactly as long as one is in flight. Reading
  // the DOM it already maintains is cheaper than a new event and cannot
  // fall out of step with it.
  // ════════════════════════════════════════════════════════════════
  function setupSearchBusy() {
    const results = $('#search-results');
    const page = $('#page-store');
    if (!results || !page || typeof MutationObserver !== 'function') return;

    const paint = () => {
      const busy = !!results.querySelector('.result-skeleton');
      if (busy) page.dataset.busy = '1';
      else delete page.dataset.busy;
    };
    new MutationObserver(() => safely('busy', paint)).observe(results, { childList: true });
    paint();
  }

  // ════════════════════════════════════════════════════════════════
  // Count-ups
  //
  // The ledger counts to its total rather than snapping to it. Driven by
  // setInterval, not requestAnimationFrame, and backed by a timer that
  // writes the final value no matter what: if frames stop arriving halfway
  // the number must still end up correct, not frozen at 43 of 128.
  // ════════════════════════════════════════════════════════════════
  const NUMBER = /^(\D*?)([\d.,]+)(.*)$/s;

  function countUp(el, duration = 620) {
    if (!el || !on()) return;
    const target = el.textContent;
    const match = NUMBER.exec(target);
    if (!match) return;

    const [, prefix, digits, suffix] = match;
    const end = Number(digits.replace(/,/g, ''));
    if (!Number.isFinite(end) || end <= 0) return;

    const decimals = (digits.split('.')[1] || '').length;
    // Keep the thousands separators the formatter used, or the number would
    // gain a comma on its very last frame and shove the label sideways.
    const grouped = digits.includes(',');
    const format = (n) => (grouped
      ? n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
      : n.toFixed(decimals));

    const start = Date.now();
    let tick = 0;

    const finish = () => {
      clearInterval(tick);
      // Whatever happened, the element ends holding exactly what the app
      // asked it to hold.
      if (el.textContent !== target) el.textContent = target;
      delete el.dataset.kCounting;
    };

    const step = () => {
      const t = Math.min(1, (Date.now() - start) / duration);
      // Ease out: fast at the top, so the last few units read as settling.
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = `${prefix}${format(end * eased)}${suffix}`;
      if (t >= 1) finish();
    };

    el.dataset.kCounting = '1';
    tick = setInterval(() => safely('count', step), 32);
    setTimeout(finish, duration + 120);
  }

  function runLedger() {
    if (!on()) return;
    ['#ledger-games', '#ledger-hours', '#ledger-size'].forEach((sel) => {
      const el = $(sel);
      if (el && !el.dataset.kCounting) safely('ledger', () => countUp(el));
    });
  }

  // ════════════════════════════════════════════════════════════════
  // Wiring
  // ════════════════════════════════════════════════════════════════
  function init() {
    sync();

    safely('cascades', attachCascades);
    safely('bursts', setupBursts);
    safely('pops', setupPops);
    safely('search-busy', setupSearchBusy);

    // Body childList catches whole subtrees arriving at once — Big Picture
    // builds its entire DOM on first open, and the containers listed above
    // do not exist until it does. Debounced, because bursts and toasts are
    // appended to the body too and re-scanning on every click is waste.
    if (typeof MutationObserver === 'function') {
      let pending = null;
      new MutationObserver(() => {
        clearTimeout(pending);
        pending = setTimeout(() => safely('reattach', attachCascades), 80);
      }).observe(document.body, { childList: true });
    }

    // ── The visibility switch ────────────────────────────────────
    // The single reason kinetic.css can be trusted with `backwards` fills.
    document.addEventListener('visibilitychange', () => safely('visibility', sync));

    // reduce-motion is toggled by writing a class on <html>, and not every
    // path that writes it announces itself — the command palette flips the
    // class and refreshes settings without emitting anything. Watching the
    // attribute catches all of them, including the checkbox in Settings.
    if (typeof MutationObserver === 'function') {
      new MutationObserver(() => safely('reduce-motion', sync))
        .observe(root, { attributes: true, attributeFilter: ['class'] });
    }
    window.matchMedia('(prefers-reduced-motion: reduce)')
      .addEventListener?.('change', () => safely('media', sync));

    // ── App events ───────────────────────────────────────────────
    window.addEventListener('librarian:page', () => safely('page', () => {
      attachCascades();
      setupPops();
    }));


    window.addEventListener('librarian:ready', () => safely('ready', () => {
      attachCascades();
      setupPops();
      runLedger();
    }));

    window.addEventListener('librarian:games', () => safely('games', () => {
      // renderLedger writes the totals as part of the same turn that emits
      // this; counting from the value already on screen would animate from
      // the answer to the answer. One turn later it is safely the new total.
      setTimeout(runLedger, 0);
    }));

    window.addEventListener('librarian:rendered', () => safely('rendered', attachCascades));

    // A store front replaces every shelf at once, so the per-shelf strips are
    // new elements and have to be picked up again.
    const rails = $('#sf-rails');
    if (rails && typeof MutationObserver === 'function') {
      new MutationObserver(() => safely('store-rails', attachCascades))
        .observe(rails, { childList: true });
    }
    window.addEventListener('librarian:queue', () => safely('queue', attachCascades));
    window.addEventListener('librarian:collections', () => safely('collections', attachCascades));

    // The hero rotates in place, so its entrance has to be re-armed by hand
    // — nothing about the DOM changes enough for the engine to notice.
    window.addEventListener('librarian:hero', () => safely('hero', () => {
      if (!on()) return;
      ['#hero-badge', '#hero-title', '#hero-subtitle'].forEach((sel) => replay($(sel)));
    }));

    window.addEventListener('librarian:bigpicture', (e) => safely('bigpicture', () => {
      attachCascades();
      setupPops();
      if (e.detail?.open) setTimeout(attachCascades, 200);
    }));

    window.addEventListener('librarian:prefs', () => safely('prefs', () => {
      sync();
      attachCascades();
    }));
  }

  // The attribute goes on the moment this file is evaluated — at the end of
  // <body>, so before the first paint — rather than waiting for DOMContentLoaded.
  // The shell is already parsed by then, and the page that is active in the
  // markup would otherwise miss its own entrance by a turn.
  safely('early-sync', sync);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
