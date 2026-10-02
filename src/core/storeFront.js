// ═══════════════════════════════════════════════════════════════════
// Librarian — store discovery
//
// The Store page could only ever answer a question you already knew how to
// ask: type a name, get that name back. This is the other half — what is
// being played right now, what is rated best, what is selling, what just came
// out, and what is on sale.
//
// Steam publishes all of it without a key, across three endpoints that do not
// agree on anything:
//
//   ISteamChartsService/GetGamesByConcurrentPlayers
//        the live top 100 by players in game — appids and counts, no names
//   /api/featuredcategories
//        top sellers, new releases, coming soon, specials — names and art
//   /api/featured
//        the large capsules Valve is promoting today
//
// The charts endpoint is the valuable one and the least usable: it returns
// nothing but numbers. Names, art and review scores come from appdetails, one
// request per game — Steam returns a bare `null` for multi-appid requests, so
// there is no batching to be had. That is why hydration is capped, pooled at
// a small concurrency, and cached for half an hour.
//
// Nothing here can fail loudly. Every source is fetched independently and a
// rail that comes back empty is dropped from the page rather than rendered as
// an error, because one dead endpoint should cost one row and not the store.
// ═══════════════════════════════════════════════════════════════════
const fetch = require('node-fetch');

const STORE = 'https://store.steampowered.com/api';
const CHARTS = 'https://api.steampowered.com/ISteamChartsService';
const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';

/** How many charting games to look up. Each one is its own request, and
 *  roughly half of any live chart is free-to-play and will be dropped, so
 *  this is sampled well above the number of rows that survive. Steam allows
 *  about 200 appdetails calls per five minutes per address; this plus the
 *  sale-rack lookups stays comfortably inside that, once every half hour. */
const CHART_SAMPLE = 40;
/** Requests in flight at once against appdetails. */
const CONCURRENCY = 6;

let cache = null;
let cachedAt = 0;
const TTL = 30 * 60 * 1000;

function normalizeAppId(appId) {
  const id = String(appId || '').trim();
  return /^\d{1,20}$/.test(id) ? id : null;
}

/** Steam prices arrive as integer cents in the store's own currency. */
function formatPrice(cents, currency) {
  if (cents === 0) return 'Free';
  if (!Number.isFinite(cents)) return '';
  const value = (cents / 100).toFixed(2);
  const symbol = { USD: '$', EUR: '€', GBP: '£' }[currency] || '';
  return symbol ? `${symbol}${value}` : `${value} ${currency || ''}`.trim();
}

/**
 * Fold one of Steam's several item shapes into ours.
 *
 * featuredcategories and featured do not agree on field names — the same game
 * is `header_image` in one and `large_capsule_image` in the other — so
 * everything downstream reads this shape and nothing else.
 */
function toItem(raw) {
  const id = normalizeAppId(raw && (raw.id ?? raw.appid));
  if (!id) return null;
  const name = String(raw.name || '').trim();
  if (!name) return null;

  return {
    id,
    name,
    header: raw.header_image || raw.large_capsule_image || `${CDN}/${id}/header.jpg`,
    capsule: `${CDN}/${id}/library_600x900.jpg`,
    discount: Number(raw.discount_percent) || 0,
    price: formatPrice(Number(raw.final_price), raw.currency),
    wasPrice: raw.discount_percent ? formatPrice(Number(raw.original_price), raw.currency) : '',
    free: Number(raw.final_price) === 0 && !Number(raw.discount_percent) && Number(raw.original_price || 0) === 0,
    score: null,     // Metacritic, on the rails that have it
    players: 0,      // in game right now, on the charts rail
    rank: 0,
  };
}

function itemsFrom(node, limit = 20) {
  const list = Array.isArray(node) ? node : (node && Array.isArray(node.items) ? node.items : []);
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const item = toItem(raw);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

async function getJson(url) {
  const res = await fetch(url, { timeout: 15000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!json) throw new Error('empty body');
  return json;
}

/**
 * Name, score and price for one app.
 *
 * One request per game, because Steam answers a comma-separated appids list
 * with a literal `null` — verified against the live endpoint, not assumed.
 */
async function lookup(appId) {
  try {
    const json = await getJson(`${STORE}/appdetails?appids=${appId}&filters=basic,metacritic,price_overview&l=english`);
    const wrapper = json[appId];
    if (!wrapper || !wrapper.success || !wrapper.data) return null;
    const d = wrapper.data;
    const price = d.price_overview || null;
    return {
      id: String(appId),
      name: String(d.name || '').trim(),
      header: d.header_image || `${CDN}/${appId}/header.jpg`,
      capsule: `${CDN}/${appId}/library_600x900.jpg`,
      score: Number.isFinite(d.metacritic?.score) ? d.metacritic.score : null,
      discount: Number(price?.discount_percent) || 0,
      price: price ? formatPrice(price.final, price.currency) : (d.is_free ? 'Free' : ''),
      wasPrice: price?.discount_percent ? formatPrice(price.initial, price.currency) : '',
      free: Boolean(d.is_free),
      players: 0,
      rank: 0,
    };
  } catch {
    return null;
  }
}

/**
 * Free-to-play games are dropped from the store.
 *
 * Librarian acquires paid games by fetching a manifest; a free game is
 * already free on Steam, so a store page for one offers nothing the Steam
 * client does not. They also dominate the live charts — the top of the
 * concurrent-players list is almost entirely free multiplayer — so leaving
 * them in filled the most valuable rail with the least useful rows.
 *
 * `is_free` from appdetails is authoritative and is what the charts are
 * filtered on. The featured lists carry only a price, and an unreleased game
 * has a price of zero without being free, so a zero price counts as free only
 * when Steam also published an original price of zero — and the coming-soon
 * rail is exempt from the test entirely.
 */
function isFree(item) {
  return item.free === true;
}

const dropFree = (items) => items.filter((item) => !isFree(item));

/** Run `task` over `list` a few at a time, in order, never rejecting. */
async function pooled(list, task, width = CONCURRENCY) {
  const out = new Array(list.length).fill(null);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(width, list.length) }, async () => {
    while (cursor < list.length) {
      const i = cursor++;
      out[i] = await task(list[i], i).catch(() => null);
    }
  });
  await Promise.all(workers);
  return out;
}

/** The live top, hydrated into real items. */
async function chartItems() {
  let ranks = [];
  try {
    const json = await getJson(`${CHARTS}/GetGamesByConcurrentPlayers/v1/`);
    ranks = Array.isArray(json?.response?.ranks) ? json.response.ranks : [];
  } catch {
    return [];
  }
  if (!ranks.length) return [];

  const top = ranks.slice(0, CHART_SAMPLE);
  const looked = await pooled(top, (row) => lookup(String(row.appid)));

  return looked
    .map((item, i) => (item && item.name ? {
      ...item,
      players: Number(top[i].concurrent_in_game) || 0,
      rank: Number(top[i].rank) || i + 1,
    } : null))
    .filter(Boolean);
}

/**
 * The whole front page in one call.
 *
 * Rails are ordered by how much they reward a glance: what people are in
 * right now, then what is worth playing, then what is worth buying.
 */
async function getStoreFront({ cc = 'us', lang = 'english' } = {}) {
  if (cache && Date.now() - cachedAt < TTL) return cache;

  const [categories, featured, charts] = await Promise.all([
    getJson(`${STORE}/featuredcategories?cc=${encodeURIComponent(cc)}&l=${encodeURIComponent(lang)}`).catch(() => null),
    getJson(`${STORE}/featured?cc=${encodeURIComponent(cc)}&l=${encodeURIComponent(lang)}`).catch(() => null),
    chartItems(),
  ]);

  // Free-to-play is filtered out of everything except Coming soon, where a
  // zero price means "not on sale yet" rather than "free".
  const topSellers = dropFree(itemsFrom(categories?.top_sellers, 20));
  const newReleases = dropFree(itemsFrom(categories?.new_releases, 20));
  const comingSoon = itemsFrom(categories?.coming_soon, 20);
  const specials = dropFree(itemsFrom(categories?.specials, 20));
  const playing = dropFree(charts);

  // Best reviewed is pooled from the two lists that actually carry scores.
  // Measured against the live endpoints: the day's top sellers were six
  // unreleased titles and not one had a Metacritic entry, and half the live
  // charts are free multiplayer games that were never reviewed either. What
  // is left — established games, and games old enough to be discounted — is
  // where the scores live, so the pool is the charts plus the sale rack.
  const saleScores = await pooled(specials.slice(0, 12), (item) => lookup(item.id));
  const ratedPool = [...playing, ...saleScores.filter(Boolean)];
  const ratedSeen = new Set();
  const rated = ratedPool
    .filter((item) => {
      if (!Number.isFinite(item.score) || ratedSeen.has(item.id)) return false;
      ratedSeen.add(item.id);
      return true;
    })
    .sort((a, z) => z.score - a.score);

  const spotlightSource = dropFree(itemsFrom(featured?.large_capsules, 8));
  const spotlight = spotlightSource.length ? spotlightSource
    : (playing.length ? playing.slice(0, 6) : topSellers.slice(0, 6));

  const rails = [
    { id: 'playing', title: 'Played right now', sub: 'Live from Steam, by players in game', items: playing, kind: 'players' },
    { id: 'rated', title: 'Best reviewed', sub: 'Metacritic, highest first', items: rated, kind: 'score' },
    { id: 'top', title: 'Top sellers', sub: 'What everyone is buying today', items: topSellers, kind: 'price' },
    { id: 'new', title: 'New releases', sub: 'Out in the last few days', items: newReleases, kind: 'price' },
    { id: 'specials', title: 'On sale', sub: 'Discounted this week', items: specials, kind: 'price' },
    { id: 'soon', title: 'Coming soon', sub: 'Not out yet', items: comingSoon, kind: 'price' },
  ].filter((rail) => rail.items.length > 0);

  const result = {
    ok: rails.length > 0,
    rails,
    spotlight,
    error: rails.length ? '' : 'Steam did not answer. Check your connection.',
  };

  // Only a page with something on it is worth remembering for half an hour.
  if (result.ok) { cache = result; cachedAt = Date.now(); }
  return result;
}

module.exports = { getStoreFront };
