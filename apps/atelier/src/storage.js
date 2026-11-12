// Storage adapters (spec 002 §9.2, §9.3): the app's only filesystem surface. One interface, three
// backends, chosen once by capability and re-picked when capabilities change:
//   host    → naklios.fs (the NakliOS Folder or Crate, paths under apps/atelier/)
//   folder  → a folder the person picked (File System Access), standalone only
//   browser → this browser's OPFS (app-owned Browser storage), always available standalone
// Interface: { kind, label, readBinary, readText, write, list, exists, delete }

export function hostStore(naklios) {
  const fs = naklios.fs;
  return {
    kind: 'host', label: `NakliOS ${naklios.capabilities.fsBackend || 'storage'}`,
    async readBinary(path) { return new Uint8Array(await fs.readBinary(path)); },
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
    async readText(path) { return (await (await fileHandle(path)).getFile()).text(); },
    async write(path, data) {
      // temp file, then move into place: a killed tab leaves the old file or the new one (spec 002 §0.5)
      const segs = parts(path); const d = await dir(segs.slice(0, -1), true); const name = segs.at(-1);
      const tmp = await d.getFileHandle(`${name}.tmp`, { create: true });
      const w = await tmp.createWritable(); await w.write(data); await w.close();
      if (tmp.move) { await tmp.move(name); return; }
      const fh = await d.getFileHandle(name, { create: true }); const w2 = await fh.createWritable(); await w2.write(data); await w2.close();
      await d.removeEntry(`${name}.tmp`);
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

export const RAW_EXT = ['arw', 'nef', 'cr2', 'cr3', 'dng', 'raf', 'orf', 'rw2'];
export const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'tif', 'tiff', 'psd'];
export const extOf = (path) => path.split('.').pop().toLowerCase();
