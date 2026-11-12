// Smart objects (P12 embedded, P13 linked): the pure parts. A smart object is a raster layer whose pixels
// are a flattened render of a source, plus `smart`, the source itself:
//   embedded: { kind: 'embedded', width, height, document, buffers }  a nested document (its layers as
//             they were) with its raster and mask buffers as PNG (base64), so the layer carries its source
//             through .atelier save and load. Photo layers inside keep naming their workspace original, as
//             every Atelier document does (originals are never copied or written).
//   linked:   { kind: 'linked', width, height, path, hash }  a workspace photo; hash = SHA-256 of the file's
//             bytes, a newline, and its Atelier sidecar's bytes, so a changed photo or changed develop
//             settings both show as a change.
// The layer's buffer is the flattened source at full size; its matrix places it. Moving, scaling or
// rotating changes only the matrix, so every transform resamples the untouched source.

import { encodePng, decodePng } from './png.js';
import { sha256 } from './sync.js';

const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Buffer ids a layer list uses (layer pixels and bitmap mask components).
export function layerBuffers(layers) {
  const ids = new Set();
  for (const l of layers) { if (l.buffer) ids.add(l.buffer); for (const c of l.mask?.components || []) if (c.bitmap) ids.add(c.bitmap); }
  return [...ids];
}

// io: { info(id) → { kind: 'pixels' | 'mask', width, height }, data(id) → Uint8Array }.
export async function packEmbedded(nested, io) {
  const buffers = {};
  for (const id of layerBuffers(nested.layers)) {
    const b = io.info(id); const ch = b.kind === 'mask' ? 1 : 4;
    buffers[id] = { kind: b.kind, width: b.width, height: b.height, png: b64(await encodePng(io.data(id), b.width, b.height, ch)) };
  }
  return { kind: 'embedded', width: nested.width, height: nested.height, document: structuredClone(nested), buffers };
}

// make: { pixels(w, h, data) → id, mask(w, h, data) → id }. Returns the nested document with buffer ids
// remapped to new buffers made from the PNGs.
export async function unpackEmbedded(smart, make) {
  const doc = structuredClone(smart.document); const remap = {};
  for (const [id, b] of Object.entries(smart.buffers || {})) {
    const png = await decodePng(unb64(b.png));
    remap[id] = b.kind === 'mask' ? make.mask(b.width, b.height, png.data) : make.pixels(b.width, b.height, png.data);
  }
  for (const l of doc.layers) {
    if (l.buffer) { if (!remap[l.buffer]) throw new Error(`smart object layer ${l.name} names buffer ${l.buffer}, which it does not carry`); l.buffer = remap[l.buffer]; }
    for (const c of l.mask?.components || []) if (c.bitmap) c.bitmap = remap[c.bitmap];
  }
  return doc;
}

export async function linkedHash(fileBytes, sidecarBytes) {
  const nl = new Uint8Array([10]); const side = sidecarBytes || new Uint8Array(0);
  const all = new Uint8Array(fileBytes.length + 1 + side.length);
  all.set(fileBytes, 0); all.set(nl, fileBytes.length); all.set(side, fileBytes.length + 1);
  return sha256(all);
}
