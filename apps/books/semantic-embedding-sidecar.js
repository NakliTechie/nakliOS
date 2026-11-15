export const DEFAULT_SEMANTIC_EMBEDDING_MODEL = Object.freeze({
  key:'minilm-l6-v2',
  providerClass:'browser-local',
  destination:'browser-wasm',
  model:'Xenova/all-MiniLM-L6-v2',
  label:'MiniLM semantic encoder',
  dimensions:384,
  dtype:'q8',
  approximateDownloadBytes:23_000_000,
});

// The shared Neural Engine embedder (naklios sdk/ane-embed.js), imported inside the worker. localStorage
// 'naklios.aneEmbed': 'off' turns it off; a URL loads that copy instead (local testing). Without WebNN the worker
// runs WASM q8 as before.
export const ANE_EMBED_URL = 'https://naklios.dev/sdk/ane-embed.js';
// The embedding worker runs its own Transformers.js, 4.3.2: the first version whose WebNN path works. 4.2.0 (the
// rest of Books) fails on int64 inputs and then breaks its own WASM fallback in the same worker. This worker loads
// only the encoder, so it does not need to match the chat pin.
export const SEMANTIC_TRANSFORMERS_JS_MODULE = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/+esm';
export function aneEmbedUrl(scope = globalThis) {
  try {
    const value = scope.localStorage?.getItem('naklios.aneEmbed');
    if (value === 'off') return null;
    if (value) return value;
  } catch (_) {}
  return ANE_EMBED_URL;
}

export function semanticEmbeddingSupported(scope = globalThis) {
  return Boolean(
    scope
    && typeof scope.Worker === 'function'
    && scope.URL?.createObjectURL
    && scope.Blob,
  );
}

export function makeSemanticEmbeddingWorkerSource(
  model = DEFAULT_SEMANTIC_EMBEDDING_MODEL,
  transformersModule = SEMANTIC_TRANSFORMERS_JS_MODULE,
) {
  return `
import * as transformers from ${JSON.stringify(transformersModule)};

const { env, pipeline } = transformers;
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;

let encoder = null;
const progress = data => self.postMessage({ type:'progress', data });
self.postMessage({ type:'booted' });

// The CPU path (WASM), as before the Neural Engine option.
async function loadCpu() {
  const extractor = await pipeline(
    'feature-extraction',
    ${JSON.stringify(model.model)},
    {
      device:'wasm',
      dtype:${JSON.stringify(model.dtype)},
      progress_callback:progress,
    },
  );
  return async texts => {
    const out = [];
    for (const text of texts) out.push((await extractor(text, { pooling:'mean', normalize:true })).data);
    return out;
  };
}

// The Neural Engine through WebNN (naklios sdk/ane-embed.js) when the page passes its URL; the CPU otherwise or
// when its import or load check fails.
async function loadEncoder(aneUrl) {
  let createEmbedder = null, note = '';
  if (aneUrl) {
    try { ({ createEmbedder } = await import(aneUrl)); }
    catch (error) { note = 'the Neural Engine module did not load: ' + String(error?.message || error).slice(0, 160) + '.'; }
  }
  encoder = createEmbedder
    ? await createEmbedder(transformers, ${JSON.stringify(model.model)}, {
        loadCpu,
        progress,
        onBackend:(backend, why) => { if (encoder) self.postMessage({ type:'backend', backend, note:why }); },
      })
    : { backend:'cpu', note, embed:await loadCpu() };
  self.postMessage({
    type:'ready',
    model:${JSON.stringify(model.model)},
    dimensions:${Number(model.dimensions)},
    backend:encoder.backend,
    note:encoder.note,
  });
}

async function embed(texts, id) {
  if (!encoder) throw new Error('Load the semantic encoder first.');
  const vectors = [];
  for (let index = 0; index < texts.length; index++) {
    const [vector] = await encoder.embed([String(texts[index] || '')]);
    vectors.push(Array.from(vector));
    self.postMessage({
      type:'embed-progress',
      id,
      completed:index + 1,
      total:texts.length,
    });
  }
  self.postMessage({ type:'embeddings', id, vectors });
}

self.addEventListener('message', async ({ data }) => {
  try {
    if (data.type === 'load') await loadEncoder(data.aneUrl || null);
    else if (data.type === 'embed') await embed(data.texts || [], data.id);
  } catch (error) {
    self.postMessage({
      type:'error',
      id:data.id || null,
      data:error?.message || String(error),
    });
  }
});
`;
}

export class BrowserSemanticEncoder {
  constructor(scope = globalThis, {
    model = DEFAULT_SEMANTIC_EMBEDDING_MODEL,
  } = {}) {
    this.scope = scope;
    this.model = model;
    this.worker = null;
    this.workerUrl = null;
    this.ready = false;
    this.loading = false;
    this.status = semanticEmbeddingSupported(scope)
      ? 'Ready to load after background intelligence is enabled.'
      : 'Web Workers are unavailable in this browser.';
    this.progress = null;
    this.error = null;
    this.listeners = new Set();
    this.pending = new Map();
    this.loadPromise = null;
    this.loadResolve = null;
    this.loadReject = null;
  }

  get supported() {
    return semanticEmbeddingSupported(this.scope);
  }

  snapshot() {
    return {
      supported:this.supported,
      ready:this.ready,
      loading:this.loading,
      status:this.status,
      progress:this.progress,
      error:this.error,
      model:this.model,
      backend:this.backend || null,
      backendNote:this.backendNote || '',
    };
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  emit() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch (_) {}
    }
  }

  async hasCachedModel() {
    if (!this.scope.caches?.keys) return false;
    try {
      for (const cacheName of await this.scope.caches.keys()) {
        const cache = await this.scope.caches.open(cacheName);
        for (const request of await cache.keys()) {
          const url = decodeURIComponent(request.url);
          if (url.includes(this.model.model)) return true;
        }
      }
    } catch (_) {}
    return false;
  }

  ensureWorker() {
    if (this.worker) return;
    if (!this.supported) throw new Error('Semantic embedding is unavailable.');
    this.workerUrl = this.scope.URL.createObjectURL(
      new this.scope.Blob(
        [makeSemanticEmbeddingWorkerSource(this.model)],
        { type:'application/javascript' },
      ),
    );
    this.worker = new this.scope.Worker(this.workerUrl, { type:'module' });
    this.worker.addEventListener('message', (event) => {
      this.handleMessage(event.data);
    });
    this.worker.addEventListener('error', (event) => {
      event.preventDefault?.();
      this.fail(new Error(event.message || 'The semantic worker stopped.'));
    });
  }

  handleMessage(data) {
    if (data.type === 'booted') {
      this.status = 'Starting the compact semantic encoder…';
      this.emit();
      return;
    }
    if (data.type === 'progress') {
      const value = Number(data.data?.progress);
      this.progress = Number.isFinite(value)
        ? Math.max(0, Math.min(100, value))
        : null;
      this.status = this.progress == null
        ? 'Downloading semantic model files…'
        : 'Downloading semantic model… ' + Math.round(this.progress) + '%';
      this.emit();
      return;
    }
    if (data.type === 'backend') {
      this.backend = data.backend;
      this.backendNote = data.note || '';
      this.emit();
      return;
    }
    if (data.type === 'ready') {
      this.ready = true;
      this.loading = false;
      this.progress = 100;
      this.error = null;
      this.backend = data.backend || 'cpu';
      this.backendNote = data.note || '';
      this.status = this.model.label + ' is ready'
        + (this.backend === 'webnn-npu' ? ' on the Neural Engine.' : '.');
      this.loadResolve?.(this.snapshot());
      this.clearLoadPromise();
      this.emit();
      return;
    }
    if (data.type === 'embed-progress') {
      const request = this.pending.get(data.id);
      request?.onProgress?.({
        completed:Number(data.completed) || 0,
        total:Number(data.total) || 0,
      });
      return;
    }
    if (data.type === 'embeddings') {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      request.cleanup();
      request.resolve(data.vectors || []);
      return;
    }
    if (data.type === 'error') {
      const error = new Error(String(data.data || 'Semantic embedding failed.'));
      if (data.id && this.pending.has(data.id)) {
        const request = this.pending.get(data.id);
        this.pending.delete(data.id);
        request.cleanup();
        request.reject(error);
      } else {
        this.fail(error);
      }
    }
  }

  clearLoadPromise() {
    this.loadPromise = null;
    this.loadResolve = null;
    this.loadReject = null;
  }

  fail(error) {
    this.loading = false;
    this.ready = false;
    this.error = error.message;
    this.status = error.message;
    this.loadReject?.(error);
    this.clearLoadPromise();
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(error);
    }
    this.pending.clear();
    this.worker?.terminate();
    if (this.workerUrl) this.scope.URL.revokeObjectURL(this.workerUrl);
    this.worker = null;
    this.workerUrl = null;
    this.emit();
  }

  load() {
    if (this.ready) return Promise.resolve(this.snapshot());
    if (this.loadPromise) return this.loadPromise;
    this.ensureWorker();
    this.loading = true;
    this.error = null;
    this.status = 'Loading ' + this.model.label + '…';
    this.loadPromise = new Promise((resolve, reject) => {
      this.loadResolve = resolve;
      this.loadReject = reject;
    });
    this.worker.postMessage({ type:'load', aneUrl:aneEmbedUrl(this.scope) });
    this.emit();
    return this.loadPromise;
  }

  async embed(texts, { signal = null, onProgress = null } = {}) {
    if (!this.ready) await this.load();
    const values = (Array.isArray(texts) ? texts : [texts])
      .map((value) => String(value || '').trim());
    if (!values.length) return [];
    const id = this.scope.crypto?.randomUUID?.()
      || Date.now().toString(36) + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const abort = () => {
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        request.cleanup();
        const error = new Error('Semantic embedding was stopped.');
        error.name = 'AbortError';
        reject(error);
      };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      this.pending.set(id, { resolve, reject, cleanup, onProgress });
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once:true });
      this.worker.postMessage({ type:'embed', id, texts:values });
    });
  }

  dispose() {
    this.worker?.terminate();
    if (this.workerUrl) this.scope.URL.revokeObjectURL(this.workerUrl);
    this.worker = null;
    this.workerUrl = null;
    this.ready = false;
    this.loading = false;
    this.clearLoadPromise();
    const error = new Error('Semantic encoder was disposed.');
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(error);
    }
    this.pending.clear();
  }
}
