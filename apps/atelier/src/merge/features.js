// Feature detection and matching for panorama stitching, ORB-like and written for Atelier:
// - corners: Harris response R = det(M) − 0.04·trace(M)², M the Gaussian-weighted (σ 1.5) structure
//   tensor of Sobel gradients (C. Harris and M. Stephens, "A combined corner and edge detector", 1988),
//   3×3 non-maximum suppression, then the strongest corners per cell of a grid so they spread over the frame;
// - orientation: the intensity centroid of a radius-15 disc, θ = atan2(m01, m10) (P. Rosin 1999, as in
//   ORB: E. Rublee et al., "ORB: an efficient alternative to SIFT or SURF", ICCV 2011);
// - descriptor: 256 binary tests between point pairs drawn once from an isotropic Gaussian (σ = 31/5)
//   inside a 31×31 patch (BRIEF, M. Calonder et al., ECCV 2010), rotated by θ, read from the image
//   smoothed with σ = 2;
// - matching: Hamming distance, Lowe's ratio test (0.8) and a mutual nearest-neighbour check.
// Pure code: node and browser.

import { gaussian } from './image.js';
import { rng } from './geometry.js';

const PAIRS = (() => {   // 256 test pairs, fixed for every run
  const r = rng(0x0b5e55); const g = () => { let u = 0; let v = 0; while (!u) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const s = 31 / 5; const c = (x) => Math.max(-15, Math.min(15, Math.round(x * s)));
  return Array.from({ length: 256 }, () => [c(g()), c(g()), c(g()), c(g())]);
})();

// grey: Float32Array plane (any range). Returns [{ x, y, score }] sorted by score.
export function harris(grey, w, h, { maxCorners = 1500, border = 20, grid = 8 } = {}) {
  const ix = new Float32Array(w * h); const iy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = (dx, dy) => grey[(y + dy) * w + x + dx];
    ix[y * w + x] = (p(1, -1) + 2 * p(1, 0) + p(1, 1)) - (p(-1, -1) + 2 * p(-1, 0) + p(-1, 1));
    iy[y * w + x] = (p(-1, 1) + 2 * p(0, 1) + p(1, 1)) - (p(-1, -1) + 2 * p(0, -1) + p(1, -1));
  }
  const xx = new Float32Array(w * h); const yy = new Float32Array(w * h); const xy = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) { xx[i] = ix[i] * ix[i]; yy[i] = iy[i] * iy[i]; xy[i] = ix[i] * iy[i]; }
  const a = gaussian(xx, w, h, 1.5); const b = gaussian(yy, w, h, 1.5); const c = gaussian(xy, w, h, 1.5);
  const R = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) { const tr = a[i] + b[i]; R[i] = a[i] * b[i] - c[i] * c[i] - 0.04 * tr * tr; }
  const cells = new Map(); const per = Math.ceil(maxCorners / (grid * grid)) * 2;
  let peak = 0; for (let i = 0; i < w * h; i++) if (R[i] > peak) peak = R[i];
  const floor = peak * 1e-4;
  for (let y = border; y < h - border; y++) for (let x = border; x < w - border; x++) {
    const v = R[y * w + x]; if (v <= floor) continue;
    let max = true;
    for (let j = -1; j <= 1 && max; j++) for (let i = -1; i <= 1; i++) if ((i || j) && R[(y + j) * w + x + i] >= v) { max = false; break; }
    if (!max) continue;
    const key = Math.floor((x * grid) / w) * grid + Math.floor((y * grid) / h);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push({ x, y, score: v });
  }
  const out = [];
  for (const list of cells.values()) { list.sort((p, q) => q.score - p.score); out.push(...list.slice(0, per)); }
  out.sort((p, q) => q.score - p.score);
  return out.slice(0, maxCorners);
}

// Descriptors for corners; returns [{ x, y, angle, d: Uint32Array(8) }] (corners too near the edge are dropped).
export function describe(grey, w, h, corners) {
  const sm = gaussian(grey, w, h, 2);
  const out = [];
  for (const { x, y } of corners) {
    if (x < 22 || y < 22 || x >= w - 22 || y >= h - 22) continue;
    let m01 = 0; let m10 = 0;
    for (let j = -15; j <= 15; j++) for (let i = -15; i <= 15; i++) { if (i * i + j * j > 225) continue; const v = sm[(y + j) * w + x + i]; m10 += i * v; m01 += j * v; }
    const angle = Math.atan2(m01, m10); const cs = Math.cos(angle); const sn = Math.sin(angle);
    const d = new Uint32Array(8);
    const px = (u, v) => sm[(y + Math.round(sn * u + cs * v)) * w + x + Math.round(cs * u - sn * v)];
    for (let k = 0; k < 256; k++) { const [u1, v1, u2, v2] = PAIRS[k]; if (px(u1, v1) < px(u2, v2)) d[k >> 5] |= 1 << (k & 31); }
    out.push({ x, y, angle, d });
  }
  return out;
}

const pop = (v) => { v -= (v >>> 1) & 0x55555555; v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
const ham = (a, b) => { let s = 0; for (let i = 0; i < 8; i++) s += pop(a[i] ^ b[i]); return s; };

function nearest(A, B) {
  return A.map((a) => {
    let b1 = 1e9; let b2 = 1e9; let bi = -1;
    for (let j = 0; j < B.length; j++) { const d = ham(a.d, B[j].d); if (d < b1) { b2 = b1; b1 = d; bi = j; } else if (d < b2) b2 = d; }
    return { j: bi, d: b1, d2: b2 };
  });
}

// Matches between feature lists A and B: [[ax, ay], [bx, by]] pairs.
export function match(A, B, { ratio = 0.8, maxDistance = 80 } = {}) {
  if (!A.length || !B.length) return [];
  const ab = nearest(A, B); const ba = nearest(B, A); const out = [];
  ab.forEach((m, i) => {
    if (m.j < 0 || m.d > maxDistance || m.d > ratio * m.d2 || ba[m.j].j !== i) return;
    out.push([[A[i].x, A[i].y], [B[m.j].x, B[m.j].y]]);
  });
  return out;
}
