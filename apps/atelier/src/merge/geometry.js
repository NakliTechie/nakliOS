// Geometry for panorama stitching: homography and affine fits, RANSAC, projections and the focal length
// implied by a homography. Pure code: node and browser.

// Solves the n×n system A x = b by Gaussian elimination with partial pivoting; null when singular.
export function solve(A, b) {
  const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}

// Least squares via the normal equations: rows of A (m × n) and b (m).
function leastSquares(rows, b) {
  const n = rows[0].length; const N = Array.from({ length: n }, () => new Array(n).fill(0)); const y = new Array(n).fill(0);
  rows.forEach((r, i) => { for (let a = 0; a < n; a++) { y[a] += r[a] * b[i]; for (let c = 0; c < n; c++) N[a][c] += r[a] * r[c]; } });
  return solve(N, y);
}

// Hartley normalisation: translate to the centroid, scale so the mean distance is √2.
function normaliser(pts) {
  let mx = 0; let my = 0; for (const [x, y] of pts) { mx += x; my += y; } mx /= pts.length; my /= pts.length;
  let d = 0; for (const [x, y] of pts) d += Math.hypot(x - mx, y - my); d = d / pts.length || 1;
  const s = Math.SQRT2 / d;
  return { T: [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1], f: ([x, y]) => [s * (x - mx), s * (y - my)] };
}

export const mul3 = (A, B) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]));
export function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h; const B = -(d * i - f * g); const C = d * h - e * g;
  const det = a * A + b * B + c * C; if (Math.abs(det) < 1e-15) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
export function apply(H, x, y) { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; }

// Homography mapping src → dst from n ≥ 4 pairs [[sx, sy], [dx, dy]]: normalised DLT with h33 = 1,
// solved by least squares (x' (h7 x + h8 y + 1) = h1 x + h2 y + h3, likewise y').
export function fitHomography(pairs) {
  if (pairs.length < 4) return null;
  const ns = normaliser(pairs.map((p) => p[0])); const nd = normaliser(pairs.map((p) => p[1]));
  const rows = []; const b = [];
  for (const [s, d] of pairs) {
    const [x, y] = ns.f(s); const [u, v] = nd.f(d);
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = leastSquares(rows, b); if (!h) return null;
  const Hn = [...h, 1]; const Ti = inv3(nd.T); if (!Ti) return null;
  const H = mul3(Ti, mul3(Hn, ns.T));
  return H.map((v) => v / H[8]);
}

// Affine map src → dst ([a, b, c, d, e, f, 0, 0, 1] as a 3×3) from n ≥ 3 pairs, least squares.
export function fitAffine(pairs) {
  if (pairs.length < 3) return null;
  const rows = []; const bx = []; const by = [];
  for (const [[x, y], [u, v]] of pairs) { rows.push([x, y, 1]); bx.push(u); by.push(v); }
  const p = leastSquares(rows, bx); const q = leastSquares(rows, by);
  return p && q ? [...p, ...q, 0, 0, 1] : null;
}

// Deterministic generator (mulberry32) so a stitch is reproducible.
export function rng(seed = 1) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// RANSAC (Fischler and Bolles 1981): best model by inlier count over `iterations` random minimal sets,
// then refit on all inliers. threshold is the reprojection error in pixels.
export function ransac(pairs, { kind = 'homography', iterations = 1500, threshold = 3, seed = 1 } = {}) {
  const k = kind === 'homography' ? 4 : 3; const fit = kind === 'homography' ? fitHomography : fitAffine;
  if (pairs.length < k) return null;
  const r = rng(seed); let best = null; let bestIn = [];
  const inliers = (M) => pairs.filter(([s, d]) => { const [x, y] = apply(M, s[0], s[1]); return Math.hypot(x - d[0], y - d[1]) <= threshold; });
  for (let it = 0; it < iterations; it++) {
    const idx = new Set(); while (idx.size < k) idx.add(Math.floor(r() * pairs.length));
    const M = fit([...idx].map((i) => pairs[i])); if (!M || M.some((v) => !Number.isFinite(v))) continue;
    const ins = inliers(M);
    if (ins.length > bestIn.length) { best = M; bestIn = ins; if (ins.length === pairs.length) break; }
  }
  if (!best || bestIn.length < k) return null;
  for (let round = 0; round < 2; round++) { const M = fit(bestIn); if (!M) break; const ins = inliers(M); if (ins.length < bestIn.length) break; best = M; bestIn = ins; }
  return { model: best, inliers: bestIn };
}

// Focal lengths implied by a homography between two views rotating about one centre (coordinates relative
// to each image's centre). Formulas from R. Szeliski and H.-Y. Shum, "Creating full view panoramic image
// mosaics and environment maps", SIGGRAPH 1997, as written in OpenCV's focalsFromHomography.
export function focalsFromHomography(H) {
  const h = H;
  // Of two candidate squared focals (each a ratio), keep the finite positive one whose denominator is larger.
  const pick = (n1, d1, n2, d2) => {
    const c = [[n1 / d1, Math.abs(d1)], [n2 / d2, Math.abs(d2)]].filter(([v]) => Number.isFinite(v) && v > 0).sort((p, q) => q[1] - p[1]);
    return c.length ? Math.sqrt(c[0][0]) : null;
  };
  const f1 = pick(-(h[0] * h[1] + h[3] * h[4]), h[6] * h[7], h[0] * h[0] + h[3] * h[3] - h[1] * h[1] - h[4] * h[4], (h[7] - h[6]) * (h[7] + h[6]));
  const f0 = pick(-h[2] * h[5], h[0] * h[3] + h[1] * h[4], h[5] * h[5] - h[2] * h[2], h[0] * h[0] + h[1] * h[1] - h[3] * h[3] - h[4] * h[4]);
  return f0 && f1 ? Math.sqrt(f0 * f1) : f0 || f1 || null;
}

// Projections of image-centred coordinates (x, y) at focal f (pixels) onto the cylinder or sphere,
// scaled by f so one unit is about one pixel at the centre: cylinder u = f·atan(x/f), v = f·y/√(x²+f²);
// sphere u = f·atan(x/f), v = f·atan(y/√(x²+f²)). 'perspective' is the identity.
export const PROJECTIONS = ['perspective', 'cylindrical', 'spherical'];
export function project(kind, f, x, y) {
  if (kind === 'perspective') return [x, y];
  const r = Math.hypot(x, f); const u = f * Math.atan2(x, f);
  return kind === 'cylindrical' ? [u, (f * y) / r] : [u, f * Math.atan2(y, r)];
}
export function unproject(kind, f, u, v) {
  if (kind === 'perspective') return [u, v];
  const th = u / f; if (Math.abs(th) >= Math.PI / 2) return [NaN, NaN];
  const x = f * Math.tan(th); const r = Math.hypot(x, f);
  return kind === 'cylindrical' ? [x, (v / f) * r] : (Math.abs(v / f) >= Math.PI / 2 ? [NaN, NaN] : [x, Math.tan(v / f) * r]);
}
