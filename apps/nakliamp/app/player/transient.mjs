// transient.mjs — files that play without joining the library (the NakliOS hand-off).
//
// A file NakliOS sends ("Open in NakliAmp", for example from Rivulina) is not in any
// granted folder, so it has no library record and no path. It still belongs in the
// queue: it gets a transient record with an id of its own (`transient:<n>`), the queue
// holds that id like any track id, and the shell resolves the id to the File here.
// The queue keeps transient ids out of its stored copy (they cannot survive a reload).
// Pure state, no DOM.

export const TRANSIENT_PREFIX = 'transient:';

export const isTransientId = id => typeof id === 'string' && id.startsWith(TRANSIENT_PREFIX);

const isFileLike = value => Boolean(value) && typeof value.arrayBuffer === 'function' && typeof value.name === 'string';

const stemOf = name => String(name ?? '').replace(/\.[^./]+$/, '') || 'Untitled track';

/** The records for files received this session, by id. */
export function createTransientStore() {
  const records = new Map();
  let counter = 0;
  return {
    /** Keep a File and return its record: `{ id, transient: true, path: null, title, name, size, file }`. */
    add(file) {
      if (!isFileLike(file)) throw new TypeError('A transient track needs a File.');
      counter += 1;
      const id = `${TRANSIENT_PREFIX}${counter}`;
      const record = {
        id,
        transient: true,
        path: null,
        name: file.name,
        title: stemOf(file.name),
        artist: null,
        album: null,
        albumKey: null,
        durationS: null,
        size: Number(file.size) || 0,
        file,
      };
      records.set(id, record);
      return record;
    },
    get: id => records.get(id) ?? null,
    has: id => records.has(id),
    size: () => records.size,
  };
}

/**
 * Queue files a host sent, after whatever is queued, and make the first one current,
 * so the queue's change listener loads and plays it. Returns the new records.
 */
export function receiveFiles(files, { store, queue }) {
  const records = [...(files ?? [])].filter(isFileLike).map(file => store.add(file));
  if (!records.length) return [];
  const at = queue.snapshot().length;
  queue.add(records.map(record => record.id));
  queue.jump(at);
  return records;
}
