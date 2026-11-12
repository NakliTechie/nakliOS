// Pure geometry for the UI: screen ↔ document coordinates, zoom about a point, panning, layer reorder
// indices, crop aspect rectangles, colour-wheel positions and tone-curve point edits. No DOM, no GPU,
// so tests/ui.test.mjs runs it in node.

// view: the engine's computed view { scale, x0, y0 } in canvas pixels (canvas px per document px, and the
// document point at the canvas's top-left). rect: the canvas's CSS box; ratio: canvas px per CSS px.
// document x = x0 + (clientX − rect.left) × ratio / scale
export function screenToDoc(view, rect, ratio, clientX, clientY) {
  return [view.x0 + ((clientX - rect.left) * ratio) / view.scale, view.y0 + ((clientY - rect.top) * ratio) / view.scale];
}
export function docToScreen(view, rect, ratio, x, y) {
  return [rect.left + ((x - view.x0) * view.scale) / ratio, rect.top + ((y - view.y0) * view.scale) / ratio];
}

// Zoom by factor keeping document point (ax, ay) under the same canvas pixel. cw, ch: canvas size in px.
// The anchor's canvas position p = (a − x0) × s stays fixed: x0' = a − p / s'; centre = x0' + cw / (2 s').
export function zoomAt(view, factor, ax, ay, cw, ch, { min = 0.01, max = 64 } = {}) {
  const s = Math.min(max, Math.max(min, view.scale * factor));
  const px = (ax - view.x0) * view.scale; const py = (ay - view.y0) * view.scale;
  const x0 = ax - px / s; const y0 = ay - py / s;
  return { zoom: s, center: [x0 + cw / (2 * s), y0 + ch / (2 * s)] };
}

// Pan by a drag of (dx, dy) canvas pixels: the document moves with the pointer, so the centre moves against it.
export function panBy(view, dx, dy, cw, ch) {
  return { zoom: view.scale, center: [view.x0 + cw / (2 * view.scale) - dx / view.scale, view.y0 + ch / (2 * view.scale) - dy / view.scale] };
}

// Rectangle from two drag points; square forces equal sides (Shift). Returns integers in document pixels.
export function dragRect(a, b, { square = false, round = true } = {}) {
  let w = b[0] - a[0]; let h = b[1] - a[1];
  if (square) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
  const x = Math.min(a[0], a[0] + w); const y = Math.min(a[1], a[1] + h);
  const r = { x, y, w: Math.abs(w), h: Math.abs(h) };
  return round ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) } : r;
}

// Clamp a rectangle to the document; null when nothing is left.
export function clampRect(r, W, H) {
  const x0 = Math.max(0, r.x); const y0 = Math.max(0, r.y);
  const x1 = Math.min(W, r.x + r.w); const y1 = Math.min(H, r.y + r.h);
  return x1 - x0 >= 1 && y1 - y0 >= 1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

// Selection op from modifier keys (Photoshop convention): Shift adds, Alt subtracts, Shift+Alt intersects.
export function selectionOp({ shiftKey, altKey }, fallback = 'replace') {
  if (shiftKey && altKey) return 'intersect';
  if (shiftKey) return 'add';
  if (altKey) return 'subtract';
  return fallback;
}

// Layer reorder for move_layer. layers: the document's flat array (bottom first). Dropping the dragged
// layer 'above' or 'below' the target row (as the panel shows it, top of stack first). The handler removes
// the layer, then inserts at index, so index counts positions in the array without the dragged layer.
// Returns { index, parentId } or { error }.
export function moveIndex(layers, dragId, targetId, where) {
  if (dragId === targetId) return { error: 'same layer' };
  const drag = layers.find((l) => l.id === dragId); const target = layers.find((l) => l.id === targetId);
  if (!drag || !target) return { error: 'unknown layer' };
  for (let p = target; p; p = layers.find((l) => l.id === p.parentId)) if (p.id === drag.id) return { error: 'a group cannot move inside itself' };
  const rest = layers.filter((l) => l.id !== dragId);
  const t = rest.findIndex((l) => l.id === targetId);
  const index = where === 'above' ? t + 1 : t;
  const parentId = target.parentId ?? null;
  return { index, parentId };
}

// The largest centred rectangle with aspect w:h inside a W × H photo, normalised to 0..1.
export function aspectRect(W, H, aspect) {
  if (!aspect) return { x: 0, y: 0, w: 1, h: 1 };
  const [aw, ah] = aspect;
  let w = W; let h = (W * ah) / aw;
  if (h > H) { h = H; w = (H * aw) / ah; }
  const nw = w / W; const nh = h / H;
  return { x: (1 - nw) / 2, y: (1 - nh) / 2, w: nw, h: nh };
}

// A drag inside the cropped develop view, mapped back to the photo: the view shows rect `old` of the photo
// (normalised), so a document point d maps to old.x + d.x / W × old.w. Straighten angle is ignored here.
export function cropFromView(old, W, H, r) {
  const o = { x: 0, y: 0, w: 1, h: 1, ...(old || {}) };
  const x = o.x + (r.x / W) * o.w; const y = o.y + (r.y / H) * o.h;
  const w = (r.w / W) * o.w; const h = (r.h / H) * o.h;
  const c = (v) => Math.min(1, Math.max(0, v));
  const cx = c(x); const cy = c(y);
  return { x: cx, y: cy, w: Math.min(1 - cx, c(w)), h: Math.min(1 - cy, c(h)) };
}

// Colour-grading wheel: angle is hue (0° at the right, counter-clockwise, as on a colour wheel), distance
// from the centre is saturation 0..100. (x, y) are offsets from the centre in px; r the wheel radius.
export function wheelToHS(x, y, r) {
  const d = Math.min(1, Math.hypot(x, y) / r);
  let hue = (Math.atan2(-y, x) * 180) / Math.PI; if (hue < 0) hue += 360;
  return { hue: (Math.round(hue) % 360) + 0, saturation: Math.round(d * 100) };
}
export function hsToWheel(hue = 0, saturation = 0, r) {
  const t = (hue * Math.PI) / 180; const d = (saturation / 100) * r;
  return [Math.cos(t) * d, -Math.sin(t) * d];
}

// Tone-curve points in 0..255, sorted by x, endpoints pinned at x 0 and 255.
export const IDENTITY_CURVE = Object.freeze([[0, 0], [255, 255]]);
const clamp255 = (v) => Math.min(255, Math.max(0, Math.round(v)));
export function addCurvePoint(points, x, y) {
  const pts = (points?.length ? points : IDENTITY_CURVE).map((p) => [...p]);
  const nx = clamp255(x);
  if (pts.some((p) => p[0] === nx)) return { points: pts, index: pts.findIndex((p) => p[0] === nx) };
  pts.push([nx, clamp255(y)]); pts.sort((a, b) => a[0] - b[0]);
  return { points: pts, index: pts.findIndex((p) => p[0] === nx) };
}
// Moves point i; x stays strictly between its neighbours (distinct x values), endpoints keep their x.
export function moveCurvePoint(points, i, x, y) {
  const pts = points.map((p) => [...p]);
  const last = pts.length - 1;
  let nx = clamp255(x);
  if (i === 0) nx = pts[0][0];
  else if (i === last) nx = pts[last][0];
  else nx = Math.min(pts[i + 1][0] - 1, Math.max(pts[i - 1][0] + 1, nx));
  pts[i] = [nx, clamp255(y)];
  return pts;
}
export function removeCurvePoint(points, i) {
  if (i <= 0 || i >= points.length - 1) return points.map((p) => [...p]);
  return points.filter((_, k) => k !== i).map((p) => [...p]);
}
