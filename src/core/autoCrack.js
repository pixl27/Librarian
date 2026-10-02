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
const { getDepsPath } = require('./runtimePaths');

/**
 * Get the path to the SteamAutoCrack.CLI executable.
 */
function getSacCliPath() {
  return getDepsPath('SteamAutoCrack', 'SteamAutoCrack.CLI.exe');
}

/**
 * Check if SAC CLI is available and Goldberg is downloaded.
 */
// The exact four files SteamAutoCrack's own EMUApply.CheckGoldberg() requires.
// It checks these literal paths and refuses to run if any is missing, so this
// list is the only definition of "Goldberg is usable" that matters.
const GOLDBERG_REQUIRED = [
  { target: ['x64'], dll: 'steam_api64.dll', sources: [['regular', 'x64'], ['release', 'regular', 'x64'], ['release', 'x64']] },
  { target: ['x32'], dll: 'steam_api.dll', sources: [['regular', 'x86'], ['release', 'regular', 'x86'], ['regular', 'x32'], ['x86'], ['release', 'x86']] },
  { target: ['experimental', 'x64'], dll: 'steam_api64.dll', sources: [['release', 'experimental', 'x64']] },
  { target: ['experimental', 'x32'], dll: 'steam_api.dll', sources: [['experimental', 'x86'], ['release', 'experimental', 'x86']] },
];

/** Every path SAC insists on is present. */
function goldbergUsable(goldbergDir) {
  return GOLDBERG_REQUIRED.every(req =>
    fs.existsSync(path.join(goldbergDir, ...req.target, req.dll)));
}

/** Any Goldberg payload at all, however it is arranged. */
function goldbergDownloaded(dir, depth = 0) {
  if (depth > 3) return false;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && /^steam_api(64)?\.dll$/i.test(entry.name)) return true;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && goldbergDownloaded(path.join(dir, entry.name), depth + 1)) return true;
  }
  return false;
}

/**
 * Reshape a downloaded Goldberg into the layout SteamAutoCrack expects.
 *
 * Goldberg's releases moved the 32-bit build from `x32/` to `x86/` and pushed
 * the regular build down into `regular/`. SAC still probes the old paths, so a
 * current download makes it throw "Goldberg emulator file missing" even though
 * the emulator is right there. Copying (never moving) the DLLs into the paths
 * SAC checks fixes that while leaving the original tree intact for SAC's own
 * updater.
 *
 * @returns {boolean} true when something was copied.
 */
function normalizeGoldbergLayout(goldbergDir) {
  if (!goldbergDir || !fs.existsSync(goldbergDir)) return false;

  let changed = false;
  for (const req of GOLDBERG_REQUIRED) {
    const targetDir = path.join(goldbergDir, ...req.target);
    if (fs.existsSync(path.join(targetDir, req.dll))) continue;

    for (const segments of req.sources) {
      const sourceDir = path.join(goldbergDir, ...segments);
      if (sourceDir === targetDir) continue;
      if (!fs.existsSync(path.join(sourceDir, req.dll))) continue;
      try {
        fs.mkdirSync(targetDir, { recursive: true });
        // force:false keeps anything already in place; this is idempotent.
        fs.cpSync(sourceDir, targetDir, { recursive: true, force: false, errorOnExist: false });
        changed = true;
      } catch (e) {
        console.error(`Failed to normalize Goldberg ${req.target.join('/')}:`, e.message);
      }
      break;
    }
  }
  return changed;
}

/**
 * Whether a folder holds an emulator SteamAutoCrack can use, after the layout
 * has been reshaped. The updater in emuCompat.js asks this about a freshly
 * extracted release before it is allowed to replace the installed one.
 */
function goldbergFolderUsable(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  normalizeGoldbergLayout(dir);
  return goldbergUsable(dir);
}

function checkSacStatus() {
  const cliPath = getSacCliPath();
  const sacDir = path.dirname(cliPath);
  
  const goldbergSacDir = path.join(sacDir, 'Goldberg');
  const goldbergLegacyDir = getDepsPath('goldberg');

  // Auto-migrate legacy deps/goldberg to the new SAC location
  if (!fs.existsSync(goldbergSacDir) && fs.existsSync(goldbergLegacyDir)) {
    try {
      fs.cpSync(goldbergLegacyDir, goldbergSacDir, { recursive: true });
    } catch (e) {
      console.error('Failed to migrate legacy goldberg files:', e);
    }
  }

  // Reshape a current-layout download into the paths SAC probes, then report
  // exactly what SAC will conclude — reporting "ready" on anything looser just
  // moves the failure to the middle of a crack run.
  normalizeGoldbergLayout(goldbergSacDir);

  const present = fs.existsSync(goldbergSacDir) && goldbergDownloaded(goldbergSacDir);
  const goldbergExists = fs.existsSync(goldbergSacDir) && goldbergUsable(goldbergSacDir);

  return {
    cliExists: fs.existsSync(cliPath),
    cliPath,
    goldbergExists,
    // Downloaded but unusable: re-downloading will not help, so the bootstrap
    // can say so rather than fetching 188 MB again on every launch.
    goldbergPresent: present,
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
      // SAC catches its own exceptions, logs them and still exits 0, so the exit
      // code alone reported a failed crack as "complete". Treat a logged
      // pipeline abort as failure too.
      const text = output.join('\n');
      const failed = /\[ERR\]\s*\[Processor\]\s*Failed to process|Goldberg emulator file missing|System\.Exception:/i.test(text);
      const errorLine = failed
        ? (text.match(/System\.Exception:\s*(.+)/)?.[1]
          || text.match(/\[ERR\][^\n]*/)?.[0]
          || 'SteamAutoCrack reported a failure.').trim()
        : null;
      resolve({ success: code === 0 && !failed, exitCode: code, output, error: errorLine });
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
/**
 * The App ID Steam itself records for an installed folder.
 *
 * A game at `<library>/steamapps/common/<dir>` has its manifest one level up
 * and over, at `<library>/steamapps/appmanifest_<id>.acf` — the one whose
 * `installdir` is `<dir>`. analyzeGame only ever looked *inside* the game
 * folder, where that file never lives, so nothing could contradict a wrong id.
 *
 * @returns {{appId: string, name: string}|null}
 */
function appIdFromLibraryManifest(gamePath) {
  try {
    const dirName = path.basename(path.resolve(gamePath));
    const steamapps = path.resolve(gamePath, '..', '..');
    if (path.basename(steamapps).toLowerCase() !== 'steamapps') return null;

    for (const entry of fs.readdirSync(steamapps)) {
      if (!/^appmanifest_\d+\.acf$/i.test(entry)) continue;
      let content;
      try { content = fs.readFileSync(path.join(steamapps, entry), 'utf-8'); } catch { continue; }
      const installDir = content.match(/"installdir"\s+"([^"]+)"/i);
      if (!installDir || installDir[1].toLowerCase() !== dirName.toLowerCase()) continue;
      const id = content.match(/"appid"\s+"(\d+)"/i);
      if (!id) continue;
      const name = content.match(/"name"\s+"([^"]+)"/i);
      return { appId: id[1], name: name ? name[1] : '' };
    }
  } catch { /* best effort — never block a crack over this */ }
  return null;
}

// ─── Stale emulator backups ───────────────────────────────────────
// SteamAutoCrack will not apply the emulator when a `.bak` already sits beside
// the library, and then reports success anyway. That is right the first time:
// it stops a second crack from filing a copy of Goldberg away as "the
// original". It is wrong after an update, where the download has just restored
// the game's own steam_api64 from the depot and the old backup is still there.
// The crack is skipped, the launcher logs "Auto-crack complete", and the game
// runs with no emulator at all.
//
// Measured on Mortal Shell II: three days of play and not one achievement
// recorded, because the library it loaded was Valve's.
//
// Clearing that backup costs nothing — the live file *is* the original at that
// point, and ApplyEMU copies it aside again on its way past. What it must never
// do is disturb a game the user deliberately put online, or one whose emulator
// is still in place.
const STEAM_API_DLL = /^steam_api(64)?\.dll$/i;

// Every genuine steam_api64 across this machine's twenty libraries measures
// between 140 KB and 320 KB; emulators are megabytes. The margin is wide on
// purpose — this only decides whether the export table is worth reading.
const GENUINE_MAX_BYTES = 1024 * 1024;

// The emulator's steam_api and steamclient are one binary, so it exports names
// Valve keeps in steamclient64.dll. A steam_api that has them is not Valve's.
const EMULATOR_EXPORTS = [
  'Steam_RegisterInterfaceFuncs',
  'Steam_RunCallbacks',
  'Steam_GetHSteamUserCurrent',
];

// Written by onlineMode when the user switches a game online. That choice
// outranks any re-crack, so it is read here rather than guessed from files.
const ONLINE_STATE = path.join('.DepotDownloader', 'online-mode.json');
const EMU_ASIDE_SUFFIX = '.goldberg';

function wantsOnline(gamePath) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(gamePath, ONLINE_STATE), 'utf-8'));
    return !!state && state.mode === 'online';
  } catch {
    return false;
  }
}

function findSteamApiDlls(root, depth = 0, out = []) {
  if (depth > 8) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) findSteamApiDlls(full, depth + 1, out);
    else if (STEAM_API_DLL.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * True when this file is the library the game shipped with — not an emulator,
 * not one of our own proxies. Anything unreadable answers false: the point is
 * to act only when we are sure.
 */
function isGameOwnLibrary(dll) {
  try {
    if (fs.statSync(dll).size > GENUINE_MAX_BYTES) return false;
  } catch { return false; }

  // Our online proxy keeps the real library renamed beside it; clearing a
  // backup underneath that would strand the game.
  if (fs.existsSync(dll.replace(/\.dll$/i, '_o.dll'))) return false;

  const names = exportNames(dll);
  return Boolean(names) && !EMULATOR_EXPORTS.some((name) => names.has(name));
}

/** The file's export names, or null when it does not parse as a PE at all. */
function exportNames(dll) {
  try {
    const { readExports } = require('../../tools/peExports');
    return new Set(readExports(dll).exports.map((e) => e.name || e));
  } catch {
    return null;
  }
}

function clearStaleBackups(gamePath, onLog = () => {}) {
  if (wantsOnline(gamePath)) {
    onLog('↩ This game is set to online mode — its Steam library is left alone.');
    return 0;
  }

  let cleared = 0;
  for (const dll of findSteamApiDlls(gamePath)) {
    const backup = `${dll}.bak`;
    if (!fs.existsSync(backup)) continue;                    // nothing in the way
    if (fs.existsSync(dll + EMU_ASIDE_SUFFIX)) continue;     // online mode owns this swap
    // A library that no longer parses is neither the game's nor the emulator's:
    // it is a damaged file (CONTROL Resonant's Goldberg, cut to Valve's length
    // by an update — Windows answers 0xc000007b). Read as "emulator still in
    // place", it kept the backup and the crack below placed nothing. The
    // backup is the game's own library, so it goes back and the crack starts
    // from a clean state.
    if (!exportNames(dll)) {
      const original = exportNames(backup);
      if (!original || EMULATOR_EXPORTS.some((name) => original.has(name))) continue;
      try {
        fs.renameSync(backup, dll);
        cleared++;
        onLog(`↻ ${path.basename(dll)} was damaged (not a readable library). Restored the game's own copy from its backup so the emulator can be applied again.`);
      } catch (e) {
        onLog(`⚠ Could not restore ${path.basename(backup)}: ${e.message}`);
      }
      continue;
    }
    if (!isGameOwnLibrary(dll)) continue;                    // emulator still in place
    try {
      fs.unlinkSync(backup);
      cleared++;
      onLog(`↻ ${path.basename(dll)} is the game's own library again — an update put it back. Clearing the stale backup so the emulator can be applied.`);
    } catch (e) {
      onLog(`⚠ Could not clear ${path.basename(backup)}: ${e.message}`);
    }
  }
  return cleared;
}

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

  // Steam's own manifest for this folder is the authority on which app lives
  // here. Nothing used to check it, so one mistyped digit produced a perfectly
  // "successful" crack that emulated the wrong app — and the only symptom was
  // wrong achievements and a game that may not launch, noticed much later.
  //
  // The manifest wins over what the caller passed: it is written by the
  // download itself, whereas the argument can be a typed field.
  let effectiveAppId = String(appId);
  const truth = appIdFromLibraryManifest(gamePath);
  if (truth && String(truth.appId) !== effectiveAppId) {
    onLog(`⚠ AppID mismatch — this folder is ${truth.name || 'a game'} (${truth.appId}), but ${effectiveAppId} was supplied.`);
    onLog(`   Using ${truth.appId}, from Steam's manifest for this install.`);
    effectiveAppId = String(truth.appId);
  }

  // An update restores the game's own steam_api64 from the depot. Without this,
  // the crack below is skipped over the backup the first one left behind — and
  // says nothing about it.
  clearStaleBackups(gamePath, onLog);

  // First ensure config.json exists with sane defaults
  const sacDir = path.dirname(getSacCliPath());
  const configPath = path.join(sacDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    onLog('📝 Creating default config...');
    await runSacCli(['createconfig'], { onLog, cwd: sacDir });
  }

  // Run the crack command
  const args = ['crack', gamePath, '--appid', effectiveAppId];
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
 * Fetch a game's achievement and DLC definitions — and nothing else.
 *
 * SteamAutoCrack's steps are independent switches, so EMUGameInfo can run on
 * its own: it writes steam_settings/achievements.json (names, descriptions and
 * icon files) beside the game and leaves every DLL untouched. That matters for
 * an already-installed game, where re-running the whole crack to obtain a list
 * of achievement names would replace the emulator underneath a working install.
 *
 * The unlocks themselves are a separate question: recording those needs the
 * offline emulator to be the one the game is calling. This only supplies the
 * half that says what the achievements *are*.
 */
async function generateGameInfo(gamePath, appId, onLog = () => {}, webApiKey = '') {
  if (!gamePath || !fs.existsSync(gamePath)) {
    return { success: false, error: 'Invalid game path' };
  }

  const id = String(appId || '').trim();
  if (!/^\d{1,20}$/.test(id) || id === '0') {
    return { success: false, error: 'A Steam AppID is required to look up achievements' };
  }

  onLog(`🏆 Fetching achievement definitions for AppID ${id}...`);

  const sacDir = path.dirname(getSacCliPath());
  const infoConfig = {
    ProcessConfigs: {
      GenerateEMUGameInfo: true,
      GenerateEMUConfig: false,
      Unpack: false,
      ApplyEMU: false,
      GenerateCrackOnly: false,
      Restore: false,
    },
    // Without one of these the step runs, reports success and writes nothing —
    // it logs "Empty Steam Web API Key, skipping getting game schema" and moves
    // on. Xan105's public achievement API needs no key at all, so it is the
    // default; a key, if the user has one, is more authoritative and wins.
    EMUGameInfoConfigs: {
      UseXan105API: !webApiKey,
      SteamWebAPIKey: webApiKey || '',
    },
  };

  const configPath = path.join(sacDir, 'gameinfo_config.json');
  fs.writeFileSync(configPath, JSON.stringify(infoConfig, null, 2), 'utf-8');

  // SAC accumulates into its own TEMP folder and never clears it, so a run for
  // one game would otherwise inherit the previous game's achievements.
  const staging = path.join(sacDir, 'TEMP', 'steam_settings');
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* first run */ }

  const result = await runSacCli(
    ['crack', gamePath, '--appid', id, '--config', configPath],
    { onLog, cwd: sacDir }
  );

  try { fs.unlinkSync(configPath); } catch { /* best effort */ }

  /*
   * Move the result into the game.
   *
   * EMUGameInfo writes to SAC's staging folder; it is the ApplyEMU step that
   * copies steam_settings into the game — and ApplyEMU also swaps DLLs, which
   * is exactly what must not happen to a working install. So the achievement
   * files are copied across by hand and nothing else is touched: the game's own
   * configs.*.ini, branches.json and steam_appid.txt are already correct and
   * are left alone.
   */
  const { findSettingsDir } = require('./achievements');
  const target = findSettingsDir(gamePath);
  if (target && fs.existsSync(staging)) {
    for (const entry of ['achievements.json', 'stats.json', 'achievement_images']) {
      const from = path.join(staging, entry);
      if (!fs.existsSync(from)) continue;
      try {
        fs.cpSync(from, path.join(target, entry), { recursive: true, force: true });
      } catch (e) {
        onLog(`⚠ Could not copy ${entry}: ${e.message}`);
      }
    }
  } else if (!target) {
    onLog('⚠ No steam_settings folder found in this game — nothing to copy into.');
  }

  // Say plainly whether anything landed: SAC reports success for a run that
  // fetched nothing, and a silent no-op here looks like a broken button.
  let count = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(target, 'achievements.json'), 'utf-8'));
    count = Array.isArray(parsed) ? parsed.length : 0;
  } catch { /* nothing landed */ }

  if (!count) {
    onLog('⚠ No achievement definitions were written — this game may publish none.');
    return { ...result, success: false, count: 0, error: result.error || 'No achievements found for this game' };
  }

  onLog(`✅ ${count} achievement definition(s) written to steam_settings.`);
  return { ...result, success: true, count };
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
    detectedName: '',
    appIdSource: ''
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

  // Steam's manifest for this install beats anything guessed from inside the
  // folder — including a steam_appid.txt left behind by an earlier, wrong
  // crack, which would otherwise keep re-suggesting its own mistake.
  const fromLibrary = appIdFromLibraryManifest(gamePath);
  if (fromLibrary) {
    result.detectedAppId = fromLibrary.appId;
    if (fromLibrary.name) result.detectedName = fromLibrary.name;
    result.appIdSource = 'steam manifest';
  } else if (result.detectedAppId) {
    result.appIdSource = 'game folder';
  }

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
  generateGameInfo,
  appIdFromLibraryManifest,
  checkSacStatus,
  goldbergFolderUsable,
  downloadGoldberg,
  crackGame,
  restoreGame,
  generateCrackOnly,
  scanGameDirectory,
  clearStaleBackups,
};
