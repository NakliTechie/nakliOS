// Layer commands: add, delete, move, properties, transform, duplicate, text.

import { makeLayer } from '../document.js';
import { BLEND_MODES } from '../../vendor/tessella/src/shaders.js';
import { needDoc, needLayer, fail, change, layerRow } from './util.js';

// Engine checks ranges for most adjustment types; curves params are point lists it would otherwise ignore.
function checkAdjustment(adj, tool) {
  if (adj.type !== 'curves') return;
  for (const [k, v] of Object.entries(adj.params || {})) {
    if (!['rgb', 'red', 'green', 'blue'].includes(k)) fail('invalid', `curves takes rgb, red, green, blue point lists; got ${k}`, 'fix_argument', tool);
    if (!Array.isArray(v) || v.length < 2 || !v.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(n) && n >= 0 && n <= 255))) fail('invalid', `curves ${k} must be at least two [x, y] points in 0..255`, 'fix_argument', tool);
  }
}

const multiply = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];

export function register(bus, ctx) {
  bus.register('layer.add', async (a) => {
    const d = needDoc(ctx);
    let layer;
    if (a.kind === 'raster') {
      const buffer = ctx.renderer.newPixels(d.width, d.height);
      layer = makeLayer('raster', { name: a.name || 'Layer', buffer, width: d.width, height: d.height });
    } else if (a.kind === 'text') {
      const t = a.text || {};
      if (typeof t.content !== 'string' || !t.content) fail('invalid', 'text.content is required for a text layer', 'fix_argument', 'add_layer');
      const style = { font: 'system-ui', size: Math.round(d.height / 12), color: '#ffffff', align: 'left', lineHeight: 1.2, bold: false, italic: false, ...(t.style || {}) };
      layer = makeLayer('text', { name: a.name || t.content.slice(0, 24), text: { content: t.content, style } });
      const { width, height } = await ctx.renderer.sourceSize(layer);
      layer.matrix = [1, 0, 0, 1, Math.round((d.width - width) / 2), Math.round((d.height - height) / 2)];
    } else if (a.kind === 'adjustment') {
      const adj = a.adjustment || {};
      if (typeof adj.type !== 'string') fail('invalid', 'adjustment.type is required: levels, curves, hue-saturation, exposure, colour-balance, black-and-white or develop', 'fix_argument', 'add_layer');
      checkAdjustment(adj, 'add_layer');
      layer = makeLayer('adjustment', { name: a.name || adj.type, adjustment: { type: adj.type, params: adj.params || {} } });
    } else if (a.kind === 'group') {
      layer = makeLayer('group', { name: a.name || 'Group', isolation: 'pass-through' });
    } else {
      fail('unsupported', `${a.kind} layers are not built yet`, 'change_target', 'add_layer');
    }
    const act = d.layers.find((l) => l.id === d.activeLayerId);
    if (act?.parentId) layer.parentId = act.parentId;
    await change(ctx, 'add_layer', (doc) => {
      const i = doc.layers.findIndex((l) => l.id === doc.activeLayerId);
      doc.layers.splice(i < 0 ? doc.layers.length : i + 1, 0, layer);
      doc.activeLayerId = layer.id;
    });
    return { layer: layerRow(layer) };
  });

  bus.register('layer.delete', async (a) => {
    const l = needLayer(ctx, a.layerId, { unlocked: false });
    const gone = new Set([l.id]);
    for (let grew = true; grew;) { grew = false; for (const x of ctx.store.doc.layers) if (!gone.has(x.id) && (gone.has(x.parentId) || gone.has(x.localOf))) { gone.add(x.id); grew = true; } }
    await change(ctx, 'delete_layer', (doc) => {
      doc.layers = doc.layers.filter((x) => !gone.has(x.id));
      if (doc.activeLayerId === l.id) doc.activeLayerId = doc.layers.at(-1)?.id ?? null;
    });
    return { deleted: l.id, layers: ctx.store.doc.layers.length };
  });

  bus.register('layer.move', async (a) => {
    const l = needLayer(ctx, a.layerId, { unlocked: false });
    if (a.parentId === '') a.parentId = null;   // '' moves the layer to the top level
    if (a.parentId !== undefined && a.parentId !== null) {
      const g = ctx.store.doc.layers.find((x) => x.id === a.parentId);
      if (!g || g.kind !== 'group') fail('invalid', `${a.parentId} is not a group`, 'get_state', 'list_layers');
      for (let p = g; p; p = ctx.store.doc.layers.find((x) => x.id === p.parentId)) if (p.id === l.id) fail('invalid', 'a group cannot move inside itself', 'fix_argument', 'move_layer');
    }
    const d = needDoc(ctx);
    if (a.index >= d.layers.length) fail('invalid', `index must be below ${d.layers.length}`, 'fix_argument', 'move_layer');
    await change(ctx, 'move_layer', (doc) => {
      doc.layers = doc.layers.filter((x) => x.id !== l.id);
      if (a.parentId !== undefined) { if (a.parentId) l.parentId = a.parentId; else delete l.parentId; }
      doc.layers.splice(a.index, 0, l);
    });
    return { order: ctx.store.doc.layers.map((x) => x.id) };
  });

  bus.register('layer.set', async (a) => {
    const l = needLayer(ctx, a.layerId, { unlocked: false });
    if (a.blendMode && !BLEND_MODES.includes(a.blendMode)) fail('invalid', 'unknown blend mode', 'fix_argument', 'set_layer');
    await change(ctx, 'set_layer', (doc) => {
      const x = doc.layers.find((y) => y.id === l.id);
      if (a.name !== undefined) x.name = a.name;
      if (a.visible !== undefined) x.visible = a.visible;
      if (a.locked !== undefined) x.locked = a.locked;
      if (a.opacity !== undefined) x.opacity = a.opacity / 100;
      if (a.fill !== undefined) x.fill = a.fill / 100;
      if (a.blendMode !== undefined) x.blend = a.blendMode;
      if (a.clipped !== undefined) { if (a.clipped) x.clipped = true; else delete x.clipped; }
    });
    return { layer: layerRow(ctx.store.doc.layers.find((y) => y.id === l.id)) };
  });

  bus.register('layer.transform', async (a) => {
    const l = needLayer(ctx, a.layerId);
    if (l.kind === 'fill') fail('unsupported', 'a fill layer covers the whole document', 'change_target', 'transform_layer');
    if (l.kind === 'group') fail('unsupported', 'transforming a group is not built yet; transform its layers', 'change_target', 'transform_layer');
    if (l.kind === 'adjustment') fail('unsupported', 'an adjustment layer has no pixels to transform', 'change_target', 'transform_layer');
    if (a.corners) {
      if (a.matrix) fail('invalid', 'pass matrix or corners, not both', 'fix_argument', 'transform_layer');
      if (l.lensBlur) fail('unsupported', 'lens blur on a perspective layer is not built yet; remove the lens blur first', 'change_target', 'set_lens_blur');
      await change(ctx, 'transform_layer', (doc) => { const x = doc.layers.find((y) => y.id === l.id); x.quad = a.corners.map(([px, py]) => [px, py]); });
      return { quad: ctx.store.doc.layers.find((y) => y.id === l.id).quad };
    }
    if (!a.matrix) fail('invalid', 'matrix or corners is required', 'fix_argument', 'transform_layer');
    const det = a.matrix[0] * a.matrix[3] - a.matrix[1] * a.matrix[2];
    if (Math.abs(det) < 1e-9) fail('invalid', 'matrix is not invertible', 'fix_argument', 'transform_layer');
    await change(ctx, 'transform_layer', (doc) => {
      const x = doc.layers.find((y) => y.id === l.id);
      if (x.quad) x.quad = x.quad.map(([px, py]) => [a.matrix[0] * px + a.matrix[2] * py + a.matrix[4], a.matrix[1] * px + a.matrix[3] * py + a.matrix[5]]);
      else x.matrix = multiply(a.matrix, x.matrix);
    });
    const t = ctx.store.doc.layers.find((y) => y.id === l.id);
    return t.quad ? { corners: t.quad } : { matrix: t.matrix };
  });

  bus.register('layer.duplicate', async (a) => {
    const l = needLayer(ctx, a.layerId, { unlocked: false });
    if (l.kind === 'group') fail('unsupported', 'duplicating a group is not built yet', 'change_target', 'duplicate_layer');
    const copy = structuredClone(l);
    copy.id = makeLayer(l.kind).id; copy.name = `${l.name} copy`;
    if (l.buffer) { const b = ctx.renderer.buffers.get(l.buffer); copy.buffer = ctx.renderer.newPixels(b.width, b.height, ctx.renderer.bufferData(l.buffer).slice()); }
    for (const c of copy.mask?.components || []) {
      if (c.bitmap) { const b = ctx.renderer.buffers.get(c.bitmap); const id = ctx.renderer.newMask(b.width, b.height); ctx.renderer.bufferIO.write(id, ctx.renderer.bufferData(c.bitmap)); c.bitmap = id; }
    }
    await change(ctx, 'duplicate_layer', (doc) => { doc.layers.splice(doc.layers.findIndex((x) => x.id === l.id) + 1, 0, copy); doc.activeLayerId = copy.id; });
    return { layer: layerRow(copy) };
  });

  // Merge: renders the chosen layers alone into one 8-bit sRGB raster layer (live develop, text and masks
  // become pixels; values above white clip), placed where the lowest of them was.
  bus.register('layer.merge', async (a) => {
    const d = needDoc(ctx);
    let ids;
    if (a.mode === 'visible') ids = d.layers.filter((l) => l.visible).map((l) => l.id);
    else if (a.mode === 'selected') ids = a.layerIds || [];
    else {
      const i = d.layers.findIndex((l) => l.id === (a.layerIds?.[0] ?? d.activeLayerId));
      if (i < 1) fail('invalid', 'merge down needs a layer above another', 'change_target', 'merge_layers');
      ids = [d.layers[i - 1].id, d.layers[i].id];
    }
    ids = d.layers.filter((l) => ids.includes(l.id)).map((l) => l.id);
    if (ids.length < 2) fail('invalid', 'merge needs at least two layers', 'fix_argument', 'merge_layers');
    if (d.layers.some((l) => ids.includes(l.id) && l.locked)) fail('unsupported', 'a locked layer cannot merge', 'change_target', 'set_layer');
    const variant = { ...structuredClone(d), layers: d.layers.filter((l) => ids.includes(l.id) || (l.localOf && ids.includes(l.localOf))) };
    await ctx.renderer.sync(variant);
    let im;
    try { im = await ctx.renderer.image8(0); } finally { await ctx.renderer.sync(d); }
    const buffer = ctx.renderer.newPixels(d.width, d.height, new Uint8Array(im.data.buffer));
    const merged = makeLayer('raster', { name: 'Merged', buffer, width: d.width, height: d.height });
    await change(ctx, 'merge_layers', (doc) => {
      const at = doc.layers.findIndex((l) => ids.includes(l.id));
      doc.layers = doc.layers.filter((l) => !ids.includes(l.id) && !(l.localOf && ids.includes(l.localOf)));
      doc.layers.splice(at, 0, merged);
      doc.activeLayerId = merged.id;
    });
    return { layer: layerRow(merged), merged: ids.length, note: 'merged to 8-bit sRGB pixels; the merged layers are rendered on transparency, as Photoshop does, so a blend mode that depended on layers outside the merge can change the look' };
  });

  bus.register('layer.group', async (a) => {
    const d = needDoc(ctx);
    const chosen = d.layers.filter((l) => a.layerIds.includes(l.id));
    if (chosen.length !== new Set(a.layerIds).size) fail('invalid', 'unknown layer id in layerIds', 'get_state', 'list_layers');
    if (a.action === 'ungroup') {
      if (chosen.some((g) => g.kind !== 'group')) fail('invalid', 'ungroup takes group ids', 'fix_argument', 'group_layers');
      await change(ctx, 'ungroup', (doc) => {
        for (const g of chosen) { for (const x of doc.layers) if (x.parentId === g.id) { if (g.parentId) x.parentId = g.parentId; else delete x.parentId; } }
        doc.layers = doc.layers.filter((x) => !a.layerIds.includes(x.id));
      });
      return { ungrouped: a.layerIds.length, layers: ctx.store.doc.layers.map(layerRow) };
    }
    const parents = new Set(chosen.map((l) => l.parentId ?? null));
    if (parents.size !== 1) fail('invalid', 'grouped layers must share one parent', 'fix_argument', 'group_layers');
    if (chosen.some((l) => l.localOf)) fail('invalid', 'group the photo, not its local adjustment', 'fix_argument', 'group_layers');
    const parent = [...parents][0];
    const group = makeLayer('group', { name: 'Group', isolation: 'pass-through', ...(parent ? { parentId: parent } : {}) });
    const ids = new Set(chosen.map((l) => l.id));
    await change(ctx, 'group_layers', (doc) => {
      const top = Math.max(...doc.layers.map((x, i) => (ids.has(x.id) ? i : -1)));
      doc.layers.splice(top + 1, 0, group);
      for (const x of doc.layers) if (ids.has(x.id) || ids.has(x.localOf)) x.parentId = group.id;
      doc.activeLayerId = group.id;
    });
    return { group: layerRow(group), children: chosen.length };
  });

  bus.register('layer.adjust', async (a) => {
    const l = needLayer(ctx, a.layerId);
    if (l.kind !== 'adjustment') fail('unsupported', 'not an adjustment layer', 'change_target', 'add_layer');
    checkAdjustment({ type: a.type || l.adjustment.type, params: a.type && a.type !== l.adjustment.type ? a.params : { ...l.adjustment.params, ...(a.params || {}) } }, 'set_adjustment');
    await change(ctx, 'set_adjustment', (doc) => {
      const x = doc.layers.find((y) => y.id === l.id);
      x.adjustment = a.type && a.type !== x.adjustment.type ? { type: a.type, params: a.params || {} } : { type: x.adjustment.type, params: { ...x.adjustment.params, ...(a.params || {}) } };
    });
    return { adjustment: ctx.store.doc.layers.find((y) => y.id === l.id).adjustment };
  });

  bus.register('layer.lens-blur', async (a) => {
    const l = needLayer(ctx, a.layerId);
    if (l.kind !== 'raw' && l.kind !== 'image') fail('unsupported', 'lens blur applies to RAW and image layers', 'change_target', 'set_lens_blur');
    if (l.quad) fail('unsupported', 'lens blur on a perspective (corners) layer is not built yet', 'change_target', 'transform_layer');
    if (a.depth && Math.hypot(a.depth.to[0] - a.depth.from[0], a.depth.to[1] - a.depth.from[1]) < 1) fail('invalid', 'depth.from and depth.to must be at least 1 px apart', 'fix_argument', 'set_lens_blur');
    if (!a.off) {
      const cur = l.lensBlur || {};
      if (!a.depth && !cur.depth) fail('invalid', 'depth {from, to} is required the first time (a depth model is not available yet)', 'fix_argument', 'set_lens_blur');
      if (a.aperture === undefined && cur.aperture === undefined) fail('invalid', 'aperture is required the first time', 'fix_argument', 'set_lens_blur');
      if (a.focus !== undefined && a.focusPoint) fail('invalid', 'give focus or focusPoint, not both', 'fix_argument', 'set_lens_blur');
    }
    await change(ctx, 'set_lens_blur', (doc) => {
      const x = doc.layers.find((y) => y.id === l.id);
      if (a.off) { delete x.lensBlur; return; }
      const n = { ...(x.lensBlur || {}) };
      for (const k of ['depth', 'aperture', 'maxRadius']) if (a[k] !== undefined) n[k] = a[k];
      if (a.focusPoint) { n.focusPoint = a.focusPoint; delete n.focus; }
      if (a.focus !== undefined) { n.focus = a.focus; delete n.focusPoint; }
      x.lensBlur = n;
    });
    return { lensBlur: ctx.store.doc.layers.find((y) => y.id === l.id).lensBlur ?? null };
  });

  bus.register('layer.text', async (a) => {
    const l = needLayer(ctx, a.layerId);
    if (l.kind !== 'text') fail('unsupported', 'not a text layer', 'change_target', 'set_text');
    await change(ctx, 'set_text', (doc) => {
      const x = doc.layers.find((y) => y.id === l.id);
      if (a.content !== undefined) x.text.content = a.content;
      if (a.style) x.text.style = { ...x.text.style, ...a.style };
    });
    return { layer: layerRow(ctx.store.doc.layers.find((y) => y.id === l.id)) };
  });
}
