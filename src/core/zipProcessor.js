const fs = require('fs');
const path = require('path');
const os = require('os');
const yauzl = require('yauzl');
const { crc32 } = require('./zipWriter');

const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 256 * 1024 * 1024;

const DEPOT_BLACKLIST = new Set([
  '228981','228982','228983','228984','228985','228986','228987','228988','228989',
  '229000','229001','229002','229003','229004','229005','229006','229007',
  '229010','229011','229012','229020','229030','229031','229032','229033',
  '228990','239142','798541','798542','798543','1034630',
]);

function parseLua(content, gameData) {
  gameData.manifest_sizes = gameData.manifest_sizes || {};

  // This is a metadata reader, not a Lua evaluator. Only accept calls at
  // the start of a code line; comments and titles may contain call syntax.
  const code = content.replace(/^\uFEFF/, '').replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, '\n');
  const allAppMatches = [...code.matchAll(/^[\t ]*addappid\s*\(([^\r\n]*?)\)([^\r\n]*)/gmi)];
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
  const sizeMatches = [...code.matchAll(/^[\t ]*setManifestid\(\s*(\d+)\s*,\s*"[^"\r\n]*"\s*,\s*(\d+)\s*\)/gmi)];
  for (const m of sizeMatches) {
    gameData.manifest_sizes[m[1].trim()] = m[2].trim();
  }
}

function readZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);

      const entries = Object.create(null);
      let totalUncompressedSize = 0;
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch {}
        reject(error);
      };

      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }

        if (entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
          fail(new Error(`ZIP entry is too large: ${entry.fileName}`));
          return;
        }

        totalUncompressedSize += entry.uncompressedSize || 0;
        if (totalUncompressedSize > MAX_ZIP_TOTAL_BYTES) {
          fail(new Error('ZIP archive is too large to process safely.'));
          return;
        }
        if (Object.hasOwn(entries, entry.fileName)) {
          fail(new Error(`Duplicate ZIP entry: ${entry.fileName}`));
          return;
        }

        const readStream = new Promise((res, rej) => {
          zipfile.openReadStream(entry, (err, stream) => {
            if (err) return rej(err);
            const chunks = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => {
              const data = Buffer.concat(chunks);
              if (crc32(data) !== (entry.crc32 >>> 0)) {
                rej(new Error(`ZIP CRC mismatch: ${entry.fileName}`));
                return;
              }
              res(data);
            });
            stream.on('error', rej);
          });
        });

        // Every entry is read eagerly, but a caller only awaits the ones it
        // wants. A corrupt archive whose *unread* entry fails to inflate used
        // to reject with nobody listening, which Node turns into a fatal
        // unhandled rejection — a bad manifest zip could take the process
        // down instead of failing the job. Marking it handled here changes
        // nothing for an awaited entry: awaiting this promise still rejects.
        readStream.catch(() => {});
        entries[entry.fileName] = readStream;
        zipfile.readEntry();
      });

      zipfile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(entries);
      });
      zipfile.on('error', fail);
    });
  });
}

async function readGameArchive(zipPath, expectedAppId) {
  const entries = await readZipEntries(zipPath);
  const fileNames = Object.keys(entries);

  // Find LUA file
  const luaFiles = fileNames.filter(f => f.toLowerCase().endsWith('.lua'));
  const luaFile = luaFiles[0];
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
  gameData.appid = String(gameData.appid || '').trim();
  if (!/^\d{1,20}$/.test(gameData.appid)) {
    throw new Error('LUA file contains an invalid AppID.');
  }

  const { assertAppId } = require('./downloadIdentity');
  assertAppId(expectedAppId, gameData.appid);
  for (const other of luaFiles.slice(1)) {
    const data = {};
    parseLua((await entries[other]).toString('utf8'), data);
    assertAppId(gameData.appid, data.appid);
  }
  return { gameData, manifestFiles };
}

async function inspectArchiveAppId(zipPath, expectedAppId) {
  return (await readGameArchive(zipPath, expectedAppId)).gameData.appid;
}

async function processZip(zipPath, expectedAppId, options = {}) {
  const { gameData, manifestFiles } = await readGameArchive(zipPath, expectedAppId);

  // Filter blacklisted depots
  const unfiltered = gameData.depots || {};
  gameData.depots = {};
  for (const [id, data] of Object.entries(unfiltered)) {
    if (!DEPOT_BLACKLIST.has(id)) {
      gameData.depots[id] = data;
    }
  }

  // Imported Lua/Hubcap packages follow the same preference as generated Lua.
  // Keep their metadata and manifest bytes; use package/saved keys as backup.
  const depotKeys = require('./depotKeys');
  const selected = await depotKeys.preferCatalog(Object.keys(gameData.depots), {
    ...depotKeys.load(options.userData), ...depotKeys.clean(gameData.depots),
  }, options);
  for (const [id, key] of Object.entries(selected.keys)) gameData.depots[id].key = key;
  try { require('./depotKeys').remember(gameData.depots, options.userData); } catch { /* the store is a convenience */ }

  // Enrich depots with API data
  if (gameData.appid && Object.keys(gameData.depots).length) {
    try {
      const { getDepotInfoFromApi, guessDepotOS, getDepotTags, parseOsList } = require('./steamApi');
      const apiData = await getDepotInfoFromApi(gameData.appid);

      if (apiData.installdir) gameData.installdir = apiData.installdir;
      if (apiData.header_url) gameData.header_url = apiData.header_url;
      if (apiData.platforms && apiData.platforms.length) gameData.platforms = apiData.platforms;

      const depotConfigs = apiData.depotConfigs || {};
      // Today's API build is evidence only when every packaged depot matches
      // it. Old Hubcap packages remain valid downloads with an unknown build.
      const depotIds = Object.keys(gameData.depots);
      if (apiData.buildid && depotIds.length && depotIds.every((id) =>
        depotConfigs[id]?.manifestId && String(depotConfigs[id].manifestId) === String(gameData.manifests[id]))) {
        gameData.buildid = apiData.buildid;
      }

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
  const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-manifests-'));
  fs.mkdirSync(manifestDir, { recursive: true });
  for (const [name, contentPromise] of Object.entries(manifestFiles)) {
    const content = contentPromise instanceof Buffer ? contentPromise : await contentPromise;
    fs.writeFileSync(path.join(manifestDir, name), content);
  }
  gameData.manifest_dir = manifestDir;

  return gameData;
}

function cleanupManifestDir(manifestDir) {
  if (typeof manifestDir !== 'string' || !manifestDir.trim()) return false;

  const tempRoot = fs.realpathSync(os.tmpdir());
  let resolved;
  try {
    resolved = fs.realpathSync(manifestDir);
  } catch {
    return false;
  }

  const relative = path.relative(tempRoot, resolved);
  const isInsideTemp = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  if (!isInsideTemp || !path.basename(resolved).startsWith('librarian-manifests-')) {
    return false;
  }

  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { processZip, cleanupManifestDir, inspectArchiveAppId, readGameArchive, DEPOT_BLACKLIST };
