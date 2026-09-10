// AC-7 — a typed gate on a TRANSITION, and authorization bound to trusted evidence.
//
// Anvil's must-pass gate answers one question about a whole task: did it pass? That is a single
// gate with its type implicit. What it cannot express is "this particular action needs an answer
// before it may happen, and here is which answer".
//
// The shape is adopted rather than invented. AC-0 (plan/research-harness-state-2026-09-10.md) found
// Codex, Claude Code and Hermes converging on the same one, and Codex's is the fullest: a guardian
// judges ONE PLANNED ACTION and returns a typed verdict over two graded axes, resolved through a
// published threshold table with a tier nothing lifts. Three properties came with it and all three
// are load-bearing:
//
//   · THE VERDICT NAMES ITS AXES. "Denied" is not a verdict. `high` risk against `low`
//     authorization is one, because a person can act on it.
//   · AUTHORIZATION COMES ONLY FROM TRUSTED EVIDENCE. Tool output, file contents and the model's
//     own prose can supply implementation detail for an authorized task; they can never widen
//     scope. Anvil already draws this exact line — B3 tags coordination messages so they cannot
//     read as the owner's instruction — so this reuses that boundary instead of inventing one.
//   · PRIOR DECISIONS ARE CONTEXT, NOT PRECEDENT. `decideAction` is a pure function of (risk,
//     authorization). It has no memory, and there is a test that it cannot acquire one: a gate
//     that accretes its own past approvals into law is a gate that erodes.
//
// WHAT THIS IS NOT. It is not the fence. The fence is the GRANT — `readOnlyPrefixes` refusing on
// the normalised path, every spelling and `..` included. String-matching a shell command line is
// not security and must never be treated as any; a `shell` classification here is ADVISORY, it
// explains a refusal and raises a question, and it is deliberately incapable of granting anything
// the grant would refuse. Classification can only ever make Anvil ask MORE, never less.

export const RISK = Object.freeze(['low', 'medium', 'high', 'critical']);
export const AUTHORIZATION = Object.freeze(['unknown', 'low', 'medium', 'high']);
const authRank = (a) => Math.max(0, AUTHORIZATION.indexOf(a));

// Actions that change the world outside the workspace, or destroy history inside it. `critical`
// is reserved for what cannot be undone by a revert and is not the point of a coding agent.
// `topic` is what the owner would have to have NAMED for this to count as explicitly asked for.
// It is how the gate checks scope without the caller having to know what the action was.
const RULES = [
  { risk: 'critical', why: 'rewrites or destroys history that cannot be recovered from the workspace', topic: ['force push', 'push --force', '--force', 'reset --hard', 'rm -rf'],
    tool: /^(shell|bash|sh)$/i, cmd: /(^|[\s;&|(])(git\s+push\s+.*--force|git\s+reset\s+--hard|rm\s+-rf\s+\/(\s|$)|shutdown|mkfs)/ },
  { risk: 'high', why: 'sends data outside this device', topic: ['push', 'curl', 'wget', 'scp', 'rsync', 'ssh', 'upload'],
    tool: /^(shell|bash|sh)$/i, cmd: /(^|[\s;&|(])(git\s+push|curl|wget|scp|rsync|ssh|nc)\b/ },
  { risk: 'high', why: 'sends data outside this device', topic: ['fetch', 'download', 'http', 'network'], tool: /^(fetch|net|http|egress)$/i },
  { risk: 'medium', why: 'removes files from the workspace', topic: ['delete', 'remove', 'rm'],
    tool: /^(shell|bash|sh)$/i, cmd: /(^|[\s;&|(])(rm|rmdir)\b/ },
  { risk: 'medium', why: 'removes or moves files in the workspace', topic: ['delete', 'remove', 'move', 'rename'], tool: /^(remove|move|delete)$/i },
  { risk: 'medium', why: 'commits to the repository', topic: ['commit'],
    tool: /^(shell|bash|sh)$/i, cmd: /(^|[\s;&|(])git\s+commit\b/ },
];

/**
 * How risky is this planned action? Pure, and deliberately conservative in one direction only:
 * an unmatched action is `low`, because this is not the fence and must not become a second one
 * that quietly diverges from the grant.
 */
export function classifyAction(toolName, args = {}, { rules = RULES } = {}) {
  const name = String(toolName || '');
  const cmd = typeof args?.command === 'string' ? args.command : '';
  for (const r of rules) {
    if (r.tool && !r.tool.test(name)) continue;
    if (r.cmd && !r.cmd.test(cmd)) continue;
    return { risk: r.risk, why: r.why, topic: r.topic || [] };
  }
  return { risk: 'low', why: '', topic: [] };
}

/**
 * What has the OWNER actually authorized, judged only from evidence that can carry authority?
 *
 * Trusted: the owner's own turns. Untrusted, and never counted: assistant prose, tool results,
 * file contents, and `[coordination]` messages — which are injected by the loop itself (gate
 * verdicts, nudges, hooks) and are tagged precisely so they cannot be mistaken for the owner (B3).
 *
 * THE LEVELS ARE DELIBERATELY MEAN. A first cut returned `medium` for any owner turn at all, which
 * — against a table where high-risk needs ≥ medium — meant every run with a prompt authorized every
 * egress in it. That is the opposite of the rule being adopted: untrusted content may supply
 * implementation detail, it may not widen scope, and neither may a vague task. So:
 *
 *   unknown — the owner said nothing in this run (a resumed or automated run)
 *   low     — the owner gave a task, but never named this kind of action
 *   high    — the owner named it in their own words
 *
 * `medium` is a valid input to the table and is never PRODUCED here. That is not an oversight: it
 * is the rung a future explicit confirmation prompt would return, and leaving it unreachable by
 * inference means nothing can drift into it by accident.
 */
export function authorizationFrom(messages, { topic = [] } = {}) {
  const owner = (Array.isArray(messages) ? messages : []).filter(
    (m) => m && m.role === 'user' && typeof m.content === 'string' && !/^\s*\[coordination\]/.test(m.content),
  );
  if (!owner.length) return { level: 'unknown', evidence: 'the owner has said nothing in this run' };
  const topics = (Array.isArray(topic) ? topic : [topic]).filter(Boolean).map((x) => String(x).toLowerCase());
  for (const m of owner) {
    const said = m.content.toLowerCase();
    const hit = topics.find((x) => said.includes(x));
    if (hit) return { level: 'high', evidence: `the owner asked for this in their own words ("${hit}"): "${m.content.slice(0, 80)}"` };
  }
  return { level: 'low', evidence: `the owner set this run's task but never mentioned it: "${owner[0].content.slice(0, 80)}"` };
}

/**
 * The published threshold table. Deliberately small enough to state in a sentence, because a
 * policy nobody can hold in their head is a policy nobody can check.
 *
 *   low, medium  → allow
 *   high         → allow only when authorization is at least medium
 *   critical     → deny, and nothing lifts it
 *
 * Pure in (risk, authorization). No history, no accretion, no precedent.
 */
export function decideAction({ risk = 'low', authorization = 'unknown', why = '', evidence = '' } = {}) {
  const r = RISK.includes(risk) ? risk : 'low';
  const a = AUTHORIZATION.includes(authorization) ? authorization : 'unknown';
  const base = { risk: r, authorization: a, why, evidence };
  if (r === 'critical') {
    return { ...base, outcome: 'deny', liftable: false,
      rationale: `Refused: this ${why || 'action'} is not something an agent may do here, whatever it was asked. Do it yourself if you mean it.` };
  }
  if (r === 'high') {
    if (authRank(a) >= authRank('medium')) {
      return { ...base, outcome: 'allow', liftable: true, rationale: `Allowed: ${why}, and ${evidence}.` };
    }
    return { ...base, outcome: 'deny', liftable: true,
      rationale: `Refused: this ${why || 'action'}, and ${evidence || 'nothing in this run shows the owner asked for it'}. Say explicitly that you want it and run again.` };
  }
  return { ...base, outcome: 'allow', liftable: true, rationale: '' };
}

/** The whole gate for one planned action. This is the only entry point a caller needs. */
export function gateAction(toolName, args, messages, opts = {}) {
  const { risk, why, topic } = classifyAction(toolName, args, opts);
  // Only ask about the owner's words when there is something to ask about. A `low` action is
  // allowed regardless, and scanning the transcript for it would be pure cost.
  if (risk === 'low') return decideAction({ risk, why });
  const { level, evidence } = authorizationFrom(messages, { topic });
  return decideAction({ risk, authorization: level, why, evidence });
}

/** The event a decision writes to the ledger, so a refusal is replayable rather than a memory. */
export function gateEvent(toolName, verdict) {
  return {
    tool: String(toolName || ''),
    risk: verdict.risk,
    authorization: verdict.authorization,
    outcome: verdict.outcome,
    rationale: verdict.rationale,
  };
}
