// The reader: which collection is open, which deck, which card, which side. No DOM here, so the page and
// the tests drive the same object.

import { openApkg } from './apkg.js';
import { renderCard, stripHtml } from './render.js';

/** @typedef {import('./apkg.js').Collection} Collection */
/** @typedef {{ id: string, name: string, depth: number, cards: number }} DeckRow */

/**
 * @typedef {{ id: string, title: string, native: string, level: string, know: string, file: string,
 *   ankiDeck: string, notes: number, cards: number, bytes: number, sha256: string }} ShelfDeck
 */

export class Reader {
  /**
   * @param {() => Promise<any>} loadSql  returns an initialised sql.js module
   * @param {(path: string) => Promise<Uint8Array>} fetchBytes  reads a file shipped with the app
   */
  constructor(loadSql, fetchBytes) {
    this.loadSql = loadSql;
    this.fetchBytes = fetchBytes;
    /** @type {{ source: any, decks: ShelfDeck[] } | null} */
    this.catalog = null;
    /** @type {Collection | null} */
    this.col = null;
    this.fileName = '';
    /** Where the open collection came from: a shelf deck id, or '' for a file the person opened. */
    this.shelfId = '';
    /** @type {import('./apkg.js').Card[]} */
    this.cards = [];
    this.deckId = '';
    this.index = 0;
    this.side = /** @type {'question' | 'answer'} */ ('question');
  }

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

  /** Open a package from its bytes; closes whatever was open. @param {Uint8Array} bytes @param {string} fileName */
  async load(bytes, fileName) {
    const col = openApkg(bytes, await this.loadSql());
    this.col = col;
    this.fileName = fileName;
    this.shelfId = '';
    this.cards = [];
    this.deckId = '';
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

  /** @param {string} deckId */
  openDeck(deckId) {
    this.cards = this.deckCards(deckId);
    this.deckId = deckId;
    this.index = 0;
    this.side = 'question';
    return this.current();
  }

  closeDeck() {
    this.cards = [];
    this.deckId = '';
    return this.decks();
  }

  /** @param {number} step */
  move(step) {
    this.needDeck();
    this.index = Math.min(this.cards.length - 1, Math.max(0, this.index + step));
    this.side = 'question';
    return this.current();
  }

  flip() {
    this.needDeck();
    this.side = this.side === 'question' ? 'answer' : 'question';
    return this.current();
  }

  /** The current card, rendered, with a plain-text copy for agents and screen readers. */
  current() {
    const col = this.needDeck();
    const card = this.cards[this.index];
    const r = renderCard(col, card);
    const html = this.side === 'question' ? r.question : r.answer;
    return {
      deck: col.decks.find((d) => d.id === this.deckId)?.name ?? '',
      position: this.index + 1,
      total: this.cards.length,
      side: this.side,
      text: plainText(html),
      html,
      css: r.css,
      ord: r.ord,
    };
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
    .replace(/<rp>[\s\S]*?<\/rp>/gi, '')
    .replace(/<rt>([\s\S]*?)<\/rt>/gi, '($1)')
    .replace(/<\/?(div|p|li|tr|td|th|h\d|hr|ul|ol|table|section|details|summary)\b[^>]*>/gi, ' ');
  return stripHtml(spaced).replace(/\s+/g, ' ').trim();
}
