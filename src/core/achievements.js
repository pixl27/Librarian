// ═══════════════════════════════════════════════════════════════════
// Librarian — local achievements
//
// Steam refuses to store stats for an app the account does not own, so an
// unlock in one of these games goes nowhere: the call returns, Steam discards
// it, and no record of it exists on the machine. The offline emulator shipped
// in deps/SteamAutoCrack/Goldberg does keep one, and this module is the reader.
//
// Two halves, from two different places:
//
//   progress    %APPDATA%\GSE Saves\<appid>\achievements.json  — written by the
//               emulator as the game unlocks things.
//   definitions <game>\steam_settings\achievements.json        — written once by
//               SteamAutoCrack's EMUGameInfo: names, descriptions, icons.
//
// Neither is under our control, so everything here is defensive: a missing
// file, a half-written file and a shape we did not expect all have to mean
// "nothing new", never a crash in the launcher.
// ═══════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

// The emulator was renamed at some point and both folders are found in the
// wild — this machine still carries the older one.
const SAVE_ROOTS = ['GSE Saves', 'Goldberg SteamEmu Saves'];

const POLL_MS = 1500;

/** Every save root that actually exists, newest layout first. */
function saveRoots() {
  const appData = process.env.APPDATA;
  if (!appData) return [];
  return SAVE_ROOTS
    .map((name) => path.join(appData, name))
    .filter((dir) => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } });
}

/** The emulator's unlock record for one app, or null when it has never run. */
function progressFile(appId) {
  const id = String(appId || '').trim();
  if (!/^\d{1,20}$/.test(id)) return null;
  for (const root of saveRoots()) {
    const file = path.join(root, id, 'achievements.json');
    try { if (fs.statSync(file).isFile()) return file; } catch { /* try the next root */ }
  }
  return null;
}

/**
 * Read the unlocks.
 *
 * The emulator writes a map of api-name to record, but older builds wrote an
 * array, and a file caught mid-write parses as neither — all three end up as
 * "nothing to report" rather than an exception.
 *
 * @returns {Map<string, {earned: boolean, earnedAt: number}>}
 */
function readProgress(appId) {
  const out = new Map();
  const file = progressFile(appId);
  if (!file) return out;

  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return out; }

  const record = (name, value) => {
    const key = String(name || '').trim();
    if (!key) return;
    const earned = value === true || value?.earned === true || value?.earned === 1;
    // earned_time is seconds since the epoch, and 0 means "no idea".
    const seconds = Number(value?.earned_time || value?.earnedTime || 0);
    out.set(key, { earned, earnedAt: seconds > 0 ? seconds * 1000 : 0 });
  };

  if (Array.isArray(raw)) raw.forEach((e) => record(e?.name || e?.api_name, e));
  else if (raw && typeof raw === 'object') Object.entries(raw).forEach(([k, v]) => record(k, v));

  return out;
}

/**
 * Find the emulator's settings folder.
 *
 * It sits beside the Steam API library, not at the root of the install — for
 * an Unreal game that is Engine/Binaries/ThirdParty/Steamworks/<ver>/Win64,
 * five levels down. Assuming the root is how one earlier pass concluded that
 * none of these games had achievement data at all, when every one of them did.
 *
 * Breadth-first with a depth cap: game trees are wide and deep, and the folder
 * is always near a binary rather than buried in content.
 */
function findSettingsDir(installPath, maxDepth = 6) {
  if (!installPath) return '';
  let level = [installPath];

  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next = [];
    for (const dir of level) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'steam_settings') return path.join(dir, entry.name);
        // Content folders hold tens of thousands of assets and never the
        // emulator's configuration; walking them costs seconds for nothing.
        if (/^(Content|Paks|Movies|__installer|node_modules)$/i.test(entry.name)) continue;
        next.push(path.join(dir, entry.name));
      }
    }
    level = next;
  }
  return '';
}

/**
 * The definitions, so an unlock can be shown as something other than its
 * internal name. Icons are files inside steam_settings; they are returned as
 * absolute paths because the renderer loads them directly.
 */
function loadDefinitions(installPath, appId) {
  const list = [];
  if (!installPath) return list;

  const settingsDir = findSettingsDir(installPath);
  if (!settingsDir) return list;
  const file = path.join(settingsDir, 'achievements.json');

  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return list; }
  if (!Array.isArray(raw)) return list;

  const resolveIcon = (value) => {
    const rel = String(value || '').trim();
    if (!rel) return '';
    const full = path.join(settingsDir, rel);
    try { return fs.statSync(full).isFile() ? full : ''; } catch { return ''; }
  };

  for (const entry of raw) {
    const name = String(entry?.name || '').trim();
    if (!name) continue;
    list.push({
      name,
      // displayName is what Steam shows; some dumps only carry the raw name.
      title: String(entry?.displayName || entry?.display_name || name),
      description: String(entry?.description || ''),
      icon: resolveIcon(entry?.icon),
      iconLocked: resolveIcon(entry?.icongray || entry?.icon_gray),
      hidden: String(entry?.hidden || '0') === '1',
      // Only present when the dump was taken with global stats.
      rarity: Number(entry?.unlock_percentage) || null,
    });
  }
  return list;
}

/** Definitions merged with progress — everything a UI needs for one game. */
function snapshot(game) {
  const appId = String(game?.appid || '');
  const definitions = loadDefinitions(game?.install_path, appId);
  const progress = readProgress(appId);

  // A game can unlock something the definitions never mentioned (a dump taken
  // before a content update). Showing it by its raw name beats hiding it.
  const known = new Set(definitions.map((d) => d.name));
  for (const name of progress.keys()) {
    if (!known.has(name)) definitions.push({ name, title: name, description: '', icon: '', iconLocked: '', hidden: false, rarity: null });
  }

  const items = definitions.map((d) => {
    const p = progress.get(d.name);
    return { ...d, unlocked: Boolean(p?.earned), unlockedAt: p?.earned ? p.earnedAt : 0 };
  });

  const unlocked = items.filter((i) => i.unlocked).length;
  return {
    appid: appId,
    total: items.length,
    unlocked,
    percent: items.length ? Math.round((unlocked / items.length) * 100) : 0,
    hasDefinitions: items.some((i) => i.title !== i.name || i.description),
    tracked: Boolean(progressFile(appId)),
    items: items.sort((a, b) => (b.unlockedAt || 0) - (a.unlockedAt || 0) || a.title.localeCompare(b.title)),
  };
}

// ─── Watching ──────────────────────────────────────────────────────
// fs.watch on the save folder would be lighter, but the emulator rewrites the
// file wholesale and some builds write to a temp file and rename — which fires
// a different event on every Windows version. Polling one small JSON file
// every second and a half is cheaper than being clever and wrong.
let timer = null;
let onUnlock = null;
let watching = new Map();   // appid -> { game, seen: Set<string>, primed: boolean }

// The injected overlay's own reports. The save file only changes when a game
// calls StoreStats, and plenty of games set an achievement and never flush —
// Goldberg then has the unlock in memory and nothing reaches disk until the
// game exits, or ever. The overlay reads the emulator from inside the process
// and appends what it sees here, so those unlocks still arrive, and arrive at
// the moment they happen rather than at the next flush.
function unlocksFile(pid) {
  const local = process.env.LOCALAPPDATA;
  if (!local || !pid) return '';
  return path.join(local, 'Librarian', 'overlay', `${pid}.unlocks`);
}

function readReported(entry) {
  const file = unlocksFile(entry.pid);
  if (!file) return [];
  let text;
  try { text = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  if (text.length <= entry.consumed) return [];
  const fresh = text.slice(entry.consumed);
  entry.consumed = text.length;
  return fresh.split('\n').map((line) => line.trim()).filter(Boolean);
}

function announce(entry, appId, name, at) {
  const definition = loadDefinitions(entry.game?.install_path, appId).find((d) => d.name === name);
  try {
    onUnlock?.({
      appid: appId,
      game: entry.game?.game_name || '',
      name,
      title: definition?.title || name,
      description: definition?.description || '',
      icon: definition?.icon || '',
      rarity: definition?.rarity ?? null,
      at: at || Date.now(),
    });
  } catch { /* a listener that throws must not stop the watch */ }
}

function poll() {
  for (const [appId, entry] of watching) {
    // First, and outside the baseline below: the overlay reports transitions it
    // watched happen, so every line it writes is new by construction — and a
    // save file that cannot be read must not cost us these.
    for (const name of readReported(entry)) {
      if (entry.seen.has(name)) continue;
      entry.seen.add(name);
      announce(entry, appId, name, Date.now());
    }

    let progress;
    try { progress = readProgress(appId); } catch { continue; }

    const earned = [...progress.entries()].filter(([, v]) => v.earned).map(([k, v]) => ({ name: k, at: v.earnedAt }));

    // The first read is a baseline, not a burst of notifications: a game that
    // already holds forty achievements must not announce all forty when the
    // launcher starts watching it.
    if (!entry.primed) {
      earned.forEach((e) => entry.seen.add(e.name));
      entry.primed = true;
      continue;
    }

    for (const item of earned) {
      if (entry.seen.has(item.name)) continue;
      entry.seen.add(item.name);
      announce(entry, appId, item.name, item.at);
    }
  }
}

/** Follow one running game. Repeated calls for the same app are harmless. */
function watch(game) {
  const appId = String(game?.appid || '').trim();
  if (!/^\d{1,20}$/.test(appId)) return;
  const pid = Number(game?.pid) || 0;

  if (!watching.has(appId)) {
    // Windows reuses process ids, so a leftover file from an earlier game could
    // otherwise announce its achievements as this one's. Start from nothing.
    try { fs.unlinkSync(unlocksFile(pid)); } catch { /* nothing to clear */ }
    watching.set(appId, { game, pid, seen: new Set(), primed: false, consumed: 0 });
  } else {
    const entry = watching.get(appId);
    entry.game = game;
    if (pid) entry.pid = pid;
  }
  if (!timer) timer = setInterval(poll, POLL_MS);
}

function unwatch(appId) {
  const entry = watching.get(String(appId || ''));
  if (entry) {
    // One last look: the game's final unlock may land between polls and its
    // exit, and the overlay writes before the process is gone.
    try {
      for (const name of readReported(entry)) {
        if (entry.seen.has(name)) continue;
        entry.seen.add(name);
        announce(entry, String(appId), name, Date.now());
      }
    } catch { /* a dying game must not take the launcher with it */ }
    try { fs.unlinkSync(unlocksFile(entry.pid)); } catch { /* already gone */ }
  }
  watching.delete(String(appId || ''));
  if (!watching.size && timer) { clearInterval(timer); timer = null; }
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  watching = new Map();
}

function init(handler) { onUnlock = typeof handler === 'function' ? handler : null; }

module.exports = { init, watch, unwatch, stop, snapshot, readProgress, loadDefinitions, progressFile, findSettingsDir };
