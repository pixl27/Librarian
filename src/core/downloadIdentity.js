const fs = require('fs');
const path = require('path');

function assertAppId(expected, actual) {
  const wanted = String(expected ?? '').trim();
  const received = String(actual ?? '').trim();
  if (!/^[1-9]\d{0,19}$/.test(received)) throw new Error('The manifest contains an invalid Steam AppID.');
  if (wanted && wanted !== received) {
    throw new Error(`Wrong game manifest: requested Steam AppID ${wanted}, received ${received}. Download stopped; no game files were changed. Retry the update from the intended game's details.`);
  }
  return received;
}

const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

// Updates keep the installation selected by the user, even if the archive or
// a later renderer message supplies a different title or destination.
function validateDownload(job, gameData, destPath) {
  if (!job) throw new Error('This download no longer exists in the queue.');
  const appid = assertAppId(job.appid, gameData?.appid);
  if (!['update', 'repair'].includes(job.jobType) || job.customGameId) return gameData;
  if (!job.appid || !job.destPath || !job.installDir) throw new Error('This saved update has incomplete game identity. Remove it and start Update again from the game details.');
  if (!samePath(job.destPath, destPath)) throw new Error('The update destination changed. Start Update again from the intended game details.');
  const folder = job.installDir;
  if (folder === '.' || folder === '..' || /[\\/:]/.test(folder)) throw new Error('Invalid update installation folder.');
  const installPath = path.join(job.destPath, 'steamapps', 'common', folder);
  if (job.installPath && !samePath(job.installPath, installPath)) throw new Error('The update folder does not match the selected installation. Rescan the library.');
  const manifestPath = path.join(job.destPath, 'steamapps', `appmanifest_${appid}.acf`);
  let content;
  try {
    if (fs.statSync(manifestPath).size > 2 * 1024 * 1024) throw new Error('Oversized manifest');
    content = fs.readFileSync(manifestPath, 'utf8');
  } catch { throw new Error('The installed game record is missing or unreadable. Rescan the library before updating.'); }
  const value = key => content.match(new RegExp(`"${key}"\\s+"([^"\\r\\n]*)"`, 'i'))?.[1];
  assertAppId(appid, value('appid'));
  if (!/^\s*"AppState"\s*\{/.test(content) || !value('installdir') || !samePath(installPath, path.join(job.destPath, 'steamapps', 'common', value('installdir')))) {
    throw new Error('The installed game record points to a different folder. Rescan the library before updating.');
  }
  if (!fs.statSync(installPath).isDirectory()) throw new Error('The selected game installation no longer exists. Rescan the library.');
  return { ...gameData, appid, game_name: job.name, installdir: folder, install_path: installPath, job_type: job.jobType };
}

module.exports = { assertAppId, samePath, validateDownload };
