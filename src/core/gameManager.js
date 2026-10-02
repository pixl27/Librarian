const fs = require('fs');
const path = require('path');
const os = require('os');
const { getSteamLibraries, findSteamInstall } = require('./steamHelpers');

/**
 * Extract the depot IDs from an ACF's "InstalledDepots" block only.
 * Uses brace matching to bound the block, then captures quoted numeric keys
 * that open a sub-block — avoiding false positives from numeric keys elsewhere
 * in the file (e.g. DlcDownloads) and from manifest/size values inside a depot.
 */
/**
 * { depotId: manifestId } for every depot the ACF says is installed.
 *
 * The depot list alone says *what* is on disk; this says *which build* of it,
 * which is what an update check needs when the build id is missing.
 */
function parseInstalledManifests(content) {
  const out = {};
  const marker = content.match(/"InstalledDepots"\s*\{/i);
  if (!marker) return out;
  const start = marker.index + marker[0].length;
  let end = start, depth = 1;
  while (end < content.length && depth) {
    if (content[end] === '{') depth++;
    if (content[end] === '}') depth--;
    end++;
  }
  const block = content.slice(start, end - 1);
  const re = /"(\d{1,10})"\s*\{[^}]*?"manifest"\s*"(\d+)"/g;
  let m;
  while ((m = re.exec(block))) out[m[1]] = m[2];
  return out;
}

function parseInstalledDepots(content) {
  const marker = content.match(/"InstalledDepots"\s*\{/i);
  if (!marker) return [];

  let i = marker.index + marker[0].length;
  const start = i;
  let depth = 1;
  while (i < content.length && depth > 0) {
    const ch = content[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  const block = content.slice(start, Math.max(start, i - 1));

  const depots = [];
  for (const m of block.matchAll(/"(\d+)"\s*\{/g)) {
    depots.push(m[1]);
  }
  return depots;
}

function scanSteamLibraries(libraries = getSteamLibraries(), warnings = []) {
  if (!libraries.length) return [];

  const games = [];
  const seenPaths = new Set();

  for (const libPath of libraries) {
    const steamapps = path.join(libPath, 'steamapps');
    const common = path.join(steamapps, 'common');
    let dirs;
    try { dirs = fs.readdirSync(common); }
    catch (error) { warnings.push({ path: libPath, error: error.code || error.message }); continue; }
    const manifestIndex = new Map();
    try {
      for (const filename of fs.readdirSync(steamapps).filter(f => /^appmanifest_\d+\.acf$/.test(f))) {
        try {
          const content = fs.readFileSync(path.join(steamapps, filename), 'utf-8');
          const dir = content.match(/"installdir"\s+"([^"]+)"/i)?.[1];
          if (dir) manifestIndex.set(process.platform === 'win32' ? dir.toLowerCase() : dir, { filename, content });
        } catch (error) { warnings.push({ path: libPath, error: `${filename}: ${error.code || error.message}` }); }
      }
    } catch (error) { warnings.push({ path: libPath, error: error.code || error.message }); continue; }

    for (const gameName of dirs) {
      const gamePath = path.join(common, gameName);
      let stat;
      try { stat = fs.statSync(gamePath); } catch { continue; }
      if (!stat.isDirectory()) continue;

      // Deduplicate by normalized path (case-insensitive on Windows)
      const normalizedPath = process.platform === 'win32'
        ? gamePath.toLowerCase() : gamePath;
      if (seenPaths.has(normalizedPath)) continue;
      seenPaths.add(normalizedPath);

      const ddPath = path.join(gamePath, '.DepotDownloader');
      if (!fs.existsSync(ddPath)) continue;

      // Check if folder has content beyond .DepotDownloader
      let items;
      try { items = fs.readdirSync(gamePath).filter(i => i !== '.DepotDownloader'); } catch { continue; }
      if (!items.length) continue;

      // Collect game data
      const gameData = collectGameData(gamePath, gameName, libPath, manifestIndex);
      if (gameData) games.push(gameData);
    }
  }

  return games;
}

function collectGameData(gamePath, gameName, libraryPath, manifestIndex) {
  try {
    const steamapps = path.join(libraryPath, 'steamapps');
    let appid = null;
    let acfData = {};

    const match = manifestIndex.get(process.platform === 'win32' ? gameName.toLowerCase() : gameName);
    if (match) {
      const { filename, content } = match;
        try {
            appid = filename.replace('appmanifest_', '').replace('.acf', '');

            const nameMatch = content.match(/"name"\s+"([^"]+)"/);
            if (nameMatch) acfData.game_name = nameMatch[1];

            const buildMatch = content.match(/"buildid"\s+"([^"]+)"/);
            if (buildMatch) acfData.buildid = buildMatch[1];

            const sizeMatch = content.match(/"SizeOnDisk"\s+"([^"]+)"/);
            if (sizeMatch) {
              const s = parseInt(sizeMatch[1]);
              if (s > 0) acfData.size_on_disk = s;
            }

            const installedDepots = parseInstalledDepots(content);
            if (installedDepots.length) {
              acfData.installed_depots = installedDepots;
            }
            const installedManifests = parseInstalledManifests(content);
            if (Object.keys(installedManifests).length) {
              acfData.installed_manifests = installedManifests;
            }
        } catch {}
    }

    // Ignore partial Librarian downloads until the manifest exists.
    if (!appid) {
      return null;
    }

    // Calculate size if not in ACF
    let sizeOnDisk = acfData.size_on_disk || 0;
    if (!sizeOnDisk) {
      sizeOnDisk = getDirSize(gamePath);
    }

    return {
      appid: appid || '0',
      game_name: acfData.game_name || gameName,
      install_dir: gameName,
      install_path: gamePath,
      library_path: libraryPath,
      size_on_disk: sizeOnDisk,
      buildid: acfData.buildid || null,
      installed_depots: acfData.installed_depots || [],
      installed_manifests: acfData.installed_manifests || {},
      source: 'Librarian',
      update_status: appid && appid !== '0' ? 'checking' : 'cannot_determine',
    };
  } catch {
    return null;
  }
}

function getDirSize(dirPath, visited = new Set()) {
  let total = 0;
  try {
    const realPath = fs.realpathSync(dirPath);
    const normalizedRealPath = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
    if (visited.has(normalizedRealPath)) return 0;
    visited.add(normalizedRealPath);

    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      const full = path.join(dirPath, item);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isFile()) total += stat.size;
      else if (stat.isDirectory()) total += getDirSize(full, visited);
    }
  } catch {}
  return total;
}

function normalizePathForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readAcfInstallDir(acfPath) {
  try {
    const content = fs.readFileSync(acfPath, 'utf-8');
    const installMatch = content.match(/"installdir"\s+"([^"]+)"/);
    return installMatch ? installMatch[1] : null;
  } catch {
    return null;
  }
}

function resolveSafeInstallTarget(installPath, libraryPath, appid) {
  if (typeof installPath !== 'string' || !installPath.trim()) {
    throw new Error('Install path is missing.');
  }

  const resolvedInstallPath = path.resolve(installPath);
  if (!fs.existsSync(resolvedInstallPath) || !fs.statSync(resolvedInstallPath).isDirectory()) {
    throw new Error('Install path does not exist or is not a directory.');
  }

  const markerPath = path.join(resolvedInstallPath, '.DepotDownloader');
  if (!fs.existsSync(markerPath)) {
    throw new Error('Refusing to uninstall a folder that was not created by Librarian.');
  }

  const libraries = [];
  try { libraries.push(...getSteamLibraries()); } catch {}
  if (libraryPath) libraries.push(libraryPath);

  const seen = new Set();
  for (const lib of libraries) {
    if (!lib) continue;
    const resolvedLibrary = path.resolve(lib);
    const key = normalizePathForCompare(resolvedLibrary);
    if (seen.has(key)) continue;
    seen.add(key);

    const commonDir = path.join(resolvedLibrary, 'steamapps', 'common');
    if (!isPathInside(commonDir, resolvedInstallPath)) continue;

    const safeAppId = String(appid || '').trim();
    if (/^\d{1,20}$/.test(safeAppId) && safeAppId !== '0') {
      const acfPath = path.join(resolvedLibrary, 'steamapps', `appmanifest_${safeAppId}.acf`);
      const installDir = readAcfInstallDir(acfPath);
      if (installDir && normalizePathForCompare(path.join(commonDir, installDir)) !== normalizePathForCompare(resolvedInstallPath)) {
        throw new Error('Install path does not match the Steam app manifest.');
      }
    }

    return {
      installPath: resolvedInstallPath,
      libraryPath: resolvedLibrary,
    };
  }

  throw new Error('Install path is not inside a known Steam library.');
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function uninstallGame(gameData) {
  try {
    const { install_path, library_path, appid } = gameData;
    const target = resolveSafeInstallTarget(install_path, library_path, appid);

    // Remove game folder
    if (fs.existsSync(target.installPath)) {
      fs.rmSync(target.installPath, { recursive: true, force: true });
    }

    // Parse installed depots before removing ACF for GreenLuma cleanup
    let installedDepots = [];
    let acfPath = null;
    if (target.libraryPath && appid && appid !== '0') {
      acfPath = path.join(target.libraryPath, 'steamapps', `appmanifest_${appid}.acf`);
      if (fs.existsSync(acfPath)) {
        try {
          const content = fs.readFileSync(acfPath, 'utf-8');
          installedDepots = parseInstalledDepots(content);
        } catch {}
      }
    }

    // Remove ACF file
    if (acfPath && fs.existsSync(acfPath)) {
      try { fs.unlinkSync(acfPath); } catch {}
    }

    // Remove GreenLuma AppList files on Windows
    if (process.platform === 'win32' && appid && appid !== '0') {
      removeGreenLumaFiles(appid, installedDepots);
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function addGreenLumaFiles(appid, depotIds = []) {
  const steamPath = findSteamInstall();
  if (!steamPath) return;

  const appListDir = path.join(steamPath, 'AppList');
  if (!fs.existsSync(appListDir)) {
    try { fs.mkdirSync(appListDir, { recursive: true }); } catch { return; }
  }

  try {
    const idsToAdd = [String(appid), ...depotIds.map(String)];
    
    // Read existing files to find what's already there and the max number
    const files = fs.readdirSync(appListDir).filter(f => f.endsWith('.txt'));
    let maxNum = -1;
    const existingIds = new Set();
    
    for (const f of files) {
      const num = parseInt(f.replace('.txt', ''));
      if (!isNaN(num) && num > maxNum) maxNum = num;
      try {
        const content = fs.readFileSync(path.join(appListDir, f), 'utf-8').trim();
        existingIds.add(content);
      } catch {}
    }
    
    for (const id of idsToAdd) {
      if (!existingIds.has(id)) {
        maxNum++;
        const newPath = path.join(appListDir, `${maxNum}.txt`);
        fs.writeFileSync(newPath, id, 'utf-8');
        existingIds.add(id);
      }
    }
  } catch {}
}

function removeGreenLumaFiles(appid, depotIds = []) {
  const steamPath = findSteamInstall();
  if (!steamPath) return;

  const appListDir = path.join(steamPath, 'AppList');
  if (!fs.existsSync(appListDir)) return;

  try {
    const idsToRemove = new Set([String(appid), ...depotIds.map(String)]);
    const files = fs.readdirSync(appListDir).filter(f => f.endsWith('.txt'));
    const toDelete = [];
    const allFiles = [];

    for (const f of files) {
      const fp = path.join(appListDir, f);
      const content = fs.readFileSync(fp, 'utf-8').trim();
      allFiles.push({ name: f, path: fp, content });
      if (idsToRemove.has(content)) toDelete.push(fp);
    }

    for (const fp of toDelete) {
      fs.unlinkSync(fp);
    }

    // Renumber remaining
    const remaining = allFiles
      .filter(f => !toDelete.includes(f.path))
      .sort((a, b) => parseInt(a.name) - parseInt(b.name));

    for (let i = 0; i < remaining.length; i++) {
      const newName = `${i}.txt`;
      const newPath = path.join(appListDir, newName);
      if (remaining[i].name !== newName) {
        fs.renameSync(remaining[i].path, newPath);
      }
    }
  } catch {}
}

function getUninstallMessage(gameData) {
  const { game_name, install_path, appid, source } = gameData;
  if (source === 'Custom') {
    return `Remove '${game_name}' from your library?\n\nThis only removes it from Librarian — game files at:\n${install_path}\nwill NOT be deleted.`;
  }
  let msg = `Are you sure you want to uninstall '${game_name}'?\n\nThis will permanently delete:\n• Game folder: ${install_path}\n`;
  if (appid && appid !== '0') msg += `• Steam app manifest (${appid}.acf)\n`;
  if (process.platform === 'win32' && appid && appid !== '0') {
    msg += `• GreenLuma AppList file(s)\n`;
  }
  msg += '\nThis action cannot be undone!';
  return msg;
}

// ─── Custom Game Support ─────────────────────────────────────────

/**
 * Scan Steam libraries AND merge in custom games.
 */
function scanAllGames() {
  const customStore = require('./customGameStore');
  const meta = require('./gameMetaStore');
  const steamGames = scanSteamLibraries();
  const customGames = customStore.getAll().map(cg => ({
    ...cg,
    install_dir: cg.install_path ? path.basename(cg.install_path) : '',
    library_path: cg.install_path ? path.dirname(cg.install_path) : '',
    buildid: null,
    source: 'Custom',
    update_status: cg.appid && cg.appid !== '0' && cg.appid !== '' ? 'checking' : 'custom',
  }));
  // Fold in launcher metadata (playtime, last played, exe override) so the
  // renderer can show it without extra round-trips.
  const games = [...steamGames, ...customGames];
  meta.recordDiscovery(games);
  return games.map(g => meta.decorate(g));
}

/**
 * Try to auto-detect AppID from the game folder.
 * Strategies: steam_appid.txt, Goldberg config, ACF manifests.
 */
function detectAppId(gamePath) {
  if (!gamePath || !fs.existsSync(gamePath)) return null;

  // 1. Check steam_appid.txt in game root
  const steamAppIdFile = path.join(gamePath, 'steam_appid.txt');
  if (fs.existsSync(steamAppIdFile)) {
    try {
      const content = fs.readFileSync(steamAppIdFile, 'utf-8').trim();
      const id = content.split(/\s/)[0];
      if (/^\d{3,}$/.test(id)) return id;
    } catch {}
  }

  // 2. Check Goldberg steam_settings/steam_appid.txt
  const goldbergFile = path.join(gamePath, 'steam_settings', 'steam_appid.txt');
  if (fs.existsSync(goldbergFile)) {
    try {
      const content = fs.readFileSync(goldbergFile, 'utf-8').trim();
      const id = content.split(/\s/)[0];
      if (/^\d{3,}$/.test(id)) return id;
    } catch {}
  }

  // 3. Check ACF manifests in parent steamapps folder
  const gameName = path.basename(gamePath);
  const parentDir = path.dirname(gamePath);                // e.g. .../steamapps/common
  const steamappsDir = path.dirname(parentDir);             // e.g. .../steamapps
  const acfDir = steamappsDir;
  if (fs.existsSync(acfDir)) {
    try {
      const files = fs.readdirSync(acfDir).filter(f => f.startsWith('appmanifest_') && f.endsWith('.acf'));
      for (const filename of files) {
        try {
          const content = fs.readFileSync(path.join(acfDir, filename), 'utf-8');
          const installMatch = content.match(/"installdir"\s+"([^"]+)"/);
          if (installMatch && installMatch[1].toLowerCase() === gameName.toLowerCase()) {
            const appid = filename.replace('appmanifest_', '').replace('.acf', '');
            if (/^\d{3,}$/.test(appid)) return appid;
          }
        } catch {}
      }
    } catch {}
  }

  return null;
}

/**
 * Calculate folder size for a given path.
 */
function calculateFolderSize(dirPath) {
  return getDirSize(dirPath);
}

module.exports = {
  scanSteamLibraries,
  scanAllGames,
  uninstallGame,
  getUninstallMessage,
  formatSize,
  addGreenLumaFiles,
  detectAppId,
  calculateFolderSize,
  parseInstalledDepots,
  parseInstalledManifests,
};
