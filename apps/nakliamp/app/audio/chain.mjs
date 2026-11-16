// The DSP chain every playback route feeds: ReplayGain gain, ten peaking EQ
// filters, a master stage, then the destination.
//
//   route output -> input (track gain) -> eq[0..9] -> output (EQ preamp) -> destination
//
// Headroom (review finding N21): the output stage lowers the level by the
// largest EQ band boost, so a boosted band does not push the signal past full
// scale, and clipping prevention treats a gain with no known peak as if the
// peak were full scale, so it never raises such a track above unity.
//
// One chain per AudioContext. Each route that owns a context (Reel's engine,
// the native element graph, the software rung, the gapless lane) gets its own
// chain, built on first use and kept until that context goes away.
//
// Every live change goes through setTargetAtTime, never `.value =`, so moving
// an EQ slider or switching tracks with a different gain does not click.
//
// Headless: uses only the AudioContext passed in. No DOM.

import { EQ_BANDS_HZ, EQ_Q, eqGains } from './eq-presets.mjs';

/** Time constant for parameter moves: about 60 ms to settle, no click. */
export const SMOOTHING_S = 0.02;

export function dbToGain(db) {
  return Math.pow(10, (Number(db) || 0) / 20);
}

export function gainToDb(gain) {
  return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
}

const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** One gain candidate, or null when its gain is not a finite number. */
function gainCandidate(gainDb, peak, source) {
  return finite(gainDb) === null ? null : { gainDb, peak: finite(peak), source };
}

/** The track and album candidates from ReplayGain tags. */
function tagCandidates(rg) {
  if (!rg) return { track: null, album: null };
  return {
    track: gainCandidate(rg.trackGainDb, rg.trackPeak, 'track'),
    album: gainCandidate(rg.albumGainDb, rg.albumPeak, 'album'),
  };
}

/** Pick the candidate the mode asks for, then the other tag gain, then the computed loudness. */
function pickGain(mode, values, albumContext) {
  const { track, album } = tagCandidates(values?.replayGain);
  const loudness = values?.loudness;
  const computed = loudness ? gainCandidate(loudness.gainDb, loudness.truePeak, 'loudness') : null;
  const wantAlbum = mode === 'album' || (mode === 'auto' && albumContext);
  return (wantAlbum ? (album ?? track) : (track ?? album)) ?? computed;
}

/** EQ preamp in dB: minus the largest band boost, or 0 when no band boosts. */
export function eqPreampDb(bandGains = []) {
  const boost = Math.max(0, ...bandGains.map(value => Number(value) || 0));
  return boost > 0 ? -boost : 0;
}

/** Lower the gain so the peak times the gain stays at or under full scale. */
function limitToPeak(gainDb, peak) {
  const ceilingDb = -20 * Math.log10(peak) || 0; // `|| 0`: a full-scale peak gives 0, not -0
  return gainDb > ceilingDb ? { gainDb: ceilingDb, clipLimited: true } : { gainDb, clipLimited: false };
}

/**
 * Pick the gain for a track from its tags or computed loudness.
 *
 * `settings` is the contract's `replayGain` block: `{ mode, preampDb,
 * preventClipping }` with mode 'off' | 'track' | 'album' | 'auto'.
 * `values` is `{ replayGain, loudness }` from the track record:
 *   replayGain: { trackGainDb, trackPeak, albumGainDb, albumPeak } or null
 *   loudness:   { integratedLufs, truePeak, gainDb } or null (computed scan)
 * `albumContext` says whether a queue neighbour shares this track's album;
 * auto mode uses album gain only then.
 *
 * Preference order: the gain the mode asks for, then the other tag gain, then
 * the computed loudness. Peaks are linear amplitude (1.0 = full scale), as
 * ReplayGain tags store them. Clipping prevention lowers the gain so that the
 * peak times the gain stays at or under full scale.
 *
 * Returns `{ gainDb, source, peak, clipLimited }`; `source` is 'off', 'track',
 * 'album', 'loudness' or 'none' (no value known, so unity gain).
 */
export function resolveTrackGain(settings = {}, values = {}, { albumContext = false } = {}) {
  const mode = settings?.mode ?? 'off';
  if (mode === 'off') return { gainDb: 0, source: 'off', peak: null, clipLimited: false };
  const pick = pickGain(mode, values, albumContext);
  if (!pick) return { gainDb: 0, source: 'none', peak: null, clipLimited: false };
  const preamped = pick.gainDb + (finite(settings.preampDb) ?? 0);
  // An unknown peak is taken as full scale: without it, a positive gain could
  // push any sample past full scale and nothing later in the chain limits it.
  const { gainDb, clipLimited } = settings.preventClipping !== false
    ? limitToPeak(preamped, pick.peak > 0 ? pick.peak : 1)
    : { gainDb: preamped, clipLimited: false };
  return { gainDb, source: pick.source, peak: pick.peak, clipLimited };
}

function smooth(context, param, value) {
  const now = context.currentTime || 0;
  if (typeof param.setTargetAtTime === 'function') {
    try { param.cancelScheduledValues?.(now); } catch {}
    param.setTargetAtTime(value, now, SMOOTHING_S);
  } else {
    param.value = value;
  }
}

/**
 * Build the chain on one context. The output is connected to the destination
 * once and stays connected; routes connect to `input`.
 */
export function createChain(context) {
  const input = context.createGain();
  const eq = EQ_BANDS_HZ.map(frequency => {
    const filter = context.createBiquadFilter();
    filter.type = 'peaking';
    filter.frequency.value = frequency;
    filter.Q.value = EQ_Q;
    filter.gain.value = 0;
    return filter;
  });
  const output = context.createGain();
  let node = input;
  for (const filter of eq) {
    node.connect(filter);
    node = filter;
  }
  node.connect(output);
  output.connect(context.destination);

  let gainDb = 0;
  let bandGains = eq.map(() => 0);

  return {
    context,
    input,
    eq,
    output,
    /** Apply an EQ setting (`{ enabled, preset, custom }`); returns the band gains used. */
    setEq(setting) {
      bandGains = eqGains(setting);
      eq.forEach((filter, index) => smooth(context, filter.gain, bandGains[index]));
      smooth(context, output.gain, dbToGain(eqPreampDb(bandGains)));
      return [...bandGains];
    },
    /** Set the per-track gain in dB on the input stage. */
    setGainDb(db) {
      gainDb = Number(db) || 0;
      smooth(context, input.gain, dbToGain(gainDb));
    },
    gainDb: () => gainDb,
    bandGains: () => [...bandGains],
    preampDb: () => eqPreampDb(bandGains),
    dispose() {
      for (const item of [input, ...eq, output]) {
        try { item.disconnect(); } catch {}
      }
    },
  };
}
