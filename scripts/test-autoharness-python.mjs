#!/usr/bin/env node
// The autoharness bed's python (scripts/autoharness/python.mjs) on REAL Pyodide. Not a CI lane: CI has
// no Pyodide. Run it after any change to python.mjs, to the bed's kiln wiring, or to sys/kiln/.
//
//   npm i --prefix <dir> pyodide@0.27            (scratch, never a repo dependency)
//   AUTOHARNESS_PYODIDE=<dir> node scripts/test-autoharness-python.mjs
//
// Checks: the battery's pythonRef task passes through runTask; a run that never calls python loads no
// interpreter; the shell's python gives exit codes (sys.exit, unittest) without killing node; the `js`
// module is not node's globalThis; sqlite3 runs on its private interpreter; one run's interpreter state
// is invisible to the next, and to a concurrent one; a runaway loop is interrupted and the run goes on.
// Prints what python costs: the startup load, a run's first call (its own load) and a later call.
import { TASKS } from './autoharness/battery.mjs';
import { runTask, scriptedInfer, freshWorkspace } from './autoharness/bed.mjs';
import { bedKiln, loadBedPython, PYODIDE_DIR } from './autoharness/python.mjs';
import { createShell } from '../sys/rig/cli/shell.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';
import { buildRigRegistry } from '../sys/rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../sys/rig/agent/index.mjs';

if (!PYODIDE_DIR) { console.log('not run: needs AUTOHARNESS_PYODIDE=<dir> (npm i --prefix <dir> pyodide@0.27)'); process.exit(2); }
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond || !detail ? '' : '\n        ' + String(detail).slice(0, 600)}`); if (!cond) failed++; };
const ms = (t0) => Math.round(performance.now() - t0);
async function sh(ws, line) { const t0 = performance.now(); const r = await ws.shell.feed(line); return { out: String(r.output ?? ''), code: ws.shell.lastCode, ms: ms(t0) }; }
async function workspace(seed = {}) { const ws = freshWorkspace(seed); await ws.ready; return ws; }

const pre = await loadBedPython();
console.log(`autoharness bed python (Pyodide ${pre.version} from ${pre.dir}; startup load ${pre.loadMs} ms):`);

// ── the battery's python reference, through the whole assembly ──
for (const t of TASKS.filter((x) => x.pythonRef)) {
  const r = await runTask(t, { infer: scriptedInfer(t.solve) });
  check(`${t.id}: its python -c reference passes`, r.pass && !r.crash, `why ${r.why} | crash ${r.crash} | changed ${r.changed}`);
  check(`${t.id}: the run loaded one interpreter and made one python call`, r.python?.loads === 1 && r.python?.calls === 1, JSON.stringify(r.python));
}
const idle = await runTask(TASKS.find((x) => x.id === 'battery-write-fresh'), { infer: scriptedInfer(TASKS.find((x) => x.id === 'battery-write-fresh').solve) });
check('a run that never calls python loads no interpreter', idle.pass && idle.python?.loads === 0 && idle.python?.calls === 0, JSON.stringify(idle.python));

// ── what the agent's shell gives back ──
const ws = await workspace({ 't_ok.py': 'import unittest\nclass T(unittest.TestCase):\n    def test_a(self): self.assertEqual(2 + 2, 4)\nunittest.main()\n',
  't_bad.py': 'import unittest\nclass T(unittest.TestCase):\n    def test_a(self): self.assertEqual(2 + 2, 5)\nunittest.main()\n' });
const first = await sh(ws, 'python -c "print(6 * 7)"');
const firstLoadMs = ws.kiln.stats.loadMs;
const second = await sh(ws, 'python -c "print(6 * 7)"');
check('python -c prints and exits 0', first.out.trim() === '42' && first.code === 0, JSON.stringify(first));
const exit3 = await sh(ws, `python -c "import sys; print('before'); sys.exit(3)"`);
check('sys.exit(3) is exit code 3, and node is still here', exit3.code === 3 && /before/.test(exit3.out), JSON.stringify(exit3));
const uok = await sh(ws, 'python t_ok.py'), ubad = await sh(ws, 'python t_bad.py');
check('unittest.main(): a green file exits 0, a red one exits 1', uok.code === 0 && /\bOK\b/.test(uok.out) && ubad.code === 1 && /FAILED/.test(ubad.out), `${uok.code} ${uok.out.slice(-80)} | ${ubad.code} ${ubad.out.slice(-80)}`);
const version = await sh(ws, 'python --version');
check('python --version names the interpreter', /^Python 3\.\d+\.\d+/.test(version.out.trim()) && version.code === 0, version.out);
const jsmod = await sh(ws, `python -c "import js; print(js.process.env)"`);
check('the js module is not node\'s globalThis (no process.env)', jsmod.code === 1 && /AttributeError/.test(jsmod.out), jsmod.out.slice(-200));
const sql = await sh(ws, 'sqlite3 :memory: "select 6 * 7"');
check('sqlite3 runs on the private interpreter (a second load)', sql.out.trim() === '42' && sql.code === 0 && ws.kiln.stats.loads === 2, `${JSON.stringify(sql)} ${JSON.stringify(ws.kiln.stats)}`);

// ── isolation: what one run leaves in its interpreter, the next run does not see ──
const a = await workspace();
await sh(a, `python -c "import os, sys; open('/tmp/leak.txt', 'w').write('x'); os.environ['LEAK'] = '1'; open('/tmp/leakmod.py', 'w').write('V = 1'); sys.path.insert(0, '/tmp'); import leakmod; os.makedirs('/work/onlyA')"`);
const b = await workspace({ 'b.txt': 'b\n' });
const seen = await sh(b, `python -c "import os, sys; print(os.path.exists('/tmp/leak.txt'), os.environ.get('LEAK'), 'leakmod' in sys.modules, sorted(os.listdir('/work')))"`);
check('a later run sees none of an earlier run\'s /tmp, environ, modules or directories', seen.out.trim() === "False None False ['b.txt']", seen.out);
const many = await Promise.all(['p', 'q', 'r', 's'].map(async (n) => {
  const w = await workspace({ [`${n}.txt`]: n });
  const outs = [];
  for (let i = 0; i < 3; i++) outs.push((await sh(w, `python -c "import os; print(sorted(os.listdir('.')), open('${n}.txt').read())"`)).out.trim());
  return outs.every((o) => o === `['${n}.txt'] ${n}`);
}));
check('four concurrent runs, three python calls each, each sees only its own workspace and output', many.every(Boolean), JSON.stringify(many));

// ── the runaway guard (a short limit; the bed's is 30 s) ──
const fs = createFileops({ backend: new MemoryBackend() });
const registry = buildRigRegistry({ fs });
const face = createAgentFace({ registry, grant: createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] }), opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
const kiln = bedKiln(fs, { limitMs: 1500 });
const guarded = { shell: createShell({ registry, face, kiln, kilnIsolate: true }) };
const loop = await sh(guarded, 'python -c "while True: pass"');
check('while True: is interrupted after the limit, exit 1 with KeyboardInterrupt', loop.code === 1 && /KeyboardInterrupt/.test(loop.out) && loop.ms >= 1500 && loop.ms < 8000, JSON.stringify({ ...loop, out: loop.out.slice(-120) }));
const swallow = await sh(guarded, `python -c "
while True:
    try:
        x = 1
    except Exception:
        pass"`);
check('an except-Exception loop is interrupted too (KeyboardInterrupt is a BaseException)', swallow.code === 1 && /KeyboardInterrupt/.test(swallow.out) && swallow.ms < 8000, JSON.stringify({ ...swallow, out: swallow.out.slice(-120) }));
const after = await sh(guarded, 'python -c "print(1 + 1)"');
check('the next python call in the same run works, with no stale interrupt', after.out.trim() === '2' && after.code === 0 && after.ms < 1000, JSON.stringify(after));

console.log(`  cost: startup load ${pre.loadMs} ms; a run's first python call ${first.ms} ms (its own interpreter's load ${firstLoadMs} ms), a later call ${second.ms} ms; rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('ok — the bed\'s python is the app\'s main-thread Kiln, one interpreter per run, and node survives it');
