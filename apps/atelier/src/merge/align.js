// Translation alignment of bracketed or focus-stacked frames by the median threshold bitmap (MTB):
// G. Ward, "Fast, Robust Image Registration for Compositing High Dynamic Range Photographs from Hand-Held
// Exposures", Journal of Graphics Tools 8(2), 2003. Each frame's grey image is thresholded at its own
// median, which is unchanged by exposure; pixels within ±4 grey levels of the median are excluded. A
// pyramid search tests the 9 one-pixel shifts at each level and doubles the shift on the way down.
// Pure code: node and browser.

import { luma, oetf } from './image.js';

// Display-encoded 8-bit grey (sRGB OETF of the Rec.709 luminance), the space Ward's ±4 tolerance assumes.
export function grey8(im) {
  const y = luma(im); const out = new Uint8Array(y.length);
  for (let i = 0; i < y.length; i++) out[i] = Math.round(255 * oetf(Math.min(1, Math.max(0, y[i]))));
  return out;
}

function half(g, w, h) {
  const W = w >> 1; const H = h >> 1; const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = 2 * y * w + 2 * x; out[y * W + x] = (g[k] + g[k + 1] + g[k + w] + g[k + w + 1] + 2) >> 2;
  }
  return { g: out, w: W, h: H };
}

function bitmaps(g, tol = 4) {
  const hist = new Uint32Array(256); for (const v of g) hist[v]++;
  let acc = 0; let med = 0; for (; med < 256; med++) { acc += hist[med]; if (acc * 2 >= g.length) break; }
  const tb = new Uint8Array(g.length); const eb = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) { tb[i] = g[i] > med ? 1 : 0; eb[i] = Math.abs(g[i] - med) > tol ? 1 : 0; }
  return { tb, eb };
}

// Count of differing, non-excluded bits between frame a and frame b shifted by (dx, dy) (b's pixel
// (x - dx, y - dy) compared with a's pixel (x, y)), normalised by the overlap area.
function diff(a, b, w, h, dx, dy) {
  let n = 0; let area = 0;
  const x0 = Math.max(0, dx); const x1 = Math.min(w, w + dx); const y0 = Math.max(0, dy); const y1 = Math.min(h, h + dy);
  for (let y = y0; y < y1; y++) {
    const ra = y * w; const rb = (y - dy) * w - dx;
    for (let x = x0; x < x1; x++) { const i = ra + x; const j = rb + x; n += (a.tb[i] ^ b.tb[j]) & a.eb[i] & b.eb[j]; }
    area += x1 - x0;
  }
  return area ? n / area : Infinity;
}

// Shift (dx, dy) that moves `moving` onto `ref`: moving's pixel (x - dx, y - dy) lands on ref's (x, y).
// maxShift bounds the search (pixels); levels follow from it.
export function mtbShift(ref, moving, w, h, { maxShift = 64 } = {}) {
  const levels = Math.max(0, Math.min(Math.ceil(Math.log2(maxShift)), Math.floor(Math.log2(Math.min(w, h) / 16))));
  const pyr = [{ a: ref, b: moving, w, h }];
  for (let l = 1; l <= levels; l++) { const p = pyr[l - 1]; const A = half(p.a, p.w, p.h); const B = half(p.b, p.w, p.h); pyr.push({ a: A.g, b: B.g, w: A.w, h: A.h }); }
  let dx = 0; let dy = 0;
  for (let l = levels; l >= 0; l--) {
    const p = pyr[l]; const A = bitmaps(p.a); const B = bitmaps(p.b);
    dx *= 2; dy *= 2; if (l === levels) { dx = 0; dy = 0; }
    let best = Infinity; let bx = dx; let by = dy;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const e = diff(A, B, p.w, p.h, dx + i, dy + j);
      if (e < best - 1e-12) { best = e; bx = dx + i; by = dy + j; }
    }
    dx = bx; dy = by;
  }
  return { dx, dy };
}

// Integer-shifted view of an input image: sample (x, y) reads the source at (x - dx, y - dy).
export function shifted(im, dx, dy) { return { ...im, dx, dy }; }
// Linear value of channel c at (x, y) of a shifted image, or NaN when it falls outside the frame.
export function at(im, x, y, c) {
  const sx = x - (im.dx || 0); const sy = y - (im.dy || 0);
  if (sx < 0 || sy < 0 || sx >= im.width || sy >= im.height) return NaN;
  const k = (sy * im.width + sx) * 3 + c;
  return im.lut ? im.lut[im.data[k]] : im.data[k];
}
