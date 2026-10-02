/**
 * Librarian updating itself.
 *
 * The installer build (dev/build-installer.cjs) writes an app-update.yml into
 * resources/ naming where releases are published. electron-updater reads it,
 * compares versions, downloads the new installer in the background — only the
 * blocks that changed, using the .blockmap published beside it — and runs it
 * when Librarian closes, or at once when the player asks for it.
 *
 * A portable build and a development checkout carry no such file and cannot
 * replace themselves, so for them this stays inert and says why.
 *
 * Everything the renderer shows comes from one state object, pushed on every
 * change: it never has to ask electron-updater anything itself.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FIRST_CHECK_MS = 8000;               // let the window settle first
const RECHECK_MS = 4 * 60 * 60 * 1000;     // a session left open all evening still hears about it
const LOG_LIMIT = 256 * 1024;

let updater = null;
let timers = [];
const listeners = new Set();
let state = {
  status: 'idle',      // idle | checking | current | downloading | ready | error | unsupported
  current: app.getVersion(),
  available: '',
  notes: '',
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  checkedAt: 0,
  error: '',
  reason: '',
};

function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) { try { fn({ ...state }); } catch { /* a closed window */ } }
}

function getState() { return { ...state }; }

/** Why this copy cannot update itself, or '' when it can. */
function unsupportedReason() {
  if (!app.isPackaged) return 'dev';
  if (process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE) return 'portable';
  if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return 'no-feed';
  return '';
}

/** A small rolling log, so a friend's "it doesn't update" has something to read. */
function makeLogger() {
  const file = path.join(app.getPath('userData'), 'logs', 'updater.log');
  const write = (level, args) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try { if (fs.statSync(file).size > LOG_LIMIT) fs.renameSync(file, `${file}.old`); } catch { /* first line */ }
      const text = args.map(a => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`);
    } catch { /* logging must never break updating */ }
  };
  return {
    info: (...a) => write('INFO', a),
    warn: (...a) => write('WARN', a),
    error: (...a) => write('ERROR', a),
    debug: () => {},
  };
}

/** Release notes arrive as HTML (GitHub) or a list of them; keep plain text. */
function plainNotes(info) {
  let notes = info && info.releaseNotes;
  if (Array.isArray(notes)) notes = notes.map(n => (n && n.note) || '').join('\n');
  return String(notes || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 1200);
}

/** One sentence a player can act on, not a stack trace. */
function explain(err) {
  const text = String((err && (err.message || err)) || '');
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|net::ERR_/i.test(text)) {
    return 'Could not reach the update server. Librarian will try again later.';
  }
  if (/No published versions|Cannot find latest|404/i.test(text)) {
    return 'No release has been published yet.';
  }
  if (/sha512 checksum mismatch/i.test(text)) {
    return 'The downloaded update was damaged. It will be downloaded again.';
  }
  return text.split('\n')[0].slice(0, 200) || 'The update check failed.';
}

/**
 * Wire electron-updater and schedule checks.
 * @param {object} options
 * @param {(state: object) => void} options.onState - every state change
 */
function start({ onState } = {}) {
  if (typeof onState === 'function') listeners.add(onState);
  const reason = unsupportedReason();
  if (reason) { set({ status: 'unsupported', reason }); return; }

  const { autoUpdater } = require('electron-updater');
  updater = autoUpdater;
  autoUpdater.logger = makeLogger();
  autoUpdater.autoDownload = true;
  // Closing Librarian is the natural moment: the installer runs silently on
  // the way out, and the next launch is the new version.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  // The full installer is published, never the web stub.
  autoUpdater.disableWebInstaller = true;

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: '' }));
  autoUpdater.on('update-not-available', () => set({ status: 'current', checkedAt: Date.now(), available: '', notes: '' }));
  autoUpdater.on('update-available', (info) => set({
    status: 'downloading', checkedAt: Date.now(), available: info.version, notes: plainNotes(info),
    percent: 0, transferred: 0, total: 0, bytesPerSecond: 0,
  }));
  autoUpdater.on('download-progress', (p) => set({
    status: 'downloading', percent: Math.max(0, Math.min(100, Number(p.percent) || 0)),
    transferred: p.transferred || 0, total: p.total || 0, bytesPerSecond: p.bytesPerSecond || 0,
  }));
  autoUpdater.on('update-downloaded', (info) => set({
    status: 'ready', available: info.version, notes: plainNotes(info) || state.notes, percent: 100,
  }));
  autoUpdater.on('error', (err) => {
    // Once an update is waiting, a later failed check changes nothing.
    if (state.status === 'ready') return;
    set({ status: 'error', error: explain(err), checkedAt: Date.now() });
  });

  timers.push(setTimeout(() => { void check(); }, FIRST_CHECK_MS));
  timers.push(setInterval(() => { void check(); }, RECHECK_MS));
  for (const t of timers) t.unref?.();
}

/** Ask now. Harmless while a check or download is already under way. */
let checkingSince = 0;
async function check() {
  if (!updater) return getState();
  if (['downloading', 'ready'].includes(state.status)) return getState();
  // A check stuck on a dead connection must not block every later one.
  if (state.status === 'checking' && Date.now() - checkingSince < 120000) return getState();
  checkingSince = Date.now();
  try { await updater.checkForUpdates(); }
  catch (err) { if (state.status !== 'ready') set({ status: 'error', error: explain(err), checkedAt: Date.now() }); }
  return getState();
}

/**
 * Close and run the downloaded installer, then start the new version.
 * Not silent: the one-click installer's progress window is the only sign
 * that something is happening during the seconds Librarian is gone.
 */
function install() {
  if (!updater || state.status !== 'ready') return false;
  updater.quitAndInstall(false, true);
  return true;
}

function stop() {
  for (const t of timers) { clearTimeout(t); clearInterval(t); }
  timers = [];
}

module.exports = { start, stop, check, install, getState, unsupportedReason };
