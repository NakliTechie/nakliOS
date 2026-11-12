// Artistic filters (P38) on 8-bit straight sRGB RGBA raster pixels, in place, blended with the original by an optional
// selection coverage (Uint8Array 0..255). They work on display-encoded values (the look is defined there). Alpha stays.
// Formulas (Atelier's own; Y = 0.2126 R + 0.7152 G + 0.0722 B on 0..255 values):
//   oil-paint: Kuwahara, radius r: of the four (r + 1)² squares with the pixel at a corner, the one with the least
//     variance of Y gives the output (its mean colour). Summed-area tables make it O(pixels).
//   watercolour: Kuwahara (radius r), then edge darkening: v × (1 - k · min(1, |∇Y| / 64)), k = strength / 100,
//     ∇Y the central difference of the Kuwahara result's Y.
//   sketch (pencil): g = Y; b = box blur of 255 - g (three passes, radius r); out = min(255, 255 g / max(255 - b, 1)) grey.
//   posterise: v' = round(v / 255 × (n - 1)) × 255 / (n - 1), n levels per channel.
//   halftone: dots on a grid of cell size s rotated by θ; dot radius ρ = s √(d / π), d = darkness 1 - Y / 255 read at the
//     cell centre (so a dot's area is d s²); ink coverage = clamp(ρ - dist + 0.5, 0, 1) (0 where d = 0); mono: black ink
//     on white; colour: cyan, magenta, yellow screens at 15°, 75°, 0° from d_c = 1 - channel / 255, multiplied.

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const mixCov = (px, out, coverage) => {
  for (let p = 0; p < px.length / 4; p++) {
    const k = coverage ? coverage[p] / 255 : 1;
    for (let c = 0; c < 3; c++) px[p * 4 + c] = Math.round(px[p * 4 + c] + (out[p * 4 + c] - px[p * 4 + c]) * k);
  }
};
// Summed-area table of f(p) over a w × h grid, (w + 1) × (h + 1).
function sat(w, h, f) {
  const S = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += f(y * w + x); S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row; } }
  return (x0, y0, x1, y1) => S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0];   // [x0, x1) × [y0, y1)
}
export function kuwahara(px, w, h, r) {
  const Y = (p) => lum(px[p * 4], px[p * 4 + 1], px[p * 4 + 2]);
  const sY = sat(w, h, Y); const sY2 = sat(w, h, (p) => Y(p) ** 2);
  const sC = [0, 1, 2].map((c) => sat(w, h, (p) => px[p * 4 + c]));
  const out = new Float32Array(px.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let best = Infinity; let pick = null;
    for (const [qx, qy] of [[x - r, y - r], [x, y - r], [x - r, y], [x, y]]) {
      const x0 = Math.max(0, qx); const y0 = Math.max(0, qy); const x1 = Math.min(w, qx + r + 1); const y1 = Math.min(h, qy + r + 1);
      const n = (x1 - x0) * (y1 - y0);
      const m = sY(x0, y0, x1, y1) / n; const v = sY2(x0, y0, x1, y1) / n - m * m;
      if (v < best - 1e-9) { best = v; pick = [x0, y0, x1, y1, n]; }
    }
    const [x0, y0, x1, y1, n] = pick; const o = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) out[o + c] = sC[c](x0, y0, x1, y1) / n;
    out[o + 3] = px[o + 3];
  }
  return out;
}
export function oilPaint(px, w, h, { radius = 4 } = {}, coverage = null) { mixCov(px, kuwahara(px, w, h, radius), coverage); }
export function watercolour(px, w, h, { radius = 4, strength = 50 } = {}, coverage = null) {
  const k = kuwahara(px, w, h, radius); const s = strength / 100;
  const Yk = (x, y) => { const o = (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4; return lum(k[o], k[o + 1], k[o + 2]); };
  const out = new Float32Array(px.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const g = Math.hypot(Yk(x + 1, y) - Yk(x - 1, y), Yk(x, y + 1) - Yk(x, y - 1)) / 2;
    const f = 1 - s * Math.min(1, g / 64); const o = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) out[o + c] = k[o + c] * f;
  }
  mixCov(px, out, coverage);
}
function boxBlur(v, w, h, r) {
  const S = sat(w, h, (p) => v[p]); const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.max(0, x - r); const y0 = Math.max(0, y - r); const x1 = Math.min(w, x + r + 1); const y1 = Math.min(h, y + r + 1);
    out[y * w + x] = S(x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0));
  }
  return out;
}
export function sketch(px, w, h, { radius = 6 } = {}, coverage = null) {
  const g = new Float32Array(w * h); for (let p = 0; p < w * h; p++) g[p] = lum(px[p * 4], px[p * 4 + 1], px[p * 4 + 2]);
  let b = g.map((v) => 255 - v); for (let i = 0; i < 3; i++) b = boxBlur(b, w, h, radius);
  const out = new Float32Array(px.length);
  for (let p = 0; p < w * h; p++) { const v = Math.min(255, (255 * g[p]) / Math.max(255 - b[p], 1)); out.set([v, v, v, px[p * 4 + 3]], p * 4); }
  mixCov(px, out, coverage);
}
export function posterise(px, w, h, { levels = 4 } = {}, coverage = null) {
  const n = levels; const out = new Float32Array(px.length);
  for (let i = 0; i < px.length; i++) out[i] = (i & 3) === 3 ? px[i] : Math.round(px[i] / 255 * (n - 1)) * 255 / (n - 1);
  mixCov(px, out, coverage);
}
// Ink coverage of one screen at (x, y): grid of cell size s rotated by θ, dot radius from darkness at the cell centre.
function screen(darkAt, x, y, s, th) {
  const c = Math.cos(th); const sn = Math.sin(th);
  const u = c * x + sn * y; const v = -sn * x + c * y;
  const cu = (Math.floor(u / s) + 0.5) * s; const cv = (Math.floor(v / s) + 0.5) * s;
  const cx = c * cu - sn * cv; const cy = sn * cu + c * cv;
  const rho = s * Math.sqrt(Math.max(0, darkAt(cx, cy)) / Math.PI);
  if (rho <= 0) return 0; // no ink where there is no darkness
  return Math.min(1, Math.max(0, rho - Math.hypot(u - cu, v - cv) + 0.5));
}
export function halftone(px, w, h, { size = 8, angle = 45, mode = 'mono' } = {}, coverage = null) {
  const at = (x, y, f) => { const o = (Math.min(h - 1, Math.max(0, Math.floor(y))) * w + Math.min(w - 1, Math.max(0, Math.floor(x)))) * 4; return f(o); };
  const out = new Float32Array(px.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4; const X = x + 0.5; const Y = y + 0.5;
    if (mode === 'colour') {
      const ink = [15, 75, 0].map((deg, c) => screen((qx, qy) => at(qx, qy, (k) => 1 - px[k + c] / 255), X, Y, size, deg * Math.PI / 180));
      for (let c = 0; c < 3; c++) out[o + c] = 255 * (1 - ink[c]);
    } else {
      const ink = screen((qx, qy) => at(qx, qy, (k) => 1 - lum(px[k], px[k + 1], px[k + 2]) / 255), X, Y, size, angle * Math.PI / 180);
      out.set([255 * (1 - ink), 255 * (1 - ink), 255 * (1 - ink)], o);
    }
    out[o + 3] = px[o + 3];
  }
  mixCov(px, out, coverage);
}
export const ARTISTIC = Object.freeze({ 'oil-paint': oilPaint, watercolour, sketch, posterise, halftone });
