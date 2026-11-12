// AI mask, AI selection, depth, edge refine and model commands (spec 002 §4.1, §4.8, §9.4; matrix L34, P18, L33,
// L53, L69, P20).
// Every AI command runs an on-device model the person downloaded (src/ai/runtime.js); with no model the
// command answers `unsupported` and names the download. AI masks are computed from the unedited photo (the
// layer's source at default develop settings) and become a new bitmap mask component the person can delete;
// AI never edits an existing component. AI selection reads the composite, as Photoshop's Select Subject does.
// The depth map is written once beside the photo as <photo>.depth.png (disparity, 255 nearest) and feeds lens
// blur and depth-range masks; the renderer loads it from there, so it survives a reload.
//
// The host route (§9.4): NakliOS offers no segmentation or depth capability today, so every task uses
// Atelier's own model; list_models reports what the host offers so a later host capability can take over.

import * as rt from '../ai/runtime.js';
import { modelById, MASK_TARGETS, MATTING_MODEL } from '../ai/registry.js';
import { stretch, stretchRGBA, coverage, targetPlane, SEMANTIC_GROUPS, docToSource, guidedRefine, roughFrom, imageKey, trimapFrom, unknownBox, crop, trimapMatte } from '../ai/masks.js';
import * as R from '../select/raster.js';
import { encodePng } from '../files/png.js';
import { MASK_KINDS } from '../../vendor/tessella/src/model.js';
import { MAX_MASK } from '../../vendor/tessella/src/shaders.js';
import { localId } from './select.js';
import { needDoc, needLayer, fail, change, layerRow, stageOrRun } from './util.js';

const MODEL_EDGE = 1024;      // at most this long edge reaches a model (DETR resizes to 800 short edge, SAM to 1024 long edge)
const REFINE_EDGE = 2048;     // the long edge smart selection and refine_edge work at
const MATTE_EDGE = 1024;      // at most this long edge of the edge band's box reaches the matting model
const CACHE_SIZE = 4;         // model answers kept per image (people and sky share one DETR call; subject and background one IS-Net call)
export const depthPath = (file) => `${file}.depth.png`;
// Where a layer's depth map lives: beside its photo file, or, for a linear float source with no file (an HDR
// merge result, src/files/linear.js), under library/depth/ named by document and buffer, which both persist.
export const depthPathFor = (doc, l) => (l.file ? depthPath(l.file) : l.buffer ? `library/depth/${doc.id}-${l.buffer}.depth.png` : null);
// The smallest level of detail (each level halves) whose long edge is at most maxEdge; the engine has levels 0..5.
const lodAtMost = (d, maxEdge) => Math.min(5, Math.max(0, Math.ceil(Math.log2(Math.max(d.width, d.height) / maxEdge))));
const LABEL_NAMES = { LABEL_184: 'tree-merged', LABEL_187: 'sky-other-merged' };

export function register(bus, ctx) {
  const run = ctx.aiRuntime ?? rt;   // tests inject a fake runtime
  if (!ctx.aiRuntime) rt.configure({ storage: () => ctx.storage() });
  const rd = () => ctx.renderer;
  // A model run takes seconds; a command that read the document before it (a mask's components, the selection)
  // answers stale when the document changed meanwhile, so it never writes over an edit made while it waited.
  const unchanged = (rev0, tool) => { if (bus.state.revision !== rev0) fail('stale', `the document changed while ${tool} ran (revision ${rev0} → ${bus.state.revision}); nothing applied, call it again`, 'retry_with_revision', 'get_state'); };
  const hostOffers = () => { const c = globalThis.naklios?.capabilities || {}; return { segmentation: !!c.segmentation, depth: !!c.depth }; };

  // The model for a target, ready to run; otherwise `unsupported` naming the download.
  async function modelFor(target, tool) {
    const id = target === 'matting' ? MATTING_MODEL : MASK_TARGETS[target];
    if (!id) fail('invalid', `unknown target ${target}; targets: ${Object.keys(MASK_TARGETS).join(', ')}`, 'fix_argument', tool);
    const m = modelById(id);
    let st = run.modelStatus(id);
    if (st === 'absent') { await run.refresh(); st = run.modelStatus(id); }   // the consent record may not have been read yet
    if (st !== 'ready') fail('unsupported', `${target} needs the on-device model "${m.label}" (${m.licence}), which is ${st}; the person downloads it in the AI panel (download_model ${id})`, 'use_ui_control', 'download_model');
    return m;
  }
  async function infer(m, task, input) {
    try { return await run.runModel(m.id, task, input); }
    catch (e) { fail(e.code === 'not_consented' || e.code === 'absent' ? 'unsupported' : 'outcome_unknown', `${m.label}: ${e.message}`, e.code === 'not_consented' || e.code === 'absent' ? 'use_ui_control' : 'get_state', e.code === 'not_consented' || e.code === 'absent' ? 'download_model' : 'list_models'); }
  }

  // The unedited photo of a RAW or image layer (default develop, no masks, no lens blur), as 8-bit sRGB RGBA
  // with its long edge near maxEdge. The engine renders a one-layer document of the source, then the real
  // document is synced back.
  async function sourceImage(l, maxEdge = MODEL_EDGE) {
    const s = await rd().sourceSize(l);
    const temp = { id: '__ai', width: s.width, height: s.height, blendSpace: 'compatible',
      layers: [{ id: '__ai-src', kind: l.kind, ...(l.file ? { file: l.file } : { buffer: l.buffer }), name: 'source', matrix: [1, 0, 0, 1, 0, 0], opacity: 1, fill: 1, blend: 'normal', visible: true, mask: null, ...(l.kind === 'raw' ? { develop: {} } : {}) }] };
    let im;
    try { await rd().sync(temp); im = await rd().image8(lodAtMost(temp, maxEdge)); }
    finally { await ctx.sync(); }
    return { image: { width: im.width, height: im.height, data: new Uint8ClampedArray(im.data) }, srcW: s.width, srcH: s.height };
  }
  async function compositeImage(doc, maxEdge = MODEL_EDGE) {
    const im = await rd().image8(lodAtMost(doc, maxEdge), null, 1);
    return { width: im.width, height: im.height, data: new Uint8ClampedArray(im.data) };
  }

  // Answers of the semantic (DETR) and salient (IS-Net) models by model and image content, newest last, so the
  // four masks of one photo cost two inferences at most. The click-driven object model is never cached.
  const answers = new Map();
  async function cachedInfer(m, task, input) {
    const key = `${m.id}|${imageKey(input.image)}`;
    if (answers.has(key)) { const r = answers.get(key); answers.delete(key); answers.set(key, r); return { ...r, cached: true }; }
    const r = await infer(m, task, input);
    answers.set(key, r); while (answers.size > CACHE_SIZE) answers.delete(answers.keys().next().value);
    return r;
  }

  // Runs one target on an image; point: [x, y] in that image's full-size grid (fullW × fullH). → 8-bit plane at the model's grid.
  async function targetMask(target, m, image, point, fullW, fullH, tool) {
    const input = { image };
    if (target === 'object') {
      if (!point) fail('invalid', 'target object needs point: [x, y], the click on the object in document pixels', 'fix_argument', tool);
      input.points = [[point[0] * image.width / fullW, point[1] * image.height / fullH]];
    }
    const task = m.task;
    if (task === 'semantic') input.groups = SEMANTIC_GROUPS;
    const res = task === 'semantic' || task === 'salient' ? await cachedInfer(m, task, input) : await infer(m, task, input);
    const extra = { ...(res.cached ? { cached: true } : {}) };
    if (res.labels) extra.labels = res.labels.filter((x) => x.groups.includes(target)).map((x) => LABEL_NAMES[x.label] ?? x.label);
    if (res.score != null) extra.score = res.score;
    return { plane: targetPlane(target, res), w: res.width, h: res.height, extra };
  }

  // ---- models ----
  bus.register('model.list', async () => {
    await run.refresh();
    return { models: run.listModels(), host: hostOffers(), route: 'own on-device models (the host offers no segmentation or depth)', targets: MASK_TARGETS };
  });
  // download_model is person-only: the bus answers person_only to every door, so only the AI panel's
  // Download button reaches the runtime. This handler is the same act for completeness.
  bus.register('model.download', async (a) => {
    if (!modelById(a.model)) fail('invalid', `no model ${a.model}`, 'fix_argument', 'list_models');
    return run.downloadModel(a.model);
  });
  // Removing deletes downloaded weights (irreversible: getting them back is a new download), so a call from any
  // door other than the person's own click waits for them to confirm.
  bus.register('model.remove', async (a, opts) => {
    const m = modelById(a.model);
    if (!m) fail('invalid', `no model ${a.model}`, 'fix_argument', 'list_models');
    opts?.viewOnly?.();   // the document does not change
    return stageOrRun(ctx, { door: opts?.door }, 'remove_model', `delete the downloaded model "${m.label}" (${m.id}) from this browser; using it again needs a new download`, async () => {
      const r = await run.removeModel(a.model);
      return { model: a.model, status: r.status, deletedEntries: r.deleted.length };
    });
  });

  // ---- AI mask on a layer (L34; depth-range for L33) ----
  bus.register('ai.mask', async (a) => {
    const T = 'ai_mask'; const doc = needDoc(ctx); const rev0 = bus.state.revision;
    const base = needLayer(ctx, a.layerId);
    if (base.kind !== 'raw' && base.kind !== 'image') fail('unsupported', `AI masks read a photo's unedited pixels; ${base.name} is a ${base.kind} layer`, 'change_target', 'get_state');
    const op = a.op ?? 'add';
    let l = base; let createLocal = null; let maskId = null;
    if (base.kind === 'raw') {
      maskId = a.maskId ?? (() => { for (let i = 1; ; i++) { const id = `${a.target}-${i}`; if (!doc.layers.some((x) => x.id === localId(base.id, id))) return id; } })();
      const lid = localId(base.id, maskId);
      l = doc.layers.find((x) => x.id === lid) || null;
      if (!l) { createLocal = { ...structuredClone(base), id: lid, name: `${base.name} · ${maskId}`, localOf: base.id, localDelta: {}, mask: null }; l = createLocal; }
    } else if (a.maskId) fail('invalid', 'maskId names a local adjustment and needs a RAW layer; an image layer has one mask, so omit maskId', 'fix_argument', T);
    const comps = l.mask?.components || [];
    if (comps.length >= MAX_MASK) fail('unsupported', `the mask already has ${MAX_MASK} components`, 'change_target', 'set_mask');

    let comp; let info = {};
    if (a.target === 'depth-range') {
      if (!MASK_KINDS.includes('depth')) fail('unsupported', 'depth-range masks wait for the engine depth mask component', 'change_target', 'get_capabilities');
      const p = [a.near, a.far, a.feather ?? 0.05];
      if (!p.every((v) => typeof v === 'number' && v >= 0 && v <= 1)) fail('invalid', 'depth-range needs near and far (and optional feather) in 0..1 of the depth map (1 nearest)', 'fix_argument', T);
      if (comps.some((c) => c.kind === 'depth')) fail('invalid', `${l.name}'s mask already has a depth range (one per mask)`, 'fix_argument', T);
      const d = await ensureDepth(base, false, T);
      comp = { op, kind: 'depth', depthFile: d.path, p0: [p[0], p[1], p[2], 0], ai: 'depth-range' };
      info = { depthFile: d.path, depthComputed: d.computed };
    } else {
      if (comps.some((c) => c.kind === 'bitmap')) fail('invalid', `${l.name}'s mask already has a bitmap component (one per mask); ${base.kind === 'raw' ? 'give a new maskId' : 'add the AI mask to a selection with ai_select instead'}`, 'fix_argument', T);
      const m = await modelFor(a.target, T);
      const { image, srcW, srcH } = await sourceImage(base);
      const pt = a.point ? docToSource(base.matrix, a.point) : null;
      if (pt && (pt[0] < 0 || pt[1] < 0 || pt[0] > srcW || pt[1] > srcH)) fail('invalid', 'point lies outside the photo', 'fix_argument', T);
      const out = await targetMask(a.target, m, image, pt, srcW, srcH, T);
      const data = stretch(out.plane, out.w, out.h, srcW, srcH);
      const id = rd().newMask(srcW, srcH); rd().bufferIO.write(id, data);
      comp = { op, kind: 'bitmap', bitmap: id, ai: a.target };
      info = { model: m.id, coverage: Math.round(coverage(data) * 10000) / 10000, modelInput: [image.width, image.height], ...out.extra };
    }
    unchanged(rev0, T);
    // The new component joins the live mask, as it is when the change applies.
    await change(ctx, `AI mask ${a.target}`, (d) => {
      if (createLocal && !d.layers.some((y) => y.id === createLocal.id)) d.layers.splice(d.layers.findIndex((x) => x.id === base.id) + 1, 0, createLocal);
      const x = d.layers.find((y) => y.id === l.id);
      const live = x.mask;
      x.mask = { components: [...(live?.components || []), comp], invert: !!live?.invert, ...(live?.density != null ? { density: live.density } : {}) };
    });
    return { target: a.target, ...info, layer: layerRow(ctx.store.doc.layers.find((x) => x.id === l.id)), ...(maskId ? { maskId, localLayerId: l.id } : {}) };
  });

  // ---- AI selection on the composite (P18) ----
  bus.register('ai.select', async (a) => {
    const T = 'ai_select'; const doc = needDoc(ctx); const rev0 = bus.state.revision;
    if (a.target === 'depth' || a.target === 'depth-range') fail('invalid', 'select by depth with ai_mask target depth-range', 'fix_argument', 'ai_mask');
    const m = await modelFor(a.target, T);
    if (a.point && (a.point[0] < 0 || a.point[1] < 0 || a.point[0] > doc.width || a.point[1] > doc.height)) fail('invalid', 'point lies outside the document', 'fix_argument', T);
    const image = await compositeImage(doc);
    const out = await targetMask(a.target, m, image, a.point, doc.width, doc.height, T);
    const data = stretch(out.plane, out.w, out.h, doc.width, doc.height);
    unchanged(rev0, T);
    const sel = await writeSelection(`AI select ${a.target}`, R.combine(doc.selection ? rd().bufferData(doc.selection.buffer) : null, data, a.op ?? 'replace'));
    return { target: a.target, model: m.id, coverage: Math.round(coverage(data) * 10000) / 10000, ...out.extra, ...sel };
  });

  // Same rule as set_selection: the selection is one document-size 8-bit buffer (quick mask paints it too).
  async function writeSelection(label, data) {
    const doc = needDoc(ctx);
    const b = R.bounds(data, doc.width, doc.height);
    const existing = doc.selection?.buffer ?? ctx.quickMask?.buffer ?? null;
    const buf = existing ?? rd().newMask(doc.width, doc.height);
    await change(ctx, label, (d) => { rd().bufferIO.write(buf, data); d.selection = b ? { buffer: buf, bounds: b } : null; }, existing ? [existing] : []);
    return { selection: b ? { bounds: b } : null };
  }

  // ---- depth map (L53 lens blur source, L33) ----
  // Writes <photo>.depth.png once (again with recompute) and returns its path.
  async function ensureDepth(l, recompute, tool) {
    const path = depthPathFor(needDoc(ctx), l);
    if (!path) fail('unsupported', 'a depth map needs a photo file or a linear float source', 'change_target', 'get_state');
    const s = ctx.storage(); if (!s) fail('unsupported', 'no storage for the depth map', 'use_ui_control', 'grant_folder');
    if (!recompute && (await s.exists(path))) return { path, computed: false };
    const m = await modelFor('depth', tool);
    const { image } = await sourceImage(l);
    const res = await infer(m, 'depth', { image });
    await s.write(path, await encodePng(res.depth, res.width, res.height, 1));
    rd().dropDepth?.(path);
    return { path, computed: true, size: [res.width, res.height], model: m.id };
  }

  bus.register('ai.depth', async (a) => {
    const T = 'ai_depth';
    const l = needLayer(ctx, a.layerId);
    if (l.kind !== 'raw' && l.kind !== 'image') fail('unsupported', 'a depth map is made for RAW and image layers', 'change_target', 'get_state');
    if (l.quad) fail('unsupported', 'lens blur on a perspective (corners) layer is not built yet', 'change_target', 'transform_layer');
    if (a.focus !== undefined && a.focusPoint) fail('invalid', 'give focus or focusPoint, not both', 'fix_argument', T);
    const lensBlur = a.lensBlur !== false;
    if (lensBlur && a.aperture === undefined && l.lensBlur?.aperture === undefined) fail('invalid', 'aperture is required the first time lens blur is turned on (or send lensBlur: false to make only the depth map)', 'fix_argument', T);
    const d = await ensureDepth(l, !!a.recompute, T);
    if (lensBlur) {
      await change(ctx, 'lens blur depth from model', (doc) => {
        const x = doc.layers.find((y) => y.id === l.id);
        const n = { ...(x.lensBlur || {}), depth: { file: d.path, model: MASK_TARGETS.depth } };
        for (const k of ['aperture', 'maxRadius']) if (a[k] !== undefined) n[k] = a[k];
        if (a.focusPoint) { n.focusPoint = a.focusPoint; delete n.focus; }
        if (a.focus !== undefined) { n.focus = a.focus; delete n.focusPoint; }
        x.lensBlur = n;
      });
    }
    return { depthFile: d.path, computed: d.computed, ...(d.size ? { size: d.size } : {}), lensBlur: ctx.store.doc.layers.find((y) => y.id === l.id).lensBlur ?? null };
  });

  // ---- smart selection from a rough outline (L69, classical) ----
  bus.register('ai.smart-select', async (a) => {
    const T = 'smart_select'; const doc = needDoc(ctx); const W = doc.width; const H = doc.height; const rev0 = bus.state.revision;
    const cur = doc.selection ? rd().bufferData(doc.selection.buffer) : null;
    if (!a.outline && !cur) fail('invalid', 'give outline (a rough polygon in document pixels) or make a rough selection first', 'fix_argument', T);
    const im = await compositeImage(doc, REFINE_EDGE);
    const k = im.width / W;
    const rough = a.outline ? roughFrom({ outline: a.outline.map(([x, y]) => [x * k, y * k]) }, im.width, im.height) : stretch(cur, W, H, im.width, im.height);
    const band = a.band ?? 8;
    const r = guidedRefine(rough, im.data, im.width, im.height, { band: band * k, radius: Math.max(2, Math.round((a.radius ?? 8) * k)), eps: a.eps ?? 1e-3 });
    const full = stretch(r.mask, im.width, im.height, W, H);
    unchanged(rev0, T);
    const sel = await writeSelection('smart selection', R.combine(a.outline ? cur : null, full, a.outline ? (a.op ?? 'replace') : 'replace'));
    return { refinedPixels: r.band, scale: Math.round(k * 10000) / 10000, coverage: Math.round(coverage(full) * 10000) / 10000, ...sel };
  });

  // ---- select and mask: refine the selection's edge into a soft matte (P20) ----
  // A trimap from the current selection (band px either side of its edge is unknown), then the unknown band is
  // solved by the matting model when the person downloaded it (ViTMatte, good on hair) or classically: local
  // foreground and background colour estimates cleaned by a colour guided filter (trimapMatte, src/ai/masks.js). Pixels outside the band keep their selection values exactly.
  bus.register('ai.refine-edge', async (a) => {
    const T = 'refine_edge'; const doc = needDoc(ctx); const W = doc.width; const H = doc.height; const rev0 = bus.state.revision;
    if (!doc.selection) fail('invalid', 'make a selection first (ai_select, smart_select or set_selection); refine_edge refines its edge', 'change_target', 'ai_select');
    const method = a.method ?? 'auto';
    let m = null;
    if (method === 'model') m = await modelFor('matting', T);
    else if (method === 'auto') { if (run.modelStatus(MATTING_MODEL) === 'absent') await run.refresh(); if (run.modelStatus(MATTING_MODEL) === 'ready') m = modelById(MATTING_MODEL); }
    const cur = rd().bufferData(doc.selection.buffer);
    const im = await compositeImage(doc, REFINE_EDGE); const w = im.width; const h = im.height; const k = w / W;
    const sel = stretch(cur, W, H, w, h);
    const band = Math.max(1, Math.round((a.band ?? 12) * k));
    const { trimap, unknown } = trimapFrom(sel, w, h, band);
    const box = unknownBox(trimap, w, h, band);
    if (!box) fail('invalid', 'the selection has no edge inside the document to refine', 'change_target', 'set_selection');
    const triC = crop(trimap, w, 1, box); const rgbaC = crop(im.data, w, 4, box); const selC = crop(sel, w, 1, box);
    let alphaC; let modelInput = null;
    if (m) {
      const s = Math.min(1, MATTE_EDGE / Math.max(box.w, box.h)); const mw = Math.max(1, Math.round(box.w * s)); const mh = Math.max(1, Math.round(box.h * s));
      // A resampled trimap is requantised to its three levels (above 2/3 foreground, below 1/3 background).
      const triM = stretch(triC, box.w, box.h, mw, mh).map((v) => (v >= 170 ? 255 : v <= 85 ? 0 : 128));
      const res = await infer(m, 'matting', { image: { width: mw, height: mh, data: stretchRGBA(rgbaC, box.w, box.h, mw, mh) }, trimap: triM });
      alphaC = stretch(res.alpha, res.width, res.height, box.w, box.h);
      modelInput = [mw, mh];
    } else alphaC = trimapMatte(triC, selC, rgbaC, box.w, box.h, { band, radius: Math.max(1, Math.round((a.radius ?? 2) * k)), eps: a.eps ?? 1e-3 });
    // Back to the working grid (refined values in the band only), then to the document grid.
    const work = sel.slice(); const unk = new Uint8Array(w * h);
    for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
      const j = y * box.w + x; if (triC[j] !== 128) continue;
      const i = (box.y + y) * w + box.x + x; work[i] = alphaC[j]; unk[i] = 255;
    }
    const full = stretch(work, w, h, W, H); const unkFull = stretch(unk, w, h, W, H);
    const out = cur.slice(); let soft = 0;
    for (let i = 0; i < out.length; i++) if (unkFull[i] >= 128) { out[i] = full[i]; if (out[i] > 0 && out[i] < 255) soft++; }
    unchanged(rev0, T);
    const sl = await writeSelection('refine edge', out);
    return { method: m ? 'model' : 'classical', ...(m ? { model: m.id, modelInput } : {}), bandPx: a.band ?? 12, unknownPixels: Math.round(unknown / (k * k)), softPixels: soft, scale: Math.round(k * 10000) / 10000, coverage: Math.round(coverage(out) * 10000) / 10000, ...sl };
  });
}
