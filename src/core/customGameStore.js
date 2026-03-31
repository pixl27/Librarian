const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const crypto = require('crypto');

let _data = null;
let _filePath = null;

function getFilePath() {
  if (!_filePath) {
    _filePath = path.join(app.getPath('userData'), 'librarian-custom-games.json');
  }
  return _filePath;
}

function load() {
  if (_data) return _data;
  try {
    const raw = fs.readFileSync(getFilePath(), 'utf-8');
    _data = JSON.parse(raw);
    if (!Array.isArray(_data)) _data = [];
  } catch {
    _data = [];
  }
  return _data;
}

function save() {
  try {
    const dir = path.dirname(getFilePath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getFilePath(), JSON.stringify(_data, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save custom games:', e);
  }
}

function getAll() {
  return [...load()];
}

function getById(id) {
  return load().find(g => g.id === id) || null;
}

function add(gameData) {
  load();
  const entry = {
    id: crypto.randomUUID(),
    game_name: gameData.game_name || 'Unknown Game',
    appid: gameData.appid || '',
    install_path: gameData.install_path || '',
    executable: gameData.executable || '',
    banner_path: gameData.banner_path || '',
    banner_url: gameData.banner_url || '',
    size_on_disk: gameData.size_on_disk || 0,
    source: 'Custom',
    added_at: new Date().toISOString(),
  };
  _data.push(entry);
  save();
  return entry;
}

function update(id, updates) {
  load();
  const idx = _data.findIndex(g => g.id === id);
  if (idx === -1) return null;
  // Only update allowed fields
  const allowed = ['game_name', 'appid', 'install_path', 'executable', 'banner_path', 'banner_url', 'size_on_disk'];
  for (const key of allowed) {
    if (updates[key] !== undefined) _data[idx][key] = updates[key];
  }
  save();
  return _data[idx];
}

function remove(id) {
  load();
  const before = _data.length;
  _data = _data.filter(g => g.id !== id);
  if (_data.length < before) {
    save();
    return true;
  }
  return false;
}

module.exports = { getAll, getById, add, update, remove };
