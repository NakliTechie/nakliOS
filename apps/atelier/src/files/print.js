// Print-side colour on the engine's built-in naive press (tessella model.js PRESS, pressInverse): CMYK readouts,
// a CMYK table for whole-image conversion, and 8-bit CMYK pixels for TIFF export. The press is Atelier's own stand-in
// model, not a characterised printing condition; ICC output profiles are not read (parked).

import { pressInverse } from '../../vendor/tessella/src/model.js';

export const M2020_709 = [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]];
const mulv = (M, c) => M.map((r) => r[0] * c[0] + r[1] * c[1] + r[2] * c[2]);
const enc1 = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
const dec1 = (x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));

// One colour (straight linear Rec.2020) → CMYK percent, the printed colour (sRGB 8-bit), Oklab miss, in gamut.
export function printColour(lin2020, tac = 300) {
  const r = pressInverse(mulv(M2020_709, lin2020), tac);
  return { cmyk: r.cmyk.map((v) => Math.round(v * 1000) / 10), printedSRGB: r.printed.map((v) => Math.round(255 * enc1(Math.min(1, Math.max(0, v))))), deltaE: Math.round(r.deltaE * 10000) / 10000, inGamut: r.inGamut };
}

// CMYK table over sRGB-encoded Rec.709 inputs, n³ nodes (red fastest), 4 coverages each.
export function cmykTable(tac = 300, n = 33) {
  const T = new Float32Array(n * n * n * 4);
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    T.set(pressInverse([r, g, b].map((v) => dec1(v / (n - 1))), tac).cmyk, ((b * n + g) * n + r) * 4);
  }
  return { n, T };
}
// Trilinear CMYK for a linear Rec.709 colour.
export function cmykAt({ n, T }, rgb709) {
  const t = rgb709.map((v) => enc1(Math.min(1, Math.max(0, v))) * (n - 1));
  const i = t.map((v) => Math.min(Math.floor(v), n - 2)); const f = t.map((v, k) => v - i[k]);
  const out = [0, 0, 0, 0];
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
    const o = (((i[2] + dz) * n + i[1] + dy) * n + i[0] + dx) * 4;
    for (let c = 0; c < 4; c++) out[c] += w * T[o + c];
  }
  return out;
}
// Premultiplied linear Rec.2020 float RGBA (renderImage) → interleaved 8-bit CMYK, flattened on paper white.
export function floatToCmyk8(im, tac = 300) {
  const table = cmykTable(tac);
  const out = new Uint8Array(im.width * im.height * 4);
  for (let p = 0; p < im.width * im.height; p++) {
    const a = im.data[p * 4 + 3];
    const lin = [0, 1, 2].map((c) => im.data[p * 4 + c] + (1 - a)); // over white paper
    const k = cmykAt(table, mulv(M2020_709, lin));
    for (let c = 0; c < 4; c++) out[p * 4 + c] = Math.round(255 * Math.min(1, Math.max(0, k[c])));
  }
  return out;
}
