// The AI panel (spec 002 §9.4, matrix L34, P18, L33, L53, L69): each on-device model with its download name,
// licence, size and status, a Download button (the person's consent; download_model is person-only, so the
// button calls the runtime itself) and Remove (remove_model). Below, the mask buttons: in Develop they add an
// AI mask to the photo (ai_mask, a new local adjustment on a RAW photo); in Composite they make a selection
// (ai_select). A button whose model is absent says which download it needs. Depth: lens blur from the depth
// map (ai_depth) and a depth-range mask. Smart selection snaps a rough selection to edges (smart_select,
// classical, always available in Composite). Refine edge (refine_edge, P20 select and mask) turns the selection's
// edge into a soft matte: with the ViTMatte download, else classical.

import { h } from './dom.js';
import { screenToDoc } from './geometry.js';
import { downloadModel } from '../ai/runtime.js';
import { MASK_TARGETS, MASK_MODELS, MATTING_MODEL, modelById } from '../ai/registry.js';

const MB = (b) => `${Math.round(b / 1e6)} MB`;
const TARGETS = [['subject', 'Subject'], ['sky', 'Sky'], ['background', 'Background'], ['people', 'People'], ['object', 'Object (click)']];

export function createAIPanel(root, ui) {
  const { send, read, say, ctx } = ui;
  let models = [];
  const progress = new Map();   // model id → text while downloading
  let armed = null;             // target waiting for a click on the photo

  const list = h('div', { class: 'ai-models' });
  const buttons = h('div', { class: 'row wrap ai-buttons' });
  const near = h('input', { type: 'number', min: 0, max: 1, step: 0.05, value: 0.6, 'aria-label': 'Depth near (0..1, 1 nearest)', style: 'width:4.5em' });
  const far = h('input', { type: 'number', min: 0, max: 1, step: 0.05, value: 1, 'aria-label': 'Depth far (0..1)', style: 'width:4.5em' });
  const depthRow = h('div', { class: 'row wrap ai-depth' });
  const edgeBand = h('input', { type: 'number', min: 1, max: 128, step: 1, value: 12, 'aria-label': 'Refine edge band (document pixels)', style: 'width:4.5em' });
  const note = h('p', { class: 'hint ai-note' });
  root.replaceChildren(h('h3', {}, 'AI (on this device)'), list, buttons, depthRow, note);

  const doc = () => ui.store.doc;
  const dev = () => ctx.view.mode === 'develop';
  // The photo the AI acts on: the active layer, or its base photo for a local adjustment.
  function photo() {
    const d = doc(); if (!d) return null;
    let l = d.layers.find((x) => x.id === d.activeLayerId) || null;
    if (l?.localOf) l = d.layers.find((x) => x.id === l.localOf);
    if (!l || (l.kind !== 'raw' && l.kind !== 'image')) l = d.layers.find((x) => (x.kind === 'raw' || x.kind === 'image') && !x.localOf) || null;
    return l;
  }
  const ready = (target) => models.find((m) => m.id === MASK_TARGETS[target])?.status === 'ready';

  async function refresh() {
    const r = await read('list_models');
    if (r.status === 'ok') models = r.result.models.filter((m) => MASK_MODELS.some((x) => x.id === m.id));   // pixel models have their own panel
    draw();
  }

  async function download(id) {
    const m = modelById(id);
    progress.set(id, 'starting');
    draw();
    try {
      await downloadModel(id, (p) => { if (p.total) { progress.set(id, `${Math.round((100 * (p.loaded || 0)) / p.total)}% of ${p.file || 'files'}`); draw(); } });
      say(`Downloaded ${m.label}.`);
    } catch (e) { say(`Download of ${m.label} failed: ${e.message}`); }
    progress.delete(id);
    await refresh();
  }

  async function act(target, point) {
    const d = doc(); if (!d) { say('Open a photo first.'); return null; }
    if (dev()) {
      const l = photo(); if (!l) { say('AI masks work on a RAW or image layer.'); return null; }
      const r = await send('ai_mask', { layerId: l.id, target, ...(point ? { point } : {}) });
      if (r.status === 'ok') { if (r.result.maskId) ui.state.mask = r.result.maskId; say(`AI mask ${target}: ${Math.round(r.result.coverage * 1000) / 10}% of the photo.`); ui.render(); }
      return r;
    }
    const r = await send('ai_select', { target, op: 'replace', ...(point ? { point } : {}) });
    if (r.status === 'ok') say(`Selected ${target}: ${Math.round(r.result.coverage * 1000) / 10}% of the document.`);
    return r;
  }

  // Object (click): the next click on the photo is the point; Escape cancels.
  const overlay = document.getElementById('overlay');
  overlay?.addEventListener('pointerdown', (e) => {
    if (!armed || !ctx.engine) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const t = armed; armed = null; draw();
    const c = document.getElementById('canvas');
    const [x, y] = screenToDoc(ctx.engine.computeView(), c.getBoundingClientRect(), devicePixelRatio, e.clientX, e.clientY);
    act(t, [Math.round(x), Math.round(y)]);
  }, true);
  addEventListener('keydown', (e) => { if (armed && e.key === 'Escape') { armed = null; draw(); } });

  let seenStorage = null;
  function draw() {
    const st = ctx.storage?.();
    if (st !== seenStorage) { seenStorage = st; refresh().catch(() => {}); }   // the consent record lives in storage
    list.replaceChildren(...models.map((m) => {
      const busy = progress.get(m.id);
      const status = busy ? `downloading ${busy}` : m.status;
      return h('div', { class: 'ai-model', dataset: { model: m.id, status: m.status } },
        h('div', {}, h('strong', {}, m.label)),
        h('div', { class: 'dim' }, h('a', { href: m.licenceUrl, target: '_blank', rel: 'noopener' }, m.licence), ` · ${MB(m.bytes)} · ${status}`, m.error ? ` (${m.error})` : ''),
        m.status === 'ready'
          ? h('button', { dataset: { command: 'remove_model', model: m.id }, onclick: async () => { const r = await send('remove_model', { model: m.id }); if (r.status === 'ok') say(`Removed ${m.label}.`); await refresh(); } }, 'Remove')
          : h('button', { dataset: { person: 'download_model', model: m.id }, disabled: !!busy, title: `Downloads ${MB(m.bytes)} from huggingface.co/${m.source?.split('huggingface.co/')[1] ?? ''}`, onclick: () => download(m.id) }, busy ? 'Downloading…' : 'Download'));
    }));
    const hasDoc = !!doc();
    const verb = dev() ? 'Mask' : 'Select';
    buttons.replaceChildren(...TARGETS.map(([t, label]) => {
      const m = modelById(MASK_TARGETS[t]);
      if (!ready(t)) return h('button', { disabled: true, title: `Download ${m.label} first`, dataset: { target: t } }, `${label}: download ${m.label.split(' (')[0]} first`);
      const command = dev() ? 'ai_mask' : 'ai_select';
      return h('button', { dataset: { command, target: t }, class: armed === t ? 'on' : '', disabled: !hasDoc,
        onclick: () => { if (t === 'object') { armed = armed === t ? null : t; draw(); say(armed ? 'Click the object on the photo (Escape cancels).' : ''); } else act(t); } }, `${verb} ${label}`);
    }));
    const depthOk = ready('depth');
    const dm = modelById(MASK_TARGETS.depth);
    depthRow.replaceChildren(...(depthOk ? [
      h('button', { dataset: { command: 'ai_depth' }, disabled: !hasDoc, onclick: async () => { const l = photo(); if (!l) return; const r = await send('ai_depth', { layerId: l.id, ...(l.lensBlur?.aperture === undefined ? { aperture: 40 } : {}) }); if (r.status === 'ok') say(`Lens blur now uses the depth map ${r.result.depthFile}.`); } }, 'Lens blur from depth'),
      h('span', {}, 'Depth range'), near, far,
      h('button', { dataset: { command: 'ai_mask', target: 'depth-range' }, disabled: !hasDoc, onclick: async () => { const l = photo(); if (!l) return; const r = await send('ai_mask', { layerId: l.id, target: 'depth-range', near: Number(near.value), far: Number(far.value) }); if (r.status === 'ok' && r.result.maskId) { ui.state.mask = r.result.maskId; ui.render(); } } }, 'Mask depth range'),
    ] : [h('button', { disabled: true, title: `Download ${dm.label} first` }, `Depth: download ${dm.label.split(' (')[0]} first`)]),
    ...(!dev() ? [h('button', { dataset: { command: 'smart_select' }, disabled: !doc()?.selection, title: 'Snaps a rough selection to the photo edges (no model)', onclick: async () => { const r = await send('smart_select', {}); if (r.status === 'ok') say(`Snapped the selection to edges (${r.result.refinedPixels} pixels refined).`); } }, 'Snap selection to edges'),
      h('button', { dataset: { command: 'refine_edge' }, disabled: !doc()?.selection, title: models.find((m) => m.id === MATTING_MODEL)?.status === 'ready' ? 'Soft edge for hair and fur with the ViTMatte model' : `Soft edge for hair and fur by a colour guided filter; download ${modelById(MATTING_MODEL).label} for the model`, onclick: async () => { const r = await send('refine_edge', { band: Number(edgeBand.value) }); if (r.status === 'ok') say(`Refined the edge (${r.result.method}): ${r.result.softPixels} soft pixels.`); } }, 'Refine edge'),
      h('span', {}, 'band'), edgeBand] : []));
    note.textContent = 'Models download only when you click Download, run in this browser and never send your photos anywhere. Atelier works fully without them.';
  }

  refresh().catch(() => {});
  return { render: draw, refresh };
}
