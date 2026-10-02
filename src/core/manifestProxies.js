/**
 * A live proxy pool for the request-code mirror.
 *
 * The mirror (20770407.xyz) rate-limits per IP, so a manifest fetch for a paid
 * depot eventually meets a 401. Routing the request through a proxy sidesteps
 * that, but a fixed list of proxies goes stale fast — free proxies die by the
 * hour. So instead of hardcoding addresses, this pulls a fresh list from a
 * public, GitHub-published source (proxifly's free-proxy-list, served over the
 * jsDelivr CDN by default), ranks it, probes a handful, and keeps the few that
 * actually respond right now. The user can still pin their own proxies in
 * Settings (`manifest_mirror_proxies`), which take precedence and are used as
 * given; the source (`manifest_proxy_source`) is only consulted when no proxy
 * is pinned, and clearing it turns auto-sourcing off.
 *
 * The list is a third party of unknown quality: only well-formed http(s) proxy
 * URLs are taken, at most a small window is ever probed, a probe is a short
 * request to a neutral endpoint, and a proxy that does not answer is dropped.
 * Nothing here is fatal — if the source is unreachable or every candidate
 * fails, the pool is empty and the mirror is tried directly.
 */
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const DEFAULT_SOURCE = 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.json';
const CACHE_FILE = 'manifest_proxies.cache.json';
const LIST_TTL_MS = 30 * 60 * 1000;   // re-fetch the source at most twice an hour
const SESSION_TTL_MS = 15 * 60 * 1000; // re-probe winners at most every 15 min
const DEFAULT_LIMIT = 5;
const PROBE_WINDOW = 24;
const PROBE_TIMEOUT_MS = 5000;
const FETCH_TIMEOUT_MS = 20000;
const MAX_LIST_BYTES = 8 * 1024 * 1024;
const HEALTH_URL = 'https://www.google.com/generate_204';

function settingGet(key) {
  try { return require('./settingsStore').get(key); }
  catch { return undefined; }
}

function electronUserData() {
  try {
    const { app } = require('electron');
    return app && typeof app.getPath === 'function' ? app.getPath('userData') : null;
  } catch {
    return null;
  }
}

function cleanProxyUrl(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null; // SOCKS unsupported
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/**
 * Parse a proxy source body into ranked candidate URLs. Understands proxifly's
 * JSON ([{proxy, protocol, https, score}]) and a plain one-URL-per-line list.
 */
function parseList(body) {
  const text = String(body || '').trim();
  if (!text) return [];
  if (text[0] === '[' || text[0] === '{') {
    let json;
    try { json = JSON.parse(text); } catch { return []; }
    const arr = Array.isArray(json) ? json : (Array.isArray(json.data) ? json.data : []);
    return arr
      .filter((e) => e && (e.protocol ? /^https?$/i.test(e.protocol) : true))
      .sort((a, b) => (Number(b.https) - Number(a.https)) || (Number(b.score || 0) - Number(a.score || 0)))
      .map((e) => cleanProxyUrl(e.proxy || (e.ip && e.port ? `${e.protocol || 'http'}://${e.ip}:${e.port}` : '')))
      .filter(Boolean);
  }
  return text.split(/\r?\n/).map(cleanProxyUrl).filter(Boolean);
}

function cachePath(userData) {
  const base = userData || electronUserData();
  if (!base) throw new Error('no user data directory for the proxy cache');
  return path.join(base, CACHE_FILE);
}

function readCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

/** Candidate proxy URLs from the source, cached on disk with a TTL. */
async function fetchCandidates({ source, userData, maxAgeMs = LIST_TTL_MS, fetchImpl = fetch }) {
  let file;
  try { file = cachePath(userData); }
  catch { file = null; }
  const cached = file ? readCache(file) : null;
  if (cached && cached.source === source && Array.isArray(cached.candidates) && Date.now() - Number(cached.fetchedAt || 0) < maxAgeMs) {
    return cached.candidates;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let candidates;
  try {
    const res = await fetchImpl(source, { headers: { 'User-Agent': 'Librarian/1.0', Accept: 'application/json, text/plain, */*' }, signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`proxy source HTTP ${res.status}`);
    const declared = Number(res.headers.get && res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_LIST_BYTES) throw new Error('proxy source too large');
    candidates = parseList(await res.text());
  } catch (err) {
    if (cached && Array.isArray(cached.candidates)) return cached.candidates; // stale but usable
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (file) { try { fs.writeFileSync(file, JSON.stringify({ source, fetchedAt: Date.now(), candidates })); } catch { /* cache is a hint */ } }
  return candidates;
}

/** Probe one proxy: a short request to a neutral endpoint; resolves latency or null. */
async function probe(proxyUrl, { healthUrl, timeoutMs, fetchImpl, agentFactory }) {
  const agent = agentFactory(proxyUrl);
  if (!agent) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchImpl(healthUrl, { agent, signal: controller.signal, redirect: 'manual' });
    if (res.status === 204 || (res.status >= 200 && res.status < 400)) return { proxy: proxyUrl, ms: Date.now() - started };
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Winners survive a session so several downloads share one probe round.
let sessionPool = { key: '', at: 0, proxies: [] };

/**
 * Resolve the proxy pool for the mirror.
 * @returns {Promise<string[]>} proxy URLs, best first (empty when off/none work)
 */
async function resolvePool(options = {}) {
  const source = String(options.source ?? settingGet('manifest_proxy_source') ?? '').trim();
  if (!source) return [];
  const limit = Number.isFinite(options.limit) ? options.limit : DEFAULT_LIMIT;
  const probeOn = options.probe !== false;
  const fetchImpl = options.fetchImpl || fetch;
  const agentFactory = options.agentFactory || ((p) => { try { const { HttpsProxyAgent } = require('https-proxy-agent'); return new HttpsProxyAgent(p); } catch { return null; } });
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};

  const key = `${source}|${limit}|${probeOn}`;
  if (!options.force && sessionPool.key === key && sessionPool.proxies.length && Date.now() - sessionPool.at < SESSION_TTL_MS) {
    return sessionPool.proxies;
  }

  let candidates;
  try { candidates = await fetchCandidates({ source, userData: options.userData, maxAgeMs: options.maxAgeMs, fetchImpl }); }
  catch (err) { onLog(`⚠ Could not fetch the proxy list (${err.message}); trying the mirror directly.`); return []; }
  if (!candidates.length) return [];

  if (!probeOn) {
    const top = candidates.slice(0, limit);
    sessionPool = { key, at: Date.now(), proxies: top };
    return top;
  }

  const window = candidates.slice(0, Number.isFinite(options.window) ? options.window : PROBE_WINDOW);
  const healthUrl = options.healthUrl || HEALTH_URL;
  const timeoutMs = Number.isFinite(options.probeTimeoutMs) ? options.probeTimeoutMs : PROBE_TIMEOUT_MS;
  const results = (await Promise.all(window.map((p) => probe(p, { healthUrl, timeoutMs, fetchImpl, agentFactory }))))
    .filter(Boolean)
    .sort((a, b) => a.ms - b.ms)
    .slice(0, limit)
    .map((r) => r.proxy);

  // If none answered, still hand back a few candidates: the mirror request
  // itself is the real test, and a working one may simply have failed the probe.
  const pool = results.length ? results : candidates.slice(0, limit);
  if (results.length) onLog(`🔁 ${results.length} of ${window.length} proxies responded; using the fastest ${pool.length}.`);
  sessionPool = { key, at: Date.now(), proxies: pool };
  return pool;
}

function _reset() { sessionPool = { key: '', at: 0, proxies: [] }; }

module.exports = {
  DEFAULT_SOURCE,
  DEFAULT_LIMIT,
  parseList,
  cleanProxyUrl,
  fetchCandidates,
  resolvePool,
  _reset,
};
