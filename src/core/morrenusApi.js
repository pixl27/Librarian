const fetch = require('node-fetch');

const BASE_URL = 'https://manifest.morrenus.xyz/api/v1';

async function searchGames(query, apiKey) {
  if (!apiKey) return { error: 'API Key is not set. Please set it in Settings.' };

  try {
    const url = `${BASE_URL}/search?q=${encodeURIComponent(query)}&limit=50`;
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

  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const manifestsDir = path.join(__dirname, '..', '..', 'morrenus_manifests');
  fs.mkdirSync(manifestsDir, { recursive: true });
  const savePath = path.join(manifestsDir, `librarian_fetch_${appId}.zip`);

  try {
    const url = `${BASE_URL}/manifest/${appId}`;
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

    const fileStream = fs.createWriteStream(savePath);
    await new Promise((resolve, reject) => {
      res.body.pipe(fileStream);
      res.body.on('error', reject);
      fileStream.on('finish', resolve);
    });

    return { filepath: savePath, error: null };
  } catch (err) {
    if (fs.existsSync(savePath)) fs.unlinkSync(savePath);
    return { filepath: null, error: `Download Failed: ${err.message}` };
  }
}

module.exports = { searchGames, downloadManifest };
