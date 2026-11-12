// Culling assist, classical part (L63): sharpness, exposure clipping and near-duplicate groups measured
// on a rendered preview (8-bit sRGB RGBA, the photo as developed), then turned into suggestions the person
// accepts. Pure, so node tests run it on synthetic images. Closed-eye detection needs a face and eye
// model and belongs to the AI masks work, not here. Formulas are Atelier's own:
//   luma        Y = 0.2126 R + 0.7152 G + 0.0722 B (8-bit sRGB values, not linearised)
//   sharpness   variance of the 4-neighbour Laplacian of Y, L = Y(x−1,y) + Y(x+1,y) + Y(x,y−1) + Y(x,y+1) − 4 Y(x,y),
//               over interior pixels (Pech-Pacheco et al., "Diatom autofocusing in brightfield microscopy", 2000)
//   clipping    highlights: share of pixels with any channel ≥ 254; shadows: share with Y ≤ 2
//   dHash       Y area-averaged to 9 × 8; bit (r, c) = Y(r, c) < Y(r, c + 1); 64 bits as 16 hex digits
//               (the difference hash described by N. Krawetz, "Kind of Like That", 2013)
//   duplicates  photos whose dHash Hamming distance is ≤ maxDistance join one group (transitively)

export const DEFAULTS = { blurBelow: 30, clipAbove: 0.01, maxDistance: 10 };

export function luma(px, w, h) {
  const Y = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) Y[i] = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
  return Y;
}

export function sharpness(Y, w, h) {
  let n = 0; let s = 0; let s2 = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; const L = Y[i - 1] + Y[i + 1] + Y[i - w] + Y[i + w] - 4 * Y[i];
    s += L; s2 += L * L; n++;
  }
  if (!n) return 0;
  const m = s / n; return s2 / n - m * m;
}

export function clipping(px, Y, w, h) {
  let hi = 0; let lo = 0;
  for (let i = 0; i < w * h; i++) {
    if (px[i * 4] >= 254 || px[i * 4 + 1] >= 254 || px[i * 4 + 2] >= 254) hi++;
    if (Y[i] <= 2) lo++;
  }
  return { highlights: hi / (w * h), shadows: lo / (w * h) };
}

export function dhash(Y, w, h) {
  const cell = (r, c) => {   // area average of the cell (c of 9, r of 8)
    const x0 = Math.floor((c * w) / 9); const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * w) / 9));
    const y0 = Math.floor((r * h) / 8); const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * h) / 8));
    let s = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += Y[y * w + x];
    return s / ((x1 - x0) * (y1 - y0));
  };
  let hex = '';
  for (let r = 0; r < 8; r++) {
    let byte = 0;
    for (let c = 0; c < 8; c++) byte = (byte << 1) | (cell(r, c) < cell(r, c + 1) ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
export function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i += 2) { let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16); while (x) { d += x & 1; x >>= 1; } }
  return d;
}

// One image's measurements.
export function measure(px, w, h) {
  const Y = luma(px, w, h);
  return { sharpness: Math.round(sharpness(Y, w, h) * 10) / 10, clipping: clipping(px, Y, w, h), dhash: dhash(Y, w, h), size: [w, h] };
}

// items: [{ key, m }] (m from measure). Returns Map(key → suggestion):
// { sharpness, clipping, dhash, group (shared id or null), flag ('reject' | null), reasons: [string] }.
// A photo is suggested for reject when it is blurry (sharpness < blurBelow), or when it is in a duplicate
// group and is not the group's sharpest. Clipping only adds a reason; exposure is the person's call.
export function suggest(items, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (hamming(items[i].m.dhash, items[j].m.dhash) <= o.maxDistance) parent[find(i)] = find(j);
  const groups = new Map();
  items.forEach((it, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  const out = new Map();
  for (const members of groups.values()) {
    const dup = members.length > 1;
    const best = members.reduce((a, b) => (items[b].m.sharpness > items[a].m.sharpness ? b : a), members[0]);
    const gid = dup ? `g-${items[best].m.dhash}` : null;
    for (const i of members) {
      const { key, m } = items[i]; const reasons = [];
      if (m.sharpness < o.blurBelow) reasons.push(`blurry: sharpness ${m.sharpness} is below ${o.blurBelow}`);
      if (dup && i !== best) reasons.push(`near-duplicate of ${items[best].key}, which is sharper (${items[best].m.sharpness} vs ${m.sharpness})`);
      const notes = [];
      if (m.clipping.highlights > o.clipAbove) notes.push(`highlights clipped on ${(m.clipping.highlights * 100).toFixed(1)}% of the photo`);
      if (m.clipping.shadows > o.clipAbove) notes.push(`shadows crushed on ${(m.clipping.shadows * 100).toFixed(1)}% of the photo`);
      out.set(key, { sharpness: m.sharpness, clipping: { highlights: round4(m.clipping.highlights), shadows: round4(m.clipping.shadows) }, dhash: m.dhash, group: gid, flag: reasons.length ? 'reject' : null, reasons, notes });
    }
  }
  return out;
}
const round4 = (v) => Math.round(v * 10000) / 10000;
