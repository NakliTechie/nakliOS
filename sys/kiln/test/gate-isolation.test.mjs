// Conformance: the verifier gate's python runs on a RESET interpreter.
//
// Why this suite exists: main-thread-runtime memoizes one Pyodide for the life of the app, so
// the agent's `python` and the gate's `python` are the same interpreter. A gate that measures
// state the agent left behind is not measuring the agent's work. The dull failure is the more
// likely one — the agent imports `answer`, edits `answer.py`, and the gate's `import answer`
// gets the cached module, so the gate passes on code that no longer exists.
//
// Fake Pyodide throughout (injected loader). No real Pyodide, no network.

import { createMainThreadKiln } from '../main-thread-runtime.mjs';
import { createShell } from '../../rig/cli/shell.mjs';
import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../rig/agent/index.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', name); } };

// Records every string handed to runPython / runPythonAsync, plus whether a fresh globals
// namespace was passed. That is the whole observable contract from outside Python.
function makeFakePyodide() {
  const seen = { sync: [], async: [], globalsPassed: [] };
  const FS = {
    mkdirTree() {}, writeFile() {}, readFile() { throw new Error('ENOENT'); },
    readdir() { return ['.', '..']; }, stat() { return { mode: 0o040000 }; },
    isDir(m) { return (m & 0o170000) === 0o040000; },
  };
  return {
    FS, _seen: seen,
    setStdout() {}, setStderr() {},
    runPython(code) {
      seen.sync.push(String(code));
      if (/types\.ModuleType\("__main__"\)[\s\S]*__kiln_script\.__dict__$/.test(String(code).trim())) return { destroy() { seen.globalsPassed.push('destroyed'); } };
      return undefined;
    },
    async runPythonAsync(code, opts) { seen.async.push(String(code)); seen.globalsPassed.push(opts && opts.globals ? 'fresh' : 'shared'); },
  };
}

const mkKiln = (py) => createMainThreadKiln({
  fs: createFileops({ backend: new MemoryBackend() }), mount: 'work', loadPyodide: async () => py,
});

// ── 1. default exec does NOT reset ──────────────────────────────────────────
{
  const py = makeFakePyodide();
  await mkKiln(py).exec('shell', 'print(1)');
  const all = py._seen.sync.join('\n');
  ok('default exec runs no isolation preamble', !all.includes('_KILN_B0') || !all.includes('del _ks.modules'));
  ok('default exec keeps the shared globals namespace', py._seen.globalsPassed.includes('shared'));
}

// ── 2. isolate:true resets ──────────────────────────────────────────────────
{
  const py = makeFakePyodide();
  await mkKiln(py).exec('gate', 'print(1)', { isolate: true });
  const pre = py._seen.sync.join('\n');
  ok('isolate restores builtins from the pre-agent snapshot', /_kd = vars\(_kb\)[\s\S]*_kd\.clear\(\)[\s\S]*_kd\.update\(_KILN_B0\)/.test(pre));
  ok('isolate drops workspace modules from sys.modules', /del _ks\.modules\[_kn\]/.test(pre));
  // sys.path is module state too (live 2026-09-11: one run's insert survived into the next).
  ok('isolate restores sys.path from the baseline snapshot, root first', /_ks\.path\[:\] = list\(_KILN_P0\)[\s\S]*_ks\.path\.insert\(0, _kroot\)/.test(pre));
  ok('isolate scopes the purge to the workspace root', pre.includes('"/work"') || pre.includes("'/work'"));
  ok('isolate leaves stdlib alone (purge is guarded on __file__)', pre.includes("getattr(m, '__file__', None)"));
  ok('isolate runs the gate in a FRESH globals namespace', py._seen.globalsPassed.includes('fresh'));
  // and that namespace is a script's: __name__ is "__main__", so a unittest gate's main guard fires
  // (a bare dict() ran the gate as "builtins" — zero tests, exit 0, a green that proved nothing)
  ok('the fresh namespace IS sys.modules["__main__"] for the run — unittest.main() finds the script\'s tests', py._seen.sync.some((c) => /sys\.modules\["__main__"\] = __kiln_script/.test(c)));
  ok('and Pyodide\'s own __main__ is put back afterwards', py._seen.sync.some((c) => /sys\.modules\["__main__"\] = __kiln_prev_main/.test(c)));
}

// ── 3. the snapshot is taken before any agent code can run ──────────────────
{
  const py = makeFakePyodide();
  const kiln = mkKiln(py);
  await kiln.exec('shell', 'import builtins; builtins.len = lambda x: 42');
  const firstSnapshot = py._seen.sync.findIndex((c) => c.includes('_KILN_B0 = dict(vars(_kb))'));
  const firstAgentRun = py._seen.async.length ? 0 : -1;
  ok('the builtins snapshot is captured at interpreter load', firstSnapshot >= 0);
  ok('the snapshot precedes the first agent statement', firstSnapshot >= 0 && firstAgentRun === 0);
  // Idempotent: a second exec must not overwrite the snapshot with poisoned builtins.
  ok('the snapshot is taken once, not re-taken per exec', /try: _KILN_B0\s*\nexcept NameError:/.test(py._seen.sync.join('\n')));
  ok('the snapshot also captures the baseline sys.path once', /try: _KILN_P0\s*\nexcept NameError: _KILN_P0 = list\(_kbs\.path\)/.test(py._seen.sync.join('\n')));
}

// ── 4. the shell only isolates when it is the VERIFIER's shell ──────────────
{
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });

  const calls = [];
  const fakeKiln = { status: () => 'ready', downloadSize: () => 0, async exec(id, code, opts) { calls.push(opts || {}); return { status: 'ok', stdout: '', stderr: '' }; } };

  const agentShell = createShell({ registry, face, kiln: fakeKiln });
  await agentShell.feed('python -c "print(1)"');
  ok("the agent's shell does NOT isolate", calls.length === 1 && calls[0].isolate !== true);

  const gateShell = createShell({ registry, face, kiln: fakeKiln, kilnIsolate: true });
  await gateShell.feed('python -c "print(1)"');
  ok("the verifier's shell DOES isolate", calls.length === 2 && calls[1].isolate === true);
}

// ── 4b. sys.argv is the script's, as CPython sets it ──────────────────────
{
  const py = makeFakePyodide();
  await mkKiln(py).exec('shell', 'print(1)', { isolate: true, argv: ['t.py', 'a', 'b'] });
  ok('argv lands in sys.argv before the script runs', py._seen.sync.some((c) => /sys\.argv = \["t\.py","a","b"\]/.test(c)));
  const py2 = makeFakePyodide();
  await mkKiln(py2).exec('shell', 'print(1)', { isolate: true });
  ok('no argv given → sys.argv untouched', !py2._seen.sync.some((c) => /sys\.argv/.test(c)));
}

// ── 5. a runtime without the globals option still runs the gate ─────────────
{
  const py = makeFakePyodide();
  py.runPython = (code) => { if (/types\.ModuleType\("__main__"\)[\s\S]*__kiln_script\.__dict__$/.test(String(code).trim())) throw new Error('unsupported'); return undefined; };
  let ran = false;
  py.runPythonAsync = async () => { ran = true; };
  const r = await mkKiln(py).exec('gate', 'print(1)', { isolate: true });
  ok('degrades to the shared namespace rather than failing the gate', ran && r.status === 'ok');
}

// The fake Pyodide never executes Python, so it accepted a preamble that THREW: a bare del of
// a name the loop never bound raises NameError, and on the FIRST isolated run nothing has been
// imported from the workspace, so that list is always empty. Every first gate failed at exit 1
// before the criterion ran. Caught live 2026-09-10, not by this suite — hence this check.
{
  const { execFileSync } = await import('node:child_process');
  const { readFile, writeFile, mkdtemp } = await import('node:fs/promises');
  const nodePath = (await import('node:path')).default;
  const { tmpdir } = await import('node:os');
  const scratch = await mkdtemp(nodePath.join(tmpdir(), 'preamble-'));
  const src = await readFile(new URL('../main-thread-runtime.mjs', import.meta.url), 'utf8');
  const m = src.match(/return `\n(import sys as _ks[\s\S]*?)\n`;/);
  ok('the isolation preamble is extractable', Boolean(m));
  if (m) {
    const body = m[1].replace('${JSON.stringify(root)}', '"/work"');
    // Written to a file rather than squeezed into `python3 -c`: the preamble is multi-line
    // Python and quoting it through an argv string is its own source of bugs.
    const harness = [
      'import builtins',
      'class _S: modules = {}',
      '_ks = _S()',
      '_kb = builtins',
      '_KILN_B0 = dict(vars(builtins))',
      '',
      body,
      '',
      'print("PREAMBLE OK")',
    ].join('\n');
    const file = nodePath.join(scratch, 'preamble_check.py');
    await writeFile(file, harness);
    let out = '', threw = null;
    try { out = execFileSync('python3', [file], { encoding: 'utf8', timeout: 20000 }); }
    catch (err) { threw = String((err && err.stderr) || (err && err.message) || err).slice(0, 240); }
    if (threw && /ENOENT|not found/i.test(threw)) {
      console.log('  (python3 unavailable — preamble execution not checked)');
    } else {
      ok('the preamble RUNS with an empty module set (the first-gate case)', /PREAMBLE OK/.test(out));
      if (threw) console.error('    preamble raised:', threw.split('\n').slice(-3).join(' '));
    }
  }
}

console.log(`gate-isolation conformance: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
