// One-off: Big Picture has its own stylesheet, but part of what it needs lived
// in two files the desktop rewrite replaced — its store screens in store.css
// and its motion in kinetic.css. Put those rules back, unchanged, taken from
// the backup in design/legacy-ui.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const legacy = (f) => fs.readFileSync(path.join(__dirname, 'legacy-ui', 'styles', f), 'utf8').replace(/\r\n/g, '\n').split('\n');
const lines = (arr, from, to) => arr.slice(from - 1, to).join('\n');

// ── store.css: the Big Picture store screens ─────────────────────
const store = legacy('store.css');
const bpStore = [
  lines(store, 703, 1255),
  lines(store, 1274, 1333),
  lines(store, 1474, 1478),
].join('\n\n');
if (!bpStore.includes('#bp-root .bp-sf-strip') || !bpStore.includes('#bp-root #bp-results')) throw new Error('store extraction missed the rules it was after');
const storePath = path.join(root, 'src', 'styles', 'store.css');
let current = fs.readFileSync(storePath, 'utf8');
const marker = '/* ═══ BIG PICTURE STORE (not redrawn yet) ';
if (current.includes(marker)) current = current.slice(0, current.indexOf(marker)).trimEnd() + '\n';
current += `\n${marker}═════════════════════════════
   Big Picture keeps its own look until it is redrawn. These rules are the
   ones it had, unchanged: they are all scoped under #bp-root and speak its
   --u units, so nothing here reaches the desktop store above.
   ═══════════════════════════════════════════════════════════════════ */\n${bpStore}\n`;
fs.writeFileSync(storePath, current);

// ── bigpicture-motion.css: its motion, with the keyframes it names ──
const kin = legacy('kinetic.css');
const text = kin.join('\n');
const rootStart = kin.findIndex((l) => l.startsWith(':root {'));
let rootEnd = rootStart;
while (!kin[rootEnd].startsWith('}')) rootEnd++;
const keyframes = [];
const re = /@keyframes\s+[\w-]+\s*\{/g;
let m;
while ((m = re.exec(text))) {
  let depth = 0, i = m.index + m[0].length - 1;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) break; }
  }
  keyframes.push(text.slice(m.index, i + 1));
}
const bpSection = lines(kin, 962, 1255);
const bpStoreMotion = lines(kin, 1403, 1427);
// The section must not carry keyframes twice.
const strip = (s) => s.replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
const out = `/* ═══════════════════════════════════════════════════════════════════
   Big Picture motion.

   Big Picture has not been redrawn yet and keeps the motion it had. These
   rules were part of the previous kinetic.css; they are all scoped under
   html[data-kinetic="on"] #bp-root, so they never reach the desktop
   interface, whose motion now lives in kinetic.css.
   ═══════════════════════════════════════════════════════════════════ */

${lines(kin, rootStart + 1, rootEnd + 1)}

${[...new Set(keyframes)].join('\n')}

${strip(bpSection)}

${strip(bpStoreMotion)}

@media (prefers-reduced-motion: reduce) {
  html[data-kinetic="on"] #bp-root *,
  html[data-kinetic="on"] #bp-root *::before,
  html[data-kinetic="on"] #bp-root *::after {
    animation-duration: .01ms !important;
    animation-delay: 0ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
    transition-delay: 0ms !important;
  }
}
`;
fs.writeFileSync(path.join(root, 'src', 'styles', 'bigpicture-motion.css'), out);

// Sanity: every selector in the motion file is a Big Picture one.
const stray = strip(out).split('\n').filter((l) => /^html\[data-kinetic="on"\]/.test(l) && !/#bp-|\.bp-/.test(l) && !/#bp-root/.test(l));
console.log('bp store rules:', bpStore.split('\n').length, 'lines; keyframes:', keyframes.length, '; non-bp selector lines in motion file:', stray.length);
if (stray.length) console.log(stray.slice(0, 10).join('\n'));
