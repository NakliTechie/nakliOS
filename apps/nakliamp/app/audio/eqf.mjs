// Winamp `.eqf` EQ presets (parity row S7): import and export.
//
// Format, as read by the `winamp-eqf` parser in the Webamp monorepo (MIT):
//   "Winamp EQ library file v1.1" (27 bytes), then 0x1A "!--" (4 bytes),
//   then one or more 268-byte entries:
//     name: 257 bytes, NUL-terminated, Latin-1
//     10 band bytes (60, 170, 310, 600, 1k, 3k, 6k, 12k, 14k, 16k Hz)
//     1 preamp byte
// A band byte runs 0..63: 0 is the top of the slider (+12 dB), 31 is 0 dB,
// 63 the bottom (-12 dB). The same layout serves single-preset `.eqf` files
// and the `winamp.q1` library.
//
// Winamp's ten bands map to NakliAmp's ten (70 .. 16k Hz) by position: the
// centres differ by at most 10 Hz below 1 kHz and match above it.
//
// Headless and pure.

import { EQ_MIN_DB, EQ_MAX_DB, eqGains } from './eq-presets.mjs';

export const EQF_HEADER = 'Winamp EQ library file v1.1';
const HEADER_TAIL = [0x1a, 0x21, 0x2d, 0x2d]; // ^Z ! - -
const NAME_BYTES = 257;
const VALUE_BYTES = 11;
const ENTRY_BYTES = NAME_BYTES + VALUE_BYTES;
const MAX_ENTRIES = 1024;

export class EqfFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EqfFormatError';
    this.code = 'ERR_NAKLIAMP_EQF_INVALID';
  }
}

/**
 * A Winamp band byte (0..63) to dB on the -12..12 scale. The scale is
 * piecewise so that 0, 31 and 63 land exactly on +12, 0 and -12 dB.
 */
export function eqfByteToDb(byte) {
  const value = Math.max(0, Math.min(63, Number(byte) | 0));
  const db = value <= 31 ? ((31 - value) * EQ_MAX_DB) / 31 : ((31 - value) * -EQ_MIN_DB) / 32;
  return Math.round(db * 100) / 100;
}

/** dB (clamped to -12..12) to the nearest Winamp band byte. */
export function dbToEqfByte(db) {
  const value = Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, Number(db) || 0));
  return value >= 0 ? Math.round(31 - (value * 31) / EQ_MAX_DB) : Math.round(31 - (value * 32) / -EQ_MIN_DB);
}

/**
 * Parse `.eqf` bytes (ArrayBuffer or Uint8Array).
 * Returns `[{ name, gains: [10 dB values], preampDb }]`.
 * Throws EqfFormatError when the header is wrong or no whole entry follows.
 */
export function parseEqf(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const header = String.fromCharCode(...bytes.subarray(0, EQF_HEADER.length));
  if (header !== EQF_HEADER) throw new EqfFormatError('Not a Winamp EQ file: the header is missing.');
  let offset = EQF_HEADER.length + HEADER_TAIL.length;
  const presets = [];
  while (offset + ENTRY_BYTES <= bytes.length && presets.length < MAX_ENTRIES) {
    const nameField = bytes.subarray(offset, offset + NAME_BYTES);
    const end = nameField.indexOf(0);
    const name = new TextDecoder('latin1').decode(nameField.subarray(0, end < 0 ? NAME_BYTES : end)).trim();
    const values = bytes.subarray(offset + NAME_BYTES, offset + ENTRY_BYTES);
    presets.push({
      name: name || `Preset ${presets.length + 1}`,
      gains: [...values.subarray(0, 10)].map(eqfByteToDb),
      preampDb: eqfByteToDb(values[10]),
    });
    offset += ENTRY_BYTES;
  }
  if (!presets.length) throw new EqfFormatError('The Winamp EQ file holds no complete preset.');
  return presets;
}

/**
 * The settings patch that applies one imported preset as the custom curve.
 * Winamp's preamp has no place in NakliAmp's EQ, so it is returned beside the
 * patch for the caller to show or fold into the ReplayGain preamp.
 */
export function eqfToSettings(preset) {
  return {
    patch: { eq: { enabled: true, preset: 'custom', custom: [...preset.gains] } },
    preampDb: preset.preampDb,
  };
}

/**
 * Write presets as `.eqf` bytes. `presets` is `[{ name, gains, preampDb }]`;
 * names are cut to 256 Latin-1 bytes (characters outside Latin-1 become `?`).
 */
export function writeEqf(presets) {
  if (!Array.isArray(presets) || !presets.length) throw new EqfFormatError('There is no preset to write.');
  const out = new Uint8Array(EQF_HEADER.length + HEADER_TAIL.length + presets.length * ENTRY_BYTES);
  for (let i = 0; i < EQF_HEADER.length; i += 1) out[i] = EQF_HEADER.charCodeAt(i);
  out.set(HEADER_TAIL, EQF_HEADER.length);
  let offset = EQF_HEADER.length + HEADER_TAIL.length;
  for (const preset of presets) {
    const name = String(preset.name ?? 'NakliAmp').slice(0, NAME_BYTES - 1);
    for (let i = 0; i < name.length; i += 1) {
      const code = name.charCodeAt(i);
      out[offset + i] = code <= 0xff ? code : 0x3f;
    }
    const gains = Array.isArray(preset.gains) ? preset.gains : [];
    for (let band = 0; band < 10; band += 1) out[offset + NAME_BYTES + band] = dbToEqfByte(gains[band] ?? 0);
    out[offset + NAME_BYTES + 10] = dbToEqfByte(preset.preampDb ?? 0);
    offset += ENTRY_BYTES;
  }
  return out;
}

/**
 * The current EQ setting as `.eqf` bytes. Exports the selected curve even
 * when the EQ is switched off, because that is the curve you are looking at.
 */
export function exportCurrentEq(eq, { name = 'NakliAmp', preampDb = 0 } = {}) {
  return writeEqf([{ name, gains: eqGains({ ...eq, enabled: true }), preampDb }]);
}
