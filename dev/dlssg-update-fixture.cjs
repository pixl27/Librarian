// Inert payloads and GitHub responses. No downloaded DLL is executed.
const { sha256, blobSha1, REPOSITORY } = require('../src/core/dlssgUpstream');
const OLD = 'a'.repeat(40), NEXT = 'b'.repeat(40), TREE = 'c'.repeat(40);
function updateFixture() {
  const oldPayload = { 'version.dll': Buffer.from('Inert OLD proxy, never executable.'), 'dlssg_sm86.ini': Buffer.from('[General]\nEnabled=1\n'),
    'README.en.md': Buffer.from('# DLSSG Native 0.1.0\nFixture.'), 'THIRD_PARTY_NOTICES.txt': Buffer.from('Fixture notices.') };
  const newPayload = { 'version.dll': Buffer.from('Inert NEW proxy, never executable.'), 'dlssg_sm86.ini': Buffer.from('[DLSSG]\nRouter=SM86\nKernelImage=PTX\n'),
    'README.en.md': Buffer.from('# DLSSG Native 0.2.4\nFixture.'), 'THIRD_PARTY_NOTICES.txt': Buffer.from('New fixture notices.') };
  const deploy = name => ['version.dll', 'dlssg_sm86.ini'].includes(name);
  const release = { repository: REPOSITORY, commit: OLD, runtime: '310.1', version: '0.1.0', files: Object.entries(oldPayload).map(([name, bytes]) => ({ name, size: bytes.length, sha256: sha256(bytes), deploy: deploy(name) })) };
  const head = { sha: NEXT, commit: { tree: { sha: TREE }, message: 'Native 0.2.4', committer: { date: '2026-09-11T00:00:00Z' } } };
  const tree = { sha: TREE, truncated: false, tree: Object.entries(newPayload).map(([name, bytes]) => ({ path: name, type: 'blob', mode: '100644', size: bytes.length, sha: blobSha1(bytes) })) };
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url), tail = parsed.pathname.split('/').at(-1);
    let result;
    if (parsed.pathname.endsWith('/commits/main')) result = head;
    else if (parsed.pathname.endsWith(`/git/trees/${TREE}`)) result = tree;
    else if (parsed.pathname.includes('/compare/')) result = { status: 'ahead' };
    if (result) return { ok: true, json: async () => JSON.parse(JSON.stringify(result)) };
    const payload = url.includes(NEXT) ? newPayload : oldPayload;
    if (!payload[tail]) throw new Error(`Unexpected fixture request: ${url}`);
    return { ok: true, buffer: async () => Buffer.from(payload[tail]) };
  };
  return { release, oldPayload, newPayload, fetch, calls, head, tree };
}
module.exports = { updateFixture, OLD, NEXT, TREE };
