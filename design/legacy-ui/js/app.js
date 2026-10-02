// ═══════════════════════════════════════════════════════════
// Librarian — Xbox-Style Launcher Controller
// ═══════════════════════════════════════════════════════════
(function () {
  'use strict';

  const THEME_DEFAULTS = { accent: '#D2A65C', background: '#0C0D10' };
  // Kept in step with DEFAULTS.bigpicture_accent in src/core/settingsStore.js.
  const BP_ACCENT_DEFAULT = '#17C8B6';

  const state = {
    queue: [],
    queueReady: false,
    cancelling: false,
    queueGeneration: 0,
    isProcessing: false,
    isPaused: false,
    currentGameData: null,
    settings: {},
    speedHistory: [],
    smoothedSpeed: 0,
    diskSpeed: '',
    lastSpeedSampleAt: 0,
    lastNonzeroSpeedAt: 0,
    currentTotalBytes: 0,
    currentTotalBytesEstimated: false,
    awaitingUpdatePlan: false,   // an update whose real size the engine hasn't reported yet
    updatePlan: null,            // the engine's diff of the old and new builds
    wireBytes: 0,                // bytes actually off the network this job
    currentPercent: 0,
    progressHistory: [],
    downloadStartTime: 0,
    games: [],
    updateResults: {},
    heroGame: null,
    currentPage: 'home',
    activeDownloadAuthChallenge: null,
    favorites: [],
    libraryView: 'all',
    librarySort: 'name',
    activeCollection: null,
    elapsedTimer: null,
    heroCandidates: [],
    patchNotesToken: 0,
    flyoutPosterToken: 0,
    pendingConfirm: null,
    // key -> { name, startedAt } for games currently running
    running: {},
    nowPlayingTimer: null,
    flyoutMediaToken: 0,
    achToken: 0,
    // The second source (src/core/csrin.js): whether its tools were found,
    // and where a release goes when the user has not chosen a folder.
    csrin: { available: false, downloadDir: '', cliPath: '' },
    // The local manifest source beside Hubcap (src/core/steamManifest.js):
    // whether the project was found and where, and which sources are in
    // effect for the Manifest source setting — what the Store gates on.
    steamManifest: { available: false, dir: '', from: '', bundled: '', keysKnown: 0, sources: [], mode: 'auto', error: '', configuredMissing: false, version: null, catalogs: { depotKeys: { enabled: false }, appTokens: { enabled: false } } },
    // '' while the archive is coming down, 'extract' once it is being placed
    // into the game; the focus view words its kicker from this.
    csrinPhase: '',
    // appid -> true/false once Steam's DRM line has been read; only Denuvo
    // titles get the second source at all.
    denuvo: {},
    // Downloads and updates that finished and may need a release fetched once
    // the library has been rescanned: [{ appid, name }].
    csrinPending: [],
  };

  const IS_WINDOWS = (window.api && api.platform) === 'win32';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const OS_ICONS = {
    windows: `<svg class="os-icon" viewBox="0 0 16 16"><path fill="currentColor" d="M0 2.3l6.5-.9v6.3H0V2.3zm7.3-1l8.7-1.3v7.6H7.3V1.3zM16 8.7v7.5l-8.7-1.2V8.7H16zM6.5 14.7L0 13.8V8.7h6.5v6z"/></svg>`,
    linux: `<svg class="os-icon" viewBox="0 0 16 16"><path fill="currentColor" d="M8 1C5.8 1 4 3 4 5.5c0 1.3.5 2.5 1.3 3.3-.8.5-1.8 1.4-2.3 2.7-.3.8 0 1.7.7 2.2.5.3 1.1.3 1.6.1.4-.2.8-.5 1.1-.9.5-.7 1-.8 1.6-.8s1.1.1 1.6.8c.3.4.7.7 1.1.9.5.2 1.1.2 1.6-.1.7-.5 1-1.4.7-2.2-.5-1.3-1.5-2.2-2.3-2.7C10.5 8 11 6.8 11 5.5 11 3 9.2 1 8 1z"/></svg>`,
    macos: `<svg class="os-icon" viewBox="0 0 16 16"><path fill="currentColor" d="M12.2 5.3c-.1-.1-1.6-.9-1.6-2.8 0-2.2 1.9-3 2-3.1-.1-.1-1.1-1.4-2.8-1.4-1.2 0-1.8.7-2.7.7-.9 0-1.6-.7-2.7-.7C2.6-2 0-.1 0 3.1c0 2 .7 4.1 1.6 5.4.8 1.1 1.5 2 2.5 2 1 0 1.3-.7 2.8-.7 1.4 0 1.7.7 2.7.7 1 0 1.8-1 2.5-2 .4-.6.7-1.1.9-1.4 0 0-1.8-.7-1.8-2.8zM9.8.2c.6-.7.9-1.6.9-2.5 0-.1 0-.3-.1-.4-1 .1-2.1.7-2.7 1.4-.6.7-.9 1.5-.9 2.5 0 .1 0 .3.1.4.1 0 .2 0 .3 0 .8 0 1.8-.6 2.4-1.4z" transform="translate(1.5,4)"/></svg>`,
  };

  // ─── Init ───────────────────────────────────────────
  async function init() {
    setupGlobalErrorHandling();
    try {
      state.settings = await api.getAllSettings();
    } catch (e) {
      console.error('Failed to load settings:', e);
      state.settings = {};
    }
    state.favorites = Array.isArray(state.settings.favorites) ? state.settings.favorites : [];
    // Hydrate cached update results so badges show immediately, before the network re-check.
    if (state.settings.update_results && typeof state.settings.update_results === 'object') {
      state.updateResults = { ...state.settings.update_results };
    }
    applyThemeColors(
      state.settings.accent_color || THEME_DEFAULTS.accent,
      state.settings.background_color || THEME_DEFAULTS.background
    );
    applyReduceMotion(Boolean(state.settings.reduce_motion));
    state.librarySort = state.settings.library_sort || 'name';

    // Layout preferences are applied before the first render so nothing reflows.
    const root = document.documentElement;
    root.dataset.density = state.settings.grid_density || 'cozy';
    root.dataset.libview = state.settings.library_view_mode || 'grid';
    root.dataset.tilt = state.settings.ui_tilt === false ? 'off' : 'on';
    root.dataset.nav = 'pointer';

    // Each setup step is isolated so one failure can't blank the whole UI.
    const steps = [
      ['navigation', setupNavigation],
      ['window controls', setupWindowControls],
      ['drop zone', setupDropZone],
      ['download listeners', setupDownloadListeners],
      ['queue controls', setupQueueControls],
      ['search page', setupSearchPage],
      ['settings page', setupSettingsPage],
      ['crack page', setupCrackPage],
      ['cs.rin.ru', setupCsrin],
      ['steammanifest', setupSteamManifest],
      ['news', setupNews],
      ['home page', setupHomePage],
      ['library page', setupLibraryPage],
      ['game sessions', setupGameSessions],
      ['context menu', setupContextMenu],
      ['lightbox', setupLightbox],
    ];
    for (const [name, fn] of steps) {
      try {
        fn();
      } catch (e) {
        console.error(`Failed to set up ${name}:`, e);
        log(`⚠ Failed to initialise ${name}: ${e.message}`, 'error');
      }
    }
    await restoreQueue();
    log('✦ Librarian Launcher is ready.', 'accent');
    emit('ready', { settings: state.settings });
  }

  function setupGlobalErrorHandling() {
    window.addEventListener('error', (event) => {
      const message = event?.error?.message || event?.message || 'Unknown error';
      console.error('Uncaught error:', event?.error || event);
      log(`⚠ Unexpected error: ${message}`, 'error');
    });
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event?.reason;
      const message = reason?.message || String(reason || 'Unknown error');
      console.error('Unhandled promise rejection:', reason);
      log(`⚠ Unexpected error: ${message}`, 'error');
      toast(message, 'error', { duration: 8000 });
    });
  }

  // ─── Navigation ─────────────────────────────────────
  function setupNavigation() {
    $$('.nav-tab[data-page]').forEach(btn => {
      btn.addEventListener('click', () => navigateTo(btn.dataset.page));
    });
    $$('.sidebar-link[data-page], #sidebar-party-card [data-page]').forEach(btn => {
      btn.addEventListener('click', () => navigateTo(btn.dataset.page));
    });
    $$('.row-see-all').forEach(btn => {
      btn.addEventListener('click', () => navigateTo(btn.dataset.target));
    });

    // "All Games" and "Favorites" share the library page but set different views.
    const allGamesLink = $('#sidebar-all-games');
    if (allGamesLink) allGamesLink.addEventListener('click', () => setLibraryView('all'));
    const favLink = $('#sidebar-favorites');
    if (favLink) favLink.addEventListener('click', () => setLibraryView('favorites'));
    const recentLink = $('#sidebar-recent');
    if (recentLink) recentLink.addEventListener('click', () => {
      state.librarySort = 'recent';
      const sortSel = $('#lib-sort');
      if (sortSel) sortSel.value = 'recent';
      setLibraryView('all');
    });
    const globalSearch = $('#global-search-input');
    if (globalSearch) {
      globalSearch.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); window.dispatchEvent(new CustomEvent('librarian:search', { detail: globalSearch.value.trim() })); }
      });
    }
  }

  const NAV_ORDER = ['home', 'library', 'store', 'downloads', 'crack', 'tuning', 'settings'];

  function navigateTo(page) {
    if (state.currentPage === page && $(`#page-${page}`)?.classList.contains('active')) return;
    const from = NAV_ORDER.indexOf(state.currentPage);
    const to = NAV_ORDER.indexOf(page);
    state.currentPage = page;
    $$('.nav-tab').forEach(b => {
      const active = b.dataset.page === page;
      b.classList.toggle('active', active);
      if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $$('.page').forEach(p => p.classList.remove('active'));
    const pageEl = $(`#page-${page}`);
    if (pageEl) {
      // Which way the page travels must be decided BEFORE .active goes on.
      // Setting it afterwards changes animation-name on an animation that is
      // already running, and a changed name restarts it from its first
      // keyframe — which is what a flash is. For the same reason the
      // attribute is never removed afterwards: taking it off would hand the
      // page back to main.css's own entrance and restart it a second time.
      pageEl.dataset.dir = (from >= 0 && to >= 0 && to < from) ? 'back' : 'fwd';
      pageEl.classList.add('active');
    }
    $$('.sidebar-link').forEach(b => b.classList.toggle('active', b.dataset.page === page));
    emit('page', { page });
  }

  function setupWindowControls() {
    $('#btn-minimize').onclick = () => api.minimize();
    $('#btn-maximize').onclick = () => api.maximize();
    $('#btn-close').onclick = () => api.close();
  }

  // ─── Home Page ──────────────────────────────────────
  function setupHomePage() {
    $('#home-scan-btn').onclick = () => scanAndRender();
    $('#home-store-btn').onclick = () => navigateTo('store');
    $('#hero-play-btn').onclick = () => {
      if (state.heroGame) launchGame(state.heroGame);
    };
    $('#hero-details-btn').onclick = () => {
      if (state.heroGame) openFlyout(state.heroGame);
    };
    // Show the last confirmed library while the worker scans the disks.
    (async () => {
      try {
        const cached = await api.getCachedGames();
        if (cached?.games?.length) { state.games = cached.games; renderHome(); renderLibraryGrid(); emit('games', { games: state.games }); }
      } catch (error) { log(error.message, 'error'); }
      await scanAndRender();
    })();
  }

  async function scanAndRender() {
    // Show the shape of the page immediately; an empty screen during a slow
    // disk scan reads as "broken" far more than a set of placeholders does.
    if (!state.games.length) showScanSkeletons();
    try {
      const games = await api.scanGames();
      if (!Array.isArray(games)) throw new Error('The library scan returned an invalid response.');
      state.games = games;
      const snapshot = await api.getCachedGames();
      if (snapshot?.warnings?.length) toast('Some library folders are unavailable. Their games have been kept.', 'error', { duration: 8000 });
    } catch (e) {
      console.error('Library scan failed:', e);
      toast(`Library scan failed: ${e.message}. The previous library has been kept.`, 'error');
    }
    renderHome();
    renderLibraryGrid();
    emit('games', { games: state.games });
    if (state.games.length > 0) {
      checkUpdatesInBackground();
    }
  }

  function skeletonTile() {
    return `<div class="tile-skeleton skeleton">
      <div class="sk-img"></div>
      <div class="sk-line"></div>
      <div class="sk-line short"></div>
    </div>`;
  }

  function showScanSkeletons() {
    const empty = $('#home-empty');
    if (empty) empty.style.display = 'none';
    const rowAll = $('#row-all');
    const rowAllScroll = $('#row-all-scroll');
    if (rowAll && rowAllScroll) {
      rowAll.style.display = '';
      rowAllScroll.innerHTML = skeletonTile().repeat(6);
    }
    const grid = $('#lib-grid');
    if (grid && !grid.querySelector('.game-tile')) grid.innerHTML = skeletonTile().repeat(12);
  }

  function renderHome() {
    const empty = $('#home-empty');
    const heroSection = $('#hero-section');
    const rowContinue = $('#row-continue');
    const rowRecent = $('#row-recent');
    const rowUpdates = $('#row-updates');
    const rowMost = $('#row-mostplayed');
    const rowAll = $('#row-all');

    renderLedger();

    if (!state.games.length) {
      empty.style.display = '';
      heroSection.style.display = 'none';
      [rowContinue, rowRecent, rowUpdates, rowMost, rowAll].forEach(r => { if (r) r.style.display = 'none'; });
      return;
    }

    empty.style.display = 'none';
    heroSection.style.display = '';

    const played = [...state.games].filter(g => (g.last_played || 0) > 0)
      .sort((a, b) => (b.last_played || 0) - (a.last_played || 0));
    const mostPlayed = [...state.games].filter(g => (g.playtime_seconds || 0) > 0)
      .sort((a, b) => (b.playtime_seconds || 0) - (a.playtime_seconds || 0));

    // Hero: the game you last played, else the first with art. A handful of
    // runners-up are kept so the spotlight can cycle through them.
    const withArt = state.games.filter(g => (g.appid && g.appid !== '0') || g.banner_path);
    const candidates = [];
    const seenKeys = new Set();
    for (const g of [...played, ...mostPlayed, ...withArt, ...state.games]) {
      const key = gameKeyOf(g) || g.game_name;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      candidates.push(g);
      if (candidates.length >= 6) break;
    }
    state.heroCandidates = candidates;

    // Keep showing whatever the rotation had landed on across a re-render.
    const stillPresent = state.heroGame && candidates.includes(state.heroGame);
    const heroCandidate = stillPresent ? state.heroGame : (candidates[0] || state.games[0]);
    state.heroGame = heroCandidate;
    renderHero(heroCandidate);
    emit('hero', { game: heroCandidate, candidates });

    // Continue Reading — recently played.
    const continueGames = played.filter(g => g !== heroCandidate).slice(0, 12);
    renderGameRow('#row-continue-scroll', continueGames);
    rowContinue.style.display = continueGames.length ? '' : 'none';

    // New Acquisitions — shelved but not yet played (your backlog).
    const unplayed = state.games.filter(g => (g.launch_count || 0) === 0 && g !== heroCandidate).slice(0, 12);
    renderGameRow('#row-recent-scroll', unplayed);
    rowRecent.style.display = unplayed.length ? '' : 'none';

    // Most Played.
    const most = mostPlayed.slice(0, 12);
    renderGameRow('#row-mostplayed-scroll', most);
    rowMost.style.display = most.length ? '' : 'none';

    // All games.
    renderGameRow('#row-all-scroll', state.games);
    rowAll.style.display = state.games.length ? '' : 'none';

    // Updates row (filled once the update check reports back).
    rowUpdates.style.display = 'none';
  }

  /** Resolve to the URL if the image actually loads, reject if it does not. */
  function probeImage(src) {
    return new Promise((resolve, reject) => {
      if (!src) { reject(new Error('no src')); return; }
      const img = new Image();
      img.onload = () => resolve(src);
      img.onerror = () => reject(new Error('404'));
      img.src = src;
    });
  }

  /**
   * The hero wordmark.
   *
   * Steam ships a transparent logo for most titles, and it is the lettering
   * the publisher art-directed — always better than the game's name set in
   * our own typeface. Big Picture already uses it; this is the same asset on
   * the desktop hero, with the serif title as the fallback for everything
   * Valve never generated one for.
   *
   * The token guards the race: the hero rotates on a timer, so a slow logo
   * for the game you just left must not land on the game now showing.
   */
  let heroLogoToken = 0;
  function applyHeroLogo(game) {
    const img = $('#hero-logo');
    const content = $('#hero-content');
    if (!img || !content) return;

    const token = ++heroLogoToken;
    const clear = () => {
      img.classList.add('hidden');
      img.removeAttribute('src');
      content.classList.remove('has-logo');
    };
    clear();

    const id = safeAppId(game.appid);
    if (!id || id === '0') return;

    const base = `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}`;
    probeImage(`${base}/logo.png`)
      .catch(() => probeImage(`${base}/logo_2x.png`))
      .then((src) => {
        if (token !== heroLogoToken) return;
        img.src = src;
        // The alt carries the name, so hiding the <h1> visually costs nothing.
        img.alt = game.game_name || '';
        img.classList.remove('hidden');
        content.classList.add('has-logo');
      })
      .catch(() => { if (token === heroLogoToken) clear(); });
  }

  function renderHero(game) {
    if (!game) return;
    setHeroBackground(getGameBannerUrl(game, 'hero'), game);
    $('#hero-title').textContent = game.game_name || 'Unknown Game';
    applyHeroLogo(game);
    const badge = $('#hero-badge');
    const playBtn = $('#hero-play-btn');
    const hasPlayed = (game.playtime_seconds || 0) > 0 || (game.launch_count || 0) > 0;
    if (badge) badge.textContent = hasPlayed ? 'Continue' : 'Featured';
    if (playBtn) {
      const label = hasPlayed ? 'Continue' : 'Play';
      playBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"/></svg>${label}`;
    }
    const bits = [];
    if ((game.playtime_seconds || 0) > 0) bits.push(`${formatPlaytime(game.playtime_seconds)} played`);
    if (game.last_played) bits.push(`Last played ${formatRelative(game.last_played)}`);
    else if (game.size_on_disk) bits.push(formatSize(game.size_on_disk));
    if (game.appid && game.appid !== '0') bits.push(`AppID ${game.appid}`);
    $('#hero-subtitle').textContent = bits.join('  ·  ') || 'Ready to play.';
  }

  function renderLedger() {
    const games = state.games || [];
    const totalSeconds = games.reduce((t, g) => t + (g.playtime_seconds || 0), 0);
    const totalSize = games.reduce((t, g) => t + (g.size_on_disk || 0), 0);
    const gamesEl = $('#ledger-games');
    const hoursEl = $('#ledger-hours');
    const sizeEl = $('#ledger-size');
    if (gamesEl) gamesEl.textContent = String(games.length);
    if (hoursEl) hoursEl.textContent = totalSeconds > 0 ? formatPlaytime(totalSeconds) : '0h';
    if (sizeEl) sizeEl.textContent = formatSize(totalSize);
  }

  const HERO_FALLBACK_BG = 'linear-gradient(135deg, var(--primary-dark), var(--bg-deep) 60%)';

  function setHeroBackground(url, game) {
    const el = $('#hero-bg');
    if (!el) return;
    // Only swap in the CDN image once it actually loads; otherwise keep the gradient.
    el.style.backgroundImage = HERO_FALLBACK_BG;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    if (!url && !game) return;

    const apply = (src) => { el.style.backgroundImage = `url(${src})`; };
    const probe = (src) => new Promise((resolve, reject) => {
      if (!src) { reject(); return; }
      const img = new Image();
      img.onload = () => resolve(src);
      img.onerror = reject;
      img.src = src;
    });

    probe(url)
      .then(apply)
      // The legacy CDN path may not exist for this app; ask for the real one.
      .catch(() => resolveArtFor(game?.appid)
        .then(art => probe(art?.hero || art?.header))
        .then(apply)
        .catch(() => { el.style.backgroundImage = HERO_FALLBACK_BG; }));
  }

  function renderGameRow(containerId, games) {
    const container = $(containerId);
    container.innerHTML = '';
    const peak = peakPlaytime();
    // One fragment, one reflow — matters on shelves of a few hundred tiles.
    const frag = document.createDocumentFragment();
    for (const g of games) frag.appendChild(createGameTile(g, { peak }));
    container.appendChild(frag);
    emit('rendered', { container, count: games.length, kind: 'row' });
  }

  function getGameBannerUrl(game, type = 'header') {
    // Custom banner takes priority
    if (game.banner_path) return filePathToUrl(game.banner_path);
    if (game.banner_url) return safeHttpUrl(game.banner_url);
    // Fallback to Steam CDN
    const appId = safeAppId(game.appid);
    if (appId && appId !== '0') {
      if (type === 'hero') return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_hero.jpg`;
      if (type === 'portrait') return steamPortraitUrl(appId);
      return steamHeaderUrl(appId);
    }
    return '';
  }

  /** Steam's 600×900 library poster — the vertical box art. */
  function steamPortraitUrl(appId) {
    const id = safeAppId(appId);
    return id ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/library_600x900.jpg` : '';
  }

  // ─── Artwork resolution ─────────────────────────────
  // The legacy CDN path (…/steam/apps/<id>/header.jpg) 404s for newer apps —
  // their art lives at content-hashed URLs only the store API knows about. The
  // main process finds and caches the real URLs; this memoises per session so a
  // grid of tiles asks once per game.
  const artMemo = new Map();

  function resolveArtFor(appId) {
    const id = safeAppId(appId);
    if (!id || id === '0' || !api.resolveGameArt) return Promise.resolve(null);
    if (!artMemo.has(id)) {
      artMemo.set(id, api.resolveGameArt(id).catch(() => null));
    }
    return artMemo.get(id);
  }

  /**
   * Wire an <img> so that a 404 triggers a real lookup instead of giving up.
   * Only when that also comes back empty does the generated cover show through.
   */
  function attachArtFallback(img, game, kind = 'header') {
    if (!img) return;
    img.onerror = () => {
      img.onerror = null;
      img.style.display = 'none';
      resolveArtFor(game.appid).then((art) => {
        if (!art) return;
        const url = kind === 'portrait'
          ? (art.portrait || art.header || art.hero)
          : (art.header || art.hero || art.portrait);
        if (!url) return;
        // If this one fails too, leave the generated art in place.
        img.onerror = () => { img.onerror = null; img.style.display = 'none'; };
        img.src = url;
        img.style.display = '';
      });
    };
  }

  // ─── Generated artwork ──────────────────────────────
  // Plenty of games have no art on the CDN at all — custom entries, regional
  // releases, anything Valve never generated a capsule for ("Best of
  // reincarnation" among them). Rather than a grey box with a controller emoji,
  // derive a stable colourway from the title and render a real cover.

  function artSeed(text) {
    let hash = 2166136261;
    const source = String(text || 'game');
    for (let i = 0; i < source.length; i++) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash;
  }

  /** Inline custom properties describing this title's colourway. */
  function artStyleFor(name) {
    const hash = artSeed(name);
    const hue = hash % 360;
    // Second hue is offset far enough to read as a gradient, never as a smear.
    const hue2 = (hue + 35 + ((hash >> 9) % 70)) % 360;
    return `--art-a:hsl(${hue} 42% 22%);--art-b:hsl(${hue2} 48% 9%);--art-c:hsl(${hue} 78% 66%);--art-rot:${(hash >> 17) % 40 - 20}deg`;
  }

  /** Up to two initials, skipping words that carry no signal. */
  function artInitials(name) {
    const SKIP = new Set(['the', 'of', 'a', 'an', 'and', 'de', 'le', 'la']);
    const words = String(name || '')
      .split(/[\s:_\-–—]+/)
      .map(w => w.replace(/[^\p{L}\p{N}]/gu, ''))
      .filter(w => w && !SKIP.has(w.toLowerCase()));
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  function artFallbackHtml(name, extraClass = '') {
    return `<div class="art-fallback ${extraClass}" style="${artStyleFor(name)}" aria-hidden="true">
      <span class="art-mark">${esc(artInitials(name))}</span>
      <span class="art-name">${esc(name || 'Unknown')}</span>
    </div>`;
  }

  /** Longest playtime in the library — the denominator for tile heat bars. */
  function peakPlaytime() {
    let peak = 0;
    for (const g of state.games) peak = Math.max(peak, g.playtime_seconds || 0);
    return peak;
  }

  /**
   * Present a wide image inside the portrait tile without cropping it.
   * Runs on load and on every later src change (the art fallback swaps it).
   */
  function fitTileArt(img) {
    if (!img) return;
    const check = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return;
      const wrap = img.closest('.game-tile-img-wrap');
      if (!wrap) return;
      // 1.2 rather than 1.0: a few posters are very slightly wide, and
      // letterboxing those would waste the frame for nothing.
      const wide = w / h > 1.2;
      wrap.classList.toggle('is-wide', wide);
      if (wide) wrap.style.setProperty('--art-url', `url("${img.currentSrc || img.src}")`);
      else wrap.style.removeProperty('--art-url');
    };
    if (img.complete) check();
    img.addEventListener('load', check);
  }

  function createGameTile(game, options = {}) {
    const tile = document.createElement('div');
    tile.className = 'game-tile reveal';
    tile.setAttribute('role', 'button');
    tile.tabIndex = 0;
    tile.setAttribute('aria-label', game.game_name || 'Game');
    tile.dataset.key = gameKeyOf(game);
    /*
     * Which shape of art this tile wants, decided by the caller.
     *
     * The library grid asks for the vertical 600x900 poster — that is the
     * format publishers art-direct for a shelf, and it fits far more games
     * on screen. Home's shelves are landscape frames and must keep asking
     * for the banner: feeding them portraits crops every one of them to a
     * sliver. Defaulting to 'header' keeps every existing caller correct.
     */
    const artKind = options.art === 'portrait' ? 'portrait' : 'header';
    const img = getGameBannerUrl(game, artKind);
    const running = isGameRunning(game);
    if (running) tile.classList.add('is-running');
    if (game.unavailable) { tile.classList.add('is-unavailable'); tile.title = 'Drive unavailable — reconnect it and scan again'; }
    const badgeHtml = running
      ? '<div class="tile-update-badge" style="background:var(--patina);color:#06110d">● Playing</div>'
      : (isUpdateAvailable(state.updateResults[updateResultKey(game)])
        ? '<div class="tile-update-badge">Update</div>' : '');
    const customBadge = game.source === 'Custom' ? '<div class="tile-custom-badge">Custom</div>' : '';
    const fav = isFavorite(game);
    const played = game.playtime_seconds || 0;
    const hours = played > 0
      ? `<span class="tile-play-hours">${formatPlaytime(played)}</span>` : '';
    const nameHtml = options.highlightPositions
      ? highlight(game.game_name, options.highlightPositions)
      : esc(game.game_name);

    tile.innerHTML = `
      <div class="game-tile-img-wrap" style="${artStyleFor(game.game_name)}">
        ${artFallbackHtml(game.game_name)}
        ${img ? `<img class="game-tile-img" src="${esc(img)}" alt="" loading="lazy" decoding="async">` : ''}
        <div class="game-tile-sheen"></div>
        <div class="tile-plate" aria-hidden="true"><span class="tile-plate-title">${esc(game.game_name || '')}</span></div>
        ${badgeHtml}
        ${customBadge}
        <button class="tile-fav-btn ${fav ? 'is-fav' : ''}" title="${fav ? 'Remove from favorites' : 'Add to favorites'}" tabindex="-1">${fav ? '★' : '☆'}</button>
        <button class="tile-play-btn" title="Play" tabindex="-1">▶</button>
      </div>
      <div class="game-tile-name">${nameHtml}</div>
      <div class="game-tile-meta">${formatSize(game.size_on_disk || 0)}${hours}</div>
    `;
    attachArtFallback(tile.querySelector('.game-tile-img'), game, artKind);
    // Not every game has a 600x900 poster; those fall back to the 460x215
    // banner, and cropping a banner into a portrait frame cuts the title
    // clean off ("Beast of Reincarnation" became "ST / ATION"). When what
    // actually loaded is wide, letterbox it over a blurred copy of itself —
    // the same treatment the detail poster already uses.
    if (artKind === 'portrait') fitTileArt(tile.querySelector('.game-tile-img'));
    tile.onclick = () => openFlyout(game);
    tile.addEventListener('keydown', (e) => {
      // Inner buttons keep their native keyboard activation. A tile has one
      // activation path, so Shift+Enter cannot open details before launching.
      if (e.target !== tile || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (e.repeat) return;
        if (e.key === 'Enter' && e.shiftKey) launchGame(game);
        else openFlyout(game);
      }
    });
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, game);
    });
    const favBtn = tile.querySelector('.tile-fav-btn');
    favBtn.onclick = (e) => {
      e.stopPropagation();
      favBtn.classList.remove('stamping'); void favBtn.offsetWidth; favBtn.classList.add('stamping');
      toggleFavorite(game);
    };
    const playBtn = tile.querySelector('.tile-play-btn');
    playBtn.onclick = (e) => { e.stopPropagation(); launchGame(game); };
    return tile;
  }

  // ─── Favorites ──────────────────────────────────────
  function favKey(game) {
    if (!game) return '';
    if (game.source === 'Custom' && game.id) return `custom:${game.id}`;
    const id = safeAppId(game.appid);
    if (id && id !== '0') return `steam:${id}`;
    if (game.install_path) return `path:${game.install_path}`;
    return '';
  }

  function isFavorite(game) {
    const key = favKey(game);
    return Boolean(key) && state.favorites.includes(key);
  }

  async function toggleFavorite(game) {
    const key = favKey(game);
    if (!key) { toast('Cannot favorite this game', 'error'); return; }
    const idx = state.favorites.indexOf(key);
    const next = idx === -1 ? [...state.favorites, key] : state.favorites.filter(value => value !== key);
    try { await api.setSetting('favorites', next); }
    catch (error) { toast('Favorite was not saved: ' + error.message, 'error'); return; }
    state.favorites = next;
    if (state.currentPage === 'home') renderHome();
    renderLibraryGrid();
    if (state.flyoutGame) renderFlyoutFavoriteButton(state.flyoutGame);
    toast(idx === -1 ? `★ ${game.game_name} favorited` : `Removed ${game.game_name} from favorites`, 'success');
  }

  // ─── Collections ────────────────────────────────────
  // User-defined shelves, stored as { name: [favKey, …] } in settings so they
  // survive rescans exactly the way favourites do.
  function getCollections() {
    const raw = state.settings.collections;
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  }

  async function saveCollections(next) {
    try {
      await api.setSetting('collections', next);
      state.settings = await api.getAllSettings();
    } catch (e) {
      console.error('Failed to save collections:', e);
      toast('Could not save that collection', 'error');
      throw e;
    }
    emit('collections', { collections: getCollections() });
    renderLibraryGrid();
  }

  async function toggleCollectionMember(name, game) {
    const key = favKey(game);
    if (!key) { toast('This game cannot be filed into a collection', 'error'); return; }
    const collections = { ...getCollections() };
    const members = [...(collections[name] || [])];
    const index = members.indexOf(key);
    if (index === -1) members.push(key); else members.splice(index, 1);
    collections[name] = members;
    await saveCollections(collections);
    toast(index === -1 ? `Added to ${name}` : `Removed from ${name}`, 'success');
  }

  async function createCollection(name, seedGame = null) {
    const label = String(name || '').trim().slice(0, 60);
    if (!label) return false;
    const collections = { ...getCollections() };
    if (collections[label]) { toast(`“${label}” already exists`, 'error'); return false; }
    collections[label] = seedGame && favKey(seedGame) ? [favKey(seedGame)] : [];
    await saveCollections(collections);
    toast(`Collection “${label}” created`, 'success');
    return true;
  }

  async function deleteCollection(name) {
    const collections = { ...getCollections() };
    if (!(name in collections)) return;
    if (!(await showConfirm('Delete collection', `Delete “${name}”? The games themselves are untouched.`, { confirmLabel: 'Delete' }))) return;
    delete collections[name];
    if (state.activeCollection === name) setLibraryView('all');
    await saveCollections(collections);
    toast(`Deleted “${name}”`, 'success');
  }

  function showCollectionPicker(game) {
    const collections = getCollections();
    const key = favKey(game);
    const names = Object.keys(collections).sort((a, b) => a.localeCompare(b));

    const rows = names.length
      ? names.map(name => {
        const has = (collections[name] || []).includes(key);
        return `<li class="library-item${has ? ' selected' : ''}" data-name="${esc(name)}">
            <div class="library-radio"></div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:700;color:var(--paper)">${esc(name)}</div>
              <div class="library-path" style="color:var(--text-muted);font-size:11px">${(collections[name] || []).length} game(s)</div>
            </div>
          </li>`;
      }).join('')
      : '<div class="empty-state-small">No collections yet — name one below.</div>';

    openModal('Add to collection', `
      <div class="text-dim" style="font-size:13px;margin-bottom:12px">Filing <b style="color:var(--paper)">${esc(game.game_name)}</b>. Click a collection to add or remove it.</div>
      <ul class="library-list" id="coll-list">${rows}</ul>
      <div class="form-group" style="margin-top:14px">
        <label>New collection</label>
        <div class="color-pick-row">
          <input type="text" class="form-input" id="coll-new-name" placeholder="e.g. Couch co-op" style="flex:1" maxlength="60">
          <button class="xbox-btn xbox-btn-secondary btn-sm" id="coll-create">Create</button>
        </div>
      </div>
      <div class="modal-actions"><button class="xbox-btn xbox-btn-primary" id="coll-done">Done</button></div>
    `);

    $$('#coll-list .library-item').forEach((row) => {
      row.onclick = async () => {
        row.classList.toggle('selected');
        await toggleCollectionMember(row.dataset.name, game);
      };
    });

    const nameInput = $('#coll-new-name');
    const create = async () => {
      if (await createCollection(nameInput.value, game)) { closeModal(); showCollectionPicker(game); }
    };
    $('#coll-create').onclick = create;
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
    $('#coll-done').onclick = () => closeModal();
    nameInput.focus();
  }

  // ─── Launch ─────────────────────────────────────────
  function gameKeyOf(game) {
    if (!game) return '';
    if (game.game_key) return game.game_key;
    if (game.source === 'Custom' && game.id) return `custom:${game.id}`;
    const id = safeAppId(game.appid);
    if (id && id !== '0') return `steam:${id}`;
    if (game.install_path) return `path:${game.install_path}`;
    return '';
  }

  function isGameRunning(game) {
    const key = gameKeyOf(game);
    return Boolean(key) && Boolean(state.running[key]);
  }

  /** @returns the launcher's result, so callers can react to a real launch. */
  async function launchGame(game) {
    if (!game) return { success: false };
    if (isGameRunning(game)) { toast(`${game.game_name} is already running`, 'success'); return { success: true, alreadyRunning: true }; }
    let res;
    try {
      res = await api.launchGame(game);
      if (res && res.success) {
        if (res.alreadyRunning) { toast(`${game.game_name} is already running`, 'success'); return; }
        if (res.method === 'folder') toast(`Opened install folder for ${game.game_name}`, 'success');
        else if (res.method === 'steam') toast(`Launching ${game.game_name} through Steam…`, 'success');
        else if (res.method === 'greenluma') {
          toast(res.restarted
            ? `Restarted Steam with GreenLuma, launching ${game.game_name}…`
            : `Launching ${game.game_name} as owned…`, 'success');
        }
        else toast(`Launching ${game.game_name}…`, 'success');
      } else if (res && res.code === 'no-exe') {
        promptExecutablePicker(game);
      } else if (res && res.needsGreenLuma) {
        toast(res.error || 'GreenLuma is not installed in your Steam folder.', 'error');
      } else if (res && res.needsGreenLumaRunning) {
        toast(res.error || 'Start Steam through your GreenLuma injector first, then press Play again.', 'accent');
      } else {
        toast((res && res.error) || 'Could not launch this game', 'error');
      }
    } catch (e) {
      toast(`Launch failed: ${e.message}`, 'error');
      return { success: false, error: e.message };
    }
    return res || { success: false };
  }

  async function stopGame(game) {
    const key = gameKeyOf(game);
    if (!key) return;
    try {
      const res = await api.stopGame(key);
      if (!res || !res.success) toast('Could not stop the game — close it from its own window.', 'error');
    } catch (e) {
      toast(`Stop failed: ${e.message}`, 'error');
    }
  }

  // ─── Update Checking ───────────────────────────────
  function updateResultKey(game) { return game.source === 'Custom' && game.id ? `custom:${game.id}` : game.appid; }
  function canUpdateGame(game) { return game.source === 'Custom' ? Boolean(game.update_link && game.update_ready) : Boolean(game.library_path); }
  async function refreshLinkedGame(game) {
    if (game.source === 'Custom' && game.update_link && api.refreshCustomUpdates) Object.assign(game, await api.refreshCustomUpdates(game.id));
    return game;
  }
  // Only a confirmed comparison earns an update badge. Unknown stays unknown.
  function isUpdateAvailable(info) {
    if (!info) return false;
    if (info.status === 'update_available') return true;
    return false;
  }

  function gamesWithUpdates() {
    return state.games.filter(g => isUpdateAvailable(state.updateResults[updateResultKey(g)]));
  }

  /**
   * @param {{force?: boolean}} options — force skips the main process's
   *   half-hour build-id cache. Anything the user pressed a button for must
   *   force; the automatic startup pass must not.
   */
  async function checkUpdatesInBackground(options = {}) {
    // Include every game with a valid AppID — even those missing a local buildId,
    // so the update checker can still report an available public build.
    const gamesWithIds = state.games.filter(g => g.appid && g.appid !== '0');
    if (!gamesWithIds.length) return { checked: 0 };

    try {
      await Promise.all(gamesWithIds.filter(g => g.update_link).map(g => refreshLinkedGame(g)));
      const results = await api.checkAllGameUpdates(
        gamesWithIds.map(g => ({
          appid: g.appid,
          result_key: updateResultKey(g),
          buildid: g.buildid || null,
          // Lets a game with no build id still be compared, depot by depot.
          installed_manifests: g.installed_manifests || null,
        })),
        { force: Boolean(options.force) }
      );
      state.updateResults = { ...state.updateResults, ...results };
      persistUpdateResults();
      refreshUpdateBadges();
      return { checked: gamesWithIds.length, results };
    } catch (e) {
      console.error('Update check failed:', e);
      toast(`Update check failed: ${e.message}`, 'error');
      return { checked: 0, error: e.message };
    }
  }

  /** One game, forced — used by the detail view and Big Picture. */
  async function checkUpdateFor(game) {
    const appId = safeAppId(game?.appid);
    if (!appId || appId === '0') {
      toast(`${game?.game_name || 'This game'} has no AppID to check`, 'error');
      return null;
    }
    try {
      await refreshLinkedGame(game);
      const result = await api.checkGameUpdate(appId, game.buildid || null, {
        force: true,
        installedManifests: game.installed_manifests || null,
      });
      state.updateResults = { ...state.updateResults, [updateResultKey(game)]: result };
      persistUpdateResults();
      refreshUpdateBadges();
      return result;
    } catch (e) {
      toast(`Update check failed: ${e.message}`, 'error');
      return null;
    }
  }

  function persistUpdateResults() {
    try {
      api.setSetting('update_results', state.updateResults);
      api.setSetting('update_checked_at', Date.now());
    } catch (e) {
      console.error('Failed to persist update results:', e);
    }
  }

  function refreshUpdateBadges() {
    // Re-render rows to show badges
    renderHome();
    renderLibraryGrid();

    // Show updates row
    const updatable = gamesWithUpdates();
    const rowUpdates = $('#row-updates');
    if (updatable.length) {
      renderGameRow('#row-updates-scroll', updatable);
      rowUpdates.style.display = '';
    } else {
      rowUpdates.style.display = 'none';
    }

    updateUpdateAllButton();

    // Update flyout if open
    const flyout = $('#game-flyout');
    if (flyout.classList.contains('flyout-open') && state.flyoutGame) {
      renderFlyoutUpdateStatus(state.flyoutGame);
    }
  }

  function updateUpdateAllButton() {
    const btn = $('#lib-update-all-btn');
    if (!btn) return;
    // Include linked Custom installations with a valid update destination.
    const count = gamesWithUpdates().filter(canUpdateGame).length;
    if (count > 0) {
      btn.style.display = '';
      btn.textContent = `⬆ Update All (${count})`;
    } else {
      btn.style.display = 'none';
    }
  }

  // ─── Library Page ───────────────────────────────────
  function setupLibraryPage() {
    $('#lib-scan-btn').onclick = () => scanAndRender();
    $('#lib-add-game-btn').onclick = () => showAddCustomGameModal();
    $('#lib-check-updates-btn').onclick = async () => {
      const btn = $('#lib-check-updates-btn');
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳ Checking…';
      toast('Checking for updates...');
      // Forced: this is the button someone presses *because* they think
      // something changed, so it must ask steamcmd.net again rather than
      // replaying a cached answer.
      const { checked, error, results } = await checkUpdatesInBackground({ force: true });
      btn.disabled = false;
      btn.textContent = original;
      if (error) return;
      if (!checked) { toast('No games with a Steam AppID to check', 'error'); return; }
      const updates = gamesWithUpdates().length;
      const unknown = Object.values(results || {}).filter(info => !['up_to_date', 'update_available'].includes(info.status)).length;
      toast(
        updates > 0
          ? `${updates} update(s) available${unknown ? ` · ${unknown} undetermined` : ''}`
          : unknown ? `No confirmed update · ${unknown} build(s) could not be compared` : `All ${checked} game${checked === 1 ? '' : 's'} are up to date ✓`,
        updates > 0 ? '' : 'success',
      );
    };
    const updateAllBtn = $('#lib-update-all-btn');
    if (updateAllBtn) updateAllBtn.onclick = () => updateAllGames();
    const favBtn = $('#lib-fav-toggle');
    if (favBtn) {
      favBtn.onclick = () => setLibraryView(state.libraryView === 'favorites' ? 'all' : 'favorites');
    }

    // The sparkline is sized from CSS, so it must be repainted on any relayout.
    window.addEventListener('resize', () => drawSpeedChart());
    window.addEventListener('librarian:redraw', () => drawSpeedChart());
    // Debounced so typing in a 500-game library doesn't rebuild the grid per keystroke.
    $('#lib-filter').oninput = () => {
      clearTimeout(libraryFilterTimer);
      $('#lib-clear-filter').hidden = !$('#lib-filter').value;
      libraryFilterTimer = setTimeout(() => renderLibraryGrid(), 110);
    };
    $('#lib-filter').addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('#lib-filter').value) {
        e.stopPropagation();
        e.preventDefault();
        clearLibraryFilter();
      }
    });
    $('#lib-clear-filter').onclick = clearLibraryFilter;
    $('#lib-page-prev').onclick = () => changeLibraryPage(-1);
    $('#lib-page-next').onclick = () => changeLibraryPage(1);
    $('#lib-grid').addEventListener('click', event => {
      if (event.target.closest('[data-clear-library-filter]')) clearLibraryFilter();
    });

    const sortSel = $('#lib-sort');
    if (sortSel) {
      state.librarySort = state.settings.library_sort || state.librarySort;
      sortSel.value = state.librarySort;
      sortSel.onchange = () => {
        state.librarySort = sortSel.value;
        api.setSetting('library_sort', state.librarySort).catch(() => {});
        renderLibraryGrid();
      };
    }
  }

  function sortGames(list) {
    const arr = [...list];
    switch (state.librarySort) {
      case 'recent':
        return arr.sort((a, b) => (b.last_played || 0) - (a.last_played || 0));
      case 'playtime':
        return arr.sort((a, b) => (b.playtime_seconds || 0) - (a.playtime_seconds || 0));
      case 'size':
        return arr.sort((a, b) => (b.size_on_disk || 0) - (a.size_on_disk || 0));
      case 'added':
        return arr.sort((a, b) => (b.first_seen || 0) - (a.first_seen || 0) || (b.last_played || 0) - (a.last_played || 0));
      case 'name':
      default:
        return arr.sort((a, b) => (a.game_name || '').localeCompare(b.game_name || ''));
    }
  }

  function setLibraryView(view, collectionName = null) {
    if (view === 'collection' && collectionName) {
      state.libraryView = 'collection';
      state.activeCollection = collectionName;
    } else {
      state.libraryView = view === 'favorites' ? 'favorites' : 'all';
      state.activeCollection = null;
    }
    const favBtn = $('#lib-fav-toggle');
    if (favBtn) {
      favBtn.classList.toggle('active', state.libraryView === 'favorites');
      favBtn.setAttribute('aria-pressed', String(state.libraryView === 'favorites'));
    }
    const heading = $('#page-library .page-heading');
    if (heading) {
      heading.textContent = state.libraryView === 'collection'
        ? state.activeCollection
        : state.libraryView === 'favorites' ? 'Favorites' : 'Library';
    }
    navigateTo('library');
    renderLibraryGrid();
    emit('libraryview', { view: state.libraryView, collection: state.activeCollection });
  }

  async function updateAllGames() {
    const updatable = gamesWithUpdates().filter(canUpdateGame);
    if (!updatable.length) { toast('No updates to queue', 'success'); return; }
    toast(`Queueing ${updatable.length} update(s)…`);
    for (const game of updatable) {
      if (hasQueuedJobForApp(game.appid, 'update', game.source === 'Custom' ? game.id : null)) continue;
      await queueGameUpdate(game, { silent: true });
    }
  }

  let libraryPage = 0;
  let libraryPageCount = 1;
  let libraryFilterTimer = null;
  let libraryCountTimer = null;
  let libraryQuery = '';
  const LIBRARY_PAGE_SIZE = 160;
  function clearLibraryFilter() {
    clearTimeout(libraryFilterTimer);
    $('#lib-filter').value = '';
    renderLibraryGrid();
    $('#lib-filter').focus();
  }
  function changeLibraryPage(delta) {
    libraryPage = Math.max(0, Math.min(libraryPageCount - 1, libraryPage + delta));
    renderLibraryGrid();
    const grid = $('#lib-grid');
    grid.scrollTop = 0;
    grid.querySelector('.game-tile')?.focus({ preventScroll: true });
  }
  function renderLibraryGrid() {
    const grid = $('#lib-grid');
    const filter = ($('#lib-filter')?.value || '').trim();
    const query = [filter, state.librarySort, state.libraryView, state.activeCollection].join('|');
    if (query !== libraryQuery) { libraryPage = 0; libraryQuery = query; grid.scrollTop = 0; }
    $('#lib-clear-filter').hidden = !$('#lib-filter').value;

    let pool = state.games;
    if (state.libraryView === 'favorites') {
      pool = pool.filter(g => isFavorite(g));
    } else if (state.libraryView === 'collection' && state.activeCollection) {
      const members = new Set((state.settings.collections || {})[state.activeCollection] || []);
      pool = pool.filter(g => members.has(favKey(g)));
    }

    // Fuzzy match keeps typos and abbreviations working ("dscvry" → "Discovery").
    let entries;
    if (filter) {
      entries = [];
      for (const g of pool) {
        const match = fuzzyMatch(g.game_name, filter);
        if (match) entries.push({ game: g, match });
      }
      entries.sort((a, b) => b.match.score - a.match.score);
    } else {
      entries = sortGames(pool).map(g => ({ game: g, match: null }));
    }

    const viewLabel = state.libraryView === 'favorites' ? 'favorite'
      : state.libraryView === 'collection' ? 'in collection' : 'game';
    const countEl = $('#lib-count');
    const countText = state.libraryView === 'collection'
      ? `${entries.length} ${viewLabel}`
      : `${entries.length} ${viewLabel}${entries.length === 1 ? '' : 's'}`;
    if (countEl.textContent !== countText) {
      countEl.textContent = countText;
      countEl.classList.add('flash');
      clearTimeout(libraryCountTimer);
      libraryCountTimer = setTimeout(() => countEl.classList.remove('flash'), 350);
    }
    libraryPageCount = Math.max(1, Math.ceil(entries.length / LIBRARY_PAGE_SIZE));
    libraryPage = Math.min(libraryPage, libraryPageCount - 1);
    const pagination = $('#lib-pagination');
    pagination.hidden = libraryPageCount <= 1;
    if (!pagination.hidden) {
      const label = `Page ${libraryPage + 1} / ${libraryPageCount}`;
      const range = `${libraryPage * LIBRARY_PAGE_SIZE + 1}–${Math.min((libraryPage + 1) * LIBRARY_PAGE_SIZE, entries.length)} of ${entries.length}`;
      if ($('#lib-page-label').textContent !== label) $('#lib-page-label').textContent = label;
      if ($('#lib-page-range').textContent !== range) $('#lib-page-range').textContent = range;
      $('#lib-page-prev').disabled = libraryPage === 0;
      $('#lib-page-next').disabled = libraryPage === libraryPageCount - 1;
    }

    if (!entries.length) {
      const msg = filter && state.games.length
        ? `No games match “${esc(filter)}”.`
        : state.libraryView === 'favorites'
        ? 'No favorites yet. Tap the ☆ on any game to add it here.'
        : state.libraryView === 'collection'
          ? `Nothing in “${esc(state.activeCollection || '')}” yet. Right-click a game to add it.`
          : (state.games.length
            ? `No games match “${esc(filter)}”.`
            : 'No games found. Click Scan to search your drives.');
      grid.innerHTML = `<div class="empty-state-centered library-empty"><p>${msg}</p>${filter ? '<button class="xbox-btn xbox-btn-secondary" data-clear-library-filter>Clear filter</button>' : ''}</div>`;
      emit('rendered', { container: grid, count: 0, kind: 'grid' });
      return;
    }

    const visible = entries.slice(libraryPage * LIBRARY_PAGE_SIZE, (libraryPage + 1) * LIBRARY_PAGE_SIZE);
    const existing = new Map([...grid.querySelectorAll(':scope > .game-tile')].map(tile => [tile.dataset.installKey, tile]));
    const wanted = [];
    for (const entry of visible) {
      const game = entry.game;
      const key = gameKeyOf(game) + '|' + (game.install_path || '');
      const signature = JSON.stringify([game, entry.match?.positions, state.updateResults[updateResultKey(game)], isGameRunning(game)]);
      let tile = existing.get(key);
      if (!tile || tile.dataset.signature !== signature) {
        tile = createGameTile(game, { art: 'portrait', highlightPositions: entry.match?.positions });
        tile.dataset.installKey = key; tile.dataset.signature = signature;
      }
      const button = tile.querySelector('.tile-fav-btn');
      const favorite = isFavorite(game);
      button.classList.toggle('is-fav', favorite);
      const favoriteText = favorite ? '★' : '☆';
      const favoriteTitle = favorite ? 'Remove from favorites' : 'Add to favorites';
      if (button.textContent !== favoriteText) button.textContent = favoriteText;
      if (button.title !== favoriteTitle) button.title = favoriteTitle;
      if (button.getAttribute('aria-pressed') !== String(favorite)) button.setAttribute('aria-pressed', String(favorite));
      wanted.push(tile);
    }
    const keep = new Set(wanted);
    for (const node of [...grid.children]) if (!keep.has(node)) node.remove();
    wanted.forEach((tile, index) => { if (grid.children[index] !== tile) grid.insertBefore(tile, grid.children[index] || null); });
    emit('rendered', { container: grid, count: entries.length, kind: 'grid' });
  }

  // ─── Immersive Game Detail ──────────────────────────
  function openFlyout(game) {
    state.flyoutGame = game;
    const flyout = $('#game-flyout');
    flyout.classList.remove('flyout-closed');
    flyout.classList.add('flyout-open');
    window.LibrarianDialogs.enter(flyout, closeFlyout, 'flyout-title');

    // A pending teardown from a close the user immediately reversed would
    // otherwise fire mid-open and stop the trailer this call is about to start.
    if (flyoutTeardown) { clearTimeout(flyoutTeardown); flyoutTeardown = null; }
    stopFlyoutTrailer();

    const heroImg = getGameBannerUrl(game, 'hero');
    const headerImg = getGameBannerUrl(game, 'header');
    const heroEl = $('#flyout-hero-img');
    heroEl.style.display = '';
    heroEl.onerror = function () {
      this.onerror = null;
      // Fall back to the landscape capsule, and if that is missing too, look up
      // the app's real art URLs before giving up.
      attachArtFallback(heroEl, game, 'hero');
      this.src = headerImg;
    };
    heroEl.src = heroImg || headerImg;

    renderFlyoutPoster(game);

    const logo = $('#flyout-logo');
    logo.classList.add('hidden');
    logo.src = '';

    $('#flyout-title').textContent = game.game_name || 'Unknown';
    renderFlyoutMeta(game);
    renderFlyoutUpdateStatus(game);
    renderFlyoutAchievements(game);
    renderFlyoutPlaytime(game);
    renderFlyoutActions(game);
    renderFlyoutDetails(game);
    window.LibrarianDlssg?.show(game);

    $('#flyout-desc').innerHTML = '<span class="desc-empty">Fetching catalog entry…</span>';
    $('#flyout-tags').innerHTML = '';
    $('#flyout-media').innerHTML = '<div class="media-empty">Loading media…</div>';
    $('#flyout-patch').innerHTML = '';
    $('#flyout-shots').innerHTML = '';
    setTabCount('#dtab-count-media', 0);
    setTabCount('#dtab-count-patch', 0);
    setTabCount('#dtab-count-ach', 0);

    setActiveTab('overview');
    setupFlyoutTabs();

    // Scroll the detail back to the top for each open. Repeated on the next tick
    // because the description, poster and patch notes all arrive asynchronously
    // and grow the panel after this point.
    const rail = $('#flyout-rail');
    if (rail) rail.scrollTop = 0;

    const panel = $('#flyout-panel');
    if (panel) {
      panel.scrollTop = 0;
      setTimeout(() => { if (state.flyoutGame === game) panel.scrollTop = 0; }, 0);
      setTimeout(() => { if (state.flyoutGame === game) panel.scrollTop = 0; }, 120);
    }

    $('#flyout-close').onclick = closeFlyout;
    $('#flyout-backdrop').onclick = closeFlyout;
    renderFlyoutNav(game);

    loadFlyoutMedia(game);
    loadFlyoutPatchNotes(game);
    emit('flyout', { open: true, game });
  }

  /**
   * The set the detail view steps through with ← / →. Mirrors whatever the
   * user is currently looking at, so browsing a filtered library stays inside
   * that filter.
   */
  function flyoutSiblings() {
    const visible = [...$$('#page-library.active #lib-grid .game-tile, .page.active .row-scroll .game-tile')]
      .map(el => el.dataset.key)
      .filter(Boolean);
    const order = visible.length ? visible : state.games.map(g => gameKeyOf(g));
    const seen = new Set();
    const keys = order.filter(k => k && !seen.has(k) && seen.add(k));
    return keys.map(k => state.games.find(g => gameKeyOf(g) === k)).filter(Boolean);
  }

  function renderFlyoutNav(game) {
    const prev = $('#flyout-prev');
    const next = $('#flyout-next');
    if (!prev || !next) return;
    const siblings = flyoutSiblings();
    const index = siblings.findIndex(g => gameKeyOf(g) === gameKeyOf(game));
    prev.disabled = index <= 0;
    next.disabled = index === -1 || index >= siblings.length - 1;
    prev.onclick = () => { if (index > 0) openFlyout(siblings[index - 1]); };
    next.onclick = () => { if (index !== -1 && index < siblings.length - 1) openFlyout(siblings[index + 1]); };
  }

  function stepFlyout(delta) {
    if (!state.flyoutGame) return;
    const siblings = flyoutSiblings();
    const index = siblings.findIndex(g => gameKeyOf(g) === gameKeyOf(state.flyoutGame));
    const target = siblings[index + delta];
    if (target) openFlyout(target);
  }

  /**
   * Paint the vertical box art beside the details.
   * Same resolution chain as the download view: 600×900 poster, else the
   * landscape capsule letterboxed over a blurred copy of itself, else generated
   * cover art — so the slot is never empty.
   */
  function renderFlyoutPoster(game) {
    const host = $('#flyout-poster-art');
    if (!host) return;

    const drawGenerated = () => { host.innerHTML = artFallbackHtml(game.game_name); };
    const drawPortrait = (url) => { host.innerHTML = `<img src="${esc(url)}" alt="">`; };
    const drawLandscape = (url) => {
      host.innerHTML = `
        <div class="poster-blur" style="background-image:url(${esc(url)})"></div>
        <img class="poster-fit" src="${esc(url)}" alt="">`;
    };

    const probe = (src) => new Promise((resolve, reject) => {
      if (!src) { reject(new Error('no url')); return; }
      const img = new Image();
      img.onload = () => (img.naturalWidth > 1 ? resolve(src) : reject(new Error('empty')));
      img.onerror = () => reject(new Error('failed'));
      img.src = src;
    });

    // Custom art wins outright — the user picked it deliberately.
    if (game.banner_path || game.banner_url) {
      const custom = getGameBannerUrl(game, 'header');
      probe(custom).then(drawLandscape).catch(drawGenerated);
      return;
    }

    drawGenerated();
    const appId = safeAppId(game.appid);
    if (!appId || appId === '0') return;

    // Its own counter: loadFlyoutMedia bumps flyoutMediaToken *after* this runs,
    // so sharing it would make every probe look superseded and the real cover
    // would never replace the generated plate.
    const token = ++state.flyoutPosterToken;
    const stillCurrent = () => state.flyoutGame === game && state.flyoutPosterToken === token;

    probe(steamPortraitUrl(appId))
      .then((url) => { if (stillCurrent()) drawPortrait(url); })
      .catch(() => probe(steamHeaderUrl(appId))
        .then((url) => { if (stillCurrent()) drawLandscape(url); })
        .catch(() => resolveArtFor(appId).then((art) => {
          if (!stillCurrent() || !art) return;
          if (art.portrait) drawPortrait(art.portrait);
          else if (art.header || art.hero) drawLandscape(art.header || art.hero);
        }).catch(() => {})));
  }

  function renderFlyoutMeta(game) {
    const chips = [];
    if (game.appid && game.appid !== '0') chips.push(`AppID ${esc(game.appid)}`);
    if (game.size_on_disk) chips.push(formatSize(game.size_on_disk));
    if (game.buildid) chips.push(`Build ${esc(game.buildid)}`);
    chips.push(game.source === 'Custom' ? 'Custom' : 'Steam');
    // Not "last played": the ledger beside the title answers that question
    // already, and a chip that repeats the cell next to it is noise.
    $('#flyout-meta').innerHTML = chips.map(c => `<span class="meta-chip">${c}</span>`).join('');
  }

  function renderFlyoutPlaytime(game) {
    const el = $('#flyout-playtime');
    if (!el) return;
    const running = isGameRunning(game);
    const total = game.playtime_seconds || 0;
    const cells = [
      { num: total > 0 ? formatPlaytime(total) : '—', label: 'Playtime', live: running },
      { num: game.launch_count ? String(game.launch_count) : '—', label: 'Sessions' },
      { num: game.last_played ? formatRelative(game.last_played) : 'Never', label: 'Last played' },
    ];
    el.innerHTML = cells.map(c =>
      `<div class="pt-cell"><span class="pt-num${c.live ? ' live' : ''}">${esc(c.num)}</span><span class="pt-label">${c.label}</span></div>`
    ).join('');
  }

  /**
   * Icons for the detail action row.
   *
   * These were emoji, and half of them (folder, wrench, spanner, the upward
   * arrow) carry Emoji_Presentation, which means Windows renders them in full
   * colour: three saturated pictograms sitting in a row of brass-on-paper text
   * buttons next to four monochrome glyphs that happen not to. Drawn instead,
   * in the same 20x20 solid set the top bar and the sidebar already use, so the
   * row reads as one control rather than as whatever each font decided.
   */
  const ACT_ICONS = {
    star: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M9.05 2.93c.3-.92 1.6-.92 1.9 0l1.07 3.29a1 1 0 00.95.69h3.46c.97 0 1.37 1.24.59 1.81l-2.8 2.03a1 1 0 00-.37 1.12l1.07 3.29c.3.92-.75 1.69-1.54 1.12l-2.8-2.04a1 1 0 00-1.17 0l-2.8 2.04c-.79.57-1.84-.2-1.54-1.12l1.07-3.29a1 1 0 00-.37-1.12l-2.8-2.03c-.78-.57-.38-1.81.59-1.81h3.46a1 1 0 00.95-.69l1.07-3.29z"/></svg>',
    folder: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M2 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>',
    cog: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.53 1.53 0 01-2.29.95c-1.37-.84-2.94.73-2.1 2.1a1.53 1.53 0 01-.95 2.29c-1.56.38-1.56 2.6 0 2.98a1.53 1.53 0 01.95 2.29c-.84 1.37.73 2.94 2.1 2.1a1.53 1.53 0 012.29.95c.38 1.56 2.6 1.56 2.98 0a1.53 1.53 0 012.29-.95c1.37.84 2.94-.73 2.1-2.1a1.53 1.53 0 01.95-2.29c1.56-.38 1.56-2.6 0-2.98a1.53 1.53 0 01-.95-2.29c.84-1.37-.73-2.94-2.1-2.1a1.53 1.53 0 01-2.29-.95zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/></svg>',
    refresh: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 2a1 1 0 011 1v2.1a7 7 0 0111.6 2.57 1 1 0 11-1.89.66A5 5 0 006 7h3a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.01 9.06a1 1 0 011.27.61A5 5 0 0014 13h-3a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.1a7 7 0 01-11.6-2.57 1 1 0 01.61-1.27z" clip-rule="evenodd"/></svg>',
    up: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.29 9.71a1 1 0 010-1.42l4-4a1 1 0 011.42 0l4 4a1 1 0 01-1.42 1.42L11 7.41V15a1 1 0 11-2 0V7.41L6.71 9.71a1 1 0 01-1.42 0z" clip-rule="evenodd"/></svg>',
    shield: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M2.17 5A11.95 11.95 0 0010 1.94 11.95 11.95 0 0017.83 5c.11.65.17 1.32.17 2 0 5.23-3.34 9.67-8 11.32C5.34 16.67 2 12.23 2 7c0-.68.06-1.35.17-2zm11.54 3.71a1 1 0 00-1.42-1.42L9 10.59 7.71 9.29a1 1 0 00-1.42 1.42l2 2a1 1 0 001.42 0l4-4z" clip-rule="evenodd"/></svg>',
    key: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 8a6 6 0 01-7.74 5.74L10 14l-1 1-1 1H6v2H2v-4l4.26-4.26A6 6 0 1118 8zm-6-4a1 1 0 100 2 2 2 0 012 2 1 1 0 102 0 4 4 0 00-4-4z" clip-rule="evenodd"/></svg>',
    pencil: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M13.59 3.59a2 2 0 112.82 2.82l-.79.8-2.83-2.83.8-.79zM11.38 5.79L3 14.17V17h2.83l8.38-8.38-2.83-2.83z"/></svg>',
    cross: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.29 4.29a1 1 0 011.42 0L10 8.59l4.29-4.3a1 1 0 111.42 1.42L11.41 10l4.3 4.29a1 1 0 01-1.42 1.42L10 11.41l-4.29 4.3a1 1 0 01-1.42-1.42L8.59 10l-4.3-4.29a1 1 0 010-1.42z" clip-rule="evenodd"/></svg>',
    globe: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 2a8 8 0 100 16 8 8 0 000-16zM3.6 9.25h2.5c.08-1.6.42-3.06.95-4.2A6.5 6.5 0 003.6 9.25zm4 0h4.8c-.1-1.72-.5-3.2-1.03-4.2C10.98 4.3 10.5 3.6 10 3.6s-.98.7-1.37 1.45c-.53 1-.93 2.48-1.03 4.2zm6.3 0h2.5a6.5 6.5 0 00-3.45-4.2c.53 1.14.87 2.6.95 4.2zm2.5 1.5h-2.5c-.08 1.6-.42 3.06-.95 4.2a6.5 6.5 0 003.45-4.2zm-4 0H7.6c.1 1.72.5 3.2 1.03 4.2.39.75.87 1.45 1.37 1.45s.98-.7 1.37-1.45c.53-1 .93-2.48 1.03-4.2zm-6.3 0H3.6a6.5 6.5 0 003.45 4.2c-.53-1.14-.87-2.6-.95-4.2z" clip-rule="evenodd"/></svg>',
  };

  function renderFlyoutActions(game) {
    if (state.flyoutGame !== game) return;
    const isCustom = game.source === 'Custom';
    const fav = isFavorite(game);
    const running = isGameRunning(game);
    // The Play control lives under the poster, so it reads as the one thing this
    // panel is for; everything else stays in the secondary row on the right.
    const primaryEl = $('#flyout-primary');
    if (primaryEl) {
      // An update is worth offering right where the eye already is, next to
      // Play — finding it in the quiet row means knowing to look for it. Play
      // stays primary: an update is available, not required, and nobody should
      // have to update before they can start the game.
      const updatable = canUpdateGame(game) && !running && isUpdateAvailable(state.updateResults[updateResultKey(game)]);
      // ■ and ↑ rather than ⏹ and ⬆: the latter pair are emoji by default and
      // arrive as colour pictograms inside a brass button.
      primaryEl.innerHTML = running
        ? '<button class="xbox-btn xbox-btn-secondary" id="flyout-stop">■ Stop</button>'
        : '<button class="xbox-btn xbox-btn-primary" id="flyout-play">▶ Play</button>'
          + (updatable ? '<button class="xbox-btn xbox-btn-secondary has-update" id="flyout-update-primary">↑ Update</button>' : '');
    }

    // Everyday actions read as one quiet cluster; the irreversible one is pushed
    // to the far end so it can't be hit by muscle memory.
    const act = (id, icon, label) =>
      `<button class="flyout-act" id="${id}"><span class="fa-ico">${icon}</span>${label}</button>`;

    const quiet = [
      act('flyout-fav-btn', ACT_ICONS.star, fav ? 'Favorited' : 'Favorite'),
      act('flyout-open-folder', ACT_ICONS.folder, 'Folder'),
      act('flyout-choose-exe', ACT_ICONS.cog, 'Executable'),
      act('flyout-update-check', ACT_ICONS.refresh, 'Check update'),
      canUpdateGame(game) ? act('flyout-update-now', ACT_ICONS.up, 'Update') : '',
      !isCustom ? act('flyout-repair-now', ACT_ICONS.shield, 'Verify') : '',
      act('flyout-crack-btn', ACT_ICONS.key, 'Crack'),
      // The second source: a member's release for this exact build, placed
      // over the install. Only for Denuvo titles, and only when the tools
      // are present; every other game's panel is exactly what it was.
      state.csrin.available && game.install_path && state.denuvo[safeAppId(game.appid)] === true
        ? act('flyout-csrin-btn', ACT_ICONS.globe, 'CS.RIN.RU') : '',
      isCustom ? act('flyout-edit-btn', ACT_ICONS.pencil, 'Edit') : '',
      isCustom ? act('flyout-link-updates', ACT_ICONS.refresh, game.update_link ? 'Update source' : 'Link updates') : '',
    ].filter(Boolean).join('');

    const danger = isCustom
      ? `<button class="flyout-act danger" id="flyout-remove-custom"><span class="fa-ico">${ACT_ICONS.cross}</span>Remove</button>`
      : `<button class="flyout-act danger" id="flyout-uninstall"><span class="fa-ico">${ACT_ICONS.cross}</span>Uninstall</button>`;

    $('#flyout-actions').innerHTML =
      `<div class="fa-group">${quiet}</div><div class="fa-group fa-danger">${danger}</div>`;
    if (fav) $('#flyout-fav-btn')?.classList.add('is-fav');

    const playBtn = $('#flyout-play');
    if (playBtn) playBtn.onclick = () => launchGame(game);
    // Preparing an update is not instant: the update check, and for a Denuvo
    // title a forum search, run before anything is queued. The button that
    // was pressed spins until the Downloads page takes over.
    const updPrimary = $('#flyout-update-primary');
    if (updPrimary) updPrimary.onclick = () => withBusy(updPrimary, () => queueGameUpdate(game));
    renderOnlineMode(game);
    renderPeakMod(game);
    renderPhotonMod(game);
    renderDlcPanel(game);
    renderEmuCompat(game);
    const stopBtn = $('#flyout-stop');
    if (stopBtn) stopBtn.onclick = () => stopGame(game);
    $('#flyout-fav-btn').onclick = () => toggleFavorite(game);
    $('#flyout-open-folder').onclick = () => openPath(game.install_path);
    $('#flyout-choose-exe').onclick = () => promptExecutablePicker(game);
    $('#flyout-update-check').onclick = async () => {
      if (!game.appid || game.appid === '0' || game.appid === '') { toast('No AppID — cannot check', 'error'); return; }
      await ensureUpdateInfo(game);
    };
    const upd = $('#flyout-update-now'); if (upd) upd.onclick = () => withBusy(upd, () => queueGameUpdate(game));
    if (!isCustom) {
      const rep = $('#flyout-repair-now'); if (rep) rep.onclick = () => queueGameRepair(game);
    }
    $('#flyout-crack-btn').onclick = () => { closeFlyout(); navigateTo('crack'); };
    const csrinBtn = $('#flyout-csrin-btn');
    if (csrinBtn) csrinBtn.onclick = () => openCsrinPicker(game.appid, game.game_name, { game });
    // Not known yet whether this is a Denuvo title: find out, and if it is,
    // draw the actions again so the button appears — once, for this game.
    if (!csrinBtn && state.csrin.available && game.install_path && state.denuvo[safeAppId(game.appid)] === undefined) {
      ensureDenuvoInfo(game).then((denuvo) => {
        if (denuvo && state.flyoutGame === game && !$('#flyout-csrin-btn')) renderFlyoutActions(game);
      }).catch(() => {});
    }
    if (isCustom) {
      $('#flyout-link-updates').onclick = () => showCustomUpdateAssociation(game);
      $('#flyout-edit-btn').onclick = () => { closeFlyout(); showEditCustomGameModal(game); };
      $('#flyout-remove-custom').onclick = async () => {
        const msg = await api.getUninstallMessage(game);
        if (await showConfirm('Remove from Library', msg, { confirmLabel: 'Remove' })) {
          await api.removeCustomGame(game.id);
          toast(`${game.game_name} removed from library`);
          closeFlyout();
          scanAndRender();
        }
      };
    } else {
      $('#flyout-uninstall').onclick = async () => {
        const msg = await api.getUninstallMessage(game);
        if (await showConfirm('Uninstall Game', msg, { confirmLabel: 'Uninstall' })) {
          const r = await api.uninstallGame(game);
          if (r.success) { toast(`${game.game_name} uninstalled`); closeFlyout(); scanAndRender(); }
          else toast(`Failed: ${r.error}`, 'error');
        }
      };
    }
  }

  function renderFlyoutDetails(game, media) {
    const rows = [];
    const add = (label, value) => { if (value) rows.push(`<div class="detail-row"><span class="detail-label">${label}</span><span class="detail-value">${esc(value)}</span></div>`); };
    if (media) {
      add('Developer', (media.developers || []).join(', '));
      add('Publisher', (media.publishers || []).join(', '));
      add('Released', media.release_date);
      if (media.metacritic) add('Metacritic', String(media.metacritic.score));
    }
    add('AppID', game.appid && game.appid !== '0' ? game.appid : '');
    add('Installed build', game.buildid || (game.update_link ? 'Unknown' : ''));
    add('Build evidence', game.build_source === 'manifest' ? 'Local app manifest' : game.build_source === 'declared' ? 'Entered manually — files not verified' : game.update_link ? 'No local version record' : '');
    add('Update branch', game.update_branch);
    add('Update association', game.update_error);
    add('Size on disk', game.size_on_disk ? formatSize(game.size_on_disk) : '');
    add('Depots', Array.isArray(game.installed_depots) && game.installed_depots.length ? game.installed_depots.join(', ') : '');
    add('Executable', game.executable);
    add('Install path', game.install_path);
    add('Library', game.library_path);
    add('Source', game.source);
    $('#flyout-details').innerHTML = rows.join('') || '<div class="empty-state-small">No catalog data.</div>';
  }

  function setupFlyoutTabs() {
    $$('#flyout-tabs .dtab').forEach(tab => {
      tab.onclick = () => setActiveTab(tab.dataset.tab);
    });
  }

  // ─── Patch notes ────────────────────────────────────
  /**
   * Steam announcements for this app, newest first, with changelog posts badged.
   * Bodies arrive from the main process already flattened to plain text and are
   * inserted as text, never markup — the feed is third-party content.
   */
  async function loadFlyoutPatchNotes(game) {
    const host = $('#flyout-patch');
    if (!host) return;

    const appId = safeAppId(game.appid);
    if (!appId || appId === '0') {
      host.innerHTML = '<div class="empty-state-small">No AppID, so there are no store announcements to read.</div>';
      return;
    }
    if (!api.getPatchNotes) {
      host.innerHTML = '<div class="empty-state-small">Patch notes are unavailable in this build.</div>';
      return;
    }

    host.innerHTML = '<div class="loading-state"><div class="spinner"></div>Fetching patch notes…</div>';
    const token = ++state.patchNotesToken;

    let result;
    try {
      result = await api.getPatchNotes(appId);
    } catch (e) {
      result = { items: [], error: e.message };
    }
    // Superseded by another game, or the panel closed.
    if (token !== state.patchNotesToken || state.flyoutGame !== game) return;

    if (result.error) {
      host.innerHTML = `<div class="empty-state-small">Could not load patch notes — ${esc(result.error)}</div>`;
      return;
    }
    if (!result.items.length) {
      host.innerHTML = '<div class="empty-state-small">This game has no published announcements.</div>';
      return;
    }

    setTabCount('#dtab-count-patch', result.items.length);
    const patchCount = result.items.filter(i => i.isPatch).length;
    const summary = patchCount
      ? `${patchCount} update${patchCount === 1 ? '' : 's'} of ${result.items.length} recent post${result.items.length === 1 ? '' : 's'}`
      : `${result.items.length} recent announcement${result.items.length === 1 ? '' : 's'}`;

    host.innerHTML = `<div class="patch-summary">${esc(summary)}</div>` + result.items.map((item, i) => `
      <article class="patch-item${i === 0 ? ' open' : ''}">
        <button class="patch-head" type="button" aria-expanded="${i === 0}">
          <span class="patch-caret">▸</span>
          <span class="patch-title">${esc(item.title)}</span>
          ${item.isPatch ? '<span class="patch-badge">Patch</span>' : ''}
          <span class="patch-date">${esc(item.date ? formatRelative(item.date) : '')}</span>
        </button>
        <div class="patch-body">
          <div class="patch-text">${esc(item.body) || '<span class="desc-empty">No details in this post.</span>'}</div>
          ${item.url ? `<button class="patch-link" data-url="${esc(item.url)}">Read on Steam ↗</button>` : ''}
        </div>
      </article>`).join('');

    host.querySelectorAll('.patch-head').forEach((head) => {
      head.onclick = () => {
        const item = head.closest('.patch-item');
        const open = item.classList.toggle('open');
        head.setAttribute('aria-expanded', String(open));
      };
    });
    host.querySelectorAll('.patch-link').forEach((btn) => {
      btn.onclick = () => api.openExternal(btn.dataset.url);
    });
  }

  function setActiveTab(name) {
    $$('#flyout-tabs .dtab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $$('.dtab-panel').forEach(p => p.classList.toggle('active', p.id === `flyout-tab-${name}`));
    // The panel is the scroller now, not the flyout, so switching tabs — or
    // stepping to the next game — has to put the reader back at the top. A tab
    // that opens forty lines into someone else's patch notes is a bug.
    const panel = $(`#flyout-tab-${name}`);
    if (panel) panel.scrollTop = 0;
  }

  async function loadFlyoutMedia(game) {
    const token = ++state.flyoutMediaToken;
    const appId = safeAppId(game.appid);
    if (!appId || appId === '0') {
      $('#flyout-desc').innerHTML = game.source === 'Custom'
        ? '<span class="desc-empty">Custom game — no store entry. Add an AppID to pull artwork, trailers and details.</span>'
        : '<span class="desc-empty">No store information available for this game.</span>';
      $('#flyout-media').innerHTML = '<div class="media-empty">No media available.</div>';
      renderFlyoutDetails(game);
      return;
    }

    let media;
    try { media = await api.getGameMedia(appId); } catch { media = null; }
    if (token !== state.flyoutMediaToken || state.flyoutGame !== game) return; // superseded
    if (!media) { $('#flyout-desc').innerHTML = '<span class="desc-empty">Could not load store information.</span>'; return; }

    // Description
    const desc = media.about || media.short_description;
    $('#flyout-desc').innerHTML = desc ? esc(desc) : '<span class="desc-empty">No description available.</span>';

    // Genres / tags
    const tags = [...(media.genres || [])];
    $('#flyout-tags').innerHTML = tags.map(t => `<span class="genre-tag">${esc(t)}</span>`).join('');

    // Wordmark logo over the hero
    if (media.logo_url) {
      const logo = $('#flyout-logo');
      logo.onload = () => { if (state.flyoutGame === game) logo.classList.remove('hidden'); };
      logo.onerror = () => logo.classList.add('hidden');
      logo.src = media.logo_url;
    }

    // Refresh the catalog record with store metadata.
    renderFlyoutDetails(game, media);
    renderFlyoutMeta(game);

    // Media tab: trailers + screenshots
    renderFlyoutMedia(media);
    setTabCount('#dtab-count-media', (media.movies || []).length + (media.screenshots || []).length);
    renderFlyoutShots(media);

    // Autoplay the first trailer muted behind the hero.
    if (media.movies && media.movies.length) {
      playFlyoutTrailer(media.movies[0]);
    }
  }

  /** Small badge on a detail tab, hidden when there is nothing to count. */
  function setTabCount(selector, count) {
    const el = $(selector);
    if (!el) return;
    el.textContent = String(count);
    el.classList.toggle('hidden', !count);
  }

  /**
   * A strip of screenshots under the description, so Overview shows the game
   * rather than only describing it. Full set stays on the Media tab.
   */
  function renderFlyoutShots(media) {
    const host = $('#flyout-shots');
    if (!host) return;
    const shots = (media?.screenshots || []).slice(0, 6);
    if (!shots.length) { host.innerHTML = ''; return; }

    host.innerHTML = shots.map(shot => `
      <button class="shot" data-full="${esc(shot.full)}" aria-label="View screenshot">
        <img src="${esc(shot.thumbnail || shot.full)}" loading="lazy" alt="" data-hide-on-error="shot">
      </button>`).join('');

    host.querySelectorAll('.shot').forEach((btn) => {
      btn.onclick = () => openLightbox(btn.dataset.full);
    });
  }

  function renderFlyoutMedia(media) {
    const container = $('#flyout-media');
    if (!container) return;
    const parts = [];
    for (const mv of (media.movies || [])) {
      // The whole record travels with the plate: which URL is playable depends
      // on whether hls.js is available, and that is trailer.js's decision.
      parts.push(`<div class="plate is-video" data-movie="${esc(JSON.stringify(mv))}" tabindex="0" role="button" aria-label="Play trailer">
        <img src="${esc(mv.thumbnail)}" loading="lazy" data-hide-on-error="">
      </div>`);
    }
    for (const sc of (media.screenshots || [])) {
      parts.push(`<div class="plate" data-full="${esc(sc.full)}" tabindex="0" role="button" aria-label="View screenshot">
        <img src="${esc(sc.thumbnail || sc.full)}" loading="lazy" data-hide-on-error="">
      </div>`);
    }
    container.innerHTML = parts.length ? parts.join('') : '<div class="media-empty">No trailers or screenshots found.</div>';

    container.querySelectorAll('.plate').forEach(plate => {
      const open = () => {
        if (plate.dataset.movie) {
          plate.classList.remove('is-video');
          plate.innerHTML = '<video controls autoplay style="width:100%;height:100%;object-fit:cover"></video>';
          const el = plate.querySelector('video');
          try {
            window.LibrarianTrailer?.attach(el, JSON.parse(plate.dataset.movie));
            el.play().catch(() => {});
          } catch { /* a malformed record just leaves an empty player */ }
        } else if (plate.dataset.full) {
          openLightbox(plate.dataset.full);
        }
      };
      plate.onclick = open;
      plate.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }

  /**
   * Achievements for the open game.
   *
   * Two absences that look alike and are not: no definitions means nobody has
   * fetched the list yet, and the panel offers to; no save file means the game
   * has never unlocked anything through the emulator, which is a normal state
   * for a game you have not played rather than something to fix.
   */
  async function renderFlyoutAchievements(game) {
    const host = $('#flyout-ach');
    if (!host || !api.getAchievements) return;

    host.innerHTML = '<div class="loading-state"><div class="spinner"></div>Reading achievements…</div>';
    const token = ++state.achToken;

    let snap;
    try { snap = await api.getAchievements(game); } catch { snap = null; }
    if (token !== state.achToken || state.flyoutGame !== game) return;

    if (!snap || !snap.items.length) {
      const canFetch = Boolean(safeAppId(game.appid) && game.install_path);
      host.innerHTML = `<div class="empty-state-small">
        No achievement list for this game yet.
        ${canFetch ? '<br><button class="xbox-btn xbox-btn-secondary btn-sm" id="ach-fetch" style="margin-top:10px">Fetch the list from Steam</button>' : ''}
      </div>`;
      const button = $('#ach-fetch');
      if (button) {
        button.onclick = async () => {
          button.disabled = true;
          button.textContent = 'Asking Steam…';
          let res;
          try { res = await api.fetchAchievementDefinitions(game); }
          catch (e) { res = { success: false, error: e.message }; }
          if (res?.success) { toast(`${res.count} achievements found`, 'success'); renderFlyoutAchievements(game); }
          else {
            toast(res?.error || 'Could not fetch the list', 'error');
            button.disabled = false;
            button.textContent = 'Try again';
          }
        };
      }
      return;
    }

    setTabCount('#dtab-count-ach', snap.total);
    const rows = snap.items.map((a) => `
      <div class="ach-row${a.unlocked ? ' unlocked' : ''}">
        <div class="ach-icon">${a.icon
          ? `<img src="${esc(filePathToUrl(a.icon))}" alt="" data-hide-on-error="">`
          : `<span>${esc((a.title || '?').slice(0, 2).toUpperCase())}</span>`}</div>
        <div class="ach-text">
          <div class="ach-name">${esc(a.title)}</div>
          <div class="ach-desc">${esc(a.hidden && !a.unlocked ? 'Hidden achievement' : a.description || '')}</div>
        </div>
        <div class="ach-when">${a.unlocked ? esc(formatRelative(a.unlockedAt) || 'Unlocked') : ''}</div>
      </div>`).join('');

    host.innerHTML = `
      <div class="ach-summary">
        <strong>${snap.unlocked}</strong> of ${snap.total} unlocked
        <div class="ach-bar"><i style="width:${snap.percent}%"></i></div>
      </div>
      <div class="ach-list">${rows}</div>`;
  }

  function playFlyoutTrailer(movie) {
    const video = $('#flyout-trailer');
    const toggle = $('#flyout-trailer-toggle');
    if (!video || !movie) return;
    // Trailers are HLS for anything released since Steam changed its media
    // format, so this goes through the shared player rather than video.src.
    if (!window.LibrarianTrailer?.attach(video, movie)) return;
    video.muted = true;
    video.play().then(() => {
      video.classList.add('playing');
      if (toggle) {
        toggle.classList.remove('hidden');
        toggle.textContent = '🔇';
        toggle.onclick = () => {
          video.muted = !video.muted;
          toggle.textContent = video.muted ? '🔇' : '🔊';
        };
      }
    }).catch(() => { /* autoplay blocked; leave the still image */ });
  }

  function stopFlyoutTrailer() {
    const video = $('#flyout-trailer');
    const toggle = $('#flyout-trailer-toggle');
    if (video) {
      // detach also destroys any streaming session; leaving one running would
      // keep fetching segments for a trailer nobody is watching.
      if (window.LibrarianTrailer) window.LibrarianTrailer.detach(video);
      else { try { video.pause(); } catch {} video.removeAttribute('src'); try { video.load(); } catch {} }
      video.classList.remove('playing');
    }
    if (toggle) { toggle.classList.add('hidden'); toggle.textContent = '🔊'; }
  }

  /**
   * Online mode, shown only for games it can actually help.
   *
   * The eligibility check is deliberately strict — it hides the toggle rather
   * than offering something that cannot work. A game with no Steam or EOS
   * networking, one that is free-to-play, or one carrying anti-cheat all get
   * nothing, with the reason available rather than a dead switch.
   *
   * The scan behind it reads the game's binaries, so it is answered off the
   * main process and the row stays hidden until it comes back.
   */
  /**
   * DLC, as the emulator sees it.
   *
   * The switch writes `[app::dlcs]` into the game's steam_settings: unlock_all
   * plus the real id/name list from the storefront, because a game that walks
   * its DLC by index shows those names in its own menus and an empty list
   * leaves them blank. Only offered where there is an emulator to tell — a
   * game running its own steam_api has nothing listening.
   */
  async function renderDlcPanel(game) {
    const panel = $('#flyout-dlc');
    if (!panel || !api.dlcStatus) return;
    panel.classList.add('hidden');
    if (!game || !game.install_path) return;

    let st;
    try { st = await api.dlcStatus(game.install_path); } catch { return; }
    // The user may have moved on while the folder was scanned.
    if (!st || state.flyoutGame !== game) return;

    /*
     * Most games have no DLC, and a switch that unlocks nothing is clutter with
     * a promise attached. The list is cached for a week, so this costs one
     * round trip per game rather than one per panel open — and when Steam
     * cannot be reached the panel is left in place, because "we could not ask"
     * is not the same answer as "there are none".
     */
    if (st.ready && !st.unlockAll) {
      let found;
      try { found = await api.listDlc(game.appid); } catch { found = null; }
      if (state.flyoutGame !== game) return;
      if (found && !found.unknown && !found.items.length) return;
    }

    const sub = $('#flyout-dlc-sub');
    const note = $('#flyout-dlc-note');
    const toggle = $('#flyout-dlc-toggle');
    if (!toggle) return;

    if (!st.ready) {
      panel.classList.remove('hidden');
      panel.classList.add('unavailable');
      sub.textContent = 'Not available for this game';
      note.textContent = st.reason || '';
      toggle.disabled = true;
      toggle.setAttribute('aria-checked', 'false');
      return;
    }

    panel.classList.remove('hidden', 'unavailable');
    toggle.disabled = false;
    toggle.classList.toggle('on', st.unlockAll);
    toggle.setAttribute('aria-checked', st.unlockAll ? 'true' : 'false');
    sub.textContent = st.unlockAll ? 'Unlocked' : 'Locked';
    note.textContent = st.unlockAll && st.items.length
      ? `${st.items.length} listed by name`
      : st.unlockAll ? 'Reported as owned' : '';

    toggle.onclick = async () => {
      if (toggle.disabled) return;
      toggle.disabled = true;
      const turningOn = !st.unlockAll;
      sub.textContent = turningOn ? 'Unlocking…' : 'Locking…';

      let r;
      try {
        r = turningOn
          ? await api.applyDlc({ gamePath: game.install_path, appId: game.appid, unlockAll: true })
          : await api.disableDlc(game.install_path);
      } catch (e) {
        r = { success: false, error: e.message };
      }

      if (!r?.success) toast(r?.error || 'Could not write the emulator config', 'error');
      else toast(turningOn ? `DLC unlocked${r.count ? ` · ${r.count} listed` : ''}` : 'DLC locked again', 'success');
      renderDlcPanel(game);
    };
  }

  /**
   * Le greffon « Rejoindre un ami » de PEAK.
   *
   * Caché partout ailleurs : il ne concerne qu'un seul jeu, et un interrupteur
   * sans objet dans une fiche est une question posée pour rien. Quand BepInEx
   * manque, le panneau reste visible mais inerte, avec la raison sous le
   * commutateur — l'absence de chargeur est une information, pas un silence.
   */
  /**
   * Le moteur générique, proposé sur tout jeu Unity/Photon reconnu.
   *
   * Contrairement au greffon PEAK, rien ici ne dépend d'un AppID : c'est le
   * dossier du jeu qui décide, et le panneau reste caché partout ailleurs. Sur
   * PEAK, le greffon dédié est signalé comme le meilleur choix, parce qu'il est
   * le seul à suivre la machine à états du jeu et qu'il a été vérifié en partie
   * réelle. Voir src/core/photonMod.js.
   */
  async function renderPhotonMod(game) {
    const panel = $('#flyout-photonmod');
    if (!panel || !api.getPhotonModStatus) return;
    panel.classList.add('hidden');
    if (!game || !game.install_path) return;

    let st;
    try { st = await api.getPhotonModStatus(game); } catch { return; }
    if (!st || !st.ok || !st.applies || state.flyoutGame !== game) return;

    const heading = $('#flyout-photonmod-title');
    const sub = $('#flyout-photonmod-sub');
    const note = $('#flyout-photonmod-note');
    const toggle = $('#flyout-photonmod-toggle');
    if (!toggle) return;

    panel.classList.remove('hidden');
    toggle.disabled = false;
    toggle.classList.toggle('on', !!st.installed);
    toggle.setAttribute('aria-checked', String(!!st.installed));
    // Le titre ne prend son qualificatif que là où il faut le distinguer du
    // greffon dédié : partout ailleurs, ce panneau EST « rejoindre un ami ».
    // Il tient sur une ligne dans les deux cas, sinon il pousse l'interrupteur
    // vers le bas et le panneau ne ressemble plus à ses voisins.
    if (heading) heading.textContent = st.preferDedicated ? 'Moteur générique' : 'Rejoindre un ami';
    sub.textContent = 'Rejoindre la partie d’un ami sur ce jeu Photon';
    const trouve = st.photonFile ? 'Photon trouvé dans ' + st.photonFile + '. ' : '';

    // Sur PEAK, dire franchement que l'autre panneau vaut mieux : proposer deux
    // chemins sans les départager reviendrait à faire tirer au sort.
    if (st.preferDedicated && !st.installed) {
      note.textContent = 'Préfère le greffon dédié ci-dessus : lui seul charge la scène après l’entrée en salle.';
    } else if (st.installed) {
      note.textContent = st.stale
        ? 'Une version plus récente est disponible — réactive pour la poser.'
        : trouve + 'F7 en jeu, F8 pour le rapport de sonde.';
    } else {
      note.textContent = st.loader
        ? trouve + 'Un seul binaire pour tous les jeux Photon.'
        : trouve + 'Installe BepInEx et le moteur, réversible en un clic.';
    }

    toggle.onclick = async () => {
      const turningOn = !toggle.classList.contains('on');
      toggle.disabled = true;
      note.textContent = turningOn ? 'Installation…' : 'Retrait…';
      let r;
      try { r = await api.setPhotonMod({ game, enabled: turningOn }); }
      catch (e) { r = { success: false, error: e.message }; }
      if (r && r.success) {
        toast(turningOn
          ? (r.loaderInstalled ? 'BepInEx et le moteur installés' : 'Moteur installé')
          : 'Moteur retiré', 'success');
      } else toast(r?.error || 'Opération impossible', 'error');
      renderPhotonMod(game);       // relire le disque plutôt que supposer
    };
  }

  async function renderPeakMod(game) {
    const panel = $('#flyout-peakmod');
    if (!panel || !api.getPeakModStatus) return;
    panel.classList.add('hidden');
    if (!game || !game.install_path) return;

    let st;
    try { st = await api.getPeakModStatus(game); } catch { return; }
    if (!st || !st.ok || !st.applies || state.flyoutGame !== game) return;

    const sub = $('#flyout-peakmod-sub');
    const note = $('#flyout-peakmod-note');
    const toggle = $('#flyout-peakmod-toggle');
    if (!toggle) return;

    panel.classList.remove('hidden');
    toggle.disabled = false;
    toggle.classList.toggle('on', !!st.installed);
    toggle.setAttribute('aria-checked', String(!!st.installed));
    sub.textContent = 'Rejoindre la partie d’un ami qui a le vrai jeu';

    // Le chargeur est livré avec Librarian, donc son absence n'est plus un
    // obstacle à signaler : elle ne change que ce que le premier clic aura à
    // faire, et l'utilisateur n'a rien à préparer.
    note.textContent = st.installed
      ? (st.stale
          ? 'Une version plus récente est disponible — réactive pour la poser.'
          : 'F7 en jeu, au menu principal. L’hôte n’installe rien.')
      : (st.loader
          ? 'Se présente sous un identifiant que l’hôte reconnaît comme membre de son lobby.'
          : 'Installe BepInEx et le greffon. Réversible en un clic.');

    toggle.onclick = async () => {
      const turningOn = !toggle.classList.contains('on');
      toggle.disabled = true;
      note.textContent = turningOn ? 'Installation…' : 'Retrait…';
      let r;
      try { r = await api.setPeakMod({ game, enabled: turningOn }); }
      catch (e) { r = { success: false, error: e.message }; }
      if (r && r.success) {
        toast(turningOn
          ? (r.loaderInstalled ? 'BepInEx et le greffon installés' : 'Greffon installé')
          : 'Greffon retiré', 'success');
      } else toast(r?.error || 'Opération impossible', 'error');
      renderPeakMod(game);       // relire le disque plutôt que supposer
    };
  }

  async function renderOnlineMode(game) {
    const panel = $('#flyout-online');
    if (!panel || !api.getOnlineStatus) return;
    panel.classList.add('hidden');
    if (!game || !game.install_path) return;

    let res;
    try { res = await api.getOnlineStatus(game); } catch { return; }
    // The user may have moved on while the scan ran.
    if (!res || !res.ok || state.flyoutGame !== game) return;

    const { eligibility, status } = res;
    const sub = $('#flyout-online-sub');
    const note = $('#flyout-online-note');
    const toggle = $('#flyout-online-toggle');
    if (!toggle) return;

    if (!eligibility.eligible) {
      // Worth showing *why* for a multiplayer game — silence reads as a bug.
      if (eligibility.backend === 'none') return;
      panel.classList.remove('hidden');
      panel.classList.add('unavailable');
      sub.textContent = 'Not available for this game';
      note.textContent = eligibility.reasons[0] || '';
      toggle.disabled = true;
      toggle.setAttribute('aria-checked', 'false');
      return;
    }

    panel.classList.remove('hidden', 'unavailable');
    toggle.disabled = false;
    const on = status.mode === 'online';
    toggle.classList.toggle('on', on);
    toggle.setAttribute('aria-checked', String(on));
    /*
     * An install whose Steam identity belongs to its own loader.
     *
     * The switch stays live — the player asked for online mode, and turning it
     * on is what stops Librarian re-applying the session swap on every launch.
     * But it has to say what it does, because the one thing it will not do is
     * change who the game thinks you are: doing that ended every Monster Hunter
     * Wilds launch three seconds in. See src/core/onlineMode.js.
     */
    const owner = eligibility.identityOwner;
    if (owner) {
      sub.textContent = 'Kept the way this install needs it';
      note.textContent = on
        ? `On. This install's own Steam loader (${owner.marks[0]}) keeps the identity its activation needs, so the session is left alone.`
        : 'This install carries its own Steam loader. Online mode will leave its identity alone — replacing it stops the game starting.';
    } else {
      sub.textContent = eligibility.backend === 'eos'
        ? 'Play with friends over Epic Online Services'
        : 'Play with friends over Steam';
      note.textContent = on
        ? 'Steam must be running. Your Steam account is in use while this is on.'
        : 'Swaps the offline emulator for a real Steam session.';
    }

    toggle.onclick = async () => {
      const turningOn = !toggle.classList.contains('on');
      toggle.disabled = true;
      note.textContent = turningOn ? 'Switching on…' : 'Restoring offline mode…';
      let r;
      try { r = await api.setOnlineMode({ game, enabled: turningOn }); }
      catch (e) { r = { success: false, error: e.message }; }

      if (r && r.success) {
        toast(turningOn ? 'Online mode on — launch with Steam running' : 'Back to offline mode', 'success');
      } else {
        toast(`Could not switch: ${r?.error || 'unknown error'}`, 'error');
      }
      renderOnlineMode(game);        // re-read from disk rather than assume
    };
  }

  /**
   * Emulator compatibility (src/core/emuCompat.js). Silent when the emulator
   * covers everything this build asks for. Shown when it does not — after a
   * download or update that refused to place it, or after a launch that
   * wrote a missing-interface report — with the one action that helps:
   * fetch the newest emulator release and apply it again.
   */
  async function renderEmuCompat(game) {
    const panel = $('#flyout-emu');
    if (!panel || !api.emuStatus) return;
    panel.classList.add('hidden');
    if (!game || !game.install_path) return;

    let st;
    try { st = await api.emuStatus(game); } catch { return; }
    if (!st || !st.ok || state.flyoutGame !== game) return;

    const sub = $('#flyout-emu-sub');
    const note = $('#flyout-emu-note');
    const btn = $('#flyout-emu-update');
    const check = st.check || {};
    const missing = Array.isArray(check.missing) ? check.missing : [];
    const block = st.block;
    if (check.online || (!missing.length && !block)) return;   // nothing to say

    panel.classList.remove('hidden', 'is-ok', 'is-busy');
    const names = missing.length ? missing : (block && block.missing) || [];
    // The column is narrow: name the count, list the names on the next line.
    sub.textContent = names.length
      ? `${names.length} interface${names.length > 1 ? 's' : ''} this build needs are missing: ${names.join(', ')}.`
      : 'The last launch reported an interface the emulator does not implement.';
    const when = block && block.at ? formatRelative(block.at) : '';
    const latest = st.latest && st.latest.publishedAt ? new Date(st.latest.publishedAt).toISOString().slice(0, 10) : '';
    const sourceText = { launch: 'at launch', update: 'after an update', download: 'after a download', repair: 'after a verify', manual: 'when applying by hand' }[block && block.source] || (block ? `after a ${block.source}` : '');
    note.textContent = `${block ? `Noticed ${when}, ${sourceText}. ` : ''}`
      + `Meanwhile the game uses its own Steam library: no achievements, no DLC.`
      + `${latest ? ` Newest emulator release: ${latest}.` : ''}`;

    btn.onclick = async () => {
      panel.classList.add('is-busy');
      note.textContent = 'Fetching the newest emulator and applying it…';
      let r;
      try { r = await api.emuRecrack(game); } catch (e) { r = { success: false, error: e.message }; }
      panel.classList.remove('is-busy');
      if (r && r.success) {
        toast(`${game.game_name}: emulator ${r.updated ? 'updated and ' : ''}applied`, 'success');
        panel.classList.add('is-ok');
        sub.textContent = 'Emulator applied for this build.';
        note.textContent = r.log && r.log.length ? r.log.slice(-1)[0] : '';
        setTimeout(() => renderEmuCompat(game), 1500);
      } else if (r && r.blocked) {
        toast('Windows Defender blocked the emulator download', 'error', { duration: 10000 });
        note.textContent = 'Windows Defender refused the emulator archive: it flags Steam emulators as potentially unwanted. The installed emulator was left untouched. Allow the file in Windows Security → Protection history (or exclude Librarian\'s deps folder), then press the button again.';
      } else {
        const why = r && r.missing && r.missing.length ? `still missing ${r.missing.join(', ')}` : (r && r.error) || 'unknown error';
        toast(`Emulator not applied: ${why}`, 'error');
        note.textContent = `Could not apply: ${why}. The newest emulator release does not cover this build yet; the game keeps its own Steam library.`;
      }
    };
  }

  function renderFlyoutFavoriteButton(game) {
    // Favourite state lives in the action bar; re-render it.
    renderFlyoutActions(game);
  }

  function renderFlyoutUpdateStatus(game) {
    if (!state.flyoutGame || gameKeyOf(state.flyoutGame) !== gameKeyOf(game)) return;
    const statusEl = $('#flyout-update-status');
    const info = state.updateResults[updateResultKey(game)];
    if (!info) {
      if (!game.appid || game.appid === '0') {
        statusEl.innerHTML = '<span class="update-badge unknown">No AppID</span>';
      } else {
        statusEl.innerHTML = '<span class="update-badge unknown">Not checked</span>';
      }
      return;
    }

    switch (info.status) {
      case 'up_to_date': {
        const newer = /^\d+$/.test(String(info.localBuildId)) && /^\d+$/.test(String(info.remoteBuildId)) && BigInt(info.localBuildId) > BigInt(info.remoteBuildId);
        statusEl.innerHTML = newer
          ? `<span class="update-badge unknown">Installed record ${esc(info.localBuildId)} · public ${esc(info.remoteBuildId)} — check the branch</span>`
          : `<span class="update-badge up-to-date">✓ ${game.build_source === 'declared' ? 'Declared build matches public' : 'Up to date'} (Build ${esc(info.remoteBuildId || info.localBuildId || 'matched manifests')})</span>`;
        break;
      }
      case 'update_available':
        statusEl.innerHTML = `<span class="update-badge update-available">↑ Update available: Build ${esc(info.localBuildId || 'unknown')} → ${esc(info.remoteBuildId || 'changed manifests')}</span>`;
        break;
      case 'unknown':
        if (info.reason === 'No local buildId' && info.remoteBuildId) {
          statusEl.innerHTML = `<span class="update-badge unknown">? Local build unknown · public build ${esc(info.remoteBuildId)}</span>`;
        } else {
          statusEl.innerHTML = `<span class="update-badge unknown">? ${esc(info.reason || 'Unknown')}</span>`;
        }
        break;
      case 'error':
        statusEl.innerHTML = `<span class="update-badge unknown">⚠ ${esc(info.reason || 'Error')}</span>`;
        break;
    }
  }

  let flyoutTeardown = null;

  function closeFlyout() {
    window.LibrarianDialogs.leave($('#game-flyout'));
    const flyout = $('#game-flyout');
    flyout.classList.remove('flyout-open');
    flyout.classList.add('flyout-closed');
    // Tearing the trailer down now would swap the moving picture for the
    // still underneath it *while the panel is fading* — a visible jump in
    // the middle of the exit. The panel is on its way out either way, so
    // let it finish leaving first. openFlyout cancels this if the user
    // comes straight back, otherwise it would kill the new trailer.
    if (flyoutTeardown) clearTimeout(flyoutTeardown);
    flyoutTeardown = setTimeout(() => { flyoutTeardown = null; stopFlyoutTrailer(); }, 260);
    state.flyoutGame = null;
    emit('flyout', { open: false });
  }

  // ─── Drop Zone ──────────────────────────────────────
  function setupDropZone() {
    const dz = $('#drop-zone');
    dz.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', (e) => { e.preventDefault(); dz.classList.remove('drag-over'); });
    dz.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation(); dz.classList.remove('drag-over');
      Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.zip')).forEach(f => addToQueue(f.name, api.getPathForFile(f)));
    });
    dz.addEventListener('click', async () => {
      const fp = await api.openFile({ filters: [{ name: 'ZIP', extensions: ['zip'] }] });
      if (fp) addToQueue(fp.split(/[\\/]/).pop(), fp);
    });
  }

  // ─── Queue ──────────────────────────────────────────
  async function addToQueue(name, filepath, options = {}) {
    if (!state.queueReady) { toast('The download queue is still loading. Try again in a moment.', 'error'); return false; }
    const job = {
      id: Date.now() + Math.random(),
      name: name.replace('.zip', ''),
      path: filepath,
      status: 'queued',
      percent: 0,
      appid: options.appid ? String(options.appid) : null,
      jobType: options.jobType || 'download',
      destPath: options.destPath || null,
      selectedDepots: Array.isArray(options.selectedDepots) ? [...options.selectedDepots] : null,
      installDir: options.installDir || null,
      installPath: options.installPath || null,
      customGameId: options.customGameId || null,
      updateRevision: options.updateRevision || null,
      targetBuildId: options.targetBuildId || null,
      skipAutoCrack: Boolean(options.skipAutoCrack),
      // Fetched manifest zips live in userData and should be deleted after the job.
      managedZip: Boolean(options.managedZip),
      // A CS.RIN.RU job has no manifest; it is one hoster link and the post
      // it came from. Everything else about it is the same queue entry.
      csrin: options.csrin ? { ...options.csrin } : null,
    };
    try { await api.addQueueJob(job); }
    catch (error) { toast(`Could not save the download: ${error.message}`, 'error'); return false; }
    state.queue.push(job);
    log(getQueuedJobMessage(job));
    updateQueueUI();
    updateBadge();
    navigateTo('downloads');
    if (!state.isProcessing) processNextJob();
    return true;
  }

  function getQueuedJobMessage(job) {
    if (job.jobType === 'update') return `⬆ Queued update: ${job.name}`;
    if (job.jobType === 'repair') return `🛠 Queued verify / repair: ${job.name}`;
    if (job.jobType === 'csrin') return `🌐 Queued from CS.RIN.RU: ${job.name}${job.csrin?.host ? ` (${job.csrin.host})` : ''}`;
    return `📦 Added: ${job.name}`;
  }

  function getProcessingJobLabel(jobType) {
    if (jobType === 'update') return 'Updating';
    if (jobType === 'repair') return 'Verifying / repairing';
    if (jobType === 'csrin') return 'Fetching from CS.RIN.RU';
    return 'Processing';
  }

  function hasQueuedJobForApp(appId, jobType = null, customGameId = null) {
    return state.queue.some(job => {
      if (!job || String(job.appid) !== String(appId)) return false;
      if ((job.customGameId || null) !== customGameId) return false;
      if (job.status !== 'queued' && job.status !== 'processing') return false;
      return !jobType || job.jobType === jobType;
    });
  }

  async function ensureUpdateInfo(game) {
    if (!game.appid || game.appid === '0' || game.appid === '') {
      return { status: 'unknown', reason: 'No AppID' };
    }

    const statusEl = $('#flyout-update-status');
    if (statusEl && state.flyoutGame && gameKeyOf(state.flyoutGame) === gameKeyOf(game)) {
      statusEl.innerHTML = '<span class="update-badge checking">⏳ Checking...</span>';
    }

    let result;
    try {
      await refreshLinkedGame(game);
      result = await api.checkGameUpdate(game.appid, game.buildid, {
        force: true,
        installedManifests: game.installed_manifests || null,
      });
    } catch (e) {
      result = { status: 'error', reason: e.message };
    }
    state.updateResults[updateResultKey(game)] = result;
    persistUpdateResults();
    renderFlyoutUpdateStatus(game);
    refreshUpdateBadges();
    return result;
  }

  /**
   * @returns {{queued: boolean, reason?: string, message?: string}} — callers
   *   need to distinguish a started job from "nothing to do" and from a
   *   failure. Big Picture builds its whole update screen from this.
   */
  async function queueGameUpdate(game, options = {}) {
    const silent = Boolean(options.silent);
    try {
      game = JSON.parse(JSON.stringify(game));
      await refreshLinkedGame(game);
      const linkedCustom = game.source === 'Custom' && Boolean(game.update_link);
      if (!game.appid || game.appid === '0' || game.appid === '') {
        if (!silent) toast('No AppID — cannot update', 'error');
        return { queued: false, reason: 'no-appid', message: 'This game has no Steam AppID.' };
      }

      if (!game.library_path && !linkedCustom) {
        if (!silent) toast('Library path missing — cannot update this game automatically', 'error');
        return { queued: false, reason: 'no-library', message: 'No library path recorded for this game.' };
      }

      if (linkedCustom && !game.update_ready) throw new Error(game.update_error || 'Inspect the update association again.');
      if (hasQueuedJobForApp(game.appid, 'update', linkedCustom ? game.id : null)) {
        if (!silent) {
          toast('An update for this game is already queued', 'error');
          closeFlyout();
          navigateTo('downloads');
        }
        return { queued: false, reason: 'already-queued', message: 'An update for this game is already queued.' };
      }

      const info = await ensureUpdateInfo(game);
      const canProceedWithoutLocalBuildId = info.status === 'unknown'
        && info.reason === 'No local buildId'
        && Boolean(info.remoteBuildId);

      if (info.status === 'up_to_date' && !linkedCustom) {
        if (!silent) toast(`${game.game_name} is already up to date ✓`, 'success');
        // ensureUpdateInfo has already corrected the stored result, so the
        // stale "update available" flag that offered this button is gone.
        return { queued: false, reason: 'up-to-date', message: `${game.game_name} is already on the latest build.` };
      }
      if (info.status !== 'update_available' && !canProceedWithoutLocalBuildId && !(linkedCustom && info.status === 'up_to_date')) {
        if (!silent) toast(info.reason || 'Unable to prepare update', 'error');
        return { queued: false, reason: 'unavailable', message: info.reason || 'Could not work out what to update.' };
      }

      if (canProceedWithoutLocalBuildId) {
        log(`⚠ Local build ID missing for ${game.game_name}; proceeding with update using remote build ${info.remoteBuildId}.`);
      }
      if (linkedCustom) {
        if (!info.remoteBuildId) throw new Error('The target build could not be verified. Check again when the source is available.');
        if (game.buildid && BigInt(game.buildid) > BigInt(info.remoteBuildId)) throw new Error('The recorded installed build is newer than public. Check the branch or correct the local build record before updating.');
        if (!silent && !await showConfirm('Update existing installation', `${game.game_name}\nInstalled build: ${game.buildid || 'Unknown'}${game.build_source === 'declared' ? ' (entered manually)' : ''}\nTarget: public build ${info.remoteBuildId}\nFolder: ${game.install_path}\n\nExisting files will be checked before downloading missing or changed data. Modified game files may be replaced. Files absent from the old depot inventory cannot be identified as obsolete and will be kept.`, { confirmLabel: 'Verify & update' })) return { queued: false, reason: 'cancelled', message: 'Update cancelled.' };
      }

      // A Denuvo game runs on the member's release for its exact build.
      // Moving it to a build CS.RIN.RU has no release for would leave it
      // unplayable, so that is checked before anything is fetched.
      const gate = linkedCustom ? { ok: true } : await csrinReleaseGate(game, info.remoteBuildId, { silent, verb: 'update' });
      if (!gate.ok) return { queued: false, reason: 'csrin-no-release', message: gate.message };

      if (!silent) closeFlyout();
      navigateTo('downloads');
      $('#log-area').classList.remove('hidden');

      if (!silent) toast(`Preparing update for ${game.game_name}...`);
      log(`🔄 Fetching latest manifest for ${game.game_name}...`);
      const res = await api.downloadManifest(game.appid);
      if (res.error) {
        log(`❌ ${res.error}`, 'error');
        toast(`Failed: ${res.error}`, 'error');
        return { queued: false, reason: 'manifest', message: res.error };
      }

      if (!res.filepath) {
        log('❌ Manifest download did not return a file path.', 'error');
        toast('Failed: manifest download did not return a file', 'error');
        return { queued: false, reason: 'manifest', message: 'The manifest download returned no file.' };
      }

      log(manifestReadyLine(res), res.stale ? 'accent' : 'success');

      const selectedDepots = Array.isArray(game.installed_depots) && game.installed_depots.length
        ? [...game.installed_depots]
        : null;

      if (!selectedDepots) {
        log(`⚠ No installed depot list found for ${game.game_name}; depot selection will be requested during update.`);
      }

      const queued = await addToQueue(game.game_name, res.filepath, {
        jobType: 'update',
        appid: game.appid,
        destPath: linkedCustom ? game.install_path : game.library_path,
        selectedDepots,
        installDir: game.install_dir,
        installPath: game.install_path,
        customGameId: linkedCustom ? game.id : null,
        updateRevision: linkedCustom ? game.update_link.revision : null,
        targetBuildId: linkedCustom ? String(info.remoteBuildId) : null,
        skipAutoCrack: linkedCustom,
        managedZip: true,
      });
      if (!queued) return { queued: false, reason: 'persistence', message: 'The download could not be saved.' };
      if (!silent) toast(`Update queued for ${game.game_name}`, 'success');
      return { queued: true };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      log(`❌ Update preparation failed: ${message}`, 'error');
      if (!silent) toast(`Failed: ${message}`, 'error');
      return { queued: false, reason: 'error', message };
    }
  }

  async function queueGameRepair(game) {
    try {
      game = JSON.parse(JSON.stringify(game));
      if (!game.appid || game.appid === '0' || game.appid === '') {
        toast('No AppID — cannot verify this game automatically', 'error');
        return;
      }

      if (!game.library_path || !game.install_dir) {
        toast('Install metadata missing — cannot verify this game automatically', 'error');
        return;
      }

      if (hasQueuedJobForApp(game.appid, 'repair')) {
        toast('A verify / repair job for this game is already queued', 'error');
        closeFlyout();
        navigateTo('downloads');
        return;
      }

      closeFlyout();
      navigateTo('downloads');
      $('#log-area').classList.remove('hidden');

      toast(`Preparing verify / repair for ${game.game_name}...`);
      log(`🛠 Fetching manifest for verify / repair: ${game.game_name}...`);

      const res = await api.downloadManifest(game.appid);
      if (res.error) {
        log(`❌ ${res.error}`, 'error');
        toast(`Failed: ${res.error}`, 'error');
        return;
      }

      if (!res.filepath) {
        log('❌ Manifest download did not return a file path.', 'error');
        toast('Failed: manifest download did not return a file', 'error');
        return;
      }

      const selectedDepots = Array.isArray(game.installed_depots) && game.installed_depots.length
        ? [...game.installed_depots]
        : null;

      if (!selectedDepots) {
        log(`⚠ No installed depot list found for ${game.game_name}; depot selection will be requested before repair.`);
      }

      log(`${manifestReadyLine(res)} Existing files are validated and only missing or corrupt chunks are downloaded.`, res.stale ? 'accent' : 'success');
      // A verify puts the game's own Steam library back over the emulator.
      // The engine re-applies the emulator afterwards, through the same
      // compatibility gate as an update, when the game had one — so a verify
      // no longer costs the achievements and the DLC (src/core/emuCompat.js).
      const queued = await addToQueue(game.game_name, res.filepath, {
        jobType: 'repair',
        appid: game.appid,
        destPath: game.library_path,
        selectedDepots,
        installDir: game.install_dir,
        installPath: game.install_path,
        managedZip: true,
      });
      if (!queued) return;
      toast(`Verify / repair queued for ${game.game_name}`, 'success');
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      log(`❌ Verify / repair preparation failed: ${message}`, 'error');
      toast(`Failed: ${message}`, 'error');
    }
  }

  function updateQueueUI() {
    const area = $('#queue-area');
    const container = $('#queue-cards');
    area.classList.remove('hidden');
    $('#log-area').classList.remove('hidden');
    container.innerHTML = '';

    const queuedJobs = state.queue.filter(j => j.status === 'queued');

    state.queue.forEach(job => {
      const card = document.createElement('div');
      card.className = `queue-card ${job.status === 'processing' ? 'active' : ''}`;
      card.dataset.jobId = job.id;      // stable identity across rerenders
      const imgSrc = steamHeaderUrl(job.appid);
      const position = job.status === 'queued' ? queuedJobs.indexOf(job) + 1 : 0;
      const statusText = job.error || (job.status === 'queued' && position ? `#${position} in queue` : job.status);
      const destLabel = job.destPath ? job.destPath.split(/[\\/]/).filter(Boolean).pop() : 'Choose folder';
      card.innerHTML = `
        ${imgSrc ? `<img class="queue-card-img" src="${esc(imgSrc)}" data-hide-on-error="">` : '<div class="queue-card-img"></div>'}
        <div class="queue-card-name">${esc(job.name)}</div>
        <div class="queue-card-status ${job.status}">${esc(statusText)}</div>
        ${job.status === 'processing' ? `<div class="queue-card-progress"><div class="queue-card-fill" style="width:${job.percent}%"></div></div>` : ''}
        ${job.status === 'queued' ? `<button class="queue-card-dest" title="${job.destPath ? esc(job.destPath) : 'Pick where this installs'}">📁 ${esc(destLabel)}</button>` : ''}
        ${['failed', 'interrupted'].includes(job.status) ? '<button class="queue-card-retry xbox-btn xbox-btn-sm">Resume / retry</button>' : ''}
        <button class="queue-card-remove" title="${job.status === 'processing' ? 'Cancel this download' : 'Remove from queue'}">✕</button>
      `;

      // Let a queued job's destination be set before it ever starts.
      const destBtn = card.querySelector('.queue-card-dest');
      if (destBtn) destBtn.onclick = async (e) => {
        e.stopPropagation();
        const folder = await api.openFolder({
          title: `Install ${job.name} where?`,
          buttonLabel: 'Install here',
          defaultPath: job.destPath || state.settings.default_install_path || undefined,
        });
        if (!folder) return;
        try { await api.patchQueueJob(job.id, { destPath: folder }); }
        catch (error) { toast(`Destination was not saved: ${error.message}`, 'error'); return; }
        job.destPath = folder;
        toast(`${job.name} will install to ${folder}`, 'success');
        updateQueueUI();
      };

      const retryBtn = card.querySelector('.queue-card-retry');
      if (retryBtn) retryBtn.onclick = async () => {
        try {
          await api.patchQueueJob(job.id, { status: 'queued', error: '' });
          job.status = 'queued'; job.error = ''; updateQueueUI(); updateBadge();
          if (!state.isProcessing) void processNextJob();
        } catch (error) { toast(error.message, 'error'); }
      };
      const removeBtn = card.querySelector('.queue-card-remove');
      removeBtn.onclick = async (e) => {
        e.stopPropagation();
        if (job.status === 'processing') {
          // Route the active job through the real cancel flow so the process is killed.
          $('#btn-cancel').click();
        } else {
          await removeJob(job.id);

          log(`🗑 Removed from queue: ${job.name}`);
        }
      };
      container.appendChild(card);
    });

    const pauseBtn = $('#btn-pause');
    const cancelBtn = $('#btn-cancel');
    if (state.isProcessing) {
      cancelBtn.style.display = '';
      // SteamPipe pauses cooperatively, so pause works on every platform. A
      // hoster transfer from CS.RIN.RU cannot pause at all.
      const activeJob = state.queue.find(j => j.status === 'processing');
      pauseBtn.style.display = activeJob?.jobType === 'csrin' ? 'none' : '';
      pauseBtn.textContent = state.isPaused ? '▶' : '⏸';
    } else {
      pauseBtn.style.display = 'none'; cancelBtn.style.display = 'none';
    }
  }

  function cleanupJobArtifacts(job) {
    if (job && job.managedZip && job.path && api.cleanupFetchedZip) {
      try { api.cleanupFetchedZip(job.path); } catch {}
    }
  }

  function updateBadge() {
    const badge = $('#badge-downloads');
    const count = state.queue.filter(j => j.status === 'queued' || j.status === 'processing').length;
    if (count > 0) { badge.textContent = count; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
    emit('queue', { count, jobs: state.queue.map(j => ({ id: j.id, name: j.name, status: j.status, percent: j.percent })) });
  }

  async function processNextJob() {
    if (state.isProcessing || state.cancelling || !state.queueReady) return;
    const next = state.queue.find(j => j.status === 'queued');
    if (!next) {
      state.isProcessing = false;
      hideDlStats();
      updateQueueUI();
      updateBadge();
      if (!state.queue.length) log('✅ All jobs complete!', 'success');
      // The rescan is what gives a freshly installed game its build id; the
      // second source needs that before it can pick a post.
      scanAndRender().then(runPendingCsrin).catch(() => {});
      return;
    }

    state.isProcessing = true;
    const generation = ++state.queueGeneration;
    const isCurrent = () => generation === state.queueGeneration && state.queue.includes(next);
    try { await api.patchQueueJob(next.id, { status: 'preparing', error: '' }); }
    catch (error) { state.isProcessing = false; toast(`Could not save download state: ${error.message}`, 'error'); return; }
    next.status = 'processing';
    updateQueueUI();
    updateBadge();

    log(`\n── ${getProcessingJobLabel(next.jobType)}: ${next.name} ──`, 'accent');
    showDlStats(next.name);

    // A forum release has no manifest, no depots and no install sheet: it is
    // one link into one folder. It still ends on depot:complete / depot:error
    // like every other job, which is what advances the queue.
    if (next.jobType === 'csrin') { await processCsrinJob(next); return; }

    let result;
    try {
      result = await api.processZip(next.path, next.appid);
    } catch (e) {
      result = { success: false, error: e.message };
    }
    if (!result.success) {
      if (!isCurrent()) return;
      log(`❌ ${result.error}`, 'error');
      await failJob(next, result.error);
      processNextJob();
      return;
    }

    if (!isCurrent()) { await cleanupGameDataTemp(result.data); return; }
    if (next.appid && String(result.data.appid) !== String(next.appid)) {
      await cleanupGameDataTemp(result.data);
      await failJob(next, `Wrong game manifest: ${next.name} (Steam AppID ${next.appid}) received AppID ${result.data.appid}. Download stopped.`);
      void processNextJob();
      return;
    }
    state.currentGameData = result.data;
    const gd = result.data;
    if (next.installDir) gd.installdir = next.installDir;
    gd.job_type = next.jobType || 'download';
    if (next.skipAutoCrack) gd.skip_auto_crack = true;
    if (!next.appid) {
      next.appid = String(gd.appid);
      try { await api.patchQueueJob(next.id, { appid: next.appid }); }
      catch (error) { await cleanupGameDataTemp(gd); await failJob(next, error.message); return; }
    }
    if (['update', 'repair'].includes(next.jobType)) gd.game_name = next.name;

    log(`🎮 ${gd.game_name} (${gd.appid})`);
    log(`📦 ${Object.keys(gd.depots || {}).length} depots`);
    if (gd.platforms) log(`🖥️ ${gd.platforms.join(', ')}`);
    if (gd.dlcs) log(`🧩 ${Object.keys(gd.dlcs).length} DLCs`);

    updateQueueUI();

    // A Denuvo title never runs on the emulator alone, and the emulator's
    // DLL in place of the game's own breaks the member's release that does
    // run it ("Unable to create interface ISteamUser"). So for these the
    // post-download emulator step is skipped; the release is the crack.
    if (gd.appid && state.csrin.available && state.settings.auto_crack) {
      let denuvo = false;
      try { denuvo = await ensureDenuvoInfo({ appid: gd.appid }); } catch { denuvo = false; }
      if (denuvo) {
        gd.skip_auto_crack = true;
        log(`🛡 ${gd.game_name || next.name} is a Denuvo title — the emulator step is skipped; the CS.RIN.RU release carries its own.`, 'accent');
      }
    }

    // A Denuvo title is only worth the gigabytes if the member's release
    // for this very build exists; an update was already checked when it
    // was queued, a fresh download is checked here, with the manifest's
    // build in hand and nothing downloaded yet.
    if (next.jobType !== 'update' && next.jobType !== 'repair' && !next.skipAutoCrack && gd.appid) {
      const gate = await csrinReleaseGate({ appid: gd.appid, game_name: gd.game_name || next.name }, gd.buildid, { silent: false, verb: 'download' });
      if (!gate.ok) {
        log(`⏹ ${gd.game_name || next.name} not downloaded: ${gate.message || 'no release on CS.RIN.RU'}`);
        toast(`${gd.game_name || next.name}: download held — no CS.RIN.RU release for this build`, 'error', { duration: 8000 });
        await cleanupGameDataTemp(gd);  await removeJob(next.id); processNextJob(); return;
      }
    }

    const depots = gd.depots || {};
    if (!Object.keys(depots).length) { log('❌ No depots found.', 'error'); await cleanupGameDataTemp(gd);  await removeJob(next.id); processNextJob(); return; }

    let selected = null;
    if (Array.isArray(next.selectedDepots) && next.selectedDepots.length) {
      selected = next.selectedDepots.filter(depotId => depots[depotId]);
      const missingDepots = next.selectedDepots.filter(depotId => !depots[depotId]);
      if (missingDepots.length) {
        log(`⚠ Some previously installed depots are not present in the new manifest: ${missingDepots.join(', ')}`);
      }
    }

    // One sheet decides everything that goes in: whole depots (languages,
    // optional packs, runtimes) and, inside the base game, file groups. It
    // skips itself entirely when the game offers no real choice.
    //
    // An update used to skip this sheet and silently reuse installed_depots.
    // That broke a 69 GB install: Mortal Shell II records exactly one depot in
    // its manifest while its content spans several, so the update refreshed
    // pakchunk0/3/11 and left pakchunk1/2/6 on the previous build. UE5 indexes
    // every container through one global.utoc, so a partially updated set is
    // not a smaller game — it is a broken one, and the symptom (missing
    // textures) points nowhere near the cause.
    //
    // installed_depots is therefore not a record of what the game needs. It is
    // a hint, good enough to preselect with and not good enough to act on
    // unattended. The sheet is shown again, with that hint applied.
    const reinstating = next.jobType === 'update' || next.jobType === 'repair';
    if (reinstating && Array.isArray(selected) && selected.length) {
      // Recorded, but not trusted as a restriction: preselecting from it would
      // untick every depot the record happens to omit, which is how a partial
      // update happens in the first place. The sheet's own defaults cover the
      // whole game; an extra language depot costs half a megabyte, a missing
      // content depot costs the install.
      log(`↺ ${selected.length} depot(s) recorded as installed — the full recommended set is offered instead, because that record is not a complete list of what the game needs.`);
      selected = null;
    }
    const plan = await showInstallSheet(gd, selected);
    if (!isCurrent()) { await cleanupGameDataTemp(gd); return; }
    if (!plan) { log('⏹ Cancelled.'); await cleanupGameDataTemp(gd);  await removeJob(next.id); processNextJob(); return; }
    if (!isCurrent()) { await cleanupGameDataTemp(gd); return; }
    selected = plan.depots;

    if (!selected || !selected.length) { log('⏹ Cancelled.'); await cleanupGameDataTemp(gd);  await removeJob(next.id); processNextJob(); return; }

    // Only depots that have a manifest in this archive can actually be downloaded.
    // Selecting one without a manifest would otherwise abort the entire job.
    const manifests = gd.manifests || {};
    const noManifest = selected.filter(depotId => !manifests[depotId]);
    if (noManifest.length) {
      log(`⚠ Skipping depot(s) with no manifest in this archive: ${noManifest.join(', ')}`);
    }
    selected = selected.filter(depotId => manifests[depotId]);
    if (!selected.length) {
      log('❌ None of the selected depots have a downloadable manifest.', 'error');
      toast('No downloadable depots (missing manifests)', 'error');
      await cleanupGameDataTemp(gd);  await removeJob(next.id); processNextJob(); return;
    }

    // Size the job first so the destination picker can warn about a drive that
    // hasn't got room, and so the ETA has a denominator from the first tick.
    setDownloadTotalFromDepots(gd, selected);

    if (plan.excludeGroups.length) {
      gd.exclude_groups = plan.excludeGroups;
      log(`✂ Install plan: leaving out ${plan.excludeGroups.length} group(s).`);
    }
    // The manifest's own file sizes beat the depot-level estimate.
    if (plan.totalBytes > 0) {
      state.currentTotalBytes = plan.totalBytes;
      state.currentTotalBytesEstimated = false;
      updateDownloadSizeText();
    }

    const dest = next.customGameId ? next.destPath : await chooseDestination(gd, state.currentTotalBytes, next.destPath);
    if (!isCurrent()) { await cleanupGameDataTemp(gd); return; }
    if (!dest) { log('⏹ No destination.'); await cleanupGameDataTemp(gd);  await removeJob(next.id); processNextJob(); return; }
    if (!isCurrent()) { await cleanupGameDataTemp(gd); return; }
    next.destPath = dest;
    next.selectedDepots = selected;

    log(next.jobType === 'update' ? `♻️ Updating in ${dest}` : next.jobType === 'repair' ? `🛠 Verifying and repairing in ${dest}` : `📂 ${dest}`);
    setDlName(gd.game_name);
    state.downloadStartTime = Date.now();
    state.speedHistory = [];
    state.progressHistory = [];
    state.currentPercent = 0;
    // The destination picker above still wants the install-sized figure — it is
    // checking free space, where over-estimating is the safe direction. The
    // progress readout does not, and waits for the diff.
    state.awaitingUpdatePlan = next.jobType === 'update';
    // Per job, not per session: a stale plan from the last update would size
    // the next download against the wrong game entirely.
    state.updatePlan = null;
    state.wireBytes = 0;
    showDownloadDestination(dest, state.currentTotalBytes);

    let dlRes;
    try {
      await api.patchQueueJob(next.id, { destPath: dest, selectedDepots: selected, installDir: gd.installdir });
      if (!isCurrent()) return;
      dlRes = await api.startDownload({ jobId: next.id, gameData: gd, selectedDepots: selected, destPath: dest });
    } catch (e) {
      dlRes = { success: false, error: e.message };
    }
    if (!dlRes.success) { await failJob(next, dlRes.error); await cleanupGameDataTemp(gd); void processNextJob(); }
  }

  async function cleanupGameDataTemp(gameData) {
    if (!gameData || !gameData.manifest_dir || !api.cleanupZip) return;
    try { await api.cleanupZip(gameData.manifest_dir); } catch {}
  }

  function setDownloadTotalFromDepots(gameData, selectedDepots) {
    const sizes = selectedDepots.map((depotId) => {
      const rawSize = Number(gameData.depots?.[depotId]?.size || 0);
      return Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 0;
    });
    const knownSizes = sizes.filter(size => size > 0);

    if (!knownSizes.length) {
      state.currentTotalBytes = 0;
      state.currentTotalBytesEstimated = false;
      updateDownloadSizeText();
      return;
    }

    const averageKnownSize = knownSizes.reduce((total, size) => total + size, 0) / knownSizes.length;
    state.currentTotalBytes = sizes.reduce((total, size) => total + (size > 0 ? size : averageKnownSize), 0);
    state.currentTotalBytesEstimated = knownSizes.length !== sizes.length;
    updateDownloadSizeText();
  }

  async function removeJob(id) {
    const removed = state.queue.find(j => j.id === id);
    await api.removeQueueJob(id);
    if (removed?.status === 'processing') state.isProcessing = false;
    state.queue = state.queue.filter(j => j.id !== id);
    cleanupJobArtifacts(removed);
    updateQueueUI(); updateBadge();
  }

  async function failJob(job, error) {
    job.status = 'failed'; job.error = String(error || 'Download failed');
    state.isProcessing = false;
    try { await api.patchQueueJob(job.id, { status: job.status, error: job.error }); }
    catch (saveError) { toast('Could not save the error: ' + saveError.message, 'error'); }
    toast(job.error, 'error'); updateQueueUI(); updateBadge();
  }

  async function restoreQueue() {
    try {
      const snapshot = await api.getQueue();
      if (!snapshot) { state.queueReady = true; return; }
      state.queue = snapshot.jobs || [];
      const active = snapshot.active;
      state.isProcessing = Boolean(active);
      state.isPaused = Boolean(active?.paused);
      if (active) {
        const job = state.queue.find(j => j.id === active.jobId);
        if (job) job.status = 'processing';
        state.currentGameData = active.gameData || null;
        showDlStats(job?.name || active.name || 'Download');
        state.downloadStartTime = active.startedAt;
        state.currentPercent = active.percent || 0;
        $('#dl-pct-text').textContent = formatPercent(state.currentPercent);
        $('#dl-progress-fill').style.width = state.currentPercent + '%';
        if (active.gameData && active.selectedDepots) setDownloadTotalFromDepots(active.gameData, active.selectedDepots);
        if (active.plan) { state.updatePlan = active.plan; state.currentTotalBytes = active.plan.remainingBytes || active.plan.downloadBytes || 0; }
        (active.logs || []).forEach(line => log(line));
        showDownloadDestination(active.destPath, state.currentTotalBytes);
        setTaskbarProgress(state.currentPercent / 100);
        emitDownloadState();
      }
      for (const job of [...state.queue]) {
        if (job.status === 'complete') { await removeJob(job.id); continue; }
        if (!active && ['preparing', 'processing', 'paused', 'queued'].includes(job.status)) {
          job.status = 'interrupted'; job.error = 'Saved job — resume when ready';
          await api.patchQueueJob(job.id, { status: job.status, error: job.error });
        }
      }
      state.queueReady = true;
      updateQueueUI(); updateBadge();
    } catch (error) { toast('Could not restore the download queue: ' + error.message, 'error'); }
  }

  // ─── Queue Controls ─────────────────────────────────
  function setupQueueControls() {
    $('#btn-pause').onclick = async () => {
      if (state.isPaused) {
        const resumed = await api.resumeDownload();
        if (!resumed) { toast('Pause/resume is not supported on this platform', 'error'); return; }
        state.isPaused = false;
        log('▶ Resumed');
      } else {
        const paused = await api.pauseDownload();
        if (!paused) { toast('Pause/resume is not supported on this platform', 'error'); return; }
        state.isPaused = true;
        log('⏸ Paused');
      }
      updateQueueUI();
      emitDownloadState();
    };
    $('#btn-cancel').onclick = async () => {
      if (state.cancelling) return;
      state.cancelling = true;
      state.queueGeneration++;
      try { await api.cancelDownload(); }
      catch (error) { state.cancelling = false; toast(error.message, 'error'); return; }
      if (!$('#modal-overlay').classList.contains('hidden')) $('#modal-close').click();
      dismissDownloadAuthPrompt();
      log('⏹ Cancelled', 'error');
      const active = state.queue.find(j => j.status === 'processing');
      try { if (active) await removeJob(active.id); }
      catch (error) {
        state.cancelling = false; state.isProcessing = false;
        if (active) { active.status = 'interrupted'; active.error = `Could not save cancellation: ${error.message}`; }
        updateQueueUI(); toast(error.message, 'error'); return;
      }
      cleanupGameDataTemp(state.currentGameData);
      state.currentGameData = null;
      state.isProcessing = false; state.isPaused = false;
      state.currentPercent = 0;
      state.smoothedSpeed = 0;
      state.diskSpeed = '';
      state.lastSpeedSampleAt = 0;
      state.lastNonzeroSpeedAt = 0;
      state.speedHistory = [];
      state.currentTotalBytes = 0;
      state.currentTotalBytesEstimated = false;
      state.awaitingUpdatePlan = false;
      state.updatePlan = null;
      state.wireBytes = 0;
      state.progressHistory = [];
      state.cancelling = false;
      hideDlStats(); updateQueueUI(); updateBadge(); processNextJob();
    };
    $('#btn-clear-log').onclick = () => { $('#log-output').innerHTML = ''; };
  }

  // ─── Download Stats / Speed Graph ───────────────────
  function showDlStats(name) {
    $('#dl-stats').classList.remove('hidden');
    $('#dl-progress-track').classList.remove('hidden');
    setDlName(name);
    $('#dl-pct-text').textContent = '0%';
    $('#dl-size-progress').textContent = 'Preparing...';
    $('#dl-speed').textContent = '—';
    $('#dl-eta').textContent = '—';
    $('#dl-progress-fill').style.width = '0%';
    state.speedHistory = [];
    state.smoothedSpeed = 0;
    state.diskSpeed = '';
    state.lastSpeedSampleAt = 0;
    state.lastNonzeroSpeedAt = 0;
    state.currentPercent = 0;
    state.currentTotalBytesEstimated = false;
    state.progressHistory = [];
    state.downloadStartTime = Date.now();
    startElapsedTimer();
    drawSpeedChart();
    emitDownloadState({ name, percent: 0 });
  }

  function hideDlStats() {
    $('#dl-stats').classList.add('hidden');
    $('#dl-progress-track').classList.add('hidden');
    $('#dl-extra')?.classList.add('hidden');
    stopElapsedTimer();
    setTaskbarProgress(-1);
    emit('download', { active: false });
  }

  /**
   * Single source of truth for "what is downloading right now".
   * The focus view in enhance.js renders entirely from this payload, so every
   * place that changes download state funnels through here.
   */
  function emitDownloadState(overrides = {}) {
    const active = state.queue.find(j => j.status === 'processing') || null;
    const queued = state.queue.filter(j => j.status === 'queued');
    emit('download', {
      active: true,
      name: active ? active.name : $('#dl-game-name').textContent,
      appid: active ? safeAppId(active.appid) : '',
      jobType: active ? (active.jobType || 'download') : 'download',
      percent: state.currentPercent,
      paused: state.isPaused,
      speed: $('#dl-speed').textContent,
      diskSpeed: state.diskSpeed || '',
      eta: $('#dl-eta').textContent,
      sizeText: $('#dl-size-progress').textContent,
      dest: active?.destPath || '',
      // CS.RIN.RU jobs: whether the archive goes into a game, and whether
      // that is happening right now.
      csrinExtract: Boolean(active?.csrin?.extractTo),
      csrinPhase: active?.jobType === 'csrin' ? state.csrinPhase : '',
      totalBytes: state.currentTotalBytes,
      startedAt: state.downloadStartTime,
      upNext: queued.map(j => ({ name: j.name, appid: safeAppId(j.appid) })),
      ...overrides,
    });
  }

  // ─── Destination + elapsed readouts ─────────────────
  async function showDownloadDestination(dest, requiredBytes) {
    const extra = $('#dl-extra');
    if (!extra) return;
    extra.classList.remove('hidden');

    const destEl = $('#dl-dest');
    if (destEl) {
      destEl.textContent = `📁 ${dest}`;
      destEl.title = `Installing into ${dest} — click to open`;
      destEl.style.cursor = 'pointer';
      destEl.onclick = () => openPath(dest);
    }

    const diskEl = $('#dl-disk');
    if (!diskEl) return;
    diskEl.textContent = '💽 …';
    diskEl.classList.remove('warn');
    try {
      const space = await api.getDiskSpace(dest);
      if (!space) { diskEl.textContent = '💽 space unknown'; return; }
      diskEl.textContent = `💽 ${formatSize(space.free)} free`;
      if (requiredBytes > 0 && space.free < requiredBytes) {
        diskEl.classList.add('warn');
        diskEl.textContent = `💽 ${formatSize(space.free)} free — needs ${formatSize(requiredBytes)}`;
        toast(`Not enough space on that drive for ${formatSize(requiredBytes)}`, 'error');
      }
    } catch {
      diskEl.textContent = '💽 space unknown';
    }
  }

  function startElapsedTimer() {
    stopElapsedTimer();
    const el = $('#dl-elapsed');
    if (!el) return;
    const tick = () => {
      const secs = Math.max(0, Math.floor((Date.now() - (state.downloadStartTime || Date.now())) / 1000));
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      el.textContent = h > 0
        ? `⏱ ${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `⏱ ${m}:${String(s).padStart(2, '0')}`;
    };
    tick();
    state.elapsedTimer = setInterval(tick, 1000);
  }

  function stopElapsedTimer() {
    if (state.elapsedTimer) { clearInterval(state.elapsedTimer); state.elapsedTimer = null; }
  }

  function setTaskbarProgress(value) {
    if (!api.setTaskbarProgress) return;
    try { api.setTaskbarProgress(value); } catch { /* taskbar progress is cosmetic */ }
  }

  function dismissDownloadAuthPrompt() {
    if (!state.activeDownloadAuthChallenge) return;
    state.activeDownloadAuthChallenge = null;
    closeModal({ force: true });
  }

  function setDlName(name) { $('#dl-game-name').textContent = name; }

  function parseSpeedToBytes(speedText) {
    const m = speedText.match(/([\d.]+)\s*(B|K(?:i)?B|M(?:i)?B|G(?:i)?B|T(?:i)?B)\/s/i);
    if (!m) return 0;
    let val = parseFloat(m[1]);
    const unit = m[2].toUpperCase().replace('I', '');
    if (unit.startsWith('K')) val *= 1024;
    else if (unit.startsWith('M')) val *= 1024 * 1024;
    else if (unit.startsWith('G')) val *= 1024 * 1024 * 1024;
    else if (unit.startsWith('T')) val *= 1024 * 1024 * 1024 * 1024;
    return val;
  }

  function pushSpeedBytes(bytesPerSec) {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec < 0) return;

    const now = Date.now();
    state.lastSpeedSampleAt = now;
    if (bytesPerSec > 0) state.lastNonzeroSpeedAt = now;

    if (bytesPerSec === 0) {
      state.smoothedSpeed = 0;
    } else if (state.smoothedSpeed > 0) {
      state.smoothedSpeed = (state.smoothedSpeed * 0.72) + (bytesPerSec * 0.28);
    } else {
      state.smoothedSpeed = bytesPerSec;
    }

    $('#dl-speed').textContent = formatSpeed(state.smoothedSpeed);

    if (bytesPerSec === 0) {
      state.speedHistory.push(0);
      if (state.speedHistory.length > 120) state.speedHistory.shift();
      drawSpeedChart();
      updateETA();
      return;
    }

    const mbps = state.smoothedSpeed / (1024 * 1024);
    state.speedHistory.push(mbps);
    if (state.speedHistory.length > 120) state.speedHistory.shift();
    drawSpeedChart();
    updateETA();
  }

  function pushSpeedSample(speedText) {
    const bytesPerSec = parseSpeedToBytes(speedText);
    pushSpeedBytes(bytesPerSec);
  }

  function recordProgressSample(percent) {
    const now = Date.now();
    state.progressHistory.push({ time: now, percent });

    const windowMs = 45000;
    while (state.progressHistory.length > 1 && now - state.progressHistory[0].time > windowMs) {
      state.progressHistory.shift();
    }
  }

  function estimateEtaFromPercentVelocity() {
    if (state.progressHistory.length < 2 || state.currentPercent <= 0 || state.currentPercent >= 100) {
      return null;
    }

    const newest = state.progressHistory[state.progressHistory.length - 1];
    const oldest = state.progressHistory.find(sample => newest.time - sample.time >= 5000) || state.progressHistory[0];
    const deltaPercent = newest.percent - oldest.percent;
    const deltaSeconds = (newest.time - oldest.time) / 1000;

    if (deltaPercent <= 0 || deltaSeconds < 1) return null;

    const percentPerSecond = deltaPercent / deltaSeconds;
    return (100 - state.currentPercent) / percentPerSecond;
  }

  function updateDownloadSizeText() {
    const el = $('#dl-size-progress');
    if (!el) return;

    /*
     * An update's size is not knowable until the engine has diffed the old and
     * new manifests, which happens after it connects and fetches them. Until
     * then the only figure to hand is the whole install, and showing it made
     * every patch open as "0 B / 31.8 GB" before snapping down to the real
     * number — the reinstall-sized headline this was supposed to remove.
     *
     * The percent guard is the way out if no plan ever arrives: without a prior
     * manifest there is nothing to diff, the engine downloads everything, and
     * the install-sized figure underneath is then the correct one.
     */
    if (state.awaitingUpdatePlan && state.currentPercent <= 0) {
      el.textContent = 'Calculating update size…';
      return;
    }

    /*
     * On an update the headline is the *transfer*, not the work.
     *
     * The percentage measures everything that has to happen, and on a large
     * patch most of that is chunks copied out of the old build — 24.7 GB of a
     * 31.8 GB game in one measured case, against 1.96 GB actually downloaded.
     * Sizing the text off the percentage therefore reads like a reinstall no
     * matter how small the patch is, which is the thing that looked broken.
     *
     * So this line answers "how much am I downloading" with real transferred
     * bytes against the planned transfer, and the bar above keeps answering
     * "how far through the operation am I". Steam splits them the same way.
     */
    if (state.updatePlan && Number.isFinite(state.updatePlan.downloadBytes)) {
      const total = Math.max(1, state.updatePlan.downloadBytes);
      const done = Math.max(0, Math.min(total, state.wireBytes || 0));
      el.textContent = `${formatSize(done)} / ${formatSize(total)} downloaded`;
      return;
    }

    if (!state.currentTotalBytes || state.currentPercent <= 0) {
      el.textContent = state.currentTotalBytes ? `0 B / ${formatSize(state.currentTotalBytes)}` : 'Size unknown';
      return;
    }

    const downloadedBytes = Math.max(0, Math.min(state.currentTotalBytes, state.currentTotalBytes * (state.currentPercent / 100)));
    const suffix = state.currentTotalBytesEstimated ? ' est.' : '';
    el.textContent = `${formatSize(downloadedBytes)} / ${formatSize(state.currentTotalBytes)}${suffix}`;
  }

  function updateETA() {
    updateDownloadSizeText();

    if (
      state.currentPercent <= 0
      || state.currentPercent >= 100
    ) {
      $('#dl-eta').textContent = '—';
      return;
    }

    let remainingSeconds = null;
    let estimated = state.currentTotalBytesEstimated;

    /*
     * Deliberately skipped on an update.
     *
     * smoothedSpeed is the network rate, but most of an update's remaining work
     * is chunks being copied off the old build at disk speed — measured here at
     * 385 MB/s against a line doing tens of MB/s. Dividing one by the other
     * overstates the time several-fold and the estimate keeps collapsing as the
     * copying races ahead. Percent velocity measures the operation as it
     * actually runs, whatever each part of it is bound by.
     */
    if (!state.updatePlan && state.smoothedSpeed > 0 && state.currentTotalBytes > 0) {
      const remainingBytes = state.currentTotalBytes * (1 - state.currentPercent / 100);
      if (remainingBytes > 0) {
        remainingSeconds = remainingBytes / state.smoothedSpeed;
      }
    }

    if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) {
      remainingSeconds = estimateEtaFromPercentVelocity();
      estimated = true;
    }

    if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) {
      const hadSpeed = state.lastNonzeroSpeedAt >= state.downloadStartTime;
      const stalled = hadSpeed && Date.now() - state.lastNonzeroSpeedAt > 5000;
      $('#dl-eta').textContent = stalled ? 'Stalled' : 'Calculating...';
      return;
    }

    $('#dl-eta').textContent = `${estimated ? '~' : ''}${formatETA(remainingSeconds)} left`;
  }

  function formatSpeed(bytesPerSecond) { return `${formatSize(bytesPerSecond)}/s`; }

  function formatPercent(percent) {
    if (!Number.isFinite(percent)) return '0%';
    const rounded = Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
  }

  // Both the compact stats bar and the focus view show the same trace.
  function drawSpeedChart() {
    for (const canvas of [$('#speed-chart'), $('#dl-focus-chart')]) {
      if (canvas) drawSpeedChartInto(canvas);
    }
  }

  function drawSpeedChartInto(canvas) {
    const ctx = canvas.getContext('2d');

    // Match the backing store to the CSS box and the display's pixel ratio, or
    // the sparkline renders soft on every modern screen.
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width || 190));
    const h = Math.max(1, Math.round(rect.height || 46));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const data = state.speedHistory.slice(-72);
    const styles = getComputedStyle(document.documentElement);
    const primary = styles.getPropertyValue('--primary').trim() || THEME_DEFAULTS.accent;

    // Baseline grid — three faint rules give the sparkline a sense of scale.
    ctx.strokeStyle = 'rgba(236, 231, 221, 0.06)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const y = Math.round((h / 4) * i) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    if (data.length < 2) return;

    // Headroom above the peak so the trace never touches the top edge.
    const max = Math.max(...data, 0.01) * 1.15;
    const pointAt = (i) => ({
      x: (i / (data.length - 1)) * w,
      y: h - (data[i] / max) * (h - 6) - 3,
    });

    // Catmull-Rom-ish smoothing: midpoints joined with quadratic curves.
    const trace = () => {
      ctx.beginPath();
      const first = pointAt(0);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < data.length; i++) {
        const prev = pointAt(i - 1);
        const curr = pointAt(i);
        ctx.quadraticCurveTo(prev.x, prev.y, (prev.x + curr.x) / 2, (prev.y + curr.y) / 2);
      }
      const last = pointAt(data.length - 1);
      ctx.lineTo(last.x, last.y);
    };

    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, hexToRgba(primary, 0.34));
    gradient.addColorStop(1, hexToRgba(primary, 0.02));

    trace();
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    trace();
    ctx.strokeStyle = primary;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // Live dot on the newest sample.
    const head = pointAt(data.length - 1);
    ctx.beginPath();
    ctx.arc(head.x - 1.5, head.y, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = primary;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(head.x - 1.5, head.y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(primary, 0.22);
    ctx.fill();
  }

  // ─── Download Listeners ─────────────────────────────
  function setupDownloadListeners() {
    api.onDownloadProgress((msg) => log(msg));

    api.onDownloadAuthChallenge((challenge) => {
      if (!challenge) return;
      log(`[AUTH] ${challenge.message}`, 'accent');
      showDownloadAuthPrompt(challenge);
    });

    api.onDownloadPercentage((pct) => {
      const safePct = Math.max(0, Math.min(100, Math.round((Number(pct) || 0) * 10) / 10));
      state.currentPercent = safePct;
      recordProgressSample(safePct);
      $('#dl-pct-text').textContent = formatPercent(safePct);
      $('#dl-progress-fill').style.width = `${safePct}%`;

      const active = state.queue.find(j => j.status === 'processing');
      if (active) {
        active.percent = safePct;
        const fills = $$('.queue-card.active .queue-card-fill');
        fills.forEach(f => f.style.width = `${safePct}%`);
      }

      updateETA();
      setTaskbarProgress(safePct / 100);
      emitDownloadState({ percent: safePct });
    });

    api.onDownloadSpeed((speed) => {
      pushSpeedSample(speed);
    });

    // Disk throughput is only worth showing when it diverges from the line
    // rate — during an update, where most bytes come off the local disk rather
    // than the network. Showing two near-identical numbers on a plain download
    // would just be noise.
    // A game update quietly restores the publisher's own DLLs, undoing online
    // mode. It gets put back at launch — say so, because a silent repair looks
    // identical to nothing having gone wrong, until it doesn't.
    api.onOnlineReapplied?.(({ name, success, reasons }) => {
      if (success) {
        toast(`Online mode restored for ${name || 'this game'} — a game update had reset it`, 'success');
        log(`♻ Online mode reapplied: ${(reasons || []).join('; ')}`, 'accent');
      } else {
        toast(`Online mode could not be restored for ${name || 'this game'}`, 'error');
      }
    });

    api.onDownloadTransferred?.((bytes) => {
      if (!Number.isFinite(bytes)) return;
      state.wireBytes = bytes;
      updateDownloadSizeText();
    });

    api.onDownloadDiskSpeed?.((diskSpeed) => {
      state.diskSpeed = diskSpeed;
      const el = $('#dl-disk-speed');
      const sep = $('.dl-disk-sep');
      if (el) {
        el.classList.remove('hidden');
        sep?.classList.remove('hidden');
        el.textContent = `💾 ${diskSpeed}`;
      }
      // The focus view is what's actually on screen during a download, and it
      // renders from this event — without it the figure only ever reached the
      // stats bar underneath, which is hidden at the time.
      emitDownloadState();
    });

    // The engine has diffed the old and new builds and knows what this update
    // actually costs. Until now the headline was the size of the whole install,
    // which made every patch look like a reinstall.
    api.onDownloadPlan?.((plan) => {
      if (!plan || !Number.isFinite(plan.downloadBytes)) return;
      state.updatePlan = plan;
      // remainingBytes is the engine's own progress denominator. Adding
      // downloadBytes to localBytes instead looks equivalent and is not:
      // compressed-per-chunk plus uncompressed-per-destination, so the size
      // text and ETA disagreed with the bar they sit under.
      state.currentTotalBytes = Math.max(1, Number.isFinite(plan.remainingBytes)
        ? plan.remainingBytes
        : plan.downloadBytes + (plan.localBytes || 0));
      state.currentTotalBytesEstimated = false;
      state.awaitingUpdatePlan = false;
      updateDownloadSizeText();
      const parts = [`↓ ${formatSize(plan.downloadBytes)} to download`];
      if (plan.localBytes) parts.push(`${formatSize(plan.localBytes)} from your disk`);
      if (plan.unchangedBytes) parts.push(`${formatSize(plan.unchangedBytes)} untouched`);
      log(`📊 Update: ${parts.join(' · ')} (install is ${formatSize(plan.installBytes)})`, 'accent');
    });

    api.onDownloadComplete(async () => {
      dismissDownloadAuthPrompt();
      const active = state.queue.find(j => j.status === 'processing');
      const doneMessage = active?.jobType === 'repair' ? 'Verify / repair complete!' : active?.jobType === 'update' ? 'Update complete!' : 'Download complete!';
      const finishedName = active?.name || '';
      log(`✅ ${doneMessage}`, 'success');
      toast(finishedName ? `${finishedName} — ${doneMessage}` : doneMessage, 'success', {
        action: active?.destPath ? { label: 'Open', run: () => openPath(active.destPath) } : null,
      });
      if (state.settings.notify_on_complete !== false) {
        notify('Librarian', finishedName ? `${finishedName} — ${doneMessage}` : doneMessage);
      }
      emit('celebrate', { name: finishedName });
      if (api.flashWindow) { try { api.flashWindow(); } catch {} }
      // A Denuvo game that has just been downloaded or updated needs the
      // member's release for its new build; remembered here, acted on once
      // the library has been rescanned and the game's build is known.
      // Part of auto-crack, so it follows the same switch and the same
      // per-job opt-out; a repair counts too, since it puts originals back.
      if (active && active.jobType !== 'csrin' && !active.skipAutoCrack && state.settings.auto_crack) {
        const appid = safeAppId(state.currentGameData?.appid || active.appid);
        if (appid) state.csrinPending.push({ appid, name: state.currentGameData?.game_name || active.name });
      }
      if (active) {  await removeJob(active.id); }
      cleanupGameDataTemp(state.currentGameData);
      state.currentGameData = null;
      state.isProcessing = false; state.isPaused = false;
      state.currentPercent = 0;
      state.smoothedSpeed = 0;
      state.lastSpeedSampleAt = 0;
      state.lastNonzeroSpeedAt = 0;
      state.speedHistory = [];
      state.currentTotalBytes = 0;
      state.currentTotalBytesEstimated = false;
      state.awaitingUpdatePlan = false;
      state.updatePlan = null;
      state.wireBytes = 0;
      state.progressHistory = [];
      hideDlStats(); updateQueueUI(); updateBadge(); processNextJob();
    });

    api.onDownloadError(async (err) => {
      dismissDownloadAuthPrompt();
      log(`❌ ${err}`, 'error');
      toast('Download failed!', 'error');
      const active = state.queue.find(j => j.status === 'processing');
      if (active) await failJob(active, err);
      cleanupGameDataTemp(state.currentGameData);
      state.currentGameData = null;
      state.isProcessing = false; state.isPaused = false;
      state.currentPercent = 0;
      state.smoothedSpeed = 0;
      state.lastSpeedSampleAt = 0;
      state.lastNonzeroSpeedAt = 0;
      state.speedHistory = [];
      state.currentTotalBytes = 0;
      state.currentTotalBytesEstimated = false;
      state.awaitingUpdatePlan = false;
      state.updatePlan = null;
      state.wireBytes = 0;
      state.progressHistory = [];
      hideDlStats(); updateQueueUI(); updateBadge(); processNextJob();
    });
  }

  // ─── Search / Store Page ────────────────────────────
  function setupSearchPage() {
    const BLACKLIST = ['soundtrack', 'ost', 'original soundtrack', 'artbook', 'demo', 'dedicated server', 'tool', 'sdk'];
    const inp = $('#search-input');

    // Without a source — no Hubcap key and no steammanifest — the whole
    // Store is inert; say so up front. The sources in effect arrive from the
    // main process, and renderStoreSource() keeps this right as they change.
    renderStoreSource();

    const page = $('#page-store');
    const hero = $('#store-hero');
    const box = $('#store-search-box');
    const results = $('#search-results');
    let lastResults = [];        // what the server returned, before local filtering

    const setMode = (mode) => page?.setAttribute('data-mode', mode);
    const setBusy = (on) => hero?.classList.toggle('busy', on);

    /** Re-trigger a one-shot animation that may already be running. */
    const replay = (el, cls) => {
      if (!el) return;
      el.classList.remove(cls);
      void el.offsetWidth;
      el.classList.add(cls);
    };

    /** Wrap the matched run so it can be picked out of a long title. */
    function highlight(name, query) {
      const at = query ? name.toLowerCase().indexOf(query.toLowerCase()) : -1;
      if (at < 0) return esc(name);
      return esc(name.slice(0, at))
        + `<mark>${esc(name.slice(at, at + query.length))}</mark>`
        + esc(name.slice(at + query.length));
    }

    /** Ghost covers while the request is in flight — a spinner says
     *  "wait", a skeleton says "here is the shape of what is coming". */
    function showSkeletons(count = 12) {
      results.classList.remove('settled');
      results.innerHTML = Array.from({ length: count }, (_, i) => `
        <div class="result-skeleton" style="--i:${i}">
          <div class="sk-art"></div><div class="sk-line"></div><div class="sk-line short"></div>
        </div>`).join('');
    }

    function resultCard(game, index, query) {
      const { id, name } = game;
      const owned = state.games.some(g => String(g.appid) === String(id));

      const card = document.createElement('div');
      card.className = 'result-card';
      card.style.setProperty('--i', index);
      card.dataset.name = name.toLowerCase();
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.setAttribute('aria-label', `Download ${name}`);
      card.innerHTML = `
        <div class="result-art">
          ${artFallbackHtml(name)}
          <img class="result-card-img" src="${esc(steamPortraitUrl(id))}" alt="" loading="lazy">
          <div class="result-shine"></div>
          ${owned ? '<div class="result-badge">In library</div>' : ''}
          <button class="result-card-add" type="button" tabindex="-1">${owned ? 'Download again' : 'Download'}</button>
        </div>
        <div class="result-card-info">
          <div class="result-card-name">${highlight(name, query)}</div>
          <div class="result-card-id">${esc(id)}</div>
        </div>`;

      // The generated cover sits underneath; a real one simply covers it.
      const img = card.querySelector('img');
      img.style.opacity = '0';
      img.onload = () => { img.style.transition = 'opacity 260ms'; img.style.opacity = '1'; };
      attachArtFallback(img, { appid: id }, 'portrait');

      // Tilt toward the cursor. Two custom properties, no layout, and the
      // transform itself stays in the stylesheet where the hover rule is.
      const art = card.querySelector('.result-art');
      card.addEventListener('pointermove', (e) => {
        const r = art.getBoundingClientRect();
        card.style.setProperty('--ry', `${((e.clientX - r.left) / r.width - .5) * 9}deg`);
        card.style.setProperty('--rx', `${(.5 - (e.clientY - r.top) / r.height) * 7}deg`);
      });
      card.addEventListener('pointerleave', () => {
        card.style.setProperty('--ry', '0deg');
        card.style.setProperty('--rx', '0deg');
      });

      // The card opens the store page for the game; the button on it is the
      // shortcut for people who already know what they want. Clicking a
      // search result straight into a download was the old behaviour, and it
      // meant committing to several gigabytes on the strength of a name.
      const openStore = () => {
        if (window.LibrarianStore) window.LibrarianStore.open(id, name);
        else fetchAndQueue(id, name);
      };
      card.onclick = openStore;
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openStore(); }
      });
      card.querySelector('.result-card-add').onclick = (e) => {
        e.stopPropagation();
        fetchAndQueue(id, name);
      };
      return card;
    }

    /**
     * Results are store cards.
     *
     * A search result and a shelf card on the store front are the same thing:
     * a game you do not own yet. Rendering them as two unrelated components
     * meant searching dropped you out of the store and into a list that
     * looked like a different application — different shape, different
     * chips, different way in. They are built from the same component now,
     * so a search is the store, filtered.
     *
     * The old resultCard path stays as the fallback for the case where
     * js/store.js failed to load: better a plain list than no results.
     */
    function renderResults(games, query) {
      results.classList.remove('settled');
      const store = window.LibrarianStore;

      if (store?.cardHtml) {
        results.dataset.view = 'store';
        const asItem = (g) => ({ id: g.id, name: g.name, header: steamHeaderUrl(g.id), price: '', discount: 0, score: null, players: 0 });
        // The first hit is the answer most of the time — a search is usually
        // for one exact title — so it gets the store's own treatment: wide,
        // art full-bleed, the name set large, with Install right there.
        // The rest are the shelf cards, in a grid.
        const lead = store.leadHtml ? store.leadHtml(asItem(games[0]), query) : '';
        results.innerHTML = lead + games
          .slice(lead ? 1 : 0)
          .map((g, i) => store.cardHtml(asItem(g), 'plain', i))
          .join('');
        store.wireCards(results);
      } else {
        delete results.dataset.view;
        results.innerHTML = '';
        games.forEach((g, i) => results.appendChild(resultCard(g, i, query)));
      }

      // A renderer that was hidden while this ran never plays the entrance
      // animation, which would strand every card at opacity 0. Settle them
      // on a timer — deliberately not requestAnimationFrame, which is what
      // stalls in the first place.
      setTimeout(() => results.classList.add('settled'), 1400);
    }

    function emptyState(title, hint) {
      results.classList.add('settled');
      results.innerHTML = `
        <div class="store-empty">
          <div class="se-mark">⌕</div>
          <div class="se-title">${esc(title)}</div>
          <div class="se-hint">${esc(hint)}</div>
        </div>`;
    }

    async function runSearch(q) {
      setMode('results');
      setBusy(true);
      showSkeletons();
      $('#search-status').textContent = `Searching for “${q}”…`;
      inp.disabled = true;

      let res;
      try {
        res = await api.searchGames(q);
      } catch (e) {
        setBusy(false);
        showSearchError(`Search failed: ${e.message}`, q);
        inp.disabled = false; inp.focus();
        return;
      }
      setBusy(false);
      inp.disabled = false; inp.focus();

      if (!res || res.error) { showSearchError(res?.error || 'Unknown error', q); return; }

      let filtered = 0;
      lastResults = (res.results || []).filter((g) => {
        const name = g.game_name || '';
        const id = safeAppId(g.game_id);
        if (!id || BLACKLIST.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(name))) { filtered++; return false; }
        return true;
      }).map(g => ({ id: safeAppId(g.game_id), name: g.game_name || '' }));

      if (!lastResults.length) {
        replay(box, 'shake');
        $('#search-status').textContent = filtered ? `0 of ${filtered} results shown` : 'No results.';
        emptyState(`Nothing found for “${q}”`,
          res.warning ? `One source did not answer — ${res.warning}. Try again, or the exact title.`
            : filtered ? 'Everything that came back was a soundtrack, demo or tool. Try the exact title, or paste an AppID.'
              : 'Try a shorter query, the exact title, or paste an AppID.');
        noteSearchWarning(res.warning);
        return;
      }

      renderResults(lastResults, q);
      setStatusCount(lastResults.length, filtered);
      noteSearchWarning(res.warning);
    }

    /**
     * One source answered and the other did not. The results are real, so
     * they are shown; but a search that quietly covers half of what it
     * usually does should say so rather than look complete.
     */
    function noteSearchWarning(warning) {
      if (!warning) return;
      const status = $('#search-status');
      if (!status) return;
      const note = document.createElement('span');
      note.className = 'search-error';
      note.style.marginLeft = '8px';
      note.textContent = `⚠ ${warning}`;
      status.appendChild(note);
    }

    /** Count that ticks up rather than snapping — it draws the eye to the
     *  one number on screen that just changed. */
    function setStatusCount(shown, filtered) {
      const status = $('#search-status');
      status.innerHTML = `<span class="hit-count">0</span> result${shown === 1 ? '' : 's'}`
        + (filtered ? ` · ${filtered} hidden` : '');
      tweenNumber(status.querySelector('.hit-count'), 0, shown, 460, v => String(Math.round(v)));
    }

    function showSearchError(message, lastQuery) {
      const status = $('#search-status');
      status.innerHTML = `<span class="search-error">⚠ ${esc(message)}</span> `;
      const retry = document.createElement('button');
      retry.className = 'xbox-btn xbox-btn-secondary btn-sm';
      retry.textContent = 'Retry';
      retry.onclick = () => runSearch(lastQuery);
      status.appendChild(retry);
      results.classList.add('settled');
      results.innerHTML = '';
    }

    /** Narrow what is already on screen instantly. The server is only asked
     *  again on Enter, so typing stays free. */
    function filterVisible(term) {
      if (!lastResults.length) return;
      const t = term.toLowerCase();
      let shown = 0;
      results.querySelectorAll('.result-card').forEach((card) => {
        const hit = !t || card.dataset.name.includes(t);
        card.classList.toggle('filtered-out', !hit);
        if (hit) shown++;
      });
      const status = $('#search-status');
      if (t) status.innerHTML = `<span class="hit-count">${shown}</span> of ${lastResults.length} shown · press Enter to search again`;
      else setStatusCount(lastResults.length, 0);
    }

    /** The field is also filled programmatically — by a recent chip, by the
     *  command palette — so the clear button can't key off input events. */
    const syncField = () => box?.classList.toggle('filled', inp.value.length > 0);

    inp.addEventListener('input', () => {
      syncField();
      replay(box, 'typing');
      filterVisible(inp.value.trim());
    });

    $('#store-search-clear')?.addEventListener('click', () => {
      inp.value = '';
      box?.classList.remove('filled');
      lastResults = [];
      results.innerHTML = '';
      results.classList.add('settled');
      $('#search-status').textContent = '';
      setMode('hero');
      inp.focus();
    });

    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && inp.value) { e.preventDefault(); $('#store-search-clear')?.click(); return; }
      if (e.key !== 'Enter') return;
      const q = inp.value.trim();
      if (q.length < 2) { replay(box, 'shake'); return; }
      rememberSearch(q);
      runSearch(q);
    });

    // Recent queries, one click to re-run.
    function renderRecentSearches() {
      const host = $('#search-recent');
      if (!host) return;
      const recents = state.settings.recent_searches || [];
      if (!recents.length) { host.innerHTML = ''; return; }
      host.innerHTML = recents.map((q, i) => `<button class="store-chip" style="--i:${i}">${esc(q)}</button>`).join('')
        + `<button class="store-chip" style="--i:${recents.length}" data-clear="1">Clear</button>`;
      host.querySelectorAll('.store-chip').forEach((chip) => {
        chip.onclick = async () => {
          if (chip.dataset.clear) {
            await api.setSetting('recent_searches', []);
            state.settings = await api.getAllSettings();
            renderRecentSearches();
            return;
          }
          inp.value = chip.textContent;
          syncField();
          runSearch(chip.textContent);
        };
      });
    }

    async function rememberSearch(query) {
      const current = state.settings.recent_searches || [];
      const next = [query, ...current.filter(q => q.toLowerCase() !== query.toLowerCase())].slice(0, 8);
      try {
        await api.setSetting('recent_searches', next);
        state.settings = await api.getAllSettings();
        renderRecentSearches();
      } catch { /* history is a nicety, not a requirement */ }
    }

    renderRecentSearches();
    state.storeSearch = (query) => { inp.value = query; syncField(); rememberSearch(query); runSearch(query); };
  }

  // Hubcap answers with { results: [{ game_id, game_name }] }. Both the Store
  // page and Big Picture need the same normalising and the same filtering of
  // soundtracks and tools, so it lives here rather than being written twice.
  const STORE_BLACKLIST = ['soundtrack', 'ost', 'original soundtrack', 'artbook', 'demo', 'dedicated server', 'tool', 'sdk'];

  async function searchStoreCatalog(query) {
    const term = String(query || '').trim();
    if (term.length < 3) return { error: 'Search for at least three characters.', results: [] };
    if (!storeSourcesReady()) {
      return { error: 'No manifest source is set up: add a Hubcap API key in Settings, or restore the steammanifest folder.', results: [] };
    }

    let res;
    try {
      res = await api.searchGames(term);
    } catch (e) {
      return { error: `Search failed: ${e.message}`, results: [] };
    }
    if (!res || res.error) return { error: res?.error || 'Unknown error', results: [] };

    const results = (res.results || []).map((g) => ({
      id: safeAppId(g.game_id),
      name: g.game_name || '',
    })).filter(({ id, name }) => (
      id && !STORE_BLACKLIST.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(name))
    ));

    return res.warning ? { results, warning: res.warning } : { results };
  }

  async function fetchAndQueue(appId, name) {
    navigateTo('downloads');
    log(`🔄 Fetching manifest for ${name}...`);
    let res;
    try {
      res = await api.downloadManifest(appId);
    } catch (e) {
      log(`❌ Manifest fetch failed: ${e.message}`, 'error');
      toast(`Failed to fetch manifest: ${e.message}`, 'error');
      return;
    }
    if (!res || res.error) { log(`❌ ${res?.error || 'Unknown error'}`, 'error'); toast(`Failed: ${res?.error || 'Unknown error'}`, 'error'); return; }
    if (res.filepath) {
      log(manifestReadyLine(res), res.stale ? 'accent' : 'success');
      if (res.stale) toast(`${name}: Hubcap's package is behind Steam and the latest could not be assembled — downloading the older build`, 'error', { duration: 9000 });
      addToQueue(name, res.filepath, { appid: appId, managedZip: true });
    }
  }

  // ─── steammanifest ──────────────────────────────────
  // The local manifest source beside Hubcap (src/core/steamManifest.js).
  // The main process says which sources are in effect for the Manifest
  // source setting; the Store gates on that rather than on the Hubcap key
  // alone, and the source's progress lines while it checks Hubcap's package
  // against Steam or assembles the latest go to the download log.
  async function refreshSteamManifestStatus() {
    if (!api.steamManifestStatus) return;
    try {
      const st = await api.steamManifestStatus();
      state.steamManifest = { ...state.steamManifest, ...(st || {}), sources: Array.isArray(st?.sources) ? st.sources : [] };
    } catch (e) {
      state.steamManifest = { ...state.steamManifest, available: false, sources: [], error: e.message };
    }
    document.documentElement.dataset.manifestSource = state.steamManifest.sources.join('+') || 'none';
    renderStoreSource();
    renderSteamManifestSettingsStatus();
  }

  function setupSteamManifest() {
    api.onSteamManifestLog?.((line) => { if (typeof line === 'string' && line) log(line); });
    return refreshSteamManifestStatus();
  }

  function storeSourcesReady() { return state.steamManifest.sources.length > 0; }

  function storeSourceLabel() {
    const s = state.steamManifest.sources;
    if (s.includes('hubcap') && s.includes('steammanifest')) return 'Hubcap and Steam';
    if (s.includes('steammanifest')) return 'Steam';
    if (s.includes('hubcap')) return 'Hubcap';
    return '';
  }

  /** The Store's subtitle names the source in effect; without one, the status line says what to set up. */
  function renderStoreSource() {
    const sub = $('#store-sub');
    if (sub) sub.textContent = storeSourcesReady() ? `Search ${storeSourceLabel()} by name or AppID.` : 'No manifest source is set up yet.';
    const status = $('#search-status');
    if (!status) return;
    if (status.dataset.gate === 'source') { status.innerHTML = ''; delete status.dataset.gate; }
    if (!storeSourcesReady() && !status.textContent) {
      status.dataset.gate = 'source';
      status.textContent = 'Store search needs a manifest source: a Hubcap API key, or the steammanifest folder Librarian ships with. ';
      const btn = document.createElement('button');
      btn.className = 'xbox-btn xbox-btn-primary btn-sm';
      btn.textContent = 'Open Settings';
      btn.onclick = () => navigateTo('settings');
      status.appendChild(btn);
    }
  }

  /** "Manifest ready" with what the source did: which answered, and whether Hubcap's package was current, replaced, or kept although behind. */
  function manifestReadyLine(res) {
    const note = res && typeof res.note === 'string' ? res.note.trim().replace(/\.$/, '') : '';
    return note ? `✅ Manifest ready — ${note}.` : '✅ Manifest ready!';
  }

  function renderSteamManifestSettingsStatus() {
    const sm = state.steamManifest;
    const dirLabel = $('#steammanifest-dir-label');
    if (dirLabel) {
      const dir = state.settings.steammanifest_dir || (sm.bundled ? `${sm.bundled} (bundled)` : 'bundled copy');
      dirLabel.textContent = dir;
      dirLabel.title = dir;
    }
    const line = $('#steammanifest-tools-line');
    if (!line) return;
    const names = { hubcap: 'Hubcap', steammanifest: 'steammanifest' };
    const order = (sm.sources || []).map((s) => names[s] || s).join(' → ') || 'none';
    const cat = sm.catalogs || {};
    const catBit = (label, c) => {
      if (!c || !c.enabled) return `${label} off`;
      if (!c.cached) return `${label} on (not yet downloaded)`;
      return `${label} ${c.entries ? c.entries.toLocaleString() : '?'} entries`;
    };
    const catalogs = ` · ${catBit('depot-key catalog', cat.depotKeys)} · ${catBit('app-token catalog', cat.appTokens)}`;
    line.textContent = sm.available
      ? `steammanifest found · ${sm.dir}${sm.version?.copied ? ` · copied ${String(sm.version.copied).slice(0, 10)}` : ''} · ${sm.keysKnown} depot key${sm.keysKnown === 1 ? '' : 's'} known · sources in effect: ${order}${sm.configuredMissing ? ' · the folder set above is not a checkout, so this copy is used' : ''}${catalogs}`
      : `steammanifest missing — ${sm.error || 'expected in deps/steammanifest'} · sources in effect: ${order}${catalogs}`;
  }

  // ─── CS.RIN.RU ──────────────────────────────────────
  // The second source beside Hubcap. The search runs in the main process
  // (src/core/csrin.js) and streams its status lines here; the user picks a
  // post, and one hoster link becomes one queue job that reports through the
  // same download channels as a SteamPipe job.
  function setupCsrin() {
    document.documentElement.dataset.csrin = 'off';
    if (!api.csrinStatus) return;

    api.csrinStatus().then((st) => {
      state.csrin.available = Boolean(st && st.cliExists && st.dlExists);
      state.csrin.downloadDir = st?.downloadDir || '';
      state.csrin.cliPath = st?.cliPath || '';
      document.documentElement.dataset.csrin = state.csrin.available ? 'on' : 'off';
      renderCsrinSettingsStatus();
      if (!state.csrin.available) {
        log(`⚠ CS.RIN.RU tools not found in ${st?.cliPath ? st.cliPath.replace(/[\\/][^\\/]+$/, '') : 'deps/csrin'} — that source is hidden.`);
      }
    }).catch(() => {});

    api.onCsrinLog?.((line) => {
      const box = $('#csrin-log');
      if (!box) return;
      const el = document.createElement('div');
      el.textContent = line;
      box.appendChild(el);
      box.scrollTop = box.scrollHeight;
    });

    // The hoster only states the size once the transfer starts; that is the
    // moment the progress bar gets its denominator.
    api.onCsrinEvent?.((ev) => {
      if (!ev || !state.isProcessing) return;
      if (ev.event === 'download_start') {
        state.csrinPhase = '';
        state.currentTotalBytes = Number(ev.total_bytes) || 0;
        state.currentTotalBytesEstimated = false;
        updateDownloadSizeText();
        emitDownloadState();
      } else if (ev.event === 'choose_folder') {
        showCsrinFolderChoice(ev);
      } else if (ev.event === 'extract_start') {
        // The transfer is done; what follows is the game's files changing.
        state.csrinPhase = 'extract';
        state.currentPercent = 100;
        $('#dl-pct-text').textContent = formatPercent(100);
        $('#dl-progress-fill').style.width = '100%';
        emitDownloadState({ percent: 100 });
      }
    });
  }

  function renderCsrinSettingsStatus() {
    const line = $('#csrin-tools-line');
    if (line) {
      line.textContent = state.csrin.available
        ? `Tools found · ${state.csrin.cliPath}`
        : `Tools missing — expected csrin-cli.exe and csrin-dl.exe in ${state.csrin.cliPath ? state.csrin.cliPath.replace(/[\\/][^\\/]+$/, '') : 'deps/csrin'}`;
    }
    const dirLabel = $('#csrin-dir-label');
    if (dirLabel) {
      const dir = state.settings.csrin_download_dir || state.csrin.downloadDir || '—';
      dirLabel.textContent = dir;
      dirLabel.title = dir;
    }
  }

  function hostOf(link) {
    try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  /**
   * The archive holds several folders and none is named after the game: the
   * main process is waiting for the person to say which one is the game.
   * Closing the dialog answers "none", which keeps the archive and places
   * nothing.
   */
  function showCsrinFolderChoice(ev) {
    const folders = Array.isArray(ev.folders) ? ev.folders : [];
    let answered = false;
    const answer = (folder) => {
      if (answered) return;
      answered = true;
      state.pendingConfirm = null;
      try { api.csrinChooseFolder?.(folder ? { folder } : { cancelled: true }); } catch { /* the job will time out on its own */ }
      $('#modal-close').onclick = () => closeModal();
      closeModal({ force: true });
      log(folder ? `📂 Chosen: "${folder}"` : '⏭ No folder chosen.');
    };
    // Escape and a click on the backdrop go through closeModal, which hands
    // them to pendingConfirm — so dismissing the dialog answers "none"
    // instead of leaving the job waiting for ever.
    state.pendingConfirm = () => answer('');

    toast('Which folder of the archive is the game? Pick one to continue.', '', { duration: 8000 });
    openModal('Which folder is the game?', `
      <div class="csrin-choose">
        <p class="text-dim" style="font-size:13px;margin:0">
          <b class="font-mono">${esc(ev.archive || 'The archive')}</b> holds several folders and none is named after
          <b>${esc(ev.gameName || 'the game')}</b>. Only the folder you pick is placed into
          <span class="font-mono">${esc(ev.extractTo || 'the game folder')}</span>; the others are left in the archive.
        </p>
        <div class="csrin-folder-list">
          ${folders.map((f, i) => `
            <label class="csrin-folder">
              <input type="radio" name="csrin-folder" value="${esc(f.folder)}"${i === 0 ? ' checked' : ''}>
              <span class="csrin-folder-name">${esc(f.folder)}/</span>
              <span class="csrin-folder-meta">${f.files} file${f.files === 1 ? '' : 's'} · ${esc((f.entries || []).join(', '))}${f.more ? `, +${f.more} more` : ''}</span>
            </label>`).join('')}
        </div>
        <div class="modal-actions">
          <button class="xbox-btn xbox-btn-secondary" id="csrin-folder-skip">Skip — keep the archive only</button>
          <button class="xbox-btn xbox-btn-primary" id="csrin-folder-ok">Place this folder</button>
        </div>
      </div>
    `);
    $('#csrin-folder-ok').onclick = () => {
      const picked = document.querySelector('input[name="csrin-folder"]:checked');
      answer(picked ? picked.value : '');
    };
    $('#csrin-folder-skip').onclick = () => answer('');
    $('#modal-close').onclick = () => answer('');
    navigateTo('downloads');
  }

  function csrinCredentialsHint() {
    if (state.settings.csrin_username && state.settings.secrets_present?.csrin_password) return '';
    return `<div class="csrin-hint">No forum account set — the forum hides download links from guests,
      so the search walks the whole thread (a minute or more) and finds posts without their links.
      <a href="#" id="csrin-go-settings" class="settings-link">Add one in Settings</a>.</div>`;
  }

  /**
   * The comparable form of a patch number — the same rule as versionKey in
   * src/core/patchVersion.js: "2.03.02" is "2.3.2", "1.4" is "1.4.0", and
   * anything that is not dotted digits never matches.
   */
  function patchKey(v) {
    const s = String(v || '').trim().replace(/^v\.?/i, '');
    if (!/^\d+(?:\.\d+)*$/.test(s)) return '';
    const parts = s.split('.').map((p) => String(Number(p)));
    while (parts.length > 1 && parts[parts.length - 1] === '0') parts.pop();
    return parts.join('.');
  }

  /**
   * The installed patch of a library game: the one the user stated, or the
   * one the last release placed, else inferred from when the installed build
   * was made and Steam's versioned announcements. Remembered per build.
   */
  async function installedPatchOf(game, { force = false } = {}) {
    if (!game?.install_path) return { version: '', source: 'unknown' };
    state.csrinPatch = state.csrinPatch || new Map();
    const key = `${game.game_key || game.appid || game.install_path}|${game.buildid || ''}`;
    if (!force && state.csrinPatch.has(key)) return state.csrinPatch.get(key);
    let p;
    try {
      p = await api.csrinInstalledPatch({ appid: game.appid, id: game.id, source: game.source, install_path: game.install_path, buildid: game.buildid || '' });
    } catch (e) {
      p = { version: '', source: 'unknown', error: e.message };
    }
    p = p || { version: '', source: 'unknown' };
    state.csrinPatch.set(key, p);
    return p;
  }

  function forgetInstalledPatch(game) {
    if (!state.csrinPatch) return;
    for (const k of [...state.csrinPatch.keys()]) {
      if (k.startsWith(`${game.game_key || game.appid || game.install_path}|`)) state.csrinPatch.delete(k);
    }
  }

  function patchSourceText(p) {
    if (!p || !p.version) return p?.error ? `not known — ${p.error}` : 'not known';
    if (p.source === 'declared') return 'as you stated it';
    if (p.source === 'release') return 'from the release placed into it';
    const when = p.date ? new Date(p.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
    if (p.source === 'steam-previous') return `inferred: this build has no notes of its own, so the last patch before it — “${p.title || 'patch notes'}”${when ? ` (${when})` : ''}`;
    return `inferred from Steam's “${p.title || 'patch notes'}”${when ? ` (${when})` : ''}`;
  }

  /**
   * A release is made for one patch. Compare the post's stated patch with
   * the installed one: 'match' lets it be placed over the game, 'mismatch'
   * refuses, 'unknown' (either side missing) asks. A post that names no
   * patch is compared on its build id, which is all an older post states.
   */
  function csrinPatchMatch(post, game, patch) {
    const posted = String(post?.version || '').trim();
    if (patchKey(posted)) {
      const installed = String(patch?.version || '').trim();
      if (!patchKey(installed)) return { state: 'unknown', by: 'patch', installed, posted };
      return { state: patchKey(installed) === patchKey(posted) ? 'match' : 'mismatch', by: 'patch', installed, posted };
    }
    const installedBuild = String(game?.buildid || '').trim();
    const postedBuild = String(post?.build || '').trim();
    if (!postedBuild) return { state: 'unknown', by: 'patch', installed: String(patch?.version || ''), posted: '' };
    if (!installedBuild) return { state: 'unknown', by: 'build', installed: '', posted: postedBuild };
    return { state: installedBuild === postedBuild ? 'match' : 'mismatch', by: 'build', installed: installedBuild, posted: postedBuild };
  }

  /** The post among `posts` made for `patch` (or, failing a patch, `build`) that has a link. */
  function csrinPostFor(posts, patch, build) {
    const withLinks = (posts || []).filter((p) => (p.links || []).length);
    const k = patchKey(patch);
    if (k) {
      const hit = withLinks.find((p) => patchKey(p.version) === k);
      if (hit) return hit;
    }
    return build ? withLinks.find((p) => !patchKey(p.version) && p.build === String(build)) || null : null;
  }

  /**
   * The picker: a search box over the forum, then the posts to choose from.
   * With a `game` (opened from the library) each post is checked against the
   * installed build and its link can be placed straight into the game folder;
   * without one (the store page) links are only saved to disk.
   */
  function openCsrinPicker(appid, name, options = {}) {
    if (!state.csrin.available) {
      toast('CS.RIN.RU tools are not installed (deps/csrin)', 'error');
      return;
    }
    const game = options.game && options.game.install_path ? options.game : null;
    const query = String(name || game?.game_name || '').trim();
    const author = state.settings.csrin_author || 'ARTIFACT';
    const target = game ? `
      <div class="csrin-target">
        Into <b>${esc(game.game_name || 'this game')}</b>
        <label class="csrin-patch">installed patch
          <input type="text" class="form-input font-mono" id="csrin-patch" placeholder="…" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="24">
        </label>
        <span class="csrin-badge dim">build ${esc(game.buildid || 'unknown')}</span>
        <span class="csrin-target-path font-mono" title="${esc(game.install_path)}">${esc(game.install_path)}</span>
        <span class="csrin-patch-source text-dim" id="csrin-patch-source">Looking up the installed patch…</span>
      </div>` : '';
    openModal('CS.RIN.RU', `
      <div class="csrin-picker">
        ${target}
        <div class="form-group">
          <label>Game, topic URL or topic ID</label>
          <input type="text" class="form-input" id="csrin-game" value="${esc(query)}" placeholder="Game name" autocomplete="off" spellcheck="false">
        </div>
        <div class="csrin-row">
          <div class="form-group" style="flex:1">
            <label>Member whose post to fetch</label>
            <input type="text" class="form-input" id="csrin-author" value="${esc(author)}" placeholder="ARTIFACT" autocomplete="off" spellcheck="false">
          </div>
          <button class="xbox-btn xbox-btn-primary" id="csrin-search">Search</button>
        </div>
        ${csrinCredentialsHint()}
        <div id="csrin-status" class="text-dim" style="font-size:12px"></div>
        <div id="csrin-results"></div>
        <div id="csrin-log" class="crack-log-box hidden"></div>
        <div class="modal-actions">
          <button class="xbox-btn xbox-btn-secondary btn-sm" id="csrin-toggle-log">Show log</button>
        </div>
      </div>
    `);

    $('#csrin-go-settings')?.addEventListener('click', (e) => {
      e.preventDefault();
      closeModal();
      navigateTo('settings');
    });
    $('#csrin-toggle-log').onclick = () => {
      const box = $('#csrin-log');
      const hidden = box.classList.toggle('hidden');
      $('#csrin-toggle-log').textContent = hidden ? 'Show log' : 'Hide log';
      if (!hidden) box.scrollTop = box.scrollHeight;
    };
    const ctx = { appid, game, scanAll: false, patch: null, lastRes: null };
    if (game) {
      // The search does not wait for this: posts render as soon as they
      // arrive and are re-judged once the installed patch is known.
      ctx.patchReady = installedPatchOf(game).then((p) => {
        ctx.patch = p;
        const input = $('#csrin-patch');
        if (!input) return p;
        input.value = p.version || '';
        $('#csrin-patch-source').textContent = patchSourceText(p);
        if (ctx.lastRes) renderCsrinResults(ctx.lastRes, ctx.lastCtx);
        return p;
      });
      // Stating the patch by hand: kept for this build, and it outranks the
      // inference everywhere the release is matched.
      const commit = async () => {
        const input = $('#csrin-patch');
        const v = input.value.trim();
        if (v === String(ctx.patch?.version || '')) return;
        if (v && !patchKey(v)) { toast('A patch number is digits and dots, like 2.03.02', 'error'); input.value = ctx.patch?.version || ''; return; }
        const r = await api.csrinSetInstalledPatch({ appid: game.appid, id: game.id, source: game.source, install_path: game.install_path, buildid: game.buildid || '' }, v);
        if (!r?.success) { toast(r?.error || 'Could not save the patch', 'error'); return; }
        forgetInstalledPatch(game);
        ctx.patch = v ? { version: v, source: 'declared' } : await installedPatchOf(game);
        if (!document.body.contains(input)) return;
        input.value = ctx.patch.version || '';
        $('#csrin-patch-source').textContent = patchSourceText(ctx.patch);
        if (ctx.lastRes) renderCsrinResults(ctx.lastRes, ctx.lastCtx);
      };
      $('#csrin-patch').onchange = commit;
      $('#csrin-patch').onkeydown = (e) => { if (e.key === 'Enter') e.currentTarget.blur(); };
    }
    const run = () => runCsrinSearch(ctx);
    $('#csrin-search').onclick = () => { ctx.scanAll = false; run(); };
    $('#csrin-game').onkeydown = (e) => { if (e.key === 'Enter') run(); };
    $('#csrin-author').onkeydown = (e) => { if (e.key === 'Enter') run(); };
    // The modal closing mid-crawl should not leave the crawler running.
    $('#modal-close').onclick = () => { api.csrinCancelSearch?.(); closeModal(); };
    if (query) run();
  }

  async function runCsrinSearch(ctx) {
    const btn = $('#csrin-search');
    const status = $('#csrin-status');
    const results = $('#csrin-results');
    const logBox = $('#csrin-log');
    if (!btn || !status || !results) return;

    const query = $('#csrin-game').value.trim();
    const author = $('#csrin-author').value.trim() || 'ARTIFACT';
    if (!query) { toast('Type a game name first', 'error'); return; }

    btn.disabled = true;
    btn.textContent = 'Searching…';
    ctx.lastRes = null;
    results.innerHTML = '';
    if (logBox) logBox.innerHTML = '';
    status.textContent = ctx.scanAll
      ? `Walking the whole thread for every post by ${author} — this takes a while…`
      : `Searching the forum for “${query}” and the latest post by ${author}…`;

    const isUrl = /^https?:\/\//i.test(query);
    const isId = /^\d{3,}$/.test(query);
    const base = isUrl ? { topicUrl: query, author } : isId ? { topicId: query, author } : { game: query, author };
    let res;
    try {
      res = await api.csrinSearch({ ...base, scanAll: Boolean(ctx.scanAll) });
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    // The picker may have been closed while the crawl ran.
    if (!document.body.contains(btn)) return;
    btn.disabled = false;
    btn.textContent = 'Search';

    if (!res || !res.ok) {
      status.textContent = `❌ ${res?.error || 'Search failed'}`;
      if (logBox && logBox.children.length) { logBox.classList.remove('hidden'); $('#csrin-toggle-log').textContent = 'Hide log'; }
      return;
    }
    if (res.loginFailed) toast('CS.RIN.RU login failed — check the account in Settings', 'error');
    // The same object, so a patch that resolves later re-judges these posts.
    Object.assign(ctx, { query, author, lastRes: res });
    ctx.lastCtx = ctx;
    renderCsrinResults(res, ctx);
  }

  function csrinBadgeHtml(match, post) {
    const build = post.build ? ` · build ${esc(post.build)}` : '';
    if (!match) return post.build || post.version ? `<span class="csrin-badge dim">${post.version ? `patch ${esc(post.version)}` : 'patch not stated'}${build}</span>` : '';
    const what = match.by === 'build' ? 'build' : 'patch';
    if (match.state === 'match') return `<span class="csrin-badge ok">✓ ${what} ${esc(match.posted)} matches the install${match.by === 'build' ? '' : build}</span>`;
    if (match.state === 'mismatch') return `<span class="csrin-badge bad">✕ ${what} ${esc(match.posted)} ≠ installed ${esc(match.installed)}${match.by === 'build' ? '' : build}</span>`;
    return `<span class="csrin-badge warn">? ${what} ${esc(match.posted || 'not stated')} · installed ${esc(match.installed || 'unknown')}${match.by === 'build' ? '' : build}</span>`;
  }

  function renderCsrinResults(res, ctx) {
    const status = $('#csrin-status');
    const results = $('#csrin-results');
    const posts = Array.isArray(res.posts) ? res.posts : [];
    const topics = Array.isArray(res.topics) ? res.topics : [];
    const game = ctx.game || null;

    if (!posts.length) {
      status.textContent = topics.length
        ? `Found ${topics.length} topic(s), but no post by ${ctx.author} in them.`
        : `No topic found for “${ctx.query}”.`;
      results.innerHTML = topics.slice(0, 8).map((t) =>
        `<div class="csrin-topic"><a href="#" data-topic="${esc(t.url)}">${esc(t.title)}</a></div>`).join('');
      results.querySelectorAll('[data-topic]').forEach((a) => {
        a.onclick = (e) => { e.preventDefault(); $('#csrin-game').value = a.dataset.topic; runCsrinSearch(ctx); };
      });
      return;
    }

    const matches = game ? posts.map((p) => csrinPatchMatch(p, game, ctx.patch)) : posts.map(() => null);
    const anyMatch = matches.some((m) => m && m.state === 'match');
    status.textContent = `${posts.length} post(s) by ${ctx.author}${res.authenticated ? '' : ' · not logged in'}`
      + (game && !anyMatch ? (ctx.patch ? ` · none is for patch ${ctx.patch.version || '?'}` : ' · looking up the installed patch…') : '');

    results.innerHTML = posts.map((p, i) => {
      const match = matches[i];
      const links = p.links || [];
      const buttons = links.map((l) => {
        const what = l.attachment
          ? `${esc(l.label || 'attachment')}${l.size ? ` · ${esc(l.size)}` : ''}`
          : `${l.label ? `${esc(l.label)} · ` : ''}${esc(l.host || 'link')}`;
        if (!game) {
          return `<button class="xbox-btn xbox-btn-primary btn-sm" data-dl="${esc(l.url)}" data-post="${p.index}" title="${esc(l.url)}">⬇ ${what}</button>`;
        }
        const blocked = match.state === 'mismatch';
        const title = blocked
          ? `This release is for ${match.by} ${match.posted}; the installed game is ${match.by} ${match.installed}.${match.by === 'patch' ? ' If the installed patch is wrong, correct it above.' : ''}`
          : match.state === 'unknown' ? `The ${match.by} could not be compared; you will be asked to confirm.` : l.url;
        return `<button class="xbox-btn xbox-btn-primary btn-sm" data-dl="${esc(l.url)}" data-post="${p.index}" data-install="1" title="${esc(title)}"${blocked ? ' disabled' : ''}>📦 Install ${what}</button>`
          + `<button class="xbox-btn xbox-btn-secondary btn-sm" data-dl="${esc(l.url)}" data-post="${p.index}" title="Save the archive to the download folder without touching the game">⬇ Save only</button>`;
      }).join('');
      return `
      <article class="csrin-post${match ? ` is-${match.state}` : ''}">
        <div class="csrin-post-head">
          <b>${esc(p.subject && p.subject !== 'No Subject' ? p.subject : (p.topicTitle || 'Post'))}</b>
          <span class="text-dim">${esc(p.author)} · ${esc(p.date)}${p.page ? ` · page ${p.page}` : ''}</span>
        </div>
        ${csrinBadgeHtml(match, p)}
        <pre class="csrin-post-body">${esc(p.excerpt)}${p.excerptCut ? '…' : ''}</pre>
        <div class="csrin-post-links">
          ${buttons}
          ${!links.length ? `<span class="text-dim" style="font-size:12px">${p.linksHidden ? 'Links hidden — log in to see them.' : 'No download link in this post.'}</span>` : ''}
          ${p.url ? `<button class="xbox-btn xbox-btn-secondary btn-sm" data-open="${esc(p.url)}">Open post</button>` : ''}
        </div>
      </article>`;
    }).join('')
    // The quick search stops at the newest post with a link. When that one is
    // for another build, the older posts are where the right one lives.
    + (game && !anyMatch && !res.scannedAll
      ? `<div class="csrin-topic"><button class="xbox-btn xbox-btn-secondary btn-sm" id="csrin-scan-all">Walk the whole thread for other patches</button></div>`
      : '');

    results.querySelectorAll('[data-dl]').forEach((b) => {
      b.onclick = async () => {
        const post = posts.find((p) => String(p.index) === b.dataset.post) || null;
        const link = (post?.links || []).find((l) => l.url === b.dataset.dl) || { url: b.dataset.dl, label: '', host: hostOf(b.dataset.dl) };
        const install = b.dataset.install === '1' && game;
        if (install) {
          if (!ctx.patch && ctx.patchReady) await ctx.patchReady;
          const match = csrinPatchMatch(post, game, ctx.patch);
          if (match.state === 'mismatch') { toast(`${match.by === 'build' ? 'Build' : 'Patch'} ${match.posted} does not match the installed ${match.installed}`, 'error'); return; }
          if (match.state === 'unknown') {
            const ok = await showConfirm(match.by === 'build' ? 'Build not compared' : 'Patch not compared',
              `${match.posted ? `The post is for ${match.by} ${match.posted}` : 'The post states no patch'} and ${match.installed ? `the game is ${match.by} ${match.installed}` : `the installed ${match.by} is unknown`}. Place the files into ${game.install_path} anyway? Replaced files are kept as .csrin.bak.`,
              { confirmLabel: 'Install anyway', cancelLabel: 'Back', danger: true });
            if (!ok) return;
          }
        }
        queueCsrinDownload({ url: link.url, appid: ctx.appid, name: ctx.query, post, link, game: install ? game : null, patch: install ? ctx.patch : null });
      };
    });
    results.querySelectorAll('[data-open]').forEach((b) => {
      b.onclick = () => api.openExternal(b.dataset.open);
    });
    const scanAll = $('#csrin-scan-all');
    if (scanAll) scanAll.onclick = () => { ctx.scanAll = true; runCsrinSearch(ctx); };
  }

  /**
   * One link becomes one queue job. With a `game` the archive's folder for
   * that game is placed over the install once downloaded; without one the
   * archive is only saved.
   */
  function queueCsrinDownload({ url, appid, name, post, link, game, patch = null }) {
    const already = state.queue.some((j) => j.jobType === 'csrin' && j.csrin?.url === url
      && (j.status === 'queued' || j.status === 'processing'));
    if (already) { toast('That link is already queued', 'error'); return; }
    closeModal();
    if (game) closeFlyout();
    const plainName = name && !/^https?:/i.test(name) && !/^\d+$/.test(name) ? name : '';
    const jobName = game?.game_name || plainName || post?.topicTitle || 'CS.RIN.RU download';
    addToQueue(jobName, null, {
      jobType: 'csrin',
      appid: safeAppId(appid || game?.appid) || null,
      csrin: {
        url,
        postUrl: post?.url || '',
        host: hostOf(url),
        label: link?.label || '',
        extractTo: game?.install_path || '',
        expectedBuild: game?.buildid || '',
        postBuild: post?.build || '',
        expectedVersion: game ? (patch?.version || '') : '',
        postVersion: post?.version || '',
        gameId: game?.id || '',
        gameSource: game?.source || '',
        sha256: post?.sha256 || '',
      },
    });
  }

  /** The download half: one link into one folder, reporting like any job. */
  async function processCsrinJob(job) {
    const link = job.csrin?.url;
    const bail = async (message) => {
      log(`❌ ${message}`, 'error');
      await failJob(job, message);
      processNextJob();
    };
    if (!link) { bail('This CS.RIN.RU job has no link.'); return; }

    state.currentGameData = null;
    state.currentTotalBytes = 0;
    state.currentTotalBytesEstimated = false;
    state.awaitingUpdatePlan = false;
    state.updatePlan = null;
    state.wireBytes = 0;
    state.currentPercent = 0;
    state.speedHistory = [];
    state.progressHistory = [];
    state.csrinPhase = '';

    const archiveDir = state.settings.csrin_download_dir || state.csrin.downloadDir;
    if (!archiveDir) { bail('No download folder is set for CS.RIN.RU.'); return; }
    const extractTo = job.csrin.extractTo || '';
    // The folder the job is "for": the game when it is being placed into
    // one, otherwise where the archive lands. It is what "Open" opens.
    job.destPath = extractTo || archiveDir;

    log(`🌐 ${job.csrin.label ? `${job.csrin.label} · ` : ''}${job.csrin.host || 'hoster'} → ${archiveDir}`);
    if (job.csrin.postUrl) log(`🔗 ${job.csrin.postUrl}`);
    if (extractTo) {
      log(job.csrin.postVersion
        ? `📦 Then into ${extractTo} — release for patch ${job.csrin.postVersion}${job.csrin.expectedVersion ? `, installed patch ${job.csrin.expectedVersion}` : ''}`
        : `📦 Then into ${extractTo}${job.csrin.postBuild ? ` — release build ${job.csrin.postBuild}` : ''}${job.csrin.expectedBuild ? `, installed build ${job.csrin.expectedBuild}` : ''}`);
    }
    setDlName(job.name);
    state.downloadStartTime = Date.now();
    showDownloadDestination(job.destPath, 0);
    updateDownloadSizeText();
    updateQueueUI();
    emitDownloadState();

    let res;
    try {
      res = await api.csrinDownload({
        jobId: job.id, appid: job.appid,
        url: link,
        outputDir: archiveDir,
        extractTo,
        gameName: job.name,
        expectedBuild: job.csrin.expectedBuild || '',
        postBuild: job.csrin.postBuild || '',
        expectedVersion: job.csrin.expectedVersion || '',
        postVersion: job.csrin.postVersion || '',
        gameId: job.csrin.gameId || '',
        gameSource: job.csrin.gameSource || '',
        sha256: job.csrin.sha256 || '',
      });
    } catch (e) {
      res = { success: false, error: e.message };
    }
    if (!res || !res.success) bail(res?.error || 'Could not start the download.');
  }

  // ─── What's new ─────────────────────────────────────
  // Two feeds, one dialog: Denuvo titles arriving on Steam's front page, and
  // the followed member's posts on CS.RIN.RU. The main process fetches
  // (src/core/newsFeed.js); this decides what is unseen, shows it once, and
  // keeps a button on the Store to bring it back.
  const NEWS_EVERY = 6 * 60 * 60 * 1000;

  function setupNews() {
    state.news = { items: [], checkedAt: 0, unseen: 0, loading: false, errors: [] };
    const btn = $('#store-news-btn');
    if (btn) btn.onclick = () => openNewsModal({ all: true });
    if (!api.fetchNews) return;
    // After the library scan and the first paint; the forum and Steam can
    // take a few seconds and nothing here is urgent.
    setTimeout(() => { void refreshNews({ show: true }); }, 9000);
    setInterval(() => { void refreshNews({ show: true }); }, NEWS_EVERY);
  }

  async function refreshNews({ show = false } = {}) {
    if (state.news.loading) return state.news;
    state.news.loading = true;
    let res = null;
    try { res = await api.fetchNews(); } catch { res = null; }
    state.news.loading = false;
    if (!res) return state.news;

    state.news.items = [...(res.denuvo?.items || []), ...(res.csrin?.items || [])];
    state.news.checkedAt = res.checkedAt || Date.now();
    state.news.errors = [res.denuvo?.error, res.csrin?.error].filter(Boolean);
    const seen = new Set(state.settings.news_seen || []);
    state.news.unseen = state.news.items.filter((it) => !seen.has(it.id)).length;
    paintNewsBadge();

    const modalUp = !$('#modal-overlay').classList.contains('hidden');
    if (show && state.news.unseen && state.settings.news_enabled !== false && !modalUp && !state.isProcessing) {
      openNewsModal({ all: false });
    }
    return state.news;
  }

  function paintNewsBadge() {
    const count = $('#store-news-count');
    const btn = $('#store-news-btn');
    if (!count || !btn) return;
    count.textContent = String(state.news.unseen || 0);
    count.classList.toggle('hidden', !state.news.unseen);
    btn.classList.toggle('has-new', Boolean(state.news.unseen));
  }

  function normalizeGameName(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  /** The installed game a forum post is about, if any. */
  function newsMatchInstalled(item) {
    const want = normalizeGameName(item.game);
    if (want.length < 4) return null;
    return state.games.find((g) => {
      const have = normalizeGameName(g.game_name);
      return have && (have === want || have.startsWith(want) || want.startsWith(have));
    }) || null;
  }

  function cachedPatchOf(game) {
    return state.csrinPatch?.get(`${game.game_key || game.appid || game.install_path}|${game.buildid || ''}`) || null;
  }

  /** A feed post against an installed game: by patch, by build when the post names no patch. */
  function newsPatchVerdict(it, game, patch) {
    const m = csrinPatchMatch(it, game, patch);
    if (m.state === 'match') return { same: true, html: `<span class="csrin-badge ok">✓ your ${m.by} ${esc(m.installed)}</span>` };
    if (m.state === 'mismatch') return { same: false, html: `<span class="csrin-badge warn">installed ${m.by} ${esc(m.installed)}</span>` };
    if (m.by === 'patch' && m.posted && !patch) return { same: false, html: '<span class="csrin-badge dim">installed · patch…</span>' };
    return { same: false, html: '<span class="csrin-badge dim">installed</span>' };
  }

  /** Once the dialog is up, judge each post for an installed game by its real patch. */
  async function paintNewsPatches(items) {
    for (const it of items) {
      const game = newsMatchInstalled(it);
      if (!game || !patchKey(it.version)) continue;
      const verdict = newsPatchVerdict(it, game, await installedPatchOf(game));
      const badge = document.querySelector(`[data-news-patch="${CSS.escape(it.id)}"]`);
      if (badge) badge.innerHTML = verdict.html;
      const btn = document.querySelector(`[data-news-fetch="${CSS.escape(it.id)}"]`);
      if (btn) btn.textContent = verdict.same ? 'Fetch for your copy' : 'Open on this game';
    }
  }

  function newsItemHtml(it, seen) {
    const fresh = seen.has(it.id) ? '' : '<span class="nw-new">New</span>';
    if (it.kind === 'denuvo') {
      return `
        <article class="nw-card is-steam" data-id="${esc(it.id)}">
          <span class="nw-art"><img src="${esc(it.header || steamHeaderUrl(it.appid))}" alt="" loading="lazy" data-hide-on-error=""></span>
          <span class="nw-body">
            <span class="nw-head">${fresh}<span class="nw-kicker">${it.comingSoon ? 'Coming soon' : 'Out on Steam'} · Denuvo</span></span>
            <span class="nw-name">${esc(it.name)}</span>
            <span class="nw-sub">${esc([it.date, it.price].filter(Boolean).join(' · '))}</span>
            <span class="nw-actions">
              <button class="xbox-btn xbox-btn-primary btn-sm" data-act="store" data-appid="${esc(it.appid)}" data-name="${esc(it.name)}">View in store</button>
            </span>
          </span>
        </article>`;
    }
    const game = newsMatchInstalled(it);
    const build = it.build ? `build ${it.build}` : '';
    const version = it.version ? `patch ${it.version}` : '';
    let state_ = '';
    let action = `<button class="xbox-btn xbox-btn-secondary btn-sm" data-act="search" data-name="${esc(it.game)}">Find in store</button>`;
    if (game) {
      const verdict = newsPatchVerdict(it, game, cachedPatchOf(game));
      state_ = `<span data-news-patch="${esc(it.id)}">${verdict.html}</span>`;
      if (state.csrin.available) {
        action = `<button class="xbox-btn xbox-btn-primary btn-sm" data-act="fetch" data-appid="${esc(game.appid)}" data-news-fetch="${esc(it.id)}">${verdict.same ? 'Fetch for your copy' : 'Open on this game'}</button>`;
      }
    }
    // "Tuesday, 01 Sep 2026, 20:00" → the day on one line, the time under it;
    // "Today, 01:20" and "Yesterday, 20:00" are already that shape.
    const dateParts = String(it.date || '').split(/,\s*/);
    const when = dateParts.length >= 2
      ? `<b>${esc(dateParts.slice(0, -1).join(', ').replace(/^\w+,\s*/, ''))}</b>${esc(dateParts[dateParts.length - 1])}`
      : `<b>${esc(it.date || '')}</b>`;
    return `
      <article class="nw-card is-csrin" data-id="${esc(it.id)}">
        <span class="nw-when-col">${when}</span>
        <span class="nw-body">
          <span class="nw-head">${fresh}<span class="nw-kicker">${esc(it.author || 'CS.RIN.RU')}${it.flags?.length ? ` · ${esc(it.flags.filter((f) => !/^info$/i.test(f)).join(' · '))}` : ''}</span></span>
          <span class="nw-name">${esc(it.game || it.topicTitle)}</span>
          <span class="nw-sub">${esc([build, version].filter(Boolean).join(' · ') || it.subject || '')} ${state_}</span>
          <span class="nw-snip">${esc(String(it.snippet || '').replace(/https?:\/\/([^\s/]+)\S*/g, '$1'))}</span>
          <span class="nw-actions">
            ${action}
            ${it.postUrl ? `<button class="xbox-btn xbox-btn-secondary btn-sm" data-act="open" data-url="${esc(it.postUrl)}">Open post</button>` : ''}
          </span>
        </span>
      </article>`;
  }

  function openNewsModal({ all = true } = {}) {
    const seen = new Set(state.settings.news_seen || []);
    const items = all ? state.news.items : state.news.items.filter((it) => !seen.has(it.id));
    const steam = items.filter((it) => it.kind === 'denuvo');
    const csrin = items.filter((it) => it.kind === 'csrin');
    const author = state.settings.csrin_author || 'ARTIFACT';
    const when = state.news.checkedAt ? formatRelative(state.news.checkedAt) : 'never';
    const empty = !items.length;

    openModal("What's new", `
      <div class="news-modal">
        ${empty ? `<div class="nw-empty">${state.news.loading ? 'Reading Steam and the forum…' : state.news.errors.length ? esc(state.news.errors.join(' · ')) : 'Nothing new since you last looked.'}</div>` : ''}
        ${steam.length ? `
          <section class="nw-section">
            <h3 class="nw-title">Denuvo on Steam <span class="nw-count">${steam.length}</span></h3>
            <div class="nw-grid">${steam.map((it) => newsItemHtml(it, seen)).join('')}</div>
          </section>` : ''}
        ${csrin.length ? `
          <section class="nw-section">
            <h3 class="nw-title">${esc(author)} on CS.RIN.RU <span class="nw-count">${csrin.length}</span></h3>
            <div class="nw-list">${csrin.map((it) => newsItemHtml(it, seen)).join('')}</div>
          </section>` : ''}
        <div class="modal-actions nw-foot">
          <span class="text-dim nw-when">Checked ${esc(when)}${state.news.errors.length && !empty ? ` · ${esc(state.news.errors.join(' · '))}` : ''}</span>
          <button class="xbox-btn xbox-btn-secondary btn-sm" id="nw-refresh">Check again</button>
          <button class="xbox-btn xbox-btn-primary" id="nw-done">Got it</button>
        </div>
      </div>`);

    // The panel's box gives way to glass for this one dialog.
    $('#modal-container')?.classList.add('is-news');

    const markSeen = async () => {
      const ids = new Set(state.settings.news_seen || []);
      for (const it of state.news.items) ids.add(it.id);
      try {
        await api.setSetting('news_seen', [...ids]);
        state.settings = await api.getAllSettings();
      } catch { /* the badge will just show again next time */ }
      state.news.unseen = 0;
      paintNewsBadge();
    };
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      state.pendingConfirm = null;
      $('#modal-close').onclick = () => closeModal();
      closeModal();
      // Once the exit transition has run, so the next dialog gets the panel back.
      setTimeout(() => $('#modal-container')?.classList.remove('is-news'), 240);
      void markSeen();
    };
    $('#nw-done').onclick = done;
    $('#modal-close').onclick = done;
    // Escape and the backdrop close it the same way, marking things seen.
    state.pendingConfirm = done;
    $('#nw-refresh').onclick = async () => {
      const b = $('#nw-refresh');
      await withBusy(b, () => refreshNews({ show: false }));
      openNewsModal({ all: true });
    };
    $('#modal-body').querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => {
        const act = b.dataset.act;
        if (act === 'open') { api.openExternal(b.dataset.url); return; }
        done();
        if (act === 'store') { navigateTo('store'); window.LibrarianStore?.open?.(b.dataset.appid, b.dataset.name); }
        else if (act === 'search') { navigateTo('store'); state.storeSearch?.(b.dataset.name); }
        else if (act === 'fetch') {
          const game = state.games.find((g) => safeAppId(g.appid) === safeAppId(b.dataset.appid));
          if (game) openCsrinPicker(game.appid, game.game_name, { game });
        }
      };
    });
    void paintNewsPatches(csrin);
  }

  // ─── Denuvo, and the release that follows a download ─
  // The second source exists for one kind of game. Steam's own DRM line
  // says which; it is read once per app and remembered for the session.
  async function ensureDenuvoInfo(game) {
    const appid = safeAppId(game?.appid);
    if (!appid) return false;
    if (typeof state.denuvo[appid] === 'boolean') return state.denuvo[appid];
    let media = null;
    try { media = await api.getGameMedia(appid); } catch { media = null; }
    // Unknown stays unknown: a failed lookup must not be remembered as "not
    // Denuvo" for the rest of the session.
    if (!media) return false;
    state.denuvo[appid] = Boolean(media.denuvo);
    return state.denuvo[appid];
  }

  /**
   * After the queue has drained and the library has been rescanned: for each
   * Denuvo game that was just downloaded or updated, fetch the member's post
   * for its new build and queue the release into it. Other games are never
   * touched; without a forum account nothing can be fetched, and that is
   * said once rather than failing quietly.
   */
  async function runPendingCsrin() {
    const pending = state.csrinPending.splice(0);
    // Part of auto-crack: the same switch that runs the emulator after a
    // download decides whether a Denuvo title gets its release fetched.
    if (!pending.length || !state.csrin.available || !state.settings.auto_crack) return;
    for (const p of pending) {
      const game = state.games.find((g) => safeAppId(g.appid) === p.appid && g.install_path);
      if (!game) continue;
      if (!(await ensureDenuvoInfo(game))) continue;
      if (!state.settings.csrin_username || !state.settings.secrets_present?.csrin_password) {
        log(`🌐 ${game.game_name} is a Denuvo title: the release for build ${game.buildid || '?'} could be fetched from CS.RIN.RU, but no forum account is set. Add one in Settings.`, 'accent');
        toast(`${game.game_name}: add a CS.RIN.RU account in Settings to fetch its release`, '', { duration: 9000 });
        continue;
      }
      await autoFetchCsrinRelease(game);
    }
  }

  /**
   * What CS.RIN.RU has for a game, remembered for the session.
   *
   * The store page, the gate before a download or an update, and the
   * unattended fetch afterwards all ask the same question of the same
   * thread; one crawl answers all of them for a quarter of an hour.
   */
  const CSRIN_CACHE_TTL = 15 * 60 * 1000;
  async function csrinReleaseInfo(gameName, { force = false } = {}) {
    const key = normalizeGameName(gameName);
    if (!key || !state.csrin.available) return null;
    state.csrinCache = state.csrinCache || new Map();
    const hit = state.csrinCache.get(key);
    if (!force && hit && Date.now() - hit.at < CSRIN_CACHE_TTL) return hit.res;
    if (hit?.pending) return hit.pending;
    const author = state.settings.csrin_author || 'ARTIFACT';
    const pending = (async () => {
      let res;
      try { res = await api.csrinSearch({ game: gameName, author }); } catch (e) { res = { ok: false, error: e.message }; }
      const out = {
        ok: Boolean(res?.ok),
        error: res?.error || '',
        author,
        authenticated: Boolean(res?.authenticated),
        loginFailed: Boolean(res?.loginFailed),
        posts: res?.posts || [],
        newest: (res?.posts || []).find((p) => p.build || p.version) || (res?.posts || [])[0] || null,
        at: Date.now(),
      };
      state.csrinCache.set(key, { at: Date.now(), res: out });
      return out;
    })();
    state.csrinCache.set(key, { at: 0, pending });
    return pending;
  }

  /**
   * Before a Denuvo game is downloaded, or moved to another build: does
   * CS.RIN.RU have the member's release for that build? Without one the game
   * would not run, so the job is held back — a confirmation can override
   * it, and an unattended "update all" simply skips the game and says so.
   */
  async function csrinReleaseGate(game, targetBuild, { silent = false, verb = 'update' } = {}) {
    if (!state.csrin.available || !state.settings.auto_crack) return { ok: true };
    let denuvo = false;
    try { denuvo = await ensureDenuvoInfo(game); } catch { denuvo = false; }
    if (!denuvo) return { ok: true };

    const author = state.settings.csrin_author || 'ARTIFACT';
    const build = String(targetBuild || '');
    // Releases name patches. The build this job lands on is the public one,
    // read against the notes posted around the moment it went live.
    let targetInfo = null;
    try { targetInfo = await api.csrinTargetPatch(game.appid); } catch { targetInfo = null; }
    const patch = targetInfo?.version || '';
    const target = patch ? `patch ${patch}` : build ? `build ${build}` : '';
    const updating = verb === 'update';
    const ask = async (title, message) => {
      if (silent) {
        toast(`${game.game_name}: ${verb} held — ${message}`, 'error', { duration: 9000 });
        return { ok: false, message };
      }
      const ok = await showConfirm(title,
        `${message} ${updating ? `Updating now would leave ${game.game_name} unplayable until a release appears.` : `${game.game_name} would download but not run until a release appears.`} ${updating ? 'Update' : 'Download'} anyway?`,
        { confirmLabel: updating ? 'Update anyway' : 'Download anyway', cancelLabel: updating ? 'Keep current build' : 'Not now', danger: true });
      return ok ? { ok: true, overridden: true } : { ok: false, message };
    };

    // A build that went live without notes yet: which patch it is cannot be
    // told, so neither can whether a release fits it. Matching it to the
    // previous patch is how a game got updated past its release.
    if (targetInfo?.source === 'pending') {
      const message = `Steam's public build${build ? ` ${build}` : ''} is new and has no patch notes yet, so its patch — and whether ${author} has a release for it — cannot be told.`;
      log(`⛔ ${game.game_name}: ${message}`, 'error');
      return ask('Patch not known yet', message);
    }

    if (!state.settings.csrin_username || !state.settings.secrets_present?.csrin_password) {
      const message = `no CS.RIN.RU account is set, so whether ${target || 'this patch'} has a release cannot be checked.`;
      log(`⚠ ${game.game_name} is a Denuvo title and ${message}`);
      return ask(`${updating ? 'Update' : 'Download'} a Denuvo game?`, `${game.game_name} is a Denuvo title and ${message}`);
    }

    log(`🌐 Checking CS.RIN.RU for ${author}'s release of ${game.game_name}${target ? ` ${target}` : ''}…`, 'accent');
    // The log is on the Downloads page; the user may still be on the game.
    if (!silent) toast(`Checking CS.RIN.RU for a release${target ? ` of ${target}` : ''}…`, '', { duration: 6000 });
    const info = await csrinReleaseInfo(game.game_name);
    const posts = info?.ok ? info.posts : [];
    const match = patch || build
      ? csrinPostFor(posts, patch, build)
      : posts.find((p) => (p.links || []).length);
    if (match) {
      log(`✅ CS.RIN.RU has ${author}'s release${match.version ? ` for patch ${match.version}` : match.build ? ` for build ${match.build}` : ''}; it will be applied once the ${updating ? 'update' : 'download'} is in.`, 'success');
      return { ok: true };
    }
    const newest = posts.find((p) => p.version || p.build);
    const newestText = newest ? (newest.version ? `patch ${newest.version}` : `build ${newest.build}`) : '';
    const message = info?.ok
      ? `CS.RIN.RU has no release by ${author}${target ? ` for ${target}` : ` for ${game.game_name}`} yet${newestText && newestText !== target ? ` (the newest is for ${newestText})` : ''}.`
      : `CS.RIN.RU could not be checked: ${info?.error || 'search failed'}.`;
    log(`⛔ ${message} ${updating ? 'Update' : 'Download'} held back${updating ? ` to keep ${game.game_name} playable` : ''}.`, 'error');
    return ask('No release for this patch', message);
  }

  /** Search, match the patch, and queue — the unattended form of the picker. */
  async function autoFetchCsrinRelease(game) {
    const author = state.settings.csrin_author || 'ARTIFACT';
    const build = String(game.buildid || '');
    // Fresh: this runs right after a download moved the game to a new build.
    const installed = await installedPatchOf(game, { force: true });
    const patch = installed.version || '';
    if (!patch && !build) {
      log(`⚠ ${game.game_name}: installed patch unknown${installed.error ? ` (${installed.error})` : ''}, so no CS.RIN.RU release can be matched. Use the game's CS.RIN.RU button to pick one by hand.`);
      return;
    }
    const target = patch ? `patch ${patch}` : `build ${build}`;
    if (patch) log(`🌐 ${game.game_name} is on patch ${patch} — ${patchSourceText(installed)}.`);
    log(`🌐 CS.RIN.RU: looking for ${author}'s release of ${game.game_name} for ${target}…`, 'accent');
    const findMatch = (res) => csrinPostFor(res?.posts, patch, build);
    const runSearch = async (scanAll) => {
      // The quick pass is the one the gate already made; the walk is fresh.
      if (!scanAll) return csrinReleaseInfo(game.game_name);
      try { return await api.csrinSearch({ game: game.game_name, author, scanAll }); }
      catch (e) { return { ok: false, error: e.message }; }
    };
    let res = await runSearch(false);
    if (!res?.ok) { log(`⚠ CS.RIN.RU search failed: ${res?.error || 'unknown error'}`, 'error'); return; }
    if (res.loginFailed) { log('⚠ CS.RIN.RU login failed — check the account in Settings.', 'error'); return; }
    let post = findMatch(res);
    if (!post && (res.posts || []).length) {
      const top = res.posts[0];
      log(`🌐 The newest post is for ${top.version ? `patch ${top.version}` : `build ${top.build || '?'}`}; walking the whole thread for ${target}…`);
      res = await runSearch(true);
      post = findMatch(res);
    }
    if (!post) {
      log(`⚠ No post by ${author} is for ${target} of ${game.game_name} — nothing was placed. Open the game and use CS.RIN.RU to pick one by hand (the installed patch can be corrected there).`, 'error');
      toast(`${game.game_name}: no CS.RIN.RU release for ${target} yet`, 'error', { duration: 9000 });
      return;
    }
    // The crack goes over the clean files: a link labelled as such first,
    // else the post's only link.
    const link = post.links.find((l) => /crack/i.test(l.label)) || post.links[0];
    log(`✅ ${author}'s post for ${post.version ? `patch ${post.version}` : `build ${post.build}`}: ${link.label || link.host}`, 'success');
    queueCsrinDownload({ url: link.url, appid: game.appid, name: game.game_name, post, link, game, patch: installed });
  }

  // ─── Settings Page ──────────────────────────────────
  function setupSettingsPage() {
    (async () => {
      let s;
      try {
        s = await api.getAllSettings();
      } catch (e) {
        console.error('Failed to load settings for the settings page:', e);
        toast('Failed to load settings — showing defaults', 'error');
        // Don't overwrite stored settings with blanks: leave inputs untouched.
        return;
      }
      $('#inp-api-key').value = '';
      $('#inp-api-key').placeholder = s.secrets_present?.hubcap_api_key ? 'Saved securely — enter to replace' : 'Not configured';
      $('#sel-manifest-source').value = ['auto', 'hubcap', 'steammanifest'].includes(s.manifest_source) ? s.manifest_source : 'auto';
      $('#inp-steammanifest-mirror').value = s.steammanifest_mirror || '';
      $('#inp-manifest-proxies').value = s.manifest_mirror_proxies || '';
      $('#inp-manifest-proxy-source').value = s.manifest_proxy_source || '';
      $('#inp-depot-key-catalog').value = s.depot_key_catalog || '';
      $('#inp-app-token-catalog').value = s.app_token_catalog || '';
      renderSteamManifestSettingsStatus();
      $('#inp-steam-web-key').value = '';
      $('#inp-steam-web-key').placeholder = s.secrets_present?.steam_web_api_key ? 'Saved securely — enter to replace' : 'Not configured';
      $('#sel-launch-mode').value = s.launch_mode || 'exe';
      $('#chk-reduce-motion').checked = s.reduce_motion || false;
      $('#chk-kinetic').checked = s.ui_kinetic !== false;
      $('#chk-dynamic-accent').checked = s.dynamic_accent !== false;
      $('#chk-tilt').checked = s.ui_tilt !== false;
      $('#chk-hero-rotate').checked = s.hero_rotate !== false;
      $('#chk-gamepad').checked = s.gamepad_nav !== false;
      $('#chk-ui-sounds').checked = Boolean(s.ui_sounds);
      $('#chk-notify-complete').checked = s.notify_on_complete !== false;
      $('#chk-news').checked = s.news_enabled !== false;
      $('#chk-ask-destination').checked = s.ask_install_location !== false;
      const vol = Number.isFinite(Number(s.ui_sound_volume)) ? Number(s.ui_sound_volume) : 0.35;
      $('#inp-sound-volume').value = String(vol);
      $('#out-sound-volume').textContent = `${Math.round(vol * 100)}%`;
      $('#row-sound-volume').style.display = s.ui_sounds ? '' : 'none';
      $('#inp-steam-username').value = s.steam_username || '';
      $('#inp-steam-password').value = '';
      $('#inp-steam-password').placeholder = s.secrets_present?.steam_password ? 'Saved securely — enter to replace' : 'Not configured';
      $('#inp-csrin-username').value = s.csrin_username || '';
      $('#inp-csrin-password').value = '';
      $('#inp-csrin-password').placeholder = s.secrets_present?.csrin_password ? 'Saved securely — enter to replace' : 'Not configured';
      $('#inp-csrin-author').value = s.csrin_author || 'ARTIFACT';
      renderCsrinSettingsStatus();
      $('#chk-sls').checked = s.slssteam_mode || false;
      $('#chk-library').checked = s.library_mode || false;
      $('#chk-achievements').checked = s.generate_achievements || false;
      $('#chk-achievement-popups').checked = s.achievement_popups !== false;
      $('#chk-steamless').checked = s.use_steamless || false;
      $('#chk-auto-crack').checked = s.auto_crack || false;
      $('#sel-max-downloads').value = String(s.download_max_downloads || 8);
      $('#chk-adaptive').checked = s.download_adaptive !== false;
      $('#chk-validate-fresh').checked = s.validate_fresh_downloads || false;
      $('#chk-lancache').checked = s.use_lancache !== false;
      $('#inp-speed-limit').value = s.download_speed_limit ? String(s.download_speed_limit) : '';
      $('#inp-steam-cell-id').value = s.steam_cell_id || '';
      $('#inp-player-name').value = s.online_player_name || '';
      $('#chk-steam-overlay').checked = s.online_steam_overlay !== false;
      // Theme
      $('#inp-accent').value = s.accent_color || THEME_DEFAULTS.accent;
      $('#accent-hex').textContent = s.accent_color || THEME_DEFAULTS.accent;
      $('#inp-bg').value = s.background_color || THEME_DEFAULTS.background;
      $('#bg-hex').textContent = s.background_color || THEME_DEFAULTS.background;
      // Big Picture
      $('#chk-bp-fullscreen').checked = s.bigpicture_fullscreen !== false;
      $('#chk-bp-logos').checked = s.bigpicture_logos !== false;
      $('#chk-bp-rounded').checked = s.bigpicture_rounded !== false;
      $('#chk-bp-trailer-bg').checked = s.bigpicture_trailer_bg !== false;
      $('#chk-bp-trailers').checked = s.bigpicture_trailers !== false;
      $('#chk-bp-sounds').checked = s.bigpicture_sounds !== false;
      const bpAccent = s.bigpicture_accent || BP_ACCENT_DEFAULT;
      $('#inp-bp-accent').value = bpAccent;
      $('#bp-accent-hex').textContent = bpAccent;
      const bpLayout = s.bigpicture_layout === 'grid' ? 'grid' : 'horizontal';
      $$('#seg-bp-layout button').forEach((b) => b.classList.toggle('active', b.dataset.bpLayout === bpLayout));
    })();

    const saveSettings = async () => {
      const values = {};
      values.accent_color = $('#inp-accent').value;
      values.background_color = $('#inp-bg').value;
      values.bigpicture_accent = $('#inp-bp-accent').value;
      if ($('#inp-api-key').value || $('#inp-api-key').dataset.clear === 'true') values.hubcap_api_key = $('#inp-api-key').value.trim();
      values.manifest_source = $('#sel-manifest-source').value;
      values.steammanifest_mirror = $('#inp-steammanifest-mirror').value.trim();
      values.manifest_mirror_proxies = $('#inp-manifest-proxies').value.trim();
      values.manifest_proxy_source = $('#inp-manifest-proxy-source').value.trim();
      values.depot_key_catalog = $('#inp-depot-key-catalog').value.trim();
      values.app_token_catalog = $('#inp-app-token-catalog').value.trim();
      if ($('#inp-steam-web-key').value || $('#inp-steam-web-key').dataset.clear === 'true') values.steam_web_api_key = $('#inp-steam-web-key').value.trim();
      values.launch_mode = $('#sel-launch-mode').value;
      values.reduce_motion = $('#chk-reduce-motion').checked;
      values.ui_kinetic = $('#chk-kinetic').checked;
      values.steam_username = $('#inp-steam-username').value.trim();
      if ($('#inp-steam-password').value || $('#inp-steam-password').dataset.clear === 'true') values.steam_password = $('#inp-steam-password').value;
      values.csrin_username = $('#inp-csrin-username').value.trim();
      if ($('#inp-csrin-password').value || $('#inp-csrin-password').dataset.clear === 'true') values.csrin_password = $('#inp-csrin-password').value;
      values.csrin_author = $('#inp-csrin-author').value.trim() || 'ARTIFACT';
      values.slssteam_mode = $('#chk-sls').checked;
      values.library_mode = $('#chk-library').checked;
      values.generate_achievements = $('#chk-achievements').checked;
      values.achievement_popups = $('#chk-achievement-popups').checked;
      values.use_steamless = $('#chk-steamless').checked;
      values.auto_crack = $('#chk-auto-crack').checked;
      values.download_max_downloads = Number($('#sel-max-downloads').value) || 8;
      values.validate_fresh_downloads = $('#chk-validate-fresh').checked;
      values.download_adaptive = $('#chk-adaptive').checked;
      values.use_lancache = $('#chk-lancache').checked;
      values.download_speed_limit = Number($('#inp-speed-limit').value) || 0;
      values.steam_cell_id = $('#inp-steam-cell-id').value.trim();
      values.online_player_name = $('#inp-player-name').value.trim();
      values.online_steam_overlay = $('#chk-steam-overlay').checked;
      values.dynamic_accent = $('#chk-dynamic-accent').checked;
      values.ui_tilt = $('#chk-tilt').checked;
      values.hero_rotate = $('#chk-hero-rotate').checked;
      values.gamepad_nav = $('#chk-gamepad').checked;
      values.ui_sounds = $('#chk-ui-sounds').checked;
      values.ui_sound_volume = Number($('#inp-sound-volume').value) || 0;
      values.notify_on_complete = $('#chk-notify-complete').checked;
      values.news_enabled = $('#chk-news').checked;
      values.ask_install_location = $('#chk-ask-destination').checked;
      values.bigpicture_fullscreen = $('#chk-bp-fullscreen').checked;
      values.bigpicture_logos = $('#chk-bp-logos').checked;
      values.bigpicture_rounded = $('#chk-bp-rounded').checked;
      values.bigpicture_trailer_bg = $('#chk-bp-trailer-bg').checked;
      values.bigpicture_trailers = $('#chk-bp-trailers').checked;
      values.bigpicture_sounds = $('#chk-bp-sounds').checked;
      state.settings = await api.setSettings(values);
      // The key or the source may have changed: which sources are in effect follows.
      void refreshSteamManifestStatus();
      applyThemeColors(state.settings.accent_color, state.settings.background_color);
      for (const [key, id] of Object.entries({"hubcap_api_key":"inp-api-key","steam_web_api_key":"inp-steam-web-key","steam_password":"inp-steam-password","csrin_password":"inp-csrin-password"})) {
        const input = document.getElementById(id); input.value = ''; delete input.dataset.clear;
        input.placeholder = state.settings.secrets_present?.[key] ? 'Saved securely — enter to replace' : 'Not configured';
      }
      // Let the enhancement layer re-read preferences without a reload.
      emit('prefs', state.settings);
    };

    for (const id of ["inp-api-key","inp-steam-web-key","inp-steam-password","inp-csrin-password"]) {
      const input = document.getElementById(id);
      input.type = 'password'; input.autocomplete = 'off';
      const clear = document.createElement('button');
      clear.className = 'xbox-btn xbox-btn-sm'; clear.type = 'button'; clear.textContent = 'Clear saved';
      clear.onclick = async () => { input.value = ''; input.dataset.clear = 'true'; await saveSettings(); toast('Saved credential cleared', 'success'); };
      input.insertAdjacentElement('afterend', clear);
    }
    $('#chk-sls').onchange = saveSettings;
    $('#chk-library').onchange = saveSettings;
    $('#chk-achievements').onchange = saveSettings;
    $('#chk-achievement-popups').onchange = saveSettings;
    $('#chk-steamless').onchange = saveSettings;
    $('#chk-auto-crack').onchange = saveSettings;
    $('#sel-max-downloads').onchange = saveSettings;
    $('#chk-validate-fresh').onchange = saveSettings;
    $('#chk-lancache').onchange = saveSettings;
    $('#inp-speed-limit').onchange = saveSettings;
    $('#sel-launch-mode').onchange = saveSettings;
    $('#chk-reduce-motion').onchange = () => { applyReduceMotion($('#chk-reduce-motion').checked); saveSettings(); };
    $('#chk-kinetic').onchange = saveSettings;
    $('#chk-dynamic-accent').onchange = saveSettings;
    $('#chk-tilt').onchange = saveSettings;
    $('#chk-hero-rotate').onchange = saveSettings;
    $('#chk-gamepad').onchange = saveSettings;
    $('#chk-notify-complete').onchange = saveSettings;
    $('#chk-news').onchange = saveSettings;
    $('#chk-ask-destination').onchange = saveSettings;
    $('#chk-ui-sounds').onchange = () => {
      $('#row-sound-volume').style.display = $('#chk-ui-sounds').checked ? '' : 'none';
      saveSettings();
    };
    $('#inp-sound-volume').oninput = function () {
      $('#out-sound-volume').textContent = `${Math.round(Number(this.value) * 100)}%`;
    };
    $('#inp-sound-volume').onchange = saveSettings;

    // CS.RIN.RU download folder: a picker, not a text field, so it commits on
    // its own rather than waiting for Save.
    const csrinBrowse = $('#btn-csrin-browse');
    if (csrinBrowse) {
      csrinBrowse.onclick = async () => {
        const folder = await api.openFolder({
          title: 'Where CS.RIN.RU releases are saved',
          buttonLabel: 'Use this folder',
          defaultPath: state.settings.csrin_download_dir || state.csrin.downloadDir || undefined,
        });
        if (!folder) return;
        await api.setSetting('csrin_download_dir', folder);
        state.settings = await api.getAllSettings();
        renderCsrinSettingsStatus();
        toast(`CS.RIN.RU releases go to ${folder}`, 'success');
      };
    }
    const csrinReset = $('#btn-csrin-dir-reset');
    if (csrinReset) {
      csrinReset.onclick = async () => {
        await api.setSetting('csrin_download_dir', '');
        state.settings = await api.getAllSettings();
        renderCsrinSettingsStatus();
      };
    }

    // The manifest source: the picker saves on change; the folder points at
    // a checkout of the steammanifest project instead of the bundled copy.
    const sourceSel = $('#sel-manifest-source');
    if (sourceSel) sourceSel.onchange = saveSettings;
    const smBrowse = $('#btn-steammanifest-browse');
    if (smBrowse) {
      smBrowse.onclick = async () => {
        const folder = await api.openFolder({
          title: 'The steammanifest checkout to use',
          buttonLabel: 'Use this folder',
          defaultPath: state.settings.steammanifest_dir || undefined,
        });
        if (!folder) return;
        await api.setSetting('steammanifest_dir', folder);
        state.settings = await api.getAllSettings();
        await refreshSteamManifestStatus();
        if (state.steamManifest.configuredMissing) toast(`${folder} is not a steammanifest checkout — the bundled copy stays in use`, 'error');
        else toast(`steammanifest: ${folder}`, 'success');
      };
    }
    const smReset = $('#btn-steammanifest-dir-reset');
    if (smReset) {
      smReset.onclick = async () => {
        await api.setSetting('steammanifest_dir', '');
        state.settings = await api.getAllSettings();
        await refreshSteamManifestStatus();
      };
    }

    // Most controls save on change; this covers the text fields (API key, Steam
    // credentials, cell ID) which only commit on demand.
    $('#btn-save-settings').onclick = async (e) => {
      const btn = e.currentTarget;
      btn.classList.add('busy');
      try {
        await saveSettings();
        const hint = $('#settings-saved-hint');
        if (hint) {
          hint.textContent = 'Saved';
          hint.classList.remove('show');
          void hint.offsetWidth;
          hint.classList.add('show');
          setTimeout(() => hint.classList.remove('show'), 2200);
        }
        toast('Settings saved', 'success');
      } finally {
        btn.classList.remove('busy');
      }
    };

    // ── Install locations ────────────────────────────────────────
    const btnAddLocation = $('#btn-add-location');
    if (btnAddLocation) {
      btnAddLocation.onclick = async () => {
        const folder = await api.openFolder({ title: 'Choose an install folder', buttonLabel: 'Use this folder' });
        if (!folder) return;
        const res = await api.addInstallLocation(folder);
        if (!res || !res.success) { toast(res?.error || 'Could not add that folder', 'error'); return; }
        state.settings = await api.getAllSettings();
        toast(`Added ${res.path}`, 'success');
        renderInstallLocations();
      };
    }
    const btnRefreshLocations = $('#btn-refresh-locations');
    if (btnRefreshLocations) btnRefreshLocations.onclick = () => renderInstallLocations();

    renderInstallLocations();

    const aboutLine = $('#about-line');
    if (aboutLine && api.getVersion) {
      api.getVersion().then((v) => { aboutLine.textContent = `Librarian ${v} · ${api.platform}`; }).catch(() => {});
    }

    const openConfigBtn = $('#btn-open-config');
    if (openConfigBtn) {
      openConfigBtn.onclick = async () => {
        try {
          const dir = await api.getPath('userData');
          const err = await api.openPath(dir);
          if (err) toast(err, 'error');
        } catch (e) {
          toast(`Could not open folder: ${e.message}`, 'error');
        }
      };
    }

    const steamKeyLink = $('#link-get-steam-key');
    if (steamKeyLink) {
      steamKeyLink.onclick = (e) => {
        e.preventDefault();
        api.openExternal('https://steamcommunity.com/dev/apikey');
      };
    }

    const apiKeyLink = $('#link-get-api-key');
    if (apiKeyLink) {
      apiKeyLink.onclick = (e) => {
        e.preventDefault();
        api.openExternal('https://hubcapmanifest.com/api-keys/stats');
      };
    }

    // Big Picture controls
    for (const id of ['#chk-bp-fullscreen', '#chk-bp-logos', '#chk-bp-rounded', '#chk-bp-trailer-bg', '#chk-bp-trailers', '#chk-bp-sounds']) {
      const el = $(id);
      if (el) el.onchange = saveSettings;
    }
    $$('#seg-bp-layout button').forEach((btn) => {
      btn.onclick = async () => {
        $$('#seg-bp-layout button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        await api.setSetting('bigpicture_layout', btn.dataset.bpLayout);
        state.settings = await api.getAllSettings();
        emit('prefs', state.settings);
      };
    });
    // The colour input fires continuously while the picker is open, so the swatch
    // follows live and only the committed value is written.
    $('#inp-bp-accent').oninput = function () { $('#bp-accent-hex').textContent = this.value; };
    $('#inp-bp-accent').onchange = async function () {
      await api.setSetting('bigpicture_accent', this.value);
      state.settings = await api.getAllSettings();
      emit('prefs', state.settings);
    };
    $('#btn-reset-bp-accent').onclick = async () => {
      $('#inp-bp-accent').value = BP_ACCENT_DEFAULT;
      $('#bp-accent-hex').textContent = BP_ACCENT_DEFAULT;
      await api.setSetting('bigpicture_accent', BP_ACCENT_DEFAULT);
      state.settings = await api.getAllSettings();
      emit('prefs', state.settings);
    };
    $('#btn-open-bigpicture').onclick = () => {
      if (window.LibrarianBigPicture) window.LibrarianBigPicture.open();
      else toast('Big Picture is unavailable in this build', 'error');
    };

    // Theme controls
    $('#inp-accent').oninput = function () { $('#accent-hex').textContent = this.value; };
    $('#inp-bg').oninput = function () { $('#bg-hex').textContent = this.value; };
    $('#btn-reset-accent').onclick = () => {
      $('#inp-accent').value = THEME_DEFAULTS.accent;
      $('#accent-hex').textContent = THEME_DEFAULTS.accent;
    };
    $('#btn-reset-bg').onclick = () => {
      $('#inp-bg').value = THEME_DEFAULTS.background;
      $('#bg-hex').textContent = THEME_DEFAULTS.background;
    };
    $('#btn-apply-style').onclick = async () => {
      const a = $('#inp-accent').value, b = $('#inp-bg').value;
      await api.setSettings({ accent_color: a, background_color: b });
      applyThemeColors(a, b);
      state.settings = await api.getAllSettings();
      toast('Theme applied! ✨');
    };
  }

  // ─── Install locations ──────────────────────────────
  // A single renderer used by both the Settings panel and the pre-download
  // destination picker, so the two can never drift apart.
  function locationRowHtml(loc, requiredBytes = 0) {
    const usedPct = (loc.total > 0 && loc.free !== null)
      ? Math.max(0, Math.min(100, ((loc.total - loc.free) / loc.total) * 100))
      : null;
    const tooSmall = requiredBytes > 0 && loc.free !== null && loc.free < requiredBytes;
    const bits = [loc.kind === 'steam' ? 'Steam library' : 'Custom folder'];
    if (!loc.exists) bits.push('missing');
    else if (loc.free !== null) bits.push(`${formatSize(loc.free)} free of ${formatSize(loc.total)}`);
    else bits.push('space unknown');

    return `
      <div class="loc-row${loc.isDefault ? ' is-default' : ''}${tooSmall ? ' too-small' : ''}${loc.exists ? '' : ' missing'}" data-path="${esc(loc.path)}" role="button" tabindex="0">
        <div class="loc-radio"></div>
        <div class="loc-info">
          <div class="loc-path">${esc(loc.path)}</div>
          <div class="loc-meta">${esc(bits.join(' · '))}${tooSmall ? ' — <b>not enough room</b>' : ''}</div>
          ${usedPct === null ? '' : `<div class="loc-bar"><i style="width:${usedPct.toFixed(1)}%"></i></div>`}
        </div>
        ${loc.kind === 'custom' ? '<button class="loc-remove" title="Forget this folder">✕</button>' : '<span class="loc-tag">auto</span>'}
      </div>`;
  }

  async function renderInstallLocations() {
    const host = $('#install-locations');
    if (!host) return;
    let locations = [];
    try { locations = await api.listInstallLocations(); } catch { locations = []; }

    if (!locations.length) {
      host.innerHTML = '<div class="empty-state-small">No install folders yet. Add one below — it becomes the default for new downloads.</div>';
      return;
    }

    host.innerHTML = locations.map(loc => locationRowHtml(loc)).join('');

    host.querySelectorAll('.loc-row').forEach((row) => {
      const choose = async () => {
        await api.setSetting('default_install_path', row.dataset.path);
        state.settings = await api.getAllSettings();
        toast(`Default install folder: ${row.dataset.path}`, 'success');
        renderInstallLocations();
      };
      row.onclick = (e) => { if (!e.target.closest('.loc-remove')) choose(); };
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
      });
      const remove = row.querySelector('.loc-remove');
      if (remove) remove.onclick = async (e) => {
        e.stopPropagation();
        await api.removeInstallLocation(row.dataset.path);
        state.settings = await api.getAllSettings();
        renderInstallLocations();
      };
    });
  }

  /**
   * Decide where a download should land.
   * Honours an explicit per-job destination first (updates and repairs must go
   * back to where the game already lives), then the saved default, and only
   * then asks — so a configured user is never interrupted.
   */
  async function chooseDestination(gameData, requiredBytes, forcedPath) {
    if (forcedPath) return forcedPath;

    const askEveryTime = state.settings.ask_install_location !== false;
    const preset = state.settings.default_install_path || '';
    if (!askEveryTime && preset) return preset;

    // Legacy behaviour is preserved for anyone who had library_mode switched on.
    if (!askEveryTime && !preset && state.settings.library_mode) {
      return showSteamLibrarySelection();
    }

    return showDestinationPicker(gameData, requiredBytes, preset);
  }

  function showDestinationPicker(gameData, requiredBytes, preset) {
    return new Promise(async (resolve) => {
      let locations = [];
      try { locations = await api.listInstallLocations(); } catch { locations = []; }

      // Fall back to whatever Steam knows about if nothing is configured yet.
      if (!locations.length) {
        try {
          const steamRoot = await api.findSteamInstall();
          if (steamRoot) locations = [{ path: steamRoot, kind: 'steam', exists: true, free: null, total: null, isDefault: true }];
        } catch { /* no Steam install — the Browse button still works */ }
      }

      let selected = preset || (locations.find(l => l.isDefault) || locations[0] || {}).path || '';

      const sizeLine = requiredBytes > 0
        ? `<b class="text-accent">${esc(formatSize(requiredBytes))}</b> needed`
        : 'Size unknown until the download starts';

      const body = `
        <div class="dest-picker">
          <div class="dest-head">
            <div class="dest-game">${esc(gameData?.game_name || 'This download')}</div>
            <div class="dest-size">${sizeLine}</div>
          </div>
          <div id="dest-list">
            ${locations.length
              ? locations.map(loc => locationRowHtml({ ...loc, isDefault: loc.path === selected }, requiredBytes)).join('')
              : '<div class="empty-state-small">No install folders found. Browse for one below.</div>'}
          </div>
          <button class="dest-browse" id="dest-browse">📂 Choose another folder…</button>
          <label class="toggle-row" style="margin-top:4px">
            <input type="checkbox" id="dest-remember">
            <span class="toggle-slider"></span>
            <span>Remember this and stop asking</span>
          </label>
          <div class="modal-actions">
            <button class="xbox-btn xbox-btn-secondary" id="dest-cancel">Cancel</button>
            <button class="xbox-btn xbox-btn-primary" id="dest-ok">Install here</button>
          </div>
        </div>`;

      openModal('Where should this install?', body);

      const okBtn = $('#dest-ok');
      const syncOk = () => { if (okBtn) okBtn.disabled = !selected; };

      const wireRows = () => {
        $$('#dest-list .loc-row').forEach((row) => {
          row.onclick = () => {
            $$('#dest-list .loc-row').forEach(r => r.classList.remove('is-default'));
            row.classList.add('is-default');
            selected = row.dataset.path;
            syncOk();
          };
        });
      };
      wireRows();
      syncOk();

      const done = async (value) => {
        if (value && $('#dest-remember')?.checked) {
          try {
            await api.addInstallLocation(value);
            await api.setSetting('default_install_path', value);
            await api.setSetting('ask_install_location', false);
            state.settings = await api.getAllSettings();
          } catch { /* the download still proceeds even if the preference fails to stick */ }
        }
        closeModal();
        $('#modal-close').onclick = closeModal;
        resolve(value);
      };

      $('#dest-browse').onclick = async () => {
        const folder = await api.openFolder({
          title: 'Choose where to install',
          buttonLabel: 'Install here',
          defaultPath: selected || undefined,
        });
        if (!folder) return;
        selected = folder;
        const list = $('#dest-list');
        if (list) {
          list.insertAdjacentHTML('afterbegin', locationRowHtml(
            { path: folder, kind: 'custom', exists: true, free: null, total: null, isDefault: true },
            requiredBytes
          ));
          $$('#dest-list .loc-row').forEach((r, i) => r.classList.toggle('is-default', i === 0));
          wireRows();
        }
        syncOk();
      };

      $('#dest-cancel').onclick = () => done(null);
      $('#modal-close').onclick = () => done(null);
      okBtn.onclick = () => done(selected);
    });
  }

  // ─── Install plan ───────────────────────────────────
  // Steam only ever asks "which depot?". The manifest knows every file and its
  // size, so we can show what is actually inside the install and let the user
  // leave out what they will never touch.

  const PLAN_COLORS = {
    core: 'var(--primary)',
    redist: '#8A8377',
    video: '#A98BD0',
    audio: '#74BBAB',
    hd: '#7FA7D9',
    extras: '#C6A15B',
  };

  /** Stable colour per group — languages get a hue derived from their name. */
  function planColor(group) {
    if (PLAN_COLORS[group.id]) return PLAN_COLORS[group.id];
    return `hsl(${artSeed(group.label) % 360} 58% 60%)`;
  }

  /**
   * Animate a number without letting a stalled frame clock strand it mid-count:
   * the final value is always written by a timer, whatever the tween did.
   */
  function tweenNumber(el, from, to, ms, format) {
    const start = performance.now();
    const settle = () => { el.textContent = format(to); };
    if (from === to) { settle(); return; }

    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = format(from + (to - from) * eased);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    clearTimeout(el._tweenGuard);
    el._tweenGuard = setTimeout(settle, ms + 60);
  }

  function splitSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const value = Math.max(0, Number(bytes) || 0);
    const i = value <= 0 ? 0 : Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    return { value: value / Math.pow(1024, i), unit: units[i] };
  }

  /**
   * Ask what to install. Resolves to { excludeGroups, totalBytes } or null when
   * the user backs out. Returns immediately when there is nothing worth asking
   * about, so small games never see an extra step.
   */
  /**
   * One list of everything you can choose to install, whatever granularity
   * Steam happened to use.
   *
   * A game splits its content across depots; inside a base-game depot it splits
   * again across folders. Those are the same question — "do you want the French
   * voice-over?" — so they belong in one list, and only get resolved back into
   * depot ids and file groups when the download actually starts. Non-core
   * depots become a row each and are kept out of the file-level pass, so no
   * byte is ever counted twice.
   */
  async function buildInstallRows(gameData, presetDepots) {
    const manifests = gameData.manifests || {};
    const { groups, defaults } = classifyDepots(gameData);
    const wanted = (presetDepots && presetDepots.length) ? new Set(presetDepots) : defaults;

    const rows = new Map();
    const row = (id, base) => {
      let r = rows.get(id);
      if (!r) { r = { id, bytes: 0, files: 0, depots: [], fileGroups: [], ...base }; rows.set(id, r); }
      return r;
    };

    for (const e of groups.language) {
      const name = e.langs[0] || cleanDepotName(e, gameData.game_name);
      const r = row(`lang:${name}`, { label: name, icon: '⌘', safety: 'optional', hint: `Text and voice for ${name}.` });
      r.bytes += e.bytes; r.depots.push(e.id);
    }
    for (const e of groups.optional) {
      const r = row(`depot:${e.id}`, { label: cleanDepotName(e, gameData.game_name), icon: '◱', safety: 'optional', hint: 'Optional pack — the game runs fine without it.' });
      r.bytes += e.bytes; r.depots.push(e.id);
    }
    for (const e of groups.shared) {
      const r = row('redist', { label: 'Redistributables', icon: '⚙', safety: 'recommended', hint: 'DirectX, VC++ and friends. Skip if your system already has them.' });
      r.bytes += e.bytes; r.depots.push(e.id);
    }

    // Only the base game gets opened up file by file — and only the native
    // engine can act on that, so anything else keeps it as one indivisible row.
    const coreIds = groups.core.map(e => e.id).filter(id => manifests[id]);
    let fileCount = 0;
    let inv = null;
    if (api.getDepotInventory && coreIds.length) {
      try { inv = await api.getDepotInventory({ gameData, selectedDepots: coreIds }); }
      catch (e) { log(`⚠ Could not read the file list: ${e.message}`); }
    }
    if (inv?.ok && inv.groups?.length) {
      fileCount = inv.fileCount || 0;
      for (const g of inv.groups) {
        // A language found inside the base game is the same row as a language
        // shipped as its own depot.
        const key = (g.kind === 'language' || g.id.startsWith('loc:')) ? `lang:${g.label}` : g.id;
        const r = row(key, { label: g.label, icon: g.icon, safety: g.safety, hint: g.hint });
        r.bytes += g.bytes; r.files += g.files; r.fileGroups.push(g.id);
      }
    } else {
      const r = row('core', { label: 'Game files', icon: '▣', safety: 'required', hint: 'Engine, code and assets the game cannot start without.' });
      for (const e of groups.core) { r.bytes += e.bytes; r.depots.push(e.id); }
    }

    const list = [...rows.values()];
    const totalBytes = list.reduce((s, r) => s + r.bytes, 0);
    const rank = { required: 0, recommended: 1, optional: 2 };
    for (const r of list) r.share = totalBytes ? r.bytes / totalBytes : 0;
    list.sort((a, b) => (rank[a.safety] - rank[b.safety]) || (b.bytes - a.bytes));

    // A row starts off when every depot behind it was left unticked.
    const off = new Set(list.filter(r => r.depots.length && !r.depots.some(id => wanted.has(id))).map(r => r.id));

    return {
      ok: list.length > 0,
      groups: list,
      totalBytes,
      fileCount,
      off,
      intro: installIntroText(gameData, groups),
      optionalBytes: list.filter(r => r.safety !== 'required').reduce((s, r) => s + r.bytes, 0),
      // Turn the user's choices back into the two things the engine understands.
      resolve(excluded) {
        const keep = list.filter(r => !excluded.has(r.id));
        const depots = new Set(coreIds);
        for (const r of keep) for (const id of r.depots) depots.add(id);
        return {
          depots: [...depots],
          excludeGroups: list.filter(r => excluded.has(r.id)).flatMap(r => r.fileGroups),
          totalBytes: keep.reduce((s, r) => s + r.bytes, 0),
        };
      },
    };
  }

  function showInstallSheet(gameData, presetDepots) {
    return new Promise(async (resolve) => {
      const inventory = await buildInstallRows(gameData, presetDepots);
      // Nothing to decide: take the complete recommended set and move on. This
      // is why a plain single-depot game never sees this step at all.
      const take = () => resolve(inventory.resolve(new Set(inventory.off)));
      if (!inventory.ok) { take(); return; }

      const optional = inventory.groups.filter(g => g.safety !== 'required');
      const worthAsking = inventory.optionalBytes >= 100 * 1024 * 1024 || optional.length >= 2;
      if (!worthAsking) { take(); return; }

      const panel = $('#plan');
      const excluded = new Set(inventory.off);

      // ── Header ──
      $('#plan-title').textContent = gameData.game_name || 'This game';
      $('#plan-legend').textContent = inventory.intro;
      renderPlanPoster(gameData);

      // ── Bar: one segment per group, sized by share of the full install ──
      $('#plan-bar').innerHTML = inventory.groups.map(g => `
        <span class="plan-seg${excluded.has(g.id) ? ' off' : ''}" data-group="${esc(g.id)}"
              style="width:${(g.share * 100).toFixed(3)}%;--seg:${planColor(g)}"
              title="${esc(g.label)} — ${esc(formatSize(g.bytes))}"></span>`).join('');

      // ── Cards ──
      $('#plan-groups').innerHTML = inventory.groups.map((g, i) => {
        const required = g.safety === 'required';
        const on = !excluded.has(g.id);
        return `
        <article class="plan-card${required ? ' required' : ''}${on ? '' : ' off'}" data-group="${esc(g.id)}"
                 style="--seg:${planColor(g)};--i:${i}"${required ? '' : ` tabindex="0" role="switch" aria-checked="${on}"`}>
          <div class="plan-card-top">
            <span class="plan-ico">${esc(g.icon)}</span>
            <span class="plan-name">${esc(g.label)}</span>
            ${required
              ? '<span class="plan-lock">Required</span>'
              : '<span class="plan-switch" aria-hidden="true"><i></i></span>'}
          </div>
          <div class="plan-card-size">${esc(formatSize(g.bytes))}</div>
          <div class="plan-card-meta">${(g.share * 100).toFixed(g.share < 0.01 ? 2 : 1)}%${g.files ? ` · ${g.files.toLocaleString()} files` : ''}</div>
          <div class="plan-card-hint">${esc(g.hint)}</div>
          <div class="plan-card-fill"></div>
        </article>`;
      }).join('');

      // ── Live totals ──
      const fullBytes = inventory.totalBytes;
      let shownBytes = fullBytes;

      const refresh = () => {
        const keep = inventory.groups
          .filter(g => !excluded.has(g.id))
          .reduce((sum, g) => sum + g.bytes, 0);

        const size = splitSize(keep);
        tweenNumber($('#plan-size-num'), splitSize(shownBytes).value, size.value, 520,
          (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1)));
        $('#plan-size-unit').textContent = size.unit;
        shownBytes = keep;

        const saved = fullBytes - keep;
        const savings = $('#plan-savings');
        if (saved > 0) {
          savings.classList.remove('hidden');
          $('#plan-full-size').textContent = formatSize(fullBytes);
          $('#plan-saved').textContent = `saving ${formatSize(saved)}`;
          savings.classList.remove('pop'); void savings.offsetWidth; savings.classList.add('pop');
        } else {
          savings.classList.add('hidden');
        }

        // Warn only about the group that can actually stop a game starting.
        const warn = $('#plan-warn');
        if (excluded.has('redist')) {
          warn.textContent = 'Without redistributables the game may not start on a clean system.';
          warn.classList.remove('hidden');
        } else {
          warn.classList.add('hidden');
        }

        $('#plan-go').textContent = `Install ${formatSize(keep)}`;
        $('#plan-all').classList.toggle('hidden', excluded.size === 0);
      };

      const setExcluded = (id, off) => {
        if (off) excluded.add(id); else excluded.delete(id);
        $(`.plan-card[data-group="${CSS.escape(id)}"]`)?.classList.toggle('off', off);
        $(`.plan-card[data-group="${CSS.escape(id)}"]`)?.setAttribute('aria-checked', String(!off));
        $(`.plan-seg[data-group="${CSS.escape(id)}"]`)?.classList.toggle('off', off);
        refresh();
      };

      $$('#plan-groups .plan-card:not(.required)').forEach((card) => {
        const toggle = () => {
          const id = card.dataset.group;
          setExcluded(id, !excluded.has(id));
          card.classList.remove('bump'); void card.offsetWidth; card.classList.add('bump');
        };
        card.onclick = toggle;
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
      });

      refresh();
      // First paint starts from the full size so the number counts down into place.
      shownBytes = fullBytes;

      // ── Open ──
      panel.classList.remove('hidden', 'closing');
      Object.assign(document.documentElement.dataset, {});

      const finish = (value) => {
        document.removeEventListener('keydown', onKey, true);
        panel.classList.add('closing');
        setTimeout(() => { panel.classList.add('hidden'); panel.classList.remove('closing'); }, 220);
        resolve(value);
      };

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(null); }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); confirmPlan(); }
      }
      const confirmPlan = () => finish(inventory.resolve(excluded));

      document.addEventListener('keydown', onKey, true);
      $('#plan-go').onclick = confirmPlan;
      $('#plan-cancel').onclick = () => finish(null);
      $('#plan-close').onclick = () => finish(null);
      $('#plan-all').onclick = () => {
        [...excluded].forEach(id => setExcluded(id, false));
      };
      // Smallest install that still runs and still has a language.
      $('#plan-lean').onclick = () => {
        const langs = inventory.groups.filter(g => g.id.startsWith('lang:'));
        const keepLang = (langs.filter(g => !inventory.off.has(g.id)).length ? langs.filter(g => !inventory.off.has(g.id)) : langs)
          .slice().sort((a, b) => a.bytes - b.bytes)[0];
        inventory.groups.forEach((g) => {
          if (g.safety === 'required' || g.safety === 'recommended') { setExcluded(g.id, false); return; }
          setExcluded(g.id, !keepLang || g.id !== keepLang.id);
        });
      };
    });
  }

  function renderPlanPoster(gameData) {
    const host = $('#plan-poster');
    if (!host) return;
    const name = gameData.game_name || '';
    host.innerHTML = artFallbackHtml(name);

    const appId = safeAppId(gameData.appid);
    if (!appId || appId === '0') return;

    const probe = (src) => new Promise((ok, no) => {
      if (!src) { no(); return; }
      const img = new Image();
      img.onload = () => (img.naturalWidth > 1 ? ok(src) : no());
      img.onerror = no;
      img.src = src;
    });

    probe(steamPortraitUrl(appId))
      .then((url) => { host.innerHTML = `<img src="${esc(url)}" alt="">`; })
      .catch(() => probe(steamHeaderUrl(appId))
        .then((url) => { host.innerHTML = `<img class="wide" src="${esc(url)}" alt="">`; })
        .catch(() => {}));
  }

  // ─── Depot Selection Modal ──────────────────────────
  // A game's install is the *union* of its depots. Steam splits games up for a
  // few reasons: the base game across several "core" depots (for size and
  // incremental updates), separate per-language voice/text, optional HD or
  // ray-tracing packs, and shared redistributables. The thing people get wrong
  // is that multiple Windows depots are almost always ADDITIVE — all part of the
  // game — not alternatives to pick between. So we classify each depot, choose a
  // complete and correct default, and only interrupt when there's a real choice.

  // Two tiers on purpose. A depot name is the *product's* name too, so a bare
  // "HD" or "4K" is no evidence at all — "FINAL FANTASY X HD Remaster" is the
  // whole game, not an optional pack. Only the unambiguous markers stand alone;
  // the resolution words need pack-shaped context before we dare untick them.
  const DEPOT_OPTIONAL_STRONG_RE = /\b(ray[\s_-]?trac\w*|rtx|dlss|texture[\s_-]?pack|soundtrack|\bost\b|art\s?book|wallpapers?|digital[\s_-]?deluxe|bonus[\s_-]+(content|material|pack|items?|dlc))\b/i;
  const DEPOT_OPTIONAL_WEAK_RE = /\b(\bhd\b|\b4k\b|uhd|ultra[\s_-]?hd|high[\s_-]?res\w*|hi[\s_-]?res|\bhq\b)\b/i;
  const DEPOT_PACK_CONTEXT_RE = /\b(packs?|textures?|assets?|add[\s_-]?ons?|dlc|optional|extras?|upgrades?)\b/i;
  const depotLooksOptional = (desc) => DEPOT_OPTIONAL_STRONG_RE.test(desc)
    || (DEPOT_OPTIONAL_WEAK_RE.test(desc) && DEPOT_PACK_CONTEXT_RE.test(desc));

  // Same trap on the language side: getDepotTags matches language names as
  // substrings, so "English Country Tune" and "Danish Delights" come back
  // tagged. A depot is only a language pack if it *reads* like one — either it
  // says so, or nothing but the language name is left once filler is stripped.
  const LOC_MARKER_RE = /\b(lang(uages?)?|localis\w*|localiz\w*|\bloc\b|voices?|\bvo\b|audio|speech|dub(bing)?|subtitles?|\bsubs?\b|texts?)\b/i;
  const DEPOT_FILLER_RE = /\b(content|contents|data|depot|files?|windows|win(32|64)?|game|install|only|support|version|pack|packs)\b/gi;
  function depotLooksLikeLanguagePack(desc, langs) {
    if (LOC_MARKER_RE.test(desc)) return true;
    let rest = desc;
    for (const l of langs) rest = rest.replace(new RegExp(`\\b${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ');
    rest = rest.replace(DEPOT_FILLER_RE, ' ').replace(/[^a-z]+/gi, ' ').trim();
    return rest.length === 0;                              // nothing but the language name
  }

  /** Languages the user's system prefers, always including English as a fallback. */
  function systemLanguageSet() {
    const map = { en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian',
      ja: 'Japanese', zh: 'Chinese', ko: 'Korean', ru: 'Russian', pl: 'Polish', pt: 'Portuguese',
      tr: 'Turkish', ar: 'Arabic', cs: 'Czech', nl: 'Dutch', hu: 'Hungarian', ro: 'Romanian',
      th: 'Thai', vi: 'Vietnamese', uk: 'Ukrainian', fi: 'Finnish', da: 'Danish', nb: 'Norwegian',
      no: 'Norwegian', sv: 'Swedish' };
    const set = new Set(['English']);
    const prefs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || 'en'];
    for (const pref of prefs) {
      const name = map[String(pref).slice(0, 2).toLowerCase()];
      if (name) set.add(name);
    }
    return set;
  }

  /**
   * Sort every depot into a role and decide what to tick by default.
   * Bias: an unknown Windows depot is treated as core (part of the game) and
   * checked — so the default download is always complete and playable. The
   * worst case is downloading a little more than strictly needed, never a
   * broken install.
   */
  /*
   * Does this depot carry a build this machine can run?
   *
   * Librarian only ships for Windows, so that is the whole question. An empty
   * or missing list means "no platform stated", which for a shared or content
   * depot is normal — those are answered as yes, because excluding something
   * unlabelled would break the install, and the bias everywhere in here is that
   * a wrong exclusion costs more than a wrong inclusion.
   */
  const HOST_OS = 'windows';
  function runsOnThisMachine(depot) {
    const os = depot && depot.os;
    if (!Array.isArray(os) || !os.length) return true;
    return os.some(o => String(o).toLowerCase() === HOST_OS);
  }

  function classifyDepots(gameData) {
    const depots = gameData.depots || {};
    const manifests = gameData.manifests || {};
    const sysLangs = systemLanguageSet();

    const groups = { core: [], language: [], optional: [], shared: [], unavailable: [], foreign: [] };
    const defaults = new Set();

    for (const [id, d] of Object.entries(depots)) {
      const bytes = Number(d.size) || 0;
      const desc = d.desc || '';
      const langs = (d.tags || []).filter(t => t && t.type === 'lang').map(t => t.label);
      let role;
      let onByDefault = false;

      if (!manifests[id]) {
        role = 'unavailable';
      } else if (!runsOnThisMachine(d)) {
        /*
         * A depot for another operating system.
         *
         * This branch did not exist, and the fall-through below was commented
         * "unknown Windows depot" while nothing ever checked the OS — so a game
         * shipping Mac and Linux builds had all of them classified as core and
         * ticked by default. LIMBO offers Windows, Mac, Linux and Linux 64-bit;
         * that is four copies of the same game, and the user pays for three of
         * them in bandwidth and disk.
         *
         * zipProcessor already works the platform out per depot, from Steam's
         * oslist where the API answers and from the depot description otherwise.
         * The data was there all along; only this was missing.
         */
        role = 'foreign';
      } else if (d.isShared) {
        role = 'shared';
        onByDefault = true;                                // redistributables: keep
      } else if (langs.length && depotLooksLikeLanguagePack(desc, langs)) {
        role = 'language';
        onByDefault = langs.some(l => sysLangs.has(l));    // only the user's language(s)
      } else if (depotLooksOptional(desc)) {
        role = 'optional';                                 // HD / RT / soundtrack: opt-in
      } else {
        role = 'core';
        onByDefault = true;                                // unknown Windows depot → part of the game
      }

      groups[role].push({ id, desc: d.desc || `Depot ${id}`, bytes, langs, role, os: d.os || ['windows'], arch: d.osarch || null });
      if (onByDefault) defaults.add(id);
    }

    // Backstop. Every heuristic above can only ever move a depot *out* of the
    // download, so a bad guess costs the user a broken install. A game always
    // has content somewhere: if we classified our way to zero core depots, the
    // guess was wrong — hand them back rather than ship an empty folder.
    if (!groups.core.length) {
      const rescue = groups.optional.length ? 'optional'
        : (groups.language.length ? 'language'
        : (groups.foreign.length ? 'foreign' : null));
      if (rescue) {
        // 'foreign' is last on purpose: it is the right answer only when the
        // game ships nothing for this machine at all, and handing back a Mac
        // build beats handing back an empty folder with no explanation.
        for (const e of groups[rescue]) { e.role = 'core'; groups.core.push(e); defaults.add(e.id); }
        groups[rescue] = [];
      }
    }

    // A game that splits language into depots must end up with at least one, or
    // it installs with no text/voice at all. If nothing matched, keep the largest.
    if (groups.language.length && !groups.language.some(e => defaults.has(e.id))) {
      const fallback = [...groups.language].sort((a, b) => b.bytes - a.bytes)[0];
      if (fallback) defaults.add(fallback.id);
    }

    // Only worth interrupting the user when there is a genuine decision — a
    // language to choose or an optional pack to skip. All-core installs just go.
    const worthShowing = groups.language.length > 0 || groups.optional.length > 0;

    return { groups, defaults, worthShowing };
  }

  // Depot descriptions are written for Valve's tooling, not for players:
  // "DOOM The Dark Ages Ray Tracing Content". Drop the game's own name and the
  // trailing filler so the row just reads "Ray Tracing".
  function cleanDepotName(e, gameName) {
    const raw = (e.desc || '').trim();
    if (/^depot\s+\d+$/i.test(raw) && e.role === 'core') return 'Game data';
    let name = raw;
    if (gameName) {
      // Every non-alphanumeric run becomes a flexible separator, which also
      // means nothing from the title survives as a regex metacharacter.
      const loose = String(gameName).trim().replace(/[^a-z0-9]+/gi, '[^a-z0-9]*');
      if (loose) name = name.replace(new RegExp(`^\\s*${loose}\\s*[-–:]?\\s*`, 'i'), '');
    }
    name = name.replace(/\s*\b(contents?|data|files?|depot)\b\s*$/i, '').trim();
    if (!name) return raw || `Depot ${e.id}`;
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  // Steam ships a game as several depots for reasons nobody downloading it
  // cares about — size limits, incremental patching, per-language voice. Say
  // what that means for *this* game in one line, so a base game arriving in
  // four parts doesn't read as four things to choose between.
  function installIntroText(gameData, groups) {
    const name = gameData.game_name || 'This game';
    const bits = [];
    bits.push(groups.core.length > 1
      ? `arrives in ${groups.core.length} parts that all belong to the base game`
      : 'installs as one base game');
    if (groups.language.length) bits.push(`${groups.language.length} language${groups.language.length === 1 ? '' : 's'}`);
    if (groups.optional.length) bits.push(`${groups.optional.length} optional pack${groups.optional.length === 1 ? '' : 's'}`);
    return `${name} ${bits.join(', ')}. Everything you need is already ticked.`;
  }

  // ─── Steam Library Selection Modal ──────────────────
  function showSteamLibrarySelection() {
    return new Promise(async (resolve) => {
      const libs = await api.getSteamLibraries();
      if (!libs.length) { toast('No Steam libraries found', 'error'); resolve(null); return; }

      let html = '<div class="text-dim font-bold mb-12" style="font-size:13px">Choose download destination</div><ul class="library-list">';
      libs.forEach((lib, i) => {
        html += `<li class="library-item ${i === 0 ? 'selected' : ''}" data-path="${esc(lib)}"><div class="library-radio"></div><span class="library-path">${esc(lib)}</span></li>`;
      });
      html += `</ul><div class="modal-actions"><button class="xbox-btn xbox-btn-secondary" id="lib-cancel">Cancel</button><button class="xbox-btn xbox-btn-primary" id="lib-ok">Select</button></div>`;

      openModal('Steam Library', html);
      $$('.library-item').forEach(el => el.onclick = () => { $$('.library-item').forEach(i => i.classList.remove('selected')); el.classList.add('selected'); });

      const done = (v) => { closeModal(); $('#modal-close').onclick = closeModal; resolve(v); };
      $('#lib-cancel').onclick = () => done(null);
      $('#modal-close').onclick = () => done(null);
      $('#lib-ok').onclick = () => { const s = document.querySelector('.library-item.selected'); done(s ? s.dataset.path : null); };
    });
  }

  // ─── Add / Edit Custom Game ────────────────────────
  function showCustomUpdateAssociation(game) {
    let manifestPath = game.update_link?.imported_manifest || '';
    let preview = null;
    let generation = 0;
    openModal('Link game updates', `
      <div class="custom-update-form">
        <p>Associate this installation with its Steam AppID and the public branch. The game stays in its current folder.</p>
        <div class="custom-update-path">${esc(game.install_path)}</div>
        <label for="cu-appid">Steam AppID</label>
        <input class="form-input" id="cu-appid" inputmode="numeric" value="${esc(game.appid || '')}" placeholder="AppID of this game">
        <label for="cu-build">Installed build, if known <span class="text-dim">(optional)</span></label>
        <input class="form-input" id="cu-build" inputmode="numeric" value="${esc(game.update_link?.declared_build || '')}" placeholder="Leave empty when unknown">
        <p class="text-dim">A local app manifest takes priority. A manually entered build is labelled as declared; the executable's version is not a Steam build ID.</p>
        <div class="custom-update-row"><button class="xbox-btn xbox-btn-secondary btn-sm" id="cu-acf">Choose .acf</button><button class="xbox-btn xbox-btn-secondary btn-sm" id="cu-clear-acf">Clear</button><span id="cu-acf-path" class="custom-update-path">${esc(manifestPath || 'Detect from the installation folder')}</span></div>
        <div id="cu-result" class="custom-update-result" role="status" aria-live="polite">Check the game and builds before linking.</div>
        <div class="modal-actions">
          ${game.update_link ? '<button class="xbox-btn xbox-btn-secondary" id="cu-unlink">Unlink updates</button>' : ''}
          <button class="xbox-btn xbox-btn-secondary" id="cu-inspect">Check builds</button>
          <button class="xbox-btn xbox-btn-primary" id="cu-save" disabled>Link this installation</button>
        </div>
      </div>`);
    const result = $('#cu-result'), save = $('#cu-save'), inspect = $('#cu-inspect');
    const options = () => ({ appid: $('#cu-appid').value.trim(), declaredBuild: $('#cu-build').value.trim(), manifestPath });
    const invalidate = () => { generation++; preview = null; save.disabled = true; result.textContent = 'Check the game and builds again to confirm these changes.'; };
    $('#cu-appid').oninput = invalidate;
    $('#cu-build').oninput = invalidate;
    $('#cu-acf').onclick = async () => {
      const selected = await api.openFile({ filters: [{ name: 'Steam app manifest', extensions: ['acf'] }] });
      if (!selected || !result.isConnected) return;
      manifestPath = selected; $('#cu-acf-path').textContent = selected; invalidate();
    };
    $('#cu-clear-acf').onclick = () => { manifestPath = ''; $('#cu-acf-path').textContent = 'Detect from the installation folder'; invalidate(); };
    inspect.onclick = async () => {
      const token = ++generation;
      preview = null; save.disabled = true; inspect.disabled = true; result.textContent = 'Reading the installation and checking the public build…';
      try {
        const inputs = options();
        const found = await api.inspectCustomUpdates(game.id, inputs);
        if (!result.isConnected || token !== generation) return;
        const { local, remote, comparison } = found;
        const evidence = local.source === 'manifest' ? 'Read from a local app manifest' : local.source === 'declared' ? 'Entered manually — not verified' : 'No local build record';
        const labels = { up_to_date: 'Version record matches the public build', update_available: 'A newer public build is available', unknown: 'The installed version cannot be compared', error: 'The remote build could not be checked' };
        if (local.buildId && remote.remoteBuildId && BigInt(local.buildId) > BigInt(remote.remoteBuildId)) labels.up_to_date = 'The installed build record is newer than public. Check the branch before updating.';
        result.innerHTML = `<strong>${esc(remote.gameName || game.game_name)}</strong><dl>
          <dt>AppID / branch</dt><dd>${esc(local.appid)} / public</dd>
          <dt>Installed build</dt><dd>${esc(local.buildId || 'Unknown')}</dd>
          <dt>Evidence</dt><dd>${esc(evidence)}</dd>
          <dt>Public build</dt><dd>${esc(remote.remoteBuildId || 'Unavailable')}</dd>
          <dt>Update folder</dt><dd>${esc(local.installPath)}</dd>
        </dl><p>${esc(remote.error || labels[comparison.status] || comparison.reason || '')}</p>`;
        if (!remote.error && remote.remoteBuildId) { preview = { ...found, inputs }; save.disabled = false; }
      } catch (error) { if (result.isConnected && token === generation) result.textContent = error.message; }
      finally { if (result.isConnected) inspect.disabled = false; }
    };
    const reopen = async () => {
      closeModal(); closeFlyout(); await scanAndRender();
      const refreshed = state.games.find(entry => entry.id === game.id);
      if (refreshed) openFlyout(refreshed);
    };
    save.onclick = async () => {
      if (!preview) return;
      save.disabled = true;
      try {
        const linked = await api.associateCustomUpdates(game.id, { ...preview.inputs, expectedInstallPath: preview.local.installPath });
        state.updateResults[updateResultKey(linked)] = preview.comparison;
        persistUpdateResults();
        await reopen(); toast('Updates linked to this installation', 'success');
      } catch (error) { result.textContent = error.message; save.disabled = false; }
    };
    const unlink = $('#cu-unlink');
    if (unlink) unlink.onclick = async () => {
      unlink.disabled = true;
      try { await api.disconnectCustomUpdates(game.id); delete state.updateResults[updateResultKey(game)]; persistUpdateResults(); await reopen(); toast('Update association removed'); }
      catch (error) { result.textContent = error.message; unlink.disabled = false; }
    };
  }

  function buildCustomGameForm(existing = null) {
    const gn = existing ? esc(existing.game_name) : '';
    const ip = existing ? esc(existing.install_path) : '';
    const ex = existing ? esc(existing.executable || '') : '';
    const ai = existing ? esc(existing.appid || '') : '';
    const bp = existing ? esc(existing.banner_path || '') : '';

    return `
      <div class="form-group">
        <label>Game Folder <span style="color:var(--accent-red)">*</span></label>
        <div class="color-pick-row">
          <button class="xbox-btn xbox-btn-secondary btn-sm" id="cg-browse-path">📂 Browse</button>
          <span class="font-mono text-dim" style="font-size:12px" id="cg-path-label">${ip || 'No folder selected'}</span>
        </div>
        <input type="hidden" id="cg-path" value="${ip}">
      </div>
      <div class="form-group">
        <label>Game Name <span style="color:var(--accent-red)">*</span></label>
        <input type="text" class="form-input" id="cg-name" value="${gn}" placeholder="e.g. Half-Life 2">
      </div>
      <div class="form-group">
        <label>AppID <span class="text-dim" style="font-size:11px">(auto-detected or manual)</span></label>
        <div class="color-pick-row">
          <input type="text" class="form-input" id="cg-appid" value="${ai}" placeholder="e.g. 220" style="flex:1">
          <button class="xbox-btn xbox-btn-secondary btn-sm" id="cg-detect-btn">🔍 Detect</button>
        </div>
        <div id="cg-suggestions" style="margin-top:6px"></div>
      </div>
      <div class="form-group">
        <label>Executable <span class="text-dim" style="font-size:11px">(optional, for Play button)</span></label>
        <div class="color-pick-row">
          <button class="xbox-btn xbox-btn-secondary btn-sm" id="cg-browse-exe">📂 Browse</button>
          <span class="font-mono text-dim" style="font-size:12px" id="cg-exe-label">${ex || 'None'}</span>
        </div>
        <input type="hidden" id="cg-exe" value="${ex}">
      </div>
      <div class="form-group">
        <label>Custom Banner Image <span class="text-dim" style="font-size:11px">(optional, falls back to Steam CDN)</span></label>
        <div class="color-pick-row">
          <button class="xbox-btn xbox-btn-secondary btn-sm" id="cg-browse-banner">🖼️ Browse</button>
          <span class="font-mono text-dim" style="font-size:12px" id="cg-banner-label">${bp || 'None (uses Steam CDN if AppID set)'}</span>
        </div>
        <input type="hidden" id="cg-banner" value="${bp}">
        <div id="cg-banner-preview" style="margin-top:8px">
          ${bp ? `<img src="${esc(filePathToUrl(bp))}" style="max-height:80px;border-radius:6px">` : ''}
        </div>
      </div>
    `;
  }

  function wireCustomGameFormEvents() {
    // Browse for game folder
    $('#cg-browse-path').onclick = async () => {
      const folder = await api.openFolder();
      if (!folder) return;
      $('#cg-path').value = folder;
      $('#cg-path-label').textContent = folder;
      // Auto-fill name from folder
      if (!$('#cg-name').value) {
        $('#cg-name').value = folder.split(/[\\/]/).pop();
      }
      // Auto-detect AppID
      const detectedId = await api.detectAppId(folder);
      if (detectedId) {
        $('#cg-appid').value = detectedId;
        toast(`AppID auto-detected: ${detectedId}`, 'success');
      } else {
        // Try suggesting from folder name
        runAppIdSuggestion($('#cg-name').value || folder.split(/[\\/]/).pop());
      }
    };

    // Manual detect button
    $('#cg-detect-btn').onclick = async () => {
      const gamePath = $('#cg-path').value;
      if (gamePath) {
        const detectedId = await api.detectAppId(gamePath);
        if (detectedId) {
          $('#cg-appid').value = detectedId;
          toast(`AppID detected: ${detectedId}`, 'success');
          return;
        }
      }
      // Fallback: suggest by name
      const name = $('#cg-name').value.trim();
      if (name) {
        runAppIdSuggestion(name);
      } else {
        toast('Enter a game name or select a folder first', 'error');
      }
    };

    // Browse for executable
    $('#cg-browse-exe').onclick = async () => {
      const fp = await api.openFile({ filters: [{ name: 'Executables', extensions: ['exe'] }] });
      if (fp) {
        $('#cg-exe').value = fp;
        $('#cg-exe-label').textContent = fp.split(/[\\/]/).pop();
      }
    };

    // Browse for banner
    $('#cg-browse-banner').onclick = async () => {
      const fp = await api.openImageDialog();
      if (fp) {
        $('#cg-banner').value = fp;
        $('#cg-banner-label').textContent = fp.split(/[\\/]/).pop();
        $('#cg-banner-preview').innerHTML = `<img src="${esc(filePathToUrl(fp))}" style="max-height:80px;border-radius:6px">`;
      }
    };
  }

  async function runAppIdSuggestion(query) {
    const sugDiv = $('#cg-suggestions');
    sugDiv.innerHTML = '<span class="text-dim" style="font-size:11px">🔍 Searching...</span>';
    const res = await api.suggestAppId(query);
    const games = res.results || [];
    if (!games.length) {
      sugDiv.innerHTML = '<span class="text-dim" style="font-size:11px">No matches found. Enter AppID manually.</span>';
      return;
    }
    const top = games.slice(0, 5);
    sugDiv.innerHTML = '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Suggestions (click to select):</div>' +
      top.map(g => {
        const id = safeAppId(g.game_id);
        if (!id) return '';
        return `<button class="cg-suggest-btn" data-id="${id}" style="
        display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;margin-bottom:4px;
        background:var(--bg-input);border:1px solid var(--border);border-radius:6px;
        color:var(--text);cursor:pointer;font-size:12px;text-align:left;
      ">
        <img src="https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/capsule_sm_120.jpg"
             style="width:40px;height:18px;border-radius:3px;object-fit:cover" data-hide-on-error="">
        <span style="flex:1">${esc(g.game_name || '')}</span>
        <span style="color:var(--text-muted);font-family:var(--font-mono)">${id}</span>
      </button>`;
      }).join('');

    sugDiv.querySelectorAll('.cg-suggest-btn').forEach(btn => {
      btn.onclick = () => {
        $('#cg-appid').value = btn.dataset.id;
        sugDiv.innerHTML = `<span style="font-size:11px;color:var(--primary)">✓ Selected AppID: ${btn.dataset.id}</span>`;
      };
    });
  }

  function showAddCustomGameModal() {
    const html = buildCustomGameForm() + `
      <div class="modal-actions">
        <button class="xbox-btn xbox-btn-secondary" id="cg-cancel">Cancel</button>
        <button class="xbox-btn xbox-btn-primary" id="cg-save">＋ Add Game</button>
      </div>
    `;
    openModal('Add Custom Game', html);
    wireCustomGameFormEvents();

    const done = () => { closeModal(); $('#modal-close').onclick = closeModal; };
    $('#cg-cancel').onclick = done;
    $('#modal-close').onclick = done;

    $('#cg-save').onclick = async () => {
      const gameName = $('#cg-name').value.trim();
      const gamePath = $('#cg-path').value.trim();
      if (!gameName) { toast('Game name is required', 'error'); return; }
      if (!gamePath) { toast('Game folder is required', 'error'); return; }

      let size = 0;
      try { size = await api.folderSize(gamePath); } catch {}

      await api.addCustomGame({
        game_name: gameName,
        install_path: gamePath,
        appid: $('#cg-appid').value.trim(),
        executable: $('#cg-exe').value.trim(),
        banner_path: $('#cg-banner').value.trim(),
        size_on_disk: size,
      });

      toast(`${gameName} added to library! 🎮`, 'success');
      done();
      scanAndRender();
    };
  }

  function showEditCustomGameModal(game) {
    const html = buildCustomGameForm(game) + `
      <div class="modal-actions">
        <button class="xbox-btn xbox-btn-secondary" id="cg-cancel">Cancel</button>
        <button class="xbox-btn xbox-btn-primary" id="cg-save">💾 Save Changes</button>
      </div>
    `;
    openModal('Edit Custom Game', html);
    wireCustomGameFormEvents();

    const done = () => { closeModal(); $('#modal-close').onclick = closeModal; };
    $('#cg-cancel').onclick = done;
    $('#modal-close').onclick = done;

    $('#cg-save').onclick = async () => {
      const gameName = $('#cg-name').value.trim();
      const gamePath = $('#cg-path').value.trim();
      if (!gameName) { toast('Game name is required', 'error'); return; }
      if (!gamePath) { toast('Game folder is required', 'error'); return; }

      let size = game.size_on_disk || 0;
      if (gamePath !== game.install_path) {
        try { size = await api.folderSize(gamePath); } catch {}
      }

      await api.updateCustomGame(game.id, {
        game_name: gameName,
        install_path: gamePath,
        appid: $('#cg-appid').value.trim(),
        executable: $('#cg-exe').value.trim(),
        banner_path: $('#cg-banner').value.trim(),
        size_on_disk: size,
      });

      toast(`${gameName} updated! ✓`, 'success');
      done();
      scanAndRender();
    };
  }

  // ─── Modal System ───────────────────────────────────
  // The overlay is a single persistent element, so closing it has to wait for
  // the exit animation before it may be hidden and emptied. Anything that
  // reopens during that window cancels the pending teardown — otherwise the
  // timer would blank the modal that just opened.
  let modalTeardown = null;

  function openModal(title, body) {
    if (modalTeardown) { clearTimeout(modalTeardown); modalTeardown = null; }
    const overlay = $('#modal-overlay');
    overlay.classList.remove('closing');
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = body;
    overlay.classList.remove('hidden');
    window.LibrarianDialogs.enter(overlay, () => closeModal(), 'modal-title');
  }

  // Themed replacement for window.confirm(). Resolves true on confirm, false otherwise.
  function showConfirm(title, message, options = {}) {
    const { confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = true } = options;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        state.pendingConfirm = null;
        window.LibrarianDialogs.leave($('#modal-overlay'));
        $('#modal-overlay').classList.add('hidden');
        $('#modal-body').innerHTML = '';
        $('#modal-close').onclick = () => closeModal();
        resolve(result);
      };
      state.pendingConfirm = () => finish(false);
      openModal(title, `
        <div class="confirm-modal">
          <div class="confirm-message">${esc(message)}</div>
          <div class="modal-actions">
            <button class="xbox-btn xbox-btn-secondary" id="confirm-cancel">${esc(cancelLabel)}</button>
            <button class="xbox-btn xbox-btn-primary" id="confirm-ok"${danger ? ' style="color:var(--accent-red)"' : ''}>${esc(confirmLabel)}</button>
          </div>
        </div>
      `);
      $('#confirm-cancel').onclick = () => finish(false);
      $('#confirm-ok').onclick = () => finish(true);
      $('#modal-close').onclick = () => finish(false);
    });
  }

  async function submitDownloadAuthChallenge(response) {
    const challenge = state.activeDownloadAuthChallenge;
    state.activeDownloadAuthChallenge = null;
    closeModal({ force: true });

    if (!challenge) return;

    const result = await api.respondToDownloadAuthChallenge({
      challengeId: challenge.id,
      ...response,
    });

    if (!result?.success && !response?.cancelled) {
      toast(result?.error || 'Failed to submit Steam login response.', 'error');
    }
  }

  function showDownloadAuthPrompt(challenge) {
    state.activeDownloadAuthChallenge = challenge;

    const inputId = 'download-auth-input';
    const inputType = challenge.secret ? 'password' : 'text';
    const autocomplete = challenge.secret ? 'current-password' : 'one-time-code';

    openModal(challenge.title || 'Steam Login Required', `
      <div style="display:grid;gap:12px">
        <div class="text-dim" style="line-height:1.5">${esc(challenge.message || 'Steam requires additional verification before the download can continue.')}</div>
        <div>
          <label>${esc(challenge.label || 'Response')}</label>
          <input type="${inputType}" class="form-input" id="${inputId}" placeholder="${esc(challenge.placeholder || '')}" autocomplete="${autocomplete}">
        </div>
        <div class="modal-actions">
          <button class="xbox-btn xbox-btn-secondary" id="download-auth-cancel">Cancel Download</button>
          <button class="xbox-btn xbox-btn-primary" id="download-auth-submit">Continue</button>
        </div>
      </div>
    `);

    const input = $(`#${inputId}`);
    const submit = async () => {
      const value = input ? input.value : '';
      const hasValue = challenge.secret ? value.length > 0 : value.trim().length > 0;
      if (!hasValue) {
        toast(`Enter ${challenge.label || 'the requested Steam login value'}.`, 'error');
        input?.focus();
        return;
      }

      $('#download-auth-submit').disabled = true;
      $('#download-auth-cancel').disabled = true;
      if (input) input.disabled = true;
      await submitDownloadAuthChallenge({ value });
    };

    $('#download-auth-submit').onclick = () => { void submit(); };
    $('#download-auth-cancel').onclick = () => { void submitDownloadAuthChallenge({ cancelled: true }); };
    $('#modal-close').onclick = () => { void submitDownloadAuthChallenge({ cancelled: true }); };

    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void submit();
      }
    });

    input?.focus();
    input?.select();
  }

  function closeModal(options = {}) {
    window.LibrarianDialogs.leave($('#modal-overlay'));
    // A pending themed confirm resolves to "cancel" when dismissed via overlay/Escape/X.
    if (state.pendingConfirm) {
      const cancel = state.pendingConfirm;
      state.pendingConfirm = null;
      cancel();
      return;
    }

    if (!options.force && state.activeDownloadAuthChallenge) {
      void submitDownloadAuthChallenge({ cancelled: true });
      return;
    }

    const overlay = $('#modal-overlay');
    overlay.classList.add('closing');
    if (modalTeardown) clearTimeout(modalTeardown);
    modalTeardown = setTimeout(() => {
      modalTeardown = null;
      overlay.classList.add('hidden');
      overlay.classList.remove('closing');
      $('#modal-body').innerHTML = '';
    }, 190);
    $('#modal-close').onclick = () => closeModal();
  }

  (function setupModal() {
    document.addEventListener('DOMContentLoaded', () => {
      $('#modal-close').onclick = closeModal;
      $('#modal-overlay').addEventListener('click', e => { if (e.target === $('#modal-overlay')) closeModal(); });
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          // A modal mid-exit is already gone as far as the user is concerned;
          // Escape should fall through to whatever is behind it.
          const overlay = $('#modal-overlay');
          const modalUp = !overlay.classList.contains('hidden') && !overlay.classList.contains('closing');
          if (modalUp) closeModal();
          else if ($('#game-flyout').classList.contains('flyout-open')) closeFlyout();
        }
      });
    });
  })();

  // ─── Auto Crack Page ────────────────────────────────
  function setupCrackPage() {
    let currentFolder = null;
    let scanData = null;

    const btnBrowse = $('#crack-browse');
    const pathLabel = $('#crack-path');
    const scanResults = $('#crack-scan-results');
    const btnApply = $('#crack-apply');
    const btnRestore = $('#crack-restore');
    const inpAppId = $('#crack-appid');
    const inpName = $('#crack-name');
    const outLog = $('#crack-log');
    const statusDiv = $('#crack-goldberg-status');

    function crackLog(msg) {
      const el = document.createElement('div');
      el.textContent = msg;
      outLog.appendChild(el);
      outLog.scrollTop = outLog.scrollHeight;
    }

    // The main process installs Goldberg on first launch; reflect its progress
    // here so the chips are never stale and the log shows what happened.
    api.onCrackStatus((status) => {
      if (status && status.installing) {
        statusDiv.innerHTML = '<span class="tag" style="background:rgba(210,166,92,0.14);color:var(--brass-2);border:1px solid rgba(210,166,92,0.3)">⏳ Installing Goldberg…</span>';
        return;
      }
      refreshStatus();
    });

    api.onCrackBootstrap((result) => {
      if (result?.success) toast('Goldberg emulator is ready', 'success');
      else if (result?.error) toast(`Goldberg install failed: ${result.error}`, 'error');
    });

    async function refreshStatus() {
      const res = await api.crackCheckGoldberg();
      let html = '';
      if (!res.cliExists) {
        html += `<span class="tag" style="background:rgba(239,68,68,0.12);color:#ef4444;border:1px solid rgba(239,68,68,0.25)">⚠️ SteamAutoCrack.CLI missing</span> `;
      } else {
        html += `<span class="tag" style="background:rgba(16,185,129,0.12);color:#10b981;border:1px solid rgba(16,185,129,0.25)">✓ SAC CLI Ready</span> `;
      }
      if (!res.goldbergExists) {
        html += `<span class="tag" style="background:rgba(239,68,68,0.12);color:#ef4444;border:1px solid rgba(239,68,68,0.25)">⚠️ Goldberg not found</span> `;
        html += `<button class="xbox-btn xbox-btn-secondary btn-sm" id="crack-dl-goldberg" style="margin-left:6px">⬇ Download Goldberg</button>`;
      } else {
        html += `<span class="tag" style="background:rgba(16,185,129,0.12);color:#10b981;border:1px solid rgba(16,185,129,0.25)">✓ Goldberg Ready</span>`;
      }
      statusDiv.innerHTML = html;

      const dlBtn = document.getElementById('crack-dl-goldberg');
      if (dlBtn) {
        dlBtn.onclick = async () => {
          dlBtn.disabled = true;
          dlBtn.textContent = '⏳ Downloading...';
          outLog.innerHTML = '';
          crackLog('🔄 Downloading Goldberg Emulator from GitHub...');
          const result = await api.crackDownloadGoldberg();
          if (result.success) {
            toast('Goldberg downloaded!', 'success');
            crackLog('✅ Goldberg emulator downloaded and extracted successfully!');
          } else {
            toast('Download failed — check log', 'error');
            crackLog('❌ Download failed. Check your internet connection.');
          }
          refreshStatus();
        };
      }
    }
    refreshStatus();

    // Which emulator build is installed and the newest release GitHub knows
    // of; the update is forced, so it also replaces a build that is present
    // but too old for a game's SDK (src/core/emuCompat.js).
    const emuText = $('#crack-emu-build-text');
    const emuBtn = $('#crack-emu-update');
    async function refreshEmuBuild() {
      if (!emuText || !api.emuStatus) return;
      let st;
      try { st = await api.emuStatus(null); } catch { emuText.textContent = 'Emulator build unknown.'; return; }
      const e = st && st.emulator;
      // The build is a commit sha (old SAC downloads) or a release tag (ours).
      const build = e && e.commit ? (/^[0-9a-f]{40}$/i.test(e.commit) ? e.commit.slice(0, 8) : e.commit) : 'no build id';
      const installed = e && e.date ? `${build} · ${e.interfaces64 ? e.interfaces64.length : 0} interfaces · installed ${new Date(e.date).toISOString().slice(0, 10)}` : 'not installed';
      const latestTag = st && st.latest ? (st.latest.tag || st.latest.name || '') : '';
      const newer = st && st.latest && e && e.date && st.latest.publishedAt > e.date + 60000;
      const same = latestTag && e && e.commit && (latestTag === e.commit || (st.latest.commit && st.latest.commit === e.commit));
      emuText.textContent = `Emulator ${installed}. ${newer ? `Newer release available: ${latestTag}.` : same ? 'This is the newest release.' : latestTag ? `Newest release: ${latestTag}.` : ''}`;
    }
    if (emuBtn) {
      emuBtn.onclick = async () => {
        emuBtn.disabled = true;
        emuBtn.textContent = '⏳ Updating…';
        crackLog('⬆ Fetching the newest emulator release from GitHub (forced)…');
        let r;
        try { r = await api.emuUpdate(); } catch (e) { r = { success: false, error: e.message }; }
        for (const line of (r && r.log) || []) crackLog(line);
        if (r && r.success) toast(r.changed ? 'Emulator updated' : 'Emulator already the newest build', 'success');
        else toast(`Emulator update failed: ${(r && r.error) || 'check the log'}`, 'error');
        emuBtn.disabled = false;
        emuBtn.textContent = '⬆ Update emulator';
        refreshStatus();
        refreshEmuBuild();
      };
    }
    refreshEmuBuild();
    window.addEventListener('librarian:page', (e) => { if (e.detail && e.detail.page === 'crack') refreshEmuBuild(); });

    api.onCrackLog((msg) => crackLog(msg));

    btnBrowse.onclick = async () => {
      const folder = await api.openFolder();
      if (!folder) return;
      currentFolder = folder;
      pathLabel.textContent = folder;
      scanResults.innerHTML = '<div class="loading-state"><div class="spinner"></div>Scanning directory...</div>';
      btnApply.disabled = true;
      btnRestore.disabled = true;
      outLog.innerHTML = '';
      crackLog(`📂 Selected folder: ${folder}`);

      scanData = await api.crackScan(folder);

      if (!scanData.hasSteamApi && !scanData.hasSteamApi64) {
        scanResults.innerHTML = `<div class="empty-state-small" style="color:var(--accent-red)">⚠️ No steam_api.dll found.<br><span style="font-size:11px;color:var(--text-muted)">Game might not use Steam DRM.</span></div>`;
        return;
      }

      let html = `<div style="font-size:13px;margin-bottom:8px">Found <b>${scanData.steamApiFiles.length}</b> Steam API DLL(s) and <b>${scanData.executables.length}</b> executable(s):</div>`;
      html += `<ul style="list-style:none;padding:0;font-family:var(--font-mono);font-size:11px;color:var(--text-muted)">`;
      scanData.steamApiFiles.forEach(f => {
        const relDir = f.dir.replace(folder, '').replace(/^[\\/]/, '') || '.';
        html += `<li style="margin-bottom:4px;background:var(--bg-input);padding:6px 10px;border-radius:4px">🔗 ${esc(f.name)} <span style="opacity:0.5">in ${esc(relDir)}</span></li>`;
      });
      scanData.executables.forEach(f => {
        const relDir = f.dir.replace(folder, '').replace(/^[\\/]/, '') || '.';
        html += `<li style="margin-bottom:4px;background:var(--bg-input);padding:6px 10px;border-radius:4px">🎮 ${esc(f.name)} <span style="opacity:0.5">in ${esc(relDir)}</span></li>`;
      });
      html += `</ul>`;
      scanResults.innerHTML = html;

      if (scanData.detectedAppId) {
        inpAppId.value = scanData.detectedAppId;
        crackLog(scanData.appIdSource === 'steam manifest'
          ? `💡 AppID ${scanData.detectedAppId} — from Steam's manifest for this install (authoritative).`
          : `💡 Auto-detected AppID: ${scanData.detectedAppId}`);
      }
      if (scanData.detectedName) {
        if (inpName.value === '' || inpName.value === 'CrackedGame' || inpName.value.startsWith('App_')) {
          inpName.value = scanData.detectedName;
          crackLog(`💡 Auto-detected Game Name: ${scanData.detectedName}`);
        }
      }
      btnApply.disabled = false;
      btnRestore.disabled = false;
    };

    btnApply.onclick = async () => {
      if (!currentFolder) return;
      const appId = inpAppId.value.trim();
      if (!appId) { toast('Please enter an App ID', 'error'); return; }
      const gameName = inpName.value.trim() || 'CrackedGame';
      btnApply.disabled = true;
      btnRestore.disabled = true;
      outLog.innerHTML = '';
      // A Denuvo title: the emulator is not the crack and its DLL in place of
      // the game's own breaks the release that is. Straight to the forum.
      let denuvoTitle = false;
      try { denuvoTitle = state.csrin.available && await ensureDenuvoInfo({ appid: appId }); } catch { denuvoTitle = false; }
      if (denuvoTitle) {
        crackLog(`🛡 ${gameName} is a Denuvo title — the emulator step is skipped; the CS.RIN.RU release carries its own.`);
        btnApply.disabled = false;
        btnRestore.disabled = false;
        await crackPageCsrinStep({ appid: appId, game_name: gameName, install_path: currentFolder }, crackLog);
        return;
      }
      crackLog(`🚀 Running SteamAutoCrack on ${gameName} (AppID: ${appId})...`);
      const res = await api.crackApply({ gamePath: currentFolder, appId: appId, gameName: gameName });
      if (res.success) { toast('Game cracked successfully! ✓', 'success'); crackLog('✅ All steps completed successfully!'); }
      else { toast(`Crack failed (exit code ${res.exitCode})`, 'error'); crackLog(`❌ Process failed with exit code ${res.exitCode}`); }
      btnApply.disabled = false;
      btnRestore.disabled = false;
      // The emulator is the whole crack for most games. For a Denuvo title it
      // is not: the member's release for this exact build has to go over the
      // install too, and that is the second half of "Apply Crack" here.
      await crackPageCsrinStep({ appid: appId, game_name: gameName, install_path: currentFolder }, crackLog);
    };

    async function crackPageCsrinStep(target, out) {
      if (!state.csrin.available) return;
      let denuvo = false;
      try { denuvo = await ensureDenuvoInfo(target); } catch { denuvo = false; }
      if (!denuvo) return;
      // The library knows this folder's build; the crack page does not.
      const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
      const known = state.games.find((g) => g.install_path && norm(g.install_path) === norm(target.install_path));
      const game = { ...(known || {}), ...target, buildid: known?.buildid || '', game_name: known?.game_name || target.game_name };
      out(`🌐 ${game.game_name} is a Denuvo title — the emulator alone will not run it. Fetching ${state.settings.csrin_author || 'ARTIFACT'}'s release for the installed patch from CS.RIN.RU…`);
      if (!state.settings.csrin_username || !state.settings.secrets_present?.csrin_password || !known) {
        out(!known
          ? '⚠ This folder is not in the library, so its patch cannot be looked up; the release has to be picked by hand.'
          : '⚠ No CS.RIN.RU account in Settings, so the release has to be picked by hand.');
        openCsrinPicker(game.appid, game.game_name, { game });
        return;
      }
      await autoFetchCsrinRelease(game);
    }

    btnRestore.onclick = async () => {
      if (!currentFolder) return;
      if (!(await showConfirm('Restore Originals', 'Restore original files and undo crack?', { confirmLabel: 'Restore' }))) return;
      outLog.innerHTML = '';
      crackLog(`↩️ Restoring original files via SAC...`);
      const res = await api.crackRestore(currentFolder);
      if (res.success) { crackLog(`✅ Restore completed.`); toast('Original files restored!', 'success'); }
      else { crackLog(`⚠️ Restore encountered issues.`); toast('Restore had issues — check log', 'error'); }
    };
  }

  // ─── Helpers ────────────────────────────────────────
  function osTag(os, arch) {
    const labels = { windows: 'Windows', linux: 'Linux', macos: 'macOS' };
    const icons = { windows: OS_ICONS.windows, linux: OS_ICONS.linux, macos: OS_ICONS.macos };
    const cls = { windows: 'tag-windows', linux: 'tag-linux', macos: 'tag-macos' };
    const base = labels[os] || os;
    const label = arch ? `${base} ${arch}-bit` : base;
    return `<span class="tag ${cls[os] || 'tag-all'}">${icons[os] || ''} ${esc(label)}</span>`;
  }

  /**
   * Run async work from a button and show it on that button: a spinner and
   * no second click until it settles. The element may be gone by then (the
   * flyout closes when a job is queued), which is fine.
   */
  async function withBusy(btn, work) {
    if (!btn || btn.classList.contains('busy')) return undefined;
    btn.classList.add('busy');
    btn.setAttribute('aria-busy', 'true');
    try {
      return await work();
    } finally {
      btn.classList.remove('busy');
      btn.removeAttribute('aria-busy');
    }
  }

  function log(msg, type = '') {
    const el = document.createElement('div');
    el.className = `log-line ${type}`;
    el.textContent = msg;
    const out = $('#log-output');
    if (out) { out.appendChild(el); out.scrollTop = out.scrollHeight; }
  }

  function notify(title, body) {
    try {
      if (typeof Notification !== 'function') return;
      if (Notification.permission === 'granted') {
        new Notification(title, { body });
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then((perm) => {
          if (perm === 'granted') { try { new Notification(title, { body }); } catch {} }
        }).catch(() => {});
      }
    } catch {}
  }

  // Toasts stack rather than overlap, collapse duplicates into a counter, and
  // can carry a single follow-up action ("Open", "Undo", …).
  const TOAST_GLYPHS = { success: '✓', error: '⚠', '': '·' };

  function toast(msg, type = '', options = {}) {
    const stack = $('#toast-stack');
    if (!stack) return;

    const text = String(msg ?? '');
    const existing = [...stack.children].find(el => el.dataset.msg === text && el.dataset.type === type);
    if (existing) {
      const count = Number(existing.dataset.count || 1) + 1;
      existing.dataset.count = String(count);
      const textEl = existing.querySelector('.toast-text');
      if (textEl) textEl.textContent = `${text} (×${count})`;
      clearTimeout(Number(existing.dataset.timer));
      existing.dataset.timer = String(setTimeout(() => dismissToast(existing), toastLifetime(type, options)));
      return;
    }

    const el = document.createElement('div');
    el.className = `toast ${type ? `toast-${type}` : ''}`;
    el.dataset.msg = text;
    el.dataset.type = type;
    el.dataset.count = '1';

    const glyph = document.createElement('span');
    glyph.className = 'toast-glyph';
    glyph.textContent = options.glyph || TOAST_GLYPHS[type] || TOAST_GLYPHS[''];

    const body = document.createElement('span');
    body.className = 'toast-text';
    body.textContent = text;

    el.append(glyph, body);

    if (options.action && typeof options.action.run === 'function') {
      const btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.textContent = options.action.label || 'Open';
      btn.onclick = (e) => { e.stopPropagation(); dismissToast(el); options.action.run(); };
      el.appendChild(btn);
    }

    el.onclick = () => dismissToast(el);
    stack.appendChild(el);

    // Never let a burst of messages fill the screen.
    while (stack.children.length > 5) dismissToast(stack.firstElementChild, true);

    el.dataset.timer = String(setTimeout(() => dismissToast(el), toastLifetime(type, options)));
  }

  function toastLifetime(type, options) {
    if (Number.isFinite(options?.duration)) return options.duration;
    if (options?.action) return 8000;
    return type === 'error' ? 6000 : 3400;
  }

  function dismissToast(el, immediate = false) {
    if (!el || el.classList.contains('leaving')) return;
    clearTimeout(Number(el.dataset.timer));
    if (immediate) { el.remove(); return; }
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 260);
  }

  /**
   * Broadcast a renderer-side event. The enhancement layer (js/enhance.js)
   * listens for these instead of reaching into this module's internals.
   */
  function emit(name, detail) {
    try { window.dispatchEvent(new CustomEvent(`librarian:${name}`, { detail })); } catch { /* non-fatal */ }
  }

  /**
   * Subsequence match used by the library filter and the command palette:
   * "hlfx" finds "Half-Life: Alyx". Returns null when there is no match, or a
   * score plus the matched character positions for highlighting.
   */
  function fuzzyMatch(text, query) {
    const haystack = String(text || '');
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return { score: 0, positions: [] };

    const lower = haystack.toLowerCase();
    const direct = lower.indexOf(needle);
    if (direct !== -1) {
      // Contiguous hits always beat scattered ones, and a prefix beats a middle.
      const positions = [];
      for (let i = 0; i < needle.length; i++) positions.push(direct + i);
      return { score: 1000 - direct * 2 + (direct === 0 ? 200 : 0), positions };
    }

    const positions = [];
    let cursor = 0;
    let score = 0;
    let streak = 0;
    for (const ch of needle) {
      const found = lower.indexOf(ch, cursor);
      if (found === -1) return null;
      // Reward runs, and characters that start a word.
      streak = found === cursor ? streak + 1 : 0;
      score += 12 + streak * 6;
      if (found === 0 || /[\s:_\-–—.]/.test(lower[found - 1] || '')) score += 18;
      positions.push(found);
      cursor = found + 1;
    }
    return { score: score - haystack.length * 0.15, positions };
  }

  /** Wrap matched characters in <mark> for the filter/palette highlight. */
  function highlight(text, positions) {
    const source = String(text || '');
    if (!positions || !positions.length) return esc(source);
    const marks = new Set(positions);
    let out = '';
    let open = false;
    for (let i = 0; i < source.length; i++) {
      const shouldMark = marks.has(i);
      if (shouldMark && !open) { out += '<mark>'; open = true; }
      if (!shouldMark && open) { out += '</mark>'; open = false; }
      out += esc(source[i]);
    }
    if (open) out += '</mark>';
    return out;
  }

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeAppId(value) {
    const id = String(value || '').trim();
    return /^\d{1,20}$/.test(id) ? id : '';
  }

  function steamHeaderUrl(appId) {
    const id = safeAppId(appId);
    return id ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg` : '';
  }

  function safeHttpUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  function filePathToUrl(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) return '';
    return `file:///${encodeURI(filePath.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
  }

  function normalizeHex(hex) {
    if (typeof hex !== 'string') return null;
    const raw = hex.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(raw)) return `#${raw.split('').map(ch => ch + ch).join('').toUpperCase()}`;
    if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toUpperCase()}`;
    return null;
  }

  function hexToRgb(hex) {
    const safeHex = normalizeHex(hex);
    if (!safeHex) return null;
    const value = safeHex.slice(1);
    return { r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16) };
  }

  function hexToRgba(hex, alpha) {
    const rgb = hexToRgb(hex);
    if (!rgb) return `rgba(16, 185, 129, ${alpha})`;
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  }

  function blendHex(hex, targetHex, amount) {
    const base = hexToRgb(hex);
    const target = hexToRgb(targetHex);
    if (!base || !target) return hex;
    const mix = (start, end) => Math.round(start + (end - start) * amount);
    return `#${[mix(base.r, target.r), mix(base.g, target.g), mix(base.b, target.b)]
      .map(channel => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  }

  function applyThemeColors(accent, background) {
    const root = document.documentElement;
    const safeAccent = normalizeHex(accent) || THEME_DEFAULTS.accent;
    const safeBackground = normalizeHex(background) || THEME_DEFAULTS.background;
    root.style.setProperty('--primary', safeAccent);
    root.style.setProperty('--primary-light', blendHex(safeAccent, '#FFFFFF', 0.28));
    root.style.setProperty('--primary-dark', blendHex(safeAccent, '#000000', 0.22));
    root.style.setProperty('--primary-glow', hexToRgba(safeAccent, 0.18));
    root.style.setProperty('--primary-glow-strong', hexToRgba(safeAccent, 0.32));
    root.style.setProperty('--border-hover', hexToRgba(safeAccent, 0.48));
    root.style.setProperty('--bg-deep', safeBackground);
    root.style.setProperty('--bg-input', blendHex(safeBackground, '#000000', 0.4));
    root.style.setProperty('--shadow-glow', `0 0 20px ${hexToRgba(safeAccent, 0.3)}`);
    document.body.style.background = safeBackground;
  }

  function formatSize(b) {
    b = Number(b);
    if (!Number.isFinite(b) || b <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
    return `${(b / Math.pow(1024, i)).toFixed(2)} ${u[i]}`;
  }

  function formatETA(seconds) {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  async function openPath(p) {
    if (!p) return;
    const result = await api.openPath(p);
    if (result) toast(result, 'error');
  }

  // ─── Playtime / time formatting ─────────────────────
  function formatPlaytime(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    if (s < 60) return '<1m';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    const hours = s / 3600;
    if (hours < 10) return `${hours.toFixed(1)}h`;
    return `${Math.round(hours)}h`;
  }

  function formatRelative(ts) {
    const t = Number(ts) || 0;
    if (!t) return 'never';
    const diff = Date.now() - t;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.round(diff / 86400000)}d ago`;
    try { return new Date(t).toLocaleDateString(); } catch { return 'a while ago'; }
  }

  function applyReduceMotion(on) {
    document.documentElement.classList.toggle('reduce-motion', Boolean(on));
  }

  // ─── Game sessions / Now Playing ────────────────────
  function setupGameSessions() {
    api.onGameSession((payload) => handleGameSession(payload));

    // An unlock arriving while its game's page is open should land on it.
    api.onAchievementUnlocked?.((item) => {
      toast(`🏆 ${item.title}`, 'success');
      if (state.flyoutGame && safeAppId(state.flyoutGame.appid) === String(item.appid)) {
        renderFlyoutAchievements(state.flyoutGame);
      }
    });

    // A game that just exited wrote a missing-interface report: its emulator
    // is too old for this build. Say so where it will be seen, with the fix.
    api.onEmuIncompatible?.((info) => {
      if (!info) return;
      const game = state.games.find((g) => gameKeyOf(g) === info.key) || null;
      toast(`${info.name || 'A game'}: the emulator lacks ${(info.missing || []).join(', ') || 'an interface'} this build needs`, 'error', {
        duration: 12000,
        action: game ? { label: 'Fix', run: () => openFlyout(game) } : null,
      });
      if (game && state.flyoutGame && gameKeyOf(state.flyoutGame) === info.key) renderEmuCompat(state.flyoutGame);
    });
    (async () => {
      try {
        const list = await api.getRunningGames();
        if (Array.isArray(list)) {
          for (const r of list) state.running[r.key] = { name: r.name, startedAt: r.startedAt };
        }
      } catch {}
      updateNowPlaying();
    })();
    const stopBtn = $('#np-stop');
    if (stopBtn) stopBtn.onclick = () => {
      const keys = Object.keys(state.running);
      if (keys.length) stopGame({ game_key: keys[keys.length - 1] });
    };
  }

  function handleGameSession(payload) {
    if (payload?.error) { toast(payload.error, 'error', { duration: 8000 }); log(payload.error, 'error'); }
    if (payload?.type === 'warning') return;
    if (!payload || !payload.key) return;
    if (payload.type === 'started') {
      state.running[payload.key] = { name: payload.name, startedAt: payload.startedAt || Date.now() };
      const g = state.games.find(x => gameKeyOf(x) === payload.key);
      if (g) g.launch_count = (g.launch_count || 0) + 1;
    } else if (payload.type === 'stopped') {
      delete state.running[payload.key];
      // Reflect the freshly-recorded playtime without a full rescan.
      const g = state.games.find(x => gameKeyOf(x) === payload.key);
      if (g) {
        if (typeof payload.playtime_seconds === 'number') g.playtime_seconds = payload.playtime_seconds;
        g.last_played = Date.now();
      }
      if (payload.sessionSeconds > 0) {
        toast(`${payload.name || 'Game'} · ${formatPlaytime(payload.sessionSeconds)} this session`, 'success');
      }
    }
    updateNowPlaying();
    emit('session', payload);
    renderHome();
    renderLibraryGrid();
    if (state.flyoutGame && gameKeyOf(state.flyoutGame) === payload.key) {
      renderFlyoutPlaytime(state.flyoutGame);
      renderFlyoutActions(state.flyoutGame);
      window.LibrarianDlssg?.show(state.flyoutGame);
    }
  }

  function updateNowPlaying() {
    const el = $('#now-playing');
    if (!el) return;
    const keys = Object.keys(state.running);
    if (!keys.length) {
      el.classList.add('hidden');
      if (state.nowPlayingTimer) { clearInterval(state.nowPlayingTimer); state.nowPlayingTimer = null; }
      return;
    }
    const key = keys[keys.length - 1];
    const info = state.running[key];
    el.classList.remove('hidden');
    const nameEl = $('#np-name');
    if (nameEl) nameEl.textContent = info.name || 'Game';
    tickNowPlaying();
    if (!state.nowPlayingTimer) state.nowPlayingTimer = setInterval(tickNowPlaying, 1000);
  }

  function tickNowPlaying() {
    const keys = Object.keys(state.running);
    if (!keys.length) return;
    const info = state.running[keys[keys.length - 1]];
    const elapsed = Math.max(0, Math.floor((Date.now() - (info.startedAt || Date.now())) / 1000));
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    const timer = $('#np-timer');
    if (timer) timer.textContent = h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  // ─── Right-click context menu ───────────────────────
  function setupContextMenu() {
    document.addEventListener('click', hideContextMenu);
    document.addEventListener('scroll', hideContextMenu, true);
    window.addEventListener('resize', hideContextMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });
  }

  function hideContextMenu() {
    const menu = $('#context-menu');
    if (menu && !menu.classList.contains('hidden')) menu.classList.add('hidden');
  }

  function showContextMenu(x, y, game) {
    const menu = $('#context-menu');
    if (!menu) return;
    const running = isGameRunning(game);
    const fav = isFavorite(game);
    const hasAppId = game.appid && game.appid !== '0';
    const items = [];
    items.push(running
      ? { label: 'Stop', icon: '⏹', action: () => stopGame(game) }
      : { label: 'Play', icon: '▶', action: () => launchGame(game) });
    items.push({ label: 'View details', icon: '❐', key: 'Enter', action: () => openFlyout(game) });
    items.push({ label: fav ? 'Remove favorite' : 'Add to favorites', icon: fav ? '★' : '☆', key: 'F', action: () => toggleFavorite(game) });
    items.push({ label: 'Add to collection…', icon: '❏', action: () => showCollectionPicker(game) });
    items.push({ sep: true });
    items.push({ label: 'Choose executable…', icon: '⚙', action: () => promptExecutablePicker(game) });
    if (game.install_path) items.push({ label: 'Open install folder', icon: '📂', action: () => openPath(game.install_path) });
    if (hasAppId) items.push({ label: 'Steam store page', icon: '↗', action: () => api.openExternal(`https://store.steampowered.com/app/${game.appid}`) });
    items.push({ sep: true });
    if (game.source === 'Custom') {
      items.push({ label: 'Remove from library', icon: '✕', danger: true, action: () => removeCustomFromMenu(game) });
    } else {
      items.push({ label: 'Uninstall', icon: '✕', danger: true, action: () => uninstallFromMenu(game) });
    }

    menu.innerHTML = '';

    // Header: which game these actions apply to. With grids this dense, the
    // menu otherwise floats free of any context.
    const head = document.createElement('div');
    head.className = 'ctx-head';
    const banner = getGameBannerUrl(game, 'header');
    head.innerHTML = `${banner ? `<img src="${esc(banner)}" data-hide-on-error="" alt="">` : ''}<span>${esc(game.game_name)}</span>`;
    menu.appendChild(head);

    for (const item of items) {
      if (item.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); continue; }
      const btn = document.createElement('button');
      btn.className = `ctx-item${item.danger ? ' danger' : ''}`;
      btn.innerHTML = `<span style="width:16px;text-align:center">${item.icon || ''}</span><span>${esc(item.label)}</span>${item.key ? `<span class="ctx-key">${esc(item.key)}</span>` : ''}`;
      btn.onclick = (e) => { e.stopPropagation(); hideContextMenu(); item.action(); };
      menu.appendChild(btn);
    }
    menu.classList.remove('hidden');
    // Position within the viewport.
    const rect = menu.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth - rect.width - 8);
    const py = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, px)}px`;
    menu.style.top = `${Math.max(8, py)}px`;
  }

  async function uninstallFromMenu(game) {
    const msg = await api.getUninstallMessage(game);
    if (await showConfirm('Uninstall Game', msg, { confirmLabel: 'Uninstall' })) {
      const r = await api.uninstallGame(game);
      if (r.success) { toast(`${game.game_name} uninstalled`); scanAndRender(); }
      else toast(`Failed: ${r.error}`, 'error');
    }
  }

  async function removeCustomFromMenu(game) {
    const msg = await api.getUninstallMessage(game);
    if (await showConfirm('Remove from Library', msg, { confirmLabel: 'Remove' })) {
      await api.removeCustomGame(game.id);
      toast(`${game.game_name} removed from library`);
      scanAndRender();
    }
  }

  // ─── Executable picker ──────────────────────────────
  async function promptExecutablePicker(game) {
    openModal('Choose Executable', '<div class="loading-state"><div class="spinner"></div>Scanning the install folder…</div>');
    let list = [];
    try { list = await api.detectExecutables(game); } catch {}
    const hasAppId = game.appid && game.appid !== '0';

    let html = `<div class="text-dim" style="font-size:13px;margin-bottom:12px">Pick the file Librarian should run when you press Play for <b style="color:var(--paper)">${esc(game.game_name)}</b>. Your choice is remembered.</div>`;

    if (Array.isArray(list) && list.length) {
      html += '<ul class="library-list" id="exe-list">';
      for (const exe of list.slice(0, 25)) {
        const rel = game.install_path ? exe.path.replace(game.install_path, '').replace(/^[\\/]/, '') : exe.name;
        const sizeTxt = exe.size ? formatSize(exe.size) : '';
        const likely = exe.score >= 60 ? '<span class="tag tag-macos" style="margin-left:8px">Likely</span>' : '';
        html += `<li class="library-item" data-path="${esc(exe.path)}">
          <div class="library-radio"></div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;color:var(--paper)">${esc(exe.name)}${likely}</div>
            <div class="library-path" style="color:var(--text-muted);font-size:11px">${esc(rel)} · ${sizeTxt}</div>
          </div>
        </li>`;
      }
      html += '</ul>';
    } else {
      html += '<div class="empty-state-small">No executables were found in this game\'s folder.</div>';
    }

    html += `<div class="modal-actions" style="flex-wrap:wrap">
      <button class="xbox-btn xbox-btn-secondary" id="exe-browse">Browse…</button>
      ${game.install_path ? '<button class="xbox-btn xbox-btn-secondary" id="exe-folder">Open Folder</button>' : ''}
      ${hasAppId ? '<button class="xbox-btn xbox-btn-secondary" id="exe-steam">Launch via Steam</button>' : ''}
      <button class="xbox-btn xbox-btn-primary" id="exe-save">Save &amp; Play</button>
    </div>`;

    openModal('Choose Executable', html);

    let selected = (list && list[0]) ? list[0].path : '';
    $$('#exe-list .library-item').forEach((el, i) => {
      if (i === 0) el.classList.add('selected');
      el.onclick = () => {
        $$('#exe-list .library-item').forEach(x => x.classList.remove('selected'));
        el.classList.add('selected');
        selected = el.dataset.path;
      };
    });

    const saveAndPlay = async (exePath) => {
      if (!exePath) { toast('Pick an executable first', 'error'); return; }
      try {
        await api.setGameExecutable(game, exePath);
        game.executable = exePath;
        const g = state.games.find(x => gameKeyOf(x) === gameKeyOf(game));
        if (g) g.executable = exePath;
      } catch {}
      closeModal();
      launchGame(game);
    };

    $('#exe-save').onclick = () => saveAndPlay(selected);
    const browseBtn = $('#exe-browse');
    if (browseBtn) browseBtn.onclick = async () => {
      const fp = await api.openFile({ filters: [{ name: 'Executables', extensions: ['exe'] }] });
      if (fp) saveAndPlay(fp);
    };
    const folderBtn = $('#exe-folder');
    if (folderBtn) folderBtn.onclick = () => openPath(game.install_path);
    const steamBtn = $('#exe-steam');
    if (steamBtn) steamBtn.onclick = () => { closeModal(); api.openExternal(`steam://rungameid/${game.appid}`); toast(`Launching ${game.game_name} through Steam…`); };
    $('#modal-close').onclick = () => closeModal();
  }

  // ─── Lightbox ───────────────────────────────────────
  function setupLightbox() {
    const lb = $('#lightbox');
    if (lb) lb.onclick = closeLightbox;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lb && !lb.classList.contains('hidden')) closeLightbox();
    });
  }

  function openLightbox(url) {
    const lb = $('#lightbox');
    const img = $('#lightbox-img');
    if (!lb || !img || !url) return;
    img.src = url;
    lb.classList.remove('hidden');
  }

  function closeLightbox() {
    const lb = $('#lightbox');
    if (lb) lb.classList.add('hidden');
  }

  // ─── Bridge ─────────────────────────────────────────
  // A deliberately small, read-mostly surface for js/enhance.js. Everything
  // else in this module stays private; new UI talks to the app through here
  // and through the `librarian:*` events above.
  window.Librarian = {
    get state() { return state; },
    get games() { return state.games; },
    get settings() { return state.settings; },

    // Navigation
    navigateTo,
    setLibraryView,
    openFlyout,
    closeFlyout,
    stepFlyout,

    // Collections
    getCollections,
    createCollection,
    deleteCollection,
    showCollectionPicker,
    toggleCollectionMember,

    // Actions
    launchGame,
    stopGame,
    toggleFavorite,
    isFavorite,
    isGameRunning,
    scanAndRender,
    checkUpdates: checkUpdatesInBackground,
    checkUpdateFor,
    updateResultKey,
    canUpdateGame,
    showCustomUpdateAssociation,
    renderFlyoutAchievements,
    updateAllGames,
    queueGameUpdate,
    queueGameRepair,
    addCustomGame: showAddCustomGameModal,
    showInstallSheet,
    fetchAndQueue,
    searchStoreCatalog,
    openPath,
    showContextMenu,
    searchStore: (query) => { navigateTo('store'); state.storeSearch?.(query); },
    // The second source: opens the CS.RIN.RU picker for a store page, or
    // queues one hoster link straight into the download queue.
    csrinSearch: openCsrinPicker,
    csrinQueue: queueCsrinDownload,
    // What the forum has for a game (cached for the session); the store
    // page says so before Install is pressed.
    csrinReleaseInfo,
    isDenuvo: ensureDenuvoInfo,
    // What's new: refresh the feeds, open the dialog.
    refreshNews,
    openNews: openNewsModal,

    // Rendering
    renderHome,
    renderLibraryGrid,
    renderHero,
    setHeroBackground,
    setHeroGame(game) { state.heroGame = game; renderHero(game); },

    // Helpers reused by the enhancement layer
    gameKeyOf,
    favKey,
    getGameBannerUrl,
    steamPortraitUrl,
    steamHeaderUrl,
    resolveArtFor,
    artFallbackHtml,
    artStyleFor,
    artInitials,
    fuzzyMatch,
    highlight,
    formatSize,
    formatPlaytime,
    formatRelative,
    esc,
    toast,
    log,
    showConfirm,
    openModal,
    closeModal,
    applyThemeColors,
    async refreshSettings() {
      state.settings = await api.getAllSettings();
      return state.settings;
    },
  };

  // ─── Start ──────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();
