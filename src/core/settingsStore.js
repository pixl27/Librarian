const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  accent_color: '#FFB703',
  background_color: '#16213E',
  slssteam_mode: false,
  library_mode: false,
  generate_achievements: false,
  use_steamless: false,
  auto_crack: false,
  morrenus_api_key: '',
  font_family: 'Fredoka',
  font_size: 13,
};

let _data = null;
let _filePath = null;

function getPreferredFilePath() {
  return path.join(app.getPath('userData'), 'librarian-settings.json');
}

function getLegacyFilePath() {
  return path.join(app.getPath('userData'), 'accela-settings.json');
}

function getFilePath() {
  if (!_filePath) {
    _filePath = getPreferredFilePath();
  }
  return _filePath;
}

function load() {
  if (_data) return _data;
  const candidates = [getPreferredFilePath(), getLegacyFilePath()];

  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf-8');
      _filePath = candidate;
      _data = { ...DEFAULTS, ...JSON.parse(raw) };
      return _data;
    } catch {
      // Try the next candidate.
    }
  }

  _filePath = getPreferredFilePath();
  _data = { ...DEFAULTS };
  return _data;
}

function save() {
  try {
    const targetPath = getPreferredFilePath();
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify(_data, null, 2), 'utf-8');
    _filePath = targetPath;
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

function get(key) {
  const data = load();
  return key ? data[key] : data;
}

function set(key, value) {
  const data = load();
  data[key] = value;
  save();
}

function getAll() {
  return { ...load() };
}

module.exports = { get, set, getAll, DEFAULTS };
