// Fuzzy search over the library index.
//
// Subsequence matching, ranked: your query's characters need only appear in
// order, not adjacently, so "skr" and "saku" both find "Sakura". Ranking
// rewards contiguous runs, word-start hits, and early matches, so the exact
// title you meant comes first rather than merely appearing somewhere.
//
// Headless by contract: no DOM, no network.

/**
 * Score `query` against `text`.
 * Returns null when the query is not a subsequence of the text, otherwise a
 * number where higher is better.
 */
export function fuzzyScore(query, text) {
  const needle = String(query ?? '').toLowerCase().trim();
  const haystack = String(text ?? '').toLowerCase();
  if (!needle) return 0;
  if (!haystack) return null;

  let score = 0;
  let cursor = 0;
  let run = 0;

  for (const character of needle) {
    if (character === ' ') continue;
    const index = haystack.indexOf(character, cursor);
    if (index === -1) return null;

    if (index === cursor && cursor > 0) {
      // Contiguous with the previous hit: the strongest signal, and it
      // compounds so a long exact run beats several scattered letters.
      run += 1;
      score += 8 + run * 4;
    } else {
      run = 0;
      score += 1;
      const previous = index === 0 ? ' ' : haystack[index - 1];
      if (index === 0) score += 10;
      else if (previous === ' ' || previous === '-' || previous === '_') score += 6;
    }
    // Earlier matches rank higher, but never enough to overturn a real run.
    score += Math.max(0, 4 - Math.floor(index / 8));
    cursor = index + 1;
  }

  // A short field that matched is a better hit than a long one that also did.
  return score + Math.max(0, 12 - Math.floor(haystack.length / 6));
}

/** The fields a track is matched on, most significant first. */
const FIELDS = Object.freeze([
  ['title', 1],
  ['artist', 0.9],
  ['album', 0.85],
  ['albumArtist', 0.7],
  ['name', 0.6],
  ['genre', 0.4],
]);

/**
 * Rank `tracks` against `query`.
 * An empty query returns everything in its incoming order, which is what makes
 * the search box safe to leave empty.
 */
export function searchTracks(tracks, query) {
  const needle = String(query ?? '').trim();
  if (!needle) return [...tracks];

  const scored = [];
  for (const track of tracks) {
    let best = null;
    for (const [field, weight] of FIELDS) {
      const score = fuzzyScore(needle, track[field]);
      if (score === null) continue;
      const weighted = score * weight;
      if (best === null || weighted > best) best = weighted;
    }
    if (best !== null) scored.push({ track, score: best });
  }

  return scored
    .sort((left, right) => right.score - left.score
      || String(left.track.title ?? '').localeCompare(String(right.track.title ?? '')))
    .map(entry => entry.track);
}
