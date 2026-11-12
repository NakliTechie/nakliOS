// Tools: the tool bar, the tool options strip and canvas pointer input. Pointer positions convert from
// screen to document pixels through the engine's current view, and each gesture ends in one manifest
// command (paint_stroke with the stroke's points, set_selection, transform_layer, fill, crop_document,
// set_crop, set_mask, paint_mask). Hand and zoom send set_view on animation frames. While a gesture runs,
// an overlay canvas draws its outline; the document changes only through the command at the end.

import { h } from './dom.js';
import { screenToDoc, docToScreen, zoomAt, panBy, dragRect, clampRect, selectionOp, cropFromView } from './geometry.js';

export const COMPOSITE_TOOLS = [
  ['move', 'Move', 'V'], ['marquee-rect', 'Rectangle select', 'M'], ['marquee-ellipse', 'Ellipse select', 'Shift+M'], ['lasso', 'Lasso', 'L'], ['wand', 'Magic wand', 'W'],
  ['brush', 'Brush', 'B'], ['eraser', 'Eraser', 'E'], ['fill', 'Fill bucket', 'G'], ['gradient', 'Gradient', 'Shift+G'],
  ['text', 'Type', 'T'], ['crop', 'Crop', 'C'], ['hand', 'Hand', 'H'], ['zoom', 'Zoom', 'Z'],
];
export const DEVELOP_TOOLS = [['crop', 'Crop', 'R'], ['mask-linear', 'Linear mask', 'M'], ['mask-radial', 'Radial mask', 'Shift+M'], ['mask-brush', 'Brush mask', 'K'], ['hand', 'Hand', 'H'], ['zoom', 'Zoom', 'Z']];
// The command each tool's gesture sends (the parity table reads this).
export const TOOL_COMMAND = {
  move: 'transform_layer', 'marquee-rect': 'set_selection', 'marquee-ellipse': 'set_selection', lasso: 'set_selection', wand: 'set_selection',
  brush: 'paint_stroke', eraser: 'paint_stroke', fill: 'fill', gradient: 'fill', text: 'add_layer', crop: 'crop_document', hand: 'set_view', zoom: 'set_view',
  'mask-linear': 'set_mask', 'mask-radial': 'set_mask', 'mask-brush': 'paint_mask',
};
const GLYPH = { move: '✥', 'marquee-rect': '▭', 'marquee-ellipse': '◯', lasso: '➰', wand: '✦', brush: '✎', eraser: '⌫', fill: '◧', gradient: '▤', text: 'T', crop: '⛶', hand: '✋', zoom: '⌕', 'mask-linear': '▥', 'mask-radial': '◎', 'mask-brush': '✎' };

export function createTools({ bar, options, stage, canvas, overlay, ui }) {
  const { send } = ui;
  const opt = { size: 40, hardness: 80, opacity: 100, flow: 100, fg: '#000000', bg: '#ffffff', tolerance: 32, contiguous: true, op: 'replace', fontSize: 120, font: 'Helvetica Neue', square: false };
  let tool = 'move'; let spaceHand = false;
  const engine = () => ui.ctx.engine;
  const view = () => engine()?.computeView();
  const rect = () => canvas.getBoundingClientRect();
  const ratio = () => canvas.width / Math.max(1, rect().width);
  const toDoc = (e) => screenToDoc(view(), rect(), ratio(), e.clientX, e.clientY);
  const toScreen = (x, y) => { const r = rect(); const [sx, sy] = docToScreen(view(), r, ratio(), x, y); return [sx - r.left, sy - r.top]; };
  const docScale = () => view().scale / ratio();   // CSS px per document px
  const viewLane = ui.latest('view', 'set_view', (v) => v);
  // set_view has no "fit" value, so Fit sends the zoom that fits: min(canvas w / doc w, canvas h / doc h).
  const fitView = () => { const d = ui.store.doc; return { zoom: Math.max(0.01, Math.min(64, Math.min(canvas.width / d.width, canvas.height / d.height))), center: [d.width / 2, d.height / 2] }; };
  const centre = () => { const v = view(); return [v.x0 + canvas.width / (2 * v.scale), v.y0 + canvas.height / (2 * v.scale)]; };

  // ---- tool bar ----
  function drawBar() {
    const list = ui.ctx.view.mode === 'develop' ? DEVELOP_TOOLS : COMPOSITE_TOOLS;
    if (!list.some(([id]) => id === tool)) tool = ui.ctx.view.mode === 'develop' ? 'hand' : 'move';
    bar.replaceChildren(...list.map(([id, name, key]) => h('button', {
      class: id === tool ? 'tool on' : 'tool', 'aria-pressed': String(id === tool), title: `${name} (${key})`, 'aria-label': name,
      dataset: { view: `tool:${id}`, tool: id }, onclick: () => setTool(id),
    }, GLYPH[id])));
    drawOptions(); stage.dataset.tool = tool;
  }

  // ---- options strip ----
  const num = (label, key, min, max, step = 1) => h('label', { class: 'opt' }, label, h('input', { type: 'number', min, max, step, value: opt[key], 'aria-label': label, dataset: { view: `option:${key}` }, onchange: (e) => { opt[key] = Math.min(max, Math.max(min, Number(e.target.value))); } }));
  const colour = (label, key) => h('label', { class: 'opt' }, label, h('input', { type: 'color', value: opt[key], 'aria-label': label, dataset: { view: `option:${key}` }, onchange: (e) => { opt[key] = e.target.value; } }));
  function drawOptions() {
    const t = tool; const o = [];
    if (t === 'brush' || t === 'eraser' || t === 'mask-brush') o.push(num('Size', 'size', 1, 2000), num('Hardness', 'hardness', 0, 100), ...(t === 'mask-brush' ? [] : [num('Opacity', 'opacity', 0, 100)]), num('Flow', 'flow', 1, 100));
    if (t === 'brush' || t === 'fill' || t === 'gradient' || t === 'text') o.push(colour(t === 'gradient' ? 'From' : 'Colour', 'fg'));
    if (t === 'gradient') o.push(colour('To', 'bg'));
    if (t === 'fill' || t === 'wand') o.push(num('Tolerance', 'tolerance', 0, 255));
    if (t === 'wand') o.push(h('label', { class: 'opt' }, h('input', { type: 'checkbox', checked: opt.contiguous, dataset: { view: 'option:contiguous' }, onchange: (e) => { opt.contiguous = e.target.checked; } }), 'Contiguous'));
    if (t.startsWith('marquee') || t === 'lasso' || t === 'wand') o.push(h('label', { class: 'opt' }, 'Mode', h('select', { dataset: { view: 'option:op' }, onchange: (e) => { opt.op = e.target.value; } }, ['replace', 'add', 'subtract', 'intersect'].map((v) => h('option', { value: v, selected: v === opt.op }, v)))),
      h('button', { dataset: { command: 'set_selection' }, onclick: () => send('set_selection', { op: 'replace', shape: 'all' }) }, 'Select all'),
      h('button', { dataset: { command: 'set_selection' }, onclick: () => send('set_selection', { op: 'replace', shape: 'none' }) }, 'Deselect'),
      h('button', { dataset: { command: 'refine_selection' }, onclick: () => send('refine_selection', { action: 'invert' }) }, 'Invert'),
      h('button', { dataset: { command: 'refine_selection' }, onclick: async () => { const v = await ui.dialogs.promptText('Feather selection', 'Radius in pixels', '10'); if (v != null && Number(v) >= 0) send('refine_selection', { action: 'feather', amount: Number(v) }); } }, 'Feather…'));
    if (t === 'text') o.push(num('Size', 'fontSize', 1, 2000));
    if (t === 'brush' || t === 'eraser') o.push(h('span', { class: 'dim' }, '[ ] size · Shift+[ ] hardness · D default colours · X swap'));
    if (t === 'move') o.push(h('span', { class: 'dim' }, 'Drag to move the active layer (one undo step per drag).'));
    if (t === 'hand' || t === 'zoom') o.push(h('button', { dataset: { command: 'set_view' }, onclick: () => send('set_view', fitView()) }, 'Fit'), h('button', { dataset: { command: 'set_view' }, onclick: () => send('set_view', { zoom: ratio(), center: centre() }) }, '100%'), h('span', { class: 'dim' }, 'Alt-click zooms out · Ctrl+wheel zooms · Space pans'));
    if (t === 'crop') o.push(h('span', { class: 'dim' }, ui.ctx.view.mode === 'develop' ? 'Drag the area to keep (set_crop).' : 'Drag the area to keep (crop_document).'));
    if (t.startsWith('mask-')) o.push(h('span', { class: 'dim' }, t === 'mask-brush' ? 'Paints into the selected mask; Alt erases.' : 'Drag on the photo to add a mask, then adjust it under Masks.'));
    options.replaceChildren(...o);
  }

  function setTool(id) { tool = id; drawBar(); paintOverlay(); }

  // ---- overlay ----
  let gesture = null;
  function sizeOverlay() { const r = rect(); overlay.width = Math.round(r.width * devicePixelRatio); overlay.height = Math.round(r.height * devicePixelRatio); }
  function paintOverlay() {
    const g = overlay.getContext('2d');
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    g.clearRect(0, 0, overlay.width, overlay.height);
    const doc = ui.store.doc; if (!doc || !engine()) return;
    const line = (pts, close, dash = [5, 4]) => { g.beginPath(); pts.forEach(([x, y], i) => { const [sx, sy] = toScreen(x, y); if (i) g.lineTo(sx, sy); else g.moveTo(sx, sy); }); if (close) g.closePath(); for (const [c, o] of [['#fff', 0], ['#000', dash[0]]]) { g.strokeStyle = c; g.setLineDash(dash); g.lineDashOffset = o; g.lineWidth = 1; g.stroke(); } };
    const sel = doc.selection?.bounds;
    if (sel) line([[sel[0], sel[1]], [sel[2], sel[1]], [sel[2], sel[3]], [sel[0], sel[3]]], true);
    if (!gesture) return;
    const { a, b, pts } = gesture;
    if (gesture.kind === 'rect' || gesture.kind === 'crop') { const r = dragRect(a, b, { round: false, square: gesture.square }); line([[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]], true); }
    else if (gesture.kind === 'ellipse') { const r = dragRect(a, b, { round: false, square: gesture.square }); const ps = []; for (let i = 0; i < 64; i++) { const t = (i / 64) * Math.PI * 2; ps.push([r.x + r.w / 2 + (Math.cos(t) * r.w) / 2, r.y + r.h / 2 + (Math.sin(t) * r.h) / 2]); } line(ps, true); }
    else if (gesture.kind === 'lasso') line(pts, false);
    else if (gesture.kind === 'stroke') {
      g.setLineDash([]); g.lineCap = 'round'; g.lineJoin = 'round';
      g.strokeStyle = tool === 'brush' ? opt.fg : 'rgba(255,255,255,.7)'; g.globalAlpha = 0.6; g.lineWidth = Math.max(1, gesture.size * docScale());
      g.beginPath(); pts.forEach(([x, y], i) => { const [sx, sy] = toScreen(x, y); if (i) g.lineTo(sx, sy); else g.moveTo(sx, sy); }); if (pts.length === 1) { const [sx, sy] = toScreen(...pts[0]); g.lineTo(sx + 0.1, sy); } g.stroke(); g.globalAlpha = 1;
    } else if (gesture.kind === 'line' || gesture.kind === 'move') { line([a, b], false, [4, 3]); if (gesture.kind === 'move') { const [sx, sy] = toScreen(...b); g.fillStyle = '#000'; g.font = '12px sans-serif'; g.fillText(`${Math.round(b[0] - a[0])}, ${Math.round(b[1] - a[1])}`, sx + 10, sy - 10); } }
    else if (gesture.kind === 'radial') { const r = Math.hypot(b[0] - a[0], b[1] - a[1]); const ps = []; for (const k of [0.5, 1]) { ps.length = 0; for (let i = 0; i <= 64; i++) { const t = (i / 64) * Math.PI * 2; ps.push([a[0] + Math.cos(t) * r * k, a[1] + Math.sin(t) * r * k]); } line(ps, true); } }
  }

  // ---- pointer input ----
  const activeLayer = () => ui.store.doc?.activeLayerId;
  const current = () => (spaceHand ? 'hand' : tool);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !ui.store.doc || !engine()) return;
    overlay.setPointerCapture(e.pointerId);
    const t = current(); const p = toDoc(e);
    const g = { tool: t, a: p, b: p, pts: [withPressure(p, e)], screen: [e.clientX, e.clientY], alt: e.altKey, shift: e.shiftKey };
    g.kind = { 'marquee-rect': 'rect', 'marquee-ellipse': 'ellipse', lasso: 'lasso', crop: 'crop', brush: 'stroke', eraser: 'stroke', 'mask-brush': 'stroke', gradient: 'line', 'mask-linear': 'line', 'mask-radial': 'radial', move: 'move' }[t] || t;
    g.size = opt.size;
    gesture = g; paintOverlay();
  });
  const withPressure = (p, e) => (e.pointerType === 'pen' ? [p[0], p[1], e.pressure] : p);
  overlay.addEventListener('pointermove', (e) => {
    if (!gesture) return;
    const p = toDoc(e); gesture.b = p; gesture.square = e.shiftKey;
    if (gesture.kind === 'hand') { const k = ratio(); viewLane.push(panBy(view(), (e.clientX - gesture.screen[0]) * k, (e.clientY - gesture.screen[1]) * k, canvas.width, canvas.height)); gesture.screen = [e.clientX, e.clientY]; return; }
    if (gesture.kind === 'stroke' || gesture.kind === 'lasso') {
      const last = gesture.pts.at(-1); const step = gesture.kind === 'stroke' ? Math.max(1, gesture.size * 0.1) : 2 / docScale();
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= step) gesture.pts.push(withPressure(p, e));
    }
    paintOverlay();
  });
  overlay.addEventListener('pointerup', async (e) => {
    const g = gesture; gesture = null; if (!g) return;
    paintOverlay();
    const moved = Math.hypot(e.clientX - g.screen[0], e.clientY - g.screen[1]) > 3 || g.kind === 'hand';
    await finish(g, moved, e);
  });
  overlay.addEventListener('pointercancel', () => { gesture = null; paintOverlay(); });

  async function finish(g, moved, e) {
    const doc = ui.store.doc; const t = g.tool; const [x, y] = g.b; const R = (v) => Math.round(v);
    const op = selectionOp(g, opt.op);
    switch (t) {
      case 'hand': return;
      case 'zoom': { const z = zoomAt(view(), g.alt ? 0.5 : 2, x, y, canvas.width, canvas.height); return send('set_view', z); }
      case 'move': if (moved) return send('transform_layer', { layerId: activeLayer(), matrix: [1, 0, 0, 1, R(x - g.a[0]), R(y - g.a[1])] }); return;
      case 'marquee-rect': case 'marquee-ellipse': {
        if (!moved) return op === 'replace' ? send('set_selection', { op: 'replace', shape: 'none' }) : null;
        const r = dragRect(g.a, g.b, { square: g.square });
        return send('set_selection', { op, shape: t === 'marquee-rect' ? 'rect' : 'ellipse', params: r });
      }
      case 'lasso': if (g.pts.length >= 3) return send('set_selection', { op, shape: 'polygon', params: { points: g.pts.map(([px, py]) => [R(px), R(py)]) } }); return;
      case 'wand': return send('set_selection', { op, shape: 'wand', params: { x: R(clampTo(x, doc.width)), y: R(clampTo(y, doc.height)), tolerance: opt.tolerance, contiguous: opt.contiguous } });
      case 'brush': case 'eraser':
        return send('paint_stroke', { layerId: activeLayer(), tool: t, points: g.pts.map((p) => p.map((v, i) => (i < 2 ? Math.round(v * 10) / 10 : v))), size: opt.size, hardness: opt.hardness, opacity: opt.opacity, flow: opt.flow, ...(t === 'brush' ? { color: opt.fg } : {}) });
      case 'fill': return send('fill', { layerId: activeLayer(), mode: 'bucket', point: [R(x), R(y)], color: opt.fg, tolerance: opt.tolerance });
      case 'gradient': if (moved) return send('fill', { layerId: activeLayer(), mode: 'gradient', color: opt.fg, gradient: { x0: R(g.a[0]), y0: R(g.a[1]), x1: R(x), y1: R(y), from: opt.fg, to: opt.bg } }); return;
      case 'text': {
        const content = await ui.dialogs.promptText('Add type', 'Text', '');
        if (!content) return;
        const r = await send('add_layer', { kind: 'text', name: content.slice(0, 24), text: { content, style: { size: opt.fontSize, color: opt.fg, font: opt.font } } });
        if (r.status !== 'ok') return;
        const l = ui.store.doc.layers.find((q) => q.id === r.result.layer.id);
        return send('transform_layer', { layerId: l.id, matrix: [1, 0, 0, 1, R(g.a[0] - l.matrix[4]), R(g.a[1] - l.matrix[5])] });
      }
      case 'crop': {
        if (!moved) return;
        const r = clampRect(dragRect(g.a, g.b, { square: g.square }), doc.width, doc.height);
        if (!r) return;
        if (ui.ctx.view.mode === 'develop' && ui.develop.layer) {
          const l = ui.develop.layer;
          return send('set_crop', { layerId: l.id, rect: cropFromView(l.crop?.rect, doc.width, doc.height, r) });
        }
        return send('crop_document', { rect: r });
      }
      case 'mask-linear': case 'mask-radial': {
        const base = ui.develop.layer; if (!base || !moved) return;
        const maskId = nextMask(doc, base.id);
        const comp = t === 'mask-linear'
          ? { op: 'add', kind: 'linear', params: { x0: R(g.a[0]), y0: R(g.a[1]), x1: R(x), y1: R(y) } }
          : (() => { const r1 = Math.max(1, R(Math.hypot(x - g.a[0], y - g.a[1]))); return { op: 'add', kind: 'radial', params: { cx: R(g.a[0]), cy: R(g.a[1]), r0: R(r1 / 2), r1 } }; })();
        const reply = await send('set_mask', { layerId: base.id, maskId, components: [comp] });
        if (reply.status === 'ok') { ui.state.mask = maskId; ui.render(); }
        return reply;
      }
      case 'mask-brush': {
        const base = ui.develop.layer; if (!base) return;
        let maskId = ui.state.mask;
        if (!maskId) {
          maskId = nextMask(doc, base.id);
          const r = await send('set_mask', { layerId: base.id, maskId, components: [{ op: 'add', kind: 'bitmap', params: { fill: 0 } }] });
          if (r.status !== 'ok') return r;
          ui.state.mask = maskId;
        }
        return send('paint_mask', { layerId: base.id, maskId, points: g.pts.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]), size: opt.size, hardness: opt.hardness, flow: opt.flow, erase: !!e.altKey });
      }
      default: return null;
    }
  }
  const clampTo = (v, n) => Math.min(n - 1, Math.max(0, v));
  const nextMask = (doc, baseId) => { let i = 1; while (doc.layers.some((l) => l.id === `${baseId}~mask-${i}`)) i++; return `mask-${i}`; };

  // Wheel: Ctrl or Cmd zooms about the pointer, otherwise the view pans.
  overlay.addEventListener('wheel', (e) => {
    if (!ui.store.doc || !engine()) return;
    e.preventDefault();
    const v = view();
    if (e.ctrlKey || e.metaKey) { const [x, y] = toDoc(e); viewLane.push(zoomAt(v, Math.exp(-e.deltaY * 0.0025), x, y, canvas.width, canvas.height)); }
    else { const k = ratio(); viewLane.push(panBy(v, -e.deltaX * k, -e.deltaY * k, canvas.width, canvas.height)); }
  }, { passive: false });

  addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat && !isTyping(e)) { spaceHand = true; stage.dataset.tool = 'hand'; } });
  addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceHand = false; stage.dataset.tool = tool; } });

  return {
    drawBar, setTool, paintOverlay, sizeOverlay, opt, fitView, get tool() { return tool; },
    // Brush keys: [ ] size, Shift+[ ] hardness; D default colours; X swap.
    nudge(key, shift) {
      if (shift) opt.hardness = Math.min(100, Math.max(0, opt.hardness + (key === ']' ? 10 : -10)));
      else opt.size = Math.min(2000, Math.max(1, Math.round(opt.size * (key === ']' ? 1.2 : 1 / 1.2))));
      drawOptions();
    },
    defaultColours() { opt.fg = '#000000'; opt.bg = '#ffffff'; drawOptions(); },
    swapColours() { [opt.fg, opt.bg] = [opt.bg, opt.fg]; drawOptions(); },
  };
}

export const isTyping = (e) => { const t = e.target; return t && (t.isContentEditable || (t.tagName === 'INPUT' && !['range', 'checkbox', 'color', 'button'].includes(t.type)) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'); };
