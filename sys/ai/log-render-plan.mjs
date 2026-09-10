// AC-5 — decide what a transcript render actually has to touch.
//
// MEASURED FIRST, per the capability's own condition ("measure changed-row updates and idle
// behaviour before replacing rendering — this is the item most likely to become a rewrite that
// buys nothing"). On a 600-row transcript, live in Anvil on 2026-09-10:
//
//   · the log box held 2,417 DOM nodes;
//   · ONE render — triggered by removing a single queue chip — took 48 ms, because renderLog does
//     `box.innerHTML=''` and rebuilds every node from scratch. 48 ms is three dropped frames, and
//     a run emits an event per turn;
//   · scrollTop went 506,771 → 1,013,331. A user reading back through a long run is yanked to the
//     bottom by every event.
//
// So the rewrite is justified, but only just — and only for the shape the data actually has.
// A TRANSCRIPT IS APPEND-DOMINANT. Rows are added at the end; earlier rows almost never change.
// A general keyed differ would be the wrong amount of machinery for that. This plans three cases:
//
//   noop     — nothing changed. Do not touch the DOM at all (the idle case).
//   append   — the previous rows are an exact prefix of the new ones. Build only the tail.
//   rebuild  — anything else (an edit, a removal, a reorder, a task switch). Full rebuild, which is
//              what the old code did unconditionally.
//
// Correctness over cleverness: the prefix test is exact-equality on row KEYS, and any mismatch
// anywhere falls back to `rebuild`. A wrong `append` would leave a stale row on screen forever,
// which is far worse than a slow render — so the failure direction is deliberately toward doing
// more work, never less.
//
// Pure: no DOM. The app supplies keys and performs the plan.

/**
 * A row's identity for render purposes: its kind plus everything that is DRAWN. Two rows with the
 * same key must be visually identical, or `append` would keep a stale one.
 *
 * `open` is included because it is rendered (a <details> is open or not) even though a user
 * toggling it does not change the text. `error` and `result` are included for the same reason.
 */
export function rowKey(e, i) {
  if (!e || typeof e !== 'object') return `${i}:?`;
  const k = String(e.k || '');
  const part = (v) => (v == null ? '' : String(v));
  switch (k) {
    case 'tool':
      return `${i}:tool:${part(e.name)}:${part(e.detail)}:${e.open ? 1 : 0}:${part(e.error)}:${part(e.result)}`;
    case 'diff':
      return `${i}:diff:${part(e.path)}:${part(e.status)}:${part(e.text)}`;
    default:
      return `${i}:${k}:${part(e.text)}`;
  }
}

export function rowKeys(log) {
  return (Array.isArray(log) ? log : []).map(rowKey);
}

/**
 * What must the renderer do to get from `prev` to `next`?
 * Returns { mode: 'noop' | 'append' | 'rebuild', from, reused, built }.
 * `from` is the index the renderer should start building at (0 for a rebuild).
 */
export function planLogUpdate(prev, next) {
  const a = Array.isArray(prev) ? prev : null;
  const b = Array.isArray(next) ? next : [];
  // No previous render (a fresh mount, or a task switch that cleared the cache).
  if (!a) return { mode: 'rebuild', from: 0, reused: 0, built: b.length };
  // The prefix walk covers truncation on its own: for i past the end of `b`, `b[i]` is undefined
  // and can never equal a real key, so a shortened log falls out here as a rebuild. An explicit
  // `b.length < a.length` guard ahead of this loop was written first and then removed — mutation
  // testing showed nothing could make it fail, because it was unreachable. An untestable branch in
  // the one function whose failure mode is a permanently stale row is worse than no branch.
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return { mode: 'rebuild', from: 0, reused: 0, built: b.length };
  }
  if (b.length === a.length) return { mode: 'noop', from: b.length, reused: a.length, built: 0 };
  return { mode: 'append', from: a.length, reused: a.length, built: b.length - a.length };
}

/**
 * Where should the scroll land after a render?
 *
 * The bug this replaces: renderLog ended with an unconditional `box.scrollTop = box.scrollHeight`,
 * so every event during a run threw the reader back to the bottom. The RARE path already got this
 * right — applyLayout (resize) has always done `pinned ? scrollHeight : top`. The hot path did not.
 *
 * `pinned` means the reader was already at the bottom and wants to follow along; anything else
 * means they scrolled up deliberately and their position is theirs to keep.
 */
export function planScroll({ scrollTop, scrollHeight, clientHeight, wasPinned = null, threshold = 40 }) {
  const pinned = wasPinned === null
    ? (scrollHeight - scrollTop - clientHeight) < threshold
    : wasPinned;
  return { pinned, scrollTop: pinned ? scrollHeight : scrollTop };
}

/** Was the reader pinned to the bottom before this render? Call BEFORE mutating the DOM. */
export function isPinned({ scrollTop, scrollHeight, clientHeight, threshold = 40 }) {
  return (scrollHeight - scrollTop - clientHeight) < threshold;
}
