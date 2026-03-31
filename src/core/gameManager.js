const fs = require('fs');
const path = require('path');
const os = require('os');
const { getSteamLibraries, findSteamInstall } = require('./steamHelpers');

function scanSteamLibraries() {
  const libraries = getSteamLibraries();
  if (!libraries.length) return [];

  const games = [];
  const seenPaths = new Set();

  for (const libPath of libraries) {
    const steamapps = path.join(libPath, 'steamapps');
    const common = path.join(steamapps, 'common');
    if (!fs.existsSync(common)) continue;

    let dirs;
    try { dirs = fs.readdirSync(common); } catch { continue; }

    for (const gameName of dirs) {
      const gamePath = path.join(common, gameName);
      if (!fs.statSync(gamePath).isDirectory()) continue;

      // Deduplicate by normalized path (case-insensitive on Windows)
      const normalizedPath = process.platform === 'win32'
        ? gamePath.toLowerCase() : gamePath;
      if (seenPaths.has(normalizedPath)) continue;
      seenPaths.add(normalizedPath);

      const ddPath = path.join(gamePath, '.DepotDownloader');
      if (!fs.existsSync(ddPath)) continue;

      // Check if folder has content beyond .DepotDownloader
      const items = fs.readdirSync(gamePath).filter(i => i !== '.DepotDownloader');
      if (!items.length) continue;

      // Collect game data
      const gameData = collectGameData(gamePath, gameName, libPath);
      if (gameData) games.push(gameData);
    }
  }

  return games;
}

function collectGameData(gamePath, gameName, libraryPath) {
  try {
    const steamapps = path.join(libraryPath, 'steamapps');
    let appid = null;
    let acfData = {};

    // Find matching ACF file
    if (fs.existsSync(steamapps)) {
      const files = fs.readdirSync(steamapps).filter(f => f.startsWith('appmanifest_') && f.endsWith('.acf'));
      for (const filename of files) {
        try {
          const content = fs.readFileSync(path.join(steamapps, filename), 'utf-8');
          const installMatch = content.match(/"installdir"\s+"([^"]+)"/);
          if (installMatch && installMatch[1] === gameName) {
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
            break;
          }
        } catch {}
      }
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
      source: 'Librarian',
      update_status: appid && appid !== '0' ? 'checking' : 'cannot_determine',
    };
  } catch {
    return null;
  }
}

function getDirSize(dirPath) {
  let total = 0;
  try {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      const full = path.join(dirPath, item);
      const stat = fs.statSync(full);
      if (stat.isFile()) total += stat.size;
      else if (stat.isDirectory()) total += getDirSize(full);
    }
  } catch {}
  return total;
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

    // Remove game folder
    if (install_path && fs.existsSync(install_path)) {
      fs.rmSync(install_path, { recursive: true, force: true });
    }

    // Parse installed depots before removing ACF for GreenLuma cleanup
    let installedDepots = [];
    let acfPath = null;
    if (library_path && appid && appid !== '0') {
      acfPath = path.join(library_path, 'steamapps', `appmanifest_${appid}.acf`);
      if (fs.existsSync(acfPath)) {
        try {
          const content = fs.readFileSync(acfPath, 'utf-8');
          const match = content.match(/"InstalledDepots"\s*\{([\s\S]*?)\}/);
          if (match) {
            const lines = match[1].split('\n');
            for (const line of lines) {
              const dMatch = line.match(/"(\d+)"/);
              if (dMatch) installedDepots.push(dMatch[1]);
            }
          }
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
  const steamGames = scanSteamLibraries();
  const customGames = customStore.getAll().map(cg => ({
    ...cg,
    install_dir: cg.install_path ? path.basename(cg.install_path) : '',
    library_path: cg.install_path ? path.dirname(cg.install_path) : '',
    buildid: null,
    source: 'Custom',
    update_status: cg.appid && cg.appid !== '0' && cg.appid !== '' ? 'checking' : 'custom',
  }));
  return [...steamGames, ...customGames];
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
};

