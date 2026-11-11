// Composite mode, layers panel (top of stack first, as Photoshop shows it): visibility, lock, opacity,
// blend mode (all 27), rename, drag to reorder (move_layer), group and ungroup, duplicate, delete, merge
// and a summary of each layer's mask. A click makes a layer active (set_active); Ctrl or Cmd click adds
// it to the panel's multi-selection, which only the panel holds (it names the layers for group or merge).

import { h } from './dom.js';
import { moveIndex } from './geometry.js';

const BLEND_GROUPS = [
  ['normal', 'dissolve'], ['darken', 'multiply', 'color-burn', 'linear-burn', 'darker-color'],
  ['lighten', 'screen', 'color-dodge', 'linear-dodge', 'lighter-color'],
  ['overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix'],
  ['difference', 'exclusion', 'subtract', 'divide'], ['hue', 'saturation', 'color', 'luminosity'],
];
export const BLEND_MODES = BLEND_GROUPS.flat();
const pretty = (m) => m.split('-').map((w, i) => (i ? w : w[0].toUpperCase() + w.slice(1))).join(' ');

export function createLayersPanel(root, ui) {
  const { send } = ui;
  const picked = new Set();
  let dragId = null;
  const list = h('ul', { class: 'layers', 'aria-label': 'Layers' });
  const opacity = h('input', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Opacity', dataset: { command: 'set_layer', param: 'opacity' } });
  const opOut = h('output', {}, '100%');
  const blend = h('select', { 'aria-label': 'Blend mode', dataset: { command: 'set_layer', param: 'blendMode' } },
    BLEND_GROUPS.map((g, i) => [i ? h('option', { disabled: true }, '──────') : null, g.map((m) => h('option', { value: m }, pretty(m)))]));
  const active = () => ui.store.doc?.layers.find((l) => l.id === ui.store.doc.activeLayerId) || null;
  const opLane = ui.latest('layer-opacity', 'set_layer', (v) => ({ layerId: v.id, opacity: v.value }));
  opacity.addEventListener('input', () => { const l = active(); if (!l) return; opOut.textContent = `${opacity.value}%`; opLane.push({ id: l.id, value: Number(opacity.value) }); });
  blend.addEventListener('change', () => { const l = active(); if (l) send('set_layer', { layerId: l.id, blendMode: blend.value }); });

  const chosen = () => { const l = active(); const ids = picked.size ? [...picked] : l ? [l.id] : []; return ids; };
  const btn = (label, command, onclick, t) => h('button', { dataset: { command }, title: t, onclick }, label);
  const tools = h('div', { class: 'row wrap' },
    btn('New layer', 'add_layer', () => send('add_layer', { kind: 'raster', name: 'Layer' })),
    btn('New group', 'add_layer', () => send('add_layer', { kind: 'group', name: 'Group' })),
    btn('Group', 'group_layers', () => { const ids = chosen(); if (ids.length) send('group_layers', { action: 'group', layerIds: ids }).then(() => picked.clear()); }, 'Ctrl+G'),
    btn('Ungroup', 'group_layers', () => { const ids = chosen().filter((id) => ui.store.doc.layers.find((l) => l.id === id)?.kind === 'group'); if (ids.length) send('group_layers', { action: 'ungroup', layerIds: ids }); else ui.say('Select a group to ungroup.'); }, 'Ctrl+Shift+G'),
    btn('Duplicate', 'duplicate_layer', () => { const l = active(); if (l) send('duplicate_layer', { layerId: l.id }); }, 'Ctrl+J'),
    btn('Merge down', 'merge_layers', () => { if (picked.size > 1) send('merge_layers', { mode: 'selected', layerIds: [...picked] }).then(() => picked.clear()); else send('merge_layers', { mode: 'down' }); }, 'Ctrl+E (merges the picked layers when several are picked)'),
    btn('Delete', 'delete_layer', () => { const l = active(); if (l) send('delete_layer', { layerId: l.id }); }, 'Delete'));
  root.append(h('div', { class: 'row' }, blend, opacity, opOut), list, tools);

  const depth = (doc, l) => { let d = 0; for (let p = l; p?.parentId; p = doc.layers.find((x) => x.id === p.parentId)) d++; return d; };
  const maskSummary = (l) => (l.mask ? `mask: ${l.mask.components.map((c) => `${c.op === 'add' ? '' : `${c.op} `}${c.kind}`).join(', ')}${l.mask.invert ? ' (inverted)' : ''}` : '');

  function row(doc, l) {
    const id = l.id;
    const li = h('li', {
      class: [id === doc.activeLayerId ? 'active' : '', picked.has(id) ? 'picked' : '', l.kind === 'group' ? 'group' : ''].join(' '),
      draggable: 'true', style: `padding-left:${4 + depth(doc, l) * 14}px`, dataset: { id, command: 'move_layer' },
      ondragstart: (e) => { dragId = id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); },
      ondragover: (e) => { if (!dragId || dragId === id) return; e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); const top = e.clientY < r.top + r.height / 2; e.currentTarget.classList.toggle('drop-above', top); e.currentTarget.classList.toggle('drop-below', !top); },
      ondragleave: (e) => e.currentTarget.classList.remove('drop-above', 'drop-below'),
      ondrop: (e) => { e.preventDefault(); const above = e.currentTarget.classList.contains('drop-above'); e.currentTarget.classList.remove('drop-above', 'drop-below'); drop(id, above ? 'above' : 'below'); },
      ondragend: () => { dragId = null; },
    },
    h('button', { class: 'ico', 'aria-label': `${l.visible ? 'Hide' : 'Show'} ${l.name}`, 'aria-pressed': String(l.visible), dataset: { command: 'set_layer', param: 'visible' }, onclick: () => send('set_layer', { layerId: id, visible: !l.visible }) }, l.visible ? '●' : '○'),
    h('button', { class: 'ico', 'aria-label': `${l.locked ? 'Unlock' : 'Lock'} ${l.name}`, 'aria-pressed': String(l.locked), dataset: { command: 'set_layer', param: 'locked' }, onclick: () => send('set_layer', { layerId: id, locked: !l.locked }) }, l.locked ? '▣' : '□'),
    h('button', {
      class: 'name', title: `${l.kind}${l.mask ? ` · ${maskSummary(l)}` : ''} · double-click to rename`, dataset: { command: 'set_active' },
      onclick: (e) => { if (e.metaKey || e.ctrlKey) { if (picked.has(id)) picked.delete(id); else picked.add(id); render(); return; } picked.clear(); send('set_active', { layerId: id }); },
      ondblclick: async () => { const name = await ui.dialogs.promptText('Rename layer', 'Name', l.name); if (name != null && name !== l.name) send('set_layer', { layerId: id, name }); },
    }, l.kind === 'group' ? `▾ ${l.name}` : l.name),
    h('small', {}, `${l.kind === 'group' ? l.isolation ?? 'pass-through' : pretty(l.blend)} ${Math.round(l.opacity * 100)}%${l.mask ? ' · mask' : ''}`));
    return li;
  }

  async function drop(targetId, where) {
    const doc = ui.store.doc; const draggedId = dragId; dragId = null;
    if (!doc || !draggedId) return;
    const m = moveIndex(doc.layers, draggedId, targetId, where);
    if (m.error) { ui.say(m.error); return; }
    const from = doc.layers.find((l) => l.id === draggedId);
    const payload = { layerId: draggedId, index: m.index };
    if ((from?.parentId ?? null) !== m.parentId) {
      if (m.parentId) payload.parentId = m.parentId;
      else { ui.say('To take a layer out of its group, ungroup the group (move_layer cannot name the top level yet).'); return; }
    }
    await send('move_layer', payload);
  }
  function render() {
    const doc = ui.store.doc;
    for (const id of [...picked]) if (!doc?.layers.some((l) => l.id === id)) picked.delete(id);
    list.replaceChildren(...(doc ? [...doc.layers].reverse().filter((l) => !l.localOf).map((l) => row(doc, l)) : [h('li', { class: 'hint' }, 'No document. Open a photo or create a new document.')]));
    const l = active();
    opacity.disabled = blend.disabled = !l || l.kind === 'group';
    if (l && document.activeElement !== opacity) { opacity.value = Math.round(l.opacity * 100); opOut.textContent = `${opacity.value}%`; }
    if (l) blend.value = l.blend;
  }
  return { render, get picked() { return [...picked]; } };
}
