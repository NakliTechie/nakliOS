// The Export dialog: format, quality, size and colour space, sent as one export_image call. The autosaver
// flushes first, so the export and the saved document agree. Replacing an existing file comes back
// `staged` and waits in the staged-actions bar for the person's Confirm.

import { h } from './dom.js';

const FORMATS = [['jpeg', 'JPEG'], ['png', 'PNG'], ['webp', 'WebP'], ['avif', 'AVIF'], ['tiff16', 'TIFF 16-bit']];
const SPACES = [['srgb', 'sRGB'], ['display-p3', 'Display P3'], ['rec2020', 'Rec. 2020']];

export function exportFields(doc, last = {}) {
  const stem = (doc?.title || 'export').replace(/\.[^.]+$/, '');
  return { name: last.name ?? `exports/${stem}`, format: last.format ?? 'jpeg', quality: last.quality ?? 90, maxEdge: last.maxEdge ?? '', colorSpace: last.colorSpace ?? 'srgb' };
}

// Form values → export_image arguments (without revision). Throws a message for a bad field.
export function exportArgs(v) {
  const args = { path: String(v.name).trim(), format: v.format };
  if (!args.path) throw new Error('Name the file.');
  if (['jpeg', 'webp', 'avif'].includes(v.format)) args.quality = Math.min(100, Math.max(1, Math.round(Number(v.quality) || 90)));
  if (v.maxEdge !== '' && v.maxEdge != null) { const m = Math.round(Number(v.maxEdge)); if (!(m >= 16)) throw new Error('Long edge is at least 16 px, or empty for full size.'); args.maxEdge = m; }
  if (v.colorSpace && v.colorSpace !== 'srgb') args.colorSpace = v.colorSpace;
  return args;
}

export function createExport(ui) {
  let last = {};
  return async function openExport() {
    const doc = ui.store.doc;
    if (!doc) { ui.say('Open a photo or document before exporting.'); return null; }
    const v = exportFields(doc, last);
    const name = h('input', { type: 'text', value: v.name, 'aria-label': 'File' });
    const format = h('select', { 'aria-label': 'Format' }, FORMATS.map(([k, t]) => h('option', { value: k, selected: k === v.format }, t)));
    const quality = h('input', { type: 'number', min: 1, max: 100, value: v.quality, 'aria-label': 'Quality' });
    const maxEdge = h('input', { type: 'number', min: 16, placeholder: `${Math.max(doc.width, doc.height)} (full size)`, value: v.maxEdge, 'aria-label': 'Long edge in pixels' });
    const space = h('select', { 'aria-label': 'Colour space' }, SPACES.map(([k, t]) => h('option', { value: k, selected: k === v.colorSpace }, t)));
    const qRow = h('label', { class: 'field' }, h('span', {}, 'Quality'), quality);
    const sync = () => { qRow.hidden = !['jpeg', 'webp', 'avif'].includes(format.value); };
    format.addEventListener('change', sync); sync();
    const body = h('div', { class: 'form', dataset: { command: 'export_image' } },
      h('label', { class: 'field' }, h('span', {}, 'File'), name),
      h('label', { class: 'field' }, h('span', {}, 'Format'), format), qRow,
      h('label', { class: 'field' }, h('span', {}, 'Long edge (px)'), maxEdge),
      h('label', { class: 'field' }, h('span', {}, 'Colour space'), space),
      h('p', { class: 'hint' }, `${doc.width} × ${doc.height} px. Files go to the workspace's exports folder unless the name says otherwise.`));
    const answer = await ui.dialogs.raw({ title: 'Export', body, actions: [{ label: 'Cancel', value: null }, { label: 'Export', primary: true, value: () => ({ name: name.value, format: format.value, quality: quality.value, maxEdge: maxEdge.value, colorSpace: space.value }) }] });
    if (!answer) return null;
    last = answer;
    let args;
    try { args = exportArgs(answer); } catch (e) { await ui.dialogs.info('Export', e.message); return null; }
    await ui.flush?.();
    ui.say('Exporting…');
    const r = await ui.send('export_image', args);
    if (r.status === 'ok') ui.say(`Exported ${r.result.path} (${r.result.width} × ${r.result.height}, ${Math.round(r.result.bytes / 1024)} KB).`);
    else if (r.status === 'staged') ui.say('The export replaces a file that exists: confirm or discard it in the bar below.');
    else await ui.dialogs.info('Export did not run', `${r.status}: ${r.error?.message ?? ''}`);
    return r;
  };
}
