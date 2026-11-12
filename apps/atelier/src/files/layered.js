// Layered interchange between Atelier documents and PSD / layered TIFF / per-layer files (P51-P54).
// Reading: a layer plan (src/files/psd.js shape) becomes Atelier layers and renderer buffers.
// Writing: each layer becomes pixels, either straight from its raster buffer (exact) or by rendering
// that layer alone through the engine. Functions that render leave the engine showing `doc` again.

import { makeLayer, IDENTITY } from '../document.js';
import { addDelta } from '../renderer.js';
import { convertFloat, makeIcc, parseIcc } from './icc.js';
import { writeTiff } from './tiff.js';

// ---- plan → document --------------------------------------------------------------------------------
// plan.layers in document order, parents before children. Returns new Atelier layers (doc order) and notes.
// offset: [dx, dy] added to every position (placing a file as layers inside another document).
export function planToLayers(plan, r, { offset = [0, 0], docWidth, docHeight } = {}) {
  const ids = new Map(); const out = []; const notes = [];
  const [dx, dy] = offset;
  for (const e of plan.layers) {
    const common = { name: e.name, visible: e.visible, opacity: e.opacity ?? 1, fill: e.fill ?? 1, blend: e.blend ?? 'normal', ...(e.parent != null ? { parentId: ids.get(e.parent) } : {}) };
    let l;
    if (e.kind === 'group') l = makeLayer('group', { ...common, isolation: e.isolation || 'pass-through' });
    else if (e.kind === 'fill') l = makeLayer('fill', { ...common, color: e.color });
    else if (!e.pixels || e.width <= 0 || e.height <= 0) {   // empty layer: a transparent canvas-sized raster, as add_layer makes
      const buffer = r.newPixels(docWidth, docHeight);
      l = makeLayer('raster', { ...common, buffer, width: docWidth, height: docHeight, matrix: [1, 0, 0, 1, dx, dy] });
    } else {
      const buffer = r.newPixels(e.width, e.height, e.pixels);
      l = makeLayer('raster', { ...common, buffer, width: e.width, height: e.height, matrix: [1, 0, 0, 1, e.left + dx, e.top + dy] });
      if (e.mask) {
        const m = r.newMask(e.width, e.height); r.bufferIO.write(m, e.mask.data);
        l.mask = { components: [{ op: 'add', kind: 'bitmap', bitmap: m }], invert: false };
      }
    }
    if (e.note) { l.note = e.note; notes.push({ layer: e.name, note: e.note }); }
    ids.set(e.index, l.id);
    out.push(l);
  }
  // Atelier keeps a group after its children in doc.layers (layer.group inserts it above them).
  const ordered = []; const kids = (pid) => out.filter((l) => (l.parentId ?? null) === pid);
  (function place(pid) { for (const l of kids(pid)) { if (l.kind === 'group') place(l.id); ordered.push(l); } })(null);
  return { layers: ordered, notes };
}

// ---- document → layers --------------------------------------------------------------------------------
// Document order as a tree walk: a group, then its children (bottom to top), recursively.
export function tree(doc) {
  const out = [];
  (function walk(pid, parent) {
    for (const l of doc.layers.filter((x) => (x.parentId ?? null) === pid && !x.localOf)) {
      out.push({ layer: l, parent }); if (l.kind === 'group') walk(l.id, l.id);
      for (const loc of doc.layers.filter((x) => x.localOf === l.id)) out.push({ layer: loc, parent });
    }
  })(null, null);
  return out;
}

const isTranslate = (m) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && Number.isInteger(m[4]) && Number.isInteger(m[5]);
// A raster layer whose pixels can be written straight from its buffer: integer translation and either
// no mask or one painted (bitmap) component, op add, full density. Returns { pixels, mask } or null.
export function directRaster(l, r) {
  if (l.kind !== 'raster' || l.vectorMask || !isTranslate(l.matrix || IDENTITY)) return null;   // a vector mask is rasterised with the layer
  const m = l.mask; let mask = null;
  if (m) {
    const c = m.components || [];
    if (c.length !== 1 || c[0].kind !== 'bitmap' || c[0].op !== 'add' || (m.density ?? 1) !== 1) return null;
    mask = r.bufferData(c[0].bitmap).slice();
    if (m.invert) for (let i = 0; i < mask.length; i++) mask[i] = 255 - mask[i];
  }
  const b = r.buffers.get(l.buffer);
  return { pixels: r.bufferData(l.buffer).slice(), width: b.width, height: b.height, left: l.matrix[4], top: l.matrix[5], mask };
}

// The layer (and, for a group, its descendants) as a stand-alone document list: normal blend,
// visible, full opacity unless keepOpacity; a local adjustment becomes the RAW layer it renders as.
// includeLocals: a RAW layer brings its local adjustments along (per-layer files); PSD and TIFF write them as layers of their own.
export function alone(doc, l, { keepOpacity = false, includeLocals = false } = {}) {
  const own = { parentId: undefined, visible: true, blend: 'normal', ...(keepOpacity ? {} : { opacity: 1, fill: 1 }) };
  if (l.localOf) {
    const base = doc.layers.find((x) => x.id === l.localOf);
    return [{ ...base, ...own, id: l.id, name: l.name, mask: l.mask, opacity: keepOpacity ? l.opacity : 1, localOf: undefined, localDelta: undefined, develop: addDelta(base.develop, l.localDelta) }];
  }
  const list = [{ ...l, ...own }];
  if (includeLocals) list.push(...doc.layers.filter((x) => x.localOf === l.id).map((x) => ({ ...x, parentId: undefined })));
  if (l.kind === 'group') {
    const ids = new Set([l.id]);
    for (let grew = true; grew;) { grew = false; for (const x of doc.layers) if (!ids.has(x.id) && (ids.has(x.parentId) || ids.has(x.localOf))) { ids.add(x.id); grew = true; } }
    list.unshift(...doc.layers.filter((x) => ids.has(x.id) && x.id !== l.id));
  }
  return list;
}

// Renders a layer list as its own document; returns image8's result (8-bit sRGB plus .float).
export async function renderLayers(r, doc, layers, background = null) {
  await r.sync({ ...doc, layers });
  return r.image8(0, null, background);
}

// Bounding box of pixels with alpha above zero, or null.
export function alphaBox(data, w, h) {
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
export function crop(data, w, box, channels = 4) {
  const out = new data.constructor(box.width * box.height * channels);
  for (let y = 0; y < box.height; y++) out.set(data.subarray(((box.y + y) * w + box.x) * channels, ((box.y + y) * w + box.x + box.width) * channels), y * box.width * channels);
  return out;
}

const groupEntry = (l, index, parent) => ({ index, parent, kind: 'group', name: l.name, visible: l.visible, opacity: l.opacity ?? 1, blend: l.blend ?? 'normal', isolation: l.isolation || 'pass-through' });
const leafEntry = (l, index, parent) => ({ index, parent, kind: 'raster', name: l.name, visible: l.visible, opacity: l.opacity ?? 1, fill: l.fill ?? 1, blend: l.blend ?? 'normal' });

// Document → PSD plan (8-bit sRGB). Returns { plan, notes }.
export async function documentToPsdPlan(r, doc) {
  const notes = []; const layers = []; const index = new Map();
  try {
    for (const { layer: l, parent } of tree(doc)) {
      const p = parent == null ? null : index.get(parent);
      const i = layers.length; index.set(l.id, i);
      if (l.kind === 'group') {
        if (l.mask) notes.push({ layer: l.name, note: 'group mask not written (PSD group masks are bitmaps; this one is a gradient or range mask)' });
        layers.push(groupEntry(l, i, p)); continue;
      }
      const e = leafEntry(l, i, p);
      const d = directRaster(l, r);
      if (d) {
        Object.assign(e, { left: d.left, top: d.top, width: d.width, height: d.height, pixels: d.pixels });
        if (d.mask) e.mask = { data: d.mask, width: d.width, height: d.height, left: d.left, top: d.top, defaultColor: 0 };
      } else {
        const im = await renderLayers(r, doc, alone(doc, l));
        const box = alphaBox(im.data, im.width, im.height);
        Object.assign(e, box ? { left: box.x, top: box.y, width: box.width, height: box.height, pixels: crop(im.data, im.width, box) } : { left: 0, top: 0, width: 0, height: 0, pixels: null });
        notes.push({ layer: l.name, note: `${l.localOf ? 'local adjustment' : l.kind} layer written as 8-bit pixels${l.mask ? ' with its mask applied to the pixels' : ''}${l.vectorMask ? ' with its vector mask rasterised into the pixels (PSD vector masks are not written)' : ''}${l.kind === 'shape' ? ' (rasterised; the editable shape stays in the .atelier document)' : ''}` });
      }
      layers.push(e);
    }
    const comp = await renderLayers(r, doc, doc.layers);
    return { plan: { width: doc.width, height: doc.height, layers, composite: { width: comp.width, height: comp.height, data: comp.data }, icc: makeIcc('srgb') }, notes };
  } finally { await r.sync(doc); }
}

// Document → layered TIFF: page 1 the flattened image (what other apps show), then one 16-bit page per
// leaf layer, cropped to its pixels; page 1's ImageDescription holds the layer tree as JSON
// ({ format: 'atelier-layered-tiff', version: 1, layers: [{ name, kind, parent, page, left, top, opacity, fill, blend, isolation, visible }] }).
// Masks are applied to the page's alpha.
export const LAYERED_TIFF = 'atelier-layered-tiff';
export async function documentToLayeredTiff(r, doc) {
  const notes = []; const meta = []; const pages = []; const index = new Map();
  const to16 = (d8) => { const o = new Uint16Array(d8.length); for (let i = 0; i < d8.length; i++) o[i] = d8[i] * 257; return o; };
  try {
    for (const { layer: l, parent } of tree(doc)) {
      const p = parent == null ? null : index.get(parent);
      const i = meta.length; index.set(l.id, i);
      if (l.kind === 'group') {
        if (l.mask) notes.push({ layer: l.name, note: 'group mask not written' });
        meta.push(groupEntry(l, i, p)); continue;
      }
      const e = leafEntry(l, i, p);
      const d = directRaster(l, r);
      let px; let box;
      if (d) {
        if (d.mask) for (let k = 0; k < d.mask.length; k++) d.pixels[k * 4 + 3] = Math.round((d.pixels[k * 4 + 3] * d.mask[k]) / 255);
        px = to16(d.pixels); box = { x: d.left, y: d.top, width: d.width, height: d.height };
      } else {
        const im = await renderLayers(r, doc, alone(doc, l));
        const full = convertFloat(im.float, 'srgb', 16);
        const b = alphaBox(full, im.width, im.height);
        if (b) { px = crop(full, im.width, b); box = b; }
        if (l.mask) notes.push({ layer: l.name, note: 'mask applied to the layer alpha' });
      }
      if (px) { e.page = pages.length + 1; pages.push({ width: box.width, height: box.height, bits: 16, channels: 4, data: px, name: l.name, x: box.x, y: box.y }); }
      e.left = box?.x ?? 0; e.top = box?.y ?? 0;
      meta.push(e);
    }
    const comp = await renderLayers(r, doc, doc.layers);
    const flat = convertFloat(comp.float, 'srgb', 16);
    const description = JSON.stringify({ format: LAYERED_TIFF, version: 1, width: doc.width, height: doc.height, layers: meta });
    const icc = makeIcc('srgb');
    const bytes = await writeTiff([{ width: comp.width, height: comp.height, bits: 16, channels: 4, data: flat, name: 'Composite', description, icc }, ...pages.map((pg) => ({ ...pg, icc }))]);
    return { bytes, pages: pages.length + 1, notes };
  } finally { await r.sync(doc); }
}

// Layered TIFF pages → layer plan (8-bit). Atelier files rebuild the tree from page 1's JSON; any other
// multi-page TIFF opens one layer per page at its X/YPosition; a single page opens as one layer.
export function tiffToPlan(pages) {
  const notes = []; const skipped = [];
  const to8 = (p) => (p.bits === 16 ? Uint8Array.from(p.data, (v) => Math.round(v / 257)) : p.data);
  let meta = null;
  try { const j = JSON.parse(pages[0].description || ''); if (j?.format === LAYERED_TIFF) meta = j; } catch { /* not ours */ }
  for (const p of pages) if (p.icc) { let desc = '?'; try { desc = parseIcc(p.icc).description; } catch { /* unreadable */ } if (!/srgb/i.test(desc || '')) { notes.push(`embedded profile "${desc}" ignored; pixels read as sRGB`); break; } }
  if (pages.some((p) => p.bits === 16)) notes.push('16-bit pages reduced to 8-bit (Atelier raster layers are 8-bit)');
  if (pages[0].photoshopLayers) notes.push('Photoshop layer data (TIFF tag 37724) is not read; the pages open instead');
  if (meta) {
    const layers = meta.layers.map((m) => {
      if (m.kind === 'group') return { ...m };
      const pg = m.page ? pages[m.page] : null;
      if (m.page && !pg) { skipped.push({ name: m.name, reason: `page ${m.page} missing` }); }
      return { ...m, kind: 'raster', pixels: pg ? to8(pg) : null, width: pg?.width ?? 0, height: pg?.height ?? 0, left: m.left ?? 0, top: m.top ?? 0 };
    });
    return { width: meta.width, height: meta.height, layers, notes, skipped };
  }
  const width = Math.max(...pages.map((p) => p.x + p.width)); const height = Math.max(...pages.map((p) => p.y + p.height));
  const layers = pages.map((p, i) => ({ index: i, parent: null, kind: 'raster', name: p.name || (pages.length > 1 ? `Page ${i + 1}` : 'Background'), visible: true, opacity: 1, fill: 1, blend: 'normal', left: p.x, top: p.y, width: p.width, height: p.height, pixels: to8(p) }));
  return { width, height, layers, notes, skipped };
}
