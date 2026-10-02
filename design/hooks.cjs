// List every class and id the renderer's markup can carry, per source file,
// so a new stylesheet can be checked for coverage.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'src');
const files = ['index.html', 'js/app.js', 'js/enhance.js', 'js/store.js', 'js/tuning.js', 'js/dialogs.js', 'js/dlssg.js', 'js/dlssgUpdates.js', 'js/kinetic.js', 'js/trailer.js', 'js/bigpicture.js'];

const out = {};
for (const f of files) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  const classes = new Set();
  const ids = new Set();
  const addClasses = (s) => s.split(/\s+/).forEach((c) => { if (/^[a-zA-Z][\w-]*$/.test(c)) classes.add(c); });
  for (const m of src.matchAll(/class(?:Name)?\s*=\s*\\?["'`]([^"'`]*)["'`]/g)) addClasses(m[1].replace(/\$\{[^}]*\}/g, ' '));
  for (const m of src.matchAll(/classList\.(?:add|remove|toggle|contains)\(([^)]*)\)/g)) {
    for (const q of m[1].matchAll(/['"`]([\w-]+)['"`]/g)) classes.add(q[1]);
  }
  for (const m of src.matchAll(/\bid\s*=\s*\\?["'`]([\w-]+)["'`]/g)) ids.add(m[1]);
  out[f] = { classes: [...classes].sort(), ids: [...ids].sort() };
}
fs.writeFileSync(path.join(__dirname, 'hooks.json'), JSON.stringify(out, null, 1));
for (const [f, v] of Object.entries(out)) console.log(f, 'classes', v.classes.length, 'ids', v.ids.length);
