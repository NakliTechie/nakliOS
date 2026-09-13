// CRIB-B B2 (Paseo 3.1, 2026-09-13): a steer queue — what arrives WHILE the parent's turn runs
// (a child's completion, first of all) and lands at the top of its next turn as a loop-authored
// user message, never spliced between an assistant tool_call and its result. A promise queue, so
// two children finishing together cannot interleave. `track` counts what is still in flight so the
// loop can tell "waiting" from "done"; `next` wakes a waiting loop on a push, on the last tracked
// promise settling (nothing more will come), on abort, or on a timeout (the wall-clock budget).
// One waiter at a time: the loop is the only one.
export function createSteerQueue() {
  const pending = [];
  let inFlight = 0;
  let wake = null;
  const poke = () => { if (wake) { const w = wake; wake = null; w(); } };
  return {
    push(msg) { pending.push(msg); poke(); },
    take() { return pending.splice(0); },
    size() { return pending.length; },
    inFlight() { return inFlight; },
    track(p) {
      inFlight++;
      const settle = () => { inFlight--; if (inFlight === 0) poke(); }; // a settle delivers nothing by itself; the LAST one means nothing more will come
      Promise.resolve(p).then(settle, settle);
      return p;
    },
    next({ signal = null, timeoutMs = null } = {}) {
      if (pending.length || inFlight === 0 || (signal && signal.aborted)) return Promise.resolve();
      return new Promise((resolve) => {
        let timer = null;
        const done = () => {
          if (timer) clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', done);
          if (wake === done) wake = null;
          resolve();
        };
        wake = done;
        if (signal) signal.addEventListener('abort', done, { once: true });
        if (Number.isFinite(timeoutMs) && timeoutMs >= 0) timer = setTimeout(done, timeoutMs);
      });
    },
  };
}
