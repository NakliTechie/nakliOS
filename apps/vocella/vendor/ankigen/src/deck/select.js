// @ts-check
// Which concepts become which notes, in which order (ARCHITECTURE §5, DATA_FORMAT §9).
//
// Merge sets and disambiguators belong to the learned language and are computed over its whole
// inventory, not the selection, so a note's identity (key → GUID) and its caption never change when
// modules are added. Merge key: same w, g, art, part of speech, reading and forms ("identical entries";
// the reading keeps Japanese/Chinese homographs such as 今日 きょう / こんにち apart).

import { SAME } from '../state.js';

/** @typedef {import('../data/loader.js').Concepts} Concepts */
/** @typedef {import('../data/loader.js').LanguageData} LanguageData */
/** @typedef {import('../state.js').Config} Config */

/**
 * Shown next to the word when another note of the learned language has the same w:
 * its part of speech if that differs, else its gender, else the first form that differs, else its hint.
 * @typedef {{ kind: 'pos', pos: string } | { kind: 'gender', g: string, art?: string } | { kind: 'form', key: string, value: string } | { kind: 'hint', hint: string }} Disambig
 */

/**
 * @typedef {object} Note
 * @property {string} key           the merge set's first concept in canonical order (seeds the GUID)
 * @property {string[]} conceptIds  the selected members, canonical order
 * @property {any[]} learnEntries   learned-language entries of the members
 * @property {any[]} knowEntries    known-language entries (word or gloss); the learned ones in same-language mode
 * @property {string[]} modules     selected modules the members belong to, canonical order
 * @property {Disambig | null} disambig
 */

/** @param {any} value */
function stableJson(value) {
  return value && typeof value === 'object' ? JSON.stringify(Object.keys(value).sort().map((k) => [k, value[k]])) : '';
}

/** @param {any} c @param {string} code */
export function owns(c, code) {
  return !c.only || c.only.includes(code);
}

/** @type {WeakMap<Map<string, any>, { keyOf: Map<string, string>, disambig: Map<string, Disambig> }>} */
const inventoryCache = new WeakMap();

/**
 * Merge sets and disambiguators of one learned language over its whole inventory.
 * @param {Concepts} concepts @param {LanguageData} learnData @param {any} langReg registry entry of the learned language
 */
export function learnedInventory(concepts, learnData, langReg) {
  const cached = inventoryCache.get(learnData.lang);
  if (cached) return cached;
  /** @type {Map<string, string[]>} */
  const sets = new Map();
  for (const id of concepts.order) {
    const e = learnData.lang.get(id);
    if (!e?.w) continue;
    const c = concepts.byId.get(id)?.c;
    const k = JSON.stringify([e.w.normalize('NFC'), e.g ?? '', e.art ?? '', c.pos, e.read ?? '', stableJson(e.forms)]);
    sets.set(k, [...(sets.get(k) ?? []), id]);
  }
  /** @type {Map<string, string>} */
  const keyOf = new Map();
  /** @type {{ key: string, w: string, pos: string, e: any }[]} */
  const units = [];
  for (const ids of sets.values()) {
    for (const id of ids) keyOf.set(id, ids[0]);
    const e = learnData.lang.get(ids[0]);
    units.push({ key: ids[0], w: e.w.normalize('NFC'), pos: concepts.byId.get(ids[0])?.c.pos, e });
  }
  /** @type {Map<string, Disambig>} */
  const disambig = new Map();
  /** @type {Map<string, typeof units>} */
  const byWord = new Map();
  for (const u of units) byWord.set(u.w, [...(byWord.get(u.w) ?? []), u]);
  for (const group of byWord.values()) {
    if (group.length < 2) continue;
    for (const u of group) {
      const d = disambiguate(u, group.filter((o) => o !== u), langReg);
      if (d) disambig.set(u.key, d);
    }
  }
  const result = { keyOf, disambig };
  inventoryCache.set(learnData.lang, result);
  return result;
}

/**
 * @param {{ pos: string, e: any }} u @param {{ pos: string, e: any }[]} others @param {any} langReg
 * @returns {Disambig | null}
 */
function disambiguate(u, others, langReg) {
  if (others.every((o) => o.pos !== u.pos)) return { kind: 'pos', pos: u.pos };
  const same = others.filter((o) => o.pos === u.pos);
  const gender = (/** @type {any} */ e) => `${e.g ?? ''}|${e.art ?? ''}`;
  if (u.e.g && same.every((o) => gender(o.e) !== gender(u.e))) return { kind: 'gender', g: u.e.g, ...(u.e.art ? { art: u.e.art } : {}) };
  const keys = [...(langReg.forms?.[u.pos]?.keys ?? []), ...Object.keys(u.e.forms ?? {})];
  for (const key of keys) {
    const value = u.e.forms?.[key];
    if (value && same.every((o) => o.e.forms?.[key] !== value)) return { kind: 'form', key, value };
  }
  return u.e.hint ? { kind: 'hint', hint: u.e.hint } : null;
}

/**
 * Whether a concept qualifies for the deck (before merging): a selected module, the 18+ rule, and the
 * entries the mode needs.
 * @param {Config} config @param {any} meta @param {Concepts} concepts
 * @param {LanguageData} learnData @param {LanguageData} knowData
 * @returns {(id: string) => boolean}
 */
function inclusion(config, meta, concepts, learnData, knowData) {
  const selected = new Set(config.modules);
  const adult = new Set(meta.modules.categories.flatMap((/** @type {any} */ cat) => cat.modules.filter((/** @type {any} */ m) => m.adult).map((/** @type {any} */ m) => m.id)));
  const same = config.know === SAME;
  return (id) => {
    const c = concepts.byId.get(id)?.c;
    if (!c || !c.mods.some((/** @type {string} */ m) => selected.has(m))) return false;
    const adultMods = c.mods.filter((/** @type {string} */ m) => adult.has(m));
    if (adultMods.length && !adultMods.some((/** @type {string} */ m) => selected.has(m))) return false;
    const a = learnData.lang.get(id);
    if (same) return Boolean(a?.w && a.def);
    const b = knowData.lang.get(id);
    return owns(c, /** @type {string} */ (config.learn)) && Boolean(a?.w) && Boolean(b?.w || b?.gl);
  };
}

/**
 * The deck's notes in canonical order.
 * @param {Config} config @param {any} meta @param {Concepts} concepts
 * @param {LanguageData} learnData @param {LanguageData} knowData the learned language's data in same-language mode
 * @returns {Note[]}
 */
export function selectNotes(config, meta, concepts, learnData, knowData) {
  if (!config.learn || !config.know) return [];
  const learnReg = meta.languages.languages[config.learn];
  const { keyOf, disambig } = learnedInventory(concepts, learnData, learnReg);
  const included = inclusion(config, meta, concepts, learnData, knowData);
  const selected = new Set(config.modules);
  /** @type {Map<string, string[]>} */
  const members = new Map(); // merge key → selected members, in canonical (= first-seen) order
  for (const id of concepts.order) {
    if (!included(id)) continue;
    const key = keyOf.get(id) ?? id;
    members.set(key, [...(members.get(key) ?? []), id]);
  }
  const moduleRank = new Map(meta.modules.categories.flatMap((/** @type {any} */ cat) => cat.modules.map((/** @type {any} */ m) => m.id)).map((/** @type {string} */ id, /** @type {number} */ i) => [id, i]));
  return [...members.entries()].map(([key, ids]) => ({
    key,
    conceptIds: ids,
    learnEntries: ids.map((id) => learnData.lang.get(id)),
    knowEntries: ids.map((id) => knowData.lang.get(id)),
    modules: [...new Set(ids.flatMap((id) => concepts.byId.get(id)?.c.mods.filter((/** @type {string} */ m) => selected.has(m))))].sort((a, b) => (moduleRank.get(a) ?? 0) - (moduleRank.get(b) ?? 0)),
    disambig: disambig.get(key) ?? null,
  }));
}

/**
 * How many concepts each module would contribute for the chosen languages (before merging):
 * the module tree shows these instead of the target sizes in modules.json.
 * @param {Config} config @param {any} meta @param {Concepts} concepts @param {LanguageData} learnData @param {LanguageData} knowData
 * @returns {Map<string, number>}
 */
export function moduleCounts(config, meta, concepts, learnData, knowData) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  if (!config.learn || !config.know) return counts;
  const all = meta.modules.categories.flatMap((/** @type {any} */ cat) => cat.modules.map((/** @type {any} */ m) => m.id));
  const included = inclusion({ ...config, modules: all }, meta, concepts, learnData, knowData);
  for (const id of concepts.order) {
    if (!included(id)) continue;
    for (const m of concepts.byId.get(id)?.c.mods ?? []) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return counts;
}

/**
 * Per module, the included concepts that only some languages have (`only`: country-specific institutions,
 * untranslatable words), with the first one's word as an example. The module tree explains them.
 * @param {Config} config @param {any} meta @param {Concepts} concepts @param {LanguageData} learnData @param {LanguageData} knowData
 * @returns {Map<string, { count: number, example: string }>}
 */
export function localTerms(config, meta, concepts, learnData, knowData) {
  /** @type {Map<string, { count: number, example: string }>} */
  const terms = new Map();
  if (!config.learn || !config.know) return terms;
  const all = meta.modules.categories.flatMap((/** @type {any} */ cat) => cat.modules.map((/** @type {any} */ m) => m.id));
  const included = inclusion({ ...config, modules: all }, meta, concepts, learnData, knowData);
  for (const id of concepts.order) {
    const c = concepts.byId.get(id)?.c;
    if (!c?.only || !included(id)) continue;
    for (const m of c.mods) {
      const t = terms.get(m);
      terms.set(m, { count: (t?.count ?? 0) + 1, example: t?.example ?? learnData.lang.get(id)?.w });
    }
  }
  return terms;
}
