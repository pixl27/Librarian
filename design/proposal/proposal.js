// Static mock-up of the proposed Librarian UI. One screen per ?s= value.
const screen = new URLSearchParams(location.search).get('s') || 'home';

const IC = {
  home: '<path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z"/>',
  library: '<path d="M5 4v16M10 4v16M14.5 5.5l4 14"/>',
  store: '<path d="M4 8h16l-1.5 11h-13zM8.5 8V6.5a3.5 3.5 0 0 1 7 0V8"/>',
  down: '<path d="M12 4v11M7.5 11l4.5 4.5 4.5-4.5M5 20h14"/>',
  tools: '<path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L4 17v3h3l5.2-5.2a4 4 0 0 0 5.3-5.3L15 12l-3-3z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  play: '<path d="M7 4.5v15l13-7.5z"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.600-7 10-7 10z"/>',
  back: '<path d="M14 6l-6 6 6 6"/>',
  folder: '<path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  check: '<path d="M5 12.5l4.500 4.500L19 7.500"/>',
  shield: '<path d="M12 3l7 3v6c0 4.500-3 7.500-7 9-4-1.500-7-4.500-7-9V6z"/>',
  trash: '<path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"/>',
  swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  sort: '<path d="M6 5v14M3 16l3 3 3-3M13 7h8M13 12h6M13 17h4"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.500"/><rect x="13" y="4" width="7" height="7" rx="1.500"/><rect x="4" y="13" width="7" height="7" rx="1.500"/><rect x="13" y="13" width="7" height="7" rx="1.500"/>',
  grip: '<circle cx="9" cy="7" r="1"/><circle cx="15" cy="7" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="17" r="1"/><circle cx="15" cy="17" r="1"/>',
  globe: '<circle cx="12" cy="12" r="8.500"/><path d="M3.500 12h17M12 3.500c3 3 3 14 0 17M12 3.500c-3 3-3 14 0 17"/>',
};
const ic = (name) => `<svg class="ic" viewBox="0 0 24 24">${IC[name]}</svg>`;

const G = {
  crimson: { id: 3321460, name: 'Crimson Desert Enhanced', size: '147.1 GB', played: '14 min', last: 'Yesterday', tint: '#e0a25a' },
  shell: { id: 2584270, name: 'Mortal Shell II', size: '68.1 GB', played: '13 h 57 min', last: '3 days ago', tint: '#7fb7c9' },
  control: { id: 3669870, name: 'CONTROL Resonant', size: '106.7 GB', played: 'Not played yet', last: '', tint: '#ef6a5b' },
  peak: { id: 3527290, name: 'PEAK', size: '4.9 GB', played: '2 h 17 min', last: '2 weeks ago', tint: '#f2c14e' },
  ultra: { id: 1229490, name: 'ULTRAKILL', size: '3.6 GB', played: '35 min', last: '6 days ago', tint: '#ff5a4f' },
  walk: { id: 1478500, name: 'Big Walk', size: '2.4 GB', played: '6 min', last: 'Last week', tint: '#8fd16a' },
  meccha: { id: 4704690, name: 'MECCHA CHAMELEON', size: '3.3 GB', played: '14 min', last: 'A month ago', tint: '#9be36b' },
  oni: { id: 2638890, name: 'Onimusha: Way of the Sword', size: '55.8 GB', played: 'Not played yet', last: '', tint: '#d9574a' },
  replaced: { id: 1663850, name: 'REPLACED', size: '4.9 GB', played: 'Not played yet', last: '', tint: '#f08a4b' },
  spire: { id: 2868840, name: 'Slay the Spire 2', size: '2.7 GB', played: 'Not played yet', last: '', tint: '#e2b34a' },
  sinking: { id: 2825860, name: 'The Sinking City 2', size: '48.6 GB', played: 'Not played yet', last: '', tint: '#6fb8a8' },
  valheim: { id: 892970, name: 'Valheim', size: '4.2 GB', played: 'Not played yet', last: '', tint: '#7fb2e5' },
};
const art = (g, kind) => `art/${g.id}_${kind}.${kind === 'l' ? 'png' : 'jpg'}`;

// A plausible throughput trace: same seed, same picture, every reload.
function trace(n, seed, base, swing) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = [];
  let v = base * 0.3;
  for (let i = 0; i < n; i++) {
    const ramp = Math.min(1, i / 14);
    const dip = (i > 58 && i < 66) ? 0.55 : 1;
    v = v * 0.72 + (base * ramp * dip + (rnd() - 0.5) * swing) * 0.28;
    out.push(Math.max(0.4, v));
  }
  return out;
}
function pathOf(values, w, h, max, close) {
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, h - (v / max) * h]);
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const cx = (x0 + x1) / 2;
    d += ` C${cx.toFixed(1)},${y0.toFixed(1)} ${cx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return close ? `${d} L${w},${h} L0,${h} Z` : d;
}

function side(active) {
  const item = (key, icon, label, extra = '') =>
    `<a href="?s=${key}" class="${active === key ? 'on' : ''}">${ic(icon)}<span>${label}</span>${extra}</a>`;
  return `
  <aside class="side">
    <div class="brand"><div class="brand-mark"><span></span><span></span><span></span></div><div class="brand-name">Librarian</div></div>
    <nav class="nav">
      ${item('home', 'home', 'Home')}
      ${item('library', 'library', 'Library', '<span class="count">12</span>')}
      ${item('store', 'store', 'Store')}
      ${item('downloads', 'down', 'Downloads', '<span class="dot"></span>')}
      ${item('tools', 'tools', 'Tools')}
    </nav>
    <div class="side-gap"></div>
    <div class="disk">
      <div class="disk-top"><span>Games drive (E:)</span><b>214 GB free</b></div>
      <div class="disk-bar"><i class="games" style="width:49%"></i><i class="other" style="width:28%"></i></div>
      <div class="disk-note">452 GB of games on a 931 GB drive</div>
    </div>
    <nav class="nav" style="margin-top:10px">
      ${item('bigpicture', 'tv', 'Big Picture')}
      ${item('settings', 'gear', 'Settings')}
    </nav>
  </aside>`;
}

function topbar(lead = '') {
  return `
  <div class="top">
    ${lead}
    <div class="find">${ic('search')}<span>Search games, settings, actions</span><kbd>Ctrl K</kbd></div>
    <div class="grow"></div>
    <button class="chip-btn">${ic('swap')}2 updates</button>
  </div>`;
}

function dock() {
  const g = G.sinking;
  const net = trace(40, 77, 9.4, 5);
  return `
  <footer class="dock">
    <div class="dock-progress"><i style="width:62%"></i></div>
    <img src="${art(g, 'c')}" alt="">
    <div><h5>${g.name}</h5><p>Downloading, 14 min left</p></div>
    <svg class="spark" viewBox="0 0 150 34" preserveAspectRatio="none">
      <path d="${pathOf(net, 150, 32, 14, true)}" fill="var(--accent)" opacity=".18"/>
      <path d="${pathOf(net, 150, 32, 14, false)}" fill="none" stroke="var(--accent)" stroke-width="1.800"/>
    </svg>
    <div class="num"><b>9.4 MB/s</b><span>62% of 45.9 GB</span></div>
    <button class="ctl">${ic('pause')}</button>
    <div class="grow"></div>
    <div class="idle">${ic('play')}<span>No game running</span></div>
  </footer>`;
}

function dockIdle() {
  return `<footer class="dock"><div class="idle" style="border:0;padding-left:8px">${ic('play')}<span>No game running</span></div><div class="grow"></div><span class="idle" style="border:0">Drop a game ZIP anywhere to add it to the queue</span></footer>`;
}

// ── Screens ──────────────────────────────────────────────

function home() {
  const g = G.crimson;
  const recent = [G.shell, G.ultra, G.peak, G.walk];
  return {
    tint: g.tint,
    html: `
    <div class="hero-art" style="background-image:url(${art(g, 'h')})"></div>
    <div class="scroll">
      ${topbar()}
      <section class="hero">
        <div>
          <h1>Crimson Desert</h1><p class="by">Enhanced edition, open-world action adventure</p>
          <div class="hero-facts">
            <div><b>${g.played}</b><span>played</span></div>
            <div><b>${g.last}</b><span>last session</span></div>
            <div><b>Up to date</b><span>checked an hour ago</span></div>
          </div>
          <div class="hero-actions">
            <button class="btn play">${ic('play')}Play</button>
            <button class="btn">Game page</button>
            <button class="btn sq">${ic('more')}</button>
          </div>
        </div>
        <aside class="notice">
          <div class="notice-head">
            <img src="${art(G.control, 'c')}" alt="">
            <div><h4>${G.control.name}</h4><p>Update available</p></div>
          </div>
          <div class="split"><i class="kept" style="width:91%"></i><i class="fetch" style="width:9%"></i></div>
          <div class="split-key"><span><b>104.6 GB</b> already on disk</span><span><b>2.1 GB</b> to download</span></div>
          <button class="btn tint">Update now</button>
        </aside>
      </section>

      <div class="section-head"><h2>Jump back in</h2><a href="?s=library">Whole library</a></div>
      <div class="row">
        ${recent.map(r => `
        <article class="wide">
          <img src="${art(r, 'c')}" alt="">
          <div class="wide-body">
            <div style="min-width:0"><h3>${r.name}</h3><p>${r.played}, ${r.last.toLowerCase()}</p></div>
            <button class="go">${ic('play')}</button>
          </div>
        </article>`).join('')}
      </div>
    </div>`,
  };
}

function library() {
  const order = ['walk', 'control', 'crimson', 'meccha', 'shell', 'oni', 'peak', 'replaced', 'spire', 'sinking', 'ultra', 'valheim'];
  const extra = {
    control: '<span class="tag update">Update, 2.1 GB</span>',
    peak: `<span class="tag online">${ic('globe')}Online</span>`,
    walk: `<span class="tag online">${ic('globe')}Online</span>`,
  };
  const card = (key) => {
    const g = G[key];
    if (key === 'sinking') {
      return `<article class="card busy">
        <div class="cover"><img src="${art(g, 'p')}" alt="">
          <div class="ring"><svg viewBox="0 0 80 80"><circle class="track" cx="40" cy="40" r="34"/><circle class="fill" cx="40" cy="40" r="34" stroke-dasharray="${(2 * Math.PI * 34 * 0.62).toFixed(1)} 400"/></svg><b>62%</b></div>
        </div>
        <h3>${g.name}</h3><p><span>Downloading</span><span>14 min left</span></p></article>`;
    }
    if (key === 'shell') {
      return `<article class="card hover" style="--accent:${g.tint}">
        <div class="cover"><img src="${art(g, 'p')}" alt="">
          <div class="quick"><button class="btn play">${ic('play')}Play</button><button class="btn sq">${ic('heart')}</button><button class="btn sq">${ic('more')}</button></div>
        </div>
        <h3>${g.name}</h3><p><span>${g.played}</span><span>${g.size}</span></p></article>`;
    }
    return `<article class="card">
      <div class="cover"><img src="${art(g, 'p')}" alt="">${extra[key] || ''}</div>
      <h3>${g.name}</h3><p><span>${g.played}</span><span>${g.size}</span></p></article>`;
  };
  return {
    tint: '#7c8cff',
    html: `
    <div class="scroll">
      ${topbar()}
      <div class="page-head"><h1>Library</h1><span class="sum">12 games, 452 GB installed</span></div>
      <div class="tools">
        <div class="seg">
          <button class="on">All <em>12</em></button>
          <button>Recently played <em>6</em></button>
          <button>Favourites <em>3</em></button>
          <button><span class="pip"></span>Updates <em>2</em></button>
          <button>Never played <em>6</em></button>
        </div>
        <div class="grow"></div>
        <button class="chip-btn">${ic('sort')}Name</button>
        <button class="chip-btn">${ic('grid')}Covers</button>
        <button class="btn small tint">Add a game</button>
      </div>
      <div class="grid">${order.map(card).join('')}</div>
    </div>`,
  };
}

function game() {
  const g = G.shell;
  const weeks = [[0, 'Aug 25'], [22, 'Sep 1'], [0, 'Sep 8'], [48, 'Sep 15'], [100, 'Sep 22'], [64, 'Sep 29']];
  const feats = [
    ['First Shell', 'Inhabit a fallen warrior', '3 days ago', '12% 30%'],
    ['Hardened', 'Harden to block 50 blows', '3 days ago', '70% 20%'],
    ['Nektar Thief', 'Reclaim a stolen gland', 'Last week', '85% 60%'],
    ['The Long Dark', 'Reach the Undermist', 'Last week', '40% 75%'],
    ['Stonebreaker', 'Shatter a hardened foe', '2 weeks ago', '62% 12%'],
    ['Old Friends', 'Find Sester Genessa', '2 weeks ago', '30% 55%'],
  ];
  const locked = [['Unbroken', 'Finish a boss without hardening', '55% 45%'], ['Collector', 'Find every shell', '20% 80%']];
  const R = 2 * Math.PI * 30;
  return {
    tint: g.tint,
    html: `
    <div class="game-art" style="background-image:url(${art(g, 'h')})"></div>
    <div class="scroll">
      ${topbar(`<a class="chip-btn crumb" href="?s=library">${ic('back')}Library</a>`)}
      <header class="game-head">
        <h1>${g.name}</h1>
        <p class="by">Cold Symmetry, action RPG, released 2026</p>
      </header>
      <div class="game-bar">
        <button class="btn play">${ic('play')}Play</button>
        <div class="stat"><b>${g.played}</b><span>played over 35 sessions</span></div>
        <div class="stat"><b>${g.last}</b><span>last session, 1 h 12 min</span></div>
        <div class="stat"><b>14 of 38</b><span>achievements</span></div>
        <div class="grow"></div>
        <button class="btn sq">${ic('heart')}</button>
        <button class="btn sq">${ic('folder')}</button>
        <button class="btn sq">${ic('more')}</button>
      </div>
      <nav class="tabs"><a class="on">Overview</a><a>Achievements <em>14/38</em></a><a>Media</a><a>News and patches</a><a>Add-ons <em>2</em></a><a>Files and versions</a><a>Launch options</a></nav>
      <div class="cols">
        <div class="stack">
          <div class="panel ach">
            <h4>Achievements<a class="more">See all 38</a></h4>
            <div class="ach-body">
              <div class="ach-ring">
                <svg viewBox="0 0 72 72"><circle class="track" cx="36" cy="36" r="30"/><circle class="fill" cx="36" cy="36" r="30" stroke-dasharray="${(R * 14 / 38).toFixed(1)} 400"/></svg>
                <b>37<small>%</small></b>
              </div>
              <div class="ach-list">
                ${feats.map(([t, d, when, pos]) => `<div class="feat"><i style="background-image:url(${art(g, 'h')});background-position:${pos}"></i><div><h5>${t}</h5><p>${d}</p></div><time>${when}</time></div>`).join('')}
              </div>
              <div class="ach-next">
                <h6>Closest to unlocking</h6>
                ${locked.map(([t, d, pos]) => `<div class="feat locked"><i style="background-image:url(${art(g, 'h')});background-position:${pos}"></i><div><h5>${t}</h5><p>${d}</p></div></div>`).join('')}
                <div class="toggle" style="margin-top:12px;padding-top:12px"><div>In-game pop-ups<p>Show a toast when one unlocks</p></div><span class="switch on"></span></div>
              </div>
            </div>
          </div>
          <div class="pair">
            <div class="panel">
              <h4>Your last six weeks</h4>
              <div class="weeks">
                ${weeks.map(([v, label], i) => `<div class="${i === weeks.length - 1 ? 'cur' : ''}"><i style="height:${Math.max(4, v * 1.15)}px"></i><span>${label}</span></div>`).join('')}
              </div>
            </div>
            <div class="panel">
              <h4>About</h4>
              <p class="about">A ruthless action RPG where you inhabit the shells of fallen warriors. Explore a shattered world, harden to stone mid-swing, and take back what the Nektar stole.</p>
              <div class="chips"><span>Single-player</span><span>Souls-like</span><span>Controller</span><span>DLSS frame generation</span></div>
            </div>
          </div>
          <div class="panel">
            <h4>Latest patch<a class="more">All news</a></h4>
            <div class="patch"><b>1.0.4</b><div><h5>Stability and balance</h5><p>Fixes the crash when leaving the Undermist, rebalances the halberd, and adds an option to disable motion blur.</p></div><time>23 September</time></div>
          </div>
        </div>
        <div class="stack">
          <div class="panel online">
            <h4>${ic('globe')}Online mode<span class="switch on"></span></h4>
            <p class="lead">Play with friends through Steam lobbies. Your Steam client must be running.</p>
            <dl class="kv">
              <dt>Status</dt><dd class="good">Ready, signed in as One</dd>
              <dt>Friends can join</dt><dd>By invite or lobby code</dd>
            </dl>
            <div class="acts"><button class="btn tint">${ic('swap')}Invite a friend</button><button class="btn">How it works</button></div>
          </div>
          <div class="panel">
            <h4>${ic('check')}Installed<span class="state">Up to date</span></h4>
            <dl class="kv">
              <dt>Size on disk</dt><dd>${g.size}</dd>
              <dt>Location</dt><dd>E:\\Games\\steam\\steamapps\\common</dd>
              <dt>Version</dt><dd>Patch 1.0.4, 23 September</dd>
            </dl>
            <div class="acts">
              <button class="btn">${ic('shield')}Verify files</button>
              <button class="btn">${ic('swap')}Check for update</button>
              <button class="btn">${ic('folder')}Move</button>
              <button class="btn">${ic('trash')}Uninstall</button>
            </div>
          </div>
          <div class="panel">
            <h4>${ic('shield')}Steam emulator<span class="state">Working</span></h4>
            <dl class="kv">
              <dt>Emulator</dt><dd>Goldberg, 28 September build</dd>
              <dt>Matches this game version</dt><dd>Yes, 14 of 14 interfaces</dd>
              <dt>Frame generation</dt><dd>DLSS 4 enabled</dd>
            </dl>
          </div>
        </div>
      </div>
    </div>`,
  };
}

function downloads() {
  const g = G.sinking;
  const net = trace(120, 4242, 9.4, 6);
  const disk = trace(120, 99, 10.6, 9);
  const W = 1000, H = 120, MAX = 16;
  const steps = [['Preparing', 'done'], ['Downloading', 'live'], ['Checking files', ''], ['Setting up to play', '']];
  return {
    tint: g.tint,
    html: `
    <div class="focus-bg" style="background-image:url(${art(g, 'h')})"></div>
    <div class="scroll">
      ${topbar()}
      <section class="focus">
        <div class="poster">
          <div class="poster-frame">
            <img class="dim" src="${art(g, 'p')}" alt="">
            <img class="lit" src="${art(g, 'p')}" alt="" style="clip-path:inset(38% 0 0 0)">
            <div class="waterline" style="top:38%"></div>
            <div class="sheen"></div>
          </div>
          <div class="plinth"></div>
        </div>

        <div class="focus-main">
          <div class="kicker"><span class="pulse"></span>Downloading<span class="where">${ic('folder')}E:\\Games\\steam\\steamapps\\common\\The Sinking City 2</span></div>
          <h1>${g.name}</h1>

          <div class="readout">
            <div class="bigpct">62<small>%</small></div>
            <div class="chart">
              <span class="peak">Last 2 minutes, peak 13.1 MB/s</span>
              <div class="legend"><span><i></i>Network</span><span class="dsk"><i></i>Disk</span></div>
              <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
                <defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".45"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
                <g stroke="rgba(190,200,255,.08)" stroke-width="1"><path d="M0 ${H * 0.33}H${W}M0 ${H * 0.66}H${W}"/></g>
                <path d="${pathOf(net, W, H, MAX, true)}" fill="url(#fade)"/>
                <path d="${pathOf(disk, W, H, MAX, false)}" fill="none" stroke="#7b84ab" stroke-width="1.500" stroke-dasharray="3 5" vector-effect="non-scaling-stroke"/>
                <path d="${pathOf(net, W, H, MAX, false)}" fill="none" stroke="var(--accent)" stroke-width="2.200" vector-effect="non-scaling-stroke"/>
              </svg>
            </div>
          </div>

          <div class="track"><i style="width:62%"></i></div>
          <div class="steps">${steps.map(([label, state]) => `<span class="${state}">${state === 'done' ? ic('check') : '<em></em>'}${label}</span>`).join('')}</div>

          <div class="fstats">
            <div><b>28.4 <small>/ 45.9 GB</small></b><span>Downloaded</span></div>
            <div><b>9.4 <small>MB/s</small></b><span>Download</span></div>
            <div><b>10.6 <small>MB/s</small></b><span>To disk</span></div>
            <div><b>14 <small>min</small></b><span>Remaining</span></div>
            <div><b>21:08</b><span>Elapsed</span></div>
          </div>

          <div class="focus-actions">
            <button class="btn play">${ic('pause')}Pause</button>
            <button class="btn">Cancel</button>
            <button class="btn">Show log</button>
            <div class="grow"></div>
            <span class="wire">24 connections on 3 servers, 31,204 pieces checked, none damaged</span>
          </div>

          <div class="upnext">
            <h6>Up next</h6>
            <div class="q"><span class="grip">${ic('grip')}</span><img src="${art(G.control, 'c')}" alt="">
              <div class="grow"><h3>${G.control.name}</h3><p>104.6 GB already on disk stays in place</p></div>
              <span class="kind update">Update</span>
              <div class="size"><b>2.1 GB</b><span>about 4 min</span></div>
              <button class="btn sq small">${ic('more')}</button></div>
            <div class="q"><span class="grip">${ic('grip')}</span><img src="${art(G.valheim, 'c')}" alt="">
              <div class="grow"><h3>${G.valheim.name}</h3><p>Online mode is kept after the update</p></div>
              <span class="kind update">Update</span>
              <div class="size"><b>310 MB</b><span>under a minute</span></div>
              <button class="btn sq small">${ic('more')}</button></div>
          </div>
        </div>
      </section>
    </div>`,
  };
}

const screens = { home, library, game, downloads };
const built = (screens[screen] || home)();
document.documentElement.style.setProperty('--accent', built.tint);
document.getElementById('app').innerHTML = `
  ${side(screen === 'game' ? 'library' : screen)}
  <div class="main"><div class="view">${built.html}</div>${screen === 'downloads' ? dockIdle() : dock()}</div>`;
