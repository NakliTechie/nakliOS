// Face maths around the MediaPipe face detector and face mesh, and SFace identity vectors: anchor decoding,
// crops, mesh mapping, face-part polygons (L61), the eye aspect ratio for closed eyes (L63), alignment and
// grouping (L64). Pure; node tests check each. Formulas are Atelier's own; the anchor layout and the mesh
// point numbers are MediaPipe's published ones.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const prob = (x) => (x >= 0 && x <= 1 ? x : 1 / (1 + Math.exp(-clamp(x, -100, 100))));

// RGBA u8 → CHW float [3, S, S] in 0..1, the image scaled to fit S and centred on black.
export function letterbox(px, w, h, S) {
  const k = S / Math.max(w, h); const ox = (S - w * k) / 2; const oy = (S - h * k) / 2;
  const out = new Float32Array(3 * S * S);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const x = (i + 0.5 - ox) / k - 0.5; const y = (j + 0.5 - oy) / k - 0.5;
    if (x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5) continue;
    const v = bilinear(px, w, h, x, y);
    for (let c = 0; c < 3; c++) out[c * S * S + j * S + i] = v[c] / 255;
  }
  return { input: out, map: { k, ox, oy, S } };
}

export function bilinear(px, w, h, x, y) {
  const x0 = Math.floor(x); const y0 = Math.floor(y); const tx = x - x0; const ty = y - y0;
  const at = (i, j) => (clamp(j, 0, h - 1) * w + clamp(i, 0, w - 1)) * 4;
  const a = at(x0, y0); const b = at(x0 + 1, y0); const c = at(x0, y0 + 1); const d = at(x0 + 1, y0 + 1);
  return [0, 1, 2].map((k) => (px[a + k] * (1 - tx) + px[b + k] * tx) * (1 - ty) + (px[c + k] * (1 - tx) + px[d + k] * tx) * ty);
}

// BlazeFace (256 px "back" model) anchors: a 16 × 16 grid with 2 anchors per cell, then an 8 × 8 grid with
// 6 per cell; centres at ((x + 0.5)/n, (y + 0.5)/n), unit size.
export function blazeAnchors() {
  const a = [];
  for (const [n, per] of [[16, 2], [8, 6]]) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) for (let k = 0; k < per; k++) a.push([(x + 0.5) / n, (y + 0.5) / n]);
  return a;
}

// Raw detector outputs (two heads, 16 values and 1 score per anchor) → detections in the 256 px frame,
// after non-maximum suppression (IoU 0.3). Per anchor (cx, cy):
//   centre = raw[0..1]/256 + (cx, cy), size = raw[2..3]/256, keypoint k = raw[4 + 2k .. 5 + 2k]/256 + (cx, cy)
// and score = sigmoid(raw score). Each detection: { box: [x0, y0, x1, y1], score, keypoints: 6 × [x, y] }.
export function decodeBlazeFace(coords, scores, { minScore = 0.6, iou = 0.3 } = {}) {
  const anchors = blazeAnchors(); const S = 256; const all = [];
  let n = 0;
  for (let head = 0; head < 2; head++) {
    const c = coords[head]; const s = scores[head]; const count = s.length;
    for (let i = 0; i < count; i++, n++) {
      const p = prob(s[i]); if (p < minScore) continue;
      const [ax, ay] = anchors[n]; const r = c.subarray(i * 16, i * 16 + 16);
      const cx = (r[0] / S + ax) * S; const cy = (r[1] / S + ay) * S; const bw = r[2]; const bh = r[3];
      const kp = []; for (let k = 0; k < 6; k++) kp.push([(r[4 + 2 * k] / S + ax) * S, (r[5 + 2 * k] / S + ay) * S]);
      all.push({ box: [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], score: p, keypoints: kp });
    }
  }
  return nms(all, iou);
}

export function iouOf(a, b) {
  const x0 = Math.max(a[0], b[0]); const y0 = Math.max(a[1], b[1]); const x1 = Math.min(a[2], b[2]); const y1 = Math.min(a[3], b[3]);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
  return u > 0 ? i / u : 0;
}
export function nms(dets, thr) {
  const out = [];
  for (const d of [...dets].sort((a, b) => b.score - a.score)) if (!out.some((o) => iouOf(o.box, d.box) > thr)) out.push(d);
  return out;
}

// Detection in the letterboxed frame → image pixels.
export function unletterbox(d, { k, ox, oy }) {
  const f = ([x, y]) => [(x - ox) / k, (y - oy) / k];
  const [x0, y0] = f([d.box[0], d.box[1]]); const [x1, y1] = f([d.box[2], d.box[3]]);
  return { box: [x0, y0, x1, y1], score: d.score, keypoints: d.keypoints.map(f) };
}

// A square crop around a detection, `scale` × its larger side, rotated so the eye line (keypoints 0 and 1)
// is horizontal: { cx, cy, size, angle }.
export function faceCrop(d, scale = 1.5) {
  const [x0, y0, x1, y1] = d.box; const [e0, e1] = d.keypoints;
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, size: Math.max(x1 - x0, y1 - y0) * scale, angle: Math.atan2(e1[1] - e0[1], e1[0] - e0[0]) };
}
// Crop point (u, v) in 0..S → image point: centre + size · R(angle) · (u/S − ½, v/S − ½).
export function cropToImage(c, S, u, v) {
  const a = u / S - 0.5; const b = v / S - 0.5; const co = Math.cos(c.angle); const si = Math.sin(c.angle);
  return [c.cx + c.size * (co * a - si * b), c.cy + c.size * (si * a + co * b)];
}
// The crop as float [3, S, S] in 0..1 (bilinear): CHW, or NHWC [S, S, 3] with layout 'nhwc' (Face Mesh V2).
export function warpCrop(px, w, h, c, S, layout = 'chw') {
  const out = new Float32Array(3 * S * S);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const [x, y] = cropToImage(c, S, i + 0.5, j + 0.5); const v = bilinear(px, w, h, x - 0.5, y - 0.5);
    for (let k = 0; k < 3; k++) out[layout === 'nhwc' ? (j * S + i) * 3 + k : k * S * S + j * S + i] = v[k] / 255;
  }
  return out;
}
// MediaPipe's next crop from a mesh: the points' bounding box centre, 1.5 × its larger side, rolled so the
// eye corners (33, 263) are level.
export function meshCrop(mesh, scale = 1.5) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of mesh) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, size: Math.max(x1 - x0, y1 - y0) * scale, angle: Math.atan2(mesh[263][1] - mesh[33][1], mesh[263][0] - mesh[33][0]) };
}
// Mesh output (468 or 478 × [x, y, z], in crop pixels or, as this ONNX export gives them, in crop units 0..1)
// → image [x, y, z] (z scaled like x).
export function meshToImage(lm, c, S) {
  let mx = 0; for (let i = 0; i < lm.length; i += 3) mx = Math.max(mx, Math.abs(lm[i]), Math.abs(lm[i + 1]));
  const u = mx <= 2 ? S : 1; const out = [];
  for (let i = 0; i + 2 < lm.length; i += 3) { const [x, y] = cropToImage(c, S, lm[i] * u, lm[i + 1] * u); out.push([x, y, lm[i + 2] * u * c.size / S]); }
  return out;
}

// ---- face parts ------------------------------------------------------------------------------------

// MediaPipe face mesh contours (point numbers of the canonical 468-point mesh).
export const CONTOURS = {
  face: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
  rightEye: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  leftEye: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  lips: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185],
  mouth: [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191],
  rightBrow: [46, 53, 52, 65, 55, 107, 66, 105, 63, 70],
  leftBrow: [276, 283, 282, 295, 285, 336, 296, 334, 293, 300],
};
export const PARTS = ['face', 'skin', 'eyes', 'brows', 'lips', 'mouth'];

// A part as polygon operations [{ op: 'add' | 'subtract', points }] in image pixels:
//   face = the face oval; eyes = both eye contours; brows = both brow contours; lips = the outer lip
//   contour minus the mouth opening; mouth = the mouth opening; skin = face − eyes − brows − outer lips.
export function partPolygons(mesh, part) {
  const P = (name) => CONTOURS[name].map((i) => [mesh[i][0], mesh[i][1]]);
  switch (part) {
    case 'face': return [{ op: 'add', points: P('face') }];
    case 'eyes': return [{ op: 'add', points: P('rightEye') }, { op: 'add', points: P('leftEye') }];
    case 'brows': return [{ op: 'add', points: P('rightBrow') }, { op: 'add', points: P('leftBrow') }];
    case 'lips': return [{ op: 'add', points: P('lips') }, { op: 'subtract', points: P('mouth') }];
    case 'mouth': return [{ op: 'add', points: P('mouth') }];
    case 'skin': return [{ op: 'add', points: P('face') }, ...['rightEye', 'leftEye', 'rightBrow', 'leftBrow', 'lips'].map((n) => ({ op: 'subtract', points: P(n) }))];
    default: throw new Error(`unknown face part ${part}`);
  }
}

// ---- closed eyes -----------------------------------------------------------------------------------

// Eye aspect ratio (Soukupová and Čech, 2016) per eye from the mesh:
//   EAR = (|p2 − p6| + |p3 − p5|) / (2 |p1 − p4|)
// right eye p1..p6 = 33, 160, 158, 133, 153, 144; left eye = 362, 385, 387, 263, 373, 380.
export function eyeAspect(mesh) {
  const d = (a, b) => Math.hypot(mesh[a][0] - mesh[b][0], mesh[a][1] - mesh[b][1]);
  const ear = ([p1, p2, p3, p4, p5, p6]) => (d(p2, p6) + d(p3, p5)) / (2 * d(p1, p4) || 1);
  return { right: ear([33, 160, 158, 133, 153, 144]), left: ear([362, 385, 387, 263, 373, 380]) };
}
// The 146 mesh points the Blendshape V2 model reads, in its order (MediaPipe face_blendshapes_graph.cc), and the
// positions of eyeBlinkLeft and eyeBlinkRight among its 52 scores (ARKit order, _neutral first).
export const BLEND_POINTS = [0, 1, 4, 5, 6, 7, 8, 10, 13, 14, 17, 21, 33, 37, 39, 40, 46, 52, 53, 54, 55, 58, 61, 63, 65, 66, 67, 70, 78, 80, 81, 82, 84, 87, 88, 91, 93, 95, 103, 105, 107, 109, 127, 132, 133, 136, 144, 145, 146, 148, 149, 150, 152, 153, 154, 155, 157, 158, 159, 160, 161, 162, 163, 168, 172, 173, 176, 178, 181, 185, 191, 195, 197, 234, 246, 249, 251, 263, 267, 269, 270, 276, 282, 283, 284, 285, 288, 291, 293, 295, 296, 297, 300, 308, 310, 311, 312, 314, 317, 318, 321, 323, 324, 332, 334, 336, 338, 356, 361, 362, 365, 373, 374, 375, 377, 378, 379, 380, 381, 382, 384, 385, 386, 387, 388, 389, 390, 397, 398, 400, 402, 405, 409, 415, 454, 466, 468, 469, 470, 471, 472, 473, 474, 475, 476, 477];
export const BLINK = { left: 9, right: 10 };
// The blendshape model's input: the 146 points' image x, y as float [1, 146, 2].
export function blendInput(mesh) { const o = new Float32Array(BLEND_POINTS.length * 2); BLEND_POINTS.forEach((i, k) => { o[k * 2] = mesh[i][0]; o[k * 2 + 1] = mesh[i][1]; }); return o; }

// Closed eyes. With blink scores (Blendshape V2, 0..1 per eye) both eyes are closed when both scores are at
// least `blinkAbove` (0.32, the midpoint of the gap). Measured in Chrome on eight CC0 Wikimedia Commons photos
// (2026-11-13, the app's 1536 px render): closed eyes 0.457 to 0.778 (lower eye of each face), open eyes 0.060 to
// 0.189 (higher eye). Without blink scores the eye aspect decides: closed when both are below `closedBelow` (0.15).
export function eyesClosed(mesh, blink = null, { closedBelow = 0.15, blinkAbove = 0.32 } = {}) {
  const e = eyeAspect(mesh); const r3 = (v) => Math.round(v * 1000) / 1000;
  if (blink) return { closed: blink.left >= blinkAbove && blink.right >= blinkAbove, left: r3(e.left), right: r3(e.right), blinkLeft: r3(blink.left), blinkRight: r3(blink.right) };
  return { closed: e.left < closedBelow && e.right < closedBelow, left: r3(e.left), right: r3(e.right) };
}

// ---- identity: alignment and grouping ---------------------------------------------------------------

// The 112 × 112 five-point template SFace and ArcFace models are trained on (image-left eye first).
export const TEMPLATE = [[38.2946, 51.6963], [73.5318, 51.4963], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
const mean = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
// Five points from the mesh in template order: eye centres (image-left first), nose tip, mouth corners.
export function fivePoints(mesh) {
  const eyeA = mean(CONTOURS.rightEye.map((i) => mesh[i])); const eyeB = mean(CONTOURS.leftEye.map((i) => mesh[i]));
  const [l, r] = eyeA[0] <= eyeB[0] ? [eyeA, eyeB] : [eyeB, eyeA];
  const m1 = mesh[61]; const m2 = mesh[291]; const [ml, mr] = m1[0] <= m2[0] ? [m1, m2] : [m2, m1];
  return [l, r, [mesh[1][0], mesh[1][1]], [ml[0], ml[1]], [mr[0], mr[1]]];
}
// Least-squares similarity transform (scale, rotation, translation) taking src points onto dst:
// [x'; y'] = [a −b; b a][x; y] + [tx; ty]. Returns [a, b, tx, ty].
export function similarity(src, dst) {
  const [sx, sy] = mean(src); const [dx, dy] = mean(dst);
  let num1 = 0; let num2 = 0; let den = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i][0] - sx; const y = src[i][1] - sy; const u = dst[i][0] - dx; const v = dst[i][1] - dy;
    num1 += x * u + y * v; num2 += x * v - y * u; den += x * x + y * y;
  }
  const a = num1 / den; const b = num2 / den;
  return [a, b, dx - (a * sx - b * sy), dy - (b * sx + a * sy)];
}
// The face aligned to the template as CHW float [3, 112, 112], BGR order, 0..255 (OpenCV's blob for SFace).
export function alignFace(px, w, h, mesh) {
  const [a, b, tx, ty] = similarity(fivePoints(mesh), TEMPLATE);
  const s2 = a * a + b * b; const S = 112; const out = new Float32Array(3 * S * S);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const u = i - tx; const v = j - ty;   // inverse: [x; y] = [a b; −b a][u; v] / (a² + b²)
    const x = (a * u + b * v) / s2; const y = (-b * u + a * v) / s2;
    const c = bilinear(px, w, h, x, y);
    out[j * S + i] = c[2]; out[S * S + j * S + i] = c[1]; out[2 * S * S + j * S + i] = c[0];
  }
  return out;
}

// Greedy grouping of unit vectors: each face joins the group whose mean vector is most similar when that
// cosine is at least `threshold` (0.363 is OpenCV's SFace same-person threshold), else starts a group.
export function groupFaces(faces, threshold = 0.363) {
  const groups = [];
  for (const f of faces) {
    let best = null; let bs = -2;
    for (const g of groups) { let s = 0; let n = 0; for (let i = 0; i < f.v.length; i++) { s += f.v[i] * g.sum[i]; n += g.sum[i] * g.sum[i]; } const c = s / (Math.sqrt(n) || 1); if (c > bs) { bs = c; best = g; } }
    if (best && bs >= threshold) { best.members.push(f); for (let i = 0; i < f.v.length; i++) best.sum[i] += f.v[i]; }
    else groups.push({ members: [f], sum: Float32Array.from(f.v) });
  }
  return groups.sort((a, b) => b.members.length - a.members.length).map((g, i) => ({ group: i + 1, faces: g.members.map(({ v, ...rest }) => rest) }));
}
