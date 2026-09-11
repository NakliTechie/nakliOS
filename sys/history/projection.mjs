// projection — a fold driven once per event, instead of once per read.
//
// Anvil's folds (run-record.mjs) are free functions over the WHOLE event array:
// every read re-joins and re-walks the log. That is what makes a run replayable
// and it is not going away — but it costs O(n) per read, and the two hottest
// readers read constantly. The log pane refolds on every repaint; the transcript
// refolds on every model request, and again inside reconstructionCheck.
//
// A unit splits one of those folds into the three parts it already has inside it:
//
//   init()               the accumulator the fold starts from
//   apply(state, event)  one event's effect on it — the switch body, unchanged
//   value(state)         what the fold returns
//
// `runUnit` walks a whole array through those parts and IS the fold, so there is
// one implementation, not two that can drift. `createProjector` keeps the state
// between calls and applies only the tail.
//
// Two rules make that safe:
//
//   - The array handed in must EXTEND the one already consumed. The projector
//     checks that (the last consumed event, by identity, is still in place, and
//     the length has not shrunk) and rebuilds from scratch when it is not. A run
//     record's events are append-only and `loadRecord` hands out slices that keep
//     the same element objects, so the check passes on the real path and fails
//     safe on every other one. A wrong answer is not available to it; a slow one
//     is.
//   - `apply` returns the SAME state reference when the event does not concern
//     the unit, and a NEW one when it does. That is the zero-work signal, and it
//     is what `changed` reports — so a caller can skip a repaint without diffing
//     the result. The signal rides on the state OBJECT; the collections inside it
//     may be, and are, mutated in place.
//
// Deliberately absent: a plugin registry, a host/wire audience split and a schema
// layer. Anvil is one module with no wire and a closed set of folds, so all three
// would be indirection with no consumer.

const identity = (s) => s;

// Join one chain event with its payloads — the shape every unit's `apply` reads.
function join(e, resolve) {
  const r = resolve(e) || {};
  return { ...e, input: r.input, output: r.output };
}

/** Fold a whole event array through a unit. This is the fold. */
export function runUnit(unit, events, resolve) {
  let state = unit.init();
  for (const e of events) state = unit.apply(state, join(e, resolve));
  return (unit.value || identity)(state);
}

// C2+C3 (N5, 2026-09-12): a durable CHECKPOINT of a projector's folded state, so a reopened
// record does not refold from event zero. A checkpoint is a plain object —
//   { stateVersion, consumed, witness, state }
// — where `state` is the unit's own snapshot of its accumulator and `witness` names the last
// consumed event (ts, tool, hashes) so a restored checkpoint can be tied to the exact array it
// came from without object identity. Three rules keep it from ever answering wrong:
//   - a checkpoint whose stateVersion is not the unit's is DISCARDED, never forward-applied:
//     a unit whose accumulator shape changed bumps its version, and old state is garbage to it;
//   - a checkpoint is schema-validated on restore (the projector's envelope, then the unit's
//     `validate`), and one that fails is ignored — a rebuild is always available, a wrong
//     answer never is;
//   - every durable read and write is fail-soft: a store that throws leaves the projector
//     exactly as it was, and `advance` never depends on a checkpoint having landed.
// A unit opts in by providing `snapshot(state)` → JSON-able and `restore(snapshot)` → state;
// without them `checkpoint()` reports unsupported and `restore()` never installs anything.
export function eventWitness(e) {
  if (!e || typeof e !== 'object') return null;
  return [e.ts ?? null, e.tool ?? null, e.input_hash ?? null, e.output_hash ?? null, e.prev_hash ?? null].join('|');
}

function validCheckpoint(cp, unit) {
  if (!cp || typeof cp !== 'object') return 'not an object';
  if (cp.stateVersion !== (unit.version ?? 1)) return `stateVersion ${JSON.stringify(cp.stateVersion)} is not the unit's ${JSON.stringify(unit.version ?? 1)}`;
  if (!Number.isInteger(cp.consumed) || cp.consumed < 0) return 'consumed is not a non-negative integer';
  if (cp.consumed > 0 && typeof cp.witness !== 'string') return 'a non-empty checkpoint carries no witness';
  if (!('state' in cp)) return 'no state';
  if (typeof unit.validate === 'function') {
    let ok = false;
    try { ok = unit.validate(cp.state) === true; } catch (_) { ok = false; }
    if (!ok) return 'the unit rejected the state shape';
  }
  return null;
}

/**
 * A unit with its state kept between calls. `advance(events, resolve)` applies
 * only the events past the ones already consumed and returns
 * `{ value, changed, consumed }` — `changed` false means no applied event
 * touched this unit, so whatever was drawn from the last value still stands.
 */
export function createProjector(unit, { checkpoint = null } = {}) {
  const value = unit.value || identity;
  let state = unit.init();
  let consumed = 0;
  let last = null;          // events[consumed - 1], held for the extension check
  let witness = null;       // eventWitness(last) — what a restored checkpoint knows instead of `last`
  const canSnapshot = typeof unit.snapshot === 'function' && typeof unit.restore === 'function';

  const reset = () => { state = unit.init(); consumed = 0; last = null; witness = null; };

  // Is `events` the array we have already consumed, plus zero or more appends? By identity when
  // this projector consumed the events itself; by witness when the state came from a checkpoint.
  const extendsConsumed = (events) => {
    if (events.length < consumed) return false;
    if (consumed === 0) return true;
    if (last !== null) return Object.is(events[consumed - 1], last);
    return witness !== null && eventWitness(events[consumed - 1]) === witness;
  };

  return {
    version: unit.version ?? 1,
    get consumed() { return consumed; },
    reset,
    // Install a checkpoint from the store. Never throws; never touches the state unless the
    // checkpoint passed every check. Call before the first advance on a reopened record.
    async restore() {
      if (!checkpoint || typeof checkpoint.load !== 'function') return { restored: false, reason: 'no store' };
      if (!canSnapshot) return { restored: false, reason: 'the unit has no snapshot/restore' };
      let cp;
      try { cp = await checkpoint.load(); } catch (e) { return { restored: false, reason: 'load failed: ' + String(e?.message || e) }; }
      if (cp == null) return { restored: false, reason: 'no checkpoint' };
      const why = validCheckpoint(cp, unit);
      if (why) return { restored: false, reason: why };
      let next;
      try { next = unit.restore(cp.state); } catch (e) { return { restored: false, reason: 'restore failed: ' + String(e?.message || e) }; }
      state = next; consumed = cp.consumed; last = null; witness = cp.consumed > 0 ? cp.witness : null;
      return { restored: true, consumed };
    },
    // Save the current state to the store. Never throws.
    async checkpoint() {
      if (!checkpoint || typeof checkpoint.save !== 'function') return { saved: false, reason: 'no store' };
      if (!canSnapshot) return { saved: false, reason: 'the unit has no snapshot/restore' };
      let cp;
      try { cp = { stateVersion: unit.version ?? 1, consumed, witness: consumed > 0 ? (last !== null ? eventWitness(last) : witness) : null, state: unit.snapshot(state) }; }
      catch (e) { return { saved: false, reason: 'snapshot failed: ' + String(e?.message || e) }; }
      try { await checkpoint.save(cp); } catch (e) { return { saved: false, reason: 'save failed: ' + String(e?.message || e) }; }
      return { saved: true, consumed };
    },
    advance(events, resolve) {
      let rebuilt = false;
      if (!extendsConsumed(events)) { reset(); rebuilt = true; }
      let changed = rebuilt;
      for (let i = consumed; i < events.length; i++) {
        const next = unit.apply(state, join(events[i], resolve));
        if (!Object.is(next, state)) { state = next; changed = true; }
        last = events[i]; // identity outranks a restored witness from here on
      }
      consumed = events.length;
      return { value: value(state), changed, consumed, rebuilt };
    },
  };
}
