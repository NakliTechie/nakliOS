// Read an Anki package (.apkg or .colpkg) into plain objects: decks, note types, notes and cards.
//
// A package is a zip. Which collection file it holds depends on the Anki version that wrote it:
//   collection.anki21b  current Anki (2.1.50+): zstd-compressed SQLite, schema 18; note types, templates,
//                       fields and decks live in their own tables, with settings as protobuf blobs.
//   collection.anki21   older Anki 2.1 (and current Anki's "legacy" export): plain SQLite, schema 11.
//   collection.anki2    Anki 2.0 and AnkiGen: plain SQLite, schema 11; note types and decks as JSON in `col`.
// Packages with a newer file also carry a dummy collection.anki2 whose one note says "please update Anki",
// so the newest file present wins.
//
// sql.js is passed in (the page loads it with a script tag, the tests load it in Node).

import { unzipSync } from '../vendor/fflate.js';
import { decompress } from '../vendor/fzstd.js';

/** @typedef {{ id: string, name: string, path: string[] }} Deck */
/** @typedef {{ ord: number, name: string, qfmt: string, afmt: string }} Template */
/** @typedef {{ id: string, name: string, cloze: boolean, css: string, fields: string[], templates: Template[] }} NoteType */
/** @typedef {{ id: string, guid: string, mid: string, fields: string[], tags: string }} Note */
/** @typedef {{ id: string, nid: string, did: string, ord: number }} Card */
/** @typedef {{ format: string, decks: Deck[], noteTypes: Map<string, NoteType>, notes: Map<string, Note>, cards: Card[] }} Collection */

export class ApkgError extends Error {}

const COLLECTIONS = ['collection.anki21b', 'collection.anki21', 'collection.anki2'];

/**
 * @param {Uint8Array} bytes  the package file
 * @param {any} SQL  an initialised sql.js module
 * @returns {Collection}
 */
export function openApkg(bytes, SQL) {
  let zip;
  try {
    zip = unzipSync(bytes, { filter: (f) => COLLECTIONS.includes(f.name) });
  } catch {
    throw new ApkgError('This file is not an Anki package (.apkg or .colpkg): it is not a zip archive.');
  }
  const name = COLLECTIONS.find((n) => zip[n]);
  if (!name) throw new ApkgError('This zip holds no Anki collection (no collection.anki21b, .anki21 or .anki2 inside).');

  let data = zip[name];
  if (name === 'collection.anki21b') {
    try {
      data = decompress(data);
    } catch (e) {
      throw new ApkgError(`This package comes from a newer Anki, and its collection could not be decompressed (${e.message}).`);
    }
  }

  const db = new SQL.Database(data);
  try {
    const ver = rows(db, 'select ver from col')[0]?.[0];
    const schema = ver >= 15 ? readSchema18(db) : readSchema11(db);
    schema.decks = withParents(schema.decks);
    return { format: `${name.slice('collection.'.length)} (schema ${ver})`, ...schema, ...readNotesAndCards(db) };
  } catch (e) {
    if (e instanceof ApkgError) throw e;
    throw new ApkgError(`The collection inside this package could not be read (${e.message}).`);
  } finally {
    db.close();
  }
}

/** @param {any} db @param {string} sql @returns {any[][]} */
function rows(db, sql) {
  return db.exec(sql)[0]?.values ?? [];
}

/** Schema 11: note types and decks are JSON objects in the single `col` row. @param {any} db */
function readSchema11(db) {
  const [models, decks] = rows(db, 'select models, decks from col')[0];
  /** @type {Map<string, NoteType>} */
  const noteTypes = new Map();
  for (const m of Object.values(JSON.parse(models))) {
    noteTypes.set(String(m.id), {
      id: String(m.id),
      name: m.name,
      cloze: m.type === 1,
      css: m.css ?? '',
      fields: [...m.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name),
      templates: m.tmpls.map((/** @type {any} */ t) => ({ ord: t.ord, name: t.name, qfmt: t.qfmt, afmt: t.afmt })),
    });
  }
  const deckList = Object.values(JSON.parse(decks)).map((d) => deck(String(d.id), d.name.split('::')));
  return { noteTypes, decks: deckList };
}

/** Schema 18: separate tables, settings as protobuf. @param {any} db */
function readSchema18(db) {
  /** @type {Map<string, NoteType>} */
  const noteTypes = new Map();
  for (const [id, name, config] of rows(db, 'select id, name, config from notetypes')) {
    const c = protobuf(config);
    noteTypes.set(String(id), { id: String(id), name, cloze: c.int(1) === 1, css: c.str(3), fields: [], templates: [] });
  }
  for (const [ntid, , name] of rows(db, 'select ntid, ord, name from fields order by ntid, ord')) {
    noteTypes.get(String(ntid))?.fields.push(name);
  }
  for (const [ntid, ord, name, config] of rows(db, 'select ntid, ord, name, config from templates order by ntid, ord')) {
    const c = protobuf(config);
    noteTypes.get(String(ntid))?.templates.push({ ord, name, qfmt: c.str(1), afmt: c.str(2) });
  }
  const decks = rows(db, 'select id, name from decks').map(([id, name]) => deck(String(id), name.split('\x1f')));
  return { noteTypes, decks };
}

/** @param {string} id @param {string[]} path @returns {Deck} */
const deck = (id, path) => ({ id, name: path.join('::'), path });

/**
 * Add parent decks a package names only through a child (AnkiGen writes "AnkiGen::Español (English)" with
 * no "AnkiGen" row); Anki creates them on import. Their ids are "parent:<name>", never a real deck id.
 * @param {Deck[]} decks
 */
function withParents(decks) {
  const names = new Set(decks.map((d) => d.name));
  const out = [...decks];
  for (const d of decks) {
    for (let i = 1; i < d.path.length; i++) {
      const path = d.path.slice(0, i);
      const name = path.join('::');
      if (!names.has(name)) {
        names.add(name);
        out.push(deck(`parent:${name}`, path));
      }
    }
  }
  return out;
}

/** Notes and cards have the same columns in both schemas. IDs stay strings: they exceed 2^53 in some decks. @param {any} db */
function readNotesAndCards(db) {
  /** @type {Map<string, Note>} */
  const notes = new Map();
  for (const [id, guid, mid, flds, tags] of rows(db, 'select cast(id as text), guid, cast(mid as text), flds, tags from notes')) {
    notes.set(id, { id, guid, mid, fields: flds.split('\x1f'), tags: tags.trim() });
  }
  // A card in a filtered deck keeps its home deck in odid.
  const cards = rows(db, 'select cast(id as text), cast(nid as text), cast(case when odid != 0 then odid else did end as text), ord from cards order by id').map(
    ([id, nid, did, ord]) => ({ id, nid, did, ord }),
  );
  return { notes, cards };
}

/**
 * A minimal protobuf reader: the last value of each top-level field number. Enough for the string and
 * varint settings Vocella reads (note type kind and CSS, template formats).
 * @param {Uint8Array} buf
 */
export function protobuf(buf) {
  /** @type {Map<number, number | Uint8Array>} */
  const fields = new Map();
  let i = 0;
  const varint = () => {
    let n = 0;
    let mul = 1;
    for (;;) {
      const b = buf[i++];
      n += (b & 0x7f) * mul;
      if (b < 0x80) return n;
      mul *= 128;
    }
  };
  while (i < buf.length) {
    const key = varint();
    const wire = key % 8;
    const num = Math.floor(key / 8);
    if (wire === 0) fields.set(num, varint());
    else if (wire === 2) {
      const len = varint();
      fields.set(num, buf.subarray(i, i + len));
      i += len;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new ApkgError(`Unexpected protobuf wire type ${wire}.`);
  }
  const decoder = new TextDecoder();
  return {
    /** @param {number} n */
    str: (n) => {
      const v = fields.get(n);
      return v instanceof Uint8Array ? decoder.decode(v) : '';
    },
    /** @param {number} n */
    int: (n) => {
      const v = fields.get(n);
      return typeof v === 'number' ? v : 0;
    },
  };
}
