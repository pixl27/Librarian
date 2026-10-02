// CS.RIN.RU releases are matched by patch number (src/core/patchVersion.js and
// the picker in src/js/app.js). This checks the pieces that decide a match:
// reading a patch out of a title or release name, comparing two patches,
// inferring the installed patch from build and announcement dates, the
// renderer's verdict on a post, and the v6 settings migration to ARTIFACT.
//
//   node dev/verify-patch-version.cjs          offline checks
//   node dev/verify-patch-version.cjs --live   plus the real installs on E:
//                                              (run under Electron's Node)
const fs = require('fs');
const path = require('path');
const pv = require('../src/core/patchVersion');

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };
const eq = (a, b, msg) => check(a === b, `${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

// Pull a named function's source out of a file: the renderer and the settings
// store keep these inside closures or unexported, and the point is to test
// the code that ships, not a copy of it.
function extract(file, name) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${file}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} has no end in ${file}`);
}

// ─── Reading a patch number ─────────────────────────────────────
const titles = [
  ['Patch Notes Version 2.03.02', '2.03.02'],
  ['Patch Notes Version 1.18.01 (All Platforms Hotfix)', '1.18.01'],
  ['CONTROL Resonant Game Update 1.4.0 brings New Game++ & Quality of Life fixes', '1.4.0'],
  ['Crimson.Desert.Enhanced.Update.v2.03.02.Crack.Only-ARTIFACT', '2.03.02'],
  ['Two.Point.Museum.Update.v11.0.234399.Crack.Only-ARTIFACT', '11.0.234399'],
  ['Hotfix v1.0.3 is live', '1.0.3'],
  ['Patch 2.04.a THE KILN IS BACK', '2.04'],
  ['Charting the Unknown: DLC Pre-Orders Now Available (Revised: 2026/30/09)', ''],
  ['Crimson Desert, On Sale for 20% Off', ''],
  ['2 Million Wishlists – Thank You!', ''],
  ['ACE.COMBAT.8.WINGS.OF.THEVE.Crack.Only-ARTIFACT', ''],
];
for (const [t, want] of titles) eq(pv.versionFromText(t), want, `versionFromText(${JSON.stringify(t)})`);

// ─── Comparing two patches ──────────────────────────────────────
check(pv.sameVersion('2.03.02', '2.3.2'), '2.03.02 is 2.3.2');
check(pv.sameVersion('1.4', '1.4.0'), '1.4 is 1.4.0');
check(pv.sameVersion('v1.4.0', '1.4'), 'a leading v is ignored');
check(!pv.sameVersion('2.03.01', '2.03.02'), '2.03.01 is not 2.03.02');
check(!pv.sameVersion('1.4', '1.40'), '1.4 is not 1.40');
check(!pv.sameVersion('', ''), 'two unknowns never match');
check(!pv.sameVersion('UE5-CL-0', 'UE5-CL-0'), 'a non-numeric version never matches');

// The renderer carries its own copy of the rule; they must agree.
const patchKey = new Function(`${extract('src/js/app.js', 'patchKey')}; return patchKey;`)();
for (const v of ['2.03.02', '2.3.2', '1.4', '1.4.0', '1.40', 'v1.0', '0', '0.0.1', '', 'abc', '1..2', '11.0.234399', ' 2.00.00 ']) {
  eq(patchKey(v), pv.versionKey(v), `renderer patchKey agrees with versionKey on ${JSON.stringify(v)}`);
}

// ─── Inferring the installed patch ──────────────────────────────
const H = 3600 * 1000;
const t0 = Date.UTC(2026, 8, 21, 10, 0, 0);
// Crimson Desert's real spacing: 2.03.01 and 2.03.02 under two days apart.
const items = [
  { version: '2.03.02', date: t0 + 42 * H, title: 'Patch Notes Version 2.03.02' },
  { version: '2.03.01', date: t0 + 4 * H, title: 'Patch Notes Version 2.03.01' },
  { version: '2.03.00', date: t0 - 84 * H, title: 'Patch Notes Version 2.03.00' },
];
eq(pv.inferAt(items, t0)?.version, '2.03.01', 'a build is the patch whose notes follow it (not the next one 42 h later)');
eq(pv.inferAt(items, t0 + 40 * H)?.version, '2.03.02', 'the next build gets the next notes');
eq(pv.inferAt(items, t0 + 40 * H)?.rule, 'notes', 'and says it came from the notes');
// 24 h after 2.03.00's notes and 64 h before 2.03.01's: outside every window.
eq(pv.inferAt(items, t0 - 60 * H)?.version, '2.03.00', 'a silent hotfix keeps the previous patch number');
eq(pv.inferAt(items, t0 - 60 * H)?.rule, 'previous', 'and says so');
// The known limit: a build up to 48 h before the next notes reads as that
// patch (CONTROL Resonant 1.4.0 really was 45 h early). A silent hotfix in
// that window is indistinguishable by dates — the picker's field corrects it.
eq(pv.inferAt(items, t0 - 40 * H)?.version, '2.03.01', 'documented limit: a build 44 h before notes is taken as that patch');
eq(pv.inferAt(items, t0 - 200 * H), null, 'a build older than every announcement is unknown');
eq(pv.inferAt([], t0), null, 'no announcements, no patch');
// A fresh build with no notes yet is not given the previous number: that is
// how an update got past its release.
const fresh = t0 + 100 * H;
eq(pv.inferAt(items, fresh, { now: fresh + 5 * H })?.rule, 'pending', 'a 5 h old build without notes is pending');
eq(pv.inferAt(items, fresh, { now: fresh + 5 * H })?.version, '', 'and has no version');
eq(pv.inferAt(items, fresh, { now: fresh + 60 * H })?.version, '2.03.02', 'once two days pass, it keeps the previous patch');
// A go-live time: notes may come a few hours before it.
// Crimson Desert 2.03.02: notes 04:48, live 08:26 UTC on 2026-09-23.
const live = Date.UTC(2026, 8, 23, 8, 26, 15);
const real = [
  { version: '2.03.02', date: Date.UTC(2026, 8, 23, 4, 48), title: 'Patch Notes Version 2.03.02' },
  { version: '2.03.01', date: Date.UTC(2026, 8, 21, 14, 8), title: 'Patch Notes Version 2.03.01' },
];
const around = { before: 6 * H, now: live + 200 * H };
eq(pv.inferAt(real, live, around)?.version, '2.03.02', 'go-live 3.6 h after its notes: that patch');
eq(pv.inferAt(real, live, around)?.rule, 'notes', 'and from the notes');
const late = [{ version: '1.4.0', date: live + 45 * H, title: 'Game Update 1.4.0' }];
eq(pv.inferAt(late, live, around)?.version, '1.4.0', 'notes two days after go-live still name it (CONTROL Resonant 1.4.0)');

// ─── The picker's verdict on a post ─────────────────────────────
const csrinPatchMatch = new Function('patchKey', `${extract('src/js/app.js', 'csrinPatchMatch')}; return csrinPatchMatch;`)(patchKey);
const csrinPostFor = new Function('patchKey', `${extract('src/js/app.js', 'csrinPostFor')}; return csrinPostFor;`)(patchKey);
const game = { buildid: '24934353' };
const link = [{ url: 'https://bzzhr.to/x' }];
eq(csrinPatchMatch({ version: '2.00.00' }, game, { version: '2.0' }).state, 'match', 'same patch, different spelling: match');
eq(csrinPatchMatch({ version: '2.03.02' }, game, { version: '2.00.00' }).state, 'mismatch', 'different patch: mismatch');
eq(csrinPatchMatch({ version: '2.03.02', build: '24934353' }, game, { version: '2.00.00' }).state, 'mismatch', 'the patch decides even when the build agrees');
eq(csrinPatchMatch({ version: '2.03.02' }, game, { version: '' }).state, 'unknown', 'installed patch unknown: ask');
eq(csrinPatchMatch({ version: '2.03.02' }, game, null).state, 'unknown', 'installed patch not looked up yet: ask');
eq(csrinPatchMatch({ build: '24934353' }, game, { version: '2.00.00' }).state, 'match', 'a post with only a build falls back to the build');
eq(csrinPatchMatch({ build: '24934353' }, game, { version: '2.00.00' }).by, 'build', 'and says it compared builds');
eq(csrinPatchMatch({ build: '1' }, game, { version: '2.00.00' }).state, 'mismatch', 'build fallback refuses another build');
eq(csrinPatchMatch({}, game, { version: '2.00.00' }).state, 'unknown', 'a post that states nothing: ask');

const posts = [
  { version: '2.03.02', links: link },
  { version: '2.00.00', links: [] },
  { version: '2.00.00', links: link, tag: 'linked' },
  { build: '24934353', links: link, tag: 'build-only' },
];
eq(csrinPostFor(posts, '2.0', '24934353')?.tag, 'linked', 'the post for the patch, with a link');
eq(csrinPostFor(posts, '9.9', '24934353')?.tag, 'build-only', 'no post for the patch: a build-only post for the build');
eq(csrinPostFor(posts, '9.9', ''), null, 'nothing for an unknown patch without a build');
eq(csrinPostFor([{ version: '2.03.02', build: '24934353', links: link }], '', '24934353'), null, 'a post naming another patch is never taken on its build alone');

// ─── v6 settings migration ──────────────────────────────────────
const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'src/core/settingsStore.js'), 'utf8');
const version = Number(/const SETTINGS_VERSION = (\d+);/.exec(settingsSrc)[1]);
const applyMigrations = new Function('DEFAULTS', 'SETTINGS_VERSION', `${extract('src/core/settingsStore.js', 'applyMigrations')}; return applyMigrations;`)({ bigpicture_accent: '#00C2A8' }, version);
const migrate = (d) => { applyMigrations(d); return d; };
eq(migrate({ settings_version: 5, csrin_author: 'DenuvOwO' }).csrin_author, 'ARTIFACT', 'v5 file on the old default moves to ARTIFACT');
eq(migrate({ settings_version: 5, csrin_author: 'denuvowo' }).csrin_author, 'ARTIFACT', 'case does not matter');
eq(migrate({ settings_version: 5, csrin_author: 'artifact' }).csrin_author, 'artifact', 'a member already chosen is left alone');
eq(migrate({ settings_version: 5, csrin_author: 'Someone' }).csrin_author, 'Someone', 'another member is left alone');
eq(migrate({ settings_version: version, csrin_author: 'DenuvOwO' }).csrin_author, 'DenuvOwO', 'a current file that chose DenuvOwO again is not re-migrated');

(async () => {
  if (process.argv.includes('--live')) {
    const live = [
      ['3321460', 'Crimson_Desert', '2.00.00'],
      ['3669870', 'CONTROL_Resonant', '1.4.0'],
    ];
    for (const [appid, dir, want] of live) {
      const p = await pv.installedPatch({ appid, installPath: `E:/Games/steam/steamapps/common/${dir}` });
      eq(p.version, want, `live: ${dir} installed patch (${p.title || p.error})`);
    }
    // The public build, dated by steamcmd.net: what an update lands on.
    const { fetchRemote } = require('../src/core/updateChecker');
    for (const [appid, want] of [['3321460', '2.03.02'], ['3669870', '1.4.0']]) {
      const remote = await fetchRemote(appid, true);
      const t = await pv.targetPatch(appid, remote.remoteBuildTime);
      eq(t.version, want, `live: ${appid} public build ${remote.remoteBuildId} (live ${new Date(remote.remoteBuildTime).toISOString()}) is patch — ${t.title || t.error}`);
    }
  }
  console.log(failures ? `FAIL ${failures}` : 'OK patch-version');
  process.exit(failures ? 1 : 0);
})();
