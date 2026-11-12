// Content-aware fill by classical PatchMatch (no model): fills a hole in an 8-bit RGBA image from the
// surrounding pixels. Pure (no GPU, no DOM), so node tests run it on synthetic images.
//
// Method (Atelier's own arrangement of two published algorithms):
// - Barnes, Shechtman, Finkelstein, Goldman, "PatchMatch: A Randomized Correspondence Algorithm for
//   Structural Image Editing", SIGGRAPH 2009: a nearest-neighbour field (NNF) from every target patch to
//   a source patch, refined by propagation from scan neighbours and a random search at halving radii.
// - Wexler, Shechtman, Irani, "Space-Time Completion of Video", PAMI 2007: coarse-to-fine completion
//   that alternates NNF search with patch voting (each hole pixel becomes the weighted mean of the
//   source pixels that the overlapping patches put on it).
//
// Definitions used below. P = 2r + 1 is the patch side. A source centre is valid when its whole P × P
// patch lies inside the image and contains no hole pixel, so a fill never copies a hole pixel. A target
// centre is any centre (clamped r pixels inside the image) whose patch overlaps the hole.
//   distance D(t, s) = Σ over the patch of Σ over R, G, B of (I[t + d] − I[s + d])²
//   vote weight     w(t) = exp(−D(t, s(t)) / (2 σ²)), σ² = 0.05 × the 75th percentile of D over the
//                   targets (a sharp weight: the best-matching patches dominate, so fine texture such as
//                   twigs survives the vote; 1 × gave a smooth smear on a real photo, 2026-11-12)
//   hole pixel      I[q] = Σ w(t) I[s(t) + (q − t)] / Σ w(t), over every target patch t that covers q
//   last full-resolution pass: I[q] = I[s(q)] for every hole pixel that is a patch centre (keeps grain)

const mulberry = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// Integral image of a 0/1 mask: S[(y + 1)(w + 1) + x + 1] = number of hole pixels in [0, x] × [0, y].
function integral(mask, w, h) {
  const S = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += mask[y * w + x]; S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row; }
  }
  return S;
}
const boxCount = (S, w, x0, y0, x1, y1) => S[(y1 + 1) * (w + 1) + x1 + 1] - S[y0 * (w + 1) + x1 + 1] - S[(y1 + 1) * (w + 1) + x0] + S[y0 * (w + 1) + x0];

function holeBox(mask, w, h) {
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}

// Halves a level: a coarse pixel is hole when any of its children is; its colour is the mean of its known
// children (hole pixels never feed a coarse colour).
function downsample(L) {
  const { w, h } = L; const cw = Math.ceil(w / 2); const chh = Math.ceil(h / 2);
  const img = new Float32Array(cw * chh * 3); const mask = new Uint8Array(cw * chh);
  for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) {
    let n = 0; let r = 0; let g = 0; let b = 0; let hole = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const X = 2 * x + dx; const Y = 2 * y + dy; if (X >= w || Y >= h) continue;
      const p = Y * w + X;
      if (L.mask[p]) { hole = 1; continue; }
      r += L.img[p * 3]; g += L.img[p * 3 + 1]; b += L.img[p * 3 + 2]; n++;
    }
    const q = y * cw + x; mask[q] = hole;
    if (n) { img[q * 3] = r / n; img[q * 3 + 1] = g / n; img[q * 3 + 2] = b / n; }
  }
  return { w: cw, h: chh, img, mask };
}

// Starting guess for the coarsest hole: peel inward, each ring pixel taking the mean of its known
// 8-neighbours.
function onionFill(L) {
  const { w, h, img } = L; const known = Uint8Array.from(L.mask, (m) => 1 - m);
  let left = known.reduce((a, k) => a + (1 - k), 0);
  while (left > 0) {
    const ring = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x; if (known[p]) continue;
      let n = 0; let r = 0; let g = 0; let b = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx; const Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const q = Y * w + X; if (!known[q]) continue;
        r += img[q * 3]; g += img[q * 3 + 1]; b += img[q * 3 + 2]; n++;
      }
      if (n) ring.push([p, r / n, g / n, b / n]);
    }
    if (!ring.length) break;   // no known pixel anywhere: nothing to grow from
    for (const [p, r, g, b] of ring) { img[p * 3] = r; img[p * 3 + 1] = g; img[p * 3 + 2] = b; known[p] = 1; left--; }
  }
}

// One pyramid level's search state: valid source centres, target centres, NNF and distances.
function prepare(L, r) {
  const { w, h, mask } = L; const S = integral(mask, w, h);
  const valid = new Uint8Array(w * h); const validList = [];
  const isTarget = new Uint8Array(w * h); const targets = [];
  for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) {
    const n = boxCount(S, w, x - r, y - r, x + r, y + r);
    const p = y * w + x;
    if (n === 0) { valid[p] = 1; validList.push(p); } else { isTarget[p] = 1; targets.push(p); }
  }
  // Hole pixels within r of the image edge are covered by the clamped centres above.
  return { valid, validList: Int32Array.from(validList), isTarget, targets: Int32Array.from(targets) };
}

export function patchmatchFill(px, w, h, holeIn, opts = {}) {
  const r = opts.radius ?? 3; const P = 2 * r + 1;
  const rand = mulberry(opts.seed ?? 1);
  if (w < P || h < P) throw new Error(`the image (${w} × ${h}) is smaller than one ${P} × ${P} patch`);
  // Level 0: the image as float RGB; the hole is every pixel with a non-zero hole value.
  const L0 = { w, h, img: new Float32Array(w * h * 3), mask: new Uint8Array(w * h) };
  let holeCount = 0;
  for (let p = 0; p < w * h; p++) {
    L0.img[p * 3] = px[p * 4]; L0.img[p * 3 + 1] = px[p * 4 + 1]; L0.img[p * 3 + 2] = px[p * 4 + 2];
    if (holeIn[p]) { L0.mask[p] = 1; holeCount++; }
  }
  const out = new Uint8ClampedArray(px);
  if (!holeCount) return { data: out, levels: 0, holePixels: 0 };

  // Pyramid: halve until the hole spans at most 2 patches or the image would get too small to search.
  const levels = [L0];
  for (;;) {
    const L = levels.at(-1); const b = holeBox(L.mask, L.w, L.h);
    if (!b || Math.max(b[2] - b[0], b[3] - b[1]) + 1 <= 2 * P || Math.min(L.w, L.h) / 2 < 4 * P) break;
    levels.push(downsample(L));
  }
  const top = levels.length - 1;
  onionFill(levels[top]);

  let prevL = null; let prevNnf = null; let iterations = 0;
  for (let li = top; li >= 0; li--) {
    const L = levels[li]; const { w: W, h: H, img: I, mask: M } = L;
    const st = prepare(L, r);
    if (!st.validList.length) throw new Error('the area around the hole has no whole patch outside it; select a smaller hole or leave more image around it');
    const nnf = new Int32Array(W * H).fill(-1); const dist = new Float64Array(W * H);
    const randomValid = () => st.validList[Math.floor(rand() * st.validList.length)];

    // Coarser result → this level: nearest upsampling of the hole colours and of the NNF.
    if (prevL) {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const p = y * W + x; if (!M[p]) continue;
        const q = Math.min(y >> 1, prevL.h - 1) * prevL.w + Math.min(x >> 1, prevL.w - 1);
        I[p * 3] = prevL.img[q * 3]; I[p * 3 + 1] = prevL.img[q * 3 + 1]; I[p * 3 + 2] = prevL.img[q * 3 + 2];
      }
    }
    const D = (t, s, best = Infinity) => {
      let sum = 0;
      for (let dy = -r; dy <= r; dy++) {
        let a = (t + dy * W - r) * 3; let b = (s + dy * W - r) * 3;
        for (let k = 0; k < P * 3; k++) { const d = I[a++] - I[b++]; sum += d * d; }
        if (sum >= best) return sum;
      }
      return sum;
    };
    for (const t of st.targets) {
      let s = -1;
      if (prevNnf) {
        const x = t % W; const y = (t - x) / W;
        const q = Math.min(y >> 1, prevL.h - 1) * prevL.w + Math.min(x >> 1, prevL.w - 1);
        const cs = prevNnf[q];
        if (cs >= 0) {
          const sx = Math.min(W - 1 - r, Math.max(r, 2 * (cs % prevL.w) + (x & 1)));
          const sy = Math.min(H - 1 - r, Math.max(r, 2 * Math.floor(cs / prevL.w) + (y & 1)));
          if (st.valid[sy * W + sx]) s = sy * W + sx;
        }
      }
      if (s < 0) s = randomValid();
      nnf[t] = s; dist[t] = D(t, s);
    }

    const tryCand = (t, s) => { if (s < 0 || s >= W * H || !st.valid[s]) return; const d = D(t, s, dist[t]); if (d < dist[t]) { dist[t] = d; nnf[t] = s; } };
    function pmPass(reverse) {
      const T = st.targets; const n = T.length; const step = reverse ? -1 : 1;
      for (let k = reverse ? n - 1 : 0; reverse ? k >= 0 : k < n; k += step) {
        const t = T[k]; const x = t % W;
        // Propagation: the scan neighbour's source, shifted back by one pixel.
        const nx = t - step; if (x - step >= 0 && x - step < W && st.isTarget[nx] && nnf[nx] >= 0) { const c = nnf[nx] + step; if ((c % W) === ((nnf[nx] % W) + step)) tryCand(t, c); }
        const ny = t - step * W; if (ny >= 0 && ny < W * H && st.isTarget[ny] && nnf[ny] >= 0) tryCand(t, nnf[ny] + step * W);
        // Random search around the current best at radii max(W, H) · 2^−i.
        const bx = nnf[t] % W; const by = (nnf[t] - bx) / W;
        for (let rad = Math.max(W, H); rad >= 1; rad >>= 1) {
          const cx = Math.round(bx + (2 * rand() - 1) * rad); const cy = Math.round(by + (2 * rand() - 1) * rad);
          if (cx < r || cy < r || cx >= W - r || cy >= H - r) continue;
          tryCand(t, cy * W + cx);
        }
      }
    }
    function vote() {
      const T = st.targets;
      const ds = Array.from(T, (t) => dist[t]).sort((a, b) => a - b);
      const sigma2 = Math.max(1e-6, 0.05 * ds[Math.floor(0.75 * (ds.length - 1))]);
      const acc = new Float64Array(W * H * 3); const ws = new Float64Array(W * H);
      for (const t of T) {
        const s = nnf[t]; const wt = Math.exp(-dist[t] / (2 * sigma2)) + 1e-12;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const q = t + dy * W + dx; if (!M[q]) continue;
          const sq = s + dy * W + dx;
          acc[q * 3] += wt * I[sq * 3]; acc[q * 3 + 1] += wt * I[sq * 3 + 1]; acc[q * 3 + 2] += wt * I[sq * 3 + 2]; ws[q] += wt;
        }
      }
      for (let q = 0; q < W * H; q++) if (M[q] && ws[q] > 0) { I[q * 3] = acc[q * 3] / ws[q]; I[q * 3 + 1] = acc[q * 3 + 1] / ws[q]; I[q * 3 + 2] = acc[q * 3 + 2] / ws[q]; }
      for (const t of T) dist[t] = D(t, nnf[t]);
    }

    const em = opts.iterations ?? (li === top ? 8 : li === 0 ? 3 : 4);
    for (let e = 0; e < em; e++) {
      pmPass(false); pmPass(true);
      vote(); iterations++;
    }
    // Final pass at full resolution: voting averages overlapping patches, which smooths fine texture, so
    // each hole pixel that is a patch centre takes its best source patch's centre pixel instead:
    //   I[q] = I[s(q)]  (Atelier's choice; keeps the surround's grain).
    if (li === 0) {
      pmPass(false); pmPass(true);
      const copy = new Float32Array(I);
      for (const t of st.targets) if (M[t]) { const s = nnf[t]; copy[t * 3] = I[s * 3]; copy[t * 3 + 1] = I[s * 3 + 1]; copy[t * 3 + 2] = I[s * 3 + 2]; }
      I.set(copy);
    }
    prevL = L; prevNnf = nnf;
  }

  for (let p = 0; p < w * h; p++) {
    if (!L0.mask[p]) continue;
    out[p * 4] = Math.round(L0.img[p * 3]); out[p * 4 + 1] = Math.round(L0.img[p * 3 + 1]); out[p * 4 + 2] = Math.round(L0.img[p * 3 + 2]); out[p * 4 + 3] = 255;
  }
  return { data: out, levels: levels.length, holePixels: holeCount, iterations };
}

// The work area for a hole: its bounding box grown by a margin (the patch source region), clamped to the
// image. margin = max(4 patches, the hole's larger side), so the source region holds at least the hole's
// own extent of surrounding image on every side the image allows.
export function fillRegion(holeBoxXYXY, w, h, radius = 3) {
  const [x0, y0, x1, y1] = holeBoxXYXY; const P = 2 * radius + 1;
  const m = Math.max(4 * P, x1 - x0 + 1, y1 - y0 + 1);
  return [Math.max(0, x0 - m), Math.max(0, y0 - m), Math.min(w, x1 + 1 + m), Math.min(h, y1 + 1 + m)];
}
