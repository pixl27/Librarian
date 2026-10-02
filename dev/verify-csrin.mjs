#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Verifier for the CS.RIN.RU source.
//
//   node dev/verify-csrin.mjs <suite>
//
// Suites:
//   deps      the two binaries are present and match deps/csrin/VERSION.txt
//   wiring    preload, main, settings, markup and renderer agree on the names,
//             and the build gate and extraction are on the path
//   parse     the core module shapes a CLI report the way the renderer
//             expects: build, version, labelled links (pure, no network)
//   extract   a generated multi-folder archive: only the game's folder is
//             placed over a fake install, originals kept as .csrin.bak,
//             an ambiguous archive is refused (uses Windows' bsdtar)
//   all
//
// Prints `OK <suite>` and exits 0 only after every assertion passed.
// ═══════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const require = createRequire(import.meta.url);

function deps() {
  const fails = [];
  const dir = join(ROOT, 'deps', 'csrin');
  const versionPath = join(dir, 'VERSION.txt');
  if (!existsSync(versionPath)) return [`missing ${versionPath}`];
  const version = readFileSync(versionPath, 'utf8');
  for (const exe of ['csrin-cli.exe', 'csrin-dl.exe']) {
    const p = join(dir, exe);
    if (!existsSync(p)) { fails.push(`missing ${p}`); continue; }
    const line = new RegExp(`^${exe} sha256 ([0-9a-f]{64}) octets (\\d+)$`, 'm').exec(version);
    if (!line) { fails.push(`VERSION.txt has no line for ${exe}`); continue; }
    const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
    if (sha !== line[1]) fails.push(`${exe}: sha256 ${sha} != ${line[1]} in VERSION.txt`);
    if (statSync(p).size !== Number(line[2])) fails.push(`${exe}: size ${statSync(p).size} != ${line[2]}`);
  }
  if (!/^commit [0-9a-f]{40}$/m.test(version)) fails.push('VERSION.txt records no source commit');
  return fails;
}

function wiring() {
  const fails = [];
  const main = read('main.js');
  const preload = read('preload.js');
  const settings = read('src/core/settingsStore.js');
  const html = read('src/index.html');
  const app = read('src/js/app.js');
  const store = read('src/js/store.js');
  const enhance = read('src/js/enhance.js');
  const storeCss = read('src/styles/store.css');

  // An ambiguous archive is put to the person, and the job waits on it.
  if (!/session\.send\('csrin:event', \{ event: 'choose_folder'/.test(main)) fails.push('main never asks which folder is the game');
  if (!/pendingCsrinFolderChoice = \{ resolve \}/.test(main)) fails.push('main does not wait on the folder choice');
  if (!/async function stopCurrentDownload\(\) \{[\s\S]{0,200}resolvePendingCsrinFolderChoice\(\{ cancelled: true \}\)/.test(main)) fails.push('cancelling the job leaves the folder choice pending');
  if (!/ev\.event === 'choose_folder'\) \{\s*showCsrinFolderChoice\(ev\)/.test(app)) fails.push('the renderer ignores choose_folder');
  if (!/state\.pendingConfirm = \(\) => answer\(''\)/.test(app)) fails.push('dismissing the folder dialog does not answer the main process');

  for (const ch of ['csrin:status', 'csrin:search', 'csrin:cancelSearch', 'csrin:download', 'csrin:chooseFolder']) {
    if (!preload.includes(`'${ch}'`)) fails.push(`preload does not invoke ${ch}`);
    if (!main.includes(`ipcMain.handle('${ch}'`)) fails.push(`main has no handler for ${ch}`);
  }
  for (const ch of ['csrin:log', 'csrin:event']) {
    if (!preload.includes(`'${ch}'`)) fails.push(`preload does not listen on ${ch}`);
    if (!main.includes(`'${ch}'`)) fails.push(`main never sends ${ch}`);
  }

  // One queue: the second source fills the same slot and completes through
  // the same session as SteamPipe.
  if (!/createDownloadSession\(opts\.jobId, \{ destPath: outputDir, extractTo, name: gameName \}\)/.test(main)) fails.push('main has no shared download session');
  const handler = main.slice(main.indexOf("ipcMain.handle('csrin:download'"));
  if (!/currentDownload = csrin\.download\(/.test(handler)) fails.push('csrin:download does not fill currentDownload');
  if (!/session\.callbacks\.onComplete\(\)/.test(handler)) fails.push('csrin:download does not complete through the shared session');
  if (!/currentDownload\.markPaused\(\) !== false/.test(main)) fails.push('depot:pause ignores an engine that cannot pause');

  // The build gate and the extraction, in the main process where the files are.
  if (!/expectedBuild && postBuild && expectedBuild !== postBuild/.test(handler)) fails.push('csrin:download does not refuse a build mismatch');
  if (!/csrin\.extractInto\(r\.filepath, extractTo/.test(handler)) fails.push('csrin:download does not extract into the game');
  // The release is built on the game's own Steam library: the emulator the
  // auto-crack left in its place is put aside first, and never applied at
  // all to a Denuvo title.
  if (!/csrin\.restoreEmulatorBackups\(extractTo/.test(handler) || handler.indexOf('csrin.restoreEmulatorBackups(extractTo') > handler.indexOf('csrin.extractInto(r.filepath')) fails.push('the emulator DLL is not put aside before the release goes on');
  if (!/gd\.skip_auto_crack = true;\s*\n\s*log\(`🛡/.test(app)) fails.push('a Denuvo download still runs the emulator step');
  if (!/if \(denuvoTitle\) \{[\s\S]*?await crackPageCsrinStep\(/.test(app)) fails.push('the Crack page still runs SteamAutoCrack on a Denuvo title');
  // Nothing of ours is injected into a hypervisor release's process, and a
  // SteamPath borrowed by its client loader is neither trusted nor left.
  const launcher = read('src/core/launcher.js');
  const helpers = read('src/core/steamHelpers.js');
  if (!/const guarded = isGuardedRelease\(game\.install_path\);[\s\S]{0,80}if \(!guarded\) \{[\s\S]{0,300}injectAchievementOverlay\(child\.pid/.test(launcher)) fails.push('the overlay is still injected into a hypervisor release');
  if (!/if \(looksLikeSteam\(found\)\) \{/.test(helpers)) fails.push('a registry SteamPath is trusted without a steamapps folder');
  if (!/function repairSteamRegistry\(\)/.test(helpers) || !/repairSteamRegistry\(\)/.test(main.slice(main.indexOf("ipcMain.handle('game:scan'")))) fails.push('a borrowed SteamPath is not put back before a scan');
  // The release's DLC list is its own; the panel neither reads nor writes it.
  const dlc = read('src/core/dlcUnlocker.js');
  if (!/if \(managedByRelease\(gamePath\)\) return \{ ready: false, managed: 'release'/.test(dlc)) fails.push('the DLC panel does not step back on a hypervisor release');
  if (!/function apply\(gamePath[^)]*\) \{\s*\n\s*if \(managedByRelease\(gamePath\)\) return \{ success: false/.test(dlc)) fails.push('the DLC panel can still write into a hypervisor release');
  if (!/Extraction failed/.test(handler)) fails.push('an extraction error does not fail the job');

  for (const key of ['csrin_username', 'csrin_password', 'csrin_author', 'csrin_download_dir']) {
    if (!new RegExp(`^\\s*${key}:`, 'm').test(settings)) fails.push(`settingsStore DEFAULTS lacks ${key}`);
    if (!app.includes(`'${key}'`) && !app.includes(`.${key}`)) fails.push(`app.js never touches ${key}`);
  }
  if (!/key === 'csrin_author'/.test(settings)) fails.push('csrin_author is not coerced');
  if (!/settings\.get\('csrin_password'\)/.test(main)) fails.push('main does not read the password itself');
  if (/csrin_password/.test(preload)) fails.push('the password crosses the preload boundary');

  for (const id of ['sd-csrin', 'inp-csrin-username', 'inp-csrin-password', 'inp-csrin-author', 'btn-csrin-browse', 'btn-csrin-dir-reset', 'csrin-dir-label', 'csrin-tools-line']) {
    if (!html.includes(`id="${id}"`)) fails.push(`index.html lacks #${id}`);
  }
  if (!/data-sec="CS\.RIN\.RU"/.test(html)) fails.push('settings has no CS.RIN.RU section (the nav is built from data-sec)');
  if (!/html:not\(\[data-csrin="on"\]\) #sd-csrin/.test(storeCss)) fails.push('store button is not gated on html[data-csrin]');
  if (!/dataset\.csrin = state\.csrin\.available \? 'on' : 'off'/.test(app)) fails.push('app.js does not stamp html[data-csrin]');

  // Two doors: the store page (save only) and the library flyout (into the game).
  if (!/b\.csrinSearch\(D\.appid, D\.name\)/.test(store)) fails.push('store.js does not open the picker through the bridge');
  if (!/csrinSearch: openCsrinPicker/.test(app)) fails.push('window.Librarian does not expose csrinSearch');
  if (!/act\('flyout-csrin-btn', ACT_ICONS\.globe, 'CS\.RIN\.RU'\)/.test(app)) fails.push('library flyout has no CS.RIN.RU action');
  if (!/openCsrinPicker\(game\.appid, game\.game_name, \{ game \}\)/.test(app)) fails.push('flyout action does not hand the game to the picker');

  // The renderer gates on the build before queuing, and carries it to main.
  if (!/function csrinPatchMatch\(post, game, patch\)/.test(app)) fails.push('no patch comparison in the renderer');
  if (!/match\.state === 'mismatch'\) \{ toast\(/.test(app)) fails.push('a mismatched build can be queued from the picker');
  if (!/expectedBuild: game\?\.buildid \|\| ''/.test(app)) fails.push('the job does not carry the installed build');
  if (!/extractTo: game\?\.install_path \|\| ''/.test(app)) fails.push('the job does not carry the install folder');
  if (!/postBuild: job\.csrin\.postBuild \|\| ''/.test(app)) fails.push('csrinDownload is not told the post build');

  // Denuvo only, and part of auto-crack.
  const steamApi = read('src/core/steamApi.js');
  if (!/result\.denuvo = \/denuvo\/i\.test\(result\.drm_notice\)/.test(steamApi)) fails.push('getGameMedia does not report Denuvo from the DRM notice');
  if (!/async function ensureDenuvoInfo\(game\)/.test(app)) fails.push('no Denuvo lookup in the renderer');
  if (!/state\.denuvo\[safeAppId\(game\.appid\)\] === true\s*\n?\s*\? act\('flyout-csrin-btn'/.test(app)) fails.push('flyout action is not gated on Denuvo');
  if (!/csrinBtn\.classList\.toggle\('hidden', !meta\.denuvo\)/.test(store)) fails.push('store button is not gated on Denuvo');
  if (!/if \(!\(await ensureDenuvoInfo\(game\)\)\) continue;/.test(app)) fails.push('the after-download step does not skip non-Denuvo games');
  if (!/!state\.settings\.auto_crack\) return;/.test(app)) fails.push('the after-download step does not follow auto_crack');
  if (!/!active\.skipAutoCrack && state\.settings\.auto_crack\) \{/.test(app)) fails.push('a finished job is remembered for the release regardless of auto-crack');
  if (/csrin_auto_apply/.test(app) || /csrin_auto_apply/.test(settings) || /chk-csrin-auto/.test(html)) fails.push('a second switch exists beside auto_crack');
  if (!/const gate = linkedCustom \? \{ ok: true \} : await csrinReleaseGate\(game, info\.remoteBuildId, \{ silent, verb: 'update' \}\);/.test(app)) fails.push('queueGameUpdate does not check CS.RIN.RU for the target patch');
  if (!/if \(!gate\.ok\) return \{ queued: false, reason: 'csrin-no-release'/.test(app)) fails.push('a held update still queues');
  // A fresh download is checked too, with the manifest's build, before any depot is fetched.
  const job = app.slice(app.indexOf('async function processNextJob'), app.indexOf('const depots = gd.depots || {};'));
  if (!/csrinReleaseGate\(\{ appid: gd\.appid, game_name: gd\.game_name \|\| next\.name \}, gd\.buildid, \{ silent: false, verb: 'download' \}\)/.test(job)) fails.push('a download is not checked against CS.RIN.RU before it starts');
  if (!/next\.jobType !== 'update' && next\.jobType !== 'repair' && !next\.skipAutoCrack/.test(job)) fails.push('the download gate does not skip updates, repairs and opted-out jobs');
  // One crawl per game per session, shared by the page, the gate and the fetch.
  if (!/state\.csrinCache\.set\(key, \{ at: Date\.now\(\), res: out \}\)/.test(app)) fails.push('release info is not cached for the session');
  if (!/if \(!scanAll\) return csrinReleaseInfo\(game\.game_name\);/.test(app)) fails.push('the unattended fetch crawls again instead of reusing the gate\'s answer');
  if (!/paintCsrinLine\(meta\.name \|\| D\.name\)/.test(store)) fails.push('the store page does not say what the forum has');
  if (!/id="sd-csrin-line"/.test(html)) fails.push('index.html lacks #sd-csrin-line');
  if (!/await crackPageCsrinStep\(\{ appid: appId, game_name: gameName, install_path: currentFolder \}, crackLog\);/.test(app)) fails.push('the Crack page does not run the CS.RIN.RU step');
  if (!/const findMatch = \(res\) => csrinPostFor\(res\?\.posts, patch, build\);/.test(app)) fails.push('the unattended fetch does not match the installed patch');

  if (!/\['cs\.rin\.ru', setupCsrin\]/.test(app)) fails.push('setupCsrin is not an init step');
  if (!/if \(next\.jobType === 'csrin'\) \{ await processCsrinJob\(next\); return; \}/.test(app)) fails.push('processNextJob does not branch on csrin');
  if (!/activeJob\?\.jobType === 'csrin' \? 'none' : ''/.test(app)) fails.push('queue pause button is not hidden for csrin');
  if (!/pauseBtn\.classList\.toggle\('hidden', d\.jobType === 'csrin'\)/.test(enhance)) fails.push('focus view pause button is not hidden for csrin');
  if (!/'Placing into the game'/.test(enhance)) fails.push('focus view has no extraction verb');
  if (!/'Into the game at'/.test(enhance)) fails.push('focus view still says Installing to for a csrin job');
  return fails;
}

function parse() {
  const fails = [];
  const csrin = require(join(ROOT, 'src', 'core', 'csrin.js'));

  // A DenuvOwO post as the CLI reports it once logged in.
  const post = csrin.shapePost({
    post_id: 'p3577059', author: 'DenuvOwO', date: 'Thursday, 27 Aug 2026, 03:55', subject: 'No Subject',
    page: 32, offset: 465, url: 'https://cs.rin.ru/forum/viewtopic.php?f=41&t=145140#p3577059',
    extracted_link: 'https://bzzhr.to/clean', post_links: ['https://bzzhr.to/clean'],
    content: 'Crimson Desert Enhanced HYPERVISOR - DenuvOwO\r\n\r\nClean Steam files:  [link](https://bzzhr.to/clean)\r\nCrack:  [link](https://pixeldrain.com/u/crack)\r\n\r\nGame version is 2.00.02 (BuildID 25050808)\r\n\r\nMake sure to read the NFO\r\nTopic: [here](https://cs.rin.ru/forum/viewtopic.php?t=1)',
    topic_title: '[Info] CRIMSON DESERT [CRACKED]', topic_url: 'https://cs.rin.ru/forum/viewtopic.php?f=41&t=145140',
  }, 0);
  if (post.build !== '25050808') fails.push(`build parsed as "${post.build}"`);
  if (post.version !== '2.00.02') fails.push(`version parsed as "${post.version}"`);
  if (post.links.length !== 2) fails.push(`expected 2 external links, got ${post.links.length}: ${JSON.stringify(post.links)}`);
  if (post.links[0]?.label !== 'Clean Steam files') fails.push(`first label is "${post.links[0]?.label}"`);
  if (post.links[1]?.label !== 'Crack' || post.links[1]?.host !== 'pixeldrain.com') fails.push(`second link is ${JSON.stringify(post.links[1])}`);
  if (post.content.includes('\r')) fails.push('content keeps carriage returns');
  if (post.linksHidden) fails.push('linksHidden set although links exist');

  // A logged-in report as the forum really renders it: the hoster hint
  // before the anchor, the anchor text being the URL, and the stated hash.
  const real = csrin.shapePost({
    content: 'Crimson Desert Enhanced HYPERVISOR - DenuvOwO\n\nLink: bzzhr.to link[https://bzzhr.to/ue1okjy7cfwc](https://bzzhr.to/ue1okjy7cfwc) ⚠   Malicious ads\n\nGame version is 2.00.02 (BuildID 25050808)\n\nSHA-256: c2a3983bca9fa00622fae7cde09ff2eb1e8099f1c9d4672be70893901de8815f\n',
    extracted_link: 'https://bzzhr.to/ue1okjy7cfwc', post_links: ['https://bzzhr.to/ue1okjy7cfwc'],
  }, 2);
  if (real.links.length !== 1 || real.links[0].label !== 'Link') fails.push(`real post links: ${JSON.stringify(real.links)}`);
  if (real.sha256 !== 'c2a3983bca9fa00622fae7cde09ff2eb1e8099f1c9d4672be70893901de8815f') fails.push(`sha256 parsed as "${real.sha256}"`);
  if (real.build !== '25050808') fails.push(`real post build "${real.build}"`);
  if (post.sha256 !== '') fails.push('a hash was invented for a post without one');

  const artifact = csrin.shapePost({
    content: 'Crimson.Desert.Enhanced.Update.v2.03.02.Crack.Only-ARTIFACT\n\nAttachment:\n[Crimson.Desert.Enhanced.Update.v2.03.02.Crack.Only-ARTIFACT.7z](./download/file.php?id=194907) [14.71 MiB]',
    extracted_link: null, post_links: [],
    attachments: [{ url: 'https://cs.rin.ru/forum/download/file.php?id=194907', name: 'Crimson.Desert.Enhanced.Update.v2.03.02.Crack.Only-ARTIFACT.7z', size: '14.71 MiB' }],
  }, 3);
  if (artifact.version !== '2.03.02') fails.push(`ARTIFACT patch parsed as "${artifact.version}"`);
  if (artifact.build !== '') fails.push(`a build was invented for an ARTIFACT post: "${artifact.build}"`);
  if (artifact.links.length !== 1 || !artifact.links[0].attachment || artifact.links[0].url !== 'https://cs.rin.ru/forum/download/file.php?id=194907') fails.push(`ARTIFACT attachment not offered as a link: ${JSON.stringify(artifact.links)}`);
  if (!/crack/i.test(artifact.links[0]?.label || '')) fails.push('the attachment label lost the release name the unattended fetch looks for');
  if (artifact.links[0]?.size !== '14.71 MiB') fails.push('the attachment size is not carried');
  if (artifact.linksHidden) fails.push('a post with an attachment is flagged linksHidden');
  if (!csrin.isForumAttachment('https://cs.rin.ru/forum/download/file.php?id=194907')) fails.push('a forum attachment URL is not recognised');
  if (csrin.isForumAttachment('https://cs.rin.ru/forum/download/file.php?avatar=1_2.png')) fails.push('an avatar counted as an attachment');
  if (csrin.isForumAttachment('https://evil.example/forum/download/file.php?id=1')) fails.push('another host counted as a forum attachment');

  const hidden = csrin.shapePost({ content: 'Link:  [[Please login to see this link.]]\n\nGame version is 2.00.02 (BuildID 25050808)', post_links: [] }, 1);
  if (!hidden.linksHidden) fails.push('a guest-hidden post is not flagged linksHidden');
  if (hidden.build !== '25050808') fails.push('build not parsed from a guest-hidden post');

  const other = csrin.parseBuild('Update 1.3 · Build 12345678 · [link](https://gofile.io/d/x)');
  if (other.build !== '12345678') fails.push(`plain "Build N" parsed as "${other.build}"`);
  if (csrin.parseBuild('nothing here').build !== '') fails.push('a build was invented');

  if (csrin.isExternalLink('https://cs.rin.ru/forum/viewtopic.php?t=1')) fails.push('forum topic counted as external');
  if (!csrin.isExternalLink('https://gofile.io/d/abc')) fails.push('gofile not counted as external');
  if (csrin.isExternalLink('ftp://x')) fails.push('non-http counted as external');

  // Which folder of an archive is the game.
  const entries = ['Other Game/x.exe', 'Crimson Desert/read.nfo', 'Crimson Desert/bin/CrimsonDesert.exe', 'Crimson Desert/', 'Other Game/'];
  const exact = csrin.pickGameFolder(entries, { installPath: 'D:\\Games\\Crimson Desert', gameName: 'Crimson Desert' });
  if (exact.mode !== 'folder' || exact.folder !== 'Crimson Desert') fails.push(`exact pick: ${JSON.stringify(exact)}`);
  const partial = csrin.pickGameFolder(['Crimson Desert HYPERVISOR - DenuvOwO/a.exe', 'NFO/read.nfo'], { installPath: 'D:\\Games\\Crimson Desert', gameName: '' });
  if (partial.mode !== 'folder' || !/HYPERVISOR/.test(partial.folder)) fails.push(`partial pick: ${JSON.stringify(partial)}`);
  const only = csrin.pickGameFolder(['Release/a.exe', 'Release/b.dll'], { installPath: 'D:\\Games\\Crimson Desert', gameName: 'Crimson Desert' });
  if (only.mode !== 'folder' || only.folder !== 'Release') fails.push(`single-folder pick: ${JSON.stringify(only)}`);
  const root = csrin.pickGameFolder(['a.exe', 'b.dll'], { installPath: 'D:\\Games\\X', gameName: 'X' });
  if (root.mode !== 'root') fails.push(`root pick: ${JSON.stringify(root)}`);
  const amb = csrin.pickGameFolder(['Alpha/a.exe', 'Beta/b.exe'], { installPath: 'D:\\Games\\Gamma', gameName: 'Gamma' });
  if (amb.mode !== 'ambiguous' || amb.folders.length !== 2) fails.push(`ambiguous pick: ${JSON.stringify(amb)}`);
  const described = csrin.describeFolders(['Alpha/a.exe', 'Alpha/bin/x.dll', 'Alpha/bin/', 'Beta/b.exe', 'readme.txt'], amb.folders);
  const alpha = described.find((d) => d.folder === 'Alpha');
  if (described.length !== 2 || !alpha) fails.push(`describeFolders: ${JSON.stringify(described)}`);
  else if (alpha.files !== 2 || alpha.entries.join(',') !== 'bin/,a.exe') fails.push(`Alpha described as ${JSON.stringify(alpha)}`);

  const st = csrin.status();
  for (const k of ['cliExists', 'dlExists', 'tarExists', 'cliPath', 'dlPath', 'tarPath', 'downloadDir']) {
    if (!(k in st)) fails.push(`status() lacks ${k}`);
  }
  if (typeof csrin.cancelSearch !== 'function') fails.push('cancelSearch is not exported');
  if (csrin.cancelSearch() !== false) fails.push('cancelSearch with nothing running should report false');
  return fails;
}

async function extract() {
  const fails = [];
  const csrin = require(join(ROOT, 'src', 'core', 'csrin.js'));
  const st = csrin.status();
  if (!st.tarExists) return [`bsdtar not found at ${st.tarPath}`];

  const work = mkdtempSync(join(tmpdir(), 'librarian-csrin-verify-'));
  try {
    // The archive: two games' folders side by side, plus an NFO at the root.
    const src = join(work, 'src');
    for (const f of ['Other Game/x.exe', 'Crimson Desert/bin/CrimsonDesert.exe', 'Crimson Desert/read.nfo', 'Crimson Desert/steam_api64.dll']) {
      mkdirSync(dirname(join(src, f)), { recursive: true });
      writeFileSync(join(src, f), `new:${f}`);
    }
    const archive = join(work, 'release.7z');
    execFileSync(st.tarPath, ['-a', '-cf', archive, 'Other Game', 'Crimson Desert'], { cwd: src });

    // The install: one file that will be replaced, one that must be left alone.
    const install = join(work, 'Games', 'Crimson Desert');
    mkdirSync(join(install, 'bin'), { recursive: true });
    writeFileSync(join(install, 'bin', 'CrimsonDesert.exe'), 'old exe');
    writeFileSync(join(install, 'untouched.pak'), 'pak');

    const log = [];
    const res = await csrin.extractInto(archive, install, { gameName: 'Crimson Desert', onLog: (l) => log.push(l) });
    if (res.folder !== 'Crimson Desert') fails.push(`took folder "${res.folder}"`);
    if (res.files !== 3) fails.push(`placed ${res.files} files, expected 3`);
    if (res.replaced !== 1) fails.push(`replaced ${res.replaced} files, expected 1`);
    const exe = join(install, 'bin', 'CrimsonDesert.exe');
    if (readFileSync(exe, 'utf8') !== 'new:Crimson Desert/bin/CrimsonDesert.exe') fails.push('the exe was not replaced');
    if (readFileSync(`${exe}${csrin.BACKUP_SUFFIX}`, 'utf8') !== 'old exe') fails.push('the original exe was not kept as .csrin.bak');
    if (!existsSync(join(install, 'read.nfo')) || !existsSync(join(install, 'steam_api64.dll'))) fails.push('new files missing');
    if (readFileSync(join(install, 'untouched.pak'), 'utf8') !== 'pak') fails.push('an unrelated file changed');
    if (existsSync(join(install, 'Other Game')) || existsSync(join(install, 'x.exe'))) fails.push('the other game\'s folder leaked into the install');
    if (existsSync(join(install, 'Crimson Desert'))) fails.push('the folder was nested instead of stripped');
    if (statSync(install).isDirectory() && existsSync(join(install, `.librarian-csrin-stage-`))) fails.push('staging left behind');
    if (!log.some((l) => /Taking "Crimson Desert"/.test(l))) fails.push(`no log line names the folder taken: ${JSON.stringify(log)}`);

    // The real DenuvOwO layout: the top folder is the member's name and
    // mirrors the game root. It is the one whose entries exist in the install.
    const src2 = join(work, 'src2');
    for (const f of ['DenuvOwO/bin64/CrimsonDesert.exe', 'DenuvOwO/bin64/coldclient/steam_api64.dll', 'Extras/readme.txt']) {
      mkdirSync(dirname(join(src2, f)), { recursive: true });
      writeFileSync(join(src2, f), `rel:${f}`);
    }
    const archive2 = join(work, 'release2.7z');
    execFileSync(st.tarPath, ['-a', '-cf', archive2, 'DenuvOwO', 'Extras'], { cwd: src2 });
    const install2 = join(work, 'Games', 'Crimson Desert Enhanced');
    mkdirSync(join(install2, 'bin64'), { recursive: true });
    writeFileSync(join(install2, 'bin64', 'CrimsonDesert.exe'), 'retail');
    const log2 = [];
    const res2 = await csrin.extractInto(archive2, install2, { gameName: 'Crimson Desert Enhanced', onLog: (l) => log2.push(l) });
    if (res2.folder !== 'DenuvOwO' || res2.mode !== 'folder') fails.push(`member-named folder not chosen: ${JSON.stringify(res2)}`);
    if (!existsSync(join(install2, 'bin64', 'coldclient', 'steam_api64.dll'))) fails.push('mirrored folder contents not placed');
    if (existsSync(join(install2, 'Extras')) || existsSync(join(install2, 'DenuvOwO'))) fails.push('the extras folder or a nested copy leaked into the install');
    if (readFileSync(join(install2, 'bin64', `CrimsonDesert.exe${csrin.BACKUP_SUFFIX}`), 'utf8') !== 'retail') fails.push('retail exe not backed up in the mirror case');
    if (!log2.some((l) => /mirrors the game folder/.test(l))) fails.push(`mirror log line missing: ${JSON.stringify(log2)}`);

    // The emulator's DLL beside the game's own `.bak`: the original comes
    // back, the emulator's copy is kept, nothing else moves.
    const install3 = join(work, 'Games', 'Onimusha');
    mkdirSync(join(install3, 'bin'), { recursive: true });
    writeFileSync(join(install3, 'steam_api64.dll'), 'emulator');
    writeFileSync(join(install3, 'steam_api64.dll.bak'), 'retail');
    writeFileSync(join(install3, 'bin', 'steam_api.dll.bak'), 'retail32');
    writeFileSync(join(install3, 'other.dll'), 'other');
    // SteamAutoCrack's settings folder beside the emulator DLL: it shadows
    // the release's own and its unlock_all=1 stalls the DLC check.
    mkdirSync(join(install3, 'steam_settings'), { recursive: true });
    writeFileSync(join(install3, 'steam_settings', 'configs.app.ini'), '[app::dlcs]\r\nunlock_all=1\r\n');
    const log3 = [];
    const restored = csrin.restoreEmulatorBackups(install3, (l) => log3.push(l));
    if (readFileSync(join(install3, 'steam_api64.dll'), 'utf8') !== 'retail') fails.push('the retail DLL was not put back');
    if (readFileSync(join(install3, 'steam_api64.dll.emu.bak'), 'utf8') !== 'emulator') fails.push('the emulator DLL was not kept as .emu.bak');
    if (existsSync(join(install3, 'steam_api64.dll.bak'))) fails.push('the .bak is still there after restoring');
    if (readFileSync(join(install3, 'bin', 'steam_api.dll'), 'utf8') !== 'retail32') fails.push('a lone .bak (no live DLL) was not restored');
    if (readFileSync(join(install3, 'other.dll'), 'utf8') !== 'other') fails.push('an unrelated DLL changed');
    if (existsSync(join(install3, 'steam_settings'))) fails.push('the emulator\'s steam_settings still shadows the release\'s');
    if (!existsSync(join(install3, 'steam_settings.emu.bak', 'configs.app.ini'))) fails.push('the emulator\'s steam_settings was not kept as .emu.bak');
    if (restored.length !== 3 || !log3.some((l) => /set aside/.test(l))) fails.push(`restore reported ${JSON.stringify(restored)} / ${JSON.stringify(log3)}`);

    // Same archive, an install named after neither folder: refused, untouched.
    const stranger = join(work, 'Games', 'Gamma');
    mkdirSync(stranger, { recursive: true });
    writeFileSync(join(stranger, 'g.exe'), 'g');
    let refused = '';
    try { await csrin.extractInto(archive, stranger, { gameName: 'Gamma' }); } catch (e) { refused = e.message; }
    if (!/several folders/.test(refused)) fails.push(`ambiguous archive not refused: "${refused}"`);
    if (readFileSync(join(stranger, 'g.exe'), 'utf8') !== 'g' || existsSync(join(stranger, 'read.nfo'))) fails.push('a refused extraction still changed the install');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return fails;
}

const SUITES = { deps, wiring, parse, extract };
const name = process.argv[2] || 'all';
const run = name === 'all' ? Object.keys(SUITES) : [name];
let failed = false;
for (const suite of run) {
  if (!SUITES[suite]) { console.error(`unknown suite: ${suite}`); process.exit(2); }
  const fails = await SUITES[suite]();
  for (const f of fails) console.error(`FAIL ${suite}: ${f}`);
  if (fails.length) failed = true;
  else console.log(`OK ${suite}`);
}
process.exit(failed ? 1 : 0);
