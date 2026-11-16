// settings.mjs — the person's settings, one record in localStorage (`nakliamp:settings`).
//
// Every read and write is wrapped, so blocked storage (a private window, a sandboxed
// iframe) leaves the player on its defaults instead of breaking it. Every value is
// validated: a wrong type or unknown enum falls back to the current value, and numbers
// are clamped to their range.

export const SETTINGS_KEY = 'nakliamp:settings';
export const LEGACY_VISUALISER_KEY = 'nakliamp:visualiser';
export const EQ_BANDS = 10;
export const EQ_PRESET_NAMES = Object.freeze([
  'flat', 'rock', 'pop', 'jazz', 'classical', 'bass-boost', 'treble-boost', 'vocal', 'electronic', 'acoustic', 'custom',
]);

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system',
  eq: Object.freeze({ enabled: false, preset: 'flat', custom: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }),
  replayGain: Object.freeze({ mode: 'auto', preampDb: 0, preventClipping: true }),
  crossfadeS: 0,
  gapless: 'albums',
  shuffle: 'off',
  repeat: 'off',
  loudnessScan: 'idle',
  visualiser: 'bars',
  miniPlayer: false,
  seekStepS: 5,
  // v1.x: volume floor in dB (S5), playback speed (P9), mono downmix (P11), output device (S6).
  volumeFloorDb: -50,
  speed: 1,
  mono: false,
  outputDeviceId: '',
  // Scale the visualiser's input by the volume (cliamp's volume-linked visualiser).
  visualiserLinkVolume: false,
});

const ENUMS = {
  theme: ['system', 'light', 'dark'],
  gapless: ['off', 'albums', 'always'],
  shuffle: ['off', 'tracks', 'albums'],
  repeat: ['off', 'all', 'one'],
  loudnessScan: ['off', 'idle'],
  replayGainMode: ['off', 'track', 'album', 'auto'],
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const num = (v, lo, hi, fallback) => (isNum(v) ? clamp(v, lo, hi) : fallback);

function clone(s) {
  return { ...s, eq: { ...s.eq, custom: s.eq.custom.slice() }, replayGain: { ...s.replayGain } };
}

/** Validators for the top-level scalar fields: (value, current) => accepted value. */
const SCALAR_FIELDS = {
  theme: (v, cur) => pick(v, ENUMS.theme, cur),
  crossfadeS: (v, cur) => num(v, 0, 12, cur),
  gapless: (v, cur) => pick(v, ENUMS.gapless, cur),
  shuffle: (v, cur) => pick(v, ENUMS.shuffle, cur),
  repeat: (v, cur) => pick(v, ENUMS.repeat, cur),
  loudnessScan: (v, cur) => pick(v, ENUMS.loudnessScan, cur),
  visualiser: (v, cur) => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : cur),
  miniPlayer: (v, cur) => bool(v, cur),
  seekStepS: (v, cur) => num(v, 1, 60, cur),
  volumeFloorDb: (v, cur) => num(v, -90, -1, cur),
  speed: (v, cur) => (isNum(v) ? Math.round(clamp(v, 0.5, 2) * 100) / 100 : cur),
  mono: (v, cur) => bool(v, cur),
  outputDeviceId: (v, cur) => (typeof v === 'string' && v.length <= 256 ? v : cur),
  visualiserLinkVolume: (v, cur) => bool(v, cur),
};

function mergeEq(eq, patchEq) {
  if (!patchEq || typeof patchEq !== 'object') return;
  eq.enabled = bool(patchEq.enabled, eq.enabled);
  eq.preset = pick(patchEq.preset, EQ_PRESET_NAMES, eq.preset);
  if (Array.isArray(patchEq.custom) && patchEq.custom.length === EQ_BANDS) {
    eq.custom = patchEq.custom.map((v, i) => num(v, -12, 12, eq.custom[i]));
  }
}

function mergeReplayGain(rg, patchRg) {
  if (!patchRg || typeof patchRg !== 'object') return;
  rg.mode = pick(patchRg.mode, ENUMS.replayGainMode, rg.mode);
  rg.preampDb = num(patchRg.preampDb, -15, 15, rg.preampDb);
  rg.preventClipping = bool(patchRg.preventClipping, rg.preventClipping);
}

/** Merge `patch` onto `base`, validating every field. Unknown keys are dropped. */
export function mergeSettings(base, patch) {
  const out = clone(base);
  if (!patch || typeof patch !== 'object') return out;
  mergeEq(out.eq, patch.eq);
  mergeReplayGain(out.replayGain, patch.replayGain);
  for (const [field, accept] of Object.entries(SCALAR_FIELDS)) {
    if (field in patch) out[field] = accept(patch[field], out[field]);
  }
  return out;
}

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** A settings store over any Storage-like object. The module-level functions use localStorage. */
export function createSettings({ storage = defaultStorage(), key = SETTINGS_KEY } = {}) {
  const listeners = new Set();
  let cached = null;

  function read() {
    let stored = null;
    let legacyVisualiser = null;
    try {
      const raw = storage?.getItem(key);
      if (raw) stored = JSON.parse(raw);
    } catch { stored = null; }
    if (!stored || typeof stored.visualiser !== 'string') {
      try { legacyVisualiser = storage?.getItem(LEGACY_VISUALISER_KEY) ?? null; } catch { legacyVisualiser = null; }
    }
    let s = mergeSettings(DEFAULT_SETTINGS, stored);
    if (legacyVisualiser) s = mergeSettings(s, { visualiser: legacyVisualiser });
    return s;
  }

  function load() {
    if (!cached) cached = read();
    return clone(cached);
  }

  function save(patch) {
    const before = load();
    cached = mergeSettings(before, patch);
    try { storage?.setItem(key, JSON.stringify(cached)); } catch { /* blocked storage keeps the change for this session only */ }
    const next = clone(cached);
    for (const fn of listeners) {
      try { fn(clone(cached), before); } catch (error) { console.warn('[nakliamp] settings listener failed', error); }
    }
    return next;
  }

  return {
    load,
    save,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    reload() { cached = null; return load(); },
  };
}

let shared = null;
const store = () => (shared ??= createSettings());

export const loadSettings = () => store().load();
export const saveSettings = patch => store().save(patch);
export const onSettings = fn => store().onChange(fn);
