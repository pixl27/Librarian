const { parentPort, workerData } = require('worker_threads');
const { getSteamLibraries } = require('./steamHelpers');
const { scanSteamLibraries } = require('./gameManager');
try {
  const libraries = workerData?.libraries || getSteamLibraries();
  const warnings = [];
  const games = scanSteamLibraries(libraries, warnings);
  parentPort.postMessage({ games, libraries, warnings });
} catch (error) { parentPort.postMessage({ error: error.message }); }
