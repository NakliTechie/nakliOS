// Pure helpers between model outputs and Atelier masks: resampling a model's low-resolution mask onto a
// layer's or the document's pixel grid, coverage numbers, and the classical edge refine for smart selection
// (L69), and the trimap and colour guided filter behind refine_edge (P20, select and mask). No GPU, no DOM,
// so node tests check them on small grids. Masks are 8-bit planes (0..255, row-major).

import { boxBlur, rasterPolygon, combine, contract, invert } from '../select/raster.js';

// Bilinear stretch of a w × h plane over W × H (pixel centres: x_src = (x + 0.5) · w / W − 0.5, edges clamped).
export function stretch(src, w, h, W, H) {
  if (w === W && h === H) return Uint8Array.from(src);
  const out = new Uint8Array(W * H);
  const sx = w / W; const sy = h / H;
  const x0 = new Int32Array(W); const x1 = new Int32Array(W); const fx = new Float32Array(W);
  for (let i = 0; i < W; i++) { const g = Math.min(w - 1, Math.max(0, (i + 0.5) * sx - 0.5)); x0[i] = Math.floor(g); x1[i] = Math.min(w - 1, x0[i] + 1); fx[i] = g - x0[i]; }
  for (let j = 0; j < H; j++) {
    const g = Math.min(h - 1, Math.max(0, (j + 0.5) * sy - 0.5)); const j0 = Math.floor(g); const j1 = Math.min(h - 1, j0 + 1); const fy = g - j0;
    const r0 = j0 * w; const r1 = j1 * w; const o = j * W;
    for (let i = 0; i < W; i++) {
      const a = src[r0 + x0[i]] + (src[r0 + x1[i]] - src[r0 + x0[i]]) * fx[i];
      const b = src[r1 + x0[i]] + (src[r1 + x1[i]] - src[r1 + x0[i]]) * fx[i];
      out[o + i] = Math.round(a + (b - a) * fy);
    }
  }
  return out;
}

// Mean coverage 0..1 (the mask area fraction reported to the agent).
export function coverage(mask) { let s = 0; for (let i = 0; i < mask.length; i++) s += mask[i]; return mask.length ? s / (255 * mask.length) : 0; }

export const invertPlane = (m) => { const out = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) out[i] = 255 - m[i]; return out; };

// A model's answer for one mask target → an 8-bit plane at the model's output grid.
// people and sky: DETR's semantic plane for that group (one call answers both); subject: IS-Net's foreground;
// background: its complement; object: the SAM mask for the click.
export function targetPlane(target, result) {
  if (result.planes) { const p = result.planes[target]; if (!p) throw new Error(`the model answered no ${target} plane`); return p; }
  if (target === 'background') return invertPlane(result.mask);
  return result.mask;
}

// DETR label patterns per semantic group (the model's id2label names). The config names the merged COCO
// panoptic stuff classes LABEL_<id>; id 187 is sky-other-merged. 'skyscraper' also starts with 'sky', so the
// sky pattern excludes it.
export const SEMANTIC_GROUPS = Object.freeze({ people: ['^person$'], sky: ['^sky(?!scraper)', '^LABEL_187$'] });

// Point in document px → the same point in a layer's source px (inverse of the layer matrix [a,b,c,d,e,f]).
export function docToSource(m, [x, y]) {
  const [a, b, c, d, e, f] = m; const det = a * d - b * c;
  const dx = x - e; const dy = y - f;
  return [(d * dx - c * dy) / det, (-b * dx + a * dy) / det];
}

// ---- smart selection: guided-filter edge snap (L69) -------------------------------------------------
// Rough mask p (0..255) and an RGBA image guide I (straight sRGB 8-bit). Inside a band of `band` px around the
// rough edge the mask is recomputed by a grey-guide guided filter (He, Sun and Tang, 2010):
//   a = cov(I, p) / (var(I) + eps),  b = mean(p) − a · mean(I),  q = a · I + b
// with box means of radius r and I, p in 0..1, then snapped by alpha = clamp((q − 0.5) · sharpness + 0.5, 0, 1).
// The coefficients are used per pixel (the filter's second averaging of a and b is skipped), because that
// averaging spreads the snapped edge over about half the window.
// Outside the band the rough mask stays as it was. Returns { mask, band } (band: pixel count refined).
export function guidedRefine(rough, rgba, w, h, { band = 8, radius = 8, eps = 1e-3, sharpness = 8 } = {}) {
  const n = w * h;
  const I = new Float32Array(n); const p = new Float32Array(n);
  for (let i = 0; i < n; i++) { I[i] = (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255; p[i] = rough[i] / 255; }
  const mean = (x) => boxBlur(x, w, h, 1, radius);
  const II = new Float32Array(n); const Ip = new Float32Array(n);
  for (let i = 0; i < n; i++) { II[i] = I[i] * I[i]; Ip[i] = I[i] * p[i]; }
  const mI = mean(I); const mp = mean(p); const mII = mean(II); const mIp = mean(Ip);
  const A = new Float32Array(n); const B = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = mII[i] - mI[i] * mI[i]; const cv = mIp[i] - mI[i] * mp[i]; A[i] = cv / (v + eps); B[i] = mp[i] - A[i] * mI[i]; }
  // The band: pixels within `band` px of a rough edge (where the rough mask's box mean is strictly between 0 and 1).
  const near = boxBlur(p, w, h, 1, Math.max(1, Math.round(band)));
  const out = new Uint8Array(n); let refined = 0;
  for (let i = 0; i < n; i++) {
    if (near[i] > 1e-4 && near[i] < 1 - 1e-4) {
      const q = A[i] * I[i] + B[i];
      out[i] = Math.round(255 * Math.min(1, Math.max(0, (q - 0.5) * sharpness + 0.5)));
      refined++;
    } else out[i] = rough[i];
  }
  return { mask: out, band: refined };
}

// Rough outline (polygon in px) or an existing mask → the rough plane smart selection starts from.
export function roughFrom({ outline, mask }, w, h) {
  if (outline) return rasterPolygon(w, h, outline);
  return mask;
}

export { combine };

// ---- select and mask: trimap and colour guided filter (P20) ----------------------------------------
// Trimap from a selection: the selection thresholded at 128, then foreground = that set contracted by band px,
// background = its complement contracted by band px, unknown (128) = the 2·band px wide strip between.
export function trimapFrom(sel, w, h, band) {
  const bin = new Uint8Array(sel.length); for (let i = 0; i < sel.length; i++) bin[i] = sel[i] >= 128 ? 255 : 0;
  const r = Math.max(1, band);
  const fg = contract(bin, w, h, r); const bg = contract(invert(bin), w, h, r);
  const tri = new Uint8Array(sel.length); let unknown = 0;
  for (let i = 0; i < tri.length; i++) { tri[i] = fg[i] >= 128 ? 255 : bg[i] >= 128 ? 0 : 128; if (tri[i] === 128) unknown++; }
  return { trimap: tri, unknown };
}

// The bounding box of the trimap's unknown pixels, padded by pad and clamped: { x, y, w, h } or null.
export function unknownBox(tri, w, h, pad) {
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (tri[y * w + x] === 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// A w × h window of a plane with ch channels (row stride W).
export function crop(src, W, ch, { x, y, w, h }) {
  const out = new (src.constructor)(w * h * ch);
  for (let j = 0; j < h; j++) out.set(src.subarray(((y + j) * W + x) * ch, ((y + j) * W + x + w) * ch), j * w * ch);
  return out;
}

// Classical trimap matting for the unknown band, in two steps (I the RGB image in 0..1):
// 1. Colour estimate. F and B are the box means (radius reach = 2·band + 1, so every unknown pixel sees both
//    sides) of the known foreground and background colours; with d = F − B,
//      alpha0 = clamp(((I − B) · d) / |d|², 0, 1)
//    (the projection of I onto the line from B to F). Where |d|² < 0.004 the two sides look alike and alpha0
//    falls back to the rough selection.
// 2. Colour guided filter (He, Sun and Tang, 2010, colour-guide form) with p = alpha0 (the trimap where known):
//      Σ = cov(I) + eps·U (3 × 3),  a = Σ⁻¹ · cov(I, p),  b = mean(p) − aᵀ · mean(I),  q = mean(a)ᵀ · I + mean(b)
//    with box means of radius r, which removes noise in alpha0 while keeping colour edges (hair strands).
// In the band alpha = clamp(q, 0, 1); known pixels keep 0 or 255. Returns a Uint8Array alpha.
export function trimapMatte(tri, rough, rgba, w, h, { band = 8, radius = 2, eps = 1e-3 } = {}) {
  const n = w * h;
  const S = new Float32Array(n * 8);   // fg r g b, fg weight, bg r g b, bg weight
  for (let i = 0; i < n; i++) {
    const o = i * 8; const r = rgba[i * 4] / 255; const g = rgba[i * 4 + 1] / 255; const b = rgba[i * 4 + 2] / 255;
    if (tri[i] === 255) { S[o] = r; S[o + 1] = g; S[o + 2] = b; S[o + 3] = 1; } else if (tri[i] === 0) { S[o + 4] = r; S[o + 5] = g; S[o + 6] = b; S[o + 7] = 1; }
  }
  const SM = boxBlur(S, w, h, 8, 2 * Math.max(1, Math.round(band)) + 1);
  const p0 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (tri[i] !== 128) { p0[i] = tri[i] / 255; continue; }
    const o = i * 8; const wf = SM[o + 3]; const wb = SM[o + 7];
    if (wf < 1e-6 || wb < 1e-6) { p0[i] = rough[i] / 255; continue; }
    const F = [SM[o] / wf, SM[o + 1] / wf, SM[o + 2] / wf]; const B = [SM[o + 4] / wb, SM[o + 5] / wb, SM[o + 6] / wb];
    const d0 = F[0] - B[0]; const d1 = F[1] - B[1]; const d2 = F[2] - B[2]; const dd = d0 * d0 + d1 * d1 + d2 * d2;
    if (dd < 0.004) { p0[i] = rough[i] / 255; continue; }
    const x = ((rgba[i * 4] / 255 - B[0]) * d0 + (rgba[i * 4 + 1] / 255 - B[1]) * d1 + (rgba[i * 4 + 2] / 255 - B[2]) * d2) / dd;
    p0[i] = Math.min(1, Math.max(0, x));
  }
  const q = guidedColour(p0, rgba, w, h, radius, eps);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = tri[i] !== 128 ? tri[i] : Math.round(255 * Math.min(1, Math.max(0, q[i])));
  return out;
}

// The colour guided filter's output q for a float plane p (formula above trimapMatte).
function guidedColour(p, rgba, w, h, radius, eps) {
  const n = w * h;
  const F = new Float32Array(n * 13);   // r g b · p · rr rg rb gg gb bb · rp gp bp
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4] / 255; const g = rgba[i * 4 + 1] / 255; const b = rgba[i * 4 + 2] / 255; const v = p[i]; const o = i * 13;
    F[o] = r; F[o + 1] = g; F[o + 2] = b; F[o + 3] = v;
    F[o + 4] = r * r; F[o + 5] = r * g; F[o + 6] = r * b; F[o + 7] = g * g; F[o + 8] = g * b; F[o + 9] = b * b;
    F[o + 10] = r * v; F[o + 11] = g * v; F[o + 12] = b * v;
  }
  const M = boxBlur(F, w, h, 13, radius);
  const AB = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 13; const mr = M[o]; const mg = M[o + 1]; const mb = M[o + 2]; const mp = M[o + 3];
    const a11 = M[o + 4] - mr * mr + eps; const a12 = M[o + 5] - mr * mg; const a13 = M[o + 6] - mr * mb;
    const a22 = M[o + 7] - mg * mg + eps; const a23 = M[o + 8] - mg * mb; const a33 = M[o + 9] - mb * mb + eps;
    const c1 = M[o + 10] - mr * mp; const c2 = M[o + 11] - mg * mp; const c3 = M[o + 12] - mb * mp;
    // Σ⁻¹ by cofactors (Σ is symmetric).
    const i11 = a22 * a33 - a23 * a23; const i12 = a13 * a23 - a12 * a33; const i13 = a12 * a23 - a13 * a22;
    const i22 = a11 * a33 - a13 * a13; const i23 = a13 * a12 - a11 * a23; const i33 = a11 * a22 - a12 * a12;
    const det = a11 * i11 + a12 * i12 + a13 * i13;
    const k = Math.abs(det) > 1e-18 ? 1 / det : 0;
    const ar = k * (i11 * c1 + i12 * c2 + i13 * c3); const ag = k * (i12 * c1 + i22 * c2 + i23 * c3); const ab = k * (i13 * c1 + i23 * c2 + i33 * c3);
    const q = i * 4; AB[q] = ar; AB[q + 1] = ag; AB[q + 2] = ab; AB[q + 3] = mp - ar * mr - ag * mg - ab * mb;
  }
  const MA = boxBlur(AB, w, h, 4, radius);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) { const o = i * 4; q[i] = MA[o] * F[i * 13] + MA[o + 1] * F[i * 13 + 1] + MA[o + 2] * F[i * 13 + 2] + MA[o + 3]; }
  return q;
}

// Bilinear stretch of an interleaved RGBA image (each channel through stretch).
export function stretchRGBA(src, w, h, W, H) {
  if (w === W && h === H) return Uint8ClampedArray.from(src);
  const out = new Uint8ClampedArray(W * H * 4); const ch = new Uint8Array(w * h);
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i < w * h; i++) ch[i] = src[i * 4 + c];
    const s = stretch(ch, w, h, W, H);
    for (let i = 0; i < W * H; i++) out[i * 4 + c] = s[i];
  }
  return out;
}

// FNV-1a 32-bit over an image's bytes and size: the key that lets four masks of one photo share one inference.
export function imageKey({ width, height, data }) {
  let x = 0x811c9dc5 ^ width; x = Math.imul(x, 16777619) ^ height;
  for (let i = 0; i < data.length; i++) { x ^= data[i]; x = Math.imul(x, 16777619); }
  return `${width}x${height}:${(x >>> 0).toString(16)}`;
}
