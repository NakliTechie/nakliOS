// PSD read and write (P51, P52) over ag-psd 34.1.0 (vendor/ag-psd). This module turns a PSD into a
// flat, renderer-independent layer plan and back; the handler maps the plan to Atelier layers and
// buffers. Raster pixels are 8-bit sRGB, straight alpha, layer-local, as Atelier raster buffers are.
// Pure code: node and browser (readPsd with useImageData needs no canvas).

import { readPsd, writePsdUint8Array, initializeCanvas } from '../../vendor/ag-psd/ag-psd.mjs';
import { encodeTrc } from './icc.js';

// Plain pixel arrays instead of canvas ImageData: no canvas needed (node, workers) and no premultiply.
initializeCanvas(
  (w, h) => { if (typeof OffscreenCanvas === 'undefined') throw new Error('this PSD feature needs a canvas'); return new OffscreenCanvas(w, h); },
  (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
);

// Atelier's 27 blend names are Photoshop's with hyphens; 'pass through' is a group isolation.
export const PSD_BLEND_TO_ATELIER = {
  normal: 'normal', dissolve: 'dissolve', darken: 'darken', multiply: 'multiply', 'color burn': 'color-burn', 'linear burn': 'linear-burn',
  'darker color': 'darker-color', lighten: 'lighten', screen: 'screen', 'color dodge': 'color-dodge', 'linear dodge': 'linear-dodge',
  'lighter color': 'lighter-color', overlay: 'overlay', 'soft light': 'soft-light', 'hard light': 'hard-light', 'vivid light': 'vivid-light',
  'linear light': 'linear-light', 'pin light': 'pin-light', 'hard mix': 'hard-mix', difference: 'difference', exclusion: 'exclusion',
  subtract: 'subtract', divide: 'divide', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};
export const ATELIER_BLEND_TO_PSD = Object.fromEntries(Object.entries(PSD_BLEND_TO_ATELIER).map(([k, v]) => [v, k]));

// Any ag-psd pixel array (8-bit, 16-bit, 32-bit linear float) → 8-bit Uint8Array.
// 16 → 8: round(v / 257). 32-bit float is linear light: sRGB-encode colour, keep alpha linear.
function to8(px, channels = 4) {
  const d = px.data;
  if (d instanceof Uint8Array || d instanceof Uint8ClampedArray) return new Uint8Array(d.buffer, d.byteOffset, d.length).slice();
  const out = new Uint8Array(d.length);
  if (d instanceof Uint16Array) { for (let i = 0; i < d.length; i++) out[i] = Math.round(d[i] / 257); return out; }
  for (let i = 0; i < d.length; i++) { const v = Math.min(1, Math.max(0, d[i])); out[i] = Math.round(255 * (i % channels === 3 ? v : encodeTrc.srgb(v))); }
  return out;
}

const hex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

// Reads a PSD into a plan:
// { width, height, bits, colorMode, icc, layers: [entry], skipped: [{ name, reason }], notes: [string] }
// entry (bottom to top, parents before children): { index, parent (index or null), kind: 'raster' | 'group' | 'fill',
//   name, visible, opacity, fill, blend, isolation?, left, top, width, height, pixels?, color?, mask?, note? }
// mask: { data (Uint8Array, layer-local, width × height) } with the PSD mask resampled onto the layer's pixels.
export function readPsdPlan(bytes) {
  const psd = readPsd(bytes, { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
  const plan = { width: psd.width, height: psd.height, bits: psd.bitsPerChannel ?? 8, colorMode: psd.colorMode ?? 3, icc: psd.imageResources?.iccProfile || null, layers: [], skipped: [], notes: [] };
  if (plan.colorMode !== 3) plan.notes.push(`colour mode ${['bitmap', 'grayscale', 'indexed', 'RGB', 'CMYK', '', '', 'multichannel', 'duotone', 'Lab'][plan.colorMode] ?? plan.colorMode} converted to RGB by ag-psd`);
  if (plan.bits !== 8) plan.notes.push(`${plan.bits}-bit channels reduced to 8-bit (Atelier raster layers are 8-bit)`);
  const skip = (name, reason) => plan.skipped.push({ name, reason });

  function walk(children, parent) {
    for (const l of children || []) {
      const name = l.name ?? 'Layer';
      const base = { index: plan.layers.length, parent, name, visible: !l.hidden, opacity: l.opacity ?? 1, fill: l.fillOpacity ?? 1, blend: 'normal' };
      const blend = l.blendMode ?? 'normal';
      if (l.children) {
        const e = { ...base, kind: 'group', isolation: blend === 'pass through' ? 'pass-through' : 'isolated', blend: blend === 'pass through' ? 'normal' : PSD_BLEND_TO_ATELIER[blend] ?? 'normal' };
        if (blend !== 'pass through' && !PSD_BLEND_TO_ATELIER[blend]) skip(name, `group blend mode "${blend}" has no Atelier equivalent; normal used`);
        if (l.mask?.imageData && !l.mask.disabled) skip(name, 'group layer mask dropped (Atelier group masks take gradient or range components, not bitmaps)');
        if (l.effects) skip(name, 'layer effects not applied');
        plan.layers.push(e);
        walk(l.children, e.index);
        continue;
      }
      if (l.adjustment) { skip(name, `adjustment layer (${l.adjustment.type}) not rendered; ag-psd offers no composite for it`); continue; }
      if (!PSD_BLEND_TO_ATELIER[blend]) skip(name, `blend mode "${blend}" has no Atelier equivalent; normal used`);
      if (l.effects) skip(name, 'layer effects not applied (the pixels are the layer without its effects)');
      if (l.clipping) skip(name, 'clipping mask not kept; the layer shows unclipped');
      if (l.filterMask) skip(name, 'smart filter mask not kept');
      const left = l.left ?? 0; const top = l.top ?? 0;
      const w = (l.right ?? left) - left; const h = (l.bottom ?? top) - top;
      const e = { ...base, blend: PSD_BLEND_TO_ATELIER[blend] ?? 'normal', left, top, width: w, height: h };
      if (l.text) e.note = `text layer rasterised; text: ${l.text.text}`;
      else if (l.placedLayer) e.note = `smart object rasterised from its stored pixels${l.placedLayer.id ? ` (linked file ${l.placedLayer.id})` : ''}`;
      if (w <= 0 || h <= 0 || !l.imageData) {
        const vf = l.vectorFill;
        if (vf?.type === 'color' && vf.color) { plan.layers.push({ ...e, kind: 'fill', color: hex(vf.color), note: 'solid colour fill layer' }); continue; }
        if (vf) { skip(name, `${vf.type} fill layer has no stored pixels; skipped`); continue; }
        plan.layers.push({ ...e, kind: 'raster', width: 0, height: 0, pixels: null, note: e.note ?? 'empty layer' });
        continue;
      }
      e.kind = 'raster'; e.pixels = to8(l.imageData);
      if (l.vectorFill) e.note = e.note ?? `${l.vectorFill.type} fill layer rasterised`;
      if (l.vectorMask || l.vectorStroke) skip(name, 'vector mask or stroke not kept (pixels are kept)');
      const m = l.mask;
      if (m?.imageData && !m.disabled) {
        // Resample the mask onto the layer's pixel grid: inside the mask rect its value, outside defaultColor.
        const mw = m.imageData.width; const mh = m.imageData.height; const md = to8(m.imageData);
        const ml = m.left ?? 0; const mt = m.top ?? 0; const def = m.defaultColor ?? 0;
        const data = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const mx = left + x - ml; const my = top + y - mt;
          data[y * w + x] = mx >= 0 && my >= 0 && mx < mw && my < mh ? md[(my * mw + mx) * 4] : def;
        }
        e.mask = { data };
      } else if (m?.disabled) skip(name, 'disabled layer mask not kept');
      plan.layers.push(e);
    }
  }
  walk(psd.children, null);
  if (!psd.children?.length && psd.imageData) {   // flattened PSD: the composite is the one layer
    plan.layers.push({ index: 0, parent: null, kind: 'raster', name: 'Background', visible: true, opacity: 1, fill: 1, blend: 'normal', left: 0, top: 0, width: psd.width, height: psd.height, pixels: to8(psd.imageData), note: 'flattened PSD: composite image' });
  }
  return plan;
}

// Writes a PSD from a plan of the same shape (entries in document order, bottom to top, parents
// before children). composite: { width, height, data } 8-bit RGBA for apps that read only the composite.
// Masks on raster entries: { data, width, height, left, top, defaultColor }.
export function writePsdPlan({ width, height, layers, composite, icc }) {
  const nodes = new Map(); const root = [];
  for (const e of layers) {
    const n = { name: e.name, hidden: !e.visible, opacity: e.opacity ?? 1 };
    if (e.kind === 'group') {
      n.children = []; n.opened = true;
      n.blendMode = e.isolation === 'pass-through' ? 'pass through' : ATELIER_BLEND_TO_PSD[e.blend] ?? 'normal';
    } else {
      n.blendMode = ATELIER_BLEND_TO_PSD[e.blend] ?? 'normal';
      if ((e.fill ?? 1) !== 1) n.fillOpacity = e.fill;
      n.left = e.left; n.top = e.top; n.right = e.left + e.width; n.bottom = e.top + e.height;
      if (e.width > 0 && e.height > 0) n.imageData = { width: e.width, height: e.height, data: new Uint8ClampedArray(e.pixels.buffer, e.pixels.byteOffset, e.pixels.length) };
      if (e.mask) {
        const m = e.mask; const rgba = new Uint8ClampedArray(m.width * m.height * 4);
        for (let i = 0; i < m.width * m.height; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = m.data[i]; rgba[i * 4 + 3] = 255; }
        n.mask = { left: m.left, top: m.top, right: m.left + m.width, bottom: m.top + m.height, defaultColor: m.defaultColor ?? 255, imageData: { width: m.width, height: m.height, data: rgba } };
      }
    }
    nodes.set(e.index, n);
    (e.parent == null ? root : nodes.get(e.parent).children).push(n);
  }
  const psd = { width, height, channels: 4, bitsPerChannel: 8, colorMode: 3, children: root };
  if (composite) psd.imageData = { width: composite.width, height: composite.height, data: new Uint8ClampedArray(composite.data.buffer, composite.data.byteOffset, composite.data.length) };
  if (icc) psd.imageResources = { iccProfile: icc };
  return writePsdUint8Array(psd, { generateThumbnail: false, noBackground: true });
}
