// Shared image helpers for the merge tools (HDR, panorama, focus stack). Pure code: node and browser.
// An input image is { width, height, data, lut? }: data holds 3 interleaved samples per pixel (RGB) as
// any typed array; lut (optional) maps an integer code to linear light (Float32Array), so 8-bit sRGB and
// 16-bit RAW data stay in their compact form. Without a lut, data already holds linear floats.

export const value = (im, k) => (im.lut ? im.lut[im.data[k]] : im.data[k]);

// sRGB EOTF lookup for 8-bit codes: linear = c ≤ 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4 (IEC 61966-2-1).
export const SRGB8_LUT = Float32Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
// 16-bit linear codes: linear = code / 65535.
export const LIN16_LUT = Float32Array.from({ length: 65536 }, (_, i) => i / 65535);
// sRGB OETF (linear → display 0..1).
export const oetf = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

// Luminance of linear Rec.709/camera RGB (Rec.709 weights: Y = 0.2126 R + 0.7152 G + 0.0722 B).
export function luma(im) {
  const n = im.width * im.height; const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.2126 * value(im, i * 3) + 0.7152 * value(im, i * 3 + 1) + 0.0722 * value(im, i * 3 + 2);
  return out;
}

// Grey plane downscaled by an integer factor f (box average), so detection runs on a small copy.
export function shrink(plane, w, h, f) {
  if (f <= 1) return { data: plane, width: w, height: h };
  const W = Math.floor(w / f); const H = Math.floor(h / f); const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let j = 0; j < f; j++) { const row = (y * f + j) * w + x * f; for (let i = 0; i < f; i++) s += plane[row + i]; }
    out[y * W + x] = s / (f * f);
  }
  return { data: out, width: W, height: H };
}

// Separable Gaussian blur of a float plane (edge samples repeat). Kernel radius ceil(3σ).
export function gaussian(plane, w, h, sigma) {
  if (!(sigma > 0)) return plane.slice();
  const r = Math.max(1, Math.ceil(sigma * 3)); const k = new Float32Array(2 * r + 1); let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(w * h); const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) { let a = 0; for (let i = -r; i <= r; i++) { const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i; a += k[i + r] * plane[row + xx]; } tmp[row + x] = a; }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0; for (let i = -r; i <= r; i++) { const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i; a += k[i + r] * tmp[yy * w + x]; } out[y * w + x] = a;
  }
  return out;
}

// Bilinear sample of channel c of im at (x, y) in pixel-centre coordinates; NaN outside the image.
export function bilinear(im, x, y, c) {
  const W = im.width; const H = im.height;
  if (!(x >= -0.5 && y >= -0.5 && x <= W - 0.5 && y <= H - 0.5)) return NaN;
  const fx = Math.min(Math.max(x, 0), W - 1); const fy = Math.min(Math.max(y, 0), H - 1);
  const x0 = Math.min(Math.floor(fx), W - 2 < 0 ? 0 : W - 2); const y0 = Math.min(Math.floor(fy), H - 2 < 0 ? 0 : H - 2);
  const x1 = Math.min(x0 + 1, W - 1); const y1 = Math.min(y0 + 1, H - 1);
  const ax = fx - x0; const ay = fy - y0;
  const v = (xx, yy) => value(im, (yy * W + xx) * 3 + c);
  return (v(x0, y0) * (1 - ax) + v(x1, y0) * ax) * (1 - ay) + (v(x0, y1) * (1 - ax) + v(x1, y1) * ax) * ay;
}

// Linear float RGB image → 8-bit sRGB RGB (for previews and tests).
export function toSrgb8(data, n) {
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n * 3; i++) out[i] = Math.round(255 * oetf(Math.min(1, Math.max(0, data[i]))));
  return out;
}

// 4-channel RGBA → 3-channel RGB copy (same type).
export function dropAlpha(rgba, n) {
  const out = new rgba.constructor(n * 3);
  for (let i = 0; i < n; i++) { out[i * 3] = rgba[i * 4]; out[i * 3 + 1] = rgba[i * 4 + 1]; out[i * 3 + 2] = rgba[i * 4 + 2]; }
  return out;
}
