const fs = require('fs');
const path = require('path');
const os = require('os');
const yauzl = require('yauzl');

const DEPOT_BLACKLIST = new Set([
  '228981','228982','228983','228984','228985','228986','228987','228988','228989',
  '229000','229001','229002','229003','229004','229005','229006','229007',
  '229010','229011','229012','229020','229030','229031','229032','229033',
  '228990','239142','798541','798542','798543','1034630',
]);

function parseLua(content, gameData) {
  gameData.manifest_sizes = gameData.manifest_sizes || {};

  const allAppMatches = [...content.matchAll(/addappid\((.*?)\)(.*)/gi)];
  if (!allAppMatches.length) throw new Error('LUA file is invalid; no addappid entries found.');

  const firstMatch = allAppMatches.shift();
  const firstArgs = firstMatch[1].trim();
  gameData.appid = firstArgs.split(',')[0].trim();

  const commentPart = firstMatch[2];
  const nameMatch = commentPart.match(/--\s*(.*)/);
  gameData.game_name = nameMatch ? nameMatch[1].trim() : `App_${gameData.appid}`;

  gameData.depots = {};
  gameData.dlcs = {};

  for (const match of allAppMatches) {
    const argsStr = match[1].trim();
    const args = argsStr.split(',').map(a => a.trim());
    const appId = args[0];

    const desc_match = match[2].match(/--\s*(.*)/);
    const desc = desc_match ? desc_match[1].trim() : `Depot ${appId}`;

    if (args.length > 2 && args[2].replace(/"/g, '')) {
      const depotKey = args[2].replace(/"/g, '');
      gameData.depots[appId] = { key: depotKey, desc };
    } else {
      gameData.dlcs[appId] = desc;
    }
  }

  // Parse manifest sizes
  const sizeMatches = [...content.matchAll(/setManifestid\(\s*(\d+)\s*,\s*".*?"\s*,\s*(\d+)\s*\)/gi)];
  for (const m of sizeMatches) {
    gameData.manifest_sizes[m[1].trim()] = m[2].trim();
  }
}

function readZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);

      const entries = {};
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        const readStream = new Promise((res, rej) => {
          zipfile.openReadStream(entry, (err, stream) => {
            if (err) return rej(err);
            const chunks = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => res(Buffer.concat(chunks)));
            stream.on('error', rej);
          });
        });

        entries[entry.fileName] = readStream;
        zipfile.readEntry();
      });

      zipfile.on('end', () => resolve(entries));
      zipfile.on('error', reject);
    });
  });
}

async function processZip(zipPath) {
  const entries = await readZipEntries(zipPath);
  const fileNames = Object.keys(entries);

  // Find LUA file
  const luaFile = fileNames.find(f => f.endsWith('.lua'));
  if (!luaFile) throw new Error('No .lua file found in the zip archive.');

  // Read manifests
  const manifestFiles = {};
  for (const f of fileNames) {
    if (f.endsWith('.manifest')) {
      const basename = path.basename(f);
      manifestFiles[basename] = await entries[f];
    }
  }

  // Parse game data
  const gameData = { manifests: {} };

  // Extract manifest IDs from filenames
  for (const name of Object.keys(manifestFiles)) {
    const parts = name.replace('.manifest', '').split('_');
    if (parts.length === 2) {
      gameData.manifests[parts[0]] = parts[1];
    }
  }

  // Parse LUA
  const luaContent = (await entries[luaFile]).toString('utf-8');
  parseLua(luaContent, gameData);

  // Filter blacklisted depots
  const unfiltered = gameData.depots || {};
  gameData.depots = {};
  for (const [id, data] of Object.entries(unfiltered)) {
    if (!DEPOT_BLACKLIST.has(id)) {
      gameData.depots[id] = data;
    }
  }

  // Enrich depots with API data
  if (gameData.appid && Object.keys(gameData.depots).length) {
    try {
      const { getDepotInfoFromApi, guessDepotOS, getDepotTags, parseOsList } = require('./steamApi');
      const apiData = await getDepotInfoFromApi(gameData.appid);

      if (apiData.installdir) gameData.installdir = apiData.installdir;
      if (apiData.header_url) gameData.header_url = apiData.header_url;
      if (apiData.buildid) gameData.buildid = apiData.buildid;
      if (apiData.platforms && apiData.platforms.length) gameData.platforms = apiData.platforms;

      const depotConfigs = apiData.depotConfigs || {};

      // Enrich depot descriptions with real OS data
      const enriched = {};
      for (const [depotId, luaData] of Object.entries(gameData.depots)) {
        const finalData = { key: luaData.key, desc: luaData.desc };

        // Use LUA size as fallback
        const luaSize = (gameData.manifest_sizes || {})[depotId];
        if (luaSize) finalData.size = luaSize;

        // Use API maxsize if available and we don't have a LUA size
        const depotCfg = depotConfigs[depotId];
        if (depotCfg && depotCfg.maxsize && !finalData.size) {
          finalData.size = depotCfg.maxsize;
        }

        // Use depot name from API if our LUA desc is generic
        if (depotCfg && depotCfg.name) {
          finalData.apiName = depotCfg.name;
          // If LUA desc is just "Depot XXXX", use the API name instead
          if (finalData.desc === `Depot ${depotId}` || !finalData.desc) {
            finalData.desc = depotCfg.name;
          }
        }

        // Filter out soundtracks
        const lower = (finalData.desc || '').toLowerCase();
        if (lower.includes('soundtrack') || /\bost\b/.test(lower)) continue;

        // *** REAL OS from Steam depot config ***
        if (depotCfg && depotCfg.oslist) {
          finalData.os = parseOsList(depotCfg.oslist);
          finalData.osarch = depotCfg.osarch || null;
        } else {
          // Fallback: guess from description text
          finalData.os = guessDepotOS(luaData.desc);
          finalData.osarch = null;
        }

        // If OS list is empty (depot config exists but oslist is blank = shared/all platforms)
        if (finalData.os.length === 0) {
          finalData.os = gameData.platforms && gameData.platforms.length
            ? [...gameData.platforms]
            : ['windows', 'macos', 'linux'];
          finalData.isShared = true;
        }

        finalData.tags = getDepotTags(luaData.desc);

        enriched[depotId] = finalData;
      }
      gameData.depots = enriched;
    } catch (e) {
      // API enrichment failed, continue with LUA data
    }
  }

  // Save manifests to temp dir
  const manifestDir = path.join(os.tmpdir(), 'mistwalker_manifests');
  fs.mkdirSync(manifestDir, { recursive: true });
  for (const [name, contentPromise] of Object.entries(manifestFiles)) {
    const content = contentPromise instanceof Buffer ? contentPromise : await contentPromise;
    fs.writeFileSync(path.join(manifestDir, name), content);
  }

  return gameData;
}

module.exports = { processZip };
