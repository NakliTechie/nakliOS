// gate — the acceptance criterion is AUTHORITY, not content.
//
// `makeShellVerifier` (agent-tools.mjs) runs an operator-fixed command in a fresh shell and
// its exit code is what turns a run's status from `unclaimed` into `done`. That is only worth
// anything if the thing the command measures is out of the agent's reach. A gate of
// `python .anvil/gate/test_fib.py` where the agent may edit `test_fib.py` is not a gate: the
// cheapest way to make it exit 0 is to weaken the assertion, and an agent optimising for the
// verdict will find that before it finds the fix. Such a gate can only ever report green.
//
// The rule this repo already wrote down (plan/history.md, 2026-09-03): a human authors the
// acceptance criterion, the agent is forbidden to edit it, and its failing output is committed
// verbatim. GATE_DIR is where that criterion lives, and the fence is what makes "forbidden"
// mean something.
//
// The BOUNDARY is not here. It is the grant: the app hands the agent face GATE_DIR as a
// readOnlyPrefix, so the check runs on the NORMALISED path — after the shell has resolved `..`,
// expanded variables, applied `cd`, and mapped `rm`/`mv` onto `fs.remove`/`fs.move`, and equally
// on the structured file tools, which reach fileops through the same face. One check covers
// every route. A string match on the command line cannot: that was tried for the skills fence
// and a cross-family review found it both leaky and over-eager (sys/ai/skills.mjs).
//
// READABLE and unwritable. The agent is aimed at this criterion, so it must be able to read it —
// a fence that hides the test turns the task into a guessing game, and hidden gates get switched
// off. Unlike the skills dir there is no agent-facing door at all: `skill_manage` exists because
// a skill is something the agent may propose, whereas the standard it is judged by is the
// owner's alone. The owner writes it through the app's own ungranted `fs`, outside this grant.
//
// What lives here is the CONSTANT and the EXPLANATION. The explanation fires only on a refusal
// that already happened, so it can never itself refuse legitimate work.

// ── How to author a criterion ──────────────────────────────────────────────────────────────
//
// The fence stops the agent editing the standard. It does NOT stop the agent satisfying a weak
// standard through the code path, and this is not hypothetical: on 2026-09-10 a run was given a
// deliberately unsatisfiable gate asserting `v == 42` AND `v == 43`. The fence held — the gate
// file was untouched — and the agent passed it anyway by returning
// `class _AlwaysEqual: __eq__ = lambda s, o: True`. Real exit 0, real verify.passed, status done.
//
// So a green gate certifies that an operator-fixed command exited 0. It does not certify that
// the task was accomplished. The 2026-09-03 rule (a human authors the criterion) is necessary and
// not sufficient — the criterion must also be authored ADVERSARIALLY:
//
//   1. Assert the TYPE as well as the value. `assert v == 42` is satisfied by anything whose
//      __eq__ says so; `assert type(v) is int and v == 42` is not. Same for str, list, dict.
//   2. Prefer values the agent cannot alias. Identity (`is`), lengths, sums over a collection,
//      and round-trips through serialisation are harder to fake than a single ==.
//   3. Check the SHAPE of the work, not only the answer — that the function exists, is callable,
//      takes the arity you meant, and fails on input it should reject. A solution that only ever
//      returns the expected constant should not pass.
//   4. Test more than one case, and include a case the naive cheat gets wrong. One assertion is
//      one thing to special-case.
//   5. Never import the agent's module and trust its objects to answer questions about
//      themselves. Compare against literals you wrote.
//
// Reviewing what a gate actually proves is part of reading the result: do not quote a gated run
// as quality evidence without reading the criterion it passed.
//
// The gate's `python` also runs on a RESET interpreter (kilnIsolate, sys/kiln/main-thread-runtime.mjs),
// because Anvil memoizes one Pyodide and the agent's python would otherwise share it — the gate
// could import a module the agent cached before editing its file, or one it pre-seeded outright.

// A short form of the rule above, for the one place a human actually authors a gate.
export const GATE_AUTHORING_HINT =
  'Assert the type as well as the value — `assert type(v) is int and v == 42`, not `assert v == 42`. ' +
  'A bare == is satisfied by any object whose __eq__ says so. Test more than one case. ' +
  'A criterion that defines __eq__/__ne__/__bool__, patches builtins, or has fewer than two assertions is refused.';

// ── The lint (N2, 2026-09-12) ──────────────────────────────────────────────────────────────
// The hint above is advice; this is the part of it a machine can check before a criterion is
// armed. It is a LINT — a criterion can still be weak — but it refuses the three shapes a
// criterion file can carry that make its own verdict meaningless: an `__eq__`/`__ne__`/`__bool__`
// defined in the criterion itself (so a comparison answers whatever the file says), `builtins`
// monkeypatched (so `assert`, `isinstance`, `type` mean something else), and fewer than two
// independent assertions (one assertion is one thing to special-case). Pure; returns every
// problem, not the first, so an author fixes the file once.
//
// What it does NOT reach, said plainly: the 2026-09-10 incident put `__eq__` in the SOLVER, not
// the criterion, and no lint over the criterion sees the solver. Against that the defence is the
// authoring rule above — assert the type, not only the value — which a checker (2026-09-12)
// confirmed the three rules here do not enforce. Syntactic evasions of a regex lint (an aliased
// `import builtins as b`, `setattr(X, "__eq__", …)`, `exec` of a built string) get through and
// are not worth chasing: an owner who writes those is not the population this guards.
const DUNDER_RE = /(?:^|[^\w])(?:def\s+__(?:eq|ne|bool)__\s*\(|__(?:eq|ne|bool)__\s*=(?!=))/;
const BUILTINS_RE = /(?:^|[^\w])(?:builtins\s*\.\s*(?:\w+\s*=(?!=)|__dict__\s*\[)|setattr\s*\(\s*(?:__builtins__|builtins)\b|__builtins__\s*(?:\.\s*\w+\s*=(?!=)|\[[^\]]*\]\s*=(?!=))|(?:sys\.modules\s*\[\s*['"]builtins['"]\s*\]))/;
const ASSERT_RE = /(?:^|[^\w.])assert\b|\.\s*assert\w+\s*\(/;

// A line without its trailing comment — cut at the first `#` that is outside a string, so a
// `#` inside a string literal neither truncates the code after it nor hides it.
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

export function lintGateCriterion(text) {
  const src = String(text == null ? '' : text);
  const problems = [];
  // Neither comments nor docstrings count for or against: a docstring that DESCRIBES the
  // `__eq__ = True` cheat is not the cheat, and two asserts quoted inside one are not assertions.
  const lines = src.replace(/("""|''')[\s\S]*?\1/g, '').split('\n').map(stripComment);
  const code = lines.join('\n');
  if (DUNDER_RE.test(code)) problems.push('defines __eq__, __ne__ or __bool__ — a comparison in this criterion would answer whatever the file says');
  if (BUILTINS_RE.test(code)) problems.push('monkeypatches builtins — assert, isinstance and type would mean something else');
  // Independent = distinct STATEMENTS with all whitespace removed: the same assertion pasted
  // twice, or spaced differently, is one thing to special-case. A statement continues across
  // lines while its brackets are open, so a formatter's `assert (\n …\n)` is read whole.
  // Two statements on one line (`assert a; assert b`) are two lines here; a `;` inside a
  // string is left alone.
  const stmts = lines.flatMap((l) => (/['"]/.test(l) ? [l] : l.split(';')));
  const asserts = new Set();
  for (let i = 0; i < stmts.length; i++) {
    if (!ASSERT_RE.test(stmts[i])) continue;
    let stmt = stmts[i], depth = 0;
    for (let j = i; j < stmts.length; j++) {
      if (j > i) stmt += '\n' + stmts[j];
      for (const c of stmts[j]) { if (c === '(' || c === '[' || c === '{') depth++; else if (c === ')' || c === ']' || c === '}') depth--; }
      if (depth <= 0) { i = j; break; }
    }
    asserts.add(stmt.replace(/\s+/g, ''));
  }
  if (asserts.size < 2) problems.push(`has ${asserts.size} independent assertion${asserts.size === 1 ? '' : 's'}; a criterion needs at least two (one assertion is one thing to special-case)`);
  return { ok: problems.length === 0, problems };
}

export const GATE_DIR = '.anvil/gate';

export function underGateDir(path) {
  const p = String(path == null ? '' : path).trim().replace(/^["']|["']$/g, '');
  if (!p) return false;
  const norm = p.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
  const want = GATE_DIR.split('/');
  const got = norm.split('/');
  if (got.length < want.length) return false;
  return want.every((seg, i) => got[i] === seg);
}

// One call that arms a run, because arming it in two was the way to get it half-done: a
// criterion written with no gate set is a file nobody runs, and a gate set with no criterion
// written is a command that cannot pass. Both leave a run that LOOKS gated and grades itself.
//
// Returns a plan, not an effect — the caller owns the owner-door write and the task field, so
// this stays pure and testable. Refuses a criterion outside GATE_DIR: a gate the agent can edit
// is not a gate, and the fence only covers this directory.
export function planGate({ file, source, command } = {}) {
  const name = String(file == null ? '' : file).trim();
  if (!name) return { ok: false, error: 'a criterion needs a file name' };
  const path = name.includes('/') ? name.replace(/^\.?\//, '') : `${GATE_DIR}/${name}`;
  if (!underGateDir(path)) {
    return { ok: false, error: `a criterion must live under ${GATE_DIR}/ — the fence covers nothing else (got ${path})` };
  }
  if (typeof source !== 'string' || !source.trim()) {
    return { ok: false, error: 'a criterion needs a body; an empty file exits 0 and passes everything' };
  }
  const lint = lintGateCriterion(source);
  if (!lint.ok) {
    return { ok: false, error: `the criterion did not pass the lint: ${lint.problems.join('; ')}`, problems: lint.problems };
  }
  const cmd = String(command == null ? '' : command).trim() || `python ${path}`;
  // The command has to actually mention the criterion, or the gate measures something else and
  // the file is decoration. Checked on the normalised path, not the raw spelling.
  if (!cmd.includes(path)) {
    return { ok: false, error: `the gate command must run the criterion: ${cmd} does not mention ${path}` };
  }
  return { ok: true, path, source, command: cmd };
}

// The grant's read-only refusal, as the face words it.
const READ_ONLY_RE = /path is read-only under this grant:\s*(\S+)/;

// Given a tool result, return it with the gate-fence explanation appended — or unchanged when
// the result is not a gate-dir read-only refusal. Pure, and never changes a success.
export function explainGateRefusal(result) {
  const text = String(result == null ? '' : result);
  const m = text.match(READ_ONLY_RE);
  if (!m || !underGateDir(m[1])) return text;
  return text + `\n\n${GATE_DIR}/ is readable but not writable: it holds the acceptance criterion this task is judged by, and only the owner writes it. Read it as often as you like and change the CODE until it passes — editing the standard is not a way to pass it.`;
}
