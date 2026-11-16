// media-session.mjs — Media Session wiring (P8): metadata with artwork, the
// transport handlers, playback state and position. Every call into the API is
// wrapped, because browsers differ in which actions they accept and an iframe
// may expose a partial object (web.dev's advice). `mediaSession` and
// `MediaMetadata` are injected so node:test can drive it with fakes.

export const ACTIONS = Object.freeze([
  'play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward', 'stop',
]);

/**
 * @param {{ mediaSession?: object|null, MediaMetadata?: Function|null,
 *           handlers: Record<string, (details) => void> }} options
 * Returns `{ supported, setTrack(meta), setPlaying(bool|null), setPosition(state), clear() }`.
 */
export function createMediaSession({
  mediaSession = globalThis.navigator?.mediaSession ?? null,
  MediaMetadata = globalThis.MediaMetadata ?? null,
  handlers = {},
} = {}) {
  const supported = Boolean(mediaSession);
  const bound = [];
  if (supported) {
    for (const action of ACTIONS) {
      const fn = handlers[action];
      if (typeof fn !== 'function') continue;
      try {
        mediaSession.setActionHandler(action, details => {
          try { fn(details ?? {}); } catch (error) { console.warn('[nakliamp] media session action failed', action, error); }
        });
        bound.push(action);
      } catch { /* this browser does not know the action */ }
    }
  }
  let lastPosition = null;

  return {
    supported,
    actions: () => bound.slice(),
    /** meta: { title, artist, album, artUrl, artType } */
    setTrack(meta) {
      if (!supported) return;
      try {
        if (!meta) { mediaSession.metadata = null; return; }
        const artwork = meta.artUrl ? [{ src: meta.artUrl, sizes: '512x512', ...(meta.artType ? { type: meta.artType } : {}) }] : [];
        const fields = { title: meta.title ?? '', artist: meta.artist ?? '', album: meta.album ?? '', artwork };
        mediaSession.metadata = typeof MediaMetadata === 'function' ? new MediaMetadata(fields) : fields;
      } catch { /* metadata refused */ }
    },
    setPlaying(playing) {
      if (!supported) return;
      try { mediaSession.playbackState = playing === null ? 'none' : playing ? 'playing' : 'paused'; } catch { /* read-only here */ }
    },
    /** state: { duration, position, rate }. Skipped when nothing changed or the duration is unknown. */
    setPosition({ duration, position, rate = 1 } = {}) {
      if (!supported || typeof mediaSession.setPositionState !== 'function') return;
      if (!(Number.isFinite(duration) && duration > 0)) return;
      const pos = Math.max(0, Math.min(Number(position) || 0, duration));
      const key = `${duration.toFixed(2)}|${pos.toFixed(0)}|${rate}`;
      if (key === lastPosition) return;
      lastPosition = key;
      try { mediaSession.setPositionState({ duration, position: pos, playbackRate: rate || 1 }); } catch { /* bad values */ }
    },
    clear() {
      if (!supported) return;
      lastPosition = null;
      try { mediaSession.metadata = null; } catch { /* ignore */ }
      try { mediaSession.playbackState = 'none'; } catch { /* ignore */ }
    },
  };
}
