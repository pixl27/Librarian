#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Structural verifier for the store work.
//
// It reads the shipped sources and asserts facts about them. It cannot see a
// rendered pixel, so every gate in GATES.md is worded as what this measures
// rather than as the visual outcome that motivated it. Where the visual
// outcome is the real subject, GATES.md carries a manual gate instead.
//
//   node dev/verify-store.mjs <suite>
//
// Each suite prints its failures and, only when every assertion in it passed,
// the line `OK <suite>` and exits 0. The success token is produced after the
// assertions, never before, so a crash cannot be mistaken for a pass.
//
// Lives in dev/ deliberately: electron-builder ships main.js, preload.js,
// src/**, tools/**, res/** and package.json, so nothing here reaches a user.
// ═══════════════════════════════════════════════════════════════════
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Pull one rule body out of a stylesheet by exact selector text. */
function ruleBody(css, selector) {
  const source = stripComments(css);
  const at = source.indexOf(selector + ' {');
  if (at === -1) return null;
  const open = source.indexOf('{', at);
  const close = source.indexOf('}', open);
  return close === -1 ? null : source.slice(open + 1, close);
}

/** All numeric px values of a shorthand or longhand padding/margin. */
function pxValues(body, prop) {
  if (!body) return [];
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`).exec(body);
  if (!m) return [];
  return [...m[1].matchAll(/(-?[\d.]+)px/g)].map((x) => Number(x[1]));
}

/** All `calc(var(--u) * N)` multipliers of a shorthand or longhand. */
function uValues(body, prop) {
  if (!body) return [];
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`).exec(body);
  if (!m) return [];
  return [...m[1].matchAll(/var\(--u\)\s*\*\s*(-?[\d.]+)/g)].map((x) => Number(x[1]));
}

// ════════════════════════════════════════════════════════════════
// Suites
//
// Each returns an array of failure strings. Empty means the suite passed.
// Every suite takes its sources as an argument so the self-test can feed it
// deliberately broken copies.
// ════════════════════════════════════════════════════════════════
const SUITES = {
  /* The desktop shelf must reserve room on the cross axis for the hover lift
     (4px) and the shadow it casts (0 16px 38px → 54px below the box). */
  'desktop-clip'(src) {
    const fail = [];
    const body = ruleBody(src.storeCss, '.sf-rail-scroll');
    if (!body) return ['.sf-rail-scroll rule not found'];

    const pad = pxValues(body, 'padding');
    const margin = pxValues(body, 'margin');
    if (pad.length < 2) fail.push('.sf-rail-scroll declares no vertical padding shorthand');
    const [padTop = 0, , padBottom = padTop] = pad.length === 3 ? [pad[0], pad[1], pad[2]] : [pad[0], pad[1], pad[0]];
    if (padTop < 20) fail.push(`.sf-rail-scroll padding-top ${padTop}px is under the 20px a hovered card needs`);
    if (padBottom < 24) fail.push(`.sf-rail-scroll padding-bottom ${padBottom}px is under the 24px its shadow needs`);
    if (!margin.some((v) => v < 0)) fail.push('.sf-rail-scroll does not hand the reserved space back as negative margin');

    // The grid the search results land in is the same kind of scroller.
    const grid = ruleBody(src.storeCss, '#search-results[data-view="store"]');
    if (!grid) fail.push('#search-results[data-view="store"] rule not found');
    else if ((pxValues(grid, 'padding')[0] ?? 0) < 20) {
      fail.push('the search results grid reserves no room for a hovered card');
    }
    return fail;
  },

  /* Big Picture: the selected cover scales to 1.075 on a card 0.92 of the
     shelf height, so it grows past each edge by roughly 0.8u, and then adds
     an outline and a 2.4u bloom. */
  'bp-clip'(src) {
    const fail = [];
    const body = ruleBody(src.storeCss, '#bp-root .bp-sf-strip');
    if (!body) return ['#bp-root .bp-sf-strip rule not found'];

    const pad = uValues(body, 'padding');
    if (pad.length < 2) fail.push('.bp-sf-strip declares no --u padding');
    const padTop = pad[0] ?? 0;
    const padBottom = pad.length >= 3 ? pad[2] : padTop;
    if (padTop < 2) fail.push(`.bp-sf-strip padding-top ${padTop}u is under the 2u the scale and bloom need`);
    if (padBottom < 2) fail.push(`.bp-sf-strip padding-bottom ${padBottom}u is under 2u`);
    // This suite used to require a negative margin here, on the reasoning that
    // the reserved room should be handed back to the layout. bp-scroll-clip
    // then showed that the margin dragged that same room out of the parent
    // scroller, which clipped it — so the assertion had encoded the defect as
    // a requirement. The clipping outcome this suite exists to measure is
    // carried by the padding and the stated overflow; the margin is now
    // forbidden by bp-scroll-clip rather than demanded here.
    // One `auto` axis makes the other `auto` as well, and that clips.
    if (!/overflow-y\s*:\s*hidden/.test(body)) {
      fail.push('.bp-sf-strip leaves overflow-y to default, which resolves to auto and clips');
    }
    // The results grid inside the search screen is a scroller too.
    if (!ruleBody(src.storeCss, '#bp-root #bp-results')) {
      fail.push('#bp-results reserves no vertical room for a scaled cover');
    }
    return fail;
  },

  /* The scroller that holds the shelves must keep a scrolled-to shelf away
     from its own clip edges, and the strips must not push the room they
     reserved back out of the scrollable area. */
  'bp-scroll-clip'(src) {
    const fail = [];
    const rails = ruleBody(src.storeCss, '#bp-root #bp-sf-rails');
    if (!rails) return ['#bp-root #bp-sf-rails rule not found'];

    const scrollPad = uValues(rails, 'scroll-padding-block');
    if (!scrollPad.length || scrollPad[0] < 2) {
      fail.push('#bp-sf-rails declares no scroll-padding-block, so a shelf brought into view parks flush against the clip edge');
    }
    const pad = uValues(rails, 'padding-block');
    if (!pad.length || Math.max(...pad) < 2) {
      fail.push('#bp-sf-rails reserves no padding for the first and last shelves');
    }

    const strip = ruleBody(src.storeCss, '#bp-root .bp-sf-strip');
    if (!strip) fail.push('#bp-root .bp-sf-strip rule not found');
    else if (uValues(strip, 'margin').some((v) => v < 0)) {
      fail.push('.bp-sf-strip still pulls its reserved room outside the scrollable area with a negative margin');
    }
    return fail;
  },

  /* Desktop search results are built from the store card component. */
  'desktop-search-cards'(src) {
    const fail = [];
    if (!/cardHtml,/.test(src.storeJs)) fail.push('store.js does not publish cardHtml');
    if (!/wireCards,/.test(src.storeJs)) fail.push('store.js does not publish wireCards');
    if (!/store\.cardHtml\(/.test(src.appJs)) fail.push('app.js does not build results from store.cardHtml');
    if (!/store\.wireCards\(results\)/.test(src.appJs)) fail.push('app.js does not wire the store cards it built');
    if (!/results\.dataset\.view = 'store'/.test(src.appJs)) {
      fail.push('app.js does not mark the results grid as the store view');
    }
    // The old component has to remain reachable as the fallback, or a failure
    // to load store.js would leave the Store page with no results at all.
    if (!/games\.forEach\(\(g, i\) => results\.appendChild\(resultCard\(g, i, query\)\)\)/.test(src.appJs)) {
      fail.push('app.js dropped the resultCard fallback for when store.js is absent');
    }
    return fail;
  },

  /* Big Picture store results are built from the store cover component. */
  'bp-search-cards'(src) {
    const fail = [];
    const fn = /function storeCardHtml\(entry, i\) \{[\s\S]*?\n  \}/.exec(src.bpJs);
    if (!fn) return ['storeCardHtml not found in bigpicture.js'];
    if (!/bp-sf-card/.test(fn[0])) fail.push('storeCardHtml does not build a store cover');
    if (/bp-card is-store/.test(fn[0])) fail.push('storeCardHtml still builds the library card');
    if (!/bp-sf-plate/.test(fn[0])) fail.push('storeCardHtml does not carry the store name plate');
    if (!/\.bp-sf-card\.is-sel/.test(src.storeCss)) {
      fail.push('the store cover has no selected treatment for the results grid');
    }
    return fail;
  },

  /* Every store-side search entry point goes through one door. */
  'search-routing'(src) {
    const fail = [];
    if (!/function openStoreSearch\(\)/.test(src.bpJs)) fail.push('openStoreSearch is not defined');
    const calls = (src.bpJs.match(/openStoreSearch\(\)/g) || []).length;
    // definition + keyboard + gamepad + the on-screen row
    if (calls < 4) fail.push(`openStoreSearch is reached from only ${calls - 1} places, expected at least 3`);
    if (!/S\.view === 'storefront' \|\| S\.view === 'store'/.test(src.bpJs)) {
      fail.push('the search button does not distinguish the store views');
    }
    if (!/'Search the store'/.test(src.bpJs)) fail.push('the hint bar does not name the store search');
    return fail;
  },

  /* The store front improvements, each present in the shipped source. */
  'bp-front-improvements'(src) {
    const fail = [];
    if (!/SKELETON_RAILS/.test(src.bpJs)) fail.push('no placeholder shelves while the charts load');
    if (!/is-skeleton/.test(src.storeCss)) fail.push('placeholder shelves have no styling');
    if (!/S\.view === 'storefront'/.test(/function cycleSection[\s\S]*?\n  \}/.exec(src.bpJs)?.[0] || '')) {
      fail.push('the shoulder buttons do not jump between shelves');
    }
    if (!/Press A to try again/.test(src.bpJs)) fail.push('a failed load offers no way to retry');
    if (!/if \(!S\.sfRails\.length\) \{ S\.sfRails = \[\]; openStoreFront\(\); return; \}/.test(src.bpJs)) {
      fail.push('the retry the status line promises is not wired to A');
    }
    if (!/id="bp-sf-search"/.test(src.bpJs)) fail.push('the store front has no search row');
    return fail;
  },

  /* The store page improvements. */
  'bp-page-improvements'(src) {
    const fail = [];
    if (!/id="bp-store-inner"/.test(src.bpJs)) fail.push('the store page is not the two-column full screen');
    for (const part of ['bp-store-about', 'bp-store-shots', 'bp-store-tags', 'bp-store-facts']) {
      if (!new RegExp(`id="${part}"`).test(src.bpJs)) fail.push(`the store page is missing ${part}`);
    }
    if (!/function runStoreInstall\(\)/.test(src.bpJs)) fail.push('no direct install shortcut on the store page');
    if (!/else if \(S\.view === 'store'\) \{ flashHint\('details'\); runStoreInstall\(\); \}/.test(src.bpJs)) {
      fail.push('the install shortcut is not bound to a button');
    }
    if (!/stopStoreMedia\(\);/.test(src.bpJs)) fail.push('the store page video is never stopped');
    return fail;
  },

  /* Nothing parses badly, nothing addresses markup that does not exist. */
  integrity(src) {
    const fail = [];
    for (const file of ['main.js', 'preload.js', 'src/core/storeFront.js', 'src/js/store.js',
      'src/js/app.js', 'src/js/bigpicture.js', 'src/js/enhance.js', 'src/js/kinetic.js']) {
      try {
        execFileSync(process.execPath, ['--check', join(ROOT, file)], { stdio: 'pipe' });
      } catch (e) {
        fail.push(`${file} does not parse: ${String(e.stderr || e).split('\n')[0]}`);
      }
    }

    for (const [name, css] of Object.entries(src.allCss)) {
      const body = stripComments(css);
      const open = (body.match(/\{/g) || []).length;
      const close = (body.match(/\}/g) || []).length;
      if (open !== close) fail.push(`${name} has ${open} { against ${close} }`);
      if ((body.match(/\(/g) || []).length !== (body.match(/\)/g) || []).length) {
        fail.push(`${name} has unbalanced parentheses`);
      }
    }

    // Every store selector must address markup that some source emits.
    const markup = src.html + src.storeJs + src.bpJs + src.appJs;
    const scoped = stripComments(src.storeCss);
    const tokens = new Set([...scoped.matchAll(/[#.]((?:sf|sd|bp-sf|bp-store)[a-z0-9-]*)/g)].map((m) => m[1]));
    for (const token of tokens) {
      if (!markup.includes(token)) fail.push(`store.css addresses ${token}, which no source emits`);
    }
    return fail;
  },

  /* The negative control the discipline requires: break each thing on
     purpose and require the suite that guards it to notice. Without this an
     assertion that can never fail would certify itself. */
  'self-test'(src) {
    const fail = [];
    const cases = [
      ['desktop-clip', { storeCss: src.storeCss.replace('padding: 26px 0 30px;', 'padding-bottom: 4px;') }],
      ['bp-clip', { storeCss: src.storeCss.replace(/padding: calc\(var\(--u\) \* 2\.6\)[^;]+;/, 'padding: calc(var(--u) * 0.9) var(--bp-gutter);') }],
      ['desktop-search-cards', { appJs: src.appJs.replace('store.cardHtml(', 'legacyCard(') }],
      ['bp-search-cards', { bpJs: src.bpJs.replace('bp-sf-card${owned', 'bp-card is-store${owned') }],
      ['search-routing', { bpJs: src.bpJs.replaceAll('openStoreSearch()', 'openSearch()') }],
      // replaceAll, not replace: a token that appears twice survives a
      // single substitution, the suite still finds the survivor, and the
      // control reports the suite as unable to fail when the fault was the
      // break. That happened on the first run of this file.
      ['bp-front-improvements', { bpJs: src.bpJs.replaceAll('SKELETON_RAILS', 'NOTHING_AT_ALL') }],
      ['bp-page-improvements', { bpJs: src.bpJs.replaceAll('runStoreInstall', 'unusedHelper') }],
      ['integrity', { storeCss: src.storeCss + '\n.broken { color: red;\n' }],
      // Two controls: one removes the scroll-padding, the other puts the
      // negative margin back. Each must make the suite fail on its own.
      ['bp-scroll-clip', { storeCss: src.storeCss.replace(/scroll-padding-block:[^;]+;/, '') }],
      ['bp-scroll-clip', { storeCss: src.storeCss.replace('.bp-sf-strip {', '.bp-sf-strip { margin: calc(var(--u) * -2.2) 0;') }],
    ];
    for (const [suite, patch] of cases) {
      const broken = { ...src, ...patch };
      if (patch.storeCss) broken.allCss = { ...src.allCss, 'src/styles/store.css': patch.storeCss };
      const failures = SUITES[suite](broken);
      if (!failures.length) fail.push(`${suite} passed against a deliberately broken source: it cannot fail`);
    }
    return fail;
  },

  /* The executable exists and is newer than every source it was built from. */
  packaged() {
    const fail = [];
    const version = JSON.parse(read('package.json')).version;
    const exe = join(ROOT, 'dist', `Librarian ${version}.exe`);
    let built;
    try { built = statSync(exe).mtimeMs; } catch { return [`dist/Librarian ${version}.exe has not been built`]; }

    let newest = 0;
    let newestFile = '';
    const walk = (dir) => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else {
          const t = statSync(join(ROOT, rel)).mtimeMs;
          if (t > newest) { newest = t; newestFile = rel; }
        }
      }
    };
    walk('src');
    for (const f of ['main.js', 'preload.js']) {
      const t = statSync(join(ROOT, f)).mtimeMs;
      if (t > newest) { newest = t; newestFile = f; }
    }
    if (newest > built) fail.push(`${newestFile} changed after the last build; the executable is stale`);

    const asar = join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');
    let blob;
    try { blob = readFileSync(asar, 'latin1'); } catch { return [...fail, 'app.asar not found'] }
    for (const marker of ['bp-sf-card', 'openStoreSearch', 'SKELETON_RAILS', 'data-view', 'runStoreInstall']) {
      if (!blob.includes(marker)) fail.push(`${marker} is not in the packaged asar`);
    }
    return fail;
  },
};

// ════════════════════════════════════════════════════════════════
const suite = process.argv[2];
if (!suite || !SUITES[suite]) {
  console.error(`usage: node dev/verify-store.mjs <${Object.keys(SUITES).join('|')}>`);
  process.exit(2);
}

const src = {
  storeCss: read('src/styles/store.css'),
  storeJs: read('src/js/store.js'),
  appJs: read('src/js/app.js'),
  bpJs: read('src/js/bigpicture.js'),
  html: read('src/index.html'),
  allCss: Object.fromEntries(['main', 'enhance', 'library', 'store', 'bigpicture', 'kinetic']
    .map((n) => [`src/styles/${n}.css`, read(`src/styles/${n}.css`)])),
};

const failures = SUITES[suite](src);
for (const f of failures) console.error(`FAIL ${suite}: ${f}`);
if (failures.length) process.exit(1);
console.log(`OK ${suite}`);
