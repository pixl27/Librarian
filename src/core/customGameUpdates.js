// Associate an existing installation without moving it or inventing a build.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const custom = require('./customGameStore');
const updates = require('./updateChecker');
const { parseInstalledManifests } = require('./gameManager');
const numeric = value => /^[1-9]\d{0,19}$/.test(String(value || '')) ? String(value) : '';
const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const samePath = (a, b) => Boolean(a && b && normalized(a) === normalized(b));
function realDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Select an absolute game folder.');
  const dir = fs.realpathSync(value);
  if (!fs.statSync(dir).isDirectory()) throw new Error('The game folder is not a directory.');
  const protectedFolders = [path.parse(dir).root, os.homedir(), ...['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos', 'AppData'].map(name => path.join(os.homedir(), name)), process.env.LOCALAPPDATA, process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], __dirname, path.resolve(__dirname, '../..')].filter(Boolean);
  if (protectedFolders.some(p => samePath(p, dir)) || ['steamapps', 'common', '.depotdownloader'].includes(path.basename(dir).toLowerCase())) throw new Error('Select the individual game folder, not a drive or shared installation folder.');
  return dir;
}
function getGame(id) {
  const game = custom.getById(id);
  if (!game) throw new Error('Custom game no longer exists.');
  return game;
}
function readManifest(file, appid, dir) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid or oversized app manifest.');
  const content = fs.readFileSync(file, 'utf8');
  if (!/^\s*"AppState"\s*\{/.test(content)) throw new Error('This file is not a Steam app manifest.');
  const value = key => content.match(new RegExp(`"${key}"\\s+"([^"\\r\\n]*)"`, 'i'))?.[1] || '';
  if (value('appid') !== appid) throw new Error('The manifest belongs to a different AppID.');
  const folder = value('installdir');
  if (!folder || folder.includes('..') || /[\\/:]/.test(folder) || !samePath(path.join(path.dirname(dir), folder), dir)) throw new Error('The manifest installation folder does not match this game folder.');
  const branch = value('BetaKey') || 'public';
  if (branch !== 'public') throw new Error(`This manifest uses branch "${branch}". Only the public branch is supported here.`);
  return { buildId: numeric(value('buildid')) || null, installedManifests: parseInstalledManifests(content), source: 'manifest', manifestPath: file, size: Number(value('SizeOnDisk')) || 0 };
}
function layout(dir, appid) {
  const marker = path.join(dir, '.DepotDownloader');
  const common = path.dirname(dir), steamapps = path.dirname(common);
  const steamLayout = path.basename(common).toLowerCase() === 'common' && path.basename(steamapps).toLowerCase() === 'steamapps';
  return {
    installPath: dir,
    manifestPath: steamLayout ? path.join(steamapps, `appmanifest_${appid}.acf`) : path.join(marker, `appmanifest_${appid}.acf`),
    cacheDir: steamLayout ? path.join(path.dirname(steamapps), 'depotcache') : path.join(marker, 'depotcache'),
    libraryPath: steamLayout ? path.dirname(steamapps) : null,
  };
}
function localState(game, { appid = game.appid, manifestPath = game.update_link?.imported_manifest, declaredBuild = game.update_link?.declared_build } = {}) {
  appid = numeric(appid);
  if (!appid) throw new Error('A valid Steam AppID is required.');
  if (declaredBuild && !numeric(declaredBuild)) throw new Error('Enter a numeric Steam build ID, not an executable version, or leave it empty.');
  const dir = realDirectory(game.install_path);
  const target = layout(dir, appid);
  // A completed update owns its record. An imported record is only a fallback.
  const candidates = [...new Set([target.manifestPath, manifestPath, path.join(dir, `appmanifest_${appid}.acf`)].filter(Boolean))];
  for (const file of candidates) {
    try { return { ...readManifest(file, appid, dir), appid, ...target, evidencePath: file }; }
    catch (error) { if (error.code === 'ENOENT' && file !== manifestPath) continue; throw error; }
  }
  return { appid, ...target, buildId: numeric(declaredBuild) || null, source: numeric(declaredBuild) ? 'declared' : 'unknown', installedManifests: {} };
}
function decorate(game) {
  if (game.update_link?.provider !== 'steam') return game;
  try {
    if (game.update_link.appid !== game.appid || !samePath(game.update_link.install_path, realDirectory(game.install_path))) throw new Error('The linked installation changed. Associate it again.');
    const local = localState(game);
    return { ...game, buildid: local.buildId, installed_manifests: local.installedManifests, installed_depots: Object.keys(local.installedManifests), build_source: local.source, update_branch: 'public', update_ready: true, update_error: '', size_on_disk: local.size || game.size_on_disk };
  } catch (error) { return { ...game, buildid: null, installed_manifests: {}, installed_depots: [], build_source: 'unknown', update_ready: false, update_error: error.message }; }
}
function assertInstallationIdentity(local) {
  // Run only while associating, not on every library refresh. A second AppID
  // must never silently adopt a folder already identified by a valid record.
  for (const dir of new Set([local.installPath, path.dirname(local.manifestPath)])) {
    let names;
    try { names = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const name of names) {
      const id = name.match(/^appmanifest_(\d+)\.acf$/i)?.[1];
      if (!id || id === local.appid) continue;
      let record;
      try { record = readManifest(path.join(dir, name), id, local.installPath); } catch { continue; }
      if (record) throw new Error(`This folder already has an app manifest for AppID ${id}. Use that AppID or correct the game folder.`);
    }
  }
}
async function inspect(id, options = {}) {
  const game = getGame(id);
  const local = localState(game, options);
  assertInstallationIdentity(local);
  let remote;
  try { remote = await updates.fetchRemote(local.appid, true); }
  catch (error) { remote = { error: error.message }; }
  const comparison = remote.error ? { status: 'error', reason: remote.error } : updates.decideUpdate({ localBuildId: local.buildId, installedManifests: local.installedManifests, ...remote });
  return { id, gameName: game.game_name, local, remote, comparison, linked: Boolean(game.update_link), revision: game.update_link?.revision || null };
}
function associate(id, options = {}) {
  const game = getGame(id);
  const local = localState(game, options);
  assertInstallationIdentity(local);
  if (options.expectedInstallPath && !samePath(options.expectedInstallPath, local.installPath)) throw new Error('The game folder changed. Inspect it again.');
  const other = custom.getAll().find(entry => entry.id !== id && entry.update_link && samePath(entry.update_link.install_path, local.installPath));
  if (other) throw new Error('This folder is already associated with another Custom entry.');
  const link = { provider: 'steam', appid: local.appid, branch: 'public', install_path: local.installPath, revision: crypto.randomUUID(), linked_at: Date.now(), declared_build: numeric(options.declaredBuild), imported_manifest: options.manifestPath || null };
  return decorate(custom.setUpdateLink(id, local.appid, link));
}
function disconnect(id) {
  const game = getGame(id);
  return custom.setUpdateLink(id, game.appid, null);
}
function validateTarget(game, revision) {
  if (!game.update_link || game.update_link.revision !== revision || game.update_link.appid !== game.appid) throw new Error('The update association changed. Prepare the update again.');
  const local = localState(game);
  if (!samePath(local.installPath, game.update_link.install_path)) throw new Error('The linked folder now points to another installation.');
  // No metadata/cache symlink may redirect writes outside this installation.
  for (const file of [path.join(local.installPath, '.DepotDownloader'), path.dirname(local.manifestPath), local.manifestPath, `${local.manifestPath}.tmp`, local.cacheDir]) {
    try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('A linked metadata path is a symbolic link. Restore an ordinary folder before updating.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return local;
}
async function prepareDownload(id, revision, expectedBuild, gameData, selectedDepots) {
  let game = getGame(id);
  validateTarget(game, revision);
  if (String(gameData.appid) !== game.appid) throw new Error('The downloaded manifest belongs to a different game.');
  const remote = await updates.fetchRemote(game.appid, true);
  if (remote.error) throw new Error(`Cannot verify the target build: ${remote.error}`);
  if (!numeric(expectedBuild) || String(remote.remoteBuildId) !== String(expectedBuild)) throw new Error('The public build changed or could not be verified. Check updates and prepare this job again.');
  const selected = Array.isArray(selectedDepots) ? selectedDepots.map(String) : [];
  if (!selected.length) throw new Error('Select at least one depot.');
  for (const depot of selected) {
    const expected = remote.remoteManifests?.[depot];
    if (!expected || String(gameData.manifests?.[depot]) !== String(expected)) throw new Error(`Depot ${depot} does not match public build ${expectedBuild}. Fetch a matching manifest before updating.`);
  }
  // The network await must not allow a changed association to redirect the job.
  game = getGame(id);
  const local = validateTarget(game, revision);
  if (local.buildId && BigInt(local.buildId) > BigInt(expectedBuild)) throw new Error('The recorded installed build is newer than public. Check the branch or correct the local build record before updating.');
  return { game, target: { installPath: local.installPath, manifestPath: local.manifestPath, cacheDir: local.cacheDir, validateAll: true }, gameData: { ...gameData, appid: game.appid, buildid: String(expectedBuild), install_path: local.installPath, installdir: path.basename(local.installPath), job_type: 'update', skip_auto_crack: true } };
}
module.exports = { inspect, associate, disconnect, decorate, localState, layout, prepareDownload };
