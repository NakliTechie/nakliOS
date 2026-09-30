// CrateBackend — a Rig fileops storage backend over the host `naklios.fs.*`
// surface (Folder or the end-to-end-encrypted Crate object store). Implements the
// same contract as MemoryBackend / FsaBackend, so createFileops({ backend })
// persists a Forge workspace to the user's cloud filesystem — the "Both" storage
// choice — with no change to the layers above.
//
// Contract (safePath = full store path, no leading slash; '' is the root):
//   readBinary / write / delete / exists / mkdir / stat / list
//
// The host `naklios.fs` surface (docs/app-contract.md) is an OBJECT STORE, so it
// is narrower than the backend contract in two ways this adapter bridges:
//
//   • Legacy hosts lack `stat`. A current host exposes metadata and bounded reads.
//   • No `mkdir` / no empty directories. Object stores have only keys; a directory
//     exists only while it has descendants. `mkdir` records a SESSION-LOCAL empty-
//     dir marker so list/stat behave, mirroring MemoryBackend's `dirs` set. Empty
//     directories are NOT persisted to Crate (there is nowhere to put them) — a
//     documented limitation, consistent with every object-store backend.
//
// The host `list(prefix)` is assumed to return descendant keys under the prefix
// (flat, object-store style); this adapter derives the IMMEDIATE-children view the
// fileops layer expects (fileops owns recursion), exactly like MemoryBackend.
//
// ── LIVE-USE BLOCK ──────────────────────────────────────────────────────
// This adapter is wired and unit-tested against a MOCK `naklios.fs`. Live Crate
// roaming (state.json across devices) is BLOCKED on the parked Crate `SyncClient`
// manifest-counter fix (see plan/pending.md "Parked"). Do not enable a live Crate
// workspace until that lands; the Folder path is unaffected.

const enc = (s) => new TextEncoder().encode(s);

export class CrateBackend {
  // @param host — the `naklios.fs` object: async readBinary/write/delete/exists/
  //               list (required); optional stat(path) -> {type,size,mtimeMs}|null.
  constructor(host) {
    if (!host || typeof host.readBinary !== 'function' || typeof host.write !== 'function' ||
        typeof host.list !== 'function' || typeof host.exists !== 'function' || typeof host.delete !== 'function') {
      throw new Error('CrateBackend requires a naklios.fs host with readBinary/write/delete/exists/list');
    }
    this.host = host;
    this._dirs = new Set(); // session-local empty-directory markers (not persisted)
    // Require an explicit host capability. A legacy whole-object reader must not
    // become a bounded reader merely because it accepts an ignored argument.
    this.supportsMetadataOnly = true;
  }

  get supportsBoundedReads() {
    return this.host.supportsBoundedReads === true && typeof this.host.stat === 'function';
  }

  async readBinary(safePath, { maxBytes } = {}) {
    if (maxBytes !== undefined && !this.supportsBoundedReads)
      throw Object.assign(new Error('host does not support bounded reads'), { code: 'ENOTSUP' });
    const data = await this.host.readBinary(safePath, { maxBytes });
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  }

  async write(safePath, data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    await this.host.write(safePath, bytes);
    // A written file makes any ancestor markers redundant; drop the exact key.
    this._dirs.delete(safePath);
  }

  async delete(safePath) {
    if (!safePath) return; // never remove the root
    await this.host.delete(safePath);
    this._dirs.delete(safePath);
  }

  async mkdir(safePath) {
    if (safePath) this._dirs.add(safePath);
  }

  async exists(safePath) {
    if (safePath === '') return true;
    if (this._dirs.has(safePath)) return true;
    return !!(await this.host.exists(safePath));
  }

  async stat(safePath, { metadataOnly = false, maxBytes } = {}) {
    if (safePath === '') return { type: 'dir', size: 0, mtimeMs: 0 };
    if (metadataOnly) {
      const parent = safePath.slice(0, Math.max(0, safePath.lastIndexOf('/')));
      const keys = await this.host.list(parent);
      if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) {
        throw Object.assign(new Error('object-store listing did not return path keys'), { code: 'EIO' });
      }
      if (keys.includes(safePath)) return { type: 'file' };
      if (this._dirs.has(safePath) || keys.some((key) => key.startsWith(safePath + '/'))
        || [...this._dirs].some((key) => key.startsWith(safePath + '/'))) return { type: 'dir' };
      return null;
    }
    if (this._dirs.has(safePath)) return { type: 'dir', size: 0, mtimeMs: 0 };
    // Prefer a host-native stat when available (avoids a full read to get size).
    if (typeof this.host.stat === 'function') {
      const s = await this.host.stat(safePath);
      if (s) return { type: s.type || 'file', size: s.size || 0, mtimeMs: s.mtimeMs || 0 };
      if (maxBytes !== undefined) return null;
    }
    if (maxBytes !== undefined)
      throw Object.assign(new Error('host does not expose bounded metadata'), { code: 'ENOTSUP' });
    // File? A readable key is a file; its byte length is the size.
    if (await this.host.exists(safePath)) {
      try {
        const bytes = await this.host.readBinary(safePath);
        return { type: 'file', size: (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).length, mtimeMs: 0 };
      } catch {
        return { type: 'dir', size: 0, mtimeMs: 0 }; // exists but not a readable key ⇒ implicit dir
      }
    }
    // Implicit directory? (has descendant keys under it)
    const desc = await this.host.list(safePath);
    if (Array.isArray(desc) && desc.some((k) => k === safePath || k.startsWith(safePath + '/'))) {
      return { type: 'dir', size: 0, mtimeMs: 0 };
    }
    return null;
  }

  // IMMEDIATE children only (one level), each a full safePath, directories
  // suffixed '/'. Derived from the host's descendant-key listing plus session dir
  // markers — the MemoryBackend algorithm (fileops owns deeper recursion).
  async list(prefix) {
    const base = prefix === '' ? '' : prefix + '/';
    const children = new Map(); // childName -> isDir
    const consider = (key, forceDir) => {
      if (prefix !== '' && !(key === prefix || key.startsWith(base))) return;
      if (key === prefix) return;
      const rest = base ? key.slice(base.length) : key;
      if (rest === '') return;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        if (forceDir) children.set(rest, true);
        else if (!children.has(rest)) children.set(rest, false);
      } else {
        children.set(rest.slice(0, slash), true);
      }
    };
    const keys = await this.host.list(prefix);
    if (Array.isArray(keys)) for (const k of keys) consider(k, false);
    for (const d of this._dirs) consider(d, true);
    return [...children.entries()]
      .map(([name, isDir]) => base + name + (isDir ? '/' : ''))
      .sort();
  }
}

// Small convenience for hosts that only surface a string `read` (not readBinary):
// wrap it so CrateBackend still gets bytes. Rarely needed — the SDK exposes
// readBinary directly — but keeps the adapter usable against a minimal host.
export function stringHostAdapter(host) {
  return {
    ...host,
    async readBinary(path) {
      if (typeof host.readBinary === 'function') return host.readBinary(path);
      const s = await host.read(path);
      return enc(typeof s === 'string' ? s : '');
    },
  };
}
