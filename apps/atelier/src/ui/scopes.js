// Colour scopes panel (L58): histogram, luma waveform, RGB parade and vectorscope of the rendered preview.
// It reads get_scopes through the bus whenever the revision changes while the panel is open (debounced),
// and draws the bounded arrays on one canvas. View only: it never changes the document.

import { h } from './dom.js';

const KINDS = [['histogram', 'Histogram'], ['waveform', 'Waveform'], ['parade', 'RGB parade'], ['vectorscope', 'Vectorscope']];
const RGB = { red: [255, 70, 60], green: [60, 210, 90], blue: [70, 120, 255], luma: [235, 235, 235] };

export function createScopes(root, ui) {
  let kind = 'waveform'; let lastRev = -1; let timer = null; let data = null;
  const canvas = h('canvas', { width: 256, height: 160, class: 'scope-canvas', role: 'img', 'aria-label': 'Colour scope' });
  const note = h('div', { class: 'hint' });
  const pick = h('select', { 'aria-label': 'Scope', dataset: { command: 'get_scopes' }, onchange: (e) => { kind = e.target.value; draw(); } }, KINDS.map(([v, t]) => h('option', { value: v, selected: v === kind }, t)));
  const box = h('details', { class: 'views-section', dataset: { viewLabel: 'Colour scopes panel (waveform, parade, vectorscope, histogram)' }, ontoggle: () => { if (box.open) refresh(true); } },
    h('summary', {}, 'Scopes'), h('div', { class: 'row' }, pick), canvas, note);
  root.append(box);

  async function refresh(force = false) {
    if (!box.open || !ui.ctx.store.doc) { if (box.open) { data = null; note.textContent = 'Open a photo to see its scopes.'; draw(); } return; }
    const rev = ui.ctx.bus.state.revision;
    if (!force && rev === lastRev) return;
    lastRev = rev;
    const r = await ui.read('get_scopes', { columns: 128, levels: 128, vectorGrid: 64 });
    if (r.status !== 'ok') { note.textContent = `Scopes: ${r.error?.message ?? r.status}`; return; }
    data = r.result; note.textContent = `${data.width} × ${data.height} preview, ${data.pixels.toLocaleString()} pixels`;
    draw();
  }

  function draw() {
    const c = canvas.getContext('2d'); const W = canvas.width; const H = canvas.height;
    c.fillStyle = '#111'; c.fillRect(0, 0, W, H);
    if (!data) return;
    if (kind === 'histogram') return drawHistogram(c, W, H);
    if (kind === 'vectorscope') return drawVector(c, W, H);
    const chans = kind === 'parade' ? ['red', 'green', 'blue'] : ['luma'];
    const sw = Math.floor(W / chans.length);
    chans.forEach((ch, k) => drawWave(c, data.waveform[ch], RGB[ch], k * sw, sw, H));
    c.strokeStyle = 'rgba(255,255,255,.18)';
    for (const f of [0.25, 0.5, 0.75]) { c.beginPath(); c.moveTo(0, H * f + 0.5); c.lineTo(W, H * f + 0.5); c.stroke(); }
  }
  // Brightness of a cell: log(1 + count) / log(1 + the column's peak), so sparse values stay visible.
  function drawWave(c, grid, rgb, x0, w, H) {
    const levels = grid.length; const cols = grid[0].length;
    const img = c.createImageData(cols, levels);
    let peak = 1; for (const row of grid) for (const v of row) peak = Math.max(peak, v);
    const lp = Math.log1p(peak);
    for (let lv = 0; lv < levels; lv++) for (let x = 0; x < cols; x++) {
      const t = Math.log1p(grid[lv][x]) / lp; const i = ((levels - 1 - lv) * cols + x) * 4;
      img.data[i] = rgb[0] * t; img.data[i + 1] = rgb[1] * t; img.data[i + 2] = rgb[2] * t; img.data[i + 3] = 255;
    }
    blit(c, img, x0, 0, w, H);
  }
  function drawHistogram(c, W, H) {
    c.globalCompositeOperation = 'lighter';
    for (const ch of ['red', 'green', 'blue']) {
      const bins = data.histogram[ch]; const peak = Math.max(1, ...bins);
      c.fillStyle = `rgba(${RGB[ch].join(',')},.75)`; c.beginPath(); c.moveTo(0, H);
      bins.forEach((v, i) => c.lineTo((i / (bins.length - 1)) * W, H - (v / peak) * (H - 4)));
      c.lineTo(W, H); c.closePath(); c.fill();
    }
    c.globalCompositeOperation = 'source-over';
  }
  function drawVector(c, W, H) {
    const vs = data.vectorscope; const n = vs.size; const S = Math.min(W, H); const x0 = (W - S) / 2;
    const img = c.createImageData(n, n);
    let peak = 1; for (const row of vs.grid) for (const v of row) peak = Math.max(peak, v);
    const lp = Math.log1p(peak);
    for (let r = 0; r < n; r++) for (let q = 0; q < n; q++) {
      const t = Math.log1p(vs.grid[r][q]) / lp; const i = ((n - 1 - r) * n + q) * 4;
      img.data[i] = 120 + 135 * t; img.data[i + 1] = 230 * t; img.data[i + 2] = 120 * t; img.data[i + 3] = t > 0 ? 255 : 0;
    }
    blit(c, img, x0, 0, S, S);
    const cx = x0 + S / 2; const cy = S / 2; const R = S / 2 - 2;
    c.strokeStyle = 'rgba(255,255,255,.25)'; c.beginPath(); c.arc(cx, cy, R, 0, 2 * Math.PI); c.stroke();
    c.font = '10px sans-serif'; c.fillStyle = 'rgba(255,255,255,.7)';
    for (const [name, deg] of Object.entries(vs.targets)) {
      const a = (deg * Math.PI) / 180; const x = cx + Math.cos(a) * R * 0.86; const y = cy - Math.sin(a) * R * 0.86;
      if (name === 'skin') { c.strokeStyle = 'rgba(255,200,150,.5)'; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a) * R, cy - Math.sin(a) * R); c.stroke(); continue; }
      c.fillText(name[0].toUpperCase(), x - 3, y + 3);
    }
  }
  function blit(c, img, x, y, w, hgt) {
    const t = new OffscreenCanvas(img.width, img.height); t.getContext('2d').putImageData(img, 0, 0);
    c.imageSmoothingEnabled = true; c.drawImage(t, x, y, w, hgt);
  }

  return {
    render() { clearTimeout(timer); timer = setTimeout(() => refresh().catch((e) => { note.textContent = e.message; }), 250); },
    get open() { return box.open; }, set open(v) { box.open = v; },
    get kind() { return kind; }, set kind(v) { kind = v; pick.value = v; draw(); },
    get data() { return data; },
  };
}
