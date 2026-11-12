// Panorama merge (L44, P57): overlapping frames → one stitched image. Steps:
// 1. Detect and describe features on a grey copy downscaled to at most `detectEdge` pixels (features.js).
// 2. Match every pair; fit a homography by RANSAC (3 px at detection scale); keep pairs with ≥ 15 inliers.
// 3. Join the frames by a maximum spanning tree on inlier counts, rooted at the frame with the most
//    inliers in total (the reference; it keeps its own geometry).
// 4. Projection: 'perspective' chains the homographies into the reference frame. 'cylindrical' and
//    'spherical' estimate the focal length (median over tree edges of focalsFromHomography, or the long
//    edge when no edge gives one), project every inlier onto the cylinder or sphere around its own frame's
//    centre, and chain affine fits of those projected pairs (a camera turning about one point moves a
//    projected frame by a shift; the affine also absorbs small tilt).
// 5. Render: each output pixel is mapped back into every frame (bilinear sample). Feathered blending:
//      w = (min(x + ½, W − ½ − x) / (W/2)) · (min(y + ½, H − ½ − y) / (H/2)), then w⁴ so the frame whose
//      centre is nearer dominates and seams stay narrow; out = Σ w·v / Σ w. Pixels no frame covers
//    stay 0 with coverage 0.
// 6. Exposure: along each tree edge the child frame gets the gain that matches its mean luminance at the
//    shared inliers (values 0.01–0.95 in both) to its parent's; gains multiply down the tree.
// Pure code: node and browser.

import { luma, oetf, shrink, bilinear } from './image.js';
import { harris, describe, match } from './features.js';
import { ransac, fitAffine, mul3, inv3, apply, focalsFromHomography, project, unproject, PROJECTIONS } from './geometry.js';

const MIN_INLIERS = 15;

function features(im, detectEdge) {
  const f = Math.max(1, Math.ceil(Math.max(im.width, im.height) / detectEdge));
  const y = luma(im); for (let i = 0; i < y.length; i++) y[i] = oetf(Math.min(1, Math.max(0, y[i])));
  const s = shrink(y, im.width, im.height, f);
  const feats = describe(s.data, s.width, s.height, harris(s.data, s.width, s.height));
  // back to full-resolution pixel centres: x_full = f·(x + ½) − ½
  return { f, feats: feats.map((p) => ({ ...p, x: f * (p.x + 0.5) - 0.5, y: f * (p.y + 0.5) - 0.5 })), scale: f };
}

// frames: [{ width, height, data, lut? }]. Returns { width, height, data: Float32Array RGB (or Uint16 when
// opts.out16), coverage: Uint8Array, reference, projection, focal, edges, transforms }.
export function stitchPanorama(frames, { projection = 'cylindrical', detectEdge = 1200, maxPixels = 120e6, out16 = false, seed = 1 } = {}) {
  if (frames.length < 2) throw new Error('a panorama needs at least 2 frames');
  if (!PROJECTIONS.includes(projection)) throw new Error(`projection is one of ${PROJECTIONS.join(', ')}`);
  const n = frames.length;
  const F = frames.map((im) => features(im, detectEdge));
  const pairs = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const m = match(F[i].feats, F[j].feats);
    if (m.length < MIN_INLIERS) continue;
    const r = ransac(m, { kind: 'homography', threshold: 3 * Math.max(F[i].scale, F[j].scale), seed: seed + i * 31 + j });
    if (r && r.inliers.length >= MIN_INLIERS) pairs.push({ i, j, H: r.model, inliers: r.inliers });
  }
  // Maximum spanning tree (Prim) from the best-connected frame.
  const total = new Array(n).fill(0); for (const p of pairs) { total[p.i] += p.inliers.length; total[p.j] += p.inliers.length; }
  const ref = total.indexOf(Math.max(...total));
  const inTree = new Set([ref]); const edges = [];
  while (inTree.size < n) {
    let best = null;
    for (const p of pairs) {
      const a = inTree.has(p.i); const b = inTree.has(p.j);
      if (a !== b && (!best || p.inliers.length > best.inliers.length)) best = p;
    }
    if (!best) {
      const lost = frames.map((_, i) => i).filter((i) => !inTree.has(i));
      throw new Error(`frame${lost.length > 1 ? 's' : ''} ${lost.map((i) => i + 1).join(', ')} share${lost.length > 1 ? '' : 's'} too few matching features with the others (need ${MIN_INLIERS}); panorama frames must overlap by about a third`);
    }
    // orient the edge parent → child; H maps child pixels into parent pixels
    const child = inTree.has(best.i) ? best.j : best.i; const parent = child === best.i ? best.j : best.i;
    const H = child === best.i ? best.H : inv3(best.H);
    const inl = best.inliers.map(([a, b]) => (child === best.i ? [a, b] : [b, a]));
    edges.push({ parent, child, H, inliers: inl }); inTree.add(child);
  }
  // Exposure: each child's gain makes its mean luminance at the shared inliers match its parent's.
  const gains = new Array(n).fill(1);
  const yAt = (im, x, y) => { const k = (Math.round(y) * im.width + Math.round(x)) * 3; const v = (c) => (im.lut ? im.lut[im.data[k + c]] : im.data[k + c]); return 0.2126 * v(0) + 0.7152 * v(1) + 0.0722 * v(2); };
  for (const e of edges) {
    let sc = 0; let sp = 0;
    for (const [c, p] of e.inliers) { const a = yAt(frames[e.child], c[0], c[1]); const b = yAt(frames[e.parent], p[0], p[1]); if (a > 0.01 && a < 0.95 && b > 0.01 && b < 0.95) { sc += a; sp += b; } }
    gains[e.child] = gains[e.parent] * (sc > 0 ? sp / sc : 1);
  }
  frames = frames.map((im, i) => ({ ...im, gain: gains[i] }));
  const C = frames.map((im) => [(im.width - 1) / 2, (im.height - 1) / 2]);
  let focal = null;
  if (projection !== 'perspective') {
    const est = [];
    for (const e of edges) {
      // centred coordinates: Hc = T_parent⁻¹ · H · T_child with T a shift by the centre
      const T = (c) => [1, 0, c[0], 0, 1, c[1], 0, 0, 1]; const Ti = (c) => [1, 0, -c[0], 0, 1, -c[1], 0, 0, 1];
      const Hc = mul3(Ti(C[e.parent]), mul3(e.H, T(C[e.child])));
      const f = focalsFromHomography(Hc.map((v) => v / Hc[8])); if (f) est.push(f);
    }
    est.sort((a, b) => a - b);
    focal = est.length ? est[est.length >> 1] : Math.max(frames[ref].width, frames[ref].height);
  }
  // M[i]: frame i pixel → canvas coordinates (perspective: reference pixels; otherwise reference-projected units).
  const toProj = (i, x, y) => project(projection, focal, x - C[i][0], y - C[i][1]);
  const fromProj = (i, u, v) => { const [x, y] = unproject(projection, focal, u, v); return [x + C[i][0], y + C[i][1]]; };
  const M = new Array(n); M[ref] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (const e of edges) {
    let A;
    if (projection === 'perspective') A = e.H;
    else A = fitAffine(e.inliers.map(([c, p]) => [toProj(e.child, c[0], c[1]), toProj(e.parent, p[0], p[1])]));
    if (!A) throw new Error('the frames could not be placed; check they overlap');
    M[e.child] = mul3(M[e.parent], A);
  }
  const fwd = (i, x, y) => (projection === 'perspective' ? apply(M[i], x, y) : apply(M[i], ...toProj(i, x, y)));
  const Minv = M.map(inv3);
  const back = (i, u, v) => { const [a, b] = apply(Minv[i], u, v); return projection === 'perspective' ? [a, b] : fromProj(i, a, b); };
  // Canvas bounds from each frame's border.
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  frames.forEach((im, i) => {
    const W = im.width; const H = im.height; const S = 32;
    for (let k = 0; k <= S; k++) for (const [x, y] of [[(k * (W - 1)) / S, 0], [(k * (W - 1)) / S, H - 1], [0, (k * (H - 1)) / S], [W - 1, (k * (H - 1)) / S]]) {
      const [u, v] = fwd(i, x, y); if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      x0 = Math.min(x0, u); y0 = Math.min(y0, v); x1 = Math.max(x1, u); y1 = Math.max(y1, v);
    }
  });
  const ox = Math.floor(x0); const oy = Math.floor(y0);
  const OW = Math.ceil(x1) - ox + 1; const OH = Math.ceil(y1) - oy + 1;
  const inputArea = frames.reduce((s, im) => s + im.width * im.height, 0);
  if (!(OW > 0 && OH > 0) || OW * OH > Math.min(maxPixels, 6 * inputArea)) throw new Error(`the stitched canvas would be ${OW} × ${OH} px; the frames do not form a panorama (try perspective off, or fewer frames)`);
  const out = out16 ? new Uint16Array(OW * OH * 3) : new Float32Array(OW * OH * 3); const cov = new Uint8Array(OW * OH);
  // Per frame, the canvas box it can reach, so each output pixel tests only frames that may cover it.
  const boxes = frames.map((im, i) => {
    let a = Infinity; let b = Infinity; let c = -Infinity; let d = -Infinity; const S = 32;
    for (let k = 0; k <= S; k++) for (const [x, y] of [[(k * (im.width - 1)) / S, 0], [(k * (im.width - 1)) / S, im.height - 1], [0, (k * (im.height - 1)) / S], [im.width - 1, (k * (im.height - 1)) / S]]) {
      const [u, v] = fwd(i, x, y); if (!Number.isFinite(u)) continue; a = Math.min(a, u); b = Math.min(b, v); c = Math.max(c, u); d = Math.max(d, v);
    }
    return [Math.floor(a) - ox - 1, Math.floor(b) - oy - 1, Math.ceil(c) - ox + 1, Math.ceil(d) - oy + 1];
  });
  for (let Y = 0; Y < OH; Y++) {
    const active = boxes.map((bx, i) => (Y >= bx[1] && Y <= bx[3] ? i : -1)).filter((i) => i >= 0);
    for (let X = 0; X < OW; X++) {
      let sw = 0; let r = 0; let g = 0; let b = 0;
      for (const i of active) {
        const bx = boxes[i]; if (X < bx[0] || X > bx[2]) continue;
        const im = frames[i]; const [x, y] = back(i, X + ox, Y + oy);
        if (!(x >= -0.5 && y >= -0.5 && x <= im.width - 0.5 && y <= im.height - 0.5)) continue;
        const wx = Math.min(x + 0.5, im.width - 0.5 - x) / (im.width / 2); const wy = Math.min(y + 0.5, im.height - 0.5 - y) / (im.height / 2);
        let w = Math.max(0, wx) * Math.max(0, wy); w *= w; w *= w; if (!(w > 0)) w = 1e-12;
        const gain = im.gain || 1;
        r += w * gain * bilinear(im, x, y, 0); g += w * gain * bilinear(im, x, y, 1); b += w * gain * bilinear(im, x, y, 2); sw += w;
      }
      if (!(sw > 0)) continue;
      const k = (Y * OW + X) * 3; cov[Y * OW + X] = 255;
      if (out16) { out[k] = Math.min(65535, Math.round((r / sw) * 65535)); out[k + 1] = Math.min(65535, Math.round((g / sw) * 65535)); out[k + 2] = Math.min(65535, Math.round((b / sw) * 65535)); }
      else { out[k] = r / sw; out[k + 1] = g / sw; out[k + 2] = b / sw; }
    }
  }
  return {
    width: OW, height: OH, data: out, coverage: cov, origin: [ox, oy], reference: ref, projection, focal,
    edges: edges.map((e) => ({ from: e.child, to: e.parent, inliers: e.inliers.length })), transforms: M, gains,
  };
}
