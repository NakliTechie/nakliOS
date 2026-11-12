// Develop mode, right panel: Basic, Tone curve, Colour mixer, Colour grading, Effects, Crop and Masks,
// plus presets and copy, paste, reset. Every control sends a manifest command through the UI door;
// drags go through coalesced lanes (newest value wins, one call per animation frame).
// Values are read back from get_develop (settings, curve, notRendered) and from the open document.

import { h, svg } from './dom.js';
import { slider } from './slider.js';
import { aspectRect, wheelToHS, hsToWheel, addCurvePoint, moveCurvePoint, removeCurvePoint, IDENTITY_CURVE } from './geometry.js';
import { curveSamples } from '../../vendor/tessella/src/model.js';

const BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];
const WHEELS = ['shadows', 'midtones', 'highlights', 'global'];
const GROUPS = [
  ['White balance', ['temperature', 'tint']],
  ['Tone', ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks']],
  ['Presence', ['texture', 'clarity', 'dehaze', 'vibrance', 'saturation']],
];
const EFFECTS = ['vignette_amount', 'vignette_midpoint', 'grain_amount', 'grain_size', 'grain_roughness'];
// Panels for the rest of the rendered develop settings (spec 002 §3.1, matrix L12, L15, L20–L26, L29).
const PANELS = [
  ['Parametric curve', ['parametric_shadows', 'parametric_darks', 'parametric_lights', 'parametric_highlights', 'parametric_split_shadows', 'parametric_split_midtones', 'parametric_split_highlights']],
  ['Detail', ['sharpen_amount', 'sharpen_radius', 'sharpen_detail', 'sharpen_masking', 'nr_luminance', 'nr_color']],
  ['Lens', ['distortion', 'ca_red', 'ca_blue', 'lens_vignette_amount', 'lens_vignette_midpoint']],
  ['Transform', ['upright_vertical', 'upright_horizontal', 'straighten_angle']],
  ['Calibration', ['calib_red_hue', 'calib_red_sat', 'calib_green_hue', 'calib_green_sat', 'calib_blue_hue', 'calib_blue_sat']],
];
const LABELS = { vignette_amount: 'Vignette', vignette_midpoint: 'Midpoint', grain_amount: 'Grain', grain_size: 'Grain size' };
const LOCAL = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'saturation'];
const ASPECTS = { original: null, '1:1': [1, 1], '4:5': [4, 5], '5:4': [5, 4], '3:2': [3, 2], '2:3': [2, 3], '16:9': [16, 9] };
const title = (k) => LABELS[k] || k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ');
const NOT_RENDERED = 'Not rendered yet: Atelier does not apply this setting, so the control is off. It turns on when get_develop lists it as rendered.';

export function baseRaw(doc) {
  if (!doc) return null;
  const act = doc.layers.find((l) => l.id === doc.activeLayerId);
  if (act?.kind === 'raw' && !act.localOf) return act;
  if (act?.localOf) return doc.layers.find((l) => l.id === act.localOf) || null;
  return doc.layers.find((l) => l.kind === 'raw' && !l.localOf) || null;
}

export function createDevelopPanel(root, ui) {
  const { send, latest, manifest } = ui;
  const params = manifest.tools.find((t) => t.name === 'set_develop').inputSchema.properties.params.properties;
  let layer = null; let reply = null;
  const sliders = new Map();
  const layerId = () => layer?.id;

  const dev = latest('develop', 'set_develop', (p) => ({ layerId: layerId(), params: p }), (a, b) => ({ ...a, ...b }));
  const mk = (k, defaults) => {
    const s = params[k];
    if (!s) return h('span');
    const step = k === 'exposure' ? 0.01 : k === 'temperature' ? 50 : k === 'sharpen_radius' ? 0.1 : 1;
    const def = defaults?.[k] ?? (k === 'temperature' ? 5500 : 0);
    const sl = slider({ label: title(k), min: s.minimum, max: s.maximum, step, value: def, def, command: 'set_develop', param: k, onInput: (v) => dev.push({ [k]: v }) });
    sliders.set(k, sl); return sl.el;
  };

  const empty = h('p', { class: 'hint' }, 'Open a RAW photo from the filmstrip to develop it.');
  const body = h('div', { class: 'dev-body' });
  root.append(empty, body);

  // ---- Basic ----
  const basic = h('details', { open: true }, h('summary', {}, 'Basic'),
    GROUPS.map(([g, keys]) => [h('h4', {}, g), keys.map((k) => mk(k))]));

  // ---- Tone curve ----
  let channel = 'rgb'; let pts = IDENTITY_CURVE.map((p) => [...p]); let dragI = -1;
  const curveLane = latest('curve', 'set_tone_curve', (v) => ({ layerId: layerId(), channel: v.channel, points: v.points }));
  const S = 200; const toPx = (v) => (v / 255) * S;
  const path = svg('polyline', { class: 'curve-line', fill: 'none' });
  const dots = svg('g');
  const grid = [1, 2, 3].map((i) => [svg('line', { x1: (S * i) / 4, y1: 0, x2: (S * i) / 4, y2: S, class: 'grid' }), svg('line', { x1: 0, y1: (S * i) / 4, x2: S, y2: (S * i) / 4, class: 'grid' })]);
  const pad = svg('svg', { viewBox: `-6 -6 ${S + 12} ${S + 12}`, class: 'curve', role: 'img', 'aria-label': 'Tone curve: drag points; click to add; double-click a point to remove', dataset: { command: 'set_tone_curve' } },
    svg('rect', { x: 0, y: 0, width: S, height: S, class: 'curve-bg' }), grid, svg('line', { x1: 0, y1: S, x2: S, y2: 0, class: 'diag' }), path, dots);
  const drawCurve = () => {
    const smp = curveSamples(pts); const n = smp.length;
    path.setAttribute('points', Array.from(smp, (y, i) => `${((i / (n - 1)) * S).toFixed(1)},${(S - y * S).toFixed(1)}`).join(' '));
    dots.replaceChildren(...pts.map((p, i) => svg('circle', { cx: toPx(p[0]), cy: S - toPx(p[1]), r: 4.5, class: i === dragI ? 'pt on' : 'pt', dataset: { i } })));
  };
  const toCurve = (e) => { const r = pad.getBoundingClientRect(); const k = (S + 12) / r.width; return [((e.clientX - r.left) * k - 6) * (255 / S), (S - ((e.clientY - r.top) * k - 6)) * (255 / S)]; };
  pad.addEventListener('pointerdown', (e) => {
    if (!layer) return;
    const [x, y] = toCurve(e);
    const hit = e.target.dataset?.i;
    if (hit != null) dragI = Number(hit);
    else { const r = addCurvePoint(pts, x, y); pts = r.points; dragI = r.index; curveLane.push({ channel, points: pts }); }
    pad.setPointerCapture(e.pointerId); drawCurve();
  });
  pad.addEventListener('pointermove', (e) => { if (dragI < 0) return; const [x, y] = toCurve(e); pts = moveCurvePoint(pts, dragI, x, y); drawCurve(); curveLane.push({ channel, points: pts }); });
  pad.addEventListener('pointerup', () => { dragI = -1; drawCurve(); });
  pad.addEventListener('dblclick', (e) => { const i = e.target.dataset?.i; if (i == null) return; pts = removeCurvePoint(pts, Number(i)); drawCurve(); curveLane.push({ channel, points: pts }); });
  const chSel = h('select', { 'aria-label': 'Curve channel', onchange: (e) => { channel = e.target.value; pts = curveFor(channel); drawCurve(); } }, ['rgb', 'red', 'green', 'blue'].map((c) => h('option', { value: c }, c === 'rgb' ? 'RGB' : title(c))));
  const curveFor = (ch) => (layer?.curve?.[ch] || IDENTITY_CURVE).map((p) => [...p]);
  const curve = h('details', {}, h('summary', {}, 'Tone curve'),
    h('div', { class: 'row' }, chSel, h('button', { dataset: { command: 'set_tone_curve' }, onclick: () => { pts = IDENTITY_CURVE.map((p) => [...p]); drawCurve(); curveLane.push({ channel, points: pts }); } }, 'Reset channel')),
    pad, h('p', { class: 'hint' }, 'Click to add a point, drag to move, double-click to remove.'));

  // ---- Colour mixer ----
  let mixMode = 'hsl'; let mixAttr = 'hue';
  const mixLane = latest('mixer', 'set_color_mixer', (v) => ({ layerId: layerId(), mode: v.mode, bands: v.bands }), (a, b) => (a.mode === b.mode ? { mode: b.mode, bands: { ...a.bands, ...b.bands } } : b));
  const bandSliders = new Map();
  const bandBox = h('div');
  const bandValue = (band) => {
    const m = layer?.mixer;
    if (mixMode === 'bw') return m?.mode === 'bw' ? m.bands?.[band] ?? 0 : 0;
    return m?.mode === 'hsl' ? m.bands?.[band]?.[mixAttr] ?? 0 : 0;
  };
  const buildBands = () => {
    bandSliders.clear();
    bandBox.replaceChildren(...BANDS.map((b) => {
      const sl = slider({ label: title(b), min: -100, max: 100, value: bandValue(b), command: 'set_color_mixer', param: b, onInput: (v) => {
        if (mixMode === 'bw') { mixLane.push({ mode: 'bw', bands: { [b]: v } }); return; }
        const cur = layer?.mixer?.mode === 'hsl' ? { hue: 0, saturation: 0, luminance: 0, ...(layer.mixer.bands?.[b] || {}) } : { hue: 0, saturation: 0, luminance: 0 };
        mixLane.push({ mode: 'hsl', bands: { [b]: { ...cur, [mixAttr]: v } } });
      } });
      bandSliders.set(b, sl); return sl.el;
    }));
  };
  const attrRow = h('div', { class: 'seg', role: 'tablist' }, ['hue', 'saturation', 'luminance'].map((a) => h('button', { role: 'tab', class: a === mixAttr ? 'on' : null, dataset: { view: 'mixer-attribute', attr: a }, onclick: (e) => { mixAttr = a; for (const b of attrRow.children) b.classList.toggle('on', b === e.currentTarget); buildBands(); } }, title(a))));
  const modeSel = h('select', { 'aria-label': 'Mixer mode', dataset: { command: 'set_color_mixer' }, onchange: (e) => { mixMode = e.target.value; attrRow.hidden = mixMode === 'bw'; buildBands(); } }, h('option', { value: 'hsl' }, 'Colour (HSL)'), h('option', { value: 'bw' }, 'Black and white'));
  buildBands();
  const mixer = h('details', {}, h('summary', {}, 'Colour mixer'), h('div', { class: 'row' }, modeSel), attrRow, bandBox);

  // ---- Colour grading ----
  const gradeLane = latest('grading', 'set_color_grading', (v) => ({ layerId: layerId(), ...v }), (a, b) => ({ ...a, ...b, wheels: { ...(a.wheels || {}), ...(b.wheels || {}) } }));
  const wheelEls = new Map();
  const wheelUI = (name) => {
    const R = 44;
    const knob = h('span', { class: 'knob' });
    const disc = h('div', { class: 'wheel', role: 'slider', 'aria-label': `${title(name)} hue and saturation`, tabindex: 0, dataset: { command: 'set_color_grading', param: name } }, knob);
    const place = (hue, sat) => { const [x, y] = hsToWheel(hue, sat, R); knob.style.transform = `translate(${x}px, ${y}px)`; };
    let on = false;
    const at = (e) => { const r = disc.getBoundingClientRect(); return wheelToHS(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2), r.width / 2); };
    disc.addEventListener('pointerdown', (e) => { if (!layer) return; on = true; disc.setPointerCapture(e.pointerId); const v = at(e); place(v.hue, v.saturation); gradeLane.push({ wheels: { [name]: v } }); });
    disc.addEventListener('pointermove', (e) => { if (!on) return; const v = at(e); place(v.hue, v.saturation); gradeLane.push({ wheels: { [name]: v } }); });
    disc.addEventListener('pointerup', () => { on = false; });
    disc.addEventListener('dblclick', () => { place(0, 0); gradeLane.push({ wheels: { [name]: { hue: 0, saturation: 0 } } }); });
    const lum = slider({ label: 'Luminance', min: -100, max: 100, command: 'set_color_grading', param: `${name}.luminance`, onInput: (v) => gradeLane.push({ wheels: { [name]: { luminance: v } } }) });
    wheelEls.set(name, { place, lum, get dragging() { return on; } });
    return h('div', { class: 'wheel-box' }, h('span', { class: 'wheel-name' }, title(name)), disc, lum.el);
  };
  const blend = slider({ label: 'Blending', min: 0, max: 100, value: 50, def: 50, command: 'set_color_grading', param: 'blending', onInput: (v) => gradeLane.push({ blending: v }) });
  const balance = slider({ label: 'Balance', min: -100, max: 100, command: 'set_color_grading', param: 'balance', onInput: (v) => gradeLane.push({ balance: v }) });
  const grading = h('details', {}, h('summary', {}, 'Colour grading'), h('div', { class: 'wheels' }, WHEELS.map(wheelUI)), blend.el, balance.el);

  // ---- Effects ----
  const effects = h('details', {}, h('summary', {}, 'Effects'), EFFECTS.map((k) => mk(k, { vignette_midpoint: 50, grain_size: 25, grain_roughness: 50 })));
  const more = PANELS.map(([name, keys]) => h('details', {}, h('summary', {}, name), keys.map((k) => mk(k, { sharpen_radius: 1, sharpen_detail: 25, lens_vignette_midpoint: 50, parametric_split_shadows: 25, parametric_split_midtones: 50, parametric_split_highlights: 75 }))));

  // ---- Crop ----
  const cropLane = latest('crop', 'set_crop', (v) => ({ layerId: layerId(), ...v }));
  const photoSize = () => { const d = ui.store.doc; const r = layer?.crop?.rect || { w: 1, h: 1 }; return [Math.round(d.width / r.w), Math.round(d.height / r.h)]; };
  const aspectSel = h('select', { 'aria-label': 'Crop aspect', dataset: { command: 'set_crop' }, onchange: (e) => { if (!layer) return; const [W, H] = photoSize(); send('set_crop', { layerId: layerId(), rect: aspectRect(W, H, ASPECTS[e.target.value]) }); } },
    Object.keys(ASPECTS).map((k) => h('option', { value: k }, k === 'original' ? 'Original' : k)));
  const angle = slider({ label: 'Straighten', min: -45, max: 45, step: 0.1, command: 'set_crop', param: 'angle', onInput: (v) => cropLane.push({ angle: v }) });
  const crop = h('details', {}, h('summary', {}, 'Crop'),
    h('div', { class: 'row' }, aspectSel, h('button', { dataset: { view: 'tool:crop' }, onclick: () => ui.setTool('crop') }, 'Draw crop (R)'),
      h('button', { dataset: { command: 'set_crop' }, onclick: () => layer && send('set_crop', { layerId: layerId(), rect: { x: 0, y: 0, w: 1, h: 1 }, angle: 0 }) }, 'Reset')),
    angle.el);

  // ---- Masks (local adjustments) ----
  const maskList = h('ul', { class: 'masks' });
  const maskSliders = new Map();
  const maskLane = latest('mask-adjust', 'set_mask_adjustments', (v) => ({ layerId: layerId(), maskId: ui.state.mask, params: v }), (a, b) => ({ ...a, ...b }));
  const maskBox = h('div', {}, LOCAL.map((k) => { const sl = slider({ label: title(k), min: k === 'exposure' ? -5 : -100, max: k === 'exposure' ? 5 : 100, step: k === 'exposure' ? 0.01 : 1, command: 'set_mask_adjustments', param: k, onInput: (v) => maskLane.push({ [k]: v }) }); maskSliders.set(k, sl); return sl.el; }));
  const masks = h('details', {}, h('summary', {}, 'Masks'),
    h('div', { class: 'row' },
      h('button', { dataset: { view: 'tool:mask-linear' }, onclick: () => ui.setTool('mask-linear') }, 'Linear (M)'),
      h('button', { dataset: { view: 'tool:mask-radial' }, onclick: () => ui.setTool('mask-radial') }, 'Radial (Shift+M)'),
      h('button', { dataset: { view: 'tool:mask-brush' }, onclick: () => ui.setTool('mask-brush') }, 'Brush (K)')),
    maskList, maskBox);

  // ---- Presets, copy, paste, reset ----
  const presetSel = h('select', { 'aria-label': 'Apply preset', dataset: { command: 'apply_preset' }, onchange: async (e) => { const p = e.target.value; e.target.value = ''; if (p && layer) await send('apply_preset', { layerIds: [layerId()], preset: p }); } });
  const foot = h('div', { class: 'dev-foot' },
    h('div', { class: 'row' }, presetSel,
      h('button', { dataset: { command: 'save_preset' }, onclick: async () => { if (!layer) return; const name = await ui.dialogs.promptText('Save preset', 'Preset name', 'My preset'); if (name) { await send('save_preset', { layerId: layerId(), name }); refreshPresets(); } } }, 'Save preset')),
    h('div', { class: 'row' },
      h('button', { dataset: { command: 'copy_settings' }, title: 'Ctrl+Shift+C', onclick: () => ui.copySettings() }, 'Copy'),
      h('button', { dataset: { command: 'sync_settings' }, title: 'Ctrl+Shift+V', onclick: () => ui.pasteSettings() }, 'Paste'),
      h('button', { dataset: { command: 'reset_develop' }, onclick: () => layer && send('reset_develop', { layerId: layerId() }) }, 'Reset all')));
  async function refreshPresets() {
    const r = await ui.read('list_presets');
    const list = r.status === 'ok' ? r.result.presets : [];
    presetSel.replaceChildren(h('option', { value: '' }, list.length ? 'Apply preset…' : 'No presets'), ...list.filter((p) => p.kind !== 'lut').map((p) => h('option', { value: p.path }, `${p.name}${p.kind === 'xmp' ? ' (XMP)' : ''}`)));
  }

  body.append(basic, curve, ...more.slice(0, 1), mixer, grading, ...more.slice(1), effects, crop, masks, foot);

  async function update() {
    const doc = ui.store.doc;
    layer = baseRaw(doc);
    empty.hidden = !!layer; body.hidden = !layer;
    if (!layer) return;
    reply = await ui.read('get_develop', { layerId: layer.id });
    if (reply.status !== 'ok') return;
    const { settings, notRendered } = reply.result;
    // Temperature and tint read as shot until set (null), so the sliders show what the photo renders with.
    const asShot = reply.result.asShot || {};
    for (const [k, sl] of sliders) {
      sl.disable(notRendered.includes(k), NOT_RENDERED);
      const v = settings[k] ?? (k === 'temperature' ? asShot.temperature : k === 'tint' ? asShot.tint : null);
      if (v !== null && v !== undefined) sl.set(Math.round(v * 100) / 100);
    }
    if (dragI < 0) { pts = curveFor(channel); drawCurve(); }
    for (const [b, sl] of bandSliders) sl.set(bandValue(b));
    const g = layer.grading || {};
    for (const [w, el] of wheelEls) { if (!el.dragging) el.place(g[w]?.hue ?? 0, g[w]?.saturation ?? 0); el.lum.set(g[w]?.luminance ?? 0); }
    blend.set(g.blending ?? 50); balance.set(g.balance ?? 0);
    angle.set(layer.crop?.angle ?? 0);
    // masks
    const locals = doc.layers.filter((l) => l.localOf === layer.id);
    const ids = locals.map((l) => l.id.slice(layer.id.length + 1));
    if (!ids.includes(ui.state.mask)) ui.state.mask = ids.at(-1) ?? null;
    maskList.replaceChildren(...locals.map((l, i) => h('li', { class: ids[i] === ui.state.mask ? 'active' : null },
      h('button', { dataset: { command: 'set_layer', layer: l.id }, 'aria-label': `${l.visible ? 'Hide' : 'Show'} mask ${ids[i]}`, onclick: () => send('set_layer', { layerId: l.id, visible: !l.visible }) }, l.visible ? '●' : '○'),
      h('button', { class: 'name', dataset: { view: 'select-mask' }, onclick: () => { ui.state.mask = ids[i]; update(); } }, `${ids[i]} · ${(l.mask?.components || []).map((c) => c.kind).join(' + ') || 'empty'}`),
      h('button', { dataset: { command: 'delete_layer' }, 'aria-label': `Delete mask ${ids[i]}`, onclick: () => send('delete_layer', { layerId: l.id }) }, '×'))));
    if (!locals.length) maskList.replaceChildren(h('li', { class: 'hint' }, 'No masks. Choose Linear, Radial or Brush, then drag on the photo.'));
    const cur = locals[ids.indexOf(ui.state.mask)];
    maskBox.hidden = !cur;
    if (cur) for (const [k, sl] of maskSliders) sl.set(cur.localDelta?.[k] ?? 0);
  }

  refreshPresets();
  return { update, refreshPresets, get layer() { return layer; } };
}
