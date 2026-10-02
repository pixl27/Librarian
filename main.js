// The native download engine decompresses chunks with libuv-threadpool codecs
// (zstd/deflate) and writes them with async fs. The default pool of 4 threads
// becomes the bottleneck well before the network does. This must be set before
// anything touches the pool, i.e. before any async fs/zlib/crypto work.
if (!process.env.UV_THREADPOOL_SIZE) {
  const cores = require('os').cpus()?.length || 4;
  process.env.UV_THREADPOOL_SIZE = String(Math.max(8, Math.min(32, cores * 2)));
}

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
// A separate profile: a fresh one shows Librarian exactly as a first install
// does, and dev/verify-app-update.cjs keeps its test installs off the real
// one. An environment variable rather than a switch because it survives the
// relaunch after an update. Before the instance lock, which is per profile.
if (process.env.LIBRARIAN_PROFILE_DIR) app.setPath('userData', path.resolve(process.env.LIBRARIAN_PROFILE_DIR));
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
const { getDepsRoot, getDepsPath } = require('./src/core/runtimePaths');

let mainWindow = null;
function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}
let settings = null;
const gameOperations = new Set();
const dlssgOperations = new Set();
function operationKey(game) {
  return game?.install_path ? `install:${path.resolve(game.install_path).toLowerCase()}` : require('./src/core/gameMetaStore').gameKey(game);
}
function assertGameIdle(game, { allowRunning = false } = {}) {
  const key = operationKey(game);
  if (gameOperations.has(key)) throw new Error('An operation is already in progress for this game.');
  const identity = require('./src/core/gameMetaStore').gameKey(game);
  if (!allowRunning && require('./src/core/launcher').getRunning().some(r => r.key === identity || (r.install_path && operationKey(r) === key))) throw new Error('Close the running game before changing its files.');
  const active = require('./src/core/downloadQueue').snapshot().active;
  const samePath = (a, b) => a && b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (active && ((key && key === operationKey(active.gameData)) || samePath(active.extractTo, game?.install_path)
    || (active.gameData?.installdir && samePath(path.join(active.destPath || '', 'steamapps', 'common', active.gameData.installdir), game?.install_path)))) {
    throw new Error('Wait for this game’s download or repair to finish.');
  }
}

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

// Every privileged request must originate from our own top-level document.
const registerHandle = ipcMain.handle.bind(ipcMain);
const registerOn = ipcMain.on.bind(ipcMain);
function trustedSender(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame
    && event.senderFrame.url === require('url').pathToFileURL(path.join(__dirname, 'src', 'index.html')).href);
}
ipcMain.handle = (channel, handler) => registerHandle(channel, (event, ...args) => {
  if (!trustedSender(event)) throw new Error('Untrusted IPC sender');
  return handler(event, ...args);
});
ipcMain.on = (channel, handler) => registerOn(channel, (event, ...args) => {
  if (trustedSender(event)) handler(event, ...args);
});

// Restore the window exactly where the user left it, but never off-screen: a
// monitor that has since been unplugged would otherwise hide Librarian entirely.
function resolveStartupBounds() {
  const stored = settings.get('window_bounds') || {};
  const bounds = {
    width: Number.isFinite(stored.width) ? stored.width : 1280,
    height: Number.isFinite(stored.height) ? stored.height : 800,
  };
  if (!Number.isFinite(stored.x) || !Number.isFinite(stored.y)) return bounds;

  const { screen } = require('electron');
  const visible = screen.getAllDisplays().some((display) => {
    const wa = display.workArea;
    return stored.x < wa.x + wa.width && stored.x + bounds.width > wa.x
      && stored.y < wa.y + wa.height && stored.y + bounds.height > wa.y;
  });
  if (visible) { bounds.x = stored.x; bounds.y = stored.y; }
  return bounds;
}

let saveBoundsTimer = null;
function rememberWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const maximized = mainWindow.isMaximized();
      settings.set('window_maximized', maximized);
      // Persist the *restored* size, so un-maximising returns to a sane window.
      // Minimised and fullscreen windows do not report one: Windows parks a
      // minimised window at roughly -32000,-32000, and that is what ends up on
      // disk if it is read mid-transition. Big Picture minimises on Play, so
      // this is a routine event, not an edge case.
      if (maximized || mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
      const bounds = mainWindow.getNormalBounds();
      if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return;
      if (Math.abs(bounds.x) > 10000 || Math.abs(bounds.y) > 10000) return;
      settings.set('window_bounds', bounds);
    } catch { /* settings are best-effort; never break the window over them */ }
  }, 400);
}

function createWindow() {
  // Lazy-load settings after app is ready
  settings = require('./src/core/settingsStore');

  mainWindow = new BrowserWindow({
    ...resolveStartupBounds(),
    minWidth: 1024,
    minHeight: 600,
    frame: false,
    show: false,
    title: 'Librarian',
    icon: path.join(__dirname, 'res', 'logo', 'librarian-icon.png'),
    backgroundColor: settings.get('background_color') || '#10131F',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  const allowedPermission = (contents, permission, details) => contents === mainWindow?.webContents
    && details?.isMainFrame === true
    && details.requestingUrl === require('url').pathToFileURL(path.join(__dirname, 'src', 'index.html')).href
    && permission === 'notifications' && settings.get('notify_on_complete') !== false;
  mainWindow.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowedPermission(contents, permission, details)));
  mainWindow.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => allowedPermission(contents, permission, details));

  if (settings.get('window_maximized')) mainWindow.maximize();

  // Painting into a hidden window and only then showing it removes the white
  // flash that a frameless Electron window otherwise opens with.
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  const emitWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window:state', {
      maximized: mainWindow.isMaximized(),
      fullScreen: mainWindow.isFullScreen(),
      focused: mainWindow.isFocused(),
    });
  };
  for (const evt of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur']) {
    mainWindow.on(evt, emitWindowState);
  }

  /*
   * Drop the resize border once Windows has finished going fullscreen.
   *
   * setFullScreen is asynchronous: Windows re-applies the window style when the
   * transition completes, which puts WS_THICKFRAME — and the 8px border it has
   * painted in the theme colour — back over anything set beside the call. That
   * is why the grey edge only showed when Big Picture was entered from a
   * *windowed* desktop; entering from an already-fullscreen window performs no
   * transition, so the setResizable in the IPC handler is the last word and the
   * border never returns.
   *
   * Re-asserted once more on a short delay because the event can arrive before
   * the frame is recomputed, and toggled rather than merely set because Windows
   * only recalculates the non-client frame when the style actually changes.
   */
  // A resizable toggle was tried here to force Windows to recompute the frame
  // after the fullscreen transition. It does force it — and it also drops the
  // window out of the state that keeps the taskbar covered, so the taskbar came
  // back over Big Picture. Measured, reverted: whatever fixes the border must
  // not touch the resizable style once the window is already fullscreen.
  //
  // Hooked on the events rather than beside the setFullScreen call so it also
  // covers a fullscreen the user triggers themselves, and so it runs after the
  // transition rather than racing it.
  mainWindow.on('enter-full-screen', () => setWindowBorder(false));
  mainWindow.on('leave-full-screen', () => setWindowBorder(true));
  mainWindow.on('resize', rememberWindowBounds);
  mainWindow.on('move', rememberWindowBounds);
  mainWindow.on('close', event => {
    if (!isQuitting) { event.preventDefault(); rememberWindowBounds(); app.quit(); }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  if (process.env.LIBRARIAN_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'right' });

  // Fetch Goldberg on first run rather than making the user discover a button on
  // the Crack page. Deliberately after the renderer is up, so its log and status
  // chips can show what is happening.
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => { void ensureGoldbergReady(); }, 2500);
  });

  // Forward game play-session start/stop events (from the launcher's process
  // tracking) to the renderer so the UI can show live "Now Playing" state and
  // refresh playtime the moment a game closes.
  try {
    const launcher = require('./src/core/launcher');
    const achievements = require('./src/core/achievements');

    // An unlock goes two places: over the game, and into the launcher.
    achievements.init((item) => {
      // The icon is a file on disk; the overlay page is a file:// document and
      // needs a URL, not a Windows path.
      const icon = item.icon ? require('url').pathToFileURL(item.icon).href : '';
      const payload = { ...item, icon };
      try {
        if (settings.get('achievement_popups') !== false) {
          showAchievementOverlay(payload);
          // The same toast, drawn inside the game's own frame — the only route
          // that survives exclusive fullscreen.
          require('./src/core/overlayFeed').show(payload);
        }
      } catch (e) { console.error('overlay:', e); }
      sendToRenderer('achievement:unlocked', payload);
    });

    // What each running game is, for the checks that run when it exits.
    const liveSessions = new Map();   // key -> { appid, name, install_path, startedAt }

    launcher.setSessionChangeHandler((payload) => {
      sendToRenderer('game:session', payload);
      // A game that wrote a missing-interface report while it ran has an
      // emulator too old for its build (src/core/emuCompat.js). Read it back
      // the moment the game exits and tell the launcher, with the fix.
      try {
        if (payload.type === 'started') {
          liveSessions.set(payload.key, { appid: payload.appid, name: payload.name, install_path: payload.install_path, startedAt: payload.startedAt || Date.now() });
        } else if (payload.type === 'stopped') {
          const s = liveSessions.get(payload.key);
          liveSessions.delete(payload.key);
          if (s && s.install_path) {
            const emuCompat = require('./src/core/emuCompat');
            const reports = emuCompat.missingInterfaceReports(s.install_path, s.startedAt);
            if (reports.length) {
              const missing = [...new Set(reports.map((r) => r.interface))].sort();
              const game = { appid: s.appid, install_path: s.install_path, source: 'Steam' };
              emuCompat.recordBlock(game, { missing, source: 'launch' });
              sendToRenderer('emu:incompatible', { key: payload.key, appid: s.appid, name: s.name, missing });
            }
          }
        }
      } catch (e) { console.error('emulator compatibility:', e); }
      try {
        const overlayFeed = require('./src/core/overlayFeed');
        if (payload.type === 'started') {
          achievements.watch({
            appid: payload.appid,
            game_name: payload.name,
            install_path: payload.install_path,
            pid: payload.pid,
          });
          // Published before the game reaches its first frame: the injected
          // half retries for ten seconds, but there is no reason to make it.
          if (settings.get('achievement_popups') !== false) overlayFeed.open(payload.pid);
        } else if (payload.type === 'stopped') {
          achievements.unwatch(payload.appid);
          overlayFeed.close(payload.pid);
          // A client loader that died with the game leaves SteamPath on
          // its own folder; hand it back to Steam now that nothing runs.
          try {
            if (!launcher.getRunning().length) {
              const r = require('./src/core/steamHelpers').repairSteamRegistry();
              if (r.repaired) sendToRenderer('depot:progress', `🔧 Steam's registry entry pointed at ${r.from}; set back to ${r.to}.`);
            }
          } catch { /* Steam does the same on its next start */ }
        }
      } catch (e) { console.error('achievement watch:', e); }
    });
  } catch (e) {
    console.error('Failed to wire launcher session events:', e);
  }
}

// Goldberg is not shipped in deps/ — SteamAutoCrack downloads it. Doing that
// automatically at startup means "Apply Crack" and auto-crack-after-download
// just work, instead of failing on a missing emulator. Runs once per launch and
// is entirely best-effort: the manual button on the Crack page still exists.
let goldbergBootstrapped = false;
async function ensureGoldbergReady() {
  if (goldbergBootstrapped || process.env.LIBRARIAN_NO_GOLDBERG) return;
  goldbergBootstrapped = true;

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  try {
    const { checkSacStatus, downloadGoldberg } = require('./src/core/autoCrack');
    let status = checkSacStatus();

    if (status.goldbergExists) { send('crack:status', status); return; }
    // Present but unusable means the layout could not be reshaped into what SAC
    // probes — another 188 MB download would land in exactly the same state.
    if (status.goldbergPresent) {
      send('crack:log', '⚠ Goldberg is installed but not in a layout SteamAutoCrack can use. Re-downloading would not help; use "Download Goldberg" on the Crack page to force a clean copy.');
      send('crack:status', status);
      return;
    }
    if (!status.cliExists) {
      send('crack:log', '⚠ SteamAutoCrack CLI is missing, so Goldberg cannot be installed automatically.');
      send('crack:status', status);
      return;
    }

    send('crack:status', { ...status, installing: true });
    send('crack:log', '⬇ Goldberg is not installed yet — fetching it in the background…');

    await downloadGoldberg({ onLog: (msg) => send('crack:log', msg) });

    status = checkSacStatus();
    send('crack:status', status);
    send('crack:bootstrap', { success: status.goldbergExists });
  } catch (err) {
    send('crack:log', `⚠ Goldberg auto-install failed: ${err.message}`);
    send('crack:bootstrap', { success: false, error: err.message });
  }
}

app.whenReady().then(() => {
  if (!ownsInstance) return;
  try {
    require('./src/core/tuning').recoverMachine();
    createWindow();
    try {
      require('./src/core/appUpdater').start({ onState: (state) => sendToRenderer('app-update:state', state) });
    } catch (error) { console.error('[update]', error.message); }
  } catch (error) {
    dialog.showErrorBox('Librarian could not start', `${error.message}\n\nYour saved files have been preserved.`);
    app.quit();
  }
});
app.on('window-all-closed', () => app.quit());

// Stop an in-flight download when the app quits, so it isn't left holding file
// handles after Librarian closes. The stop unwinds asynchronously, so briefly
// defer the quit to give it time to land.
let isQuitting = false;
let quitPending = false;
app.on('before-quit', (event) => {
  if (isQuitting || !ownsInstance) return;
  event.preventDefault();
  if (quitPending) return;
  quitPending = true;
  void (async () => {
    try {
      require('./src/core/launcher').checkpointSessions();
      require('./src/core/tuning').shutdown();
      if (currentDownload) {
        await cancelCurrentDownload('Librarian closed during this job.');
      }
      await Promise.allSettled([...dlssgOperations]);
      isQuitting = true;
      app.quit();
    } catch (error) {
      quitPending = false;
      isQuitting = false;
      dialog.showErrorBox('Could not finish closing', `${error.message}\n\nFree disk space or restore access, then close Librarian again.`);
    }
  })();
});

// ─── Window Controls ─────────────────────────────────────────────
// ─── Achievement overlay ─────────────────────────────────────────
// A transparent, click-through window pinned above everything, shown only
// while there is something to say. It is not a second launcher window: it has
// no chrome, takes no focus, and is skipped by the taskbar and Alt-Tab.
//
// Its one real limit is exclusive fullscreen — a game that owns the display
// outright will cover it. Borderless windowed, which is what most games now
// default to, is fine.
let overlayWindow = null;
let overlayHideTimer = null;

function ensureOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;

  const { screen } = require('electron');
  const area = screen.getPrimaryDisplay().bounds;

  overlayWindow = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: 260,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,          // never steals the game's input
    show: false,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'src', 'overlay', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 'screen-saver' is the level that sits above a borderless fullscreen game;
  // plain alwaysOnTop is not enough.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setIgnoreMouseEvents(true, { forward: false });
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(__dirname, 'src', 'overlay', 'achievement.html'));
  overlayWindow.on('closed', () => { overlayWindow = null; });
  return overlayWindow;
}

function showAchievementOverlay(item) {
  try {
    const win = ensureOverlay();
    clearTimeout(overlayHideTimer);
    const send = () => {
      if (win.isDestroyed() || settings.get('achievement_popups') === false) return;
      win.showInactive();                       // visible without taking focus
      win.setAlwaysOnTop(true, 'screen-saver');
      win.webContents.send('overlay:achievement', item);
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
    // A belt-and-braces hide: if the page never reports itself idle (a crash,
    // a stalled renderer), the window must not stay over the game for ever.
    overlayHideTimer = setTimeout(() => { try { win.hide(); } catch {} }, 30000);
  } catch (e) {
    console.error('Achievement overlay failed:', e);
  }
}

ipcMain.on('overlay:idle', () => {
  clearTimeout(overlayHideTimer);
  try { overlayWindow?.hide(); } catch { /* already gone */ }
});

ipcMain.handle('achievements:fetchDefinitions', async (_e, game) => {
  const { generateGameInfo } = require('./src/core/autoCrack');
  return generateGameInfo(game?.install_path, game?.appid,
    (line) => sendToRenderer('crack:log', line),
    settings.get('steam_web_api_key') || '');
});

ipcMain.handle('achievements:snapshot', (_e, game) => {
  const achievements = require('./src/core/achievements');
  return achievements.snapshot(game || {});
});

/** Bring the window back from wherever the launcher put it. */
ipcMain.handle('window:restore', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  return true;
});

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.restore();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

ipcMain.handle('window:isMaximized', () => Boolean(mainWindow?.isMaximized()));

// Big Picture asks for real OS fullscreen so the couch UI owns the display.
// A frameless window is already borderless, but only setFullScreen hides the
// taskbar and stops the desktop showing through on a second monitor.
/**
 * Windows 11 draws a one-pixel border around every window, composited by DWM
 * outside anything the application paints. It survives a frameless window and
 * it survives fullscreen: measured on this machine with Big Picture filling a
 * 1920x1080 display, a solid grey line — RGB 54,54,54 on the left, 56 on the
 * right, 57 on top, 58 at the bottom — with the page's own pixels starting one
 * in from each edge. It never appears in a screenshot of the page, which is why
 * every measurement taken from inside the renderer came back perfect while the
 * thing was plainly visible on screen.
 *
 * Only DWM can turn it off and Electron has no binding for that, so a small
 * helper does it. Best-effort throughout: this is cosmetic, and no window
 * transition is worth failing over.
 */
function setWindowBorder(visible) {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    const exe = getDepsPath('librarian', 'librarian_winborder.exe');
    if (!fs.existsSync(exe)) return;

    const handle = mainWindow.getNativeWindowHandle();
    const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0));

    require('child_process').execFile(exe, [hwnd, visible ? 'on' : 'off'], () => {});
  } catch { /* the border staying is not a reason to break fullscreen */ }
}

/**
 * Make the client area actually be the display.
 *
 * setFullScreen reports success without always delivering it. From a maximised
 * window Windows can leave the client at the work area — measured, 1920x1032 on
 * a 1920x1080 display, with isFullScreen() true and the taskbar still drawn
 * over Big Picture. A frameless window that kept WS_THICKFRAME is inset by its
 * resize border instead. Both look identical from the page: a correct, full-size
 * layout with the desktop showing around it, and neither is visible to any
 * measurement the renderer can take — which is why this went unexplained for so
 * long.
 *
 * So the result is compared against the display and corrected, a few times,
 * because Windows finishes the transition asynchronously and can undo a
 * correction applied too early. Losing fullscreen while correcting would put
 * the taskbar back, so that is checked too.
 */
function fitToDisplay(attempt = 0) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Scheduled before any early exit. The first call lands while Windows is
  // still mid-transition and isFullScreen() is not true yet; returning without
  // arranging another pass is how the first version of this managed to never
  // run at all — measured, a 1600x900 client sitting inside a window that
  // reported itself fullscreen.
  const again = () => {
    if (attempt < 5) setTimeout(() => fitToDisplay(attempt + 1), 120 * (attempt + 1));
  };

  if (!mainWindow.isFullScreen()) { again(); return; }
  const { screen } = require('electron');

  const want = screen.getDisplayNearestPoint(mainWindow.getBounds()).bounds;
  const have = mainWindow.getContentBounds();
  const adrift = have.x !== want.x || have.y !== want.y
    || have.width !== want.width || have.height !== want.height;

  if (adrift) {
    try {
      mainWindow.setContentBounds({ x: want.x, y: want.y, width: want.width, height: want.height });
      if (!mainWindow.isFullScreen()) mainWindow.setFullScreen(true);
    } catch { /* the next pass tries again */ }
  }
  again();
}

ipcMain.handle('window:setFullScreen', (_, flag) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const wanted = Boolean(flag);

  // A frameless window on Windows keeps WS_THICKFRAME — its 8px resize border
  // — even in fullscreen, and the client area is inset by it. The result is a
  // strip down the left, right and bottom edges painted by the system in the
  // Windows theme colour, which the page has no way to cover: measured at
  // 1904x1072 of content inside a 1920x1080 window. Dropping the style while
  // fullscreen gives the renderer the whole screen (measured 1920x1080, no
  // gap). setKiosk has the same inset, so it is not an alternative.
  if (wanted) {
    // A minimised window cannot become fullscreen. Windows accepts the call and
    // leaves the result in a degenerate state — a small window pinned to the
    // top-left corner — which is what "Librarian never came back" looks like
    // after a game exits and Big Picture asks for fullscreen again.
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();

    // Maximised is not a state Windows goes fullscreen from cleanly: it keeps
    // the work area and reports success anyway. Measured: isFullScreen() true
    // with a 1920x1032 client on a 1920x1080 display — the missing 48px is the
    // taskbar, still on screen over Big Picture. Unmaximising first removes the
    // ambiguity, and costs nothing when the window is already plain.
    if (mainWindow.isMaximized()) mainWindow.unmaximize();

    if (!mainWindow.isFullScreen()) mainWindow.setFullScreen(true);
    mainWindow.setResizable(false);
    fitToDisplay();
    // Entering Big Picture from an already-fullscreen window fires no
    // enter-full-screen event, so the border has to be asked for here too.
    setWindowBorder(false);
  } else {
    mainWindow.setResizable(true);
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
  }
  return mainWindow.isFullScreen();
});

ipcMain.handle('window:isFullScreen', () => Boolean(mainWindow?.isFullScreen()));

// Drives the Windows taskbar / macOS dock progress indicator during downloads.
// -1 clears it; anything else is clamped to 0..1.
ipcMain.handle('window:setProgress', (_, value) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    mainWindow.setProgressBar(-1);
    return true;
  }
  mainWindow.setProgressBar(Math.min(1, numberValue));
  return true;
});

// Bounce the taskbar entry when a long job finishes while the app is in the
// background — the whole point being that you can alt-tab away mid-download.
ipcMain.handle('window:flash', () => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return false;
  try { mainWindow.flashFrame(true); } catch { return false; }
  return true;
});

ipcMain.handle('app:getVersion', () => app.getVersion());

// ─── Librarian's own updates (src/core/appUpdater.js) ────────────
ipcMain.handle('app-update:state', () => require('./src/core/appUpdater').getState());
ipcMain.handle('app-update:check', () => require('./src/core/appUpdater').check());
ipcMain.handle('app-update:install', async () => {
  const updater = require('./src/core/appUpdater');
  if (updater.getState().status !== 'ready') return false;
  // The installer starts closing Librarian within a second or two of being
  // launched. A download is stopped first, the way closing the window stops
  // it, so its progress is on disk before the process goes.
  if (currentDownload) await cancelCurrentDownload('Librarian restarted to install an update.');
  return updater.install();
});

// ─── Co-op presets (src/core/gamePresets.js) ─────────────────────
// Given the library, each preset also says where that game stands: missing,
// pending (set up at the next launch), off (online mode turned off) or ready.
ipcMain.handle('presets:list', (_, games) => {
  const presets = require('./src/core/gamePresets');
  const library = Array.isArray(games) ? games : [];
  return presets.list().map((preset) => {
    const game = library.find(g => g && String(g.appid) === preset.appid && typeof g.install_path === 'string' && g.install_path);
    return { ...preset, installed: Boolean(game), state: (game && presets.stateOf(game)) || 'missing' };
  });
});

// Free/total bytes for the volume a path lives on, so the UI can warn before a
// download that will not fit.
ipcMain.handle('system:diskSpace', (_, targetPath) => {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return null;
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const stats = fs.statfsSync(path.resolve(targetPath));
    const blockSize = Number(stats.bsize) || 0;
    return {
      free: Number(stats.bavail) * blockSize,
      total: Number(stats.blocks) * blockSize,
    };
  } catch {
    return null;
  }
});

// ─── Settings ────────────────────────────────────────────────────
ipcMain.handle('settings:get', (_, key) => settings.getPublic(key));
ipcMain.handle('settings:getAll', () => settings.getPublic());
function applyOverlayPreference() {
  if (settings.get('achievement_popups') !== false) return;
  clearTimeout(overlayHideTimer);
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  require('./src/core/overlayFeed').dismiss();
}
ipcMain.handle('settings:setMany', (_, values) => {
  settings.setMany(values);
  applyOverlayPreference();
  return settings.getPublic();
});
ipcMain.handle('settings:set', (_, key, value) => {
  settings.set(key, value);
  applyOverlayPreference();
  return true;
});

// ─── Native Dialogs ──────────────────────────────────────────────
ipcMain.handle('dialog:openFolder', async (_, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: options?.title || undefined,
    buttonLabel: options?.buttonLabel || undefined,
    defaultPath: typeof options?.defaultPath === 'string' && options.defaultPath ? options.defaultPath : undefined,
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:openFile', async (_, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: options?.filters || []
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:openImage', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

// ─── ZIP Processing ──────────────────────────────────────────────
ipcMain.handle('zip:process', async (_, zipPath, expectedAppId) => {
  try {
    const { processZip } = require('./src/core/zipProcessor');
    const gameData = await processZip(zipPath, expectedAppId);
    return { success: true, data: gameData };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('zip:cleanup', (_, manifestDir) => {
  const { cleanupManifestDir } = require('./src/core/zipProcessor');
  return cleanupManifestDir(manifestDir);
});

// ─── Depot Downloads ─────────────────────────────────────────────
let currentDownload = null;
let preparingDownload = false;
let downloadPreparationGeneration = 0;
let pendingDownloadAuthChallenge = null;
// Identifies the active download so a superseded/cancelled download's late
// callbacks are ignored and can't emit spurious complete/error events (which
// would double-advance the renderer queue).
let activeDownloadToken = 0;
let downloadTokenCounter = 0;

function resolvePendingDownloadAuthChallenge(response = { cancelled: true }) {
  if (!pendingDownloadAuthChallenge) return;
  pendingDownloadAuthChallenge.resolve(response);
  pendingDownloadAuthChallenge = null;
}

/**
 * One download at a time, whatever its source. Every engine that fills
 * `currentDownload` — SteamPipe, and the CS.RIN.RU hoster fetch — reports
 * through these callbacks, so the renderer sees one kind of download and the
 * queue advances the same way for both. The token makes a superseded job's
 * late callbacks inert.
 */
function createDownloadSession(jobId, details = {}) {
  const queue = require('./src/core/downloadQueue');
  queue.begin(jobId, details);
  resolvePendingDownloadAuthChallenge({ cancelled: true, byUser: true });
  const token = ++downloadTokenCounter;
  activeDownloadToken = token;
  const isCurrent = () => activeDownloadToken === token;
  const send = (channel, payload) => { if (isCurrent()) sendToRenderer(channel, payload); };
  const settle = () => {
    activeDownloadToken = 0;
    resolvePendingDownloadAuthChallenge({ cancelled: true, byUser: true });
    resolvePendingCsrinFolderChoice({ cancelled: true });
    currentDownload = null;
  };
  const finish = async (status, message = '') => {
    // Completion means file handles and workers have drained too. Do not let
    // the next job, launch or uninstall race the previous engine's finally.
    try { await currentDownload?.done; } catch { /* failure is reported below */ }
    if (!isCurrent()) return;
    let error = status === 'failed' ? message : '';
    try { queue.finish(status, message); }
    catch (saveError) { error = `Could not save download status: ${saveError.message}`; }
    settle();
    if (error) sendToRenderer('depot:error', error);
    else sendToRenderer('depot:complete');
  };
  const callbacks = {
    onProgress: (msg) => { if (isCurrent()) queue.progress('log', msg); send('depot:progress', msg); },
    onPercentage: (pct) => { if (isCurrent()) queue.progress('percent', pct); send('depot:percentage', pct); },
    onSpeed: (speed) => { if (isCurrent()) queue.progress('speed', speed); send('depot:speed', speed); },
    onPlan: (plan) => { if (isCurrent()) queue.progress('plan', plan); send('depot:plan', plan); },
    onDiskSpeed: (s) => send('depot:diskspeed', s),
    onTransferred: (bytes) => send('depot:transferred', bytes),
    onComplete: () => {
      if (!isCurrent()) return;
      void finish('complete');
    },
    onError: (err) => {
      if (!isCurrent()) return;
      void finish('failed', err);
    },
  };
  return { token, isCurrent, send, callbacks };
}

ipcMain.handle('depot:download', async (event, { gameData, selectedDepots, destPath, jobId }) => {
  if (currentDownload || preparingDownload) return { success: false, error: 'A download is already starting or in progress.' };
  preparingDownload = true;
  const generation = ++downloadPreparationGeneration;
  try {
    if (currentDownload) {
      return { success: false, error: 'A download is already in progress. Wait for it to finish or cancel it first.' };
    }

    // SteamPipe is the only Steam engine now. It needs zstd and an LZMA
    // decoder to read Valve's chunk formats; both ship with this build
    // (verified on Electron 41 / Node 24), but check anyway and fail with a
    // clear reason rather than dying partway through a download.
    try {
      const { checkNativeEngineSupport } = require('./src/core/steamPipe');
      const support = checkNativeEngineSupport();
      if (!support.ok) {
        return { success: false, error: `Download engine unavailable: ${support.missing.join('; ')}.` };
      }
    } catch (err) {
      return { success: false, error: `Download engine failed to load: ${err.message}` };
    }

    let target = null;
    const savedJob = require('./src/core/downloadQueue').snapshot().jobs.find(job => job.id === jobId);
    gameData = require('./src/core/downloadIdentity').validateDownload(savedJob, gameData, destPath);
    if (savedJob?.customGameId) {
      const associated = require('./src/core/customGameStore').getById(savedJob.customGameId);
      if (!associated) throw new Error('The associated Custom game no longer exists.');
      assertGameIdle(associated);
      const prepared = await require('./src/core/customGameUpdates').prepareDownload(savedJob.customGameId, savedJob.updateRevision, savedJob.targetBuildId, gameData, selectedDepots);
      gameData = prepared.gameData;
      target = prepared.target;
      destPath = target.installPath;
      if (!require('./src/core/downloadQueue').snapshot().jobs.some(job => job.id === jobId)) throw new Error('This download was removed from the queue.');
    }
    if (generation !== downloadPreparationGeneration || isQuitting || quitPending) throw new Error('Download preparation was cancelled.');
    const installPath = target?.installPath || (gameData.installdir ? path.join(destPath, 'steamapps', 'common', gameData.installdir) : gameData.install_path);
    assertGameIdle({ ...gameData, install_path: installPath });
    const session = createDownloadSession(jobId, { gameData, selectedDepots, destPath });
    const { startNativeDownload } = require('./src/core/steamPipe');
    currentDownload = startNativeDownload(gameData, selectedDepots, destPath, session.callbacks, target);
    return { success: true };
  } catch (err) {
    if (!currentDownload) { try { require('./src/core/downloadQueue').finish('failed', err.message); } catch {} }
    return { success: false, error: err.message };
  } finally {
    preparingDownload = false;
  }
});

ipcMain.handle('depot:pause', () => {
  if (!currentDownload) return false;
  // A source that cannot pause says so by returning false.
  const paused = currentDownload.markPaused() !== false;
  if (paused) require('./src/core/downloadQueue').pause(true);
  return paused;
});

ipcMain.handle('depot:resume', () => {
  if (!currentDownload) return false;
  const resumed = currentDownload.markResumed() !== false;
  if (resumed) require('./src/core/downloadQueue').pause(false);
  return resumed;
});

async function stopCurrentDownload() {
  resolvePendingDownloadAuthChallenge({ cancelled: true, byUser: true });
  resolvePendingCsrinFolderChoice({ cancelled: true });
  if (currentDownload) {
    // Invalidate first so the download's own onError/onComplete (fired as it unwinds)
    // is ignored and cannot emit a spurious event that double-advances the queue.
    activeDownloadToken = 0;
    const stopping = currentDownload;
    stopping.stop();
    try { if (stopping.done) await stopping.done; }
    catch (error) { console.error('Download stopped with an error:', error.message); }
    currentDownload = null;
    return true;
  }
  return false;
}
async function cancelCurrentDownload(reason = 'Cancelled by user') {
  downloadPreparationGeneration++;
  const queue = require('./src/core/downloadQueue');
  const active = queue.snapshot().active;
  let saveError;
  try { if (active?.jobId != null) queue.patch(active.jobId, { status: 'interrupted', error: reason }); }
  catch (error) { saveError = error; }
  // Keep the active installation locked until cancellation has drained.
  // A full disk must not prevent stopping the engine that is filling it.
  const stopped = await stopCurrentDownload();
  try { queue.finish('interrupted', reason); }
  catch (error) { saveError = error; }
  if (saveError) throw saveError;
  return stopped;
}
ipcMain.handle('depot:cancel', () => cancelCurrentDownload());
ipcMain.handle('queue:snapshot', () => require('./src/core/downloadQueue').snapshot());
ipcMain.handle('queue:add', (_, job) => require('./src/core/downloadQueue').add(job));
ipcMain.handle('queue:patch', (_, id, updates) => require('./src/core/downloadQueue').patch(id, updates));
ipcMain.handle('queue:remove', (_, id) => require('./src/core/downloadQueue').remove(id));

ipcMain.handle('depot:authResponse', (_, response) => {
  if (!pendingDownloadAuthChallenge) {
    return { success: false, error: 'No Steam login challenge is pending.' };
  }

  resolvePendingDownloadAuthChallenge(response || { cancelled: true });
  return { success: true };
});

// ─── Manifest sources: Hubcap and steammanifest ──────────────────
// Hubcap is a service with a key; steammanifest (src/core/steamManifest.js)
// is the user's own project, vendored under deps/steammanifest, that builds
// the same package from Steam. The Manifest source setting says which:
// Hubcap alone, the local source alone, or Auto — Hubcap when a key is set,
// its package checked against Steam's current manifests and re-assembled
// when a depot is behind, the local source alone when there is no key or
// Hubcap fails. Both packages land in userData/hubcap_manifests, so the
// queue, zipProcessor and cleanup never learn which source made one.
function manifestSourceState() {
  const local = require('./src/core/steamManifest');
  const mode = settings.get('manifest_source') || 'auto';
  const hasKey = Boolean(settings.get('hubcap_api_key'));
  const status = local.status();
  return { mode, hasKey, status, sources: local.sourceOrder({ mode, hasKey, available: status.available }) };
}

ipcMain.handle('steammanifest:status', () => {
  try {
    const { mode, hasKey, status, sources } = manifestSourceState();
    return { ...status, mode, hasKey, sources };
  } catch (err) {
    return { available: false, error: err.message, mode: 'auto', hasKey: false, sources: [] };
  }
});

async function searchManifestSources(query) {
  const hubcap = require('./src/core/hubcapApi');
  const local = require('./src/core/steamManifest');
  const { sources } = manifestSourceState();
  if (!sources.length) return { error: 'No manifest source: add a Hubcap API key in Settings, or restore the steammanifest folder.', results: [] };
  const asks = sources.map((source) => source === 'hubcap'
    ? hubcap.searchGames(query, settings.get('hubcap_api_key') || '')
    : local.searchGames(query));
  const answers = await Promise.all(asks.map((p) => p.catch((err) => ({ error: err.message, results: [] }))));
  const good = answers.filter((a) => a && !a.error);
  if (!good.length) return { error: answers.map((a, i) => `${sources[i] === 'hubcap' ? 'Hubcap' : 'Steam'}: ${a?.error || 'no answer'}`).join(' · '), results: [] };
  const results = local.unionResults(...good.map((a) => a.results || []));
  const failed = answers.map((a, i) => (a && (a.error || a.warning) ? `${sources[i] === 'hubcap' ? 'Hubcap' : 'Steam'}: ${a.error || a.warning}` : '')).filter(Boolean);
  return failed.length ? { results, warning: failed.join(' · ') } : { results };
}

ipcMain.handle('hubcap:search', (_, query) => searchManifestSources(query));

// Deliberately not coalesced by app: every fetch gets its own file, because
// the caller owns it — a queue job deletes its package when it finishes, and
// two jobs sharing one path would delete the file the other still needs.
ipcMain.handle('hubcap:download', (_, appId) => fetchManifestPackage(appId));

async function fetchManifestPackage(appId) {
  const hubcap = require('./src/core/hubcapApi');
  const local = require('./src/core/steamManifest');
  const onLog = (line) => sendToRenderer('steammanifest:log', line);
  const { sources } = manifestSourceState();
  if (!sources.length) return { filepath: null, error: 'No manifest source: add a Hubcap API key in Settings, or restore the steammanifest folder.' };

  if (sources[0] === 'steammanifest') return local.downloadManifest(appId, { onLog });

  const hub = await hubcap.downloadManifest(appId, settings.get('hubcap_api_key') || '');
  if (!sources.includes('steammanifest')) return hub;
  if (hub.error) {
    onLog(`⚠ Hubcap: ${hub.error} — asking Steam through steammanifest instead.`);
    return local.downloadManifest(appId, { onLog });
  }

  // Hubcap answered. Is its package what Steam serves today?
  const fresh = await local.refresh(appId, hub.filepath, { onLog });
  if (fresh.filepath) {
    try { fs.unlinkSync(hub.filepath); } catch { /* the newer package is what matters */ }
    return { ...hub, filepath: fresh.filepath, source: 'steammanifest', stale: false, note: fresh.note, behind: fresh.behind, buildid: fresh.buildid };
  }
  if (fresh.stale) {
    onLog(`⚠ Using Hubcap's older package: ${fresh.error}`);
    return { ...hub, source: 'hubcap', stale: true, behind: fresh.behind, note: `Hubcap's package is behind Steam on ${fresh.behind.length} depot(s) and the latest could not be assembled — ${fresh.error}` };
  }
  if (fresh.error) onLog(`⚠ Could not check Hubcap's package against Steam: ${fresh.error}`);
  return { ...hub, source: 'hubcap', stale: false, note: fresh.checked ? fresh.note : '' };
}

// ─── CS.RIN.RU ──────────────────────────────────────────────────
// The second source; see src/core/csrin.js. Credentials stay here: the
// renderer asks for a search and gets posts back, never the password. A
// download from it fills the same `currentDownload` slot as SteamPipe and
// reports on the same channels, so the queue needs no second engine.
let csrinSearchRunning = false;

// When an archive holds several folders and none is named after the game,
// the person picks. The download job waits on this, like it waits on a
// Steam login challenge; cancelling the job answers it.
let pendingCsrinFolderChoice = null;

function resolvePendingCsrinFolderChoice(response = { cancelled: true }) {
  if (!pendingCsrinFolderChoice) return;
  pendingCsrinFolderChoice.resolve(response);
  pendingCsrinFolderChoice = null;
}

ipcMain.handle('csrin:chooseFolder', (_, response) => {
  if (!pendingCsrinFolderChoice) return { success: false, error: 'No archive is waiting for a folder to be chosen.' };
  const folder = typeof response?.folder === 'string' ? response.folder : '';
  resolvePendingCsrinFolderChoice(folder ? { folder } : { cancelled: true });
  return { success: true };
});

ipcMain.handle('csrin:status', () => {
  try { return require('./src/core/csrin').status(); }
  catch (err) { return { cliExists: false, dlExists: false, error: err.message }; }
});

ipcMain.handle('csrin:search', async (_, opts = {}) => {
  if (csrinSearchRunning) return { ok: false, error: 'A forum search is already running.', topics: [], posts: [] };
  csrinSearchRunning = true;
  try {
    const csrin = require('./src/core/csrin');
    const game = typeof opts.game === 'string' ? opts.game.trim().slice(0, 200) : '';
    const topicUrl = typeof opts.topicUrl === 'string' && /^https?:\/\/cs\.rin\.ru\//i.test(opts.topicUrl.trim())
      ? opts.topicUrl.trim().slice(0, 400) : '';
    const topicId = /^\d{1,12}$/.test(String(opts.topicId || '').trim()) ? String(opts.topicId).trim() : '';
    const author = (typeof opts.author === 'string' && opts.author.trim().slice(0, 64))
      || settings.get('csrin_author') || 'ARTIFACT';
    return await csrin.search({
      game, topicUrl, topicId, author,
      username: settings.get('csrin_username') || '',
      password: settings.get('csrin_password') || '',
      scanAll: Boolean(opts.scanAll),
      onLog: (line) => sendToRenderer('csrin:log', line),
    });
  } catch (err) {
    return { ok: false, error: err.message, topics: [], posts: [] };
  } finally {
    csrinSearchRunning = false;
  }
});

ipcMain.handle('csrin:cancelSearch', () => {
  try { return require('./src/core/csrin').cancelSearch(); }
  catch { return false; }
});

// A release names the patch it was made for, not a Steam build (ARTIFACT
// states none), so that is what an install is compared on. The user's word
// for the installed patch wins over the inference, but only for the build it
// was given on: an update makes it stale.
function storedPatch(game) {
  const meta = require('./src/core/gameMetaStore');
  const key = meta.gameKey(game);
  const p = key ? meta.getByKey(key).patch : null;
  if (!p || !p.version) return null;
  if (p.build && String(p.build) !== String(game.buildid || '')) return null;
  return { version: p.version, source: p.source || 'declared', date: p.at || 0 };
}

function recordPatch(game, version, source) {
  const meta = require('./src/core/gameMetaStore');
  const key = meta.gameKey(game);
  if (!key) return null;
  const v = String(version || '').trim();
  return meta.setByKey(key, { patch: v ? { version: v, build: String(game.buildid || ''), source, at: Date.now() } : null });
}

ipcMain.handle('csrin:installedPatch', async (_, game = {}) => {
  try {
    const stored = storedPatch(game);
    if (stored) return stored;
    return await require('./src/core/patchVersion').installedPatch({ appid: game.appid, installPath: game.install_path });
  } catch (err) {
    return { version: '', source: 'unknown', error: err.message };
  }
});

ipcMain.handle('csrin:setInstalledPatch', (_, game = {}, version = '') => {
  try {
    const v = String(version || '').trim();
    if (v && !require('./src/core/patchVersion').versionKey(v)) return { success: false, error: 'A patch number is digits and dots, like 2.03.02.' };
    recordPatch(game, v, 'declared');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// The patch of the public build: what a download or an update lands on.
ipcMain.handle('csrin:targetPatch', async (_, appid) => {
  try {
    const id = String(appid || '').trim();
    let liveTime = 0;
    let buildid = '';
    try {
      const remote = await require('./src/core/updateChecker').fetchRemote(id);
      liveTime = remote?.remoteBuildTime || 0;
      buildid = remote?.remoteBuildId || '';
    } catch { /* falls back to the newest notes */ }
    const p = await require('./src/core/patchVersion').targetPatch(id, liveTime);
    return { ...p, buildid };
  } catch (err) {
    return { version: '', source: 'unknown', error: err.message };
  }
});

ipcMain.handle('csrin:download', async (_, opts = {}) => {
  try {
    if (currentDownload) {
      return { success: false, error: 'A download is already in progress. Wait for it to finish or cancel it first.' };
    }
    const csrin = require('./src/core/csrin');
    const st = csrin.status();
    if (!st.dlExists) return { success: false, error: `CS.RIN.RU downloader not found at ${st.dlPath}` };

    const url = typeof opts.url === 'string' ? opts.url.trim() : '';
    if (!csrin.isExternalLink(url)) return { success: false, error: 'That is not a downloadable link.' };
    const outputDir = typeof opts.outputDir === 'string' && opts.outputDir.trim()
      ? path.resolve(opts.outputDir.trim())
      : (settings.get('csrin_download_dir') || st.downloadDir);
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.accessSync(outputDir, fs.constants.W_OK);
    } catch (err) {
      return { success: false, error: `Cannot write to ${outputDir}: ${err.message}` };
    }

    // Into a game, or only onto disk. A release is made for one patch; the
    // renderer already refuses a mismatch, and so does this, because the
    // thing at stake is the game's own files. A post that names no patch
    // falls back to its build id, which is all an older post may state.
    const extractTo = typeof opts.extractTo === 'string' && opts.extractTo.trim() ? path.resolve(opts.extractTo.trim()) : '';
    const gameName = typeof opts.gameName === 'string' ? opts.gameName : '';
    const expectedBuild = String(opts.expectedBuild || '').trim();
    const postBuild = String(opts.postBuild || '').trim();
    const expectedVersion = String(opts.expectedVersion || '').trim();
    const postVersion = String(opts.postVersion || '').trim();
    const { versionKey, sameVersion } = require('./src/core/patchVersion');
    if (extractTo) {
      if (!fs.existsSync(extractTo) || !fs.statSync(extractTo).isDirectory()) {
        return { success: false, error: `The game folder does not exist: ${extractTo}` };
      }
      if (versionKey(postVersion)) {
        if (versionKey(expectedVersion) && !sameVersion(expectedVersion, postVersion)) {
          return { success: false, error: `This release is for patch ${postVersion}; the installed game is patch ${expectedVersion}. Update or downgrade the game first.` };
        }
      } else if (expectedBuild && postBuild && expectedBuild !== postBuild) {
        return { success: false, error: `This release is for build ${postBuild}; the installed game is build ${expectedBuild}. Update or downgrade the game first.` };
      }
      if (!st.tarExists) return { success: false, error: `bsdtar not found at ${st.tarPath}; archives cannot be opened.` };
    }

    assertGameIdle({ appid: opts.appid, install_path: extractTo });
    const session = createDownloadSession(opts.jobId, { destPath: outputDir, extractTo, name: gameName });
    const sha256 = /^[0-9a-f]{64}$/i.test(String(opts.sha256 || '')) ? String(opts.sha256).toLowerCase() : '';
    currentDownload = csrin.download({
      url, outputDir, sha256,
      // Only used for a forum attachment, which the forum serves to members.
      username: settings.get('csrin_username') || '',
      password: settings.get('csrin_password') || '',
    }, {
      onLog: (line) => session.callbacks.onProgress(line),
      onEvent: (event) => session.send('csrin:event', event),
      onProgress: (p) => {
        if (p.percent !== null && p.percent !== undefined) session.callbacks.onPercentage(p.percent);
        if (p.speed) session.callbacks.onSpeed(p.speed);
        if (Number.isFinite(p.downloadedBytes)) session.callbacks.onTransferred(p.downloadedBytes);
      },
      onComplete: async (r) => {
        session.callbacks.onProgress(`✅ Saved ${r.filename || ''} to ${r.filepath}`);
        if (!extractTo) { session.callbacks.onComplete(); return; }
        if (!session.isCurrent()) return;
        try {
          session.callbacks.onProgress(`📦 Opening ${r.filename || 'the archive'} for ${extractTo}…`);

          // Which folder is the game. Decided here, before the extraction
          // event, so an archive nobody can decide for is put to the person
          // rather than failed: several folders, none named after the game.
          let folder = '';
          const entries = await csrin.listArchive(r.filepath);
          const choice = csrin.pickGameFolder(entries, { installPath: extractTo, gameName });
          if (choice.mode === 'ambiguous') {
            const folders = csrin.describeFolders(entries, choice.folders);
            session.callbacks.onProgress(`❓ ${r.filename || 'The archive'} holds several folders (${choice.folders.join(', ')}) and none is named after the game — waiting for you to pick the game's.`);
            session.send('csrin:event', { event: 'choose_folder', folders, archive: r.filename || path.basename(r.filepath), extractTo, gameName });
            const answer = await new Promise((resolve) => { pendingCsrinFolderChoice = { resolve }; });
            if (!session.isCurrent()) return;
            if (answer.cancelled || !answer.folder) {
              session.callbacks.onProgress(`⏭ No folder chosen — ${r.filename || 'the archive'} is kept in ${path.dirname(r.filepath)} and nothing was placed into the game.`);
              session.callbacks.onComplete();
              return;
            }
            folder = answer.folder;
            session.callbacks.onProgress(`📂 You chose "${folder}".`);
          }

          session.send('csrin:event', { event: 'extract_start', filepath: r.filepath, extractTo });
          // The release is built on the game's own Steam library; an
          // emulator the auto-crack left in its place is put aside first.
          csrin.restoreEmulatorBackups(extractTo, (line) => session.callbacks.onProgress(line));
          const res = await csrin.extractInto(r.filepath, extractTo, {
            gameName,
            folder,
            onLog: (line) => session.callbacks.onProgress(line),
          });
          session.callbacks.onProgress(`✅ ${res.files} file(s) placed into the game${res.replaced ? `; ${res.replaced} original(s) kept as ${csrin.BACKUP_SUFFIX}` : ''}.`);
          // The release was made for this patch and now runs on this build:
          // the best record of the installed patch there is.
          if (versionKey(postVersion)) {
            const ref = { appid: opts.appid, id: opts.gameId || '', source: opts.gameSource || 'Steam', install_path: extractTo, buildid: expectedBuild };
            try { recordPatch(ref, postVersion, 'release'); } catch {}
          }
          session.send('csrin:event', { event: 'extract_complete', ...res, extractTo });
          session.callbacks.onComplete();
        } catch (err) {
          session.callbacks.onError(`Extraction failed: ${err.message}`);
        }
      },
      onError: (err) => session.callbacks.onError(err && err.message ? err.message : String(err)),
    });
    return { success: true, outputDir, extractTo };
  } catch (err) {
    if (!currentDownload) { try { require('./src/core/downloadQueue').finish('failed', err.message); } catch {} }
    return { success: false, error: err.message };
  }
});

// ─── What's new ─────────────────────────────────────────────────
// Fetched here so the forum's cookie challenge and the appdetails cache
// live in one place; the renderer decides what is unseen and shows it.
let newsInFlight = null;
ipcMain.handle('news:fetch', (_, opts = {}) => {
  if (newsInFlight) return newsInFlight;
  const { getNews } = require('./src/core/newsFeed');
  newsInFlight = getNews({
    author: settings.get('csrin_author') || 'ARTIFACT',
    pages: Math.max(1, Math.min(3, Number(opts.pages) || 1)),
  }).catch((err) => ({ checkedAt: Date.now(), denuvo: { ok: false, items: [], error: err.message }, csrin: { ok: false, items: [], error: err.message } }))
    .finally(() => { newsInFlight = null; });
  return newsInFlight;
});

// ─── Steam Helpers ───────────────────────────────────────────────
ipcMain.handle('steam:findInstall', () => {
  const { findSteamInstall } = require('./src/core/steamHelpers');
  return findSteamInstall();
});

ipcMain.handle('steam:getLibraries', () => {
  const { getSteamLibraries } = require('./src/core/steamHelpers');
  return getSteamLibraries();
});

// ─── Game Library ────────────────────────────────────────────────
ipcMain.handle('game:scan', async () => {
  // A client loader that crashed leaves SteamPath on its own folder, and the
  // library then shows only custom games. Put it back before scanning, when
  // no game is running that could still need it. This used to run inside
  // the scan and was lost when the scan moved into a worker.
  try {
    if (!require('./src/core/launcher').getRunning().length) {
      const r = require('./src/core/steamHelpers').repairSteamRegistry();
      if (r.repaired) sendToRenderer('depot:progress', `🔧 Steam's registry entry pointed at ${r.from}; set back to ${r.to}.`);
    }
  } catch { /* the scan still validates SteamPath on its own */ }
  return (await require('./src/core/libraryService').scan()).games;
});
ipcMain.handle('game:cached', () => require('./src/core/libraryService').cached());

ipcMain.handle('game:detectAppId', (_, gamePath) => {
  const { detectAppId } = require('./src/core/gameManager');
  return detectAppId(gamePath);
});

ipcMain.handle('game:suggestAppId', (_, gameName) => searchManifestSources(gameName));

ipcMain.handle('game:folderSize', (_, dirPath) => {
  const { calculateFolderSize } = require('./src/core/gameManager');
  return calculateFolderSize(dirPath);
});

// ─── Custom Game CRUD ────────────────────────────────────────────
ipcMain.handle('customGame:add', (_, gameData) => {
  const customStore = require('./src/core/customGameStore');
  return customStore.add(gameData);
});

ipcMain.handle('customGame:update', (_, id, updates) => {
  const customStore = require('./src/core/customGameStore');
  assertGameIdle(customStore.getById(id));
  return customStore.update(id, updates);
});

ipcMain.handle('customGame:inspectUpdates', (_, id, options) => require('./src/core/customGameUpdates').inspect(id, options || {}));
ipcMain.handle('customGame:associateUpdates', (_, id, options) => {
  assertGameIdle(require('./src/core/customGameStore').getById(id));
  return require('./src/core/customGameUpdates').associate(id, options || {});
});
ipcMain.handle('customGame:disconnectUpdates', (_, id) => {
  assertGameIdle(require('./src/core/customGameStore').getById(id));
  return require('./src/core/customGameUpdates').disconnect(id);
});
ipcMain.handle('customGame:refreshUpdates', (_, id) => {
  const game = require('./src/core/customGameStore').getById(id);
  if (!game) throw new Error('Custom game no longer exists.');
  return require('./src/core/customGameUpdates').decorate(game);
});

ipcMain.handle('customGame:remove', (_, id) => {
  const customStore = require('./src/core/customGameStore');
  return customStore.remove(id);
});

ipcMain.handle('game:uninstall', (_, gameData) => {
  try { assertGameIdle(gameData); } catch (error) { return { success: false, error: error.message }; }
  const { uninstallGame } = require('./src/core/gameManager');
  return uninstallGame(gameData);
});

// ─── Launch Game ─────────────────────────────────────────────────
// Default behaviour launches the game's executable directly (tracking
// playtime), only falling back to the Steam client or the install folder
// when no runnable executable can be found.
ipcMain.handle('game:launch', async (_, gameData) => {
  let lockedKey;
  try {
    const launcher = require('./src/core/launcher');
    const data = gameData || {};
    assertGameIdle(data, { allowRunning: true });
    lockedKey = operationKey(data);
    gameOperations.add(lockedKey);
    if (data.install_path && fs.existsSync(data.install_path)) await require('./src/core/dlssg').checkLaunch(data);
    const appId = String(data.appid || '').trim();
    const canSteam = /^\d{1,20}$/.test(appId) && appId !== '0';
    const launchMode = settings.get('launch_mode') || 'exe';

    // Explicit Steam preference wins when a valid AppID exists.
    if (launchMode === 'steam' && canSteam) {
      await shell.openExternal(`steam://rungameid/${appId}`);
      return { success: true, method: 'steam' };
    }

    // GreenLuma mode: play as if you owned it, through the real client. This is
    // the only path that can join a friend who genuinely owns the game — see
    // src/core/greenLuma.js. It puts the game into a genuine-steam_api state
    // (undoing Spacewar), ensures the client is up with GreenLuma injected, and
    // launches under the real App ID.
    if (launchMode === 'greenluma') {
      try {
        const greenLuma = require('./src/core/greenLuma');
        const exe = launcher.resolveExecutable(data);
        const r = await greenLuma.launch(data, exe);
        if (r.success && r.restarted) {
          sendToRenderer('greenluma:restarted', { name: data.game_name || '' });
        }
        return r;
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    // A co-op preset (src/core/gamePresets.js) that the download could not
    // apply — the game came from elsewhere, an older Librarian, or a step that
    // failed — gets its turn now, before online mode is checked below.
    try {
      const presets = require('./src/core/gamePresets');
      if (settings.get('game_presets') !== false && presets.pending(data)) {
        const r = presets.apply(data, { exe: launcher.resolveExecutable(data), playerName: settings.get('online_player_name') });
        if (r.applied || r.error) sendToRenderer('preset:applied', { name: r.name || data.game_name || '', labels: r.labels || [], error: r.error || '' });
      }
    } catch { /* never block a launch over this */ }

    // A game update rewrites steam_api64.dll and the EOS SDK with the
    // publisher's originals, silently undoing online mode. Launch is the one
    // moment we are guaranteed to be here before it matters, so the intent
    // recorded on disk is reconciled with reality now rather than leaving the
    // player to discover co-op stopped working.
    try {
      const onlineMode = require('./src/core/onlineMode');
      const exe = launcher.resolveExecutable(data);
      if (data.install_path && exe) {
        const r = onlineMode.reapplyIfNeeded(data.install_path, exe, settings.get('online_player_name'));
        if (r.reapplied) {
          sendToRenderer('online:reapplied', {
            name: data.game_name || '',
            reasons: r.reasons,
            success: !!(r.result && r.result.success),
          });
          if (r.result && !r.result.success) return { success: false, error: r.result.error || 'Online compatibility could not be restored. Switch to offline mode before launching.' };
        }
      }
    } catch { /* never block a launch over this */ }

    const direct = await launcher.launchDirect(data);
    if (direct.success) return direct;

    // No runnable executable auto-detected. Rather than silently opening Steam
    // (the user asked to launch the exe directly), let the renderer offer an
    // executable picker — with Steam/folder as explicit alternatives.
    if (direct.error === 'no-exe') {
      const installPath = typeof data.install_path === 'string' ? data.install_path : '';
      return {
        success: false,
        code: 'no-exe',
        canSteam,
        hasFolder: Boolean(installPath && fs.existsSync(installPath)),
        error: 'No runnable executable was found for this game.',
      };
    }

    return { success: false, error: direct.error || 'Could not launch this game.' };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (lockedKey !== undefined) gameOperations.delete(lockedKey);
  }
});

// Stop a running tracked game.
ipcMain.handle('game:stop', (_, gameKey) => {
  const launcher = require('./src/core/launcher');
  return launcher.stopGame(gameKey);
});

// List currently-running tracked games.
ipcMain.handle('game:running', () => {
  const launcher = require('./src/core/launcher');
  return launcher.getRunning();
});

// ─── Tuning ──────────────────────────────────────────────────────
// The performance mode's page talks to src/core/tuning.js through these; the
// live measurements and the A/B test's progress come back as tuning:* events.
{
  const tuning = require('./src/core/tuning');
  tuning.onLog = (line) => console.log('[tuning]', line);
  tuning.subscribe((type, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(`tuning:${type}`, payload);
  });
  ipcMain.handle('tuning:state', (_, gameKey) => tuning.getState(gameKey));
  ipcMain.handle('tuning:setProfile', (_, patch) => tuning.setProfile(patch));
  ipcMain.handle('tuning:setOverride', (_, gameKey, value) => tuning.setOverride(gameKey, value));
  ipcMain.handle('tuning:setLive', (_, pid, live) => tuning.setLive(pid, live));
  ipcMain.handle('tuning:runAB', async (_, opts) => {
    try { return { success: true, result: await tuning.runAB(opts || {}) }; }
    catch (err) { return { success: false, error: err.message }; }
  });
  ipcMain.handle('tuning:cancelAB', () => tuning.cancelAB());
}

// ─── Emulator compatibility ──────────────────────────────────────
// What the game panel and the Crack page read (src/core/emuCompat.js): the
// installed emulator, the newest release, and for a game the set difference
// between what its build asks for and what the emulator implements; and the
// two actions — update the emulator, or update it and apply it to a game.
{
  const emuCompat = require('./src/core/emuCompat');
  ipcMain.handle('emu:status', async (_, game) => {
    try {
      const emulator = emuCompat.emulatorInfo();
      const latest = await emuCompat.latestRelease();
      const out = { ok: true, emulator: { ...emulator, interfaces32: undefined }, latest };
      if (game && game.install_path) {
        out.check = emuCompat.check(game.install_path);
        out.block = emuCompat.blockFor(game);
      }
      return out;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('emu:update', async () => {
    const log = [];
    try {
      const r = await emuCompat.updateEmulator({ onLog: (m) => { log.push(m); sendToRenderer('crack:log', m); } });
      return { success: r.success, changed: r.changed, log, after: { commit: r.after.commit, date: r.after.date, interfaces: r.after.interfaces64.length } };
    } catch (err) {
      return { success: false, error: err.message, log };
    }
  });
  ipcMain.handle('emu:recrack', async (_, game) => {
    const log = [];
    const onLog = (m) => { log.push(m); sendToRenderer('crack:log', m); };
    try {
      if (!game || !game.install_path) return { success: false, error: 'no install path', log };
      const gate = await emuCompat.ensureCompatible(game.install_path, { onLog });
      if (!gate.ok) {
        if (gate.reason === 'incompatible') emuCompat.recordBlock(game, { missing: gate.missing, source: 'manual', emulatorDate: gate.check.emulatorDate, blocked: gate.blocked, updateError: gate.updateError });
        return { success: false, error: gate.blocked ? 'Windows Defender blocked the emulator download' : gate.reason, missing: gate.missing, updated: gate.updated, blocked: gate.blocked, log };
      }
      const { crackGame } = require('./src/core/autoCrack');
      const r = await crackGame({ gamePath: game.install_path, appId: String(game.appid || ''), onLog });
      if (r && r.success) emuCompat.clearBlock(game);
      return { success: Boolean(r && r.success), error: r && !r.success ? (r.error || `exit code ${r.exitCode}`) : undefined, updated: gate.updated, log };
    } catch (err) {
      return { success: false, error: err.message, log };
    }
  });
}

// Rank candidate executables inside a game's install folder.
ipcMain.handle('game:detectExecutables', (_, gameData) => {
  const launcher = require('./src/core/launcher');
  const data = gameData || {};
  return launcher.detectExecutables(data.install_path, data.game_name);
});

// Persist a chosen executable override for a game.
ipcMain.handle('game:setExecutable', (_, gameData, executable) => {
  const meta = require('./src/core/gameMetaStore');
  const key = meta.gameKey(gameData || {});
  if (!key) return { success: false, error: 'Cannot identify this game.' };
  meta.setExecutable(key, executable || '');
  return { success: true };
});

// Read/reset playtime metadata.
ipcMain.handle('game:getMeta', (_, gameData) => {
  const meta = require('./src/core/gameMetaStore');
  return meta.get(gameData || {});
});

// ─── Store artwork resolution ────────────────────────────────────
// Steam moved capsule art to content-hashed URLs; the legacy CDN path 404s for
// newer apps. This finds whatever actually exists and caches the answer.
ipcMain.handle('art:resolve', async (_, appId) => {
  const { resolveArt } = require('./src/core/artResolver');
  return resolveArt(appId);
});

ipcMain.handle('art:clearCache', () => {
  const { clearArtCache } = require('./src/core/artResolver');
  return clearArtCache();
});

// Which of these artwork URLs actually exists. Answered from a cache that
// outlives the session, because the legacy CDN returns its 404s with no
// cache-control and Chromium therefore re-requests every missing poster, logo
// and header on every single launch.
ipcMain.handle('art:probe', async (_, urls) => {
  const { firstThatExists } = require('./src/core/artProbe');
  return firstThatExists(Array.isArray(urls) ? urls : [urls]);
});

ipcMain.handle('art:probeStats', () => require('./src/core/artProbe').stats());

// ─── DLC ──────────────────────────────────────────────────────────
ipcMain.handle('dlc:status', (_, gamePath) => {
  const { status } = require('./src/core/dlcUnlocker');
  return status(gamePath);
});

ipcMain.handle('dlc:list', async (_, appId) => {
  const { listDlc } = require('./src/core/dlcUnlocker');
  return listDlc(appId);
});

ipcMain.handle('dlc:apply', async (_, options = {}) => {
  const { listDlc, apply } = require('./src/core/dlcUnlocker');
  const { gamePath, appId, unlockAll = true } = options;

  // The names are fetched here rather than asked of the renderer, so a game
  // that enumerates its DLC by index still gets real titles in its own menus
  // even when the list was never opened.
  let items = Array.isArray(options.items) ? options.items : null;
  if (!items) {
    const found = await listDlc(appId);
    items = found.items;
  }
  return apply(gamePath, { unlockAll, items });
});

ipcMain.handle('dlc:disable', (_, gamePath) => {
  const { disable } = require('./src/core/dlcUnlocker');
  return disable(gamePath);
});

// ─── Install plan (what's inside a game) ─────────────────────────
ipcMain.handle('depot:inventory', async (_, { gameData, selectedDepots }) => {
  try {
    const { buildInventory } = require('./src/core/depotInventory');
    return buildInventory(gameData, Array.isArray(selectedDepots) ? selectedDepots : []);
  } catch (err) {
    return { ok: false, error: err.message, groups: [] };
  }
});

// ─── Patch notes / announcements ─────────────────────────────────
ipcMain.handle('news:patchNotes', async (_, appId) => {
  const { getPatchNotes } = require('./src/core/steamNews');
  return getPatchNotes(appId);
});

// ─── Steam Media (trailers, screenshots, description) ────────────
ipcMain.handle('steam:getGameMedia', async (_, appId) => {
  const { getGameMedia } = require('./src/core/steamApi');
  return getGameMedia(appId);
});

// ─── Store discovery (what is selling, new, and rated) ───────────
ipcMain.handle('store:getFront', async (_, opts) => {
  const { getStoreFront } = require('./src/core/storeFront');
  return getStoreFront(opts || {});
});

ipcMain.handle('game:uninstallMessage', (_, gameData) => {
  const { getUninstallMessage } = require('./src/core/gameManager');
  return getUninstallMessage(gameData);
});

ipcMain.handle('game:checkUpdate', async (_, appId, localBuildId, options) => {
  const { checkForUpdate } = require('./src/core/updateChecker');
  return checkForUpdate(appId, localBuildId, options || {});
});

ipcMain.handle('game:checkAllUpdates', async (_, games, options) => {
  const { checkAllUpdates } = require('./src/core/updateChecker');
  return checkAllUpdates(games, options || {});
});

// ─── Steam API ───────────────────────────────────────────────────
ipcMain.handle('steam:getDepotInfo', async (_, appId) => {
  const { getDepotInfoFromApi } = require('./src/core/steamApi');
  return getDepotInfoFromApi(appId);
});

// ─── Shell ───────────────────────────────────────────────────────
ipcMain.handle('shell:openExternal', async (_, url) => {
  if (typeof url !== 'string') return 'Invalid URL';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Only http/https links can be opened';
    }
    await shell.openExternal(parsed.href);
    return '';
  } catch (err) {
    return err.message;
  }
});

// Delete a fetched manifest zip — but only inside userData/hubcap_manifests
// (both sources write there), so a user-dropped zip elsewhere is never removed.
ipcMain.handle('manifest:cleanupFetched', (_, filePath) => {
  if (typeof filePath !== 'string' || !filePath.trim()) return false;
  try {
    const managedDir = path.resolve(app.getPath('userData'), 'hubcap_manifests');
    const resolved = path.resolve(filePath);
    const relative = path.relative(managedDir, resolved);
    const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    if (!inside) return false;
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      fs.unlinkSync(resolved);
      return true;
    }
    return false;
  } catch {
    return false;
  }
});

ipcMain.handle('shell:openPath', (_, p) => {
  if (typeof p !== 'string' || !p.trim()) return 'Invalid path';

  try {
    const resolvedPath = path.resolve(p);
    if (!fs.existsSync(resolvedPath)) return 'Path does not exist';

    const stat = fs.statSync(resolvedPath);
    if (stat.isDirectory()) return shell.openPath(resolvedPath);

    shell.showItemInFolder(resolvedPath);
    return '';
  } catch (err) {
    return err.message;
  }
});

ipcMain.handle('app:getPath', (_, name) => {
  if (name === 'deps') return getDepsRoot();
  if (name === 'goldberg') return getDepsPath('goldberg');
  if (name === 'res') return path.join(__dirname, 'res');
  if (name === 'data') return path.join(__dirname, 'data');
  if (name === 'userData') return app.getPath('userData');
  if (name === 'downloads') return app.getPath('downloads');
  return __dirname;
});

// ─── Install destinations ────────────────────────────────────────
// Steam libraries plus any folders the user added, each annotated with free
// space so the destination picker can warn before a download that won't fit.
ipcMain.handle('install:listLocations', () => {
  const { getSteamLibraries } = require('./src/core/steamHelpers');

  let steamLibs = [];
  try { steamLibs = getSteamLibraries() || []; } catch { steamLibs = []; }
  const custom = settings.get('install_locations') || [];
  const defaultPath = settings.get('default_install_path') || '';

  const seen = new Set();
  const entries = [];
  const push = (target, kind) => {
    if (typeof target !== 'string' || !target.trim()) return;
    const resolved = path.resolve(target);
    const dedupeKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    let space = null;
    let exists = false;
    try {
      exists = fs.existsSync(resolved);
      if (exists && typeof fs.statfsSync === 'function') {
        const stats = fs.statfsSync(resolved);
        const blockSize = Number(stats.bsize) || 0;
        space = { free: Number(stats.bavail) * blockSize, total: Number(stats.blocks) * blockSize };
      }
    } catch { /* an unreadable drive simply reports no space info */ }

    entries.push({
      path: resolved,
      kind,
      exists,
      free: space ? space.free : null,
      total: space ? space.total : null,
      isDefault: Boolean(defaultPath) && path.resolve(defaultPath) === resolved,
    });
  };

  for (const dir of custom) push(dir, 'custom');
  for (const lib of steamLibs) push(lib, 'steam');
  if (defaultPath) push(defaultPath, 'custom');
  return entries;
});

// Add a folder to the saved install locations, creating it if needed.
ipcMain.handle('install:addLocation', (_, target) => {
  if (typeof target !== 'string' || !target.trim()) return { success: false, error: 'No folder given.' };
  const resolved = path.resolve(target);
  try {
    fs.mkdirSync(resolved, { recursive: true });
    fs.accessSync(resolved, fs.constants.W_OK);
  } catch (err) {
    return { success: false, error: `Cannot write to ${resolved}: ${err.message}` };
  }
  const current = settings.get('install_locations') || [];
  const compare = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const updates = {};
  if (!current.some((entry) => compare(entry) === compare(resolved))) updates.install_locations = [...current, resolved];
  if (!settings.get('default_install_path')) updates.default_install_path = resolved;
  settings.setMany(updates);
  return { success: true, path: resolved };
});

ipcMain.handle('install:removeLocation', (_, target) => {
  if (typeof target !== 'string') return false;
  const resolved = path.resolve(target);
  const current = settings.get('install_locations') || [];
  const compare = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const updates = { install_locations: current.filter((entry) => compare(entry) !== compare(resolved)) };
  if (settings.get('default_install_path') && compare(settings.get('default_install_path')) === compare(resolved)) updates.default_install_path = '';
  settings.setMany(updates);
  return true;
});

// ─── Auto Crack (SteamAutoCrack CLI) ─────────────────────────────
ipcMain.handle('crack:scan', (_, gamePath) => {
  const { scanGameDirectory } = require('./src/core/autoCrack');
  return scanGameDirectory(gamePath);
});

// ─── Per-game DLSS Frame Generation ─────────────────────────────
// Resolve only library-owned installations; renderer paths and compatibility
// claims are never accepted as authority for writing DLLs.
function dlssgGame(request) {
  const games = require('./src/core/libraryService').cached().games;
  const key = require('./src/core/gameMetaStore').gameKey(request);
  const matches = games.filter(entry => require('./src/core/gameMetaStore').gameKey(entry) === key);
  const game = matches.length === 1 ? matches[0] : matches.find(entry => request?.install_path
    && path.resolve(entry.install_path).toLowerCase() === path.resolve(request.install_path).toLowerCase());
  if (!game?.install_path || game.unavailable) throw new Error('This game is not available in the library. Refresh the library first.');
  return game;
}
ipcMain.handle('dlssg:status', async (_, request, selection) => {
  try {
    const game = dlssgGame(request);
    const status = await require('./src/core/dlssg').status(game, selection);
    try { assertGameIdle(game); } catch (error) {
      status.canEnable = false; status.canDisable = false; status.reason = error.message;
      status.issues.unshift({ code: 'busy', title: error.message, detail: 'Wait for the operation to finish, then use Check again.', severity: 'error' });
    }
    return status;
  } catch (error) { return { ok: false, error: require('./src/core/dlssg').explainError(error) }; }
});
ipcMain.handle('dlssg:set', async (_, { game: request, enabled, selection } = {}) => {
  let key;
  try {
    if (isQuitting || quitPending) throw new Error('Librarian is closing.');
    const game = dlssgGame(request);
    assertGameIdle(game);
    key = operationKey(game);
    gameOperations.add(key);
    const recheck = () => {
      // This operation owns the lock; all other checks still apply.
      gameOperations.delete(key);
      try {
        assertGameIdle(game);
        const latest = dlssgGame(request);
        if (operationKey(latest) !== key) throw new Error('The game installation changed. Check again.');
      } finally { gameOperations.add(key); }
    };
    const operation = require('./src/core/dlssg').setEnabled(game, enabled, selection, recheck);
    dlssgOperations.add(operation);
    try { return await operation; } finally { dlssgOperations.delete(operation); }
  } catch (error) { return { success: false, error: require('./src/core/dlssg').explainError(error), code: error.code || '' }; }
  finally { if (key !== undefined) gameOperations.delete(key); }
});

// A user-triggered updater covering every managed installation in the library.
// Checking and opening the settings page never replace a game file.
let dlssgBatch;
function getDlssgBatch() {
  if (dlssgBatch) return dlssgBatch;
  const manager = require('./src/core/dlssg');
  dlssgBatch = require('./src/core/dlssgBatch').createBatch({
    manager,
    getGames: () => require('./src/core/libraryService').cached().games,
    getBlocker: request => {
      try { assertGameIdle(dlssgGame(request)); return ''; }
      catch (error) { return error.message; }
    },
    onProgress: value => sendToRenderer('dlssg:updates-progress', value),
    runUpdate: async (request, commit) => {
      let key;
      try {
        if (isQuitting || quitPending) return { success: true, state: 'skipped', reason: 'Librarian is closing. Check again after reopening.' };
        const game = dlssgGame(request);
        if (operationKey(game) !== operationKey(request)) return { success: true, state: 'skipped', reason: 'This game moved after the update check. Check for updates again before changing its files.' };
        try { assertGameIdle(game); }
        catch (error) { return { success: true, state: 'skipped', reason: error.message }; }
        key = operationKey(game); gameOperations.add(key);
        const recheck = () => {
          gameOperations.delete(key);
          try {
            if (isQuitting || quitPending) throw new Error('Librarian is closing.');
            assertGameIdle(game);
            if (operationKey(dlssgGame(request)) !== key) throw new Error('The installation changed. Check the library again.');
          } finally { gameOperations.add(key); }
        };
        return await manager.updateGame(game, commit, recheck);
      } finally { if (key !== undefined) gameOperations.delete(key); }
    },
  });
  return dlssgBatch;
}
ipcMain.handle('dlssg:updates-state', () => getDlssgBatch().snapshot());
ipcMain.handle('dlssg:updates-check', async () => {
  try {
    if (isQuitting || quitPending) throw new Error('Librarian is closing.');
    return await getDlssgBatch().check();
  } catch (error) { return { ok: false, error: require('./src/core/dlssg').explainError(error) }; }
});
ipcMain.handle('dlssg:updates-apply', async (_, checkId) => {
  try {
    if (isQuitting || quitPending) throw new Error('Librarian is closing.');
    const operation = getDlssgBatch().update(checkId);
    dlssgOperations.add(operation);
    try { return await operation; } finally { dlssgOperations.delete(operation); }
  } catch (error) { return { ok: false, error: require('./src/core/dlssg').explainError(error) }; }
});

// ─── Online mode (real Steam session via Spacewar) ───────────────
// The binary scan is the slow part (tens to hundreds of ms) and the store
// lookup needs the network, so both are held for the session — a game's
// answer cannot change while it sits installed.
const onlineEligibilityCache = new Map();

async function evaluateOnline(game) {
  const installPath = game && game.install_path;
  if (!installPath) return null;
  const startupBlock = require('./src/core/onlineMode').getStartupBlock(installPath);
  const valheimCheck = require('./src/core/valheimOnline').inspect(installPath);
  if (valheimCheck.applicable && !valheimCheck.ok) return { eligible: false, backend: 'steam', reasons: [`Valheim online compatibility check: ${valheimCheck.error}`] };
  if (startupBlock && !valheimCheck.applicable) return { eligible: false, backend: 'steam', reasons: [startupBlock.reason] };
  if (onlineEligibilityCache.has(installPath)) return onlineEligibilityCache.get(installPath);

  const { detectSteamMultiplayer, detectAntiCheat, evaluateOnlineEligibility } = require('./src/core/multiplayer');
  const scan = await detectSteamMultiplayer(installPath);
  const antiCheat = detectAntiCheat(installPath);

  let media = null;
  if (game.appid && game.appid !== '0') {
    try {
      const { getGameMedia } = require('./src/core/steamApi');
      media = await getGameMedia(game.appid);
    } catch { /* offline: the binary scan still decides */ }
  }

  // The install path decides two of the reasons — a loader that owns the Steam
  // identity, and a shipped non-Steam transport. See multiplayer.js.
  const result = evaluateOnlineEligibility(scan, media, antiCheat, installPath);
  result.backend = scan.backend;   // the UI labels Steam vs EOS from this
  onlineEligibilityCache.set(installPath, result);
  return result;
}

ipcMain.handle('online:status', async (_, game) => {
  try {
    const onlineMode = require('./src/core/onlineMode');
    const { resolveExecutable } = require('./src/core/launcher');
    const eligibility = await evaluateOnline(game);
    if (!eligibility) return { ok: false, error: 'No install path for this game.' };

    const exe = resolveExecutable(game);
    const status = onlineMode.getStatus(game.install_path, exe);
    return { ok: true, eligibility, status, exe: exe || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('online:set', async (_, { game, enabled }) => {
  try {
    const onlineMode = require('./src/core/onlineMode');
    const { resolveExecutable } = require('./src/core/launcher');
    const exe = resolveExecutable(game);
    if (!exe) return { success: false, error: 'Could not work out which executable this game launches.' };
    return enabled
      ? onlineMode.enableOnline(game.install_path, exe, settings.get('online_player_name'))
      : onlineMode.disableOnline(game.install_path, exe);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── Greffon PEAK : rejoindre un ami depuis une session Spacewar ─
// Voir src/core/peakMod.js pour le pourquoi de la manœuvre.
ipcMain.handle('peakmod:status', (_, game) => {
  try { return require('./src/core/peakMod').status(game); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('peakmod:set', (_, { game, enabled }) => {
  try {
    const peakMod = require('./src/core/peakMod');
    return enabled ? peakMod.install(game) : peakMod.uninstall(game);
  } catch (err) { return { success: false, error: err.message }; }
});

// ─── Moteur générique : rejoindre un ami dans un jeu Unity/Photon ─
// Même mécanique que ci-dessus, mais sans connaître le jeu à l'avance : voir
// src/core/photonMod.js. La reconnaissance lit le dossier, pas une liste.
ipcMain.handle('photonmod:status', (_, game) => {
  try { return require('./src/core/photonMod').status(game); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('photonmod:set', (_, { game, enabled }) => {
  try {
    const photonMod = require('./src/core/photonMod');
    return enabled ? photonMod.install(game) : photonMod.uninstall(game);
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('crack:apply', async (_, options) => {
  const { crackGame } = require('./src/core/autoCrack');
  return crackGame({
    ...options,
    onLog: (msg) => sendToRenderer('crack:log', msg),
  });
});

ipcMain.handle('crack:restore', async (_, gamePath) => {
  const { restoreGame } = require('./src/core/autoCrack');
  return restoreGame(gamePath, (msg) => sendToRenderer('crack:log', msg));
});

ipcMain.handle('crack:checkGoldberg', () => {
  const { checkSacStatus } = require('./src/core/autoCrack');
  return checkSacStatus();
});

ipcMain.handle('crack:downloadGoldberg', async () => {
  const { downloadGoldberg } = require('./src/core/autoCrack');
  return downloadGoldberg({
    onLog: (msg) => sendToRenderer('crack:log', msg),
  });
});

ipcMain.handle('crack:generateCrackOnly', async (_, { gamePath, outputPath }) => {
  const { generateCrackOnly } = require('./src/core/autoCrack');
  return generateCrackOnly(gamePath, outputPath, (msg) => sendToRenderer('crack:log', msg));
});
