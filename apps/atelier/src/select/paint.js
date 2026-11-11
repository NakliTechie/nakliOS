// Pure pixel helpers for raster layers: 8-bit sRGB RGBA, straight alpha, layer-local pixels. Fills,
// gradients and brush strokes composite in display-encoded sRGB (the way Photoshop paints by default);
// blur-based filters work in linear light on premultiplied values. coverage: optional Uint8Array
// (0..255) per pixel, the selection resampled into the layer's grid; null means everywhere.

import { gaussBlur } from './raster.js';

export function parseHex(hex) {
  const h = String(hex).replace('#', '');
  if (!/^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) return null;
  return [0, 2, 4, 6].map((i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255));
}

const DECODE = Float32Array.from({ length: 256 }, (_, i) => { const x = i / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
export const decode = (v) => DECODE[v];
export const encode = (x) => { x = x < 0 ? 0 : x > 1 ? 1 : x; return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)); };

// Source-over of colour c (r, g, b in 0..255) with alpha a (0..1) onto pixel k, straight alpha.
export function over(px, k, r, g, b, a) {
  if (a <= 0) return;
  const da = px[k + 3] / 255; const oa = a + da * (1 - a);
  const mix = (s, d) => Math.round((s * a + d * da * (1 - a)) / oa);
  px[k] = mix(r, px[k]); px[k + 1] = mix(g, px[k + 1]); px[k + 2] = mix(b, px[k + 2]); px[k + 3] = Math.round(255 * oa);
}

const cov = (coverage, p) => (coverage ? coverage[p] / 255 : 1);

// Solid fill of colour [r, g, b, a] (0..255) over the covered pixels.
export function fillSolid(px, width, height, colour, coverage) {
  const a = colour[3] / 255;
  for (let p = 0; p < width * height; p++) over(px, p * 4, colour[0], colour[1], colour[2], a * cov(coverage, p));
}

// Linear gradient from colour c0 at document point (x0, y0) to c1 at (x1, y1), interpolated in sRGB.
// matrix maps local → document so the gradient sits where the person drew it.
export function fillGradient(px, width, height, { x0, y0, x1, y1, c0, c1 }, matrix, coverage) {
  const [ma, mb, mc, md, me, mf] = matrix;
  const dx = x1 - x0; const dy = y1 - y0; const dd = Math.max(1e-9, dx * dx + dy * dy);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const p = j * width + i; const x = i + 0.5; const y = j + 0.5;
      const X = ma * x + mc * y + me; const Y = mb * x + md * y + mf;
      const t = Math.min(1, Math.max(0, ((X - x0) * dx + (Y - y0) * dy) / dd));
      const c = [0, 1, 2, 3].map((n) => c0[n] + (c1[n] - c0[n]) * t);
      over(px, p * 4, Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), (c[3] / 255) * cov(coverage, p));
    }
  }
}

// Round-brush coverage of a stroke, like the engine's paintMask: stamps every 25% of the size,
// hardness and flow in percent, each stamp adding a·(1 − v). Returns Float32Array (0..1) and bounds.
export function strokeCoverage(width, height, points, size, hardness = 100, flow = 100) {
  const S = new Float32Array(width * height);
  const r = size / 2; const hard = Math.min(0.999, hardness / 100); const fl = flow / 100;
  const stamps = [];
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    if (i === 0) { stamps.push([x, y]); continue; }
    const [qx, qy] = points[i - 1];
    const d = Math.hypot(x - qx, y - qy); const step = Math.max(1, size * 0.25);
    for (let t = step; t <= d; t += step) stamps.push([qx + (x - qx) * t / d, qy + (y - qy) * t / d]);
  }
  for (const [cx, cy] of stamps) {
    const bx0 = Math.max(0, Math.floor(cx - r)); const bx1 = Math.min(width - 1, Math.ceil(cx + r));
    const by0 = Math.max(0, Math.floor(cy - r)); const by1 = Math.min(height - 1, Math.ceil(cy + r));
    for (let yy = by0; yy <= by1; yy++) {
      for (let xx = bx0; xx <= bx1; xx++) {
        const dist = Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy) / r;
        if (dist >= 1) continue;
        const a = (dist <= hard ? 1 : 1 - (dist - hard) / (1 - hard)) * fl;
        const k = yy * width + xx; S[k] += (1 - S[k]) * a;
      }
    }
  }
  return { coverage: S, stamps: stamps.length };
}

// Applies a stroke: brush paints colour at S·opacity; eraser removes alpha by the same amount.
export function applyStroke(px, width, height, S, { colour, opacity = 100, erase = false }, coverage) {
  const op = opacity / 100;
  for (let p = 0; p < width * height; p++) {
    if (!S[p]) continue;
    const a = S[p] * op * cov(coverage, p);
    if (erase) px[p * 4 + 3] = Math.round(px[p * 4 + 3] * (1 - a));
    else over(px, p * 4, colour[0], colour[1], colour[2], a * colour[3] / 255);
  }
}

// ---- filters (CPU) -------------------------------------------------------------------------------

// 8-bit straight sRGB → premultiplied linear float RGBA.
function toLinearPremul(px) {
  const f = new Float32Array(px.length);
  for (let k = 0; k < px.length; k += 4) {
    const a = px[k + 3] / 255;
    f[k] = DECODE[px[k]] * a; f[k + 1] = DECODE[px[k + 1]] * a; f[k + 2] = DECODE[px[k + 2]] * a; f[k + 3] = a;
  }
  return f;
}

// Writes premultiplied linear float RGBA back into 8-bit straight sRGB, blended by coverage.
function writeBack(px, f, coverage) {
  for (let p = 0; p < px.length / 4; p++) {
    const k = p * 4; const t = cov(coverage, p);
    if (t <= 0) continue;
    const a = Math.min(1, Math.max(0, f[k + 3]));
    const v = [0, 1, 2].map((c) => (a > 0 ? encode(f[k + c] / a) : 0));
    const na = Math.round(255 * a);
    if (t >= 1) { px[k] = v[0]; px[k + 1] = v[1]; px[k + 2] = v[2]; px[k + 3] = na; continue; }
    px[k] = Math.round(px[k] + (v[0] - px[k]) * t); px[k + 1] = Math.round(px[k + 1] + (v[1] - px[k + 1]) * t);
    px[k + 2] = Math.round(px[k + 2] + (v[2] - px[k + 2]) * t); px[k + 3] = Math.round(px[k + 3] + (na - px[k + 3]) * t);
  }
}

// Gaussian blur of sigma = radius px, in linear light on premultiplied values.
export function gaussianBlur(px, width, height, radius, coverage) {
  writeBack(px, gaussBlur(toLinearPremul(px), width, height, 4, radius), coverage);
}

// Unsharp mask in linear light: x + amount·(x − blur) where the display-encoded difference exceeds
// threshold levels. amount in percent.
export function unsharpMask(px, width, height, { amount = 100, radius = 1, threshold = 0 }, coverage) {
  const f = toLinearPremul(px); const b = gaussBlur(f, width, height, 4, radius);
  const k = amount / 100; const out = Float32Array.from(f);
  for (let p = 0; p < width * height; p++) {
    const a = f[p * 4 + 3];
    if (a <= 0) continue;
    for (let c = 0; c < 3; c++) {
      const i = p * 4 + c;
      const de = Math.abs(encode(f[i] / a) - encode(b[i] / Math.max(1e-9, b[p * 4 + 3])));
      if (de > threshold) out[i] = Math.max(0, f[i] + k * (f[i] - b[i]));
    }
  }
  writeBack(px, out, coverage);
}

// High pass: 128 + (x − blur) per channel in display-encoded sRGB, so the result overlays at mid
// grey the way the Photoshop filter does; alpha is kept.
export function highPass(px, width, height, radius, coverage) {
  const f = new Float32Array(px.length); for (let i = 0; i < px.length; i++) f[i] = px[i];
  const b = gaussBlur(f, width, height, 4, radius);
  const out = px.slice();
  for (let p = 0; p < width * height; p++) {
    for (let c = 0; c < 3; c++) out[p * 4 + c] = Math.max(0, Math.min(255, Math.round(128 + f[p * 4 + c] - b[p * 4 + c])));
  }
  for (let p = 0; p < width * height; p++) {
    const t = cov(coverage, p);
    for (let c = 0; c < 3; c++) px[p * 4 + c] = Math.round(px[p * 4 + c] + (out[p * 4 + c] - px[p * 4 + c]) * t);
  }
}

// Seeded Gaussian noise in linear light: standard deviation amount% of full scale. monochromatic
// adds the same value to R, G and B. A fixed seed makes the result repeatable (edit-list replay).
export function addNoise(px, width, height, { amount = 10, monochromatic = false, seed = 1 }, coverage) {
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return (s + 0.5) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const sd = amount / 100;
  const f = toLinearPremul(px);
  for (let p = 0; p < width * height; p++) {
    const a = f[p * 4 + 3];
    const n0 = gauss() * sd;
    for (let c = 0; c < 3; c++) { const n = monochromatic ? n0 : c === 0 ? n0 : gauss() * sd; f[p * 4 + c] = Math.max(0, Math.min(a, f[p * 4 + c] + n * a)); }
  }
  writeBack(px, f, coverage);
}
