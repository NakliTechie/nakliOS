// The filmstrip: list_folder's photos with rating, flag and colour label, filtered by the same three
// (Lightroom's Library conventions). A click opens the photo (open_photo); Ctrl or Cmd click and Shift
// click select several for sync and paste. Ratings, flags and labels write sidecars through set_rating.

import { h } from './dom.js';

const LABELS = ['none', 'red', 'yellow', 'green', 'blue', 'purple'];

export function createFilmstrip(root, ui) {
  const { send } = ui;
  let photos = []; let page = 0; let pages = 1; let total = 0;
  const filter = { minRating: 0, flag: '', label: '' };
  const selected = new Set(); let anchor = null;

  const strip = h('div', { class: 'strip', role: 'listbox', 'aria-label': 'Photos in the folder', 'aria-multiselectable': 'true' });
  const count = h('span', { class: 'dim' });
  const sel = (label, key, opts) => h('select', { 'aria-label': label, dataset: { command: 'list_folder' }, onchange: (e) => { filter[key] = key === 'minRating' ? Number(e.target.value) : e.target.value; page = 0; refresh(); } }, opts);
  const more = h('button', { dataset: { command: 'list_folder' }, hidden: true, onclick: () => { page = (page + 1) % pages; refresh(); } }, 'Next page');
  const bar = h('div', { class: 'strip-bar' },
    h('strong', {}, 'Filmstrip'), count,
    sel('Minimum rating', 'minRating', [0, 1, 2, 3, 4, 5].map((n) => h('option', { value: n }, n ? `${'★'.repeat(n)} and up` : 'Any rating'))),
    sel('Flag', 'flag', [['', 'Any flag'], ['pick', 'Picks'], ['reject', 'Rejects'], ['none', 'Unflagged']].map(([v, t]) => h('option', { value: v }, t))),
    sel('Label', 'label', [['', 'Any label'], ...LABELS.map((l) => [l, l === 'none' ? 'No label' : l])].map(([v, t]) => h('option', { value: v }, t))),
    more, h('span', { class: 'grow' }),
    h('button', { dataset: { command: 'open_photo' }, title: 'Add the selected photo to the open document as a layer', onclick: () => placeSelected() }, 'Place as layer'),
    h('button', { dataset: { command: 'sync_settings' }, title: 'Copy the open photo’s settings to the selected photos', onclick: () => ui.syncSettings() }, 'Sync…'));
  root.append(bar, strip);

  const cull = (paths, patch) => send('set_rating', { paths, ...patch }).then((r) => { if (r.status === 'ok') refresh(); return r; });
  const targets = (path) => (selected.has(path) && selected.size > 1 ? [...selected] : [path]);

  function tile(p) {
    const name = p.path.split('/').pop();
    const stars = h('span', { class: 'stars', role: 'radiogroup', 'aria-label': 'Rating' }, [1, 2, 3, 4, 5].map((n) => h('button', {
      class: n <= p.rating ? 'on' : null, 'aria-label': `${n} star${n > 1 ? 's' : ''}`, dataset: { command: 'set_rating' },
      onclick: (e) => { e.stopPropagation(); cull(targets(p.path), { rating: p.rating === n ? 0 : n }); },
    }, '★')));
    const flag = (f, glyph, label) => h('button', { class: `flag ${p.flag === f ? 'on' : ''}`, 'aria-label': label, 'aria-pressed': String(p.flag === f), dataset: { command: 'set_rating' }, onclick: (e) => { e.stopPropagation(); cull(targets(p.path), { flag: p.flag === f ? 'none' : f }); } }, glyph);
    const label = h('select', { class: `lab lab-${p.label}`, 'aria-label': 'Colour label', dataset: { command: 'set_rating' }, onclick: (e) => e.stopPropagation(), onchange: (e) => cull(targets(p.path), { label: e.target.value }) },
      LABELS.map((l) => h('option', { value: l, selected: l === p.label }, l === 'none' ? '–' : l)));
    const active = ui.ctx.activePhoto === p.path;
    return h('div', {
      class: ['tile', selected.has(p.path) ? 'sel' : '', active ? 'active' : '', p.flag === 'reject' ? 'rejected' : ''].join(' '),
      role: 'option', 'aria-selected': String(selected.has(p.path)), tabindex: 0, title: p.path, dataset: { command: 'open_photo', path: p.path },
      onclick: (e) => choose(p.path, e), onkeydown: (e) => { if (e.key === 'Enter') choose(p.path, {}); },
    }, h('span', { class: 'kind' }, p.kind === 'raw' ? 'RAW' : name.split('.').pop().toUpperCase()), h('span', { class: 'fname' }, name), h('span', { class: 'meta' }, stars, flag('pick', '⚑', 'Pick'), flag('reject', '✕', 'Reject'), label));
  }

  function choose(path, e) {
    if (e.metaKey || e.ctrlKey) { if (selected.has(path)) selected.delete(path); else selected.add(path); anchor = path; draw(); return; }
    if (e.shiftKey && anchor) {
      const a = photos.findIndex((p) => p.path === anchor); const b = photos.findIndex((p) => p.path === path);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(photos[i].path);
      draw(); return;
    }
    selected.clear(); selected.add(path); anchor = path;
    ui.openPhoto(path);
  }

  async function placeSelected() {
    const path = anchor || [...selected][0];
    if (!path) { ui.say('Select a photo in the filmstrip first.'); return; }
    if (!ui.store.doc) { ui.say('Open or create a document first; Place adds the photo as a layer.'); return; }
    await send('open_photo', { path, asLayer: true });
  }

  function draw() {
    strip.replaceChildren(...(photos.length ? photos.map(tile) : [h('p', { class: 'hint' }, ui.ctx.storage() ? 'No photos here. Add RAW or JPEG files to the folder, or open a folder.' : 'No storage yet.')]));
    count.textContent = `${total} photo${total === 1 ? '' : 's'}${selected.size > 1 ? ` · ${selected.size} selected` : ''}`;
    more.hidden = pages < 2; more.textContent = `Page ${page + 1} of ${pages}`;
  }

  async function refresh() {
    const f = {};
    if (filter.minRating) f.minRating = filter.minRating;
    if (filter.flag) f.flag = filter.flag;
    if (filter.label) f.label = filter.label;
    const r = await ui.read('list_folder', { ...(Object.keys(f).length ? { filter: f } : {}), page });
    if (r.status === 'ok') { photos = r.result.photos; pages = r.result.pages; total = r.result.total; } else { photos = []; pages = 1; total = 0; }
    for (const p of [...selected]) if (!photos.some((x) => x.path === p)) selected.delete(p);
    draw();
  }

  // Keyboard culling on the focused or open photo: 0–5 rating, P pick, X reject, U unflag, 6–9 labels.
  function key(e) {
    const path = anchor || ui.ctx.activePhoto;
    if (!path || !photos.some((p) => p.path === path)) return false;
    const t = targets(path);
    if (/^[0-5]$/.test(e.key)) { cull(t, { rating: Number(e.key) }); return true; }
    const k = e.key.toLowerCase();
    if (k === 'p') { cull(t, { flag: 'pick' }); return true; }
    if (k === 'x') { cull(t, { flag: 'reject' }); return true; }
    if (k === 'u') { cull(t, { flag: 'none' }); return true; }
    if (/^[6-9]$/.test(e.key)) { cull(t, { label: ['red', 'yellow', 'green', 'blue'][Number(e.key) - 6] }); return true; }
    return false;
  }

  return { refresh, draw, key, get selected() { return [...selected]; }, get photos() { return photos; } };
}
