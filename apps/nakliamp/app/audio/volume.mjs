// Output stage helpers: volume in dB with a floor (parity row S5) and mono
// downmix (parity row P11).
//
// Volume: the slider position (0..1) maps linearly to dB between the floor
// and 0 dB, so each step of the slider is the same loudness change. Position
// 0 is mute, not the floor: the floor is the quietest audible setting.
//
// Mono: a downmix stage inserted between the DSP chain output and the
// destination. Headless: it uses only the AudioContext it is given.

export const DEFAULT_FLOOR_DB = -50;
export const MIN_FLOOR_DB = -90;
export const MAX_FLOOR_DB = -1;

/** A floor clamped to -90..-1 dB (a floor at 0 would leave no range). */
export function clampFloor(floorDb = DEFAULT_FLOOR_DB) {
  const value = Number(floorDb);
  if (!Number.isFinite(value)) return DEFAULT_FLOOR_DB;
  return Math.max(MIN_FLOOR_DB, Math.min(MAX_FLOOR_DB, value));
}

/** Slider position 0..1 to dB; 0 is mute (-Infinity). */
export function positionToDb(position, floorDb = DEFAULT_FLOOR_DB) {
  const floor = clampFloor(floorDb);
  const value = Number(position);
  if (!Number.isFinite(value) || value <= 0) return -Infinity;
  return floor + Math.min(1, value) * -floor;
}

/** dB to slider position 0..1; at or below the floor is 0 only for mute. */
export function dbToPosition(db, floorDb = DEFAULT_FLOOR_DB) {
  const floor = clampFloor(floorDb);
  if (db === -Infinity || !Number.isFinite(db)) return 0;
  if (db >= 0) return 1;
  if (db <= floor) return Number.EPSILON;
  return (db - floor) / -floor;
}

/** Linear gain for dB: 10^(dB/20); -Infinity is 0. */
export function dbToGain(db) {
  return db === -Infinity ? 0 : Math.pow(10, Number(db) / 20);
}

/** dB for a linear gain; 0 is -Infinity. */
export function gainToDb(gain) {
  return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
}

export const positionToGain = (position, floorDb) => dbToGain(positionToDb(position, floorDb));

/**
 * Slider position for a linear gain, so an engine that stores 0..1 gain can
 * drive a dB slider. A gain quieter than the floor sits at the bottom.
 */
export function gainToPosition(gain, floorDb = DEFAULT_FLOOR_DB) {
  return gain > 0 ? dbToPosition(gainToDb(gain), floorDb) : 0;
}

/**
 * Step the volume by `deltaDb` (for keys and the mouse wheel). Stepping up
 * from mute lands on the floor; stepping down past the floor mutes. The
 * result is rounded to 0.1 dB and capped at 0 dB.
 */
export function stepDb(db, deltaDb, floorDb = DEFAULT_FLOOR_DB) {
  const floor = clampFloor(floorDb);
  if (db === -Infinity || !Number.isFinite(db)) return deltaDb > 0 ? floor : -Infinity;
  const next = db + deltaDb;
  if (next < floor) return deltaDb < 0 ? -Infinity : floor;
  return Math.min(0, Math.round(next * 10) / 10);
}

/** Display text: "Muted", or "-12.5 dB" with one decimal ("0.0 dB" at the top). */
export function formatDb(db) {
  if (db === -Infinity || !Number.isFinite(db)) return 'Muted';
  const rounded = Math.round(db * 10) / 10;
  return `${rounded === 0 ? '0.0' : rounded.toFixed(1)} dB`;
}

// ------------------------------------------------------------ mono ----

/**
 * The mono downmix graph, as data, for the honesty strip and for tests:
 *   input -> stereo gain (bypass) -------------------------> output
 *   input -> mono gain (1 channel, explicit, speakers) -> merger in 0 and 1 -> output
 * The mono gain node's `channelCount: 1` with `channelCountMode: 'explicit'`
 * makes Web Audio downmix stereo to (L + R) / 2 by the speakers rule, so the
 * sum never clips. The merger copies that one channel to left and right.
 */
export const MONO_GRAPH = Object.freeze({
  nodes: Object.freeze(['input', 'stereo', 'mono', 'merger', 'output']),
  edges: Object.freeze([
    ['input', 'stereo'], ['stereo', 'output'],
    ['input', 'mono'], ['mono', 'merger:0'], ['mono', 'merger:1'], ['merger', 'output'],
  ]),
});

/**
 * Build the switchable mono stage on `context`. Returns
 * `{ input, output, setMono(on), mono() }`. Insert it as
 * `chain.output -> stage.input`, `stage.output -> destination`. Switching
 * moves two gains with a short ramp, so it does not click.
 */
export function createMonoStage(context, { mono = false, smoothingS = 0.02 } = {}) {
  const input = context.createGain();
  const output = context.createGain();
  const stereo = context.createGain();
  const down = context.createGain();
  down.channelCount = 1;
  down.channelCountMode = 'explicit';
  down.channelInterpretation = 'speakers';
  const merger = context.createChannelMerger(2);

  input.connect(stereo);
  stereo.connect(output);
  input.connect(down);
  down.connect(merger, 0, 0);
  down.connect(merger, 0, 1);
  merger.connect(output);

  let on = Boolean(mono);
  const apply = immediate => {
    const now = context.currentTime ?? 0;
    const targets = [[stereo.gain, on ? 0 : 1], [down.gain, on ? 1 : 0]];
    for (const [param, value] of targets) {
      if (immediate || typeof param.setTargetAtTime !== 'function') param.value = value;
      else param.setTargetAtTime(value, now, smoothingS);
    }
  };
  apply(true);

  return {
    input,
    output,
    nodes: { stereo, mono: down, merger },
    setMono(next) {
      const value = Boolean(next);
      if (value === on) return;
      on = value;
      apply(false);
    },
    mono: () => on,
  };
}
