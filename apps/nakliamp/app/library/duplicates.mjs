// Duplicate finder (parity row L14). An index query only: no file is read.
//
// Two kinds of group:
// - exact: same byte size and same duration. Almost certainly one file
//   copied twice, whatever its tags say.
// - likely: same artist and title after normalising, durations within the
//   tolerance (2 s by default). The same recording ripped or bought twice.
//
// A likely group whose tracks are all inside one exact group adds nothing and
// is dropped. Cue-sheet virtual tracks share their parent's size, so they
// never form exact groups; parent images a sheet replaced are skipped.
//
// Headless and pure.

export const DEFAULT_TOLERANCE_S = 2;

/** Fold text for comparison: no accents, no case, no punctuation, one space. */
export function normaliseForMatch(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const durationOf = track => (Number.isFinite(track.durationS) ? track.durationS : null);

/**
 * Split tracks sorted by duration into clusters where every member is within
 * `toleranceS` of the cluster's first (shortest) track. Anchoring on the first
 * keeps a long chain of near-equal durations from joining 3:00 to 3:10.
 */
function clusterByDuration(tracks, toleranceS) {
  const sorted = [...tracks].sort((a, b) => a.durationS - b.durationS);
  const clusters = [];
  let current = [];
  for (const track of sorted) {
    if (current.length && track.durationS - current[0].durationS > toleranceS) {
      clusters.push(current);
      current = [];
    }
    current.push(track);
  }
  if (current.length) clusters.push(current);
  return clusters.filter(cluster => cluster.length > 1);
}

/**
 * The track to keep in a group: the one you have used most (play count,
 * then rating, then favourite), then the larger file (often the better
 * encode), then the shorter path. A suggestion only; nothing is deleted here.
 */
export function suggestKeep(tracks) {
  return [...tracks].sort(compareKeep)[0];
}

/** Higher play count, rating, favourite and size first; numeric fields default to 0. */
const KEEP_FIELDS = ['playCount', 'rating', 'bookmarked', 'size'];

function compareKeep(a, b) {
  for (const field of KEEP_FIELDS) {
    const difference = (b[field] ?? 0) - (a[field] ?? 0);
    if (difference) return difference;
  }
  return String(a.path).length - String(b.path).length
    || (String(a.path) < String(b.path) ? -1 : 1);
}

/**
 * Find duplicate groups.
 * Returns `[{ kind: 'exact'|'likely', key, ids, keepId }]`, exact groups
 * first, then likely ones, each sorted by key. `ids` are in path order.
 */
/** Exact copies: same size and duration (to 0.01 s). Virtual cue tracks share a file, so they are skipped. */
function exactBucketsOf(eligible) {
  const buckets = new Map();
  for (const track of eligible) {
    if (track.virtual || !Number.isFinite(track.size) || track.size <= 0) continue;
    const key = `${track.size}|${track.durationS.toFixed(2)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(track);
  }
  return buckets;
}

/** Likely copies: same normalised artist and title. */
function tagBucketsOf(eligible) {
  const buckets = new Map();
  for (const track of eligible) {
    const artist = normaliseForMatch(track.artist || track.albumArtist);
    const title = normaliseForMatch(track.title);
    if (!artist || !title) continue; // untagged files would all match each other
    const key = `${artist}|${title}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(track);
  }
  return buckets;
}

const compareKeys = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function findDuplicates(tracks, { toleranceS = DEFAULT_TOLERANCE_S } = {}) {
  const eligible = tracks.filter(track => !track.hidden && durationOf(track) !== null);
  const groups = [];

  const exactOf = new Map();
  for (const [key, members] of exactBucketsOf(eligible)) {
    if (members.length < 2) continue;
    groups.push(makeGroup('exact', key, members));
    for (const track of members) exactOf.set(track.id, key);
  }

  for (const [key, members] of tagBucketsOf(eligible)) {
    for (const cluster of clusterByDuration(members, toleranceS)) {
      const exactKeys = new Set(cluster.map(track => exactOf.get(track.id)));
      if (exactKeys.size === 1 && !exactKeys.has(undefined)) continue;
      groups.push(makeGroup('likely', key, cluster));
    }
  }

  const rank = { exact: 0, likely: 1 };
  return groups.sort((a, b) => rank[a.kind] - rank[b.kind] || compareKeys(a.key, b.key));
}

function makeGroup(kind, key, members) {
  const ordered = [...members].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { kind, key, ids: ordered.map(track => track.id), keepId: suggestKeep(ordered).id };
}
