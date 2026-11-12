// Linear DNG writer for merge results (HDR, panorama and focus stack of RAW inputs). The file is a
// LinearRaw DNG: three samples per pixel, already demosaiced, in the camera's own linear RGB, so the
// existing RAW path (LibRaw → develop) opens it and the Develop module tones it like any RAW.
// Source: Adobe "Digital Negative (DNG) Specification" version 1.4.0.0 (June 2012), chapter 4 (tags)
// and chapter 5 (mapping camera colour space to CIE XYZ). Tags used:
//   PhotometricInterpretation 34892 = LinearRaw; DNGVersion 50706; DNGBackwardVersion 50707;
//   UniqueCameraModel 50708; WhiteLevel 50717; ColorMatrix1 50721 (XYZ → camera, SRATIONAL);
//   AsShotNeutral 50728 (camera neutral, RATIONAL); CalibrationIlluminant1 50778 (21 = D65).
// bits 16 writes unsigned integers 0..65535 (WhiteLevel 65535); bits 32 writes IEEE floats
// (SampleFormat 3, DNG 1.4 floating-point data, white = 1.0). Uncompressed strips, little-endian.
// Pure code: node and browser.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8 };

// Nearest rational to v with a fixed denominator (DNG readers accept any denominator).
const rat = (v, den = 1000000) => [Math.round(v * den), den];

// img: { width, height, data: Float32Array RGB interleaved, linear camera RGB, white-balanced or not as
// `neutral` says }. opts: { bits: 16 | 32, camXyz: 3×3 XYZ(D65) → camera, neutral: [r,g,b] camera values
// of a neutral grey (AsShotNeutral), scale: multiplier applied before writing (16-bit: value 1.0 → 65535
// after scale), channelScale: per-channel multipliers [r, g, b] (to undo white balance), model, software,
// description }.
export function writeLinearDng(img, { bits = 16, camXyz, neutral = [1, 1, 1], scale = 1, channelScale = null, model = 'Atelier merge', software = 'Atelier', description = '' } = {}) {
  const { width: W, height: H, data } = img;
  if (data.length !== W * H * 3) throw new Error(`data is ${data.length} samples, expected ${W * H * 3}`);
  if (!camXyz || camXyz.length !== 3) throw new Error('camXyz (XYZ → camera matrix) is required');
  const bps = bits / 8;
  const rowBytes = W * 3 * bps;
  const rps = Math.max(1, Math.min(H, Math.floor((1 << 20) / rowBytes)));
  const strips = [];
  for (let y0 = 0; y0 < H; y0 += rps) {
    const rows = Math.min(rps, H - y0);
    const buf = new Uint8Array(rows * rowBytes); const dv = new DataView(buf.buffer);
    const base = y0 * W * 3;
    for (let i = 0; i < rows * W * 3; i++) {
      const v = data[base + i] * scale * (channelScale ? channelScale[i % 3] : 1);
      if (bits === 16) dv.setUint16(i * 2, Math.max(0, Math.min(65535, Math.round(v * 65535))), true);
      else dv.setFloat32(i * 4, Number.isFinite(v) ? Math.max(0, v) : 0, true);
    }
    strips.push(buf);
  }
  const enc = new TextEncoder();
  const ascii = (s) => enc.encode(`${s}\0`);
  const flat = camXyz.flat();
  const entries = [
    [254, 4, [0]], [256, 4, [W]], [257, 4, [H]], [258, 3, [bits, bits, bits]], [259, 3, [1]], [262, 3, [34892]],
    ...(description ? [[270, 2, ascii(description)]] : []),
    [271, 2, ascii('Atelier')], [272, 2, ascii(model)],
    [273, 4, strips.map(() => 0)], [274, 3, [1]], [277, 3, [3]], [278, 4, [rps]], [279, 4, strips.map((s) => s.length)],
    [284, 3, [1]], [305, 2, ascii(software)], [339, 3, Array(3).fill(bits === 32 ? 3 : 1)],
    [50706, 1, [1, 4, 0, 0]], [50707, 1, [bits === 32 ? 1 : 1, bits === 32 ? 4 : 1, 0, 0]],
    [50708, 2, ascii(model)],
    ...(bits === 16 ? [[50717, 4, [65535, 65535, 65535]]] : []),
    [50721, 10, flat.map((v) => rat(v, 10000))], [50728, 5, neutral.map((v) => rat(v))], [50778, 3, [21]],
  ].sort((a, b) => a[0] - b[0]);
  const ifdAt = 8; const ifdSize = 2 + entries.length * 12 + 4;
  let extra = 0;
  for (const [, type, v] of entries) { const s = TYPE_SIZE[type] * v.length; if (s > 4) extra += (s + 1) & ~1; }
  let dataAt = ifdAt + ifdSize + extra;
  const offsets = strips.map((s) => { const o = dataAt; dataAt += s.length; return o; });
  entries.find((e) => e[0] === 273)[2] = offsets;
  const out = new Uint8Array(dataAt); const dv = new DataView(out.buffer);
  dv.setUint16(0, 0x4949, true); dv.setUint16(2, 42, true); dv.setUint32(4, ifdAt, true);
  dv.setUint16(ifdAt, entries.length, true);
  let x = ifdAt + ifdSize;
  entries.forEach(([tag, type, v], i) => {
    const e = ifdAt + 2 + i * 12;
    dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, v.length, true);
    const size = TYPE_SIZE[type] * v.length; let at = e + 8;
    if (size > 4) { dv.setUint32(e + 8, x, true); at = x; x += (size + 1) & ~1; }
    for (let k = 0; k < v.length; k++) {
      if (type === 1 || type === 2) out[at + k] = v[k];
      else if (type === 3) dv.setUint16(at + k * 2, v[k], true);
      else if (type === 4) dv.setUint32(at + k * 4, v[k], true);
      else if (type === 5) { dv.setUint32(at + k * 8, v[k][0], true); dv.setUint32(at + k * 8 + 4, v[k][1], true); }
      else if (type === 10) { dv.setInt32(at + k * 8, v[k][0], true); dv.setInt32(at + k * 8 + 4, v[k][1], true); }
    }
  });
  dv.setUint32(ifdAt + 2 + entries.length * 12, 0, true);
  strips.forEach((s, i) => out.set(s, offsets[i]));
  return out;
}

// XYZ (D65) → linear Rec.709/sRGB primaries: the camXyz for merges of browser images (sRGB inputs).
export const XYZ_TO_SRGB = [[3.2404542, -1.5371385, -0.4985314], [-0.9692660, 1.8760108, 0.0415560], [0.0556434, -0.2040259, 1.0572252]];
