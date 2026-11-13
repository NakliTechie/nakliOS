// Mounts the UI: header, tool bar and options, canvas input, the Develop and Composite panels, the
// filmstrip, the staged-actions bar, notices and the Export dialog. Every control dispatches a manifest
// command through the bus as door 'ui' (src/ui/send.js); the parity table is src/ui/parity.js.
// The UI reads the open document from the store to draw itself and changes it only through commands.

import { h, $ } from './dom.js';
import { createDialogs } from './dialog.js';
import { createSender, plainError } from './send.js';
import { createDevelopPanel } from './develop.js';
import { createFilmstrip } from './filmstrip.js';
import { createLayersPanel } from './layers.js';
import { createTools, isTyping } from './tools.js';
import { createExport } from './export.js';
import { zoomAt } from './geometry.js';
import { createFillButton, createSmartMenu } from './heal.js';
import { mountViews } from './views.js';
import { createAiPixelsPanel } from './ai-pixels.js';
import { createAiPortraitPanel } from './ai-portrait.js';
import { createAIPanel } from './ai.js';
import { createMergeButton } from './merge.js';
import { createTetherControls } from './tether.js';
import { createVectorPanel } from './vector.js';
import { createBrushPanel } from './brushes.js';
import { createTimelinePanel } from './timeline.js';
import { createEngineUI } from './engine-ui.js';

const COPY_PANELS = [['basic', 'Basic'], ['curve', 'Tone curve'], ['mixer', 'Colour mixer'], ['grading', 'Colour grading'], ['effects', 'Effects']];

export function mountUI({ bus, ctx, manifest, engineError, grantFolder, importFiles, runStaged, hostCaps }) {
  const dialogs = createDialogs();
  const status = $('#status');
  let lastNote = '';
  // Feedback goes to the status bar and, within 4 s of a click or key press on a control, also to a short
  // toast beside that control, so the answer appears where the person is looking.
  let lastControl = null; let lastAt = 0;
  const mark = (c) => { if (c) { lastControl = c; lastAt = performance.now(); } };
  addEventListener('pointerdown', (e) => mark(e.target.closest?.('button, select, summary, label, [role=option]')), true);
  addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') mark(document.activeElement?.closest?.('button, select, summary')); }, true);
  const toastEl = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite', hidden: true });
  document.body.append(toastEl);
  let toastTimer = 0;
  function toast(t) {
    const c = lastControl;
    if (!t || !c?.isConnected || performance.now() - lastAt > 4000 || !c.getClientRects().length) return;
    toastEl.textContent = t; toastEl.hidden = false;
    const r = c.getBoundingClientRect(); const w = toastEl.offsetWidth; const hgt = toastEl.offsetHeight;
    const below = r.bottom + 6 + hgt < innerHeight;
    toastEl.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    toastEl.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - hgt - 6)}px`;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, 5000);
  }
  const say = (t) => { lastNote = t; status.textContent = t; toast(t); };
  const sender = createSender({ bus, onReply: (name, r, { quiet }) => {
    if (r.status === 'ok') { if (!quiet) lastNote = ''; return; }
    if (r.status === 'staged') { say('This waits for your Confirm in the bar below.'); return; }
    if (!quiet || r.status !== 'unsupported') say(plainError(r));
  } });

  const ui = {
    manifest, ctx, store: ctx.store, dialogs, say, state: { mask: null },
    send: sender.send, read: sender.read, latest: sender.latest,
    render: () => render(), flush: () => ctx.flush?.(),
    setTool: (t) => tools.setTool(t),
    openPhoto: (path) => sender.send('open_photo', { path }),
    copySettings, pasteSettings, syncSettings,
  };

  // ---- header ----
  const modeBtn = (mode, label, key) => h('button', { class: 'mode', dataset: { command: 'set_view', mode }, title: key, onclick: () => setMode(mode) }, label);
  const modes = h('div', { class: 'seg', role: 'group', 'aria-label': 'Mode' }, modeBtn('develop', 'Develop', 'Ctrl+1'), modeBtn('composite', 'Composite', 'Ctrl+2'));
  const storageLabel = h('span', { class: 'dim', id: 'storage' });
  const saveState = $('#save-state');
  const header = $('header');
  // Open photo…: the browser's file picker for one or more photos, copied into Atelier's storage and opened.
  const ACCEPT = '.jpg,.jpeg,.png,.webp,.avif,.gif,.tif,.tiff,.psd,.arw,.nef,.cr2,.cr3,.dng,.raf,.orf,.rw2,image/*';
  const photoInput = h('input', { type: 'file', accept: ACCEPT, multiple: true, hidden: true, 'aria-label': 'Photo file', onchange: async (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) await importFiles(f); render(); } });
  const openPhotoPicker = () => photoInput.click();
  const folderLabel = () => (hostCaps().hosted && hostCaps().fs ? 'Storage…' : 'Open folder');
  header.replaceChildren(
    h('h1', {}, 'Atelier'), modes,
    h('button', { dataset: { command: 'undo' }, title: 'Ctrl+Z', onclick: () => sender.send('undo') }, 'Undo'),
    h('button', { dataset: { command: 'redo' }, title: 'Ctrl+Shift+Z', onclick: () => sender.send('redo') }, 'Redo'),
    h('span', { class: 'grow' }), storageLabel,
    h('button', { dataset: { command: 'open_photo' }, title: 'Open one or more photos from your disk (or drop them on the canvas)', onclick: openPhotoPicker }, 'Open photo…'), photoInput,
    h('button', { dataset: { person: 'grant_folder' }, title: 'Choose a folder on your disk for photos and documents', onclick: () => grantFolder() }, folderLabel()),
    h('button', { dataset: { command: 'new_document' }, onclick: newDocument }, 'New'),
    h('button', { dataset: { command: 'save_document' }, title: 'Ctrl+S (Atelier also saves on its own)', onclick: () => saveNow() }, 'Save'),
    h('button', { class: 'primary', dataset: { command: 'export_image' }, onclick: () => openExport() }, 'Export…'),
  );

  const fillBtn = createFillButton(ui); header.insertBefore(fillBtn, header.querySelector('.grow'));   // content-aware fill (P41)
  async function setMode(mode) { await sender.send('set_view', { mode }); tools.drawBar(); render(); }

  async function newDocument() {
    const w = h('input', { type: 'number', min: 1, max: 65535, value: 3000, 'aria-label': 'Width' });
    const hh = h('input', { type: 'number', min: 1, max: 65535, value: 2000, 'aria-label': 'Height' });
    const bg = h('select', { 'aria-label': 'Background' }, ['white', 'black', 'transparent'].map((b) => h('option', { value: b }, b)));
    const v = await dialogs.raw({ title: 'New document', body: h('div', { class: 'form' }, h('label', { class: 'field' }, h('span', {}, 'Width (px)'), w), h('label', { class: 'field' }, h('span', {}, 'Height (px)'), hh), h('label', { class: 'field' }, h('span', {}, 'Background'), bg)),
      actions: [{ label: 'Cancel', value: null }, { label: 'Create', primary: true, value: () => ({ width: Math.round(Number(w.value)), height: Math.round(Number(hh.value)), background: bg.value }) }] });
    if (!v) return;
    const r = await sender.send('new_document', v);
    if (r.status === 'ok' && ctx.view.mode !== 'composite') await setMode('composite');
  }
  // The first Save of a document asks for its name (a single RAW photo saves to its sidecar instead);
  // after that, Save and autosave write to that name.
  async function saveNow() {
    const doc = ctx.store.doc;
    if (!doc) { say('Nothing to save: no document is open.'); return; }
    const sidecar = doc.layers.length === 1 && doc.layers[0].kind === 'raw';
    let args = {};
    if (!sidecar && !doc.path) {
      const name = h('input', { type: 'text', value: (doc.title || 'Untitled').replace(/\.[^.]+$/, ''), 'aria-label': 'Document name', autofocus: true });
      const v = await dialogs.raw({ title: 'Save document', body: h('div', { class: 'form' }, h('label', { class: 'field' }, h('span', {}, 'Name'), name), h('p', { class: 'hint' }, `Saved as documents/<name>.atelier in ${ctx.storage()?.label ?? 'your storage'}. Atelier keeps saving it there as you work.`)),
        actions: [{ label: 'Cancel', value: null }, { label: 'Save', primary: true, value: () => name.value.trim().replace(/[\\/:*?"<>|]/g, '_') }] });
      if (v == null) return;
      if (!v) { say('Give the document a name to save it.'); return; }
      args = { path: `documents/${v}.atelier` };
    }
    try { await ctx.flush?.(); } catch (e) { say(`Save failed: ${e.message}`); return; }
    const r = await sender.send('save_document', args);
    if (r.status === 'ok') say(`Saved ${r.result.path}.`);
  }
  const openExport = createExport(ui);

  // ---- develop settings clipboard ----
  async function choosePanels(title) {
    const boxes = COPY_PANELS.map(([k, t]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, value: k }), t));
    const v = await dialogs.raw({ title, body: h('div', { class: 'form' }, boxes, h('p', { class: 'hint' }, 'White balance, detail, lens and calibration are not rendered yet, so they are not offered.')),
      actions: [{ label: 'Cancel', value: null }, { label: 'Copy', primary: true, value: () => boxes.map((b) => b.firstChild).filter((i) => i.checked).map((i) => i.value) }] });
    return v && v.length ? v : null;
  }
  async function copySettings() {
    const l = develop.layer; if (!l) { say('Open a RAW photo to copy its settings.'); return null; }
    const panels = await choosePanels('Copy settings');
    if (!panels) return null;
    const r = await sender.send('copy_settings', { layerId: l.id, panels });
    if (r.status === 'ok') say(`Copied ${Object.keys(r.result.copied).length} settings.`);
    return r;
  }
  async function pasteSettings() {
    const paths = filmstrip.selected.length > 1 ? filmstrip.selected : ctx.activePhoto ? [ctx.activePhoto] : [];
    if (!paths.length) { say('Select photos in the filmstrip, or open one, to paste onto.'); return null; }
    const r = await sender.send('sync_settings', { paths });
    if (r.status === 'ok') { say(`Pasted settings onto ${paths.length} photo${paths.length > 1 ? 's' : ''}.`); filmstrip.refresh(); }
    return r;
  }
  async function syncSettings() {
    const others = filmstrip.selected.filter((p) => p !== ctx.activePhoto);
    if (!develop.layer || !others.length) { say('Open a RAW photo, then Ctrl-click the photos to sync it to.'); return null; }
    const c = await copySettings(); if (!c || c.status !== 'ok') return c;
    const r = await sender.send('sync_settings', { paths: others });
    if (r.status === 'ok') { say(`Synced to ${others.length} photo${others.length > 1 ? 's' : ''}.`); filmstrip.refresh(); }
    return r;
  }

  // ---- panels ----
  const devRoot = $('#develop-panel'); const layRoot = $('#layers-panel');
  const develop = createDevelopPanel(devRoot, ui); ui.develop = develop;
  const layers = createLayersPanel(layRoot, ui);
  const engineUI = createEngineUI(layRoot, ui);   // layer styles, adjustments, filters, soft proof
  const smartSel = createSmartMenu(ui, () => layers.picked); header.insertBefore(smartSel, header.querySelector('.grow'));   // smart objects (P12, P13)
  ui.aiPixels = createAiPixelsPanel($('aside'), ui);
  ui.aiPortrait = createAiPortraitPanel($('aside'), ui);   // portrait and colour filters, hair and skin masks (P61, L61)
  const aiMasks = createAIPanel($('#ai-panel'), ui); ui.aiMasks = aiMasks;
  ui.vector = createVectorPanel($('#vector-panel'), ui);   // pen, paths, vector masks, shapes, rich type, artboards (P08, P32–P35, P56)
  const filmstrip = createFilmstrip($('#filmstrip'), ui); ui.filmstrip = filmstrip;
  const mergeBtn = createMergeButton(ui); header.insertBefore(mergeBtn, header.querySelector('.grow'));   // HDR, panorama, focus stack (L44–L46)
  const tetherEl = createTetherControls(ui); if (tetherEl) header.insertBefore(tetherEl, header.querySelector('.grow'));   // tethered capture (L50)
  const tools = createTools({ bar: $('#toolbar'), options: $('#options'), stage: $('#stage'), canvas: $('#canvas'), overlay: $('#overlay'), ui });
  ui.brushes = createBrushPanel($('#brush-panel'), ui, tools);   // brush engine v2 and presets (P26)
  ui.timeline = createTimelinePanel($('#timeline-panel'), ui);   // timeline, animation, video layers (P58)

  // ---- staged actions (the person's Confirm or Discard) and notices ----
  const stagedBar = $('#staged');
  stagedBar.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-staged]'); if (!b) return;
    if (b.dataset.decision === 'confirm') {
      const job = await runStaged(b.dataset.staged);
      if (job?.state === 'done' && /^export_/.test(job.tool) && job.result?.path) await ui.downloadExport(job.result.path);
      say(!job ? 'That action is gone.' : job.state === 'done' ? `Done${job.result?.path ? `: ${job.result.path}` : ''}.` : `That did not finish${job.error ? `: ${job.error}` : ''}.`);
    } else { ctx.staged.delete(b.dataset.staged); say('Discarded.'); }
    render();
  });
  const noticeBox = $('#notice');
  ui.notice = (text, actions = []) => {
    noticeBox.hidden = !text;
    noticeBox.replaceChildren(...(text ? [h('span', {}, text), ...actions.map((a) => h('button', { dataset: { person: 'notice' }, onclick: () => a.run() }, a.label))] : []));
  };
  ui.saveState = (s, info) => {
    saveState.textContent = { saved: 'Saved', unsaved: 'Unsaved changes', saving: 'Saving…', paused: 'Saving paused', error: 'Save failed, retrying' }[s] || '';
    saveState.dataset.state = s; saveState.title = info?.error || info?.path || '';
  };

  // ---- empty state and dropping photos on the canvas ----
  const stage = $('#stage');
  const empty = h('div', { id: 'empty', role: 'region', 'aria-label': 'Start' },
    h('h2', {}, 'Open a photo to start'),
    h('p', {}, 'Drop photos here, or choose one.'),
    h('div', { class: 'row wrap empty-actions' },
      h('button', { class: 'primary', dataset: { command: 'open_photo' }, onclick: openPhotoPicker }, 'Open photo…'),
      h('button', { dataset: { person: 'grant_folder' }, onclick: () => grantFolder() }, folderLabel()),
      h('button', { dataset: { command: 'new_document' }, onclick: newDocument }, 'New document')),
    h('dl', {},
      h('dt', {}, 'Develop'), h('dd', {}, 'Adjust one photo: exposure, white balance, colour, tone curve and lens. Best with camera RAW files.'),
      h('dt', {}, 'Composite'), h('dd', {}, 'Build a picture from layers, masks, adjustments and type.')),
    h('p', { class: 'hint', id: 'empty-storage' }));
  const loadingEl = h('div', { id: 'loading', role: 'status', hidden: true });
  stage.append(empty, loadingEl);
  ui.loading = (text) => { loadingEl.textContent = text || ''; loadingEl.hidden = !text; render(); };
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  stage.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; stage.classList.add('drop-target'); });
  stage.addEventListener('dragleave', (e) => { if (!stage.contains(e.relatedTarget)) stage.classList.remove('drop-target'); });
  stage.addEventListener('drop', async (e) => { if (!hasFiles(e)) return; e.preventDefault(); stage.classList.remove('drop-target'); await importFiles(e.dataTransfer.files); render(); });
  // A file dropped anywhere else would make the browser navigate away from Atelier; refuse it there.
  addEventListener('dragover', (e) => { if (hasFiles(e) && !stage.contains(e.target)) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; } });
  addEventListener('drop', (e) => { if (hasFiles(e) && !stage.contains(e.target)) e.preventDefault(); });

  // ---- keyboard ----
  addEventListener('keydown', async (e) => {
    if (dialogs.open || isTyping(e)) return;
    const mod = e.metaKey || e.ctrlKey; const k = e.key.toLowerCase(); const dev = ctx.view.mode === 'develop';
    const run = (f) => { e.preventDefault(); f(); };
    if (mod) {
      if (k === '1') return run(() => setMode('develop'));
      if (k === '2') return run(() => setMode('composite'));
      if (k === 'z' && !e.shiftKey) return run(() => sender.send('undo'));
      if ((k === 'z' && e.shiftKey) || k === 'y') return run(() => sender.send('redo'));
      if (k === 's') return run(() => saveNow());
      if (k === '0' && ctx.store.doc) return run(() => sender.send('set_view', tools.fitView()));
      if ((k === '=' || k === '+' || k === '-') && ctx.store.doc && ctx.engine) return run(() => { const v = ctx.engine.computeView(); const c = $('#canvas'); sender.send('set_view', zoomAt(v, k === '-' ? 0.5 : 2, v.x0 + c.width / (2 * v.scale), v.y0 + c.height / (2 * v.scale), c.width, c.height)); });
      if (k === 'c' && e.shiftKey) return run(() => copySettings());
      if (k === 'v' && e.shiftKey) return run(() => pasteSettings());
      if (dev && k === 'e' && e.shiftKey) return run(() => openExport());
      if (!dev) {
        const act = ctx.store.doc?.activeLayerId;
        if (k === 'j' && act) return run(() => sender.send('duplicate_layer', { layerId: act }));
        if (k === 'g' && !e.shiftKey && act) return run(() => sender.send('group_layers', { action: 'group', layerIds: layers.picked.length ? layers.picked : [act] }));
        if (k === 'g' && e.shiftKey && act) return run(() => sender.send('group_layers', { action: 'ungroup', layerIds: [act] }));
        if (k === 'e' && !e.shiftKey) return run(() => sender.send('merge_layers', { mode: 'down' }));
        if (k === 'e' && e.shiftKey) return run(() => sender.send('merge_layers', { mode: 'visible' }));
        if (k === 'a') return run(() => sender.send('set_selection', { op: 'replace', shape: 'all' }));
        if (k === 'd') return run(() => sender.send('set_selection', { op: 'replace', shape: 'none' }));
        if (k === 'i' && e.shiftKey) return run(() => sender.send('refine_selection', { action: 'invert' }));
      }
      return;
    }
    if (e.altKey) return;
    if (e.key === '\\') return run(() => sender.send('set_view', { beforeAfter: 'toggle' }));
    if (dev) {
      if (filmstrip.key(e)) { e.preventDefault(); return; }
      const t = { r: 'crop', m: e.shiftKey ? 'mask-radial' : 'mask-linear', k: 'mask-brush', h: 'hand', z: 'zoom' }[k];
      if (t) return run(() => tools.setTool(t));
      if (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}') return run(() => tools.nudge(e.key === '{' ? '[' : e.key === '}' ? ']' : e.key, e.shiftKey));
      return;
    }
    const t = { v: 'move', m: e.shiftKey ? 'marquee-ellipse' : 'marquee-rect', l: 'lasso', w: 'wand', b: 'brush', e: 'eraser', g: e.shiftKey ? 'gradient' : 'fill', t: 'text', c: 'crop', h: 'hand', z: 'zoom' }[k];
    if (t) return run(() => tools.setTool(t));
    if (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}') return run(() => tools.nudge(e.key === '{' ? '[' : e.key === '}' ? ']' : e.key, e.shiftKey));
    const t2 = { i: 'eyedropper', u: 'warp', q: 'liquify' }[k];
    if (t2) return run(() => tools.setTool(t2));
    if (k === 'd') return run(() => tools.defaultColours());
    if (k === 'x') return run(() => tools.swapColours());
  });

  // ---- render ----
  let queued = false;
  // A hidden tab gets no animation frames; redraw on a timer then, so state an agent reads stays current.
  const nextFrame = (f) => (document.hidden ? setTimeout(f, 16) : requestAnimationFrame(f));
  function render() { if (queued) return; queued = true; nextFrame(() => { queued = false; renderNow(); }); }
  function renderNow() {
    const doc = ctx.store.doc; const dev = ctx.view.mode === 'develop'; const caps = hostCaps();
    document.body.dataset.mode = dev ? 'develop' : 'composite';
    for (const b of modes.children) { const on = b.dataset.mode === ctx.view.mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
    const s = ctx.storage();
    storageLabel.textContent = s ? s.label : 'No storage'; storageLabel.title = 'Where Atelier keeps your photos and documents';
    devRoot.hidden = !dev; layRoot.hidden = dev;
    if (dev) develop.update(); else { layers.render(); engineUI.render(); }
    empty.hidden = !!doc || !!engineError || !loadingEl.hidden;
    if (!doc) $('#empty-storage').textContent = s ? `Photos you open are copied to ${s.kind === 'browser' ? 'this browser’s own storage' : s.label}. Nothing is uploaded.` : 'Nothing is uploaded.';
    // AI tools act on an open photo, so their panels (and model downloads) wait until one is open.
    for (const el of [$('#ai-panel'), document.querySelector('aside .ai-pixels'), document.querySelector('aside .ai-portrait')]) if (el) el.hidden = !doc;
    aiMasks.render();
    ui.vector?.render();
    filmstrip.draw();
    ui.views?.render();
    tools.paintOverlay();
    stagedBar.replaceChildren(...[...ctx.staged.values()].map((st) => h('div', {}, h('span', {}, st.summary),
      h('button', { class: 'primary', dataset: { staged: st.id, decision: 'confirm', person: 'confirm_staged' } }, 'Confirm'),
      h('button', { dataset: { staged: st.id, decision: 'discard', person: 'discard_staged' } }, 'Discard'))));
    $('#mode').textContent = dev ? 'Develop' : 'Composite';
    if (engineError) { status.textContent = `Atelier needs WebGPU to show and edit photos: ${engineError.message} ${engineError.remedy ?? ''}`; return; }
    const where = caps.hosted && window.parent !== window ? 'In NakliOS' : 'Standalone';
    const base = `${where} · ${doc ? `${doc.title} · ${doc.width} × ${doc.height}` : 'no document'} · revision ${bus.state.revision}`;
    status.textContent = lastNote ? `${base} · ${lastNote}` : base;
  }

  // ---- WebGPU missing ----
  if (engineError) {
    const m = $('#gpu-msg'); m.hidden = false;
    m.replaceChildren(h('h2', {}, 'Atelier needs WebGPU'), h('p', {}, engineError.message), h('p', {}, 'Open Atelier in a current Chrome, Edge or Safari with WebGPU turned on. Your files stay where they are; nothing is lost.'));
  }

  tools.drawBar();
  ui.views = mountViews(ui);
  groupHeader();

  // ---- header menus (UX review M7) ----
  // The header keeps File actions, the mode switch, Undo and Redo in view and puts the rest in four menus
  // grouped by task. A menu is a <details>, so the command palette's reach() opens it to show a control.
  function menu(label, items, title) {
    const list = h('div', { class: 'hmenu-list', role: 'group', 'aria-label': label }, items);
    const d = h('details', { class: 'hmenu' }, h('summary', { title }, label), list);
    // a click on a button in the list runs it, then the menu closes; selects and inputs keep it open
    list.addEventListener('click', (e) => { if (e.target.closest('button')) setTimeout(() => { d.open = false; }, 0); });
    d.addEventListener('toggle', () => { if (d.open) for (const o of header.querySelectorAll('details.hmenu[open]')) if (o !== d) o.open = false; });
    return d;
  }
  function groupHeader() {
    const v = (prefix) => [...header.querySelectorAll('.views-bar button')].find((b) => (b.dataset.viewLabel || '').startsWith(prefix));
    const bar = header.querySelector('.views-bar');
    const viewItems = ['Compare view', 'Before and after', 'Node view'].map(v).filter(Boolean);
    const shareItems = ['Slideshow', 'Print', 'Web gallery', 'Map of photos', 'Book'].map(v).filter(Boolean);
    const search = v('Command palette');
    if (search) { search.textContent = 'Search ⌘K'; search.classList.add('hsearch'); }
    const menus = [
      menu('Edit', [fillBtn, mergeBtn, smartSel], 'Content-aware fill, merge photos, smart objects'),
      menu('View', viewItems, 'Compare, before and after, node view'),
      menu('Share', shareItems, 'Slideshow, print, web gallery, map, book'),
      ...(tetherEl ? [menu('Camera', [tetherEl], 'Tethered capture from a USB camera')] : []),
    ];
    const help = h('button', { class: 'hhelp', dataset: { view: 'help' }, title: 'How to start, and keyboard shortcuts', 'aria-label': 'Help', onclick: () => openHelp() }, '?');
    const redo = header.querySelector('[data-command="redo"]');
    redo.after(...menus, ...(search ? [search] : []), help);
    bar?.remove();
  }

  // ---- help sheet (UX review L2) ----
  function openHelp() {
    const row = (k, t) => h('div', { class: 'help-row' }, h('kbd', {}, k), h('span', {}, t));
    return dialogs.raw({ title: 'Getting started', body: h('div', { class: 'form help' },
      h('ol', {},
        h('li', {}, 'Open photo… or drop photos on the canvas. Photos are copied into Atelier’s storage; your originals stay as they are.'),
        h('li', {}, 'Develop adjusts one photo (exposure, colour, tone curve, lens). Composite builds a picture from layers.'),
        h('li', {}, 'In Composite, Add adjustment adds a layer whose sliders appear above the panel when you select it.'),
        h('li', {}, 'Atelier saves as you work. The first Save asks for a name.'),
        h('li', {}, 'Export… writes a JPEG, PNG, WebP, AVIF or TIFF; with this browser’s storage it also downloads a copy.')),
      h('h4', {}, 'Keyboard'),
      row('Ctrl+1 / Ctrl+2', 'Develop / Composite'), row('Ctrl+Z / Ctrl+Shift+Z', 'Undo / Redo'), row('Ctrl+S', 'Save'), row('Ctrl+K', 'Search commands'),
      row('Ctrl+0, Ctrl+= , Ctrl+-', 'Fit, zoom in, zoom out'), row('\\', 'Before and after'),
      row('V M L W B E T C H Z', 'Move, marquee, lasso, wand, brush, eraser, type, crop, hand, zoom (Composite)'),
      row('R M K', 'Crop, linear mask, brush mask (Develop)')),
    actions: [{ label: 'Close', value: null, primary: true }] });
  }
  addEventListener('keydown', (e) => { if (e.key === 'Escape') for (const o of header.querySelectorAll('details.hmenu[open]')) o.open = false; });
  addEventListener('pointerdown', (e) => { if (!e.target.closest('details.hmenu')) for (const o of header.querySelectorAll('details.hmenu[open]')) o.open = false; });
  addEventListener('resize', () => { tools.sizeOverlay(); render(); });
  tools.sizeOverlay();
  return { ui, render, refreshFolder: () => filmstrip.refresh().then(() => develop.refreshPresets()), say };
}
