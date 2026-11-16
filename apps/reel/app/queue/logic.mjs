/* Reel queue: pure logic (natural sort, folder classification, sibling subtitles, play order).
 * No DOM and no browser globals, so test/queue.test.mjs runs it in Node.
 *
 * The folder walk shape (skip dot entries, depth cap against symlink loops, sort each level)
 * is adapted from NakliAmp app/library/scan-core.mjs `walk` at NakliAmp commit 5eb5937.
 * NakliAmp's audio tag parsing and playlist file formats do not apply to video folders. */

export const SUBTITLE_EXTENSIONS = Object.freeze(['.srt', '.vtt', '.ass', '.ssa']);
export const REPEAT_MODES = Object.freeze(['off', 'all', 'one']);
export const MAX_DEPTH = 12;
export const MAX_ENTRIES = 5000;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/* "Episode 2" before "Episode 10"; ties broken by exact code-unit order so the sort is stable. */
export function naturalCompare(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/* Compares slash-separated paths one segment at a time, so "Season 2/x" sorts before "Season 10/x". */
export function comparePaths(left, right) {
  const a = String(left ?? '').split('/');
  const b = String(right ?? '').split('/');
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const order = naturalCompare(a[i], b[i]);
    if (order) return order;
  }
  return a.length - b.length;
}

export function extensionOf(name) {
  const base = String(name ?? '').split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

export function stemOf(name) {
  const base = String(name ?? '').split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function dirOf(path) {
  const parts = String(path ?? '').split('/');
  parts.pop();
  return parts.join('/');
}

export function isSubtitleName(name) {
  return SUBTITLE_EXTENSIONS.includes(extensionOf(name));
}

/* True for names the walk skips: dot files (".DS_Store", "._Episode 1.mkv") and dot folders. */
export function isHiddenName(name) {
  return String(name ?? '').startsWith('.');
}

/* Strips the picked folder's own name from a webkitRelativePath ("Show/Season 1/a.mkv" -> "Season 1/a.mkv"). */
export function stripRoot(relativePath) {
  const parts = String(relativePath ?? '').split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : parts[0];
}

/* Splits records { path, name, ... } into playable videos (natural path order) and subtitle files.
 * `isPlayable(record)` decides what plays (the engine's extension list); hidden paths are dropped. */
export function classify(records, isPlayable) {
  const videos = [];
  const subtitles = [];
  for (const record of records) {
    const path = String(record.path || record.name || '');
    if (path.split('/').some(isHiddenName)) continue;
    if (isSubtitleName(path)) subtitles.push(record);
    else if (isPlayable(record)) videos.push(record);
  }
  const byPath = (l, r) => comparePaths(l.path || l.name, r.path || r.name);
  return { videos: videos.sort(byPath), subtitles: subtitles.sort(byPath) };
}

/* True when a subtitle stem belongs to a video stem: equal, or the video stem followed by a
 * separator ("Episode 1.en", "Episode 1 - English"), so "Episode 10" never matches "Episode 1". */
export function stemMatches(subtitleStem, videoStem) {
  const sub = String(subtitleStem).toLowerCase();
  const video = String(videoStem).toLowerCase();
  return sub === video || (sub.startsWith(video) && /^[\s._-]/.test(sub.slice(video.length)));
}

/* Subtitle files for the video at `videoPath`: files in the same folder whose name matches the
 * video's stem. When the video is the only one in its folder (a film folder with "English.srt"),
 * every subtitle file in that folder belongs to it, matching names first. */
export function siblingsFor(videoPath, subtitles, { soleVideo = false } = {}) {
  const dir = dirOf(videoPath);
  const stem = stemOf(videoPath);
  const same = subtitles.filter(sub => dirOf(sub.path || sub.name) === dir);
  const matched = same.filter(sub => stemMatches(stemOf(sub.path || sub.name), stem));
  if (!soleVideo) return matched;
  return [...matched, ...same.filter(sub => !matched.includes(sub))];
}

/* Number of videos per folder, for siblingsFor's soleVideo rule. */
export function videosPerFolder(videos) {
  const counts = new Map();
  for (const video of videos) {
    const dir = dirOf(video.path || video.name);
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  return counts;
}

/* Deterministic generator so a shuffle can be replayed in tests (mulberry32). */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function identity(length) {
  return Array.from({ length }, (_, i) => i);
}

/* Play-order state. `order` lists item indices in play order; `pos` points into it.
 * Items are addressed by their natural-order index everywhere outside this module. */
export function createOrder(length, { current = 0, repeat = 'off', shuffle = false, random = Math.random } = {}) {
  const state = { length, order: identity(length), pos: 0, repeat: REPEAT_MODES.includes(repeat) ? repeat : 'off', shuffle: false };
  const start = length ? Math.max(0, Math.min(length - 1, current)) : 0;
  state.pos = start;
  return shuffle ? setShuffle(state, true, random) : state;
}

export function currentIndex(state) {
  return state.length ? state.order[state.pos] : null;
}

/* Turning shuffle on keeps the current item first and shuffles the rest once (Fisher-Yates), so
 * the order stays stable until shuffle is turned off. Turning it off returns to natural order. */
export function setShuffle(state, on, random = Math.random) {
  const current = currentIndex(state);
  if (!on) {
    return { ...state, shuffle: false, order: identity(state.length), pos: current ?? 0 };
  }
  const rest = identity(state.length).filter(i => i !== current);
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return { ...state, shuffle: true, order: current === null ? rest : [current, ...rest], pos: 0 };
}

export function setRepeat(state, mode) {
  return { ...state, repeat: REPEAT_MODES.includes(mode) ? mode : 'off' };
}

export function cycleRepeat(mode) {
  return REPEAT_MODES[(REPEAT_MODES.indexOf(mode) + 1) % REPEAT_MODES.length];
}

/* Moves to item `index` (natural order) without changing the play order. */
export function jumpTo(state, index) {
  const pos = state.order.indexOf(index);
  return pos < 0 ? state : { ...state, pos };
}

/* The state after "next", or null when the queue ends.
 * `auto` is true for the end-of-video advance: repeat one replays the same item then;
 * a person pressing next always moves on. */
export function next(state, { auto = false } = {}) {
  if (!state.length) return null;
  if (auto && state.repeat === 'one') return state;
  if (state.pos + 1 < state.length) return { ...state, pos: state.pos + 1 };
  if (state.repeat === 'all' || state.repeat === 'one') return { ...state, pos: 0 };
  return null;
}

/* The state after "previous", or null at the start of the queue (the caller restarts the item). */
export function previous(state) {
  if (!state.length) return null;
  if (state.pos > 0) return { ...state, pos: state.pos - 1 };
  if (state.repeat === 'all' || state.repeat === 'one') return { ...state, pos: state.length - 1 };
  return null;
}
