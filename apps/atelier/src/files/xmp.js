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
  return mapCrs(readCrs(xml), ranges);
}

// crs: name → value (strings, or arrays of "x, y" strings for curves) → Atelier settings. Shared by XMP
// presets, XMP sidecars and Lightroom catalog develop text (src/files/lrcat.js).
export function mapCrs(crs, ranges = DEFAULT_RANGES) {
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

// ---- XMP sidecars beside photos (L55) --------------------------------------------------------------
// Lightroom, Bridge and Camera Raw keep a proprietary RAW's metadata in <stem>.xmp beside it: xmp:Rating
// (0..5; −1 marks a reject in Bridge's convention), xmp:Label (the label's name, default set Red,
// Yellow, Green, Blue, Purple) and dc:subject (an rdf:Bag of keywords). JPEG, TIFF, PSD and DNG keep
// XMP inside the file, which Atelier never writes, so they get no sidecar.
// Specs: Adobe XMP Specification Part 1 (ISO 16684-1) for the packet; Part 2 for the xmp: and dc: schemas.
export const XMP_SIDECAR_EXT = ['arw', 'nef', 'cr2', 'cr3', 'raf', 'orf', 'rw2'];
export function xmpSidecarPath(path) {
  const e = path.split('.').pop().toLowerCase();
  return XMP_SIDECAR_EXT.includes(e) ? path.replace(/\.[^./]+$/, '.xmp') : null;
}
const NS = { xmp: 'http://ns.adobe.com/xap/1.0/', dc: 'http://purl.org/dc/elements/1.1/', rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' };
const LABEL_NAMES = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple' };
const escX = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The prefix a packet binds to a namespace URI (writers may use xap: for xmp:), or null.
function prefixOf(xml, uri) { const m = new RegExp(`xmlns:([A-Za-z_][\\w.-]*)\\s*=\\s*["']${reEsc(uri)}["']`).exec(xml); return m ? m[1] : null; }
function prop(xml, pfx, name) {
  if (!pfx) return null;
  // XML allows either quote around an attribute value (XML 1.0 §2.3 AttValue).
  const a = new RegExp(`\\s${pfx}:${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(xml); if (a) return decode(a[1] ?? a[2]);
  const e = new RegExp(`<${pfx}:${name}>([^<]*)</${pfx}:${name}>`).exec(xml); return e ? decode(e[1].trim()) : null;
}

// Reads rating, flag, label, keywords and the crs: develop settings. Unknown label names are reported.
export function readXmpMeta(xml) {
  if (typeof xml !== 'string' || !xml.includes('x:xmpmeta') && !xml.includes('rdf:RDF')) throw new Error('not an XMP packet');
  const px = prefixOf(xml, NS.xmp); const pd = prefixOf(xml, NS.dc);
  const out = { skipped: [] };
  const r = prop(xml, px, 'Rating');
  if (r !== null) { const n = Math.round(Number(r)); if (n === -1) out.flag = 'reject'; else if (n >= 0 && n <= 5) out.rating = n; else out.skipped.push({ field: 'xmp:Rating', value: r, reason: 'outside -1..5' }); }
  const l = prop(xml, px, 'Label');
  if (l) { const k = Object.keys(LABEL_NAMES).find((x) => x === l.toLowerCase()); if (k) out.label = k; else out.skipped.push({ field: 'xmp:Label', value: l, reason: 'not one of Red, Yellow, Green, Blue, Purple' }); }
  if (pd) {
    const m = new RegExp(`<${pd}:subject>([\\s\\S]*?)</${pd}:subject>`).exec(xml);
    if (m) out.keywords = [...m[1].matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g)].map((x) => decode(x[1].trim())).filter(Boolean);
  }
  if (xml.includes('crs:')) { const c = mapCrs(readCrs(xml)); if (Object.keys(c.settings).length || c.curve) out.develop = { settings: c.settings, curve: c.curve, skipped: c.skipped.length }; }
  return out;
}

// Writes rating, label and keywords into an XMP sidecar. With existing text (a sidecar another tool
// wrote), only the properties the caller names change: a meta key that is undefined leaves that property
// as written, so a rating change never clears Lightroom's label or keywords. Every other property (crs:
// develop settings, IPTC, GPS) is kept as written. meta: { rating 0..5, flag, label ('none' clears),
// keywords [] }. xmp:Rating carries both rating and reject (-1): it is rewritten when rating or flag is
// given; a flag without a rating keeps the written rating (a reject lifted becomes 0).
export function writeXmpSidecar(existing, meta) {
  const kws = meta.keywords || [];
  const bag = (ind) => kws.length ? `${ind}<dc:subject>\n${ind} <rdf:Bag>\n${kws.map((k) => `${ind}  <rdf:li>${escX(k)}</rdf:li>`).join('\n')}\n${ind} </rdf:Bag>\n${ind}</dc:subject>\n` : '';
  const labelOf = (l) => (l && l !== 'none' ? (LABEL_NAMES[l] || l) : null);
  if (!existing || !/<rdf:Description\b/.test(existing)) {
    const rating = meta.flag === 'reject' ? -1 : (meta.rating ?? 0); const label = labelOf(meta.label);
    return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Atelier">\n <rdf:RDF xmlns:rdf="${NS.rdf}">\n  <rdf:Description rdf:about=""\n    xmlns:xmp="${NS.xmp}"\n    xmlns:dc="${NS.dc}"\n   xmp:Rating="${rating}"${label ? `\n   xmp:Label="${escX(label)}"` : ''}>\n${bag('   ')}  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>\n`;
  }
  let xml = existing;
  const px = prefixOf(xml, NS.xmp); const pd = prefixOf(xml, NS.dc);
  const doRating = meta.rating !== undefined || meta.flag !== undefined;
  const doLabel = meta.label !== undefined; const doKw = meta.keywords !== undefined;
  let rating = null;
  if (doRating) {
    const was = Math.round(Number(prop(xml, px, 'Rating') ?? 0));
    rating = meta.flag === 'reject' ? -1 : meta.rating !== undefined ? meta.rating : (was === -1 || !Number.isFinite(was) ? 0 : was);
  }
  const label = doLabel ? labelOf(meta.label) : null;
  // Remove the named properties wherever and however (attribute in either quote, or element) they are written.
  for (const [p, n, on] of [[px, 'Rating', doRating], [px, 'Label', doLabel]]) if (p && on) {
    xml = xml.replace(new RegExp(`\\s+${p}:${n}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'g'), '');
    xml = xml.replace(new RegExp(`[ \\t]*<${p}:${n}>[^<]*</${p}:${n}>[ \\t]*\\n?`, 'g'), '');
  }
  if (pd && doKw) xml = xml.replace(new RegExp(`[ \\t]*<${pd}:subject>[\\s\\S]*?</${pd}:subject>[ \\t]*\\n?`, 'g'), '').replace(new RegExp(`[ \\t]*<${pd}:subject\\s*/>[ \\t]*\\n?`, 'g'), '');
  // Insert into the first rdf:Description, declaring the namespaces it lacks.
  const open = /<rdf:Description\b([^>]*?)(\/?)>/.exec(xml);
  const P = px || 'xmp'; const D = pd || 'dc';
  let attrs = open[1];
  if (!px && (doRating || label)) attrs += `\n    xmlns:xmp="${NS.xmp}"`;
  if (!pd && doKw && kws.length) attrs += `\n    xmlns:dc="${NS.dc}"`;
  if (doRating) attrs += `\n   ${P}:Rating="${rating}"`;
  if (label) attrs += `\n   ${P}:Label="${escX(label)}"`;
  const subject = doKw ? bag('   ').replace(/<(\/?)dc:/g, `<$1${D}:`) : '';
  const replacement = open[2] ? `<rdf:Description${attrs}>\n${subject}  </rdf:Description>` : `<rdf:Description${attrs}>\n${subject}`;
  return xml.slice(0, open.index) + replacement + xml.slice(open.index + open[0].length).replace(/^\n/, '');
}
