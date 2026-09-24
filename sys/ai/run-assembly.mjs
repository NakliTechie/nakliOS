// The run assembly — ONE source for what a run is made of, imported by the app and called by
// every node bed. Before this the beds hand-wrote the prompt, stripped the toolset, capped at 8
// steps and skipped hooks, nudge and supervisor, so each of their numbers measured a module, not
// the product (plan/bench-live-bed-2026-09-11.md). The app's behaviour is the contract: same
// prompt bytes, same tool list per mode, same budgets, same re-loops. scripts/test-run-assembly.mjs
// holds the byte-equality lane against the inline app.
import { runAgentLoop } from './agent-loop.mjs';
import { codingToolset, toolReadiness , scopeAllows, TOOL_SCOPES } from './agent-tools.mjs';
import { renderProcedural } from './procedural.mjs';
import { rememberTool } from './project-context.mjs';
import { skillTool } from './skills.mjs';
import { skillManageTool } from './skill-manage.mjs';
import { contextRemainingTool, checkpointTool } from './context-budget.mjs';
import { learnReviewTool } from './learn.mjs';
import { recallTool, reviseTool, LESSON_CONTRACT } from './memory-store.mjs';
import { HOOKS_FILE, parseHooks, preToolDecision, postToolCommands } from './hooks.mjs';
import { historyTool, foldStagnation, stagnationNudge } from '../history/run-record.mjs';

// ── the prompt ────────────────────────────────────────────────────────────────
// Head and tail are the stable halves around the procedural prior (sys/ai/procedural.mjs); the
// seams are pinned by scripts/test-anvil-procedural.mjs. The tail's path sentence is there because
// a model spent 24 steps under an invented /workspace prefix (live 2026-09-11).
export const SYSTEM_HEAD = 'You are a coding agent working over the user\'s files. Tools: read (line-numbered), write (whole file), edit (surgical old_string→new_string), apply_patch (add/update/delete files), todowrite (checklist), task (delegate one bounded sub-task to a subagent), dispatch (fan out INDEPENDENT sub-tasks to subagents that run in parallel, each in an isolated copy of the workspace — their changes merge back when they touch different files), review (an independent read-only reviewer subagent for a second opinion), shell (a CURATED bash-like shell, not coreutils: ls cat grep rg sed awk find head tail wc sort uniq cut tr test git python, with pipes, && || ; > >> < and globs. Each builtin implements a documented subset and REFUSES an unsupported flag rather than ignoring it — run `help` to see what each one supports. No loops, subshells, command substitution or heredocs; use python for scripting). ';
// The effort clause (2026-09-24): a fresh "list the files here" ran 5 steps — it answered at step 1,
// then ran find, find again, and cat on every file (the simple-task battery's first case). Nothing
// told the model a trivial ask is finished when it is answered. Run 3 of the battery (same day) left
// three habits on simple asks: re-reading a write to confirm it, a skill load first, and memory calls
// (recall/remember/revise) — each pushed by general guidance with no carve-out for a trivial ask.
export const SYSTEM_TAIL = ' Work in small, verifiable steps, and match the effort to the ask: a simple request (list files, read one, answer a question, write or edit one small thing) takes the fewest tool calls that settle it — once it is answered or done, stop; do not explore, open unrelated files or re-check beyond what the ask needs. The success line a write or edit returns is the confirmation — do not re-read the file to check it. A simple request needs no skill load and no memory call (recall, remember, revise). End with a one-line summary. Paths are relative to the workspace root, which the shell shows as / and python as /work — there is no /workspace, /home or /tmp; do not invent a prefix and do not cd first.';
export const MODE_NOTE = Object.freeze({ code:'', plan:' PLAN mode: read and think only — no writes/edits/shell; produce a concise plan.', ask:' ASK mode: read-only; answer the question, do not modify anything.' });
// The lesson-layer contract rides in the system prompt of every code-mode run (where `remember`
// exists) — the first remember of a project happens with an EMPTY memory index, so the index
// header alone could never carry it. Same constant as the tool description.
export const LESSON_NOTE = ' Memory: ' + LESSON_CONTRACT;

// Head + prior + tail, and nothing else: the system message is the CACHE PREFIX, so only stable
// text may reach it. The volatile indexes ride in a context message after the carried history.
export function systemPrompt(proceduralPrior = renderProcedural()) {
  return SYSTEM_HEAD + proceduralPrior + SYSTEM_TAIL;
}

export function systemMessage({ mode = 'code', proceduralPrior = renderProcedural(), extra = '' } = {}) {
  return { role: 'system', content: systemPrompt(proceduralPrior) + (MODE_NOTE[mode] || '') + (mode === 'code' ? LESSON_NOTE : '') + (extra || '') };
}

// The one per-run addition to the prefix: which command ends the run. Empty when there is no gate.
export function gateNote(verifyCmd) {
  const cmd = String(verifyCmd || '').trim();
  return cmd ? (' A verify gate is set: `'+cmd+'`. You are not done until it exits 0 — call task_done when you believe the work is complete and it will run.') : '';
}

// ── the toolset ───────────────────────────────────────────────────────────────
// `synthesize` is schema-only here; its executor needs a Kiln and lives with the app.
export function synthesizeTool() {
  return { type: 'function', function: { name: 'synthesize',
    description: 'Evolve a Python solve(x) for an EXAMPLE-BASED task (a puzzle defined by input→output pairs). Runs several generations of candidate programs, scoring each by how many example pairs it reproduces and repairing the best — then writes solver.py and reports the best fitness. Prefer this over writing one solver by hand when the task is defined by examples.',
    parameters: { type: 'object', properties: {
      goal: { type: 'string', description: 'One line describing the task.' },
      examples: { type: 'array', description: 'The input→output pairs: [{input, output}, …].', items: { type: 'object' } },
      popSize: { type: 'integer', description: 'Candidates per generation (default 3, max 4).' },
      maxGen: { type: 'integer', description: 'Max generations (default 3, max 4).' },
    }, required: ['goal', 'examples'] } } };
}

// The app's list, in the app's order. `remember` writes a fact file — code mode only (plan/ask
// are read-only). `skill` and `recall` are UNCONDITIONAL: gating them on whether the store had
// anything changed the tool SCHEMA block — the most expensive thing in the prompt to invalidate
// (F3). The tools answer honestly when there is nothing yet.
export function runToolsetOptions(mode = 'code', { verify = false, scopes = null } = {}) {
  const code = mode === 'code';
  return { subagents: true, supervisor: code, completion: !!verify, clarify: true, scopes }; // B3: top level may ask; B5: the grant projects the catalog
}
// A4 (osaurus B9): the readiness surface for THIS run's options — exposed / hidden (mode) / off
// (opt-in) / unavailable (the host's capability gap, named by the app) — from the same option
// object the toolset is built from, so the two cannot drift.
// The memory gate (battery 2026-09-24): on trivial asks the model kept calling recall / remember /
// revise — +1 step each — through three prompt revisions that told it not to. A prompt rule is a
// request; this is the gate. A SIMPLE ask's run is offered no memory tools at all. The memory INDEX
// still rides the context (the one-line facts are visible), and the post-run review still stages
// lessons, so nothing is lost but a step. Decided once, at run start, from the owner's ask — the
// toolset is recorded on run.started, so it never changes mid-run (the record's replay contract).
export const MEMORY_TOOLS = Object.freeze(['remember', 'recall', 'revise']);
const WORK_WORDS = /\b(fix|debug|implement|refactor|build|add|test|tests|investigate|optimi[sz]e|design|port|migrate|update|improve|why|review|audit|plan|learn|remember|recall|memory|continue|resume)\b/;
export function isSimpleAsk(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || t.length > 80 || /\n/.test(t)) return false;
  return !WORK_WORDS.test(t);
}
export function runReadiness(mode = 'code', { verify = false, scopes = null, simple = false } = {}, { unavailable = {} } = {}) {
  const rows = toolReadiness(mode, runToolsetOptions(mode, { verify, scopes }), { unavailable });
  // The tools this module adds AFTER codingToolset (memory, skills, history, checkpoint, …) are
  // derived from the toolset itself, never listed here: what this mode offers is exposed; what
  // the mode would offer but the grant cannot honour is blocked (B5); what code mode would offer
  // and this mode does not is hidden by the mode.
  const named = new Set(rows.map((r) => r.name));
  const offered = new Set(runToolset(mode, { verify, scopes, simple }).map((t) => t.function.name));
  const modeOffers = new Set(runToolset(mode, { verify }).map((t) => t.function.name)); // the mode's list before the grant
  const codeOffers = runToolset('code', { verify }).map((t) => t.function.name);
  for (const name of [...new Set([...modeOffers, ...codeOffers])]) {
    if (named.has(name)) continue;
    if (unavailable[name]) rows.push({ name, state: 'unavailable', why: String(unavailable[name]) });
    else if (offered.has(name)) rows.push({ name, state: 'exposed', why: '' });
    else if (simple && MEMORY_TOOLS.includes(name) && runToolset(mode, { verify, scopes }).some((t) => t.function.name === name)) rows.push({ name, state: 'off', why: 'not offered on a simple ask' });
    else if (modeOffers.has(name)) rows.push({ name, state: 'blocked', why: `blocked by policy — the grant lacks ${TOOL_SCOPES[name]}` });
    else rows.push({ name, state: 'hidden', why: `not in ${mode} mode` });
  }
  return rows;
}
export function runToolset(mode = 'code', { verify = false, scopes = null, simple = false } = {}) {
  const code = mode === 'code';
  const tools = codingToolset(mode, runToolsetOptions(mode, { verify, scopes }));
  if (code) tools.push(rememberTool());
  if (code) tools.push(skillManageTool());
  if (code) tools.push(synthesizeTool());
  tools.push(historyTool()); // read-only: search/read past runs, every mode
  tools.push(contextRemainingTool()); // read-only: the honest budget, every mode
  if (code) { tools.push(checkpointTool()); tools.push(learnReviewTool()); }
  tools.push(skillTool());
  tools.push(recallTool());
  if (code) tools.push(reviseTool()); // belief revision over existing facts
  return tools.filter((t) => scopeAllows(scopes, t.function.name)) // B5: the extras are projected by the grant too
    .filter((t) => !(simple && MEMORY_TOOLS.includes(t.function.name)));
}

// Tools the app hands the model that a node bed has no store or Kiln behind. A bed answers
// these with `bedStub` — an honest "nothing here" the record shows — instead of letting the
// base executor call them unknown, which would make the shared tool list look like a lie.
export const BED_UNWIRED = Object.freeze(['remember', 'skill_manage', 'synthesize', 'history', 'context_remaining', 'checkpoint', 'learn_this_run', 'skill', 'recall', 'revise']);
export function bedStub(name) {
  return '(the "' + name + '" tool has no store behind it in this bed — nothing was recorded; continue with the file tools)';
}
export function withBedStubs(executeTool) {
  return async (name, args, call) => (BED_UNWIRED.includes(name) ? bedStub(name) : executeTool(name, args, call));
}

// ── the budgets ───────────────────────────────────────────────────────────────
// Wall clock, not step count, is what ends a run on a local model. Measured 2026-09-03 against a
// local model through this loop: 3 steps consumed a 240s budget, so the agent never saw its own
// gate failure — 900s lets a slow endpoint actually reach the retry it needs. The re-loops
// (act-or-nudge, supervisor) are shorter: they are one redirect, not a second run.
export const RUN_BUDGET = Object.freeze({ maxSteps: 24, budget: Object.freeze({ tokens: 120000, wallClockMs: 900000 }), maxVerifyRounds: 3 });
export const RELOOP_BUDGET = Object.freeze({ maxSteps: 16, budget: Object.freeze({ tokens: 120000, wallClockMs: 240000 }), maxVerifyRounds: 3 });

// ── hooks ─────────────────────────────────────────────────────────────────────
// Per-project tool hooks from .anvil/hooks.json: pre-tool guards and post-tool commands.
export const EMPTY_HOOKS = Object.freeze({ preTool: [], postTool: [] });
export async function loadHooks(fs, fallback = EMPTY_HOOKS) {
  try { const r = await fs.read(HOOKS_FILE, { encoding: 'utf-8' }); if (r && r.ok) return parseHooks(r.data); } catch (_) {}
  return fallback;
}
// The guard runs BEFORE anything else the executor does, so a project rule can block every tool.
export function preHookReply(hooksCfg, name, args) {
  const dec = preToolDecision(hooksCfg, name, args);
  return dec.blocked ? '[blocked by a project hook] ' + dec.message : null;
}
// Post-tool commands run through a shell over the same workspace; their bounded output is fed
// back to the agent. Empty string when no hook matched, so the tool result stays byte-identical.
// `shellFor` is a factory: the shell is built only when a hook has a command to run.
export async function postHookNotes(hooksCfg, name, args, shellFor) {
  let extra = '';
  try {
    const cmds = postToolCommands(hooksCfg, name, args);
    if (!cmds.length) return '';
    const shell = shellFor();
    for (const cmd of cmds) {
      try { const o = await shell.feed(cmd); const out = String((o && o.output) || '').trim().slice(0, 2000); extra += '\n[hook] ' + cmd + (out ? ('\n' + out) : ' (ok)'); }
      catch (e) { extra += '\n[hook] ' + cmd + ' — error: ' + (e && e.message || e); }
    }
  } catch (_) {}
  return extra;
}
// The bed composition: guard, run, annotate. The app wires the same two primitives at its own
// two sites because its executor has layers (permission gate, store tools) between them.
export function withHooks(executeTool, { hooks = () => EMPTY_HOOKS, shellFor }) {
  return async (name, args, call) => {
    const pre = preHookReply(hooks(), name, args);
    if (pre != null) return pre;
    const res = await executeTool(name, args, call);
    const extra = await postHookNotes(hooks(), name, args, shellFor);
    return extra ? String(res == null ? '' : res) + extra : res;
  };
}

// ── the volatile context ──────────────────────────────────────────────────────
// The project notes, memory index and skills index ride AFTER the carried history as a tagged
// coordination message — never in the system prefix (F3) — so a change costs only the tail. The
// tag says it is the machine's context, not the owner's instruction: foldRecovery must not read
// it as a steer, and the action gate must not read it as authorization.
export function contextMessage(volatileCtx) {
  return { role: 'user', content: '[coordination] Working context for this run — project notes, the memory index, and the skills available. Not an instruction from the owner.\n\n' + volatileCtx };
}

// ── the re-loops ──────────────────────────────────────────────────────────────
// Act-or-nudge: a CODE-mode run that produced ONLY prose (0 tool calls) gets one firm nudge to
// actually use the tools — weak endpoints often "answer" instead of doing the work. plan/ask
// untouched.
export const ACT_NUDGE = '[coordination] You described the work but did not do it. Use the tools (write / edit / apply_patch / shell) to actually make and run the change in the workspace now, then give a one-line summary. Do not only explain.';
// A QUESTION answered in prose is not "described but not done" — it is done. Live 2026-09-24 (the
// simple-task battery): "what is 17 times 23? answer without using any tools" was answered at step 1
// ("391"), nudged, and the agent went on to write check.py and edit an unrelated notes.md (9 steps).
// The owner's newest message decides: a question, or an explicit no-tools ask, is never nudged.
export function isQuestionAsk(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  if (/\bwithout (using )?(any )?tools?\b|\bno tools\b|\bdon'?t use (any )?tools?\b/.test(t)) return true;
  // "can you fix the parser?" is a request for work, question mark or not.
  if (/^(please\b|(can|could|would|will) you\b)/.test(t)) return false;
  if (/\?\s*$/.test(t)) return true;
  return /^(what|why|how|which|who|whom|whose|when|where|explain|tell me|describe)\b/.test(t);
}
export function needsActNudge({ mode, toolCalls, stop, aborted = false, ask = '' }) {
  return mode === 'code' && toolCalls === 0 && stop === 'done' && !aborted && !isQuestionAsk(ask);
}
// The owner's newest message in a carried conversation — the last user turn that is not the
// machine's own [coordination] context.
export function ownerAsk(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string' && !/^\[coordination\]/.test(m.content)) return m.content;
  }
  return '';
}
// Supervisor: after a loop, if the RECORD shows spinning the loop's own consecutive-identical
// guard misses — the SAME call repeated non-consecutively, or gate rounds with no new file —
// inject ONE capped redirect and re-loop. Never on a run that finished 'done', and not for
// no-tools (the act-or-nudge owns that).
export function needsSupervisor({ mode, stop, aborted = false, stag, budgetAxis = null }) {
  // D1: a run that stopped on a prediction streak stopped ON PURPOSE — a re-loop would land more
  // edits on the model of the workspace the streak just showed wrong
  // DC2 checker: a run paused on a question (`clarify`) is the owner's to answer, not the supervisor's to
  // redirect; a run that ran out of TOKENS re-loops into a zero-step loop (the re-loop carries the same
  // history and the same budget), so it is not redirected either.
  return mode === 'code' && stop !== 'done' && stop !== 'expect-misses' && stop !== 'clarify' && !(stop === 'budget' && budgetAxis === 'tokens') && !aborted && !!(stag && stag.stalled && stag.signal !== 'no-tools');
}
// Every re-loop carries the SAME conversation the first loop built, unfiltered: filtering the
// context message out would drop the memory and skills index mid-run and make the second
// run.started disagree with the first.
// S3 (2026-09-24): and the SAME system head — a gated run's re-loop keeps its gate note. It used to
// send sysMsg(''), so the redirected model lost the instruction that the gate, not it, decides done
// (a pinned byte equality kept one prompt-cache hit per re-loop; the truthful bytes won). An ungated
// run's note is '' — its re-loop bytes are unchanged.
export function reloopMessages(sysMsg, convo, gate = '') { return [sysMsg(gate), ...convo]; }

// ── the driver ────────────────────────────────────────────────────────────────
// One run = the first loop, then at most one act-or-nudge, then at most one supervisor redirect.
// Every loop is recorded: rec.start before, rec.finish after, the same infer and onEvent. The
// caller owns the UI (`note`), the budget probe (`onSystemText`) and the model stamp (`model`).
export async function driveRun({
  mode = 'code', convo, sysMsg, tools, infer, executeTool, rec,
  verify = null, signal = null, onEvent = () => {}, model = () => null,
  gateNote: gate = '', note = () => {}, onSystemText = () => {}, readiness = null,
  steer = null, // B2: the run's steer queue — a child's completion lands at the parent's next turn
  compact = null, // C1: the loop's compactor after a context overflow (every loop of the run gets it)
}) {
  let toolCalls = 0;
  const onLoop = (e) => { if (e && e.type === 'tool-call') toolCalls++; onEvent(e); };
  const aborted = () => !!(signal && signal.aborted);
  const loop = async (messages, budget) => {
    onSystemText(messages[0].content); // the budget counts THIS loop's prompt
    await rec.start({ messages, tools, model: model(), readiness }); // A4: the readiness rows ride run.started when the app supplies them
    const result = await runAgentLoop({ messages, tools, infer, executeTool, ...budget, signal, verify, onEvent: onLoop, steer, compact });
    await rec.finish(result);
    return result;
  };
  // DC2 (decided 2026-09-17): a re-entered loop carries the loop's OWN conversation — every tool call,
  // result, steer and gate verdict of the loop before it — then the redirect. The lean re-send (the
  // owner's convo + a nudge) hid the first loop's history from the model and diverged from the record
  // on every request of the re-loop ("sending 2, the record reconstructs 51"): the fold expects the
  // re-entered run.started to repeat what the transcript holds. `convo` is re-seeded IN PLACE (the
  // caller holds the reference) from the loop's messages minus the system head.
  // The re-loops work on a DRIVER-LOCAL copy: the caller's `convo` (the app's `t.convo`, saved to
  // localStorage mid-run) is never inflated with a loop's whole history — the record's fold owns what
  // is carried into the next run.
  let carried = convo.slice();
  const reseed = (r) => { carried = (r.messages || []).slice(1); }; // minus the system HEAD only — a carried compaction marker is a system-role message too
  let result = await loop([sysMsg(gate), ...carried], RUN_BUDGET);
  if (needsActNudge({ mode, toolCalls, stop: result.stop, aborted: aborted(), ask: ownerAsk(convo) })) {
    note('No tools were used — nudging the agent to make the change, not just describe it.');
    reseed(result); // the loop's convo already ends with the (possibly empty) assistant turn
    carried.push({ role: 'user', content: ACT_NUDGE });
    result = await loop(reloopMessages(sysMsg, carried, gate), RELOOP_BUDGET);
  }
  const abortedAfterFirst = aborted(); // read once, as the inline app did — not again after settling
  if (mode === 'code' && result.stop !== 'done' && !abortedAfterFirst) {
    try {
      await rec.settled();
      const stag = foldStagnation(rec.events(), rec.resolve);
      if (needsSupervisor({ mode, stop: result.stop, aborted: abortedAfterFirst, stag, budgetAxis: result.budgetAxis || null })) {
        note('Supervisor: ' + stag.detail + ' — redirecting.');
        reseed(result); // the redirect lands on the whole history the model produced, not on the owner's opening alone
        carried.push({ role: 'user', content: stagnationNudge(stag) });
        result = await loop(reloopMessages(sysMsg, carried, gate), RELOOP_BUDGET);
      }
    } catch (_) {}
  }
  return result;
}
