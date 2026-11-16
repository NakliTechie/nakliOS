// similar.mjs — "more like this": extend the queue from the playing track (Q2).
//
// The same pipeline as AI playlists (playlist.mjs): filter the library first, then let
// the model rerank only those candidates. Candidates come from the seed track's tags, in
// tiers: same artist, same album artist, same genre, same decade, then the most-played
// tracks of the genre's neighbours. Tracks already in the queue, and the seed itself,
// are never offered. Without a model the tag tiers are the answer, with at most two
// tracks from any one album so the extension is not one album played again.
//
// The model sees the candidate table and a description built from the seed's tags; it
// answers `{"title": ..., "ids": [...]}` as plain JSON, parsed by playlist.mjs's parser.
// Headless: no DOM, no network; `chat` is injected (host `aiChat`).

import { buildPrompt, requestBody, parsePlaylistReply } from './playlist.mjs';

export const DEFAULT_CANDIDATES = 80;
export const DEFAULT_LENGTH = 10;
export const PER_ALBUM_TAGS_ONLY = 2;
export const CALL_TIMEOUT_MS = 60_000;

export const SIMILAR_PATHS = Object.freeze({
  model: 'model',
  tags: 'tags-only',
  failed: 'model-failed-then-tags',
});

const norm = s => String(s ?? '').toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
const decade = y => (Number.isFinite(y) && y > 0 ? Math.floor(y / 10) * 10 : null);
const albumKey = t => `${norm(t.albumArtist || t.artist)}\u001f${norm(t.album)}`;
const plays = t => Number(t.playCount) || 0;
const byPlays = (a, b) => plays(b) - plays(a) || String(a.title ?? '').localeCompare(String(b.title ?? '')) || String(a.id).localeCompare(String(b.id));

// Genre words that sit together, to widen "most played in genre" past an exact match.
const genreWords = g => new Set(norm(g).split(/[^\p{L}\p{N}&]+/u).filter(w => w.length > 2));
const genreNear = (a, b) => {
  if (!a || !b) return false;
  if (norm(a) === norm(b)) return true;
  const wa = genreWords(a);
  for (const w of genreWords(b)) if (wa.has(w)) return true;
  return false;
};

/**
 * Candidates for "more like" `seed`, best first, excluding `excludeIds` and the seed.
 * Returns `[{ id, trackId, artist, title, album, genre, year, via }]` with `id` 1..n
 * local to one request (the shape playlist.mjs's prompt and parser take).
 */
export function similarCandidates(seed, tracks, { excludeIds = [], limit = DEFAULT_CANDIDATES } = {}) {
  if (!seed) return [];
  const exclude = new Set([seed.id, ...excludeIds].map(String));
  const pool = (Array.isArray(tracks) ? tracks : []).filter(t => t && t.id != null && !exclude.has(String(t.id)));
  const picked = new Map();
  const add = (list, via) => { for (const t of [...list].sort(byPlays)) if (!picked.has(t.id)) picked.set(t.id, { t, via }); };

  addTiers(seed, pool, add);
  return [...picked.values()].slice(0, Math.max(0, limit)).map(({ t, via }, i) => candidateRow(t, via, i + 1));
}

// The candidate tiers, best first: artist, album artist, genre, decade, genre neighbours.
function addTiers(seed, pool, add) {
  const artist = norm(seed.artist); const albumArtist = norm(seed.albumArtist); const genre = norm(seed.genre);
  const dec = decade(Number(seed.year));
  if (artist) add(pool.filter(t => norm(t.artist) === artist || norm(t.albumArtist) === artist), 'same-artist');
  if (albumArtist && albumArtist !== artist) add(pool.filter(t => norm(t.albumArtist) === albumArtist || norm(t.artist) === albumArtist), 'same-album-artist');
  if (genre) add(pool.filter(t => norm(t.genre) === genre), 'same-genre');
  if (dec !== null) {
    const sameDecade = pool.filter(t => decade(Number(t.year)) === dec);
    // Same decade and a related genre first, then the rest of the decade.
    add(sameDecade.filter(t => genreNear(t.genre, seed.genre)), 'same-decade');
    if (!genre) add(sameDecade, 'same-decade');
  }
  if (genre) add(pool.filter(t => genreNear(t.genre, seed.genre) && plays(t) > 0), 'most-played-in-genre');
}

const candidateRow = (t, via, id) => ({
  id,
  trackId: t.id,
  artist: t.artist || t.albumArtist || null,
  title: t.title || t.name || null,
  album: t.album || null,
  genre: t.genre || null,
  year: Number.isFinite(t.year) ? t.year : null,
  via,
  albumKey: albumKey(t),
});

/** The tags-only answer: candidates in order, at most `perAlbum` from one album, then fill. */
export function pickByTags(candidates, length, { perAlbum = PER_ALBUM_TAGS_ONLY } = {}) {
  const out = []; const perKey = new Map(); const skipped = [];
  for (const c of candidates) {
    if (out.length >= length) break;
    const n = perKey.get(c.albumKey) ?? 0;
    if (n >= perAlbum) { skipped.push(c); continue; }
    perKey.set(c.albumKey, n + 1);
    out.push(c);
  }
  for (const c of skipped) { if (out.length >= length) break; out.push(c); }
  return out.map(c => c.trackId);
}

/** The description the model reads: the seed's tags, as data. */
export function seedDescription(seed) {
  const bits = [];
  if (seed?.title) bits.push(`"${String(seed.title).slice(0, 80)}"`);
  if (seed?.artist) bits.push(`by ${String(seed.artist).slice(0, 60)}`);
  const extra = [seed?.genre, Number.isFinite(seed?.year) ? String(seed.year) : null].filter(Boolean).join(', ');
  return `More tracks like ${bits.join(' ') || 'the playing track'}${extra ? ` (${extra})` : ''}. Similar sound and mood; vary the artists where the table allows.`;
}

function withTimeout(promise, ms, signal) {
  let timer; let onAbort;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The model did not answer within ${Math.round(ms / 1000)} seconds.`)), ms);
    if (signal) { onAbort = () => reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Cancelled.'), { name: 'AbortError' })); signal.addEventListener('abort', onAbort, { once: true }); }
  });
  return Promise.race([promise, limit]).finally(() => { clearTimeout(timer); if (onAbort) signal.removeEventListener('abort', onAbort); });
}

/**
 * Extend the queue from `seed`. Returns
 * `{ path, trackIds, candidateCount, title, error }`; `trackIds` exclude the seed and
 * `queuedIds`. Cancelling through `signal` rejects.
 */
export async function moreLikeThis({ seed, tracks, queuedIds = [], chat = null, length = DEFAULT_LENGTH, signal, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  if (!seed || seed.id == null) throw new Error('Play a track first: "more like this" starts from the playing track.');
  const want = Math.max(1, Math.min(100, Math.floor(Number(length) || DEFAULT_LENGTH)));
  const candidates = similarCandidates(seed, tracks, { excludeIds: queuedIds });
  const base = { candidateCount: candidates.length, title: `More like ${seed.title || 'this'}`.slice(0, 80), error: null };
  const tagsOnly = (path, error = null) => ({ ...base, path, trackIds: pickByTags(candidates, want), error });
  if (typeof chat !== 'function' || candidates.length === 0) return tagsOnly(SIMILAR_PATHS.tags);
  throwIfAborted(signal);
  return askModel({ seed, candidates, want, base, tagsOnly, chat, signal, timeoutMs });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Cancelled.'), { name: 'AbortError' });
}

// The model pass; a short or failed answer falls back to the tag tiers.
async function askModel({ seed, candidates, want, base, tagsOnly, chat, signal, timeoutMs }) {
  const { messages, used } = buildPrompt(seedDescription(seed), candidates, { length: want });
  try {
    const reply = await withTimeout(Promise.resolve().then(() => chat({ ...requestBody(messages, { length: want }), signal })), timeoutMs, signal);
    const parsed = parsePlaylistReply(reply, used);
    if (parsed.trackIds.length >= Math.ceil(Math.min(want, used.length) / 2)) {
      return { ...base, path: SIMILAR_PATHS.model, trackIds: parsed.trackIds.slice(0, want), title: parsed.title || base.title };
    }
    return tagsOnly(SIMILAR_PATHS.failed, parsed.error ?? `The model returned ${parsed.trackIds.length} usable tracks.`);
  } catch (error) {
    if (signal?.aborted) throw error;
    return tagsOnly(SIMILAR_PATHS.failed, String(error?.message || error));
  }
}
