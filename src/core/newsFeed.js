/**
 * What's new.
 *
 * Two things a library built around Denuvo titles wants to hear about, and
 * neither arrives by itself:
 *
 *   · a Denuvo game that just came out on Steam — read off the store's own
 *     "new releases" and "top sellers" charts, each app checked once against
 *     its drm_notice and remembered in a small cache, because appdetails is
 *     the only place Steam says it and it is a full page per app;
 *
 *   · a post by the member Librarian follows on cs.rin.ru — the forum's
 *     "search by author" page, readable as a guest (the links inside are
 *     hidden, the words are not), which lists every release and every update
 *     to one, newest first, with the build it was made for in the snippet.
 *
 * The renderer decides what is unseen and shows it; this module only fetches
 * and parses. cs.rin.ru fronts itself with a cookie challenge (a 401 whose
 * body carries the token to echo back), solved here the way csrin-cli does.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { getStoreFront } = require('./storeFront');
const { parseBuild } = require('./csrin');
const jsonFile = require('./jsonFile');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const FORUM = 'https://cs.rin.ru';
const DENUVO_TTL = 14 * 24 * 60 * 60 * 1000;

// ─── HTTP with a cookie jar for the forum ─────────────────────────
const jar = new Map();

function fetchText(url, { headers = {}, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const cookie = u.hostname.endsWith('cs.rin.ru') ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : '';
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
    }, (res) => {
      for (const c of res.headers['set-cookie'] || []) {
        const m = /^([^=]+)=([^;]*)/.exec(c);
        if (m && u.hostname.endsWith('cs.rin.ru')) jar.set(m[1].trim(), m[2].trim());
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timed out')));
  });
}

/** The forum's JavaScript cookie challenge: a 401 whose body names the token. */
async function forumGet(url) {
  let r = await fetchText(url);
  if (r.status !== 401) return r;
  const tok = /securitytoken=([^;"]+)/.exec(r.body);
  const exp = /securitytoken_expiration=([^;"]+)/.exec(r.body);
  if (!tok || !exp) return r;
  jar.set('securitytoken', tok[1]);
  jar.set('securitytoken_expiration', exp[1]);
  try { await fetchText(`${FORUM}/securitycheck/forum/`); } catch { /* the cookies alone usually suffice */ }
  r = await fetchText(url);
  return r;
}

// ─── Parsing the forum ────────────────────────────────────────────
function decodeEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** "./viewtopic.php?f=41&amp;t=1&amp;sid=…#p2" → an absolute URL without the session id. */
function forumUrl(href) {
  const clean = decodeEntities(String(href || '')).replace(/^\.\//, '');
  if (!clean) return '';
  try {
    const u = new URL(clean, `${FORUM}/forum/`);
    u.searchParams.delete('sid');
    return u.toString();
  } catch {
    return '';
  }
}

/**
 * "[Info] Assassin's Creed Black Flag Resynced [CRACKED]" → the game and
 * the flags the forum puts around it.
 */
function cleanTopicTitle(raw) {
  const text = stripTags(raw).replace(/\s+/g, ' ').trim();
  const flags = [...text.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim()).filter(Boolean);
  const game = text.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  return { game, flags };
}

/**
 * One search-results page in "posts" mode. Each hit is a table row pair:
 * the topic line, then author / subject / date, then the snippet.
 */
function parseAuthorSearch(html) {
  const blocks = String(html || '').split(/<p class="topictitle">/).slice(1);
  const items = [];
  for (const block of blocks) {
    const idM = /<a name="p(\d+)"/.exec(block);
    const topicM = /Topic:\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!idM || !topicM) continue;
    const authorM = /class="postauthor"><a[^>]*>([^<]+)<\/a>/.exec(block) || /class="postauthor">([^<]+)</.exec(block);
    const subjectM = /Post subject:<\/b>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const dateM = /<b>Posted:<\/b>\s*([^<]+?)(?:&nbsp;)*\s*<\/div>/.exec(block) || /<b>Posted:<\/b>\s*([^<]+)/.exec(block);
    const bodyM = /<td class="postbody">([\s\S]*?)<\/td>/.exec(block);
    const topicUrl = forumUrl(topicM[1]);
    const topicIdM = /[?&]t=(\d+)/.exec(topicUrl);
    const body = stripTags(bodyM ? bodyM[1] : '');
    const { build, version } = parseBuild(body);
    const sha = /SHA-?256\s*[:=]?\s*([0-9a-f]{64})/i.exec(body);
    const { game, flags } = cleanTopicTitle(topicM[2]);
    items.push({
      id: `csrin:p${idM[1]}`,
      kind: 'csrin',
      postId: `p${idM[1]}`,
      topicId: topicIdM ? topicIdM[1] : '',
      topicUrl,
      postUrl: subjectM ? forumUrl(subjectM[1]) : (topicUrl ? `${topicUrl}#p${idM[1]}` : ''),
      topicTitle: stripTags(topicM[2]).replace(/\s+/g, ' ').trim(),
      game,
      flags,
      subject: subjectM ? stripTags(subjectM[2]).replace(/\s+/g, ' ').trim() : '',
      author: authorM ? decodeEntities(authorM[1]).trim() : '',
      date: dateM ? decodeEntities(dateM[1]).replace(/\s+/g, ' ').trim() : '',
      snippet: body.replace(/\s+/g, ' ').slice(0, 320),
      build,
      version,
      sha256: sha ? sha[1].toLowerCase() : '',
    });
  }
  return items;
}

/**
 * The member's latest posts across the whole forum, newest first.
 * @returns {{ ok: boolean, items: object[], error?: string }}
 */
async function fetchCsrinFeed(author = 'ARTIFACT', { pages = 1 } = {}) {
  const items = [];
  try {
    for (let page = 0; page < Math.max(1, Math.min(4, pages)); page++) {
      const url = `${FORUM}/forum/search.php?author=${encodeURIComponent(author)}&sr=posts&sk=t&sd=d&st=0&start=${page * 15}`;
      let r = await forumGet(url);
      if (r.status !== 200) return { ok: false, items, error: `cs.rin.ru answered ${r.status}` };
      let found = parseAuthorSearch(r.body);
      // A first page with nothing on it right after the challenge is the
      // challenge page again, not an empty result: ask once more.
      if (!found.length && page === 0 && /securitytoken|securitycheck/i.test(r.body)) {
        jar.clear();
        r = await forumGet(url);
        found = r.status === 200 ? parseAuthorSearch(r.body) : [];
      }
      if (!found.length) break;
      items.push(...found);
    }
    return { ok: true, items };
  } catch (err) {
    return { ok: false, items, error: `cs.rin.ru: ${err.message}` };
  }
}

// ─── Denuvo on Steam ──────────────────────────────────────────────
function cacheFile() {
  try {
    const { app } = require('electron');
    if (app && app.getPath) return path.join(app.getPath('userData'), 'news-cache.json');
  } catch { /* outside Electron */ }
  return path.join(require('os').tmpdir(), 'librarian-news-cache.json');
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) || { apps: {} }; } catch { return { apps: {} }; }
}

function saveCache(cache) {
  try {
    jsonFile.write(cacheFile(), cache);
  } catch { /* the cache is a courtesy */ }
}

/** One appdetails call, reduced to what the news needs. */
async function probeApp(appid) {
  const r = await fetchText(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`, { headers: { Accept: 'application/json' }, timeout: 15000 });
  if (r.status !== 200) throw new Error(`appdetails ${r.status}`);
  const json = JSON.parse(r.body);
  const d = json && json[appid] && json[appid].success ? json[appid].data : null;
  if (!d) throw new Error('no data');
  const drm = String(d.drm_notice || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    name: d.name || '',
    denuvo: /denuvo/i.test(drm),
    drm,
    header: d.header_image || '',
    date: d.release_date && d.release_date.date ? d.release_date.date : '',
    comingSoon: Boolean(d.release_date && d.release_date.coming_soon),
    price: d.is_free ? 'Free' : (d.price_overview && d.price_overview.final_formatted) || '',
    checkedAt: Date.now(),
  };
}

/**
 * Denuvo titles among what Steam is putting on its front page right now.
 * Cached per app for two weeks — the DRM line of a released game rarely
 * changes, and rechecking twenty apps on every launch would be rude.
 */
async function fetchDenuvoReleases({ limit = 24, concurrency = 3 } = {}) {
  let front;
  try { front = await getStoreFront(); } catch (err) { return { ok: false, items: [], error: `Steam: ${err.message}` }; }
  if (!front || !front.ok) return { ok: false, items: [], error: front?.error || 'Steam did not answer.' };

  const order = ['new', 'top', 'soon'];
  const seen = new Set();
  const candidates = [];
  for (const railId of order) {
    const rail = (front.rails || []).find((r) => r.id === railId);
    for (const it of rail?.items || []) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      candidates.push(it);
      if (candidates.length >= limit) break;
    }
    if (candidates.length >= limit) break;
  }

  const cache = loadCache();
  cache.apps = cache.apps || {};
  const now = Date.now();
  const stale = candidates.filter((it) => !cache.apps[it.id] || now - (cache.apps[it.id].checkedAt || 0) > DENUVO_TTL);

  let changed = false;
  const queue = [...stale];
  const worker = async () => {
    while (queue.length) {
      const it = queue.shift();
      try {
        cache.apps[it.id] = await probeApp(it.id);
        changed = true;
      } catch {
        // Not remembered as anything: the next launch tries again.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  if (changed) saveCache(cache);

  const items = candidates
    .filter((it) => cache.apps[it.id] && cache.apps[it.id].denuvo)
    .map((it) => {
      const c = cache.apps[it.id];
      return {
        id: `steam:${it.id}`,
        kind: 'denuvo',
        appid: it.id,
        name: c.name || it.name,
        header: c.header || it.header,
        date: c.date || '',
        comingSoon: Boolean(c.comingSoon),
        price: it.discount ? `${it.price} · -${it.discount}%` : (it.price || c.price || ''),
        drm: c.drm,
      };
    });
  return { ok: true, items };
}

/** Both feeds, each allowed to fail on its own. */
async function getNews({ author = 'ARTIFACT', pages = 1 } = {}) {
  const [denuvo, csrin] = await Promise.all([
    fetchDenuvoReleases().catch((err) => ({ ok: false, items: [], error: err.message })),
    fetchCsrinFeed(author, { pages }).catch((err) => ({ ok: false, items: [], error: err.message })),
  ]);
  const cache = loadCache();
  cache.feeds ||= {};
  const keep = (key, response) => {
    const result = retainFeed(response, cache.feeds[key]);
    if (response.ok) cache.feeds[key] = { items: response.items.slice(0, 100), cachedAt: Date.now() };
    return result;
  };
  const result = { checkedAt: Date.now(), author, denuvo: keep('steam', denuvo), csrin: keep(`csrin:${String(author).toLowerCase()}`, csrin) };
  cache.feeds = Object.fromEntries(Object.entries(cache.feeds).sort((a, b) => b[1].cachedAt - a[1].cachedAt).slice(0, 20));
  saveCache(cache);
  return result;
}

function retainFeed(response, previous) {
  if (response.ok || !Array.isArray(previous?.items)) return response;
  return { ...response, items: previous.items, stale: true, cachedAt: previous.cachedAt };
}

module.exports = {
  getNews,
  fetchCsrinFeed,
  fetchDenuvoReleases,
  parseAuthorSearch,
  cleanTopicTitle,
  decodeEntities,
  forumUrl,
  retainFeed,
};
