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
//   patch    — up to PATCH_MAX rows changed in place (U1): replace those nodes, append any tail.
//   rebuild  — anything else (a removal, a large reorder, a task switch). Full rebuild, which is
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
      return `${i}:tool:${part(e.name)}:${part(e.detail)}:${e.open ? 1 : 0}:${part(e.error)}:${part(e.result)}:${part(e.kind)}`;
    case 'diff':
      return `${i}:diff:${part(e.path)}:${part(e.status)}:${part(e.text)}`;
    // ESS-2: a child's live row changes in place as it runs — every field the line shows is in
    // the key, so a step or a new tool call is a visible change and never a stale row.
    // B1: `live` and `age` are the ticker's stamp — the typed state and the seconds since the child
    // was last seen — so a silent child's row repaints as it ages and flips to unverifiable.
    case 'subagent':
      return `${i}:subagent:${part(e.kind)}:${part(e.label)}:${part(e.status)}:${part(e.steps)}:${part(e.tools)}:${part(e.lastTool)}:${part(e.lastDetail)}:${part(e.lastError)}:${part(e.live)}:${part(e.age)}`;
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
  // A shortened log is a rebuild: a row that no longer exists has no node to replace it with.
  if (b.length < a.length) return { mode: 'rebuild', from: 0, reused: 0, built: b.length };
  // U1 (2026-09-24): rows that changed IN PLACE are patched, not rebuilt. Every 5 s the fleet ticker
  // re-stamps a child's row (`live`, `age` are in its key), and that one changed key used to force a
  // full rebuild of the whole transcript — ~48 ms at 600 rows, and it closed any <details> the user
  // had opened. Keys carry their index, so an insertion shifts every later key and shows up as many
  // changed rows; past PATCH_MAX the rebuild is the cheaper render. A patch is correct for ANY change
  // pattern of the same or greater length — the renderer rebuilds row i from row i — so the cap is a
  // cost bound, never a correctness one.
  const patched = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) patched.push(i);
  if (patched.length > PATCH_MAX) return { mode: 'rebuild', from: 0, reused: 0, built: b.length };
  if (patched.length) return { mode: 'patch', from: a.length, patched, reused: a.length - patched.length, built: patched.length + (b.length - a.length) };
  if (b.length === a.length) return { mode: 'noop', from: b.length, reused: a.length, built: 0 };
  return { mode: 'append', from: a.length, reused: a.length, built: b.length - a.length };
}
export const PATCH_MAX = 8;

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
