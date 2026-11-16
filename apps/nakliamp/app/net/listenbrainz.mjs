// listenbrainz.mjs — scrobbling to ListenBrainz with the person's own token (I1).
//
// Opt-in network through `consentedFetch`: nothing is sent until the person turns
// ListenBrainz on and pastes the user token from their ListenBrainz settings page. The
// token goes only to api.listenbrainz.org, in the Authorization header. No app secret
// exists, so no server is needed (Last.fm would need one to sign requests).
//
// The scrobble rule: a track longer than 30 seconds counts once it has played for half
// its length or 4 minutes, whichever comes first. Seeking does not count as playing.
//
// Listens wait in a queue in localStorage (`nakliamp:listenbrainz`) that survives
// restarts. The queue keeps at most `QUEUE_MAX` listens (about 400 bytes each), so it
// stays well inside the browser's per-origin storage, which other apps on the origin
// share. A save that fails (storage full or blocked) is reported by `saveError()` and by
// `saved: false` on every result, so the page can tell the person that queued listens
// last only until reload. `flush()` sends them oldest first: one listen as `single`, more as `import`
// in batches of up to 50. A network failure, a 429 or a 5xx stops the flush and sets a
// backoff (30 s doubling to 1 hour, or the server's Retry-After when longer). A 401
// keeps the queue and reports the token as rejected. A 400 on a batch resends that
// batch one listen at a time, and a single listen the server still refuses is set aside
// in `rejected`, so one bad listen never blocks the rest. Headless: no DOM.
//
// The token is not part of the stored queue (N15): other apps on a shared origin can read
// localStorage. It lives in `tokenStore` (`get()`, `set(token)`), which the page backs with
// the sealed vault (app/net/vault.mjs); by default it lasts for this page only. A token an
// older version left in the queue record moves into the token store and out of storage.

import { consentedFetch } from './consent.mjs';

export const LB_ORIGIN = 'https://api.listenbrainz.org';
export const LB_KEY = 'nakliamp:listenbrainz';
export const BATCH_MAX = 50;
export const MIN_TRACK_S = 30;
export const MAX_THRESHOLD_S = 240;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 60 * 60 * 1000;
export const QUEUE_MAX = 2_000;
export const REJECTED_MAX = 50;
export const CLIENT_NAME = 'NakliAmp';

export class ListenBrainzError extends Error {
  /** `code`: no-token, bad-token, bad-input, http, bad-reply. */
  constructor(code, message, status = null) {
    super(`[${code}] ${message}`);
    this.name = 'ListenBrainzError';
    this.code = code;
    this.status = status;
  }
}

/** True when a play of `playedS` seconds of a `durationS`-second track counts as a listen. */
export function shouldScrobble({ durationS, playedS }) {
  const d = Number(durationS); const p = Number(playedS);
  if (!(d > MIN_TRACK_S) || !(p > 0)) return false;
  return p >= Math.min(d / 2, MAX_THRESHOLD_S);
}

/** Seconds of play a track needs before it counts, or null when it never counts. */
export function scrobbleThresholdS(durationS) {
  const d = Number(durationS);
  return d > MIN_TRACK_S ? Math.min(d / 2, MAX_THRESHOLD_S) : null;
}

// oxlint-disable-next-line no-control-regex -- matching C0 controls is the point: tag text is sanitised before it is sent
const CONTROL_RUN = /[\u0000-\u001F\u007F]+/g;
const text = (s, max = 512) => String(s ?? '').replace(CONTROL_RUN, ' ').trim().slice(0, max);
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A ListenBrainz listen from a track record. Sends artist, title, album, track number
 * and length; never the file path. `listenedAt` is Unix seconds (omit for playing_now).
 */
export function makeListen(track, listenedAt, { clientVersion = '' } = {}) {
  const { artist, title } = listenNames(track);
  if (!artist || !title) throw new ListenBrainzError('bad-input', 'A listen needs an artist and a title; this track has no tags for them.');
  const metadata = { artist_name: artist, track_name: title, additional_info: additionalInfo(track, clientVersion) };
  const album = text(track?.album);
  if (album) metadata.release_name = album;
  const listen = { track_metadata: metadata };
  if (listenedAt != null) listen.listened_at = Math.floor(Number(listenedAt));
  return listen;
}

const listenNames = track => ({ artist: text(track?.artist || track?.albumArtist), title: text(track?.title || track?.name) });

// The listen's additional_info: client name and version, length, track number, release id.
function additionalInfo(track, clientVersion) {
  const info = { media_player: CLIENT_NAME, submission_client: CLIENT_NAME };
  if (clientVersion) { info.media_player_version = String(clientVersion); info.submission_client_version = String(clientVersion); }
  const dur = Number(track?.durationS);
  if (dur > 0) info.duration_ms = Math.round(dur * 1000);
  if (Number(track?.trackNo) > 0) info.tracknumber = Number(track.trackNo);
  if (MBID.test(String(track?.releaseMbid ?? ''))) info.release_mbid = track.releaseMbid;
  return info;
}

const isListen = l => l && typeof l === 'object' && Number.isInteger(l.listened_at) && l.track_metadata
  && typeof l.track_metadata.artist_name === 'string' && typeof l.track_metadata.track_name === 'string';

function readState(storage) {
  const empty = { queue: [], rejected: [], nextAttemptAt: 0, failures: 0, legacyToken: '' };
  try {
    const raw = storage?.getItem(LB_KEY);
    if (!raw) return empty;
    return stateFrom(JSON.parse(raw));
  } catch { return empty; }
}

// Stored state with every field checked; a wrong-typed field falls back to empty.
const stateFrom = s => ({
  legacyToken: typeof s?.token === 'string' ? s.token : '',
  queue: Array.isArray(s?.queue) ? s.queue.filter(isListen) : [],
  rejected: Array.isArray(s?.rejected) ? s.rejected.slice(-REJECTED_MAX) : [],
  nextAttemptAt: Number(s?.nextAttemptAt) || 0,
  failures: Number(s?.failures) || 0,
});

/** Backoff after `failures` failures in a row, at least the server's `retryAfterS`. */
export function backoffMs(failures, retryAfterS = 0) {
  const ours = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  const theirs = Number(retryAfterS) > 0 ? Math.min(BACKOFF_MAX_MS, Number(retryAfterS) * 1000) : 0;
  return Math.max(ours, theirs);
}

function retryAfterOf(res) {
  const h = name => res?.headers?.get?.(name);
  const s = Number(h('retry-after')) || Number(h('x-ratelimit-reset-in'));
  return Number.isFinite(s) && s > 0 ? s : 0;
}

/** A token holder that lasts for this page only. */
export function memoryTokenStore() {
  let token = '';
  return { get: () => token, set(value) { token = String(value ?? ''); } };
}

/**
 * `createListenBrainz({ fetch, consent, storage, tokenStore, now, clientVersion })`.
 * `now()` is milliseconds.
 */
export function createListenBrainz({ fetch: fetchFn, consent, storage = globalThis.localStorage, tokenStore = memoryTokenStore(), now = () => Date.now(), clientVersion = '' } = {}) {
  const get = consentedFetch(fetchFn, consent);
  const { legacyToken, ...stored } = readState(storage);
  let state = stored;
  const token = () => tokenStore.get() || '';
  let running = null;
  let singles = 0; // listens still to send one at a time after a 400 on a batch
  let saveError = null; // why the last save failed, or null when the stored copy is current

  // Store the state. On failure the queue lasts for this page only, and saveError says so.
  const save = () => {
    try {
      if (!storage) throw new Error('No storage is available.');
      storage.setItem(LB_KEY, JSON.stringify(state));
      saveError = null;
      return true;
    } catch (error) {
      saveError = { name: String(error?.name || 'Error'), message: String(error?.message || error), at: now(), queued: state.queue.length };
      return false;
    }
  };
  // A token stored by an older version moves to the token store and leaves localStorage.
  if (legacyToken) {
    if (!tokenStore.get()) tokenStore.set(legacyToken);
    save();
  }
  const auth = value => ({ Authorization: `Token ${value}` });

  async function post(listenType, payload) {
    return get(`${LB_ORIGIN}/1/submit-listens`, {
      method: 'POST',
      headers: { ...auth(token()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ listen_type: listenType, payload }),
    });
  }

  // A result to return before sending anything (empty queue, no token, backing off), or null.
  function flushBlocked(force, result) {
    if (!state.queue.length) return result;
    if (!token()) return { ...result, status: 'no-token' };
    consent.assertAllowed(LB_ORIGIN);
    if (!force && now() < state.nextAttemptAt) return { ...result, status: 'waiting', retryAt: state.nextAttemptAt };
    return null;
  }

  // The response to one batch, or null when the network failed.
  async function postBatch(batch) {
    try {
      return await post(batch.length === 1 ? 'single' : 'import', batch);
    } catch (error) {
      if (error?.name === 'NetworkConsentError') throw error;
      return null;
    }
  }

  function onSent(size, result) {
    state.queue = state.queue.slice(size);
    state.failures = 0; state.nextAttemptAt = 0;
    if (singles > 0) singles -= 1;
    result.sent += size;
    save();
  }

  // ListenBrainz refused one listen (400): keep it aside and move on.
  function onRejected(listen, result) {
    state.rejected = [...state.rejected, { listen, status: 400, at: now() }].slice(-REJECTED_MAX);
    state.queue = state.queue.slice(1);
    if (singles > 0) singles -= 1;
    result.rejected += 1;
    save();
  }

  function onFailure(res, result) {
    state.failures += 1;
    state.nextAttemptAt = now() + backoffMs(state.failures, retryAfterOf(res));
    save();
    return { ...result, remaining: state.queue.length, status: res ? `http-${res.status}` : 'offline', retryAt: state.nextAttemptAt };
  }

  async function flushOnce({ force }) {
    return { ...(await sendQueue({ force })), saved: saveError === null };
  }

  async function sendQueue({ force }) {
    const result = { sent: 0, rejected: 0, remaining: state.queue.length, status: 'idle', retryAt: null };
    const blocked = flushBlocked(force, result);
    if (blocked) return blocked;

    while (state.queue.length) {
      const size = singles > 0 ? 1 : Math.min(BATCH_MAX, state.queue.length);
      const batch = state.queue.slice(0, size);
      const res = await postBatch(batch);
      if (res?.ok) { onSent(size, result); continue; }
      if (res?.status === 401) {
        save();
        return { ...result, remaining: state.queue.length, status: 'bad-token' };
      }
      if (res?.status !== 400) return onFailure(res, result);
      if (size > 1) singles = size;
      else onRejected(batch[0], result);
    }
    return { ...result, remaining: 0, status: 'sent' };
  }

  const api = {
    token: () => token(),
    /** Store the token the person pasted. LB tokens are UUIDs; anything else is refused. */
    setToken(token) {
      const t = String(token ?? '').trim();
      if (!/^[A-Za-z0-9-]{8,128}$/.test(t)) throw new ListenBrainzError('bad-input', 'That does not look like a ListenBrainz user token. Copy it from listenbrainz.org, Settings.');
      tokenStore.set(t);
      state = { ...state, failures: 0, nextAttemptAt: 0 };
      save();
    },
    clearToken() { tokenStore.set(''); },
    queued: () => state.queue.slice(),
    /** `{ name, message, at, queued }` when the last save failed, else null. */
    saveError: () => (saveError ? { ...saveError } : null),
    rejected: () => state.rejected.slice(),
    nextAttemptAt: () => state.nextAttemptAt,

    /** `{ valid, userName }` for a token (the stored one by default). */
    async validateToken(candidate = token()) {
      if (!candidate) throw new ListenBrainzError('no-token', 'Paste your ListenBrainz user token first.');
      const res = await get(`${LB_ORIGIN}/1/validate-token`, { headers: auth(candidate) });
      if (res.status === 401) return { valid: false, userName: null };
      if (!res.ok) throw new ListenBrainzError('http', `ListenBrainz answered ${res.status}.`, res.status);
      let json;
      try { json = await res.json(); } catch { throw new ListenBrainzError('bad-reply', 'ListenBrainz sent something other than JSON.'); }
      return { valid: json?.valid === true, userName: typeof json?.user_name === 'string' ? json.user_name : null };
    },

    /**
     * Add a listen to the end of the persistent queue; the oldest are dropped past
     * `QUEUE_MAX`. Returns `{ queued, saved }`; `saved` is false when storage refused it.
     */
    enqueue(listen) {
      if (!isListen(listen)) throw new ListenBrainzError('bad-input', 'Not a listen: it needs listened_at, artist_name and track_name.');
      const queue = [...state.queue, listen];
      state = { ...state, queue: queue.length > QUEUE_MAX ? queue.slice(queue.length - QUEUE_MAX) : queue };
      return { queued: state.queue.length, saved: save() };
    },

    /** Add listens from an import (for example an older play history), oldest first. */
    enqueueAll(listens) { for (const l of listens) api.enqueue(l); },

    /**
     * Send the queue in order. Returns `{ sent, rejected, remaining, status, retryAt, saved }`;
     * `status` is idle, sent, waiting, no-token, bad-token, offline or http-<code>.
     * Concurrent calls share one run.
     */
    flush({ force = false } = {}) {
      if (!running) running = flushOnce({ force }).finally(() => { running = null; });
      return running;
    },

    /** Queue a listen and try to send it now. */
    async scrobble(listen) { api.enqueue(listen); return api.flush(); },

    /** Tell ListenBrainz what is playing now. Not queued: a failure is returned, not retried. */
    async nowPlaying(track) {
      if (!token()) return { ok: false, status: 'no-token' };
      const listen = makeListen(track, null, { clientVersion });
      try {
        const res = await post('playing_now', [listen]);
        return { ok: !!res.ok, status: res.ok ? 'sent' : `http-${res.status}` };
      } catch (error) {
        if (error?.name === 'NetworkConsentError') throw error;
        return { ok: false, status: 'offline' };
      }
    },
  };
  return api;
}

/**
 * Follows one play of one track and calls `onScrobble(listen)` once, as soon as the
 * scrobble rule is met. Only forward movement of up to `maxStepS` between position
 * reports counts as playing, so a seek forward adds nothing.
 *
 *   tracker.start(track)        // when a track starts (records listened_at)
 *   tracker.position(seconds)   // on every timeupdate
 *   tracker.stop()              // when the track ends or another one loads
 */
export function createPlayTracker({ onScrobble, now = () => Date.now(), maxStepS = 5, clientVersion = '' } = {}) {
  let track = null; let startedAt = 0; let last = null; let played = 0; let done = false;
  return {
    start(t, { positionS = 0 } = {}) {
      track = t; startedAt = Math.floor(now() / 1000); last = Number(positionS) || 0; played = 0; done = false;
    },
    position(seconds) {
      if (!track || done) return false;
      const p = Number(seconds);
      if (!Number.isFinite(p)) return false;
      const step = p - last;
      if (step > 0 && step <= maxStepS) played += step;
      last = p;
      if (shouldScrobble({ durationS: track.durationS, playedS: played })) {
        done = true;
        let listen;
        try { listen = makeListen(track, startedAt, { clientVersion }); } catch { return false; }
        onScrobble?.(listen);
        return true;
      }
      return false;
    },
    stop() { track = null; last = null; },
    /** True while a play is being followed (including one already scrobbled). */
    active: () => track !== null,
    playedS: () => played,
    scrobbled: () => done,
  };
}
