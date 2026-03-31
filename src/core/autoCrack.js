/**
 * Auto Crack Module — Wraps SteamAutoCrack.CLI as a subprocess
 * 
 * Uses the real Steam Auto Crack engine (C# CLI) which handles:
 * 1. EMUGameInfo — Fetch DLCs, achievements, stats from Steam
 * 2. EMUConfig — Generate Goldberg emulator configuration
 * 3. SteamStubUnpacker — Remove SteamStub DRM via bundled Steamless
 * 4. EMUApply — Replace steam_api DLLs with Goldberg emulator
 * 5. GenCrackOnly — Extract crack files for redistribution
 * 6. Restore — Undo everything
 * 
 * Also supports auto-downloading/updating Goldberg emulator from GitHub.
 */

const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Get the path to the SteamAutoCrack.CLI executable.
 */
function getSacCliPath() {
  return path.join(__dirname, '..', '..', 'deps', 'SteamAutoCrack', 'SteamAutoCrack.CLI.exe');
}

/**
 * Check if SAC CLI is available and Goldberg is downloaded.
 */
function checkSacStatus() {
  const cliPath = getSacCliPath();
  const sacDir = path.dirname(cliPath);
  
  const goldbergSacDir = path.join(sacDir, 'Goldberg');
  const goldbergLegacyDir = path.join(__dirname, '..', '..', 'deps', 'goldberg');

  // Auto-migrate legacy deps/goldberg to the new SAC location
  if (!fs.existsSync(goldbergSacDir) && fs.existsSync(goldbergLegacyDir)) {
    try {
      fs.cpSync(goldbergLegacyDir, goldbergSacDir, { recursive: true });
    } catch (e) {
      console.error('Failed to migrate legacy goldberg files:', e);
    }
  }

  const goldbergExists = fs.existsSync(goldbergSacDir) && 
      (fs.existsSync(path.join(goldbergSacDir, 'x32', 'steam_api.dll')) || 
       fs.existsSync(path.join(goldbergSacDir, 'x64', 'steam_api64.dll')) ||
       fs.existsSync(path.join(goldbergSacDir, 'steam_api.dll')));

  return {
    cliExists: fs.existsSync(cliPath),
    cliPath,
    goldbergExists,
    goldbergDir: goldbergSacDir,
    sacDir,
  };
}

/**
 * Run SAC CLI with arguments and stream output.
 * 
 * @param {string[]} args - CLI arguments
 * @param {Object} options
 * @param {Function} options.onLog - Log callback (line) => void
 * @param {string} options.cwd - Working directory
 * @returns {Promise<{success: boolean, exitCode: number, output: string[]}>}
 */
function runSacCli(args, options = {}) {
  const { onLog = () => {}, cwd } = options;
  const cliPath = getSacCliPath();

  return new Promise((resolve, reject) => {
    if (!fs.existsSync(cliPath)) {
      reject(new Error(`SteamAutoCrack.CLI not found at: ${cliPath}`));
      return;
    }

    const output = [];
    const proc = spawn(cliPath, args, {
      cwd: cwd || path.dirname(cliPath),
      windowsHide: true,
    });

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split(/\r?\n/).filter(l => l.trim());
      for (const line of lines) {
        output.push(line);
        onLog(line);
      }
    });

    proc.stderr.on('data', (data) => {
      const lines = data.toString().split(/\r?\n/).filter(l => l.trim());
      for (const line of lines) {
        output.push(`[ERR] ${line}`);
        onLog(`[ERR] ${line}`);
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });

    proc.on('close', (code) => {
      resolve({ success: code === 0, exitCode: code, output });
    });
  });
}

/**
 * Download/update Goldberg emulator using SAC's built-in updater.
 * SAC CLI command: `downloademu [--force]`
 */
async function downloadGoldberg(options = {}) {
  const { onLog = () => {}, force = false } = options;

  onLog('🔄 Downloading Goldberg Steam Emulator...');
  const args = ['downloademu'];
  if (force) args.push('--force');

  return runSacCli(args, { onLog });
}

/**
 * Crack a game using the full SAC pipeline.
 * SAC CLI command: `crack <path> --appid <id>`
 * 
 * @param {Object} options
 * @param {string} options.gamePath - Path to the game directory
 * @param {string} options.appId - Steam AppID
 * @param {Function} options.onLog - Log callback
 */
async function crackGame(options = {}) {
  const { gamePath, appId, onLog = () => {} } = options;

  if (!gamePath || !fs.existsSync(gamePath)) {
    return { success: false, error: 'Invalid game path' };
  }
  if (!appId) {
    return { success: false, error: 'AppID is required' };
  }

  onLog(`🔧 Cracking game at: ${gamePath}`);
  onLog(`   AppID: ${appId}`);

  // First ensure config.json exists with sane defaults
  const sacDir = path.dirname(getSacCliPath());
  const configPath = path.join(sacDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    onLog('📝 Creating default config...');
    await runSacCli(['createconfig'], { onLog, cwd: sacDir });
  }

  // Run the crack command
  const args = ['crack', gamePath, '--appid', appId];
  return runSacCli(args, { onLog, cwd: sacDir });
}

/**
 * Restore cracked game to original state.
 * We create a temporary config that only enables Restore, then run crack.
 */
async function restoreGame(gamePath, onLog = () => {}) {
  if (!gamePath || !fs.existsSync(gamePath)) {
    return { success: false, error: 'Invalid game path' };
  }

  onLog(`↩️ Restoring original files at: ${gamePath}`);

  const sacDir = path.dirname(getSacCliPath());
  
  // Create a restore-only config
  const restoreConfig = {
    ProcessConfigs: {
      GenerateEMUGameInfo: false,
      GenerateEMUConfig: false,
      Unpack: false,
      ApplyEMU: false,
      GenerateCrackOnly: false,
      Restore: true,
    },
  };

  const configPath = path.join(sacDir, 'restore_config.json');
  fs.writeFileSync(configPath, JSON.stringify(restoreConfig, null, 2), 'utf-8');

  const result = await runSacCli(
    ['crack', gamePath, '--config', configPath],
    { onLog, cwd: sacDir }
  );

  // Clean up temp config
  try { fs.unlinkSync(configPath); } catch {}

  return result;
}

/**
 * Generate crack-only files (for redistribution).
 */
async function generateCrackOnly(gamePath, outputPath, onLog = () => {}) {
  onLog(`📦 Generating crack-only files...`);
  onLog(`   Source: ${gamePath}`);
  onLog(`   Output: ${outputPath}`);

  const sacDir = path.dirname(getSacCliPath());

  // Create a crack-only config
  const config = {
    ProcessConfigs: {
      GenerateEMUGameInfo: false,
      GenerateEMUConfig: false,
      Unpack: false,
      ApplyEMU: false,
      GenerateCrackOnly: true,
      Restore: false,
    },
    GenCrackOnlyConfigs: {
      OutputPath: outputPath,
      CreateReadme: true,
      Pack: true,
    },
  };

  const configPath = path.join(sacDir, 'crackonly_config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  const result = await runSacCli(
    ['crack', gamePath, '--config', configPath],
    { onLog, cwd: sacDir }
  );

  try { fs.unlinkSync(configPath); } catch {}
  return result;
}

/**
 * Scan a game directory for steam_api DLLs (quick JS-based scan, no CLI needed).
 */
function scanGameDirectory(gamePath) {
  const result = {
    gamePath,
    executables: [],
    steamApiFiles: [],
    hasSteamApi: false,
    hasSteamApi64: false,
    detectedAppId: '',
    detectedName: ''
  };

  // 1) Quick top-level check for steam_appid.txt or .url or .acf
  try {
    const topFiles = fs.readdirSync(gamePath);
    for (const f of topFiles) {
      const lower = f.toLowerCase();
      const fp = path.join(gamePath, f);
      
      if (lower === 'steam_appid.txt' && !result.detectedAppId) {
        result.detectedAppId = fs.readFileSync(fp, 'utf-8').trim();
      } else if (lower.endsWith('.url') && !result.detectedAppId) {
        const urlContent = fs.readFileSync(fp, 'utf-8');
        const match = urlContent.match(/steam:\/\/rungameid\/(\d+)/i);
        if (match) result.detectedAppId = match[1];
      } else if (lower.startsWith('appmanifest_') && lower.endsWith('.acf') && !result.detectedAppId) {
        const acfContent = fs.readFileSync(fp, 'utf-8');
        const idMatch = acfContent.match(/"appid"\s+"(\d+)"/i);
        const nameMatch = acfContent.match(/"name"\s+"([^"]+)"/i);
        if (idMatch) result.detectedAppId = idMatch[1];
        if (nameMatch) result.detectedName = nameMatch[1];
      }
    }
    
    // Fallback: guess name from folder name if not found in ACF
    if (!result.detectedName) {
      result.detectedName = path.basename(gamePath).replace(/_/g, ' ');
    }
  } catch {}

  function walkDir(dir, depth = 0) {
    if (depth > 5) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const skip = ['__pycache__', 'node_modules', '.git', 'redist', 'directx', '_commonredist'];
          if (!skip.includes(entry.name.toLowerCase())) walkDir(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const lower = entry.name.toLowerCase();
          if (lower === 'steam_api.dll') {
            result.steamApiFiles.push({ file: fullPath, dir, is64: false, name: entry.name });
            result.hasSteamApi = true;
          } else if (lower === 'steam_api64.dll') {
            result.steamApiFiles.push({ file: fullPath, dir, is64: true, name: entry.name });
            result.hasSteamApi64 = true;
          } else if (lower.endsWith('.exe') && !lower.includes('unins') && !lower.includes('setup') && !lower.includes('redist')) {
            result.executables.push({ file: fullPath, dir, name: entry.name });
          }
        }
      }
    } catch {}
  }

  walkDir(gamePath);
  return result;
}

module.exports = {
  checkSacStatus,
  downloadGoldberg,
  crackGame,
  restoreGame,
  generateCrackOnly,
  scanGameDirectory,
};
