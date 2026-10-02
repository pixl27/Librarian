// Evidence only: PE imports and bounded string reads. No DLL is loaded.
const fs = require('fs/promises');
const path = require('path');
const { inspectPe } = require('./dlssgPe');
const SKIP = /^(\.git|\.depotdownloader|node_modules|_?commonredist|redist|redistributables|__installer|dlssg_sm86|_storage_|backups?)$/i;
const ANTICHEAT = /easyanticheat|battleye|(^|[_-])(?:eac|beclient|beservice)(?:[_.-]|$)|vgk\.|vanguard|equ8|faceit|anticheat|anti-cheat/i;
const HELPER = /launcher|crash|report|unins|setup|install|redist|server|editor|helper|benchmark|updater/i;

async function markers(file, names) {
  const handle = await fs.open(file, 'r');
  const found = new Set();
  try {
    const limit = Math.min((await handle.stat()).size, 64 * 1024 * 1024);
    const needles = names.map(name => [name, name.toLowerCase(), Buffer.from(name.toLowerCase(), 'utf16le').toString('latin1')]);
    const overlap = Math.max(...needles.map(n => n[2].length), 1);
    const buffer = Buffer.alloc(256 * 1024);
    let tail = '';
    for (let offset = 0; offset < limit; offset += buffer.length) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit - offset), offset);
      const text = tail + buffer.toString('latin1', 0, bytesRead).toLowerCase();
      for (const [name, ascii, wide] of needles) if (text.includes(ascii) || text.includes(wide)) found.add(name);
      if (found.size === names.length) break;
      tail = text.slice(-overlap);
    }
    return found;
  } finally { await handle.close(); }
}

async function scan(root) {
  const files = [], antiCheat = [], gaps = [];
  let count = 0, incomplete = false;
  const gap = (file, reason) => { incomplete = true; if (gaps.length < 8) gaps.push({ path: path.relative(root, file), reason }); };
  const walk = async (dir, depth) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) { gap(dir, error.code || 'unreadable'); return; }
    for (const entry of entries) {
      if (++count > 25000) { gap(dir, 'scan limit reached'); return; }
      const full = path.join(dir, entry.name);
      if (ANTICHEAT.test(entry.name)) antiCheat.push(path.relative(root, full));
      if (entry.isSymbolicLink()) { gap(full, 'linked path skipped'); continue; }
      if (entry.isDirectory() && !SKIP.test(entry.name)) {
        if (depth < 9) await walk(full, depth + 1); else gap(full, 'depth limit reached');
      } else if (entry.isFile() && /\.(dll|exe)$/i.test(entry.name)) files.push(full);
    }
  };
  await walk(root, 0);
  const evidence = files.filter(f => /^(nvngx_dlssg|sl\.dlss_g)\.dll$/i.test(path.basename(f)));
  const reports = [], candidates = [], peCache = new Map();
  const readMarkers = async (file, names) => markers(file, names).catch(error => { gap(file, error.code || 'unreadable'); return new Set(); });
  const inspect = async file => {
    if (!peCache.has(file)) peCache.set(file, inspectPe(file).catch(error => { gap(file, error.code || 'unreadable'); return null; }));
    return peCache.get(file);
  };
  const byDirectory = new Map(), unrealByName = new Map();
  const unrealBinary = file => /(?:^|[\\/])Binaries[\\/]/i.test(path.relative(root, file));
  const hasUnrealEngine = files.some(file => /^Engine[\\/](?:Binaries|Plugins)[\\/]/i.test(path.relative(root, file)));
  for (const file of files) {
    const key = path.dirname(file).toLowerCase();
    if (!byDirectory.has(key)) byDirectory.set(key, new Map());
    byDirectory.get(key).set(path.basename(file).toLowerCase(), file);
    if (/\.dll$/i.test(file) && unrealBinary(file)) {
      const name = path.basename(file).toLowerCase();
      if (!unrealByName.has(name)) unrealByName.set(name, []);
      unrealByName.get(name).push(file);
    }
  }
  if (evidence.length) {
    const exes = files.filter(f => /\.exe$/i.test(f) && !HELPER.test(path.basename(f)));
    if (exes.length > 80) gap(root, 'executable limit reached');
    for (const exe of exes.slice(0, 80)) {
      const pe = await inspect(exe);
      const report = { exe: path.relative(root, exe), directory: path.relative(root, path.dirname(exe)), readable: !!pe, x64: !!pe?.x64, dx12: false, version: false, winmm: false, dx12Evidence: '', proxyImport: '', proxyEvidence: [], ambiguousDependencies: [] };
      reports.push(report);
      if (!pe?.x64) continue;
      const local = byDirectory.get(path.dirname(exe).toLowerCase());
      // UE delay-loads third-party modules from Engine/Project/Plugin Binaries,
      // not just the EXE folder. Resolve actual imported names only. A unique
      // x64 match is evidence; duplicate basenames must never be guessed.
      const unreal = hasUnrealEngine && /[\\/]Binaries[\\/]Win64[\\/]/i.test(exe);
      const resolveDependency = async (name, importer) => {
        const besideImporter = byDirectory.get(path.dirname(importer).toLowerCase())?.get(name);
        if (besideImporter) return besideImporter;
        if (local.has(name)) return local.get(name);
        if (!unreal) return null;
        const matches = [];
        for (const file of unrealByName.get(name) || []) if ((await inspect(file))?.x64) matches.push(file);
        if (matches.length === 1) return matches[0];
        if (matches.length > 1 && !report.ambiguousDependencies.some(d => d.name === name)) report.ambiguousDependencies.push({ name, paths: matches.map(file => path.relative(root, file)) });
        return null;
      };
      const imports = new Set(), queue = [{ file: exe, pe, chain: [report.exe] }], visited = new Set(), reachable = [];
      while (queue.length && visited.size < 256) {
        const node = queue.shift();
        if (visited.has(node.file)) continue;
        visited.add(node.file); reachable.push(node.file);
        for (const name of node.pe.imports) {
          imports.add(name);
          if (name === 'version.dll' && report.proxyEvidence.length < 4) report.proxyEvidence.push([...node.chain, 'version.dll'].join(' → '));
          const dependency = await resolveDependency(name, node.file);
          if (!dependency || visited.has(dependency) || queue.some(item => item.file === dependency)) continue;
          const child = await inspect(dependency);
          if (child?.x64) queue.push({ file: dependency, pe: child, chain: [...node.chain, path.relative(root, dependency)] });
        }
        // Streamline's interposer loads its plugins with LoadLibraryExW, not
        // imports (CONTROL Resonant: sl.common.dll is the one importing VERSION).
        // Follow only sibling plugins whose name the reachable interposer holds.
        if (path.basename(node.file).toLowerCase() === 'sl.interposer.dll') {
          const siblings = [...(byDirectory.get(path.dirname(node.file).toLowerCase()) || new Map())]
            .filter(([n]) => /^sl\..+\.dll$/.test(n) && n !== 'sl.interposer.dll');
          const named = await readMarkers(node.file, siblings.map(([n]) => n.slice(0, -4)));
          for (const [n, plugin] of siblings) {
            if (!named.has(n.slice(0, -4)) || visited.has(plugin) || queue.some(item => item.file === plugin)) continue;
            const child = await inspect(plugin);
            if (child?.x64) queue.push({ file: plugin, pe: child, chain: [...node.chain, `${path.relative(root, plugin)} (Streamline plugin)`] });
          }
        }
      }
      if (queue.length) gap(exe, 'dependency limit reached');
      report.version = imports.has('version.dll'); report.winmm = imports.has('winmm.dll');
      report.proxyImport = report.version ? (pe.imports.includes('version.dll') ? 'executable' : 'dependency') : '';
      const name = path.basename(exe).toLowerCase();
      report.reported = name === 'cyberpunk2077.exe' || name === 'b1-win64-shipping.exe';
      report.dx12 = imports.has('d3d12.dll') || report.reported;
      if (report.dx12) report.dx12Evidence = imports.has('d3d12.dll') ? 'DirectX 12 import' : 'Upstream game profile';
      if (!report.dx12) {
        // DX12 engines may load a renderer module by name rather than import D3D12.
        // Require a reference in a reachable engine AND an x64 provider with DX12 APIs.
        for (const file of reachable) {
          const moduleDirectory = byDirectory.get(path.dirname(file).toLowerCase());
          const providers = [...new Map([...local, ...moduleDirectory]).entries()].filter(([n]) => /^(rd3d12|(?:render|renderer|runtime|d3d12rhi).*(?:dx12|d3d12)).*\.dll$/i.test(n)).slice(0, 8);
          const tokens = providers.map(([n]) => n.startsWith('rd3d12') ? 'rd3d12' : n);
          const needles = ['d3d12.dll', 'D3D12CreateDevice', ...tokens];
          const seen = await readMarkers(file, needles);
          if (seen.has('d3d12.dll') && seen.has('D3D12CreateDevice')) {
            report.dx12 = true; report.dx12Evidence = `Dynamic DirectX 12 API: ${path.relative(root, file)}`; break;
          }
          for (let i = 0; i < providers.length; i++) {
            if (!seen.has(tokens[i])) continue;
            const provider = providers[i][1], providerPe = await inspect(provider);
            if (!providerPe?.x64) continue;
            const api = await readMarkers(provider, ['d3d12.dll', 'D3D12CreateDevice']);
            if (providerPe.imports.includes('d3d12.dll') || (api.has('d3d12.dll') && api.has('D3D12CreateDevice'))) {
              report.dx12 = true; report.dx12Evidence = `Dynamic renderer: ${path.relative(root, provider)}`; break;
            }
          }
          if (report.dx12) break;
        }
      }
      if (report.dx12 && report.version) candidates.push(report);
    }
  }
  return { evidence: evidence.map(f => path.relative(root, f)), candidates, reports, antiCheat, incomplete, gaps };
}

module.exports = { scan };
