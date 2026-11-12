// Pure workspace helpers: sidecar shape, photo listing and filtering, names, export formats and a float
// downscale for 16-bit exports. No storage calls here; the handlers in src/handlers/files.js do the I/O.

import { RAW_EXT, extOf } from '../storage.js';
import { BROWSER_IMAGE_EXT } from '../renderer.js';

export const SIDECAR_SUFFIX = '.atelier.json';
export const PAGE = 100;
// Folders the app writes; they hold no photos the person culls.
export const APP_DIRS = ['documents/', 'exports/', 'presets/'];

// Develop settings kept as whole objects on a RAW layer beside the scalar `develop` values.
export const STRUCT = ['curve', 'mixer', 'grading', 'crop', 'lut'];

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

// Sidecar on disk: { format, version, file, develop, curve, rating, flag, label, updated }.
// develop holds only keys the engine renders; rating 0..5; flag pick|reject; label a colour.
export function normalizeSidecar(obj, rendered) {
  const s = obj && typeof obj === 'object' ? obj : {};
  const develop = {};
  for (const [k, v] of Object.entries(s.develop || {})) if (rendered.includes(k) && Number.isFinite(v)) develop[k] = v;
  const out = { format: 'atelier-sidecar', version: 1, develop };
  if (s.file) out.file = String(s.file);
  for (const k of STRUCT) if (s[k] && typeof s[k] === 'object') out[k] = s[k];
  if (Array.isArray(s.locals)) out.locals = s.locals;
  if (Number.isInteger(s.rating) && s.rating >= 0 && s.rating <= 5) out.rating = s.rating;
  if (s.flag === 'pick' || s.flag === 'reject') out.flag = s.flag;
  if (typeof s.label === 'string' && s.label && s.label !== 'none') out.label = s.label;
  if (s.updated) out.updated = s.updated;
  return out;
}

// Applies a cull patch ({ rating?, flag?, label? }; 'none' clears) to a normalized sidecar.
export function applyCull(sidecar, { rating, flag, label }) {
  const s = { ...sidecar };
  if (rating !== undefined) s.rating = rating;
  if (flag !== undefined) { if (flag === 'none') delete s.flag; else s.flag = flag; }
  if (label !== undefined) { if (label === 'none') delete s.label; else s.label = label; }
  return s;
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

// Storage listing → photo paths (RAW and browser images) outside the app's own folders, sorted.
export function photoPaths(listing) {
  return listing.map((e) => e.path)
    .filter((p) => !p.endsWith(SIDECAR_SUFFIX) && !APP_DIRS.some((d) => p.startsWith(d)) && photoKind(p))
    .sort((a, b) => a.localeCompare(b));
}

// rows: [{ path, rating, flag, label }]; filter per the list_folder schema.
export function filterPhotos(rows, filter = {}) {
  return rows.filter((r) => {
    if (filter.minRating != null && (r.rating ?? 0) < filter.minRating) return false;
    if (filter.flag && (r.flag ?? 'none') !== filter.flag) return false;
    if (filter.label && (r.label ?? 'none') !== filter.label) return false;
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
