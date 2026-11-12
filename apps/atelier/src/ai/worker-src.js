// Source of the one model worker (a module worker started from a blob URL by src/ai/runtime.js).
// It installs the network guard (src/ai/guard.js) before transformers.js loads. The guard lets a model's repo
// through only while that model's explicit download runs (a load with allowRemote, which only the person's
// Download click sends); at every other time, runs included, model files come from Cache Storage or not at all,
// so a removed or evicted model is never fetched again without a click. It answers these messages, one at a time:
//   { op: 'consent' | 'revoke', repo }                       → the consented set (which models may load at all)
//   { op: 'load', reqId, model, allowRemote }                → loads (and, with allowRemote, downloads) a model
//   { op: 'run', reqId, model, task, input }                 → runs a task; the model loads from the cache only
//   { op: 'unload', model }                                  → frees a loaded model
// Replies: { reqId, progress } while loading, then { reqId, ok: true, result } or { reqId, ok: false, error }.
// Images travel as { width, height, data: Uint8ClampedArray RGBA } and masks as Uint8Array, one byte per pixel.
//
// Tasks: 'semantic' (DETR: one soft plane per named label group, all from one call),
// 'salient' (IS-Net: the foreground plane), 'matting' (ViTMatte: alpha from an image and a trimap),
// 'point-mask' (SAM: best mask for click points), 'depth' (Depth Anything: disparity 0..255, 255 nearest),
// and 'pipeline' (any transformers.js pipeline named by model.pipeline, for pixel models: input.image plus
// input.options; RawImage outputs come back as { width, height, channels, data }).

import { hfGuard } from './guard.js';

export const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4/+esm';
export const NEEDED_EXPORTS = ['env', 'RawImage', 'Tensor', 'AutoProcessor', 'AutoModel', 'SamModel', 'DetrForSegmentation', 'VitMatteForImageMatting', 'pipeline'];

function workerMain(TJS, NEEDED) {
  const consented = new Set();
  const downloading = new Set();   // repos whose explicit download is running now: the only repos the guard lets through
  const realFetch = self.fetch.bind(self);
  // eslint-disable-next-line no-undef
  self.fetch = (input, init) => { const url = typeof input === 'string' ? input : input?.url ?? String(input); const v = hfGuard(url, downloading); return v.ok ? realFetch(input, init) : Promise.reject(new Error(v.reason)); };

  let T = null;
  async function lib() {
    if (T) return T;
    const mod = await import(TJS);
    const missing = NEEDED.filter((n) => !(n in mod));
    if (missing.length) throw new Error(`transformers.js lacks ${missing.join(', ')}`);
    mod.env.allowLocalModels = false;
    mod.env.allowRemoteModels = false;
    mod.env.useBrowserCache = true;
    T = mod; return T;
  }
  const loaded = new Map();   // model id → { model?, processor?, pipe? }
  const device = (m) => (m.device === 'webgpu' && self.navigator?.gpu ? 'webgpu' : 'wasm');

  async function load(m, allowRemote, progress) {
    if (loaded.has(m.id)) return loaded.get(m.id);
    const t = await lib();
    // transformers.js 4 refuses to load with local and remote both off, so remote is on while a consented model
    // loads; the fetch guard above lets the repo through only during its explicit download (allowRemote), so a
    // run (allowRemote false) finds the files in Cache Storage or fails, and never fetches them.
    if (!consented.has(m.repo)) throw new Error(`not consented: ${m.repo}`);
    t.env.allowRemoteModels = true;
    if (allowRemote) downloading.add(m.repo);
    const o = { revision: m.revision, dtype: m.dtype, device: device(m), progress_callback: progress };
    let entry;
    try {
      if (m.task === 'point-mask') entry = { model: await t.SamModel.from_pretrained(m.repo, o), processor: await t.AutoProcessor.from_pretrained(m.repo, o) };
      else if (m.task === 'semantic') entry = { model: await t.DetrForSegmentation.from_pretrained(m.repo, o), processor: await t.AutoProcessor.from_pretrained(m.repo, o) };
      // IS-Net is a bare ONNX graph (no config.json): the config is given here and the graph named by its file.
      else if (m.task === 'salient') entry = { model: await t.AutoModel.from_pretrained(m.repo, { ...o, config: { model_type: 'isnet' }, subfolder: '', model_file_name: m.file.replace(/\.onnx$/, '') }) };
      else if (m.task === 'matting') entry = { model: await t.VitMatteForImageMatting.from_pretrained(m.repo, o), processor: await t.AutoProcessor.from_pretrained(m.repo, o) };
      else if (m.task === 'depth') entry = { pipe: await t.pipeline('depth-estimation', m.repo, o) };
      else entry = { pipe: await t.pipeline(m.pipeline ?? m.task, m.repo, o) };
    } finally { t.env.allowRemoteModels = false; downloading.delete(m.repo); }
    loaded.set(m.id, entry);
    return entry;
  }

  const plane = (raw) => { const c = raw.channels; if (c === 1) return raw.data; const out = new Uint8Array(raw.width * raw.height); for (let i = 0; i < out.length; i++) out[i] = raw.data[i * c]; return out; };
  const asImage = (raw) => (raw && raw.data && raw.width ? { width: raw.width, height: raw.height, channels: raw.channels, data: raw.data } : raw);

  async function run(m, task, input) {
    const t = await lib();
    const e = await load(m, false, null);
    const { width: w, height: h, data } = input.image;
    const img = new t.RawImage(new Uint8ClampedArray(data), w, h, 4);
    if (task === 'semantic') {
      // One DETR call, then MaskFormer-style semantic inference (Cheng, Schwing and Kirillov, 2021) over its
      // 100 queries instead of the panoptic argmax (which gave every pixel to the strongest kept segment, so a
      // person also claimed the wall behind):
      //   P_c(x) = Σ_q softmax(logits_q)[c] · σ(maskLogit_q(x))      c over the 250 real classes (no-object dropped)
      //   p_g(x) = Σ_{c∈g} P_c(x) / Σ_c P_c(x)                        (0 where Σ_c P_c(x) < 1e-6)
      //   alpha_g(x) = 255 · smoothstep(0.35, 0.65, p_g(x))           so faint shares do not leak into the mask
      // Planes come back at the mask grid (a quarter of the model input), one per group in input.groups.
      const inputs = await e.processor(img.rgb());
      const out = await e.model(inputs);
      const [, Q, C] = out.logits.dims; const [, , H, W] = out.pred_masks.dims;
      const lg = out.logits.data; const pm = out.pred_masks.data; const id2 = e.model.config.id2label;
      const groups = Object.entries(input.groups || {}).map(([name, pats]) => ({ name, res: pats.map((x) => new RegExp(x)) }));
      const inGroup = groups.map((g) => { const ids = []; for (let c = 0; c < C - 1; c++) if (g.res.some((r) => r.test(id2[c] ?? id2[String(c)] ?? ''))) ids.push(c); return ids; });
      const cls = new Float32Array(Q * C);
      for (let q = 0; q < Q; q++) { let mx = -Infinity; for (let c = 0; c < C; c++) mx = Math.max(mx, lg[q * C + c]); let sum = 0; for (let c = 0; c < C; c++) { const v = Math.exp(lg[q * C + c] - mx); cls[q * C + c] = v; sum += v; } for (let c = 0; c < C; c++) cls[q * C + c] /= sum; }
      const wAll = new Float32Array(Q); const wG = groups.map(() => new Float32Array(Q));
      for (let q = 0; q < Q; q++) { for (let c = 0; c < C - 1; c++) wAll[q] += cls[q * C + c]; inGroup.forEach((ids, k) => { for (const c of ids) wG[k][q] += cls[q * C + c]; }); }
      const n = H * W; const den = new Float32Array(n); const num = groups.map(() => new Float32Array(n));
      for (let q = 0; q < Q; q++) {
        if (wAll[q] < 1e-3) continue;   // a query that is almost surely no-object adds nothing
        const off = q * n;
        for (let i = 0; i < n; i++) { const sg = 1 / (1 + Math.exp(-pm[off + i])); den[i] += wAll[q] * sg; for (let k = 0; k < groups.length; k++) if (wG[k][q] > 1e-4) num[k][i] += wG[k][q] * sg; }
      }
      const planes = {};
      groups.forEach((g, k) => {
        const a = new Uint8Array(n);
        for (let i = 0; i < n; i++) { const p = den[i] > 1e-6 ? num[k][i] / den[i] : 0; const x = Math.min(1, Math.max(0, (p - 0.35) / 0.3)); a[i] = Math.round(255 * x * x * (3 - 2 * x)); }
        planes[g.name] = a;
      });
      // The confident queries (top class probability >= 0.5), for the reply.
      const labels = [];
      for (let q = 0; q < Q; q++) { let b = 0; let bc = -1; for (let c = 0; c < C - 1; c++) if (cls[q * C + c] > b) { b = cls[q * C + c]; bc = c; } if (b >= 0.5) labels.push({ label: id2[bc] ?? id2[String(bc)], score: Math.round(b * 1000) / 1000, groups: groups.filter((_, k) => inGroup[k].includes(bc)).map((g) => g.name) }); }
      return { width: W, height: H, planes, labels };
    }
    if (task === 'salient') {
      // IS-Net (Qin et al., ECCV 2022): input S × S RGB, x' = x / 255 − 0.5 (mean 0.5, std 1); output a sigmoid
      // map, rescaled to its own range as the reference code does: m' = (m − min) / (max − min).
      const S = m.size ?? 1024;
      const r = await img.resize(S, S); const rd = r.data; const ch = r.channels; const px = new Float32Array(3 * S * S);
      for (let i = 0; i < S * S; i++) for (let c = 0; c < 3; c++) px[c * S * S + i] = rd[i * ch + c] / 255 - 0.5;
      const sess = Object.values(e.model.sessions)[0];
      const out = await e.model({ [sess.inputNames[0]]: new t.Tensor('float32', px, [1, 3, S, S]) });
      const o = (out.output ?? out[sess.outputNames[0]]).data;
      let lo = Infinity; let hi = -Infinity; for (let i = 0; i < o.length; i++) { if (o[i] < lo) lo = o[i]; if (o[i] > hi) hi = o[i]; }
      const mask = new Uint8Array(S * S); const k = hi - lo > 1e-6 ? 255 / (hi - lo) : 0;
      for (let i = 0; i < mask.length; i++) mask[i] = Math.round((o[i] - lo) * k);
      return { width: S, height: S, mask };
    }
    if (task === 'matting') {
      // ViTMatte (Yao et al., 2023): the image plus a trimap (0 background, 128 unknown, 255 foreground) → alpha.
      // The processor pads to a multiple of 32; the alpha is cropped back to the input size.
      const tri = new t.RawImage(new Uint8ClampedArray(input.trimap), w, h, 1);
      const inputs = await e.processor(img.rgb(), tri);
      const out = await e.model(inputs);
      const a = out.alphas; const AW = a.dims[3]; const ad = a.data;
      const alpha = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) alpha[y * w + x] = Math.round(255 * Math.min(1, Math.max(0, ad[y * AW + x])));
      return { width: w, height: h, alpha };
    }
    if (task === 'point-mask') {
      const pts = input.points.map(([x, y]) => [x, y]);
      const inputs = await e.processor(img, { input_points: [[pts]], input_labels: [[pts.map((_, i) => input.labels?.[i] ?? 1)]] });
      const out = await e.model(inputs);
      const masks = await e.processor.post_process_masks(out.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes);
      const scores = Array.from(out.iou_scores.data);
      let best = 0; for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
      const t0 = masks[0]; const [, n, H, W] = t0.dims; const src = t0.data; const off = best * H * W;
      const mask = new Uint8Array(W * H); for (let i = 0; i < mask.length; i++) mask[i] = src[off + i] ? 255 : 0;
      return { width: W, height: H, mask, score: Math.round(scores[best] * 1000) / 1000, candidates: n };
    }
    if (task === 'depth') {
      const out = await e.pipe(img);
      const d = out.depth.width === w && out.depth.height === h ? out.depth : await out.depth.resize(w, h);
      return { width: w, height: h, depth: plane(d) };
    }
    const out = await e.pipe(img, input.options || {});
    return Array.isArray(out) ? out.map((o) => (o?.mask ? { ...o, mask: asImage(o.mask) } : asImage(o))) : asImage(out?.image ?? out);
  }

  let chain = Promise.resolve();
  self.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.op === 'consent') { consented.add(msg.repo); return; }
    if (msg.op === 'revoke') { consented.delete(msg.repo); downloading.delete(msg.repo); return; }
    chain = chain.then(async () => {
      try {
        if (msg.op === 'unload') { const e = loaded.get(msg.model.id); loaded.delete(msg.model.id); try { await e?.model?.dispose?.(); await e?.pipe?.dispose?.(); } catch { /* already gone */ } return; }
        let result;
        if (msg.op === 'load') { await load(msg.model, msg.allowRemote, (p) => self.postMessage({ reqId: msg.reqId, progress: { status: p.status, file: p.file, loaded: p.loaded, total: p.total, progress: p.progress } })); result = { loaded: msg.model.id }; }
        else if (msg.op === 'run') result = await run(msg.model, msg.task, msg.input);
        else throw new Error(`unknown op ${msg.op}`);
        const transfer = [];
        for (const k of ['mask', 'depth', 'alpha']) if (result?.[k]?.buffer) transfer.push(result[k].buffer);
        for (const p of Object.values(result?.planes ?? {})) transfer.push(p.buffer);
        self.postMessage({ reqId: msg.reqId, ok: true, result }, transfer);
      } catch (err) { self.postMessage({ reqId: msg.reqId, ok: false, error: String(err?.message ?? err) }); }
    });
  };
}

// The worker's whole text: the guard, then workerMain called with the pinned library URL.
export function workerSource() {
  return `${hfGuard.toString()}\n(${workerMain.toString()})(${JSON.stringify(TRANSFORMERS_URL)}, ${JSON.stringify(NEEDED_EXPORTS)});\n`;
}
