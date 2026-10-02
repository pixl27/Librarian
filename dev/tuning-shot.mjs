#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Screenshot the Tuning page in the running application, over CDP.
//
// Evidence for the one gate no command can decide (GATES-tuning.md G10):
// the page renders with its switches, the tiles fill while a game runs, the
// A/B produces a table. This starts Librarian with a remote debugging port,
// attaches to its page, navigates to Tuning, optionally starts a game
// through the application's own bridge, waits for the tiles, runs the A/B,
// and saves PNGs. Run under Electron's Node so the global WebSocket exists:
//
//   set ELECTRON_RUN_AS_NODE=1
//   node_modules\electron\dist\electron.exe dev/tuning-shot.mjs --out <dir> [--game ULTRAKILL] [--seconds 10]
//
// The application's own settings are used, so this switches Tuning mode on
// through the page's switch for the run and switches it back off at the
// end — the default stays what it was unless the user chooses otherwise.
// ═══════════════════════════════════════════════════════════════════
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const OUT = path.resolve(opt('--out', path.join(ROOT, 'dev', 'shots')));
const GAME = opt('--game', 'ULTRAKILL');
const SECONDS = Number(opt('--seconds', '10'));
const PORT = 9333;
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const r = await fetch(url);
  return r.json();
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; ws.onmessage = (m) => this.onMessage(JSON.parse(m.data)); }
  onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) { const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
    else if (msg.method) this.events.push(msg);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    return r.result.value;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`  shot ${file}`);
  }
}

// This script runs under ELECTRON_RUN_AS_NODE; the application must not. An
// empty value still counts as set, so the variable is removed, not blanked.
const appEnv = { ...process.env };
delete appEnv.ELECTRON_RUN_AS_NODE;
const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'ignore', env: appEnv });
let cdp = null;
try {
  let targets = [];
  for (let i = 0; i < 60 && !targets.length; i++) {
    await sleep(500);
    try { targets = (await fetchJson(`http://127.0.0.1:${PORT}/json`)).filter((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch { /* not up yet */ }
  }
  if (!targets.length) throw new Error('the application did not expose its page over CDP');
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // Wait for the app to be ready and its library scanned.
  for (let i = 0; i < 60; i++) {
    const ready = await cdp.eval('Boolean(window.Librarian && window.Librarian.games && window.Librarian.games.length)');
    if (ready) break;
    await sleep(500);
  }
  await cdp.eval("window.Librarian.navigateTo('tuning')");
  await sleep(1200);
  const wasOn = await cdp.eval("Boolean(window.Librarian.settings && window.Librarian.settings.tuning && window.Librarian.settings.tuning.enabled)");
  if (!wasOn) {
    await cdp.eval("(() => { const c = document.querySelector('#tn-enabled'); if (!c.checked) c.click(); return c.checked; })()");
    await sleep(800);
  }
  await cdp.shot(path.join(OUT, 'tuning-1-idle.png'));

  // Start the game through the application's own bridge.
  const found = await cdp.eval(`(() => { const g = window.Librarian.games.find((x) => x.game_name === ${JSON.stringify(GAME)}); return g ? g.game_name : null; })()`);
  if (!found) throw new Error(`${GAME} is not in the library`);
  await cdp.eval(`window.Librarian.launchGame(window.Librarian.games.find((x) => x.game_name === ${JSON.stringify(GAME)}))`);
  // A Unity game pauses without the foreground, and a game started by an
  // application driven from a script may not get it; a real click does.
  const focusGame = () => {
    try { spawnSync('powershell', ['-NoProfile', '-Command', `Get-Process -Name ${JSON.stringify(GAME)} -ErrorAction SilentlyContinue | ForEach-Object { (New-Object -ComObject WScript.Shell).AppActivate($_.Id) }`], { windowsHide: true, timeout: 8000, stdio: 'ignore' }); }
    catch { /* try again on the next lap */ }
  };
  let live = false;
  for (let i = 0; i < 60 && !live; i++) {
    await sleep(1000);
    if (i % 3 === 0) focusGame();
    live = await cdp.eval("document.querySelector('#tn-m-fps').textContent !== '—'");
  }
  console.log(`  live tiles: ${live}`);
  await sleep(6000);
  await cdp.eval("window.Librarian.navigateTo('tuning')");
  await sleep(500);
  await cdp.shot(path.join(OUT, 'tuning-2-live.png'));
  const tiles = await cdp.eval("[...document.querySelectorAll('#tn-tiles .tn-tile-value')].map((e) => e.textContent).join(' | ')");
  console.log(`  tiles: ${tiles}`);
  console.log(`  status: ${await cdp.eval("document.querySelector('#tn-status').textContent")}`);

  // The before/after test, as a user would run it.
  await cdp.eval(`(() => { document.querySelector('#tn-ab-seconds').value = '${SECONDS}'; document.querySelector('#tn-ab-run').click(); return true; })()`);
  let rows = 0;
  for (let i = 0; i < (SECONDS * 2 + 20) * 2 && rows < 5; i++) {
    await sleep(500);
    rows = await cdp.eval("document.querySelectorAll('#tn-ab-body tr').length");
  }
  await sleep(400);
  await cdp.eval("document.querySelector('#tn-ab').scrollIntoView({ block: 'center' })");
  await sleep(300);
  await cdp.shot(path.join(OUT, 'tuning-3-ab.png'));
  const table = await cdp.eval("[...document.querySelectorAll('#tn-ab-body tr')].map((tr) => [...tr.children].map((td) => td.textContent).join(' | ')).join('\\n')");
  console.log(`  A/B table:\n${table.split('\n').map((l) => '    ' + l).join('\n')}`);

  // Stop the game and put the switch back. stopGame may open a confirmation
  // and never settle its promise, so it is fired and the exit is watched for.
  await cdp.eval(`window.Librarian.stopGame(window.Librarian.games.find((x) => x.game_name === ${JSON.stringify(GAME)})); true`, false);
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const running = await cdp.eval(`window.Librarian.isGameRunning(window.Librarian.games.find((x) => x.game_name === ${JSON.stringify(GAME)}))`);
    if (!running) break;
    if (i === 5) spawnSync('taskkill', ['/IM', `${GAME}.exe`, '/T', '/F'], { stdio: 'ignore' });
  }
  await sleep(1500);
  if (!wasOn) await cdp.eval("(() => { const c = document.querySelector('#tn-enabled'); if (c.checked) c.click(); return c.checked; })()");
  await sleep(600);
  await cdp.eval("window.scrollTo(0, 0); document.querySelector('#page-tuning .settings-panel').scrollTop = 0; true");
  await cdp.shot(path.join(OUT, 'tuning-4-after-exit.png'));
  console.log('OK shot');
} catch (e) {
  console.error(`FAIL ${e.message}`);
  process.exitCode = 1;
} finally {
  try { app.kill(); } catch { /* gone */ }
  spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
}
