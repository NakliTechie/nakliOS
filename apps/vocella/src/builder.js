// Build any AnkiGen deck on the device with AnkiGen's own code (vendor/ankigen/, unmodified): the same
// path as AnkiGen's tools/apkg.mjs, from a configuration hash to .apkg bytes. Vocella then opens those
// bytes like any other package.

import { createLoader } from '../vendor/ankigen/src/data/loader.js';
import { SAME, decodeHash } from '../vendor/ankigen/src/state.js';
import { buildDeck } from '../vendor/ankigen/src/deck/deck.js';
import { buildApkg } from '../vendor/ankigen/src/deck/apkg.js';
import { apkgFileName, deckName } from '../vendor/ankigen/src/deck/names.js';

export { SAME };

const BASE = 'vendor/ankigen/';

/**
 * @typedef {{ code: string, name: string, native: string }} Language
 * @typedef {{ id: string, name: string, category: string, size: number, adult: boolean }} Module
 * @typedef {{ learn: string, know: string, modules: string[], now?: number }} DeckRequest
 */

/**
 * @param {{ fetchBytes: (path: string) => Promise<Uint8Array>, loadSql: () => Promise<any> }} deps
 */
export function createBuilder({ fetchBytes, loadSql }) {
  const text = new TextDecoder();
  /** @param {string} p */
  const read = async (p) => {
    try {
      return text.decode(await fetchBytes(BASE + p));
    } catch {
      return null; // AnkiGen's loader treats a missing file as "no data"
    }
  };
  const loader = createLoader({
    fetchJson: async (p) => {
      const t = await read(p);
      return t === null ? null : JSON.parse(t);
    },
    fetchText: read,
  });

  return {
    /** The languages and modules a deck can be built from, in AnkiGen's order. */
    async options() {
      const meta = await loader.getMeta();
      /** @type {Language[]} */
      const languages = meta.languages.active.map((/** @type {string} */ code) => {
        const l = meta.languages.languages[code];
        return { code, name: l.name, native: l.native };
      });
      /** @type {Module[]} */
      const modules = meta.modules.categories.flatMap((/** @type {any} */ cat) =>
        cat.modules.map((/** @type {any} */ m) => ({ id: m.id, name: m.name, category: cat.name, size: m.size, adult: Boolean(m.adult) })),
      );
      return { languages, modules, data: meta.version.data };
    },

    /**
     * Build a deck. `know` is a language code, or "=" for definitions in the learned language.
     * @param {DeckRequest} req
     */
    async build({ learn, know, modules, now = Date.now() }) {
      const meta = await loader.getMeta();
      const hash = `#v1&l=${encodeURIComponent(learn)}&k=${encodeURIComponent(know)}&m=${modules.map(encodeURIComponent).join(',')}`;
      const config = decodeHash(hash, meta);
      if (!config?.learn || !config.know || !config.modules.length) {
        throw new Error('Pick a language to learn, a language you know, and at least one topic.');
      }
      const dropped = modules.filter((m) => !config.modules.includes(m));
      if (config.learn !== learn || config.know !== know || dropped.length) {
        throw new Error(`AnkiGen does not offer this combination${dropped.length ? ` (topics: ${dropped.join(', ')})` : ''}.`);
      }
      const [concepts, learnData, css] = await Promise.all([loader.getConcepts(), loader.getLanguage(config.learn), loader.getCardCss()]);
      const knowData = config.know === SAME ? learnData : await loader.getLanguage(config.know);
      const deck = buildDeck({ config, meta, concepts, learnData, knowData, css: css ?? '' });
      if (!deck.notes.length) throw new Error('AnkiGen has no words for this combination yet.');
      const bytes = await buildApkg({ SQL: await loadSql(), config, meta, deck, now });
      return { bytes, fileName: apkgFileName(config, meta), deckName: deckName(config, meta), notes: deck.notes.length };
    },
  };
}
