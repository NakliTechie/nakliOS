// Portrait maths: person parsing around the MediaPipe selfie multiclass model (L61 hair, body skin, clothes),
// skin smoothing (P61), colour transfer (P61, classical), colourize around DDColor (P61) and fast neural
// style transfer (P61). Pure; node tests check each formula with stand-in models. Formulas are Atelier's own
// except where a published method is named. Pixels are RGBA u8, display-encoded sRGB, straight alpha.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);

// ---- person parsing ----------------------------------------------------------------------------------

// The model's six classes, in its output channel order.
export const PERSON_CLASSES = ['background', 'hair', 'body-skin', 'face-skin', 'clothes', 'others'];
// The parts ai_face_mask offers from it (skin-all = body skin + face skin).
export const PERSON_PARTS = { hair: [1], 'body-skin': [2], 'face-skin': [3], 'skin-all': [2, 3], clothes: [4], accessories: [5] };
export const PARSE_SIZE = 256;

// Bilinear sample of channel c at continuous pixel position (x, y), edge clamped.
function sample(px, w, h, x, y, c) {
  x = clamp(x, 0, w - 1); y = clamp(y, 0, h - 1);
  const x0 = Math.floor(x); const y0 = Math.floor(y); const x1 = Math.min(w - 1, x0 + 1); const y1 = Math.min(h - 1, y0 + 1); const tx = x - x0; const ty = y - y0;
  return (px[(y0 * w + x0) * 4 + c] * (1 - tx) + px[(y0 * w + x1) * 4 + c] * tx) * (1 - ty) + (px[(y1 * w + x0) * 4 + c] * (1 - tx) + px[(y1 * w + x1) * 4 + c] * tx) * ty;
}

// RGBA u8 (w × h) stretched (not letterboxed, as the model was trained) to S × S, NHWC float RGB 0..1.
export function parsingInput(px, w, h, S = PARSE_SIZE) {
  const out = new Float32Array(S * S * 3);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const x = (i + 0.5) * w / S - 0.5; const y = (j + 0.5) * h / S - 0.5; const o = (j * S + i) * 3;
    for (let c = 0; c < 3; c++) out[o + c] = sample(px, w, h, x, y, c) / 255;
  }
  return out;
}

// Logits NHWC [S, S, C] → the probability that each pixel belongs to any of `classes`, as u8 0..255:
//   p_k = exp(z_k − max z) / Σ_j exp(z_j − max z),  part = Σ_{k ∈ classes} p_k.
// (MediaPipe applies this softmax outside the graph.) An output already in 0..1 that sums to 1 is the same.
export function partPlane(logits, n, C, classes) {
  const out = new Uint8Array(n); const e = new Float64Array(C);
  for (let p = 0; p < n; p++) {
    let mx = -Infinity; for (let k = 0; k < C; k++) mx = Math.max(mx, logits[p * C + k]);
    let s = 0; for (let k = 0; k < C; k++) { e[k] = Math.exp(logits[p * C + k] - mx); s += e[k]; }
    let v = 0; for (const k of classes) v += e[k];
    out[p] = Math.round(255 * v / s);
  }
  return out;
}

// ---- skin smoothing (frequency separation over a skin mask) ------------------------------------------

// Separable box blur of an interleaved float image with c channels, radius r, edge clamped.
export function boxBlurC(f, w, h, c, r) {
  if (r < 1) return Float32Array.from(f);
  const t = new Float32Array(f.length); const out = new Float32Array(f.length); const n = 2 * r + 1;
  for (let k = 0; k < c; k++) {
    for (let j = 0; j < h; j++) {
      let s = 0; for (let d = -r; d <= r; d++) s += f[(j * w + clamp(d, 0, w - 1)) * c + k];
      for (let i = 0; i < w; i++) { t[(j * w + i) * c + k] = s / n; s += f[(j * w + Math.min(w - 1, i + r + 1)) * c + k] - f[(j * w + Math.max(0, i - r)) * c + k]; }
    }
    for (let i = 0; i < w; i++) {
      let s = 0; for (let d = -r; d <= r; d++) s += t[(clamp(d, 0, h - 1) * w + i) * c + k];
      for (let j = 0; j < h; j++) { out[(j * w + i) * c + k] = s / n; s += t[(Math.min(h - 1, j + r + 1) * w + i) * c + k] - t[(Math.max(0, j - r) * w + i) * c + k]; }
    }
  }
  return out;
}
// Two box passes: a tent-shaped kernel, closer to a Gaussian than one box.
const soften = (f, w, h, c, r) => boxBlurC(boxBlurC(f, w, h, c, r), w, h, c, r);

// The default smoothing radius from the skin area: r = max(2, round(√(skin pixels) / 40)), so a face about
// 400 px across gets r ≈ 9 and the result does not depend on the photo's resolution.
export function skinRadius(mask) { let n = 0; for (const v of mask) n += v / 255; return Math.max(2, Math.round(Math.sqrt(n) / 40)); }

// Frequency-separation skin smoothing. With I the image, S = soften(I, rs) (rs = max(1, round(r/4))) and the
// mask-weighted low pass L = soften(I·m, r) / soften(m, r) (only skin colours enter it):
//   out = L + (I − S) + (1 − a)(S − L),  a = amount/100
// The finest band I − S (pores, fine texture) is kept, the middle band S − L (blotches, uneven tone) is
// reduced by a, and the tone L is the skin's own. The layer's alpha is the skin mask. Returns RGBA u8.
export function smoothSkin(px, w, h, mask, { amount = 60, radius } = {}) {
  const r = radius ?? skinRadius(mask); const rs = Math.max(1, Math.round(r / 4)); const a = clamp01(amount / 100);
  const I = new Float32Array(w * h * 3); const Im = new Float32Array(w * h * 3); const m = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) { m[p] = mask[p] / 255; for (let c = 0; c < 3; c++) { I[p * 3 + c] = px[p * 4 + c] / 255; Im[p * 3 + c] = I[p * 3 + c] * m[p]; } }
  const S = soften(I, w, h, 3, rs); const Ln = soften(Im, w, h, 3, r); const Ld = soften(m, w, h, 1, r);
  const out = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const ok = Ld[p] > 1e-3;
    for (let c = 0; c < 3; c++) {
      const i = p * 3 + c; const L = ok ? Ln[i] / Ld[p] : I[i];
      out[p * 4 + c] = Math.round(255 * clamp01(L + (I[i] - S[i]) + (1 - a) * (S[i] - L)));
    }
    out[p * 4 + 3] = mask[p];
  }
  return { px: out, radius: r, fineRadius: rs };
}

// ---- CIELAB (D65, sRGB) ------------------------------------------------------------------------------

const dec = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const enc = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const WX = 0.95047; const WZ = 1.08883;
const fLab = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const fInv = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
// sRGB 0..1 → [L 0..100, a, b].
export function rgbToLab(r, g, b) {
  r = dec(r); g = dec(g); b = dec(b);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / WX; const y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b; const z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / WZ;
  const fx = fLab(x); const fy = fLab(y); const fz = fLab(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
// [L, a, b] → sRGB 0..1 (clamped).
export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116; const x = WX * fInv(fy + a / 500); const y = fInv(fy); const z = WZ * fInv(fy - b / 200);
  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z; const g = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z; const bb = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return [clamp01(enc(clamp01(r))), clamp01(enc(clamp01(g))), clamp01(enc(clamp01(bb)))];
}
export function toLab(px, n) { const o = new Float32Array(n * 3); for (let p = 0; p < n; p++) o.set(rgbToLab(px[p * 4] / 255, px[p * 4 + 1] / 255, px[p * 4 + 2] / 255), p * 3); return o; }

// ---- colour transfer (classical) ----------------------------------------------------------------------

// Mean and standard deviation of each Lab channel over pixels with alpha > 0.
export function labStats(lab, px, n) {
  const s = [0, 0, 0]; const q = [0, 0, 0]; let k = 0;
  for (let p = 0; p < n; p++) { if (px[p * 4 + 3] === 0) continue; k++; for (let c = 0; c < 3; c++) { const v = lab[p * 3 + c]; s[c] += v; q[c] += v * v; } }
  const mean = s.map((v) => v / (k || 1)); const sd = q.map((v, c) => Math.sqrt(Math.max(0, v / (k || 1) - mean[c] ** 2)));
  return { mean, sd, n: k };
}
// Reinhard et al., "Color Transfer between Images" (2001): match each channel's mean and spread to the
// reference's, here in CIELAB instead of the paper's lαβ:
//   x' = (x − μ_src) · σ_ref / σ_src + μ_ref,  out = x + t (x' − x),  t = amount/100
// (σ_src below 0.5 Lab units is treated as 0.5, so a flat channel is shifted, not stretched without bound).
// Returns RGBA u8 with the source alpha.
export function colourTransfer(px, w, h, ref, rw, rh, { amount = 100 } = {}) {
  const n = w * h; const lab = toLab(px, n); const src = labStats(lab, px, n);
  const dst = labStats(toLab(ref, rw * rh), ref, rw * rh); const t = clamp01(amount / 100);
  const k = [0, 1, 2].map((c) => dst.sd[c] / Math.max(0.5, src.sd[c]));
  const out = new Uint8Array(n * 4);
  for (let p = 0; p < n; p++) {
    const v = [0, 1, 2].map((c) => { const x = lab[p * 3 + c]; return x + t * ((x - src.mean[c]) * k[c] + dst.mean[c] - x); });
    const rgb = labToRgb(clamp(v[0], 0, 100), v[1], v[2]);
    for (let c = 0; c < 3; c++) out[p * 4 + c] = Math.round(255 * rgb[c]);
    out[p * 4 + 3] = px[p * 4 + 3];
  }
  const r3 = (a) => a.map((v) => Math.round(v * 100) / 100);
  return { px: out, source: { mean: r3(src.mean), sd: r3(src.sd) }, reference: { mean: r3(dst.mean), sd: r3(dst.sd) } };
}

// ---- colourize (DDColor) -----------------------------------------------------------------------------

export const COLOURIZE_SIZE = 512;
// The model's input: the photo's lightness only, as grey RGB (Lab with a = b = 0 back to sRGB), resized to
// S × S, CHW float 0..1. Downscaling averages L over each output pixel's footprint (a tent of the footprint's
// width), because the model's answer changes with aliasing: on a 1920 × 2888 black-and-white photo a point
// sample gave mean chroma 0.13 and an averaged one 11.8 (DDColor tiny, 2026-11-13).
export function colourizeInput(px, w, h, S = COLOURIZE_SIZE) {
  const L = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) L[p] = rgbToLab(px[p * 4] / 255, px[p * 4 + 1] / 255, px[p * 4 + 2] / 255)[0];
  const kx = w / S; const ky = h / S; const rx = Math.max(1, kx); const ry = Math.max(1, ky);
  const out = new Float32Array(3 * S * S);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const cx = (i + 0.5) * kx - 0.5; const cy = (j + 0.5) * ky - 0.5; let s = 0; let n = 0;
    for (let y = Math.ceil(cy - ry); y <= Math.floor(cy + ry); y++) for (let x = Math.ceil(cx - rx); x <= Math.floor(cx + rx); x++) {
      const wt = (1 - Math.abs(x - cx) / rx) * (1 - Math.abs(y - cy) / ry); if (wt <= 0) continue;
      s += wt * L[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)]; n += wt;
    }
    const g = labToRgb(n ? s / n : 0, 0, 0)[0];
    for (let c = 0; c < 3; c++) out[c * S * S + j * S + i] = g;
  }
  return out;
}
// The predicted a, b planes (CHW [2, S, S]) stretched to w × h and joined with the photo's own lightness:
//   out = Lab→sRGB(L_photo, a_model, b_model); a strength t < 1 scales a and b by t. RGBA u8, alpha kept.
export function colourizeCombine(px, w, h, ab, S = COLOURIZE_SIZE, { strength = 100 } = {}) {
  const out = new Uint8Array(w * h * 4); const t = clamp01(strength / 100);
  const at = (c, x, y) => { x = clamp(x, 0, S - 1); y = clamp(y, 0, S - 1); const x0 = Math.floor(x); const y0 = Math.floor(y); const x1 = Math.min(S - 1, x0 + 1); const y1 = Math.min(S - 1, y0 + 1); const tx = x - x0; const ty = y - y0; const o = c * S * S;
    return (ab[o + y0 * S + x0] * (1 - tx) + ab[o + y0 * S + x1] * tx) * (1 - ty) + (ab[o + y1 * S + x0] * (1 - tx) + ab[o + y1 * S + x1] * tx) * ty; };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const p = j * w + i; const L = rgbToLab(px[p * 4] / 255, px[p * 4 + 1] / 255, px[p * 4 + 2] / 255)[0];
    const x = (i + 0.5) * S / w - 0.5; const y = (j + 0.5) * S / h - 0.5;
    const rgb = labToRgb(L, t * at(0, x, y), t * at(1, x, y));
    for (let c = 0; c < 3; c++) out[p * 4 + c] = Math.round(255 * rgb[c]);
    out[p * 4 + 3] = px[p * 4 + 3];
  }
  return out;
}
// Mean chroma √(a² + b²) of an RGBA image (alpha > 0): about 0 for a black-and-white photo.
export function meanChroma(px, n) { let s = 0; let k = 0; for (let p = 0; p < n; p++) { if (!px[p * 4 + 3]) continue; const [, a, b] = rgbToLab(px[p * 4] / 255, px[p * 4 + 1] / 255, px[p * 4 + 2] / 255); s += Math.hypot(a, b); k++; } return k ? s / k : 0; }

// ---- style transfer ----------------------------------------------------------------------------------

// The working size for a style network: long edge at most `edge` (the brush strokes the network paints have a
// fixed size in pixels, so the style reads the same at any photo resolution), a multiple of 4 (two stride-2
// downsamplings and their upsamplings).
export function styleSize(w, h, edge = 1024) {
  const k = Math.min(1, edge / Math.max(w, h));
  return [Math.max(4, Math.round(w * k / 4) * 4), Math.max(4, Math.round(h * k / 4) * 4)];
}
// RGBA u8 resized (bilinear) to W × H, RGBA u8.
export function resizeRGBA(px, w, h, W, H) {
  const out = new Uint8Array(W * H * 4);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = (i + 0.5) * w / W - 0.5; const y = (j + 0.5) * h / H - 0.5;
    for (let c = 0; c < 4; c++) out[(j * W + i) * 4 + c] = Math.round(sample(px, w, h, x, y, c));
  }
  return out;
}
// One tile for a fast-neural-style network: HWC 0..1 in → the network's CHW 0..255 input, and its CHW
// 0..255 output → HWC 0..1 (clamped).
export function styleTileIn(t, tw, th) { const o = new Float32Array(3 * tw * th); for (let p = 0; p < tw * th; p++) for (let c = 0; c < 3; c++) o[c * tw * th + p] = 255 * t[p * 3 + c]; return o; }
export function styleTileOut(y, tw, th) { const o = new Float32Array(3 * tw * th); for (let p = 0; p < tw * th; p++) for (let c = 0; c < 3; c++) o[p * 3 + c] = clamp01(y[c * tw * th + p] / 255); return o; }
// The styled image (HWC float 0..1, W × H) resized to w × h and mixed with the photo:
//   out = photo + t (styled − photo),  t = strength/100. RGBA u8, alpha kept.
export function styleOutput(y, W, H, px, w, h, { strength = 100 } = {}) {
  const out = new Uint8Array(w * h * 4); const t = clamp01(strength / 100);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = clamp((i + 0.5) * W / w - 0.5, 0, W - 1); const yy = clamp((j + 0.5) * H / h - 0.5, 0, H - 1);
    const x0 = Math.floor(x); const y0 = Math.floor(yy); const x1 = Math.min(W - 1, x0 + 1); const y1 = Math.min(H - 1, y0 + 1); const tx = x - x0; const ty = yy - y0; const p = j * w + i;
    for (let c = 0; c < 3; c++) {
      const v = 255 * ((y[(y0 * W + x0) * 3 + c] * (1 - tx) + y[(y0 * W + x1) * 3 + c] * tx) * (1 - ty) + (y[(y1 * W + x0) * 3 + c] * (1 - tx) + y[(y1 * W + x1) * 3 + c] * tx) * ty);
      out[p * 4 + c] = Math.round(clamp(px[p * 4 + c] + t * (v - px[p * 4 + c]), 0, 255));
    }
    out[p * 4 + 3] = px[p * 4 + 3];
  }
  return out;
}
