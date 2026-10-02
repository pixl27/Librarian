// Preload for the achievement overlay window. It receives, it never asks:
// the page has no business reaching into the app, and the window is
// click-through, so there is nothing for a user to interact with either.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  onAchievement: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('overlay:achievement', (_e, item) => cb(item));
  },
  // Nothing left on screen — the main process can hide the window again.
  idle: () => ipcRenderer.send('overlay:idle'),
});
