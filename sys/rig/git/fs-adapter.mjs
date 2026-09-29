// fs-adapter — presents a Node-fs-shaped `{ promises }` surface over a Rig
// fileops instance, so vendored isomorphic-git runs over naklios.fs unchanged.
// This is the C2 "adapter only, never fork isomorphic-git" boundary.
//
// Two translations matter:
//   1. isomorphic-git expects the Node contract: methods THROW errors carrying
//      a `.code` ('ENOENT', 'ENOTDIR', …). Rig fileops returns typed
//      { ok:false, code } results. The adapter converts result → coded throw.
//   2. stat/lstat must return STABLE `ino`/`dev` — synthesised from a path hash.
//      If ino changed between calls, git would see phantom modifications.

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0) || 1; // never 0
}

function nodeErr(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

// mode bits git cares about: regular file, directory, symlink. The object store
// has no executable bit; 0o100644 is correct for all tracked blobs here.
function modeFor(type) {
  return type === 'dir' ? 0o40000 : type === 'symlink' ? 0o120000 : 0o100644;
}

function makeStat(path, st) {
  const type = st.type;
  const sec = Math.floor((st.mtimeMs || 0) / 1000);
  return {
    type,
    mode: modeFor(type),
    size: st.size || 0,
    ino: fnv(path),
    uid: 1,
    gid: 1,
    dev: 1, // one synthetic device for the whole mount — stable
    mtimeMs: st.mtimeMs || 0,
    ctimeMs: st.mtimeMs || 0,
    mtimeSeconds: sec,
    ctimeSeconds: sec,
    isFile: () => type === 'file',
    isDirectory: () => type === 'dir',
    isSymbolicLink: () => type === 'symlink',
  };
}

// Racy git. isomorphic-git trusts an index entry whose size and whole-second mtime match the file
// (compareStats), so an edit of the same size in the same second as `git add` was invisible to
// status, diff and commit -a — and on a backend that reports no mtime (0), every same-size edit was
// (2026-09-29). Real git "smudges" such entries when it writes the index: the stored size becomes 0,
// the next compare fails, and the file is hashed. This does the same on every index write. An entry
// is racy when its mtime is not before the second the index is written in, or is unknown (0).
// Index versions 2 and 3 only (what isomorphic-git writes); anything else is left as it is.
export async function smudgeRacyEntries(bytes, nowMs = Date.now()) {
  const b = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle || b.length < 32 || view.getUint32(0) !== 0x44495243) return bytes; // 'DIRC'
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) return bytes;
  const nowSec = Math.floor(nowMs / 1000);
  let off = 12, changed = false;
  for (let i = 0, n = view.getUint32(8); i < n; i++) {
    const mtimeSec = view.getUint32(off + 8), mtimeNs = view.getUint32(off + 12);
    const isFile = (view.getUint32(off + 24) >>> 12) === 8;
    if (isFile && view.getUint32(off + 36) !== 0 && (mtimeSec >= nowSec || (mtimeSec === 0 && mtimeNs === 0))) {
      view.setUint32(off + 36, 0); changed = true;
    }
    const pathStart = off + 62 + (version === 3 && (view.getUint16(off + 60) & 0x4000) ? 2 : 0);
    let end = pathStart; while (end < b.length && b[end] !== 0) end++;
    off += (pathStart - off + (end - pathStart) + 8) & ~7;
  }
  if (!changed) return bytes;
  const sum = new Uint8Array(await subtle.digest('SHA-1', b.subarray(0, b.length - 20)));
  b.set(sum, b.length - 20);
  return b;
}

/**
 * @param {object} fs  a createFileops(...) instance
 * @returns an object with a `.promises` namespace consumable by isomorphic-git.
 */
export function makeFsAdapter(fs) {
  const promises = {
    async readFile(path, opts) {
      const encoding = typeof opts === 'string' ? opts : (opts && opts.encoding);
      const norm = encoding === 'utf8' ? 'utf-8' : encoding;
      const res = await fs.read(path, norm ? { encoding: norm } : {});
      if (!res.ok) throw nodeErr(res.code, res.message);
      return res.data;
    },

    async writeFile(path, data, _opts) {
      if (/(^|\/)\.git\/index$/.test(path) && typeof data !== 'string') data = await smudgeRacyEntries(data);
      // isomorphic-git mkdirs first, but createParents keeps the Folder backend
      // safe if a parent is missing; the object store ignores dirs anyway.
      const res = await fs.write(path, data, { createParents: true });
      if (!res.ok) throw nodeErr(res.code, res.message);
    },

    async unlink(path) {
      const res = await fs.remove(path);
      if (!res.ok) throw nodeErr(res.code, res.message);
    },

    async readdir(path) {
      const res = await fs.list(path);
      if (!res.ok) throw nodeErr(res.code, res.message);
      return res.entries.map((e) => e.name);
    },

    async mkdir(path, opts) {
      const res = await fs.mkdir(path, { createParents: !!(opts && opts.recursive) });
      if (!res.ok) throw nodeErr(res.code, res.message);
    },

    async rmdir(path) {
      const res = await fs.remove(path, { recursive: false });
      if (!res.ok) throw nodeErr(res.code, res.message);
    },

    async stat(path) {
      const res = await fs.stat(path);
      if (!res.ok) throw nodeErr(res.code, res.message);
      return makeStat(path, res.stat);
    },

    // The backends do not represent symlinks (a repo containing one fails loudly
    // at symlink() below), so lstat === stat here.
    async lstat(path) {
      return promises.stat(path);
    },

    // Fail loudly — never a silent no-op (RIG §5).
    async symlink(_target, _path) {
      throw nodeErr('ENOSYS', 'symlinks are not supported on this storage backend');
    },
    async readlink(path) {
      throw nodeErr('EINVAL', `not a symlink: ${path}`);
    },

    // The object store has no file modes; accept and ignore so isomorphic-git's
    // optional chmod path does not error.
    async chmod(_path, _mode) {},
  };

  return { promises };
}
