/* Reel stored data: list and delete the records Reel keeps about what the person watched.
 * Browser only, no top-level DOM or storage access, so Node can import the modules that use it.
 *
 * Reel's key-value records live in the IndexedDB database "reel", object store "kv" (the Storage
 * façade in index.html). The façade has no delete, so this module opens the same database and
 * deletes keys by exact name. Posters live in OPFS under reel-posters/ and are deleted file by file.
 * Every call touches only names Reel writes: "resume:index", "bookmarks:<fingerprint>",
 * "queue:lastFolder" and reel-posters/<fingerprint>.webp. Nothing is deleted by container. */

import { POSTER_DIR, isPosterName } from './logic.mjs';

const DB = 'reel';
const STORE = 'kv';

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* Runs fn(store) in one transaction on Reel's kv store. The façade opens (and upgrades) the
 * database first through `storage.get`, so this never creates it; the connection closes after. */
async function withStore(storage, mode, fn) {
  await storage.get('resume:index');
  const db = await request(indexedDB.open(DB));
  try {
    if (!db.objectStoreNames.contains(STORE)) return mode === 'readonly' ? [] : 0;
    const tx = db.transaction(STORE, mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted.', 'AbortError'));
    });
    const result = await fn(tx.objectStore(STORE));
    await done;
    return result;
  } finally {
    db.close();
  }
}

/* The keys in Reel's kv store that start with `prefix`. */
export function keysWithPrefix(storage, prefix) {
  return withStore(storage, 'readonly', async store => {
    const keys = await request(store.getAllKeys());
    return keys.filter(key => typeof key === 'string' && key.startsWith(prefix));
  });
}

/* Deletes each named key; returns how many it deleted. */
export function deleteKeys(storage, keys) {
  const list = [...keys];
  if (!list.length) return Promise.resolve(0);
  return withStore(storage, 'readwrite', async store => {
    for (const key of list) store.delete(key);
    return list.length;
  });
}

async function posterDir() {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(POSTER_DIR);
  } catch {
    return null; // no OPFS, or no poster made yet
  }
}

/* The poster file names in OPFS reel-posters/ (only names Reel writes). */
export async function posterNames() {
  const dir = await posterDir();
  if (!dir) return [];
  const names = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file' && isPosterName(name)) names.push(name);
  }
  return names;
}

/* Deletes each named poster; removes reel-posters/ itself once it holds nothing. Returns the count. */
export async function deletePosters(names) {
  const dir = await posterDir();
  if (!dir) return 0;
  let removed = 0;
  for (const name of names) {
    if (!isPosterName(name)) continue;
    try { await dir.removeEntry(name); removed += 1; } catch { /* already gone */ }
  }
  let empty = true;
  for await (const _ of dir.keys()) { empty = false; break; }
  if (empty) {
    try { await (await navigator.storage.getDirectory()).removeEntry(POSTER_DIR); } catch { /* another tab wrote one */ }
  }
  return removed;
}
