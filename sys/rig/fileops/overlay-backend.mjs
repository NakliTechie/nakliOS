// OverlayBackend — a copy-on-write worktree over any Rig storage backend. This
// is the isolation primitive behind parallel subagents (the "Polly" supervisor
// pattern): each subagent runs against its own overlay, so concurrent full-tool
// agents (including shell writes) can never corrupt each other or the real
// workspace. Reads fall through to the base; writes and deletes are captured in
// the overlay; nothing touches the base until an explicit commit.
//
// It implements the same 8-method backend contract as MemoryBackend (see
// memory-backend.mjs) so it drops in wherever createFileops({ backend }) is
// wired. safePath is a full store path string (no leading slash); directories
// are implicit (derived from key prefixes), same as the live object stores.
//
// Semantics:
//   read/exists/stat/list  → base view, with overlay writes shadowing and
//                            tombstones (deletes) hiding base entries.
//   write/mkdir            → overlay only; clears any tombstone for the path.
//   delete                 → overlay tombstone (exact key); base untouched.
//   changes()              → { written:[path…], deleted:[path…] } for merge/review.
//   commit(apply)          → replays writes+deletes onto the real store via a
//                            caller-supplied applier (so the app can capture
//                            pre-images / route through the audited agent face).
//
// A base directory that is emptied purely by overlay tombstones stops existing
// in the overlay view (matching object-store semantics), computed by a bounded
// descendant walk — the base is never mutated.

// #9 (Superset's `^{commit}` deref, 2026-09-17 — plan/9-snapshot-overlays-design.md): the overlay is
// SNAPSHOT-ROOTED by pinning. The base's state of a path is pinned at the child's FIRST touch —
// bytes on first read, stat on first stat/exists, the listing on first list, the pre-image on first
// write/delete — and never consulted again for that key, so nothing the child has looked at moves
// under it while a sibling merges or the owner edits. `moved()` is the fence at merge: the base NOW
// against every pin, exact (bytes), backend-independent, bounded by what the child touched.
const MAX_DESCENDANT_SCAN = 5000; // safety cap on the base emptiness walk
export const PIN_MAX_BYTES = 4 * 1024 * 1024;     // per file: above this the pin is a hash, and reads fall through live
export const PIN_BUDGET_BYTES = 32 * 1024 * 1024; // per overlay: bytes held in pins; past it, new pins are hashes
const sha256 = async (bytes) => { const d = await globalThis.crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''); };

export class OverlayBackend {
  constructor(base, { pinMaxBytes = PIN_MAX_BYTES, pinBudgetBytes = PIN_BUDGET_BYTES } = {}) {
    if (!base) throw new Error('OverlayBackend requires a base backend');
    this.base = base;
    this.writes = new Map();   // safePath -> { bytes, mtimeMs }
    this.tomb = new Set();     // deleted exact keys (files or explicit dirs)
    this.dirsAdded = new Set(); // explicit dir markers created in the overlay
    // #9 pins — the base as this overlay first saw it. pins: safePath -> { stat } (absent, a dir, a
    // symlink: stat-only) | { stat, bytes } (held) | { stat, hash } (hashed: above the per-file cap or
    // past the budget — reads fall through live, the fence is still exact). lists: prefix -> listing.
    // A pin not in changes() was a read/stat (the child LOOKED).
    this.pins = new Map();
    this.pinning = new Map(); // safePath -> the in-flight first touch (parallel reads of one path pin once)
    this.lists = new Map();
    this.pinMaxBytes = pinMaxBytes;
    this.pinBudgetBytes = pinBudgetBytes;
    this.pinHeldBytes = 0;
  }

  _now() { return Date.now(); }

  // Pin the base's current state of safePath (once). A base error is NOT pinned — it propagates, as it
  // did before pins, so a transient host failure is not turned into a run-long absence.
  // `hold: false` (a write/delete pre-image the child will never read back) pins a hash, never bytes.
  async _pin(safePath, { hold = true } = {}) {
    if (this.pins.has(safePath)) return this.pins.get(safePath);
    if (this.pinning.has(safePath)) return this.pinning.get(safePath);
    const p = (async () => {
      const stat = await this.base.stat(safePath);
      let pin;
      if (!stat || stat.type !== 'file') pin = { stat: stat ? { ...stat } : null };
      else {
        const bytes = await this.base.readBinary(safePath);
        if (!hold || bytes.length > this.pinMaxBytes || this.pinHeldBytes + bytes.length > this.pinBudgetBytes) pin = { stat: { ...stat }, hash: await sha256(bytes) };
        else { pin = { stat: { ...stat }, bytes }; this.pinHeldBytes += bytes.length; }
      }
      this.pins.set(safePath, pin);
      return pin;
    })();
    this.pinning.set(safePath, p);
    try { return await p; } finally { this.pinning.delete(safePath); }
  }

  async _baseList(prefix) {
    if (this.lists.has(prefix)) return this.lists.get(prefix);
    let kids;
    try { kids = await this.base.list(prefix); } catch (_) { kids = []; }
    this.lists.set(prefix, kids);
    return kids;
  }

  async readBinary(safePath) {
    const w = this.writes.get(safePath);
    if (w) return w.bytes.slice();
    if (this.tomb.has(safePath)) throw new Error(`no such file: ${safePath}`);
    const pin = await this._pin(safePath);
    if (pin.bytes) return pin.bytes.slice();
    if (pin.hash || (pin.stat && pin.stat.type === 'symlink')) return this.base.readBinary(safePath); // not held: the live base (the fence still sees it)
    throw new Error(`no such file: ${safePath}`);
  }

  async write(safePath, data) {
    const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
    await this._pin(safePath, { hold: false }); // the base as it was before this child's first touch — the fence at merge compares against it
    this.writes.set(safePath, { bytes, mtimeMs: this._now() });
    this.tomb.delete(safePath);
  }

  async delete(safePath) {
    await this._pin(safePath, { hold: false });
    this.writes.delete(safePath);
    this.dirsAdded.delete(safePath);
    this.tomb.add(safePath);
  }

  async mkdir(safePath) {
    this.dirsAdded.add(safePath);
    this.tomb.delete(safePath);
  }

  async exists(safePath) {
    return (await this.stat(safePath)) !== null;
  }

  async stat(safePath) {
    const w = this.writes.get(safePath);
    if (w) return { type: 'file', size: w.bytes.length, mtimeMs: w.mtimeMs };
    if (this.dirsAdded.has(safePath)) return { type: 'dir', size: 0, mtimeMs: 0 };
    if (this.tomb.has(safePath)) {
      // Exact key deleted; it may still be an implicit dir if live descendants remain.
      return (await this._isImplicitDir(safePath)) ? { type: 'dir', size: 0, mtimeMs: 0 } : null;
    }
    // Not touched in the overlay: consult the base, but resolve directoriness
    // from the merged live key-space (base dirs emptied by tombstones vanish).
    const pin = await this._pin(safePath);
    const b = pin.hash ? await this.base.stat(safePath) : pin.stat; // a hashed pin is not snapshotted: its stat is live, like its bytes
    if (b && (b.type === 'file' || b.type === 'symlink')) return { ...b };
    if (await this._isImplicitDir(safePath)) return { type: 'dir', size: 0, mtimeMs: 0 };
    return null;
  }

  // Any LIVE descendant under safePath? Live = an overlay write/dir under it, or
  // a base descendant that is not tombstoned. Bounded so a huge tree can't hang.
  async _isImplicitDir(safePath) {
    if (safePath === '') return true; // the store root always exists
    const p = safePath + '/';
    for (const k of this.writes.keys()) if (k.startsWith(p)) return true;
    for (const k of this.dirsAdded) if (k === safePath || k.startsWith(p)) return true;
    // Walk the base subtree for a non-tombstoned descendant.
    let scanned = 0;
    const stack = [safePath];
    while (stack.length) {
      const dir = stack.pop();
      let kids;
      kids = await this._baseList(dir);
      for (const kid of kids) {
        if (++scanned > MAX_DESCENDANT_SCAN) return true; // assume live (keeps dir visible)
        const isDir = kid.endsWith('/');
        const full = isDir ? kid.slice(0, -1) : kid;
        if (isDir) { stack.push(full); continue; }
        if (!this.tomb.has(full)) return true; // a surviving base file → dir is live
      }
    }
    return false;
  }

  // Immediate children of prefix, dirs suffixed '/', base+overlay merged with
  // tombstones applied and overlay writes shadowing base. Mirrors MemoryBackend.list.
  async list(prefix) {
    const base = prefix === '' ? '' : prefix + '/';
    const children = new Map(); // childName -> isDir

    // Base children first (tomb-filtered; emptied dirs dropped).
    let baseKids;
    baseKids = await this._baseList(prefix);
    for (const kid of baseKids) {
      const isDir = kid.endsWith('/');
      const full = isDir ? kid.slice(0, -1) : kid;
      const rest = base ? full.slice(base.length) : full;
      if (rest === '' || rest.includes('/')) continue; // defensive: not an immediate child
      if (isDir) {
        if (await this._isImplicitDir(full)) children.set(rest, true);
      } else if (!this.tomb.has(full)) {
        if (!children.has(rest)) children.set(rest, false);
      }
    }

    // Overlay-added keys (writes + explicit dirs) contribute children too.
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
        children.set(rest.slice(0, slash), true); // deeper key ⇒ this level is a dir
      }
    };
    for (const k of this.writes.keys()) consider(k, false);
    for (const d of this.dirsAdded) consider(d, true);

    return [...children.entries()]
      .map(([name, isDir]) => base + name + (isDir ? '/' : ''))
      .sort();
  }

  // The changeset this overlay would apply to the base — for conflict detection,
  // review, and merge. Sorted for stable digests.
  changes() {
    return {
      written: [...this.writes.keys()].sort(),
      deleted: [...this.tomb].sort(),
    };
  }

  hasChanges() { return this.writes.size > 0 || this.tomb.size > 0; }

  // #9 — every path this overlay pinned (read, stat, or touched by a write/delete), for a caller that
  // knows what moved by other means (the batch path knows which paths its siblings just merged).
  pinned() { return [...this.pins.keys()].sort(); }

  // #9 — the fence at merge: the base NOW against every pin. `wrote`: written/deleted paths whose
  // base moved since this overlay first touched them (a merge would land on a workspace the child
  // never saw — hold it); `read`: paths the child looked at that moved but did not write (merge, and
  // say so). Exact: held bytes compare byte-for-byte, hashed pins re-hash — always a re-read, no
  // mtime shortcut (a same-size rewrite in the same millisecond is a real edit; Crate reports mtime 0
  // anyway). Cost: one read per pinned file at merge, bounded by what the child touched.
  // Listings are pinned for the child's view but not fenced here (a tree snapshot is not in scope).
  async moved() {
    const changed = new Set([...this.writes.keys(), ...this.tomb]);
    const wrote = [], read = [];
    for (const [path, pin] of this.pins) {
      let stat = null;
      try { stat = await this.base.stat(path); } catch (_) { stat = null; }
      const wasFile = !!(pin.stat && pin.stat.type !== 'dir');
      const isFile = !!(stat && stat.type !== 'dir');
      let moved;
      if (wasFile !== isFile) moved = true;
      else if (!isFile) moved = !!stat !== !!pin.stat; // absent both times or a dir both times: not moved; absent → dir (or back): moved — a file must not land over a directory
      else if (!pin.bytes && !pin.hash) moved = stat.type !== pin.stat.type || stat.size !== pin.stat.size || stat.mtimeMs !== pin.stat.mtimeMs; // stat-only (a symlink)
      else {
        let now = null;
        try { now = await this.base.readBinary(path); } catch (_) { now = null; }
        if (!now) moved = true;
        else if (pin.bytes) moved = now.length !== pin.bytes.length || now.some((b, i) => b !== pin.bytes[i]);
        else moved = (await sha256(now)) !== pin.hash;
      }
      if (!moved) continue;
      if (changed.has(path)) wrote.push(path); else read.push(path); // a pin outside changes() was a read/stat
    }
    wrote.sort(); read.sort();
    return { wrote, read };
  }

  // Replay this overlay onto the real store. `apply` is caller-supplied so the
  // app can capture pre-images and route writes through the audited agent face:
  //   apply.write(path, bytes) -> Promise   (bytes is a Uint8Array — pass through
  //                                          byte-exact; do NOT decode/re-encode)
  //   apply.remove(path)       -> Promise
  // Writes are applied before deletes, each in sorted order for determinism.
  // NOTE: explicit EMPTY directories (mkdir → dirsAdded) are not replayed — under
  // object-store implicit-dir semantics a dir exists only via its files, so an
  // empty dir has no durable representation to carry across. Files + deletes are.
  async commit(apply) {
    if (!apply || typeof apply.write !== 'function' || typeof apply.remove !== 'function') {
      throw new Error('commit(apply) needs { write, remove }');
    }
    const applied = { written: [], deleted: [] };
    for (const path of [...this.writes.keys()].sort()) {
      await apply.write(path, this.writes.get(path).bytes.slice());
      applied.written.push(path);
    }
    for (const path of [...this.tomb].sort()) {
      await apply.remove(path);
      applied.deleted.push(path);
    }
    return applied;
  }
}
