// Drives the packaged app over CDP: opens Crimson Desert's CS.RIN.RU picker
// and reports the installed patch it shows, with a screenshot.
// Run: ELECTRON_RUN_AS_NODE=1 electron.exe dev/patch-picker-shot.mjs <port> <out.png>
import fs from 'node:fs';
const [port, out] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && !/devtools/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const waiting = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const until = async (expr, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await evaluate(expr); if (v) return v; await new Promise((r) => setTimeout(r, 400)); } return null; };

await until(`(window.Librarian?.games || []).some(g => g.appid == '3321460')`);
await evaluate(`(() => { const g = Librarian.games.find(g => g.appid == '3321460'); Librarian.openFlyout(g); return true; })()`);
const btn = await until(`!!document.querySelector('#flyout-csrin-btn')`, 30000);
console.log('csrin button:', btn);
await evaluate(`document.querySelector('#flyout-csrin-btn').click(), true`);
const patch = await until(`(() => { const s = document.querySelector('#csrin-patch-source'); return s && !/Looking up/.test(s.textContent) ? { value: document.querySelector('#csrin-patch').value, source: s.textContent } : null; })()`, 60000);
console.log('picker patch:', JSON.stringify(patch));
const box = await evaluate(`(() => { const r = document.querySelector('.csrin-target').getBoundingClientRect(); const i = document.querySelector('#csrin-patch').getBoundingClientRect(); return { target: [r.width, r.height], input: [i.width, i.height] }; })()`);
console.log('geometry:', JSON.stringify(box));
if (process.argv[4] === 'results') {
  const posts = await until(`(() => { const a = [...document.querySelectorAll('.csrin-post')]; return a.length ? a.map(p => p.className + ' | ' + (p.querySelector('.csrin-badge')?.textContent || '') + ' | install disabled=' + (p.querySelector('[data-install]')?.disabled ?? 'n/a')) : null; })()`, 180000);
  console.log('posts:', JSON.stringify(posts));
  console.log('status:', await evaluate(`document.querySelector('#csrin-status')?.textContent`));
}
await new Promise((r) => setTimeout(r, 600));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
await evaluate(`document.querySelector('#modal-close')?.click(), true`);
ws.close();
