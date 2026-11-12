// ICC output profiles through LittleCMS (vendor/lcms-wasm, MIT, loaded lazily on first use): soft-proof tables for
// tessella's proof adjustment (model 'icc') and CMYK separation for TIFF export, both through a CMYK profile the
// person supplies. Input side: LittleCMS's built-in sRGB profile, so colours outside Rec.709 are clipped to it
// first (the engine's proof table has the same sRGB-encoded Rec.709 domain). Pure code: node and browser.

let cmsPromise = null;
async function cms() {
  cmsPromise ||= (async () => {
    const L = await import('../../vendor/lcms-wasm/lcms.js');
    return { L, lcms: await L.instantiate() };
  })();
  return cmsPromise;
}

export const INTENTS = Object.freeze({ perceptual: 0, relative: 1, saturation: 2, absolute: 3 });
const intentOf = (name = 'relative') => {
  if (!(name in INTENTS)) throw new Error(`rendering intent ${name}; use ${Object.keys(INTENTS).join(', ')}`);
  return INTENTS[name];
};

// Opens a CMYK output profile. Returns { name, close() , handle } or throws when the bytes are not a CMYK ICC profile.
async function openCmyk(bytes) {
  const { L, lcms } = await cms();
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const h = lcms.cmsOpenProfileFromMem(b, b.byteLength);
  if (!h) throw new Error('not an ICC profile LittleCMS can read');
  if (lcms.cmsGetColorSpace(h) !== L.cmsSigCmykData) { lcms.cmsCloseProfile(h); throw new Error('the profile is not a CMYK output profile'); }
  const name = lcms.cmsGetProfileInfoASCII(h, L.cmsInfoDescription, 'en', 'US') || 'unnamed profile';
  return { L, lcms, h, name, close: () => lcms.cmsCloseProfile(h) };
}

// Profile facts without building a transform: { name }.
export async function cmykProfileInfo(bytes) {
  const p = await openCmyk(bytes); try { return { name: p.name }; } finally { p.close(); }
}

// sRGB → CMYK and CMYK → sRGB transforms (16-bit) through the profile. Caller calls close().
async function transforms(bytes, intent, bpc = true) {
  const p = await openCmyk(bytes);
  const { L, lcms } = p;
  const srgb = lcms.cmsCreate_sRGBProfile();
  const it = intentOf(intent);
  const fwd = lcms.cmsCreateTransform(srgb, L.TYPE_RGB_16, p.h, L.TYPE_CMYK_16, it, bpc ? L.cmsFLAGS_BLACKPOINTCOMPENSATION : 0);
  const back = lcms.cmsCreateTransform(p.h, L.TYPE_CMYK_16, srgb, L.TYPE_RGB_16, L.INTENT_RELATIVE_COLORIMETRIC, 0);
  if (!fwd || !back) { if (fwd) lcms.cmsDeleteTransform(fwd); if (back) lcms.cmsDeleteTransform(back); lcms.cmsCloseProfile(srgb); p.close(); throw new Error('LittleCMS could not build a transform for this profile'); }
  return {
    name: p.name,
    toCmyk: (rgb16, n) => lcms.cmsDoTransform(fwd, rgb16, n).slice(0, n * 4),
    toRgb: (cmyk16, n) => lcms.cmsDoTransform(back, cmyk16, n).slice(0, n * 3),
    close() { lcms.cmsDeleteTransform(fwd); lcms.cmsDeleteTransform(back); lcms.cmsCloseProfile(srgb); p.close(); },
  };
}

// Oklab distance between two linear Rec.709 colours (the engine's gamut flag uses the same measure).
const cbrt = Math.cbrt;
function oklab([r, g, b]) {
  const l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
const dec1 = (x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));

// Soft-proof table for tessella's proof adjustment (model 'icc'): size³ nodes over sRGB-encoded Rec.709 inputs,
// red fastest; each node is the colour after sRGB → CMYK (intent) → sRGB (relative colorimetric, paper white shows as
// white), sRGB-encoded, and a gamut flag f = smoothstep(0.02, 0.12, ΔOklab(input, proofed)), the same measure and
// ramp as the built-in press table. Returns { table: Float32Array, size, name }.
export async function iccProofTable(bytes, { intent = 'relative', size = 17, bpc = true } = {}) {
  const t = await transforms(bytes, intent, bpc);
  try {
    const n = size ** 3; const rgb = new Uint16Array(n * 3);
    for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
      const o = ((b * size + g) * size + r) * 3;
      rgb[o] = Math.round((65535 * r) / (size - 1)); rgb[o + 1] = Math.round((65535 * g) / (size - 1)); rgb[o + 2] = Math.round((65535 * b) / (size - 1));
    }
    const back = t.toRgb(t.toCmyk(rgb, n), n);
    const table = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const vin = [0, 1, 2].map((c) => rgb[i * 3 + c] / 65535); const vout = [0, 1, 2].map((c) => back[i * 3 + c] / 65535);
      const p = oklab(vin.map(dec1)); const q = oklab(vout.map(dec1));
      const x = Math.min(1, Math.max(0, (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) - 0.02) / 0.1));
      table.set([...vout, x * x * (3 - 2 * x)], i * 4);
    }
    return { table, size, name: t.name };
  } finally { t.close(); }
}

// sRGB-encoded 16-bit RGB pixels (interleaved, n pixels) → CMYK 16-bit through the profile, in chunks.
export async function rgb16ToCmyk16(bytes, rgb16, n, { intent = 'relative', bpc = true } = {}) {
  const t = await transforms(bytes, intent, bpc);
  try {
    const out = new Uint16Array(n * 4); const CH = 1 << 18;
    for (let i = 0; i < n; i += CH) {
      const k = Math.min(CH, n - i);
      out.set(t.toCmyk(rgb16.subarray(i * 3, (i + k) * 3), k), i * 4);
    }
    return { cmyk: out, name: t.name };
  } finally { t.close(); }
}

// CMYK 16-bit → sRGB-encoded 16-bit through the profile (relative colorimetric), for readouts and tests.
export async function cmyk16ToRgb16(bytes, cmyk16, n) {
  const t = await transforms(bytes, 'relative');
  try { return t.toRgb(cmyk16, n); } finally { t.close(); }
}
