const fetch = require('node-fetch');

function normalizeAppId(appId) {
  const id = String(appId || '').trim();
  return /^\d{1,20}$/.test(id) ? id : null;
}

/**
 * Fetch full app + depot info from Steam.
 * Uses steamcmd.net API which provides depot config data (including oslist)
 * similar to SteamDB.
 */
async function getDepotInfoFromApi(appId) {
  const safeAppId = normalizeAppId(appId);
  const result = {
    installdir: null,
    header_url: null,
    buildid: null,
    platforms: [],
    depotConfigs: {},  // { depotId: { oslist, osarch, ... } }
  };

  if (!safeAppId) return result;

  // 1) Get store data (platforms, header, install dir)
  try {
    const storeUrl = `https://store.steampowered.com/api/appdetails?appids=${safeAppId}`;
    const storeRes = await fetch(storeUrl, { timeout: 15000 });
    if (storeRes.ok) {
      const storeData = await storeRes.json();
      const wrapper = storeData[safeAppId];
      if (wrapper && wrapper.success && wrapper.data) {
        const d = wrapper.data;
        result.installdir = d.install_dir || null;
        result.header_url = d.header_image || null;
        const p = d.platforms || {};
        if (p.windows) result.platforms.push('windows');
        if (p.mac) result.platforms.push('macos');
        if (p.linux) result.platforms.push('linux');
      }
    }
  } catch (e) { /* store API failed, continue */ }

  // 2) Get depot configs from steamcmd.net API (has oslist per depot)
  try {
    const cmdUrl = `https://api.steamcmd.net/v1/info/${safeAppId}`;
    const cmdRes = await fetch(cmdUrl, { timeout: 15000 });
    if (cmdRes.ok) {
      const cmdData = await cmdRes.json();
      if (cmdData.status === 'success' && cmdData.data && cmdData.data[safeAppId]) {
        const appInfo = cmdData.data[safeAppId];
        const depots = appInfo.depots || {};
        const publicBranch = depots.branches?.public || {};

        if (publicBranch.buildid) {
          result.buildid = String(publicBranch.buildid);
        }

        for (const [depotId, depotData] of Object.entries(depots)) {
          // Skip non-numeric keys (like "branches")
          if (!/^\d+$/.test(depotId)) continue;

          const config = depotData.config || {};
          const oslist = config.oslist || null;
          const osarch = config.osarch || null;

          result.depotConfigs[depotId] = {
            oslist: oslist,       // e.g. "windows", "macos", "linux"
            osarch: osarch,       // e.g. "64", "32"
            name: depotData.name || null,
            maxsize: depotData.maxsize || null,
            manifestId: String(depotData.manifests?.public?.gid || (typeof depotData.manifests?.public === 'string' ? depotData.manifests.public : '') || '') || null,
          };
        }

        // Also grab installdir from common/config if available
        if (!result.installdir && appInfo.common && appInfo.common.installdir) {
          result.installdir = appInfo.common.installdir;
        }
      }
    }
  } catch (e) { /* steamcmd API failed, continue */ }

  return result;
}

/**
 * Parse oslist string into array of OS names.
 * Steam uses comma-separated values like "windows", "macos", "linux"
 * or combined like "windows,macos"
 */
function parseOsList(oslistStr) {
  if (!oslistStr) return [];
  return oslistStr.split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .map(os => {
      // Normalize OS names
      if (os === 'windows') return 'windows';
      if (os === 'macos') return 'macos';
      if (os === 'linux') return 'linux';
      return os;
    });
}

/**
 * Format OS + architecture into a readable label.
 * e.g. "windows" + "64" → "Windows 64-bit"
 */
function formatOsLabel(os, arch) {
  const labels = {
    windows: 'Windows',
    macos: 'macOS',
    linux: 'Linux',
  };
  const base = labels[os] || os;
  if (arch) return `${base} ${arch}-bit`;
  return base;
}

function getHeaderImageUrl(appId) {
  const safeAppId = normalizeAppId(appId);
  return safeAppId ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${safeAppId}/header.jpg` : '';
}

// Steam sometimes returns plain-http CDN URLs; upgrade so they load under
// Electron's secure context.
// Movie files are addressed by the *movie* id, not the app id.
const MOVIE_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';

function forceHttps(url) {
  return typeof url === 'string' ? url.replace(/^http:\/\//i, 'https://') : '';
}

function stripHtml(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fetch rich media + storefront metadata for a game: trailers, screenshots,
 * description, genres, developer/publisher, release date and library artwork.
 * Everything is best-effort; missing fields come back empty.
 */
async function getGameMedia(appId) {
  const safeAppId = normalizeAppId(appId);
  const cdn = safeAppId ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${safeAppId}` : '';
  const result = {
    appid: safeAppId,
    name: '',
    short_description: '',
    about: '',
    genres: [],
    categories: [],
    developers: [],
    publishers: [],
    release_date: '',
    metacritic: null,
    reviews: null,
    website: '',
    header_url: cdn ? `${cdn}/header.jpg` : '',
    capsule_url: cdn ? `${cdn}/library_600x900_2x.jpg` : '',
    hero_url: cdn ? `${cdn}/library_hero.jpg` : '',
    logo_url: cdn ? `${cdn}/logo.png` : '',
    background_url: cdn ? `${cdn}/page_bg_generated_v6b.jpg` : '',
    is_free: false,
    movies: [],
    screenshots: [],
  };

  if (!safeAppId) return result;

  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${safeAppId}&l=english`;
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) return result;
    const json = await res.json();
    const wrapper = json[safeAppId];
    if (!wrapper || !wrapper.success || !wrapper.data) return result;
    const d = wrapper.data;

    result.name = d.name || '';
    result.short_description = stripHtml(d.short_description || '');
    result.about = stripHtml(d.about_the_game || d.detailed_description || '');
    result.genres = Array.isArray(d.genres) ? d.genres.map(g => g.description).filter(Boolean).slice(0, 8) : [];
    result.categories = Array.isArray(d.categories) ? d.categories.map(c => c.description).filter(Boolean).slice(0, 12) : [];
    // Free-to-play games are already yours; Online mode has nothing to spoof.
    result.is_free = !!d.is_free;
    // The store's own DRM line ("Denuvo Anti-tamper", sometimes with a
    // machine-activation limit). Denuvo is what decides whether the emulator
    // alone can run a game or a member's release from CS.RIN.RU is needed.
    result.drm_notice = String(d.drm_notice || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    result.denuvo = /denuvo/i.test(result.drm_notice);
    result.developers = Array.isArray(d.developers) ? d.developers.slice(0, 4) : [];
    result.publishers = Array.isArray(d.publishers) ? d.publishers.slice(0, 4) : [];
    result.release_date = d.release_date && d.release_date.date ? d.release_date.date : '';
    result.website = forceHttps(d.website || '');
    if (d.header_image) result.header_url = forceHttps(d.header_image);
    if (d.background_raw) result.background_url = forceHttps(d.background_raw);
    if (d.metacritic && d.metacritic.score) {
      result.metacritic = { score: d.metacritic.score, url: forceHttps(d.metacritic.url || '') };
    }

    // Steam stopped shipping the progressive `mp4` / `webm` objects in
    // appdetails: a movie entry now describes DASH and HLS manifests
    // (dash_av1 / dash_h264 / hls_h264), which a plain <video> cannot play, so
    // this mapping silently produced an empty list for every game and every
    // trailer in the app went quiet.
    //
    // The progressive files are still served from the CDN under the *movie*
    // id, so they are derived when the old fields are missing. 480p is the
    // right default — these play behind a scrim or in a small pane, and
    // movie_max.mp4 is often five times the size for no visible gain.
    if (Array.isArray(d.movies)) {
      result.movies = d.movies.slice(0, 6).map(m => {
        const base = m.id ? `${MOVIE_CDN}/${m.id}` : '';
        return {
          id: m.id,
          name: m.name || '',
          thumbnail: forceHttps(m.thumbnail || ''),
          // movie480.mp4 has existed across every era of Steam's movie
          // hosting; the vp9 webm only exists for newer entries, so it is
          // never used as the sole source.
          mp4: forceHttps((m.mp4 && (m.mp4.max || m.mp4['480'])) || '') || (base ? `${base}/movie480.mp4` : ''),
          webm: forceHttps((m.webm && (m.webm.max || m.webm['480'])) || ''),
          mp4_hd: base ? `${base}/movie_max.mp4` : '',
          dash: forceHttps(m.dash_h264 || m.dash_av1 || ''),
          hls: forceHttps(m.hls_h264 || ''),
        };
      }).filter(m => m.mp4 || m.webm);
    }

    if (Array.isArray(d.screenshots)) {
      result.screenshots = d.screenshots.slice(0, 14).map(s => ({
        thumbnail: forceHttps(s.path_thumbnail || ''),
        full: forceHttps(s.path_full || ''),
      })).filter(s => s.full);
    }
  } catch { /* best-effort; return whatever we have */ }

  /*
   * Steam's own review score, alongside Metacritic.
   *
   * Metacritic covers a small minority of a library like this one — PEAK, Mortal
   * Shell II and most indie releases have no score at all, so the detail page
   * showed "Critic Score —" for nearly every game. The storefront's review
   * summary is published for essentially everything and is what a player
   * actually goes by. Fetched separately so a failure here costs the review
   * line and nothing else.
   */
  if (safeAppId) {
    try {
      const url = `https://store.steampowered.com/appreviews/${safeAppId}`
        + '?json=1&language=all&purchase_type=all&num_per_page=0';
      const res = await fetch(url, { timeout: 12000 });
      if (res.ok) {
        const json = await res.json();
        const q = json?.query_summary;
        const total = Number(q?.total_reviews) || 0;
        if (total > 0) {
          const positive = Number(q?.total_positive) || 0;
          result.reviews = {
            desc: String(q?.review_score_desc || '').trim(),
            score: Number(q?.review_score) || 0,
            positive,
            total,
            percent: Math.round((positive / total) * 100),
          };
        }
      }
    } catch { /* the rest of the page does not depend on this */ }
  }

  return result;
}

/**
 * Fallback: guess OS from depot description text.
 * Only used when API data is unavailable.
 */
function guessDepotOS(depotDesc) {
  if (!depotDesc) return ['windows'];
  const d = depotDesc.toLowerCase();
  const os = [];

  if (/\bwin(dows|32|64)?\b/.test(d)) os.push('windows');
  if (/\b(linux|ubuntu|steamos)\b/.test(d)) os.push('linux');
  if (/\b(mac|macos|osx|darwin)\b/.test(d)) os.push('macos');

  if (/\b(content|data|shared|common|assets)\b/.test(d)) {
    if (!os.length) return ['windows', 'linux', 'macos'];
  }

  return os.length ? os : ['windows'];
}

/**
 * Detect additional tags from depot description (languages, etc.)
 */
function getDepotTags(depotDesc) {
  if (!depotDesc) return [];
  const d = depotDesc.toLowerCase();
  const tags = [];

  const languages = ['english', 'french', 'german', 'spanish', 'italian', 'japanese',
    'chinese', 'korean', 'russian', 'polish', 'portuguese', 'brazilian', 'turkish',
    'arabic', 'czech', 'dutch', 'hungarian', 'romanian', 'thai', 'vietnamese',
    'ukrainian', 'finnish', 'danish', 'norwegian', 'swedish'];

  for (const lang of languages) {
    if (d.includes(lang)) {
      tags.push({ type: 'lang', label: lang.charAt(0).toUpperCase() + lang.slice(1) });
    }
  }

  return tags;
}

module.exports = {
  getDepotInfoFromApi, getHeaderImageUrl, getGameMedia,
  guessDepotOS, getDepotTags,
  parseOsList, formatOsLabel,
};
