// Folder watching (L11): pick up added, changed and removed files without a
// manual rescan.
//
// Two triggers, no polling loop:
// - Window focus (or the page becoming visible) rescans when the last scan is
//   older than `intervalMs`. Coming back to the tab is when changes made in
//   another app become relevant.
// - `FileSystemObserver`, where the browser has it (Chrome 133 desktop,
//   experimental), rescans shortly after a change, with events debounced so a
//   folder copy is one rescan rather than hundreds.
//
// The rescan itself is the incremental scan (size and lastModified), so a
// rescan with nothing changed reads no tags.
//
// Everything that touches the browser is injectable, so the watcher runs
// under `node --test` with fake timers, a fake target and a fake observer.

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_DEBOUNCE_MS = 1500;

function defaultEnvironment() {
  const target = typeof window !== 'undefined' ? window : null;
  const doc = typeof document !== 'undefined' ? document : null;
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
    FileSystemObserver: globalThis.FileSystemObserver,
    onFocus(listener) {
      if (!target) return () => {};
      const visible = () => { if (!doc || doc.visibilityState === 'visible') listener(); };
      target.addEventListener('focus', listener);
      doc?.addEventListener('visibilitychange', visible);
      return () => {
        target.removeEventListener('focus', listener);
        doc?.removeEventListener('visibilitychange', visible);
      };
    },
  };
}

/**
 * Create a watcher for the granted folder `handle`.
 * `rescan()` returns a promise; the watcher never runs two at once, and a
 * trigger that arrives during a rescan queues exactly one more.
 *
 * Returns `{ start(), stop(), markScanned(at?), state() }`. Call
 * `markScanned()` after a scan the watcher did not start, so focus does not
 * rescan straight after it.
 */
export function createWatcher({
  handle,
  rescan,
  intervalMs = DEFAULT_INTERVAL_MS,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  environment = undefined,
  onError = () => {},
} = {}) {
  if (typeof rescan !== 'function') throw new TypeError('createWatcher needs a rescan function.');
  if (!(Number.isFinite(intervalMs) && intervalMs >= 0)) throw new TypeError('intervalMs is not a duration.');
  const env = { ...defaultEnvironment(), ...environment };

  let lastScanAt = env.now();
  let running = null;
  let queued = false;
  let started = false;
  let removeFocus = null;
  let observer = null;
  let debounce = null;

  const run = reason => {
    if (!started) return Promise.resolve();
    if (running) { queued = true; return running; }
    running = (async () => {
      // Start on the next microtask, so `running` is assigned before a
      // rescan that fails synchronously reaches the `finally` that clears it.
      await Promise.resolve();
      try {
        await rescan({ reason });
      } catch (error) {
        onError(error);
      } finally {
        lastScanAt = env.now();
        running = null;
      }
      if (queued && started) {
        queued = false;
        await run('queued');
      }
    })();
    return running;
  };

  const onFocus = () => {
    if (env.now() - lastScanAt >= intervalMs) run('focus');
  };

  const onObserved = () => {
    if (debounce !== null) env.clearTimeout(debounce);
    debounce = env.setTimeout(() => { debounce = null; run('observer'); }, debounceMs);
  };

  async function startObserver() {
    const Observer = env.FileSystemObserver;
    if (typeof Observer !== 'function' || !handle) return false;
    try {
      observer = new Observer(records => { if (records?.length !== 0) onObserved(); });
      await observer.observe(handle, { recursive: true });
      return true;
    } catch (error) {
      // An experimental API that refuses is not a failure: focus still works.
      observer = null;
      onError(error);
      return false;
    }
  }

  return {
    async start() {
      if (started) return this.state();
      started = true;
      removeFocus = env.onFocus(onFocus);
      await startObserver();
      return this.state();
    },
    stop() {
      started = false;
      queued = false;
      removeFocus?.();
      removeFocus = null;
      if (debounce !== null) env.clearTimeout(debounce);
      debounce = null;
      try { observer?.disconnect?.(); } catch { /* already gone */ }
      observer = null;
    },
    markScanned(at = env.now()) {
      lastScanAt = at;
    },
    /** Resolves when any rescan in flight (and one queued) has finished. */
    idle() {
      return running ?? Promise.resolve();
    },
    state() {
      return { started, observing: observer !== null, running: running !== null, lastScanAt, intervalMs };
    },
  };
}
