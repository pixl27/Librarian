const os = require('os');
const path = require('path');
const fs = require('fs');

function findSteamInstall() {
  if (process.platform === 'win32') return _findSteamWindows();
  if (process.platform === 'linux') return _findSteamLinux();
  return null;
}

/** Settings are main-process only; outside Electron (tests) there are none. */
function settingsOrNull() {
  const { isMainThread, workerData } = require('worker_threads');
  if (!isMainThread && workerData?.settings) return { get: key => workerData.settings[key], set: () => {} };
  try { return require('./settingsStore'); } catch { return null; }
}

/**
 * A Steam folder, as opposed to something that merely claims to be one.
 *
 * Goldberg's ColdClientLoader — what a DenuvOwO release runs the game
 * through — points HKCU\Software\Valve\Steam\SteamPath at its own
 * `coldclient` folder while the game runs, and leaves it there if the game
 * dies. Taken at its word, that made the "Steam library" a folder with
 * three files in it and the library page a list of the games added by hand.
 * Measured 2026-09-04. A real Steam folder has a steamapps directory.
 */
function looksLikeSteam(p) {
  try { return Boolean(p) && fs.existsSync(path.join(p, 'steamapps')); } catch { return false; }
}
const hasSteamapps = looksLikeSteam;

function _findSteamWindows() {
  const settings = settingsOrNull();

  // The registry is the truth, asked of reg.exe by its full path: a portable
  // build can start with a PATH that has no System32 on it.
  try {
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    const result = require('child_process').execFileSync(
      fs.existsSync(reg) ? reg : 'reg',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { encoding: 'utf-8', windowsHide: true, timeout: 8000 }
    );
    const match = result.match(/SteamPath\s+REG_SZ\s+(.+)/);
    if (match) {
      const found = path.normalize(match[1].trim());
      if (looksLikeSteam(found)) {
        // Remembered, so a launch on which the registry cannot be asked, or
        // has been borrowed by a game's client loader, still finds the
        // library instead of showing only the games added by hand.
        try { if (settings && settings.get('steam_path') !== found) settings.set('steam_path', found); } catch { /* best effort */ }
        return found;
      }
    }
  } catch (e) { /* the fallbacks below */ }

  // Fallbacks, most specific first: the last path the registry gave, the
  // folder downloads go to (a Steam library, when that is how Librarian is
  // used), then the usual places.
  const candidates = [];
  if (settings) {
    try {
      candidates.push(settings.get('steam_path'));
      candidates.push(settings.get('default_install_path'));
      for (const loc of settings.get('install_locations') || []) candidates.push(loc);
    } catch { /* no settings */ }
  }
  candidates.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam', path.join(os.homedir(), 'Steam'));
  for (const p of candidates) {
    if (hasSteamapps(p)) return path.normalize(p);
  }
  return null;
}

function _findSteamLinux() {
  const home = os.homedir();
  const paths = [
    path.join(home, '.steam', 'steam'),
    path.join(home, '.local', 'share', 'Steam'),
  ];
  for (const p of paths) {
    if (fs.existsSync(path.join(p, 'steamapps'))) {
      return fs.realpathSync(p);
    }
  }
  return null;
}

function parseLibraryFolders(vdfPath) {
  const libraries = [];
  try {
    const content = fs.readFileSync(vdfPath, 'utf-8');
    const matches = content.match(/^\s*"(?:path|\d+)"\s*"(.*?)"/gm);
    if (matches) {
      for (const m of matches) {
        const pathMatch = m.match(/"(?:path|\d+)"\s*"(.*?)"/);
        if (pathMatch) {
          const p = pathMatch[1].replace(/\\\\/g, '\\');
          if (path.isAbsolute(p)) libraries.push(p);
        }
      }
    }
  } catch (e) { /* ignore */ }
  return libraries;
}

function getSteamLibraries() {
  const steamPath = findSteamInstall();
  const candidates = steamPath ? [steamPath] : [];
  if (steamPath) {
    const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
    if (fs.existsSync(vdfPath)) candidates.push(...parseLibraryFolders(vdfPath));
  }
  const settings = settingsOrNull();
  if (settings) candidates.push(settings.get('steam_path'), settings.get('default_install_path'), ...(settings.get('install_locations') || []));
  const libs = new Map();
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
    let resolved = path.resolve(candidate);
    try { resolved = fs.realpathSync(resolved); } catch { /* disconnected drive: retain the registration */ }
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!libs.has(key)) libs.set(key, resolved);
  }
  return [...libs.values()];
}

function killSteamProcess() {
  try {
    if (process.platform === 'win32') {
      require('child_process').execSync('taskkill /IM steam.exe /F', { stdio: 'ignore' });
    } else {
      require('child_process').execSync('pkill -9 steam', { stdio: 'ignore' });
    }
    return true;
  } catch { return false; }
}

function runDllInjector(steamPath) {
  if (process.platform !== 'win32') return false;
  const injectorPath = path.join(steamPath, 'DLLInjector.exe');
  if (!fs.existsSync(injectorPath)) return false;
  try {
    // cwd MUST be the Steam folder. DLLInjector.ini ships with
    // UseFullPathsFromIni = 0, so every path it names — Steam.exe, the
    // GreenLuma DLL, and BootImage (GreenLuma20xx_Files\BootImage.bmp, loaded
    // via GDI+ GetHBITMAP) — is resolved relative to the injector's working
    // directory. Spawned without cwd, it inherited Librarian's directory,
    // could not find the bitmap, and died with "GetHBITMAP Failed!" before it
    // ever touched Steam.
    require('child_process')
      .spawn(injectorPath, [], { cwd: steamPath, detached: true, stdio: 'ignore' })
      .unref();
    return true;
  } catch { return false; }
}

/**
 * Put HKCU\Software\Valve\Steam back the way Steam left it.
 *
 * A game run through a client loader (coldclient) borrows SteamPath and
 * ActiveProcess\SteamClientDll(64) for the length of the session and hands
 * them back on exit — unless it crashes, and then every program that asks
 * the registry where Steam is gets the game's folder. Steam repairs it
 * when it next starts; this does the same when it is safe to, i.e. when no
 * game launched from here is running. Windows only, best effort, and only
 * ever writes a folder that has been seen to be Steam.
 *
 * @returns {{ repaired: boolean, from?: string, to?: string }}
 */
function repairSteamRegistry() {
  if (process.platform !== 'win32') return { repaired: false };
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const exe = fs.existsSync(reg) ? reg : 'reg';
  const { execFileSync } = require('child_process');
  const query = (key, value) => {
    try {
      const out = execFileSync(exe, ['query', key, '/v', value], { encoding: 'utf-8', windowsHide: true, timeout: 8000 });
      const m = new RegExp(`${value}\\s+REG_SZ\\s+(.+)`).exec(out);
      return m ? m[1].trim() : '';
    } catch { return ''; }
  };
  const current = query('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  if (looksLikeSteam(current)) return { repaired: false };

  const settings = settingsOrNull();
  let good = '';
  try { good = settings ? settings.get('steam_path') : ''; } catch { good = ''; }
  if (!looksLikeSteam(good)) return { repaired: false };

  // Steam writes it with forward slashes; so does this, so nothing that
  // compares the string byte for byte sees a difference.
  const steamStyle = good.replace(/\\/g, '/');
  const set = (key, value, data) => execFileSync(exe, ['add', key, '/v', value, '/t', 'REG_SZ', '/d', data, '/f'], { windowsHide: true, timeout: 8000, stdio: 'ignore' });
  try {
    set('HKCU\\Software\\Valve\\Steam', 'SteamPath', steamStyle);
    const ap = 'HKCU\\Software\\Valve\\Steam\\ActiveProcess';
    for (const [value, file] of [['SteamClientDll', 'steamclient.dll'], ['SteamClientDll64', 'steamclient64.dll']]) {
      const dll = query(ap, value);
      if (dll && !dll.toLowerCase().startsWith(good.toLowerCase())) set(ap, value, path.join(good, file));
    }
    return { repaired: true, from: current, to: steamStyle };
  } catch (err) {
    return { repaired: false, error: err.message, from: current };
  }
}

module.exports = {
  findSteamInstall,
  getSteamLibraries,
  parseLibraryFolders,
  killSteamProcess,
  runDllInjector,
  repairSteamRegistry,
  looksLikeSteam,
};
