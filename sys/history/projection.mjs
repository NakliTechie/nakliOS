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
// Cribbed from deepseek-harness's session projections (plan/research-dsh-web-2026-09-08.md
// §2). Deliberately NOT cribbed: the plugin registry, the host/wire audience split
// and the schema layer. Anvil is one module with no wire and a closed set of folds,
// so all three would be indirection with no consumer.

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

/**
 * A unit with its state kept between calls. `advance(events, resolve)` applies
 * only the events past the ones already consumed and returns
 * `{ value, changed, consumed }` — `changed` false means no applied event
 * touched this unit, so whatever was drawn from the last value still stands.
 */
export function createProjector(unit) {
  const value = unit.value || identity;
  let state = unit.init();
  let consumed = 0;
  let last = null;          // events[consumed - 1], held for the extension check

  const reset = () => { state = unit.init(); consumed = 0; last = null; };

  // Is `events` the array we have already consumed, plus zero or more appends?
  const extendsConsumed = (events) => {
    if (events.length < consumed) return false;
    if (consumed === 0) return true;
    return Object.is(events[consumed - 1], last);
  };

  return {
    version: unit.version ?? 1,
    get consumed() { return consumed; },
    reset,
    advance(events, resolve) {
      let rebuilt = false;
      if (!extendsConsumed(events)) { reset(); rebuilt = true; }
      let changed = rebuilt;
      for (let i = consumed; i < events.length; i++) {
        const next = unit.apply(state, join(events[i], resolve));
        if (!Object.is(next, state)) { state = next; changed = true; }
        last = events[i];
      }
      consumed = events.length;
      return { value: value(state), changed, consumed, rebuilt };
    },
  };
}
