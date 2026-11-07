// Project storage behind one small interface: { list, read, readBinary, write, remove, exists }. `list(folder)` answers
// paths relative to the store, folders ending in '/'. Inside NakliOS it is the app's own scope; on the direct site it is
// the browser's private storage; tests use memory.

const clean = path => path.split('/').filter(Boolean);

export function hostStore(fs) {
  return {
    async list(folder = '') {
      const entries = await fs.list(folder);
      return entries.map(entry => (typeof entry === 'string' ? entry : entry.path + (entry.type === 'directory' ? '/' : '')));
    },
    read:path => fs.read(path),
    readBinary:async path => new Uint8Array(await fs.readBinary(path)),
    write:(path, data) => fs.write(path, data),
    remove:path => fs.delete(path),
    exists:path => fs.exists(path),
  };
}

// A same-origin mirror shares this storage with the host, so everything sits in one folder of its own.
export function browserStore(root = navigator.storage.getDirectory().then(top => top.getDirectoryHandle('scribella', { create:true }))) {
  async function folderOf(parts, create) {
    let folder = await root;
    for (const part of parts) folder = await folder.getDirectoryHandle(part, { create });
    return folder;
  }
  const fileOf = async (path, create) => {
    const parts = clean(path), name = parts.pop();
    return (await folderOf(parts, create)).getFileHandle(name, { create });
  };
  return {
    async list(folder = '') {
      const out = [], prefix = clean(folder).join('/');
      for await (const [name, handle] of (await folderOf(clean(folder), false)).entries()) {
        out.push((prefix ? `${prefix}/` : '') + name + (handle.kind === 'directory' ? '/' : ''));
      }
      return out;
    },
    read:async path => (await (await fileOf(path, false)).getFile()).text(),
    readBinary:async path => new Uint8Array(await (await (await fileOf(path, false)).getFile()).arrayBuffer()),
    async write(path, data) {
      const writable = await (await fileOf(path, true)).createWritable();
      await writable.write(data);
      await writable.close();
    },
    async remove(path) {
      const parts = clean(path), name = parts.pop();
      await (await folderOf(parts, false)).removeEntry(name, { recursive:true });
    },
    async exists(path) {
      try { await fileOf(path, false); return true; } catch (_) {}
      try { await folderOf(clean(path), false); return true; } catch (_) { return false; }
    },
  };
}

export function memoryStore(files = {}) {
  const map = new Map(Object.entries(files));
  const bytes = data => (typeof data === 'string' ? new TextEncoder().encode(data) : data);
  return {
    async list(folder = '') {
      const prefix = clean(folder).join('/'), lead = prefix ? `${prefix}/` : '', out = new Set();
      for (const path of map.keys()) {
        if (!path.startsWith(lead)) continue;
        const [first, ...rest] = path.slice(lead.length).split('/');
        out.add(lead + first + (rest.length ? '/' : ''));
      }
      return [...out];
    },
    read:async path => { if (!map.has(path)) throw new Error(`ENOENT: ${path}`); return new TextDecoder().decode(bytes(map.get(path))); },
    readBinary:async path => { if (!map.has(path)) throw new Error(`ENOENT: ${path}`); return bytes(map.get(path)); },
    write:async (path, data) => { map.set(path, data); },
    remove:async path => { for (const key of [...map.keys()]) if (key === path || key.startsWith(`${path}/`)) map.delete(key); },
    exists:async path => map.has(path) || [...map.keys()].some(key => key.startsWith(`${path}/`)),
  };
}
