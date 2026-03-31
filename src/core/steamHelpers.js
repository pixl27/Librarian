const os = require('os');
const path = require('path');
const fs = require('fs');

function findSteamInstall() {
  if (process.platform === 'win32') return _findSteamWindows();
  if (process.platform === 'linux') return _findSteamLinux();
  return null;
}

function _findSteamWindows() {
  try {
    const reg = require('child_process');
    const result = reg.execSync(
      'reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath',
      { encoding: 'utf-8' }
    );
    const match = result.match(/SteamPath\s+REG_SZ\s+(.+)/);
    if (match) return path.normalize(match[1].trim());
  } catch (e) { /* ignore */ }
  
  // Fallback: common paths
  const common = [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    path.join(os.homedir(), 'Steam'),
  ];
  for (const p of common) {
    if (fs.existsSync(path.join(p, 'steamapps'))) return p;
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
          if (fs.existsSync(path.join(p, 'steamapps'))) {
            libraries.push(p);
          }
        }
      }
    }
  } catch (e) { /* ignore */ }
  return libraries;
}

function getSteamLibraries() {
  const steamPath = findSteamInstall();
  if (!steamPath) return [];

  const libs = new Set();
  libs.add(fs.realpathSync(steamPath));

  const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  if (fs.existsSync(vdfPath)) {
    for (const lib of parseLibraryFolders(vdfPath)) {
      try { libs.add(fs.realpathSync(lib)); } catch { libs.add(lib); }
    }
  }

  return Array.from(libs);
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
    require('child_process').spawn(injectorPath, [], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}

module.exports = {
  findSteamInstall,
  getSteamLibraries,
  parseLibraryFolders,
  killSteamProcess,
  runDllInjector,
};
