const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function formatTransferSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 B/s';

  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
  let value = bytesPerSecond;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function startDepotDownload(gameData, selectedDepots, destPath, callbacks) {
  const { onProgress, onPercentage, onSpeed, onComplete, onError } = callbacks;

  const tempDir = os.tmpdir();
  const keysPath = path.join(tempDir, 'mistwalker_keys.vdf');
  const manifestDir = path.join(tempDir, 'mistwalker_manifests');

  // Generate depot keys file
  const keyLines = [];
  for (const depotId of selectedDepots) {
    if (gameData.depots[depotId]) {
      keyLines.push(`${depotId};${gameData.depots[depotId].key}`);
    }
  }
  fs.writeFileSync(keysPath, keyLines.join('\n'));

  // Determine install folder
  const safeName = (gameData.game_name || '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_');
  const installFolder = gameData.installdir || safeName || `App_${gameData.appid}`;
  const downloadDir = path.join(destPath, 'steamapps', 'common', installFolder);
  fs.mkdirSync(downloadDir, { recursive: true });

  // Build commands for each depot
  const exeName = process.platform === 'win32'
    ? path.join(__dirname, '..', '..', 'deps', 'DepotDownloaderMod.exe')
    : path.join(__dirname, '..', '..', 'deps', 'DepotDownloaderMod');

  const commands = [];
  const depotSizes = [];
  const skipped = [];

  for (const depotId of selectedDepots) {
    const manifestId = (gameData.manifests || {})[depotId];
    if (!manifestId) { skipped.push(depotId); continue; }

    let size = 0;
    try { size = parseInt(gameData.depots[depotId]?.size || '0') || 0; } catch {}
    depotSizes.push(size);

    const manifestFile = path.join(manifestDir, `${depotId}_${manifestId}.manifest`);
    commands.push([
      exeName,
      '-app', gameData.appid,
      '-depot', String(depotId),
      '-manifest', manifestId,
      '-manifestfile', manifestFile,
      '-depotkeys', keysPath,
      '-max-downloads', '8',
      '-dir', downloadDir,
      '-validate',
    ]);
  }

  if (!commands.length) {
    onProgress('No valid download commands to execute.');
    onComplete();
    return null;
  }

  const totalSize = depotSizes.reduce((a, b) => a + b, 0);
  let completedSize = 0;
  const percentRegex = /(\d{1,3}\.\d{2})%/;
  const fileProgressRegex = /^(\d{1,3}\.\d{2})%\s+(.+)$/;
  const speedRegex = /(\d+(?:\.\d+)?)\s*((?:[KMGT]i?B)|B)\/s\b/i;
  let stopped = false;
  let currentProcess = null;
  let isPaused = false;
  let lastPercent = 0;
  let currentDepotTrackedBytes = 0;
  let currentDepotFileProgress = new Map();

  // Rolling speed tracker — accumulates bytes over a window for smooth readings
  let speedSamples = []; // { time, totalBytes }
  const SPEED_WINDOW_MS = 2000;
  let lastSpeedEmitAt = 0;
  const SPEED_EMIT_INTERVAL = 800; // emit speed at most every 800ms

  function emitPercentage(pct) {
    const safePct = Math.max(lastPercent, Math.min(100, Math.round(pct)));
    lastPercent = safePct;
    onPercentage(safePct);
  }

  function resetDepotTracking() {
    currentDepotTrackedBytes = 0;
    currentDepotFileProgress = new Map();
    speedSamples = [];
    lastSpeedEmitAt = 0;
  }

  function emitSmoothedSpeed() {
    const now = Date.now();
    if (now - lastSpeedEmitAt < SPEED_EMIT_INTERVAL) return;

    const totalTracked = completedSize + currentDepotTrackedBytes;
    speedSamples.push({ time: now, totalBytes: totalTracked });

    // Prune old samples outside window
    while (speedSamples.length > 1 && now - speedSamples[0].time > SPEED_WINDOW_MS) {
      speedSamples.shift();
    }

    if (speedSamples.length >= 2) {
      const oldest = speedSamples[0];
      const newest = speedSamples[speedSamples.length - 1];
      const deltaBytes = newest.totalBytes - oldest.totalBytes;
      const deltaSeconds = (newest.time - oldest.time) / 1000;
      if (deltaBytes > 0 && deltaSeconds > 0.1) {
        const bytesPerSecond = deltaBytes / deltaSeconds;
        if (onSpeed) onSpeed(formatTransferSpeed(bytesPerSecond));
        lastSpeedEmitAt = now;
      }
    }
  }

  function updateTrackedProgress(progressBytes) {
    currentDepotTrackedBytes = Math.max(currentDepotTrackedBytes, progressBytes);

    if (totalSize > 0) {
      emitPercentage(((completedSize + currentDepotTrackedBytes) / totalSize) * 100);
    }

    emitSmoothedSpeed();
  }

  function trackFileProgress(trimmed, downloadDir) {
    const match = trimmed.match(fileProgressRegex);
    if (!match) return;

    const pct = parseFloat(match[1]);
    let filePath = match[2].trim();
    if (!filePath) return;

    // Resolve relative paths against downloadDir
    if (!path.isAbsolute(filePath)) {
      filePath = path.join(downloadDir, filePath);
    }

    let fileSize = 0;
    try {
      fileSize = fs.statSync(filePath).size;
    } catch {
      return;
    }

    if (!fileSize) return;

    const previousPct = currentDepotFileProgress.get(filePath) || 0;
    const nextPct = Math.max(previousPct, Math.min(100, pct));
    if (nextPct <= previousPct) return;

    currentDepotFileProgress.set(filePath, nextPct);
    const deltaBytes = ((nextPct - previousPct) / 100) * fileSize;
    updateTrackedProgress(currentDepotTrackedBytes + deltaBytes);
  }

  function handleProcessLine(line, currentSize, downloadDir) {
    const trimmed = line.trim();
    if (!trimmed) return;

    onProgress(trimmed);
    trackFileProgress(trimmed, downloadDir);

    // Explicit speed from DepotDownloader output
    const speedMatch = trimmed.match(speedRegex);
    if (speedMatch && onSpeed) {
      const val = parseFloat(speedMatch[1]);
      const unit = speedMatch[2].toUpperCase().replace('I', '');
      let bytes = val;
      if (unit.startsWith('K')) bytes *= 1024;
      else if (unit.startsWith('M')) bytes *= 1024 * 1024;
      else if (unit.startsWith('G')) bytes *= 1024 * 1024 * 1024;
      else if (unit.startsWith('T')) bytes *= 1024 * 1024 * 1024 * 1024;
      onSpeed(formatTransferSpeed(bytes));
      lastSpeedEmitAt = Date.now();
    }

    // Percentage from the tool's own output
    const match = trimmed.match(percentRegex);
    if (match) {
      const pct = parseFloat(match[1]);
      if (totalSize > 0) {
        const progress = completedSize + (pct / 100) * currentSize;
        emitPercentage((progress / totalSize) * 100);
      } else {
        emitPercentage(pct);
      }
    }
  }

  function processBufferedOutput(chunk, currentSize, buffer, downloadDir) {
    const merged = `${buffer}${chunk.toString()}`;
    const parts = merged.split(/\r\n|\n|\r/g);
    const remainder = parts.pop() || '';

    for (const part of parts) {
      handleProcessLine(part, currentSize, downloadDir);
    }

    return remainder;
  }

  async function runSequential() {
    // Inject Depot Decryption Keys into config.vdf for GreenLuma/SLS mode BEFORE download starts
    const { get, getAll } = require('./settingsStore');
    const slsMode = get('slssteam_mode');
    onProgress(`[DEBUG] Loaded slssteam_mode: ${slsMode} | All settings: ${JSON.stringify(getAll())}`);
    
    if (slsMode) {
      onProgress('=== GreenLuma / SLSsteam Integration ===');
      try {
        injectDepotKeysIntoConfig(gameData, selectedDepots);
        onProgress('Injected depot keys into Steam config.vdf successfully.');
        
        // Also generate the GreenLuma AppList file
        const { addGreenLumaFiles } = require('./gameManager');
        addGreenLumaFiles(gameData.appid, selectedDepots);
        onProgress(`Generated GreenLuma AppList files for app ${gameData.appid} and its depots.`);
      } catch (e) {
        onProgress(`Warning: Could not inject GreenLuma files: ${e.message}`);
      }
      onProgress('==========================================');
    }

    for (let i = 0; i < commands.length; i++) {
      if (stopped) break;

      const cmd = commands[i];
      const depotId = cmd[4]; // -depot value
      const currentSize = depotSizes[i];
      resetDepotTracking();

      onProgress(`--- Downloading depot ${depotId} (${i + 1}/${commands.length}) ---`);

      const maxRetries = 5;
      let attempt = 0;
      let success = false;

      while (!success && attempt < maxRetries && !stopped) {
        attempt++;
        if (attempt > 1) {
          onProgress(`--- Retrying depot ${depotId} (Attempt ${attempt}/${maxRetries}) ---`);
          // Brief pause before retry
          await new Promise(r => setTimeout(r, 2000));
        }

        await new Promise((resolve, reject) => {
          const opts = { stdio: ['ignore', 'pipe', 'pipe'] };
          if (process.platform === 'win32') opts.windowsHide = true;
          let stdoutBuffer = '';
          let stderrBuffer = '';

          currentProcess = spawn(cmd[0], cmd.slice(1), opts);
          isPaused = false;

          currentProcess.stdout.on('data', (data) => {
            stdoutBuffer = processBufferedOutput(data, currentSize, stdoutBuffer, downloadDir);
          });

          currentProcess.stderr.on('data', (data) => {
            stderrBuffer = processBufferedOutput(data, currentSize, stderrBuffer, downloadDir);
          });

          currentProcess.on('close', (code) => {
            if (stdoutBuffer) handleProcessLine(stdoutBuffer, currentSize, downloadDir);
            if (stderrBuffer) handleProcessLine(stderrBuffer, currentSize, downloadDir);
            if (code === 0) {
              success = true;
              completedSize += currentSize;
              if (totalSize > 0) emitPercentage((completedSize / totalSize) * 100);
            } else if (stopped) {
              onProgress(`Download stopped by user.`);
            } else {
              onProgress(`Warning: DepotDownloaderMod exited with code ${code} for depot ${depotId}`);
            }
            currentProcess = null;
            resolve();
          });

          currentProcess.on('error', (err) => {
            currentProcess = null;
            if (!stopped) onProgress(`Error starting process: ${err.message}`);
            resolve();
          });
        });
      }

      if (!success && !stopped) {
        throw new Error(`Failed to download depot ${depotId} after ${maxRetries} attempts.`);
      }
    }

    // Generate ACF file
    try {
      generateAcfFile(gameData, selectedDepots, destPath, installFolder, totalSize);
      onProgress('Generated .acf manifest file.');
    } catch (e) {
      onProgress(`Warning: Could not generate .acf file: ${e.message}`);
    }

    // Move manifests to depotcache
    try {
      moveManifestsToDepotcache(gameData, destPath);
    } catch (e) {
      onProgress(`Warning: Could not move manifests: ${e.message}`);
    }

    // Cleanup temp keys file
    try { if (fs.existsSync(keysPath)) fs.unlinkSync(keysPath); } catch {}

    // ─── Auto-Crack if enabled ──────────────────────────────
    try {
      const settingsStore = require('./settingsStore');
      const autoCrackEnabled = settingsStore.get('auto_crack');
      if (autoCrackEnabled) {
        onProgress('');
        onProgress('═══════════════════════════════════════════');
        onProgress('🔧 AUTO-CRACK: Starting post-download crack...');
        onProgress('═══════════════════════════════════════════');

        const { crackGame, checkSacStatus } = require('./autoCrack');
        const sacStatus = checkSacStatus();

        if (!sacStatus.cliExists) {
          onProgress('⚠️ AUTO-CRACK: SteamAutoCrack.CLI not found — skipping.');
        } else if (!sacStatus.goldbergExists) {
          onProgress('⚠️ AUTO-CRACK: Goldberg emulator not downloaded — skipping.');
          onProgress('   Go to Settings → Auto Crack to download it first.');
        } else {
          onProgress(`🎮 Cracking: ${gameData.game_name || 'Unknown'} (AppID: ${gameData.appid})`);
          onProgress(`📂 Path: ${downloadDir}`);

          const crackResult = await crackGame({
            gamePath: downloadDir,
            appId: String(gameData.appid),
            onLog: (msg) => onProgress(`   [CRACK] ${msg}`),
          });

          if (crackResult.success) {
            onProgress('✅ AUTO-CRACK: Game cracked successfully!');
          } else {
            onProgress(`❌ AUTO-CRACK: Failed (exit code ${crackResult.exitCode})`);
            if (crackResult.error) onProgress(`   Error: ${crackResult.error}`);
          }
        }
        onProgress('═══════════════════════════════════════════');
      }
    } catch (e) {
      onProgress(`⚠️ AUTO-CRACK error: ${e.message}`);
    }

    if (totalSize > 0) emitPercentage(100);
    onComplete();
  }

  runSequential().catch((err) => {
    onError(err.message);
  });

  return {
    get process() { return currentProcess; },
    get stopped() { return stopped; },
    markPaused() { isPaused = true; },
    markResumed() {
      isPaused = false;
      speedSamples = [];
      lastSpeedEmitAt = 0;
    },
    stop() { stopped = true; if (currentProcess) currentProcess.kill(); },
  };
}

function generateAcfFile(gameData, selectedDepots, destPath, installFolder, sizeOnDisk) {
  const acfDir = path.join(destPath, 'steamapps');
  fs.mkdirSync(acfDir, { recursive: true });
  const acfPath = path.join(acfDir, `appmanifest_${gameData.appid}.acf`);

  let depots = '';
  if (process.platform === 'win32') {
    for (const depotId of selectedDepots) {
      const manifestId = (gameData.manifests || {})[String(depotId)];
      const depotInfo = (gameData.depots || {})[String(depotId)] || {};
      const depotSize = depotInfo.size || '0';
      if (manifestId) {
        depots += `\t\t"${depotId}"\n\t\t{\n\t\t\t"manifest"\t\t"${manifestId}"\n\t\t\t"size"\t\t"${depotSize}"\n\t\t}\n`;
      }
    }
  }

  const installedDepots = depots
    ? `\t"InstalledDepots"\n\t{\n${depots}\t}`
    : `\t"InstalledDepots"\n\t{\n\t}`;

  const content = `"AppState"\n{\n\t"appid"\t\t"${gameData.appid}"\n\t"Universe"\t\t"1"\n\t"name"\t\t"${gameData.game_name}"\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"${installFolder}"\n\t"SizeOnDisk"\t\t"${sizeOnDisk}"\n\t"buildid"\t\t"${gameData.buildid || '0'}"\n${installedDepots}\n\t"UserConfig"\n\t{\n\t}\n\t"MountedConfig"\n\t{\n\t}\n}`;

  fs.writeFileSync(acfPath, content, 'utf-8');
}

function moveManifestsToDepotcache(gameData, destPath) {
  const tempManifestDir = path.join(os.tmpdir(), 'mistwalker_manifests');
  if (!fs.existsSync(tempManifestDir)) return;

  const depotcache = path.join(destPath, 'depotcache');
  fs.mkdirSync(depotcache, { recursive: true });

  const manifests = gameData.manifests || {};
  for (const [depotId, manifestGid] of Object.entries(manifests)) {
    const filename = `${depotId}_${manifestGid}.manifest`;
    const src = path.join(tempManifestDir, filename);
    const dst = path.join(depotcache, filename);
    if (fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, dst);
        fs.unlinkSync(src);
      } catch (err) {
        console.error(`Failed to move manifest ${filename}:`, err);
      }
    }
  }

  try { fs.rmSync(tempManifestDir, { recursive: true, force: true }); } catch {}
}

function pauseDownload(handle) {
  // On Windows, we can't easily suspend a process from Node without native bindings
  // This is a best-effort approach
  if (handle && handle.process && handle.process.pid) {
    if (typeof handle.markPaused === 'function') handle.markPaused();
    try {
      process.kill(handle.process.pid, 'SIGSTOP');
    } catch {}
  }
}

function resumeDownload(handle) {
  if (handle && handle.process && handle.process.pid) {
    if (typeof handle.markResumed === 'function') handle.markResumed();
    try {
      process.kill(handle.process.pid, 'SIGCONT');
    } catch {}
  }
}

function cancelDownload(handle) {
  if (handle) handle.stop();
}

function injectDepotKeysIntoConfig(gameData, selectedDepots) {
  const { findSteamInstall } = require('./steamHelpers');
  const steamPath = findSteamInstall();
  if (!steamPath) return;

  const configPath = path.join(steamPath, 'config', 'config.vdf');
  if (!fs.existsSync(configPath)) return;

  let content = fs.readFileSync(configPath, 'utf-8');
  
  // Find where "depots" node is located under "Software" -> "Valve" -> "Steam"
  // It's usually near the top, but we'll use a regex to find the exact block.
  const depotsMatch = content.match(/"Software"\s*\{\s*"Valve"\s*\{\s*"Steam"\s*\{[\s\S]*?"depots"\s*\{/i);

  if (!depotsMatch) {
    console.log('[injectDepotKeysIntoConfig] Could not find "depots" node in config.vdf. Skipping injection.');
    return;
  }

  const insertionIndex = depotsMatch.index + depotsMatch[0].length;
  
  // Build the block of keys to inject
  let keysBlock = '\n';
  for (const depotId of selectedDepots) {
    const key = gameData.depots[depotId]?.key;
    if (!key) continue;

    // Only inject if this depot ID isn't already inside the config
    // (A rough check to avoid duplicating entries)
    const depotRegex = new RegExp(`"${depotId}"\\s*\\{[^}]*"DecryptionKey"[^}]*\\}`, 'i');
    if (!depotRegex.test(content)) {
      keysBlock += `\t\t\t\t"${depotId}"\n\t\t\t\t{\n\t\t\t\t\t"DecryptionKey"\t\t"${key}"\n\t\t\t\t}\n`;
    }
  }

  if (keysBlock.trim() !== '') {
    // Inject right after the opening brace of "depots" {
    content = content.slice(0, insertionIndex) + keysBlock + content.slice(insertionIndex);
    fs.writeFileSync(configPath, content, 'utf-8');
  }
}

module.exports = { startDepotDownload, pauseDownload, resumeDownload, cancelDownload };
