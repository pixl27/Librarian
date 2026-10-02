const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const crypto = require('crypto');
const json = require('./jsonFile');

let _data = null;
let _filePath = null;

function cleanString(value, maxLength = 2048) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function cleanAppId(value) {
  const appId = cleanString(value, 20);
  return /^\d{1,20}$/.test(appId) ? appId : '';
}

function cleanSize(value) {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
}

function getFilePath() {
  if (!_filePath) {
    _filePath = path.join(app.getPath('userData'), 'librarian-custom-games.json');
  }
  return _filePath;
}

function load() {
  if (_data) return _data;
  _data = json.read(getFilePath(), [], Array.isArray);
  return _data;
}

function save(next) {
  json.write(getFilePath(), next);
  _data = next;
}

function getAll() {
  return json.clone(load());
}

function getById(id) {
  return json.clone(load().find(g => g.id === id) || null);
}

function add(gameData) {
  load();
  const entry = {
    id: crypto.randomUUID(),
    game_name: cleanString(gameData.game_name, 160) || 'Unknown Game',
    appid: cleanAppId(gameData.appid),
    install_path: cleanString(gameData.install_path),
    executable: cleanString(gameData.executable),
    banner_path: cleanString(gameData.banner_path),
    banner_url: cleanString(gameData.banner_url),
    size_on_disk: cleanSize(gameData.size_on_disk),
    source: 'Custom',
    added_at: new Date().toISOString(),
  };
  save([..._data, entry]);
  return json.clone(entry);
}

function update(id, updates) {
  load();
  const idx = _data.findIndex(g => g.id === id);
  if (idx === -1) return null;
  const next = json.clone(_data);
  // Only update allowed fields
  const allowed = ['game_name', 'appid', 'install_path', 'executable', 'banner_path', 'banner_url', 'size_on_disk'];
  for (const key of allowed) {
    if (updates[key] === undefined) continue;
    if (key === 'appid') next[idx][key] = cleanAppId(updates[key]);
    else if (key === 'size_on_disk') next[idx][key] = cleanSize(updates[key]);
    else if (key === 'game_name') next[idx][key] = cleanString(updates[key], 160) || 'Unknown Game';
    else next[idx][key] = cleanString(updates[key]);
  }
  if (next[idx].appid !== _data[idx].appid || next[idx].install_path !== _data[idx].install_path) delete next[idx].update_link;
  save(next);
  return json.clone(_data[idx]);
}

function setUpdateLink(id, appid, link) {
  const next = json.clone(load());
  const entry = next.find(game => game.id === id);
  if (!entry) throw new Error('Custom game no longer exists.');
  entry.appid = cleanAppId(appid);
  if (link) entry.update_link = json.clone(link);
  else delete entry.update_link;
  save(next);
  return json.clone(entry);
}

function remove(id) {
  load();
  const before = _data.length;
  const next = _data.filter(g => g.id !== id);
  if (next.length < before) {
    save(next);
    return true;
  }
  return false;
}

module.exports = { getAll, getById, add, update, remove, setUpdateLink };
