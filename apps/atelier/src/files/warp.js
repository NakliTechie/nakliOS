// Warps (P24) as one inverse displacement field per layer, rendered by the engine (tessella createDisplacementMap,
// layer displace: { map }): an output position q in layer-source pixels reads the source at q + D(q).
//   Puppet and mesh warp: pins { from, to } in source px. Each grid point v maps back through a moving-least-squares
//   similarity (Schaefer et al. 2006) fitted from the pins' `to` to their `from`: weights w_i = 1 / (|to_i - v|² + 1),
//   in complex numbers a = Σ w conj(to_i - t*) (from_i - f*) / Σ w |to_i - t*|² (a = 1 with one pin), f(v) = a (v - t*) + f*,
//   t*, f* the weighted centroids; D(v) = f(v) - v.
//   Liquify strokes, applied in order after the pins: stamps every size / 4 px along the points, falloff
//   w = (1 - (d / r)²)², r = size / 2, k = strength (0..1): push D -= k w Δ (Δ the step between stamps, so content
//   moves with the stroke); bloat D -= 0.5 k w (q - c); pinch D += 0.5 k w (q - c).
// The field has one node per 4 source px (at most 256 a side); the engine reads it bilinearly.

export function fieldSize(W, H) { const s = Math.max(1, Math.ceil(Math.max(W, H) / 4) / 256); return [Math.max(2, Math.round(W / 4 / Math.max(1, s))), Math.max(2, Math.round(H / 4 / Math.max(1, s)))]; }

export function warpField(W, H, { pins = [], strokes = [] } = {}) {
  const [mw, mh] = fieldSize(W, H);
  const data = new Float32Array(mw * mh * 2);
  const pos = (i, j) => [(i + 0.5) * W / mw, (j + 0.5) * H / mh];
  if (pins.length) {
    for (let j = 0; j < mh; j++) for (let i = 0; i < mw; i++) {
      const [vx, vy] = pos(i, j);
      let sw = 0; let tx = 0; let ty = 0; let fx = 0; let fy = 0; const w = [];
      for (const p of pins) { const k = 1 / ((p.to[0] - vx) ** 2 + (p.to[1] - vy) ** 2 + 1); w.push(k); sw += k; tx += k * p.to[0]; ty += k * p.to[1]; fx += k * p.from[0]; fy += k * p.from[1]; }
      tx /= sw; ty /= sw; fx /= sw; fy /= sw;
      let ar = 0; let ai = 0; let mu = 0;
      pins.forEach((p, n) => {
        const qx = p.to[0] - tx; const qy = p.to[1] - ty; const px = p.from[0] - fx; const py = p.from[1] - fy;
        ar += w[n] * (qx * px + qy * py); ai += w[n] * (qx * py - qy * px); mu += w[n] * (qx * qx + qy * qy);
      });
      if (mu < 1e-9) { ar = 1; ai = 0; } else { ar /= mu; ai /= mu; }
      const dx = vx - tx; const dy = vy - ty;
      data[(j * mw + i) * 2] = ar * dx - ai * dy + fx - vx;
      data[(j * mw + i) * 2 + 1] = ai * dx + ar * dy + fy - vy;
    }
  }
  for (const s of strokes) {
    const r = s.size / 2; const k = s.strength ?? 0.5; const step = Math.max(1, s.size / 4);
    const stamps = [];
    for (let n = 0; n < s.points.length; n++) {
      if (n === 0) { stamps.push([...s.points[0], 0, 0]); continue; }
      const [ax, ay] = s.points[n - 1]; const [bx, by] = s.points[n]; const L = Math.hypot(bx - ax, by - ay);
      for (let t = step; t <= L + 1e-9; t += step) stamps.push([ax + (bx - ax) * t / L, ay + (by - ay) * t / L, (bx - ax) * step / L, (by - ay) * step / L]);
    }
    for (const [cx, cy, sx, sy] of stamps) {
      const i0 = Math.max(0, Math.floor((cx - r) * mw / W)); const i1 = Math.min(mw - 1, Math.ceil((cx + r) * mw / W));
      const j0 = Math.max(0, Math.floor((cy - r) * mh / H)); const j1 = Math.min(mh - 1, Math.ceil((cy + r) * mh / H));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const [qx, qy] = pos(i, j); const d = Math.hypot(qx - cx, qy - cy);
        if (d >= r) continue;
        const w = (1 - (d / r) ** 2) ** 2; const o = (j * mw + i) * 2;
        if (s.mode === 'push') { data[o] -= k * w * sx; data[o + 1] -= k * w * sy; }
        else if (s.mode === 'bloat') { data[o] -= 0.5 * k * w * (qx - cx); data[o + 1] -= 0.5 * k * w * (qy - cy); }
        else if (s.mode === 'pinch') { data[o] += 0.5 * k * w * (qx - cx); data[o + 1] += 0.5 * k * w * (qy - cy); }
      }
    }
  }
  return { width: mw, height: mh, data };
}

// Renderer hook: the engine displacement map for a layer's warp, cached by its content.
const maps = new Map(); // key → engine map id
export function displaceFor(engine, l, s) {
  if (!l.warp || (!l.warp.pins?.length && !l.warp.strokes?.length)) return undefined;
  const key = JSON.stringify([s.width, s.height, l.warp]);
  if (!maps.has(key)) maps.set(key, engine.createDisplacementMap(warpField(s.width, s.height, l.warp)).id);
  return { map: maps.get(key) };
}
