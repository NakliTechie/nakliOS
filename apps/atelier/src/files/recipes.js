// Pure pixel recipes (no GPU, no DOM): the film looks pack (L60), auto tone and white balance maths (L14),
// red-eye detection (L38), frequency separation (P44) and channel thumbnails (P45). Formulas are Atelier's
// own and are written next to the code.

// ---- colour helpers ----------------------------------------------------------------------------------
export const eotf = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const oetf = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
// The engine's matrices (vendor/tessella/src/shaders.js M709_2020, M2020_709), rows.
const M709_2020 = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]];
const M2020_709 = [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]];
const mul = (M, v) => [M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2], M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2], M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]];
const EOTF8 = Float64Array.from({ length: 256 }, (_, i) => eotf(i / 255));

// ---- L60 film looks ----------------------------------------------------------------------------------
// A look maps display sRGB (0..1) to display sRGB, in this order:
//   1. saturation: c = Y + sat · (c − Y), Y = 0.2126 R + 0.7152 G + 0.0722 B
//   2. mono (optional): c = Σ mix_i · c_i (a black-and-white filter), then the tint below colours it
//   3. tone per channel: S(x) = (1 − k) x + k (3x² − 2x³) (k = contrast), then x = toe + (1 − toe − cut) S(x)
//   4. split tone: c += (1 − Y)² · shadow + Y² · highlight (Y after step 3)
//   5. warmth: R · (1 + w), B · (1 − w); clamp to 0..1
// The names describe a mood, not a film stock or a brand.
export const LOOKS = [
  { id: 'soft-matinee', name: 'Soft Matinee', sat: 0.9, k: 0.25, toe: 0.04, cut: 0.03, shadow: [0.0, 0.01, 0.03], highlight: [0.03, 0.015, 0.0], w: 0.02 },
  { id: 'harbour-fade', name: 'Harbour Fade', sat: 0.75, k: 0.1, toe: 0.09, cut: 0.05, shadow: [-0.01, 0.02, 0.05], highlight: [0.02, 0.01, -0.01], w: -0.01 },
  { id: 'copper-dusk', name: 'Copper Dusk', sat: 1.05, k: 0.35, toe: 0.02, cut: 0.02, shadow: [0.02, -0.005, -0.02], highlight: [0.05, 0.02, -0.03], w: 0.05 },
  { id: 'monsoon-teal', name: 'Monsoon Teal', sat: 0.9, k: 0.35, toe: 0.04, cut: 0.03, shadow: [-0.06, 0.02, 0.07], highlight: [0.06, 0.02, -0.04], w: 0.0 },
  { id: 'chalk-mono', name: 'Chalk Mono', sat: 1, k: 0.15, toe: 0.07, cut: 0.04, mono: [0.3, 0.55, 0.15], shadow: [0, 0, 0], highlight: [0, 0, 0], w: 0 },
  { id: 'ink-mono', name: 'Ink Mono', sat: 1, k: 0.6, toe: 0.0, cut: 0.0, mono: [0.45, 0.45, 0.1], shadow: [0, 0, 0], highlight: [0, 0, 0], w: 0 },
  { id: 'sepia-letter', name: 'Sepia Letter', sat: 1, k: 0.2, toe: 0.05, cut: 0.04, mono: [0.3, 0.6, 0.1], shadow: [0.03, 0.01, -0.02], highlight: [0.06, 0.03, -0.03], w: 0.0 },
  { id: 'bright-market', name: 'Bright Market', sat: 1.25, k: 0.3, toe: 0.0, cut: 0.0, shadow: [0, 0, 0.01], highlight: [0.01, 0.01, 0], w: 0.01 },
  { id: 'faded-postcard', name: 'Faded Postcard', sat: 0.7, k: -0.1, toe: 0.12, cut: 0.08, shadow: [0.02, 0.0, 0.03], highlight: [0.03, 0.02, 0.0], w: 0.03 },
  { id: 'cool-morning', name: 'Cool Morning', sat: 0.9, k: 0.2, toe: 0.03, cut: 0.02, shadow: [-0.01, 0.0, 0.04], highlight: [-0.01, 0.01, 0.03], w: -0.05 },
  { id: 'ember-night', name: 'Ember Night', sat: 1.1, k: 0.45, toe: 0.01, cut: 0.03, shadow: [0.03, 0.0, -0.01], highlight: [0.05, 0.0, -0.04], w: 0.06 },
  { id: 'green-field', name: 'Green Field', sat: 1.1, k: 0.3, toe: 0.04, cut: 0.03, shadow: [-0.03, 0.04, -0.01], highlight: [0.03, 0.04, -0.04], w: 0.01 },
];

export function applyLook(L, [r, g, b]) {
  let Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let c = [r, g, b].map((x) => Y + L.sat * (x - Y));
  if (L.mono) { const m = L.mono[0] * c[0] + L.mono[1] * c[1] + L.mono[2] * c[2]; c = [m, m, m]; }
  c = c.map((x) => { x = clamp01(x); const s = (1 - L.k) * x + L.k * (3 * x * x - 2 * x * x * x); return L.toe + (1 - L.toe - L.cut) * s; });
  Y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  c = c.map((x, i) => x + (1 - Y) ** 2 * L.shadow[i] + Y * Y * L.highlight[i]);
  c[0] *= 1 + L.w; c[2] *= 1 - L.w;
  return c.map(clamp01);
}

// .cube text (Adobe Cube 1.0): LUT_3D_SIZE n, red varies fastest.
export function lookCube(L, n = 17) {
  const out = [`TITLE "${L.name}"`, '# Atelier film look; generated from the formula in src/files/recipes.js (Atelier, MIT)', `LUT_3D_SIZE ${n}`];
  for (let bi = 0; bi < n; bi++) for (let gi = 0; gi < n; gi++) for (let ri = 0; ri < n; ri++) {
    out.push(applyLook(L, [ri / (n - 1), gi / (n - 1), bi / (n - 1)]).map((v) => v.toFixed(6)).join(' '));
  }
  return `${out.join('\n')}\n`;
}

// ---- L14 auto tone and auto white balance ------------------------------------------------------------
// Auto white balance, grey world in camera space. meanRec2020: mean linear Rec.2020 of the mid-tone pixels
// of a render at the current white balance. Camera values = inverse(camToRec2020) · mean; the extra gains that
// make them equal are r_c = G / c; the new as-shot-style gains are current · r, and (T, tint) is solved from
// them with the engine's own model (solveAsShot). Returns the camera-space target gains.
export function greyWorldGains(meanRec2020, camToRec2020, currentGains) {
  const inv = inv3(camToRec2020);
  const cam = mul(inv, meanRec2020);
  if (cam.some((v) => !(v > 0))) return null;
  const r = [cam[1] / cam[0], 1, cam[1] / cam[2]];
  const g = currentGains.map((v, i) => v * r[i]);
  const m = Math.min(...g);
  return g.map((v) => v / m);
}
export function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h; const B = -(d * i - f * g); const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}

// Auto tone from a luma histogram of the render with tone settings at zero (display-encoded, 256 bins).
// Targets (Atelier's own, not fitted to Lightroom, which needs a corpus of its outputs):
//   exposure: move the median luma to 0.42 encoded: exposure = log2(eotf(0.42) / eotf(median)), within ±3
//   contrast: interquartile range (encoded) toward 0.30: contrast = 120 · (0.30 − IQR), within ±40
//   whites:   99.5th percentile toward 0.96: whites = 150 · (0.96 − p995), within ±60
//   blacks:   0.5th percentile toward 0.04: blacks = 150 · (0.04 − p005), within ±60
//   highlights: −40 · clipped-high fraction / 2% (at most −40); shadows: +40 · crushed fraction / 2% (at most 40)
export function autoToneParams(hist) {
  const n = hist.reduce((a, b) => a + b, 0);
  if (!n) return null;
  const pct = (q) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= q * n) return i / 255; } return 1; };
  const med = Math.max(1 / 255, pct(0.5));
  const expo = Math.log2(eotf(0.42) / eotf(med));
  // after exposure the percentiles move; estimate them through the same linear scale
  const shift = (v) => clamp01(oetf(Math.min(1, eotf(v) * 2 ** expo)));
  const q1 = shift(pct(0.25)); const q3 = shift(pct(0.75)); const p995 = shift(pct(0.995)); const p005 = shift(pct(0.005));
  const hi = (hist[255] + hist[254]) / n; const lo = (hist[0] + hist[1]) / n;
  const lim = (x, a) => Math.max(-a, Math.min(a, Math.round(x)));
  return {
    exposure: Math.round(Math.max(-3, Math.min(3, expo)) * 100) / 100,
    contrast: lim(120 * (0.30 - (q3 - q1)), 40),
    whites: lim(150 * (0.96 - p995), 60),
    blacks: lim(150 * (0.04 - p005), 60),
    highlights: -Math.min(40, Math.round(40 * hi / 0.02)),
    shadows: Math.min(40, Math.round(40 * lo / 0.02)),
  };
}

// ---- L38 red eye -------------------------------------------------------------------------------------
// redness = R / max(1, (G + B) / 2); a pupil pixel has redness ≥ 1.8, R ≥ 60 and R − max(G, B) ≥ 60
// (the last keeps brown irises and warm skin out). The pupil is the
// 4-connected region of pupil pixels nearest the box centre (largest when several touch it), dilated by
// 1 px. Corrected colour: R = G = B = 0.8 · (G + B) / 2, which keeps the catch-light and the texture.
export function redEyeMask(rgba, w, h) {
  const red = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const r = rgba[p * 4]; const g = rgba[p * 4 + 1]; const b = rgba[p * 4 + 2];
    if (r >= 60 && r - Math.max(g, b) >= 60 && r / Math.max(1, (g + b) / 2) >= 1.8) red[p] = 1;
  }
  const label = new Int32Array(w * h); const sizes = [0]; let best = 0; let bestScore = Infinity;
  const cx = w / 2; const cy = h / 2;
  for (let p = 0; p < w * h; p++) {
    if (!red[p] || label[p]) continue;
    const id = sizes.length; const stack = [p]; label[p] = id; let n = 0; let sx = 0; let sy = 0;
    while (stack.length) {
      const q = stack.pop(); n++; const x = q % w; const y = (q / w) | 0; sx += x; sy += y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx; const Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const k = Y * w + X; if (red[k] && !label[k]) { label[k] = id; stack.push(k); }
      }
    }
    sizes.push(n);
    if (n < 4) continue;
    const score = Math.hypot(sx / n - cx, sy / n - cy) - Math.sqrt(n);   // near the centre, then larger
    if (score < bestScore) { bestScore = score; best = id; }
  }
  const mask = new Uint8Array(w * h);
  if (!best) return { mask, pixels: 0 };
  let count = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let hit = label[y * w + x] === best;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx; const Y = y + dy; if (!hit && X >= 0 && Y >= 0 && X < w && Y < h && label[Y * w + X] === best) hit = true; }
    if (hit) { mask[y * w + x] = 255; count++; }
  }
  return { mask, pixels: count };
}
// The retouch layer's pixels: corrected colour where the mask is set, transparent elsewhere.
export function redEyeFix(rgba, mask, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    if (!mask[p]) continue;
    const v = Math.round(0.8 * (rgba[p * 4 + 1] + rgba[p * 4 + 2]) / 2);
    out[p * 4] = v; out[p * 4 + 1] = v; out[p * 4 + 2] = v; out[p * 4 + 3] = mask[p];
  }
  return out;
}

// ---- P44 frequency separation ------------------------------------------------------------------------
// The engine blends in its 'compatible' space: E = oetf(M709→2020 · eotf(sRGB)), linear light is
// clamp(B + 2S − 1, 0, 1) per channel (vendor/tessella/src/shaders.js blend 16). For original O and low L
// (both 8-bit sRGB), the high layer needs E(H) = (E(O) − E(L)) / 2 + 0.5; it is stored as 8-bit sRGB, so the
// nearest code per channel is chosen; then the high code and the low code (within ±2 of the blur) are nudged
// ±1 where that brings the composite closer to O, because the doubling in linear light turns a half-code
// rounding into a full code. Where even that fails (texture outside the sRGB gamut), the low layer carries the pixel.
const enc2020 = (r, g, b) => mul(M709_2020, [EOTF8[r], EOTF8[g], EOTF8[b]]).map((v) => oetf(Math.max(0, v)));
const dispFromEnc = (E) => mul(M2020_709, E.map(eotf)).map((v) => 255 * oetf(clamp01(v)));
export function linearLight(EL, EH) { return EL.map((l, i) => clamp01(l + 2 * EH[i] - 1)); }
// low is changed in place at pixels the high layer cannot carry (out.adjusted counts them).
export function freqHigh(orig, low, n) {
  const out = new Uint8Array(n * 4); let adjusted = 0;
  for (let p = 0; p < n; p++) {
    const k = p * 4;
    const EO = enc2020(orig[k], orig[k + 1], orig[k + 2]); const EL = enc2020(low[k], low[k + 1], low[k + 2]);
    const want = EO.map((o, i) => clamp01((o - EL[i]) / 2 + 0.5));
    const lin709 = mul(M2020_709, want.map(eotf));
    const h = lin709.map((v) => Math.round(255 * oetf(clamp01(v))));
    // coordinate descent over the high code and the low code (low within ±2 of its blur), ±1 at a time
    const L0 = [low[k], low[k + 1], low[k + 2]]; const ll = L0.slice();
    const err = (hh, lv) => { const d = dispFromEnc(linearLight(enc2020(lv[0], lv[1], lv[2]), enc2020(hh[0], hh[1], hh[2]))); return Math.max(Math.abs(d[0] - orig[k]), Math.abs(d[1] - orig[k + 1]), Math.abs(d[2] - orig[k + 2])); };
    let e = err(h, ll);
    for (let pass = 0; pass < 4 && e > 0.5; pass++) {
      for (let c = 0; c < 6; c++) for (const d of [-1, 1]) {
        const th = h.slice(); const tl = ll.slice();
        if (c < 3) th[c] = Math.max(0, Math.min(255, th[c] + d)); else { const j = c - 3; tl[j] = Math.max(0, Math.min(255, tl[j] + d)); if (Math.abs(tl[j] - L0[j]) > 2) continue; }
        const et = err(th, tl);
        if (et < e) { e = et; h.splice(0, 3, ...th); ll.splice(0, 3, ...tl); }
      }
    }
    if (e <= 1) { low[k] = ll[0]; low[k + 1] = ll[1]; low[k + 2] = ll[2]; }
    if (e > 1) {
      // The texture this pixel needs is outside what an 8-bit sRGB high layer can hold (a saturated edge):
      // the high layer goes to a near-neutral code (127 to 129 per channel) and the low layer takes the pixel's
      // value, nudged ±1 at a time.
      let best = { e: Infinity };
      for (const g0 of [127, 128, 129]) for (const g1 of [127, 128, 129]) for (const g2 of [127, 128, 129]) {
        const hh = [g0, g1, g2]; const EH = enc2020(g0, g1, g2);
        const errL = (lv) => { const d = dispFromEnc(linearLight(enc2020(lv[0], lv[1], lv[2]), EH)); return Math.max(Math.abs(d[0] - orig[k]), Math.abs(d[1] - orig[k + 1]), Math.abs(d[2] - orig[k + 2])); };
        const lv = [orig[k], orig[k + 1], orig[k + 2]]; let el = errL(lv);
        for (let pass = 0; pass < 4 && el > 0.5; pass++) for (let c = 0; c < 3; c++) for (const d of [-1, 1]) {
          const t = lv.slice(); t[c] = Math.max(0, Math.min(255, t[c] + d)); const et = errL(t);
          if (et < el) { el = et; lv[c] = t[c]; }
        }
        if (el < best.e) best = { e: el, hh, lv };
        if (el <= 0.5) break;
      }
      h.splice(0, 3, ...best.hh); ll.splice(0, 3, ...best.lv);
      low[k] = ll[0]; low[k + 1] = ll[1]; low[k + 2] = ll[2];
      adjusted++;
    }
    out[k] = h[0]; out[k + 1] = h[1]; out[k + 2] = h[2]; out[k + 3] = orig[k + 3];
  }
  out.adjusted = adjusted;
  return out;
}
// The composite the engine draws (display 8-bit) for low under high in linear light; for tests and checks.
export function freqComposite(low, high, n) {
  const out = new Uint8Array(n * 4);
  for (let p = 0; p < n; p++) {
    const k = p * 4;
    const d = dispFromEnc(linearLight(enc2020(low[k], low[k + 1], low[k + 2]), enc2020(high[k], high[k + 1], high[k + 2])));
    out[k] = Math.round(d[0]); out[k + 1] = Math.round(d[1]); out[k + 2] = Math.round(d[2]); out[k + 3] = 255;
  }
  return out;
}

// ---- P45 channels ------------------------------------------------------------------------------------
// One channel (0 R, 1 G, 2 B, 3 A) of RGBA as grey RGBA, for thumbnails and the single-channel view.
export function channelGrey(rgba, n, c) {
  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p++) { const v = rgba[p * 4 + c]; out[p * 4] = v; out[p * 4 + 1] = v; out[p * 4 + 2] = v; out[p * 4 + 3] = 255; }
  return out;
}
export function maskGrey(mask, n) {
  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p++) { const v = mask[p]; out[p * 4] = v; out[p * 4 + 1] = v; out[p * 4 + 2] = v; out[p * 4 + 3] = 255; }
  return out;
}
