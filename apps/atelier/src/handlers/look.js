// Perception that needs pixels: rendered previews (JPEG returned to the caller, so an agent can look at
// its own work), histograms and colour samples. All read the engine's real output.

import { needDoc, fail } from './util.js';

const M2020_709 = [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]];
const oetf = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

// Renders a variant of the document (one layer alone, or develop off) and restores the real one after.
async function withVariant(ctx, variant, fn) {
  if (!variant) return fn();
  await ctx.renderer.sync(variant);
  try { return await fn(); } finally { await ctx.renderer.sync(ctx.store.doc); }
}

function variantFor(doc, a) {
  if (!a.layerId && !a.before) return null;
  const v = structuredClone(doc);
  if (a.layerId) {
    if (!v.layers.some((l) => l.id === a.layerId)) return 'missing';
    v.layers = v.layers.filter((l) => l.id === a.layerId).map((l) => ({ ...l, visible: true }));
  }
  if (a.before) for (const l of v.layers) if (l.kind === 'raw') { l.develop = {}; delete l.curve; }
  return v;
}

const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };

export function register(bus, ctx) {
  bus.register('query.render', async (a) => {
    const doc = needDoc(ctx);
    const variant = variantFor(doc, a);
    if (variant === 'missing') fail('invalid', `no layer ${a.layerId}`, 'get_state', 'get_state');
    return withVariant(ctx, variant, async () => {
      let im;
      if (a.region) {
        const { x = 0, y = 0, w = 512, h = 512 } = a.region;
        im = await ctx.renderer.image8(0, [x, y, x + Math.min(w, 1024), y + Math.min(h, 1024)], 0.18);
      } else {
        const maxEdge = a.maxEdge ?? 1024;
        im = await ctx.renderer.resize(await ctx.renderer.image8(ctx.renderer.lodFor(doc, maxEdge), null, 0.18), maxEdge);
      }
      const jpeg = await ctx.renderer.encode(im, 'image/jpeg', 0.88);
      return { mime: 'image/jpeg', width: im.width, height: im.height, base64: b64(jpeg), before: !!a.before };
    });
  });

  bus.register('query.histogram', async (a) => {
    const doc = needDoc(ctx);
    const variant = variantFor(doc, a);
    if (variant === 'missing') fail('invalid', `no layer ${a.layerId}`, 'get_state', 'get_state');
    return withVariant(ctx, variant, async () => {
      const im = await ctx.renderer.image8(ctx.renderer.lodFor(doc, 1024), null, 0.18);
      const bins = { red: new Array(256).fill(0), green: new Array(256).fill(0), blue: new Array(256).fill(0), luma: new Array(256).fill(0) };
      let clipLow = 0; let clipHigh = 0; const n = im.width * im.height;
      for (let i = 0; i < n; i++) {
        const r = im.data[i * 4]; const g = im.data[i * 4 + 1]; const b = im.data[i * 4 + 2];
        bins.red[r]++; bins.green[g]++; bins.blue[b]++;
        bins.luma[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
        if (r === 0 && g === 0 && b === 0) clipLow++; if (r === 255 || g === 255 || b === 255) clipHigh++;
      }
      return { pixels: n, width: im.width, height: im.height, encoding: 'sRGB 8-bit, display', bins, clipped: { shadows: clipLow, highlights: clipHigh } };
    });
  });

  bus.register('query.sample', async (a) => {
    const doc = needDoc(ctx);
    const r = a.radius ?? 0;
    if (a.x < 0 || a.y < 0 || a.x >= doc.width || a.y >= doc.height) fail('invalid', 'point is outside the document', 'fix_argument', 'sample_color');
    const im = await ctx.engine.renderImage(0, [a.x - r, a.y - r, a.x + r + 1, a.y + r + 1]);
    const n = im.width * im.height; const sum = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) sum[c] += im.data[i * 4 + c];
    const alpha = sum[3] / n; const k = sum[3] > 0 ? 1 / sum[3] : 0;
    const lin2020 = [sum[0] * k, sum[1] * k, sum[2] * k];
    const lin709 = M2020_709.map((row) => row[0] * lin2020[0] + row[1] * lin2020[1] + row[2] * lin2020[2]);
    const srgb = lin709.map((v) => Math.round(255 * oetf(Math.min(1, Math.max(0, v)))));
    // CIE Lab (D65) from linear sRGB
    const X = 0.4124 * lin709[0] + 0.3576 * lin709[1] + 0.1805 * lin709[2];
    const Y = 0.2126 * lin709[0] + 0.7152 * lin709[1] + 0.0722 * lin709[2];
    const Z = 0.0193 * lin709[0] + 0.1192 * lin709[1] + 0.9505 * lin709[2];
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    const fx = f(X / 0.95047); const fy = f(Y); const fz = f(Z / 1.08883);
    const round = (v) => Math.round(v * 10000) / 10000;
    return { x: a.x, y: a.y, radius: r, pixels: n, alpha: round(alpha), linearRec2020: lin2020.map(round), sRGB: srgb,
      hex: `#${srgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`, lab: [round(116 * fy - 16), round(500 * (fx - fy)), round(200 * (fy - fz))] };
  });
}
