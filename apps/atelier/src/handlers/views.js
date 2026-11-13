// View commands (parity rows L42, L51, L56, L57, L58, L72): colour scopes, command search, rendering other
// photos for compare, slideshow and print, preset previews on a scratch copy, photo locations from EXIF GPS,
// and the static web gallery export. Every read here leaves the document and its revision unchanged; the
// engine is pointed at a temporary document and synced back to the open one afterwards.

import { newDocument, makeLayer, createStore } from '../document.js';
import { DEVELOP_RENDERED } from '../../vendor/tessella/src/model.js';
import { sidecarPath, baseName, stem, photoKind, normalizeSidecar, photoPaths, STRUCT, fileSafe } from '../files/workspace.js';
import { cropGeometry } from './develop.js';
import { localId } from './select.js';
import { register as registerFiles, photoDocument as openPhotoDocument } from './files.js';
import { PARITY } from '../ui/parity.js';
import { COMPOSITE_TOOLS, DEVELOP_TOOLS } from '../ui/tools.js';
import { needDoc, fail, stageOrRun } from './util.js';
import { bookLayout, packBook, sha256Hex } from '../files/book.js';

// ---- colour scopes (pure) ---------------------------------------------------------------------------
// Input: display-encoded sRGB 8-bit RGBA, as the preview shows it. Formulas (Atelier's own choices):
//   luma Y' = 0.2126 R' + 0.7152 G' + 0.0722 B'  (Rec. 709 weights on encoded values, as get_histogram)
//   Cb = (B' - Y') / 1.8556,  Cr = (R' - Y') / 1.5748  (Rec. 709 colour difference, each in -0.5..0.5)
//   vectorscope angle = atan2(Cr, Cb) in degrees 0..360, chroma = sqrt(Cb² + Cr²)
//   waveform cell: column = floor(x · columns / width), level = floor(value · levels / 256)
const ycc = (r, g, b) => { const y = 0.2126 * r + 0.7152 * g + 0.0722 * b; return [y, (b - y) / 1.8556, (r - y) / 1.5748]; };
const angleOf = (cb, cr) => ((Math.atan2(cr, cb) * 180) / Math.PI + 360) % 360;
// Where pure primaries and secondaries land on the vectorscope (degrees), plus the skin-tone line.
export const VECTOR_TARGETS = Object.fromEntries([['red', [1, 0, 0]], ['yellow', [1, 1, 0]], ['green', [0, 1, 0]], ['cyan', [0, 1, 1]], ['blue', [0, 0, 1]], ['magenta', [1, 0, 1]]]
  .map(([k, c]) => { const [, cb, cr] = ycc(...c); return [k, Math.round(angleOf(cb, cr) * 10) / 10]; }).concat([['skin', 123]]));

export function computeScopes(data, width, height, { columns = 64, levels = 64, vectorGrid = 32, angleBins = 72, chromaFloor = 0.02 } = {}) {
  const grid = (rows, cols) => Array.from({ length: rows }, () => new Array(cols).fill(0));
  const hist = { red: new Array(levels).fill(0), green: new Array(levels).fill(0), blue: new Array(levels).fill(0), luma: new Array(levels).fill(0) };
  const wave = { luma: grid(levels, columns), red: grid(levels, columns), green: grid(levels, columns), blue: grid(levels, columns) };
  const vec = grid(vectorGrid, vectorGrid); const angles = new Array(angleBins).fill(0);
  const lv = (v) => Math.min(levels - 1, Math.floor((v * levels) / 256));
  const vg = (v) => Math.min(vectorGrid - 1, Math.max(0, Math.floor((v + 0.5) * vectorGrid)));
  let opaque = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue;
      opaque++;
      const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
      const col = Math.min(columns - 1, Math.floor((x * columns) / width));
      const yl = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      hist.red[lv(r)]++; hist.green[lv(g)]++; hist.blue[lv(b)]++; hist.luma[lv(yl)]++;
      wave.luma[lv(yl)][col]++; wave.red[lv(r)][col]++; wave.green[lv(g)][col]++; wave.blue[lv(b)][col]++;
      const [, cb, cr] = ycc(r / 255, g / 255, b / 255);
      vec[vg(cr)][vg(cb)]++;   // row = Cr (bottom = -0.5), column = Cb
      if (Math.hypot(cb, cr) >= chromaFloor) angles[Math.min(angleBins - 1, Math.floor((angleOf(cb, cr) * angleBins) / 360))]++;
    }
  }
  return {
    width, height, pixels: opaque, encoding: 'sRGB 8-bit, display', columns, levels,
    histogram: hist,
    waveform: { ...wave, layout: 'waveform[channel][level][column]; level 0 is black' },
    parade: ['red', 'green', 'blue'],
    vectorscope: { grid: vec, size: vectorGrid, layout: 'grid[cr][cb], Cb and Cr from -0.5 to 0.5, row 0 is Cr = -0.5', angles, angleBins, chromaFloor, targets: VECTOR_TARGETS },
  };
}

// ---- command search by task (pure) -------------------------------------------------------------------
// A task phrase maps to the words the commands and controls use. Synonyms name tools that may not exist yet
// (generative remove); search answers only with what the manifest and the parity table hold now.
export const SYNONYMS = {
  'remove object': ['heal', 'spot', 'clone', 'content-aware', 'remove', 'inpaint'],
  'remove blemish': ['heal', 'spot', 'clone'],
  'erase': ['eraser', 'heal', 'remove'],
  'background blur': ['lens blur', 'set_lens_blur', 'depth'],
  'bokeh': ['lens blur', 'set_lens_blur'],
  'blur background': ['lens blur', 'set_lens_blur'],
  'white balance': ['temperature', 'tint'],
  'colour temperature': ['temperature'], 'color temperature': ['temperature'],
  'warmer': ['temperature'], 'cooler': ['temperature'],
  'brighten': ['exposure', 'shadows', 'levels'], 'darken': ['exposure', 'blacks', 'levels'],
  'brightness': ['exposure'], 'lighten': ['exposure', 'shadows'],
  'straighten': ['straighten', 'angle', 'crop'], 'rotate': ['straighten', 'angle', 'transform'], 'level horizon': ['straighten'],
  'cut out': ['selection', 'mask', 'wand', 'lasso'], 'select subject': ['selection', 'wand', 'lasso'],
  'noise': ['nr_luminance', 'nr_color', 'noise'], 'denoise': ['nr_luminance', 'nr_color'], 'grainy': ['nr_luminance', 'grain'],
  'sharpen': ['sharpen_amount', 'texture', 'clarity'], 'sharper': ['sharpen_amount'],
  'vignette': ['vignette_amount'], 'film grain': ['grain_amount'],
  'black and white': ['black-and-white', 'monochrome', 'mixer'], 'monochrome': ['black-and-white', 'mixer'], 'b&w': ['black-and-white'],
  'haze': ['dehaze'], 'fog': ['dehaze'],
  'colour': ['color', 'mixer', 'grading', 'saturation', 'vibrance'], 'vivid': ['vibrance', 'saturation'], 'muted': ['saturation'],
  'look': ['preset', 'lut', 'grading'], 'filter': ['preset', 'lut', 'apply_filter'], 'style': ['preset'],
  'save as': ['export_image', 'export'], 'jpeg': ['export'], 'share': ['export', 'gallery'], 'website': ['web gallery', 'export_web_gallery'],
  'resize': ['set_document', 'export', 'maxEdge'], 'canvas size': ['set_document'],
  'trim': ['crop'], 'aspect ratio': ['crop'],
  'perspective': ['upright', 'transform'], 'keystone': ['upright_vertical', 'upright_horizontal'],
  'chromatic aberration': ['ca_remove', 'ca_red'], 'fringe': ['ca_remove'], 'lens correction': ['lens_profile', 'distortion'],
  'scopes': ['waveform', 'vectorscope', 'histogram'], 'waveform': ['scopes'], 'vectorscope': ['scopes'], 'parade': ['scopes'],
  'side by side': ['compare'], 'compare': ['compare view'], 'before after': ['before'],
  'slideshow': ['slideshow'], 'print': ['print'], 'map': ['map', 'location'], 'gps': ['map', 'location'],
  'rating': ['set_rating', 'star'], 'stars': ['set_rating'], 'reject': ['set_rating', 'flag'], 'pick': ['set_rating', 'flag'],
  'copy settings': ['copy_settings', 'sync'], 'batch': ['sync_settings', 'export_batch'],
  'text': ['type', 'text'], 'title': ['type', 'text'], 'gradient': ['gradient', 'linear'], 'paint': ['brush'],
  'undo': ['undo'], 'history': ['get_history', 'snapshot'], 'contrast': ['contrast', 'curve'],
  'node': ['node view'], 'nodes': ['node view'], 'node graph': ['node view'], 'stack': ['node view', 'layer'],
};

const words = (s) => String(s).toLowerCase().replace(/[_\-./()…,:;+]/g, ' ').split(/\s+/).filter(Boolean);
const TOOL_KEYS = new Map([...COMPOSITE_TOOLS.map((t) => [t, 'composite']), ...DEVELOP_TOOLS.map((t) => [t, 'develop'])]);

// Entries: manifest tools (person-only ones too, flagged), parity controls, set_develop parameters and tool bar tools.
export function buildSearchIndex(manifest, parity = PARITY) {
  const out = [];
  for (const t of manifest.tools) out.push({ kind: 'command', id: t.name, command: t.name, label: t.name[0].toUpperCase() + t.name.slice(1).replace(/_/g, ' '), text: `${t.name} ${t.description}`, personOnly: !!t.personOnly });
  for (const [label, cmd] of parity) out.push({ kind: 'control', id: `control:${label}`, command: cmd.startsWith('person:') ? null : cmd === 'view' ? null : cmd, label, text: label, person: cmd.startsWith('person:') ? cmd.slice(8) : undefined });
  const dev = manifest.tools.find((t) => t.name === 'set_develop');
  for (const p of Object.keys(dev?.inputSchema.properties.params?.properties || {})) out.push({ kind: 'parameter', id: `set_develop.${p}`, command: 'set_develop', param: p, label: `${p.replace(/_/g, ' ')} (develop slider)`, text: `${p} ${p.replace(/_/g, ' ')}` });
  for (const [[tool, label, key], mode] of TOOL_KEYS) out.push({ kind: 'tool', id: `tool:${mode}:${tool}`, tool, mode, label: `${label} tool (${key}, ${mode})`, text: `${tool} ${label} tool` });
  return out.map((e) => ({ ...e, words: new Set(words(e.text)), name: (e.command || e.tool || e.param || '').toLowerCase() }));
}

// Words a task phrase uses that name no command ("make it warmer" is about warmth, not make_book).
const STOP = new Set(['make', 'it', 'the', 'a', 'an', 'to', 'my', 'me', 'more', 'less', 'bit', 'little', 'this', 'photo', 'image', 'picture', 'and', 'of', 'in', 'on', 'for', 'how', 'do', 'i', 'can', 'want', 'please']);
// Score: an exact command, parameter or tool name 12; a query word in the label or name 4, in the text 2;
// a synonym of a task phrase found in the query: 6 when it names the entry, 3 when it is one of its words.
export function searchCommands(index, query, limit = 10) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const qWords = words(q).filter((w) => !STOP.has(w));
  const syn = [];
  for (const [phrase, targets] of Object.entries(SYNONYMS)) if (` ${q} `.includes(` ${phrase} `) || q === phrase) syn.push(...targets);
  const scored = [];
  for (const e of index) {
    let s = 0;
    const lw = new Set(words(e.label));
    if (e.name && (e.name === q.replace(/\s+/g, '_') || e.name === q)) s += 12;
    for (const w of qWords) { if (w.length < 2) continue; if (lw.has(w) || words(e.name).includes(w)) s += 4; else if (e.words.has(w)) s += 2; }
    for (const t of syn) {
      const tl = t.toLowerCase();
      if (e.name === tl || e.label.toLowerCase().includes(tl)) s += 6;
      else if (words(tl).every((w) => e.words.has(w))) s += 3;
    }
    if (e.personOnly) s -= 1;
    if (s > 0) scored.push({ s, e });
  }
  scored.sort((a, b) => b.s - a.s || a.e.label.length - b.e.label.length);
  return scored.slice(0, limit).map(({ s, e }) => ({ score: s, kind: e.kind, label: e.label, command: e.command ?? null, ...(e.param ? { param: e.param } : {}), ...(e.tool ? { tool: e.tool, mode: e.mode } : {}), ...(e.person ? { person: e.person } : {}), ...(e.personOnly ? { personOnly: true } : {}) }));
}

// ---- EXIF GPS (pure) ---------------------------------------------------------------------------------
// Reads GPSLatitude/GPSLongitude from a TIFF structure (TIFF-based RAW: ARW, NEF, DNG, CR2, ORF, RW2, PEF)
// or a JPEG's APP1 Exif block, or the JPEG preview inside a Fujifilm RAF. CR3 (ISO media) returns null.
// Decimal degrees = deg + min / 60 + sec / 3600, negative for S and W.
export function readGps(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 16) return null;
  if (u8[0] === 0xff && u8[1] === 0xd8) return gpsFromJpeg(u8);
  if (String.fromCharCode(...u8.subarray(0, 15)) === 'FUJIFILMCCD-RAW') {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const off = dv.getUint32(84); const len = dv.getUint32(88);
    return off && off + len <= u8.length ? gpsFromJpeg(u8.subarray(off, off + len)) : null;
  }
  return gpsFromTiff(u8, 0);
}
function gpsFromJpeg(u8) {
  let p = 2;
  while (p + 4 < u8.length && u8[p] === 0xff) {
    const marker = u8[p + 1]; const len = (u8[p + 2] << 8) | u8[p + 3];
    if (marker === 0xe1 && String.fromCharCode(...u8.subarray(p + 4, p + 10)) === 'Exif\0\0') return gpsFromTiff(u8, p + 10);
    if (marker === 0xda) break;
    p += 2 + len;
  }
  return null;
}
function gpsFromTiff(u8, base) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (base + 8 > u8.length) return null;
  const order = String.fromCharCode(u8[base], u8[base + 1]);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const u16 = (o) => dv.getUint16(base + o, le); const u32 = (o) => dv.getUint32(base + o, le);
  const inRange = (o, n) => base + o >= 0 && base + o + n <= u8.length;
  function entries(ifd) {
    if (!inRange(ifd, 2)) return [];
    const n = u16(ifd); const out = [];
    for (let i = 0; i < n && inRange(ifd + 2 + i * 12, 12); i++) { const e = ifd + 2 + i * 12; out.push({ tag: u16(e), type: u16(e + 2), count: u32(e + 4), at: e + 8 }); }
    return out;
  }
  const gpsTag = entries(u32(4)).find((e) => e.tag === 0x8825);
  if (!gpsTag) return null;
  const tags = new Map(entries(u32(gpsTag.at)).map((e) => [e.tag, e]));
  const ref = (t) => { const e = tags.get(t); return e ? String.fromCharCode(dv.getUint8(base + e.at)) : null; };
  const dms = (t) => {
    const e = tags.get(t); if (!e || e.type !== 5 || e.count < 3) return null;
    const o = u32(e.at); if (!inRange(o, 24)) return null;
    const r = (k) => { const d = u32(o + k * 8 + 4); return d ? u32(o + k * 8) / d : 0; };
    return r(0) + r(1) / 60 + r(2) / 3600;
  };
  const lat = dms(2); const lon = dms(4);
  if (lat == null || lon == null) return null;
  const v = { lat: ref(1) === 'S' ? -lat : lat, lon: ref(3) === 'W' ? -lon : lon };
  return Math.abs(v.lat) <= 90 && Math.abs(v.lon) <= 180 ? v : null;
}

// ---- web gallery (pure) ------------------------------------------------------------------------------
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// items: [{ title, image, thumb, width, height }] with paths relative to the gallery folder.
export function galleryHtml(title, items) {
  const cards = items.map((it) => `  <figure><a href="${escHtml(it.image)}"><img src="${escHtml(it.thumb)}" alt="${escHtml(it.title)}" loading="lazy" width="${it.thumbWidth}" height="${it.thumbHeight}"></a><figcaption>${escHtml(it.title)}</figcaption></figure>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<style>
 body { margin: 0; padding: 24px 16px; background: #fafafa; color: #111; font: 15px/1.4 "Helvetica Neue", Helvetica, Arial, sans-serif; }
 h1 { font-size: 20px; font-weight: 600; margin: 0 0 16px; }
 main { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
 figure { margin: 0; } img { width: 100%; height: auto; display: block; background: #ddd; }
 figcaption { font-size: 13px; color: #555; margin-top: 4px; overflow-wrap: anywhere; }
</style></head>
<body><h1>${escHtml(title)}</h1>
<main>
${cards}
</main>
<p style="color:#777;font-size:12px">${items.length} photo${items.length === 1 ? '' : 's'}. Made with Atelier; no scripts, no tracking.</p>
</body></html>
`;
}

// ---- photos as temporary documents ---------------------------------------------------------------------
// A photo as it would open (sidecar develop, crop, local adjustments), without opening it. The open photo
// uses the open document, so unsaved edits show.
export async function photoDocument(ctx, path) {
  const open = ctx.store.doc;
  if (open?.photo?.path === path && !open.photo.copy) return structuredClone(open);
  return (await openPhotoDocument(ctx, path)).doc;
}

const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };

export function register(bus, ctx) {
  const store = () => { const s = ctx.storage(); if (!s) fail('unsupported', 'no workspace storage; grant a folder or allow browser storage', 'use_ui_control', 'grant_folder'); return s; };
  const renderer = () => { if (!ctx.renderer) fail('unsupported', 'this command needs the WebGPU engine, which did not start', 'get_state', 'get_capabilities'); return ctx.renderer; };

  // Renders a document other than the open one, then shows the open one again (or nothing). Each photo's
  // decoded source is released after its render unless the open document uses it, so GPU memory holds at
  // most the open document plus one photo.
  async function renderOther(doc, maxEdge) {
    const r = renderer();
    try {
      await r.sync(doc);
      return await r.resize(await r.image8(r.lodFor(doc, maxEdge), null, 0.18), maxEdge);
    } finally {
      if (ctx.store.doc) await r.sync(ctx.store.doc); else { ctx.engine?.setLayers([]); ctx.engine?.schedule(); }
      for (const l of doc.layers) if (l.file && !ctx.store.doc?.layers.some((x) => x.file === l.file)) r.dropFile(l.kind, l.file);
    }
  }
  const jpeg = async (im, q = 0.88) => ({ mime: 'image/jpeg', width: im.width, height: im.height, base64: b64(await ctx.renderer.encode(im, 'image/jpeg', q)) });

  // L58 colour scopes from the rendered preview (the composite, one layer, or before develop).
  bus.register('query.scopes', async (a) => {
    const doc = needDoc(ctx); const r = renderer();
    let variant = null;
    if (a.layerId || a.before) {
      variant = structuredClone(doc);
      if (a.layerId) {
        if (!variant.layers.some((l) => l.id === a.layerId)) fail('invalid', `no layer ${a.layerId}`, 'get_state', 'get_state');
        variant.layers = variant.layers.filter((l) => l.id === a.layerId).map((l) => ({ ...l, visible: true }));
      }
      if (a.before) for (const l of variant.layers) if (l.kind === 'raw') { l.develop = {}; delete l.curve; }
    }
    if (variant) await r.sync(variant);
    try {
      const im = await r.image8(r.lodFor(doc, a.maxEdge ?? 512), null, null);
      return computeScopes(im.data, im.width, im.height, { columns: a.columns ?? 64, levels: a.levels ?? 64, vectorGrid: a.vectorGrid ?? 32 });
    } finally { if (variant) await r.sync(ctx.store.doc); }
  });

  // L72 command search by task.
  let index = null;
  bus.register('query.search', (a) => {
    index ||= buildSearchIndex(bus.manifest);
    const results = searchCommands(index, a.query, a.limit ?? 10).map((x) => (x.command && !x.personOnly ? { ...x, built: bus.has(bus.manifest.tools.find((t) => t.name === x.command)?.handler) } : x));
    return { query: a.query, results };
  });

  // L56, L51: photos rendered as they would open, for compare, slideshow and print.
  bus.register('query.photos', async (a) => {
    store(); renderer();
    const out = [];
    for (const p of a.paths) {
      const doc = await photoDocument(ctx, p);
      const im = await renderOther(doc, a.maxEdge ?? 1024);
      out.push({ path: p, ...(await jpeg(im)) });
    }
    return { photos: out };
  });

  // L57 preset previews: each preset is applied by the real apply_preset handler to a scratch copy of the
  // document (its own store, no render, no autosave), then the copy is rendered. The open document, its
  // undo history and its revision stay as they were.
  bus.register('query.preset-previews', async (a) => {
    const doc = needDoc(ctx); store(); renderer();
    const raws = doc.layers.filter((l) => l.kind === 'raw' && !l.localOf);
    const target = a.layerId ? raws.find((l) => l.id === a.layerId) : raws.find((l) => l.id === doc.activeLayerId) ?? raws[0];
    if (!target) fail('unsupported', a.layerId ? `${a.layerId} is not a RAW layer` : 'the document has no RAW layer; presets apply to RAW layers', 'change_target', 'list_layers');
    const previews = [];
    for (const preset of a.presets) {
      const scratch = await presetScratch(bus, ctx, target.id, preset);
      if (scratch.status !== 'ok') { previews.push({ preset, status: scratch.status, message: scratch.message }); continue; }
      const im = await renderOther(scratch.doc, a.maxEdge ?? 256);
      previews.push({ preset, status: 'ok', applied: scratch.result.applied, skipped: scratch.result.skipped, ...(await jpeg(im, 0.82)) });
    }
    return { layerId: target.id, previews };
  });

  // L51 map: GPS positions from EXIF, a page of photos at a time (each file is read once and cached).
  const gpsCache = new Map();
  bus.register('query.locations', async (a) => {
    const s = store();
    const all = photoPaths(await s.list(''));
    const page = a.page ?? 0; const size = 50; const pages = Math.max(1, Math.ceil(all.length / size));
    const placed = []; const missing = [];
    for (const p of all.slice(page * size, page * size + size)) {
      if (!gpsCache.has(p)) { let g = null; try { g = readGps(await s.readBinary(p)); } catch { g = null; } gpsCache.set(p, g); }
      const g = gpsCache.get(p);
      if (g) placed.push({ path: p, lat: Math.round(g.lat * 1e6) / 1e6, lon: Math.round(g.lon * 1e6) / 1e6 }); else missing.push(p);
    }
    return { page, pages, total: all.length, placed, missing };
  });

  // L51 web gallery: a static folder (index.html, images/, thumbs/) written through the storage adapter.
  bus.register('file.web-gallery', async (a, { door }) => {
    const s = store(); renderer();
    const folder = (a.folder || 'exports/gallery').replace(/^\/+|\/+$/g, '');
    if (folder.split('/').some((x) => x === '..' || x === '.')) fail('invalid', 'folder stays inside the workspace', 'fix_argument', 'export_web_gallery');
    for (const p of a.paths) { if (!photoKind(p)) fail('unsupported', `${p} is not a RAW or browser image`, 'fix_argument', 'export_web_gallery'); if (!(await s.exists(p))) fail('invalid', `no file ${p}`, 'fix_argument', 'list_folder'); }
    const names = a.paths.map((p) => fileSafe(stem(p)));
    if (new Set(names).size !== names.length) fail('invalid', 'two photos share a file name and would write the same gallery file', 'fix_argument', 'export_web_gallery');
    const title = a.title || 'Gallery';
    // Every file the gallery writes. One that is a source photo (any photo in this export, or a photo the
    // person has culled, which has a sidecar) is refused; any other existing one is replaced, which the
    // person confirms with the list in front of them.
    const outputs = [...names.flatMap((n) => [`${folder}/images/${n}.jpg`, `${folder}/thumbs/${n}.jpg`]), `${folder}/index.html`];
    const sources = new Set(a.paths);
    for (const o of outputs) if (sources.has(o) || await s.exists(sidecarPath(o))) fail('invalid', `the gallery would write over the photo ${o}; pick another folder`, 'fix_argument', 'export_web_gallery');
    const existing = []; for (const o of outputs) if (await s.exists(o)) existing.push(o);
    const replaces = existing.length > 0;
    const what = replaces
      ? `REPLACE ${existing.length} existing file${existing.length > 1 ? 's' : ''} in ${folder}/ (${existing.slice(0, 5).join(', ')}${existing.length > 5 ? ', …' : ''}) with a web gallery of ${a.paths.length} photo${a.paths.length > 1 ? 's' : ''}`
      : `write a web gallery of ${a.paths.length} photo${a.paths.length > 1 ? 's' : ''} to ${folder}/ (index.html, images/, thumbs/)`;
    return stageOrRun(ctx, { door }, 'export_web_gallery', what, async () => {
      ctx.busy = 'export_web_gallery';
      try {
        const items = []; const files = [];
        for (let i = 0; i < a.paths.length; i++) {
          const doc = await photoDocument(ctx, a.paths[i]);
          const im = await renderOther(doc, a.maxEdge ?? 2048);
          const th = await ctx.renderer.resize(im, 400);
          const image = `images/${names[i]}.jpg`; const thumb = `thumbs/${names[i]}.jpg`;
          const big = await ctx.renderer.encode(im, 'image/jpeg', (a.quality ?? 88) / 100); const small = await ctx.renderer.encode(th, 'image/jpeg', 0.82);
          await s.write(`${folder}/${image}`, big); await s.write(`${folder}/${thumb}`, small);
          files.push({ path: `${folder}/${image}`, bytes: big.length }, { path: `${folder}/${thumb}`, bytes: small.length });
          items.push({ title: baseName(a.paths[i]), image, thumb, width: im.width, height: im.height, thumbWidth: th.width, thumbHeight: th.height });
        }
        const html = new TextEncoder().encode(galleryHtml(title, items));
        await s.write(`${folder}/index.html`, html);
        files.push({ path: `${folder}/index.html`, bytes: html.length });
        return { folder, index: `${folder}/index.html`, photos: items.length, files };
      } finally { ctx.busy = null; }
    }, { force: replaces });
  });

  // L51 Book: books/<name>.naklidoc (a Paginella layout document, one photo per page) plus the exported
  // JPEGs in books/<name>/, then the exact-file handoff to Paginella when NakliOS offers it.
  bus.register('file.book', async (a, { door }) => {
    const s = store(); renderer();
    const name = fileSafe(a.title || 'Photo book');
    for (const p of a.paths) { if (!photoKind(p)) fail('unsupported', `${p} is not a RAW or browser image`, 'fix_argument', 'make_book'); if (!(await s.exists(p))) fail('invalid', `no file ${p}`, 'fix_argument', 'list_folder'); }
    const docPath = `books/${name}.naklidoc`;
    const replaces = await s.exists(docPath);
    const what = `${replaces ? 'REPLACE' : 'write'} the Paginella book ${docPath} with ${a.paths.length} photo${a.paths.length > 1 ? 's' : ''} (JPEGs in books/${name}/)`;
    return stageOrRun(ctx, { door }, 'make_book', what, async () => {
      ctx.busy = 'make_book';
      const photos = []; const images = [];
      try {
        for (let i = 0; i < a.paths.length; i++) {
          const im = await renderOther(await photoDocument(ctx, a.paths[i]), a.maxEdge ?? 3000);
          const bytes = await ctx.renderer.encode(im, 'image/jpeg', 0.92);
          const img = `books/${name}/${String(i + 1).padStart(2, '0')}-${fileSafe(stem(a.paths[i]))}.jpg`;
          await s.write(img, bytes); images.push(img);
          photos.push({ name: baseName(img), hash: await sha256Hex(bytes), width: im.width, height: im.height, bytes });
        }
      } finally { ctx.busy = null; }
      const zip = packBook(bookLayout(a.title || 'Photo book', photos), photos);
      await s.write(docPath, zip);
      // Hand the book to Paginella when hosted; the host asks the person first. Standalone: say where it is.
      let handoff = 'standalone: open the .naklidoc in Paginella with File › Open .naklidoc';
      const files = globalThis.naklios?.capabilities?.hosted ? globalThis.naklios.files : null;
      if (a.open !== false && files?.experimental_sendTo) { try { await files.experimental_sendTo('paginella', [docPath]); handoff = 'sent to Paginella'; } catch (e) { handoff = `not sent: ${e.message}`; } }
      else if (a.open !== false && files?.openWith) { try { await files.openWith('paginella', docPath); handoff = 'opened in Paginella'; } catch (e) { handoff = `not opened: ${e.message}`; } }
      return { path: docPath, bytes: zip.length, pages: photos.length, images, handoff };
    }, { force: replaces });
  });
}

// Runs the real apply_preset handler against a scratch store that holds a copy of the open document.
// Returns { status, doc, result } (status other than 'ok' carries message).
export async function presetScratch(bus, ctx, layerId, preset) {
  const scratchStore = createStore({ limit: 1 });
  scratchStore.replace(structuredClone(ctx.store.doc));
  const handlers = new Map();
  const scratch = { ...ctx, store: scratchStore, sync: async () => null, staged: new Map(), jobs: new Map() };
  registerFiles({ manifest: bus.manifest, register: (id, fn) => handlers.set(id, fn), has: () => true }, scratch);
  try {
    const result = await handlers.get('develop.preset')({ layerIds: [layerId], preset }, { door: 'window', viewOnly: () => {} });
    return { status: 'ok', doc: scratchStore.doc, result };
  } catch (e) { return { status: e.status || 'invalid', message: e.message }; }
}
