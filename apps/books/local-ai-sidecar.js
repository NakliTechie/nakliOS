export const TRANSFORMERS_JS_VERSION = '4.2.0';
export const TRANSFORMERS_JS_MODULE =
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@' +
  TRANSFORMERS_JS_VERSION + '/+esm';
export const WLLAMA_VERSION = '3.4.1';
export const WLLAMA_MODULE =
  'https://cdn.jsdelivr.net/npm/@wllama/wllama@' +
  WLLAMA_VERSION + '/esm/index.js';
export const WLLAMA_WASM =
  'https://cdn.jsdelivr.net/npm/@wllama/wllama@' +
  WLLAMA_VERSION + '/esm/wasm/wllama.wasm';

export const DEFAULT_LOCAL_AI_MODEL_KEY = 'gemma-4-e2b';
export const FIREFOX_LOCAL_AI_MODEL_KEY = 'lfm2-230m-wasm';
export const LOCAL_AI_MODELS = Object.freeze([
  Object.freeze({
    key:'gemma-4-e2b',
    runtime:'transformers-webgpu',
    providerClass:'browser-local',
    destination:'browser-webgpu',
    endpoint:null,
    model:'onnx-community/gemma-4-E2B-it-ONNX',
    label:'Gemma 4 E2B',
    shortLabel:'E2B',
    dtype:'q4f16',
    approximateDownloadBytes:3_400_000_000,
    recommended:true,
  }),
  Object.freeze({
    key:'gemma-4-e4b',
    runtime:'transformers-webgpu',
    providerClass:'browser-local',
    destination:'browser-webgpu',
    endpoint:null,
    model:'onnx-community/gemma-4-E4B-it-ONNX',
    label:'Gemma 4 E4B',
    shortLabel:'E4B',
    dtype:'q4f16',
    approximateDownloadBytes:5_200_000_000,
    recommended:false,
  }),
  Object.freeze({
    key:'lfm2-230m-wasm',
    runtime:'wllama-cpu',
    providerClass:'browser-local',
    destination:'browser-wasm',
    endpoint:null,
    model:
      'https://huggingface.co/LiquidAI/LFM2.5-230M-GGUF/resolve/main/' +
      'LFM2.5-230M-Q5_K_M.gguf',
    label:'LFM2.5 230M',
    shortLabel:'LFM2',
    dtype:'Q5_K_M',
    approximateDownloadBytes:170_000_000,
    recommended:false,
    recommendedOnFirefox:true,
  }),
]);
const LOCAL_AI_MODEL_BY_KEY = new Map(
  LOCAL_AI_MODELS.map((model) => [model.key, model]),
);

export function localAiModel(modelKey = DEFAULT_LOCAL_AI_MODEL_KEY) {
  return LOCAL_AI_MODEL_BY_KEY.get(String(modelKey))
    || LOCAL_AI_MODEL_BY_KEY.get(DEFAULT_LOCAL_AI_MODEL_KEY);
}

export const LOCAL_AI_MODEL = localAiModel();

function abortError() {
  const error = new Error('Local generation was stopped.');
  error.name = 'AbortError';
  return error;
}

export function browserLocalProviderDescriptor(model = LOCAL_AI_MODEL) {
  return {
    providerClass:model.providerClass,
    destination:model.destination,
    endpoint:model.endpoint,
    model:model.model,
  };
}

function browserWorkerSupported(scope) {
  return Boolean(
    scope
    && typeof scope.Worker === 'function'
    && scope.URL?.createObjectURL
    && scope.Blob,
  );
}

export function isFirefoxBrowser(scope = globalThis) {
  const userAgent = String(scope?.navigator?.userAgent || '');
  return /Firefox\/|FxiOS\//i.test(userAgent) && !/Seamonkey\//i.test(userAgent);
}

export function recommendedLocalAiModelKey(scope = globalThis) {
  return isFirefoxBrowser(scope)
    ? FIREFOX_LOCAL_AI_MODEL_KEY
    : DEFAULT_LOCAL_AI_MODEL_KEY;
}

export function browserLocalAiSupported(
  scope = globalThis,
  model = LOCAL_AI_MODEL,
) {
  if (!browserWorkerSupported(scope)) return false;
  if (model.runtime === 'wllama-cpu') {
    return typeof scope.WebAssembly === 'object';
  }
  return Boolean(
    !isFirefoxBrowser(scope)
    && scope.navigator
    && scope.navigator.gpu,
  );
}

export async function preflightBrowserLocalAi(
  scope = globalThis,
  model = LOCAL_AI_MODEL,
) {
  if (!browserWorkerSupported(scope)) {
    return {
      supported:false,
      code:'worker-unavailable',
      runtime:model.runtime,
      message:
        'This browser cannot start the private AI worker. Use Ollama, ' +
        'LM Studio, NakliOS AI, or remote BYOK.',
    };
  }
  if (model.runtime === 'wllama-cpu') {
    if (typeof scope.WebAssembly !== 'object') {
      return {
        supported:false,
        code:'wasm-unavailable',
        runtime:model.runtime,
        message:
          'WebAssembly is unavailable. Use Ollama, LM Studio, NakliOS AI, ' +
          'or remote BYOK.',
      };
    }
    return {
      supported:true,
      code:isFirefoxBrowser(scope) ? 'firefox-wasm' : 'wasm',
      runtime:model.runtime,
      browser:isFirefoxBrowser(scope) ? 'firefox' : 'other',
      message:isFirefoxBrowser(scope)
        ? 'Firefox detected. Lorewell will use the smaller CPU/WebAssembly model.'
        : 'The CPU/WebAssembly model is available.',
    };
  }
  if (isFirefoxBrowser(scope)) {
    return {
      supported:false,
      code:'firefox-webgpu',
      runtime:model.runtime,
      browser:'firefox',
      message:
        'Gemma’s ONNX/WebGPU runtime is not supported in Firefox. Use the ' +
        'smaller CPU/WebAssembly model or a local endpoint.',
    };
  }
  const gpu = scope.navigator?.gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') {
    return {
      supported:false,
      code:'webgpu-unavailable',
      runtime:model.runtime,
      message:
        'WebGPU is unavailable. Use the CPU/WebAssembly model, Ollama, ' +
        'LM Studio, NakliOS AI, or remote BYOK.',
    };
  }
  let adapter;
  try {
    adapter = await gpu.requestAdapter({ powerPreference:'high-performance' });
  } catch (error) {
    return {
      supported:false,
      code:'webgpu-adapter-error',
      runtime:model.runtime,
      technicalDetails:String(error?.message || error),
      message:
        'The browser could not open a WebGPU adapter. Check hardware ' +
        'acceleration or use the CPU/WebAssembly model.',
    };
  }
  if (!adapter) {
    return {
      supported:false,
      code:'webgpu-adapter-unavailable',
      runtime:model.runtime,
      message:
        'No WebGPU adapter is available. Check hardware acceleration or use ' +
        'the CPU/WebAssembly model.',
    };
  }
  if (adapter.features && !adapter.features.has('shader-f16')) {
    return {
      supported:false,
      code:'shader-f16-unavailable',
      runtime:model.runtime,
      message:
        'This GPU does not expose the float16 feature Gemma needs. Use the ' +
        'CPU/WebAssembly model or a local endpoint.',
    };
  }
  return {
    supported:true,
    code:'webgpu-ready',
    runtime:model.runtime,
    browser:'chromium',
    features:adapter.features ? Array.from(adapter.features) : [],
    limits:{
      maxBufferSize:Number(adapter.limits?.maxBufferSize) || null,
      maxStorageBufferBindingSize:
        Number(adapter.limits?.maxStorageBufferBindingSize) || null,
    },
    message:'WebGPU adapter ready.',
  };
}

export function classifyLocalAiError(
  error,
  { model = LOCAL_AI_MODEL, scope = globalThis } = {},
) {
  const technicalDetails = String(error?.message || error || 'Unknown error');
  const lower = technicalDetails.toLowerCase();
  if (
    model.runtime === 'transformers-webgpu'
    && isFirefoxBrowser(scope)
  ) {
    return {
      code:'firefox-webgpu',
      message:
        'Gemma’s current WebGPU runtime is not supported in Firefox. Select ' +
        'LFM2.5 230M (CPU/WebAssembly) or use Ollama or LM Studio.',
      technicalDetails,
      actions:['use-wasm', 'endpoint'],
    };
  }
  if (
    /deserialize tensor|memory copy|external data file|can't create a session/.test(lower)
    || /out of memory|allocation failed|failed to allocate/.test(lower)
  ) {
    const wasm = model.runtime === 'wllama-cpu';
    return {
      code:'model-memory',
      message:wasm
        ? 'The CPU/WebAssembly model could not reserve enough memory. Close ' +
          'memory-heavy tabs and retry, or use Ollama/LM Studio.'
        :
        'The model could not be copied into memory. Close memory-heavy tabs, ' +
        'clear this model’s cache, and retry. The smaller CPU/WebAssembly ' +
        'model or Ollama/LM Studio remains available.',
      technicalDetails,
      actions:wasm
        ? ['endpoint']
        : ['clear-cache', 'use-wasm', 'endpoint'],
    };
  }
  if (
    /failed to fetch|networkerror|load external data|unexpected end|cache/.test(lower)
  ) {
    return {
      code:'model-download',
      message:
        'The model download is incomplete or blocked. Clear this model’s ' +
        'cache and retry, or use Ollama/LM Studio.',
      technicalDetails,
      actions:['clear-cache', 'endpoint'],
    };
  }
  if (/device lost|webgpu|gpu device|requestadapter|shader-f16/.test(lower)) {
    return {
      code:'webgpu-device',
      message:
        'The WebGPU device could not start. Check browser hardware ' +
        'acceleration, try the CPU/WebAssembly model, or use Ollama/LM Studio.',
      technicalDetails,
      actions:['use-wasm', 'endpoint'],
    };
  }
  return {
    code:'runtime-error',
    message:model.runtime === 'wllama-cpu'
      ? 'The CPU/WebAssembly runtime stopped. Retry or use Ollama/LM Studio.'
      :
      'The private AI runtime stopped. Retry, choose the smaller ' +
      'CPU/WebAssembly model, or use Ollama/LM Studio.',
    technicalDetails,
    actions:model.runtime === 'wllama-cpu'
      ? ['endpoint']
      : ['clear-cache', 'use-wasm', 'endpoint'],
  };
}

export function modelCacheRequestMatches(request, model = LOCAL_AI_MODEL) {
  const raw = String(request?.url || request || '');
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch (_) {}
  if (model.runtime === 'wllama-cpu') {
    return decoded === model.model || decoded.includes(model.model);
  }
  return decoded.includes(model.model);
}

export function makeLocalAiWorkerSource(
  modelDefinition = LOCAL_AI_MODEL,
  transformersModule = TRANSFORMERS_JS_MODULE,
) {
  if (modelDefinition.runtime === 'wllama-cpu') {
    return makeWllamaWorkerSource(modelDefinition);
  }
  return `
import {
  env,
  AutoProcessor,
  Gemma4ForConditionalGeneration,
  TextStreamer,
  InterruptableStoppingCriteria,
} from ${JSON.stringify(transformersModule)};

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;

let processor = null;
let model = null;
let activeRequestId = null;
let stopRequestedId = null;
const stoppingCriteria = new InterruptableStoppingCriteria();
const progress = data => self.postMessage({ type:'progress', data });
self.postMessage({ type:'booted' });

async function loadModel() {
  self.postMessage({ type:'status', data:'Loading tokenizer and processor…' });
  processor = await AutoProcessor.from_pretrained(
    ${JSON.stringify(modelDefinition.model)},
    { progress_callback:progress },
  );
  self.postMessage({
    type:'status',
    data:${JSON.stringify('Loading ' + modelDefinition.label + ' into WebGPU…')},
  });
  model = await Gemma4ForConditionalGeneration.from_pretrained(
    ${JSON.stringify(modelDefinition.model)},
    {
      dtype:${JSON.stringify(modelDefinition.dtype)},
      device:'webgpu',
      progress_callback:progress,
    },
  );
  self.postMessage({
    type:'status',
    data:${JSON.stringify('Warming up ' + modelDefinition.label + '…')},
  });
  const warmup = processor.tokenizer('a');
  await model.generate({ ...warmup, max_new_tokens:1 });
  self.postMessage({ type:'ready' });
}

async function generate(messages, id, maxTokens) {
  activeRequestId = id;
  stoppingCriteria.reset();
  const normalizedMessages = messages.map(message => ({
    role:String(message?.role || 'user'),
    content:['system', 'developer'].includes(String(message?.role || ''))
      ? String(message?.content || '')
      : Array.isArray(message?.content)
      ? message.content
      : [{ type:'text', text:String(message?.content || '') }],
  }));
  const streamer = new TextStreamer(processor.tokenizer, {
    skip_prompt:true,
    skip_special_tokens:true,
    callback_function:token => {
      if (stopRequestedId !== id) self.postMessage({ type:'token', id, token });
    },
  });
  const prompt = processor.apply_chat_template(normalizedMessages, {
    enable_thinking:false,
    add_generation_prompt:true,
  });
  const inputs = await processor(prompt, null, null, {
    add_special_tokens:false,
  });
  await model.generate({
    ...inputs,
    max_new_tokens:Math.min(2048, Math.max(1, Number(maxTokens) || 600)),
    do_sample:false,
    streamer,
    stopping_criteria:stoppingCriteria,
  });
  self.postMessage({ type:stopRequestedId === id ? 'stopped' : 'complete', id });
  stopRequestedId = null;
  activeRequestId = null;
}

self.addEventListener('message', async ({ data }) => {
  try {
    if (data.type === 'load') {
      await loadModel();
    } else if (data.type === 'generate') {
      if (!model || !processor) {
        throw new Error(
          ${JSON.stringify('Load ' + modelDefinition.label + ' first.')},
        );
      }
      await generate(data.messages || [], data.id, data.maxTokens);
    } else if (data.type === 'stop') {
      if (!data.id || data.id === activeRequestId) {
        stopRequestedId = activeRequestId;
        stoppingCriteria.interrupt();
      }
    }
  } catch (error) {
    self.postMessage({
      type:'error',
      id:data.id || null,
      data:error?.message || String(error),
    });
    if (data.type === 'generate') activeRequestId = null;
  }
});
`;
}

export function makeWllamaWorkerSource(
  modelDefinition = localAiModel(FIREFOX_LOCAL_AI_MODEL_KEY),
  wllamaModule = WLLAMA_MODULE,
  wllamaWasm = WLLAMA_WASM,
) {
  return `
import { Wllama } from ${JSON.stringify(wllamaModule)};

if (typeof self.document === 'undefined') {
  self.document = { baseURI:self.location.href };
}

const WASM = { default:${JSON.stringify(wllamaWasm)} };
let runtime = null;
let activeRequestId = null;
let abortController = null;
const post = message => self.postMessage(message);
post({ type:'booted' });

async function loadModel() {
  post({
    type:'status',
    data:${JSON.stringify('Loading ' + modelDefinition.label + ' on CPU/WebAssembly…')},
  });
  runtime = new Wllama(WASM, {
    logger:{
      debug() {},
      log() {},
      warn() {},
      error(message) { console.error('[wllama]', message); },
    },
  });
  await runtime.loadModelFromUrl(
    ${JSON.stringify(modelDefinition.model)},
    {
      n_ctx:4096,
      n_threads:1,
      n_gpu_layers:0,
      progressCallback:({ loaded, total }) => post({
        type:'progress',
        data:{ loaded, total, file:'model.gguf' },
      }),
    },
  );
  post({ type:'ready', backend:'cpu-wasm' });
}

async function generate(messages, id, maxTokens) {
  if (!runtime) throw new Error(
    ${JSON.stringify('Load ' + modelDefinition.label + ' first.')},
  );
  activeRequestId = id;
  abortController = new AbortController();
  const normalized = messages.map(message => ({
    role:['system', 'assistant', 'user'].includes(String(message?.role || ''))
      ? String(message.role)
      : 'system',
    content:Array.isArray(message?.content)
      ? message.content
          .filter(block => block?.type === 'text')
          .map(block => String(block.text || ''))
          .join('\\n')
      : String(message?.content || ''),
  }));
  try {
    const stream = await runtime.createChatCompletion({
      messages:normalized,
      stream:true,
      max_tokens:Math.min(1024, Math.max(1, Number(maxTokens) || 600)),
      temperature:0.3,
      top_p:0.95,
      top_k:20,
      abortSignal:abortController.signal,
    });
    for await (const chunk of stream) {
      const token = chunk?.choices?.[0]?.delta?.content;
      if (token) post({ type:'token', id, token });
    }
    post({ type:'complete', id });
  } catch (error) {
    if (error?.name === 'AbortError') {
      post({ type:'stopped', id });
    } else {
      throw error;
    }
  } finally {
    activeRequestId = null;
    abortController = null;
  }
}

self.addEventListener('message', async ({ data }) => {
  try {
    if (data.type === 'load') {
      await loadModel();
    } else if (data.type === 'generate') {
      await generate(data.messages || [], data.id, data.maxTokens);
    } else if (data.type === 'stop') {
      if (!data.id || data.id === activeRequestId) abortController?.abort();
    }
  } catch (error) {
    post({
      type:'error',
      id:data.id || null,
      data:error?.message || String(error),
    });
  }
});
`;
}

export class BrowserLocalAi {
  constructor(scope = globalThis, {
    modelKey = DEFAULT_LOCAL_AI_MODEL_KEY,
    loadIdleTimeoutMs = 120_000,
    loadTotalTimeoutMs = 30 * 60_000,
    stopTimeoutMs = 10_000,
  } = {}) {
    this.scope = scope;
    const requestedModel = localAiModel(modelKey);
    this.model = isFirefoxBrowser(scope)
      && requestedModel.runtime === 'transformers-webgpu'
      ? localAiModel(FIREFOX_LOCAL_AI_MODEL_KEY)
      : requestedModel;
    this.worker = null;
    this.workerUrl = null;
    this.ready = false;
    this.loading = false;
    this.progress = null;
    this.progressLabel = null;
    this.compatibility = null;
    this.diagnostic = null;
    this.status = browserLocalAiSupported(scope, this.model)
      ? this.model.runtime === 'wllama-cpu' && isFirefoxBrowser(scope)
        ? 'Firefox detected. Ready to load the CPU/WebAssembly model.'
        : 'Ready to check this device and load on demand.'
      : 'This model runtime is unavailable in this browser.';
    this.error = null;
    this.listeners = new Set();
    this.pending = new Map();
    this.loadPromise = null;
    this.loadResolve = null;
    this.loadReject = null;
    this.loadIdleTimeoutMs = loadIdleTimeoutMs;
    this.loadTotalTimeoutMs = loadTotalTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.loadIdleTimer = null;
    this.loadTotalTimer = null;
    this.setTimer = scope.setTimeout?.bind(scope) || globalThis.setTimeout.bind(globalThis);
    this.clearTimer = scope.clearTimeout?.bind(scope) || globalThis.clearTimeout.bind(globalThis);
  }

  get supported() {
    if (this.compatibility) return this.compatibility.supported;
    return browserLocalAiSupported(this.scope, this.model);
  }

  descriptor() {
    return browserLocalProviderDescriptor(this.model);
  }

  snapshot() {
    return {
      supported:this.supported,
      ready:this.ready,
      loading:this.loading,
      progress:this.progress,
      progressLabel:this.progressLabel,
      status:this.status,
      error:this.error,
      diagnostic:this.diagnostic,
      compatibility:this.compatibility,
      firefox:isFirefoxBrowser(this.scope),
      model:this.model,
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

  selectModel(modelKey) {
    const next = localAiModel(modelKey);
    if (next.key === this.model.key) return this.snapshot();
    this.dispose();
    this.model = next;
    this.compatibility = null;
    this.diagnostic = null;
    this.status = browserLocalAiSupported(this.scope, next)
      ? 'Ready to check this device and load ' + next.label + '.'
      : next.runtime === 'transformers-webgpu' && isFirefoxBrowser(this.scope)
        ? 'Gemma’s WebGPU runtime is unavailable in Firefox. Choose the ' +
          'CPU/WebAssembly model.'
        : 'This model runtime is unavailable in this browser.';
    this.emit();
    return this.snapshot();
  }

  supportsModel(model = this.model) {
    return browserLocalAiSupported(this.scope, model);
  }

  async checkCompatibility() {
    const checkedModel = this.model;
    const result = await preflightBrowserLocalAi(this.scope, checkedModel);
    if (checkedModel.key !== this.model.key) return this.compatibility;
    this.compatibility = result;
    if (!this.loading && !this.ready && !this.diagnostic) {
      this.status = result.message;
      this.error = result.technicalDetails || null;
      this.emit();
    }
    return result;
  }

  async hasCachedModel(model = this.model) {
    if (!this.scope.caches?.keys) return false;
    try {
      const names = await this.scope.caches.keys();
      for (const name of names) {
        const cache = await this.scope.caches.open(name);
        const keys = await cache.keys();
        if (keys.some((request) => modelCacheRequestMatches(request, model))) {
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  async clearCachedModel(model = this.model) {
    if (!this.scope.caches?.keys) {
      throw new Error('This browser does not expose model cache controls.');
    }
    if (this.loading || this.ready) this.dispose();
    let deleted = 0;
    const names = await this.scope.caches.keys();
    for (const name of names) {
      const cache = await this.scope.caches.open(name);
      const keys = await cache.keys();
      for (const request of keys) {
        if (
          modelCacheRequestMatches(request, model)
          && await cache.delete(request)
        ) {
          deleted++;
        }
      }
    }
    this.diagnostic = null;
    this.error = null;
    this.status = deleted
      ? 'Cleared ' + deleted + ' cached model file' +
        (deleted === 1 ? '' : 's') + '. Load again to download a clean copy.'
      : 'No cached files for ' + model.label +
        ' were found. You can retry the load.';
    this.emit();
    return { deleted, model:model.key };
  }

  ensureWorker() {
    if (this.worker) return;
    if (!this.supported) {
      throw new Error(
        this.compatibility?.message
        || 'This local runtime is unavailable. Use another model or provider.',
      );
    }
    const source = makeLocalAiWorkerSource(this.model);
    this.workerUrl = this.scope.URL.createObjectURL(
      new this.scope.Blob([source], { type:'application/javascript' }),
    );
    this.worker = new this.scope.Worker(this.workerUrl, { type:'module' });
    this.worker.addEventListener('message', (event) => this.handleMessage(event.data));
    this.worker.addEventListener('error', (event) => {
      event.preventDefault?.();
      const location = event.filename
        ? ' (' + event.filename + ':' + (event.lineno || 0) + ')'
        : '';
      this.failAll(new Error(
        (event.message || 'The browser blocked the local AI runtime.') + location,
      ));
    });
  }

  handleMessage(data) {
    if (data.type === 'booted') {
      const runtime = this.model.runtime === 'wllama-cpu'
        ? 'wllama'
        : 'Transformers.js';
      this.status = runtime + ' is ready. Starting ' + this.model.label + '…';
      this.touchLoadWatchdog();
      this.emit();
      return;
    }
    if (data.type === 'progress') {
      const loaded = Number(data.data?.loaded);
      const total = Number(data.data?.total);
      const raw = Number.isFinite(loaded) && Number.isFinite(total) && total > 0
        ? loaded / total * 100
        : Number(data.data?.progress);
      this.progress = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : null;
      const file = String(
        data.data?.file || data.data?.name || data.data?.status || '',
      ).split(/[\\/]/).pop();
      this.progressLabel = file || null;
      this.status = this.progress == null
        ? 'Downloading model files…'
        : 'Downloading ' + (this.progressLabel || 'current model file') +
          '… ' + Math.round(this.progress) + '%';
      this.touchLoadWatchdog();
      this.emit();
      return;
    }
    if (data.type === 'status') {
      this.status = String(data.data || 'Loading…');
      this.touchLoadWatchdog();
      this.emit();
      return;
    }
    if (data.type === 'ready') {
      this.ready = true;
      this.loading = false;
      this.progress = 100;
      this.progressLabel = null;
      this.status = this.model.label + ' is ready on this device.';
      this.error = null;
      this.diagnostic = null;
      this.loadResolve?.(this.snapshot());
      this.clearLoadPromise();
      this.clearLoadWatchdogs();
      this.emit();
      return;
    }
    if (data.type === 'token') {
      const request = this.pending.get(data.id);
      if (!request || request.aborted) return;
      request.text += String(data.token || '');
      request.onDelta(request.text);
      return;
    }
    if (data.type === 'complete') {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      request.cleanup();
      if (request.aborted) return;
      if (!request.text.trim()) {
        request.reject(new Error(
          this.model.label + ' returned no readable answer.',
        ));
      } else {
        request.resolve({
          text:request.text.trim(),
          model:this.model.model,
          usage:null,
        });
      }
      return;
    }
    if (data.type === 'stopped') {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      request.cleanup();
      if (!request.aborted) request.reject(abortError());
      return;
    }
    if (data.type === 'error') {
      const error = new Error(String(data.data || 'Local AI failed.'));
      if (data.id && this.pending.has(data.id)) {
        const request = this.pending.get(data.id);
        this.pending.delete(data.id);
        request.cleanup();
        const diagnostic = classifyLocalAiError(error, {
          model:this.model,
          scope:this.scope,
        });
        request.reject(new Error(diagnostic.message));
      } else if (this.loading) {
        this.reportFailure(error);
      }
    }
  }

  clearLoadPromise() {
    this.loadPromise = null;
    this.loadResolve = null;
    this.loadReject = null;
  }

  clearLoadWatchdogs() {
    if (this.loadIdleTimer) this.clearTimer(this.loadIdleTimer);
    if (this.loadTotalTimer) this.clearTimer(this.loadTotalTimer);
    this.loadIdleTimer = null;
    this.loadTotalTimer = null;
  }

  touchLoadWatchdog() {
    if (!this.loading) return;
    if (this.loadIdleTimer) this.clearTimer(this.loadIdleTimer);
    this.loadIdleTimer = this.setTimer(() => {
      if (this.loading) this.reportFailure(new Error(
        'The model download stopped making progress. Retry the load or clear its cache.',
      ));
    }, this.loadIdleTimeoutMs);
  }

  async load() {
    if (this.ready) return this.snapshot();
    if (this.loadPromise) return this.loadPromise;
    const compatibility = await this.checkCompatibility();
    if (!compatibility?.supported) {
      const error = new Error(
        compatibility?.message || 'This local model is unavailable.',
      );
      this.reportFailure(error);
      throw error;
    }
    this.ensureWorker();
    this.loading = true;
    this.progress = null;
    this.progressLabel = null;
    this.error = null;
    this.diagnostic = null;
    this.status = 'Starting the local model…';
    this.loadPromise = new Promise((resolve, reject) => {
      this.loadResolve = resolve;
      this.loadReject = reject;
    });
    this.emit();
    this.clearLoadWatchdogs();
    this.touchLoadWatchdog();
    this.loadTotalTimer = this.setTimer(() => {
      if (this.loading) this.reportFailure(new Error(
        'The model did not finish loading within 30 minutes. Retry when the device has more free memory.',
      ));
    }, this.loadTotalTimeoutMs);
    this.worker.postMessage({ type:'load' });
    return this.loadPromise;
  }

  generate(messages, {
    signal,
    maxTokens = 1200,
    onStatus = () => {},
    onDelta = () => {},
  } = {}) {
    if (!this.ready || !this.worker) {
      return Promise.reject(new Error(
        'Load ' + this.model.label + ' before asking Lorewell AI.',
      ));
    }
    if (this.pending.size) {
      return Promise.reject(new Error(
        this.model.label + ' is already answering another request.',
      ));
    }
    const id = this.scope.crypto?.randomUUID?.()
      || 'local_' + Date.now().toString(36);
    onStatus('generating');
    return new Promise((resolve, reject) => {
      let stopTimer = null;
      const abort = () => {
        this.worker?.postMessage({ type:'stop', id });
        const request = this.pending.get(id);
        if (!request || request.aborted) return;
        request.aborted = true;
        reject(abortError());
        stopTimer = this.setTimer(() => {
          if (!this.pending.has(id)) return;
          this.stopWorker(abortError(), { report:false });
          this.status = 'Generation was stopped. Load the model again to continue.';
          this.emit();
        }, this.stopTimeoutMs);
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', abort);
        if (stopTimer) this.clearTimer(stopTimer);
        stopTimer = null;
      };
      this.pending.set(id, {
        resolve,
        reject,
        cleanup,
        onDelta,
        text:'',
        aborted:false,
      });
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once:true });
      this.worker.postMessage({
        type:'generate',
        id,
        messages,
        maxTokens,
      });
    });
  }

  stopWorker(error, { report = true } = {}) {
    this.clearLoadWatchdogs();
    this.worker?.terminate();
    if (this.workerUrl) this.scope.URL.revokeObjectURL(this.workerUrl);
    this.worker = null;
    this.workerUrl = null;
    if (this.loading) {
      this.loading = false;
      this.loadReject?.(error);
      this.clearLoadPromise();
    }
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(error);
    }
    this.pending.clear();
    this.ready = false;
    this.progress = null;
    this.progressLabel = null;
    if (report) {
      const diagnostic = classifyLocalAiError(error, {
        model:this.model,
        scope:this.scope,
      });
      this.diagnostic = diagnostic;
      this.error = diagnostic.technicalDetails;
      this.status = diagnostic.message;
      this.emit();
    } else {
      this.error = null;
      this.diagnostic = null;
      this.status = this.supported
        ? 'Ready to load on demand.'
        : 'This model runtime is unavailable in this browser.';
    }
  }

  failAll(error) {
    this.reportFailure(error);
  }

  cancelLoad() {
    if (!this.loading) return false;
    this.stopWorker(abortError(), { report:false });
    this.status = 'Model loading cancelled. Ready to retry.';
    this.emit();
    return true;
  }

  reportFailure(error) {
    const diagnostic = classifyLocalAiError(error, {
      model:this.model,
      scope:this.scope,
    });
    const friendlyError = new Error(diagnostic.message);
    this.stopWorker(friendlyError, { report:false });
    this.diagnostic = diagnostic;
    this.error = diagnostic.technicalDetails;
    this.status = diagnostic.message;
    this.emit();
  }

  dispose() {
    this.stopWorker(abortError(), { report:false });
  }
}
