// remote-backend.mjs — a Rig fileops backend whose storage lives on the other side of a message channel.
//
// Pi runs in a Worker, but NakliOS storage (`naklios.fs` for the connected Folder or Crate) lives on the
// page. The page keeps the real backend (CrateBackend over naklios.fs, OPFS, or memory) and serves it
// with `serveBackend`; the Worker builds `createRemoteBackend` over the same channel and hands it to
// createFileops. Files and Pi's sessions then land wherever the page chose, and the Worker never holds
// a host handle.
//
// The backend contract is the one fileops uses: readBinary / write / delete / mkdir / exists / stat /
// list, plus optional truncate / createExclusive / conditionalWrite / conditionalDelete and the
// capability flags read once at setup. Errors keep their `code` (ENOENT, EISDIR …) across the channel.

export const BACKEND_METHODS = ['readBinary', 'write', 'delete', 'mkdir', 'exists', 'stat', 'list'];
export const OPTIONAL_METHODS = ['truncate', 'createExclusive', 'conditionalWrite', 'conditionalDelete'];
export const BACKEND_FLAGS = ['supportsMetadataOnly', 'supportsBoundedReads', 'supportsBoundedListing'];

// Page side: describe the backend once, then answer calls.
export function describeBackend(backend) {
  const flags = {};
  for (const f of BACKEND_FLAGS) if (backend[f] !== undefined) flags[f] = backend[f] === true;
  return { flags, optional: OPTIONAL_METHODS.filter((m) => typeof backend[m] === 'function') };
}

export function serveBackend(backend) {
  const allowed = new Set([...BACKEND_METHODS, ...OPTIONAL_METHODS.filter((m) => typeof backend[m] === 'function')]);
  return async function handle(method, args) {
    if (!allowed.has(method)) return { error: { code: 'ENOTSUP', message: `backend method ${method} is not available` } };
    try { return { value: await backend[method](...(Array.isArray(args) ? args : [])) }; }
    catch (e) { return { error: { code: e?.code || 'EIO', message: String(e?.message || e) } }; }
  };
}

// Worker side: `call(method, args)` resolves to the page handler's { value } or { error }.
export function createRemoteBackend(call, { flags = {}, optional = [] } = {}) {
  const invoke = async (method, args) => {
    const r = await call(method, args);
    if (r && r.error) { const e = new Error(r.error.message); e.code = r.error.code; throw e; }
    return r ? r.value : undefined;
  };
  const backend = { ...flags };
  for (const m of [...BACKEND_METHODS, ...optional]) backend[m] = (...args) => invoke(m, args);
  return backend;
}
