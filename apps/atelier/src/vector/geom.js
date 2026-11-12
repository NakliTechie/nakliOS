// Copied from Ductella (MIT) src/geom.js, lines 1-649, at commit b0d5a3c (github.com/NakliTechie/ductella).
// Shared vector code with Ductella: the path model, SVG path parse and write, shapes, measurement and
// flattening. Kept as close to the source as possible so fixes can travel both ways; do not edit here
// without checking Ductella. Unused Ductella editing and curve-fitting functions are left out.

// Ductella geometry core: affine matrices, the path model, parsing and writing
// SVG path data, measurement, editing and curve fitting. Pure functions, no DOM.
//
// Model    = Subpath[]
// Subpath  = { closed: boolean, anchors: Anchor[] }
// Anchor   = { x, y, hIn: {x,y}, hOut: {x,y}, type: 'corner'|'smooth' }
// Handles are relative to their anchor; a zero vector means no handle.

const PI = Math.PI;
const DEG = PI / 180;
const KAPPA = 0.5522847498;

// ---------------------------------------------------------------- matrices

export function identity() { return [1, 0, 0, 1, 0, 0]; }

/** m1 · m2: the result applies m2 first, then m1. */
export function mul(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function inv(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!det || !Number.isFinite(det)) throw new Error('singular matrix');
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function apply(m, p) {
  const [x, y] = p;
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function translate(tx, ty = 0) { return [1, 0, 0, 1, tx, ty]; }
export function scale(sx, sy = sx) { return [sx, 0, 0, sy, 0, 0]; }
export function rotate(deg, cx = 0, cy = 0) {
  const r = deg * DEG, cos = Math.cos(r), sin = Math.sin(r);
  return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
}
export function skewX(deg) { return [1, 0, Math.tan(deg * DEG), 1, 0, 0]; }
export function skewY(deg) { return [1, Math.tan(deg * DEG), 0, 1, 0, 0]; }

const NUM_RE_G = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

export function parseTransform(str) {
  let m = identity();
  if (!str) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let hit;
  while ((hit = re.exec(String(str)))) {
    const v = (hit[2].match(NUM_RE_G) || []).map(Number);
    let t = null;
    switch (hit[1]) {
      case 'matrix': if (v.length >= 6) t = v.slice(0, 6); break;
      case 'translate': if (v.length >= 1) t = translate(v[0], v[1] ?? 0); break;
      case 'scale': if (v.length >= 1) t = scale(v[0], v[1] ?? v[0]); break;
      case 'rotate': if (v.length >= 1) t = rotate(v[0], v[1] ?? 0, v[2] ?? 0); break;
      case 'skewX': if (v.length >= 1) t = skewX(v[0]); break;
      case 'skewY': if (v.length >= 1) t = skewY(v[0]); break;
    }
    if (t) m = mul(m, t);
  }
  return m;
}

export function fmt(n, precision = 3) {
  if (!Number.isFinite(n)) n = 0;
  let s = n.toFixed(precision);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

export function formatTransform(m, precision = 3) {
  const tol = 0.5 * 10 ** -Math.max(precision, 6);
  const isId = (v, w) => Math.abs(v - w) <= tol;
  const linearId = isId(m[0], 1) && isId(m[1], 0) && isId(m[2], 0) && isId(m[3], 1);
  if (linearId) {
    if (fmt(m[4], precision) === '0' && fmt(m[5], precision) === '0') return '';
    return `translate(${fmt(m[4], precision)} ${fmt(m[5], precision)})`;
  }
  return `matrix(${m.map((v) => fmt(v, precision)).join(' ')})`;
}

/** m = translate(tx,ty) · rotate(rotation) · skewX(skewX) · scale(sx,sy). Angles in degrees. */
export function decompose(m) {
  const [a, b, c, d, e, f] = m;
  const sx = Math.hypot(a, b);
  const det = a * d - b * c;
  const rotation = sx ? Math.atan2(b, a) / DEG : 0;
  const sy = sx ? det / sx : Math.hypot(c, d);
  const skew = det ? Math.atan((a * c + b * d) / det) / DEG : 0;
  return { tx: e, ty: f, sx, sy, rotation, skewX: skew };
}

// ---------------------------------------------------------------- model basics

const zero = () => ({ x: 0, y: 0 });
const isZero = (h, eps = 1e-12) => Math.abs(h.x) <= eps && Math.abs(h.y) <= eps;

export function makeAnchor(x, y, hIn = zero(), hOut = zero(), type) {
  const a = { x, y, hIn: { x: hIn.x, y: hIn.y }, hOut: { x: hOut.x, y: hOut.y }, type: 'corner' };
  a.type = type || anchorType(a);
  return a;
}

export function anchorType(a) {
  const li = Math.hypot(a.hIn.x, a.hIn.y), lo = Math.hypot(a.hOut.x, a.hOut.y);
  if (li < 1e-9 || lo < 1e-9) return 'corner';
  // angle between hOut and -hIn
  const cross = a.hOut.x * -a.hIn.y - a.hOut.y * -a.hIn.x;
  const dot = a.hOut.x * -a.hIn.x + a.hOut.y * -a.hIn.y;
  return Math.abs(Math.atan2(cross, dot)) < 1e-3 ? 'smooth' : 'corner';
}

function retype(model) {
  for (const sp of model) for (const a of sp.anchors) a.type = anchorType(a);
  return model;
}

function cloneAnchor(a) {
  return { x: a.x, y: a.y, hIn: { x: a.hIn.x, y: a.hIn.y }, hOut: { x: a.hOut.x, y: a.hOut.y }, type: a.type };
}
function cloneSub(sp) { return { closed: !!sp.closed, anchors: sp.anchors.map(cloneAnchor) }; }
export function cloneModel(model) { return model.map(cloneSub); }

// ---------------------------------------------------------------- path parsing

const CMD_RE = /[MmLlHhVvCcSsQqTtAaZz]/;

export function arcToCubics(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (!rx || !ry) return [[x1, y1, x2, y2, x2, y2]];
  const phi = phiDeg * DEG, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const rx2 = rx * rx, ry2 = ry * ry;
  let num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  if (num < 0) num = 0;
  let coef = Math.sqrt(num / (rx2 * y1p * y1p + ry2 * x1p * x1p));
  if (!!fa === !!fs) coef = -coef;
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const th1 = ang(1, 0, ux, uy);
  let dth = ang(ux, uy, vx, vy);
  if (!fs && dth > 0) dth -= 2 * PI;
  if (fs && dth < 0) dth += 2 * PI;
  const nseg = Math.max(1, Math.ceil(Math.abs(dth) / (PI / 2) - 1e-9));
  const delta = dth / nseg, k = (4 / 3) * Math.tan(delta / 4);
  const map = (x, y) => [cx + cos * rx * x - sin * ry * y, cy + sin * rx * x + cos * ry * y];
  const out = [];
  for (let j = 0; j < nseg; j++) {
    const t1 = th1 + j * delta, t2 = t1 + delta;
    const c1t = Math.cos(t1), s1t = Math.sin(t1), c2t = Math.cos(t2), s2t = Math.sin(t2);
    const c1 = map(c1t - k * s1t, s1t + k * c1t);
    const c2 = map(c2t + k * s2t, s2t - k * c2t);
    const p = j === nseg - 1 ? [x2, y2] : map(c2t, s2t);
    out.push([c1[0], c1[1], c2[0], c2[1], p[0], p[1]]);
  }
  return out;
}

export function parsePath(d) {
  const s = String(d ?? '');
  const n = s.length;
  const model = [];
  let i = 0;
  const numRe = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  const skip = () => {
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 44) i++;
      else break;
    }
  };
  const num = () => {
    skip();
    numRe.lastIndex = i;
    const m = numRe.exec(s);
    if (!m) return null;
    i = numRe.lastIndex;
    const v = parseFloat(m[0]);
    return Number.isFinite(v) ? v : null;
  };
  const flag = () => {
    skip();
    const c = s[i];
    if (c === '0' || c === '1') { i++; return c === '1'; }
    return null;
  };
  const nums = (k) => {
    const out = [];
    for (let j = 0; j < k; j++) { const v = num(); if (v === null) return null; out.push(v); }
    return out;
  };

  let sp = null, cx = 0, cy = 0, sx = 0, sy = 0;
  let lastC2 = null, lastQ = null, prev = '';
  let cmd = null;

  const startSub = (x, y) => {
    if (sp && !sp.closed && sp.anchors.length === 1) model.pop();
    sp = { closed: false, anchors: [makeAnchor(x, y)] };
    model.push(sp);
    cx = sx = x; cy = sy = y;
  };
  const ensureSub = () => { if (!sp || sp.closed) startSub(cx, cy); };
  const cubicTo = (x1, y1, x2, y2, x, y) => {
    ensureSub();
    const last = sp.anchors[sp.anchors.length - 1];
    last.hOut = { x: x1 - last.x, y: y1 - last.y };
    sp.anchors.push(makeAnchor(x, y, { x: x2 - x, y: y2 - y }));
    cx = x; cy = y;
  };
  const lineTo = (x, y) => cubicTo(cx, cy, x, y, x, y);

  for (;;) {
    skip();
    if (i >= n) break;
    const ch = s[i];
    if (CMD_RE.test(ch)) { cmd = ch; i++; }
    else if (cmd === null) break;
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    const C = cmd.toUpperCase();
    let c2 = null, q = null;
    if (C === 'Z') {
      if (sp && !sp.closed) {
        const a = sp.anchors;
        if (a.length > 1) {
          const f = a[0], l = a[a.length - 1];
          if (Math.abs(f.x - l.x) < 1e-9 && Math.abs(f.y - l.y) < 1e-9) {
            f.hIn = l.hIn;
            a.pop();
          }
        }
        sp.closed = true;
      }
      cx = sx; cy = sy;
      cmd = null; // no implicit repeat after Z
      prev = 'Z'; lastC2 = lastQ = null;
      continue;
    } else if (C === 'M') {
      const v = nums(2); if (!v) break;
      startSub(v[0] + ox, v[1] + oy);
      cmd = rel ? 'l' : 'L';
    } else if (C === 'L') {
      const v = nums(2); if (!v) break;
      lineTo(v[0] + ox, v[1] + oy);
    } else if (C === 'H') {
      const v = nums(1); if (!v) break;
      lineTo(v[0] + ox, cy);
    } else if (C === 'V') {
      const v = nums(1); if (!v) break;
      lineTo(cx, v[0] + oy);
    } else if (C === 'C') {
      const v = nums(6); if (!v) break;
      c2 = [v[2] + ox, v[3] + oy];
      cubicTo(v[0] + ox, v[1] + oy, c2[0], c2[1], v[4] + ox, v[5] + oy);
    } else if (C === 'S') {
      const v = nums(4); if (!v) break;
      const r = (prev === 'C' || prev === 'S') && lastC2 ? [2 * cx - lastC2[0], 2 * cy - lastC2[1]] : [cx, cy];
      c2 = [v[0] + ox, v[1] + oy];
      cubicTo(r[0], r[1], c2[0], c2[1], v[2] + ox, v[3] + oy);
    } else if (C === 'Q') {
      const v = nums(4); if (!v) break;
      q = [v[0] + ox, v[1] + oy];
      const x = v[2] + ox, y = v[3] + oy;
      cubicTo(cx + (2 / 3) * (q[0] - cx), cy + (2 / 3) * (q[1] - cy), x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y), x, y);
    } else if (C === 'T') {
      const v = nums(2); if (!v) break;
      q = (prev === 'Q' || prev === 'T') && lastQ ? [2 * cx - lastQ[0], 2 * cy - lastQ[1]] : [cx, cy];
      const x = v[0] + ox, y = v[1] + oy;
      cubicTo(cx + (2 / 3) * (q[0] - cx), cy + (2 / 3) * (q[1] - cy), x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y), x, y);
    } else if (C === 'A') {
      const r = nums(3); if (!r) break;
      const fa = flag(); if (fa === null) break;
      const fs = flag(); if (fs === null) break;
      const p = nums(2); if (!p) break;
      const x = p[0] + ox, y = p[1] + oy;
      ensureSub();
      for (const c of arcToCubics(cx, cy, r[0], r[1], r[2], fa, fs, x, y)) cubicTo(...c);
      cx = x; cy = y;
    }
    prev = C;
    lastC2 = c2;
    lastQ = q;
  }
  const out = model.filter((p) => p.anchors.length > 1);
  return retype(out);
}

// ---------------------------------------------------------------- path writing

export function writePath(model, precision = 3) {
  const f = (v) => fmt(v, precision);
  const parts = [];
  for (const sp of model) {
    const a = sp.anchors;
    if (!a.length) continue;
    parts.push(`M${f(a[0].x)} ${f(a[0].y)}`);
    const seg = (p, q) => {
      if (isZero(p.hOut) && isZero(q.hIn)) return `L${f(q.x)} ${f(q.y)}`;
      return `C${f(p.x + p.hOut.x)} ${f(p.y + p.hOut.y)} ${f(q.x + q.hIn.x)} ${f(q.y + q.hIn.y)} ${f(q.x)} ${f(q.y)}`;
    };
    for (let i = 0; i + 1 < a.length; i++) parts.push(seg(a[i], a[i + 1]));
    if (sp.closed) {
      const l = a[a.length - 1], first = a[0];
      if (a.length > 1 && !(isZero(l.hOut) && isZero(first.hIn))) parts.push(seg(l, first));
      parts.push('Z');
    }
  }
  return parts.join('');
}

// ---------------------------------------------------------------- transforms

export function transformModel(model, m) {
  const lin = (h) => ({ x: m[0] * h.x + m[2] * h.y, y: m[1] * h.x + m[3] * h.y });
  return retype(model.map((sp) => ({
    closed: sp.closed,
    anchors: sp.anchors.map((a) => {
      const [x, y] = apply(m, [a.x, a.y]);
      return { x, y, hIn: lin(a.hIn), hOut: lin(a.hOut), type: a.type };
    }),
  })));
}

/** Reverse direction. A closed subpath keeps anchor 0 first. */
export function reverseSubpath(sp) {
  const src = sp.anchors.map(cloneAnchor);
  let order = src.slice().reverse();
  if (sp.closed && order.length > 1) order = [order[order.length - 1], ...order.slice(0, -1)];
  return { closed: sp.closed, anchors: order.map((a) => ({ ...a, hIn: a.hOut, hOut: a.hIn })) };
}
export function reverseModel(model) { return model.map(reverseSubpath); }

// ---------------------------------------------------------------- elements and shapes

const numAttr = (v, dflt = 0) => {
  if (v === undefined || v === null) return dflt;
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : dflt;
};

function mergeCoincident(sp, eps = 1e-9) {
  const out = [];
  for (const a of sp.anchors) {
    const l = out[out.length - 1];
    if (l && Math.abs(l.x - a.x) < eps && Math.abs(l.y - a.y) < eps) l.hOut = a.hOut;
    else out.push(a);
  }
  if (sp.closed && out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if (Math.abs(f.x - l.x) < eps && Math.abs(f.y - l.y) < eps) { f.hIn = l.hIn; out.pop(); }
  }
  sp.anchors = out;
  return sp;
}

export function ellipseModel(cx, cy, rx, ry) {
  if (!(rx > 0) || !(ry > 0)) return [];
  const kx = KAPPA * rx, ky = KAPPA * ry;
  return [{
    closed: true,
    anchors: [
      makeAnchor(cx + rx, cy, { x: 0, y: -ky }, { x: 0, y: ky }),
      makeAnchor(cx, cy + ry, { x: kx, y: 0 }, { x: -kx, y: 0 }),
      makeAnchor(cx - rx, cy, { x: 0, y: ky }, { x: 0, y: -ky }),
      makeAnchor(cx, cy - ry, { x: -kx, y: 0 }, { x: kx, y: 0 }),
    ],
  }];
}

export function rectModel(x, y, w, h, rx = 0, ry = 0) {
  if (!(w > 0) || !(h > 0)) return [];
  rx = Math.min(Math.max(rx, 0), w / 2);
  ry = Math.min(Math.max(ry, 0), h / 2);
  if (!rx || !ry) {
    return [{ closed: true, anchors: [makeAnchor(x, y), makeAnchor(x + w, y), makeAnchor(x + w, y + h), makeAnchor(x, y + h)] }];
  }
  const kx = KAPPA * rx, ky = KAPPA * ry;
  const A = makeAnchor;
  const sp = {
    closed: true,
    anchors: [
      A(x + rx, y, { x: -kx, y: 0 }, zero()),
      A(x + w - rx, y, zero(), { x: kx, y: 0 }),
      A(x + w, y + ry, { x: 0, y: -ky }, zero()),
      A(x + w, y + h - ry, zero(), { x: 0, y: ky }),
      A(x + w - rx, y + h, { x: kx, y: 0 }, zero()),
      A(x + rx, y + h, zero(), { x: -kx, y: 0 }),
      A(x, y + h - ry, { x: 0, y: ky }, zero()),
      A(x, y + ry, zero(), { x: 0, y: -ky }),
    ],
  };
  return retype([mergeCoincident(sp)]);
}

function pointList(str) {
  const v = (String(str ?? '').match(NUM_RE_G) || []).map(Number);
  const pts = [];
  for (let i = 0; i + 1 < v.length; i += 2) pts.push(makeAnchor(v[i], v[i + 1]));
  return pts;
}

export function elementToModel(tag, attrs = {}) {
  const t = String(tag || '').toLowerCase();
  const g = (k, d) => numAttr(attrs[k], d);
  switch (t) {
    case 'path': return parsePath(attrs.d || '');
    case 'rect': {
      const parseR = (v) => {
        if (v === undefined || v === null || v === 'auto') return undefined;
        const x = parseFloat(v);
        return Number.isFinite(x) && x >= 0 ? x : undefined;
      };
      let rx = parseR(attrs.rx), ry = parseR(attrs.ry);
      if (rx === undefined && ry === undefined) rx = ry = 0;
      else if (rx === undefined) rx = ry;
      else if (ry === undefined) ry = rx;
      return rectModel(g('x', 0), g('y', 0), g('width', 0), g('height', 0), rx, ry);
    }
    case 'circle': return ellipseModel(g('cx', 0), g('cy', 0), g('r', 0), g('r', 0));
    case 'ellipse': {
      let rx = parseFloat(attrs.rx), ry = parseFloat(attrs.ry);
      if (!Number.isFinite(rx) && Number.isFinite(ry)) rx = ry;
      if (!Number.isFinite(ry) && Number.isFinite(rx)) ry = rx;
      return ellipseModel(g('cx', 0), g('cy', 0), rx, ry);
    }
    case 'line':
      return [{ closed: false, anchors: [makeAnchor(g('x1', 0), g('y1', 0)), makeAnchor(g('x2', 0), g('y2', 0))] }];
    case 'polyline':
    case 'polygon': {
      const pts = pointList(attrs.points);
      if (pts.length < 2) return [];
      return [{ closed: t === 'polygon', anchors: pts }];
    }
    default: return [];
  }
}

export function polygonModel(cx, cy, r, sides, rotationDeg = 0) {
  const n = Math.max(3, Math.floor(sides));
  const anchors = [];
  for (let i = 0; i < n; i++) {
    const a = (-90 + rotationDeg + (360 * i) / n) * DEG;
    anchors.push(makeAnchor(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return [{ closed: true, anchors }];
}

export function starModel(cx, cy, rOuter, rInner, points, rotationDeg = 0) {
  const n = Math.max(2, Math.floor(points));
  const anchors = [];
  for (let i = 0; i < 2 * n; i++) {
    const r = i % 2 ? rInner : rOuter;
    const a = (-90 + rotationDeg + (180 * i) / n) * DEG;
    anchors.push(makeAnchor(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return [{ closed: true, anchors }];
}

// ---------------------------------------------------------------- segments and measurement

function segOf(spIdx, sp, i) {
  const a = sp.anchors[i], b = sp.anchors[(i + 1) % sp.anchors.length];
  return {
    sp: spIdx, i,
    p0: [a.x, a.y],
    c1: [a.x + a.hOut.x, a.y + a.hOut.y],
    c2: [b.x + b.hIn.x, b.y + b.hIn.y],
    p3: [b.x, b.y],
  };
}

export function subpathSegments(sp, spIdx = 0) {
  const n = sp.anchors.length, out = [];
  if (n < 2) return out;
  const count = sp.closed ? n : n - 1;
  for (let i = 0; i < count; i++) out.push(segOf(spIdx, sp, i));
  return out;
}

export function segments(model) {
  const out = [];
  model.forEach((sp, k) => out.push(...subpathSegments(sp, k)));
  return out;
}

export function cubicPoint(s, t) {
  const mt = 1 - t, a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return [
    a * s.p0[0] + b * s.c1[0] + c * s.c2[0] + d * s.p3[0],
    a * s.p0[1] + b * s.c1[1] + c * s.c2[1] + d * s.p3[1],
  ];
}

export function cubicDerivative(s, t) {
  const mt = 1 - t;
  const a = 3 * mt * mt, b = 6 * mt * t, c = 3 * t * t;
  return [
    a * (s.c1[0] - s.p0[0]) + b * (s.c2[0] - s.c1[0]) + c * (s.p3[0] - s.c2[0]),
    a * (s.c1[1] - s.p0[1]) + b * (s.c2[1] - s.c1[1]) + c * (s.p3[1] - s.c2[1]),
  ];
}

function cubicSecond(s, t) {
  const mt = 1 - t;
  return [
    6 * mt * (s.c2[0] - 2 * s.c1[0] + s.p0[0]) + 6 * t * (s.p3[0] - 2 * s.c2[0] + s.c1[0]),
    6 * mt * (s.c2[1] - 2 * s.c1[1] + s.p0[1]) + 6 * t * (s.p3[1] - 2 * s.c2[1] + s.c1[1]),
  ];
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = (v) => Math.hypot(v[0], v[1]);
const norm = (v) => { const l = len(v); return l ? [v[0] / l, v[1] / l] : [0, 0]; };

/** Unit tangent at the start of a segment, robust to zero-length handles. */
export function startTangent(s) {
  for (const q of [s.c1, s.c2, s.p3]) { const v = sub(q, s.p0); if (len(v) > 1e-12) return norm(v); }
  return [0, 0];
}
/** Unit tangent (direction of travel) at the end of a segment. */
export function endTangent(s) {
  for (const q of [s.c2, s.c1, s.p0]) { const v = sub(s.p3, q); if (len(v) > 1e-12) return norm(v); }
  return [0, 0];
}

function quadRoots(a, b, c) {
  if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b];
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  return [(-b + sq) / (2 * a), (-b - sq) / (2 * a)];
}

export function segmentBounds(s) {
  let minX = Math.min(s.p0[0], s.p3[0]), maxX = Math.max(s.p0[0], s.p3[0]);
  let minY = Math.min(s.p0[1], s.p3[1]), maxY = Math.max(s.p0[1], s.p3[1]);
  for (let k = 0; k < 2; k++) {
    const p0 = s.p0[k], p1 = s.c1[k], p2 = s.c2[k], p3 = s.p3[k];
    const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0;
    for (const t of quadRoots(a, b, c)) {
      if (t > 0 && t < 1) {
        const v = cubicPoint(s, t)[k];
        if (k === 0) { minX = Math.min(minX, v); maxX = Math.max(maxX, v); }
        else { minY = Math.min(minY, v); maxY = Math.max(maxY, v); }
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

export function bounds(model) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sp of model) {
    for (const a of sp.anchors) {
      minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x);
      minY = Math.min(minY, a.y); maxY = Math.max(maxY, a.y);
    }
  }
  for (const s of segments(model)) {
    const b = segmentBounds(s);
    minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX);
    minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function segArea(s) {
  const [x0, y0] = s.p0, [x1, y1] = s.c1, [x2, y2] = s.c2, [x3, y3] = s.p3;
  return (3 * ((y3 - y0) * (x1 + x2) - (x3 - x0) * (y1 + y2)
    + y1 * (x0 - x2) - x1 * (y0 - y2)
    + y3 * (x2 + x0 / 3) - x3 * (y2 + y0 / 3))) / 20;
}

/**
 * Signed area by Green's theorem, exact for cubics. Positive when the
 * subpath runs clockwise on screen (y down). Open subpaths are closed with a
 * straight line, as fill does.
 */
export function area(model) {
  let total = 0;
  for (const sp of model) {
    const n = sp.anchors.length;
    if (n < 2) continue;
    const segs = subpathSegments({ closed: true, anchors: sp.anchors }, 0);
    if (!sp.closed) {
      // replace the closing curve with a straight line
      const l = sp.anchors[n - 1], f = sp.anchors[0];
      segs[segs.length - 1] = { p0: [l.x, l.y], c1: [l.x, l.y], c2: [f.x, f.y], p3: [f.x, f.y] };
    }
    for (const s of segs) total += segArea(s);
  }
  return total;
}

function flattenSeg(s, tol, out, depth = 0) {
  const [x0, y0] = s.p0, [x3, y3] = s.p3;
  const dx = x3 - x0, dy = y3 - y0, L = Math.hypot(dx, dy);
  const dist = (p) => (L > 1e-12 ? Math.abs((p[0] - x0) * dy - (p[1] - y0) * dx) / L : Math.hypot(p[0] - x0, p[1] - y0));
  if (depth >= 18 || Math.max(dist(s.c1), dist(s.c2)) <= tol) { out.push([x3, y3]); return; }
  const [l, r] = splitCubic(s, 0.5);
  flattenSeg(l, tol, out, depth + 1);
  flattenSeg(r, tol, out, depth + 1);
}

/** Polyline per subpath. Closed subpaths do not repeat their first point. */
export function flatten(model, tolerance = 0.25) {
  const tol = Math.max(tolerance, 1e-6);
  return model.map((sp) => {
    if (!sp.anchors.length) return [];
    const out = [[sp.anchors[0].x, sp.anchors[0].y]];
    for (const s of subpathSegments(sp)) flattenSeg(s, tol, out);
    if (sp.closed && out.length > 1) {
      const f = out[0], l = out[out.length - 1];
      if (Math.abs(f[0] - l[0]) < 1e-12 && Math.abs(f[1] - l[1]) < 1e-12) out.pop();
    }
    return out;
  });
}

// ---------------------------------------------------------------- editing

export function splitCubic(s, t) {
  const lerp = (a, b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const a = lerp(s.p0, s.c1), b = lerp(s.c1, s.c2), c = lerp(s.c2, s.p3);
  const ab = lerp(a, b), bc = lerp(b, c), m = lerp(ab, bc);
  return [{ p0: s.p0, c1: a, c2: ab, p3: m }, { p0: m, c1: bc, c2: c, p3: s.p3 }];
}
