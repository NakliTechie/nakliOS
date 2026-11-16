// spectrum.mjs — `spectrum.get`: the analyser's current frame as log-spaced bands (M3).
//
// cliamp's IPC v2 offers `spectrum.get`, one frame of the visualiser's bands per call
// (github.com/bjarneo/cliamp, docs/remote-control.md; MIT). NakliAmp reads the same
// AnalyserNode the visualiser draws from and folds its linear FFT bins into `count`
// bands spaced evenly on a log frequency scale, each the loudest bin inside it, 0 to 1.
// No DOM; the analyser is injected.

export const DEFAULT_BANDS = 32;
export const MIN_HZ = 20;
export const MAX_HZ = 20000;

/** `count + 1` band edges in Hz, evenly spaced on a log scale from `minHz` to `maxHz`. */
export function logBandEdges(count = DEFAULT_BANDS, minHz = MIN_HZ, maxHz = MAX_HZ) {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('count must be a positive integer');
  if (!(minHz > 0) || !(maxHz > minHz)) throw new RangeError('need 0 < minHz < maxHz');
  const ratio = Math.log(maxHz / minHz);
  return Array.from({ length: count + 1 }, (_, i) => minHz * Math.exp((ratio * i) / count));
}

const round3 = v => Math.round(v * 1000) / 1000;

/**
 * Fold byte frequency data (AnalyserNode.getByteFrequencyData) into `count` log bands.
 * Bin `i` sits at `i * sampleRate / fftSize`, with `fftSize = 2 * bins.length`. A band
 * narrower than one bin (low frequencies) takes the bin nearest its centre.
 * Returns `{ bands, edgesHz }`, levels 0 to 1 rounded to 3 decimals.
 */
export function spectrumBands(bins, sampleRate, count = DEFAULT_BANDS, { minHz = MIN_HZ, maxHz = MAX_HZ } = {}) {
  const n = bins?.length ?? 0;
  if (!n || !(sampleRate > 0)) return { bands: [], edgesHz: [] };
  const nyquist = sampleRate / 2;
  const top = Math.min(maxHz, nyquist);
  const edgesHz = logBandEdges(count, minHz, top);
  const hzPerBin = nyquist / n;
  const bands = [];
  for (let b = 0; b < count; b += 1) bands.push(round3(bandPeak(bins, edgesHz[b], edgesHz[b + 1], hzPerBin) / 255));
  return { bands, edgesHz: edgesHz.map(v => Math.round(v)) };
}

// The loudest bin between `loHz` and `hiHz`, or the bin nearest the band's centre when
// the band falls between two bins.
function bandPeak(bins, loHz, hiHz, hzPerBin) {
  const last = bins.length - 1;
  const lo = Math.ceil(loHz / hzPerBin);
  const hi = Math.min(last, Math.floor(hiHz / hzPerBin));
  if (lo > hi) return bins[Math.min(last, Math.round(Math.sqrt(loHz * hiHz) / hzPerBin))] ?? 0;
  let peak = 0;
  for (let i = lo; i <= hi; i += 1) if (bins[i] > peak) peak = bins[i];
  return peak;
}

/**
 * One frame from `analyser` (an AnalyserNode or anything with frequencyBinCount,
 * getByteFrequencyData and context.sampleRate). `playing` false, or no analyser, gives
 * empty bands: cliamp sends an empty frame when nothing plays.
 */
export function readSpectrum(analyser, { count = DEFAULT_BANDS, playing = true } = {}) {
  const empty = { bands: [], count, minHz: MIN_HZ, maxHz: MAX_HZ, edgesHz: [], playing: Boolean(playing) };
  if (!playing || !analyser || !(analyser.frequencyBinCount > 0)) return empty;
  const bins = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(bins);
  const sampleRate = analyser.context?.sampleRate ?? 48000;
  const { bands, edgesHz } = spectrumBands(bins, sampleRate, count);
  return { ...empty, bands, edgesHz, maxHz: edgesHz[edgesHz.length - 1] ?? MAX_HZ };
}
