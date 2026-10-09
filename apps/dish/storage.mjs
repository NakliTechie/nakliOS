const DB = 'naklios-dish-v1';
export function validPath(path) {
  return typeof path === 'string' && /^(home|workspace)(\/|$)/.test(path) && path.split('/').every(p => p && p !== '.' && p !== '..');
}
export function browserStore() {
  let opened;
  const db = () => opened ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('state');
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
  return {
    id: 'browser',
    async load() {
      const database = await db();
      return new Promise((resolve, reject) => {
        const tx = database.transaction('state'), req = tx.objectStore('state').get('snapshot');
        req.onsuccess = () => resolve(req.result || []); req.onerror = () => reject(req.error);
      });
    },
    async save(entries) {
      const database = await db();
      return new Promise((resolve, reject) => {
        const tx = database.transaction('state', 'readwrite');
        tx.objectStore('state').put(entries, 'snapshot');
        tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
      });
    },
  };
}
export function hostStore(sdk) {
  const id = sdk.capabilities.fsBackend;
  const assert = () => { if (!sdk.capabilities.fs || sdk.capabilities.fsBackend !== id) throw new Error('Storage backend changed; reload Dish'); };
  return {
    id,
    async load() {
      assert();
      if (!await sdk.fs.exists('vfs.json')) return [];
      const data = JSON.parse(await sdk.fs.read('vfs.json')); assert();
      if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error('Unsupported Dish storage snapshot');
      return data.entries;
    },
    async save(entries) { assert(); await sdk.fs.write('vfs.json', JSON.stringify({ version: 1, entries })); assert(); },
  };
}
export class Snapshot {
  constructor(entries = []) {
    this.entries = new Map();
    for (const entry of entries) {
      if (!validPath(entry.path) || (!entry.directory && (!Array.isArray(entry.bytes) || entry.bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)))) throw new Error('Invalid Dish snapshot');
      this.entries.set(entry.path, entry);
    }
  }
  apply(change) {
    if (!validPath(change.path)) throw new Error('Invalid Dish mutation');
    if (change.kind === 'remove') {
      for (const key of this.entries.keys()) if (key === change.path || key.startsWith(change.path + '/')) this.entries.delete(key);
    } else if (change.kind === 'write') this.entries.set(change.path, { path: change.path, bytes: Array.from(change.bytes), mode: change.mode });
    else if (change.kind === 'mkdir') this.entries.set(change.path, { path: change.path, directory: true, mode: change.mode });
    else if (change.kind === 'chmod' && this.entries.has(change.path)) this.entries.get(change.path).mode = change.mode;
    else if (change.kind !== 'chmod') throw new Error('Unknown Dish mutation');
  }
  values() { return [...this.entries.values()].sort((a,b) => a.path.localeCompare(b.path)); }
}
