// Smart object commands (P12 embedded, P13 linked); the data shape is in src/files/smart.js. The engine
// renders a smart object's source as its own document, and the flattened result becomes the layer's pixel
// source; transform_layer then changes only the layer's matrix, so transforms always resample the source.
// PSD and layered TIFF exports write a smart object as an ordinary pixel layer (flattened); the source
// travels only in .atelier documents.

import { newDocument, makeLayer } from '../document.js';
import { needDoc, needLayer, fail, change, layerRow } from './util.js';
import { photoDocument } from './files.js';
import { photoKind, sidecarPath, baseName } from '../files/workspace.js';
import { packEmbedded, unpackEmbedded, linkedHash } from '../files/smart.js';

export function register(bus, ctx) {
  const rd = () => { if (!ctx.renderer) fail('unsupported', 'smart objects render through the WebGPU engine, which did not start', 'get_state', 'get_capabilities'); return ctx.renderer; };
  const store = () => { const s = ctx.storage(); if (!s) fail('unsupported', 'no workspace storage', 'use_ui_control', 'grant_folder'); return s; };
  const io = () => ({ info: (id) => rd().buffers.get(id), data: (id) => rd().bufferData(id) });
  const make = () => ({ pixels: (w, h, d) => rd().newPixels(w, h, new Uint8Array(d)), mask: (w, h, d) => { const id = rd().newMask(w, h); rd().bufferIO.write(id, new Uint8Array(d)); return id; } });

  // Renders a document that is not the open one and returns its full-size 8-bit RGBA; the open document
  // is put back on the engine afterwards.
  async function flatten(nested) {
    const r = rd();
    try { await r.sync(nested); const im = await r.image8(0, null); return { width: im.width, height: im.height, data: new Uint8Array(im.data.buffer, im.data.byteOffset, im.data.byteLength) }; }
    finally {
      if (ctx.store.doc) await r.sync(ctx.store.doc); else { ctx.engine?.setLayers([]); ctx.engine?.schedule(); }
      for (const l of nested.layers) if (l.file && !ctx.store.doc?.layers.some((x) => x.file === l.file)) r.dropFile?.(l.kind, l.file);
    }
  }
  async function hashOf(s, path) {
    const side = await s.exists(sidecarPath(path)) ? await s.readBinary(sidecarPath(path)) : null;
    return linkedHash(await s.readBinary(path), side);
  }
  // The source document of a smart object, ready to render.
  async function sourceOf(l) {
    if (l.smart.kind === 'linked') return (await photoDocument(ctx, l.smart.path)).doc;
    return unpackEmbedded(l.smart, make());
  }
  const needSmart = (id) => { const l = needLayer(ctx, id); if (!l.smart) fail('unsupported', `${l.name} is not a smart object`, 'change_target', 'check_smart_objects'); return l; };

  // P12: the chosen layers become one embedded smart object at their place in the stack.
  bus.register('smart.convert', async (a) => {
    const doc = needDoc(ctx); const T = 'convert_to_smart_object';
    const picked = doc.layers.filter((l) => a.layerIds.includes(l.id));
    if (picked.length !== new Set(a.layerIds).size) fail('invalid', 'every layerId must name a layer in the document', 'get_state', 'get_state');
    for (const l of picked) {
      if (l.kind === 'group' || l.localOf || l.retouchOf || doc.layers.some((x) => x.parentId === l.id)) fail('unsupported', `${l.name}: groups, local adjustments and retouch layers stay with their photo; pick the photo or pixel layers`, 'fix_argument', T);
      if (l.kind === 'adjustment') fail('unsupported', `${l.name} is an adjustment layer; a smart object holds content layers`, 'fix_argument', T);
    }
    // The photo's own local adjustments and retouch layer go along with it.
    const ids = new Set(picked.map((l) => l.id));
    for (const l of doc.layers) if (ids.has(l.localOf) || ids.has(l.retouchOf)) ids.add(l.id);
    const inner = doc.layers.filter((l) => ids.has(l.id)).map((l) => { const c = structuredClone(l); delete c.parentId; return c; });
    const nested = newDocument({ width: doc.width, height: doc.height, background: 'transparent', title: `${picked.at(-1).name} (smart object)` });
    nested.layers = inner; nested.activeLayerId = inner.at(-1).id;
    const smart = await packEmbedded(nested, io());
    const im = await flatten(nested);
    const buffer = rd().newPixels(im.width, im.height, im.data);
    const top = doc.layers.filter((l) => ids.has(l.id)).at(-1);
    const layer = makeLayer('raster', { name: `${picked.at(-1).name} · smart`, buffer, width: im.width, height: im.height, smart, ...(top.parentId ? { parentId: top.parentId } : {}) });
    await change(ctx, T, (d) => {
      const at = d.layers.findIndex((l) => l.id === top.id);
      d.layers.splice(at + 1, 0, layer);
      d.layers = d.layers.filter((l) => !ids.has(l.id));
      d.activeLayerId = layer.id;
    });
    return { layer: layerRow(ctx.store.doc.layers.find((l) => l.id === layer.id)), smart: { kind: 'embedded', layers: inner.length, buffers: Object.keys(smart.buffers).length } };
  });

  // P12 / P13: a workspace photo placed as a smart object, embedded (its develop settings frozen into the
  // layer's source) or linked (the photo and its sidecar followed by hash).
  bus.register('smart.place', async (a) => {
    const doc = needDoc(ctx); const s = store(); const T = 'place_smart_object';
    if (!photoKind(a.path)) fail('unsupported', `${a.path} is not a RAW or browser image`, 'fix_argument', T);
    const { doc: nested } = await photoDocument(ctx, a.path);
    const im = await flatten(nested);
    const smart = a.linked ? { kind: 'linked', width: im.width, height: im.height, path: a.path, hash: await hashOf(s, a.path) } : await packEmbedded(nested, io());
    const buffer = rd().newPixels(im.width, im.height, im.data);
    const layer = makeLayer('raster', { name: `${baseName(a.path)} · ${a.linked ? 'linked' : 'smart'}`, buffer, width: im.width, height: im.height, smart, matrix: [1, 0, 0, 1, Math.round((doc.width - im.width) / 2), Math.round((doc.height - im.height) / 2)] });
    await change(ctx, T, (d) => { const i = d.layers.findIndex((l) => l.id === d.activeLayerId); d.layers.splice(i < 0 ? d.layers.length : i + 1, 0, layer); d.activeLayerId = layer.id; });
    return { layer: layerRow(ctx.store.doc.layers.find((l) => l.id === layer.id)), smart: { kind: smart.kind, width: im.width, height: im.height, ...(a.linked ? { path: a.path, hash: smart.hash } : {}) } };
  });

  // P13: which linked smart objects changed on disk since they were placed or last updated.
  bus.register('smart.check', async () => {
    const doc = needDoc(ctx); const s = store(); const out = [];
    for (const l of doc.layers.filter((x) => x.smart)) {
      if (l.smart.kind !== 'linked') { out.push({ layerId: l.id, name: l.name, kind: 'embedded' }); continue; }
      const exists = await s.exists(l.smart.path);
      out.push({ layerId: l.id, name: l.name, kind: 'linked', path: l.smart.path, missing: !exists, changed: exists ? (await hashOf(s, l.smart.path)) !== l.smart.hash : false });
    }
    return { smartObjects: out, changed: out.filter((x) => x.changed).length };
  });

  // Re-renders a smart object from its source (for a linked one, the photo as it is now) into its pixel
  // source; the matrix (placement and transforms) stays.
  bus.register('smart.update', async (a) => {
    const l = needSmart(a.layerId); const s = store();
    let hash = null;
    if (l.smart.kind === 'linked') {
      if (!(await s.exists(l.smart.path))) fail('invalid', `the linked photo ${l.smart.path} is missing`, 'change_target', 'check_smart_objects');
      hash = await hashOf(s, l.smart.path);
    }
    const changed = hash ? hash !== l.smart.hash : null; const kind = l.smart.kind;
    const im = await flatten(await sourceOf(l));
    const same = im.width === l.width && im.height === l.height;
    const buffer = same ? l.buffer : rd().newPixels(im.width, im.height, im.data);
    await change(ctx, 'update_smart_object', (d) => {
      const x = d.layers.find((y) => y.id === l.id);
      if (same) rd().bufferIO.write(l.buffer, im.data);
      else { x.buffer = buffer; x.width = im.width; x.height = im.height; }
      x.smart = { ...x.smart, width: im.width, height: im.height, ...(hash ? { hash } : {}) };
    }, same ? [l.buffer] : []);
    return { layer: layerRow(ctx.store.doc.layers.find((y) => y.id === l.id)), kind, changed, size: [im.width, im.height] };
  });
}
