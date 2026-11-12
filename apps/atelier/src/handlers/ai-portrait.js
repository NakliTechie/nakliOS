// P61 neural filters, the portrait and colour set. Each command writes ONE new raster layer just above its
// source layer and leaves the photo's pixels alone, so deleting the layer (or undo) removes the filter, and its
// opacity sets the strength afterwards. One model or one named method per filter:
//   ai_smooth_skin     skin mask from the MediaPipe selfie multiclass model + frequency separation
//                      (src/ai/portrait.js smoothSkin) → "Skin smoothing (edited)", alpha = skin mask.
//   colour_transfer    classical: Reinhard et al. (2001) mean and spread matching in CIELAB against a
//                      reference photo from the workspace; no model → "Colour transfer (Reinhard)".
//   ai_colourize       DDColor tiny predicts a, b; the photo's own lightness is kept → "Colourized (edited)".
//   ai_style_transfer  a fast neural style network (Udnie) → "Style: Udnie (edited)".
// Harmonization is not offered: the one published model (Harmonizer) is CC BY-NC-SA.
//
// ctx.aiVision (tests set it) supplies status, parsePerson, colourize, stylize; without it the handlers use
// src/ai/vision-ort.js. Model-backed commands answer `unsupported`, naming the download, without their model.

import { makeLayer } from '../document.js';
import { alone, renderLayers } from '../files/layered.js';
import { pixelModel } from '../ai/models-pixels.js';
import { stretch, coverage } from '../ai/masks.js';
import * as P from '../ai/portrait.js';
import * as F from '../ai/faces.js';
import * as R from '../select/raster.js';
import { photoDocument } from './views.js';
import { needDoc, needLayer, fail, change, layerRow } from './util.js';

const PIXEL_KINDS = ['raw', 'image', 'raster'];
export const STYLES = { udnie: { model: 'style-udnie', name: 'Udnie' } };

export function register(bus, ctx) {
  let ioP = null;
  const io = async () => ctx.aiVision ?? (ioP ??= import('../ai/vision-ort.js'));
  const rd = () => { if (!ctx.renderer) fail('unsupported', 'this command needs the WebGPU engine, which did not start', 'get_state', 'get_capabilities'); return ctx.renderer; };
  const u8 = (im) => new Uint8Array(im.data.buffer, im.data.byteOffset, im.data.byteLength);
  async function needModel(id, tool) {
    const m = pixelModel(id);
    if ((await (await io()).status(id)) !== 'ready') fail('unsupported', `${tool} needs the on-device model "${m.label}" (${m.licence}, ${m.repo}); the person downloads it in the AI pixel tools panel (download_model ${id})`, 'use_ui_control', 'download_model');
    return m;
  }
  async function holding(tool, fn) {
    if (ctx.busy) fail('busy', `${ctx.busy} holds the engine`, 'get_job', 'get_job');
    ctx.busy = tool; try { return await fn(); } finally { ctx.busy = null; }
  }
  const pixelLayer = (a, tool) => {
    const l = needLayer(ctx, a.layerId, { unlocked: false });
    if (!PIXEL_KINDS.includes(l.kind)) fail('unsupported', `${tool} works on a photo, image or raster layer; ${l.name} is ${l.kind}`, 'change_target', 'set_active');
    return l;
  };
  // The layer rendered alone at canvas size (develop, local adjustments, its mask), 8-bit sRGB.
  async function layerPixels(d, l) {
    const r = rd();
    try { return u8(await renderLayers(r, d, alone(d, l, { includeLocals: true }), 1)); } finally { await r.sync(d); }
  }
  // A new doc-size raster layer just above l (and above its local adjustments and retouch layer), active. One undo step.
  async function addAbove(tool, l, name, px, props = {}) {
    const d = needDoc(ctx);
    const layer = makeLayer('raster', { name, buffer: rd().newPixels(d.width, d.height, px), width: d.width, height: d.height, ...(l.parentId ? { parentId: l.parentId } : {}), ...props });
    await change(ctx, tool, (doc) => {
      let at = doc.layers.findIndex((x) => x.id === l.id);
      while (at + 1 < doc.layers.length && (doc.layers[at + 1].localOf === l.id || doc.layers[at + 1].retouchOf === l.id)) at++;
      doc.layers.splice(at + 1, 0, layer); doc.activeLayerId = layer.id;
    });
    return layer;
  }

  bus.register('ai.smooth-skin', async (a) => {
    const T = 'ai_smooth_skin'; const d = needDoc(ctx); const l = pixelLayer(a, T);
    await needModel('mediapipe-multiclass', T);
    const areas = a.areas ?? 'skin-all';
    if (!['face-skin', 'skin-all'].includes(areas)) fail('invalid', 'areas is face-skin or skin-all', 'fix_argument', T);
    return holding(T, async () => {
      const W = d.width; const H = d.height; const px = await layerPixels(d, l);
      const r = await (await io()).parsePerson(px, W, H);
      const mask = stretch(P.partPlane(r.logits, r.size * r.size, r.classes, P.PERSON_PARTS[areas]), r.size, r.size, W, H);
      // The parsing model's face skin includes the eyes, brows and lips; when the face finder is downloaded,
      // those (grown by 1.5 % of the face width, then feathered) leave the mask so lashes and lips stay sharp.
      let kept = 0;
      if ((await (await io()).status('mediapipe-face')) === 'ready') {
        for (const f of await (await io()).detectFaces(px, W, H)) {
          const fw = f.box[2] - f.box[0]; let cut = new Uint8Array(W * H);
          for (const part of ['eyes', 'brows', 'lips', 'mouth']) for (const poly of F.partPolygons(f.mesh, part)) if (poly.op === 'add') cut = R.combine(cut, R.rasterPolygon(W, H, poly.points), 'add');
          cut = R.feather(R.dilate(cut, W, H, Math.max(1, Math.round(fw * 0.015))), W, H, Math.max(1, Math.round(fw * 0.01)));
          for (let p = 0; p < W * H; p++) mask[p] = Math.round(mask[p] * (255 - cut[p]) / 255);
          kept++;
        }
      }
      const cov = coverage(mask);
      if (!(cov > 0.0005)) fail('invalid', 'no skin found on this layer', 'change_target', 'ai_find_faces');
      const s = P.smoothSkin(px, W, H, mask, { amount: a.amount ?? 60, ...(a.radius ? { radius: a.radius } : {}) });
      const layer = await addAbove(T, l, 'Skin smoothing (edited)', s.px, { aiEdit: 'skin smoothing' });
      return { layer: layerRow(layer), model: 'mediapipe-multiclass', areas, skinCoverage: Math.round(cov * 10000) / 10000, featuresKeptSharp: kept, radius: s.radius, fineRadius: s.fineRadius, amount: a.amount ?? 60 };
    });
  });

  bus.register('ai.colour-transfer', async (a) => {
    const T = 'colour_transfer'; const d = needDoc(ctx); const l = pixelLayer(a, T); const s = ctx.storage();
    if (!s) fail('unsupported', 'no workspace storage to read the reference photo from', 'use_ui_control', 'grant_folder');
    if (!(await s.exists(a.referencePath))) fail('invalid', `no file ${a.referencePath} in the workspace`, 'fix_argument', 'list_folder');
    return holding(T, async () => {
      const px = await layerPixels(d, l);
      // The reference, rendered as it would open, at most 1024 px on the long edge (statistics only).
      const r = rd(); const rdoc = await photoDocument(ctx, a.referencePath); let ref;
      try { await r.sync(rdoc); ref = await r.resize(await r.image8(r.lodFor(rdoc, 1024), null, 1), 1024); }
      finally { await r.sync(d); for (const x of rdoc.layers) if (x.file && !d.layers.some((y) => y.file === x.file)) r.dropFile(x.kind, x.file); }
      const out = P.colourTransfer(px, d.width, d.height, u8(ref), ref.width, ref.height, { amount: a.amount ?? 100 });
      const layer = await addAbove(T, l, 'Colour transfer (Reinhard)', out.px);
      return { layer: layerRow(layer), method: 'classical: Reinhard et al. 2001 mean and spread transfer, in CIELAB', amount: a.amount ?? 100, source: out.source, reference: out.reference };
    });
  });

  bus.register('ai.colourize', async (a) => {
    const T = 'ai_colourize'; const d = needDoc(ctx); const l = pixelLayer(a, T);
    await needModel('ddcolor-tiny', T);
    return holding(T, async () => {
      const px = await layerPixels(d, l); const n = d.width * d.height;
      const r = await (await io()).colourize(px, d.width, d.height);
      const out = P.colourizeCombine(px, d.width, d.height, r.ab, r.size, { strength: a.strength ?? 100 });
      const layer = await addAbove(T, l, 'Colourized (edited)', out, { aiEdit: 'colourize' });
      return { layer: layerRow(layer), model: 'ddcolor-tiny', chromaBefore: Math.round(P.meanChroma(px, n) * 100) / 100, chromaAfter: Math.round(P.meanChroma(out, n) * 100) / 100 };
    });
  });

  bus.register('ai.style', async (a) => {
    const T = 'ai_style_transfer'; const d = needDoc(ctx); const l = pixelLayer(a, T);
    const st = STYLES[a.style ?? 'udnie'];
    if (!st) fail('invalid', `style is one of ${Object.keys(STYLES).join(', ')}`, 'fix_argument', T);
    await needModel(st.model, T);
    return holding(T, async () => {
      const px = await layerPixels(d, l);
      const [w, h] = P.styleSize(d.width, d.height, a.edge ?? 1024);
      const small = P.resizeRGBA(px, d.width, d.height, w, h);
      const y = await (await io()).stylize(st.model, small, w, h, (n, total) => ctx.aiProgress?.(T, n, total));
      const out = P.styleOutput(y, w, h, px, d.width, d.height, { strength: a.strength ?? 100 });
      const layer = await addAbove(T, l, `Style: ${st.name} (edited)`, out, { aiEdit: `style transfer ${st.name}` });
      return { layer: layerRow(layer), model: st.model, workingSize: [w, h], strength: a.strength ?? 100 };
    });
  });
}
