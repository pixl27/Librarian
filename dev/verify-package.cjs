// Read-only verification of the generated application and its source payload.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const manifest = require(path.join(root, 'package.json'));
const resources = path.join(root, 'dist/win-unpacked/resources');
const archive = path.join(resources, 'app.asar');
const portable = path.join(root, `dist/Librarian ${manifest.version}.exe`);
const backup = process.env.LIBRARIAN_TEST_BASELINE || path.join(root, 'audits/2026-09-07/before-fixes');
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}
const sourceFiles = ['main.js', 'preload.js', ...files(path.join(root, 'src')).map(file => path.relative(root, file).replaceAll('\\', '/'))];
const report = { at: new Date().toISOString(), version: manifest.version, matchedSourceFiles: 0, mismatches: [], changesFromBackup: [] };
for (const file of sourceFiles) {
  const content = fs.readFileSync(path.join(root, file));
  try {
    if (!content.equals(asar.extractFile(archive, path.normalize(file)))) report.mismatches.push(file);
    else report.matchedSourceFiles++;
  } catch (error) { report.mismatches.push(`${file}: ${error.message}`); }
  const before = path.join(backup, file);
  if (!fs.existsSync(before)) report.changesFromBackup.push({ file, change: 'added' });
  else if (!content.equals(fs.readFileSync(before))) report.changesFromBackup.push({ file, change: 'modified' });
}
const packagedManifest = JSON.parse(asar.extractFile(archive, 'package.json'));
report.packagedManifestMatches = packagedManifest.version === manifest.version && packagedManifest.main === manifest.main;
report.sourceRollbackPreserved = fs.existsSync(path.join(root, 'deps/SteamAutoCrack/Goldberg.prev'));
report.packagedBackupFiles = files(path.join(resources, 'deps')).map(file => path.relative(resources, file)).filter(file => /(?:^|[\\/])[^\\/]+\.prev(?:[\\/]|$)|\.(tmp|log)$/i.test(file));
const executable = fs.statSync(portable);
report.portable = { file: portable, bytes: executable.size, sha256: hash(fs.readFileSync(portable)), modifiedAt: executable.mtime.toISOString() };
report.archiveSha256 = hash(fs.readFileSync(archive));
report.portableNewerThanArchive = executable.mtimeMs >= fs.statSync(archive).mtimeMs;
report.ok = !report.mismatches.length && report.packagedManifestMatches && report.sourceRollbackPreserved && !report.packagedBackupFiles.length && report.portableNewerThanArchive;
const output = process.env.LIBRARIAN_TEST_OUTPUT || path.join(root, 'audits/2026-09-07/fixes');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'package-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
