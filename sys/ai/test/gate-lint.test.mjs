#!/usr/bin/env node
// Conformance (N2, 2026-09-12): a green gate that cannot be `__eq__ = True`.
//
// On 2026-09-10 an agent passed a deliberately unsatisfiable criterion (`v == 42` AND `v == 43`)
// by returning `class _AlwaysEqual: __eq__ = lambda s, o: True`. The fence held; the criterion
// was weak. lintGateCriterion refuses the three shapes a machine can see before arming — a dunder
// comparison defined in the file, builtins monkeypatched, fewer than two independent assertions —
// and planGate (which armGate calls) refuses to arm on any of them and says why.
import assert from 'node:assert/strict';
import { lintGateCriterion, planGate, GATE_AUTHORING_HINT } from '../gate.mjs';

let n = 0;
const refused = (src, re, why) => { const r = lintGateCriterion(src); assert.equal(r.ok, false, why); assert.ok(r.problems.some((p) => re.test(p)), `${why}: ${JSON.stringify(r.problems)}`); n++; };
const passes = (src, why) => { const r = lintGateCriterion(src); assert.deepEqual(r, { ok: true, problems: [] }, why); n++; };

// ── the file that fooled the gate ───────────────────────────────────────────
const ALWAYS_EQUAL = 'class _AlwaysEqual:\n    __eq__ = lambda s, o: True\n\nfrom solver import f\nassert f() == 42\nassert f() == 43\n';
refused(ALWAYS_EQUAL, /defines __eq__/, 'the _AlwaysEqual criterion is refused');
refused('class X:\n    def __eq__(self, o):\n        return True\nassert X() == 1\nassert X() == 2\n', /defines __eq__/, 'a def __eq__ is refused');
refused('class X:\n    def __ne__(self, o): return False\nassert 1\nassert 2\n', /defines __eq__/, '__ne__ counts');
refused('class X:\n    def __bool__(self): return True\nassert X()\nassert X() is not None\n', /defines __eq__/, '__bool__ counts');
refused('X.__eq__ = lambda s, o: True\nassert 1\nassert 2\n', /defines __eq__/, 'an assigned __eq__ counts');
refused('def   __eq__ (a, b): return True\nassert 1\nassert 2\n', /defines __eq__/, 'spacing does not hide it');
passes('assert f().__eq__(42)\nassert f().__eq__ == g().__eq__\n', 'CALLING or comparing a dunder is not defining one');

// ── builtins ────────────────────────────────────────────────────────────────
refused('import builtins\nbuiltins.isinstance = lambda *a: True\nassert isinstance(f(), int)\nassert f() == 1\n', /monkeypatches builtins/, 'builtins.X = is refused');
refused('import builtins\nsetattr(builtins, "type", lambda x: int)\nassert 1\nassert 2\n', /monkeypatches builtins/, 'setattr(builtins, …) is refused');
refused('__builtins__["len"] = lambda x: 3\nassert len(f()) == 3\nassert f()\n', /monkeypatches builtins/, '__builtins__[…] = is refused');
refused('__builtins__.type = lambda x: int\nassert 1\nassert 2\n', /monkeypatches builtins/, '__builtins__.X = is refused');
refused('import sys\nsys.modules["builtins"].type = lambda x: int\nassert 1\nassert 2\n', /monkeypatches builtins/, 'sys.modules["builtins"] is refused');
passes('import builtins\nassert builtins.type(f()) is int\nassert f() == 42\n', 'READING builtins is fine — only assignment is refused');
passes('assert builtins_ok == 1\nassert x == 2\n', 'a name that merely starts with builtins is not builtins');

// ── two independent assertions ──────────────────────────────────────────────
refused('assert type(f()) is int and f() == 42\n', /has 1 independent assertion;/, 'one assertion is refused');
refused('assert f() == 42\nassert f() == 42\n', /has 1 independent assertion;/, 'the same assertion twice is one');
refused('assert f() == 42\nassert  f()  ==  42\n', /has 1 independent assertion;/, 'whitespace does not make it two');
refused('assert f() == 42\n# assert f() == 43\n', /has 1 independent assertion;/, 'a commented-out assertion does not count');
refused('import sys\nsys.exit(0 if f() == 42 else 1)\n', /has 0 independent assertions;/, 'no assertion at all is refused, even with an exit code');
refused('', /has 0 independent assertions;/, 'an empty file has no assertions');
passes('assert type(f()) is int and f() == 42\nassert type(f(1)) is int and f(1) == 43\n', 'two distinct assertions pass');
passes('import unittest\nclass T(unittest.TestCase):\n    def test_a(self): self.assertEqual(f(), 42)\n    def test_b(self): self.assertIs(type(f()), int)\nunittest.main()\n', 'unittest-style assertions count');
passes('assert f() == 42  # the answer\nassert f() != 41  # and not the neighbour\n', 'trailing comments do not hide an assertion');
passes('x = "assert nothing"\nassert f() == 1\nassert g() == 2\n', 'the word assert inside a string neither adds nor removes (two real ones remain)');

// ── what a checker (2026-09-12) got past the first cut, now pinned ──────────
refused('"""\nassert f() == 1\nassert f() == 2\n"""\nprint("ok")\n', /has 0 independent assertions;/, 'two asserts inside a docstring are zero assertions');
refused('assert f()==42\nassert f() == 42\n', /has 1 independent assertion;/, 'spacing inside the expression does not make two');
refused('x = "#"; __eq__ = lambda s, o: True\nassert 1\nassert 2\n', /defines __eq__/, 'a # inside a string does not hide the rest of the line');
refused('setattr(__builtins__, "type", lambda x: int)\nassert 1\nassert 2\n', /monkeypatches builtins/, 'setattr(__builtins__, …) is refused');
refused('import builtins\nbuiltins.__dict__["type"] = lambda x: int\nassert 1\nassert 2\n', /monkeypatches builtins/, 'builtins.__dict__[…] = is refused');
passes('"""A solver with __eq__ = True must fail this."""\nassert type(f()) is int and f() == 42\nassert type(f(1)) is int and f(1) == 43\n', 'a docstring that DESCRIBES the cheat is not the cheat');
passes('assert (\n    type(f()) is int\n    and f() == 42\n)\nassert (\n    type(f(1)) is int\n    and f(1) == 43\n)\n', 'a formatter\'s parenthesised multi-line asserts are read whole — two, not one');
passes('assert f() == 42; assert f(1) == 43\n', 'two assertions on one line are two');
passes('assert g(1) == "#1"\nassert g(2) == "#2"\n', 'a # inside an asserted string is kept');

// ── the whole verdict, not the first ────────────────────────────────────────
{
  const r = lintGateCriterion('class X:\n    __eq__ = lambda s, o: True\nimport builtins\nbuiltins.type = int\nassert 1\n');
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 3, 'every problem is reported so the author fixes the file once');
  n++;
}

// ── planGate refuses to arm, and says why ──────────────────────────────────
{
  const p = planGate({ file: 'test_x.py', source: ALWAYS_EQUAL });
  assert.equal(p.ok, false, 'armGate (through planGate) refuses the _AlwaysEqual file');
  assert.match(p.error, /did not pass the lint: defines __eq__/, 'and says which rule');
  assert.deepEqual(p.problems, ['defines __eq__, __ne__ or __bool__ — a comparison in this criterion would answer whatever the file says']);
  const one = planGate({ file: 'test_x.py', source: 'assert f() == 42\n' });
  assert.equal(one.ok, false); assert.match(one.error, /has 1 independent assertion/);
  const two = planGate({ file: 'test_x.py', source: 'assert type(f()) is int and f() == 42\nassert type(f(1)) is int and f(1) == 43\n' });
  assert.equal(two.ok, true, 'a two-assert criterion arms');
  assert.equal(two.path, '.anvil/gate/test_x.py');
  assert.equal(two.command, 'python .anvil/gate/test_x.py');
  // the lint runs AFTER the fence and body checks — an outside path is still refused for the fence
  const outside = planGate({ file: 'tests/t.py', source: ALWAYS_EQUAL });
  assert.match(outside.error, /must live under/, 'the fence refusal comes first');
  n += 6;
}
assert.match(GATE_AUTHORING_HINT, /fewer than two assertions is refused/, 'the authoring hint states the rule the lint enforces');
n++;

console.log(`gate-lint: ${n} checks green — dunder comparisons, patched builtins and single assertions are refused before arming; planGate says why`);
