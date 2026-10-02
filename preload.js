const { contextBridge, ipcRenderer, webUtils } = require('electron');

function onIpc(channel, cb) {
  if (typeof cb !== 'function') return () => {};
  const listener = (_event, ...args) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  // Platform (available synchronously to the renderer)
  platform: process.platform,
  getPathForFile: file => webUtils.getPathForFile(file),

  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  restoreWindow: () => ipcRenderer.invoke('window:restore'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  setFullScreen: (flag) => ipcRenderer.invoke('window:setFullScreen', flag),
  isFullScreen: () => ipcRenderer.invoke('window:isFullScreen'),
  onWindowState: (cb) => onIpc('window:state', cb),

  // Taskbar / dock feedback
  setTaskbarProgress: (value) => ipcRenderer.invoke('window:setProgress', value),
  flashWindow: () => ipcRenderer.invoke('window:flash'),

  // Environment
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getDiskSpace: (targetPath) => ipcRenderer.invoke('system:diskSpace', targetPath),

  // Settings
  getSetting: (key) => ipcRenderer.invoke('settings:get', key),
  getAllSettings: () => ipcRenderer.invoke('settings:getAll'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  setSettings: (values) => ipcRenderer.invoke('settings:setMany', values),
  getCachedGames: () => ipcRenderer.invoke('game:cached'),
  getQueue: () => ipcRenderer.invoke('queue:snapshot'),
  addQueueJob: (job) => ipcRenderer.invoke('queue:add', job),
  patchQueueJob: (id, updates) => ipcRenderer.invoke('queue:patch', id, updates),
  removeQueueJob: (id) => ipcRenderer.invoke('queue:remove', id),

  // Dialogs
  openFolder: (opts) => ipcRenderer.invoke('dialog:openFolder', opts),
  openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts),

  // Install destinations
  listInstallLocations: () => ipcRenderer.invoke('install:listLocations'),
  addInstallLocation: (dir) => ipcRenderer.invoke('install:addLocation', dir),
  removeInstallLocation: (dir) => ipcRenderer.invoke('install:removeLocation', dir),

  // ZIP Processing
  processZip: (zipPath, expectedAppId) => ipcRenderer.invoke('zip:process', zipPath, expectedAppId),
  cleanupZip: (manifestDir) => ipcRenderer.invoke('zip:cleanup', manifestDir),

  // Depot Downloads
  getDepotInventory: (opts) => ipcRenderer.invoke('depot:inventory', opts),
  startDownload: (opts) => ipcRenderer.invoke('depot:download', opts),
  pauseDownload: () => ipcRenderer.invoke('depot:pause'),
  resumeDownload: () => ipcRenderer.invoke('depot:resume'),
  cancelDownload: () => ipcRenderer.invoke('depot:cancel'),
  respondToDownloadAuthChallenge: (response) => ipcRenderer.invoke('depot:authResponse', response),

  onDownloadProgress: (cb) => onIpc('depot:progress', cb),
  onDownloadPercentage: (cb) => onIpc('depot:percentage', cb),
  onDownloadSpeed: (cb) => onIpc('depot:speed', cb),
  onDownloadPlan: (cb) => onIpc('depot:plan', cb),
  onDownloadDiskSpeed: (cb) => onIpc('depot:diskspeed', cb),
  onDownloadTransferred: (cb) => onIpc('depot:transferred', cb),
  onOnlineReapplied: (cb) => onIpc('online:reapplied', cb),

  // Online mode: play through a real Steam session instead of the emulator.
  getOnlineStatus: (game) => ipcRenderer.invoke('online:status', game),
  setOnlineMode: (opts) => ipcRenderer.invoke('online:set', opts),

  // Greffon PEAK : rejoindre un ami sans partager son application Steam.
  getPeakModStatus: (game) => ipcRenderer.invoke('peakmod:status', game),
  setPeakMod: (opts) => ipcRenderer.invoke('peakmod:set', opts),

  // Moteur générique : le même service pour tout jeu Unity/Photon reconnu.
  getPhotonModStatus: (game) => ipcRenderer.invoke('photonmod:status', game),
  setPhotonMod: (opts) => ipcRenderer.invoke('photonmod:set', opts),

  // Co-op presets: games set up for playing together on first download/launch.
  listPresets: (games) => ipcRenderer.invoke('presets:list', games),
  onPresetApplied: (cb) => onIpc('preset:applied', cb),

  // Librarian's own updates (installer builds only; inert elsewhere).
  getAppUpdate: () => ipcRenderer.invoke('app-update:state'),
  checkAppUpdate: () => ipcRenderer.invoke('app-update:check'),
  installAppUpdate: () => ipcRenderer.invoke('app-update:install'),
  onAppUpdate: (cb) => onIpc('app-update:state', cb),

  getDlssgStatus: (game, selection) => ipcRenderer.invoke('dlssg:status', game, selection),
  setDlssg: (opts) => ipcRenderer.invoke('dlssg:set', opts),
  getDlssgUpdates: () => ipcRenderer.invoke('dlssg:updates-state'),
  checkDlssgUpdates: () => ipcRenderer.invoke('dlssg:updates-check'),
  updateAllDlssg: (checkId) => ipcRenderer.invoke('dlssg:updates-apply', checkId),
  onDlssgUpdates: (cb) => onIpc('dlssg:updates-progress', cb),

  onDownloadComplete: (cb) => onIpc('depot:complete', cb),
  onDownloadError: (cb) => onIpc('depot:error', cb),
  onDownloadAuthChallenge: (cb) => onIpc('depot:auth-challenge', cb),

  // CS.RIN.RU: a second source beside Hubcap (src/core/csrin.js). A download
  // started here reports on the depot:* channels above and is cancelled with
  // cancelDownload, so the queue treats it like any other job.
  csrinStatus: () => ipcRenderer.invoke('csrin:status'),
  csrinSearch: (opts) => ipcRenderer.invoke('csrin:search', opts),
  csrinCancelSearch: () => ipcRenderer.invoke('csrin:cancelSearch'),
  csrinDownload: (opts) => ipcRenderer.invoke('csrin:download', opts),
  // Answer to a csrin:event of kind choose_folder: { folder } or { cancelled }.
  csrinChooseFolder: (response) => ipcRenderer.invoke('csrin:chooseFolder', response),
  // Releases are matched by patch number (src/core/patchVersion.js).
  csrinInstalledPatch: (game) => ipcRenderer.invoke('csrin:installedPatch', game),
  csrinSetInstalledPatch: (game, version) => ipcRenderer.invoke('csrin:setInstalledPatch', game, version),
  csrinTargetPatch: (appid) => ipcRenderer.invoke('csrin:targetPatch', appid),
  onCsrinLog: (cb) => onIpc('csrin:log', cb),
  onCsrinEvent: (cb) => onIpc('csrin:event', cb),

  // What's new: Denuvo titles on Steam's front page and the followed
  // member's posts on CS.RIN.RU (src/core/newsFeed.js).
  fetchNews: (opts) => ipcRenderer.invoke('news:fetch', opts),

  // Manifest packages: Hubcap, the steammanifest source, or both, as the
  // Manifest source setting says (main.js decides; src/core/steamManifest.js).
  searchGames: (query) => ipcRenderer.invoke('hubcap:search', query),
  downloadManifest: (appId) => ipcRenderer.invoke('hubcap:download', appId),
  // The local source: whether the project was found, where, how many depot
  // keys are known, and the sources in effect; its progress lines while it
  // checks or assembles a package.
  steamManifestStatus: () => ipcRenderer.invoke('steammanifest:status'),
  onSteamManifestLog: (cb) => onIpc('steammanifest:log', cb),

  // Steam Helpers
  findSteamInstall: () => ipcRenderer.invoke('steam:findInstall'),
  getSteamLibraries: () => ipcRenderer.invoke('steam:getLibraries'),
  getDepotInfo: (appId) => ipcRenderer.invoke('steam:getDepotInfo', appId),

  // Game Library
  scanGames: () => ipcRenderer.invoke('game:scan'),
  launchGame: (gameData) => ipcRenderer.invoke('game:launch', gameData),
  stopGame: (gameKey) => ipcRenderer.invoke('game:stop', gameKey),
  getRunningGames: () => ipcRenderer.invoke('game:running'),
  detectExecutables: (gameData) => ipcRenderer.invoke('game:detectExecutables', gameData),
  setGameExecutable: (gameData, executable) => ipcRenderer.invoke('game:setExecutable', gameData, executable),
  getGameMeta: (gameData) => ipcRenderer.invoke('game:getMeta', gameData),
  getGameMedia: (appId) => ipcRenderer.invoke('steam:getGameMedia', appId),
  getStoreFront: (opts) => ipcRenderer.invoke('store:getFront', opts),
  resolveGameArt: (appId) => ipcRenderer.invoke('art:resolve', appId),
  clearArtCache: () => ipcRenderer.invoke('art:clearCache'),
  probeArt: (urls) => ipcRenderer.invoke('art:probe', urls),
  artProbeStats: () => ipcRenderer.invoke('art:probeStats'),

  dlcStatus: (gamePath) => ipcRenderer.invoke('dlc:status', gamePath),
  listDlc: (appId) => ipcRenderer.invoke('dlc:list', appId),
  applyDlc: (options) => ipcRenderer.invoke('dlc:apply', options),
  disableDlc: (gamePath) => ipcRenderer.invoke('dlc:disable', gamePath),
  onGameSession: (cb) => onIpc('game:session', cb),

  // Achievements, read from the offline emulator's own save file.
  getAchievements: (game) => ipcRenderer.invoke('achievements:snapshot', game),
  fetchAchievementDefinitions: (game) => ipcRenderer.invoke('achievements:fetchDefinitions', game),
  onAchievementUnlocked: (cb) => onIpc('achievement:unlocked', cb),
  uninstallGame: (gameData) => ipcRenderer.invoke('game:uninstall', gameData),
  getUninstallMessage: (gameData) => ipcRenderer.invoke('game:uninstallMessage', gameData),
  checkGameUpdate: (appId, localBuildId, options) => ipcRenderer.invoke('game:checkUpdate', appId, localBuildId, options),
  checkAllGameUpdates: (games, options) => ipcRenderer.invoke('game:checkAllUpdates', games, options),
  detectAppId: (gamePath) => ipcRenderer.invoke('game:detectAppId', gamePath),
  suggestAppId: (gameName) => ipcRenderer.invoke('game:suggestAppId', gameName),
  folderSize: (dirPath) => ipcRenderer.invoke('game:folderSize', dirPath),

  // Custom Games
  addCustomGame: (data) => ipcRenderer.invoke('customGame:add', data),
  updateCustomGame: (id, data) => ipcRenderer.invoke('customGame:update', id, data),
  removeCustomGame: (id) => ipcRenderer.invoke('customGame:remove', id),
  inspectCustomUpdates: (id, options) => ipcRenderer.invoke('customGame:inspectUpdates', id, options),
  associateCustomUpdates: (id, options) => ipcRenderer.invoke('customGame:associateUpdates', id, options),
  disconnectCustomUpdates: (id) => ipcRenderer.invoke('customGame:disconnectUpdates', id),
  refreshCustomUpdates: (id) => ipcRenderer.invoke('customGame:refreshUpdates', id),

  // Shell
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Cleanup of fetched manifest zips (userData only)
  cleanupFetchedZip: (filePath) => ipcRenderer.invoke('manifest:cleanupFetched', filePath),

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
  onCrackLog: (cb) => onIpc('crack:log', cb),
  onCrackStatus: (cb) => onIpc('crack:status', cb),
  onCrackBootstrap: (cb) => onIpc('crack:bootstrap', cb),

  // Patch notes / announcements
  getPatchNotes: (appId) => ipcRenderer.invoke('news:patchNotes', appId),

  // Tuning: the performance mode (src/core/tuning.js). State in one call,
  // the profile and per-game override to write, a live override for "try
  // it now", the A/B test, and the events that feed the page's tiles.
  tuningState: (gameKey) => ipcRenderer.invoke('tuning:state', gameKey),
  tuningSetProfile: (patch) => ipcRenderer.invoke('tuning:setProfile', patch),
  tuningSetOverride: (gameKey, value) => ipcRenderer.invoke('tuning:setOverride', gameKey, value),
  tuningSetLive: (pid, live) => ipcRenderer.invoke('tuning:setLive', pid, live),
  tuningRunAB: (opts) => ipcRenderer.invoke('tuning:runAB', opts),
  tuningCancelAB: () => ipcRenderer.invoke('tuning:cancelAB'),
  onTuningStats: (cb) => onIpc('tuning:stats', cb),
  onTuningSession: (cb) => onIpc('tuning:session', cb),
  onTuningAB: (cb) => onIpc('tuning:ab', cb),

  // Emulator compatibility (src/core/emuCompat.js): what the installed
  // emulator implements against what a game's build asks for, the newest
  // release, and the two actions. `emu:incompatible` arrives when a game that
  // just exited wrote a missing-interface report.
  emuStatus: (game) => ipcRenderer.invoke('emu:status', game),
  emuUpdate: () => ipcRenderer.invoke('emu:update'),
  emuRecrack: (game) => ipcRenderer.invoke('emu:recrack', game),
  onEmuIncompatible: (cb) => onIpc('emu:incompatible', cb),
});
