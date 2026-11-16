// The gapless lane: two decoded tracks on one AudioContext, one clock.
//
// Gapless playback across separate decoders cannot be exact, because each
// route has its own clock. The lane avoids the problem: it decodes the
// current track and the next one in full (decodeAudioData, or NakliAmp's own
// decoders for formats the browser refuses), and schedules the next
// AudioBufferSourceNode to start on the frame the current one ends. Encoder
// delay and padding are cut with the source's own offset and duration
// arguments, so nothing is copied.
//
// Crossfade uses the same lane: the next track starts `fadeS` before the
// current ends, with equal-power gain curves (cos/sin) so the summed power
// stays level through the overlap.
//
// Memory: a decoded track is Float32 per channel, about 10 MB per stereo
// minute at 44.1 kHz. The lane is capped at tracks under 20 minutes
// (LANE_MAX_S); longer files take the normal route.
//
// Headless: uses only the AudioContext it is given.

import { dbToGain } from './chain.mjs';

export const LANE_MAX_S = 20 * 60;
/** Lead time when starting playback, so the start lands in a future render quantum. */
export const LANE_LEAD_S = 0.03;

const positiveInt = value => (Number.isInteger(value) && value > 0 ? value : null);

/**
 * True when `next` is the track that follows `current` on the same album:
 * same album key, and either the next track number on the same disc, or
 * track 1 of the next disc. A missing disc number counts as disc 1. Missing
 * track numbers mean the order is unknown, so they do not join.
 */
export function sameAlbumConsecutive(current, next) {
  if (!current?.albumKey || current.albumKey !== next?.albumKey) return false;
  const a = positiveInt(current.trackNo);
  const b = positiveInt(next.trackNo);
  if (!a || !b) return false;
  const discA = positiveInt(current.discNo) ?? 1;
  const discB = positiveInt(next.discNo) ?? 1;
  if (discA === discB) return b === a + 1;
  return discB === discA + 1 && b === 1;
}

/**
 * How two queue items are joined, from the settings:
 *   'gapless'   when gapless is 'always', or 'albums' and the two are
 *               consecutive tracks of one album;
 *   'crossfade' when crossfadeS > 0 and the gapless rule does not join them
 *               (crossfade never applies where gapless does);
 *   null        otherwise: the normal route plays them one after the other.
 */
export function laneJoin(settings = {}, current, next) {
  if (!next) return null;
  const gapless = settings.gapless === 'always' || (settings.gapless === 'albums' && sameAlbumConsecutive(current, next));
  if (gapless) return 'gapless';
  if (Number(settings.crossfadeS) > 0) return 'crossfade';
  return null;
}

/**
 * Whether a track should be loaded onto the lane, decided at load time, before
 * the next queue item is known: when any transition out of it could be joined.
 */
export function wantsLane(settings = {}, meta = null) {
  if (settings.gapless === 'always') return true;
  if (Number(settings.crossfadeS) > 0) return true;
  return settings.gapless === 'albums' && Boolean(meta?.albumKey);
}

/** Equal-power fade curves of `points` values: out = cos, in = sin over a quarter turn. */
export function equalPowerCurves(points = 64, gainOut = 1, gainIn = 1) {
  const n = Math.max(2, points | 0);
  const fadeOut = new Float32Array(n);
  const fadeIn = new Float32Array(n);
  for (let index = 0; index < n; index += 1) {
    const t = index / (n - 1);
    fadeOut[index] = Math.cos(t * Math.PI / 2) * gainOut;
    fadeIn[index] = Math.sin(t * Math.PI / 2) * gainIn;
  }
  return { fadeOut, fadeIn };
}

/** Round a context time to the nearest whole frame. */
export function alignToFrame(timeS, sampleRate) {
  return Math.round(timeS * sampleRate) / sampleRate;
}

/**
 * When the next track starts, given the current track's schedule.
 *
 *   currentStartAt  context time the current source started (or will)
 *   offsetS         position in the current track it started from
 *   lengthS         current track's trimmed length
 *   nextLengthS     next track's trimmed length
 *   mode            'gapless' | 'crossfade'
 *   crossfadeS      requested fade length
 *   now             context time now; lead added so the start is in the future
 *
 * Returns { endAt, nextStartAt, fadeS, late }. `late` is true when the end had
 * already passed, so the next track starts as soon as possible (with a gap).
 */
export function scheduleTransition({
  currentStartAt, offsetS = 0, lengthS, nextLengthS, mode, crossfadeS = 0, now = 0, sampleRate = 48000, leadS = LANE_LEAD_S,
}) {
  const endAt = alignToFrame(currentStartAt + (lengthS - offsetS), sampleRate);
  const earliest = now + leadS;
  if (mode === 'crossfade') {
    let fadeS = Math.max(0, Math.min(Number(crossfadeS) || 0, lengthS / 2, nextLengthS / 2));
    let nextStartAt = alignToFrame(endAt - fadeS, sampleRate);
    if (nextStartAt < earliest) {
      nextStartAt = alignToFrame(earliest, sampleRate);
      fadeS = Math.max(0, endAt - nextStartAt);
    }
    return { endAt, nextStartAt, fadeS, late: endAt < earliest };
  }
  if (endAt < earliest) return { endAt, nextStartAt: alignToFrame(earliest, sampleRate), fadeS: 0, late: true };
  return { endAt, nextStartAt: endAt, fadeS: 0, late: false };
}

/**
 * A lane item from a decoded buffer and a trim decision (`reconcileTrim`).
 * Start and end are snapped to whole frames of the buffer.
 */
export function laneItem(buffer, trim = {}, extra = {}) {
  const rate = buffer.sampleRate;
  const startFrame = Math.max(0, Math.min(buffer.length, Math.round((trim.startS || 0) * rate)));
  const endFrame = trim.endS == null ? buffer.length : Math.max(startFrame, Math.min(buffer.length, Math.round(trim.endS * rate)));
  return {
    buffer,
    startS: startFrame / rate,
    lengthS: (endFrame - startFrame) / rate,
    gainDb: 0,
    ...extra,
  };
}

/**
 * The lane itself.
 *
 *   context      the lane's AudioContext (one for the life of the lane)
 *   destination  node the lane feeds (the chain input, or a volume stage)
 *   onAdvance    called with the new current item when the lane moves on
 *   setTimer / clearTimer  injected for tests
 */
export function createGaplessLane({
  context, destination, onAdvance = () => {}, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id),
}) {
  let current = null; // { item, source, gain }
  let next = null; // { item, mode, fadeS, source, gain, plan }
  let tail = null; // the outgoing track during a crossfade
  let tailFadeEnd = 0;
  let playing = false;
  let startAt = 0;
  let offsetAtStart = 0;
  let pausedOffset = 0;
  let timer = null;
  const now = () => context.currentTime;
  const rate = () => context.sampleRate || 48000;

  function makeVoice(item) {
    const gain = context.createGain();
    gain.gain.value = dbToGain(item.gainDb);
    gain.connect(destination);
    return gain;
  }
  function startSource(item, gain, when, offsetS) {
    const source = context.createBufferSource();
    source.buffer = item.buffer;
    source.connect(gain);
    const remaining = Math.max(0, item.lengthS - offsetS);
    source.start(when, item.startS + offsetS, remaining);
    return source;
  }
  function silence(voice) {
    if (!voice) return;
    try { voice.source?.stop(); } catch {}
    try { voice.source?.disconnect(); } catch {}
    try { voice.gain?.disconnect(); } catch {}
    voice.source = null;
  }
  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function resetCurrentGain() {
    if (!current?.gain) return;
    const param = current.gain.gain;
    try { param.cancelScheduledValues(0); } catch {}
    try { param.setValueAtTime(dbToGain(current.item.gainDb), now()); } catch { param.value = dbToGain(current.item.gainDb); }
  }

  function unscheduleNext() {
    cancelTimer();
    if (next?.source) {
      silence(next);
      next.gain = null;
      next.plan = null;
      resetCurrentGain();
    }
  }

  function scheduleNext() {
    if (!playing || !current || !next || next.source) return;
    const plan = scheduleTransition({
      currentStartAt: startAt,
      offsetS: offsetAtStart,
      lengthS: current.item.lengthS,
      nextLengthS: next.item.lengthS,
      mode: next.mode,
      crossfadeS: next.fadeS,
      now: now(),
      sampleRate: rate(),
    });
    next.gain = makeVoice(next.item);
    if (plan.fadeS > 0) {
      const curves = equalPowerCurves(128, dbToGain(current.item.gainDb), dbToGain(next.item.gainDb));
      next.gain.gain.value = 0;
      next.gain.gain.setValueCurveAtTime(curves.fadeIn, plan.nextStartAt, plan.fadeS);
      try { current.gain.gain.cancelScheduledValues(0); } catch {}
      current.gain.gain.setValueCurveAtTime(curves.fadeOut, plan.nextStartAt, plan.fadeS);
    }
    next.source = startSource(next.item, next.gain, plan.nextStartAt, 0);
    next.plan = plan;
    const delayMs = Math.max(0, (plan.nextStartAt - now()) * 1000);
    cancelTimer();
    timer = setTimer(checkAdvance, delayMs + 5);
  }

  /** Move to the next track once its start time has passed. */
  function checkAdvance() {
    if (!playing || !next?.plan || now() < next.plan.nextStartAt) {
      if (playing && next?.plan) {
        cancelTimer();
        timer = setTimer(checkAdvance, Math.max(5, (next.plan.nextStartAt - now()) * 1000 + 5));
      }
      return false;
    }
    cancelTimer();
    const incoming = next;
    if (incoming.plan.fadeS > 0) {
      if (tail) silence(tail);
      tail = current; // keeps fading out, ends by itself at endAt
      tailFadeEnd = incoming.plan.nextStartAt + incoming.plan.fadeS;
    } else {
      silence(current);
    }
    current = { item: incoming.item, source: incoming.source, gain: incoming.gain };
    startAt = incoming.plan.nextStartAt;
    offsetAtStart = 0;
    next = null;
    try { onAdvance(current.item, { mode: incoming.mode, fadeS: incoming.plan.fadeS }); } catch {}
    return true;
  }

  function position() {
    if (!current) return 0;
    if (!playing) return pausedOffset;
    checkAdvance();
    return Math.min(current.item.lengthS, Math.max(0, offsetAtStart + (now() - startAt)));
  }

  function stopAll() {
    cancelTimer();
    if (tail) { silence(tail); tail = null; }
    if (current) silence(current);
    if (next?.source) { silence(next); next.gain = null; next.plan = null; }
  }

  return {
    /** Replace everything with one item, paused at its start. */
    load(item) {
      stopAll();
      current = { item, source: null, gain: null };
      next = null;
      playing = false;
      pausedOffset = 0;
      offsetAtStart = 0;
    },
    play() {
      if (!current || playing) return;
      const offset = Math.min(pausedOffset, current.item.lengthS);
      startAt = alignToFrame(now() + LANE_LEAD_S, rate());
      offsetAtStart = offset;
      current.gain = makeVoice(current.item);
      current.source = startSource(current.item, current.gain, startAt, offset);
      playing = true;
      scheduleNext();
    },
    pause() {
      if (!playing) return;
      pausedOffset = position();
      playing = false;
      stopAll();
      if (current) current.gain = null;
    },
    seek(positionS) {
      if (!current) return;
      const wasPlaying = playing;
      if (playing) this.pause();
      pausedOffset = Math.max(0, Math.min(current.item.lengthS, alignToFrame(Number(positionS) || 0, current.item.buffer.sampleRate)));
      if (wasPlaying) this.play();
    },
    /** Queue the item that follows, joined by 'gapless' or 'crossfade'. */
    queue(item, { mode = 'gapless', fadeS = 0 } = {}) {
      unscheduleNext();
      next = item ? { item, mode, fadeS, source: null, gain: null, plan: null } : null;
      scheduleNext();
    },
    clearNext() {
      unscheduleNext();
      next = null;
    },
    /** Change the current item's gain (ReplayGain) smoothly; ignored mid-fade. */
    setCurrentGainDb(db) {
      if (!current) return;
      current.item.gainDb = Number(db) || 0;
      if (current.gain && !(next?.plan?.fadeS > 0)) {
        try { current.gain.gain.setTargetAtTime(dbToGain(current.item.gainDb), now(), 0.02); } catch {}
      }
    },
    position,
    duration: () => current?.item.lengthS ?? 0,
    playing: () => playing && Boolean(current) && position() < current.item.lengthS,
    ended: () => Boolean(current) && playing && !next && position() >= current.item.lengthS,
    current: () => current?.item ?? null,
    next: () => next?.item ?? null,
    nextScheduled: () => (next?.plan ? { ...next.plan, mode: next.mode } : null),
    /** True while two tracks overlap in a crossfade. */
    crossfading() {
      if (!playing) return false;
      const t = now();
      if (tail && t < tailFadeEnd) return true;
      return Boolean(next?.plan?.fadeS > 0 && t >= next.plan.nextStartAt);
    },
    checkAdvance,
    dispose() {
      stopAll();
      current = null;
      next = null;
      playing = false;
    },
  };
}
