#!/usr/bin/env node
'use strict';

/**
 * Fetch Steam depot manifests from the Steam CDN.
 *
 * The default anonymous session uses our CM protocol implementation. Steam decides
 * which app metadata, manifest request codes and depot keys the session can access.
 * --login retains the existing steam-user account/Steam Guard authentication path.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { parseArgs } = require('util');

const { AnonymousCMClient } = require('./re/cm_client');
const ContentManifest = require('./re/manifest_format');
const { httpGet: boundedHttpGet } = require('./re/http');
const { uint32, uint64 } = require('./re/ids');
const EDepotFileFlag = Object.freeze({
	UserConfig: 1, VersionedUserConfig: 2, Encrypted: 4, ReadOnly: 8, Hidden: 16,
	Executable: 32, Directory: 64, CustomExecutable: 128, InstallScript: 256, Symlink: 512,
});

const USAGE = `Usage: node fetch-manifest.js <app> [options]

  <app>                 App ID, Steam store URL, or game name
                        (e.g. 1510440 or "honeycomb the world beyond")

Options:
  --info                Only list depots and their manifest IDs; download nothing
  --depot <ids>         Only these depots (comma-separated)
  --manifest <id>       Download this specific manifest ID (e.g. an older build);
                        requires exactly one --depot
  --branch <name>       Branch to take manifest IDs from (default: public)
  --login <username>    Log in with your own Steam account instead of anonymously;
                        the password is read from STEAM_PASSWORD or prompted for
  --out <dir>           Output directory (default: ./manifests)
  --debug               Print connection and download diagnostics
  -h, --help            Show this help

Exit codes: 0 = success, 1 = error, 2 = Steam denied access to at least one manifest`;

const EXIT_DENIED = 2;
const CDN_ATTEMPTS = 5;

let debugEnabled = false;

class AccessDeniedError extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = 'AccessDeniedError';
		this.eresult = 15;
	}
}
class UsageError extends Error {}

function debug(...args) {
	if (debugEnabled) {
		console.error('[debug]', ...args);
	}
}

async function main() {
	const opts = parseCli();
	if (!opts) {
		return;
	}

	const app = await resolveApp(opts.app);
	const client = opts.login ? new (require('steam-user'))({
		// Don't persist anything (login tokens, depot keys, machine IDs) to disk.
		dataDirectory: null,
		autoRelogin: false,
		enablePicsCache: false,
	}) : new AnonymousCMClient();
	if (debugEnabled && client instanceof AnonymousCMClient) {
		client.on('debug', (msg) => debug(msg));
		client.on('trace', (entry) => debug(`CM ${entry.direction} ${entry.name}: ${entry.bytes} bytes`));
	}

	try {
		await logOn(client, opts.login);
		client.on('error', (err) => {
			console.error(`\nSteam connection error: ${err.message}`);
			process.exit(1);
		});
		process.exitCode = await run(client, app, opts);
	} finally {
		client.logOff();
		// steam-user can hold the event loop open briefly after logging off.
		setTimeout(() => process.exit(), 2000).unref();
	}
}

function parseCli(args = process.argv.slice(2)) {
	let parsed;
	try {
		parsed = parseArgs({
			args,
			allowPositionals: true,
			options: {
				info: { type: 'boolean', default: false },
				depot: { type: 'string' },
				manifest: { type: 'string' },
				branch: { type: 'string', default: 'public' },
				login: { type: 'string' },
				out: { type: 'string', default: 'manifests' },
				debug: { type: 'boolean', default: false },
				help: { type: 'boolean', short: 'h', default: false },
			},
		});
	} catch (err) {
		throw new UsageError(err.message);
	}

	const { values, positionals } = parsed;
	if (values.help) {
		console.log(USAGE);
		return null;
	}
	if (positionals.length === 0) {
		throw new UsageError('Missing <app>.');
	}

	let depots = null;
	try {
		if (values.depot !== undefined) depots = [...new Set(values.depot.split(',').map((id) => uint32(id.trim(), 'depot ID')))];
		if (values.manifest !== undefined) values.manifest = uint64(values.manifest, 'manifest ID');
	} catch (err) { throw new UsageError(err.message); }
	if (!values.branch.trim() || !values.out.trim() || (values.login !== undefined && !values.login.trim())) {
		throw new UsageError('--branch, --out and --login must not be empty.');
	}
	if (values.manifest !== undefined) {
		if (!depots || depots.length !== 1) {
			throw new UsageError('--manifest requires exactly one --depot.');
		}
	}

	debugEnabled = values.debug;
	return {
		// Allow unquoted multi-word names: node fetch-manifest.js honeycomb the world beyond
		app: positionals.join(' '),
		info: values.info,
		depots,
		manifest: values.manifest,
		branch: values.branch,
		login: values.login,
		out: values.out,
	};
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

	// Unless the search asks for one, prefer the base game over its demo, soundtrack, etc.
	const sideProduct = /\b(demo|playtest|soundtrack|ost|dedicated server|sdk)\b/i;
	if (!sideProduct.test(text)) {
		items = [...items.filter((item) => !sideProduct.test(item.name)), ...items.filter((item) => sideProduct.test(item.name))];
	}

	const [best, ...others] = items;
	console.log(`Search "${text}" -> ${best.id} ${best.name}`);
	if (others.length > 0) {
		console.log(`  (other matches: ${others.map((item) => `${item.id} ${item.name}`).join('; ')})`);
	}
	return { appid: best.id };
}

async function logOn(client, username) {
	if (!username) {
		process.stdout.write('Logging in to Steam anonymously (independent CM client)...');
		await client.connect();
		console.log(' OK');
		return;
	}
	const details = {
		accountName: username,
		password: process.env.STEAM_PASSWORD || (await promptHidden(`Steam password for ${username}: `)),
		authCode: process.env.STEAM_AUTH_CODE || process.env.STEAM_GUARD_CODE,
	};
	console.log(`Logging in to Steam as ${username}...`);
	const loggedOn = new Promise((resolve, reject) => {
		const onLoggedOn = () => {
			client.removeListener('error', onError);
			resolve();
		};
		const onError = (err) => {
			client.removeListener('loggedOn', onLoggedOn);
			reject(new Error(`Steam login failed: ${err.message}`));
		};
		client.once('loggedOn', onLoggedOn);
		client.once('error', onError);
	});
	client.logOn(details);

	// Account login may wait for a Steam Guard code entered in the terminal.
	await loggedOn;
	console.log('Logged in.');
}

async function run(client, { appid }, opts) {
	const { apps } = await withTimeout(client.getProductInfo([appid], [], true), 60000, 'App info request');
	const appinfo = apps[appid] && apps[appid].appinfo;
	if (!appinfo || !appinfo.common) {
		throw new Error(`Steam returned no info for app ${appid}. Check the app ID.`);
	}
	console.log(`\nApp ${appid}: ${appinfo.common.name} (${appinfo.common.type})`);

	const branches = (appinfo.depots && appinfo.depots.branches) || {};
	const branch = branches[opts.branch];
	if (!branch && !opts.manifest) {
		const names = Object.keys(branches);
		throw new Error(`App has no branch "${opts.branch}". Branches: ${names.length ? names.join(', ') : '(none)'}`);
	}
	if (branch) {
		const password = branch.pwdrequired === '1' ? ', password-protected' : '';
		console.log(`Branch "${opts.branch}": build ${branch.buildid}, updated ${formatTime(branch.timeupdated)}${password}`);
	}

	let depots = listDepots(appinfo, opts.branch);
	if (opts.depots) {
		const unknown = opts.depots.filter((id) => !depots.some((depot) => depot.depotId === id));
		if (unknown.length > 0) {
			console.log(`Warning: app ${appid} doesn't list depot(s) ${unknown.join(', ')}`);
		}
		depots = opts.depots.map((id) => depots.find((depot) => depot.depotId === id) || { depotId: id, os: '', note: 'not listed by app' });
	}
	if (opts.manifest) {
		depots = [{ ...depots[0], manifest: opts.manifest, size: null, download: null, note: 'requested with --manifest' }];
	}

	console.log('');
	printTable(depots, [
		{ title: 'Depot', value: (d) => d.depotId },
		{ title: 'Manifest ID', value: (d) => d.manifest || '-' },
		{ title: 'Size', value: (d) => (d.size == null ? '-' : formatBytes(d.size)), align: 'right' },
		{ title: 'Download', value: (d) => (d.download == null ? '-' : formatBytes(d.download)), align: 'right' },
		{ title: 'OS', value: (d) => d.os || '-' },
		{ title: 'Note', value: (d) => d.note || '' },
	]);

	const targets = depots.filter((depot) => depot.manifest);
	if (opts.info) {
		return 0;
	}
	if (opts.depots) {
		const missing = depots.filter((depot) => !depot.manifest);
		if (missing.length) {
			throw new Error(`Explicit depot selection has no manifest on branch "${opts.branch}": ${missing.map((depot) => depot.depotId).join(', ')}`);
		}
	}
	if (targets.length === 0) {
		console.log(`\nNothing to download: none of the depots above has a manifest on branch "${opts.branch}".`);
		return 0;
	}

	const outDir = path.resolve(opts.out, String(appid));
	const counts = { saved: 0, denied: 0, failed: 0 };
	for (const depot of targets) {
		console.log(`\nDepot ${depot.depotId}, manifest ${depot.manifest}:`);
		try {
			const result = await downloadManifest(client, appid, depot.depotId, depot.manifest, opts.branch, outDir);
			console.log(`  OK      saved ${path.relative(process.cwd(), result.manifestPath)} (${formatBytes(result.bytes)})`);
			console.log(`          ${result.summary}`);
			console.log(`          listing: ${path.relative(process.cwd(), result.jsonPath)}`);
			counts.saved++;
		} catch (err) {
			if (err instanceof AccessDeniedError) {
				console.log(`  DENIED  ${err.message}`);
				counts.denied++;
			} else {
				console.log(`  FAILED  ${err.message}`);
				debug(err.stack);
				counts.failed++;
			}
		}
	}

	console.log(`\nDone: ${counts.saved} saved, ${counts.denied} denied, ${counts.failed} failed.`);
	if (counts.denied > 0) {
		printDeniedHelp(appid, opts);
	}
	if (counts.failed > 0) {
		return 1;
	}
	return counts.denied > 0 ? EXIT_DENIED : 0;
}

function listDepots(appinfo, branchName) {
	const depots = [];
	for (const [key, depot] of Object.entries((appinfo && appinfo.depots) || {})) {
		// Non-numeric keys are metadata such as "branches" and "baselanguages".
		if (!/^\d+$/.test(key)) {
			continue;
		}

		const entry = {
			depotId: uint32(key, 'depot ID'),
			os: (depot.config && depot.config.oslist) || '',
			manifest: null,
			size: null,
			download: null,
			note: '',
		};

		const manifest = depot.manifests && depot.manifests[branchName];
		if (manifest) {
			// Older appinfo stored the manifest ID directly; newer appinfo wraps it as { gid, size, download }.
			if (typeof manifest === 'object') {
				entry.manifest = uint64(manifest.gid, 'manifest ID');
				entry.size = manifest.size == null ? null : jsonInteger(manifest.size);
				entry.download = manifest.download == null ? null : jsonInteger(manifest.download);
			} else {
				entry.manifest = uint64(manifest, 'manifest ID');
			}
		} else if (depot.depotfromapp) {
			entry.note = `shared from app ${depot.depotfromapp}`;
		} else if (depot.encryptedmanifests && depot.encryptedmanifests[branchName]) {
			entry.note = 'manifest ID hidden (password-protected branch)';
		} else if (depot.dlcappid) {
			entry.note = `DLC ${depot.dlcappid}, no manifest on this branch`;
		} else {
			entry.note = 'no manifest on this branch';
		}

		if (depot.config && depot.config.language) {
			entry.note = [`language: ${depot.config.language}`, entry.note].filter(Boolean).join(', ');
		}
		depots.push(entry);
	}
	return depots;
}

async function downloadManifest(client, appid, depotId, manifestId, branch, outDir) {
	const { host, data } = await downloadFromCdn(client, appid, depotId, manifestId, branch);
	const manifest = ContentManifest.parseManifest(data);
	if (String(manifest.depot_id) !== String(depotId) || String(manifest.gid_manifest) !== String(manifestId)) {
		throw new Error(`CDN returned the wrong manifest (depot ${manifest.depot_id}, manifest ${manifest.gid_manifest})`);
	}

	let filenames = 'plain';
	if (manifest.filenames_encrypted) {
		let key;
		try {
			({ key } = await client.getDepotDecryptionKey(appid, depotId));
		} catch (err) {
			if (err.eresult !== 15) throw err;
			filenames = `still encrypted (no depot key: ${err.message})`;
		}
		if (key) {
			// A denied key leaves encrypted names intact. Invalid ciphertext fails the
			// download instead of being mislabeled as a successful decryption.
			try { ContentManifest.decryptFilenames(manifest, key); } finally { key.fill(0); }
			filenames = 'decrypted with depot key';
		}
	}

	fs.mkdirSync(outDir, { recursive: true });
	const base = path.join(outDir, `${depotId}_${manifestId}`);
	const manifestPath = `${base}.manifest`;
	const jsonPath = `${base}.json`;
	// The decompressed binary manifest, exactly as served (filenames stay as Steam stored them).
	fs.writeFileSync(manifestPath, data);

	const listing = manifestToJson({ appid, depotId, manifestId, branch, host, manifest });
	fs.writeFileSync(jsonPath, JSON.stringify(listing, null, 2));

	const summary = [
		`created ${formatTime(manifest.creation_time)}`,
		`${listing.file_count} files`,
		`${formatBytes(listing.total_size)} on disk`,
		`${listing.unique_chunks} unique chunks`,
		`filenames ${filenames}`,
	].join(', ');

	return { manifestPath, jsonPath, bytes: data.length, summary };
}

async function downloadFromCdn(client, appid, depotId, manifestId, branch) {
	const { servers } = await client.getContentServers(appid);
	const candidates = servers
		.slice()
		.sort((a, b) => (a.weightedload || 0) - (b.weightedload || 0))
		.slice(0, CDN_ATTEMPTS);

	let lastError;
	for (const server of candidates) {
		// Obtain a server-issued request code for each attempt; never reuse a recorded code.
		const requestCode = await getManifestRequestCode(client, appid, depotId, manifestId, branch);
		const host = server.vhost || server.Host;
		const scheme = server.https_support === 'mandatory' || server.https_support === 'optional' ? 'https' : 'http';
		const url = `${scheme}://${host}/depot/${depotId}/manifest/${manifestId}/5/${requestCode}`;

		try {
			debug(`GET ${scheme}://${host}/depot/${depotId}/manifest/${manifestId}/5/<request-code>`);
			const res = await httpGet(url, { 'User-Agent': 'Valve/Steam HTTP Client 1.0' });
			if (res.status !== 200) {
				throw Object.assign(new Error(`HTTP ${res.status} from ${host}`), { stage: 'cdn-http', httpStatus: res.status });
			}
			return { host, raw: res.body, data: ContentManifest.decompress(res.body).data };
		} catch (err) {
			debug(`manifest download from ${host} failed: ${err.message}`);
			lastError = err;
		}
	}

	throw Object.assign(new Error(`Could not download the manifest from ${candidates.length} CDN server(s). Last error: ${lastError && lastError.message}`, { cause: lastError }), {
		stage: lastError?.stage || 'cdn-download',
		...(lastError?.httpStatus === undefined ? {} : { httpStatus: lastError.httpStatus }),
	});
}

async function getManifestRequestCode(client, appid, depotId, manifestId, branch) {
	let result;
	try {
		result = await client.getManifestRequestCode(appid, depotId, manifestId, branch);
	} catch (err) {
		const error = err.eresult === 15
			? new AccessDeniedError('Steam refused to issue a manifest request code (AccessDenied).', { cause: err })
			: new Error(`Manifest request code failed: ${err.message}`, { cause: err });
		error.stage = 'manifest-request-code';
		error.operation = 'ContentServerDirectory.GetManifestRequestCode#1';
		if (Number.isInteger(err.eresult)) error.eresult = err.eresult;
		if (err.resultSource) error.resultSource = err.resultSource;
		throw error;
	}

	if (!result.requestCode || result.requestCode === '0') {
		throw new Error('Malformed manifest request-code response: missing or zero code');
	}
	return uint64(result.requestCode, 'manifest request code');
}

function printDeniedHelp(appid, opts) {
	if (opts.login) {
		console.log(`
Steam denied this account access to the requested depot or manifest.
Check that the account "${opts.login}" has access to the game, any required DLC,
and the selected branch.`);
		return;
	}

	console.log(`
Steam returned app metadata but denied this anonymous session a manifest request code.
Use an account with access to the requested game, depot and branch:

  node fetch-manifest.js ${appid} --login <your_steam_username>`);
}

function manifestToJson({ appid, depotId, manifestId, branch, host, manifest }) {
	const files = (manifest.files || []).map((file) => ({
		name: file.filename,
		size: jsonInteger(file.size),
		flags: file.flags,
		flag_names: flagNames(file.flags),
		sha_content: file.sha_content,
		link_target: file.linktarget || undefined,
		chunks: (file.chunks || []).map((chunk) => ({
			sha: chunk.sha,
			crc: chunk.crc,
			offset: jsonInteger(chunk.offset),
			size: chunk.cb_original,
			compressed_size: chunk.cb_compressed,
		})),
	}));

	return {
		app_id: appid,
		depot_id: depotId,
		manifest_id: String(manifestId),
		branch,
		created: new Date(manifest.creation_time * 1000).toISOString(),
		filenames_encrypted: Boolean(manifest.filenames_encrypted),
		total_size: jsonInteger(manifest.cb_disk_original),
		total_compressed_size: jsonInteger(manifest.cb_disk_compressed),
		unique_chunks: manifest.unique_chunks,
		file_count: files.length,
		fetched_from: host,
		files,
	};
}

function flagNames(flags) {
	return Object.entries(EDepotFileFlag)
		.filter(([, value]) => typeof value === 'number' && (flags & value) !== 0)
		.map(([name]) => name);
}

function httpGet(url, headers = {}, idleTimeoutMs = 30000) {
	return boundedHttpGet(url, { headers, timeoutMs: idleTimeoutMs });
}

function jsonInteger(value) {
	const n = BigInt(uint64(value ?? '0', 'manifest size/offset', true));
	return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString();
}

function promptHidden(question) {
	return new Promise((resolve, reject) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
		let answered = false;
		let muted = false;
		// Show the question, then hide the typed characters.
		rl._writeToOutput = (text) => {
			if (!muted) {
				rl.output.write(text);
			}
		};
		rl.on('close', () => {
			if (!answered) {
				reject(new Error('No password entered.'));
			}
		});
		rl.question(question, (answer) => {
			answered = true;
			rl.close();
			process.stdout.write('\n');
			resolve(answer);
		});
		muted = true;
	});
}

function withTimeout(promise, ms, what) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function printTable(rows, columns) {
	const cells = rows.map((row) => columns.map((column) => String(column.value(row))));
	const widths = columns.map((column, i) => Math.max(column.title.length, ...cells.map((row) => row[i].length)));
	const format = (row) =>
		row
			.map((cell, i) => (columns[i].align === 'right' ? cell.padStart(widths[i]) : cell.padEnd(widths[i])))
			.join('  ')
			.trimEnd();

	console.log(`  ${format(columns.map((column) => column.title))}`);
	for (const row of cells) {
		console.log(`  ${format(row)}`);
	}
}

function formatBytes(bytes) {
	const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	let value = Number(bytes);
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return unit === 0 ? `${value} B` : `${value.toFixed(2)} ${units[unit]}`;
}

function formatTime(unixSeconds) {
	return `${new Date(Number(unixSeconds) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

if (require.main === module) main().catch((err) => {
	if (err instanceof UsageError) {
		console.error(`Error: ${err.message}\n\n${USAGE}`);
	} else {
		console.error(`\nError: ${err.message}`);
		debug(err.stack);
	}
	process.exit(1);
});

module.exports = { parseCli, resolveApp, listDepots, manifestToJson, downloadFromCdn, getManifestRequestCode, AccessDeniedError, run };
