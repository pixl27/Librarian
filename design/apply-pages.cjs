// One-off: replace a span of index.html, between two markers, with a fragment.
//   node design/apply-pages.cjs <fragment> "<start marker>" "<end marker>"
const fs = require('fs');
const path = require('path');
const [fragment, startMarker, endMarker] = process.argv.slice(2);
const file = path.join(__dirname, '..', 'src', 'index.html');
let html = fs.readFileSync(file, 'utf8');
const start = html.indexOf(startMarker);
const end = html.indexOf(endMarker);
if (start < 0 || end < 0 || end <= start) throw new Error(`markers not found (${start}, ${end})`);
html = html.slice(0, start) + fs.readFileSync(path.join(__dirname, fragment), 'utf8').replace(/\r\n/g, '\n') + html.slice(end);
fs.writeFileSync(file, html);
console.log('replaced', end - start, 'characters');
