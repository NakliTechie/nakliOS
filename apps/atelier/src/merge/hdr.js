// HDR merge (L45, P57): bracketed exposures of one scene → one linear float radiance image.
// Inputs are linear light (RAW camera RGB after decode, or sRGB images through the sRGB EOTF).
// Steps, all Atelier's own formulas:
// 1. Order frames by mean luminance; the middle frame is the reference (its exposure is 1).
// 2. Align each frame to the reference by MTB translation (align.js), unless align is off.
// 3. Relative exposure t of each frame: the median, over pixels well exposed in both frames
//    (0.02 ≤ Y ≤ 0.8 in each), of Y_brighter / Y_darker between neighbours in brightness order,
//    chained outward from the reference. No EXIF is needed, so brackets from any source work.
// 4. Radiance per pixel and channel: E = Σ_i w_i · v_i / t_i ÷ Σ_i w_i, with one weight per frame and
//    pixel taken from the pixel's largest channel m (so channels stay in proportion):
//      w(m) = 0 when m ≥ clip (clipped) ; otherwise 1 − (2·m/clip − 1)^12    (a flat-topped hat)
//    When every weight is zero: the darkest frame wins if any frame is clipped there (a highlight),
//    else the brightest frame (a deep shadow).
// 5. Deghost (optional): a frame whose radiance disagrees with the reference's by more than a relative
//    threshold (high 0.1, medium 0.2, low 0.4) is marked there; the mark is blurred (σ = 2 px plus
//    0.2% of the long edge) and the frame's weight is scaled by (1 − mark). The reference is never
//    marked, so moving objects come from the reference exposure.
// Pure code: node and browser.

import { grey8, mtbShift, shifted, at } from './align.js';
import { gaussian } from './image.js';

export const DEGHOST = { off: 0, low: 0.4, medium: 0.2, high: 0.1 };
const hat = (m, clip) => (m >= clip ? 0 : 1 - (2 * m / clip - 1) ** 12);

function meanLuma(im) {
  const n = im.width * im.height; const step = Math.max(1, Math.floor(n / 200000)); let s = 0; let c = 0;
  for (let i = 0; i < n; i += step) { const k = i * 3; const v = im.lut ? [im.lut[im.data[k]], im.lut[im.data[k + 1]], im.lut[im.data[k + 2]]] : [im.data[k], im.data[k + 1], im.data[k + 2]]; s += 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; c++; }
  return s / c;
}

// Ratio of exposure brighter / darker from pixels well exposed in both (aligned views).
function ratio(dark, bright, w, h) {
  const r = []; const step = Math.max(1, Math.floor((w * h) / 400000));
  for (let i = 0; i < w * h; i += step) {
    const x = i % w; const y = (i / w) | 0;
    const yd = 0.2126 * at(dark, x, y, 0) + 0.7152 * at(dark, x, y, 1) + 0.0722 * at(dark, x, y, 2);
    const yb = 0.2126 * at(bright, x, y, 0) + 0.7152 * at(bright, x, y, 1) + 0.0722 * at(bright, x, y, 2);
    if (yd >= 0.02 && yd <= 0.8 && yb >= 0.02 && yb <= 0.8) r.push(yb / yd);
  }
  if (r.length < 50) return null;
  r.sort((a, b) => a - b);
  return r[r.length >> 1];
}

// frames: [{ width, height, data, lut? }] of one size. Returns { width, height, data: Float32Array RGB
// radiance (reference exposure = 1), reference, exposures (t per input, input order), shifts, fallback
// pixel count, ghost pixel count }.
export function mergeHdr(frames, { align = true, deghost = 'off', clip = 0.99, maxShift = 64 } = {}) {
  if (frames.length < 2) throw new Error('an HDR merge needs at least 2 frames');
  const { width: w, height: h } = frames[0];
  if (frames.some((f) => f.width !== w || f.height !== h)) throw new Error('every frame must have the same size; bracketed frames come from one camera position');
  if (!(deghost in DEGHOST)) throw new Error(`deghost is one of ${Object.keys(DEGHOST).join(', ')}`);
  const order = frames.map((f, i) => ({ i, m: meanLuma(f) })).sort((a, b) => a.m - b.m).map((o) => o.i);
  const refPos = (order.length - 1) >> 1; const ref = order[refPos];
  const shifts = frames.map(() => ({ dx: 0, dy: 0 }));
  if (align) {
    const g = frames.map(grey8);
    for (let i = 0; i < frames.length; i++) if (i !== ref) shifts[i] = mtbShift(g[ref], g[i], w, h, { maxShift });
  }
  const view = frames.map((f, i) => shifted(f, shifts[i].dx, shifts[i].dy));
  // Exposures chained outward from the reference along brightness order.
  const t = new Array(frames.length).fill(null); t[ref] = 1;
  for (let p = refPos + 1; p < order.length; p++) { const r = ratio(view[order[p - 1]], view[order[p]], w, h); if (!r) throw new Error('two neighbouring exposures share too few well-exposed pixels to measure their exposure ratio'); t[order[p]] = t[order[p - 1]] * r; }
  for (let p = refPos - 1; p >= 0; p--) { const r = ratio(view[order[p]], view[order[p + 1]], w, h); if (!r) throw new Error('two neighbouring exposures share too few well-exposed pixels to measure their exposure ratio'); t[order[p]] = t[order[p + 1]] / r; }

  const n = w * h; const K = frames.length;
  const W = Array.from({ length: K }, () => new Float32Array(n));
  for (let k = 0; k < K; k++) {
    const v = view[k]; const Wk = W[k];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const r = at(v, x, y, 0); if (Number.isNaN(r)) { Wk[y * w + x] = 0; continue; }
      Wk[y * w + x] = hat(Math.max(r, at(v, x, y, 1), at(v, x, y, 2)), clip);
    }
  }
  let ghostPixels = 0;
  const thr = DEGHOST[deghost];
  if (thr > 0) {
    const vr = view[ref]; const s = 2 + 0.002 * Math.max(w, h);
    for (let k = 0; k < K; k++) {
      if (k === ref) continue;
      const mark = new Float32Array(n); const vk = view[k];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; if (!(W[k][i] > 0 && W[ref][i] > 0)) continue;
        const er = (0.2126 * at(vr, x, y, 0) + 0.7152 * at(vr, x, y, 1) + 0.0722 * at(vr, x, y, 2)) / t[ref];
        const ek = (0.2126 * at(vk, x, y, 0) + 0.7152 * at(vk, x, y, 1) + 0.0722 * at(vk, x, y, 2)) / t[k];
        if (Math.abs(ek - er) > thr * Math.max(er, ek, 1e-4)) { mark[i] = 1; ghostPixels++; }
      }
      const soft = gaussian(mark, w, h, s);
      for (let i = 0; i < n; i++) W[k][i] *= 1 - Math.min(1, soft[i] * 2);
    }
  }
  const out = new Float32Array(n * 3); let fallback = 0;
  const darkest = order[0]; const brightest = order[K - 1];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; let sw = 0; let r = 0; let g = 0; let b = 0;
    for (let k = 0; k < K; k++) {
      const wk = W[k][i]; if (!(wk > 0)) continue;
      const v = view[k]; const s = wk / t[k];
      r += s * at(v, x, y, 0); g += s * at(v, x, y, 1); b += s * at(v, x, y, 2); sw += wk;
    }
    if (sw > 0) { out[i * 3] = r / sw; out[i * 3 + 1] = g / sw; out[i * 3 + 2] = b / sw; continue; }
    fallback++;
    // No usable weight: a highlight clipped everywhere takes the darkest frame; a deep shadow the brightest.
    let pick = -1;
    const clipped = view.some((v) => Math.max(at(v, x, y, 0), at(v, x, y, 1), at(v, x, y, 2)) >= clip);
    for (const k of clipped ? order : [...order].reverse()) if (!Number.isNaN(at(view[k], x, y, 0))) { pick = k; break; }
    if (pick < 0) continue;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = at(view[pick], x, y, c) / t[pick];
  }
  return { width: w, height: h, data: out, reference: ref, exposures: t, shifts, fallback, ghostPixels };
}
