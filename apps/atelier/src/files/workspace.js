// Pure workspace helpers: sidecar shape, photo listing and filtering, names, export formats and a float
// downscale for 16-bit exports. No storage calls here; the handlers in src/handlers/files.js do the I/O.

import { RAW_EXT, extOf } from '../storage.js';
import { BROWSER_IMAGE_EXT } from '../renderer.js';

export const SIDECAR_SUFFIX = '.atelier.json';
export const PAGE = 100;
// Folders the app writes images into; they hold no photos the person culls. collections/ and
// library/colours.json, library/brushes/ hold JSON only (never a photo), so a person's own top-level
// collections/ or library/ folder of photos stays listed; library/images/ holds placed-image assets (P60).
export const APP_DIRS = ['documents/', 'exports/', 'presets/', 'library/images/'];

// Develop settings kept as whole objects on a RAW layer beside the scalar `develop` values.
// lensProfile is the resolved lens profile that develop.lens_profile = 1 switches on (set_lens_profile).
export const STRUCT = ['curve', 'mixer', 'grading', 'crop', 'lut', 'lensProfile'];

export const sidecarPath = (path) => `${path}${SIDECAR_SUFFIX}`;
export const baseName = (path) => path.split('/').pop();
export const stem = (path) => baseName(path).replace(/\.[^.]+$/, '');
export function photoKind(path) {
  const e = extOf(path);
  if (RAW_EXT.includes(e)) return 'raw';
  if (BROWSER_IMAGE_EXT.includes(e)) return 'image';
  return null;
}

// A preset or document name becomes one path segment; slashes and dot segments are refused.
export function safeName(name) {
  const n = String(name ?? '').trim();
  if (!n || n === '.' || n === '..' || /[/\\:*?"<>|\u0000-\u001f]/.test(n)) return null;
  return n;
}

// Sidecar on disk: { format, version, file, develop, curve, rating, flag, label, keywords, copies, suggestions, updated }.
// develop holds only keys the engine renders; rating 0..5; flag pick|reject; label a colour; keywords a
// list of strings; copies the virtual copies (L43): [{ id, name, develop, curve…, locals, created }], each
// with its own develop settings and sharing the photo's rating, flag, label and keywords.
const SETTINGS = ['develop', ...STRUCT, 'locals'];
function settingsPart(s, rendered) {
  const develop = {};
  for (const [k, v] of Object.entries(s.develop || {})) if (rendered.includes(k) && Number.isFinite(v)) develop[k] = v;
  const out = { develop };
  for (const k of STRUCT) if (s[k] && typeof s[k] === 'object') out[k] = s[k];
  if (Array.isArray(s.locals)) out.locals = s.locals;
  return out;
}
export function normalizeSidecar(obj, rendered) {
  const s = obj && typeof obj === 'object' ? obj : {};
  const out = { format: 'atelier-sidecar', version: 1, ...settingsPart(s, rendered) };
  if (s.file) out.file = String(s.file);
  if (Number.isInteger(s.rating) && s.rating >= 0 && s.rating <= 5) out.rating = s.rating;
  if (s.flag === 'pick' || s.flag === 'reject') out.flag = s.flag;
  if (typeof s.label === 'string' && s.label && s.label !== 'none') out.label = s.label;
  const kw = normalizeKeywords(s.keywords);
  if (kw.length) out.keywords = kw;
  // Caption (set_caption, the L65 describe Accept): one plain-text string, trimmed, at most 2,000 characters.
  if (typeof s.caption === 'string' && s.caption.trim()) out.caption = s.caption.trim().slice(0, 2000);
  if (Array.isArray(s.copies)) {
    const copies = s.copies.filter((c) => c && typeof c.id === 'string' && COPY_ID.test(c.id))
      .map((c) => ({ id: c.id, name: String(c.name || c.id).slice(0, 80), ...settingsPart(c, rendered), ...(c.created ? { created: c.created } : {}) }));
    if (copies.length) out.copies = copies;
  }
  // Culling-assist suggestions (L63): measured values and a suggested flag the person may accept.
  if (s.suggestions && typeof s.suggestions === 'object') out.suggestions = s.suggestions;
  if (s.updated) out.updated = s.updated;
  return out;
}

// Applies a cull patch ({ rating?, flag?, label? }; 'none' clears) to a normalized sidecar. A photo's
// virtual copies share its rating, flag and label.
export function applyCull(sidecar, { rating, flag, label }) {
  const s = { ...sidecar };
  if (rating !== undefined) s.rating = rating;
  if (flag !== undefined) { if (flag === 'none') delete s.flag; else s.flag = flag; }
  if (label !== undefined) { if (label === 'none') delete s.label; else s.label = label; }
  return s;
}

// ---- keywords, virtual copies, collections, smart rules (L04, L43, L54) ------------------------------
export const COPY_ID = /^vc[0-9]{1,4}$/;
// A photo or virtual copy as one string: 'photos/a/B.ARW' or 'photos/a/B.ARW#vc1'.
export const itemKey = (path, copy) => (copy ? `${path}#${copy}` : path);
export const splitKey = (key) => { const i = key.lastIndexOf('#'); return i > 0 && COPY_ID.test(key.slice(i + 1)) ? { path: key.slice(0, i), copy: key.slice(i + 1) } : { path: key, copy: null }; };

// Keywords: trimmed, 1..100 characters, no commas or semicolons (Lightroom's separators), unique without
// regard to case (the first spelling wins), in the order given.
export function normalizeKeywords(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set(); const out = [];
  for (const k of list) {
    const t = String(k ?? '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 100 || /[,;]/.test(t) || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); out.push(t);
  }
  return out;
}
export function badKeyword(list) { return (list || []).find((k) => { const t = String(k ?? '').trim(); return !t || t.length > 100 || /[,;]/.test(t); }); }

// mode set replaces the list; add appends missing ones; remove drops them (case-insensitive).
export function applyKeywords(sidecar, keywords, mode = 'set') {
  const s = { ...sidecar }; const cur = s.keywords || []; const kw = normalizeKeywords(keywords);
  let next;
  if (mode === 'set') next = kw;
  else if (mode === 'add') next = normalizeKeywords([...cur, ...kw]);
  else { const drop = new Set(kw.map((k) => k.toLowerCase())); next = cur.filter((k) => !drop.has(k.toLowerCase())); }
  if (next.length) s.keywords = next; else delete s.keywords;
  return s;
}

// A new virtual copy of the photo's current settings (or of another copy's).
export function addCopy(sidecar, { name, from } = {}) {
  const copies = [...(sidecar.copies || [])];
  let n = 1; while (copies.some((c) => c.id === `vc${n}`)) n++;
  const id = `vc${n}`;
  const src = from ? copies.find((c) => c.id === from) : sidecar;
  if (!src) return null;
  const entry = { id, name: String(name || `Copy ${n}`).slice(0, 80), ...structuredClone(Object.fromEntries(SETTINGS.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]))), created: new Date().toISOString() };
  if (!entry.develop) entry.develop = {};
  return { sidecar: { ...sidecar, copies: [...copies, entry] }, copy: entry };
}
export function removeCopy(sidecar, id) {
  const copies = (sidecar.copies || []).filter((c) => c.id !== id);
  const s = { ...sidecar }; if (copies.length) s.copies = copies; else delete s.copies;
  return s;
}

// Collections: collections/<name>.json { format, version, name, kind: manual|smart, items | rules }.
export const COLLECTION_DIR = 'collections/';
export const collectionPath = (name) => `${COLLECTION_DIR}${name}.json`;
export function collectionText(c) { return `${JSON.stringify({ format: 'atelier-collection', version: 1, ...c, updated: new Date().toISOString() }, null, 2)}\n`; }

// Smart-collection rules: { match: 'all' | 'any', rules: [{ field, op, value }] }.
export const RULE_FIELDS = {
  rating: 'number', flag: 'enum', label: 'enum', keyword: 'text', camera: 'text', lens: 'text',
  iso: 'number', focalLength: 'number', date: 'date', path: 'text', kind: 'enum',
};
export const RULE_OPS = { number: ['=', '!=', '>=', '<='], enum: ['=', '!='], text: ['contains', 'notContains', '='], date: ['>=', '<=', '='] };
export function checkRules(spec) {
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.rules) || !spec.rules.length) return 'rules needs { match, rules: [{ field, op, value }] } with at least one rule';
  if (spec.match !== undefined && !['all', 'any'].includes(spec.match)) return 'match is all or any';
  for (const [i, r] of spec.rules.entries()) {
    const t = RULE_FIELDS[r?.field];
    if (!t) return `rules[${i}].field must be one of ${Object.keys(RULE_FIELDS).join(', ')}`;
    if (!RULE_OPS[t].includes(r.op)) return `rules[${i}].op for ${r.field} must be one of ${RULE_OPS[t].join(', ')}`;
    if (t === 'number' && !Number.isFinite(r.value)) return `rules[${i}].value must be a number`;
    if (t === 'date' && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(String(r.value))) return `rules[${i}].value must be a date YYYY, YYYY-MM or YYYY-MM-DD`;
    if ((t === 'text' || t === 'enum') && (typeof r.value !== 'string' || !r.value)) return `rules[${i}].value must be a non-empty string`;
  }
  return null;
}
// The row value a rule field reads. Text compares case-insensitively.
function fieldValue(row, f) {
  const e = row.exif || {};
  switch (f) {
    case 'rating': return row.rating ?? 0;
    case 'flag': return row.flag ?? 'none';
    case 'label': return row.label ?? 'none';
    case 'keyword': return (row.keywords || []);
    case 'camera': return e.camera ?? null;
    case 'lens': return e.lens ?? null;
    case 'iso': return e.iso ?? null;
    case 'focalLength': return e.focalLength ?? null;
    case 'date': return e.date ? e.date.slice(0, 10) : null;
    case 'path': return row.path;
    case 'kind': return row.kind;
    default: return null;
  }
}
function ruleMatch(row, r) {
  const t = RULE_FIELDS[r.field]; const v = fieldValue(row, r.field);
  if (r.field === 'keyword') {
    const q = r.value.toLowerCase(); const ks = v.map((k) => k.toLowerCase());
    if (r.op === '=') return ks.includes(q);
    const has = ks.some((k) => k.includes(q));
    return r.op === 'contains' ? has : !has;
  }
  if (v === null || v === undefined) return r.op === '!=' || r.op === 'notContains';
  if (t === 'number') return r.op === '=' ? v === r.value : r.op === '!=' ? v !== r.value : r.op === '>=' ? v >= r.value : v <= r.value;
  if (t === 'enum') return r.op === '=' ? v === r.value : v !== r.value;
  if (t === 'date') {
    // A partial date compares on its own length: '2024' matches every day of 2024 for '='.
    const a = v.slice(0, String(r.value).length);
    return r.op === '=' ? a === r.value : r.op === '>=' ? a >= r.value : a <= r.value;
  }
  const s = String(v).toLowerCase(); const q = r.value.toLowerCase();
  return r.op === '=' ? s === q : r.op === 'contains' ? s.includes(q) : !s.includes(q);
}
export function matchRules(row, spec) {
  const res = spec.rules.map((r) => ruleMatch(row, r));
  return (spec.match ?? 'all') === 'any' ? res.some(Boolean) : res.every(Boolean);
}

// Applies copied develop settings ({ ...keys, curve?, mixer?, grading? }) to a normalized sidecar.
export function applySettings(sidecar, copied, rendered) {
  const s = { ...sidecar, develop: { ...sidecar.develop } };
  for (const [k, v] of Object.entries(copied)) {
    if (STRUCT.includes(k)) s[k] = structuredClone(v);
    else if (rendered.includes(k)) s.develop[k] = v;
  }
  return s;
}

export const sidecarText = (s, file) => `${JSON.stringify({ ...s, file: s.file ?? file, updated: new Date().toISOString() }, null, 2)}\n`;

// Storage listing → photo paths (RAW and browser images) outside the app's own folders, sorted. A library
// sync root inside the workspace (src/files/sync.js: <root>/.meta/… beside the synced copies) is the
// shared folder, not the person's photos, so everything under it is left out too.
export function photoPaths(listing) {
  const paths = listing.map((e) => e.path);
  const syncRoots = [...new Set(paths.filter((p) => p.includes('/.meta/')).map((p) => `${p.slice(0, p.indexOf('/.meta/'))}/`))];
  return paths
    .filter((p) => !p.endsWith(SIDECAR_SUFFIX) && !APP_DIRS.some((d) => p.startsWith(d)) && !syncRoots.some((r) => p.startsWith(r)) && photoKind(p))
    .sort((a, b) => a.localeCompare(b));
}

// rows: [{ path, copy?, rating, flag, label, keywords?, exif? }]; filter per the list_folder schema.
// keyword: the row has that keyword (case-insensitive, whole keyword); items: a Set of itemKey strings
// (a collection's members); text: path contains; camera/lens: contains; iso/focal ranges and dates
// (YYYY-MM-DD, inclusive) read the cached EXIF, and a row without the field does not match.
export function filterPhotos(rows, filter = {}) {
  const lc = (s) => String(s ?? '').toLowerCase();
  return rows.filter((r) => {
    const e = r.exif || {};
    if (filter.minRating != null && (r.rating ?? 0) < filter.minRating) return false;
    if (filter.flag && (r.flag ?? 'none') !== filter.flag) return false;
    if (filter.label && (r.label ?? 'none') !== filter.label) return false;
    if (filter.keyword && !(r.keywords || []).some((k) => lc(k) === lc(filter.keyword))) return false;
    if (filter.items && !filter.items.has(itemKey(r.path, r.copy))) return false;
    if (filter.text && !lc(r.path).includes(lc(filter.text))) return false;
    if (filter.camera && !(e.camera && lc(e.camera).includes(lc(filter.camera)))) return false;
    if (filter.lens && !(e.lens && lc(e.lens).includes(lc(filter.lens)))) return false;
    if (filter.isoMin != null && !(e.iso >= filter.isoMin)) return false;
    if (filter.isoMax != null && !(e.iso <= filter.isoMax)) return false;
    if (filter.focalMin != null && !(e.focalLength >= filter.focalMin)) return false;
    if (filter.focalMax != null && !(e.focalLength <= filter.focalMax)) return false;
    if (filter.dateFrom && !(e.date && e.date.slice(0, 10) >= filter.dateFrom)) return false;
    if (filter.dateTo && !(e.date && e.date.slice(0, 10) <= filter.dateTo)) return false;
    return true;
  });
}

export function pageOf(rows, page = 0, size = PAGE) {
  return { page, pages: Math.max(1, Math.ceil(rows.length / size)), total: rows.length, rows: rows.slice(page * size, page * size + size) };
}

// Export formats: extension and MIME type; tiff16, tiff-layered and psd are written by src/files/, not a canvas.
export const FORMATS = {
  jpeg: { ext: ['jpg', 'jpeg'], mime: 'image/jpeg' },
  png: { ext: ['png'], mime: 'image/png' },
  webp: { ext: ['webp'], mime: 'image/webp' },
  avif: { ext: ['avif'], mime: 'image/avif' },
  tiff16: { ext: ['tif', 'tiff'], mime: 'image/tiff' },
  'tiff-layered': { ext: ['tif', 'tiff'], mime: 'image/tiff' },
  psd: { ext: ['psd'], mime: 'image/vnd.adobe.photoshop' },
};
// Formats written as layers (src/files/layered.js) rather than as one flat image.
export const LAYERED_FORMATS = ['psd', 'tiff-layered'];
// A layer name as one file-name segment.
export const fileSafe = (name) => String(name ?? '').replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || 'layer';

// Resolves an export path: a bare name goes under folder; a missing extension gets the format's.
// Returns null when the extension names a different format.
export function exportPath(path, format, folder = 'exports') {
  let p = path.includes('/') ? path.replace(/^\/+/, '') : `${folder.replace(/\/+$/, '')}/${path}`;
  const f = FORMATS[format];
  const hasExt = /\.[A-Za-z0-9]+$/.test(baseName(p));
  if (!hasExt) return `${p}.${f.ext[0]}`;
  const e = extOf(p);
  if (f.ext.includes(e)) return p;
  return Object.values(FORMATS).some((x) => x.ext.includes(e)) ? null : `${p}.${f.ext[0]}`;
}

// Export preset settings Atelier applies; any other key is refused so a preset never promises more.
export const EXPORT_KEYS = ['format', 'quality', 'maxEdge', 'colorSpace'];
export function checkExportSettings(s) {
  const extra = Object.keys(s).filter((k) => !EXPORT_KEYS.includes(k));
  if (extra.length) return { status: 'unsupported', message: `not built yet: ${extra.join(', ')}; Atelier exports apply ${EXPORT_KEYS.join(', ')}` };
  if (!s.format || !(s.format in FORMATS)) return { status: 'invalid', message: `format must be one of ${Object.keys(FORMATS).join(', ')}` };
  if (s.quality != null && !(Number.isInteger(s.quality) && s.quality >= 1 && s.quality <= 100)) return { status: 'invalid', message: 'quality is an integer 1 to 100' };
  if (s.maxEdge != null && !(Number.isInteger(s.maxEdge) && s.maxEdge >= 16)) return { status: 'invalid', message: 'maxEdge is an integer of at least 16' };
  if (s.colorSpace != null && !['srgb', 'display-p3', 'rec2020'].includes(s.colorSpace)) return { status: 'invalid', message: 'colorSpace is srgb, display-p3 or rec2020' };
  return null;
}

// Area-average downscale of an RGBA float image (premultiplied, so averaging is correct) to fit maxEdge.
export function resizeFloat(im, maxEdge) {
  const k = Math.min(1, maxEdge / Math.max(im.width, im.height));
  if (k >= 1) return im;
  const w = Math.max(1, Math.round(im.width * k)); const h = Math.max(1, Math.round(im.height * k));
  const out = new Float32Array(w * h * 4);
  const sx = im.width / w; const sy = im.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy); const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx); const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const acc = [0, 0, 0, 0]; const n = (y1 - y0) * (x1 - x0);
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * im.width + xx) * 4; for (let c = 0; c < 4; c++) acc[c] += im.data[i + c]; }
      for (let c = 0; c < 4; c++) out[(y * w + x) * 4 + c] = acc[c] / n;
    }
  }
  return { width: w, height: h, data: out };
}
