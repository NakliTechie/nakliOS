// Supervisor + parallel subagents — the "Polly" pattern for Anvil. The main
// agent acts as a supervisor: it fans work out to several subagents that run
// CONCURRENTLY, each isolated in its own copy-on-write overlay of the workspace
// (see rig/fileops/overlay-backend.mjs), then it reviews and merges the results.
// This module is the PURE half — tool schemas, task validation, conflict
// detection, the merge policy, and digest formatting. The app supplies the
// isolation factory (spawnIsolated) and the inference function; agent-tools.mjs
// wires the two together in the `dispatch` / `review` tool handlers.
//
// Layer-1 merge policy (conservative + honest): after all subagents finish,
// their changesets are merged onto the real workspace ONLY when no two subagents
// touched the same path. On any cross-subagent conflict, NOTHING is applied and
// the conflict is reported so the supervisor decides (re-run sequentially, pick
// one, or split the work). Isolated parallel WRITERS are supported; automatic
// conflicting-write resolution is deliberately left to the supervisor.

export const DISPATCH_MAX = 4;        // max subagents per dispatch (bounds host-AI load)
export const SUBAGENT_MAX_STEPS = 20; // per-subagent step budget

export const SUBAGENT_SYSTEM =
  'You are a subagent working in an ISOLATED copy of the shared workspace — your ' +
  'file changes are private until the supervisor merges them, so work freely. You ' +
  'have the full coding toolset (read, write, edit, apply_patch, shell, todowrite). ' +
  'Do exactly the task you were given, keep your edits tightly scoped to it, and ' +
  'finish with a concise report of what you changed (files touched) or found. Do not ' +
  'ask questions — decide and act.';

export const REVIEW_SYSTEM =
  'You are a code reviewer with READ-ONLY access to the workspace (read, read_lines, ' +
  'shell for inspection, todowrite). Review the changes or files described in your ' +
  'task. Report concrete, actionable findings only: correctness bugs, security issues, ' +
  'missed edge cases, and clear regressions — each as "file:line — problem". If the ' +
  'work is sound, say so plainly and briefly. Do not restate the code or praise it. Do ' +
  'not modify anything.\n' +
  'If a project memory exists (.anvil/memory/*.md), also check it against the current ' +
  'code: name any fact the code now CONTRADICTS as "stale memory: <fact-name> — why", ' +
  'so it can be retracted. You cannot write; just flag them.';

export function dispatchTool() {
  return { type: 'function', function: {
    name: 'dispatch',
    description:
      'Delegate to several subagents that run IN PARALLEL, each in an isolated copy of ' +
      'the workspace with the full toolset. Use it to fan out independent work — one ' +
      'subagent per file/module/angle. Each returns a concise report; their file ' +
      'changes are merged back automatically when no two touched the same path (any ' +
      'conflict is reported for you to resolve). Keep sub-tasks INDEPENDENT; run at ' +
      'most ' + DISPATCH_MAX + ' at once. For a single bounded sub-task use `task`; for ' +
      'critique use `review`.',
    parameters: { type: 'object', properties: {
      tasks: { type: 'array', description: 'The independent sub-tasks to run in parallel (max ' + DISPATCH_MAX + ').',
        items: { type: 'object', properties: {
          description: { type: 'string', description: 'A 3–5 word label.' },
          prompt: { type: 'string', description: 'The full, self-contained task for this subagent.' },
        }, required: ['prompt'] } },
    }, required: ['tasks'] },
  } };
}

export function reviewTool() {
  return { type: 'function', function: {
    name: 'review',
    description:
      'Spawn a read-only reviewer subagent over the current workspace and get back ' +
      'concrete findings (bugs, security issues, missed edge cases). Use it after a ' +
      'change to get an independent second opinion before you declare done. The ' +
      'reviewer cannot modify anything.',
    parameters: { type: 'object', properties: {
      prompt: { type: 'string', description: 'What to review and what to look for. Name the files/changes.' },
    }, required: ['prompt'] },
  } };
}

// Validate + normalize the tasks array. Drops empty prompts; caps at DISPATCH_MAX
// (reporting the overflow rather than silently truncating). label defaults from
// the prompt so every result is identifiable.
export function normalizeTasks(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: 'tasks must be an array of { prompt } objects.', tasks: [], dropped: 0 };
  const cleaned = [];
  let droppedEmpty = 0;
  for (const t of raw) {
    const prompt = String((t && t.prompt) || '').trim();
    if (!prompt) { droppedEmpty++; continue; }
    const label = String((t && t.description) || '').trim() || firstWords(prompt, 5);
    cleaned.push({ label, prompt });
  }
  if (!cleaned.length) return { ok: false, error: 'No non-empty sub-tasks provided.', tasks: [], dropped: droppedEmpty };
  const overflow = Math.max(0, cleaned.length - DISPATCH_MAX);
  return { ok: true, tasks: cleaned.slice(0, DISPATCH_MAX), dropped: droppedEmpty + overflow, overflow };
}

function firstWords(s, n) {
  const w = String(s).trim().split(/\s+/).slice(0, n).join(' ');
  return w.length > 48 ? w.slice(0, 48) + '…' : w;
}

// Cross-subagent conflict detection. `changesets` is an array aligned to the
// tasks: each is { written:[path…], deleted:[path…] } (an OverlayBackend.changes()).
// A path is a conflict when it appears in the change set of more than one
// subagent (write/write, write/delete, or delete/delete all count).
export function detectConflicts(changesets) {
  const owners = new Map(); // path -> Set(agentIndex)
  changesets.forEach((ch, i) => {
    if (!ch) return;
    for (const p of [...(ch.written || []), ...(ch.deleted || [])]) {
      if (!owners.has(p)) owners.set(p, new Set());
      owners.get(p).add(i);
    }
  });
  const conflicts = [];
  for (const [path, set] of owners) {
    if (set.size > 1) conflicts.push({ path, agents: [...set].sort((a, b) => a - b) });
  }
  conflicts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return conflicts;
}

// The merge decision (batch form, kept for the pure conflict tests). Layer-1
// policy: apply every subagent's changeset iff there are no cross-subagent
// conflicts; otherwise apply none. Returns { apply:[agentIndex…], conflicts }.
export function mergeDecision(changesets) {
  const conflicts = detectConflicts(changesets);
  if (conflicts.length) return { apply: [], conflicts };
  const apply = [];
  changesets.forEach((ch, i) => { if (ch && ((ch.written || []).length || (ch.deleted || []).length)) apply.push(i); });
  return { apply, conflicts: [] };
}

// planMerge — the per-run merge plan the `dispatch` handler uses. Unlike
// mergeDecision it is CLEAN-STOP AWARE and conflict-ISOLATED:
//   • A run merges only if it finished CLEANLY (ok === true, i.e. stop 'done').
//     A run that errored, hit max-steps, or got stuck ('incomplete') is HELD —
//     its partial writes are never committed to the real workspace (fixes the
//     "half-done edit silently merged" hazard).
//   • A path clash HOLDS only the clashing runs, not the whole batch — a clean
//     subagent that touched a disjoint path still applies.
// `runs` is [{ ok, changes:{written,deleted} }]. Returns { status[], apply[],
// conflicts[] } where status[i] ∈ merge | conflict | incomplete | no-op | error.
//
// Layer-1 limitations (documented, not bugs — a tree-aware Layer 2 would close
// them): conflict detection is PATH-LEVEL, so a wholesale directory delete by
// one subagent and a new file added under that directory by another are NOT seen
// as conflicting (each touches different exact paths). And a subagent that
// rewrites a file with identical bytes still counts as "touching" it, so it can
// force a spurious hold. Both fail safe (nothing is corrupted); neither silently
// merges a wrong result.
export function planMerge(runs) {
  const owners = new Map(); // path -> Set(agentIndex) — only among clean runs
  (runs || []).forEach((r, i) => {
    if (!r || !r.ok || !r.changes) return;
    for (const p of [...(r.changes.written || []), ...(r.changes.deleted || [])]) {
      if (!owners.has(p)) owners.set(p, new Set());
      owners.get(p).add(i);
    }
  });
  const conflicts = [];
  for (const [path, set] of owners) if (set.size > 1) conflicts.push({ path, agents: [...set].sort((a, b) => a - b) });
  conflicts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const conflicted = new Set();
  conflicts.forEach((c) => c.agents.forEach((i) => conflicted.add(i)));
  const status = (runs || []).map((r, i) => {
    if (!r) return 'error';
    if (!r.ok) return 'incomplete';
    const ch = r.changes || { written: [], deleted: [] };
    if (!((ch.written || []).length + (ch.deleted || []).length)) return 'no-op';
    return conflicted.has(i) ? 'conflict' : 'merge';
  });
  const apply = status.map((s, i) => (s === 'merge' ? i : -1)).filter((i) => i >= 0);
  return { status, apply, conflicts };
}

// Render the supervisor-facing digest of a dispatch. `results` is aligned to the
// launched tasks: { label, text, changes, stop }. `status` is the planMerge
// status per run (after commit — a merge that then failed to apply becomes
// 'merge-failed'); `conflicts` are the held clashing paths. Labels are HONEST:
// only a cleanly-finished, applied run reads "merged"; partial/errored runs are
// "held" so the supervisor never mistakes an unfinished edit for a success.
const STATUS_TAG = {
  merge: 'merged',
  conflict: 'held — path conflict',
  incomplete: 'held — subagent did not finish cleanly',
  'no-op': 'no file changes',
  error: 'ERROR — subagent failed to run',
  'merge-failed': 'merge FAILED (workspace unchanged for this one)',
  aborted: 'STOPPED — the owner ended the run while it worked; nothing merged',
};
export function formatDispatchDigest({ results, status, conflicts, dropped }) {
  const st = (i) => (status && status[i]) || (results[i] && results[i].ok ? 'no-op' : 'incomplete');
  const lines = [];
  lines.push(`Dispatched ${results.length} subagent${results.length === 1 ? '' : 's'} in parallel.`);
  if (dropped) lines.push(`(${dropped} sub-task${dropped === 1 ? '' : 's'} dropped: empty or over the ${DISPATCH_MAX}-at-once cap — re-dispatch the rest.)`);
  results.forEach((r, i) => {
    const ch = r.changes || { written: [], deleted: [] };
    const touched = [...(ch.written || []), ...(ch.deleted || [])];
    const s = st(i);
    let tag = STATUS_TAG[s] || s;
    if (s === 'incomplete' && r.stop) tag += ` (${r.stop})`;
    lines.push('');
    lines.push(`### [${i + 1}] ${r.label} — ${tag}`);
    if (touched.length) {
      const parts = [];
      if ((ch.written || []).length) parts.push('wrote ' + ch.written.join(', '));
      if ((ch.deleted || []).length) parts.push('deleted ' + ch.deleted.join(', '));
      const verb = s === 'merge' ? 'applied' : 'attempted (NOT applied)';
      lines.push(`changes ${verb}: ` + parts.join('; '));
    }
    lines.push((r.text || '(no report)').trim());
  });
  if (conflicts && conflicts.length) {
    lines.push('');
    lines.push('### ⚠ path conflicts — the clashing subagents were held (their disjoint siblings still merged)');
    for (const c of conflicts) lines.push(`- ${c.path} — touched by subagents ${c.agents.map(a => a + 1).join(' & ')}`);
    lines.push('Resolve by re-running the conflicting sub-tasks sequentially with `task`, or pick one and apply it yourself.');
  }
  return lines.join('\n');
}

// ── ESS-2: the live feed — what a parent sees WHILE a child runs ─────────────────────────
// A child's loop events are tapped (agent-tools `onSubagentEvent`) and folded into ONE row per
// child that the transcript renders in place. Pure: (row, event) → row, so the shape is
// testable without a DOM and the app only ever calls this and re-renders. The dispatch digest
// is still the tool result; this is the part that used to be silence until the digest arrived.
export function subagentFeedRow(row, ev) {
  const r = row ? { ...row } : { k: 'subagent', status: 'running', steps: 0, tools: 0, lastTool: '', lastDetail: '' };
  const e = ev || {};
  switch (e.type) {
    case 'turn-start': r.steps = Math.max(r.steps, (Number(e.step) || 0) + 1); break;
    case 'tool-call': {
      const a = e.args || {};
      r.tools += 1;
      r.lastTool = String(e.name || '');
      r.lastDetail = String(a.command || a.path || a.file || a.old_string || (a.patch ? 'patch' : '') || '').slice(0, 80);
      break;
    }
    case 'tool-error': r.lastError = String(e.error || '').slice(0, 120); break;
    case 'aborted': r.status = 'aborted'; break;
    default: break;
  }
  return r;
}

// The row's one-line summary. `stop` is the child's final stop once it reported back; until
// then the row says running and how far it got.
export function subagentFeedLine(row) {
  const r = row || {};
  const where = r.lastTool ? ` · last: ${r.lastTool}${r.lastDetail ? '(' + r.lastDetail + ')' : ''}` : '';
  if (r.status === 'running') return `${r.kind || 'task'} · ${r.label || ''} — running · step ${r.steps || 0} · ${r.tools || 0} tool call${r.tools === 1 ? '' : 's'}${where}`;
  return `${r.kind || 'task'} · ${r.label || ''} — ${r.status} (${r.steps || 0} step${r.steps === 1 ? '' : 's'}, ${r.tools || 0} tool call${r.tools === 1 ? '' : 's'})`;
}
