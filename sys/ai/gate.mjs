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
