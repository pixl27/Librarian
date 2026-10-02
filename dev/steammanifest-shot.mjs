#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Screenshot the manifest source controls in the running application, over
// CDP. Evidence for the one gate no command can decide
// (GATES-steammanifest.md G14): the Settings API section shows the Manifest
// source picker with the vendored copy reported found, and the Store's
// subtitle names the source in effect for the setting chosen.
//
// Run under Electron's Node, so the global WebSocket exists:
//
//   set ELECTRON_RUN_AS_NODE=1
//   node_modules\electron\dist\electron.exe dev/steammanifest-shot.mjs --out <dir>
//
// The application's own settings are used. The Manifest source setting is
// moved through its three values to photograph each, and put back to what it
// was before the run finishes.
// ═══════════════════════════════════════════════════════════════════
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const OUT = path.resolve(opt('--out', path.join(ROOT, 'dev', 'shots')));
const PORT = Number(opt('--port', '9336'));
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const findings = [];

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (m) => this.onMessage(JSON.parse(m.data)); }
  onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`  shot ${path.relative(ROOT, file)}`);
  }
}

const appEnv = { ...process.env };
delete appEnv.ELECTRON_RUN_AS_NODE;
const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'ignore', env: appEnv });
let cdp = null;
let restore = null;
try {
  let targets = [];
  for (let i = 0; i < 60 && !targets.length; i++) {
    await sleep(500);
    try { targets = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === 'page' && /index\.html/.test(t.url)); }
    catch { /* not up yet */ }
  }
  if (!targets.length) throw new Error('the application did not expose its page over CDP');
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  for (let i = 0; i < 60; i++) {
    if (await cdp.eval('Boolean(window.Librarian && window.Librarian.settings)')) break;
    await sleep(500);
  }

  restore = await cdp.eval("window.Librarian.settings.manifest_source || 'auto'");
  console.log(`  the setting was "${restore}"`);

  // The Settings API section, with the picker, the folder and the status line.
  await cdp.eval("window.Librarian.navigateTo('settings')");
  await sleep(600);
  await cdp.eval("document.querySelector('#settings-graphics')?.scrollIntoView?.({ block: 'start' }); document.querySelector('#sel-manifest-source').scrollIntoView({ block: 'center' }); true");
  await sleep(700);
  await cdp.shot(path.join(OUT, 'sm-1-settings.png'));
  // The rest of the card: the folder, the mirror and the status line.
  await cdp.eval("document.querySelector('#steammanifest-tools-line').scrollIntoView({ block: 'center' }); true");
  await sleep(700);
  await cdp.shot(path.join(OUT, 'sm-1b-settings-status.png'));
  const settingsRead = await cdp.eval(`JSON.stringify({
    options: [...document.querySelectorAll('#sel-manifest-source option')].map(o => o.value),
    selected: document.querySelector('#sel-manifest-source').value,
    folder: document.querySelector('#steammanifest-dir-label').textContent,
    mirror: document.querySelector('#inp-steammanifest-mirror').placeholder,
    status: document.querySelector('#steammanifest-tools-line').textContent,
  })`);
  console.log(`  settings: ${settingsRead}`);
  findings.push(['settings', JSON.parse(settingsRead)]);

  // The Store's subtitle, for each source the setting can choose.
  for (const [value, file] of [['auto', 'sm-2-store-auto.png'], ['steammanifest', 'sm-3-store-steammanifest.png'], ['hubcap', 'sm-4-store-hubcap.png']]) {
    await cdp.eval(`(async () => {
      const sel = document.querySelector('#sel-manifest-source');
      sel.value = ${JSON.stringify(value)};
      sel.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 900));
    })()`);
    await cdp.eval("window.Librarian.navigateTo('store')");
    await sleep(900);
    await cdp.shot(path.join(OUT, file));
    const store = await cdp.eval(`JSON.stringify({
      setting: ${JSON.stringify(value)},
      sub: document.querySelector('#store-sub').textContent,
      status: document.querySelector('#search-status').textContent,
      sources: document.documentElement.dataset.manifestSource || '',
    })`);
    console.log(`  store (${value}): ${store}`);
    findings.push(['store', JSON.parse(store)]);
    await cdp.eval("window.Librarian.navigateTo('settings')");
    await sleep(400);
  }
} finally {
  try {
    if (cdp && restore) {
      await cdp.eval(`(async () => {
        const sel = document.querySelector('#sel-manifest-source');
        sel.value = ${JSON.stringify(restore)};
        sel.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 700));
      })()`);
      console.log(`  the setting was put back to "${restore}"`);
    }
  } catch (err) { console.error(`  could not restore the setting: ${err.message}`); }
  try { app.kill(); } catch { /* already gone */ }
}
fs.writeFileSync(path.join(OUT, 'steammanifest-shot.json'), JSON.stringify(findings, null, 2));
console.log('OK shot');
