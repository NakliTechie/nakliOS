// Brush engine panel (P26): brush presets from the shared asset library (library/brushes/), the engine
// settings (spacing, angle, roundness, scatter, count, jitter, pressure/tilt/velocity controls), and
// custom brushes from a selection. Applying sends set_brush, which every following paint_stroke uses;
// picking a preset also loads its size, hardness, flow and opacity into the tool options.
// Mounted in the side panel by src/ui/index.js.

import { h } from './dom.js';

const CONTROL = ['off', 'pressure', 'tilt', 'velocity'];

export function createBrushPanel(root, ui, tools) {
  const f = {};
  const num = (key, label, min, max, value) => { f[key] = h('input', { type: 'number', min, max, value, 'aria-label': label, dataset: { view: `brush:${key}` } }); return h('label', { class: 'opt' }, label, f[key]); };
  const sel = (key, label, opts) => { f[key] = h('select', { 'aria-label': label, dataset: { view: `brush:${key}` } }, opts.map((o) => h('option', { value: o }, o))); return h('label', { class: 'opt' }, label, f[key]); };
  const preset = h('select', { 'aria-label': 'Brush preset', dataset: { command: 'list_brushes' }, onchange: () => pick() }, h('option', { value: '' }, 'Round (no preset)'));
  const grid = h('div', { class: 'brush-grid' },
    num('spacing', 'Spacing %', 1, 1000, 25), num('angle', 'Angle°', -360, 360, 0), num('roundness', 'Roundness %', 1, 100, 100),
    num('scatter', 'Scatter %', 0, 1000, 0), num('count', 'Count', 1, 16, 1),
    num('jSize', 'Size jitter %', 0, 100, 0), num('jOpacity', 'Opacity jitter %', 0, 100, 0), num('jAngle', 'Angle jitter %', 0, 100, 0),
    sel('cSize', 'Size from', CONTROL), sel('cOpacity', 'Opacity from', CONTROL), sel('cFlow', 'Flow from', CONTROL), sel('cAngle', 'Angle from', ['off', 'direction', 'tilt']),
    num('mSize', 'Min size %', 0, 100, 0));
  const read = () => ({
    spacing: +f.spacing.value, angle: +f.angle.value, roundness: +f.roundness.value, scatter: +f.scatter.value, count: +f.count.value,
    jitter: { size: +f.jSize.value, opacity: +f.jOpacity.value, angle: +f.jAngle.value },
    control: { size: f.cSize.value, opacity: f.cOpacity.value, flow: f.cFlow.value, angle: f.cAngle.value }, min: { size: +f.mSize.value },
  });
  const fill = (b) => {
    const set = (k, v) => { if (v !== undefined) f[k].value = v; };
    set('spacing', b.spacing); set('angle', b.angle); set('roundness', b.roundness); set('scatter', b.scatter); set('count', b.count);
    set('jSize', b.jitter?.size); set('jOpacity', b.jitter?.opacity); set('jAngle', b.jitter?.angle);
    set('cSize', b.control?.size); set('cOpacity', b.control?.opacity); set('cFlow', b.control?.flow); set('cAngle', b.control?.angle); set('mSize', b.min?.size);
  };
  let list = [];
  async function refresh() {
    const r = await ui.read('list_brushes');
    if (r.status !== 'ok') return;
    list = r.result.brushes;
    const cur = preset.value;
    preset.replaceChildren(h('option', { value: '' }, 'Round (no preset)'), ...list.map((b) => h('option', { value: b.name }, `${b.name}${b.tip ? ' (tip)' : ''}`)));
    preset.value = list.some((b) => b.name === cur) ? cur : '';
  }
  function pick() {
    const b = list.find((x) => x.name === preset.value);
    if (!b) return;
    fill(b);
    for (const k of ['size', 'hardness', 'flow', 'opacity']) if (Number.isFinite(b[k])) tools.opt[k] = b[k];
    tools.drawBar();
  }
  async function apply() {
    const r = await ui.send('set_brush', { ...(preset.value ? { preset: preset.value } : {}), brush: read() });
    if (r.status === 'ok') ui.say(`Brush set${preset.value ? ` (${preset.value})` : ''}; strokes use it until you reset.`);
  }
  async function save(fromSelection) {
    const name = (await ui.dialogs.promptText(fromSelection ? 'Define brush from selection' : 'Save brush preset', 'Name'))?.trim();
    if (!name) return;
    const r = await ui.send('save_brush_preset', { name, size: tools.opt.size, hardness: tools.opt.hardness, flow: tools.opt.flow, opacity: Math.max(1, tools.opt.opacity), brush: read(), ...(fromSelection ? { fromSelection: true } : {}), ...(list.some((b) => b.name === name) ? { replace: true } : {}) });
    if (r.status === 'ok') { ui.say(`Saved ${r.result.path}${r.result.tip ? ` with a ${r.result.tip.width} × ${r.result.tip.height} tip` : ''}.`); await refresh(); preset.value = name; }
  }
  root.replaceChildren(h('details', { class: 'brush-panel' },
    h('summary', { dataset: { view: 'brush-panel' }, onclick: () => refresh() }, 'Brush engine'),
    h('div', { class: 'row' }, preset, h('button', { dataset: { command: 'list_brushes' }, onclick: () => refresh(), title: 'Reload presets from the library' }, '↻')),
    grid,
    h('div', { class: 'row' },
      h('button', { class: 'primary', dataset: { command: 'set_brush' }, onclick: apply }, 'Apply'),
      h('button', { dataset: { command: 'set_brush' }, onclick: async () => { const r = await ui.send('set_brush', { reset: true }); if (r.status === 'ok') { preset.value = ''; ui.say('Round brush.'); } } }, 'Reset'),
      h('button', { dataset: { command: 'save_brush_preset' }, onclick: () => save(false) }, 'Save preset…'),
      h('button', { dataset: { command: 'save_brush_preset' }, title: 'Dark pixels of the active raster layer inside the selection become the brush tip', onclick: () => save(true) }, 'From selection…'))));
  return { refresh };
}
