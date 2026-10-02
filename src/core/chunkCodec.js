// Valve depot chunk pipeline: decrypt → unwrap the container → verify.
//
// Shared on purpose. steamPipe runs this on worker threads (chunkWorker.js) so
// that AES and SHA-1 stay off the thread driving the UI, and inline on the
// calling thread when the pool cannot start. Two copies of this logic would be
// two chances for the paths to disagree about what a valid chunk is, and that
// disagreement would surface as a corrupt install rather than an error.
//
// Everything here is pure: bytes in, bytes out, no filesystem and no state
// beyond the lazily-loaded decoders.
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');

const ZSTD_AVAILABLE = typeof zlib.zstdDecompressSync === 'function';
// VSZ (Valve zstd) footer: crc32(4) + uncompressed size(8) + "zsv"(3) = 15 bytes.
const VSZ_FOOTER_LEN = 15;

// Async codecs run on the libuv thread pool. That mattered enormously when this
// ran on the Electron main thread; inside a worker it is merely harmless, and
// keeping one implementation for both callers is worth more than the last
// microsecond.
const zstdDecompressAsync = typeof zlib.zstdDecompress === 'function'
  ? promisify(zlib.zstdDecompress) : null;
const inflateAsync = promisify(zlib.inflate);
const inflateRawAsync = promisify(zlib.inflateRaw);

/** An error the caller can branch on without matching message text. */
function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ── LZMA ("VZ") ─────────────────────────────────────────────────

let lzmaDecode = null;   // (aloneBuffer) => Buffer | Promise<Buffer>
let lzmaLoaded = false;

function loadLzma() {
  if (lzmaLoaded) return lzmaDecode;
  lzmaLoaded = true;
  // Prefer @napi-rs/lzma (native liblzma, ~70 MB/s/core) and fall back to the
  // pure-JS `lzma` package, which is roughly ten times slower but universal.
  try {
    const napi = require('@napi-rs/lzma');
    lzmaDecode = (alone) => Buffer.from(napi.lzma.decompressSync(alone));
    return lzmaDecode;
  } catch { /* fall through */ }
  try {
    const lzma = require('lzma');
    lzmaDecode = (alone) => new Promise((resolve, reject) => {
      lzma.decompress(alone, (result, err) => (err ? reject(err) : resolve(Buffer.from(result))));
    });
  } catch {
    lzmaDecode = null;
  }
  return lzmaDecode;
}

/** Can this build decode VZ chunks at all? Resolution only — nothing is loaded. */
function lzmaAvailable() {
  const canLoad = (mod) => { try { require.resolve(mod); return true; } catch { return false; } };
  return canLoad('@napi-rs/lzma') || canLoad('lzma');
}

// A decrypted chunk is LZMA-framed when it starts with "VZ" (0x56 0x5A). VSZ
// ("VSZ", 0x56 0x53 0x5A) is zstd — its second byte is 0x53, not 0x5A — so the
// two never collide.
function isVZ(data) {
  return data.length >= 2 && data[0] === 0x56 && data[1] === 0x5A;
}

/**
 * VZ layout: [0:2]="VZ" [2]=ver [3:7]=crc [7:12]=LZMA props(5)
 *            [12:len-10]=LZMA data [len-10:len-2]=crc+size [len-2:]="zv"
 *
 * The container carries the property bytes but no inline size, so a standard
 * LZMA-Alone stream is rebuilt from the caller-supplied decompressed size.
 */
async function decodeVZ(container, expectedSize) {
  const decode = loadLzma();
  if (!decode) throw codedError('LZMA_UNSUPPORTED', 'no LZMA decoder available');
  if (container.length < 22) throw codedError('BAD_CHUNK', 'VZ container too small');

  const props = container.subarray(7, 12);
  const data = container.subarray(12, container.length - 10);
  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeUInt32LE(expectedSize >>> 0, 0);
  sizeBuf.writeUInt32LE(Math.floor(expectedSize / 0x100000000), 4);
  return decode(Buffer.concat([props, sizeBuf, data]));
}

// ── Crypto ──────────────────────────────────────────────────────

// Chunks arrive in file order and a depot has one key, so the same hex string
// is re-parsed tens of thousands of times otherwise.
const keyCache = new Map();
function keyFor(keyHex) {
  let key = keyCache.get(keyHex);
  if (!key) {
    key = Buffer.from(keyHex, 'hex');
    if (key.length !== 32) throw codedError('BAD_KEY', 'depot key is not 32 bytes');
    if (keyCache.size > 32) keyCache.clear();
    keyCache.set(keyHex, key);
  }
  return key;
}

/**
 * Steam chunk encryption: the first 16 bytes are the CBC IV, itself encrypted
 * with AES-256-ECB under the depot key; the remainder is AES-256-CBC.
 */
function decryptChunk(enc, keyHex) {
  const key = keyFor(keyHex);
  if (enc.length < 32 || (enc.length % 16) !== 0) {
    // IV block plus at least one ciphertext block, and CBC output is always a
    // whole number of blocks. Anything else is a truncated or corrupted body,
    // and saying so here is cheaper than discovering it after decompression.
    throw codedError('BAD_CHUNK', `encrypted chunk has an impossible length (${enc.length})`);
  }
  const ecb = crypto.createDecipheriv('aes-256-ecb', key, null);
  ecb.setAutoPadding(false);
  const iv = Buffer.concat([ecb.update(enc.subarray(0, 16)), ecb.final()]);

  const cbc = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([cbc.update(enc.subarray(16)), cbc.final()]);
}

// ── Container unwrapping ────────────────────────────────────────

/**
 * A decrypted Steam chunk is a Valve-framed compression container, verified
 * against live CDN data (Hollow Knight: Silksong depots):
 *   VSZ ("VSZ"+ver, 8-byte header, a zstd frame, 15-byte "zsv" footer)  — zstd
 *   VZ  ("VZ"+ver,  LZMA properties, LZMA stream, "zv" footer)          — LZMA
 *   ZIP ("PK\x03\x04")                                                  — deflate
 * A modern depot mixes VSZ and VZ chunks within a single file.
 */
async function decompressChunk(data, expectedSize) {
  if (data.length < 4) return data;

  // VSZ — Valve zstd. Node's zstd decoder treats the trailing 15-byte footer as
  // a second (invalid) frame, so decode only the frame slice [8 .. len-15].
  if (data[0] === 0x56 && data[1] === 0x53 && data[2] === 0x5A) {
    if (!ZSTD_AVAILABLE) throw codedError('ZSTD_UNSUPPORTED', 'no zstd decoder in this runtime');
    const decode = zstdDecompressAsync
      ? (buf) => zstdDecompressAsync(buf)
      : async (buf) => zlib.zstdDecompressSync(buf);
    if (data.length > 8 + VSZ_FOOTER_LEN) {
      try { return await decode(data.subarray(8, data.length - VSZ_FOOTER_LEN)); } catch {}
    }
    return decode(data.subarray(8));
  }

  if (isVZ(data)) return decodeVZ(data, expectedSize);

  // ZIP local file header.
  if (data[0] === 0x50 && data[1] === 0x4B && data[2] === 0x03 && data[3] === 0x04) {
    const method = data.readUInt16LE(8);
    const uncompressedSize = data.readUInt32LE(22);
    const nameLen = data.readUInt16LE(26);
    const extraLen = data.readUInt16LE(28);
    const start = 30 + nameLen + extraLen;
    const body = data.subarray(start);
    if (method === 0) return body.subarray(0, uncompressedSize); // stored
    // method 8 = deflate. inflateRaw stops at the stream end, ignoring the
    // trailing central directory, so the compressed length is not needed.
    return inflateRawAsync(body);
  }

  // Legacy fallback: a bare zlib or raw-deflate stream.
  try { return await inflateAsync(data); } catch {}
  try { return await inflateRawAsync(data); } catch {}
  return data;
}

function shaVerify(data, expected) {
  return crypto.createHash('sha1').update(data).digest().equals(expected);
}

/**
 * The whole pipeline for one chunk, and the only entry point either caller
 * should use.
 *
 * The manifest's chunk sha is the SHA-1 of the *decompressed* data — it is the
 * content-addressed CDN id — so verification happens last. A size or hash
 * mismatch means a bad depot key or a corrupt download, never a bug in framing.
 *
 * @param {Buffer} encrypted  raw CDN body
 * @param {string} keyHex     depot key, 64 hex characters
 * @param {number} expectedSize  cbOriginal from the manifest
 * @param {Buffer} expectedSha   20-byte chunk sha from the manifest
 * @returns {Promise<Buffer>} the verified plaintext chunk
 */
async function processChunk(encrypted, keyHex, expectedSize, expectedSha) {
  const decrypted = decryptChunk(encrypted, keyHex);
  const raw = await decompressChunk(decrypted, expectedSize);
  if (raw.length !== expectedSize) {
    throw codedError('SIZE_MISMATCH', `expected ${expectedSize} bytes, got ${raw.length}`);
  }
  if (!shaVerify(raw, expectedSha)) {
    throw codedError('CHECKSUM_MISMATCH', 'chunk failed its SHA-1 (bad depot key or corrupt download)');
  }
  return raw;
}

/**
 * Report whether this build can run the native engine, so the caller can refuse
 * a download up front rather than failing partway through. Only zstd is
 * treated as required: every modern depot uses it, whereas LZMA appears in
 * older ones and its absence is a warning, not a blocker.
 */
function checkCodecSupport() {
  const zstd = ZSTD_AVAILABLE;
  const lzma = lzmaAvailable();
  const missing = [];
  if (!zstd) missing.push('zstd decompression (requires a newer Electron runtime)');
  if (!lzma) missing.push('LZMA decoder (@napi-rs/lzma or lzma)');
  return { ok: zstd, zstd, lzma, missing };
}

module.exports = {
  processChunk,
  decryptChunk,
  decompressChunk,
  shaVerify,
  isVZ,
  lzmaAvailable,
  checkCodecSupport,
  ZSTD_AVAILABLE,
};
