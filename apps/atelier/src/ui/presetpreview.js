// Preset preview (L57): opening this section renders up to 8 presets on the current photo as thumbnails
// (preview_presets applies each to a scratch copy; the document is unchanged). Clicking a thumbnail applies
// that preset through apply_preset, the same command the preset menu sends.

import { h } from './dom.js';
import { decodeJpeg } from './compare.js';

export function createPresetPreview(root, ui) {
  const grid = h('div', { class: 'pp-grid' });
  const note = h('div', { class: 'hint' });
  const box = h('details', { class: 'views-section', dataset: { viewLabel: 'Preset previews (thumbnails before applying)' }, ontoggle: () => { if (box.open) refresh(true); } },
    h('summary', {}, 'Preset previews'), grid, note);
  root.append(box);
  let lastRev = -1; let timer = null; let busy = false;

  const rawLayer = () => { const d = ui.ctx.store.doc; if (!d) return null; const raws = d.layers.filter((l) => l.kind === 'raw' && !l.localOf); return raws.find((l) => l.id === d.activeLayerId) ?? raws[0] ?? null; };

  async function refresh(force = false) {
    if (!box.open || busy) return;
    const rev = ui.ctx.bus.state.revision; if (!force && rev === lastRev) return;
    const layer = rawLayer();
    if (!layer) { grid.replaceChildren(); note.textContent = 'Open a RAW photo to preview presets on it.'; return; }
    busy = true; lastRev = rev;
    try {
      const list = await ui.read('list_presets');
      const names = list.status === 'ok' ? list.result.presets.slice(0, 8).map((p) => p.path) : [];
      if (!names.length) { grid.replaceChildren(); note.textContent = list.status === 'ok' ? 'No presets in presets/ yet. Save one from the Develop panel.' : `Presets: ${list.error?.message ?? list.status}`; return; }
      note.textContent = 'Rendering previews…';
      const r = await ui.read('preview_presets', { presets: names, layerId: layer.id, maxEdge: 192 });
      if (r.status !== 'ok') { note.textContent = `Preview: ${r.error?.message ?? r.status}`; return; }
      const cells = await Promise.all(r.result.previews.map(async (p) => {
        const name = p.preset.split('/').pop().replace(/\.[^.]+$/, '');
        if (p.status !== 'ok') return h('div', { class: 'pp-cell dim', title: p.message }, h('div', { class: 'pp-none' }, '—'), h('span', {}, name));
        const c = h('canvas', { width: p.width, height: p.height }); c.getContext('2d').drawImage(await decodeJpeg(p), 0, 0);
        return h('button', { class: 'pp-cell', title: `Apply ${name}`, dataset: { command: 'apply_preset', preset: p.preset }, onclick: () => ui.send('apply_preset', { layerIds: [layer.id], preset: p.preset }) }, c, h('span', {}, name));
      }));
      grid.replaceChildren(...cells);
      note.textContent = 'Click a preview to apply it.';
    } finally { busy = false; }
  }
  return {
    render() { if (!box.open) return; clearTimeout(timer); timer = setTimeout(() => refresh().catch((e) => { note.textContent = e.message; }), 600); },
    get open() { return box.open; }, set open(v) { box.open = v; }, refresh,
  };
}
