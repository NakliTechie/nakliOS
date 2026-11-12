// Storage adapters (spec 002 §9.2, §9.3): the app's only filesystem surface. One interface, three
// backends, chosen once by capability and re-picked when capabilities change:
//   host    → naklios.fs (the NakliOS Folder or Crate, paths under apps/atelier/)
//   folder  → a folder the person picked (File System Access), standalone only
//   browser → this browser's OPFS (app-owned Browser storage), always available standalone
// Interface: { kind, label, readBinary, readRange, readText, write, list, exists, delete }
// readRange(path, offset, length) returns at most length bytes from offset (fewer at the end of the file).

export function hostStore(naklios) {
  const fs = naklios.fs;
  return {
    kind: 'host', label: `NakliOS ${naklios.capabilities.fsBackend || 'storage'}`,
    async readBinary(path) { return new Uint8Array(await fs.readBinary(path)); },
    // A bounded read where the host's Folder advertises byte ranges (capabilities.fsRangeReads, at most
    // 16 MiB a call); elsewhere (Crate, older hosts) the whole file is read and sliced.
    async readRange(path, offset, length) {
      if (naklios.capabilities.fsRangeReads && length <= 16 * 1024 * 1024) return new Uint8Array(await fs.readBinary(path, { offset, maxBytes: length }));
      return new Uint8Array(await fs.readBinary(path)).slice(offset, offset + length);
    },
    readText: (path) => fs.read(path),
    write: (path, data) => fs.write(path, data),
    async list(prefix = '') {
      const out = await fs.list(prefix);
      return (out || []).map((e) => (typeof e === 'string' ? { path: e, type: 'file' } : { path: e.path ?? e.name, type: e.type ?? 'file' }));
    },
    exists: (path) => fs.exists(path),
    delete: (path) => fs.delete(path),
  };
}

// Folder and browser share the File System Access directory-handle code.
export function directoryStore(root, kind, label) {
  const parts = (p) => p.split('/').filter(Boolean);
  async function dir(segs, create) {
    let d = root;
    for (const s of segs) d = await d.getDirectoryHandle(s, { create });
    return d;
  }
  async function fileHandle(path, create = false) {
    const segs = parts(path);
    if (segs.some((s) => s === '..' || s === '.')) throw new Error(`path escapes the workspace: ${path}`);
    return (await dir(segs.slice(0, -1), create)).getFileHandle(segs.at(-1), { create });
  }
  return {
    kind, label,
    async readBinary(path) { return new Uint8Array(await (await (await fileHandle(path)).getFile()).arrayBuffer()); },
    async readRange(path, offset, length) { return new Uint8Array(await (await (await fileHandle(path)).getFile()).slice(offset, offset + length).arrayBuffer()); },
    async readText(path) { return (await (await fileHandle(path)).getFile()).text(); },
    async write(path, data) {
      // temp file, then move into place: a killed tab leaves the old file or the new one (spec 002 §0.5)
      const segs = parts(path); const d = await dir(segs.slice(0, -1), true); const name = segs.at(-1);
      // A temp name of its own per write, so two writes to one path (autosave and a Save click) never share
      // a locked temp file; the later move wins, and each leaves a whole file.
      const tmpName = `${name}.${Math.random().toString(36).slice(2, 10)}.tmp`;
      const tmp = await d.getFileHandle(tmpName, { create: true });
      try {
        const w = await tmp.createWritable(); await w.write(data); await w.close();
        if (tmp.move) { await tmp.move(name); return; }
        const fh = await d.getFileHandle(name, { create: true }); const w2 = await fh.createWritable(); await w2.write(data); await w2.close();
      } catch (e) {
        // A failed write (disk full, permission revoked) removes its own temp file: the target keeps
        // the old content and no stray .tmp is left beside it.
        try { await d.removeEntry(tmpName); } catch { /* already gone (moved) or unreachable */ }
        throw e;
      }
      await d.removeEntry(tmpName);
    },
    async list(prefix = '') {
      const out = [];
      let start;
      try { start = await dir(parts(prefix), false); } catch { return out; }
      async function walk(d, base) {
        for await (const [name, h] of d.entries()) {
          if (name.endsWith('.tmp')) continue;
          const p = base ? `${base}/${name}` : name;
          if (h.kind === 'directory') await walk(h, p); else out.push({ path: p, type: 'file' });
        }
      }
      await walk(start, parts(prefix).join('/'));
      return out.sort((a, b) => a.path.localeCompare(b.path));
    },
    async exists(path) { try { await fileHandle(path); return true; } catch { return false; } },
    async delete(path) { const segs = parts(path); await (await dir(segs.slice(0, -1), false)).removeEntry(segs.at(-1)); },
  };
}

export async function browserStore() {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('atelier', { create: true });
  return directoryStore(root, 'browser', 'This browser');
}

// Picks the adapter: host when NakliOS offers a filesystem, else a granted folder, else this browser.
export async function pickStore({ naklios, folder }) {
  if (naklios?.capabilities?.hosted && naklios.capabilities.fs) return hostStore(naklios);
  if (folder) return directoryStore(folder, 'folder', folder.name);
  return browserStore();
}

// Runs fn after every earlier fn queued under the same key has finished (resolved or failed), so two
// read-modify-write cycles on one file (a sidecar) never interleave and drop each other's change.
const chains = new Map();
export function serial(key, fn) {
  const run = (chains.get(key) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

export const RAW_EXT = ['arw', 'nef', 'cr2', 'cr3', 'dng', 'raf', 'orf', 'rw2'];
export const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'tif', 'tiff', 'psd'];
export const extOf = (path) => path.split('.').pop().toLowerCase();
