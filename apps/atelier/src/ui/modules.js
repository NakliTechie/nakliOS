// Library modules in the browser (L51): Slideshow, Print, Web gallery and Map. Slideshow and Print show
// photos rendered by render_photos; Web gallery writes files through export_web_gallery; Map places photos
// by EXIF GPS from list_photo_locations on a plain latitude and longitude grid (no online map tiles, so no
// request leaves the device). Book is not offered: it hands off to Paginella, which is not available here.

import { h, svg } from './dom.js';
import { decodeJpeg } from './compare.js';

// Equirectangular fit of points into w × h with padding: x scales longitude by cos(mid latitude) so
// distances look right near the middle; grid step is the first of 0.01..30 degrees giving at most 8 lines.
export function mapProjection(points, w, h, pad = 32) {
  const lats = points.map((p) => p.lat); const lons = points.map((p) => p.lon);
  let [s, n, west, east] = points.length ? [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)] : [-60, 75, -180, 180];
  const span = Math.max(n - s, east - west, 0.02);
  if (n - s < span * 0.2) { const c = (n + s) / 2; s = c - span * 0.1; n = c + span * 0.1; }
  if (east - west < span * 0.2) { const c = (east + west) / 2; west = c - span * 0.1; east = c + span * 0.1; }
  const k = Math.cos((((n + s) / 2) * Math.PI) / 180);
  const scale = Math.min((w - 2 * pad) / ((east - west) * k), (h - 2 * pad) / (n - s));
  const cx = (east + west) / 2; const cy = (n + s) / 2;
  const project = (lat, lon) => [w / 2 + (lon - cx) * k * scale, h / 2 - (lat - cy) * scale];
  const range = Math.max(n - s, east - west);
  const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30].find((st) => range / st <= 8) ?? 30;
  return { project, step, bounds: { s, n, west, east }, scale, k };
}

export function createModules(ui, { selection }) {
  // ---- slideshow ----
  const img = h('canvas', { class: 'ss-canvas' }); const cap = h('div', { class: 'ss-cap' });
  const ss = h('div', { class: 'slideshow', hidden: true, role: 'region', 'aria-label': 'Slideshow', tabindex: -1 }, img, cap);
  document.body.append(ss);
  let show = null;
  async function photosToShow() {
    const sel = selection();
    if (sel.length > 1) return sel;
    const r = await ui.read('list_folder', {});
    return r.status === 'ok' ? r.result.photos.map((p) => p.path) : [];
  }
  async function frame(path) {
    const edge = Math.min(2048, Math.round(Math.max(innerWidth, innerHeight) * devicePixelRatio));
    const r = await ui.read('render_photos', { paths: [path], maxEdge: edge });
    return r.status === 'ok' ? decodeJpeg(r.result.photos[0]) : null;
  }
  async function startSlideshow({ seconds = 4 } = {}) {
    const paths = await photosToShow();
    if (!paths.length) { ui.say('No photos to show: open a folder first.'); return null; }
    show = { paths, i: 0, seconds, paused: false, timer: null, next: null };
    ss.hidden = false; ss.focus();
    try { await ss.requestFullscreen?.(); } catch { /* full window instead */ }
    await present();
    return show;
  }
  async function present() {
    if (!show) return;
    const path = show.paths[show.i];
    const bm = (show.next && show.next.path === path ? await show.next.p : null) ?? await frame(path);
    if (!show) return;
    img.width = bm?.width ?? 1; img.height = bm?.height ?? 1;
    if (bm) img.getContext('2d').drawImage(bm, 0, 0);
    cap.textContent = `${path.split('/').pop()} · ${show.i + 1} of ${show.paths.length}${show.paused ? ' · paused (space)' : ''}`;
    const ni = (show.i + 1) % show.paths.length; show.next = { path: show.paths[ni], p: frame(show.paths[ni]) };
    clearTimeout(show.timer);
    if (!show.paused) show.timer = setTimeout(() => { if (show) { show.i = ni; present(); } }, show.seconds * 1000);
  }
  function stopSlideshow() { if (!show) return; clearTimeout(show.timer); show = null; ss.hidden = true; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
  ss.addEventListener('keydown', (e) => {
    if (!show) return;
    if (e.key === 'Escape') stopSlideshow();
    else if (e.key === 'ArrowRight') { show.i = (show.i + 1) % show.paths.length; present(); }
    else if (e.key === 'ArrowLeft') { show.i = (show.i - 1 + show.paths.length) % show.paths.length; present(); }
    else if (e.key === ' ') { e.preventDefault(); show.paused = !show.paused; present(); }
  });
  ss.addEventListener('click', () => stopSlideshow());
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && show) stopSlideshow(); });

  // ---- print ----
  const sheet = h('div', { id: 'print-sheet', hidden: true });
  document.body.append(sheet);
  // layout: 'single' (one photo per page) or 'contact' (columns × rows grid, captions)
  async function buildPrintSheet(paths, { layout = 'contact', columns = 4 } = {}) {
    const edge = layout === 'single' ? 2048 : 800;
    const cells = [];
    for (let i = 0; i < paths.length; i += 4) {
      const r = await ui.read('render_photos', { paths: paths.slice(i, i + 4), maxEdge: edge });
      if (r.status !== 'ok') throw new Error(r.error?.message ?? r.status);
      for (const p of r.result.photos) cells.push(h('figure', {}, h('img', { src: `data:${p.mime};base64,${p.base64}`, alt: p.path }), h('figcaption', {}, p.path.split('/').pop())));
    }
    sheet.className = `print-${layout}`; sheet.style.setProperty('--cols', String(columns));
    sheet.replaceChildren(...cells);
    return cells.length;
  }
  async function print() {
    const sel = selection(); const paths = sel.length ? sel : ui.ctx.activePhoto ? [ui.ctx.activePhoto] : await photosToShow();
    if (!paths.length) { ui.say('Nothing to print: select photos in the filmstrip.'); return; }
    const layout = h('select', { 'aria-label': 'Layout' }, h('option', { value: 'contact' }, 'Contact sheet'), h('option', { value: 'single' }, 'One photo per page'));
    const cols = h('select', { 'aria-label': 'Columns' }, [2, 3, 4, 5].map((n) => h('option', { value: n, selected: n === 4 }, n)));
    const v = await ui.dialogs.raw({ title: `Print ${paths.length} photo${paths.length > 1 ? 's' : ''}`, body: h('div', { class: 'form' }, h('label', { class: 'field' }, h('span', {}, 'Layout'), layout), h('label', { class: 'field' }, h('span', {}, 'Columns'), cols), h('p', { class: 'hint' }, 'Opens the browser print dialog; choose a printer or Save as PDF there.')),
      actions: [{ label: 'Cancel', value: null }, { label: 'Print…', primary: true, value: () => ({ layout: layout.value, columns: Number(cols.value) }) }] });
    if (!v) return;
    ui.say('Rendering photos for print…');
    await buildPrintSheet(paths, v);
    ui.say('');
    addEventListener('afterprint', () => sheet.replaceChildren(), { once: true });
    window.print();
  }

  // ---- web gallery ----
  async function gallery() {
    const sel = selection(); const paths = sel.length ? sel : await photosToShow();
    if (!paths.length) { ui.say('No photos for a gallery: open a folder first.'); return null; }
    const title = h('input', { type: 'text', value: 'Gallery', 'aria-label': 'Title' });
    const folder = h('input', { type: 'text', value: 'exports/gallery', 'aria-label': 'Folder' });
    const edge = h('select', { 'aria-label': 'Image size' }, [1024, 1600, 2048, 3000].map((n) => h('option', { value: n, selected: n === 2048 }, `${n} px`)));
    const v = await ui.dialogs.raw({ title: `Web gallery of ${paths.length} photo${paths.length > 1 ? 's' : ''}`, body: h('div', { class: 'form' }, h('label', { class: 'field' }, h('span', {}, 'Title'), title), h('label', { class: 'field' }, h('span', {}, 'Folder'), folder), h('label', { class: 'field' }, h('span', {}, 'Image size'), edge), h('p', { class: 'hint' }, 'Writes index.html, images/ and thumbs/ into the folder. The page has no scripts and loads nothing from the internet.')),
      actions: [{ label: 'Cancel', value: null }, { label: 'Write gallery', primary: true, value: () => ({ title: title.value || 'Gallery', folder: folder.value || 'exports/gallery', maxEdge: Number(edge.value) }) }] });
    if (!v) return null;
    ui.say(`Writing the gallery to ${v.folder}/…`);
    const r = await ui.send('export_web_gallery', { paths, ...v });
    if (r.status === 'ok') ui.say(`Gallery written: ${r.result.index} (${r.result.photos} photos).`);
    return r;
  }

  // ---- book (a Paginella document) ----
  async function book() {
    const sel = selection(); const paths = sel.length ? sel : ui.ctx.activePhoto ? [ui.ctx.activePhoto] : [];
    if (!paths.length) { ui.say('Select photos in the filmstrip for the book.'); return null; }
    const title = await ui.dialogs.promptText(`Book of ${paths.length} photo${paths.length > 1 ? 's' : ''}`, 'Title', 'Photo book');
    if (!title) return null;
    ui.say('Writing the book…');
    const r = await ui.send('make_book', { paths, title });
    if (r.status === 'ok') ui.say(`Book written: ${r.result.path} (${r.result.pages} pages); ${r.result.handoff}.`);
    return r;
  }

  // ---- map ----
  const mapBox = h('div', { class: 'map-box' }); const mapNote = h('span', { class: 'dim' });
  const mapRoot = h('div', { class: 'view-overlay', hidden: true, role: 'region', 'aria-label': 'Map' },
    h('div', { class: 'cmp-bar' }, h('strong', {}, 'Map'), mapNote, h('span', { class: 'grow' }), h('button', { onclick: () => { mapRoot.hidden = true; } }, 'Close (Esc)')), mapBox);
  document.querySelector('#stage').append(mapRoot);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mapRoot.hidden) mapRoot.hidden = true; });
  async function map() {
    const placed = []; let missing = 0; let total = 0;
    for (let page = 0, pages = 1; page < Math.min(pages, 20); page++) {
      const r = await ui.read('list_photo_locations', { page });
      if (r.status !== 'ok') { ui.say(`Map: ${r.error?.message ?? r.status}`); return r; }
      placed.push(...r.result.placed); missing += r.result.missing.length; total = r.result.total; pages = r.result.pages;
    }
    mapRoot.hidden = false;
    mapNote.textContent = `${placed.length} of ${total} photos have GPS${missing ? `; ${missing} without` : ''}. Plain grid, no online map.`;
    const rect = mapBox.getBoundingClientRect(); const W = Math.max(300, rect.width); const H = Math.max(200, rect.height);
    const m = mapProjection(placed, W, H);
    const lines = [];
    const { s, n, west, east } = m.bounds;
    const start = (v) => Math.ceil(v / m.step) * m.step;
    for (let lat = start(s - m.step * 2); lat <= n + m.step * 2; lat += m.step) { const [, y] = m.project(lat, 0); lines.push(svg('line', { x1: 0, x2: W, y1: y, y2: y, class: 'map-grid' }), svg('text', { x: 4, y: y - 3, class: 'map-label' }, `${+lat.toFixed(4)}°`)); }
    for (let lon = start(west - m.step * 4); lon <= east + m.step * 4; lon += m.step) { const [x] = m.project(0, lon); lines.push(svg('line', { x1: x, x2: x, y1: 0, y2: H, class: 'map-grid' }), svg('text', { x: x + 3, y: H - 4, class: 'map-label' }, `${+lon.toFixed(4)}°`)); }
    const dots = placed.map((p) => { const [x, y] = m.project(p.lat, p.lon); return svg('g', { class: 'map-dot', tabindex: 0, dataset: { command: 'open_photo', path: p.path }, onclick: () => ui.send('open_photo', { path: p.path }) },
      svg('circle', { cx: x, cy: y, r: 6 }), svg('text', { x: x + 9, y: y + 4 }, p.path.split('/').pop()), svg('title', {}, `${p.path} · ${p.lat}, ${p.lon}`)); });
    mapBox.replaceChildren(svg('svg', { width: W, height: H, role: 'img', 'aria-label': `Map of ${placed.length} photos` }, ...lines, ...dots));
    return { placed, missing, total };
  }

  return { startSlideshow, stopSlideshow, buildPrintSheet, print, gallery, map, book, get slideshow() { return show; } };
}
