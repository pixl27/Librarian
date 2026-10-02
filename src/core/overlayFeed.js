// ═══════════════════════════════════════════════════════════════════
// Librarian — feeding the in-game overlay
//
// The injected half (native/achoverlay) draws a bitmap and nothing else. This
// is where that bitmap comes from: the same achievement toast the windowed
// overlay shows, rendered off screen and published frame by frame.
//
// Why go the long way round instead of drawing the toast in C++: the design
// already exists, in CSS, and it animates. Reimplementing it against a D3D
// device would be the same work twice and the second copy would be the worse
// one — no text shaping, no rounded corners for free, no easing curves.
//
// Off-screen rendering rather than capturePage(): with `offscreen: true`
// Electron hands over a fresh bitmap on every repaint, which is exactly the
// frame stream the overlay wants. capturePage would have to be polled, and
// would fight the compositor for each grab.
//
// The channel between the two halves is a fixed-size file that the game maps.
// See native/achoverlay/shared.h for why it is a file and not a named section.
// ═══════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { BrowserWindow, app } = require('electron');

const MAX_W = 640;
const MAX_H = 160;

// The window is deliberately shorter than the atlas: a 160px-tall bitmap of
// which the toast used only a third made the toast tiny in the frame, because
// the quad is sized from the bitmap and not from its contents.
const RENDER_H = 110;
const HEADER = 60;                       // 6 uint32 + 3 float + 6 reserved
const SIZE = HEADER + MAX_W * MAX_H * 4;
const MAGIC = 0x4F41424C;                // 'LBAO'
const VERSION = 1;

const FRAME_RATE = 30;                   // enough for the toast's easing to read
const HOLD_MS = 5200;                    // must outlast the page's own animation

// How tall the toast is drawn, as a share of the frame's height. Tunable
// because "big enough" depends on the screen and how far away it is.
const DEFAULT_SCALE = 0.15;

function currentScale() {
  try {
    const value = Number(require('./settingsStore').get('achievement_popup_scale'));
    return Number.isFinite(value) && value > 0.02 && value <= 0.6 ? value : DEFAULT_SCALE;
  } catch { return DEFAULT_SCALE; }
}

let renderer = null;                     // the off-screen BrowserWindow
let feeds = new Map();                   // pid -> { fd, buffer, seq }
let stopTimer = null;

function overlayDir() {
  return path.join(app.getPath('appData'), '..', 'Local', 'Librarian', 'overlay');
}

/** The file a game's injected half will map. One per process id. */
function open(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (feeds.has(id)) return feeds.get(id);

  try {
    const dir = overlayDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.bin`);

    // Created at full size up front: the injected side maps the whole struct,
    // and a file that grows underneath a live mapping is a fault, not a resize.
    const buffer = Buffer.alloc(SIZE);
    buffer.writeUInt32LE(MAGIC, 0);
    buffer.writeUInt32LE(VERSION, 4);
    fs.writeFileSync(file, buffer);

    const feed = { fd: fs.openSync(file, 'r+'), buffer, seq: 0, file };
    feeds.set(id, feed);
    return feed;
  } catch (e) {
    console.error('overlay feed: could not open for', id, e.message);
    return null;
  }
}

function close(pid) {
  const feed = feeds.get(Number(pid));
  if (!feed) return;
  try { fs.closeSync(feed.fd); } catch { /* already gone */ }
  try { fs.unlinkSync(feed.file); } catch { /* the game may still hold it */ }
  feeds.delete(Number(pid));
}

function closeAll() {
  for (const pid of [...feeds.keys()]) close(pid);
}

/**
 * Publish one frame to every game being fed.
 *
 * The pixel payload is written before the header, and `seq` last of all: a
 * reader that catches the file mid-write sees the previous sequence number and
 * draws the frame it already has. That ordering is the whole synchronisation
 * scheme — there is no lock, and none is needed for one writer.
 */
function publish({ pixels, width, height, visible = 1, anchorX = 0.5, anchorY = 0.045, scale = currentScale() }) {
  for (const feed of feeds.values()) {
    try {
      if (pixels) {
        // The source may be narrower than the atlas; copy row by row so the
        // stride the injected half assumes stays correct.
        const rowBytes = width * 4;
        for (let row = 0; row < height; row++) {
          pixels.copy(feed.buffer, HEADER + row * MAX_W * 4, row * rowBytes, row * rowBytes + rowBytes);
        }
        fs.writeSync(feed.fd, feed.buffer, HEADER, height * MAX_W * 4, HEADER);
      }

      const head = Buffer.alloc(HEADER);
      head.writeUInt32LE(MAGIC, 0);
      head.writeUInt32LE(VERSION, 4);
      head.writeUInt32LE(++feed.seq, 8);
      head.writeUInt32LE(visible ? 1 : 0, 12);
      head.writeUInt32LE(width, 16);
      head.writeUInt32LE(height, 20);
      head.writeFloatLE(anchorX, 24);
      head.writeFloatLE(anchorY, 28);
      head.writeFloatLE(scale, 32);
      fs.writeSync(feed.fd, head, 0, HEADER, 0);
    } catch (e) {
      console.error('overlay feed: write failed', e.message);
    }
  }
}

/** Hide without tearing anything down, so the next unlock starts instantly. */
function hide() {
  publish({ pixels: null, width: 0, height: 0, visible: 0 });
}

function ensureRenderer() {
  if (renderer && !renderer.isDestroyed()) return renderer;

  renderer = new BrowserWindow({
    width: MAX_W,
    height: RENDER_H,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: {
      offscreen: true,
      preload: path.join(__dirname, '..', 'overlay', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  renderer.webContents.setFrameRate(FRAME_RATE);
  renderer.webContents.setBackgroundThrottling(false);

  // Every repaint is a frame for the game. `image` is BGRA, which is the
  // format the injected texture expects, so nothing is converted here.
  renderer.webContents.on('paint', (_event, _dirty, image) => {
    if (!feeds.size || require('./settingsStore').get('achievement_popups') === false) return;
    const size = image.getSize();
    if (!size.width || !size.height) return;
    publish({
      pixels: image.toBitmap(),
      width: Math.min(size.width, MAX_W),
      height: Math.min(size.height, MAX_H),
      visible: 1,
    });
  });

  renderer.loadFile(path.join(__dirname, '..', 'overlay', 'achievement.html'), { search: 'feed=1' });
  renderer.on('closed', () => { renderer = null; });
  return renderer;
}

/** Show an unlock inside every game currently being fed. */
function show(item) {
  if (require('./settingsStore').get('achievement_popups') === false) return;
  if (!feeds.size) return;                  // no game is listening
  const win = ensureRenderer();
  const send = () => {
    if (!win.isDestroyed() && require('./settingsStore').get('achievement_popups') !== false) {
      win.webContents.send('overlay:achievement', item);
    }
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();

  clearTimeout(stopTimer);
  stopTimer = setTimeout(hide, HOLD_MS);
}

function dismiss() {
  clearTimeout(stopTimer);
  hide();
  if (renderer && !renderer.isDestroyed()) renderer.destroy();
  renderer = null;
}

function stop() {
  dismiss();
  closeAll();
}

module.exports = { open, close, closeAll, show, hide, dismiss, stop, MAX_W, MAX_H };
