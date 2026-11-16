/* Reel hosted: pure logic for reading media through NakliOS (`naklios.fs`). No DOM, no browser
 * globals, so test/queue.test.mjs runs it in Node.
 *
 * NakliOS rules (naklios docs/app-contract.md, "Filesystem"): paths are relative to the app's
 * storage; `list(prefix)` returns one level, folders end in "/"; `readBinary(path, { offset,
 * maxBytes })` reads at most 16 MiB a call and needs `capabilities.fsRangeReads` (Folder only);
 * Crate refuses offset reads. */

export const MAX_READ_BYTES = 16 * 1024 * 1024;   // the host's cap for one ranged read
export const CHUNK_BYTES = 4 * 1024 * 1024;       // one cached chunk; well under the cap
export const CACHE_CHUNKS = 8;                    // 32 MiB of chunks across every open reader
export const WHOLE_READ_LIMIT = 64 * 1024 * 1024; // largest file Reel plays without ranged reads
export const SUBTITLE_LIMIT = 8 * 1024 * 1024;    // largest subtitle file Reel reads
export const LIST_DEPTH = 6;
export const LIST_ENTRIES = 2000;

/* Uint8Array from whatever the host's RPC returns (Uint8Array, ArrayBuffer, view, or a byte array). */
export function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (value && typeof value === 'object' && Array.isArray(value.data)) return Uint8Array.from(value.data);
  throw new TypeError('NakliOS returned no bytes for a binary read.');
}

/* Least-recently-used chunk cache shared by every reader, so memory stays bounded however many
 * files the library probes. In-flight reads are shared too, so two callers fetch a chunk once. */
export function createChunkCache(maxChunks = CACHE_CHUNKS) {
  const entries = new Map(); // key -> Promise<Uint8Array>, oldest first
  return {
    get(key, load) {
      const hit = entries.get(key);
      if (hit) {
        entries.delete(key);
        entries.set(key, hit);
        return hit;
      }
      const pending = Promise.resolve().then(load);
      entries.set(key, pending);
      pending.catch(() => { if (entries.get(key) === pending) entries.delete(key); });
      while (entries.size > maxChunks) entries.delete(entries.keys().next().value);
      return pending;
    },
    clear() { entries.clear(); },
    /* Drops every chunk of one path (keys start with "<path>\0"). */
    dropPath(path) {
      const prefix = `${path}\0`;
      for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
    },
    get size() { return entries.size; },
  };
}

/* Blob-shaped slice over a reader: enough for `Storage.fingerprint(file)` (slice + arrayBuffer). */
function sliceOf(reader, start = 0, end = reader.size) {
  const clamp = (value, fallback) => {
    const n = Number.isFinite(value) ? Math.trunc(value) : fallback;
    return n < 0 ? Math.max(reader.size + n, 0) : Math.min(n, reader.size);
  };
  const from = clamp(start, 0);
  const to = Math.max(from, clamp(end, reader.size));
  return {
    size: to - from,
    type: reader.type,
    async arrayBuffer() {
      const bytes = await reader.read(from, to - from);
      return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer : bytes.slice().buffer;
    },
  };
}

/* A ranged reader `{ name, size, type, path, read(offset, length), slice(a, b) }` over aligned
 * chunks of `chunkBytes`, each fetched with one `readChunk(offset, maxBytes)` call. */
export function createChunkReader({ path, name, size, type = '', stamp = '', readChunk, cache, chunkBytes = CHUNK_BYTES }) {
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError(`No size for ${name}.`);
  if (!(chunkBytes > 0 && chunkBytes <= MAX_READ_BYTES)) throw new RangeError('Chunk size must be 1 byte to 16 MiB.');
  const chunk = index => cache.get(`${path}\0${size}\0${stamp}\0${index}`, async () => {
    const offset = index * chunkBytes;
    const want = Math.min(chunkBytes, size - offset);
    const bytes = bytesOf(await readChunk(offset, want));
    if (bytes.byteLength !== want) {
      throw Object.assign(new Error(`NakliOS returned ${bytes.byteLength} of ${want} bytes from ${name} at byte ${offset}.`), { code: 'ERR_HOSTED_SHORT_READ' });
    }
    return bytes;
  });
  const reader = {
    path, name, size, type,
    async read(offset, length) {
      // One read is at most the host's 16 MiB call cap, so a bad length cannot fan out into
      // hundreds of concurrent host calls (V57).
      if (!(length <= MAX_READ_BYTES)) {
        throw Object.assign(new RangeError(`One read of ${name} is limited to ${MAX_READ_BYTES} bytes; ${length} were asked.`), { code: 'ERR_HOSTED_READ_TOO_LARGE' });
      }
      const start = Math.max(0, Math.min(size, Math.floor(offset)));
      const end = Math.max(start, Math.min(size, start + Math.floor(length)));
      const out = new Uint8Array(end - start);
      if (end === start) return out;
      const first = Math.floor(start / chunkBytes);
      const last = Math.floor((end - 1) / chunkBytes);
      const parts = [];
      for (let index = first; index <= last; index += 1) parts.push(chunk(index));
      const chunks = await Promise.all(parts);
      chunks.forEach((bytes, i) => {
        const base = (first + i) * chunkBytes;
        const from = Math.max(start, base) - base;
        const to = Math.min(end, base + bytes.byteLength) - base;
        out.set(bytes.subarray(from, to), base + from - start);
      });
      return out;
    },
    slice(start, end) { return sliceOf(reader, start, end); },
  };
  return reader;
}

/* A reader over bytes already in memory (the Crate case: one bounded read of a small file). */
export function createBufferReader({ path, name, type = '', bytes }) {
  const data = bytesOf(bytes);
  const reader = {
    path, name, size: data.byteLength, type,
    async read(offset, length) {
      const start = Math.max(0, Math.min(data.byteLength, Math.floor(offset)));
      const end = Math.max(start, Math.min(data.byteLength, start + Math.floor(length)));
      return data.slice(start, end);
    },
    slice(start, end) { return sliceOf(reader, start, end); },
  };
  return reader;
}

/* Normalises one `list(prefix)` result to [{ path, name, dir }] with app-relative paths. */
export function normaliseListing(entries, prefix = '') {
  const base = String(prefix || '').replace(/^\/+|\/+$/g, '');
  const out = [];
  for (const raw of Array.isArray(entries) ? entries : []) {
    const text = typeof raw === 'string' ? raw : String(raw?.path ?? raw?.name ?? '');
    if (!text) continue;
    const dir = text.endsWith('/') || raw?.type === 'dir' || raw?.isDir === true;
    let path = text.replace(/^\/+|\/+$/g, '');
    if (base && path !== base && !path.startsWith(`${base}/`)) path = `${base}/${path}`;
    if (!path || path === base) continue;
    out.push({ path, name: path.split('/').pop(), dir });
  }
  return out;
}

/* Walks `prefix` with `list`, keeping files for which `keep(name)` is true. Skips dot entries,
 * stops at `maxDepth` folders down and `maxEntries` kept files. Returns { records, truncated }. */
export async function walkListing(list, keep, { prefix = '', maxDepth = LIST_DEPTH, maxEntries = LIST_ENTRIES } = {}) {
  const records = [];
  let truncated = false;
  async function visit(dir, depth) {
    const entries = normaliseListing(await list(dir), dir);
    for (const entry of entries) {
      if (records.length >= maxEntries) { truncated = true; return; }
      if (entry.name.startsWith('.')) continue;
      if (entry.dir) {
        if (depth < maxDepth) await visit(entry.path, depth + 1);
        else truncated = true;
      } else if (keep(entry.name)) {
        records.push({ name: entry.name, path: entry.path, hosted: true });
      }
    }
  }
  await visit(String(prefix || '').replace(/^\/+|\/+$/g, ''), 0);
  return { records, truncated };
}

/* "1.2 GB" style size for refusal messages. */
export function formatBytes(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return unit ? `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}` : `${value} bytes`;
}
