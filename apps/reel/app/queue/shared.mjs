/* The queue's items, shared with the library view (app/library) and the NakliOS store (app/hosted).
 * No DOM. Items: { name, path, file?, handle?, hosted?, external? } in natural order; a `hosted` item
 * reads through the host store's ranged reader for its `path`. `generation` changes when the
 * queue is rebuilt, so the library knows its per-card cache is stale. */

let source = Object.freeze({ items: [], folderName: null, generation: 0 });
const listeners = new Set();

export function queueSource() {
  return source;
}

export function setQueueSource({ items, folderName = null }) {
  source = Object.freeze({ items: Object.freeze([...items]), folderName, generation: source.generation + 1 });
  for (const listener of listeners) {
    try { listener(source); } catch (_) { /* a listener's failure stays its own */ }
  }
}

export function onQueueSource(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* The NakliOS store, set by app/hosted while Reel runs hosted with `naklios.fs`, else null:
 * { label, rangeReads, walk(prefix) -> { records, truncated }, reader(path) -> ranged reader,
 *   file(path) -> small File (subtitles) }. */
let host = null;
const hostListeners = new Set();

export function hostStore() {
  return host;
}

export function setHostStore(store) {
  host = store || null;
  for (const listener of hostListeners) {
    try { listener(host); } catch (_) { /* a listener's failure stays its own */ }
  }
}

export function onHostStore(listener) {
  hostListeners.add(listener);
  return () => hostListeners.delete(listener);
}

/* What the engine opens for an item: a File, or a ranged reader for a hosted item; null for an
 * item opened outside the queue. */
export async function itemFile(item) {
  if (item?.file) return item.file;
  if (item?.handle) return item.handle.getFile();
  if (item?.hosted && host) return host.reader(item.path);
  return null;
}

/* A File for a subtitle record (hosted subtitles are read once, bounded). */
export async function recordFile(record) {
  if (record?.file) return record.file;
  if (record?.handle) return record.handle.getFile();
  if (record?.hosted && host) return host.file(record.path);
  throw new Error(`No file for ${record?.name ?? 'the item'}.`);
}
