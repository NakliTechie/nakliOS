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
import { planQuery, evaluateQuery, evaluateQueryIds, trigrams, foldCase } from './trigram.mjs';

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
 * @param {boolean} [opts.index=false]   build a trigram index to skip non-candidate files
 * @param {number}  [opts.indexMaxBytes] per-file size ceiling for indexing (default 16 MiB).
 *                                     Above it a file holds no postings, so it stays a candidate
 *                                     and is re-read on every query — raise it rather than lower
 *                                     it if large text files are being searched often.
 * @param {boolean} [opts.exclusive]   nothing outside this fileops writes to the backend
 * @param {number}  [opts.reconcileMs] EXPERIMENT: re-stat at most this often rather than every
 *                                     search. 0 (default) keeps the per-query sweep.
 * @param {string}  [opts.indexPath]   persist the index here, through this same fileops, so it
 *                                     survives a reload. Omit to keep it in memory only.
 */
export function createFileops({ backend, root = '', symlinkDepth = 8, grepCap = 1000, onSearch = null, index = false, indexMaxBytes = 16 * 1024 * 1024, exclusive = false, reconcileMs = 0, indexPath = '' }) {
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

  // ── trigram index (plan/anvil-indexed-search.md §2) ───────────────────────
  // Opt-in. Decides which files to OPEN; never which lines match — the caller
  // always verifies with the real regex, so the index cannot invent a result.
  //
  // Staleness has two modes, because the honest answer differs by backend.
  //
  //   exclusive: false (default) — anything may write behind us, so every search
  //     re-stats every file. Correct against an external editor or a branch
  //     switch. Costs one round trip per file: measured on 300 OPFS files, the
  //     stat sweep IS the indexed grep (188 ms of 176 ms measured separately),
  //     capping the win at ~1.9x since `read` is 1.92x `stat`.
  //
  //   exclusive: true — this fileops is the only writer, so the mutators below
  //     invalidate exactly, and a search stats only files it has never seen.
  //     The walk still runs (3 ms per 300 files) so new and deleted files are
  //     found. This is the mode that actually pays: no per-file round trip at all
  //     for an unchanged workspace.
  //
  // The caller declares it, because the caller is where the knowledge lives: an
  // OPFS app workspace is exclusive, a user-picked disk folder is not. Guessing
  // it from the backend class cannot work — OPFS *is* FsaBackend underneath.
  // Two posting stores, which is tgrep's HybridIndex split and the reason the
  // typed array is affordable at all.
  //
  // `postings` is the BASE: triHash -> Uint32Array of sorted file ids. A V8 Set
  // costs ~34 B per entry whether it holds a string or a small integer — measured
  // 125 MiB either way on a 38 MiB corpus, against 43 MiB for the typed array. So
  // dropping the path strings buys nothing; only the typed array does.
  //
  // The price is that removing one id from a Uint32Array means rebuilding it, and
  // a write touches thousands of trigrams. So the base is NEVER mutated on a write.
  // Instead `overlay` — the old Set shape, small — holds every file (re)indexed
  // since the last fold, and a query unions the two.
  //
  // Why that is correct, which is the whole argument: a file is either in the
  // overlay (written since the fold, so the overlay holds its CURRENT trigrams) or
  // it is not (unchanged since the fold, so the base holds its current trigrams).
  // Every file is covered by exactly one of them, so no candidate is ever missed.
  // The base may still list a file whose content has since changed — that is an
  // EXTRA candidate, which costs a read and can never produce a wrong answer,
  // because the caller verifies every candidate with the real regex.
  const idx = {
    postings: new Map(),        // triHash -> Uint32Array of sorted file ids (base)
    overlay: new Map(),         // triHash -> Set<path>  (written since the fold)
    overlayFiles: new Set(),    // paths the overlay speaks for
    files: new Map(),           // path -> { mtimeMs, size, hashes: Uint32Array }
    paths: [],                  // file id -> path
  };

  // Fold the overlay into the base: reassign ids, rebuild every posting list as a
  // typed array, drop the Sets. O(total postings), so it must not run per write —
  // indexFoldDue() keeps it to the cold build and to bursts.
  function indexFold() {
    const byHash = new Map();
    idx.paths.length = 0;
    for (const [p, e] of idx.files) {
      const id = idx.paths.length;
      idx.paths.push(p);
      // Ascending by construction, because ids are handed out in this same loop.
      // evaluateQueryIds is a sorted merge and silently returns nonsense on
      // unsorted input, so this ordering is load-bearing, not incidental.
      for (const h of e.hashes) {
        let a = byHash.get(h);
        if (!a) { a = []; byHash.set(h, a); }
        a.push(id);
      }
    }
    idx.postings.clear();
    for (const [h, a] of byHash) idx.postings.set(h, Uint32Array.from(a));
    idx.overlay.clear();
    idx.overlayFiles.clear();
  }

  // Fold after the cold build (where every file lands in the overlay, so without
  // this the base would stay empty and nothing would be saved), and once a burst
  // of writes has made the overlay a material fraction of the workspace. A single
  // write must never trigger it.
  function indexFoldDue() {
    const n = idx.overlayFiles.size;
    if (!n) return false;
    return n >= Math.max(32, idx.files.size * 0.1);
  }

  // ── persistence ───────────────────────────────────────────────────────────
  // The index is written through this same fileops, so it lands wherever the
  // workspace lives — OPFS for a Browser project, the real folder for a picked
  // one. No new storage tier and no separate eviction story.
  //
  // It is DERIVED and never authoritative. On load, every entry is checked
  // against the filesystem's own mtime and size before it is trusted, and a file
  // that disagrees is simply re-read. So a stale or truncated index costs a read,
  // never a wrong answer — which is why it can be written without a fsync story.
  const INDEX_FORMAT = 1;
  const INDEX_SAVE_DEBOUNCE_MS = 5000;
  let indexDirty = false;
  let lastIndexSaveAt = 0;

  // Write at most once every few seconds, and only after something changed.
  // Fire-and-forget: a failed save costs a cold build next time, nothing more,
  // so a search must never wait on it or fail because of it.
  function indexSaveSoon(){
    if (!indexPath || !indexDirty) return;
    if (Date.now() - lastIndexSaveAt < INDEX_SAVE_DEBOUNCE_MS) return;
    lastIndexSaveAt = Date.now();
    indexDirty = false;
    Promise.resolve().then(() => indexSave()).catch(() => { indexDirty = true; });
  }

  async function indexSave(){
    if (!indexPath) return { ok: false, code: 'ENOPATH' };
    const files = [];
    for (const [path, e] of idx.files) {
      // `a` is indexedAt. Without it a loaded entry can never satisfy the
      // `settled` test below, so every file is re-read on the first search and
      // persistence buys nothing — measured at 6,028 ms against 57 ms warm on a
      // 38 MiB workspace.
      files.push({ p: path, m: e.mtimeMs, s: e.size, b: e.binary ? 1 : 0, a: e.indexedAt, h: [...e.hashes] });
    }
    const blob = JSON.stringify({ v: INDEX_FORMAT, savedAt: Date.now(), files });
    return write(indexPath, blob, { createParents: true });
  }

  async function indexLoad(){
    if (!indexPath) return { ok: false, code: 'ENOPATH' };
    const rd = await read(indexPath, { encoding: 'utf-8' });
    if (!rd.ok) return rd;
    let parsed;
    try { parsed = JSON.parse(rd.data); } catch (_) { return err('EBADINDEX', 'index is not readable JSON'); }
    if (!parsed || parsed.v !== INDEX_FORMAT || !Array.isArray(parsed.files)) {
      return err('EBADINDEX', 'index format is not this version');
    }
    idx.postings.clear();
    idx.overlay.clear();
    idx.overlayFiles.clear();
    idx.files.clear();
    let loaded = 0;
    for (const f of parsed.files) {
      if (!f || typeof f.p !== 'string' || !Array.isArray(f.h)) continue;
      const hashes = Uint32Array.from(new Set(f.h.filter((h) => Number.isInteger(h))));
      // Nothing loaded from disk is trusted until it has been checked against the
      // filesystem once: `validated: false` forces a stat on the first search even
      // in exclusive mode, which is where this guarantee used to be lost. The
      // exclusive shortcut skipped validation BEFORE anything inspected indexedAt,
      // so a saved index was trusted blindly and a file rewritten between save and
      // load was invisible — a silent false negative on an ordinary reload.
      //
      // indexedAt is the real timestamp from the indexing session, not 0. It is what
      // lets an unchanged file pass `settled` and skip its re-READ; the stat still
      // happens. An index written before this field existed has no `a`, falls back
      // to 0, and is simply re-read once — slower, never wrong.
      idx.files.set(f.p, { mtimeMs: f.m || 0, size: f.s || 0, indexedAt: f.a || 0, validated: false, safe: null, binary: f.b === 1, hashes });
      loaded++;
    }
    // Build the base from what was loaded, rather than routing it through the
    // overlay: a loaded index is by definition not "recently written".
    indexFold();
    return { ok: true, loaded };
  }

  const exclusiveOk = () => exclusive;

  // EXPERIMENT (plan/anvil-indexed-search.md, folder-mount question, option b).
  // A non-exclusive mount pays one stat per file per query, which is what makes a
  // picked folder ~1.2x instead of ~10x. reconcileMs sweeps on a timer instead:
  // between sweeps the index is trusted, exactly as tgrep trusts its watched tree
  // between hourly reconciles. The cost is a window in which an edit made OUTSIDE
  // this fileops is invisible. Zero — the default — keeps the per-query sweep and
  // therefore keeps the guarantee. The walk still runs every query either way, so
  // files added or deleted are always seen; only content changes are deferred.
  let lastSweepAt = 0;
  const sweepDue = () => !reconcileMs || (Date.now() - lastSweepAt >= reconcileMs);

  // Every invalidation bumps a sequence for its path. A read that began before an
  // invalidation must not be allowed to install its result afterwards: the bytes
  // it holds are older than the write that just landed, and in exclusive mode —
  // which never re-stats a file it believes it knows — that stale entry would
  // never be revisited.
  // The directory walk runs on every search: measured at 16.7 ms of a 29.7 ms
  // zero-candidate query — 56% of the floor, and the reason a small workspace
  // barely benefits. In exclusive mode it can be cached exactly, because file
  // CREATION and deletion also go through this fileops, so the same invalidation
  // that drops an index entry can drop the walk. Never cached otherwise.
  // `walkSeq` versions the cache the way dropSeq versions a file's bytes. A walk
  // that STARTED before an invalidation must not install its snapshot after it:
  // the snapshot predates the write, so a file that write created is missing from
  // it, and nothing re-walks until the next invalidation — one interleaving hides
  // that file from every later query for the rest of the session. fileops supplies
  // the interleaving itself: grep ends in indexSaveSoon(), whose indexSave() is
  // fire-and-forget and writes through write(), which invalidates.
  let walkCache = null;
  let walkSeq = 0;
  const invalidateWalk = () => { walkCache = null; walkSeq++; };

  let dropSeq = 0;
  const dropSeqByPath = new Map();
  const dropSeqBySafe = new Map();
  function seqOf(path) { return dropSeqByPath.get(path) || 0; }
  // The same sequence, keyed by the resolved path. Two mount paths can name one
  // backend file through a symlink, and the per-mount-path sequence only guards
  // the spelling the write actually used.
  function seqOfSafe(safe) { return safe ? (dropSeqBySafe.get(safe) || 0) : 0; }

  function indexDrop(path) {
    invalidateWalk();
    dropSeqByPath.set(path, ++dropSeq);
    const e = idx.files.get(path);
    if (!e) return;
    // Only the overlay is edited. The base keeps this file's id under its old
    // trigrams until the next fold, which costs an extra candidate and a read —
    // never a wrong answer, because the caller re-runs the real regex. Rebuilding
    // a Uint32Array per trigram per write is what this trade exists to avoid.
    if (idx.overlayFiles.has(path)) {
      for (const h of e.hashes) {
        const s = idx.overlay.get(h);
        if (s) { s.delete(path); if (!s.size) idx.overlay.delete(h); }
      }
      idx.overlayFiles.delete(path);
    }
    idx.files.delete(path);
  }

  // Drop a path and everything beneath it (a recursive remove takes a subtree).
  function indexDropSubtree(path) {
    // Removing the mount root ('') must drop EVERYTHING. The prefix form gave
    // '/', which matches no key (keys are mount-relative, unrooted), so a
    // recursive remove of the root left every posting in place — and a path
    // later recreated at the same name was then served from stale postings.
    invalidateWalk();
    if (path === '') {
      idx.postings.clear(); idx.overlay.clear(); idx.overlayFiles.clear();
      idx.files.clear(); idx.paths.length = 0;
      return;
    }
    indexDrop(path);
    const prefix = path + '/';
    for (const p of [...idx.files.keys()]) if (p.startsWith(prefix)) indexDrop(p);
  }

  // Drop every mount path that resolves to the same backend file. Two paths can
  // alias one file through a symlink, and the index is keyed by mount path, so
  // writing through one used to leave the other stale. Sniffing the backend for
  // symlink support missed wrappers (OverlayBackend has no `.symlinks` of its
  // own); resolving is what actually knows.
  // A short, readable shape for the meter — "AND(TRI,OR(TRI,TRI))" — so a slow
  // query can be explained without re-deriving the plan by hand.
  function describePlan(node) {
    if (!node || node.op === 'ALL') return 'ALL';
    if (node.op === 'TRI') return 'TRI';
    return `${node.op}(${node.subs.map(describePlan).join(',')})`;
  }

  function indexDropBySafe(safe) {
    if (!safe) return;
    // Bump BEFORE the sweep, and unconditionally. The sweep only reaches aliases
    // already installed in idx.files; an alias whose read is still in flight has no
    // entry to visit, so without this its stale bytes land after the write and that
    // alias path drops out of every later grep.
    dropSeqBySafe.set(safe, ++dropSeq);
    for (const [p, e] of [...idx.files]) if (e.safe === safe) indexDrop(p);
  }

  function indexAdd(path, text, st, safe, readStartedAt, seenSeq, seenSafeSeq, binary = false) {
    // Discard a read that raced a write to the same path, under EITHER name.
    if (seenSeq !== undefined && seqOf(path) !== seenSeq) return;
    if (seenSafeSeq !== undefined && safe && seqOfSafe(safe) !== seenSafeSeq) return;
    indexDrop(path);
    // Index the CASE-FOLDED text, folded per character (see foldCase — whole-string
    // lowercasing is not substring-preserving in Unicode and silently lost matches).
    // A folded index over-matches a case-sensitive query, which is free: the real
    // regex rejects the extra candidates. In exchange, `-i` can use the index at
    // all, where it used to scan everything.
    const hashSet = trigrams(foldCase(text));
    // Sorted, because indexFold hands out ids in idx.files order and evaluateQueryIds
    // merges on the assumption that every posting list ascends.
    const hashes = Uint32Array.from(hashSet).sort();
    for (const h of hashSet) {
      let s = idx.overlay.get(h);
      if (!s) { s = new Set(); idx.overlay.set(h, s); }
      s.add(path);
    }
    idx.overlayFiles.add(path);
    // `indexedAt` closes a coherency window mtime alone cannot: if a file is
    // rewritten in the SAME millisecond we indexed it, at the same size, its
    // mtime and size both compare equal and the sweep skips a changed file.
    // Storing when we read it lets us distrust exactly that overlap.
    // indexedAt is when the read STARTED, not when it finished: a write landing
    // mid-read would otherwise be stamped as already-captured and stay invisible.
    idx.files.set(path, { mtimeMs: st.mtimeMs, size: st.size, indexedAt: readStartedAt, validated: true, safe, binary, hashes });
    indexDirty = true;
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
    // Invalidate in a finally: a backend that writes and THEN throws (or commits
    // and reports failure) still changed the bytes, and an invalidation only on
    // the success path left the index holding content that no longer exists.
    try {
      await backend.write(r.safe, bytes);
    } finally {
      indexDrop(r.path);
      indexDropBySafe(r.safe);
    }
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
      try {
        for (const f of files) { const e = await deleteFile(f); if (e) return e; }
        // deepest-first so a backend that tracks explicit dir markers stays consistent
        for (const d of dirs.sort((a, b) => b.split('/').length - a.split('/').length)) await deleteDir(d);
        await deleteDir(r.safe);
      } finally {
        // Even a removal that stopped partway deleted something.
        indexDropSubtree(r.path);
      }
      return { ok: true, path: r.path };
    }
    const e = await deleteFile(r.safe);
    indexDrop(r.path);
    indexDropBySafe(r.safe);
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
      try {
        for (const f of files) {
          const rel = f.startsWith(fromBase) ? f.slice(fromBase.length) : f;
          const bytes = await backend.readBinary(f);
          await backend.write(joinRoot(tr.safe, rel), bytes);
        }
      } finally {
        // An interrupted copy still wrote whatever it got through.
        indexDropSubtree(tr.path);
      }
      return { ok: true, from: fr.path, to: tr.path };
    }
    const bytes = await backend.readBinary(fr.safe);
    try {
      await backend.write(tr.safe, bytes);
    } finally {
      indexDrop(tr.path);
      indexDropBySafe(tr.safe);
    }
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
    try {
      await backend.write(r.safe, enc.encode(applied.result));
    } finally {
      indexDrop(r.path);
      indexDropBySafe(r.safe);
    }
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

  // Whether a search with these options WOULD have listed `path` — the same scope
  // test and the same regex `glob` applies, run backwards against a path it already
  // produced. The index's eviction sweep needs it: "absent from this glob's matches"
  // is not "vanished from the filesystem", and reading it that way threw the rest of
  // the index away on every narrowed search, so alternating globs never warmed.
  async function globCovers(pattern, opts = {}) {
    const cr = await resolve(opts.cwd || '');
    if (!cr.ok) return () => false;
    const re = globToRegExp(pattern);
    const prefix = cr.path ? cr.path + '/' : '';
    return (path) => {
      if (prefix && !path.startsWith(prefix)) return false;
      return re.test(prefix ? path.slice(prefix.length) : path);
    };
  }

  async function grep(pattern, opts = {}) {
    const max = opts.maxResults || grepCap;
    const t0 = Date.now();
    let filesRead = 0;
    let bytesRead = 0;
    const cr = await resolve(opts.cwd || '');
    if (!cr.ok) return cr;
    // Reuse the previous walk when this fileops is the only writer and nothing has
    // been mutated since. Keyed by the glob and cwd actually asked for.
    const walkKey = `${opts.cwd || ''}\u0000${opts.glob || '**'}`;
    let globbed;
    if (index && exclusiveOk() && walkCache && walkCache.key === walkKey) {
      globbed = { ok: true, matches: walkCache.matches };
    } else {
      const walkedFrom = walkSeq;
      globbed = await glob(opts.glob || '**', { cwd: opts.cwd || '' });
      if (!globbed.ok) return globbed;
      // Only cache a snapshot that nothing invalidated while it was being taken.
      if (index && exclusiveOk() && walkSeq === walkedFrom) walkCache = { key: walkKey, matches: globbed.matches };
    }
    if (!globbed.ok) return globbed;
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    const matches = [];
    let truncated = false;
    // Candidate narrowing. `lit` is null whenever the pattern is anything the
    // extractor does not fully understand, and null means "scan everything" —
    // the same work as before the index existed.
    // planQuery returns ALL when it cannot constrain, which is the same fallback
    // the single-literal extractor used to reach far more often: an alternation,
    // a group, a class or a \w escape used to disqualify the whole pattern even
    // when a neighbouring literal was still required by every match.
    // `i` is no longer excluded: the index is case-folded, so an ignoreCase query
    // is answered from it directly and a case-sensitive one merely over-matches.
    const plan = index ? planQuery(re.source, re.flags) : null;
    const lit = plan && plan.op !== 'ALL' ? plan : null;
    let candidates = null;
    let indexUsed = false;
    let filesStatted = 0;
    let sweeping = false;
    if (lit) {
      // Refresh the index against the filesystem: new and changed files are
      // re-read, vanished ones dropped. One stat per file, which `read` was
      // paying anyway.
      sweeping = sweepDue();
      if (sweeping) lastSweepAt = Date.now();
      const seen = new Set();
      for (const p of globbed.matches) {
        if (indexPath && p === indexPath) continue;   // the index does not index itself
        seen.add(p);
        const e = idx.files.get(p);
        // Exclusive mode: a file we already hold is current by construction —
        // every write through this fileops dropped it from the index. Timed mode:
        // trusted until the next sweep falls due.
        // `e.validated` is the load guard: an entry read from disk has never been
        // checked against this session's filesystem, so it does not get the
        // exclusive shortcut until it has been.
        if (e && e.validated && (exclusiveOk() || !sweeping)) continue;
        // Resolve and stat as two steps rather than through `stat`, which discards
        // the resolved path. `safe` is what alias invalidation matches on, and an
        // entry validated without a re-read has no other way to learn it.
        const rr = await resolve(p);
        if (!rr.ok) { indexDrop(p); continue; }
        const raw = await backend.stat(rr.safe);
        if (!raw) { indexDrop(p); continue; }
        const st = { stat: { type: raw.type, size: raw.size ?? 0, mtimeMs: raw.mtimeMs ?? 0 } };
        filesStatted++;
        // Trust an unchanged mtime+size only when the file was already at least a
        // millisecond old when we indexed it. Inside that window the pair cannot
        // distinguish "unchanged" from "rewritten at the same size".
        // mtime 0 means the backend does not report one (the Crate fallback), which
        // is the absence of evidence, not evidence of freshness. Without it, size
        // alone decides, and a same-size rewrite is invisible — so never settle.
        const settled = e && st.stat.mtimeMs > 0 && e.indexedAt > st.stat.mtimeMs;
        // Unchanged since it was indexed — including in a previous session, which
        // is the case this validates. Mark it so later searches take the shortcut;
        // the file is NOT re-read.
        if (e && settled && e.mtimeMs === st.stat.mtimeMs && e.size === st.stat.size) {
          // Checked against the file, and it learns its resolved path without a read.
          e.validated = true;
          e.safe = rr.safe;
          continue;
        }
        if (st.stat.size > indexMaxBytes) { indexDrop(p); continue; } // stays a full-read candidate
        const readStartedAt = Date.now();
        const seenSeq = seqOf(p);
        const seenSafeSeq = seqOfSafe(rr.safe);
        const rd = await read(p, { encoding: 'utf-8' });
        if (!rd.ok) { indexDrop(p); continue; }
        filesRead++;
        bytesRead += rd.data.length;
        // Binaries are never searched, but REMEMBER that: dropping them meant the
        // refresh re-read every binary on every search just to rediscover what it
        // already knew. On one real folder that was 4.29 MB per query — exactly
        // cancelling the bytes the index saved.
        const isBinary = rd.data.includes('\u0000');
        indexAdd(p, isBinary ? '' : rd.data, st.stat, rr.safe, readStartedAt, seenSeq, seenSafeSeq, isBinary);
      }
      // Snapshot the keys: indexDrop mutates idx.files, so iterating it live
      // would skip entries. (oxlint flags the spread as useless; it is not.)
      // Drop only what this glob COVERS: a path outside it was never looked for,
      // so its absence from `seen` says nothing about whether it still exists.
      const covers = await globCovers(opts.glob || '**', { cwd: opts.cwd || '' });
      for (const p of [...idx.files.keys()]) if (!seen.has(p) && covers(p)) indexDrop(p);

      // Everything the refresh just read went into the overlay. Fold it into the
      // base before evaluating, so the cold build does not leave the whole index
      // sitting in Sets — which is the shape this change exists to get rid of.
      if (indexFoldDue()) indexFold();

      // Evaluate the plan against BOTH stores and union the two. Same plan, same
      // semantics; only the storage differs. evaluateQueryIds is asserted against
      // evaluateQuery in trigram.test.mjs, which is why they can be mixed here.
      const baseIds = evaluateQueryIds(plan, idx.postings);
      const overlayHits = evaluateQuery(plan, idx.overlay);
      // null from either side means "no constraint". Today's code read null as an
      // EMPTY candidate set, which would drop every result; treat it as the full
      // scan it is meant to be.
      let acc = null;
      if (baseIds !== null && overlayHits !== null) {
        acc = new Set();
        for (const p of overlayHits) if (idx.files.has(p)) acc.add(p);
        for (const id of baseIds) {
          const p = idx.paths[id];
          // A path the base still lists but that no longer exists, or that has been
          // rewritten into the overlay, is dropped here rather than at read time.
          if (p !== undefined && idx.files.has(p)) acc.add(p);
        }
      }
      // A file we hold no postings for must stay a candidate, because we cannot
      // know whether it matches — that is oversized files, which are never read
      // here. A file we know to be BINARY is not a candidate: binaries are not
      // searched at all, so there is nothing to verify.
      // Anything we hold no entry for must stay a candidate, because we cannot know
      // whether it matches — that is oversized files, which are never read here.
      // Binaries DO have an entry (with no postings), so they fall out of both the
      // intersection and this list without being re-read.
      const over = globbed.matches.filter((p) => !idx.files.has(p) && !(indexPath && p === indexPath));
      // Sort by path: postings iterate in id order, and today's callers see glob's
      // sorted order. Candidate order must not change which results the maxResults
      // cap keeps.
      if (acc === null) {
        candidates = null;                       // unconstrained ⇒ scan, as before
      } else {
        // The index spans every glob ever searched, so postings can name files
        // outside this one. `over` is already glob-bounded; `acc` is not, and
        // was only ever bounded by the sweep that used to empty it.
        const inGlob = new Set(globbed.matches);
        candidates = [...new Set([...[...acc].filter((p) => inGlob.has(p)), ...over])].sort();
        indexUsed = true;
      }
    }

    outer: for (const p of (candidates || globbed.matches)) {
      const rd = await read(p, { encoding: 'utf-8' });
      if (!rd.ok) continue; // unreadable → skip silently
      // Binary detection by NUL byte, as grep, ripgrep and the shell's own rg do.
      // This comment used to claim binaries were skipped while nothing checked,
      // so fs.grep reported matches from inside binary files and disagreed with
      // the rg builtin over the same tree. Pre-dates the index; surfaced by it,
      // because fs.grep is now the path everything else is built on.
      if (rd.data.includes('\u0000')) continue;
      filesRead++;
      bytesRead += rd.data.length;
      const lines = rd.data.split('\n');
      for (let i = 0; i < lines.length; i++) {
        // A /g or /y regex carries lastIndex between calls, so `test` skips every
        // other match and the result depends on which lines were tested before.
        // That made grep order-dependent on its own, and made an indexed run —
        // which tests fewer files — disagree with an unindexed one. Reset per
        // line so each line is judged on its own, both paths alike.
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          if (matches.length >= max) { truncated = true; break outer; }
          matches.push({ path: p, line: i + 1, text: lines[i] });
        }
      }
    }
    indexSaveSoon();
    recordSearch({
      via: 'fs.grep',
      pattern: String(pattern),
      cwd: opts.cwd || '',
      glob: opts.glob || '**',
      indexUsed,
      swept: lit ? sweeping : null,
      plan: lit ? describePlan(plan) : null,
      filesStatted,
      candidates: candidates ? candidates.length : null,
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
    // index persistence — derived, never authoritative (see indexLoad)
    indexSave, indexLoad,
    // exposed for the git adapter (C2) and grant layer (C4)
    _resolve: resolve,
    root: rootPrefix,
  };
}
