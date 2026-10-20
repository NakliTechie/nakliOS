// The viewer's saved state: reading places, shuffle seeds, study progress and settings, as one JSON object.
// Where it lives is the page's choice (app.js): NakliOS storage when hosted, the browser's local storage
// standalone. Reads are synchronous from memory; every change calls `changed`, and the page's saver
// decides when to write.

/**
 * @param {{ changed?: () => void }} [opts]
 */
export function createStore(opts = {}) {
  /** @type {Record<string, any>} */
  let data = {};
  return {
    /** @param {string} key @param {any} [fallback] */
    get(key, fallback) {
      return key in data ? data[key] : fallback;
    },
    /** @param {string} key @param {any} value */
    set(key, value) {
      data[key] = value;
      opts.changed?.();
    },
    /** Replace everything, e.g. from a file or an import. @param {string | null | undefined} text */
    load(text) {
      if (!text) return;
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Saved progress is not a JSON object.');
      data = parsed;
    },
    toJSON() {
      return JSON.stringify(data);
    },
  };
}

/** @typedef {ReturnType<typeof createStore>} Store */
