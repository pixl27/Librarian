'use strict';

// Independent anonymous Steam CM client. Generic WebSocket/TLS and protobuf codecs
// are libraries; Steam framing, session state, jobs and PICS handling are ours.
const { EventEmitter } = require('events');
const WS = require('websocket13');
const wire = require('./cm_wire');
const { webApi } = require('./http');
const { parseVdf } = require('./vdf');
const { uint32, uint64 } = require('./ids');
const { summarizeCMResult } = require('./access_trace');

const { EMsg, JOBID_NONE } = wire;
const MAX_MESSAGE = 32 * 1024 * 1024;
const messageNames = new Map(Object.entries(EMsg).map(([key, value]) => [value, key]));

class SteamResultError extends Error {
	constructor(operation, result, resultSource = 'body') {
		const name = ({ 1: 'OK', 2: 'Fail', 5: 'InvalidPassword', 15: 'AccessDenied', 84: 'RateLimitExceeded' })[result] || 'Steam error';
		super(`${operation}: ${name} (${result})`);
		this.name = 'SteamResultError';
		this.eresult = result;
		this.operation = operation;
		this.resultSource = resultSource;
	}
}

function endpointUrl(endpoint) {
	if (typeof endpoint !== 'string' || !/^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(endpoint)) {
		throw new Error('Malformed CM endpoint');
	}
	return `wss://${endpoint}/cmsocket/`;
}

class AnonymousCMClient extends EventEmitter {
	constructor({ api = webApi, socketFactory = (url) => new WS.WebSocket(url, { pingInterval: 30000, permessageDeflate: false }), requestTimeoutMs = 15000, connectTimeoutMs = 15000, maxAttempts = 3 } = {}) {
		super();
		this.api = api;
		this.socketFactory = socketFactory;
		this.requestTimeoutMs = requestTimeoutMs;
		this.connectTimeoutMs = connectTimeoutMs;
		this.maxAttempts = maxAttempts;
		this.steamID = null;
		this.sessionID = 0;
		this.cellID = 0;
		this.state = 'idle';
		this._socket = null;
		this._pending = new Map();
		this._nextJob = 0n;
		this._generation = 0;
		this._heartbeat = null;
		this._login = null;
	}

	async connect() {
		if (this.state === 'connecting' || this.state === 'ready') throw new Error('CM client is already connected or connecting');
		this.state = 'connecting';
		const generation = ++this._generation;
		try {
			const directory = await this.api('ISteamDirectory', 'GetCMListForConnect', { cellid: 0, cmtype: 'websockets' });
			if (generation !== this._generation) throw new Error('CM connection cancelled');
			const candidates = Object.values(directory.serverlist || {})
				.filter((s) => s.type === 'websockets' && (!s.realm || s.realm === 'steamglobal'))
				.sort((a, b) => Number(a.wtd_load || 0) - Number(b.wtd_load || 0))
				.slice(0, this.maxAttempts);
			if (!candidates.length) throw new Error('No WebSocket CM servers available');
			let lastError;
			for (const candidate of candidates) {
				if (generation !== this._generation) throw new Error('CM connection cancelled');
				try {
						await this._open(candidate.endpoint);
						if (generation !== this._generation || this.state !== 'ready' || !this._socket) {
							throw new Error('CM connection closed or cancelled during login');
						}
						return this;
				} catch (err) {
					lastError = err;
					this.emit('debug', `CM connection failed: ${err.message}`);
					if (err instanceof SteamResultError) throw err;
				}
			}
			throw lastError;
		} catch (err) {
			if (generation === this._generation) this.state = 'closed';
			throw err;
		}
	}

	_open(endpoint) {
		return new Promise((resolve, reject) => {
			this.state = 'connecting';
			this.steamID = null;
			this.sessionID = 0;
			let socket;
			try { socket = this.socketFactory(endpointUrl(endpoint)); } catch (err) { reject(err); return; }
			this._socket = socket;
			const timer = setTimeout(() => this._fail(new Error('CM login timed out'), socket), this.connectTimeoutMs);
			this._login = {
				resolve: () => { clearTimeout(timer); resolve(); },
				reject: (err) => { clearTimeout(timer); reject(err); },
			};
			socket.on('connected', () => {
				if (this._socket !== socket) return;
				try {
					this._send(EMsg.ClientLogon, {
						protocol_version: wire.PROTOCOL_VERSION,
						client_os_type: 20,
						client_language: 'english',
						anon_user_target_account_name: 'anonymous',
					});
				} catch (err) { this._fail(err, socket); }
			});
			socket.on('message', (type, data) => {
				if (this._socket !== socket || type !== WS.FrameType.Data.Binary) return;
				try { this._receive(Buffer.from(data)); } catch (err) { this._fail(err, socket); }
			});
			socket.on('streamedMessage', (type, stream) => {
				let total = 0;
				const chunks = [];
				stream.on('data', (chunk) => {
					total += chunk.length;
					if (total > MAX_MESSAGE) {
						stream.destroy();
						this._fail(new Error('CM message size limit exceeded'), socket);
					} else chunks.push(chunk);
				});
				stream.on('error', (err) => this._fail(err, socket));
				stream.on('end', () => {
					if (this._socket !== socket || type !== WS.FrameType.Data.Binary) return;
					try { this._receive(Buffer.concat(chunks, total)); } catch (err) { this._fail(err, socket); }
				});
			});
			socket.on('error', (err) => this._fail(err, socket));
			socket.on('disconnected', (code) => this._fail(new Error(`CM disconnected (${code})`), socket));
		});
	}

	_send(emsg, body = {}, header = {}) {
		if (!this._socket) throw new Error('CM is disconnected');
		const packet = wire.encodeMessage(emsg, {
			steamid: this.steamID || wire.ANON_STEAM_ID,
			client_sessionid: this.sessionID,
			jobid_source: JOBID_NONE,
			jobid_target: JOBID_NONE,
			...header,
		}, body);
		// Never emit bodies, keys, request codes, or account identifiers into traces.
		this.emit('trace', { direction: 'out', emsg, name: header.target_job_name || messageNames.get(emsg) || String(emsg), bytes: packet.length });
		this._socket.send(packet);
	}

	_receive(packet) {
		if (packet.length < 4 || packet.length > MAX_MESSAGE) throw new Error('Invalid CM message length');
		if (!(packet.readUInt32LE(0) & 0x80000000)) {
			// Unsolicited legacy notifications are outside the protobuf RPC subset.
			if (packet.length < 36 || packet[4] !== 36 || packet.readUInt16LE(5) !== 2 || packet[23] !== 239) throw new Error('Invalid legacy CM header');
			return;
		}
		const frame = wire.decodeMessage(packet);
		if (frame.emsg === EMsg.Multi) {
			for (const child of wire.unpackMulti(frame.body)) this._receive(child);
			return;
		}
		const { emsg, header, body } = frame;
		const pending = this._pending.get(header.jobid_target);
		const result = summarizeCMResult(packet, frame);
		if (result) result.matchedRequest = emsg === EMsg.ClientLogOnResponse ? Boolean(this._login)
			: Boolean(pending && emsg === pending.response && (!pending.service || header.target_job_name === pending.service));
		this.emit('trace', { direction: 'in', emsg, name: header.target_job_name || messageNames.get(emsg) || String(emsg), bytes: packet.length,
			...(result ? { result } : {}) });
		if (emsg === EMsg.ClientLogOnResponse && this._login) {
			if (body.eresult !== 1) throw new SteamResultError('Anonymous login', body.eresult);
				const assignedId = header.steamid && header.steamid !== '0' ? header.steamid : body.client_supplied_steamid;
				this.steamID = uint64(assignedId, 'assigned SteamID');
			this.sessionID = header.client_sessionid;
			this.cellID = body.cell_id || 0;
			this.state = 'ready';
			const heartbeat = body.heartbeat_seconds > 0 ? body.heartbeat_seconds : 30;
			if (heartbeat > 3600) throw new Error('Invalid CM heartbeat interval');
			this._heartbeat = setInterval(() => {
				try { this._send(EMsg.ClientHeartBeat); } catch (err) { this._fail(err); }
			}, heartbeat * 1000);
			this._heartbeat.unref();
			const login = this._login;
			this._login = null;
			login.resolve();
			return;
		}
		if (emsg === EMsg.ClientLoggedOff) throw new SteamResultError('Logged off by Steam', body.eresult);
		if (!pending) return;
		try {
			if (emsg !== pending.response || (pending.service && header.target_job_name !== pending.service)) throw new Error('Mismatched CM response type');
			if (pending.service && header.eresult !== 1) throw new SteamResultError(pending.service, header.eresult, 'header');
			const decoded = pending.service ? wire.decodeUnified(pending.service, frame.bodyBytes) : body;
			pending.bytes += packet.length;
			pending.parts.push(decoded);
			if (pending.bytes > MAX_MESSAGE || pending.parts.length > 1024) throw new Error('CM response limit exceeded');
			if (pending.multipart && decoded.response_pending) return;
			this._pending.delete(header.jobid_target);
			clearTimeout(pending.timer);
			pending.resolve(pending.multipart ? pending.parts : decoded);
		} catch (err) {
			this._pending.delete(header.jobid_target);
			clearTimeout(pending.timer);
			pending.reject(err);
		}
	}

	_request(emsg, body, response, { service, multipart = false } = {}) {
		if (this.state !== 'ready') return Promise.reject(new Error('CM is not logged on'));
		if (this._pending.size >= 128) return Promise.reject(new Error('Too many pending CM requests'));
		const job = (++this._nextJob).toString();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pending.delete(job);
				reject(new Error(`${service || messageNames.get(emsg)} timed out`));
			}, this.requestTimeoutMs);
			this._pending.set(job, { resolve, reject, timer, response, service, multipart, parts: [], bytes: 0 });
			try {
				this._send(emsg, body, { jobid_source: job, ...(service ? { target_job_name: service } : {}) });
			} catch (err) {
				clearTimeout(timer);
				this._pending.delete(job);
				reject(err);
			}
		});
	}

	async getProductInfo(apps, packages = [], includeTokens = true) {
		if (packages.length) throw new Error('Independent PICS client supports apps, not package-info buffers');
		const requests = apps.map((app) => typeof app === 'object'
			? { appid: uint32(app.appid, 'app ID'), access_token: uint64(app.access_token || '0', 'PICS token', true) }
			: { appid: uint32(app, 'app ID') });
		const parts = await this._request(EMsg.ClientPICSProductInfoRequest, { apps: requests, meta_data_only: false }, EMsg.ClientPICSProductInfoResponse, { multipart: true });
		const result = { apps: Object.create(null), packages: {}, unknownApps: [], unknownPackages: [] };
		const requested = new Set(requests.map((app) => app.appid));
		for (const part of parts) {
			result.unknownApps.push(...(part.unknown_appids || []));
			for (const app of part.apps || []) {
				if (!requested.has(app.appid)) throw new Error('PICS returned an unrequested app ID');
				if (!app.buffer || !app.buffer.length) throw new Error(`PICS app ${app.appid} has no inline appinfo buffer`);
				result.apps[app.appid] = { changenumber: app.change_number, missingToken: !!app.missing_token, appinfo: parseVdf(app.buffer).appinfo };
			}
		}
		if (includeTokens) {
			const missing = Object.entries(result.apps).filter(([, app]) => app.missingToken).map(([id]) => Number(id));
			if (missing.length) {
				const tokens = await this._request(EMsg.ClientPICSAccessTokenRequest, { appids: missing }, EMsg.ClientPICSAccessTokenResponse);
				const retry = (tokens.app_access_tokens || []).filter((app) => missing.includes(app.appid) && app.access_token !== '0');
				if (retry.length) Object.assign(result.apps, (await this.getProductInfo(retry, [], false)).apps);
			}
		}
		return result;
	}

	async getContentServers(appid) {
		appid = uint32(appid, 'app ID');
		const directory = await this.api('IContentServerDirectoryService', 'GetServersForSteamPipe', { cell_id: this.cellID });
		const servers = Object.values(directory.servers || {})
			.filter((s) => ['CDN', 'SteamCache'].includes(s.type))
			.filter((s) => !s.allowed_app_ids || !s.allowed_app_ids.length || s.allowed_app_ids.map(Number).includes(appid))
			.map((s) => ({ ...s, Host: s.host, weightedload: s.weighted_load }));
		if (!servers.length) throw new Error('No content servers available');
		return { servers };
	}

	async getManifestRequestCode(appid, depotId, manifestId, branch = 'public') {
		if (typeof branch !== 'string' || !branch.length) throw new Error('Branch must be nonempty');
		const service = 'ContentServerDirectory.GetManifestRequestCode#1';
		const result = await this._request(EMsg.ServiceMethodCallFromClient, {
			app_id: uint32(appid, 'app ID'), depot_id: uint32(depotId, 'depot ID'),
			manifest_id: uint64(manifestId, 'manifest ID'), app_branch: branch,
		}, EMsg.ServiceMethodResponse, { service });
			if (!result.manifest_request_code || result.manifest_request_code === '0') throw new Error('Malformed manifest request-code response: missing or zero code');
		return { requestCode: uint64(result.manifest_request_code, 'manifest request code') };
	}

	async getDepotDecryptionKey(appid, depotId) {
		depotId = uint32(depotId, 'depot ID');
		const result = await this._request(EMsg.ClientGetDepotDecryptionKey, { app_id: uint32(appid, 'app ID'), depot_id: depotId }, EMsg.ClientGetDepotDecryptionKeyResponse);
		if (result.eresult !== 1) throw new SteamResultError('Depot decryption key', result.eresult);
		if (result.depot_id !== depotId || !Buffer.isBuffer(result.depot_encryption_key) || result.depot_encryption_key.length !== 32) throw new Error('Invalid depot decryption key response');
		return { key: result.depot_encryption_key };
	}

	_fail(err, socket = this._socket) {
		if (!socket || this._socket !== socket) return;
		this._socket = null;
		this.state = 'closed';
		this.steamID = null;
		clearInterval(this._heartbeat);
		this._heartbeat = null;
		if (this._login) { this._login.reject(err); this._login = null; }
		for (const pending of this._pending.values()) { clearTimeout(pending.timer); pending.reject(err); }
		this._pending.clear();
		try { socket.disconnect(); } catch (_) { /* Already disconnected. */ }
		this.emit('debug', err.message);
	}

	logOff() {
		++this._generation;
		if (this.state === 'ready') {
			try { this._send(EMsg.ClientLogOff); } catch (_) { /* Continue cleanup. */ }
		}
		this._fail(new Error('CM client closed'));
		this.state = 'closed';
	}
}

module.exports = { AnonymousCMClient, SteamResultError, endpointUrl };
