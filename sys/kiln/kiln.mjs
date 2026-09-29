// kiln — the K0 facade: the consent gate over the kernel core.
//
// Kiln does NOT load Pyodide until consent is granted (hard rule #11, never
// auto-download). `loadRuntime` is the injected async function that would fetch
// + initialise Pyodide (real one in the browser; a stub in tests). The gate is
// here so the "no fetch without consent" guarantee is enforced in one place and
// is headlessly testable with a fetch/load spy.
//
// Until ready, Kiln reports `unavailable` in one line and every other nakliOS
// surface is unaffected (§3).

import { createKernelCore } from './kernel-core.mjs';
import { waitForSqliteLoad } from './sqlite-load.mjs';

/**
 * @param {object}   opts
 * @param {function} opts.loadRuntime  async ({purpose}?) => distinct runtime
 * @param {function} opts.consent      () => boolean         (operator granted the download)
 * @param {number}   [opts.sizeBytes]  reported download size, for the consent prompt
 * @param {function} [opts.now]
 */
export function createKiln({ loadRuntime, consent, sizeBytes = null, now = () => Date.now() }) {
  if (typeof loadRuntime !== 'function') throw new Error('createKiln requires loadRuntime()');
  if (typeof consent !== 'function') throw new Error('createKiln requires consent()');

  const channel = (purpose) => ({ purpose, state: 'unloaded', core: null, runtime: null, loading: null });
  const python = channel('python'), sqlite = channel('sqlite'), runtimes = new WeakSet();
  let sqliteTail = Promise.resolve();

  function status({ purpose = 'python' } = {}) { return (purpose === 'sqlite' ? sqlite : python).state; }
  function downloadSize() { return sizeBytes; }

  // Load only with consent. Never touches the network otherwise.
  async function ensureChannel(target) {
    if (target.state === 'ready') return { ok: true };
    if (!consent()) return { ok: false, reason: 'consent-withheld', message: 'Kiln needs your consent to download Pyodide.' };
    if (target.loading) return target.loading;
    target.state = 'loading';
    target.loading = (async () => {
      try {
        const runtime = await (target === python ? loadRuntime() : loadRuntime({ purpose: 'sqlite' }));
        if (runtimes.has(runtime)) throw new Error('Kiln SQLite requires a distinct private interpreter');
        runtimes.add(runtime);
        target.runtime = runtime;
        target.core = createKernelCore({ runtime, now });
        target.state = 'ready';
        return { ok: true };
      } catch (e) {
        target.state = 'unavailable';
        target.loading = null;
        return { ok: false, reason: 'unavailable', message: String(e && e.message ? e.message : e) };
      }
    })();
    return target.loading;
  }
  const ensureReady = () => ensureChannel(python);

  // Every operation goes through the ready gate; typed miss when not ready.
  async function withCore(fn, target = python) {
    const r = await ensureChannel(target);
    if (!r.ok) return { status: 'unavailable', reason: r.reason, message: r.message };
    return fn(target.core);
  }

  return {
    status,
    downloadSize,
    ensureReady,
    exec(cellId, code, opts = {}) {
      if (opts.interpreter !== 'sqlite') return withCore((c) => c.exec(cellId, code, opts));
      // Only the trusted SQL bridge selects this channel. General Python never
      // shares its modules, builtins or globals. Queue SQL cells independently.
      const run = sqliteTail.then(async () => {
        const loaded = await waitForSqliteLoad(() => ensureChannel(sqlite), {
          signal: opts.signal, timeoutMs: opts.loadTimeoutMs,
        });
        if (!loaded.ok) return loaded.result;
        if (!loaded.value.ok) return { status: 'unavailable', reason: loaded.value.reason, message: loaded.value.message };
        return opts.signal?.aborted
          ? { status: 'interrupted', stdout: '', stderr: 'SQLite execution cancelled' }
          : sqlite.core.exec(cellId, code, opts);
      });
      sqliteTail = run.catch(() => {});
      return run;
    },
    interrupt(cellId) {
      const results = [python, sqlite].map((target) => target.core?.interrupt(cellId));
      return results.find((r) => r?.ok) || { ok: false, message: 'no matching running cell' };
    },
    reset: (opts) => (python.core ? python.core.reset(opts) : { ok: false, message: 'kernel not ready' }),
    inspect: (name) => withCore((c) => c.inspect(name)),
    listNames: () => withCore((c) => c.listNames()),
    cells: () => [python, sqlite].flatMap((target) => target.core?.cells() || []),
    close: () => Promise.all([python, sqlite].map((target) => target.runtime?.close?.())),
  };
}
