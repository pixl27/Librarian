const fetch = require('node-fetch');

const BASE_URL = 'https://hubcapmanifest.com/api/v1';

function normalizeAppId(appId) {
  const id = String(appId || '').trim();
  return /^\d{1,20}$/.test(id) ? id : null;
}

async function searchGames(query, apiKey) {
  if (!apiKey) return { error: 'API Key is not set. Please set it in Settings.' };

  try {
    const safeQuery = String(query || '').trim().slice(0, 120);
    if (safeQuery.length < 3) return { error: 'Search query must be at least 3 characters.' };

    const url = `${BASE_URL}/search?q=${encodeURIComponent(safeQuery)}&limit=50`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeout: 10000,
    });

    if (!res.ok) {
      const body = await res.text();
      try {
        const json = JSON.parse(body);
        return { error: `API Error (${res.status}): ${json.detail || body}` };
      } catch {
        return { error: `API Error (${res.status}): ${body}` };
      }
    }

    return await res.json();
  } catch (err) {
    return { error: `Request Failed: ${err.message}` };
  }
}

async function downloadManifest(appId, apiKey) {
  if (!apiKey) return { filepath: null, error: 'API Key is not set. Please set it in Settings.' };

  const safeAppId = normalizeAppId(appId);
  if (!safeAppId) return { filepath: null, error: 'Invalid AppID.' };

  const { app } = require('electron');
  const fs = require('fs');
  const path = require('path');
  const { pipeline } = require('stream/promises');

  const manifestsDir = path.join(app.getPath('userData'), 'hubcap_manifests');
  const savePath = path.join(manifestsDir, `librarian_fetch_${safeAppId}_${require('crypto').randomUUID()}.zip`);

  try {
    fs.mkdirSync(manifestsDir, { recursive: true });

    const url = `${BASE_URL}/manifest/${safeAppId}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeout: 60000,
    });

    if (!res.ok) {
      const body = await res.text();
      try {
        const json = JSON.parse(body);
        return { filepath: null, error: `API Error (${res.status}): ${json.detail || body}` };
      } catch {
        return { filepath: null, error: `API Error (${res.status}): ${body}` };
      }
    }

    const fileStream = fs.createWriteStream(savePath, { flags: 'wx' });
    await pipeline(res.body, fileStream);

    // Integrity checks so a truncated or non-zip response never reaches the
    // downloader as a "valid" manifest — the #1 cause of confusing failures later.
    const expectedLength = Number(res.headers.get('content-length'));
    const actualSize = fs.statSync(savePath).size;

    if (actualSize === 0) {
      throw new Error('the downloaded manifest file is empty.');
    }
    if (Number.isFinite(expectedLength) && expectedLength > 0 && actualSize !== expectedLength) {
      throw new Error(`the manifest download was truncated (${actualSize} of ${expectedLength} bytes). Please try again.`);
    }
    // A ZIP always begins with the "PK" local-file-header signature.
    const header = Buffer.alloc(4);
    const fd = fs.openSync(savePath, 'r');
    try {
      fs.readSync(fd, header, 0, 4, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (header[0] !== 0x50 || header[1] !== 0x4b) {
      throw new Error('the server did not return a valid manifest archive.');
    }

    await require('./zipProcessor').inspectArchiveAppId(savePath, safeAppId);
    return { filepath: savePath, appid: safeAppId, error: null };
  } catch (err) {
    try {
      if (fs.existsSync(savePath)) fs.unlinkSync(savePath);
    } catch {
      // Ignore cleanup failures and surface the original error.
    }
    return { filepath: null, error: `Download Failed: ${err.message}` };
  }
}

module.exports = { searchGames, downloadManifest };
