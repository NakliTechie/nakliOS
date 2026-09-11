#!/usr/bin/env node
// Conformance: arming a run's gate is one call, and it refuses the half-states.
//
// Why this exists: on 2026-09-10 the test bed produced four full agent runs, all `stop: done`,
// and all `status: unclaimed` — because nothing set a gate. The machinery was there (t.verifyCmd
// -> makeShellVerifier -> verify.passed -> foldStatus) and the harness simply never used it.
//
// Arming has TWO writes: author the criterion under the fenced .anvil/gate/, and point the task's
// verifyCmd at it. Either alone yields a run that looks gated and still grades itself:
//   - a criterion with no gate set is a file nobody runs;
//   - a gate with no criterion written is a command that cannot pass;
//   - a gate whose command does not mention the criterion measures something else entirely.
// planGate refuses all three BEFORE anything is written, so a rejected arm leaves no residue.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planGate, GATE_DIR, underGateDir } from '../gate.mjs';

// N2 (2026-09-12): planGate also lints the criterion (gate-lint.test.mjs) — two independent
// assertions is the floor, so every fixture that must arm carries two.
const TWO = 'assert type(fib(10)) is int and fib(10) == 55\nassert type(fib(1)) is int and fib(1) == 1\n';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', name); } };

// ── the happy path ──────────────────────────────────────────────────────────
{
  const p = planGate({ file: 'test_fib.py', source: TWO });
  ok('a bare filename lands under the fence', p.ok && p.path === `${GATE_DIR}/test_fib.py`);
  ok('the default command runs the criterion', p.ok && p.command === `python ${GATE_DIR}/test_fib.py`);
  ok('the planned path is inside the fence', underGateDir(p.path));

  const explicit = planGate({
    file: `${GATE_DIR}/t.py`, source: TWO,
    command: `python ${GATE_DIR}/t.py --strict`,
  });
  ok('an explicit command is kept', explicit.ok && explicit.command.endsWith('--strict'));
}

// ── the half-states, each refused ───────────────────────────────────────────
{
  const outside = planGate({ file: 'tests/test_fib.py', source: 'assert 1\n' });
  ok('a criterion outside the fence is refused', !outside.ok && /must live under/.test(outside.error));
  ok('the refusal says why the fence matters', !outside.ok && /fence covers nothing else/.test(outside.error));

  const escape = planGate({ file: '../../etc/passwd', source: TWO }); // TWO: so the fence, not the lint, is what refuses
  ok('a traversal out of the fence is refused', !escape.ok);

  const empty = planGate({ file: 'test_x.py', source: '   ' });
  ok('an empty criterion is refused', !empty.ok && /exits 0 and passes everything/.test(empty.error));

  const noFile = planGate({ source: TWO }); // TWO: so the missing name, not the lint, is what refuses
  ok('a gate with no criterion file is refused', !noFile.ok);

  const mismatched = planGate({
    file: 'test_fib.py', source: TWO, command: 'pytest tests/',
  });
  ok('a command that does not run the criterion is refused',
    !mismatched.ok && /does not mention/.test(mismatched.error));
}

// ── purity: planGate decides, the caller writes ─────────────────────────────
{
  const p = planGate({ file: 'a.py', source: TWO });
  ok('planGate returns a plan, not an effect', p.ok && typeof p.source === 'string' && !('written' in p));
}

// ── the app actually uses it, and both writes live in one place ─────────────
{
  const anvil = readFileSync(new URL('../../../apps/anvil/index.html', import.meta.url), 'utf8');
  const imported = anvil.match(/import \{([^}]*)\} from '\.\.\/\.\.\/sys\/ai\/gate\.mjs';/);
  ok('anvil imports planGate from the module', imported && /\bplanGate\b/.test(imported[1]));
  ok('planGate is not redefined in the app', !/(const|let|function)\s+planGate\s*[=(]/.test(anvil));

  const arm = anvil.match(/armGate:async\([\s\S]*?\n    \},/);
  ok('armGate exists on the test door', Boolean(arm));
  if (arm) {
    const body = arm[0];
    // Assert the guard EXISTS and precedes the write. A bare `indexOf(a) < indexOf(b)` passes
    // when the guard is deleted, because -1 is less than everything — the mutation that
    // removed it survived until this line checked for presence first.
    const guardAt = body.indexOf('if(!plan.ok) return plan');
    const writeAt = body.indexOf('fs.write');
    ok('armGate has the refuse-before-write guard', guardAt >= 0);
    ok('armGate refuses BEFORE it writes', guardAt >= 0 && writeAt >= 0 && guardAt < writeAt);
    ok('armGate authors the criterion through the OWNER door', /fs\.write\(plan\.path/.test(body));
    ok('armGate sets the task gate in the same call', /verifyCmd=plan\.command/.test(body));
  }

  // An ungated bed run must announce itself: `unclaimed` is easy to misread as success later.
  ok('an ungated test-bed run warns at the moment it starts',
    /this run is UNGATED/.test(anvil) && /__anvilTestOptIn/.test(anvil.slice(anvil.indexOf('this run is UNGATED') - 400, anvil.indexOf('this run is UNGATED'))));
  ok('the warning names the status the record will carry', /status:unclaimed/.test(anvil));
}

console.log(`gate-arming conformance: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
