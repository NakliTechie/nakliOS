// Lightroom Classic catalog (.lrcat) import (L05). A catalog is a SQLite database; the caller opens it
// with sql.js (vendor/sql.js) and passes the database object. Pure apart from db.exec, so node tests run
// it against a synthetic catalog.
//
// Schema source: the reverse-engineered notes in lrcat-extractor 0.6.0 (doc/lrcat_format.md, MPL-2.0,
// https://crates.io/crates/lrcat-extractor), which cover Lightroom 4 and 6 and match Classic catalogs:
//   Adobe_images(id_local, rootFile → AgLibraryFile, rating, colorLabels, pick (1, 0, −1), captureTime,
//                masterImage (non-NULL for a virtual copy), copyName)
//   AgLibraryFile(id_local, baseName, extension, folder → AgLibraryFolder)
//   AgLibraryFolder(id_local, pathFromRoot, rootFolder → AgLibraryRootFolder)
//   AgLibraryRootFolder(id_local, absolutePath, name)
//   AgLibraryKeyword(id_local, name, parent), AgLibraryKeywordImage(image, tag)
//   AgLibraryCollection(id_local, name, creationId, parent, systemOnly), AgLibraryCollectionImage(collection, image)
//   Adobe_imageDevelopSettings(image, text): the develop settings as a Lua table, `s = { Exposure2012 = 0.5, … }`
// creationId: com.adobe.ag.library.collection (manual), com.adobe.ag.library.smart_collection (smart).

import { mapCrs, DEFAULT_RANGES } from './xmp.js';

// ---- a Lua table literal reader (the subset Lightroom writes) --------------------------------------
// Values: numbers, "strings" (with \" \\ \n escapes), true/false/nil, and tables with `Name = v`,
// `["key"] = v` and positional entries. Tables with only positional entries become arrays.
export function parseLua(text) {
  let i = 0; const s = String(text);
  const ws = () => { for (;;) { while (/\s/.test(s[i] || '')) i++; if (s.startsWith('--', i)) { while (i < s.length && s[i] !== '\n') i++; } else return; } };
  const err = (m) => { throw new Error(`Lua table: ${m} at ${i}`); };
  function value() {
    ws();
    const c = s[i];
    if (c === '{') return table();
    if (c === '"' || c === "'") return str();
    if (s.startsWith('[[', i)) { const e = s.indexOf(']]', i + 2); if (e < 0) err('unterminated long string'); const v = s.slice(i + 2, e); i = e + 2; return v; }
    const m = /^-?(?:0x[0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(s.slice(i, i + 40));
    if (m) { i += m[0].length; return Number(m[0]); }
    for (const [w, v] of [['true', true], ['false', false], ['nil', null]]) if (s.startsWith(w, i)) { i += w.length; return v; }
    return err('unexpected value');
  }
  function str() {
    const q = s[i++]; let out = '';
    while (i < s.length && s[i] !== q) {
      if (s[i] === '\\') { const n = s[i + 1]; out += n === 'n' ? '\n' : n === 't' ? '\t' : n; i += 2; } else out += s[i++];
    }
    if (s[i] !== q) err('unterminated string');
    i++; return out;
  }
  function table() {
    i++; const obj = {}; const arr = []; let named = false;
    for (;;) {
      ws();
      if (s[i] === '}') { i++; break; }
      let key = null;
      if (s[i] === '[' && s[i + 1] !== '[') { i++; key = value(); ws(); if (s[i] !== ']') err('expected ]'); i++; ws(); if (s[i] !== '=') err('expected ='); i++; }
      else { const m = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(s.slice(i, i + 200)); if (m) { key = m[1]; i += m[0].length; } }
      const v = value();
      if (key === null) arr.push(v); else { obj[key] = v; named = true; }
      ws();
      if (s[i] === ',' || s[i] === ';') i++;
      else if (s[i] !== '}') err('expected , or }');
    }
    if (!named) return arr;
    arr.forEach((v, k) => { obj[k + 1] = v; });
    return obj;
  }
  ws();
  const m = /^([A-Za-z_]\w*)\s*=/.exec(s.slice(i, i + 100));
  if (m) i += m[0].length;   // `s = { … }`
  return value();
}

// Lua develop table → the crs: shape readCrs gives (strings; curves as "x, y" items; tables '<struct>').
export function luaToCrs(t) {
  const out = {};
  for (const [k, v] of Object.entries(t || {})) {
    if (typeof v === 'number') out[k] = String(v);
    else if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'boolean') out[k] = v ? 'True' : 'False';
    else if (Array.isArray(v) && v.every((x) => typeof x === 'number') && v.length % 2 === 0 && /^ToneCurve/.test(k)) {
      const items = []; for (let j = 0; j < v.length; j += 2) items.push(`${v[j]}, ${v[j + 1]}`); out[k] = items;
    } else if (v !== null) out[k] = '<struct>';
  }
  return out;
}

const LABELS = ['red', 'yellow', 'green', 'blue', 'purple'];
const rows = (db, sql) => { const r = db.exec(sql); if (!r.length) return []; const { columns, values } = r[0]; return values.map((v) => Object.fromEntries(columns.map((c, k) => [c, v[k]]))); };
const hasTable = (db, name) => rows(db, `SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`).length > 0;

// Reads the catalog into plain records: { images: [{ id, path, rating, pick, label, keywords, copyOf,
// copyName, develop: { settings, curve, skipped } | null }], collections: [{ name, kind, images }],
// skipped: [{ what, reason }] }. path is the absolute path the catalog records, with '/' separators.
export function readCatalog(db, ranges = DEFAULT_RANGES) {
  const need = ['Adobe_images', 'AgLibraryFile', 'AgLibraryFolder', 'AgLibraryRootFolder'];
  const missing = need.filter((t) => !hasTable(db, t));
  if (missing.length) throw new Error(`not a Lightroom catalog: no ${missing.join(', ')} table`);
  const skipped = [];
  const imgs = rows(db, `SELECT i.id_local AS id, i.rating, i.colorLabels, i.pick, i.masterImage, i.copyName,
      r.absolutePath, f.pathFromRoot, lf.baseName, lf.extension
    FROM Adobe_images i JOIN AgLibraryFile lf ON lf.id_local = i.rootFile
    JOIN AgLibraryFolder f ON f.id_local = lf.folder JOIN AgLibraryRootFolder r ON r.id_local = f.rootFolder`);
  const kw = new Map();
  if (hasTable(db, 'AgLibraryKeywordImage') && hasTable(db, 'AgLibraryKeyword')) {
    for (const r of rows(db, 'SELECT ki.image, k.name FROM AgLibraryKeywordImage ki JOIN AgLibraryKeyword k ON k.id_local = ki.tag WHERE k.name IS NOT NULL')) {
      if (!kw.has(r.image)) kw.set(r.image, []); kw.get(r.image).push(r.name);
    }
  }
  const dev = new Map();
  if (hasTable(db, 'Adobe_imageDevelopSettings')) {
    for (const r of rows(db, 'SELECT image, text FROM Adobe_imageDevelopSettings WHERE text IS NOT NULL')) {
      try { const m = mapCrs(luaToCrs(parseLua(r.text)), ranges); dev.set(r.image, { settings: m.settings, curve: m.curve, skipped: m.skipped.length }); }
      catch (e) { skipped.push({ what: `develop settings of image ${r.image}`, reason: e.message }); }
    }
  }
  const images = imgs.map((r) => {
    const label = typeof r.colorLabels === 'string' && LABELS.includes(r.colorLabels.toLowerCase()) ? r.colorLabels.toLowerCase() : null;
    if (r.colorLabels && !label) skipped.push({ what: `label "${r.colorLabels}" on image ${r.id}`, reason: 'not one of Red, Yellow, Green, Blue, Purple' });
    const path = `${String(r.absolutePath || '').replace(/\\/g, '/').replace(/\/?$/, '/')}${String(r.pathFromRoot || '').replace(/\\/g, '/')}${r.baseName}${r.extension ? `.${r.extension}` : ''}`;
    const pick = Number(r.pick);
    return {
      id: r.id, path, rating: Number.isFinite(r.rating) ? Math.max(0, Math.min(5, Math.round(r.rating))) : 0,
      flag: pick >= 1 ? 'pick' : pick <= -1 ? 'reject' : 'none', label: label ?? 'none',
      keywords: kw.get(r.id) || [], copyOf: r.masterImage ?? null, copyName: r.copyName ?? null, develop: dev.get(r.id) ?? null,
    };
  });
  const collections = [];
  if (hasTable(db, 'AgLibraryCollection')) {
    const members = new Map();
    if (hasTable(db, 'AgLibraryCollectionImage')) for (const r of rows(db, 'SELECT collection, image FROM AgLibraryCollectionImage')) { if (!members.has(r.collection)) members.set(r.collection, []); members.get(r.collection).push(r.image); }
    for (const c of rows(db, 'SELECT id_local AS id, name, creationId, systemOnly FROM AgLibraryCollection')) {
      if (Number(c.systemOnly)) continue;
      if (c.creationId === 'com.adobe.ag.library.collection') collections.push({ name: c.name, kind: 'manual', images: members.get(c.id) || [] });
      else if (c.creationId === 'com.adobe.ag.library.smart_collection') skipped.push({ what: `smart collection "${c.name}"`, reason: "Lightroom's smart rules are not converted; recreate it with set_smart_collection" });
    }
  }
  return { images, collections, skipped };
}

// Matches catalog paths to workspace photo paths by the longest shared tail of path segments (at least
// the file name). A tail that fits more than one workspace photo is ambiguous and not matched.
// Returns Map(catalog path → workspace path) and the unmatched catalog paths.
export function matchPaths(catalogPaths, workspacePaths) {
  const seg = (p) => p.toLowerCase().split('/').filter(Boolean);
  const byName = new Map();
  for (const w of workspacePaths) { const n = seg(w).at(-1); if (!byName.has(n)) byName.set(n, []); byName.get(n).push(w); }
  const map = new Map(); const unmatched = []; const ambiguous = [];
  for (const c of catalogPaths) {
    const cs = seg(c); const cands = byName.get(cs.at(-1)) || [];
    if (!cands.length) { unmatched.push(c); continue; }
    const score = (w) => { const ws = seg(w); let k = 0; while (k < ws.length && k < cs.length && ws[ws.length - 1 - k] === cs[cs.length - 1 - k]) k++; return k; };
    const scored = cands.map((w) => [w, score(w)]).sort((a, b) => b[1] - a[1]);
    if (scored.length > 1 && scored[0][1] === scored[1][1]) { ambiguous.push(c); continue; }
    map.set(c, scored[0][0]);
  }
  // Two catalog photos that land on one workspace photo (same file name in two Lightroom folders, one
  // copy in the workspace) cannot both be it: neither is matched, so neither overwrites the other's values.
  const reached = new Map();
  for (const [c, w] of map) { if (!reached.has(w)) reached.set(w, []); reached.get(w).push(c); }
  for (const cs of reached.values()) if (cs.length > 1) for (const c of cs) { map.delete(c); ambiguous.push(c); }
  return { map, unmatched, ambiguous };
}
