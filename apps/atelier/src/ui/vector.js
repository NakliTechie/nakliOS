// The Vector panel (Composite mode): the pen tool and its canvas, the document paths with path booleans,
// path → selection, vector masks, shape layers, rich type (runs, OpenType features, type on a path,
// warps) and artboards. Every control sends one manifest command; the parity rows are in src/ui/parity.js.
// The pen draws on its own canvas over the photo (#vector-overlay), which takes pointer input only while
// the pen is on, so the other tools' gestures are untouched.

import { h } from './dom.js';
import { screenToDoc, docToScreen } from './geometry.js';
import { isTyping } from './tools.js';
import { parsePath } from '../vector/geom.js';

const HIT = 8;   // CSS px: clicking this close to the first anchor closes the path

export function createVectorPanel(root, ui) {
  const { send, read, store, ctx } = ui;
  const canvas = document.querySelector('#canvas');
  const layer = document.querySelector('#vector-overlay');
  let pen = null;          // { anchors: [{ x, y, hIn, hOut }], drag: index | null } while the pen is on
  let paths = [];          // last list_paths answer
  let boards = [];         // last list_artboards answer
  const picked = new Set();

  // ---- pen tool -----------------------------------------------------------------------------------
  const view = () => ctx.engine?.computeView();
  const rect = () => canvas.getBoundingClientRect();
  const ratio = () => canvas.width / Math.max(1, rect().width);
  const toDoc = (e) => screenToDoc(view(), rect(), ratio(), e.clientX, e.clientY);
  const toScreen = (x, y) => { const r = rect(); const [sx, sy] = docToScreen(view(), r, ratio(), x, y); return [sx - r.left, sy - r.top]; };
  function setPen(on) {
    pen = on ? { anchors: [], drag: null } : null;
    layer.classList.toggle('active', !!pen);
    penBtn.classList.toggle('on', !!pen); penBtn.setAttribute('aria-pressed', String(!!pen));
    draw();
  }
  layer.addEventListener('pointerdown', (e) => {
    if (!pen || e.button !== 0 || !view()) return;
    try { layer.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer has nothing to capture */ }
    const p = toDoc(e); const a0 = pen.anchors[0];
    if (a0 && pen.anchors.length > 2) {
      const [sx, sy] = toScreen(a0.x, a0.y); const r = rect();
      if (Math.hypot(e.clientX - r.left - sx, e.clientY - r.top - sy) <= HIT) { finish(true); return; }
    }
    pen.anchors.push({ x: p[0], y: p[1], hIn: { x: 0, y: 0 }, hOut: { x: 0, y: 0 } });
    pen.drag = pen.anchors.length - 1; draw();
  });
  layer.addEventListener('pointermove', (e) => {
    if (!pen || pen.drag == null) return;
    const a = pen.anchors[pen.drag]; const p = toDoc(e);
    a.hOut = { x: p[0] - a.x, y: p[1] - a.y }; a.hIn = { x: -a.hOut.x, y: -a.hOut.y };   // dragging makes a smooth point
    draw();
  });
  layer.addEventListener('pointerup', () => { if (pen) pen.drag = null; });
  addEventListener('keydown', (e) => {
    if (isTyping(e) || ui.dialogs.open || ctx.view.mode === 'develop') return;
    if (pen && e.key === 'Enter') { e.preventDefault(); finish(false); }
    else if (pen && e.key === 'Escape') { e.preventDefault(); setPen(false); }
    else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'p' && store.doc) { e.preventDefault(); setPen(!pen); }
  });
  async function finish(closed) {
    const anchors = pen.anchors.map((a) => ({ x: a.x, y: a.y, hIn: a.hIn, hOut: a.hOut }));
    setPen(false);
    if (anchors.length < 2) { ui.say('A path needs at least two points.'); return; }
    const r = await send('add_path', { subpaths: [{ closed, anchors }] });
    if (r.status === 'ok') ui.say(`Added ${r.result.path.name}.`);
    refresh();
  }
  // Paints the pen's path in progress and every document path's outline.
  function draw() {
    const r = rect();
    layer.width = Math.round(r.width * devicePixelRatio); layer.height = Math.round(r.height * devicePixelRatio);
    const g = layer.getContext('2d'); g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); g.clearRect(0, 0, r.width, r.height);
    if (!store.doc || !view() || ctx.view.mode === 'develop') return;
    const trace = (model) => {
      g.beginPath();
      for (const sp of model) {
        const A = sp.anchors; if (!A.length) continue;
        g.moveTo(...toScreen(A[0].x, A[0].y));
        const seg = (p, q) => g.bezierCurveTo(...toScreen(p.x + p.hOut.x, p.y + p.hOut.y), ...toScreen(q.x + q.hIn.x, q.y + q.hIn.y), ...toScreen(q.x, q.y));
        for (let i = 0; i + 1 < A.length; i++) seg(A[i], A[i + 1]);
        if (sp.closed) { seg(A.at(-1), A[0]); g.closePath(); }
      }
    };
    g.lineWidth = 1;
    if (showPaths.checked) for (const p of paths) { trace(parsePath(p.d)); g.strokeStyle = picked.has(p.id) ? '#ff7a00' : '#2d7ff9'; g.stroke(); }
    for (const b of boards) { const [x0, y0] = toScreen(b.x, b.y); const [x1, y1] = toScreen(b.x + b.width, b.y + b.height); g.strokeStyle = '#888'; g.setLineDash([4, 3]); g.strokeRect(x0, y0, x1 - x0, y1 - y0); g.setLineDash([]); g.fillStyle = '#e8e8e8'; g.font = '11px sans-serif'; g.fillText(b.name, x0, y0 - 4); }
    if (pen && pen.anchors.length) {
      trace([{ closed: false, anchors: pen.anchors }]); g.strokeStyle = '#2d7ff9'; g.lineWidth = 1.5; g.stroke();
      for (const a of pen.anchors) {
        const [x, y] = toScreen(a.x, a.y);
        if (a.hOut.x || a.hOut.y) for (const hh of [a.hIn, a.hOut]) { const [hx, hy] = toScreen(a.x + hh.x, a.y + hh.y); g.beginPath(); g.moveTo(x, y); g.lineTo(hx, hy); g.strokeStyle = '#2d7ff9'; g.lineWidth = 1; g.stroke(); g.fillStyle = '#2d7ff9'; g.fillRect(hx - 2, hy - 2, 4, 4); }
        g.fillStyle = '#fff'; g.strokeStyle = '#2d7ff9'; g.fillRect(x - 3, y - 3, 6, 6); g.strokeRect(x - 3, y - 3, 6, 6);
      }
    }
  }

  // ---- controls ---------------------------------------------------------------------------------------
  const num = (label, value, attrs = {}) => h('input', { type: 'number', value, 'aria-label': label, title: label, ...attrs });
  const col = (label, value) => h('input', { type: 'color', value, 'aria-label': label, title: label });
  const sel = (label, opts, value) => h('select', { 'aria-label': label, title: label }, opts.map((o) => h('option', { value: o, selected: o === value }, o)));
  const btn = (text, command, onclick, title) => h('button', { dataset: { command }, onclick, title }, text);
  const active = () => store.doc?.layers.find((l) => l.id === store.doc.activeLayerId) || null;
  const ok = (r, msg) => { if (r.status === 'ok' && msg) ui.say(typeof msg === 'function' ? msg(r.result) : msg); refresh(); return r; };

  const penBtn = h('button', { dataset: { view: 'tool:pen' }, 'aria-pressed': 'false', title: 'Pen (P): click for corners, drag for curves, click the first point to close, Enter to finish open, Esc to cancel', onclick: () => setPen(!pen) }, 'Pen');
  const showPaths = h('input', { type: 'checkbox', checked: true, dataset: { view: 'option:show-paths' }, onchange: () => draw() });
  const pathList = h('div', { class: 'vec-list' });
  const feather = num('Feather (px)', 0, { min: 0, max: 500, step: 0.5 });
  const opSel = sel('Selection mode', ['replace', 'add', 'subtract', 'intersect'], 'replace');

  const combine = (op) => async () => {
    const ids = paths.filter((p) => picked.has(p.id)).map((p) => p.id);
    if (ids.length < 2) { ui.say('Tick two or more paths first.'); return; }
    ok(await send('combine_paths', { op, pathIds: ids }), (r) => `${op}: ${r.path.name}, area ${Math.round(r.area)} px².`);
  };
  function pathRow(p) {
    const box = h('input', { type: 'checkbox', checked: picked.has(p.id), 'aria-label': `Pick ${p.name}`, dataset: { view: 'option:pick-path' }, onchange: (e) => { if (e.target.checked) picked.add(p.id); else picked.delete(p.id); draw(); } });
    return h('div', { class: 'vec-item' }, h('div', { class: 'vec-row' }, box, h('span', { class: 'grow', title: p.d.slice(0, 200) }, p.name)), h('div', { class: 'vec-row' },
      btn('Select', 'path_to_selection', async () => ok(await send('path_to_selection', { pathId: p.id, op: opSel.value, feather: Number(feather.value) || 0 }), 'Selected the path.'), 'Make a selection from this path'),
      btn('Mask', 'set_vector_mask', async () => { const l = active(); if (!l) return; ok(await send('set_vector_mask', { layerId: l.id, pathId: p.id, feather: Number(feather.value) || 0 }), `Vector mask on ${l.name}.`); }, 'Vector mask on the active layer'),
      btn('Shape', 'add_shape_layer', async () => ok(await send('add_shape_layer', { shape: { type: 'path', pathId: p.id }, ...paint() }), 'Added a shape layer.'), 'Shape layer from this path'),
      btn('Type', 'set_text', async () => { const l = active(); if (l?.kind !== 'text') { ui.say('Select a type layer first.'); return; } ok(await send('set_text', { layerId: l.id, path: { pathId: p.id, startOffset: Number(startOff.value) || 0 } }), 'Type now runs along the path.'); }, 'Put the active type layer on this path'),
      btn('×', 'delete_path', async () => { picked.delete(p.id); ok(await send('delete_path', { pathId: p.id })); }, 'Delete path')));
  }

  // shapes
  const shapeType = sel('Shape', ['rect', 'rounded-rect', 'ellipse', 'polygon', 'line'], 'rect');
  const radius = num('Corner radius / polygon radius', 40, { min: 0 });
  const sides = num('Polygon sides', 6, { min: 3, max: 100 });
  const fillCol = col('Fill colour', '#4a90d9'); const noFill = h('input', { type: 'checkbox', 'aria-label': 'No fill', dataset: { view: 'option:no-fill' } });
  const strokeCol = col('Stroke colour', '#000000'); const strokeW = num('Stroke width (px)', 0, { min: 0, step: 0.5 });
  const strokeAlign = sel('Stroke align', ['center', 'inside', 'outside'], 'center');
  const dash = h('input', { type: 'text', placeholder: 'dash e.g. 12 6', 'aria-label': 'Dash pattern (px)', size: 8 });
  const paint = () => {
    const w = Number(strokeW.value) || 0; const ds = dash.value.trim() ? dash.value.trim().split(/[\s,]+/).map(Number).filter((v) => v >= 0) : [];
    return { fill: noFill.checked ? 'none' : fillCol.value, ...(w > 0 ? { stroke: { color: strokeCol.value, width: w, align: strokeAlign.value, dash: ds } } : {}) };
  };
  function shapeArgs() {
    const d = store.doc; const s = d.selection?.bounds;
    const [x0, y0, x1, y1] = s || [d.width / 3, d.height / 3, (2 * d.width) / 3, (2 * d.height) / 3];
    const t = shapeType.value; const w = x1 - x0; const hh = y1 - y0;
    if (t === 'polygon') return { type: t, cx: x0 + w / 2, cy: y0 + hh / 2, radius: Math.min(w, hh) / 2, sides: Number(sides.value) || 6 };
    if (t === 'line') return { type: t, x1: x0, y1: y0, x2: x1, y2: y1 };
    return { type: t, x: x0, y: y0, width: w, height: hh, ...(t === 'rounded-rect' ? { radius: Number(radius.value) || 0 } : {}) };
  }

  // type
  const warpSel = sel('Warp', ['none', 'arc', 'arch', 'bulge', 'flag', 'wave'], 'none'); const bend = num('Bend (−100 to 100)', 50, { min: -100, max: 100 });
  const feats = ['liga', 'kern', 'smcp', 'onum'].map((k) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: k, checked: k === 'liga' || k === 'kern', dataset: { view: `option:feature-${k}` } }), k));
  const tracking = num('Tracking (1/1000 em)', 0, { min: -1000, max: 10000, step: 10 });
  const runStart = num('From character', 0, { min: 0 }); const runEnd = num('To character (exclusive)', 1, { min: 1 });
  const runCol = col('Run colour', '#ff0000'); const runSize = num('Run size (px, 0 = keep)', 0, { min: 0 }); const runShift = num('Baseline shift (px)', 0);
  const startOff = num('Start offset on path (%)', 0, { min: 0, max: 100 });
  const textLayer = () => { const l = active(); if (l?.kind !== 'text') { ui.say('Select a type layer first.'); return null; } return l; };

  // artboards
  const boardList = h('div', { class: 'vec-list' });
  async function addArtboard() {
    const d = store.doc; if (!d) return;
    const f = { name: h('input', { type: 'text', value: `Artboard ${boards.length + 1}`, 'aria-label': 'Name' }), x: num('x', boards.length ? Math.max(...boards.map((b) => b.x + b.width)) + 100 : 0), y: num('y', 0),
      width: num('Width', 1080, { min: 1 }), height: num('Height', 1080, { min: 1 }), bg: h('input', { type: 'text', value: '#ffffff', 'aria-label': 'Background (#rrggbb or transparent)' }) };
    const grow = h('input', { type: 'checkbox', checked: true });
    // Moving the selected layer onto the board is the person's explicit choice: an artboard draws below every
    // layer outside it, so a silent move hid a shape under the photo (filming defect, 2026-11-13).
    const sel = active() && !active().parentId && !active().localOf ? active() : null;
    const move = h('input', { type: 'checkbox' });
    const v = await ui.dialogs.raw({ title: 'New artboard', body: h('div', { class: 'form' }, ...Object.entries(f).map(([k, el]) => h('label', { class: 'field' }, h('span', {}, k), el)), h('label', { class: 'check' }, grow, 'Grow the document to fit'),
      sel ? h('label', { class: 'check', title: 'An artboard draws below the layers outside it' }, move, `Move "${sel.name}" onto this artboard`) : null),
      actions: [{ label: 'Cancel', value: null }, { label: 'Add', primary: true, value: () => ({ name: f.name.value, x: Math.round(+f.x.value), y: Math.round(+f.y.value), width: Math.round(+f.width.value), height: Math.round(+f.height.value), background: f.bg.value.trim(), grow: grow.checked, move: move.checked }) }] });
    if (!v) return;
    const { move: moveSel, ...args } = v;
    ok(await send('add_artboard', { ...args, layerIds: moveSel && sel ? [sel.id] : [] }), (r) => `Added ${r.artboard.name}.${moveSel && sel ? ` ${sel.name} is on it; layers outside artboards draw above it.` : ''}`);
  }
  async function exportBoards(artboardId) {
    const folder = await ui.dialogs.promptText('Export artboards', 'Folder in the workspace', 'exports/artboards');
    if (!folder) return;
    const r = await send('export_artboards', { folder, format: 'png', ...(artboardId ? { artboardId } : {}) });
    if (r.status === 'ok') ui.say(`Wrote ${r.result.files.map((f) => f.path).join(', ')}.`);
  }
  function boardRow(b) {
    return h('div', { class: 'vec-item' }, h('div', { class: 'vec-row' }, h('span', { class: 'grow', title: `${b.x}, ${b.y} · ${b.layers.length} layers` }, `${b.name} · ${b.width} × ${b.height}`)), h('div', { class: 'vec-row' },
      btn('+ layer', 'set_layer_artboard', async () => { const l = active(); if (!l) return; ok(await send('set_layer_artboard', { layerId: l.id, artboardId: b.id }), `${l.name} is on ${b.name}.`); }, 'Put the active layer on this artboard'),
      btn('Colour', 'set_artboard', async () => { const v = await ui.dialogs.promptText('Artboard background', '#rrggbb or transparent', b.background); if (v != null) ok(await send('set_artboard', { artboardId: b.id, background: v.trim() })); }, 'Background colour'),
      btn('Export', 'export_artboards', () => exportBoards(b.id), 'Export this artboard as PNG'),
      btn('×', 'delete_artboard', async () => ok(await send('delete_artboard', { artboardId: b.id })), 'Delete artboard (its layers stay)')));
  }

  const section = (title, ...kids) => h('details', { class: 'vec-section', open: true }, h('summary', {}, title), ...kids);
  const row = (...kids) => h('div', { class: 'vec-row' }, ...kids);
  root.replaceChildren(h('h3', {}, 'Vector'),
    section('Paths', row(penBtn, h('label', { class: 'check' }, showPaths, 'Show paths')), pathList,
      row(...['union', 'subtract', 'intersect', 'exclude'].map((op) => btn(op[0].toUpperCase() + op.slice(1), 'combine_paths', combine(op), `Path ${op} of the ticked paths (list order = bottom first)`))),
      row(h('span', { class: 'dim' }, 'Select'), opSel, h('span', { class: 'dim' }, 'Feather'), feather)),
    section('Vector mask', row(btn('Remove vector mask', 'set_vector_mask', async () => { const l = active(); if (l) ok(await send('set_vector_mask', { layerId: l.id, off: true }), 'Vector mask removed.'); }),
      btn('Feather', 'set_vector_mask', async () => { const l = active(); if (l?.vectorMask) ok(await send('set_vector_mask', { layerId: l.id, feather: Number(feather.value) || 0 })); }, 'Apply the feather above to the active layer\'s vector mask'))),
    section('Shape layer', row(shapeType, radius, sides), row(h('span', { class: 'dim' }, 'Fill'), fillCol, h('label', { class: 'check' }, noFill, 'none')),
      row(h('span', { class: 'dim' }, 'Stroke'), strokeCol, strokeW, strokeAlign, dash),
      row(btn('Add shape', 'add_shape_layer', async () => { if (!store.doc) return; ok(await send('add_shape_layer', { shape: shapeArgs(), ...paint() }), 'Added a shape layer (in the selection, or the middle third).'); }, 'Shape in the selection bounds, or the middle of the document'),
        btn('Apply to shape', 'set_shape', async () => { const l = active(); if (l?.kind !== 'shape') { ui.say('Select a shape layer first.'); return; } const p = paint(); ok(await send('set_shape', { layerId: l.id, fill: p.fill, ...(p.stroke ? { stroke: p.stroke } : { noStroke: true }) }), 'Shape updated.'); }, 'Fill and stroke on the active shape layer'))),
    section('Type', row(warpSel, bend, btn('Warp', 'set_text', async () => { const l = textLayer(); if (!l) return; ok(await send('set_text', warpSel.value === 'none' ? { layerId: l.id, clear: ['warp'] } : { layerId: l.id, warp: { style: warpSel.value, bend: Number(bend.value) || 0 } })); })),
      row(...feats, btn('Features', 'set_text', async () => { const l = textLayer(); if (!l) return; ok(await send('set_text', { layerId: l.id, features: Object.fromEntries(feats.map((f) => [f.firstChild.value, f.firstChild.checked])) })); }, 'OpenType features on the active type layer')),
      row(h('span', { class: 'dim' }, 'Tracking'), tracking, btn('Set', 'set_text', async () => { const l = textLayer(); if (l) ok(await send('set_text', { layerId: l.id, style: { tracking: Number(tracking.value) || 0 } })); })),
      row(h('span', { class: 'dim' }, 'Characters'), runStart, runEnd, runCol, runSize, runShift),
      row(btn('Format characters', 'set_text', async () => {
        const l = textLayer(); if (!l) return;
        const r = { start: Number(runStart.value) || 0, end: Number(runEnd.value) || 1, color: runCol.value, ...(Number(runSize.value) > 0 ? { size: Number(runSize.value) } : {}), ...(Number(runShift.value) ? { baselineShift: Number(runShift.value) } : {}) };
        ok(await send('set_text', { layerId: l.id, runs: [...(l.text.runs || []), r] }));
      }, 'Per-character colour, size and baseline shift on the active type layer'),
      btn('Clear formatting', 'set_text', async () => { const l = textLayer(); if (l) ok(await send('set_text', { layerId: l.id, clear: ['runs'] })); })),
      row(h('span', { class: 'dim' }, 'Path start %'), startOff, btn('Off path', 'set_text', async () => { const l = textLayer(); if (l) ok(await send('set_text', { layerId: l.id, clear: ['path'] })); }))),
    section('Artboards', boardList, row(btn('Add artboard…', 'add_artboard', addArtboard), btn('Export all…', 'export_artboards', () => exportBoards(null)),
      btn('Off artboard', 'set_layer_artboard', async () => { const l = active(); if (l) ok(await send('set_layer_artboard', { layerId: l.id, artboardId: '' })); }, 'Take the active layer off its artboard'))));

  let seen = -1;
  async function refresh() {
    if (!store.doc) { paths = []; boards = []; }
    else {
      const p = await read('list_paths'); paths = p.status === 'ok' ? p.result.paths : [];
      const b = await read('list_artboards'); boards = b.status === 'ok' ? b.result.artboards : [];
    }
    for (const id of [...picked]) if (!paths.some((p) => p.id === id)) picked.delete(id);
    pathList.replaceChildren(...(paths.length ? paths.map(pathRow) : [h('p', { class: 'dim' }, 'No paths. Press P and click on the photo.')]));
    boardList.replaceChildren(...boards.map(boardRow));
    draw();
  }
  return {
    render() {
      root.hidden = ctx.view.mode === 'develop';
      const rev = ui.store.doc ? `${store.doc.id}:${ctx.bus?.state.revision ?? 0}` : '';
      if (rev !== seen) { seen = rev; refresh(); } else draw();
    },
    setPen, get pen() { return pen; },
  };
}
