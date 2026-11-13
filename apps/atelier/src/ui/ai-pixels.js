// The "AI pixel tools" panel (both modes): the commands each on-device pixel model unlocks. A command whose model is
// absent shows what to download instead of its button, so the app works fully with no model (rule ④).
// P61 neural filters available locally: Noise reduction and JPEG artefact removal (ai_denoise, SCUNet),
// Super zoom ×2 (ai_upscale, Swin2SR), Photo restoration (ai_restore). Skin smoothing, style transfer,
// colourize, colour transfer and the hair, skin and clothes masks are in the portrait panel
// (src/ui/ai-portrait.js). Smart portrait, makeup transfer, landscape mixer and harmonization have no
// permissive local model here and are not offered; depth blur is the depth model (ai_depth) with lens blur.
// The panel also holds keyword suggestions, find-similar, face-mesh parts and grouping, sky replacement and
// relighting.

import { h } from './dom.js';
import { PIXEL_MODELS } from '../ai/models-pixels.js';
import { imageEditRoute, readImageModel, writeImageModel } from '../ai/image-edit.js';

export function createAiPixelsPanel(root, ui) {
  const { send } = ui;
  // Download (the person's click; download_model is person-only) and Remove (remove_model) go through
  // src/ai/runtime.js, which records consent and hands these models to src/ai/pixels-ort.js. The mask panel
  // (src/ui/ai.js) lists only the mask models, so this panel owns the pixel models' rows.
  let rt = null;
  const runtime = async () => (rt ??= await import('../ai/runtime.js'));
  const status = new Map(PIXEL_MODELS.map((m) => [m.id, 'absent']));
  ui.ctx.aiProgress = (tool, n, total) => ui.say(`${tool}: tile ${n} of ${total}`);

  // Redraw only when a model's status changed: the window focus event fires when a click enters the NakliOS
  // iframe, and a redraw between mousedown and mouseup swallowed the first click on a tool (filming defect).
  const busy = new Map();
  let drawn = '';
  const sig = () => JSON.stringify([...status, ...busy, imageEditRoute()?.label ?? null]);
  async function refresh() {
    try { const r = await runtime(); await r.refresh(); for (const m of PIXEL_MODELS) status.set(m.id, r.modelStatus(m.id)); for (const id of ['detr-panoptic', 'depth-anything-v2-small']) status.set(id, r.modelStatus(id)); } catch { /* no Cache Storage: every model stays absent */ }
    if (sig() !== drawn) draw();
  }

  async function download(m) {
    busy.set(m.id, 'starting'); draw();
    try {
      await (await runtime()).downloadModel(m.id, (p) => { if (p.total) { busy.set(m.id, `${Math.round((100 * (p.loaded || 0)) / p.total)}%`); draw(); } });
      ui.say(`Downloaded ${m.label}.`);
    } catch (e) { ui.say(`Download of ${m.label} failed: ${e.message}`); }
    busy.delete(m.id); refresh();
  }
  async function remove(m) { const r = await send('remove_model', { model: m.id }); if (r.status === 'ok') ui.say(`Removed ${m.label}.`); refresh(); }

  const strength = h('input', { type: 'range', min: 0, max: 100, step: 1, value: 100, 'aria-label': 'Denoise strength' });
  const pct = h('input', { type: 'number', min: 1, max: 100, value: 25, 'aria-label': 'Expand percent', style: 'width:4.5em' });
  const dust = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Dust and scratches' });
  const fade = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Faded colour' });
  const active = () => ui.store.doc?.activeLayerId;
  const ready = (id) => status.get(id) === 'ready';
  const need = (id) => { const m = PIXEL_MODELS.find((x) => x.id === id); return h('span', { class: 'dim', title: `${m.source}. ${m.licence}: ${m.licenceUrl}` }, `Download ${m.label} above to use this.`); };
  const btn = (label, command, onclick, t) => h('button', { dataset: { command }, title: t, onclick }, label);

  const body = h('div');
  const panel = h('details', { class: 'ai-pixels' }, h('summary', {}, 'AI pixel tools (on device)'), body);
  root.append(panel);
  // A model can be downloaded or removed in the AI panel or another tab; re-read status when this opens.
  panel.addEventListener('toggle', () => { if (panel.open) refresh(); });
  addEventListener('focus', () => { if (panel.open) refresh(); });

  // ---- library and scene tools (keywords, similar, faces, sky, relight) ----
  const results = h('div', { class: 'ai-results' });
  const photoPath = () => ui.store.doc?.photo?.path ?? ui.ctx.activePhoto ?? null;
  const part = h('select', { 'aria-label': 'Face part' }, ['skin', 'eyes', 'brows', 'lips', 'mouth', 'face'].map((p) => h('option', { value: p }, p)));
  const skyPick = h('select', { 'aria-label': 'Replacement sky photo' });
  const lx = h('input', { type: 'number', min: -100, max: 200, value: 0, 'aria-label': 'Light x percent', style: 'width:4.5em' });
  const ly = h('input', { type: 'number', min: -100, max: 200, value: 0, 'aria-label': 'Light y percent', style: 'width:4.5em' });
  const show = (...kids) => results.replaceChildren(...kids);
  const prompt = h('input', { type: 'text', placeholder: 'What to paint into the selection', 'aria-label': 'Fill prompt' });
  const imgModel = h('input', { type: 'text', value: readImageModel(), placeholder: 'image model id', 'aria-label': 'Image model', style: 'width:10em', onchange: () => { writeImageModel(imgModel.value); draw(); } });
  async function suggest() {
    const p = photoPath(); if (!p) { ui.say('Open a photo first.'); return; }
    const r = await send('ai_suggest_keywords', { paths: [p] }); if (r.status !== 'ok') return;
    const words = r.result.suggestions[0].keywords;
    show(h('div', { class: 'row wrap' }, h('span', {}, `Suggested for ${p}:`), ...words.map((k) => h('button', { dataset: { command: 'set_keywords' }, title: `score ${k.score}; click to add`, onclick: () => send('set_keywords', { paths: [p], keywords: [k.keyword], mode: 'add' }).then((x) => { if (x.status === 'ok') ui.say(`Added keyword ${k.keyword}.`); }) }, `+ ${k.keyword}`)),
      words.length ? h('button', { dataset: { command: 'set_keywords' }, onclick: () => send('set_keywords', { paths: [p], keywords: words.map((k) => k.keyword), mode: 'add' }) }, 'Accept all') : h('span', { class: 'dim' }, 'nothing above 5 %')));
  }
  async function similar() {
    const p = photoPath(); if (!p) { ui.say('Open a photo first.'); return; }
    const r = await send('ai_find_similar', { path: p, limit: 12 }); if (r.status !== 'ok') return;
    show(h('div', { class: 'row wrap' }, h('span', {}, 'Most similar:'), ...r.result.similar.map((x) => h('button', { dataset: { command: 'open_photo' }, title: `cosine ${x.score}`, onclick: () => send('open_photo', { path: x.path }) }, x.path.split('/').pop()))));
  }
  async function group() {
    const r = await send('ai_group_faces', {}); if (r.status !== 'ok') return;
    show(h('div', {}, h('p', {}, `${r.result.faces} faces in ${r.result.photos} photos; closed eyes in: ${r.result.closedEyes.join(', ') || 'none'}`),
      ...r.result.groups.map((g) => { const name = h('input', { placeholder: 'Name this person', 'aria-label': `Name group ${g.group}` }); const paths = [...new Set(g.faces.map((f) => f.path))];
        return h('div', { class: 'row wrap' }, h('span', {}, `Person ${g.group}: ${paths.length} photo${paths.length > 1 ? 's' : ''}`), name,
          h('button', { dataset: { command: 'set_keywords' }, onclick: () => name.value.trim() && send('set_keywords', { paths, keywords: [name.value.trim()], mode: 'add' }) }, 'Add name as keyword')); })));
  }
  async function fillSkies() {
    const r = await ui.read('list_folder', {}); const items = r.result?.photos || r.result?.items || [];
    skyPick.replaceChildren(...items.map((x) => h('option', { value: x.path }, x.path)));
  }
  panel.addEventListener('toggle', () => { if (panel.open) fillSkies(); });

  function libraryTools() {
    return [
      h('h4', {}, 'Library and scene'),
      h('div', { class: 'row wrap' }, ready('clip-b32') ? [btn('Suggest keywords', 'ai_suggest_keywords', suggest, 'Proposes keywords for the open photo; nothing is written until you accept'), btn('Find similar', 'ai_find_similar', similar, 'Ranks the folder by likeness to the open photo')] : need('clip-b32')),
      h('div', { class: 'row wrap' }, ready('mediapipe-face') ? [part, btn('Mask face part', 'ai_face_mask', () => send('ai_face_mask', { layerId: active(), part: part.value }), 'Makes the part the selection, then a mask on the active layer'),
        ready('sface') ? btn('Group faces', 'ai_group_faces', group, 'Groups faces across the folder and lists closed eyes') : need('sface')] : need('mediapipe-face')),
      h('div', { class: 'row wrap' }, ready('detr-panoptic') ? [h('span', {}, 'Sky from'), skyPick, btn('Replace sky', 'ai_replace_sky', () => skyPick.value && send('ai_replace_sky', { skyPath: skyPick.value }), 'New "(edited)" layers; the photo is untouched')] : h('span', { class: 'dim' }, 'Download the People and sky finder in the AI panel to replace skies.')),
      h('div', { class: 'row wrap' }, ready('depth-anything-v2-small') ? [h('span', {}, 'Light at'), lx, '%', ly, '%', btn('Relight', 'ai_relight', () => { const d = ui.store.doc; if (d) send('ai_relight', { layerId: active(), light: [d.width * Number(lx.value) / 100, d.height * Number(ly.value) / 100] }); }, 'A soft-light "Relight (edited)" layer from the depth map')] : h('span', { class: 'dim' }, 'Download the Depth map model in the AI panel to relight.')),
      h('div', { class: 'row wrap' }, h('span', { title: 'Uses the endpoint and key from your own-key AI settings; the photo region is sent there' }, 'Image model for prompted fill'), imgModel,
        imageEditRoute() ? [prompt, btn('Fill selection from prompt', 'ai_generative_fill', () => prompt.value.trim() && send('ai_generative_fill', { prompt: prompt.value.trim() }), `Sends the area around the selection to ${imageEditRoute().label}`)] : h('span', { class: 'dim' }, 'Off: needs your own key turned on in AI settings and an image model here.')),
      results,
    ];
  }

  async function upscale() {
    ui.say('Upscaling ×2…');
    const r = await send('ai_upscale', {}); if (r.status !== 'ok') return;
    const { path, width, height } = r.result;
    const got = await ui.downloadExport?.(path);
    ui.say(`Wrote ${path} (${width} × ${height})${got ? ' and downloaded it' : ''}.`);
  }

  function draw() {
    drawn = sig();
    body.replaceChildren(
      h('p', { class: 'dim' }, 'Each tool writes a new layer (or, for ×2, a new file) and leaves your pixels alone. Models download only when you click Download and run on this device.'),
      ...PIXEL_MODELS.map((m) => h('div', { class: 'row wrap', dataset: { model: m.id } },
        h('span', { title: `${m.source}. Licence ${m.licence}: ${m.licenceUrl}` }, `${m.label}, ${m.licence}`),
        ready(m.id) ? h('button', { dataset: { command: 'remove_model', model: m.id }, onclick: () => remove(m) }, 'Remove')
          : h('button', { dataset: { person: 'download_model', model: m.id }, disabled: busy.has(m.id), title: `Downloads ${Math.round(m.bytes / 1e6)} MB from huggingface.co/${m.repo}`, onclick: () => download(m) }, busy.has(m.id) ? `Downloading ${busy.get(m.id)}` : 'Download'))),
      h('div', { class: 'row wrap' }, ready('scunet-denoise') ? [btn('Denoise', 'ai_denoise', () => send('ai_denoise', { layerId: active(), strength: Number(strength.value) }), 'Noise reduction and JPEG artefact removal on the active layer'), strength] : need('scunet-denoise')),
      h('div', { class: 'row wrap' }, ready('swin2sr-x2') ? btn('Upscale ×2 to file', 'ai_upscale', upscale, 'Writes exports/<title>-upscaled-x2.png') : need('swin2sr-x2')),
      h('div', { class: 'row wrap' }, ready('lama-inpaint') ? [
        btn('Remove selection', 'ai_remove', () => send('ai_remove', {}), 'Fills the selection from its surroundings'),
        btn('Expand canvas', 'ai_expand', () => send('ai_expand', { percent: Number(pct.value) }), 'Grows the canvas and fills the new border'), pct, '%',
      ] : need('lama-inpaint')),
      h('div', { class: 'row wrap' }, btn('Restore photo', 'ai_restore', () => send('ai_restore', { layerId: active(), dust: dust.checked && ready('lama-inpaint'), fade: fade.checked }), 'Faded colour needs no model; dust and scratches need LaMa'),
        h('label', {}, fade, ' faded colour'), ready('lama-inpaint') ? h('label', {}, dust, ' dust, scratches') : null),
      ...libraryTools(),
    );
  }
  draw(); refresh();
  return { refresh };
}
