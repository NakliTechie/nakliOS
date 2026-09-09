// Main-thread proxy for Kiln's dedicated Pyodide Worker.
//
// Storage snapshots cross the Worker boundary at cell boundaries. Mutations
// flow back through the governed Rig face: writes invoke `fs.write`; removals
// become staged `fs.remove` proposals. The Worker never receives the backend,
// grant, registry, or operation log objects.

import { PYODIDE_INDEX_URL } from './pyodide-runtime.mjs';

const enc = new TextEncoder();

// Truncate a UTF-8 byte array to at most `maxBytes` without splitting a
// multibyte sequence: back off from the cut point over any continuation bytes
// (0b10xxxxxx) so a partial trailing codepoint is dropped, not corrupted (L-K7).
export function truncateUtf8Bytes(bytes, maxBytes) {
  if (bytes.length <= maxBytes) return bytes;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

// The set of registry command names the generated Python module actually
// exposes. Every generated binding forwards through `_rig_invoke("<command>",
// …)`, so the invoke targets in the source ARE the binding manifest. Locking
// rig-call to this set stops forged `postMessage({type:'rig-call', name})`
// reaching a command with no Python binding (M-K2).
export function deriveRigAllowlist(source) {
  const names = new Set();
  const re = /_rig_invoke\(\s*"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = re.exec(source || '')) !== null) names.add(match[1]);
  return names;
}

function bytesEqual(a, b) {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function bytesToBase64(bytes) {
  let binary = '';
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) {
    binary += String.fromCharCode(...bytes.subarray(i, i + size));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toRigJsonValue(value) {
  if (value instanceof Uint8Array) {
    return { __kiln_type: 'bytes', base64: bytesToBase64(value) };
  }
  if (value instanceof ArrayBuffer) return toRigJsonValue(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return toRigJsonValue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Array.isArray(value)) return value.map(toRigJsonValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = toRigJsonValue(child);
    return out;
  }
  return value;
}

export function fromRigJsonValue(value) {
  if (value && typeof value === 'object' && value.__kiln_type === 'bytes') {
    return base64ToBytes(value.base64);
  }
  if (Array.isArray(value)) return value.map(fromRigJsonValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = fromRigJsonValue(child);
    return out;
  }
  return value;
}

export async function snapshotBridge(fsBridge) {
  if (!fsBridge) return { dirs: [], files: [] };
  const listed = await fsBridge.list('', { recursive: true });
  if (!listed.ok && listed.code === 'ENOENT') return { dirs: [], files: [] };
  if (!listed.ok) throw new Error(listed.message || 'Could not list the Kiln mount');
  const dirs = listed.entries.filter((entry) => entry.type === 'dir').map((entry) => entry.path);
  const files = [];
  for (const entry of listed.entries.filter((candidate) => candidate.type === 'file')) {
    const read = await fsBridge.read(entry.path);
    if (!read.ok) throw new Error(read.message || `Could not read ${entry.path}`);
    files.push({ path: entry.path, data: read.data });
  }
  return { dirs, files };
}

function snapshotMaps(snapshot) {
  return {
    dirs: new Set(snapshot.dirs || []),
    files: new Map((snapshot.files || []).map((file) => [file.path, file.data])),
  };
}

export async function syncWorkerSnapshot({ before, after, face, fsBridge, allowUngoverned = false }) {
  const prior = snapshotMaps(before || { dirs: [], files: [] });
  const next = snapshotMaps(after || { dirs: [], files: [] });
  const result = { writes: [], directories: [], staged: [], errors: [] };
  const invoke = face
    ? (name, input) => face.invoke(name, input)
    : async (name, input) => {
        // No governed face. Face-less writes bypass the grant + op-log, so they
        // are refused unless the session opted in explicitly (M-K5).
        if (!allowUngoverned) {
          return {
            ok: false, code: 'EUNGOVERNED',
            message: `refusing ungoverned ${name}: this Kiln session has no Rig face (set allowUngovernedWrites to permit direct fsBridge writes)`,
          };
        }
        const op = name.slice(3);
        if (op === 'write') return fsBridge.write(input.path, input.data);
        if (op === 'mkdir') return fsBridge.mkdir(input.path, { createParents: input.createParents });
        if (op === 'remove') return fsBridge.remove(input.path, { recursive: input.recursive });
        return { ok: false, code: 'ENOCMD', message: `Unsupported filesystem sync command: ${name}` };
      };

  for (const path of [...next.dirs].sort((a, b) => a.split('/').length - b.split('/').length)) {
    if (prior.dirs.has(path)) continue;
    const out = await invoke('fs.mkdir', { path, createParents: true });
    if (out.ok) result.directories.push(path);
    else if (out.staged) result.staged.push(out);
    else result.errors.push({ command: 'fs.mkdir', path, result: out });
  }
  for (const [path, data] of next.files) {
    if (prior.files.has(path) && bytesEqual(prior.files.get(path), data)) continue;
    const out = await invoke('fs.write', { path, data, createParents: true });
    if (out.ok) result.writes.push(path);
    else if (out.staged) result.staged.push(out);
    else result.errors.push({ command: 'fs.write', path, result: out });
  }
  const removedFiles = [...prior.files.keys()].filter((path) => !next.files.has(path));
  const removedDirs = [...prior.dirs].filter((path) => !next.dirs.has(path))
    .sort((a, b) => b.split('/').length - a.split('/').length);
  for (const path of [...removedFiles, ...removedDirs]) {
    const out = await invoke('fs.remove', { path, recursive: true });
    if (out.ok) continue;
    if (out.staged) result.staged.push(out);
    else if (out.code !== 'ENOENT') result.errors.push({ command: 'fs.remove', path, result: out });
  }
  return result;
}

// A request id doubles as the response-channel authentication tag (Low11). The
// Worker echoes it verbatim in every `{type:'response', id, ...}`, and the main
// thread settles the matching pending request by id. Because the Rig
// back-channel needs `postMessage` un-neutered, model-authored Python shares the
// Worker's `postMessage` and can forge a `response`. A guessable id (the old
// `++counter`) let a forged response with the in-flight id settle a running
// runCode with an attacker-chosen snapshot/namespace. A cryptographically
// random id is a per-request nonce the forger cannot predict; it lives only in
// this module's `pending` map on the main thread — never on any Worker global
// that `js.<x>` from Python can read. The counter prefix keeps ids unique even
// across an astronomically unlikely RNG collision.
// Residual (cannot be closed from this file alone): a session that plants its
// own `self` 'message' listener inside the Worker can read the id off the
// incoming request message. Closing that needs the trusted Worker `reply` in
// worker.mjs to carry a Worker-closure session nonce Python never observes —
// out of this cluster's file scope; see the handback.
function randomRequestId(counter) {
  const c = globalThis.crypto;
  let rand;
  if (c && typeof c.randomUUID === 'function') {
    rand = c.randomUUID();
  } else if (c && typeof c.getRandomValues === 'function') {
    rand = Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  } else {
    rand = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  }
  return `${counter}.${rand}`;
}

/**
 * Create a runtime matching `createKernelCore`'s injected runtime contract.
 */
export async function createWorkerRuntime({
  face = null,
  fsBridge = null,
  rigModuleSource = '',
  rigAllowlist = null,
  indexURL = PYODIDE_INDEX_URL,
  mountPath = '/workspace',
  rigRpcBytes = 8 << 20,
  allowUngovernedWrites = false,
  initTimeoutMs = 120000,
  runCodeTimeoutMs = 60000,
  WorkerClass = globalThis.Worker,
} = {}) {
  if (typeof WorkerClass !== 'function') throw new Error('Kiln requires Worker support');
  if (typeof SharedArrayBuffer !== 'function') {
    throw new Error('Kiln requires cross-origin isolation for SharedArrayBuffer');
  }
  // A storage-backed session with no governed face would write straight to the
  // bridge (no grant, no op-log). Refuse to stand one up unless it opted in.
  if (fsBridge && !face && !allowUngovernedWrites) {
    throw new Error('Kiln requires a Rig face for a storage-backed session (or set allowUngovernedWrites)');
  }
  // Rig-call is locked to exactly the generated Python bindings (M-K2).
  const allowlist = rigAllowlist
    ? (rigAllowlist instanceof Set ? rigAllowlist : new Set(rigAllowlist))
    : deriveRigAllowlist(rigModuleSource);
  // Paths a staged fs.remove is holding: masked from the snapshot sent to the
  // Worker so loadSnapshot cannot resurrect them mid-session (M-K4).
  const stagedRemovals = new Set();

  const workerModuleUrl = new URL('./worker.mjs', import.meta.url).href;
  const blobUrl = URL.createObjectURL(new Blob([
    `import ${JSON.stringify(workerModuleUrl)};`,
  ], { type: 'application/javascript' }));
  const worker = new WorkerClass(blobUrl, { type: 'module', name: 'naklios-kiln' });
  const interruptBuffer = new Uint8Array(new SharedArrayBuffer(1));
  const pending = new Map();
  let requestId = 0;
  let namespace = {};
  let closed = false;

  function settleAll(error) {
    for (const pendingRequest of pending.values()) pendingRequest.reject(error);
    pending.clear();
  }

  async function handleRigCall(message) {
    const control = new Int32Array(message.controlBuffer);
    const target = new Uint8Array(message.payloadBuffer);
    try {
      if (!face) throw new Error('Rig is unavailable in this Kiln session');
      if (!allowlist.has(message.name)) {
        // Forged rig-call: a name with no generated Python binding. Return a
        // typed miss instead of letting it reach an ungoverned command (M-K2).
        // Fail closed on an EMPTY allowlist too (Low12): an empty set means the
        // generated module exposes no `_rig_invoke` binding, so no legitimate
        // Python-origin rig-call name can exist — every name is therefore
        // forged. The governed face stays as defense-in-depth, but the binding
        // allowlist is the primary gate and rejects unknown names regardless of
        // its size.
        const denial = enc.encode(JSON.stringify(toRigJsonValue({
          ok: false, code: 'ENOCMD',
          message: `rig-call denied: '${message.name}' is not an exposed Kiln binding`,
        })));
        const bytes = truncateUtf8Bytes(denial, target.length);
        target.set(bytes);
        Atomics.store(control, 1, bytes.length);
        Atomics.store(control, 2, 1);
        return;
      }
      const args = fromRigJsonValue(JSON.parse(message.argsJson));
      const result = await face.invoke(message.name, args);
      const payload = enc.encode(JSON.stringify(toRigJsonValue(result)));
      if (payload.length > target.length) throw new Error(`Rig result exceeds ${target.length} bytes`);
      target.set(payload);
      Atomics.store(control, 1, payload.length);
      Atomics.store(control, 2, 1);
    } catch (error) {
      const payload = truncateUtf8Bytes(enc.encode(String(error?.message || error)), target.length);
      target.set(payload);
      Atomics.store(control, 1, payload.length);
      Atomics.store(control, 2, -1);
    } finally {
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
    }
  }

  worker.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'rig-call') {
      void handleRigCall(message);
      return;
    }
    if (message.type !== 'response') return;
    // The id is the response-channel auth tag: only an unguessable id minted by
    // request() below is in `pending`, so a forged response with a wrong/absent
    // id finds no match and is dropped (Low11). Guard the lookup key shape too.
    if (typeof message.id !== 'string' && typeof message.id !== 'number') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.ok) request.resolve(message.value);
    else request.reject(new Error(message.value?.message || 'Kiln Worker request failed'));
  });
  worker.addEventListener('error', (event) => {
    // A Worker-level error means the heap is gone; mark it unusable so a later
    // request() rejects instead of re-enqueuing onto a dead Worker (M-K3b).
    closed = true;
    settleAll(new Error(event.message || 'Kiln Worker failed'));
  });
  worker.addEventListener('messageerror', (event) => {
    // A structured-clone failure crossing the boundary settles the same way as
    // an error rather than hanging the pending request forever (M-K3a).
    closed = true;
    settleAll(new Error(event?.message || 'Kiln Worker message could not be deserialized'));
  });

  function request(op, payload = {}, timeoutMs = 0) {
    if (closed) return Promise.reject(new Error('Kiln Worker is closed'));
    const id = randomRequestId(++requestId);
    return new Promise((resolve, reject) => {
      let timer = null;
      pending.set(id, {
        resolve: (value) => { if (timer) clearTimeout(timer); resolve(value); },
        reject: (error) => { if (timer) clearTimeout(timer); reject(error); },
      });
      if (timeoutMs > 0 && timeoutMs !== Infinity) {
        timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          // A timed-out request means the Worker is presumed wedged: mark it
          // unusable and fail any siblings too (M-K3c).
          closed = true;
          const error = new Error(`Kiln Worker '${op}' timed out after ${timeoutMs}ms`);
          settleAll(error);
          reject(error);
        }, timeoutMs);
      }
      worker.postMessage({ type: 'request', id, op, ...payload });
    });
  }

  const ready = await request('init', {
    indexURL,
    interruptBuffer: interruptBuffer.buffer,
    mountPath,
    rigRpcBytes,
    rigModuleSource,
  }, initTimeoutMs);
  URL.revokeObjectURL(blobUrl);

  // Drop paths under a staged removal so loadSnapshot cannot re-materialize
  // them next cell, while the host copy is retained for operator accept (M-K4).
  function maskStagedRemovals(snapshot) {
    if (stagedRemovals.size === 0) return snapshot;
    const isMasked = (path) => {
      for (const removed of stagedRemovals) {
        if (path === removed || path.startsWith(removed + '/')) return true;
      }
      return false;
    };
    return {
      dirs: (snapshot.dirs || []).filter((path) => !isMasked(path)),
      files: (snapshot.files || []).filter((file) => !isMasked(file.path)),
    };
  }

  function reconcileStagedRemovals(fsSync, after) {
    // A path re-created this cell is no longer removed — stop masking it.
    const present = new Set((after.files || []).map((file) => file.path));
    for (const path of [...stagedRemovals]) if (present.has(path)) stagedRemovals.delete(path);
    // Newly staged fs.remove proposals join the mask set.
    for (const entry of fsSync.staged || []) {
      if (entry && entry.command === 'fs.remove' && entry.input && typeof entry.input.path === 'string') {
        stagedRemovals.add(entry.input.path);
      }
    }
  }

  async function runCode(code, options = {}) {
    const before = maskStagedRemovals(await snapshotBridge(fsBridge));
    const value = await request('runCode', { code, options, snapshot: before }, runCodeTimeoutMs);
    namespace = value.namespace || {};
    delete value.namespace;
    const after = value.snapshot || { dirs: [], files: [] };
    delete value.snapshot;
    const fsSync = await syncWorkerSnapshot({ before, after, face, fsBridge, allowUngoverned: allowUngovernedWrites });
    value.fsSync = fsSync;
    reconcileStagedRemovals(fsSync, after);
    return value;
  }

  function interrupt() {
    interruptBuffer[0] = 2;
  }

  function reset(options = {}) {
    namespace = {};
    void request('reset', { options }).catch(() => {});
  }

  async function close() {
    if (closed) return;
    try { await request('close'); } finally {
      closed = true;
      worker.terminate();
      settleAll(new Error('Kiln Worker closed'));
    }
  }

  return {
    runCode,
    interrupt,
    reset,
    listNames: () => Object.keys(namespace),
    inspect: (name) => namespace[name] || null,
    close,
    workerInfo: ready,
  };
}
