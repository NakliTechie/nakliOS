// @ts-check
// Names that identify a language pair's deck: the note type's and deck's names, and the file name.
// Anki matches decks by name, so these must stay stable for a pair (ARCHITECTURE §7.2).

import { SAME } from '../state.js';

/** @typedef {import('../state.js').Config} Config */

/**
 * "日本語 (Русский)", or "日本語 (definitions)" in same-language mode.
 * @param {any} meta @param {Config} config
 */
export function pairLabel(meta, config) {
  const native = (/** @type {string | null} */ code) => meta.languages.languages[code ?? '']?.native ?? code;
  return `${native(config.learn)} (${config.know === SAME ? 'definitions' : native(config.know)})`;
}

/** @param {Config} config @param {any} meta */
export function deckName(config, meta) {
  return `AnkiGen::${pairLabel(meta, config)}`;
}

/** ankigen-<learn>-<know>-<data version>.apkg; same-language decks repeat the language. @param {Config} config @param {any} meta */
export function apkgFileName(config, meta) {
  const know = config.know === SAME ? config.learn : config.know;
  return `ankigen-${config.learn}-${know}-${meta.version.data}.apkg`;
}
