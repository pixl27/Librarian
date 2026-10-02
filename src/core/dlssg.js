// Per-installation, opt-in DLSSG SM86 deployment. Never executes the payload.
// Receipts precede file creation so interrupted installs can be removed safely.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { inspectPe } = require('./dlssgPe');
const release = require('./dlssgRelease.json');
const upstreamTools = require('./dlssgUpstream');
const json = require('./jsonFile');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };

function explainError(error) {
  const file = error.path ? ` (${error.path})` : '';
  switch (error.code) {
    case 'ENOSPC': return `Not enough free disk space${file}. Free space on the game and Librarian data drives, then check again.`;
    case 'EACCES': case 'EPERM': case 'EBUSY': return `Windows blocked access to a file${file}. Close the game and check folder permissions or Windows Security protection history, then check again. Any incomplete installation remains recoverable.`;
    case 'ENOENT': return `The game folder or a required file is missing${file}. Check that the drive is connected and refresh the library.`;
    case 'EEXIST': return `A file appeared in the target folder during installation${file}. It was preserved. Check the game folder before retrying.`;
    case 'ENOTSUP': case 'EXDEV': return 'This game drive does not support the file operation needed for a reversible installation. Use a local NTFS game folder.';
    case 'PROCESS_CHECK_UNAVAILABLE': return 'Could not check whether the game is running. Windows process inspection must work before its files can be changed.';
    case 'ETIMEDOUT': case 'ECONNRESET': case 'ENOTFOUND': return 'The package download could not finish. Check the connection and try again; verified cached files will be reused.';
    default: return error.message || String(error);
  }
}

async function probeHardware() {
  if (process.platform !== 'win32' || process.arch !== 'x64') return { supported: false, reason: 'Requires Windows x64.' };
  try {
    const { stdout } = await execFile('nvidia-smi.exe', ['--query-gpu=name,compute_cap,driver_version', '--format=csv,noheader'], { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    const devices = stdout.trim().split(/\r?\n/).map(row => { const [name, sm, driver] = row.split(',').map(v => v.trim()); return { name, sm, driver }; });
    const gpu = devices.find(d => d.sm === '8.6');
    return { supported: !!gpu, devices, name: gpu?.name || devices.map(d => d.name).join(', '), reason: gpu ? '' : 'Requires an NVIDIA SM 8.6 GPU (RTX 30 series).' };
  } catch { return { supported: false, reason: 'Could not verify GPU support. Install the NVIDIA driver, then check again.' }; }
}

async function assertNotRunning(root) {
  if (process.platform !== 'win32') throw new Error('Requires Windows.');
  // The path is data in an environment variable, never interpolated into shell code.
  const script = "$ErrorActionPreference='Stop'; $r=$env:LIBRARIAN_DLSSG_ROOT.TrimEnd('\\')+'\\'; $p=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($r,[System.StringComparison]::OrdinalIgnoreCase) }); if($p.Count){ Write-Output 'RUNNING' }";
  const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 65536, env: { ...process.env, LIBRARIAN_DLSSG_ROOT: root } })
    .catch(cause => { throw Object.assign(new Error('Could not inspect running processes.'), { code: 'PROCESS_CHECK_UNAVAILABLE', cause }); });
  if (stdout.includes('RUNNING')) throw new Error('Close the game and its launcher before changing frame generation.');
}

async function checkedPath(root, file) {
  if (!inside(root, path.resolve(file))) throw new Error('Frame generation target is outside this installation.');
  const relative = path.relative(root, path.resolve(file));
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Frame generation does not modify linked files or folders.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return file;
}

async function fingerprint(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) return 'foreign';
    return hash(await fs.readFile(file));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

const { scan } = require('./dlssgScan');

function createManager(options = {}) {
  const dataPath = () => options.dataPath || path.join(require('electron').app.getPath('userData'), 'dlssg-sm86');
  const getHardware = options.hardware || probeHardware;
  const ensureIdle = options.ensureIdle || assertNotRunning;
  const fetchFile = options.fetch || require('node-fetch');
  let pins = options.release || release;
  let activeLoaded = false;
  const upstream = options.upstream || upstreamTools.createUpstream(fetchFile);
  const candidates = new Map(), packagePending = new Map();
  const locks = new Set();
  let preferredDownloadSource = 0;
  const receiptPath = root => path.join(dataPath(), 'installs', `${hash(root.toLowerCase())}.json`);
  const cachePath = selected => path.join(dataPath(), 'packages', selected.commit);
  async function loadActive() {
    if (activeLoaded) return;
    try {
      const selected = JSON.parse(await fs.readFile(path.join(dataPath(), 'active-release.json'), 'utf8'));
      if (!upstreamTools.validManifest(selected, true)) throw new Error('Invalid saved DLSS FG package metadata.');
      pins = selected;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    activeLoaded = true;
  }
  const rootFor = async game => {
    if (!game?.install_path || !path.isAbsolute(game.install_path)) throw new Error('No valid game installation folder.');
    const root = await fs.realpath(game.install_path);
    if (samePath(root, path.parse(root).root)) throw new Error('Select a game folder, not a drive.');
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Game installation folder is unavailable.');
    return root;
  };
  async function receiptFor(root) {
    let receipt;
    try { receipt = JSON.parse(await fs.readFile(receiptPath(root), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Cannot read the frame generation receipt. Existing files were preserved.'); }
    const validFiles = files => Array.isArray(files) && files.length === 2 && new Set(files.map(f => f?.name)).size === 2
      && files.every(f => ['version.dll', 'dlssg_sm86.ini'].includes(f?.name) && /^[a-f0-9]{64}$/.test(f.sha256));
    if (receipt.schema !== 1 || typeof receipt.root !== 'string' || !samePath(receipt.root, root) || typeof receipt.exe !== 'string' || !validFiles(receipt.files)
      || (receipt.update && (!/^[a-f0-9]{40}$/.test(receipt.update.commit || '') || !validFiles(receipt.update.files)))) throw new Error('Invalid frame generation receipt. Existing files were preserved.');
    await checkedPath(root, path.resolve(root, receipt.exe));
    return receipt;
  }
  async function ownedState(root, receipt) {
    const directory = path.dirname(path.resolve(root, receipt.exe));
    const files = [];
    for (const file of receipt.files) {
      const target = await checkedPath(root, path.join(directory, file.name));
      files.push({ ...file, target, actual: await fingerprint(target) });
    }
    return { files, intact: !receipt.update && files.every(f => f.actual === f.sha256),
      changed: files.filter(f => f.actual && f.actual !== f.sha256 && f.actual !== receipt.update?.files.find(next => next.name === f.name)?.sha256) };
  }
  async function status(game, selection) {
    await loadActive();
    const root = await rootFor(game), receipt = await receiptFor(root);
    const [found, gpu] = await Promise.all([scan(root), getHardware()]);
    const owned = receipt ? await ownedState(root, receipt) : null;
    const candidates = found.candidates;
    const wanted = receipt?.exe || selection;
    const candidate = wanted ? candidates.find(c => c.exe === wanted) : candidates.length === 1 ? candidates[0] : null;
    const compatible = !!(gpu.supported && !found.antiCheat.length && !found.incomplete && found.evidence.length && candidate);
    const issues = [];
    const add = (code, title, detail, severity = 'error') => issues.push({ code, title, detail, severity });
    const report = candidate || [...found.reports].sort((a, b) => (Number(b.dx12) * 4 + Number(b.version) * 2 + Number(b.x64)) - (Number(a.dx12) * 4 + Number(a.version) * 2 + Number(a.x64)))[0];
    if (!gpu.supported) add('gpu', gpu.reason || 'GPU support could not be verified.', 'Requires an NVIDIA SM 8.6 GPU. Check the NVIDIA driver and use Check again.');
    if (found.antiCheat.length) add('anti-cheat', 'Anti-cheat detected.', `${found.antiCheat.join(', ')}. This installation is unavailable for the mod; disabling a managed installation remains possible.`);
    if (found.incomplete) add('scan-incomplete', 'The game folder could not be fully inspected.', found.gaps.map(g => `${g.path || '.'}: ${g.reason}`).join('; ') + '. Restore access or inspect the linked folder before retrying.');
    if (!found.evidence.length) add('no-dlssg', 'No DLSS Frame Generation files detected.', 'DLSS upscaling alone is not sufficient. Check that this game version includes DLSS Frame Generation.');
    else if (!candidates.length) {
      if (!found.reports.some(r => r.x64)) add('no-x64', 'No readable 64-bit game executable found.', 'Check the installation folder and files. A 32-bit game cannot use this x64 mod.');
      else {
        if (!report.dx12) add('dx12-unverified', 'DirectX 12 could not be verified.', `${report.exe}: neither its imports nor a referenced DX12 renderer provided enough evidence. Check that the game has a DX12 mode; this result does not prove incompatibility.`);
        if (!report.version) add('proxy-unavailable', 'The mod loading route could not be verified.', `${report.exe}: NVIDIA Frame Generation files are present, but the inspected imports and resolved dependencies did not establish a VERSION route. This is a mod-loading check, not a statement that the game lacks Frame Generation. Renaming version.dll is not a substitute.`);
        if (report.ambiguousDependencies?.length) add('dependency-ambiguous', 'Some dependency locations are ambiguous.', `${report.ambiguousDependencies.map(d => `${d.name}: ${d.paths.join(', ')}`).join('; ')}. Several copies exist, so Librarian has not assumed which one loads.`, 'warning');
      }
    } else if (!candidate) add('select-exe', 'Choose the rendering executable below.', 'Several eligible executables were found; no game files will change until one is selected.');
    const target = receipt ? path.dirname(path.resolve(root, receipt.exe)) : (candidate || report) ? path.join(root, (candidate || report).directory) : root;
    if (candidate || receipt || report?.x64) {
      if (!receipt) for (const name of ['version.dll', 'dlssg_sm86.ini']) {
        const file = await checkedPath(root, path.join(target, name));
        if (await fingerprint(file)) add('file-conflict', `${name} already exists beside this executable.`, 'This is a filename collision. Identify the existing mod and use its removal or restore option before retrying. Librarian will not overwrite it.');
      }
      for (const name of ['winmm.dll', 'dxgi.dll', 'd3d12.dll', 'dbghelp.dll', 'winhttp.dll']) {
        const actual = await fingerprint(path.join(target, name));
        if (!actual) continue;
        if ([pins, receipt].some(record => actual === record?.files.find(f => f.name === 'version.dll')?.sha256)) add('duplicate-proxy', `Another copy of the SM86 proxy is named ${name}.`, 'Use a single entry point. Remove the manually installed copy using its original instructions before enabling.');
        else add('other-loader', `${name} is already present and will be preserved.`, 'It uses a different filename from this mod, so there is no overwrite conflict. Coexistence has not been verified in-game.', 'warning');
      }
    }
    if (candidate?.dx12Evidence.startsWith('Dynamic')) add('dynamic-dx12', 'A dynamically loaded DirectX 12 renderer was detected.', `${candidate.dx12Evidence}. Select DirectX 12 in the game; detection cannot tell which mode is currently selected.`, 'info');
    if (owned?.changed.length) add('modified-files', `Installed ${owned.changed.map(f => f.name).join(', ')} changed outside Librarian.`, 'Files were preserved. Restore the installed version or remove it using the tool that changed it, then remove the remaining installation here.');
    else if (receipt?.update) add('interrupted-update', 'A previous DLSS FG update did not finish.', 'Use Remove incomplete installation, then enable again. The previous package was backed up in Librarian’s data folder.');
    else if (receipt && !owned.intact) add('incomplete-install', 'Installation is incomplete or files were removed by an update.', 'Use Remove incomplete installation, then enable again to restore the verified package.');
    const blockers = issues.filter(i => i.severity === 'error');
    const reason = blockers.length ? `${blockers[0].title} ${blockers[0].detail}` : '';
    const checks = [
      { label: 'NVIDIA SM 8.6 GPU', passed: !!gpu.supported, detail: gpu.name || gpu.reason || 'Not verified' },
      { label: 'DLSS Frame Generation files', passed: !!found.evidence.length, detail: found.evidence.join(', ') || 'Not detected' },
      { label: '64-bit rendering executable', passed: !!report?.x64, detail: report?.exe || 'Not detected' },
      { label: 'DirectX 12 support', passed: !!report?.dx12, detail: report?.dx12Evidence || 'Not verified by file inspection' },
      { label: 'Mod loading route (VERSION)', passed: !!report?.version, detail: report?.version ? report.proxyEvidence?.join('\n') || 'Import found in the executable or a dependency' : 'Not verified from the inspected dependency paths' },
    ];
    return { ok: true, visible: !!(receipt || found.evidence.length), compatible, installed: !!receipt, enabled: !!owned?.intact, canEnable: !receipt && !blockers.length, canDisable: !!receipt && !owned.changed.length,
      reason, issues, checks, reports: found.reports, gpu, candidates, selected: receipt?.exe || candidate?.exe || '', evidence: found.evidence, reported: !!candidate?.reported,
      runtime: receipt?.runtime || pins.runtime, commit: receipt?.commit || pins.commit, version: receipt?.version || (!receipt ? pins.version : '') || '', source: pins.repository, target };
  }
  async function downloadPackage(selected) {
    const directory = cachePath(selected);
    await fs.mkdir(directory, { recursive: true });
    for (const file of selected.files) {
      const target = path.join(directory, file.name);
      try {
        const stat = await fs.lstat(target);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size === file.size) {
          const cached = await fs.readFile(target);
          if (upstreamTools.matches(cached, file)) { file.sha256 = hash(cached); continue; }
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const filename = encodeURIComponent(file.name), revision = encodeURIComponent(selected.commit);
      // Different delivery routes for the same immutable revision. Every route
      // must satisfy the original size/hash pins; redirects are not followed.
      const sources = [
        { name: 'GitHub raw', url: `https://raw.githubusercontent.com/sdli1995/dlssg_for_sm86/${revision}/${filename}`, accept: 'application/octet-stream' },
        { name: 'GitHub API', url: `https://api.github.com/repos/sdli1995/dlssg_for_sm86/contents/${filename}?ref=${revision}`, accept: 'application/vnd.github.raw+json' },
        { name: 'jsDelivr', url: `https://cdn.jsdelivr.net/gh/sdli1995/dlssg_for_sm86@${revision}/${filename}`, accept: 'application/octet-stream' },
      ];
      const order = [preferredDownloadSource, ...sources.map((_, index) => index).filter(index => index !== preferredDownloadSource)];
      const failures = [];
      let bytes;
      for (const index of order) {
        const source = sources[index];
        // jsDelivr refuses GitHub files over 20 MB with a 403; newer proxies are larger.
        if (source.name === 'jsDelivr' && file.size > 20 * 1024 * 1024) { failures.push(`${source.name}: file exceeds its 20 MB limit`); continue; }
        // A fixed total deadline fails large files on slow links (30 MB needs
        // 1.5 MB/s in 20 s). Abort only when no data arrives for 20 s, with an
        // overall ceiling so a trickling connection still ends.
        const controller = new AbortController();
        let abortReason = '', stallTimer;
        const arm = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => { abortReason = 'stalled (no data for 20 s)'; controller.abort(); }, 20000); };
        const deadline = setTimeout(() => { abortReason = 'timed out after 15 minutes'; controller.abort(); }, 15 * 60 * 1000);
        arm();
        try {
          const response = await fetchFile(source.url,
            { signal: controller.signal, size: file.size + 1, redirect: 'error', headers: { 'User-Agent': 'Librarian-DLSSG', Accept: source.accept } });
          if (!response.ok) {
            response.body?.destroy?.();
            failures.push(`${source.name}: HTTP ${response.status}`);
            continue;
          }
          arm();
          const pending = response.buffer();
          // buffer() subscribes synchronously, so this listener sees every chunk.
          response.body?.on?.('data', arm);
          const downloaded = await pending;
          if (!upstreamTools.matches(downloaded, file)) {
            failures.push(`${source.name}: Integrity check failed`);
            continue;
          }
          bytes = downloaded; preferredDownloadSource = index;
          break;
        } catch (error) {
          const reason = abortReason || (error.type?.includes('timeout') || error.code === 'ETIMEDOUT' ? 'timed out'
            : error.type === 'max-size' ? 'response exceeded the expected size'
              : /^[A-Z][A-Z0-9_]{0,36}$/.test(error.code || '') ? error.code : 'connection failed');
          failures.push(`${source.name}: ${reason}`);
        } finally { clearTimeout(stallTimer); clearTimeout(deadline); }
      }
      if (!bytes) throw Object.assign(new Error(`Frame generation download failed for ${file.name}. ${failures.join('; ')}. No game files were changed. Use Retry installation to try again; verified cached files will be reused.`), { code: 'DLSSG_DOWNLOAD_FAILED' });
      const temp = `${target}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temp, bytes, { flag: 'wx' }); await fs.rename(temp, target); }
      finally { await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
      file.sha256 = hash(bytes);
    }
    const instructions = await fs.readFile(path.join(directory, 'README.en.md'), 'utf8').catch(() => '');
    selected.version = instructions.match(/^#\s+DLSSG\s+(?:Native\s+)?(\d+\.\d+\.\d+)/mi)?.[1] || selected.version || '';
    return directory;
  }
  function ensurePackage(selected = pins) {
    if (!packagePending.has(selected.commit)) packagePending.set(selected.commit, downloadPackage(selected).finally(() => packagePending.delete(selected.commit)));
    return packagePending.get(selected.commit);
  }
  async function remove(root, receipt) {
    const owned = await ownedState(root, receipt);
    if (owned.changed.length) throw new Error('Installed files changed outside Librarian. Nothing was removed.');
    // Keep the receipt through partial removal, including sharing violations.
    for (const file of owned.files) if (file.actual) await fs.unlink(file.target);
    await fs.unlink(receiptPath(root));
  }
  async function setEnabled(game, enabled, selection, recheckIdle = () => {}) {
    if (typeof enabled !== 'boolean') throw new Error('Invalid frame generation switch value.');
    await loadActive();
    const selectedPins = pins;
    const root = await rootFor(game), key = root.toLowerCase();
    if (locks.has(key)) throw new Error('Frame generation is already being changed for this game.');
    locks.add(key);
    try {
      await ensureIdle(root); await recheckIdle();
      const receipt = await receiptFor(root);
      if (!enabled) { if (receipt) await remove(root, receipt); return { success: true, status: await status(game) }; }
      if (receipt) throw new Error('Remove the current frame generation installation before enabling again.');
      const before = await status(game, selection);
      if (!before.canEnable) throw new Error(before.reason);
      const source = await ensurePackage(selectedPins);
      // The download may take a minute: revalidate files, processes and launch/download locks.
      await ensureIdle(root); await recheckIdle();
      const current = await status(game, selection);
      if (!current.canEnable || current.selected !== before.selected) throw new Error(current.reason || 'The installation changed. Check again.');
      const record = { schema: 1, root, exe: current.selected, commit: selectedPins.commit, runtime: selectedPins.runtime, version: selectedPins.version || '', files: selectedPins.files.filter(f => f.deploy).map(({ name, sha256 }) => ({ name, sha256 })) };
      json.write(receiptPath(root), record, { backup: false });
      try {
        // INI first, executable proxy last. Never overwrite an existing file.
        for (const file of [...record.files].reverse()) {
          const target = await checkedPath(root, path.join(current.target, file.name));
          const bytes = await fs.readFile(path.join(source, file.name));
          if (hash(bytes) !== file.sha256) throw new Error('Cached package changed. Retry the download.');
          const temp = `${target}.librarian-${crypto.randomUUID()}.tmp`;
          try {
            const handle = await fs.open(temp, 'wx');
            try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
            // Atomic, exclusive publication on the same volume. A partial write
            // can never become a game DLL, even if Librarian loses power here.
            await fs.link(temp, target);
          } finally { await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
        }
      } catch (error) {
        try { await remove(root, record); }
        catch { throw new Error(`${explainError(error)} Use Remove incomplete installation to recover; files changed outside Librarian are preserved.`); }
        throw error;
      }
      return { success: true, status: await status(game, current.selected) };
    } finally { locks.delete(key); }
  }
  async function checkLaunch(game) {
    const root = await rootFor(game), receipt = await receiptFor(root);
    if (locks.has(root.toLowerCase())) throw new Error('Wait for frame generation to finish changing before launching this game.');
    if (receipt && !(await ownedState(root, receipt)).intact) throw new Error('DLSS Frame Generation files changed or are incomplete. Open this game’s Graphics tab and follow the recovery instructions before playing.');
    if (receipt) {
      const current = await status(game, receipt.exe);
      if (!current.compatible || current.issues.some(issue => issue.severity === 'error')) throw new Error(`DLSS Frame Generation requirements changed: ${current.reason} Disable it in this game’s Graphics section before playing.`);
    }
  }

  async function checkUpdates(games) {
    const selected = await upstream.check();
    if (!upstreamTools.validManifest(selected)) throw new Error('Invalid upstream DLSS FG package metadata.');
    candidates.set(selected.commit, selected);
    while (candidates.size > 4) candidates.delete(candidates.keys().next().value);
    const rows = [], seen = new Set();
    let unmanaged = 0;
    for (const game of games) {
      const row = { game: { id: game.id, appid: game.appid, source: game.source, game_key: game.game_key, install_path: game.install_path },
        name: game.game_name || game.name || 'Unnamed game', source: game.source || 'Library', state: 'blocked', reason: '' };
      try {
        const root = await rootFor(game), key = root.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const receipt = await receiptFor(root);
        if (!receipt) { unmanaged++; continue; }
        row.installedCommit = receipt.commit || '';
        if (game.unavailable) throw new Error('This installation is unavailable. Refresh the library after reconnecting its drive.');
        const owned = await ownedState(root, receipt);
        if (!owned.intact) throw new Error(owned.changed.length ? 'Managed files were modified. Restore them before updating; your changes were preserved.' : 'Recover the incomplete installation from this game’s Graphics tab first.');
        if (locks.has(key)) throw new Error('A graphics operation is already in progress for this game.');
        if (receipt.commit === selected.commit) row.state = 'current';
        else if (await upstream.isNewer(receipt.commit, selected.commit)) row.state = 'available';
        else throw new Error('The installed revision is newer or has a different history. Automatic downgrade is unavailable.');
      } catch (error) { row.reason = explainError(error); }
      rows.push(row);
    }
    return { release: { commit: selected.commit, version: selected.version, title: selected.title || '', date: selected.date || '', source: selected.repository },
      games: rows, unmanaged };
  }

  async function stageBytes(target, bytes) {
    const temp = `${target}.librarian-${crypto.randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, 'wx');
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      return temp;
    } catch (error) { await fs.unlink(temp).catch(() => {}); throw error; }
  }

  async function updateGame(game, commit, recheckIdle = () => {}) {
    const selected = candidates.get(commit);
    if (!selected) throw new Error('Check for DLSS FG updates again before applying this revision.');
    const root = await rootFor(game), key = root.toLowerCase();
    if (locks.has(key)) throw new Error('Frame generation is already being changed for this game.');
    locks.add(key);
    const staged = [];
    try {
      await ensureIdle(root); await recheckIdle();
      const previous = await receiptFor(root);
      if (!previous) throw new Error('DLSS FG is not managed by Librarian in this installation.');
      if (!(await ownedState(root, previous)).intact) throw new Error('The managed installation changed or is incomplete. Open its Graphics tab before updating.');
      if (previous.commit === commit) return { success: true, state: 'current' };
      if (!(await upstream.isNewer(previous.commit, commit))) throw new Error('This update would downgrade or replace a different revision history.');
      const before = await status(game, previous.exe);
      if (!before.compatible || before.issues.some(issue => issue.severity === 'error')) throw new Error(before.reason);
      const source = await ensurePackage(selected);
      await ensureIdle(root); await recheckIdle();
      if (!samePath(root, await rootFor(game))) throw new Error('The installation folder changed during the download.');
      const current = await status(game, previous.exe);
      if (!current.enabled || !current.compatible || current.issues.some(issue => issue.severity === 'error')
        || JSON.stringify(await receiptFor(root)) !== JSON.stringify(previous)) throw new Error(current.reason || 'The installation changed during the download. Check again.');
      const candidateProxyHash = selected.files.find(file => file.name === 'version.dll').sha256;
      for (const name of ['winmm.dll', 'dxgi.dll', 'd3d12.dll', 'dbghelp.dll', 'winhttp.dll', 'dinput8.dll']) {
        const target = await checkedPath(root, path.join(current.target, name));
        if (await fingerprint(target) === candidateProxyHash) throw new Error(`Another copy of the updated proxy is named ${name}. Use a single entry point before updating. Existing files were preserved.`);
      }
      const backup = path.join(dataPath(), 'backups', hash(key), crypto.randomUUID());
      await fs.mkdir(backup, { recursive: true });
      const originals = new Map();
      const nextFiles = ['version.dll', 'dlssg_sm86.ini'].map(name => ({ name, sha256: selected.files.find(file => file.name === name).sha256 }));
      for (const file of nextFiles) {
        const target = await checkedPath(root, path.join(current.target, file.name));
        const original = await fs.readFile(target);
        if (hash(original) !== previous.files.find(old => old.name === file.name).sha256) throw new Error('An installed file changed before backup.');
        originals.set(file.name, original);
        const saved = await fs.open(path.join(backup, file.name), 'wx');
        try { await saved.writeFile(original); await saved.sync(); } finally { await saved.close(); }
        const bytes = await fs.readFile(path.join(source, file.name));
        if (hash(bytes) !== file.sha256) throw new Error('The cached update changed. Check for updates again.');
        staged.push({ ...file, target, temp: await stageBytes(target, bytes) });
      }
      json.write(path.join(backup, 'receipt.json'), previous, { backup: false });
      const next = { schema: 1, root, exe: previous.exe, commit, runtime: selected.runtime, version: selected.version || '', files: nextFiles };
      // Persist both sets of owned hashes before touching the old files. After a
      // process crash, status and removal understand a partially replaced pair.
      json.write(receiptPath(root), { ...previous, update: { commit, files: nextFiles, backup } }, { backup: false });
      try {
        await ensureIdle(root); await recheckIdle();
        // Remove the old proxy first; publish the new proxy only after its INI.
        for (const file of staged) {
          await checkedPath(root, file.target);
          if (await fingerprint(file.target) !== previous.files.find(old => old.name === file.name).sha256) throw new Error('An installed file changed before replacement.');
          await fs.unlink(file.target);
        }
        for (const file of [...staged].reverse()) { await checkedPath(root, file.target); await fs.link(file.temp, file.target); }
        if (!(await ownedState(root, next)).intact) throw new Error('The updated files failed verification before the installation receipt could be committed.');
        json.write(receiptPath(root), next, { backup: false });
      } catch (error) {
        try {
          for (const file of staged) {
            await checkedPath(root, file.target);
            const actual = await fingerprint(file.target), oldHash = previous.files.find(old => old.name === file.name).sha256;
            if (actual === oldHash || !actual) continue;
            if (actual !== file.sha256) throw new Error('A file was changed by another program.');
            await fs.unlink(file.target);
          }
          for (const file of [...staged].reverse()) {
            await checkedPath(root, file.target);
            if (await fingerprint(file.target)) continue;
            const temp = await stageBytes(file.target, originals.get(file.name));
            try { await fs.link(temp, file.target); } finally { await fs.unlink(temp).catch(() => {}); }
          }
          if (!(await ownedState(root, previous)).intact) throw new Error('The previous package could not be restored completely.');
          json.write(receiptPath(root), previous, { backup: false });
        } catch {
          throw Object.assign(new Error(`${explainError(error)} The update is incomplete. Open the game’s Graphics tab to recover. Previous files are backed up at ${backup}.`), { code: 'DLSSG_UPDATE_RECOVERY' });
        }
        throw new Error(`${explainError(error)} The previous DLSS FG installation was restored.`);
      }
      // Only an explicit successful update opts future installations into this
      // verified revision. Opening Librarian or checking never changes it.
      let warning = '';
      try {
        if (!upstreamTools.validManifest(selected, true)) throw new Error('Invalid verified release metadata.');
        json.write(path.join(dataPath(), 'active-release.json'), selected, { backup: false });
        pins = selected; activeLoaded = true;
      } catch (error) { warning = `This game was updated, but the default package could not be saved: ${explainError(error)}`; }
      return { success: true, state: 'updated', commit, version: selected.version || '', backup, warning };
    } finally {
      for (const file of staged) await fs.unlink(file.temp).catch(() => {});
      locks.delete(key);
    }
  }
  return { status, setEnabled, ensurePackage, checkLaunch, checkUpdates, updateGame, explainError };
}

let manager;
module.exports = { createManager, probeHardware, scan, inspectPe, explainError,
  status: (...args) => (manager ||= createManager()).status(...args),
  checkUpdates: (...args) => (manager ||= createManager()).checkUpdates(...args),
  updateGame: (...args) => (manager ||= createManager()).updateGame(...args),
  checkLaunch: (...args) => (manager ||= createManager()).checkLaunch(...args),
  setEnabled: (...args) => (manager ||= createManager()).setEnabled(...args) };
