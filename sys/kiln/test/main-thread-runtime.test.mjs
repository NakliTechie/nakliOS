// Conformance: sys/kiln/main-thread-runtime.mjs
// Verifies the no-SAB main-thread Python runtime's workspace<->MEMFS sync and the
// shell `exec` contract, using a fake Pyodide (injected loader). No real Pyodide.

import { createMainThreadKiln, safeCwd } from '../main-thread-runtime.mjs';
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
    // bytes in the store, as MEMFS keeps them; a string write is encoded, a read decodes only when asked
    writeFile(p, d) { const dd = p.slice(0, p.lastIndexOf('/')); if (dd) addDirs(dd); files.set(p, d instanceof Uint8Array ? new Uint8Array(d) : new TextEncoder().encode(String(d))); },
    readFile(p, o) { if (!files.has(p)) throw new Error('ENOENT: ' + p); const b = files.get(p); return o && o.encoding ? new TextDecoder().decode(b) : new Uint8Array(b); },
    unlink(p) { if (!files.has(p)) throw new Error('ENOENT: ' + p); files.delete(p); },
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
    // bytes in, as Pyodide's `write` hands them; the runtime must not use `batched` (it strips newlines)
    setStdout(o) { if (o && o.batched) throw new Error('batched capture strips newlines — use write'); stdout = o && o.write; },
    setStderr(o) { if (o && o.batched) throw new Error('batched capture strips newlines — use write'); stderr = o && o.write; },
    // the byte protocol, as Pyodide offers it: read(buf) fills and returns a count, 0 at EOF
    setStdin(o) { if (o && o.stdin) throw new Error('the string stdin handler appends a newline — use read'); py._read = o && o.read; },
    runPython() { /* os.chdir / sys.path — no-op in the fake */ },
    async runPythonAsync(code) { const enc = new TextEncoder(); if (py._onRun) await py._onRun({ FS, out: (s) => stdout && stdout(enc.encode(s)), err: (s) => stderr && stderr(enc.encode(s)), code }); },
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
    fake._onRun = ({ FS }) => { sawFiles = { a: FS.readFile('/work/a.py', { encoding: 'utf8' }), b: FS.readFile('/work/pkg/b.py', { encoding: 'utf8' }) }; };
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

  // ── 2b. the two streams come back in the order they were written ──
  // `print("before")` then unittest's stderr came back as "before-----…" with `batched`: newline
  // gone, and stderr appended after ALL of stdout. `output` is what a terminal showed.
  {
    const fs = createFileops({ backend: new MemoryBackend() });
    const fake = makeFakePyodide();
    const kiln = createMainThreadKiln({ fs, mount: 'work', loadPyodide: async () => fake });
    fake._onRun = ({ out, err }) => { out('before\n'); err('Ran 0 tests\n'); out('after\n'); err('é: multi'); err('byte\n'); };
    const r = await kiln.exec('shell', 'x');
    ok('output keeps the write order', r.output === 'before\nRan 0 tests\nafter\né: multibyte\n');
    ok('stdout alone is still stdout', r.stdout === 'before\nafter\n');
    ok('stderr alone is still stderr', r.stderr === 'Ran 0 tests\né: multibyte\n');
  }

  // ── 1b. MEMFS mirrors the workspace both ways: a workspace delete is not undone by the next run,
  // and a delete Python makes reaches the workspace ──
  {
    const fs = createFileops({ backend: new MemoryBackend() });
    await fs.write('keep.py', 'x = 1\n'); await fs.write('gone.md', 'bye\n');
    const fake = makeFakePyodide();
    const kiln = createMainThreadKiln({ fs, mount: 'work', loadPyodide: async () => fake });
    fake._onRun = () => {};
    await kiln.exec('shell', 'noop');
    ok('first run synced gone.md in', fake._files.has('/work/gone.md'));
    await fs.remove('gone.md');                       // the shell's rm, between two runs
    let memAfterSync = null;
    fake._onRun = ({ FS }) => { let has = true; try { FS.readFile('/work/gone.md'); } catch (_) { has = false; } memAfterSync = has; };
    await kiln.exec('shell', 'noop');
    ok('a file the workspace no longer has is gone from MEMFS on the next run', memAfterSync === false);
    ok('and was NOT written back into the workspace', !(await fs.read('gone.md', { encoding: 'utf-8' })).ok);
    ok('the file that stayed is still there', (await fs.read('keep.py', { encoding: 'utf-8' })).data === 'x = 1\n');
    fake._onRun = ({ FS }) => { FS.unlink('/work/keep.py'); };   // os.remove in the script
    await kiln.exec('shell', 'import os; os.remove("keep.py")');
    ok('a delete Python makes reaches the workspace', !(await fs.read('keep.py', { encoding: 'utf-8' })).ok);
  }

  // ── 2c. stdin is what the shell fed, then EOF; nothing fed is EOF at once, never an I/O error ──
  {
    const fs = createFileops({ backend: new MemoryBackend() });
    const fake = makeFakePyodide();
    const kiln = createMainThreadKiln({ fs, mount: 'work', loadPyodide: async () => fake });
    const drain = () => { const dec = new TextDecoder(); let s = '', calls = 0; for (;;) { const buf = new Uint8Array(7); const n = fake._read(buf); calls++; if (!n) break; s += dec.decode(buf.subarray(0, n), { stream: true }); } return { s, calls }; };
    let got = null;
    fake._onRun = () => { got = drain(); };
    await kiln.exec('shell', 'sys.stdin.read()', { stdin: 'q' });
    ok('the fed bytes are the bytes — no newline appended to a text that has none', got && got.s === 'q');
    await kiln.exec('shell', 'sys.stdin.read()', { stdin: 'line one\nline two — é' });
    ok('a text longer than the read buffer arrives whole, then EOF', got && got.s === 'line one\nline two — é' && got.calls > 2);
    await kiln.exec('shell', 'sys.stdin.read()');
    ok('no stdin → EOF at once', got && got.s === '' && got.calls === 1);
  }

  // ── 1c. U4: bytes both ways — a binary the workspace holds reaches MEMFS intact, a binary
  // Python writes reaches the workspace intact, and text is still text ──
  {
    const fs = createFileops({ backend: new MemoryBackend() });
    const all = new Uint8Array(256); for (let i = 0; i < 256; i++) all[i] = i;   // every byte, incl. 0x00 and 0x80–0xFF
    await fs.write('in.bin', all); await fs.write('note.txt', 'héllo\n');
    const fake = makeFakePyodide();
    const kiln = createMainThreadKiln({ fs, mount: 'work', loadPyodide: async () => fake });
    let sawIn = null;
    fake._onRun = ({ FS }) => { sawIn = FS.readFile('/work/in.bin'); const out = new Uint8Array(256); for (let i = 0; i < 256; i++) out[i] = 255 - i; FS.writeFile('/work/out.bin', out); FS.writeFile('/work/made.txt', 'ok\n'); };
    await kiln.exec('shell', 'x');
    ok('a workspace binary reaches MEMFS byte-exact', sawIn instanceof Uint8Array && sawIn.length === 256 && sawIn.every((b, i) => b === i));
    const outBin = await fs.read('out.bin');
    ok('a binary Python wrote reaches the workspace byte-exact', outBin.ok && outBin.data.length === 256 && outBin.data.every((b, i) => b === 255 - i));
    ok('a text file Python wrote is still its text', (await fs.read('made.txt', { encoding: 'utf-8' })).data === 'ok\n');
    ok('a workspace text file is unchanged by the round trip', (await fs.read('note.txt', { encoding: 'utf-8' })).data === 'héllo\n');
    // nothing changed → NOTHING written: the change check is on bytes, and it is a check, not a rewrite
    let writes = 0; const rawWrite = fs.write.bind(fs); fs.write = (...a) => { writes++; return rawWrite(...a); };
    fake._onRun = () => {};
    await kiln.exec('shell', 'noop');
    ok('an unchanged workspace is not rewritten on the way out', writes === 0);
    // same length, different bytes → written (a length compare would miss it)
    fake._onRun = ({ FS }) => { const flip = new Uint8Array(256); for (let i = 0; i < 256; i++) flip[i] = i; flip[7] = 99; FS.writeFile('/work/in.bin', flip); };
    writes = 0; await kiln.exec('shell', 'x');
    ok('a same-length change in one byte is seen and written', writes === 1 && (await fs.read('in.bin')).data[7] === 99);
    fs.write = rawWrite;
    // a read the workspace refuses leaves no stale copy in MEMFS to be written back
    const fs2 = createFileops({ backend: new MemoryBackend() }); await fs2.write('v.txt', 'v1\n');
    const fake2 = makeFakePyodide(); const kiln2 = createMainThreadKiln({ fs: fs2, mount: 'work', loadPyodide: async () => fake2 });
    fake2._onRun = () => {}; await kiln2.exec('shell', 'noop');
    await fs2.write('v.txt', 'v2\n');
    const rawRead = fs2.read.bind(fs2); fs2.read = async (p, o) => (p === 'v.txt' ? { ok: false, error: 'EIO' } : rawRead(p, o));
    await kiln2.exec('shell', 'noop'); fs2.read = rawRead;
    ok('a refused read does not resurrect the previous run\'s copy', (await fs2.read('v.txt', { encoding: 'utf-8' })).data === 'v2\n');
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

  // ── 8. a file that fails to sync IN is not written back stale ──
  // Reproduced 2026-09-13: MEMFS held f.txt=v1 from an earlier run; the shell wrote v2; the next
  // run's sync-in of f.txt failed and `continue`d — the workspace still listed the file, so the
  // unlink pass left the stale node, `seen` had no record of it, and syncOut wrote v1 back over
  // v2 with exec reporting ok. Python read v1 during the run. Every failure shape must leave the
  // workspace at v2 and give Python ENOENT, not the stale text; the rest of the run is unaffected.
  {
    // A fileops whose read / list can be made to fail on demand, per path.
    const hook = (fs, ctl) => new Proxy(fs, {
      get(t, k) {
        if (k === 'read') return async (path, o) => {
          if (ctl.readNotOk.has(path)) return { ok: false, code: 'EIO', message: 'injected: ' + path };
          if (ctl.readThrows.has(path)) throw new Error('injected read rejection: ' + path);
          return t.read(path, o);
        };
        if (k === 'list') return async (...a) => { if (ctl.listThrows) throw new Error('injected list rejection'); return t.list(...a); };
        const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const probe = (FS) => { try { return FS.readFile('/work/f.txt', { encoding: 'utf8' }); } catch (_) { return 'ENOENT'; } };
    // Drives one failure shape: seed v1 into MEMFS, edit to v2 in the workspace, arm the failure,
    // run, and report what Python saw + what the workspace holds afterwards.
    const drive = async (label, arm, disarm) => {
      const ctl = { readNotOk: new Set(), readThrows: new Set(), listThrows: false };
      const real = createFileops({ backend: new MemoryBackend() });
      const fs = hook(real, ctl);
      await fs.write('f.txt', 'v1'); await fs.write('g.txt', 'g1');
      const fake = makeFakePyodide();
      const kiln = createMainThreadKiln({ fs, mount: 'work', loadPyodide: async () => fake });
      fake._onRun = () => {};
      await kiln.exec('shell', 'noop');
      ok(`${label}: MEMFS holds v1 after the first run`, new TextDecoder().decode(fake._files.get('/work/f.txt')) === 'v1');
      await fs.write('f.txt', 'v2');                     // the shell's edit, between two runs
      arm(ctl, fake);
      let saw = null, sawG = null;
      fake._onRun = ({ FS }) => { saw = probe(FS); sawG = FS.readFile('/work/g.txt', { encoding: 'utf8' }); FS.writeFile('/work/new.txt', 'made'); };
      const r = await kiln.exec('shell', 'noop');
      ok(`${label}: the workspace keeps v2`, (await real.read('f.txt', { encoding: 'utf-8' })).data === 'v2');
      ok(`${label}: Python sees ENOENT, not the stale v1`, saw === 'ENOENT');
      ok(`${label}: the run itself still happens and other files sync in`, r.status === 'ok' && sawG === 'g1');
      ok(`${label}: what Python wrote still syncs out`, (await real.read('new.txt', { encoding: 'utf-8' })).data === 'made');
      disarm(ctl, fake);
      fake._onRun = ({ FS }) => { saw = probe(FS); };
      await kiln.exec('shell', 'noop');
      ok(`${label}: once readable again the file is back at v2 for Python`, saw === 'v2');
    };
    await drive('fs.read ok:false', (ctl) => ctl.readNotOk.add('f.txt'), (ctl) => ctl.readNotOk.clear());
    await drive('fs.read rejects', (ctl) => ctl.readThrows.add('f.txt'), (ctl) => ctl.readThrows.clear());
    let origWrite = null;
    await drive('py.FS.writeFile throws',
      (_ctl, fake) => { origWrite = fake.FS.writeFile; fake.FS.writeFile = (p, d) => { if (p === '/work/f.txt') throw new Error('ENOMEM'); return origWrite(p, d); }; },
      (_ctl, fake) => { fake.FS.writeFile = origWrite; });

    // The whole sync-in throwing (the listing rejects) must not reach syncOut with an empty `seen`:
    // that wrote EVERY stale MEMFS file over the workspace. The run is refused instead.
    {
      const ctl = { readNotOk: new Set(), readThrows: new Set(), listThrows: false };
      const real = createFileops({ backend: new MemoryBackend() });
      const fs = hook(real, ctl);
      await fs.write('f.txt', 'v1'); await fs.write('g.txt', 'g1');
      const fake = makeFakePyodide();
      const kiln = createMainThreadKiln({ fs, mount: 'work', loadPyodide: async () => fake });
      let ran = 0;
      fake._onRun = () => { ran++; };
      await kiln.exec('shell', 'noop');
      await fs.write('f.txt', 'v2'); await fs.write('g.txt', 'g2');
      ctl.listThrows = true;
      const r = await kiln.exec('shell', 'noop');
      ok('sync-in throws: exec reports error, not ok', r.status === 'error' && /sync/.test(r.stderr));
      ok('sync-in throws: the script did not run', ran === 1);
      ok('sync-in throws: no stale write-back — f.txt is v2', (await real.read('f.txt', { encoding: 'utf-8' })).data === 'v2');
      ok('sync-in throws: no stale write-back — g.txt is g2', (await real.read('g.txt', { encoding: 'utf-8' })).data === 'g2');
      ctl.listThrows = false;
      let saw = null;
      fake._onRun = ({ FS }) => { saw = [probe(FS), FS.readFile('/work/g.txt', { encoding: 'utf8' })].join(','); };
      const r2 = await kiln.exec('shell', 'noop');
      ok('sync-in throws: the next run recovers with the current workspace', r2.status === 'ok' && saw === 'v2,g2');
    }
  }

  console.log(`sys/kiln/main-thread-runtime conformance: ${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

run();

// Defect 7: the kernel runs where the shell is; a cwd that would leave the root falls back to it.
{
  ok('safeCwd: empty → root', safeCwd('/work', '') === '/work');
  ok('safeCwd: a clean relative path is joined', safeCwd('/work', 'sub/dir') === '/work/sub/dir');
  ok('safeCwd: leading/trailing slashes are trimmed', safeCwd('/work', '/sub/') === '/work/sub');
  ok('safeCwd: `..` falls back to the root', safeCwd('/work', '../x') === '/work');
  ok('safeCwd: a bare `.` falls back to the root', safeCwd('/work', './x') === '/work');
  ok('safeCwd: backslashes are not a way out', safeCwd('/work', '..\\x') === '/work');
  const fs = createFileops({ backend: new MemoryBackend() });
  const fake = makeFakePyodide();
  const seen = [];
  const origRun = fake.runPython; fake.runPython = (code) => { seen.push(String(code)); return origRun ? origRun.call(fake, code) : undefined; };
  const kiln = createMainThreadKiln({ fs, loadPyodide: async () => fake });
  fake._onRun = () => {};
  await kiln.exec('shell', 'x = 1', { cwd: 'sub' });
  ok('exec(cwd:"sub") chdirs the kernel to root/sub', seen.some((c) => /os\.chdir\("[^"]*\/sub"\)/.test(c)));
  ok('and the ROOT, not the cwd, goes first on sys.path', seen.some((c) => /sys\.path\.insert\(0, "([^"]*)"\)/.test(c) && !/sys\.path\.insert\(0, "[^"]*\/sub"\)/.test(c)));
  seen.length = 0;
  await kiln.exec('shell', 'x = 2', { cwd: '../escape' });
  ok('a cwd that would leave the root runs at the root', seen.some((c) => /os\.chdir\("([^"]*)"\)/.test(c)) && !seen.some((c) => /escape/.test(c)));
}
