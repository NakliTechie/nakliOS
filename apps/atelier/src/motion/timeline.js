// Animation timeline (P58): pure maths, no DOM. The document carries
//   doc.timeline = { fps, frames, loop, tracks: { [layerId]: { [property]: [[frame, value, ease?], ...] } } }
// Properties: visible (hold), opacity (0..1), x and y (document px, a translation added on top of the
// layer's matrix), scale (factor), rotation (degrees). Scale and rotation turn about the layer's centre.
//
// Frame animation (Photoshop's frame mode) is the same model with hold keys: capture_frame records every
// layer's visibility and opacity as hold keys at one frame, so each frame is a set of layer states.

export const PROPS = ['visible', 'opacity', 'x', 'y', 'scale', 'rotation'];
export const EASES = ['linear', 'hold', 'ease'];
export const NEUTRAL = { x: 0, y: 0, scale: 1, rotation: 0 };

export function newTimeline({ fps = 12, frames = 24, loop = 0 } = {}) { return { fps, frames, loop, tracks: {} }; }

// Easing of the segment that starts at a key: linear t; hold 0 until the next key; ease = cubic in-out:
//   e(t) = 4t³ for t < ½, else 1 − (−2t + 2)³ / 2.
export function ease(kind, t) {
  if (kind === 'hold') return 0;
  if (kind === 'ease') return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
  return t;
}

// Value of one track at a (possibly fractional) frame. Before the first key: the first key's value;
// after the last: the last key's. Between keys k0 = [f0, v0, e0] and k1 = [f1, v1]:
//   v = v0 + (v1 − v0)·ease(e0, (f − f0)/(f1 − f0)); booleans (visible) always hold.
export function valueAt(keys, frame) {
  if (!keys?.length) return undefined;
  if (frame <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (frame >= last[0]) return last[1];
  let i = 0; while (keys[i + 1][0] <= frame) i++;
  const [f0, v0, e0] = keys[i]; const [f1, v1] = keys[i + 1];
  if (typeof v0 !== 'number' || typeof v1 !== 'number') return v0;
  return v0 + (v1 - v0) * ease(e0 || 'linear', (frame - f0) / (f1 - f0));
}

// Inserts or replaces the key at a frame, keeping keys sorted.
export function setKey(keys, frame, value, easeKind) {
  const k = easeKind && easeKind !== 'linear' ? [frame, value, easeKind] : [frame, value];
  const i = keys.findIndex((x) => x[0] >= frame);
  if (i < 0) keys.push(k); else if (keys[i][0] === frame) keys[i] = k; else keys.splice(i, 0, k);
  return keys;
}

// The animated state of one layer at a frame: only the properties that have tracks.
export function layerStateAt(tl, layerId, frame) {
  const tr = tl?.tracks?.[layerId]; if (!tr) return {};
  const out = {};
  for (const p of PROPS) { const v = valueAt(tr[p], frame); if (v !== undefined) out[p] = v; }
  return out;
}

const mul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];

// Layer matrix at a frame: M' = T(c + (x, y)) · R(θ) · S(s) · T(−c) · M, with c the document position
// of the layer's centre (its local centre through M; the document centre for layers without a size).
export function animatedMatrix(M, st, centre) {
  const x = st.x ?? 0; const y = st.y ?? 0; const s = st.scale ?? 1; const r = ((st.rotation ?? 0) * Math.PI) / 180;
  if (!x && !y && s === 1 && !r) return M;
  const [cx, cy] = centre;
  const A = [Math.cos(r) * s, Math.sin(r) * s, -Math.sin(r) * s, Math.cos(r) * s, cx + x, cy + y];
  return mul(A, mul([1, 0, 0, 1, -cx, -cy], M));
}

export function layerCentre(doc, l) {
  const M = l.matrix || [1, 0, 0, 1, 0, 0];
  if (Number.isFinite(l.width) && Number.isFinite(l.height)) return [M[0] * l.width / 2 + M[2] * l.height / 2 + M[4], M[1] * l.width / 2 + M[3] * l.height / 2 + M[5]];
  return [doc.width / 2, doc.height / 2];
}

// The document as it renders at a frame: a shallow copy whose animated layers carry the frame's
// visibility, opacity and matrix. The stored document is never changed.
export function frameDoc(doc, frame) {
  const tl = doc.timeline; if (!tl) return doc;
  return { ...doc, layers: doc.layers.map((l) => {
    const st = layerStateAt(tl, l.id, frame);
    if (!Object.keys(st).length) return l;
    const o = { ...l };
    if ('visible' in st) o.visible = !!st.visible;
    if ('opacity' in st) o.opacity = Math.min(1, Math.max(0, st.opacity));
    if (['x', 'y', 'scale', 'rotation'].some((k) => k in st) && !l.quad) o.matrix = animatedMatrix(l.matrix, st, layerCentre(doc, l));
    return o;
  }) };
}

// Frame → seconds and the per-frame delay in GIF centiseconds / WebP milliseconds.
export const frameTime = (tl, f) => f / tl.fps;
export const delayMs = (tl) => Math.round(1000 / tl.fps);
