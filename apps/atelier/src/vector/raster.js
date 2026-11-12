// Vector rasteriser: path models (src/vector/geom.js) → anti-aliased coverage, pure JS, no DOM. One
// rasteriser serves vector masks, path → selection and shape layers, so all three agree pixel for pixel.
//
// Coverage is exact area coverage per pixel (the signed-area accumulation method described by Raph
// Levien for font-rs; written here from the description): every polygon edge deposits, into the cells
// of the rows it crosses, the signed area it sweeps to its right; a running sum along each row then
// gives the winding-weighted area covered in each pixel.
//   nonzero: coverage = min(1, |sum|)                       (exact for paths that do not overlap themselves)
//   evenodd: coverage = 1 − |1 − (|sum| mod 2)|             (exact where the winding number is 0 or 1)
// Pixel (i, j) spans [i, i+1] × [j, j+1] in the target grid, so a pixel centre is (i + 0.5, j + 0.5).

import { transformModel, flatten, bounds } from './geom.js';
import { gaussBlur } from '../select/raster.js';

const FLAT_TOL = 0.05;   // flattening tolerance in target pixels: chord error under 1/20 px

// Model (document or local units) → polygons in target pixels after the affine matrix.
export function toPolys(model, matrix = null, tol = FLAT_TOL) {
  const m = matrix ? transformModel(model, matrix) : model;
  return flatten(m, tol).map((pts, k) => ({ pts, closed: !!m[k].closed })).filter((p) => p.pts.length > 1);
}

// Signed area of a closed polygon (positive when clockwise on screen, y down).
export function polyArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]);
  return a / 2;
}

// Clips the edge (x0,y0)→(x1,y1) at x = 0 and x = w and clamps what lies outside onto those lines: an edge
// left of the grid still adds its winding to column 0, which is what the area to its right needs.
function clipX(x0, y0, x1, y1, w, out) {
  const cuts = [0];
  for (const X of [0, w]) if ((x0 - X) * (x1 - X) < 0) cuts.push((X - x0) / (x1 - x0));
  cuts.push(1); cuts.sort((a, b) => a - b);
  for (let k = 0; k + 1 < cuts.length; k++) {
    const t0 = cuts[k]; const t1 = cuts[k + 1]; if (t1 <= t0) continue;
    const ax = x0 + (x1 - x0) * t0; const ay = y0 + (y1 - y0) * t0; const bx = x0 + (x1 - x0) * t1; const by = y0 + (y1 - y0) * t1;
    out.push([Math.min(w, Math.max(0, ax)), ay, Math.min(w, Math.max(0, bx)), by]);
  }
}

// Accumulates one edge into acc (row stride w + 2; the two spare cells per row take spill at x = w).
function edge(acc, w, h, x0, y0, x1, y1) {
  if (y0 === y1) return;
  let dir = 1;
  if (y0 > y1) { dir = -1; [x0, y0, x1, y1] = [x1, y1, x0, y0]; }
  const S = w + 2;
  const dxdy = (x1 - x0) / (y1 - y0);
  let x = x0; if (y0 < 0) x -= y0 * dxdy;
  const yStart = Math.max(0, Math.floor(y0)); const yEnd = Math.min(h, Math.ceil(y1));
  for (let y = yStart; y < yEnd; y++) {
    const row = y * S;
    const dy = Math.min(y + 1, y1) - Math.max(y, y0);
    const xn = x + dxdy * dy;
    const d = dy * dir;
    const xa = Math.min(x, xn); const xb = Math.max(x, xn);
    const xaf = Math.floor(xa); const xai = xaf | 0; const xbc = Math.ceil(xb); const xbi = xbc | 0;
    if (xbi <= xai + 1) {
      const xmf = 0.5 * (x + xn) - xaf;
      acc[row + xai] += d - d * xmf;
      acc[row + xai + 1] += d * xmf;
    } else {
      const s = 1 / (xb - xa);
      const x0f = xa - xaf;
      const a0 = 0.5 * s * (1 - x0f) * (1 - x0f);
      const x1f = xb - xbc + 1;
      const am = 0.5 * s * x1f * x1f;
      acc[row + xai] += d * a0;
      if (xbi === xai + 2) acc[row + xai + 1] += d * (1 - a0 - am);
      else {
        const a1 = s * (1.5 - x0f);
        acc[row + xai + 1] += d * (a1 - a0);
        for (let xi = xai + 2; xi < xbi - 1; xi++) acc[row + xi] += d * s;
        const a2 = a1 + (xbi - xai - 3) * s;
        acc[row + xbi - 1] += d * (1 - a2 - am);
      }
      acc[row + xbi] += d * am;
    }
    x = xn;
  }
}

// Polygons (each closed implicitly) → Float32 coverage 0..1 on a w × h grid whose origin is (ox, oy).
export function coverage(polys, w, h, { fillRule = 'nonzero', ox = 0, oy = 0 } = {}) {
  const S = w + 2;
  const acc = new Float32Array(S * h + 2);
  const segs = [];
  for (const p of polys) {
    const pts = p.pts || p;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]; const b = pts[(i + 1) % pts.length];
      segs.length = 0;
      clipX(a[0] - ox, a[1] - oy, b[0] - ox, b[1] - oy, w, segs);
      for (const s of segs) edge(acc, w, h, s[0], s[1], s[2], s[3]);
    }
  }
  const out = new Float32Array(w * h);
  const even = fillRule === 'evenodd';
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < w; x++) {
      sum += acc[y * S + x];
      const v = Math.abs(sum);
      out[y * w + x] = even ? 1 - Math.abs(1 - (v % 2)) : Math.min(1, v);
    }
  }
  return out;
}

// Pixel box (integer, clamped to the grid) around polygons, grown by pad pixels; null when empty.
export function polyBox(polys, w, h, pad = 0) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p.pts || p) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  if (!Number.isFinite(x0)) return null;
  const bx0 = Math.max(0, Math.floor(x0 - pad)); const by0 = Math.max(0, Math.floor(y0 - pad));
  const bx1 = Math.min(w, Math.ceil(x1 + pad)); const by1 = Math.min(h, Math.ceil(y1 + pad));
  return bx1 > bx0 && by1 > by0 ? { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 } : null;
}

// Model → 8-bit mask on a w × h grid (a document, or a layer's source grid via matrix: model units →
// grid pixels). feather is the Gaussian sigma in grid pixels (the same meaning as refine_selection
// feather). Only the path's box (plus 3 sigma) is rasterised; the rest stays 0.
export function maskFromModel(model, w, h, { matrix = null, feather = 0, fillRule = 'nonzero', invert = false } = {}) {
  const polys = toPolys(model, matrix);
  const out = new Uint8Array(w * h);
  const box = polyBox(polys, w, h, Math.ceil(3 * feather) + 1);
  if (box) {
    let cov = coverage(polys, box.w, box.h, { fillRule, ox: box.x, oy: box.y });
    if (feather > 0) cov = gaussBlur(cov, box.w, box.h, 1, feather);
    for (let j = 0; j < box.h; j++) for (let i = 0; i < box.w; i++) out[(box.y + j) * w + box.x + i] = Math.round(255 * Math.min(1, Math.max(0, cov[j * box.w + i])));
  }
  if (invert) for (let i = 0; i < out.length; i++) out[i] = 255 - out[i];
  return out;
}

// ---- strokes -------------------------------------------------------------------------------------
// A stroke is the union of one quad per polyline segment plus a join piece at every inner vertex and a
// cap at each open end. Every piece is wound clockwise so the nonzero sum covers the union; where two
// pieces both cross one edge pixel the clamped sum can over-count that pixel's coverage slightly.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const nrm = (v) => { const l = Math.hypot(v[0], v[1]); return l ? [v[0] / l, v[1] / l] : [0, 0]; };
const cw = (pts) => (polyArea(pts) < 0 ? pts.slice().reverse() : pts);

function disc(c, r, n = Math.max(12, Math.ceil(r * 2))) {
  const pts = [];
  for (let i = 0; i < n; i++) { const t = (i / n) * 2 * Math.PI; pts.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); }
  return pts;
}

// polylines: [{ pts, closed }]; width in target pixels. Returns clockwise polygons.
export function strokePolys(polylines, width, { join = 'miter', cap = 'butt', miterLimit = 4 } = {}) {
  const r = width / 2; const out = [];
  for (const { pts: raw, closed } of polylines) {
    const pts = raw.filter((p, i) => i === 0 || Math.hypot(p[0] - raw[i - 1][0], p[1] - raw[i - 1][1]) > 1e-9);
    if (closed && pts.length > 2 && Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < 1e-9) pts.pop();
    if (pts.length < 2) { if (pts.length === 1 && cap === 'round') out.push(cw(disc(pts[0], r))); continue; }
    const n = pts.length; const segCount = closed ? n : n - 1;
    const norms = [];
    for (let i = 0; i < segCount; i++) {
      const a = pts[i]; const b = pts[(i + 1) % n];
      const t = nrm(sub(b, a)); const nv = [-t[1] * r, t[0] * r];
      norms.push(nv);
      out.push(cw([[a[0] + nv[0], a[1] + nv[1]], [b[0] + nv[0], b[1] + nv[1]], [b[0] - nv[0], b[1] - nv[1]], [a[0] - nv[0], a[1] - nv[1]]]));
    }
    const joinAt = (k, nIn, nOut) => {
      const p = pts[k];
      if (join === 'round') { out.push(cw(disc(p, r))); return; }
      // The outer side of the turn: the side whose offset points away from the turn direction.
      const tIn = [nIn[1], -nIn[0]]; const tOut = [nOut[1], -nOut[0]];
      const turn = tIn[0] * tOut[1] - tIn[1] * tOut[0];
      if (Math.abs(turn) < 1e-12) return;
      const s = turn > 0 ? -1 : 1;
      const a = [p[0] + s * nIn[0], p[1] + s * nIn[1]]; const b = [p[0] + s * nOut[0], p[1] + s * nOut[1]];
      const bevel = [p, a, b];
      if (join === 'miter') {
        const mid = nrm([nIn[0] + nOut[0], nIn[1] + nOut[1]]);
        const cosHalf = (mid[0] * nIn[0] + mid[1] * nIn[1]) / r;
        const ratio = cosHalf > 1e-9 ? 1 / cosHalf : Infinity;   // miter length / stroke width
        if (ratio <= miterLimit) { const m = [p[0] + s * mid[0] * r * ratio, p[1] + s * mid[1] * r * ratio]; out.push(cw([p, a, m, b])); return; }
      }
      out.push(cw(bevel));
    };
    for (let k = closed ? 0 : 1; k < (closed ? n : n - 1); k++) joinAt(k, norms[(k - 1 + segCount) % segCount], norms[k % segCount]);
    if (!closed) {
      for (const [p, q] of [[pts[0], pts[1]], [pts[n - 1], pts[n - 2]]]) {
        if (cap === 'round') out.push(cw(disc(p, r)));
        else if (cap === 'square') {
          const t = nrm(sub(p, q)); const nv = [-t[1] * r, t[0] * r]; const e = [p[0] + t[0] * r, p[1] + t[1] * r];
          out.push(cw([[p[0] + nv[0], p[1] + nv[1]], [e[0] + nv[0], e[1] + nv[1]], [e[0] - nv[0], e[1] - nv[1]], [p[0] - nv[0], p[1] - nv[1]]]));
        }
      }
    }
  }
  return out;
}

// Splits polylines into dashes. dash: [on, off, ...] in target pixels (an odd list repeats, as SVG does).
export function dashPolylines(polylines, dash, offset = 0) {
  const d = dash.length % 2 ? [...dash, ...dash] : dash.slice();
  const total = d.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return polylines;
  const out = [];
  for (const { pts: raw, closed } of polylines) {
    const pts = closed ? [...raw, raw[0]] : raw;
    let k = 0; let left = d[0]; let pos = ((offset % total) + total) % total;
    while (pos > 0) { if (pos >= left) { pos -= left; k = (k + 1) % d.length; left = d[k]; } else { left -= pos; pos = 0; } }
    let cur = k % 2 === 0 ? [pts[0]] : null;
    for (let i = 0; i + 1 < pts.length; i++) {
      let a = pts[i]; const b = pts[i + 1];
      let segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      while (segLen > 0) {
        if (left >= segLen) { left -= segLen; if (cur) cur.push(b); segLen = 0; }
        else {
          const t = left / segLen; const m = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          segLen -= left; a = m;
          if (cur) { cur.push(m); if (cur.length > 1) out.push({ pts: cur, closed: false }); cur = null; } else cur = [m];
          k = (k + 1) % d.length; left = d[k];
        }
      }
    }
    if (cur && cur.length > 1) out.push({ pts: cur, closed: false });
  }
  return out;
}

// ---- shape layers ----------------------------------------------------------------------------------
// shape: { model (layer-local units), fill: '#rrggbb[aa]' | null, stroke: { color, width, align
// ('center' | 'inside' | 'outside'), dash: [..] | null, join, cap } | null, fillRule }.
// Returns { pixels (8-bit sRGB RGBA, straight alpha), width, height, offset: [x, y] } where offset is the
// local position of pixel (0, 0). Formulas, per pixel, with F the fill coverage and S the stroke coverage:
//   inside stroke  S = S2 · F        outside stroke  S = S2 · (1 − F)       (S2: a centred stroke of 2 × width)
//   colour over:   a = aS + aF·(1 − aS);  rgb = (rgbS·aS + rgbF·aF·(1 − aS)) / a   (stroke over fill, sRGB values)
export function shapeExtent(shape) {
  const b = bounds(shape.model);
  const sw = shape.stroke && shape.stroke.width > 0 ? shape.stroke.width : 0;
  const reach = sw ? (shape.stroke.align === 'inside' ? 0 : shape.stroke.align === 'outside' ? sw : sw / 2) * Math.max(1, shape.stroke.join === 'miter' ? (shape.stroke.miterLimit ?? 4) : 1) + sw : 0;
  const pad = Math.ceil(reach) + 2;
  const x = Math.floor(b.x) - pad; const y = Math.floor(b.y) - pad;
  return { x, y, width: Math.max(1, Math.ceil(b.x + b.width) + pad - x), height: Math.max(1, Math.ceil(b.y + b.height) + pad - y) };
}

export function parseColour(hex) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex || '');
  if (!m) return null;
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(m[2] ? parseInt(m[2], 16) : 255);
}

export function rasterShape(shape) {
  const ext = shapeExtent(shape);
  const { width: w, height: h } = ext;
  const polys = toPolys(shape.model);
  const fillRule = shape.fillRule || 'nonzero';
  const F = coverage(polys, w, h, { fillRule, ox: ext.x, oy: ext.y });
  let S = null;
  const st = shape.stroke;
  if (st && st.width > 0 && st.color) {
    const closedOnly = st.align && st.align !== 'center';
    const width = closedOnly ? st.width * 2 : st.width;
    const lines = st.dash && st.dash.length ? dashPolylines(polys, st.dash, st.dashOffset || 0) : polys;
    S = coverage(strokePolys(lines, width, st), w, h, { ox: ext.x, oy: ext.y });
    if (st.align === 'inside') for (let i = 0; i < S.length; i++) S[i] *= F[i];
    else if (st.align === 'outside') for (let i = 0; i < S.length; i++) S[i] *= 1 - F[i];
  }
  const fc = shape.fill ? parseColour(shape.fill) : null; const sc = st?.color ? parseColour(st.color) : null;
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const aF = fc ? F[i] * fc[3] / 255 : 0; const aS = S && sc ? S[i] * sc[3] / 255 : 0;
    const a = aS + aF * (1 - aS);
    if (a <= 0) continue;
    for (let c = 0; c < 3; c++) px[i * 4 + c] = Math.round(((sc ? sc[c] : 0) * aS + (fc ? fc[c] : 0) * aF * (1 - aS)) / a);
    px[i * 4 + 3] = Math.round(255 * a);
  }
  return { pixels: px, width: w, height: h, offset: [ext.x, ext.y] };
}
