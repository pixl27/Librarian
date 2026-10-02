// Build the installer (NSIS, one-click, per user) and optionally publish it.
//
//   node dev/build-installer.cjs                 build into dist/
//   node dev/build-installer.cjs --publish       build, then upload to the
//                                                GitHub release v<version>
//   node dev/build-installer.cjs --feed=<url> --version=<x.y.z> --out=<dir>
//                                                a test build whose updater
//                                                reads <url> instead of GitHub
//
// electron-builder runs under Electron's own Node: the host's Node 20 cannot
// require the ES modules the packaging tools now load. It also shells out to
// npm through PowerShell, so PowerShell is put on the child's PATH explicitly.
//
// Publishing needs a GitHub token with "Contents: read and write" on the
// release repository, in GH_TOKEN or in %APPDATA%\librarian-release\gh-token.
// It is read here and handed to the child's environment only; it is never
// written into the project. Release notes come from --notes="…" or from
// release-notes.md at the project root.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [arg, true];
}));

if (args['builder-child']) {
  process.noAsar = true;
  process.chdir(root);
  const builder = require('electron-builder');
  const options = JSON.parse(process.env.LIBRARIAN_BUILD_OPTIONS || '{}');
  // Overrides go in as a whole configuration file, not as an object to merge:
  // electron-builder deep-merges an option object's `publish` into the first
  // entry of package.json's list, which would graft the test feed onto the
  // GitHub entry instead of replacing it.
  const config = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build;
  if (options.feed) config.publish = [{ provider: 'generic', url: options.feed }];
  if (options.version) config.extraMetadata = { ...config.extraMetadata, version: options.version };
  if (options.out) config.directories = { ...config.directories, output: options.out };
  if (options.notes) config.releaseInfo = { ...config.releaseInfo, releaseNotes: options.notes };
  const configFile = path.join(os.tmpdir(), `librarian-builder-${process.pid}.json`);
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  builder.build({
    targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64),
    publish: options.publish ? 'always' : 'never',
    config: configFile,
  })
    .then(artifacts => console.log(JSON.stringify({ artifacts })))
    .catch(error => { console.error(error.stack || error); process.exitCode = 1; })
    .finally(() => { try { fs.unlinkSync(configFile); } catch { /* already gone */ } });
  return;
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const github = (pkg.build.publish || []).find(p => p.provider === 'github');
const publish = Boolean(args.publish);
const feed = typeof args.feed === 'string' ? args.feed : '';

if (!feed && (!github || !github.owner || github.owner === 'OWNER')) {
  console.error('package.json build.publish still names no GitHub owner. Set build.publish[0].owner and .repo to the release repository first.');
  process.exit(1);
}
if (publish && feed) {
  console.error('--publish uploads to GitHub; it cannot be combined with --feed.');
  process.exit(1);
}

let token = process.env.GH_TOKEN || '';
if (publish && !token) {
  const file = path.join(process.env.APPDATA || os.homedir(), 'librarian-release', 'gh-token');
  try { token = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim(); } catch { /* reported below */ }
  if (!token) {
    console.error(`Publishing needs a GitHub token: set GH_TOKEN, or put it alone in ${file}`);
    process.exit(1);
  }
}

let notes = typeof args.notes === 'string' ? args.notes : '';
if (!notes) {
  try { notes = fs.readFileSync(path.join(root, 'release-notes.md'), 'utf8').trim(); } catch { notes = ''; }
}

const out = typeof args.out === 'string' ? path.resolve(args.out) : '';
const version = typeof args.version === 'string' ? args.version : '';
const logDir = out || path.join(root, 'dist');
fs.mkdirSync(logDir, { recursive: true });

// One PATH, with PowerShell on it, whatever the caller had.
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
const system = process.env.SystemRoot || 'C:\\Windows';
env.Path = [path.join(system, 'System32', 'WindowsPowerShell', 'v1.0'), process.env.PATH || process.env.Path || ''].join(path.delimiter);
env.ELECTRON_RUN_AS_NODE = '1';
env.LIBRARIAN_BUILD_OPTIONS = JSON.stringify({ feed, version, out, publish, notes });
if (publish) env.GH_TOKEN = token;

const startedAt = new Date().toISOString();
const logFile = path.join(logDir, 'installer-build.log');
const log = fs.openSync(logFile, 'w');
let run;
try {
  run = spawnSync(require('electron'), [__filename, '--builder-child'], {
    cwd: root, env, windowsHide: true, stdio: ['ignore', log, log], timeout: 20 * 60 * 1000,
  });
} finally { fs.closeSync(log); }

const output = fs.readFileSync(logFile, 'utf8');
const artifacts = (() => {
  const line = output.split(/\r?\n/).reverse().find(l => l.startsWith('{"artifacts"'));
  try { return JSON.parse(line).artifacts; } catch { return []; }
})();
const result = {
  startedAt, finishedAt: new Date().toISOString(), exitCode: run.status, error: run.error?.message,
  version: version || pkg.version, channel: feed || `github:${github.owner}/${github.repo}`, published: publish && run.status === 0,
  artifacts, log: logFile,
};
console.log(JSON.stringify(result, null, 2));
if (run.status !== 0 || run.error) {
  console.error(output.split(/\r?\n/).slice(-30).join('\n'));
  process.exitCode = 1;
}
