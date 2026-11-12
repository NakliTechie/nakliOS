// Pure retouching maths for raster layers (8-bit sRGB RGBA, straight alpha, layer-local pixels): clone
// stamp, healing brush, spot healing, dodge, burn, sponge, and quick-mask painting of the selection.
// No GPU, no DOM, so node tests can check every formula on small grids. Formulas are Atelier's own.
//
// Conventions: S is a stroke coverage (Float32Array 0..1 from paint.strokeCoverage); coverage is the
// selection resampled into the layer grid (Uint8Array 0..255) or null for everywhere. A pixel (i, j)
// has its centre at (i + 0.5, j + 0.5).

import { decode, over } from './paint.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// sRGB OETF without rounding (display encoding of a linear value).
export const oetf = (x) => { x = clamp01(x); return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055; };
const enc8 = (x) => Math.round(255 * oetf(x));
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const cov = (coverage, p) => (coverage ? coverage[p] / 255 : 1);

// 8-bit straight sRGB pixel k → premultiplied linear [r, g, b, a].
export function premul(px, k) {
  const a = px[k + 3] / 255;
  return [decode(px[k]) * a, decode(px[k + 1]) * a, decode(px[k + 2]) * a, a];
}

// Bilinear sample of an 8-bit straight sRGB RGBA image at continuous coordinates (centre convention),
// interpolated on premultiplied linear values. Points outside [0, w] × [0, h] return null; the last
// half pixel at each edge clamps to the edge pixel. Integer offsets copy pixels exactly.
export function samplePremul(px, w, h, x, y) {
  if (!(x >= 0 && y >= 0 && x <= w && y <= h)) return null;
  const fx = x - 0.5; const fy = y - 0.5;
  const i0 = Math.floor(fx); const j0 = Math.floor(fy); const tx = fx - i0; const ty = fy - j0;
  const out = [0, 0, 0, 0];
  const add = (i, j, wt) => {
    if (wt === 0) return;
    const ii = i < 0 ? 0 : i >= w ? w - 1 : i; const jj = j < 0 ? 0 : j >= h ? h - 1 : j;
    const v = premul(px, (jj * w + ii) * 4);
    out[0] += v[0] * wt; out[1] += v[1] * wt; out[2] += v[2] * wt; out[3] += v[3] * wt;
  };
  add(i0, j0, (1 - tx) * (1 - ty)); add(i0 + 1, j0, tx * (1 - ty)); add(i0, j0 + 1, (1 - tx) * ty); add(i0 + 1, j0 + 1, tx * ty);
  return out;
}

// Bounding box [x0, y0, x1, y1] (inclusive) of S > 0, grown by pad and clamped to the image; null if empty.
export function strokeBox(S, w, h, pad = 0) {
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (S[j * w + i] > 0) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; if (j > y1) y1 = j; }
  if (x1 < 0) return null;
  return [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(w - 1, x1 + pad), Math.min(h - 1, y1 + pad)];
}

// ---- membrane (Laplace) interpolation --------------------------------------------------------------

// Fills the unknown cells of val (w × h × ch floats) so that each is the mean of its 4 neighbours
// (∇²v = 0), with known cells fixed (Dirichlet) and the grid edge free (Neumann). Solved coarse to
// fine: a half-size grid gives the starting guess, then successive over-relaxation (ω = 1.8) refines.
// This is the correction term of a Poisson (gradient-domain) blend.
export function membrane(val, known, w, h, ch, iters = 40) {
  let unknown = 0;
  for (let i = 0; i < w * h; i++) if (!known[i]) unknown++;
  if (!unknown) return val;
  if (w > 8 && h > 8) {
    const cw = Math.ceil(w / 2); const chh = Math.ceil(h / 2);
    const cv = new Float32Array(cw * chh * ch); const ck = new Uint8Array(cw * chh); const cn = new Float32Array(cw * chh);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const p = j * w + i; if (!known[p]) continue;
      const q = (j >> 1) * cw + (i >> 1); ck[q] = 1; cn[q]++;
      for (let c = 0; c < ch; c++) cv[q * ch + c] += val[p * ch + c];
    }
    for (let q = 0; q < cw * chh; q++) if (cn[q]) for (let c = 0; c < ch; c++) cv[q * ch + c] /= cn[q];
    membrane(cv, ck, cw, chh, ch, iters);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const p = j * w + i; if (known[p]) continue;
      const q = (j >> 1) * cw + (i >> 1);
      for (let c = 0; c < ch; c++) val[p * ch + c] = cv[q * ch + c];
    }
  } else iters = Math.max(iters, 4 * (w + h));
  const omega = 1.8;
  for (let it = 0; it < iters; it++) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const p = j * w + i; if (known[p]) continue;
      const nb = [];
      if (i > 0) nb.push(p - 1); if (i < w - 1) nb.push(p + 1); if (j > 0) nb.push(p - w); if (j < h - 1) nb.push(p + w);
      for (let c = 0; c < ch; c++) {
        let s = 0; for (const n of nb) s += val[n * ch + c];
        const v = val[p * ch + c];
        val[p * ch + c] = v + omega * (s / nb.length - v);
      }
    }
  }
  return val;
}

// ---- clone and heal --------------------------------------------------------------------------------

// Paints a clone or heal stroke into px (w × h layer pixels).
//   src(i, j) → premultiplied linear RGBA sampled at the source for destination pixel (i, j), or null
//   dst(i, j) → premultiplied linear RGBA of what the person sees at (i, j) (the layer, or the composite)
//   heal: false = clone stamp (result f = source); true = healing brush, a Poisson blend:
//     f = G + c, where G is the source and c solves ∇²c = 0 inside the stroke with c = D − G on the
//     pixels around it, so f keeps the source's texture (its gradients) and takes the destination's
//     colour and luminance at the stroke edge. Solved on premultiplied linear RGBA.
// The result goes on with source-over at alpha S·opacity·coverage (display-encoded mixing, as the brush).
export function retouchStroke(px, w, h, S, { src, dst, heal = false, opacity = 100 }, coverage = null) {
  const box = strokeBox(S, w, h, 2);
  if (!box) return { painted: 0, box: null };
  const [x0, y0, x1, y1] = box; const bw = x1 - x0 + 1; const bh = y1 - y0 + 1;
  const G = new Float32Array(bw * bh * 4); const ok = new Uint8Array(bw * bh);
  for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
    const g = src(x0 + i, y0 + j);
    if (g) { G.set(g, (j * bw + i) * 4); ok[j * bw + i] = 1; }
  }
  let C = null;
  if (heal) {
    C = new Float32Array(bw * bh * 4); const known = new Uint8Array(bw * bh);
    for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
      const q = j * bw + i; const p = (y0 + j) * w + x0 + i;
      if (S[p] > 0 && ok[q]) continue;
      known[q] = 1;
      if (!ok[q]) continue;   // no source here: correction 0 (the pixel is left alone)
      const d = dst(x0 + i, y0 + j);
      for (let c = 0; c < 4; c++) C[q * 4 + c] = d[c] - G[q * 4 + c];
    }
    membrane(C, known, bw, bh, 4);
  }
  const op = opacity / 100; let painted = 0;
  for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
    const q = j * bw + i; const p = (y0 + j) * w + x0 + i;
    if (!(S[p] > 0) || !ok[q]) continue;
    const t = S[p] * op * cov(coverage, p);
    if (t <= 0) continue;
    const f = [0, 1, 2, 3].map((c) => G[q * 4 + c] + (C ? C[q * 4 + c] : 0));
    const a = clamp01(f[3]);
    if (a <= 0) { const k = p * 4; px[k + 3] = Math.round(px[k + 3] * (1 - t)); painted++; continue; }
    const rgb = [0, 1, 2].map((c) => enc8(Math.min(a, Math.max(0, f[c])) / a));
    over(px, p * 4, rgb[0], rgb[1], rgb[2], t * a);
    painted++;
  }
  return { painted, box };
}

// Spot healing: chooses a source offset [dx, dy] (whole pixels) for a stroke with no source given.
// Candidates sit on rings around the stroke (1.2×, 1.6× and 2.2× its size, 16 directions) so the
// source never overlaps it. Each is scored by how well the band of pixels just outside the stroke
// matches the band around the candidate (sum of squared differences of display-encoded RGB), plus how
// far the candidate's inside variance is from the band's variance (so a second blemish is not copied).
// ref(i, j) → premultiplied linear RGBA at a layer-local pixel, or null outside. Returns null if no
// candidate fits inside the image.
export function spotSource(S, w, h, ref) {
  const box = strokeBox(S, w, h, 0);
  if (!box) return null;
  const [x0, y0, x1, y1] = box; const bw = x1 - x0 + 1; const bh = y1 - y0 + 1;
  const band = Math.max(2, Math.round(Math.max(bw, bh) / 4));
  const ring = []; const inside = [];
  for (let j = Math.max(0, y0 - band); j <= Math.min(h - 1, y1 + band); j++) {
    for (let i = Math.max(0, x0 - band); i <= Math.min(w - 1, x1 + band); i++) {
      if (S[j * w + i] > 0) inside.push([i, j]); else ring.push([i, j]);
    }
  }
  const look = (i, j) => { const v = ref(i, j); if (!v) return null; const a = v[3] || 1; return [oetf(v[0] / a), oetf(v[1] / a), oetf(v[2] / a)]; };
  const variance = (pts, dx, dy) => {
    let n = 0; const s = [0, 0, 0]; const s2 = [0, 0, 0];
    for (const [i, j] of pts) { const v = look(i + dx, j + dy); if (!v) return null; n++; for (let c = 0; c < 3; c++) { s[c] += v[c]; s2[c] += v[c] * v[c]; } }
    return n ? s2.reduce((acc, x, c) => acc + x / n - (s[c] / n) ** 2, 0) : 0;
  };
  const ringVar = variance(ring, 0, 0) ?? 0;
  const ringVals = ring.map(([i, j]) => look(i, j));
  const size = Math.max(bw, bh);
  let best = null;
  for (const k of [1.2, 1.6, 2.2]) {
    for (let d = 0; d < 16; d++) {
      const th = (d / 16) * 2 * Math.PI;
      const dx = Math.round(Math.cos(th) * k * size); const dy = Math.round(Math.sin(th) * k * size);
      if (Math.abs(dx) <= bw && Math.abs(dy) <= bh) continue;
      let ssd = 0; let n = 0; let fits = true;
      for (let r = 0; r < ring.length; r++) {
        const [i, j] = ring[r]; const a = ringVals[r]; const b = look(i + dx, j + dy);
        if (!b) { fits = false; break; }
        if (!a) continue;
        ssd += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2; n++;
      }
      if (!fits) continue;
      const v = variance(inside, dx, dy);
      if (v === null) continue;
      const score = ssd / Math.max(1, n) + Math.abs(v - ringVar);
      if (!best || score < best.score) best = { dx, dy, score };
    }
  }
  return best;
}

// ---- dodge, burn, sponge ---------------------------------------------------------------------------

// Tonal range weight on display-encoded luminance e (Rec.709 Y, then the sRGB OETF):
//   shadows    w = 1 − smoothstep(0.25, 0.50, e)
//   midtones   w = smoothstep(0.10, 0.35, e) · (1 − smoothstep(0.65, 0.90, e))
//   highlights w = smoothstep(0.50, 0.75, e)
export function rangeWeight(range, e) {
  if (range === 'shadows') return 1 - smoothstep(0.25, 0.5, e);
  if (range === 'highlights') return smoothstep(0.5, 0.75, e);
  return smoothstep(0.1, 0.35, e) * (1 - smoothstep(0.65, 0.9, e));
}

// Dodge (+) or burn (−) in linear light: rgb · 2^(±k · w · t), k = exposure/100 stops (exposure 100% is
// one stop at full stroke strength), w the range weight of the pixel before the stroke, t = S·opacity·
// coverage. Channels clip at 1. Alpha is kept.
export function dodgeBurn(px, w, h, S, { burn = false, range = 'midtones', exposure = 50, opacity = 100 }, coverage = null) {
  const k = (burn ? -1 : 1) * exposure / 100; const op = opacity / 100; let painted = 0;
  for (let p = 0; p < w * h; p++) {
    if (!(S[p] > 0)) continue;
    const t = S[p] * op * cov(coverage, p); if (t <= 0) continue;
    const q = p * 4; const lin = [decode(px[q]), decode(px[q + 1]), decode(px[q + 2])];
    const e = oetf(0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]);
    const f = 2 ** (k * rangeWeight(range, e) * t);
    for (let c = 0; c < 3; c++) px[q + c] = enc8(lin[c] * f);
    painted++;
  }
  return { painted };
}

// Linear sRGB ↔ Oklab (Björn Ottosson, 2020).
export function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
export function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
export const chroma = (lin) => { const [, a, b] = linearToOklab(lin); return Math.hypot(a, b); };

// Sponge in Oklab: chroma × (1 + k·t) to saturate or × (1 − k·t) to desaturate, k = amount/100,
// lightness and hue kept. A saturated colour that leaves the sRGB gamut is pulled back by bisection
// on the chroma scale (12 steps) to the largest scale that stays inside.
export function sponge(px, w, h, S, { saturate = false, amount = 50, opacity = 100 }, coverage = null) {
  const k = amount / 100; const op = opacity / 100; let painted = 0;
  const inGamut = (v) => v.every((x) => x >= -1e-6 && x <= 1 + 1e-6);
  for (let p = 0; p < w * h; p++) {
    if (!(S[p] > 0)) continue;
    const t = S[p] * op * cov(coverage, p); if (t <= 0) continue;
    const q = p * 4; const lab = linearToOklab([decode(px[q]), decode(px[q + 1]), decode(px[q + 2])]);
    let s = saturate ? 1 + k * t : Math.max(0, 1 - k * t);
    let out = oklabToLinear([lab[0], lab[1] * s, lab[2] * s]);
    if (!inGamut(out)) {
      let lo = Math.min(1, s); let hi = s;
      for (let it = 0; it < 12; it++) { const mid = (lo + hi) / 2; if (inGamut(oklabToLinear([lab[0], lab[1] * mid, lab[2] * mid]))) lo = mid; else hi = mid; }
      s = lo; out = oklabToLinear([lab[0], lab[1] * s, lab[2] * s]);
    }
    for (let c = 0; c < 3; c++) px[q + c] = enc8(out[c]);
    painted++;
  }
  return { painted };
}

// ---- quick mask ------------------------------------------------------------------------------------

// Paints the selection itself (document-size, 8-bit): sel ← sel + (v − sel)·t, t = S·opacity, where v
// is the brush colour's display-encoded luminance (white 255 adds, black 0 removes) scaled by its
// alpha through t, and the eraser paints v = 0.
export function paintSelection(sel, S, { value = 255, alpha = 1, opacity = 100 }) {
  const op = (opacity / 100) * alpha; let painted = 0;
  for (let p = 0; p < sel.length; p++) {
    if (!(S[p] > 0)) continue;
    const t = S[p] * op;
    sel[p] = Math.round(sel[p] + (value - sel[p]) * t); painted++;
  }
  return { painted };
}
