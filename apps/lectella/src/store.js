// The library: notebooks, sources, notes and chat, kept as plain files through one small filesystem adapter.
//
//   library.json                    every notebook, source and note's metadata (the index)
//   sources/<id>/text.md            a source's text, the only copy the app searches
//   sources/<id>/original.<ext>     the file the person added, as bytes, when there was one
//   notes/<notebook>/<id>.md        a note's Markdown
//   chats/<notebook>.json           the notebook's chat turns, with each answer's citation map
//
// Bodies are written before the index that names them, so an interrupted write leaves an unlisted file, never
// a listed record with no body. Three adapters: NakliOS storage (Folder or Crate), this browser's private
// storage (OPFS), and memory for tests.

import { uid, chunkText } from './core.js';

/** @typedef {{ read(p: string): Promise<string>, readBinary?(p: string): Promise<Uint8Array>, write(p: string, d: string | Uint8Array): Promise<void>, exists(p: string): Promise<boolean>, delete(p: string): Promise<void> }} Fs */
/** @typedef {{ id: string, name: string, description: string, created: number, updated: number, sources: string[], notes: string[], off: string[] }} Notebook */
/** @typedef {{ id: string, title: string, kind: string, origin: string, added: number, chars: number, original?: string }} Source */
/** @typedef {{ id: string, notebook: string, title: string, kind: 'human' | 'ai', created: number, updated: number, refs?: any[] }} Note */
/** @typedef {{ role: 'user' | 'assistant', content: string, refs?: any[], mode?: string, at: number }} Turn */

export const LIBRARY_VERSION = 1;

/** @returns {Fs & { files: Map<string, string | Uint8Array> }} */
export function memoryFs() {
  /** @type {Map<string, string | Uint8Array>} */
  const files = new Map();
  return {
    files,
    async read(p) {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      const v = files.get(p);
      return typeof v === 'string' ? v : new TextDecoder().decode(v);
    },
    async readBinary(p) {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      const v = files.get(p);
      return typeof v === 'string' ? new TextEncoder().encode(v) : /** @type {Uint8Array} */ (v);
    },
    async write(p, d) {
      files.set(p, d);
    },
    async exists(p) {
      return files.has(p);
    },
    async delete(p) {
      files.delete(p);
    },
  };
}

/** NakliOS storage: paths are already scoped to apps/lectella/ by the host. @param {any} naklios @returns {Fs} */
export function hostFs(naklios) {
  return {
    read: (p) => naklios.fs.read(p),
    readBinary: (p) => naklios.fs.readBinary(p),
    write: (p, d) => naklios.fs.write(p, d),
    exists: (p) => naklios.fs.exists(p),
    delete: (p) => naklios.fs.delete(p),
  };
}

/** This browser's private storage (OPFS), under a `lectella` folder. @returns {Fs} */
export function opfsFs() {
  const root = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('lectella', { create: true });
  /** @param {string} p @param {boolean} create */
  async function walk(p, create) {
    const parts = p.split('/').filter(Boolean);
    const name = /** @type {string} */ (parts.pop());
    let dir = await root();
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return { dir, name };
  }
  return {
    async read(p) {
      const { dir, name } = await walk(p, false);
      return (await (await dir.getFileHandle(name)).getFile()).text();
    },
    async readBinary(p) {
      const { dir, name } = await walk(p, false);
      return new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer());
    },
    async write(p, d) {
      const { dir, name } = await walk(p, true);
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(/** @type {any} */ (d));
      await w.close();
    },
    async exists(p) {
      try {
        const { dir, name } = await walk(p, false);
        await dir.getFileHandle(name);
        return true;
      } catch {
        return false;
      }
    },
    async delete(p) {
      try {
        const { dir, name } = await walk(p, false);
        await dir.removeEntry(name);
      } catch {
        // already gone
      }
    },
  };
}

export class Library {
  /** @param {Fs} fs */
  constructor(fs) {
    this.fs = fs;
    /** @type {{ version: number, notebooks: Notebook[], sources: Source[], notes: Note[] }} */
    this.data = { version: LIBRARY_VERSION, notebooks: [], sources: [], notes: [] };
    /** @type {Map<string, string>} */
    this.textCache = new Map();
    /** @type {Map<string, ReturnType<typeof chunkText>>} */
    this.chunkCache = new Map();
    /** Serialises writes so the index never races a body write. @type {Promise<any>} */
    this.queue = Promise.resolve();
  }

  /** @template T @param {() => Promise<T>} job @returns {Promise<T>} */
  serial(job) {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => {});
    return next;
  }

  async load() {
    if (await this.fs.exists('library.json')) {
      const parsed = JSON.parse(await this.fs.read('library.json'));
      if (!parsed || !Array.isArray(parsed.notebooks)) throw new Error('library.json is not a Lectella library');
      if (parsed.version > LIBRARY_VERSION) throw new Error(`library.json is version ${parsed.version}; this Lectella reads version ${LIBRARY_VERSION}`);
      this.data = { version: LIBRARY_VERSION, notebooks: parsed.notebooks, sources: parsed.sources ?? [], notes: parsed.notes ?? [] };
    }
    return this;
  }

  saveIndex() {
    return this.serial(() => this.fs.write('library.json', JSON.stringify(this.data, null, 1)));
  }

  // ── Notebooks ──────────────────────────────────────────────────────────────────────────────────────

  notebooks() {
    return [...this.data.notebooks].sort((a, b) => b.updated - a.updated);
  }

  /** @param {string} id */
  notebook(id) {
    const nb = this.data.notebooks.find((n) => n.id === id);
    if (!nb) throw new Error(`No notebook with id ${id}`);
    return nb;
  }

  /** @param {string} id */
  findNotebook(id) {
    return this.data.notebooks.find((n) => n.id === id || n.name.toLowerCase() === String(id).toLowerCase()) ?? null;
  }

  /** @param {{ name: string, description?: string }} input */
  async createNotebook({ name, description = '' }) {
    const clean = String(name ?? '').trim();
    if (!clean) throw new Error('A notebook needs a name');
    const now = Date.now();
    /** @type {Notebook} */
    const nb = { id: uid('nb'), name: clean, description: String(description).trim(), created: now, updated: now, sources: [], notes: [], off: [] };
    this.data.notebooks.push(nb);
    await this.saveIndex();
    return nb;
  }

  /** @param {string} id @param {{ name?: string, description?: string }} patch */
  async updateNotebook(id, patch) {
    const nb = this.notebook(id);
    if (patch.name !== undefined) {
      const clean = String(patch.name).trim();
      if (!clean) throw new Error('A notebook needs a name');
      nb.name = clean;
    }
    if (patch.description !== undefined) nb.description = String(patch.description).trim();
    nb.updated = Date.now();
    await this.saveIndex();
    return nb;
  }

  /** Delete a notebook, its notes and chat. Sources linked to no other notebook are deleted too. @param {string} id */
  async deleteNotebook(id) {
    const nb = this.notebook(id);
    this.data.notebooks = this.data.notebooks.filter((n) => n !== nb);
    const orphanIds = nb.sources.filter((s) => !this.data.notebooks.some((n) => n.sources.includes(s)));
    const orphans = this.data.sources.filter((s) => orphanIds.includes(s.id));
    const notes = this.data.notes.filter((n) => n.notebook === id);
    this.data.notes = this.data.notes.filter((n) => n.notebook !== id);
    this.data.sources = this.data.sources.filter((s) => !orphanIds.includes(s.id));
    await this.saveIndex();
    // Bodies go after the index stops naming them, so a failure leaves stray files, never broken records.
    await this.serial(async () => {
      for (const n of notes) await this.fs.delete(`notes/${id}/${n.id}.md`);
      await this.fs.delete(`chats/${id}.json`);
      for (const s of orphans) await this.dropSourceFiles(s);
    });
    return { notes: notes.length, sources: orphans.length };
  }

  /** Switch an item in or out of this notebook's chat context. @param {string} nbId @param {string} itemId @param {boolean} on */
  async setInChat(nbId, itemId, on) {
    const nb = this.notebook(nbId);
    nb.off = nb.off.filter((x) => x !== itemId);
    if (!on) nb.off.push(itemId);
    await this.saveIndex();
  }

  // ── Sources ────────────────────────────────────────────────────────────────────────────────────────

  /** @param {string} nbId */
  sourcesOf(nbId) {
    const nb = this.notebook(nbId);
    return nb.sources.map((id) => this.data.sources.find((s) => s.id === id)).filter((s) => !!s);
  }

  /** @param {string} id */
  source(id) {
    const s = this.data.sources.find((x) => x.id === id);
    if (!s) throw new Error(`No source with id ${id}`);
    return s;
  }

  /**
   * Add a source to a notebook. Text is required; `original` keeps the file the person picked, as bytes.
   * @param {string} nbId
   * @param {{ title: string, text: string, kind?: string, origin?: string, original?: { name: string, bytes: Uint8Array } }} input
   */
  async addSource(nbId, { title, text, kind = 'text', origin = 'pasted', original }) {
    const nb = this.notebook(nbId);
    const body = String(text ?? '').replace(/\r\n?/g, '\n').trim();
    if (!body) throw new Error('A source needs some text');
    const id = uid('src');
    /** @type {Source} */
    const src = { id, title: String(title ?? '').trim() || 'Untitled source', kind, origin, added: Date.now(), chars: body.length };
    await this.serial(async () => {
      await this.fs.write(`sources/${id}/text.md`, body);
      if (original) {
        const ext = (/\.([a-z0-9]{1,8})$/i.exec(original.name)?.[1] ?? 'bin').toLowerCase();
        src.original = `sources/${id}/original.${ext}`;
        await this.fs.write(src.original, original.bytes);
      }
    });
    this.data.sources.push(src);
    nb.sources.push(id);
    nb.updated = Date.now();
    this.textCache.set(id, body);
    await this.saveIndex();
    return src;
  }

  /** @param {string} id */
  async sourceText(id) {
    if (!this.textCache.has(id)) this.textCache.set(id, await this.fs.read(`sources/${id}/text.md`));
    return /** @type {string} */ (this.textCache.get(id));
  }

  /** @param {string} id */
  async sourceChunks(id) {
    if (!this.chunkCache.has(id)) this.chunkCache.set(id, chunkText(await this.sourceText(id)));
    return /** @type {ReturnType<typeof chunkText>} */ (this.chunkCache.get(id));
  }

  /** @param {string} nbId @param {string} srcId @param {string} title */
  async renameSource(nbId, srcId, title) {
    const s = this.source(srcId);
    s.title = String(title ?? '').trim() || s.title;
    this.notebook(nbId).updated = Date.now();
    await this.saveIndex();
    return s;
  }

  /** Remove a source from a notebook; delete its files when no other notebook links it. @param {string} nbId @param {string} srcId */
  async removeSource(nbId, srcId) {
    const nb = this.notebook(nbId);
    nb.sources = nb.sources.filter((s) => s !== srcId);
    nb.off = nb.off.filter((s) => s !== srcId);
    nb.updated = Date.now();
    const shared = this.data.notebooks.some((n) => n.sources.includes(srcId));
    const src = this.data.sources.find((s) => s.id === srcId);
    if (!shared) this.data.sources = this.data.sources.filter((s) => s.id !== srcId);
    await this.saveIndex();
    if (!shared && src) await this.serial(() => this.dropSourceFiles(src));
    return { deleted: !shared };
  }

  /** @param {Source} src */
  async dropSourceFiles(src) {
    await this.fs.delete(`sources/${src.id}/text.md`);
    if (src.original) await this.fs.delete(src.original);
    this.textCache.delete(src.id);
    this.chunkCache.delete(src.id);
  }

  // ── Notes ──────────────────────────────────────────────────────────────────────────────────────────

  /** @param {string} nbId */
  notesOf(nbId) {
    return this.data.notes.filter((n) => n.notebook === nbId).sort((a, b) => b.updated - a.updated);
  }

  /** @param {string} id */
  note(id) {
    const n = this.data.notes.find((x) => x.id === id);
    if (!n) throw new Error(`No note with id ${id}`);
    return n;
  }

  /** @param {string} nbId @param {{ title: string, body: string, kind?: 'human' | 'ai', refs?: any[] }} input */
  async addNote(nbId, { title, body, kind = 'human', refs }) {
    const nb = this.notebook(nbId);
    const now = Date.now();
    /** @type {Note} */
    const note = { id: uid('note'), notebook: nbId, title: String(title ?? '').trim() || 'Untitled note', kind, created: now, updated: now };
    if (refs?.length) note.refs = refs;
    await this.serial(() => this.fs.write(`notes/${nbId}/${note.id}.md`, String(body ?? '')));
    this.textCache.set(note.id, String(body ?? ''));
    this.data.notes.push(note);
    nb.notes.push(note.id);
    nb.updated = now;
    await this.saveIndex();
    return note;
  }

  /** @param {string} id */
  async noteBody(id) {
    const n = this.note(id);
    if (!this.textCache.has(id)) this.textCache.set(id, await this.fs.read(`notes/${n.notebook}/${id}.md`));
    return /** @type {string} */ (this.textCache.get(id));
  }

  /** @param {string} id @param {{ title?: string, body?: string }} patch */
  async updateNote(id, patch) {
    const n = this.note(id);
    if (patch.body !== undefined) {
      const body = String(patch.body);
      await this.serial(() => this.fs.write(`notes/${n.notebook}/${id}.md`, body));
      this.textCache.set(id, body);
      this.chunkCache.delete(id);
    }
    if (patch.title !== undefined) n.title = String(patch.title).trim() || n.title;
    n.updated = Date.now();
    this.notebook(n.notebook).updated = n.updated;
    await this.saveIndex();
    return n;
  }

  /** @param {string} id */
  async deleteNote(id) {
    const n = this.note(id);
    const nb = this.notebook(n.notebook);
    nb.notes = nb.notes.filter((x) => x !== id);
    nb.off = nb.off.filter((x) => x !== id);
    this.data.notes = this.data.notes.filter((x) => x.id !== id);
    await this.saveIndex();
    await this.serial(() => this.fs.delete(`notes/${n.notebook}/${id}.md`));
    this.textCache.delete(id);
  }

  // ── Chat ───────────────────────────────────────────────────────────────────────────────────────────

  /** @param {string} nbId @returns {Promise<Turn[]>} */
  async chat(nbId) {
    const p = `chats/${nbId}.json`;
    if (!(await this.fs.exists(p))) return [];
    const parsed = JSON.parse(await this.fs.read(p));
    return Array.isArray(parsed?.turns) ? parsed.turns : [];
  }

  /** @param {string} nbId @param {Turn[]} turns */
  saveChat(nbId, turns) {
    return this.serial(() => this.fs.write(`chats/${nbId}.json`, JSON.stringify({ turns }, null, 1)));
  }

  /**
   * The text of every source and note switched on for chat, as context items.
   * @param {string} nbId
   */
  async contextItems(nbId) {
    const nb = this.notebook(nbId);
    const items = [];
    for (const s of this.sourcesOf(nbId)) if (!nb.off.includes(s.id)) items.push({ kind: /** @type {const} */ ('source'), id: s.id, title: s.title, text: await this.sourceText(s.id) });
    for (const n of this.notesOf(nbId)) if (!nb.off.includes(n.id)) items.push({ kind: /** @type {const} */ ('note'), id: n.id, title: n.title, text: await this.noteBody(n.id) });
    return items;
  }

  /** Chunks for each context item, cached per source. @param {{ id: string, kind: string, text: string }[]} items */
  async chunksFor(items) {
    const map = new Map();
    for (const it of items) map.set(it.id, it.kind === 'source' ? await this.sourceChunks(it.id) : chunkText(it.text));
    return map;
  }
}
