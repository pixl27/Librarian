// ═══════════════════════════════════════════════════════════════════
// Librarian — remembering which artwork URLs exist
//
// Big Picture picks its poster, hero and logo by trying candidate URLs and
// keeping the first that loads. The candidates are the legacy CDN paths, and
// for anything released in the last couple of years they are simply not there:
//
//   404  1197ms  cache-control: (none)   apps/2584270/header.jpg
//   404   332ms  cache-control: (none)   apps/2584270/library_600x900.jpg
//   404   335ms  cache-control: (none)   apps/2584270/logo.png
//   404   331ms  cache-control: (none)   apps/2584270/logo_2x.png
//   200    40ms  cache-control: public, max-age=604800   apps/2584270/library_hero.jpg
//
// A 404 from that CDN carries no cache-control, so Chromium never stores it.
// The art that exists is cached for a week and reloads in about 5ms; the art
// that does not exist is re-requested in full every single time — on every
// launch, for every game, four times over. That is the "it loads every time".
//
// So the answer is not another byte cache. It is remembering the answer to a
// question whose answer does not change: does this URL exist? Hits and misses
// are both recorded, and both survive a restart.
//
// HEAD from the main process rather than an Image() in the renderer: no decode,
// no CORS, and the status code is readable instead of being flattened into an
// onerror.
// ═══════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const https = require('https');
const { app } = require('electron');

const CACHE_FILE = 'librarian-art-probe.json';

// A game that has art keeps it. A game that has none may get some later, when
// its store page is finished — but not within a day, so the retry is cheap.
const TTL_HIT = 30 * 24 * 60 * 60 * 1000;
const TTL_MISS = 7 * 24 * 60 * 60 * 1000;

const TIMEOUT = 6000;

let _cache = null;
let _saveTimer = null;
// Two tiles asking for the same URL at once must cost one request, not two.
const inFlight = new Map();

function cachePath() {
  return path.join(app.getPath('userData'), CACHE_FILE);
}

function loadCache() {
  if (_cache) return _cache;
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), 'utf-8'));
    _cache = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch {
    _cache = {};
  }
  return _cache;
}

function saveCacheSoon() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      const target = cachePath();
      const tmp = `${target}.tmp`;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(_cache), 'utf-8');
      fs.renameSync(tmp, target);
    } catch { /* a cache that cannot be written is still a cache in memory */ }
  }, 1500);
  if (_saveTimer.unref) _saveTimer.unref();
}

/** Remembered answer for one URL, or undefined if we have never asked or it went stale. */
function remembered(url) {
  const hit = loadCache()[url];
  if (!hit || typeof hit !== 'object') return undefined;
  const age = Date.now() - (Number(hit.ts) || 0);
  if (age >= (hit.ok ? TTL_HIT : TTL_MISS)) return undefined;
  return Boolean(hit.ok);
}

function remember(url, ok) {
  loadCache()[url] = { ok: Boolean(ok), ts: Date.now() };
  saveCacheSoon();
}

/**
 * Does this URL serve an image?
 *
 * Answers from memory when it can. A network failure — offline, DNS, timeout —
 * is deliberately *not* recorded: that says nothing about whether the art
 * exists, and writing it down would hide the art for a week after one bad
 * moment on the train.
 */
function exists(url) {
  if (!/^https:\/\//i.test(url || '')) return Promise.resolve(false);

  const known = remembered(url);
  if (known !== undefined) return Promise.resolve(known);
  if (inFlight.has(url)) return inFlight.get(url);

  const task = new Promise((resolve) => {
    let settled = false;
    const done = (ok, record = true) => {
      if (settled) return;
      settled = true;
      if (record) remember(url, ok);
      resolve(ok);
    };

    let request;
    try {
      request = https.request(url, { method: 'HEAD', timeout: TIMEOUT }, (res) => {
        res.resume();
        const code = res.statusCode || 0;
        // 3xx is the CDN moving things around, not an answer about existence.
        if (code >= 300 && code < 400) { done(true); return; }
        done(code >= 200 && code < 300);
      });
    } catch {
      done(false, false);
      return;
    }

    request.on('timeout', () => { request.destroy(); done(false, false); });
    request.on('error', () => done(false, false));
    request.end();
  }).finally(() => inFlight.delete(url));

  inFlight.set(url, task);
  return task;
}

/** The first candidate that exists, or '' — the shape Big Picture already uses. */
async function firstThatExists(urls) {
  for (const url of Array.isArray(urls) ? urls : [urls]) {
    if (!url) continue;
    if (await exists(url)) return url;
  }
  return '';
}

function stats() {
  const cache = loadCache();
  const keys = Object.keys(cache);
  return {
    entries: keys.length,
    hits: keys.filter((k) => cache[k]?.ok).length,
    misses: keys.filter((k) => !cache[k]?.ok).length,
  };
}

module.exports = { exists, firstThatExists, stats };
