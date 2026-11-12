// Content-aware fill (P41): fills the selection, or a layer's bitmap mask, from the surrounding image by
// classical PatchMatch (src/select/patchmatch.js; no model). The result is a new raster layer holding
// only the filled pixels, placed above the target layer, so authored pixels are never overwritten and
// the person can delete, mask or lower the fill like any layer.

import { invertAffine } from '../../vendor/tessella/src/model.js';
import * as R from '../select/raster.js';
import { patchmatchFill, fillRegion } from '../select/patchmatch.js';
import { makeLayer } from '../document.js';
import { needDoc, needLayer, fail, change, layerRow } from './util.js';

export function register(bus, ctx) {
  const T = 'content_aware_fill';
  const rd = () => { if (!ctx.renderer) fail('unsupported', 'content-aware fill reads the rendered image and needs the WebGPU engine, which did not start', 'get_state', 'get_capabilities'); return ctx.renderer; };

  bus.register('retouch.content-aware-fill', async (a) => {
    const doc = needDoc(ctx);
    const target = needLayer(ctx, a.layerId, { unlocked: false });
    const W = doc.width; const H = doc.height;
    // Hole coverage in document pixels, 0..255.
    let cov;
    if ((a.hole ?? 'selection') === 'selection') {
      if (!doc.selection) fail('invalid', 'there is no selection; select the area to fill (set_selection) or pass hole "mask"', 'change_target', 'set_selection');
      cov = rd().bufferData(doc.selection.buffer);
    } else {
      const ml = needLayer(ctx, a.maskLayerId ?? target.id, { unlocked: false });
      const comp = ml.mask?.components.find((c) => c.kind === 'bitmap');
      if (!comp) fail('invalid', `layer ${ml.name} has no bitmap mask; paint one (paint_mask) or use the selection`, 'fix_argument', 'set_mask');
      const b = rd().buffers.get(comp.bitmap);
      // Mask pixels are in the layer's own grid; the inverse matrix maps document pixels into it.
      cov = R.resampleToLocal(rd().bufferData(comp.bitmap), b.width, b.height, invertAffine(ml.matrix), W, H);
    }
    const box = R.bounds(cov, W, H);
    if (!box) fail('invalid', 'the hole is empty; select the area to fill', 'change_target', 'set_selection');
    const patch = a.patchSize ?? 7; const radius = (patch - 1) / 2;
    const [rx0, ry0, rx1, ry1] = fillRegion([box[0], box[1], box[2] - 1, box[3] - 1], W, H, radius);
    const im = await rd().image8(0, [rx0, ry0, rx1, ry1]);
    const rw = im.width; const rh = im.height; const ox = im.x ?? rx0; const oy = im.y ?? ry0;
    const hole = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) hole[y * rw + x] = cov[(y + oy) * W + x + ox];
    let res;
    try { res = patchmatchFill(im.data, rw, rh, hole, { radius, seed: a.seed ?? 1 }); } catch (e) { fail('invalid', `nothing applied: ${e.message}`, 'change_target', 'set_selection'); }

    // The fill layer covers the hole's box only; alpha is the hole coverage, so a feathered selection blends.
    const bw = box[2] - box[0]; const bh = box[3] - box[1];
    const px = new Uint8Array(bw * bh * 4);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const X = x + box[0]; const Y = y + box[1]; const c = cov[Y * W + X]; if (!c) continue;
      const k = ((Y - oy) * rw + (X - ox)) * 4; const o = (y * bw + x) * 4;
      px[o] = res.data[k]; px[o + 1] = res.data[k + 1]; px[o + 2] = res.data[k + 2]; px[o + 3] = c;
    }
    const buffer = rd().newPixels(bw, bh, px);
    const layer = makeLayer('raster', { name: `${target.name} · fill`, buffer, width: bw, height: bh, matrix: [1, 0, 0, 1, box[0], box[1]], ...(target.parentId ? { parentId: target.parentId } : {}) });
    await change(ctx, T, (d) => {
      let at = d.layers.findIndex((x) => x.id === target.id);
      // Above the photo's own local-adjustment passes and retouch layer, which belong with it.
      while (at + 1 < d.layers.length && (d.layers[at + 1].localOf === target.id || d.layers[at + 1].retouchOf === target.id)) at++;
      d.layers.splice(at + 1, 0, layer);
      d.activeLayerId = layer.id;
    });
    return { layer: layerRow(ctx.store.doc.layers.find((x) => x.id === layer.id)), hole: { bounds: box, pixels: res.holePixels }, region: [rx0, ry0, rx1, ry1], levels: res.levels, iterations: res.iterations };
  });
}
