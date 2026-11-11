// tessella engine: a document-driven float renderer. The caller (Atelier, Slate) owns the document; it
// creates sources (RAW, image, solid, text, mask bitmaps) and hands the engine the layer list. Working
// space is linear Rec.2020 in rgba16float. Visible 256 px tiles are composited at a level of detail and
// cached by a signature of every layer that overlaps them, so any change re-renders only what it touches.
// Rendering is latest-wins.

import { createGpu, computePipeline, EngineError } from './gpu.js';
import { parseCube } from './lut.js';
import { decodeRaw, colourInfo } from './raw.js';
import { TILE, MAX_MASK, CURVE_N, U_SIZE, BLEND_MODES, UPLOAD_WGSL, COMPOSITE_WGSL, DISPLAY_WGSL, DEV_LIN_WGSL, DEV_NR_WGSL, DEV_SHARP_WGSL, DEV_GRID_WGSL, DEV_GBLUR_WGSL, DEV_TONE_WGSL, lensWgsl } from './shaders.js';
import { curveLuts, developPlan, DEV_FLOATS, DEVELOP_RENDERED, invertAffine, layerBounds, MASK_KINDS, MASK_OPS, adjustmentPlan, quadInverse, quadBounds, lensPlan } from './model.js';

export { BLEND_MODES };
export const MAX_LOD = 5;
export const MAX_GROUP_DEPTH = 8;
const SLICES = 256;
const BATCH = 64; // tiles per dispatch; each group nesting level has a scratch pair of this many slices
const ISOLATION = ['pass-through', 'isolated'];

export async function createEngine({ canvas } = {}) {
  const gpu = await createGpu();
  const { device } = gpu;
  let lost = null;
  device.lost.then((info) => { lost = info; });

  const pipes = {
    upload: computePipeline(device, UPLOAD_WGSL, 'upload'),
    composite: computePipeline(device, COMPOSITE_WGSL, 'composite'),
  };
  // Develop passes use explicit layouts: their rgba32float inputs are unfilterable.
  const BIND = {
    tex: { texture: { sampleType: 'unfilterable-float' } },
    st32: { storageTexture: { access: 'write-only', format: 'rgba32float' } },
    st16: { storageTexture: { access: 'write-only', format: 'rgba16float' } },
    uni: { buffer: { type: 'uniform' } },
    ro: { buffer: { type: 'read-only-storage' } },
  };
  function explicitPipe(code, label, kinds) {
    const layout = device.createBindGroupLayout({ entries: kinds.map((k, i) => ({ binding: i, visibility: GPUShaderStage.COMPUTE, ...BIND[k] })), label });
    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: device.createShaderModule({ code, label }), entryPoint: 'main' }, label,
    });
    return { pipeline, layout };
  }
  const devPipes = {
    lin: explicitPipe(DEV_LIN_WGSL, 'dev-lin', ['tex', 'st32', 'uni']),
    nr: explicitPipe(DEV_NR_WGSL, 'dev-nr', ['tex', 'st32', 'uni']),
    sharp: explicitPipe(DEV_SHARP_WGSL, 'dev-sharp', ['tex', 'st32', 'uni']),
    grid: explicitPipe(DEV_GRID_WGSL, 'dev-grid', ['tex', 'st32', 'uni']),
    gblur: explicitPipe(DEV_GBLUR_WGSL, 'dev-gblur', ['tex', 'st32', 'uni']),
    tone: explicitPipe(DEV_TONE_WGSL, 'dev-tone', ['tex', 'st16', 'uni', 'ro', 'tex', 'ro']),
    lens: explicitPipe(lensWgsl('rgba32float'), 'dev-lens', ['tex', 'st32', 'uni', 'tex']),
    lensImg: explicitPipe(lensWgsl('rgba16float'), 'image-lens', ['tex', 'st16', 'uni', 'tex']),
  };
  let ctx = null; let display = null;
  if (canvas) {
    const format = navigator.gpu.getPreferredCanvasFormat();
    ctx = canvas.getContext('webgpu');
    ctx.configure({ device, format, alphaMode: 'opaque' });
    const dmod = device.createShaderModule({ code: DISPLAY_WGSL, label: 'display' });
    display = device.createRenderPipeline({
      layout: 'auto', vertex: { module: dmod, entryPoint: 'vs' },
      fragment: { module: dmod, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' },
    });
  }

  const TU = GPUTextureUsage;
  const tileUsage = TU.TEXTURE_BINDING | TU.STORAGE_BINDING | TU.COPY_SRC | TU.COPY_DST;
  const tilesA = device.createTexture({ size: [TILE, TILE, SLICES], format: 'rgba16float', usage: tileUsage, label: 'tilesA' });
  const tilesB = device.createTexture({ size: [TILE, TILE, SLICES], format: 'rgba16float', usage: tileUsage, label: 'tilesB' });
  const viewA = tilesA.createView({ dimension: '2d-array' });
  const viewB = tilesB.createView({ dimension: '2d-array' });
  const dummyTex = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: TU.TEXTURE_BINDING });
  const dummyMask = device.createTexture({ size: [1, 1], format: 'r8unorm', usage: TU.TEXTURE_BINDING });
  const dummyGrid = device.createTexture({ size: [1, 1], format: 'rgba32float', usage: TU.TEXTURE_BINDING });
  const dummyTiles = device.createTexture({ size: [1, 1, 1], format: 'rgba16float', usage: TU.TEXTURE_BINDING }).createView({ dimension: '2d-array' });
  // Scratch tile arrays for group nesting level d (1-based), allocated on first use: BATCH slices each.
  const scratchLevels = [];
  const scratchLevel = (d) => {
    if (d > MAX_GROUP_DEPTH) throw new EngineError('unsupported', `groups nest at most ${MAX_GROUP_DEPTH} deep`, 'flatten the outer groups');
    while (scratchLevels.length < d) {
      const k = scratchLevels.length + 1;
      const A = device.createTexture({ size: [TILE, TILE, BATCH], format: 'rgba16float', usage: tileUsage, label: `groupA${k}` });
      const B = device.createTexture({ size: [TILE, TILE, BATCH], format: 'rgba16float', usage: tileUsage, label: `groupB${k}` });
      scratchLevels.push({ A, B, vA: A.createView({ dimension: '2d-array' }), vB: B.createView({ dimension: '2d-array' }) });
    }
    return scratchLevels[d - 1];
  };
  // Clipping: per nesting level d (0 = top), one alpha slice per tile of a chunk (BATCH), allocated on first use.
  const clipLevels = [];
  const clipLevel = (d) => {
    if (!clipLevels[d]) {
      const T = device.createTexture({ size: [TILE, TILE, BATCH], format: 'rgba16float', usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING, label: `clip${d}` });
      clipLevels[d] = T.createView({ dimension: '2d-array' });
    }
    return clipLevels[d];
  };
  const dummyClipW = device.createTexture({ size: [1, 1, 1], format: 'rgba16float', usage: TU.STORAGE_BINDING }).createView({ dimension: '2d-array' });
  // Adjustment-layer buffers, one set per adjustment dispatch in a render (pooled like the layer uniforms).
  const pool = (size, usage) => { const list = []; return (i) => { while (list.length <= i) list.push(device.createBuffer({ size, usage })); return list[i]; }; };
  const SB = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST; const UB = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
  const adjPool = pool(64 * 4, SB); const adjCurvePool = pool(4 * CURVE_N * 4, SB); const adjDevPool = pool(DEV_FLOATS * 4, UB);
  const dummyAdj = device.createBuffer({ size: 64 * 4, usage: SB });
  const dummyDev = device.createBuffer({ size: DEV_FLOATS * 4, usage: UB });
  const identityCurve = device.createBuffer({ size: 4 * CURVE_N * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(identityCurve, 0, curveLuts(null));
  const uniformPool = [];
  const uniformAt = (i) => {
    while (uniformPool.length <= i) uniformPool.push(device.createBuffer({ size: U_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    return uniformPool[i];
  };
  const displayUniform = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  const S = {
    doc: null,            // { width, height, blendSpace }
    sources: new Map(),   // id → { id, kind, width, height, tex, data?, scale?, color?, pixels? }
    masks: new Map(),     // id → { id, width, height, tex, data: Uint8Array }
    developed: new Map(), // develop key (source + settings) → { tex, used }
    luts: new Map(),      // id → parsed .cube ({ kind, size, domainMin, domainMax, data, title }) + buf
    layers: [],           // render layers, bottom first (see model.js)
    view: { fit: true },
    cache: new Map(),
    free: Array.from({ length: SLICES }, (_, i) => SLICES - 1 - i),
    tick: 0, nextId: 1, stats: null, developCount: 0,
  };
  const newId = (p) => `${p}${S.nextId++}`;

  // ---- sources ----------------------------------------------------------------------------------
  async function createRawSource(bytes) {
    const dec = await decodeRaw(bytes);
    const { width, height, data } = dec;
    const colour = colourInfo(dec.meta);
    const tex = device.createTexture({ size: [width, height], format: 'rgba16float', usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING, label: 'raw' });
    const scale = 1 / 65535;
    const rowsPerBand = Math.max(1, Math.floor((32 << 20) / (width * 6)));
    const ubuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    let sbuf = null;
    for (let row = 0; row < height; row += rowsPerBand) {
      const rows = Math.min(rowsPerBand, height - row);
      const n = width * rows * 3;
      let band = data.subarray(row * width * 3, row * width * 3 + n);
      if (n & 1) { const padded = new Uint16Array(n + 1); padded.set(band); band = padded; }
      if (!sbuf || sbuf.size < band.byteLength) {
        sbuf?.destroy();
        sbuf = device.createBuffer({ size: band.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      }
      device.queue.writeBuffer(sbuf, 0, band.buffer, band.byteOffset, band.byteLength);
      const u = new ArrayBuffer(16);
      new Uint32Array(u, 0, 3).set([width, row, rows]);
      new Float32Array(u, 12, 1)[0] = scale;
      device.queue.writeBuffer(ubuf, 0, u);
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipes.upload);
      pass.setBindGroup(0, device.createBindGroup({
        layout: pipes.upload.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: sbuf } }, { binding: 1, resource: tex.createView() }, { binding: 2, resource: { buffer: ubuf } }],
      }));
      pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(rows / 16));
      pass.end();
      device.queue.submit([enc.finish()]);
    }
    await device.queue.onSubmittedWorkDone();
    sbuf?.destroy(); ubuf.destroy();
    const id = newId('raw');
    S.sources.set(id, { id, kind: 'raw', width, height, tex, data, scale, ...colour });
    // asShot: the camera's white balance as kelvin and tint (null when the camera has no cam_xyz matrix), and
    // its camera-space gains (min-normalised). camToRec2020 is LibRaw's own camera → Rec.2020 matrix.
    return { id, kind: 'raw', width, height, meta: dec.meta, decodeMs: dec.decodeMs, asShot: colour.asShot, camToRec2020: colour.camToRec2020 };
  }

  // Image sources keep an 8-bit sRGB copy on the CPU for the reference and for merges.
  // pixels: 8-bit sRGB RGBA, straight alpha. The engine keeps the array (callers may edit it and re-upload).
  function imageSourceFromPixels(pixels, width, height, label = 'image') {
    const tex = device.createTexture({ size: [width, height], format: 'rgba8unorm-srgb', usage: TU.TEXTURE_BINDING | TU.COPY_DST, label });
    device.queue.writeTexture({ texture: tex }, pixels, { bytesPerRow: width * 4 }, [width, height]);
    const id = newId('img');
    S.sources.set(id, { id, kind: 'image', width, height, tex, pixels });
    return { id, kind: 'image', width, height };
  }

  async function createImageSource(blob) {
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const oc = new OffscreenCanvas(bmp.width, bmp.height);
    const c2 = oc.getContext('2d', { colorSpace: 'srgb' });
    c2.drawImage(bmp, 0, 0);
    const pixels = new Uint8Array(c2.getImageData(0, 0, bmp.width, bmp.height).data.buffer);
    bmp.close();
    return imageSourceFromPixels(pixels, oc.width, oc.height);
  }

  // Text: rasterised by the browser's text engine (spec 002 open question: browser APIs in v1.0).
  function createTextSource({ content, font = 'system-ui', size = 64, color = '#000000', align = 'left', lineHeight = 1.2, bold = false, italic = false }) {
    const lines = String(content).split('\n');
    const css = `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${size}px ${font}`;
    const probe = new OffscreenCanvas(1, 1).getContext('2d');
    probe.font = css;
    const w = Math.max(1, Math.ceil(Math.max(...lines.map((l) => probe.measureText(l).width)) + size * 0.2));
    const lh = Math.ceil(size * lineHeight);
    const h = Math.max(1, lh * lines.length + Math.ceil(size * 0.3));
    const oc = new OffscreenCanvas(w, h);
    const c2 = oc.getContext('2d', { colorSpace: 'srgb' });
    c2.font = css; c2.fillStyle = color; c2.textBaseline = 'top';
    c2.textAlign = align === 'justify' ? 'left' : align;
    const x = align === 'center' ? w / 2 : align === 'right' ? w - size * 0.1 : size * 0.1;
    lines.forEach((l, i) => c2.fillText(l, x, i * lh + size * 0.1));
    const pixels = new Uint8Array(c2.getImageData(0, 0, w, h).data.buffer);
    return imageSourceFromPixels(pixels, w, h, 'text');
  }

  function createSolidSource(color) {
    const id = newId('solid');
    S.sources.set(id, { id, kind: 'solid', width: 1, height: 1, tex: null, color: [...color] });
    return { id, kind: 'solid', width: 1, height: 1 };
  }

  function updatePixelSource(id, x = 0, y = 0, w, h) {
    const s = S.sources.get(id);
    if (!s || s.kind !== 'image') throw new EngineError('invalid', `no image source ${id}`, 'create it first');
    w = w ?? s.width; h = h ?? s.height;
    const sub = new Uint8Array(w * h * 4);
    for (let j = 0; j < h; j++) sub.set(s.pixels.subarray(((y + j) * s.width + x) * 4, ((y + j) * s.width + x + w) * 4), j * w * 4);
    device.queue.writeTexture({ texture: s.tex, origin: [x, y] }, sub, { bytesPerRow: w * 4 }, [w, h]);
    s.version = (s.version || 0) + 1;
  }

  // ---- LUTs ---------------------------------------------------------------------------------------
  // .cube text → a LUT a RAW layer can use with `lut: { id, amount }` (amount 0..1, default 1).
  function createLut(text) {
    let l;
    try { l = parseCube(text); } catch (e) { throw new EngineError(e.code || 'invalid', `LUT: ${e.message}`, 'check the .cube file'); }
    const buf = device.createBuffer({ size: l.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'lut' });
    device.queue.writeBuffer(buf, 0, l.data);
    const id = newId('lut');
    S.luts.set(id, { ...l, id, buf });
    return { id, kind: l.kind, size: l.size, title: l.title };
  }
  function dropLut(id) { S.luts.get(id)?.buf.destroy(); S.luts.delete(id); }

  function dropSource(id) {
    const s = S.sources.get(id); s?.tex?.destroy(); S.sources.delete(id);
    for (const [k, e] of S.developed) if (k.startsWith(`${id}|`)) { e.tex.destroy(); S.developed.delete(k); }
  }

  // ---- mask bitmaps (layer-local, 8-bit) ---------------------------------------------------------
  function createMaskBitmap(width, height, fill = 0) {
    const data = new Uint8Array(width * height).fill(fill);
    const tex = device.createTexture({ size: [width, height], format: 'r8unorm', usage: TU.TEXTURE_BINDING | TU.COPY_DST, label: 'mask' });
    const id = newId('mask');
    const m = { id, width, height, tex, data, version: 1 };
    S.masks.set(id, m);
    uploadMask(m, 0, 0, width, height);
    return { id, width, height };
  }
  function uploadMask(m, x, y, w, h) {
    if (w <= 0 || h <= 0) return;
    const sub = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) sub.set(m.data.subarray((y + j) * m.width + x, (y + j) * m.width + x + w), j * w);
    const bpr = Math.ceil(w / 256) * 256;
    const padded = new Uint8Array(bpr * h);
    for (let j = 0; j < h; j++) padded.set(sub.subarray(j * w, j * w + w), j * bpr);
    device.queue.writeTexture({ texture: m.tex, origin: [x, y] }, padded, { bytesPerRow: bpr }, [w, h]);
  }
  function writeMaskBitmap(id, data) {
    const m = S.masks.get(id);
    if (!m) throw new EngineError('invalid', `no mask ${id}`, 'create it first');
    m.data.set(data); m.version++;
    uploadMask(m, 0, 0, m.width, m.height);
  }
  // Round brush, spacing 25% of the size, flow and hardness in percent; layer-local coordinates.
  function paintMask(id, { points, size, hardness = 100, flow = 100, erase = false }) {
    const m = S.masks.get(id);
    if (!m) throw new EngineError('invalid', `no mask ${id}`, 'create it first');
    const r = size / 2; const hard = Math.min(0.999, hardness / 100); const fl = flow / 100;
    const stamps = [];
    for (let i = 0; i < points.length; i++) {
      const [x, y] = points[i];
      if (i === 0) { stamps.push([x, y]); continue; }
      const [px, py] = points[i - 1];
      const d = Math.hypot(x - px, y - py); const step = Math.max(1, size * 0.25);
      for (let t = step; t <= d; t += step) stamps.push([px + (x - px) * t / d, py + (y - py) * t / d]);
    }
    let x0 = m.width; let y0 = m.height; let x1 = 0; let y1 = 0;
    for (const [cx, cy] of stamps) {
      const bx0 = Math.max(0, Math.floor(cx - r)); const bx1 = Math.min(m.width - 1, Math.ceil(cx + r));
      const by0 = Math.max(0, Math.floor(cy - r)); const by1 = Math.min(m.height - 1, Math.ceil(cy + r));
      for (let yy = by0; yy <= by1; yy++) {
        for (let xx = bx0; xx <= bx1; xx++) {
          const dist = Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy) / r;
          if (dist >= 1) continue;
          const a = (dist <= hard ? 1 : 1 - (dist - hard) / (1 - hard)) * fl;
          const k = yy * m.width + xx; const v = m.data[k] / 255;
          m.data[k] = Math.round(255 * (erase ? v * (1 - a) : v + (1 - v) * a));
        }
      }
      x0 = Math.min(x0, bx0); y0 = Math.min(y0, by0); x1 = Math.max(x1, bx1); y1 = Math.max(y1, by1);
    }
    m.version++;
    if (x1 >= x0 && y1 >= y0) uploadMask(m, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    return { stamps: stamps.length, bounds: [x0, y0, x1, y1] };
  }

  // A synthetic depth bitmap for tests: disparity rises linearly from 0 at `from` to 255 at `to` (pixel centres
  // projected on the from → to line, clamped), so `to` is nearest. Returns the mask bitmap { id, width, height }.
  function createDepthRamp(width, height, { from = [0, 0], to = [0, height] } = {}) {
    const m = createMaskBitmap(width, height, 0);
    const dx = to[0] - from[0]; const dy = to[1] - from[1]; const L2 = dx * dx + dy * dy;
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const t = ((x + 0.5 - from[0]) * dx + (y + 0.5 - from[1]) * dy) / L2;
      data[y * width + x] = Math.round(255 * Math.min(1, Math.max(0, t)));
    }
    writeMaskBitmap(m.id, data);
    return m;
  }

  // ---- document and layers ----------------------------------------------------------------------
  function setDocument({ width, height, blendSpace = 'compatible' }) {
    const sized = !S.doc || S.doc.width !== width || S.doc.height !== height;
    S.doc = { width, height, blendSpace };
    if (sized) invalidateAll();
  }

  // layers: [{ id, source, matrix:[a,b,c,d,e,f], opacity, fill, blend, visible, develop?, curve?, mixer?, grading?, mask? }
  //          | { id, group: true, children: [...], isolation: 'pass-through' | 'isolated', opacity, blend, visible, mask? }]
  // matrix maps source pixels to document pixels: x' = a*x + c*y + e, y' = b*x + d*y + f. Lists are bottom first.
  // Groups (Photoshop semantics): isolated composites the children onto transparency, then the result as one
  // layer (blend, opacity, mask); pass-through composites the children onto a copy of the stack below, then
  // mixes it over the stack below by opacity × mask (blend is ignored). Group masks are in document
  // coordinates; bitmap components are refused. Groups have no fill.
  // Adjustment layers { id, adjustment: { type, params }, opacity, fill, blend, visible, mask?, clipped? } have no source:
  // they transform the composite below them in their stack (in a pass-through group, the parent's stack too) and
  // blend the result over it. Their masks are in document pixels (a bitmap component is read 1:1 in document
  // pixels). They touch every tile of their stack. clipped: true clips a layer to the alpha of the nearest unclipped
  // layer below it in its stack (alpha × mask × opacity, without fill); a pass-through group cannot be a base.
  // quad: [[x, y] × 4], document corners of the source rectangle (TL, TR, BR, BL), a perspective map instead of
  // matrix. lensBlur (RAW and image layers): { depthMask, focus | focusPoint, aperture, maxRadius, bokehShape: 'disc' }.
  function checkMask(l, mask) {
    for (const c of mask?.components || []) {
      if (!MASK_KINDS.includes(c.kind)) throw new EngineError('invalid', `layer ${l.id}: mask kind ${c.kind}`, `use one of ${MASK_KINDS.join(', ')}`);
      if (!MASK_OPS.includes(c.op)) throw new EngineError('invalid', `layer ${l.id}: mask op ${c.op}`, `use one of ${MASK_OPS.join(', ')}`);
      if (c.kind === 'colour-range' && !(Array.isArray(c.p0) && c.p0.length === 4 && c.p0.every(Number.isFinite) && c.p0[3] >= 0 && Number.isFinite(c.p1?.[0]) && c.p1[0] >= 0)) {
        throw new EngineError('invalid', `layer ${l.id}: colour-range needs p0 [L, a, b, tolerance >= 0] and p1 [feather >= 0]`, 'Oklab values of the target colour');
      }
    }
  }
  function linkClips(list) {
    let base = null;
    for (const l of list) {
      if (!l.clipped) { base = l; continue; }
      if (!base) throw new EngineError('invalid', `layer ${l.id}: clipped, but no layer below it to clip to`, 'unclip it or move it above a layer');
      if (base.group && base.isolation === 'pass-through') throw new EngineError('unsupported', `layer ${l.id}: clipping to a pass-through group`, 'make the group isolated');
      l.clipBase = base.id; base.hasClipped = true;
    }
    return list;
  }
  function setLayers(list) {
    const prep = (l, depth) => {
      const mask = l.mask?.components?.length ? l.mask : null;
      if (mask && mask.components.length > MAX_MASK) throw new EngineError('unsupported', `at most ${MAX_MASK} mask components`, 'combine components');
      checkMask(l, mask);
      if (l.adjustment) {
        if (l.source || l.group) throw new EngineError('invalid', `layer ${l.id}: an adjustment layer has no source and no children`, 'remove source or children');
        for (const c of mask?.components || []) if (c.kind === 'bitmap' && !S.masks.has(c.bitmap)) throw new EngineError('invalid', `no mask bitmap ${c.bitmap}`, 'create it first');
        if (mask && mask.components.filter((c) => c.kind === 'bitmap').length > 1) throw new EngineError('unsupported', 'one bitmap component per mask', 'merge painted components');
        let adj;
        try { adj = adjustmentPlan(l.adjustment); } catch (e) { throw new EngineError(e.code || 'invalid', `layer ${l.id}: ${e.message}`, 'check the adjustment parameters'); }
        const sig = JSON.stringify({ ...l, maskVersions: (mask?.components || []).filter((c) => c.kind === 'bitmap').map((c) => S.masks.get(c.bitmap).version) });
        return { ...l, mask, sig, adj, bounds: null, unbounded: true };
      }
      if (l.group) {
        if (!Array.isArray(l.children)) throw new EngineError('invalid', `group ${l.id}: children must be an array`, 'pass a list, bottom first');
        if (depth >= MAX_GROUP_DEPTH) throw new EngineError('unsupported', `groups nest at most ${MAX_GROUP_DEPTH} deep`, 'flatten the outer groups');
        const isolation = l.isolation ?? 'pass-through';
        if (!ISOLATION.includes(isolation)) throw new EngineError('invalid', `group ${l.id}: isolation ${isolation}`, `use one of ${ISOLATION.join(', ')}`);
        if (mask?.components.some((c) => c.kind === 'bitmap')) throw new EngineError('unsupported', `group ${l.id}: bitmap mask components on groups`, 'use linear, radial or luminance-range components, or mask the children');
        const children = linkClips(l.children.map((c) => prep(c, depth + 1)));
        const { children: _c, ...own } = l;
        const sig = JSON.stringify({ ...own, isolation });
        const bs = children.map((c) => c.bounds).filter(Boolean);
        const bounds = bs.length ? [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))] : null;
        return { ...l, isolation, children, mask, sig, bounds };
      }
      const src = S.sources.get(l.source);
      if (!src) throw new EngineError('invalid', `layer ${l.id}: no source ${l.source}`, 'create the source first');
      for (const c of mask?.components || []) if (c.kind === 'bitmap' && !S.masks.has(c.bitmap)) throw new EngineError('invalid', `no mask bitmap ${c.bitmap}`, 'create it first');
      if (mask && mask.components.filter((c) => c.kind === 'bitmap').length > 1) throw new EngineError('unsupported', 'one bitmap component per mask', 'merge painted components');
      let plan = null; let devKey = null; let quadInv = null; let lens = null;
      if (l.quad !== undefined) {
        if (l.matrix !== undefined) throw new EngineError('invalid', `layer ${l.id}: quad and matrix are mutually exclusive`, 'pass one of them');
        if (src.kind === 'solid') throw new EngineError('invalid', `layer ${l.id}: a solid layer has no rectangle to map`, 'remove quad');
        try { quadInv = quadInverse(l.quad, src.width, src.height); } catch (e) { throw new EngineError(e.code || 'invalid', `layer ${l.id}: ${e.message}`, 'pass a convex quad, corners clockwise from top-left'); }
      }
      if (l.lensBlur) {
        if (src.kind !== 'raw' && src.kind !== 'image') throw new EngineError('unsupported', `layer ${l.id}: lens blur on ${src.kind} layers`, 'use a RAW or image layer');
        const depth = S.masks.get(l.lensBlur.depthMask);
        if (!depth) throw new EngineError('invalid', `layer ${l.id}: no depth bitmap ${l.lensBlur.depthMask}`, 'create it with createMaskBitmap or createDepthRamp');
        try { lens = { ...lensPlan(l.lensBlur, depth, src.width, src.height), depth: depth.id, depthVersion: depth.version }; } catch (e) { throw new EngineError(e.code || 'invalid', `layer ${l.id}: ${e.message}`, 'check the lens blur settings'); }
        if (src.kind === 'image') devKey = `${src.id}|lens|${src.version || 0}|${JSON.stringify(lens)}`;
      }
      if (src.kind === 'raw') {
        const bad = Object.entries(l.develop || {}).filter(([k, v]) => v !== null && v !== undefined && !DEVELOP_RENDERED.includes(k)).map(([k]) => k);
        if (bad.length) throw new EngineError('unsupported', `layer ${l.id}: develop settings not rendered: ${bad.join(', ')}`, `use ${DEVELOP_RENDERED.join(', ')}`);
        let lut = null;
        if (l.lut) {
          lut = S.luts.get(l.lut.id);
          if (!lut) throw new EngineError('invalid', `layer ${l.id}: no LUT ${l.lut.id}`, 'create it with createLut');
          const amount = l.lut.amount ?? 1;
          if (!(amount >= 0 && amount <= 1)) throw new EngineError('invalid', `layer ${l.id}: LUT amount ${amount}`, 'use 0..1');
          lut = { ...lut, amount };
        }
        try { plan = developPlan(l.develop, { curve: l.curve, mixer: l.mixer, grading: l.grading, lut, lens }, src); } catch (e) { throw new EngineError(e.code || 'invalid', `layer ${l.id}: ${e.message}`, 'check the develop settings'); }
        devKey = `${src.id}|${JSON.stringify({ d: plan.settings, c: l.curve || null, m: l.mixer || null, g: l.grading || null, l: l.lut || null, b: lens })}`;
      }
      const sig = JSON.stringify({ ...l, srcVersion: src.version || 0, maskVersions: (mask?.components || []).filter((c) => c.kind === 'bitmap').map((c) => S.masks.get(c.bitmap).version), solid: src.color, lens });
      const bounds = src.kind === 'solid' ? [0, 0, S.doc.width, S.doc.height] : quadInv ? quadBounds(l.quad) : layerBounds(l.matrix, src.width, src.height);
      return { ...l, src, mask, sig, plan, devKey, quadInv, lens, bounds };
    };
    S.layers = linkClips(list.map((l) => prep(l, 0)));
  }
  function setView(view) { S.view = view; }
  function invalidateAll() { for (const e of S.cache.values()) S.free.push(e.slice); S.cache.clear(); }

  function viewFor(cw, ch, view) {
    const { width: W, height: H } = S.doc;
    let scale; let x0; let y0;
    if (view.fit) { scale = Math.min(cw / W, ch / H); x0 = -(cw / scale - W) / 2; y0 = -(ch / scale - H) / 2; }
    else { scale = view.scale; x0 = view.cx - cw / (2 * scale); y0 = view.cy - ch / (2 * scale); }
    const lod = view.lod ?? Math.max(0, Math.min(MAX_LOD, Math.floor(Math.log2(1 / scale) + 1e-9)));
    const span = TILE * 2 ** lod;
    const vx0 = Math.max(0, x0); const vy0 = Math.max(0, y0);
    const vx1 = Math.min(W, x0 + cw / scale); const vy1 = Math.min(H, y0 + ch / scale);
    const empty = vx1 <= vx0 || vy1 <= vy0;
    const tx0 = Math.floor(vx0 / span); const ty0 = Math.floor(vy0 / span);
    const tx1 = Math.floor((vx1 - 1e-6) / span); const ty1 = Math.floor((vy1 - 1e-6) / span);
    return { cw, ch, scale, x0, y0, lod, tx0, ty0, gw: empty ? 0 : tx1 - tx0 + 1, gh: empty ? 0 : ty1 - ty0 + 1 };
  }
  const computeView = () => viewFor(canvas.width, canvas.height, S.view);

  // The layers that touch tile (tx, ty), bottom first. A group survives when it is visible with opacity > 0 and
  // at least one child survives; it comes back as a copy whose `kids` are its surviving children.
  function layersFor(lod, tx, ty) {
    const span = TILE * 2 ** lod;
    const fx0 = tx * span; const fy0 = ty * span;
    const fx1 = Math.min(S.doc.width, fx0 + span); const fy1 = Math.min(S.doc.height, fy0 + span);
    // Adjustments touch every tile; an isolated group needs content (a non-adjustment layer) on the tile; a clipped
    // layer needs its base on the tile; a fill-0 layer survives only as a clipping base.
    const content = (k) => (k.group ? k.kids.some(content) : !k.adjustment);
    const cull = (list) => {
      const out = []; const kept = new Set();
      for (const l of list) {
        if (l.visible === false || !((l.opacity ?? 1) > 0)) continue;
        if (l.clipped && !kept.has(l.clipBase)) continue;
        if (l.group) {
          const kids = cull(l.children);
          if (l.isolation === 'isolated' ? kids.some(content) : kids.length) { out.push({ ...l, kids }); kept.add(l.id); }
          continue;
        }
        if (!((l.fill ?? 1) > 0 || l.hasClipped)) continue;
        if (l.unbounded || (l.bounds[0] < fx1 && l.bounds[2] > fx0 && l.bounds[1] < fy1 && l.bounds[3] > fy0)) { out.push(l); kept.add(l.id); }
      }
      return out;
    };
    return cull(S.layers);
  }
  const treeKey = (list, f) => list.map((l) => (l.group ? `${f(l)}{${treeKey(l.kids, f)}}` : f(l))).join('\n');
  const signature = (lod, tx, ty) => S.doc.blendSpace + '|' + treeKey(layersFor(lod, tx, ty), (l) => l.sig);

  // ---- develop cache: one developed texture per (source, develop settings) in use -------------------
  function rawLayers(list, out = []) {
    for (const l of list) {
      if (l.visible === false || !((l.opacity ?? 1) > 0)) continue;
      if (l.group) rawLayers(l.children, out); else if (l.devKey) out.push(l);
    }
    return out;
  }
  // Develops every visible RAW layer whose settings have no cached texture; drops textures no layer uses.
  // Called at the start of each render, so only the latest settings are ever developed (latest-wins).
  async function ensureDeveloped() {
    const need = new Map();
    for (const l of rawLayers(S.layers)) if (!need.has(l.devKey)) need.set(l.devKey, l);
    for (const [k, e] of S.developed) if (!need.has(k)) { e.tex.destroy(); S.developed.delete(k); }
    let n = 0;
    for (const [k, l] of need) {
      if (S.developed.has(k)) continue;
      S.developed.set(k, { tex: l.src.kind === 'raw' ? await runDevelop(l.src, l.plan, l.lut?.id) : await runLensImage(l.src, l.lens) });
      n++; S.developCount++;
    }
    return n;
  }
  async function runDevelop(src, plan, lutId) {
    const { width: W, height: H } = src;
    const tmp = [];
    const ub = device.createBuffer({ size: DEV_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); tmp.push(ub);
    device.queue.writeBuffer(ub, 0, plan.u);
    let cb = identityCurve;
    if (plan.curveLut) { cb = device.createBuffer({ size: 4 * CURVE_N * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(cb, 0, plan.curveLut); tmp.push(cb); }
    const scratch = () => { const t = device.createTexture({ size: [W, H], format: 'rgba32float', usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING, label: 'develop scratch' }); tmp.push(t); return t; };
    const out = device.createTexture({ size: [W, H], format: 'rgba16float', usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING | TU.COPY_SRC, label: 'developed' });
    const enc = device.createCommandEncoder();
    const pass = (p, resources, gx = Math.ceil(W / 16), gy = Math.ceil(H / 16)) => {
      const cp = enc.beginComputePass();
      cp.setPipeline(p.pipeline);
      cp.setBindGroup(0, device.createBindGroup({ layout: p.layout, entries: resources.map((r, i) => ({ binding: i, resource: r instanceof GPUBuffer ? { buffer: r } : r.createView() })) }));
      cp.dispatchWorkgroups(gx, gy);
      cp.end();
    };
    // Ping-pong between at most two rgba32float scratch textures.
    let cur = scratch(); let other = null;
    const step = (p) => { other = other || scratch(); pass(p, [cur, other, ub]); [cur, other] = [other, cur]; };
    pass(devPipes.lin, [src.tex, cur, ub]);
    if (plan.passes.detail) step(devPipes.nr);
    if (plan.passes.lens) {
      const lu = lensUniform(W, H, 0, plan.lens); tmp.push(lu);
      other = other || scratch(); pass(devPipes.lens, [cur, other, lu, S.masks.get(plan.lens.depth).tex]); [cur, other] = [other, cur];
    }
    if (plan.passes.sharpen) step(devPipes.sharp);
    let grid = dummyGrid;
    if (plan.passes.grid) {
      const C = plan.u[2]; const gw = Math.ceil(W / C); const gh = Math.ceil(H / C);
      const mk = () => { const t = device.createTexture({ size: [gw, gh], format: 'rgba32float', usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING, label: 'develop grid' }); tmp.push(t); return t; };
      const g0 = mk(); grid = mk();
      pass(devPipes.grid, [cur, g0, ub], Math.ceil(gw / 16), Math.ceil(gh / 16));
      pass(devPipes.gblur, [g0, grid, ub], Math.ceil(gw / 16), Math.ceil(gh / 16));
    }
    pass(devPipes.tone, [cur, out, ub, cb, grid, plan.passes.lut ? S.luts.get(lutId).buf : identityCurve]);
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    tmp.forEach((t) => t.destroy());
    return out;
  }
  function lensUniform(W, H, mode, lens) {
    const b = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, new Float32Array([W, H, 0, 0, mode, lens.dFocus, lens.slope, lens.maxR]));
    return b;
  }
  // Lens blur of an image source: a straight linear Rec.2020 rgba16float texture (composited as kind 0).
  async function runLensImage(src, lens) {
    const { width: W, height: H } = src;
    const lu = lensUniform(W, H, 1, lens);
    const out = device.createTexture({ size: [W, H], format: 'rgba16float', usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING | TU.COPY_SRC, label: 'lens-blurred image' });
    const enc = device.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setPipeline(devPipes.lensImg.pipeline);
    cp.setBindGroup(0, device.createBindGroup({ layout: devPipes.lensImg.layout, entries: [src.tex.createView(), out.createView(), { buffer: lu }, S.masks.get(lens.depth).tex.createView()].map((resource, binding) => ({ binding, resource })) }));
    cp.dispatchWorkgroups(Math.ceil(W / 16), Math.ceil(H / 16));
    cp.end();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    lu.destroy();
    return out;
  }
  const layerTexture = (l) => (l.devKey ? S.developed.get(l.devKey).tex : l.src?.tex);

  // Reads a rect of a RAW layer's developed texture (float RGBA, w × h × 4). For checks and samplers.
  async function readDeveloped(layerId, x, y, w, h) {
    const find = (list) => { for (const l of list) { if (l.group) { const r = find(l.children); if (r) return r; } else if (l.id === layerId) return l; } return null; };
    const l = find(S.layers);
    const e = l && S.developed.get(l.devKey);
    if (!e) throw new EngineError('invalid', `layer ${layerId} has no developed texture`, 'render first');
    const bpr = Math.ceil(w * 8 / 256) * 256;
    const buf = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: e.tex, origin: [x, y] }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: h }, [w, h, 1]);
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const half = new Uint16Array(buf.getMappedRange().slice(0));
    buf.unmap(); buf.destroy();
    const out = new Float32Array(w * h * 4);
    for (let j = 0; j < h; j++) for (let i = 0; i < w * 4; i++) out[j * w * 4 + i] = halfToFloat(half[j * bpr / 2 + i]);
    return out;
  }

  function writeLayerUniform(buf, l, lod, first) {
    const dv = new DataView(new ArrayBuffer(U_SIZE));
    // Groups: kind 3 = isolated (the scratch tile composited as one layer), 4 = pass-through mix.
    const mask = l.mask;
    const bm = (mask?.components || []).find((c) => c.kind === 'bitmap');
    const src = l.group ? { kind: 'group', width: 1, height: 1 } : l.adjustment ? { width: bm ? S.masks.get(bm.bitmap).width : 1, height: bm ? S.masks.get(bm.bitmap).height : 1 } : l.src;
    const kind = l.group ? (l.isolation === 'isolated' ? 3 : 4) : l.adjustment ? 5 : l.devKey ? 0 : { raw: 0, image: 1, solid: 2 }[src.kind];
    const u32 = (o, v) => dv.setUint32(o, v, true); const f32 = (o, v) => dv.setFloat32(o, v, true);
    u32(0, lod); u32(4, first ? 1 : 0); u32(8, Math.max(0, BLEND_MODES.indexOf(l.blend ?? 'normal'))); u32(12, S.doc.blendSpace === 'linear' ? 1 : 0);
    u32(16, kind); u32(20, src.width); u32(24, src.height); u32(28, S.doc.width);
    u32(32, S.doc.height); u32(36, mask ? mask.components.length : 0); u32(40, mask?.invert ? 1 : 0); u32(44, l.clipped ? 2 : l.hasClipped ? 1 : 0);
    const inv = l.group || l.adjustment ? [1, 0, 0, 1, 0, 0] : invertAffine(l.matrix);
    f32(48, inv[0]); f32(52, inv[1]); f32(56, inv[2]); f32(60, inv[3]);
    f32(64, inv[4]); f32(68, inv[5]); f32(72, l.opacity ?? 1); f32(76, l.group ? 1 : (l.fill ?? 1));
    (src.color || [0, 0, 0, 0]).forEach((v, i) => f32(80 + 4 * i, v));
    if (l.quadInv) { l.quadInv.flat().forEach((v, i) => f32(96 + 4 * i, v)); f32(132, 1); }
    if (l.adjustment) f32(136, l.adj.type);
    f32(148, mask ? (mask.density ?? 1) : 1);
    (mask?.components || []).forEach((c, k) => {
      const o = 160 + 48 * k;
      f32(o, MASK_KINDS.indexOf(c.kind)); f32(o + 4, MASK_OPS.indexOf(c.op));
      (c.p0 || [0, 0, 0, 0]).forEach((v, i) => f32(o + 16 + 4 * i, v));
      (c.p1 || [0, 0, 0, 0]).forEach((v, i) => f32(o + 32 + 4 * i, v));
    });
    device.queue.writeBuffer(buf, 0, dv.buffer);
  }

  function allocSlice(keep) {
    if (S.free.length) return S.free.pop();
    let victim = null;
    for (const [k, e] of S.cache) { if (keep.has(k)) continue; if (!victim || e.used < victim[1].used) victim = [k, e]; }
    if (!victim) throw new EngineError('busy', 'more tiles requested than the cache holds', 'render a smaller region');
    S.cache.delete(victim[0]);
    return victim[1].slice;
  }

  // Composites the given tiles (if stale) into the cache; returns { grid slices, composited, reused }.
  // Tiles with the same culled layer tree share dispatches, in chunks of BATCH tiles. Each layer is one
  // dispatch that reads the accumulator from one array of a pair and writes the other (ping-pong). A group
  // composites its children one level down, in that level's scratch pair at the tile's chunk index, then
  // one more dispatch brings the result up (kind 3 isolated, kind 4 pass-through mix).
  function encodeTiles(enc, lod, coords, scratch) {
    const keys = new Set(coords.map(([tx, ty]) => `${lod}:${tx}:${ty}`));
    const groups = new Map(); const slices = []; let reused = 0; let composited = 0; const uc = { u: 0, a: 0 };
    for (const [tx, ty] of coords) {
      const key = `${lod}:${tx}:${ty}`;
      const stack = layersFor(lod, tx, ty);
      const sig = S.doc.blendSpace + '|' + treeKey(stack, (l) => l.sig);
      const e = S.cache.get(key);
      if (e && e.sig === sig) { e.used = S.tick; slices.push(e.slice); reused++; continue; }
      if (!stack.length) { if (e) { S.free.push(e.slice); S.cache.delete(key); } slices.push(-1); continue; }
      const slice = e ? e.slice : allocSlice(keys);
      S.cache.set(key, { slice, sig, used: S.tick });
      slices.push(slice);
      const gk = treeKey(stack, (l) => l.id);
      if (!groups.has(gk)) groups.set(gk, { stack, tiles: [] });
      groups.get(gk).tiles.push([tx, ty, slice]);
    }
    for (const { stack, tiles } of groups.values()) {
      composited += tiles.length;
      for (let i = 0; i < tiles.length; i += BATCH) encodeChunk(enc, lod, stack, tiles.slice(i, i + BATCH), scratch, uc);
    }
    return { slices, composited, reused };
  }

  function tileBuffer(entries, scratch) {
    const tb = device.createBuffer({ size: entries.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(tb, 0, new Int32Array(entries.flat()));
    scratch.push(tb);
    return tb;
  }

  // tiles: [[tx, ty, cacheSlice]] (≤ BATCH). Tile entries are [tx, ty, slice at this level, slice one level down].
  function encodeChunk(enc, lod, stack, tiles, scratch, uc) {
    const top = { A: tilesA, B: tilesB, vA: viewA, vB: viewB, tb: tileBuffer(tiles.map(([tx, ty, s], i) => [tx, ty, s, i]), scratch), slices: tiles.map((t) => t[2]) };
    let inner = null;
    const level = (d) => {
      if (d === 0) return top;
      if (!inner) inner = { tb: tileBuffer(tiles.map(([tx, ty], i) => [tx, ty, i, i]), scratch), slices: tiles.map((_, i) => i) };
      return { ...scratchLevel(d), tb: inner.tb, slices: inner.slices };
    };
    // Composites nodes at level d; startFilled: the level's A array already holds the stack below.
    // Returns the view of the array that holds the result.
    const run = (nodes, d, startFilled) => {
      const L = level(d);
      nodes.forEach((l, k) => {
        const first = k === 0 && !startFilled;
        const evenStep = k % 2 === 0; // even: read A (unused when first), write B; odd: read B, write A
        let srcView = dummyTiles;
        if (l.group) {
          const C = level(d + 1);
          const passThrough = l.isolation === 'pass-through';
          if (passThrough && !first) {
            L.slices.forEach((s, i) => enc.copyTextureToTexture({ texture: evenStep ? L.A : L.B, origin: [0, 0, s] }, { texture: C.A, origin: [0, 0, i] }, [TILE, TILE, 1]));
          }
          srcView = run(l.kids, d + 1, passThrough && !first);
        }
        const ub = uniformAt(uc.u++);
        writeLayerUniform(ub, l, lod, first);
        const maskComp = l.group ? null : (l.mask?.components || []).find((c) => c.kind === 'bitmap');
        let adjBuf = dummyAdj; let curveBuf = identityCurve; let devBuf = dummyDev;
        if (l.adjustment) {
          const i = uc.a++;
          adjBuf = adjPool(i); device.queue.writeBuffer(adjBuf, 0, l.adj.p);
          if (l.adj.curve) { curveBuf = adjCurvePool(i); device.queue.writeBuffer(curveBuf, 0, l.adj.curve); }
          if (l.adj.dev) { devBuf = adjDevPool(i); device.queue.writeBuffer(devBuf, 0, l.adj.dev); }
        }
        const clipMode = l.clipped ? 2 : l.hasClipped ? 1 : 0;
        const pass = enc.beginComputePass();
        pass.setPipeline(pipes.composite);
        pass.setBindGroup(0, device.createBindGroup({
          layout: pipes.composite.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: evenStep ? L.vA : L.vB },
            { binding: 1, resource: evenStep ? L.vB : L.vA },
            { binding: 2, resource: (layerTexture(l) || dummyTex).createView() },
            { binding: 3, resource: { buffer: L.tb } },
            { binding: 4, resource: { buffer: ub } },
            { binding: 5, resource: (maskComp ? S.masks.get(maskComp.bitmap).tex : dummyMask).createView() },
            { binding: 6, resource: srcView },
            { binding: 7, resource: { buffer: adjBuf } },
            { binding: 8, resource: { buffer: devBuf } },
            { binding: 9, resource: { buffer: curveBuf } },
            { binding: 10, resource: clipMode === 1 ? clipLevel(d) : dummyClipW },
            { binding: 11, resource: clipMode === 2 ? clipLevel(d) : dummyTiles },
          ],
        }));
        pass.dispatchWorkgroups(TILE / 16, TILE / 16, tiles.length);
        pass.end();
      });
      return nodes.length % 2 === 1 ? L.vB : L.vA;
    };
    run(stack, 0, false);
    if (stack.length % 2 === 1) {
      for (const [, , slice] of tiles) enc.copyTextureToTexture({ texture: tilesB, origin: [0, 0, slice] }, { texture: tilesA, origin: [0, 0, slice] }, [TILE, TILE, 1]);
    }
  }

  async function render() {
    if (lost) throw new EngineError('device_lost', `GPU device lost: ${lost.message}`, 'reload the document');
    if (!S.doc || !ctx) return null;
    const t0 = performance.now();
    const developed = await ensureDeveloped();
    S.tick++;
    const v = computeView();
    const coords = [];
    for (let j = 0; j < v.gh; j++) for (let i = 0; i < v.gw; i++) coords.push([v.tx0 + i, v.ty0 + j]);
    const enc = device.createCommandEncoder(); const scratch = [];
    const { slices, composited, reused } = encodeTiles(enc, v.lod, coords, scratch);
    const grid = new Int32Array(slices.length ? slices : [-1]);
    const gb = device.createBuffer({ size: grid.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(gb, 0, grid); scratch.push(gb);
    const dv = new DataView(new ArrayBuffer(48));
    dv.setFloat32(0, v.x0, true); dv.setFloat32(4, v.y0, true); dv.setFloat32(8, v.scale, true); dv.setUint32(12, v.lod, true);
    dv.setInt32(16, v.tx0, true); dv.setInt32(20, v.ty0, true); dv.setInt32(24, v.gw, true); dv.setInt32(28, v.gh, true);
    dv.setFloat32(32, S.doc.width, true); dv.setFloat32(36, S.doc.height, true);
    device.queue.writeBuffer(displayUniform, 0, dv.buffer);
    const rp = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    rp.setPipeline(display);
    rp.setBindGroup(0, device.createBindGroup({
      layout: display.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: viewA }, { binding: 1, resource: { buffer: gb } }, { binding: 2, resource: { buffer: displayUniform } }],
    }));
    rp.draw(3); rp.end();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    scratch.forEach((b) => b.destroy());
    S.stats = { lod: v.lod, visible: v.gw * v.gh, composited, reused, developed, frameMs: performance.now() - t0 };
    return S.stats;
  }

  let inflight = null; let pending = false;
  function schedule() {
    if (inflight) { pending = true; return inflight; }
    inflight = (async () => {
      try { do { pending = false; await render(); } while (pending); } finally { inflight = null; }
      return S.stats;
    })();
    return inflight;
  }

  async function readSlice(slice) {
    const buf = device.createBuffer({ size: TILE * TILE * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tilesA, origin: [0, 0, slice] }, { buffer: buf, bytesPerRow: TILE * 8, rowsPerImage: TILE }, [TILE, TILE, 1]);
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const half = new Uint16Array(buf.getMappedRange().slice(0));
    buf.unmap(); buf.destroy();
    const out = new Float32Array(half.length);
    for (let i = 0; i < half.length; i++) out[i] = halfToFloat(half[i]);
    return out;
  }

  async function readTile(lod, tx, ty) {
    const e = S.cache.get(`${lod}:${tx}:${ty}`);
    if (!e || e.sig !== signature(lod, tx, ty)) return null;
    return readSlice(e.slice);
  }

  // Renders the whole document at a level of detail, tile batch by tile batch, into one premultiplied
  // linear Rec.2020 float image (w × h × 4). Used for previews, histograms, sampling and export.
  // rect (optional) is [x0, y0, x1, y1] in pixels at this lod; the result covers exactly that rect.
  async function renderImage(lod = 0, rect = null) {
    if (!S.doc) throw new EngineError('unsupported', 'no document', 'set a document first');
    const s = 2 ** lod; const fw = Math.ceil(S.doc.width / s); const fh = Math.ceil(S.doc.height / s);
    const [rx0, ry0, rx1, ry1] = rect ? [Math.max(0, rect[0]), Math.max(0, rect[1]), Math.min(fw, rect[2]), Math.min(fh, rect[3])] : [0, 0, fw, fh];
    const w = Math.max(0, rx1 - rx0); const h = Math.max(0, ry1 - ry0);
    const out = new Float32Array(w * h * 4);
    await ensureDeveloped();
    const all = [];
    for (let ty = Math.floor(ry0 / TILE); ty * TILE < ry1; ty++) for (let tx = Math.floor(rx0 / TILE); tx * TILE < rx1; tx++) all.push([tx, ty]);
    for (let i = 0; i < all.length; i += 64) {
      S.tick++;
      const batch = all.slice(i, i + 64);
      const enc = device.createCommandEncoder(); const scratch = [];
      const { slices } = encodeTiles(enc, lod, batch, scratch);
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
      scratch.forEach((b) => b.destroy());
      for (let k = 0; k < batch.length; k++) {
        if (slices[k] < 0) continue;
        const [tx, ty] = batch[k];
        const px = await readSlice(slices[k]);
        const x0 = Math.max(rx0, tx * TILE); const x1 = Math.min(rx1, tx * TILE + TILE);
        for (let gy = Math.max(ry0, ty * TILE); gy < Math.min(ry1, ty * TILE + TILE); gy++) {
          const y = gy - ty * TILE;
          out.set(px.subarray((y * TILE + x0 - tx * TILE) * 4, (y * TILE + x1 - tx * TILE) * 4), ((gy - ry0) * w + (x0 - rx0)) * 4);
        }
      }
    }
    return { width: w, height: h, lod, x: rx0, y: ry0, data: out };
  }

  function getState() {
    return {
      doc: S.doc, view: S.view, stats: S.stats,
      gpu: { ...gpu.info, isFallback: gpu.isFallback, lost: !!lost },
      sources: [...S.sources.values()].map(({ id, kind, width, height }) => ({ id, kind, width, height })),
      developCount: S.developCount, developedTextures: S.developed.size,
      layers: (function strip(list) { return list.map(({ src, sig, plan, devKey, adj, quadInv, ...l }) => (l.group ? { ...l, children: strip(l.children) } : l)); })(S.layers),
      cachedTiles: S.cache.size,
    };
  }

  return {
    createRawSource, createImageSource, createTextSource, createSolidSource, dropSource,
    createPixelSource: imageSourceFromPixels, updatePixelSource,
    createMaskBitmap, writeMaskBitmap, paintMask, createDepthRamp, createLut, dropLut,
    setDocument, setLayers, setView, render, schedule, readTile, readDeveloped, renderImage, getState, computeView, viewFor, layersFor,
    source: (id) => S.sources.get(id), mask: (id) => S.masks.get(id), lut: (id) => S.luts.get(id),
    get layers() { return S.layers; }, get doc() { return S.doc; },
  };
}

export function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1; const e = (h >> 10) & 0x1f; const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}
