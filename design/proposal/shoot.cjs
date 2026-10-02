// Render each mock-up screen to a sharp PNG.
//   node_modules/electron/dist/electron.exe design/proposal/shoot.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'shots');
const SCREENS = (process.argv[2] || 'home,library,game,downloads').split(',');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false, useContentSize: true,
    webPreferences: { offscreen: true },
  });
  for (const s of SCREENS) {
    win.setContentSize(1440, s === 'game' ? 1180 : 900);
    await win.loadURL(`http://localhost:8765/index.html?s=${s}&v=${Date.now()}`);
    await win.webContents.executeJavaScript(
      'Promise.all([document.fonts.ready, ...[...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))]).then(() => new Promise(r => setTimeout(r, 900)))');
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${s}.png`), image.toPNG());
    console.log(s, image.getSize());
  }
  app.quit();
});
