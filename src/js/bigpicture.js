// ═══════════════════════════════════════════════════════════════════
// Librarian — Big Picture
//
// A couch front-end: full-bleed hero art, a narrow icon rail, a pinned-left
// cover carousel (or a grid), a details view with the game's trailer, an
// on-screen keyboard for search, and a button-hint bar. Modelled on the
// Playnite "Modern UI" fullscreen theme.
//
// Like js/enhance.js this is purely additive. It reads the app through the
// window.Librarian bridge and the librarian:* events, owns its own DOM under
// #bp-root, and every entry point is wrapped so a failure in here can never
// take the launcher down.
//
//   Controller     stick/d-pad move · A play · B back · X details · Y search
//                  View options · Menu system · LB/RB group · LT layout · RT filter
//   Keyboard       arrows move · Enter play · Esc back · X details · Y or / search
//                  M options · F filter · G layout · Ctrl+Shift+B toggle
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const bridge = () => window.Librarian || null;
  const prefs = () => bridge()?.settings || {};
  const api = () => window.api || null;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function safely(label, fn) {
    try { return fn(); } catch (e) { console.error(`[bigpicture] ${label} failed:`, e); return null; }
  }

  /** Frames stop arriving to a hidden renderer, so transitions must never gate logic. */
  const framesStalled = () => document.visibilityState === 'hidden';

  const motionOff = () => prefs().reduce_motion === true
    || document.documentElement.classList.contains('reduce-motion')
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ════════════════════════════════════════════════════════════════
  // Icons
  // ════════════════════════════════════════════════════════════════
  const ICON = {
    grid: 'M3 3h6v6H3V3zm8 0h6v6h-6V3zM3 11h6v6H3v-6zm8 0h6v6h-6v-6z',
    heart: 'M10 17.5l-1.2-1.1C4.7 12.7 2 10.3 2 7.3 2 5 3.9 3.2 6.2 3.2c1.3 0 2.6.6 3.8 2 1.2-1.4 2.5-2 3.8-2C16.1 3.2 18 5 18 7.3c0 3-2.7 5.4-6.8 9.1L10 17.5z',
    clock: 'M10 2a8 8 0 100 16 8 8 0 000-16zm1 4a1 1 0 10-2 0v4.2l3 1.8a1 1 0 001-1.7L11 9.4V6z',
    spark: 'M10 2l1.7 4.9L17 8.5l-4.4 3 .4 5.5-3-2.6-3 2.6.4-5.5L3 8.5l5.3-1.6L10 2z',
    download: 'M10 3a1 1 0 011 1v6.6l2.3-2.3a1 1 0 011.4 1.4l-4 4a1 1 0 01-1.4 0l-4-4a1 1 0 011.4-1.4L9 10.6V4a1 1 0 011-1zM4 16a1 1 0 011-1h10a1 1 0 010 2H5a1 1 0 01-1-1z',
    steam: 'M10 2a8 8 0 00-8 7.7l4.3 1.8a2.3 2.3 0 011.3-.4l1.9-2.8v-.1a3 3 0 116 0 3 3 0 01-3.1 3H12l-2.7 2a2.3 2.3 0 11-4.5.5L2 12.6A8 8 0 1010 2zm3.4 3.6a2 2 0 100 4 2 2 0 000-4zm0 .6a1.4 1.4 0 110 2.9 1.4 1.4 0 010-2.9z',
    disc: 'M10 2a8 8 0 100 16 8 8 0 000-16zm0 5.6a2.4 2.4 0 100 4.8 2.4 2.4 0 000-4.8z',
    folder: 'M3 5a2 2 0 012-2h3.2l1.6 2H15a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2V5z',
    news: 'M4 3h9a1 1 0 011 1v11a2 2 0 002 2H5a2 2 0 01-2-2V4a1 1 0 011-1zm2 3h5v2H6V6zm0 4h5v1.5H6V10zm0 3h5v1.5H6V13zM15 7h1a1 1 0 011 1v7a1 1 0 01-2 0V7z',
    trophy: 'M6 3h8v1h3v3a3 3 0 01-3 3h-.4A4 4 0 0111 12.9V15h2a1 1 0 010 2H7a1 1 0 010-2h2v-2.1A4 4 0 016.4 10H6a3 3 0 01-3-3V4h3V3zm0 3H5v1a1 1 0 001 1V6zm9 0v2a1 1 0 001-1V6h-1z',
    pad: 'M6.5 6h7A4.5 4.5 0 0118 10.5v1A3.5 3.5 0 0111.6 13l-.6-1H9l-.6 1A3.5 3.5 0 012 11.5v-1A4.5 4.5 0 016.5 6zm-.5 2.6v1.1H4.9v1.1H6v1.1h1.1v-1.1h1.1V9.7H7.1V8.6H6zm7.4.2a.85.85 0 100 1.7.85.85 0 000-1.7zm-1.7 1.7a.85.85 0 100 1.7.85.85 0 000-1.7z',
    dots: 'M4 8.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm6 0a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm6 0a1.5 1.5 0 110 3 1.5 1.5 0 010-3z',
    search: 'M8.5 3a5.5 5.5 0 014.4 8.8l3.1 3.2a.75.75 0 11-1 1l-3.2-3.1A5.5 5.5 0 118.5 3zm0 1.5a4 4 0 100 8 4 4 0 000-8z',
    play: 'M6.3 2.8A1.5 1.5 0 004 4.1v11.8a1.5 1.5 0 002.3 1.3l9.3-5.9a1.5 1.5 0 000-2.5L6.3 2.8z',
    stop: 'M5 5h10v10H5z',
    star: 'M10 1.8l2.5 5.1 5.6.8-4 4 .9 5.6L10 14.6l-5 2.6.9-5.6-4-4 5.6-.8L10 1.8z',
    mute: 'M9 4.5v11l-4-3H2v-5h3l4-3zm3.2 2.3l1-1 4.5 4.5-1 1-4.5-4.5zm5.5 0l1 1-4.5 4.5-1-1 4.5-4.5z',
    sound: 'M9 4.5v11l-4-3H2v-5h3l4-3zm3.3 1.2a5.5 5.5 0 010 8.6l-.9-1.1a4 4 0 000-6.4l.9-1.1z',
    expand: 'M3 3h6L6.8 5.2l3.4 3.4L8.6 10.2 5.2 6.8 3 9V3zm14 14h-6l2.2-2.2-3.4-3.4 1.6-1.6 3.4 3.4L17 11v6z',
    box: 'M4 4h12v12H4V4zm2 2v8h8V6H6z',
    check: 'M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.8 3.8 6.8-6.8a1 1 0 011.4 0z',
    filter: 'M3 4h14l-5.4 6.4V16l-3.2-1.8v-3.8L3 4z',
    layers: 'M10 2l8 4-8 4-8-4 8-4zm0 6.7l8-4v3.6l-8 4-8-4V4.7l8 4zm0 5.3l8-4v3.6l-8 4-8-4V10l8 4z',
    gear: 'M11.5 3.2c-.4-1.6-2.6-1.6-3 0a1.5 1.5 0 01-2.3.9C4.8 3.3 3.3 4.8 4.1 6.2a1.5 1.5 0 01-.9 2.3c-1.6.4-1.6 2.6 0 3a1.5 1.5 0 01.9 2.3c-.8 1.4.7 2.9 2.1 2.1a1.5 1.5 0 012.3.9c.4 1.6 2.6 1.6 3 0a1.5 1.5 0 012.3-.9c1.4.8 2.9-.7 2.1-2.1a1.5 1.5 0 01.9-2.3c1.6-.4 1.6-2.6 0-3a1.5 1.5 0 01-.9-2.3c.8-1.4-.7-2.9-2.1-2.1a1.5 1.5 0 01-2.3-.9zM10 13a3 3 0 110-6 3 3 0 010 6z',
    exit: 'M7 3a1 1 0 010 2H5v10h2a1 1 0 010 2H5a2 2 0 01-2-2V5a2 2 0 012-2h2zm5.3 2.3l4 4a1 1 0 010 1.4l-4 4a1 1 0 01-1.4-1.4L13.6 11H8a1 1 0 010-2h5.6l-2.7-2.3a1 1 0 011.4-1.4z',
    back: 'M12.7 4.3a1 1 0 010 1.4L8.4 10l4.3 4.3a1 1 0 01-1.4 1.4l-5-5a1 1 0 010-1.4l5-5a1 1 0 011.4 0z',
    wrench: 'M13.5 2a4.5 4.5 0 00-4.2 6L2.6 14.7a2 2 0 102.7 2.7L12 10.7A4.5 4.5 0 1013.5 2zm0 2a2.5 2.5 0 110 5 2.5 2.5 0 010-5z',
    trash: 'M8 2h4a1 1 0 011 1v1h3a1 1 0 010 2H4a1 1 0 010-2h3V3a1 1 0 011-1zM5 7h10l-.8 9a2 2 0 01-2 1.9H7.8a2 2 0 01-2-1.9L5 7z',
    keyboard: 'M2 5h16v10H2V5zm2 2v2h2V7H4zm3 0v2h2V7H7zm3 0v2h2V7h-2zm3 0v2h2V7h-2zM4 10v2h2v-2H4zm3 0v2h2v-2H7zm3 0v2h5v-2h-5z',
  };

  // The paths are drawn for the even-odd rule: without it the clock, the disc,
  // the newspaper and the Steam mark fill in as plain blobs. The muted speaker
  // is the one icon whose strokes overlap on purpose.
  const svg = (path, cls = '') =>
    `<svg viewBox="0 0 20 20" ${cls ? `class="${cls}"` : ''} aria-hidden="true"><path${path === ICON.mute ? '' : ' fill-rule="evenodd"'} d="${path}"/></svg>`;

  // ════════════════════════════════════════════════════════════════
  // Sound — synthesised, so there is nothing to ship and nothing to load.
  // ════════════════════════════════════════════════════════════════
  const Sound = (() => {
    let ctx = null;
    let last = 0;

    const VOICES = {
      move:   { freq: 540,  type: 'sine',     dur: 0.05,  gain: 0.14, slide: 90 },
      select: { freq: 760,  type: 'triangle', dur: 0.1,   gain: 0.2,  slide: 260 },
      back:   { freq: 420,  type: 'sine',     dur: 0.1,   gain: 0.16, slide: -160 },
      open:   { freq: 300,  type: 'sine',     dur: 0.22,  gain: 0.2,  slide: 420 },
      close:  { freq: 520,  type: 'sine',     dur: 0.18,  gain: 0.16, slide: -260 },
      launch: { freq: 480,  type: 'triangle', dur: 0.34,  gain: 0.26, slide: 620 },
      type:   { freq: 900,  type: 'square',   dur: 0.028, gain: 0.06, slide: 0 },
      edge:   { freq: 200,  type: 'sine',     dur: 0.07,  gain: 0.1,  slide: -40 },
    };

    return {
      play(name) {
        if (prefs().bigpicture_sounds === false) return;
        const voice = VOICES[name];
        if (!voice) return;
        const now = performance.now();
        if ((name === 'move' || name === 'type') && now - last < 38) return;
        last = now;

        safely('sound', () => {
          const Ctor = window.AudioContext || window.webkitAudioContext;
          if (!Ctor) return;
          if (!ctx) ctx = new Ctor();
          if (ctx.state === 'suspended') ctx.resume().catch(() => {});

          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const t = ctx.currentTime;
          osc.type = voice.type;
          osc.frequency.setValueAtTime(voice.freq, t);
          if (voice.slide) {
            osc.frequency.exponentialRampToValueAtTime(
              Math.max(60, voice.freq + voice.slide), t + voice.dur
            );
          }
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.exponentialRampToValueAtTime(voice.gain, t + 0.007);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + voice.dur);
          osc.connect(gain).connect(ctx.destination);
          osc.start(t);
          osc.stop(t + voice.dur + 0.02);
        });
      },
    };
  })();

  // ════════════════════════════════════════════════════════════════
  // Artwork — one probe per game per session, shared by every view.
  // ════════════════════════════════════════════════════════════════
  const LEGACY = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
  const artMemo = new Map();
  const metaMemo = new Map();

  function probe(url) {
    return new Promise((resolve, reject) => {
      if (!url) { reject(new Error('no url')); return; }
      const img = new Image();
      img.onload = () => resolve(url);
      img.onerror = () => reject(new Error('404'));
      img.src = url;
    });
  }

  const firstOf = async (...urls) => {
    const candidates = urls.filter(Boolean);
    if (!candidates.length) return '';

    /*
     * The main process remembers which of these exist, and remembers it across
     * restarts. That matters more than it looks: the legacy CDN answers its
     * 404s with no cache-control at all, so Chromium never stores them and the
     * probe below pays full network latency again on every launch — measured
     * at 330ms to 1.2s per missing asset, four of them for a recent game, every
     * time Big Picture opened.
     */
    const bridge = api();
    if (bridge?.probeArt) {
      try {
        const found = await bridge.probeArt(candidates);
        if (typeof found === 'string') return found;
      } catch { /* the launcher is old or busy; load them here instead */ }
    }

    for (const url of candidates) {
      try { return await probe(url); } catch { /* try the next candidate */ }
    }
    return '';
  };

  function appIdOf(game) {
    const id = String(game?.appid || '').trim();
    return /^\d{1,20}$/.test(id) && id !== '0' ? id : '';
  }

  /**
   * Resolve portrait/hero/logo for one game.
   *
   * The legacy CDN paths 404 for newer apps, so a miss falls through to the
   * main process's resolver — the same one the desktop library uses, and it
   * caches, so this costs one round trip per game at most.
   */
  function artFor(game) {
    const b = bridge();
    const key = b?.gameKeyOf?.(game) || game?.game_name || '';
    if (artMemo.has(key)) return artMemo.get(key);

    const job = (async () => {
      const id = appIdOf(game);
      const out = { portrait: '', hero: '', logo: '' };

      const wanted = {
        portrait: b?.getGameBannerUrl?.(game, 'portrait') || (id ? `${LEGACY}/${id}/library_600x900.jpg` : ''),
        hero: b?.getGameBannerUrl?.(game, 'hero') || (id ? `${LEGACY}/${id}/library_hero.jpg` : ''),
        header: b?.getGameBannerUrl?.(game, 'header') || (id ? `${LEGACY}/${id}/header.jpg` : ''),
      };

      out.portrait = await firstOf(wanted.portrait, wanted.header);
      out.hero = await firstOf(wanted.hero, wanted.header, wanted.portrait);

      if ((!out.portrait || !out.hero) && id && b?.resolveArtFor) {
        const resolved = await b.resolveArtFor(id).catch(() => null);
        if (resolved) {
          out.portrait = out.portrait || await firstOf(resolved.portrait, resolved.header);
          out.hero = out.hero || await firstOf(resolved.hero, resolved.header, resolved.portrait);
        }
      }

      // Steam keeps a transparent wordmark next to the capsules. When it exists
      // the reference theme shows it in place of the title.
      if (id) out.logo = await firstOf(`${LEGACY}/${id}/logo.png`, `${LEGACY}/${id}/logo_2x.png`);

      return out;
    })();

    artMemo.set(key, job);
    return job;
  }

  /** Store metadata (description, genres, trailer…). Null when unavailable. */
  function metaFor(game) {
    const id = appIdOf(game);
    if (!id) return Promise.resolve(null);
    if (metaMemo.has(id)) return metaMemo.get(id);
    const job = api()?.getGameMedia
      ? api().getGameMedia(id).catch(() => null)
      : Promise.resolve(null);
    metaMemo.set(id, job);
    return job;
  }

  // ════════════════════════════════════════════════════════════════
  // Formatting
  // ════════════════════════════════════════════════════════════════
  function fmtPlaytime(seconds) {
    const b = bridge();
    if (b?.formatPlaytime) return b.formatPlaytime(seconds || 0);
    const mins = Math.round((seconds || 0) / 60);
    return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  function fmtRelative(ts) {
    const b = bridge();
    if (b?.formatRelative) return b.formatRelative(ts);
    return ts ? new Date(ts).toLocaleDateString() : '—';
  }

  const fmtSize = (bytes) => bridge()?.formatSize?.(bytes) || '—';

  function clockText() {
    const now = new Date();
    return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ════════════════════════════════════════════════════════════════
  // State
  // ════════════════════════════════════════════════════════════════
  const S = {
    open: false,
    built: false,
    layout: 'horizontal',
    zone: 'shelf',        // rail · shelf · grid
    view: 'browse',       // browse · details · search · menu · filter · system
    list: [],             // the filtered, sorted games on screen
    index: 0,
    groups: [],
    groupIndex: 0,
    filter: { installedOnly: false, favOnly: false, updatesOnly: false, sort: 'name' },
    query: '',
    searchMode: 'library',  // library · store
    searchZone: 'keys',     // keys · results
    keyIndex: 0,
    resultIndex: 0,
    results: [],            // library games, or { id, name } from the store
    storeError: '',
    storeBusy: false,
    download: null,         // last librarian:download payload
    queue: [],
    oskTarget: null,        // which field the on-screen keyboard is typing into
    modalCursor: 0,
    updating: false,        // an update is being prepared from the details page
    padBrand: 'xbox',       // xbox · playstation · nintendo
    shelfTrailer: false,
    steppedAside: false,    // minimised so a launched game could come forward
    steppedAsideAt: 0,
    online: null,           // { key, state, on, backend, reason, busy } for the open game
    // The details page is three focusable rows: the action pills, the tab bar
    // beneath them, and whatever the open tab put on screen. Up and down move
    // between them, and stepping off the top or the bottom changes game — the
    // way it always did, so the habit still works.
    sfRails: [],            // the store front page, once fetched
    sfRail: 0,              // which shelf the cursor is on
    sfCard: 0,              // and which card within it
    detRow: 0,              // 0 actions · 1 tabs · 2 panel contents
    tabs: [],               // the tabs this game actually has something for
    tabIndex: 0,
    cellIndex: 0,           // focus inside the open panel
    ach: null,              // achievement snapshot for the open game
    dlc: null,              // what the emulator has been told about this game's DLC
    news: null,             // patch notes for the open game
    shots: [],              // screenshot slideshow for the details background
    shotIndex: 0,
    shotFlip: false,
    rowIndex: 0,          // cursor inside the active sheet
    actIndex: 0,          // cursor inside the details action row
    railIndex: 0,
    bgToken: 0,
    metaToken: 0,
    wasFullscreen: false,
    layerFlip: false,
    trailerOn: false,
    muted: true,
  };

  const els = {};
  let bgTimer = 0;
  let metaTimer = 0;
  let swapTimer = 0;
  let clockTimer = 0;
  let liveTimer = 0;
  let trailerTimer = 0;
  let bgSwapTimer = 0;
  let shotTimer = 0;

  // ════════════════════════════════════════════════════════════════
  // DOM
  // ════════════════════════════════════════════════════════════════
  const KEY_ROWS = [
    [...'1234567890'],
    [...'qwertyuiop'],
    [...'asdfghjkl', { id: 'bs', label: '⌫ Back', span: 1 }],
    [...'zxcvbnm', { id: 'sp', label: 'Space', span: 2 }, { id: 'cl', label: 'Clear', span: 1 }],
  ];

  // Element index ⇄ (row, column). The rows are not all the same length —
  // Space is two columns wide — so navigation walks this map rather than doing
  // arithmetic on a fixed column count.
  const KEY_LAYOUT = [];
  const KEY_AT = [];

  (function mapKeys() {
    let i = 0;
    KEY_ROWS.forEach((row, r) => {
      KEY_LAYOUT[r] = [];
      row.forEach((_, c) => {
        KEY_LAYOUT[r][c] = i;
        KEY_AT[i] = { row: r, col: c };
        i++;
      });
    });
  })();

  function buildKeyboard() {
    let html = '';
    let i = 0;
    for (const row of KEY_ROWS) {
      for (const key of row) {
        const isObj = typeof key === 'object';
        const id = isObj ? key.id : key;
        const label = isObj ? key.label : key;
        // Word keys (Space, Clear, Back) are not letters and must not be shouted.
        const cls = ['bp-key'];
        if (isObj) cls.push('is-fn');
        if (isObj && key.span > 1) cls.push('is-wide');
        html += `<button class="${cls.join(' ')}" data-key="${esc(id)}" data-ki="${i++}">${esc(label)}</button>`;
      }
    }
    return html;
  }

  function hint(id, glyphKey, label, square) {
    return `<button class="bp-hint" data-hint="${id}">
      <span class="bp-glyph${square ? ' is-square' : ''}" data-glyph="${glyphKey}"></span><span>${esc(label)}</span>
    </button>`;
  }

  function build() {
    if (S.built) return;

    const root = document.createElement('div');
    root.id = 'bp-root';
    root.hidden = true;
    root.setAttribute('role', 'application');
    root.setAttribute('aria-label', 'Big Picture');
    root.dataset.layout = 'horizontal';
    root.dataset.zone = 'shelf';

    root.innerHTML = `
      <div id="bp-bg">
        <div class="bp-layer" id="bp-layer-a"></div>
        <div class="bp-layer" id="bp-layer-b"></div>
        <video id="bp-bg-video" muted loop playsinline preload="none"></video>
      </div>
      <div id="bp-scrim"></div>
      <div id="bp-grain"></div>

      <!-- Everything below is inside the 16:9 stage, so the whole layout keeps
           its proportions on an ultrawide display instead of stretching. -->
      <div id="bp-stage">
        <nav id="bp-rail" aria-label="Filters"><div class="bp-rail-scroll" id="bp-rail-list"></div></nav>

        <header id="bp-top">
          <div id="bp-title">Games</div>
          <div id="bp-top-right">
            <button class="bp-playing" id="bp-playing" hidden>
              <span class="bp-playing-dot"></span>
              <span class="bp-playing-name">—</span>
              <span class="bp-playing-time">0:00</span>
            </button>
            <button class="bp-top-btn" id="bp-btn-dl" title="Downloads" hidden>
              <svg viewBox="0 0 36 36" class="bp-ring" aria-hidden="true">
                <circle cx="18" cy="18" r="15" class="bp-ring-track"></circle>
                <circle cx="18" cy="18" r="15" class="bp-ring-fill"></circle>
              </svg>
              <span id="bp-dl-pct">0</span>
            </button>
            <span id="bp-clock">--:--</span>
            <button class="bp-top-btn" id="bp-btn-store" title="Store">${svg(ICON.download)}</button>
            <button class="bp-top-btn" id="bp-btn-grid" title="Grid view">${svg(ICON.grid)}</button>
            <button class="bp-top-btn" id="bp-btn-system" title="System menu">${svg(ICON.dots)}</button>
            <button class="bp-top-btn" id="bp-btn-exit" title="Leave Big Picture">${svg(ICON.pad)}</button>
          </div>
        </header>

        <div id="bp-body">
          <section id="bp-detail">
            <img id="bp-logo" alt="" hidden>
            <h1 id="bp-name">—</h1>
            <div id="bp-rule"></div>
            <div id="bp-meta"></div>
            <p id="bp-desc"></p>
          </section>
          <div id="bp-grid-wrap"><div id="bp-grid"></div></div>
        </div>

        <div id="bp-shelf"><div id="bp-track"></div></div>

        <footer id="bp-hints">
          <span id="bp-hint-note"></span>
          <div id="bp-hint-list">
            ${hint('play', 'confirm', 'Play')}
            ${hint('details', 'details', 'Details')}
            ${hint('menu', 'view', 'Game Options')}
            ${hint('search', 'search', 'Search')}
            ${hint('filter', 'filter', 'Filter', true)}
          </div>
        </footer>

        <div id="bp-empty">
          <h2>Nothing on the shelf yet</h2>
          <p>Search the store to download your first game, or head back to the desktop interface to add one you already have.</p>
          <div id="bp-empty-actions">
            <button class="bp-act is-primary" id="bp-empty-store">Browse the store</button>
            <button class="bp-act" id="bp-empty-exit">Back to Librarian</button>
          </div>
        </div>
      </div>

      <!-- Details ------------------------------------------------ -->
      <section id="bp-details" aria-label="Game details">
        <div id="bp-det-bg"></div>
        <div id="bp-det-bg2"></div>
        <video id="bp-det-video" muted playsinline preload="none"></video>
        <div id="bp-det-scrim"></div>
        <div id="bp-det-stage">
          <div id="bp-det-topname"></div>
          <div id="bp-det-head">
            <img id="bp-det-logo" alt="" hidden>
            <h2 id="bp-det-name">—</h2>
            <div id="bp-det-sub"></div>
          </div>
          <div id="bp-det-actions"></div>
          <div id="bp-det-note"></div>
          <div id="bp-det-tabs" role="tablist"></div>
          <div id="bp-det-panels">
            <div id="bp-det-foot" class="bp-det-panel" data-tab="overview">
              <div id="bp-det-achbar"></div>
              <div id="bp-det-cols">
                <p id="bp-det-desc"></p>
                <div id="bp-det-stats"></div>
                <div id="bp-det-tags"></div>
              </div>
            </div>
            <div id="bp-det-ach" class="bp-det-panel" data-tab="achievements"></div>
            <div id="bp-det-shots" class="bp-det-panel" data-tab="screenshots"></div>
            <div id="bp-det-news" class="bp-det-panel" data-tab="news"></div>
          </div>
        </div>
      </section>

      <!-- Sheets ------------------------------------------------- -->
      <div class="bp-sheet" id="bp-menu" aria-label="Game options">
        <div class="bp-panel">
          <div class="bp-panel-head">Game Options</div>
          <div class="bp-panel-sub" id="bp-menu-sub"></div>
          <div id="bp-menu-rows"></div>
        </div>
      </div>

      <div class="bp-sheet" id="bp-filter" aria-label="Filter">
        <div class="bp-panel">
          <div class="bp-panel-head">Filter &amp; Sort</div>
          <div id="bp-filter-rows"></div>
        </div>
      </div>

      <div class="bp-sheet" id="bp-update" aria-label="Update">
        <div class="bp-panel is-update">
          <div id="bp-upd-art"></div>
          <div id="bp-upd-body">
            <div id="bp-upd-name">—</div>
            <div id="bp-upd-status"><span id="bp-upd-spin"></span><span id="bp-upd-text">Checking…</span></div>
            <div id="bp-upd-bar"><i id="bp-upd-fill"></i></div>
            <div id="bp-upd-stats"></div>
          </div>
        </div>
      </div>

      <div class="bp-sheet" id="bp-ach" aria-label="Achievements">
        <div class="bp-panel is-wide">
          <div class="bp-panel-head">Achievements</div>
          <div class="bp-panel-sub" id="bp-ach-sub"></div>
          <div id="bp-ach-bar"><i id="bp-ach-fill"></i></div>
          <div id="bp-ach-list"></div>
        </div>
      </div>

      <!-- The store front, on the couch. Its own screen rather than a sheet:
           browsing is somewhere you go, not a dialog you dismiss. Sits below
           the sheets in the stack, so a store page opened from it lands on
           top of it rather than behind. -->
      <section id="bp-storefront" aria-label="Store">
        <img id="bp-sf-bg" alt="" aria-hidden="true">
        <div id="bp-sf-scrim" aria-hidden="true"></div>
        <div id="bp-sf-body">
          <button id="bp-sf-search" type="button">
            ${svg(ICON.search)}<span>Search the store</span>
          </button>
          <div id="bp-sf-head">
            <div id="bp-sf-kicker">Store</div>
            <div id="bp-sf-name">—</div>
            <div id="bp-sf-meta"></div>
          </div>
          <div id="bp-sf-rails"></div>
          <div id="bp-sf-status"></div>
        </div>
      </section>

      <!-- The store page, on the couch. Media band on top, the same .bp-row
           list underneath so the stick and A work here with no new input
           code. Deliberately not the details view: that describes a game you
           own, this one is selling you one you do not. -->
      <!-- The store page, on the couch. A full screen, not a panel: it is the
           page that sells a game, and it carries the trailer, the artwork, the
           description, the facts, the screenshots and the actions all at once.
           Sits above the store front it was launched from. -->
      <section id="bp-store" aria-label="Store page">
        <img id="bp-store-bg" alt="" aria-hidden="true">
        <video id="bp-store-video" muted loop playsinline preload="none" aria-hidden="true"></video>
        <div id="bp-store-scrim" aria-hidden="true"></div>

        <div id="bp-store-inner">
          <div id="bp-store-left">
            <img id="bp-store-logo" hidden alt="">
            <div id="bp-store-name"></div>
            <div id="bp-store-sub"></div>
            <div id="bp-store-facts"></div>
            <div id="bp-store-rows"></div>
          </div>

          <div id="bp-store-right">
            <div class="bp-store-block" id="bp-store-about-wrap">
              <div class="bp-store-block-head">About</div>
              <div id="bp-store-about"></div>
            </div>
            <div class="bp-store-block" id="bp-store-shots-wrap">
              <div class="bp-store-block-head">Screenshots</div>
              <div id="bp-store-shots"></div>
            </div>
            <div class="bp-store-block" id="bp-store-tags-wrap">
              <div class="bp-store-block-head">Tags</div>
              <div id="bp-store-tags"></div>
            </div>
          </div>
        </div>
      </section>

      <div class="bp-sheet" id="bp-news" aria-label="Patch notes">
        <div class="bp-panel is-wide">
          <div class="bp-panel-head">Patch notes</div>
          <div class="bp-panel-sub" id="bp-news-sub"></div>
          <div id="bp-news-list"></div>
        </div>
      </div>

      <div class="bp-sheet" id="bp-system" aria-label="System">
        <div class="bp-panel">
          <div class="bp-panel-head">Big Picture</div>
          <div id="bp-system-rows"></div>
        </div>
      </div>

      <div class="bp-sheet" id="bp-search" aria-label="Search">
        <div id="bp-search-box">
          <div>
            <div id="bp-search-tabs">
              <button class="bp-tab is-on" data-mode="library">${svg(ICON.grid)}<span>My library</span></button>
              <button class="bp-tab" data-mode="store">${svg(ICON.download)}<span>Store</span></button>
              <span id="bp-tab-hint">LB / RB</span>
            </div>
            <div id="bp-query-wrap">
              ${svg(ICON.search)}
              <input id="bp-query" type="text" placeholder="Search your library" autocomplete="off" spellcheck="false">
            </div>
            <div id="bp-keys">${buildKeyboard()}</div>
          </div>
          <div id="bp-results-wrap">
            <div id="bp-results"></div>
            <div id="bp-results-empty" hidden>No matches.</div>
          </div>
        </div>
      </div>

      <!-- Downloads ---------------------------------------------- -->
      <div class="bp-sheet" id="bp-downloads" aria-label="Downloads">
        <div class="bp-panel">
          <div class="bp-panel-head">Downloads</div>
          <div id="bp-dl-live">
            <div id="bp-dl-name">—</div>
            <div id="bp-dl-bar"><i></i></div>
            <div id="bp-dl-stats"></div>
          </div>
          <div id="bp-dl-rows"></div>
        </div>
      </div>

      <div id="bp-curtain">
        <div id="bp-curtain-inner">
          <div id="bp-curtain-art"></div>
          <div id="bp-curtain-text">Launching…</div>
          <div id="bp-curtain-bar"><i></i></div>
        </div>
      </div>
    `;

    document.body.appendChild(root);

    const pick = (id) => root.querySelector(`#${id}`);
    Object.assign(els, {
      root,
      bg: pick('bp-bg'),
      layerA: pick('bp-layer-a'),
      layerB: pick('bp-layer-b'),
      bgVideo: pick('bp-bg-video'),
      playing: pick('bp-playing'),
      playingName: pick('bp-playing').querySelector('.bp-playing-name'),
      playingTime: pick('bp-playing').querySelector('.bp-playing-time'),
      rail: pick('bp-rail'),
      railList: pick('bp-rail-list'),
      title: pick('bp-title'),
      clock: pick('bp-clock'),
      btnGrid: pick('bp-btn-grid'),
      btnSystem: pick('bp-btn-system'),
      btnExit: pick('bp-btn-exit'),
      detail: pick('bp-detail'),
      logo: pick('bp-logo'),
      name: pick('bp-name'),
      meta: pick('bp-meta'),
      desc: pick('bp-desc'),
      shelf: pick('bp-shelf'),
      track: pick('bp-track'),
      gridWrap: pick('bp-grid-wrap'),
      grid: pick('bp-grid'),
      hintNote: pick('bp-hint-note'),
      hintList: pick('bp-hint-list'),
      btnStore: pick('bp-btn-store'),
      storefront: pick('bp-storefront'),
      sfBg: pick('bp-sf-bg'),
      sfSearch: pick('bp-sf-search'),
      sfName: pick('bp-sf-name'),
      sfMeta: pick('bp-sf-meta'),
      sfRails: pick('bp-sf-rails'),
      sfStatus: pick('bp-sf-status'),
      store: pick('bp-store'),
      storeBg: pick('bp-store-bg'),
      storeVideo: pick('bp-store-video'),
      storeLogo: pick('bp-store-logo'),
      storeName: pick('bp-store-name'),
      storeSub: pick('bp-store-sub'),
      storeFacts: pick('bp-store-facts'),
      storeRows: pick('bp-store-rows'),
      storeAbout: pick('bp-store-about'),
      storeShots: pick('bp-store-shots'),
      storeTags: pick('bp-store-tags'),
      details: pick('bp-details'),
      detBg: pick('bp-det-bg'),
      detBg2: pick('bp-det-bg2'),
      detNote: pick('bp-det-note'),
      detVideo: pick('bp-det-video'),
      detTopName: pick('bp-det-topname'),
      detLogo: pick('bp-det-logo'),
      detName: pick('bp-det-name'),
      detSub: pick('bp-det-sub'),
      detActions: pick('bp-det-actions'),
      detDesc: pick('bp-det-desc'),
      detStats: pick('bp-det-stats'),
      detTags: pick('bp-det-tags'),
      detTabs: pick('bp-det-tabs'),
      detPanels: pick('bp-det-panels'),
      detFoot: pick('bp-det-foot'),
      detAch: pick('bp-det-ach'),
      detAchBar: pick('bp-det-achbar'),
      detShots: pick('bp-det-shots'),
      detNews: pick('bp-det-news'),
      menu: pick('bp-menu'),
      menuSub: pick('bp-menu-sub'),
      menuRows: pick('bp-menu-rows'),
      filter: pick('bp-filter'),
      filterRows: pick('bp-filter-rows'),
      system: pick('bp-system'),
      systemHead: pick('bp-system').querySelector('.bp-panel-head'),
      systemRows: pick('bp-system-rows'),
      update: pick('bp-update'),
      updArt: pick('bp-upd-art'),
      updName: pick('bp-upd-name'),
      updText: pick('bp-upd-text'),
      updBar: pick('bp-upd-bar'),
      updFill: pick('bp-upd-fill'),
      updStats: pick('bp-upd-stats'),
      ach: pick('bp-ach'),
      achSub: pick('bp-ach-sub'),
      achFill: pick('bp-ach-fill'),
      achList: pick('bp-ach-list'),
      news: pick('bp-news'),
      newsSub: pick('bp-news-sub'),
      newsList: pick('bp-news-list'),
      search: pick('bp-search'),
      searchTabs: pick('bp-search-tabs'),
      query: pick('bp-query'),
      downloads: pick('bp-downloads'),
      dlLive: pick('bp-dl-live'),
      dlName: pick('bp-dl-name'),
      dlBar: pick('bp-dl-bar').firstElementChild,
      dlStats: pick('bp-dl-stats'),
      dlRows: pick('bp-dl-rows'),
      btnDl: pick('bp-btn-dl'),
      dlPct: pick('bp-dl-pct'),
      ringFill: root.querySelector('.bp-ring-fill'),
      keys: pick('bp-keys'),
      results: pick('bp-results'),
      resultsWrap: pick('bp-results-wrap'),
      resultsEmpty: pick('bp-results-empty'),
      curtain: pick('bp-curtain'),
      curtainArt: pick('bp-curtain-art'),
      curtainText: pick('bp-curtain-text'),
    });

    wirePointer();
    S.built = true;
  }

  // ════════════════════════════════════════════════════════════════
  // Groups (the left rail)
  // ════════════════════════════════════════════════════════════════
  function hasUpdate(game) {
    const info = bridge()?.state?.updateResults?.[bridge()?.updateResultKey?.(game) || game?.appid];
    if (!info) return false;
    if (info.status === 'update_available') return true;
    return info.status === 'unknown' && info.reason === 'No local buildId' && Boolean(info.remoteBuildId);
  }

  const isInstalled = (game) => Boolean(game?.install_path);

  function sourceIcon(source) {
    const s = String(source || '').toLowerCase();
    if (s.includes('steam')) return ICON.steam;
    if (s.includes('custom')) return ICON.folder;
    return ICON.disc;
  }

  function buildGroups() {
    const b = bridge();
    const games = b?.games || [];

    const groups = [
      { id: 'all', label: 'All Games', icon: ICON.grid, test: () => true },
      { id: 'fav', label: 'Favorites', icon: ICON.heart, test: (g) => Boolean(b?.isFavorite?.(g)) },
      { id: 'recent', label: 'Recently Played', icon: ICON.clock, test: (g) => Boolean(g.last_played) },
      { id: 'fresh', label: 'Never Played', icon: ICON.spark, test: (g) => !(g.playtime_seconds > 0) },
    ];

    if (games.some(hasUpdate)) {
      groups.push({ id: 'updates', label: 'Updates', icon: ICON.download, test: hasUpdate });
    }

    for (const source of [...new Set(games.map((g) => g.source).filter(Boolean))].sort()) {
      groups.push({
        id: `src:${source}`,
        label: String(source),
        icon: sourceIcon(source),
        test: (g) => g.source === source,
      });
    }

    const collections = b?.getCollections?.() || {};
    for (const name of Object.keys(collections).sort((a, z) => a.localeCompare(z))) {
      const members = new Set(collections[name] || []);
      groups.push({
        id: `col:${name}`,
        label: name,
        icon: ICON.layers,
        test: (g) => members.has(b?.favKey?.(g) || ''),
      });
    }

    // The store is the last stop on the rail, and it is not a filter — it is
    // a place. `action` marks it so activation opens the store instead of
    // narrowing the shelf, and because it is appended last it can never be
    // the default S.groupIndex, which would otherwise filter the library
    // through a test that matches nothing.
    //
    // It lives here rather than only in the top bar because the rail is what
    // Big Picture uses for navigation; a small glyph in the top-right corner
    // is the least discoverable place on a screen you look at from a sofa.
    groups.push({
      id: 'store',
      label: 'Store',
      icon: ICON.download,
      action: 'store',
      test: () => false,
    });

    // Keep whatever the user was looking at, if it still exists.
    const wanted = S.groups[S.groupIndex]?.id;
    S.groups = groups;
    const at = groups.findIndex((g) => g.id === wanted && !g.action);
    S.groupIndex = at === -1 ? 0 : at;
    renderRail();
  }

  function renderRail() {
    els.railList.innerHTML = S.groups.map((group, i) => `
      <button class="bp-rail-item${group.action ? ` is-${group.action}` : ''}${i === S.groupIndex ? ' is-active' : ''}${i === S.railIndex ? ' is-cursor' : ''}"
              data-gi="${i}" title="${esc(group.label)}">
        ${svg(group.icon)}<span class="bp-rail-label">${esc(group.label)}</span>
      </button>
    `).join('');
  }

  function paintRailCursor() {
    [...els.railList.children].forEach((item, i) => {
      item.classList.toggle('is-cursor', i === S.railIndex);
      item.classList.toggle('is-active', i === S.groupIndex);
    });
  }

  // ════════════════════════════════════════════════════════════════
  // The list on screen
  // ════════════════════════════════════════════════════════════════
  const SORTS = {
    name: (a, z) => String(a.game_name || '').localeCompare(String(z.game_name || '')),
    recent: (a, z) => (z.last_played || 0) - (a.last_played || 0),
    playtime: (a, z) => (z.playtime_seconds || 0) - (a.playtime_seconds || 0),
    size: (a, z) => (z.size_on_disk || 0) - (a.size_on_disk || 0),
  };

  const SORT_LABELS = { name: 'Name', recent: 'Recently played', playtime: 'Most played', size: 'Size on disk' };

  function rebuildList({ keepSelection = true } = {}) {
    const b = bridge();
    const group = S.groups[S.groupIndex] || { test: () => true, label: 'All Games' };
    const before = keepSelection ? S.list[S.index] : null;
    const beforeKey = before ? b?.gameKeyOf?.(before) : '';

    let list = (b?.games || []).filter((g) => {
      if (!group.test(g)) return false;
      if (S.filter.installedOnly && !isInstalled(g)) return false;
      if (S.filter.favOnly && !b?.isFavorite?.(g)) return false;
      if (S.filter.updatesOnly && !hasUpdate(g)) return false;
      return true;
    });

    // "Recently Played" is meaningless in alphabetical order.
    const sortKey = group.id === 'recent' && S.filter.sort === 'name' ? 'recent' : S.filter.sort;
    list = list.sort(SORTS[sortKey] || SORTS.name);

    S.list = list;
    els.title.textContent = group.label;
    // Retrigger the underline sweep.
    els.title.style.animation = 'none';
    void els.title.offsetWidth;
    els.title.style.animation = '';

    els.root.dataset.empty = list.length ? '0' : '1';

    const at = beforeKey ? list.findIndex((g) => b?.gameKeyOf?.(g) === beforeKey) : -1;
    S.index = at === -1 ? 0 : at;

    renderCards();
    const active = list.length ? filterNote() : '';
    els.hintNote.textContent = active;
    select(S.index, { animate: false, force: true });
  }

  function filterNote() {
    const bits = [];
    if (S.filter.installedOnly) bits.push('installed only');
    if (S.filter.favOnly) bits.push('favorites only');
    if (S.filter.updatesOnly) bits.push('updates only');
    if (S.filter.sort !== 'name') bits.push(`sorted by ${SORT_LABELS[S.filter.sort].toLowerCase()}`);
    const count = `${S.list.length} ${S.list.length === 1 ? 'game' : 'games'}`;
    return bits.length ? `${count} · ${bits.join(', ')}` : count;
  }

  // ════════════════════════════════════════════════════════════════
  // Cards
  // ════════════════════════════════════════════════════════════════
  /** The generated cover, for titles the CDN has no art for at all. */
  function fallbackHtml(name) {
    const b = bridge();
    return `<div class="bp-fallback" style="${b?.artStyleFor?.(name) || ''}">
      <span class="bp-fb-mark">${esc(b?.artInitials?.(name) || '?')}</span>
      <span class="bp-fb-name">${esc(name)}</span>
    </div>`;
  }

  function cardHtml(game, i) {
    const b = bridge();
    const name = game.game_name || 'Unknown';
    const flags = [];
    if (b?.isGameRunning?.(game)) flags.push(`<span class="bp-flag is-live">${svg(ICON.play)}</span>`);
    else if (hasUpdate(game)) flags.push(`<span class="bp-flag is-update">${svg(ICON.download)}</span>`);
    if (b?.isFavorite?.(game)) flags.push(`<span class="bp-flag is-fav">${svg(ICON.star)}</span>`);

    // A skeleton, not the generated cover: showing initials and then replacing
    // them a second later reads as a glitch. The fallback is only committed to
    // once the lookup has actually come back empty.
    return `<div class="bp-card is-enter is-entering" data-i="${i}" style="--d:${Math.min(i, 22) * 26}ms" title="${esc(name)}">
      <div class="bp-card-art"><div class="bp-skel"></div></div>
      <div class="bp-card-flags">${flags.join('')}</div>
      <div class="bp-card-plate"><span class="bp-card-name">${esc(name)}</span></div>
    </div>`;
  }

  /** Resolve the skeleton into either real art or the generated cover. */
  function hydrateArt(card, game) {
    const settle = (html) => {
      if (!card.isConnected) return;
      const holder = card.querySelector('.bp-card-art');
      if (holder) holder.innerHTML = html;
    };

    artFor(game).then((art) => {
      if (!card.isConnected) return;
      if (!art.portrait) { settle(fallbackHtml(game.game_name || 'Unknown')); return; }
      const img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.onload = () => {
        if (!card.isConnected) return;
        const holder = card.querySelector('.bp-card-art');
        if (holder) holder.replaceChildren(img);
      };
      img.onerror = () => settle(fallbackHtml(game.game_name || 'Unknown'));
      img.src = art.portrait;
    }).catch(() => settle(fallbackHtml(game.game_name || 'Unknown')));
  }

  function renderCards() {
    const host = S.layout === 'grid' ? els.grid : els.track;
    const other = S.layout === 'grid' ? els.track : els.grid;
    other.replaceChildren();

    host.innerHTML = S.list.map(cardHtml).join('');
    const cards = [...host.children];
    cards.forEach((card, i) => hydrateArt(card, S.list[i]));

    // setTimeout, never rAF — a backgrounded renderer would otherwise leave
    // every card stuck at opacity 0 for as long as the window stayed hidden.
    const settle = () => {
      cards.forEach((card) => card.classList.remove('is-enter'));
      setTimeout(() => cards.forEach((card) => card.classList.remove('is-entering')), 900);
    };
    if (motionOff() || framesStalled()) settle();
    else setTimeout(settle, 16);

    if (S.layout === 'horizontal') moveTrack(false);
  }

  function cardAt(i) {
    const host = S.layout === 'grid' ? els.grid : els.track;
    return host.children[i] || null;
  }

  function gridColumns() {
    const cols = getComputedStyle(els.grid).gridTemplateColumns;
    const n = cols ? cols.split(' ').filter(Boolean).length : 5;
    return clamp(n, 1, 12);
  }

  function moveTrack(animate = true) {
    const first = els.track.firstElementChild;
    if (!first) { els.track.style.transform = 'translate3d(0,0,0)'; return; }

    const style = getComputedStyle(els.track);
    const gap = parseFloat(style.columnGap || style.gap || '0') || 0;
    const pad = parseFloat(style.paddingLeft || '0') || 0;
    const step = first.offsetWidth + gap;
    const total = S.list.length * step - gap;
    // The selected card is scaled up, so it overhangs its own box; without a
    // little slack the last item in the shelf is clipped by the right edge.
    const room = els.shelf.clientWidth - pad - first.offsetWidth * 0.05;
    const maxShift = Math.max(0, total - room);
    const shift = Math.min(S.index * step, maxShift);

    els.track.style.transition = animate && !motionOff() ? '' : 'none';
    els.track.style.transform = `translate3d(${-Math.round(shift)}px,0,0)`;
    if (!animate) {
      // Restore the transition without a frame callback.
      setTimeout(() => { els.track.style.transition = ''; }, 0);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // Selection
  // ════════════════════════════════════════════════════════════════
  const current = () => S.list[S.index] || null;

  function select(i, { animate = true, force = false } = {}) {
    if (!S.list.length) { paintDetail(null); return; }
    const next = clamp(i, 0, S.list.length - 1);
    if (next === S.index && !force) return;
    S.index = next;

    const host = S.layout === 'grid' ? els.grid : els.track;
    [...host.children].forEach((card, at) => card.classList.toggle('is-sel', at === next));

    if (S.layout === 'grid') {
      cardAt(next)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else {
      moveTrack(animate);
    }

    // The background drifts against the shelf: moving right pushes the art
    // left, so the two planes read as different distances.
    const ratio = S.list.length > 1 ? next / (S.list.length - 1) : 0;
    els.bg.style.setProperty('--bp-par', String(ratio.toFixed(3)));

    paintDetail(current());
  }

  function bumpDetail() {
    if (motionOff()) return;
    els.detail.classList.add('is-swap');
    clearTimeout(swapTimer);
    swapTimer = setTimeout(() => els.detail.classList.remove('is-swap'), 95);
  }

  function paintDetail(game) {
    if (!game) {
      els.name.textContent = '';
      els.meta.replaceChildren();
      els.desc.textContent = '';
      els.logo.hidden = true;
      return;
    }

    const b = bridge();
    bumpDetail();

    els.name.textContent = game.game_name || 'Unknown';
    els.logo.hidden = true;
    els.name.hidden = false;

    const fav = Boolean(b?.isFavorite?.(game));
    const running = Boolean(b?.isGameRunning?.(game));
    const bits = [];
    if (game.source) bits.push(esc(game.source));
    if (game.playtime_seconds > 0) bits.push(esc(fmtPlaytime(game.playtime_seconds)));
    else if (game.size_on_disk) bits.push(esc(fmtSize(game.size_on_disk)));

    els.meta.innerHTML = `
      ${svg(ICON.star, `bp-star${fav ? '' : ' is-off'}`)}
      <span>${bits.join('&nbsp;&nbsp;·&nbsp;&nbsp;') || 'Ready to play'}</span>
      ${running ? '<span class="bp-pill is-live">Running</span>' : ''}
      ${!running && hasUpdate(game) ? '<span class="bp-pill is-warn">Update</span>' : ''}
      ${!isInstalled(game) ? '<span class="bp-pill">Not installed</span>' : ''}
    `;

    els.desc.textContent = localBlurb(game);

    const token = ++S.metaToken;
    clearTimeout(metaTimer);
    clearTimeout(bgTimer);

    // Only reach for the network once the user has stopped scrubbing.
    metaTimer = setTimeout(() => {
      metaFor(game).then((meta) => {
        if (token !== S.metaToken) return;
        if (meta?.short_description) els.desc.textContent = meta.short_description;
      }).catch(() => {});

      if (prefs().bigpicture_logos !== false) {
        artFor(game).then((art) => {
          if (token !== S.metaToken || !art.logo) return;
          els.logo.onload = () => {
            if (token !== S.metaToken) return;
            els.logo.hidden = false;
            els.name.hidden = true;
          };
          els.logo.src = art.logo;
        }).catch(() => {});
      }
    }, 300);

    bgTimer = setTimeout(() => setBackground(game, token), 140);
    stopShelfTrailer();
    scheduleShelfTrailer(game, token);
  }

  /** Something true and useful to show before the store API answers. */
  function localBlurb(game) {
    const bits = [];
    if (game.playtime_seconds > 0) bits.push(`${fmtPlaytime(game.playtime_seconds)} played`);
    if (game.last_played) bits.push(`last played ${fmtRelative(game.last_played)}`);
    if (game.size_on_disk) bits.push(fmtSize(game.size_on_disk));
    if (appIdOf(game)) bits.push(`AppID ${appIdOf(game)}`);
    if (!bits.length) return isInstalled(game) ? 'Installed and ready.' : 'Not installed yet.';
    return `${bits.join(' · ')}.`;
  }

  // ────────────────────────────────────────────────────────────────
  // Trailer behind the shelf. The reference theme's most alive moment: the
  // still settles, then the game starts moving behind the covers. Held back
  // until the selection has rested, so scrubbing the shelf never starts a
  // video, and torn down the instant anything else takes the screen.
  // ────────────────────────────────────────────────────────────────
  // js/trailer.js owns the awkward part: Steam publishes HLS for anything
  // recent, so this may be a streaming session rather than a plain source.
  const setTrailerSources = (video, movie) =>
    Boolean(window.LibrarianTrailer?.attach(video, movie));

  const clearTrailer = (video) =>
    safely('trailer-clear', () => window.LibrarianTrailer?.detach(video));

  function stopShelfTrailer() {
    clearTimeout(trailerTimer);
    if (!S.shelfTrailer) return;
    S.shelfTrailer = false;
    els.bgVideo.classList.remove('is-on');
    clearTrailer(els.bgVideo);
  }

  function scheduleShelfTrailer(game, token) {
    clearTimeout(trailerTimer);
    if (prefs().bigpicture_trailer_bg === false || motionOff()) return;
    trailerTimer = setTimeout(() => {
      if (token !== S.metaToken || S.view !== 'browse' || !S.open) return;
      metaFor(game).then((meta) => {
        const movie = meta?.movies?.[0];
        if (!movie || token !== S.metaToken || S.view !== 'browse' || !S.open) return;
        if (!setTrailerSources(els.bgVideo, movie)) return;
        els.bgVideo.muted = true;

        const reveal = () => {
          if (token !== S.metaToken || S.view !== 'browse' || !S.open) { stopShelfTrailer(); return; }
          if (!els.bgVideo.videoWidth) return;   // no picture — leave the still up
          S.shelfTrailer = true;
          els.bgVideo.classList.add('is-on');
        };

        els.bgVideo.addEventListener('error', () => stopShelfTrailer(), { once: true });
        els.bgVideo.play().then(() => {
          // Wait for a decoded frame rather than for play() to resolve: a video
          // whose every source 404s still reports itself as playing.
          if (els.bgVideo.readyState >= 2) reveal();
          else els.bgVideo.addEventListener('loadeddata', reveal, { once: true });
        }).catch(() => {});
      }).catch(() => {});
    }, 1800);
  }

  function setBackground(game, token) {
    artFor(game).then((art) => {
      if (token !== S.metaToken) return;
      const url = art.hero || art.portrait;
      const next = S.layerFlip ? els.layerA : els.layerB;
      const prev = S.layerFlip ? els.layerB : els.layerA;
      if (!url) {
        prev.classList.remove('is-on');
        next.classList.remove('is-on');
        return;
      }
      probe(url).then(() => {
        if (token !== S.metaToken) return;
        next.style.backgroundImage = `url("${url}")`;
        next.classList.add('is-on');
        prev.classList.remove('is-on');
        S.layerFlip = !S.layerFlip;
        // A short push-in makes the crossfade read as a move rather than a
        // dissolve. Cleared on a timer so a stalled renderer still settles.
        els.bg.style.setProperty('--bp-zoom', '1.025');
        clearTimeout(bgSwapTimer);
        bgSwapTimer = setTimeout(() => els.bg.style.setProperty('--bp-zoom', '1'), 700);
      }).catch(() => {});
    }).catch(() => {});
  }

  // ────────────────────────────────────────────────────────────────
  // The details page cycles the game's own screenshots behind the text, so a
  // game with no trailer still has a moving page. Two layers crossfade rather
  // than one swapping, and the next image is decoded before the swap so the
  // transition never shows a half-painted frame.
  //
  // It yields to the trailer: video wins whenever one is actually playing, and
  // the slideshow picks up again if the trailer is stopped from the page.
  // ────────────────────────────────────────────────────────────────
  const SHOT_INTERVAL = 9000;

  function stopSlideshow() {
    clearTimeout(shotTimer);
    shotTimer = 0;
  }

  function startSlideshow(shots, token) {
    stopSlideshow();
    S.shots = Array.isArray(shots) ? shots.filter(Boolean) : [];
    S.shotIndex = 0;
    if (S.shots.length < 2 || motionOff()) return;
    scheduleShot(token);
  }

  function scheduleShot(token) {
    clearTimeout(shotTimer);
    shotTimer = setTimeout(() => nextShot(token), SHOT_INTERVAL);
  }

  function nextShot(token) {
    if (token !== S.metaToken || S.view !== 'details' || !S.open) return stopSlideshow();
    // The trailer owns the background while it plays; keep the rotation ticking
    // so it resumes in place the moment the video is stopped.
    if (S.trailerOn) return scheduleShot(token);

    S.shotIndex = (S.shotIndex + 1) % S.shots.length;
    const url = S.shots[S.shotIndex];
    probe(url).then(() => {
      if (token !== S.metaToken || S.view !== 'details') return;
      const next = S.shotFlip ? els.detBg : els.detBg2;
      const prev = S.shotFlip ? els.detBg2 : els.detBg;
      next.style.backgroundImage = `url("${url}")`;
      next.classList.add('is-on');
      prev.classList.remove('is-on');
      S.shotFlip = !S.shotFlip;
      scheduleShot(token);
    }).catch(() => scheduleShot(token));
  }

  // ════════════════════════════════════════════════════════════════
  // Details view
  // ════════════════════════════════════════════════════════════════

  /**
   * Online mode, read from disk for the open game.
   *
   * The eligibility rules live in the main process and are deliberately strict:
   * a game that cannot use online mode must not be offered a switch that will
   * not work. A multiplayer game that is merely *not ready* still shows the
   * button, disabled, with the reason — silence would read as a missing feature.
   */
  function loadOnline(game, token) {
    S.online = null;
    if (!api()?.getOnlineStatus || !game?.install_path) return;
    api().getOnlineStatus(game).then((res) => {
      if (token !== S.metaToken || S.view !== 'details') return;
      if (!res?.ok) return;
      const { eligibility, status } = res;
      if (!eligibility?.eligible) {
        if (eligibility?.backend === 'none') return;    // single-player: nothing to say
        S.online = { state: 'unavailable', reason: eligibility?.reasons?.[0] || '', backend: eligibility?.backend };
      } else {
        S.online = { state: 'ready', on: status?.mode === 'online', backend: eligibility.backend };
      }
      renderDetActions(game);
    }).catch(() => {});
  }

  async function toggleOnline(game) {
    if (!S.online || S.online.state !== 'ready' || S.online.busy) return;
    const turningOn = !S.online.on;
    S.online.busy = true;
    renderDetActions(game);

    let res;
    try { res = await api()?.setOnlineMode?.({ game, enabled: turningOn }); }
    catch (e) { res = { success: false, error: e.message }; }

    const b = bridge();
    if (res?.success) {
      b?.toast?.(turningOn ? 'Online mode on — launch with Steam running' : 'Back to offline mode', 'success');
    } else {
      b?.toast?.(`Could not switch: ${res?.error || 'unknown error'}`, 'error');
    }
    S.online.busy = false;
    // Re-read from disk rather than assume the write landed.
    loadOnline(game, S.metaToken);
    renderDetActions(game);
  }

  function renderDetActions(game) {
    const b = bridge();
    const running = Boolean(b?.isGameRunning?.(game));
    const installed = isInstalled(game);

    const acts = [{
      act: 'play',
      label: running ? 'Stop' : installed ? 'Play' : 'Install',
      cls: 'is-primary',
    }];

    // Sits immediately after Play, because that is the one thing you want
    // instead of playing when a game is out of date.
    if (installed && hasUpdate(game)) {
      acts.push({ act: 'update', label: S.updating ? 'Preparing…' : 'Update', cls: 'is-update', disabled: S.updating });
    }

    acts.push({ act: 'options', label: 'Game Options' });

    if (S.online?.state === 'ready') {
      acts.push({
        act: 'online',
        label: S.online.busy ? 'Switching…' : `Online · ${S.online.on ? 'On' : 'Off'}`,
        cls: `is-toggle${S.online.on ? ' is-toggle-on' : ''}`,
        disabled: S.online.busy,
      });
    } else if (S.online?.state === 'unavailable') {
      acts.push({ act: 'online', label: 'Online · unavailable', cls: 'is-toggle', disabled: true });
    }

    acts.push(
      { act: 'trailer', round: true, title: 'Trailer', icon: S.trailerOn ? ICON.stop : ICON.box },
      { act: 'mute', round: true, title: 'Sound', icon: S.muted ? ICON.mute : ICON.sound },
      { act: 'expand', round: true, title: 'Fill the screen', icon: ICON.expand },
    );

    els.detActions.innerHTML = acts.map((a) => {
      const cls = ['bp-act', a.cls || '', a.round ? 'is-round' : ''].filter(Boolean).join(' ');
      const body = a.round ? svg(a.icon) : esc(a.label);
      const label = a.title ? ` title="${esc(a.title)}" data-label="${esc(a.title)}"` : '';
      return `<button class="${cls}" data-act="${a.act}"${label}${a.disabled ? ' disabled' : ''}>${body}</button>`;
    }).join('');

    // The row's length changes as the update and online buttons appear, so the
    // cursor is clamped rather than left pointing past the end.
    S.actIndex = clamp(S.actIndex, 0, acts.length - 1);
    els.detNote.textContent = S.online?.state === 'unavailable' ? (S.online.reason || '') : '';
    paintActCursor();
  }

  // ────────────────────────────────────────────────────────────────
  // Updating, on Big Picture's own terms.
  //
  // The desktop path answers with a toast and drops you on its Downloads page.
  // Neither belongs here, and a game whose stored "update available" flag has
  // gone stale must say so rather than appearing to do nothing: that flag is
  // persisted between sessions, so it outlives the update it describes.
  // ────────────────────────────────────────────────────────────────
  function showUpdateScreen(game, { text, mode }) {
    S.view = 'update';
    els.update.classList.add('is-on');
    els.update.dataset.mode = mode;              // busy · done · error · live
    els.updName.textContent = game.game_name || 'Update';
    els.updText.textContent = text;
    els.updStats.textContent = '';
    els.updFill.style.width = '0%';
    artFor(game).then((art) => {
      if (S.view !== 'update') return;
      els.updArt.style.backgroundImage = art.portrait ? `url("${art.portrait}")` : 'none';
    }).catch(() => {});
  }

  function closeUpdateScreen() {
    els.update.classList.remove('is-on');
    S.view = els.details.classList.contains('is-on') ? 'details' : 'browse';
  }

  /** Live percentage, once the job is actually running. */
  function paintUpdateProgress() {
    if (S.view !== 'update' || els.update.dataset.mode !== 'live') return;
    const dl = S.download;
    if (!dl || !dl.active) return;
    const pct = clamp(Math.round(Number(dl.percent) || 0), 0, 100);
    els.updFill.style.width = `${pct}%`;
    els.updText.textContent = `${dl.jobType === 'update' ? 'Updating' : 'Downloading'} · ${pct}%`;
    els.updStats.textContent = [dl.paused ? 'Paused' : dl.speed, dl.paused ? '' : dl.eta, dl.sizeText]
      .filter(Boolean).join('   ·   ');
  }

  async function startUpdate(game) {
    if (S.updating) return;
    S.updating = true;
    renderDetActions(game);
    showUpdateScreen(game, { text: 'Checking for a newer build…', mode: 'busy' });
    Sound.play('open');

    let result;
    try { result = await bridge()?.queueGameUpdate?.(game); }
    catch (e) { result = { queued: false, reason: 'error', message: e.message }; }

    S.updating = false;
    renderCards();
    if (els.details.classList.contains('is-on')) renderDetActions(game);
    if (S.view !== 'update') return;             // the user walked away

    if (result?.queued) {
      els.update.dataset.mode = 'live';
      els.updText.textContent = 'Update queued — starting…';
      paintUpdateProgress();
      return;
    }

    // Nothing was queued. Say which of the several reasons it was, and leave
    // the message up long enough to read.
    els.update.dataset.mode = result?.reason === 'up-to-date' ? 'done' : 'error';
    els.updText.textContent = result?.message || 'Nothing to update.';
    Sound.play(result?.reason === 'up-to-date' ? 'select' : 'edge');
    setTimeout(() => { if (S.view === 'update') closeUpdateScreen(); }, 3200);
  }

  /**
   * Move the cursor by one, skipping anything disabled. The row's length varies
   * per game — Update and Online appear only when they apply — so it is read
   * from the DOM rather than from a fixed list.
   */
  function stepAction(delta) {
    const buttons = [...els.detActions.children];
    if (!buttons.length) return 0;
    let i = S.actIndex;
    for (let n = 0; n < buttons.length; n++) {
      const next = i + delta;
      if (next < 0 || next >= buttons.length) return i;
      i = next;
      if (!buttons[i].disabled) return i;
    }
    return S.actIndex;
  }

  function paintActCursor() {
    [...els.detActions.children].forEach((btn, i) => btn.classList.toggle('is-cursor', i === S.actIndex));
  }

  function statCell(label, value) {
    return `<div><div class="bp-stat-label">${esc(label)}</div><div class="bp-stat-value">${esc(value || '—')}</div></div>`;
  }

  function statusOf(game) {
    if (bridge()?.isGameRunning?.(game)) return 'Running';
    if (!isInstalled(game)) return 'Not installed';
    if (hasUpdate(game)) return 'Update available';
    return game.playtime_seconds > 0 ? 'Played' : 'Installed';
  }

  function collectionsOf(game) {
    const b = bridge();
    const key = b?.favKey?.(game) || '';
    const all = b?.getCollections?.() || {};
    return Object.keys(all).filter((name) => (all[name] || []).includes(key));
  }

  /**
   * Morph the selected cover into (or out of) the details view.
   *
   * A clone of the card is scaled up to fill the stage while the details page
   * fades in underneath it, so the cover reads as *becoming* the page rather
   * than being replaced by it. Everything lands on its final state from a
   * timer rather than a frame callback, so a backgrounded renderer degrades to
   * an un-animated cut instead of a stuck clone.
   */
  function flyCard(card, direction) {
    if (!card || motionOff() || framesStalled()) return 0;

    const rect = card.getBoundingClientRect();
    const view = els.root.getBoundingClientRect();
    if (!rect.width || !view.width) return 0;

    const img = card.querySelector('.bp-card-art img');
    const clone = document.createElement('div');
    clone.className = 'bp-fly';
    if (img?.src) clone.style.backgroundImage = `url("${img.src}")`;
    clone.style.left = `${rect.left}px`;
    clone.style.top = `${rect.top}px`;
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    if (els.root.dataset.rounded === 'on') clone.style.borderRadius = getComputedStyle(card).borderRadius;

    // Cover the stage from the card's own box.
    const scale = Math.max(view.width / rect.width, view.height / rect.height);
    const dx = view.width / 2 - (rect.left + rect.width / 2);
    const dy = view.height / 2 - (rect.top + rect.height / 2);
    const big = `translate(${dx}px, ${dy}px) scale(${scale})`;

    els.root.appendChild(clone);
    if (direction === 'in') {
      clone.style.transform = 'none';
      clone.style.opacity = '1';
      setTimeout(() => {
        clone.classList.add('is-flying');
        clone.style.transform = big;
        clone.style.opacity = '0';
      }, 0);
    } else {
      clone.style.transform = big;
      clone.style.opacity = '0.9';
      setTimeout(() => {
        clone.classList.add('is-flying');
        clone.style.transform = 'none';
        clone.style.opacity = '0';
      }, 0);
    }

    setTimeout(() => clone.remove(), 700);
    return 1;
  }

  // ────────────────────────────────────────────────────────────────
  // Details: tabs and their panels
  //
  // A tab only exists once there is something behind it — a game with no
  // achievements should not offer an empty Achievements tab and make the user
  // find that out by pressing it. So the bar is rebuilt as each source lands,
  // keeping whatever tab the user was on.
  // ────────────────────────────────────────────────────────────────
  function detPanel() {
    return els.detPanels?.querySelector('.bp-det-panel.is-on') || null;
  }

  function detCells() {
    const panel = detPanel();
    return panel ? [...panel.querySelectorAll('[data-cell]')] : [];
  }

  function paintDetCursor() {
    const tabs = [...(els.detTabs?.children || [])];
    tabs.forEach((el, i) => {
      el.classList.toggle('is-on', i === S.tabIndex);
      el.classList.toggle('is-cursor', S.detRow === 1 && i === S.tabIndex);
    });

    const cells = detCells();
    S.cellIndex = clamp(S.cellIndex, 0, Math.max(0, cells.length - 1));
    cells.forEach((el, i) => el.classList.toggle('is-cursor', S.detRow === 2 && i === S.cellIndex));
    if (S.detRow === 2 && !framesStalled()) {
      cells[S.cellIndex]?.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: motionOff() ? 'auto' : 'smooth' });
    }

    els.details.dataset.row = String(S.detRow);
    paintActCursor();
  }

  function availableTabs() {
    const tabs = [{ id: 'overview', label: 'Overview' }];
    if (S.ach?.total) tabs.push({ id: 'achievements', label: 'Achievements', badge: `${S.ach.unlocked}/${S.ach.total}` });
    if (S.shots?.length) tabs.push({ id: 'screenshots', label: 'Screenshots', badge: String(S.shots.length) });
    if (S.news?.length) tabs.push({ id: 'news', label: "What's New", badge: String(S.news.length) });
    return tabs;
  }

  function renderDetTabs() {
    const wanted = S.tabs[S.tabIndex]?.id || 'overview';
    S.tabs = availableTabs();
    S.tabIndex = Math.max(0, S.tabs.findIndex((t) => t.id === wanted));

    els.detTabs.innerHTML = S.tabs.map((t) => `
      <button class="bp-tab" role="tab" data-tab="${t.id}">
        <span>${esc(t.label)}</span>${t.badge ? `<i class="bp-tab-badge">${esc(t.badge)}</i>` : ''}
      </button>`).join('');

    // One tab is no tab: the bar only earns its space once there is a choice.
    els.detTabs.hidden = S.tabs.length < 2;
    if (els.detTabs.hidden && S.detRow > 0) S.detRow = 0;
    showDetPanel();
  }

  function showDetPanel() {
    const id = S.tabs[S.tabIndex]?.id || 'overview';
    els.detPanels.querySelectorAll('.bp-det-panel')
      .forEach((p) => p.classList.toggle('is-on', p.dataset.tab === id));
    S.cellIndex = 0;
    paintDetCursor();
  }

  /** The definitions carry plain disk paths; an <img> needs a file URL. */
  function achArt(a) {
    return fileUrl(a.unlocked ? (a.icon || a.iconLocked) : (a.iconLocked || a.icon));
  }

  function achHead(snap) {
    return `
      <div class="bp-ach-head">
        <div class="bp-ach-count">${snap.unlocked}<span> / ${snap.total}</span></div>
        <div class="bp-ach-bar"><i style="width:${snap.percent}%"></i></div>
        <div class="bp-ach-pct">${snap.percent}%</div>
      </div>`;
  }

  function renderAchPanel() {
    const snap = S.ach;
    if (!snap?.total) { els.detAch.innerHTML = ''; return; }

    // Unlocked first — the snapshot already sorts by unlock time — then the
    // rest, so the strip opens on what you just did rather than on a wall of
    // padlocks.
    const tile = (a) => {
      const art = achArt(a);
      return `
        <div class="bp-ach-tile${a.unlocked ? ' is-got' : ''}" data-cell>
          <div class="bp-ach-ico"${art ? ` style="background-image:url('${esc(art)}')"` : ''}></div>
          <div class="bp-ach-txt">
            <div class="bp-ach-name">${esc(a.title || a.name)}</div>
            <div class="bp-ach-desc">${esc(a.description || (a.unlocked ? 'Unlocked' : 'Locked'))}</div>
          </div>
        </div>`;
    };

    els.detAch.innerHTML = achHead(snap) + `
      <div class="bp-ach-strip">${snap.items.slice(0, 40).map(tile).join('')}</div>`;
  }

  /**
   * The same progress, on the overview.
   *
   * Achievements are the one thing on this page that changes while you play, so
   * they should not be behind a tab press — the overview shows how far along you
   * are and the last few you earned, and the tab is there for the whole list.
   */
  function renderAchBar() {
    const snap = S.ach;
    if (!snap?.total) { els.detAchBar.innerHTML = ''; els.detAchBar.hidden = true; return; }
    els.detAchBar.hidden = false;

    const recent = snap.items.filter((a) => a.unlocked).slice(0, 6);
    const pips = recent.map((a) => {
      const art = achArt(a);
      return `<div class="bp-achpip" title="${esc(a.title || a.name)}"${art ? ` style="background-image:url('${esc(art)}')"` : ''}></div>`;
    }).join('');

    els.detAchBar.innerHTML = achHead(snap)
      + (pips ? `<div class="bp-achpips">${pips}</div>` : '');
  }

  function renderShotsPanel() {
    const shots = S.shots || [];
    els.detShots.innerHTML = shots.length
      ? `<div class="bp-shot-strip">${shots.slice(0, 16).map((s, i) => `
          <button class="bp-shot" data-cell data-shot="${i}" style="background-image:url('${esc(s)}')" aria-label="Screenshot ${i + 1}"></button>`).join('')}</div>`
      : '';
  }

  function renderNewsPanel() {
    const items = S.news || [];
    els.detNews.innerHTML = items.length
      ? `<div class="bp-detnews-list">${items.slice(0, 6).map((n) => `
          <div class="bp-detnews-item${n.isPatch ? ' is-patch' : ''}" data-cell>
            <div class="bp-detnews-meta">${n.isPatch ? '<span class="bp-news-tag">Patch</span>' : ''}<span>${esc(fmtNewsDate(n.date))}</span></div>
            <div class="bp-detnews-title">${esc(n.title || 'Untitled')}</div>
            <div class="bp-detnews-body">${esc((n.body || '').slice(0, 260))}</div>
          </div>`).join('')}</div>`
      : '';
  }

  /**
   * The overview columns.
   *
   * Every line here is either a fact or absent — a page of "—" and "None" reads
   * as broken rather than as empty. Metacritic covers a small minority of a
   * library like this, so the score line falls back to Steam's own review
   * summary, which exists for nearly everything.
   */
  function renderDetStats(game, meta) {
    const rows = [];
    const add = (label, value) => { if (value) rows.push(statCell(label, value)); };

    add('Time Played', game.playtime_seconds > 0 ? fmtPlaytime(game.playtime_seconds) : 'Never');
    add('Last Played', game.last_played ? fmtRelative(game.last_played) : 'Never');
    add('Status', statusOf(game));
    add('Release Date', meta?.release_date);

    const score = meta?.metacritic?.score
      ? `${meta.metacritic.score} · Metacritic`
      : meta?.reviews
        ? `${meta.reviews.percent}% · ${meta.reviews.desc}`
        : '';
    add('Score', score);
    add('Reviews', meta?.reviews ? `${meta.reviews.total.toLocaleString()} on Steam` : '');
    add('Size on Disk', game.size_on_disk ? fmtSize(game.size_on_disk) : '');
    add('Library', game.source);
    if (S.online?.state === 'ready') add('Online Mode', S.online.on ? 'On' : 'Off');
    if (S.ach?.total) add('Achievements', `${S.ach.unlocked} of ${S.ach.total} · ${S.ach.percent}%`);

    els.detStats.innerHTML = rows.join('');
    // The cards arrive one after another rather than all at once; 30ms apart is
    // enough to read as a sweep and short enough not to feel slow.
    [...els.detStats.children].forEach((el, i) => { el.style.animationDelay = `${i * 30}ms`; });

    const cols = collectionsOf(game);
    const tags = [];
    const addTag = (label, value) => { if (value) tags.push(statCell(label, value)); };
    addTag('Platforms', 'Windows');
    addTag('Genres', meta?.genres?.join(', '));
    addTag('Developers', meta?.developers?.join(', '));
    addTag('Publishers', meta?.publishers?.join(', '));
    addTag('Features', meta?.categories?.slice(0, 3).join(', '));
    addTag('Collections', cols.length ? cols.join(', ') : '');
    els.detTags.innerHTML = tags.join('');
    [...els.detTags.children].forEach((el, i) => { el.style.animationDelay = `${i * 30}ms`; });
  }

  /** A cell was chosen: screenshots become the backdrop, the rest just sit there. */
  function activateDetCell() {
    const cell = detCells()[S.cellIndex];
    if (!cell) return false;
    const shot = cell.dataset.shot;
    if (shot !== undefined) {
      const url = S.shots[Number(shot)];
      if (url) {
        stopSlideshow();
        els.detBg.style.backgroundImage = `url("${url}")`;
        els.detBg.classList.add('is-on');
        els.detBg2.classList.remove('is-on');
        Sound.play('select');
      }
      return true;
    }
    return false;
  }

  function openDetails({ morph = true } = {}) {
    const game = current();
    if (!game) return;

    stopShelfTrailer();
    if (morph) flyCard(cardAt(S.index), 'in');

    S.view = 'details';
    S.actIndex = 0;
    S.detRow = 0;
    S.tabIndex = 0;
    S.cellIndex = 0;
    S.ach = null;
    S.news = null;
    S.shots = [];
    S.detMeta = null;
    S.trailerOn = false;
    els.details.classList.add('is-on');

    const b = bridge();
    els.detTopName.textContent = game.game_name || '';
    els.detName.textContent = game.game_name || 'Unknown';
    els.detName.hidden = false;
    els.detLogo.hidden = true;

    const fav = Boolean(b?.isFavorite?.(game));
    els.detSub.innerHTML = `${svg(ICON.star, `bp-star${fav ? '' : ' is-off'}`)}<span>${esc(game.source || 'Library')}</span>`;

    renderDetActions(game);
    els.detDesc.textContent = localBlurb(game);
    els.detBg2.classList.remove('is-on');
    S.shotFlip = false;
    stopSlideshow();

    renderDetStats(game, null);
    renderAchPanel();
    renderAchBar();
    renderShotsPanel();
    renderNewsPanel();
    renderDetTabs();

    // Art first (it is cached), metadata second.
    const token = ++S.metaToken;
    loadOnline(game, token);
    artFor(game).then((art) => {
      if (token !== S.metaToken) return;
      if (art.hero || art.portrait) {
        els.detBg.style.backgroundImage = `url("${art.hero || art.portrait}")`;
        els.detBg.classList.add('is-on');
      }
      if (art.logo && prefs().bigpicture_logos !== false) {
        els.detLogo.onload = () => {
          if (token !== S.metaToken) return;
          els.detLogo.hidden = false;
          els.detName.hidden = true;
        };
        els.detLogo.src = art.logo;
      }
    }).catch(() => {});

    // Achievements and patch notes are their own tabs, and each rebuilds the bar
    // when it lands. Neither blocks the other, or the page.
    Promise.resolve(api()?.getAchievements?.(game)).then((snap) => {
      if (token !== S.metaToken || !snap?.total) return;
      S.ach = snap;
      renderAchPanel();
      renderAchBar();
      renderDetStats(game, S.detMeta);
      renderDetTabs();
    }).catch(() => {});

    const newsId = appIdOf(game);
    if (newsId) {
      Promise.resolve(api()?.getPatchNotes?.(newsId)).then((res) => {
        if (token !== S.metaToken) return;
        S.news = res?.items || [];
        if (!S.news.length) return;
        renderNewsPanel();
        renderDetTabs();
      }).catch(() => {});
    }

    metaFor(game).then((meta) => {
      if (token !== S.metaToken || !meta) return;
      if (meta.short_description) els.detDesc.textContent = meta.short_description;

      S.detMeta = meta;
      renderDetStats(game, meta);

      // Screenshots run behind the page whenever a video is not, and fill their
      // own tab.
      const shots = (meta.screenshots || []).map((s) => s.full || s.thumbnail).filter(Boolean);
      startSlideshow(shots, token);
      renderShotsPanel();
      renderDetTabs();

      const movie = meta.movies?.[0];
      if (movie && prefs().bigpicture_trailers !== false && setTrailerSources(els.detVideo, movie)) {
        els.detVideo.muted = S.muted;
        const reveal = () => {
          if (token !== S.metaToken || S.view !== 'details' || !els.detVideo.videoWidth) return;
          els.detVideo.classList.add('is-on');
          S.trailerOn = true;
          renderDetActions(game);
        };

        /*
         * The trailer used to loop, so it never ended and the page stayed a
         * looping video for as long as you left it there. Playing it once and
         * handing the background back to the screenshots gives the page an
         * arc: the trailer says its piece, then the art takes over.
         */
        els.detVideo.addEventListener('ended', () => {
          if (token !== S.metaToken || S.view !== 'details') return;
          els.detVideo.classList.remove('is-on');
          S.trailerOn = false;
          renderDetActions(game);
          startSlideshow(shots, token);
        }, { once: true });
        // A beat of stillness first — the trailer should feel like it faded in,
        // not like the page loaded a video.
        setTimeout(() => {
          if (token !== S.metaToken || S.view !== 'details') return;
          els.detVideo.play().then(() => {
            if (els.detVideo.readyState >= 2) reveal();
            else els.detVideo.addEventListener('loadeddata', reveal, { once: true });
          }).catch(() => {});
        }, 900);
      }
    }).catch(() => {});

    Sound.play('open');
  }

  function closeDetails() {
    S.view = 'browse';
    els.details.classList.remove('is-on');
    stopSlideshow();
    S.online = null;
    stopTrailer();
    Sound.play('close');
    // Repaint: favourites or playtime may have changed while the view was open.
    select(S.index, { animate: false, force: true });
    renderCards();
    flyCard(cardAt(S.index), 'out');
  }

  function stopTrailer() {
    S.trailerOn = false;
    els.detVideo.classList.remove('is-on');
    clearTrailer(els.detVideo);
  }

  function detAction(id) {
    const game = current();
    if (!game) return;
    switch (id) {
      case 'play': play(); break;
      case 'options': openMenu(); break;
      case 'trailer':
        if (S.trailerOn) { stopTrailer(); renderDetActions(game); }
        else if (els.detVideo.childElementCount || els.detVideo._librarianHls) {
          els.detVideo.play().then(() => {
            els.detVideo.classList.add('is-on');
            S.trailerOn = true;
            renderDetActions(game);
          }).catch(() => {});
        }
        break;
      case 'mute':
        S.muted = !S.muted;
        els.detVideo.muted = S.muted;
        renderDetActions(game);
        break;
      case 'update': startUpdate(game); break;
      case 'online': toggleOnline(game); break;
      case 'expand':
        els.detVideo.style.objectFit = els.detVideo.style.objectFit === 'contain' ? 'cover' : 'contain';
        break;
      default: break;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // Sheets — options, filter, system
  // ════════════════════════════════════════════════════════════════
  let rows = [];   // the active sheet's rows: { label, value, run, icon, danger, disabled }

  function rowHtml(row, i) {
    if (row.sep) return '<div class="bp-row-sep" aria-hidden="true"></div>';
    const cls = ['bp-row'];
    if (row.danger) cls.push('is-danger');
    if (i === S.rowIndex) cls.push('is-cursor');
    const value = row.toggle !== undefined
      ? `<span class="bp-switch${row.toggle ? ' is-on' : ''}"></span>`
      : row.value ? `<span class="bp-row-value">${esc(row.value)}</span>` : '';
    return `<button class="${cls.join(' ')}" data-ri="${i}"${row.disabled ? ' disabled' : ''}>
      ${row.icon ? svg(row.icon) : ''}
      <span class="bp-row-label">${esc(row.label)}</span>${value}
    </button>`;
  }

  /** Never leave the cursor parked on a separator or a disabled row. */
  function settleRowIndex() {
    S.rowIndex = clamp(S.rowIndex, 0, Math.max(0, rows.length - 1));
    for (let n = 0; n < rows.length; n++) {
      const row = rows[S.rowIndex];
      if (row && !row.sep && !row.disabled) return;
      S.rowIndex = (S.rowIndex + 1) % rows.length;
    }
  }

  function paintRows(host) {
    settleRowIndex();
    host.innerHTML = rows.map(rowHtml).join('');
  }

  /* Separators are rendered too, so rows are addressed by data-ri, never by
     child position. */
  function paintRowCursor(host) {
    host.querySelectorAll('.bp-row').forEach((row) => {
      const on = Number(row.dataset.ri) === S.rowIndex;
      row.classList.toggle('is-cursor', on);
      if (on) row.scrollIntoView?.({ block: 'nearest' });
    });
  }

  const rowEl = (host) => host.querySelector(`.bp-row[data-ri="${S.rowIndex}"]`);

  const SHEET_VIEWS = ['menu', 'filter', 'system', 'confirm', 'downloads', 'store'];
  const isSheet = (view) => SHEET_VIEWS.includes(view);

  const sheetHost = () => (
    S.view === 'menu' ? els.menuRows
      : S.view === 'filter' ? els.filterRows
        : S.view === 'downloads' ? els.dlRows
          : S.view === 'store' ? els.storeRows
            : els.systemRows
  );

  /**
   * What the emulator has been told about this game's DLC.
   *
   * A local file read, so it is cheap — but it is still asynchronous, and the
   * options sheet is built synchronously. The sheet therefore draws once
   * without the row and redraws with it, which is invisible at file-read speed
   * and avoids making the whole menu wait on disk.
   */
  async function loadDlc(game) {
    const key = `${game?.appid || ''}|${game?.install_path || ''}`;
    let st = null;
    try { st = await api()?.dlcStatus?.(game?.install_path); } catch { /* not cracked, or gone */ }
    const state = { key, ready: false, unlockAll: false, items: [], ...(st || {}) };

    // A game with nothing to unlock should not be offered the switch. The list
    // is cached for a week on the other side, and a lookup that fails leaves
    // the row in place — not being able to ask is not an answer.
    if (state.ready && !state.unlockAll) {
      let found = null;
      try { found = await api()?.listDlc?.(game?.appid); } catch { /* offline */ }
      if (found && !found.unknown && !found.items.length) state.ready = false;
    }

    S.dlc = state;
    return S.dlc;
  }

  function openMenu() {
    const game = current();
    const b = bridge();
    if (!game || !b) return;

    const dlcKey = `${game.appid || ''}|${game.install_path || ''}`;
    if (S.dlc?.key !== dlcKey) {
      S.dlc = null;
      // Re-opens itself once the answer is in; the key check above stops that
      // from becoming a loop.
      loadDlc(game).then(() => { if (S.view === 'menu') safely('menu-dlc', openMenu); });
    }

    const running = Boolean(b.isGameRunning?.(game));
    const installed = isInstalled(game);
    const fav = Boolean(b.isFavorite?.(game));
    const collections = Object.keys(b.getCollections?.() || {}).sort((a, z) => a.localeCompare(z));
    const mine = new Set(collectionsOf(game));

    rows = [
      running
        ? { label: 'Stop', icon: ICON.stop, run: () => { b.stopGame?.(game); closeSheet(); } }
        : { label: installed ? 'Play' : 'Install', icon: ICON.play, run: () => { closeSheet(); play(); } },
      { label: 'Details', icon: ICON.search, run: () => { closeSheet(); openDetails(); } },
      {
        label: fav ? 'Remove from favorites' : 'Add to favorites',
        icon: ICON.heart,
        run: async () => {
          await b.toggleFavorite?.(game);
          popStar();
          openMenu();
          renderCards();
          select(S.index, { animate: false, force: true });
        },
      },
    ];

    if (installed && appIdOf(game)) {
      rows.push(hasUpdate(game)
        ? {
          label: 'Update now',
          icon: ICON.download,
          run: () => { closeSheet(); leaveFor(() => b.queueGameUpdate?.(game), 'Update queued on the desktop view'); },
        }
        : {
          label: 'Check for update',
          icon: ICON.download,
          run: async () => {
            rows[S.rowIndex] = { ...rows[S.rowIndex], label: 'Checking…', disabled: true };
            paintRows(els.menuRows);
            const result = await b.checkUpdateFor?.(game);
            b.toast?.(
              result?.status === 'update_available'
                ? `${game.game_name}: build ${result.localBuildId} → ${result.remoteBuildId}`
                : result?.status === 'up_to_date' ? `${game.game_name} is up to date`
                  : result?.reason || 'Could not reach the update service',
              result?.status === 'up_to_date' ? 'success' : result?.status === 'update_available' ? '' : 'error',
            );
            renderCards();
            select(S.index, { animate: false, force: true });
            openMenu();
          },
        });
      rows.push({
        label: 'Verify & repair',
        icon: ICON.wrench,
        run: () => { closeSheet(); leaveFor(() => b.queueGameRepair?.(game), 'Repair queued on the desktop view'); },
      });
    }

    if (installed) {
      if (appIdOf(game)) {
      rows.push({
        label: 'Achievements',
        icon: ICON.trophy,
        run: () => { closeSheet(); openAchievements(game); },
      });
      rows.push({
        label: 'Patch notes',
        icon: ICON.news,
        run: () => { closeSheet(); openPatchNotes(game); },
      });

      // Only offered for a cracked game: without steam_settings there is no
      // emulator to tell, and a row that silently does nothing is worse than
      // no row at all.
      const dlc = S.dlc;
      if (dlc?.ready) {
        rows.push({
          label: 'DLC',
          icon: ICON.layers,
          value: dlc.unlockAll ? (dlc.items.length ? `Unlocked · ${dlc.items.length}` : 'Unlocked') : 'Locked',
          run: async () => {
            const idx = S.rowIndex;
            rows[idx] = { ...rows[idx], label: dlc.unlockAll ? 'Locking…' : 'Unlocking…', disabled: true };
            paintRows(els.menuRows);

            const api_ = api();
            const result = dlc.unlockAll
              ? await api_?.disableDlc?.(game.install_path)
              : await api_?.applyDlc?.({ gamePath: game.install_path, appId: appIdOf(game), unlockAll: true });

            if (result?.success) {
              b.toast?.(dlc.unlockAll
                ? `${game.game_name}: DLC locked again`
                : `${game.game_name}: DLC unlocked${result.count ? ` · ${result.count} listed` : ''}`,
              'success');
            } else {
              b.toast?.(result?.error || 'Could not write the emulator config', 'error');
            }
            await loadDlc(game);
            openMenu();
          },
        });
      }
    }

    rows.push({ label: 'Open install folder', icon: ICON.folder, run: () => { b.openPath?.(game.install_path); closeSheet(); } });
    }

    if (collections.length) {
      rows.push({ sep: true });
      for (const name of collections) {
        rows.push({
          label: name,
          icon: mine.has(name) ? ICON.check : ICON.layers,
          value: mine.has(name) ? 'In' : '',
          run: async () => {
            await b.toggleCollectionMember?.(name, game);
            openMenu();
          },
        });
      }
    }

    rows.push({ sep: true });
    rows.push({
      label: 'Manage on the desktop…',
      icon: ICON.exit,
      run: () => { closeSheet(); leaveFor(() => b.openFlyout?.(game), ''); },
    });

    S.rowIndex = 0;
    S.view = 'menu';
    els.menuSub.textContent = game.game_name || '';
    paintRows(els.menuRows);
    els.menu.classList.add('is-on');
    Sound.play('open');
  }

  function openFilter() {
    rows = [
      { label: 'Sort by', value: SORT_LABELS[S.filter.sort], icon: ICON.layers, cycle: true, run: () => cycleSort(1) },
      { label: 'Installed only', toggle: S.filter.installedOnly, icon: ICON.folder, run: () => toggleFilter('installedOnly') },
      { label: 'Favorites only', toggle: S.filter.favOnly, icon: ICON.heart, run: () => toggleFilter('favOnly') },
      { label: 'Updates only', toggle: S.filter.updatesOnly, icon: ICON.download, run: () => toggleFilter('updatesOnly') },
      { label: 'Clear filters', icon: ICON.back, run: () => {
        S.filter = { installedOnly: false, favOnly: false, updatesOnly: false, sort: 'name' };
        rebuildList();
        openFilter();
      } },
    ];
    S.rowIndex = clamp(S.rowIndex, 0, rows.length - 1);
    S.view = 'filter';
    paintRows(els.filterRows);
    els.filter.classList.add('is-on');
    Sound.play('open');
  }

  function cycleSort(delta) {
    const keys = Object.keys(SORTS);
    const at = keys.indexOf(S.filter.sort);
    S.filter.sort = keys[(((at === -1 ? 0 : at) + delta) % keys.length + keys.length) % keys.length];
    rebuildList();
    openFilter();
  }

  function toggleFilter(key) {
    S.filter[key] = !S.filter[key];
    rebuildList();
    openFilter();
  }

  function openSystem() {
    const p = prefs();
    rows = [
      { label: 'Resume', icon: ICON.back, run: () => closeSheet() },
      { label: 'Downloads', icon: ICON.download, value: downloadSummary(), run: () => { closeSheet(); openDownloads(); } },
      { label: 'Browse the store', icon: ICON.download, run: () => { closeSheet(); openStoreFront(); } },
      { label: 'Search the store', icon: ICON.search, run: () => { closeSheet(); S.searchMode = 'store'; openSearch(); } },
      { sep: true },
      {
        label: 'Layout',
        value: S.layout === 'grid' ? 'Grid' : 'Horizontal',
        icon: ICON.grid,
        run: () => { toggleLayout(); openSystem(); },
      },
      {
        label: 'Cover logos',
        toggle: p.bigpicture_logos !== false,
        icon: ICON.spark,
        run: () => setPref('bigpicture_logos', p.bigpicture_logos === false).then(openSystem),
      },
      {
        label: 'Rounded covers',
        toggle: p.bigpicture_rounded !== false,
        icon: ICON.box,
        run: () => setPref('bigpicture_rounded', p.bigpicture_rounded === false).then(() => { applyPrefs(); openSystem(); }),
      },
      {
        label: 'Trailer backgrounds',
        toggle: p.bigpicture_trailer_bg !== false,
        icon: ICON.spark,
        run: () => setPref('bigpicture_trailer_bg', p.bigpicture_trailer_bg === false).then(() => {
          // Off means off now, not at the next selection change.
          if (prefs().bigpicture_trailer_bg === false) stopShelfTrailer();
          else scheduleShelfTrailer(current(), S.metaToken);
          openSystem();
        }),
      },
      {
        label: 'Trailers in details',
        toggle: p.bigpicture_trailers !== false,
        icon: ICON.play,
        run: () => setPref('bigpicture_trailers', p.bigpicture_trailers === false).then(openSystem),
      },
      {
        label: 'Navigation sounds',
        toggle: p.bigpicture_sounds !== false,
        icon: ICON.sound,
        run: () => setPref('bigpicture_sounds', p.bigpicture_sounds === false).then(openSystem),
      },
      {
        label: 'Step aside on Play',
        toggle: p.bigpicture_minimize_on_play !== false,
        icon: ICON.exit,
        run: () => setPref('bigpicture_minimize_on_play', p.bigpicture_minimize_on_play === false).then(openSystem),
      },
      {
        label: 'Fullscreen',
        toggle: p.bigpicture_fullscreen !== false,
        icon: ICON.expand,
        run: () => {
          const next = p.bigpicture_fullscreen === false;
          setPref('bigpicture_fullscreen', next).then(() => {
            api()?.setFullScreen?.(next);
            openSystem();
          });
        },
      },
      { sep: true },
      { label: 'Leave Big Picture', icon: ICON.exit, danger: true, run: () => close() },
    ];
    S.rowIndex = clamp(S.rowIndex, 0, rows.length - 1);
    S.view = 'system';
    els.systemHead.textContent = 'Big Picture';
    paintRows(els.systemRows);
    els.system.classList.add('is-on');
    Sound.play('open');
  }

  async function setPref(key, value) {
    const b = bridge();
    try {
      await api()?.setSetting?.(key, value);
      await b?.refreshSettings?.();
    } catch (e) {
      console.error('[bigpicture] could not save', key, e);
    }
  }

  function closeSheet() {
    stopStoreMedia();
    const wasStore = els.store.classList.contains('is-on');
    els.store.classList.remove('is-on');
    els.ach.classList.remove('is-on');
    els.update.classList.remove('is-on');
    els.news.classList.remove('is-on');
    els.menu.classList.remove('is-on');
    els.filter.classList.remove('is-on');
    els.system.classList.remove('is-on');
    els.downloads.classList.remove('is-on');
    S.view = els.search.classList.contains('is-on') ? 'search'
      : els.details.classList.contains('is-on') ? 'details'
        : els.storefront.classList.contains('is-on') ? 'storefront'
          : 'browse';
    // Backing out of a store page opened from the front page returns you to
    // the shelf you were on, with the cursor where you left it.
    if (wasStore && S.view === 'storefront') paintSfCursor();
    paintHints();
    Sound.play('close');
  }

  function runRow() {
    const row = rows[S.rowIndex];
    if (!row || row.disabled || row.sep) return;
    const el = rowEl(sheetHost());
    if (el) {
      el.classList.add('is-press');
      setTimeout(() => el.classList.remove('is-press'), 130);
    }
    Sound.play('select');
    safely('row', () => row.run?.());
  }

  // ════════════════════════════════════════════════════════════════
  // Search — the local library and the store, from one overlay.
  // ════════════════════════════════════════════════════════════════
  const KEY_COUNT = KEY_AT.length;
  let storeTimer = 0;
  let storeToken = 0;

  function openSearch() {
    stopShelfTrailer();
    S.view = 'search';
    S.searchZone = 'keys';
    S.keyIndex = 0;
    S.resultIndex = 0;
    S.oskTarget = els.query;
    els.search.classList.add('is-on');
    els.query.value = S.query;
    paintSearchMode();
    paintHints();
    paintKeys();
    runSearch();
    Sound.play('open');
    // Focusing lets a real keyboard type straight in; the OSK is for pads.
    setTimeout(() => els.query.focus({ preventScroll: true }), 60);
  }

  /**
   * Y from inside the store searches the store.
   *
   * openSearch() honours whatever S.searchMode was last set to, which is the
   * library by default — so the search button pressed on the store front used
   * to open a search of the games you already own, which is the one place it
   * cannot mean.
   */
  function openStoreSearch() {
    if (S.view === 'storefront') closeStoreFront();
    S.searchMode = 'store';
    openSearch();
  }

  function closeSearch() {
    els.search.classList.remove('is-on');
    els.query.blur();
    S.oskTarget = null;
    S.view = 'browse';
    paintHints();
    Sound.play('close');
  }

  function setSearchMode(mode) {
    if (S.searchMode === mode) return;
    S.searchMode = mode;
    S.resultIndex = 0;
    paintSearchMode();
    paintHints();
    runSearch();
    Sound.play('move');
  }

  function paintSearchMode() {
    [...els.searchTabs.querySelectorAll('.bp-tab')].forEach((tab) => {
      tab.classList.toggle('is-on', tab.dataset.mode === S.searchMode);
    });
    els.query.placeholder = S.searchMode === 'store'
      ? 'Search the store to download'
      : 'Search your library';
  }

  function paintKeys() {
    [...els.keys.children].forEach((key, i) => {
      key.classList.toggle('is-cursor', S.searchZone === 'keys' && i === S.keyIndex);
    });
  }

  function paintResultCursor() {
    [...els.results.children].forEach((card, i) => {
      card.classList.toggle('is-sel', S.searchZone === 'results' && i === S.resultIndex);
    });
    if (S.searchZone === 'results') {
      els.results.children[S.resultIndex]?.scrollIntoView?.({ block: 'nearest' });
    }
  }

  const runSearch = () => (S.searchMode === 'store' ? runStoreSearch() : runLibrarySearch());

  function runLibrarySearch() {
    const b = bridge();
    const query = S.query.trim();
    const games = b?.games || [];
    storeToken++;                     // abandon any store request still in flight
    clearTimeout(storeTimer);

    S.results = !query
      ? games.slice(0, 24)
      : games
        .map((g) => ({ g, hit: b?.fuzzyMatch?.(g.game_name || '', query) }))
        .filter((row) => row.hit)
        .sort((a, z) => (z.hit.score || 0) - (a.hit.score || 0))
        .slice(0, 24)
        .map((row) => row.g);

    els.results.innerHTML = S.results.map(cardHtml).join('');
    [...els.results.children].forEach((card, i) => {
      card.classList.remove('is-enter', 'is-entering');
      hydrateArt(card, S.results[i]);
    });
    els.resultsEmpty.hidden = S.results.length > 0;
    els.resultsEmpty.textContent = query ? 'No matches in your library.' : 'Your library is empty.';
    S.resultIndex = clamp(S.resultIndex, 0, Math.max(0, S.results.length - 1));
    paintResultCursor();
  }

  /**
   * Store results come from the manifest sources in effect (Hubcap, Steam
   * through steammanifest, or both) and need at least three characters.
   * Debounced, because the on-screen keyboard fires per letter.
   */
  function runStoreSearch() {
    const query = S.query.trim();
    clearTimeout(storeTimer);
    const token = ++storeToken;

    const note = (text) => {
      els.resultsEmpty.hidden = false;
      els.resultsEmpty.textContent = text;
    };

    if (query.length < 3) {
      S.results = [];
      els.results.replaceChildren();
      note('Type at least three letters to search the store.');
      return;
    }

    note('Searching the store…');

    storeTimer = setTimeout(async () => {
      const b = bridge();
      let res;
      try {
        res = await b?.searchStoreCatalog?.(query);
      } catch (e) {
        res = { error: e.message };
      }
      if (token !== storeToken) return;

      if (!res || res.error) {
        S.results = [];
        els.results.replaceChildren();
        note(res?.error || 'The store could not be reached.');
        return;
      }

      S.results = (res.results || []).slice(0, 24);

      els.results.innerHTML = S.results.map(storeCardHtml).join('');
      [...els.results.children].forEach((card, i) => hydrateStoreArt(card, S.results[i]));
      els.resultsEmpty.hidden = S.results.length > 0;
      els.resultsEmpty.textContent = 'Nothing in the store matches that.';
      S.resultIndex = clamp(S.resultIndex, 0, Math.max(0, S.results.length - 1));
      paintResultCursor();
    }, 420);
  }

  const ownsAppId = (id) => (bridge()?.games || []).some((g) => String(g.appid) === String(id));

  /**
   * A store search result is a store cover.
   *
   * It used to be a .bp-card — the library component — so searching the store
   * dropped you into something that looked like your own shelf, with a
   * download flag stuck on it. It is the same object the store front deals
   * out, so it is built the same way and selects the same way.
   */
  function storeCardHtml(entry, i) {
    const owned = ownsAppId(entry.id);
    return `<div class="bp-sf-card${owned ? ' is-owned' : ''}" data-i="${i}" title="${esc(entry.name)}">
      <img class="bp-sf-art" alt="">
      ${owned ? '<span class="bp-sf-owned"></span>' : ''}
      <span class="bp-sf-plate"><span class="bp-sf-plate-name">${esc(entry.name)}</span></span>
    </div>`;
  }

  function hydrateStoreArt(card, entry) {
    const b = bridge();
    const img = card.querySelector('.bp-sf-art');
    if (!img) return;
    const portrait = b?.steamPortraitUrl?.(entry.id) || `${LEGACY}/${entry.id}/library_600x900.jpg`;
    // Much of the back catalogue has no 2:3 capsule; the header stands in,
    // fitted rather than cropped, exactly as it does on the store front.
    img.onerror = () => {
      img.onerror = null;
      img.classList.add('is-wide');
      img.src = `${LEGACY}/${entry.id}/header.jpg`;
    };
    img.src = portrait;
  }

  /** Writes into whichever field the keyboard is currently bound to. */
  function typeKey(id) {
    const target = S.oskTarget;
    if (!target) return;

    let value = target.value || '';
    if (id === 'bs') value = value.slice(0, -1);
    else if (id === 'sp') value += ' ';
    else if (id === 'cl') value = '';
    else value += id;

    target.value = value;
    // Let whoever owns the field react — the app's own dialog inputs included.
    target.dispatchEvent(new Event('input', { bubbles: true }));
    if (target === els.query) { S.query = value; runSearch(); }
    Sound.play('type');
  }

  function pressKey(i) {
    const key = els.keys.children[i];
    if (!key) return;
    key.classList.add('is-press');
    setTimeout(() => key.classList.remove('is-press'), 110);
    typeKey(key.dataset.key);
  }

  const pickResult = () => (S.searchMode === 'store' ? pickStoreResult() : pickLibraryResult());

  /** Jump the browse view to whatever the search landed on. */
  function pickLibraryResult() {
    const game = S.results[S.resultIndex];
    if (!game) return;
    const b = bridge();
    const key = b?.gameKeyOf?.(game);

    // Fall back to the unfiltered "All Games" group so the pick is always reachable.
    let at = S.list.findIndex((g) => b?.gameKeyOf?.(g) === key);
    if (at === -1) {
      S.groupIndex = 0;
      S.filter.installedOnly = false;
      S.filter.favOnly = false;
      S.filter.updatesOnly = false;
      renderRail();
      rebuildList({ keepSelection: false });
      at = S.list.findIndex((g) => b?.gameKeyOf?.(g) === key);
    }
    closeSearch();
    if (at !== -1) select(at, { animate: false, force: true });
    Sound.play('select');
  }


  // ════════════════════════════════════════════════════════════════
  // The store front, on the couch
  //
  // Its own screen rather than a sheet: browsing is somewhere you go, not a
  // dialog you dismiss. Reachable from the top bar, from the system menu and
  // from the empty-library screen, because a store nobody can find is not a
  // store.
  //
  // The data is the same call the desktop front page makes, cached for half
  // an hour in the main process — so opening this after opening that costs
  // nothing, and the two can never show different charts.
  //
  // Navigation is two-dimensional and deliberately simple: up and down change
  // shelf, left and right walk the shelf, A opens the store page, B leaves.
  // ════════════════════════════════════════════════════════════════
  let sfToken = 0;

  /** How many placeholder covers each placeholder shelf shows. */
  const SKELETON_RAILS = [7, 7, 7];

  const sfRailEls = () => [...els.sfRails.querySelectorAll('.bp-sf-rail')];
  const sfCardEls = (rail) => (rail ? [...rail.querySelectorAll('.bp-sf-card')] : []);

  /**
   * A store card is a cover, not a web thumbnail.
   *
   * Big Picture is built end to end on the 2:3 portrait capsule — the shelf,
   * the grid and the search results are all that shape — so a rail of 460x215
   * header images read as a browser window someone had pasted into a
   * television. The header is kept only as the fallback for the back-catalogue
   * titles Valve never generated a portrait for, letterboxed into the same box
   * so the row still lines up.
   */
  function sfCardHtml(item, kind, i) {
    const owned = Boolean(window.LibrarianStore?.isOwned?.(item.id));
    const chip = kind === 'players' && item.players
      ? `<span class="bp-sf-chip is-live">${fmtPlayers(item.players)}</span>`
      : Number.isFinite(item.score) && kind === 'score'
        ? `<span class="bp-sf-chip is-score">${item.score}</span>`
        : item.discount ? `<span class="bp-sf-chip is-cut">-${item.discount}%</span>`
          : '';
    // No chart numeral on the cover. It was meant to read as a rank the way a
    // streaming service does, and on a wall of artwork it read as a loose
    // digit sitting on the picture. The rail is already in rank order and the
    // heading says so; the artwork keeps the space.
    // A wide card (the featured shelf) shows the header plate as it is, with
    // its name and price always on. A portrait card whose 2:3 capsule does
    // not exist falls back to the header — and rather than a band of pixels
    // between two black bars, the same header fills the card behind it,
    // blown up and blurred, so the cover still reads as a cover.
    const wide = Boolean(item.wide);
    const header = esc(item.header);
    const sub = wide ? (item.discount ? `${item.price} · -${item.discount}%` : (item.price || '')) : '';
    return `
      <button class="bp-sf-card${owned ? ' is-owned' : ''}${wide ? ' is-wide-card' : ''}" data-i="${i}"
              data-id="${esc(item.id)}" data-name="${esc(item.name)}" title="${esc(item.name)}">
        <img class="bp-sf-art${wide ? ' is-wide-art' : ''}" src="${wide ? header : esc(item.capsule || item.header)}" alt=""
             loading="lazy" data-fallback-header="${wide ? '' : header}">
        ${chip}
        ${owned ? '<span class="bp-sf-owned"></span>' : ''}
        <span class="bp-sf-plate">
          <span class="bp-sf-plate-name">${esc(item.name)}</span>
          ${sub ? `<span class="bp-sf-plate-sub">${esc(sub)}</span>` : ''}
        </span>
      </button>`;
  }

  const fmtPlayers = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n));

  function renderStoreFront() {
    els.sfRails.innerHTML = S.sfRails.map((rail) => `
      <section class="bp-sf-rail${rail.wide ? ' is-wide' : ''}" data-rail="${esc(rail.id)}">
        <div class="bp-sf-rail-head">
          <span class="bp-sf-rail-title">${esc(rail.title)}</span>
          <span class="bp-sf-rail-sub">${esc(rail.sub || '')}</span>
        </div>
        <div class="bp-sf-strip">${rail.items.map((it, i) => sfCardHtml(rail.wide ? { ...it, wide: true } : it, rail.kind, i)).join('')}</div>
      </section>`).join('');
    paintSfCursor();
  }

  /**
   * Move the highlight — and with it the whole screen.
   *
   * The backdrop and the heading follow the cursor, which is the single thing
   * that makes Big Picture feel like Big Picture: the shelf does it, the grid
   * does it, and a store that left a static background while you moved would
   * read as a different application.
   */
  function paintSfCursor() {
    els.sfSearch.classList.toggle('is-cursor', S.sfRail === -1);
    if (S.sfRail === -1) {
      els.sfSearch.scrollIntoView?.({ block: 'nearest', behavior: motionOff() ? 'auto' : 'smooth' });
      stopSfTrailer();
      return;
    }
    const rails = sfRailEls();
    rails.forEach((rail, ri) => {
      const on = ri === S.sfRail;
      rail.classList.toggle('is-row', on);
      sfCardEls(rail).forEach((card, ci) => {
        card.classList.toggle('is-cursor', on && ci === S.sfCard);
      });
    });

    const rail = rails[S.sfRail];
    if (!rail) return;
    const card = sfCardEls(rail)[S.sfCard];
    // block:'nearest' on the card would scroll the strip vertically too; the
    // shelf and the card are scrolled on their own axes instead.
    rail.scrollIntoView({ block: 'nearest', behavior: motionOff() ? 'auto' : 'smooth' });
    if (card) card.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: motionOff() ? 'auto' : 'smooth' });

    paintSfDetail();
  }

  /**
   * No ambient trailer on the browse screen.
   *
   * It was here, and it was a mistake. A trailer playing full-bleed behind a
   * wall of covers does not decorate the browsing, it replaces it: the video
   * is opaque where the artwork is, and almost every Steam trailer opens on a
   * white ESRB card, so resting on a cover for a second turned the store into
   * a blank rectangle. Browsing wants the covers legible.
   *
   * The trailer still plays on the store page, one level in — where it is the
   * subject rather than the wallpaper, and where the layout is built around
   * it. This stays as a no-op so every caller can keep asking for the video
   * to be stopped without knowing whether one was ever started.
   */
  function stopSfTrailer() { /* nothing plays on the browse screen any more */ }

  /** The heading and the backdrop for whatever is under the cursor. */
  function paintSfDetail() {
    const item = S.sfRails[S.sfRail]?.items?.[S.sfCard];
    if (!item) return;

    els.sfName.textContent = item.name || '';

    const bits = [];
    if (item.players) bits.push(`${fmtPlayers(item.players)} playing now`);
    if (Number.isFinite(item.score)) bits.push(`Metacritic ${item.score}`);
    if (item.discount) bits.push(`${item.discount}% off · ${item.price}`);
    else if (item.price) bits.push(item.price);
    if (window.LibrarianStore?.isOwned?.(item.id)) bits.push('In your library');
    els.sfMeta.innerHTML = bits.map((b) => `<span class="bp-sf-pill">${esc(b)}</span>`).join('');

    // Hero art where Steam has it, the header capsule where it does not. The
    // fallback is wired on the element rather than probed up front, so moving
    // along a shelf never waits on a network round trip.
    const hero = `${LEGACY}/${item.id}/library_hero.jpg`;
    if (els.sfBg.dataset.id !== item.id) {
      els.sfBg.dataset.id = item.id;
      // Hero, then header, then the item's own capsule: a playtest or a
      // brand-new app has none of the first two, and a black void behind
      // the shelves is what that used to look like.
      const chain = [`${LEGACY}/${item.id}/header.jpg`, item.header, item.capsule].filter(Boolean);
      els.sfBg.onerror = () => {
        const next = chain.shift();
        if (next) { els.sfBg.src = next; return; }
        els.sfBg.onerror = null;
        els.sfBg.removeAttribute('src');
      };
      els.sfBg.src = hero;
    }

    // The backdrop drifts against the shelf, so the two read as different
    // distances — the same trick #bp-bg plays with --bp-par on the library.
    const count = S.sfRails[S.sfRail]?.items?.length || 1;
    const ratio = count > 1 ? S.sfCard / (count - 1) : 0;
    els.storefront.style.setProperty('--bp-sf-par', ratio.toFixed(3));

  }

  async function openStoreFront() {
    S.view = 'storefront';
    S.sfRail = 0;
    S.sfCard = 0;
    els.storefront.classList.add('is-on');
    paintHints();
    Sound.play('open');

    if (S.sfRails.length) { renderStoreFront(); paintSfDetail(); return; }

    // Placeholder shelves rather than a line of text. The charts take a few
    // seconds — three Steam endpoints and forty lookups behind them — and a
    // sentence on an empty screen reads as a dead application, while the
    // shape of the page arriving first reads as one that is working.
    els.sfStatus.textContent = '';
    els.sfName.textContent = 'Reading the charts…';
    els.sfMeta.innerHTML = '';
    els.sfRails.innerHTML = SKELETON_RAILS.map((count) => `
      <section class="bp-sf-rail is-skeleton">
        <div class="bp-sf-rail-head"><span class="bp-sf-rail-title">&nbsp;</span></div>
        <div class="bp-sf-strip">${'<div class="bp-sf-card is-skeleton"></div>'.repeat(count)}</div>
      </section>`).join('');

    const token = ++sfToken;
    let data = null;
    try { data = await api()?.getStoreFront?.(); } catch { data = null; }
    if (token !== sfToken || S.view !== 'storefront') return;

    if (!data || !data.ok) {
      els.sfRails.innerHTML = '';
      els.sfName.textContent = 'The store is out of reach';
      els.sfStatus.textContent = `${data?.error || 'Could not reach the Steam charts.'}  ·  Press A to try again.`;
      // A dead end with no way out is the worst version of this screen; the
      // only row left is the one that retries.
      S.sfRails = [];
      S.sfRail = -1;
      els.sfSearch.classList.add('is-cursor');
      return;
    }
    els.sfStatus.textContent = '';
    // The front's featured plates lead, as one wide shelf: what Steam is
    // putting first today, at a size that reads from the sofa, before the
    // portrait shelves of charts underneath.
    // Steam's spotlight is often a single plate; a shelf of one reads as a
    // mistake, so the newest releases and the top sellers fill it out.
    const spot = Array.isArray(data.spotlight) ? [...data.spotlight] : [];
    const have = new Set(spot.map((it) => it.id));
    for (const railId of ['new', 'top']) {
      for (const it of (data.rails || []).find((r) => r.id === railId)?.items || []) {
        if (spot.length >= 6) break;
        if (have.has(it.id)) continue;
        have.add(it.id);
        spot.push(it);
      }
    }
    const featured = spot.length
      ? [{ id: 'featured', title: 'Featured', sub: 'On the front of the store today', kind: 'price', wide: true, items: spot }]
      : [];
    S.sfRails = [...featured, ...(data.rails || [])];
    renderStoreFront();
  }

  function closeStoreFront() {
    stopSfTrailer();
    stopStoreMedia();
    els.storefront.classList.remove('is-on');
    S.view = 'browse';
    paintHints();
    Sound.play('back');
  }

  /**
   * Up and down change shelf, left and right walk one.
   *
   * Row -1 is the search bar, which sits above the first shelf: stepping off
   * the top of the shelves lands on it rather than stopping dead, which is
   * how every other zone in Big Picture behaves.
   */
  function moveStoreFront(dir) {
    const rails = S.sfRails;
    if (!rails.length) return;
    const before = `${S.sfRail}:${S.sfCard}`;

    if (dir === 'up' || dir === 'down') {
      S.sfRail = clamp(S.sfRail + (dir === 'down' ? 1 : -1), -1, rails.length - 1);
      if (S.sfRail >= 0) {
        // Keep the column roughly where it was rather than snapping to the
        // start of every shelf you pass through.
        S.sfCard = clamp(S.sfCard, 0, Math.max(0, (rails[S.sfRail].items.length || 1) - 1));
      }
    } else if (S.sfRail >= 0) {
      const count = rails[S.sfRail]?.items.length || 0;
      S.sfCard = clamp(S.sfCard + (dir === 'right' ? 1 : -1), 0, Math.max(0, count - 1));
    }

    if (`${S.sfRail}:${S.sfCard}` !== before) { paintSfCursor(); Sound.play('move'); }
    else Sound.play('edge');
  }

  function activateStoreFront() {
    if (S.sfRail === -1) {
      Sound.play('select');
      // With no shelves the screen has failed to load, and the only useful
      // thing the one remaining row can do is try again — which is what the
      // status line under it promises.
      if (!S.sfRails.length) { S.sfRails = []; openStoreFront(); return; }
      openStoreSearch();
      return;
    }
    const item = S.sfRails[S.sfRail]?.items?.[S.sfCard];
    if (!item) { Sound.play('edge'); return; }
    Sound.play('select');
    openStorePage({ id: item.id, name: item.name });
  }

  function pickStoreResult() {
    const entry = S.results[S.resultIndex];
    if (!entry) return;
    Sound.play('select');
    openStorePage(entry);
  }

  // ────────────────────────────────────────────────────────────────
  // The store page
  //
  // Picking a result used to raise a two-row sheet that said the game's name
  // and offered Download or Cancel — several gigabytes committed on the
  // strength of a title. This is the same page the desktop store shows, laid
  // out for a television: the trailer plays behind the name, the facts are
  // four large cells, and the actions are ordinary .bp-rows so the stick and
  // the A button need no new code.
  //
  // The metadata comes from window.LibrarianStore, which is also what the
  // desktop half reads, so the two cannot drift and a page opened on the
  // couch after one opened at the desk costs no second fetch.
  // ────────────────────────────────────────────────────────────────
  let storePageToken = 0;

  /** The first action on the open store page, run directly. */
  function runStoreInstall() {
    const first = rows.find((r) => !r.sep && !r.disabled && typeof r.run === 'function');
    if (!first) { Sound.play('edge'); return; }
    Sound.play('select');
    first.run();
  }

  function stopStoreMedia() {
    if (els.storeVideo) safely('store-trailer', () => window.LibrarianTrailer?.detach(els.storeVideo));
  }

  function storeFact(label, value) {
    return `<div class="bp-store-fact"><div class="bp-store-fact-label">${esc(label)}</div>` +
           `<div class="bp-store-fact-value">${esc(value)}</div></div>`;
  }

  async function openStorePage(entry) {
    stopSfTrailer();
    const store = window.LibrarianStore;
    const token = ++storePageToken;

    S.view = 'store';
    stopStoreMedia();
    els.storeName.textContent = entry.name || '';
    els.storeSub.textContent = 'Reading the store…';
    els.storeLogo.hidden = true;
    els.storeFacts.innerHTML = '';
    els.storeAbout.textContent = '';
    els.storeShots.innerHTML = '';
    els.storeTags.innerHTML = '';
    ['about', 'shots', 'tags'].forEach((k) => {
      els.store.querySelector(`#bp-store-${k}-wrap`)?.classList.add('is-empty');
    });
    if (entry.id) {
      els.storeBg.onerror = () => { els.storeBg.src = `${LEGACY}/${entry.id}/header.jpg`; els.storeBg.onerror = null; };
      els.storeBg.src = `${LEGACY}/${entry.id}/library_hero.jpg`;
    }
    els.store.classList.add('is-on');
    Sound.play('open');

    // The actions are up before the network is, so the page is usable from
    // the first frame even on a slow connection.
    const owned = Boolean(store?.isOwned?.(entry.id));
    rows = [
      {
        label: owned ? 'Download again' : 'Install',
        icon: ICON.download,
        run: () => { closeSheet(); closeSearch(); startDownload(entry); },
      },
      { label: 'Back', icon: ICON.back, run: () => closeSheet() },
    ];
    S.rowIndex = 0;
    paintRows(els.storeRows);
    paintRowCursor(els.storeRows);
    paintHints();

    if (!store) return;

    const meta = await store.fetchMeta(entry.id).catch(() => null);
    if (token !== storePageToken || S.view !== 'store') return;

    if (meta) {
      if (meta.name) els.storeName.textContent = meta.name;
      els.storeSub.textContent = meta.short_description || '';
      if (meta.logo_url) {
        els.storeLogo.onload = () => { els.storeLogo.hidden = false; };
        els.storeLogo.onerror = () => { els.storeLogo.hidden = true; };
        els.storeLogo.src = meta.logo_url;
      }

      // ── The right column ──
      const about = meta.about || meta.short_description || '';
      els.storeAbout.textContent = about;
      els.store.querySelector('#bp-store-about-wrap')?.classList.toggle('is-empty', !about);

      const shots = (meta.screenshots || []).map((sh) => sh.full || sh.thumb).filter(Boolean);
      els.storeShots.innerHTML = shots.slice(0, 6)
        .map((src) => `<img src="${esc(src)}" alt="" loading="lazy">`).join('');
      els.store.querySelector('#bp-store-shots-wrap')?.classList.toggle('is-empty', !shots.length);

      const tags = [...(meta.genres || []), ...(meta.categories || [])].slice(0, 12);
      els.storeTags.innerHTML = tags.map((t) => `<span class="bp-store-tag">${esc(t)}</span>`).join('');
      els.store.querySelector('#bp-store-tags-wrap')?.classList.toggle('is-empty', !tags.length);

      const movie = (meta.movies || [])[0];
      if (movie && prefs().bigpicture_trailers !== false) {
        const on = Boolean(safely('store-attach', () => window.LibrarianTrailer?.attach(els.storeVideo, movie)));
        els.storeVideo.classList.toggle('is-on', on);
        if (on) { els.storeVideo.muted = true; els.storeVideo.play?.().catch(() => {}); }
      }

      const facts = [];
      if (meta.release_date) facts.push(storeFact('Released', meta.release_date));
      if (meta.developers?.length) facts.push(storeFact('Developer', meta.developers.join(', ')));
      if (meta.genres?.length) facts.push(storeFact('Genre', meta.genres.slice(0, 3).join(', ')));
      if (meta.metacritic?.score) facts.push(storeFact('Metacritic', String(meta.metacritic.score)));
      els.storeFacts.innerHTML = facts.join('');
    }

    // Size arrives last and only changes a label, so it never blocks the page.
    const info = await store.fetchDepots(entry.id).catch(() => null);
    if (token !== storePageToken || S.view !== 'store') return;
    const size = store.sizeOf(info);
    if (size.bytes) {
      els.storeFacts.insertAdjacentHTML('beforeend',
        storeFact('Download', `${size.partial ? '≈ ' : ''}${fmtSize(size.bytes)}`));
    }
  }
  /**
   * Use the app's own download path: fetch the manifest, queue it, and let
   * processNextJob raise the depot/destination sheet. That sheet is bridged over
   * Big Picture (see the modal section) so the whole flow stays on the couch.
   */
  async function startDownload(entry) {
    const b = bridge();
    if (!b?.fetchAndQueue) { b?.toast?.('Downloads are unavailable', 'error'); return; }
    b.toast?.(`Fetching ${entry.name}…`, 'accent');
    openDownloads();
    await safely('download', () => b.fetchAndQueue(entry.id, entry.name));
  }

  // ────────────────────────────────────────────────────────────────
  // Achievements, read from the offline emulator's save file.
  //
  // Two things can be missing and they fail very differently. Without
  // definitions there is nothing to name — the panel offers to fetch them.
  // Without a save file the game has simply never unlocked anything through
  // the emulator, which is not an error and must not be reported as one.
  // ────────────────────────────────────────────────────────────────
  let achToken = 0;

  async function openAchievements(game) {
    S.view = 'achievements';
    els.ach.classList.add('is-on');
    els.achSub.textContent = game.game_name || '';
    els.achList.innerHTML = '<div class="bp-news-empty">Reading…</div>';
    els.achFill.style.width = '0%';
    els.achList.scrollTop = 0;
    Sound.play('open');

    const token = ++achToken;
    let snap;
    try { snap = await api()?.getAchievements?.(game); }
    catch (e) { snap = null; }
    if (token !== achToken || S.view !== 'achievements') return;
    paintAchievements(game, snap);
  }

  function paintAchievements(game, snap) {
    if (!snap || !snap.items?.length) {
      els.achSub.textContent = game.game_name || '';
      els.achFill.style.width = '0%';
      els.achList.innerHTML = `<div class="bp-news-empty">
        No achievement list for this game yet.<br>
        <button class="bp-ach-fetch" id="bp-ach-fetch">Fetch the list from Steam</button>
      </div>`;
      const button = els.achList.querySelector('#bp-ach-fetch');
      if (button) button.onclick = () => fetchAchievements(game);
      return;
    }

    els.achSub.textContent = `${game.game_name || ''} · ${snap.unlocked} of ${snap.total} unlocked`;
    els.achFill.style.width = `${snap.percent}%`;

    els.achList.innerHTML = snap.items.map((a) => `
      <article class="bp-ach-item${a.unlocked ? ' is-on' : ''}">
        <div class="bp-ach-icon">${a.icon
          ? `<img src="${esc(fileUrl(a.icon))}" alt="">`
          : `<span>${esc((a.title || '?').slice(0, 2).toUpperCase())}</span>`}</div>
        <div class="bp-ach-body">
          <div class="bp-ach-name">${esc(a.title)}</div>
          <div class="bp-ach-desc">${esc(a.hidden && !a.unlocked ? 'Hidden achievement' : a.description || '')}</div>
        </div>
        <div class="bp-ach-when">${a.unlocked ? esc(fmtNewsDate(a.unlockedAt) || 'Unlocked') : ''}</div>
      </article>
    `).join('');
  }

  /** Icons are files on disk; the page is a file:// document either way. */
  function fileUrl(p) {
    const clean = String(p || '').split('\\').join('/');
    return clean ? `file:///${clean.replace(/^\/+/, '')}` : '';
  }

  async function fetchAchievements(game) {
    els.achList.innerHTML = '<div class="bp-news-empty">Asking Steam for the list…</div>';
    let res;
    try { res = await api()?.fetchAchievementDefinitions?.(game); }
    catch (e) { res = { success: false, error: e.message }; }

    if (S.view !== 'achievements') return;
    if (!res?.success) {
      els.achList.innerHTML = `<div class="bp-news-empty">${esc(res?.error || 'Could not fetch the list.')}<br>
        <span class="bp-ach-hint">A Steam Web API key is required — add one in Settings on the desktop.</span></div>`;
      return;
    }
    openAchievements(game);
  }

  function closeAchievements() {
    achToken++;
    els.ach.classList.remove('is-on');
    S.view = els.details.classList.contains('is-on') ? 'details' : 'browse';
    Sound.play('close');
  }

  function scrollAchievements(direction) {
    const step = Math.max(120, Math.round(els.achList.clientHeight * 0.72)) * direction;
    els.achList.scrollBy({ top: step, behavior: motionOff() ? 'auto' : 'smooth' });
  }

  // ────────────────────────────────────────────────────────────────
  // Patch notes. A reading pane rather than a list of rows: the stick scrolls
  // it, B closes it. Steam's feed mixes announcements with real patch notes,
  // so the genuine updates are tagged and counted separately.
  // ────────────────────────────────────────────────────────────────
  let newsToken = 0;

  async function openPatchNotes(game) {
    const id = appIdOf(game);
    if (!id) { bridge()?.toast?.('No AppID — no patch notes to fetch', 'error'); return; }

    S.view = 'news';
    els.news.classList.add('is-on');
    els.newsSub.textContent = game.game_name || '';
    els.newsList.innerHTML = '<div class="bp-news-empty">Fetching patch notes…</div>';
    els.newsList.scrollTop = 0;
    Sound.play('open');

    const token = ++newsToken;
    let result;
    try { result = await api()?.getPatchNotes?.(id); }
    catch (e) { result = { items: [], error: e.message }; }
    if (token !== newsToken || S.view !== 'news') return;

    if (result?.error) {
      els.newsList.innerHTML = `<div class="bp-news-empty">Could not load patch notes — ${esc(result.error)}</div>`;
      return;
    }
    const items = result?.items || [];
    if (!items.length) {
      els.newsList.innerHTML = '<div class="bp-news-empty">This game has no published announcements.</div>';
      return;
    }

    const patches = items.filter((i) => i.isPatch).length;
    const summary = patches
      ? `${patches} update${patches === 1 ? '' : 's'} of ${items.length} recent posts`
      : `${items.length} recent announcement${items.length === 1 ? '' : 's'}`;
    els.newsSub.textContent = `${game.game_name || ''} · ${summary}`;

    els.newsList.innerHTML = items.map((item) => `
      <article class="bp-news-item${item.isPatch ? ' is-patch' : ''}">
        <div class="bp-news-meta">
          ${item.isPatch ? '<span class="bp-news-tag">Patch</span>' : ''}
          <span>${esc(fmtNewsDate(item.date))}</span>
        </div>
        <h3 class="bp-news-title">${esc(item.title || 'Untitled')}</h3>
        <p class="bp-news-body">${esc(item.body || '').split('\n').join('<br>')}</p>
      </article>
    `).join('');
  }

  function closePatchNotes() {
    newsToken++;
    els.news.classList.remove('is-on');
    S.view = els.details.classList.contains('is-on') ? 'details' : 'browse';
    Sound.play('close');
  }

  /** The reading pane moves by roughly a screenful, the way a page-down would. */
  function scrollNews(direction) {
    const step = Math.max(120, Math.round(els.newsList.clientHeight * 0.72)) * direction;
    els.newsList.scrollBy({ top: step, behavior: motionOff() ? 'auto' : 'smooth' });
  }

  function fmtNewsDate(ms) {
    if (!ms) return '';
    try { return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch { return ''; }
  }

  function openDownloads() {
    S.view = 'downloads';
    S.rowIndex = 0;
    paintDownloads();
    els.downloads.classList.add('is-on');
    Sound.play('open');
  }

  function paintDownloads() {
    const dl = S.download;
    const live = Boolean(dl && dl.active);
    els.dlLive.hidden = !live;

    if (live) {
      const pct = clamp(Math.round(Number(dl.percent) || 0), 0, 100);
      const verb = dl.jobType === 'update' ? 'Updating' : dl.jobType === 'repair' ? 'Verifying' : 'Downloading';
      els.dlName.textContent = `${verb} ${dl.name || '—'}`;
      els.dlBar.style.width = `${pct}%`;
      els.dlStats.textContent = [
        `${pct}%`,
        dl.paused ? 'Paused' : dl.speed,
        dl.paused ? '' : dl.eta,
        dl.sizeText,
      ].filter(Boolean).join('  ·  ');
    }

    rows = [];
    if (live) {
      rows.push(dl.paused
        ? { label: 'Resume', icon: ICON.play, run: () => { api()?.resumeDownload?.(); } }
        : { label: 'Pause', icon: ICON.stop, run: () => { api()?.pauseDownload?.(); } });
      rows.push({
        label: 'Cancel this download',
        icon: ICON.trash,
        danger: true,
        run: () => { api()?.cancelDownload?.(); },
      });
    }

    for (const job of S.queue) {
      if (job.status === 'processing') continue;
      rows.push({ label: job.name, value: 'Queued', icon: ICON.download, disabled: true });
    }

    if (!rows.length) rows.push({ label: 'Nothing downloading', icon: ICON.check, disabled: true });
    rows.push({ sep: true });
    rows.push({ label: 'Browse the store', icon: ICON.download, run: () => { closeSheet(); openStoreFront(); } });
    rows.push({ label: 'Search for a game', icon: ICON.search, run: () => { closeSheet(); S.searchMode = 'store'; openSearch(); } });
    rows.push({ label: 'Close', icon: ICON.back, run: () => closeSheet() });

    paintRows(els.dlRows);
  }

  /** The top-bar ring: a running download is worth seeing from any view. */
  function paintDownloadChip() {
    const dl = S.download;
    const live = Boolean(dl && dl.active);
    els.btnDl.hidden = !live;
    if (!live) return;
    const pct = clamp(Math.round(Number(dl.percent) || 0), 0, 100);
    els.dlPct.textContent = String(pct);
    els.ringFill.style.strokeDashoffset = String(94.25 * (1 - pct / 100));  // r=15 → C≈94.25
    els.btnDl.classList.toggle('is-paused', Boolean(dl.paused));
  }

  // ════════════════════════════════════════════════════════════════
  // Modal bridge
  //
  // Some steps genuinely need the desktop dialogs — which depots, where to
  // install, which executable. Rebuilding those for a pad would be a second
  // implementation of the download path, so instead the app's own modal is
  // raised above Big Picture and driven from here: the cursor walks its
  // focusables, A activates, B closes, and A on a text field brings up the
  // on-screen keyboard bound to that field.
  // ════════════════════════════════════════════════════════════════
  const MODAL_FOCUSABLE = [
    'button:not(:disabled)', 'input:not([type=hidden]):not(:disabled)', 'select', 'textarea',
    '.library-item', '.plan-card', '.loc-row', '.depot-row', '[tabindex]:not([tabindex="-1"])',
  ].join(', ');

  /*
   * Two desktop dialogs can come up over Big Picture, and only one of them is
   * the standard modal. The install planner lives in its own #plan element at
   * z-index 1750 — far below this overlay — so before it was adopted it opened
   * *underneath* Big Picture and the download simply appeared to hang, waiting
   * on an answer to a question nobody could see.
   */
  const DIALOG_IDS = ['plan', 'modal-overlay'];

  const dialogEls = () => DIALOG_IDS
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  const openDialog = () => dialogEls().find((el) => !el.classList.contains('hidden')) || null;
  const modalEl = () => openDialog() || document.getElementById('modal-overlay');
  const modalOpen = () => Boolean(openDialog());

  function modalTargets() {
    const overlay = modalEl();
    if (!overlay) return [];
    return [...overlay.querySelectorAll(MODAL_FOCUSABLE)].filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 3 && rect.height > 3;
    });
  }

  function enterModal() {
    if (S.view === 'modal') return;
    // Get out of the dialog's way: it is the only thing that should be on
    // screen, and leaving the search overlay or a sheet behind it is confusing
    // the moment the dialog is dismissed.
    els.menu.classList.remove('is-on');
    els.filter.classList.remove('is-on');
    els.system.classList.remove('is-on');
    els.downloads.classList.remove('is-on');
    els.search.classList.remove('is-on');
    delete els.root.dataset.osk;

    S.view = 'modal';
    S.modalCursor = 0;
    // Dialogs fill themselves in asynchronously more often than not.
    setTimeout(() => { if (S.view === 'modal') focusModal(0); }, 60);
    Sound.play('open');
  }

  function leaveModal() {
    if (S.view !== 'modal') return;
    closeOsk({ quiet: true });
    S.view = els.details.classList.contains('is-on') ? 'details' : 'browse';
  }

  function focusModal(index) {
    const targets = modalTargets();
    if (!targets.length) return;
    S.modalCursor = clamp(index, 0, targets.length - 1);
    const el = targets[S.modalCursor];
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
  }

  /**
   * Geometric step, so it drives any dialog without per-dialog wiring.
   *
   * Distances are measured edge to edge and the cross-axis penalty is the *gap
   * between the two boxes' spans*, which is zero whenever they overlap. Centre
   * points would not do: a full-width list row has its centre far from a
   * top-right close button, so a distant but well-centred button underneath
   * would win over the row directly below.
   */
  function moveModal(dir) {
    const targets = modalTargets();
    if (!targets.length) return;
    const from = targets[S.modalCursor] || targets[0];
    const a = from.getBoundingClientRect();
    const vertical = dir === 'up' || dir === 'down';

    let best = -1;
    let bestCost = Infinity;
    targets.forEach((el, i) => {
      if (el === from) return;
      const r = el.getBoundingClientRect();

      const forward = dir === 'down' ? r.top - a.bottom
        : dir === 'up' ? a.top - r.bottom
          : dir === 'right' ? r.left - a.right
            : a.left - r.right;

      // Slight overlap is fine — stacked rows often share a pixel — but a box
      // that sits mostly alongside is not "in that direction" at all.
      const span = vertical ? Math.min(a.height, r.height) : Math.min(a.width, r.width);
      if (forward < -span * 0.4) return;

      const gap = vertical
        ? Math.max(0, Math.max(a.left, r.left) - Math.min(a.right, r.right))
        : Math.max(0, Math.max(a.top, r.top) - Math.min(a.bottom, r.bottom));

      const centreDrift = vertical
        ? Math.abs((r.left + r.width / 2) - (a.left + a.width / 2))
        : Math.abs((r.top + r.height / 2) - (a.top + a.height / 2));

      const cost = Math.max(0, forward) + gap * 4 + centreDrift * 0.02;
      if (cost < bestCost) { bestCost = cost; best = i; }
    });

    if (best === -1) { Sound.play('edge'); return; }
    focusModal(best);
    Sound.play('move');
  }

  function activateModal() {
    const el = modalTargets()[S.modalCursor];
    if (!el) return;

    // A text field needs a keyboard, not a click.
    const typable = (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(el.type))
      || el.tagName === 'TEXTAREA';
    if (typable) {
      S.oskTarget = el;
      el.focus({ preventScroll: true });
      S.searchZone = 'keys';
      S.keyIndex = 0;
      els.root.dataset.osk = 'on';
      els.search.classList.add('is-on');
      paintKeys();
      Sound.play('open');
      return;
    }

    Sound.play('select');
    el.click();
    // A dialog usually rebuilds itself on a click; re-anchor next tick.
    setTimeout(() => { if (S.view === 'modal') focusModal(S.modalCursor); }, 90);
  }

  function closeOsk({ quiet = false } = {}) {
    if (els.root.dataset.osk !== 'on') return;
    delete els.root.dataset.osk;
    els.search.classList.remove('is-on');
    S.oskTarget = null;
    if (!quiet) Sound.play('close');
  }

  const oskOpen = () => els.root.dataset.osk === 'on';

  function adoptModal() {
    for (const el of dialogEls()) {
      if (el.parentElement !== els.root) els.root.appendChild(el);
    }
  }

  function releaseModal() {
    for (const el of dialogEls()) {
      if (el.parentElement === els.root) document.body.appendChild(el);
    }
  }

  function downloadSummary() {
    if (S.download?.active) return `${clamp(Math.round(Number(S.download.percent) || 0), 0, 100)}%`;
    const waiting = S.queue.filter((j) => j.status === 'queued').length;
    return waiting ? `${waiting} queued` : '';
  }

  function watchModal() {
    const sync = () => {
      if (!S.open) return;
      if (modalOpen()) enterModal();
      else leaveModal();
    };
    // Each dialog opens and closes by toggling its own `hidden` class, so both
    // are watched — the planner is the one that matters for a download.
    for (const el of dialogEls()) {
      new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ['class'] });
    }
    const overlay = modalEl();
    if (!overlay) return;
    if (modalOpen()) sync();
  }

  // ════════════════════════════════════════════════════════════════
  // Actions
  // ════════════════════════════════════════════════════════════════
  function popStar() {
    const star = els.meta.querySelector('.bp-star');
    if (!star) return;
    star.classList.add('is-pop');
    setTimeout(() => star.classList.remove('is-pop'), 320);
  }

  /** Hand the user back to the desktop UI for something Big Picture can't host. */
  function leaveFor(run, note) {
    close();
    setTimeout(() => {
      safely('leave', run);
      if (note) bridge()?.toast?.(note, 'accent');
    }, 360);
  }

  async function play() {
    const game = current();
    const b = bridge();
    if (!game || !b) return;

    if (b.isGameRunning?.(game)) {
      await safely('stop', () => b.stopGame?.(game));
      renderCards();
      select(S.index, { animate: false, force: true });
      return;
    }

    if (!isInstalled(game)) {
      leaveFor(() => b.showInstallSheet?.(game) ?? b.openFlyout?.(game), 'Pick your install options here');
      return;
    }

    Sound.play('launch');
    const art = await artFor(game).catch(() => ({}));
    els.curtainArt.style.backgroundImage = art.portrait ? `url("${art.portrait}")` : 'none';
    els.curtainText.textContent = `Launching ${game.game_name || 'game'}…`;
    els.curtain.classList.add('is-on');

    const result = await safely('launch', () => b.launchGame?.(game));

    // launchGame opens the executable picker when it cannot decide for itself.
    // That modal belongs to the desktop UI, so step aside and let it be used.
    const modalOpen = !document.getElementById('modal-overlay')?.classList.contains('hidden');
    setTimeout(() => {
      els.curtain.classList.remove('is-on');
      if (modalOpen) { close(); return; }
      renderCards();
      select(S.index, { animate: false, force: true });
      // Big Picture is fullscreen, so it would otherwise sit in front of the
      // game it just started. Only step back for a launch that actually
      // reported success — minimising after a failure would hide the error.
      if (result?.success && prefs().bigpicture_minimize_on_play !== false) standAside();
    }, modalOpen ? 200 : 1400);
  }

  /**
   * Drop out of fullscreen and minimise so the game takes the foreground.
   * Leaving fullscreen first matters: a minimised fullscreen window comes back
   * in an odd state on Windows, and the game would still be behind it.
   */
  function standAside() {
    S.steppedAside = true;
    S.steppedAsideAt = Date.now();
    safely('stand-aside', async () => {
      if (prefs().bigpicture_fullscreen !== false) await api()?.setFullScreen?.(false);
      api()?.minimize?.();
    });
  }

  /** Come back when the game exits, but only if we were the ones who left. */
  async function comeBack() {
    if (!S.steppedAside) return;
    S.steppedAside = false;
    try {
      // Un-minimise first and wait for it: asking a minimised window to go
      // fullscreen is what left it small in the corner.
      await api()?.restoreWindow?.();
      if (S.open && prefs().bigpicture_fullscreen !== false) await api()?.setFullScreen?.(true);
    } catch (e) {
      console.error('[bigpicture] could not come back', e);
    }
  }

  function toggleLayout() {
    S.layout = S.layout === 'grid' ? 'horizontal' : 'grid';
    els.root.dataset.layout = S.layout;
    els.btnGrid.classList.toggle('is-on', S.layout === 'grid');
    S.zone = S.layout === 'grid' ? 'grid' : 'shelf';
    els.root.dataset.zone = S.zone;
    renderCards();
    select(S.index, { animate: false, force: true });
    setPref('bigpicture_layout', S.layout);
    Sound.play('select');
  }

  /** LB/RB: shelf groups browsing, Library ⇄ Store searching, shelves in the store. */
  function cycleSection(delta) {
    if (S.view === 'search') {
      setSearchMode(S.searchMode === 'store' ? 'library' : 'store');
      return;
    }
    // A store front is six shelves deep and some of them are twenty covers
    // long. Walking to the next shelf with the stick means crossing whatever
    // you are standing on; the shoulders skip straight there and put you back
    // at its first cover, which is where a jump should land.
    if (S.view === 'storefront') {
      const next = clamp(S.sfRail + delta, 0, Math.max(0, S.sfRails.length - 1));
      if (next === S.sfRail) { Sound.play('edge'); return; }
      S.sfRail = next;
      S.sfCard = 0;
      paintSfCursor();
      Sound.play('move');
      return;
    }
    if (S.view !== 'browse') return;
    cycleGroup(delta);
  }

  function moveKeys(dir) {
    const at = KEY_AT[S.keyIndex] || { row: 0, col: 0 };
    let { row, col } = at;

    if (dir === 'left') {
      if (col === 0) return void Sound.play('edge');
      col--;
    } else if (dir === 'right') {
      if (col >= KEY_LAYOUT[row].length - 1) {
        // Off the right edge of the keyboard is the results grid — but only in
        // the search overlay; over a dialog the keyboard is all there is.
        if (S.view === 'search' && S.results.length) {
          S.searchZone = 'results';
          paintKeys();
          paintResultCursor();
          Sound.play('move');
        } else Sound.play('edge');
        return;
      }
      col++;
    } else if (dir === 'up') {
      if (row === 0) return void Sound.play('edge');
      row--;
    } else if (dir === 'down') {
      if (row >= KEY_LAYOUT.length - 1) return void Sound.play('edge');
      row++;
    }

    col = clamp(col, 0, KEY_LAYOUT[row].length - 1);
    S.keyIndex = KEY_LAYOUT[row][col];
    paintKeys();
    Sound.play('move');
  }

  function cycleGroup(delta) {
    if (!S.groups.length) return;
    const next = (((S.groupIndex + delta) % S.groups.length) + S.groups.length) % S.groups.length;
    S.groupIndex = next;
    S.railIndex = next;
    paintRailCursor();
    rebuildList({ keepSelection: false });
    Sound.play('move');
  }

  // ════════════════════════════════════════════════════════════════
  // Navigation
  // ════════════════════════════════════════════════════════════════
  function setZone(zone) {
    S.zone = zone;
    els.root.dataset.zone = zone;
  }

  function move(dir) {
    if (S.view === 'update') return;

    if (S.view === 'storefront') return void moveStoreFront(dir);

    if (S.view === 'achievements') {
      if (dir === 'up' || dir === 'down') { scrollAchievements(dir === 'down' ? 1 : -1); Sound.play('move'); }
      return;
    }

    // ── Patch notes is a reading pane, not a list ──────────────────
    if (S.view === 'news') {
      if (dir === 'up' || dir === 'down') { scrollNews(dir === 'down' ? 1 : -1); Sound.play('move'); }
      return;
    }

    // ── A desktop dialog is on top ─────────────────────────────────
    if (S.view === 'modal') {
      if (oskOpen()) return moveKeys(dir);
      return moveModal(dir);
    }

    // ── Sheets ────────────────────────────────────────────────────
    if (isSheet(S.view)) {
      const host = sheetHost();
      if (dir === 'up' || dir === 'down') {
        const step = dir === 'down' ? 1 : -1;
        let next = S.rowIndex;
        for (let n = 0; n < rows.length; n++) {
          next = (((next + step) % rows.length) + rows.length) % rows.length;
          if (!rows[next].sep && !rows[next].disabled) break;
        }
        S.rowIndex = next;
        paintRowCursor(host);
        Sound.play('move');
      } else if (S.view === 'filter' && rows[S.rowIndex]?.cycle) {
        cycleSort(dir === 'right' ? 1 : -1);
        Sound.play('move');
      } else if (S.view === 'system' && rows[S.rowIndex]?.label === 'Layout') {
        runRow();
      }
      return;
    }

    // ── Search ────────────────────────────────────────────────────
    if (S.view === 'search') {
      if (S.searchZone === 'keys') return moveKeys(dir);

      const cols = 4;
      const before = S.resultIndex;
      if (dir === 'left') {
        if (S.resultIndex % cols === 0) { S.searchZone = 'keys'; paintKeys(); paintResultCursor(); Sound.play('move'); return; }
        S.resultIndex--;
      } else if (dir === 'right') S.resultIndex++;
      else if (dir === 'up') S.resultIndex -= cols;
      else if (dir === 'down') S.resultIndex += cols;
      S.resultIndex = clamp(S.resultIndex, 0, Math.max(0, S.results.length - 1));
      if (S.resultIndex !== before) { paintResultCursor(); Sound.play('move'); }
      return;
    }

    // ── Details ───────────────────────────────────────────────────
    if (S.view === 'details') {
      if (dir === 'left' || dir === 'right') {
        const step = dir === 'right' ? 1 : -1;

        if (S.detRow === 1) {
          const before = S.tabIndex;
          S.tabIndex = clamp(S.tabIndex + step, 0, S.tabs.length - 1);
          if (S.tabIndex !== before) { showDetPanel(); Sound.play('move'); }
          else Sound.play('edge');
          return;
        }
        if (S.detRow === 2) {
          const cells = detCells();
          const before = S.cellIndex;
          S.cellIndex = clamp(S.cellIndex + step, 0, Math.max(0, cells.length - 1));
          if (S.cellIndex !== before) { paintDetCursor(); Sound.play('move'); }
          else Sound.play('edge');
          return;
        }

        const before = S.actIndex;
        S.actIndex = stepAction(step);
        if (S.actIndex !== before) { paintActCursor(); Sound.play('move'); }
      } else if (dir === 'up' || dir === 'down') {
        const step = dir === 'down' ? 1 : -1;

        // The page is a stack of rows. Stepping off the top or the bottom of
        // that stack changes game, which is what up and down did before the
        // tabs existed — so the habit still works, and the rows are found by
        // pressing down rather than by being told about them.
        const rows = els.detTabs?.hidden ? 1 : (detCells().length ? 3 : 2);
        const wanted = S.detRow + step;
        if (wanted >= 0 && wanted < rows) {
          S.detRow = wanted;
          paintDetCursor();
          Sound.play('move');
          return;
        }

        const next = clamp(S.index + step, 0, S.list.length - 1);
        if (next !== S.index) {
          select(next, { animate: false });
          stopTrailer();
          openDetails({ morph: false });
        } else {
          Sound.play('edge');
        }
      }
      return;
    }

    // ── Rail ──────────────────────────────────────────────────────
    if (S.zone === 'rail') {
      if (dir === 'up' || dir === 'down') {
        const step = dir === 'down' ? 1 : -1;
        S.railIndex = clamp(S.railIndex + step, 0, S.groups.length - 1);
        paintRailCursor();
        els.railList.children[S.railIndex]?.scrollIntoView?.({ block: 'nearest' });
        Sound.play('move');
      } else if (dir === 'right') {
        setZone(S.layout === 'grid' ? 'grid' : 'shelf');
        Sound.play('move');
      } else if (dir === 'left') {
        Sound.play('edge');
      }
      return;
    }

    // ── Shelf / grid ──────────────────────────────────────────────
    if (S.layout === 'grid') {
      const cols = gridColumns();
      if (dir === 'left') {
        if (S.index % cols === 0) { setZone('rail'); S.railIndex = S.groupIndex; paintRailCursor(); Sound.play('move'); return; }
        select(S.index - 1);
      } else if (dir === 'right') select(S.index + 1);
      else if (dir === 'up') {
        if (S.index < cols) { Sound.play('edge'); return; }
        select(S.index - cols);
      } else if (dir === 'down') {
        if (S.index + cols >= S.list.length) { Sound.play('edge'); return; }
        select(S.index + cols);
      }
      Sound.play('move');
      return;
    }

    if (dir === 'left') {
      if (S.index === 0) { setZone('rail'); S.railIndex = S.groupIndex; paintRailCursor(); Sound.play('move'); return; }
      select(S.index - 1);
      Sound.play('move');
    } else if (dir === 'right') {
      if (S.index >= S.list.length - 1) { Sound.play('edge'); return; }
      select(S.index + 1);
      Sound.play('move');
    } else if (dir === 'up') {
      setZone('rail');
      S.railIndex = S.groupIndex;
      paintRailCursor();
      Sound.play('move');
    } else if (dir === 'down') {
      Sound.play('edge');
    }
  }

  function activate() {
    if (S.view === 'storefront') return void activateStoreFront();
    if (S.view === 'modal') {
      if (oskOpen()) return void pressKey(S.keyIndex);
      return void activateModal();
    }
    if (isSheet(S.view)) return void runRow();
    if (S.view === 'search') {
      if (S.searchZone === 'keys') pressKey(S.keyIndex);
      else pickResult();
      return;
    }
    if (S.view === 'details') {
      // The tab bar switches on focus already, so confirming there just drops
      // into what it opened — one press instead of two.
      if (S.detRow === 1) {
        if (detCells().length) { S.detRow = 2; paintDetCursor(); Sound.play('select'); }
        else Sound.play('edge');
        return;
      }
      if (S.detRow === 2) {
        if (!activateDetCell()) Sound.play('edge');
        return;
      }

      const btn = els.detActions.children[S.actIndex];
      if (btn) {
        btn.classList.add('is-press');
        setTimeout(() => btn.classList.remove('is-press'), 130);
      }
      if (btn && !btn.disabled) detAction(btn.dataset.act);
      return;
    }
    if (S.zone === 'rail') {
      const group = S.groups[S.railIndex];
      if (group?.action === 'store') { openStoreFront(); return; }
      S.groupIndex = S.railIndex;
      paintRailCursor();
      rebuildList({ keepSelection: false });
      setZone(S.layout === 'grid' ? 'grid' : 'shelf');
      Sound.play('select');
      return;
    }
    // On the shelf, A plays — the hint bar promises exactly that.
    const card = cardAt(S.index);
    if (card) {
      card.classList.add('is-press');
      setTimeout(() => card.classList.remove('is-press'), 140);
    }
    play();
  }

  function back() {
    if (S.view === 'modal') {
      if (oskOpen()) return void closeOsk();
      const close = modalEl()?.querySelector('#modal-close');
      if (close) { Sound.play('back'); close.click(); }
      return;
    }
    if (S.view === 'storefront') return void closeStoreFront();
    if (S.view === 'update') return void closeUpdateScreen();
    if (S.view === 'achievements') return void closeAchievements();
    if (S.view === 'news') return void closePatchNotes();
    if (isSheet(S.view)) return void closeSheet();
    if (S.view === 'search') {
      if (S.searchZone === 'results') { S.searchZone = 'keys'; paintKeys(); paintResultCursor(); Sound.play('back'); return; }
      return void closeSearch();
    }
    if (S.view === 'details') {
      // Back climbs out of the page a row at a time before it leaves it — the
      // same shape as going in.
      if (S.detRow > 0) { S.detRow -= 1; paintDetCursor(); Sound.play('back'); return; }
      return void closeDetails();
    }
    if (S.zone === 'rail') { setZone(S.layout === 'grid' ? 'grid' : 'shelf'); Sound.play('back'); return; }
    close();
  }

  // Button *positions* are fixed by the standard gamepad mapping — index 0 is
  // always the bottom face button — but the letter printed on it is not. A
  // PlayStation pad calls it ✕ and a Nintendo pad calls it B, so showing "A"
  // to either is simply wrong.
  const GLYPHS = {
    xbox: { confirm: 'A', details: 'X', search: 'Y' },
    playstation: { confirm: '✕', details: '□', search: '△' },
    nintendo: { confirm: 'B', details: 'Y', search: 'X' },
  };

  function padBrandFrom(id) {
    const name = String(id || '').toLowerCase();
    if (/playstation|dualshock|dualsense|054c|wireless controller/.test(name)) return 'playstation';
    if (/nintendo|switch|joy-?con|057e|pro controller/.test(name)) return 'nintendo';
    return 'xbox';
  }

  function detectPadBrand() {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    const brand = pads.length ? padBrandFrom(pads[0].id) : 'xbox';
    if (brand === S.padBrand) return;
    S.padBrand = brand;
    if (S.built) paintHints();
  }

  const HINTS = {
    browse: [['play', 'Play'], ['details', 'Details'], ['menu', 'Game Options'], ['search', 'Search'], ['filter', 'Filter']],
    library: [['play', 'Go to game'], ['details', 'Details'], ['menu', 'Library ⇄ Store'], ['search', 'Search'], ['filter', 'Filter']],
    store: [['play', 'Open store page'], ['details', 'Details'], ['menu', 'Library ⇄ Store'], ['search', 'Search'], ['filter', 'Filter']],
    storepage: [['play', 'Choose'], ['details', 'Details'], ['menu', 'Menu'], ['search', 'Search the store'], ['filter', 'Filter']],
    storefront: [['play', 'Open store page'], ['details', 'Details'], ['menu', 'Menu'], ['search', 'Search the store'], ['filter', 'Filter']],
  };

  function paintHints() {
    const set = S.view === 'storefront' ? HINTS.storefront
      : S.view === 'store' ? HINTS.storepage
      : S.view === 'search' ? HINTS[S.searchMode]
        : HINTS.browse;
    set.forEach(([id, label]) => {
      const btn = els.hintList.querySelector(`[data-hint="${id}"] span:last-child`);
      if (btn) btn.textContent = label;
    });

    const letters = GLYPHS[S.padBrand] || GLYPHS.xbox;
    els.hintList.querySelectorAll('.bp-glyph').forEach((glyph) => {
      const key = glyph.dataset.glyph;
      if (key === 'view') glyph.innerHTML = svg(ICON.dots);
      else if (key === 'filter') glyph.innerHTML = svg(ICON.filter);
      else glyph.textContent = letters[key] || '';
    });
  }

  function flashHint(id) {
    const btn = els.hintList.querySelector(`[data-hint="${id}"]`);
    if (!btn) return;
    btn.classList.add('is-hit');
    setTimeout(() => btn.classList.remove('is-hit'), 220);
  }

  // ════════════════════════════════════════════════════════════════
  // Keyboard
  // ════════════════════════════════════════════════════════════════
  const DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

  function onKeyDown(e) {
    // Ctrl+Shift+B toggles, from anywhere, whether Big Picture is up or not.
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      e.stopImmediatePropagation();
      toggle();
      return;
    }
    if (!S.open) return;

    // Any focused text field owns the printable keys — the search box, and any
    // field inside an adopted desktop dialog. Without this a hardware keyboard
    // could not type into the destination or login dialogs at all.
    const focused = document.activeElement;
    const typing = Boolean(focused) && (
      focused.tagName === 'TEXTAREA'
      || (focused.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(focused.type))
      || focused.isContentEditable
    );

    // Everything below belongs to Big Picture; nothing may reach the desktop UI.
    const swallow = () => { e.preventDefault(); e.stopImmediatePropagation(); };

    if (DIRS[e.key]) {
      // While the search field has focus, left/right still move the caret —
      // a hardware keyboard should not have to fight the on-screen one.
      if (typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.stopImmediatePropagation(); return; }
      swallow();
      move(DIRS[e.key]);
      return;
    }

    switch (e.key) {
      case 'Enter':
        swallow();
        if (S.view === 'search' && typing) { S.searchZone = 'results'; paintKeys(); paintResultCursor(); pickResult(); return; }
        flashHint('play');
        activate();
        return;
      case 'Escape':
      case 'Backspace':
        if (typing && e.key === 'Backspace') return; // let the field edit itself
        swallow();
        back();
        return;
      case 'Tab':
        swallow();
        if (S.view === 'search') {
          S.searchZone = S.searchZone === 'keys' ? 'results' : 'keys';
          paintKeys();
          paintResultCursor();
        } else {
          setZone(S.zone === 'rail' ? (S.layout === 'grid' ? 'grid' : 'shelf') : 'rail');
        }
        Sound.play('move');
        return;
      case 'Home':
        swallow();
        if (S.view === 'browse') select(0);
        return;
      case 'End':
        swallow();
        if (S.view === 'browse') select(S.list.length - 1);
        return;
      case 'PageUp':
        swallow();
        cycleSection(-1);
        return;
      case 'PageDown':
        swallow();
        cycleSection(1);
        return;
      default: break;
    }

    if (typing) return; // plain characters belong to the field

    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key.toLowerCase()) {
      case 'x': swallow(); flashHint('details'); if (S.view === 'browse') openDetails(); return;
      case 'y': case '/':
        swallow();
        flashHint('search');
        if (S.view === 'search') return;
        if (S.view === 'storefront' || S.view === 'store') openStoreSearch();
        else openSearch();
        return;
      case 'm': case 'o': swallow(); flashHint('menu'); if (S.view === 'browse' || S.view === 'details') openMenu(); return;
      case 'f': swallow(); flashHint('filter'); if (S.view === 'browse') openFilter(); return;
      case 'g': swallow(); if (S.view === 'browse') toggleLayout(); return;
      case 'p': swallow(); flashHint('play'); play(); return;
      case 's': swallow(); if (S.view === 'browse') openSystem(); return;
      case 'd': swallow(); if (S.view === 'browse') openDownloads(); return;
      default: break;
    }
  }

  // The search field needs its own listener: typing there updates the query
  // that the on-screen keyboard shares.
  function wireQuery() {
    els.query.addEventListener('input', () => {
      S.query = els.query.value;
      runSearch();
    });
  }

  // ════════════════════════════════════════════════════════════════
  // Pointer — Big Picture is controller-first but must not be mouse-hostile.
  // ════════════════════════════════════════════════════════════════
  function wirePointer() {
    els.btnStore.onclick = () => (S.view === 'storefront' ? closeStoreFront() : openStoreFront());
    els.sfRails.addEventListener('click', (e) => {
      const card = e.target.closest('.bp-sf-card');
      if (!card) return;
      S.sfRail = Math.max(0, sfRailEls().indexOf(card.closest('.bp-sf-rail')));
      S.sfCard = Number(card.dataset.i) || 0;
      paintSfCursor();
      activateStoreFront();
    });
    els.btnGrid.onclick = () => toggleLayout();
    els.btnSystem.onclick = () => (S.view === 'system' ? closeSheet() : openSystem());
    els.btnExit.onclick = () => close();
    els.root.querySelector('#bp-empty-exit').onclick = () => close();
    els.root.querySelector('#bp-empty-store').onclick = () => openStoreFront();

    els.railList.addEventListener('pointerenter', () => setZone('rail'));
    els.railList.addEventListener('click', (e) => {
      const item = e.target.closest('.bp-rail-item');
      if (!item) return;
      S.groupIndex = Number(item.dataset.gi) || 0;
      S.railIndex = S.groupIndex;
      paintRailCursor();
      rebuildList({ keepSelection: false });
      setZone(S.layout === 'grid' ? 'grid' : 'shelf');
      Sound.play('select');
    });

    const onCardHover = (e) => {
      const card = e.target.closest('.bp-card');
      if (!card || !card.parentElement) return;
      if (card.parentElement === els.results) {
        S.searchZone = 'results';
        S.resultIndex = [...els.results.children].indexOf(card);
        paintKeys();
        paintResultCursor();
        return;
      }
      const at = Number(card.dataset.i);
      if (Number.isFinite(at) && at !== S.index) {
        setZone(S.layout === 'grid' ? 'grid' : 'shelf');
        select(at);
      }
    };

    const onCardClick = (e) => {
      const card = e.target.closest('.bp-card');
      if (!card) return;
      if (card.parentElement === els.results) { pickResult(); return; }
      const at = Number(card.dataset.i);
      if (at === S.index) activate();
      else select(at);
    };

    els.shelf.addEventListener('pointermove', onCardHover, { passive: true });
    els.grid.addEventListener('pointermove', onCardHover, { passive: true });
    els.results.addEventListener('pointermove', onCardHover, { passive: true });
    els.root.addEventListener('click', onCardClick);

    // Wheel scrubs the carousel; the grid scrolls natively.
    els.shelf.addEventListener('wheel', (e) => {
      e.preventDefault();
      select(S.index + (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1));
    }, { passive: false });

    els.keys.addEventListener('click', (e) => {
      const key = e.target.closest('.bp-key');
      if (!key) return;
      S.keyIndex = Number(key.dataset.ki) || 0;
      S.searchZone = 'keys';
      paintKeys();
      pressKey(S.keyIndex);
    });

    for (const [sheet, host] of [[els.menu, els.menuRows], [els.filter, els.filterRows], [els.system, els.systemRows]]) {
      host.addEventListener('click', (e) => {
        const row = e.target.closest('.bp-row');
        if (!row) return;
        S.rowIndex = Number(row.dataset.ri) || 0;
        paintRowCursor(host);
        runRow();
      });
      host.addEventListener('pointermove', (e) => {
        const row = e.target.closest('.bp-row');
        if (!row) return;
        const at = Number(row.dataset.ri) || 0;
        if (at === S.rowIndex) return;
        S.rowIndex = at;
        paintRowCursor(host);
      }, { passive: true });
      // Clicking the dimmed backdrop closes the sheet.
      sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
    }

    els.detActions.addEventListener('click', (e) => {
      const btn = e.target.closest('.bp-act');
      if (!btn) return;
      S.detRow = 0;
      S.actIndex = [...els.detActions.children].indexOf(btn);
      paintActCursor();
      detAction(btn.dataset.act);
    });

    els.detTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.bp-tab');
      if (!tab) return;
      S.detRow = 1;
      S.tabIndex = [...els.detTabs.children].indexOf(tab);
      showDetPanel();
      Sound.play('move');
    });

    els.detPanels.addEventListener('click', (e) => {
      const cell = e.target.closest('[data-cell]');
      if (!cell) return;
      S.detRow = 2;
      S.cellIndex = detCells().indexOf(cell);
      paintDetCursor();
      activateDetCell();
    });

    els.hintList.addEventListener('click', (e) => {
      const btn = e.target.closest('.bp-hint');
      if (!btn) return;
      flashHint(btn.dataset.hint);
      switch (btn.dataset.hint) {
        case 'play': play(); break;
        case 'details': openDetails(); break;
        case 'menu': openMenu(); break;
        case 'search': openSearch(); break;
        case 'filter': openFilter(); break;
        default: break;
      }
    });

    els.searchTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.bp-tab');
      if (tab) setSearchMode(tab.dataset.mode);
    });

    els.btnDl.onclick = () => (S.view === 'downloads' ? closeSheet() : openDownloads());

    // The now-playing pill jumps to that game and opens its options, which is
    // where Stop lives.
    els.playing.onclick = () => {
      const entry = runningEntry();
      if (!entry?.game) return;
      const b = bridge();
      const at = S.list.findIndex((g) => b?.gameKeyOf?.(g) === entry.key);
      if (at !== -1) select(at, { animate: false, force: true });
      openMenu();
    };

    els.dlRows.addEventListener('click', (e) => {
      const row = e.target.closest('.bp-row');
      if (!row) return;
      S.rowIndex = Number(row.dataset.ri) || 0;
      paintRowCursor(els.dlRows);
      runRow();
    });
    els.downloads.addEventListener('click', (e) => { if (e.target === els.downloads) closeSheet(); });

    els.search.addEventListener('click', (e) => {
      if (e.target === els.search) (oskOpen() ? closeOsk() : closeSearch());
    });
    wireQuery();
  }

  // ════════════════════════════════════════════════════════════════
  // Gamepad — Big Picture owns the pad while it is up.
  // ════════════════════════════════════════════════════════════════
  const Pad = (() => {
    const B = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9 };
    const FIRST = 400;
    const NEXT = 105;
    const DEAD = 0.5;

    let frame = 0;
    const held = new Map();

    function edge(name, down, repeat) {
      const now = performance.now();
      const state = held.get(name);
      if (!down) { held.delete(name); return false; }
      if (!state) { held.set(name, { since: now, last: now }); return true; }
      if (!repeat) return false;
      const interval = now - state.since > FIRST ? NEXT : FIRST;
      if (now - state.last >= interval) { state.last = now; return true; }
      return false;
    }

    const down = (pad, i) => Boolean(pad.buttons[i]?.pressed);

    function poll() {
      frame = 0;
      if (!S.open || document.hidden) { held.clear(); return; }

      const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
      const pad = pads[0];
      if (!pad) { held.clear(); return; }

      if (pad) {
        const [lx = 0, ly = 0, , ry = 0] = pad.axes;

        const up = down(pad, 12) || ly < -DEAD;
        const dn = down(pad, 13) || ly > DEAD;
        const lf = down(pad, 14) || lx < -DEAD;
        const rt = down(pad, 15) || lx > DEAD;

        if (edge('up', up, true)) move('up');
        if (edge('down', dn, true)) move('down');
        if (edge('left', lf, true)) move('left');
        if (edge('right', rt, true)) move('right');

        // Right stick pages through a grid quickly.
        if (edge('rsUp', ry < -DEAD, true)) { for (let n = 0; n < 3; n++) move('up'); }
        if (edge('rsDn', ry > DEAD, true)) { for (let n = 0; n < 3; n++) move('down'); }

        if (edge('A', down(pad, B.A))) { flashHint('play'); activate(); }
        if (edge('B', down(pad, B.B))) back();
        if (edge('X', down(pad, B.X))) {
          if (S.view === 'browse') { flashHint('details'); openDetails(); }
          // On a store page X is the shortcut past the row list: the reason
          // you opened the page is the first action on it.
          else if (S.view === 'store') { flashHint('details'); runStoreInstall(); }
        }
        if (edge('Y', down(pad, B.Y))) {
          if (S.view !== 'search' && S.view !== 'modal') {
            flashHint('search');
            if (S.view === 'storefront' || S.view === 'store') openStoreSearch();
            else openSearch();
          }
        }
        if (edge('LB', down(pad, B.LB))) cycleSection(-1);
        if (edge('RB', down(pad, B.RB))) cycleSection(1);
        if (edge('LT', down(pad, B.LT))) { if (S.view === 'browse') toggleLayout(); }
        if (edge('RT', down(pad, B.RT))) { flashHint('filter'); if (S.view === 'browse') openFilter(); }
        if (edge('VIEW', down(pad, B.VIEW))) { if (S.view === 'browse' || S.view === 'details') { flashHint('menu'); openMenu(); } }
        if (edge('MENU', down(pad, B.MENU))) {
          if (S.view === 'modal') { /* the dialog owns the screen */ }
          else if (S.view === 'system') closeSheet();
          else openSystem();
        }
      }

      frame = requestAnimationFrame(poll);
    }

    return {
      start() {
        if (S.open && !document.hidden && !frame && navigator.getGamepads?.().some(pad => pad)) frame = requestAnimationFrame(poll);
      },
      stop() { if (frame) cancelAnimationFrame(frame); frame = 0; held.clear(); },
    };
  })();

  // ════════════════════════════════════════════════════════════════
  // Open / close
  // ════════════════════════════════════════════════════════════════
  function applyPrefs() {
    const p = prefs();
    const accent = /^#[0-9a-fA-F]{6}$/.test(String(p.bigpicture_accent || '')) ? p.bigpicture_accent : '#17C8B6';
    els.root.style.setProperty('--bp-accent', accent);
    const rgb = [1, 3, 5].map((at) => parseInt(accent.slice(at, at + 2), 16));
    els.root.style.setProperty('--bp-accent-soft', `rgba(${rgb.join(',')},0.24)`);
    els.root.style.setProperty('--bp-accent-glow', `rgba(${rgb.join(',')},0.42)`);
    els.root.dataset.rounded = p.bigpicture_rounded === false ? 'off' : 'on';
    els.root.dataset.motion = motionOff() ? 'off' : 'on';
  }

  /**
   * Give the entrance transition back, but only once the renderer can actually
   * paint.
   *
   * The obvious version — drop .no-anim on a short timer — is wrong, and wrong
   * in a way that leaves the whole UI visibly broken. Timers keep firing for a
   * hidden renderer while frames do not, so the jump to the open state is never
   * committed; removing .no-anim then hands the element back to its transition,
   * which starts at opacity 0 and scale(1.028) and stays there for good.
   * Measured: #bp-root at -22.4,-12.6 sized 1644.8x925.2 inside a 1600x900
   * viewport, which is what "there is a padding, it is not really fullscreen"
   * looks like. Waiting for a real frame is the only signal that means the
   * renderer is live.
   */
  function releaseNoAnim() {
    const settle = () => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        els.root?.classList.remove('no-anim');
      }));
    };
    if (document.visibilityState === 'visible') { settle(); return; }
    document.addEventListener('visibilitychange', function once() {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', once);
      settle();
    });
  }

  /**
   * Coming back on screen — after a game, after a minimise — is the moment the
   * window may no longer be the size Big Picture laid itself out for, and the
   * moment a frozen entrance can finally be finished. Both are cheap to redo
   * and neither is safe to assume happened.
   */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !S.open || !els.root) return;
    safely('resettle', () => {
      if (prefs().bigpicture_fullscreen !== false) api()?.setFullScreen?.(true);
      els.root.classList.add('no-anim', 'is-open');
      releaseNoAnim();
    });
  });

  function open() {
    const b = bridge();
    if (!b) { console.warn('[bigpicture] the app bridge is not ready yet'); return; }
    if (S.open) return;

    build();
    S.open = true;
    S.view = 'browse';
    S.layout = prefs().bigpicture_layout === 'grid' ? 'grid' : 'horizontal';
    els.root.dataset.layout = S.layout;
    els.btnGrid.classList.toggle('is-on', S.layout === 'grid');
    setZone(S.layout === 'grid' ? 'grid' : 'shelf');
    applyPrefs();

    document.documentElement.dataset.bp = 'on';
    els.root.hidden = false;
    // #bp-root is a stacking context, so a dialog left in <body> could never
    // paint above it. Adopting the container is what lets the depot and
    // destination sheets appear over Big Picture instead of behind it.
    adoptModal();

    buildGroups();
    rebuildList({ keepSelection: false });

    detectPadBrand();
    paintHints();
    paintDownloadChip();
    paintNowPlaying();
    if (modalOpen()) enterModal();

    els.clock.textContent = clockText();
    clearInterval(clockTimer);
    clockTimer = setInterval(() => { els.clock.textContent = clockText(); }, 15000);

    // Running games and update badges change underneath us.
    clearInterval(liveTimer);
    liveTimer = setInterval(() => {
      if (!S.open) return;
      safely('now-playing', paintNowPlaying);

      // Coming back is normally driven by the session-stopped event. If that
      // never arrives — the launcher lost track of the process, the game was
      // killed from Task Manager — the window would stay minimised for good,
      // which reads as the launcher having crashed. Polling for "nothing is
      // running any more" costs one map lookup a second and removes that
      // failure entirely.
      if (S.steppedAside && Date.now() - S.steppedAsideAt > 4000 && !runningEntry()) {
        safely('come-back-fallback', comeBack);
      }

      if (S.view === 'browse' && current()) paintFlags();
    }, 1000);

    if (prefs().bigpicture_fullscreen !== false) safely('fullscreen', () => api()?.setFullScreen?.(true));

    // No animation frames arrive to a hidden window, so land on the open state
    // directly rather than starting a transition that would freeze at zero.
    if (framesStalled() || motionOff()) {
      els.root.classList.add('no-anim', 'is-open');
      releaseNoAnim();
    } else {
      setTimeout(() => els.root.classList.add('is-open'), 0);
    }

    Pad.start();
    Sound.play('open');
    window.dispatchEvent(new CustomEvent('librarian:bigpicture', { detail: { open: true } }));
  }

  /** The running game, if any, straight from the app's own session tracking. */
  function runningEntry() {
    const b = bridge();
    const running = b?.state?.running || {};
    const key = Object.keys(running)[0];
    if (!key) return null;
    const game = (b.games || []).find((g) => b.gameKeyOf?.(g) === key);
    return { key, game, ...running[key] };
  }

  function paintNowPlaying() {
    const entry = runningEntry();
    els.playing.hidden = !entry;
    if (!entry) return;
    els.playingName.textContent = entry.name || entry.game?.game_name || 'Playing';
    const seconds = Math.max(0, Math.floor((Date.now() - (entry.startedAt || Date.now())) / 1000));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const sec = seconds % 60;
    els.playingTime.textContent = h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  }

  /** Refresh only the badges, so a game starting elsewhere shows up here. */
  function paintFlags() {
    const b = bridge();
    const host = S.layout === 'grid' ? els.grid : els.track;
    [...host.children].forEach((card, i) => {
      const game = S.list[i];
      if (!game) return;
      const flags = card.querySelector('.bp-card-flags');
      if (!flags) return;
      const want = [];
      if (b?.isGameRunning?.(game)) want.push(`<span class="bp-flag is-live">${svg(ICON.play)}</span>`);
      else if (hasUpdate(game)) want.push(`<span class="bp-flag is-update">${svg(ICON.download)}</span>`);
      if (b?.isFavorite?.(game)) want.push(`<span class="bp-flag is-fav">${svg(ICON.star)}</span>`);
      const html = want.join('');
      if (flags.innerHTML !== html) flags.innerHTML = html;
    });
  }

  function close() {
    if (!S.open) return;
    S.open = false;

    stopTrailer();
    stopShelfTrailer();
    // The store owns a <video> of its own, and leaving Big Picture with one
    // still attached leaves it decoding behind a hidden root.
    stopStoreMedia();
    els.menu.classList.remove('is-on');
    els.filter.classList.remove('is-on');
    els.system.classList.remove('is-on');
    els.search.classList.remove('is-on');
    els.details.classList.remove('is-on');
    els.store.classList.remove('is-on');
    els.storefront.classList.remove('is-on');
    els.curtain.classList.remove('is-on');
    els.root.classList.remove('is-open');

    clearInterval(clockTimer);
    clearInterval(liveTimer);
    clearTimeout(metaTimer);
    clearTimeout(bgTimer);
    Pad.stop();

    delete document.documentElement.dataset.bp;
    closeOsk({ quiet: true });
    // Put the dialog container back before the root is hidden, or an open
    // dialog would vanish with it.
    releaseModal();
    if (prefs().bigpicture_fullscreen !== false) safely('fullscreen', () => api()?.setFullScreen?.(false));

    setTimeout(() => { if (!S.open) els.root.hidden = true; }, 380);
    Sound.play('close');
    window.dispatchEvent(new CustomEvent('librarian:bigpicture', { detail: { open: false } }));
  }

  const toggle = () => (S.open ? close() : open());

  // ════════════════════════════════════════════════════════════════
  // Wiring
  // ════════════════════════════════════════════════════════════════
  function init() {
    window.addEventListener('keydown', onKeyDown, true);

    // A rescan, a new favourite or a new collection all change what the rail
    // and the shelf should show.
    window.addEventListener('librarian:games', () => {
      if (!S.open) return;
      safely('refresh-games', () => { buildGroups(); rebuildList(); });
    });

    // A game exiting is Big Picture's cue to come back to the front.
    window.addEventListener('librarian:session', (e) => {
      if (e.detail?.type !== 'stopped') return;
      safely('session-end', () => {
        comeBack();
        if (S.open) { renderCards(); select(S.index, { animate: false, force: true }); }
      });
    });

    window.addEventListener('librarian:collections', () => {
      if (!S.open) return;
      safely('refresh-collections', () => { buildGroups(); rebuildList(); });
    });

    window.addEventListener('librarian:prefs', () => {
      if (!S.built) return;
      safely('refresh-prefs', applyPrefs);
      // Switched off from the desktop settings page while Big Picture is up.
      if (S.open && prefs().bigpicture_trailer_bg === false) safely('trailer-off', stopShelfTrailer);
    });

    // Downloads keep running whether or not Big Picture is on screen, so the
    // state is recorded either way and only painted when there is a UI for it.
    window.addEventListener('librarian:download', (e) => {
      S.download = e.detail?.active ? e.detail : null;
      if (!S.built || !S.open) return;
      safely('paint-download', () => {
        paintDownloadChip();
        if (S.view === 'downloads') paintDownloads();
        safely('update-progress', paintUpdateProgress);
      });
    });

    window.addEventListener('librarian:queue', (e) => {
      S.queue = e.detail?.jobs || [];
      if (!S.built || !S.open) return;
      safely('paint-queue', () => { if (S.view === 'downloads') paintDownloads(); });
    });

    // Layout depends on measured card widths, which change with the window.
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      if (!S.open) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (S.layout === 'horizontal') moveTrack(false);
        else cardAt(S.index)?.scrollIntoView({ block: 'nearest' });
      }, 120);
    });

    // Re-measure after coming back from a hidden window, where layout could
    // have shifted while nothing was being painted.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) Pad.stop(); else if (S.open) Pad.start();
      if (S.open && document.visibilityState === 'visible' && S.layout === 'horizontal') {
        setTimeout(() => moveTrack(false), 0);
      }
    });

    safely('modal-bridge', watchModal);

    for (const evt of ['gamepadconnected', 'gamepaddisconnected']) {
      window.addEventListener(evt, () => {
        safely('pad-brand', detectPadBrand);
        if (S.open) {
          Pad.stop();
          Pad.start();
        }
      });
    }

    const button = document.getElementById('btn-bigpicture');
    if (button) button.onclick = () => toggle();
  }

  window.LibrarianBigPicture = {
    get isOpen() { return S.open; },
    open: () => safely('open', open),
    close: () => safely('close', close),
    toggle: () => safely('toggle', toggle),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => safely('init', init));
  else safely('init', init);
})();
