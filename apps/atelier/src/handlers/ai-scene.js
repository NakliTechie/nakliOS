// Sky replacement and relighting (L66). Both write new layers marked as AI edits (aiEdit: true, "(edited)"
// in the name) and leave the photo's pixels alone.
//   ai_replace_sky: the sky is found by ai_select target sky (the AI mask builder's sky model, called on the
//     bus), feathered, and filled with a replacement photo the person picks from the workspace ("Sky
//     (edited)"); the foreground takes part of the new sky's colour cast ("Sky colour match (edited)").
//   ai_relight: surface normals from the depth model and a movable point light make a grey shading layer
//     in soft-light blend ("Relight (edited)"), so moving the light means running it again and deleting
//     the old layer, and opacity sets its strength afterwards.

import { makeLayer } from '../document.js';
import { alone, renderLayers } from '../files/layered.js';
import { decodePng } from '../files/png.js';
import { photoDocument } from './views.js';
import { depthPathFor } from './ai.js';
import * as rt from '../ai/runtime.js';
import * as S from '../ai/scene.js';
import { boxBlur } from '../ai/pixels.js';
import { needDoc, needLayer, fail, change, layerRow } from './util.js';

const DEPTH_EDGE = 768;

export function register(bus, ctx) {
  const run = () => ctx.aiRuntime ?? rt;
  const rd = () => { if (!ctx.renderer) fail('unsupported', 'this command needs the WebGPU engine, which did not start', 'get_state', 'get_capabilities'); return ctx.renderer; };
  const u8 = (im) => new Uint8Array(im.data.buffer, im.data.byteOffset, im.data.byteLength);
  async function layerPixels(d, l) {
    const r = rd();
    try { return u8(await renderLayers(r, d, alone(d, l, { includeLocals: true }), 1)); } finally { await r.sync(d); }
  }
  async function addLayers(tool, layers) {
    await change(ctx, tool, (doc) => { doc.layers.push(...layers); doc.activeLayerId = layers.at(-1).id; });
  }
  const forward = (r, name) => fail(r.status === 'stale' ? 'outcome_unknown' : r.status, `${name} answered ${r.status}: ${r.error?.message ?? ''}`, r.remedy?.action ?? 'get_state', r.remedy?.tool ?? 'get_state');

  bus.register('ai.sky', async (a, { door, caller }) => {
    const T = 'ai_replace_sky'; const d = needDoc(ctx); const s = ctx.storage();
    if (!s) fail('unsupported', 'no workspace storage to read the replacement sky from', 'use_ui_control', 'grant_folder');
    if (!(await s.exists(a.skyPath))) fail('invalid', `no file ${a.skyPath} in the workspace`, 'fix_argument', 'list_folder');
    // 1. The sky, through the AI mask builder's command (it needs its sky model; it answers unsupported without).
    const sel = await bus.dispatch('ai_select', { target: 'sky', op: 'replace', revision: bus.state.revision }, { door, caller: `${caller ?? door} via ai_replace_sky` });
    if (sel.status !== 'ok') forward(sel, 'ai_select');
    const doc = needDoc(ctx); const W = doc.width; const H = doc.height;
    if (!doc.selection) fail('invalid', 'no sky found in this photo', 'change_target', 'ai_select');
    const sky8 = rd().bufferData(doc.selection.buffer).slice();
    const feather = a.feather ?? Math.max(2, Math.round(Math.max(W, H) / 400));
    // The panoptic sky region is coarse (masts, rockets, branches fall inside it): keep only sky-coloured
    // pixels (refineSky), then feather the edge.
    const comp0 = u8(await rd().image8(0, null, 1));
    const refined = S.refineSky(comp0, sky8, W, H, { tolerance: a.tolerance ?? 40 });
    const alpha = boxBlur(Uint8Array.from(refined, (v) => Math.round(255 * v)), W, H, feather);   // 0..1 feathered sky coverage
    // 2. The replacement, rendered as it would open, covering the canvas.
    const r = rd(); const sdoc = await photoDocument(ctx, a.skyPath); let rep;
    try { await r.sync(sdoc); const im = await r.image8(0, null, 1); rep = S.coverFit(u8(im), im.width, im.height, W, H); }
    finally { await r.sync(doc); for (const l of sdoc.layers) if (l.file && !doc.layers.some((x) => x.file === l.file)) r.dropFile(l.kind, l.file); }
    // 3. Colour match: the composite's old sky vs the replacement where the sky is.
    const comp = u8(await r.image8(0, null, 1));
    const oldSky = S.meanLinear(comp, alpha); const newSky = S.meanLinear(rep, alpha);
    const fgMask = Float32Array.from(alpha, (v) => 1 - v);
    const match = a.match ?? 50; const out = [];
    const skyPx = rep.slice(); for (let p = 0; p < W * H; p++) skyPx[p * 4 + 3] = Math.round(255 * alpha[p]);
    const skyLayer = makeLayer('raster', { name: 'Sky (edited)', buffer: r.newPixels(W, H, skyPx), width: W, height: H, aiEdit: 'sky replacement' });
    let gains = null;
    if (match > 0 && oldSky && newSky) {
      const m = S.matchForeground(comp, oldSky, newSky, match); gains = m.gains;
      for (let p = 0; p < W * H; p++) m.px[p * 4 + 3] = Math.round(255 * fgMask[p]);
      out.push(makeLayer('raster', { name: 'Sky colour match (edited)', buffer: r.newPixels(W, H, m.px), width: W, height: H, aiEdit: 'sky colour match' }));
    }
    out.unshift(skyLayer);
    await addLayers(T, out);
    return { layers: out.map(layerRow), sky: { modelCoverage: Math.round((sky8.reduce((x, y) => x + y, 0) / 255 / (W * H)) * 10000) / 10000, coverage: Math.round((alpha.reduce((x, y) => x + y, 0) / (W * H)) * 10000) / 10000, feather }, colourMatch: gains ? { amount: match, gains } : null };
  });

  bus.register('ai.relight', async (a) => {
    const T = 'ai_relight'; const d = needDoc(ctx); const l = needLayer(ctx, a.layerId, { unlocked: false });
    const W = d.width; const H = d.height;
    if (!a.light || a.light[0] < -W || a.light[0] > 2 * W || a.light[1] < -H || a.light[1] > 2 * H) fail('invalid', 'light [x, y] in document pixels is required (within one canvas size of it)', 'fix_argument', T);
    // Depth: the photo's saved depth map (<photo>.depth.png, written by ai_depth) or the depth model run now.
    let depth = null; let from = 'model'; const s = ctx.storage();
    const dp = depthPathFor(d, l);
    if (dp && s && (await s.exists(dp))) {
      const png = await decodePng(await s.readBinary(dp));
      const plane = new Uint8Array(png.width * png.height); for (let i = 0; i < plane.length; i++) plane[i] = png.data[i * png.channels];
      depth = S.resizePlane(plane, png.width, png.height, W, H); from = dp;
    } else {
      const id = 'depth-anything-v2-small';
      let st = run().modelStatus(id);
      if (st === 'absent') { await run().refresh?.(); st = run().modelStatus(id); }   // the consent record may not have been read yet (as modelFor in ai.js)
      if (st !== 'ready') fail('unsupported', 'ai_relight needs the depth model (Depth Anything V2 Small, Apache-2.0); the person downloads it in the AI panel (download_model depth-anything-v2-small)', 'use_ui_control', 'download_model');
      const px = await layerPixels(d, l);
      const k = Math.min(1, DEPTH_EDGE / Math.max(W, H)); const w = Math.max(1, Math.round(W * k)); const h = Math.max(1, Math.round(H * k));
      const small = new Uint8Array(w * h * 4);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const q = (Math.min(H - 1, Math.floor((j + 0.5) / k)) * W + Math.min(W - 1, Math.floor((i + 0.5) / k))) * 4; small.set(px.subarray(q, q + 4), (j * w + i) * 4); }
      const res = await run().runModel(id, 'depth', { image: { width: w, height: h, data: small } });
      depth = S.resizePlane(res.depth, res.width, res.height, W, H);
    }
    const n = S.normalsFromDepth(depth, W, H, { relief: (a.relief ?? 15) / 100, r: Math.max(1, Math.round(Math.max(W, H) / 500)) });
    const sh = S.shade(n, W, H, a.light, (a.height ?? 50) / 100);
    const px = S.relightLayer(sh, a.strength ?? 60);
    const layer = makeLayer('raster', { name: 'Relight (edited)', buffer: rd().newPixels(W, H, px), width: W, height: H, blend: 'soft-light', aiEdit: 'relight', ...(l.parentId ? { parentId: l.parentId } : {}) });
    await addLayers(T, [layer]);
    return { layer: layerRow(layer), depth: from, light: a.light, blend: 'soft-light' };
  });
}
