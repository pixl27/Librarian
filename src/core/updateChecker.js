const fetch = require('node-fetch');

function normalizeAppId(appId) {
  const id = String(appId || '').trim();
  return /^\d{1,20}$/.test(id) ? id : null;
}

// Cache the remote answer per app so the automatic checks (startup scan,
// background refresh) don't hammer steamcmd.net. Only definitive lookups are
// cached; transient errors are not, so a one-off failure doesn't stick.
//
// A check the user asked for explicitly must pass { force: true }: reading a
// half-hour-old answer back to someone who just pressed "Check Updates" is
// indistinguishable from the button doing nothing.
const REMOTE_BUILD_TTL_MS = 30 * 60 * 1000;
const remoteCache = new Map(); // appId -> { remoteBuildId, remoteManifests, fetchedAt }

/**
 * The public manifest id of every depot the API describes.
 *
 * steamcmd.net has answered in two shapes over the years: `manifests.public`
 * as the gid string, and `manifests.public` as an object carrying `gid`.
 * Both are read.
 */
function extractPublicManifests(appInfo) {
  const out = {};
  const depots = appInfo?.depots;
  if (!depots || typeof depots !== 'object') return out;
  for (const [depotId, info] of Object.entries(depots)) {
    if (!/^\d+$/.test(depotId) || !info || typeof info !== 'object') continue;
    const pub = info.manifests?.public;
    const gid = typeof pub === 'string' ? pub : (pub && typeof pub === 'object' ? pub.gid : null);
    if (gid && /^\d+$/.test(String(gid))) out[depotId] = String(gid);
  }
  return out;
}

async function fetchRemote(safeAppId, force = false) {
  const cached = remoteCache.get(safeAppId);
  if (!force && cached && (Date.now() - cached.fetchedAt) < REMOTE_BUILD_TTL_MS) {
    return { ...cached };
  }

  const url = `https://api.steamcmd.net/v1/info/${safeAppId}`;
  const res = await fetch(url, { timeout: 15000 });
  if (!res.ok) {
    return { error: `API returned ${res.status}` };
  }

  const data = await res.json();
  if (data.status !== 'success' || !data.data || !data.data[safeAppId]) {
    return { error: 'Invalid API response' };
  }

  const appInfo = data.data[safeAppId];
  const branches = appInfo.depots?.branches || {};
  const publicBranch = branches.public || {};
  const remoteBuildId = publicBranch.buildid || null;
  const remoteManifests = extractPublicManifests(appInfo);
  // When the public build went live: what its patch number is read against
  // (src/core/patchVersion.js targetPatch).
  const remoteBuildTime = (Number(publicBranch.timebuildupdated || publicBranch.timeupdated) || 0) * 1000;

  const result = { remoteBuildId, remoteBuildTime, remoteManifests, gameName: appInfo.common?.name || '', fetchedAt: Date.now(), branch: 'public' };
  remoteCache.set(safeAppId, result);
  return { ...result };
}

/**
 * Decide from what is known. Pure, so it can be exercised without the network.
 *
 * Build ids are the first word: when both exist they decide, as they always
 * have. The manifest ids are the fallback for when they cannot — an install
 * adopted without a build id, a game whose public branch reports none — and
 * they are compared only for depots that are actually installed, since the
 * API describes every depot the app has ever had, DLC and betas included.
 *
 * They are deliberately *not* consulted when the build ids agree. Equal build
 * ids mean equal content; a difference in the manifest table at that point is
 * the API's cache lagging, and acting on it would start a re-download of a
 * build the user already has.
 *
 * @param {{localBuildId?:string, remoteBuildId?:string,
 *          installedManifests?:Object<string,string>,
 *          remoteManifests?:Object<string,string>}} facts
 */
function decideUpdate({ localBuildId, remoteBuildId, installedManifests, remoteManifests }) {
  const localNum = parseInt(localBuildId, 10);
  const remoteNum = parseInt(remoteBuildId, 10);
  const haveLocalBuild = Number.isFinite(localNum) && localNum > 0;
  const haveRemoteBuild = Number.isFinite(remoteNum) && remoteNum > 0;

  if (haveLocalBuild && haveRemoteBuild) {
    if (remoteNum > localNum) {
      return {
        status: 'update_available',
        localBuildId: String(localBuildId),
        remoteBuildId: String(remoteBuildId),
        reason: `Build ${localBuildId} → ${remoteBuildId}`,
      };
    }
    return { status: 'up_to_date', localBuildId: String(localBuildId), remoteBuildId: String(remoteBuildId) };
  }

  // Build ids cannot decide. Manifest ids can, for the depots on disk.
  const installed = Object.entries(installedManifests || {})
    .filter(([id, gid]) => /^\d+$/.test(id) && /^\d+$/.test(String(gid || '')));
  if (installed.length && remoteManifests && typeof remoteManifests === 'object') {
    const compared = installed.filter(([id]) => remoteManifests[id]);
    if (compared.length) {
      const changed = compared.filter(([id, gid]) => String(remoteManifests[id]) !== String(gid));
      if (changed.length) {
        const [firstId, firstGid] = changed[0];
        return {
          status: 'update_available',
          localBuildId: haveLocalBuild ? String(localBuildId) : null,
          remoteBuildId: haveRemoteBuild ? String(remoteBuildId) : null,
          reason: changed.length === 1
            ? `Depot ${firstId}: manifest ${firstGid} → ${remoteManifests[firstId]}`
            : `${changed.length} installed depots have newer manifests`,
        };
      }
      return {
        status: 'up_to_date',
        localBuildId: haveLocalBuild ? String(localBuildId) : null,
        remoteBuildId: haveRemoteBuild ? String(remoteBuildId) : null,
        reason: `${compared.length} installed depot(s) match the public manifests`,
      };
    }
  }

  if (!haveRemoteBuild) {
    return { status: 'unknown', reason: 'No public branch buildId found' };
  }
  return {
    status: 'unknown',
    reason: 'No local buildId',
    remoteBuildId: String(remoteBuildId),
  };
}

/**
 * Check if a game has an update available.
 *
 * @param options.force               bypass the cache (a user-initiated check)
 * @param options.installedManifests  { depotId: manifestId } from the ACF, so
 *                                    an install with no build id can still be
 *                                    compared against the public manifests
 */
async function checkForUpdate(appId, localBuildId, options = {}) {
  const safeAppId = normalizeAppId(appId);
  if (!safeAppId || safeAppId === '0') {
    return { status: 'unknown', reason: 'No AppID' };
  }

  try {
    const remote = await fetchRemote(safeAppId, Boolean(options.force));
    if (remote.error) {
      return { status: 'error', reason: remote.error };
    }
    return decideUpdate({
      localBuildId,
      remoteBuildId: remote.remoteBuildId,
      installedManifests: options.installedManifests || null,
      remoteManifests: remote.remoteManifests || null,
    });
  } catch (err) {
    return { status: 'error', reason: err.message };
  }
}

/**
 * Check updates for multiple games in parallel.
 * @param {Array} games — array of { appid, buildid, installed_manifests? } objects
 * @returns {Object} — map of appId → update result
 */
async function checkAllUpdates(games, options = {}) {
  const results = {};
  const validGames = games
    .map(g => ({ ...g, appid: normalizeAppId(g.appid) }))
    .filter(g => g.appid && g.appid !== '0');

  // Process in batches of 5 to avoid hammering the API
  const BATCH_SIZE = 5;
  for (let i = 0; i < validGames.length; i += BATCH_SIZE) {
    const batch = validGames.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (game) => {
      const result = await checkForUpdate(game.appid, game.buildid, {
        ...options,
        installedManifests: game.installed_manifests || options.installedManifests || null,
      });
      const key = /^custom:[\w-]+$/.test(game.result_key || '') ? game.result_key : game.appid;
      results[key] = result;
    });
    await Promise.all(promises);
    // Small courtesy delay between batches so a large library doesn't get rate-limited.
    if (i + BATCH_SIZE < validGames.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return results;
}

module.exports = { checkForUpdate, checkAllUpdates, decideUpdate, extractPublicManifests, fetchRemote };
