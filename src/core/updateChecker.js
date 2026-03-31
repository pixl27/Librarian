const fetch = require('node-fetch');

/**
 * Check if a game has an update available by comparing
 * the local buildId (from ACF) against the latest public
 * buildId from the steamcmd.net API.
 */
async function checkForUpdate(appId, localBuildId) {
  if (!appId || appId === '0') {
    return { status: 'unknown', reason: 'No AppID' };
  }

  try {
    const url = `https://api.steamcmd.net/v1/info/${appId}`;
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) {
      return { status: 'error', reason: `API returned ${res.status}` };
    }

    const data = await res.json();
    if (data.status !== 'success' || !data.data || !data.data[String(appId)]) {
      return { status: 'error', reason: 'Invalid API response' };
    }

    const appInfo = data.data[String(appId)];
    const branches = appInfo.depots?.branches || {};
    const publicBranch = branches.public || {};
    const remoteBuildId = publicBranch.buildid || null;

    if (!remoteBuildId) {
      return { status: 'unknown', reason: 'No public branch buildId found' };
    }

    if (!localBuildId || localBuildId === '0') {
      return {
        status: 'unknown',
        reason: 'No local buildId',
        remoteBuildId,
      };
    }

    const localNum = parseInt(localBuildId, 10);
    const remoteNum = parseInt(remoteBuildId, 10);

    if (remoteNum > localNum) {
      return {
        status: 'update_available',
        localBuildId,
        remoteBuildId,
        reason: `Build ${localBuildId} → ${remoteBuildId}`,
      };
    }

    return {
      status: 'up_to_date',
      localBuildId,
      remoteBuildId,
    };
  } catch (err) {
    return { status: 'error', reason: err.message };
  }
}

/**
 * Check updates for multiple games in parallel.
 * @param {Array} games — array of { appid, buildid } objects
 * @returns {Object} — map of appId → update result
 */
async function checkAllUpdates(games) {
  const results = {};
  const validGames = games.filter(g => g.appid && g.appid !== '0');

  // Process in batches of 5 to avoid hammering the API
  const BATCH_SIZE = 5;
  for (let i = 0; i < validGames.length; i += BATCH_SIZE) {
    const batch = validGames.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (game) => {
      const result = await checkForUpdate(game.appid, game.buildid);
      results[game.appid] = result;
    });
    await Promise.all(promises);
  }

  return results;
}

module.exports = { checkForUpdate, checkAllUpdates };
