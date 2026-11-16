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
