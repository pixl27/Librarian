const fs = require('fs'); const path = require('path');
const LOG = path.join(require('os').tmpdir(), 'csrin-session.log');
const log = (m) => fs.appendFileSync(LOG, m + '\n');
log('start ' + process.argv.join(' | '));
try {
  const { app, safeStorage } = require('electron');
  const { spawnSync } = require('child_process');
  app.setPath('userData', path.join(process.env.APPDATA, 'librarian'));
  app.whenReady().then(() => {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'librarian-settings.json'), 'utf8').replace(/^\uFEFF/, ''));
      const enc = s.csrin_password && s.csrin_password.encrypted;
      const pw = enc ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : (s.csrin_password || '');
      log('user ' + s.csrin_username + ' pw ' + (pw ? 'yes' : 'no'));
      const args = JSON.parse(process.env.CSRIN_SESSION_ARGS || '[]');
      const cmd = process.env.CSRIN_SESSION_CMD || 'python';
      const r = spawnSync(cmd, args, { env: { ...process.env, CSRIN_U: s.csrin_username, CSRIN_P: pw, CSRIN_USERNAME: s.csrin_username, CSRIN_PASSWORD: pw, PYTHONUTF8: '1' }, encoding: 'utf8', timeout: 300000 });
      log('py ' + r.status + ' ' + (r.stdout || '') + (r.stderr || '').slice(-1500) + (r.error ? r.error.message : ''));
    } catch (e) { log('err ' + e.stack); }
    app.quit();
  });
} catch (e) { log('top ' + e.stack); }
