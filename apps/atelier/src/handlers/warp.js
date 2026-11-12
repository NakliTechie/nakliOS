// Warp, puppet warp and liquify (P24): the layer keeps its warp as pins and strokes (src/files/warp.js builds the
// displacement field the engine renders), so a warp stays editable and undoable.

import { needLayer, fail, change } from './util.js';

const pt = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
function warpable(ctx, id, tool) {
  const l = needLayer(ctx, id);
  if (!['image', 'text', 'raster', 'raw'].includes(l.kind)) fail('unsupported', 'warps apply to image, text, raster and RAW layers', 'change_target', tool);
  if (l.quad) fail('unsupported', 'this layer has perspective corners; warp it before setting corners', 'change_target', tool);
  if (l.styles) fail('unsupported', 'this layer has layer styles; remove them or warp a copy without styles', 'change_target', tool);
  if (l.localOf) fail('unsupported', 'warp the base photo, not its local adjustment', 'change_target', tool);
  return l;
}
export function register(bus, ctx) {
  bus.register('layer.warp', async (a) => {
    const l = warpable(ctx, a.layerId, 'warp_layer');
    if (!a.pins.every((p) => pt(p.from) && pt(p.to))) fail('invalid', 'each pin is { from: [x, y], to: [x, y] } in layer-source pixels', 'fix_argument', 'warp_layer');
    await change(ctx, 'warp_layer', (doc) => { const x = doc.layers.find((y) => y.id === l.id); x.warp = { ...(x.warp || {}), pins: a.pins.map((p) => ({ from: [...p.from], to: [...p.to] })) }; });
    return { layerId: l.id, pins: a.pins.length, strokes: ctx.store.doc.layers.find((y) => y.id === l.id).warp.strokes?.length ?? 0 };
  });
  bus.register('layer.liquify', async (a) => {
    const l = warpable(ctx, a.layerId, 'liquify_layer');
    for (const s of a.strokes) if (!s.points.every(pt)) fail('invalid', 'stroke points are [x, y] in layer-source pixels', 'fix_argument', 'liquify_layer');
    await change(ctx, 'liquify_layer', (doc) => {
      const x = doc.layers.find((y) => y.id === l.id);
      x.warp = { ...(x.warp || {}), strokes: [...(x.warp?.strokes || []), ...a.strokes.map((s) => ({ mode: s.mode, points: s.points.map((p) => [...p]), size: s.size, strength: s.strength ?? 0.5 }))] };
    });
    return { layerId: l.id, strokes: ctx.store.doc.layers.find((y) => y.id === l.id).warp.strokes.length };
  });
  bus.register('layer.warp-reset', async (a) => {
    const l = needLayer(ctx, a.layerId);
    await change(ctx, 'reset_warp', (doc) => { delete doc.layers.find((y) => y.id === l.id).warp; });
    return { layerId: l.id, warp: null };
  });
}
