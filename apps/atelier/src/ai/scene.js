// Sky replacement and relighting maths (L66). Pure; node tests check each formula. Formulas are Atelier's own.
// Pixels are RGBA u8, display-encoded sRGB, straight alpha; masks are u8 0..255 or float 0..1.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const dec = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const enc = (x) => Math.round(255 * (x <= 0.0031308 ? 12.92 * clamp01(x) : 1.055 * clamp01(x) ** (1 / 2.4) - 0.055));

// The replacement sky scaled to cover W × H (the larger of the two scale factors), centred horizontally
// and aligned to the top, bilinear. RGBA u8 W × H.
export function coverFit(px, w, h, W, H) {
  const k = Math.max(W / w, H / h); const ox = (w * k - W) / 2; const out = new Uint8Array(W * H * 4);
  for (let J = 0; J < H; J++) for (let I = 0; I < W; I++) {
    const x = Math.min(w - 1, Math.max(0, (I + 0.5 + ox) / k - 0.5)); const y = Math.min(h - 1, Math.max(0, (J + 0.5) / k - 0.5));
    const x0 = Math.floor(x); const y0 = Math.floor(y); const x1 = Math.min(w - 1, x0 + 1); const y1 = Math.min(h - 1, y0 + 1); const tx = x - x0; const ty = y - y0;
    for (let c = 0; c < 4; c++) {
      const a = px[(y0 * w + x0) * 4 + c] * (1 - tx) + px[(y0 * w + x1) * 4 + c] * tx; const b = px[(y1 * w + x0) * 4 + c] * (1 - tx) + px[(y1 * w + x1) * 4 + c] * tx;
      out[(J * W + I) * 4 + c] = Math.round(a * (1 - ty) + b * ty);
    }
  }
  return out;
}

// Mean linear RGB of px weighted by m (0..1 per pixel); null when the weights sum to 0.
export function meanLinear(px, m) {
  const s = [0, 0, 0]; let n = 0;
  for (let p = 0; p < m.length; p++) { const t = m[p]; if (!(t > 0)) continue; for (let c = 0; c < 3; c++) s[c] += t * dec(px[p * 4 + c]); n += t; }
  return n > 0 ? s.map((v) => v / n) : null;
}

// Colour match of the foreground to the new sky: per-channel linear gains g_c = (new_c / old_c) rescaled so
// the Rec.709 luminance of g is 1 (the cast changes, the brightness does not), then
//   out_c = fg_c · (1 + (g_c − 1) · t),  t = amount/100 · 0.5   (half the sky's cast at most, in linear light)
// Returns { gains, px } with px the foreground's new colour (alpha kept).
export function matchForeground(px, oldSky, newSky, amount = 50) {
  const g = [0, 1, 2].map((c) => (newSky[c] + 1e-4) / (oldSky[c] + 1e-4));
  const Y = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2]; for (let c = 0; c < 3; c++) g[c] /= Y;
  const t = (amount / 100) * 0.5; const out = new Uint8Array(px.length);
  for (let p = 0; p < px.length / 4; p++) {
    for (let c = 0; c < 3; c++) out[p * 4 + c] = enc(dec(px[p * 4 + c]) * (1 + (g[c] - 1) * t));
    out[p * 4 + 3] = px[p * 4 + 3];
  }
  return { gains: g.map((v) => Math.round(v * 1000) / 1000), px: out };
}

// Separable box blur of a float plane, radius r (edge clamp).
export function blurPlane(f, w, h, r) {
  if (r < 1) return Float32Array.from(f);
  const t = new Float32Array(w * h); const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) { let s = 0; for (let d = -r; d <= r; d++) s += f[j * w + Math.min(w - 1, Math.max(0, d))]; for (let i = 0; i < w; i++) { t[j * w + i] = s / (2 * r + 1); s += f[j * w + Math.min(w - 1, i + r + 1)] - f[j * w + Math.max(0, i - r)]; } }
  for (let i = 0; i < w; i++) { let s = 0; for (let d = -r; d <= r; d++) s += t[Math.min(h - 1, Math.max(0, d)) * w + i]; for (let j = 0; j < h; j++) { out[j * w + i] = s / (2 * r + 1); s += t[Math.min(h - 1, j + r + 1) * w + i] - t[Math.max(0, j - r) * w + i]; } }
  return out;
}

// Surface normals from a disparity map (u8, 255 nearest): height z = relief · d/255 · w (relief in units of
// the image width), smoothed by a box of radius r, then n = normalize(−∂z/∂x, −∂z/∂y, 1) by central differences.
export function normalsFromDepth(d, w, h, { relief = 0.15, r = 2 } = {}) {
  const z = blurPlane(Float32Array.from(d, (v) => (relief * v * w) / 255), w, h, r);
  const n = new Float32Array(w * h * 3);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const dx = (z[j * w + Math.min(w - 1, i + 1)] - z[j * w + Math.max(0, i - 1)]) / 2;
    const dy = (z[Math.min(h - 1, j + 1) * w + i] - z[Math.max(0, j - 1) * w + i]) / 2;
    const L = Math.hypot(dx, dy, 1); const p = (j * w + i) * 3; n[p] = -dx / L; n[p + 1] = -dy / L; n[p + 2] = 1 / L;
  }
  return n;
}

// Lambert shading from a point light at (lx, ly) in image pixels, `height` above the image plane (in
// image widths): L = normalize(lx − x, ly − y, height · w), s = max(0, n · L). Returns Float32 shading.
export function shade(n, w, h, [lx, ly], height = 0.5) {
  const s = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const vx = lx - (i + 0.5); const vy = ly - (j + 0.5); const vz = height * w; const L = Math.hypot(vx, vy, vz); const p = (j * w + i) * 3;
    s[j * w + i] = Math.max(0, (n[p] * vx + n[p + 1] * vy + n[p + 2] * vz) / L);
  }
  return s;
}

// The relight layer: mid-grey where the shading equals its mean, lighter where the light falls more,
// darker where less, for the soft-light blend (50 % grey is neutral there):
//   v = 0.5 + 0.5 · k · (s − mean(s)) / max|s − mean(s)|,  k = strength/100,  grey RGBA u8, alpha 255.
export function relightLayer(s, strength = 50) {
  let m = 0; for (const v of s) m += v; m /= s.length || 1;
  let mx = 1e-6; for (const v of s) mx = Math.max(mx, Math.abs(v - m));
  const k = strength / 100; const out = new Uint8Array(s.length * 4);
  for (let p = 0; p < s.length; p++) { const v = Math.round(255 * clamp01(0.5 + 0.5 * k * (s[p] - m) / mx)); out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = v; out[p * 4 + 3] = 255; }
  return out;
}

// Nearest-neighbour or bilinear resize of a u8 plane (w × h → W × H).
export function resizePlane(d, w, h, W, H) {
  const out = new Uint8Array(W * H);
  for (let J = 0; J < H; J++) for (let I = 0; I < W; I++) {
    const x = Math.min(w - 1, Math.max(0, (I + 0.5) * w / W - 0.5)); const y = Math.min(h - 1, Math.max(0, (J + 0.5) * h / H - 0.5));
    const x0 = Math.floor(x); const y0 = Math.floor(y); const x1 = Math.min(w - 1, x0 + 1); const y1 = Math.min(h - 1, y0 + 1); const tx = x - x0; const ty = y - y0;
    out[J * W + I] = Math.round((d[y0 * w + x0] * (1 - tx) + d[y0 * w + x1] * tx) * (1 - ty) + (d[y1 * w + x0] * (1 - tx) + d[y1 * w + x1] * tx) * ty);
  }
  return out;
}

// What an export should say about AI edits: null when no layer is marked, else a sentence for the PNG
// tEXt Description, TIFF ImageDescription or XMP dc:description, e.g.
// "Edited with Atelier on-device AI: Sky (edited), Relight (edited)."
export function editedNote(doc) {
  const names = (doc?.layers || []).filter((l) => l.aiEdit && l.visible !== false).map((l) => l.name);
  return names.length ? `Edited with Atelier on-device AI: ${names.join(', ')}.` : null;
}

// Refines a coarse sky mask (u8, from a panoptic model that marks whole regions) by colour: the sky's
// expected colour on row y is the median of masked pixels within ±band rows (sky colour changes mostly
// with height, and an object such as a mast or a rocket is a small share of each row), and each masked
// pixel keeps the weight
//   g = exp(−(d / tol)²),  d = |rgb − median_y| in 8-bit display units,  tol = tolerance (default 40),
// so objects whose colour departs from the sky's leave the mask. Returns Float32 0..1.
export function refineSky(px, mask, W, H, { tolerance = 40, band = 4 } = {}) {
  const med = new Float32Array(H * 3); const has = new Uint8Array(H);
  const vals = [[], [], []];
  for (let y = 0; y < H; y++) {
    vals[0].length = vals[1].length = vals[2].length = 0;
    for (let yy = Math.max(0, y - band); yy <= Math.min(H - 1, y + band); yy++) for (let x = 0; x < W; x++) {
      const p = yy * W + x; if (mask[p] < 128) continue;
      for (let c = 0; c < 3; c++) vals[c].push(px[p * 4 + c]);
    }
    if (!vals[0].length) continue;
    has[y] = 1;
    for (let c = 0; c < 3; c++) { const v = vals[c].sort((a, b) => a - b); med[y * 3 + c] = v[v.length >> 1]; }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x; const m = mask[p] / 255; if (!(m > 0) || !has[y]) continue;
    const d = Math.hypot(px[p * 4] - med[y * 3], px[p * 4 + 1] - med[y * 3 + 1], px[p * 4 + 2] - med[y * 3 + 2]);
    out[p] = m * Math.exp(-((d / tolerance) ** 2));
  }
  return out;
}
