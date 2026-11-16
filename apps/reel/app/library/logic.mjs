/* Reel library view: pure logic (watch state, poster time, grid keyboard moves). No DOM. */

export const WATCHED_FRACTION = 0.9;
export const POSTER_DIR = 'reel-posters';

/* Watch state from a resume entry { positionS, durationS } (the resume index, keyed by fingerprint).
 * `durationS` from the card wins when the entry has none. */
export function watchState(entry, durationS = null) {
  const total = Number(entry?.durationS) > 0 ? Number(entry.durationS) : Number(durationS) || 0;
  const position = Math.max(0, Number(entry?.positionS) || 0);
  if (!entry || !(total > 0) || position <= 0) return { state: 'new', fraction: 0, leftS: total || null };
  const fraction = Math.min(1, position / total);
  if (fraction >= WATCHED_FRACTION) return { state: 'watched', fraction, leftS: Math.max(0, total - position) };
  return { state: 'partial', fraction, leftS: total - position };
}

/* The poster frame: a tenth of the way in, at most 30 s, so title cards and black leaders are skipped. */
export function posterTime(durationS) {
  const total = Number(durationS);
  if (!(total > 0)) return 0;
  return Math.min(30, total * 0.1);
}

/* OPFS file name for a fingerprint ("123-abcd..." is already safe; anything else is reduced). */
export function posterName(fingerprint) {
  return `${String(fingerprint).replace(/[^a-zA-Z0-9_-]/g, '_')}.webp`;
}

/* Next focused card for a key in a grid of `count` cards laid out in `columns` columns.
 * Returns the same index when the move would leave the grid, or null for keys it does not handle. */
export function gridMove(index, key, count, columns) {
  if (!count) return null;
  const cols = Math.max(1, columns | 0);
  const last = count - 1;
  switch (key) {
    case 'ArrowRight': return Math.min(last, index + 1);
    case 'ArrowLeft': return Math.max(0, index - 1);
    case 'ArrowDown': return index + cols <= last ? index + cols : index;
    case 'ArrowUp': return index - cols >= 0 ? index - cols : index;
    case 'Home': return 0;
    case 'End': return last;
    default: return null;
  }
}

/* A file name Reel writes in reel-posters/ (posterName output). */
export function isPosterName(name) {
  return /^[a-zA-Z0-9_-]+\.webp$/.test(String(name));
}

/* The resume index keeps the newest RESUME_LIMIT entries (index.html Storage.upsertResume). */
export const RESUME_LIMIT = 100;
export const BOOKMARK_PREFIX = 'bookmarks:';

/* Which stored posters and bookmark records to prune. Pruning runs only once the resume index
 * is full, because only then has it dropped entries; a record is kept when its fingerprint is in
 * the index or in `keep` (the file open now and the library's cards). `entries` is the resume
 * index, `bookmarkKeys` the "bookmarks:<fingerprint>" keys, `posters` the poster file names.
 * Returns { bookmarkKeys, posters } to delete. */
export function pruneTargets({ entries, bookmarkKeys, posters, keep = [] }) {
  if (!Array.isArray(entries) || entries.length < RESUME_LIMIT) return { bookmarkKeys: [], posters: [] };
  const fingerprints = [...entries.map(entry => entry?.fingerprint), ...keep].filter(Boolean);
  const keptKeys = new Set(fingerprints.map(fp => `${BOOKMARK_PREFIX}${fp}`));
  const keptPosters = new Set(fingerprints.map(posterName));
  return {
    bookmarkKeys: bookmarkKeys.filter(key => key.startsWith(BOOKMARK_PREFIX) && !keptKeys.has(key)),
    posters: posters.filter(name => isPosterName(name) && !keptPosters.has(name)),
  };
}
