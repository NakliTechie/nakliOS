// Develop commands on RAW layers. Only settings the engine renders are accepted; a setting it cannot
// render yet answers `unsupported` and nothing is applied, so a stored value never misreports the image.

import { DEVELOP_DEFAULTS, DEVELOP_RENDERED } from '../../vendor/tessella/src/model.js';
import { needLayer, needDoc, fail, change } from './util.js';
import { localId } from './select.js';

export const PANELS = {
  wb: ['temperature', 'tint'],
  basic: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'texture', 'clarity', 'dehaze', 'vibrance', 'saturation'],
  curve: ['parametric_shadows', 'parametric_darks', 'parametric_lights', 'parametric_highlights', 'parametric_split_shadows', 'parametric_split_midtones', 'parametric_split_highlights'],
  detail: ['sharpen_amount', 'sharpen_radius', 'sharpen_detail', 'sharpen_masking', 'nr_luminance', 'nr_color'],
  lens: ['distortion', 'ca_remove', 'ca_red', 'ca_blue', 'lens_vignette_amount', 'lens_vignette_midpoint', 'lens_profile', 'lens_profile_distortion', 'lens_profile_vignetting'],
  transform: ['upright_vertical', 'upright_horizontal', 'straighten_angle'],
  effects: ['vignette_amount', 'vignette_midpoint', 'grain_amount', 'grain_size', 'grain_roughness', 'halation_amount', 'halation_size', 'bloom_amount', 'bloom_size'],
  calibration: ['calib_red_hue', 'calib_red_sat', 'calib_green_hue', 'calib_green_sat', 'calib_blue_hue', 'calib_blue_sat'],
  mixer: [], grading: [],
};
const BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];
const WHEELS = ['shadows', 'midtones', 'highlights', 'global'];
const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const KNOWN_PANELS = ['wb', 'basic', 'curve', 'mixer', 'grading', 'detail', 'lens', 'transform', 'effects', 'calibration', 'masks', 'crop'];

function rawLayer(ctx, id) {
  const l = needLayer(ctx, id);
  if (l.kind !== 'raw') fail('unsupported', 'develop settings apply to RAW layers', 'change_target', 'open_photo');
  if (l.localOf) fail('unsupported', 'this layer is a local adjustment; change it with set_mask_adjustments on its base layer', 'change_target', 'set_mask_adjustments');
  return l;
}

export function settingsOf(l, panels = KNOWN_PANELS) {
  const out = {};
  for (const p of panels) {
    if (p === 'curve') { if (l.curve) out.curve = structuredClone(l.curve); continue; }
    if (p === 'mixer') { if (l.mixer) out.mixer = structuredClone(l.mixer); continue; }
    if (p === 'grading') { if (l.grading) out.grading = structuredClone(l.grading); continue; }
    if (p === 'calibration' && l.lut) out.lut = structuredClone(l.lut);
    // The lens profile flag (lens_profile) travels with the resolved profile it switches on; a flag without
    // its profile would make the target fail to render. The coefficients are the ones resolved for this photo.
    if (p === 'lens' && l.lensProfile) out.lensProfile = structuredClone(l.lensProfile);
    for (const k of PANELS[p] || []) if (l.develop?.[k] !== undefined) out[k] = l.develop[k];
  }
  return out;
}

export function register(bus, ctx) {
  bus.register('query.develop', async (a) => {
    const l = rawLayer(ctx, a.layerId);
    const src = await ctx.renderer?.sourceSize(l);
    return { layerId: l.id, asShot: src?.asShot ? { temperature: src.asShot.temperature, tint: src.asShot.tint } : null, settings: { ...DEVELOP_DEFAULTS, ...l.develop }, curve: l.curve ?? null, rendered: DEVELOP_RENDERED,
      notRendered: Object.keys(bus.manifest.tools.find((t) => t.name === 'set_develop').inputSchema.properties.params.properties).filter((k) => !DEVELOP_RENDERED.includes(k)) };
  });

  bus.register('develop.set', async (a) => {
    const l = rawLayer(ctx, a.layerId);
    const unrendered = Object.keys(a.params).filter((k) => !DEVELOP_RENDERED.includes(k));
    if (a.params.lens_profile === 1 && !l.lensProfile) fail('unsupported', 'this layer has no lens profile; open lens data you own with load_lens_data, then pick a profile with set_lens_profile', 'fix_argument', 'set_lens_profile');
    const merged = { ...DEVELOP_DEFAULTS, ...l.develop, ...a.params };
    const sp = [merged.parametric_split_shadows, merged.parametric_split_midtones, merged.parametric_split_highlights];
    if (!(sp[0] + 5 <= sp[1] && sp[1] + 5 <= sp[2])) fail('invalid', `parametric splits must ascend at least 5 apart (shadows < midtones < highlights); would be ${sp.join(', ')}`, 'fix_argument', 'set_develop');
    if (unrendered.length) fail('unsupported', `not rendered yet: ${unrendered.join(', ')}; nothing applied`, 'fix_argument', 'get_develop');
    await change(ctx, 'set_develop', (doc) => { const x = doc.layers.find((y) => y.id === l.id); x.develop = { ...x.develop, ...a.params }; });
    return { settings: { ...DEVELOP_DEFAULTS, ...ctx.store.doc.layers.find((y) => y.id === l.id).develop } };
  });

  bus.register('develop.curve', async (a) => {
    const l = rawLayer(ctx, a.layerId);
    if (a.parametric) fail('unsupported', 'parametric curves are not built yet; pass points', 'fix_argument', 'set_tone_curve');
    if (!a.points) fail('invalid', 'points are required', 'fix_argument', 'set_tone_curve');
    const xs = a.points.map((p) => p[0]);
    if (new Set(xs).size !== xs.length) fail('invalid', 'curve points need distinct x values', 'fix_argument', 'set_tone_curve');
    await change(ctx, 'set_tone_curve', (doc) => {
      const x = doc.layers.find((y) => y.id === l.id);
      x.curve = { ...(x.curve || {}), [a.channel]: a.points };
    });
    return { curve: ctx.store.doc.layers.find((y) => y.id === l.id).curve };
  });

  bus.register('develop.mixer', async (a) => {
    const l = rawLayer(ctx, a.layerId);
    for (const [band, v] of Object.entries(a.bands)) {
      if (!BANDS.includes(band)) fail('invalid', `unknown band ${band}`, 'fix_argument', 'set_color_mixer');
      if (a.mode === 'bw' && !inRange(v, -100, 100)) fail('invalid', `bands.${band} is a number -100..100 in bw mode`, 'fix_argument', 'set_color_mixer');
      if (a.mode === 'hsl') {
        if (typeof v !== 'object' || v === null) fail('invalid', `bands.${band} is { hue, saturation, luminance }`, 'fix_argument', 'set_color_mixer');
        for (const [k, n] of Object.entries(v)) if (!['hue', 'saturation', 'luminance'].includes(k) || !inRange(n, -100, 100)) fail('invalid', `bands.${band}.${k} must be hue|saturation|luminance in -100..100`, 'fix_argument', 'set_color_mixer');
      }
    }
    await change(ctx, 'set_color_mixer', (doc) => {
      const x = doc.layers.find((y) => y.id === l.id);
      const keep = x.mixer?.mode === a.mode ? x.mixer.bands : {};
      x.mixer = { mode: a.mode, bands: { ...keep, ...a.bands } };
    });
    return { mixer: ctx.store.doc.layers.find((y) => y.id === l.id).mixer };
  });

  bus.register('develop.grading', async (a) => {
    const l = rawLayer(ctx, a.layerId);
    for (const [w, v] of Object.entries(a.wheels || {})) {
      if (!WHEELS.includes(w)) fail('invalid', `unknown wheel ${w}`, 'fix_argument', 'set_color_grading');
      if (typeof v !== 'object' || v === null) fail('invalid', `wheels.${w} is { hue, saturation, luminance }`, 'fix_argument', 'set_color_grading');
      if (v.hue !== undefined && !inRange(v.hue, 0, 360)) fail('invalid', `wheels.${w}.hue is 0..360`, 'fix_argument', 'set_color_grading');
      if (v.saturation !== undefined && !inRange(v.saturation, 0, 100)) fail('invalid', `wheels.${w}.saturation is 0..100`, 'fix_argument', 'set_color_grading');
      if (v.luminance !== undefined && !inRange(v.luminance, -100, 100)) fail('invalid', `wheels.${w}.luminance is -100..100`, 'fix_argument', 'set_color_grading');
      if (Object.keys(v).some((k) => !['hue', 'saturation', 'luminance'].includes(k))) fail('invalid', `wheels.${w} takes hue, saturation, luminance`, 'fix_argument', 'set_color_grading');
    }
    await change(ctx, 'set_color_grading', (doc) => {
      const x = doc.layers.find((y) => y.id === l.id);
      const g = x.grading || {};
      for (const [w, v] of Object.entries(a.wheels || {})) g[w] = { ...(g[w] || {}), ...v };
      if (a.blending !== undefined) g.blending = a.blending;
      if (a.balance !== undefined) g.balance = a.balance;
      x.grading = g;
    });
    return { grading: ctx.store.doc.layers.find((y) => y.id === l.id).grading };
  });

  // Local adjustment deltas for a masked local adjustment created by set_mask with a maskId.
  bus.register('mask.adjust', async (a) => {
    const base = rawLayer(ctx, a.layerId);
    const loc = needDoc(ctx).layers.find((x) => x.id === localId(base.id, a.maskId));
    if (!loc) fail('invalid', `no local adjustment ${a.maskId}; create it with set_mask (layerId, maskId, components)`, 'change_target', 'set_mask');
    // A local adjustment is a second develop of the same photo under a mask, so geometry and lens settings
    // (which would move its pixels against the base) and the post-crop vignette stay global.
    const GLOBAL_ONLY = /^(vignette|lens_|ca_|distortion|upright_|straighten|parametric_split)/;
    const local = DEVELOP_RENDERED.filter((k) => !GLOBAL_ONLY.test(k));
    const bad = Object.keys(a.params).filter((k) => !local.includes(k));
    if (bad.length) fail('unsupported', `not available as local adjustments: ${bad.join(', ')}; local: ${local.join(', ')}`, 'fix_argument', 'set_mask_adjustments');
    for (const [k, v] of Object.entries(a.params)) {
      const lim = k === 'exposure' ? 5 : 100;
      if (typeof v !== 'number' || Math.abs(v) > lim) fail('invalid', `${k} must be a number within ±${lim}`, 'fix_argument', 'set_mask_adjustments');
    }
    await change(ctx, 'set_mask_adjustments', (doc) => { const x = doc.layers.find((y) => y.id === loc.id); x.localDelta = { ...x.localDelta, ...a.params }; });
    return { maskId: a.maskId, localLayerId: loc.id, delta: ctx.store.doc.layers.find((y) => y.id === loc.id).localDelta };
  });

  // Crop and straighten a develop document (one RAW photo): the document becomes the crop, the photo
  // is placed through a rotation about the crop centre. rect is normalised to the photo, angle in degrees.
  bus.register('develop.crop', async (a) => {
    const l = rawLayer(ctx, a.layerId);
    const doc = needDoc(ctx);
    if (doc.layers.some((x) => x.id !== l.id && x.localOf !== l.id && x.kind !== 'fill')) fail('unsupported', 'crop applies to a develop document (one RAW photo); in a composite use crop_document or transform_layer', 'change_target', 'crop_document');
    const { width: W, height: H } = await ctx.renderer.sourceSize(l);
    const rect = { x: 0, y: 0, w: 1, h: 1, ...(l.crop?.rect || {}), ...(a.rect || {}) };
    const angle = a.angle ?? l.crop?.angle ?? 0;
    if (rect.x + rect.w > 1.000001 || rect.y + rect.h > 1.000001 || rect.w <= 0 || rect.h <= 0) fail('invalid', 'rect must lie inside the photo (x + w <= 1, y + h <= 1)', 'fix_argument', 'set_crop');
    const { width: dw, height: dh, matrix } = cropGeometry(W, H, rect, angle);
    await change(ctx, 'set_crop', (d) => {
      d.width = dw; d.height = dh;
      for (const x of d.layers) if (x.id === l.id || x.localOf === l.id) { x.matrix = [...matrix]; if (x.id === l.id) x.crop = { rect, angle }; }
    });
    return { crop: { rect, angle }, document: { width: dw, height: dh } };
  });

  bus.register('develop.reset', async (a) => {
    const l = rawLayer(ctx, a.layerId);
    const panels = a.panels?.length ? a.panels : KNOWN_PANELS;
    const bad = panels.filter((p) => !KNOWN_PANELS.includes(p));
    if (bad.length) fail('invalid', `unknown panels: ${bad.join(', ')}`, 'fix_argument', 'reset_develop');
    await change(ctx, 'reset_develop', (doc) => {
      const x = doc.layers.find((y) => y.id === l.id);
      for (const p of panels) {
        if (p === 'curve') delete x.curve;
        if (p === 'mixer') delete x.mixer;
        if (p === 'grading') delete x.grading;
        if (p === 'calibration') delete x.lut;
        if (p === 'lens') delete x.lensProfile;
        for (const k of PANELS[p] || []) delete x.develop?.[k];
      }
    });
    return { settings: { ...DEVELOP_DEFAULTS, ...ctx.store.doc.layers.find((y) => y.id === l.id).develop } };
  });

  bus.register('develop.copy', (a) => {
    const l = rawLayer(ctx, a.layerId);
    ctx.clipboard = settingsOf(l, a.panels?.length ? a.panels : KNOWN_PANELS);
    return { copied: ctx.clipboard };
  });
}

// rect normalised to the photo (W × H source pixels), angle in degrees → document size and photo matrix.
export function cropGeometry(W, H, rect, angle = 0) {
  const width = Math.max(1, Math.round(rect.w * W)); const height = Math.max(1, Math.round(rect.h * H));
  const cx = (rect.x + rect.w / 2) * W; const cy = (rect.y + rect.h / 2) * H;
  const t = (-angle * Math.PI) / 180; const c = Math.cos(t); const s = Math.sin(t);
  return { width, height, matrix: [c, s, -s, c, width / 2 - (c * cx - s * cy), height / 2 - (s * cx + c * cy)] };
}
