// Lightroom / Camera Raw XMP preset → Atelier develop settings (spec 002 §4.4). Pure: no DOM, so the
// same parser runs in the page and in node tests. Every crs: setting without an Atelier equivalent, or
// with a value Atelier cannot take, is returned in `skipped` with its reason; nothing is dropped silently.
// Preset metadata (name, UUID, support flags) is not a setting and is returned in `metadata`.

const SCALAR = {
  Exposure2012: 'exposure', Contrast2012: 'contrast', Highlights2012: 'highlights', Shadows2012: 'shadows',
  Whites2012: 'whites', Blacks2012: 'blacks', Vibrance: 'vibrance', Saturation: 'saturation',
  PostCropVignetteAmount: 'vignette_amount', PostCropVignetteMidpoint: 'vignette_midpoint',
  Temperature: 'temperature', Tint: 'tint', Texture: 'texture', Clarity2012: 'clarity', Dehaze: 'dehaze',
  ParametricShadows: 'parametric_shadows', ParametricDarks: 'parametric_darks', ParametricLights: 'parametric_lights', ParametricHighlights: 'parametric_highlights',
  ParametricShadowSplit: 'parametric_split_shadows', ParametricMidtoneSplit: 'parametric_split_midtones', ParametricHighlightSplit: 'parametric_split_highlights',
  Sharpness: 'sharpen_amount', SharpenRadius: 'sharpen_radius', SharpenDetail: 'sharpen_detail', SharpenEdgeMasking: 'sharpen_masking',
  LuminanceSmoothing: 'nr_luminance', ColorNoiseReduction: 'nr_color',
  GrainAmount: 'grain_amount', GrainSize: 'grain_size', GrainFrequency: 'grain_roughness',
  LensManualDistortionAmount: 'distortion', VignetteAmount: 'lens_vignette_amount', VignetteMidpoint: 'lens_vignette_midpoint',
  PerspectiveVertical: 'upright_vertical', PerspectiveHorizontal: 'upright_horizontal',
  RedHue: 'calib_red_hue', RedSaturation: 'calib_red_sat', GreenHue: 'calib_green_hue', GreenSaturation: 'calib_green_sat', BlueHue: 'calib_blue_hue', BlueSaturation: 'calib_blue_sat',
};
const CURVES = { ToneCurvePV2012: 'rgb', ToneCurvePV2012Red: 'red', ToneCurvePV2012Green: 'green', ToneCurvePV2012Blue: 'blue' };

// Describe the preset rather than set a value in the image.
export const PRESET_METADATA = new Set([
  'PresetType', 'Cluster', 'UUID', 'SupportsAmount', 'SupportsAmount2', 'SupportsColor', 'SupportsMonochrome',
  'SupportsHighDynamicRange', 'SupportsNormalDynamicRange', 'SupportsSceneReferred', 'SupportsOutputReferred',
  'CameraModelRestriction', 'Copyright', 'ContactInfo', 'Version', 'CompatibleVersion', 'Name', 'ShortName',
  'SortName', 'Group', 'Description', 'HasSettings', 'HasCrop', 'AlreadyApplied', 'RequiresRGBTables', 'ToneCurveName2012',
]);

// Ranges Atelier accepts (the set_develop schema); callers may pass the manifest's ranges instead.
export const DEFAULT_RANGES = {
  exposure: [-5, 5], contrast: [-100, 100], highlights: [-100, 100], shadows: [-100, 100], whites: [-100, 100],
  blacks: [-100, 100], vibrance: [-100, 100], saturation: [-100, 100], vignette_amount: [-100, 100], vignette_midpoint: [0, 100],
};

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 80 ? `${s.slice(0, 77)}...` : s; };

// Collects every top-level crs: setting as { name → string | string[] (list items) | '<struct>' }.
export function readCrs(xml) {
  const out = {};
  let rest = '';
  let i = 0;
  const open = /<crs:([A-Za-z0-9_]+)(\s[^>]*?)?(\/?)>/g;
  while (true) {
    open.lastIndex = i;
    const m = open.exec(xml);
    if (!m) { rest += xml.slice(i); break; }
    rest += xml.slice(i, m.index);
    const name = m[1];
    if (m[3] === '/') { out[name] = '<struct>'; i = open.lastIndex; continue; }
    const close = xml.indexOf(`</crs:${name}>`, open.lastIndex);
    if (close < 0) { i = open.lastIndex; continue; }
    const body = xml.slice(open.lastIndex, close);
    const items = [...body.matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g)].map((x) => decode(x[1].trim()));
    if (/<rdf:(Seq|Bag|Alt)/.test(body)) out[name] = /<rdf:Description/.test(body) || items.some((s) => s.includes('<')) ? '<struct>' : items;
    else if (body.includes('<')) out[name] = '<struct>';
    else out[name] = decode(body.trim());
    i = close + name.length + 7;
  }
  // Attributes on the rdf:Description elements outside the element bodies taken above.
  for (const m of rest.matchAll(/crs:([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/g)) if (!(m[1] in out)) out[m[1]] = decode(m[2]);
  return out;
}

// Returns { settings, curve, skipped: [{ setting, value, reason }], metadata: [name] }.
export function parseXmpPreset(xml, ranges = DEFAULT_RANGES) {
  if (typeof xml !== 'string' || !xml.includes('crs:')) throw new Error('not a Camera Raw XMP preset: no crs: settings found');
  const crs = readCrs(xml);
  const settings = {}; const curve = {}; const skipped = []; const metadata = [];
  for (const [name, value] of Object.entries(crs)) {
    if (PRESET_METADATA.has(name)) { metadata.push(name); continue; }
    if (name in SCALAR) {
      const key = SCALAR[name]; const n = Number(String(value).replace(/^\+/, ''));
      const [lo, hi] = ranges[key] || [-Infinity, Infinity];
      if (typeof value !== 'string' || !Number.isFinite(n)) skipped.push({ setting: name, value: short(value), reason: 'not a number' });
      else if (n < lo || n > hi) skipped.push({ setting: name, value: short(value), reason: `outside Atelier's range ${lo} to ${hi}` });
      else settings[key] = n;
      continue;
    }
    if (name in CURVES) {
      const pts = Array.isArray(value) ? value.map((s) => s.split(',').map((x) => Number(x.trim()))) : null;
      const ok = pts && pts.length >= 2 && pts.every((p) => p.length === 2 && p.every((x) => Number.isFinite(x) && x >= 0 && x <= 255))
        && pts.every((p, k) => k === 0 || p[0] > pts[k - 1][0]);
      if (ok) curve[CURVES[name]] = pts;
      else skipped.push({ setting: name, value: short(value), reason: 'curve points must be 2+ ascending x,y pairs in 0..255' });
      continue;
    }
    skipped.push({ setting: name, value: short(value), reason: 'no Atelier equivalent yet' });
  }
  return { settings, curve: Object.keys(curve).length ? curve : null, skipped, metadata };
}
