// Pure helpers shared by the engine and the CPU reference: develop parameters → uniform values,
// tone-curve lookup tables, affine maths and mask vocabularies. No GPU, no DOM.

export const CURVE_N = 256;

export const MIXER_BANDS = Object.freeze(['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']);
export const GRADE_WHEELS = Object.freeze(['shadows', 'midtones', 'highlights', 'global']);

export const MASK_KINDS = Object.freeze(['bitmap', 'linear', 'radial', 'luminance-range', 'colour-range']);
export const MASK_OPS = Object.freeze(['add', 'subtract', 'intersect']);

// Develop settings the engine renders, in displayed units (Lightroom-style names and ranges).
// temperature and tint: null means as shot (the decoder's white balance); kelvin 2000..50000, tint -150..150.
export const DEVELOP_DEFAULTS = Object.freeze({
  temperature: null, tint: null,
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  vibrance: 0, saturation: 0, vignette_amount: 0, vignette_midpoint: 50,
  // Parametric tone curve: region amounts -100..100 and the three region splits 0..100 (ascending).
  parametric_shadows: 0, parametric_darks: 0, parametric_lights: 0, parametric_highlights: 0,
  parametric_split_shadows: 25, parametric_split_midtones: 50, parametric_split_highlights: 75,
  // Detail: sharpening amount 0..150, radius 0.5..3 px, detail 0..100, masking 0..100; noise reduction 0..100.
  sharpen_amount: 0, sharpen_radius: 1, sharpen_detail: 25, sharpen_masking: 0, nr_luminance: 0, nr_color: 0,
  // Local contrast, -100..100.
  texture: 0, clarity: 0, dehaze: 0,
  // Lens (manual): distortion -100..100 (+ corrects barrel), lateral CA scale of red and blue -100..100,
  // defringe 0 or 1 (ca_remove), lens vignette amount -100..100 (+ brightens corners) and midpoint 0..100.
  // lens_profile 0 only: profile corrections need a lens database the engine does not have.
  distortion: 0, ca_red: 0, ca_blue: 0, ca_remove: 0, lens_vignette_amount: 0, lens_vignette_midpoint: 50, lens_profile: 0,
  // Transform: upright vertical and horizontal -100..100, straighten angle -45..45 degrees (+ clockwise).
  upright_vertical: 0, upright_horizontal: 0, straighten_angle: 0,
  // Calibration: primary hue and saturation -100..100.
  calib_red_hue: 0, calib_red_sat: 0, calib_green_hue: 0, calib_green_sat: 0, calib_blue_hue: 0, calib_blue_sat: 0,
  // Grain: amount 0..100, size 0..100, roughness 0..100.
  grain_amount: 0, grain_size: 25, grain_roughness: 50,
});
export const DEVELOP_RENDERED = Object.freeze(Object.keys(DEVELOP_DEFAULTS));
const WHITE_POINT = 4; // tone mapper white point, scene-linear

// ---- develop uniform: one struct of vec4 slots shared by every develop pass ---------------------
// [name, vec4 count]. shaders.js generates the WGSL struct from this list; developPlan packs it.
export const DEV_SLOTS = Object.freeze([
  ['size', 1],   // W, H, grid cell px, _
  ['geo', 1],    // geometry on, distortion k1, CA scale red, CA scale blue
  ['h', 3],      // inverse homography rows (output → undistorted), normalised coordinates
  ['wb', 1],     // relative white-balance gains r, g, b (camera space), exposure multiplier
  ['cam', 3],    // camera RGB (white-balanced) → linear Rec.2020 rows
  ['cal', 3],    // calibration matrix rows (identity when off)
  ['lens', 1],   // lens vignette amount (EV), midpoint, _, _
  ['det', 2],    // nrLum, nrColor, defringe, sharpenAmount | sharpenSigma, detailDamp, maskingThreshold, _
  ['local', 1],  // texture k, clarity k, dehaze amount, _
  ['tone', 3],   // whitePoint, contrast, highlights, shadows | whites, blacks, vibrance, saturation | vignette, vigMid, hasCurve, _
  ['fx', 1],     // grain amount, grain size px, roughness, seed
  ['lut', 3],    // kind (0 off, 1 1D, 2 3D), size, amount, _ | domain min | domain max
  ['mixv', 6],   // HSL mixer, 8 bands × hue, sat, lum
  ['grade', 4],  // colour grading wheels
  ['gradeX', 1], // blending, balance, mixer mode, grading on
]);
export const DEV_OFFSETS = Object.freeze(DEV_SLOTS.reduce((o, [k, n]) => { o.map[k] = o.at; o.at += n * 4; return o; }, { map: {}, at: 0 }).map);
export const DEV_FLOATS = DEV_SLOTS.reduce((t, [, n]) => t + n * 4, 0);

// ---- white balance: CCT and tint → camera-space gains --------------------------------------------
// Planckian locus xy from kelvin (Kim et al. 2002 cubic spline, 1667..25000 K, extrapolated beyond).
export function planckXY(T) {
  const t = Math.max(1667, T); const i1 = 1e3 / t; const i2 = i1 * i1; const i3 = i2 * i1;
  const x = t <= 4000 ? -0.2661239 * i3 - 0.2343589 * i2 + 0.8776956 * i1 + 0.179910
    : -3.0258469 * i3 + 2.1070379 * i2 + 0.2226347 * i1 + 0.240390;
  const y = t <= 2222 ? -1.1063814 * x ** 3 - 1.34811020 * x * x + 2.18555832 * x - 0.20219683
    : t <= 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x * x + 2.09137015 * x - 0.16748867
      : 3.0817580 * x ** 3 - 5.87338670 * x * x + 3.75112997 * x - 0.37001483;
  return [x, y];
}
const xyToUv = ([x, y]) => { const d = -2 * x + 12 * y + 3; return [4 * x / d, 6 * y / d]; };
const uvToXy = ([u, v]) => { const d = 2 * u - 8 * v + 4; return [3 * u / d, 2 * v / d]; };
// White point xy for kelvin and tint: the Planckian point moved along the locus normal in CIE 1960 uv by
// Duv = +tint / 3000 (Lightroom's slider convention: positive tint assumes a greener illuminant, above the
// locus, so the rendered photo turns more magenta; the solver, the develop plan and the reference all use this).
export function whiteXY(T, tint = 0) {
  const [u, v] = xyToUv(planckXY(T));
  const [u2, v2] = xyToUv(planckXY(T * 1.001));
  let nu = -(v2 - v); let nv = u2 - u; const n = Math.hypot(nu, nv);
  nu /= n; nv /= n; if (nv < 0) { nu = -nu; nv = -nv; } // normal pointing to +v (green)
  const duv = tint / 3000;
  return uvToXy([u + duv * nu, v + duv * nv]);
}
// Camera-space gains that make the white of (T, tint) neutral: 1 / (cam_xyz · XYZ(xy, Y=1)), divided by the
// smallest gain (LibRaw's normalisation with highlight clipping on).
export function wbGains(camXyz, T, tint) {
  const [x, y] = whiteXY(T, tint);
  const XYZ = [x / y, 1, (1 - x - y) / y];
  const g = camXyz.slice(0, 3).map((row) => 1 / (row[0] * XYZ[0] + row[1] * XYZ[1] + row[2] * XYZ[2]));
  const m = Math.min(...g);
  return g.map((v) => v / m);
}
// As-shot (T, tint): solves wbGains(camXyz, T, tint) = the decoder's as-shot gains (red/green and blue/green
// ratios) by damped Newton in (mired, tint). Returns null when the camera matrix is missing.
export function solveAsShot(camXyz, gains) {
  if (!camXyz || !camXyz.slice(0, 3).every((r) => r.some((v) => v !== 0))) return null;
  const target = [Math.log(gains[0] / gains[1]), Math.log(gains[2] / gains[1])];
  const f = (mired, tint) => { const g = wbGains(camXyz, 1e6 / mired, tint); return [Math.log(g[0] / g[1]) - target[0], Math.log(g[2] / g[1]) - target[1]]; };
  let m = 200; let t = 0;
  for (let it = 0; it < 60; it++) {
    const r = f(m, t);
    if (Math.hypot(r[0], r[1]) < 1e-12) break;
    const e = 1e-4; const rm = f(m + e, t); const rt = f(m, t + e);
    const J = [[(rm[0] - r[0]) / e, (rt[0] - r[0]) / e], [(rm[1] - r[1]) / e, (rt[1] - r[1]) / e]];
    const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
    if (Math.abs(det) < 1e-18) break;
    let dm = -(J[1][1] * r[0] - J[0][1] * r[1]) / det; let dt = -(-J[1][0] * r[0] + J[0][0] * r[1]) / det;
    const s = Math.min(1, 50 / Math.max(Math.abs(dm), 1e-9), 100 / Math.max(Math.abs(dt), 1e-9));
    m = Math.min(600, Math.max(15, m + s * dm)); t = Math.min(300, Math.max(-300, t + s * dt));
  }
  const r = f(m, t);
  return { temperature: 1e6 / m, tint: t, residual: Math.hypot(r[0], r[1]) };
}

// Calibration: each Rec.2020 primary moves in Oklch (hue by 30° × hue/100, chroma × max(1 + 0.6 × sat/100, 0)),
// the moved primaries form the columns of C, and the columns are rescaled so white stays white:
// C' = C · diag(C⁻¹ · (1, 1, 1)). Identity when every slider is 0. Applied to linear Rec.2020 in the LIN pass.
const M2020_709 = [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]];
const M709_2020 = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]];
const mv = (M, c) => M.map((r) => r[0] * c[0] + r[1] * c[1] + r[2] * c[2]);
function oklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
function unOklab([L, A, B]) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3; const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3; const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
}
export function inv3(m) {
  const [a, b, c] = m[0]; const [d, e, f] = m[1]; const [g, h, k] = m[2];
  const A = e * k - f * h; const B = -(d * k - f * g); const C = d * h - e * g; const det = a * A + b * B + c * C;
  return [[A, -(b * k - c * h), b * f - c * e], [B, a * k - c * g, -(a * f - c * d)], [C, -(a * h - b * g), a * e - b * d]].map((r) => r.map((v) => v / det));
}
export function calibrationMatrix(d) {
  const sl = [[d.calib_red_hue, d.calib_red_sat], [d.calib_green_hue, d.calib_green_sat], [d.calib_blue_hue, d.calib_blue_sat]].map(([h, s]) => [(h ?? 0) / 100, (s ?? 0) / 100]);
  if (sl.every(([h, s]) => h === 0 && s === 0)) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const cols = sl.map(([h, s], k) => {
    const e = [0, 0, 0]; e[k] = 1;
    const o = oklab(mv(M2020_709, e)); const C = Math.hypot(o[1], o[2]) * Math.max(1 + 0.6 * s, 0);
    const a = Math.atan2(o[2], o[1]) + h * Math.PI / 6;
    return mv(M709_2020, unOklab([o[0], C * Math.cos(a), C * Math.sin(a)]));
  });
  const M = [0, 1, 2].map((i) => cols.map((c) => c[i]));
  const w = mv(inv3(M), [1, 1, 1]);
  return M.map((r) => r.map((v, j) => v * w[j]));
}

// LibRaw's sRGB → Rec.2020 matrix (its rec2020_rgb table); camera → Rec.2020 = this × rgb_cam.
export const SRGB_TO_REC2020 = Object.freeze([[0.627404078626, 0.329282097415, 0.043313797587], [0.069097233123, 0.919541035593, 0.011361189924], [0.016391587664, 0.088013255546, 0.895595009604]]);
export const matMul3 = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));

// The parameters a develop needs from its RAW source (engine and reference alike).
// src: { width, height, asShot: { gains, temperature, tint } | null, camXyz, camToRec2020 }.
export function developPlan(d0, extras, src) {
  const d = { ...DEVELOP_DEFAULTS };
  for (const [k, v] of Object.entries(d0 || {})) if (v !== null && v !== undefined) d[k] = v;
  const u = new Float32Array(DEV_FLOATS);
  const put = (slot, i, vals) => u.set(vals, DEV_OFFSETS[slot] + i * 4);
  const W = src.width; const H = src.height;
  const cell = Math.max(4, Math.round(Math.max(W, H) / 256)); // local-contrast grid cell, px
  put('size', 0, [W, H, cell, 0]);
  put('geo', 0, [0, 0, 1, 1]);
  if (d.lens_profile) throw Object.assign(new Error('lens profile corrections are not available (no lens database)'), { code: 'unsupported' });
  // Geometry (DEV_LIN_WGSL): H = [[1,0,0],[0,1,0],[ph,pv,1]] · Rot(-angle); k1 = -0.2 × distortion/100;
  // CA scales s = 1 + 0.003 × ca/100; ph, pv = 0.3 × upright/100.
  const th = d.straighten_angle * Math.PI / 180; const co = Math.cos(th); const si = Math.sin(th);
  const ph = 0.3 * d.upright_horizontal / 100; const pv = 0.3 * d.upright_vertical / 100;
  const geometry = !!(d.distortion || d.ca_red || d.ca_blue || d.upright_vertical || d.upright_horizontal || d.straighten_angle);
  put('geo', 0, [geometry ? 1 : 0, -0.2 * d.distortion / 100, 1 + 0.003 * d.ca_red / 100, 1 + 0.003 * d.ca_blue / 100]);
  put('h', 0, [co, si, 0, 0]); put('h', 1, [-si, co, 0, 0]); put('h', 2, [ph * co - pv * si, ph * si + pv * co, 1, 0]);
  put('lens', 0, [d.lens_vignette_amount / 100, d.lens_vignette_midpoint / 100, 0, 0]);
  // White balance: relative gains r = g(T, tint) / g(as shot), both min-normalised (exactly 1 at as shot).
  let r = [1, 1, 1];
  if (d.temperature !== null || d.tint !== null) {
    const as = src.asShot;
    if (!as || as.temperature == null) throw Object.assign(new Error('white balance needs the camera matrix'), { code: 'unsupported' });
    const gNew = wbGains(src.camXyz, d.temperature ?? as.temperature, d.tint ?? as.tint);
    const gAs = wbGains(src.camXyz, as.temperature, as.tint);
    r = gNew.map((v, i) => v / gAs[i]);
  }
  put('wb', 0, [...r, 2 ** d.exposure]);
  src.camToRec2020.forEach((row, i) => put('cam', i, [...row, 0]));
  calibrationMatrix(d).forEach((row, i) => put('cal', i, [...row, 0]));
  put('fx', 0, [d.grain_amount / 100, 1 + 3 * d.grain_size / 100, d.grain_roughness / 100, 0]);
  const n = (k) => d[k] / 100;
  put('tone', 0, [WHITE_POINT, n('contrast'), n('highlights'), n('shadows')]);
  put('tone', 1, [n('whites'), n('blacks'), n('vibrance'), n('saturation')]);
  const paramSamples = parametricSamples(d); // validates the splits even when the amounts are zero
  const param = parametricOn(d) ? paramSamples : null;
  const hasCurve = !!(extras?.curve || param);
  put('tone', 2, [n('vignette_amount'), d.vignette_midpoint / 100, hasCurve ? 1 : 0, 0]);
  const K = colourUniform(extras?.mixer, extras?.grading);
  u.set(K.slice(0, 24), DEV_OFFSETS.mixv); u.set(K.slice(24, 40), DEV_OFFSETS.grade); u.set(K.slice(40, 44), DEV_OFFSETS.gradeX);
  const sr = Math.min(3, Math.max(0.5, d.sharpen_radius));
  put('det', 0, [d.nr_luminance / 100, d.nr_color / 100, d.ca_remove ? 1 : 0, d.sharpen_amount / 100]);
  put('det', 1, [sr, (1 - d.sharpen_detail / 100) * 20, 0.08 * d.sharpen_masking / 100, Math.ceil(2 * sr)]);
  put('local', 0, [0.8 * d.texture / 100, 0.6 * d.clarity / 100, d.dehaze / 100, 0]);
  const L = extras?.lut;
  if (L) {
    put('lut', 0, [L.kind === '1d' ? 1 : 2, L.size, L.amount ?? 1, 0]);
    put('lut', 1, [...L.domainMin, 0]); put('lut', 2, [...L.domainMax, 0]);
  }
  const passes = { geometry, detail: d.nr_luminance > 0 || d.nr_color > 0 || !!d.ca_remove, lens: !!extras?.lens, sharpen: d.sharpen_amount > 0, grid: d.clarity !== 0 || d.dehaze !== 0, lut: !!L };
  return { u, passes, curveLut: hasCurve ? curveLuts(extras?.curve, param) : null, settings: d, lens: extras?.lens || null };
}

// Monotone cubic (Fritsch–Carlson) through points in 0..255 display space → CURVE_N samples in 0..1.
export function curveSamples(points) {
  const out = new Float32Array(CURVE_N);
  if (!points || points.length < 2) { for (let i = 0; i < CURVE_N; i++) out[i] = i / (CURVE_N - 1); return out; }
  const p = [...points].map(([x, y]) => [x / 255, y / 255]).sort((a, b) => a[0] - b[0]);
  const n = p.length; const dx = []; const sl = [];
  for (let i = 0; i < n - 1; i++) { dx.push(Math.max(1e-9, p[i + 1][0] - p[i][0])); sl.push((p[i + 1][1] - p[i][1]) / dx[i]); }
  const m = new Array(n);
  m[0] = sl[0]; m[n - 1] = sl[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = sl[i - 1] * sl[i] <= 0 ? 0 : (sl[i - 1] + sl[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (sl[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / sl[i]; const b = m[i + 1] / sl[i]; const h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * sl[i]; m[i + 1] = t * b * sl[i]; }
  }
  for (let k = 0; k < CURVE_N; k++) {
    const x = k / (CURVE_N - 1);
    let y;
    if (x <= p[0][0]) y = p[0][1];
    else if (x >= p[n - 1][0]) y = p[n - 1][1];
    else {
      let i = 0; while (x > p[i + 1][0]) i++;
      const h = dx[i]; const t = (x - p[i][0]) / h; const t2 = t * t; const t3 = t2 * t;
      y = (2 * t3 - 3 * t2 + 1) * p[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * p[i + 1][1] + (t3 - t2) * h * m[i + 1];
    }
    out[k] = Math.min(1, Math.max(0, y));
  }
  return out;
}

// Parametric curve in display space (0..1), Lightroom-style regions. Splits s1 < s2 < s3 cut 0..1 into
// shadows, darks, lights and highlights (edges E = [0, s1, s2, s3, 1]). Region k moves the curve by
// 0.15 × amount/100 × w_k(p), where w_k is a raised-cosine window that is 0 at L, 1 at P and 0 at R:
//   shadows (0, s1/2, s2), darks (0, (s1+s2)/2, s3), lights (s1, (s2+s3)/2, 1), highlights (s2, (s3+1)/2, 1).
// The result is clamped to 0..1 and made non-decreasing (running maximum). Endpoints stay at 0 and 1.
export function parametricSamples(d) {
  const a = [d.parametric_shadows, d.parametric_darks, d.parametric_lights, d.parametric_highlights].map((v) => (v ?? 0) / 100);
  const s1 = (d.parametric_split_shadows ?? 25) / 100; const s2 = (d.parametric_split_midtones ?? 50) / 100; const s3 = (d.parametric_split_highlights ?? 75) / 100;
  if (!(s1 >= 0.05 && s2 - s1 >= 0.05 && s3 - s2 >= 0.05 && s3 <= 0.95)) throw Object.assign(new Error('parametric splits must ascend, each at least 5 apart, within 5..95'), { code: 'invalid' });
  const win = [[0, s1 / 2, s2], [0, (s1 + s2) / 2, s3], [s1, (s2 + s3) / 2, 1], [s2, (s3 + 1) / 2, 1]];
  const w = (p, [L, P, R]) => (p <= L || p >= R ? 0 : p < P ? 0.5 - 0.5 * Math.cos(Math.PI * (p - L) / (P - L)) : 0.5 + 0.5 * Math.cos(Math.PI * (p - P) / (R - P)));
  const out = new Float32Array(CURVE_N); let run = 0;
  for (let k = 0; k < CURVE_N; k++) {
    const p = k / (CURVE_N - 1);
    let y = p; for (let r = 0; r < 4; r++) y += 0.15 * a[r] * w(p, win[r]);
    run = Math.max(run, Math.min(1, Math.max(0, y)));
    out[k] = run;
  }
  return out;
}
const parametricOn = (d) => !!(d.parametric_shadows || d.parametric_darks || d.parametric_lights || d.parametric_highlights);

// curve = { rgb?, red?, green?, blue? } point lists → 4 × CURVE_N floats (master, r, g, b).
// param (optional): parametric samples, applied before the point curve: master[k] = point(param[k]),
// the point curve read from its own table by linear interpolation.
export function curveLuts(curve, param = null) {
  const out = new Float32Array(4 * CURVE_N);
  ['rgb', 'red', 'green', 'blue'].forEach((ch, i) => out.set(curveSamples(curve?.[ch]), i * CURVE_N));
  if (param) {
    const point = out.slice(0, CURVE_N);
    for (let k = 0; k < CURVE_N; k++) {
      const t = Math.min(1, Math.max(0, param[k])) * (CURVE_N - 1); const i = Math.min(Math.floor(t), CURVE_N - 2); const f = t - i;
      out[k] = point[i] * (1 - f) + point[i + 1] * f;
    }
  }
  return out;
}

// matrix [a,b,c,d,e,f]: x' = a*x + c*y + e, y' = b*x + d*y + f (source px → document px).
export function invertAffine(m = [1, 0, 0, 1, 0, 0]) {
  const [a, b, c, d, e, f] = m; const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return [0, 0, 0, 0, -1e9, -1e9];
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function layerBounds(m = [1, 0, 0, 1, 0, 0], w, h) {
  const [a, b, c, d, e, f] = m;
  const xs = []; const ys = [];
  for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]]) { xs.push(a * x + c * y + e); ys.push(b * x + d * y + f); }
  return [Math.floor(Math.min(...xs)), Math.floor(Math.min(...ys)), Math.ceil(Math.max(...xs)), Math.ceil(Math.max(...ys))];
}

// Mixer and grading → 44 floats: mix (24), grade (16), gradeX (4). Values in displayed units:
// mixer { mode: 'hsl', bands: { red: { hue, saturation, luminance } … } } or { mode: 'bw', bands: { red: n … } }, all -100..100;
// grading { shadows|midtones|highlights|global: { hue 0..360, saturation 0..100, luminance -100..100 }, blending 0..100, balance -100..100 }.
export function colourUniform(mixer, grading) {
  const mix = new Array(24).fill(0);
  let mode = 0;
  if (mixer) {
    mode = mixer.mode === 'bw' ? 2 : 1;
    MIXER_BANDS.forEach((b, i) => {
      const v = mixer.bands?.[b];
      if (mode === 2) mix[i * 3 + 2] = (typeof v === 'number' ? v : 0) / 100;
      else if (v) { mix[i * 3] = (v.hue ?? 0) / 100; mix[i * 3 + 1] = (v.saturation ?? 0) / 100; mix[i * 3 + 2] = (v.luminance ?? 0) / 100; }
    });
  }
  const grade = new Array(16).fill(0);
  let on = 0;
  if (grading) {
    GRADE_WHEELS.forEach((w, k) => {
      const g = grading[w];
      if (g) { grade[k * 4] = g.hue ?? 0; grade[k * 4 + 1] = (g.saturation ?? 0) / 100; grade[k * 4 + 2] = (g.luminance ?? 0) / 100; if (g.saturation || g.luminance) on = 1; }
    });
  }
  return [...mix, ...grade, (grading?.blending ?? 50) / 100, (grading?.balance ?? 0) / 100, mode, on];
}

// ---- adjustment layers ------------------------------------------------------------------------------
// { type, params } → { type index, space, p: 64 floats, curve: 4 × CURVE_N | null, dev: develop uniform | null }.
// space 0: the adjustment reads display-encoded values (sRGB transfer on the working Rec.2020 primaries) in a
// 'compatible' document and linear values in a 'linear' one; space 1: always linear (exposure and develop are
// defined in linear light). The application maths lives in shaders.js (adjust) and its twin in reference.js.
export const ADJUSTMENT_TYPES = Object.freeze(['levels', 'curves', 'hue-saturation', 'exposure', 'colour-balance', 'black-and-white', 'develop']);
export const BW_DEFAULTS = Object.freeze({ reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 });
// Develop settings a develop adjustment renders (per-pixel stages only); every other setting must stay at its default.
export const DEVELOP_ADJUSTMENT_KEYS = Object.freeze(['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'saturation',
  'parametric_shadows', 'parametric_darks', 'parametric_lights', 'parametric_highlights', 'parametric_split_shadows', 'parametric_split_midtones', 'parametric_split_highlights']);
const err = (code, message) => Object.assign(new Error(message), { code });
const num = (v, d, lo, hi, name) => {
  const x = v ?? d;
  if (typeof x !== 'number' || !Number.isFinite(x) || x < lo || x > hi) throw err('invalid', `${name} ${v} is outside ${lo}..${hi}`);
  return x;
};
export function adjustmentPlan(adj, layerExtras = {}) {
  if (!adj || typeof adj !== 'object') throw err('invalid', 'adjustment must be { type, params }');
  const type = ADJUSTMENT_TYPES.indexOf(adj.type);
  if (type < 0) throw err('unsupported', `adjustment type ${adj.type}; use one of ${ADJUSTMENT_TYPES.join(', ')}`);
  const P = adj.params || {};
  const p = new Float32Array(64); let curve = null; let dev = null; let space = 0;
  if (adj.type === 'levels') {
    // Per channel block k (rgb, red, green, blue): input black/white, gamma, output black/white; 0..255 except gamma.
    ['rgb', 'red', 'green', 'blue'].forEach((ch, k) => {
      const c = P[ch] || {};
      const ib = num(c.inBlack, 0, 0, 253, `${ch}.inBlack`); const iw = num(c.inWhite, 255, 2, 255, `${ch}.inWhite`);
      if (iw - ib < 2) throw err('invalid', `${ch}: inWhite must exceed inBlack by at least 2`);
      p.set([ib / 255, iw / 255, num(c.gamma, 1, 0.1, 9.99, `${ch}.gamma`), num(c.outBlack, 0, 0, 255, `${ch}.outBlack`) / 255, num(c.outWhite, 255, 0, 255, `${ch}.outWhite`) / 255], k * 5);
    });
  } else if (adj.type === 'curves') {
    curve = curveLuts(P);
  } else if (adj.type === 'hue-saturation') {
    const colourize = !!P.colourize;
    const hue = colourize ? num(P.hue, 0, 0, 360, 'hue') : num(P.hue, 0, -180, 180, 'hue');
    const sat = colourize ? num(P.saturation, 25, 0, 100, 'saturation') : num(P.saturation, 0, -100, 100, 'saturation');
    p.set([hue, sat / 100, num(P.lightness, 0, -100, 100, 'lightness') / 100, colourize ? 1 : 0]);
  } else if (adj.type === 'exposure') {
    space = 1;
    p.set([num(P.exposure, 0, -20, 20, 'exposure'), num(P.offset, 0, -0.5, 0.5, 'offset'), num(P.gamma, 1, 0.01, 9.99, 'gamma')]);
  } else if (adj.type === 'colour-balance') {
    ['shadows', 'midtones', 'highlights'].forEach((r, k) => {
      const v = P[r] || [0, 0, 0];
      if (!Array.isArray(v) || v.length !== 3) throw err('invalid', `${r} must be [cyan-red, magenta-green, yellow-blue]`);
      v.forEach((x, i) => { p[k * 3 + i] = num(x, 0, -100, 100, `${r}[${i}]`) / 100; });
    });
    p[9] = P.preserveLuminosity === false ? 0 : 1;
  } else if (adj.type === 'black-and-white') {
    for (const k of Object.keys(P)) if (!(k in BW_DEFAULTS)) throw err('unsupported', `black-and-white setting ${k}; use ${Object.keys(BW_DEFAULTS).join(', ')}`);
    Object.keys(BW_DEFAULTS).forEach((k, i) => { p[i] = num(P[k], BW_DEFAULTS[k], -200, 300, k) / 100; });
  } else if (adj.type === 'develop') {
    space = 1;
    const d = P.develop || {};
    const bad = Object.entries(d).filter(([k, v]) => v !== null && v !== undefined && !DEVELOP_ADJUSTMENT_KEYS.includes(k) && v !== DEVELOP_DEFAULTS[k]).map(([k]) => k);
    if (bad.length) throw err('unsupported', `develop adjustment renders per-pixel stages only; not rendered: ${bad.join(', ')}`);
    if (P.lut) throw err('unsupported', 'develop adjustment: LUTs are not rendered on adjustments');
    for (const k of Object.keys(P)) if (!['develop', 'curve', 'mixer', 'grading'].includes(k)) throw err('unsupported', `develop adjustment parameter ${k}`);
    const plan = developPlan(d, { curve: P.curve, mixer: P.mixer, grading: P.grading }, { width: 1, height: 1, asShot: null, camXyz: null, camToRec2020: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] });
    dev = plan.u; dev[DEV_OFFSETS.tone] = 0; // white point 0: no scene tone mapper, so defaults are the identity
    curve = plan.curveLut;
  }
  return { type, space, p, curve, dev, ...layerExtras };
}

// ---- perspective quads ------------------------------------------------------------------------------
// quad: document corners of the source rectangle [TL, TR, BR, BL]. Returns the 3 × 3 homography (row major) that
// maps document → source pixels, from Heckbert's square-to-quad closed form, inverted. Refuses degenerate or
// non-convex quads, because a projective map folds them.
export function quadInverse(quad, w, h) {
  if (!Array.isArray(quad) || quad.length !== 4 || !quad.every((q) => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite))) throw err('invalid', 'quad must be four [x, y] corners');
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b, c] = [quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4]];
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(z) < 1e-9) throw err('invalid', 'quad is degenerate (three corners in a line)');
    if (sign && Math.sign(z) !== sign) throw err('invalid', 'quad is not convex');
    sign = Math.sign(z);
  }
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
  // Unit square (u, v) → quad: x = (a u + b v + c) / (g u + h v + 1), y = (d u + e v + f) / (g u + h v + 1).
  const sx = x0 - x1 + x2 - x3; const sy = y0 - y1 + y2 - y3;
  const dx1 = x1 - x2; const dx2 = x3 - x2; const dy1 = y1 - y2; const dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den; const hh = (dx1 * sy - sx * dy1) / den;
  const S = [[x1 - x0 + g * x1, x3 - x0 + hh * x3, x0], [y1 - y0 + g * y1, y3 - y0 + hh * y3, y0], [g, hh, 1]];
  // Source px → unit square: diag(1/w, 1/h, 1); so source → doc = S · diag(1/w, 1/h, 1).
  const F = S.map((r) => [r[0] / w, r[1] / h, r[2]]);
  const I = inv3(F);
  // Scale so the denominator is +1 at the quad's centroid (positive over the whole convex interior).
  const cx = (x0 + x1 + x2 + x3) / 4; const cy = (y0 + y1 + y2 + y3) / 4;
  const z = I[2][0] * cx + I[2][1] * cy + I[2][2];
  return I.map((r) => r.map((v) => v / z));
}
export function quadBounds(quad) {
  const xs = quad.map((q) => q[0]); const ys = quad.map((q) => q[1]);
  return [Math.floor(Math.min(...xs)), Math.floor(Math.min(...ys)), Math.ceil(Math.max(...xs)), Math.ceil(Math.max(...ys))];
}

// ---- lens blur ----------------------------------------------------------------------------------------
// depth: { width, height, data: Uint8Array } disparity 0..255 (255 nearest). Bilinear at source position
// (x, y) px of a source W × H (the depth map may have any size; it is stretched over the source).
export function depthAt(depth, W, H, x, y) {
  const gx = x / W * depth.width - 0.5; const gy = y / H * depth.height - 0.5;
  const ix = Math.floor(gx); const iy = Math.floor(gy); const fx = gx - ix; const fy = gy - iy;
  const at = (i, j) => depth.data[Math.min(depth.height - 1, Math.max(0, j)) * depth.width + Math.min(depth.width - 1, Math.max(0, i))] / 255;
  return (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
}
export const LENS_MAX_RADIUS = 32;
// lensBlur → { dFocus, slope, maxR } (validated). focus 0..1 or focusPoint [x, y] in source px (depth read there).
export function lensPlan(lb, depth, W, H) {
  if ((lb.bokehShape ?? 'disc') !== 'disc') throw err('unsupported', `bokeh shape ${lb.bokehShape}; only 'disc' is rendered`);
  const known = ['depthMask', 'focus', 'focusPoint', 'aperture', 'maxRadius', 'bokehShape'];
  for (const k of Object.keys(lb)) if (!known.includes(k)) throw err('unsupported', `lens blur setting ${k}`);
  let dFocus;
  if (lb.focusPoint) {
    if (lb.focus !== undefined) throw err('invalid', 'give focus or focusPoint, not both');
    const [x, y] = lb.focusPoint;
    if (!(x >= 0 && y >= 0 && x <= W && y <= H)) throw err('invalid', 'focusPoint must lie inside the source');
    dFocus = depthAt(depth, W, H, x, y);
  } else dFocus = num(lb.focus, undefined, 0, 1, 'focus');
  return { dFocus, slope: num(lb.aperture, undefined, 0, 1000, 'aperture'), maxR: num(lb.maxRadius, 8, 0, LENS_MAX_RADIUS, 'maxRadius') };
}
