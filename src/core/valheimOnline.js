// Valheim's managed adapter. Game assemblies are inspected, never rewritten.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { getDepsPath } = require('./runtimePaths');
const PLUGIN = 'BepInEx/plugins/Librarian.ValheimOnline/Librarian.ValheimOnline.dll';
const RECEIPT = '.DepotDownloader/valheim-online.json';
const checks = new Map();
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exists = file => fs.existsSync(file);
function applicable(game) { return exists(path.join(game, 'valheim_Data')) && exists(path.join(game, 'valheim.exe')); }
function receipt(game) { try { return JSON.parse(fs.readFileSync(path.join(game, RECEIPT), 'utf8')); } catch { return null; } }
function inside(game, relative) {
  const root = path.resolve(game), target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) throw new Error('Adapter path escaped game directory');
  for (let at = target; at !== root; at = path.dirname(at)) {
    if (exists(at) && fs.lstatSync(at).isSymbolicLink()) throw new Error('Adapter destination contains a symbolic link');
  }
  return target;
}
function inspect(game) {
  if (!applicable(game)) return { applicable: false, ok: true };
  try {
    const config = path.join(game, 'doorstop_config.ini');
    if (exists(config)) {
      const body = fs.readFileSync(config, 'utf8');
      if (!/^\s*enabled\s*=\s*true\s*$/im.test(body) || !/^\s*target_assembly\s*=\s*.*BepInEx[\\/]core[\\/]BepInEx\.Preloader\.dll\s*$/im.test(body))
        throw new Error('The existing mod loader is disabled or uses a different entry point');
    }
    const managed = path.join(game, 'valheim_Data/Managed');
    const probe = getDepsPath('valheim-online', 'ValheimCompatibility.exe');
    const files = [probe, path.join(path.dirname(probe), 'Mono.Cecil.dll'),
      ...['assembly_valheim.dll', 'PlayFab.dll', 'com.rlabrecque.steamworks.net.dll'].map(name => path.join(managed, name))];
    const signature = files.map(digest).join(':');
    if (checks.has(signature)) return checks.get(signature);
    const result = spawnSync(probe, [managed], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
    let parsed;
    try { parsed = JSON.parse(result.stdout || '{}'); } catch { parsed = {}; }
    const answer = { applicable: true, ok: result.status === 0 && parsed.ok === true,
      error: parsed.error || result.error?.message || (result.status !== 0 ? 'Valheim compatibility inspection failed' : undefined), signature };
    if (checks.size >= 16) checks.delete(checks.keys().next().value);
    checks.set(signature, answer);
    return answer;
  } catch (error) { return { applicable: true, ok: false, error: error.message }; }
}
function bundleFiles() {
  const base = getDepsPath('bepinex');
  const core = 'BepInEx/core';
  return [
    ...['winhttp.dll', 'doorstop_config.ini', '.doorstop_version'].map(relative => ({ relative, source: path.join(base, relative) })),
    ...fs.readdirSync(path.join(base, core)).filter(name => name.endsWith('.dll')).map(name => ({ relative: `${core}/${name}`, source: path.join(base, core, name) })),
    { relative: PLUGIN, source: getDepsPath('valheim-online', 'Librarian.ValheimOnline.dll') },
  ];
}
function status(game) {
  const check = inspect(game);
  if (!check.applicable) return check;
  try {
    const saved = receipt(game);
    const bundled = new Map(bundleFiles().map(file => [file.relative, file.source]));
    const plugin = inside(game, PLUGIN);
    const installed = exists(plugin);
    const incomplete = !saved || saved.active !== true || (saved.files || []).some(file => !exists(inside(game, file.relative)));
    const stale = installed && (!fs.readFileSync(plugin).equals(fs.readFileSync(getDepsPath('valheim-online', 'Librarian.ValheimOnline.dll'))) ||
      (saved?.files || []).some(file => file.owned && exists(inside(game, file.relative)) &&
        digest(inside(game, file.relative)) !== (bundled.has(file.relative) ? digest(bundled.get(file.relative)) : file.hash)));
    return { ...check, installed, stale, incomplete };
  } catch (error) { return { ...check, ok: false, error: error.message }; }
}
function ensure(game) {
  const check = inspect(game);
  if (!check.applicable) return { success: true, skipped: true };
  if (!check.ok) return { success: false, error: `Valheim online compatibility check: ${check.error}` };
  try {
    if (exists(path.join(game, 'OnlineFix64.dll'))) throw new Error('Remove the other online fix before enabling Librarian\'s Valheim adapter');
    const old = receipt(game);
    const prior = new Map((old?.files || []).map(file => [file.relative, file]));
    const hasLoader = exists(inside(game, 'BepInEx/core/BepInEx.dll'));
    const plans = bundleFiles().map(file => {
      const target = inside(game, file.relative), hash = digest(file.source), previous = prior.get(file.relative);
      const current = exists(target) ? digest(target) : null;
      let preserve = hasLoader && file.relative !== PLUGIN && current && current !== hash && !previous?.owned;
      if (file.relative === 'winhttp.dll' && current && current !== hash && !hasLoader && !previous?.owned) throw new Error('Existing winhttp.dll belongs to another mod');
      if (current && current !== hash && !preserve && (!previous?.owned || current !== previous.hash)) throw new Error(`Adapter file was modified externally: ${file.relative}`);
      return { ...file, target, hash: preserve ? current : hash, current, preserve,
        owned: previous?.owned || !current || file.relative === PLUGIN && current === hash };
    });
    // Preflight all collisions before writing anything. Keep existing mod loaders.
    const written = [];
    try {
      for (const file of plans) {
        if (file.preserve || file.current === file.hash) continue;
        const before = file.current ? fs.readFileSync(file.target) : null;
        fs.mkdirSync(path.dirname(file.target), { recursive: true });
        const temporary = `${file.target}.${crypto.randomUUID()}.tmp`;
        try {
          fs.copyFileSync(file.source, temporary);
          if (digest(temporary) !== file.hash) throw new Error('Adapter copy verification failed');
          fs.renameSync(temporary, file.target);
          written.push({ file: file.target, before });
        } finally { try { fs.unlinkSync(temporary); } catch {} }
      }
      const saved = { version: 1, active: true, signature: check.signature, at: Date.now(), files: plans.map(({ relative, hash, owned }) => ({ relative, hash, owned: Boolean(owned) })) };
      fs.mkdirSync(path.join(game, '.DepotDownloader'), { recursive: true });
      const target = inside(game, RECEIPT), temporary = `${target}.${crypto.randomUUID()}.tmp`;
      try { fs.writeFileSync(temporary, JSON.stringify(saved, null, 2)); fs.renameSync(temporary, target); }
      finally { try { fs.unlinkSync(temporary); } catch {} }
      return { success: true, repaired: written.length };
    } catch (error) {
      for (const change of written.reverse()) {
        try { if (change.before) fs.writeFileSync(change.file, change.before); else fs.unlinkSync(change.file); } catch {}
      }
      throw error;
    }
  } catch (error) { return { success: false, error: error.message }; }
}
function disable(game) {
  const saved = receipt(game);
  if (!saved) return { success: true, skipped: true };
  try {
    const file = saved.files.find(file => file.relative === PLUGIN);
    const target = inside(game, PLUGIN);
    if (exists(target)) {
      if (!file?.owned || digest(target) !== file.hash) throw new Error('Valheim plugin was modified externally; it was preserved');
      fs.unlinkSync(target);
    }
    saved.active = false;
    fs.writeFileSync(inside(game, RECEIPT), JSON.stringify(saved, null, 2));
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
}
module.exports = { applicable, inspect, status, ensure, disable, PLUGIN };
