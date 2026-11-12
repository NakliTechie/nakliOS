// Composite-mode controls for the engine commands that had no UI (two doors, one core): layer styles
// (set_layer_style), the add-adjustment menu with the duotone dialog (add_layer, set_adjustment), the filter menu with the
// artistic filters (apply_filter) and the soft proof toggle with gamut warning (set_soft_proof). The warp and liquify tools
// and the CMYK eyedropper live with the other tools in tools.js; Export CMYK TIFF is in export.js. Every control sends its
// command through ui.send, so the bus checks it exactly as it checks an agent's call.

import { h } from './dom.js';
import { hexToLinear2020 } from '../document.js';

// [key, label, fields]. A field is [name, kind, default, min, max]; kind: colour | pct (0..1 shown as 0..100) | num | select.
const SHADOW = [['colour', 'colour', '#000000'], ['opacity', 'pct', 0.6, 0, 100], ['angle', 'num', 120, -360, 360], ['distance', 'num', 8, 0, 100], ['size', 'num', 8, 0, 40]];
export const STYLE_DEFS = [
  ['dropShadow', 'Drop shadow', SHADOW],
  ['innerShadow', 'Inner shadow', SHADOW],
  ['stroke', 'Stroke', [['colour', 'colour', '#000000'], ['opacity', 'pct', 1, 0, 100], ['size', 'num', 3, 1, 30], ['position', ['outside', 'inside', 'centre'], 'outside']]],
  ['gradientOverlay', 'Gradient overlay', [['from', 'colour', '#000000'], ['to', 'colour', '#ffffff'], ['angle', 'num', 90, -360, 360], ['opacity', 'pct', 1, 0, 100]]],
];
const LABEL = { colour: 'Colour', opacity: 'Opacity %', angle: 'Angle', distance: 'Distance', size: 'Size', position: 'Position', from: 'From', to: 'To' };

// Artistic filters and the classic four: [filter, label, fields]; each field [name, label, min, max, default, step].
export const FILTER_DEFS = [
  ['gaussian-blur', 'Gaussian blur', [['radius', 'Radius', 0, 250, 5, 0.5]]],
  ['unsharp-mask', 'Unsharp mask', [['amount', 'Amount %', 0, 500, 100], ['radius', 'Radius', 0.1, 250, 1, 0.1], ['threshold', 'Threshold', 0, 255, 0]]],
  ['high-pass', 'High pass', [['radius', 'Radius', 0.1, 250, 3, 0.1]]],
  ['add-noise', 'Add noise', [['amount', 'Amount %', 0, 100, 10]]],
  ['oil-paint', 'Oil paint', [['radius', 'Radius', 1, 30, 4]]],
  ['watercolour', 'Watercolour', [['radius', 'Radius', 1, 30, 4], ['strength', 'Strength', 0, 100, 50]]],
  ['sketch', 'Sketch', [['radius', 'Radius', 1, 30, 6]]],
  ['posterise', 'Posterise', [['levels', 'Levels', 2, 64, 4]]],
  ['halftone', 'Halftone', [['size', 'Dot size', 2, 128, 8], ['angle', 'Angle', -360, 360, 45]]],
];
// Adjustment layers added with the engine's defaults (empty params); Duotone opens its ink dialog.
const ADJUSTMENTS = [['levels', 'Levels'], ['curves', 'Curves'], ['hue-saturation', 'Hue and saturation'], ['exposure', 'Exposure'], ['colour-balance', 'Colour balance'], ['black-and-white', 'Black and white'], ['duotone', 'Duotone…']];
const DUO_DEFAULT = ['#1b2a6b', '#e8b04a', '#8a2d2d', '#2d6a4f'];

// '#rrggbb' → linear Rec.2020 [r, g, b] (the engine's ink colour), and back for prefilling the dialog.
export const inkFromHex = (hex) => Array.from(hexToLinear2020(hex)).slice(0, 3);
// Inverse of hexToLinear2020 (the engine stores ink colours as linear Rec.2020), so an existing duotone opens with its colours.
const M2020 = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]];
const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
const inv3 = (m) => { const d = det3(m); const c = (i, j) => { const r = [0, 1, 2].filter((x) => x !== i); const k = [0, 1, 2].filter((x) => x !== j); return (m[r[0]][k[0]] * m[r[1]][k[1]] - m[r[0]][k[1]] * m[r[1]][k[0]]) * ((i + j) % 2 ? -1 : 1); }; return [0, 1, 2].map((i) => [0, 1, 2].map((j) => c(j, i) / d)); };
const MINV = inv3(M2020);
export const hexFromInk = (lin) => '#' + MINV.map((r) => r[0] * lin[0] + r[1] * lin[1] + r[2] * lin[2]).map((x) => { const c = Math.min(1, Math.max(0, x)); const e = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055; return Math.round(e * 255).toString(16).padStart(2, '0'); }).join('');

export function createEngineUI(root, ui) {
  const { send } = ui;
  const active = () => ui.store.doc?.layers.find((l) => l.id === ui.store.doc.activeLayerId) || null;
  const proofLayer = () => ui.store.doc?.layers.find((l) => l.kind === 'adjustment' && l.adjustment?.type === 'proof' && !l.parentId) || null;

  // ---- layer style ----
  async function layerStyleDialog() {
    const l = active();
    if (!l || !['image', 'text', 'raster'].includes(l.kind)) { ui.say('Choose an image, text or raster layer for a layer style.'); return null; }
    const src = l.styleSource || {};
    const state = STYLE_DEFS.map(([key, title, fields]) => {
      const cur = src[key];
      const on = h('input', { type: 'checkbox', checked: !!cur, 'aria-label': title, dataset: { view: `style:${key}` } });
      const inputs = fields.map(([name, kind, def, min, max]) => {
        const v = cur?.[name] ?? def;
        let el;
        if (kind === 'colour') el = h('input', { type: 'color', value: typeof v === 'string' ? (v.startsWith('#') ? v : `#${v}`) : '#000000', 'aria-label': `${title} ${LABEL[name]}` });
        else if (Array.isArray(kind)) el = h('select', { 'aria-label': `${title} ${LABEL[name]}` }, kind.map((o) => h('option', { value: o, selected: o === v }, o)));
        else el = h('input', { type: 'number', min, max, step: 1, value: kind === 'pct' ? Math.round(v * 100) : v, 'aria-label': `${title} ${LABEL[name]}` });
        return [name, kind, el];
      });
      const box = h('fieldset', { class: 'style-box' }, h('legend', {}, h('label', { class: 'check' }, on, title)),
        inputs.map(([name, , el]) => h('label', { class: 'field' }, h('span', {}, LABEL[name]), el)));
      return { key, on, inputs, box };
    });
    const read = () => {
      const styles = {};
      for (const s of state) {
        if (!s.on.checked) { styles[s.key] = null; continue; }
        const o = {};
        for (const [name, kind, el] of s.inputs) {
          if (kind === 'colour' || Array.isArray(kind)) o[name] = el.value;
          else { const n = Number(el.value); const [min, max] = kind === 'pct' ? [0, 100] : [Number(el.min), Number(el.max)]; const c = Math.min(max, Math.max(min, Number.isFinite(n) ? n : 0)); o[name] = kind === 'pct' ? c / 100 : c; }
        }
        styles[s.key] = o;
      }
      return styles;
    };
    const styles = await ui.dialogs.raw({ title: 'Layer style', body: h('div', { class: 'form', dataset: { command: 'set_layer_style' } }, state.map((s) => s.box), h('p', { class: 'hint' }, `Applies to “${l.name}”. A style left unticked is removed.`)),
      actions: [{ label: 'Cancel', value: null }, { label: 'Apply', primary: true, value: read }] });
    if (!styles) return null;
    const r = await send('set_layer_style', { layerId: l.id, styles });
    if (r.status === 'ok') ui.say(r.result.styles ? `Layer style: ${Object.keys(r.result.styles).join(', ')}.` : 'Layer style removed.');
    return r;
  }

  // ---- duotone ----
  async function duotoneDialog() {
    const cur = active();
    const editing = cur?.kind === 'adjustment' && cur.adjustment?.type === 'duotone';
    const n = h('select', { 'aria-label': 'Number of inks' }, [1, 2, 3, 4].map((k) => h('option', { value: k, selected: k === (editing ? cur.adjustment.params.inks?.length ?? 2 : 2) }, String(k))));
    const picks = DUO_DEFAULT.map((d, i) => h('input', { type: 'color', value: d, 'aria-label': `Ink ${i + 1}` }));
    const rows = picks.map((p, i) => h('label', { class: 'field' }, h('span', {}, `Ink ${i + 1}`), p));
    const sync = () => rows.forEach((r, i) => { r.hidden = i >= Number(n.value); });
    n.addEventListener('change', sync); sync();
    if (editing) (cur.adjustment.params.inks || []).forEach((ink, i) => { if (picks[i] && ink.colour) picks[i].value = hexFromInk(ink.colour); });
    const v = await ui.dialogs.raw({ title: editing ? 'Edit duotone' : 'Duotone', body: h('div', { class: 'form', dataset: { command: 'set_adjustment' } },
      h('label', { class: 'field' }, h('span', {}, 'Inks'), n), rows,
      h('p', { class: 'hint' }, 'Each ink prints in proportion to how dark the image is, the first ink on the darkest tones. Colours are converted to the engine’s linear Rec. 2020.')),
    actions: [{ label: 'Cancel', value: null }, { label: editing ? 'Apply' : 'Add layer', primary: true, value: () => picks.slice(0, Number(n.value)).map((p) => p.value) }] });
    if (!v) return null;
    const inks = v.map((c) => ({ colour: inkFromHex(c) }));
    if (editing) return send('set_adjustment', { layerId: cur.id, type: 'duotone', params: { inks } });
    return send('add_layer', { kind: 'adjustment', name: 'Duotone', adjustment: { type: 'duotone', params: { inks } } });
  }

  // ---- filter ----
  async function filterDialog(filter) {
    const l = active();
    if (!l || l.kind !== 'raster') { ui.say('Choose a raster layer to filter (filters change its pixels).'); return null; }
    const def = FILTER_DEFS.find((f) => f[0] === filter);
    const inputs = def[2].map(([name, label, min, max, d, step]) => [name, h('input', { type: 'number', min, max, step: step ?? 1, value: d, 'aria-label': label })]);
    const extra = [];
    let mode = null; let mono = null;
    if (filter === 'halftone') { mode = h('select', { 'aria-label': 'Halftone mode' }, ['mono', 'colour'].map((m) => h('option', { value: m }, m))); extra.push(h('label', { class: 'field' }, h('span', {}, 'Mode'), mode)); }
    if (filter === 'add-noise') { mono = h('input', { type: 'checkbox', 'aria-label': 'Monochromatic' }); extra.push(h('label', { class: 'field' }, h('span', {}, 'Monochromatic'), mono)); }
    const params = await ui.dialogs.raw({ title: def[1], body: h('div', { class: 'form', dataset: { command: 'apply_filter' } },
      def[2].map(([, label], i) => h('label', { class: 'field' }, h('span', {}, label), inputs[i][1])), extra,
      h('p', { class: 'hint' }, `Changes the pixels of “${l.name}”. Undo (Ctrl+Z) takes it back.`)),
    actions: [{ label: 'Cancel', value: null }, { label: 'Apply', primary: true, value: () => {
      const o = {};
      def[2].forEach(([name, , min, max], i) => { const n = Number(inputs[i][1].value); o[name] = Math.min(max, Math.max(min, Number.isFinite(n) ? n : min)); });
      if (mode) o.mode = mode.value;
      if (mono) o.monochromatic = mono.checked;
      return o;
    } }] });
    if (!params) return null;
    const r = await send('apply_filter', { layerId: l.id, filter, params });
    if (r.status === 'ok') ui.say(`${def[1]} applied.`);
    return r;
  }

  // ---- soft proof ----
  const proofOn = h('input', { type: 'checkbox', 'aria-label': 'Soft proof', dataset: { command: 'set_soft_proof' } });
  const proofWarn = h('input', { type: 'checkbox', 'aria-label': 'Gamut warning', dataset: { command: 'set_soft_proof' } });
  const proofTac = h('input', { type: 'number', min: 100, max: 400, step: 10, value: 300, 'aria-label': 'Total ink limit', style: 'width:4.5em', dataset: { command: 'set_soft_proof' } });
  // A CMYK ICC output profile from the workspace (path to a .icc or .icm file); empty proofs on the built-in press.
  const proofProfile = h('input', { type: 'text', placeholder: 'ICC profile path (empty: built-in press)', 'aria-label': 'Soft proof ICC profile', style: 'width:14em', dataset: { command: 'set_soft_proof' } });
  const sendProof = async () => {
    if (!ui.store.doc) return;
    const tac = Math.min(400, Math.max(100, Number(proofTac.value) || 300));
    const profile = proofProfile.value.trim();
    const r = await send('set_soft_proof', profile ? { on: proofOn.checked, profile, warning: proofWarn.checked } : { on: proofOn.checked, tac, warning: proofWarn.checked, profile: null });
    if (r.status === 'ok') ui.say(proofOn.checked ? `Soft proof on (${r.result.softProof?.press ?? 'naive press'}${profile ? '' : `, total ink ${tac} %`}).` : 'Soft proof off.');
    else if (r.status === 'invalid') ui.say(`Soft proof: ${r.error?.message ?? 'refused'}`);
    render();
  };
  for (const el of [proofOn, proofWarn]) el.addEventListener('change', sendProof);
  proofTac.addEventListener('change', () => { if (proofOn.checked) sendProof(); });
  proofProfile.addEventListener('change', () => { if (proofOn.checked) sendProof(); });

  // ---- panel ----
  const styleBtn = h('button', { dataset: { command: 'set_layer_style' }, title: 'Drop shadow, inner shadow, stroke, gradient overlay', onclick: () => layerStyleDialog() }, 'Layer style…');
  const adjSel = h('select', { 'aria-label': 'Add adjustment', dataset: { command: 'add_layer' }, onchange: async (e) => {
    const t = e.target.value; e.target.value = ''; if (!t) return;
    if (t === 'duotone') { await duotoneDialog(); return; }
    await send('add_layer', { kind: 'adjustment', name: ADJUSTMENTS.find((a) => a[0] === t)[1], adjustment: { type: t, params: {} } });
  } }, h('option', { value: '' }, 'Add adjustment…'), ADJUSTMENTS.map(([k, t]) => h('option', { value: k }, t)));
  const duoBtn = h('button', { dataset: { command: 'set_adjustment' }, hidden: true, onclick: () => duotoneDialog() }, 'Edit duotone…');
  const filSel = h('select', { 'aria-label': 'Filter', dataset: { command: 'apply_filter' }, onchange: async (e) => { const f = e.target.value; e.target.value = ''; if (f) await filterDialog(f); } },
    h('option', { value: '' }, 'Filter…'), h('optgroup', { label: 'Artistic' }, FILTER_DEFS.slice(4).map(([k, t]) => h('option', { value: k }, t))), h('optgroup', { label: 'Blur, sharpen, noise' }, FILTER_DEFS.slice(0, 4).map(([k, t]) => h('option', { value: k }, t))));
  const panel = h('details', { class: 'engine-ui', open: true }, h('summary', {}, 'Style, filters and print'),
    h('div', { class: 'row wrap' }, styleBtn, duoBtn), h('div', { class: 'row wrap' }, adjSel, filSel),
    h('div', { class: 'row wrap' }, h('label', { class: 'check' }, proofOn, 'Soft proof'), h('label', { class: 'check', title: 'Paints colours the press cannot print in grey' }, proofWarn, 'Gamut warning'), h('label', {}, 'Ink ', proofTac, ' %')),
    h('div', { class: 'row wrap' }, proofProfile),
    h('p', { class: 'hint' }, 'Soft proof previews the built-in four-ink press (not a characterised printing condition), or the CMYK ICC profile you name.'));
  root.append(panel);

  function render() {
    const doc = ui.store.doc; const l = active();
    styleBtn.disabled = !l || !['image', 'text', 'raster'].includes(l.kind);
    duoBtn.hidden = !(l?.kind === 'adjustment' && l.adjustment?.type === 'duotone');
    adjSel.disabled = filSel.disabled = !doc; filSel.disabled = !l || l.kind !== 'raster';
    const p = proofLayer();
    proofOn.disabled = proofWarn.disabled = proofTac.disabled = proofProfile.disabled = !doc;
    proofOn.checked = !!p;
    if (p) { proofWarn.checked = !!p.adjustment.params.warning; if (document.activeElement !== proofTac) proofTac.value = p.adjustment.params.tac ?? 300; }
    if (p && document.activeElement !== proofProfile) proofProfile.value = p.adjustment.params.model === 'icc' ? p.adjustment.params.profile : '';
    proofTac.disabled ||= !!proofProfile.value.trim();
  }
  render();
  return { render, layerStyleDialog, duotoneDialog, filterDialog };
}
