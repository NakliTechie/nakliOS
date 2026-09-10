// Predict-then-grade for a shell call (D3; khiladi's expect, NOOA's retrodiction). The agent
// states what it EXPECTS before running a command; the result is graded against it, and a MISS
// is a small, honest failure signal on the run record. Pure and OPTIONAL — a shell call with no
// `expect` behaves exactly as before.
//
// A three-token grammar, "<kind> <value>":
//   exit <n>        the command must exit with code n
//   contains <str>  the combined stdout/stderr must contain str
//   absent <str>    the output must NOT contain str (e.g. "absent Error")
//   output          the command must print something (no value) — the falsifiable prediction
//                   for a search or a listing, whose whole point is to produce output
export const EXPECT_KINDS = Object.freeze(['exit', 'contains', 'absent', 'output']);

// What the shell executor hands back for a command that printed nothing (agent-loop.mjs). Named
// here so the runner's grade and a post-hoc fold — which re-grades the RECORDED text, placeholder
// and all — read blankness identically.
export const NO_OUTPUT = '(no output)';
export function isBlankOutput(output) {
  const s = String(output == null ? '' : output).trim();
  return s === '' || s === NO_OUTPUT;
}

export function parseExpect(str) {
  // A prediction is ONE LINE. Interior whitespace is collapsed before anything else, because
  // the graded line echoes this value back inside the runner's own `[expect] …` message: a
  // value carrying a newline could therefore plant a second EXPECT_MARKER inside the runner's
  // text and forge the verdict a post-hoc fold reads back. Collapsing kills that at the source
  // and costs nothing — no legitimate prediction spans lines.
  const s = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const sp = s.indexOf(' ');
  const kind = (sp < 0 ? s : s.slice(0, sp)).toLowerCase();
  const value = sp < 0 ? '' : s.slice(sp + 1).trim();
  if (!EXPECT_KINDS.includes(kind)) return null;
  if (kind === 'exit') { if (value === '') return null; const n = Number(value); return Number.isInteger(n) ? { kind, value: n } : null; }
  // `output` takes no value: "output empty" would read as its own opposite, so a trailing value
  // is malformed rather than silently ignored.
  if (kind === 'output') return value === '' ? { kind, value: '' } : null;
  return value ? { kind, value } : null;
}

// A grade is { ok, why } and, for one case, { ok: true, vacuous: true, why }. VACUOUS is the
// live-found weakness (2026-09-10, qwen3:8b): a search pipeline predicted `exit 0`, printed
// nothing, exited 0, and read the MET as corroboration that it had found something. For a
// command whose purpose is to produce output, "exit 0" is satisfied just as well by "ran fine,
// found nothing" — the prediction was met and taught the agent nothing. So an `exit 0` hit on
// blank output stays a hit (the prediction was not wrong) but is marked vacuous, the feedback
// line says so, and the fold counts it as neither hit nor miss. Scoped to exit 0: predicting a
// NON-zero exit (grep's "no match" is exit 1) on a silent command is a genuine prediction.
export function gradeExpect(exp, { exitCode = null, output = '' } = {}) {
  if (!exp) return { ok: true, why: 'no expectation' };
  const out = String(output == null ? '' : output);
  if (exp.kind === 'exit') {
    const ok = exitCode != null && Number(exitCode) === exp.value;
    if (ok && exp.value === 0 && isBlankOutput(out)) {
      return { ok: true, vacuous: true, why: 'exit 0, but the command printed nothing — exit 0 does not say it found anything. '
        + 'For a search or a listing, predict "output" or "contains <text>" instead.' };
    }
    return { ok, why: ok ? `exit ${exitCode} as expected` : `expected exit ${exp.value}, got ${exitCode == null ? 'unknown' : exitCode}` };
  }
  if (exp.kind === 'contains') {
    const ok = out.includes(exp.value);
    return { ok, why: ok ? `output contains "${exp.value}"` : `expected output to contain "${exp.value}" — it did not` };
  }
  if (exp.kind === 'output') {
    const ok = !isBlankOutput(out);
    return { ok, why: ok ? 'the command printed output as expected' : 'expected output — the command printed nothing' };
  }
  // absent
  const ok = !out.includes(exp.value);
  return { ok, why: ok ? `"${exp.value}" absent as expected` : `expected "${exp.value}" to be absent — it appeared` };
}

// The line appended to a graded shell result (the agent's immediate feedback). A fixed marker
// so a post-hoc fold can split it off and never grade against its own message. The verdict word
// is one of MET / MISS / VACUOUS — the fold reads that word, so it is the whole contract.
export const EXPECT_MARKER = '\n[expect] ';
export function expectVerdict(grade) { return grade.ok ? (grade.vacuous ? 'VACUOUS' : 'MET') : 'MISS'; }
export function expectLine(exp, grade) {
  const what = exp.value === '' ? exp.kind : `${exp.kind} ${exp.value}`;
  return `${EXPECT_MARKER}${expectVerdict(grade)} (${what}) — ${grade.why}`;
}
// Recover the command's real output from a graded result — everything before the marker.
export function stripExpect(result) {
  const s = String(result == null ? '' : result);
  // lastIndexOf: the runner APPENDS its line, so the last marker is the one it wrote. indexOf
  // truncated the command's real output at any marker the output itself happened to contain,
  // which could turn a genuine MET into a MISS.
  const i = s.lastIndexOf(EXPECT_MARKER);
  return i < 0 ? s : s.slice(0, i);
}
