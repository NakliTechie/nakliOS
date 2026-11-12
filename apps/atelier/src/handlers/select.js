// Selection, mask, paint and filter commands. The selection is a document-size 8-bit bitmap held in a
// renderer mask buffer and referenced from doc.selection = { buffer, bounds }. Layer masks are engine
// mask components; bitmap components and raster pixels live in renderer buffers in layer-local pixels.
// Pixel work is CPU (src/select/*); the engine re-uploads what changed.

import { invertAffine, MASK_KINDS } from '../../vendor/tessella/src/model.js';
import { MAX_MASK } from '../../vendor/tessella/src/shaders.js';
import * as R from '../select/raster.js';
import * as P from '../select/paint.js';
import * as RT from '../select/retouch.js';
import { ARTISTIC } from '../select/artistic.js';
import { createQuickMask } from '../select/quickmask.js';
import { makeLayer } from '../document.js';
import { needDoc, needLayer, fail, change, layerRow } from './util.js';
import { resolveBrush } from './brush.js';
import { frameDoc } from '../motion/timeline.js';

const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function register(bus, ctx) {
  const rd = () => ctx.renderer;
  const num = (obj, key, tool, { min = -Infinity, max = Infinity, def } = {}) => {
    const v = obj?.[key] ?? def;
    if (!isNum(v) || v < min || v > max) fail('invalid', `params.${key} must be a number${min > -Infinity ? ` >= ${min}` : ''}${max < Infinity ? ` <= ${max}` : ''}`, 'fix_argument', tool);
    return v;
  };
  const colour = (hex, tool, field = 'color') => {
    const c = P.parseHex(hex ?? '');
    if (!c) fail('invalid', `${field} must be #rrggbb or #rrggbbaa`, 'fix_argument', tool);
    return c;
  };
  const selData = (doc) => (doc.selection ? rd().bufferData(doc.selection.buffer) : null);
  const qm = createQuickMask(ctx);
  ctx.quickMask = qm;   // read by tests (renderWithOverlay) and any view that wants the state

  // Replaces the selection with an 8-bit document-size bitmap (undoable).
  async function writeSelection(label, data) {
    const doc = needDoc(ctx);
    const b = R.bounds(data, doc.width, doc.height);
    // In quick mask the film shows one buffer, so every selection write goes to that buffer.
    const existing = doc.selection?.buffer ?? qm?.buffer ?? null;
    const buf = existing ?? rd().newMask(doc.width, doc.height);
    await change(ctx, label, (d) => {
      rd().bufferIO.write(buf, data);
      d.selection = b ? { buffer: buf, bounds: b } : null;
    }, existing ? [existing] : []);
    return { selection: b ? { bounds: b } : null };
  }

  async function composite8(doc) {
    const im = await rd().image8(0);
    if (im.width !== doc.width || im.height !== doc.height) fail('outcome_unknown', 'the full-resolution render did not match the document size', 'get_state', 'get_state');
    return im.data;
  }

  // Vector selection source: path_to_selection (src/handlers/vector.js) hands a document-size coverage here.
  ctx.selectionWrite = (label, shape, op) => writeSelection(label, R.combine(selData(needDoc(ctx)), shape, op));

  // The selection resampled into a layer's local grid (null when nothing is selected).
  // The matrix a layer shows with at the current timeline frame (motion.js keeps ctx.motion): an animated
  // layer's pixels are edited through the place the person sees it, not through its base matrix.
  const shownMatrix = (doc, l) => {
    const f = ctx.motion?.docId === doc.id ? ctx.motion.frame : 0;
    return doc.timeline ? (frameDoc(doc, f).layers.find((x) => x.id === l.id)?.matrix ?? l.matrix) : l.matrix;
  };
  const localCoverage = (doc, l, w, h) => (doc.selection ? R.resampleToLocal(selData(doc), doc.width, doc.height, shownMatrix(doc, l), w, h) : null);
  // A video layer's pixels are replaced by the video frame on every timeline move, so an edit would vanish.
  const notVideo = (l, tool) => { if (l.video) fail('unsupported', `${l.name} is a video layer: its pixels are replaced by the video frame on every frame, so ${tool} would be lost; edit a raster layer above it or use an adjustment layer`, 'change_target', 'add_layer'); };

  bus.register('selection.set', async (a) => {
    const doc = needDoc(ctx); const T = 'set_selection'; const p = a.params || {};
    const W = doc.width; const H = doc.height;
    if (a.shape === 'none') return writeSelection('deselect', new Uint8Array(W * H));
    let shape;
    if (a.shape === 'all') shape = new Uint8Array(W * H).fill(255);
    else if (a.shape === 'rect') shape = R.rasterRect(W, H, { x: num(p, 'x', T), y: num(p, 'y', T), w: num(p, 'w', T, { min: 0 }), h: num(p, 'h', T, { min: 0 }) });
    else if (a.shape === 'ellipse') {
      const e = 'cx' in p ? { cx: num(p, 'cx', T), cy: num(p, 'cy', T), rx: num(p, 'rx', T, { min: 0 }), ry: num(p, 'ry', T, { min: 0 }) }
        : (() => { const x = num(p, 'x', T); const y = num(p, 'y', T); const w = num(p, 'w', T, { min: 0 }); const h = num(p, 'h', T, { min: 0 }); return { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 }; })();
      shape = e.rx > 0 && e.ry > 0 ? R.rasterEllipse(W, H, e) : new Uint8Array(W * H);
    } else if (a.shape === 'polygon') {
      const pts = p.points;
      if (!Array.isArray(pts) || pts.length < 3 || !pts.every((q) => Array.isArray(q) && isNum(q[0]) && isNum(q[1]))) fail('invalid', 'params.points must be at least 3 [x, y] pairs in document pixels', 'fix_argument', T);
      shape = R.rasterPolygon(W, H, pts);
    } else if (a.shape === 'wand') {
      const x = num(p, 'x', T, { min: 0, max: W - 1 }); const y = num(p, 'y', T, { min: 0, max: H - 1 });
      shape = R.floodRegion(await composite8(doc), W, H, x, y, num(p, 'tolerance', T, { min: 0, max: 255, def: 32 }), p.contiguous !== false);
    } else if (a.shape === 'colour-range') {
      let c;
      const img = await composite8(doc);
      if (p.color !== undefined) c = colour(p.color, T, 'params.color');
      else {
        const x = Math.floor(num(p, 'x', T, { min: 0, max: W - 1 })); const y = Math.floor(num(p, 'y', T, { min: 0, max: H - 1 }));
        const k = (y * W + x) * 4; c = [img[k], img[k + 1], img[k + 2], img[k + 3]];
      }
      shape = R.colourRange(img, W, H, c, num(p, 'tolerance', T, { min: 0, max: 255, def: 32 }), num(p, 'fuzziness', T, { min: 0, max: 255, def: 0 }));
    } else fail('invalid', `unknown shape ${a.shape}`, 'fix_argument', T);
    return writeSelection(`select ${a.op} ${a.shape}`, R.combine(selData(doc), shape, a.op));
  });

  bus.register('selection.refine', async (a, opts) => {
    const doc = needDoc(ctx); const T = 'refine_selection'; const W = doc.width; const H = doc.height;
    if (a.action === 'quick-mask-toggle') {
      // View state only (no revision bump, not saved): the selection buffer is what changes.
      if (!qm) fail('unsupported', 'quick mask needs the engine', 'get_capabilities', 'get_capabilities');
      opts?.viewOnly();
      if (qm.on) qm.disable();
      else qm.enable(doc.selection?.buffer ?? rd().newMask(W, H));
      await ctx.sync();
      const s = doc.selection;
      return { quickMask: qm.on, selection: s ? { bounds: s.bounds } : null, ...(qm.on ? { note: 'paint_stroke brush (white adds, black removes) and eraser now edit the selection; toggle again to return to the selection outline' } : {}) };
    }
    if (a.action === 'load') {
      const id = doc.savedSelections?.[a.name];
      if (!id) fail('invalid', `no saved selection ${a.name}; saved: ${Object.keys(doc.savedSelections || {}).join(', ') || 'none'}`, 'fix_argument', T);
      return writeSelection(`load selection ${a.name}`, rd().bufferData(id).slice());
    }
    const cur = selData(doc);
    if (!cur) fail('invalid', 'there is no selection', 'change_target', 'set_selection');
    const amount = () => { if (!isNum(a.amount) || a.amount <= 0) fail('invalid', 'amount (pixels) above 0 is required', 'fix_argument', T); return a.amount; };
    switch (a.action) {
      case 'feather': return writeSelection('feather selection', R.feather(cur, W, H, amount()));
      case 'expand': return writeSelection('expand selection', R.expand(cur, W, H, amount()));
      case 'contract': return writeSelection('contract selection', R.contract(cur, W, H, amount()));
      case 'smooth': return writeSelection('smooth selection', R.smooth(cur, W, H, amount()));
      case 'invert': return writeSelection('invert selection', R.invert(cur));
      case 'save': {
        if (!a.name) fail('invalid', 'name is required', 'fix_argument', T);
        const id = rd().newMask(W, H); rd().bufferIO.write(id, cur);
        await change(ctx, `save selection ${a.name}`, (d) => { d.savedSelections = { ...(d.savedSelections || {}), [a.name]: id }; });
        return { saved: Object.keys(ctx.store.doc.savedSelections) };
      }
      case 'to-mask': {
        const l = needLayer(ctx);
        if (l.kind === 'fill') fail('unsupported', 'a fill layer has no pixel grid for a bitmap mask; use set_mask with linear, radial or luminance-range', 'change_target', 'set_mask');
        if (l.mask) fail('invalid', `layer ${l.name} already has a mask; use set_mask with a bitmap component {from:'selection'}`, 'change_target', 'set_mask');
        const { width, height } = await rd().sourceSize(l);
        const id = rd().newMask(width, height); rd().bufferIO.write(id, R.resampleToLocal(cur, W, H, l.matrix, width, height));
        await change(ctx, 'selection to mask', (d) => { d.layers.find((x) => x.id === l.id).mask = { components: [{ op: 'add', kind: 'bitmap', bitmap: id }], invert: false }; });
        return { layer: layerRow(ctx.store.doc.layers.find((x) => x.id === l.id)) };
      }
      default: return fail('invalid', `unknown action ${a.action}`, 'fix_argument', T);
    }
  });

  bus.register('mask.set', async (a) => {
    const doc = needDoc(ctx); const T = 'set_mask';
    const base = needLayer(ctx, a.layerId);
    // On a RAW layer, maskId names a local adjustment: a masked second pass of the same photo whose develop
    // settings are the base settings plus the local deltas (set_mask_adjustments). Created on first use.
    let l = base; let createLocal = null;
    if (a.maskId) {
      if (base.kind !== 'raw') fail('unsupported', 'maskId names a local adjustment and needs a RAW layer; other layers have one mask, so omit maskId', 'fix_argument', T);
      const lid = localId(base.id, a.maskId);
      l = doc.layers.find((x) => x.id === lid) || null;
      if (!l) { createLocal = { ...structuredClone(base), id: lid, name: `${base.name} · ${a.maskId}`, localOf: base.id, localDelta: {}, mask: null }; l = createLocal; }
    }
    if (a.feather) fail('unsupported', 'mask feather is not built; feather the selection (refine_selection) before turning it into a bitmap component', 'fix_argument', T);
    if (a.components.length > MAX_MASK) fail('invalid', `at most ${MAX_MASK} components`, 'fix_argument', T);
    if (a.components.filter((c) => c.kind === 'bitmap').length > 1) fail('invalid', 'at most one bitmap component per mask', 'fix_argument', T);
    const comps = [];
    for (const [i, c] of a.components.entries()) {
      const p = c.params || {}; const at = (k) => num(p, k, T);
      // A depth component reads the photo's depth map, which only ai_mask makes (without this the bitmap branch below would take it).
      if (c.kind === 'depth' || c.kind === 'depth-range') fail('unsupported', 'a depth mask component needs the photo\'s depth map, which set_mask cannot make; add it with ai_mask target depth-range (near, far)', 'fix_argument', 'ai_mask');
      if (!MASK_KINDS.includes(c.kind)) fail('unsupported', `${c.kind} mask components are not built yet; built: ${MASK_KINDS.join(', ')}`, 'fix_argument', T);
      if (c.kind === 'linear') comps.push({ op: c.op, kind: 'linear', p0: [at('x0'), at('y0'), at('x1'), at('y1')] });
      else if (c.kind === 'radial') {
        const r0 = num(p, 'r0', T, { min: 0 }); const r1 = num(p, 'r1', T, { min: 0 });
        if (r1 < r0) fail('invalid', `components[${i}].params.r1 must be >= r0`, 'fix_argument', T);
        comps.push({ op: c.op, kind: 'radial', p0: [at('cx'), at('cy'), r0, r1] });
      } else if (c.kind === 'luminance-range') {
        const v = ['lo0', 'lo1', 'hi0', 'hi1'].map((k) => num(p, k, T, { min: 0, max: 255 }));
        if (v[1] < v[0] || v[3] < v[2]) fail('invalid', `components[${i}]: need lo0 <= lo1 and hi0 <= hi1 (0..255 display levels)`, 'fix_argument', T);
        comps.push({ op: c.op, kind: 'luminance-range', p0: v.map((x) => x / 255) });
      } else if (c.kind === 'colour-range') {
        if (l.kind === 'adjustment') fail('unsupported', 'a colour-range mask on an adjustment layer would read the adjusted colour; put the adjustment in a group with the mask, or mask by luminance', 'fix_argument', T);
        // params: color '#rrggbb' (sRGB), tolerance and feather as Oklab distances (0..1).
        if (typeof p.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(p.color)) fail('invalid', `components[${i}].params.color must be '#rrggbb'`, 'fix_argument', T);
        const tol = num(p, 'tolerance', T, { min: 0, max: 1, def: 0.1 }); const fe = num(p, 'feather', T, { min: 0, max: 1, def: 0.05 });
        comps.push({ op: c.op, kind: 'colour-range', p0: [...hexToOklab(p.color), tol], p1: [fe, 0, 0, 0] });
      } else {
        if (l.kind === 'fill' || l.kind === 'group') fail('unsupported', `a ${l.kind} layer has no pixel grid for a bitmap mask; use linear, radial or luminance-range`, 'fix_argument', T);
        const { width, height } = await rd().sourceSize(l);
        let data;
        if (p.from === 'selection') {
          const s = selData(doc);
          if (!s) fail('invalid', 'there is no selection', 'change_target', 'set_selection');
          data = R.resampleToLocal(s, doc.width, doc.height, l.matrix, width, height);
        } else if (p.from === 'current') {
          const old = l.mask?.components.find((x) => x.kind === 'bitmap');
          if (!old) fail('invalid', 'the layer mask has no bitmap component to keep', 'fix_argument', T);
          data = rd().bufferData(old.bitmap).slice();
        } else if (p.fill === 0 || p.fill === 255) data = new Uint8Array(width * height).fill(p.fill);
        else fail('invalid', `components[${i}].params: bitmap takes {from:'selection'}, {from:'current'} or {fill:0|255}`, 'fix_argument', T);
        const id = rd().newMask(width, height); rd().bufferIO.write(id, data);
        comps.push({ op: c.op, kind: 'bitmap', bitmap: id });
      }
    }
    if (createLocal && !comps.length) fail('invalid', 'a new local adjustment needs at least one mask component', 'fix_argument', T);
    await change(ctx, 'set_mask', (d) => {
      if (createLocal) d.layers.splice(d.layers.findIndex((x) => x.id === base.id) + 1, 0, createLocal);
      d.layers.find((x) => x.id === l.id).mask = comps.length ? { components: comps, invert: !!a.invert } : null;
    });
    return { layer: layerRow(ctx.store.doc.layers.find((x) => x.id === l.id)), ...(a.maskId ? { maskId: a.maskId, localLayerId: l.id } : {}) };
  });

  bus.register('mask.paint', async (a) => {
    const T = 'paint_mask';
    let l = needLayer(ctx, a.layerId);
    if (a.maskId) {
      l = ctx.store.doc.layers.find((x) => x.id === localId(l.id, a.maskId));
      if (!l) fail('invalid', `no local adjustment ${a.maskId}; create it with set_mask`, 'change_target', 'set_mask');
    }
    if (l.kind === 'fill' || l.kind === 'group') fail('unsupported', `a ${l.kind} layer has no pixel grid for a painted mask`, 'change_target', 'set_mask');
    const comps = l.mask?.components || [];
    let bm = comps.find((c) => c.kind === 'bitmap');
    let fresh = null;
    if (!bm) {
      if (comps.length >= MAX_MASK) fail('unsupported', `the mask already has ${MAX_MASK} components`, 'change_target', 'set_mask');
      const { width, height } = await rd().sourceSize(l);
      const id = rd().newMask(width, height, comps.length ? 0 : 255);
      fresh = { op: 'add', kind: 'bitmap', bitmap: id }; bm = fresh;
    }
    const inv = invertAffine(l.matrix);
    const scale = Math.sqrt(Math.abs(inv[0] * inv[3] - inv[1] * inv[2]));
    const pts = a.points.map(([x, y]) => apply(inv, x, y));
    const engineId = rd().buffers.get(bm.bitmap).engineId;
    let out;
    await change(ctx, 'paint_mask', (d) => {
      if (fresh) { const x = d.layers.find((y) => y.id === l.id); x.mask = { components: [...comps, fresh], invert: !!l.mask?.invert, ...(l.mask?.density != null ? { density: l.mask.density } : {}) }; }
      out = rd().engine.paintMask(engineId, { points: pts, size: Math.max(1, a.size * scale), hardness: a.hardness ?? 100, flow: a.flow ?? 100, erase: !!a.erase });
    }, [bm.bitmap]);
    return { stamps: out.stamps, layer: layerRow(ctx.store.doc.layers.find((x) => x.id === l.id)) };
  });

  // Raster pixel edits: copy, edit, write back inside one undoable change.
  function rasterLayer(a, tool) {
    const l = needLayer(ctx, a.layerId);
    if (l.kind !== 'raster') fail('unsupported', `${tool} paints raster layers only; ${l.name} is ${l.kind}`, 'change_target', 'add_layer');
    notVideo(l, tool);
    const b = rd().buffers.get(l.buffer);
    return { l, w: b.width, h: b.height };
  }
  async function editPixels(label, l, fn) {
    const id = l.buffer;
    await change(ctx, label, () => { const px = rd().bufferData(id).slice(); fn(px); rd().bufferIO.write(id, px); }, [id]);
  }

  bus.register('paint.fill', async (a) => {
    const T = 'fill'; const doc = needDoc(ctx);
    const { l, w, h } = rasterLayer(a, T);
    const covg = localCoverage(doc, l, w, h);
    if (a.mode === 'solid') {
      const c = colour(a.color, T);
      await editPixels('fill', l, (px) => P.fillSolid(px, w, h, c, covg));
    } else if (a.mode === 'gradient') {
      const g = a.gradient || {};
      const spec = { x0: num(g, 'x0', T), y0: num(g, 'y0', T), x1: num(g, 'x1', T), y1: num(g, 'y1', T), c0: colour(g.from ?? a.color, T, 'gradient.from'), c1: colour(g.to, T, 'gradient.to') };
      await editPixels('gradient', l, (px) => P.fillGradient(px, w, h, spec, shownMatrix(doc, l), covg));
    } else if (a.mode === 'bucket') {
      if (!Array.isArray(a.point)) fail('invalid', 'bucket fill needs point: [x, y] in document pixels', 'fix_argument', 'fill');
      const c = colour(a.color, T);
      const [sx, sy] = apply(invertAffine(shownMatrix(doc, l)), a.point[0], a.point[1]);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) fail('invalid', 'point is outside the layer', 'fix_argument', T);
      await editPixels('bucket fill', l, (px) => {
        const region = R.floodRegion(px, w, h, sx, sy, a.tolerance ?? 32, true);
        if (covg) for (let i = 0; i < region.length; i++) region[i] = Math.round(region[i] * covg[i] / 255);
        P.fillSolid(px, w, h, c, region);
      });
    }
    return { layer: layerRow(l) };
  });

  // paint_stroke: brush and eraser paint colour or remove alpha; clone, heal, dodge, burn and sponge
  // retouch (src/select/retouch.js holds the formulas). Tool settings beyond the schema's fields go in
  // `source`: clone/heal {x, y, sample}, dodge/burn {range, exposure}, sponge {mode, amount}.
  // In quick mask, brush and eraser paint the selection instead of a layer.
  const SOURCE_KEYS = { brush: [], eraser: [], clone: ['x', 'y', 'sample'], heal: ['x', 'y', 'sample'], dodge: ['range', 'exposure'], burn: ['range', 'exposure'], sponge: ['mode', 'amount'] };
  const pick = (obj, key, allowed, def, tool) => { const v = obj?.[key] ?? def; if (!allowed.includes(v)) fail('invalid', `source.${key} must be one of ${allowed.join(', ')}`, 'fix_argument', tool); return v; };

  bus.register('paint.stroke', async (a) => {
    const TL = 'paint_stroke'; const doc = needDoc(ctx); const src = a.source;
    const keys = SOURCE_KEYS[a.tool];
    if (src) {
      const extra = Object.keys(src).filter((k) => !keys.includes(k));
      if (extra.length) fail('invalid', `source.${extra[0]} does not apply to ${a.tool}; ${a.tool} takes ${keys.length ? `source {${keys.join(', ')}}` : 'no source'}`, 'fix_argument', TL);
    }
    const opacity = a.opacity ?? 100; const hardness = a.hardness ?? 100; const flow = a.flow ?? 100;
    const brush = await resolveBrush(ctx, a);   // brush engine v2 (P26), null for the v1 round brush

    // Quick mask: the selection is the canvas being painted.
    if (qm?.on) {
      if (a.tool !== 'brush' && a.tool !== 'eraser') fail('unsupported', `quick mask is on: only brush and eraser paint, and they edit the selection; toggle quick mask off to use ${a.tool}`, 'change_target', 'refine_selection');
      const c = a.tool === 'brush' ? colour(a.color ?? '#ffffff', TL) : null;
      const pts = a.points.map(([x, y, ...dyn]) => [x, y, ...dyn]);
      const { coverage: S, stamps } = P.strokeCoverage(doc.width, doc.height, pts, Math.max(1, a.size ?? 20), hardness, flow, brush);
      const sel = rd().bufferData(qm.buffer).slice();
      RT.paintSelection(sel, S, c ? { value: Math.round(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]), alpha: c[3] / 255, opacity } : { value: 0, opacity });
      const out = await writeSelection(`quick mask ${a.tool}`, sel);
      return { stamps, quickMask: true, ...out };
    }

    let l = needLayer(ctx, a.layerId); let created = null;
    const retouch = a.tool === 'clone' || a.tool === 'heal';
    let sample = retouch ? pick(src, 'sample', ['layer', 'all'], 'layer', TL) : null;
    // RAW develop retouching (L36): clone and heal paint a transparent "retouch" raster layer kept just
    // above the photo (and its local adjustments), created on first use, sampling all visible layers.
    if (l.kind === 'raw' && retouch) {
      if (src?.sample === 'layer') fail('invalid', 'a RAW layer has no pixels to sample; clone and heal on a photo paint its retouch layer and sample all visible layers (omit source.sample or send "all")', 'fix_argument', TL);
      sample = 'all';
      const existing = doc.layers.find((x) => x.retouchOf === l.id);
      if (existing) l = needLayer(ctx, existing.id);
      else {
        const buffer = rd().newPixels(doc.width, doc.height);
        created = { raw: l, layer: makeLayer('raster', { name: `${l.name} · retouch`, buffer, width: doc.width, height: doc.height, retouchOf: l.id, ...(l.parentId ? { parentId: l.parentId } : {}) }) };
        l = created.layer;
      }
    }
    if (l.smart) fail('unsupported', `${l.name} is a smart object: painting would edit its cached pixels, which the next update replaces; paint on a new layer above it`, 'change_target', 'add_layer');
    if (l.kind !== 'raster') fail('unsupported', `${a.tool} paints raster layers${retouch ? ' (and RAW photos, through a retouch layer)' : ''}; ${l.name} is ${l.kind}`, 'change_target', 'add_layer');
    notVideo(l, a.tool);
    const { width: w, height: h } = rd().buffers.get(l.buffer);
    const M = shownMatrix(doc, l); const inv = invertAffine(M);
    const scale = Math.sqrt(Math.abs(inv[0] * inv[3] - inv[1] * inv[2]));
    const pts = a.points.map(([x, y, ...dyn]) => [...apply(inv, x, y), ...dyn]);   // dyn: pressure, tilt, time
    const size = Math.max(1, (a.size ?? 20) * scale);
    const { coverage: S, stamps } = P.strokeCoverage(w, h, pts, size, hardness, flow, brush);
    const covg = localCoverage(doc, l, w, h);
    const orig = rd().bufferData(l.buffer).slice();
    let run; let info = {};

    if (a.tool === 'brush' || a.tool === 'eraser') {
      const c = a.tool === 'brush' ? colour(a.color ?? '#000000', TL) : null;
      run = (px) => P.applyStroke(px, w, h, S, { colour: c, opacity, erase: a.tool === 'eraser' }, covg);
    } else if (a.tool === 'dodge' || a.tool === 'burn') {
      const o = { burn: a.tool === 'burn', range: pick(src, 'range', ['shadows', 'midtones', 'highlights'], 'midtones', TL), exposure: num(src, 'exposure', TL, { min: 0, max: 100, def: 50 }), opacity };
      run = (px) => RT.dodgeBurn(px, w, h, S, o, covg); info = { range: o.range, exposure: o.exposure };
    } else if (a.tool === 'sponge') {
      const o = { saturate: pick(src, 'mode', ['desaturate', 'saturate'], 'desaturate', TL) === 'saturate', amount: num(src, 'amount', TL, { min: 0, max: 100, def: 50 }), opacity };
      run = (px) => RT.sponge(px, w, h, S, o, covg); info = { mode: o.saturate ? 'saturate' : 'desaturate', amount: o.amount };
    } else {
      const spot = a.tool === 'heal' && (src?.x === undefined && src?.y === undefined);
      if (!spot && (!isNum(src?.x) || !isNum(src?.y))) fail('invalid', `${a.tool} needs source {x, y}: the document point the first stroke point copies from${a.tool === 'heal' ? ' (omit both for spot healing)' : ''}`, 'fix_argument', TL);
      // Aligned: the document offset source − first point stays fixed for the whole stroke. In layer-local
      // pixels it is the same vector through the inverse matrix's linear part.
      let ox = 0; let oy = 0;
      if (!spot) { const dx = src.x - a.points[0][0]; const dy = src.y - a.points[0][1]; ox = inv[0] * dx + inv[2] * dy; oy = inv[1] * dx + inv[3] * dy; }
      const box = RT.strokeBox(S, w, h, 0);
      if (!box) fail('invalid', 'the stroke does not touch the layer', 'fix_argument', TL);
      let at;   // (x, y) local continuous → premultiplied linear RGBA of the sampled image, or null
      if (sample === 'layer') at = (x, y) => RT.samplePremul(orig, w, h, x, y);
      else {
        // The composite of all visible layers (the quick-mask film excluded), rendered over the area the
        // stroke and its source cover, in document pixels.
        const reach = spot ? Math.ceil(2.2 * Math.max(box[2] - box[0], box[3] - box[1]) + Math.max(box[2] - box[0], box[3] - box[1]) / 2) + 8 : 0;
        const lx = [box[0] - 3 - reach, box[2] + 4 + reach, box[0] - 3 + ox, box[2] + 4 + ox];
        const ly = [box[1] - 3 - reach, box[3] + 4 + reach, box[1] - 3 + oy, box[3] + 4 + oy];
        const xs = []; const ys = [];
        for (const x of lx) for (const y of ly) { const [X, Y] = apply(M, x, y); xs.push(X); ys.push(Y); }
        const rect = [Math.max(0, Math.floor(Math.min(...xs))), Math.max(0, Math.floor(Math.min(...ys))), Math.min(doc.width, Math.ceil(Math.max(...xs))), Math.min(doc.height, Math.ceil(Math.max(...ys)))];
        if (rect[2] <= rect[0] || rect[3] <= rect[1]) fail('invalid', 'the source is outside the document', 'fix_argument', TL);
        const im = await rd().image8(0, rect);
        at = (x, y) => { const [X, Y] = apply(M, x, y); return RT.samplePremul(im.data, im.width, im.height, X - im.x, Y - im.y); };
      }
      if (spot) {
        const best = RT.spotSource(S, w, h, (i, j) => (i < 0 || j < 0 || i >= w || j >= h ? null : at(i + 0.5, j + 0.5)));
        if (!best) fail('invalid', 'spot healing found no source patch inside the image near the stroke; give source {x, y}', 'fix_argument', TL);
        ox = best.dx; oy = best.dy;
      }
      const srcAt = (i, j) => at(i + 0.5 + ox, j + 0.5 + oy);
      const dstAt = sample === 'layer' ? (i, j) => RT.premul(orig, (j * w + i) * 4) : (i, j) => at(i + 0.5, j + 0.5) ?? [0, 0, 0, 0];
      const [fx, fy] = [M[0] * ox + M[2] * oy, M[1] * ox + M[3] * oy];
      info = { sample, ...(spot ? { spot: true } : {}), sourceOffset: [Math.round(fx * 100) / 100, Math.round(fy * 100) / 100] };
      run = (px) => { const r = RT.retouchStroke(px, w, h, S, { src: srcAt, dst: dstAt, heal: a.tool === 'heal', opacity }, covg); info.painted = r.painted; };
    }

    const id = l.buffer;
    await change(ctx, a.tool, (d) => {
      if (created) {
        let at = d.layers.findIndex((x) => x.id === created.raw.id);
        while (at + 1 < d.layers.length && d.layers[at + 1].id.startsWith(`${created.raw.id}~`)) at++;
        d.layers.splice(at + 1, 0, created.layer);
      }
      const px = orig.slice(); run(px); rd().bufferIO.write(id, px);
    }, created ? [] : [id]);
    if (info.painted === 0) {   // nothing changed (e.g. the source lies outside the layer): leave no undo step
      ctx.store.rollback(); await ctx.sync();
      fail('invalid', 'the stroke changed no pixels; check the source point lies inside the layer', 'fix_argument', 'paint_stroke');
    }
    return { stamps, tool: a.tool, ...info, layer: layerRow(ctx.store.doc.layers.find((x) => x.id === l.id)), ...(created ? { retouchLayerCreated: true } : {}) };
  });

  bus.register('filter.apply', async (a) => {
    const T = 'apply_filter'; const doc = needDoc(ctx); const p = a.params || {};
    const { l, w, h } = rasterLayer(a, T);
    const covg = localCoverage(doc, l, w, h);
    let run;
    if (a.filter === 'gaussian-blur') { const r = num(p, 'radius', T, { min: 0, max: 250 }); run = (px) => P.gaussianBlur(px, w, h, r, covg); }
    else if (a.filter === 'unsharp-mask') {
      const o = { amount: num(p, 'amount', T, { min: 0, max: 500, def: 100 }), radius: num(p, 'radius', T, { min: 0.1, max: 250, def: 1 }), threshold: num(p, 'threshold', T, { min: 0, max: 255, def: 0 }) };
      run = (px) => P.unsharpMask(px, w, h, o, covg);
    } else if (a.filter === 'high-pass') { const r = num(p, 'radius', T, { min: 0.1, max: 250 }); run = (px) => P.highPass(px, w, h, r, covg); }
    else if (ARTISTIC[a.filter]) {   // artistic filters (src/select/artistic.js)
      const o = a.filter === 'posterise' ? { levels: num(p, 'levels', T, { min: 2, max: 64, def: 4 }) }
        : a.filter === 'halftone' ? { size: num(p, 'size', T, { min: 2, max: 128, def: 8 }), angle: num(p, 'angle', T, { min: -360, max: 360, def: 45 }), mode: p.mode === 'colour' ? 'colour' : 'mono' }
          : a.filter === 'watercolour' ? { radius: num(p, 'radius', T, { min: 1, max: 30, def: 4 }), strength: num(p, 'strength', T, { min: 0, max: 100, def: 50 }) }
            : { radius: num(p, 'radius', T, { min: 1, max: 30, def: a.filter === 'sketch' ? 6 : 4 }) };
      if (a.filter === 'halftone' && p.mode !== undefined && !['mono', 'colour'].includes(p.mode)) fail('invalid', "halftone mode is 'mono' or 'colour'", 'fix_argument', T);
      run = (px) => ARTISTIC[a.filter](px, w, h, o, covg);
    } else {
      const o = { amount: num(p, 'amount', T, { min: 0, max: 100, def: 10 }), monochromatic: !!p.monochromatic, seed: num(p, 'seed', T, { min: 0, def: 1 }) };
      run = (px) => P.addNoise(px, w, h, o, covg);
    }
    await editPixels(a.filter, l, run);
    return { layer: layerRow(l) };
  });
}

export const localId = (baseId, maskId) => `${baseId}~${String(maskId).replace(/[^A-Za-z0-9_-]/g, '_')}`;

// '#rrggbb' sRGB → Oklab (from linear sRGB, Björn Ottosson's matrices), for colour-range mask components.
export function hexToOklab(hex) {
  const lin = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  const [r, g, b] = lin;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
