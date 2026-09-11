// Conformance: sys/kiln/main-thread-runtime.mjs
// Verifies the no-SAB main-thread Python runtime's workspace<->MEMFS sync and the
// shell `exec` contract, using a fake Pyodide (injected loader). No real Pyodide.

import { createMainThreadKiln } from '../main-thread-runtime.mjs';
import { systemExitCode } from '../pyodide-runtime.mjs';
import { createFileops } from '../../rig/fileops/index.mjs';
import { MemoryBackend } from '../../rig/fileops/memory-backend.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', name); } };

// ── A minimal fake Pyodide: a flat in-memory FS + hookable runPythonAsync ──
function makeFakePyodide() {
  const files = new Map();   // abs path -> string content
  const dirs = new Set(['/']);
  let stdout = null, stderr = null;
  const addDirs = (p) => { const parts = p.split('/').filter(Boolean); let cur = ''; for (const s of parts) { cur += '/' + s; dirs.add(cur); } };
  const FS = {
    mkdirTree(p) { addDirs(p); },
    writeFile(p, d) { const dd = p.slice(0, p.lastIndexOf('/')); if (dd) addDirs(dd); files.set(p, String(d)); },
    readFile(p) { if (!files.has(p)) throw new Error('ENOENT: ' + p); return files.get(p); },
    readdir(dir) {
      const prefix = dir === '/' ? '/' : dir + '/';
      const names = new Set();
      for (const p of [...files.keys(), ...dirs]) {
        if (p === dir || !p.startsWith(prefix)) continue;
        const name = p.slice(prefix.length).split('/')[0];
        if (name) names.add(name);
      }
      return ['.', '..', ...names];
    },
    stat(p) { const isDir = dirs.has(p) && !files.has(p); return { mode: isDir ? 0o040000 : 0o0100000 }; },
    isDir(mode) { return (mode & 0o170000) === 0o040000; },
  };
  const py = {
    FS,
    setStdout(o) { stdout = o && o.batched; },
    setStderr(o) { stderr = o && o.batched; },
    runPython() { /* os.chdir / sys.path — no-op in the fake */ },
    async runPythonAsync(code) { if (py._onRun) await py._onRun({ FS, out: (s) => stdout && stdout(s), err: (s) => stderr && stderr(s), code }); },
    _files: files, _onRun: null,
  };
  return py;
}

async function run() {
  // ── 1. syncIn: workspace files land in MEMFS under the mount root ──
  {
    const fs = createFileops({ backend: new MemoryBackend() });
    await fs.write('a.py', 'print("hi")\n');
    await fs.write('pkg/b.py', 'VALUE = 42\n');
    const fake = makeFakePyodide();
    const kiln = createMainThreadKiln({ fs, mount: 'work', loadPyodide: async () => fake });
    let sawFiles = null;
    fake._onRun = ({ FS }) => { sawFiles = { a: FS.readFile('/work/a.py'), b: FS.readFile('/work/pkg/b.py') }; };
    const r = await kiln.exec('shell', 'noop');
    ok('exec returns ok', r.status === 'ok');
    ok('syncIn copied a.py into MEMFS', sawFiles && sawFiles.a === 'print("hi")\n');
    ok('syncIn copied nested pkg/b.py into MEMFS', sawFiles && sawFiles.b === 'VALUE = 42\n');
  }

  // ── 2. stdout is captured and returned ──
  {
    const fs = createFileops({ backend: new MemoryBackend() });
    const fake = makeFakePyodide();
    const kiln = createMainThreadKiln({ fs, mount: 'work', loadPyodide: async () => fake });
    fake._onRun = ({ out }) => { out('hello\n'); out('world\n'); };
    const r = await kiln.exec('shell', 'print("hello"); print("world")');
    ok('stdout captured', r.stdout === 'hello\nworld\n');
    ok('no stderr on success', r.stderr === '');
  }

  // ── 3. syncOut: a NEW file Python writes is synced back to the workspace ──
  {
    const backend = new MemoryBackend();
    const fs = createFileops({ backend });
    await fs.write('seed.txt', 'seed\n');
    const fake = makeFakePyodide();
    const kiln = createMainThreadKiln({ fs, mount: 'work', loadPyodide: async () => fake });
    fake._onRun = ({ FS }) => { FS.writeFile('/work/out.txt', 'generated\n'); };
    await kiln.exec('shell', 'open("out.txt","w").write("generated")');
    const rd = await fs.read('out.txt', { encoding: 'utf-8' });
    ok('new file synced back to workspace', rd.ok && rd.data === 'generated\n');
  }

  // ── 4. syncOut skips __pycache__ / .pyc ──
  {
    const fs = createFileops({ backend: new MemoryBackend() });
    const fake = makeFakePyodide();
    const kiln = createMainThreadKiln({ fs, mount: 'work', loadPyodide: async () => fake });
    fake._onRun = ({ FS }) => { FS.writeFile('/work/__pycache__/m.pyc', 'bytecode'); FS.writeFile('/work/keep.py', 'x=1\n'); };
    await kiln.exec('shell', 'import m');
    const cache = await fs.read('__pycache__/m.pyc', { encoding: 'utf-8' });
    const keep = await fs.read('keep.py', { encoding: 'utf-8' });
    ok('__pycache__/.pyc not synced back', !cache.ok);
    ok('normal file still synced back', keep.ok && keep.data === 'x=1\n');
  }

  // ── 5. a Python error → status:error, with the message in stderr ──
  {
    const fs = createFileops({ backend: new MemoryBackend() });
    const fake = makeFakePyodide();
    const kiln = createMainThreadKiln({ fs, mount: 'work', loadPyodide: async () => fake });
    fake._onRun = () => { throw new Error('NameError: name \'x\' is not defined'); };
    const r = await kiln.exec('shell', 'print(x)');
    ok('error → status error', r.status === 'error');
    ok('error message in stderr', /NameError/.test(r.stderr));
  }

// `sys.exit(n)` is an exit code, not a failure (live 2026-09-11: a script ending
// `sys.exit(main())` returned 0 and the kernel reported a traceback with exit 1).
{
  const PY = 'Traceback (most recent call last):\n  File "/lib/python312.zip/_pyodide/_base.py", line 597, in eval_code_async\n    await CodeRunner(\n  File "<exec>", line 35, in <module>\n';
  ok('systemExitCode: "SystemExit: 0" → 0', systemExitCode(PY + 'SystemExit: 0') === 0);
  ok('systemExitCode: bare "SystemExit" (None) → 0', systemExitCode(PY + 'SystemExit') === 0);
  ok('systemExitCode: "SystemExit: 3" → 3', systemExitCode(PY + 'SystemExit: 3') === 3);
  ok('systemExitCode: a message payload exits 1, as CPython does', systemExitCode(PY + 'SystemExit: usage: x') === 1);
  ok('systemExitCode: a NameError is not a SystemExit', systemExitCode(PY + "NameError: name 'x' is not defined") === null);
  ok('systemExitCode: SystemExit mentioned mid-traceback is not the exit', systemExitCode('SystemExit: 0\nValueError: boom') === null);

  const fs = createFileops({ backend: new MemoryBackend() });
  const fake = makeFakePyodide();
  const kiln = createMainThreadKiln({ fs, loadPyodide: async () => fake });
  fake._onRun = ({ out }) => { out('done\n'); throw new Error(PY + 'SystemExit: 0'); };
  const r0 = await kiln.exec('shell', 'import sys; print("done"); sys.exit(0)');
  ok('exit 0 → status ok', r0.status === 'ok');
  ok('exit 0 → stdout kept', /done/.test(r0.stdout));
  ok('exit 0 → no traceback in stderr', !/Traceback|SystemExit/.test(r0.stderr || ''));
  ok('exit 0 → code 0', r0.code === 0);
  fake._onRun = () => { throw new Error(PY + 'SystemExit: 3'); };
  const r3 = await kiln.exec('shell', 'import sys; sys.exit(3)');
  ok('exit 3 → status error', r3.status === 'error');
  ok('exit 3 → code 3', r3.code === 3);
  ok('exit 3 → no traceback (it is an exit, not a crash)', !/Traceback/.test(r3.stderr || ''));
  fake._onRun = () => { throw new Error(PY + 'ValueError: boom'); };
  const rv = await kiln.exec('shell', 'raise ValueError("boom")');
  ok('a real exception is still status error with its traceback', rv.status === 'error' && /ValueError: boom/.test(rv.stderr));
}

  // ── 6. loader failure → status:unavailable (graceful) ──
  {
    const fs = createFileops({ backend: new MemoryBackend() });
    const kiln = createMainThreadKiln({ fs, loadPyodide: async () => { throw new Error('no network'); } });
    const r = await kiln.exec('shell', 'print(1)');
    ok('loader failure → unavailable', r.status === 'unavailable');
    ok('unavailable carries a message', /no network/.test(r.message || ''));
  }

  // ── 7. .git/ is never round-tripped through MEMFS (protects the shell's git repo) ──
  // Regression: the snapshot handles files as UTF-8; git's binary index/objects were
  // corrupted (index → 0 bytes) when .git/ was copied in and written back, breaking
  // the shell's git. .git/ must be skipped in BOTH directions.
  {
    const fs = createFileops({ backend: new MemoryBackend() });
    await fs.write('.git/index', 'DIRC-real-index-bytes');   // the shell-managed repo
    await fs.write('app.py', 'print(1)\n');
    const fake = makeFakePyodide();
    const kiln = createMainThreadKiln({ fs, mount: 'work', loadPyodide: async () => fake });
    let sawGit = 'not-checked';
    fake._onRun = ({ FS }) => {
      try { FS.readFile('/work/.git/index'); sawGit = 'present'; } catch (_) { sawGit = 'absent'; }
      try { FS.writeFile('/work/.git/index', ''); } catch (_) {}  // python clobbers its MEMFS copy
      FS.writeFile('/work/app.py', 'print(2)\n');                  // and edits a real source file
    };
    await kiln.exec('shell', 'noop');
    const idx = await fs.read('.git/index', { encoding: 'utf-8' });
    const app = await fs.read('app.py', { encoding: 'utf-8' });
    ok('.git/ not copied into MEMFS (syncIn skip)', sawGit === 'absent');
    ok('.git/index preserved in the workspace (syncOut skip)', idx.ok && idx.data === 'DIRC-real-index-bytes');
    ok('normal source edits still sync back', app.ok && app.data === 'print(2)\n');
  }

  console.log(`sys/kiln/main-thread-runtime conformance: ${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

run();
