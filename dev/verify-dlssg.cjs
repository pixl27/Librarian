const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const { createManager, scan, inspectPe, explainError } = require('../src/core/dlssg');
const { executable, packageFixture } = require('./dlssg-fixture.cjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-dlssg-test-'));
const gpu = async () => ({ supported: true, name: 'Fixture RTX 3060 Ti' });
const pkg = packageFixture();
let sequence = 0, passed = 0;
function fixture(options = {}) {
  const dir = path.join(base, `game-${++sequence}`), exe = path.join(dir, 'Game/Binaries/Win64/Game.exe');
  executable(exe);
  fs.writeFileSync(path.join(path.dirname(exe), 'nvngx_dlssg.dll'), 'Existing native DLSSG. Preserve me.');
  const game = { install_path: dir, game_name: 'Fixture game' };
  const dataPath = path.join(base, `profile-${sequence}`);
  const manager = createManager({ dataPath, hardware: gpu, ensureIdle: async () => {}, retryDelay: 0, ...pkg, ...options });
  return { game, exe, dir, target: path.dirname(exe), manager, dataPath };
}
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
(async () => {
  await test('detects rendering EXE in a nested folder; upscaling alone stays hidden', async () => {
    const f = fixture();
    const s = await f.manager.status(f.game);
    assert.equal(s.canEnable, true); assert.equal(s.target, f.target); assert.equal(s.reported, false);
    fs.renameSync(path.join(f.target, 'nvngx_dlssg.dll'), path.join(f.target, 'nvngx_dlss.dll'));
    assert.equal((await f.manager.status(f.game)).visible, false);
  });
  await test('rejects x86, malformed PE and missing proxy/DX12 imports', async () => {
    const f = fixture();
    executable(f.exe, ['version.dll','d3d12.dll'], false); assert.equal((await f.manager.status(f.game)).canEnable, false);
    fs.writeFileSync(f.exe, 'MZ'); assert.equal(await inspectPe(f.exe), null);
    executable(f.exe, ['version.dll']); assert.equal((await scan(f.dir)).candidates.length, 0);
  });
  await test('follows actual engine DLL imports to detect renderer capabilities', async () => {
    const f = fixture(); executable(f.exe, ['engine.dll']); executable(path.join(f.target, 'engine.dll'));
    const s = await f.manager.status(f.game); assert.equal(s.canEnable, true); assert.equal(s.candidates[0].proxyImport, 'dependency');
  });
  await test('Unreal delay imports resolve third-party DLLs outside the rendering EXE folder', async () => {
    const f = fixture(); executable(f.exe, ['d3d12.dll', 'winmm.dll'], true, ['xaudio2_9redist.dll']);
    const dependency = path.join(f.dir, 'Engine/Binaries/ThirdParty/Windows/XAudio2_9/x64/xaudio2_9redist.dll');
    executable(dependency, ['version.dll']); const before = fs.readFileSync(dependency);
    const s = await f.manager.status(f.game);
    assert.equal(s.canEnable, true); assert.equal(s.target, f.target);
    assert(s.candidates[0].proxyEvidence.some(chain => chain.includes('xaudio2_9redist.dll → version.dll')));
    await f.manager.setEnabled(f.game, true); await f.manager.checkLaunch(f.game); await f.manager.setEnabled(f.game, false);
    assert(fs.readFileSync(dependency).equals(before));
  });
  await test('nested dependencies resolve siblings in their own third-party directory', async () => {
    const f = fixture(); executable(f.exe, ['d3d12.dll'], true, ['engine.dll']);
    const engine = path.join(f.dir, 'Engine/Binaries/ThirdParty/Runtime/engine.dll');
    executable(engine, ['nested.dll']); executable(path.join(path.dirname(engine), 'nested.dll'), ['version.dll']);
    executable(path.join(f.dir, 'Engine/Plugins/Unused/Binaries/Win64/nested.dll'), []);
    const s = await f.manager.status(f.game); assert.equal(s.canEnable, true);
    assert(s.candidates[0].proxyEvidence[0].includes('engine.dll → Engine'));
  });
  await test('Streamline plugins named by a reachable interposer provide the VERSION route', async () => {
    const f = fixture(); executable(f.exe, ['d3d12.dll', 'sl.interposer.dll']);
    const interposer = path.join(f.target, 'sl.interposer.dll');
    executable(interposer, []); executable(path.join(f.target, 'sl.common.dll'), ['version.dll']);
    assert.equal((await f.manager.status(f.game)).canEnable, false, 'an unnamed plugin is not evidence');
    const bytes = fs.readFileSync(interposer); bytes.write('sl.common.dll\0', 7000, 'utf16le'); fs.writeFileSync(interposer, bytes);
    const s = await f.manager.status(f.game);
    assert.equal(s.canEnable, true); assert.equal(s.candidates[0].proxyImport, 'dependency');
    assert(s.candidates[0].proxyEvidence.some(chain => /sl\.interposer\.dll → \S*sl\.common\.dll \(Streamline plugin\) → version\.dll$/.test(chain)));
  });
  await test('unreferenced plugins, backup DLLs and arbitrary folders cannot manufacture support', async () => {
    const f = fixture(); executable(f.exe, ['d3d12.dll', 'engine.dll']);
    executable(path.join(f.dir, 'Engine/Plugins/Unused/Binaries/Win64/unrelated.dll'), ['version.dll']);
    executable(path.join(f.dir, 'Backups/Engine/Binaries/Win64/engine.dll'), ['version.dll']);
    executable(path.join(f.dir, 'Random/engine.dll'), ['version.dll']);
    assert.equal((await f.manager.status(f.game)).canEnable, false);
  });
  await test('ambiguous third-party DLL basenames do not combine conflicting capabilities', async () => {
    const f = fixture(); executable(f.exe, ['d3d12.dll', 'engine.dll']);
    executable(path.join(f.dir, 'Engine/Binaries/ThirdParty/A/engine.dll'), ['version.dll']);
    executable(path.join(f.dir, 'Engine/Binaries/ThirdParty/B/engine.dll'), []);
    const s = await f.manager.status(f.game); assert.equal(s.canEnable, false);
    assert(s.issues.some(i => i.code === 'dependency-ambiguous'));
  });
  await test('x86 copies are excluded when resolving an x64 engine dependency', async () => {
    const f = fixture(); executable(f.exe, ['d3d12.dll', 'engine.dll']);
    executable(path.join(f.dir, 'Engine/Binaries/ThirdParty/Win32/engine.dll'), ['version.dll'], false);
    assert.equal((await f.manager.status(f.game)).canEnable, false);
    executable(path.join(f.dir, 'Engine/Binaries/ThirdParty/Win64/engine.dll'), ['version.dll']);
    assert.equal((await f.manager.status(f.game)).canEnable, true);
  });
  await test('an EXE-adjacent dependency takes precedence over unrelated engine copies', async () => {
    const f = fixture(); executable(f.exe, ['d3d12.dll', 'engine.dll']);
    executable(path.join(f.target, 'engine.dll'), []);
    executable(path.join(f.dir, 'Engine/Binaries/ThirdParty/Other/engine.dll'), ['version.dll']);
    assert.equal((await f.manager.status(f.game)).canEnable, false);
  });
  await test('GPU support, anti-cheat and ambiguous executable selection are enforced', async () => {
    const f = fixture({ hardware: async () => ({ supported: false, reason: 'Unsupported GPU' }) });
    await assert.rejects(f.manager.setEnabled(f.game, true), /Unsupported GPU/);
    const g = fixture(); fs.mkdirSync(path.join(g.dir, 'EasyAntiCheat')); await assert.rejects(g.manager.setEnabled(g.game, true), /Anti-cheat/);
    const h = fixture(); executable(path.join(h.target, 'Second.exe'));
    assert.equal((await h.manager.status(h.game)).canEnable, false);
    const selected = path.relative(h.dir, h.exe); assert.equal((await h.manager.status(h.game, selected)).canEnable, true);
    await assert.rejects(h.manager.setEnabled(h.game, true, '../outside.exe'), /Choose/);
  });
  await test('actual filename collisions block changes and preserve existing files', async () => {
    for (const name of ['version.dll', 'dlssg_sm86.ini']) {
      const f = fixture(), file = path.join(f.target, name); fs.writeFileSync(file, 'User mod');
      await assert.rejects(f.manager.setEnabled(f.game, true), /already exists/);
      assert.equal(fs.readFileSync(file, 'utf8'), 'User mod');
    }
  });
  await test('other loader filenames are notices; install and removal leave them untouched', async () => {
    for (const name of ['winmm.dll', 'dxgi.dll', 'd3d12.dll', 'dbghelp.dll', 'winhttp.dll']) {
      const f = fixture(), file = path.join(f.target, name); fs.writeFileSync(file, 'Existing unrelated component');
      const s = await f.manager.status(f.game); assert.equal(s.canEnable, true); assert(s.issues.some(i => i.code === 'other-loader' && i.severity === 'warning'));
      await f.manager.setEnabled(f.game, true); await f.manager.setEnabled(f.game, false);
      assert.equal(fs.readFileSync(file, 'utf8'), 'Existing unrelated component');
    }
  });
  await test('an unverified mod route is distinguished from native Frame Generation support', async () => {
    const f = fixture(); executable(f.exe, ['winmm.dll', 'd3d12.dll']);
    const s = await f.manager.status(f.game);
    assert.equal(s.canEnable, false); assert(s.issues.some(i => i.code === 'proxy-unavailable' && i.detail.includes('Renaming')));
    assert(s.reason.includes('not a statement that the game lacks Frame Generation'));
    assert(s.checks.find(c => c.label === 'DirectX 12 support').passed);
    assert.equal(s.target, f.target);
  });
  await test('dynamic DX12 APIs in a reachable engine are recognized', async () => {
    const f = fixture(); executable(f.exe, ['version.dll', 'engine.dll']);
    const engine = path.join(f.target, 'engine.dll'); executable(engine, []); fs.appendFileSync(engine, 'd3d12.dll\0D3D12CreateDevice\0');
    const s = await f.manager.status(f.game); assert.equal(s.canEnable, true); assert(s.issues.some(i => i.code === 'dynamic-dx12'));
  });
  await test('a referenced DX12 renderer is supported; an unrelated DLL is insufficient', async () => {
    const f = fixture(); executable(f.exe, ['version.dll', 'renderer.dll']);
    const engine = path.join(f.target, 'renderer.dll'); executable(engine, []);
    const provider = path.join(f.target, 'rd3d12_x64_test.dll'); executable(provider, []); fs.appendFileSync(provider, 'd3d12.dll\0D3D12CreateDevice\0');
    assert.equal((await f.manager.status(f.game)).canEnable, false);
    fs.appendFileSync(engine, Buffer.from('rd3d12', 'utf16le'));
    assert.equal((await f.manager.status(f.game)).canEnable, true);
    executable(provider, []); assert.equal((await f.manager.status(f.game)).canEnable, false);
  });
  await test('dynamic DX12 renderer lookup follows its engine dependency directory', async () => {
    const f = fixture(); executable(f.exe, ['engine.dll']);
    const engine = path.join(f.dir, 'Engine/Binaries/ThirdParty/Renderer/engine.dll');
    executable(engine, ['version.dll']); fs.appendFileSync(engine, 'rd3d12');
    const provider = path.join(path.dirname(engine), 'rd3d12_test.dll'); executable(provider, ['d3d12.dll']);
    const s = await f.manager.status(f.game); assert.equal(s.canEnable, true);
    assert(s.candidates[0].dx12Evidence.includes('Engine'));
  });
  await test('all blockers are retained instead of one filename hiding hardware or anti-cheat failures', async () => {
    const f = fixture({ hardware: async () => ({ supported: false, reason: 'Unsupported GPU' }) });
    fs.mkdirSync(path.join(f.dir, 'EasyAntiCheat')); fs.writeFileSync(path.join(f.target, 'version.dll'), 'User proxy'); fs.writeFileSync(path.join(f.target, 'dlssg_sm86.ini'), 'User config');
    const s = await f.manager.status(f.game);
    assert.equal(s.canEnable, false); assert(s.reason.startsWith('Unsupported GPU'));
    assert.deepEqual(s.issues.filter(i => i.severity === 'error').map(i => i.code), ['gpu', 'anti-cheat', 'file-conflict', 'file-conflict']);
  });
  await test('a second copy of the same SM86 payload is a genuine duplicate proxy conflict', async () => {
    const f = fixture(); fs.writeFileSync(path.join(f.target, 'winmm.dll'), pkg.payload['version.dll']);
    const s = await f.manager.status(f.game); assert.equal(s.canEnable, false); assert(s.issues.some(i => i.code === 'duplicate-proxy'));
    const g = fixture(); await g.manager.setEnabled(g.game, true);
    fs.writeFileSync(path.join(g.target, 'winmm.dll'), 'An unrelated component'); await g.manager.checkLaunch(g.game);
    fs.writeFileSync(path.join(g.target, 'winmm.dll'), pkg.payload['version.dll']);
    await assert.rejects(g.manager.checkLaunch(g.game), /Another copy/);
    await g.manager.setEnabled(g.game, false);
    assert(fs.readFileSync(path.join(g.target, 'winmm.dll')).equals(pkg.payload['version.dll']));
  });
  await test('filesystem and network failures explain concrete recovery steps', async () => {
    for (const [code, expected] of [['ENOSPC', 'Free space'], ['EACCES', 'Windows blocked'], ['EPERM', 'Windows blocked'], ['EBUSY', 'Close the game'], ['ENOENT', 'refresh the library'], ['EEXIST', 'preserved'], ['ENOTSUP', 'NTFS'], ['EXDEV', 'NTFS'], ['PROCESS_CHECK_UNAVAILABLE', 'process inspection'], ['ETIMEDOUT', 'connection'], ['ECONNRESET', 'connection'], ['ENOTFOUND', 'connection']]) {
      assert(explainError({ code, path: 'C:/Games/Fixture/version.dll' }).includes(expected), code);
    }
    assert.equal(explainError(new Error('Specific failure')), 'Specific failure');
  });
  await test('install, restart, disable and re-enable preserve original game files', async () => {
    const f = fixture(); const before = fs.readFileSync(f.exe), native = fs.readFileSync(path.join(f.target, 'nvngx_dlssg.dll'));
    assert.equal((await f.manager.setEnabled(f.game, true)).status.enabled, true);
    const restarted = createManager({ dataPath: f.dataPath, hardware: gpu, ensureIdle: async () => {}, ...pkg });
    assert.equal((await restarted.status(f.game)).enabled, true); await restarted.checkLaunch(f.game);
    assert.equal((await restarted.setEnabled(f.game, false)).status.enabled, false);
    assert(!fs.existsSync(path.join(f.target, 'version.dll'))); assert(fs.readFileSync(f.exe).equals(before));
    assert(fs.readFileSync(path.join(f.target, 'nvngx_dlssg.dll')).equals(native));
    assert.equal((await restarted.setEnabled(f.game, true)).status.enabled, true);
  });
  await test('two installations remain independent and share a verified cache', async () => {
    let downloads = 0;
    const a = fixture({ fetch: async (...args) => { downloads++; return pkg.fetch(...args); } }), b = fixture();
    await a.manager.setEnabled(a.game, true); await a.manager.setEnabled(b.game, true);
    assert.equal(downloads, pkg.release.files.length);
    await a.manager.setEnabled(a.game, false); assert.equal((await a.manager.status(b.game)).enabled, true);
  });
  await test('network errors and wrong hashes never alter game files', async () => {
    for (const fetch of [async () => ({ ok: false, status: 503 }), async () => ({ ok: true, buffer: async () => Buffer.from('wrong') })]) {
      const f = fixture({ fetch }); await assert.rejects(f.manager.setEnabled(f.game, true), /download failed|Integrity/);
      assert(!fs.existsSync(path.join(f.target, 'version.dll'))); assert(!fs.existsSync(path.join(f.dataPath, 'installs')));
    }
  });
  await test('cache corruption is repaired before a subsequent game is modified', async () => {
    let downloads = 0;
    const a = fixture({ fetch: async (...args) => { downloads++; return pkg.fetch(...args); } }), b = fixture();
    await a.manager.setEnabled(a.game, true);
    fs.writeFileSync(path.join(a.dataPath, 'packages/fixture/version.dll'), 'corrupt');
    await a.manager.setEnabled(b.game, true); assert.equal(downloads, pkg.release.files.length + 1);
  });
  await test('temporary CDN failures retry the same pinned bytes before installing', async () => {
    let calls = 0;
    const f = fixture({ fetch: async (...args) => ++calls === 1 ? { ok: false, status: 503 } : pkg.fetch(...args) });
    await f.manager.setEnabled(f.game, true); assert.equal(calls, pkg.release.files.length + 1);
  });
  await test('persistent raw HTTP 503 switches to GitHub API and reuses that route for the package', async () => {
    const calls = [];
    const f = fixture({ fetch: async (url, options) => {
      calls.push(url); assert.equal(options.redirect, 'error');
      if (new URL(url).hostname === 'raw.githubusercontent.com') return { ok: false, status: 503 };
      assert.equal(new URL(url).searchParams.get('ref'), pkg.release.commit);
      assert.equal(options.headers.Accept, 'application/vnd.github.raw+json');
      return pkg.fetch(url);
    } });
    await f.manager.setEnabled(f.game, true);
    assert.equal(calls.filter(url => new URL(url).hostname === 'raw.githubusercontent.com').length, 1);
    assert.equal(calls.length, pkg.release.files.length + 1);
  });
  await test('GitHub delivery failures fall back to a pinned CDN without relaxing integrity checks', async () => {
    const calls = [];
    const f = fixture({ fetch: async (url, options) => {
      calls.push(url);
      if (new URL(url).hostname === 'raw.githubusercontent.com') return { ok: false, status: 503 };
      if (new URL(url).hostname === 'api.github.com') throw Object.assign(new Error('timeout'), { type: 'request-timeout' });
      assert(url.includes(`@${pkg.release.commit}/`)); assert.equal(options.redirect, 'error');
      return pkg.fetch(url);
    } });
    await f.manager.setEnabled(f.game, true); assert.equal(calls.length, pkg.release.files.length + 2);
    assert(fs.readFileSync(path.join(f.target, 'version.dll')).equals(pkg.payload['version.dll']));
  });
  await test('an HTTP 200 response with wrong bytes is rejected before trying a verified route', async () => {
    const f = fixture({ fetch: async url => new URL(url).hostname === 'cdn.jsdelivr.net' ? pkg.fetch(url)
      : { ok: true, buffer: async () => Buffer.alloc(pkg.payload[new URL(url).pathname.split('/').at(-1)].length, 7) } });
    await f.manager.setEnabled(f.game, true);
    assert(fs.readFileSync(path.join(f.target, 'version.dll')).equals(pkg.payload['version.dll']));
  });
  await test('all routes failing report a retryable download error without creating an installation', async () => {
    const f = fixture({ fetch: async () => ({ ok: false, status: 503 }) });
    await assert.rejects(f.manager.setEnabled(f.game, true), error => error.code === 'DLSSG_DOWNLOAD_FAILED' && error.message.includes('version.dll') && error.message.includes('GitHub API') && error.message.includes('jsDelivr') && error.message.includes('Retry installation'));
    assert.equal((await f.manager.status(f.game)).installed, false);
    assert(!fs.existsSync(path.join(f.target, 'version.dll')));
  });
  await test('retry resumes a partial verified cache and a complete cache works offline after restart', async () => {
    let failing = true; const calls = [];
    const f = fixture({ fetch: async url => { calls.push(url); return failing && !new URL(url).pathname.endsWith('/version.dll') ? { ok: false, status: 503 } : pkg.fetch(url); } });
    await assert.rejects(f.manager.setEnabled(f.game, true), /dlssg_sm86.ini/);
    failing = false; calls.length = 0; await f.manager.setEnabled(f.game, true);
    assert(!calls.some(url => new URL(url).pathname.endsWith('/version.dll')));
    await f.manager.setEnabled(f.game, false);
    const offline = createManager({ dataPath: f.dataPath, hardware: gpu, ensureIdle: async () => {}, ...pkg, fetch: async () => { throw new Error('Offline fetch must never run'); } });
    await offline.setEnabled(f.game, true); assert.equal((await offline.status(f.game)).enabled, true);
  });
  await test('external file changes block removal and launch without deleting user data', async () => {
    const f = fixture(); await f.manager.setEnabled(f.game, true);
    fs.writeFileSync(path.join(f.target, 'version.dll'), 'Another mod');
    const s = await f.manager.status(f.game); assert.equal(s.enabled, false); assert.equal(s.canDisable, false);
    await assert.rejects(f.manager.setEnabled(f.game, false), /changed/); await assert.rejects(f.manager.checkLaunch(f.game), /changed/);
    assert.equal(fs.readFileSync(path.join(f.target, 'version.dll'), 'utf8'), 'Another mod');
  });
  await test('missing files remain recoverable even when GPU or DLSSG support disappears', async () => {
    const f = fixture(); await f.manager.setEnabled(f.game, true);
    fs.unlinkSync(path.join(f.target, 'version.dll')); fs.unlinkSync(path.join(f.target, 'nvngx_dlssg.dll'));
    const m = createManager({ dataPath: f.dataPath, hardware: async () => ({ supported: false }), ensureIdle: async () => {}, ...pkg });
    const s = await m.status(f.game); assert.equal(s.canDisable, true); assert.equal(s.enabled, false); assert.equal(s.visible, true);
    await m.setEnabled(f.game, false); assert(!fs.existsSync(path.join(f.target, 'dlssg_sm86.ini')));
  });
  await test('launch rechecks compatibility after game updates and retains an explicit EXE selection', async () => {
    const f = fixture(); executable(path.join(f.target, 'Second.exe'));
    await f.manager.setEnabled(f.game, true, path.relative(f.dir, f.exe));
    assert.equal((await f.manager.status(f.game)).compatible, true); await f.manager.checkLaunch(f.game);
    fs.mkdirSync(path.join(f.dir, 'EasyAntiCheat'));
    await assert.rejects(f.manager.checkLaunch(f.game), /requirements changed/);
    await f.manager.setEnabled(f.game, false);
  });
  await test('failed publication rolls back only owned files and leaves a retryable state', async () => {
    const f = fixture(), original = fsp.link;
    fsp.link = async (source, target) => { if (target.endsWith('version.dll')) throw new Error('Simulated sharing violation'); return original(source, target); };
    try { await assert.rejects(f.manager.setEnabled(f.game, true), /sharing violation/); } finally { fsp.link = original; }
    assert(!fs.existsSync(path.join(f.target, 'dlssg_sm86.ini'))); assert.equal((await f.manager.status(f.game)).canEnable, true);
  });
  await test('a Windows sharing violation during removal preserves the receipt and remains retryable', async () => {
    const f = fixture(); await f.manager.setEnabled(f.game, true);
    const original = fsp.unlink;
    fsp.unlink = async file => { if (file === path.join(f.target, 'dlssg_sm86.ini')) throw Object.assign(new Error('File locked'), { code: 'EBUSY', path: file }); return original(file); };
    try { await assert.rejects(f.manager.setEnabled(f.game, false), error => error.code === 'EBUSY' && explainError(error).includes('Close the game')); }
    finally { fsp.unlink = original; }
    const s = await f.manager.status(f.game); assert.equal(s.installed, true); assert.equal(s.enabled, false); assert.equal(s.canDisable, true);
    await f.manager.setEnabled(f.game, false); assert.equal((await f.manager.status(f.game)).canEnable, true);
  });
  await test('running game and files changed while downloading are rechecked before writing', async () => {
    let checks = 0;
    const f = fixture({ ensureIdle: async () => { if (++checks === 2) throw new Error('Game started'); } });
    await assert.rejects(f.manager.setEnabled(f.game, true), /Game started/); assert(!fs.existsSync(path.join(f.target, 'version.dll')));
    let g;
    g = fixture({ fetch: async (...args) => { fs.writeFileSync(path.join(g.target, 'version.dll'), 'Arrived during download'); return pkg.fetch(...args); } });
    await assert.rejects(g.manager.setEnabled(g.game, true), /already exists/);
    assert.equal(fs.readFileSync(path.join(g.target, 'version.dll'), 'utf8'), 'Arrived during download');
  });
  await test('concurrent toggles for the same installation are serialized', async () => {
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const f = fixture({ ensureIdle: async () => { entered(); await gate; } });
    const first = f.manager.setEnabled(f.game, true); await started;
    await assert.rejects(f.manager.setEnabled(f.game, true), /already being changed/); release(); await first;
  });
  await test('linked folders and tampered receipts cannot redirect writes/removals', async () => {
    const f = fixture(); const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(f.dir, 'linked'), 'junction');
    assert.equal((await f.manager.status(f.game)).canEnable, false);
    const g = fixture(); await g.manager.setEnabled(g.game, true);
    const receiptPath = path.join(g.dataPath, 'installs', fs.readdirSync(path.join(g.dataPath, 'installs'))[0]);
    const receipt = JSON.parse(fs.readFileSync(receiptPath)); receipt.exe = path.join(outside, 'outside.exe'); fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    await assert.rejects(g.manager.setEnabled(g.game, false), /outside/); assert(fs.existsSync(path.join(g.target, 'version.dll')));
  });
  console.log(`${passed}/${passed} DLSSG behavioral checks passed. No game or payload was executed.`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  assert(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep + 'librarian-dlssg-test-'));
  fs.rmSync(base, { recursive: true, force: true });
});
