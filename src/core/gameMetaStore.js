// ─── Per-Game Metadata Store ─────────────────────────────────────
// Persists launcher metadata that isn't part of Steam/custom game records:
// playtime, last-played timestamp, launch count, and a chosen executable
// override. Keyed by a stable identity string so it survives rescans.
//
// Keys mirror the renderer's favourite keys so both stores agree on identity:
//   steam:<appid>  ·  custom:<id>  ·  path:<install_path>
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const json = require('./jsonFile');

let _data = null;
let _filePath = null;

function getFilePath() {
  if (!_filePath) {
    _filePath = path.join(app.getPath('userData'), 'librarian-game-meta.json');
  }
  return _filePath;
}

function normalizePathForKey(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Build the stable identity key for a game record.
 * Prefers custom id, then Steam AppID, then a normalized install path.
 */
function gameKey(game) {
  if (!game) return '';
  if (game.source === 'Custom' && game.id) return `custom:${game.id}`;
  const appId = String(game.appid || '').trim();
  if (/^\d{1,20}$/.test(appId) && appId !== '0') return `steam:${appId}`;
  if (game.install_path) return `path:${normalizePathForKey(game.install_path)}`;
  return '';
}

function load() {
  if (_data) return _data;
  _data = json.read(getFilePath(), {}, value => value && typeof value === 'object' && !Array.isArray(value));
  return _data;
}

function save(next) {
  json.write(getFilePath(), next);
  _data = next;
}

function blankEntry() {
  return {
    playtime_seconds: 0,
    last_played: 0,
    launch_count: 0,
    executable: '',
    first_seen: 0,
  };
}

function getByKey(key) {
  if (!key) return blankEntry();
  const data = load();
  return json.clone({ ...blankEntry(), ...(data[key] || {}) });
}

function get(game) {
  return getByKey(gameKey(game));
}

function setByKey(key, updates) {
  if (!key) return null;
  const data = load();
  const entry = { ...blankEntry(), ...(data[key] || {}), ...updates };
  entry.playtime_seconds = Math.max(0, Math.floor(Number(entry.playtime_seconds) || 0));
  entry.launch_count = Math.max(0, Math.floor(Number(entry.launch_count) || 0));
  entry.last_played = Math.max(0, Math.floor(Number(entry.last_played) || 0));
  entry.first_seen = Math.max(0, Math.floor(Number(entry.first_seen) || 0));
  entry.executable = typeof entry.executable === 'string' ? entry.executable : '';
  save({ ...data, [key]: entry });
  return json.clone(entry);
}

/** Add a completed play session's duration (seconds) and stamp last-played. */
function addPlaytime(key, seconds) {
  if (!key) return null;
  const secs = Math.max(0, Math.floor(Number(seconds) || 0));
  const current = getByKey(key);
  return setByKey(key, {
    playtime_seconds: current.playtime_seconds + secs,
    last_played: Date.now(),
  });
}

/** Record that a launch happened (bumps count + last-played, sets first_seen once). */
function recordLaunch(key) {
  if (!key) return null;
  const current = getByKey(key);
  return setByKey(key, {
    launch_count: current.launch_count + 1,
    last_played: Date.now(),
    first_seen: current.first_seen || Date.now(),
  });
}

function setExecutable(key, executable) {
  if (!key) return null;
  return setByKey(key, { executable: typeof executable === 'string' ? executable : '' });
}

/** Merge stored metadata onto a game record for the renderer. */
function decorate(game) {
  const meta = get(game);
  return {
    ...game,
    playtime_seconds: meta.playtime_seconds,
    last_played: meta.last_played,
    launch_count: meta.launch_count,
    first_seen: Date.parse(game.added_at) || meta.first_seen || 0,
    executable: game.executable || meta.executable || '',
    game_key: gameKey(game),
  };
}

function getAll() {
  return json.clone(load());
}

// Stamp discovery once in one transaction, not once per game or on first play.
function recordDiscovery(games) {
  const next = json.clone(load());
  let changed = false;
  for (const game of games) {
    const key = gameKey(game);
    if (!key || next[key]?.first_seen) continue;
    next[key] = { ...blankEntry(), ...next[key], first_seen: Date.parse(game.added_at) || Date.now() };
    changed = true;
  }
  if (changed) save(next);
}

module.exports = {
  gameKey,
  get,
  getByKey,
  setByKey,
  addPlaytime,
  recordLaunch,
  setExecutable,
  decorate,
  getAll,
  recordDiscovery,
};
