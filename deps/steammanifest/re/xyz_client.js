'use strict';

/**
 * Robust client for fetching Steam manifests from 20770407.xyz and compatible mirrors/portals.
 * Features exponential backoff retries, authentication token support, response validation,
 * and error categorization.
 */

const { httpGet } = require('./http');
const ContentManifest = require('./manifest_format');
const { uint32, uint64 } = require('./ids');

const DEFAULT_ENDPOINT = 'https://20770407.xyz';
const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 15000;

class XyzError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'XyzError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

class XyzClient {
  constructor(options = {}) {
    this.endpoint = (options.endpoint || process.env.XYZ_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
    this.token = options.token || process.env.XYZ_TOKEN || process.env.STEAM_INBOX_CREDENTIAL || null;
    this.maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : DEFAULT_RETRIES;
    this.timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.headers = options.headers || {};
  }

  buildHeaders() {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SteamManifest/1.0',
      'Accept': 'application/octet-stream, application/json, text/plain, */*',
      'Referer': `${this.endpoint}/`,
      ...this.headers,
    };

    if (this.token) {
      headers['x-inbox-credential'] = this.token;
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    return headers;
  }

  buildUrl(depotId, manifestId, query = {}) {
    const cleanDepot = uint32(depotId, 'depot ID');
    const cleanManifest = uint64(manifestId, 'manifest ID');
    const url = new URL(`${this.endpoint}/manifest/${cleanDepot}/${cleanManifest}`);
    if (query.appid) {
      url.searchParams.set('appid', String(query.appid));
    }
    if (query.branch && query.branch !== 'public') {
      url.searchParams.set('branch', String(query.branch));
    }
    return url.toString();
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  isRetriableStatus(status) {
    // 429 Too Many Requests, 500, 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout
    return status === 429 || status >= 500;
  }

  async fetchRaw(url, options = {}) {
    const headers = { ...this.buildHeaders(), ...(options.headers || {}) };
    const timeoutMs = options.timeoutMs || this.timeoutMs;
    const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : this.maxRetries;

    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await httpGet(url, { headers, timeoutMs });
        if (res.status === 200) {
          return res;
        }

        if (res.status === 401) {
          throw new XyzError(401, 'XYZ_UNAUTHORIZED',
            `XYZ server required authentication (HTTP 401 Unauthorized). Set XYZ_TOKEN or pass --token.`,
            { url, body: res.body.toString('utf8').slice(0, 300) }
          );
        }

        if (res.status === 403) {
          throw new XyzError(403, 'XYZ_ACCESS_DENIED',
            `XYZ server denied access (HTTP 403 Forbidden).`,
            { url, body: res.body.toString('utf8').slice(0, 300) }
          );
        }

        if (res.status === 404) {
          throw new XyzError(404, 'XYZ_NOT_FOUND',
            `Manifest not found on XYZ server (HTTP 404 Not Found).`,
            { url }
          );
        }

        if (this.isRetriableStatus(res.status)) {
          const err = new XyzError(res.status, 'XYZ_UPSTREAM_ERROR',
            `XYZ server returned HTTP ${res.status}. Attempt ${attempt + 1}/${maxRetries + 1}.`,
            { status: res.status, url }
          );
          lastErr = err;
          if (attempt < maxRetries) {
            const delay = Math.min(5000, 500 * Math.pow(2, attempt) + Math.random() * 300);
            await this.sleep(delay);
            continue;
          }
          throw err;
        }

        throw new XyzError(res.status, 'XYZ_HTTP_ERROR',
          `XYZ server returned unexpected HTTP ${res.status}`,
          { status: res.status, url }
        );
      } catch (err) {
        lastErr = err;
        if (err instanceof XyzError && (err.status === 401 || err.status === 403 || err.status === 404)) {
          // Do not retry client auth/not found errors
          throw err;
        }
        if (attempt < maxRetries) {
          const delay = Math.min(5000, 500 * Math.pow(2, attempt) + Math.random() * 300);
          await this.sleep(delay);
          continue;
        }
      }
    }

    throw lastErr;
  }

  /**
   * Fetch and validate manifest data from XYZ server
   */
  async fetchManifest(depotId, manifestId, options = {}) {
    const cleanDepot = uint32(depotId, 'depot ID');
    const cleanManifest = uint64(manifestId, 'manifest ID');
    const url = this.buildUrl(cleanDepot, cleanManifest, options);

    const res = await this.fetchRaw(url, options);
    let raw = res.body;

    // The response could be compressed or decompressed binary manifest
    let decompressed;
    try {
      decompressed = ContentManifest.decompress(raw).data;
    } catch (_) {
      // It might already be decompressed binary
      decompressed = raw;
    }

    let manifest;
    try {
      manifest = ContentManifest.parseManifest(decompressed);
    } catch (parseErr) {
      throw new XyzError(502, 'XYZ_INVALID_MANIFEST',
        `XYZ server returned data that could not be parsed as a Steam manifest: ${parseErr.message}`,
        { url, bodySnippet: raw.slice(0, 100).toString('hex') }
      );
    }

    if (String(manifest.depot_id) !== String(cleanDepot) || String(manifest.gid_manifest) !== String(cleanManifest)) {
      throw new XyzError(502, 'XYZ_MANIFEST_MISMATCH',
        `XYZ server returned a manifest for depot ${manifest.depot_id}, manifest ${manifest.gid_manifest}, expected ${cleanDepot}_${cleanManifest}`,
        { returnedDepotId: manifest.depot_id, returnedManifestId: manifest.gid_manifest }
      );
    }

    return {
      depotId: cleanDepot,
      manifestId: cleanManifest,
      raw,
      data: decompressed,
      manifest,
      source: 'xyz-proxy',
      endpoint: this.endpoint,
    };
  }
}

module.exports = {
  XyzClient,
  XyzError,
  DEFAULT_ENDPOINT,
};
