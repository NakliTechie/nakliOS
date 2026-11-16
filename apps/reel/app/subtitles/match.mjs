/* Sidecar subtitle files matched to a video by base name. Pure.
 * "Movie.mkv" matches "Movie.srt", "Movie.en.srt" and "Movie.eng.forced.srt" (case-insensitive);
 * it does not match "Movie 2.srt" or "Movie.extended.mkv". */

export const SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.ass', '.ssa'];

const FORCED_TAGS = new Set(['forced', 'foreign']);
const OTHER_TAGS = new Set(['sdh', 'cc', 'default', 'full']);

export function isSubtitleName(name) {
  const lower = String(name || '').toLowerCase();
  return SUBTITLE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

export function stripExtension(name) {
  return String(name || '').replace(/\.[^./\\]*$/, '');
}

/* Reads the tags after the video's base name: language, forced, sdh. */
export function describeSidecar(videoName, subtitleName) {
  if (!isSubtitleName(subtitleName)) return null;
  const base = stripExtension(videoName).toLowerCase();
  const stem = stripExtension(subtitleName);
  const lowerStem = stem.toLowerCase();
  if (!base) return null;
  let tags;
  if (lowerStem === base) tags = [];
  else if (lowerStem.startsWith(`${base}.`)) tags = stem.slice(base.length + 1).split('.').filter(Boolean);
  else return null;
  const lowerTags = tags.map(tag => tag.toLowerCase());
  const forced = lowerTags.some(tag => FORCED_TAGS.has(tag));
  const language = lowerTags.find(tag => /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/.test(tag) && !OTHER_TAGS.has(tag)) || null;
  return { name: subtitleName, tags, language, forced, exact: tags.length === 0 };
}

/* Returns matching files, best first: an exact base-name match, then the reader's language,
 * then other languages; forced-only files go last because they hold only foreign dialogue. */
export function matchSidecars(videoName, files, preferredLanguages = []) {
  const prefs = preferredLanguages.map(lang => String(lang).toLowerCase().split('-')[0]);
  const rank = info => {
    if (info.forced) return 3;
    if (info.exact) return 0;
    const lang = (info.language || '').split('-')[0];
    const short = lang.length === 3 ? THREE_TO_TWO[lang] || lang : lang;
    const at = prefs.indexOf(short);
    return at >= 0 ? 1 + at / 1000 : 2;
  };
  return files
    .map(file => ({ file, info: describeSidecar(videoName, file?.name) }))
    .filter(entry => entry.info)
    .sort((a, b) => rank(a.info) - rank(b.info) || a.info.name.localeCompare(b.info.name));
}

const THREE_TO_TWO = {
  eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', dut: 'nl', nld: 'nl',
  rus: 'ru', jpn: 'ja', chi: 'zh', zho: 'zh', kor: 'ko', hin: 'hi', ara: 'ar', swe: 'sv', nor: 'no', dan: 'da',
  fin: 'fi', pol: 'pl', tur: 'tr', gre: 'el', ell: 'el', heb: 'he', cze: 'cs', ces: 'cs', hun: 'hu',
};
