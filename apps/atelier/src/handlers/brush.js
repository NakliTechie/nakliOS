// Brush engine v2 commands (P26): brush presets in the shared asset library, the session's active brush,
// and the resolver paint_stroke uses. The engine is src/brush/engine.js.
//
// Presets are library/brushes/<name>.json, the folder the shared asset library (P60, src/handlers/share.js)
// lists and syncs: { format: 'atelier-brush', version: 2, size, hardness, flow, opacity, ...v2 fields,
// tip?: { width, height, data: base64 greyscale } }. Version 1 files (size, hardness, flow, opacity only)
// read as a round brush with no dynamics.
//
// Replay: paint_stroke records the brush it used. resolveBrush writes the resolved v2 fields (and the
// preset name for the tip) back into the call's args before the edit list stores them, and fills a
// missing seed from the stroke's points, so replaying the edit list paints the same dabs.

import { fail, needDoc, needLayer, stageOrRun } from './util.js';
import { safeName } from '../files/workspace.js';
import { normalizeBrush, tipFromPixels, tipToJson, tipFromJson, seedFromPoints } from '../brush/engine.js';

const enc = new TextEncoder();
const DIR = 'library/brushes/';
const V2_KEYS = ['spacing', 'angle', 'roundness', 'scatter', 'scatterBoth', 'count', 'jitter', 'control', 'min', 'seed'];

async function readPreset(s, name) {
  const p = `${DIR}${name}.json`;
  if (!s || !(await s.exists(p))) fail('invalid', `no brush preset ${name}; list_brushes lists them`, 'fix_argument', 'list_brushes');
  let j; try { j = JSON.parse(await s.readText(p)); } catch { fail('invalid', `${p} is not valid JSON`, 'fix_argument', 'list_brushes'); }
  return j;
}
// Decoded tips keyed by the preset name and the whole base64 data, so an edited tip of the same length is
// never served from the cache. The cache keeps the 32 most recently added tips.
const tipCache = new Map();
const TIP_CACHE_MAX = 32;

// The v2 brush for a paint_stroke call, or null for the v1 round brush. a.brush wins over the active
// brush (set_brush). Mutates a.brush to the resolved, normalised form so the edit list records it.
export async function resolveBrush(ctx, a) {
  const given = a.brush ?? ctx.activeBrush ?? null;
  if (!given) return null;
  let base = {}; let tipData = null;
  if (given.preset) {
    const s = ctx.storage();
    const j = await readPreset(s, given.preset);
    base = Object.fromEntries(V2_KEYS.filter((k) => k in j).map((k) => [k, j[k]]));
    if (j.tip) {
      const key = `${given.preset}:${j.tip.width}x${j.tip.height}:${j.tip.data}`;
      if (!tipCache.has(key)) {
        tipCache.set(key, tipFromJson(j.tip));
        if (tipCache.size > TIP_CACHE_MAX) tipCache.delete(tipCache.keys().next().value);
      }
      tipData = tipCache.get(key);
    }
  }
  const merged = { ...base, ...Object.fromEntries(Object.entries(given).filter(([k]) => V2_KEYS.includes(k))) };
  if (!Number.isFinite(merged.seed)) merged.seed = seedFromPoints(a.points);
  const b = normalizeBrush(merged);
  a.brush = { ...(given.preset ? { preset: given.preset } : {}), ...b };
  return { ...b, tipData };
}

export function register(bus, ctx) {
  const store = () => { const s = ctx.storage(); if (!s) fail('unsupported', 'no workspace storage; grant a folder or allow browser storage', 'use_ui_control', 'grant_folder'); return s; };

  bus.register('brush.set', async (a, { viewOnly }) => {
    viewOnly();
    if (a.reset) { ctx.activeBrush = null; return { brush: null, note: 'paint_stroke uses the v1 round brush' }; }
    const b = { ...(a.brush || {}) };
    if (a.preset) { await readPreset(store(), a.preset); b.preset = a.preset; }
    for (const k of Object.keys(b)) if (k !== 'preset' && !V2_KEYS.includes(k)) fail('invalid', `brush.${k} is not a brush engine field; size, hardness, flow and opacity are paint_stroke arguments`, 'fix_argument', 'set_brush');
    if ('seed' in b) delete b.seed;   // each stroke seeds from its own points unless the stroke names a seed
    ctx.activeBrush = b;
    return { brush: { ...(b.preset ? { preset: b.preset } : {}), ...normalizeBrush(b), seed: 'per stroke' } };
  });

  bus.register('brush.list', async () => {
    const s = store(); const out = [];
    for (const e of await s.list(DIR)) {
      if (!e.path.endsWith('.json')) continue;
      let j = {}; try { j = JSON.parse(await s.readText(e.path)); } catch { continue; }
      const { tip, format, ...rest } = j;
      out.push({ name: e.path.slice(DIR.length).replace(/\.json$/, ''), path: e.path, ...rest, version: j.version ?? 1, tip: tip ? { width: tip.width, height: tip.height } : null });
    }
    return { brushes: out, active: ctx.activeBrush ?? null };
  });

  bus.register('brush.save', async (a, { viewOnly, door }) => {
    viewOnly(); const s = store(); const T = 'save_brush_preset';
    const name = safeName(a.name);
    if (!name) fail('invalid', 'name is one path segment without / \\ : * ? " < > |', 'fix_argument', T);
    const p = `${DIR}${name}.json`;
    const replaces = await s.exists(p);
    if (replaces && !a.replace) fail('invalid', `${p} exists; pass replace: true or pick another name`, 'fix_argument', 'list_brushes');
    const num = (k, lo, hi, d) => { const v = a[k] ?? d; if (!Number.isFinite(v) || v < lo || v > hi) fail('invalid', `${k} is ${lo} to ${hi}`, 'fix_argument', T); return v; };
    const b = a.brush || {};
    for (const k of Object.keys(b)) if (!V2_KEYS.includes(k)) fail('invalid', `brush.${k} is not a brush engine field`, 'fix_argument', T);
    const { seed, ...v2 } = normalizeBrush(b);
    const out = { format: 'atelier-brush', version: 2, size: num('size', 1, 5000, 20), hardness: num('hardness', 0, 100, 100), flow: num('flow', 1, 100, 100), opacity: num('opacity', 1, 100, 100), ...v2, ...(Number.isFinite(b.seed) ? { seed } : {}) };
    // Custom brush from a selection: the selected pixels of a raster layer become the tip.
    if (a.fromSelection) {
      const doc = needDoc(ctx);
      if (!doc.selection) fail('invalid', 'nothing is selected; select the brush shape first', 'change_target', 'set_selection');
      const l = needLayer(ctx, a.layerId, { unlocked: false });
      if (l.kind !== 'raster') fail('unsupported', `a brush tip comes from a raster layer's pixels; ${l.name} is ${l.kind}`, 'change_target', 'list_layers');
      const r = ctx.renderer; const { width: w, height: h } = r.buffers.get(l.buffer);
      const m = l.matrix;
      if (m[0] !== 1 || m[1] !== 0 || m[2] !== 0 || m[3] !== 1 || w !== doc.width || h !== doc.height) fail('unsupported', 'define a brush from an untransformed, document-size raster layer (rasterise or reset its transform first)', 'change_target', 'list_layers');
      const tip = tipFromPixels(r.bufferData(l.buffer), w, h, r.bufferData(doc.selection.buffer), doc.selection.bounds, 256);
      if (!tip.data.some((v) => v > 0)) fail('invalid', 'the selected pixels are white or transparent, so the tip would paint nothing (dark pixels paint)', 'change_target', 'set_selection');
      out.tip = tipToJson(tip);
      if (a.size === undefined) out.size = tip.sourceSize;
    }
    const write = async () => {
      await s.write(p, enc.encode(`${JSON.stringify(out, null, 2)}\n`));
      return { name, path: p, size: out.size, tip: out.tip ? { width: out.tip.width, height: out.tip.height } : null, ...(replaces ? { replaced: true } : {}) };
    };
    // Writing over an existing preset replaces the person's file: the person confirms, from every door.
    if (replaces) return stageOrRun(ctx, { door }, T, `REPLACE brush preset ${name}`, write, { force: true });
    return write();
  });
}
