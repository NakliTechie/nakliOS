// The renderer's vector hooks: shape layer and rich text sources, vector masks, artboard groups.
// src/renderer.js calls these; everything here turns document JSON into engine sources and masks.

import { invertAffine } from '../../vendor/tessella/src/model.js';
import { maskFromModel, rasterShape } from './raster.js';
import { isRich, rasterRichText } from './text.js';

export const usesVectorSource = (l) => l.kind === 'shape' || (l.kind === 'text' && isRich(l.text));
export const vectorSourceKey = (l) => (l.kind === 'shape' ? `shape:${JSON.stringify(l.shape)}` : `richtext:${JSON.stringify(l.text)}`);

// → { id, width, height, meta: { offset } }. offset: the layer-local position of the source's pixel (0, 0);
// the handlers keep it at [0, 0] by moving the geometry and the layer matrix (see normalise in
// src/handlers/vector.js), so masks and selections map through l.matrix alone.
export async function createVectorSource(engine, l) {
  const r = l.kind === 'shape' ? rasterShape(l.shape) : await rasterRichText(l.text);
  const s = engine.createPixelSource(r.pixels, r.width, r.height);
  return { id: s.id, width: r.width, height: r.height, meta: { offset: r.offset } };
}

// Vector mask on a layer: l.vectorMask = { model (layer-local px, so it moves with the layer), feather
// (Gaussian sigma in document px), invert }. It multiplies the layer's raster mask: final = rasterMask ×
// vectorCoverage. The coverage is rasterised on the layer's source grid (the grid the engine samples
// bitmap masks on; the document grid for an adjustment layer), with the feather scaled from document to
// source pixels by sqrt|det inverse(l.matrix)|. Cases the engine's mask maths expresses exactly:
//   no raster mask                                  → [add V]
//   raster mask without a bitmap, not inverted      → components + [intersect V]   (m · V)
//   raster mask = one bitmap component              → one baked bitmap D = M · V    (M after its invert)
// anything else is refused as unsupported (the change rolls back).
export function vectorMaskFor(ctx, l, src, mask) {
  const vm = l.vectorMask;
  if (!vm) return mask;
  if (l.quad) throw Object.assign(new Error('a vector mask on a perspective (corners) layer is not built'), { code: 'unsupported' });
  const adj = l.kind === 'adjustment';
  const w = adj ? ctx.docW : src.width; const h = adj ? ctx.docH : src.height;
  const inv = adj ? [1, 0, 0, 1, 0, 0] : invertAffine(l.matrix);
  const scale = Math.sqrt(Math.abs(inv[0] * inv[3] - inv[1] * inv[2]));
  const key = JSON.stringify([vm.model, vm.feather || 0, !!vm.invert, inv, w, h]);
  let V = ctx.cache.get(key);
  if (!V) { V = maskFromModel(vm.model, w, h, { feather: (vm.feather || 0) * scale, invert: !!vm.invert }); ctx.cache.set(key, V); }
  const comps = mask?.components || [];
  const bm = comps.filter((c) => c.kind === 'bitmap');
  if (!comps.length) return { components: [{ op: 'add', kind: 'bitmap', bitmap: ctx.upload(`v:${key}`, V, w, h) }], invert: false };
  if (!bm.length && !mask.invert) {
    if (comps.length >= 4) throw Object.assign(new Error('a vector mask needs a free mask component (the engine takes 4)'), { code: 'unsupported' });
    return { ...mask, components: [...comps, { op: 'intersect', kind: 'bitmap', bitmap: ctx.upload(`v:${key}`, V, w, h) }] };
  }
  if (comps.length === 1 && comps[0].kind === 'bitmap' && comps[0].op === 'add' && (mask.density ?? 1) === 1) {
    const id = comps[0].bitmap; const dk = `d:${l.id}`;
    const stamp = `${id}:${ctx.maskVersion(id)}:${mask.invert ? 1 : 0}:${key}`;
    let hit = ctx.cache.get(dk);
    if (!hit || hit.stamp !== stamp) {
      const M = ctx.bitmapData(id);
      if (!M || M.length !== V.length) throw Object.assign(new Error('the painted mask and the vector mask grids differ; reapply the vector mask'), { code: 'unsupported' });
      const D = new Uint8Array(V.length);
      for (let i = 0; i < D.length; i++) D[i] = Math.round(((mask.invert ? 255 - M[i] : M[i]) * V[i]) / 255);   // D = M · V
      hit = { stamp, D }; ctx.cache.set(dk, hit);
    }
    return { components: [{ op: 'add', kind: 'bitmap', bitmap: ctx.upload(dk, hit.D, w, h) }], invert: false };
  }
  throw Object.assign(new Error('a vector mask with a painted mask plus other mask components is not built; flatten the raster mask to one bitmap first'), { code: 'unsupported' });
}

// Artboards: doc.artboards = [{ id, name, x, y, width, height, background ('transparent' | '#rrggbb') }];
// a top-level layer with artboardId belongs to that artboard. Each artboard renders as an isolated group
// clipped to its rectangle (four linear mask components, one per edge, each 1 px wide and centred on the
// pixel edge so whole-pixel edges are crisp: coverage 1 at the centre of the last inside pixel, 0 at the
// centre of the first outside one), with its background as a fill at the bottom.
export function edgeComponents(a) {
  const { x, y, width, height } = a; const x1 = x + width; const y1 = y + height;
  return [
    { op: 'add', kind: 'linear', p0: [x1 - 0.5, y, x1 + 0.5, y] },      // right edge: full left of it
    { op: 'intersect', kind: 'linear', p0: [x + 0.5, y, x - 0.5, y] },  // left edge
    { op: 'intersect', kind: 'linear', p0: [x, y1 - 0.5, x, y1 + 0.5] }, // bottom edge
    { op: 'intersect', kind: 'linear', p0: [x, y + 0.5, x, y - 0.5] },  // top edge
  ];
}

// top: the built top-level engine list, in order, with the document layer each entry came from.
export async function wrapArtboards(doc, top, background) {
  const boards = doc.artboards || [];
  if (!boards.length) return top.map((t) => t.entry);
  const groups = new Map();
  const out = [];
  const groupFor = async (a) => {
    if (!groups.has(a.id)) {
      const children = [];
      if (a.background && a.background !== 'transparent') children.push(await background(a));
      const g = { id: `artboard:${a.id}`, group: true, children, isolation: 'isolated', opacity: 1, blend: 'normal', visible: a.visible !== false, mask: { components: edgeComponents(a), invert: false } };
      groups.set(a.id, g);
    }
    return groups.get(a.id);
  };
  for (const a of boards) out.push(await groupFor(a));   // artboards sit below unassigned layers, in list order
  for (const { layer, entry } of top) {
    const a = layer.artboardId && boards.find((b) => b.id === layer.artboardId);
    if (a) (await groupFor(a)).children.push(entry); else out.push(entry);
  }
  return out.filter((g) => !g.group || g.children.length || !String(g.id).startsWith('artboard:'));
}
