// WGSL for tessella. Every formula here has a float64 twin in src/reference.js, which the checks
// compare against; change both together.
//
// Compositor: one dispatch per layer per batch of tiles. Source kinds: 0 RAW (or any straight linear
// Rec.2020 texture, such as a lens-blurred image), 1 sRGB image, 2 solid, 5 adjustment layer (no source: it
// transforms the accumulator, see adjust()),
// 3 isolated group (the group's scratch tile, composited as one layer), 4 pass-through group (mixes the
// scratch tile over the accumulator by opacity × mask). Kinds 3 and 4 read the scratch slice tiles[i].w at
// the same pixel, already at this lod; only the group mask is averaged over the pixel's document footprint. Each pixel at a level of detail (lod) box-
// filters its document footprint; each sample maps through the layer's inverse affine into source
// texels (bilinear, with an exact single-texel path for whole-pixel offsets). RAW layers sample their
// developed texture: the develop passes (DEV_*_WGSL) run once per develop change over the full-resolution
// source and write an rgba16float texture, so neighbourhood stages are possible and tiles stay cheap.

import { DEV_SLOTS, CURVE_N } from './model.js';

export { CURVE_N };

export const TILE = 256;
export const MAX_MASK = 4;

export const BLEND_MODES = Object.freeze([
  'normal', 'dissolve', 'darken', 'multiply', 'color-burn', 'linear-burn', 'darker-color',
  'lighten', 'screen', 'color-dodge', 'linear-dodge', 'lighter-color',
  'overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix',
  'difference', 'exclusion', 'subtract', 'divide',
  'hue', 'saturation', 'color', 'luminosity',
]);

// 16-bit RGB (packed two samples per u32) → rgba16float, one band of rows per dispatch.
export const UPLOAD_WGSL = /* wgsl */`
struct P { width: u32, rowOffset: u32, rows: u32, scale: f32 };
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: P;
fn s16(i: u32) -> f32 {
  let w = src[i >> 1u];
  return f32(select(w & 0xFFFFu, w >> 16u, (i & 1u) == 1u));
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.width || id.y >= p.rows) { return; }
  let b = (id.y * p.width + id.x) * 3u;
  let c = vec3f(s16(b), s16(b + 1u), s16(b + 2u)) * p.scale;
  textureStore(dst, vec2u(id.x, id.y + p.rowOffset), vec4f(c, 1.0));
}`;

// Float32 RGB → rgba16float (linear float sources), one band of rows per dispatch.
export const UPLOAD_F32_WGSL = /* wgsl */`
struct P { width: u32, rowOffset: u32, rows: u32, scale: f32 };
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.width || id.y >= p.rows) { return; }
  let b = (id.y * p.width + id.x) * 3u;
  let c = vec3f(src[b], src[b + 1u], src[b + 2u]) * p.scale;
  textureStore(dst, vec2u(id.x, id.y + p.rowOffset), vec4f(c, 1.0));
}`;

// Uniform layout, byte offsets (engine.js writeLayerUniform mirrors these):
//   0 lod first blend blendSpace | 16 kind (0 raw, 1 image, 2 solid, 3 isolated group, 4 pass-through group, 5 adjustment) srcW srcH docW
//   32 docH maskCount maskInvert clipMode (0 none, 1 clipping base: write its alpha, 2 clipped: read the base alpha)
//   48 inv(a b c d) | 64 invT(e f) opacity fill | 80 solid rgba | 96 q0 | 112 q1 | 128 q2 (h22, quad on, adjustment type, _) | 144 dev3
//   q0..q2: the perspective quad's document → source homography, row major (h00 h01 h02 h10 | h11 h12 h20 h21 | h22)
//   160 mask[i]: head(kind op _ _) p0 p1, 48 bytes each, 4 of them → 352 bytes
export const U_SIZE = 352;
// Oklch hue (degrees) of each mixer band's centre: the sRGB primaries and secondaries plus orange and purple.
export const BAND_HUES = Object.freeze([29, 55, 110, 142, 195, 264, 300, 328]);

export const COLOUR_WGSL = /* wgsl */`
const LUMA = vec3f(0.2627, 0.6780, 0.0593); // Rec.2020
const PI2 = 6.283185307179586;
const M2020_709 = mat3x3f(vec3f(1.6605, -0.1246, -0.0182), vec3f(-0.5876, 1.1329, -0.1006), vec3f(-0.0728, -0.0083, 1.1187));
const M709_2020 = mat3x3f(vec3f(0.6274, 0.0691, 0.0164), vec3f(0.3293, 0.9195, 0.0880), vec3f(0.0433, 0.0114, 0.8956));

fn oetf1(x: f32) -> f32 { if (x <= 0.0031308) { return 12.92 * x; } return 1.055 * pow(x, 1.0 / 2.4) - 0.055; }
fn eotf1(x: f32) -> f32 { if (x <= 0.04045) { return x / 12.92; } return pow((x + 0.055) / 1.055, 2.4); }
fn oetf(c: vec3f) -> vec3f { return vec3f(oetf1(c.r), oetf1(c.g), oetf1(c.b)); }
fn eotf(c: vec3f) -> vec3f { return vec3f(eotf1(c.r), eotf1(c.g), eotf1(c.b)); }
fn cbrt(x: f32) -> f32 { return sign(x) * pow(abs(x), 1.0 / 3.0); }

fn toOklab(c: vec3f) -> vec3f {
  let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  let l_ = cbrt(l); let m_ = cbrt(m); let s_ = cbrt(s);
  return vec3f(0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
               1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
               0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_);
}
fn fromOklab(o: vec3f) -> vec3f {
  let l_ = o.x + 0.3963377774 * o.y + 0.2158037573 * o.z;
  let m_ = o.x - 0.1055613458 * o.y - 0.0638541728 * o.z;
  let s_ = o.x - 0.0894841775 * o.y - 1.2914855480 * o.z;
  let l = l_ * l_ * l_; let m = m_ * m_ * m_; let s = s_ * s_ * s_;
  return vec3f(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
              -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
              -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}

`;

// ---- develop passes ---------------------------------------------------------------------------------
// Run once per develop change over the full-resolution RAW source. Intermediates are rgba32float scratch
// textures (freed after the develop); the result is the layer's rgba16float developed texture.
// Order: geometry and camera colour (LIN) → detail (NR, defringe; then sharpening) → local-contrast grid →
// tone and colour, effects, LUT (TONE). Every formula has a float64 twin in reference.js (developRef).
const DEV_STRUCT = `struct DevU {
${DEV_SLOTS.map(([k, n]) => (n === 1 ? `  ${k}: vec4f,` : `  ${k}: array<vec4f, ${n}>,`)).join('\n')}
};`;

export const DEV_TONE_FNS = /* wgsl */`
var<private> BAND_HUES: array<f32, 8> = array<f32, 8>(${BAND_HUES.map((h) => h.toFixed(1)).join(', ')});
fn mixAt(i: u32) -> f32 { return u.mixv[i / 4u][i % 4u]; }
// Piecewise-linear weights between neighbouring band centres around the hue circle; they sum to 1.
fn bandWeight(b: u32, h: f32) -> f32 {
  let c = BAND_HUES[b];
  let prev = BAND_HUES[(b + 7u) % 8u]; let next = BAND_HUES[(b + 1u) % 8u];
  let d = fract((h - c) / 360.0 + 0.5) * 360.0 - 180.0;          // signed distance to centre, -180..180
  let dPrev = fract((c - prev) / 360.0) * 360.0; let dNext = fract((next - c) / 360.0) * 360.0;
  if (d >= 0.0) { return max(0.0, 1.0 - d / dNext); }
  return max(0.0, 1.0 + d / dPrev);
}
fn mixer(o0: vec3f) -> vec3f {
  var o = o0;
  let C = length(o.yz);
  var h = atan2(o.z, o.y) * 57.29577951308232;
  if (h < 0.0) { h = h + 360.0; }
  var dh = 0.0; var ds = 0.0; var dl = 0.0;
  for (var b = 0u; b < 8u; b++) {
    let w = bandWeight(b, h);
    dh += w * mixAt(b * 3u); ds += w * mixAt(b * 3u + 1u); dl += w * mixAt(b * 3u + 2u);
  }
  let chromaW = C / (C + 0.05);
  if (u.gradeX.z == 2.0) { return vec3f(clamp(o.x + dl * 0.3 * chromaW, 0.0, 2.0), 0.0, 0.0); }  // black and white
  let h2 = (h + dh * 30.0) * 0.017453292519943295;
  let C2 = max(C * (1.0 + ds), 0.0);
  return vec3f(o.x + dl * 0.3 * chromaW, C2 * cos(h2), C2 * sin(h2));
}
fn grading(o0: vec3f) -> vec3f {
  var o = o0;
  let p = clamp(0.5 + 0.25 * u.gradeX.y, 0.1, 0.9);
  let w = mix(0.15, 0.5, u.gradeX.x);
  let ws = 1.0 - smoothstep(p - w, p, o.x);
  let wh = smoothstep(p, p + w, o.x);
  let wm = max(0.0, 1.0 - ws - wh);
  var ws4 = array<f32, 4>(ws, wm, wh, 1.0);
  for (var k = 0u; k < 4u; k++) {
    let g = u.grade[k];
    let a = g.x * 0.017453292519943295;
    o = vec3f(o.x + ws4[k] * g.z * 0.15, o.y + ws4[k] * g.y * 0.08 * cos(a), o.z + ws4[k] * g.y * 0.08 * sin(a));
  }
  return o;
}

fn curveAt(ch: u32, x: f32) -> f32 {
  let t = clamp(x, 0.0, 1.0) * f32(${CURVE_N - 1});
  let i = min(u32(floor(t)), ${CURVE_N - 2}u);
  let f = t - f32(i);
  let base = ch * ${CURVE_N}u;
  return mix(curve[base + i], curve[base + i + 1u], f);
}

fn dpcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// Value noise in -1..1: hashed lattice values, smoothstep-interpolated (q >= 0).
fn vnoise(q: vec2f, seed: u32) -> f32 {
  let i = vec2u(floor(q)); let f = q - floor(q); let s = f * f * (3.0 - 2.0 * f);
  let h = array<f32, 4>(
    f32(dpcg(i.x + dpcg(i.y + seed))), f32(dpcg(i.x + 1u + dpcg(i.y + seed))),
    f32(dpcg(i.x + dpcg(i.y + 1u + seed))), f32(dpcg(i.x + 1u + dpcg(i.y + 1u + seed))));
  let a = h[0] / 4294967295.0 * 2.0 - 1.0; let b = h[1] / 4294967295.0 * 2.0 - 1.0;
  let c = h[2] / 4294967295.0 * 2.0 - 1.0; let d = h[3] / 4294967295.0 * 2.0 - 1.0;
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}
// Grain (fx = amount, size px, roughness): n = (1 - r) vnoise(p / size) + r vnoise(2 p / size + 37);
// x *= max(1 + 0.3 amount n, 0). p is the texel centre in photo pixels, so grain is fixed to the photo.
fn grain(x: vec3f, p: vec2f) -> vec3f {
  let n = (1.0 - u.fx.z) * vnoise(p / u.fx.y, 0u) + u.fx.z * vnoise(2.0 * p / u.fx.y + vec2f(37.0), 1u);
  return x * max(1.0 + 0.3 * u.fx.x * n, 0.0);
}

// Tone and colour: tone mapper, luminance adjustments, contrast, Oklab colour, mixer, grading, curves,
// post-crop vignette. x is linear Rec.2020 after the scene-linear stages; pos = 0..1 in the photo.
fn toneColour(x0: vec3f, pos: vec2f) -> vec3f {
  var x = x0;
  var y = dot(x, LUMA);
  if (y > 1e-8 && u.tone[0].x > 0.0) {   // white point 0: no tone mapper (develop adjustment layers)
    let w2 = u.tone[0].x * u.tone[0].x;
    x = x * ((1.0 + y / w2) / (1.0 + y));
  }
  x = max(x, vec3f(0.0));
  // luminance adjustments on the clamped luminance; the delta also applies above 1
  y = dot(x, LUMA);
  if (y > 1e-8) {
    let yn = min(y, 1.0);
    var t = yn;
    t = t + u.tone[0].w * 1.2 * t * (1.0 - t) * (1.0 - t);   // shadows
    t = t + u.tone[0].z * 1.2 * t * t * (1.0 - t);           // highlights
    t = t + u.tone[1].x * 0.3 * t * t * t * t;               // whites
    t = t + u.tone[1].y * 0.15 * pow(1.0 - t, 4.0);          // blacks
    t = clamp(t, 0.0, 1.0);
    let p = oetf1(t);
    let p2 = p + u.tone[0].y * sin(PI2 * (p - 0.5)) / PI2;    // contrast S-curve in display space
    let y2 = max(y + (eotf1(clamp(p2, 0.0, 1.0)) - yn), 0.0);
    x = x * (y2 / y);
  }
  // colour in Oklab (from linear sRGB primaries)
  if (u.tone[1].z != 0.0 || u.tone[1].w != 0.0 || u.gradeX.z != 0.0 || u.gradeX.w != 0.0) {
    var o = toOklab(M2020_709 * x);
    let C = length(o.yz);
    let k = (1.0 + u.tone[1].w) * (1.0 + u.tone[1].z * (1.0 - smoothstep(0.0, 0.25, C)));
    o = vec3f(o.x, o.yz * max(k, 0.0));
    if (u.gradeX.z != 0.0) { o = mixer(o); }
    if (u.gradeX.w != 0.0) { o = grading(o); }
    x = max(M709_2020 * fromOklab(o), vec3f(0.0));
  }
  if (u.tone[2].z == 1.0) {
    var p = oetf(clamp(x, vec3f(0.0), vec3f(1.0)));
    p = vec3f(curveAt(0u, p.r), curveAt(0u, p.g), curveAt(0u, p.b));
    p = vec3f(curveAt(1u, p.r), curveAt(2u, p.g), curveAt(3u, p.b));
    x = eotf(p);
  }
  if (u.tone[2].x != 0.0) {
    let r = length((pos - vec2f(0.5)) * 2.0) / 1.4142135623730951;
    x = x * max(1.0 + u.tone[2].x * smoothstep(u.tone[2].y, 1.0, r), 0.0);
  }
  return x;
}
`;

// Adjustment layers (kind 5): adjust(cb) maps the straight colour of the stack below. Types (model.js
// ADJUSTMENT_TYPES): 0 levels, 1 curves, 2 hue-saturation, 3 exposure, 4 colour balance, 5 black and white,
// 6 develop. Types 0, 1, 2, 4, 5 work on v = sRGB-encoded values (Rec.2020 primaries) in a 'compatible'
// document and on linear values in a 'linear' one; exposure and develop always work on linear values.
//   levels: per channel then master, x' = ob + (ow - ob) · clamp((x - ib) / (iw - ib), 0, 1)^(1 / gamma).
//   curves: v clamped 0..1, master curve then the channel curves (the develop tone-curve tables).
//   hue-saturation: HSL of clamp(v, 0, 1); hue += h (or = h when colourizing, saturation = s); saturation
//     S' = clamp(S (1 + s), 0, 1); back to RGB; then lightness l: v' = v + (1 - v) l (l > 0) or v (1 + l).
//   exposure: x' = max(x 2^ev + offset, 0)^(1 / gamma).
//   colour balance: l = Rec.2020 luma of clamp(v, 0, 1); weights ws = 1 - smoothstep(0, 0.5, l),
//     wh = smoothstep(0.5, 1, l), wm = 1 - ws - wh; v' = clamp(v + 0.2 (ws S + wm M + wh H), 0, 1) with the
//     (cyan-red, magenta-green, yellow-blue) triples as (r, g, b) shifts; preserve luminosity adds l - luma(v')
//     to every channel and clamps.
//   black and white: grey = min + (mid - min) W[secondary] + (max - mid) W[primary] on clamp(v, 0, 1)
//     (primary = largest channel: reds, greens, blues; secondary = largest two: yellows, cyans, magentas).
//   develop: x' = toneColour(x · 2^exposure) with the scene tone mapper off (the per-pixel develop stages).
//   proof (linear): v = sRGB-encoded clamp(M2020_709 x, 0, 1); (rgb, flag) = trilinear read of the press table
//     (model.js proofTable, N³ entries, red fastest); x' = M709_2020 · decode(rgb); with the warning on,
//     x' = mix(x', warning colour, flag).
//   duotone (linear): t = 1 - sRGB-encoded clamp(luma(x), 0, 1) (darkness); x' = Π_i (1 - curve_i(t) (1 - ink_i)), inks
//     linear Rec.2020 (paper white 1), curve_i the i-th curve table (identity by default).
const ADJUST_FNS = /* wgsl */`
fn levels1(x: f32, k: u32) -> f32 {
  let o = k * 5u;
  let t = clamp((x - adjP[o]) / (adjP[o + 1u] - adjP[o]), 0.0, 1.0);
  var g = 0.0;
  if (t > 0.0) { g = pow(t, 1.0 / adjP[o + 2u]); }
  return adjP[o + 3u] + (adjP[o + 4u] - adjP[o + 3u]) * g;
}
fn rgb2hsl(c: vec3f) -> vec3f {
  let mx = max(c.r, max(c.g, c.b)); let mn = min(c.r, min(c.g, c.b));
  let l = 0.5 * (mx + mn); let d = mx - mn;
  if (d <= 0.0) { return vec3f(0.0, 0.0, l); }
  let s = d / max(1.0 - abs(2.0 * l - 1.0), 1e-12);
  var h = 0.0;
  if (mx == c.r) { h = (c.g - c.b) / d; if (h < 0.0) { h = h + 6.0; } }
  else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
  else { h = (c.r - c.g) / d + 4.0; }
  return vec3f(h * 60.0, s, l);
}
fn hsl1(n: f32, h: vec3f) -> f32 {
  let k = (n + h.x / 30.0) % 12.0;
  let a = h.y * min(h.z, 1.0 - h.z);
  return h.z - a * max(-1.0, min(min(k - 3.0, 9.0 - k), 1.0));
}
fn hsl2rgb(h: vec3f) -> vec3f { return vec3f(hsl1(0.0, h), hsl1(8.0, h), hsl1(4.0, h)); }
fn proofAt(i: u32) -> vec4f { return vec4f(adjL[i * 4u], adjL[i * 4u + 1u], adjL[i * 4u + 2u], adjL[i * 4u + 3u]); }
fn adjust(cb: vec3f) -> vec3f {
  let ty = u32(u.q2.z);
  if (ty == 7u) {
    let N = u32(adjP[2]); let nf = f32(N - 1u);
    let v = oetf(clamp(M2020_709 * cb, vec3f(0.0), vec3f(1.0)));
    let t = v * nf;
    let i = min(vec3u(floor(t)), vec3u(N - 2u)); let f = t - vec3f(i);
    let k = (i.z * N + i.y) * N + i.x;
    let c00 = mix(proofAt(k), proofAt(k + 1u), f.x);
    let c10 = mix(proofAt(k + N), proofAt(k + N + 1u), f.x);
    let c01 = mix(proofAt(k + N * N), proofAt(k + N * N + 1u), f.x);
    let c11 = mix(proofAt(k + N * N + N), proofAt(k + N * N + N + 1u), f.x);
    let o = mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
    var x = M709_2020 * eotf(clamp(o.rgb, vec3f(0.0), vec3f(1.0)));
    if (adjP[0] == 1.0) { x = mix(x, vec3f(adjP[4], adjP[5], adjP[6]), clamp(o.a, 0.0, 1.0)); }
    return x;
  }
  if (ty == 8u) {
    let t = 1.0 - oetf1(clamp(dot(cb, LUMA), 0.0, 1.0));
    var x = vec3f(1.0);
    for (var i = 0u; i < u32(adjP[12]); i++) {
      let ink = vec3f(adjP[i * 3u], adjP[i * 3u + 1u], adjP[i * 3u + 2u]);
      x = x * (vec3f(1.0) - curveAt(i, t) * (vec3f(1.0) - ink));
    }
    return x;
  }
  if (ty == 6u) { return toneColour(cb * dv.wb.w, vec2f(0.5)); }
  if (ty == 3u) {
    let y = max(cb * exp2(adjP[0]) + vec3f(adjP[1]), vec3f(0.0));
    return pow(max(y, vec3f(1e-30)), vec3f(1.0 / adjP[2])) * step(vec3f(1e-30), y);
  }
  let enc = u.blendSpace == 0u;
  var v = cb;
  if (enc) { v = oetf(max(cb, vec3f(0.0))); }
  var o = v;
  if (ty == 0u) {
    o = vec3f(levels1(levels1(v.r, 1u), 0u), levels1(levels1(v.g, 2u), 0u), levels1(levels1(v.b, 3u), 0u));
  } else if (ty == 1u) {
    let p = clamp(v, vec3f(0.0), vec3f(1.0));
    o = vec3f(curveAt(1u, curveAt(0u, p.r)), curveAt(2u, curveAt(0u, p.g)), curveAt(3u, curveAt(0u, p.b)));
  } else if (ty == 2u) {
    var h = rgb2hsl(clamp(v, vec3f(0.0), vec3f(1.0)));
    if (adjP[3] == 1.0) { h = vec3f(adjP[0], adjP[1], h.z); }
    else { h = vec3f(fract((h.x + adjP[0]) / 360.0) * 360.0, clamp(h.y * (1.0 + adjP[1]), 0.0, 1.0), h.z); }
    o = hsl2rgb(h);
    let l = adjP[2];
    if (l > 0.0) { o = o + (vec3f(1.0) - o) * l; } else { o = o * (1.0 + l); }
  } else if (ty == 4u) {
    let c = clamp(v, vec3f(0.0), vec3f(1.0));
    let l = dot(c, LUMA);
    let ws = 1.0 - smoothstep(0.0, 0.5, l); let wh = smoothstep(0.5, 1.0, l); let wm = 1.0 - ws - wh;
    let D = ws * vec3f(adjP[0], adjP[1], adjP[2]) + wm * vec3f(adjP[3], adjP[4], adjP[5]) + wh * vec3f(adjP[6], adjP[7], adjP[8]);
    o = clamp(c + 0.2 * D, vec3f(0.0), vec3f(1.0));
    if (adjP[9] == 1.0) { o = clamp(o + vec3f(l - dot(o, LUMA)), vec3f(0.0), vec3f(1.0)); }
  } else if (ty == 5u) {
    let c = clamp(v, vec3f(0.0), vec3f(1.0));
    var prim = 0u; var sec = 1u; var mx = c.r; var md = c.g; var mn = c.b;
    if (c.r >= c.g && c.r >= c.b) {
      if (c.g >= c.b) { sec = 1u; md = c.g; mn = c.b; } else { sec = 5u; md = c.b; mn = c.g; }
    } else if (c.g >= c.b) {
      prim = 2u; mx = c.g;
      if (c.r >= c.b) { sec = 1u; md = c.r; mn = c.b; } else { sec = 3u; md = c.b; mn = c.r; }
    } else {
      prim = 4u; mx = c.b;
      if (c.r >= c.g) { sec = 5u; md = c.r; mn = c.g; } else { sec = 3u; md = c.g; mn = c.r; }
    }
    o = vec3f(clamp(mn + (md - mn) * adjP[sec] + (mx - md) * adjP[prim], 0.0, 1.0));
  }
  if (enc) { return eotf(max(o, vec3f(0.0))); }
  return o;
}
`;

export const COMPOSITE_WGSL = /* wgsl */`
${DEV_STRUCT}
struct MaskC { head: vec4f, p0: vec4f, p1: vec4f };
struct U {
  lod: u32, first: u32, blend: u32, blendSpace: u32,
  kind: u32, srcW: u32, srcH: u32, docW: u32,
  docH: u32, maskCount: u32, maskInvert: u32, clipMode: u32,
  inv: vec4f,
  invT: vec4f,
  solid: vec4f,
  q0: vec4f,
  q1: vec4f,
  q2: vec4f,
  dev3: vec4f, // _, maskDensity, _, _
  mask: array<MaskC, ${MAX_MASK}>,
};
@group(0) @binding(0) var acc: texture_2d_array<f32>;
@group(0) @binding(1) var outT: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var layerT: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> tiles: array<vec4i>;
@group(0) @binding(4) var<uniform> u: U;
@group(0) @binding(5) var maskT: texture_2d<f32>;
@group(0) @binding(6) var groupT: texture_2d_array<f32>; // groups: the children's result, one level down
@group(0) @binding(7) var<storage, read> adjP: array<f32>;  // adjustment parameters (model.js adjustmentPlan)
@group(0) @binding(8) var<uniform> dv: DevU;                // develop adjustment: the develop uniform
@group(0) @binding(9) var<storage, read> adjC: array<f32>;  // curves / develop adjustment: 4 × ${CURVE_N} curve table
@group(0) @binding(10) var clipW: texture_storage_2d_array<rgba16float, write>; // clipping base alpha (written)
@group(0) @binding(11) var clipR: texture_2d_array<f32>;    // clipping base alpha (read by clipped layers)
@group(0) @binding(12) var depthT: texture_2d<f32>;         // depth mask component's bitmap (model.js depth masks)
@group(0) @binding(13) var<storage, read> adjL: array<f32>; // proof adjustment: the press table (model.js proofTable)
@group(0) @binding(14) var dispT: texture_2d<f32>;          // displacement map (rg = source px), stretched over the source

${COLOUR_WGSL}
${DEV_TONE_FNS.replace(/\bu\./g, 'dv.').replace(/\bcurve\[/g, 'adjC[')}
${ADJUST_FNS}
fn texel(i: vec2i) -> vec4f {
  let t = textureLoad(layerT, i, 0);
  if (u.kind == 1u) { return vec4f(M709_2020 * t.rgb, t.a); }   // sRGB image (sampled linear)
  return t;
}

// Bilinear in source texels; exact single load when the sample sits on a texel centre.
fn sampleSrc(local: vec2f) -> vec4f {
  if (u.kind == 2u) { return u.solid; }
  let t = local - vec2f(0.5);
  let i = vec2i(floor(t));
  let f = t - floor(t);
  let mx = vec2i(i32(u.srcW) - 1, i32(u.srcH) - 1);
  if (f.x == 0.0 && f.y == 0.0) { return texel(clamp(i, vec2i(0), mx)); }
  let a = texel(clamp(i, vec2i(0), mx));
  let b = texel(clamp(i + vec2i(1, 0), vec2i(0), mx));
  let c = texel(clamp(i + vec2i(0, 1), vec2i(0), mx));
  let d = texel(clamp(i + vec2i(1, 1), vec2i(0), mx));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Depth bitmap read bilinearly at q px of a domain sz px (the bitmap stretched over it), edges repeated.
fn depthRead(q: vec2f, sz: vec2f) -> f32 {
  let ds = vec2f(textureDimensions(depthT));
  let g = q / sz * ds - vec2f(0.5);
  let i = vec2i(floor(g)); let f = g - floor(g);
  let mx = vec2i(ds) - vec2i(1);
  let a = textureLoad(depthT, clamp(i, vec2i(0), mx), 0).r;
  let b = textureLoad(depthT, clamp(i + vec2i(1, 0), vec2i(0), mx), 0).r;
  let c = textureLoad(depthT, clamp(i + vec2i(0, 1), vec2i(0), mx), 0).r;
  let d = textureLoad(depthT, clamp(i + vec2i(1, 1), vec2i(0), mx), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// smoothstep that is a hard step when the edges meet (feather 0).
fn sstep(a: f32, b: f32, x: f32) -> f32 { if (b <= a) { return select(0.0, 1.0, x >= b); } return smoothstep(a, b, x); }

fn maskAt(doc: vec2f, local: vec2f, col: vec3f) -> f32 {
  if (u.maskCount == 0u) { return 1.0; }
  var m = 0.0;
  for (var k = 0u; k < u.maskCount; k++) {
    let mc = u.mask[k];
    let kind = u32(mc.head.x); let op = u32(mc.head.y);
    var c = 0.0;
    if (kind == 0u) {        // bitmap, layer-local
      let i = clamp(vec2i(floor(local)), vec2i(0), vec2i(i32(u.srcW) - 1, i32(u.srcH) - 1));
      c = textureLoad(maskT, i, 0).r;
    } else if (kind == 1u) { // linear: full at p0.xy, none at p0.zw
      let d = mc.p0.zw - mc.p0.xy;
      c = 1.0 - smoothstep(0.0, 1.0, dot(doc - mc.p0.xy, d) / max(dot(d, d), 1e-6));
    } else if (kind == 2u) { // radial: full inside p0.z, none beyond p0.w
      c = 1.0 - smoothstep(mc.p0.z, mc.p0.w, distance(doc, mc.p0.xy));
    } else if (kind == 3u) { // luminance range (display-encoded): ramps p0.x→p0.y up, p0.z→p0.w down
      let e = oetf1(clamp(dot(col, LUMA), 0.0, 1.0));
      c = smoothstep(mc.p0.x, max(mc.p0.y, mc.p0.x + 1e-4), e) * (1.0 - smoothstep(mc.p0.z, max(mc.p0.w, mc.p0.z + 1e-4), e));
    } else if (kind == 4u) { // colour range in Oklab: full within tolerance p0.w of p0.xyz, none beyond p0.w + feather p1.x
      let o = toOklab(M2020_709 * col);
      c = 1.0 - smoothstep(mc.p0.w, mc.p0.w + max(mc.p1.x, 1e-4), distance(o, mc.p0.xyz));
    } else if (kind == 5u) { // depth range: full within [p0.x, p0.y], feather p0.z (layer source or document domain)
      var d = 0.0;
      if (u.kind <= 1u) { d = depthRead(local, vec2f(f32(u.srcW), f32(u.srcH))); }
      else { d = depthRead(doc, vec2f(f32(u.docW), f32(u.docH))); }
      c = sstep(mc.p0.x - mc.p0.z, mc.p0.x, d) * (1.0 - sstep(mc.p0.y, mc.p0.y + mc.p0.z, d));
    }
    if (op == 0u) { m = max(m, c); } else if (op == 1u) { m = m * (1.0 - c); } else { m = m * c; }
  }
  if (u.maskInvert == 1u) { m = 1.0 - m; }
  return m * u.dev3.y;
}

fn lum1(c: vec3f) -> f32 { return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; }
fn clipColor(c: vec3f) -> vec3f {
  let l = lum1(c); let n = min(c.r, min(c.g, c.b)); let x = max(c.r, max(c.g, c.b));
  var o = c;
  if (n < 0.0) { o = l + (o - l) * l / max(l - n, 1e-6); }
  if (x > 1.0) { o = l + (o - l) * (1.0 - l) / max(x - l, 1e-6); }
  return o;
}
fn setLum(c: vec3f, l: f32) -> vec3f { return clipColor(c + vec3f(l - lum1(c))); }
fn sat1(c: vec3f) -> f32 { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
fn setSat(c: vec3f, s: f32) -> vec3f {
  let mx = max(c.r, max(c.g, c.b)); let mn = min(c.r, min(c.g, c.b));
  if (mx <= mn) { return vec3f(0.0); }
  return (c - vec3f(mn)) * s / (mx - mn);
}
fn burn(b: f32, s: f32) -> f32 { if (b >= 1.0) { return 1.0; } if (s <= 0.0) { return 0.0; } return 1.0 - min(1.0, (1.0 - b) / s); }
fn dodge(b: f32, s: f32) -> f32 { if (b <= 0.0) { return 0.0; } if (s >= 1.0) { return 1.0; } return min(1.0, b / (1.0 - s)); }
fn hard(b: f32, s: f32) -> f32 { if (s <= 0.5) { return 2.0 * b * s; } return 1.0 - 2.0 * (1.0 - b) * (1.0 - s); }
fn soft(b: f32, s: f32) -> f32 {
  if (s <= 0.5) { return b - (1.0 - 2.0 * s) * b * (1.0 - b); }
  var d = sqrt(b);
  if (b <= 0.25) { d = ((16.0 * b - 12.0) * b + 4.0) * b; }
  return b + (2.0 * s - 1.0) * (d - b);
}
fn sep(m: u32, b: f32, s: f32) -> f32 {
  switch (m) {
    case 2u: { return min(b, s); }
    case 3u: { return b * s; }
    case 4u: { return burn(b, s); }
    case 5u: { return max(0.0, b + s - 1.0); }
    case 7u: { return max(b, s); }
    case 8u: { return b + s - b * s; }
    case 9u: { return dodge(b, s); }
    case 10u: { return min(1.0, b + s); }
    case 12u: { return hard(s, b); }
    case 13u: { return soft(b, s); }
    case 14u: { return hard(b, s); }
    case 15u: { if (s <= 0.5) { return burn(b, 2.0 * s); } return dodge(b, 2.0 * (s - 0.5)); }
    case 16u: { return clamp(b + 2.0 * s - 1.0, 0.0, 1.0); }
    case 17u: { if (s <= 0.5) { return min(b, 2.0 * s); } return max(b, 2.0 * s - 1.0); }
    case 18u: { return select(0.0, 1.0, b + s >= 1.0); }
    case 19u: { return abs(b - s); }
    case 20u: { return b + s - 2.0 * b * s; }
    case 21u: { return max(0.0, b - s); }
    case 22u: { if (s <= 0.0) { return select(1.0, 0.0, b <= 0.0); } return min(1.0, b / s); }
    default: { return s; }
  }
}
fn blendFn(m: u32, b0: vec3f, s0: vec3f) -> vec3f {
  let b = clamp(b0, vec3f(0.0), vec3f(1.0)); let s = clamp(s0, vec3f(0.0), vec3f(1.0));
  switch (m) {
    case 6u: { return select(b, s, lum1(s) < lum1(b)); }
    case 11u: { return select(b, s, lum1(s) > lum1(b)); }
    case 23u: { return setLum(setSat(s, sat1(b)), lum1(b)); }
    case 24u: { return setLum(setSat(b, sat1(s)), lum1(b)); }
    case 25u: { return setLum(s, lum1(b)); }
    case 26u: { return setLum(b, lum1(s)); }
    default: { return vec3f(sep(m, b.r, s.r), sep(m, b.g, s.g), sep(m, b.b, s.b)); }
  }
}

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let t = tiles[gid.z];
  let slice = t.z;
  let lp = vec2i(t.xy) * ${TILE} + vec2i(gid.xy);
  var a = vec4f(0.0);
  if (u.first == 0u) { a = textureLoad(acc, vec2i(gid.xy), slice, 0); }
  let s = 1 << u.lod;
  let stp = max(1, s / 4);
  let base = lp * s;
  var sum = vec4f(0.0);
  var cov = 0.0;
  var nTot = 0;
  var baseA = 0.0; // this layer's alpha for the layers clipped to it (clipMode 1)
  var clipA = 1.0;
  if (u.clipMode == 2u) { clipA = textureLoad(clipR, vec2i(gid.xy), t.w, 0).a; }
  if (u.kind == 5u) {
    // Adjustment: adjusted colour of the stack below, blended over it by mode, opacity × fill × mask (document
    // footprint average) × clip; alpha unchanged (an adjustment never adds coverage).
    let ab = a.a;
    var cb = vec3f(0.0);
    if (ab > 0.0) { cb = a.rgb / ab; }
    let cs = adjust(cb);
    var msum = 0.0;
    var n = 0;
    for (var dy = 0; dy < s; dy += stp) {
      for (var dx = 0; dx < s; dx += stp) {
        let d = base + vec2i(dx, dy);
        if (d.x >= i32(u.docW) || d.y >= i32(u.docH)) { continue; }
        n += 1;
        let dc = vec2f(d) + vec2f(0.5);
        msum += maskAt(dc, dc, cs);
      }
    }
    var m = 0.0;
    if (n > 0) { m = msum / f32(n); }
    baseA = m * u.invT.z;
    if (ab > 0.0) {
      var la = m * u.invT.z * u.invT.w * clipA;
      if (u.blend == 1u) {
        let h = f32(pcg(u32(base.x) + pcg(u32(base.y)))) / 4294967295.0;
        la = select(0.0, 1.0, h < la);
      }
      var B = cs;
      if (u.blend > 1u) {
        if (u.blendSpace == 0u) { B = eotf(blendFn(u.blend, oetf(max(cb, vec3f(0.0))), oetf(max(cs, vec3f(0.0))))); }
        else { B = blendFn(u.blend, cb, cs); }
      }
      a = vec4f(a.rgb + la * (ab * B - a.rgb), ab);
    }
  } else if (u.kind >= 3u) {
    let g = textureLoad(groupT, vec2i(gid.xy), t.w, 0); // premultiplied
    var col = vec3f(0.0);
    if (g.a > 0.0) { col = g.rgb / g.a; }
    var msum = 0.0;
    var n = 0;
    for (var dy = 0; dy < s; dy += stp) {
      for (var dx = 0; dx < s; dx += stp) {
        let d = base + vec2i(dx, dy);
        if (d.x >= i32(u.docW) || d.y >= i32(u.docH)) { continue; }
        n += 1;
        let dc = vec2f(d) + vec2f(0.5);
        msum += maskAt(dc, dc, col);
      }
    }
    if (n > 0) {
      let m = msum / f32(n);
      baseA = g.a * m * u.invT.z;
      if (u.kind == 4u) { a = mix(a, g, u.invT.z * m * clipA); }
      else { sum = vec4f(g.rgb * m, g.a * m); cov = 1.0; nTot = 1; }
    }
  } else {
  for (var dy = 0; dy < s; dy += stp) {
    for (var dx = 0; dx < s; dx += stp) {
      let d = base + vec2i(dx, dy);
      if (d.x >= i32(u.docW) || d.y >= i32(u.docH)) { continue; }
      nTot += 1;
      let dc = vec2f(d) + vec2f(0.5);
      var local = vec2f(u.inv.x * dc.x + u.inv.z * dc.y + u.invT.x, u.inv.y * dc.x + u.inv.w * dc.y + u.invT.y);
      if (u.q2.y == 1.0) { // perspective quad: projective map, outside where the denominator is not positive
        let hz = u.q1.z * dc.x + u.q1.w * dc.y + u.q2.x;
        local = vec2f(-1.0);
        if (hz > 0.0) { local = vec2f(u.q0.x * dc.x + u.q0.y * dc.y + u.q0.z, u.q0.w * dc.x + u.q1.x * dc.y + u.q1.y) / hz; }
      }
      var inside = local.x >= 0.0 && local.y >= 0.0 && local.x < f32(u.srcW) && local.y < f32(u.srcH);
      if (u.kind == 2u) { inside = true; }
      if (inside && u.q2.w == 1.0) { // displacement (warp, liquify): read the source at local + D(local); the layer keeps its rectangle
        let ds = vec2f(textureDimensions(dispT)); let sz = vec2f(f32(u.srcW), f32(u.srcH));
        let g = local / sz * ds - vec2f(0.5);
        let i = vec2i(floor(g)); let f = g - floor(g); let mx = vec2i(ds) - vec2i(1);
        let D = mix(mix(textureLoad(dispT, clamp(i, vec2i(0), mx), 0).rg, textureLoad(dispT, clamp(i + vec2i(1, 0), vec2i(0), mx), 0).rg, f.x),
                    mix(textureLoad(dispT, clamp(i + vec2i(0, 1), vec2i(0), mx), 0).rg, textureLoad(dispT, clamp(i + vec2i(1, 1), vec2i(0), mx), 0).rg, f.x), f.y);
        local = local + D;
        inside = local.x >= 0.0 && local.y >= 0.0 && local.x < sz.x && local.y < sz.y;
      }
      if (inside) {
        let v = sampleSrc(local);
        let m = maskAt(dc, local, v.rgb);
        sum += vec4f(v.rgb * v.a * m, v.a * m);
        cov += 1.0;
      }
    }
  }
  if (nTot > 0) { baseA = (sum.a / f32(nTot)) * u.invT.z; }
  }
  if (cov > 0.0 && sum.a > 0.0) {
    let cs = sum.rgb / sum.a;
    var la = (sum.a / f32(nTot)) * u.invT.z * u.invT.w * clipA;
    if (u.blend == 1u) {
      let h = f32(pcg(u32(base.x) + pcg(u32(base.y)))) / 4294967295.0;
      la = select(0.0, 1.0, h < la);
    }
    let ab = a.a;
    var cb = vec3f(0.0);
    if (ab > 0.0) { cb = a.rgb / ab; }
    var B = cs;
    if (u.blend > 1u) {
      if (u.blendSpace == 0u) { B = eotf(blendFn(u.blend, oetf(max(cb, vec3f(0.0))), oetf(max(cs, vec3f(0.0))))); }
      else { B = blendFn(u.blend, cb, cs); }
    }
    let csp = (1.0 - ab) * cs + ab * B;
    a = vec4f(la * csp + (1.0 - la) * a.rgb, la + (1.0 - la) * ab);
  }
  if (u.clipMode == 1u) { textureStore(clipW, vec2i(gid.xy), t.w, vec4f(baseA)); }
  textureStore(outT, vec2i(gid.xy), slice, a);
}`;

// LIN: inverse geometry, camera-space white balance (clip at full scale), camera matrix to linear Rec.2020
// (clamped 0..1, as LibRaw's own output), calibration, exposure, lens vignette.
// Geometry, output texel p → source, in coordinates n = (p - centre) / half-diagonal:
//   n_u = (H n)_xy / (H n)_z, H = [[1,0,0],[0,1,0],[ph,pv,1]] · Rot(-angle) (upright and straighten; z <= 0 is outside);
//   n_raw = n_u (1 + k1 |n_u|^2) (radial distortion); channel c reads n_raw × s_c (CA: s_r, 1, s_b), bilinear.
//   Alpha is 0 where the green sample falls outside the photo (rgb 0 there).
// Lens vignette: gain 2^(amount × smoothstep(mid, 1, |n_raw|)).
// Lens profile (model.js lensProfilePlan): after the manual distortion, P = n_raw × hd px from the centre;
//   P_s = P g(|P| / unitD) (green), red P_s t_r(|P_s| / unitT), blue P_s t_b(...), then the manual CA scales about the
//   centre; vignetting gain × max(1 + k1 r² + k2 r⁴ + k3 r⁶, 1e-3)^(-v), r = |P_s| / unitV (texel centre when no geometry).
export const DEV_LIN_WGSL = /* wgsl */`
${DEV_STRUCT}
@group(0) @binding(0) var rawT: texture_2d<f32>;
@group(0) @binding(1) var outT: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> u: DevU;
${COLOUR_WGSL}
fn poly7(a: array<vec4f, 2>, r: f32) -> f32 {
  let r2 = r * r; let r3 = r2 * r;
  return a[0].x + a[0].y * r + a[0].z * r2 + a[0].w * r3 + a[1].x * r2 * r2 + a[1].y * r2 * r3 + a[1].z * r3 * r3;
}
// Bilinear read of one camera channel at source position q (px), edge texels repeated.
fn chan(q: vec2f, c: u32) -> f32 {
  let t = q - vec2f(0.5);
  let i = vec2i(floor(t)); let f = t - floor(t);
  let mx = vec2i(i32(u.size.x) - 1, i32(u.size.y) - 1);
  let a = textureLoad(rawT, clamp(i, vec2i(0), mx), 0)[c];
  let b = textureLoad(rawT, clamp(i + vec2i(1, 0), vec2i(0), mx), 0)[c];
  let d = textureLoad(rawT, clamp(i + vec2i(0, 1), vec2i(0), mx), 0)[c];
  let e = textureLoad(rawT, clamp(i + vec2i(1, 1), vec2i(0), mx), 0)[c];
  return mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let W = u32(u.size.x); let H = u32(u.size.y);
  if (id.x >= W || id.y >= H) { return; }
  let ctr = vec2f(f32(W), f32(H)) * 0.5;
  let hd = length(ctr);
  let n = (vec2f(id.xy) + vec2f(0.5) - ctr) / hd;
  var cam: vec3f; var a = 1.0; var rho = length(n);
  var ps = vec2f(id.xy) + vec2f(0.5) - ctr; // sensor position of green, px from the centre (lens profile vignetting)
  if (u.geo.x == 0.0) {
    cam = textureLoad(rawT, vec2i(id.xy), 0).rgb;
  } else {
    let hp = vec3f(dot(u.h[0].xyz, vec3f(n, 1.0)), dot(u.h[1].xyz, vec3f(n, 1.0)), dot(u.h[2].xyz, vec3f(n, 1.0)));
    let nu = hp.xy / hp.z;
    let nr = nu * (1.0 + u.geo.y * dot(nu, nu));
    rho = length(nr);
    ps = nr * hd;
    if (u.lpf.x != 0.0) { ps = ps * poly7(u.lpd, length(ps) / u.lpd[1].w); }
    var pr = ps; var pb = ps;
    if (u.lpf.y != 0.0) { let rt = length(ps) / u.lpr[1].w; pr = ps * poly7(u.lpr, rt); pb = ps * poly7(u.lpb, rt); }
    let qg = ctr + ps;
    if (hp.z <= 0.0 || qg.x < 0.0 || qg.y < 0.0 || qg.x >= f32(W) || qg.y >= f32(H)) {
      textureStore(outT, vec2i(id.xy), vec4f(0.0)); return;
    }
    cam = vec3f(chan(ctr + pr * u.geo.z, 0u), chan(qg, 1u), chan(ctr + pb * u.geo.w, 2u));
  }
  let v = min(cam * u.wb.xyz, vec3f(1.0));
  var x = clamp(vec3f(dot(u.cam[0].xyz, v), dot(u.cam[1].xyz, v), dot(u.cam[2].xyz, v)), vec3f(0.0), vec3f(1.0));
  x = vec3f(dot(u.cal[0].xyz, x), dot(u.cal[1].xyz, x), dot(u.cal[2].xyz, x));
  var gain = u.wb.w;
  if (u.lens.x != 0.0) { gain = gain * exp2(u.lens.x * smoothstep(u.lens.y, 1.0, rho)); }
  if (u.lpf.z != 0.0) {
    let r2 = dot(ps, ps) / (u.lpv.w * u.lpv.w);
    gain = gain * pow(max(1.0 + u.lpv.x * r2 + u.lpv.y * r2 * r2 + u.lpv.z * r2 * r2 * r2, 1e-3), -u.lpb[1].w);
  }
  textureStore(outT, vec2i(id.xy), vec4f(x * gain, a));
}`;

// NR: noise reduction on the linear image, in Oklab (from linear sRGB primaries). Luminance: bilateral
// filter of L over a 7 × 7 window, spatial sigma 2 px, range sigma 0.004 + 0.06 × nrLum. Colour: Gaussian
// average of a, b over a 9 × 9 window (sigma 3 px), mixed in by nrColor. Edges replicate.
// Defringe (det[0].z = 1), after NR: chroma *= 1 - e w, e = smoothstep(0.1, 0.4, (Ymax - Ymin) / (Ymax + 0.02)) over
// the 5 × 5 neighbourhood (an edge), w = purple (Oklch hue 305 ± 25..45°) or green (135 ± 20..40°) weight.
export const DEV_NR_WGSL = /* wgsl */`
${DEV_STRUCT}
@group(0) @binding(0) var inT: texture_2d<f32>;
@group(0) @binding(1) var outT: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> u: DevU;
${COLOUR_WGSL}
fn at(p: vec2i) -> vec4f { return textureLoad(inT, clamp(p, vec2i(0), vec2i(i32(u.size.x) - 1, i32(u.size.y) - 1)), 0); }
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let W = u32(u.size.x); let H = u32(u.size.y);
  if (id.x >= W || id.y >= H) { return; }
  let p = vec2i(id.xy);
  let c = at(p);
  var o = toOklab(M2020_709 * c.rgb);
  let nl = u.det[0].x; let nc = u.det[0].y;
  if (nl > 0.0) {
    let sr = 0.004 + 0.06 * nl;
    var sw = 0.0; var sl = 0.0;
    for (var dy = -3; dy <= 3; dy++) { for (var dx = -3; dx <= 3; dx++) {
      let L = toOklab(M2020_709 * at(p + vec2i(dx, dy)).rgb).x;
      let dl = L - o.x;
      let w = exp(-f32(dx * dx + dy * dy) / 8.0 - dl * dl / (2.0 * sr * sr));
      sw += w; sl += w * L;
    } }
    o.x = sl / sw;
  }
  if (nc > 0.0) {
    var sw = 0.0; var sab = vec2f(0.0);
    for (var dy = -4; dy <= 4; dy++) { for (var dx = -4; dx <= 4; dx++) {
      let w = exp(-f32(dx * dx + dy * dy) / 18.0);
      sw += w; sab += w * toOklab(M2020_709 * at(p + vec2i(dx, dy)).rgb).yz;
    } }
    o = vec3f(o.x, mix(o.yz, sab / sw, nc));
  }
  if (u.det[0].z != 0.0) {
    var ymax = 0.0; var ymin = 1e30;
    for (var dy = -2; dy <= 2; dy++) { for (var dx = -2; dx <= 2; dx++) {
      let y = dot(at(p + vec2i(dx, dy)).rgb, LUMA); ymax = max(ymax, y); ymin = min(ymin, y);
    } }
    let e = smoothstep(0.1, 0.4, (ymax - ymin) / (ymax + 0.02));
    var h = atan2(o.z, o.y) * 57.29577951308232;
    if (h < 0.0) { h = h + 360.0; }
    let dp = abs(fract((h - 305.0) / 360.0 + 0.5) * 360.0 - 180.0);
    let dg = abs(fract((h - 135.0) / 360.0 + 0.5) * 360.0 - 180.0);
    let w = max(1.0 - smoothstep(25.0, 45.0, dp), 1.0 - smoothstep(20.0, 40.0, dg));
    o = vec3f(o.x, o.yz * (1.0 - e * w));
  }
  textureStore(outT, p, vec4f(M709_2020 * fromOklab(o), c.a));
}`;

// LENS: lens blur (depth of field), a per-pixel variable-radius disc gather in source pixels, in linear light,
// premultiplied. Depth d is disparity 0..1 (1 nearest), read bilinearly from the caller's depth bitmap stretched
// over the source. Circle of confusion r(d) = clamp(slope |d - dFocus|, 0, maxR). Pixel q contributes to p with
// radius rq = r(dq) when q is nearer than p (dq > dp: a blurred foreground spreads over what lies behind it), and
// min(rq, rp) otherwise (a blurred background cannot spread over a sharper foreground, so a sharp subject keeps
// its edge and a blurred foreground keeps no sharp halo). Weight w = clamp(r + 0.5 - |p - q|, 0, 1) / max(r, 0.5)²
// (an anti-aliased disc of unit energy); the result is Σ w c / Σ w over the in-image window |dx|, |dy| <= ceil(maxR).
// Mode 0 reads the develop's linear Rec.2020 scratch (RAW layers, after noise reduction, before sharpening); mode 1
// reads an sRGB image (decoded on load) and converts to linear Rec.2020. Output: straight colour, alpha.
// Uniform: size (W, H, _, _), p (mode, dFocus, slope, maxR).
export const lensWgsl = (format) => /* wgsl */`
struct LensU { size: vec4f, p: vec4f };
@group(0) @binding(0) var inT: texture_2d<f32>;
@group(0) @binding(1) var outT: texture_storage_2d<${format}, write>;
@group(0) @binding(2) var<uniform> L: LensU;
@group(0) @binding(3) var depthT: texture_2d<f32>;
${COLOUR_WGSL}
fn depthAt(q: vec2f) -> f32 {
  let ds = vec2f(textureDimensions(depthT));
  let g = q / L.size.xy * ds - vec2f(0.5);
  let i = vec2i(floor(g)); let f = g - floor(g);
  let mx = vec2i(ds) - vec2i(1);
  let a = textureLoad(depthT, clamp(i, vec2i(0), mx), 0).r;
  let b = textureLoad(depthT, clamp(i + vec2i(1, 0), vec2i(0), mx), 0).r;
  let c = textureLoad(depthT, clamp(i + vec2i(0, 1), vec2i(0), mx), 0).r;
  let d = textureLoad(depthT, clamp(i + vec2i(1, 1), vec2i(0), mx), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
fn rad(d: f32) -> f32 { return clamp(L.p.z * abs(d - L.p.y), 0.0, L.p.w); }
fn colAt(q: vec2i) -> vec4f {
  let t = textureLoad(inT, q, 0);
  var c = t.rgb;
  if (L.p.x == 1.0) { c = M709_2020 * c; }
  return vec4f(c * t.a, t.a);
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let W = i32(L.size.x); let H = i32(L.size.y);
  if (i32(id.x) >= W || i32(id.y) >= H) { return; }
  let p = vec2i(id.xy);
  let dp = depthAt(vec2f(p) + vec2f(0.5));
  let rp = rad(dp);
  let R = i32(ceil(L.p.w));
  var sum = vec4f(0.0); var sw = 0.0;
  for (var dy = -R; dy <= R; dy++) { for (var dx = -R; dx <= R; dx++) {
    let q = p + vec2i(dx, dy);
    if (q.x < 0 || q.y < 0 || q.x >= W || q.y >= H) { continue; }
    let dq = depthAt(vec2f(q) + vec2f(0.5));
    let rq = rad(dq);
    var re = rq;
    if (dq <= dp) { re = min(rq, rp); }
    let cov = clamp(re + 0.5 - length(vec2f(f32(dx), f32(dy))), 0.0, 1.0);
    if (cov <= 0.0) { continue; }
    let w = cov / max(re * re, 0.25);
    sum += w * colAt(q); sw += w;
  } }
  let o = sum / sw;
  var c = vec3f(0.0);
  if (o.a > 0.0) { c = o.rgb / o.a; }
  textureStore(outT, p, vec4f(c, o.a));
}`;

// SHARP: unsharp mask on lightness l = cbrt(Y). d = l - Gaussian(l) (sigma = radius px, window ±ceil(2 sigma));
// detail damps large differences (halos): d' = d / (1 + |d| × (1 - detail) × 20); masking keeps edges only:
// mask = smoothstep(m / 2, m, |grad l|), m = 0.08 × masking (mask 1 when masking is 0);
// l' = max(l + amount × mask × d', 0); rgb scales by (l' / l)^3.
export const DEV_SHARP_WGSL = /* wgsl */`
${DEV_STRUCT}
@group(0) @binding(0) var inT: texture_2d<f32>;
@group(0) @binding(1) var outT: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> u: DevU;
${COLOUR_WGSL}
fn lAt(p: vec2i) -> f32 { return cbrt(dot(textureLoad(inT, clamp(p, vec2i(0), vec2i(i32(u.size.x) - 1, i32(u.size.y) - 1)), 0).rgb, LUMA)); }
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let W = u32(u.size.x); let H = u32(u.size.y);
  if (id.x >= W || id.y >= H) { return; }
  let p = vec2i(id.xy);
  let c = textureLoad(inT, p, 0);
  let l = lAt(p);
  let sg = u.det[1].x; let R = i32(u.det[1].w);
  var sw = 0.0; var sb = 0.0;
  for (var dy = -R; dy <= R; dy++) { for (var dx = -R; dx <= R; dx++) {
    let w = exp(-f32(dx * dx + dy * dy) / (2.0 * sg * sg));
    sw += w; sb += w * lAt(p + vec2i(dx, dy));
  } }
  let d = l - sb / sw;
  let dd = d / (1.0 + abs(d) * u.det[1].y);
  var mask = 1.0;
  if (u.det[1].z > 0.0) {
    let g = length(vec2f(lAt(p + vec2i(1, 0)) - lAt(p - vec2i(1, 0)), lAt(p + vec2i(0, 1)) - lAt(p - vec2i(0, 1))) * 0.5);
    mask = smoothstep(0.5 * u.det[1].z, u.det[1].z, g);
  }
  let l2 = max(l + u.det[0].w * mask * dd, 0.0);
  var x = c.rgb;
  if (l > 1e-6) { let k = l2 / l; x = x * (k * k * k); }
  textureStore(outT, p, vec4f(x, c.a));
}`;

// GRID: local statistics for clarity and dehaze on a grid of C × C px cells (C = size.z): x = mean of
// log2(Y + 1e-4), y = minimum over the cell of max(min(r, g, b), 0) (the dark channel).
export const DEV_GRID_WGSL = /* wgsl */`
${DEV_STRUCT}
@group(0) @binding(0) var inT: texture_2d<f32>;
@group(0) @binding(1) var outT: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> u: DevU;
${COLOUR_WGSL}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let W = i32(u.size.x); let H = i32(u.size.y); let C = i32(u.size.z);
  let gw = (W + C - 1) / C; let gh = (H + C - 1) / C;
  if (i32(id.x) >= gw || i32(id.y) >= gh) { return; }
  let x0 = i32(id.x) * C; let y0 = i32(id.y) * C;
  var sl = 0.0; var dk = 1e30; var n = 0.0;
  for (var y = y0; y < min(y0 + C, H); y++) { for (var x = x0; x < min(x0 + C, W); x++) {
    let c = textureLoad(inT, vec2i(x, y), 0).rgb;
    sl += log2(dot(c, LUMA) + 1e-4);
    dk = min(dk, max(min(c.r, min(c.g, c.b)), 0.0));
    n += 1.0;
  } }
  textureStore(outT, vec2i(id.xy), vec4f(sl / n, dk, 0.0, 1.0));
}`;

// GBLUR: Gaussian over the grid, 7 × 7 cells, sigma 1.5 cells, weights renormalised over in-grid cells.
export const DEV_GBLUR_WGSL = /* wgsl */`
${DEV_STRUCT}
@group(0) @binding(0) var inT: texture_2d<f32>;
@group(0) @binding(1) var outT: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> u: DevU;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let C = i32(u.size.z);
  let gw = (i32(u.size.x) + C - 1) / C; let gh = (i32(u.size.y) + C - 1) / C;
  if (i32(id.x) >= gw || i32(id.y) >= gh) { return; }
  var s = vec2f(0.0); var sw = 0.0;
  for (var dy = -3; dy <= 3; dy++) { for (var dx = -3; dx <= 3; dx++) {
    let q = vec2i(id.xy) + vec2i(dx, dy);
    if (q.x < 0 || q.y < 0 || q.x >= gw || q.y >= gh) { continue; }
    let w = exp(-f32(dx * dx + dy * dy) / 4.5);
    s += w * textureLoad(inT, q, 0).xy; sw += w;
  } }
  textureStore(outT, vec2i(id.xy), vec4f(s / sw, 0.0, 1.0));
}`;

// GLOW (film effects), on the same C × C cells as GRID, from the image before local contrast (scene-linear):
//   cell source: rgb = mean of x · smoothstep(0.25, 1, Y) (bloom), a = mean of max(Y - 0.5, 0) (halation);
//   blur: Gaussian over cells, sigma glow.y (halation, alpha) and glow.w (bloom, rgb), window ±min(ceil(3 max sigma), 9)
//   cells, weights renormalised over in-grid cells. TONE adds, after local contrast and before tone and colour:
//   x += glow.z · B + glow.x · H · HAL, HAL = M709_2020 · (1, 0.25, 0.04) (red-orange), B and H read bilinearly.
export const DEV_GLOW_GRID_WGSL = /* wgsl */`
${DEV_STRUCT}
@group(0) @binding(0) var inT: texture_2d<f32>;
@group(0) @binding(1) var outT: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> u: DevU;
${COLOUR_WGSL}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let W = i32(u.size.x); let H = i32(u.size.y); let C = i32(u.size.z);
  let gw = (W + C - 1) / C; let gh = (H + C - 1) / C;
  if (i32(id.x) >= gw || i32(id.y) >= gh) { return; }
  let x0 = i32(id.x) * C; let y0 = i32(id.y) * C;
  var b = vec3f(0.0); var h = 0.0; var n = 0.0;
  for (var y = y0; y < min(y0 + C, H); y++) { for (var x = x0; x < min(x0 + C, W); x++) {
    let c = textureLoad(inT, vec2i(x, y), 0).rgb;
    let Y = dot(c, LUMA);
    b += c * smoothstep(0.25, 1.0, Y); h += max(Y - 0.5, 0.0); n += 1.0;
  } }
  textureStore(outT, vec2i(id.xy), vec4f(b / n, h / n));
}`;
export const DEV_GLOW_BLUR_WGSL = /* wgsl */`
${DEV_STRUCT}
@group(0) @binding(0) var inT: texture_2d<f32>;
@group(0) @binding(1) var outT: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> u: DevU;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let C = i32(u.size.z);
  let gw = (i32(u.size.x) + C - 1) / C; let gh = (i32(u.size.y) + C - 1) / C;
  if (i32(id.x) >= gw || i32(id.y) >= gh) { return; }
  let sh = u.glow.y; let sb = u.glow.w;
  let R = min(i32(ceil(3.0 * max(sh, sb))), 9);
  var b = vec3f(0.0); var h = 0.0; var wbs = 0.0; var whs = 0.0;
  for (var dy = -R; dy <= R; dy++) { for (var dx = -R; dx <= R; dx++) {
    let q = vec2i(id.xy) + vec2i(dx, dy);
    if (q.x < 0 || q.y < 0 || q.x >= gw || q.y >= gh) { continue; }
    let d2 = f32(dx * dx + dy * dy);
    let wb = exp(-d2 / (2.0 * sb * sb)); let wh = exp(-d2 / (2.0 * sh * sh));
    let t = textureLoad(inT, q, 0);
    b += wb * t.rgb; h += wh * t.a; wbs += wb; whs += wh;
  } }
  textureStore(outT, vec2i(id.xy), vec4f(b / wbs, h / whs));
}`;

// TONE: local contrast, then tone and colour per texel; writes the developed texture.
// Local contrast (local = texture k, clarity k, dehaze amount):
//   dehaze > 0: t = max(1 - 0.95 dz h, 0.1), x = max((x - (1 - t)) / t, 0), h = blurred dark channel, airlight 1;
//   dehaze < 0: w = -0.5 dz, x = x (1 - w) + w 2^m (m = blurred mean log2 luminance: a local grey veil);
//   clarity: D += clamp(kc (log2(Y + 1e-4) - m) 4p(1 - p), -1.5, 1.5), p = sRGB-encoded min(Y, 1);
//   texture: D += clamp(kt (log2(Y + 1e-4) - G(log2(Y + 1e-4))), -1, 1), G a 9 × 9 Gaussian, sigma 2 px;
//   x *= 2^D. Y is the luminance before dehaze; the grid is read bilinearly between cell centres.
export const DEV_TONE_WGSL = /* wgsl */`
${DEV_STRUCT}
@group(0) @binding(0) var inT: texture_2d<f32>;
@group(0) @binding(1) var outT: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u: DevU;
@group(0) @binding(3) var<storage, read> curve: array<f32>;  // 4 × ${CURVE_N}: master, r, g, b
@group(0) @binding(4) var gridT: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> lutD: array<f32>;  // .cube table, RGB triplets, red fastest
@group(0) @binding(6) var glowT: texture_2d<f32>;           // blurred glow grid (DEV_GLOW_BLUR_WGSL)
${COLOUR_WGSL}
// LUT (lut = kind 1 1D / 2 3D, size, amount | domain min | domain max), last in the develop: the input is
// linear Rec.2020 → Rec.709 primaries, clamped 0..1, sRGB-encoded, mapped to the LUT domain; the table is read
// linearly (1D) or trilinearly (3D); the output mixes with the input by amount and decodes back.
fn lutAt(i: u32) -> vec3f { return vec3f(lutD[i * 3u], lutD[i * 3u + 1u], lutD[i * 3u + 2u]); }
fn applyLut(x: vec3f) -> vec3f {
  let pin = oetf(clamp(M2020_709 * x, vec3f(0.0), vec3f(1.0)));
  let N = u32(u.lut[0].y); let nf = f32(N - 1u);
  let t = clamp((pin - u.lut[1].xyz) / (u.lut[2].xyz - u.lut[1].xyz), vec3f(0.0), vec3f(1.0)) * nf;
  let i = min(vec3u(floor(t)), vec3u(N - 2u)); let f = t - vec3f(i);
  var o: vec3f;
  if (u.lut[0].x == 1.0) {
    o = vec3f(mix(lutAt(i.x).x, lutAt(i.x + 1u).x, f.x), mix(lutAt(i.y).y, lutAt(i.y + 1u).y, f.y), mix(lutAt(i.z).z, lutAt(i.z + 1u).z, f.z));
  } else {
    let k = (i.z * N + i.y) * N + i.x;
    let c00 = mix(lutAt(k), lutAt(k + 1u), f.x);
    let c10 = mix(lutAt(k + N), lutAt(k + N + 1u), f.x);
    let c01 = mix(lutAt(k + N * N), lutAt(k + N * N + 1u), f.x);
    let c11 = mix(lutAt(k + N * N + N), lutAt(k + N * N + N + 1u), f.x);
    o = mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
  }
  o = mix(pin, o, u.lut[0].z);
  return M709_2020 * eotf(clamp(o, vec3f(0.0), vec3f(1.0)));
}
${DEV_TONE_FNS}
fn gridAt(p: vec2f) -> vec2f {
  let C = u.size.z;
  let gw = (i32(u.size.x) + i32(C) - 1) / i32(C); let gh = (i32(u.size.y) + i32(C) - 1) / i32(C);
  let g = p / C - vec2f(0.5);
  let i = vec2i(floor(g)); let f = g - floor(g);
  let mx = vec2i(gw - 1, gh - 1);
  let a = textureLoad(gridT, clamp(i, vec2i(0), mx), 0).xy;
  let b = textureLoad(gridT, clamp(i + vec2i(1, 0), vec2i(0), mx), 0).xy;
  let c = textureLoad(gridT, clamp(i + vec2i(0, 1), vec2i(0), mx), 0).xy;
  let d = textureLoad(gridT, clamp(i + vec2i(1, 1), vec2i(0), mx), 0).xy;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
fn glowAt(p: vec2f) -> vec4f {
  let C = u.size.z;
  let gw = (i32(u.size.x) + i32(C) - 1) / i32(C); let gh = (i32(u.size.y) + i32(C) - 1) / i32(C);
  let g = p / C - vec2f(0.5);
  let i = vec2i(floor(g)); let f = g - floor(g);
  let mx = vec2i(gw - 1, gh - 1);
  let a = textureLoad(glowT, clamp(i, vec2i(0), mx), 0);
  let b = textureLoad(glowT, clamp(i + vec2i(1, 0), vec2i(0), mx), 0);
  let c = textureLoad(glowT, clamp(i + vec2i(0, 1), vec2i(0), mx), 0);
  let d = textureLoad(glowT, clamp(i + vec2i(1, 1), vec2i(0), mx), 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
fn lyAt(p: vec2i) -> f32 { return log2(dot(textureLoad(inT, clamp(p, vec2i(0), vec2i(i32(u.size.x) - 1, i32(u.size.y) - 1)), 0).rgb, LUMA) + 1e-4); }
fn localContrast(x0: vec3f, p: vec2i) -> vec3f {
  var x = x0;
  let kt = u.local.x; let kc = u.local.y; let dz = u.local.z;
  var G = vec2f(0.0);
  if (kc != 0.0 || dz != 0.0) { G = gridAt(vec2f(p) + vec2f(0.5)); }
  if (dz > 0.0) {
    let t = max(1.0 - 0.95 * dz * clamp(G.y, 0.0, 1.0), 0.1);
    x = max((x - vec3f(1.0 - t)) / t, vec3f(0.0));
  } else if (dz < 0.0) {
    let w = -0.5 * dz;
    x = x * (1.0 - w) + vec3f(w * exp2(G.x));
  }
  if (kc != 0.0 || kt != 0.0) {
    let Y = dot(x0, LUMA);
    let ly = log2(Y + 1e-4);
    var D = 0.0;
    if (kc != 0.0) { let pd = oetf1(clamp(Y, 0.0, 1.0)); D += clamp(kc * (ly - G.x) * 4.0 * pd * (1.0 - pd), -1.5, 1.5); }
    if (kt != 0.0) {
      var sw = 0.0; var sb = 0.0;
      for (var dy = -4; dy <= 4; dy++) { for (var dx = -4; dx <= 4; dx++) {
        let w = exp(-f32(dx * dx + dy * dy) / 8.0);
        sw += w; sb += w * lyAt(p + vec2i(dx, dy));
      } }
      D += clamp(kt * (ly - sb / sw), -1.0, 1.0);
    }
    x = x * exp2(D);
  }
  return x;
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let W = u32(u.size.x); let H = u32(u.size.y);
  if (id.x >= W || id.y >= H) { return; }
  let c = textureLoad(inT, vec2i(id.xy), 0);
  let pos = (vec2f(id.xy) + vec2f(0.5)) / vec2f(f32(W), f32(H));
  var x = c.rgb;
  if (u.local.x != 0.0 || u.local.y != 0.0 || u.local.z != 0.0) { x = localContrast(x, vec2i(id.xy)); }
  if (u.glow.x != 0.0 || u.glow.z != 0.0) {
    let g = glowAt(vec2f(id.xy) + vec2f(0.5));
    x = x + u.glow.z * g.rgb + u.glow.x * g.a * (M709_2020 * vec3f(1.0, 0.25, 0.04));
  }
  x = toneColour(x, pos);
  if (u.fx.x != 0.0) { x = grain(x, vec2f(id.xy) + vec2f(0.5)); }
  if (u.lut[0].x != 0.0) { x = applyLut(x); }
  textureStore(outT, vec2i(id.xy), vec4f(x, c.a));
}`;

export const DISPLAY_WGSL = /* wgsl */`
struct V {
  x0: f32, y0: f32, scale: f32, lod: u32,
  gx0: i32, gy0: i32, gw: i32, gh: i32,
  docW: f32, docH: f32, _a: f32, _b: f32,
};
@group(0) @binding(0) var tilesT: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read> grid: array<i32>;
@group(0) @binding(2) var<uniform> v: V;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn oetf1(x: f32) -> f32 { if (x <= 0.0031308) { return 12.92 * x; } return 1.055 * pow(x, 1.0 / 2.4) - 0.055; }

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let doc = vec2f(v.x0, v.y0) + pos.xy / v.scale;
  var rgb = vec3f(0.18); // the 18% grey surround, outside the document and behind transparency
  if (doc.x >= 0.0 && doc.y >= 0.0 && doc.x < v.docW && doc.y < v.docH) {
    let lp = vec2i(floor(doc / f32(1u << v.lod)));
    let t = lp / ${TILE};
    let g = t - vec2i(v.gx0, v.gy0);
    if (g.x >= 0 && g.y >= 0 && g.x < v.gw && g.y < v.gh) {
      let slice = grid[g.y * v.gw + g.x];
      if (slice >= 0) {
        let c = textureLoad(tilesT, lp - t * ${TILE}, slice, 0);
        rgb = c.rgb + vec3f(0.18) * (1.0 - c.a);
      }
    }
  }
  let m = mat3x3f(vec3f(1.6605, -0.1246, -0.0182), vec3f(-0.5876, 1.1329, -0.1006), vec3f(-0.0728, -0.0083, 1.1187));
  let s = clamp(m * rgb, vec3f(0.0), vec3f(1.0));
  return vec4f(oetf1(s.r), oetf1(s.g), oetf1(s.b), 1.0);
}`;

// ---- layer styles (model.js stylePlan) ------------------------------------------------------------------------
// Three passes over the padded texture (Wp × Hp = (W + 2M) × (H + 2M)): a horizontal then vertical Gaussian of the
// source alpha (r: drop shadow, g: inner shadow; weights normalised over the full window, alpha 0 outside the
// source), then the composition (stylePlan's formulas). Output: straight linear Rec.2020 colour and alpha.
const STYLE_HEAD = /* wgsl */`
struct StyleU { size: vec4f, drop: vec4f, dcol: vec4f, inner: vec4f, icol: vec4f, stroke: vec4f, scol: vec4f, grad: vec4f, g0: vec4f, g1: vec4f, flags: vec4f, pad: vec4f };
@group(0) @binding(2) var<uniform> S: StyleU;
fn gw(d: i32, sigma: f32) -> f32 { if (sigma <= 0.0) { return select(0.0, 1.0, d == 0); } return exp(-f32(d * d) / (2.0 * sigma * sigma)); }
fn gsum(R: i32, sigma: f32) -> f32 { var s = 0.0; for (var d = -R; d <= R; d++) { s += gw(d, sigma); } return s; }
`;
export const STYLE_BLUR_H_WGSL = /* wgsl */`
@group(0) @binding(0) var srcT: texture_2d<f32>;
@group(0) @binding(1) var outT: texture_storage_2d<rgba32float, write>;
${STYLE_HEAD}
fn A(p: vec2i) -> f32 {
  let q = p - vec2i(i32(S.size.z));
  if (q.x < 0 || q.y < 0 || q.x >= i32(S.size.x) || q.y >= i32(S.size.y)) { return 0.0; }
  return textureLoad(srcT, q, 0).a;
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let M = i32(S.size.z); let Wp = i32(S.size.x) + 2 * M; let Hp = i32(S.size.y) + 2 * M;
  if (i32(id.x) >= Wp || i32(id.y) >= Hp) { return; }
  let p = vec2i(id.xy);
  let Rd = i32(S.dcol.w); let Ri = i32(S.icol.w);
  var d = 0.0; var i = 0.0;
  for (var k = -Rd; k <= Rd; k++) { d += gw(k, S.drop.y) * A(p + vec2i(k, 0)); }
  for (var k = -Ri; k <= Ri; k++) { i += gw(k, S.inner.y) * A(p + vec2i(k, 0)); }
  textureStore(outT, p, vec4f(d / gsum(Rd, S.drop.y), i / gsum(Ri, S.inner.y), 0.0, 1.0));
}`;
export const STYLE_BLUR_V_WGSL = /* wgsl */`
@group(0) @binding(0) var hT: texture_2d<f32>;
@group(0) @binding(1) var outT: texture_storage_2d<rgba32float, write>;
${STYLE_HEAD}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let M = i32(S.size.z); let Wp = i32(S.size.x) + 2 * M; let Hp = i32(S.size.y) + 2 * M;
  if (i32(id.x) >= Wp || i32(id.y) >= Hp) { return; }
  let p = vec2i(id.xy);
  let Rd = i32(S.dcol.w); let Ri = i32(S.icol.w);
  var d = 0.0; var i = 0.0;
  for (var k = -Rd; k <= Rd; k++) { let q = p + vec2i(0, k); if (q.y >= 0 && q.y < Hp) { d += gw(k, S.drop.y) * textureLoad(hT, q, 0).r; } }
  for (var k = -Ri; k <= Ri; k++) { let q = p + vec2i(0, k); if (q.y >= 0 && q.y < Hp) { i += gw(k, S.inner.y) * textureLoad(hT, q, 0).g; } }
  textureStore(outT, p, vec4f(d / gsum(Rd, S.drop.y), i / gsum(Ri, S.inner.y), 0.0, 1.0));
}`;
export const STYLE_FINAL_WGSL = /* wgsl */`
@group(0) @binding(0) var srcT: texture_2d<f32>;
@group(0) @binding(1) var outT: texture_storage_2d<rgba16float, write>;
${STYLE_HEAD}
@group(0) @binding(3) var bT: texture_2d<f32>;
${COLOUR_WGSL}
fn texAt(p: vec2i) -> vec4f {
  let q = p - vec2i(i32(S.size.z));
  if (q.x < 0 || q.y < 0 || q.x >= i32(S.size.x) || q.y >= i32(S.size.y)) { return vec4f(0.0); }
  let t = textureLoad(srcT, q, 0);
  return vec4f(M709_2020 * t.rgb, t.a);
}
fn B(p: vec2i) -> vec2f {
  let M = i32(S.size.z); let Wp = i32(S.size.x) + 2 * M; let Hp = i32(S.size.y) + 2 * M;
  if (p.x < 0 || p.y < 0 || p.x >= Wp || p.y >= Hp) { return vec2f(0.0); }
  return textureLoad(bT, p, 0).rg;
}
// dilation (max of A · cov) and erosion (1 - max of (1 - A) · cov) over a disc of radius r
fn morph(p: vec2i, r: f32) -> vec2f {
  let R = i32(ceil(r));
  var dil = 0.0; var ero = 0.0;
  for (var dy = -R; dy <= R; dy++) { for (var dx = -R; dx <= R; dx++) {
    let cov = clamp(r + 0.5 - length(vec2f(f32(dx), f32(dy))), 0.0, 1.0);
    if (cov <= 0.0) { continue; }
    let a = texAt(p + vec2i(dx, dy)).a;
    dil = max(dil, a * cov); ero = max(ero, (1.0 - a) * cov);
  } }
  return vec2f(dil, 1.0 - ero);
}
fn over(top: vec4f, bot: vec4f) -> vec4f { return top + bot * (1.0 - top.a); }
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let M = i32(S.size.z); let Wp = i32(S.size.x) + 2 * M; let Hp = i32(S.size.y) + 2 * M;
  if (i32(id.x) >= Wp || i32(id.y) >= Hp) { return; }
  let p = vec2i(id.xy);
  let t = texAt(p);
  var c = t.rgb; let a = t.a;
  if (S.flags.w != 0.0) {
    let q = vec2f(p - vec2i(M)) + vec2f(0.5) - 0.5 * S.size.xy;
    let ext = abs(S.size.x * S.grad.y) + abs(S.size.y * S.grad.z);
    let g = clamp(0.5 + dot(q, S.grad.yz) / ext, 0.0, 1.0);
    c = mix(c, mix(S.g0.rgb, S.g1.rgb, g), S.grad.x);
  }
  if (S.flags.y != 0.0) { c = mix(c, S.icol.rgb, S.inner.x * (1.0 - B(p - vec2i(i32(S.inner.z), i32(S.inner.w))).y)); }
  var res = vec4f(c * a, a);
  if (S.flags.z != 0.0) {
    let pos = S.stroke.z;
    var ring = 0.0;
    if (pos == 0.0) { ring = morph(p, S.stroke.y).x - a; }
    else if (pos == 1.0) { ring = a - morph(p, S.stroke.y).y; }
    else { let m = morph(p, 0.5 * S.stroke.y); ring = m.x - m.y; }
    let sa = S.stroke.x * clamp(ring, 0.0, 1.0);
    let sp = vec4f(S.scol.rgb * sa, sa);
    if (pos == 0.0) { res = over(res, sp); } else { res = over(sp, res); }
  }
  if (S.flags.x != 0.0) {
    let da = S.drop.x * B(p - vec2i(i32(S.drop.z), i32(S.drop.w))).x;
    res = over(res, vec4f(S.dcol.rgb * da, da));
  }
  var o = vec3f(0.0);
  if (res.a > 0.0) { o = res.rgb / res.a; }
  textureStore(outT, p, vec4f(o, res.a));
}`;
