// The filmstrip: list_folder's photos and virtual copies with rating, flag, colour label and keywords,
// filtered by those, by a collection, and by EXIF (camera, lens, ISO, focal length, date) — Lightroom's
// Library conventions. A click opens the photo or its virtual copy (open_photo with copy);
// Ctrl or Cmd click and Shift click select several. Ratings, flags, labels and keywords write sidecars
// (and XMP sidecars for proprietary RAWs). Collections, smart-collection rules, virtual copies, XMP
// read-back and the Lightroom catalog import live in the bar's Library menu.

import { h } from './dom.js';

const LABELS = ['none', 'red', 'yellow', 'green', 'blue', 'purple'];
const keyOf = (p) => (p.copy ? `${p.path}#${p.copy}` : p.path);
const RULE_FIELDS = [['rating', 'Rating', 'number'], ['flag', 'Flag', 'enum'], ['label', 'Label', 'enum'], ['keyword', 'Keyword', 'text'], ['camera', 'Camera', 'text'], ['lens', 'Lens', 'text'], ['iso', 'ISO', 'number'], ['focalLength', 'Focal length (mm)', 'number'], ['date', 'Capture date', 'date'], ['path', 'File path', 'text'], ['kind', 'Kind (raw, image)', 'enum']];
const RULE_OPS = { number: ['=', '!=', '>=', '<='], enum: ['=', '!='], text: ['contains', 'notContains', '='], date: ['>=', '<=', '='] };
const EXIF_FIELDS = [['camera', 'Camera contains', 'text'], ['lens', 'Lens contains', 'text'], ['isoMin', 'ISO from', 'number'], ['isoMax', 'ISO to', 'number'], ['focalMin', 'Focal length from (mm)', 'number'], ['focalMax', 'Focal length to (mm)', 'number'], ['dateFrom', 'Captured from', 'date'], ['dateTo', 'Captured to', 'date'], ['text', 'File name contains', 'text']];

export function createFilmstrip(root, ui) {
  const { send } = ui;
  let photos = []; let page = 0; let pages = 1; let total = 0;
  const filter = { minRating: 0, flag: '', label: '', keyword: '', collection: '' };
  let exifFilter = {};
  const selected = new Set(); let anchor = null;   // item keys: 'path' or 'path#vc1'
  let keywords = []; let collections = [];

  const strip = h('div', { class: 'strip', role: 'listbox', 'aria-label': 'Photos in the folder', 'aria-multiselectable': 'true' });
  const count = h('span', { class: 'dim' });
  const sel = (label, key, opts) => h('select', { 'aria-label': label, dataset: { command: 'list_folder' }, onchange: (e) => { filter[key] = key === 'minRating' ? Number(e.target.value) : e.target.value; page = 0; refresh(); } }, opts);
  const more = h('button', { dataset: { command: 'list_folder' }, hidden: true, onclick: () => { page = (page + 1) % pages; refresh(); } }, 'Next page');
  const kwSel = sel('Keyword', 'keyword', []);
  const colSel = sel('Collection', 'collection', []);
  const exifBtn = h('button', { dataset: { command: 'list_folder' }, title: 'Filter by camera, lens, ISO, focal length, capture date or file name', onclick: () => editExifFilter() }, 'Filter…');
  const menu = h('select', { class: 'lib-menu', 'aria-label': 'Library actions', onchange: (e) => { const v = e.target.value; e.target.value = ''; libraryAction(v); } },
    h('option', { value: '' }, 'Library…'),
    h('option', { value: 'keywords', dataset: { command: 'set_keywords' } }, 'Keywords for selected…'),
    h('option', { value: 'add-col', dataset: { command: 'add_to_collection' } }, 'Add selected to collection…'),
    h('option', { value: 'remove-col', dataset: { command: 'add_to_collection' } }, 'Remove selected from shown collection'),
    h('option', { value: 'new-col', dataset: { command: 'create_collection' } }, 'New collection…'),
    h('option', { value: 'new-smart', dataset: { command: 'set_smart_collection' } }, 'New smart collection…'),
    h('option', { value: 'edit-smart', dataset: { command: 'set_smart_collection' } }, 'Edit shown smart collection…'),
    h('option', { value: 'del-col', dataset: { command: 'delete_collection' } }, 'Delete shown collection'),
    h('option', { value: 'vc', dataset: { command: 'create_virtual_copy' } }, 'Make virtual copy'),
    h('option', { value: 'del-vc', dataset: { command: 'delete_virtual_copy' } }, 'Delete selected virtual copy'),
    h('option', { value: 'xmp', dataset: { command: 'import_xmp' } }, 'Read XMP sidecars (ratings, labels, keywords)'),
    h('option', { value: 'lrcat', dataset: { command: 'import_lightroom_catalog' } }, 'Import Lightroom catalog…'),
    h('option', { value: 'cull', dataset: { command: 'analyze_culling' } }, 'Culling assist: analyse shown photos'),
    h('option', { value: 'cull-accept', dataset: { command: 'accept_cull_suggestions' } }, 'Culling assist: accept suggestions for selected'),
    h('option', { value: 'assets', dataset: { command: 'list_library_assets' } }, 'Shared library (presets, LUTs, colours, brushes, images)…'),
    h('option', { value: 'sync', dataset: { command: 'sync_library' } }, 'Sync library…'));
  const assetInput = h('input', { type: 'file', accept: '.png,.jpg,.jpeg,.webp,.cube', hidden: true, 'aria-label': 'Library asset file', onchange: (e) => addAssetFile(e.target.files[0]) });
  const lrInput = h('input', { type: 'file', accept: '.lrcat', hidden: true, 'aria-label': 'Lightroom catalog file', onchange: (e) => importCatalog(e.target.files[0]) });
  const bar = h('div', { class: 'strip-bar' },
    h('strong', {}, 'Filmstrip'), count,
    sel('Minimum rating', 'minRating', [0, 1, 2, 3, 4, 5].map((n) => h('option', { value: n }, n ? `${'★'.repeat(n)} and up` : 'Any rating'))),
    sel('Flag', 'flag', [['', 'Any flag'], ['pick', 'Picks'], ['reject', 'Rejects'], ['none', 'Unflagged']].map(([v, t]) => h('option', { value: v }, t))),
    sel('Label', 'label', [['', 'Any label'], ...LABELS.map((l) => [l, l === 'none' ? 'No label' : l])].map(([v, t]) => h('option', { value: v }, t))),
    kwSel, colSel, exifBtn,
    more, h('span', { class: 'grow' }), menu, lrInput, assetInput,
    h('button', { dataset: { command: 'open_photo' }, title: 'Add the selected photo to the open document as a layer', onclick: () => placeSelected() }, 'Place as layer'),
    h('button', { dataset: { command: 'sync_settings' }, title: 'Copy the open photo’s settings to the selected photos', onclick: () => ui.syncSettings() }, 'Sync…'));
  root.append(bar, strip);

  const selectedPaths = () => [...new Set([...selected].map((k) => k.replace(/#vc\d+$/, '')))];
  const cull = (paths, patch) => send('set_rating', { paths, ...patch }).then((r) => { if (r.status === 'ok') refresh(); return r; });
  const targets = (key) => (selected.has(key) && selected.size > 1 ? selectedPaths() : [key.replace(/#vc\d+$/, '')]);

  function tile(p) {
    const name = p.path.split('/').pop(); const key = keyOf(p);
    const stars = h('span', { class: 'stars', role: 'radiogroup', 'aria-label': 'Rating' }, [1, 2, 3, 4, 5].map((n) => h('button', {
      class: n <= p.rating ? 'on' : null, 'aria-label': `${n} star${n > 1 ? 's' : ''}`, dataset: { command: 'set_rating' },
      onclick: (e) => { e.stopPropagation(); cull(targets(key), { rating: p.rating === n ? 0 : n }); },
    }, '★')));
    const flag = (f, glyph, label) => h('button', { class: `flag ${p.flag === f ? 'on' : ''}`, 'aria-label': label, 'aria-pressed': String(p.flag === f), dataset: { command: 'set_rating' }, onclick: (e) => { e.stopPropagation(); cull(targets(key), { flag: p.flag === f ? 'none' : f }); } }, glyph);
    const label = h('select', { class: `lab lab-${p.label}`, 'aria-label': 'Colour label', dataset: { command: 'set_rating' }, onclick: (e) => e.stopPropagation(), onchange: (e) => cull(targets(key), { label: e.target.value }) },
      LABELS.map((l) => h('option', { value: l, selected: l === p.label }, l === 'none' ? '–' : l)));
    const active = ui.ctx.activePhoto === p.path && (ui.store.doc?.photo?.copy ?? null) === (p.copy ?? null);
    const e = p.exif;
    const info = [p.path, p.copy ? `Virtual copy: ${p.copyName}` : null, e ? [e.camera, e.lens, e.iso ? `ISO ${e.iso}` : null, e.focalLength ? `${e.focalLength} mm` : null, e.date?.replace('T', ' ')].filter(Boolean).join(' · ') : null, p.keywords?.length ? `Keywords: ${p.keywords.join(', ')}` : null].filter(Boolean).join('\n');
    return h('div', {
      class: ['tile', selected.has(key) ? 'sel' : '', active ? 'active' : '', p.flag === 'reject' ? 'rejected' : '', p.copy ? 'vcopy' : ''].join(' '),
      role: 'option', 'aria-selected': String(selected.has(key)), tabindex: 0, title: info, dataset: { command: 'open_photo', path: p.path, ...(p.copy ? { copy: p.copy } : {}) },
      onclick: (ev) => choose(key, ev), onkeydown: (ev) => { if (ev.key === 'Enter') choose(key, {}); },
    }, h('span', { class: 'kind' }, p.kind === 'raw' ? 'RAW' : name.split('.').pop().toUpperCase()), h('span', { class: 'fname' }, p.copy ? `${name} · ${p.copyName}` : name),
    p.suggest?.flag || p.suggest?.notes?.length ? h('span', { class: 'kw sug', title: [...(p.suggest.reasons || []), ...(p.suggest.notes || [])].join('\n') }, p.suggest.flag ? `Suggest reject: ${p.suggest.reasons[0]}` : p.suggest.notes[0]) : null,
    p.keywords?.length ? h('span', { class: 'kw dim', 'aria-label': `Keywords: ${p.keywords.join(', ')}` }, p.keywords.slice(0, 3).join(', ') + (p.keywords.length > 3 ? '…' : '')) : null,
    h('span', { class: 'meta' }, stars, flag('pick', '⚑', 'Pick'), flag('reject', '✕', 'Reject'), label));
  }

  function choose(key, e) {
    if (e.metaKey || e.ctrlKey) { if (selected.has(key)) selected.delete(key); else selected.add(key); anchor = key; draw(); return; }
    if (e.shiftKey && anchor) {
      const a = photos.findIndex((p) => keyOf(p) === anchor); const b = photos.findIndex((p) => keyOf(p) === key);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(keyOf(photos[i]));
      draw(); return;
    }
    selected.clear(); selected.add(key); anchor = key;
    const p = photos.find((x) => keyOf(x) === key);
    if (p?.copy) send('open_photo', { path: p.path, copy: p.copy }).then(() => ui.render?.());
    else ui.openPhoto(key);
  }

  async function placeSelected() {
    // the anchor can be a tile the person just deselected (Cmd-click); place only what is selected
    const key = anchor && selected.has(anchor) ? anchor : [...selected][0];
    if (!key) { ui.say('Select a photo in the filmstrip first.'); return; }
    if (!ui.store.doc) { ui.say('Open or create a document first; Place adds the photo as a layer.'); return; }
    await send('open_photo', { path: key.replace(/#vc\d+$/, ''), asLayer: true });
  }

  function draw() {
    strip.replaceChildren(...(photos.length ? photos.map(tile) : [h('p', { class: 'hint' }, ui.ctx.storage() ? 'No photos match. Add RAW or JPEG files to the folder, open a folder, or clear the filters.' : 'No storage yet.')]));
    // a listbox needs options, so the empty strip (a hint) is a plain region
    if (photos.length) { strip.setAttribute('role', 'listbox'); strip.setAttribute('aria-multiselectable', 'true'); } else { strip.removeAttribute('role'); strip.removeAttribute('aria-multiselectable'); }
    count.textContent = `${total} photo${total === 1 ? '' : 's'}${selected.size > 1 ? ` · ${selected.size} selected` : ''}`;
    more.hidden = pages < 2; more.textContent = `Page ${page + 1} of ${pages}`;
    const nExif = Object.keys(exifFilter).length;
    exifBtn.textContent = nExif ? `Filter (${nExif})…` : 'Filter…'; exifBtn.classList.toggle('on', nExif > 0);
  }
  const option = (v, t, cur) => h('option', { value: v, selected: v === cur }, t);
  function drawLists() {
    kwSel.replaceChildren(option('', 'Any keyword', filter.keyword), ...keywords.map((k) => option(k.keyword, `${k.keyword} (${k.count})`, filter.keyword)));
    colSel.replaceChildren(option('', 'All photos', filter.collection), ...collections.map((c) => option(c.name, `${c.kind === 'smart' ? '⚙ ' : ''}${c.name} (${c.count})`, filter.collection)));
  }

  async function refresh() {
    const f = { ...exifFilter };
    if (filter.minRating) f.minRating = filter.minRating;
    for (const k of ['flag', 'label', 'keyword', 'collection']) if (filter[k]) f[k] = filter[k];
    const r = await ui.read('list_folder', { ...(Object.keys(f).length ? { filter: f } : {}), page });
    if (r.status === 'ok') { photos = r.result.photos; pages = r.result.pages; total = r.result.total; } else { photos = []; pages = 1; total = 0; }
    for (const k of [...selected]) if (!photos.some((x) => keyOf(x) === k)) selected.delete(k);
    const [kw, col] = await Promise.all([ui.read('list_keywords', {}), ui.read('list_collections', {})]);
    keywords = kw.status === 'ok' ? kw.result.keywords : []; collections = col.status === 'ok' ? col.result.collections : [];
    if (filter.collection && !collections.some((c) => c.name === filter.collection)) { filter.collection = ''; }
    drawLists(); draw();
  }

  // ---- dialogs ----
  const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);
  async function editExifFilter() {
    const inputs = Object.fromEntries(EXIF_FIELDS.map(([k, , t]) => [k, h('input', { type: t === 'number' ? 'number' : t === 'date' ? 'date' : 'text', value: exifFilter[k] ?? '', 'aria-label': k })]));
    const v = await ui.dialogs.raw({ title: 'Filter by EXIF', body: h('div', { class: 'form' }, EXIF_FIELDS.map(([k, label]) => field(label, inputs[k])), h('p', { class: 'hint' }, 'Atelier reads each photo’s EXIF once and keeps it in library.json.')),
      actions: [{ label: 'Clear', value: 'clear' }, { label: 'Cancel', value: null }, { label: 'Apply', value: 'apply', primary: true }] });
    if (!v) return;
    exifFilter = {};
    if (v === 'apply') for (const [k, , t] of EXIF_FIELDS) { const x = inputs[k].value.trim(); if (x) exifFilter[k] = t === 'number' ? Number(x) : x; }
    page = 0; refresh();
  }

  async function editRules(initial = { match: 'all', rules: [{ field: 'rating', op: '>=', value: 3 }] }, name = '') {
    const nameIn = h('input', { type: 'text', value: name, 'aria-label': 'Collection name', disabled: !!name });
    const match = h('select', { 'aria-label': 'Match' }, option('all', 'Match all rules', initial.match), option('any', 'Match any rule', initial.match));
    const list = h('div', { class: 'rules' });
    const addRow = (r) => {
      const fieldSel = h('select', { 'aria-label': 'Field' }, RULE_FIELDS.map(([k, t]) => option(k, t, r.field)));
      const opSel = h('select', { 'aria-label': 'Operator' });
      const val = h('input', { type: 'text', value: r.value ?? '', 'aria-label': 'Value' });
      const syncOps = () => { const t = RULE_FIELDS.find(([k]) => k === fieldSel.value)[2]; opSel.replaceChildren(...RULE_OPS[t].map((o) => option(o, o, r.op))); val.type = t === 'number' ? 'number' : 'text'; val.placeholder = t === 'date' ? 'YYYY-MM-DD' : t === 'enum' ? (fieldSel.value === 'flag' ? 'pick, reject or none' : fieldSel.value === 'kind' ? 'raw or image' : 'red, yellow, green, blue, purple, none') : ''; };
      fieldSel.onchange = syncOps; syncOps();
      const row = h('div', { class: 'rule' }, fieldSel, opSel, val, h('button', { type: 'button', 'aria-label': 'Remove rule', onclick: () => row.remove() }, '✕'));
      row.read = () => { const t = RULE_FIELDS.find(([k]) => k === fieldSel.value)[2]; return { field: fieldSel.value, op: opSel.value, value: t === 'number' ? Number(val.value) : val.value.trim() }; };
      list.append(row);
    };
    initial.rules.forEach(addRow);
    const v = await ui.dialogs.raw({ title: name ? `Smart collection ${name}` : 'New smart collection',
      body: h('div', { class: 'form' }, field('Name', nameIn), match, list, h('button', { type: 'button', onclick: () => addRow({ field: 'keyword', op: 'contains', value: '' }) }, 'Add rule')),
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', value: () => ({ name: nameIn.value.trim(), rules: { match: match.value, rules: [...list.children].map((r) => r.read()) } }), primary: true }] });
    if (!v) return;
    if (!v.name) { ui.say('Give the smart collection a name.'); return; }
    const r = await send('set_smart_collection', v);
    if (r.status === 'ok') { filter.collection = v.name; ui.say(`Smart collection ${v.name}: ${r.result.count} photos.`); refresh(); }
  }

  async function pickCollection(title) {
    const manual = collections.filter((c) => c.kind === 'manual');
    const s = h('select', { 'aria-label': 'Collection' }, manual.map((c) => option(c.name, c.name, filter.collection)));
    const input = h('input', { type: 'text', placeholder: 'or a new collection name', 'aria-label': 'New collection name' });
    const v = await ui.dialogs.raw({ title, body: h('div', { class: 'form' }, manual.length ? field('Collection', s) : null, field('New collection', input)), actions: [{ label: 'Cancel', value: null }, { label: 'Add', value: () => input.value.trim() || s.value, primary: true }] });
    return v || null;
  }

  async function libraryAction(v) {
    const keys = [...selected]; const paths = selectedPaths();
    const needSel = () => { if (!keys.length) { ui.say('Select photos in the filmstrip first.'); return false; } return true; };
    if (v === 'keywords') {
      if (!needSel()) return;
      const common = photos.filter((p) => keys.includes(keyOf(p))).map((p) => p.keywords || []);
      const cur = common.length ? common.reduce((a, b) => a.filter((k) => b.includes(k))) : [];
      const mode = h('select', { 'aria-label': 'How' }, option('set', 'Replace keywords', 'set'), option('add', 'Add keywords', 'set'), option('remove', 'Remove keywords', 'set'));
      const input = h('input', { type: 'text', value: cur.join(', '), autofocus: true, 'aria-label': 'Keywords, comma separated' });
      const r = await ui.dialogs.raw({ title: `Keywords for ${paths.length} photo${paths.length > 1 ? 's' : ''}`, body: h('div', { class: 'form' }, field('Keywords (comma separated)', input), mode, h('p', { class: 'hint' }, 'Also written to XMP sidecars that Lightroom and Bridge read.')),
        actions: [{ label: 'Cancel', value: null }, { label: 'Save', value: () => ({ keywords: input.value.split(',').map((s) => s.trim()).filter(Boolean), mode: mode.value }), primary: true }] });
      if (!r) return;
      const out = await send('set_keywords', { paths, ...r });
      if (out.status === 'ok') refresh();
    } else if (v === 'new-col') {
      const name = await ui.dialogs.promptText('New collection', 'Name');
      if (!name) return;
      const r = await send('create_collection', { name: name.trim() });
      if (r.status === 'ok' && keys.length) await send('add_to_collection', { name: r.result.name, items: keys });
      if (r.status === 'ok') { filter.collection = r.result.name; refresh(); }
    } else if (v === 'add-col') {
      if (!needSel()) return;
      const name = await pickCollection(`Add ${keys.length} to a collection`);
      if (!name) return;
      if (!collections.some((c) => c.name === name)) { const c = await send('create_collection', { name }); if (c.status !== 'ok') return; }
      const r = await send('add_to_collection', { name, items: keys });
      if (r.status === 'ok') { ui.say(`${name}: ${r.result.count} items.`); refresh(); }
    } else if (v === 'remove-col') {
      if (!needSel()) return;
      if (!filter.collection) { ui.say('Show a collection first (the collection menu), then remove photos from it.'); return; }
      const r = await send('add_to_collection', { name: filter.collection, items: keys, op: 'remove' });
      if (r.status === 'ok') refresh();
    } else if (v === 'new-smart') editRules();
    else if (v === 'edit-smart') {
      const c = collections.find((x) => x.name === filter.collection);
      if (!c || c.kind !== 'smart') { ui.say('Show a smart collection first.'); return; }
      editRules(c.rules, c.name);
    } else if (v === 'del-col') {
      if (!filter.collection) { ui.say('Show the collection to delete first.'); return; }
      const ok = await ui.dialogs.ask('Delete collection', `Delete the collection ${filter.collection}? The photos stay where they are.`, [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, primary: true, danger: true }], false);
      if (!ok) return;
      const r = await send('delete_collection', { name: filter.collection });
      if (r.status === 'ok') { filter.collection = ''; refresh(); }
    } else if (v === 'vc') {
      const key = anchor || keys[0] || ui.ctx.activePhoto;
      if (!key) { ui.say('Select a RAW photo first.'); return; }
      const { path, copy } = /#vc\d+$/.test(key) ? { path: key.replace(/#vc\d+$/, ''), copy: key.split('#').pop() } : { path: key, copy: null };
      const r = await send('create_virtual_copy', { path, ...(copy ? { from: copy } : {}) });
      if (r.status === 'ok') { ui.say(`Made ${r.result.name} of ${path.split('/').pop()}.`); refresh(); }
    } else if (v === 'del-vc') {
      const p = photos.find((x) => keyOf(x) === (anchor || keys[0]));
      if (!p?.copy) { ui.say('Select a virtual copy tile first.'); return; }
      const ok = await ui.dialogs.ask('Delete virtual copy', `Delete ${p.copyName} and its develop settings? The photo and its other copies stay.`, [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, primary: true, danger: true }], false);
      if (!ok) return;
      const r = await send('delete_virtual_copy', { path: p.path, copy: p.copy });
      if (r.status === 'ok') refresh();
    } else if (v === 'xmp') {
      const r = await send('import_xmp', {});
      if (r.status === 'ok') { ui.say(`Read ${r.result.photos.filter((x) => x.imported).length} XMP sidecar${r.result.photos.length === 1 ? '' : 's'}.`); refresh(); }
    } else if (v === 'lrcat') lrInput.click();
    else if (v === 'cull') {
      const paths = keys.length ? paths0() : photos.filter((p) => !p.copy).map((p) => p.path);
      ui.say(`Analysing ${paths.length} photo${paths.length === 1 ? '' : 's'}…`);
      const r = await send('analyze_culling', { paths });
      if (r.status === 'ok') { ui.say(`Culling assist: ${r.result.suggestedRejects} suggested reject${r.result.suggestedRejects === 1 ? '' : 's'} of ${r.result.photos.length}. Select photos and accept, or ignore.`); refresh(); }
    } else if (v === 'cull-accept') {
      if (!needSel()) return;
      const r = await send('accept_cull_suggestions', { paths });
      if (r.status === 'ok') refresh();
    } else if (v === 'assets') openAssets();
    else if (v === 'sync') openSync();
  }
  const paths0 = () => selectedPaths();

  // ---- shared asset library (P60) ----
  let pendingAsset = null;
  async function addAssetFile(file) {
    assetInput.value = ''; if (!file || !pendingAsset) return;
    ui.ctx.pickedAsset = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    try { const r = await send('add_library_asset', { kind: pendingAsset, name: file.name.replace(/\.[^.]+$/, '') }); if (r.status === 'ok') ui.say(`Added ${r.result.path} to the library.`); }
    finally { ui.ctx.pickedAsset = null; pendingAsset = null; }
  }
  // Remove asks twice in place (the library dialog is open, so no second dialog): the first click arms
  // the button, the second deletes. Presets are saved from Develop and removed there, so they have none.
  function removeButton(a) {
    if (a.kind === 'preset') return h('span', {});
    let armed = false;
    return h('button', { type: 'button', dataset: { command: 'delete_library_asset' }, title: `Remove ${a.name} from the library`, onclick: async (e) => {
      const b = e.currentTarget;
      if (!armed) { armed = true; b.textContent = 'Confirm remove'; b.classList.add('danger'); setTimeout(() => { if (b.isConnected) { armed = false; b.textContent = 'Remove'; b.classList.remove('danger'); } }, 4000); return; }
      const r = await send('delete_library_asset', a.kind === 'colour' ? { kind: 'colour', name: a.name } : { kind: 'file', path: a.path });
      if (r.status === 'ok') { b.closest('.rule')?.remove(); ui.say(`Removed ${a.name} from the library.`); }
    } }, 'Remove');
  }
  async function openAssets() {
    const r = await ui.read('list_library_assets', {}); if (r.status !== 'ok') return;
    const rows = r.result.assets.map((a) => h('div', { class: 'rule asset-row' }, h('span', {}, a.kind), h('span', {}, a.name), a.kind === 'colour' ? h('span', { style: `background:${a.hex}`, 'aria-label': a.hex }, a.hex) : h('span', { class: 'dim' }, a.path),
      a.kind === 'image' ? h('button', { type: 'button', dataset: { command: 'open_photo' }, onclick: async (e) => { if (!ui.store.doc) { ui.say('Open a document first.'); return; } const dlg = e.currentTarget.closest('dialog'); const r = await send('open_photo', { path: a.path, asLayer: true }); if (r.status === 'ok') { ui.say(`Placed ${a.name} as a layer.`); dlg?.querySelector('[data-answer="Close"]')?.click(); } } }, 'Place')
        : a.kind === 'preset' || a.kind === 'lut' ? h('span', { class: 'dim' }, 'Develop › Presets') : h('span', {}),
      removeButton(a)));
    const v = await ui.dialogs.raw({ title: 'Shared library', body: h('div', { class: 'form' }, h('div', { class: 'rules' }, rows.length ? rows : h('p', { class: 'hint' }, 'Nothing yet.')), h('p', { class: 'hint' }, 'The library syncs with Sync library… to your other devices.')),
      actions: [{ label: 'Close', value: null }, { label: 'Add colour…', value: 'colour' }, { label: 'Add brush…', value: 'brush' }, { label: 'Add image…', value: 'image' }, { label: 'Add LUT…', value: 'lut' }] });
    if (v === 'image' || v === 'lut') { pendingAsset = v; assetInput.accept = v === 'lut' ? '.cube' : '.png,.jpg,.jpeg,.webp'; assetInput.click(); }
    else if (v === 'colour') {
      const name = h('input', { type: 'text', 'aria-label': 'Name' }); const col = h('input', { type: 'color', value: '#c8553d', 'aria-label': 'Colour' });
      const x = await ui.dialogs.raw({ title: 'Add colour', body: h('div', { class: 'form' }, field('Name', name), field('Colour', col)), actions: [{ label: 'Cancel', value: null }, { label: 'Add', value: () => ({ name: name.value.trim(), color: col.value }), primary: true }] });
      if (x?.name) await send('add_library_asset', { kind: 'colour', ...x });
    } else if (v === 'brush') {
      const inp = (k, d) => h('input', { type: 'number', value: d, 'aria-label': k });
      const f = { name: h('input', { type: 'text', 'aria-label': 'Name' }), size: inp('Size', 20), hardness: inp('Hardness', 100), flow: inp('Flow', 100), opacity: inp('Opacity', 100) };
      const x = await ui.dialogs.raw({ title: 'Add brush', body: h('div', { class: 'form' }, Object.entries(f).map(([k, el]) => field(k[0].toUpperCase() + k.slice(1), el))), actions: [{ label: 'Cancel', value: null }, { label: 'Add', value: () => ({ name: f.name.value.trim(), brush: { size: +f.size.value, hardness: +f.hardness.value, flow: +f.flow.value, opacity: +f.opacity.value } }), primary: true }] });
      if (x?.name) await send('add_library_asset', { kind: 'brush', ...x });
    }
  }

  // ---- library sync (L52) ----
  async function openSync() {
    const st = await ui.read('get_sync_status', {});
    if (st.status !== 'ok') return;
    if (!st.result.configured) {
      const hosted = ui.ctx.storage()?.kind === 'host';
      if (!hosted && !ui.ctx.syncTarget) {
        const pick = await ui.dialogs.ask('Sync library', 'Choose a folder your devices share (for example a Dropbox or iCloud folder). Atelier keeps its library there; no account is involved.', [{ label: 'Cancel', value: false }, { label: 'Choose sync folder…', value: true, primary: true }], false);
        if (!pick || !window.showDirectoryPicker) return;
        try { const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'atelier-sync' }); const { directoryStore } = await import('../storage.js'); ui.ctx.syncTarget = directoryStore(handle, 'folder', handle.name); } catch { return; }
      }
      const root = await ui.dialogs.promptText('Sync library', hosted ? 'Folder in your NakliOS Folder or Crate' : 'Folder inside the chosen folder', 'atelier-library');
      if (!root) return;
      const r = await send('set_sync_folder', { root: root.trim() });
      if (r.status !== 'ok') return;
    }
    const r = await send('sync_library', {});
    if (r.status !== 'ok') return;
    const c = r.result.conflicts;
    ui.say(`Synced: ${r.result.pushed.length} sent, ${r.result.pulled.length} received${c.length ? `, ${c.length} conflict${c.length === 1 ? '' : 's'}` : ''}.`);
    for (const x of c) {
      const choice = await ui.dialogs.ask('Changed on two devices', `${x.path} changed here and on ${x.theirs.device} (${x.theirs.updated?.slice(0, 16).replace('T', ' ') ?? ''}).`, [{ label: 'Later', value: null }, { label: 'Keep both', value: 'both' }, { label: 'Take theirs', value: 'theirs' }, { label: 'Keep mine', value: 'mine', primary: true }], null);
      if (choice) await send('resolve_sync_conflict', { path: x.path, choice });
    }
    refresh();
  }

  async function importCatalog(file) {
    lrInput.value = '';
    if (!file) return;
    ui.ctx.pickedCatalog = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    try {
      const dry = await send('import_lightroom_catalog', { dryRun: true });
      if (dry.status !== 'ok') return;
      const d = dry.result;
      const body = h('div', {}, h('p', {}, `${file.name} matches ${d.photos} photo${d.photos === 1 ? '' : 's'} in this folder, with ${d.virtualCopies} virtual cop${d.virtualCopies === 1 ? 'y' : 'ies'} and ${d.collections.length} collection${d.collections.length === 1 ? '' : 's'}.`),
        d.unmatchedCount ? h('p', { class: 'hint' }, `${d.unmatchedCount} catalog photo${d.unmatchedCount === 1 ? ' is' : 's are'} not in this folder, for example ${d.unmatched.slice(0, 3).join(', ')}.`) : null,
        d.skipped.length ? h('p', { class: 'hint' }, `Not imported: ${d.skipped.slice(0, 3).map((s) => `${s.what} (${s.reason})`).join('; ')}.`) : null,
        h('p', { class: 'hint' }, 'Ratings, picks, labels and keywords are written to the photos’ sidecars. Develop settings fill only photos you have not edited in Atelier.'));
      const ok = await ui.dialogs.ask('Import Lightroom catalog', body, [{ label: 'Cancel', value: false }, { label: 'Import', value: true, primary: true }], false);
      if (!ok) return;
      const r = await send('import_lightroom_catalog', {});
      if (r.status === 'ok') { ui.say(`Imported ${r.result.photos} photos from ${file.name}.`); refresh(); }
    } finally { ui.ctx.pickedCatalog = null; }
  }

  // Keyboard culling on the focused or open photo: 0–5 rating, P pick, X reject, U unflag, 6–9 labels.
  function key(e) {
    const k0 = anchor || ui.ctx.activePhoto;
    if (!k0 || !photos.some((p) => keyOf(p) === k0)) return false;
    const t = targets(k0);
    if (/^[0-5]$/.test(e.key)) { cull(t, { rating: Number(e.key) }); return true; }
    const k = e.key.toLowerCase();
    if (k === 'p') { cull(t, { flag: 'pick' }); return true; }
    if (k === 'x') { cull(t, { flag: 'reject' }); return true; }
    if (k === 'u') { cull(t, { flag: 'none' }); return true; }
    if (/^[6-9]$/.test(e.key)) { cull(t, { label: ['red', 'yellow', 'green', 'blue'][Number(e.key) - 6] }); return true; }
    return false;
  }

  return { refresh, draw, key, get selected() { return selectedPaths(); }, get photos() { return photos; } };
}
