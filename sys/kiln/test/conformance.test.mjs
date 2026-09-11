// K0 conformance suite — the gate artifact for the Kiln kernel (mock runtime).
//
//   node sys/kiln/test/conformance.test.mjs
//
// Verifies the kernel-core orchestration + consent gate headlessly against a
// MockRuntime: namespace persistence, timeout-interrupt (kernel still usable),
// external interrupt, exception → structured traceback (never a hang or a throw
// across the boundary), output cap, provenance, and the no-fetch-without-consent
// guarantee. The real Pyodide behaviour is verified separately (pyodide-runtime).

import { createKiln, MockRuntime } from '../index.mjs';

// ── tiny harness ──────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push({ name, message: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
const readyKiln = () => createKiln({ loadRuntime: async () => new MockRuntime(), consent: () => true });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ── namespace persists across exec (the whole point) ─────────────────────
await test('the namespace persists across exec calls', async () => {
  const kiln = readyKiln();
  const a = await kiln.exec('c1', 'x = 5', { provenance: 'operator' });
  eq(a.status, 'ok', 'assign ok');
  const b = await kiln.exec('c2', 'print(x)', { provenance: 'operator' });
  eq(b.status, 'ok', 'read ok');
  eq(b.stdout, '5\n', 'value persisted from an earlier cell');
});

// ── runaway loop interrupted within timeout, kernel still usable ─────────
await test('a runaway loop is interrupted by the timeout and the kernel survives', async () => {
  const kiln = readyKiln();
  const r = await kiln.exec('loop', 'LOOP', { timeoutMs: 40 });
  eq(r.status, 'timeout', 'runaway loop → timeout');
  // kernel remains usable afterward
  eq((await kiln.exec('c', 'y = 7')).status, 'ok', 'kernel usable after timeout');
  eq((await kiln.exec('c2', 'print(y)')).stdout, '7\n', 'namespace intact after timeout');
});

await test('an explicit interrupt stops a running cell', async () => {
  const kiln = readyKiln();
  const p = kiln.exec('loop2', 'LOOP', { timeoutMs: 60000 });
  await tick(10);
  const i = kiln.interrupt('loop2');
  assert(i.ok, 'interrupt acknowledged');
  const r = await p;
  eq(r.status, 'interrupted', 'explicit interrupt → interrupted (not timeout)');
});

// ── uncaught exception → structured traceback, never a hang or a throw ───
await test('an uncaught exception returns a traceback as data', async () => {
  const kiln = readyKiln();
  let threw = false, r;
  try { r = await kiln.exec('err', 'raise ValueError(boom)'); } catch (_) { threw = true; }
  assert(!threw, 'exec must not throw across the boundary');
  eq(r.status, 'error', 'error status');
  assert(r.traceback && /ValueError: boom/.test(r.traceback), `traceback present: ${r.traceback}`);
  eq((await kiln.exec('after', 'ok = 1')).status, 'ok', 'kernel usable after an exception');
});

// `sys.exit(n)` from the worker runtime arrives as exitCode, never as a traceback — the kernel
// maps 0 to ok and n>0 to error, and carries n on the result (live 2026-09-11).
await test('an exitCode from the runtime is a status and a code, not a traceback', async () => {
  const mk = (exitCode) => ({
    async runCode() { return { stdout: 'ran\n', stderr: '', result: null, traceback: null, interrupted: false, truncated: false, exitCode }; },
    interrupt() {}, reset() {},
  });
  const k0 = createKiln({ loadRuntime: async () => mk(0), consent: () => true }); const r0 = await k0.exec('c', 'sys.exit(0)');
  eq(r0.status, 'ok', 'exit 0 is ok'); eq(r0.code, 0, 'and says 0'); assert(!r0.traceback, 'no traceback');
  const k3 = createKiln({ loadRuntime: async () => mk(3), consent: () => true }); const r3 = await k3.exec('c', 'sys.exit(3)');
  eq(r3.status, 'error', 'exit 3 is an error'); eq(r3.code, 3, 'and says 3'); assert(!r3.traceback, 'still no traceback — an exit is not a crash');
  const kn = createKiln({ loadRuntime: async () => mk(null), consent: () => true }); const rn = await kn.exec('c', 'x = 1');
  eq(rn.status, 'ok', 'no exitCode → ok as before'); assert(!('code' in rn), 'and no code key invented');
});

await test('defect 7: exec({cwd}) reaches the runtime as runCode({cwd}); absent, it is not invented', async () => {
  const seen = [];
  const rt = { async runCode(code, opts) { seen.push(opts); return { stdout: '', stderr: '', result: null, traceback: null, interrupted: false, truncated: false }; }, interrupt() {}, reset() {} };
  const k = createKiln({ loadRuntime: async () => rt, consent: () => true });
  await k.exec('c', 'x', { cwd: 'sub/dir' }); eq(seen[0].cwd, 'sub/dir', 'passed through');
  await k.exec('c', 'x', {});                 assert(!('cwd' in seen[1]), 'not invented when absent');
});

await test('a runtime that throws never leaks the throw across the boundary', async () => {
  const kiln = readyKiln();
  let threw = false, r;
  try { r = await kiln.exec('boom', 'THROW'); } catch (_) { threw = true; }
  assert(!threw, 'must not throw');
  eq(r.status, 'error', 'typed error result');
  assert(/blew up/.test(r.traceback || r.stderr), 'carries the failure as data');
});

// ── output cap ───────────────────────────────────────────────────────────
await test('output is capped and truncation is reported', async () => {
  const kiln = readyKiln();
  const r = await kiln.exec('big', 'BIGOUTPUT 5000', { outputCapBytes: 100 });
  eq(r.stdout.length, 100, 'stdout capped');
  eq(r.truncated, true, 'truncation reported');
});

// ── provenance + inspect/listNames/reset ─────────────────────────────────
await test('provenance is recorded on every cell', async () => {
  const kiln = readyKiln();
  await kiln.exec('p1', 'z = 1', { provenance: 'session-42' });
  const cells = kiln.cells();
  eq(cells[cells.length - 1].provenance, 'session-42', 'provenance recorded');
});

await test('inspect / listNames / reset operate on the namespace', async () => {
  const kiln = readyKiln();
  await kiln.exec('c', 'a = 9');
  assert((await kiln.listNames()).names.includes('a'), 'listNames sees a');
  eq((await kiln.inspect('a')).info.repr, '9', 'inspect reports the repr');
  kiln.reset();
  eq((await kiln.listNames()).names.length, 0, 'reset clears the namespace');
});

// ── no fetch without consent (the security checkpoint) ───────────────────
await test('nothing loads or fetches until consent is granted', async () => {
  let loads = 0;
  let allow = false;
  const kiln = createKiln({
    loadRuntime: async () => { loads++; return new MockRuntime(); },
    consent: () => allow,
  });
  const r1 = await kiln.ensureReady();
  eq(r1.ok, false, 'not ready without consent');
  eq(r1.reason, 'consent-withheld', 'reason is consent-withheld');
  eq(loads, 0, 'loadRuntime NOT called without consent');
  const e1 = await kiln.exec('c', 'x = 1');
  eq(e1.status, 'unavailable', 'exec reports unavailable without consent');
  eq(loads, 0, 'exec did not trigger a load without consent');
  eq(kiln.status(), 'unloaded', 'still unloaded');
  // grant consent → now it loads, exactly once
  allow = true;
  const r2 = await kiln.ensureReady();
  assert(r2.ok, 'ready after consent');
  eq(loads, 1, 'loaded once');
  eq((await kiln.exec('c', 'x = 1')).status, 'ok', 'exec works after consent');
});

// ── report ──────────────────────────────────────────────────────────────
const total = passed + failures.length;
if (failures.length === 0) {
  console.log(`K0 conformance: ${passed}/${total} passed`);
  process.exit(0);
} else {
  console.log(`K0 conformance: ${passed}/${total} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.message}`);
  process.exit(1);
}
