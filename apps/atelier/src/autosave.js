// Durability (NakliOS acceptance gate items 3–5, spec 002 §9.3).
// - Autosave: each open document gets one naklios.fs.autosave saver (1 s delay; the SDK also saves when
//   the page hides and when NakliOS closes the window). Its save() sends save_document through the bus, so
//   a sidecar or .atelier file is written by the same command every other door uses. The SDK's timing runs
//   standalone too, so standalone and hosted share one path. Atelier adds no beforeunload save.
// - Change subscriptions: hosted with a filesystem, naklios.fs.subscribe reports changes; standalone, the
//   file is polled every 2 s through the storage adapter (the host polls a Folder the same way). A change
//   to a clean document reloads it; a change under unsaved edits asks Reload, Keep mine or Later.
// - Disconnect: when the storage the document belongs to goes away or changes, saving pauses and the
//   edits stay in the window; nothing is saved to a different location unless the person chooses it.

import { sidecarPath } from './files/workspace.js';

// Commands that never change the open document (or that write their own files): they do not mark it dirty.
export const NON_DOC = new Set(['save_document', 'set_view', 'set_active', 'export_image', 'export_batch', 'save_export_preset', 'save_preset', 'set_rating', 'grant_folder', 'enable_channel', 'confirm_staged', 'overwrite_file', 'download_model', 'copy_settings',
  // library commands write sidecars, collections, assets or the sync folder, never the open document
  'set_keywords', 'create_collection', 'add_to_collection', 'set_smart_collection', 'delete_collection', 'create_virtual_copy', 'delete_virtual_copy',
  'import_xmp', 'import_lightroom_catalog', 'sync_library', 'resolve_sync_conflict', 'add_library_asset', 'delete_library_asset', 'analyze_culling', 'accept_cull_suggestions']);
// Commands that replace the open document: the old one is flushed first.
export const REPLACES = (name, args) => (name === 'open_photo' && !args?.asLayer) || name === 'open_virtual_copy' || name === 'new_document';

export function changesDocument(name, args, reply, effectOf) {
  if (reply?.status !== 'ok') return false;
  if (effectOf(name) === 'read' || NON_DOC.has(name)) return false;
  if (REPLACES(name, args)) return false;
  if (name === 'snapshot' && args?.action !== 'restore') return false;
  return true;
}

// Where a document saves before its first save answers with the real path: a document whose content is
// one RAW photo (and its local adjustments) saves as that photo's sidecar; anything else as .atelier.
// An open virtual copy reopens as that copy (copy), not as the master photo.
export function guessTarget(doc) {
  if (!doc) return null;
  const raws = doc.layers.filter((l) => l.kind === 'raw' && !l.localOf);
  if (raws.length === 1 && doc.layers.every((l) => l === raws[0] || l.localOf === raws[0].id)) {
    const copy = doc.photo?.path === raws[0].file ? doc.photo.copy : null;
    return { path: sidecarPath(raws[0].file), reopen: raws[0].file, ...(copy ? { copy } : {}) };
  }
  const p = `documents/${doc.id}.atelier`;
  return { path: p, reopen: p };
}

// Library commands this window runs that write the open photo's sidecar without touching what the
// document holds (rating, keywords, copies, suggestions, caption): the new text is this window's own, not
// a change made elsewhere. import_xmp with develop and import_lightroom_catalog (which may fill develop
// settings) are left out: they change settings the open document shows, so they count as outside changes.
export const OWN_SIDECAR_WRITES = (name, args) => ['set_rating', 'sync_settings', 'set_keywords', 'create_virtual_copy', 'delete_virtual_copy', 'analyze_culling', 'accept_cull_suggestions', 'set_caption'].includes(name)
  || (name === 'import_xmp' && !args?.develop) || (name === 'import_lightroom_catalog' && args?.develop === false && !args?.dryRun);

// What to do when the watched file's text differs from what this window last wrote or read.
export function decide({ text, known, dirty }) {
  if (text === known) return 'ignore';
  if (text == null) return 'ignore';   // deleted elsewhere: the next save writes it again
  return dirty ? 'ask' : 'reload';
}

// The same contract as naklios.fs.autosave: save at most `delay` ms after the first unsaved change; a
// failed save stays dirty; flush() saves now after any save already running.
export function debounceSaver({ save, delay = 1000, onError }, setTimer = setTimeout) {
  let gen = 0; let saved = 0; let timer = null; let tail = Promise.resolve(); let disposed = false;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    tail = tail.catch(() => {}).then(async () => {
      if (gen <= saved) return;
      const g = gen;
      try { await save(); saved = Math.max(saved, g); } catch (e) { onError?.(e); throw e; }
    });
    return tail;
  };
  return {
    markDirty() { if (disposed) return; gen++; if (!timer) timer = setTimer(() => { timer = null; flush().catch(() => {}); }, delay); },
    flush, get dirty() { return gen > saved; }, dispose() { disposed = true; if (timer) clearTimeout(timer); timer = null; },
  };
}

const identity = (s) => (s ? `${s.kind}:${s.label}` : 'none');

export function createDurability({ naklios, bus, ctx, dialogs, notice = () => {}, onState = () => {}, setTimer = setTimeout, setRepeat = setInterval, clearRepeat = clearInterval }) {
  const effectOf = (name) => bus.manifest.tools.find((t) => t.name === name)?.effect;
  let saver = null; let docId = null; let watch = null; let known = null; let bound = null;
  let saving = false; let asking = null; let paused = null; let stopWatch = null; let lastError = null;

  const storage = () => ctx.storage();
  const state = () => (paused ? 'paused' : saving ? 'saving' : lastError ? 'error' : saver?.dirty ? 'unsaved' : 'saved');
  const report = () => onState(state(), { path: watch?.path ?? null, paused, error: lastError });
  async function readText(path) {
    const s = storage();
    try { return (await s.exists(path)) ? await s.readText(path) : null; } catch { return null; }
  }

  async function save() {
    // While the person decides about a change made elsewhere, no save may overwrite that change.
    if (asking) { const choice = await asking; if (choice === 'reload') return; }
    if (!ctx.store.doc) return;
    if (identity(storage()) !== bound) { pause(); throw new Error(paused); }
    if (paused) throw new Error(paused);
    // A change made elsewhere since this window last read the file is decided before any save writes over it.
    if (watch && !asking) {
      const now = await readText(watch.path);
      if (now != null && now !== known) { const r = await check(); if (r === 'reload' || r === 'ask:reload') return; }
    }
    saving = true; report();
    try {
      const r = await bus.dispatch('save_document', { revision: bus.state.revision }, { door: 'ui', caller: 'autosave' });
      if (r.status !== 'ok') throw new Error(`${r.status}${r.error?.message ? `: ${r.error.message}` : ''}`);
      const g = guessTarget(ctx.store.doc);
      watch = r.result.kind === 'document' ? { path: r.result.path, reopen: r.result.path } : { path: r.result.path, reopen: watch?.reopen ?? g?.reopen, ...((watch?.copy ?? g?.copy) ? { copy: watch?.copy ?? g?.copy } : {}) };
      known = await readText(watch.path);
      lastError = null;
    } finally { saving = false; report(); setTimer(report, 0); }   // again once the saver has counted the save as durable
  }

  function newSaver() {
    saver?.dispose();
    const opts = {
      save, delay: 1000,
      onError: (e) => { lastError = e.message; report(); if (!paused) setTimer(() => saver?.dirty && saver.flush().catch(() => {}), 5000); },
    };
    // The inlined SDK's autosave runs standalone too (its timing half); the debounce below covers a page
    // without the SDK, with the same 1 s timing and no beforeunload save.
    saver = naklios?.fs?.autosave ? naklios.fs.autosave(opts) : debounceSaver(opts, setTimer);
  }

  async function bind() {
    const doc = ctx.store.doc;
    docId = doc?.id ?? null;
    newSaver();
    paused = null; lastError = null; notice(null);
    bound = identity(storage());
    watch = guessTarget(doc);
    known = watch ? await readText(watch.path) : null;
    report();
  }

  function pause() {
    const s = storage();
    paused = `Saving is paused: this document belongs to ${bound.split(':').slice(1).join(':') || 'a storage that is gone'}, which is not connected. Your edits stay in this window.`;
    notice(paused, s ? [{ label: `Save to ${s.label}`, run: () => { bound = identity(s); paused = null; notice(null); saver?.markDirty(); saver?.flush().catch(() => {}); } }] : []);
    report();
  }

  async function reload(text) {
    known = text;
    saver?.dispose(); saver = null;
    return bus.dispatch('open_photo', { path: watch.reopen, ...(watch.copy ? { copy: watch.copy } : {}) }, { door: 'ui', caller: 'change-subscription' });
  }

  // Compares the watched file with what this window last saw; acts on a difference.
  async function check() {
    if (!watch || saving || asking || paused || !storage()) return 'skip';
    const text = await readText(watch.path);
    if (saving) return 'skip';
    const what = decide({ text, known, dirty: !!saver?.dirty });
    if (what === 'ignore') { if (text == null) known = null; return what; }
    if (what === 'reload') { await reload(text); return what; }
    let decided; asking = new Promise((r) => { decided = r; });
    let choice = 'later';
    try {
      choice = await dialogs.ask('Changed outside Atelier', `${watch.path} changed in another app or window. This window has edits that are not saved yet.`, [
        { label: 'Reload (drop my edits)', value: 'reload', danger: true },
        { label: 'Later', value: 'later' },
        { label: 'Keep mine', value: 'keep', primary: true },
      ], 'later');
    } finally { const a = decided; asking = null; a(choice); }   // a save that waited goes on (or stops, on reload)
    {
      if (choice === 'reload') await reload(text);
      else if (choice === 'keep') { known = text; saver?.markDirty(); }   // the autosaver writes ours over theirs
      else { known = text; notice(`${watch.path} changed elsewhere; your edits are kept and will save over it.`, [{ label: 'Reload theirs', run: () => { notice(null); reload(text); } }]); }
      return `ask:${choice}`;
    }
  }

  function startWatching() {
    stopWatch?.(); stopWatch = null;
    const caps = naklios?.capabilities || {};
    if (caps.hosted && caps.fs && naklios.fs?.subscribe) {
      let stop = null; let live = true;
      naklios.fs.subscribe('', (ev) => {
        if (ev?.op === 'disconnected') { onDisconnect(ev.reason); return; }
        const p = String(ev?.path || '').replace(/^apps\/atelier\//, '');
        if (watch && (p === watch.path || ev?.to === watch.path || !p)) check();
      }).then((s) => { if (live) stop = s; else s(); }).catch((e) => console.warn('[atelier] subscribe failed', e));
      stopWatch = () => { live = false; stop?.(); };
    } else {
      const id = setRepeat(() => { check().catch(() => {}); }, 2000);
      stopWatch = () => clearRepeat(id);
    }
  }

  function onDisconnect(reason) {
    if (saver?.dirty) pause();
    else notice(`Storage disconnected${reason ? ` (${reason})` : ''}. Nothing unsaved was lost.`, []);
  }

  return {
    // Called after every bus reply (all doors).
    async observe(name, args, reply) {
      // A save from another door wrote the file this window watches: that is ours, not a change made elsewhere.
      if (name === 'save_document' && reply?.status === 'ok' && watch && reply.result?.path === watch.path) known = await readText(watch.path);
      const doc = ctx.store.doc;
      if ((doc?.id ?? null) !== docId) { await bind(); return; }
      if (changesDocument(name, args, reply, effectOf)) { saver?.markDirty(); report(); }
      if (reply?.status === 'ok' && OWN_SIDECAR_WRITES(name, args) && watch) known = await readText(watch.path);
    },
    // Called before a command runs: a command that replaces the document saves the old one first.
    async before(name, args, opts) {
      if (REPLACES(name, args) && opts?.caller !== 'change-subscription' && saver?.dirty && !paused) await saver.flush().catch(() => {});
    },
    flush: () => (saver ? saver.flush() : Promise.resolve()),
    async storageChanged() {
      const id = identity(storage());
      if (!ctx.store.doc) { bound = id; startWatching(); return; }
      if (id === bound) { if (paused) { paused = null; notice(null); report(); saver?.flush().catch(() => {}); } startWatching(); return; }
      if (saver?.dirty) pause();
      else { bound = id; known = watch ? await readText(watch.path) : null; }
      startWatching();
    },
    start() { startWatching(); return bind(); },
    check,
    get dirty() { return !!saver?.dirty; },
    get state() { return state(); },
    get watched() { return watch; },
  };
}
