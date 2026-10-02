const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const dns = require('dns');
const fetch = require('node-fetch');
const { Worker } = require('worker_threads');
const chunkCodec = require('./chunkCodec');

const PAYLOAD_MAGIC = 0x71F617D0;
const DEPOT_KEY_RE = /^[0-9a-fA-F]{64}$/;
const DEFAULT_CONCURRENCY = 8;
const ADAPTIVE_MAX_WORKERS = 48;   // ceiling for the adaptive ramp
const ADAPTIVE_PROBE_MS = 4000;    // how often throughput is re-sampled while climbing
// After the ramp settles it keeps watching, just far less often. A link that
// frees up twenty minutes into a download used to stay unused for the rest of
// it, because the probe was cleared for good the first time two samples failed
// to improve.
const ADAPTIVE_IDLE_PROBE_MS = 30000;
// A sample this much worse than the one before the last increase means the
// increase hurt — a saturated uplink or an edge that started shaping us.
const ADAPTIVE_REGRESS_RATIO = 0.92;
const CHUNK_TIMEOUT = 30000;
const CHUNK_RETRIES = 5;
const CDN_DIR_URL = 'https://api.steampowered.com/IContentServerDirectoryService/GetServersForSteamPipe/v1/';
// The mirror list is asked for again once fewer than half of it is healthy,
// but not more often than this: a directory service that keeps handing back
// the same dead edges should not be hammered for it.
const CDN_REFRESH_MIN_MS = 30000;
// Checkpoint flushes back off when they run long — a spinning disk with many
// open files can take longer to fsync than the interval between flushes — and
// come back down when they are quick again. Bounded either way.
const STATE_SAVE_MAX_INTERVAL_MULT = 4;
const FALLBACK_CDNS = ['steampipe.akamaized.net'];
const FLAG_DIRECTORY = 0x40;
const SPEED_WINDOW = 3000;
const SPEED_SAMPLE_MS = 50;         // finest granularity the rate window keeps
const SPEED_EMIT_INTERVAL = 800;
const REUSE_EMIT_INTERVAL = 5000;   // live "reused vs downloaded" line, update/repair only
const MARKER_DIR = '.DepotDownloader';
// Engine scratch lives inside the marker directory, which every "is anything
// installed here?" scan already skips. It used to sit in the install directory
// itself, where it counted as a game file — which quietly disabled both the
// disk-space preflight and the guard against registering a vanished install.
const STATE_FILENAME = '.librarian-pipe-state.json';
const STATE_SAVE_INTERVAL_MS = 3000;
// Time alone is a poor checkpoint trigger: on a fast link three seconds is most
// of a gigabyte to fetch again after a crash. The bitmap is ~7.5 KB for a
// 60k-chunk game, so checkpointing on volume too is nearly free.
const STATE_SAVE_CHUNKS = 512;
const RECOVERY_CACHE = '.librarian-reuse.bin';   // staged copy of data lifted from the previous build
const RECOVERY_INDEX = `${RECOVERY_CACHE}.json`;  // what is in it, so a resume can reuse it
// A host is benched once it has failed this many times; it can still be used if
// every other mirror is also benched.
const HOST_FAIL_LIMIT = 8;
// Open file handles kept warm. Downloads are ordered by file, so the working set
// is roughly the worker count; this is deliberately generous headroom.
const FD_CACHE_LIMIT = 96;
// Valve's own name for a local content cache. Steam resolves this host and, if
// something answers, serves depot content from it; we do the same.
const LANCACHE_HOST = 'lancache.steamcontent.com';
// A mirror that answers but trickles never throws, so the 30 s timeout never
// fires for a 1 MB chunk at 200 KB/s. A request is abandoned once it has run
// longer than this multiple of what the pool's median mirror would have taken,
// with a floor so a brief hiccup is not mistaken for a bad edge.
const STALL_FACTOR = 4;
const STALL_FLOOR_MS = 5000;
// The most any one request may take, however slow the link. CHUNK_TIMEOUT is
// how long a request may stay *silent*; this is the outer bound on one that
// keeps sending.
const STALL_CEILING_MS = 10 * 60 * 1000;
// Larger than any body a depot serves (chunks are about a megabyte). A
// Content-Length past this is a broken edge, not something to allocate for.
const MAX_CHUNK_BODY = 64 * 1024 * 1024;
// How many mirrors carry the download at once. Measured on a 200 ms link:
// sixteen connections rotated across the fifteen "healthiest third" mirrors
// left every socket idle between requests, so each megabyte started from a
// cold congestion window. A few mirrors keep the same connections busy.
const ACTIVE_HOSTS_MAX = 4;
// A mirror outside the active set is given one request every so often, so the
// ranking is corrected by a real transfer rather than left to the probe.
const TRIAL_EVERY = 48;
const TRIAL_DEPTH = 4;
// A mirror with this many failures is ranked behind every cleaner one.
const HOST_SUSPECT_FAILS = 3;
// Decoded chunks kept in memory for their other destinations. Repeated content
// tends to be adjacent — runs of the same padding block — so a small window
// serves most duplicates without a read.
const RECENT_CHUNK_BYTES = 48 * 1024 * 1024;
// Disk failures a retry cannot fix. The job stops at once instead of
// downloading every remaining chunk only to fail writing it.
const DISK_HALT_CODES = new Set(['ENOSPC', 'EDQUOT', 'EIO', 'EROFS']);
const STAGING_CONCURRENCY = 8;
// How long the whole pool stands down when Steam answers 429 without saying.
const RATE_LIMIT_COOLDOWN_MS = 5000;
const RATE_LIMIT_MAX_MS = 60000;

// ── Protobuf wire-format reader ─────────────────────────────────

class PbReader {
  constructor(buf) { this.b = buf; this.p = 0; }
  eof() { return this.p >= this.b.length; }

  varint() {
    let r = 0n, s = 0n;
    do {
      if (this.p >= this.b.length) throw new Error('varint: unexpected EOF');
      const c = this.b[this.p++];
      r |= BigInt(c & 0x7f) << s;
      if (!(c & 0x80)) return r;
      s += 7n;
    } while (s < 64n);
    throw new Error('varint: overflow');
  }

  tag() {
    if (this.eof()) return null;
    const v = this.varint();
    return { f: Number(v >> 3n), w: Number(v & 7n) };
  }

  fixed32() {
    if (this.p + 4 > this.b.length) throw new Error('fixed32: unexpected EOF');
    const v = this.b.readUInt32LE(this.p);
    this.p += 4;
    return v;
  }

  bytes() {
    const n = Number(this.varint());
    if (this.p + n > this.b.length) throw new Error('length-delimited field overflows buffer');
    const d = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return d;
  }

  str() { return this.bytes().toString('utf-8'); }

  skip(w) {
    if (w === 0) this.varint();
    else if (w === 1) this.p += 8;
    else if (w === 2) this.p += Number(this.varint());
    else if (w === 5) this.p += 4;
    else throw new Error(`unknown wire type ${w}`);
  }
}

// ── Steam depot manifest parser ─────────────────────────────────

function parseChunkProto(buf) {
  const r = new PbReader(buf);
  const c = { sha: null, crc: 0, offset: 0n, cbOriginal: 0, cbCompressed: 0 };
  while (!r.eof()) {
    const t = r.tag(); if (!t) break;
    switch (t.f) {
      case 1: c.sha = Buffer.from(r.bytes()); break;
      // crc is a protobuf fixed32 (wire type 5), NOT a varint. Reading it as a
      // varint consumes the wrong number of bytes and desyncs every subsequent
      // field/chunk, corrupting the whole manifest parse.
      case 2: c.crc = (t.w === 5) ? r.fixed32() : Number(r.varint()); break;
      case 3: c.offset = r.varint(); break;
      case 4: c.cbOriginal = Number(r.varint()); break;
      case 5: c.cbCompressed = Number(r.varint()); break;
      default: r.skip(t.w);
    }
  }
  return c;
}

function parseFileProto(buf) {
  const r = new PbReader(buf);
  const f = { filename: '', size: 0n, flags: 0, shaContent: null, chunks: [], linktarget: '' };
  while (!r.eof()) {
    const t = r.tag(); if (!t) break;
    switch (t.f) {
      case 1: f.filename = r.str(); break;
      case 2: f.size = r.varint(); break;
      case 3: f.flags = Number(r.varint()); break;
      case 4: r.bytes(); break;
      case 5: f.shaContent = Buffer.from(r.bytes()); break;
      case 6: f.chunks.push(parseChunkProto(r.bytes())); break;
      case 7: f.linktarget = r.str(); break;
      default: r.skip(t.w);
    }
  }
  return f;
}

function parsePayloadProto(buf) {
  const r = new PbReader(buf);
  const files = [];
  while (!r.eof()) {
    const t = r.tag(); if (!t) break;
    if (t.f === 1 && t.w === 2) files.push(parseFileProto(r.bytes()));
    else r.skip(t.w);
  }
  return files;
}

function readManifestFile(manifestPath, depotKey) {
  const raw = fs.readFileSync(manifestPath);
  if (raw.length < 8) throw new Error('manifest file too small');

  const magic = raw.readUInt32LE(0);
  if (magic !== PAYLOAD_MAGIC) {
    throw new Error(`bad manifest magic 0x${magic.toString(16)}`);
  }

  const len = raw.readUInt32LE(4);
  if (8 + len > raw.length) throw new Error('manifest payload exceeds file size');
  // Complete Steam manifests carry the encryption flag in METADATA. Reading
  // only PAYLOAD treated base64 ciphertext (including its line breaks) as paths.
  // Share the validated format/decryption implementation with manifest fetching.
  if (8 + len < raw.length) {
    const { getDepsPath } = require('./runtimePaths');
    const format = require(getDepsPath('steammanifest', 're', 'manifest_format.js'));
    const manifest = format.parseManifest(raw);
    if (manifest.filenames_encrypted) {
      if (typeof depotKey !== 'string' || !DEPOT_KEY_RE.test(depotKey)) {
        throw new Error('Manifest filenames are encrypted; a valid depot key is required. Re-fetch the manifest or add Steam credentials.');
      }
      const key = Buffer.from(depotKey, 'hex');
      try { format.decryptFilenames(manifest, key); }
      catch (err) { throw new Error(`Cannot decrypt manifest filenames; re-fetch the manifest and depot key. ${err.message}`); }
      finally { key.fill(0); }
    }
    return manifest.files.map(file => ({
      filename: file.filename, size: BigInt(file.size), flags: file.flags,
      shaContent: file.sha_content ? Buffer.from(file.sha_content, 'hex') : null,
      linktarget: file.linktarget || '',
      chunks: file.chunks.map(chunk => ({
        sha: chunk.sha ? Buffer.from(chunk.sha, 'hex') : null,
        crc: chunk.crc, offset: BigInt(chunk.offset),
        cbOriginal: chunk.cb_original, cbCompressed: chunk.cb_compressed,
      })),
    }));
  }
  // Retain support for the historical payload-only, optionally zlib-wrapped
  // manifests. They have no metadata or filename-encryption flag.
  const compressed = raw.subarray(8, 8 + len);

  let data;
  try { data = zlib.inflateSync(compressed); } catch { data = compressed; }

  return parsePayloadProto(data);
}

// ── Chunk pipeline ──────────────────────────────────────────────
//
// Decrypting, unwrapping and verifying a chunk all live in chunkCodec.js, so
// the worker threads and the inline fallback cannot drift apart about what a
// valid chunk is. What remains here is the pool that keeps that work off the
// thread driving the UI.

const { shaVerify, processChunk: processChunkInline } = chunkCodec;

/**
 * Report whether this build can actually run the native engine, so the caller
 * can refuse the download *before* starting rather than failing partway
 * through. Delegated to the codec, which owns the decoders.
 */
function checkNativeEngineSupport() {
  return chunkCodec.checkCodecSupport();
}

/**
 * Fixed pool of worker threads running the entire per-chunk pipeline: AES
 * decrypt, container unwrap, decompress, size check and SHA-1.
 *
 * All of that used to run on the Electron main thread. A megabyte chunk costs
 * a couple of milliseconds of pure CPU, so at 100 MB/s it consumed about a
 * fifth of the event loop and past a few hundred MB/s the event loop, not the
 * link, was the ceiling — visible as a UI that stuttered in proportion to how
 * well the download was going.
 *
 * One chunk at a time per worker: the work is CPU-bound, so the useful width
 * is the core count, not the connection count. Encrypted bodies are
 * transferred rather than copied in both directions.
 */
function createChunkPool(poolSize) {
  const workers = [];
  const idle = [];
  const waiters = [];
  let terminated = false;

  function rejectAllWaiters(err) {
    for (const w of waiters.splice(0)) w.reject(err);
  }
  function release(worker) {
    if (terminated) { try { worker.terminate(); } catch {} return; }
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(worker);
    else idle.push(worker);
  }
  function spawn() {
    const worker = new Worker(path.join(__dirname, 'chunkWorker.js'));
    worker._task = null;
    worker.on('message', (msg) => {
      const task = worker._task;
      worker._task = null;
      if (task) {
        if (msg && msg.error) {
          const err = new Error(msg.error);
          if (msg.code) err.code = msg.code;
          task.reject(err);
        } else if (msg && 'ok' in msg) {
          task.resolve({ ok: msg.ok, data: Buffer.from(msg.data) });
        } else {
          task.resolve(Buffer.from(msg.result));
        }
      }
      release(worker);
    });
    worker.on('error', (err) => {
      const task = worker._task;
      worker._task = null;
      if (task) task.reject(err);
      const wi = workers.indexOf(worker); if (wi >= 0) workers.splice(wi, 1);
      const ii = idle.indexOf(worker); if (ii >= 0) idle.splice(ii, 1);
      // If every worker has died, don't let queued callers hang forever.
      if (!terminated && workers.length === 0) rejectAllWaiters(err);
    });
    // A thread can end without raising 'error' — killed for memory, or exiting
    // on its own. Its chunk would otherwise wait for an answer that is never
    // coming, and the download would sit at that percentage for good.
    worker.on('exit', (code) => {
      const task = worker._task;
      worker._task = null;
      const err = new Error(`chunk decoder thread exited (code ${code})`);
      if (task) task.reject(err);
      const wi = workers.indexOf(worker); if (wi >= 0) workers.splice(wi, 1);
      const ii = idle.indexOf(worker); if (ii >= 0) idle.splice(ii, 1);
      if (!terminated && workers.length === 0) rejectAllWaiters(err);
    });
    workers.push(worker);
    return worker;
  }

  for (let i = 0; i < poolSize; i++) idle.push(spawn());

  return {
    get width() { return workers.length; },

    /**
     * @param {ArrayBuffer} encrypted  transferred to the worker; do not reuse it
     * @returns {Promise<Buffer>} the verified plaintext chunk
     */
    async run(encrypted, keyHex, size, sha) {
      if (terminated) throw new Error('chunk pool terminated');
      let worker;
      if (idle.length) {
        worker = idle.pop();
      } else if (workers.length === 0) {
        // Every worker died — reject rather than queue a waiter that cannot resolve.
        throw new Error('chunk decoder workers are unavailable');
      } else {
        worker = await new Promise((resolve, reject) => waiters.push({ resolve, reject }));
      }
      return new Promise((resolve, reject) => {
        worker._task = { resolve, reject };
        // `sha` is 20 bytes and is reused across retries, so it is cloned, not
        // transferred — detaching it would empty the manifest's own copy.
        worker.postMessage({ encrypted, keyHex, size, sha }, [encrypted]);
      });
    },

    /**
     * SHA-1 a buffer read off the disk, on a worker, and hand it back.
     *
     * Downloads left the calling thread in round one; the reads did not. A
     * repair of a 60 GB install was 60 GB of SHA-1 on the thread driving the
     * UI — the same stutter the download used to have, confined to update and
     * repair. The buffer is transferred out and transferred back, so it can be
     * written afterwards without a copy in either direction.
     *
     * @param {Buffer} data  must own its memory; detached on return
     * @returns {Promise<{ok:boolean, data:Buffer}>}
     */
    async verify(data, sha) {
      if (terminated) throw new Error('chunk pool terminated');
      let worker;
      if (idle.length) {
        worker = idle.pop();
      } else if (workers.length === 0) {
        throw new Error('chunk decoder workers are unavailable');
      } else {
        worker = await new Promise((resolve, reject) => waiters.push({ resolve, reject }));
      }
      const ab = data.buffer.byteLength === data.byteLength && data.byteOffset === 0
        ? data.buffer
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      return new Promise((resolve, reject) => {
        worker._task = { resolve, reject };
        worker.postMessage({ op: 'hash', data: ab, sha }, [ab]);
      });
    },

    terminate() {
      if (terminated) return;
      terminated = true;
      rejectAllWaiters(new Error('chunk pool terminated'));
      for (const worker of workers.splice(0)) { try { worker.terminate(); } catch {} }
      idle.length = 0;
    },
  };
}

// ── CDN server resolution ───────────────────────────────────────

/**
 * @param directoryUrl  where to ask. Steam's own service by default; a user
 *                      can point at a directory mirror, and the end-to-end
 *                      tests point at a local one.
 */
async function resolveCdn(cellId, directoryUrl = CDN_DIR_URL) {
  // The directory service is a single point of failure for the whole download,
  // so give it a couple of attempts before dropping to the static fallback.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `${directoryUrl}?cell_id=${cellId || 0}&max_servers=40`;
      const res = await fetch(url, { timeout: 10000 });
      if (!res.ok) throw new Error(`${res.status}`);
      const json = await res.json();
      const hosts = [...new Set((json?.response?.servers || [])
        .filter(s => s.https_support === 'mandatory' || s.https_support === 'optional')
        .map(s => s.vhost || s.host)
        .filter(Boolean))];
      if (hosts.length) return hosts;
    } catch {
      if (attempt < 2) await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  return [...FALLBACK_CDNS];
}

/** RFC1918 / loopback / link-local — i.e. something on this network, not the internet. */
function isPrivateAddress(addr) {
  if (!addr) return false;
  if (addr === '::1' || addr.startsWith('fc') || addr.startsWith('fd') || addr.startsWith('fe80')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Look for a Lancache on this network.
 *
 * Valve publishes `lancache.steamcontent.com` for exactly this: a site running
 * a content cache answers it from local DNS, and Steam then pulls depot content
 * from the cache instead of the internet. A hit runs at local-network speed,
 * which is worth more than every other tuning in this file put together.
 *
 * The address has to be a private one. A public answer means we are looking at
 * ordinary internet DNS rather than a cache someone runs, and routing a whole
 * download through it would be worse than not trying.
 */
async function detectLancache() {
  try {
    const { address } = await Promise.race([
      dns.promises.lookup(LANCACHE_HOST),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
    ]);
    if (!isPrivateAddress(address)) return { found: false, address, public: true };
    return { found: true, address };
  } catch {
    return { found: false };
  }
}

/**
 * Rank mirrors by a quick reachability probe before the first chunk is asked for.
 *
 * Without this, every host starts identical and the "healthiest third" is just
 * whatever order the directory service happened to answer in — for the first
 * few dozen picks the pool is choosing at random, on a list that routinely
 * contains edges nowhere near the user. One small request each, in parallel,
 * costs well under a second and gives the ranking something real to start from.
 */
async function probeHosts(hosts, agent, signal, timeoutMs = 2500) {
  const results = await Promise.all(hosts.map(async (host) => {
    const started = Date.now();
    try {
      const res = await fetch(`https://${host}/`, {
        method: 'HEAD', timeout: timeoutMs, agent, signal, compress: false,
      });
      // Any answer at all proves the edge is reachable and how quickly. A 404
      // for the bare root is the normal, healthy response from a depot server.
      void res.status;
      return { host, ms: Date.now() - started };
    } catch {
      return { host, ms: null };
    }
  }));
  return results;
}

/**
 * Health-ranked mirror list.
 *
 * Round-robining blindly over every server the directory hands back means a
 * throttled or half-broken edge keeps getting an equal share of the download.
 * Each host carries a failure count and an EWMA of observed throughput; picks
 * rotate over the few best so the duds fall out of rotation and the
 * connections to the good ones never sit idle.
 */
class HostPool {
  constructor(hosts) {
    this.entries = hosts.map(host => ({ host, fails: 0, ok: 0, ewma: 0, preferred: false }));
    this.cursor = 0;
    this.dirty = false;
    this.picksSinceSort = 0;
    this.picksSinceTrial = 0;
    this.activeHosts = 3;
    // Set while the whole pool is standing down after a rate-limit answer.
    this.cooldownUntil = 0;
  }

  get size() { return this.entries.length; }

  /**
   * Size the active set to the connections that will use it.
   *
   * Two is the floor: with one mirror there is nothing to compare it against,
   * so one that turns slow looks normal. Past that, a mirror is only worth
   * adding once there are enough connections to keep its sockets busy.
   */
  setWorkers(count) {
    this.activeHosts = count <= 8 ? 2 : count <= 24 ? 3 : ACTIVE_HOSTS_MAX;
  }

  /**
   * Put a host at the front of the queue unconditionally while it is healthy.
   *
   * Used for a detected Lancache: it is not one mirror among many, it is a
   * local disk, and spreading load across "the healthiest third" would only
   * send most of the download to the internet instead.
   */
  addPreferred(host, scheme = 'https') {
    const entry = { host, fails: 0, ok: 0, ewma: 0, preferred: true, scheme };
    this.entries.unshift(entry);
    return entry;
  }

  /** Seed the ranking from a reachability probe, before any chunk is fetched. */
  seedLatency(samples) {
    const byHost = new Map(samples.map(s => [s.host, s.ms]));
    for (const entry of this.entries) {
      if (entry.preferred) continue;
      const ms = byHost.get(entry.host);
      if (ms === null || ms === undefined) {
        // Unreachable for the probe. Not benched outright — a mirror can refuse
        // a bare HEAD and still serve chunks — but it starts at the back.
        entry.fails = Math.max(entry.fails, 1);
        continue;
      }
      // A latency in milliseconds is not a throughput, but the ordering it
      // produces is the one we want and it is replaced by the real figure as
      // soon as that host has served a chunk.
      entry.ewma = 1000 / Math.max(1, ms);
    }
    this._resort();
  }

  pick() {
    if (this.dirty && this.picksSinceSort++ > 32) this._resort();
    const preferred = this.entries.find(e => e.preferred && e.fails < HOST_FAIL_LIMIT);
    if (preferred) return preferred;
    const live = this.entries.filter(e => e.fails < HOST_FAIL_LIMIT);
    const pool = live.length ? live : this.entries;
    // Rotate over the best few, never fewer than two while two exist. It used
    // to be the healthiest third: fourteen mirrors of a forty-entry answer, so
    // each connection carried one chunk and then idled while the rotation went
    // round the others, and the server restarted it from a cold window.
    const top = Math.min(pool.length, Math.max(2, this.activeHosts));
    // The ranking outside the active set is only a reachability probe. Give
    // the next mirror in line a single real request now and then, so one that
    // would outperform the current set can be found without the set failing.
    if (++this.picksSinceTrial >= TRIAL_EVERY) {
      this.picksSinceTrial = 0;
      const trial = pool.slice(top, top + TRIAL_DEPTH).find(e => e.ok === 0 && e.fails === 0 && !e.trialled);
      if (trial) { trial.trialled = true; return trial; }
    }
    return pool[this.cursor++ % top];
  }

  /** A different host than `entry`, for the next retry of the same chunk. */
  pickAlternate(entry) {
    const pool = this.entries.filter(e => e !== entry && e.fails < HOST_FAIL_LIMIT);
    if (!pool.length) return this.pick();
    return pool[this.cursor++ % pool.length];
  }

  succeeded(entry, bytes, ms) {
    entry.ok++;
    if (entry.fails > 0) entry.fails--;   // let a recovered mirror climb back
    // Clamped to a millisecond, not skipped when the clock says zero. A mirror
    // fast enough to round to 0 ms — a Lancache, a nearby edge — would
    // otherwise never record a throughput at all, leaving it unranked and the
    // pool with no median to judge a slow mirror against.
    const bps = (bytes / Math.max(1, ms)) * 1000;
    entry.ewma = entry.ewma ? entry.ewma * 0.7 + bps * 0.3 : bps;
    this.dirty = true;
  }

  /**
   * @param weight  how much to hold against the host. A connection that fails
   *                costs 1. A body that arrived and then failed its checksum
   *                costs 2: the arrival was already credited as a success —
   *                and forgave one earlier failure — so a single point would
   *                leave a garbage-serving mirror oscillating just below the
   *                bench forever, and it also wasted a whole transfer.
   */
  failed(entry, weight = 1) {
    entry.fails += weight;
    this.dirty = true;
  }

  /**
   * Typical observed throughput across mirrors that have actually served
   * something, in bytes per second. 0 until the pool has enough evidence.
   *
   * This is what makes "too slow" a decidable question: a mirror is slow
   * relative to its peers on this link, not relative to a number picked in
   * advance that would be wrong on both fibre and hotel wifi.
   */
  medianRate() {
    const rates = this.entries.filter(e => e.ok > 0 && e.ewma > 0).map(e => e.ewma).sort((a, b) => a - b);
    // Two is the fewest that makes this a comparison rather than a mirror being
    // measured against itself — with one, a host that slowed down would be
    // judged against the average it had already dragged down, and there would
    // be nowhere else to send the retry anyway.
    if (rates.length < 2) return 0;
    return rates[rates.length >> 1];
  }

  /** Stand the whole pool down — Steam has asked us to slow down. */
  coolDown(ms) {
    const until = Date.now() + Math.min(RATE_LIMIT_MAX_MS, Math.max(0, ms));
    if (until > this.cooldownUntil) this.cooldownUntil = until;
  }

  cooldownRemaining() {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  _resort() {
    // Preferred hosts sort ahead of everything; among the rest, the ones that
    // keep failing go behind the ones that do not, and then fastest first.
    //
    // Failures are a tier, not the leading sort key. Ordering by the raw count
    // put a fast mirror with one timeout behind every mirror that had never
    // been asked for anything — and once outside the active set it was never
    // picked again, so it could not earn the failure back.
    const tier = (e) => (e.fails >= HOST_FAIL_LIMIT ? 2 : e.fails >= HOST_SUSPECT_FAILS ? 1 : 0);
    this.entries.sort((a, b) =>
      (Number(b.preferred) - Number(a.preferred)) || (tier(a) - tier(b)) || (b.ewma - a.ewma));
    this.dirty = false;
    this.picksSinceSort = 0;
  }

  healthyCount() {
    return this.entries.filter(e => e.fails < HOST_FAIL_LIMIT).length;
  }

  /**
   * Take in a fresh answer from the directory service. Hosts already known
   * keep their history — including their benching — and only genuinely new
   * ones are added, unranked, which sorts them ahead of anything benched.
   * @returns how many were new
   */
  merge(hostList) {
    const known = new Set(this.entries.map(e => e.host));
    let added = 0;
    for (const host of hostList) {
      if (!host || known.has(host)) continue;
      known.add(host);
      this.entries.push({ host, fails: 0, ok: 0, ewma: 0, preferred: false });
      added++;
    }
    if (added) this._resort();
    return added;
  }

  summary() {
    const healthy = this.entries.filter(e => e.fails < HOST_FAIL_LIMIT).length;
    return `${healthy}/${this.entries.length} mirrors healthy`;
  }
}

/**
 * Token-bucket rate limiter for the whole job, or a pass-through when the user
 * has not set a cap.
 *
 * Steam has had a bandwidth limit for years, for the obvious reason: a download
 * that saturates the link makes everything else in the house unusable, so
 * people cap it and leave it running instead of babysitting it.
 */
function createRateLimiter(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond <= 0) return { take: async () => {}, enabled: false };
  const capacity = Math.max(bytesPerSecond, 1 << 20);   // a second of burst
  let tokens = capacity;
  let last = Date.now();

  return {
    enabled: true,
    limit: bytesPerSecond,
    async take(bytes) {
      // Cost is capped at the bucket size so a chunk larger than one second's
      // budget cannot deadlock waiting for tokens that will never all exist.
      const want = Math.min(bytes, capacity);
      for (;;) {
        const now = Date.now();
        tokens = Math.min(capacity, tokens + ((now - last) / 1000) * bytesPerSecond);
        last = now;
        if (tokens >= want) { tokens -= want; return; }
        const deficit = want - tokens;
        await new Promise(r => setTimeout(r, Math.min(1000, Math.ceil((deficit / bytesPerSecond) * 1000) + 5)));
      }
    },
  };
}

// ── Chunk fetch with retry ──────────────────────────────────────

function sleepAbortable(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', finish);
      resolve();
    }
    signal?.addEventListener?.('abort', finish, { once: true });
  });
}

/** `Retry-After` is either a delay in seconds or an HTTP date. */
function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(value);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : 0;
}

/**
 * Fetch one encrypted chunk, rotating mirrors on retry so a single flaky or
 * blocked edge can't abort the download. `signal` lets a cancel tear down every
 * in-flight request immediately instead of waiting out the timeout.
 *
 * Three things beyond a plain GET:
 *
 * Slow is a failure, not a success. A mirror that accepts the connection and
 * then trickles never throws, so it used to keep its place in the rotation
 * forever — the 30 s timeout does not fire for a megabyte at 200 KB/s. Each
 * request now gets a budget derived from what the pool's median mirror would
 * take, and blowing it aborts the request and benches the host.
 *
 * Rate limiting is answered rather than fought. Every worker hitting a 429 used
 * to burn all five of its retries against a server that had just asked us to
 * stop, five times over, simultaneously. Now the pool stands down once, for as
 * long as the response asked for.
 *
 * The body is returned as a raw ArrayBuffer so it can be transferred to a
 * decoder thread rather than copied.
 *
 * Silence is what times a request out, not duration. The limit used to be
 * thirty seconds for the whole body, which is a statement about the link
 * rather than the mirror: at 30 KB/s per connection — a slow line shared
 * between sixteen of them — no megabyte chunk can arrive in time, every
 * request is thrown away just short of finishing, and the download never ends.
 */
async function fetchChunk(pool, depotId, shaHex, agent, signal, opts = {}) {
  const { expectedBytes = 0, limiter = null, onBytes = null } = opts;
  let lastErr = null;
  let entry = pool.pick();

  for (let i = 0; i < CHUNK_RETRIES; i++) {
    if (signal?.aborted) throw new Error('cancelled');

    const cooling = pool.cooldownRemaining();
    if (cooling > 0) await sleepAbortable(cooling, signal);
    if (signal?.aborted) throw new Error('cancelled');

    // Per-request control chained to the job's, so a stall can be cut short
    // without disturbing anything else in flight.
    const ac = new AbortController();
    const onJobAbort = () => ac.abort();
    signal?.addEventListener?.('abort', onJobAbort, { once: true });

    // With peers to compare against, the budget is a multiple of what the
    // median mirror would take — however long that is on this link. Without
    // them there is no such thing as "too slow", only "silent".
    const median = pool.medianRate();
    const budgetMs = (median > 0 && expectedBytes > 0)
      ? Math.max(STALL_FLOOR_MS, Math.min(STALL_CEILING_MS, (expectedBytes / median) * 1000 * STALL_FACTOR))
      : STALL_CEILING_MS;
    let stalled = false;
    const stallTimer = setTimeout(() => { stalled = true; ac.abort(); }, budgetMs);
    let silent = false;
    const idleTimer = setTimeout(() => { silent = true; ac.abort(); }, CHUNK_TIMEOUT);

    const started = Date.now();
    try {
      const res = await fetch(chunkUrl(entry, depotId, shaHex), {
        agent,
        signal: ac.signal,
        compress: false,   // chunks are already compressed; skip a pointless gzip layer
        headers: entry.scheme === 'http' ? LANCACHE_HEADERS : undefined,
      });
      idleTimer.refresh();

      if (res.status === 429 || res.status === 503) {
        const wait = parseRetryAfter(res.headers.get('retry-after')) || RATE_LIMIT_COOLDOWN_MS;
        pool.coolDown(wait);
        const err = new Error(`HTTP ${res.status} (rate limited) from ${entry.host}`);
        err.rateLimited = true;
        throw err;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${entry.host}`);

      const ab = await readBody(res, (n) => { idleTimer.refresh(); if (onBytes) onBytes(n); });
      clearTimeout(stallTimer);
      clearTimeout(idleTimer);
      pool.succeeded(entry, ab.byteLength, Date.now() - started);
      // Charged after the fact, against what actually arrived: the next request
      // this worker makes is the one that waits.
      if (limiter?.enabled) await limiter.take(ab.byteLength);
      // The host comes back with the body. A body that later fails its checksum
      // is this mirror's failure, and the caller is the only one who will know.
      return { ab, entry };
    } catch (err) {
      if (signal?.aborted) throw new Error('cancelled');
      lastErr = stalled
        ? new Error(`${entry.host} stalled (slower than ${formatSpeed(median / STALL_FACTOR)})`)
        : silent
          ? new Error(`${entry.host} sent nothing for ${Math.round(CHUNK_TIMEOUT / 1000)} s`)
          : err;
      // A rate limit is the server's problem with the moment, not with this
      // mirror. Benching it would empty the pool during any throttling episode.
      if (!err.rateLimited) pool.failed(entry);
      entry = pool.pickAlternate(entry);
      if (i < CHUNK_RETRIES - 1) await sleepAbortable(400 * (i + 1), signal);
    } finally {
      clearTimeout(stallTimer);
      clearTimeout(idleTimer);
      signal?.removeEventListener?.('abort', onJobAbort);
    }
  }
  throw lastErr || new Error('chunk download failed');
}

// A Lancache only caches plain HTTP — anything over TLS is passed through to
// the internet untouched, so asking it over HTTPS got none of the benefit. The
// request identifies itself the way the Steam client's does, so both are filed
// as the same content.
const LANCACHE_HEADERS = { 'user-agent': 'Valve/Steam HTTP Client 1.0' };

function chunkUrl(entry, depotId, shaHex) {
  return `${entry.scheme === 'http' ? 'http' : 'https'}://${entry.host}/depot/${depotId}/chunk/${shaHex}`;
}

/**
 * Collect a response body into one ArrayBuffer that owns its memory.
 *
 * `onData(n)` fires as bytes arrive, which is what lets the caller time a
 * request out on silence and report a transfer rate that moves between chunk
 * boundaries. When the length is declared the buffer is allocated once and
 * filled in place; a body that ends short of it is a truncated transfer and is
 * reported as one, rather than being left for the decoder to trip over.
 */
function readBody(res, onData) {
  return new Promise((resolve, reject) => {
    const declared = Number(res.headers.get('content-length'));
    const known = Number.isInteger(declared) && declared > 0;
    if (known && declared > MAX_CHUNK_BODY) {
      res.body.destroy();
      reject(new Error(`implausible chunk body of ${declared} bytes`));
      return;
    }
    const whole = known ? Buffer.from(new ArrayBuffer(declared)) : null;
    const parts = [];
    let got = 0;
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; res.body.destroy(); reject(err); } };

    res.body.on('data', (piece) => {
      if (settled) return;
      if (got + piece.length > (known ? declared : MAX_CHUNK_BODY)) {
        fail(new Error('chunk body is longer than declared'));
        return;
      }
      if (known) piece.copy(whole, got); else parts.push(piece);
      got += piece.length;
      onData(piece.length);
    });
    res.body.on('error', fail);
    res.body.on('end', () => {
      if (settled) return;
      if (known && got !== declared) { fail(new Error(`truncated chunk body: ${got} of ${declared} bytes`)); return; }
      settled = true;
      if (known) { resolve(whole.buffer); return; }
      const all = Buffer.concat(parts, got);
      resolve(all.buffer.slice(all.byteOffset, all.byteOffset + got));
    });
  });
}

// ── Path safety ─────────────────────────────────────────────────

// File paths come from a third-party manifest (Hubcap). Resolve each against the
// install dir and reject anything that escapes it (via '..', an absolute path, or
// a drive-letter component), so a malicious/malformed manifest can't write files
// outside the destination. Handles both '/' and '\' separators the depots use.
function safeResolveInside(baseDir, relFilename) {
  const rel = String(relFilename || '').replace(/[\\/]+/g, path.sep);
  const base = path.resolve(baseDir);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`Manifest contains an unsafe file path: ${relFilename}`);
  }
  return abs;
}

// ── Open-file cache ─────────────────────────────────────────────

/**
 * Keeps file handles warm across chunk writes.
 *
 * The previous implementation did open/write/close *synchronously* for every
 * chunk: on a 60 GB game that is ~60k blocking syscall triples on the Electron
 * main thread. Chunks are processed in file order, so a small LRU of handles
 * turns that into one open per file, with positional async writes in between.
 */
function createFileCache(limit) {
  const entries = new Map();   // absolute path -> { refs, used, promise, handle }
  let clock = 0;
  let closed = false;
  // Files written since the last flush. The resume bitmap is only allowed to
  // claim chunks whose bytes have been forced out of the page cache, so it
  // needs to know which handles are actually carrying dirty data.
  const dirty = new Set();

  /**
   * @param sizeHint  the length the manifest declares for this file, when the
   *                  caller is about to write to it. A file shorter than that
   *                  is extended on open, which reserves the clusters up front:
   *                  fragmentation stops, and running out of space becomes an
   *                  error at open rather than a failed write mid-download.
   *                  Never shrinks — a longer file may still be holding bytes
   *                  the update is about to recover from it.
   */
  async function acquire(filePath, sizeHint = 0) {
    let entry = entries.get(filePath);
    if (!entry) {
      entry = { refs: 0, used: ++clock, promise: null, handle: null, reserved: 0 };
      entry.promise = (async () => {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        // 'r+' keeps existing content (vital for resume and for update/repair);
        // 'wx+' creates without clobbering a file another worker just made.
        try {
          entry.handle = await fs.promises.open(filePath, 'r+');
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
          try {
            entry.handle = await fs.promises.open(filePath, 'wx+');
          } catch (raceErr) {
            if (raceErr.code !== 'EEXIST') throw raceErr;
            entry.handle = await fs.promises.open(filePath, 'r+');
          }
        }
        return entry.handle;
      })();
      entries.set(filePath, entry);
    }
    if (sizeHint > 0 && entry.reserved < sizeHint) {
      // Marked before the await so concurrent writers to the same file do not
      // all queue up to extend it.
      entry.reserved = sizeHint;
      const handle = await entry.promise;
      try {
        const { size } = await handle.stat();
        if (size < sizeHint) await handle.truncate(sizeHint);
      } catch (err) {
        // ENOSPC here is the whole point: surface it as the write would have.
        if (err.code === 'ENOSPC') throw err;
        // Anything else (an odd filesystem refusing to extend) is not fatal —
        // the positional writes still work, just without the reservation.
      }
    }
    entry.refs++;
    entry.used = ++clock;
    try {
      return await entry.promise;
    } catch (err) {
      entry.refs--;
      entries.delete(filePath);
      throw err;
    }
  }

  function release(filePath) {
    const entry = entries.get(filePath);
    if (!entry) return;
    entry.refs--;
    if (!closed && entries.size > limit) void evict();
  }

  // Evictions whose flush has not finished. A checkpoint that ran in that
  // window used to find the file gone from both `entries` and `dirty`, take
  // that to mean it was already on disk, and claim its chunks.
  const evicting = new Set();

  async function evict() {
    const idle = [...entries.entries()]
      .filter(([, e]) => e.refs <= 0 && e.handle)
      .sort((a, b) => a[1].used - b[1].used);
    const excess = entries.size - limit;
    for (let i = 0; i < Math.min(excess, idle.length); i++) {
      const [p, e] = idle[i];
      // Delete before closing so nothing can hand out a closing handle.
      entries.delete(p);
      // An evicted handle can no longer be synced by flushDirty, and closing is
      // not a flush. Push it down now, or the resume bitmap could come to claim
      // bytes that only ever reached the page cache.
      if (dirty.has(p)) {
        dirty.delete(p);
        const flush = e.handle.sync().then(() => true, () => false);
        evicting.add(flush);
        try { await flush; } finally { evicting.delete(flush); }
      }
      try { await e.handle.close(); } catch {}
    }
  }

  function markDirty(filePath) { dirty.add(filePath); }

  /**
   * Force everything written since the last call out to stable storage.
   *
   * Closing a handle does not do this, and neither does a resolved write: both
   * leave the bytes in the operating system's page cache, where a power loss
   * eats them. The resume bitmap is durable — it is written and renamed — so
   * without this it could outlive the data it claims, and the next run would
   * skip chunks that were never really written. That failure is silent until
   * the game refuses to start.
   *
   * Only files actually written since the last flush are touched.
   */
  async function flushDirty() {
    const pending = [...dirty];
    dirty.clear();
    // Files being evicted right now are flushing on their own; wait for them.
    let ok = (await Promise.all([...evicting])).every(Boolean);
    await Promise.all(pending.map(async (p) => {
      const entry = entries.get(p);
      if (!entry) return;                       // evicted; its close already pushed it down
      try {
        const handle = entry.handle || await entry.promise;
        await handle.sync();
      } catch {
        // A file that cannot be synced is one we should not claim as durable.
        dirty.add(p);
        ok = false;
      }
    }));
    return ok;
  }

  /** Same, on a thread that is about to go away. */
  function flushDirtySync() {
    const pending = [...dirty];
    dirty.clear();
    // An eviction still flushing cannot be waited for here, so nothing written
    // before it may be claimed yet.
    let ok = evicting.size === 0;
    for (const p of pending) {
      const entry = entries.get(p);
      if (!entry) continue;                     // evicted; its close already pushed it down
      if (!entry.handle) { dirty.add(p); ok = false; continue; }
      try { fs.fsyncSync(entry.handle.fd); } catch { dirty.add(p); ok = false; }
    }
    return ok;
  }

  async function closeAll() {
    closed = true;
    for (const [p, entry] of [...entries]) {
      entries.delete(p);
      try {
        const handle = entry.handle || await entry.promise;
        await handle.close();
      } catch { /* a handle that never opened has nothing to close */ }
    }
    dirty.clear();
  }

  return { acquire, release, closeAll, markDirty, flushDirty, flushDirtySync };
}

/**
 * Delete directories left empty by the orphan sweep, deepest first.
 *
 * A build that drops a whole folder of content otherwise leaves the skeleton
 * behind. The install root itself is never removed, and neither is anything
 * that still contains a file.
 */
function pruneEmptyDirs(rootDir) {
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    let keep = false;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === MARKER_DIR) { keep = true; continue; }
        const child = path.join(dir, entry.name);
        if (walk(child)) keep = true;
        else { try { fs.rmdirSync(child); } catch { keep = true; } }
      } else {
        keep = true;
      }
    }
    return keep;
  };
  walk(rootDir);
}

/**
 * True if the directory holds any actual payload, recursively.
 *
 * Used for two decisions: whether a fresh install needs a disk-space check, and
 * whether an "everything is done" resume has anything to register.
 *
 * Our own marker directory does not count — that is engine scratch, not game
 * content. Neither does a zero-byte file: the manifest enumeration materialises
 * every empty file the depot declares before a single chunk is fetched, so
 * counting those would mean any game containing one empty file always looks
 * installed, including immediately after its payload was deleted.
 */
function directoryHasFiles(dirPath) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name === MARKER_DIR) continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isFile()) {
      try { if (fs.statSync(full).size > 0) return true; } catch {}
      continue;
    }
    if (entry.isDirectory() && directoryHasFiles(full)) return true;
  }
  return false;
}

// ── Speed tracker ───────────────────────────────────────────────

class SpeedTracker {
  constructor() { this.samples = []; }

  /**
   * One sample per SPEED_SAMPLE_MS at most. This used to push a sample per
   * completed chunk and shift the array from the front to expire old ones —
   * at a few thousand chunks a second that is a few thousand O(n) shifts a
   * second, for a readout that is only refreshed several times a second. A
   * sample arriving inside the same slot just updates the slot's byte count.
   */
  record(bytes) {
    const now = Date.now();
    const last = this.samples[this.samples.length - 1];
    if (last && now - last.t < SPEED_SAMPLE_MS) {
      last.b = bytes;
      return;
    }
    this.samples.push({ t: now, b: bytes });
    const cutoff = now - SPEED_WINDOW;
    let drop = 0;
    while (drop < this.samples.length - 1 && this.samples[drop].t < cutoff) drop++;
    if (drop) this.samples.splice(0, drop);
  }

  /**
   * Bytes per second across the window.
   *
   * Deliberately measured between the first and last sample rather than up to
   * the current time: stretching the window to "now" while the byte count only
   * runs to the last sample divides real bytes by inflated seconds, and the
   * readout sits below the true rate for the whole transfer. Staying responsive
   * is the sampler's job — a caller that keeps recording while nothing arrives
   * fills the window with a flat byte count, and the rate falls to zero on its
   * own, exactly as it should.
   */
  get() {
    if (this.samples.length < 2) return 0;
    const dt = (this.samples[this.samples.length - 1].t - this.samples[0].t) / 1000;
    const db = this.samples[this.samples.length - 1].b - this.samples[0].b;
    return dt > 0.3 ? Math.max(0, db / dt) : 0;
  }

  reset() { this.samples = []; }
}

// ── Resume state ────────────────────────────────────────────────
//
// v2 stores a bitmap over the deterministic chunk-target enumeration instead of
// a map of "depot|path|offset" strings. A 60k-chunk game is 7.5 KB rather than
// several megabytes, and re-serialising it every few seconds stops being an
// O(n²) write amplifier on big installs.

function bitGet(bits, i) { return (bits[i >> 3] >> (i & 7)) & 1; }
function bitSet(bits, i) { bits[i >> 3] |= (1 << (i & 7)); }

// The state file lives inside the marker directory. It used to sit in the
// install directory itself, where every "does this folder contain a game?"
// scan counted it as one — which silently disabled the disk-space preflight on
// any retry and made the guard against registering a deleted install
// unreachable. An older file at the previous location is still read once, so a
// download interrupted before this change still resumes.
function stateFilePath(dir) { return path.join(dir, MARKER_DIR, STATE_FILENAME); }
function legacyStateFilePath(dir) { return path.join(dir, STATE_FILENAME); }

/**
 * @param legacyKeyFor  index -> "depot|path|offset", used only to upgrade a v1
 *                      file so an in-flight download survives the engine update.
 */
function loadState(dir, sig, total, legacyKeyFor) {
  for (const p of [stateFilePath(dir), legacyStateFilePath(dir)]) {
    const bits = readStateFile(p, sig, total, legacyKeyFor);
    if (bits) return bits;
  }
  return null;
}

function readStateFile(p, sig, total, legacyKeyFor) {
  try {
    if (!fs.existsSync(p)) return null;
    const json = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (json.sig !== sig) return null;

    if (json.v === 2 && typeof json.bits === 'string' && json.total === total) {
      const buf = Buffer.from(json.bits, 'base64');
      if (buf.length !== Math.ceil(total / 8)) return null;
      return buf;
    }

    // v1 → v2 migration.
    if (json.done && typeof json.done === 'object' && typeof legacyKeyFor === 'function') {
      const bits = Buffer.alloc(Math.ceil(total / 8));
      let carried = 0;
      for (let i = 0; i < total; i++) {
        if (json.done[legacyKeyFor(i)]) { bitSet(bits, i); carried++; }
      }
      return carried > 0 ? bits : null;
    }
    return null;
  } catch { return null; }
}

let stateSaveSeq = 0;

/**
 * Per-job state writer.
 *
 * The in-flight guard used to be module scope, so two jobs sharing this module
 * could suppress each other's checkpoints. Only one download runs at a time
 * today, which is the only reason that never bit; it is not a property worth
 * depending on.
 */
function createStateWriter(dir, sig, total) {
  let inFlight = false;

  function payloadFor(bits) {
    const p = stateFilePath(dir);
    return {
      p,
      tmp: `${p}.${process.pid}.${stateSaveSeq++}.tmp`,
      payload: JSON.stringify({ v: 2, sig, total, bits: bits.toString('base64') }),
    };
  }

  return {
    /** Authoritative synchronous save, for a process that may be about to end. */
    save(bits) {
      const { p, tmp, payload } = payloadFor(bits);
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(tmp, payload, 'utf-8');
        fs.renameSync(tmp, p);
      } catch {
        try { fs.unlinkSync(tmp); } catch {}
      }
    },

    /** Non-blocking checkpoint for the hot path; overlapping writes are dropped. */
    saveAsync(bits) {
      if (inFlight) return;
      inFlight = true;
      const { p, tmp, payload } = payloadFor(bits);
      fs.promises.writeFile(tmp, payload, 'utf-8')
        .then(() => fs.promises.rename(tmp, p))
        .catch(() => fs.promises.unlink(tmp).catch(() => {}))
        .finally(() => { inFlight = false; });
    },

    clear() {
      try { fs.unlinkSync(stateFilePath(dir)); } catch {}
      try { fs.unlinkSync(legacyStateFilePath(dir)); } catch {}
    },
  };
}

// ── ACF manifest ────────────────────────────────────────────────

function escVdf(v) { return String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

function writeAcf(gameData, selectedDepots, destPath, installFolder, totalSize, explicitPath) {
  const acfDir = explicitPath ? path.dirname(explicitPath) : path.join(destPath, 'steamapps');
  fs.mkdirSync(acfDir, { recursive: true });
  const appId = escVdf(gameData.appid);
  const acfPath = explicitPath || path.join(acfDir, `appmanifest_${appId}.acf`);

  let depots = '';
  for (const depotId of selectedDepots) {
    const manifestId = (gameData.manifests || {})[String(depotId)];
    const depotInfo = (gameData.depots || {})[String(depotId)] || {};
    if (manifestId) {
      depots += `\t\t"${depotId}"\n\t\t{\n\t\t\t"manifest"\t\t"${manifestId}"\n\t\t\t"size"\t\t"${depotInfo.size || '0'}"\n\t\t}\n`;
    }
  }

  const content = [
    '"AppState"',
    '{',
    `\t"appid"\t\t"${appId}"`,
    '\t"Universe"\t\t"1"',
    `\t"name"\t\t"${escVdf(gameData.game_name)}"`,
    '\t"StateFlags"\t\t"4"',
    `\t"installdir"\t\t"${escVdf(installFolder)}"`,
    `\t"LastUpdated"\t\t"${Math.floor(Date.now() / 1000)}"`,
    `\t"SizeOnDisk"\t\t"${escVdf(totalSize)}"`,
    `\t"buildid"\t\t"${escVdf(gameData.buildid || '0')}"`,
    '\t"InstalledDepots"',
    '\t{',
    depots + '\t}',
    '\t"UserConfig"',
    '\t{',
    '\t}',
    '\t"MountedConfig"',
    '\t{',
    '\t}',
    '}',
  ].join('\n');

  const tmp = `${acfPath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, acfPath);
}

// ── Format helpers ──────────────────────────────────────────────

function formatSpeed(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '0 B/s';
  const u = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let v = bps, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${u[i]}`;
}

function formatBytes(b) {
  if (!Number.isFinite(b) || b <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = b, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function getFreeDiskBytes(targetPath) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const stats = fs.statfsSync(targetPath);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(free) && free >= 0 ? free : null;
  } catch { return null; }
}

/** Errors that will never succeed on retry — abort the whole job immediately. */
function markFatal(err) { err.fatal = true; return err; }

/**
 * A disk failure that ends the job now but not for good.
 *
 * Deliberately not `fatal`: that also throws away the manifests and the staged
 * data, and here the user is about to free some space and press resume.
 */
function diskHalt(err) {
  const full = err.code === 'ENOSPC' || err.code === 'EDQUOT';
  const halt = new Error(full
    ? 'The disk is full. The download stopped where it was — free some space and resume; everything already downloaded is kept.'
    : `The disk reported an error (${err.code}). The download stopped where it was — check the drive, then resume.`);
  halt.code = err.code;
  halt.haltJob = true;
  return halt;
}

/**
 * How much more disk an update or repair is going to need.
 *
 * "An update already has the game on disk" was the reason updates skipped the
 * space check, and it is only true when the build does not grow. One that adds
 * a region of new content, or a depot selected for the first time, used to run
 * out of space mid-download with nothing having warned.
 *
 *   - a file that does not exist yet counts in full
 *   - one that exists but is shorter counts by the difference
 *   - one that is longer than declared counts as nothing (it is trimmed later)
 *   - the staging area, if this update needs one, counts on top
 *
 * Files the orphan sweep will remove are ignored: freeing them is a bonus,
 * never a plan.
 *
 * @param {Map<string, number>} declared  path -> length the manifest declares
 * @param {(path:string)=>number} existingSize  -1 when the file is absent
 */
function estimateGrowth(declared, existingSize, stagingBytes = 0) {
  let growth = 0;
  for (const [p, size] of declared) {
    const have = existingSize(p);
    if (have < 0) growth += size;
    else if (size > have) growth += size - have;
  }
  return growth + Math.max(0, Number(stagingBytes) || 0);
}

/**
 * The next checkpoint interval, given how long the last flush took.
 *
 * A flush that ate more than half the interval is a disk that cannot keep up
 * with the cadence; doubling gives it room. A flush that took under an eighth
 * means the disk has caught up and the interval can come back down. Both are
 * bounded, so a bad patch cannot push resume granularity out indefinitely.
 */
function nextCheckpointInterval(current, lastFlushMs, base = STATE_SAVE_INTERVAL_MS) {
  const max = base * STATE_SAVE_MAX_INTERVAL_MULT;
  if (lastFlushMs > current / 2) return Math.min(max, current * 2);
  if (lastFlushMs < current / 8) return Math.max(base, Math.floor(current / 2));
  return current;
}

/**
 * The adaptive-concurrency decision, separated from the sockets it commands so
 * it can be exercised directly.
 *
 * The rule used to be "add while it helps, then stop forever". That is only
 * half a controller. It could not tell an increase that helped from one that
 * hurt — a saturated uplink or an edge that starts shaping under load both read
 * as "did not improve", and the connections that caused the problem stayed. And
 * once two samples in a row failed to improve it cleared its timer for good, so
 * a link that freed up later — the other download finished, someone stopped
 * streaming — was never taken advantage of.
 *
 * So: climb while it helps, hand the connections back when it does not, and
 * keep watching afterwards at a lazier interval. The floor is the user's
 * setting, and nothing here can go below it.
 *
 * @param {{floor:number, hardCap:number, regressRatio?:number}} opts
 */
function createRampController({ floor, hardCap, regressRatio = ADAPTIVE_REGRESS_RATIO }) {
  let best = 0;
  let flat = 0;
  let settled = false;
  let lastAdd = 0;         // connections added on the previous sample, if any
  let rateBeforeAdd = 0;

  const step = (live, remaining) => Math.max(0, Math.min(4, hardCap - live, remaining - live));

  return {
    get settled() { return settled; },
    get best() { return best; },

    /**
     * @param rate      bytes/second observed since the last sample
     * @param live      connections currently running
     * @param remaining chunks still unclaimed
     * @returns {{add:number, remove:number, resumed:boolean}}
     */
    sample(rate, live, remaining) {
      const noop = { add: 0, remove: 0, resumed: false };
      // Nothing moved. That is a paused, stalled or finished transfer, and it
      // says nothing about whether the last change to concurrency was wise.
      if (!(rate > 0)) return noop;

      // Did the increase we just made actually hurt?
      if (lastAdd > 0 && rate < rateBeforeAdd * regressRatio) {
        const remove = Math.min(lastAdd, Math.max(0, live - floor));
        lastAdd = 0;
        flat = 0;
        settled = true;
        if (rate > best) best = rate;
        return { add: 0, remove, resumed: false };
      }
      lastAdd = 0;

      if (settled) {
        // Throughput climbing while we are *not* adding connections means the
        // link itself has more room than it did. Worth another look.
        if (rate > best * 1.1 && live < hardCap && remaining > live * 2) {
          const add = step(live, remaining);
          if (add > 0) {
            settled = false;
            flat = 0;
            best = rate;
            rateBeforeAdd = rate;
            lastAdd = add;
            return { add, remove: 0, resumed: true };
          }
        }
        if (rate > best) best = rate;
        return noop;
      }

      if (rate > best * 1.05 && live < hardCap && remaining > live * 2) {
        const add = step(live, remaining);
        if (add > 0) {
          best = rate;
          flat = 0;
          rateBeforeAdd = rate;
          lastAdd = add;
          return { add, remove: 0, resumed: false };
        }
      }
      if (rate > best) best = rate;
      if (++flat >= 2) { settled = true; flat = 0; }
      return noop;
    },
  };
}

// ── Main download engine ────────────────────────────────────────

function startNativeDownload(gameData, selectedDepots, destPath, callbacks, target = null) {
  const { onProgress, onPercentage, onSpeed, onComplete, onError, onPlan, onDiskSpeed, onTransferred } = callbacks;

  const appId = String(gameData?.appid || '').trim();
  if (!/^\d{1,20}$/.test(appId)) throw new Error('Invalid AppID.');
  gameData.appid = appId;

  selectedDepots = (Array.isArray(selectedDepots) ? selectedDepots : [])
    .map(d => String(d).trim()).filter(d => /^\d{1,20}$/.test(d));
  if (!selectedDepots.length) throw new Error('No valid depots selected.');

  const settingsStore = require('./settingsStore');
  const maxDl = Math.max(1, Math.min(32, Math.round(Number(settingsStore.get('download_max_downloads')) || DEFAULT_CONCURRENCY)));
  const cellId = String(settingsStore.get('steam_cell_id') || '').trim();
  const slsMode = settingsStore.get('slssteam_mode');
  const wantLancache = settingsStore.get('use_lancache') !== false;
  // Megabytes per second in the setting, bytes per second here. 0 is unlimited.
  const speedLimitBps = Math.max(0, Number(settingsStore.get('download_speed_limit')) || 0) * 1024 * 1024;
  const jobType = String(gameData?.job_type || gameData?.jobType || 'download').toLowerCase();
  // Update/repair reuse existing files: every chunk already correct on disk is
  // skipped instead of re-downloaded. Plain downloads don't validate (an interrupted
  // one resumes from the saved state file), unless the user opts in via the setting.
  const shouldValidate = jobType === 'update' || jobType === 'repair' || Boolean(settingsStore.get('validate_fresh_downloads'));

  // File groups the user chose to leave out in the install plan. The same
  // classifier built that plan, so what was shown is exactly what is skipped.
  const excludeGroups = new Set(
    Array.isArray(gameData?.exclude_groups) ? gameData.exclude_groups.map(String) : []
  );
  const classifyFile = excludeGroups.size
    ? require('./depotInventory').classifyFile
    : null;

  const safeName = (gameData.game_name || '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_');
  const installFolder = gameData.installdir || safeName || `App_${appId}`;
  // An associated Custom installation uses a target resolved by the main
  // process from its saved association, never a path supplied in gameData.
  const downloadDir = target ? target.installPath : path.join(destPath, 'steamapps', 'common', installFolder);
  const acfPath = target ? target.manifestPath : path.join(destPath, 'steamapps', `appmanifest_${appId}.acf`);
  const depotCacheDir = target ? target.cacheDir : path.join(destPath, 'depotcache');
  fs.mkdirSync(downloadDir, { recursive: true });

  const markerDir = path.join(downloadDir, MARKER_DIR);
  fs.mkdirSync(markerDir, { recursive: true });

  // Sampled here, before anything else touches the directory.
  //
  // It used to be read after the manifests were enumerated — but that loop
  // creates the directory tree and materialises every zero-chunk file first, so
  // by the time the question was asked the answer was yes for any depot that
  // contains an empty file. Together with the state file that used to live here
  // too, that is how a fresh install quietly stopped being checked for space.
  const priorInstallExists = directoryHasFiles(downloadDir);

  const manifestDir = gameData.manifest_dir || path.join(os.tmpdir(), 'librarian_manifests');
  const ownsManifestDir = Boolean(gameData.manifest_dir);

  for (const depotId of selectedDepots) {
    const key = gameData.depots?.[depotId]?.key;
    if (!key || !DEPOT_KEY_RE.test(key)) {
      throw new Error(`Missing or invalid decryption key for depot ${depotId}. Re-fetch the manifest or add Steam credentials.`);
    }
  }

  let stopped = false;
  let isPaused = false;
  let stopReason = null;
  let lastEmittedPct = 0;
  // Set once run() has enough context to write a state file. Pausing and
  // cancelling both need to persist progress at the moment they happen, and
  // neither can see inside run() to do it.
  let persistNow = null;

  // One keep-alive pool for the whole job. Without this node-fetch opens a fresh
  // TCP+TLS connection per chunk — tens of thousands of handshakes on a large
  // game, which dominates wall-clock time on anything but a LAN cache.
  const agentOptions = {
    keepAlive: true,
    keepAliveMsecs: 15000,
    // Room for the adaptive ramp, not just the configured floor.
    maxSockets: Math.max(8, Math.min(ADAPTIVE_MAX_WORKERS, maxDl * 4) * 2),
    maxFreeSockets: Math.max(4, maxDl),
    timeout: CHUNK_TIMEOUT + 5000,
    // Most recently used socket first. 'fifo' hands out the one that has been
    // idle longest, which is the one whose congestion window the server has
    // already reset — every request then pays for slow start again.
    scheduling: 'lifo',
  };
  const tlsAgent = new https.Agent(agentOptions);
  // Only a Lancache is ever spoken to in the clear; see LANCACHE_HEADERS.
  const plainAgent = new http.Agent(agentOptions);
  const agent = (url) => (url.protocol === 'http:' ? plainAgent : tlsAgent);

  // Aborting in-flight requests makes cancel feel instant instead of waiting out
  // the per-chunk timeout.
  const abort = new AbortController();

  const files = createFileCache(FD_CACHE_LIMIT);
  const limiter = createRateLimiter(speedLimitBps);

  // Worker pool running the whole per-chunk pipeline. The work is CPU-bound, so
  // its useful width is the core count — not the connection count, which the
  // adaptive ramp may push far higher.
  let chunkPool = null;
  let chunkPoolFailed = false;
  const chunkPoolSize = Math.max(1, Math.min(12, (os.cpus()?.length || 2) - 1 || 1));

  /**
   * Run one chunk through decrypt → unwrap → verify.
   *
   * On a worker thread whenever possible. If the pool cannot start — an
   * unpacked worker file missing from an odd install, a platform that refuses
   * to spawn threads — the same codec runs inline instead. Slower and it will
   * make the UI stutter, but it is the identical pipeline, so it cannot produce
   * a different answer.
   *
   * @param {ArrayBuffer} encrypted  transferred to the worker; not reusable after
   */
  async function decodeChunk(encrypted, group) {
    if (!chunkPool && !chunkPoolFailed) {
      try {
        chunkPool = createChunkPool(chunkPoolSize);
      } catch (err) {
        chunkPoolFailed = true;
        onProgress(`[SteamPipe] Chunk decoder threads unavailable (${err.message}); decoding in-process.`);
      }
    }
    if (chunkPool) {
      try {
        return await chunkPool.run(encrypted, group.depotKey, group.cbOriginal, group.sha);
      } catch (err) {
        // A dead pool is worth one fallback, not a failed download. A chunk
        // that genuinely failed verification carries a code and must not be
        // retried inline — it would only fail again, slower.
        if (err.code || stopped) throw err;
        // One thread lost is a narrower pool, not a dead one: the rest keep
        // decoding off the calling thread. Only when none are left does the
        // work come back here.
        if (chunkPool && chunkPool.width > 0) throw err;
        chunkPoolFailed = true;
        try { chunkPool?.terminate(); } catch {}
        chunkPool = null;
        onProgress(`[SteamPipe] Chunk decoder threads died (${err.message}); decoding in-process.`);
        throw err;   // this chunk retries through the normal path
      }
    }
    return processChunkInline(Buffer.from(encrypted), group.depotKey, group.cbOriginal, group.sha);
  }

  /**
   * SHA-1 bytes read off the disk, on a worker when one is available.
   *
   * Returns the verdict and the buffer to keep using — the input is detached
   * by the transfer and must not be touched afterwards. If the pool dies
   * mid-verify the bytes are gone with it, so the answer is "no": the caller
   * falls back to the network, which is slower and never wrong.
   *
   * @param {Buffer} buf  a buffer that owns its memory (allocUnsafe of a real size)
   * @returns {Promise<{ok:boolean, data:Buffer|null}>}
   */
  async function verifyBytes(buf, sha) {
    if (!chunkPool && !chunkPoolFailed) {
      try {
        chunkPool = createChunkPool(chunkPoolSize);
      } catch (err) {
        chunkPoolFailed = true;
        onProgress(`[SteamPipe] Chunk decoder threads unavailable (${err.message}); hashing in-process.`);
      }
    }
    if (chunkPool) {
      try {
        return await chunkPool.verify(buf, sha);
      } catch (err) {
        if (stopped) throw err;
        if (chunkPool && chunkPool.width > 0) return { ok: false, data: null };
        chunkPoolFailed = true;
        try { chunkPool?.terminate(); } catch {}
        chunkPool = null;
        onProgress(`[SteamPipe] Chunk decoder threads died (${err.message}); hashing in-process.`);
        return { ok: false, data: null };
      }
    }
    return { ok: shaVerify(buf, sha), data: buf };
  }

  function terminateChunkPool() {
    if (chunkPool) { try { chunkPool.terminate(); } catch {} chunkPool = null; }
  }
  // Every worker that hits the pause gate registers its own resolver here, so a
  // single resume/stop wakes ALL of them (a lone shared resolver would strand
  // every waiter but the last one).
  let pauseWaiters = [];

  function releasePauseWaiters() {
    const waiters = pauseWaiters;
    pauseWaiters = [];
    for (const r of waiters) r();
  }

  const speed = new SpeedTracker();       // bytes landing on disk
  const wireSpeed = new SpeedTracker();   // bytes off the network
  let totalBytes = 0;
  let downloadedBytes = 0;   // counts toward overall % (downloaded OR validated-on-disk)
  let wireBytes = 0;         // compressed bytes actually pulled from the CDN
  let validatedTargets = 0;  // targets skipped because they were already correct on disk
  let dedupedTargets = 0;    // extra writes served from an already-fetched chunk
  let fetchedTargets = 0;    // destinations whose bytes came off the network
  let resumedTargets = 0;    // targets a previous run had already finished
                             // (declared out here so the live reuse report can see it)
  let recoveredTargets = 0;  // chunks copied from the previous build on disk
  let recoveredBytes = 0;
  let peakWorkers = 0;       // high-water mark of the adaptive ramp
  let rampBackoffs = 0;      // times the ramp handed connections back
  let rampResumes = 0;       // times it started climbing again afterwards
  let cdnRefreshCount = 0;   // times the mirror list was re-resolved mid-job
  let priorIndex = null;     // sha → [where those bytes live in the old build]
  const priorAtPath = new Map();  // path → (offset → sha) in the old build
  // Depots whose installed build could not be identified. Their chunks take the
  // slow, always-correct route (hash what is on disk) while the rest still patch.
  const unresolvedDepots = new Set();
  // Every path the previous build declared, for depots that did resolve. The
  // orphan sweep needs to know what the old build owned, so it never touches a
  // file that was not part of it.
  const priorDepotPaths = new Set();
  const recoverPlan = new Map();  // sha → [source locations], for chunks we mean to copy
  let recoveryCache = null;       // staged copy of those bytes, read-only during the update
  let unchangedTargets = 0;  // chunks the two manifests agree on: no work at all
  let unchangedBytes = 0;
  let plannedDownloadBytes = 0;   // what will actually cross the network
  let lastSpeedEmit = 0;
  // A transfer that goes quiet has to keep saying so. emitSpd only ran when a
  // chunk finished, so a stall froze the readout on its last healthy number —
  // the one moment the figure matters most is the one it stopped updating.
  let heartbeat = null;

  function emitPct(pct) {
    if (!Number.isFinite(pct)) return; // guard against totalBytes === 0 → NaN
    const safe = Math.max(lastEmittedPct, Math.min(100, Math.round(pct * 10) / 10));
    if (safe <= lastEmittedPct) return;
    lastEmittedPct = safe;
    onPercentage(safe);
  }

  // Two different rates, and conflating them is why an update looked wrong.
  // `speed` counts bytes committed to disk — which includes chunks copied from
  // the previous build and never downloaded at all, so it can read far above
  // the actual line rate. `wireSpeed` counts only what came off the CDN. A
  // user asking "how fast am I downloading" means the second one.
  function emitSpd() {
    const now = Date.now();
    // Both windows, sampled first and unconditionally. The emit throttle is
    // about how often the renderer is told, not how often the rate is measured;
    // folding the two together left the window fed only by whatever happened to
    // land, so a stall recorded nothing and the last healthy figure stood.
    wireSpeed.record(wireBytes);
    speed.record(downloadedBytes);
    if (now - lastSpeedEmit < SPEED_EMIT_INTERVAL) return;
    lastSpeedEmit = now;
    if (onSpeed) onSpeed(formatSpeed(wireSpeed.get()));
    if (onDiskSpeed) onDiskSpeed(formatSpeed(speed.get()));
    // The number, not the formatted rate. "How much of this update have I
    // actually downloaded" cannot be derived from the percentage: that counts
    // chunks copied off the old build, which are most of the work on a large
    // patch and none of the transfer.
    if (onTransferred) onTransferred(wireBytes);
    emitReuse();
  }

  // An update's headline size is the size of the *install*, not of the
  // transfer: a chunk already correct on disk counts toward the percentage
  // without a byte crossing the network. That makes a 31 GB game look like a
  // 31 GB download every time it patches. The split used to be reported only
  // in the final summary, by which point the user has spent the whole
  // download believing the worst — so report it while it is happening.
  let lastReuseEmit = 0;
  function emitReuse() {
    if (!shouldValidate) return;
    const now = Date.now();
    if (now - lastReuseEmit < REUSE_EMIT_INTERVAL) return;
    lastReuseEmit = now;
    const reused = validatedTargets + resumedTargets + dedupedTargets + recoveredTargets;
    if (!reused && !wireBytes) return;
    const copied = recoveredBytes ? `, ${formatBytes(recoveredBytes)} copied from the old build` : '';
    onProgress(`[SteamPipe] Reused ${reused} chunk(s) already on disk${copied} · ${formatBytes(wireBytes)} downloaded so far.`);
  }

  async function waitWhilePaused() {
    while (isPaused && !stopped) {
      await new Promise(r => { pauseWaiters.push(r); });
    }
  }

  /**
   * @param final  the job has ended for good — success, or an error that a
   *               retry cannot fix. Only then is scratch removed: a stop or a
   *               network failure leaves the manifests *and* the staging area,
   *               which is what lets the next attempt resume instead of restart.
   */
  function cleanupTempFiles(final) {
    if (!final) return;
    try { fs.unlinkSync(path.join(markerDir, RECOVERY_CACHE)); } catch {}
    try { fs.unlinkSync(path.join(markerDir, RECOVERY_INDEX)); } catch {}
    if (ownsManifestDir) {
      try { fs.rmSync(manifestDir, { recursive: true, force: true }); } catch {}
    }
  }

  async function run() {
    if (slsMode) {
      try {
        const { findSteamInstall } = require('./steamHelpers');
        const steamPath = findSteamInstall();
        if (steamPath) {
          const configPath = path.join(steamPath, 'config', 'config.vdf');
          if (fs.existsSync(configPath)) {
            injectDepotKeys(configPath, gameData, selectedDepots);
            onProgress('[SteamPipe] Injected depot keys into Steam config.vdf.');
          }
          try {
            const { addGreenLumaFiles } = require('./gameManager');
            addGreenLumaFiles(gameData.appid, selectedDepots);
            onProgress('[SteamPipe] Generated GreenLuma AppList files.');
          } catch (e) {
            onProgress(`[SteamPipe] GreenLuma warning: ${e.message}`);
          }
        }
      } catch (e) {
        onProgress(`[SteamPipe] GreenLuma integration warning: ${e.message}`);
      }
    }

    onProgress('[SteamPipe] Native download engine active.');
    onProgress(`[SteamPipe] Download workers: ${maxDl}`);
    if (limiter.enabled) {
      onProgress(`[SteamPipe] Bandwidth limit: ${formatSpeed(limiter.limit)}.`);
    }

    // An explicit host list short-circuits discovery. It is how the end-to-end
    // tests point the engine at a local origin, and it lets a user pin a mirror
    // that works when the directory service's suggestions do not.
    const overrideHosts = Array.isArray(gameData.cdn_hosts)
      ? gameData.cdn_hosts.map(h => String(h).trim()).filter(Boolean)
      : null;

    const directoryUrl = typeof gameData.cdn_directory_url === 'string' && /^https?:\/\//.test(gameData.cdn_directory_url)
      ? gameData.cdn_directory_url
      : CDN_DIR_URL;
    const cell = /^\d{1,10}$/.test(cellId) ? parseInt(cellId) : 0;

    let cdnHosts;
    if (overrideHosts && overrideHosts.length) {
      cdnHosts = overrideHosts;
      onProgress(`[SteamPipe] Using ${cdnHosts.length} pinned content server(s).`);
    } else {
      onProgress('[SteamPipe] Resolving Steam CDN servers...');
      cdnHosts = await resolveCdn(cell, directoryUrl);
      onProgress(`[SteamPipe] CDN: ${cdnHosts[0]}${cdnHosts.length > 1 ? ` (+${cdnHosts.length - 1} mirrors)` : ''}`);
    }
    const hosts = new HostPool(cdnHosts);

    // A local content cache beats every mirror on that list by an order of
    // magnitude, so ask before spending the download finding out.
    if (wantLancache && !overrideHosts) {
      const lan = await detectLancache();
      if (lan.found) {
        hosts.addPreferred(LANCACHE_HOST, 'http');
        onProgress(`[SteamPipe] Lancache found at ${lan.address} — serving from it in preference to the CDN.`);
      } else if (lan.public) {
        onProgress(`[SteamPipe] ${LANCACHE_HOST} resolves to a public address (${lan.address}); ignoring it.`);
      }
    }

    // Rank the mirrors before the first chunk rather than during the first few
    // hundred. Deferred until it is known that anything will be fetched at all:
    // an update that resolves entirely from the previous build used to spend up
    // to two and a half seconds ranking mirrors it never asked for a byte.
    // Skipped outright when the host list was pinned — nothing to choose between.
    async function rankMirrors() {
      if (overrideHosts || hosts.size < 2 || stopped) return;
      const probe = await probeHosts(cdnHosts, agent, abort.signal);
      if (stopped) return;
      hosts.seedLatency(probe);
      const reachable = probe.filter(p => p.ms !== null);
      if (reachable.length) {
        const best = reachable.reduce((a, b) => (a.ms <= b.ms ? a : b));
        onProgress(`[SteamPipe] Ranked ${reachable.length}/${probe.length} mirrors; fastest ${best.host} at ${best.ms} ms.`);
      }
    }

    // The pool can bench mirrors but could never replace them. Once fewer than
    // half are healthy, ask the directory again and fold in whatever is new.
    // Never for a pinned list: those hosts are the user's choice.
    let lastCdnRefresh = 0;
    let cdnRefreshing = false;
    async function maybeRefreshHosts() {
      if (overrideHosts || cdnRefreshing || stopped) return;
      if (hosts.healthyCount() >= Math.ceil(hosts.size / 2)) return;
      if (Date.now() - lastCdnRefresh < CDN_REFRESH_MIN_MS) return;
      cdnRefreshing = true;
      try {
        const fresh = await resolveCdn(cell, directoryUrl);
        lastCdnRefresh = Date.now();
        if (stopped) return;
        const added = hosts.merge(fresh);
        cdnRefreshCount++;
        onProgress(`[SteamPipe] ${hosts.summary()} — asked the directory again: ${added} new mirror(s).`);
      } catch (err) {
        onProgress(`[SteamPipe] Could not refresh the mirror list: ${err.message}`);
      } finally {
        cdnRefreshing = false;
      }
    }

    // ── Enumerate every chunk target, deduplicating by content hash ──
    //
    // Steam content-addresses chunks, so one sha routinely maps to many
    // (file, offset) destinations — padding blocks, shared audio banks, repeated
    // assets. The old loop downloaded the same bytes once per destination.
    // Grouping by sha fetches once and writes to every target.
    const filePaths = [];                 // interned: targets store an index, not a string
    const fileIndexOf = new Map();
    // absolute path -> the length the manifest declares. Needed at the end: a
    // file the new build shortens keeps the tail of the old one otherwise.
    const declaredSize = new Map();
    // Every path the new build declares — including the ones the install plan
    // excluded, the empty ones and the symlink entries we do not materialise.
    // This is the reference set for deciding what the new build no longer has;
    // a file left out by choice is not a file the build dropped, and deleting
    // it would turn "don't download the language packs" into "delete them".
    const newManifestPaths = new Set();
    // Directory entries the manifest declares, and which directories are
    // ancestors of excluded versus included files. A directory that would only
    // ever have held excluded content is not created: the user asked for the
    // language packs to be left out, not for their empty folders.
    const directoryEntries = [];
    const excludedAncestors = new Set();
    const includedAncestors = new Set();
    const ancestorsOf = (abs) => {
      const out = [];
      let dir = path.dirname(abs);
      while (dir.length > downloadDir.length && dir.startsWith(downloadDir)) {
        out.push(dir);
        dir = path.dirname(dir);
      }
      return out;
    };
    const groups = new Map();             // shaHex -> group
    let targetCount = 0;
    let totalOriginalBytes = 0;
    let excludedBytes = 0;
    let excludedFiles = 0;

    // One mkdir per directory, not per file: this loop runs on the calling
    // thread, and a depot of a hundred thousand loose files otherwise spends
    // seconds re-creating the same few thousand folders.
    const madeDirs = new Set();
    const ensureDir = (dir) => {
      if (madeDirs.has(dir)) return;
      fs.mkdirSync(dir, { recursive: true });
      madeDirs.add(dir);
    };

    const internPath = (abs) => {
      let idx = fileIndexOf.get(abs);
      if (idx === undefined) {
        idx = filePaths.push(abs) - 1;
        fileIndexOf.set(abs, idx);
      }
      return idx;
    };

    for (const depotId of selectedDepots) {
      if (stopped) return;

      const depotKey = gameData.depots[depotId].key;
      const manifestId = (gameData.manifests || {})[depotId];
      if (!manifestId) throw markFatal(new Error(`No manifest ID for depot ${depotId}.`));

      const manifestPath = path.join(manifestDir, `${depotId}_${manifestId}.manifest`);
      if (!fs.existsSync(manifestPath)) throw markFatal(new Error(`Manifest file missing for depot ${depotId}.`));

      onProgress(`[SteamPipe] Parsing manifest: depot ${depotId}...`);
      let manifestFiles;
      try {
        manifestFiles = readManifestFile(manifestPath, depotKey);
      } catch (e) {
        throw markFatal(new Error(`Failed to parse manifest for depot ${depotId}: ${e.message}`));
      }

      let depotTargets = 0;
      for (const file of manifestFiles) {
        if (!file.filename) continue;

        if (file.flags & FLAG_DIRECTORY) {
          // Deferred: whether this directory should exist depends on whether
          // anything in it survives the install plan, which is not known until
          // every file has been looked at.
          directoryEntries.push(safeResolveInside(downloadDir, file.filename));
          continue;
        }

        const absPath = safeResolveInside(downloadDir, file.filename);
        // Record the path first, whatever happens to it below: the orphan sweep
        // asks "does the new build still declare this?", which is a different
        // question from "are we going to write it?".
        newManifestPaths.add(absPath);

        // Honour the install plan before anything is created on disk.
        if (classifyFile && excludeGroups.has(classifyFile(file.filename))) {
          excludedBytes += Number(file.size) || 0;
          excludedFiles++;
          for (const d of ancestorsOf(absPath)) excludedAncestors.add(d);
          continue;
        }
        // Symlink entries (linktarget set) are not materialized: creating a symlink
        // from untrusted manifest data is a foot-gun, and they're macOS/Linux-only.
        if (file.linktarget) continue;

        for (const d of ancestorsOf(absPath)) includedAncestors.add(d);

        // A legitimately empty file has a name but no chunks. Skipping it would
        // silently omit it yet still finalize the install as complete, so create
        // the empty file explicitly.
        if (!file.chunks.length) {
          ensureDir(path.dirname(absPath));
          try { fs.closeSync(fs.openSync(absPath, 'a')); } catch {}
          continue;
        }

        ensureDir(path.dirname(absPath));
        const fileIdx = internPath(absPath);
        declaredSize.set(absPath, Number(file.size) || 0);

        for (const chunk of file.chunks) {
          if (!chunk.sha || chunk.sha.length < 20) continue;
          const shaHex = chunk.sha.toString('hex');
          // Deduplicate per depot: the decryption key is depot-scoped, so the same
          // sha under two depots is genuinely two different fetches.
          const groupKey = `${depotId}:${shaHex}`;
          let group = groups.get(groupKey);
          if (!group) {
            group = {
              depotId,
              depotKey,
              shaHex,
              sha: chunk.sha,
              cbOriginal: chunk.cbOriginal,
              cbCompressed: chunk.cbCompressed || chunk.cbOriginal,
              targets: [],
              home: null,          // a destination known to hold these bytes
              homeSearched: false,
              pending: null,       // the fetch in flight, shared by its other destinations
            };
            groups.set(groupKey, group);
          }
          group.targets.push({ fileIdx, offset: Number(chunk.offset), index: targetCount++, group });
          totalOriginalBytes += chunk.cbOriginal;
          depotTargets++;
        }
      }
      onProgress(`[SteamPipe] Depot ${depotId}: ${manifestFiles.length} files, ${depotTargets} chunks.`);
    }

    if (!targetCount) throw markFatal(new Error('No downloadable chunks found in manifest(s).'));

    // Directories the manifest declares outright. One that only ever held
    // excluded content stays uncreated; one with anything left in it, or one
    // the build declares empty on purpose, is made as before.
    let skippedDirs = 0;
    for (const dir of directoryEntries) {
      if (excludedAncestors.has(dir) && !includedAncestors.has(dir)) { skippedDirs++; continue; }
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    }
    if (skippedDirs) onProgress(`[SteamPipe] Install plan: ${skippedDirs} folder(s) left uncreated — nothing in them was selected.`);

    totalBytes = totalOriginalBytes;

    // Process in file order so the handle cache sees a small working set and each
    // file is written front-to-back rather than scattered.
    const tasks = [...groups.values()].sort((a, b) => {
      const at = a.targets[0], bt = b.targets[0];
      return (at.fileIdx - bt.fileIdx) || (at.offset - bt.offset);
    });

    /*
     * The unit of work is a destination, in file order — not a chunk with all
     * of its destinations.
     *
     * Writing every home of a chunk the moment it arrived meant a duplicate
     * landed deep inside a file the download had not reached yet, and NTFS has
     * to zero everything between the data a file already holds and a write
     * past it. Replaying real manifests through that order: 101 GB of zeroes
     * for a 122 GB install, 45 GB for a 107 GB one — written, then written
     * again with the real content. Measured here at 440 ms of blocked write
     * per gigabyte of gap.
     *
     * In file order every file fills front to back, so there is no gap. A
     * later destination of a chunk already fetched takes it from memory, or
     * reads it back from the home that was written first.
     */
    const work = [];
    for (const group of tasks) for (const t of group.targets) work.push(t);
    work.sort((a, b) => (a.fileIdx - b.fileIdx) || (a.offset - b.offset));

    const uniqueChunks = tasks.length;
    const duplicateTargets = targetCount - uniqueChunks;
    onProgress(`[SteamPipe] Total: ${targetCount} chunks, ~${formatBytes(totalOriginalBytes)}`);
    if (excludedFiles > 0) {
      onProgress(`[SteamPipe] Install plan: skipping ${excludedFiles} file(s), ~${formatBytes(excludedBytes)} not downloaded.`);
    }
    if (duplicateTargets > 0) {
      const dupBytes = totalOriginalBytes - tasks.reduce((sum, g) => sum + g.cbOriginal, 0);
      onProgress(`[SteamPipe] Deduplicated ${duplicateTargets} repeated chunk(s) — ~${formatBytes(dupBytes)} that won't be downloaded twice.`);
    }

    // Validate-and-skip only for update/repair (or the opt-in setting) — not merely
    // because the folder has files. priorInstallExists (sampled before any of
    // this ran) is still used to size the disk-space check below: an in-place
    // overwrite needs no extra room.
    let validateExisting = shouldValidate;

    // Disk-space preflight: only a fresh install (empty dir, not an update/repair)
    // needs room for the whole payload. An update already has the game on disk and
    // only fetches the delta, so requiring full free space would wrongly block it.
    const isFreshInstall = !priorInstallExists && jobType !== 'update' && jobType !== 'repair';
    if (isFreshInstall) {
      const freeBytes = getFreeDiskBytes(downloadDir);
      if (freeBytes !== null) {
        const required = Math.round(totalOriginalBytes * 1.05);
        if (freeBytes < required) {
          throw markFatal(new Error(`Not enough disk space. Need ~${formatBytes(required)}, have ${formatBytes(freeBytes)}.`));
        }
        onProgress(`[SteamPipe] Disk space OK: ${formatBytes(freeBytes)} free.`);
      }
    }

    // Resume state is tagged with the exact manifest set it was written for; a
    // different build's chunks can occupy the same (path, offset) with new content,
    // so an unmatched signature is discarded and on-disk validation reused instead.
    const manifestSig = selectedDepots
      .map(d => `${d}:${(gameData.manifests || {})[d] || ''}`).sort().join('|');

    // Reverse index for upgrading a v1 (string-keyed) resume file in place.
    const legacyKeyFor = (() => {
      let table = null;
      return (index) => {
        if (!table) {
          table = new Array(targetCount);
          for (const group of tasks) {
            for (const t of group.targets) {
              table[t.index] = `${group.depotId}|${filePaths[t.fileIdx]}|${t.offset}`;
            }
          }
        }
        return table[index];
      };
    })();

    // A Custom installation can be edited outside Librarian between attempts.
    // Revalidate checkpointed bytes too; the record alone is not file evidence.
    const bits = (target?.validateAll ? null : loadState(downloadDir, manifestSig, targetCount, legacyKeyFor))
      || Buffer.alloc(Math.ceil(targetCount / 8));

    // What has been persisted, as opposed to what has been written.
    //
    // `bits` is the live truth used to decide what still needs doing. `durable`
    // is the subset whose bytes are known to have reached the disk, and it is
    // the only thing ever written to the state file. A resolved write leaves
    // data in the page cache, so recording a chunk as done the instant its
    // write returned meant the state file could outlive the data it claimed —
    // and the next run would skip a chunk that was never really there.
    const durable = Buffer.from(bits);
    const pendingDurable = [];   // target indices written but not yet flushed
    const state = createStateWriter(downloadDir, manifestSig, targetCount);
    let persistedAtLeastOnce = false;

    // ── Which regions this update is going to overwrite ─────────
    //
    // Filled in while the plan is built, then merged, so "will anything write
    // over these bytes?" is a binary search rather than a scan. Declared up
    // here because planUpdate() runs before the staging helpers appear below.
    const plannedWrites = new Map();   // path -> [[start, end), ...]

    resumedTargets = 0;
    for (const group of tasks) {
      for (const t of group.targets) {
        if (bitGet(bits, t.index)) {
          downloadedBytes += group.cbOriginal;
          resumedTargets++;
        }
      }
    }
    if (resumedTargets > 0) {
      onProgress(`[SteamPipe] Resuming: ${resumedTargets}/${targetCount} chunks already done.`);
      emitPct((downloadedBytes / totalBytes) * 100);
    }

    // ── Local chunk recovery (the thing that makes a patch small) ──
    //
    // Comparing a chunk against the same offset in the old file only finds
    // content that did not move. When a game repacks a large archive the
    // bytes are overwhelmingly the same but every offset shifts, so an
    // offset-for-offset check scores near zero and the whole archive comes
    // down again — measured on a 31.8 GB depot: 130 of 35,196 chunks.
    //
    // Steam avoids this by keeping the previous build's manifest and finding
    // chunks by content hash anywhere in the installed files. We already
    // archive manifests to <library>/depotcache after every successful
    // install, so the previous build's chunk map is on disk and we can do
    // the same: look the hash up, read those bytes locally, and skip the
    // network entirely.
    //
    // Every recovered chunk is SHA-verified before use, exactly like a
    // downloaded one. Chunks are written front-to-back per file, so a source
    // region behind the write frontier may already have been overwritten —
    // that read simply fails its hash and falls back to the network. It can
    // waste a read; it can never corrupt an install.
    let needsNetwork = true;
    if (validateExisting) {
      buildPriorIndex();
      // With a prior manifest the diff has already settled every chunk, so the
      // read-and-hash pass over the whole install is pure waste — that is the
      // 31.8 GB of reads. Without one there is nothing to diff, so keep it.
      let stagingPlan = null;
      // Adopted Custom installs may have modified files despite a valid record.
      // Retain the prior inventory for recovery/pruning, but hash every chunk.
      if (jobType === 'update' && priorIndex && !target?.validateAll) {
        planUpdate();
        validateExisting = false;
        // An interrupted update may already have staged what it needs; if so,
        // that is used as-is rather than read and hashed all over again.
        if (!loadStagedData()) stagingPlan = planStaging();
        needsNetwork = plannedDownloadBytes > 0 || unresolvedDepots.size > 0;
      }
      if (jobType === 'update' || jobType === 'repair') {
        checkGrowth(stagingPlan ? stagingPlan.wanted : 0);
      }
      // Must happen before the first write, or the sources are gone.
      if (stagingPlan) await stageReusableData(stagingPlan);
      onProgress(jobType === 'repair'
        ? '[SteamPipe] Verifying existing files; only mismatched chunks will be re-downloaded...'
        : '[SteamPipe] Applying update...');
    } else {
      onProgress('[SteamPipe] Downloading...');
    }

    if (needsNetwork) await rankMirrors();
    else onProgress('[SteamPipe] Everything this update needs is already on disk — no mirrors to rank.');

    /**
     * Refuse an update or repair that will not fit, before a byte is written.
     * The fresh-install check above only covers an empty directory.
     */
    function checkGrowth(stagingBytes) {
      const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return -1; } };
      const growth = estimateGrowth(declaredSize, sizeOf, stagingBytes);
      const free = getFreeDiskBytes(downloadDir);
      if (free === null) return;
      const required = Math.round(growth * 1.05);
      if (free < required) {
        throw markFatal(new Error(`Not enough disk space for this ${jobType}. Needs ~${formatBytes(required)} more, have ${formatBytes(free)}.`));
      }
      onProgress(`[SteamPipe] Disk space OK for this ${jobType}: needs ~${formatBytes(growth)} more, ${formatBytes(free)} free.`);
    }

    let lastStateSaveAt = Date.now();
    let checkpointInFlight = false;
    let checkpointInterval = STATE_SAVE_INTERVAL_MS;
    let fatal = null;

    /**
     * Commit progress to disk: flush the files first, then record the chunks
     * that were already written when the flush began.
     *
     * The ordering is the whole point. Anything in `batch` had its write
     * resolve before the flush started, so the flush covers it; anything that
     * lands afterwards stays pending and is committed by the next checkpoint.
     */
    async function commitDurable(sync = false) {
      if (!pendingDurable.length) return;
      const batch = pendingDurable.splice(0);
      const flushStarted = Date.now();
      const flushed = sync ? files.flushDirtySync() : await files.flushDirty();
      checkpointInterval = nextCheckpointInterval(checkpointInterval, Date.now() - flushStarted);
      if (!flushed) {
        // Some file could not be forced to disk, and there is no telling which
        // of these chunks it was carrying. None of them is claimed; they stay
        // pending for the next checkpoint, when the flush may succeed.
        for (const i of batch) pendingDurable.push(i);
        return;
      }
      for (const i of batch) bitSet(durable, i);
      if (sync) state.save(durable);
      else state.saveAsync(durable);
      persistedAtLeastOnce = true;
    }

    // Time alone is the wrong trigger. On a fast link three seconds of progress
    // is most of a gigabyte to fetch again after a crash, and the bitmap costs
    // 7.5 KB to write for a 60,000-chunk game — so volume counts too.
    function checkpoint() {
      if (checkpointInFlight) return;
      const due = (Date.now() - lastStateSaveAt > checkpointInterval)
        || (pendingDurable.length >= STATE_SAVE_CHUNKS);
      if (!due) return;
      lastStateSaveAt = Date.now();
      checkpointInFlight = true;
      commitDurable().catch(() => {}).finally(() => { checkpointInFlight = false; });
    }

    // Reachable from stop()/markPaused(), which have no view inside run().
    //
    // The cheap write comes first, deliberately. On quit the app allows this
    // 400 ms; forcing up to ninety file handles to disk can take longer than
    // that on a slow drive, and if it does, the process may end mid-flush. So
    // the progress already known to be durable is committed immediately, and
    // extending it with the pending batch is the part that may not finish.
    persistNow = () => {
      try {
        state.save(durable);
        persistedAtLeastOnce = true;
      } catch { /* a state file we cannot write is a slower resume, not a failure */ }
      // async, so it cannot throw into the try above — it reports by rejecting.
      commitDurable(true).catch(() => {});
    };

    function completeTarget(group, target) {
      bitSet(bits, target.index);
      if (!group.home) group.home = target;
      pendingDurable.push(target.index);
      downloadedBytes += group.cbOriginal;
      speed.record(downloadedBytes);
      emitPct((downloadedBytes / totalBytes) * 100);
      emitSpd();
      checkpoint();
    }

    /**
     * Map every chunk of the previously installed build to where its bytes
     * still sit on disk: sha → { path, offset, len }.
     *
     * The previous manifest is whichever archived manifest for this depot is
     * not the one we are installing now; if several have accumulated, the
     * newest wins.
     */
    /**
     * The manifest each depot is *installed* at, straight from the app manifest.
     *
     * This is the only record of what the bytes on disk actually are. The
     * depotcache is not: Steam prefetches manifests for updates it has not
     * applied, so the newest file there routinely describes a build the user
     * has never had.
     */
    function installedManifestIds() {
      const out = new Map();
      const acf = acfPath;
      let text = '';
      try { text = fs.readFileSync(acf, 'utf-8'); } catch { return out; }
      const block = text.match(/"InstalledDepots"\s*\{([\s\S]*?)\n\t\}/);
      if (!block) return out;
      const re = /"(\d{4,10})"\s*\{[^}]*?"manifest"\s*"(\d+)"/g;
      let m;
      while ((m = re.exec(block[1]))) out.set(m[1], m[2]);
      return out;
    }

    /**
     * Where the installed build's manifest for a depot might be found.
     *
     * The library's own depotcache is where this engine archives them, and it
     * is checked first. But an install adopted from Steam, or one whose cache
     * was cleaned, still has perfectly good copies elsewhere — and the cost of
     * not finding one is a full read-and-hash pass over the entire install, so
     * it is worth looking properly before giving up.
     */
    function priorManifestCandidates(depotId, priorId) {
      const name = `${depotId}_${priorId}.manifest`;
      const places = [
        path.join(depotCacheDir, name),
        path.join(markerDir, name),
        path.join(manifestDir, name),
      ];
      try {
        const { findSteamInstall } = require('./steamHelpers');
        const steamPath = findSteamInstall();
        if (steamPath) places.push(path.join(steamPath, 'depotcache', name));
      } catch { /* no Steam install to borrow from */ }
      return places;
    }

    /**
     * Map every chunk of the *installed* build to where it sits on disk.
     *
     * Diffing against the wrong build is worse than not diffing at all: every
     * chunk the two manifests agree on gets marked done, and the file keeps
     * whatever it actually held. planUpdate's only guard is that the file is
     * long enough, which a stale build passes whenever its file is the larger
     * of the two — silently, with no error and a game that may not start.
     *
     * So a depot is only diffed when it can be pinned to a manifest we can
     * read. It used to be all-or-nothing across the whole job: one uncached
     * language pack cost the base depot its diff too, and a multi-depot game
     * fell back to hashing the entire install. The safety argument is about a
     * depot's own bytes, so the granularity is a depot — chunks are already
     * keyed by it. Anything unresolved is handed back for validation, which is
     * slower and never wrong.
     *
     * Up to a few locations are kept per hash. Keeping only the first meant a
     * chunk whose one recorded home had since been edited — a cracked binary, a
     * rewritten config — went to the network even though identical bytes sat
     * elsewhere in the install.
     */
    function buildPriorIndex() {
      const installed = installedManifestIds();
      const index = new Map();
      const MAX_SOURCES = 3;

      for (const depotId of selectedDepots) {
        const currentId = String((gameData.manifests || {})[depotId] || '');
        const priorId = installed.get(String(depotId)) || '';
        if (!priorId) {
          unresolvedDepots.add(depotId);
          onProgress(`[SteamPipe] Depot ${depotId}: no installed build on record — verifying its files instead of patching.`);
          continue;
        }

        const priorPath = priorManifestCandidates(depotId, priorId).find(p => {
          try { return fs.existsSync(p); } catch { return false; }
        });
        if (!priorPath) {
          unresolvedDepots.add(depotId);
          onProgress(`[SteamPipe] Depot ${depotId}: build ${priorId} is installed but its manifest is not cached — verifying its files instead of patching.`);
          continue;
        }

        let priorFiles;
        try { priorFiles = readManifestFile(priorPath, gameData.depots[depotId].key); }
        catch (err) {
          unresolvedDepots.add(depotId);
          onProgress(`[SteamPipe] Depot ${depotId}: installed manifest unreadable (${err.message}) — verifying its files instead of patching.`);
          continue;
        }
        if (priorId !== currentId) {
          onProgress(`[SteamPipe] Depot ${depotId}: patching from installed build ${priorId}.`);
        }

        for (const file of priorFiles) {
          if (!file.filename || (file.flags & FLAG_DIRECTORY) || file.linktarget) continue;
          let abs;
          try { abs = safeResolveInside(downloadDir, file.filename); } catch { continue; }
          priorDepotPaths.add(abs);
          // Only index files that actually survived — a chunk cannot be read
          // out of something that is no longer there.
          let onDisk;
          try { onDisk = fs.statSync(abs).size; } catch { continue; }
          /*
           * A file whose length no longer matches the old build was replaced
           * after that build landed — the emulator's steam_api64.dll is the
           * usual case. Its bytes are not the old build's, so none of its
           * chunks may be declared unchanged without being read. CONTROL
           * Resonant lost its Goldberg DLL exactly that way: the 8 MB emulator
           * passed the "at least as long" test, nothing was rewritten, and the
           * trim pass cut it to Valve's 317,080 bytes — a PE that Windows
           * refuses with 0xc000007b. It stays a recovery source: those reads
           * are hash-checked.
           */
          const intact = onDisk === Number(file.size);
          let byOffset = priorAtPath.get(abs);
          if (!byOffset) { byOffset = new Map(); priorAtPath.set(abs, byOffset); }
          for (const chunk of file.chunks || []) {
            if (!chunk.sha || chunk.sha.length < 20) continue;
            const hex = chunk.sha.toString('hex');
            // Where this content sat in the old build, so an unchanged chunk
            // can be recognised without reading a byte.
            if (intact) byOffset.set(Number(chunk.offset), hex);
            let sources = index.get(hex);
            if (!sources) { sources = []; index.set(hex, sources); }
            if (sources.length < MAX_SOURCES) {
              sources.push({ path: abs, offset: Number(chunk.offset), len: chunk.cbOriginal });
            }
          }
        }
      }

      if (unresolvedDepots.size && unresolvedDepots.size < selectedDepots.length) {
        onProgress(`[SteamPipe] Patching ${selectedDepots.length - unresolvedDepots.size} of ${selectedDepots.length} depots; the rest are being verified.`);
      }
      if (index.size) priorIndex = index;
    }

    /**
     * Diff the two manifests and settle the whole update before touching a byte.
     *
     * The old path validated by reading and SHA-hashing every chunk on disk —
     * on a 31.8 GB game that is 31.8 GB of reads and 35,000 hashes before the
     * first download even starts, which is most of why an update felt slower
     * than it should. But the two manifests already say exactly what changed:
     * if the old build has the same content, in the same file, at the same
     * offset, there is nothing to verify and nothing to do.
     *
     * So each chunk lands in one of three buckets:
     *   unchanged  — both manifests agree on file+offset+hash: no read, no
     *                hash, no download. Just mark it done.
     *   local      — the hash exists somewhere in the old build: copy it off
     *                the disk (recoverLocally), still no network.
     *   download   — genuinely new content.
     *
     * The size worth showing a user is that third bucket. This is also why
     * Steam has a separate "verify integrity" button: an update trusts its own
     * bookkeeping, and only a repair re-reads everything. `repair` still takes
     * the full validating path — it deliberately does not call this.
     */
    function planUpdate() {
      if (!priorIndex) return;

      // One stat per file, not per chunk: a file that is missing or short
      // cannot be trusted to still hold the old build's bytes.
      const sizeCache = new Map();
      const fileSize = (p) => {
        if (!sizeCache.has(p)) {
          let s = -1;
          try { s = fs.statSync(p).size; } catch {}
          sizeCache.set(p, s);
        }
        return sizeCache.get(p);
      };

      let localTargets = 0, localBytes = 0, downloadGroups = 0, downloadOriginalBytes = 0;

      for (const group of tasks) {
        // A depot whose installed build could not be identified gets no
        // shortcuts: its chunks are hashed against what is on disk instead.
        if (unresolvedDepots.has(group.depotId)) continue;
        let needsFetch = false;
        for (const t of group.targets) {
          if (bitGet(bits, t.index)) continue;             // already done in a prior run
          const p = filePaths[t.fileIdx];
          const sameSpot = priorAtPath.get(p)?.get(t.offset) === group.shaHex;
          if (sameSpot && fileSize(p) >= t.offset + group.cbOriginal) {
            bitSet(bits, t.index);                         // nothing to do for this one
            unchangedTargets++;
            unchangedBytes += group.cbOriginal;
            continue;
          }
          // Every destination this chunk still needs is a place the update is
          // going to write, which is what decides whether its own source has to
          // be rescued before it is overwritten.
          addPlannedWrite(p, t.offset, group.cbOriginal);
          if (priorIndex.has(group.shaHex)) {
            localTargets++; localBytes += group.cbOriginal;
            // One source read serves every destination of this chunk.
            if (!recoverPlan.has(group.shaHex)) recoverPlan.set(group.shaHex, priorIndex.get(group.shaHex));
          } else {
            needsFetch = true;
            // Counted per target and uncompressed, to sit on the same basis as
            // localBytes and unchangedBytes. plannedDownloadBytes below is
            // neither — it is compressed and counted once per chunk, because it
            // answers a different question (what crosses the network).
            downloadOriginalBytes += group.cbOriginal;
          }
        }
        if (needsFetch) { downloadGroups++; plannedDownloadBytes += group.cbCompressed; }
      }
      sealPlannedWrites();

      // Progress should measure the work that is actually left, otherwise an
      // update opens at 95% and crawls, which tells the user nothing.
      totalBytes = Math.max(1, totalOriginalBytes - unchangedBytes);

      onProgress(`[SteamPipe] Update plan — unchanged: ${formatBytes(unchangedBytes)} (${unchangedTargets} chunks, untouched)`);
      if (localTargets) onProgress(`[SteamPipe]   from previous build on disk: ${formatBytes(localBytes)} (${localTargets} chunks)`);
      onProgress(`[SteamPipe]   to download: ${formatBytes(plannedDownloadBytes)} (${downloadGroups} chunks) — of a ${formatBytes(totalOriginalBytes)} install`);

      if (onPlan) {
        onPlan({
          installBytes: totalOriginalBytes,
          unchangedBytes,
          localBytes,
          downloadBytes: plannedDownloadBytes,   // compressed, over the wire
          downloadOriginalBytes,                 // the same chunks, on disk
          /*
           * The denominator the progress percentage is actually measured
           * against, handed over rather than left to be reconstructed.
           *
           * A caller adding downloadBytes to localBytes gets a number that
           * looks right and is not: the first is compressed and counted once
           * per chunk, the second is uncompressed and counted once per
           * destination. Mixing them made the size text and the ETA disagree
           * with the bar above them. This is the one figure that cannot drift.
           */
          remainingBytes: totalBytes,
        });
      }
    }

    function addPlannedWrite(filePath, offset, len) {
      let ranges = plannedWrites.get(filePath);
      if (!ranges) { ranges = []; plannedWrites.set(filePath, ranges); }
      ranges.push([offset, offset + len]);
    }

    function sealPlannedWrites() {
      for (const [p, ranges] of plannedWrites) {
        ranges.sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const r of ranges) {
          const last = merged[merged.length - 1];
          if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
          else merged.push([r[0], r[1]]);
        }
        plannedWrites.set(p, merged);
      }
    }

    /** Does anything this update writes land on top of [offset, offset+len)? */
    function sourceAtRisk(src) {
      const ranges = plannedWrites.get(src.path);
      if (!ranges || !ranges.length) return false;
      const start = src.offset, end = src.offset + src.len;
      let lo = 0, hi = ranges.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const [rs, re] = ranges[mid];
        if (re <= start) lo = mid + 1;
        else if (rs >= end) hi = mid - 1;
        else return true;
      }
      return false;
    }

    /**
     * Lift the reusable chunks that are in danger out of the old build BEFORE
     * anything is overwritten.
     *
     * Copying in place is a race against ourselves: the update writes over the
     * very bytes it wants to reuse, so a source region behind the write
     * frontier is already gone by the time we ask for it. Verification catches
     * that and falls back to the network, which is safe but means paying for
     * data that was sitting on the disk a moment earlier. Staging first is how
     * Steam avoids it, and why Steam wants free space to update.
     *
     * But most reusable data is never in danger. A chunk whose source sits in a
     * file this update does not touch, or in a part of a file nothing writes to,
     * can be read in place at the moment it is needed. Staging it anyway meant
     * every reused byte was read and written twice over — on a patch reusing
     * 20 GB, 40 GB of disk traffic for nothing, and a staging area large enough
     * to trigger the out-of-space fallback that then re-downloads it.
     *
     * So only chunks whose source overlaps a planned write are staged, and the
     * rest are left where they are.
     */
    /** Which reusable chunks are threatened, and how much space rescuing them takes. */
    function planStaging() {
      const atRisk = [];
      let wanted = 0;
      if (!recoverPlan.size) return { atRisk, wanted, safeInPlace: 0 };
      // One entry per chunk: the first source that is actually threatened.
      for (const [shaHex, sources] of recoverPlan) {
        const threatened = sources.find(sourceAtRisk);
        if (!threatened) continue;
        atRisk.push([shaHex, threatened]);
        wanted += threatened.len;
      }
      const safeInPlace = recoverPlan.size - atRisk.length;
      if (safeInPlace > 0) {
        onProgress(`[SteamPipe] ${safeInPlace} reusable chunk(s) are not in the way of this update and will be copied in place.`);
      }
      return { atRisk, wanted, safeInPlace };
    }

    /**
     * Pick up the staging area an interrupted run of this same update left.
     *
     * Staging is the one part of an update that reads the old build before
     * anything is overwritten, so a resume that re-staged from scratch was
     * reading sources the first run may already have written over — hashing
     * them, discarding them, and downloading what had been sitting in the
     * scratch file all along. The scratch file and its index are kept across
     * the interruption; every chunk in it is still verified on use.
     */
    function loadStagedData() {
      const indexPath = path.join(markerDir, RECOVERY_INDEX);
      const cachePath = path.join(markerDir, RECOVERY_CACHE);
      try {
        const json = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        if (json.v !== 1 || json.sig !== manifestSig || !Array.isArray(json.entries)) return false;
        const size = fs.statSync(cachePath).size;
        if (size < (Number(json.size) || 0)) return false;
        const map = new Map();
        for (const [sha, offset, len] of json.entries) {
          if (typeof sha === 'string' && Number.isFinite(offset) && Number.isFinite(len)) map.set(sha, { offset, len });
        }
        if (!map.size) return false;
        recoveryCache = { path: cachePath, map };
        onProgress(`[SteamPipe] Reusing ${map.size} chunk(s) (${formatBytes(json.size)}) staged by the interrupted update.`);
        return true;
      } catch {
        return false;
      }
    }

    function saveStagedIndex(map, size) {
      try {
        fs.writeFileSync(path.join(markerDir, RECOVERY_INDEX), JSON.stringify({
          v: 1, sig: manifestSig, size,
          entries: [...map].map(([sha, { offset, len }]) => [sha, offset, len]),
        }), 'utf-8');
      } catch { /* a resume will simply re-stage */ }
    }

    async function stageReusableData({ atRisk, wanted }) {
      if (!atRisk.length) return;

      const free = getFreeDiskBytes(downloadDir);
      if (free !== null && free < wanted * 1.05) {
        onProgress(`[SteamPipe] Only ${formatBytes(free)} free; cannot stage ${formatBytes(wanted)} of reusable data. Falling back to in-place copying — some of it may be re-downloaded.`);
        return;
      }

      const cachePath = path.join(markerDir, RECOVERY_CACHE);
      let out;
      try { out = await fs.promises.open(cachePath, 'w'); } catch { return; }

      const map = new Map();
      let pos = 0, seen = 0, lastReport = Date.now();
      // Several at once. This used to read, hash and write one chunk at a time
      // while the hashing threads and the disk queue sat idle — the slowest
      // stretch of a large patch, before its first byte of progress.
      let next = 0;
      const stageOne = async ([shaHex, src]) => {
        let handle;
        try { handle = await files.acquire(src.path); } catch { return; }
        try {
          const buf = Buffer.allocUnsafe(src.len);
          // A read that runs past the end of the file comes back short.
          const { bytesRead } = await handle.read(buf, 0, src.len, src.offset);
          if (bytesRead !== src.len) return;
          // A file the user or the cracker has altered will not hash; drop it
          // here rather than discovering it chunk by chunk later.
          const verdict = await verifyBytes(buf, Buffer.from(shaHex, 'hex'));
          if (!verdict.ok) return;
          // Claimed before the write, so concurrent chunks never share a slot.
          const at = pos;
          pos += src.len;
          await out.write(verdict.data, 0, src.len, at);
          map.set(shaHex, { offset: at, len: src.len });
        } catch {
          // Unreadable or unwritable: that chunk is simply not staged.
        } finally {
          files.release(src.path);
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(STAGING_CONCURRENCY, atRisk.length) }, async () => {
          while (!stopped) {
            const item = atRisk[next++];
            if (!item) return;
            await stageOne(item);
            seen += item[1].len;
            if (Date.now() - lastReport > 3000) {
              lastReport = Date.now();
              onProgress(`[SteamPipe] Staging reusable data: ${formatBytes(seen)} / ${formatBytes(wanted)}`);
            }
          }
        }));
      } finally {
        await out.close().catch(() => {});
      }

      if (map.size && !stopped) {
        recoveryCache = { path: cachePath, map };
        saveStagedIndex(map, pos);
        onProgress(`[SteamPipe] Staged ${formatBytes(pos)} that this update would have overwritten — that much will not be downloaded.`);
      } else {
        try { fs.unlinkSync(cachePath); } catch {}
      }
    }

    /**
     * Try to satisfy a chunk from the previous build's bytes on disk.
     * Returns the verified buffer, or null to fall through to the network.
     */
    async function recoverLocally(group) {
      // Staged bytes first: those were read before anything was overwritten,
      // so they are always intact.
      if (recoveryCache) {
        const hit = recoveryCache.map.get(group.shaHex);
        if (hit && hit.len === group.cbOriginal) {
          let h;
          try { h = await files.acquire(recoveryCache.path); } catch { h = null; }
          if (h) {
            try {
              const buf = Buffer.allocUnsafe(hit.len);
              const { bytesRead } = await h.read(buf, 0, hit.len, hit.offset);
              if (bytesRead === hit.len) {
                const verdict = await verifyBytes(buf, group.sha);
                if (verdict.ok) return verdict.data;
              }
            } catch { /* fall through to the live files */ }
            finally { files.release(recoveryCache.path); }
          }
        }
      }

      if (!priorIndex) return null;
      const sources = priorIndex.get(group.shaHex);
      if (!sources) return null;

      // Several recorded homes for the same content, tried in turn. A file the
      // user edited — or that this very update already overwrote — fails its
      // hash here, and another copy elsewhere in the install often still holds
      // exactly these bytes.
      for (const src of sources) {
        if (src.len !== group.cbOriginal) continue;
        let handle;
        try { handle = await files.acquire(src.path); }
        catch { continue; }
        try {
          const buf = Buffer.allocUnsafe(src.len);
          const { bytesRead } = await handle.read(buf, 0, src.len, src.offset);
          if (bytesRead !== src.len) continue;
          // Same verification a downloaded chunk gets, on the same threads.
          const verdict = await verifyBytes(buf, group.sha);
          if (verdict.ok) return verdict.data;
        } catch {
          continue;
        } finally {
          files.release(src.path);
        }
      }
      return null;
    }

    /** Read back a target's region and confirm it already holds the right bytes. */
    async function targetMatchesOnDisk(group, target) {
      const filePath = filePaths[target.fileIdx];
      let handle;
      try {
        handle = await files.acquire(filePath);
      } catch {
        return false;
      }
      try {
        const buf = Buffer.allocUnsafe(group.cbOriginal);
        const { bytesRead } = await handle.read(buf, 0, group.cbOriginal, target.offset);
        if (bytesRead !== group.cbOriginal) return false;
        return (await verifyBytes(buf, group.sha)).ok;
      } catch {
        return false;
      } finally {
        files.release(filePath);
      }
    }

    async function writeTarget(target, data) {
      const filePath = filePaths[target.fileIdx];
      const handle = await files.acquire(filePath, declaredSize.get(filePath) || 0);
      try {
        await handle.write(data, 0, data.length, target.offset);
        // The bytes are in the page cache now, not on the disk. Recording that
        // is what lets the checkpoint know which handles it has to force out
        // before it may claim these chunks as done.
        files.markDirty(filePath);
      } finally {
        files.release(filePath);
      }
    }

    // Decoded chunks still wanted by another destination, newest last.
    const recent = new Map();   // group -> Buffer
    let recentBytes = 0;
    function remember(group, data) {
      if (group.targets.length < 2 || recent.has(group)) return;
      recent.set(group, data);
      recentBytes += data.length;
      for (const [oldest, buf] of recent) {
        if (recentBytes <= RECENT_CHUNK_BYTES) break;
        recent.delete(oldest);
        recentBytes -= buf.length;
      }
    }

    /**
     * Read a chunk back from a destination that already holds it.
     *
     * A home is any destination marked done: written earlier in this run, by
     * the run this one resumes, or left untouched by the update plan. It is
     * hashed like everything else read off the disk — a file edited since is
     * simply not a home any more, and the caller looks elsewhere.
     */
    async function readHome(group) {
      if (!group.home && !group.homeSearched) {
        group.homeSearched = true;
        group.home = group.targets.find(t => bitGet(bits, t.index)) || null;
      }
      const home = group.home;
      if (!home) return null;
      const filePath = filePaths[home.fileIdx];
      let handle;
      try { handle = await files.acquire(filePath); } catch { return null; }
      try {
        const buf = Buffer.allocUnsafe(group.cbOriginal);
        const { bytesRead } = await handle.read(buf, 0, group.cbOriginal, home.offset);
        if (bytesRead === group.cbOriginal) {
          const verdict = await verifyBytes(buf, group.sha);
          if (verdict.ok) return verdict.data;
        }
      } catch {
        // Unreadable is the same answer as altered.
      } finally {
        files.release(filePath);
      }
      if (group.home === home) group.home = null;
      return null;
    }

    /**
     * The bytes of one chunk, from the cheapest place that has them: memory,
     * a destination already written, the previous build, then the network.
     *
     * Destinations of the same chunk that arrive while it is being fetched
     * wait for that one fetch instead of starting their own.
     *
     * @returns {Promise<{data:Buffer, origin:'duplicate'|'recovered'|'fetched'}>}
     */
    async function obtain(group) {
      const held = recent.get(group);
      if (held) return { data: held, origin: 'duplicate' };
      if (group.pending) {
        const { data } = await group.pending;
        return { data, origin: 'duplicate' };
      }
      const pending = produce(group);
      group.pending = pending;
      try {
        const result = await pending;
        remember(group, result.data);
        return result;
      } finally {
        if (group.pending === pending) group.pending = null;
      }
    }

    async function processTarget(target) {
      const group = target.group;
      if (stopped || bitGet(bits, target.index)) return;
      await waitWhilePaused();
      if (stopped) return;

      // Incremental update / verify-repair: if a target's content is already
      // correct on disk, skip it. This is what turns an "update" from a full
      // re-download into pulling only the changed chunks. A depot the plan
      // could not pin to an installed build takes this route too, even during
      // an update that is patching everything else.
      if (validateExisting || unresolvedDepots.has(group.depotId)) {
        if (await targetMatchesOnDisk(group, target)) {
          validatedTargets++;
          completeTarget(group, target);   // counts toward %, not toward network
          return;
        }
        if (stopped) return;
      }

      const { data, origin } = await obtain(group);
      if (stopped) return;
      await writeTarget(target, data);
      if (origin === 'fetched') fetchedTargets++;
      else if (origin === 'recovered') { recoveredTargets++; recoveredBytes += group.cbOriginal; }
      else dedupedTargets++;
      completeTarget(group, target);
    }

    async function produce(group) {
      // A destination that already holds these bytes beats everything else.
      if (group.targets.length > 1) {
        const held = await readHome(group);
        if (held) return { data: held, origin: 'duplicate' };
        if (stopped) throw new Error('cancelled');
      }

      // Before reaching for the network, see whether these exact bytes are
      // already somewhere in the installed build.
      const local = await recoverLocally(group);
      if (local) return { data: local, origin: 'recovered' };
      if (stopped) throw new Error('cancelled');

      const { ab: encrypted, entry: servedBy } = await fetchChunk(hosts, group.depotId, group.shaHex, agent, abort.signal, {
        expectedBytes: group.cbCompressed,
        limiter,
        // Counted as it arrives, so the rate shown — and the one the ramp
        // steers by — moves between chunk boundaries instead of in steps.
        onBytes: (n) => { wireBytes += n; },
      });
      if (stopped) throw new Error('cancelled');

      // Decrypt, unwrap, size-check and hash — all on a worker thread, and all
      // in one hop so the chunk crosses the thread boundary once each way.
      let raw;
      try {
        raw = await decodeChunk(encrypted, group);
      } catch (err) {
        if (err.code === 'ZSTD_UNSUPPORTED') {
          throw markFatal(new Error(`This runtime has no zstd support, required to decode depot ${group.depotId}. Reinstall Librarian — its bundled runtime provides it.`));
        }
        if (err.code === 'LZMA_UNSUPPORTED') {
          throw markFatal(new Error(`Depot ${group.depotId} uses LZMA-compressed chunks but this build has no LZMA decoder. Reinstall Librarian — the decoder ships with it.`));
        }
        if (err.code === 'SIZE_MISMATCH' || err.code === 'CHECKSUM_MISMATCH' || err.code === 'BAD_CHUNK') {
          // Not fatal: a corrupt body from one mirror is exactly what the retry
          // pass exists for. But it is that mirror's failure — the body arrived
          // and was credited as a success the moment it did, so without this
          // an edge returning garbage kept its rank and kept being picked.
          hosts.failed(servedBy, 2);
          throw new Error(`Chunk ${group.shaHex} from depot ${group.depotId} via ${servedBy.host}: ${err.message}`);
        }
        throw err;
      }
      return { data: raw, origin: 'fetched' };
    }

    /**
     * Run `list` through a bounded set of concurrent workers.
     *
     * The previous implementation built one promise per chunk up front — 60k live
     * closures all contending on a semaphore. Pulling from a shared cursor keeps
     * memory flat regardless of game size.
     */
    async function runPass(list) {
      let cursor = 0;
      const failed = [];
      const startCount = Math.min(maxDl, list.length);
      let live = 0;
      let pending = [];

      // Workers asked to stand down at their next chunk boundary. Retiring this
      // way rather than killing anything means no request is ever abandoned
      // mid-flight just because the ramp changed its mind.
      let retireCount = 0;

      const spawn = () => {
        live++;
        hosts.setWorkers(live);
        pending.push((async () => {
          while (!stopped && !fatal) {
            if (retireCount > 0 && live > startCount) { retireCount--; return; }
            const i = cursor++;
            if (i >= list.length) return;
            try {
              await processTarget(list[i]);
            } catch (err) {
              if (stopped) return;
              if (err && err.fatal) { fatal = err; return; }
              // A full or failing disk fails every chunk after this one too.
              // Carrying on meant downloading the rest of the game three times
              // over — once per pass — and discarding each chunk on arrival.
              if (err && DISK_HALT_CODES.has(err.code)) { fatal = diskHalt(err); return; }
              failed.push({ target: list[i], err });
              // A failure is the moment to ask whether the pool has run out of
              // healthy mirrors; the refresh itself runs in the background.
              void maybeRefreshHosts();
            }
          }
        })().finally(() => { live--; hosts.setWorkers(live); }));
      };

      for (let i = 0; i < startCount; i++) spawn();

      // ── Adaptive concurrency ──────────────────────────────────
      // Measured on this machine: the CPU pipeline (decrypt + verify) tops out
      // near 970 MB/s and the disk near 385 MB/s. Neither is what limits a
      // download — the link is, and the right number of parallel connections
      // for a link cannot be guessed from a settings dropdown. A fixed 16 is
      // too few for a fat high-latency pipe and too many for a thin one.
      //
      // So the chosen value becomes a floor and throughput is sampled from
      // there. The decision itself lives in createRampController, which knows
      // nothing about sockets and can therefore be tested.
      const adaptive = settingsStore.get('download_adaptive') !== false;
      const hardCap = adaptive ? Math.min(ADAPTIVE_MAX_WORKERS, maxDl * 4) : startCount;
      let probeTimer = null;

      if (hardCap > startCount) {
        const ramp = createRampController({ floor: startCount, hardCap });
        let lastWire = wireBytes;
        let lastAt = Date.now();

        const schedule = () => {
          probeTimer = setTimeout(onProbe, ramp.settled ? ADAPTIVE_IDLE_PROBE_MS : ADAPTIVE_PROBE_MS);
          if (probeTimer.unref) probeTimer.unref();
        };

        const onProbe = () => {
          probeTimer = null;
          if (stopped || fatal || cursor >= list.length) return;

          const now = Date.now();
          const dt = (now - lastAt) / 1000;
          const rate = dt > 0 ? (wireBytes - lastWire) / dt : 0;
          lastWire = wireBytes;
          lastAt = now;

          // A paused transfer measures nothing; sampling it would read as a
          // collapse and hand back every connection the ramp had earned.
          if (!isPaused) {
            const { add, remove, resumed } = ramp.sample(rate, live, list.length - cursor);
            for (let i = 0; i < add; i++) spawn();
            if (add > 0 && live > peakWorkers) peakWorkers = live;
            if (remove > 0) {
              retireCount += remove;
              rampBackoffs++;
            }
            if (resumed) rampResumes++;
          }
          schedule();
        };

        schedule();
      }

      try {
        // spawn() appends while we are awaiting, so drain until nothing is left.
        while (pending.length) {
          const batch = pending;
          pending = [];
          await Promise.all(batch);
        }
      } finally {
        if (probeTimer) clearTimeout(probeTimer);
      }

      return failed;
    }

    // Whatever ends the job early, the chunks already written are worth keeping:
    // the next attempt resumes from them instead of fetching them again.
    const failJob = async (err) => {
      try { await commitDurable(true); } catch { /* the resume is shorter, not wrong */ }
      throw err;
    };

    let failures = await runPass(work);
    if (fatal) await failJob(fatal);

    // Extra passes cost nothing when the first succeeded, and rescue the common
    // case of chunks lost to a mirror that went sour mid-download — which once
    // failed the entire job. Retrying instantly, though, wastes the attempt when
    // the cause was a network drop that has not finished dropping, so each pass
    // waits a little longer than the last.
    for (let attempt = 1; attempt <= 2 && failures.length && !stopped; attempt++) {
      const wait = Math.max(attempt * 3000, hosts.cooldownRemaining());
      onProgress(`[SteamPipe] Retrying ${failures.length} failed chunk(s) on other mirrors in ${Math.round(wait / 1000)}s...`);
      await sleepAbortable(wait, abort.signal);
      if (stopped) break;
      failures = await runPass(failures.map(f => f.target));
      if (fatal) await failJob(fatal);
    }

    if (stopped) {
      await commitDurable(true);
      if (stopReason) throw stopReason;
      return;
    }

    if (failures.length > 0) {
      await commitDurable(true);
      const first = failures[0].err?.message || 'Unknown error';
      throw new Error(`${failures.length} chunk(s) failed after retries (${hosts.summary()}). First error: ${first}`);
    }

    // All bytes are on disk — flush handles before anything inspects the files.
    await files.flushDirty();
    await files.closeAll();

    if (peakWorkers > maxDl) {
      onProgress(`[SteamPipe] Adaptive concurrency: ramped ${maxDl} → ${peakWorkers} connections`
        + (rampBackoffs ? `, backed off ${rampBackoffs} time(s)` : '')
        + (rampResumes ? `, climbed again ${rampResumes} time(s)` : '') + '.');
    }
    if (cdnRefreshCount) {
      onProgress(`[SteamPipe] Mirror list refreshed ${cdnRefreshCount} time(s) during the download (${hosts.summary()}).`);
    }
    if (validateExisting) {
      onProgress(`[SteamPipe] Reused ${validatedTargets + resumedTargets} unchanged chunk(s) in place`
        + (recoveredTargets ? `, recovered ${recoveredTargets} (~${formatBytes(recoveredBytes)}) from the previous build` : '')
        + `; downloaded ${fetchedTargets} (~${formatBytes(wireBytes)} over the wire).`);
    } else if (wireBytes > 0) {
      const ratio = downloadedBytes > 0 ? (wireBytes / downloadedBytes) : 1;
      onProgress(`[SteamPipe] Transferred ${formatBytes(wireBytes)} for ${formatBytes(totalBytes)} installed (${(ratio * 100).toFixed(0)}% of install size).`);
    }

    // Guard against finalizing a "successful" resume whose payload was deleted off
    // disk while the state file survived — writing an ACF for missing files would
    // register a broken install that only fails at launch.
    //
    // This used to be unreachable: the state file lived in the install directory
    // and counted as one of the files it was looking for, so the answer was
    // always yes. It lives in the marker directory now, which this skips.
    if (!directoryHasFiles(downloadDir)) {
      state.clear();
      throw new Error('No game files are present on disk. The install was not registered — the download folder may have been cleared; please download again.');
    }

    state.clear();

    /*
     * Remove what the new build no longer has.
     *
     * Files are written and shortened in place, so a file the previous build
     * had and this one does not simply stayed — for good, through every future
     * update. That is not just wasted space. Unreal mounts every pakchunk it
     * finds in the directory, so a leftover archive from the old build is
     * loaded alongside the new ones and the game runs on a mixture of two
     * builds' assets; Steam removes these for exactly this reason.
     *
     * Three conditions, all required, because this deletes a user's files:
     *   - the path was declared by the previous build of a depot we positively
     *     identified (never a guess, never someone else's file),
     *   - the new build's manifest does not declare it at all — a file left out
     *     by the install plan is a file the user chose not to download, not one
     *     the build dropped,
     *   - it resolves inside the install directory, and is not our own scratch.
     */
    if (priorDepotPaths.size && !unresolvedDepots.size) {
      let removed = 0;
      let removedBytes = 0;
      for (const absPath of priorDepotPaths) {
        if (newManifestPaths.has(absPath)) continue;
        // Belt and braces: priorDepotPaths was built through safeResolveInside,
        // but a deletion loop is the wrong place to trust a previous check.
        let inside;
        try { inside = safeResolveInside(downloadDir, path.relative(downloadDir, absPath)); }
        catch { continue; }
        if (inside !== absPath) continue;
        if (absPath.startsWith(markerDir + path.sep)) continue;
        try {
          const stat = fs.statSync(absPath);
          if (!stat.isFile()) continue;
          fs.unlinkSync(absPath);
          removed++;
          removedBytes += stat.size;
        } catch { /* already gone, or held open by something else */ }
      }
      if (removed) {
        onProgress(`[SteamPipe] Removed ${removed} file(s) totalling ${formatBytes(removedBytes)} that this build no longer includes.`);
        pruneEmptyDirs(downloadDir);
      }
    }

    /*
     * Cut every file back to the length the manifest declares.
     *
     * Target files are opened 'r+', which keeps whatever was already there —
     * necessary for resume and for patching in place. The cost is that a file
     * the new build makes *shorter* keeps the tail of the old one: the chunks
     * are rewritten correctly and the bytes past the last chunk are never
     * touched. Nothing downstream notices, because verification hashes chunks
     * at known offsets and never looks past them.
     *
     * That is not a cosmetic few bytes. An Unreal .pak stores the offset of its
     * index in a footer at the very end of the file, so 130 stray bytes move
     * the footer and the whole archive stops resolving — which surfaces as a
     * game with no textures and no error message. Mortal Shell II hit exactly
     * this: pakchunk3-Windows.pak left at 81,223 bytes for a build that
     * declares 81,093.
     */
    let trimmed = 0;
    for (const [absPath, declared] of declaredSize) {
      try {
        const actual = fs.statSync(absPath).size;
        if (actual > declared) { fs.truncateSync(absPath, declared); trimmed++; }
      } catch { /* a missing file is the ACF guard's problem, not this loop's */ }
    }
    if (trimmed) onProgress(`[SteamPipe] Trimmed ${trimmed} file(s) that the new build makes shorter.`);

    try {
      // The install's size, not the job's. totalBytes is the progress
      // denominator and an update shrinks it to the work that is actually
      // left, so writing it here made a 31 GB game read as 2 GB in the library
      // after its first patch.
      writeAcf(gameData, selectedDepots, destPath, installFolder, totalOriginalBytes, acfPath);
      onProgress('[SteamPipe] Generated .acf manifest.');
    } catch (e) {
      throw new Error(`Files downloaded but ACF generation failed: ${e.message}`);
    }

    try {
      const depotcache = depotCacheDir;
      fs.mkdirSync(depotcache, { recursive: true });
      for (const depotId of selectedDepots) {
        const mid = (gameData.manifests || {})[depotId];
        if (!mid) continue;
        const fname = `${depotId}_${mid}.manifest`;
        const src = path.join(manifestDir, fname);
        const dst = path.join(depotcache, fname);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dst);
          if (fs.existsSync(dst) && fs.statSync(dst).size > 0) fs.unlinkSync(src);
        }
      }
    } catch (e) {
      onProgress(`[SteamPipe] Warning: manifest migration failed: ${e.message}`);
    }

    cleanupTempFiles(true);

    try {
      // The emulator is placed through a gate (src/core/emuCompat.js): the
      // game's own Steam library says which interface versions this build
      // asks for, the emulator's says which it implements, and an emulator
      // that lacks one is not installed — it would fail SteamAPI_Init and
      // show the player a Steam error. A newer emulator release is fetched
      // first when one exists. A verify goes through the same door, so it
      // re-applies the emulator it just overwrote instead of leaving Valve's
      // library behind without a word.
      const emuCompat = require('./emuCompat');
      const gameRef = { appid: gameData.appid, install_path: downloadDir, source: 'Steam' };
      const jobType = gameData.job_type || 'download';
      const facts = {
        jobType,
        skipAutoCrack: Boolean(gameData.skip_auto_crack),
        autoCrack: Boolean(settingsStore.get('auto_crack')),
        online: emuCompat.isOnline(downloadDir),
        wasCracked: emuCompat.wasCracked(downloadDir),
      };
      let decision = emuCompat.decide(facts);
      if (decision.apply) {
        const { crackGame, checkSacStatus } = require('./autoCrack');
        const status = checkSacStatus();
        if (!status.cliExists || !status.goldbergExists) {
          onProgress('[SteamPipe] Auto-crack skipped: Goldberg not available.');
        } else {
          onProgress('[SteamPipe] Checking the emulator against this build…');
          const gate = await emuCompat.ensureCompatible(downloadDir, { onLog: (msg) => onProgress(`[EMU] ${msg}`) });
          decision = emuCompat.decide({ ...facts, gate });
          if (decision.apply) {
            onProgress(`[SteamPipe] Running auto-crack (${decision.reason})...`);
            const result = await crackGame({
              gamePath: downloadDir,
              appId: String(gameData.appid),
              onLog: (msg) => onProgress(`[CRACK] ${msg}`),
            });
            onProgress(result.success
              ? '[SteamPipe] Auto-crack complete.'
              : `[SteamPipe] Auto-crack FAILED — ${result.error || `exit code ${result.exitCode}`}`);
            if (result.success) emuCompat.clearBlock(gameRef);
          } else {
            onProgress(`[SteamPipe] Emulator not applied: ${decision.reason}.`);
            if (gate.reason === 'incompatible') emuCompat.recordBlock(gameRef, { missing: gate.missing, source: jobType, emulatorDate: gate.check.emulatorDate });
          }
        }
      } else if (facts.autoCrack) {
        onProgress(`[SteamPipe] Emulator step skipped: ${decision.reason}.`);
      }
    } catch (e) {
      onProgress(`[SteamPipe] Auto-crack error: ${e.message}`);
    }

    // Games listed in gamePresets.json come set up for co-op. After the
    // emulator step on purpose: online mode puts Valve's library back and
    // files the emulator away beside it, so it must see the emulator first.
    try {
      if (settingsStore.get('game_presets') !== false) {
        const r = require('./gamePresets').apply(
          { appid: gameData.appid, game_name: gameData.game_name, install_path: downloadDir },
          { playerName: settingsStore.get('online_player_name'), onLog: (msg) => onProgress(`[PRESET] ${msg}`) });
        if (r.error) onProgress(`[SteamPipe] Co-op preset incomplete — ${r.error}. It will be retried at launch.`);
      }
    } catch (e) {
      onProgress(`[SteamPipe] Co-op preset error: ${e.message}`);
    }

    emitPct(100);
    onComplete();
  }

  heartbeat = setInterval(() => { if (!isPaused) emitSpd(); }, 400);
  if (heartbeat.unref) heartbeat.unref();   // never hold the process open

  const done = run()
    .catch(err => {
      // Only a permanent failure justifies throwing the manifests away. A
      // network error is the case where the user will press retry immediately,
      // and re-fetching several megabytes of manifest to start a resume that
      // already knows what it is doing is pure delay.
      cleanupTempFiles(Boolean(err && err.fatal));
      if (!stopped) onError(err.message);
    })
    .finally(async () => {
      // Never leak worker threads, sockets, file handles or timers.
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      terminateChunkPool();
      try { await files.closeAll(); } catch {}
      try { tlsAgent.destroy(); } catch {}
      try { plainAgent.destroy(); } catch {}
    });

  return {
    done,
    get process() { return null; },
    get stopped() { return stopped; },
    markPaused() {
      isPaused = true;
      // Progress belongs on disk at the moment the user asks for the download
      // to stand still — not up to three seconds later, and not conditional on
      // the app surviving that long.
      persistNow?.();
      // Both windows, not just the disk one: samples that span a pause make the
      // first seconds after resuming read as a crawl that never happened.
      speed.reset();
      wireSpeed.reset();
      if (onSpeed) onSpeed('0 B/s');
      if (onDiskSpeed) onDiskSpeed('0 B/s');
    },
    markResumed() {
      isPaused = false;
      speed.reset();
      wireSpeed.reset();
      releasePauseWaiters();
    },
    stop(reason = null) {
      if (reason) stopReason = reason instanceof Error ? reason : new Error(String(reason));
      stopped = true;
      isPaused = false;
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      releasePauseWaiters();
      // Persist here, synchronously, rather than leaving it to run() as it
      // unwinds. On quit the app gives that unwind 400 ms and then exits; a
      // slow disk or a chunk still being written could take longer, and the
      // progress since the last checkpoint would be gone.
      persistNow?.();
      try { abort.abort(); } catch {}   // tear down in-flight requests at once
      terminateChunkPool();             // kill decoders promptly on cancel/quit
    },
  };
}

// ── GreenLuma depot key injection (self-contained) ──────────────

function injectDepotKeys(configPath, gameData, selectedDepots) {
  let content = fs.readFileSync(configPath, 'utf-8');
  const depotsMatch = content.match(/"Software"\s*\{\s*"Valve"\s*\{\s*"Steam"\s*\{[\s\S]*?"depots"\s*\{/i);
  if (!depotsMatch) return;

  const insertIdx = depotsMatch.index + depotsMatch[0].length;
  let block = '\n';
  for (const depotId of selectedDepots) {
    const key = gameData.depots[depotId]?.key;
    if (!key) continue;
    const re = new RegExp(`"${depotId}"\\s*\\{[^}]*"DecryptionKey"[^}]*\\}`, 'i');
    if (!re.test(content)) {
      block += `\t\t\t\t"${depotId}"\n\t\t\t\t{\n\t\t\t\t\t"DecryptionKey"\t\t"${key}"\n\t\t\t\t}\n`;
    }
  }

  if (block.trim() === '') return;

  const newContent = content.slice(0, insertIdx) + block + content.slice(insertIdx);
  const openD = (newContent.match(/\{/g) || []).length - (content.match(/\{/g) || []).length;
  const closeD = (newContent.match(/\}/g) || []).length - (content.match(/\}/g) || []).length;
  if (openD < 0 || openD !== closeD) return;

  const backupPath = `${configPath}.librarian.bak`;
  try { if (!fs.existsSync(backupPath)) fs.copyFileSync(configPath, backupPath); } catch {}

  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, newContent, 'utf-8');
  fs.renameSync(tmp, configPath);
}

module.exports = {
  startNativeDownload,
  checkNativeEngineSupport,
  readManifestFile,
  // Exported for dev/verify-steampipe-engine.mjs, which exercises the pieces
  // that have no observable effect from outside a live download.
  createRampController,
  HostPool,
  SpeedTracker,
  isPrivateAddress,
  parseRetryAfter,
  createRateLimiter,
  estimateGrowth,
  nextCheckpointInterval,
  chunkUrl,
  fetchChunk,
};
