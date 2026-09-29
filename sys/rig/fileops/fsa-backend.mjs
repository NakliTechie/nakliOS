// FsaBackend — a Rig fileops storage backend over a File System Access API
// directory handle (a real local folder the user picked). Implements the same
// contract as MemoryBackend, so createFileops({ backend }) persists to disk and
// survives reload. Used by Forge (and any app that wants a real workspace) once
// the user grants a folder via showDirectoryPicker().
//
// Contract (safePath = full store path, no leading slash; '' is the root):
//   readBinary / write / delete / exists / mkdir / stat / list
//
// FSA is entirely async and handle-based; this maps paths to nested
// FileSystemDirectoryHandle / FileSystemFileHandle. The class is API-shaped, so
// it runs against a mock handle in tests (fsa-backend.test.mjs) and a real
// showDirectoryPicker() handle in the browser — no branching between them.

import { checkReadLimit, checkReadSize } from './read-limit.mjs';

export class FsaBackend {
  /** @param {FileSystemDirectoryHandle} rootHandle */
  constructor(rootHandle) {
    if (!rootHandle || typeof rootHandle.getDirectoryHandle !== 'function') {
      throw new Error('FsaBackend requires a FileSystemDirectoryHandle');
    }
    this.root = rootHandle;
    this.supportsBoundedReads = true;
  }

  _split(safePath) {
    const parts = String(safePath).split('/').filter(Boolean);
    const name = parts.pop();
    return { parts, name };
  }

  // Walk to a directory handle. create=true makes missing dirs along the way.
  async _dirHandle(parts, create = false) {
    let h = this.root;
    for (const part of parts) {
      h = await h.getDirectoryHandle(part, { create });
    }
    return h;
  }

  async readBinary(safePath, { maxBytes } = {}) {
    checkReadLimit(maxBytes);
    const { parts, name } = this._split(safePath);
    const dir = await this._dirHandle(parts, false);
    const fh = await dir.getFileHandle(name, { create: false });
    const file = await fh.getFile();
    // Check the fresh File snapshot that will supply arrayBuffer, not an older stat.
    checkReadSize(file.size, maxBytes);
    const buffer = await file.arrayBuffer();
    checkReadSize(buffer.byteLength, maxBytes);
    return new Uint8Array(buffer);
  }

  async write(safePath, data) {
    const { parts, name } = this._split(safePath);
    const dir = await this._dirHandle(parts, true);
    const fh = await dir.getFileHandle(name, { create: true });
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
  }

  async delete(safePath) {
    const { parts, name } = this._split(safePath);
    if (!name) return; // never remove the root
    let dir;
    try { dir = await this._dirHandle(parts, false); } catch { return; }
    try { await dir.removeEntry(name, { recursive: true }); } catch { /* already gone */ }
  }

  async mkdir(safePath) {
    const { parts, name } = this._split(safePath);
    await this._dirHandle(name ? [...parts, name] : parts, true);
  }

  async stat(safePath) {
    const { parts, name } = this._split(safePath);
    if (!name) return { type: 'dir', size: 0, mtimeMs: 0 }; // root
    let dir;
    try { dir = await this._dirHandle(parts, false); } catch { return null; }
    // File?
    try {
      const fh = await dir.getFileHandle(name, { create: false });
      const file = await fh.getFile();
      return { type: 'file', size: file.size, mtimeMs: file.lastModified || 0 };
    } catch { /* not a file */ }
    // Directory?
    try {
      await dir.getDirectoryHandle(name, { create: false });
      return { type: 'dir', size: 0, mtimeMs: 0 };
    } catch { /* not a dir */ }
    return null;
  }

  async exists(safePath) {
    if (safePath === '') return true;
    return (await this.stat(safePath)) != null;
  }

  // Immediate children only, each a full safePath; directories suffixed '/'.
  async list(prefix) {
    const parts = String(prefix).split('/').filter(Boolean);
    let dir;
    try { dir = await this._dirHandle(parts, false); } catch { return []; }
    const base = prefix === '' ? '' : prefix + '/';
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      out.push(base + name + (handle.kind === 'directory' ? '/' : ''));
    }
    return out.sort();
  }
}
