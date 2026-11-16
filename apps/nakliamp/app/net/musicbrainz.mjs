// musicbrainz.mjs — tags and front covers from MusicBrainz and the Cover Art Archive (T8).
//
// Opt-in network: every request goes through `consentedFetch`, so nothing leaves the
// page until the person turns MusicBrainz (and, for covers, the Cover Art Archive) on.
// What is sent: the artist, album and title text searched for, and a release id.
// Never audio, never a file path.
//
// MusicBrainz asks clients for a descriptive User-Agent and at most one request per
// second. A browser cannot set User-Agent, so every request asks for `fmt=json` and goes
// through one queue that starts requests at least `intervalMs` apart. The queue holds a
// Web Lock while a request and its interval run, so two NakliAmp tabs share one rate. A
// 503 or 429 (the rate limiter's answer) is reported as `rate-limited` and pauses the
// queue for the server's Retry-After, or `MB_PAUSE_MS` when it sends none.
//
// The output is a patch in the shape app/tags/write.mjs takes; the UI shows it as a
// destructive, approved edit through `track.edit_tags`. Headless: no DOM.

import { consentedFetch } from './consent.mjs';

export const MB_ORIGIN = 'https://musicbrainz.org';
export const CAA_ORIGIN = 'https://coverartarchive.org';
export const MB_INTERVAL_MS = 1000;
export const MB_PAUSE_MS = 5000;
export const MB_MAX_PAUSE_MS = 60_000;
export const MB_LOCK_NAME = 'nakliamp:musicbrainz';
export const MAX_COVER_BYTES = 8 * 1024 * 1024;

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isMbid = s => MBID.test(String(s ?? ''));

export class MusicBrainzError extends Error {
  /** `code`: bad-input, not-found, rate-limited, http, bad-reply, too-large. */
  constructor(code, message, status = null) {
    super(`[${code}] ${message}`);
    this.name = 'MusicBrainzError';
    this.code = code;
    this.status = status;
  }
}

/**
 * A queue that starts each task at least `intervalMs` after the previous one started,
 * one at a time, in order. `enqueue.pause(ms)` holds every later start for `ms`.
 *
 * With `locks` (the Web Locks API; `navigator.locks` by default) each task runs inside the
 * lock `lockName`, and the lock is released only when the interval, and any pause, has
 * passed. Every page on the origin that uses the same lock name then shares one rate.
 * The task's result is returned as soon as the task settles. `sleep`, `now` and `locks`
 * are injectable for tests.
 */
export function createRateQueue({
  intervalMs = MB_INTERVAL_MS, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)),
  locks = globalThis.navigator?.locks ?? null, lockName = MB_LOCK_NAME,
} = {}) {
  let tail = Promise.resolve();
  let lastStart = -Infinity;
  let pausedUntil = -Infinity;
  const readyAt = () => Math.max(lastStart + intervalMs, pausedUntil);

  async function start(task) {
    const wait = readyAt() - now();
    if (wait > 0) await sleep(wait);
    lastStart = now();
    return task();
  }

  // Run inside the shared lock; settle the caller on the task, release after the interval.
  function locked(task) {
    return new Promise((resolve, reject) => {
      locks.request(lockName, async () => {
        const run = start(task);
        run.then(resolve, reject);
        await run.catch(() => {});
        const rest = readyAt() - now();
        if (rest > 0) await sleep(rest);
      }).catch(reject);
    });
  }

  function enqueue(task) {
    const run = tail.then(() => (locks && typeof locks.request === 'function' ? locked(task) : start(task)));
    tail = run.catch(() => {});
    return run;
  }
  enqueue.pause = ms => { pausedUntil = Math.max(pausedUntil, now() + Math.max(0, Number(ms) || 0)); };
  return enqueue;
}

/** How long to pause after a 503 or 429: the Retry-After seconds, capped, or the default. */
export function retryAfterMs(res) {
  const seconds = Number(String(res?.headers?.get?.('retry-after') ?? '').trim());
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(MB_MAX_PAUSE_MS, seconds * 1000);
  return MB_PAUSE_MS;
}

// Discard a body NakliAmp will not use; a failed cancel changes nothing.
async function discard(target) {
  try { await target?.cancel?.(); } catch { /* the body is discarded either way */ }
}

// Concatenate the chunks read from a body.
function joined(chunks, total) {
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return bytes;
}

// Read a body stream, stopping as soon as it passes `max`.
async function readStreamCapped(reader, max, tooLarge) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return joined(chunks, total);
    total += value.byteLength;
    if (total > max) { await discard(reader); throw tooLarge(); }
    chunks.push(value);
  }
}

/**
 * The response body as bytes, refusing past `max`: by `content-length` before reading,
 * and by a running count while reading, so an oversized body is never held whole.
 */
export async function readCapped(res, max, tooLarge) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > max) { await discard(res.body); throw tooLarge(); }
  const reader = res.body?.getReader?.();
  if (reader) return readStreamCapped(reader, max, tooLarge);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > max) throw tooLarge();
  return bytes;
}

// Lucene query term: quoted phrase with quotes and backslashes escaped.
const phrase = s => `"${String(s).replace(/[\\"]/g, m => `\\${m}`).replace(/\s+/g, ' ').trim()}"`;
// oxlint-disable-next-line no-control-regex -- matching C0 controls is the point: text from tags and servers is sanitised
const CONTROL_RUN = /[\u0000-\u001F\u007F]+/g;
const clean = s => String(s ?? '').replace(CONTROL_RUN, ' ').trim().slice(0, 200);
const credit = list => (Array.isArray(list) ? list.map(c => `${c?.name ?? c?.artist?.name ?? ''}${c?.joinphrase ?? ''}`).join('').trim() : '');
const yearOf = date => { const m = /^(\d{4})/.exec(String(date ?? '')); return m ? Number(m[1]) : null; };

/** Search results reduced to what a picker shows. */
export function summariseReleases(json) {
  const list = Array.isArray(json?.releases) ? json.releases : [];
  return list.filter(r => isMbid(r?.id)).map(r => ({
    mbid: r.id,
    title: r.title ?? '',
    artist: credit(r['artist-credit']),
    date: r.date ?? null,
    year: yearOf(r.date),
    country: r.country ?? null,
    trackCount: Number(r['track-count']) || (Array.isArray(r.media) ? r.media.reduce((n, m) => n + (Number(m['track-count']) || 0), 0) : null),
    score: Number(r.score) || 0,
  }));
}

function topGenre(release) {
  const pool = [
    ...(release?.genres ?? []), ...(release?.['release-group']?.genres ?? []),
  ].filter(g => g && typeof g.name === 'string');
  if (!pool.length) return null;
  const byName = new Map();
  for (const g of pool) byName.set(g.name, (byName.get(g.name) ?? 0) + (Number(g.count) || 1));
  const [name] = [...byName.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return name.replace(/\b\p{L}/gu, c => c.toUpperCase());
}

const norm = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The tag patch for one local track from a full release (`getRelease`). The track is
 * matched by disc and track number when both exist, else by title. Returns
 * `{ patch, matched: 'number'|'title'|'album-only' }`; with no match the patch carries
 * only album-level fields.
 */
export function releaseToPatch(release, track = {}) {
  if (!release || typeof release !== 'object') throw new MusicBrainzError('bad-reply', 'The release has no data.');
  const media = Array.isArray(release.media) ? release.media : [];
  const albumArtist = credit(release['artist-credit']);
  const patch = albumPatch(release, media, albumArtist);
  const trackNo = Number(track.trackNo) || 0;
  const { hit, matched } = matchTrack(media, track, trackNo);
  if (hit) Object.assign(patch, trackPatch(hit, albumArtist, trackNo));
  return { patch, matched };
}

// Album-level fields: album, album artist, year, genre and disc count.
function albumPatch(release, media, albumArtist) {
  const patch = {};
  if (release.title) patch.album = clean(release.title);
  if (albumArtist) patch.albumArtist = clean(albumArtist);
  const year = yearOf(release.date) ?? yearOf(release['release-group']?.['first-release-date']);
  if (year) patch.year = year;
  const genre = topGenre(release);
  if (genre) patch.genre = genre;
  if (media.length) patch.discTotal = media.length;
  return patch;
}

// The release track for a local track: by disc and track number, else by title.
function matchTrack(media, track, trackNo) {
  const byNumber = trackNo ? matchByNumber(media, Number(track.discNo) || (media.length === 1 ? 1 : 0), trackNo) : null;
  if (byNumber) return { hit: byNumber, matched: 'number' };
  const byTitle = track.title ? matchByTitle(media, norm(track.title)) : null;
  if (byTitle) return { hit: byTitle, matched: 'title' };
  return { hit: null, matched: 'album-only' };
}

function matchByNumber(media, discNo, trackNo) {
  const medium = media.find(m => Number(m.position) === discNo) ?? (media.length === 1 ? media[0] : null);
  const t = medium?.tracks?.find(x => Number(x.position) === trackNo || Number(x.number) === trackNo);
  return t ? { medium, t } : null;
}

function matchByTitle(media, want) {
  for (const medium of media) {
    const t = medium.tracks?.find(x => norm(x.title ?? x.recording?.title) === want);
    if (t) return { medium, t };
  }
  return null;
}

// Track-level fields from the matched release track.
function trackPatch({ medium, t }, albumArtist, trackNo) {
  const patch = { title: clean(t.title ?? t.recording?.title) };
  const artist = credit(t['artist-credit'] ?? t.recording?.['artist-credit']) || albumArtist;
  if (artist) patch.artist = clean(artist);
  patch.trackNo = Number(t.position) || trackNo;
  patch.trackTotal = Number(medium['track-count']) || medium.tracks.length;
  patch.discNo = Number(medium.position) || 1;
  return patch;
}

// The cover's media type from the response; JPEG when the server sends none.
const coverMime = res => String(res.headers?.get?.('content-type') ?? '').split(';')[0].trim() || 'image/jpeg';

/**
 * `createMusicBrainz({ fetch, consent, sleep, now, locks, intervalMs })`.
 * `fetch` is injected (window.fetch in the page, a stub in tests).
 */
export function createMusicBrainz({ fetch: fetchFn, consent, sleep, now, locks, intervalMs = MB_INTERVAL_MS } = {}) {
  const get = consentedFetch(fetchFn, consent);
  const queue = createRateQueue({ intervalMs, sleep, now, ...(locks === undefined ? {} : { locks }) });

  async function getJson(path, params) {
    const url = new URL(path, MB_ORIGIN);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('fmt', 'json');
    consent.assertAllowed(url); // refuse before queueing, so a refusal never waits a second
    const res = await queue(async () => {
      const answer = await get(url, { headers: { Accept: 'application/json' } });
      if (answer.status === 503 || answer.status === 429) queue.pause(retryAfterMs(answer));
      return answer;
    });
    if (res.status === 404) throw new MusicBrainzError('not-found', 'MusicBrainz has no such release.', 404);
    if (res.status === 503 || res.status === 429) throw new MusicBrainzError('rate-limited', 'MusicBrainz asked NakliAmp to slow down. Try again in a few seconds.', res.status);
    if (!res.ok) throw new MusicBrainzError('http', `MusicBrainz answered ${res.status}.`, res.status);
    try { return await res.json(); } catch { throw new MusicBrainzError('bad-reply', 'MusicBrainz sent something other than JSON.'); }
  }

  return {
    /** Releases matching an album and artist, best first: `[{ mbid, title, artist, year, trackCount, score }]`. */
    async searchRelease({ artist, album, limit = 5 } = {}) {
      const a = clean(artist); const b = clean(album);
      if (!b) throw new MusicBrainzError('bad-input', 'Give an album name to search for.');
      const query = a ? `release:${phrase(b)} AND artist:${phrase(a)}` : `release:${phrase(b)}`;
      const json = await getJson('/ws/2/release/', { query, limit: String(Math.max(1, Math.min(25, Math.floor(limit) || 5))) });
      return summariseReleases(json);
    },
    /** One release with its tracks, artist credits, genres and release group. */
    async getRelease(mbid) {
      if (!isMbid(mbid)) throw new MusicBrainzError('bad-input', `${String(mbid)} is not a MusicBrainz release id.`);
      return getJson(`/ws/2/release/${mbid.toLowerCase()}`, { inc: 'recordings artist-credits genres release-groups' });
    },
    /** Patches for local tracks: `[{ trackId, patch, matched }]`. */
    async patchesFor(mbid, tracks = []) {
      const release = await this.getRelease(mbid);
      return tracks.map(t => ({ trackId: t.id, ...releaseToPatch(release, t) }));
    },
    /**
     * The front cover as `{ mime, bytes }` (the `picture` field of a tag patch), or
     * null when the release has none. `size` is 250, 500 or 1200.
     */
    async fetchFrontCover(mbid, { size = 500 } = {}) {
      if (!isMbid(mbid)) throw new MusicBrainzError('bad-input', `${String(mbid)} is not a MusicBrainz release id.`);
      const px = [250, 500, 1200].includes(size) ? size : 500;
      const url = `${CAA_ORIGIN}/release/${mbid.toLowerCase()}/front-${px}`;
      const res = await get(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new MusicBrainzError('http', `The Cover Art Archive answered ${res.status}.`, res.status);
      const mime = coverMime(res);
      if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) throw new MusicBrainzError('bad-reply', `The cover is ${mime}, not an image NakliAmp writes into tags.`);
      const bytes = await readCapped(res, MAX_COVER_BYTES, () => new MusicBrainzError('too-large', 'The cover is larger than 8 MB.'));
      return { mime, bytes };
    },
  };
}
