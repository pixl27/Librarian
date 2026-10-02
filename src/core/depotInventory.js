// ─── Depot inventory ─────────────────────────────────────────────
//
// A depot manifest lists every file a game installs, with its size. Steam only
// ever exposes that at depot granularity ("do you want the German depot?"), but
// the data is per-file — so we can show what is actually inside a 90 GB install
// and let the user leave out the parts they will never touch.
//
// The same classifier runs here (to build the plan) and in steamPipe (to honour
// it during download), so what the user was shown is exactly what gets skipped.
//
// Bias throughout: when unsure, classify as core. Wrongly marking a needed file
// optional breaks the install; wrongly marking an optional file core just costs
// disk.
const path = require('path');

// Steam's own language folder names, plus the ISO codes that show up in file
// suffixes. Full names may match anywhere in the path; two-letter codes only
// match a whole path segment, or a whole token in a filename — otherwise "it"
// would match "edit" and "de" would match half the alphabet.
const LANGUAGES = [
  ['English', ['english', 'en', 'eng', 'en-us', 'en-gb']],
  ['French', ['french', 'francais', 'fr', 'fra', 'fre', 'fr-fr']],
  ['German', ['german', 'deutsch', 'de', 'ger', 'deu', 'de-de']],
  ['Italian', ['italian', 'italiano', 'it', 'ita', 'it-it']],
  ['Spanish', ['spanish', 'espanol', 'es', 'spa', 'es-es', 'latam', 'latam-spanish']],
  ['Portuguese', ['portuguese', 'brazilian', 'portugues', 'pt', 'ptb', 'pt-br', 'br']],
  ['Russian', ['russian', 'russkij', 'ru', 'rus', 'ru-ru']],
  ['Polish', ['polish', 'polski', 'pl', 'pol']],
  ['Japanese', ['japanese', 'ja', 'jp', 'jpn']],
  ['Korean', ['korean', 'koreana', 'ko', 'kor']],
  ['Chinese (Simplified)', ['schinese', 'chinese', 'zh-cn', 'zh-hans', 'chs', 'cn']],
  ['Chinese (Traditional)', ['tchinese', 'zh-tw', 'zh-hant', 'cht', 'tw']],
  ['Turkish', ['turkish', 'turkce', 'tr', 'tur']],
  ['Czech', ['czech', 'cs', 'cze', 'ces']],
  ['Dutch', ['dutch', 'nederlands', 'nl', 'nld']],
  ['Danish', ['danish', 'da', 'dan']],
  ['Finnish', ['finnish', 'fi', 'fin']],
  ['Norwegian', ['norwegian', 'no', 'nor', 'nb']],
  ['Swedish', ['swedish', 'sv', 'swe']],
  ['Hungarian', ['hungarian', 'hu', 'hun']],
  ['Greek', ['greek', 'el', 'ell', 'gre']],
  ['Romanian', ['romanian', 'ro', 'ron']],
  ['Bulgarian', ['bulgarian', 'bg', 'bul']],
  ['Ukrainian', ['ukrainian', 'uk', 'ukr']],
  ['Thai', ['thai', 'th', 'tha']],
  ['Vietnamese', ['vietnamese', 'vi', 'vie']],
  ['Arabic', ['arabic', 'ar', 'ara']],
];

const LANG_BY_FULL = new Map();   // long, unambiguous names — match anywhere
const LANG_BY_CODE = new Map();   // short codes — whole segment/token only
for (const [name, tokens] of LANGUAGES) {
  for (const token of tokens) {
    (token.length > 3 ? LANG_BY_FULL : LANG_BY_CODE).set(token, name);
  }
}

const VIDEO_EXT = new Set(['bik', 'bk2', 'usm', 'mp4', 'webm', 'wmv', 'avi', 'mov', 'ogv', 'mpg', 'mpeg', 'vp6']);
const AUDIO_EXT = new Set(['wem', 'bnk', 'fsb', 'ogg', 'wav', 'mp3', 'flac', 'xwb', 'xwm', 'aud', 'snd']);
const DOC_EXT = new Set(['pdf', 'txt', 'rtf', 'doc', 'docx']);

const VIDEO_DIRS = new Set(['movie', 'movies', 'video', 'videos', 'cinematic', 'cinematics', 'fmv', 'cutscene', 'cutscenes', 'bink']);
const AUDIO_DIRS = new Set(['audio', 'sound', 'sounds', 'music', 'voice', 'voices', 'vo', 'speech', 'wwise', 'fmod', 'soundbanks']);
const HD_DIRS = new Set(['hd', '4k', 'uhd', 'hires', 'highres', 'high_res', 'hd_textures', 'texture_hd']);
const REDIST_DIRS = new Set(['_commonredist', 'commonredist', 'redist', 'redistributables', 'directx', 'vcredist', 'dotnet', 'openal', 'physx', '_redist']);
const EXTRA_DIRS = new Set(['soundtrack', 'ost', 'artbook', 'artwork', 'manual', 'manuals', 'bonus', 'extras', 'wallpaper', 'wallpapers', 'concept_art']);

/** Fixed, non-language groups. Order here is the display order for ties. */
const CATEGORIES = {
  core: { id: 'core', label: 'Game files', hint: 'Engine, code and assets the game cannot start without.', safety: 'required', icon: '▣' },
  redist: { id: 'redist', label: 'Redistributables', hint: 'DirectX, VC++ and friends. Skip if your system already has them.', safety: 'recommended', icon: '⚙' },
  video: { id: 'video', label: 'Videos & cutscenes', hint: 'Pre-rendered movies. Some games skip them gracefully; some do not.', safety: 'optional', icon: '▶' },
  audio: { id: 'audio', label: 'Extra audio', hint: 'Sound banks not tied to a specific language.', safety: 'optional', icon: '♪' },
  hd: { id: 'hd', label: 'High-resolution textures', hint: 'Optional HD/4K asset packs.', safety: 'optional', icon: '◱' },
  extras: { id: 'extras', label: 'Manuals & bonus content', hint: 'Soundtracks, art books, wallpapers, PDFs.', safety: 'optional', icon: '❏' },
};

function segmentsOf(filename) {
  return String(filename || '').toLowerCase().split(/[\\/]+/).filter(Boolean);
}

function extensionOf(filename) {
  const dot = String(filename || '').lastIndexOf('.');
  return dot === -1 ? '' : String(filename).slice(dot + 1).toLowerCase();
}

// Words that mark a path as carrying localised content. A bare two-letter code
// inside a file name only counts as a language when one of these is nearby —
// otherwise "editor/edit_it.cfg" reads as Italian and a core file gets skipped.
const LOC_MARKERS = new Set([
  'voice', 'voices', 'vo', 'sound', 'sounds', 'audio', 'speech', 'spoken',
  'text', 'texts', 'loc', 'locale', 'locales', 'localization', 'localisation',
  'lang', 'langs', 'language', 'languages', 'subtitle', 'subtitles', 'subs',
  'dialog', 'dialogue', 'caption', 'captions', 'strings', 'translation', 'translations',
]);

/**
 * Language this file belongs to, or null.
 *
 * Long, unambiguous names ("italian", "deutsch", "koreana") match anywhere.
 * Two-letter codes are far riskier, so they only count as either a whole path
 * segment ("data/it/…") or the trailing token of a file name that is already
 * marked as localised content ("sound/voice_ru.pck").
 */
function detectLanguage(filename) {
  const segments = segmentsOf(filename);

  for (const segment of segments) {
    if (LANG_BY_CODE.has(segment)) return LANG_BY_CODE.get(segment);
    for (const [token, name] of LANG_BY_FULL) {
      if (segment.includes(token)) return name;
    }
  }

  const base = segments[segments.length - 1] || '';
  const stem = base.replace(/\.[^.]+$/, '');
  const stemTokens = stem.split(/[^a-z0-9]+/).filter(Boolean);
  const nearbyMarker =
    segments.slice(0, -1).some(segment => LOC_MARKERS.has(segment))
    || stemTokens.slice(0, -1).some(token => LOC_MARKERS.has(token));
  if (!nearbyMarker) return null;

  const last = stemTokens[stemTokens.length - 1];
  if (last && last.length >= 2 && LANG_BY_CODE.has(last)) return LANG_BY_CODE.get(last);
  return null;
}

/**
 * Group id for a manifest file path.
 * Language wins over category: "audio/french/vo.bnk" is more usefully offered
 * as "French" than as "Extra audio".
 */
function classifyFile(filename) {
  const segments = segmentsOf(filename);
  const dirs = segments.slice(0, -1);
  const ext = extensionOf(filename);

  for (const dir of dirs) {
    if (REDIST_DIRS.has(dir)) return 'redist';
    if (EXTRA_DIRS.has(dir)) return 'extras';
  }

  const language = detectLanguage(filename);
  if (language) return `loc:${language}`;

  for (const dir of dirs) {
    if (VIDEO_DIRS.has(dir)) return 'video';
    if (HD_DIRS.has(dir)) return 'hd';
  }
  if (VIDEO_EXT.has(ext)) return 'video';

  for (const dir of dirs) {
    if (AUDIO_DIRS.has(dir)) return 'audio';
  }
  if (AUDIO_EXT.has(ext)) return 'audio';

  if (DOC_EXT.has(ext) && /manual|readme|guide|licen[cs]e/i.test(filename)) return 'extras';

  return 'core';
}

function describeGroup(id) {
  if (CATEGORIES[id]) return CATEGORIES[id];
  if (id.startsWith('loc:')) {
    const name = id.slice(4);
    return {
      id,
      label: name,
      hint: `Text and voice for ${name}.`,
      safety: 'optional',
      icon: '⌘',
      kind: 'language',
    };
  }
  return CATEGORIES.core;
}

/**
 * Walk the manifests for the chosen depots and total up what is inside.
 *
 * @param {object} gameData  parsed zip payload (depots, manifests, manifest_dir)
 * @param {string[]} selectedDepots
 * @returns {{ok: boolean, error?: string, totalBytes: number, fileCount: number, groups: object[]}}
 */
function buildInventory(gameData, selectedDepots) {
  const { readManifestFile } = require('./steamPipe');

  const manifestDir = gameData?.manifest_dir;
  if (!manifestDir) return { ok: false, error: 'No manifest directory for this download.', groups: [] };

  const totals = new Map();   // groupId -> { bytes, files }
  let totalBytes = 0;
  let fileCount = 0;

  for (const depotId of selectedDepots) {
    const manifestId = (gameData.manifests || {})[depotId];
    if (!manifestId) continue;
    const manifestPath = path.join(manifestDir, `${depotId}_${manifestId}.manifest`);

    let files;
    try {
      files = readManifestFile(manifestPath, gameData.depots?.[depotId]?.key);
    } catch {
      continue;   // a depot we cannot read simply contributes nothing to the plan
    }

    for (const file of files) {
      // 0x40 = directory. Symlinks and empty files carry no size worth planning.
      if (file.flags & 0x40) continue;
      if (!file.filename || file.linktarget) continue;
      const size = Number(file.size) || 0;
      if (size <= 0) continue;

      const id = classifyFile(file.filename);
      const entry = totals.get(id) || { bytes: 0, files: 0 };
      entry.bytes += size;
      entry.files += 1;
      totals.set(id, entry);

      totalBytes += size;
      fileCount += 1;
    }
  }

  const groups = [...totals.entries()].map(([id, entry]) => {
    const meta = describeGroup(id);
    return {
      id,
      label: meta.label,
      hint: meta.hint,
      icon: meta.icon,
      safety: meta.safety,
      kind: meta.kind || 'category',
      bytes: entry.bytes,
      files: entry.files,
      share: totalBytes > 0 ? entry.bytes / totalBytes : 0,
    };
  });

  // Required first, then biggest — the things worth dropping float to the top
  // of the optional list.
  groups.sort((a, b) => {
    const rank = (g) => (g.safety === 'required' ? 0 : g.safety === 'recommended' ? 1 : 2);
    return rank(a) - rank(b) || b.bytes - a.bytes;
  });

  const optionalBytes = groups
    .filter(g => g.safety === 'optional')
    .reduce((sum, g) => sum + g.bytes, 0);

  return { ok: true, totalBytes, fileCount, optionalBytes, groups };
}

module.exports = { buildInventory, classifyFile, describeGroup, detectLanguage };
