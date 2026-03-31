const fetch = require('node-fetch');

/**
 * Fetch full app + depot info from Steam.
 * Uses steamcmd.net API which provides depot config data (including oslist)
 * similar to SteamDB.
 */
async function getDepotInfoFromApi(appId) {
  const result = {
    installdir: null,
    header_url: null,
    platforms: [],
    depotConfigs: {},  // { depotId: { oslist, osarch, ... } }
  };

  // 1) Get store data (platforms, header, install dir)
  try {
    const storeUrl = `https://store.steampowered.com/api/appdetails?appids=${appId}`;
    const storeRes = await fetch(storeUrl, { timeout: 15000 });
    if (storeRes.ok) {
      const storeData = await storeRes.json();
      const wrapper = storeData[String(appId)];
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
    const cmdUrl = `https://api.steamcmd.net/v1/info/${appId}`;
    const cmdRes = await fetch(cmdUrl, { timeout: 15000 });
    if (cmdRes.ok) {
      const cmdData = await cmdRes.json();
      if (cmdData.status === 'success' && cmdData.data && cmdData.data[String(appId)]) {
        const appInfo = cmdData.data[String(appId)];
        const depots = appInfo.depots || {};

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
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
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
  getDepotInfoFromApi, getHeaderImageUrl,
  guessDepotOS, getDepotTags,
  parseOsList, formatOsLabel,
};
