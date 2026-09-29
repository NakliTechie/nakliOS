// Shared command I/O. The shell supplies an invoke wrapper that waits for staged
// operations; commands never obtain the registry, backend, or proposal acceptor.

const encoder = new TextEncoder();
// Preserve a UTF-8 BOM as U+FEFF so reading and writing text preserves its bytes.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// Keep the shell's existing binary classification. Tabs, LF, VT, FF and CR are text.
// eslint-disable-next-line no-control-regex
const BINARY_BYTES = /[\u0000-\u0008\u000e-\u001f]/;

export function normalizePath(cwd, path) {
  const raw = String(path ?? '');
  const parts = raw.startsWith('/') ? [] : String(cwd ?? '').split('/').filter(Boolean);
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { parts.pop(); continue; }
    parts.push(part);
  }
  return parts.join('/');
}

/** Encode text without decoding bytes. Returned byte arrays may alias the input. */
export function toBytes(data = '') {
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('command data must be a string or Uint8Array');
}

/** Explicit text consumers decode invalid UTF-8 with replacement characters. */
export function toText(data = '') {
  return typeof data === 'string' ? data : decoder.decode(toBytes(data));
}

/** Use strings only when UTF-8 decoding is lossless and contains no binary controls. */
export function autoData(data = '') {
  if (typeof data === 'string') return BINARY_BYTES.test(data) ? toBytes(data) : data;
  const bytes = toBytes(data);
  try {
    const text = strictDecoder.decode(bytes);
    if (BINARY_BYTES.test(text)) return bytes;
    const encoded = encoder.encode(text);
    if (encoded.length !== bytes.length || encoded.some((b, i) => b !== bytes[i])) return bytes;
    return text;
  } catch (_) { return bytes; }
}

/** A byte-bearing pipeline stays byte-bearing, including across empty chunks. */
export function concatData(parts) {
  if (parts.every((part) => typeof part === 'string')) return parts.join('');
  const chunks = parts.map((part) => toBytes(part));
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

/** Terminal rendering belongs at the boundary, never between pipeline stages. */
export function renderData(data = '') {
  return typeof data === 'string' ? data : `<${toBytes(data).byteLength} bytes>`;
}

export class IOFailure extends Error {
  constructor(operation, result) {
    super(result?.message || `${operation} failed`);
    this.name = 'IOFailure';
    this.operation = operation;
    this.code = result?.code || (result?.staged ? 'ESTAGED' : 'EIO');
    this.result = result;
  }
}

/**
 * Methods resolve paths against the current cwd at invocation time. Returned paths
 * from list/glob remain mount-relative; prepend `/` when passing them back to I/O.
 * Reads return data, stat/list/glob unwrap their payload, and mutations return the
 * complete face success result. Failures throw IOFailure with the original result.
 * `run` invokes already-separated argv without reparsing a shell command string.
 */
export function createIO({ invoke, cwd = () => '', run } = {}) {
  if (typeof invoke !== 'function') throw new TypeError('createIO requires an invoke function');
  if (typeof cwd !== 'function') throw new TypeError('createIO cwd must be a function');
  if (run != null && typeof run !== 'function') throw new TypeError('createIO run must be a function');

  const resolve = (path) => normalizePath(cwd(), path);
  const call = async (operation, input) => {
    const result = await invoke(operation, input);
    if (!result?.ok) throw new IOFailure(operation, result);
    return result;
  };
  const readBytes = async (path, { maxBytes, rejectSymlinks } = {}) => toBytes((await call('fs.read', { path: resolve(path),
    ...(maxBytes === undefined ? {} : { maxBytes }), ...(rejectSymlinks === undefined ? {} : { rejectSymlinks }) })).data);

  return {
    // Advanced commands use the same granted/staged call boundary for indexed search.
    // Inputs here are registry-shaped; convenience methods below resolve relative paths.
    invoke: call,
    resolve,
    readBytes,
    readText: async (path) => toText(await readBytes(path)),
    read: async (path) => autoData(await readBytes(path)),
    write: (path, data, { createParents = false } = {}) => call('fs.write', {
      path: resolve(path), data, createParents,
    }),
    stat: async (path, { follow, metadataOnly, rejectSymlinks } = {}) => (await call('fs.stat', { path: resolve(path),
      ...(follow === undefined ? {} : { follow }), ...(metadataOnly === undefined ? {} : { metadataOnly }),
      ...(rejectSymlinks === undefined ? {} : { rejectSymlinks }) })).stat,
    list: async (path = '.', { recursive = false, metadataOnly, rejectSymlinks } = {}) => (await call('fs.list', {
      path: resolve(path), recursive, ...(metadataOnly === undefined ? {} : { metadataOnly }),
      ...(rejectSymlinks === undefined ? {} : { rejectSymlinks }),
    })).entries,
    glob: async (pattern, { cwd: from = '.' } = {}) => {
      // The registry glob's pattern is relative to its cwd, including for `/...`.
      const absolute = String(pattern).startsWith('/');
      const input = absolute
        ? { pattern: normalizePath('', pattern), cwd: '' }
        : { pattern, cwd: resolve(from) };
      return (await call('fs.glob', input)).matches;
    },
    mkdir: (path, { createParents = false } = {}) => call('fs.mkdir', { path: resolve(path), createParents }),
    create: (path, { directory = false } = {}) => call('fs.create', { path: resolve(path), directory }),
    truncate: (path, { size, mode = 'set', create = true, maxBytes } = {}) => call('fs.truncate', { path: resolve(path), size, mode, create,
      ...(maxBytes === undefined ? {} : { maxBytes }) }),
    remove: (path, { recursive = false, follow, metadataOnly, kind } = {}) => call('fs.remove', { path: resolve(path), recursive,
      ...(follow === undefined ? {} : { follow }), ...(metadataOnly === undefined ? {} : { metadataOnly }),
      ...(kind === undefined ? {} : { kind }) }),
    move: (from, to, { overwrite = false } = {}) => call('fs.move', { from: resolve(from), to: resolve(to), overwrite }),
    copy: (from, to, { overwrite = false } = {}) => call('fs.copy', { from: resolve(from), to: resolve(to), overwrite }),
    run: async (argv, stdin = '') => {
      if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) {
        throw new TypeError('io.run requires an array of string arguments');
      }
      if (!run) throw new IOFailure('run', { code: 'ENOSYS', message: 'nested commands are unavailable' });
      return run(argv, stdin);
    },
  };
}
