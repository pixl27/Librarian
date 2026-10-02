/**
 * Games that come ready for co-op.
 *
 * Librarian is handed to friends who want to play together without learning
 * which switches to flip first. For the games listed in gamePresets.json the
 * switches the owner uses are flipped for them — online mode (a real Steam
 * session under Spacewar, which for Valheim also installs the managed adapter,
 * see valheimOnline.js), PEAK's join-a-friend plugin (peakMod.js), the generic
 * Photon engine (photonMod.js).
 *
 * It happens once per step, at the first moment Librarian is in a position to
 * do it: when the download finishes, or failing that, when the game is
 * launched. "Once" is the point. A receipt in the install's marker folder lists
 * the steps already done, so a friend who turns online mode off keeps it off,
 * while a step added to the list in a later release still reaches installs
 * that had the others. An install that already carries an online-mode record
 * with no receipt beside it — the owner's own games, anything switched by
 * hand — is never touched: that record is somebody's choice, whichever way it
 * went. Only the receipt is written.
 *
 * A failed step is left out of the receipt, so the next launch tries it again;
 * the launch itself is never held up by it.
 */
const fs = require('fs');
const path = require('path');

const MARKER_DIR = '.DepotDownloader';
const RECEIPT = 'librarian-preset.json';
const ONLINE_STATE = 'online-mode.json';

// What a preset can ask for, in the order they must run: the mods load through
// BepInEx and do nothing without the Steam session online mode provides.
const STEPS = {
  online: {
    label: 'Online mode',
    run: (game, dir, exe, playerName) => require('./onlineMode').enableOnline(dir, exe, playerName),
  },
  peakMod: {
    label: 'Join-a-friend plugin',
    run: (game, dir) => require('./peakMod').install({ ...game, install_path: dir }),
  },
  photonMod: {
    label: 'Photon join engine',
    run: (game, dir) => require('./photonMod').install({ ...game, install_path: dir }),
  },
};
const ORDER = Object.keys(STEPS);

let catalog = null;

/** The presets shipped with this build, cleaned of anything malformed. */
function list() {
  if (catalog) return catalog;
  let raw = [];
  try { raw = require('./gamePresets.json').presets || []; } catch { raw = []; }
  const seen = new Set();
  catalog = raw.flatMap((entry) => {
    const appid = String(entry && entry.appid || '').trim();
    if (!/^\d{1,10}$/.test(appid) || seen.has(appid)) return [];
    const steps = ORDER.filter(step => Array.isArray(entry.steps) && entry.steps.includes(step));
    if (!steps.length) return [];
    seen.add(appid);
    return [{
      appid,
      name: String(entry.name || appid).slice(0, 80),
      steps,
      labels: steps.map(step => STEPS[step].label),
      note: String(entry.note || '').slice(0, 300),
    }];
  });
  return catalog;
}

function presetFor(appid) {
  const id = String(appid ?? '').trim();
  return list().find(p => p.appid === id) || null;
}

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const receiptPath = (dir) => path.join(dir, MARKER_DIR, RECEIPT);

function readReceipt(dir) {
  try { return JSON.parse(fs.readFileSync(receiptPath(dir), 'utf8')); } catch { return null; }
}

function writeReceipt(dir, body) {
  fs.mkdirSync(path.join(dir, MARKER_DIR), { recursive: true });
  fs.writeFileSync(receiptPath(dir), JSON.stringify({ version: 1, ...body, at: Date.now() }, null, 2));
}

function installDir(game) {
  const dir = game && typeof game.install_path === 'string' ? game.install_path : '';
  return dir && exists(dir) ? dir : '';
}

/** Steps of this game's preset not yet done on this install. */
function remaining(preset, receipt) {
  if (!preset) return [];
  if (!receipt) return [...preset.steps];
  if (receipt.respected === true) return [];
  const done = Array.isArray(receipt.steps) ? receipt.steps : [];
  return preset.steps.filter(step => !done.includes(step));
}

/** Does this install still wait for some or all of its preset? */
function pending(game) {
  const dir = installDir(game);
  const preset = presetFor(game && game.appid);
  return Boolean(dir && preset && remaining(preset, readReceipt(dir)).length);
}

function onlineRecord(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MARKER_DIR, ONLINE_STATE), 'utf8')); } catch { return null; }
}

/**
 * Where this install stands, for display: 'pending' (something will be set up
 * at the next launch), 'off' (online mode was turned off — by the player, or
 * before the preset existed) or 'ready'. Null for a game with no preset.
 */
function stateOf(game) {
  const dir = installDir(game);
  const preset = presetFor(game && game.appid);
  if (!dir || !preset) return null;
  const receipt = readReceipt(dir);
  const record = onlineRecord(dir);
  // No receipt but a record: the next launch only writes the receipt.
  if (remaining(preset, receipt).length && !(receipt === null && record)) return 'pending';
  if (preset.steps.includes('online') && record && record.mode !== 'online') return 'off';
  return 'ready';
}

/**
 * Apply what is left of the preset for this game.
 *
 * @param {object} game     - { appid, install_path, game_name }
 * @param {object} options
 * @param {string} [options.exe]        - the executable Librarian launches;
 *                                        resolved from the game when omitted.
 * @param {string} [options.playerName] - forwarded to online mode.
 * @param {function} [options.onLog]
 * @returns {{ applied: boolean, steps?: string[], name?: string, skipped?: string, error?: string }}
 */
function apply(game, { exe, playerName = '', onLog = () => {} } = {}) {
  const preset = presetFor(game && game.appid);
  const dir = installDir(game);
  if (!preset || !dir) return { applied: false, skipped: 'no-preset' };
  const receipt = readReceipt(dir);
  const todo = remaining(preset, receipt);
  if (!todo.length) return { applied: false, skipped: 'done' };

  const executable = exe || require('./launcher').resolveExecutable(game);
  if (!executable) return { applied: false, error: 'No executable found for this game yet.' };

  // A record means someone already chose, in either direction. The files are
  // asked too, because an install switched online outside Librarian has no
  // record but is just as much a decision. With a receipt present the record
  // is ours, written by an earlier run of this preset.
  if (!receipt) {
    const recorded = exists(path.join(dir, MARKER_DIR, ONLINE_STATE));
    const live = require('./onlineMode').getStatus(dir, executable).mode === 'online';
    if (recorded || live) {
      writeReceipt(dir, { appid: preset.appid, respected: true, steps: [] });
      onLog(`${preset.name}: online mode was already chosen for this install; left as it is.`);
      return { applied: false, skipped: 'existing-choice' };
    }
  }

  const done = receipt && Array.isArray(receipt.steps) ? [...receipt.steps] : [];
  const ran = [];
  for (const step of todo) {
    onLog(`${preset.name}: ${STEPS[step].label.toLowerCase()}…`);
    let r;
    try { r = STEPS[step].run(game, dir, executable, playerName); }
    catch (err) { r = { success: false, error: err.message }; }
    if (!r || !r.success) {
      const error = (r && r.error) || `${STEPS[step].label} could not be set up.`;
      onLog(`${preset.name}: ${STEPS[step].label.toLowerCase()} failed — ${error}`);
      if (ran.length) writeReceipt(dir, { appid: preset.appid, steps: done });
      return { applied: ran.length > 0, steps: ran, labels: ran.map(s => STEPS[s].label), name: preset.name, error };
    }
    done.push(step);
    ran.push(step);
  }

  writeReceipt(dir, { appid: preset.appid, steps: done });
  onLog(`${preset.name}: ready for co-op (${ran.map(step => STEPS[step].label).join(' + ')}).`);
  return { applied: true, steps: ran, labels: ran.map(step => STEPS[step].label), name: preset.name };
}

module.exports = { list, presetFor, pending, stateOf, apply, RECEIPT, STEPS: ORDER };
