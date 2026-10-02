// ═══════════════════════════════════════════════════════════════════
// Librarian — enhancement layer
//
// Everything here is additive. It talks to the app through window.Librarian
// (a small read-mostly bridge) and the `librarian:*` events app.js emits, so
// the core download/launch logic stays untouched and this file can fail
// without taking the launcher with it.
//
//   · Command palette (Ctrl/⌘ K)          · Gamepad navigation
//   · Global keyboard shortcuts + sheet   · Pointer tilt & spotlight
//   · Shelf rails, drag-scroll, fades     · Hero rotation & parallax
//   · Download HUD + taskbar progress     · Accent extracted from cover art
//   · Collections rail                    · Interface sounds
//   · Scroll reveals                      · First-run onboarding
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const root = document.documentElement;

  /** The bridge is published by app.js; everything here degrades if it is absent. */
  const app = () => window.Librarian || null;
  const prefs = () => (app()?.settings) || {};
  const reduceMotion = () => root.classList.contains('reduce-motion')
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const isTypingTarget = (el) => !!el && (
    el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
  );

  function safely(label, fn) {
    try { return fn(); } catch (e) { console.error(`[enhance] ${label} failed:`, e); return null; }
  }

  // ════════════════════════════════════════════════════════════════
  // Interface sounds — synthesised, so there are no audio files to ship
  // and no download to wait for. Off unless the user turns them on.
  // ════════════════════════════════════════════════════════════════
  const Sound = (() => {
    let ctx = null;
    const ensure = () => {
      if (!ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        ctx = new Ctor();
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    };

    const VOICES = {
      move:    { freq: 620,  type: 'sine',     dur: 0.045, gain: 0.16, slide: 0 },
      select:  { freq: 880,  type: 'triangle', dur: 0.085, gain: 0.24, slide: 220 },
      back:    { freq: 400,  type: 'sine',     dur: 0.09,  gain: 0.2,  slide: -140 },
      launch:  { freq: 523,  type: 'triangle', dur: 0.24,  gain: 0.3,  slide: 400 },
      error:   { freq: 180,  type: 'sawtooth', dur: 0.16,  gain: 0.18, slide: -50 },
      success: { freq: 660,  type: 'sine',     dur: 0.3,   gain: 0.26, slide: 330 },
      open:    { freq: 500,  type: 'sine',     dur: 0.11,  gain: 0.2,  slide: 180 },
    };

    let lastPlayed = 0;
    return {
      play(name) {
        if (!prefs().ui_sounds) return;
        // Rapid navigation would otherwise machine-gun the speakers.
        const now = performance.now();
        if (name === 'move' && now - lastPlayed < 45) return;
        lastPlayed = now;

        safely('sound', () => {
          const audio = ensure();
          const voice = VOICES[name];
          if (!audio || !voice) return;

          const volume = clamp(Number(prefs().ui_sound_volume ?? 0.35), 0, 1);
          if (volume <= 0) return;

          const osc = audio.createOscillator();
          const gain = audio.createGain();
          const t = audio.currentTime;

          osc.type = voice.type;
          osc.frequency.setValueAtTime(voice.freq, t);
          if (voice.slide) osc.frequency.exponentialRampToValueAtTime(
            Math.max(60, voice.freq + voice.slide), t + voice.dur
          );

          // Short attack, exponential release — reads as a "tick", not a beep.
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.exponentialRampToValueAtTime(voice.gain * volume, t + 0.008);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + voice.dur);

          osc.connect(gain).connect(audio.destination);
          osc.start(t);
          osc.stop(t + voice.dur + 0.02);
        });
      },
    };
  })();

  // ════════════════════════════════════════════════════════════════
  // Input mode — drives which focus ring is shown.
  // ════════════════════════════════════════════════════════════════
  function setNavMode(mode) {
    if (root.dataset.nav !== mode) root.dataset.nav = mode;
  }
  window.addEventListener('pointerdown', () => setNavMode('pointer'), true);
  window.addEventListener('keydown', (e) => {
    if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) setNavMode('key');
  }, true);

  // ════════════════════════════════════════════════════════════════
  // Scroll reveals — one shared observer for every tile ever rendered.
  // ════════════════════════════════════════════════════════════════
  const revealObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries, observer) => {
      // Stagger by position within the batch that just became visible.
      let index = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.style.setProperty('--reveal-delay', `${Math.min(index * 28, 260)}ms`);
        entry.target.classList.add('shown');
        observer.unobserve(entry.target);
        index++;
      }
    }, { rootMargin: '80px 0px', threshold: 0.02 })
    : null;

  function observeReveals(container) {
    const targets = $$('.reveal:not(.shown)', container);
    if (!revealObserver || reduceMotion()) {
      targets.forEach(el => el.classList.add('shown'));
      return;
    }
    targets.forEach(el => revealObserver.observe(el));
  }

  // ════════════════════════════════════════════════════════════════
  // Tile tilt + cursor spotlight, via delegation so the cost does not
  // scale with library size.
  // ════════════════════════════════════════════════════════════════
  function setupTilt() {
    let active = null;
    let frame = 0;
    let pending = null;

    const apply = () => {
      frame = 0;
      if (!active || !pending) return;
      const { rect, x, y } = pending;
      const px = (x - rect.left) / rect.width;
      const py = (y - rect.top) / rect.height;

      active.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
      active.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);

      if (root.dataset.tilt === 'on' && !reduceMotion()) {
        const MAX = 7;
        active.style.setProperty('--ry', `${((px - 0.5) * MAX * 2).toFixed(2)}deg`);
        active.style.setProperty('--rx', `${((0.5 - py) * MAX * 1.4).toFixed(2)}deg`);
        active.style.setProperty('--tz', '14px');
      }
    };

    document.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      const tile = e.target.closest?.('.game-tile');
      if (tile !== active) {
        if (active) reset(active);
        active = tile || null;
        if (active && root.dataset.tilt === 'on' && !reduceMotion()) active.classList.add('tilting');
      }
      if (!active) return;
      pending = { rect: active.getBoundingClientRect(), x: e.clientX, y: e.clientY };
      if (!frame) frame = requestAnimationFrame(apply);
    }, { passive: true });

    document.addEventListener('pointerleave', () => { if (active) { reset(active); active = null; } }, true);
    // A scroll under a stationary cursor leaves the tilt stuck otherwise.
    document.addEventListener('scroll', () => { if (active) { reset(active); active = null; } }, true);

    function reset(tile) {
      tile.classList.remove('tilting');
      tile.style.removeProperty('--rx');
      tile.style.removeProperty('--ry');
      tile.style.removeProperty('--tz');
    }
  }

  // ════════════════════════════════════════════════════════════════
  // Shelves: scroll rails, edge fades, wheel-to-horizontal, drag to pan.
  // ════════════════════════════════════════════════════════════════
  function setupShelves() {
    const wire = (scroller) => {
      if (scroller.dataset.railed) return;
      scroller.dataset.railed = '1';

      const row = scroller.closest('.game-row');
      if (!row) return;

      const left = document.createElement('button');
      left.className = 'row-rail left';
      left.innerHTML = '‹';
      left.setAttribute('aria-label', 'Scroll left');

      const right = document.createElement('button');
      right.className = 'row-rail right';
      right.innerHTML = '›';
      right.setAttribute('aria-label', 'Scroll right');

      const page = () => Math.max(240, scroller.clientWidth * 0.82);
      left.onclick = () => { scroller.scrollBy({ left: -page(), behavior: reduceMotion() ? 'auto' : 'smooth' }); Sound.play('move'); };
      right.onclick = () => { scroller.scrollBy({ left: page(), behavior: reduceMotion() ? 'auto' : 'smooth' }); Sound.play('move'); };

      row.append(left, right);

      const sync = () => {
        const max = scroller.scrollWidth - scroller.clientWidth;
        const x = scroller.scrollLeft;
        left.classList.toggle('can', x > 6);
        right.classList.toggle('can', x < max - 6);
        // Only fade the side that actually has more content behind it.
        scroller.style.setProperty('--fade-l', x > 6 ? '46px' : '0px');
        scroller.style.setProperty('--fade-r', x < max - 6 ? '46px' : '0px');
      };

      scroller.addEventListener('scroll', () => requestAnimationFrame(sync), { passive: true });
      new ResizeObserver(sync).observe(scroller);
      sync();

      // A vertical wheel over a shelf should move the shelf, not the page.
      scroller.addEventListener('wheel', (e) => {
        if (e.deltaX !== 0 || e.shiftKey) return;
        const max = scroller.scrollWidth - scroller.clientWidth;
        if (max <= 0) return;
        const atStart = scroller.scrollLeft <= 0 && e.deltaY < 0;
        const atEnd = scroller.scrollLeft >= max - 1 && e.deltaY > 0;
        if (atStart || atEnd) return; // let the page take over at the ends
        e.preventDefault();
        scroller.scrollLeft += e.deltaY;
      }, { passive: false });

      // Click-and-drag panning, without stealing ordinary clicks.
      let dragging = false;
      let startX = 0;
      let startScroll = 0;
      let moved = 0;

      scroller.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'touch' || e.button !== 0) return;
        if (e.target.closest('button')) return;
        dragging = true;
        moved = 0;
        startX = e.clientX;
        startScroll = scroller.scrollLeft;
      });
      scroller.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const delta = e.clientX - startX;
        moved = Math.abs(delta);
        if (moved > 6) {
          scroller.classList.add('dragging');
          scroller.setPointerCapture?.(e.pointerId);
          scroller.scrollLeft = startScroll - delta;
        }
      });
      const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        scroller.classList.remove('dragging');
      };
      scroller.addEventListener('pointerup', endDrag);
      scroller.addEventListener('pointercancel', endDrag);
    };

    $$('.row-scroll').forEach(wire);
    window.addEventListener('librarian:rendered', (e) => {
      const container = e.detail?.container;
      if (container?.classList.contains('row-scroll')) wire(container);
    });
  }

  // ════════════════════════════════════════════════════════════════
  // Hero: rotation through your top games, plus scroll parallax.
  // ════════════════════════════════════════════════════════════════
  const Hero = (() => {
    const INTERVAL = 11000;
    let candidates = [];
    let index = 0;
    let timer = null;
    let paused = false;

    function renderDots() {
      const dots = $('#hero-dots');
      if (!dots) return;
      if (candidates.length < 2) { dots.innerHTML = ''; return; }
      dots.style.setProperty('--hero-interval', `${INTERVAL}ms`);
      dots.innerHTML = candidates.map((g, i) =>
        `<button class="${i === index ? 'active' : ''}" aria-label="Show ${(g.game_name || 'game').replace(/"/g, '')}"></button>`
      ).join('');
      $$('#hero-dots button').forEach((btn, i) => {
        btn.onclick = () => { show(i); restart(); Sound.play('move'); };
      });
    }

    function show(next) {
      const bridge = app();
      if (!bridge || !candidates.length) return;
      index = ((next % candidates.length) + candidates.length) % candidates.length;
      const section = $('#hero-section');
      const content = $('#hero-content');

      // Re-trigger the entrance animation on the copy without touching the art,
      // so the crossfade and the text reveal do not fight each other.
      if (content && !reduceMotion()) {
        section?.classList.add('swapping');
        content.style.opacity = '0';
        setTimeout(() => {
          bridge.setHeroGame(candidates[index]);
          section?.classList.remove('swapping');
          content.style.opacity = '';
        }, 170);
      } else {
        bridge.setHeroGame(candidates[index]);
      }
      renderDots();
    }

    function restart() {
      clearInterval(timer);
      timer = null;
      if (prefs().hero_rotate === false || candidates.length < 2) return;
      timer = setInterval(() => {
        if (paused || document.hidden || app()?.state?.currentPage !== 'home') return;
        show(index + 1);
      }, INTERVAL);
    }

    function setCandidates(list, current) {
      candidates = Array.isArray(list) ? list : [];
      const at = candidates.indexOf(current);
      index = at === -1 ? 0 : at;
      renderDots();
      restart();
    }

    // Pause while the pointer is over the hero — nobody wants the thing they
    // are about to click to slide away.
    function setupHover() {
      const section = $('#hero-section');
      if (!section) return;
      section.addEventListener('pointerenter', () => { paused = true; });
      section.addEventListener('pointerleave', () => { paused = false; });
    }

    // Gentle parallax as the home page scrolls. The artwork lags behind the
    // scroll, and the hero fades out *as a whole* — fading only the text while
    // the art stayed at full brightness read as a rendering bug.
    function setupParallax() {
      const scroller = $('#home-scroll');
      const section = $('#hero-section');
      const bg = $('#hero-bg');
      const content = $('#hero-content');
      if (!scroller || !bg || !section) return;

      let frame = 0;
      const apply = () => {
        frame = 0;
        const y = scroller.scrollTop;
        const height = section.offsetHeight || 420;
        if (y > height * 1.4) return;   // fully scrolled past; nothing to update

        bg.style.setProperty('translate', `0 ${(y * 0.26).toFixed(1)}px`);
        if (content) content.style.setProperty('translate', `0 ${(y * 0.08).toFixed(1)}px`);

        // Hold full opacity until the hero is a third of the way out, then fade
        // the whole section together over the remainder.
        const fade = clamp((y - height * 0.33) / (height * 0.6), 0, 1);
        section.style.opacity = String(1 - fade * 0.9);
      };

      scroller.addEventListener('scroll', () => {
        if (frame || reduceMotion()) return;
        frame = requestAnimationFrame(apply);
      }, { passive: true });
    }

    return {
      init() { setupHover(); setupParallax(); },
      setCandidates,
      next() { show(index + 1); restart(); },
      prev() { show(index - 1); restart(); },
      refresh() { restart(); },
    };
  })();

  // ════════════════════════════════════════════════════════════════
  // Accent extracted from the featured game's cover art.
  // ════════════════════════════════════════════════════════════════
  const Accent = (() => {
    const cache = new Map();

    /** Average the image's saturated pixels, then force it to a usable accent. */
    function dominantColor(url) {
      if (cache.has(url)) return Promise.resolve(cache.get(url));
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          const result = safely('accent-sample', () => {
            const W = 48;
            const H = Math.max(1, Math.round((img.height / img.width) * W)) || 24;
            const canvas = document.createElement('canvas');
            canvas.width = W;
            canvas.height = H;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, W, H);
            const { data } = ctx.getImageData(0, 0, W, H);

            let r = 0, g = 0, b = 0, weight = 0;
            for (let i = 0; i < data.length; i += 4) {
              const [pr, pg, pb, pa] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
              if (pa < 200) continue;
              const max = Math.max(pr, pg, pb);
              const min = Math.min(pr, pg, pb);
              const sat = max === 0 ? 0 : (max - min) / max;
              // Ignore near-black, near-white and grey pixels: box art is mostly
              // those, and they average out to mud.
              if (max < 40 || min > 225 || sat < 0.22) continue;
              const w = sat * sat;
              r += pr * w; g += pg * w; b += pb * w; weight += w;
            }
            if (weight < 1) return null;
            return normalise(r / weight, g / weight, b / weight);
          });
          cache.set(url, result);
          resolve(result);
        };
        img.onerror = () => { cache.set(url, null); resolve(null); };
        img.src = url;
      });
    }

    /** Push the sampled colour to a consistent lightness/saturation so every
     *  game produces an accent that is actually readable on the dark ink. */
    function normalise(r, g, b) {
      const [h, s, l] = rgbToHsl(r, g, b);
      const [nr, ng, nb] = hslToRgb(h, clamp(s, 0.42, 0.78), clamp(l, 0.55, 0.68));
      return `#${[nr, ng, nb].map(c => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    }

    function rgbToHsl(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      if (max === min) return [0, 0, l];
      const d = max - min;
      const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      let h;
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
      return [h, s, l];
    }

    function hslToRgb(h, s, l) {
      if (s === 0) return [l * 255, l * 255, l * 255];
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      const channel = (t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
    }

    let applied = null;
    return {
      /** Sampled cover colour, normalised for legibility on the dark theme. */
      sample: dominantColor,

      async applyFor(game) {
        const bridge = app();
        if (!bridge) return;
        const settings = prefs();

        // Turned off, or the user picked their own accent explicitly? Respect it.
        if (settings.dynamic_accent === false) {
          if (applied) {
            applied = null;
            bridge.applyThemeColors(settings.accent_color || '#D2A65C', settings.background_color || '#0C0D10');
          }
          return;
        }
        if (!game) return;

        const url = bridge.getGameBannerUrl(game, 'header');
        if (!url) return;
        const colour = await dominantColor(url);
        if (!colour || colour === applied) return;
        applied = colour;
        bridge.applyThemeColors(colour, settings.background_color || '#0C0D10');
      },
    };
  })();

  // ════════════════════════════════════════════════════════════════
  // Command palette
  // ════════════════════════════════════════════════════════════════
  const Palette = (() => {
    let open = false;
    let items = [];
    let cursor = 0;
    let closeTimer = null;
    let debounce = null;

    const el = () => $('#palette');
    const input = () => $('#palette-input');
    const list = () => $('#palette-list');

    const COMMANDS = () => {
      const bridge = app();
      if (!bridge) return [];
      const cmds = [
        { icon: '⌂', title: 'Go to Home', hint: '1', run: () => bridge.navigateTo('home') },
        { icon: '❏', title: 'Go to Library', hint: '2', run: () => bridge.setLibraryView('all') },
        { icon: '⌕', title: 'Go to Store', hint: '3', run: () => bridge.navigateTo('store') },
        { icon: '⬇', title: 'Go to Downloads', hint: '4', run: () => bridge.navigateTo('downloads') },
        { icon: '⚙', title: 'Go to Settings', hint: '6', run: () => bridge.navigateTo('settings') },
        { icon: '★', title: 'Show favorites', run: () => bridge.setLibraryView('favorites') },
        { icon: '↻', title: 'Scan for games', hint: 'F5', run: () => bridge.scanAndRender() },
        { icon: '⬆', title: 'Check for updates', run: () => bridge.checkUpdates({ force: true }) },
        { icon: '⬆', title: 'Update all games', run: () => bridge.updateAllGames() },
        { icon: '＋', title: 'Add a custom game', run: () => bridge.addCustomGame() },
        { icon: '❏', title: 'New collection…', run: () => promptNewCollection() },
        { icon: '⌨', title: 'Keyboard shortcuts', hint: '?', run: () => Shortcuts.show() },
        {
          icon: '🎮',
          title: 'Open Big Picture',
          hint: 'Ctrl ⇧ B',
          run: () => window.LibrarianBigPicture?.open(),
        },
        {
          icon: '◐',
          title: `Turn ${prefs().reduce_motion ? 'on' : 'off'} animations`,
          run: async () => {
            const next = !prefs().reduce_motion;
            await window.api.setSetting('reduce_motion', next);
            root.classList.toggle('reduce-motion', next);
            const box = $('#chk-reduce-motion');
            if (box) box.checked = next;
            await bridge.refreshSettings();
            bridge.toast(next ? 'Animations reduced' : 'Animations restored', 'success');
          },
        },
        {
          icon: '⚡',
          title: `Turn the kinetic interface ${prefs().ui_kinetic === false ? 'on' : 'off'}`,
          run: async () => {
            const next = prefs().ui_kinetic === false;
            await window.api.setSetting('ui_kinetic', next);
            const box = $('#chk-kinetic');
            if (box) box.checked = next;
            const settings = await bridge.refreshSettings();
            // js/kinetic.js flips the root attribute off the back of this.
            window.dispatchEvent(new CustomEvent('librarian:prefs', { detail: settings }));
            bridge.toast(next ? 'Kinetic interface on' : 'Kinetic interface off', 'success');
          },
        },
        {
          icon: '♪',
          title: `Turn interface sounds ${prefs().ui_sounds ? 'off' : 'on'}`,
          run: async () => {
            const next = !prefs().ui_sounds;
            await window.api.setSetting('ui_sounds', next);
            const box = $('#chk-ui-sounds');
            if (box) { box.checked = next; $('#row-sound-volume').style.display = next ? '' : 'none'; }
            await bridge.refreshSettings();
            bridge.toast(next ? 'Interface sounds on' : 'Interface sounds off', 'success');
          },
        },
      ];

      for (const name of Object.keys(bridge.getCollections())) {
        cmds.push({ icon: '❏', title: `Open collection: ${name}`, run: () => bridge.setLibraryView('collection', name) });
      }
      return cmds;
    };

    function build(query) {
      const bridge = app();
      if (!bridge) return [];

      const commandMode = query.startsWith('>');
      const term = commandMode ? query.slice(1).trim() : query.trim();
      const mode = $('#palette-mode');
      if (mode) mode.textContent = commandMode ? 'Commands' : (term ? 'Search' : 'All');

      const results = [];

      // Commands
      const commands = COMMANDS();
      const commandHits = [];
      for (const cmd of commands) {
        const match = bridge.fuzzyMatch(cmd.title, term);
        if (term && !match) continue;
        commandHits.push({ ...cmd, group: 'Commands', score: match ? match.score : 0, positions: match?.positions });
      }
      commandHits.sort((a, b) => b.score - a.score);

      if (commandMode) return commandHits.slice(0, 40);

      // Games
      const gameHits = [];
      for (const game of bridge.games) {
        const match = bridge.fuzzyMatch(game.game_name, term);
        if (term && !match) continue;
        gameHits.push({
          group: 'Games',
          game,
          title: game.game_name,
          positions: match?.positions,
          score: (match ? match.score : 0)
            + (bridge.isFavorite(game) ? 40 : 0)
            + (bridge.isGameRunning(game) ? 300 : 0)
            + Math.min(60, (game.playtime_seconds || 0) / 3600),
          sub: [
            bridge.isGameRunning(game) ? 'Running' : null,
            (game.playtime_seconds || 0) > 0 ? `${bridge.formatPlaytime(game.playtime_seconds)} played` : 'Never played',
            game.size_on_disk ? bridge.formatSize(game.size_on_disk) : null,
          ].filter(Boolean).join(' · '),
          hint: '↵ open · ⇧↵ play',
          run: () => bridge.openFlyout(game),
          runAlt: () => bridge.launchGame(game),
        });
      }
      gameHits.sort((a, b) => b.score - a.score);

      // With no query at all, lead with recently played rather than A–Z noise.
      if (!term) {
        gameHits.sort((a, b) => (b.game.last_played || 0) - (a.game.last_played || 0));
      }

      results.push(...gameHits.slice(0, 40));
      results.push(...commandHits.slice(0, term ? 12 : 8));

      // Offer a store lookup for anything not already on the shelves.
      if (term.length >= 2) {
        results.push({
          group: 'Store',
          icon: '⌕',
          title: `Search the store for “${term}”`,
          hint: '↵',
          run: () => bridge.searchStore(term),
        });
      }
      return results;
    }

    function render(query) {
      const bridge = app();
      const container = list();
      if (!container || !bridge) return;

      items = build(query);
      cursor = 0;

      if (!items.length) {
        container.innerHTML = '<div class="cmd-empty">Nothing matches. Try <b>&gt;</b> for commands.</div>';
        return;
      }

      let html = '';
      let group = null;
      items.forEach((item, i) => {
        if (item.group !== group) {
          group = item.group;
          html += `<div class="cmd-group">${bridge.esc(group)}</div>`;
        }
        const banner = item.game ? bridge.getGameBannerUrl(item.game, 'header') : '';
        const icon = banner
          ? `<span class="cmd-icon"><img src="${bridge.esc(banner)}" loading="lazy" data-hide-on-error=""></span>`
          : `<span class="cmd-icon">${bridge.esc(item.icon || '›')}</span>`;
        html += `
          <button class="cmd-item" role="option" data-index="${i}" aria-selected="${i === 0}">
            ${icon}
            <span class="cmd-body">
              <span class="cmd-title">${item.positions ? bridge.highlight(item.title, item.positions) : bridge.esc(item.title)}</span>
              ${item.sub ? `<span class="cmd-sub">${bridge.esc(item.sub)}</span>` : ''}
            </span>
            ${item.hint ? `<span class="cmd-hint">${bridge.esc(item.hint)}</span>` : ''}
          </button>`;
      });
      container.innerHTML = html;

      $$('.cmd-item', container).forEach((btn) => {
        btn.addEventListener('mousemove', () => select(Number(btn.dataset.index)));
        btn.onclick = (e) => run(Number(btn.dataset.index), e.shiftKey);
      });
    }

    function select(next) {
      if (!items.length) return;
      cursor = ((next % items.length) + items.length) % items.length;
      const buttons = $$('.cmd-item', list());
      buttons.forEach((b, i) => b.setAttribute('aria-selected', String(i === cursor)));
      buttons[cursor]?.scrollIntoView({ block: 'nearest' });
    }

    function run(index, alt) {
      const item = items[index];
      if (!item) return;
      close();
      Sound.play('select');
      const action = (alt && item.runAlt) ? item.runAlt : item.run;
      safely('palette-run', action);
    }

    function show(initial = '') {
      const node = el();
      if (!node || open) return;
      const panel = window.LibrarianDialogs.activePanel;
      if (panel && panel.id !== 'game-flyout') return;
      clearTimeout(closeTimer);
      closeTimer = null;
      clearTimeout(debounce);
      open = true;
      node.classList.remove('hidden', 'closing');
      node.setAttribute('aria-label', 'Search games and commands');
      window.LibrarianDialogs.enter(node, close);
      const field = input();
      field.value = initial;
      render(initial);
      field.focus();
      field.select();
      Sound.play('open');
    }

    function close() {
      const node = el();
      if (!node || !open) return;
      open = false;
      clearTimeout(debounce);
      window.LibrarianDialogs.leave(node);
      node.classList.add('closing');
      closeTimer = setTimeout(() => {
        closeTimer = null;
        if (!open) { node.classList.add('hidden'); node.classList.remove('closing'); }
      }, reduceMotion() ? 0 : 180);
    }

    function init() {
      window.addEventListener('librarian:search', event => show(event.detail || ''));
      const node = el();
      if (!node) return;

      input().addEventListener('input', (e) => {
        clearTimeout(debounce);
        const value = e.target.value;
        debounce = setTimeout(() => { if (open) render(value); }, 60);
      });

      input().addEventListener('keydown', (e) => {
        switch (e.key) {
          case 'ArrowDown': e.preventDefault(); select(cursor + 1); Sound.play('move'); break;
          case 'ArrowUp': e.preventDefault(); select(cursor - 1); Sound.play('move'); break;
          case 'Home': e.preventDefault(); select(0); break;
          case 'End': e.preventDefault(); select(items.length - 1); break;
          case 'PageDown': e.preventDefault(); select(cursor + 6); break;
          case 'PageUp': e.preventDefault(); select(cursor - 6); break;
          case 'Enter': e.preventDefault(); run(cursor, e.shiftKey); break;
          case 'Escape': e.preventDefault(); close(); Sound.play('back'); break;
          case 'Tab': e.preventDefault(); select(cursor + (e.shiftKey ? -1 : 1)); break;
        }
      });

      node.addEventListener('mousedown', (e) => { if (e.target === node) close(); });
    }

    return { init, show, close, get isOpen() { return open; } };
  })();

  async function promptNewCollection() {
    const bridge = app();
    if (!bridge) return;
    bridge.openModal('New collection', `
      <div class="form-group">
        <label>Name</label>
        <input type="text" class="form-input" id="new-coll-name" placeholder="e.g. Friday night co-op" maxlength="60">
      </div>
      <div class="modal-actions">
        <button class="xbox-btn xbox-btn-secondary" id="new-coll-cancel">Cancel</button>
        <button class="xbox-btn xbox-btn-primary" id="new-coll-ok">Create</button>
      </div>
    `);
    const field = $('#new-coll-name');
    const create = async () => {
      if (await bridge.createCollection(field.value)) bridge.closeModal();
    };
    $('#new-coll-ok').onclick = create;
    $('#new-coll-cancel').onclick = () => bridge.closeModal();
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
    field.focus();
  }

  // ════════════════════════════════════════════════════════════════
  // Keyboard shortcuts + the sheet that documents them
  // ════════════════════════════════════════════════════════════════
  const Shortcuts = (() => {
    const MAP = [
      ['Global', [
        ['Command palette', ['Ctrl', 'K']],
        ['Search the store', ['/']],
        ['This help', ['?']],
        ['Home · Library · Store · Downloads · Crack · Settings', ['1', '–', '6']],
        ['Rescan library', ['F5']],
        ['Back / close', ['Esc']],
        ['Toggle full screen', ['F11']],
      ]],
      ['Library', [
        ['Filter your library', ['Ctrl', 'F']],
        ['Move between games', ['↑', '↓', '←', '→']],
        ['Open details', ['↵']],
        ['Play the focused game', ['Shift', '↵']],
        ['Favorite the focused game', ['F']],
        ['Context menu', ['Menu']],
        ['Grid / list', ['V']],
      ]],
      ['Game details', [
        ['Previous · next game', ['←', '→']],
        ['Play', ['P']],
        ['Close', ['Esc']],
      ]],
      ['Gamepad', [
        ['Move', ['D-pad', '/', 'Stick']],
        ['Open', ['A']],
        ['Back', ['B']],
        ['Play focused game', ['X']],
        ['Command palette', ['Y']],
        ['Switch page', ['LB', '/', 'RB']],
      ]],
      ['Big Picture', [
        ['Open · close', ['Ctrl', 'Shift', 'B']],
        ['Play · back', ['A', '/', 'B']],
        ['Details · search', ['X', '/', 'Y']],
        ['Options · system', ['View', '/', 'Menu']],
        ['Filter · layout', ['RT', '/', 'LT']],
        ['Switch shelf', ['LB', '/', 'RB']],
      ]],
    ];

    function build() {
      const grid = $('#shortcut-grid');
      if (!grid || grid.dataset.built) return;
      grid.dataset.built = '1';
      grid.innerHTML = MAP.map(([section, rows]) => `
        <div class="sc-col">
          <h3>${section}</h3>
          ${rows.map(([label, keys]) => `
            <div class="sc-row">
              <span>${label}</span>
              <span class="keys">${keys.map(k => `<kbd>${k}</kbd>`).join('')}</span>
            </div>`).join('')}
        </div>`).join('');
    }

    function show() {
      const sheet = $('#shortcut-sheet');
      if (!sheet || !sheet.classList.contains('hidden')) return;
      const panel = window.LibrarianDialogs.activePanel;
      if (panel && panel.id !== 'game-flyout') return;
      build();
      sheet.classList.remove('hidden');
      window.LibrarianDialogs.enter(sheet, hide, 'shortcut-title');
      Sound.play('open');
    }
    function hide() {
      const sheet = $('#shortcut-sheet');
      if (!sheet) return;
      window.LibrarianDialogs.leave(sheet);
      sheet.classList.add('hidden');
    }

    function init() {
      const sheet = $('#shortcut-sheet');
      if (sheet) sheet.addEventListener('click', (e) => { if (e.target === sheet) hide(); });
      const btn = $('#btn-show-shortcuts');
      if (btn) btn.onclick = show;
      const close = $('#shortcut-close');
      if (close) close.onclick = hide;
    }

    return { init, show, hide, get isOpen() { return !$('#shortcut-sheet')?.classList.contains('hidden'); } };
  })();

  const PAGE_KEYS = { 1: 'home', 2: 'library', 3: 'store', 4: 'downloads', 5: 'crack', 6: 'settings' };

  function setupHotkeys() {
    // Label the nav tabs with their number so the shortcut is discoverable.
    $$('.nav-tab[data-page]').forEach((tab) => {
      const number = Object.entries(PAGE_KEYS).find(([, page]) => page === tab.dataset.page)?.[0];
      if (number && !tab.querySelector('.nav-key')) {
        const badge = document.createElement('span');
        badge.className = 'nav-key';
        badge.textContent = number;
        tab.appendChild(badge);
      }
    });

    // Holding Alt reveals them.
    window.addEventListener('keydown', (e) => { if (e.key === 'Alt') root.classList.add('show-hotkeys'); });
    window.addEventListener('keyup', (e) => { if (e.key === 'Alt') root.classList.remove('show-hotkeys'); });
    window.addEventListener('blur', () => root.classList.remove('show-hotkeys'));

    document.addEventListener('keydown', (e) => {
      const bridge = app();
      if (!bridge) return;
      // The tour owns the keyboard while it is running.
      if (Tour.isOpen || window.LibrarianBigPicture?.isOpen) return;

      // Ctrl/⌘ K works inside text fields; a pending dialog keeps ownership.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopImmediatePropagation();
        Palette.isOpen ? Palette.close() : Palette.show();
        return;
      }

      if (Palette.isOpen) return;

      if (e.key === 'Escape') {
        if (Shortcuts.isOpen) { Shortcuts.hide(); Sound.play('back'); return; }
        return; // app.js already handles modal/flyout dismissal
      }

      const panel = window.LibrarianDialogs.activePanel;
      if (panel && panel.id !== 'game-flyout') return;
      if (!panel && bridge.state.currentPage === 'library'
          && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        const field = $('#lib-filter');
        field?.focus();
        field?.select();
        return;
      }

      if (isTypingTarget(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const flyoutOpen = $('#game-flyout')?.classList.contains('flyout-open');

      // Detail view takes the arrows for stepping between games.
      if (flyoutOpen) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); bridge.stepFlyout(-1); Sound.play('move'); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); bridge.stepFlyout(1); Sound.play('move'); return; }
        if (e.key.toLowerCase() === 'p') { e.preventDefault(); bridge.launchGame(bridge.state.flyoutGame); return; }
        if (e.key.toLowerCase() === 'f') { e.preventDefault(); bridge.toggleFavorite(bridge.state.flyoutGame); return; }
        return;
      }

      if (PAGE_KEYS[e.key]) {
        e.preventDefault();
        bridge.navigateTo(PAGE_KEYS[e.key]);
        Sound.play('move');
        return;
      }

      switch (e.key) {
        case '?':
          e.preventDefault();
          Shortcuts.isOpen ? Shortcuts.hide() : Shortcuts.show();
          break;
        case '/':
          e.preventDefault();
          bridge.navigateTo('store');
          $('#search-input')?.focus();
          break;
        case 'F5':
          e.preventDefault();
          bridge.scanAndRender();
          bridge.toast('Rescanning…');
          break;
        default: {
          const key = e.key.toLowerCase();
          if (key === 'v' && bridge.state.currentPage === 'library') {
            e.preventDefault();
            setLibraryLayout(root.dataset.libview === 'grid' ? 'list' : 'grid');
          } else if (key === 'f') {
            const focused = document.activeElement?.closest?.('.game-tile');
            if (focused) {
              e.preventDefault();
              const game = gameForTile(focused);
              if (game) bridge.toggleFavorite(game);
            }
          } else if (key === 'g') {
            e.preventDefault();
            focusFirstTile();
          }
          break;
        }
      }
    }, true);

    // Tile activation (including Shift+Enter) belongs to createGameTile, so
    // opening details cannot move focus before the launch shortcut is handled.
  }

  function gameForTile(tile) {
    const bridge = app();
    if (!bridge || !tile?.dataset.key) return null;
    return bridge.games.find(g => bridge.gameKeyOf(g) === tile.dataset.key) || null;
  }

  function focusFirstTile() {
    const page = $('.page.active');
    const tile = page?.querySelector('.game-tile');
    if (tile) { tile.focus(); setNavMode('key'); }
  }

  // ════════════════════════════════════════════════════════════════
  // Spatial navigation — shared by arrow keys and the gamepad. Picks the
  // nearest focusable in the requested direction by geometry, which works
  // across grids, shelves and toolbars without any per-page wiring.
  // ════════════════════════════════════════════════════════════════
  const FOCUSABLE = '.game-tile, .result-card, .nav-tab, .sidebar-link, .xbox-btn:not(:disabled), .icon-btn, .queue-card, .dtab, .plate, .row-see-all, .seg button, .loc-row, .store-chip';

  function visibleFocusables() {
    const panel = window.LibrarianDialogs.activePanel;
    const selector = panel
      ? 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
      : FOCUSABLE;
    return $$(selector, panel || document).filter((el) => {
      if (el.disabled || el.tabIndex < 0 || el.closest('.hidden, [hidden], [inert]') || getComputedStyle(el).visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return false;
      // Only what is actually on screen; a shelf scrolled off to the right
      // should not steal focus from what the user can see.
      return rect.bottom > 40 && rect.top < window.innerHeight - 4
        && rect.right > 0 && rect.left < window.innerWidth;
    });
  }

  function moveFocus(direction) {
    const candidates = visibleFocusables();
    if (!candidates.length) return false;

    const current = document.activeElement && candidates.includes(document.activeElement)
      ? document.activeElement
      : null;

    if (!current) {
      candidates[0].focus();
      scrollFocusIntoView(candidates[0]);
      return true;
    }

    const from = current.getBoundingClientRect();
    const fx = from.left + from.width / 2;
    const fy = from.top + from.height / 2;

    let best = null;
    let bestCost = Infinity;

    for (const candidate of candidates) {
      if (candidate === current) continue;
      const rect = candidate.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = cx - fx;
      const dy = cy - fy;

      // Must lie meaningfully in the requested direction.
      const along = { left: -dx, right: dx, up: -dy, down: dy }[direction];
      const across = (direction === 'left' || direction === 'right') ? Math.abs(dy) : Math.abs(dx);
      if (along <= 6) continue;

      // Drifting sideways is penalised heavily, so a grid walks in straight lines.
      const cost = along + across * 2.6;
      if (cost < bestCost) { bestCost = cost; best = candidate; }
    }

    if (!best) return false;
    best.focus();
    scrollFocusIntoView(best);
    Sound.play('move');
    return true;
  }

  function scrollFocusIntoView(el) {
    const behavior = reduceMotion() ? 'auto' : 'smooth';
    const shelf = el.closest('.row-scroll');
    if (shelf) {
      const rect = el.getBoundingClientRect();
      const box = shelf.getBoundingClientRect();
      if (rect.left < box.left + 20) shelf.scrollBy({ left: rect.left - box.left - 40, behavior });
      else if (rect.right > box.right - 20) shelf.scrollBy({ left: rect.right - box.right + 40, behavior });
    }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior });
  }

  function setupSpatialNav() {
    document.addEventListener('keydown', (e) => {
      if (Palette.isOpen || Shortcuts.isOpen || Tour.isOpen) return;
      if (isTypingTarget(e.target)) return;
      if (!$('#modal-overlay')?.classList.contains('hidden')) return;
      if ($('#game-flyout')?.classList.contains('flyout-open')) return;

      const direction = {
        ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
      }[e.key];
      if (!direction) return;

      setNavMode(root.dataset.nav === 'pad' ? 'pad' : 'key');
      if (moveFocus(direction)) e.preventDefault();
    });
  }

  // ════════════════════════════════════════════════════════════════
  // Gamepad — a launcher a PC gamer can drive from the couch.
  // ════════════════════════════════════════════════════════════════
  const Gamepad = (() => {
    const BUTTON = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, BACK: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
    const REPEAT_FIRST = 420;
    const REPEAT_NEXT = 130;

    let running = false;
    let frame = 0;
    const held = new Map();

    function pressed(pad, index) { return Boolean(pad.buttons[index]?.pressed); }

    /** Edge detection with key-repeat, so holding a direction keeps moving. */
    function edge(name, isDown, repeatable) {
      const now = performance.now();
      const state = held.get(name);
      if (!isDown) { held.delete(name); return false; }
      if (!state) { held.set(name, { since: now, last: now }); return true; }
      if (!repeatable) return false;
      const interval = now - state.since > REPEAT_FIRST ? REPEAT_NEXT : REPEAT_FIRST;
      if (now - state.last >= interval) { state.last = now; return true; }
      return false;
    }

    function poll() {
      frame = 0;
      if (!running) return;

      // Visibility and Big Picture events resume desktop input when it is
      // needed again; an idle desktop does not need an animation-frame loop.
      if (document.hidden || window.LibrarianBigPicture?.isOpen || prefs().gamepad_nav === false) { stop(); return; }

      const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
      const bridge = app();
      if (!pads.length) { stop(); return; }

      if (pads.length && bridge) {
        for (const pad of pads) {
          const [lx = 0, ly = 0] = pad.axes;
          const DEAD = 0.55;

          const up = pressed(pad, BUTTON.UP) || ly < -DEAD;
          const down = pressed(pad, BUTTON.DOWN) || ly > DEAD;
          const left = pressed(pad, BUTTON.LEFT) || lx < -DEAD;
          const right = pressed(pad, BUTTON.RIGHT) || lx > DEAD;

          if (up || down || left || right) setNavMode('pad');

          if (edge('up', up, true)) act('up');
          if (edge('down', down, true)) act('down');
          if (edge('left', left, true)) act('left');
          if (edge('right', right, true)) act('right');

          if (edge('A', pressed(pad, BUTTON.A))) activate();
          if (edge('B', pressed(pad, BUTTON.B))) back();
          if (edge('X', pressed(pad, BUTTON.X))) playFocused();
          if (edge('Y', pressed(pad, BUTTON.Y))) Palette.show();
          if (edge('LB', pressed(pad, BUTTON.LB))) cyclePage(-1);
          if (edge('RB', pressed(pad, BUTTON.RB))) cyclePage(1);
          if (edge('START', pressed(pad, BUTTON.START))) Shortcuts.show();
          break; // one pad drives the UI
        }
      }
      frame = requestAnimationFrame(poll);
    }

    function act(direction) {
      if (Tour.isOpen) return;
      if (Palette.isOpen) {
        // Reuse the palette's own key handling.
        const key = direction === 'up' ? 'ArrowUp' : direction === 'down' ? 'ArrowDown' : null;
        if (key) $('#palette-input')?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        return;
      }
      const bridge = app();
      if (bridge && window.LibrarianDialogs.activePanel?.id === 'game-flyout') {
        if (direction === 'left') bridge.stepFlyout(-1);
        if (direction === 'right') bridge.stepFlyout(1);
        if (direction === 'up' || direction === 'down') moveFocus(direction);
        return;
      }
      moveFocus(direction);
    }

    function activate() {
      if (Tour.isOpen) return;
      Sound.play('select');
      if (Palette.isOpen) {
        $('#palette-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return;
      }
      const el = document.activeElement;
      const panel = window.LibrarianDialogs.activePanel;
      if (panel && !panel.contains(el)) { panel.focus(); return; }
      if (el && el !== document.body && typeof el.click === 'function') el.click();
      else focusFirstTile();
    }

    function back() {
      if (Tour.isOpen) return;
      Sound.play('back');
      const bridge = app();
      if (window.LibrarianDialogs.activePanel) return window.LibrarianDialogs.dismiss();
      if (Palette.isOpen) return Palette.close();
      if (Shortcuts.isOpen) return Shortcuts.hide();
      if (!$('#modal-overlay')?.classList.contains('hidden')) return bridge?.closeModal();
      if ($('#game-flyout')?.classList.contains('flyout-open')) return bridge?.closeFlyout();
      bridge?.navigateTo('home');
    }

    function playFocused() {
      const bridge = app();
      if (!bridge) return;
      const panel = window.LibrarianDialogs.activePanel;
      if (Tour.isOpen || (panel && panel.id !== 'game-flyout')) return;
      const target = panel?.id === 'game-flyout'
        ? bridge.state.flyoutGame : gameForTile(document.activeElement?.closest?.('.game-tile'));
      if (target) { bridge.launchGame(target); Sound.play('launch'); }
    }

    function cyclePage(delta) {
      const bridge = app();
      if (!bridge || Tour.isOpen || window.LibrarianDialogs.activePanel) return;
      const pages = Object.values(PAGE_KEYS);
      const at = pages.indexOf(bridge.state.currentPage);
      const next = pages[(((at === -1 ? 0 : at) + delta) % pages.length + pages.length) % pages.length];
      bridge.navigateTo(next);
      Sound.play('move');
    }

    function start() {
      if (prefs().gamepad_nav === false || document.hidden || window.LibrarianBigPicture?.isOpen) { stop(); return; }
      if (running) return;
      if (!navigator.getGamepads?.().some(pad => pad)) return;
      running = true;
      if (!frame) frame = requestAnimationFrame(poll);
    }

    function stop() {
      running = false;
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      held.clear();
      if (root.dataset.nav === 'pad') setNavMode('pointer');
    }

    function init() {
      window.addEventListener('gamepadconnected', (e) => {
        if (prefs().gamepad_nav === false) return;
        app()?.toast(`${e.gamepad.id.split('(')[0].trim() || 'Controller'} connected`, 'success');
        start();
      });
      window.addEventListener('gamepaddisconnected', () => {
        const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
        if (!pads.length) stop();
      });
      // A pad already plugged in before launch raises no connect event.
      const existing = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
      if (existing.length) start();
      document.addEventListener('visibilitychange', sync);
      window.addEventListener('librarian:bigpicture', sync);
      window.addEventListener('librarian:ready', sync);
    }

    function sync() {
      if (prefs().gamepad_nav === false || document.hidden || window.LibrarianBigPicture?.isOpen) stop();
      else start();
    }
    return { init, start, stop, sync };
  })();

  // ════════════════════════════════════════════════════════════════
  // Download HUD — sidebar card, top-bar rail, taskbar progress.
  // ════════════════════════════════════════════════════════════════
  function setupDownloadHud() {
    const hud = $('#dl-hud');
    const rail = $('#topbar-progress');
    const fill = rail?.querySelector('i');

    if (hud) {
      const go = () => app()?.navigateTo('downloads');
      hud.onclick = go;
      hud.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    }

    window.addEventListener('librarian:download', (e) => {
      const d = e.detail || {};
      if (!d.active) {
        hud?.classList.add('hidden');
        rail?.classList.remove('on', 'indeterminate');
        return;
      }

      hud?.classList.remove('hidden');
      hud?.classList.toggle('paused', Boolean(d.paused));
      rail?.classList.add('on');

      const pct = Number(d.percent) || 0;
      // Before the first percentage arrives, show motion rather than a dead bar.
      rail?.classList.toggle('indeterminate', pct <= 0);
      if (fill) fill.style.width = `${pct}%`;

      setText('#dl-hud-name', d.name || '—');
      setText('#dl-hud-pct', `${pct.toFixed(pct % 1 ? 1 : 0)}%`);
      setText('#dl-hud-label', d.paused ? 'Paused' : 'Downloading');
      setText('#dl-hud-speed', d.speed && d.speed !== '—' ? d.speed : '—');
      setText('#dl-hud-eta', d.eta && d.eta !== '—' ? d.eta : '—');
      const bar = $('#dl-hud-fill');
      if (bar) bar.style.width = `${pct}%`;
    });
  }

  function setText(selector, value) {
    const el = $(selector);
    if (el && el.textContent !== value) el.textContent = value;
  }

  // ════════════════════════════════════════════════════════════════
  // Download focus view
  //
  // While something is downloading, the Downloads page stops being a form and
  // becomes one object: the game's poster, lit from behind by its own key art,
  // with the numbers beside it. The drop zone, queue table and log step aside
  // until the job finishes or is cancelled.
  // ════════════════════════════════════════════════════════════════
  const Focus = (() => {
    let currentKey = '';       // appid|name — identifies which game is on screen
    let elapsedTimer = null;
    let startedAt = 0;

    /**
     * Resolve the best available poster.
     *
     * Steam's 600×900 library art is the ideal, but plenty of titles have none
     * — regional bundles, shovelware, anything Valve never generated art for.
     * Try portrait, then the landscape header (framed against a blurred copy of
     * itself), and finally fall back to generated cover art so the slot is
     * never empty.
     */
    async function paintPoster(name, appid) {
      const host = $('#dl-poster-art');
      const bg = $('#dl-focus-bg');
      const bridge = app();
      if (!host || !bridge) return;

      const drawGenerated = () => {
        host.innerHTML = bridge.artFallbackHtml(name);
        if (bg) {
          // No art at all: light the room from the generated colourway instead.
          const plate = host.querySelector('.art-fallback');
          bg.style.backgroundImage = plate ? getComputedStyle(plate).backgroundImage : 'none';
        }
      };

      const drawPortrait = (url) => { host.innerHTML = `<img src="${bridge.esc(url)}" alt="">`; };
      // A landscape source in a 2:3 frame is letterboxed over a blurred copy of
      // itself rather than having its middle cropped out.
      const drawLandscape = (url) => {
        host.innerHTML = `
          <div class="poster-blur" style="background-image:url(${bridge.esc(url)})"></div>
          <img class="poster-fit" src="${bridge.esc(url)}" alt="">`;
      };

      if (!appid) { drawGenerated(); return; }

      // Try the cheap legacy URLs first; only ask the resolver if they 404.
      const legacyPortrait = bridge.steamPortraitUrl(appid);
      const legacyHeader = bridge.steamHeaderUrl(appid);

      try {
        await loadImage(legacyPortrait);
        drawPortrait(legacyPortrait);
      } catch {
        try {
          await loadImage(legacyHeader);
          drawLandscape(legacyHeader);
        } catch {
          const art = await bridge.resolveArtFor(appid).catch(() => null);
          const portrait = art?.portrait;
          const landscape = art?.header || art?.hero;
          if (portrait) drawPortrait(portrait);
          else if (landscape) drawLandscape(landscape);
          else drawGenerated();
        }
      }

      if (!bg) return;
      const legacyHero = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_hero.jpg`;
      try {
        await loadImage(legacyHero);
        bg.style.backgroundImage = `url(${legacyHero})`;
      } catch {
        const art = await bridge.resolveArtFor(appid).catch(() => null);
        const wide = art?.hero || art?.header;
        if (wide) bg.style.backgroundImage = `url(${wide})`;
      }
    }

    function loadImage(url) {
      return new Promise((resolve, reject) => {
        if (!url) { reject(new Error('no url')); return; }
        const img = new Image();
        img.onload = () => (img.naturalWidth > 1 ? resolve(img) : reject(new Error('empty')));
        img.onerror = () => reject(new Error('failed'));
        img.src = url;
      });
    }

    function tickElapsed() {
      const el = $('#fstat-elapsed');
      if (!el) return;
      const secs = Math.max(0, Math.floor((Date.now() - (startedAt || Date.now())) / 1000));
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      el.textContent = h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
    }

    function show(d) {
      const page = $('#page-downloads');
      const panel = $('#dl-focus');
      const bridge = app();
      if (!page || !panel || !bridge) return;

      panel.classList.remove('hidden');
      page.classList.add('focus-mode');
      panel.classList.toggle('paused', Boolean(d.paused));

      // Only repaint the artwork when the game actually changes — otherwise the
      // poster would flicker on every progress tick.
      const key = `${d.appid || ''}|${d.name || ''}`;
      if (key !== currentKey) {
        currentKey = key;
        paintPoster(d.name, d.appid);
        startedAt = d.startedAt || Date.now();
        clearInterval(elapsedTimer);
        elapsedTimer = setInterval(tickElapsed, 1000);
        Sound.play('open');
        // The chart canvas was display:none until now, so it has no measurable
        // box yet; redraw once the browser has laid the panel out.
        requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('librarian:redraw')));
      }

      const verb = d.jobType === 'update' ? 'Updating'
        : d.jobType === 'repair' ? 'Verifying'
          : d.jobType === 'csrin'
            ? (d.csrinPhase === 'extract' ? 'Placing into the game' : 'Fetching from CS.RIN.RU')
            : 'Downloading';
      setText('#dl-focus-kicker-text', d.paused ? 'Paused' : verb);
      setText('#dl-focus-title', d.name || 'Unknown');

      const pct = Number(d.percent) || 0;
      setText('#dl-focus-pct-num', pct.toFixed(pct > 0 && pct % 1 ? 1 : 0));
      const fill = $('#dl-focus-fill');
      if (fill) fill.style.width = `${pct}%`;
      const posterFill = $('#dl-poster-fill');
      if (posterFill) posterFill.style.height = `${pct}%`;

      setText('#fstat-size', d.sizeText && d.sizeText !== '—' ? d.sizeText : '—');
      setText('#fstat-speed', d.paused ? 'Paused' : (d.speed && d.speed !== '—' ? d.speed : '—'));

      // Always shown, on every job type. These are genuinely two different
      // numbers even on a plain download — chunks arrive compressed, so more
      // lands on disk than crosses the wire — and on an update the gap is the
      // whole point. Hiding it "when redundant" only made it unfindable.
      const showDisk = !!d.diskSpeed && d.diskSpeed !== '—';
      $('#fstat-disk-wrap')?.classList.toggle('hidden', !showDisk);
      if (showDisk) setText('#fstat-disk', d.paused ? 'Paused' : d.diskSpeed);
      setText('#fstat-eta', d.eta && d.eta !== '—' ? d.eta.replace(/\s*left$/, '') : '—');
      tickElapsed();

      const destWrap = $('#dl-focus-dest');
      if (destWrap) {
        if (d.dest) {
          // A forum release is placed into an installed game's folder, or —
          // from the store page — only saved as an archive.
          const lead = d.jobType === 'csrin' ? (d.csrinExtract ? 'Into the game at' : 'Saving to') : 'Installing to';
          destWrap.innerHTML = `${lead} <button type="button">${bridge.esc(d.dest)}</button>`;
          destWrap.querySelector('button').onclick = () => bridge.openPath(d.dest);
        } else {
          destWrap.textContent = '';
        }
      }

      const pauseBtn = $('#dl-focus-pause');
      if (pauseBtn) {
        pauseBtn.innerHTML = d.paused ? '▶ Resume' : '⏸ Pause';
        // A hoster transfer cannot be paused; offering it would only toast.
        pauseBtn.classList.toggle('hidden', d.jobType === 'csrin');
      }

      renderUpNext(d.upNext || []);
    }

    function renderUpNext(list) {
      const wrap = $('#dl-focus-queue');
      const host = $('#dl-focus-queue-list');
      const bridge = app();
      if (!wrap || !host || !bridge) return;
      if (!list.length) { wrap.classList.add('hidden'); host.innerHTML = ''; return; }
      wrap.classList.remove('hidden');
      host.innerHTML = list.slice(0, 6).map((job) => {
        const art = job.appid ? bridge.steamHeaderUrl(job.appid) : '';
        return `<span class="fq-item">${art
          ? `<img src="${bridge.esc(art)}" alt="" data-hide-on-error="">` : ''}${bridge.esc(job.name)}</span>`;
      }).join('');
    }

    function hide() {
      const page = $('#page-downloads');
      const panel = $('#dl-focus');
      currentKey = '';
      clearInterval(elapsedTimer);
      elapsedTimer = null;
      if (page) page.classList.remove('focus-mode', 'show-log');
      if (panel) { panel.classList.add('hidden'); panel.classList.remove('paused'); }
      const logBtn = $('#dl-focus-logbtn');
      if (logBtn) logBtn.textContent = 'Show log';
    }

    function init() {
      const pause = $('#dl-focus-pause');
      const cancel = $('#dl-focus-cancel');
      const logBtn = $('#dl-focus-logbtn');

      // Reuse the existing controls so there is exactly one implementation of
      // pause/cancel, including its platform guards and cleanup.
      if (pause) pause.onclick = () => $('#btn-pause')?.click();
      if (cancel) cancel.onclick = async () => {
        const bridge = app();
        const ok = !bridge || await bridge.showConfirm(
          'Cancel download',
          'Stop this download? Progress is kept, so starting it again resumes from where it left off.',
          { confirmLabel: 'Cancel download', cancelLabel: 'Keep downloading' }
        );
        if (ok) $('#btn-cancel')?.click();
      };
      if (logBtn) logBtn.onclick = () => {
        const page = $('#page-downloads');
        const on = page.classList.toggle('show-log');
        logBtn.textContent = on ? 'Hide log' : 'Show log';
        if (on) $('#log-output')?.scrollTo({ top: $('#log-output').scrollHeight });
      };

      window.addEventListener('librarian:download', (e) => {
        const d = e.detail || {};
        if (d.active) show(d); else hide();
      });
    }

    return { init, hide };
  })();

  // ════════════════════════════════════════════════════════════════
  // Celebration on a finished download.
  // ════════════════════════════════════════════════════════════════
  function celebrate() {
    if (reduceMotion()) return;
    const canvas = $('#confetti');
    if (!canvas) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.classList.remove('hidden');

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const styles = getComputedStyle(root);
    const palette = [
      styles.getPropertyValue('--primary').trim() || '#D2A65C',
      styles.getPropertyValue('--brass-2').trim() || '#EBCB86',
      styles.getPropertyValue('--patina').trim() || '#74BBAB',
      '#ECE7DD',
    ];

    const W = window.innerWidth;
    const H = window.innerHeight;
    const pieces = Array.from({ length: 110 }, () => ({
      x: W * (0.15 + Math.random() * 0.7),
      y: H + Math.random() * 40,
      vx: (Math.random() - 0.5) * 7,
      vy: -(10 + Math.random() * 11),
      size: 4 + Math.random() * 6,
      spin: (Math.random() - 0.5) * 0.34,
      angle: Math.random() * Math.PI,
      colour: palette[(Math.random() * palette.length) | 0],
    }));

    const started = performance.now();
    (function tick(now) {
      const elapsed = now - started;
      ctx.clearRect(0, 0, W, H);

      for (const p of pieces) {
        p.vy += 0.34;          // gravity
        p.vx *= 0.995;         // drag
        p.x += p.vx;
        p.y += p.vy;
        p.angle += p.spin;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.globalAlpha = clamp(1 - elapsed / 2400, 0, 1);
        ctx.fillStyle = p.colour;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.62);
        ctx.restore();
      }

      if (elapsed < 2400) requestAnimationFrame(tick);
      else { ctx.clearRect(0, 0, W, H); canvas.classList.add('hidden'); }
    })(started);
  }

  // ════════════════════════════════════════════════════════════════
  // Library layout controls
  // ════════════════════════════════════════════════════════════════
  function setLibraryLayout(view) {
    root.dataset.libview = view;
    $$('#lib-view-seg button').forEach(b => {
      b.classList.toggle('active', b.dataset.view === view);
      b.setAttribute('aria-pressed', String(b.dataset.view === view));
    });
    window.api?.setSetting('library_view_mode', view).catch(() => {});
    app()?.refreshSettings();
    Sound.play('move');
  }

  function setDensity(density) {
    root.dataset.density = density;
    $$('#lib-density-seg button').forEach(b => {
      b.classList.toggle('active', b.dataset.density === density);
      b.setAttribute('aria-pressed', String(b.dataset.density === density));
    });
    window.api?.setSetting('grid_density', density).catch(() => {});
    app()?.refreshSettings();
    Sound.play('move');
  }

  function setupLibraryControls() {
    $$('#lib-view-seg button').forEach((btn) => {
      btn.onclick = () => setLibraryLayout(btn.dataset.view);
      btn.classList.toggle('active', btn.dataset.view === root.dataset.libview);
      btn.setAttribute('aria-pressed', String(btn.dataset.view === root.dataset.libview));
    });
    $$('#lib-density-seg button').forEach((btn) => {
      btn.onclick = () => setDensity(btn.dataset.density);
      btn.classList.toggle('active', btn.dataset.density === root.dataset.density);
      btn.setAttribute('aria-pressed', String(btn.dataset.density === root.dataset.density));
    });
  }

  // ════════════════════════════════════════════════════════════════
  // Collections rail
  // ════════════════════════════════════════════════════════════════
  function renderCollections() {
    const bridge = app();
    const host = $('#sidebar-collections');
    if (!bridge || !host) return;

    const collections = bridge.getCollections();
    const names = Object.keys(collections).sort((a, b) => a.localeCompare(b));

    if (!names.length) {
      host.innerHTML = '<div class="collection-empty">Right-click any game to file it into a collection.</div>';
      return;
    }

    host.innerHTML = names.map(name => `
      <button class="sidebar-link collection-link" data-collection="${bridge.esc(name)}">
        <span class="coll-dot"></span>
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${bridge.esc(name)}</span>
        <span class="side-count">${(collections[name] || []).length}</span>
      </button>`).join('');

    $$('.collection-link', host).forEach((btn) => {
      btn.onclick = () => {
        bridge.setLibraryView('collection', btn.dataset.collection);
        $$('.sidebar-link').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        Sound.play('move');
      };
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        bridge.deleteCollection(btn.dataset.collection);
      });
    });
  }

  function setupCollections() {
    const btn = $('#sidebar-new-collection');
    if (btn) btn.onclick = () => promptNewCollection();
    window.addEventListener('librarian:collections', renderCollections);
    window.addEventListener('librarian:ready', renderCollections);
  }

  // ════════════════════════════════════════════════════════════════
  // Sidebar counters
  // ════════════════════════════════════════════════════════════════
  function refreshSidebarCounts() {
    const bridge = app();
    if (!bridge) return;
    const games = bridge.games || [];

    const set = (selector, value) => {
      const link = $(selector);
      if (!link) return;
      let badge = link.querySelector('.side-count');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'side-count';
        link.appendChild(badge);
      }
      badge.textContent = String(value);
    };

    set('#sidebar-all-games', games.length);
    set('#sidebar-favorites', games.filter(g => bridge.isFavorite(g)).length);
    set('#sidebar-recent', games.filter(g => (g.last_played || 0) > 0).length);

    // Nudge the ledger numbers so a changed total is noticed.
    $$('.ledger-num').forEach((el) => {
      if (el.dataset.prev !== el.textContent) {
        el.dataset.prev = el.textContent;
        el.classList.remove('bump');
        void el.offsetWidth;
        el.classList.add('bump');
      }
    });
  }

  // ════════════════════════════════════════════════════════════════
  // Settings section navigation
  // ════════════════════════════════════════════════════════════════
  function setupSettingsNav() {
    const nav = $('#settings-nav');
    if (!nav) return;
    const sections = $$('#page-settings .settings-section[data-sec]');
    if (!sections.length) return;

    nav.innerHTML = sections.map((section, i) =>
      `<button data-index="${i}" class="${i === 0 ? 'active' : ''}">${section.dataset.sec}</button>`
    ).join('');

    $$('button', nav).forEach((btn) => {
      btn.onclick = () => {
        const target = sections[Number(btn.dataset.index)];
        if (!target) return;
        $$('button', nav).forEach(b => b.classList.toggle('active', b === btn));
        target.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
        target.classList.add('flash-target');
        setTimeout(() => target.classList.remove('flash-target'), 1200);
        Sound.play('move');
      };
    });
  }

  // ════════════════════════════════════════════════════════════════
  // Button feedback: ripple from the click point, busy state on async work.
  // ════════════════════════════════════════════════════════════════
  function setupButtonFeedback() {
    document.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest?.('.xbox-btn');
      if (!btn || btn.disabled || reduceMotion()) return;
      const rect = btn.getBoundingClientRect();
      btn.style.setProperty('--rx-x', `${e.clientX - rect.left}px`);
      btn.style.setProperty('--rx-y', `${e.clientY - rect.top}px`);
      btn.classList.remove('rippling');
      void btn.offsetWidth;
      btn.classList.add('rippling');
      setTimeout(() => btn.classList.remove('rippling'), 600);
    }, { passive: true });

    document.addEventListener('click', (e) => {
      if (e.target.closest?.('.tile-play-btn')) Sound.play('launch');
      else if (e.target.closest?.('.game-tile, .result-card')) Sound.play('select');
      else if (e.target.closest?.('.xbox-btn, .nav-tab, .sidebar-link, .icon-btn')) Sound.play('move');
    }, true);
  }

  // ════════════════════════════════════════════════════════════════
  // Window chrome: keep the maximize glyph honest.
  // ════════════════════════════════════════════════════════════════
  function setupWindowChrome() {
    const btn = $('#btn-maximize');
    if (!btn || !window.api?.onWindowState) return;

    const RESTORE = '<svg viewBox="0 0 12 12"><rect x="2" y="3.5" width="6" height="6" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M4 3.5V2h6v6H8.5" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>';
    const MAXIMIZE = '<svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>';

    const paint = (maximized) => {
      btn.innerHTML = maximized ? RESTORE : MAXIMIZE;
      btn.title = maximized ? 'Restore' : 'Maximize';
      root.classList.toggle('is-maximized', Boolean(maximized));
    };

    window.api.onWindowState((state) => paint(state?.maximized));
    window.api.isMaximized?.().then(paint).catch(() => {});

    // Double-clicking the drag strip should maximize, as in every other app.
    $('#topbar-drag')?.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, input, .nav-tab, #topbar-search')) return;
      window.api.maximize();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'F11') { e.preventDefault(); window.api.maximize(); }
    });
  }

  // ════════════════════════════════════════════════════════════════
  // Detail-view tint
  //
  // The panel takes its glow, button and accent colours from the cover art of
  // whichever game is open, so each game's page feels like that game rather
  // than a generic template.
  // ════════════════════════════════════════════════════════════════
  function setupFlyoutTint() {
    const panel = $('#game-flyout');
    if (!panel) return;

    window.addEventListener('librarian:flyout', async (e) => {
      const { open, game } = e.detail || {};
      // Deliberately NOT clearing the tint on close. The poster's glow,
      // border and plinth are all color-mix(--game-tint …), so dropping it
      // back to the theme accent recolours the whole card in one frame
      // while the panel is still fading out — which is the flash. The next
      // open resets it anyway, so there is nothing to clean up here.
      if (!open || !game) return;

      const bridge = app();
      if (!bridge) return;
      // Start from the theme accent so the panel is never briefly untinted.
      panel.style.removeProperty('--game-tint');

      const appId = String(game.appid || '').trim();
      const candidates = [
        appId && appId !== '0' ? bridge.steamPortraitUrl(appId) : '',
        bridge.getGameBannerUrl(game, 'header'),
      ].filter(Boolean);

      for (const url of candidates) {
        const colour = await Accent.sample(url).catch(() => null);
        // Bail if the user moved on to another game while we were sampling.
        if (bridge.state.flyoutGame !== game) return;
        if (colour) { panel.style.setProperty('--game-tint', colour); return; }
      }
    });
  }

  // ════════════════════════════════════════════════════════════════
  // First-run setup banner on Home
  //
  // Goldberg is fetched in the background on first launch. Without a visible
  // signal that looks like nothing is happening, so surface it on Home and
  // keep it there until the install finishes one way or the other.
  // ════════════════════════════════════════════════════════════════
  function setupSetupBanner() {
    const panel = $('#home-setup');
    if (!panel) return;

    const title = $('#home-setup-title');
    const sub = $('#home-setup-sub');
    const spin = $('#home-setup-spin');
    const action = $('#home-setup-action');
    let installing = false;
    let hideTimer = null;

    const show = () => {
      clearTimeout(hideTimer);
      panel.classList.remove('hidden', 'leaving', 'done', 'failed');
      action.classList.add('hidden');
      spin.textContent = '';
    };

    const dismiss = (delay) => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        panel.classList.add('leaving');
        setTimeout(() => panel.classList.add('hidden'), 340);
      }, delay);
    };

    window.addEventListener('librarian:setup', (e) => {
      const d = e.detail || {};

      if (d.phase === 'start') {
        installing = true;
        show();
        title.textContent = 'Setting up the Goldberg emulator';
        sub.textContent = 'Downloading — this only happens once.';
        return;
      }

      // Mirror the installer's own log lines so progress is legible. Strip the
      // leading emoji and the log level, but keep bracketed component names —
      // a blanket "leading non-word" strip ate the "[" of "[INF]".
      if (d.phase === 'log' && installing) {
        const line = String(d.message || '')
          .replace(/^[^\p{L}\p{N}[(]+/u, '')
          .replace(/^\[(INF|WRN|ERR|DBG|INFO|WARN|ERROR)\]\s*/i, '')
          .trim();
        if (line) sub.textContent = line.slice(0, 140);
        return;
      }

      if (d.phase === 'done') {
        if (!installing) return;
        installing = false;
        panel.classList.remove('hidden', 'failed');
        panel.classList.add('done');
        spin.textContent = '✓';
        title.textContent = 'Goldberg emulator ready';
        sub.textContent = 'Cracking and auto-crack-after-download are available.';
        Sound.play('success');
        dismiss(5000);
        return;
      }

      if (d.phase === 'failed') {
        installing = false;
        panel.classList.remove('hidden', 'done');
        panel.classList.add('failed');
        spin.textContent = '!';
        title.textContent = 'Goldberg could not be installed';
        sub.textContent = d.error || 'Check your connection and try again.';
        action.classList.remove('hidden');
      }
    });

    action.onclick = async () => {
      action.classList.add('hidden');
      installing = true;
      show();
      title.textContent = 'Setting up the Goldberg emulator';
      sub.textContent = 'Retrying…';
      try {
        const res = await window.api.crackDownloadGoldberg();
        window.dispatchEvent(new CustomEvent('librarian:setup', {
          detail: res?.success ? { phase: 'done' } : { phase: 'failed', error: 'The download did not complete.' },
        }));
      } catch (err) {
        window.dispatchEvent(new CustomEvent('librarian:setup', { detail: { phase: 'failed', error: err.message } }));
      }
    };

    // Bridge the main process's crack channels into the banner.
    window.api?.onCrackStatus?.((status) => {
      if (status?.installing) window.dispatchEvent(new CustomEvent('librarian:setup', { detail: { phase: 'start' } }));
    });
    window.api?.onCrackLog?.((message) => {
      if (installing) window.dispatchEvent(new CustomEvent('librarian:setup', { detail: { phase: 'log', message } }));
    });
    window.api?.onCrackBootstrap?.((result) => {
      window.dispatchEvent(new CustomEvent('librarian:setup', {
        detail: result?.success ? { phase: 'done' } : { phase: 'failed', error: result?.error },
      }));
    });
  }

  // ════════════════════════════════════════════════════════════════
  // Guided tour
  //
  // A spotlight walk over the real interface. Each step can switch page and
  // scroll a control into view before explaining it, so every setting is
  // described next to the thing it actually controls.
  // ════════════════════════════════════════════════════════════════
  const Tour = (() => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // Deliberately a timer, not requestAnimationFrame: a hidden or occluded
    // renderer stops delivering frames entirely, so an rAF await here would
    // never resolve and the card would never get positioned. Timers keep running.
    const settle = () => sleep(0);

    const STEPS = [
      {
        chapter: 'Welcome',
        title: 'Let me show you around',
        body: `<p>Two minutes, twenty-five stops. We'll cover every setting, what a
          <b>manifest</b> is, and how the <b>Goldberg</b> emulator fits in.</p>
          <p>Use <code>→</code> and <code>←</code>, or the buttons. <code>Esc</code> leaves at any point —
          you can pick it back up from Settings.</p>`,
      },

      // ── Getting around ──
      {
        chapter: 'Getting around', page: 'home', target: '#topbar-nav',
        title: 'Six places',
        body: `<ul>
            <li><b>Home</b> — your shelf: what you're playing, what's new, what needs updating.</li>
            <li><b>Library</b> — everything you own.</li>
            <li><b>Store</b> — find games you don't have yet.</li>
            <li><b>Downloads</b> — what's arriving right now.</li>
            <li><b>Crack</b> — apply the Goldberg emulator to a game.</li>
            <li><b>Settings</b> — everything else.</li>
          </ul>
          <p>Press <code>1</code>–<code>6</code> to jump straight to any of them.</p>`,
      },
      {
        chapter: 'Getting around', page: 'home', target: '#topbar-search',
        title: 'One shortcut worth learning',
        body: `<p><code>Ctrl</code>+<code>K</code> opens the command palette from anywhere.</p>
          <p>Start typing a game to open it, or <code>Shift</code>+<code>Enter</code> to launch it
          immediately. Type <code>&gt;</code> first to run a command instead — scan, check updates,
          toggle sounds, jump to a collection.</p>
          <p>It matches loosely, so <code>hlfx</code> finds <i>Half-Life: Alyx</i>.</p>`,
      },
      {
        chapter: 'Getting around', page: 'home', target: '#sidebar-all-games',
        title: 'The catalog rail',
        body: `<p><b>All Games</b> is everything. <b>Favorites</b> collects anything you've starred —
          hover a tile and click the ☆. <b>Recently Played</b> sorts by last launch, and <b>Queue</b>
          jumps to whatever is downloading.</p>`,
      },
      {
        chapter: 'Getting around', page: 'home', target: '#sidebar-new-collection',
        title: 'Collections are your own shelves',
        body: `<p>Make one for anything — <i>Couch co-op</i>, <i>Finish these</i>, <i>Install on the laptop</i>.</p>
          <p>Right-click any game and choose <b>Add to collection</b>. Right-click a collection in this
          rail to delete it; the games themselves are never touched.</p>`,
      },
      {
        chapter: 'Getting around', page: 'home', target: '#sidebar-ledger',
        title: 'The ledger',
        body: `<p>How many games are shelved, how long you've played across all of them, and how much
          disk they occupy. Playtime is recorded by Librarian itself whenever you launch a game
          directly, so it works for games Steam never sees.</p>`,
      },

      // ── Library ──
      {
        chapter: 'Your library', page: 'library', target: '#lib-toolbar-extra',
        title: 'Grid or list, three sizes',
        body: `<p>The first pair switches between cover grid and a compact list. The second sets tile
          size — small, medium, large.</p>
          <p>Both stick between sessions. <code>V</code> flips grid/list without reaching for the mouse.</p>`,
      },
      {
        chapter: 'Your library', page: 'library', target: '#lib-scan-btn',
        title: 'Filling the shelves',
        body: `<ul>
            <li><b>Scan</b> reads your Steam libraries and picks up everything already installed.</li>
            <li><b>Add Game</b> registers a folder Steam knows nothing about — a DRM-free build, an
              old install, anything with an executable. It can auto-detect the AppID.</li>
            <li><b>Check Updates</b> compares each installed build against the current public build
              on Steam and badges anything behind.</li>
          </ul>`,
      },

      // ── Manifests ──
      {
        chapter: 'Finding games', page: 'store', target: '#search-input',
        title: 'What a manifest actually is',
        body: `<p>Librarian doesn't pull games out of the Steam client. It fetches a <b>manifest</b>:
          a small file listing every <b>depot</b> a game is split into, which files live in each, and
          the keys needed to decrypt them.</p>
          <p>Search here, pick a game, and Librarian fetches its manifest, asks which depots you want
          (language packs and platform builds are usually separate), then streams those chunks
          straight from Valve's content servers.</p>`,
      },
      {
        chapter: 'Finding games', page: 'settings', target: '#inp-api-key',
        title: 'The key that makes manifests work',
        body: `<p>Manifests come from <b>Hubcap</b>, which needs a free API key, or from
          <b>steammanifest</b>, which uses public metadata and configured endpoints without a Steam session.
          With a key, Auto uses Hubcap and checks its packages against the public metadata endpoint.
          Missing or outdated packages are assembled using your relay endpoints and XYZ or saved depot keys.</p>
          <p>The <b>Where do I get a key?</b> link under the field opens the page that issues one.
          Paste it here and it's saved immediately.</p>`,
      },

      // ── Downloading ──
      {
        chapter: 'Downloading', page: 'settings', target: '#install-locations',
        title: 'Where games land',
        body: `<p>Steam libraries are detected automatically. <b>Add folder</b> registers any other
          drive or directory, and <b>Rescan drives</b> refreshes the list.</p>
          <p>Click a row to make it the default. Each row shows free space against total, so you can
          tell at a glance whether a 90 GB game is going to fit.</p>`,
      },
      {
        chapter: 'Downloading', page: 'settings', target: '#chk-ask-destination',
        title: 'Ask, or just go',
        body: `<p><b>On</b> — every download opens a picker showing each folder's free space next to
          the game's size, and warns before you start something that won't fit.</p>
          <p><b>Off</b> — downloads go straight to the default folder without interrupting you.</p>
          <p>You can also override the destination per job from its card in the queue.</p>`,
      },
      {
        chapter: 'Downloading', page: 'downloads', target: '#drop-zone',
        title: 'Already have a manifest?',
        body: `<p>Drop a manifest <code>.zip</code> here, or click to browse. It's the same path as
          searching the Store — Librarian reads the depots and starts the download.</p>
          <p>Once something is running, this page turns into a single focused view: the game's poster,
          its progress, speed, time remaining and install path. Everything else gets out of the way
          until it finishes or you cancel.</p>`,
      },

      // ── Download options ──
      {
        chapter: 'Download options', page: 'settings', target: '#sel-max-downloads',
        title: 'How hard to pull',
        body: `<p>How many chunks are fetched at once. <b>8</b> is safe on any connection,
          <b>16</b> is a good default on fibre.</p>
          <p>Higher isn't always faster — past a point you're just queueing requests, and some
          networks throttle a burst of parallel connections.</p>`,
      },
      {
        chapter: 'Download options', page: 'settings', target: '#chk-adaptive',
        title: 'Let it find the right number',
        body: `<p>The right number of connections depends on your line, not on a dropdown.
          With this on, the setting above becomes a <i>starting point</i>: Librarian measures
          throughput and opens more connections while that keeps making the download faster,
          stopping as soon as it doesn't.</p>
          <p>It only ever adds, so it can never end up slower than what you chose.</p>`,
      },
      {
        chapter: 'Download options', page: 'settings', target: '#chk-validate-fresh',
        title: 'Verification and caching',
        body: `<ul>
            <li><b>Validate new downloads</b> — hashes every chunk against the manifest as it lands.
              Slower, but catches a bad disk or a corrupt transfer immediately. Updates and repairs
              always validate regardless.</li>
            <li><b>Use Lancache</b> — route through a local caching proxy. Only useful if you actually
              run one on your network.</li>
            <li><b>Cell ID</b> — pins downloads to a specific Steam region. Leave blank unless you
              have a reason; Librarian picks the nearest servers itself.</li>
          </ul>`,
      },
      {
        chapter: 'Download options', page: 'settings', target: '#chk-sls',
        title: 'Running through the Steam client',
        body: `<ul>
            <li><b>SLSsteam / GreenLuma wrapper mode</b> — writes the depot keys into Steam's own
              config and generates the AppList files those tools read, so the Steam client itself will
              launch the game.</li>
            <li><b>Limit Downloads to Steam Libraries</b> — restricts the destination picker to folders
              Steam already manages, so a download always lands somewhere Steam will recognise.</li>
          </ul>`,
      },
      {
        chapter: 'Download options', page: 'settings', target: '#chk-auto-crack',
        title: 'What happens after the bytes land',
        body: `<ul>
            <li><b>Generate Steam Achievements</b> — builds the achievement and stats data that
              Goldberg needs to show progress offline.</li>
            <li><b>Remove Steam DRM with Steamless</b> — strips Valve's DRM wrapper from the
              executable so it will start without the Steam client attached.</li>
            <li><b>Auto-Crack after Download</b> — runs the whole Goldberg pass automatically the
              moment a download finishes, so the game is playable without a second step.</li>
          </ul>`,
      },
      {
        chapter: 'Download options', page: 'settings', target: '#inp-steam-username',
        title: 'Steam login (optional)',
        body: `<p>Leave both fields blank and Librarian downloads anonymously, which covers the large
          majority of depots.</p>
          <p>A login is only needed for depots that refuse anonymous access. Credentials are stored
          locally on this machine and used solely by the download engine. If Steam asks for a Guard
          code, a prompt appears mid-download.</p>`,
      },

      // ── Goldberg ──
      {
        chapter: 'Cracking', page: 'crack', target: '#crack-goldberg-status',
        title: 'What Goldberg is',
        body: `<p>Goldberg is a <b>Steam emulator</b>. It replaces <code>steam_api.dll</code> with a
          stand-in that answers the calls a game makes — your name, your friends, achievements, DLC
          ownership — without the Steam client running.</p>
          <p>These chips show whether the tooling is present. If Goldberg is missing, the button next
          to it downloads it.</p>`,
      },
      {
        chapter: 'Cracking', page: 'crack', target: '#crack-browse',
        title: 'Point it at a game',
        body: `<p>Choose the game's install folder. Librarian scans it for every
          <code>steam_api.dll</code> and executable, then fills in the <b>AppID</b> and <b>name</b> for
          you where it can — both matter, because Goldberg uses them to pick the right configuration.</p>
          <p>The scan results below list exactly what it found and where.</p>`,
      },
      {
        chapter: 'Cracking', page: 'crack', target: '#crack-apply',
        title: 'Apply, and undo',
        body: `<p><b>Apply Crack</b> backs up the original files first, then swaps in the emulator and
          writes its configuration, DLC unlocks and achievement data.</p>
          <p><b>Restore Originals</b> puts the untouched files back. The log underneath records every
          step, so if something fails you can see precisely where.</p>`,
      },

      // ── Personalisation ──
      {
        chapter: 'Making it yours', page: 'settings', target: '#chk-dynamic-accent',
        title: 'How it looks and feels',
        body: `<ul>
            <li><b>Accent</b> — pick a colour, or let it follow whichever game is featured on Home.</li>
            <li><b>Tilt</b> and <b>rotate the featured game</b> — the small motion touches.</li>
            <li><b>Gamepad</b> — drive the whole launcher from a controller: stick to move, A opens,
              B goes back, X plays, Y opens the palette.</li>
            <li><b>Interface sounds</b> — off by default, with a volume slider.</li>
            <li><b>Reduce motion</b> — stops every animation if you'd rather it sat still.</li>
          </ul>`,
      },
      {
        chapter: 'Making it yours', page: 'settings', target: '#btn-replay-tour',
        title: 'Where to find help later',
        body: `<p>This button replays the tour whenever you want it.</p>
          <p>Next to it, <b>Keyboard Shortcuts</b> opens the full reference — or press <code>?</code>
          from anywhere.</p>`,
      },
      {
        chapter: 'Done', page: 'home',
        title: "That's everything",
        body: `<p>Scan your drives, paste a Hubcap key if you have one, and you're set.</p>
          <p>If you only remember one thing: <code>Ctrl</code>+<code>K</code>.</p>`,
      },
    ];

    let index = 0;
    let active = false;

    const el = () => $('#tour');
    const card = () => $('#tour-card');
    const mask = () => $('#tour-mask');

    /**
     * Resolve a step's target to something that actually has a box.
     * Toggle inputs are visually hidden (the slider is a sibling), so a raw
     * checkbox measures 0×0 — spotlight its whole row instead.
     */
    function resolveTarget(selector) {
      if (!selector) return null;
      const node = $(selector);
      if (!node) return null;
      if (node.matches('input[type="checkbox"], input[type="radio"]')) {
        return node.closest('.toggle-row') || node.parentElement;
      }
      const rect = node.getBoundingClientRect();
      if (rect.width < 2 && rect.height < 2) {
        return node.closest('.toggle-row, .form-group, .settings-section') || node;
      }
      return node;
    }

    function buildDots() {
      const host = $('#tour-dots');
      if (!host) return;
      host.innerHTML = STEPS.map(() => '<i></i>').join('');
    }

    function paintDots() {
      $$('#tour-dots i').forEach((dot, i) => {
        dot.classList.toggle('now', i === index);
        dot.classList.toggle('done', i < index);
      });
    }

    /** Put the card where it does not cover the thing it is describing. */
    function placeCard(rect) {
      const node = card();
      if (!node) return;
      const box = node.getBoundingClientRect();
      const GAP = 18;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      if (!rect) {
        node.style.left = `${Math.round((vw - box.width) / 2)}px`;
        node.style.top = `${Math.round((vh - box.height) / 2)}px`;
        return;
      }

      let top;
      if (rect.bottom + GAP + box.height <= vh - 12) top = rect.bottom + GAP;
      else if (rect.top - GAP - box.height >= 12) top = rect.top - GAP - box.height;
      else top = Math.max(12, Math.min(vh - box.height - 12, rect.top));

      // Centre on the target horizontally, then keep it fully on screen.
      let left = rect.left + rect.width / 2 - box.width / 2;
      // If the card would sit on top of the target, push it to whichever side has room.
      const overlaps = top < rect.bottom && top + box.height > rect.top;
      if (overlaps) {
        left = (rect.right + GAP + box.width <= vw - 12)
          ? rect.right + GAP
          : rect.left - GAP - box.width;
      }
      left = Math.max(12, Math.min(vw - box.width - 12, left));

      node.style.left = `${Math.round(left)}px`;
      node.style.top = `${Math.round(top)}px`;
    }

    function spotlight(target) {
      const m = mask();
      if (!m) return null;
      if (!target) {
        m.classList.remove('lit');
        m.style.width = '0px';
        m.style.height = '0px';
        m.style.left = '50%';
        m.style.top = '50%';
        return null;
      }
      const rect = target.getBoundingClientRect();
      const pad = 8;
      const lit = {
        left: rect.left - pad,
        top: rect.top - pad,
        right: rect.right + pad,
        bottom: rect.bottom + pad,
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
      };
      m.classList.add('lit');
      m.style.left = `${Math.round(lit.left)}px`;
      m.style.top = `${Math.round(lit.top)}px`;
      m.style.width = `${Math.round(lit.width)}px`;
      m.style.height = `${Math.round(lit.height)}px`;
      return lit;
    }

    async function render() {
      const step = STEPS[index];
      const bridge = app();
      if (!step || !bridge) return;

      setText('#tour-chapter', step.chapter);
      setText('#tour-count', `${index + 1} / ${STEPS.length}`);
      setText('#tour-title', step.title);
      const body = $('#tour-body');
      if (body) body.innerHTML = step.body;

      const back = $('#tour-back');
      const next = $('#tour-next');
      if (back) back.disabled = index === 0;
      if (next) next.textContent = index === STEPS.length - 1 ? 'Finish' : 'Next';
      paintDots();

      card()?.classList.remove('jump');
      void card()?.offsetWidth;
      card()?.classList.add('jump');

      // Move to the right page, then bring the control into view before lighting it.
      if (step.page && bridge.state.currentPage !== step.page) {
        bridge.navigateTo(step.page);
        await sleep(reduceMotion() ? 40 : 320);
      }

      const target = resolveTarget(step.target);
      if (target) {
        target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
        await sleep(reduceMotion() ? 30 : 330);
      }

      await settle();
      reposition();
    }

    /** Re-measure the current step's target and move the spotlight and card to it. */
    function reposition() {
      if (!active) return;
      placeCard(spotlight(resolveTarget(STEPS[index]?.target)));
    }

    async function go(next) {
      if (next < 0 || next >= STEPS.length) { finish(); return; }
      index = next;
      Sound.play('move');
      await render();
    }

    async function start(from = 0) {
      const node = el();
      const bridge = app();
      if (!node || !bridge || active) return;
      active = true;
      index = Math.max(0, Math.min(STEPS.length - 1, from));
      buildDots();
      node.classList.remove('hidden', 'closing');
      Sound.play('open');
      await render();
    }

    function finish() {
      const node = el();
      if (!node || !active) return;
      active = false;
      node.classList.add('closing');
      setTimeout(() => { node.classList.add('hidden'); node.classList.remove('closing'); }, 220);
      Sound.play('select');
      window.api?.setSetting('onboarded', true).catch(() => {});
      app()?.refreshSettings();
      app()?.navigateTo('home');
    }

    function init() {
      const node = el();
      if (!node) return;

      $('#tour-next').onclick = () => go(index + 1);
      $('#tour-back').onclick = () => go(index - 1);
      $('#tour-skip').onclick = () => finish();

      // Clicking the dimmed area advances, like a slideshow.
      node.addEventListener('click', (e) => {
        if (e.target === node || e.target === mask()) go(index + 1);
      });

      document.addEventListener('keydown', (e) => {
        if (!active) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(); }
        else if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopImmediatePropagation(); go(index + 1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); go(index - 1); }
      }, true);

      // Keep the spotlight glued to its target when the window changes shape.
      let resizeTimer = null;
      window.addEventListener('resize', () => {
        if (!active) return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(reposition, 140);
      });

      // Coming back from another window: re-measure, since layout may have moved
      // while nothing was being painted.
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) setTimeout(reposition, 60);
      });

      const replay = $('#btn-replay-tour');
      if (replay) replay.onclick = () => start(0);
    }

    return { init, start, get isOpen() { return active; } };
  })();

  // ════════════════════════════════════════════════════════════════
  // First-run onboarding
  // ════════════════════════════════════════════════════════════════
  function setupOnboarding() {
    const panel = $('#onboard');
    if (!panel) return;

    const finish = async (thenTour) => {
      panel.classList.add('hidden');
      await window.api?.setSetting('onboarded', true).catch(() => {});
      await app()?.refreshSettings();
      // Scanning while the tour runs means the library is already populated by
      // the time the tour reaches it.
      app()?.scanAndRender();
      if (thenTour) setTimeout(() => Tour.start(0), 260);
    };

    $('#onboard-skip').onclick = () => finish(false);
    $('#onboard-go').onclick = () => finish(true);

    window.addEventListener('librarian:ready', () => {
      if (!prefs().onboarded) setTimeout(() => panel.classList.remove('hidden'), 600);
    }, { once: true });
  }

  // ════════════════════════════════════════════════════════════════
  // Motion — continuity between steps
  //
  // app.js decides *what* is on screen; this decides how you get told
  // about it. Three jobs: give a page change a direction, keep one
  // indicator sliding under the tabs instead of six blinking, and make
  // a list that loses a row close the gap instead of snapping shut.
  // ════════════════════════════════════════════════════════════════
  const Motion = (() => {
    let ind = null;

    /** Slide the pill under whichever tab is active. */
    function placeIndicator(animate = true) {
      const nav = document.getElementById('topbar-nav');
      const active = nav?.querySelector('.nav-tab.active');
      if (!nav || !ind) return;
      if (!active) { ind.classList.remove('on'); return; }
      if (!animate) ind.classList.add('placing');
      ind.style.setProperty('--nx', `${active.offsetLeft}px`);
      ind.style.setProperty('--nw', `${active.offsetWidth}px`);
      ind.classList.add('on');
      // Drop the no-transition guard on a timer rather than a frame
      // callback: a hidden renderer never delivers the frame, and the
      // indicator would then be stuck unable to animate for the session.
      if (!animate) setTimeout(() => ind.classList.remove('placing'), 60);
    }

    function initIndicator() {
      const nav = document.getElementById('topbar-nav');
      if (!nav || document.getElementById('nav-ind')) return;
      ind = document.createElement('span');
      ind.id = 'nav-ind';
      ind.setAttribute('aria-hidden', 'true');
      nav.appendChild(ind);
      // Only now is it safe for the stylesheet to strip the per-tab
      // active styling — if any of the above threw, the original look
      // is still in place.
      root.dataset.navind = 'on';
      placeIndicator(false);
      window.addEventListener('resize', () => placeIndicator(false));
    }

    /**
     * Travel direction is set by navigateTo in app.js, before it adds
     * .active — doing it from here, after the event, would change
     * animation-name on an already-running animation and restart it,
     * which is seen as a flash. All this needs to do is move the pill.
     */
    function onPage() {
      placeIndicator(true);
    }

    /**
     * FLIP for a list that rerenders wholesale.
     *
     * The queue throws its DOM away and rebuilds on every change, and the
     * event that announces the change does not fire in a fixed order
     * around that rebuild — so measuring "before" on the event is not
     * reliable. Instead each row's position is remembered by job id, and
     * on the next render a row that moved is put back where it was and
     * then released. A MutationObserver is what fires at exactly the
     * right moment, and it needs no cooperation from app.js.
     *
     * Both axes are tracked, because the queue is a horizontal strip
     * while most other lists are vertical, and offset* rather than
     * getBoundingClientRect so scrolling the strip does not read as
     * movement.
     */
    function watchList(container, selector) {
      if (!container || typeof MutationObserver !== 'function') return;
      const seen = new Map();
      const keyOf = el => el.dataset.jobId || el.dataset.appid || el.id || '';

      const settle = () => {
        // A page that is not the active one has no layout at all: every
        // offset reads 0. Recording that as the baseline would fling
        // every row in from the corner the first time the page is shown,
        // so throw the baseline away and rebuild it once it is visible.
        if (!container.offsetParent) { seen.clear(); return; }

        const now = new Map();
        for (const el of container.querySelectorAll(selector)) {
          const key = keyOf(el);
          if (!key) continue;
          const pos = { x: el.offsetLeft, y: el.offsetTop };
          now.set(key, pos);
          const prev = seen.get(key);
          if (!prev || reduceMotion()) continue;    // new row: its own entrance plays
          const dx = prev.x - pos.x;
          const dy = prev.y - pos.y;
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
          el.style.transition = 'none';
          el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
          setTimeout(() => {
            el.classList.add('flip-move');
            el.style.transition = '';
            el.style.transform = '';
            setTimeout(() => el.classList.remove('flip-move'), 420);
          }, 20);
        }
        seen.clear();
        for (const [k, v] of now) seen.set(k, v);
      };

      new MutationObserver(settle).observe(container, { childList: true });
      settle();
    }

    return { initIndicator, onPage, placeIndicator, watchList };
  })();

  // ════════════════════════════════════════════════════════════════
  // Wiring
  // ════════════════════════════════════════════════════════════════
  function init() {
    safely('palette', Palette.init);
    safely('shortcuts', Shortcuts.init);
    safely('hotkeys', setupHotkeys);
    safely('spatial-nav', setupSpatialNav);
    safely('gamepad', Gamepad.init);
    safely('tilt', setupTilt);
    safely('shelves', setupShelves);
    safely('hero', Hero.init);
    safely('download-hud', setupDownloadHud);
    safely('download-focus', Focus.init);
    safely('flyout-tint', setupFlyoutTint);
    safely('setup-banner', setupSetupBanner);
    safely('library-controls', setupLibraryControls);
    safely('collections', setupCollections);
    safely('settings-nav', setupSettingsNav);
    safely('button-feedback', setupButtonFeedback);
    safely('window-chrome', setupWindowChrome);
    safely('tour', Tour.init);
    safely('onboarding', setupOnboarding);
    safely('motion', Motion.initIndicator);
    safely('motion-queue', () => Motion.watchList(document.getElementById('queue-cards'), '.queue-card'));

    // ── App events ────────────────────────────────────────────────
    window.addEventListener('librarian:rendered', (e) => {
      observeReveals(e.detail?.container || document);
    });

    window.addEventListener('librarian:games', () => {
      refreshSidebarCounts();
      renderCollections();
    });

    window.addEventListener('librarian:hero', (e) => {
      Hero.setCandidates(e.detail?.candidates || [], e.detail?.game);
      Accent.applyFor(e.detail?.game);
    });

    window.addEventListener('librarian:page', (e) => {
      safely('motion-page', () => Motion.onPage(e.detail?.page));
      // The speed sparkline is sized from CSS, so it must be redrawn whenever
      // the Downloads page becomes visible and finally has a real box.
      if (e.detail?.page === 'downloads') setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
      if (e.detail?.page === 'settings') setupSettingsNav();
    });


    window.addEventListener('librarian:prefs', () => {
      root.dataset.tilt = prefs().ui_tilt === false ? 'off' : 'on';
      Gamepad.sync();
      Hero.refresh();
      Accent.applyFor(app()?.state?.heroGame);
    });

    // ── Borrowed light ────────────────────────────────────────────
    // Each tile pools its own cover's colour when you hover it, so the
    // shelf lights up in the colour of whatever you are looking at rather
    // than in one brand accent. See src/styles/library.css.
    //
    // Sampled on first hover, not on render: a library of 200 covers would
    // otherwise decode 200 images at startup for an effect nobody has asked
    // to see yet. One sample per tile per session, cached on the element.
    (function borrowedLight() {
      const grid = () => document.getElementById('lib-grid');
      const pending = new WeakSet();

      async function tint(tile) {
        if (tile.dataset.tinted || pending.has(tile)) return;
        pending.add(tile);
        const bridge = app();
        const key = tile.dataset.key;
        const game = bridge?.state?.games?.find((g) => bridge.gameKeyOf?.(g) === key);
        const url = game && bridge.getGameBannerUrl?.(game, 'header');
        if (!url) { tile.dataset.tinted = '1'; return; }
        const colour = await Accent.sample(url).catch(() => null);
        tile.dataset.tinted = '1';
        // No colour is a perfectly good answer — the CSS falls back to brass.
        if (colour) tile.style.setProperty('--tile-tint', colour);
      }

      // Delegated, so refreshed and newly paged tiles share one listener.
      document.addEventListener('pointerover', (e) => {
        if (prefs().dynamic_accent === false) return;
        const tile = e.target.closest?.('.game-tile');
        if (tile && grid()?.contains(tile)) safely('tile-tint', () => tint(tile));
      }, { passive: true });
    })();

    window.addEventListener('librarian:celebrate', () => celebrate());
    window.addEventListener('librarian:ready', () => {
      refreshSidebarCounts();
      renderCollections();
      setupLibraryControls();
    });

    // Redraw the sparkline when the window resizes.
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => window.dispatchEvent(new CustomEvent('librarian:redraw')), 120);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
