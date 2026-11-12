// Library commands: the folder listing with keywords, collections, EXIF and virtual copies; culling that
// also writes standard XMP sidecars; keywords; manual and smart collections; virtual copies; reading XMP
// sidecars back; Lightroom catalog import (L04, L05, L43, L54, L55; spec 002 §4.2, §9.3).
// Files: sidecars <photo>.atelier.json, XMP sidecars <stem>.xmp (proprietary RAWs only), collections as
// collections/<name>.json, and the EXIF cache in library.json. All writes are temp file then move.

import { DEVELOP_RENDERED } from '../../vendor/tessella/src/model.js';
import { fail, stageOrRun } from './util.js';
import {
  sidecarPath, baseName, photoKind, safeName, normalizeSidecar, applyCull, sidecarText, photoPaths, filterPhotos, pageOf,
  applyKeywords, badKeyword, addCopy, removeCopy, itemKey, splitKey, COPY_ID, collectionPath, collectionText, COLLECTION_DIR,
  checkRules, matchRules, STRUCT,
} from '../files/workspace.js';
import { xmpSidecarPath, readXmpMeta, writeXmpSidecar } from '../files/xmp.js';
import { readExif, isTruncated } from '../files/exif.js';
import { readCatalog, matchPaths } from '../files/lrcat.js';
import { register as registerHeal } from './heal.js';
import { register as registerShare } from './share.js';
import { register as registerSmart } from './smart.js';
import { photoDocument } from './files.js';
import { serial } from '../storage.js';
import { measure, suggest, DEFAULTS as CULL_DEFAULTS } from '../files/cullassist.js';

const enc = new TextEncoder();
export const LIBRARY_FILE = 'library.json';
const EXIF_HEAD = 256 * 1024;   // EXIF sits in the first 64 KB of every sample tried; 256 KB leaves room

export function register(bus, ctx) {
  registerHeal(bus, ctx);   // content-aware fill (P41), library sync and shared assets (L52, P60) and
  registerShare(bus, ctx);  // smart objects (P12, P13) register with the library builder's entry
  registerSmart(bus, ctx);
  function store() {
    const s = ctx.storage();
    if (!s) fail('unsupported', 'no workspace storage; grant a folder or allow browser storage', 'use_ui_control', 'grant_folder');
    return s;
  }
  // A photo with no Atelier sidecar yet starts from its XMP sidecar's rating, flag, label and keywords
  // (another tool wrote them), so the first Atelier write keeps them instead of clearing them.
  async function readSidecar(s, path) {
    const p = sidecarPath(path);
    if (!(await s.exists(p))) {
      let seed = {};
      const xp = xmpSidecarPath(path);
      if (xp && await s.exists(xp)) { try { const m = readXmpMeta(await s.readText(xp)); seed = { rating: m.rating, flag: m.flag, label: m.label, keywords: m.keywords }; } catch { /* unreadable XMP: start empty */ } }
      return { exists: false, sidecar: normalizeSidecar(seed, DEVELOP_RENDERED) };
    }
    let raw; try { raw = JSON.parse(await s.readText(p)); } catch { raw = {}; }
    return { exists: true, sidecar: normalizeSidecar(raw, DEVELOP_RENDERED) };
  }
  const writeSidecar = (s, path, sc) => s.write(sidecarPath(path), enc.encode(sidecarText(sc, baseName(path))));
  async function needPhoto(s, path, tool) {
    if (!photoKind(path)) fail('unsupported', `${path} is not a RAW or browser image`, 'fix_argument', tool);
    if (!(await s.exists(path))) fail('invalid', `no file ${path} in the workspace`, 'fix_argument', 'list_folder');
  }
  // Mirrors the fields a command changed (any of 'rating', 'flag', 'label', 'keywords') into the photo's
  // XMP sidecar; every other property an existing one holds is kept as written. Returns the XMP path, or
  // null for formats that keep XMP inside the file.
  async function writeXmp(s, path, sc, fields) {
    const xp = xmpSidecarPath(path); if (!xp) return null;
    const old = (await s.exists(xp)) ? await s.readText(xp) : null;
    const meta = {};
    if (fields.includes('rating') || fields.includes('flag')) { meta.rating = sc.rating ?? 0; meta.flag = sc.flag ?? 'none'; }
    if (fields.includes('label')) meta.label = sc.label ?? 'none';
    if (fields.includes('keywords')) meta.keywords = sc.keywords || [];
    await s.write(xp, enc.encode(writeXmpSidecar(old, meta)));
    return xp;
  }
  // One read-modify-write of a photo's sidecar at a time (autosave's save_document takes the same lock).
  const locked = (path, fn) => serial(sidecarPath(path), fn);
  async function readLibrary(s) {
    if (!(await s.exists(LIBRARY_FILE))) return { format: 'atelier-library', version: 1, exif: {} };
    try { const j = JSON.parse(await s.readText(LIBRARY_FILE)); return { ...j, exif: j.exif || {} }; } catch { return { format: 'atelier-library', version: 1, exif: {} }; }
  }
  const writeLibrary = (s, lib) => s.write(LIBRARY_FILE, enc.encode(`${JSON.stringify({ ...lib, format: 'atelier-library', version: 1, updated: new Date().toISOString() }, null, 2)}\n`));
  // EXIF from the file's first 256 KB (storage readRange); the whole file only when that is too short.
  async function exifOf(s, path) {
    const parse = (bytes) => readExif(bytes) || { unreadable: true };
    try { return parse(await s.readRange(path, 0, EXIF_HEAD)); } catch (e) {
      if (!isTruncated(e)) return { unreadable: true };
      try { return parse(await s.readBinary(path)); } catch { return { unreadable: true }; }
    }
  }

  // Every photo and virtual copy as a row; EXIF from the cache, filled for missing photos when asked.
  // A read command (list_folder) keeps what it reads in memory (ctx.exifMemo) and writes no file; the
  // next mutating command that reads EXIF (persist) writes the memo into library.json with its own reads.
  // Keyed by storage, so a memo never crosses into another workspace.
  const memo = () => { const s = ctx.storage(); const k = s ? `${s.kind}:${s.label}` : ''; ctx.exifMemo ||= new Map(); if (!ctx.exifMemo.has(k)) ctx.exifMemo.set(k, new Map()); return ctx.exifMemo.get(k); };
  async function allRows(s, { exif = false, persist = false } = {}) {
    const listing = await s.list('');
    const have = new Set(listing.map((e) => e.path));
    const lib = await readLibrary(s); let added = 0; let fromMemo = 0;
    for (const [p, e] of memo()) if (!lib.exif[p]) { lib.exif[p] = e; fromMemo++; }
    const rows = [];
    for (const path of photoPaths(listing)) {
      const hasSide = have.has(sidecarPath(path));
      const { sidecar } = hasSide ? await readSidecar(s, path) : { sidecar: {} };
      if (exif && !lib.exif[path]) { lib.exif[path] = await exifOf(s, path); memo().set(path, lib.exif[path]); added++; }
      const e = lib.exif[path]; const ex = e && !e.unreadable ? e : null;
      const base = { path, kind: photoKind(path), rating: sidecar.rating ?? 0, flag: sidecar.flag ?? 'none', label: sidecar.label ?? 'none', keywords: sidecar.keywords || [], exif: ex, sidecar: hasSide, xmp: !!(xmpSidecarPath(path) && have.has(xmpSidecarPath(path))), ...(sidecar.suggestions && !sidecar.suggestions.accepted ? { suggest: { flag: sidecar.suggestions.flag, reasons: sidecar.suggestions.reasons, notes: sidecar.suggestions.notes } } : {}) };
      rows.push(base);
      for (const c of sidecar.copies || []) rows.push({ ...base, copy: c.id, copyName: c.name });
    }
    if (persist && (added || fromMemo)) { await writeLibrary(s, lib); memo().clear(); }
    return { rows, exifRead: added };
  }
  async function readCollection(s, name) {
    const n = safeName(name); if (!n) fail('invalid', 'a collection name is one segment without / \\ : * ? " < > |', 'fix_argument', 'list_collections');
    const p = collectionPath(n);
    if (!(await s.exists(p))) return { name: n, path: p, exists: false };
    let j; try { j = JSON.parse(await s.readText(p)); } catch (e) { fail('invalid', `${p} is not valid JSON: ${e.message}`, 'change_target', 'list_collections'); }
    return { ...j, name: n, path: p, exists: true };
  }
  const writeCollection = (s, c) => { const { path, exists, ...rest } = c; return s.write(collectionPath(c.name), enc.encode(collectionText(rest))); };
  const membersOf = (c, rows) => (c.kind === 'smart' ? new Set(rows.filter((r) => matchRules(r, c.rules)).map((r) => itemKey(r.path, r.copy))) : new Set(c.items || []));
  const EXIF_FILTERS = ['camera', 'lens', 'isoMin', 'isoMax', 'focalMin', 'focalMax', 'dateFrom', 'dateTo'];

  // ---- listing -----------------------------------------------------------------------------------
  bus.register('library.folder', async (a) => {
    const s = store(); const f = { ...(a.filter || {}) };
    let col = null;
    if (f.collection) { col = await readCollection(s, f.collection); if (!col.exists) fail('invalid', `no collection ${f.collection}`, 'fix_argument', 'list_collections'); }
    const needExif = a.exif || EXIF_FILTERS.some((k) => f[k] != null && f[k] !== '') || col?.kind === 'smart' && col.rules.rules.some((r) => ['camera', 'lens', 'iso', 'focalLength', 'date'].includes(r.field));
    const { rows, exifRead } = await allRows(s, { exif: needExif });
    if (col) f.items = membersOf(col, rows);
    delete f.collection;
    const pg = pageOf(filterPhotos(rows, f), a.page ?? 0);
    return { page: pg.page, pages: pg.pages, total: pg.total, photos: pg.rows, ...(exifRead ? { exifRead } : {}) };
  });

  // ---- culling, also into XMP sidecars ------------------------------------------------------------
  bus.register('library.cull', async (a) => {
    const s = store();
    if (a.rating === undefined && a.flag === undefined && a.label === undefined) fail('invalid', 'pass rating, flag or label', 'fix_argument', 'set_rating');
    for (const p of a.paths) await needPhoto(s, p, 'set_rating');   // check every path before writing any
    const out = [];
    const fields = ['rating', 'flag', 'label'].filter((k) => a[k] !== undefined);
    for (const p of a.paths) await locked(p, async () => {
      const { sidecar } = await readSidecar(s, p);
      const next = applyCull(sidecar, a);
      await writeSidecar(s, p, next);
      const xmp = await writeXmp(s, p, next, fields);
      out.push({ path: p, rating: next.rating ?? 0, flag: next.flag ?? 'none', label: next.label ?? 'none', xmp });
    });
    const photo = ctx.store.doc?.photo;
    if (photo && a.paths.includes(photo.path)) Object.assign(photo, { rating: a.rating ?? photo.rating, flag: a.flag ?? photo.flag, label: a.label ?? photo.label });
    return { photos: out };
  });

  // ---- keywords ------------------------------------------------------------------------------------
  bus.register('library.keywords', async (a, { viewOnly }) => {
    viewOnly();   // writes sidecars; the open document is unchanged
    const s = store(); const bad = badKeyword(a.keywords);
    if (bad !== undefined) fail('invalid', `keyword "${bad}" must be 1 to 100 characters without commas or semicolons`, 'fix_argument', 'set_keywords');
    for (const p of a.paths) await needPhoto(s, p, 'set_keywords');
    const out = [];
    for (const p of a.paths) await locked(p, async () => {
      const { sidecar } = await readSidecar(s, p);
      const next = applyKeywords(sidecar, a.keywords, a.mode ?? 'set');
      await writeSidecar(s, p, next);
      out.push({ path: p, keywords: next.keywords || [], xmp: await writeXmp(s, p, next, ['keywords']) });
    });
    return { photos: out };
  });
  bus.register('library.list-keywords', async () => {
    const { rows } = await allRows(store());
    const n = new Map();
    for (const r of rows) if (!r.copy) for (const k of r.keywords) { const key = k.toLowerCase(); const e = n.get(key) || { keyword: k, count: 0 }; e.count++; n.set(key, e); }
    return { keywords: [...n.values()].sort((x, y) => x.keyword.localeCompare(y.keyword)) };
  });

  // ---- collections ---------------------------------------------------------------------------------
  bus.register('library.list-collections', async () => {
    const s = store(); const listing = await s.list(COLLECTION_DIR);
    const { rows } = await allRows(s);
    const out = [];
    for (const e of listing) {
      if (!e.path.endsWith('.json')) continue;
      const name = baseName(e.path).replace(/\.json$/, '');
      try { const c = await readCollection(s, name); out.push({ name, kind: c.kind, count: membersOf(c, rows).size, ...(c.kind === 'smart' ? { rules: c.rules } : {}) }); } catch { /* an unreadable file is not a collection */ }
    }
    return { collections: out.sort((x, y) => x.name.localeCompare(y.name)) };
  });
  bus.register('library.create-collection', async (a, { viewOnly }) => {
    viewOnly(); const s = store();
    const c = await readCollection(s, a.name);
    if (c.exists) fail('invalid', `a collection named ${c.name} exists`, 'fix_argument', 'list_collections');
    const kind = a.rules ? 'smart' : 'manual';
    if (a.rules) { const e = checkRules(a.rules); if (e) fail('invalid', e, 'fix_argument', 'create_collection'); }
    await writeCollection(s, { name: c.name, kind, ...(kind === 'smart' ? { rules: { match: a.rules.match ?? 'all', rules: a.rules.rules } } : { items: [] }), created: new Date().toISOString() });
    return { name: c.name, kind, path: collectionPath(c.name) };
  });
  bus.register('library.collection-items', async (a, { viewOnly }) => {
    viewOnly(); const s = store();
    const c = await readCollection(s, a.name);
    if (!c.exists) fail('invalid', `no collection ${a.name}`, 'fix_argument', 'create_collection');
    if (c.kind !== 'manual') fail('unsupported', `${c.name} is a smart collection; its members follow its rules (set_smart_collection)`, 'change_target', 'set_smart_collection');
    for (const key of a.items) {
      const { path, copy } = splitKey(key);
      await needPhoto(s, path, 'add_to_collection');
      if (copy && !((await readSidecar(s, path)).sidecar.copies || []).some((x) => x.id === copy)) fail('invalid', `${path} has no virtual copy ${copy}`, 'fix_argument', 'list_folder');
    }
    const items = new Set(c.items || []);
    for (const k of a.items) { if ((a.op ?? 'add') === 'add') items.add(k); else items.delete(k); }
    await writeCollection(s, { ...c, items: [...items] });
    return { name: c.name, count: items.size };
  });
  bus.register('library.smart-collection', async (a, { viewOnly }) => {
    viewOnly(); const s = store();
    const e = checkRules(a.rules); if (e) fail('invalid', e, 'fix_argument', 'set_smart_collection');
    const c = await readCollection(s, a.name);
    if (c.exists && c.kind !== 'smart') fail('unsupported', `${c.name} is a manual collection; pick another name for a smart one`, 'fix_argument', 'set_smart_collection');
    const rules = { match: a.rules.match ?? 'all', rules: a.rules.rules };
    await writeCollection(s, { ...(c.exists ? c : { name: c.name, created: new Date().toISOString() }), kind: 'smart', rules });
    const { rows } = await allRows(s, { exif: rules.rules.some((r) => ['camera', 'lens', 'iso', 'focalLength', 'date'].includes(r.field)), persist: true });
    return { name: c.name, kind: 'smart', rules, count: rows.filter((r) => matchRules(r, rules)).length };
  });
  bus.register('library.delete-collection', async (a, { door }) => {
    const s = store(); const c = await readCollection(s, a.name);
    if (!c.exists) fail('invalid', `no collection ${a.name}`, 'fix_argument', 'list_collections');
    return stageOrRun(ctx, { door }, 'delete_collection', `DELETE collection ${c.name} (the photos stay)`, async () => { await s.delete(c.path); return { deleted: c.path }; });
  });

  // ---- virtual copies ------------------------------------------------------------------------------
  bus.register('library.create-copy', async (a, { viewOnly }) => {
    viewOnly(); const s = store();
    await needPhoto(s, a.path, 'create_virtual_copy');
    if (photoKind(a.path) !== 'raw') fail('unsupported', 'virtual copies hold develop settings, which only RAW photos have', 'change_target', 'list_folder');
    const made = await locked(a.path, async () => {
      const { sidecar } = await readSidecar(s, a.path);
      if (a.from && !(sidecar.copies || []).some((c) => c.id === a.from)) fail('invalid', `${a.path} has no virtual copy ${a.from}`, 'fix_argument', 'list_folder');
      const m = addCopy(sidecar, { name: a.name, from: a.from });
      await writeSidecar(s, a.path, m.sidecar);
      return m;
    });
    return { path: a.path, copy: made.copy.id, name: made.copy.name, item: itemKey(a.path, made.copy.id) };
  });
  bus.register('library.delete-copy', async (a, { door }) => {
    const s = store(); await needPhoto(s, a.path, 'delete_virtual_copy');
    const { sidecar } = await readSidecar(s, a.path);
    const c = (sidecar.copies || []).find((x) => x.id === a.copy);
    if (!c) fail('invalid', `${a.path} has no virtual copy ${a.copy}`, 'fix_argument', 'list_folder');
    if (ctx.store.doc?.photo?.path === a.path && ctx.store.doc.photo.copy === a.copy) fail('unsupported', 'that virtual copy is open; open another photo first', 'change_target', 'open_photo');
    return stageOrRun(ctx, { door }, 'delete_virtual_copy', `DELETE virtual copy "${c.name}" of ${baseName(a.path)} and its settings`, async () => {
      await locked(a.path, async () => { const cur = (await readSidecar(s, a.path)).sidecar; await writeSidecar(s, a.path, removeCopy(cur, a.copy)); });
      return { path: a.path, deleted: a.copy };
    });
  });
  // A virtual copy opens through open_photo with its copy id (src/handlers/files.js photoDocument);
  // the document's saves then go to the copy's sidecar entry.
  bus.register('library.open-copy', async (a, { door, caller }) => {
    if (!COPY_ID.test(a.copy)) fail('invalid', 'copy is an id like vc1 from list_folder', 'fix_argument', 'list_folder');
    const r = await bus.dispatch('open_photo', { path: a.path, copy: a.copy }, { door, caller });
    if (r.status !== 'ok') { const { CommandError } = await import('../bus.js'); throw new CommandError(r.status, r.error?.message || 'open_photo failed', r.remedy); }
    return r.result;
  });

  // ---- XMP sidecars read back ---------------------------------------------------------------------
  bus.register('library.import-xmp', async (a, { viewOnly, door }) => {
    viewOnly(); const s = store();
    const listing = await s.list(''); const have = new Set(listing.map((e) => e.path));
    const paths = a.paths || photoPaths(listing).filter((p) => xmpSidecarPath(p) && have.has(xmpSidecarPath(p)));
    for (const p of paths) await needPhoto(s, p, 'import_xmp');
    // Develop settings from XMP replace the person's Atelier settings: an agent's call waits for the person.
    if (a.develop) return stageOrRun(ctx, { door }, 'import_xmp', `REPLACE develop settings of up to ${paths.length} photo${paths.length === 1 ? '' : 's'} with the settings in their XMP sidecars`, () => importXmp(s, a, paths, have));
    return importXmp(s, a, paths, have);
  });
  async function importXmp(s, a, paths, have) {
    const out = [];
    for (const p of paths) await locked(p, async () => {
      const xp = xmpSidecarPath(p);
      if (!xp || !have.has(xp)) { out.push({ path: p, imported: false, reason: xp ? `no ${xp}` : 'this format keeps XMP inside the file' }); return; }
      let meta; try { meta = readXmpMeta(await s.readText(xp)); } catch (e) { out.push({ path: p, imported: false, reason: e.message }); return; }
      const { sidecar } = await readSidecar(s, p);
      let next = applyCull(sidecar, { rating: meta.rating, flag: meta.flag, label: meta.label });
      if (meta.keywords) next = applyKeywords(next, meta.keywords, 'set');
      let develop = null;
      if (a.develop && meta.develop && photoKind(p) === 'raw') { next = { ...next, develop: { ...next.develop, ...meta.develop.settings } }; if (meta.develop.curve) next.curve = meta.develop.curve; develop = Object.keys(meta.develop.settings); }
      await writeSidecar(s, p, next);
      out.push({ path: p, imported: true, rating: next.rating ?? 0, flag: next.flag ?? 'none', label: next.label ?? 'none', keywords: next.keywords || [], ...(develop ? { develop } : {}), ...(meta.skipped.length ? { skipped: meta.skipped } : {}) });
    });
    return { photos: out };
  }

  // ---- culling assist (L63, classical part) -------------------------------------------------------
  // A small render of the photo as developed (long edge about 512 px), restoring the open document after.
  // ctx.photoPreview, when set (node tests), stands in for the GPU render.
  async function preview(path) {
    if (ctx.photoPreview) return ctx.photoPreview(path);
    const r = ctx.renderer;
    if (!r) fail('unsupported', 'culling assist renders each photo and needs the WebGPU engine, which did not start', 'get_state', 'get_capabilities');
    const { doc } = await photoDocument(ctx, path);
    try { await r.sync(doc); return await r.image8(r.lodFor(doc, 512), null); }
    finally {
      if (ctx.store.doc) await r.sync(ctx.store.doc); else { ctx.engine?.setLayers([]); ctx.engine?.schedule(); }
      for (const l of doc.layers) if (l.file && !ctx.store.doc?.layers.some((x) => x.file === l.file)) r.dropFile(l.kind, l.file);
    }
  }
  bus.register('library.analyze-culling', async (a, { viewOnly }) => {
    viewOnly(); const s = store();
    const paths = a.paths || photoPaths(await s.list(''));
    if (paths.length > 500) fail('invalid', `${paths.length} photos; analyse at most 500 a call (pass paths)`, 'fix_argument', 'analyze_culling');
    for (const p of paths) await needPhoto(s, p, 'analyze_culling');
    const items = [];
    for (const p of paths) { const im = await preview(p); items.push({ key: p, m: measure(im.data, im.width, im.height) }); }
    const sug = suggest(items, { ...(a.blurBelow != null ? { blurBelow: a.blurBelow } : {}), ...(a.maxDistance != null ? { maxDistance: a.maxDistance } : {}) });
    const out = [];
    for (const p of paths) {
      const g = sug.get(p);
      await locked(p, async () => { const { sidecar } = await readSidecar(s, p); await writeSidecar(s, p, { ...sidecar, suggestions: { ...g, analyzed: new Date().toISOString(), accepted: false } }); });
      out.push({ path: p, flag: g.flag, reasons: g.reasons, notes: g.notes, sharpness: g.sharpness, group: g.group });
    }
    return { thresholds: { blurBelow: a.blurBelow ?? CULL_DEFAULTS.blurBelow, maxDistance: a.maxDistance ?? CULL_DEFAULTS.maxDistance, clipAbove: CULL_DEFAULTS.clipAbove }, photos: out, suggestedRejects: out.filter((x) => x.flag).length };
  });
  bus.register('library.accept-culling', async (a, { viewOnly }) => {
    viewOnly(); const s = store();
    for (const p of a.paths) await needPhoto(s, p, 'accept_cull_suggestions');
    const out = [];
    for (const p of a.paths) await locked(p, async () => {
      const { sidecar } = await readSidecar(s, p); const g = sidecar.suggestions;
      if (!g || g.accepted) { out.push({ path: p, applied: false, reason: g ? 'already accepted' : 'not analysed (analyze_culling)' }); return; }
      let next = { ...sidecar, suggestions: { ...g, accepted: true } };
      if (g.flag) next = applyCull(next, { flag: g.flag });
      await writeSidecar(s, p, next); if (g.flag) await writeXmp(s, p, next, ['flag']);
      out.push({ path: p, applied: true, flag: next.flag ?? 'none' });
    });
    return { photos: out };
  });

  // ---- Lightroom catalog import -------------------------------------------------------------------
  async function loadSql() {
    if (ctx.sqlJs) return ctx.sqlJs;
    const base = new URL('../../vendor/sql.js/', import.meta.url);
    let init; let locateFile;
    if (typeof document === 'undefined') {
      const { createRequire } = await import('node:module'); const { fileURLToPath } = await import('node:url');
      init = createRequire(import.meta.url)('../../vendor/sql.js/sql-wasm.js'); locateFile = (f) => fileURLToPath(new URL(f, base));
    } else {
      if (!globalThis.initSqlJs) await new Promise((res, rej) => { const el = document.createElement('script'); el.src = new URL('sql-wasm.js', base).href; el.onload = res; el.onerror = () => rej(new Error('could not load vendor/sql.js/sql-wasm.js')); document.head.append(el); });
      init = globalThis.initSqlJs; locateFile = (f) => new URL(f, base).href;
    }
    ctx.sqlJs = await init({ locateFile });
    return ctx.sqlJs;
  }
  bus.register('library.import-lrcat', async (a, { door, viewOnly }) => {
    viewOnly(); const s = store(); const T = 'import_lightroom_catalog';
    let bytes;
    if (a.path) { if (!a.path.toLowerCase().endsWith('.lrcat')) fail('invalid', 'path names a .lrcat file in the workspace', 'fix_argument', T); if (!(await s.exists(a.path))) fail('invalid', `no file ${a.path}`, 'fix_argument', 'list_folder'); bytes = await s.readBinary(a.path); }
    else if (ctx.pickedCatalog) bytes = ctx.pickedCatalog.bytes;
    else fail('invalid', 'pass path (a .lrcat in the workspace), or pick a catalog with the Import Lightroom catalog button', 'use_ui_control', T);
    const SQL = await loadSql();
    let cat; const db = new SQL.Database(bytes);
    try { cat = readCatalog(db); } catch (e) { fail('invalid', `${a.path || ctx.pickedCatalog.name}: ${e.message}`, 'change_target', T); } finally { db.close(); }
    const listing = await s.list(''); const photos = photoPaths(listing);
    const masters = cat.images.filter((i) => !i.copyOf); const byId = new Map(cat.images.map((i) => [i.id, i]));
    const { map, unmatched, ambiguous } = matchPaths(masters.map((i) => i.path), photos);
    const plan = new Map();   // workspace path → { image, copies: [] }
    for (const i of masters) if (map.has(i.path)) plan.set(map.get(i.path), { image: i, copies: [] });
    for (const i of cat.images) if (i.copyOf) { const m = byId.get(i.copyOf); const w = m && map.get(m.path); if (w) plan.get(w).copies.push(i); }
    const collections = cat.collections.map((c) => ({ name: safeName(c.name) ?? safeName(String(c.name).replace(/[/\\:*?"<>|]/g, '_')), items: c.images.map((id) => byId.get(id)).filter((i) => i && !i.copyOf && map.has(i.path)).map((i) => map.get(i.path)) }));
    const summary = { photos: plan.size, virtualCopies: [...plan.values()].reduce((n, p) => n + p.copies.length, 0), collections: collections.map((c) => ({ name: c.name, items: c.items.length })), unmatched: unmatched.slice(0, 50), unmatchedCount: unmatched.length, ambiguous: ambiguous.slice(0, 50), skipped: cat.skipped.slice(0, 50) };
    if (a.dryRun) return { dryRun: true, ...summary };
    const run = async () => {
      let developApplied = 0;
      for (const [path, { image, copies }] of plan) await locked(path, async () => {
        const { sidecar } = await readSidecar(s, path);
        let next = applyCull(sidecar, { rating: image.rating, flag: image.flag, label: image.label });
        next = applyKeywords(next, image.keywords, 'add');
        const raw = photoKind(path) === 'raw';
        // Develop settings fill a photo that has none in Atelier; settings made in Atelier are kept.
        const empty = !Object.keys(next.develop || {}).length && !STRUCT.some((k) => next[k]);
        if (raw && image.develop && empty && a.develop !== false) { next = { ...next, develop: { ...image.develop.settings } }; if (image.develop.curve) next.curve = image.develop.curve; developApplied++; }
        for (const c of raw ? copies : []) {
          if ((next.copies || []).some((x) => x.name === (c.copyName || 'Lightroom copy'))) continue;
          const made = addCopy(next, { name: c.copyName || 'Lightroom copy' });
          if (c.develop) { made.copy.develop = { ...c.develop.settings }; if (c.develop.curve) made.copy.curve = c.develop.curve; }
          next = made.sidecar;
        }
        await writeSidecar(s, path, next);
        await writeXmp(s, path, next, ['rating', 'flag', 'label', 'keywords']);
      });
      for (const c of collections) {
        if (!c.name) continue;
        const cur = await readCollection(s, c.name);
        if (cur.exists && cur.kind !== 'manual') continue;
        const items = new Set([...(cur.items || []), ...c.items]);
        await writeCollection(s, { ...(cur.exists ? cur : { name: c.name, created: new Date().toISOString() }), kind: 'manual', items: [...items] });
      }
      return { ...summary, developApplied };
    };
    return stageOrRun(ctx, { door }, T, `IMPORT Lightroom catalog into ${plan.size} photo sidecars and ${collections.length} collections`, run);
  });
}
