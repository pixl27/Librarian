#!/usr/bin/env node
'use strict';

/**
 * CLI tool to fetch and validate depot manifests from 20770407.xyz or compatible mirrors.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

const { XyzClient, XyzError, DEFAULT_ENDPOINT } = require('./re/xyz_client');
const { manifestToJson } = require('./fetch-manifest');
const { uint32, uint64 } = require('./re/ids');

const USAGE = `Usage: node fetch-xyz.js <depotid> <manifestid> [options]

  <depotid>             Steam Depot ID (e.g. 1004)
  <manifestid>          Steam Manifest ID (e.g. 5612541580377302256)

Options:
  --appid <id>          App ID associated with this depot (optional query hint)
  --branch <name>       Branch name (default: public)
  --endpoint <url>      Custom server endpoint (default: ${DEFAULT_ENDPOINT})
  --token <token>       Authentication token / inbox credential
  --out <dir>           Output directory (default: ./manifests/<appid> or ./manifests)
  --retries <n>         Max retries on network/server errors (default: 3)
  --timeout <ms>        Request timeout in ms (default: 15000)
  -h, --help            Show this help`;

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        appid: { type: 'string' },
        branch: { type: 'string', default: 'public' },
        endpoint: { type: 'string' },
        token: { type: 'string' },
        out: { type: 'string' },
        retries: { type: 'string', default: '3' },
        timeout: { type: 'string', default: '15000' },
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

  if (positionals.length < 2) {
    console.error('Error: Both <depotid> and <manifestid> are required.\n');
    console.log(USAGE);
    process.exit(1);
  }

  let depotId, manifestId, appid;
  try {
    depotId = uint32(positionals[0], 'depot ID');
    manifestId = uint64(positionals[1], 'manifest ID');
    if (values.appid) {
      appid = uint32(values.appid, 'app ID');
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }

  return {
    depotId,
    manifestId,
    appid: appid || depotId,
    branch: values.branch,
    endpoint: values.endpoint,
    token: values.token,
    out: values.out,
    maxRetries: Number(values.retries),
    timeoutMs: Number(values.timeout),
  };
}

async function main() {
  const opts = parseCli();
  const client = new XyzClient({
    endpoint: opts.endpoint,
    token: opts.token,
    maxRetries: opts.maxRetries,
    timeoutMs: opts.timeoutMs,
  });

  console.log(`Connecting to XYZ mirror at: ${client.endpoint}`);
  console.log(`Fetching manifest for Depot ${opts.depotId}, Manifest ${opts.manifestId}...`);

  try {
    const result = await client.fetchManifest(opts.depotId, opts.manifestId, {
      appid: opts.appid,
      branch: opts.branch,
    });

    const outDir = opts.out
      ? path.resolve(opts.out)
      : path.resolve('manifests', String(opts.appid));
    fs.mkdirSync(outDir, { recursive: true });

    const base = path.join(outDir, `${opts.depotId}_${opts.manifestId}`);
    const manifestPath = `${base}.manifest`;
    const jsonPath = `${base}.json`;

    fs.writeFileSync(manifestPath, result.data);

    const listing = manifestToJson({
      appid: opts.appid,
      depotId: opts.depotId,
      manifestId: opts.manifestId,
      branch: opts.branch,
      host: new URL(client.endpoint).host,
      manifest: result.manifest,
    });
    fs.writeFileSync(jsonPath, JSON.stringify(listing, null, 2));

    console.log(`\n  OK  Saved manifest: ${path.relative(process.cwd(), manifestPath)} (${result.data.length} bytes)`);
    console.log(`      Saved listing:  ${path.relative(process.cwd(), jsonPath)} (${listing.file_count} files, ${listing.unique_chunks} unique chunks)`);
    console.log(`      Source:         ${result.source} (${client.endpoint})`);
  } catch (err) {
    if (err instanceof XyzError) {
      console.error(`\n  XYZ ERROR [${err.code}]: ${err.message}`);
      if (err.status === 401) {
        console.error(`  Tip: The mirror requires credentials. Supply --token <token> or set XYZ_TOKEN.`);
      }
    } else {
      console.error(`\n  FAILED: ${err.message}`);
    }
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
  parseCli,
  main,
};
