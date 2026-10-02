// ═══════════════════════════════════════════════════════════════════
// Librarian — the Tuning page
//
// A layer in its own file, like store.js: it talks to the main process
// through the tuning* bridge in preload.js and to the rest of the launcher
// through window.Librarian and the librarian:* events. The markup is static
// in index.html; this fills it, wires the switches and paints the numbers.
//
// Three rules keep it honest. Every switch writes the saved profile at once
// (a running game picks the change up on its next frame, so a flip is a live
// experiment). The tiles show what the game's own frames say, never what the
// profile claims. And the before/after test measures both phases on the same
// game, back to back, with the numbers side by side and the change spelled
// out — including when the change is nothing.
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const api = window.api;
  const app = () => window.Librarian || null;
  if (!api || !$('#page-tuning')) return;

  const el = {
    enabled: $('#tn-enabled'),
    status: $('#tn-status'),
    queue: $('#tn-queue'),
    queueHint: $('#tn-queue-hint'),
    limiter: $('#tn-limiter'),
    fps: $('#tn-fps'),
    fpsHint: $('#tn-fps-hint'),
    affinity: $('#tn-affinity'),
    topology: $('#tn-topology'),
    priority: $('#tn-priority'),
    refresh: $('#tn-refresh'),
    display: $('#tn-display'),
    power: $('#tn-power'),
    powerHint: $('#tn-power-hint'),
    gameSelect: $('#tn-game-select'),
    override: $('#tn-override'),
    liveApi: $('#tn-live-api'),
    mFps: $('#tn-m-fps'), mFpsSub: $('#tn-m-fps-sub'),
    mLow1: $('#tn-m-low1'), mLow1Sub: $('#tn-m-low1-sub'),
    mFrame: $('#tn-m-frame'), mFrameSub: $('#tn-m-frame-sub'),
    mLat: $('#tn-m-lat'), mLatSub: $('#tn-m-lat-sub'),
    mPresent: $('#tn-m-present'), mPresentSub: $('#tn-m-present-sub'),
    mWaits: $('#tn-m-waits'), mWaitsSub: $('#tn-m-waits-sub'),
    spark: $('#tn-spark'),
    applied: $('#tn-applied'),
    abSeconds: $('#tn-ab-seconds'),
    abRun: $('#tn-ab-run'),
    abCancel: $('#tn-ab-cancel'),
    abProgress: $('#tn-ab-progress'),
    abBarFill: $('#tn-ab-bar-fill'),
    abPhase: $('#tn-ab-phase'),
    abBody: $('#tn-ab-body'),
    abNote: $('#tn-ab-note'),
    page: $('#page-tuning'),
  };

  const state = {
    profile: null,
    machine: null,          // topology, display, availability
    sessions: [],           // tuned games running now
    last: null,             // the most recent one that exited
    history: [],            // fps samples for the sparkline
    gameKey: '',
    abRunning: false,
    loaded: false,
  };

  const fmt = {
    ms: (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : `${v.toFixed(d)} ms`,
    fps: (v) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : v.toFixed(v >= 100 ? 0 : 1),
    pct: (a, b) => (a && b && Number.isFinite(a) && Number.isFinite(b) && a !== 0) ? `${(((b - a) / a) * 100).toFixed(0)}%` : '',
  };

  // ── Segmented controls ─────────────────────────────────────────
  function segValue(root) {
    const on = root && $('[aria-checked="true"]', root);
    return on ? on.dataset.value : null;
  }
  function segSet(root, value) {
    if (!root) return;
    for (const b of $$('button', root)) {
      const on = b.dataset.value === value;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.classList.toggle('is-on', on);
    }
  }
  function segWire(root, onChange) {
    if (!root) return;
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (!b || b.disabled) return;
      segSet(root, b.dataset.value);
      onChange(b.dataset.value);
    });
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const buttons = $$('button', root);
      const idx = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
      const next = buttons[(idx + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
      if (next) { next.focus(); next.click(); e.preventDefault(); }
    });
  }

  // ── Profile ────────────────────────────────────────────────────
  function paintProfile() {
    const p = state.profile;
    if (!p) return;
    el.enabled.checked = Boolean(p.enabled);
    segSet(el.queue, p.queue);
    el.limiter.checked = Boolean(p.limiter);
    el.fps.value = p.fps > 0 ? String(p.fps) : '';
    el.affinity.checked = p.affinity !== 'off';
    el.priority.checked = Boolean(p.priority);
    el.refresh.checked = Boolean(p.refresh);
    el.power.checked = Boolean(p.power);
    el.page.classList.toggle('tn-off', !p.enabled);
    paintHints();
  }

  async function saveProfile(patch) {
    try {
      state.profile = await api.tuningSetProfile(patch);
      paintProfile();
      paintStatus();
      window.dispatchEvent(new CustomEvent('librarian:tuning', { detail: { profile: state.profile } }));
    } catch (e) {
      app()?.toast?.(`Tuning: ${e.message}`, 'error');
    }
  }

  function paintHints() {
    const m = state.machine;
    const p = state.profile || {};
    if (m && m.display && !m.display.error) {
      const d = m.display;
      const auto = Math.max(0, (d.max_hz || d.hz) - 3);
      el.fpsHint.textContent = p.fps > 0 ? `${p.fps} fps` : `auto = ${auto} fps (${d.max_hz || d.hz} Hz − 3)`;
      const rates = Array.isArray(d.rates) ? d.rates.join(' / ') : '';
      el.display.textContent = `${d.width}×${d.height} at ${d.hz} Hz now; this resolution offers ${rates} Hz.`
        + (d.max_hz > d.hz ? ` A game will run at ${d.max_hz} Hz.` : d.max_hz === d.hz ? ' Already at the highest rate.' : '');
    } else {
      el.fpsHint.textContent = p.fps > 0 ? `${p.fps} fps` : 'auto follows the display';
      el.display.textContent = m && m.available && !m.available.helper ? 'The tune helper is missing, so the display cannot be read or switched.' : 'Display not read.';
    }
    if (m && m.topology && !m.topology.error) {
      const t = m.topology;
      const rec = t.recommend || {};
      let what;
      if (rec.mode === 'pcores') what = `hybrid processor: games will be pinned to the ${t.classes.filter((c) => c.efficiency === Math.max(...t.classes.map((x) => x.efficiency))).length} performance cores.`;
      else if (rec.mode === 'vcache') what = 'two cache dies of different sizes: games will be pinned to the one with the large cache.';
      else what = `${t.cores} uniform cores, ${t.logical} threads: nothing to pin, so this changes nothing here.`;
      el.topology.textContent = `Detected ${what}`;
    } else {
      el.topology.textContent = 'Processor topology not read.';
    }
    if (m) {
      el.powerHint.textContent = m.highPerfPlan
        ? 'Switches to the High performance plan while a tuned game runs, then back.'
        : 'This Windows has no High performance plan to switch to; the switch will do nothing.';
    }
    const sess = currentSession();
    if (sess && sess.header) {
      const h = sess.header;
      el.queueHint.textContent = h.canQueue ? '' : (h.api === 'D3D12' ? 'waiting for the game\'s command queue' : `not available on ${h.api}`);
    } else {
      el.queueHint.textContent = '';
    }
  }

  // ── Sessions and measurements ──────────────────────────────────
  function currentSession() {
    return state.sessions.find((s) => s.running) || state.sessions[0] || null;
  }

  function paintStatus() {
    const sess = currentSession();
    const p = state.profile || {};
    let text, cls = '';
    if (sess) {
      const h = sess.header;
      const bits = [sess.name || 'Game'];
      if (h) bits.push(h.api);
      const age = (Date.now() - (sess.startedAt || Date.now())) / 1000;
      const quiet = sess.summary && sess.summary.seconds < 0.5 && age > 15;
      if (h && h.disabled) {
        bits.push(h.disabled === 'steam-overlay'
          ? 'Steam overlay active: Librarian FPS limit, render queue control and in-game toasts are unavailable for this session'
          : `tuning switched itself off (${h.disabled})`);
        cls = 'is-warn';
      }
      else if (sess.stale) { bits.push('no recent frame measurements — the game may be paused or the rendering hook interrupted'); cls = 'is-warn'; }
      else if (h && !h.frames && age > 15 && h.stage && h.stage !== 'idle' && h.stage !== 'in-present') { bits.push(`no frame yet — the DLL is at '${h.stage}'`); cls = 'is-warn'; }
      else if (h && (!h.frames || quiet)) bits.push(age > 15 ? 'hooked, but the game is not presenting frames (paused, minimised or unfocused?)' : 'waiting for the first frame');
      else if (sess.summary) bits.push(`${fmt.fps(sess.summary.fps)} measured fps`);
      else bits.push('hooked');
      if (sess.applied) {
        const a = sess.applied;
        const done = [];
        if (a.priority) done.push('high priority');
        if (a.affinity && a.affinity.applied) done.push(`pinned (${a.affinity.mode})`);
        if (a.refresh && a.refresh.changed) done.push(`${a.refresh.to} Hz`);
        if (a.power && a.power.to && a.power.from !== a.power.to) done.push('performance plan');
        if (done.length) bits.push(done.join(', '));
      }
      text = bits.join(' · ');
      cls = cls || 'is-live';
    } else if (state.last) {
      const s = state.last.summary;
      text = `${state.last.name || 'Last game'} exited` + (s ? ` — last seen at ${fmt.fps(s.fps)} fps, ${fmt.ms(s.gpuLatMs)} GPU latency` : '');
    } else if (!p.enabled) {
      text = 'Tuning mode is off. Turn it on, then start a game to see it measured here.';
    } else {
      const av = state.machine && state.machine.available;
      if (av && (!av.dll || !av.injector)) { text = 'The in-game DLL or its injector is missing from deps/librarian; nothing can be tuned inside a game.'; cls = 'is-warn'; }
      else text = 'Ready. Start a game and its frames will appear here.';
    }
    el.status.textContent = text;
    el.status.className = `tn-status ${cls}`.trim();
    el.abRun.disabled = !(sess && sess.running && !sess.stale && sess.header && sess.header.frames > 0) || state.abRunning;
    el.abNote.textContent = sess && sess.running
      ? 'Both phases run on the game now playing, back to back: first with everything inside the game off, then with your profile.'
      : 'Start a game with Tuning mode on, then run the test: one phase with everything inside the game switched off, one with your profile, back to back on the same scene.';
  }

  function paintLive(sess) {
    const s = sess && !sess.stale && sess.summary;
    const h = sess && sess.header;
    el.liveApi.textContent = h ? `${h.api}${h.canQueue ? '' : ' · no queue cap'}${h.hooks & 4 ? ' · D3D12 queue hooked' : ''}` : '';
    if (!s) {
      for (const k of ['mFps', 'mLow1', 'mFrame', 'mLat', 'mPresent', 'mWaits']) el[k].textContent = '—';
      el.mFrameSub.textContent = 'p99 —';
      el.mFpsSub.textContent = sess?.stale ? 'No new measurements for at least 2 seconds' : 'Waiting for frame measurements';
      el.mLow1Sub.textContent = 'no current sample';
      el.mPresentSub.textContent = 'no current sample';
      el.mWaitsSub.textContent = 'no current sample';
      el.mLatSub.textContent = 'Present → frame rendered';
      el.applied.textContent = '';
      return;
    }
    el.mFps.textContent = fmt.fps(s.fps);
    el.mFpsSub.textContent = `${s.count} Present calls over ${s.seconds.toFixed(1)} s`;
    el.mLow1.textContent = fmt.fps(s.low1Fps);
    el.mLow1Sub.textContent = 'the slow frames, as a rate';
    el.mFrame.textContent = fmt.ms(s.avgMs, 2);
    el.mFrameSub.textContent = `p99 ${fmt.ms(s.p99Ms, 2)}${s.stalls ? ` · ${s.stalls} hitch${s.stalls > 1 ? 'es' : ''} over 100 ms` : ''}`;
    if (s.gpuLatMs === null || s.gpuLatMs === undefined) {
      el.mLat.textContent = '—';
      el.mLatSub.textContent = h && !h.canQueue ? 'needs a fence: not on this API' : 'not observed yet';
    } else {
      el.mLat.textContent = fmt.ms(s.gpuLatMs, 1);
      const frames = s.avgMs > 0 ? s.gpuLatMs / s.avgMs : 0;
      el.mLatSub.textContent = `≈ ${frames.toFixed(1)} frames${s.gpuLatUncMs !== null && s.gpuLatUncMs !== undefined ? `, ±${s.gpuLatUncMs.toFixed(2)} ms` : ''}`;
    }
    el.mPresent.textContent = fmt.ms(s.presentMs, 2);
    el.mPresentSub.textContent = s.cpuMs !== undefined ? `game work ${fmt.ms(s.cpuMs, 1)} · depth ${s.queueDepth.toFixed(1)}` : 'CPU waiting on the queue';
    el.mWaits.textContent = `${s.limiterMs.toFixed(1)} · ${s.gpuWaitMs.toFixed(1)}`;
    el.mWaitsSub.textContent = 'ms per frame: limiter · queue cap';

    const f = s.flags || 0;
    const parts = [];
    parts.push(f & 1 ? `limiter on (${sess.config && sess.config.fps ? `${Math.round(sess.config.fps)} fps` : 'auto'})` : 'limiter off');
    // Bit 8 is "just in time armed"; bit 2 beside it means it actually held
    // the game this second — which it only does when the GPU is the bottleneck.
    if (f & 8) parts.push(f & 2 ? 'just in time: engaged (GPU is the bottleneck)' : 'just in time: armed, nothing to gain right now');
    else parts.push(f & 2 ? (f & 4 ? 'queue: ultra' : 'queue: one frame') : 'queue: driver default');
    if (sess.live) parts.push('live override (test running)');
    el.applied.textContent = `In effect this second: ${parts.join(' · ')}.`;
  }

  function paintSpark() {
    const c = el.spark;
    if (!c) return;
    const w = c.clientWidth || 600;
    if (c.width !== w) c.width = w;
    const h = c.height;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const pts = state.history.slice(-120);
    if (pts.length < 2) return;
    const max = Math.max(...pts.map((p) => p.fps)) * 1.1 || 1;
    const line = getComputedStyle(c).getPropertyValue('--tn-spark').trim() || '#7C8CFF';
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = line;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = (i / (pts.length - 1)) * (w - 2) + 1;
      const y = h - 4 - (p.fps / max) * (h - 8);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    // Bands where the profile was on, so a flip is visible in the trace.
    ctx.fillStyle = 'rgba(210, 166, 92, 0.10)';
    pts.forEach((p, i) => {
      if (!(p.flags & 3)) return;
      const x0 = (i / (pts.length - 1)) * (w - 2) + 1;
      const x1 = ((i + 1) / (pts.length - 1)) * (w - 2) + 1;
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
    });
  }

  function onStats(sess) {
    if (!sess) return;
    const i = state.sessions.findIndex((s) => s.pid === sess.pid);
    if (i >= 0) state.sessions[i] = sess; else state.sessions.push(sess);
    if (sess.summary && !sess.stale) state.history.push({ fps: sess.summary.fps, flags: sess.summary.flags || 0, t: Date.now() });
    if (state.history.length > 400) state.history.splice(0, state.history.length - 400);
    if (!el.page.classList.contains('active')) return;
    paintStatus();
    paintHints();
    paintLive(currentSession());
    paintSpark();
  }

  function onSession(sess) {
    if (!sess) return;
    if (sess.running) {
      onStats(sess);
    } else {
      state.sessions = state.sessions.filter((s) => s.pid !== sess.pid);
      state.last = sess;
      if (el.page.classList.contains('active')) { paintStatus(); paintLive(currentSession() || sess); }
    }
  }

  // ── Per game ───────────────────────────────────────────────────
  function fillGames() {
    const L = app();
    const games = (L && Array.isArray(L.games)) ? L.games.filter((g) => g && g.install_path) : [];
    const sel = el.gameSelect;
    const before = sel.value;
    sel.innerHTML = '';
    if (!games.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'No installed game found yet';
      sel.appendChild(o);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    games
      .slice()
      .sort((a, b) => String(a.game_name || '').localeCompare(String(b.game_name || '')))
      .forEach((g) => {
        const o = document.createElement('option');
        o.value = L.gameKeyOf ? L.gameKeyOf(g) : '';
        o.textContent = g.game_name || o.value;
        sel.appendChild(o);
      });
    const running = currentSession();
    const want = before || (running && running.key) || sel.options[0].value;
    sel.value = [...sel.options].some((o) => o.value === want) ? want : sel.options[0].value;
    state.gameKey = sel.value;
    loadOverride();
  }

  async function loadOverride() {
    if (!state.gameKey) { segSet(el.override, 'inherit'); return; }
    try {
      const st = await api.tuningState(state.gameKey);
      segSet(el.override, st.override || 'inherit');
    } catch { segSet(el.override, 'inherit'); }
  }

  // ── Before / after ─────────────────────────────────────────────
  const AB_ROWS = [
    ['Frame rate (mean)', (s) => s.fps, (v) => fmt.fps(v), 'higher'],
    ['Frame rate (typical frame)', (s) => s.medianFps, (v) => fmt.fps(v), 'higher'],
    ['1% low', (s) => s.low1Fps, (v) => fmt.fps(v), 'higher'],
    ['Frame time', (s) => s.avgMs, (v) => fmt.ms(v, 2), 'lower'],
    ['Frame time p99', (s) => s.p99Ms, (v) => fmt.ms(v, 2), 'lower'],
    ['Hitches over 100 ms', (s) => s.stalls, (v) => Number.isFinite(v) ? String(v) : '—', 'lower'],
    ['GPU latency (Present → rendered)', (s) => s.gpuLatMs, (v) => fmt.ms(v, 1), 'lower'],
    ['Blocked in Present', (s) => s.presentMs, (v) => fmt.ms(v, 2), 'lower'],
    ['Limiter wait', (s) => s.limiterMs, (v) => fmt.ms(v, 2), 'none'],
    ['Queue cap wait', (s) => s.gpuWaitMs, (v) => fmt.ms(v, 2), 'none'],
    ['Queue depth after Present', (s) => s.queueDepth, (v) => Number.isFinite(v) ? v.toFixed(2) : '—', 'lower'],
  ];

  function paintAB(result) {
    const body = el.abBody;
    body.innerHTML = '';
    if (!result || !result.before || !result.after) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="4" class="tn-muted">${result && result.cancelled ? 'Test cancelled.' : 'No frames measured — did the game exit?'}</td>`;
      body.appendChild(tr);
      return;
    }
    for (const [label, pick, show, better] of AB_ROWS) {
      const a = pick(result.before), b = pick(result.after);
      const tr = document.createElement('tr');
      let change = '', cls = '';
      if (Number.isFinite(a) && Number.isFinite(b) && a !== null && b !== null) {
        const delta = b - a;
        const rel = a !== 0 ? (delta / Math.abs(a)) * 100 : null;
        const tiny = Math.abs(delta) < 0.2 && (rel === null || Math.abs(rel) < 2);
        if (tiny) { change = 'no change'; cls = 'is-same'; }
        else {
          // No percentage against a zero baseline: "+9 ms from nothing" is
          // the whole story.
          const pct = rel === null ? '' : ` (${rel > 0 ? '+' : '−'}${Math.abs(rel).toFixed(0)}%)`;
          change = `${delta > 0 ? '+' : '−'}${show(Math.abs(delta))}${pct}`;
          if (better !== 'none') cls = ((better === 'lower') === (delta < 0)) ? 'is-better' : 'is-worse';
        }
      }
      tr.innerHTML = `<td>${label}</td><td>${show(a)}</td><td>${show(b)}</td><td class="${cls}">${change}</td>`;
      body.appendChild(tr);
    }
    // The longest frame of each phase and who owned it, so a loading screen
    // that landed in a phase is read as what it was, not as the profile's doing.
    const owner = (w) => {
      if (!w) return '';
      const parts = [['the game\'s own work', w.cpuMs], ['blocked in Present', w.presentMs], ['the limiter', w.limiterMs], ['the queue cap', w.gpuWaitMs]];
      parts.sort((a, b) => b[1] - a[1]);
      return `${w.frameMs >= 1000 ? `${(w.frameMs / 1000).toFixed(1)} s` : `${w.frameMs.toFixed(0)} ms`} in ${parts[0][0]}`;
    };
    const wb = result.before.worst && result.before.worst[0];
    const wa = result.after.worst && result.after.worst[0];
    const info = document.createElement('tr');
    info.className = 'tn-table-foot';
    info.innerHTML = `<td colspan="4" class="tn-muted">${result.name || 'Game'} · ${result.seconds} s per phase · ${result.before.count} then ${result.after.count} frames · ${result.after.header ? result.after.header.api : ''}`
      + `${wb || wa ? `<br>Longest frame — before: ${owner(wb) || '—'}; after: ${owner(wa) || '—'}.` : ''}</td>`;
    body.appendChild(info);
  }

  function onAB(ev) {
    if (!ev) return;
    if (ev.state === 'done') {
      state.abRunning = false;
      el.abProgress.classList.add('hidden');
      el.abCancel.classList.add('hidden');
      paintStatus();
      paintAB(ev.result);
      return;
    }
    state.abRunning = true;
    el.abProgress.classList.remove('hidden');
    el.abCancel.classList.remove('hidden');
    const phaseIdx = ev.phase === 'after' ? 1 : 0;
    const frac = ev.state === 'measuring' && ev.seconds ? Math.min(1, (ev.elapsed || 0) / ev.seconds) : 0;
    el.abBarFill.style.width = `${Math.round(((phaseIdx + frac) / 2) * 100)}%`;
    el.abPhase.textContent = `${ev.phase === 'after' ? 'After — your profile' : 'Before — everything off'} · ${ev.state === 'settling' ? 'settling' : `${Math.max(0, Math.round((ev.seconds || 0) - (ev.elapsed || 0)))} s left`}`;
    paintStatus();
  }

  async function runAB() {
    const sess = currentSession();
    if (!sess || !sess.running) return;
    const seconds = Number(el.abSeconds.value) || 15;
    state.abRunning = true;
    paintStatus();
    el.abBody.innerHTML = '';
    const r = await api.tuningRunAB({ pid: sess.pid, seconds });
    if (!r || !r.success) {
      state.abRunning = false;
      el.abProgress.classList.add('hidden');
      el.abCancel.classList.add('hidden');
      paintStatus();
      app()?.toast?.(`Tuning test: ${r && r.error ? r.error : 'failed'}`, 'error');
    }
  }

  // ── Load ───────────────────────────────────────────────────────
  async function refresh() {
    try {
      const st = await api.tuningState(state.gameKey || undefined);
      state.profile = st.profile;
      state.machine = { topology: st.topology, display: st.display, available: st.available, highPerfPlan: st.highPerfPlan };
      state.sessions = st.sessions || [];
      state.last = st.last || state.last;
      state.abRunning = Boolean(st.ab);
      if (state.gameKey) segSet(el.override, st.override || 'inherit');
      state.loaded = true;
      paintProfile();
      paintStatus();
      paintLive(currentSession() || state.last);
      paintSpark();
    } catch (e) {
      el.status.textContent = `Tuning is unavailable: ${e.message}`;
      el.status.className = 'tn-status is-warn';
    }
  }

  function wire() {
    el.enabled.addEventListener('change', () => saveProfile({ enabled: el.enabled.checked }));
    segWire(el.queue, (v) => saveProfile({ queue: v }));
    el.limiter.addEventListener('change', () => saveProfile({ limiter: el.limiter.checked }));
    el.fps.addEventListener('change', () => {
      const v = Math.round(Number(el.fps.value));
      saveProfile({ fps: Number.isFinite(v) && v > 0 ? v : 0 });
    });
    el.affinity.addEventListener('change', () => saveProfile({ affinity: el.affinity.checked ? 'auto' : 'off' }));
    el.priority.addEventListener('change', () => saveProfile({ priority: el.priority.checked }));
    el.refresh.addEventListener('change', () => saveProfile({ refresh: el.refresh.checked }));
    el.power.addEventListener('change', () => saveProfile({ power: el.power.checked }));

    el.gameSelect.addEventListener('change', () => { state.gameKey = el.gameSelect.value; loadOverride(); });
    segWire(el.override, async (v) => {
      if (!state.gameKey) return;
      try { segSet(el.override, await api.tuningSetOverride(state.gameKey, v)); }
      catch (e) { app()?.toast?.(`Tuning: ${e.message}`, 'error'); }
    });

    el.abRun.addEventListener('click', runAB);
    el.abCancel.addEventListener('click', () => api.tuningCancelAB());

    api.onTuningStats?.(onStats);
    api.onTuningSession?.(onSession);
    api.onTuningAB?.(onAB);

    window.addEventListener('librarian:page', (e) => {
      if (e.detail && e.detail.page === 'tuning') { refresh(); fillGames(); }
    });
    window.addEventListener('librarian:games', () => { if (el.page.classList.contains('active')) fillGames(); });
    window.addEventListener('librarian:session', () => { if (el.page.classList.contains('active')) refresh(); });
    window.addEventListener('resize', () => { if (el.page.classList.contains('active')) paintSpark(); });

    // A reduced-motion user still gets the numbers; only the trace is skipped
    // for them when the tab is hidden, which costs nothing to keep painting.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && el.page.classList.contains('active')) refresh();
    });
  }

  wire();
  if (window.Librarian) refresh();
  else window.addEventListener('librarian:ready', () => refresh(), { once: true });

  window.LibrarianTuning = {
    refresh,
    get state() { return state; },
  };
})();
