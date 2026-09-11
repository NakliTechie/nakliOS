// The run assembly — ONE source for what a run is made of, imported by the app and called by
// every node bed. Before this the beds hand-wrote the prompt, stripped the toolset, capped at 8
// steps and skipped hooks, nudge and supervisor, so each of their numbers measured a module, not
// the product (plan/bench-live-bed-2026-09-11.md). The app's behaviour is the contract: same
// prompt bytes, same tool list per mode, same budgets, same re-loops. scripts/test-run-assembly.mjs
// holds the byte-equality lane against the inline app.
import { runAgentLoop } from './agent-loop.mjs';
import { codingToolset } from './agent-tools.mjs';
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
export const SYSTEM_TAIL = ' Work in small, verifiable steps; end with a one-line summary. Paths are relative to the workspace root, which the shell shows as / and python as /work — there is no /workspace, /home or /tmp; do not invent a prefix and do not cd first.';
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
export function runToolset(mode = 'code', { verify = false } = {}) {
  const code = mode === 'code';
  const tools = codingToolset(mode, { subagents: true, supervisor: code, completion: !!verify, clarify: true }); // B3: top level may ask
  if (code) tools.push(rememberTool());
  if (code) tools.push(skillManageTool());
  if (code) tools.push(synthesizeTool());
  tools.push(historyTool()); // read-only: search/read past runs, every mode
  tools.push(contextRemainingTool()); // read-only: the honest budget, every mode
  if (code) { tools.push(checkpointTool()); tools.push(learnReviewTool()); }
  tools.push(skillTool());
  tools.push(recallTool());
  if (code) tools.push(reviseTool()); // belief revision over existing facts
  return tools;
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
export function needsActNudge({ mode, toolCalls, stop, aborted = false }) {
  return mode === 'code' && toolCalls === 0 && stop === 'done' && !aborted;
}
// Supervisor: after a loop, if the RECORD shows spinning the loop's own consecutive-identical
// guard misses — the SAME call repeated non-consecutively, or gate rounds with no new file —
// inject ONE capped redirect and re-loop. Never on a run that finished 'done', and not for
// no-tools (the act-or-nudge owns that).
export function needsSupervisor({ mode, stop, aborted = false, stag }) {
  return mode === 'code' && stop !== 'done' && !aborted && !!(stag && stag.stalled && stag.signal !== 'no-tools');
}
// Every re-loop carries the SAME conversation the first loop built, unfiltered: filtering the
// context message out would drop the memory and skills index mid-run and make the second
// run.started disagree with the first.
export function reloopMessages(sysMsg, convo) { return [sysMsg(''), ...convo]; }

// ── the driver ────────────────────────────────────────────────────────────────
// One run = the first loop, then at most one act-or-nudge, then at most one supervisor redirect.
// Every loop is recorded: rec.start before, rec.finish after, the same infer and onEvent. The
// caller owns the UI (`note`), the budget probe (`onSystemText`) and the model stamp (`model`).
export async function driveRun({
  mode = 'code', convo, sysMsg, tools, infer, executeTool, rec,
  verify = null, signal = null, onEvent = () => {}, model = () => null,
  gateNote: gate = '', note = () => {}, onSystemText = () => {},
}) {
  let toolCalls = 0;
  const onLoop = (e) => { if (e && e.type === 'tool-call') toolCalls++; onEvent(e); };
  const aborted = () => !!(signal && signal.aborted);
  const loop = async (messages, budget) => {
    onSystemText(messages[0].content); // the budget counts THIS loop's prompt
    await rec.start({ messages, tools, model: model() });
    const result = await runAgentLoop({ messages, tools, infer, executeTool, ...budget, signal, verify, onEvent: onLoop });
    await rec.finish(result);
    return result;
  };
  let result = await loop([sysMsg(gate), ...convo], RUN_BUDGET);
  if (needsActNudge({ mode, toolCalls, stop: result.stop, aborted: aborted() })) {
    note('No tools were used — nudging the agent to make the change, not just describe it.');
    if (result.text) convo.push({ role: 'assistant', content: result.text });
    convo.push({ role: 'user', content: ACT_NUDGE });
    result = await loop(reloopMessages(sysMsg, convo), RELOOP_BUDGET);
  }
  const abortedAfterFirst = aborted(); // read once, as the inline app did — not again after settling
  if (mode === 'code' && result.stop !== 'done' && !abortedAfterFirst) {
    try {
      await rec.settled();
      const stag = foldStagnation(rec.events(), rec.resolve);
      if (needsSupervisor({ mode, stop: result.stop, aborted: abortedAfterFirst, stag })) {
        note('Supervisor: ' + stag.detail + ' — redirecting.');
        convo.push({ role: 'user', content: stagnationNudge(stag) });
        result = await loop(reloopMessages(sysMsg, convo), RELOOP_BUDGET);
      }
    } catch (_) {}
  }
  return result;
}
