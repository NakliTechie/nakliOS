// AI pixel commands (L22 denoise, L62 upscale, L37 remove, P42 expand, L68 restore; P61 neural filters
// are these same commands). Every command needs its model downloaded first (rule ④: the app works with
// none) and answers `unsupported`, naming the download, when it is absent. AI never overwrites authored
// pixels: each command writes a NEW raster layer above its source ("Denoised", "Removed", "Expanded",
// "Restored"), or, for the ×2 upscale, a new PNG file in the workspace (a person-confirmed write), so
// undo or deleting that layer gives the original back.
//
// ctx.aiPixels (optional, tests set it): { status(id), runImage(id, px, w, h, onTile), inpaintModel(id) }.
// Without it the handlers use src/ai/pixels-ort.js. ctx.aiProgress?(tool, done, total) reports tiles.

import { makeLayer } from '../document.js';
import { shiftAll } from './core.js';
import { alone, renderLayers } from '../files/layered.js';
import { encodePng, decodePng } from '../files/png.js';
import { imageEditRoute, imageEdit, editSquare } from '../ai/image-edit.js';
import { fileSafe } from '../files/workspace.js';
import { pixelModel } from '../ai/models-pixels.js';
import * as X from '../ai/pixels.js';
import { needDoc, needLayer, fail, change, layerRow, stageOrRun } from './util.js';

export const UPSCALE_MAX_PIXELS = 8_000_000;   // input cap for ×2: the output is held as floats while tiles blend
const PIXEL_KINDS = ['raw', 'image', 'raster'];

export function register(bus, ctx) {
  let ortP = null;
  const io = async () => ctx.aiPixels ?? (ortP ??= import('../ai/pixels-ort.js').then((o) => ({ status: o.pixelModelStatus, runImage: o.runImage, inpaintModel: o.inpaintModel })));
  const rd = () => { if (!ctx.renderer) fail('unsupported', 'this command needs the WebGPU engine, which did not start', 'get_state', 'get_capabilities'); return ctx.renderer; };

  async function needModel(id, tool) {
    const m = pixelModel(id);
    if ((await (await io()).status(id)) !== 'ready') fail('unsupported', `${tool} needs the on-device model "${m.label}" (${m.licence}, ${m.repo}); the person downloads it with Download in the AI tools panel (download_model ${id})`, 'use_ui_control', 'download_model');
    return m;
  }
  // Holds the engine while a model runs, so no other command changes the document under it.
  async function holding(tool, fn) {
    if (ctx.busy) fail('busy', `${ctx.busy} holds the engine`, 'get_job', 'get_job');
    ctx.busy = tool;
    try { return await fn((n, total) => ctx.aiProgress?.(tool, n, total)); } finally { ctx.busy = null; }
  }
  // A layer rendered alone at canvas size (develop, local adjustments and its mask applied, opacity 1,
  // normal blend), 8-bit sRGB straight alpha. The document is re-synced afterwards.
  async function renderAlone(doc, l) {
    const r = rd();
    try { const im = await renderLayers(r, doc, alone(doc, l, { includeLocals: true })); return new Uint8Array(im.data.buffer, im.data.byteOffset, im.data.byteLength); }
    finally { await r.sync(doc); }
  }
  async function composite(doc) {
    const im = await rd().image8(0);
    if (im.width !== doc.width || im.height !== doc.height) fail('outcome_unknown', 'the full-resolution render did not match the document size', 'get_state', 'get_state');
    return new Uint8Array(im.data.buffer, im.data.byteOffset, im.data.byteLength);
  }
  // Inserts a new doc-size raster layer just above l (and above l's local adjustments and retouch layer),
  // or at the top of the stack when l is null, and makes it active. One undo step.
  async function addResultLayer(tool, name, px, l, extra = {}) {
    const d = needDoc(ctx);
    const buffer = rd().newPixels(d.width, d.height, px);
    const layer = makeLayer('raster', { name, buffer, width: d.width, height: d.height, ...(l?.parentId ? { parentId: l.parentId } : {}), ...extra.props });
    await change(ctx, tool, (doc) => {
      extra.before?.(doc);
      let at = doc.layers.length - 1;
      if (l) { at = doc.layers.findIndex((x) => x.id === l.id); while (at + 1 < doc.layers.length && (doc.layers[at + 1].localOf === l.id || doc.layers[at + 1].retouchOf === l.id)) at++; }
      doc.layers.splice(at + 1, 0, layer); doc.activeLayerId = layer.id;
    });
    return layer;
  }
  const pixelLayer = (a, tool) => {
    const l = needLayer(ctx, a.layerId, { unlocked: false });
    if (!PIXEL_KINDS.includes(l.kind)) fail('unsupported', `${tool} works on a photo, image or raster layer; ${l.name} is ${l.kind}`, 'change_target', 'set_active');
    return l;
  };

  // L22 (and P61 "Noise reduction" / "JPEG artefact removal"): SCUNet blind real-world denoiser.
  //   out = src + (model(src) − src) · strength/100, alpha kept from the source.
  bus.register('ai.denoise', async (a) => {
    const T = 'ai_denoise'; const d = needDoc(ctx); const l = pixelLayer(a, T);
    const m = await needModel('scunet-denoise', T); const strength = (a.strength ?? 100) / 100;
    return holding(T, async (onTile) => {
      const src = await renderAlone(d, l);
      const out = await (await io()).runImage(m.id, src, d.width, d.height, onTile);
      const f = out.data; const px = new Uint8Array(d.width * d.height * 4);
      for (let p = 0; p < d.width * d.height; p++) {
        for (let c = 0; c < 3; c++) { const s = src[p * 4 + c] / 255; px[p * 4 + c] = Math.round(255 * Math.min(1, Math.max(0, s + (f[p * 3 + c] - s) * strength))); }
        px[p * 4 + 3] = src[p * 4 + 3];
      }
      const layer = await addResultLayer(T, 'Denoised', px, l);
      return { layer: layerRow(layer), source: l.id, model: m.id, strength: strength * 100, tiles: out.tiles };
    });
  });

  // L62 (and P61 "Super zoom"): Swin2SR ×2 of the visible composite, written as a new PNG file in the
  // workspace (as Lightroom's Super Resolution writes a new file). The composite's alpha is resized
  // bilinearly. Writing a file is irreversible, so it waits for the person unless they clicked it.
  bus.register('ai.upscale', async (a, { door }) => {
    const T = 'ai_upscale'; const d = needDoc(ctx); const s = ctx.storage();
    if (!s) fail('unsupported', 'no workspace storage to write the upscaled file to; grant a folder', 'use_ui_control', 'grant_folder');
    const m = await needModel('swin2sr-x2', T);
    if (d.width * d.height > UPSCALE_MAX_PIXELS) fail('unsupported', `the ×2 upscale takes up to ${UPSCALE_MAX_PIXELS / 1e6} MP; this document is ${(d.width * d.height / 1e6).toFixed(1)} MP. Crop it (crop_document) or export a smaller copy first`, 'change_target', 'crop_document');
    const path = (a.path || `exports/${fileSafe(d.title).replace(/\.(jpe?g|png|webp|avif|gif|tiff?|heic|psd|dng|cr2|cr3|nef|arw|raf|orf|rw2|atelier)$/i, '') || 'image'}-upscaled-x2.png`).replace(/^\/+/, '');
    if (!/\.png$/i.test(path)) fail('invalid', 'path must end in .png', 'fix_argument', T);
    const replaces = await s.exists(path);
    return stageOrRun(ctx, { door }, T, `${replaces ? 'REPLACE' : 'write'} ${path}: "${d.title}" upscaled ×2 to ${d.width * 2} × ${d.height * 2} by ${m.label}`, () => holding(T, async (onTile) => {
      const doc = needDoc(ctx);
      const src = await composite(doc);
      const out = await (await io()).runImage(m.id, src, doc.width, doc.height, onTile);
      const al = new Float32Array(doc.width * doc.height); for (let p = 0; p < al.length; p++) al[p] = src[p * 4 + 3] / 255;
      const A = X.resizeBilinear(al, doc.width, doc.height, 1, out.w, out.h);
      const bytes = await encodePng(X.floatToRgba(out.data, out.w, out.h, Uint8Array.from(A, (v) => Math.round(255 * v))), out.w, out.h, 4);
      await s.write(path, bytes);
      return { path, width: out.w, height: out.h, bytes: bytes.length, model: m.id, replaced: replaces };
    }), { force: replaces });
  });

  // L37 (and P42 prompt-free "generative fill"): LaMa fills the current selection from the visible
  // composite. The result is a "Removed" layer at the top of the stack: the fill inside the selection
  // grown by 3 px and feathered by 2 px (softMask), transparent elsewhere.
  bus.register('ai.remove', async (a) => {
    const T = 'ai_remove'; const d = needDoc(ctx);
    if (!d.selection) fail('invalid', 'select what to remove first (set_selection, or an AI mask), then call ai_remove', 'change_target', 'set_selection');
    const m = await needModel('lama-inpaint', T);
    const hole = rd().bufferData(d.selection.buffer).slice();
    if (!X.maskBox(hole, d.width, d.height)) fail('invalid', 'the selection is empty', 'change_target', 'set_selection');
    return holding(T, async (onTile) => {
      const px = await composite(d);
      const r = await removeFill(m.id, px, hole, d.width, d.height, onTile);
      const layer = await addResultLayer(T, 'Removed', r.layer, null);
      return { layer: layerRow(layer), model: m.id, region: { x: r.region.x, y: r.region.y, width: r.region.w, height: r.region.h }, workingScale: Math.round(r.region.scale * 1000) / 1000 };
    });
  });

  async function removeFill(id, px, hole, W, H, onTile, { maxWork = 512, grow = 3, feather = 2 } = {}) {
    const box = X.maskBox(hole, W, H);
    const region = X.inpaintRegion(box, W, H, { maxWork });
    const img = X.rgbaToFloat(px, W, H);
    const fill = await X.inpaint(img, hole, W, H, region, await (await io()).inpaintModel(id), { onTile });
    const alpha = X.softMask(hole, W, H, grow, feather);
    return { region, fill, layer: X.patchLayer(fill, region, alpha, W, H) };
  }

  // P42 text-prompted generative fill through the person's own image-edit endpoint (BYOK, off by default):
  // a square around the selection (editSquare) is sent at 1,024 px with a mask transparent over the
  // selection; the reply is resized back and kept inside the selection grown 3 px and feathered 2 px, as a
  // "Generated (edited)" layer at the top. Without a configured endpoint and image model: unsupported.
  // The crop leaves the device for the person's own endpoint, so a call from any door other than their own click
  // (window, modelContext, a plugin) is staged for them to confirm, as ai_describe is (src/handlers/assist.js).
  bus.register('ai.fill', async (a, { door } = {}) => {
    const T = 'ai_generative_fill'; const d = needDoc(ctx);
    const route = ctx.imageEditRoute ? ctx.imageEditRoute() : imageEditRoute();
    if (!route) fail('unsupported', 'text-prompted fill needs your own image-edit endpoint: turn on your own key in AI settings (endpoint and key) and set an image model in the AI pixel tools panel; prompt-free fill is ai_remove', 'use_ui_control', 'ai_settings');
    if (!d.selection) fail('invalid', 'select the area to fill first (set_selection)', 'change_target', 'set_selection');
    const hole = rd().bufferData(d.selection.buffer).slice();
    const box = X.maskBox(hole, d.width, d.height);
    if (!box) fail('invalid', 'the selection is empty', 'change_target', 'set_selection');
    const sq0 = editSquare(box, d.width, d.height);
    return stageOrRun(ctx, { door }, T, `send a ${sq0.w} × ${sq0.h} px crop of "${d.title}" and its selection mask, with the prompt "${String(a.prompt).slice(0, 200)}", to your own image endpoint (${route.label})`, () => holding(T, async () => {
      const W = d.width; const H = d.height; const px = await composite(d); const sq = editSquare(box, W, H); const S = 1024;
      const crop = new Float32Array(sq.w * sq.h * 3); const cm = new Float32Array(sq.w * sq.h);
      for (let j = 0; j < sq.h; j++) for (let i = 0; i < sq.w; i++) { const P = (sq.y + j) * W + sq.x + i; const q = j * sq.w + i; for (let c = 0; c < 3; c++) crop[q * 3 + c] = px[P * 4 + c] / 255; cm[q] = hole[P] > 0 ? 1 : 0; }
      const img = X.floatToRgba(X.resizeBilinear(crop, sq.w, sq.h, 3, S, S), S, S);
      const mk = X.resizeBilinear(cm, sq.w, sq.h, 1, S, S); const mask = new Uint8Array(S * S * 4);
      for (let q = 0; q < S * S; q++) mask[q * 4 + 3] = mk[q] > 0.01 ? 0 : 255;   // transparent = may paint
      const bytes = await imageEdit(route, { prompt: a.prompt, image: await encodePng(img, S, S, 4), mask: await encodePng(mask, S, S, 4), size: S }, { fetchFn: ctx.fetch ?? ((...x) => fetch(...x)) });
      const out = await decodeImage(bytes);
      const f = new Float32Array(out.width * out.height * 3); for (let q = 0; q < out.width * out.height; q++) for (let c = 0; c < 3; c++) f[q * 3 + c] = out.data[q * out.channels + c] / 255;
      const fill = X.resizeBilinear(f, out.width, out.height, 3, sq.w, sq.h);
      const layerPx = X.patchLayer(fill, sq, X.softMask(hole, W, H), W, H);
      const layer = await addResultLayer(T, 'Generated (edited)', layerPx, null, { props: { aiEdit: `generative fill via ${route.label}` } });
      return { layer: layerRow(layer), route: route.label, sent: { x: sq.x, y: sq.y, width: sq.w, height: sq.h, size: S } };
    }));
  });
  async function decodeImage(bytes) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return decodePng(bytes);
    const b = await createImageBitmap(new Blob([bytes])); const c = new OffscreenCanvas(b.width, b.height).getContext('2d'); c.drawImage(b, 0, 0);
    return { width: b.width, height: b.height, channels: 4, data: c.getImageData(0, 0, b.width, b.height).data };
  }

  // P42 generative expand (prompt-free): the canvas grows by `percent` on each named side's axis, the
  // layers keep their place, and LaMa fills the new border from the composite. The fill runs at a working
  // scale of at most 1,024 px on the long side, so the extension is softer than the photo on a large
  // canvas. Result: an "Expanded" layer at the top of the stack, opaque in the new border only.
  bus.register('ai.expand', async (a) => {
    const T = 'ai_expand'; const d = needDoc(ctx);
    const m = await needModel('lama-inpaint', T);
    const pct = a.percent ?? 25; const sides = a.sides ?? ['top', 'right', 'bottom', 'left'];
    const mg = X.expandMargins(d.width, d.height, pct, sides);
    if (!(mg.top + mg.right + mg.bottom + mg.left)) fail('invalid', 'the expansion rounds to 0 px; raise percent', 'fix_argument', T);
    const W = d.width + mg.left + mg.right; const H = d.height + mg.top + mg.bottom;
    if (W > 65535 || H > 65535) fail('invalid', 'the expanded canvas would exceed 65,535 px', 'fix_argument', T);
    return holding(T, async (onTile) => {
      const px = await composite(d);
      const { img, hole } = X.padCanvas(px, d.width, d.height, mg);
      const region = { x: 0, y: 0, w: W, h: H, scale: Math.min(1, 1024 / Math.max(W, H)) };
      region.workW = Math.max(1, Math.round(W * region.scale)); region.workH = Math.max(1, Math.round(H * region.scale));
      const fill = await X.inpaint(img, hole, W, H, region, await (await io()).inpaintModel(m.id), { onTile });
      const alpha = Float32Array.from(hole, (v) => v / 255);
      const out = X.patchLayer(fill, region, alpha, W, H);
      // The new layer is made at the new size; the canvas change and the layer land in one undo step.
      const buffer = rd().newPixels(W, H, out);
      const layer = makeLayer('raster', { name: `Expanded ${pct}%`, buffer, width: W, height: H });
      await change(ctx, T, (doc) => { shiftAll(doc, mg.left, mg.top); doc.width = W; doc.height = H; doc.layers.push(layer); doc.activeLayerId = layer.id; });
      return { layer: layerRow(layer), model: m.id, document: { width: W, height: H }, margins: mg, workingScale: Math.round(region.scale * 1000) / 1000 };
    });
  });

  // L68 restoration of a scanned print: faded colour (classical per-channel levels, restoreFade) and
  // dust and scratches (classical detection, detectDefects, filled by LaMa at full resolution, so only
  // the 512 px windows that hold a defect run). Result: a "Restored" layer above the source. Fade alone
  // needs no model.
  bus.register('ai.restore', async (a) => {
    const T = 'ai_restore'; const d = needDoc(ctx); const l = pixelLayer(a, T);
    const doDust = a.dust ?? true; const doFade = a.fade ?? true;
    if (!doDust && !doFade) fail('invalid', 'turn on dust or fade (or both)', 'fix_argument', T);
    const m = doDust ? await needModel('lama-inpaint', T) : null;
    return holding(T, async (onTile) => {
      let px = await renderAlone(d, l);
      const info = { source: l.id };
      if (doFade) { const f = X.restoreFade(px, d.width, d.height, { amount: a.fadeAmount ?? 100 }); px = f.px; info.fade = { lo: f.lo, hi: f.hi }; }
      if (doDust) {
        const { mask, count } = X.detectDefects(px, d.width, d.height, { sensitivity: a.sensitivity ?? 50 });
        info.defectPixels = count;
        if (count) {
          const box = X.maskBox(mask, d.width, d.height);
          const region = { ...box, scale: 1, workW: box.w, workH: box.h };
          // Context: widen the box by one window so edge defects see their surroundings.
          const pad = 64; region.x = Math.max(0, box.x - pad); region.y = Math.max(0, box.y - pad);
          region.w = region.workW = Math.min(d.width, box.x + box.w + pad) - region.x; region.h = region.workH = Math.min(d.height, box.y + box.h + pad) - region.y;
          const fill = await X.inpaint(X.rgbaToFloat(px, d.width, d.height), mask, d.width, d.height, region, await (await io()).inpaintModel(m.id), { onTile });
          const alpha = X.softMask(mask, d.width, d.height, 0, 1);
          for (let j = 0; j < region.h; j++) for (let i = 0; i < region.w; i++) {
            const P = (region.y + j) * d.width + region.x + i; const t = alpha[P]; if (!(t > 0)) continue;
            const q = (j * region.w + i) * 3;
            for (let c = 0; c < 3; c++) px[P * 4 + c] = Math.round(px[P * 4 + c] * (1 - t) + 255 * Math.min(1, Math.max(0, fill[q + c])) * t);
          }
          info.model = m.id;
        }
      }
      const layer = await addResultLayer(T, 'Restored', px, l);
      return { layer: layerRow(layer), ...info };
    });
  });
}
