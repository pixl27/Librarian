const { Worker } = require('worker_threads');
const path = require('path');
const { app } = require('electron');
const json = require('./jsonFile');
const meta = require('./gameMetaStore');
const custom = require('./customGameStore');
const settings = require('./settingsStore');
let pending = null;
let snapshot = null;
const cachePath = () => path.join(app.getPath('userData'), 'librarian-library-cache.json');
const key = value => process.platform === 'win32' ? String(value).toLowerCase() : String(value);

function cached() {
  if (!snapshot) snapshot = json.read(cachePath(), { games: [], warnings: [], scannedAt: 0 }, value => Array.isArray(value?.games));
  const customs = custom.getAll().map(g => require('./customGameUpdates').decorate(g));
  const linkedPaths = new Set(customs.filter(g => g.update_link).map(g => key(path.resolve(g.install_path))));
  return { ...snapshot, games: snapshot.games.filter(g => g.source !== 'Custom' && !linkedPaths.has(key(path.resolve(g.install_path)))).concat(customs).map(g => meta.decorate(g)) };
}

function scan() {
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'libraryWorker.js'), { workerData: { settings: {
      steam_path: settings.get('steam_path'), default_install_path: settings.get('default_install_path'), install_locations: settings.get('install_locations'),
    } } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Library scan timed out. The previous library has been kept.')); }, 120000);
    worker.once('message', result => {
      clearTimeout(timer);
      if (result.error) { reject(new Error(result.error)); return; }
      try {
        const previous = cached();
        const failed = new Set(result.warnings.map(w => key(w.path)));
        const seen = new Set(result.games.map(g => key(g.install_path)));
        const retained = previous.games.filter(g => g.source !== 'Custom' && failed.has(key(g.library_path)) && !seen.has(key(g.install_path)))
          .map(g => ({ ...g, unavailable: true }));
        const games = [...result.games, ...retained];
        meta.recordDiscovery([...games, ...custom.getAll()]);
        const next = { games, warnings: result.warnings, libraries: result.libraries, scannedAt: Date.now() };
        json.write(cachePath(), next);
        snapshot = next;
        resolve(cached());
      } catch (error) { reject(error); }
    });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error(`Library worker exited (${code})`)); });
  }).finally(() => { pending = null; });
  return pending;
}
module.exports = { cached, scan };
