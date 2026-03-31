// ═══════════════════════════════════════════════════════════
// Librarian — Xbox-Style Launcher Controller
// ═══════════════════════════════════════════════════════════
(function () {
  'use strict';

  const THEME_DEFAULTS = { accent: '#10B981', background: '#0e0e0e' };

  const state = {
    queue: [],
    isProcessing: false,
    isPaused: false,
    currentGameData: null,
    settings: {},
    speedHistory: [],
    smoothedSpeed: 0,
    currentTotalBytes: 0,
    currentPercent: 0,
    downloadStartTime: 0,
    games: [],
    updateResults: {},
    heroGame: null,
    currentPage: 'home',
  };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const OS_ICONS = {
    windows: `<svg class="os-icon" viewBox="0 0 16 16"><path fill="currentColor" d="M0 2.3l6.5-.9v6.3H0V2.3zm7.3-1l8.7-1.3v7.6H7.3V1.3zM16 8.7v7.5l-8.7-1.2V8.7H16zM6.5 14.7L0 13.8V8.7h6.5v6z"/></svg>`,
    linux: `<svg class="os-icon" viewBox="0 0 16 16"><path fill="currentColor" d="M8 1C5.8 1 4 3 4 5.5c0 1.3.5 2.5 1.3 3.3-.8.5-1.8 1.4-2.3 2.7-.3.8 0 1.7.7 2.2.5.3 1.1.3 1.6.1.4-.2.8-.5 1.1-.9.5-.7 1-.8 1.6-.8s1.1.1 1.6.8c.3.4.7.7 1.1.9.5.2 1.1.2 1.6-.1.7-.5 1-1.4.7-2.2-.5-1.3-1.5-2.2-2.3-2.7C10.5 8 11 6.8 11 5.5 11 3 9.2 1 8 1z"/></svg>`,
    macos: `<svg class="os-icon" viewBox="0 0 16 16"><path fill="currentColor" d="M12.2 5.3c-.1-.1-1.6-.9-1.6-2.8 0-2.2 1.9-3 2-3.1-.1-.1-1.1-1.4-2.8-1.4-1.2 0-1.8.7-2.7.7-.9 0-1.6-.7-2.7-.7C2.6-2 0-.1 0 3.1c0 2 .7 4.1 1.6 5.4.8 1.1 1.5 2 2.5 2 1 0 1.3-.7 2.8-.7 1.4 0 1.7.7 2.7.7 1 0 1.8-1 2.5-2 .4-.6.7-1.1.9-1.4 0 0-1.8-.7-1.8-2.8zM9.8.2c.6-.7.9-1.6.9-2.5 0-.1 0-.3-.1-.4-1 .1-2.1.7-2.7 1.4-.6.7-.9 1.5-.9 2.5 0 .1 0 .3.1.4.1 0 .2 0 .3 0 .8 0 1.8-.6 2.4-1.4z" transform="translate(1.5,4)"/></svg>`,
  };

  // ─── Init ───────────────────────────────────────────
  async function init() {
    state.settings = await api.getAllSettings();
    applyThemeColors(
      state.settings.accent_color || THEME_DEFAULTS.accent,
      state.settings.background_color || THEME_DEFAULTS.background
    );
    setupNavigation();
    setupWindowControls();
    setupDropZone();
    setupDownloadListeners();
    setupQueueControls();
    setupSearchPage();
    setupSettingsPage();
    setupCrackPage();
    setupHomePage();
    setupLibraryPage();
    log('✦ Librarian Launcher is ready.', 'accent');
  }

  // ─── Navigation ─────────────────────────────────────
  function setupNavigation() {
    $$('.nav-tab[data-page]').forEach(btn => {
      btn.addEventListener('click', () => navigateTo(btn.dataset.page));
    });
    $$('.row-see-all').forEach(btn => {
      btn.addEventListener('click', () => navigateTo(btn.dataset.target));
    });
  }

  function navigateTo(page) {
    state.currentPage = page;
    $$('.nav-tab').forEach(b => b.classList.remove('active'));
    const activeTab = $(`[data-page="${page}"]`);
    if (activeTab) activeTab.classList.add('active');
    $$('.page').forEach(p => p.classList.remove('active'));
    const pageEl = $(`#page-${page}`);
    if (pageEl) pageEl.classList.add('active');
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
      if (state.heroGame) openPath(state.heroGame.install_path);
    };
    $('#hero-details-btn').onclick = () => {
      if (state.heroGame) openFlyout(state.heroGame);
    };
    // Auto-scan on startup
    scanAndRender();
  }

  async function scanAndRender() {
    state.games = await api.scanGames();
    renderHome();
    renderLibraryGrid();
    if (state.games.length > 0) {
      checkUpdatesInBackground();
    }
  }

  function renderHome() {
    const empty = $('#home-empty');
    const heroSection = $('#hero-section');
    const rowRecent = $('#row-recent');
    const rowUpdates = $('#row-updates');
    const rowAll = $('#row-all');

    if (!state.games.length) {
      empty.style.display = '';
      heroSection.style.display = 'none';
      rowRecent.style.display = 'none';
      rowUpdates.style.display = 'none';
      rowAll.style.display = 'none';
      return;
    }

    empty.style.display = 'none';
    heroSection.style.display = '';

    // Hero: first game with an AppID or banner
    const heroCandidate = state.games.find(g => (g.appid && g.appid !== '0') || g.banner_path) || state.games[0];
    state.heroGame = heroCandidate;

    const heroBg = getGameBannerUrl(heroCandidate, 'hero');
    if (heroBg) {
      $('#hero-bg').style.backgroundImage = `url(${heroBg})`;
      $('#hero-bg').style.backgroundSize = 'cover';
      $('#hero-bg').style.backgroundPosition = 'center';
    }
    $('#hero-title').textContent = heroCandidate.game_name || 'Unknown Game';
    $('#hero-subtitle').textContent = `AppID: ${heroCandidate.appid || 'N/A'} · ${formatSize(heroCandidate.size_on_disk || 0)}`;

    // Recent games (exclude hero, show up to 10)
    const recent = state.games.filter(g => g !== heroCandidate).slice(0, 10);
    renderGameRow('#row-recent-scroll', recent);
    rowRecent.style.display = recent.length ? '' : 'none';

    // All games
    renderGameRow('#row-all-scroll', state.games);
    rowAll.style.display = state.games.length ? '' : 'none';

    // Updates row (fill later when updates come in)
    rowUpdates.style.display = 'none';
  }

  function renderGameRow(containerId, games) {
    const container = $(containerId);
    container.innerHTML = '';
    for (const g of games) {
      container.appendChild(createGameTile(g));
    }
  }

  function getGameBannerUrl(game, type = 'header') {
    // Custom banner takes priority
    if (game.banner_path) return `file:///${game.banner_path.replace(/\\/g, '/')}`;
    if (game.banner_url) return game.banner_url;
    // Fallback to Steam CDN
    if (game.appid && game.appid !== '0' && game.appid !== '') {
      if (type === 'hero') return `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/library_hero.jpg`;
      return `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/header.jpg`;
    }
    return '';
  }

  function createGameTile(game) {
    const tile = document.createElement('div');
    tile.className = 'game-tile';
    const img = getGameBannerUrl(game, 'header');
    const updateInfo = state.updateResults[game.appid];
    const badgeHtml = updateInfo && updateInfo.status === 'update_available'
      ? '<div class="tile-update-badge">Update</div>' : '';
    const customBadge = game.source === 'Custom' ? '<div class="tile-custom-badge">Custom</div>' : '';

    tile.innerHTML = `
      <div class="game-tile-img-wrap">
        ${img ? `<img class="game-tile-img" src="${img}" onerror="this.style.display='none'" loading="lazy">` : '<div class="game-tile-placeholder">🎮</div>'}
        ${badgeHtml}
        ${customBadge}
      </div>
      <div class="game-tile-name">${esc(game.game_name)}</div>
      <div class="game-tile-meta">${formatSize(game.size_on_disk || 0)}</div>
    `;
    tile.onclick = () => openFlyout(game);
    return tile;
  }

  // ─── Update Checking ───────────────────────────────
  async function checkUpdatesInBackground() {
    const gamesWithIds = state.games.filter(g => g.appid && g.appid !== '0' && g.buildid);
    if (!gamesWithIds.length) return;

    try {
      const results = await api.checkAllGameUpdates(
        gamesWithIds.map(g => ({ appid: g.appid, buildid: g.buildid }))
      );
      state.updateResults = results;
      refreshUpdateBadges();
    } catch (e) {
      console.error('Update check failed:', e);
    }
  }

  function refreshUpdateBadges() {
    // Re-render rows to show badges
    renderHome();
    renderLibraryGrid();

    // Show updates row
    const gamesWithUpdates = state.games.filter(g =>
      state.updateResults[g.appid] && state.updateResults[g.appid].status === 'update_available'
    );
    const rowUpdates = $('#row-updates');
    if (gamesWithUpdates.length) {
      renderGameRow('#row-updates-scroll', gamesWithUpdates);
      rowUpdates.style.display = '';
    }

    // Update flyout if open
    const flyout = $('#game-flyout');
    if (flyout.classList.contains('flyout-open') && state.flyoutGame) {
      renderFlyoutUpdateStatus(state.flyoutGame);
    }
  }

  // ─── Library Page ───────────────────────────────────
  function setupLibraryPage() {
    $('#lib-scan-btn').onclick = () => scanAndRender();
    $('#lib-add-game-btn').onclick = () => showAddCustomGameModal();
    $('#lib-check-updates-btn').onclick = async () => {
      toast('Checking for updates...');
      await checkUpdatesInBackground();
      const updates = Object.values(state.updateResults).filter(r => r.status === 'update_available').length;
      toast(updates > 0 ? `${updates} update(s) available!` : 'All games are up to date ✓', updates > 0 ? '' : 'success');
    };
    $('#lib-filter').oninput = () => renderLibraryGrid();
  }

  function renderLibraryGrid() {
    const grid = $('#lib-grid');
    const filter = ($('#lib-filter')?.value || '').toLowerCase();
    grid.innerHTML = '';

    let filtered = state.games;
    if (filter) {
      filtered = filtered.filter(g => (g.game_name || '').toLowerCase().includes(filter));
    }

    $('#lib-count').textContent = `${filtered.length} game(s)`;

    if (!filtered.length) {
      grid.innerHTML = '<div class="empty-state-centered">No games found. Click Scan to search your Steam libraries.</div>';
      return;
    }

    for (const g of filtered) {
      grid.appendChild(createGameTile(g));
    }
  }

  // ─── Game Flyout Panel ──────────────────────────────
  function openFlyout(game) {
    state.flyoutGame = game;
    const flyout = $('#game-flyout');
    flyout.classList.remove('flyout-closed');
    flyout.classList.add('flyout-open');

    const heroImg = getGameBannerUrl(game, 'hero');
    const headerImg = getGameBannerUrl(game, 'header');
    $('#flyout-hero-img').src = heroImg;
    $('#flyout-hero-img').onerror = function() { this.src = headerImg; };
    $('#flyout-title').textContent = game.game_name || 'Unknown';

    $('#flyout-meta').innerHTML = `
      <span>AppID: ${game.appid || 'N/A'}</span>
      <span>·</span>
      <span>${formatSize(game.size_on_disk || 0)}</span>
      ${game.buildid ? `<span>·</span><span>Build: ${game.buildid}</span>` : ''}
      ${game.source === 'Custom' ? `<span>·</span><span style="color:var(--primary)">Custom</span>` : ''}
    `;

    renderFlyoutUpdateStatus(game);

    const isCustom = game.source === 'Custom';
    let actionsHtml = `
      <button class="xbox-btn xbox-btn-primary" id="flyout-open-folder">Open Folder</button>
      <button class="xbox-btn xbox-btn-secondary" id="flyout-update-check">Check for Update</button>
      <button class="xbox-btn xbox-btn-secondary" id="flyout-crack-btn">Crack Game</button>
    `;
    if (isCustom) {
      actionsHtml += `<button class="xbox-btn xbox-btn-secondary" id="flyout-edit-btn">Edit</button>`;
      actionsHtml += `<button class="xbox-btn xbox-btn-secondary" style="color:var(--accent-red)" id="flyout-remove-custom">Remove from Library</button>`;
    } else {
      actionsHtml += `<button class="xbox-btn xbox-btn-secondary" style="color:var(--accent-red)" id="flyout-uninstall">Uninstall</button>`;
    }
    $('#flyout-actions').innerHTML = actionsHtml;

    $('#flyout-details').innerHTML = `
      <div class="detail-row"><span class="detail-label">Path</span><span class="detail-value">${esc(game.install_path || 'N/A')}</span></div>
      <div class="detail-row"><span class="detail-label">Library</span><span class="detail-value">${esc(game.library_path || 'N/A')}</span></div>
      <div class="detail-row"><span class="detail-label">Source</span><span class="detail-value">${esc(game.source || 'N/A')}</span></div>
    `;

    // Wire up buttons
    $('#flyout-open-folder').onclick = () => api.openPath(game.install_path);
    $('#flyout-update-check').onclick = async () => {
      if (!game.appid || game.appid === '0' || game.appid === '') { toast('No AppID — cannot check', 'error'); return; }
      const statusEl = $('#flyout-update-status');
      statusEl.innerHTML = '<span class="update-badge checking">⏳ Checking...</span>';
      const result = await api.checkGameUpdate(game.appid, game.buildid);
      state.updateResults[game.appid] = result;
      renderFlyoutUpdateStatus(game);
      refreshUpdateBadges();
    };
    $('#flyout-crack-btn').onclick = () => { closeFlyout(); navigateTo('crack'); };

    if (isCustom) {
      $('#flyout-edit-btn').onclick = () => { closeFlyout(); showEditCustomGameModal(game); };
      $('#flyout-remove-custom').onclick = async () => {
        const msg = await api.getUninstallMessage(game);
        if (confirm(msg)) {
          await api.removeCustomGame(game.id);
          toast(`${game.game_name} removed from library`);
          closeFlyout();
          scanAndRender();
        }
      };
    } else {
      $('#flyout-uninstall').onclick = async () => {
        const msg = await api.getUninstallMessage(game);
        if (confirm(msg)) {
          const r = await api.uninstallGame(game);
          if (r.success) { toast(`${game.game_name} uninstalled`); closeFlyout(); scanAndRender(); }
          else toast(`Failed: ${r.error}`, 'error');
        }
      };
    }

    $('#flyout-close').onclick = closeFlyout;
    $('#flyout-backdrop').onclick = closeFlyout;
  }

  function renderFlyoutUpdateStatus(game) {
    const statusEl = $('#flyout-update-status');
    const info = state.updateResults[game.appid];
    if (!info) {
      if (!game.appid || game.appid === '0') {
        statusEl.innerHTML = '<span class="update-badge unknown">No AppID</span>';
      } else {
        statusEl.innerHTML = '<span class="update-badge unknown">Not checked</span>';
      }
      return;
    }

    switch (info.status) {
      case 'up_to_date':
        statusEl.innerHTML = `<span class="update-badge up-to-date">✓ Up to date (Build ${info.remoteBuildId})</span>`;
        break;
      case 'update_available':
        statusEl.innerHTML = `<span class="update-badge update-available">⬆ Update available: Build ${info.localBuildId} → ${info.remoteBuildId}</span>`;
        break;
      case 'unknown':
        statusEl.innerHTML = `<span class="update-badge unknown">? ${info.reason || 'Unknown'}</span>`;
        break;
      case 'error':
        statusEl.innerHTML = `<span class="update-badge unknown">⚠ ${info.reason || 'Error'}</span>`;
        break;
    }
  }

  function closeFlyout() {
    const flyout = $('#game-flyout');
    flyout.classList.remove('flyout-open');
    flyout.classList.add('flyout-closed');
    state.flyoutGame = null;
  }

  // ─── Drop Zone ──────────────────────────────────────
  function setupDropZone() {
    const dz = $('#drop-zone');
    dz.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', (e) => { e.preventDefault(); dz.classList.remove('drag-over'); });
    dz.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation(); dz.classList.remove('drag-over');
      Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.zip')).forEach(f => addToQueue(f.name, f.path));
    });
    dz.addEventListener('click', async () => {
      const fp = await api.openFile({ filters: [{ name: 'ZIP', extensions: ['zip'] }] });
      if (fp) addToQueue(fp.split(/[\\/]/).pop(), fp);
    });
  }

  // ─── Queue ──────────────────────────────────────────
  function addToQueue(name, filepath) {
    const appIdMatch = name.match(/(\d{3,})/);
    const possibleAppId = appIdMatch ? appIdMatch[1] : null;
    const job = {
      id: Date.now() + Math.random(),
      name: name.replace('.zip', ''),
      path: filepath,
      status: 'queued',
      percent: 0,
      appid: possibleAppId,
    };
    state.queue.push(job);
    log(`📦 Added: ${job.name}`);
    updateQueueUI();
    updateBadge();
    navigateTo('downloads');
    if (!state.isProcessing) processNextJob();
  }

  function updateQueueUI() {
    const area = $('#queue-area');
    const container = $('#queue-cards');
    area.classList.remove('hidden');
    $('#log-area').classList.remove('hidden');
    container.innerHTML = '';

    state.queue.forEach(job => {
      const card = document.createElement('div');
      card.className = `queue-card ${job.status === 'processing' ? 'active' : ''}`;
      const imgSrc = job.appid ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${job.appid}/header.jpg` : '';
      card.innerHTML = `
        ${imgSrc ? `<img class="queue-card-img" src="${imgSrc}" onerror="this.style.display='none'">` : '<div class="queue-card-img"></div>'}
        <div class="queue-card-name">${esc(job.name)}</div>
        <div class="queue-card-status ${job.status}">${job.status}</div>
        ${job.status === 'processing' ? `<div class="queue-card-progress"><div class="queue-card-fill" style="width:${job.percent}%"></div></div>` : ''}
      `;
      container.appendChild(card);
    });

    const pauseBtn = $('#btn-pause');
    const cancelBtn = $('#btn-cancel');
    if (state.isProcessing) {
      pauseBtn.style.display = ''; cancelBtn.style.display = '';
      pauseBtn.textContent = state.isPaused ? '▶' : '⏸';
    } else {
      pauseBtn.style.display = 'none'; cancelBtn.style.display = 'none';
    }
  }

  function updateBadge() {
    const badge = $('#badge-downloads');
    const count = state.queue.filter(j => j.status === 'queued' || j.status === 'processing').length;
    if (count > 0) { badge.textContent = count; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  }

  async function processNextJob() {
    const next = state.queue.find(j => j.status === 'queued');
    if (!next) {
      state.isProcessing = false;
      hideDlStats();
      updateQueueUI();
      updateBadge();
      log('✅ All jobs complete!', 'success');
      scanAndRender();
      return;
    }

    state.isProcessing = true;
    next.status = 'processing';
    updateQueueUI();
    updateBadge();

    log(`\n── Processing: ${next.name} ──`, 'accent');
    showDlStats(next.name);

    const result = await api.processZip(next.path);
    if (!result.success) {
      log(`❌ ${result.error}`, 'error');
      toast(`Failed: ${next.name}`, 'error');
      removeJob(next.id);
      processNextJob();
      return;
    }

    state.currentGameData = result.data;
    const gd = result.data;
    if (gd.appid) next.appid = gd.appid;

    log(`🎮 ${gd.game_name} (${gd.appid})`);
    log(`📦 ${Object.keys(gd.depots || {}).length} depots`);
    if (gd.platforms) log(`🖥️ ${gd.platforms.join(', ')}`);
    if (gd.dlcs) log(`🧩 ${Object.keys(gd.dlcs).length} DLCs`);

    updateQueueUI();

    const depots = gd.depots || {};
    if (!Object.keys(depots).length) { log('❌ No depots found.', 'error'); removeJob(next.id); processNextJob(); return; }

    const selected = await showDepotSelection(gd);
    if (!selected || !selected.length) { log('⏹ Cancelled.'); removeJob(next.id); processNextJob(); return; }

    let dest;
    if (state.settings.library_mode) dest = await showSteamLibrarySelection();
    else { dest = await api.findSteamInstall(); if (!dest) dest = await api.openFolder(); }
    if (!dest) { log('⏹ No destination.'); removeJob(next.id); processNextJob(); return; }

    log(`📂 ${dest}`);
    setDlName(gd.game_name);
    state.downloadStartTime = Date.now();
    state.speedHistory = [];
    state.currentTotalBytes = selected.reduce((total, depotId) => {
      const depotSize = Number(gd.depots?.[depotId]?.size || 0);
      return total + (Number.isFinite(depotSize) ? depotSize : 0);
    }, 0);
    state.currentPercent = 0;
    state.lastPercentSample = 0;
    state.lastPercentSampleTime = 0;
    state.lastExplicitSpeedAt = 0;

    const dlRes = await api.startDownload({ gameData: gd, selectedDepots: selected, destPath: dest });
    if (!dlRes.success) { log(`❌ ${dlRes.error}`, 'error'); removeJob(next.id); processNextJob(); }
  }

  function removeJob(id) {
    state.queue = state.queue.filter(j => j.id !== id);
    updateQueueUI();
    updateBadge();
  }

  // ─── Queue Controls ─────────────────────────────────
  function setupQueueControls() {
    $('#btn-pause').onclick = async () => {
      if (state.isPaused) { await api.resumeDownload(); state.isPaused = false; log('▶️ Resumed'); }
      else { await api.pauseDownload(); state.isPaused = true; log('⏸️ Paused'); }
      updateQueueUI();
    };
    $('#btn-cancel').onclick = async () => {
      await api.cancelDownload();
      log('⏹ Cancelled', 'error');
      const active = state.queue.find(j => j.status === 'processing');
      if (active) removeJob(active.id);
      state.isProcessing = false; state.isPaused = false;
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
    $('#dl-speed').textContent = '—';
    $('#dl-eta').textContent = '—';
    $('#dl-progress-fill').style.width = '0%';
    state.speedHistory = [];
    state.smoothedSpeed = 0;
    drawSpeedChart();
  }

  function hideDlStats() {
    $('#dl-stats').classList.add('hidden');
    $('#dl-progress-track').classList.add('hidden');
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

  function pushSpeedSample(speedText) {
    const bytesPerSec = parseSpeedToBytes(speedText);
    if (bytesPerSec <= 0) return;

    // Exponential moving average (alpha = 0.3 for smooth but responsive)
    const alpha = state.smoothedSpeed > 0 ? 0.3 : 1.0;
    state.smoothedSpeed = alpha * bytesPerSec + (1 - alpha) * (state.smoothedSpeed || 0);

    // Display smoothed speed
    $('#dl-speed').textContent = formatSpeed(state.smoothedSpeed);

    // Push to chart (in MB/s)
    const mbps = state.smoothedSpeed / (1024 * 1024);
    state.speedHistory.push(mbps);
    if (state.speedHistory.length > 120) state.speedHistory.shift();
    drawSpeedChart();

    // Update ETA based on smoothed speed
    updateETA();
  }

  function updateETA() {
    if (!state.smoothedSpeed || state.smoothedSpeed <= 0 || !state.currentTotalBytes || state.currentPercent <= 0) {
      $('#dl-eta').textContent = '—';
      return;
    }
    const remainingBytes = state.currentTotalBytes * (1 - state.currentPercent / 100);
    if (remainingBytes <= 0) {
      $('#dl-eta').textContent = '—';
      return;
    }
    const remainingSeconds = remainingBytes / state.smoothedSpeed;
    $('#dl-eta').textContent = remainingSeconds > 0 ? formatETA(remainingSeconds) : '—';
  }

  function formatSpeed(bytesPerSecond) { return `${formatSize(bytesPerSecond)}/s`; }

  function drawSpeedChart() {
    const canvas = $('#speed-chart');
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const data = state.speedHistory.slice(-60);
    if (data.length < 2) return;
    const max = Math.max(...data, 0.01);
    const primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || THEME_DEFAULTS.accent;
    ctx.strokeStyle = primary;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - (v / max) * (h - 4) - 2;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fillStyle = hexToRgba(primary, 0.18);
    ctx.fill();
  }

  // ─── Download Listeners ─────────────────────────────
  function setupDownloadListeners() {
    api.onDownloadProgress((msg) => log(msg));

    api.onDownloadPercentage((pct) => {
      state.currentPercent = pct;
      $('#dl-pct-text').textContent = `${pct}%`;
      $('#dl-progress-fill').style.width = `${pct}%`;

      const active = state.queue.find(j => j.status === 'processing');
      if (active) {
        active.percent = pct;
        const fills = $$('.queue-card.active .queue-card-fill');
        fills.forEach(f => f.style.width = `${pct}%`);
      }

      // Update ETA whenever percentage changes
      updateETA();
    });

    api.onDownloadSpeed((speed) => {
      pushSpeedSample(speed);
    });

    api.onDownloadComplete(() => {
      log('✅ Download complete!', 'success');
      toast('Download complete! 🎉', 'success');
      try { new Notification('Librarian', { body: 'Download complete!' }); } catch { }
      const active = state.queue.find(j => j.status === 'processing');
      if (active) removeJob(active.id);
      state.isProcessing = false; state.isPaused = false;
      state.currentTotalBytes = 0;
      hideDlStats(); updateQueueUI(); updateBadge(); processNextJob();
    });

    api.onDownloadError((err) => {
      log(`❌ ${err}`, 'error');
      toast('Download failed!', 'error');
      const active = state.queue.find(j => j.status === 'processing');
      if (active) removeJob(active.id);
      state.isProcessing = false; state.isPaused = false;
      state.currentTotalBytes = 0;
      hideDlStats(); updateQueueUI(); updateBadge(); processNextJob();
    });
  }

  // ─── Search / Store Page ────────────────────────────
  function setupSearchPage() {
    const BLACKLIST = ['soundtrack', 'ost', 'original soundtrack', 'artbook', 'demo', 'dedicated server', 'tool', 'sdk'];
    const inp = $('#search-input');

    inp.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const q = inp.value.trim();
      if (q.length < 2) return;

      $('#search-status').innerHTML = '<div class="loading-state"><div class="spinner"></div>Searching...</div>';
      $('#search-results').innerHTML = '';
      inp.disabled = true;

      const res = await api.searchGames(q);
      inp.disabled = false; inp.focus();

      if (res.error) { $('#search-status').textContent = `Error: ${res.error}`; return; }
      const games = res.results || [];
      if (!games.length) { $('#search-status').textContent = 'No results found.'; return; }

      let filtered = 0;
      const container = $('#search-results');
      container.innerHTML = '';

      for (const g of games) {
        const name = g.game_name || '';
        if (BLACKLIST.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(name))) { filtered++; continue; }
        const id = String(g.game_id);
        const card = document.createElement('div');
        card.className = 'result-card';
        card.innerHTML = `
          <img class="result-card-img" src="https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg" onerror="this.style.display='none'" loading="lazy">
          <div class="result-card-info">
            <div class="result-card-name">${esc(name)}</div>
            <div class="result-card-id">AppID: ${id}</div>
          </div>
        `;
        card.onclick = () => fetchAndQueue(id, name);
        container.appendChild(card);
      }
      $('#search-status').textContent = `${games.length - filtered} results (${filtered} filtered)`;
    });
  }

  async function fetchAndQueue(appId, name) {
    navigateTo('downloads');
    log(`🔄 Fetching manifest for ${name}...`);
    const res = await api.downloadManifest(appId);
    if (res.error) { log(`❌ ${res.error}`, 'error'); toast(`Failed: ${res.error}`, 'error'); return; }
    if (res.filepath) { log('✅ Manifest ready!', 'success'); addToQueue(name, res.filepath); }
  }

  // ─── Settings Page ──────────────────────────────────
  function setupSettingsPage() {
    (async () => {
      const s = await api.getAllSettings();
      $('#inp-api-key').value = s.morrenus_api_key || '';
      $('#chk-sls').checked = s.slssteam_mode || false;
      $('#chk-library').checked = s.library_mode || false;
      $('#chk-achievements').checked = s.generate_achievements || false;
      $('#chk-steamless').checked = s.use_steamless || false;
      $('#chk-auto-crack').checked = s.auto_crack || false;
      // Theme
      $('#inp-accent').value = s.accent_color || THEME_DEFAULTS.accent;
      $('#accent-hex').textContent = s.accent_color || THEME_DEFAULTS.accent;
      $('#inp-bg').value = s.background_color || THEME_DEFAULTS.background;
      $('#bg-hex').textContent = s.background_color || THEME_DEFAULTS.background;
    })();

    const saveSettings = async () => {
      await api.setSetting('morrenus_api_key', $('#inp-api-key').value.trim());
      await api.setSetting('slssteam_mode', $('#chk-sls').checked);
      await api.setSetting('library_mode', $('#chk-library').checked);
      await api.setSetting('generate_achievements', $('#chk-achievements').checked);
      await api.setSetting('use_steamless', $('#chk-steamless').checked);
      await api.setSetting('auto_crack', $('#chk-auto-crack').checked);
      state.settings = await api.getAllSettings();
    };

    $('#chk-sls').onchange = saveSettings;
    $('#chk-library').onchange = saveSettings;
    $('#chk-achievements').onchange = saveSettings;
    $('#chk-steamless').onchange = saveSettings;
    $('#chk-auto-crack').onchange = saveSettings;

    $('#btn-save-settings').onclick = async () => {
      await saveSettings();
      toast('Settings saved! ✓');
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
      await api.setSetting('accent_color', a);
      await api.setSetting('background_color', b);
      applyThemeColors(a, b);
      state.settings = await api.getAllSettings();
      toast('Theme applied! ✨');
    };
  }

  // ─── Depot Selection Modal ──────────────────────────
  function showDepotSelection(gameData) {
    return new Promise((resolve) => {
      const depots = gameData.depots || {};
      const entries = Object.entries(depots);
      const headerUrl = gameData.header_url || `https://cdn.cloudflare.steamstatic.com/steam/apps/${gameData.appid}/header.jpg`;
      const platforms = gameData.platforms || ['windows'];

      let html = `
        <img class="modal-header-img" src="${headerUrl}" onerror="this.style.display='none'">
        <div class="flex items-center justify-between mb-8">
          <div>
            <div class="font-bold" style="font-size:15px">${esc(gameData.game_name)}</div>
            <div class="text-muted" style="font-size:11px;font-family:var(--font-mono)">AppID: ${gameData.appid} · ${entries.length} depots</div>
          </div>
          <div class="flex gap-6">${platforms.map(p => osTag(p)).join('')}</div>
        </div>
        <div class="flex gap-6 mb-8">
          <button class="xbox-btn xbox-btn-secondary btn-sm" id="depot-all">Select All</button>
          <button class="xbox-btn xbox-btn-secondary btn-sm" id="depot-none">Deselect All</button>
        </div>
        <ul class="depot-list" id="depot-list">
      `;

      for (const [id, d] of entries) {
        const depotOS = d.os || ['windows'];
        const arch = d.osarch || null;
        const isShared = d.isShared || false;
        const tags = d.tags || [];
        let size = '';
        if (d.size) {
          const b = parseInt(d.size);
          if (b > 1073741824) size = `${(b / 1073741824).toFixed(2)} GB`;
          else if (b > 1048576) size = `${(b / 1048576).toFixed(1)} MB`;
          else if (b > 1024) size = `${(b / 1024).toFixed(0)} KB`;
        }
        const osTags = isShared
          ? '<span class="tag tag-all">📦 Shared</span>'
          : depotOS.map(o => osTag(o, arch)).join('');

        html += `
          <li class="depot-item" data-depot="${id}">
            <div class="depot-check">✓</div>
            <div class="depot-content">
              <div class="depot-desc">${esc(d.desc || `Depot ${id}`)}</div>
              <div class="depot-tags">
                ${osTags}
                ${tags.map(t => `<span class="tag tag-lang">${t.label}</span>`).join('')}
                <span class="tag" style="background:rgba(255,255,255,0.05);color:var(--text-muted);border:1px solid var(--border)">${id}</span>
              </div>
            </div>
            ${size ? `<span class="depot-size">${size}</span>` : ''}
          </li>`;
      }
      html += '</ul>';

      if (gameData.dlcs && Object.keys(gameData.dlcs).length) {
        html += `<div class="separator"></div><div class="text-dim" style="font-size:12px;font-weight:700;margin-bottom:8px">🧩 DLCs (${Object.keys(gameData.dlcs).length})</div><ul class="dlc-list">`;
        for (const [dlcId, desc] of Object.entries(gameData.dlcs)) {
          html += `<li class="dlc-item"><span class="dlc-id">${dlcId}</span><span>${esc(desc)}</span></li>`;
        }
        html += '</ul>';
      }

      html += `<div class="modal-actions">
        <button class="xbox-btn xbox-btn-secondary" id="depot-cancel">Cancel</button>
        <button class="xbox-btn xbox-btn-primary" id="depot-ok">⬇ Download Selected</button>
      </div>`;

      openModal('Select Depots', html);

      $$('.depot-item').forEach(el => el.onclick = () => el.classList.toggle('checked'));
      $('#depot-all').onclick = () => $$('.depot-item').forEach(i => i.classList.add('checked'));
      $('#depot-none').onclick = () => $$('.depot-item').forEach(i => i.classList.remove('checked'));

      const done = (v) => { closeModal(); $('#modal-close').onclick = closeModal; resolve(v); };
      $('#depot-cancel').onclick = () => done(null);
      $('#modal-close').onclick = () => done(null);
      $('#depot-ok').onclick = () => {
        const sel = []; $$('.depot-item.checked').forEach(el => sel.push(el.dataset.depot));
        done(sel);
      };
    });
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
          ${bp ? `<img src="file:///${bp.replace(/\\/g, '/')}" style="max-height:80px;border-radius:6px">` : ''}
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
        $('#cg-banner-preview').innerHTML = `<img src="file:///${fp.replace(/\\/g, '/')}" style="max-height:80px;border-radius:6px">`;
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
      top.map(g => `<button class="cg-suggest-btn" data-id="${g.game_id}" style="
        display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;margin-bottom:4px;
        background:var(--bg-input);border:1px solid var(--border);border-radius:6px;
        color:var(--text);cursor:pointer;font-size:12px;text-align:left;
      ">
        <img src="https://cdn.cloudflare.steamstatic.com/steam/apps/${g.game_id}/capsule_sm_120.jpg"
             style="width:40px;height:18px;border-radius:3px;object-fit:cover" onerror="this.style.display='none'">
        <span style="flex:1">${esc(g.game_name || '')}</span>
        <span style="color:var(--text-muted);font-family:var(--font-mono)">${g.game_id}</span>
      </button>`).join('');

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
  function openModal(title, body) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = body;
    $('#modal-overlay').classList.remove('hidden');
  }

  function closeModal() {
    $('#modal-overlay').classList.add('hidden');
    $('#modal-body').innerHTML = '';
  }

  (function setupModal() {
    document.addEventListener('DOMContentLoaded', () => {
      $('#modal-close').onclick = closeModal;
      $('#modal-overlay').addEventListener('click', e => { if (e.target === $('#modal-overlay')) closeModal(); });
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          if (!$('#modal-overlay').classList.contains('hidden')) closeModal();
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

      if (scanData.detectedAppId) { inpAppId.value = scanData.detectedAppId; crackLog(`💡 Auto-detected AppID: ${scanData.detectedAppId}`); }
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
      crackLog(`🚀 Running SteamAutoCrack on ${gameName} (AppID: ${appId})...`);
      const res = await api.crackApply({ gamePath: currentFolder, appId: appId, gameName: gameName });
      if (res.success) { toast('Game cracked successfully! ✓', 'success'); crackLog('✅ All steps completed successfully!'); }
      else { toast(`Crack failed (exit code ${res.exitCode})`, 'error'); crackLog(`❌ Process failed with exit code ${res.exitCode}`); }
      btnApply.disabled = false;
      btnRestore.disabled = false;
    };

    btnRestore.onclick = async () => {
      if (!currentFolder) return;
      if (!confirm('Restore original files and undo crack?')) return;
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
    return `<span class="tag ${cls[os] || 'tag-all'}">${icons[os] || ''} ${label}</span>`;
  }

  function log(msg, type = '') {
    const el = document.createElement('div');
    el.className = `log-line ${type}`;
    el.textContent = msg;
    const out = $('#log-output');
    if (out) { out.appendChild(el); out.scrollTop = out.scrollHeight; }
  }

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type ? `toast-${type}` : ''}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 200ms'; setTimeout(() => el.remove(), 200); }, 3000);
  }

  function esc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return `${(b / Math.pow(1024, i)).toFixed(2)} ${u[i]}`;
  }

  function formatETA(seconds) {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  function openPath(p) { if (p) api.openPath(p); }

  // ─── Start ──────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();
