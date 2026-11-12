// Compare view (L56) and before and after (L42): 2 to 4 rendered photos side by side, or one photo split
// before | after, with zoom and pan synced across panes. Images come from render_photos and render_preview
// (downscaled JPEGs, so GPU memory holds at most one photo at a time while they render); this view is a
// 2D canvas over the stage and never changes the document.

import { h } from './dom.js';

// Shared view: zoom 1 = fit; (cx, cy) = the image point at the pane centre, as fractions of width and height.
// Each pane fits its own image, so photos of different sizes stay aligned by relative position.
export function paneRect(view, iw, ih, pw, ph) {
  const s = Math.min(pw / iw, ph / ih) * view.zoom;
  const w = iw * s; const hgt = ih * s;
  return { x: pw / 2 - view.cx * w, y: ph / 2 - view.cy * hgt, w, h: hgt, scale: s };
}
// Zoom by factor about pane point (px, py), keeping the image point under it fixed.
export function zoomView(view, factor, px, py, iw, ih, pw, ph) {
  const r = paneRect(view, iw, ih, pw, ph);
  const fx = (px - r.x) / r.w; const fy = (py - r.y) / r.h;
  const zoom = Math.min(32, Math.max(0.25, view.zoom * factor));
  const r2 = paneRect({ zoom, cx: 0, cy: 0 }, iw, ih, pw, ph);
  return { zoom, cx: fx - (px - pw / 2) / r2.w, cy: fy - (py - ph / 2) / r2.h };
}
export const gridFor = (n) => (n <= 3 ? [n, 1] : [2, 2]);

export const decodeJpeg = (p) => createImageBitmap(new Blob([Uint8Array.from(atob(p.base64), (c) => c.charCodeAt(0))], { type: p.mime }));

export function createViewer(ui) {
  const stage = document.querySelector('#stage');
  const area = h('div', { class: 'cmp-area' });
  const title = h('strong', {});
  const layoutSel = h('select', { 'aria-label': 'Layout', hidden: true, onchange: (e) => { layout = e.target.value; draw(); } }, h('option', { value: 'split' }, 'Split'), h('option', { value: 'side' }, 'Side by side'));
  const bar = h('div', { class: 'cmp-bar' }, title, layoutSel,
    h('button', { onclick: () => { view = { zoom: 1, cx: 0.5, cy: 0.5 }; draw(); } }, 'Fit'),
    h('button', { onclick: () => { const p = panes[0]; if (!p) return; const c = canvases[0]; const fit = Math.min(c.width / p.bitmap.width, c.height / p.bitmap.height); view = { ...view, zoom: 1 / fit }; draw(); } }, '1:1 preview'),
    h('span', { class: 'grow' }), h('span', { class: 'dim cmp-note' }), h('button', { onclick: () => close() }, 'Close (Esc)'));
  const root = h('div', { class: 'view-overlay', hidden: true, role: 'region', 'aria-label': 'Compare view' }, bar, area);
  stage.append(root);
  let panes = []; let layout = 'side'; let view = { zoom: 1, cx: 0.5, cy: 0.5 }; let divider = 0.5; let canvases = [];

  function show(t, list, { split = false, note = '' } = {}) {
    panes = list; view = { zoom: 1, cx: 0.5, cy: 0.5 }; divider = 0.5;
    title.textContent = t; layoutSel.hidden = !split; layout = split ? 'split' : 'side'; layoutSel.value = layout;
    bar.querySelector('.cmp-note').textContent = note;
    root.hidden = false; draw();
  }
  function close() { root.hidden = true; for (const p of panes) p.bitmap.close?.(); panes = []; area.replaceChildren(); }

  function draw() {
    if (root.hidden) return;
    const n = layout === 'split' ? 1 : panes.length; const [cols, rows] = gridFor(n);
    area.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`; area.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
    if (canvases.length !== n) {
      canvases = Array.from({ length: n }, () => h('canvas', { class: 'cmp-pane' }));
      area.replaceChildren(...canvases.map((c, i) => h('div', { class: 'cmp-cell' }, c, h('span', { class: 'cmp-label' }, layout === 'split' ? `${panes[0]?.label} | ${panes[1]?.label}` : panes[i]?.label ?? ''))));
      canvases.forEach((c, i) => bind(c, i));
    }
    // a hidden tab gets no animation frames; paint on a timer then, so the panes stay current
    (document.hidden ? (f) => setTimeout(f, 16) : requestAnimationFrame)(() => canvases.forEach((c, i) => paint(c, i)));
  }
  function paint(c, i) {
    const r = c.getBoundingClientRect(); c.width = Math.max(1, Math.round(r.width * devicePixelRatio)); c.height = Math.max(1, Math.round(r.height * devicePixelRatio));
    const g = c.getContext('2d'); g.fillStyle = '#777'; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingQuality = 'high';
    if (layout === 'split') {
      const [a, b] = panes; if (!a || !b) return;
      const ra = paneRect(view, b.bitmap.width, b.bitmap.height, c.width, c.height);
      g.drawImage(b.bitmap, ra.x, ra.y, ra.w, ra.h);   // right of the divider: the second (after)
      const x = divider * c.width;
      g.save(); g.beginPath(); g.rect(0, 0, x, c.height); g.clip();
      const rb = paneRect(view, a.bitmap.width, a.bitmap.height, c.width, c.height); g.drawImage(a.bitmap, rb.x, rb.y, rb.w, rb.h); g.restore();
      g.fillStyle = '#fff'; g.fillRect(x - devicePixelRatio, 0, 2 * devicePixelRatio, c.height);
      return;
    }
    const p = panes[i]; if (!p) return;
    const rr = paneRect(view, p.bitmap.width, p.bitmap.height, c.width, c.height);
    g.drawImage(p.bitmap, rr.x, rr.y, rr.w, rr.h);
  }
  function bind(c, i) {
    const img = () => panes[layout === 'split' ? 1 : i]?.bitmap;
    c.addEventListener('wheel', (e) => {
      e.preventDefault(); const b = img(); if (!b) return;
      const k = devicePixelRatio; const r = c.getBoundingClientRect();
      view = zoomView(view, e.deltaY < 0 ? 1.25 : 0.8, (e.clientX - r.left) * k, (e.clientY - r.top) * k, b.width, b.height, c.width, c.height); draw();
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      const b = img(); if (!b) return;
      const r = c.getBoundingClientRect(); const onDivider = layout === 'split' && Math.abs((e.clientX - r.left) / r.width - divider) < 0.02;
      c.setPointerCapture(e.pointerId); let last = [e.clientX, e.clientY];
      const move = (ev) => {
        if (onDivider) { divider = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)); draw(); return; }
        const rr = paneRect(view, b.width, b.height, c.width, c.height); const k = devicePixelRatio;
        view = { ...view, cx: view.cx - ((ev.clientX - last[0]) * k) / rr.w, cy: view.cy - ((ev.clientY - last[1]) * k) / rr.h };
        last = [ev.clientX, ev.clientY]; draw();
      };
      const up = () => { c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); };
      c.addEventListener('pointermove', move); c.addEventListener('pointerup', up);
    });
  }
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden) close(); });
  new ResizeObserver(() => draw()).observe(area);

  // Compare 2 to 4 photos from the filmstrip selection.
  async function compare(paths) {
    if (paths.length < 2) { ui.say('Ctrl-click 2 to 4 photos in the filmstrip to compare them.'); return null; }
    const chosen = paths.slice(0, 4);
    ui.say(`Rendering ${chosen.length} photos to compare…`);
    const r = await ui.read('render_photos', { paths: chosen, maxEdge: 1600 });
    if (r.status !== 'ok') { ui.say(`Compare: ${r.error?.message ?? r.status}`); return r; }
    baOpen = false;
    show('Compare', await Promise.all(r.result.photos.map(async (p) => ({ label: p.path.split('/').pop(), bitmap: await decodeJpeg(p) }))), { note: paths.length > 4 ? `showing the first 4 of ${paths.length}` : 'synced zoom and pan; preview resolution' });
    ui.say('');
    return r;
  }
  // Before (no develop) and after, split by a draggable divider or side by side.
  async function beforeAfter() {
    if (!ui.ctx.store.doc) { ui.say('Open a photo first.'); return null; }
    const [b, a] = [await ui.read('render_preview', { maxEdge: 2048, before: true }), await ui.read('render_preview', { maxEdge: 2048 })];
    if (b.status !== 'ok' || a.status !== 'ok') { ui.say(`Before and after: ${(b.error || a.error)?.message ?? 'failed'}`); return null; }
    show('Before / after', [{ label: 'Before', bitmap: await decodeJpeg(b.result) }, { label: 'After', bitmap: await decodeJpeg(a.result) }], { split: true, note: 'drag the white line; wheel zooms both' });
    return [b, a];
  }
  // set_view beforeAfter: 'split' | 'side-by-side' | 'toggle' | 'off'. Returns the state now shown.
  let baOpen = false;
  function closeAll() { close(); baOpen = false; }
  async function setBeforeAfter(mode) {
    const showing = !root.hidden && baOpen;
    if (mode === 'off' || (mode === 'toggle' && showing)) { if (showing) closeAll(); return 'off'; }
    const want = mode === 'side-by-side' ? 'side' : 'split';
    if (!showing) { const r = await beforeAfter(); if (!r) return 'off'; baOpen = true; }
    layout = want; layoutSel.value = want; draw();
    return want === 'side' ? 'side-by-side' : 'split';
  }
  return { compare, beforeAfter, setBeforeAfter, show: (t, list, o) => { baOpen = false; show(t, list, o); }, close: closeAll, get open() { return !root.hidden; }, get state() { return { panes: panes.length, layout, view, divider }; } };
}
