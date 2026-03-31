const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  // Settings
  getSetting: (key) => ipcRenderer.invoke('settings:get', key),
  getAllSettings: () => ipcRenderer.invoke('settings:getAll'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),

  // Dialogs
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts),

  // ZIP Processing
  processZip: (zipPath) => ipcRenderer.invoke('zip:process', zipPath),

  // Depot Downloads
  startDownload: (opts) => ipcRenderer.invoke('depot:download', opts),
  pauseDownload: () => ipcRenderer.invoke('depot:pause'),
  resumeDownload: () => ipcRenderer.invoke('depot:resume'),
  cancelDownload: () => ipcRenderer.invoke('depot:cancel'),

  onDownloadProgress: (cb) => { ipcRenderer.on('depot:progress', (_, msg) => cb(msg)); },
  onDownloadPercentage: (cb) => { ipcRenderer.on('depot:percentage', (_, pct) => cb(pct)); },
  onDownloadSpeed: (cb) => { ipcRenderer.on('depot:speed', (_, spd) => cb(spd)); },
  onDownloadComplete: (cb) => { ipcRenderer.on('depot:complete', () => cb()); },
  onDownloadError: (cb) => { ipcRenderer.on('depot:error', (_, err) => cb(err)); },

  // Morrenus API
  searchGames: (query) => ipcRenderer.invoke('morrenus:search', query),
  downloadManifest: (appId) => ipcRenderer.invoke('morrenus:download', appId),

  // Steam Helpers
  findSteamInstall: () => ipcRenderer.invoke('steam:findInstall'),
  getSteamLibraries: () => ipcRenderer.invoke('steam:getLibraries'),
  getDepotInfo: (appId) => ipcRenderer.invoke('steam:getDepotInfo', appId),

  // Game Library
  scanGames: () => ipcRenderer.invoke('game:scan'),
  uninstallGame: (gameData) => ipcRenderer.invoke('game:uninstall', gameData),
  getUninstallMessage: (gameData) => ipcRenderer.invoke('game:uninstallMessage', gameData),
  checkGameUpdate: (appId, localBuildId) => ipcRenderer.invoke('game:checkUpdate', appId, localBuildId),
  checkAllGameUpdates: (games) => ipcRenderer.invoke('game:checkAllUpdates', games),
  detectAppId: (gamePath) => ipcRenderer.invoke('game:detectAppId', gamePath),
  suggestAppId: (gameName) => ipcRenderer.invoke('game:suggestAppId', gameName),
  folderSize: (dirPath) => ipcRenderer.invoke('game:folderSize', dirPath),

  // Custom Games
  addCustomGame: (data) => ipcRenderer.invoke('customGame:add', data),
  updateCustomGame: (id, data) => ipcRenderer.invoke('customGame:update', id, data),
  removeCustomGame: (id) => ipcRenderer.invoke('customGame:remove', id),

  // Shell
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),

  // App paths
  getPath: (name) => ipcRenderer.invoke('app:getPath', name),

  // Dialogs (additional)
  openImageDialog: () => ipcRenderer.invoke('dialog:openImage'),

  // Auto Crack (SAC CLI)
  crackScan: (gamePath) => ipcRenderer.invoke('crack:scan', gamePath),
  crackApply: (opts) => ipcRenderer.invoke('crack:apply', opts),
  crackRestore: (gamePath) => ipcRenderer.invoke('crack:restore', gamePath),
  crackCheckGoldberg: () => ipcRenderer.invoke('crack:checkGoldberg'),
  crackDownloadGoldberg: () => ipcRenderer.invoke('crack:downloadGoldberg'),
  crackGenerateCrackOnly: (opts) => ipcRenderer.invoke('crack:generateCrackOnly', opts),
  onCrackLog: (cb) => { ipcRenderer.on('crack:log', (_, msg) => cb(msg)); },
});
