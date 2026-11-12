// The "Portrait and colour filters" panel (P61 neural filters, L61 hair and skin masks). Each control appears
// only when its model is downloaded (the Download buttons live in the AI pixel tools panel, one per model);
// otherwise it says which download it needs, so the app works fully with no model. Colour transfer is
// classical and needs no model. Every filter writes one new layer above the active layer.

import { h } from './dom.js';
import { PIXEL_MODELS } from '../ai/models-pixels.js';

export function createAiPortraitPanel(root, ui) {
  const { send } = ui;
  let rt = null;
  const runtime = async () => (rt ??= await import('../ai/runtime.js'));
  const ids = ['mediapipe-multiclass', 'ddcolor-tiny', 'style-udnie'];
  const status = new Map(ids.map((id) => [id, 'absent']));
  async function refresh() {
    try { const r = await runtime(); await r.refresh(); for (const id of ids) status.set(id, r.modelStatus(id)); } catch { /* no Cache Storage: models stay absent */ }
    draw();
  }
  const ready = (id) => status.get(id) === 'ready';
  const need = (id) => { const m = PIXEL_MODELS.find((x) => x.id === id); return h('span', { class: 'dim', title: `${m.source}. ${m.licence}: ${m.licenceUrl}` }, `Download ${m.label} in AI pixel tools to use this.`); };
  const btn = (label, command, onclick, title) => h('button', { dataset: { command }, title, onclick }, label);
  const active = () => ui.store.doc?.activeLayerId;
  const range = (label, value) => h('input', { type: 'range', min: 0, max: 100, step: 1, value, 'aria-label': label });

  const part = h('select', { 'aria-label': 'Portrait part' }, ['hair', 'skin-all', 'face-skin', 'body-skin', 'clothes', 'accessories'].map((p) => h('option', { value: p }, p)));
  const refine = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Refine edge' });
  const smooth = range('Skin smoothing amount', 60);
  const ref = h('select', { 'aria-label': 'Reference photo for colour transfer' });
  const mix = range('Colour transfer amount', 100);
  const chroma = range('Colourize strength', 100);
  const style = range('Style strength', 100);

  async function fillRefs() {
    const r = await ui.read('list_folder', {}); const items = r.result?.photos || r.result?.items || [];
    ref.replaceChildren(...items.map((x) => h('option', { value: x.path }, x.path)));
  }

  const body = h('div');
  const panel = h('details', { class: 'ai-portrait' }, h('summary', {}, 'Portrait and colour filters (on device)'), body);
  root.append(panel);
  panel.addEventListener('toggle', () => { if (panel.open) { refresh(); fillRefs(); } });
  addEventListener('focus', () => { if (panel.open) refresh(); });

  function draw() {
    body.replaceChildren(
      h('p', { class: 'dim' }, 'Each filter adds one new layer above the active layer; delete it to undo the filter, or lower its opacity.'),
      h('div', { class: 'row wrap' }, ready('mediapipe-multiclass') ? [part, h('label', {}, refine, ' refine edge'),
        btn('Mask part', 'ai_face_mask', () => send('ai_face_mask', { layerId: active(), part: part.value, ...(refine.checked && part.value === 'hair' ? { refine: true } : {}) }), 'Hair, skin or clothes from the person-parsing model become a mask on the active layer')] : need('mediapipe-multiclass')),
      h('div', { class: 'row wrap' }, ready('mediapipe-multiclass') ? [btn('Smooth skin', 'ai_smooth_skin', () => send('ai_smooth_skin', { layerId: active(), amount: Number(smooth.value) }), 'Frequency separation over the skin mask, on a new layer'), smooth] : need('mediapipe-multiclass')),
      h('div', { class: 'row wrap' }, h('span', { title: 'Classical: Reinhard et al. 2001 colour statistics in CIELAB; no model' }, 'Colours from'), ref, mix,
        btn('Transfer colour', 'colour_transfer', () => ref.value && send('colour_transfer', { layerId: active(), referencePath: ref.value, amount: Number(mix.value) }), 'Matches the active layer’s colour statistics to the reference photo')),
      h('div', { class: 'row wrap' }, ready('ddcolor-tiny') ? [btn('Colourize', 'ai_colourize', () => send('ai_colourize', { layerId: active(), strength: Number(chroma.value) }), 'DDColor predicts colour; your photo’s lightness is kept'), chroma] : need('ddcolor-tiny')),
      h('div', { class: 'row wrap' }, ready('style-udnie') ? [btn('Style: Udnie', 'ai_style_transfer', () => send('ai_style_transfer', { layerId: active(), style: 'udnie', strength: Number(style.value) }), 'Repaints the layer in the style of Picabia’s Udnie (1913)'), style] : need('style-udnie')),
    );
  }
  draw();
  return { refresh };
}
