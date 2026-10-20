// The reader: which collection is open, which deck, which card, which side, and, in study mode, which card
// is due. No DOM here, so the page and the tests drive the same object.
//
// Two modes over the same deck:
//   browse  every card in deck order (or a saved shuffle), stepping with next/previous; the place is saved
//   study   due cards first, then new cards up to a daily limit, scheduled by FSRS (vendor/ts-fsrs.mjs)
// Saved state (places, study progress) lives in a Store the page persists. Cards are keyed by note GUID and
// card number, so progress survives rebuilding a deck.

import { openApkg } from './apkg.js';
import { renderCard, stripHtml } from './render.js';
import { createBuilder } from './builder.js';
import { resolveMedia, resolveMediaCss } from './media.js';
import { hasMath, renderMath } from './math.js';
import { compareTyped } from './typing.js';
import { createStore } from './store.js';
import { Rating, State, createEmptyCard, fsrs, generatorParameters } from '../vendor/ts-fsrs.mjs';

/** @typedef {import('./apkg.js').Collection} Collection */
/** @typedef {import('./apkg.js').Card} Card */
/** @typedef {{ id: string, name: string, depth: number, cards: number }} DeckRow */

/**
 * @typedef {{ id: string, title: string, native: string, level: string, know: string, file: string,
 *   ankiDeck: string, notes: number, cards: number, bytes: number, sha256: string }} ShelfDeck
 */

/** Saved study state, under the store key "study". */
/** @typedef {{ cards: Record<string, any>, suspended: Record<string, 1>, buried: Record<string, string>, flags: Record<string, number>, days: Record<string, { reviews: number, new: number }>, newPerDay: number }} Study */

const RATINGS = /** @type {const} */ ({ 1: Rating.Again, 2: Rating.Hard, 3: Rating.Good, 4: Rating.Easy });
const scheduler = fsrs(generatorParameters({ enable_fuzz: false }));

/** Local calendar day, YYYY-MM-DD. @param {Date} d */
export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** A short interval: 10m, 3h, 4d, 2mo, 1.5y. @param {number} ms */
export function interval(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${Math.round((d / 365) * 10) / 10}y`;
}

/** A seeded shuffle (mulberry32 + Fisher-Yates), so a saved seed restores the same order. @param {number} n @param {number} seed */
export function shuffled(n, seed) {
  const order = Array.from({ length: n }, (_, i) => i);
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export class Reader {
  /**
   * @param {() => Promise<any>} loadSql  returns an initialised sql.js module
   * @param {(path: string) => Promise<Uint8Array>} fetchBytes  reads a file shipped with the app
   * @param {{ mediaUrl?: (name: string, bytes: Uint8Array) => string, releaseMedia?: () => void,
   *   store?: import('./store.js').Store, now?: () => Date, random?: () => number }} [opts]
   *   mediaUrl turns a package file into a URL the card frame can load (blob: in the page); the default
   *   returns "media:<name>", which tests read. releaseMedia frees those URLs when another package opens.
   *   store holds saved places and study progress (in memory by default). now and random are for tests.
   */
  constructor(loadSql, fetchBytes, opts = {}) {
    this.loadSql = loadSql;
    this.fetchBytes = fetchBytes;
    this.mediaUrl = opts.mediaUrl ?? ((/** @type {string} */ name) => `media:${name}`);
    this.releaseMedia = opts.releaseMedia ?? (() => {});
    this.store = opts.store ?? createStore();
    this.now = opts.now ?? (() => new Date());
    this.random = opts.random ?? Math.random;
    /** @type {Map<string, string | null>} */
    this.urls = new Map();
    /** KaTeX, loaded only for a package whose notes contain formulas. @type {any} */
    this.katex = null;
    this.builder = createBuilder({ fetchBytes, loadSql });
    /** @type {{ source: any, decks: ShelfDeck[] } | null} */
    this.catalog = null;
    /** @type {Collection | null} */
    this.col = null;
    this.fileName = '';
    /** Where the open collection came from: a shelf deck id, or '' for a file the person opened. */
    this.shelfId = '';
    /** The last deck the picker built, for download. @type {{ bytes: Uint8Array, fileName: string } | null} */
    this.built = null;
    /** Cards of the open deck, in deck order. @type {Card[]} */
    this.cards = [];
    this.deckId = '';
    /** browse: position in `order`; study: unused. */
    this.index = 0;
    /** Browse order: indices into `cards` (identity, or a seeded shuffle). @type {number[]} */
    this.order = [];
    this.seed = 0;
    this.mode = /** @type {'browse' | 'study'} */ ('browse');
    /** Study queue: cards due now, then new cards. @type {Card[]} */
    this.queue = [];
    this.side = /** @type {'question' | 'answer'} */ ('question');
    /** What was typed into a type-in answer box before the flip. */
    this.typed = '';
  }

  /** Light (the default) or dark, saved per viewer. */
  get theme() {
    return this.store.get('theme', 'light') === 'dark' ? 'dark' : 'light';
  }

  toggleTheme() {
    this.store.set('theme', this.theme === 'dark' ? 'light' : 'dark');
    return { theme: this.theme };
  }

  // ── Shelf, picker, files ──────────────────────────────────────────────────────────────────────────

  /** Read decks/catalog.json, the onboarded decks. */
  async loadCatalog() {
    this.catalog = JSON.parse(new TextDecoder().decode(await this.fetchBytes('decks/catalog.json')));
    return this.shelf();
  }

  /** The onboarded decks. @returns {ShelfDeck[]} */
  shelf() {
    if (!this.catalog) throw new Error('The deck catalog is not loaded yet.');
    return this.catalog.decks;
  }

  /** Open an onboarded deck by its catalog id, after checking the file against its recorded hash. @param {string} id */
  async openShelfDeck(id) {
    const entry = this.shelf().find((d) => d.id === id);
    if (!entry) throw new Error(`No onboarded deck with id "${id}". Known: ${this.shelf().map((d) => d.id).join(', ')}.`);
    const [bytes] = await Promise.all([this.fetchBytes(entry.file), this.loadSql()]);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hash !== entry.sha256) throw new Error(`${entry.file} does not match its recorded SHA-256; the file is damaged or was replaced.`);
    await this.load(bytes, entry.file);
    this.shelfId = id;
    const deck = this.col?.decks.find((d) => d.name === entry.ankiDeck);
    if (!deck) throw new Error(`${entry.file} has no deck named "${entry.ankiDeck}".`);
    return this.openDeck(deck.id);
  }

  /** Languages and topics the deck picker offers. */
  deckOptions() {
    return this.builder.options();
  }

  /**
   * Build an AnkiGen deck on the device, open it, and show its first card.
   * @param {import('./builder.js').DeckRequest} req
   */
  async buildDeck(req) {
    const built = await this.builder.build(req);
    await this.load(built.bytes, built.fileName);
    this.built = { bytes: built.bytes, fileName: built.fileName };
    const deck = this.col?.decks.find((d) => d.name === built.deckName);
    if (!deck) throw new Error(`The built deck has no deck named "${built.deckName}".`);
    return this.openDeck(deck.id);
  }

  /** The last picker-built deck as a file to save. */
  download() {
    if (!this.built) throw new Error('Build a deck with the picker first; only picker-built decks can be downloaded.');
    return this.built;
  }

  /** Open a package from its bytes; closes whatever was open. @param {Uint8Array} bytes @param {string} fileName */
  async load(bytes, fileName) {
    const col = openApkg(bytes, await this.loadSql());
    if (!this.katex && [...col.notes.values()].some((n) => n.fields.some(hasMath))) {
      this.katex = (await import('../vendor/katex.mjs')).default;
    }
    this.releaseMedia();
    this.urls.clear();
    this.col = col;
    this.fileName = fileName;
    this.shelfId = '';
    this.built = null;
    this.cards = [];
    this.queue = [];
    this.deckId = '';
    this.mode = 'browse';
    return { file: fileName, format: col.format, notes: col.notes.size, cards: col.cards.length, decks: this.decks() };
  }

  /**
   * Decks that hold cards, as a tree in name order. A deck's count includes its subdecks, as in Anki.
   * @returns {DeckRow[]}
   */
  decks() {
    const col = this.need();
    return [...col.decks]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => ({ id: d.id, name: d.name, depth: d.path.length - 1, cards: this.deckCards(d.id).length }))
      .filter((d) => d.cards > 0);
  }

  /** Cards of a deck and its subdecks, in creation order. @param {string} deckId */
  deckCards(deckId) {
    const col = this.need();
    const root = col.decks.find((d) => d.id === deckId);
    if (!root) throw new Error(`No deck with id ${deckId}.`);
    const ids = new Set(col.decks.filter((d) => d.path.length >= root.path.length && root.path.every((p, i) => d.path[i] === p)).map((d) => d.id));
    return col.cards.filter((c) => ids.has(c.did));
  }

  // ── Browse ────────────────────────────────────────────────────────────────────────────────────────

  /** Open a deck to browse, at its saved place and order. @param {string} deckId */
  openDeck(deckId) {
    this.cards = this.deckCards(deckId);
    this.deckId = deckId;
    this.mode = 'browse';
    const place = this.store.get(this.placeKey(), {});
    this.seed = Number(place.seed) || 0;
    this.order = this.seed ? shuffled(this.cards.length, this.seed) : this.cards.map((_, i) => i);
    this.index = Math.min(Math.max(0, Number(place.index) || 0), this.cards.length - 1);
    this.side = 'question';
    this.typed = '';
    this.savePlace();
    return this.current();
  }

  closeDeck() {
    this.cards = [];
    this.queue = [];
    this.deckId = '';
    this.mode = 'browse';
    return this.decks();
  }

  /** @param {number} step */
  move(step) {
    this.needDeck();
    if (this.mode === 'study') throw new Error('In study mode, rate the card to go on (Again, Hard, Good or Easy).');
    this.index = Math.min(this.cards.length - 1, Math.max(0, this.index + step));
    this.side = 'question';
    this.typed = '';
    this.savePlace();
    return this.current();
  }

  /** Turn the card. typed is what the person entered in a type-in answer box, compared on the answer side. @param {string} [typed] */
  flip(typed) {
    this.needDeck();
    if (this.side === 'question') this.typed = typed ?? '';
    this.side = this.side === 'question' ? 'answer' : 'question';
    return this.current();
  }

  /** Shuffle the browse order, or restore deck order; the current card stays current. */
  toggleShuffle() {
    this.needDeck();
    if (this.mode === 'study') throw new Error('Study mode has its own order; shuffle applies when browsing.');
    const card = this.order[this.index];
    this.seed = this.seed ? 0 : 1 + Math.floor(this.random() * 2 ** 31);
    this.order = this.seed ? shuffled(this.cards.length, this.seed) : this.cards.map((_, i) => i);
    this.index = Math.max(0, this.order.indexOf(card));
    this.savePlace();
    return this.current();
  }

  placeKey() {
    const name = this.col?.decks.find((d) => d.id === this.deckId)?.name ?? this.deckId;
    return `place:${name}`;
  }

  savePlace() {
    if (this.mode === 'browse' && this.cards.length) this.store.set(this.placeKey(), { index: this.index, seed: this.seed });
  }

  // ── Study ─────────────────────────────────────────────────────────────────────────────────────────

  /** @returns {Study} */
  study() {
    const s = this.store.get('study', {});
    return { cards: {}, suspended: {}, buried: {}, flags: {}, days: {}, newPerDay: 20, ...s };
  }

  /** @param {Study} s */
  saveStudy(s) {
    this.store.set('study', s);
  }

  /** Stable key for a card: note GUID and card number. @param {Card} card */
  keyOf(card) {
    return `${this.col?.notes.get(card.nid)?.guid ?? card.nid}:${card.ord}`;
  }

  /** Start studying a deck: due cards, then new ones up to today's limit. @param {string} deckId */
  studyDeck(deckId) {
    this.cards = this.deckCards(deckId);
    this.deckId = deckId;
    this.mode = 'study';
    this.buildQueue();
    return this.current();
  }

  buildQueue() {
    const s = this.study();
    const now = this.now();
    const today = dayKey(now);
    const hidden = (/** @type {string} */ k) => s.suspended[k] || s.buried[k] === today;
    const due = [];
    const fresh = [];
    for (const c of this.cards) {
      const k = this.keyOf(c);
      if (hidden(k)) continue;
      const st = s.cards[k];
      if (!st) fresh.push(c);
      else if (new Date(st.due) <= now) due.push(c);
    }
    due.sort((a, b) => +new Date(s.cards[this.keyOf(a)].due) - +new Date(s.cards[this.keyOf(b)].due));
    const room = Math.max(0, s.newPerDay - (s.days[today]?.new ?? 0));
    this.queue = [...due, ...fresh.slice(0, room)];
    this.side = 'question';
    this.typed = '';
  }

  /** Rate the current card and move to the next due one. @param {number} rating 1 Again, 2 Hard, 3 Good, 4 Easy */
  rate(rating) {
    this.needDeck();
    if (this.mode !== 'study') throw new Error('Rating needs study mode; start it with study-deck.');
    const r = RATINGS[/** @type {1 | 2 | 3 | 4} */ (rating)];
    if (r === undefined) throw new Error('Rating must be 1 (Again), 2 (Hard), 3 (Good) or 4 (Easy).');
    const card = this.queue[0];
    if (!card) throw new Error('Nothing is due in this deck now.');
    const s = this.study();
    const now = this.now();
    const today = dayKey(now);
    const k = this.keyOf(card);
    const before = s.cards[k];
    const next = scheduler.next(before ? { ...before, due: new Date(before.due), last_review: before.last_review && new Date(before.last_review) } : createEmptyCard(now), now, r).card;
    s.cards[k] = { ...next, due: next.due.toISOString(), last_review: next.last_review?.toISOString() };
    const day = (s.days[today] ??= { reviews: 0, new: 0 });
    day.reviews++;
    if (!before) day.new++;
    this.saveStudy(s);
    this.queue.shift();
    // A card still in learning comes back this session, after the others.
    if (next.state === State.Learning || next.state === State.Relearning) this.queue.push(card);
    this.side = 'question';
    this.typed = '';
    return this.current();
  }

  /** Hide the current card from study until it is unsuspended (export, edit the file, import). */
  suspendCard() {
    return this.hideCurrent((s, k) => (s.suspended[k] = 1));
  }

  /** Hide the current card from study for the rest of today. */
  buryCard() {
    return this.hideCurrent((s, k) => (s.buried[k] = dayKey(this.now())));
  }

  /** @param {(s: Study, key: string) => void} mark */
  hideCurrent(mark) {
    const card = this.currentCard();
    const s = this.study();
    mark(s, this.keyOf(card));
    this.saveStudy(s);
    if (this.mode === 'study') this.queue = this.queue.filter((c) => c !== card);
    else this.move(1);
    this.side = 'question';
    return this.current();
  }

  /** Set (1–4) or clear (0) the current card's flag. @param {number} flag */
  flagCard(flag) {
    const f = Number(flag);
    if (!(f >= 0 && f <= 4 && Number.isInteger(f))) throw new Error('Flag must be 0 (none) to 4.');
    const card = this.currentCard();
    const s = this.study();
    if (f) s.flags[this.keyOf(card)] = f;
    else delete s.flags[this.keyOf(card)];
    this.saveStudy(s);
    return this.current();
  }

  /** @param {number} limit */
  setNewLimit(limit) {
    const n = Math.round(Number(limit));
    if (!(n >= 0 && n <= 9999)) throw new Error('The daily new-card limit must be between 0 and 9999.');
    const s = this.study();
    s.newPerDay = n;
    this.saveStudy(s);
    if (this.mode === 'study') this.buildQueue();
    return { newPerDay: n };
  }

  /** Today's counts and the streak of days with at least one review, ending today or yesterday. */
  stats() {
    const s = this.study();
    const now = this.now();
    const today = s.days[dayKey(now)] ?? { reviews: 0, new: 0 };
    let streak = 0;
    const d = new Date(now);
    if (!s.days[dayKey(d)]?.reviews) d.setDate(d.getDate() - 1);
    while (s.days[dayKey(d)]?.reviews) {
      streak++;
      d.setDate(d.getDate() - 1);
    }
    return { reviewsToday: today.reviews, newToday: today.new, newPerDay: s.newPerDay, streak, cardsStudied: Object.keys(s.cards).length };
  }

  /** Saved progress as JSON, to keep or move. */
  exportProgress() {
    return this.store.toJSON();
  }

  /** Replace saved progress with an exported file. @param {string} json */
  importProgress(json) {
    this.store.load(json);
    this.store.set('importedAt', this.now().toISOString());
    if (this.cards.length) {
      if (this.mode === 'study') this.buildQueue();
      else this.openDeck(this.deckId);
    }
    return this.stats();
  }

  // ── The card on screen ────────────────────────────────────────────────────────────────────────────

  /** @returns {Card} */
  currentCard() {
    this.needDeck();
    const card = this.mode === 'study' ? this.queue[0] : this.cards[this.order[this.index]];
    if (!card) throw new Error('Nothing is due in this deck now.');
    return card;
  }

  /** The current card, rendered, with a plain-text copy for agents and screen readers. */
  current() {
    const col = this.needDeck();
    const deck = col.decks.find((d) => d.id === this.deckId)?.name ?? '';
    if (this.mode === 'study' && !this.queue.length) return this.doneToday(deck);
    const card = this.currentCard();
    const r = renderCard(col, card);
    const url = (/** @type {string} */ name) => this.urlFor(name);
    let html = this.side === 'question' ? r.question : r.answer;
    if (this.side === 'answer') {
      html = html.replace(/<div id="typeans"><code>([\s\S]*?)<\/code><\/div>/, (_, expected) => compareTyped(this.typed, stripHtml(expected)));
    }
    html = renderMath(resolveMedia(html, url), this.katex);
    const s = this.study();
    const k = this.keyOf(card);
    return {
      mode: this.mode,
      deck,
      position: this.mode === 'study' ? 1 : this.index + 1,
      total: this.mode === 'study' ? this.queue.length : this.cards.length,
      side: this.side,
      shuffled: this.seed !== 0,
      flag: s.flags[k] ?? 0,
      intervals: this.mode === 'study' ? this.intervals(s.cards[k]) : null,
      speech: [...html.matchAll(/class="vc-speak" data-lang="([^"]*)" data-text="([^"]*)"/g)].map((m) => ({ lang: m[1], text: stripHtml(m[2]) })),
      text: plainText(html),
      html,
      css: resolveMediaCss(r.css, url),
      ord: r.ord,
      done: false,
    };
  }

  /** When each rating would next show the card, e.g. { 1: "1m", 3: "2d" }. @param {any} saved */
  intervals(saved) {
    const now = this.now();
    const card = saved ? { ...saved, due: new Date(saved.due), last_review: saved.last_review && new Date(saved.last_review) } : createEmptyCard(now);
    const preview = scheduler.repeat(card, now);
    return Object.fromEntries(Object.entries(RATINGS).map(([n, r]) => [n, interval(+preview[r].card.due - +now)]));
  }

  /** The study screen once nothing is due: when the next card comes back. @param {string} deck */
  doneToday(deck) {
    const s = this.study();
    const next = this.cards
      .map((c) => s.cards[this.keyOf(c)]?.due)
      .filter(Boolean)
      .map((d) => new Date(d))
      .sort((a, b) => +a - +b)[0];
    const when = next ? `The next card is due in ${interval(+next - +this.now())}.` : 'New cards return tomorrow, up to the daily limit.';
    const text = `Done for now. ${when}`;
    return {
      mode: this.mode, deck, position: 0, total: 0, side: this.side, shuffled: false, flag: 0, intervals: null, speech: [],
      text, html: `<div class="vc-done"><p><b>Done for now.</b></p><p>${when}</p></div>`, css: '', ord: 0, done: true,
    };
  }

  /** A loadable URL for a file in the open package, or null when the package has no such file. @param {string} name */
  urlFor(name) {
    if (!this.urls.has(name)) {
      const bytes = this.col?.media.get(name) ?? null;
      this.urls.set(name, bytes ? this.mediaUrl(name, bytes) : null);
    }
    return this.urls.get(name) ?? null;
  }

  need() {
    if (!this.col) throw new Error('No deck file is open. Open an .apkg first.');
    return this.col;
  }

  needDeck() {
    const col = this.need();
    if (!this.cards.length) throw new Error('No deck is open. Pick a deck first.');
    return col;
  }
}

/**
 * Card HTML as one line of text: ruby readings in brackets after their word, a space between blocks.
 * @param {string} html
 */
export function plainText(html) {
  const spaced = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<annotation\b[\s\S]*?<\/annotation>/gi, '')
    .replace(/<button\b[\s\S]*?<\/button>/gi, '')
    .replace(/<rp>[\s\S]*?<\/rp>/gi, '')
    .replace(/<rt>([\s\S]*?)<\/rt>/gi, '($1)')
    .replace(/<\/?(div|p|li|tr|td|th|h\d|hr|ul|ol|table|section|details|summary|br)\b[^>]*>/gi, ' ');
  return stripHtml(spaced).replace(/\s+/g, ' ').trim();
}
