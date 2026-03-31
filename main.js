const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let settings = null;

function createWindow() {
  // Lazy-load settings after app is ready
  settings = require('./src/core/settingsStore');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    frame: false,
    title: 'Librarian',
    icon: path.join(__dirname, 'res', 'logo', 'librarian-icon.png'),
    backgroundColor: settings.get('background_color') || '#16213E',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ─── Window Controls ─────────────────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.restore();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

// ─── Settings ────────────────────────────────────────────────────
ipcMain.handle('settings:get', (_, key) => settings.get(key));
ipcMain.handle('settings:getAll', () => settings.getAll());
ipcMain.handle('settings:set', (_, key, value) => {
  settings.set(key, value);
  return true;
});

// ─── Native Dialogs ──────────────────────────────────────────────
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:openFile', async (_, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: options?.filters || []
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:openImage', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

// ─── ZIP Processing ──────────────────────────────────────────────
ipcMain.handle('zip:process', async (_, zipPath) => {
  try {
    const { processZip } = require('./src/core/zipProcessor');
    const gameData = await processZip(zipPath);
    return { success: true, data: gameData };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── Depot Downloads ─────────────────────────────────────────────
let currentDownload = null;

ipcMain.handle('depot:download', async (event, { gameData, selectedDepots, destPath }) => {
  try {
    const { startDepotDownload } = require('./src/core/depotDownloader');
    currentDownload = startDepotDownload(gameData, selectedDepots, destPath, {
      onProgress: (msg) => mainWindow?.webContents.send('depot:progress', msg),
      onPercentage: (pct) => mainWindow?.webContents.send('depot:percentage', pct),
      onSpeed: (speed) => mainWindow?.webContents.send('depot:speed', speed),
      onComplete: () => {
        currentDownload = null;
        mainWindow?.webContents.send('depot:complete');
      },
      onError: (err) => {
        currentDownload = null;
        mainWindow?.webContents.send('depot:error', err);
      }
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('depot:pause', () => {
  if (currentDownload) {
    const { pauseDownload } = require('./src/core/depotDownloader');
    pauseDownload(currentDownload);
    return true;
  }
  return false;
});

ipcMain.handle('depot:resume', () => {
  if (currentDownload) {
    const { resumeDownload } = require('./src/core/depotDownloader');
    resumeDownload(currentDownload);
    return true;
  }
  return false;
});

ipcMain.handle('depot:cancel', () => {
  if (currentDownload) {
    const { cancelDownload } = require('./src/core/depotDownloader');
    cancelDownload(currentDownload);
    currentDownload = null;
    return true;
  }
  return false;
});

// ─── Morrenus API ────────────────────────────────────────────────
ipcMain.handle('morrenus:search', async (_, query) => {
  const { searchGames } = require('./src/core/morrenusApi');
  const apiKey = settings.get('morrenus_api_key') || '';
  return searchGames(query, apiKey);
});

ipcMain.handle('morrenus:download', async (_, appId) => {
  const { downloadManifest } = require('./src/core/morrenusApi');
  const apiKey = settings.get('morrenus_api_key') || '';
  return downloadManifest(appId, apiKey);
});

// ─── Steam Helpers ───────────────────────────────────────────────
ipcMain.handle('steam:findInstall', () => {
  const { findSteamInstall } = require('./src/core/steamHelpers');
  return findSteamInstall();
});

ipcMain.handle('steam:getLibraries', () => {
  const { getSteamLibraries } = require('./src/core/steamHelpers');
  return getSteamLibraries();
});

// ─── Game Library ────────────────────────────────────────────────
ipcMain.handle('game:scan', () => {
  const { scanAllGames } = require('./src/core/gameManager');
  return scanAllGames();
});

ipcMain.handle('game:detectAppId', (_, gamePath) => {
  const { detectAppId } = require('./src/core/gameManager');
  return detectAppId(gamePath);
});

ipcMain.handle('game:suggestAppId', async (_, gameName) => {
  const { searchGames } = require('./src/core/morrenusApi');
  const apiKey = settings.get('morrenus_api_key') || '';
  return searchGames(gameName, apiKey);
});

ipcMain.handle('game:folderSize', (_, dirPath) => {
  const { calculateFolderSize } = require('./src/core/gameManager');
  return calculateFolderSize(dirPath);
});

// ─── Custom Game CRUD ────────────────────────────────────────────
ipcMain.handle('customGame:add', (_, gameData) => {
  const customStore = require('./src/core/customGameStore');
  return customStore.add(gameData);
});

ipcMain.handle('customGame:update', (_, id, updates) => {
  const customStore = require('./src/core/customGameStore');
  return customStore.update(id, updates);
});

ipcMain.handle('customGame:remove', (_, id) => {
  const customStore = require('./src/core/customGameStore');
  return customStore.remove(id);
});

ipcMain.handle('game:uninstall', (_, gameData) => {
  const { uninstallGame } = require('./src/core/gameManager');
  return uninstallGame(gameData);
});

ipcMain.handle('game:uninstallMessage', (_, gameData) => {
  const { getUninstallMessage } = require('./src/core/gameManager');
  return getUninstallMessage(gameData);
});

ipcMain.handle('game:checkUpdate', async (_, appId, localBuildId) => {
  const { checkForUpdate } = require('./src/core/updateChecker');
  return checkForUpdate(appId, localBuildId);
});

ipcMain.handle('game:checkAllUpdates', async (_, games) => {
  const { checkAllUpdates } = require('./src/core/updateChecker');
  return checkAllUpdates(games);
});

// ─── Steam API ───────────────────────────────────────────────────
ipcMain.handle('steam:getDepotInfo', async (_, appId) => {
  const { getDepotInfoFromApi } = require('./src/core/steamApi');
  return getDepotInfoFromApi(appId);
});

// ─── Shell ───────────────────────────────────────────────────────
ipcMain.handle('shell:openPath', (_, p) => shell.openPath(p));

// ─── App Info ────────────────────────────────────────────────────
ipcMain.handle('app:getPath', (_, name) => {
  if (name === 'deps') return path.join(__dirname, 'deps');
  if (name === 'goldberg') return path.join(__dirname, 'deps', 'goldberg');
  if (name === 'res') return path.join(__dirname, 'res');
  if (name === 'data') return path.join(__dirname, 'data');
  if (name === 'userData') return app.getPath('userData');
  return __dirname;
});

// ─── Auto Crack (SteamAutoCrack CLI) ─────────────────────────────
ipcMain.handle('crack:scan', (_, gamePath) => {
  const { scanGameDirectory } = require('./src/core/autoCrack');
  return scanGameDirectory(gamePath);
});

ipcMain.handle('crack:apply', async (_, options) => {
  const { crackGame } = require('./src/core/autoCrack');
  return crackGame({
    ...options,
    onLog: (msg) => mainWindow?.webContents.send('crack:log', msg),
  });
});

ipcMain.handle('crack:restore', async (_, gamePath) => {
  const { restoreGame } = require('./src/core/autoCrack');
  return restoreGame(gamePath, (msg) => mainWindow?.webContents.send('crack:log', msg));
});

ipcMain.handle('crack:checkGoldberg', () => {
  const { checkSacStatus } = require('./src/core/autoCrack');
  return checkSacStatus();
});

ipcMain.handle('crack:downloadGoldberg', async () => {
  const { downloadGoldberg } = require('./src/core/autoCrack');
  return downloadGoldberg({
    onLog: (msg) => mainWindow?.webContents.send('crack:log', msg),
  });
});

ipcMain.handle('crack:generateCrackOnly', async (_, { gamePath, outputPath }) => {
  const { generateCrackOnly } = require('./src/core/autoCrack');
  return generateCrackOnly(gamePath, outputPath, (msg) => mainWindow?.webContents.send('crack:log', msg));
});

