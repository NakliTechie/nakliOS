// Kiln's dedicated Pyodide Worker.
//
// The main thread owns consent, storage, grants, and Rig. This Worker owns the
// Python heap. A SharedArrayBuffer carries interrupts into a busy Python call
// and lets synchronous generated `rig.*` functions wait for the main thread's
// governed registry result without exposing a second capability path.

import { createPyodideRuntime, PYODIDE_ENTRY_SHA256 } from './pyodide-runtime.mjs';

let runtime = null;
let pyodide = null;
let mountPath = '/workspace';
let rigRpcBytes = 8 << 20;
let queue = Promise.resolve();
let networkNeutered = false;

const textDecoder = new TextDecoder();

// Worker-global names that reach the network. Pyodide's `js` module resolves
// these to the Worker globals, and its urllib / pyfetch shims route through
// `js.fetch`, so replacing them with throwing stubs closes the standard egress
// APIs from model-authored Python (C-K1). This is NOT a complete sandbox: it
// cannot stub the syntactic `import()` operator, and stubbing `eval`/`Function`
// would break Pyodide itself — so `js.eval("import('…')")` remains reachable.
// A CSP `connect-src` on the Kiln-hosting document is the network-layer backstop
// (see sys/kiln README). `postMessage` is deliberately NOT here — the Rig
// back-channel depends on it.
export const NETWORK_EGRESS_GLOBALS = [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
  'Request', 'importScripts', 'Worker', 'SharedWorker', 'WebTransport',
];

// Replace every network-egress global on `target` with a stub that throws a
// clear error. Idempotent, and safe to run once Pyodide (and any packages) are
// loaded but before the first user cell. Exported so headless tests can assert
// the stubs are installed without a real Worker.
export function neuterNetworkEgress(target = globalThis) {
  const deny = (label) => {
    const stub = function kilnNetworkDisabled() {
      throw new Error(`${label}: network access is disabled in Kiln`);
    };
    return stub;
  };
  for (const name of NETWORK_EGRESS_GLOBALS) {
    const stub = deny(name);
    try {
      Object.defineProperty(target, name, { value: stub, configurable: true, writable: true });
    } catch (_) {
      try { target[name] = stub; } catch (_) {}
    }
  }
  const nav = target.navigator;
  if (nav && typeof nav.sendBeacon === 'function') {
    try { nav.sendBeacon = deny('navigator.sendBeacon'); } catch (_) {}
  }
  // CacheStorage: Cache.add/addAll fetch over the network without touching the
  // `fetch` global, so stub the whole caches accessor (M-K1 completeness).
  const cachesStub = {
    open: deny('caches.open'), match: deny('caches.match'), has: deny('caches.has'),
    delete: deny('caches.delete'), keys: deny('caches.keys'),
  };
  try { Object.defineProperty(target, 'caches', { value: cachesStub, configurable: true, writable: true }); }
  catch (_) { try { target.caches = cachesStub; } catch (_) {} }
  return target;
}

// Fetch the Pyodide entry module, verify its bytes against the pinned digest,
// and import it from a blob URL so only vetted bytes ever execute (M-K6). When
// no digest is configured the loader falls back to a direct CDN import (the
// documented residual-trust path).
async function importPyodideEntry(indexURL, expectedSha256) {
  const entryURL = indexURL + 'pyodide.mjs';
  if (!expectedSha256) return import(entryURL);
  const response = await fetch(entryURL);
  if (!response.ok) throw new Error(`Kiln could not fetch the Pyodide entry module (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== expectedSha256) {
    throw new Error(`Kiln Pyodide entry integrity check failed: expected ${expectedSha256}, got ${hex}`);
  }
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
  try {
    return await import(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

// Low11: the session nonce. A module-scope binding, deliberately NOT a property of
// `self` or any other global — model-authored Python reaches JS through `js.<name>`,
// which resolves globals; it cannot read a module closure. Set once from `init`,
// before Pyodide loads, and never read back out of the Worker.
let sessionNonce = null;

function reply(id, ok, value) {
  // Stamped on every response. The main thread drops any response without it, so a
  // forged `postMessage` from Python — which CAN read request ids via a planted
  // 'message' listener — still cannot settle a pending request.
  self.postMessage({ type: 'response', id, ok, value, nonce: sessionNonce });
}

function ensureDirectory(path) {
  if (!path || path === '/') return;
  try { pyodide.FS.mkdirTree(path); } catch (_) {}
}

function clearDirectory(path) {
  for (const name of pyodide.FS.readdir(path)) {
    if (name === '.' || name === '..') continue;
    const child = path.replace(/\/$/, '') + '/' + name;
    const st = pyodide.FS.lstat(child);
    if (pyodide.FS.isDir(st.mode)) {
      clearDirectory(child);
      pyodide.FS.rmdir(child);
    } else {
      pyodide.FS.unlink(child);
    }
  }
}

function loadSnapshot(snapshot) {
  pyodide.FS.chdir(mountPath);
  clearDirectory(mountPath);
  const dirs = [...(snapshot?.dirs || [])].sort((a, b) => a.split('/').length - b.split('/').length);
  for (const path of dirs) ensureDirectory(mountPath + '/' + path);
  for (const file of snapshot?.files || []) {
    const full = mountPath + '/' + file.path;
    ensureDirectory(full.slice(0, full.lastIndexOf('/')));
    pyodide.FS.writeFile(full, file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data));
  }
}

function takeSnapshot() {
  const dirs = [];
  const files = [];
  const walk = (dir, rel) => {
    for (const name of pyodide.FS.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const full = dir.replace(/\/$/, '') + '/' + name;
      const childRel = rel ? rel + '/' + name : name;
      const st = pyodide.FS.lstat(full);
      if (pyodide.FS.isLink(st.mode)) {
        // The snapshot format carries only files and directories; a symlink
        // would be silently dropped on the next loadSnapshot. Reject it loudly
        // rather than lose it (L-K7).
        throw new Error(`Kiln does not support symlinks in the workspace: ${childRel}`);
      }
      if (pyodide.FS.isDir(st.mode)) {
        dirs.push(childRel);
        walk(full, childRel);
      } else if (pyodide.FS.isFile(st.mode)) {
        files.push({ path: childRel, data: pyodide.FS.readFile(full, { encoding: 'binary' }) });
      }
    }
  };
  walk(mountPath, '');
  dirs.sort();
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { dirs, files };
}

function callRig(name, argsJson) {
  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
  const payloadBuffer = new SharedArrayBuffer(rigRpcBytes);
  const control = new Int32Array(controlBuffer);
  self.postMessage({ type: 'rig-call', name, argsJson, controlBuffer, payloadBuffer });
  const wait = Atomics.wait(control, 0, 0, 60000);
  if (wait === 'timed-out') throw new Error(`Rig call timed out: ${name}`);
  const length = Atomics.load(control, 1);
  const status = Atomics.load(control, 2);
  const payloadBytes = new Uint8Array(length);
  payloadBytes.set(new Uint8Array(payloadBuffer, 0, length));
  const payload = textDecoder.decode(payloadBytes);
  if (status !== 1) throw new Error(payload || `Rig call failed: ${name}`);
  return payload;
}

function installRigModule(source) {
  if (!source) return;
  pyodide.globals.set('_kiln_rig_call', callRig);
  pyodide.globals.set('_kiln_rig_source', source);
  pyodide.runPython(`
import sys as _kiln_sys
import types as _kiln_types
_kiln_rig_module = _kiln_types.ModuleType("rig")
_kiln_rig_module.__dict__["_rig_call"] = _kiln_rig_call
exec(_kiln_rig_source, _kiln_rig_module.__dict__)
_kiln_sys.modules["rig"] = _kiln_rig_module
`);
}

function installFilesystemGuard() {
  pyodide.globals.set('_kiln_mount_path', mountPath);
  pyodide.runPython(`
import os as _kiln_os
import sys as _kiln_sys

_KILN_ROOT = _kiln_os.path.realpath(_kiln_mount_path)
_KILN_READONLY_RUNTIME_ROOTS = ("/usr/", "/lib/")

def _kiln_resolve_path(value):
    if isinstance(value, int):
        return None
    try:
        path = _kiln_os.fspath(value)
    except TypeError:
        return None
    if isinstance(path, bytes):
        path = _kiln_os.fsdecode(path)
    if not _kiln_os.path.isabs(path):
        path = _kiln_os.path.join(_kiln_os.getcwd(), path)
    return _kiln_os.path.realpath(path)

def _kiln_inside(path):
    return path == _KILN_ROOT or path.startswith(_KILN_ROOT + _kiln_os.sep)

def _kiln_fs_audit(event, args):
    path_indexes = {
        "open": (0,), "os.chdir": (0,), "os.listdir": (0,), "os.scandir": (0,),
        "os.remove": (0,), "os.rmdir": (0,), "os.mkdir": (0,), "os.chmod": (0,),
        "os.chown": (0,), "os.truncate": (0,), "os.utime": (0,),
        "os.rename": (0, 1), "os.link": (0, 1), "os.symlink": (0, 1),
    }.get(event)
    if not path_indexes:
        return
    for index in path_indexes:
        if index >= len(args):
            continue
        path = _kiln_resolve_path(args[index])
        if path is None or _kiln_inside(path):
            continue
        read_only_runtime = event == "open" and path.startswith(_KILN_READONLY_RUNTIME_ROOTS)
        if read_only_runtime:
            mode = args[1] if len(args) > 1 else "r"
            if not any(flag in str(mode) for flag in ("w", "a", "+", "x")):
                continue
        raise PermissionError(f"path outside Kiln mount: {args[index]}")

_kiln_sys.addaudithook(_kiln_fs_audit)
_kiln_os.chdir(_KILN_ROOT)
`);
}

async function initialize(message) {
  const expectedSha256 = message.pyodideEntrySha256 !== undefined
    ? message.pyodideEntrySha256
    : PYODIDE_ENTRY_SHA256;
  const { loadPyodide } = await importPyodideEntry(message.indexURL, expectedSha256);
  const interruptBuffer = new Uint8Array(message.interruptBuffer);
  mountPath = message.mountPath || mountPath;
  rigRpcBytes = message.rigRpcBytes || rigRpcBytes;
  pyodide = await loadPyodide({ indexURL: message.indexURL });
  ensureDirectory(mountPath);
  pyodide.FS.mount(pyodide.FS.filesystems.MEMFS, {}, mountPath);
  runtime = createPyodideRuntime(pyodide, interruptBuffer);
  installRigModule(message.rigModuleSource);
  installFilesystemGuard();
  // Deny network egress now: Pyodide is up and every package is loaded, and no
  // user cell has run yet. Any later `import js; js.fetch(...)` hits a stub.
  if (!networkNeutered) { neuterNetworkEgress(globalThis); networkNeutered = true; }
  return { version: pyodide.version, mountPath };
}

async function handle(message) {
  try {
    if (message.op === 'init') {
      // Captured BEFORE initialize() — that is what loads Pyodide, so the nonce is
      // in the closure before any user code exists to look for it. Only the first
      // init sets it: a second `init` carrying a different nonce must not be able
      // to re-key the channel.
      if (sessionNonce === null && typeof message.sessionNonce === 'string') sessionNonce = message.sessionNonce;
      reply(message.id, true, await initialize(message));
      return;
    }
    if (!runtime) throw new Error('Kiln Worker is not initialized');
    if (message.op === 'runCode') {
      loadSnapshot(message.snapshot);
      const value = await runtime.runCode(message.code, message.options || {});
      const names = runtime.listNames();
      const namespace = {};
      for (const name of names) namespace[name] = runtime.inspect(name);
      value.namespace = namespace;
      value.snapshot = takeSnapshot();
      reply(message.id, true, value);
      return;
    }
    if (message.op === 'reset') {
      runtime.reset(message.options || {});
      if (!message.options?.keepMounts) clearDirectory(mountPath);
      reply(message.id, true, { ok: true });
      return;
    }
    if (message.op === 'close') {
      reply(message.id, true, { ok: true });
      self.close();
      return;
    }
    throw new Error(`Unknown Kiln Worker operation: ${message.op}`);
  } catch (error) {
    reply(message.id, false, {
      message: String(error?.message || error),
      stack: String(error?.stack || error),
    });
  }
}

// Guarded so the module can be imported outside a Worker (headless tests reach
// the exported helpers without a `self`).
if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', (event) => {
    queue = queue.then(() => handle(event.data));
  });
}
