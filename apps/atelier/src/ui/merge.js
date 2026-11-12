// The Merge… button (L44 panorama, L45 HDR, L46 focus stack): merges the photos selected in the
// filmstrip (Ctrl/Shift click) through merge_hdr, merge_panorama or merge_focus_stack. The result is a
// new file beside the first photo and opens as a new document. Mounted in the header by src/ui/index.js.

import { h } from './dom.js';

export function createMergeButton(ui) {
  return h('button', {
    dataset: { command: 'merge_hdr' }, title: 'Merge the photos selected in the filmstrip into an HDR, a panorama or a focus stack (no AI model)',
    onclick: async () => {
      const paths = ui.filmstrip?.selected || [];
      if (paths.length < 2) { ui.say('Select two or more photos in the filmstrip first (Ctrl-click or Shift-click), then Merge.'); return; }
      const kind = h('select', { 'aria-label': 'Merge kind' },
        h('option', { value: 'merge_hdr', dataset: { command: 'merge_hdr' } }, 'HDR (bracketed exposures)'),
        h('option', { value: 'merge_panorama', dataset: { command: 'merge_panorama' } }, 'Panorama (overlapping frames)'),
        h('option', { value: 'merge_focus_stack', dataset: { command: 'merge_focus_stack' } }, 'Focus stack (different focus distances)'));
      const align = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Align frames' });
      const deghost = h('select', { 'aria-label': 'Deghost' }, ['off', 'low', 'medium', 'high'].map((v) => h('option', { value: v }, v)));
      const projection = h('select', { 'aria-label': 'Projection' }, ['cylindrical', 'spherical', 'perspective'].map((v) => h('option', { value: v }, v)));
      const rows = {
        align: h('label', { class: 'field' }, h('span', {}, 'Align frames'), align),
        deghost: h('label', { class: 'field' }, h('span', {}, 'Deghost'), deghost),
        projection: h('label', { class: 'field' }, h('span', {}, 'Projection'), projection),
      };
      const show = () => {
        rows.align.hidden = kind.value === 'merge_panorama';
        rows.deghost.hidden = kind.value !== 'merge_hdr';
        rows.projection.hidden = kind.value !== 'merge_panorama';
      };
      kind.addEventListener('change', show); show();
      const body = h('div', { class: 'form' },
        h('p', { class: 'dim' }, `${paths.length} photos: ${paths.map((p) => p.split('/').pop()).join(', ')}`),
        h('label', { class: 'field' }, h('span', {}, 'Merge'), kind), rows.align, rows.deghost, rows.projection);
      const v = await ui.dialogs.raw({ title: 'Merge photos', body, actions: [{ label: 'Cancel', value: null }, { label: 'Merge', primary: true, value: () => kind.value }] });
      if (!v) return;
      const args = { paths, ...(v === 'merge_hdr' ? { align: align.checked, deghost: deghost.value } : v === 'merge_panorama' ? { projection: projection.value } : { align: align.checked }) };
      ui.say(`Merging ${paths.length} photos…`);
      const r = await ui.send(v, args);
      if (r.status === 'ok') {
        const x = r.result;
        ui.say(`Wrote ${x.path} (${x.width} × ${x.height}, ${x.format})${x.exposure ? `; exposure +${x.exposure} EV matches the middle bracket` : ''}.`);
        ui.filmstrip?.refresh(); ui.render();
      }
    },
  }, 'Merge…');
}
