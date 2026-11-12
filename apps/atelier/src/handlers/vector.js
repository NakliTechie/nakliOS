// Vector commands: paths (pen tool output, path booleans, path → selection), vector masks, shape layers,
// placement of rich text (runs, OpenType features, type on a path, warps; the set_text handler in
// layers.js calls placeRichText), and artboards.
//
// Document fields (plain JSON, so .atelier save and load carry them unchanged):
//   doc.paths      [{ id, name, model, fillRule }]                 model in document pixels (src/vector/geom.js)
//   l.vectorMask   { model, feather, invert, pathId? }               model in the layer's local pixels
//   l.shape        { type, params, model, fill, stroke, fillRule }   kind 'shape'; model in local pixels
//   l.text.origin / runs / features / path / warp                   see src/vector/text.js
//   doc.artboards  [{ id, name, x, y, width, height, background }]; l.artboardId on top-level layers

import { makeLayer } from '../document.js';
import { invertAffine } from '../../vendor/tessella/src/model.js';
import * as G from '../vector/geom.js';
import { boolean } from '../vector/booleans.js';
import { maskFromModel, shapeExtent, parseColour } from '../vector/raster.js';
import { checkRich, isRich } from '../vector/text.js';
import { fileSafe } from '../files/workspace.js';
import { frameDoc } from '../motion/timeline.js';
import { needDoc, needLayer, fail, change, layerRow, stageOrRun } from './util.js';

const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const T = (x, y) => [1, 0, 0, 1, x, y];
let seq = 0;
const newId = (p) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

// ---- path input ----------------------------------------------------------------------------------
// A path arrives as SVG path data `d` or as `subpaths` [{ closed, anchors: [{ x, y, hIn?, hOut? }] }]
// (handles relative to their anchor, as in Ductella). Coordinates are document pixels.
export function modelFrom(a, tool, ctx) {
  let model;
  if (typeof a.d === 'string') model = G.parsePath(a.d);
  else if (Array.isArray(a.subpaths)) {
    model = a.subpaths.map((sp) => ({ closed: !!sp.closed, anchors: sp.anchors.map((p) => G.makeAnchor(p.x, p.y, p.hIn || undefined, p.hOut || undefined)) }));
  } else if (a.pathId && ctx) {
    const p = (needDoc(ctx).paths || []).find((x) => x.id === a.pathId);
    if (!p) fail('invalid', `no path ${a.pathId}`, 'get_state', 'list_paths');
    model = G.cloneModel(p.model);
  } else fail('invalid', 'give d (SVG path data), subpaths or pathId', 'fix_argument', tool);
  model = model.filter((sp) => sp.anchors.length > 1);
  if (!model.length) fail('invalid', 'the path has no segments', 'fix_argument', tool);
  for (const sp of model) for (const p of sp.anchors) if (![p.x, p.y, p.hIn.x, p.hIn.y, p.hOut.x, p.hOut.y].every(Number.isFinite)) fail('invalid', 'path coordinates must be finite numbers', 'fix_argument', tool);
  return model;
}
const pathRow = (p) => ({ id: p.id, name: p.name, d: G.writePath(p.model, 2), fillRule: p.fillRule, bounds: G.bounds(p.model), subpaths: p.model.length, closed: p.model.every((sp) => sp.closed) });

// ---- shapes --------------------------------------------------------------------------------------
export const SHAPE_TYPES = ['rect', 'rounded-rect', 'ellipse', 'polygon', 'line', 'path'];
export function shapeModel(s, tool = 'add_shape_layer', ctx = null) {
  const n = (k, min = -Infinity) => { const v = s[k]; if (typeof v !== 'number' || !Number.isFinite(v) || v < min) fail('invalid', `shape.${k} must be a number${min > -Infinity ? ` >= ${min}` : ''}`, 'fix_argument', tool); return v; };
  switch (s.type) {
    case 'rect': return G.rectModel(n('x'), n('y'), n('width', 0.01), n('height', 0.01));
    case 'rounded-rect': { const r = n('radius', 0); return G.rectModel(n('x'), n('y'), n('width', 0.01), n('height', 0.01), r, r); }
    case 'ellipse': { const w = n('width', 0.01); const h = n('height', 0.01); return G.ellipseModel(n('x') + w / 2, n('y') + h / 2, w / 2, h / 2); }
    case 'polygon': return G.polygonModel(n('cx'), n('cy'), n('radius', 0.01), Math.max(3, Math.round(n('sides', 3))), s.rotation ?? 0);
    case 'line': return [{ closed: false, anchors: [G.makeAnchor(n('x1'), n('y1')), G.makeAnchor(n('x2'), n('y2'))] }];
    case 'path': return modelFrom(s, tool, ctx);
    default: return fail('invalid', `shape.type must be one of ${SHAPE_TYPES.join(', ')}`, 'fix_argument', tool);
  }
}
function checkPaint(fill, stroke, tool) {
  if (fill != null && fill !== 'none' && !parseColour(fill)) fail('invalid', 'fill must be #rrggbb or #rrggbbaa, or null', 'fix_argument', tool);
  if (stroke != null) {
    if (!parseColour(stroke.color)) fail('invalid', 'stroke.color must be #rrggbb or #rrggbbaa', 'fix_argument', tool);
    if (!(stroke.width > 0)) fail('invalid', 'stroke.width must be above 0', 'fix_argument', tool);
    if (stroke.dash && (stroke.dash.length < 1 || stroke.dash.some((v) => !(v >= 0)) || !stroke.dash.some((v) => v > 0))) fail('invalid', 'stroke.dash lists non-negative lengths, at least one above 0', 'fix_argument', tool);
  }
}
// Moves a shape's model so its raster box starts at local (0, 0) and moves the matrix the other way;
// the pixels stay where they were. Integer moves keep the box stable on the next call.
export function normaliseShape(l) {
  const e = shapeExtent(l.shape);
  if (!e.x && !e.y) return l;
  l.shape.model = G.transformModel(l.shape.model, T(-e.x, -e.y));
  l.matrix = mul(l.matrix, T(e.x, e.y));
  if (l.vectorMask) l.vectorMask.model = G.transformModel(l.vectorMask.model, T(-e.x, -e.y));
  return l;
}

// Rich text: render once to learn where the source's pixel (0, 0) falls, then move text.origin and the
// matrix so it falls on the layer origin (masks and selections map through l.matrix alone).
export async function placeRichText(ctx, l) {
  // Back to plain text (rich fields cleared): the plain renderer ignores text.origin, so fold it into the
  // matrix (M' = M · T(origin)) and the vector mask (T(-origin) · model), and the text stays where it was.
  if (!isRich(l.text) && l.text?.origin) {
    const [ox, oy] = l.text.origin; delete l.text.origin;
    if (ox || oy) {
      l.matrix = mul(l.matrix, T(ox, oy));
      if (l.vectorMask) l.vectorMask.model = G.transformModel(l.vectorMask.model, T(-ox, -oy));
    }
    return l;
  }
  if (!isRich(l.text) || !ctx.renderer?.sourceSize) return l;
  const off = (await ctx.renderer.sourceSize(l)).meta?.offset || [0, 0];
  if (!off[0] && !off[1]) return l;
  const o = l.text.origin || [0, 0];
  l.text.origin = [o[0] - off[0], o[1] - off[1]];
  l.matrix = mul(l.matrix, T(off[0], off[1]));
  if (l.vectorMask) l.vectorMask.model = G.transformModel(l.vectorMask.model, T(-off[0], -off[1]));
  return l;
}
// set_text's rich fields → the new text object (doc-space path converted to the layer's local space).
export function richText(ctx, l, a, tool = 'set_text') {
  const t = structuredClone(l.text);
  for (const k of ['runs', 'features', 'warp']) if (a[k] !== undefined) t[k] = structuredClone(a[k]);
  for (const k of a.clear || []) delete t[k];
  if (a.path !== undefined && !(a.clear || []).includes('path')) {
    {
      const docModel = modelFrom(a.path, tool, ctx);
      const local = G.transformModel(docModel, invertAffine(l.matrix));
      // the path lives in the text's own space, before text.origin moves it
      const o = t.origin || [0, 0];
      t.path = { model: G.transformModel(local, T(-o[0], -o[1])), startOffset: a.path.startOffset ?? 0, flip: !!a.path.flip, ...(a.path.pathId ? { pathId: a.path.pathId } : {}) };
    }
  }
  if (t.runs && !t.runs.length) delete t.runs;
  const bad = checkRich(t);
  if (bad) fail('invalid', bad, 'fix_argument', tool);
  return t;
}

// ---- artboards -----------------------------------------------------------------------------------
const boardRow = (doc, a) => ({ ...a, layers: doc.layers.filter((l) => l.artboardId === a.id).map((l) => l.id) });
function boardLayers(doc, a) {
  const ids = new Set(doc.layers.filter((l) => !l.parentId && l.artboardId === a.id).map((l) => l.id));
  for (let grew = true; grew;) { grew = false; for (const x of doc.layers) if (!ids.has(x.id) && (ids.has(x.parentId) || ids.has(x.localOf))) { ids.add(x.id); grew = true; } }
  return doc.layers.filter((l) => ids.has(l.id));
}

export function register(bus, ctx) {
  const rd = () => ctx.renderer;
  const findPath = (doc, id) => (doc.paths || []).find((p) => p.id === id) || fail('invalid', `no path ${id}`, 'get_state', 'list_paths');

  // ---- paths ----
  bus.register('vector.path-list', async () => ({ paths: (needDoc(ctx).paths || []).map(pathRow) }));
  bus.register('vector.path-add', async (a) => {
    needDoc(ctx);
    const model = modelFrom(a, 'add_path');
    const p = { id: newId('P'), name: a.name || `Path ${(ctx.store.doc.paths || []).length + 1}`, model, fillRule: a.fillRule || 'nonzero' };
    await change(ctx, 'add_path', (d) => { d.paths = [...(d.paths || []), p]; });
    return { path: pathRow(p) };
  });
  bus.register('vector.path-set', async (a) => {
    const doc = needDoc(ctx); const p = findPath(doc, a.pathId);
    const model = a.d !== undefined || a.subpaths !== undefined ? modelFrom(a, 'set_path') : null;
    await change(ctx, 'set_path', (d) => {
      const x = d.paths.find((q) => q.id === p.id);
      if (model) x.model = model;
      if (a.name !== undefined) x.name = a.name;
      if (a.fillRule !== undefined) x.fillRule = a.fillRule;
    });
    return { path: pathRow(ctx.store.doc.paths.find((q) => q.id === p.id)) };
  });
  bus.register('vector.path-delete', async (a) => {
    const doc = needDoc(ctx); findPath(doc, a.pathId);
    await change(ctx, 'delete_path', (d) => { d.paths = d.paths.filter((q) => q.id !== a.pathId); });
    return { deleted: a.pathId, paths: ctx.store.doc.paths.length };
  });
  // Booleans (Ductella's path-bool route): pathIds in stacking order, bottom first. subtract = the bottom
  // path minus every path above it; exclude keeps the areas covered an odd number of times.
  const OPS = { union: 'unite', subtract: 'minus-front', intersect: 'intersect', exclude: 'exclude' };
  bus.register('vector.path-combine', async (a) => {
    const doc = needDoc(ctx);
    if (new Set(a.pathIds).size !== a.pathIds.length) fail('invalid', 'pathIds repeats a path', 'fix_argument', 'combine_paths');
    const inputs = a.pathIds.map((id) => { const p = findPath(doc, id); return { model: p.model, fillRule: p.fillRule }; });
    const model = boolean(OPS[a.op], inputs);
    if (!model.length) fail('invalid', `the ${a.op} of these paths is empty`, 'fix_argument', 'combine_paths');
    const p = { id: newId('P'), name: a.name || `${a.op[0].toUpperCase()}${a.op.slice(1)}`, model, fillRule: 'nonzero' };
    await change(ctx, 'combine_paths', (d) => { d.paths = [...(a.replace ? d.paths.filter((q) => !a.pathIds.includes(q.id)) : d.paths), p]; });
    return { path: pathRow(p), area: Math.abs(G.area(model)) };
  });
  bus.register('vector.path-select', async (a) => {
    const doc = needDoc(ctx); const p = findPath(doc, a.pathId);
    if (!ctx.selectionWrite) fail('unsupported', 'selections need the engine', 'get_capabilities', 'get_capabilities');
    const cov = maskFromModel(p.model, doc.width, doc.height, { feather: a.feather || 0, fillRule: p.fillRule });
    return ctx.selectionWrite(`select ${a.op || 'replace'} path`, cov, a.op || 'replace');
  });

  // ---- vector masks ----
  bus.register('vector.mask', async (a) => {
    const l = needLayer(ctx, a.layerId); const T0 = 'set_vector_mask';
    if (l.kind === 'group' || l.kind === 'fill') fail('unsupported', `a ${l.kind} layer has no pixel grid for a vector mask; use a shape layer (add_shape_layer) for a filled shape`, 'change_target', 'add_shape_layer');
    if (l.quad) fail('unsupported', 'a vector mask on a perspective (corners) layer is not built', 'change_target', 'transform_layer');
    if (a.off) { await change(ctx, T0, (d) => { delete d.layers.find((x) => x.id === l.id).vectorMask; }); return { layer: layerRow(ctx.store.doc.layers.find((x) => x.id === l.id)), vectorMask: null }; }
    let vm = l.vectorMask ? structuredClone(l.vectorMask) : null;
    if (a.d !== undefined || a.subpaths !== undefined || a.pathId !== undefined) {
      const docModel = modelFrom(a, T0, ctx);
      const toLocal = l.kind === 'adjustment' ? [1, 0, 0, 1, 0, 0] : invertAffine(l.matrix);
      vm = { ...(vm || {}), model: G.transformModel(docModel, toLocal), ...(a.pathId ? { pathId: a.pathId } : {}) };
      if (!a.pathId) delete vm.pathId;
    }
    if (!vm) fail('invalid', 'the layer has no vector mask yet; give pathId, d or subpaths', 'fix_argument', T0);
    if (a.feather !== undefined) vm.feather = a.feather;
    if (a.invert !== undefined) vm.invert = a.invert;
    vm.feather = vm.feather || 0; vm.invert = !!vm.invert;
    await change(ctx, T0, (d) => { d.layers.find((x) => x.id === l.id).vectorMask = vm; });
    return { layer: layerRow(ctx.store.doc.layers.find((x) => x.id === l.id)), vectorMask: { d: G.writePath(vm.model, 2), feather: vm.feather, invert: vm.invert, space: 'layer' } };
  });

  // ---- shape layers ----
  const shapeOut = (l) => ({ layer: layerRow(l), shape: { type: l.shape.type, fill: l.shape.fill, stroke: l.shape.stroke, d: G.writePath(l.shape.model, 2) }, matrix: l.matrix });
  bus.register('vector.shape-add', async (a) => {
    const d0 = needDoc(ctx); const tool = 'add_shape_layer';
    const model = shapeModel(a.shape, tool, ctx);
    const fill = a.fill === undefined ? (a.shape.type === 'line' ? null : '#808080') : a.fill === 'none' ? null : a.fill;
    const stroke = a.stroke ?? (a.shape.type === 'line' ? { color: '#000000', width: 2 } : null);
    checkPaint(fill, stroke, tool);
    if (!fill && !stroke) fail('invalid', 'a shape needs a fill or a stroke', 'fix_argument', tool);
    const { d: _d, ...params } = a.shape;
    const l = makeLayer('shape', { name: a.name || `${a.shape.type} shape`, shape: { type: a.shape.type, params, model, fill, stroke: stroke ? { align: 'center', join: 'miter', cap: 'butt', ...stroke } : null, fillRule: a.fillRule || 'nonzero' } });
    normaliseShape(l);
    const act = d0.layers.find((x) => x.id === d0.activeLayerId);
    if (act?.parentId) l.parentId = act.parentId;
    if (act?.artboardId && !act.parentId) l.artboardId = act.artboardId;
    await change(ctx, tool, (doc) => {
      const i = doc.layers.findIndex((x) => x.id === doc.activeLayerId);
      doc.layers.splice(i < 0 ? doc.layers.length : i + 1, 0, l);
      doc.activeLayerId = l.id;
    });
    return shapeOut(l);
  });
  bus.register('vector.shape-set', async (a) => {
    const l = needLayer(ctx, a.layerId); const tool = 'set_shape';
    if (l.kind !== 'shape') fail('unsupported', `${l.name} is not a shape layer`, 'change_target', 'add_shape_layer');
    const x = structuredClone(l);
    if (a.shape) {
      const docModel = shapeModel(a.shape, tool, ctx);
      const { d: _d, ...params } = a.shape;
      // new geometry is given in document pixels: back to layer space, then re-normalise.
      x.shape.model = G.transformModel(docModel, invertAffine(x.matrix)); x.shape.type = a.shape.type; x.shape.params = params;
    }
    if (a.fill !== undefined) x.shape.fill = a.fill === 'none' ? null : a.fill;
    if (a.noStroke) x.shape.stroke = null;
    else if (a.stroke !== undefined) x.shape.stroke = { align: 'center', join: 'miter', cap: 'butt', ...(x.shape.stroke || {}), ...a.stroke };
    checkPaint(x.shape.fill, x.shape.stroke, tool);
    if (!x.shape.fill && !x.shape.stroke) fail('invalid', 'a shape needs a fill or a stroke', 'fix_argument', tool);
    normaliseShape(x);
    await change(ctx, tool, (doc) => { const i = doc.layers.findIndex((y) => y.id === l.id); doc.layers[i] = x; });
    return shapeOut(x);
  });

  // ---- artboards ----
  const findBoard = (doc, id) => (doc.artboards || []).find((b) => b.id === id) || fail('invalid', `no artboard ${id}`, 'get_state', 'list_artboards');
  const checkBg = (bg, tool) => { if (bg !== undefined && bg !== 'transparent' && !/^#[0-9a-f]{6}$/i.test(bg)) fail('invalid', "background is '#rrggbb' or 'transparent'", 'fix_argument', tool); };
  function fits(doc, r, grow, tool) {
    if (r.x < 0 || r.y < 0) fail('invalid', 'artboards start at x, y >= 0 (the document grows right and down only)', 'fix_argument', tool);
    const W = Math.max(doc.width, Math.ceil(r.x + r.width)); const H = Math.max(doc.height, Math.ceil(r.y + r.height));
    if ((W !== doc.width || H !== doc.height) && !grow) fail('invalid', `the artboard reaches ${W} × ${H}, past the ${doc.width} × ${doc.height} document; pass grow: true to enlarge the document`, 'fix_argument', tool);
    if ((W !== doc.width || H !== doc.height) && (doc.selection || Object.keys(doc.savedSelections || {}).length)) fail('unsupported', 'growing the document with a selection or saved selections is not built; deselect first', 'change_target', 'set_selection');
    if ((W !== doc.width || H !== doc.height) && doc.layers.some((l) => l.kind === 'adjustment' && (l.mask?.components || []).some((c) => c.kind === 'bitmap'))) fail('unsupported', 'growing the document under a painted adjustment-layer mask is not built', 'change_target', 'set_mask');
    return [W, H];
  }
  bus.register('vector.artboard-list', async () => { const doc = needDoc(ctx); return { artboards: (doc.artboards || []).map((a) => boardRow(doc, a)), document: { width: doc.width, height: doc.height } }; });
  bus.register('vector.artboard-add', async (a) => {
    const doc = needDoc(ctx); const tool = 'add_artboard'; checkBg(a.background, tool);
    const b = { id: newId('A'), name: a.name || `Artboard ${(doc.artboards || []).length + 1}`, x: a.x, y: a.y, width: a.width, height: a.height, background: a.background || '#ffffff' };
    const [W, H] = fits(doc, b, a.grow, tool);
    await change(ctx, tool, (d) => {
      d.width = W; d.height = H; d.artboards = [...(d.artboards || []), b];
      for (const id of a.layerIds || []) { const l = d.layers.find((x) => x.id === id && !x.parentId); if (l) l.artboardId = b.id; }
    });
    return { artboard: boardRow(ctx.store.doc, b), document: { width: W, height: H } };
  });
  bus.register('vector.artboard-set', async (a) => {
    const doc = needDoc(ctx); const tool = 'set_artboard'; const b0 = findBoard(doc, a.artboardId); checkBg(a.background, tool);
    const b = { ...b0 }; for (const k of ['name', 'x', 'y', 'width', 'height', 'background']) if (a[k] !== undefined) b[k] = a[k];
    const [W, H] = fits(doc, b, a.grow, tool);
    const dx = b.x - b0.x; const dy = b.y - b0.y;
    const moving = (dx || dy) && a.moveLayers !== false ? boardLayers(doc, b0).filter((l) => !l.localOf && l.kind !== 'group' && l.kind !== 'fill' && l.kind !== 'adjustment') : [];
    if (moving.some((l) => l.locked)) fail('unsupported', 'a locked layer on the artboard cannot move; unlock it or pass moveLayers: false', 'change_target', 'set_layer');
    await change(ctx, tool, (d) => {
      d.width = W; d.height = H;
      Object.assign(d.artboards.find((x) => x.id === b.id), b);
      for (const m of moving) { const l = d.layers.find((x) => x.id === m.id); if (l.quad) l.quad = l.quad.map(([px, py]) => [px + dx, py + dy]); else l.matrix = mul(T(dx, dy), l.matrix); }
    });
    return { artboard: boardRow(ctx.store.doc, b), moved: moving.length };
  });
  bus.register('vector.artboard-delete', async (a) => {
    const doc = needDoc(ctx); findBoard(doc, a.artboardId);
    await change(ctx, 'delete_artboard', (d) => { d.artboards = d.artboards.filter((x) => x.id !== a.artboardId); if (!d.artboards.length) delete d.artboards; for (const l of d.layers) if (l.artboardId === a.artboardId) delete l.artboardId; });
    return { deleted: a.artboardId, note: 'its layers stay in the document, outside any artboard' };
  });
  bus.register('vector.artboard-assign', async (a) => {
    const l = needLayer(ctx, a.layerId, { unlocked: false }); const doc = needDoc(ctx);
    if (l.parentId) fail('invalid', 'only top-level layers belong to artboards; a layer in a group follows its group', 'change_target', 'move_layer');
    if (l.localOf) fail('invalid', 'a local adjustment follows its photo layer', 'change_target', 'set_layer_artboard');
    if (a.artboardId) findBoard(doc, a.artboardId);
    await change(ctx, 'set_layer_artboard', (d) => {
      const ids = new Set([l.id, ...d.layers.filter((x) => x.localOf === l.id).map((x) => x.id)]);
      for (const x of d.layers) if (ids.has(x.id)) { if (a.artboardId) x.artboardId = a.artboardId; else delete x.artboardId; }
    });
    return { layer: layerRow(ctx.store.doc.layers.find((x) => x.id === l.id)), artboardId: a.artboardId || null };
  });
  // Export: one file per artboard, each rendered with only its own layers and cropped to its rectangle.
  bus.register('vector.artboard-export', async (a, { door }) => {
    const doc = needDoc(ctx); const tool = 'export_artboards';
    const boards = a.artboardId ? [findBoard(doc, a.artboardId)] : (doc.artboards || []);
    if (!boards.length) fail('invalid', 'the document has no artboards', 'change_target', 'add_artboard');
    const s = ctx.storage(); if (!s) fail('unsupported', 'no storage: open a folder first', 'change_target', 'grant_folder');
    const fmt = a.format || 'png'; const ext = fmt === 'jpeg' ? 'jpg' : 'png';
    const folder = a.folder.replace(/\/+$/, '');
    const paths = boards.map((b) => `${folder}/${fileSafe(b.name)}.${ext}`);
    if (new Set(paths).size !== paths.length) fail('invalid', 'two artboards share a name; rename one (set_artboard)', 'fix_argument', 'set_artboard');
    const existing = []; for (const p of paths) if (await s.exists(p)) existing.push(p);
    const what = `export ${boards.length} artboard${boards.length > 1 ? 's' : ''} as ${fmt.toUpperCase()} to ${folder}/${existing.length ? ` (REPLACES ${existing.join(', ')})` : ''}`;
    return stageOrRun(ctx, { door }, tool, what, async () => {
      const r = rd(); const out = [];
      try {
        // The artboards as the preview shows them: an animated document at its current timeline frame.
        const shown = frameDoc(doc, ctx.motion?.docId === doc.id ? ctx.motion.frame : 0);
        for (const [i, b] of boards.entries()) {
          await r.sync({ ...shown, artboards: [b], layers: boardLayers(shown, b) });
          const im = await r.image8(0, [b.x, b.y, b.x + b.width, b.y + b.height], fmt === 'jpeg' ? 1 : null);
          if (im.width !== b.width || im.height !== b.height) throw new Error(`rendered ${im.width} × ${im.height}, expected ${b.width} × ${b.height}`);
          const bytes = await r.encode(im, fmt === 'jpeg' ? 'image/jpeg' : 'image/png', (a.quality ?? 90) / 100);
          await s.write(paths[i], bytes);
          out.push({ artboard: b.id, path: paths[i], width: im.width, height: im.height, bytes: bytes.length });
        }
      } finally { await r.sync(ctx.store.doc); }
      return { files: out };
    }, { force: existing.length > 0 });
  });
}
