// ═══════════════════════════════════════════════════════════════════
// Librarian — the store
//
// Before this file, "the store" was a search box and a grid of covers, and
// clicking one started a download of a game you had seen the name of and
// nothing else. This turns that into an actual store page: art, trailer,
// screenshots, what it is, who made it, when it came out, how big it is, and
// what will land on disk — and only then the button that queues it.
//
// Two consumers, one source of truth:
//
//   · the desktop page, rendered here into #store-detail
//   · Big Picture, which owns its own DOM and calls the data half through
//     window.LibrarianStore
//
// Nothing here downloads anything itself. Install goes through the bridge's
// fetchAndQueue, which is the same path the old result card used, so the
// manifest fetch, the depot plan sheet and the queue are untouched.
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const bridge = () => window.Librarian || null;
  const api = () => window.api || null;

  function safely(label, fn) {
    try { return fn(); } catch (e) { console.error(`[store] ${label} failed:`, e); return null; }
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  // ════════════════════════════════════════════════════════════════
  // Data
  //
  // Both fetches are cached by appid for the life of the session. Walking
  // back and forth between the results and a page is the normal way to use a
  // store, and appdetails is slow enough that doing it twice is felt.
  // ════════════════════════════════════════════════════════════════
  const metaCache = new Map();
  const depotCache = new Map();

  function fetchMeta(appid) {
    const id = String(appid || '');
    if (!id) return Promise.resolve(null);
    if (!metaCache.has(id)) {
      metaCache.set(id, Promise.resolve(api()?.getGameMedia?.(id))
        .catch(() => null)
        // A rejected promise would be cached as a permanent failure; a null
        // result lets the next visit try again.
        .then((meta) => { if (!meta) metaCache.delete(id); return meta || null; }));
    }
    return metaCache.get(id);
  }

  function fetchDepots(appid) {
    const id = String(appid || '');
    if (!id) return Promise.resolve(null);
    if (!depotCache.has(id)) {
      depotCache.set(id, Promise.resolve(api()?.getDepotInfo?.(id))
        .catch(() => null)
        .then((info) => { if (!info) depotCache.delete(id); return info || null; }));
    }
    return depotCache.get(id);
  }

  /**
   * A download-size estimate from the depot table.
   *
   * `maxsize` is the uncompressed depot size Steam publishes, and only some
   * depots carry one, so this is explicitly an estimate and is labelled as
   * one. Linux and macOS depots are excluded: this downloads the Windows
   * build, and counting the others has told people a 12 GB game was 30.
   */
  function sizeOf(info) {
    if (!info || !info.depotConfigs) return { bytes: 0, partial: true, depots: [] };
    const depots = [];
    let bytes = 0;
    let missing = 0;

    for (const [id, cfg] of Object.entries(info.depotConfigs)) {
      const os = String(cfg.oslist || '').toLowerCase();
      if (os.includes('macos') || os.includes('linux')) continue;
      const size = Number(cfg.maxsize) || 0;
      if (size) bytes += size; else missing++;
      depots.push({ id, name: cfg.name || `Depot ${id}`, bytes: size, os: cfg.oslist || 'windows' });
    }
    depots.sort((a, z) => z.bytes - a.bytes);
    return { bytes, partial: missing > 0 || !bytes, depots };
  }

  /** Is this AppID already on the shelves? */
  function isOwned(appid) {
    const games = bridge()?.state?.games || [];
    return games.some((g) => String(g.appid) === String(appid));
  }

  // ════════════════════════════════════════════════════════════════
  // Desktop page
  // ════════════════════════════════════════════════════════════════
  const D = {
    appid: '',
    name: '',
    token: 0,        // guards against a slow fetch landing on a later game
    shots: [],
    shotIndex: 0,
    slideTimer: 0,
    trailer: null,
    onKey: null,
  };

  const page = () => $('#page-store');
  const panel = () => $('#store-detail');

  function fmtSize(bytes) {
    return bridge()?.formatSize?.(bytes) || `${Math.round((bytes || 0) / 1e9)} GB`;
  }

  function setText(sel, value) {
    const el = $(sel);
    if (el) el.textContent = value || '';
  }

  /** Show a block only when it has something in it. */
  function block(sel, has) {
    const el = $(sel);
    if (el) el.classList.toggle('hidden', !has);
  }

  function stopMedia() {
    clearInterval(D.slideTimer);
    D.slideTimer = 0;
    if (D.trailer) safely('trailer-detach', () => window.LibrarianTrailer?.detach(D.trailer));
  }

  /**
   * Open the page for one game.
   *
   * `name` comes from the search result and is shown immediately, so the page
   * has a title from the first frame rather than after a network round trip.
   * Everything else fills in as it arrives.
   */
  async function open(appid, name) {
    const box = panel();
    const host = page();
    if (!box || !host) return;

    const token = ++D.token;
    D.appid = String(appid || '');
    D.name = name || '';
    stopMedia();

    // ── Immediate shell ──
    setText('#sd-title', D.name || 'Unknown game');
    setText('#sd-bar-name', D.name || '');
    setText('#sd-tagline', '');
    setText('#sd-facts', '');
    setText('#sd-size', 'Checking size…');
    setText('#sd-kicker', 'Store');
    $('#sd-logo')?.classList.add('hidden');
    $('#sd-sound')?.classList.add('hidden');
    $('#sd-strip')?.replaceChildren();
    ['#sd-about', '#sd-tags', '#sd-depots'].forEach((s) => block(s, false));
    // Denuvo is known only once the metadata is in; until then, no button
    // and no release line.
    $('#sd-csrin')?.classList.add('hidden');
    $('#sd-csrin-line')?.classList.add('hidden');
    paintInstall();

    // The header capsule stands in until the real media arrives, so the
    // cinema is never an empty black rectangle.
    const still = $('#sd-still');
    if (still && D.appid) still.src = `https://cdn.cloudflare.steamstatic.com/steam/apps/${D.appid}/header.jpg`;
    const bg = $('#sd-bg');
    if (bg) bg.style.backgroundImage = D.appid
      ? `url("https://cdn.cloudflare.steamstatic.com/steam/apps/${D.appid}/library_hero.jpg")`
      : '';

    box.classList.remove('hidden');
    host.setAttribute('data-mode', 'detail');
    $('#sd-scroll').scrollTop = 0;
    bindKeys();

    // ── Metadata ──
    const meta = await fetchMeta(D.appid);
    if (token !== D.token) return;
    if (meta) paintMeta(meta);

    // ── Size, which is a second, slower call ──
    const info = await fetchDepots(D.appid);
    if (token !== D.token) return;
    paintSize(info);
  }

  function paintMeta(meta) {
    if (meta.name) { D.name = meta.name; setText('#sd-title', meta.name); setText('#sd-bar-name', meta.name); }
    setText('#sd-tagline', meta.short_description || '');
    setText('#sd-kicker', meta.is_free ? 'Free to play' : meta.denuvo ? 'Store · Denuvo' : 'Store');
    // The second source is for Denuvo titles only; every other game keeps
    // the store page it always had.
    const csrinBtn = $('#sd-csrin');
    if (csrinBtn) {
      csrinBtn.classList.toggle('hidden', !meta.denuvo);
      csrinBtn.title = meta.drm_notice ? `${meta.drm_notice} — look this release up on CS.RIN.RU` : 'Look this game up on CS.RIN.RU';
    }
    if (meta.denuvo) paintCsrinLine(meta.name || D.name);
  }

  /**
   * For a Denuvo title, what the forum has — said in the commit bar before
   * Install is pressed, because without a release the download would only
   * produce a game that does not run. Answered from the app's session
   * cache, so a page revisited costs nothing.
   */
  async function paintCsrinLine(name) {
    const line = $('#sd-csrin-line');
    const b = bridge();
    if (!line || !b?.csrinReleaseInfo) return;
    const token = D.token;
    line.className = 'sd-csrin-wait';
    line.textContent = 'CS.RIN.RU · checking for a release…';
    const info = await b.csrinReleaseInfo(name);
    if (token !== D.token) return;
    if (!info) { line.classList.add('hidden'); return; }
    const author = info.author || 'ARTIFACT';
    if (!info.ok) {
      line.className = 'sd-csrin-none';
      line.textContent = `CS.RIN.RU · could not be checked (${info.error || 'search failed'})`;
      return;
    }
    const post = info.newest;
    if (!post) {
      line.className = 'sd-csrin-none';
      line.textContent = `CS.RIN.RU · no release by ${author} yet`;
      return;
    }
    const bits = [post.version ? `patch ${post.version}` : '', post.build ? `build ${post.build}` : '', post.date || ''].filter(Boolean);
    line.className = 'sd-csrin-ok';
    line.textContent = `CS.RIN.RU · ${author} release${bits.length ? ` · ${bits.join(' · ')}` : ''}${info.authenticated ? '' : ' · log in to fetch it'}`;

    // The publisher's own wordmark, when there is one.
    const logo = $('#sd-logo');
    if (logo && meta.logo_url) {
      logo.onload = () => logo.classList.remove('hidden');
      logo.onerror = () => logo.classList.add('hidden');
      logo.alt = meta.name || D.name;
      logo.src = meta.logo_url;
    }

    // ── Facts line ──
    const facts = [];
    if (meta.release_date) facts.push({ label: 'Released', value: meta.release_date });
    if (meta.developers?.length) facts.push({ label: 'Developer', value: meta.developers.join(', ') });
    if (meta.publishers?.length) facts.push({ label: 'Publisher', value: meta.publishers.join(', ') });
    if (meta.metacritic?.score) facts.push({ label: 'Metacritic', value: String(meta.metacritic.score), score: meta.metacritic.score });
    const factsEl = $('#sd-facts');
    if (factsEl) {
      factsEl.innerHTML = facts.map((f, i) => `
        <div class="sd-fact" style="--k-i:${i}">
          <span class="sd-fact-label">${esc(f.label)}</span>
          <span class="sd-fact-value${f.score ? ` sd-score ${scoreClass(f.score)}` : ''}">${esc(f.value)}</span>
        </div>`).join('');
    }

    // ── About ──
    const about = meta.about || meta.short_description || '';
    setText('#sd-about-text', about);
    block('#sd-about', Boolean(about));

    // ── Tags: genres first, then the feature categories ──
    const tags = [...(meta.genres || []), ...(meta.categories || [])];
    const tagList = $('#sd-tag-list');
    if (tagList) {
      tagList.innerHTML = tags.slice(0, 16)
        .map((t, i) => `<span class="sd-tag" style="--k-i:${i}">${esc(t)}</span>`).join('');
    }
    block('#sd-tags', tags.length > 0);

    paintMedia(meta);
    paintInstall();
  }

  const scoreClass = (n) => (n >= 80 ? 'is-high' : n >= 60 ? 'is-mid' : 'is-low');

  /**
   * The stage plays the trailer when there is one and runs the screenshots as
   * a slideshow when there is not, so a game with no video is not a still
   * frame with a play button that does nothing.
   */
  function paintMedia(meta) {
    const shots = (meta.screenshots || []).map((s) => s.full || s.thumb || s).filter(Boolean);
    const movie = (meta.movies || [])[0] || null;
    D.shots = shots;
    D.shotIndex = 0;

    const video = $('#sd-trailer');
    const still = $('#sd-still');
    const strip = $('#sd-strip');
    const sound = $('#sd-sound');
    if (!video || !still || !strip) return;

    D.trailer = video;
    let playing = false;
    if (movie) playing = Boolean(safely('trailer', () => window.LibrarianTrailer?.attach(video, movie)));
    video.classList.toggle('is-on', playing);
    // Muted, always. A store page that starts talking the moment it opens is
    // the single most complained-about thing storefronts do.
    if (playing) { video.muted = true; video.play?.().catch(() => {}); }
    if (sound) { sound.classList.toggle('hidden', !playing); sound.textContent = '🔇'; }

    if (shots.length) {
      if (!playing) still.src = shots[0];
      still.classList.remove('hidden');
      // Only cycle when the trailer is not carrying the stage already.
      if (!playing && shots.length > 1) {
        D.slideTimer = setInterval(() => {
          D.shotIndex = (D.shotIndex + 1) % shots.length;
          still.src = shots[D.shotIndex];
          markStrip();
        }, 5200);
      }
    } else {
      still.classList.add('hidden');
    }

    strip.innerHTML = shots.slice(0, 12)
      .map((src, i) => `<button class="sd-shot" type="button" data-i="${i}" style="--k-i:${i}"><img src="${esc(src)}" alt="" loading="lazy"></button>`)
      .join('');
    strip.querySelectorAll('.sd-shot').forEach((btn) => {
      btn.onclick = () => {
        const i = Number(btn.dataset.i) || 0;
        D.shotIndex = i;
        clearInterval(D.slideTimer);
        D.slideTimer = 0;
        still.src = shots[i];
        still.classList.remove('hidden');
        video.classList.remove('is-on');
        safely('trailer-stop', () => window.LibrarianTrailer?.detach(video));
        markStrip();
      };
    });
    markStrip();
  }

  function markStrip() {
    document.querySelectorAll('#sd-strip .sd-shot').forEach((b, i) => {
      b.classList.toggle('is-on', i === D.shotIndex);
    });
  }

  function paintSize(info) {
    const { bytes, partial, depots } = sizeOf(info);
    setText('#sd-size', bytes
      ? `${partial ? '≈ ' : ''}${fmtSize(bytes)} to download`
      : 'Download size unknown until the manifest is fetched');

    const list = $('#sd-depot-list');
    if (list) {
      list.innerHTML = depots.slice(0, 8).map((d, i) => `
        <div class="sd-depot" style="--k-i:${i}">
          <span class="sd-depot-name">${esc(d.name)}</span>
          <span class="sd-depot-size">${d.bytes ? esc(fmtSize(d.bytes)) : '—'}</span>
        </div>`).join('');
    }
    block('#sd-depots', depots.length > 0);
  }

  /** The one button that does something irreversible-ish, kept honest. */
  function paintInstall() {
    const btn = $('#sd-install');
    if (!btn) return;
    const owned = isOwned(D.appid);
    btn.textContent = owned ? 'Download again' : 'Install';
    btn.classList.toggle('is-owned', owned);
  }

  function close() {
    const box = panel();
    const host = page();
    D.token++;
    stopMedia();
    unbindKeys();
    if (box) box.classList.add('hidden');
    // Back to whichever face the Store page had before — results if a search
    // has run, the hero if it has not.
    if (host) host.setAttribute('data-mode', $('#search-results')?.children.length ? 'results' : 'hero');
  }

  function bindKeys() {
    unbindKeys();
    D.onKey = (e) => {
      if (e.key !== 'Escape') return;
      // Anything modal is in front of this and owns Escape first.
      if (document.querySelector('#modal-overlay:not(.hidden), #palette:not(.hidden), #plan:not(.hidden), #lightbox:not(.hidden)')) return;
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', D.onKey, true);
  }

  function unbindKeys() {
    if (D.onKey) window.removeEventListener('keydown', D.onKey, true);
    D.onKey = null;
  }

  function install() {
    const b = bridge();
    if (!b || !D.appid) return;
    const name = D.name || 'this game';
    close();
    b.fetchAndQueue(D.appid, name);
  }


  // ════════════════════════════════════════════════════════════════
  // The front page
  //
  // A store you can only search is a search engine. This is the part that
  // gives you something before you have asked: the live top by players in
  // game, the best reviewed, what is selling, what is on sale.
  //
  // One fetch, cached in the main process for half an hour, so walking in and
  // out of the Store costs nothing after the first visit.
  // ════════════════════════════════════════════════════════════════
  const F = {
    loaded: false,
    loading: false,
    spot: [],
    spotIndex: 0,
    spotTimer: 0,
  };

  const fmtPlayers = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n));

  /** The chip in the corner of a card, which is different per rail. */
  function cardBadge(item, kind) {
    if (kind === 'players' && item.players) {
      return `<span class="sf-chip is-live"><i></i>${esc(fmtPlayers(item.players))} playing</span>`;
    }
    if (kind === 'score' && Number.isFinite(item.score)) {
      return `<span class="sf-chip is-score ${scoreClass(item.score)}">${item.score}</span>`;
    }
    if (item.discount) {
      return `<span class="sf-chip is-cut">-${item.discount}%</span>`;
    }
    if (item.price) return `<span class="sf-chip">${esc(item.price)}</span>`;
    return '';
  }

  function cardHtml(item, kind, i) {
    const owned = isOwned(item.id);
    const rank = kind === 'players' && item.rank ? `<span class="sf-rank">${item.rank}</span>` : '';
    // A capsule that never arrives — an unreleased app, a delisted one, a
    // playtest — used to leave the browser's broken-image glyph on a grey
    // slab. wireCards swaps in the library's own plate for those.
    return `
      <button class="sf-card${owned ? ' is-owned' : ''}" type="button" data-id="${esc(item.id)}"
              data-name="${esc(item.name)}" style="--k-i:${i}" title="${esc(item.name)}">
        <span class="sf-card-art">
          <img src="${esc(item.header)}" alt="" loading="lazy">
          ${rank}
          ${owned ? '<span class="sf-owned">In library</span>' : ''}
          ${cardBadge(item, kind)}
        </span>
        <span class="sf-card-foot">
          <span class="sf-card-name">${esc(item.name)}</span>
        </span>
      </button>`;
  }

  /**
   * The lead result: the top hit of a search, set the way the spotlight is
   * set — wide, art full-bleed, name large, the commit right there. One
   * search is one title, most of the time; this is that title.
   */
  function leadHtml(item, query) {
    const owned = isOwned(item.id);
    return `
      <button class="sf-lead${owned ? ' is-owned' : ''}" type="button" data-id="${esc(item.id)}"
              data-name="${esc(item.name)}" title="${esc(item.name)}">
        <img class="sf-lead-art" src="${esc(item.header)}" alt="">
        <span class="sf-lead-scrim" aria-hidden="true"></span>
        <span class="sf-lead-body">
          <span class="sf-lead-kicker">${owned ? 'In your library' : 'Top result'}${query ? ` · for “${esc(query)}”` : ''}</span>
          <span class="sf-lead-name">${esc(item.name)}</span>
          <span class="sf-lead-sub">AppID ${esc(item.id)}</span>
          <span class="sf-lead-actions">
            <span class="xbox-btn xbox-btn-primary btn-sm">${owned ? 'Download again' : 'Install'}</span>
            <span class="xbox-btn xbox-btn-secondary btn-sm">Store page</span>
          </span>
        </span>
      </button>`;
  }

  /** When the art never comes, the library's plate stands in for it. */
  function plateFor(img, name) {
    const b = bridge();
    const host = img.parentElement;
    if (!host) return;
    img.remove();
    host.classList.add('is-plate');
    if (b?.artFallbackHtml) host.insertAdjacentHTML('afterbegin', b.artFallbackHtml(name, 'sf-plate'));
    else host.insertAdjacentHTML('afterbegin', `<span class="sf-plate">${esc(name)}</span>`);
  }

  function railHtml(rail) {
    return `
      <section class="sf-rail" data-rail="${esc(rail.id)}">
        <header class="sf-rail-head">
          <h2 class="sf-rail-title">${esc(rail.title)}</h2>
          <span class="sf-rail-sub">${esc(rail.sub || '')}</span>
        </header>
        <div class="sf-rail-scroll">${rail.items.map((it, i) => cardHtml(it, rail.kind, i)).join('')}</div>
      </section>`;
  }

  function wireCards(root) {
    root.querySelectorAll('.sf-card').forEach((card) => {
      card.onclick = () => open(card.dataset.id, card.dataset.name);
      const img = card.querySelector('.sf-card-art img');
      if (img) {
        img.onerror = () => { img.onerror = null; plateFor(img, card.dataset.name || ''); };
        // A cached failure has already fired the event; ask again.
        if (img.complete && img.naturalWidth === 0) img.onerror();
      }
    });
    root.querySelectorAll('.sf-lead').forEach((lead) => {
      lead.onclick = (e) => {
        // The Install control inside the plate commits straight away; the
        // rest of the plate opens the page, like any card.
        if (e.target.closest('.xbox-btn-primary')) {
          const b = bridge();
          if (b?.fetchAndQueue) { b.fetchAndQueue(lead.dataset.id, lead.dataset.name); return; }
        }
        open(lead.dataset.id, lead.dataset.name);
      };
      const img = lead.querySelector('.sf-lead-art');
      if (img) img.onerror = () => { img.onerror = null; img.remove(); lead.classList.add('is-plate'); };
    });
  }

  /** The spotlight rotates on its own, and stops the moment you touch it. */
  function paintSpot() {
    const item = F.spot[F.spotIndex];
    const box = $('#sf-spotlight');
    if (!item || !box) return;
    box.classList.remove('hidden');
    const art = $('#sf-spot-art');
    if (art) art.src = item.header;
    setText('#sf-spot-name', item.name);
    setText('#sf-spot-sub', item.discount
      ? `${item.price} · ${item.discount}% off`
      : (item.price || 'On Steam now'));
    setText('#sf-spot-kicker', isOwned(item.id) ? 'Already in your library' : 'Featured today');
    const dots = $('#sf-spot-dots');
    if (dots) {
      dots.innerHTML = F.spot.map((_, i) => `<i class="${i === F.spotIndex ? 'is-on' : ''}"></i>`).join('');
    }
  }

  function startSpot() {
    clearInterval(F.spotTimer);
    if (F.spot.length < 2) return;
    F.spotTimer = setInterval(() => {
      F.spotIndex = (F.spotIndex + 1) % F.spot.length;
      paintSpot();
    }, 7000);
  }

  function stopSpot() { clearInterval(F.spotTimer); F.spotTimer = 0; }

  async function loadFront({ force = false } = {}) {
    const host = $('#store-front');
    const rails = $('#sf-rails');
    if (!host || !rails || F.loading) return;
    if (F.loaded && !force) return;

    F.loading = true;
    setText('#sf-status', 'Reading the charts…');
    let data = null;
    try { data = await api()?.getStoreFront?.(); } catch { data = null; }
    F.loading = false;

    if (!data || !data.ok) {
      rails.replaceChildren();
      setText('#sf-status', data?.error || 'Could not reach the Steam charts.');
      // Nothing to browse, so the search hero stays full size — it is the
      // only thing the page can offer.
      page()?.removeAttribute('data-front');
      return;
    }

    F.loaded = true;
    // There is a front page now, so the search hero folds down to a bar.
    // A full-height "Find a game" panel above the rails pushed every one of
    // them below the fold and asked a question the page was already
    // answering.
    page()?.setAttribute('data-front', 'on');
    setText('#sf-status', '');
    F.spot = data.spotlight || [];
    F.spotIndex = 0;
    if (F.spot.length) { paintSpot(); startSpot(); }
    else $('#sf-spotlight')?.classList.add('hidden');

    rails.innerHTML = data.rails.map(railHtml).join('');
    wireCards(rails);
  }

  /**
   * The front page is the Store page's resting face.
   *
   * The fetch is deliberately not made until the Store is actually on screen.
   * Wiring it to the mode attribute alone would have run three Steam requests
   * and forty appdetails lookups during startup for every user who never
   * opens the Store that session.
   */
  function showFront(on) {
    const host = $('#store-front');
    if (!host) return;
    const visible = on && Boolean(page()?.classList.contains('active'));
    host.classList.toggle('hidden', !on);
    if (visible) { loadFront(); startSpot(); } else stopSpot();
  }

  function init() {
    $('#sd-back')?.addEventListener('click', close);
    $('#sd-install')?.addEventListener('click', () => safely('install', install));
    $('#sd-steam')?.addEventListener('click', () => {
      if (D.appid) api()?.openExternal?.(`https://store.steampowered.com/app/${D.appid}`);
    });
    // The second source. The page stays up behind the picker, so a closed
    // picker lands back here rather than on the results.
    $('#sd-csrin')?.addEventListener('click', () => safely('csrin', () => {
      const b = bridge();
      if (!b?.csrinSearch || !D.appid) return;
      b.csrinSearch(D.appid, D.name);
    }));

    const sound = $('#sd-sound');
    sound?.addEventListener('click', () => {
      const v = $('#sd-trailer');
      if (!v) return;
      v.muted = !v.muted;
      sound.textContent = v.muted ? '🔇' : '🔊';
    });

    // A finished scan can change whether this game is owned while its page is
    // open, and the button has to say so.
    window.addEventListener('librarian:games', () => safely('owned', paintInstall));

    // Leaving the Store page closes whatever was open on it; arriving brings
    // the front page back up.
    window.addEventListener('librarian:page', (e) => {
      const onStore = e.detail?.page === 'store';
      if (!onStore && panel() && !panel().classList.contains('hidden')) close();
      showFront(onStore && page()?.getAttribute('data-mode') === 'hero');
    });

    // app.js flips data-mode when a search runs or is cleared. The front page
    // is the resting face of the Store, so it follows that attribute rather
    // than trying to track the search box itself.
    const host = page();
    if (host && typeof MutationObserver === 'function') {
      new MutationObserver(() => safely('mode', () => {
        showFront(host.getAttribute('data-mode') === 'hero');
      })).observe(host, { attributes: true, attributeFilter: ['data-mode'] });
      showFront(host.getAttribute('data-mode') === 'hero');
    }

    $('#sf-spot-open')?.addEventListener('click', () => {
      const item = F.spot[F.spotIndex];
      if (item) open(item.id, item.name);
    });
    $('#sf-spot-get')?.addEventListener('click', () => {
      const item = F.spot[F.spotIndex];
      if (item) bridge()?.fetchAndQueue?.(item.id, item.name);
    });
    // Touching the spotlight stops it moving under you.
    $('#sf-spotlight')?.addEventListener('pointerenter', stopSpot);
    $('#sf-spotlight')?.addEventListener('pointerleave', () => { if (F.spot.length > 1) startSpot(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // ════════════════════════════════════════════════════════════════
  // Published for Big Picture, which renders its own couch version of all
  // of this and only needs the data half.
  // ════════════════════════════════════════════════════════════════
  window.LibrarianStore = {
    open,
    close,
    // Published so the search results can be built from the same component
    // the front page uses. A search result and a shelf card are the same
    // thing — a game you do not own yet — and rendering them as two
    // different objects was the whole reason search looked like a different
    // application from the store it belongs to.
    cardHtml,
    leadHtml,
    wireCards,
    fetchMeta,
    fetchDepots,
    sizeOf,
    isOwned,
    get openAppId() { return panel() && !panel().classList.contains('hidden') ? D.appid : ''; },
  };
})();
