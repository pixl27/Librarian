// ─── Steam news / patch notes ────────────────────────────────────
//
// Steam publishes per-app announcements through ISteamNews. Most developers tag
// their changelog posts `patchnotes`, so the same feed gives both "what's new"
// and a usable patch history.
//
// Bodies come back as BBCode (sometimes with raw HTML mixed in) written by third
// parties. Everything is flattened to plain text here and the renderer escapes it
// on the way out, so nothing from the feed is ever parsed as markup.
const fetch = require('node-fetch');

const NEWS_URL = 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/';
const CACHE_TTL = 6 * 60 * 60 * 1000;   // announcements are not time-critical
const MAX_BODY = 4000;

const cache = new Map();
const inFlight = new Map();

function normalizeAppId(appId) {
  const id = String(appId || '').trim();
  return /^\d{1,20}$/.test(id) && id !== '0' ? id : null;
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–');
}

/** Flatten Steam's BBCode-plus-HTML soup into readable plain text. */
function toPlainText(raw) {
  let text = String(raw || '');

  // Block-level HTML becomes line breaks before tags are stripped. Both the
  // opening and closing tag break the line — otherwise "Two<p>Three</p>" runs
  // the two together, since only the closing tag would have matched.
  text = text
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<\s*\/?\s*(p|div|h[1-6]|tr|ul|ol|section|blockquote)[^>]*>/gi, '\n')
    .replace(/<\s*\/\s*li\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  // Media and embeds carry nothing useful once flattened.
  text = text
    .replace(/\[img\][\s\S]*?\[\/img\]/gi, '')
    .replace(/\[previewyoutube[^\]]*\][\s\S]*?\[\/previewyoutube\]/gi, '')
    .replace(/\[video[^\]]*\][\s\S]*?\[\/video\]/gi, '');

  // Headings get their own line so sections stay legible.
  text = text
    .replace(/\[h[1-6]\]\s*([\s\S]*?)\s*\[\/h[1-6]\]/gi, (_, inner) => `\n${inner.trim()}\n`)
    .replace(/\[\/?list[^\]]*\]/gi, '\n')
    .replace(/\[\*\]\s*/g, '\n• ')
    // The newer editor closes its list items and wraps text in paragraphs.
    .replace(/\[\/\*\]/g, '')
    .replace(/\[\/p\]/gi, '\n')
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[quote[^\]]*\]([\s\S]*?)\[\/quote\]/gi, '$1')
    // Any remaining simple tag pair or standalone tag.
    .replace(/\[\/?[a-z][^\]]*\]/gi, '');

  text = decodeEntities(text)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    // Consecutive list items sit on consecutive lines.
    .replace(/^(• [^\n]*)\n+(?=• )/gm, '$1\n')
    .replace(/^\s+|\s+$/g, '');

  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY).trimEnd()}…` : text;
}

async function fetchNews(appId, count) {
  const url = `${NEWS_URL}?appid=${appId}&count=${count}&maxlength=0&format=json`;
  const res = await fetch(url, { timeout: 12000 });
  if (!res.ok) throw new Error(`Steam news returned ${res.status}`);
  const json = await res.json();
  const items = json?.appnews?.newsitems;
  if (!Array.isArray(items)) return [];

  return items.map((item) => {
    const tags = Array.isArray(item.tags) ? item.tags.map(t => String(t).toLowerCase()) : [];
    return {
      id: String(item.gid || ''),
      title: String(item.title || 'Untitled').trim(),
      url: typeof item.url === 'string' && /^https?:\/\//.test(item.url) ? item.url : '',
      author: String(item.author || '').trim(),
      source: String(item.feedlabel || '').trim(),
      date: (Number(item.date) || 0) * 1000,
      isPatch: tags.includes('patchnotes'),
      body: toPlainText(item.contents),
    };
  }).filter(item => item.title || item.body);
}

/**
 * Recent announcements for an app, newest first, with patch-note posts flagged.
 * @returns {Promise<{items: Array, error: string|null}>}
 */
async function getPatchNotes(appId, count = 15) {
  const id = normalizeAppId(appId);
  if (!id) return { items: [], error: null };

  const hit = cache.get(id);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return { items: hit.items, error: hit.error };
  if (inFlight.has(id)) return inFlight.get(id);

  const task = (async () => {
    let result;
    try {
      const items = await fetchNews(id, Math.max(1, Math.min(30, count)));
      items.sort((a, b) => b.date - a.date);
      result = { items, error: null };
    } catch (err) {
      result = { items: [], error: err.message };
    }
    // Cache failures too, briefly, so a dead network doesn't retry per keystroke.
    cache.set(id, { ...result, ts: result.error ? Date.now() - CACHE_TTL + 60000 : Date.now() });
    return result;
  })().finally(() => inFlight.delete(id));

  inFlight.set(id, task);
  return task;
}

module.exports = { getPatchNotes, toPlainText };
