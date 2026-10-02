#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Screenshot the emulator-compatibility surfaces in the running application.
//
// Evidence for GATES-emucompat.md G8: the game panel for a blocked game
// explains the block and offers the update; the Crack page shows the
// emulator's build with its update control. Starts Librarian with a remote
// debugging port, attaches over CDP, opens the flyout of the given game,
// captures it, presses "Update & apply", captures the outcome, then the
// Crack page. Run under Electron's Node for the global WebSocket:
//
//   set ELECTRON_RUN_AS_NODE=1
//   node_modules\electron\dist\electron.exe dev/emucompat-shot.mjs --out <dir> [--game "Mortal Shell II"]
//
// The block record it shows must already be in the game meta store (the
// engine or the post-launch check write it; the gate runner stages the one
// Mortal Shell II earned on 2026-09-06 before calling this).
// ═══════════════════════════════════════════════════════════════════
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const OUT = path.resolve(opt('--out', path.join(ROOT, 'dev', 'shots')));
const GAME = opt('--game', 'Mortal Shell II');
const PORT = 9334;
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (m) => this.onMessage(JSON.parse(m.data)); }
  onMessage(msg) { if (msg.id && this.pending.has(msg.id)) { const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); } }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || ''));
    return r.result.value;
  }
  async shot(file) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); console.log(`  shot ${file}`); }
}

const appEnv = { ...process.env };
delete appEnv.ELECTRON_RUN_AS_NODE;
const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'ignore', env: appEnv });
try {
  let targets = [];
  for (let i = 0; i < 60 && !targets.length; i++) {
    await sleep(500);
    try { targets = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch { /* not up */ }
  }
  if (!targets.length) throw new Error('the application did not expose its page over CDP');
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  for (let i = 0; i < 60; i++) {
    if (await cdp.eval('Boolean(window.Librarian && window.Librarian.games && window.Librarian.games.length)')) break;
    await sleep(500);
  }
  const found = await cdp.eval(`(() => { const g = window.Librarian.games.find((x) => x.game_name === ${JSON.stringify(GAME)}); return g ? g.game_name : null; })()`);
  if (!found) throw new Error(`${GAME} is not in the library`);

  // The game panel, with the block recorded for it.
  await cdp.eval(`window.Librarian.openFlyout(window.Librarian.games.find((x) => x.game_name === ${JSON.stringify(GAME)})); true`, false);
  let visible = false;
  for (let i = 0; i < 20 && !visible; i++) { await sleep(500); visible = await cdp.eval("(() => { const p = document.querySelector('#flyout-emu'); return Boolean(p) && !p.classList.contains('hidden'); })()"); }
  console.log(`  panel visible: ${visible}`);
  await cdp.eval("document.querySelector('#flyout-emu') && document.querySelector('#flyout-emu').scrollIntoView({ block: 'center' }); true", false);
  await sleep(600);
  await cdp.shot(path.join(OUT, 'emu-1-panel.png'));
  console.log(`  panel text: ${await cdp.eval("[ '#flyout-emu-title', '#flyout-emu-sub', '#flyout-emu-note' ].map((s) => (document.querySelector(s) || {}).textContent || '').join(' | ')")}`);

  // The one action, as a user would take it.
  if (visible) {
    await cdp.eval("document.querySelector('#flyout-emu-update').click(); true", false);
    let settled = false;
    for (let i = 0; i < 240 && !settled; i++) {
      await sleep(500);
      settled = await cdp.eval("(() => { const p = document.querySelector('#flyout-emu'); return p.classList.contains('is-ok') || p.classList.contains('hidden') || /Could not|blocked/i.test(document.querySelector('#flyout-emu-note').textContent); })()");
    }
    await sleep(800);
    await cdp.shot(path.join(OUT, 'emu-2-after-apply.png'));
    console.log(`  after apply: ${await cdp.eval("(() => { const p = document.querySelector('#flyout-emu'); return p.className + ' | ' + document.querySelector('#flyout-emu-sub').textContent + ' | ' + document.querySelector('#flyout-emu-note').textContent; })()")}`);
  }

  // The Crack page and its emulator line.
  await cdp.eval("window.Librarian.closeFlyout && window.Librarian.closeFlyout(); window.Librarian.navigateTo('crack'); true", false);
  for (let i = 0; i < 20; i++) { await sleep(500); if (/Installed emulator/.test(await cdp.eval("document.querySelector('#crack-emu-build-text').textContent"))) break; }
  await sleep(600);
  await cdp.shot(path.join(OUT, 'emu-3-crack-page.png'));
  console.log(`  crack page: ${await cdp.eval("document.querySelector('#crack-emu-build-text').textContent")}`);
  console.log('OK shot');
} catch (e) {
  console.error(`FAIL ${e.message}`);
  process.exitCode = 1;
} finally {
  try { app.kill(); } catch { /* gone */ }
  spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
}
