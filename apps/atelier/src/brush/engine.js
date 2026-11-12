// Brush engine v2 (P26): dab placement with dynamics, scatter, angle, roundness and a greyscale tip
// image, then rasterised into a stroke coverage map. Pure code: no DOM, no GPU, runs in node tests.
//
// A stroke is a list of input points [x, y, pressure?, tiltX?, tiltY?, t?] (pressure 0..1, tilt in
// degrees −90..90 as PointerEvent gives them, t in ms). planDabs turns it into dabs; dabCoverage
// accumulates the dabs into S (0..1 per pixel). The caller multiplies the tool's base opacity on top,
// exactly as with the v1 round brush (src/select/paint.js strokeCoverage).
//
// Every random choice comes from one seeded generator drawn in a fixed order, so the same points,
// brush and seed give the same dabs (a recorded stroke replays identically).

export const CONTROLS = ['off', 'pressure', 'tilt', 'velocity'];
export const ANGLE_CONTROLS = ['off', 'direction', 'tilt'];

// Normalised brush: every field present, in range. Unknown fields are dropped.
export function normalizeBrush(b = {}) {
  const n = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const j = b.jitter || {}; const c = b.control || {}; const m = b.min || {};
  return {
    spacing: n(b.spacing, 1, 1000, 25),          // % of the dab size between dabs
    angle: n(b.angle, -360, 360, 0),             // degrees, tip rotation
    roundness: n(b.roundness, 1, 100, 100),      // % (100 = circle); squashes the tip's y axis
    scatter: n(b.scatter, 0, 1000, 0),           // % of the size, offset across the stroke
    scatterBoth: !!b.scatterBoth,                // scatter along the stroke too
    count: Math.round(n(b.count, 1, 16, 1)),     // dabs per spacing step
    jitter: { size: n(j.size, 0, 100, 0), opacity: n(j.opacity, 0, 100, 0), flow: n(j.flow, 0, 100, 0), angle: n(j.angle, 0, 100, 0), roundness: n(j.roundness, 0, 100, 0) },
    control: { size: CONTROLS.includes(c.size) ? c.size : 'off', opacity: CONTROLS.includes(c.opacity) ? c.opacity : 'off', flow: CONTROLS.includes(c.flow) ? c.flow : 'off', angle: ANGLE_CONTROLS.includes(c.angle) ? c.angle : 'off' },
    min: { size: n(m.size, 0, 100, 0), opacity: n(m.opacity, 0, 100, 0), flow: n(m.flow, 0, 100, 0) },
    seed: (Number.isFinite(b.seed) ? b.seed : 1) >>> 0,
  };
}

// mulberry32: 32-bit seeded generator, uniform in [0, 1).
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// FNV-1a hash of the stroke's points: the default seed, so two different strokes jitter differently
// while one stroke always jitters the same way.
export function seedFromPoints(points) {
  let h = 0x811c9dc5;
  for (const p of points) for (const v of p) { h ^= Math.round(v * 100) | 0; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// Velocity reference: 3 px/ms with timestamps; without them, the input samples' spacing over 50 px.
const V_REF_MS = 3; const V_REF_PX = 50;

// Control value in 0..1 for a dab: pressure p (1 when the device sends none); tilt = |tilt|/90 (more
// lean → larger); velocity = 1 − min(1, v/vRef) (faster → smaller, as ink thins).
function controlValue(kind, s) {
  if (kind === 'pressure') return s.p;
  if (kind === 'tilt') return Math.min(1, Math.hypot(s.tx, s.ty) / 90);
  if (kind === 'velocity') return 1 - Math.min(1, s.v);
  return 1;
}

// points → dabs [{ x, y, size, angle (deg), roundness (0..1), flow (0..1), cap (0..1) }].
// size is the base size in the points' pixel units; flow in percent.
// Per dab: factor_k = (min_k + (1 − min_k)·control_k) · (1 − jitter_k·u) for size, opacity (cap) and flow;
// angle = brush.angle + control angle + jitter·360·(u − ½); roundness = brush.roundness·(1 − jitter·u).
export function planDabs(points, size, flow, brush) {
  const b = brush; const R = rng(b.seed);
  const pt = (q) => ({ x: q[0], y: q[1], p: q[2] ?? 1, tx: q[3] ?? 0, ty: q[4] ?? 0, t: q[5] });
  const P = points.map(pt);
  const dabs = [];
  const emit = (s, dirDeg) => {
    for (let c = 0; c < b.count; c++) {
      const u = () => R();
      const f = (k) => { const mn = b.min[k] / 100; return (mn + (1 - mn) * controlValue(b.control[k], s)) * (1 - (b.jitter[k] / 100) * u()); };
      const ks = f('size'); const ko = f('opacity'); const kf = f('flow');
      let ang = b.angle + (b.control.angle === 'direction' ? dirDeg : b.control.angle === 'tilt' ? (Math.atan2(s.ty, s.tx) * 180) / Math.PI : 0);
      ang += (b.jitter.angle / 100) * 360 * (u() - 0.5);
      const rnd = Math.max(0.01, (b.roundness / 100) * (1 - (b.jitter.roundness / 100) * u()));
      const dsz = Math.max(0.5, size * ks);
      // Scatter: across the stroke (perpendicular to its direction), and along it when scatterBoth.
      const sc = (b.scatter / 100) * dsz;
      const a = (dirDeg * Math.PI) / 180;
      const off = sc * (2 * u() - 1); const along = b.scatterBoth ? sc * (2 * u() - 1) : 0;
      dabs.push({ x: s.x - Math.sin(a) * off + Math.cos(a) * along, y: s.y + Math.cos(a) * off + Math.sin(a) * along,
        size: dsz, angle: ang, roundness: rnd, flow: (flow / 100) * kf, cap: ko });
    }
  };
  if (!P.length) return dabs;
  // First dab at the first point; then one dab each time the path length since the last dab reaches
  // spacing% of the current dab size (the remainder carries across input segments).
  let dir = P.length > 1 ? Math.atan2(P[1].y - P[0].y, P[1].x - P[0].x) * 180 / Math.PI : 0;
  emit({ ...P[0], v: 0 }, dir);
  let since = 0;
  for (let i = 1; i < P.length; i++) {
    const A = P[i - 1]; const B = P[i];
    const d = Math.hypot(B.x - A.x, B.y - A.y);
    if (d === 0) continue;
    dir = Math.atan2(B.y - A.y, B.x - A.x) * 180 / Math.PI;
    const v = Number.isFinite(A.t) && Number.isFinite(B.t) && B.t > A.t ? d / (B.t - A.t) / V_REF_MS : d / V_REF_PX;
    let pos = 0;
    for (;;) {
      const s0 = { p: A.p, tx: A.tx, ty: A.ty, v };
      const step = Math.max(1, (b.spacing / 100) * size * Math.max(0.05, b.control.size === 'off' ? 1 : (b.min.size / 100 + (1 - b.min.size / 100) * controlValue(b.control.size, s0))));
      const need = step - since;
      if (pos + need > d) { since += d - pos; break; }
      pos += need; since = 0;
      const k = pos / d;
      emit({ x: A.x + (B.x - A.x) * k, y: A.y + (B.y - A.y) * k, p: A.p + (B.p - A.p) * k, tx: A.tx + (B.tx - A.tx) * k, ty: A.ty + (B.ty - A.ty) * k, v }, dir);
    }
  }
  return dabs;
}

// Bilinear sample of a greyscale tip (Uint8Array, 255 = full paint) at continuous (x, y) in tip pixels.
function tipAt(tip, x, y) {
  const { width: w, height: h, data } = tip;
  x -= 0.5; y -= 0.5;
  const x0 = Math.floor(x); const y0 = Math.floor(y); const fx = x - x0; const fy = y - y0;
  const g = (i, j) => (i < 0 || j < 0 || i >= w || j >= h ? 0 : data[j * w + i]);
  return ((g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy) / 255;
}

// Dabs → coverage S (Float32Array, 0..1). Each dab's footprint is the tip (or the round profile with
// hardness h: 1 inside h·r, falling linearly to 0 at r) in dab-local axes: rotate by −angle, divide the
// y axis by roundness. Accumulation: S ← S + (cap − S)·a where a = footprint·flow, only while S < cap,
// so flow builds up within the stroke and the dab's opacity caps it. With cap = 1, angle 0 and roundness 1
// this is the v1 round brush's S += (1 − S)·a.
export function dabCoverage(width, height, dabs, { hardness = 100, tip = null } = {}) {
  const S = new Float32Array(width * height);
  const hard = Math.min(0.999, hardness / 100);
  for (const d of dabs) {
    const r = d.size / 2; const ca = Math.cos((d.angle * Math.PI) / 180); const sa = Math.sin((d.angle * Math.PI) / 180);
    // A tip keeps its aspect: the longer side spans the dab size.
    const tw = tip ? tip.width / Math.max(tip.width, tip.height) : 1; const th = tip ? tip.height / Math.max(tip.width, tip.height) : 1;
    const bx0 = Math.max(0, Math.floor(d.x - r)); const bx1 = Math.min(width - 1, Math.ceil(d.x + r));
    const by0 = Math.max(0, Math.floor(d.y - r)); const by1 = Math.min(height - 1, Math.ceil(d.y + r));
    for (let yy = by0; yy <= by1; yy++) {
      for (let xx = bx0; xx <= bx1; xx++) {
        const dx = xx + 0.5 - d.x; const dy = yy + 0.5 - d.y;
        const u = (dx * ca + dy * sa) / r; const v = (-dx * sa + dy * ca) / (r * d.roundness);
        let f;
        if (tip) {
          if (Math.abs(u) >= tw || Math.abs(v) >= th) continue;
          f = tipAt(tip, ((u / tw + 1) / 2) * tip.width, ((v / th + 1) / 2) * tip.height);
        } else {
          const dist = Math.hypot(u, v);
          if (dist >= 1) continue;
          f = dist <= hard ? 1 : 1 - (dist - hard) / (1 - hard);
        }
        const a = f * d.flow;
        if (a <= 0) continue;
        const k = yy * width + xx;
        if (S[k] < d.cap) S[k] += (d.cap - S[k]) * a;
      }
    }
  }
  return S;
}

// A tip from pixels (custom brush from a selection): value = (255 − luma)·alpha·coverage, cropped to
// bounds and box-downsampled so the longer side is at most maxEdge. Dark, opaque, selected pixels paint.
// px: 8-bit straight sRGB RGBA, w × h; sel: Uint8Array coverage (0..255) or null; bounds [x0, y0, x1, y1).
export function tipFromPixels(px, w, h, sel, bounds, maxEdge = 256) {
  const [x0, y0, x1, y1] = bounds.map(Math.round);
  const bw = Math.max(1, x1 - x0); const bh = Math.max(1, y1 - y0);
  const k = Math.min(1, maxEdge / Math.max(bw, bh));
  const tw = Math.max(1, Math.round(bw * k)); const th = Math.max(1, Math.round(bh * k));
  const acc = new Float64Array(tw * th); const cnt = new Float64Array(tw * th);
  for (let y = y0; y < y1; y++) {
    if (y < 0 || y >= h) continue;
    for (let x = x0; x < x1; x++) {
      if (x < 0 || x >= w) continue;
      const p = y * w + x; const q = p * 4;
      const luma = 0.2126 * px[q] + 0.7152 * px[q + 1] + 0.0722 * px[q + 2];
      const v = (255 - luma) * (px[q + 3] / 255) * (sel ? sel[p] / 255 : 1);
      const i = Math.min(tw - 1, Math.floor((x - x0) * k)); const j = Math.min(th - 1, Math.floor((y - y0) * k));
      acc[j * tw + i] += v; cnt[j * tw + i]++;
    }
  }
  const data = new Uint8Array(tw * th);
  for (let i = 0; i < data.length; i++) data[i] = cnt[i] ? Math.round(acc[i] / cnt[i]) : 0;
  return { width: tw, height: th, data, sourceSize: Math.max(bw, bh) };
}

// Tip ↔ JSON (base64 of the raw greyscale bytes).
export const tipToJson = (t) => ({ width: t.width, height: t.height, data: b64(t.data) });
export function tipFromJson(j) {
  if (!j || !Number.isInteger(j.width) || !Number.isInteger(j.height) || typeof j.data !== 'string') return null;
  const data = unb64(j.data);
  return data.length === j.width * j.height ? { width: j.width, height: j.height, data } : null;
}
function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s) { const t = atob(s); const u = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i); return u; }

// Full v2 stroke: plan, then rasterise. Returns { coverage, stamps } like strokeCoverage.
export function brushStrokeCoverage(width, height, points, size, hardness, flow, brush) {
  const dabs = planDabs(points, size, flow, brush);
  return { coverage: dabCoverage(width, height, dabs, { hardness, tip: brush.tipData || null }), stamps: dabs.length, dabs };
}
