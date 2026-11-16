// lrclib.mjs — lyrics from LRCLIB for tracks that carry none (T9).
//
// Opt-in network through `consentedFetch`. One GET to /api/get with the track title,
// artist, album and length in whole seconds; nothing else is sent. LRCLIB matches on
// length within a couple of seconds, so a track with no known length is refused here
// rather than sent as a looser search.
//
// The result is parsed with the library's LRC parser, and `sidecarPlan` says which
// `.lrc` file to write beside the track. The shell writes it (it holds the folder
// handle), so this module never touches the file system. Headless: no DOM.

import { consentedFetch } from './consent.mjs';
import { parseLrc, sidecarNameFor } from '../library/lyrics.mjs';

export const LRCLIB_ORIGIN = 'https://lrclib.net';
export const MAX_LYRICS_CHARS = 200_000;

export class LrclibError extends Error {
  /** `code`: bad-input, http, bad-reply. */
  constructor(code, message, status = null) {
    super(`[${code}] ${message}`);
    this.name = 'LrclibError';
    this.code = code;
    this.status = status;
  }
}

// oxlint-disable-next-line no-control-regex -- matching C0 controls is the point: text from tags and servers is sanitised
const CONTROL_RUN = /[\u0000-\u001F\u007F]+/g;
const clean = s => String(s ?? '').replace(CONTROL_RUN, ' ').trim().slice(0, 300);

/** The /api/get URL for a track, or a LrclibError('bad-input'). */
export function lyricsUrl({ title, artist, album, durationS } = {}) {
  const t = clean(title); const a = clean(artist);
  if (!t || !a) throw new LrclibError('bad-input', 'LRCLIB needs a title and an artist.');
  const d = Math.round(Number(durationS));
  if (!Number.isFinite(d) || d <= 0) throw new LrclibError('bad-input', 'LRCLIB needs the track length; this track has none yet.');
  const url = new URL('/api/get', LRCLIB_ORIGIN);
  url.searchParams.set('track_name', t);
  url.searchParams.set('artist_name', a);
  url.searchParams.set('album_name', clean(album));
  url.searchParams.set('duration', String(d));
  return url;
}

/**
 * Read an /api/get reply. Returns
 * `{ synced, text, lines, offsetS, instrumental, source: 'lrclib', id }` or null.
 * Synced lyrics win over plain ones.
 */
export function readLrclibReply(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.instrumental === true) return { synced: false, text: '', lines: [], offsetS: 0, instrumental: true, source: 'lrclib', id: json.id ?? null };
  const syncedText = typeof json.syncedLyrics === 'string' ? json.syncedLyrics.slice(0, MAX_LYRICS_CHARS) : '';
  const plainText = typeof json.plainLyrics === 'string' ? json.plainLyrics.slice(0, MAX_LYRICS_CHARS) : '';
  for (const text of [syncedText, plainText]) {
    if (!text.trim()) continue;
    const parsed = parseLrc(text);
    if (parsed.lines.some(l => l.text)) {
      return { synced: parsed.synced, text, lines: parsed.lines, offsetS: parsed.offsetS ?? 0, instrumental: false, source: 'lrclib', id: json.id ?? null };
    }
  }
  return null;
}

/**
 * The sidecar the shell writes: `{ name, text }`, where `name` is the track's file
 * name with `.lrc`. Null when there is nothing to save (instrumental or empty).
 */
export function sidecarPlan(trackFileName, result) {
  if (!result || result.instrumental || !String(result.text ?? '').trim()) return null;
  const base = String(trackFileName ?? '').split('/').pop();
  if (!base) return null;
  const text = result.text.endsWith('\n') ? result.text : `${result.text}\n`;
  return { name: sidecarNameFor(base), text };
}

/** `createLrclib({ fetch, consent })` → `{ getLyrics(track) }`. */
export function createLrclib({ fetch: fetchFn, consent } = {}) {
  const get = consentedFetch(fetchFn, consent);
  return {
    /** `track`: `{ title, artist, album, durationS }`. Null when LRCLIB has no lyrics for it. */
    async getLyrics(track) {
      const url = lyricsUrl(track);
      const res = await get(url, { headers: { Accept: 'application/json' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new LrclibError('http', `LRCLIB answered ${res.status}.`, res.status);
      let json;
      try { json = await res.json(); } catch { throw new LrclibError('bad-reply', 'LRCLIB sent something other than JSON.'); }
      return readLrclibReply(json);
    },
  };
}
