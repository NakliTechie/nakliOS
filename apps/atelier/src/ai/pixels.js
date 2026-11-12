// Pure pixel maths for the on-device image-to-image models (denoise, upscale, inpaint) and the classical
// parts of photo restoration. No GPU, no DOM, no model: node tests check every formula with stand-in
// "models". The model sessions live in src/ai/pixels-ort.js. Formulas are Atelier's own.
//
// Images here are Float32Array, interleaved HWC, values 0..1 in display-encoded sRGB (the space the
// models were trained in). u8 RGBA buffers are the renderer's 8-bit straight-alpha sRGB pixels.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---- conversions -----------------------------------------------------------------------------------

// RGBA u8 (w × h) → RGB float HWC 0..1.
export function rgbaToFloat(px, w, h) {
  const out = new Float32Array(w * h * 3);
  for (let p = 0; p < w * h; p++) { out[p * 3] = px[p * 4] / 255; out[p * 3 + 1] = px[p * 4 + 1] / 255; out[p * 3 + 2] = px[p * 4 + 2] / 255; }
  return out;
}
// RGB float HWC + alpha (u8 per pixel, or a constant 0..255) → RGBA u8.
export function floatToRgba(f, w, h, alpha = 255) {
  const out = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    out[p * 4] = Math.round(255 * clamp01(f[p * 3])); out[p * 4 + 1] = Math.round(255 * clamp01(f[p * 3 + 1])); out[p * 4 + 2] = Math.round(255 * clamp01(f[p * 3 + 2]));
    out[p * 4 + 3] = typeof alpha === 'number' ? alpha : alpha[p];
  }
  return out;
}
// HWC → CHW (the ONNX tensor layout) and back.
export function hwcToChw(f, w, h, c) {
  const out = new Float32Array(w * h * c);
  for (let p = 0; p < w * h; p++) for (let k = 0; k < c; k++) out[k * w * h + p] = f[p * c + k];
  return out;
}
export function chwToHwc(f, w, h, c) {
  const out = new Float32Array(w * h * c);
  for (let p = 0; p < w * h; p++) for (let k = 0; k < c; k++) out[p * c + k] = f[k * w * h + p];
  return out;
}

// ---- tiled inference -------------------------------------------------------------------------------

// Tile start positions along one axis of length L for windows of length T overlapping by at least ov:
// 0, T − ov, 2(T − ov), … and a last window flush with the far edge.
export function tileStarts(L, T, ov) {
  if (L <= T) return [0];
  const step = Math.max(1, T - ov); const s = [];
  for (let x = 0; x + T < L; x += step) s.push(x);
  s.push(L - T);
  return s;
}

// Blend weight along one axis for a pixel at local position x (centre x + 0.5) in a window [s, s + T)
// of an axis of length L: a linear ramp over the first ov pixels when another tile lies before, and over
// the last ov pixels when another lies after; 1 elsewhere and at the image edges. Always > 0.
//   w(x) = min(1, (x + 0.5)/ov if s > 0) · min(1, (T − x − 0.5)/ov if s + T < L)
export function rampWeight(x, s, T, L, ov) {
  let w = 1;
  if (s > 0) w = Math.min(w, (x + 0.5) / ov);
  if (s + T < L) w = Math.min(w, (T - x - 0.5) / ov);
  return w;
}

// Runs a model over overlapping tiles and blends the results with feathered weights, so a large photo
// fits in memory and tile borders leave no seam:
//   out(p) = Σ_t w_t(p) · model_t(p) / Σ_t w_t(p)
// src: { w, h, c, read(x, y, tw, th) → Float32Array HWC tw·th·c } (the read stays inside the image).
// opts: tile (window edge, input px), overlap, scale (output px per input px), outC, multiple (window edges
//   are padded to a multiple of this by repeating the edge pixel; an image smaller than the tile is padded
//   up to the next multiple), run(t, tw, th, at) → Float32Array HWC (tw·scale × th·scale × outC), or
//   null to keep the input (only when scale is 1 and outC equals c).
// Returns { data: Float32Array HWC, w: w·scale, h: h·scale, c: outC, tiles, ran }.
export async function tileInfer(src, { tile, overlap, scale = 1, outC = src.c, multiple = 1, run, onTile }) {
  const { w, h, c } = src;
  const up = (n) => Math.ceil(n / multiple) * multiple;
  const Tw = w <= tile ? up(w) : tile; const Th = h <= tile ? up(h) : tile;
  const xs = tileStarts(w, Tw, overlap); const ys = tileStarts(h, Th, overlap);
  const W = w * scale; const H = h * scale;
  const acc = new Float32Array(W * H * outC); const wsum = new Float32Array(W * H);
  let n = 0; let ran = 0; const total = xs.length * ys.length;
  for (const y0 of ys) for (const x0 of xs) {
    const rw = Math.min(Tw, w - x0); const rh = Math.min(Th, h - y0);
    const real = src.read(x0, y0, rw, rh);
    let t = real;
    if (rw !== Tw || rh !== Th) {   // pad by repeating the last row and column
      t = new Float32Array(Tw * Th * c);
      for (let j = 0; j < Th; j++) for (let i = 0; i < Tw; i++) {
        const q = (Math.min(j, rh - 1) * rw + Math.min(i, rw - 1)) * c;
        for (let k = 0; k < c; k++) t[(j * Tw + i) * c + k] = real[q + k];
      }
    }
    let o = await run(t, Tw, Th, { x: x0, y: y0, index: n, total });
    if (o === null) { if (scale !== 1 || outC !== c) throw new Error('run may return null only for a same-size, same-channel model'); o = t; } else ran++;
    const oTw = Tw * scale;
    if (o.length !== oTw * Th * scale * outC) throw new Error(`model output has ${o.length} values; expected ${oTw * Th * scale * outC}`);
    // Weights are computed in input pixels at each output pixel's centre: x_in = (x_out + 0.5)/scale − 0.5.
    const wx = new Float32Array(rw * scale); const wy = new Float32Array(rh * scale);
    for (let i = 0; i < rw * scale; i++) wx[i] = rampWeight((i + 0.5) / scale - 0.5, x0, Tw, w, overlap);
    for (let j = 0; j < rh * scale; j++) wy[j] = rampWeight((j + 0.5) / scale - 0.5, y0, Th, h, overlap);
    for (let j = 0; j < rh * scale; j++) {
      const Y = y0 * scale + j;
      for (let i = 0; i < rw * scale; i++) {
        const X = x0 * scale + i; const wt = Math.max(1e-6, wx[i] * wy[j]);
        const P = Y * W + X; const q = (j * oTw + i) * outC;
        wsum[P] += wt;
        for (let k = 0; k < outC; k++) acc[P * outC + k] += wt * o[q + k];
      }
    }
    n++; onTile?.(n, total);
  }
  for (let P = 0; P < W * H; P++) { const s = wsum[P]; for (let k = 0; k < outC; k++) acc[P * outC + k] /= s; }
  return { data: acc, w: W, h: H, c: outC, tiles: total, ran };
}

// A tile reader over a HWC float image.
export const floatReader = (f, w, h, c) => ({ w, h, c, read(x0, y0, tw, th) {
  const out = new Float32Array(tw * th * c);
  for (let j = 0; j < th; j++) out.set(f.subarray(((y0 + j) * w + x0) * c, ((y0 + j) * w + x0 + tw) * c), j * tw * c);
  return out;
} });
// A tile reader over an 8-bit RGBA image (RGB only, 0..1), so a 24 MP photo is never held as floats.
export const rgbaReader = (px, w, h) => ({ w, h, c: 3, read(x0, y0, tw, th) {
  const out = new Float32Array(tw * th * 3);
  for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) { const k = ((y0 + j) * w + x0 + i) * 4; const q = (j * tw + i) * 3; out[q] = px[k] / 255; out[q + 1] = px[k + 1] / 255; out[q + 2] = px[k + 2] / 255; }
  return out;
} });

// ---- resampling ------------------------------------------------------------------------------------

// Bilinear resize of HWC float (centre convention, edge clamp).
export function resizeBilinear(f, w, h, c, W, H) {
  if (W === w && H === h) return f.slice();
  const out = new Float32Array(W * H * c);
  for (let J = 0; J < H; J++) {
    const y = Math.min(h - 1, Math.max(0, (J + 0.5) * h / H - 0.5)); const j0 = Math.floor(y); const j1 = Math.min(h - 1, j0 + 1); const ty = y - j0;
    for (let I = 0; I < W; I++) {
      const x = Math.min(w - 1, Math.max(0, (I + 0.5) * w / W - 0.5)); const i0 = Math.floor(x); const i1 = Math.min(w - 1, i0 + 1); const tx = x - i0;
      for (let k = 0; k < c; k++) {
        const a = f[(j0 * w + i0) * c + k] * (1 - tx) + f[(j0 * w + i1) * c + k] * tx;
        const b = f[(j1 * w + i0) * c + k] * (1 - tx) + f[(j1 * w + i1) * c + k] * tx;
        out[(J * W + I) * c + k] = a * (1 - ty) + b * ty;
      }
    }
  }
  return out;
}

// Bicubic (Keys, a = −0.5) resize of HWC float, the baseline an upscaler is judged against.
export function resizeBicubic(f, w, h, c, W, H) {
  const k = (t) => { t = Math.abs(t); return t <= 1 ? 1.5 * t ** 3 - 2.5 * t ** 2 + 1 : t < 2 ? -0.5 * t ** 3 + 2.5 * t ** 2 - 4 * t + 2 : 0; };
  const out = new Float32Array(W * H * c);
  for (let J = 0; J < H; J++) {
    const y = (J + 0.5) * h / H - 0.5; const jy = Math.floor(y);
    for (let I = 0; I < W; I++) {
      const x = (I + 0.5) * w / W - 0.5; const ix = Math.floor(x);
      for (let ch = 0; ch < c; ch++) {
        let s = 0; let ws = 0;
        for (let m = -1; m <= 2; m++) for (let n = -1; n <= 2; n++) {
          const wt = k(x - (ix + n)) * k(y - (jy + m));
          const ii = Math.min(w - 1, Math.max(0, ix + n)); const jj = Math.min(h - 1, Math.max(0, jy + m));
          s += wt * f[(jj * w + ii) * c + ch]; ws += wt;
        }
        out[(J * W + I) * c + ch] = s / ws;
      }
    }
  }
  return out;
}

// PSNR in dB between two HWC float images in 0..1: 10·log10(1 / MSE).
export function psnr(a, b) {
  let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return 10 * Math.log10(1 / Math.max(1e-12, s / a.length));
}

// ---- masks -----------------------------------------------------------------------------------------

// Bounding box {x, y, w, h} of mask values above 0 (u8 or float), or null.
export function maskBox(m, w, h) {
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (m[j * w + i] > 0) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; if (j > y1) y1 = j; }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Binary dilation by a square of radius r (separable max), u8 0/255 → u8 0/255.
export function dilate(m, w, h, r) {
  if (r <= 0) return m.slice();
  const t = new Uint8Array(w * h); const out = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { let v = 0; for (let d = Math.max(0, i - r); d <= Math.min(w - 1, i + r) && !v; d++) v = m[j * w + d]; t[j * w + i] = v ? 255 : 0; }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { let v = 0; for (let d = Math.max(0, j - r); d <= Math.min(h - 1, j + r) && !v; d++) v = t[d * w + i]; out[j * w + i] = v ? 255 : 0; }
  return out;
}

// Box blur of radius r (separable mean), u8 → Float32 0..1.
export function boxBlur(m, w, h, r) {
  const f = Float32Array.from(m, (v) => v / 255);
  if (r <= 0) return f;
  const t = new Float32Array(w * h); const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { let s = 0; let n = 0; for (let d = i - r; d <= i + r; d++) { s += f[j * w + Math.min(w - 1, Math.max(0, d))]; n++; } t[j * w + i] = s / n; }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { let s = 0; let n = 0; for (let d = j - r; d <= j + r; d++) { s += t[Math.min(h - 1, Math.max(0, d)) * w + i]; n++; } out[j * w + i] = s / n; }
  return out;
}

// Soft alpha for an inpainted hole: the hole grown by `grow` px, then box-blurred by `feather` px, and
// never below 1 inside the original hole: a = max(hole, blur(dilate(hole, grow), feather)).
export function softMask(m, w, h, grow = 3, feather = 2) {
  const a = boxBlur(dilate(m, w, h, grow), w, h, feather);
  for (let p = 0; p < w * h; p++) if (m[p] > 0) a[p] = 1;
  return a;
}

// ---- inpainting plan -------------------------------------------------------------------------------

// The region an inpainting model sees for a hole box b in an image W × H: the box grown by half its
// larger side (at least 32 px) on every side, then widened to at least min(window, image) per axis so
// a small hole still gets a full window of context; clamped to the image.
// The working scale s = min(1, maxWork / max(cw, ch)) shrinks a large region before the model runs.
export function inpaintRegion(b, W, H, { window = 512, maxWork = 512 } = {}) {
  const m = Math.max(32, Math.round(Math.max(b.w, b.h) / 2));
  let x0 = b.x - m; let y0 = b.y - m; let x1 = b.x + b.w + m; let y1 = b.y + b.h + m;
  const widen = (a0, a1, L) => {
    const need = Math.min(window, L) - (a1 - a0);
    if (need > 0) { a0 -= Math.floor(need / 2); a1 += Math.ceil(need / 2); }
    if (a0 < 0) { a1 -= a0; a0 = 0; }
    if (a1 > L) { a0 -= a1 - L; a1 = L; }
    return [Math.max(0, a0), Math.min(L, a1)];
  };
  [x0, x1] = widen(x0, x1, W); [y0, y1] = widen(y0, y1, H);
  const cw = x1 - x0; const ch = y1 - y0;
  const s = Math.min(1, maxWork / Math.max(cw, ch));
  return { x: x0, y: y0, w: cw, h: ch, scale: s, workW: Math.max(1, Math.round(cw * s)), workH: Math.max(1, Math.round(ch * s)) };
}

// Inpaints the hole m (u8, w × h, > 0 = fill) of img (RGB float HWC) inside region r (from inpaintRegion).
// model(t4, T, T) takes a T × T × 4 tile (RGB with the hole zeroed, then the hole as 0/1) and returns
// T × T × 3. The region is resized to the working scale, run in windows of `window` px (windows with no
// hole are skipped), and resized back. Returns the filled region (RGB float HWC, r.w × r.h).
export async function inpaint(img, m, w, h, r, model, { window = 512, overlap = 128, onTile } = {}) {
  const crop = new Float32Array(r.w * r.h * 3); const cm = new Float32Array(r.w * r.h);
  for (let j = 0; j < r.h; j++) for (let i = 0; i < r.w; i++) {
    const p = (r.y + j) * w + r.x + i; const q = j * r.w + i;
    crop[q * 3] = img[p * 3]; crop[q * 3 + 1] = img[p * 3 + 1]; crop[q * 3 + 2] = img[p * 3 + 2]; cm[q] = m[p] > 0 ? 1 : 0;
  }
  const wc = resizeBilinear(crop, r.w, r.h, 3, r.workW, r.workH);
  const wm = resizeBilinear(cm, r.w, r.h, 1, r.workW, r.workH);
  const four = new Float32Array(r.workW * r.workH * 4);
  for (let q = 0; q < r.workW * r.workH; q++) {
    const hole = wm[q] > 0.01 ? 1 : 0;   // any coverage after resizing counts as hole
    for (let k = 0; k < 3; k++) four[q * 4 + k] = hole ? 0 : wc[q * 3 + k];
    four[q * 4 + 3] = hole;
  }
  const out = await tileInfer(floatReader(four, r.workW, r.workH, 4), {
    tile: window, overlap, multiple: window, outC: 3, onTile,
    run: async (t, tw, th) => {
      let any = false; for (let q = 0; q < tw * th && !any; q++) any = t[q * 4 + 3] > 0;
      if (any) return model(t, tw, th);
      const rgb = new Float32Array(tw * th * 3);   // no hole: the tile passes through unchanged
      for (let q = 0; q < tw * th; q++) { rgb[q * 3] = t[q * 4]; rgb[q * 3 + 1] = t[q * 4 + 1]; rgb[q * 3 + 2] = t[q * 4 + 2]; }
      return rgb;
    },
  });
  return resizeBilinear(out.data, r.workW, r.workH, 3, r.w, r.h);
}

// A raster layer (doc-size RGBA u8) holding fill pixels at alpha a·255 inside region r, transparent
// elsewhere: the "Removed" or "Restored" layer that sits over the photo.
export function patchLayer(fill, r, alpha, W, H) {
  const out = new Uint8Array(W * H * 4);
  for (let j = 0; j < r.h; j++) for (let i = 0; i < r.w; i++) {
    const P = (r.y + j) * W + r.x + i; const a = alpha[P];
    if (!(a > 0)) continue;
    const q = (j * r.w + i) * 3;
    out[P * 4] = Math.round(255 * clamp01(fill[q])); out[P * 4 + 1] = Math.round(255 * clamp01(fill[q + 1])); out[P * 4 + 2] = Math.round(255 * clamp01(fill[q + 2]));
    out[P * 4 + 3] = Math.round(255 * clamp01(a));
  }
  return out;
}

// ---- generative expand -----------------------------------------------------------------------------

// Expansion in px per side for a percentage of the canvas (each axis grows by pct, split evenly unless
// `sides` names only some of 'top', 'right', 'bottom', 'left').
export function expandMargins(W, H, pct, sides = ['top', 'right', 'bottom', 'left']) {
  const gx = Math.round(W * pct / 100); const gy = Math.round(H * pct / 100);
  const lr = (sides.includes('left') ? 1 : 0) + (sides.includes('right') ? 1 : 0);
  const tb = (sides.includes('top') ? 1 : 0) + (sides.includes('bottom') ? 1 : 0);
  const m = { top: 0, right: 0, bottom: 0, left: 0 };
  if (lr) { const each = Math.floor(gx / lr); if (sides.includes('left')) m.left = each; if (sides.includes('right')) m.right = gx - (sides.includes('left') ? each : 0); }
  if (tb) { const each = Math.floor(gy / tb); if (sides.includes('top')) m.top = each; if (sides.includes('bottom')) m.bottom = gy - (sides.includes('top') ? each : 0); }
  return m;
}

// The expanded canvas: the composite placed at (left, top), the new border marked as hole (255), border
// pixels seeded by repeating the nearest edge pixel (the model fills them; the seed only matters where
// the working scale blurs across the boundary).
export function padCanvas(px, w, h, m) {
  const W = w + m.left + m.right; const H = h + m.top + m.bottom;
  const img = new Float32Array(W * H * 3); const hole = new Uint8Array(W * H);
  for (let J = 0; J < H; J++) for (let I = 0; I < W; I++) {
    const i = Math.min(w - 1, Math.max(0, I - m.left)); const j = Math.min(h - 1, Math.max(0, J - m.top));
    const inside = I - m.left === i && J - m.top === j;
    const k = (j * w + i) * 4; const P = J * W + I;
    img[P * 3] = px[k] / 255; img[P * 3 + 1] = px[k + 1] / 255; img[P * 3 + 2] = px[k + 2] / 255;
    hole[P] = inside && px[k + 3] > 0 ? 0 : 255;
  }
  return { img, hole, W, H };
}

// ---- restoration (L68): classical dust and scratch detection, faded colour --------------------------

// Display luminance (Rec.709 weights on display-encoded values), 0..1 per pixel, from RGBA u8.
export function luma(px, w, h) {
  const y = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) y[p] = (0.2126 * px[p * 4] + 0.7152 * px[p * 4 + 1] + 0.0722 * px[p * 4 + 2]) / 255;
  return y;
}

// Median of a (2r + 1)² window at every pixel (edge clamp), by a 64-bin histogram per row, slid along it.
// Values are quantised to 1/63, which is fine for the defect test below.
export function median(y, w, h, r) {
  const B = 64; const out = new Float32Array(w * h); const half = ((2 * r + 1) ** 2 + 1) / 2;
  const bin = (v) => Math.min(B - 1, Math.max(0, Math.round(v * (B - 1))));
  for (let j = 0; j < h; j++) {
    const hist = new Int32Array(B);
    const col = (i, sgn) => { const ii = Math.min(w - 1, Math.max(0, i)); for (let d = -r; d <= r; d++) hist[bin(y[Math.min(h - 1, Math.max(0, j + d)) * w + ii])] += sgn; };
    for (let i = -r; i <= r; i++) col(i, 1);
    for (let i = 0; i < w; i++) {
      let s = 0; let b = 0; for (; b < B; b++) { s += hist[b]; if (s >= half) break; }
      out[j * w + i] = b / (B - 1);
      col(i - r, -1); col(i + r + 1, 1);
    }
  }
  return out;
}

// Dust and scratch mask (u8 0/255). A pixel is a defect when it departs from the median of its
// (2r + 1)² neighbourhood by more than the threshold, and the departure is local: the median of the
// departures around it stays small (so an edge or texture, where many neighbours depart, is not marked).
//   d = |Y − median_r(Y)|,  defect ⇔ d > T and median_r(d) < T/2,  T = 0.40 − 0.30 · sensitivity/100
// r = 2 (a 5 × 5 window): on a real 512 × 384 crop with 860 painted defect pixels it found 799 and marked
// 322 others, where r = 3 marked 1,073 others (the sensitivity-50 threshold, measured 2026-11-12).
// The mask is grown by `grow` px so the fill covers the defect's soft rim.
export function detectDefects(px, w, h, { sensitivity = 50, radius = 2, grow = 1 } = {}) {
  const Y = luma(px, w, h); const M = median(Y, w, h, radius);
  const d = new Float32Array(w * h); for (let p = 0; p < w * h; p++) d[p] = Math.abs(Y[p] - M[p]);
  const md = median(d, w, h, radius);
  const T = 0.40 - 0.30 * Math.min(100, Math.max(0, sensitivity)) / 100;
  const m = new Uint8Array(w * h); let count = 0;
  for (let p = 0; p < w * h; p++) if (px[p * 4 + 3] > 0 && d[p] > T && md[p] < T / 2) { m[p] = 255; count++; }
  return { mask: grow > 0 ? dilate(m, w, h, grow) : m, count };
}

// Faded colour restore: a per-channel levels stretch. For each of R, G, B the lo and hi percentiles
// (default 0.5 % and 99.5 %) of the opaque pixels map to 0 and 1:
//   v' = clamp((v − lo_c) / (hi_c − lo_c)),  then mixed with the original by amount: v + (v' − v)·amount
// Faded dyes lift the black point and shift each channel by a different amount, so stretching each
// channel separately restores contrast and removes the cast. Returns { px (new RGBA u8), lo, hi }.
export function restoreFade(px, w, h, { amount = 100, clip = 0.5 } = {}) {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]; let n = 0;
  for (let p = 0; p < w * h; p++) { if (px[p * 4 + 3] === 0) continue; n++; for (let c = 0; c < 3; c++) hist[c][px[p * 4 + c]]++; }
  const lo = [0, 0, 0]; const hi = [255, 255, 255];
  if (n) for (let c = 0; c < 3; c++) {
    const cut = n * clip / 100; let s = 0; let v = 0;
    for (; v < 255; v++) { s += hist[c][v]; if (s > cut) break; } lo[c] = v;
    s = 0; for (v = 255; v > 0; v--) { s += hist[c][v]; if (s > cut) break; } hi[c] = v;
    if (hi[c] - lo[c] < 8) { lo[c] = 0; hi[c] = 255; }   // a flat channel is left alone
  }
  const k = amount / 100; const out = new Uint8Array(px.length);
  for (let p = 0; p < w * h; p++) {
    for (let c = 0; c < 3; c++) { const v = px[p * 4 + c]; const s = Math.min(255, Math.max(0, (v - lo[c]) * 255 / (hi[c] - lo[c]))); out[p * 4 + c] = Math.round(v + (s - v) * k); }
    out[p * 4 + 3] = px[p * 4 + 3];
  }
  return { px: out, lo, hi };
}

// Standard deviation of display luminance over a rect {x, y, w, h} of RGBA u8 (a noise measure on a flat patch).
export function patchStd(px, W, r) {
  let s = 0; let s2 = 0; let n = 0;
  for (let j = r.y; j < r.y + r.h; j++) for (let i = r.x; i < r.x + r.w; i++) {
    const k = (j * W + i) * 4; const v = (0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2]) / 255; s += v; s2 += v * v; n++;
  }
  return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
}
