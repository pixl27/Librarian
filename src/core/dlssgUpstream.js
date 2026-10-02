// Discover immutable package revisions. Merely checking never downloads a DLL.
const crypto = require('crypto');
const REPOSITORY = 'https://github.com/sdli1995/dlssg_for_sm86';
const API = 'https://api.github.com/repos/sdli1995/dlssg_for_sm86';
const LIMITS = { 'version.dll': 64 * 1024 * 1024, 'dlssg_sm86.ini': 128 * 1024, 'README.en.md': 1024 * 1024, 'THIRD_PARTY_NOTICES.txt': 1024 * 1024 };
const DEPLOY = ['version.dll', 'dlssg_sm86.ini'];
const revision = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const blobSha1 = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function validManifest(value, verified = false) {
  return value?.repository === REPOSITORY && revision(value.commit)
    && Array.isArray(value.files) && value.files.length === Object.keys(LIMITS).length
    && new Set(value.files.map(file => file.name)).size === value.files.length
    && value.files.every(file => Object.hasOwn(LIMITS, file.name)
      && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= LIMITS[file.name]
      && Boolean(file.deploy) === DEPLOY.includes(file.name)
      && (verified ? /^[a-f0-9]{64}$/.test(file.sha256 || '') : revision(file.blobSha1)))
    && (value.runtime === undefined || typeof value.runtime === 'string')
    && (value.version === undefined || typeof value.version === 'string');
}

function matches(bytes, file) {
  return bytes.length === file.size && (!file.sha256 || sha256(bytes) === file.sha256)
    && (!file.blobSha1 || blobSha1(bytes) === file.blobSha1)
    && Boolean(file.sha256 || file.blobSha1);
}

function createUpstream(fetchFile) {
  async function getJson(url) {
    const response = await fetchFile(url, { timeout: 20000, size: 2 * 1024 * 1024, redirect: 'error',
      headers: { 'User-Agent': 'Librarian-DLSSG', Accept: 'application/vnd.github+json' } });
    if (!response.ok) {
      response.body?.destroy();
      const reason = response.status === 403 || response.status === 429
        ? 'GitHub temporarily limited update checks. Try again later.' : `GitHub update check failed (HTTP ${response.status}). Try again.`;
      throw new Error(reason);
    }
    return response.json();
  }
  async function check() {
    const head = await getJson(`${API}/commits/main`);
    if (!revision(head?.sha) || !revision(head?.commit?.tree?.sha)) throw new Error('GitHub returned invalid revision metadata.');
    const tree = await getJson(`${API}/git/trees/${head.commit.tree.sha}`);
    if (tree.sha !== head.commit.tree.sha || tree.truncated || !Array.isArray(tree.tree)) throw new Error('GitHub returned an incomplete package tree.');
    const files = Object.keys(LIMITS).map(name => {
      const entries = tree.tree.filter(entry => entry.path === name);
      const item = entries[0];
      if (entries.length !== 1 || item.type !== 'blob' || !['100644', '100755'].includes(item.mode)) throw new Error(`The upstream package layout changed: ${name} is unavailable. No games were changed.`);
      return { name, size: item.size, blobSha1: item.sha, deploy: DEPLOY.includes(name) };
    });
    const title = String(head.commit.message || '').split('\n')[0].slice(0, 160);
    const manifest = { repository: REPOSITORY, commit: head.sha, title, date: head.commit.committer?.date || '',
      version: title.match(/\b(?:native|release|v)\s*(\d+\.\d+\.\d+)\b/i)?.[1] || '', runtime: 'Upstream', files };
    if (!validManifest(manifest)) throw new Error('The upstream package exceeds the supported format or size. No games were changed.');
    return manifest;
  }
  const comparisons = new Map();
  async function isNewer(installed, candidate) {
    if (installed === candidate) return false;
    if (!revision(installed) || !revision(candidate)) throw new Error('The installed revision cannot be compared with GitHub.');
    const key = `${installed}...${candidate}`;
    if (!comparisons.has(key)) {
      const result = await getJson(`${API}/compare/${key}`);
      if (!['ahead', 'behind', 'identical', 'diverged'].includes(result.status)) throw new Error('GitHub could not establish the update history.');
      comparisons.set(key, result.status);
    }
    return comparisons.get(key) === 'ahead';
  }
  return { check, isNewer };
}

module.exports = { createUpstream, validManifest, matches, sha256, blobSha1, REPOSITORY };
