#!/usr/bin/env node
'use strict';

/**
 * Free Game Assembler: Combines Steam CM metadata, Lua generator,
 * direct Steam CDN manifest fetcher, and robust XYZ proxy fallback
 * to assemble complete playable packages for SteamTools.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

const { AnonymousCMClient } = require('./re/cm_client');
const { downloadFromCdn, manifestToJson, AccessDeniedError } = require('./fetch-manifest');
const { fetchLuaData, buildLuaScript, resolveApp } = require('./fetch-lua');
const { XyzClient, XyzError, DEFAULT_ENDPOINT } = require('./re/xyz_client');
const ContentManifest = require('./re/manifest_format');
const { uint32, uint64 } = require('./re/ids');

const USAGE = `Usage: node assemble.js <appid> [options]

  <appid>               Steam App ID (e.g. 1007, 730, 440)

Options:
  --branch <name>       Branch to query manifests from (default: public)
  --os <name>           OS filter for depots (windows, linux, macos, all; default: windows)
  --source <strategy>   Manifest source: auto, cdn-first, xyz-first, cdn-only, xyz-only
                        (default: auto)
  --endpoint <url>      XYZ mirror endpoint (default: ${DEFAULT_ENDPOINT})
  --token <token>       XYZ authentication token (or XYZ_TOKEN env)
  --out <dir>           Output root directory (default: ./manifests/<appid>)
  --keys-file <file>    Path to depot keys JSON (default: ./depot_keys.json)
  --free                Explicitly treat as free game / unencrypted depots
  --allow-missing-keys  Allow assembling even if depot keys are unknown
  --force               Re-download manifests even if they already exist on disk
  -h, --help            Show this help`;

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        branch: { type: 'string', default: 'public' },
        os: { type: 'string', default: 'windows' },
        source: { type: 'string', default: 'auto' },
        endpoint: { type: 'string' },
        token: { type: 'string' },
        out: { type: 'string' },
        'keys-file': { type: 'string', default: 'depot_keys.json' },
        free: { type: 'boolean', default: false },
        'allow-missing-keys': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    console.error('Error:', err.message);
    console.log(USAGE);
    process.exit(1);
  }

  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (positionals.length === 0) {
    console.error('Error: Missing <appid>.\n');
    console.log(USAGE);
    process.exit(1);
  }

  return {
    appInput: positionals.join(' '),
    branch: values.branch,
    os: values.os.toLowerCase(),
    source: values.source.toLowerCase(),
    endpoint: values.endpoint,
    token: values.token,
    out: values.out,
    keysFile: values['keys-file'],
    free: values.free,
    allowMissingKeys: values['allow-missing-keys'],
    force: values.force,
  };
}

async function assembleGame(appInput, options = {}) {
  const branch = options.branch || 'public';
  const osFilter = options.os || 'windows';
  const sourceStrategy = options.source || 'auto';

  const app = await resolveApp(String(appInput));
  const appid = app.appid;

  const outDir = options.out ? path.resolve(options.out) : path.resolve('manifests', String(appid));
  fs.mkdirSync(outDir, { recursive: true });

  const keysPath = path.resolve(options.keysFile || 'depot_keys.json');
  let keysDb = {};
  try {
    if (fs.existsSync(keysPath)) {
      keysDb = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
    }
  } catch (_) {}

  const xyzClient = new XyzClient({
    endpoint: options.endpoint,
    token: options.token,
  });

  const client = options.client || new AnonymousCMClient();
  const ownClient = !options.client;

  const summary = {
    appid,
    gameName: '',
    branch,
    os: osFilter,
    assembledAt: new Date().toISOString(),
    luaFile: null,
    dlcs: [],
    depots: [],
    status: 'pending',
  };

  try {
    if (ownClient) {
      process.stdout.write('Connecting to Steam anonymously...');
      await client.connect();
      console.log(' OK');
    }

    console.log(`\n=== 1. Querying App ${appid} Metadata ===`);
    const luaData = await fetchLuaData(client, appid, {
      branch,
      os: osFilter,
      free: options.free,
      allowMissingKeys: options.allowMissingKeys,
    });

    summary.gameName = luaData.gameName;
    summary.isFree = luaData.isFree;
    summary.dlcs = luaData.dlcs;

    console.log(`Title: ${luaData.gameName} (AppID ${appid})`);
    console.log(`Type:  ${luaData.isFree ? 'Free App / Tool / Demo' : 'Commercial App'}`);
    if (luaData.dlcs.length > 0) {
      console.log(`DLCs:  ${luaData.dlcs.map((d) => d.dlcId + (d.name ? ` (${d.name})` : '')).join(', ')}`);
    }

    // Step 2: Build and save Lua script
    console.log(`\n=== 2. Generating SteamTools Lua Script ===`);
    const luaScript = buildLuaScript(luaData, keysDb, {
      free: options.free || luaData.isFree,
      allowMissingKeys: options.allowMissingKeys,
    });

    const luaPath = path.join(outDir, `${appid}.lua`);
    fs.writeFileSync(luaPath, luaScript, 'utf8');
    summary.luaFile = path.relative(process.cwd(), luaPath);
    console.log(`Saved Lua script: ${summary.luaFile}`);

    // Collect all depots to download
    const targetDepots = [
      ...luaData.mainDepots.map((d) => ({ ...d, type: 'main', parentApp: appid })),
      ...luaData.sharedDepots.map((d) => ({ ...d, type: 'shared', parentApp: d.parentApp || appid })),
    ];

    console.log(`\n=== 3. Acquiring Manifests (${targetDepots.length} depot(s)) ===`);
    let savedCount = 0;
    let failedCount = 0;

    for (const d of targetDepots) {
      const depotId = d.depotId;
      const manifestId = d.manifestId;
      const base = path.join(outDir, `${depotId}_${manifestId}`);
      const manifestFile = `${base}.manifest`;
      const jsonFile = `${base}.json`;

      const depotEntry = {
        depotId,
        manifestId,
        os: d.os || 'all',
        type: d.type,
        downloadSize: d.downloadSize,
        source: null,
        status: 'pending',
      };

      // Check if already on disk
      if (!options.force && fs.existsSync(manifestFile) && fs.existsSync(jsonFile)) {
        try {
          const existingData = fs.readFileSync(manifestFile);
          const manifest = ContentManifest.parseManifest(existingData);
          if (String(manifest.depot_id) === String(depotId) && String(manifest.gid_manifest) === String(manifestId)) {
            console.log(`Depot ${depotId} (${manifestId}): Existing manifest verified on disk.`);
            depotEntry.source = 'disk';
            depotEntry.status = 'cached';
            depotEntry.manifestPath = path.relative(process.cwd(), manifestFile);
            depotEntry.jsonPath = path.relative(process.cwd(), jsonFile);
            summary.depots.push(depotEntry);
            savedCount++;
            continue;
          }
        } catch (_) {}
      }

      console.log(`\nDepot ${depotId} (Manifest ${manifestId}, OS: ${d.os || 'all'}):`);
      let manifestData = null;
      let manifestParsed = null;
      let sourceUsed = null;
      let cdnHost = null;

      const tryDirectCdn = async () => {
        process.stdout.write(`  [Steam CDN] Requesting manifest... `);
        const { host, data } = await downloadFromCdn(client, appid, depotId, manifestId, branch);
        const parsed = ContentManifest.parseManifest(data);
        console.log(`OK (from ${host})`);
        return { data, parsed, host, source: 'steam-cdn' };
      };

      const tryXyz = async () => {
        process.stdout.write(`  [XYZ Mirror] Requesting from ${xyzClient.endpoint}... `);
        const result = await xyzClient.fetchManifest(depotId, manifestId, { appid, branch });
        console.log(`OK (verified)`);
        return { data: result.data, parsed: result.manifest, host: new URL(xyzClient.endpoint).host, source: 'xyz-proxy' };
      };

      // Execute strategy
      if (sourceStrategy === 'xyz-first') {
        try {
          const res = await tryXyz();
          manifestData = res.data;
          manifestParsed = res.parsed;
          sourceUsed = res.source;
          cdnHost = res.host;
        } catch (xyzErr) {
          console.log(`FAILED (${xyzErr.message})`);
          try {
            const res = await tryDirectCdn();
            manifestData = res.data;
            manifestParsed = res.parsed;
            sourceUsed = res.source;
            cdnHost = res.host;
          } catch (cdnErr) {
            console.log(`FAILED (${cdnErr.message})`);
          }
        }
      } else if (sourceStrategy === 'xyz-only') {
        try {
          const res = await tryXyz();
          manifestData = res.data;
          manifestParsed = res.parsed;
          sourceUsed = res.source;
          cdnHost = res.host;
        } catch (xyzErr) {
          console.log(`FAILED (${xyzErr.message})`);
        }
      } else if (sourceStrategy === 'cdn-only') {
        try {
          const res = await tryDirectCdn();
          manifestData = res.data;
          manifestParsed = res.parsed;
          sourceUsed = res.source;
          cdnHost = res.host;
        } catch (cdnErr) {
          console.log(`FAILED (${cdnErr.message})`);
        }
      } else {
        // Default: auto / cdn-first
        try {
          const res = await tryDirectCdn();
          manifestData = res.data;
          manifestParsed = res.parsed;
          sourceUsed = res.source;
          cdnHost = res.host;
        } catch (cdnErr) {
          const isDenied = cdnErr instanceof AccessDeniedError || cdnErr.eresult === 15;
          console.log(isDenied ? 'DENIED (AccessDenied)' : `FAILED (${cdnErr.message})`);
          console.log('  -> Falling back to robust XYZ mirror...');
          try {
            const res = await tryXyz();
            manifestData = res.data;
            manifestParsed = res.parsed;
            sourceUsed = res.source;
            cdnHost = res.host;
          } catch (xyzErr) {
            console.log(`  -> XYZ mirror also failed: ${xyzErr.message}`);
          }
        }
      }

      if (manifestData && manifestParsed) {
        // Decrypt filenames if key is known
        const key = keysDb[depotId];
        if (manifestParsed.filenames_encrypted && key) {
          try {
            const keyBuf = Buffer.from(key, 'hex');
            ContentManifest.decryptFilenames(manifestParsed, keyBuf);
            keyBuf.fill(0);
          } catch (_) {}
        }

        fs.writeFileSync(manifestFile, manifestData);

        const listing = manifestToJson({
          appid,
          depotId,
          manifestId,
          branch,
          host: cdnHost || 'unknown',
          manifest: manifestParsed,
        });
        fs.writeFileSync(jsonFile, JSON.stringify(listing, null, 2));

        depotEntry.source = sourceUsed;
        depotEntry.status = 'acquired';
        depotEntry.fileCount = listing.file_count;
        depotEntry.manifestPath = path.relative(process.cwd(), manifestFile);
        depotEntry.jsonPath = path.relative(process.cwd(), jsonFile);
        summary.depots.push(depotEntry);

        console.log(`  Saved: ${depotEntry.manifestPath} (${manifestData.length} bytes, ${listing.file_count} files)`);
        savedCount++;
      } else {
        depotEntry.status = 'failed';
        summary.depots.push(depotEntry);
        failedCount++;
      }
    }

    summary.status = failedCount === 0 ? 'assembled' : savedCount > 0 ? 'partial' : 'failed';

    // Step 5: Save assembly.json
    const summaryFile = path.join(outDir, 'assembly.json');
    fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + '\n');
    console.log(`\n=== 4. Assembly Summary ===`);
    console.log(`Output Directory: ${path.relative(process.cwd(), outDir)}`);
    console.log(`Status:           ${summary.status.toUpperCase()}`);
    console.log(`Manifests:        ${savedCount} acquired / ${targetDepots.length} total`);
    console.log(`Assembly Report:  ${path.relative(process.cwd(), summaryFile)}`);

    return summary;
  } finally {
    if (ownClient) {
      client.logOff();
    }
  }
}

async function main() {
  const opts = parseCli();
  try {
    const summary = await assembleGame(opts.appInput, opts);
    if (summary.status === 'assembled') {
      console.log('\nSUCCESS: Game assembled successfully!');
      process.exit(0);
    } else if (summary.status === 'partial') {
      console.log('\nWARNING: Game assembled with missing depots.');
      process.exit(0);
    } else {
      console.error('\nFAILED: Could not acquire manifests for this game.');
      process.exit(1);
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
  assembleGame,
  parseCli,
};
