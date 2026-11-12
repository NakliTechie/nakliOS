// Focus stacking (L46, P57): frames of one scene focused at different distances → one frame sharp
// throughout. Steps (Atelier's own formulas):
// 1. Align every frame to the middle one by MTB translation (align.js), unless align is off.
// 2. Sharpness of frame k: the discrete Laplacian of its display-encoded luminance g,
//      L = 4·g(x, y) − g(x−1, y) − g(x+1, y) − g(x, y−1) − g(x, y+1),
//    squared and Gaussian-smoothed: E_k = G_σ * L², σ = smoothing (default max(2, 0.003 · long edge) px).
// 3. Soft blend: w_k = (E_k + 1e-9)^p with p = 4, out = Σ w_k · v_k / Σ w_k per pixel (linear light),
//    so the sharpest frame dominates and transitions stay smooth instead of switching hard per pixel.
// Frames are accumulated one at a time, so memory holds one frame's planes plus the running sums.
// Pure code: node and browser.

import { grey8, mtbShift } from './align.js';
import { luma, oetf, gaussian } from './image.js';

export function sharpness(im, sigma) {
  const w = im.width; const h = im.height; const y = luma(im);
  for (let i = 0; i < y.length; i++) y[i] = oetf(Math.min(1, Math.max(0, y[i])));
  const L = new Float32Array(w * h);
  for (let r = 1; r < h - 1; r++) for (let c = 1; c < w - 1; c++) {
    const i = r * w + c; const v = 4 * y[i] - y[i - 1] - y[i + 1] - y[i - w] - y[i + w]; L[i] = v * v;
  }
  return gaussian(L, w, h, sigma);
}

export function focusStack(frames, { align = true, smoothing = null, power = 4, maxShift = 64, out16 = false } = {}) {
  if (frames.length < 2) throw new Error('a focus stack needs at least 2 frames');
  const { width: w, height: h } = frames[0];
  if (frames.some((f) => f.width !== w || f.height !== h)) throw new Error('every frame must have the same size');
  const ref = (frames.length - 1) >> 1;
  const sigma = smoothing ?? Math.max(2, 0.003 * Math.max(w, h));
  const refGrey = align ? grey8(frames[ref]) : null;
  const n = w * h; const num = new Float32Array(n * 3); const den = new Float32Array(n);
  const shifts = []; const share = new Float64Array(frames.length);
  // Weights are normalised per pixel at the end; energies are scaled by the first frame's peak so E^p
  // stays inside float range.
  let norm = null;
  for (let k = 0; k < frames.length; k++) {
    const im = frames[k];
    const s = align && k !== ref ? mtbShift(refGrey, grey8(im), w, h, { maxShift }) : { dx: 0, dy: 0 };
    shifts.push(s);
    const E = sharpness(im, sigma);
    if (norm === null) { let peak = 0; for (let i = 0; i < n; i++) if (E[i] > peak) peak = E[i]; norm = peak > 0 ? 1 / peak : 1; }
    const lut = im.lut; const d = im.data;
    for (let y = 0; y < h; y++) {
      const sy = y - s.dy; if (sy < 0 || sy >= h) continue;
      for (let x = 0; x < w; x++) {
        const sx = x - s.dx; if (sx < 0 || sx >= w) continue;
        const j = sy * w + sx; const wt = (E[j] * norm + 1e-9) ** power; const i = y * w + x;
        den[i] += wt; share[k] += wt;
        const q = j * 3;
        num[i * 3] += wt * (lut ? lut[d[q]] : d[q]); num[i * 3 + 1] += wt * (lut ? lut[d[q + 1]] : d[q + 1]); num[i * 3 + 2] += wt * (lut ? lut[d[q + 2]] : d[q + 2]);
      }
    }
  }
  const out = out16 ? new Uint16Array(n * 3) : new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const dn = den[i]; if (!(dn > 0)) continue;
    for (let c = 0; c < 3; c++) { const v = num[i * 3 + c] / dn; out[i * 3 + c] = out16 ? Math.min(65535, Math.round(v * 65535)) : v; }
  }
  const tot = share.reduce((a, b) => a + b, 0);
  return { width: w, height: h, data: out, reference: ref, shifts, sigma, share: Array.from(share, (v) => Math.round((1000 * v) / tot) / 1000) };
}
