// Colour spaces for export (P48): matrices derived from primaries, transfer functions, a generated
// ICC v4 matrix/TRC display profile, and profile embedding in PNG (iCCP or sRGB chunk), JPEG (APP2),
// WebP (VP8X + ICCP). TIFF carries the profile in tag 34675 (src/files/tiff.js). Pure code: node and browser.

import { chunk, pngChunks } from './png.js';

// ---- primaries and matrices ----------------------------------------------------------------------
const D65 = [0.3127, 0.3290];
export const SPACES = {
  srgb: { name: 'sRGB IEC61966-2.1 (Atelier)', primaries: [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]], trc: 'srgb' },
  'display-p3': { name: 'Display P3 (Atelier)', primaries: [[0.680, 0.320], [0.265, 0.690], [0.150, 0.060]], trc: 'srgb' },
  rec2020: { name: 'Rec. ITU-R BT.2020 (Atelier)', primaries: [[0.708, 0.292], [0.170, 0.797], [0.131, 0.046]], trc: 'bt2020' },
};

const mul = (A, B) => A.map((r) => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0)));
const mulv = (A, v) => A.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
export function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h; const B = -(d * i - f * g); const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
const xyz = ([x, y]) => [x / y, 1, (1 - x - y) / y];
// RGB → XYZ for primaries and white: M = P · diag(S), S = P⁻¹ · W, P's columns the primaries' XYZ (Y = 1).
export function rgbToXyz(primaries, white = D65) {
  const P = [0, 1, 2].map((r) => primaries.map((p) => xyz(p)[r]));
  const S = mulv(inv3(P), xyz(white));
  return P.map((row) => row.map((v, j) => v * S[j]));
}
// Linear Rec.2020 (the engine's working space) → linear target space: M_target⁻¹ · M_2020.
export function fromRec2020(space) {
  return mul(inv3(rgbToXyz(SPACES[space].primaries)), rgbToXyz(SPACES.rec2020.primaries));
}

// Bradford chromatic adaptation D65 → D50 (ICC PCS): M_BFD⁻¹ · diag(ρ50/ρ65) · M_BFD.
const BFD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
const D50_XYZ = [0.9642, 1, 0.8249];   // ICC PCS illuminant, as the spec writes it
export function bradford(src, dst) {
  const s = mulv(BFD, src); const d = mulv(BFD, dst);
  return mul(inv3(BFD), mul([[d[0] / s[0], 0, 0], [0, d[1] / s[1], 0], [0, 0, d[2] / s[2]]], BFD));
}

// ---- transfer functions (encode: linear → signal) ------------------------------------------------
// sRGB: V = 12.92 L for L ≤ 0.0031308, else 1.055 L^(1/2.4) − 0.055 (IEC 61966-2-1).
// BT.2020 (10/12-bit form, same as BT.709): V = 4.5 L for L < 0.018053968, else 1.099297 L^0.45 − 0.099297.
export const encodeTrc = {
  srgb: (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055),
  bt2020: (x) => (x < 0.018053968510807 ? 4.5 * x : 1.09929682680944 * Math.pow(x, 0.45) - 0.09929682680944),
};
// ICC parametricCurveType 3 (decode: signal X → linear Y): Y = (aX + b)^g for X ≥ d, else cX.
const PARA = {
  srgb: [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045],
  bt2020: [1 / 0.45, 1 / 1.09929682680944, 0.09929682680944 / 1.09929682680944, 1 / 4.5, 4.5 * 0.018053968510807],
};

// Premultiplied linear Rec.2020 floats (engine output) → straight-alpha RGBA in the target space.
// bits 8 → Uint8ClampedArray, 16 → Uint16Array. background (0..1 linear) flattens alpha (JPEG).
export function convertFloat(im, space, bits = 8, background = null) {
  const M = fromRec2020(space); const enc = encodeTrc[SPACES[space].trc];
  const n = im.width * im.height; const max = bits === 16 ? 65535 : 255;
  const out = bits === 16 ? new Uint16Array(n * 4) : new Uint8ClampedArray(n * 4);
  const d = im.data;
  for (let i = 0; i < n; i++) {
    let r = d[i * 4]; let g = d[i * 4 + 1]; let b = d[i * 4 + 2]; let a = d[i * 4 + 3];
    if (background != null) { r += background * (1 - a); g += background * (1 - a); b += background * (1 - a); a = 1; }
    const k = a > 0 ? 1 / a : 0; r *= k; g *= k; b *= k;
    for (let j = 0; j < 3; j++) {
      const v = M[j][0] * r + M[j][1] * g + M[j][2] * b;
      out[i * 4 + j] = Math.round(max * enc(Math.min(1, Math.max(0, v))));
    }
    out[i * 4 + 3] = Math.round(max * Math.min(1, Math.max(0, a)));
  }
  return out;
}

// ---- ICC v4.3 profile writer ----------------------------------------------------------------------
const s15 = (v) => Math.round(v * 65536) | 0;
function bytesOf(build, size) { const b = new Uint8Array(size); build(new DataView(b.buffer), b); return b; }
const ascii = (b, o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
function mluc(text) {
  return bytesOf((dv, b) => {
    ascii(b, 0, 'mluc'); dv.setUint32(8, 1); dv.setUint32(12, 12);
    ascii(b, 16, 'enUS'); dv.setUint32(20, text.length * 2); dv.setUint32(24, 28);
    for (let i = 0; i < text.length; i++) dv.setUint16(28 + i * 2, text.charCodeAt(i));
  }, 28 + text.length * 2);
}
const xyzTag = (v) => bytesOf((dv, b) => { ascii(b, 0, 'XYZ '); v.forEach((x, i) => dv.setInt32(8 + i * 4, s15(x))); }, 20);
const para = (p) => bytesOf((dv, b) => { ascii(b, 0, 'para'); dv.setUint16(8, 3); p.forEach((x, i) => dv.setInt32(12 + i * 4, s15(x))); }, 32);
const sf32 = (m) => bytesOf((dv, b) => { ascii(b, 0, 'sf32'); m.flat().forEach((x, i) => dv.setInt32(8 + i * 4, s15(x))); }, 44);

// A display-class RGB profile: colorants are the D65 RGB→XYZ columns adapted to D50 (Bradford),
// wtpt is the D50 PCS white (v4 rule), chad holds the adaptation, and one para curve serves R, G and B.
export function makeIcc(space) {
  const sp = SPACES[space]; if (!sp) throw new Error(`no colour space ${space}`);
  const chad = bradford(xyz(D65), D50_XYZ);
  const M = mul(chad, rgbToXyz(sp.primaries));
  const trc = para(PARA[sp.trc]);
  const tags = [['desc', mluc(sp.name)], ['cprt', mluc('No copyright, use freely (CC0)')], ['wtpt', xyzTag(D50_XYZ)],
    ['rXYZ', xyzTag([M[0][0], M[1][0], M[2][0]])], ['gXYZ', xyzTag([M[0][1], M[1][1], M[2][1]])], ['bXYZ', xyzTag([M[0][2], M[1][2], M[2][2]])],
    ['rTRC', trc], ['gTRC', trc], ['bTRC', trc], ['chad', sf32(chad)]];
  const table = 128 + 4 + tags.length * 12;
  const pad = (n) => (n + 3) & ~3;
  const offsets = new Map(); let o = table;
  for (const [, data] of tags) if (!offsets.has(data)) { offsets.set(data, o); o += pad(data.length); }
  const size = o;
  return bytesOf((dv, b) => {
    dv.setUint32(0, size); dv.setUint32(8, 0x04300000); ascii(b, 12, 'mntr'); ascii(b, 16, 'RGB '); ascii(b, 20, 'XYZ ');
    dv.setUint16(24, 2026); dv.setUint16(26, 11); dv.setUint16(28, 12);
    ascii(b, 36, 'acsp'); D50_XYZ.forEach((v, i) => dv.setInt32(68 + i * 4, s15(v)));
    dv.setUint32(128, tags.length);
    tags.forEach(([sig, data], i) => { const e = 132 + i * 12; ascii(b, e, sig); dv.setUint32(e + 4, offsets.get(data)); dv.setUint32(e + 8, data.length); });
    for (const [data, off] of offsets) b.set(data, off);
  }, size);
}

// Reads back what makeIcc writes (and the same tags from other matrix/TRC profiles).
export function parseIcc(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o, n) => String.fromCharCode(...bytes.subarray(o, o + n));
  if (str(36, 4) !== 'acsp') throw new Error('not an ICC profile');
  const out = { size: dv.getUint32(0), version: `${bytes[8]}.${bytes[9] >> 4}`, class: str(12, 4), colorSpace: str(16, 4), pcs: str(20, 4), tags: {} };
  const n = dv.getUint32(128);
  for (let i = 0; i < n; i++) {
    const e = 132 + i * 12; const sig = str(e, 4); const off = dv.getUint32(e + 4); const type = str(off, 4);
    const f = (k) => dv.getInt32(off + k) / 65536;
    if (type === 'XYZ ') out.tags[sig] = [f(8), f(12), f(16)];
    else if (type === 'para') out.tags[sig] = { fn: dv.getUint16(off + 8), params: [0, 1, 2, 3, 4, 5, 6].slice(0, [1, 3, 4, 5, 7][dv.getUint16(off + 8)]).map((k) => f(12 + k * 4)) };
    else if (type === 'mluc') { const len = dv.getUint32(off + 20); const so = off + dv.getUint32(off + 24); let s = ''; for (let k = 0; k < len; k += 2) s += String.fromCharCode(dv.getUint16(so + k)); out.tags[sig] = s; }
    else if (type === 'desc') { const len = dv.getUint32(off + 8); out.tags[sig] = str(off + 12, len).replace(/\0+$/, ''); }
    else if (type === 'sf32') out.tags[sig] = [0, 1, 2].map((r) => [0, 1, 2].map((c) => f(8 + (r * 3 + c) * 4)));
    else out.tags[sig] = type;
  }
  out.description = out.tags.desc ?? null;
  return out;
}

// ---- embedding ------------------------------------------------------------------------------------
async function zlib(bytes, mode) {
  const s = mode === 'compress' ? new CompressionStream('deflate') : new DecompressionStream('deflate');
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(s)).arrayBuffer());
}
const join = (parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

// PNG: drops any colour chunks (sRGB, iCCP, gAMA, cHRM) and inserts one after IHDR: the sRGB chunk
// (rendering intent 0, perceptual) for sRGB, otherwise an iCCP chunk holding the profile.
export async function tagPng(bytes, space) {
  const chunks = pngChunks(bytes).filter((c) => !['sRGB', 'iCCP', 'gAMA', 'cHRM'].includes(c.type));
  let tag;
  if (space === 'srgb') tag = chunk('sRGB', new Uint8Array([0]));
  else { const name = new TextEncoder().encode('ICC profile'); tag = chunk('iCCP', join([name, new Uint8Array([0, 0]), await zlib(makeIcc(space), 'compress')])); }
  const parts = [bytes.subarray(0, 8)];
  for (const c of chunks) { parts.push(c.bytes); if (c.type === 'IHDR') parts.push(tag); }
  return join(parts);
}

// JPEG: drops existing ICC APP2 segments and inserts one after SOI and any APP0/APP1 segments.
export function tagJpeg(bytes, space) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG');
  const icc = makeIcc(space);
  const head = new TextEncoder().encode('ICC_PROFILE\0');
  const len = 2 + head.length + 2 + icc.length;
  if (len > 65535) throw new Error('ICC profile too large for one APP2 segment');
  const app2 = join([new Uint8Array([0xff, 0xe2, len >> 8, len & 255]), head, new Uint8Array([1, 1]), icc]);
  const parts = [bytes.subarray(0, 2)]; let o = 2; let inserted = false;
  while (o < bytes.length && bytes[o] === 0xff) {
    const m = bytes[o + 1];
    if (m === 0xda || m === 0xd9) break;   // start of scan: the rest is entropy-coded data
    const L = (bytes[o + 2] << 8) | bytes[o + 3]; const seg = bytes.subarray(o, o + 2 + L);
    const isIcc = m === 0xe2 && String.fromCharCode(...seg.subarray(4, 15)) === 'ICC_PROFILE';
    if (!inserted && m !== 0xe0 && m !== 0xe1) { parts.push(app2); inserted = true; }
    if (!isIcc) parts.push(seg);
    o += 2 + L;
  }
  if (!inserted) parts.push(app2);
  parts.push(bytes.subarray(o));
  return join(parts);
}

// WebP: converts a simple VP8/VP8L file to the extended (VP8X) form and adds an ICCP chunk.
export function tagWebp(bytes, space) {
  const str = (o) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (str(0) !== 'RIFF' || str(8) !== 'WEBP') throw new Error('not a WebP');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = []; let o = 12;
  while (o + 8 <= bytes.length) { const t = str(o); const n = dv.getUint32(o + 4, true); chunks.push({ type: t, bytes: bytes.subarray(o, o + 8 + n + (n & 1)), data: bytes.subarray(o + 8, o + 8 + n) }); o += 8 + n + (n & 1); }
  const icc = makeIcc(space);
  const riff = (type, data) => { const h = new Uint8Array(8); ascii(h, 0, type); new DataView(h.buffer).setUint32(4, data.length, true); return join([h, data, data.length & 1 ? new Uint8Array(1) : new Uint8Array(0)]); };
  let vp8x = chunks.find((c) => c.type === 'VP8X');
  let x;
  if (vp8x) { x = new Uint8Array(vp8x.data); x[0] |= 0x20; }
  else {
    const img = chunks.find((c) => c.type === 'VP8 ' || c.type === 'VP8L'); if (!img) throw new Error('WebP without image data');
    let w; let h; let alpha = false; const d = img.data;
    if (img.type === 'VP8L') { const bits = d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24); w = (bits & 0x3fff) + 1; h = ((bits >>> 14) & 0x3fff) + 1; alpha = !!((bits >>> 28) & 1); }
    else { w = (d[6] | (d[7] << 8)) & 0x3fff; h = (d[8] | (d[9] << 8)) & 0x3fff; }
    x = new Uint8Array(10); x[0] = 0x20 | (alpha ? 0x10 : 0);
    x[4] = (w - 1) & 255; x[5] = ((w - 1) >> 8) & 255; x[6] = ((w - 1) >> 16) & 255;
    x[7] = (h - 1) & 255; x[8] = ((h - 1) >> 8) & 255; x[9] = ((h - 1) >> 16) & 255;
  }
  const body = [riff('VP8X', x), riff('ICCP', icc), ...chunks.filter((c) => c.type !== 'VP8X' && c.type !== 'ICCP').map((c) => c.bytes)];
  const payload = join(body);
  const head = new Uint8Array(12); ascii(head, 0, 'RIFF'); new DataView(head.buffer).setUint32(4, payload.length + 4, true); ascii(head, 8, 'WEBP');
  return join([head, payload]);
}

// Reads the colour tag back from a PNG, JPEG or WebP file: { srgbChunk } or { icc } (raw profile bytes) or {}.
export async function readColorTag(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    for (const c of pngChunks(bytes)) {
      if (c.type === 'sRGB') return { srgbChunk: true };
      if (c.type === 'iCCP') { const z = c.data.indexOf(0); return { icc: await zlib(c.data.subarray(z + 2), 'decompress') }; }
    }
    return {};
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o < bytes.length && bytes[o] === 0xff && bytes[o + 1] !== 0xda) {
      const L = (bytes[o + 2] << 8) | bytes[o + 3];
      if (bytes[o + 1] === 0xe2 && String.fromCharCode(...bytes.subarray(o + 4, o + 15)) === 'ICC_PROFILE') return { icc: bytes.slice(o + 18, o + 2 + L) };
      o += 2 + L;
    }
    return {};
  }
  if (String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let o = 12;
    while (o + 8 <= bytes.length) { const t = String.fromCharCode(...bytes.subarray(o, o + 4)); const n = dv.getUint32(o + 4, true); if (t === 'ICCP') return { icc: bytes.slice(o + 8, o + 8 + n) }; o += 8 + n + (n & 1); }
    return {};
  }
  return {};
}
