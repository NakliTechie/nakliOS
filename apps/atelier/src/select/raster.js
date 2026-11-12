// Pure single-channel raster helpers for selections and mask bitmaps (8-bit, 0..255, row-major).
// No GPU, no DOM, so node tests can check them on small grids. Coordinates are in pixels with the
// pixel (i, j) covering [i, i+1) × [j, j+1); a pixel's centre is (i + 0.5, j + 0.5).

const SUBROWS = 4;   // anti-aliasing: exact horizontal coverage on 4 sub-rows per pixel row
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const to8 = (v) => Math.round(255 * clamp01(v));

// Rectangle [x, x+w) × [y, y+h) with exact fractional coverage at its edges.
export function rasterRect(width, height, { x, y, w, h }) {
  const out = new Uint8Array(width * height);
  const x1 = x + w; const y1 = y + h;
  for (let j = Math.max(0, Math.floor(y)); j < Math.min(height, Math.ceil(y1)); j++) {
    const cy = Math.min(j + 1, y1) - Math.max(j, y);
    for (let i = Math.max(0, Math.floor(x)); i < Math.min(width, Math.ceil(x1)); i++) {
      const cx = Math.min(i + 1, x1) - Math.max(i, x);
      out[j * width + i] = to8(cx * cy);
    }
  }
  return out;
}

// Accumulates the horizontal coverage of spans [xa, xb) on sub-row k of row j into acc (floats).
function addSpan(acc, width, j, xa, xb, weight) {
  xa = Math.max(0, xa); xb = Math.min(width, xb);
  if (xb <= xa) return;
  const ia = Math.floor(xa); const ib = Math.min(width - 1, Math.ceil(xb) - 1);
  for (let i = ia; i <= ib; i++) acc[j * width + i] += (Math.min(i + 1, xb) - Math.max(i, xa)) * weight;
}

// spansAt(y) → [[xa, xb], ...] for the horizontal line at height y.
function rasterSpans(width, height, y0, y1, spansAt) {
  const acc = new Float32Array(width * height);
  for (let j = Math.max(0, Math.floor(y0)); j < Math.min(height, Math.ceil(y1)); j++) {
    for (let k = 0; k < SUBROWS; k++) {
      for (const [xa, xb] of spansAt(j + (k + 0.5) / SUBROWS)) addSpan(acc, width, j, xa, xb, 1 / SUBROWS);
    }
  }
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = to8(acc[i]);
  return out;
}

// Ellipse centred (cx, cy) with radii rx, ry, anti-aliased.
export function rasterEllipse(width, height, { cx, cy, rx, ry }) {
  return rasterSpans(width, height, cy - ry, cy + ry, (y) => {
    const t = (y - cy) / ry;
    if (t * t >= 1) return [];
    const half = rx * Math.sqrt(1 - t * t);
    return [[cx - half, cx + half]];
  });
}

// Polygon (even-odd rule), anti-aliased. points: [[x, y], ...], at least 3.
export function rasterPolygon(width, height, points) {
  const ys = points.map((p) => p[1]);
  return rasterSpans(width, height, Math.min(...ys), Math.max(...ys), (y) => {
    const xs = [];
    for (let i = 0; i < points.length; i++) {
      const [ax, ay] = points[i]; const [bx, by] = points[(i + 1) % points.length];
      if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + (y - ay) * (bx - ax) / (by - ay));
    }
    xs.sort((a, b) => a - b);
    const spans = [];
    for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i + 1]]);
    return spans;
  });
}

// Boolean combination of the current selection a (or null) with a new shape b, the engine's rules:
// add = max, subtract = a·(1−b), intersect = a·b.
export function combine(a, b, op) {
  if (op === 'replace' || !a) return op === 'subtract' || op === 'intersect' ? new Uint8Array(b.length) : b.slice();
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) {
    if (op === 'add') out[i] = Math.max(a[i], b[i]);
    else if (op === 'subtract') out[i] = Math.round(a[i] * (255 - b[i]) / 255);
    else out[i] = Math.round(a[i] * b[i] / 255);
  }
  return out;
}

export function invert(a) { const out = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) out[i] = 255 - a[i]; return out; }

// [x0, y0, x1, y1) of the non-zero pixels, or null when the bitmap is empty.
export function bounds(a, width, height) {
  let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      if (!a[j * width + i]) continue;
      if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; if (j > y1) y1 = j;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

// ---- blur ----------------------------------------------------------------------------------------

// Three box widths whose sum of variances matches a Gaussian of sigma (Kovesi 2010).
export function boxesForGauss(sigma, n = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

// One box blur of radius r along x then y on interleaved float channels, edges extended.
export function boxBlur(data, width, height, channels, r) {
  if (r <= 0) return data;
  const tmp = new Float32Array(data.length); const out = new Float32Array(data.length);
  const n = 2 * r + 1;
  const pass = (src, dst, len, lines, step, lineStep) => {
    for (let l = 0; l < lines; l++) {
      for (let c = 0; c < channels; c++) {
        const base = l * lineStep + c;
        const at = (i) => src[base + Math.min(len - 1, Math.max(0, i)) * step];
        let s = 0;
        for (let i = -r; i <= r; i++) s += at(i);
        for (let i = 0; i < len; i++) { dst[base + i * step] = s / n; s += at(i + r + 1) - at(i - r); }
      }
    }
  };
  pass(data, tmp, width, height, channels, width * channels);
  pass(tmp, out, height, width, width * channels, channels);
  return out;
}

// Approximate Gaussian of sigma by three box blurs. data: Float32Array, interleaved channels.
export function gaussBlur(data, width, height, channels, sigma) {
  if (sigma <= 0) return Float32Array.from(data);
  let d = Float32Array.from(data);
  for (const w of boxesForGauss(sigma)) d = boxBlur(d, width, height, channels, (w - 1) / 2);
  return d;
}

// Feather an 8-bit selection by sigma = amount pixels.
export function feather(a, width, height, amount) {
  const f = gaussBlur(Float32Array.from(a), width, height, 1, amount);
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.round(Math.min(255, Math.max(0, f[i])));
  return out;
}

// ---- morphology ----------------------------------------------------------------------------------

// Grayscale dilation by a disk of radius r (pixel centres within r). pad: value outside the image.
export function dilate(a, width, height, r, pad = 0) {
  if (r <= 0) return a.slice();
  const R = Math.floor(r);
  const out = new Uint8Array(a.length);
  const L = width + 2 * R;
  const row = new Uint8Array(L); const g = new Uint8Array(L); const h = new Uint8Array(L);
  const rowMax = new Uint8Array(width);
  for (let dy = -R; dy <= R; dy++) {
    const hw = Math.floor(Math.sqrt(r * r - dy * dy) + 1e-9);
    const k = 2 * hw + 1;
    for (let j = 0; j < height; j++) {
      const sy = j + dy;
      if (sy < 0 || sy >= height) rowMax.fill(pad);
      else {
        // Horizontal max of row sy over [i − hw, i + hw] (van Herk / Gil–Werman, O(width)).
        const n = width + 2 * hw;
        row.fill(pad, 0, n);
        row.set(a.subarray(sy * width, sy * width + width), hw);
        for (let x = 0; x < n; x++) g[x] = x % k === 0 ? row[x] : Math.max(g[x - 1], row[x]);
        for (let x = n - 1; x >= 0; x--) h[x] = x === n - 1 || (x + 1) % k === 0 ? row[x] : Math.max(h[x + 1], row[x]);
        for (let i = 0; i < width; i++) rowMax[i] = Math.max(h[i], g[i + k - 1]);
      }
      for (let i = 0; i < width; i++) if (rowMax[i] > out[j * width + i]) out[j * width + i] = rowMax[i];
    }
  }
  return out;
}

// Expand grows the selection by r px; canvas edges add nothing.
export const expand = (a, width, height, r) => dilate(a, width, height, r, 0);
// Contract shrinks it by r px; canvas edges count as selected, so select-all stays select-all.
export const contract = (a, width, height, r) => invert(dilate(invert(a), width, height, r, 0));

// Smooth: majority vote in a (2r+1)² square, a pixel counting as selected at ≥128 (the median of a
// two-level image). Out-of-canvas pixels are not counted. The result is hard-edged.
export function smooth(a, width, height, r) {
  const R = Math.max(1, Math.round(r));
  const W = width + 1; const ii = new Uint32Array(W * (height + 1));
  for (let j = 0; j < height; j++) {
    let s = 0;
    for (let i = 0; i < width; i++) { s += a[j * width + i] >= 128 ? 1 : 0; ii[(j + 1) * W + i + 1] = ii[j * W + i + 1] + s; }
  }
  const out = new Uint8Array(a.length);
  for (let j = 0; j < height; j++) {
    const y0 = Math.max(0, j - R); const y1 = Math.min(height, j + R + 1);
    for (let i = 0; i < width; i++) {
      const x0 = Math.max(0, i - R); const x1 = Math.min(width, i + R + 1);
      const on = ii[y1 * W + x1] - ii[y0 * W + x1] - ii[y1 * W + x0] + ii[y0 * W + x0];
      out[j * width + i] = 2 * on > (x1 - x0) * (y1 - y0) ? 255 : 0;
    }
  }
  return out;
}

// ---- colour selections ---------------------------------------------------------------------------

// Largest per-channel difference (RGBA) between pixel k of rgba and a colour.
const diff = (rgba, k, c) => Math.max(Math.abs(rgba[k] - c[0]), Math.abs(rgba[k + 1] - c[1]), Math.abs(rgba[k + 2] - c[2]), Math.abs(rgba[k + 3] - c[3]));

// Magic wand / bucket region: pixels within tolerance of the seed pixel's colour, 4-connected to the
// seed when contiguous. Returns 0/255.
export function floodRegion(rgba, width, height, sx, sy, tolerance, contiguous = true) {
  const out = new Uint8Array(width * height);
  sx = Math.floor(sx); sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return out;
  const k0 = (sy * width + sx) * 4;
  const seed = [rgba[k0], rgba[k0 + 1], rgba[k0 + 2], rgba[k0 + 3]];
  const ok = (p) => diff(rgba, p * 4, seed) <= tolerance;
  if (!contiguous) { for (let p = 0; p < out.length; p++) if (ok(p)) out[p] = 255; return out; }
  const stack = [sy * width + sx]; out[sy * width + sx] = 255;
  while (stack.length) {
    const p = stack.pop(); const x = p % width; const y = (p - x) / width;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const q = ny * width + nx;
      if (!out[q] && ok(q)) { out[q] = 255; stack.push(q); }
    }
  }
  return out;
}

// Colour range: 255 within tolerance of colour, a linear ramp to 0 over the next fuzziness levels.
export function colourRange(rgba, width, height, colour, tolerance, fuzziness = 0) {
  const out = new Uint8Array(width * height);
  const c = [colour[0], colour[1], colour[2], colour[3] ?? 255];
  for (let p = 0; p < out.length; p++) {
    const d = diff(rgba, p * 4, c);
    out[p] = d <= tolerance ? 255 : fuzziness > 0 && d < tolerance + fuzziness ? to8(1 - (d - tolerance) / fuzziness) : 0;
  }
  return out;
}

// ---- resampling ----------------------------------------------------------------------------------

// Bilinear sample of a single-channel image at continuous pixel coordinates (centre convention);
// outside the image counts as `outside`.
export function sampleBilinear(a, width, height, x, y, outside = 0) {
  const tx = x - 0.5; const ty = y - 0.5;
  const i = Math.floor(tx); const j = Math.floor(ty); const fx = tx - i; const fy = ty - j;
  const at = (u, v) => (u < 0 || v < 0 || u >= width || v >= height ? outside : a[v * width + u]);
  if (fx === 0 && fy === 0) return at(i, j);
  return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy;
}

// Resample a document-space bitmap into a layer's local pixel grid (lw × lh). matrix maps layer-local
// px to document px ([a,b,c,d,e,f], x' = a·x + c·y + e), so each local pixel centre is sent forward
// through it (the inverse of the document → local map the shader uses) and sampled bilinearly.
export function resampleToLocal(docA, docW, docH, matrix, lw, lh) {
  const [a, b, c, d, e, f] = matrix;
  const out = new Uint8Array(lw * lh);
  for (let j = 0; j < lh; j++) {
    for (let i = 0; i < lw; i++) {
      const x = i + 0.5; const y = j + 0.5;
      out[j * lw + i] = Math.round(sampleBilinear(docA, docW, docH, a * x + c * y + e, b * x + d * y + f, 0));
    }
  }
  return out;
}
