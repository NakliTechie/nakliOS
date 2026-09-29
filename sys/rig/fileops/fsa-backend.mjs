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

// DOMException.code is a legacy number, not a filesystem error code. Keep
// provider failures typed at the metadata-only boundary without changing the
// older best-effort backend paths.
function metadataError(error, operation, path) {
  if (error?.code === 130 || error?.cancelled) return error;
  const code = typeof error?.code === 'string' && /^E[A-Z0-9_]+$/.test(error.code) ? error.code : ({
    NotFoundError: 'ENOENT', TypeMismatchError: 'ENOTDIR',
    NotAllowedError: 'EACCES', SecurityError: 'EACCES', NoModificationAllowedError: 'EACCES',
    InvalidModificationError: 'ENOTEMPTY', NotSupportedError: 'ENOTSUP', AbortError: 'ECANCELED',
  }[error?.name] || 'EIO');
  return Object.assign(new Error(`${operation} ${path}: ${error?.message || 'provider failed'}`, { cause: error }), { code });
}

export class FsaBackend {
  /** @param {FileSystemDirectoryHandle} rootHandle */
  constructor(rootHandle) {
    if (!rootHandle || typeof rootHandle.getDirectoryHandle !== 'function') {
      throw new Error('FsaBackend requires a FileSystemDirectoryHandle');
    }
    this.root = rootHandle;
    this.supportsBoundedReads = true;
    this.supportsMetadataOnly = true;
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

  async delete(safePath, { metadataOnly } = {}) {
    const { parts, name } = this._split(safePath);
    if (!name) {
      if (metadataOnly) throw metadataError(Object.assign(new Error('cannot remove the filesystem root'), { code: 'EBUSY' }), 'remove', '/');
      return; // never remove the root
    }
    let dir;
    try { dir = await this._dirHandle(parts, false); }
    catch (error) { if (metadataOnly) throw metadataError(error, 'remove', safePath); return; }
    // A checked empty directory may gain children before removeEntry. Metadata
    // deletion is nonrecursive, so that race must fail rather than remove them.
    try { await dir.removeEntry(name, { recursive: !metadataOnly }); }
    catch (error) { if (metadataOnly) throw metadataError(error, 'remove', safePath); /* already gone */ }
  }

  async mkdir(safePath) {
    const { parts, name } = this._split(safePath);
    await this._dirHandle(name ? [...parts, name] : parts, true);
  }

  async stat(safePath, { metadataOnly } = {}) {
    const { parts, name } = this._split(safePath);
    if (!name) return { type: 'dir', size: 0, mtimeMs: 0 }; // root
    let dir;
    try { dir = await this._dirHandle(parts, false); }
    catch (error) {
      if (metadataOnly && error?.name !== 'NotFoundError') throw metadataError(error, 'stat', safePath);
      return null;
    }
    // File?
    try {
      const fh = await dir.getFileHandle(name, { create: false });
      const file = await fh.getFile();
      return { type: 'file', size: file.size, mtimeMs: file.lastModified || 0 };
    } catch (error) {
      if (metadataOnly && !['NotFoundError', 'TypeMismatchError'].includes(error?.name)) throw metadataError(error, 'stat', safePath);
      /* not a file */
    }
    // Directory?
    try {
      await dir.getDirectoryHandle(name, { create: false });
      return { type: 'dir', size: 0, mtimeMs: 0 };
    } catch (error) {
      if (metadataOnly && error?.name !== 'NotFoundError') throw metadataError(error, 'stat', safePath);
      /* not a dir */
    }
    return null;
  }

  async exists(safePath) {
    if (safePath === '') return true;
    return (await this.stat(safePath)) != null;
  }

  // Immediate children only, each a full safePath; directories suffixed '/'.
  async list(prefix, { metadataOnly } = {}) {
    const parts = String(prefix).split('/').filter(Boolean);
    let dir;
    try { dir = await this._dirHandle(parts, false); }
    catch (error) { if (metadataOnly) throw metadataError(error, 'list', prefix); return []; }
    const base = prefix === '' ? '' : prefix + '/';
    const out = [];
    try {
      for await (const [name, handle] of dir.entries()) {
        out.push(base + name + (handle.kind === 'directory' ? '/' : ''));
      }
    } catch (error) {
      if (metadataOnly) throw metadataError(error, 'list', prefix);
      throw error;
    }
    return out.sort();
  }
}
