// Renderer: keeps the tessella engine in step with the document. It creates engine sources lazily from
// layer descriptions (files read through the storage adapter, text, fill colours), owns the buffers
// (mask bitmaps and raster pixels) that layers reference by id, and maps document layers to engine
// layers. It also turns engine output into previews, histograms, samples and 8-bit or 16-bit exports.

import { hexToLinear2020 } from './document.js';
import { decodePng } from './files/png.js';
import { displaceFor } from './files/warp.js';
import { usesVectorSource, vectorSourceKey, createVectorSource, vectorMaskFor, wrapArtboards } from './vector/render.js';

export const BROWSER_IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'];
const M2020_709 = [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]];
const oetf = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

const RANGE = { exposure: [-5, 5] };
export function addDelta(dev = {}, delta = {}) {
  const out = { ...dev };
  for (const [k, v] of Object.entries(delta)) { const [lo, hi] = RANGE[k] || [-100, 100]; out[k] = Math.min(hi, Math.max(lo, (out[k] ?? 0) + v)); }
  return out;
}

export function createRenderer({ engine, storage }) {
  const sources = new Map();   // source key → { id, width, height }
  const buffers = new Map();   // buffer id → { kind: 'mask' | 'pixels', engineId, width, height }
  let nextBuf = 1;
  let store = storage;

  async function sourceFor(l) {
    let key;
    if (usesVectorSource(l)) { key = vectorSourceKey(l); vec.sources.add(key); }   // shape layers, rich text (src/vector)
    else if (l.kind === 'raw' && l.buffer) key = `buf:${l.buffer}`;   // linear float source (an HDR merge), held in a buffer
    else if (l.kind === 'raw' || l.kind === 'image') key = `${l.kind}:${l.file}`;
    else if (l.kind === 'raster') key = `buf:${l.buffer}`;
    else if (l.kind === 'text') key = `text:${JSON.stringify(l.text)}`;
    else if (l.kind === 'fill') key = `fill:${l.color}`;
    else throw new Error(`unknown layer kind ${l.kind}`);
    if (sources.has(key)) return sources.get(key);
    let s;
    if (usesVectorSource(l)) s = await createVectorSource(engine, l);
    else if (l.kind === 'raw' && l.buffer) { const b = buffers.get(l.buffer); if (b?.kind !== 'linear') throw new Error(`layer ${l.name}: buffer ${l.buffer} is not a linear float source`); s = { id: b.engineId, width: b.width, height: b.height, asShot: b.asShot }; }
    else if (l.kind === 'raw') s = await engine.createRawSource(await store().readBinary(l.file));
    else if (l.kind === 'image') s = await engine.createImageSource(new Blob([await store().readBinary(l.file)]));
    else if (l.kind === 'raster') { const b = buffers.get(l.buffer); s = { id: b.engineId, width: b.width, height: b.height }; }
    else if (l.kind === 'text') s = engine.createTextSource({ content: l.text.content, ...l.text.style });
    else s = engine.createSolidSource(hexToLinear2020(l.color));
    const entry = { id: s.id, width: s.width, height: s.height, meta: s.meta, asShot: s.asShot };
    sources.set(key, entry);
    return entry;
  }

  function engineMask(mask) {
    if (!mask) return null;
    return { ...mask, components: mask.components.map((c) => (c.kind === 'bitmap' ? { ...c, bitmap: buffers.get(c.bitmap).engineId }
      : c.kind === 'depth' && c.depthFile ? { op: c.op, kind: 'depth', depth: depthFiles.get(c.depthFile), p0: c.p0 } : c)) };
  }

  // Vector masks and vector sources (src/vector/render.js): engine masks keyed by content, dropped when
  // a sync no longer uses them.
  const vec = { cache: new Map(), masks: new Map(), used: new Set(), sources: new Set(), docW: 0, docH: 0,
    upload(key, data, w, h) {
      vec.used.add(key);
      let m = vec.masks.get(key);
      if (!m || m.w !== w || m.h !== h) { if (m) engine.dropMask(m.id); m = { id: engine.createMaskBitmap(w, h, 0).id, w, h, data: null }; vec.masks.set(key, m); }
      if (m.data !== data) { engine.writeMaskBitmap(m.id, data); m.data = data; }
      return m.id;
    },
    bitmapData: (engineId) => engine.mask(engineId)?.data,
    maskVersion: (engineId) => engine.mask(engineId)?.version,
  };
  const vmask = (l, s, mask) => (l.vectorMask ? vectorMaskFor(vec, l, s, mask) : mask);

  async function sync(doc) {
    if (!doc) return null;
    vec.used.clear(); vec.sources.clear(); vec.docW = doc.width; vec.docH = doc.height;
    // Model depth maps (src/handlers/ai.js) live in the workspace as <photo>.depth.png; load each one once.
    for (const l of doc.layers) {
      for (const p of [l.lensBlur?.depth?.file, ...(l.mask?.components || []).map((c) => c.depthFile)]) if (p) await depthFromFile(p);
    }
    async function leaf(l0) {
      let l = l0;
      if (l0.localOf) {   // local adjustment: the base photo's settings plus the local deltas, masked
        const base = doc.layers.find((x) => x.id === l0.localOf);
        if (!base) return null;
        l = { ...base, id: l0.id, mask: l0.mask, visible: l0.visible && base.visible, opacity: l0.opacity, blend: 'normal', develop: addDelta(base.develop, l0.localDelta) };
      }
      if (l.kind === 'adjustment') {
        return { id: l.id, adjustment: await iccProof(l.adjustment), opacity: l.opacity, fill: l.fill, blend: l.blend, visible: l.visible, mask: vmask(l, null, engineMask(l.mask)), clipped: !!l.clipped };
      }
      const s = await sourceFor(l);
      const lut = l.kind === 'raw' && l.lut ? { id: (await lutFor(l.lut.path)).id ?? await lutFor(l.lut.path), amount: l.lut.amount ?? 1 } : undefined;
      return { lut, id: l.id, source: s.id, matrix: l.matrix, opacity: l.opacity, fill: l.fill, blend: l.blend, visible: l.visible,
        develop: l.kind === 'raw' ? l.develop || {} : undefined, curve: l.kind === 'raw' ? l.curve : undefined,
        mixer: l.kind === 'raw' ? l.mixer : undefined, grading: l.kind === 'raw' ? l.grading : undefined, mask: vmask(l, s, engineMask(l.mask)),
        clipped: !!l.clipped, ...(l.quad ? { quad: l.quad, matrix: undefined } : {}), lensBlur: await lensFor(l, s),
        lensProfile: l.kind === 'raw' ? l.lensProfile?.engine : undefined, styles: l.styles || undefined, displace: displaceFor(engine, l, s) };
    }
    // Groups nest through parentId; children keep their stack order.
    async function build(parentId) {
      const out = [];
      for (const l of doc.layers.filter((x) => (x.parentId ?? null) === parentId)) {
        if (l.kind === 'group') {
          const children = await build(l.id);
          if (children.length) out.push({ id: l.id, group: true, children, isolation: l.isolation || 'pass-through', opacity: l.opacity, blend: l.blend, visible: l.visible, mask: engineMask(l.mask) });
        } else { const e = await leaf(l); if (e) out.push(e); }
      }
      return out;
    }
    const top = await build(null);
    const owner = new Map(doc.layers.map((l) => [l.id, l]));
    const list = await wrapArtboards(doc, top.map((entry) => ({ layer: owner.get(entry.id), entry })), async (a) => ({
      id: `artboard-bg:${a.id}`, source: (await sourceFor({ kind: 'fill', color: a.background })).id, matrix: [1, 0, 0, 1, 0, 0], opacity: 1, fill: 1, blend: 'normal', visible: true, mask: null }));
    for (const [k, m] of vec.masks) if (!vec.used.has(k)) { engine.dropMask(m.id); vec.masks.delete(k); }
    // A coverage V stays cached while it is uploaded (v:key) or while a used baked mask (d:layer, stamp
    // ending in :key) was built from it; otherwise every sync of a baked vector mask rebuilt V.
    const bakedFrom = new Set([...vec.used].filter((k) => k.startsWith('d:')).map((k) => vec.cache.get(k)?.stamp).filter(Boolean));
    const feeds = (k) => [...bakedFrom].some((st) => st.endsWith(`:${k}`));
    for (const k of vec.cache.keys()) if (!vec.used.has(`v:${k}`) && !vec.used.has(k) && !feeds(k)) vec.cache.delete(k);
    for (const [k, e] of sources) if ((k.startsWith('shape:') || k.startsWith('richtext:')) && !vec.sources.has(k)) { engine.dropSource(e.id); sources.delete(k); }
    engine.setDocument({ width: doc.width, height: doc.height, blendSpace: doc.blendSpace });
    engine.setLayers(list);
    // Depth maps replaced since the last sync: the engine no longer references them after setLayers.
    for (const id of staleDepth.splice(0)) engine.dropMask(id);
    return engine.schedule();
  }

  // Buffers
  function newMask(width, height, fill = 0) {
    const m = engine.createMaskBitmap(width, height, fill);
    const id = `mask${nextBuf++}`;
    buffers.set(id, { kind: 'mask', engineId: m.id, width, height });
    return id;
  }
  function newPixels(width, height, pixels = new Uint8Array(width * height * 4)) {
    const s = engine.createPixelSource(pixels, width, height);
    const id = `px${nextBuf++}`;
    buffers.set(id, { kind: 'pixels', engineId: s.id, width, height });
    return id;
  }
  // Linear float source (HDR merge result): float32 linear RGB, developed like a RAW. colour: { camToRec2020,
  // camXyz, gains, scale } as tessella's createLinearSource takes them; data keeps values above 1.0.
  async function newLinear(width, height, data, colour = {}) {
    const s = await engine.createLinearSource({ width, height, data, ...colour });
    const id = `lin${nextBuf++}`;
    buffers.set(id, { kind: 'linear', engineId: s.id, width, height, asShot: s.asShot, colour: structuredClone(colour) });
    return id;
  }
  const bufferData = (id) => { const b = buffers.get(id); if (!b) return null; return b.kind === 'mask' ? engine.mask(b.engineId).data : b.kind === 'linear' ? engine.source(b.engineId).data : engine.source(b.engineId).pixels; };
  function writeBuffer(id, data) {
    const b = buffers.get(id); if (!b) return;
    if (b.kind === 'linear') return;   // linear sources are never edited in place, so undo has nothing to restore
    if (b.kind === 'mask') engine.writeMaskBitmap(b.engineId, data);
    else { engine.source(b.engineId).pixels.set(data); engine.updatePixelSource(b.engineId); }
  }
  const bufferIO = { read: (id) => { const d = bufferData(id); return d ? d.slice() : null; }, write: writeBuffer };

  // Size of a layer's source in source pixels.
  async function sourceSize(l) { const s = await sourceFor(l); return { width: s.width, height: s.height, meta: s.meta, asShot: s.asShot }; }

  // Model depth maps: workspace path → engine mask id (8-bit grey PNG, disparity, 255 nearest).
  const depthFiles = new Map();
  async function depthFromFile(path) {
    if (!depthFiles.has(path)) {
      const png = await decodePng(await store().readBinary(path));
      const plane = png.channels === 1 ? png.data : png.data.filter((_, i) => i % png.channels === 0);
      depthFiles.set(path, engine.createDepthMap({ width: png.width, height: png.height, data: Uint8Array.from(plane) }).id);
    }
    return depthFiles.get(path);
  }
  // Forgets a depth map file (rewritten by a recompute) and frees its engine bitmap at the next sync, once
  // the layer list that may still point at it has been replaced.
  const staleDepth = [];
  const dropDepth = (path) => { const id = depthFiles.get(path); if (id === undefined) return false; staleDepth.push(id); depthFiles.delete(path); return true; };

  // Lens blur depth: a linear ramp between two document points, built as a source-sized bitmap (cached by shape).
  // Soft proof through a person's ICC profile (src/handlers/print.js): the layer stores { model: 'icc', profile,
  // intent }; the engine takes the 17³ proof table LittleCMS builds from it (src/files/cms.js), one per profile and
  // intent (the same table object each time, so the engine uploads it once).
  const proofTables = new Map();
  async function iccProof(adj) {
    const P = adj?.type === 'proof' ? adj.params : null;
    if (P?.model !== 'icc') return adj;
    const key = `${P.profile}|${P.intent ?? 'relative'}`;
    if (!proofTables.has(key)) {
      const { iccProofTable } = await import('./files/cms.js');
      proofTables.set(key, await iccProofTable(await store().readBinary(P.profile), { intent: P.intent ?? 'relative', size: 17 }));
    }
    const t = proofTables.get(key);
    return { type: 'proof', params: { model: 'icc', size: t.size, table: t.table, warning: !!P.warning, ...(P.warningColour ? { warningColour: P.warningColour } : {}) } };
  }

  const depths = new Map();
  async function lensFor(l, s) {
    const lb = l.lensBlur; if (!lb) return undefined;
    const inv = (await import('../vendor/tessella/src/model.js')).invertAffine(l.matrix);
    const toSrc = ([x, y]) => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]];
    if (lb.depth.file) {   // a model depth map: any size, the engine stretches it over the source
      return { depthMask: await depthFromFile(lb.depth.file), aperture: lb.aperture, maxRadius: lb.maxRadius,
        ...(lb.focusPoint ? { focusPoint: toSrc(lb.focusPoint) } : { focus: lb.focus ?? 0.5 }) };
    }
    const from = toSrc(lb.depth.from); const to = toSrc(lb.depth.to);
    const key = JSON.stringify([s.id, from, to]);
    if (!depths.has(key)) depths.set(key, engine.createDepthRamp(s.width, s.height, { from, to }).id);
    return { depthMask: depths.get(key), aperture: lb.aperture, maxRadius: lb.maxRadius,
      ...(lb.focusPoint ? { focusPoint: toSrc(lb.focusPoint) } : { focus: lb.focus ?? 0.5 }) };
  }

  const luts = new Map();   // workspace path → engine LUT id
  async function lutFor(path) {
    if (!luts.has(path)) luts.set(path, engine.createLut(new TextDecoder().decode(await store().readBinary(path))));
    return luts.get(path);
  }

  // Document → display-encoded sRGB 8-bit RGBA (straight alpha) at a level of detail, over an optional rect.
  async function image8(lod, rect = null, background = null) {
    const im = await engine.renderImage(lod, rect);
    const px = new Uint8ClampedArray(im.width * im.height * 4);
    for (let i = 0; i < im.width * im.height; i++) {
      let r = im.data[i * 4]; let g = im.data[i * 4 + 1]; let b = im.data[i * 4 + 2]; let a = im.data[i * 4 + 3];
      if (background) { r += background * (1 - a); g += background * (1 - a); b += background * (1 - a); a = 1; }
      const k = a > 0 ? 1 / a : 0;
      const c = M2020_709.map((row) => row[0] * r * k + row[1] * g * k + row[2] * b * k);
      for (let j = 0; j < 3; j++) px[i * 4 + j] = Math.round(255 * oetf(Math.min(1, Math.max(0, c[j]))));
      px[i * 4 + 3] = Math.round(255 * a);
    }
    return { width: im.width, height: im.height, data: px, x: im.x, y: im.y, float: im };
  }

  // Smallest lod whose image fits maxEdge, never below 0.
  const lodFor = (doc, maxEdge) => Math.max(0, Math.floor(Math.log2(Math.max(doc.width, doc.height) / maxEdge)));

  async function encode(im, type, quality) {
    const oc = new OffscreenCanvas(im.width, im.height);
    oc.getContext('2d').putImageData(new ImageData(im.data, im.width, im.height), 0, 0);
    return new Uint8Array(await (await oc.convertToBlob({ type, quality })).arrayBuffer());
  }

  async function resize(im, maxEdge) {
    const k = Math.min(1, maxEdge / Math.max(im.width, im.height));
    if (k >= 1) return im;
    const w = Math.max(1, Math.round(im.width * k)); const h = Math.max(1, Math.round(im.height * k));
    const src = new OffscreenCanvas(im.width, im.height); src.getContext('2d').putImageData(new ImageData(im.data, im.width, im.height), 0, 0);
    const oc = new OffscreenCanvas(w, h); const c = oc.getContext('2d'); c.imageSmoothingQuality = 'high'; c.drawImage(src, 0, 0, w, h);
    return { width: w, height: h, data: c.getImageData(0, 0, w, h).data };
  }

  // Frees a file-backed source's GPU texture and CPU copy (after a batch, or when a file closes).
  function dropFile(kind, path) {
    const key = `${kind}:${path}`; const e = sources.get(key);
    if (!e) return false;
    engine.dropSource(e.id); sources.delete(key);
    return true;
  }

  return {
    sync, sourceSize, dropFile, dropDepth, vectorCache: vec.cache, newMask, newPixels, newLinear, bufferData, bufferIO, buffers, image8, lodFor, encode, resize,
    useStorage(fn) { store = fn; },
    get engine() { return engine; },
  };
}
