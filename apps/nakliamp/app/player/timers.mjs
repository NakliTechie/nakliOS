// Playback speed (parity row P9), stop after current track and sleep timer
// (parity row P10).
//
// Pure state. No timers run in here: the caller drives `tick()` from the
// engine's time updates and calls `trackEnded()` when a track finishes, and
// the clock is injected, so the logic runs in Node with a fake clock.

// ----------------------------------------------------------- speed ----

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;
export const SPEED_STEPS = Object.freeze([0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]);

/** A playback rate clamped to 0.5..2 and rounded to 0.01; junk is 1. */
export function clampSpeed(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.round(Math.max(SPEED_MIN, Math.min(SPEED_MAX, value)) * 100) / 100;
}

/** The next step up (`direction` > 0) or down from `rate`. */
export function stepSpeed(rate, direction) {
  const current = clampSpeed(rate);
  if (direction > 0) return SPEED_STEPS.find(step => step > current + 1e-9) ?? SPEED_MAX;
  return [...SPEED_STEPS].reverse().find(step => step < current - 1e-9) ?? SPEED_MIN;
}

/** "1x", "1.25x", "0.5x". */
export function formatSpeed(rate) {
  return `${clampSpeed(rate)}x`;
}

// ---------------------------------------------------- sleep / stop ----

export const FADE_S = 10;
export const SLEEP_MODES = Object.freeze(['minutes', 'end-of-track', 'end-of-queue']);

export class TimerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimerError';
    this.code = 'ERR_NAKLIAMP_TIMER_INVALID';
  }
}

/**
 * Stop-after-current and the sleep timer.
 *
 * `now()` returns milliseconds (default Date.now). Use:
 * - `setStopAfterCurrent(on)`: stop when the playing track ends (one shot).
 * - `setSleep({ minutes })`, `setSleep({ mode: 'end-of-track' })`,
 *   `setSleep({ mode: 'end-of-queue' })`, `cancelSleep()`.
 * - `tick({ positionS, durationS, isLast })` on every time update. Returns
 *   `{ volume, action }`: `volume` is the fade factor 0..1 to multiply the
 *   output by (it falls linearly over the last 10 s), `action` is 'stop' when
 *   a minutes timer runs out, else null.
 * - `trackEnded({ isLast })` when a track finishes. Returns 'stop' or
 *   'continue'. A one-shot that fires disarms itself.
 * - `status()` for the UI; `onChange(fn)` for updates.
 * After a 'stop', the caller pauses and restores full volume; the timer is
 * already cleared, so the next play is not faded.
 */
export function createPlaybackTimers({ now = () => Date.now() } = {}) {
  let stopAfterCurrent = false;
  let sleep = null; // { mode, deadline? }
  const listeners = new Set();
  const emit = () => { const state = status(); for (const fn of listeners) fn(state); };

  function status() {
    let remainingS = null;
    if (sleep?.mode === 'minutes') remainingS = Math.max(0, (sleep.deadline - now()) / 1000);
    return { stopAfterCurrent, sleep: sleep ? { mode: sleep.mode, remainingS } : null };
  }

  function fadeFor(remainingS) {
    if (remainingS === null || !Number.isFinite(remainingS)) return 1;
    return Math.max(0, Math.min(1, remainingS / FADE_S));
  }

  return {
    status,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    setStopAfterCurrent(on) {
      stopAfterCurrent = Boolean(on);
      emit();
    },

    setSleep({ minutes, mode } = {}) {
      if (minutes !== undefined) {
        const value = Number(minutes);
        if (!Number.isFinite(value) || value <= 0 || value > 24 * 60) {
          throw new TimerError('Sleep timer minutes must be more than 0 and at most 1440.');
        }
        sleep = { mode: 'minutes', deadline: now() + value * 60000 };
      } else if (mode === 'end-of-track' || mode === 'end-of-queue') {
        sleep = { mode };
      } else {
        throw new TimerError(`Not a sleep timer mode: ${mode}`);
      }
      emit();
      return status();
    },

    cancelSleep() {
      if (!sleep) return;
      sleep = null;
      emit();
    },

    tick({ positionS = null, durationS = null, isLast = false } = {}) {
      const trackLeftS = Number.isFinite(positionS) && Number.isFinite(durationS) ? Math.max(0, durationS - positionS) : null;
      if (!sleep) return { volume: 1, action: null };
      if (sleep.mode === 'minutes') {
        const remainingS = (sleep.deadline - now()) / 1000;
        if (remainingS <= 0) {
          sleep = null;
          emit();
          return { volume: 0, action: 'stop' };
        }
        return { volume: fadeFor(remainingS), action: null };
      }
      if (sleep.mode === 'end-of-track') return { volume: fadeFor(trackLeftS), action: null };
      // end-of-queue: only the last track fades.
      return { volume: isLast ? fadeFor(trackLeftS) : 1, action: null };
    },

    trackEnded({ isLast = false } = {}) {
      let stop = false;
      if (stopAfterCurrent) { stopAfterCurrent = false; stop = true; }
      if (sleep?.mode === 'end-of-track' || (sleep?.mode === 'end-of-queue' && isLast)) { sleep = null; stop = true; }
      if (stop) emit();
      return stop ? 'stop' : 'continue';
    },
  };
}

/** "25:00", "1:02:03"; null (no countdown) is the empty string. */
export function formatRemaining(seconds) {
  if (seconds === null || !Number.isFinite(seconds)) return '';
  const total = Math.ceil(Math.max(0, seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = n => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
