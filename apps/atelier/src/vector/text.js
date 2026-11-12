// Rich type: per-character runs (font, size, colour, tracking, baseline shift, bold, italic), OpenType
// features through CSS font-feature-settings, type on a path, and warped type. A text layer whose
// text.runs, text.features, text.path or text.warp is set renders through rasterRichText here; a plain
// text layer keeps the engine's own text source (vendor/tessella createTextSource).
//
// The rasteriser writes the text as SVG <text> and lets the browser lay it out, then draws the SVG into a
// canvas. Type on a path uses SVG <textPath>, the same route as Ductella's type-on-path tool
// (Ductella src/type.js makeOnPath, commit b0d5a3c); the path model and its reversal come from the
// Ductella geometry copied into src/vector/geom.js. Warps are Atelier's own formulas (warpForward below),
// applied to the flat text's pixels by inverse mapping with bilinear sampling of premultiplied colour.
//
// Units: size and baselineShift in pixels; tracking in thousandths of an em (Photoshop's unit), so
// letter-spacing = tracking / 1000 × size px; startOffset in percent of the path length.

import { writePath, reverseModel } from './geom.js';

export const FEATURES = ['liga', 'kern', 'smcp', 'onum', 'dlig', 'lnum', 'tnum', 'frac', 'c2sc', 'swsh'];
export const WARPS = ['arc', 'arch', 'bulge', 'flag', 'wave'];
const RUN_KEYS = ['font', 'size', 'color', 'tracking', 'baselineShift', 'bold', 'italic'];

export const isRich = (t) => !!(t && ((t.runs && t.runs.length) || t.features || t.path || t.warp || t.style?.tracking || t.style?.baselineShift));

// Validation shared by the handler and tests; returns an error message or null.
export function checkRich(t) {
  const n = [...(t.content || '')].length;
  for (const [i, r] of (t.runs || []).entries()) {
    if (!(Number.isInteger(r.start) && Number.isInteger(r.end) && r.start >= 0 && r.end > r.start && r.end <= n)) return `runs[${i}]: need 0 <= start < end <= ${n} (character indices)`;
    if (!RUN_KEYS.some((k) => r[k] !== undefined)) return `runs[${i}] sets no style (${RUN_KEYS.join(', ')})`;
  }
  if (t.path && t.warp) return 'warped type on a path is not built; use one or the other';
  if (t.warp && !WARPS.includes(t.warp.style)) return `warp.style must be one of ${WARPS.join(', ')}`;
  if (t.path && !(t.path.model && t.path.model.some((sp) => sp.anchors.length > 1))) return 'path has no segments';
  return null;
}

// Content split into style segments: each character takes the base style, then every run that covers
// it in order (a later run wins on the keys it sets). Character indices count code points.
export function segments(t) {
  const chars = [...(t.content || '')];
  const base = t.style || {};
  const styleAt = (i) => {
    const s = { ...base };
    for (const r of t.runs || []) if (i >= r.start && i < r.end) for (const k of RUN_KEYS) if (r[k] !== undefined) s[k] = r[k];
    return s;
  };
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    const s = styleAt(i); const key = JSON.stringify(s);
    if (out.length && out.at(-1).key === key && chars[i] !== '\n' && out.at(-1).text.at(-1) !== '\n') out.at(-1).text += chars[i];
    else out.push({ key, style: s, text: chars[i] });
  }
  return out.map(({ style, text }) => ({ style, text }));
}

export function featureSettings(features) {
  if (!features) return '';
  return Object.entries(features).filter(([k]) => FEATURES.includes(k)).map(([k, v]) => `'${k}' ${v ? 1 : 0}`).join(', ');
}

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const family = (f) => String(f || 'system-ui').split(',').map((x) => x.trim()).map((x) => (/^[\w-]+$/.test(x) ? x : `'${x.replace(/['"]/g, '')}'`)).join(', ');

function spanAttrs(s) {
  const a = [`font-family="${xml(family(s.font))}"`, `font-size="${s.size}"`, `fill="${xml(s.color || '#000000')}"`,
    `font-weight="${s.bold ? 700 : 400}"`, `font-style="${s.italic ? 'italic' : 'normal'}"`];
  if (s.tracking) a.push(`letter-spacing="${(s.tracking / 1000) * s.size}"`);
  if (s.baselineShift) a.push(`baseline-shift="${s.baselineShift}"`);
  return a.join(' ');
}

// The <text> element (and the <defs> its path needs) as SVG markup in layer-local units.
export function textMarkup(t) {
  const st = t.style || {};
  const size = st.size || 64; const lh = Math.round(size * (st.lineHeight || 1.2));
  const ff = featureSettings(t.features);
  const style = `white-space:pre;${ff ? `font-feature-settings:${ff};` : ''}${t.features && t.features.kern === false ? 'font-kerning:none;' : ''}`;
  const segs = segments(t);
  if (t.path) {
    const model = t.path.flip ? reverseModel(t.path.model) : t.path.model;
    const inner = segs.map((g) => `<tspan ${spanAttrs(g.style)}>${xml(g.text.replace(/\n/g, ' '))}</tspan>`).join('');
    const anchor = st.align === 'center' ? 'middle' : st.align === 'right' ? 'end' : 'start';
    const off = t.path.startOffset ?? (anchor === 'middle' ? 50 : anchor === 'end' ? 100 : 0);
    return { defs: `<path id="atelier-text-path" d="${writePath(model, 4)}"/>`,
      text: `<text style="${style}" text-anchor="${anchor}"><textPath href="#atelier-text-path" startOffset="${off}%">${inner}</textPath></text>` };
  }
  // Lines: one <tspan x="0"> per line, each holding a tspan per style segment.
  const anchor = st.align === 'center' ? 'middle' : st.align === 'right' ? 'end' : 'start';
  const lines = [[]];
  for (const g of segs) {
    const parts = g.text.split('\n');
    parts.forEach((p, i) => { if (i) lines.push([]); if (p) lines.at(-1).push({ style: g.style, text: p }); });
  }
  const body = lines.map((ln, i) => `<tspan x="0" y="${size + i * lh}">${ln.map((g) => `<tspan ${spanAttrs(g.style)}>${xml(g.text)}</tspan>`).join('') || ' '}</tspan>`).join('');
  return { defs: '', text: `<text style="${style}" text-anchor="${anchor}">${body}</text>` };
}

// ---- warps -----------------------------------------------------------------------------------------
// Box of the flat text: width W, height H, centre (cx, cy). For a source point, u = (x − cx)/(W/2) and
// y' = y − cy (pixels, down positive); b = bend / 100 in [−1, 1]. Forward maps (source → output, relative
// to the centre), Atelier's own:
//   arc:   the centre line bends onto a circle of radius R = W / (|b|·π), so the line spans b·π radians;
//          φ = u·b·π/2, X = (R − y')·sin φ, Y = R − (R − y')·cos φ   (b < 0 mirrors it: centre above)
//   arch:  X = x', Y = y' − b·(H/2)·(1 − u²)                               (the whole block bows)
//   bulge: X = x', Y = y'·(1 + b·(1 − u²))                                  (taller in the middle; b ≥ −0.9)
//   flag:  X = x', Y = y' + b·(H/2)·sin(π·u)                               (half a wave across the text)
//   wave:  X = x', Y = y' + b·(H/2)·sin(2π·u)                              (a full wave across the text)
export function warpForward(style, b, W, H) {
  const hw = W / 2;
  if (style === 'arc') {
    if (Math.abs(b) < 1e-3) return (x, y) => [x, y];
    const R = W / (Math.abs(b) * Math.PI); const s = Math.sign(b);
    return (x, y) => { const phi = (x / hw) * Math.abs(b) * Math.PI / 2; const rr = R - s * y; return [rr * Math.sin(phi), s * (R - rr * Math.cos(phi))]; };
  }
  if (style === 'arch') return (x, y) => [x, y - b * (H / 2) * (1 - (x / hw) ** 2)];
  if (style === 'bulge') return (x, y) => [x, y * (1 + Math.max(-0.9, b) * (1 - (x / hw) ** 2))];
  if (style === 'flag') return (x, y) => [x, y + b * (H / 2) * Math.sin(Math.PI * (x / hw))];
  if (style === 'wave') return (x, y) => [x, y + b * (H / 2) * Math.sin(2 * Math.PI * (x / hw))];
  throw new Error(`unknown warp ${style}`);
}
// Inverse maps (output → source), solved from the forward maps above.
export function warpInverse(style, b, W, H) {
  const hw = W / 2;
  if (style === 'arc') {
    if (Math.abs(b) < 1e-3) return (X, Y) => [X, Y];
    const R = W / (Math.abs(b) * Math.PI); const s = Math.sign(b);
    return (X, Y) => { const dy = s * Y - R; const rr = Math.hypot(X, dy); const phi = Math.atan2(X, -dy); return [(phi / (Math.abs(b) * Math.PI / 2)) * hw, s * (R - rr)]; };
  }
  if (style === 'arch') return (X, Y) => [X, Y + b * (H / 2) * (1 - (X / hw) ** 2)];
  if (style === 'bulge') return (X, Y) => [X, Y / (1 + Math.max(-0.9, b) * (1 - (X / hw) ** 2))];
  if (style === 'flag') return (X, Y) => [X, Y - b * (H / 2) * Math.sin(Math.PI * (X / hw))];
  if (style === 'wave') return (X, Y) => [X, Y - b * (H / 2) * Math.sin(2 * Math.PI * (X / hw))];
  throw new Error(`unknown warp ${style}`);
}

// Warps an RGBA8 image (straight alpha). Returns { pixels, width, height, shift: [dx, dy] }: the output's
// pixel (0, 0) sits at the input's (dx, dy).
export function warpPixels(src, w, h, { style, bend = 50 }) {
  const b = Math.max(-100, Math.min(100, bend)) / 100;
  const cx = w / 2; const cy = h / 2;
  const fwd = warpForward(style, b, w, h); const inv = warpInverse(style, b, w, h);
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  const N = 64;
  for (let k = 0; k <= N; k++) for (const [x, y] of [[k / N * w, 0], [k / N * w, h], [0, k / N * h], [w, k / N * h], [k / N * w, h / 2]]) {
    const [X, Y] = fwd(x - cx, y - cy); x0 = Math.min(x0, X); y0 = Math.min(y0, Y); x1 = Math.max(x1, X); y1 = Math.max(y1, Y);
  }
  // Output grid in input pixels: integer edges, so the shift is whole pixels.
  const left = Math.floor(x0 + cx) - 2; const top = Math.floor(y0 + cy) - 2;
  const W = Math.ceil(x1 + cx) + 2 - left; const H = Math.ceil(y1 + cy) + 2 - top;
  const ox = left - cx; const oy = top - cy;
  const out = new Uint8Array(W * H * 4);
  const at = (x, y, c) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : c === 3 ? src[(y * w + x) * 4 + 3] : src[(y * w + x) * 4 + c] * src[(y * w + x) * 4 + 3] / 255);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const [sx, sy] = inv(ox + i + 0.5, oy + j + 0.5);
    const fx = sx + cx - 0.5; const fy = sy + cy - 0.5;
    if (fx < -1 || fy < -1 || fx > w || fy > h) continue;
    const xi = Math.floor(fx); const yi = Math.floor(fy); const tx = fx - xi; const ty = fy - yi;
    const v = [0, 1, 2, 3].map((c) => (at(xi, yi, c) * (1 - tx) + at(xi + 1, yi, c) * tx) * (1 - ty) + (at(xi, yi + 1, c) * (1 - tx) + at(xi + 1, yi + 1, c) * tx) * ty);
    if (v[3] <= 0) continue;
    const k = (j * W + i) * 4;
    for (let c = 0; c < 3; c++) out[k + c] = Math.round(Math.min(255, v[c] * 255 / v[3]));
    out[k + 3] = Math.round(v[3]);
  }
  return { pixels: out, width: W, height: H, shift: [left, top] };
}

// ---- browser rasteriser ----------------------------------------------------------------------------
// Returns { pixels (8-bit sRGB RGBA, straight alpha), width, height, offset: [x, y] } with offset the
// layer-local position of pixel (0, 0). text.origin [x, y] translates the whole text (path included); the
// handler moves it by -offset and the layer matrix by +offset, so the source starts at the layer origin.
export async function rasterRichText(t) {
  const { defs, text } = textMarkup(t);
  const NS = 'http://www.w3.org/2000/svg';
  const host = document.createElementNS(NS, 'svg');
  host.setAttribute('style', 'position:absolute;left:-100000px;top:0;width:10px;height:10px;visibility:hidden');
  const [gx, gy] = t.origin || [0, 0];
  const body = `<g transform="translate(${gx} ${gy})">${text}</g>`;
  host.innerHTML = `<defs>${defs}</defs>${body}`;
  document.body.append(host);
  let bb;
  try { const r = host.querySelector('text').getBBox(); bb = { x: r.x + gx, y: r.y + gy, width: r.width, height: r.height }; } finally { host.remove(); }
  const sizes = [t.style?.size || 64, ...(t.runs || []).map((r) => r.size || 0)];
  const pad = Math.ceil(Math.max(...sizes) * 0.3) + 2;
  const x0 = Math.floor(bb.x) - pad; const y0 = Math.floor(bb.y) - pad;
  const w = Math.max(1, Math.ceil(bb.x + bb.width) + pad - x0); const h = Math.max(1, Math.ceil(bb.y + bb.height) + pad - y0);
  if (w * h > 16384 * 16384) throw new Error('text is too large to rasterise');
  const markup = `<svg xmlns="${NS}" width="${w}" height="${h}" viewBox="${x0} ${y0} ${w} ${h}"><defs>${defs}</defs>${body}</svg>`;
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  let pixels;
  try {
    const img = new Image(); img.src = url; await img.decode();
    const oc = new OffscreenCanvas(w, h); const c2 = oc.getContext('2d', { colorSpace: 'srgb' });
    c2.drawImage(img, 0, 0, w, h);
    pixels = new Uint8Array(c2.getImageData(0, 0, w, h).data.buffer);
  } finally { URL.revokeObjectURL(url); }
  if (t.warp) {
    const r = warpPixels(pixels, w, h, t.warp);
    return { pixels: r.pixels, width: r.width, height: r.height, offset: [x0 + r.shift[0], y0 + r.shift[1]] };
  }
  return { pixels, width: w, height: h, offset: [x0, y0] };
}
