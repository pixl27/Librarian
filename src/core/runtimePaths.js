const path = require('path');
const { app } = require('electron');

function isPackagedApp() {
  return Boolean(app && app.isPackaged);
}

function getDepsRoot() {
  if (isPackagedApp()) {
    return path.join(process.resourcesPath, 'deps');
  }

  return path.join(__dirname, '..', '..', 'deps');
}

function getDepsPath(...segments) {
  return path.join(getDepsRoot(), ...segments);
}

module.exports = {
  getDepsRoot,
  getDepsPath,
};