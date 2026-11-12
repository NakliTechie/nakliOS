// Side-panel sections for the second views batch: Actions (record, replay, batch), Recipes (auto develop,
// red eye, frequency separation, film looks), Channels, AI (describe and rate, edit assistant, own-key
// settings) and Plugins. Every control sends a manifest command through ui.send / ui.read, except the AI key
// settings, which are the person's own and never reach a command.

import { h } from './dom.js';
import { decodeJpeg } from './compare.js';
import { readByok, writeByok, forgetByok, textAi } from '../ai/text.js';

const section = (label, title, ...kids) => h('details', { class: 'views-section', dataset: { viewLabel: label } }, h('summary', {}, title), ...kids);

export function createRecipes(aside, ui, { viewer, selection }) {
  const say = (r, ok) => { if (r.status === 'ok') ui.say(typeof ok === 'function' ? ok(r.result) : ok); return r; };

  // ---- Actions ----
  const actList = h('div', { class: 'stack' }); const recBtn = h('button', { dataset: { command: 'record_action' } }, 'Record…');
  recBtn.onclick = async () => {
    const st = await ui.read('list_actions');
    if (st.result?.recording) { const r = await ui.send('record_action', { action: 'stop' }); say(r, (x) => `Saved ${x.path} (${x.steps.length} steps).`); refreshActions(); return; }
    const name = await ui.dialogs.promptText('Record an action', 'Action name', 'My action');
    if (name) { const r = await ui.send('record_action', { action: 'start', name }); say(r, `Recording ${name}: edit as usual, then press Stop recording.`); refreshActions(); }
  };
  async function refreshActions() {
    const r = await ui.read('list_actions'); if (r.status !== 'ok') { actList.replaceChildren(h('p', { class: 'hint' }, r.error?.message ?? r.status)); return; }
    recBtn.textContent = r.result.recording ? `Stop recording (${r.result.recording.steps} steps)` : 'Record…';
    actList.replaceChildren(...(r.result.actions.length ? r.result.actions.map((a) => h('div', { class: 'row' }, h('span', { class: 'grow', title: (a.commands || []).join(' → ') }, `${a.name} · ${a.steps} steps`),
      h('button', { dataset: { command: 'run_action' }, onclick: async () => { const x = await ui.send('run_action', { name: a.path }); say(x, (o) => (o.ok ? `${a.name}: ${o.done.length} steps applied.` : `${a.name} stopped at step ${o.failed.step} (${o.failed.command}: ${o.failed.message ?? o.failed.status}).`)); } }, 'Run'),
      h('button', { dataset: { command: 'run_action' }, title: 'Run on the photos selected in the filmstrip', onclick: async () => { const paths = selection(); if (!paths.length) { ui.say('Select photos in the filmstrip first.'); return; } const x = await ui.send('run_action', { name: a.path, paths }); say(x, (o) => `${a.name}: ${o.photos.length - o.failedCount} of ${o.photos.length} photos done${o.failedCount ? `; failed: ${o.photos.filter((p) => !p.ok).map((p) => p.path.split('/').pop()).join(', ')}` : ''}.`); } }, 'Batch'))) : [h('p', { class: 'hint' }, 'No actions yet.')]));
  }
  const actions = section('Actions: record, run, batch over selected photos', 'Actions', h('div', { class: 'row' }, recBtn), actList);
  actions.addEventListener('toggle', () => { if (actions.open) refreshActions(); });

  // ---- Recipes ----
  const radius = h('input', { type: 'number', min: 0.5, max: 100, step: 0.5, value: 4, 'aria-label': 'Blur radius (px)', style: 'width:64px' });
  const active = () => ui.ctx.store.doc?.activeLayerId;
  const recipes = section('Recipes: auto tone and white balance, red eye, frequency separation, film looks', 'Recipes',
    h('div', { class: 'row wrap' },
      h('button', { dataset: { command: 'auto_develop' }, onclick: async () => say(await ui.send('auto_develop', {}), (x) => `Auto: ${Object.entries(x.applied).map(([k, v]) => `${k} ${v}`).join(', ')} (one undo step).`) }, 'Auto tone + WB'),
      h('button', { dataset: { command: 'auto_develop' }, onclick: async () => say(await ui.send('auto_develop', { tone: false }), 'Auto white balance applied.') }, 'Auto WB')),
    h('div', { class: 'row wrap' },
      h('button', { dataset: { command: 'fix_red_eye' }, title: 'Draw a rectangle selection around one eye first (Composite mode)', onclick: async () => {
        const b = ui.ctx.store.doc?.selection?.bounds; if (!b) { ui.say('Draw a rectangle selection around one eye, then press Red eye.'); return; }
        say(await ui.send('fix_red_eye', { rect: { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] } }), (x) => `Red eye: ${x.pixels} pixels corrected on layer "${x.layer.name}".`);
      } }, 'Red eye in selection')),
    h('div', { class: 'row wrap' }, h('span', { class: 'dim' }, 'Radius'), radius,
      h('button', { dataset: { command: 'frequency_separation' }, onclick: async () => { if (!active()) { ui.say('Pick a pixel layer first.'); return; } say(await ui.send('frequency_separation', { layerId: active(), radius: Number(radius.value) }), 'Frequency separation: low and high layers added in a group.'); } }, 'Frequency separation')),
    h('div', { class: 'row wrap' }, h('button', { dataset: { command: 'install_looks' }, onclick: async () => { const r = await ui.send('install_looks'); say(r, (x) => `Film looks: ${x.written.length} added, ${x.kept.length} already there. They are in the preset menu.`); ui.develop?.refreshPresets?.(); ui.views?.presets?.refresh?.(true); } }, 'Add the film looks pack')));

  // ---- Channels ----
  const chGrid = h('div', { class: 'pp-grid' }); const chNote = h('p', { class: 'hint' });
  async function refreshChannels() {
    if (!ui.ctx.store.doc) { chGrid.replaceChildren(); chNote.textContent = 'Open a photo or document.'; return; }
    const r = await ui.read('get_channels', { maxEdge: 160 }); if (r.status !== 'ok') { chNote.textContent = r.error?.message ?? r.status; return; }
    const cell = async (label, p, onclick) => { const c = h('canvas', { width: r.result.width, height: r.result.height }); c.getContext('2d').drawImage(await decodeJpeg(p), 0, 0); return h('button', { class: 'pp-cell', title: `View ${label}`, dataset: { command: 'get_channels' }, onclick }, c, h('span', {}, label)); };
    const view = (label, args) => async () => { const x = await ui.read('get_channels', { maxEdge: 1024, ...args }); if (x.status !== 'ok') return; const item = args.channel ? x.result.channels[0] : x.result.alphaChannels.find((a) => a.name === args.name); viewer.show(label, [{ label, bitmap: await decodeJpeg(item) }], { note: 'one channel as grey; Esc closes' }); };
    chGrid.replaceChildren(...await Promise.all([
      ...r.result.channels.map((c) => cell(c.channel[0].toUpperCase() + c.channel.slice(1), c, view(`${c.channel} channel`, { channel: c.channel }))),
      ...r.result.alphaChannels.map((a) => cell(`α ${a.name}`, a, view(`Alpha channel ${a.name}`, { name: a.name }))),
    ]));
    chNote.textContent = `${r.result.alphaChannels.length} alpha channel${r.result.alphaChannels.length === 1 ? '' : 's'} (saved selections).`;
  }
  const loadSel = h('select', { 'aria-label': 'Alpha channel to load', dataset: { command: 'refine_selection' } });
  const channels = section('Channels panel (R, G, B, alpha; alpha channels from selections)', 'Channels', chGrid, chNote,
    h('div', { class: 'row wrap' },
      h('button', { dataset: { command: 'refine_selection' }, onclick: async () => { const name = await ui.dialogs.promptText('Save selection as channel', 'Channel name', 'Alpha 1'); if (name) { say(await ui.send('refine_selection', { action: 'save', name }), `Saved the selection as alpha channel ${name}.`); refreshChannels(); fillLoad(); } } }, 'Save selection as channel'),
      loadSel,
      h('button', { dataset: { command: 'refine_selection' }, onclick: async () => { if (!loadSel.value) return; say(await ui.send('refine_selection', { action: 'load', name: loadSel.value }), `Loaded ${loadSel.value} as the selection.`); } }, 'Load as selection')));
  function fillLoad() { loadSel.replaceChildren(...Object.keys(ui.ctx.store.doc?.savedSelections || {}).map((n) => h('option', { value: n }, n))); }
  channels.addEventListener('toggle', () => { if (channels.open) { refreshChannels(); fillLoad(); } });

  // ---- AI (removable) ----
  const ai = textAi();
  const aiOut = h('div', { class: 'stack' }); const instr = h('input', { type: 'text', placeholder: 'Optional: what you want (e.g. warmer, moodier)', 'aria-label': 'Instruction for the assistant' });
  const aiControls = h('div', { class: 'stack' },
    h('div', { class: 'row wrap' },
      h('button', { dataset: { command: 'ai_describe' }, onclick: () => describe() }, 'Describe and rate'),
      h('button', { dataset: { command: 'ai_suggest_develop' }, onclick: async () => say(await ui.send('ai_suggest_develop', { instruction: instr.value || undefined }), (x) => `Assistant applied ${Object.entries(x.applied).map(([k, v]) => `${k} ${v}`).join(', ')} (one undo step).`) }, 'Suggest develop')),
    instr, aiOut);
  async function describe() {
    const path = ui.ctx.store.doc?.photo?.path ?? ui.ctx.activePhoto; if (!path) { ui.say('Open a photo first.'); return; }
    aiOut.replaceChildren(h('p', { class: 'hint' }, 'Asking the AI…'));
    const r = await ui.read('ai_describe', { path });
    if (r.status !== 'ok') { aiOut.replaceChildren(h('p', { class: 'hint' }, r.error?.message ?? r.status)); return; }
    const s = r.result.suggestion;
    aiOut.replaceChildren(h('p', {}, s.caption || '(no caption)'), h('p', { class: 'dim' }, `Keywords: ${s.keywords.join(', ') || 'none'} · Rating: ${s.rating ?? 'none'} · ${r.result.model}`),
      h('div', { class: 'row' }, h('button', { class: 'primary', dataset: { command: 'set_keywords' }, onclick: async () => {
        if (s.keywords.length) await ui.send('set_keywords', { paths: [path], keywords: s.keywords, mode: 'add' });
        if (s.rating) await ui.send('set_rating', { paths: [path], rating: s.rating });
        if (s.caption) await ui.send('set_caption', { paths: [path], caption: s.caption });
        ui.say('Accepted the AI suggestion.'); aiOut.replaceChildren(); ui.filmstrip?.refresh?.();
      } }, 'Accept'), h('button', { onclick: () => aiOut.replaceChildren() }, 'Dismiss')));
  }
  const byok = readByok();
  const ep = h('input', { type: 'text', value: byok.endpoint || '', placeholder: 'https://…/v1', 'aria-label': 'Endpoint (OpenAI-compatible)' });
  const model = h('input', { type: 'text', value: byok.model || '', placeholder: 'model id', 'aria-label': 'Model' });
  const key = h('input', { type: 'password', value: byok.key || '', autocomplete: 'off', 'aria-label': 'API key' });
  const on = h('input', { type: 'checkbox', checked: !!byok.enabled });
  const aiStatus = h('p', { class: 'hint' });
  const settings = h('details', {}, h('summary', {}, 'Use your own AI key'),
    h('p', { class: 'hint' }, 'Off by default. The key stays in this browser only; photos you describe are sent to the endpoint you enter.'),
    h('label', { class: 'check' }, on, 'Turn on'), h('label', { class: 'field' }, h('span', {}, 'Endpoint'), ep), h('label', { class: 'field' }, h('span', {}, 'Model'), model), h('label', { class: 'field' }, h('span', {}, 'Key'), key),
    h('div', { class: 'row' }, h('button', { dataset: { person: 'ai_settings' }, onclick: () => { writeByok({ enabled: on.checked, endpoint: ep.value, model: model.value, key: key.value }); render(); } }, 'Save'),
      h('button', { dataset: { person: 'ai_settings' }, onclick: () => { forgetByok(); on.checked = false; key.value = ''; render(); } }, 'Forget key')));
  const aiSec = section('AI: describe and rate, develop assistant (host AI or your own key)', 'AI assistant', aiStatus, aiControls, settings);

  // ---- Plugins ----
  const plList = h('div', { class: 'stack' });
  async function refreshPlugins() {
    const r = await ui.read('list_plugins'); if (r.status !== 'ok') { plList.replaceChildren(h('p', { class: 'hint' }, r.error?.message ?? r.status)); return; }
    plList.replaceChildren(...(r.result.plugins.length ? r.result.plugins.map((p) => (p.error ? h('p', { class: 'hint' }, `${p.path}: ${p.error}`) : h('div', { class: 'row' }, h('span', { class: 'grow', title: `calls ${p.commands.join(', ')}` }, p.name),
      h('button', { dataset: { command: 'run_plugin' }, onclick: async () => { const x = await ui.send('run_plugin', { name: p.name }); say(x, (o) => `${p.name}: ${o.state}${o.error ? ` (${o.error})` : ''}; ${o.calls.length} calls.`); } }, 'Run')))) : [h('p', { class: 'hint' }, 'No plugins. A plugin is plugins/<name>/plugin.json plus its script.')]));
  }
  const plugins = section('Plugins: run a workspace plugin', 'Plugins', plList);
  plugins.addEventListener('toggle', () => { if (plugins.open) refreshPlugins(); });

  aside.append(actions, recipes, channels, aiSec, plugins);

  function render() {
    aiControls.hidden = !ai.available;
    aiStatus.textContent = ai.available ? `AI: ${ai.label} (${ai.route}).` : 'No AI is set up. Atelier works fully without it.';
    const rev = ui.ctx.bus.state.revision;
    if (channels.open && rev !== chRev) { chRev = rev; refreshChannels(); }
  }
  let chRev = -1;
  render();
  return { render, refreshActions, refreshChannels, refreshPlugins, describe, get aiAvailable() { return ai.available; } };
}
