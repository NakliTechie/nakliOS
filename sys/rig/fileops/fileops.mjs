// fileops — Rig's C0 filesystem surface.
//
// Composes the injected storage backend (live BACKENDS[bound] in the browser,
// MemoryBackend in tests) into the 11-op API the handoff specifies:
//
//   read(path,{encoding})  write(path,data,{createParents})  list(path,{recursive})
//   stat(path)   mkdir(path,{createParents})   remove(path,{recursive})
//   move(from,to)   copy(from,to)   patch(path,unifiedDiff)
//   glob(pattern,{cwd})   grep(pattern,{cwd,glob,maxResults})
//
// Backend contract (deliberately the common denominator of Folder + Crate):
//   readBinary/write/delete/exists/stat/mkdir act on a single safePath.
//   list(safeDir) returns the IMMEDIATE children only (one level), each a full
//   safePath, directories suffixed '/'. Recursion is owned here, not by the
//   backend — so a one-level Folder (fsList) and an object-store Crate both work.
//
// Contract:
//   - Every external path passes normalizeMountPath (the one ingress). ".."
//     escapes, absolute escapes, encoded traversal, symlink-out all fail closed.
//   - read returns a Uint8Array by default; text only with {encoding}.
//   - Expected conditions return typed { ok:false, code, message } — no throws.
//   - patch is atomic (no write on a failed hunk) and returns an exact `revert`.

import { normalizeMountPath, joinRoot } from './pathguard.mjs';
import { applyPatch, reversePatch } from './patch.mjs';

const enc = new TextEncoder();

function err(code, message, extra) {
  return { ok: false, code, message, ...(extra || {}) };
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return enc.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function globToRegExp(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // '**/' also matches zero dirs
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(re + '$');
}

/**
 * @param {object}  opts
 * @param {object}  opts.backend        storage primitive (see MemoryBackend)
 * @param {string}  [opts.root='']      mount root; all paths resolve within it
 * @param {number}  [opts.symlinkDepth] max symlink hops before ELOOP
 * @param {number}  [opts.grepCap]      default grep maxResults
 * @param {Function} [opts.onSearch]    called with one SearchStat per grep (measurement only)
 */
export function createFileops({ backend, root = '', symlinkDepth = 8, grepCap = 1000, onSearch = null }) {
  if (!backend) throw new Error('createFileops requires a backend');
  const rootPrefix = String(root || '').replace(/\/+$/, '');

  // Validate + fully resolve symlinks, re-checking mount containment on every
  // hop. Returns { ok, path (mount-relative), safe (backend safePath) }.
  async function resolveMount(mountRel, depthLeft) {
    const v = normalizeMountPath(mountRel);
    if (!v.ok) return v;
    const acc = [];
    for (let i = 0; i < v.segments.length; i++) {
      acc.push(v.segments[i]);
      const safe = joinRoot(rootPrefix, acc.join('/'));
      const st = await backend.stat(safe);
      if (st && st.type === 'symlink') {
        if (depthLeft <= 0) {
          return err('ELOOP', 'too many symlink levels', { input: mountRel });
        }
        const parent = acc.slice(0, -1).join('/');
        const combined = (parent ? parent + '/' : '') + st.target;
        const rest = v.segments.slice(i + 1).join('/');
        const next = combined + (rest ? '/' + rest : '');
        // normalizeMountPath inside the recursion rejects a target that climbs
        // above the mount root — this is the symlink-escape gate.
        const r = await resolveMount(next, depthLeft - 1);
        if (!r.ok && r.code === 'EINVAL_PATH') {
          return err('EINVAL_PATH', 'symlink escapes mount root', { input: mountRel });
        }
        return r;
      }
    }
    const path = acc.join('/');
    return { ok: true, path, safe: joinRoot(rootPrefix, path) };
  }

  const resolve = (p) => resolveMount(p, symlinkDepth);

  // Immediate children of a directory safePath → [{ safe, name, type }].
  // Collapses whatever the backend returns to one level, so it is correct
  // whether backend.list is one-level (Folder/fsList) or recursive (an
  // object-store Crate that returns deep descendants). A deeper entry
  // contributes its first segment as a directory child.
  async function listChildren(safeDir) {
    const raw = await backend.list(safeDir);
    const base = safeDir === '' ? '' : safeDir + '/';
    const map = new Map(); // childName -> isDir
    for (const full0 of raw) {
      const isDirMark = full0.endsWith('/');
      const full = isDirMark ? full0.slice(0, -1) : full0;
      if (full === safeDir) continue;
      const rel = base ? (full.startsWith(base) ? full.slice(base.length) : full) : full;
      if (rel === '') continue;
      const slash = rel.indexOf('/');
      if (slash === -1) {
        if (isDirMark) map.set(rel, true);
        else if (!map.has(rel)) map.set(rel, false);
      } else {
        map.set(rel.slice(0, slash), true); // deeper ⇒ a directory at this level
      }
    }
    return [...map.entries()].map(([name, isDir]) => ({
      safe: base + name, name, type: isDir ? 'dir' : 'file',
    }));
  }

  // Depth-first walk. Returns { files:[safe], dirs:[safe] } for all descendants.
  // ── search instrumentation (measurement only; changes no result) ──────────
  // Why this exists: plan/anvil-indexed-search.md §6 — before an index is worth
  // building we need to know what search actually costs on real workspaces.
  // A grep is walk + (stat + readBinary) per file, so the interesting numbers
  // are files opened and bytes decoded, not wall time alone.
  // Never throws into the caller: a broken meter must not break a search.
  const searchLog = [];
  const searchTotals = { calls: 0, filesWalked: 0, filesRead: 0, bytesRead: 0, ms: 0, truncated: 0, empty: 0 };
  const SEARCH_LOG_CAP = 200;

  function recordSearch(stat) {
    searchTotals.calls++;
    searchTotals.filesWalked += stat.filesWalked;
    searchTotals.filesRead += stat.filesRead;
    searchTotals.bytesRead += stat.bytesRead;
    searchTotals.ms += stat.ms;
    if (stat.truncated) searchTotals.truncated++;
    // The expensive class (§1): few-or-no matches means the cap never fired and
    // the whole workspace was read. Counted separately because it is the one
    // an agent hits most and the one an index would help most.
    if (stat.matches === 0) searchTotals.empty++;
    searchLog.push(stat);
    if (searchLog.length > SEARCH_LOG_CAP) searchLog.shift();
    if (onSearch) { try { onSearch(stat); } catch (_) { /* a meter never breaks a search */ } }
  }

  function searchStats({ reset = false } = {}) {
    const out = {
      totals: { ...searchTotals },
      recent: searchLog.slice(),
      // Derived, so a caller does not have to: the two ratios that decide §6.
      avgFilesRead: searchTotals.calls ? searchTotals.filesRead / searchTotals.calls : 0,
      avgBytesRead: searchTotals.calls ? searchTotals.bytesRead / searchTotals.calls : 0,
      emptyShare: searchTotals.calls ? searchTotals.empty / searchTotals.calls : 0,
    };
    if (reset) {
      searchLog.length = 0;
      for (const k of Object.keys(searchTotals)) searchTotals[k] = 0;
    }
    return out;
  }

  async function walkAll(safeDir) {
    const files = [];
    const dirs = [];
    const stack = [safeDir];
    while (stack.length) {
      const d = stack.pop();
      for (const c of await listChildren(d)) {
        if (c.type === 'dir') { dirs.push(c.safe); stack.push(c.safe); }
        else files.push(c.safe);
      }
    }
    return { files, dirs };
  }

  async function ensureParents(mountPath) {
    const parts = mountPath.split('/');
    for (let k = 1; k < parts.length; k++) {
      const anc = joinRoot(rootPrefix, parts.slice(0, k).join('/'));
      const st = await backend.stat(anc);
      if (!st && backend.mkdir) await backend.mkdir(anc);
    }
  }

  async function read(path, opts = {}) {
    const r = await resolve(path);
    if (!r.ok) return r;
    const st = await backend.stat(r.safe);
    if (!st) return err('ENOENT', `no such file: ${r.path}`, { path: r.path });
    if (st.type === 'dir') return err('EISDIR', `is a directory: ${r.path}`, { path: r.path });
    const bytes = await backend.readBinary(r.safe);
    if (opts.encoding) {
      return { ok: true, data: new TextDecoder(opts.encoding).decode(bytes) };
    }
    return { ok: true, data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) };
  }

  async function write(path, data, opts = {}) {
    const bytes = toBytes(data);
    if (bytes === null) return err('EINVAL', 'data must be a string, Uint8Array, or ArrayBuffer');
    const r = await resolve(path);
    if (!r.ok) return r;
    const st = await backend.stat(r.safe);
    if (st && st.type === 'dir') return err('EISDIR', `is a directory: ${r.path}`, { path: r.path });
    if (opts.createParents) await ensureParents(r.path);
    await backend.write(r.safe, bytes);
    return { ok: true, path: r.path };
  }

  async function stat(path) {
    const r = await resolve(path);
    if (!r.ok) return r;
    const st = await backend.stat(r.safe);
    if (!st) return err('ENOENT', `no such path: ${r.path}`, { path: r.path });
    const out = { type: st.type, size: st.size ?? 0, mtimeMs: st.mtimeMs ?? 0 };
    if (st.target !== undefined) out.target = st.target;
    return { ok: true, stat: out };
  }

  async function mkdir(path, opts = {}) {
    const r = await resolve(path);
    if (!r.ok) return r;
    const st = await backend.stat(r.safe);
    if (st) {
      if (st.type === 'dir') return { ok: true, path: r.path };
      return err('EEXIST', `already exists: ${r.path}`, { path: r.path });
    }
    if (opts.createParents) await ensureParents(r.path);
    if (backend.mkdir) await backend.mkdir(r.safe);
    return { ok: true, path: r.path };
  }

  async function list(path, opts = {}) {
    const r = await resolve(path);
    if (!r.ok) return r;
    const st = await backend.stat(r.safe);
    if (!st) return err('ENOENT', `no such directory: ${r.path}`, { path: r.path });
    if (st.type !== 'dir') return err('ENOTDIR', `not a directory: ${r.path}`, { path: r.path });
    const base = r.safe === '' ? '' : r.safe + '/';
    const toEntry = (safe, type) => {
      const rel = base ? (safe.startsWith(base) ? safe.slice(base.length) : safe) : safe;
      return { path: r.path ? r.path + '/' + rel : rel, name: rel.split('/').pop(), type };
    };
    let entries;
    if (opts.recursive) {
      const { files, dirs } = await walkAll(r.safe);
      entries = [...dirs.map((d) => toEntry(d, 'dir')), ...files.map((f) => toEntry(f, 'file'))];
    } else {
      const children = await listChildren(r.safe);
      entries = children.map((c) => ({
        path: r.path ? r.path + '/' + c.name : c.name, name: c.name, type: c.type,
      }));
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { ok: true, entries };
  }

  async function remove(path, opts = {}) {
    const r = await resolve(path);
    if (!r.ok) return r;
    const st = await backend.stat(r.safe);
    if (!st) return err('ENOENT', `no such path: ${r.path}`, { path: r.path });
    // Directories are implicit on object stores (Crate.remove throws on a
    // folder); deleting a dir path there is a no-op success. So dir-path deletes
    // are best-effort, while file deletes are strict — a failed file delete is a
    // real EIO, surfaced as a typed result rather than a throw.
    const deleteDir = async (p) => { try { await backend.delete(p); } catch (_) { /* implicit dir */ } };
    const deleteFile = async (p) => {
      try { await backend.delete(p); return null; }
      catch (e) { return err('EIO', `could not remove ${p}: ${e && e.message ? e.message : e}`); }
    };
    if (st.type === 'dir') {
      const { files, dirs } = await walkAll(r.safe);
      if ((files.length || dirs.length) && !opts.recursive) {
        return err('ENOTEMPTY', `directory not empty: ${r.path}`, { path: r.path });
      }
      for (const f of files) { const e = await deleteFile(f); if (e) return e; }
      // deepest-first so a backend that tracks explicit dir markers stays consistent
      for (const d of dirs.sort((a, b) => b.split('/').length - a.split('/').length)) await deleteDir(d);
      await deleteDir(r.safe);
      return { ok: true, path: r.path };
    }
    const e = await deleteFile(r.safe);
    if (e) return e;
    return { ok: true, path: r.path };
  }

  async function copy(from, to) {
    const fr = await resolve(from);
    if (!fr.ok) return fr;
    const tr = await resolve(to);
    if (!tr.ok) return tr;
    const fst = await backend.stat(fr.safe);
    if (!fst) return err('ENOENT', `no such path: ${fr.path}`, { path: fr.path });
    const tst = await backend.stat(tr.safe);
    if (tst) return err('EEXIST', `destination exists: ${tr.path}`, { path: tr.path });
    if (fst.type === 'dir') {
      const { files } = await walkAll(fr.safe);
      const fromBase = fr.safe === '' ? '' : fr.safe + '/';
      if (backend.mkdir) await backend.mkdir(tr.safe);
      for (const f of files) {
        const rel = f.startsWith(fromBase) ? f.slice(fromBase.length) : f;
        const bytes = await backend.readBinary(f);
        await backend.write(joinRoot(tr.safe, rel), bytes);
      }
      return { ok: true, from: fr.path, to: tr.path };
    }
    const bytes = await backend.readBinary(fr.safe);
    await backend.write(tr.safe, bytes);
    return { ok: true, from: fr.path, to: tr.path };
  }

  async function move(from, to) {
    const c = await copy(from, to);
    if (!c.ok) return c;
    const rm = await remove(from, { recursive: true });
    if (!rm.ok) return rm;
    return { ok: true, from: c.from, to: c.to };
  }

  async function patch(path, unifiedDiff) {
    const r = await resolve(path);
    if (!r.ok) return r;
    const st = await backend.stat(r.safe);
    if (!st) return err('ENOENT', `no such file: ${r.path}`, { path: r.path });
    if (st.type === 'dir') return err('EISDIR', `is a directory: ${r.path}`, { path: r.path });
    const bytes = await backend.readBinary(r.safe);
    const text = new TextDecoder('utf-8').decode(bytes);
    const applied = applyPatch(text, unifiedDiff);
    if (!applied.ok) return applied; // EPATCH names the hunk; nothing written (atomic)
    await backend.write(r.safe, enc.encode(applied.result));
    return { ok: true, path: r.path, revert: reversePatch(unifiedDiff) };
  }

  async function glob(pattern, opts = {}) {
    const cr = await resolve(opts.cwd || '');
    if (!cr.ok) return cr;
    const { files } = await walkAll(cr.safe);
    const base = cr.safe === '' ? '' : cr.safe + '/';
    const re = globToRegExp(pattern);
    const matches = [];
    for (const f of files) {
      const rel = base ? (f.startsWith(base) ? f.slice(base.length) : f) : f;
      if (re.test(rel)) matches.push(cr.path ? cr.path + '/' + rel : rel);
    }
    matches.sort();
    return { ok: true, matches };
  }

  async function grep(pattern, opts = {}) {
    const max = opts.maxResults || grepCap;
    const t0 = Date.now();
    let filesRead = 0;
    let bytesRead = 0;
    const cr = await resolve(opts.cwd || '');
    if (!cr.ok) return cr;
    const globbed = await glob(opts.glob || '**', { cwd: opts.cwd || '' });
    if (!globbed.ok) return globbed;
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    const matches = [];
    let truncated = false;
    outer: for (const p of globbed.matches) {
      const rd = await read(p, { encoding: 'utf-8' });
      if (!rd.ok) continue; // skip unreadable/binary silently
      filesRead++;
      bytesRead += rd.data.length;
      const lines = rd.data.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          if (matches.length >= max) { truncated = true; break outer; }
          matches.push({ path: p, line: i + 1, text: lines[i] });
        }
      }
    }
    recordSearch({
      via: 'fs.grep',
      pattern: String(pattern),
      cwd: opts.cwd || '',
      glob: opts.glob || '**',
      filesWalked: globbed.matches.length,
      filesRead,
      bytesRead,
      matches: matches.length,
      truncated,
      ms: Date.now() - t0,
      at: t0,
    });
    return { ok: true, matches, truncated };
  }

  return {
    read, write, list, stat, mkdir, remove, move, copy, patch, glob, grep,
    // measurement surface (plan/anvil-indexed-search.md §6); changes no result
    searchStats, recordSearch,
    // exposed for the git adapter (C2) and grant layer (C4)
    _resolve: resolve,
    root: rootPrefix,
  };
}
