/**
 * CS.RIN.RU as a source.
 *
 * Hubcap gives Librarian the Steam depots; this gives it the other thing an
 * installed game can need — a release posted on cs.rin.ru by a known member
 * (DenuvOwO for Denuvo titles, and so on), hosted on Buzzheavier, Pixeldrain,
 * Gofile or a direct link, and meant to be dropped over the game's files. The
 * forum crawling and the hoster resolution live in a separate project,
 * https://github.com/pixl27/csrinru, and ship here as two PyInstaller
 * binaries in deps/csrin (see VERSION.txt there for the commit):
 *
 *   csrin-cli.exe  search the forum, crawl the topic, extract the member's post
 *   csrin-dl.exe   resolve one hoster link and download the file
 *
 * Three phases on purpose. The CLI can search and download in one go with
 * --download, but that hands the choice of *what* to download to a regex;
 * here the search returns the posts and the user picks. A post names the
 * patch it was made for ("Update.v2.03.02"), and that has to equal the patch
 * installed (src/core/patchVersion.js) before anything is placed into the
 * game — the renderer gates on it and csrin:download refuses a mismatch again. Then one link becomes one
 * queue job that reports through the same channels as a SteamPipe download,
 * and when it is for an installed game the archive's folder for that game —
 * only that folder — is placed over the install, originals kept beside.
 *
 * Search has no JSON mode — it prints status lines and writes a JSON file next
 * to its Markdown report. So the status lines are relayed as a log, and the
 * JSON file is what the result is read from. Download has a JSON mode
 * (--json-events, NDJSON on stdout) and that is what is parsed; its curl
 * fallback prints plain text, which is handled too.
 *
 * Archives are read with bsdtar, which Windows has shipped in System32 since
 * 10 1803 (libarchive: zip, 7z, rar including v5). Nothing else to install.
 *
 * Both binaries are PyInstaller one-file bundles: the process Librarian spawns
 * is a bootloader whose child is the real interpreter. Killing the parent
 * alone leaves the child running, so stopping goes through taskkill /T.
 */
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { getDepsPath } = require('./runtimePaths');

const SEARCH_TIMEOUT_MS = 4 * 60 * 1000;
const BACKUP_SUFFIX = '.csrin.bak';

// One search at a time; this is what cancelSearch() stops.
let activeSearch = null;

function cancelSearch() {
  if (!activeSearch) return false;
  activeSearch.cancel();
  return true;
}

function electronApp() {
  try {
    const { app } = require('electron');
    return app && typeof app.getPath === 'function' ? app : null;
  } catch {
    return null;
  }
}

/** LIBRARIAN_CSRIN_DIR points at a checkout's dist/ during development. */
function binDir() {
  return process.env.LIBRARIAN_CSRIN_DIR || getDepsPath('csrin');
}

function cliPath() { return path.join(binDir(), 'csrin-cli.exe'); }
function dlPath() { return path.join(binDir(), 'csrin-dl.exe'); }

/**
 * Windows' own bsdtar, by absolute path: a Git or MSYS install puts GNU tar
 * first on PATH, and GNU tar reads neither 7z nor rar.
 */
function tarPath() {
  if (process.platform === 'win32') {
    const p = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'tar';
}

/**
 * Where a release lands when the user has not said otherwise. The archive is
 * kept here even when its contents go into a game, so a bad extraction can
 * be redone without another download.
 */
function defaultDownloadDir() {
  const app = electronApp();
  const base = app ? app.getPath('downloads') : path.join(os.homedir(), 'Downloads');
  return path.join(base, 'Librarian');
}

/** Scratch space for the search reports; the CLI writes into its cwd. */
function workDir() {
  const app = electronApp();
  return app ? path.join(app.getPath('userData'), 'csrin') : path.join(os.tmpdir(), 'librarian-csrin');
}

function status() {
  const cli = cliPath();
  const dl = dlPath();
  const tar = tarPath();
  return {
    cliExists: fs.existsSync(cli),
    dlExists: fs.existsSync(dl),
    tarExists: path.isAbsolute(tar) ? fs.existsSync(tar) : true,
    cliPath: cli,
    dlPath: dl,
    tarPath: tar,
    downloadDir: defaultDownloadDir(),
  };
}

function slug(text) {
  return String(text || '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase().slice(0, 80) || 'search';
}

function killTree(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => {});
  }
  try { proc.kill(); } catch { /* already gone */ }
}

function spawnTool(exe, args, cwd, extraEnv = {}) {
  fs.mkdirSync(cwd, { recursive: true });
  return spawn(exe, args, {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // The forum is UTF-8 and so are post subjects; without this a frozen
    // Python falls back to the console code page and dies on the first
    // character outside it.
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...extraEnv },
  });
}

function runTool(exe, args, options = {}) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err });
    });
  });
}

/** The forum's own links inside a post are navigation, not a download. */
function isExternalLink(link) {
  return typeof link === 'string'
    && /^https?:\/\//i.test(link)
    && !/cs\.rin\.ru\/forum\/(viewtopic|memberlist)/i.test(link);
}

/** A file attached to a forum post, served by cs.rin.ru itself. */
function isForumAttachment(link) {
  return typeof link === 'string' && /^https:\/\/cs\.rin\.ru\/forum\/download\/file\.php\?id=\d+$/i.test(link);
}

function hostOf(link) {
  try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// ─── Post shaping ─────────────────────────────────────────────────

/**
 * The patch and build a post was made for. ARTIFACT names the release
 * "Crimson.Desert.Enhanced.Update.v2.03.02.Crack.Only-ARTIFACT" and states no
 * build; DenuvOwO wrote "Game version is 2.00.02 (BuildID 25050808)"; others
 * write "Build 12345678". The patch is what a release is matched on; the
 * build id only stands in for a post that names no patch.
 */
function parseBuild(content) {
  const text = String(content || '');
  const build = /build\s*-?\s*id\s*[:#=]?\s*(\d{4,})/i.exec(text)
    || /\bbuild\s*[:#=]?\s*(\d{6,})\b/i.exec(text);
  const version = /\bversion\s*(?:is|:|=)?\s*v?\.?\s*(\d+(?:\.\d+)+[\w.-]*)/i.exec(text)
    // "Game version is Title Update 1.0.7", "Patch 2.1.0"
    || /\b(?:version|update|patch)\b[^\d\n]{0,24}(\d+(?:\.\d+)+)/i.exec(text)
    || /\bv(\d+(?:\.\d+)+)\b/i.exec(text);
  return { build: build ? build[1] : '', version: version ? version[1] : '' };
}

/**
 * Links as the post presents them, in order and with their labels. The CLI
 * turns every anchor into "[text](url)" and keeps the line around it, so
 * "Crack:  [link](https://…)" yields label "Crack" — the thing that tells the
 * user which of two links is the one to install.
 */
function labelledLinks(content) {
  const out = [];
  const re = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  for (const line of String(content || '').split('\n')) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      const url = m[2];
      if (!isExternalLink(url) || out.some((l) => l.url === url)) continue;
      // The forum prefixes every anchor with "<host> link" (a hoster hint
      // span); that is not the member's label, "Crack:" or "Link:" is.
      const before = line.slice(0, m.index)
        .replace(/\s*[\w.-]+\.[a-z]{2,}\s+link\s*$/i, '')
        .replace(/[\s:：\-–—]+$/, '').trim();
      const text = m[1].trim();
      const label = (before || (/^https?:\/\//i.test(text) ? '' : text)).slice(-48);
      out.push({ url, label });
    }
  }
  return out;
}

/**
 * The post as a person reads it. The CLI flattens the forum's attachment box
 * into its icon, a relative link and the template's indentation; none of
 * that is text. Display only — `content` keeps everything for parsing.
 */
function readableExcerpt(content) {
  return String(content || '')
    .replace(/\[Image:\s*\.\/styles\/[^\]]*\]/g, '')
    .replace(/\[([^\]]+)\]\(\.\/download\/file\.php\?id=\d+\)/g, '📎 $1')
    .replace(/[ \t]+/g, ' ')
    .replace(/^ +| +$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Normalise a post from the CLI's JSON report into what the picker shows.
 * Everything the renderer needs is here, so it never touches the raw report.
 */
function shapePost(raw, index) {
  const content = String(raw.content || '').replace(/\r/g, '').trim();
  const links = labelledLinks(content);
  const push = (l) => { if (isExternalLink(l) && !links.some((x) => x.url === l)) links.push({ url: l, label: '' }); };
  push(raw.extracted_link);
  for (const l of raw.post_links || []) push(l);
  // ARTIFACT attaches the release to the post instead of linking a hoster:
  // the forum serves it (download/file.php?id=N) to logged-in members only,
  // and the downloader fetches it with the account's session.
  for (const a of raw.attachments || []) {
    if (!isForumAttachment(a?.url) || links.some((x) => x.url === a.url)) continue;
    links.push({ url: a.url, label: String(a.name || 'Attachment').slice(0, 64), attachment: true, size: String(a.size || '') });
  }
  const { build, version } = parseBuild(content);
  // The member states the archive's SHA-256 because the hoster shows fake
  // download pages; the file is checked against it once it is down.
  const sha = /SHA-?256\s*[:=]?\s*([0-9a-f]{64})/i.exec(content);
  return {
    sha256: sha ? sha[1].toLowerCase() : '',
    index,
    postId: String(raw.post_id || ''),
    author: String(raw.author || ''),
    date: String(raw.date || ''),
    subject: String(raw.subject || ''),
    page: Number(raw.page) || 0,
    url: String(raw.url || ''),
    topicTitle: String(raw.topic_title || ''),
    topicUrl: String(raw.topic_url || ''),
    build,
    version,
    links: links.map((l) => ({ url: l.url, host: l.attachment ? 'forum attachment' : hostOf(l.url), label: l.label, attachment: Boolean(l.attachment), size: l.size || '' })),
    // The forum hides links from guests and says so inline; surfacing that
    // phrase is how the picker explains an empty link list.
    linksHidden: links.length === 0 && /please login to see this link/i.test(content),
    excerpt: readableExcerpt(content).slice(0, 600),
    excerptCut: readableExcerpt(content).length > 600,
    content,
  };
}

// ─── Search ───────────────────────────────────────────────────────

/**
 * Search the forum for a game and the posts of one member in its topic.
 *
 * Resolves (never rejects) with:
 *   { ok, error?, cancelled?, topics: [{title, url}], posts: [shaped],
 *     authenticated, loginFailed, scannedAll }
 *
 * Exactly one of game / topicUrl / topicId is used, in that order. By default
 * the CLI walks the thread backwards and stops at the newest post with a
 * visible link; scanAll walks every page and returns every post, which is
 * how an older build's post is found when the newest one does not match.
 */
function search(options = {}) {
  const {
    game = '',
    topicUrl = '',
    topicId = '',
    author = 'ARTIFACT',
    username = '',
    password = '',
    maxPages = 50,
    scanAll = false,
    onLog = () => {},
  } = options;

  return new Promise((resolve) => {
    const exe = cliPath();
    if (!fs.existsSync(exe)) {
      resolve({ ok: false, error: `csrin-cli.exe not found at ${exe}`, topics: [], posts: [] });
      return;
    }
    const target = game ? ['--game', game] : topicUrl ? ['--url', topicUrl] : topicId ? ['--topic-id', String(topicId)] : null;
    if (!target) {
      resolve({ ok: false, error: 'Nothing to search for.', topics: [], posts: [] });
      return;
    }

    const cwd = workDir();
    const stamp = `${slug(game || topicId || 'topic')}_${slug(author)}_${Date.now()}`;
    const reportMd = path.join(cwd, `${stamp}.md`);
    const reportJson = path.join(cwd, `${stamp}.json`);

    const args = [...target, '--author', author || 'ARTIFACT', '--max-pages', String(Math.max(1, Math.min(500, Number(maxPages) || 50))), '--output', reportMd];
    if (scanAll) args.push('--all');
    if (username && password) args.push('-U', username, '-P', password);

    const result = { ok: false, topics: [], posts: [], authenticated: false, loginFailed: false, scannedAll: Boolean(scanAll) };
    let proc;
    try {
      proc = spawnTool(exe, args, cwd);
    } catch (err) {
      resolve({ ...result, error: `Could not start csrin-cli.exe: ${err.message}` });
      return;
    }

    let settled = false;
    let stderrTail = '';
    const finish = (patch) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeSearch && activeSearch.proc === proc) activeSearch = null;
      resolve({ ...result, ...patch });
    };
    const timer = setTimeout(() => {
      killTree(proc);
      finish({ error: 'The forum search took too long and was stopped.' });
    }, SEARCH_TIMEOUT_MS);
    activeSearch = {
      proc,
      cancel: () => { killTree(proc); finish({ error: 'Search cancelled.', cancelled: true }); },
    };

    const handleLine = (line) => {
      const text = line.replace(/\r/g, '').trimEnd();
      if (!text.trim()) return;
      onLog(text);
      const topic = /^\s*\[(\d+)\]\s+(.*?)\s+->\s+(https?:\/\/\S+)\s*$/.exec(text);
      if (topic) result.topics.push({ title: topic[2], url: topic[3] });
      if (/Login successful/i.test(text)) result.authenticated = true;
      if (/Login verification failed|Login error/i.test(text)) result.loginFailed = true;
    };

    readline.createInterface({ input: proc.stdout }).on('line', handleLine);
    readline.createInterface({ input: proc.stderr }).on('line', (line) => {
      const text = line.replace(/\r/g, '').trim();
      if (!text) return;
      stderrTail = `${stderrTail}\n${text}`.slice(-2000);
      onLog(`[stderr] ${text}`);
    });

    proc.on('error', (err) => finish({ error: `csrin-cli.exe failed: ${err.message}` }));
    proc.on('close', (code) => {
      let raw = null;
      try {
        raw = JSON.parse(fs.readFileSync(reportJson, 'utf8'));
      } catch { /* no report: the search ended before the crawl */ }
      // The report has been read; nothing else looks at it, and a search per
      // visit would otherwise pile these up in userData for ever.
      for (const f of [reportMd, reportJson]) { try { fs.unlinkSync(f); } catch { /* never written */ } }

      if (Array.isArray(raw)) {
        result.posts = raw.map(shapePost);
        finish({ ok: true });
        return;
      }
      if (code === 0) {
        // The CLI exits 0 with no report when the search found no topic.
        finish({ ok: true });
        return;
      }
      const reason = stderrTail.trim().split('\n').pop() || `exit code ${code}`;
      finish({ error: `csrin-cli.exe failed: ${reason}` });
    });
  });
}

// ─── Download ─────────────────────────────────────────────────────

/**
 * Download one hoster link into a folder.
 *
 * Callbacks:
 *   onLog(text)          plain status lines
 *   onEvent(event)       every JSON event, verbatim (resolving_url,
 *                        download_start, download_progress, …)
 *   onProgress(p)        { percent|null, speed, eta, downloadedBytes, totalBytes }
 *   onComplete(r)        { filepath, filename, totalBytes }
 *   onError(err)         Error
 *
 * Returns a handle shaped like the SteamPipe one so main.js can keep it in the
 * same slot: stop(), markPaused(), markResumed(). The hoster transfer cannot
 * be paused, so markPaused reports false and the UI hides the control.
 */
function sha256Of(filepath) {
  return new Promise((resolve, reject) => {
    const hash = require('crypto').createHash('sha256');
    fs.createReadStream(filepath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** A hoster's error or challenge page saved under the file's name. */
function looksLikeHtmlFile(filepath) {
  try {
    const stat = fs.statSync(filepath);
    if (stat.size > 2 * 1024 * 1024) return false;
    const fd = fs.openSync(filepath, 'r');
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, n).toString('latin1').trimStart().toLowerCase();
    return head.startsWith('<!doctype') || head.startsWith('<html') || head.slice(0, 200).includes('<head');
  } catch {
    return false;
  }
}

function download(options = {}, callbacks = {}) {
  const { url, outputDir } = options;
  // Stated in the post; checked once the file is down, because the hoster
  // shows fake download pages and a swapped archive is the whole risk.
  const expectedSha = /^[0-9a-f]{64}$/i.test(String(options.sha256 || '')) ? String(options.sha256).toLowerCase() : '';
  const onLog = callbacks.onLog || (() => {});
  const onEvent = callbacks.onEvent || (() => {});
  const onProgress = callbacks.onProgress || (() => {});
  const onComplete = callbacks.onComplete || (() => {});
  const onError = callbacks.onError || (() => {});

  const exe = dlPath();
  if (!fs.existsSync(exe)) throw new Error(`csrin-dl.exe not found at ${exe}`);
  if (!isExternalLink(url)) throw new Error('That is not a downloadable link.');
  const dir = path.resolve(String(outputDir || defaultDownloadDir()));

  // A forum attachment needs the member's session. The account goes through
  // the environment, never the command line, so it stays out of process lists.
  let env = {};
  if (isForumAttachment(url)) {
    if (!options.username || !options.password) throw new Error('This release is a forum attachment; CS.RIN.RU only serves it to members. Add a forum account in Settings.');
    env = { CSRIN_USERNAME: String(options.username), CSRIN_PASSWORD: String(options.password) };
  }
  const proc = spawnTool(exe, [url, '--output-dir', dir, '--json-events'], dir, env);

  let stopped = false;
  let done = null;
  let lastError = '';
  let startInfo = null;

  const handleJson = (event) => {
    onEvent(event);
    switch (event.event) {
      case 'resolving_url':
        onLog(`🔗 Resolving ${hostOf(event.url) || event.url}…`);
        break;
      case 'resolver_error':
        lastError = `Could not resolve the hoster link: ${event.error}`;
        onLog(`⚠ ${lastError}`);
        break;
      case 'download_start':
        startInfo = event;
        onLog(`⬇ ${event.filename} (${event.size_str || 'unknown size'})`);
        break;
      case 'download_progress':
        onProgress({
          percent: Number.isFinite(event.percent) ? event.percent : null,
          speed: event.speed || '',
          eta: event.eta || '',
          downloadedBytes: Number(event.downloaded_bytes) || 0,
          totalBytes: Number.isFinite(event.total_bytes) ? event.total_bytes : null,
        });
        break;
      case 'download_complete':
        done = { filepath: event.filepath, filename: event.filename, totalBytes: Number(event.total_bytes) || 0 };
        break;
      case 'no_links':
        lastError = 'No downloadable link.';
        break;
      case 'download_error':
        lastError = String(event.error || 'Download failed.');
        onLog(`❌ ${lastError}`);
        break;
      default:
        break;
    }
  };

  const handleText = (text) => {
    const curl = /Download succeeded via curl:\s*(.+)$/.exec(text);
    if (curl) {
      const filepath = curl[1].trim();
      done = { filepath, filename: path.basename(filepath), totalBytes: startInfo?.total_bytes || 0 };
      return;
    }
    const failure = /^\[-\]\s*(.+)$/.exec(text);
    if (failure) lastError = failure[1];
    onLog(text);
  };

  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    const text = line.replace(/\r/g, '').trim();
    if (!text) return;
    if (text.startsWith('{')) {
      try { handleJson(JSON.parse(text)); return; } catch { /* fall through as text */ }
    }
    handleText(text);
  });

  // curl's own progress meter lives on stderr; only real complaints matter.
  readline.createInterface({ input: proc.stderr }).on('line', (line) => {
    const text = line.replace(/\r/g, '').trim();
    if (text && /error|fail|denied|refused/i.test(text)) onLog(`[stderr] ${text}`);
  });

  proc.on('error', (err) => { if (!stopped) onError(new Error(`csrin-dl.exe failed to start: ${err.message}`)); });
  const finished = new Promise(resolveFinished => { proc.on('close', async (code) => {
    try {
    if (stopped) return;
    if (!done || !done.filepath) {
      onError(new Error(lastError || `csrin-dl.exe exited with code ${code} without finishing the download.`));
      return;
    }
    // What came down has to be the file, not a page about it — and, when
    // the post says what the file's hash is, that file exactly.
    if (looksLikeHtmlFile(done.filepath)) {
      try { fs.unlinkSync(done.filepath); } catch { /* leave it */ }
      onError(new Error(`${hostOf(url) || 'The hoster'} answered with a web page instead of the file.`));
      return;
    }
    if (expectedSha) {
      try {
        const actual = await sha256Of(done.filepath);
        if (actual !== expectedSha) {
          const bad = `${done.filepath}.rejected`;
          try { fs.renameSync(done.filepath, bad); } catch { /* keep it where it is */ }
          onError(new Error(`SHA-256 mismatch: the post states ${expectedSha.slice(0, 12)}…, the file is ${actual.slice(0, 12)}…. It was set aside as ${path.basename(bad)} and not used.`));
          return;
        }
        onLog(`🔏 SHA-256 matches the post (${expectedSha.slice(0, 12)}…)`);
      } catch (err) {
        onError(new Error(`Could not verify the file: ${err.message}`));
        return;
      }
    }
    await onComplete(done);
    } finally { resolveFinished(); }
  }); });

  return {
    done: finished,
    pid: proc.pid,
    stop() { stopped = true; killTree(proc); },
    markPaused() { return false; },
    markResumed() { return false; },
  };
}

// ─── Extraction ───────────────────────────────────────────────────

/** Entry paths as bsdtar lists them, forward slashes, no trailing blanks. */
async function listArchive(archivePath) {
  const r = await runTool(tarPath(), ['-tf', archivePath]);
  if (r.code !== 0) throw new Error(`Cannot read ${path.basename(archivePath)}: ${r.stderr.trim().split('\n').pop() || 'not an archive bsdtar understands'}`);
  return r.stdout.split(/\r?\n/).map((l) => l.trim().replace(/\\/g, '/')).filter(Boolean);
}

function normalizeName(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Which folder of the archive is the game.
 *
 * A release pack can hold several folders — one per game, or the clean
 * files beside the crack — and only the one named after the game goes over
 * the install. The install folder's own name is the first thing looked for,
 * the store name second; a folder that merely contains one of them ("Crimson
 * Desert HYPERVISOR - DenuvOwO") counts when it is the only such folder.
 *
 * Returns { mode: 'folder', folder } | { mode: 'root' } | { mode: 'ambiguous', folders }
 */
function pickGameFolder(entries, { installPath = '', gameName = '' } = {}) {
  const dirs = new Set();
  const children = new Map();   // top folder -> Set of its immediate entries
  let rootFiles = 0;
  for (const entry of entries) {
    const clean = entry.replace(/^\.\//, '').replace(/^\/+/, '');
    if (!clean) continue;
    const slash = clean.indexOf('/');
    if (slash === -1) { rootFiles++; continue; }
    const top = clean.slice(0, slash);
    dirs.add(top);
    const rest = clean.slice(slash + 1);
    const next = rest.indexOf('/');
    const child = next === -1 ? rest : rest.slice(0, next);
    if (child) {
      if (!children.has(top)) children.set(top, new Set());
      children.get(top).add(child.toLowerCase());
    }
  }
  const folders = [...dirs];
  if (!folders.length) return { mode: 'root' };

  const targets = [path.basename(installPath || ''), gameName].map(normalizeName).filter((t) => t.length >= 3);
  const exact = folders.filter((f) => targets.includes(normalizeName(f)));
  if (exact.length === 1) return { mode: 'folder', folder: exact[0], how: 'exact' };
  if (exact.length > 1) return { mode: 'ambiguous', folders: exact };

  // A release folder is often named after the member, not the game
  // ("DenuvOwO/bin64/…" for Crimson Desert), and mirrors the game's root.
  // The folder whose own entries exist in the install is the game's.
  let installEntries = null;
  try {
    if (installPath && fs.existsSync(installPath)) {
      installEntries = new Set(fs.readdirSync(installPath).map((n) => n.toLowerCase()));
    }
  } catch { installEntries = null; }
  if (installEntries && installEntries.size) {
    const scored = folders.map((f) => {
      const kids = children.get(f) || new Set();
      let overlap = 0;
      for (const k of kids) if (installEntries.has(k)) overlap++;
      return { f, overlap };
    }).filter((s) => s.overlap > 0).sort((a, b) => b.overlap - a.overlap);
    if (scored.length === 1 || (scored.length > 1 && scored[0].overlap > scored[1].overlap)) {
      return { mode: 'folder', folder: scored[0].f, how: 'mirror', overlap: scored[0].overlap };
    }
  }

  const partial = folders.filter((f) => {
    const n = normalizeName(f);
    return n.length >= 4 && targets.some((t) => t.length >= 4 && (n.includes(t) || t.includes(n)));
  });
  if (partial.length === 1) return { mode: 'folder', folder: partial[0], how: 'partial' };
  if (partial.length > 1) return { mode: 'ambiguous', folders: partial };

  // One folder and nothing beside it: the pack is that folder.
  if (folders.length === 1 && rootFiles === 0) return { mode: 'folder', folder: folders[0], how: 'only' };
  return { mode: 'ambiguous', folders };
}

/**
 * What each top-level folder of an archive holds, for a person to choose
 * from when pickGameFolder could not: file count and the first few entries.
 */
function describeFolders(entries, folders = null) {
  const info = new Map();
  for (const entry of entries) {
    const clean = entry.replace(/^\.\//, '').replace(/^\/+/, '');
    const slash = clean.indexOf('/');
    if (slash === -1) continue;
    const top = clean.slice(0, slash);
    if (folders && !folders.includes(top)) continue;
    if (!info.has(top)) info.set(top, { folder: top, files: 0, entries: new Set() });
    const rec = info.get(top);
    const rest = clean.slice(slash + 1);
    if (!rest) continue;
    const next = rest.indexOf('/');
    rec.entries.add(next === -1 ? rest : `${rest.slice(0, next)}/`);
    if (!clean.endsWith('/')) rec.files++;
  }
  return [...info.values()].map((rec) => ({
    folder: rec.folder,
    files: rec.files,
    entries: [...rec.entries].sort((a, b) => (a.endsWith('/') === b.endsWith('/') ? a.localeCompare(b) : a.endsWith('/') ? -1 : 1)).slice(0, 8),
    more: Math.max(0, rec.entries.size - 8),
  }));
}

/**
 * Put the game's own Steam library back before a release goes over it.
 *
 * SteamAutoCrack swaps steam_api(64).dll for the emulator and keeps the
 * original beside it as `.bak`. A member's release is built on the game's
 * own DLL — it brings its own client (coldclient, a dinput8 hook, a
 * hypervisor driver) — and with the emulator's DLL still in place the game
 * dies at SteamAPI_Init with "Unable to create interface ISteamUser".
 * Measured on Onimusha: Way of the Sword, 2026-09-04.
 *
 * The emulator's copy is kept as `.emu.bak` so nothing is lost.
 * @returns {string[]} the DLLs restored, relative to the install
 */
function restoreEmulatorBackups(installPath, onLog = () => {}) {
  const restored = [];
  const visit = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3 && !/^(\.|_storage_|coldclient|steam_settings)/i.test(entry.name)) visit(full, depth + 1);
        continue;
      }
      if (!/^steam_api(64)?\.dll\.bak$/i.test(entry.name)) continue;
      const live = full.slice(0, -4);
      if (!fs.existsSync(live)) { try { fs.renameSync(full, live); restored.push(path.relative(installPath, live)); } catch { /* leave it */ } continue; }
      try {
        const emu = `${live}.emu.bak`;
        try { if (fs.existsSync(emu)) fs.unlinkSync(emu); } catch { /* replaced below */ }
        fs.renameSync(live, emu);
        fs.renameSync(full, live);
        restored.push(path.relative(installPath, live));
      } catch (err) {
        onLog(`⚠ Could not put ${entry.name.slice(0, -4)} back: ${err.message}`);
      }
      // The emulator's settings folder beside it goes the same way. Left in
      // place it shadows the release's own (steam_settings next to the exe
      // wins), and its unlock_all=1 is what stalled Onimusha's DLC check.
      const settingsDir = path.join(dir, 'steam_settings');
      try {
        if (fs.existsSync(settingsDir) && fs.statSync(settingsDir).isDirectory()) {
          const aside = `${settingsDir}.emu.bak`;
          try { fs.rmSync(aside, { recursive: true, force: true }); } catch { /* replaced below */ }
          fs.renameSync(settingsDir, aside);
          restored.push(path.relative(installPath, settingsDir));
        }
      } catch (err) {
        onLog(`⚠ Could not set the emulator's steam_settings aside: ${err.message}`);
      }
    }
  };
  visit(installPath, 0);
  if (restored.length) onLog(`↩ Emulator leftovers set aside before the release goes on (${restored.join(', ')}); the game's own files are back and the emulator's copies are kept as .emu.bak.`);
  return restored;
}

function walkFiles(root, out = [], rel = '') {
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkFiles(root, out, next);
    else if (entry.isFile()) out.push(next);
  }
  return out;
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

/**
 * Place the game's folder from an archive over an installed game.
 *
 * Extracts into a staging directory on the same volume, then moves file by
 * file so every original that is replaced is kept beside it as
 * `<name>.csrin.bak` — the same idea as the emulator's `.bak`, under a
 * different suffix so neither tool mistakes the other's backup for its own.
 *
 * @returns {{ files: number, replaced: number, folder: string, mode: string }}
 */
async function extractInto(archivePath, installPath, options = {}) {
  const { gameName = '', folder: forcedFolder = '', onLog = () => {} } = options;
  if (!archivePath || !fs.existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`);
  if (!installPath || !fs.existsSync(installPath) || !fs.statSync(installPath).isDirectory()) {
    throw new Error(`The game folder does not exist: ${installPath}`);
  }

  const entries = await listArchive(archivePath);
  const choice = forcedFolder ? { mode: 'folder', folder: forcedFolder, how: 'chosen' } : pickGameFolder(entries, { installPath, gameName });
  if (choice.mode === 'ambiguous') {
    throw new Error(`The archive holds several folders (${choice.folders.join(', ')}) and none is named after the game "${path.basename(installPath)}". Nothing was placed.`);
  }
  if (choice.mode === 'folder') {
    onLog(choice.how === 'only'
      ? `📂 The archive is one folder, "${choice.folder}" — placing its contents into the game.`
      : choice.how === 'mirror'
        ? `📂 Taking "${choice.folder}" from the archive — its layout mirrors the game folder (${choice.overlap} matching entr${choice.overlap === 1 ? 'y' : 'ies'}) — and nothing else.`
        : choice.how === 'chosen'
          ? `📂 Taking "${choice.folder}" from the archive, as chosen, and nothing else.`
          : `📂 Taking "${choice.folder}" from the archive — the folder that matches the game — and nothing else.`);
  } else {
    onLog('📂 The archive has no folders; its files go straight into the game.');
  }

  const staging = path.join(installPath, `.librarian-csrin-stage-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    const args = ['-xf', archivePath, '-C', staging];
    if (choice.mode === 'folder') args.push('--strip-components', '1', choice.folder);
    const r = await runTool(tarPath(), args);
    if (r.code !== 0) throw new Error(`bsdtar failed: ${r.stderr.trim().split('\n').pop() || `exit ${r.code}`}`);

    const files = walkFiles(staging);
    if (!files.length) throw new Error(`Nothing came out of the archive for "${choice.folder || 'root'}".`);

    let replaced = 0;
    for (const rel of files) {
      const from = path.join(staging, rel);
      const to = path.join(installPath, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (fs.existsSync(to)) {
        const backup = `${to}${BACKUP_SUFFIX}`;
        try { if (fs.existsSync(backup)) fs.unlinkSync(backup); } catch { /* replaced below */ }
        try {
          fs.renameSync(to, backup);
        } catch (err) {
          throw new Error(`Cannot replace ${rel} — is the game running? (${err.message})`);
        }
        replaced++;
      }
      moveFile(from, to);
    }
    return { files: files.length, replaced, folder: choice.folder || '', mode: choice.mode };
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

module.exports = {
  status,
  search,
  cancelSearch,
  download,
  listArchive,
  pickGameFolder,
  describeFolders,
  extractInto,
  restoreEmulatorBackups,
  defaultDownloadDir,
  shapePost,
  parseBuild,
  labelledLinks,
  isExternalLink,
  isForumAttachment,
  BACKUP_SUFFIX,
};
