#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Verifier for "What's new" (src/core/newsFeed.js and its wiring).
//
//   node dev/verify-news.mjs <parse|wiring|live|all>
//
//   parse   the forum's search-by-author page is read into items the
//           dialog can show (fixture below is a real block, sid removed)
//   wiring  preload, main, settings, markup and renderer agree
//   live    both feeds against the network (not part of `all`)
// ═══════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const require = createRequire(import.meta.url);
const news = require(join(ROOT, 'src', 'core', 'newsFeed.js'));

const FIXTURE = `<table class="tablebg" width="100%" cellspacing="1"> <tr> <th width="150" nowrap="nowrap">Author</th> <th width="100%" nowrap="nowrap">Message</th> </tr>
<tr class="row2"> <td colspan="2" height="25"><p class="topictitle"><a name="p3582002" id="p3582002"></a>&nbsp;Forum: <a href="./viewforum.php?f=41&amp;sid=abc">Temporarily Restricted Topics</a> &nbsp; Topic: <a href="./viewtopic.php?f=41&amp;t=157669&amp;sid=abc"><span style="color:#258CBC;">[</span><span style="color:#258CBC;font-size: 0.9em;">Info</span><span style="color:#258CBC;">]</span> Assassin's Creed Black Flag Resynced [CRACKED]</a> </p></td> </tr>
<tr class="row1"> <td width="150" align="center" valign="middle"><b class="postauthor"><a href="./memberlist.php?mode=viewprofile&amp;u=3625690&amp;sid=abc">DenuvOwO</a></b></td> <td height="25"> <table width="100%" cellspacing="0" cellpadding="0" border="0"> <tr> <td class="gensmall"> <div style="float: left;"> &nbsp;<b>Post subject:</b> <a href="./viewtopic.php?f=41&amp;t=157669&amp;p=3582002&amp;sid=abc#p3582002">Re: Assassin's Creed Black Flag Resynced [CRACKED]</a> </div> <div style="float: right;"><b>Posted:</b> Today, 01:20&nbsp;</div> </td> </tr> </table> </td> </tr>
<tr class="row1"> <td width="150" align="center" valign="top"><br /><span class="postdetails">Replies: <b>481</b><br />Views: <b>241376</b></span><br /><br /></td> <td valign="top"> <table width="100%" cellspacing="5"> <tr> <td class="postbody"> Assassin's Creed Black Flag Resynced HYPERVISOR - DenuvOwO Crack&#58; https&#58;//bzzhr&#46;to/fs23scpibms3 Ubisoft exe&#58; https&#58;//bzzhr&#46;to/xugsvg20ttg0 Game version is Title Update 1&#46;0&#46;7 SHA-256&#58; 85a38159f47f895619db026c0c98dd7c943c0c4c7ca2e097dcec8f4cec13496f Learn more here on HV releases&#58; Hypervisor cracks -&#46;&#46;&#46;</td> </tr> </table> </td> </tr>
<tr class="row2"> <td colspan="2" height="25"><p class="topictitle"><a name="p3580530" id="p3580530"></a>&nbsp;Forum: <a href="./viewforum.php?f=41&amp;sid=abc">Temporarily Restricted Topics</a> &nbsp; Topic: <a href="./viewtopic.php?f=41&amp;t=145140&amp;sid=abc"><span style="color:#258CBC;">[</span><span style="color:#258CBC;font-size: 0.9em;">Info</span><span style="color:#258CBC;">]</span> CRIMSON DESERT [CRACKED]</a> </p></td> </tr>
<tr class="row1"> <td width="150" align="center" valign="middle"><b class="postauthor"><a href="./memberlist.php?mode=viewprofile&amp;u=3625690&amp;sid=abc">DenuvOwO</a></b></td> <td height="25"> <table><tr><td class="gensmall"> <div style="float: left;"> &nbsp;<b>Post subject:</b> <a href="./viewtopic.php?f=41&amp;t=145140&amp;p=3580530&amp;sid=abc#p3580530">Re: CRIMSON DESERT [CRACKED]</a> </div> <div style="float: right;"><b>Posted:</b> Yesterday, 20:00&nbsp;</div> </td></tr></table> </td> </tr>
<tr class="row1"> <td></td> <td valign="top"> <table><tr> <td class="postbody"> Crimson Desert Enhanced HYPERVISOR - DenuvOwO Link&#58; https&#58;//bzzhr&#46;to/ue1okjy7cfwc Game version is 2&#46;00&#46;02 (BuildID 25050808) SHA-256&#58; c2a3983bca9fa00622fae7cde09ff2eb1e8099f1c9d4672be70893901de8815f</td> </tr></table> </td> </tr>
</table>`;

function parse() {
  const fails = [];
  const items = news.parseAuthorSearch(FIXTURE);
  if (items.length !== 2) return [`parsed ${items.length} items, expected 2`];
  const [ac, cd] = items;
  if (ac.id !== 'csrin:p3582002' || ac.postId !== 'p3582002') fails.push(`first id ${ac.id}`);
  if (ac.game !== "Assassin's Creed Black Flag Resynced") fails.push(`first game "${ac.game}"`);
  if (ac.flags.join(',') !== 'Info,CRACKED') fails.push(`first flags ${ac.flags}`);
  if (ac.author !== 'DenuvOwO') fails.push(`author "${ac.author}"`);
  if (ac.date !== 'Today, 01:20') fails.push(`date "${ac.date}"`);
  if (ac.topicUrl !== 'https://cs.rin.ru/forum/viewtopic.php?f=41&t=157669') fails.push(`topic url ${ac.topicUrl}`);
  if (ac.postUrl !== 'https://cs.rin.ru/forum/viewtopic.php?f=41&t=157669&p=3582002#p3582002') fails.push(`post url ${ac.postUrl}`);
  if (ac.topicId !== '157669') fails.push(`topic id ${ac.topicId}`);
  if (ac.version !== '1.0.7') fails.push(`first version "${ac.version}" (Title Update 1.0.7)`);
  if (ac.build !== '') fails.push(`first build "${ac.build}" was invented`);
  if (!/Crack: https:\/\/bzzhr\.to\/fs23scpibms3/.test(ac.snippet)) fails.push(`entities not decoded in "${ac.snippet.slice(0, 80)}"`);
  if (ac.sha256 !== '85a38159f47f895619db026c0c98dd7c943c0c4c7ca2e097dcec8f4cec13496f') fails.push(`first sha ${ac.sha256}`);
  if (cd.game !== 'CRIMSON DESERT' || cd.build !== '25050808' || cd.version !== '2.00.02') fails.push(`second item ${JSON.stringify({ game: cd.game, build: cd.build, version: cd.version })}`);
  if (cd.date !== 'Yesterday, 20:00') fails.push(`second date "${cd.date}"`);

  const t = news.cleanTopicTitle('<span>[</span><span>Info</span><span>]</span> Mortal Shell II [CRACKED] [Denuvo]');
  if (t.game !== 'Mortal Shell II' || t.flags.length !== 3) fails.push(`cleanTopicTitle ${JSON.stringify(t)}`);
  if (news.decodeEntities('a&#58;b&amp;c&#46;d') !== 'a:b&c.d') fails.push('decodeEntities');
  if (news.forumUrl('./viewtopic.php?f=1&amp;t=2&amp;sid=zzz#p3') !== 'https://cs.rin.ru/forum/viewtopic.php?f=1&t=2#p3') fails.push(`forumUrl ${news.forumUrl('./viewtopic.php?f=1&amp;t=2&amp;sid=zzz#p3')}`);
  return fails;
}

function wiring() {
  const fails = [];
  const main = read('main.js');
  const preload = read('preload.js');
  const settings = read('src/core/settingsStore.js');
  const html = read('src/index.html');
  const app = read('src/js/app.js');
  if (!/ipcMain\.handle\('news:fetch'/.test(main)) fails.push('main has no news:fetch handler');
  if (!/settings\.get\('csrin_author'\)/.test(main.slice(main.indexOf("ipcMain.handle('news:fetch'")))) fails.push('the feed does not follow the configured member');
  if (!/'news:fetch'/.test(preload)) fails.push('preload does not expose fetchNews');
  for (const key of ['news_enabled', 'news_seen', 'news_checked_at']) {
    if (!new RegExp(`^\\s*${key}:`, 'm').test(settings)) fails.push(`settingsStore DEFAULTS lacks ${key}`);
  }
  if (!/key === 'news_seen'/.test(settings)) fails.push('news_seen is not bounded');
  for (const id of ['store-news-btn', 'store-news-count', 'chk-news']) {
    if (!html.includes(`id="${id}"`)) fails.push(`index.html lacks #${id}`);
  }
  if (!/\['news', setupNews\]/.test(app)) fails.push('setupNews is not an init step');
  if (!/state\.settings\.news_enabled !== false && !modalUp && !state\.isProcessing/.test(app)) fails.push('the dialog does not respect the setting, an open modal, or a running download');
  if (!/api\.setSetting\('news_seen'/.test(app)) fails.push('closing the dialog does not remember what was seen');
  if (!(/api\.setSetting\('news_enabled'/.test(app)
    || (/values\.news_enabled = \$\('#chk-news'\)\.checked/.test(app) && /api\.setSettings\(values\)/.test(app)))) fails.push('the setting is never saved');
  if (!/openCsrinPicker\(game\.appid, game\.game_name, \{ game \}\)/.test(app.slice(app.indexOf('function openNewsModal')))) fails.push('a forum post cannot be opened on the installed game');
  return fails;
}

async function live() {
  const fails = [];
  const t0 = Date.now();
  const res = await news.getNews({ author: 'DenuvOwO' });
  console.log(`  csrin: ok=${res.csrin.ok} items=${res.csrin.items.length} ${res.csrin.error || ''}`);
  console.log(`  denuvo: ok=${res.denuvo.ok} items=${res.denuvo.items.length} ${res.denuvo.error || ''}`);
  console.log(`  took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const it of res.csrin.items.slice(0, 4)) console.log('  ·', JSON.stringify({ game: it.game, build: it.build, version: it.version, date: it.date }));
  for (const it of res.denuvo.items.slice(0, 6)) console.log('  ·', JSON.stringify({ name: it.name, date: it.date, price: it.price, drm: it.drm.slice(0, 40) }));
  if (!res.csrin.ok) fails.push(`forum feed failed: ${res.csrin.error}`);
  if (res.csrin.ok && !res.csrin.items.length) fails.push('forum feed returned no posts');
  if (!res.denuvo.ok) fails.push(`steam feed failed: ${res.denuvo.error}`);
  return fails;
}

const SUITES = { parse, wiring, live };
const name = process.argv[2] || 'all';
const run = name === 'all' ? ['parse', 'wiring'] : [name];
let failed = false;
for (const suite of run) {
  if (!SUITES[suite]) { console.error(`unknown suite: ${suite}`); process.exit(2); }
  const fails = await SUITES[suite]();
  for (const f of fails) console.error(`FAIL ${suite}: ${f}`);
  if (fails.length) failed = true;
  else console.log(`OK ${suite}`);
}
process.exit(failed ? 1 : 0);
