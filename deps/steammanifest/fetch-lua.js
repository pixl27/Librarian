#!/usr/bin/env node
'use strict';

/**
 * Generate SteamTools .lua script directly from Steam CM metadata and known depot keys.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

const { AnonymousCMClient } = require('./re/cm_client');
const { httpGet } = require('./re/http');
const { uint32 } = require('./re/ids');

const USAGE = `Usage: node fetch-lua.js <appid> [options]

  <appid>               App ID, Steam store URL, or game name
                        (e.g. 1007, 1510440 or "honeycomb the world beyond")

Options:
  --key <hex>           Depot decryption key (64 hex characters) to use/save
  --depot <id>          Depot ID that the --key belongs to
  --branch <name>       Branch to query manifest IDs from (default: public)
  --os <name>           Filter depots by OS (windows, linux, macos, or all; default: all)
  --free                Generate depot entries for free game (clean addappid without missing key comments)
  --allow-missing-keys  Generate addappid without keys if not in database
  --out <dir>           Output directory for the .lua file (default: ./manifests/<appid>)
  --keys-file <file>    Path to depot keys JSON database (default: ./depot_keys.json)
  --print-only          Print Lua script to stdout without saving to disk
  -h, --help            Show this help`;

function parseCliOptions(args = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        key: { type: 'string' },
        depot: { type: 'string' },
        branch: { type: 'string', default: 'public' },
        os: { type: 'string', default: 'all' },
        free: { type: 'boolean', default: false },
        'allow-missing-keys': { type: 'boolean', default: false },
        out: { type: 'string' },
        'keys-file': { type: 'string', default: 'depot_keys.json' },
        'print-only': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    throw new Error(err.message);
  }

  const { values, positionals } = parsed;
  if (values.help) {
    return { help: true };
  }
  if (positionals.length === 0) {
    throw new Error('Missing <appid>.');
  }

  return {
    appInput: positionals.join(' '),
    key: values.key,
    depot: values.depot,
    branch: values.branch,
    os: values.os.toLowerCase(),
    free: values.free,
    allowMissingKeys: values['allow-missing-keys'],
    out: values.out,
    keysFile: values['keys-file'],
    printOnly: values['print-only'],
  };
}

async function fetchLuaData(client, appid, options = {}) {
  const branch = options.branch || 'public';
  const osFilter = options.os ? options.os.toLowerCase() : 'all';

  const { apps } = await client.getProductInfo([appid], [], true);
  const appinfo = apps[appid] && apps[appid].appinfo;
  if (!appinfo || !appinfo.common) {
    throw new Error(`Steam returned no info for app ${appid}. Check the app ID.`);
  }

  const gameName = appinfo.common.name || ('App ' + appid);
  const isFree = options.free || appinfo.common.type === 'Demo' || appinfo.common.type === 'Tool' || appinfo.extended?.isfreeapp === '1';

  const mainDepots = [];
  const sharedDepotIds = [];
  const sharedFromApps = new Set();
  const dlcs = [];

  // Parse DLCs from extended metadata
  if (appinfo.extended && appinfo.extended.listofdlc) {
    const list = String(appinfo.extended.listofdlc).split(',').map(s => s.trim()).filter(Boolean);
    for (const dlcId of list) {
      if (/^\d+$/.test(dlcId)) dlcs.push({ dlcId: Number(dlcId), name: '' });
    }
  }

  for (const [key, depot] of Object.entries((appinfo && appinfo.depots) || {})) {
    if (!/^\d+$/.test(key)) continue;
    const depotId = key;

    // Track DLC appid if listed in depot
    if (depot.dlcappid && !dlcs.some(d => String(d.dlcId) === String(depot.dlcappid))) {
      dlcs.push({ dlcId: Number(depot.dlcappid), name: depot.name || '' });
    }

    // OS filter check: if depot specifies oslist, match against filter
    const depotOs = (depot.config && depot.config.oslist) || '';
    if (osFilter !== 'all' && depotOs) {
      const allowed = depotOs.split(',').map(s => s.trim().toLowerCase());
      if (!allowed.includes(osFilter)) {
        continue;
      }
    }

    if (depot.depotfromapp) {
      sharedDepotIds.push({ depotId, fromApp: depot.depotfromapp, os: depotOs, name: depot.name || '' });
      sharedFromApps.add(depot.depotfromapp);
      continue;
    }

    const m = depot.manifests && depot.manifests[branch];
    if (m) {
      const manifestId = typeof m === 'object' ? m.gid : m;
      const downloadSize = typeof m === 'object' ? (m.download || m.size || '0') : '0';
      mainDepots.push({
        depotId,
        manifestId,
        downloadSize,
        os: depotOs,
        name: depot.name || '',
      });
    }
  }

  // Resolve shared apps info
  const sharedDepotEntries = [];
  if (sharedFromApps.size > 0) {
    const sharedAppsList = [...sharedFromApps].map(id => Number(id));
    const { apps: sharedAppsRes } = await client.getProductInfo(sharedAppsList, [], true);
    for (const item of sharedDepotIds) {
      const parentApp = sharedAppsRes[item.fromApp]?.appinfo;
      const parentName = parentApp?.common?.name || ('App ' + item.fromApp);
      const parentDepot = parentApp?.depots?.[item.depotId];
      const m = parentDepot?.manifests?.[branch];
      if (m) {
        const manifestId = typeof m === 'object' ? m.gid : m;
        const downloadSize = typeof m === 'object' ? (m.download || m.size || '0') : '0';
        sharedDepotEntries.push({
          depotId: item.depotId,
          manifestId,
          downloadSize,
          parentName,
          os: item.os || (parentDepot?.config?.oslist) || '',
        });
      }
    }
  }

  return {
    appid,
    gameName,
    isFree,
    mainDepots,
    sharedDepots: sharedDepotEntries,
    dlcs,
  };
}

function buildLuaScript(data, keysDb = {}, options = {}) {
  const { appid, gameName, mainDepots, sharedDepots, dlcs, isFree } = data;
  const allowMissing = options.allowMissingKeys || options.free || isFree;

  const scriptLines = [];
  scriptLines.push(`--Gamename ${gameName}`);
  scriptLines.push(`addappid(${appid}) --Mainappid ${gameName}`);

  // DLCs
  if (dlcs && dlcs.length > 0) {
    scriptLines.push('');
    scriptLines.push('--DLCs');
    for (const dlc of dlcs) {
      const desc = dlc.name ? ` --DLC ${dlc.name}` : ` --DLC ${dlc.dlcId}`;
      scriptLines.push(`addappid(${dlc.dlcId})${desc}`);
    }
  }

  // Main Depots
  if (mainDepots.length > 0) {
    scriptLines.push('');
    scriptLines.push('--Main Depots');
    for (const d of mainDepots) {
      const key = keysDb[d.depotId];
      const osDesc = d.os ? (d.os.charAt(0).toUpperCase() + d.os.slice(1) + ' ') : '';
      if (key) {
        scriptLines.push(`addappid(${d.depotId}, 1, "${key}") --Main ${osDesc}Depot ${gameName}`);
      } else if (allowMissing) {
        scriptLines.push(`addappid(${d.depotId}, 1) --Main ${osDesc}Depot ${gameName}`);
      } else {
        scriptLines.push(`-- addappid(${d.depotId}, 1, "TODO_DEPOT_KEY") --Main ${osDesc}Depot ${gameName} (Missing key)`);
      }
      scriptLines.push(`setManifestid(${d.depotId}, "${d.manifestId}", ${d.downloadSize})`);
    }
  }

  // Shared Depots
  if (sharedDepots.length > 0) {
    scriptLines.push('');
    scriptLines.push('--Share Depots');
    for (const d of sharedDepots) {
      const key = keysDb[d.depotId];
      const osDesc = d.os ? (d.os.charAt(0).toUpperCase() + d.os.slice(1) + ' ') : '';
      if (key) {
        scriptLines.push(`addappid(${d.depotId}, 1, "${key}") --Share ${osDesc}Depot ${d.parentName}`);
      } else if (allowMissing) {
        scriptLines.push(`addappid(${d.depotId}, 1) --Share ${osDesc}Depot ${d.parentName}`);
      } else {
        scriptLines.push(`-- addappid(${d.depotId}, 1, "TODO_DEPOT_KEY") --Share ${osDesc}Depot ${d.parentName} (Missing key)`);
      }
      scriptLines.push(`setManifestid(${d.depotId}, "${d.manifestId}", ${d.downloadSize})`);
    }
  }

  return scriptLines.join('\n') + '\n';
}

async function generateLua(appInput, options = {}) {
  const app = await resolveApp(String(appInput));
  const keysPath = path.resolve(options.keysFile || 'depot_keys.json');
  let keysDb = {};
  try {
    if (fs.existsSync(keysPath)) {
      keysDb = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
    }
  } catch (e) {}

  if (options.key) {
    const cleanKey = options.key.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/i.test(cleanKey)) {
      throw new Error('Depot key must be exactly 64 hexadecimal characters (32 bytes).');
    }
    if (options.depot) {
      keysDb[String(options.depot).trim()] = cleanKey;
    }
  }

  const client = options.client || new AnonymousCMClient();
  const ownClient = !options.client;
  try {
    if (ownClient) {
      process.stdout.write('Connecting to Steam anonymously...');
      await client.connect();
      console.log(' OK\n');
    }

    const data = await fetchLuaData(client, app.appid, options);

    // Save key if user passed a key without --depot and there is exactly one main depot
    if (options.key && !options.depot && data.mainDepots.length === 1) {
      keysDb[data.mainDepots[0].depotId] = options.key.trim().toLowerCase();
    }

    // Save updated keys database
    try {
      fs.writeFileSync(keysPath, JSON.stringify(keysDb, null, 2) + '\n');
    } catch (e) {}

    const luaScript = buildLuaScript(data, keysDb, options);

    let savedPath = null;
    if (!options.printOnly) {
      const outDir = options.out ? path.resolve(options.out) : path.resolve('manifests', String(app.appid));
      fs.mkdirSync(outDir, { recursive: true });
      savedPath = path.join(outDir, `${app.appid}.lua`);
      fs.writeFileSync(savedPath, luaScript, 'utf8');
    }

    return {
      appid: app.appid,
      gameName: data.gameName,
      data,
      luaScript,
      savedPath,
    };
  } finally {
    if (ownClient) {
      client.logOff();
    }
  }
}

async function resolveApp(input) {
  const text = input.trim();
  if (/^\d+$/.test(text)) {
    return { appid: uint32(text, 'app ID') };
  }
  const urlMatch = text.match(/(?:store\.steampowered\.com|steamdb\.info)\/app\/(\d+)/i);
  if (urlMatch) {
    return { appid: uint32(urlMatch[1], 'app ID') };
  }
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(text)}&l=english&cc=US`;
  const res = await httpGet(url);
  if (res.status !== 200) {
    throw new Error(`Steam store search failed (HTTP ${res.status}). Pass the app ID instead.`);
  }
  let items = (JSON.parse(res.body.toString('utf8')).items || []).filter((item) => item.type === 'app');
  if (items.length === 0) {
    throw new Error(`No Steam store results for "${text}". Pass the app ID instead.`);
  }
  const sideProduct = /\b(demo|playtest|soundtrack|ost|dedicated server|sdk)\b/i;
  if (!sideProduct.test(text)) {
    items = [...items.filter((item) => !sideProduct.test(item.name)), ...items.filter((item) => sideProduct.test(item.name))];
  }
  return { appid: items[0].id };
}

async function main() {
  let opts;
  try {
    opts = parseCliOptions();
  } catch (err) {
    console.error('Error:', err.message);
    console.log(USAGE);
    process.exit(1);
  }

  if (opts.help) {
    console.log(USAGE);
    return;
  }

  try {
    const result = await generateLua(opts.appInput, opts);
    console.log(`Game: ${result.gameName} (AppID ${result.appid})`);
    console.log('\n--- Generated SteamTools Lua Script ---');
    console.log(result.luaScript);
    if (result.savedPath) {
      console.log(`Saved Lua script to: ${result.savedPath}`);
    }
  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = {
  parseCliOptions,
  fetchLuaData,
  buildLuaScript,
  generateLua,
  resolveApp,
};
