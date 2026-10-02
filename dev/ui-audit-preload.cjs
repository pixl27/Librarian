// Demonstration backend for the renderer audit. No production IPC is invoked.
const { contextBridge, ipcRenderer } = require('electron');
const fixture = ipcRenderer.sendSync('ui-audit:fixture');
const settings = fixture.settings;
const api = {};
for (const name of fixture.apiNames) {
  if (name.startsWith('on')) { api[name] = () => () => {}; continue; }
  api[name] = async (...args) => {
    ipcRenderer.send('ui-audit:call', name);
    if (name === 'getCachedGames') return { games: fixture.games, warnings: [] };
    if (name === 'scanGames') return fixture.games;
    if (name === 'getQueue') return { jobs: [], active: null };
    if (name === 'getAllSettings') return settings;
    if (name === 'getSetting') return settings[args[0]];
    if (name === 'setSetting') { settings[args[0]] = args[1]; return true; }
    if (name === 'setSettings') { Object.assign(settings, args[0]); return settings; }
    if (name === 'getVersion') return '1.1.0 (UI fixture)';
    if (['getRunningGames', 'getSteamLibraries', 'listInstallLocations', 'detectExecutables', 'searchGames', 'listDlc'].includes(name)) return [];
    if (name === 'getPatchNotes') return { items: [], error: null };
    if (['isFullScreen', 'isMaximized'].includes(name)) return false;
    if (name === 'crackCheckGoldberg') return { cliExists: false, goldbergExists: false };
    if (name === 'csrinStatus') return { cliExists: false, dlExists: false };
    if (name === 'checkAllGameUpdates') return {};
    if (name === 'getGameMeta') return args[0]?.meta || {};
    if (name === 'getGameMedia') return { name: 'Demonstration game', short_description: 'Local UI audit fixture.', genres: ['Adventure'], categories: ['Single-player'], developers: ['Fixture'], publishers: ['Fixture'], screenshots: [], movies: [] };
    if (name === 'getStoreFront') return { ok: true, spotlight: [], rails: [] };
    if (['resolveGameArt', 'probeArt'].includes(name)) return {};
    if (name === 'tuningState') return { profile: settings.tuning, available: {}, topology: {}, display: null, sessions: [], override: 'inherit', ab: false };
    if (name === 'getAchievements') return { total: 0, unlocked: 0, items: [] };
    if (name === 'getDlssgStatus') return { ok: true, visible: false };
    if (name === 'fetchNews') return { checkedAt: Date.now(), csrin: { items: [] }, denuvo: { items: [] } };
    if (name === 'getDiskSpace') return { free: 100 * 1024 ** 3, total: 500 * 1024 ** 3 };
    if (name === 'launchGame') return { success: true, alreadyRunning: true };
    return null;
  };
}
api.platform = 'win32';
contextBridge.exposeInMainWorld('api', api);
