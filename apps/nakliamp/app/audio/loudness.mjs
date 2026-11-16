// Integrated loudness (ITU-R BS.1770-4) and peak, in plain JavaScript.
//
// For files with no ReplayGain tags. The result feeds the same gain stage as
// the tags do: gainDb = -18 - integratedLufs, the ReplayGain 2.0 reference.
//
// Method, as the standard defines it:
//   1. K-weighting: a high-shelf stage then a high-pass stage per channel.
//      Coefficients are derived for any sample rate with the bilinear
//      transform (the same derivation libebur128 uses), so 44.1 kHz files are
//      not measured with 48 kHz coefficients.
//   2. Mean square per 400 ms block, blocks overlapping by 75% (100 ms hop).
//      Built from 100 ms sub-blocks: a 400 ms block is the mean of four.
//   3. Block loudness = -0.691 + 10 log10(sum of channel weight x mean square).
//      Weights: 1.0 for left, right, centre; 1.41 for the surrounds; the LFE
//      channel of a 5.1 file is left out.
//   4. Gating: drop blocks under -70 LUFS (absolute), then drop blocks more
//      than 10 LU under the loudness of what is left (relative). The
//      integrated loudness is that of the blocks that pass both gates.
//
// Peak: the sample peak, and a true-peak estimate from 4x oversampling with a
// 48-tap windowed-sinc interpolator (12 taps per phase). BS.1770-4 Annex 2
// gives its own filter; this one is an estimate in the same spirit, accurate
// to a few hundredths of a dB on test tones, and is reported as such.
//
// Headless and incremental: `createLoudnessMeter` takes audio in chunks so a
// background scanner can yield between them.

export const REFERENCE_LUFS = -18;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;

/** K-weighting biquad coefficients for one sample rate. */
export function kWeightingCoefficients(sampleRate) {
  // Stage 1: high shelf, +4 dB above about 1.5 kHz (head effects).
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0],
    a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0],
  };
  // Stage 2: high pass at about 38 Hz (the RLB curve).
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / sampleRate);
  a0 = 1 + K / Q + K * K;
  const highPass = {
    b: [1, -2, 1],
    a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0],
  };
  return { shelf, highPass };
}

/** Per-channel weights for BS.1770, by channel count (WAV/Vorbis 5.1 order). */
export function channelWeights(channels) {
  if (channels === 6) return [1, 1, 1, 0, 1.41, 1.41];
  if (channels === 5) return [1, 1, 1, 1.41, 1.41];
  return Array.from({ length: channels }, () => 1);
}

const TAPS_PER_PHASE = 12;
const HALF = TAPS_PER_PHASE / 2;

/** Interpolator coefficients for the three in-between phases (1/4, 2/4, 3/4). */
function oversampleCoefficients() {
  const phases = [];
  for (let phase = 1; phase < 4; phase += 1) {
    const frac = phase / 4;
    const taps = new Float64Array(TAPS_PER_PHASE);
    let sum = 0;
    for (let j = 0; j < TAPS_PER_PHASE; j += 1) {
      // Tap j weights input sample (centre - HALF + 1 + j); distance from the
      // interpolation point, which sits `frac` after the centre sample.
      const t = (j - HALF + 1) - frac;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const x = t / HALF;
      const window = Math.abs(x) >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);
      taps[j] = sinc * window;
      sum += taps[j];
    }
    for (let j = 0; j < TAPS_PER_PHASE; j += 1) taps[j] /= sum;
    phases.push(taps);
  }
  return phases;
}
const OVERSAMPLE = oversampleCoefficients();

function planesOf(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input.getChannelData === 'function') {
    return Array.from({ length: input.numberOfChannels }, (_, index) => input.getChannelData(index));
  }
  throw new TypeError('measureLoudness takes an AudioBuffer or an array of Float32Array channel planes.');
}

/**
 * The largest interpolated magnitude in one history ring. The oldest sample in
 * the ring is at `historyIndex`. Interpolate the three points after the centre
 * sample (ring position HALF - 1).
 */
function ringPeak(ring, historyIndex) {
  let peak = 0;
  for (let phase = 0; phase < 3; phase += 1) {
    const taps = OVERSAMPLE[phase];
    let acc = 0;
    for (let j = 0; j < TAPS_PER_PHASE; j += 1) acc += taps[j] * ring[(historyIndex + j) % TAPS_PER_PHASE];
    const magnitude = acc < 0 ? -acc : acc;
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}

/**
 * An incremental meter. `push(planes)` with equal-length Float32Array planes,
 * as many times as needed; `result()` at any point.
 */
export function createLoudnessMeter({ sampleRate, channels, truePeak = true } = {}) {
  if (!(sampleRate > 0)) throw new RangeError('createLoudnessMeter needs a positive sampleRate.');
  if (!(channels >= 1)) throw new RangeError('createLoudnessMeter needs at least one channel.');
  const { shelf, highPass } = kWeightingCoefficients(sampleRate);
  const weights = channelWeights(channels);
  const subLength = Math.round(sampleRate * 0.1);
  // Filter state per channel: [x1, x2, y1, y2] for each stage.
  const state = Array.from({ length: channels }, () => new Float64Array(8));
  const subEnergy = new Float64Array(channels);
  let subCount = 0;
  const subBlocks = []; // weighted sum of channel mean squares per 100 ms
  let samplePeak = 0;
  let interpolatedPeak = 0;
  const history = Array.from({ length: channels }, () => new Float64Array(TAPS_PER_PHASE));
  let historyFilled = 0;
  let historyIndex = 0;

  function closeSubBlock() {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += weights[channel] * (subEnergy[channel] / subLength);
      subEnergy[channel] = 0;
    }
    subBlocks.push(sum);
    subCount = 0;
  }

  const [sb0, sb1, sb2] = shelf.b;
  const [sa1, sa2] = shelf.a;
  const [ha1, ha2] = highPass.a;

  /** Track the sample peak and add one frame's K-weighted energy per channel. */
  function weighFrame(planes, frame) {
    for (let channel = 0; channel < channels; channel += 1) {
      const x = planes[channel][frame];
      const magnitude = x < 0 ? -x : x;
      if (magnitude > samplePeak) samplePeak = magnitude;
      if (weights[channel] === 0) continue;
      const s = state[channel];
      // Direct form I, stage 1 then stage 2.
      const y1 = sb0 * x + sb1 * s[0] + sb2 * s[1] - sa1 * s[2] - sa2 * s[3];
      s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y1;
      const y2 = y1 - 2 * s[4] + s[5] - ha1 * s[6] - ha2 * s[7];
      s[5] = s[4]; s[4] = y1; s[7] = s[6]; s[6] = y2;
      subEnergy[channel] += y2 * y2;
    }
  }

  /** Add one frame to the history ring and, once it is full, update the interpolated peak. */
  function trackTruePeak(planes, frame) {
    for (let channel = 0; channel < channels; channel += 1) history[channel][historyIndex] = planes[channel][frame];
    historyIndex = (historyIndex + 1) % TAPS_PER_PHASE;
    if (historyFilled < TAPS_PER_PHASE) historyFilled += 1;
    if (historyFilled < TAPS_PER_PHASE) return;
    for (let channel = 0; channel < channels; channel += 1) {
      const peak = ringPeak(history[channel], historyIndex);
      if (peak > interpolatedPeak) interpolatedPeak = peak;
    }
  }

  function push(planesInput) {
    const planes = planesOf(planesInput);
    if (planes.length !== channels) throw new RangeError(`Expected ${channels} channel planes, got ${planes.length}.`);
    const frames = planes[0].length;
    for (let frame = 0; frame < frames; frame += 1) {
      weighFrame(planes, frame);
      subCount += 1;
      if (subCount === subLength) closeSubBlock();
      if (truePeak) trackTruePeak(planes, frame);
    }
  }

  function result() {
    const blocks = [];
    for (let index = 3; index < subBlocks.length; index += 1) {
      blocks.push((subBlocks[index - 3] + subBlocks[index - 2] + subBlocks[index - 1] + subBlocks[index]) / 4);
    }
    const lufs = energy => -0.691 + 10 * Math.log10(energy);
    const absolute = blocks.filter(energy => energy > 0 && lufs(energy) > ABSOLUTE_GATE_LUFS);
    let integratedLufs = -Infinity;
    if (absolute.length) {
      const ungated = absolute.reduce((sum, value) => sum + value, 0) / absolute.length;
      const relativeGate = lufs(ungated) + RELATIVE_GATE_LU;
      const gated = absolute.filter(energy => lufs(energy) > relativeGate);
      if (gated.length) integratedLufs = lufs(gated.reduce((sum, value) => sum + value, 0) / gated.length);
    }
    const peak = Math.max(samplePeak, truePeak ? interpolatedPeak : 0);
    return {
      integratedLufs,
      truePeak: peak,
      truePeakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
      samplePeak,
      blocks: blocks.length,
      truePeakMethod: truePeak ? '4x windowed-sinc estimate' : 'sample peak only',
    };
  }

  return { push, result };
}

/**
 * One-shot measurement of an AudioBuffer or channel planes.
 * Returns `{ integratedLufs, truePeak, truePeakDb, samplePeak, blocks }`.
 * `truePeak` is linear amplitude (1.0 = full scale), like ReplayGain peaks.
 * Silence, or anything shorter than one 400 ms block, measures -Infinity.
 */
export function measureLoudness(input, sampleRate = input?.sampleRate, options = {}) {
  const planes = planesOf(input);
  const meter = createLoudnessMeter({ sampleRate, channels: planes.length, truePeak: options.truePeak !== false });
  meter.push(planes);
  return meter.result();
}

/** ReplayGain 2.0 gain for a measured loudness, or null when nothing was measurable. */
export function loudnessToGainDb(integratedLufs) {
  return Number.isFinite(integratedLufs) ? REFERENCE_LUFS - integratedLufs : null;
}

/** The cache key the library store uses (contract: path, size, lastModified). */
export function defaultLoudnessKey(track) {
  return `${track.path}\u001f${track.size}\u001f${track.lastModified}`;
}

const defaultYield = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Work through tracks in the background, one at a time.
 *
 * Injected, so it runs and tests without a browser:
 *   decode(track)        -> { planes | buffer, sampleRate } or null to skip
 *   getLoudness(key)     -> cached value or null
 *   putLoudness(key, v)  -> store `{ integratedLufs, truePeak, gainDb, computedAt }`
 *   keyOf(track)         -> cache key (defaults to the contract's key)
 *   isBusy()             -> true while playback is decoding; the scanner waits
 *   yieldFn()            -> promise resolved when the scanner may continue
 *   chunkFrames          -> frames measured between yields (default 1 s at 48 kHz)
 *   now()                -> timestamp for computedAt
 *
 * Returns { enqueue(tracks), pause(), resume(), cancel(), status(), onProgress(fn), idle() }.
 * `idle()` resolves when the queue is empty or the scanner was cancelled.
 */
export function createLoudnessScanner({
  decode,
  getLoudness,
  putLoudness,
  keyOf = defaultLoudnessKey,
  isBusy = () => false,
  yieldFn = defaultYield,
  chunkFrames = 48_000,
  now = () => Date.now(),
} = {}) {
  if (typeof decode !== 'function') throw new TypeError('createLoudnessScanner needs a decode function.');
  const queue = [];
  const queued = new Set();
  const listeners = new Set();
  let running = false;
  let paused = false;
  let cancelled = false;
  let current = null;
  let done = 0;
  let failed = 0;
  let skipped = 0;
  let idleWaiters = [];

  function snapshot() {
    return { running, paused, cancelled, current: current ? keyOf(current) : null, queued: queue.length, done, failed, skipped };
  }
  function notify(event) {
    for (const listener of listeners) { try { listener({ ...snapshot(), ...event }); } catch {} }
  }
  async function gate() {
    // Wait while paused or while playback needs the decoder.
    while (!cancelled && (paused || isBusy())) await yieldFn();
    return !cancelled;
  }

  async function measureTrack(track) {
    const decoded = await decode(track);
    if (!decoded) return null;
    const planes = decoded.planes ?? planesOf(decoded.buffer ?? decoded);
    const sampleRate = decoded.sampleRate ?? decoded.buffer?.sampleRate;
    const meter = createLoudnessMeter({ sampleRate, channels: planes.length });
    const frames = planes[0]?.length ?? 0;
    for (let start = 0; start < frames; start += chunkFrames) {
      if (!(await gate())) return undefined;
      meter.push(planes.map(plane => plane.subarray(start, Math.min(frames, start + chunkFrames))));
      await yieldFn();
    }
    return meter.result();
  }

  /** Measure and store one track, or skip it when cached or undecodable. False when cancelled mid-track. */
  async function scanTrack(track, key) {
    const cached = getLoudness ? await getLoudness(key) : null;
    if (cached) { skipped += 1; notify({ type: 'skipped', key }); return true; }
    const measured = await measureTrack(track);
    if (measured === undefined) return false;
    if (measured === null) { skipped += 1; notify({ type: 'skipped', key }); return true; }
    const value = {
      integratedLufs: Number.isFinite(measured.integratedLufs) ? measured.integratedLufs : null,
      truePeak: measured.truePeak,
      gainDb: loudnessToGainDb(measured.integratedLufs),
      computedAt: now(),
    };
    if (putLoudness) await putLoudness(key, value);
    done += 1;
    notify({ type: 'measured', key, value });
    return true;
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      while (queue.length && !cancelled) {
        if (!(await gate())) break;
        current = queue.shift();
        const key = keyOf(current);
        queued.delete(key);
        try {
          if (!(await scanTrack(current, key))) break; // cancelled mid-track
        } catch (error) {
          failed += 1;
          notify({ type: 'failed', key, error: error?.message || String(error) });
        } finally {
          current = null;
        }
      }
    } finally {
      running = false;
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve(snapshot());
      notify({ type: 'idle' });
    }
  }

  return {
    enqueue(tracks) {
      if (cancelled) return snapshot();
      for (const track of tracks ?? []) {
        const key = keyOf(track);
        if (queued.has(key)) continue;
        queued.add(key);
        queue.push(track);
      }
      run();
      return snapshot();
    },
    pause() { paused = true; },
    resume() { paused = false; },
    cancel() { cancelled = true; queue.length = 0; queued.clear(); },
    status: snapshot,
    onProgress(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    idle() {
      if (!running) return Promise.resolve(snapshot());
      return new Promise(resolve => idleWaiters.push(resolve));
    },
  };
}
