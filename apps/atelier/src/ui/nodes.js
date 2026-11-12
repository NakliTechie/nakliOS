// Node view of the layer stack (L70): a second view of the same document, no new model. Each layer is a
// node (adjustment layers show their type and mask), edges follow stack order bottom to top, a group's
// children come before the group's own blend node. Editing a node sends the commands the Layers panel
// sends: set_layer (visible, opacity, blend), set_adjustment (type, params), move_layer (one step).

import { h, svg } from './dom.js';
import { moveIndex } from './geometry.js';

const maskText = (l) => (l.mask?.components?.length ? `${l.mask.invert ? 'inverted ' : ''}mask: ${l.mask.components.map((c) => c.kind).join(' + ')}` : null);

// Graph from a document: nodes in compositing order with input and output ends, edges between neighbours.
export function buildGraph(doc) {
  const nodes = [{ id: 'input', kind: 'input', label: 'Transparent canvas', depth: 0 }];
  const walk = (parentId, depth) => {
    for (const l of doc.layers.filter((x) => (x.parentId ?? null) === parentId)) {
      if (l.kind === 'group') walk(l.id, depth + 1);
      nodes.push({
        id: l.id, layerId: l.id, depth, label: l.name, visible: l.visible, opacity: Math.round(l.opacity * 100), blend: l.blend,
        kind: l.kind === 'adjustment' ? 'adjustment' : l.localOf ? 'local' : l.kind === 'group' ? 'group' : 'source',
        ...(l.adjustment ? { type: l.adjustment.type, params: l.adjustment.params } : {}),
        ...(l.localOf ? { localOf: l.localOf } : {}), mask: maskText(l), ...(l.parentId ? { parentId: l.parentId } : {}),
      });
    }
  };
  walk(null, 0);
  nodes.push({ id: 'output', kind: 'output', label: 'Output', depth: 0 });
  const edges = nodes.slice(1).map((n, i) => [nodes[i].id, n.id]);
  return { nodes, edges };
}

// The command and arguments a node edit sends (null when the edit has nothing to do).
// edit: { visible } | { opacity } | { blendMode } | { type } | { params } | { move: 'up' | 'down' }
export function nodeEditArgs(doc, layerId, edit) {
  const l = doc.layers.find((x) => x.id === layerId); if (!l) return null;
  if ('visible' in edit || 'opacity' in edit || 'blendMode' in edit) return ['set_layer', { layerId, ...edit }];
  if ('type' in edit || 'params' in edit) {
    if (l.kind !== 'adjustment') return null;
    return ['set_adjustment', { layerId, ...(edit.type ? { type: edit.type, params: edit.params ?? {} } : { params: edit.params }) }];
  }
  if (edit.move) {
    const sib = doc.layers.filter((x) => (x.parentId ?? null) === (l.parentId ?? null) && !x.localOf);
    const i = sib.findIndex((x) => x.id === layerId);
    const target = sib[edit.move === 'up' ? i + 1 : i - 1]; if (!target) return null;
    const m = moveIndex(doc.layers, layerId, target.id, edit.move === 'up' ? 'above' : 'below');
    return m.error ? null : ['move_layer', { layerId, index: m.index }];
  }
  return null;
}

const ADJ_TYPES = ['levels', 'curves', 'hue-saturation', 'exposure', 'colour-balance', 'black-and-white', 'develop'];

export function createNodeView(ui) {
  const stage = document.querySelector('#stage');
  const canvas = h('div', { class: 'nodes-graph' }); const inspector = h('div', { class: 'nodes-inspector' });
  const root = h('div', { class: 'view-overlay', hidden: true, role: 'region', 'aria-label': 'Node view' },
    h('div', { class: 'cmp-bar' }, h('strong', {}, 'Node view'), h('span', { class: 'dim' }, 'the layer stack as nodes; edits go through the same commands as the Layers panel'), h('span', { class: 'grow' }), h('button', { onclick: () => close() }, 'Close (Esc)')),
    h('div', { class: 'nodes-body' }, canvas, inspector));
  stage.append(root);
  let selected = null;

  const send = async (edit) => {
    const doc = ui.ctx.store.doc; if (!doc || !selected) return null;
    const call = nodeEditArgs(doc, selected, edit); if (!call) return null;
    const [cmd, args] = call;
    const r = cmd === 'set_layer' ? await ui.send('set_layer', args) : cmd === 'set_adjustment' ? await ui.send('set_adjustment', args) : await ui.send('move_layer', args);
    render(); return r;
  };

  function render() {
    if (root.hidden) return;
    const doc = ui.ctx.store.doc;
    if (!doc) { canvas.replaceChildren(h('p', { class: 'hint' }, 'No document.')); inspector.replaceChildren(); return; }
    const g = buildGraph(doc);
    const W = 150; const H = 56; const gap = 34; const pad = 16;
    const width = pad * 2 + g.nodes.length * W + (g.nodes.length - 1) * gap; const maxD = Math.max(0, ...g.nodes.map((n) => n.depth));
    const y = (n) => pad + n.depth * 22; const x = (i) => pad + i * (W + gap);
    const pic = svg('svg', { width, height: pad * 2 + H + maxD * 22 + 10, class: 'nodes-svg', role: 'img', 'aria-label': `${g.nodes.length - 2} layers as nodes` },
      ...g.edges.map(([a, b]) => { const i = g.nodes.findIndex((n) => n.id === a); const j = g.nodes.findIndex((n) => n.id === b); return svg('path', { d: `M${x(i) + W} ${y(g.nodes[i]) + H / 2} C${x(i) + W + gap / 2} ${y(g.nodes[i]) + H / 2} ${x(j) - gap / 2} ${y(g.nodes[j]) + H / 2} ${x(j)} ${y(g.nodes[j]) + H / 2}`, class: 'nodes-edge' }); }),
      ...g.nodes.map((n, i) => svg('g', { class: `nodes-node k-${n.kind}${n.id === selected ? ' on' : ''}${n.visible === false ? ' off' : ''}`, transform: `translate(${x(i)} ${y(n)})`, tabindex: n.layerId ? 0 : null, dataset: { node: n.id },
        onclick: () => { if (n.layerId) { selected = n.layerId; render(); } } },
      svg('rect', { width: W, height: H, rx: 6 }),
      svg('text', { x: 8, y: 18, class: 'nodes-title' }, n.label.slice(0, 22)),
      svg('text', { x: 8, y: 34, class: 'nodes-sub' }, n.kind === 'adjustment' ? n.type : n.kind === 'group' ? 'group blend' : n.kind === 'local' ? 'local adjustment' : n.kind === 'source' ? `${n.blend} ${n.opacity}%` : ''),
      n.mask ? svg('text', { x: 8, y: 49, class: 'nodes-sub' }, n.mask.slice(0, 26)) : null)));
    canvas.replaceChildren(pic);
    drawInspector(doc);
  }
  function drawInspector(doc) {
    const l = doc.layers.find((x) => x.id === selected);
    if (!l) { inspector.replaceChildren(h('p', { class: 'hint' }, 'Click a node to edit its layer.')); return; }
    const parts = [h('strong', {}, l.name),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: l.visible, dataset: { command: 'set_layer' }, onchange: (e) => send({ visible: e.target.checked }) }), 'Visible'),
      h('label', { class: 'field' }, h('span', {}, 'Opacity'), h('input', { type: 'range', min: 0, max: 100, value: Math.round(l.opacity * 100), dataset: { command: 'set_layer', param: 'opacity' }, onchange: (e) => send({ opacity: Number(e.target.value) }) })),
      h('div', { class: 'row' }, h('button', { dataset: { command: 'move_layer' }, onclick: () => send({ move: 'down' }) }, 'Earlier in stack'), h('button', { dataset: { command: 'move_layer' }, onclick: () => send({ move: 'up' }) }, 'Later in stack'))];
    if (l.kind === 'adjustment') {
      parts.push(h('label', { class: 'field' }, h('span', {}, 'Type'), h('select', { dataset: { command: 'set_adjustment' }, onchange: (e) => send({ type: e.target.value }) }, ADJ_TYPES.map((t) => h('option', { value: t, selected: t === l.adjustment.type }, t)))));
      for (const [k, v] of Object.entries(l.adjustment.params || {})) {
        if (typeof v !== 'number') { parts.push(h('div', { class: 'hint' }, `${k}: ${JSON.stringify(v).slice(0, 40)} (edit in the Layers panel)`)); continue; }
        parts.push(h('label', { class: 'field' }, h('span', {}, k), h('input', { type: 'number', value: v, step: 'any', dataset: { command: 'set_adjustment', param: k }, onchange: (e) => send({ params: { [k]: Number(e.target.value) } }) })));
      }
    }
    if (l.mask) parts.push(h('p', { class: 'hint' }, `${maskText(l)}; edit masks in the Layers or Develop panel.`));
    inspector.replaceChildren(...parts);
  }
  function open() { if (ui.ctx.view.mode !== 'composite') document.querySelector('button.mode[data-mode="composite"]')?.click(); root.hidden = false; selected ||= ui.ctx.store.doc?.activeLayerId ?? null; render(); }
  function close() { root.hidden = true; }
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden) close(); });
  return { open, close, render, send, select: (id) => { selected = id; render(); }, get isOpen() { return !root.hidden; } };
}
