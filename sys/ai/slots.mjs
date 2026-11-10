// slots.mjs — at most `n` calls in flight; the rest wait their turn in arrival order.
//
// Why: the NakliOS host refuses an app's AI request while that app already has 3 pending
// (AI_MAX_QUEUE_PER_APP in index.html), and the refusal is not a retryable error. A 4-way
// subagent dispatch therefore lost its fourth child on its first call. Anvil now holds a slot
// per host call, so a fourth call waits here instead of failing there. The host serves one AI
// request at a time anyway, so waiting here costs no throughput.

// acquire(signal?) resolves to a release function. An aborted signal rejects a waiting acquire
// with Error('aborted') and gives up its place in the line.
export function createSlots(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error('createSlots needs a positive integer');
  let inFlight = 0;
  const line = []; // waiting entries: { grant, reject, signal, onAbort }
  function next() {
    while (inFlight < n && line.length) {
      const w = line.shift();
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
      inFlight++;
      w.grant(makeRelease());
    }
  }
  function makeRelease() {
    let released = false;
    return () => { if (released) return; released = true; inFlight--; next(); };
  }
  function acquire(signal = null) {
    if (signal && signal.aborted) return Promise.reject(new Error('aborted'));
    if (inFlight < n && !line.length) { inFlight++; return Promise.resolve(makeRelease()); }
    return new Promise((grant, reject) => {
      const w = { grant, reject, signal, onAbort: null };
      if (signal) {
        w.onAbort = () => { const i = line.indexOf(w); if (i >= 0) line.splice(i, 1); reject(new Error('aborted')); };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      line.push(w);
    });
  }
  return { acquire, get inFlight() { return inFlight; }, get waiting() { return line.length; } };
}
