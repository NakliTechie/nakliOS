// The bed's python, opt-in. AUTOHARNESS_PYODIDE=<dir> names a directory where
//
//   npm i --prefix <dir> pyodide@0.27      (scratch, never a repo dependency)
//
// ran. Unset (CI, and every bed number before 2026-10-01), the bed has no python and the shell answers
// "the Kiln kernel is not available", as before. The variable is inherited, so a loop, its rounds and
// both scoring arms all run in the same bed; the summary of every split run names which one it was.
//
// What the agent gets is the app's NakliOS-embedded path: createMainThreadKiln
// (sys/kiln/main-thread-runtime.mjs) over the run's workspace, mount /work, handed to createShell with
// kilnIsolate. The loader is that runtime's default one (Pyodide, the sqlite3 package, then
// `import json, base64, math, sqlite3`), read from the local directory instead of the CDN.
//
// One interpreter per RUN, loaded on the run's first `python` as the app loads it on its first. Not
// one per process: the main-thread kiln points the interpreter's stdout at the caller and mirrors /work
// around an await, so two concurrent runs on one interpreter write into each other's output and
// workspace, and a reset at each hand-off would wipe a run's own /tmp between two of its calls.
// Measured 2026-10-01 (node 22.23, Pyodide 0.27.8, Apple M4 Pro): a fresh interpreter costs ~0.85 s of
// main-thread CPU and ~60 MB; 64 python runs at concurrency 4 held RSS under 710 MB, and under that
// contention a run's first call waited ~3 s for its load. A memory snapshot (load once, restore per run)
// fails on 0.27.8 once sqlite3 is loaded ("Unexpected hiwire entry"). loadBedPython() loads one
// interpreter at startup: it measures the load, caches the sqlite3 wheel in <dir>, and fails before any
// run spends tokens.
//
// Three things differ from the browser, each because node is not a browser:
//  - SystemExit and KeyboardInterrupt raised under runPythonAsync escape Pyodide's event loop. A browser
//    logs that; node exits (`sys.exit(3)` and `unittest.main()` each killed the process). The loop's
//    two handlers are no-ops here; the kiln still gets the rejection and maps it to the exit code.
//  - the `js` module holds timers only, not node's globalThis, whose process.env holds the bench's
//    keys. Not a security boundary (any JS object reaches Function), the same posture as js-runner.mjs.
//  - a python run still going after LIMIT_MS gets a KeyboardInterrupt, the worker kiln's default limit
//    (sys/kiln/kernel-core.mjs). On the main thread a `while True:` stops every concurrent run.
//    A single blocking call (time.sleep(600)) checks no signal and still blocks until it returns.
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMainThreadKiln } from '../../sys/kiln/main-thread-runtime.mjs';

export const PYODIDE_DIR = process.env.AUTOHARNESS_PYODIDE || null;
export const LIMIT_MS = 30000;

// After the loader: the browser's non-fatal escape, made non-fatal here too.
const NODE_HANDLERS = 'import asyncio\n_l = asyncio.get_event_loop()\n_l._system_exit_handler = lambda code: None\n_l._keyboard_interrupt_handler = lambda: None\ndel _l, asyncio';

const pkg = (dir) => join(dir, 'node_modules', 'pyodide');
const modules = new Map(); // dir → the imported pyodide.mjs (node caches it too; this keeps the URL in one place)
function pyodideModule(dir) {
  if (!existsSync(join(pkg(dir), 'pyodide.mjs'))) throw new Error(`AUTOHARNESS_PYODIDE=${dir}: no node_modules/pyodide/pyodide.mjs there (npm i --prefix ${dir} pyodide@0.27)`);
  if (!modules.has(dir)) modules.set(dir, import(pathToFileURL(join(pkg(dir), 'pyodide.mjs')).href));
  return modules.get(dir);
}

// One fresh interpreter, as main-thread-runtime.mjs's defaultLoadPyodide makes it.
async function loadInterpreter(dir, interruptBuffer) {
  const { loadPyodide } = await pyodideModule(dir);
  const py = await loadPyodide({ indexURL: pkg(dir) + '/', jsglobals: Object.freeze(Object.assign(Object.create(null), { setTimeout, clearTimeout })) });
  await py.loadPackage('sqlite3', { checkIntegrity: true, messageCallback: () => {} });
  py.runPython('import json, base64, math, sqlite3');
  py.runPython(NODE_HANDLERS);
  py.setInterruptBuffer(interruptBuffer);
  return py;
}

// The guard. A watchdog thread holds a timer per exec; the main thread may be blocked in Python, so
// the exec's state lives in shared memory: ARMED[slot] holds the exec's sequence number until it
// returns. Past the limit the watchdog writes SIGINT (2) into that run's interrupt buffer, and again
// each second while the exec is still armed, so an interrupt Python did not get to is not lost.
const ARMED = new Int32Array(new SharedArrayBuffer(4 * 64));
let watchdog = null, seq = 0;
function dog() {
  if (watchdog) return watchdog;
  watchdog = new Worker(`const { parentPort } = require('node:worker_threads');
let armed;
parentPort.on('message', (m) => {
  if (m.armed) { armed = new Int32Array(m.armed); return; }
  const ib = new Uint8Array(m.ib);
  const check = () => { if (Atomics.load(armed, m.slot) !== m.seq) return; Atomics.store(ib, 0, 2); setTimeout(check, 1000); };
  setTimeout(check, m.ms);
});`, { eval: true });
  watchdog.unref();
  watchdog.postMessage({ armed: ARMED.buffer });
  return watchdog;
}

// The kiln for one run's workspace `fs`, or null when the bed has no python. `stats` is what the run
// paid: interpreters loaded (the run's own, and the private SQLite one if it ran sqlite3), the load
// time, the python calls and their total wall time.
export function bedKiln(fs, { dir = PYODIDE_DIR, limitMs = LIMIT_MS } = {}) {
  if (!dir) return null;
  const interrupt = new Uint8Array(new SharedArrayBuffer(1));
  const stats = { loads: 0, loadMs: 0, calls: 0, execMs: 0 };
  const kiln = createMainThreadKiln({
    fs, mount: 'work',
    loadPyodide: async () => {
      const t0 = performance.now();
      const py = await loadInterpreter(dir, interrupt);
      stats.loads++; stats.loadMs += Math.round(performance.now() - t0);
      return py;
    },
  });
  return {
    ...kiln, stats,
    async exec(cellId, code, options) {
      const s = ++seq, slot = s % ARMED.length, t0 = performance.now();
      Atomics.store(ARMED, slot, s);
      dog().postMessage({ ib: interrupt.buffer, slot, seq: s, ms: limitMs });
      try { return await kiln.exec(cellId, code, options); }
      finally {
        Atomics.store(ARMED, slot, 0);
        Atomics.store(interrupt, 0, 0); // one Python never reached is not the next call's
        stats.calls++; stats.execMs += Math.round(performance.now() - t0);
      }
    },
  };
}

// Load one interpreter now: proves the directory, caches the sqlite3 wheel, and measures the load.
// `null` when the bed has no python.
let preflight = null;
export function loadBedPython(dir = PYODIDE_DIR) {
  if (!dir) return Promise.resolve(null);
  if (!preflight) {
    preflight = (async () => {
      const t0 = performance.now();
      const py = await loadInterpreter(dir, new Uint8Array(new SharedArrayBuffer(1)));
      return { dir, version: py.version, loadMs: Math.round(performance.now() - t0) };
    })();
  }
  return preflight;
}
