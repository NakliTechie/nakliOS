// sys/kiln/main-thread-runtime.mjs
//
// A no-SharedArrayBuffer Python runtime for EMBEDDED (non-isolated) contexts —
// e.g. a Kiln app running as an iframe inside NakliOS, where the host is not
// cross-origin-isolated and the worker Kiln (worker-runtime.mjs) can't get
// SharedArrayBuffer.
//
// Design: run Pyodide on the MAIN THREAD (loadPyodide needs no SAB there), and
// instead of a live synchronous fs-bridge (which is what forces SAB), snapshot
// the Rig workspace into Pyodide's in-memory FS before each run and sync any
// new/changed files back after. `python file.py`, imports across workspace
// files, and file writes all work — without cross-origin isolation.
//
// Trade-offs vs the worker Kiln: execution blocks the UI thread (fine for the
// short scripts an agent runs; no interrupt), and each run re-snapshots the tree.
// When SharedArrayBuffer IS available (Forge/Anvil as a top-level isolated tab),
// prefer the worker Kiln instead — it's non-blocking and interruptible.
//
// It implements the minimal contract the Rig shell calls (shell.mjs `python`):
//   exec(cellId, code) -> { status:'ok'|'error'|'unavailable', stdout, stderr, message? }

import { PYODIDE_VERSION, PYODIDE_INDEX_URL, sanitizeTraceback, systemExitCode } from './pyodide-runtime.mjs';

async function defaultLoadPyodide() {
  const mod = await import(PYODIDE_INDEX_URL + 'pyodide.mjs');
  return mod.loadPyodide({ indexURL: PYODIDE_INDEX_URL });
}

// Paths the python MEMFS snapshot must not touch, in EITHER direction.
//  - __pycache__/.pyc: Pyodide-generated, never belong in the workspace.
//  - .git/: the git repo is the SHELL's domain (git runs over the workspace
//    fileops, not MEMFS). Its index + objects are BINARY; this snapshot reads and
//    writes every file as UTF-8, so round-tripping .git/ through MEMFS corrupts the
//    index (observed: `.git/index` truncated to 0 bytes after a python run, breaking
//    the shell's `git add`/`commit`). Excluding it in both directions keeps a
//    python run from ever mutating the repo the shell manages.
const SKIP_BACK = /(^|\/)(__pycache__|\.git)(\/|$)|\.pyc$/;

// Taken once, before any agent code can run, and restored before a gate runs. Kept as a
// module-level name inside the interpreter because there is nowhere better in a shared one —
// see the RESIDUAL note on `exec`.
const SNAPSHOT = `
import builtins as _kb, sys as _kbs
try: _KILN_B0
except NameError: _KILN_B0 = dict(vars(_kb))
try: _KILN_P0
except NameError: _KILN_P0 = list(_kbs.path)
`;

// Restore builtins, then drop every module loaded FROM THE WORKSPACE so the gate imports the
// agent's code off disk as it now stands. Stdlib and site-packages are left alone: reimporting
// them costs time and they are not what the agent can edit.
function isolationPreamble(root) {
  return `
import sys as _ks, builtins as _kb
try:
    # Bind the dict FIRST: clearing builtins removes the vars builtin itself, so calling it a
    # second time on the next statement raises NameError and the restore never ran.
    _kd = vars(_kb)
    _kd.clear()
    _kd.update(_KILN_B0)
    del _kd
except NameError:
    pass
_kroot = ${JSON.stringify(root)}
# sys.path is module state too: an insert in one run survived into the next and resolved
# import inv to a stale namespace package (live 2026-09-11). Back to the baseline, root first.
try:
    _ks.path[:] = list(_KILN_P0)
except NameError:
    pass
if _kroot not in _ks.path:
    _ks.path.insert(0, _kroot)
for _kn in [n for n, m in list(_ks.modules.items())
            if getattr(m, '__file__', None) and str(m.__file__).startswith(_kroot)]:
    del _ks.modules[_kn]
# Names are cleaned up defensively: on the FIRST isolated run nothing has been imported from the
# workspace yet, so the loop never binds _kn and a bare del of it raises NameError, which threw
# the whole preamble and failed every first gate at exit 1 before the criterion ever ran.
for _kname in ('_kn', '_kroot'):
    globals().pop(_kname, None)
del _kname
`;
}

export function createMainThreadKiln({ fs, mount = 'work', loadPyodide = defaultLoadPyodide } = {}) {
  if (!fs) throw new Error('createMainThreadKiln requires a Rig fileops instance (fs)');
  const root = '/' + String(mount).replace(/^\/+|\/+$/g, '');
  let py = null;
  let loading = null;

  async function ensure() {
    if (py) return py;
    if (!loading) {
      loading = (async () => {
        const p = await loadPyodide();
        try { p.runPython(SNAPSHOT); } catch (_) {}
        try { p.FS.mkdirTree(root); } catch (_) {}
        py = p;
        return p;
      })();
    }
    return loading;
  }

  const dirOf = (p) => { const i = p.lastIndexOf('/'); return i <= 0 ? '' : p.slice(0, i); };
  function mkdirp(rel) { if (!rel) return; try { py.FS.mkdirTree(root + '/' + rel); } catch (_) {} }

  // Copy every workspace file into MEMFS; remember contents to detect changes.
  async function syncIn() {
    const seen = new Map();
    const res = await fs.list('', { recursive: true });
    if (!res || !res.ok) return seen;
    for (const e of res.entries) {
      if (e.type !== 'file') continue;
      if (SKIP_BACK.test(e.path)) continue; // never pull .git/ or caches into MEMFS
      const rd = await fs.read(e.path, { encoding: 'utf-8' });
      if (!rd || !rd.ok) continue;
      const d = dirOf(e.path); if (d) mkdirp(d);
      try { py.FS.writeFile(root + '/' + e.path, rd.data); seen.set(e.path, rd.data); } catch (_) {}
    }
    return seen;
  }

  // Walk MEMFS; write new/changed files back to the workspace (skipping caches).
  async function syncOut(seen) {
    const out = [];
    (function walk(dir) {
      let ents; try { ents = py.FS.readdir(dir); } catch (_) { return; }
      for (const name of ents) {
        if (name === '.' || name === '..') continue;
        const full = dir + '/' + name;
        let st; try { st = py.FS.stat(full); } catch (_) { continue; }
        if (py.FS.isDir(st.mode)) walk(full);
        else out.push(full);
      }
    })(root);
    for (const full of out) {
      const rel = full.slice(root.length + 1);
      if (SKIP_BACK.test(rel)) continue;
      let data; try { data = py.FS.readFile(full, { encoding: 'utf8' }); } catch (_) { continue; }
      if (seen.get(rel) === data) continue; // unchanged since snapshot
      await fs.write(rel, data);
    }
  }

  return {
    status: () => (py ? 'ready' : 'idle'),
    downloadSize: () => PYODIDE_VERSION && (12 * 1024 * 1024),
    // `isolate` is for the VERIFIER GATE. The interpreter is memoized (one Pyodide for the
    // life of the app), so by default the agent's `python` and the gate's `python` are the
    // SAME interpreter: globals, `sys.modules` and `builtins` all carry over. Two consequences,
    // and the dull one is the more likely:
    //   - staleness: the agent imports `answer`, edits `answer.py`, and the gate's `import
    //     answer` gets the CACHED module — a gate passing on code that no longer exists.
    //   - poisoning: the agent pre-seeds `sys.modules['answer']` or rebinds a builtin, and the
    //     gate measures the agent's fixture instead of the agent's work.
    // Isolating drops every module whose file lives under the workspace, restores builtins from
    // a snapshot taken before any agent code ran, and runs in a fresh globals namespace.
    //
    // RESIDUAL, stated plainly: this raises the bar, it does not close the door. An agent with
    // arbitrary Python in the SAME interpreter can reach the snapshot itself. True isolation
    // needs a separate interpreter (reload Pyodide, or run the gate in the worker runtime);
    // that costs seconds per gate round and is a follow-on, not this change.
    async exec(cellId, code, { isolate = false } = {}) {
      let p;
      try { p = await ensure(); }
      catch (e) { return { status: 'unavailable', message: 'Pyodide failed to load: ' + (e && e.message ? e.message : e) }; }

      let out = '', err = '';
      try { p.setStdout({ batched: (s) => { out += s; } }); } catch (_) {}
      try { p.setStderr({ batched: (s) => { err += s; } }); } catch (_) {}

      let seen = new Map();
      try {
        seen = await syncIn();
        // Run from the workspace dir and make its modules importable.
        p.runPython(`import os, sys\nos.chdir(${JSON.stringify(root)})\nif ${JSON.stringify(root)} not in sys.path: sys.path.insert(0, ${JSON.stringify(root)})`);
        if (isolate) p.runPython(isolationPreamble(root));
        // A fresh globals namespace when isolating, so a name the agent left behind cannot
        // stand in for one the gate expects to import. Degrades to the shared namespace where
        // the runtime does not support the option rather than failing the gate outright.
        let freshGlobals = null;
        if (isolate) { try { freshGlobals = p.runPython('dict()'); } catch (_) { freshGlobals = null; } }
        await (freshGlobals ? p.runPythonAsync(code, { globals: freshGlobals }) : p.runPythonAsync(code));
        if (freshGlobals) { try { freshGlobals.destroy(); } catch (_) {} }
        await syncOut(seen);
        return { status: 'ok', stdout: out, stderr: err };
      } catch (e) {
        try { await syncOut(seen); } catch (_) {}
        const raw = String(e && e.message ? e.message : e);
        // `sys.exit(n)` is the program's exit code, not a failure — see systemExitCode.
        const sx = systemExitCode(raw);
        if (sx !== null) return { status: sx === 0 ? 'ok' : 'error', stdout: out, stderr: err, code: sx };
        const msg = sanitizeTraceback(raw);
        return { status: 'error', stdout: out, stderr: err + (err && !err.endsWith('\n') ? '\n' : '') + msg };
      } finally {
        try { p.setStdout(); } catch (_) {}
        try { p.setStderr(); } catch (_) {}
      }
    },
  };
}
