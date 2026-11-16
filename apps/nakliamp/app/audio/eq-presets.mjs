// 10-band graphic EQ: band table and presets.
//
// Band centres, Q and preset curves are cliamp's (bjarneo/cliamp,
// ui/model/eq_presets.go), taken verbatim as plan/cliamp-parity.md decided.
// cliamp ships six more presets (Hip-Hop, R&B, Loudness, Late Night, Podcast,
// Small Speakers); the v1 contract names ten plus Custom, so those ten are here.
//
// Headless: no DOM, no Web Audio. Pure data plus two lookups.

export const EQ_BANDS_HZ = Object.freeze([70, 180, 320, 600, 1000, 3000, 6000, 12000, 14000, 16000]);
export const EQ_Q = 1.4;
export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;

const curve = values => Object.freeze(values);

export const EQ_PRESETS = Object.freeze({
  flat: Object.freeze({ label: 'Flat', gains: curve([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }),
  rock: Object.freeze({ label: 'Rock', gains: curve([5, 4, 2, -1, -2, 2, 4, 5, 5, 5]) }),
  pop: Object.freeze({ label: 'Pop', gains: curve([-1, 2, 4, 5, 4, 1, -1, -1, 1, 2]) }),
  jazz: Object.freeze({ label: 'Jazz', gains: curve([3, 4, 2, 1, -1, -1, 1, 2, 3, 4]) }),
  classical: Object.freeze({ label: 'Classical', gains: curve([3, 2, 1, 0, -1, -1, 0, 2, 3, 4]) }),
  'bass-boost': Object.freeze({ label: 'Bass boost', gains: curve([8, 6, 4, 2, 0, 0, 0, 0, 0, 0]) }),
  'treble-boost': Object.freeze({ label: 'Treble boost', gains: curve([0, 0, 0, 0, 0, 1, 3, 5, 6, 7]) }),
  vocal: Object.freeze({ label: 'Vocal', gains: curve([-2, -1, 1, 4, 5, 4, 2, 0, -1, -2]) }),
  electronic: Object.freeze({ label: 'Electronic', gains: curve([6, 4, 1, -1, -2, 1, 3, 4, 5, 6]) }),
  acoustic: Object.freeze({ label: 'Acoustic', gains: curve([3, 3, 2, 0, 1, 2, 3, 3, 2, 1]) }),
});

/** Preset ids in display order; `custom` last, as it reads the saved curve. */
export const EQ_PRESET_IDS = Object.freeze([...Object.keys(EQ_PRESETS), 'custom']);

function clampDb(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, number));
}

/** A custom curve made safe: exactly ten finite values inside -12..12 dB. */
export function normaliseCustom(custom) {
  const source = Array.isArray(custom) ? custom : [];
  return EQ_BANDS_HZ.map((_, index) => clampDb(source[index]));
}

/**
 * The ten band gains in dB that the chain should apply for an EQ setting.
 * A disabled EQ is ten zeros: the filters stay in the graph at unity, so
 * turning it on or off moves gains smoothly rather than rewiring nodes.
 * An unknown preset name falls back to flat rather than throwing, because a
 * stale setting must not stop playback.
 */
export function eqGains(eq = {}) {
  if (!eq || !eq.enabled) return EQ_BANDS_HZ.map(() => 0);
  if (eq.preset === 'custom') return normaliseCustom(eq.custom);
  const preset = EQ_PRESETS[eq.preset] ?? EQ_PRESETS.flat;
  return [...preset.gains];
}
