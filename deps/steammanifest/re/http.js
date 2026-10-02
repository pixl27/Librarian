'use strict';

const http = require('http');
const https = require('https');

// Both an idle timeout and one total deadline, including redirects and DNS lookup.
function httpGet(input, { headers = {}, timeoutMs = 30000, maxBytes = 64 * 1024 * 1024, maxRedirects = 3 } = {}) {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return Promise.reject(new Error('Invalid HTTP size or timeout limit'));
	}
	const deadline = Date.now() + timeoutMs;
	function attempt(target, redirects) {
		return new Promise((resolve, reject) => {
			let url;
			try {
				url = new URL(target);
				if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported HTTP URL');
			} catch (err) { reject(err); return; }
			const remaining = deadline - Date.now();
			if (remaining <= 0) { reject(new Error('HTTP request deadline exceeded')); return; }
			let settled = false;
			let timer;
			const finish = (err, result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				err ? reject(err) : resolve(result);
			};
			const req = (url.protocol === 'https:' ? https : http).get(url, {
				headers: { 'User-Agent': 'Valve/Steam HTTP Client 1.0', 'Accept-Encoding': 'identity', ...headers },
			}, (res) => {
				if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
					let next;
					try {
						next = new URL(res.headers.location, url);
						if (redirects >= maxRedirects) throw new Error('Too many HTTP redirects');
						if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('Refusing HTTPS downgrade');
					} catch (err) { finish(err); res.destroy(); return; }
					res.destroy();
					finish(null, attempt(next, redirects + 1));
					return;
				}
				const length = res.headers['content-length'];
				if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
					finish(new Error(`HTTP response exceeds ${maxBytes} bytes`));
					res.destroy();
					return;
				}
				let size = 0;
				const chunks = [];
				res.on('data', (chunk) => {
					size += chunk.length;
					if (size > maxBytes) {
						finish(new Error(`HTTP response exceeds ${maxBytes} bytes`));
						res.destroy();
					} else chunks.push(chunk);
				});
				res.on('end', () => {
					if (!res.complete) return finish(new Error('Truncated HTTP response'));
					finish(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks, size) });
				});
				res.on('aborted', () => finish(new Error('Truncated HTTP response')));
				res.on('error', (err) => finish(err));
			});
			timer = setTimeout(() => req.destroy(new Error('HTTP request deadline exceeded')), remaining);
			req.setTimeout(Math.min(timeoutMs, remaining), () => req.destroy(new Error('HTTP request timed out')));
			req.on('error', (err) => finish(err));
		});
	}
	return attempt(input, 0);
}

async function webApi(iface, method, params = {}, options = {}) {
	const url = new URL(`https://api.steampowered.com/${iface}/${method}/v1/`);
	url.search = new URLSearchParams({ ...params, format: 'json' }).toString();
	const response = await httpGet(url, { maxBytes: 4 * 1024 * 1024, ...options });
	if (response.status !== 200) throw new Error(`${iface}.${method}: HTTP ${response.status}`);
	const parsed = JSON.parse(response.body.toString('utf8'));
	if (!parsed.response || typeof parsed.response !== 'object') throw new Error(`${iface}.${method}: malformed response`);
	return parsed.response;
}

module.exports = { httpGet, webApi };
