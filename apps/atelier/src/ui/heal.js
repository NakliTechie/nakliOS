// The Content-aware fill button (P41): fills the selection from the surrounding image into a new layer
// above the active layer (content_aware_fill). Mounted in the header by src/ui/index.js.

import { h } from './dom.js';

export function createFillButton(ui) {
  return h('button', {
    dataset: { command: 'content_aware_fill' }, title: 'Fill the selection from the surrounding image, into a new layer (no AI model)',
    onclick: async () => {
      const doc = ui.store.doc;
      if (!doc) { ui.say('Open a photo first.'); return; }
      if (!doc.selection) { ui.say('Select the area to fill first (a selection tool), then Content-aware fill.'); return; }
      ui.say('Filling…');
      const r = await ui.send('content_aware_fill', { layerId: doc.activeLayerId });
      if (r.status === 'ok') { ui.say(`Filled ${r.result.hole.pixels} pixels into ${r.result.layer.name}.`); ui.render(); }
    },
  }, 'Content-aware fill');
}

// The Smart objects menu (P12, P13): convert the picked layers (or the active one), place a filmstrip
// photo as a linked or embedded smart object, and check linked ones, offering Update for each change.
export function createSmartMenu(ui, pickedLayers) {
  const run = async (v) => {
    const doc = ui.store.doc;
    if (!doc) { ui.say('Open or create a document first.'); return; }
    if (v === 'convert') {
      const ids = pickedLayers().length ? pickedLayers() : [doc.activeLayerId];
      const r = await ui.send('convert_to_smart_object', { layerIds: ids });
      if (r.status === 'ok') { ui.say(`${r.result.layer.name}: ${r.result.smart.layers} layer${r.result.smart.layers === 1 ? '' : 's'} in a smart object.`); ui.render(); }
    } else if (v === 'linked' || v === 'embedded') {
      const path = ui.filmstrip?.selected?.[0];
      if (!path) { ui.say('Select a photo in the filmstrip first, then place it.'); return; }
      const r = await ui.send('place_smart_object', { path, linked: v === 'linked' });
      if (r.status === 'ok') ui.render();
    } else if (v === 'check') {
      const r = await ui.read('check_smart_objects', {});
      if (r.status !== 'ok') return;
      const changed = r.result.smartObjects.filter((x) => x.changed);
      if (!changed.length) { ui.say(`${r.result.smartObjects.length} smart object${r.result.smartObjects.length === 1 ? '' : 's'}; no linked photo changed.`); ui.notice?.(''); return; }
      ui.notice?.(`${changed.length} linked smart object${changed.length === 1 ? '' : 's'} changed on disk (${changed.map((x) => x.path.split('/').pop()).join(', ')}).`, [{ label: 'Update', run: async () => {
        for (const x of changed) await ui.send('update_smart_object', { layerId: x.layerId });
        ui.notice?.(''); ui.render();
      } }]);
    }
  };
  return h('select', { 'aria-label': 'Smart objects', onchange: (e) => { const v = e.target.value; e.target.value = ''; run(v); } },
    h('option', { value: '' }, 'Smart objects…'),
    h('option', { value: 'convert', dataset: { command: 'convert_to_smart_object' } }, 'Convert picked layers to smart object'),
    h('option', { value: 'linked', dataset: { command: 'place_smart_object' } }, 'Place selected photo, linked'),
    h('option', { value: 'embedded', dataset: { command: 'place_smart_object' } }, 'Place selected photo, embedded'),
    h('option', { value: 'check', dataset: { command: 'check_smart_objects' } }, 'Check linked smart objects'));
}
