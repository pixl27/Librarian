// Read-only benchmark: how fast does this link pull real depot chunks under
// different mirror/connection strategies? Nothing is decrypted or written —
// chunk bodies are counted and dropped.
//
//   node dev/bench-cdn-strategy.cjs <manifest> [workers=16] [warmupSec=5] [measureSec=15]
//
// "current" drives the engine's own HostPool exactly as fetchChunk does.
// "sticky"  binds each worker to one of the best few hosts on a LIFO agent.
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const https = require('https');
const fetch = require('node-fetch');
const { HostPool } = require('../src/core/steamPipe');
const format = require('../deps/steammanifest/re/manifest_format.js');

const manifestPath = process.argv[2];
const WORKERS = Number(process.argv[3]) || 16;
const WARMUP = (Number(process.argv[4]) || 5) * 1000;
const MEASURE = (Number(process.argv[5]) || 15) * 1000;
const depotId = path.basename(manifestPath).split('_')[0];

function loadChunks() {
  const manifest = format.parseManifest(fs.readFileSync(manifestPath));
  const seen = new Set();
  const out = [];
  for (const file of manifest.files) {
    for (const c of file.chunks || []) {
      if (!c.sha || seen.has(c.sha)) continue;
      seen.add(c.sha);
      if (c.cb_compressed > 400 * 1024) out.push({ sha: c.sha, size: c.cb_compressed });
    }
  }
  return out;
}

async function directory() {
  const res = await fetch('https://api.steampowered.com/IContentServerDirectoryService/GetServersForSteamPipe/v1/?cell_id=0&max_servers=40', { timeout: 10000 });
  const json = await res.json();
  return json.response.servers.filter(s => s.https_support === 'mandatory' || s.https_support === 'optional');
}

/** TLS handshake time and whether the edge offers HTTP/2. */
function tlsProbe(host) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = tls.connect({ host, port: 443, servername: host, ALPNProtocols: ['h2', 'http/1.1'], timeout: 4000 }, () => {
      const out = { host, ms: Date.now() - started, alpn: socket.alpnProtocol || 'none' };
      socket.destroy();
      resolve(out);
    });
    socket.on('error', () => resolve({ host, ms: null, alpn: null }));
    socket.on('timeout', () => { socket.destroy(); resolve({ host, ms: null, alpn: null }); });
  });
}

/** The engine's own probe: one HEAD per host through the job's agent. */
async function headProbe(hosts, agent) {
  return Promise.all(hosts.map(async (host) => {
    const started = Date.now();
    try {
      await fetch(`https://${host}/`, { method: 'HEAD', timeout: 2500, agent, compress: false });
      return { host, ms: Date.now() - started };
    } catch { return { host, ms: null }; }
  }));
}

async function run(label, chunks, pickFor, agent) {
  let cursor = 0;
  let bytes = 0, measured = 0, done = 0, errors = 0;
  const ttfb = [];
  const perHost = new Map();
  const start = Date.now();
  const measureFrom = start + WARMUP;
  const end = measureFrom + MEASURE;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WARMUP + MEASURE);

  await Promise.all(Array.from({ length: WORKERS }, async (_, w) => {
    while (Date.now() < end) {
      const chunk = chunks[cursor++];
      if (!chunk) return;
      const pick = pickFor(w);
      const t0 = Date.now();
      try {
        const res = await fetch(`https://${pick.host}/depot/${depotId}/chunk/${chunk.sha}`, { agent, signal: ac.signal, compress: false, timeout: 30000 });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const t1 = Date.now();
        // Count bytes as they arrive so a body cut off by the deadline still
        // contributes what actually crossed the wire.
        await new Promise((resolve, reject) => {
          res.body.on('data', (d) => {
            bytes += d.length;
            if (Date.now() >= measureFrom) measured += d.length;
          });
          res.body.on('end', resolve);
          res.body.on('error', reject);
        });
        const ms = Date.now() - t0;
        if (t0 >= measureFrom) ttfb.push(t1 - t0);
        done++;
        perHost.set(pick.host, (perHost.get(pick.host) || 0) + 1);
        pick.onOk?.(chunk.size, ms);
      } catch (err) {
        if (ac.signal.aborted) return;
        errors++;
        pick.onFail?.();
      }
    }
  }));
  clearTimeout(timer);
  agent.destroy();

  ttfb.sort((a, b) => a - b);
  const median = ttfb.length ? ttfb[ttfb.length >> 1] : 0;
  const rate = measured / (MEASURE / 1000);
  console.log(`${label.padEnd(26)} ${(rate / 1048576).toFixed(2).padStart(7)} MB/s  chunks=${String(done).padStart(4)}  errors=${errors}  median TTFB=${median} ms  hosts used=${perHost.size}`);
  return { rate, used: cursor };
}

(async () => {
  const all = loadChunks();
  console.log(`manifest ${path.basename(manifestPath)}: ${all.length} distinct chunks > 400 KB, depot ${depotId}`);

  const servers = await directory();
  const hosts = [...new Set(servers.map(s => s.vhost || s.host))];
  const tlsResults = await Promise.all(hosts.map(tlsProbe));
  const byType = new Map(servers.map(s => [s.vhost || s.host, s]));
  console.log('\nhost, type, weighted_load, TLS handshake ms, ALPN');
  for (const r of [...tlsResults].sort((a, b) => (a.ms ?? 1e9) - (b.ms ?? 1e9))) {
    const s = byType.get(r.host);
    console.log(`  ${r.host.padEnd(44)} ${s.type.padEnd(10)} w=${String(s.weighted_load).padEnd(7)} ${String(r.ms).padStart(5)} ms  ${r.alpn}`);
  }

  const mkAgent = (scheduling) => new https.Agent({
    keepAlive: true, keepAliveMsecs: 15000, maxSockets: 96, maxFreeSockets: WORKERS, scheduling,
  });

  let offset = 0;
  const slice = () => { const s = all.slice(offset); return s; };

  const current = async (round) => {
    const agent = mkAgent('fifo');
    const pool = new HostPool(hosts);
    pool.seedLatency(await headProbe(hosts, agent));
    const r = await run(`current #${round}`, slice(), () => {
      const entry = pool.pick();
      return {
        host: entry.host,
        onOk: (size, ms) => pool.succeeded(entry, size, ms),
        onFail: () => pool.failed(entry),
      };
    }, agent);
    offset += r.used;
    return r.rate;
  };

  const sticky = async (round, k, order) => {
    const agent = mkAgent('lifo');
    const best = order.slice(0, k);
    const r = await run(`sticky top-${k} #${round}`, slice(), (w) => ({ host: best[w % best.length] }), agent);
    offset += r.used;
    return r.rate;
  };

  const byLatency = tlsResults.filter(r => r.ms !== null).sort((a, b) => a.ms - b.ms).map(r => r.host);
  console.log(`\n${WORKERS} workers, ${WARMUP / 1000}s warm-up then ${MEASURE / 1000}s measured, per run`);
  // Rotation over the same few hosts, most-recently-used socket first: what a
  // narrower HostPool gives without binding a worker to a mirror.
  const rotate = async (round, k, order) => {
    const agent = mkAgent('lifo');
    const best = order.slice(0, k);
    let n = 0;
    const r = await run(`rotate top-${k} #${round}`, slice(), () => ({ host: best[n++ % best.length] }), agent);
    offset += r.used;
    return r.rate;
  };

  const a = [], b = [], c = [];
  for (let round = 1; round <= 2; round++) {
    a.push(await current(round));
    b.push(await sticky(round, 3, byLatency));
    c.push(await rotate(round, 3, byLatency));
  }
  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const mb = (x) => (x / 1048576).toFixed(2);
  console.log(`\ncurrent avg ${mb(avg(a))} MB/s, sticky avg ${mb(avg(b))} MB/s (${(avg(b) / avg(a)).toFixed(2)}x), rotate avg ${mb(avg(c))} MB/s (${(avg(c) / avg(a)).toFixed(2)}x)`);
})().catch((err) => { console.error(err); process.exit(1); });
