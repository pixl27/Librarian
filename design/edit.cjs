// Small literal find/replace helper for source edits that are awkward to do
// by hand. Usage: node design/edit.cjs <edits.json>
// edits.json: [{ "file": "src/js/app.js", "from": "...", "to": "...", "all": false }]
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const edits = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const cache = new Map();
for (const { file, from, to, all } of edits) {
  const p = path.join(root, file);
  let src = cache.has(p) ? cache.get(p) : fs.readFileSync(p, 'utf8');
  const count = src.split(from).length - 1;
  if (count === 0) throw new Error(`not found in ${file}: ${from.slice(0, 70)}`);
  if (count > 1 && !all) throw new Error(`${count} matches in ${file}: ${from.slice(0, 70)}`);
  // split/join, never String.replace: a "$$" in the replacement must stay "$$".
  src = src.split(from).join(to);
  cache.set(p, src);
}
for (const [p, src] of cache) fs.writeFileSync(p, src);
console.log(`${edits.length} edit(s) applied to ${cache.size} file(s)`);
