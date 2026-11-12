// Model files and sessions for the image-to-image models (src/ai/models-pixels.js). These are raw ONNX
// graphs (no transformers.js config), so they run through onnxruntime-web directly, loaded from the pinned
// CDN path only when a model runs. Model files are fetched only by downloadPixelModel, which only the
// person's own click calls (download_model is person-only), and kept in Cache Storage under one named
// cache, so removing a model deletes exactly its files.

import { pixelModel, fileUrl } from './models-pixels.js';
import { tileInfer, rgbaReader, hwcToChw, chwToHwc } from './pixels.js';

export const PIXEL_CACHE = 'atelier-ai-pixels';
const ORT_VERSION = '1.22.0';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

const caches_ = () => (typeof caches === 'undefined' ? null : caches);
const need = (id) => { const m = pixelModel(id); if (!m) throw new Error(`no pixel model ${id}`); return m; };

// 'ready' when every file of the model is in the cache, else 'absent'.
export async function pixelModelStatus(id) {
  const m = need(id); const cs = caches_(); if (!cs) return 'absent';
  const c = await cs.open(PIXEL_CACHE);
  for (const f of m.files) if (!(await c.match(fileUrl(m, f)))) return 'absent';
  return 'ready';
}

// Person-only: fetches each file (streamed, so onProgress(bytesSoFar, totalBytes) can report) and caches it.
export async function downloadPixelModel(id, onProgress) {
  const m = need(id); const cs = caches_(); if (!cs) throw new Error('this browser has no Cache Storage');
  const c = await cs.open(PIXEL_CACHE); let done = 0;
  for (const f of m.files) {
    const url = fileUrl(m, f);
    if (await c.match(url)) { done += f.bytes; onProgress?.(done, m.bytes); continue; }
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${m.label}: ${f.path} answered HTTP ${r.status}`);
    const reader = r.body.getReader(); const parts = [];
    for (;;) { const { done: end, value } = await reader.read(); if (end) break; parts.push(value); done += value.length; onProgress?.(done, m.bytes); }
    await c.put(url, new Response(new Blob(parts), { headers: { 'Content-Type': 'application/octet-stream' } }));
  }
  return { id, status: 'ready', bytes: done };
}

export async function removePixelModel(id) {
  const m = need(id); for (const k of [...sessions.keys()]) if (k.startsWith(`${id}|`)) sessions.delete(k); const cs = caches_(); if (!cs) return { id, removed: 0 };
  const c = await cs.open(PIXEL_CACHE); let removed = 0;
  for (const f of m.files) if (await c.delete(fileUrl(m, f))) removed++;
  return { id, removed };
}

let ortP = null;
async function ort() {
  if (!ortP) ortP = import(/* @vite-ignore */ `${ORT_BASE}ort.webgpu.min.mjs`).then((o) => { o.env.wasm.wasmPaths = ORT_BASE; o.env.logLevel = 'error'; return o; });
  return ortP;
}

const sessions = new Map();   // `${id}|${graph}` → Promise<{ session, provider }>
// A model may hold several graphs (CLIP vision and text; face detector and landmarks). graph: the .onnx
// file's path (default: the model's first graph). An external weights file belongs to the graph whose path
// it extends (x.onnx → x.onnx.data or x.data) and is passed under its own file name, as the graph names it.
async function session(id, graph) {
  const m = need(id); const main = graph ?? m.files.find((f) => f.path.endsWith('.onnx')).path;
  const key = `${id}|${main}`;
  if (!sessions.has(key)) sessions.set(key, (async () => {
    // A run reads the model's files from Cache Storage only (modelFile never fetches), before the runtime
    // library loads, so a removed or evicted model fails here with nothing fetched.
    const stem = main.replace(/\.onnx$/, '');
    const ext = m.files.filter((f) => f.externalData && (f.path === `${main}.data` || f.path === `${stem}.data`));
    const externalData = [];
    for (const f of ext) externalData.push({ path: f.path.split('/').pop(), data: await modelFile(id, f.path) });
    const bytes = await modelFile(id, main);
    const o = await ort();
    const tryEps = m.device === 'webgpu' && typeof navigator !== 'undefined' && navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
    let last;
    for (const ep of tryEps) {
      try { return { session: await o.InferenceSession.create(bytes, { executionProviders: [ep], ...(externalData.length ? { externalData } : {}) }), provider: ep }; }
      catch (e) { last = e; }
    }
    throw last;
  })().catch((e) => { sessions.delete(key); throw e; }));
  return sessions.get(key);
}

// One downloaded file of a model, as bytes (tokenizer files, graphs).
export async function modelFile(id, path) {
  const m = need(id); const f = m.files.find((x) => x.path === path);
  if (!f) throw new Error(`${m.label} has no file ${path}`);
  const cs = caches_(); const r = cs ? await (await cs.open(PIXEL_CACHE)).match(fileUrl(m, f)) : null;
  if (!r) throw new Error(`${m.label} is not downloaded`);
  return new Uint8Array(await r.arrayBuffer());
}

// Runs one graph of a model: feeds { name: { type, data, dims } } → { name: { data, dims } }.
export async function runGraph(id, graph, feeds) {
  const { session: s } = await session(id, graph); const o = await ort();
  const f = {}; for (const [k, v] of Object.entries(feeds)) f[k] = new o.Tensor(v.type || 'float32', v.data, v.dims);
  const out = await s.run(f); const r = {};
  for (const k of s.outputNames) r[k] = { data: out[k].data, dims: out[k].dims };
  return r;
}
export async function graphInputs(id, graph) { const { session: s } = await session(id, graph); return { inputs: s.inputNames, outputs: s.outputNames }; }

// Runs one model on one HWC tile; returns HWC.
async function runTile(id, t, tw, th, c) {
  const m = need(id); const { session: s } = await session(id); const o = await ort();
  const feeds = {};
  if (m.task === 'inpaint') {   // t: tw × th × 4 (RGB with the hole zeroed, then the hole 0/1)
    const chw = hwcToChw(t, tw, th, 4);
    feeds[s.inputNames[0]] = new o.Tensor('float32', chw.subarray(0, 3 * tw * th), [1, 3, th, tw]);
    feeds[s.inputNames[1]] = new o.Tensor('float32', chw.subarray(3 * tw * th), [1, 1, th, tw]);
  } else feeds[s.inputNames[0]] = new o.Tensor('float32', hwcToChw(t, tw, th, c), [1, c, th, tw]);
  const out = (await s.run(feeds))[s.outputNames[0]];
  const [, oc, oh, ow] = out.dims; let data = out.data;
  // LaMa's export returns 0..255; the others return 0..1.
  if (m.task === 'inpaint') { let mx = 0; for (let i = 0; i < data.length; i += 97) mx = Math.max(mx, data[i]); if (mx > 1.5) data = Float32Array.from(data, (v) => v / 255); }
  if (ow !== tw * m.io.scale || oh !== th * m.io.scale) throw new Error(`${m.label} returned ${ow} × ${oh} for a ${tw} × ${th} tile`);
  return chwToHwc(data, ow, oh, oc);
}

export async function providerOf(id) { return (await session(id)).provider; }

// Image-to-image over a whole RGBA u8 image, tiled; returns RGB float HWC (w·scale × h·scale).
export async function runImage(id, px, w, h, onProgress) {
  const m = need(id);
  await session(id);
  return tileInfer(rgbaReader(px, w, h), { tile: m.io.tile, overlap: m.io.overlap, scale: m.io.scale, multiple: m.io.multiple, outC: 3, onTile: onProgress, run: (t, tw, th) => runTile(id, t, tw, th, 3) });
}

// The inpainting model as the 4-channel tile function src/ai/pixels.js inpaint() expects.
export async function inpaintModel(id = 'lama-inpaint') {
  await session(id);
  return (t, tw, th) => runTile(id, t, tw, th, 4);
}
