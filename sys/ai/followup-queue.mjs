// AC-4 — the follow-up queue, as durable state instead of a list of strings.
//
// Anvil already queued: type while a run is in flight and the prompt waits its turn, draining
// automatically when the run ends. What it did not have was any way to reason about the queue
// after something went wrong. Four defects, all found by auditing the existing code rather than
// by a report:
//
//   1. DATA LOSS between dequeue and dispatch. The drain did
//      `const next = t.queued.shift(); save(); … runTask(t, next)`. The item left the queue and
//      was PERSISTED gone before the run existed. Close the tab in that window and the prompt is
//      in no queue, no log and no record — it is simply gone, silently.
//   2. Removal raced the drain. The ✕ button captured a render-time INDEX
//      (`splice(idx,1)`), so if the queue shifted between render and click the user deleted a
//      different item than the one they clicked.
//   3. A failing run cascaded. The drain guard was `!wasAborted`, so a run that ended in `error`
//      still fired the next follow-up — and the one after that — into a workspace whose state
//      nobody had looked at.
//   4. No delivery state at all, so after a crash "never ran" and "ran, and the record was lost"
//      were indistinguishable.
//
// This module is the reducer for all four. Pure: no DOM, no storage, no clock beyond an injected
// `now`. The app owns persistence and rendering; everything decidable lives here so it can be
// tested without a browser.
//
// THE STATE MACHINE. An entry is `pending` or `dispatching`. `dispatching` is a CLAIM, written and
// persisted BEFORE the run starts, and cleared only once the run has genuinely begun. That makes
// the crash window recoverable instead of lossy: on load, an entry still marked `dispatching`
// belongs to a run that no longer exists, so it is demoted to `pending` and SAID — the same shape
// as the stale-`running` reconciliation, and the same lesson (a silent recovery is a defect too).

export const QUEUE_STATES = Object.freeze(['pending', 'dispatching']);

let counter = 0;
function newId(now) {
  counter = (counter + 1) % 1e6;
  return `q${now.toString(36)}${counter.toString(36)}`;
}

/**
 * Accept whatever is on disk. Legacy queues are arrays of bare strings and MUST survive — a
 * migration that drops the user's pending work to tidy a shape is worse than the shape.
 * Anything unrecognisable is dropped and counted, never silently kept as a broken entry.
 */
export function migrateQueue(raw, { now = Date.now() } = {}) {
  const out = []; let migrated = 0, dropped = 0;
  for (const item of Array.isArray(raw) ? raw : []) {
    if (typeof item === 'string') {
      if (!item.trim()) { dropped++; continue; }
      out.push({ id: newId(now), text: item, state: 'pending', at: now });
      migrated++;
    } else if (item && typeof item === 'object' && typeof item.text === 'string' && item.text.trim()) {
      out.push({
        id: typeof item.id === 'string' && item.id ? item.id : newId(now),
        text: item.text,
        state: QUEUE_STATES.includes(item.state) ? item.state : 'pending',
        at: Number.isFinite(item.at) ? item.at : now,
      });
    } else dropped++;
  }
  return { queue: out, migrated, dropped };
}

/**
 * Startup reconciliation. An entry left `dispatching` was claimed by a run that no longer exists —
 * the tab closed, or the app crashed, between the claim and the run starting. Demote it to
 * `pending` so it is not lost, and RETURN what was recovered so the caller can say so out loud.
 */
export function reconcileQueue(queue, { now = Date.now() } = {}) {
  const recovered = [];
  const next = (queue || []).map((e) => {
    if (e.state !== 'dispatching') return e;
    recovered.push(e.text);
    return { ...e, state: 'pending', at: e.at ?? now };
  });
  return { queue: next, recovered };
}

export function enqueue(queue, text, { now = Date.now() } = {}) {
  const t = String(text ?? '');
  if (!t.trim()) return { queue: queue || [], entry: null };
  const entry = { id: newId(now), text: t, state: 'pending', at: now };
  return { queue: [...(queue || []), entry], entry };
}

/** Remove by ID. Never by index — see defect 2. Unknown ids are a no-op, not an error. */
export function removeEntry(queue, id) {
  const next = (queue || []).filter((e) => e.id !== id);
  return { queue: next, removed: next.length !== (queue || []).length };
}

/** Reorder by ID, clamped. Returns the queue unchanged when the id is unknown. */
export function moveEntry(queue, id, delta) {
  const q = [...(queue || [])];
  const i = q.findIndex((e) => e.id === id);
  if (i < 0 || !delta) return { queue: q, moved: false };
  const j = Math.max(0, Math.min(q.length - 1, i + delta));
  if (i === j) return { queue: q, moved: false };
  const [e] = q.splice(i, 1); q.splice(j, 0, e);
  return { queue: q, moved: true };
}

/** Edit an entry's text in place, keeping its id and position. Empty text is a removal. */
export function editEntry(queue, id, text) {
  const t = String(text ?? '');
  if (!t.trim()) return removeEntry(queue, id);
  let changed = false;
  const next = (queue || []).map((e) => (e.id === id ? (changed = true, { ...e, text: t }) : e));
  return { queue: next, removed: false, changed };
}

/**
 * Should the queue drain now, and with what?
 *
 * `paused` is the whole point of defect 3: a run that was STOPPED by the owner, or that ENDED IN
 * ERROR, or whose recovery is ambiguous, must not hand the next prompt to a workspace nobody has
 * looked at. The queue holds and says why; the owner continues it explicitly.
 *
 * `outcome` is what the finished run reported: { aborted, error, stop }.
 */
export function nextDispatch(queue, outcome = {}, { now = Date.now() } = {}) {
  const q = queue || [];
  const head = q.find((e) => e.state === 'pending');
  if (!head) return { queue: q, entry: null, paused: false, reason: '' };

  if (outcome.aborted) return { queue: q, entry: null, paused: true, reason: 'you stopped the run — the queue is holding' };
  if (outcome.error) return { queue: q, entry: null, paused: true, reason: `the run ended in an error (${String(outcome.error).slice(0, 80)}) — the queue is holding` };
  // An ambiguous end is anything that is not a clean finish. `unverified`, `budget`, `max-steps`
  // and `no-progress` all leave the workspace in a state the next prompt would build on blind.
  if (outcome.stop && outcome.stop !== 'done') return { queue: q, entry: null, paused: true, reason: `the run ended '${outcome.stop}' — the queue is holding` };

  // Claim it: mark dispatching and hand the caller the entry to persist BEFORE running.
  return {
    queue: q.map((e) => (e.id === head.id ? { ...e, state: 'dispatching', at: e.at ?? now } : e)),
    entry: { ...head, state: 'dispatching' },
    paused: false,
    reason: '',
  };
}

/** The run genuinely started: the claim is honoured and the entry leaves the queue. */
export function completeDispatch(queue, id) {
  return removeEntry(queue, id).queue;
}

/** The run never started (a throw between claim and start): release the claim, keep the work. */
export function releaseDispatch(queue, id) {
  return (queue || []).map((e) => (e.id === id ? { ...e, state: 'pending' } : e));
}

/**
 * AC-8a — may a NEW run start at all?
 *
 * `nextDispatch` above already holds QUEUED work after a bad ending, which is admission control
 * rather than a fuse: the fuses (budget, max-steps, no-progress) all stop a run already going, and
 * none of them decides a run is not worth starting. But the hold covered only the queue — press
 * Send after three failed runs and the fourth started regardless, into a workspace nobody had
 * looked at. The gap was that the same question had two answers depending on where the prompt
 * came from.
 *
 * Two ways to refuse, and neither kills anything in flight — that is the whole distinction a quota
 * draws against a fuse (`hermes pause`: "halts NEW work only … in-flight work is never killed"):
 *   · `held` — the owner switched holding on. Explicit, visible, and cleared by them.
 *   · the last run ended badly and nothing has been acknowledged since.
 *
 * The SECOND is deliberately weak: it holds exactly once, and sending again goes through. It is a
 * speed bump that makes you look at the workspace, not a lockout — a quota you cannot override by
 * repeating yourself is a quota that gets switched off.
 */
export function admitRun({ held = false, heldReason = '', lastStop = null, lastWasError = false, acknowledged = false } = {}) {
  if (held) {
    return { admit: false, reason: heldReason ? `New runs are on hold: ${heldReason}` : 'New runs are on hold.', kind: 'held' };
  }
  if (acknowledged) return { admit: true, reason: '', kind: '' };
  if (lastWasError) {
    return { admit: false, kind: 'after-error',
      reason: 'The last run ended in an error and nothing has been checked since. Send again to run anyway.' };
  }
  // B3: a run that paused to ask is not a bad ending — the next Send IS the answer.
  if (lastStop === 'clarify') return { admit: true, reason: '', kind: '' };
  if (lastStop && lastStop !== 'done') {
    return { admit: false, kind: 'after-' + lastStop,
      reason: `The last run ended '${lastStop}' — the workspace may be half-changed. Send again to run anyway.` };
  }
  return { admit: true, reason: '', kind: '' };
}

export function pendingCount(queue) {
  return (queue || []).filter((e) => e.state === 'pending').length;
}
