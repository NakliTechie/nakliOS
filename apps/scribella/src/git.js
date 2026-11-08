// Local version history with Git, kept in the project's hidden .git folder. isomorphic-git runs over the project
// store through a small Node-style adapter. The adapter's racy-entry handling comes from NakliOS's Rig adapter.
import * as git from '../vendor/isomorphic-git/isomorphic-git.mjs';

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


const AUTHOR = { name:'Scribella', email:'scribella@local' };

// `root` is the project folder in the store; git sees it as '/'.
export function storeFs(store, root) {
  const real = path => {
    const parts = String(path).split('/').filter(part => part && part !== '.');
    return [root, ...parts].join('/');
  };
  const promises = {
    async readFile(path, opts) {
      const encoding = typeof opts === 'string' ? opts : opts?.encoding;
      if (!await store.exists(real(path))) throw nodeErr('ENOENT', path);
      return encoding ? store.read(real(path)) : store.readBinary(real(path));
    },
    async writeFile(path, data) {
      if (/(^|\/)\.git\/index$/.test(path) && typeof data !== 'string') data = await smudgeRacyEntries(data);
      await store.write(real(path), data);
    },
    async unlink(path) {
      if (!await store.exists(real(path))) throw nodeErr('ENOENT', path);
      await store.remove(real(path));
    },
    async readdir(path) {
      if (!await store.exists(real(path))) throw nodeErr('ENOENT', path);
      return (await store.list(real(path))).map(entry => entry.replace(/\/$/, '').split('/').pop());
    },
    async mkdir(path) { await store.mkdir?.(real(path)); },
    async rmdir(path) { await store.remove(real(path)); },
    async stat(path) {
      const found = await store.stat(real(path));
      if (!found) throw nodeErr('ENOENT', path);
      return makeStat(path, found);
    },
    async lstat(path) { return promises.stat(path); },
    async symlink() { throw nodeErr('ENOSYS', 'symlinks are not supported'); },
    async readlink(path) { throw nodeErr('EINVAL', `not a symlink: ${path}`); },
    async chmod() {},
  };
  return { promises };
}

const SKIP = path => path.split('/').some(part => part.startsWith('.'));

export function projectGit(store, root) {
  const base = { fs:storeFs(store, root), dir:'/' };
  async function ready() {
    if (await store.exists(`${root}/.git/HEAD`)) return;
    await git.init({ ...base, defaultBranch:'main' });
  }
  return {
    // Stages every change, deletions included, then commits. Answers null when nothing changed.
    async commitAll(message, now = Date.now()) {
      await ready();
      let changed = 0;
      for (const [file, head, work, stage] of await git.statusMatrix(base)) {
        if (SKIP(file) || (head === 1 && work === 1 && stage === 1)) continue;
        if (work === 0) await git.remove({ ...base, filepath:file });
        else await git.add({ ...base, filepath:file });
        changed += 1;
      }
      if (!changed) return null;
      const author = { ...AUTHOR, timestamp:Math.floor(now / 1000), timezoneOffset:0 };
      return { oid:await git.commit({ ...base, message, author, committer:author }), changed };
    },
    async log(depth = 50) {
      if (!await store.exists(`${root}/.git/HEAD`)) return [];
      try { return (await git.log({ ...base, depth })).map(({ oid, commit }) => ({ oid, message:commit.message.trim(), at:commit.author.timestamp * 1000 })); }
      catch (error) { if (error.code === 'NotFoundError') return []; throw error; }
    },
    // The files a commit changed against its parent.
    async changed(oid) {
      const { commit } = await git.readCommit({ ...base, oid });
      const trees = [git.TREE({ ref:oid }), git.TREE({ ref:commit.parent[0] || oid })];
      const files = [];
      await git.walk({ ...base, trees:commit.parent[0] ? trees : [trees[0]], map:async (path, [now, then]) => {
        if (path === '.' || (await now?.type()) === 'tree') return true;
        if (!commit.parent[0] || (await now?.oid()) !== (await then?.oid())) files.push(path);
        return true;
      } });
      return files;
    },
    async readAt(oid, filepath) {
      const { blob } = await git.readBlob({ ...base, oid, filepath });
      return blob;
    },
  };
}
