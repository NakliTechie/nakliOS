// The shared on-device AI runtime (spec 002 §9.4), used by the AI mask commands and the AI pixel commands.
// One module Web Worker (src/ai/worker-src.js) runs transformers.js; this side keeps the consent record and
// the model status. Consent is the person's download click: downloadModel records it in the app's storage
// (settings/ai-models.json through the storage adapter, so apps/atelier/ when hosted) and only then lets the
// worker fetch that one model. runModel refuses a model without consent, and the worker loads models for a
// run from Cache Storage only. Which models are present comes from Cache Storage (transformers.js caches each
// file under its Hugging Face URL); removeModel deletes that model's entries by URL.
//
// Exports: modelStatus(id) → 'absent' | 'downloading' | 'ready' | 'failed'; downloadModel(id, onProgress);
// removeModel(id); runModel(id, task, input); plus configure({ storage }), refresh(), listModels() and
// createRuntime (for tests and for a second instance).

import { MODELS, graphFile } from './registry.js';
import { workerSource } from './worker-src.js';

export const CONSENT_FILE = 'settings/ai-models.json';

export class RuntimeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function defaultWorker() {
  const url = URL.createObjectURL(new Blob([workerSource()], { type: 'application/javascript' }));
  const w = new Worker(url, { type: 'module', name: 'atelier-ai' });
  return w;
}

// storage: () → storage adapter or null. caches: the CacheStorage to read and prune. makeWorker: () → Worker.
// Models with runtime 'ort' (the pixel models) keep their files in their own cache through src/ai/pixels-ort.js;
// this runtime records consent and status for them and hands download and removal to that module.
const loadOrt = () => import('./pixels-ort.js');

export function createRuntime({ models = MODELS, storage = () => null, caches = globalThis.caches, makeWorker = defaultWorker, ort = loadOrt } = {}) {
  const byId = new Map(models.map((m) => [m.id, m]));
  let consent = null;               // { [id]: { at, revision } } once read
  const phase = new Map();          // id → 'downloading' | 'failed' (in memory)
  const errors = new Map();         // id → last error message
  const present = new Set();        // ids whose weights are in Cache Storage
  let worker = null; let reqSeq = 0; const pending = new Map();

  const need = (id) => { const m = byId.get(id); if (!m) throw new RuntimeError('unknown_model', `no model ${id}; models: ${[...byId.keys()].join(', ')}`); return m; };

  async function readConsent() {
    if (consent) return consent;
    const s = storage();
    if (!s) return {};   // storage not chosen yet: read again once it is
    let c = {};
    try { if (await s.exists(CONSENT_FILE)) c = JSON.parse(await s.readText(CONSENT_FILE))?.consented ?? {}; } catch { c = {}; }
    consent = c;
    return consent;
  }
  // Writes go one at a time, so two Download clicks never race on the same temp file.
  let writing = Promise.resolve();
  function writeConsent() {
    writing = writing.catch(() => {}).then(() => writeConsentNow());
    return writing;
  }
  async function writeConsentNow() {
    const s = storage();
    if (s) await s.write(CONSENT_FILE, new TextEncoder().encode(`${JSON.stringify({ note: 'On-device models the person chose to download (Atelier, spec 002 §9.4).', consented: consent }, null, 2)}\n`));
  }

  // The Cache Storage entries holding a model: every cached request under huggingface.co/<repo>/resolve/.
  async function entriesOf(m) {
    const out = [];
    if (!caches) return out;
    for (const name of await caches.keys()) {
      const c = await caches.open(name);
      for (const req of await c.keys()) if (req.url.includes(`/${m.repo}/resolve/`)) out.push({ cache: name, url: req.url });
    }
    return out;
  }

  async function refresh() {
    consent = null;   // storage may have changed (a folder granted, the host connected)
    const c = await readConsent();
    for (const m of models) {
      let here;
      if (m.runtime === 'ort') here = (await (await ort()).pixelModelStatus(m.id)) === 'ready';
      // Present means this model's own graph file (its dtype) is cached, not any .onnx of the repo.
      else here = !!c[m.id] && (await entriesOf(m)).some((f) => f.url.endsWith(`/${graphFile(m)}`));
      if (here) present.add(m.id); else present.delete(m.id);
    }
    return listModels();
  }

  function modelStatus(id) {
    need(id);
    if (phase.has(id)) return phase.get(id);
    return present.has(id) && (consent?.[id] || byId.get(id).runtime === 'ort') ? 'ready' : 'absent';
  }
  const listModels = () => models.map((m) => ({ id: m.id, label: m.label, task: m.task, licence: m.licence, licenceUrl: m.licenceUrl, source: `https://huggingface.co/${m.repo}`, revision: m.revision, bytes: m.bytes, status: modelStatus(m.id), ...(errors.has(m.id) && phase.get(m.id) === 'failed' ? { error: errors.get(m.id) } : {}) }));

  function getWorker() {
    if (worker) return worker;
    worker = makeWorker();
    worker.onmessage = (ev) => {
      const { reqId, progress, ok, result, error } = ev.data || {};
      const p = pending.get(reqId); if (!p) return;
      if (progress) { p.onProgress?.(progress); return; }
      pending.delete(reqId);
      if (ok) p.resolve(result); else p.reject(new RuntimeError('model_error', error));
    };
    // Without this a failing module worker is silent; every waiting call fails and the next call starts a new worker.
    const dead = (e) => {
      const msg = e?.message || 'the model worker stopped (check the console for a load error)';
      for (const p of pending.values()) p.reject(new RuntimeError('worker_error', msg));
      pending.clear(); worker?.terminate?.(); worker = null;
    };
    worker.onerror = dead; worker.onmessageerror = dead;
    // The worker keeps its own consented set; send every recorded consent to a fresh worker.
    for (const id of Object.keys(consent || {})) { const m = byId.get(id); if (m) worker.postMessage({ op: 'consent', repo: m.repo }); }
    return worker;
  }
  function call(msg, onProgress, transfer = []) {
    const reqId = ++reqSeq;
    return new Promise((resolve, reject) => { pending.set(reqId, { resolve, reject, onProgress }); getWorker().postMessage({ ...msg, reqId }, transfer); });
  }

  // Only the person's download click reaches this (the download_model tool is person-only).
  async function downloadModel(id, onProgress) {
    const m = need(id);
    if (phase.get(id) === 'downloading') throw new RuntimeError('busy', `${m.label} is already downloading`);
    phase.set(id, 'downloading'); errors.delete(id);
    try {
      consent = await readConsent();
      consent[id] = { at: new Date().toISOString(), revision: m.revision };
      await writeConsent();
      if (m.runtime === 'ort') await (await ort()).downloadPixelModel(id, (loaded, total) => onProgress?.({ status: 'progress', loaded, total, progress: total ? (100 * loaded) / total : 0 }));
      else {
        getWorker().postMessage({ op: 'consent', repo: m.repo });
        await call({ op: 'load', model: m, allowRemote: true }, onProgress);
      }
      present.add(id); phase.delete(id);
      return { id, status: 'ready', bytes: m.bytes };
    } catch (e) {
      phase.set(id, 'failed'); errors.set(id, e.message);
      throw e;
    }
  }

  async function removeModel(id) {
    const m = need(id);
    consent = await readConsent();
    delete consent[id];
    await writeConsent();
    if (m.runtime === 'ort') {
      const r = await (await ort()).removePixelModel(id);
      present.delete(id); phase.delete(id); errors.delete(id);
      return { id, status: 'absent', deleted: Array.from({ length: r.removed }, (_, i) => `${m.repo}#${i}`) };
    }
    if (worker) { worker.postMessage({ op: 'revoke', repo: m.repo }); worker.postMessage({ op: 'unload', model: m, reqId: 0 }); }
    const files = await entriesOf(m);
    for (const f of files) await (await caches.open(f.cache)).delete(f.url);
    present.delete(id); phase.delete(id); errors.delete(id);
    return { id, status: 'absent', deleted: files.map((f) => f.url) };
  }

  // input: per task (worker-src.js). Images are transferred, so the caller's buffer is detached afterwards.
  async function runModel(id, task, input) {
    const m = need(id);
    if (m.runtime === 'ort') throw new RuntimeError('wrong_runtime', `${m.label} runs through src/ai/pixels-ort.js, not the transformers.js worker`);
    if (!(await readConsent())[id]) throw new RuntimeError('not_consented', `${m.label} is not downloaded; the person downloads it first (download_model)`);
    if (phase.get(id) === 'downloading') throw new RuntimeError('busy', `${m.label} is still downloading`);
    if (!present.has(id)) await refresh();
    if (!present.has(id)) throw new RuntimeError('absent', `${m.label} is not in this browser's cache any more; download it again`);
    const transfer = input?.image?.data?.buffer ? [input.image.data.buffer] : [];
    return call({ op: 'run', model: m, task, input }, null, transfer);
  }

  return {
    modelStatus, downloadModel, removeModel, runModel, refresh, listModels,
    useStorage(fn) { storage = fn; consent = null; },
    get workerStarted() { return !!worker; },
  };
}

// The app's one runtime. The handler module calls configure({ storage }) at registration.
const shared = createRuntime({ storage: () => null });
export const configure = ({ storage }) => shared.useStorage(storage);
export const modelStatus = (id) => shared.modelStatus(id);
export const downloadModel = (id, onProgress) => shared.downloadModel(id, onProgress);
export const removeModel = (id) => shared.removeModel(id);
export const runModel = (id, task, input) => shared.runModel(id, task, input);
export const refresh = () => shared.refresh();
export const listModels = () => shared.listModels();
