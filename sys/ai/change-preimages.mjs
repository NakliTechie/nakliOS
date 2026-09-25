// AC-6 — the pre-images behind Anvil's change chips: keep them bounded, say when they are
// missing, and never let Revert destroy work it cannot see.
//
// WHAT THE AUDIT ACTUALLY FOUND. The capability entry said "rebuilding diff chips after reload
// still needs pre-images". That premise is WRONG: `noteChange` stores the pre-image on the change
// row itself (`t.log.push({k:'change', file, verb, pre})`), and `t.log` persists to localStorage
// and roams to apps/anvil/state.json. Chips and their diffs already survive a reload. Three
// different things are broken, and one of them loses data:
//
//   1. REVERT BLINDLY CLOBBERS. `revertChange` did `fs.write(pv.file, pv.pre)` with no check that
//      the file still looks the way the agent left it. Edit that file yourself — or let a later
//      turn, a subagent merge, or a second tab touch it — and Revert silently destroys the newer
//      content. Same family as the follow-up queue's dequeue window: a narrow race with no
//      warning and no way back.
//   2. THE 20,000-CHAR CAP FAILS SILENTLY. Over it, `pre` becomes null and the chip renders
//      IDENTICALLY; clicking it shows the current file with no diff and no Revert, and the user is
//      never told the pre-image was dropped or why.
//   3. RETENTION IS UNBOUNDED. Every change row keeps a full copy of the file's previous contents
//      forever. Fifty edits to a 19 KB file is ~1 MB of task state, written to localStorage on
//      every save and roamed to state.json on every debounced flush.
//
// Pure: no fs, no DOM, no storage. The app supplies content and performs the decision.

/** Default ceiling for ONE pre-image. Matches the cap the app already applied, now named. */
export const MAX_PREIMAGE_CHARS = 20000;
/** Default ceiling for ALL retained pre-images on a task. This is the bound that did not exist. */
export const MAX_PREIMAGE_BUDGET = 256000;

/** FNV-1a with the length prefixed — same shape as the app's ctxDigest. Cheap, and collisions
 *  need the same length AND the same hash, which is enough for "did this file change under us". */
export function digest(s) {
  let h = 0x811c9dc5; const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return str.length + ':' + (h >>> 0).toString(36);
}

/**
 * Build the change row for one write/edit.
 *
 * `post` is what the file contains immediately AFTER the agent's write. Its digest is what makes
 * a safe Revert possible later: at revert time we can ask "does the file still look the way the
 * agent left it?" and refuse if it does not.
 *
 * When the pre-image cannot be kept, `preUnavailable` says WHY in words meant for a person. A chip
 * that silently loses its diff is defect 2.
 */
export function buildChangeRow({ file, verb, pre, post, maxChars = MAX_PREIMAGE_CHARS }) {
  const row = { k: 'change', file, verb, pre: null };
  if (post != null) row.postHash = digest(post);
  if (pre == null) {
    row.preUnavailable = 'the file could not be read before the change';
  } else if (String(pre).length > maxChars) {
    row.preUnavailable = `the previous version was ${String(pre).length.toLocaleString()} characters, over the ${maxChars.toLocaleString()} kept for diffs`;
  } else {
    row.pre = String(pre);
  }
  return row;
}

/**
 * May this change be reverted, and if not, why not?
 *
 * Three refusals, each with a reason a person can act on. `stale` is the data-loss one: the file
 * has changed since the agent wrote it, so writing the pre-image back would destroy whatever did
 * that. We refuse rather than guess, because we cannot tell the owner's edit from a later turn's.
 */
export function planRevert(row, currentContent) {
  if (!row || row.k !== 'change') return { ok: false, reason: 'not-a-change', message: 'This is not a change that can be reverted.' };
  if (row.pre == null) {
    return { ok: false, reason: 'no-preimage',
      message: `No previous version was kept for ${row.file}${row.preUnavailable ? ` — ${row.preUnavailable}` : ''}.` };
  }
  if (currentContent == null) {
    return { ok: false, reason: 'unreadable', message: `${row.file} could not be read, so reverting it is not safe.` };
  }
  // No postHash: an older row from before this shipped. Say so rather than pretending it is safe —
  // a silent best-effort revert is exactly the behaviour being removed.
  if (!row.postHash) {
    return { ok: false, reason: 'no-posthash',
      message: `${row.file} was changed before Anvil started recording what it wrote, so it cannot check whether anything has touched the file since. Open the file and edit it directly.` };
  }
  const now = digest(currentContent);
  // `already-reverted` is checked BEFORE `stale` on purpose. A file that already equals the
  // pre-image also differs from the postHash, so the stale branch would claim it first and say
  // "reverting would discard that" about content identical to what we would write. Safe to order
  // this first precisely because writing the pre-image here changes nothing.
  if (now === digest(row.pre)) {
    return { ok: false, reason: 'already-reverted', message: `${row.file} already matches the previous version.` };
  }
  if (now !== row.postHash) {
    return { ok: false, reason: 'stale',
      message: `${row.file} has changed since the agent wrote it — reverting now would discard that. Open the file and check before undoing.` };
  }
  return { ok: true, reason: '', message: '', content: row.pre };
}

/**
 * Bounded retention. Walks the log NEWEST FIRST and keeps pre-images until the budget runs out,
 * then drops the rest — the oldest change is the one you are least likely to undo. A dropped row
 * keeps its chip and its `postHash`; it loses only the ability to diff and revert, and it SAYS so.
 *
 * Returns a new log; the input is not mutated.
 */
export function prunePreimages(log, { budget = MAX_PREIMAGE_BUDGET } = {}) {
  const rows = Array.isArray(log) ? log : [];
  let used = 0, dropped = 0, freed = 0;
  const keep = new Array(rows.length).fill(true);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r || r.k !== 'change' || r.pre == null) continue;
    const size = String(r.pre).length;
    if (used + size <= budget) { used += size; continue; }
    keep[i] = false; dropped++; freed += size;
  }
  if (!dropped) return { log: rows, dropped: 0, freed: 0, retained: used };
  const next = rows.map((r, i) => (keep[i] ? r : { ...r, pre: null,
    preUnavailable: 'the previous version was dropped to keep this task\'s history from growing without bound' }));
  return { log: next, dropped, freed, retained: used };
}

/** Total characters currently held in pre-images on this log. */
export function preimageBytes(log) {
  return (Array.isArray(log) ? log : []).reduce((n, r) => n + (r && r.k === 'change' && r.pre != null ? String(r.pre).length : 0), 0);
}

// ── ZR-A2 (CRIB-E E3, 2026-09-24): turn-scoped change review ──────────────────────────────────
// A chip reviews ONE write. A run is reviewed as a unit: "this run changed these files" — each
// file's state before the run (the FIRST pre-image the run took of it) against what the run left
// (the LAST post digest), however many edits it took in between. Change rows carry `run` (the
// task's run sequence number) so a run's changes are separable from everything else in the log —
// the owner's edits and earlier runs' are not this run's, and are never attributed to it.

/** The files one run changed, collapsed per file. `state`: complete (every file has its pre-run
 *  version) · partial (some do) · unavailable (none do) · empty (the run changed nothing). */
export function turnChanges(log, run) {
  const byFile = new Map();
  for (const r of Array.isArray(log) ? log : []) {
    if (!r || r.k !== 'change' || r.run !== run) continue;
    const e = byFile.get(r.file);
    if (!e) byFile.set(r.file, { file: r.file, verb: r.verb, pre: r.pre ?? null, preUnavailable: r.preUnavailable || null, postHash: r.postHash || null, edits: 1 });
    else { e.postHash = r.postHash || null; e.edits++; if (r.verb === 'wrote') e.verb = 'wrote'; }
  }
  const files = [...byFile.values()];
  const kept = files.filter((f) => f.pre != null).length;
  const state = !files.length ? 'empty' : kept === files.length ? 'complete' : kept ? 'partial' : 'unavailable';
  return { run, files, state };
}

/** Revert a whole run, file by file, with planRevert's refusals intact: a file changed since the
 *  run left it is SKIPPED with its reason, never overwritten. `contents` maps file → current text
 *  (null when unreadable). Nothing here writes; the app applies `restore`. */
export function planTurnRevert(turn, contents = {}) {
  const plans = (turn && turn.files ? turn.files : []).map((f) => ({ file: f.file,
    ...planRevert({ k: 'change', file: f.file, pre: f.pre, postHash: f.postHash, preUnavailable: f.preUnavailable },
      Object.prototype.hasOwnProperty.call(contents, f.file) ? contents[f.file] : null) }));
  return { restore: plans.filter((p) => p.ok), skipped: plans.filter((p) => !p.ok) };
}
