// Agent loop — the pure orchestration that turns the inference tier into a
// coding agent (Forge C6 / LocalMind L0, the tool-using driver).
//
// The loop is deliberately I/O-free: the two things that touch the world —
// calling the model and running a tool — are injected. That keeps the control
// flow (send → tool_calls → execute → feed results → repeat) headlessly
// testable with mocks before any live
// endpoint or terminal is wired.
//
//   const result = await runAgentLoop({
//     messages,                 // seed transcript (system + user)
//     tools: [shellTool()],     // OpenAI tool schemas
//     infer,                    // async ({messages, tools}) => { content, toolCalls, finishReason }
//     executeTool,              // async (name, args, rawCall) => string   (the tool result text)
//     maxSteps: 24,
//     onEvent,                  // optional (event) => void   progress taps
//   });
//   // result: { messages, steps, stop: 'done'|'max-steps'|'no-progress'|'error', text }

import { parseToolArguments } from './agent-protocol.mjs';
import { classifyToolResult } from './tool-result-kind.mjs';
import { NO_OUTPUT } from './expect.mjs';

// The single most powerful tool for a coding agent: a real shell. The Forge
// shell already covers fileops, git, pipes, and globs, so one `shell` tool is a
// complete surface — the agent writes a command line, we run it, return output.
export function shellTool() {
  return {
    type: 'function',
    function: {
      name: 'shell',
      description:
        'Run a command in the workspace shell (bash-style: fileops, git, pipes, ' +
        'redirects, globs). Returns combined stdout/stderr as text. Destructive ' +
        'commands (rm, git commit) stage for confirmation.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to run.' },
          expect: { type: 'string', description: 'Optional prediction, graded against the result: "exit <n>", "contains <text>", "absent <text>", or "output" (the command prints something). A miss is recorded — predict when you are testing a belief. For a search or a listing predict "output" or "contains <text>", not "exit 0": a search that finds nothing also exits 0, and that grade is reported as VACUOUS.' },
        },
        required: ['command'],
      },
    },
  };
}

// The explicit-completion tool. The model calls
// it to assert the task is done; the loop's handler runs the verifier gate
// before accepting, and rejects with the gate's bounded output if it is red.
// Stronger than "the assistant stopped talking = done" — completion is an
// affirmative act the harness gets to veto.
// B2 (2026-09-11): a completion claim with no substance is bounced back for a
// retry instead of ending the run. "done", "ok", "finished", an empty string, a few characters —
// none of them say what was done or how it was checked, which is the only thing the summary is
// for. Pure; the loop calls it before it runs the gate, so a placeholder never costs a gate run.
export const PLACEHOLDER_SUMMARY_RE = /^(?:done|ok|okay|finished|complete|completed|task (?:is )?(?:done|complete|completed)|all done|success|✓|yes)[.! ]*$/i;
export function placeholderSummary(summary) {
  const t = String(summary ?? '').trim();
  if (!t) return 'task_done needs a summary — what you did and how you verified it.';
  if (PLACEHOLDER_SUMMARY_RE.test(t)) return `"${t}" is not a summary — say what you did and how you verified it.`;
  // No length rule: a 12-character floor was a guessed number, and it refused real summaries
  // ("tests green"). The bar is the closed list above and a blank; the model keeps its words.
  return null;
}

// B3 (2026-09-11): a run that needs a decision can ask for one instead of guessing
// or dying. The loop intercepts `clarify`, pauses the run with stop:'clarify', and the owner's
// next message resumes it — the same carried-conversation path every re-send already uses.
export function clarifyTool() {
  return { type: 'function', function: {
    name: 'clarify',
    description: 'Ask the owner ONE question you cannot answer from the workspace and that changes what you would do — a missing requirement, two conflicting instructions, a destructive choice. The run pauses; their answer arrives as the next message. Do not use it for things you can find out by reading or running.',
    parameters: { type: 'object', properties: { question: { type: 'string', description: 'The one question, with the options if there are options.' } }, required: ['question'] },
  } };
}

export function taskDoneTool() {
  return {
    type: 'function',
    function: {
      name: 'task_done',
      description:
        'Call this when you believe the task is complete. The verification gate ' +
        'runs before this is accepted; if the gate is red you receive its output ' +
        'and must fix the problem and try again. Only a green gate ends the task.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'What you did AND how you verified it, in one or two sentences. Required — "done" is not a summary and is refused.' },
        },
        required: [],
      },
    },
  };
}

// Rough token estimate (~4 chars/token) over a string or a message transcript.
// Deliberately cheap and dependency-free — the budget ladder and compaction only
// need a monotonic proxy, not a real tokenizer.
// ── usage-anchored token accounting (F6) ──
//
// estimateTokens is chars/4. That is fine for a log line and wrong for a budget that ENDS
// runs: it ignores the system prompt's real tokenisation, tool schemas, images, and every
// provider's own accounting. When the provider tells us what a request actually cost, that
// number is the truth and the estimate is only used for the delta since.
//
// The two provider shapes, and why they are NOT added together:
//   Anthropic: input_tokens EXCLUDES cache reads/writes, which are reported separately —
//              so the real input is the sum of the three.
//   OpenAI:    prompt_tokens INCLUDES the cached part, and prompt_tokens_details.cached_tokens
//              is a SUBSET of it — adding it would double-count the cache on every turn.
// Returns null when the object carries no usable input count, so the caller falls back to
// the estimate rather than silently anchoring on zero.
export function usageInputTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
  const anthropic = num(usage.input_tokens);
  if (anthropic !== null) {
    return anthropic + (num(usage.cache_read_input_tokens) || 0) + (num(usage.cache_creation_input_tokens) || 0);
  }
  const openai = num(usage.prompt_tokens);
  if (openai !== null) return openai; // cached_tokens is already inside this
  return null;
}

// What the provider says the reply itself cost, or null.
export function usageOutputTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
  return num(usage.output_tokens) ?? num(usage.completion_tokens);
}

export function estimateTokens(input) {
  if (typeof input === 'string') return Math.ceil(input.length / 4);
  if (Array.isArray(input)) {
    let chars = 0;
    for (const m of input) {
      if (typeof m?.content === 'string') chars += m.content.length;
      if (Array.isArray(m?.tool_calls)) {
        for (const c of m.tool_calls) chars += (c.function?.arguments || '').length + (c.function?.name || '').length;
      }
    }
    return Math.ceil(chars / 4);
  }
  return 0;
}

// Bound a block of text to a line/byte cap for feeding back into the model — the
// same discipline as tool-output capping, applied to verifier gate output (Prime
// Agent: "a failed gate returns its bounded output to the agent"). Pure: no file
// spill (the loop has no workspace face), just a truncation marker.
// Head AND tail. This kept only the head, and its main caller is the GATE FEEDBACK message — the
// most important thing the loop says. A test runner prints its summary last, so head-only
// truncation dropped exactly the diagnosis the agent needed (forward-pass R1b). Slicing is by code
// POINT, so a surrogate pair can never be split down the middle.
export function boundedText(text, { maxLines = 200, maxBytes = 4000, tailLines = 40, tailBytes = 1000 } = {}) {
  const s = String(text == null ? '' : text);
  const lines = s.split('\n');
  let out = s, truncated = false;
  if (lines.length > maxLines) {
    // the tail can never outgrow the cap itself — with a small maxLines an unclamped tail
    // produced MORE output than the limit it was enforcing
    const tn = Math.min(tailLines, Math.max(1, Math.floor(maxLines / 2)));
    const headN = Math.max(1, maxLines - tn);
    const head = lines.slice(0, headN), tail = lines.slice(-tn);
    // The marker names BOTH dimensions of what went missing — a line count alone does not tell
    // the model how much text it is not seeing. CHARS, not bytes: `s.length` is UTF-16 code
    // units, and the byte path below counts code points; calling either "bytes" is false for
    // anything non-ASCII (3,000 emoji are 3,000 code points and 12,000 UTF-8 bytes). The count
    // is the elided lines and the newlines that joined them — exactly what is no longer there.
    const elided = lines.slice(head.length, lines.length - tail.length);
    const elidedChars = elided.reduce((n, l) => n + l.length, 0) + elided.length;
    out = `${head.join('\n')}\n… (${elided.length} lines / ${elidedChars} chars elided) …\n${tail.join('\n')}`;
    truncated = true;
  }
  const cp = [...out];
  if (cp.length > maxBytes) {
    const tb = Math.min(tailBytes, Math.max(1, Math.floor(maxBytes / 2)));
    const headN = Math.max(1, maxBytes - tb);
    out = `${cp.slice(0, headN).join('')}\n… (${cp.length - headN - tb} chars elided) …\n${cp.slice(-tb).join('')}`;
    truncated = true;
  }
  return truncated ? out + `\n… (output truncated: ${lines.length} lines / ${s.length} chars)` : out;
}

// ── spill at produce-time (F5) ──
//
// An oversized tool result used to enter the transcript whole and only get elided later, by
// compaction, once the WHOLE transcript was already over budget — which means the run paid
// for it at least once, and on a small local window a single 200 KB result could blow the
// context before anything had a chance to shrink it. Capping here, where the result is
// produced, keeps it out of the surface entirely.
//
// What the model sees is a head + tail preview and a locator that RESOLVES: the record keeps
// the full result (the recorder stores what was produced alongside what was sent), and the
// `history` tool searches it. The notice's own cost is reserved INSIDE the cap, so the
// replacement is never bigger than the limit it enforces.
export const DEFAULT_TOOL_OUTPUT_CAP = 20_000;

// F9 (N4, 2026-09-12): which tools may run concurrently within one step. A model that asks for
// four reads in one turn used to get them one after another; the read-only tools now run as a
// rolling pool (at most MAX_PARALLEL in flight) while anything that can change state — a write,
// the shell (which also carries a cwd), a skill load (it revives a stale skill on disk), the
// budget tools (they read the transcript as it stands, so a pending read changes their answer),
// read_lines (an oversized one spills to a numbered artifact) — stays exclusive and waits for the
// pool before it. The declaration lives here, not on the wire: a tool schema is what the provider
// receives, and an extra key there is a provider's to reject. A caller's `concurrency` map
// REPLACES this one (no merge); unknown and inherited names are exclusive; clarify and task_done
// are the loop's own and never executed by a pool whatever the map says. Known and accepted:
// a project post-hook configured on `read` runs beside sibling reads, and a read that needs a
// permission prompt can raise it while another is pending — both are the hook/rule author's
// declared choice on a read-only tool; the pool does not know about either. And an executor that
// emits its OWN events (Anvil's action gate records a tool-error on a denied read) does so for a
// member started ahead before that member's tool-call is on the chain — the loop's own events keep
// the serial order and pairing; a denied pool member's gate event lands one call early.
export const DEFAULT_TOOL_CONCURRENCY = Object.freeze({ read: 'parallel', history: 'parallel' });
export const MAX_PARALLEL = 4;

export function spillToolOutput(result, { name = '', cap = DEFAULT_TOOL_OUTPUT_CAP } = {}) {
  const text = String(result == null ? '' : result);
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;
  if (!limit || text.length <= limit) return { sent: text, spilled: false, chars: text.length };
  const notice = (elided) =>
    `\n… (${elided} chars elided — the FULL result of \`${name || 'this call'}\` is in this run's record; find it with the \`history\` tool, searching for a distinctive string from the head or tail above.) …\n`;
  // Reserve the notice's own length before splitting, so head + notice + tail <= cap. The
  // notice length depends on the elided count, which depends on the notice length; one
  // iteration on an upper bound settles it without a fixed point.
  const reserve = notice(text.length).length;
  const room = Math.max(2, limit - reserve);
  const headN = Math.ceil(room * 0.6);
  const tailN = room - headN;
  const head = text.slice(0, headN);
  const tail = tailN > 0 ? text.slice(-tailN) : '';
  const sent = head + notice(text.length - head.length - tail.length) + tail;
  return { sent, spilled: true, chars: text.length };
}

// A capped, model-facing rendering of a verifier verdict — the exact text fed
// back as the repair prompt / task_done rejection.
function gateFeedback(verdict, cap) {
  const exit = verdict?.exit ?? 1;
  const body = String(verdict?.stdout || '') + (verdict?.stderr ? (verdict?.stdout ? '\n' : '') + verdict.stderr : '');
  return `Verification failed (exit ${exit}). The task is NOT complete.` +
    (body ? '\n\n' + boundedText(body, cap) : '');
}

// omp's bash interceptors: shell idioms with a strictly-better structured tool
// are redirected instead of run, so the model reaches for read/write/edit/rg.
// Returns a hint string (the tool result) when a command should be intercepted,
// or null to run it normally. Conservative by design — only idioms the curated
// shell handles poorly or destructively-in-place are intercepted; plain reads
// (`cat file`) and simple redirects the shell supports are left alone.
export function interceptBashCommand(command) {
  const cmd = String(command == null ? '' : command).trim();
  if (!cmd) return null;
  // In-place stream editors → the edit tool (the shell's sed reads stdin only).
  if (/(^|\|)\s*sed\s+[^|]*-i\b/.test(cmd) || /(^|\|)\s*perl\s+[^|]*-i\b/.test(cmd) ||
      /(^|\|)\s*awk\s+[^|]*-i\s+inplace\b/.test(cmd)) {
    return 'Use the `edit` tool for in-place file edits instead of `sed -i`/`perl -i` — it is exact, reviewable, and cannot silently corrupt the file.';
  }
  // Recursive grep → the `rg` tool (the shell grep does not recurse directories).
  if (/(^|\|)\s*grep\s+[^|]*-(?:r|R|-recursive)\b/.test(cmd)) {
    return 'Use the `rg` tool (ripgrep) for recursive search — the shell `grep` reads named files/stdin only, not directory trees.';
  }
  // Writing a file via cat/heredoc redirection → the write tool.
  if (/(^|\|)\s*cat\s*(?:<<|>)/.test(cmd) || /(^|\|)\s*cat\s+[^|]*<</.test(cmd)) {
    return 'Use the `write` tool to create or overwrite a file instead of `cat >`/heredoc — it creates parent directories and is unambiguous.';
  }
  return null;
}

// Build the assistant turn to append to the transcript. Mirrors the OpenAI
// contract: content is null when the turn is purely tool calls.
function assistantTurn(content, toolCalls) {
  const turn = { role: 'assistant', content: content || (toolCalls?.length ? null : '') };
  if (toolCalls?.length) turn.tool_calls = toolCalls;
  return turn;
}

// Give a tool call a stable id so the paired tool result can reference it. Some
// endpoints omit ids on tool calls; synthesise a deterministic one from the step.
function callId(call, step, index) {
  return call.id || `call_${step}_${index}`;
}

// A signature of the tool calls in a step, to detect a stuck loop (the model
// repeating the identical call with no new information).
// The CANONICAL form of a tool call's arguments: same object, same string, whatever
// order the model happened to emit the keys in. Detection keys on this — a model that
// re-issues `{a:1,b:2}` then `{b:2,a:1}` is repeating itself, and a raw-string compare
// would call that progress. Unparseable arguments fall back to the raw string.
function stableArgs(raw) {
  const text = String(raw == null ? '' : raw);
  let v; try { v = JSON.parse(text); } catch { return text; }
  const canon = (x) => {
    if (Array.isArray(x)) return x.map(canon);
    if (x && typeof x === 'object') {
      const out = {};
      for (const k of Object.keys(x).sort()) out[k] = canon(x[k]);
      return out;
    }
    return x;
  };
  try { return JSON.stringify(canon(v)); } catch { return text; }
}

export function stepSignature(toolCalls) {
  return (toolCalls || [])
    .map(c => `${c.function?.name}(${stableArgs(c.function?.arguments)})`)
    .join('|');
}

// The repeat counts at which the loop speaks up. Escalating, and it NEVER stops the
// run: the old guard returned stop:'no-progress' at the second identical call, throwing
// away a run that one sentence might have saved — and the model never learned why. The
// budget ladder (turns / tokens / wall-clock) is what ends a run; this only interrupts.
export const REPEAT_NUDGE_AT = Object.freeze([3, 5, 8]);

// What a refused result looks like coming back from a tool. Deliberately narrow: an
// ordinary empty result or a "no matches" is NOT a denial, and calling it one would put
// the harsher wording in front of a model that is merely searching.
const DENIED_RE = /^\s*(Refused\b|Error:|Denied\b|Permission denied\b|Blocked by )/i;

// What the model is SHOWN of the repeated call. Bounded, because a repeated 40 KB
// write would otherwise be pasted back into the transcript at every escalation — while
// DETECTION still keys on the full canonical string, so two long calls that differ only
// past the cap are not mistaken for each other.
const REPEAT_PREVIEW = 200;
function repeatPreview(toolCalls) {
  return (toolCalls || []).map((c) => {
    const name = c.function?.name || '?';
    const args = stableArgs(c.function?.arguments);
    return `${name}(${args.length > REPEAT_PREVIEW ? args.slice(0, REPEAT_PREVIEW) + `… +${args.length - REPEAT_PREVIEW} chars` : args})`;
  }).join(' , ');
}

// The escalating reminder. Tagged [coordination] so foldRecovery and the model both read
// it as the machine talking, never as the owner's instruction. `denied` says the repeated
// call was REFUSED every time — a model hammering a denied call is the loop most worth
// breaking, and the honest thing to tell it is that repeating will not change the answer.
export function repeatNudge(times, toolCalls, { denied = false } = {}) {
  const what = repeatPreview(toolCalls);
  if (times >= 8) {
    return `[coordination] That is ${times} identical calls: ${what}. ` +
      (denied ? 'Every one was refused, and repeating it will not change that. ' : 'Nothing about the result will change. ') +
      'Stop repeating it. Either take a different route to the same goal, or say plainly what is blocking you and what you would need — an honest stop is a better outcome than another identical call.';
  }
  if (times >= 5) {
    return `[coordination] You have now issued the same call ${times} times: ${what}. ` +
      (denied ? 'It was refused each time. ' : 'The result has been the same each time. ') +
      'Change something concrete: a different tool, a smaller step, a different path, or re-read the goal. Do not issue it again unchanged.';
  }
  return `[coordination] You have issued the same call ${times} times in a row: ${what}. ` +
    (denied ? 'It was refused each time, so repeating it will not succeed. ' : 'Repeating it will not produce a different result. ') +
    'Step back: what were you trying to achieve, and what else could get you there?';
}

export async function runAgentLoop({
  messages,
  tools,
  infer,
  executeTool,
  maxSteps = 24,
  onEvent = () => {},
  verify = null,           // optional async () => { ok, exit, stdout, stderr } (a K3 verifier)
  maxVerifyRounds = 3,     // how many times a failing verdict is fed back before giving up
  workspaceHash = null,    // optional async () => string — gate memoization by workspace state
  budget = null,           // optional { turns, tokens, wallClockMs } — the completion budget ladder
  gateOutputCap = { maxLines: 200, maxBytes: 4000 }, // how much gate output is fed back
  toolOutputCap = DEFAULT_TOOL_OUTPUT_CAP, // F5: chars of a single tool result that reach the surface
  concurrency = DEFAULT_TOOL_CONCURRENCY, // F9: { toolName: 'parallel' | 'exclusive' }; unknown = exclusive
  maxParallel = MAX_PARALLEL,             // F9: the pool's width
  now = () => Date.now(),  // injectable clock (wall-clock budget is testable headlessly)
  signal = null,           // optional AbortSignal — cooperative stop between turns/tools
}) {
  if (typeof infer !== 'function') throw new Error('runAgentLoop needs an infer function');
  if (typeof executeTool !== 'function') throw new Error('runAgentLoop needs an executeTool function');
  const convo = messages.slice();
  let lastText = '';
  let repeats = 0;           // consecutive turns whose canonical tool-call set was identical
  let prevSignature = null;
  let repeatDenied = false;  // was every result of the repeated call a refusal?
  let nudgedAt = -1;         // the repeat count the last nudge was issued for (never twice for one count)
  let pendingNudge = null;   // a nudge waiting for this turn's tool results to be appended
  // The user messages the LOOP wrote (gate feedback, repeat nudges). Identity, not text:
  // a model that echoes a nudge back verbatim must not be mistaken for the owner speaking.
  const loopAuthored = new WeakSet();
  let scannedTo = 0;         // how much of convo has been checked for an owner interjection
  let requestLen = 0;        // convo length at the moment the in-flight request was sent (F6)
  let verifyRounds = 0;
  const startedAt = now();

  // Cooperative stop: the caller aborts the signal (a Stop button). We check it
  // between turns, right after inference, and before each tool call, then return
  // stop:'aborted' with whatever conversation exists so far. An in-flight
  // inference/tool call is not force-killed — the loop stops at the next boundary.
  const aborted = () => !!(signal && signal.aborted);
  const abortReturn = (step) => { onEvent({ type: 'aborted', step }); return { messages: convo, steps: step, stop: 'aborted', text: lastText }; };

  // Gate memoization: after a verifier failure, remember the
  // workspace hash and the failing verdict. If the next gate request arrives on
  // an identical hash, replay the cached failure instead of re-running the gate —
  // no burning gate runtime on an unchanged workspace. Returns { verdict, ran }.
  let memo = null; // { hash, verdict }
  async function runGate() {
    let hash = null;
    if (typeof workspaceHash === 'function') {
      try { hash = await workspaceHash(); } catch { hash = null; }
    }
    if (memo && hash != null && hash === memo.hash) {
      return { verdict: memo.verdict, ran: false };
    }
    let verdict;
    try { verdict = await verify(); }
    catch (e) { verdict = { ok: false, exit: 1, stderr: String(e?.message || e) }; }
    if (verdict && !verdict.ok && hash != null) memo = { hash, verdict };
    else if (verdict && verdict.ok) memo = null; // a pass invalidates any cached failure
    return { verdict, ran: true };
  }

  // The budget ladder: turns / tokens / wall-clock. Any tripped axis stops the
  // loop with stop:'budget' and names the axis. Checked at the top of each turn.
  // The run's token count. Anchored on what the provider actually charged for the last
  // request it reported, plus an estimate of only what has been appended since — so the
  // estimator's error is bounded by one turn's tail instead of accumulating over the whole
  // transcript. With no usage ever reported it degrades to exactly the old behaviour.
  let anchor = null; // { len, input } — input tokens the provider charged for convo[0..len)
  function tokensUsed() {
    if (!anchor) return estimateTokens(convo);
    return anchor.input + estimateTokens(convo.slice(anchor.len));
  }

  function budgetTripped(step) {
    if (!budget) return null;
    if (Number.isFinite(budget.turns) && step >= budget.turns) return 'turns';
    if (Number.isFinite(budget.tokens) && tokensUsed() > budget.tokens) return 'tokens';
    if (Number.isFinite(budget.wallClockMs) && now() - startedAt >= budget.wallClockMs) return 'wall-clock';
    return null;
  }

  for (let step = 0; step < maxSteps; step++) {
    if (aborted()) return abortReturn(step);
    const axis = budgetTripped(step);
    if (axis) {
      onEvent({ type: 'budget', axis, step });
      onEvent({ type: 'done', reason: 'budget', axis, step });
      return { messages: convo, steps: step, stop: 'budget', budgetAxis: axis, text: lastText };
    }
    // A turn can be long (a slow local model thinks for minutes) and until it
    // returns there is NOTHING on screen, so a working run and a wedged one look
    // identical. Announce the turn before blocking on it.
    onEvent({ type: 'turn-start', step });
    let reply;
    try {
      // `signal` reaches infer so an in-flight call can actually be cancelled.
      // Without it Stop only takes effect BETWEEN turns, so a hung inference
      // ignores both the abort and the wall-clock budget (which is also only
      // checked between turns) — the run becomes uninterruptible.
      requestLen = convo.length;
      reply = await infer({ messages: convo, tools, signal });
    } catch (e) {
      // A cancelled inference throws — that is the Stop button working, not a
      // fault. Report it as the abort it is; 'error' is for the model or the host
      // failing on their own (live finding 2026-09-06: Stop read as 'agent error').
      if (aborted()) return abortReturn(step);
      onEvent({ type: 'error', error: String(e?.message || e), step });
      return { messages: convo, steps: step, stop: 'error', text: lastText, error: String(e?.message || e) };
    }

    // F6: anchor on the provider's own count when it gave one for THIS request envelope.
    // A count that arrives for a request we did not just make (a cached or replayed reply
    // with stale usage) would anchor on the wrong prefix, so the length is captured at the
    // call and the anchor only ever moves forward.
    {
      const input = usageInputTokens(reply?.usage);
      if (input !== null && requestLen >= (anchor ? anchor.len : 0)) {
        anchor = { len: requestLen, input };
        const out = usageOutputTokens(reply?.usage);
        onEvent({ type: 'usage', step, input, output: out ?? null, at: requestLen });
      }
    }

    if (aborted()) return abortReturn(step);
    const content = typeof reply?.content === 'string' ? reply.content : '';
    const toolCalls = Array.isArray(reply?.toolCalls) ? reply.toolCalls : [];
    if (content) { lastText = content; onEvent({ type: 'assistant', content, step }); }

    // No tool calls → the model believes it is done. If a verifier is wired, the
    // model does NOT get to declare done — the verifier does. A failing verdict is
    // fed back so the model fixes it; only a passing verdict (exit 0) completes.
    if (!toolCalls.length) {
      convo.push(assistantTurn(content, null));
      if (verify) {
        const { verdict, ran } = await runGate();
        if (verdict && verdict.ok) {
          onEvent({ type: 'verify-pass', verdict, step });
          onEvent({ type: 'done', reason: 'verified', step });
          return { messages: convo, steps: step + 1, stop: 'done', verified: true, text: lastText };
        }
        verifyRounds++;
        onEvent({ type: 'verify-fail', verdict, round: verifyRounds, ran, step });
        if (verifyRounds >= maxVerifyRounds) {
          onEvent({ type: 'done', reason: 'unverified', step });
          return { messages: convo, steps: step + 1, stop: 'unverified', verified: false, text: lastText, verdict };
        }
        const fb = { role: 'user', content: gateFeedback(verdict, gateOutputCap) + '\nFix the problem and continue.' };
        loopAuthored.add(fb);
        convo.push(fb);
        continue;
      }
      onEvent({ type: 'done', reason: reply?.finishReason || 'stop', step });
      return { messages: convo, steps: step + 1, stop: 'done', text: lastText };
    }

    // Repeat guard (F7). The identical canonical tool-call set, turn after turn, means the
    // model is going in a circle. This used to STOP the run at the second occurrence, which
    // threw away every run a single sentence would have saved and never told the model what
    // was wrong. It now NUDGES, escalating at REPEAT_NUDGE_AT, and never stops: the budget
    // ladder ends runs, this only interrupts one.
    //
    // A user message the loop did not author resets the chain — a person who says something
    // new has changed the situation, and the count should not carry across that. (Anvil's own
    // interjection is a fresh runAgentLoop, which resets by construction; this covers a caller
    // that seeds the conversation with a later owner turn.)
    for (let i = scannedTo; i < convo.length; i++) {
      const m = convo[i];
      if (m && m.role === 'user' && !loopAuthored.has(m)) { repeats = 0; prevSignature = null; nudgedAt = -1; break; }
    }
    scannedTo = convo.length;

    const signature = stepSignature(toolCalls);
    repeats = signature === prevSignature ? repeats + 1 : 0;
    prevSignature = signature;

    convo.push(assistantTurn(content, toolCalls));

    const times = repeats + 1; // occurrences of this call in a row, counting the first
    if (REPEAT_NUDGE_AT.includes(times) && times !== nudgedAt) {
      nudgedAt = times;
      // The wording is decided AFTER this turn's tools have run, so "it was refused each
      // time" is a statement about the results the model has actually seen, including this
      // turn's. Only the decision to nudge is made here.
      pendingNudge = { times, signature, toolCalls };
    }

    // Execute each tool call and feed the result back as a tool message. A
    // `task_done` call is intercepted here (not passed to executeTool): the loop
    // owns completion, so it runs the gate and either accepts or rejects.
    let gateGreen = false;
    const stepResults = [];
    // F9: one execution, its outcome captured rather than thrown, so a batch member's failure
    // is reported at its own place in the order and cannot take the batch down with it.
    const runOne = async (n, args, c) => {
      try { return { text: await executeTool(n, args, c), error: null }; }
      catch (e) { const m = String(e?.message || e); return { text: `Error: ${m}`, error: m }; }
    };
    const parallelOk = (n) => !!concurrency && Object.hasOwn(concurrency, n) && concurrency[n] === 'parallel' && n !== 'clarify' && n !== 'task_done';
    const inFlight = new Map(); // call index -> pending runOne, for the pool members started ahead
    const started = new Set();  // call indexes ever started (ahead or inline)
    let active = 0;             // members RUNNING right now — a settled member no one has consumed yet holds no slot
    let poolStart = 0, poolEnd = 0; // the pool's eligible span [poolStart, poolEnd); members start in request order
    const cap = Math.max(1, maxParallel | 0);
    // Start pool members ahead, in request order, while a slot is free. The signal is checked before
    // EACH launch, so a stop during one executor never starts the next. A settled member refills the
    // pool itself (below), so a slow member at the front does not hold the members behind it.
    const startNext = () => {
      for (let k = poolStart; k < poolEnd && active < cap; k++) {
        if (started.has(k)) continue;
        if (aborted()) return;
        const c = toolCalls[k];
        started.add(k); active++;
        const p = runOne(c.function?.name || '', parseToolArguments(c).value, c);
        inFlight.set(k, p);
        p.then(() => { active--; startNext(); });
      }
    };
    for (let i = 0; i < toolCalls.length; i++) {
      // A stop is honoured at a BOUNDARY: a pool member already running is drained and its result
      // recorded (it happened), and nothing new is started — the serial loop's own rule, "an
      // in-flight call is not force-killed", extended to the members in flight.
      if (aborted() && !inFlight.has(i)) return abortReturn(step + 1);
      const call = toolCalls[i];
      const id = callId(call, step, i);
      const name = call.function?.name || '';

      if (name === 'clarify') {
        const q = String(parseToolArguments(call).value?.question ?? '').trim();
        if (!q) {
          const msg = 'Error (invalid_args): clarify needs the question.';
          onEvent({ type: 'tool-error', name, id, error: msg, kind: 'invalid_args', step });
          onEvent({ type: 'tool-result', name, id, result: msg, kind: 'invalid_args', step });
          convo.push({ role: 'tool', tool_call_id: id, content: msg });
          continue;
        }
        const msg = 'Question sent to the owner. The run pauses here; their answer arrives as the next message.';
        onEvent({ type: 'tool-result', name, id, result: msg, step });
        convo.push({ role: 'tool', tool_call_id: id, content: msg });
        onEvent({ type: 'clarify', question: q, step });
        return { messages: convo, steps: step + 1, stop: 'clarify', question: q, text: lastText };
      }

      if (name === 'task_done') {
        const problem = placeholderSummary(parseToolArguments(call).value?.summary);
        if (problem) { // B2: no substance, no gate run — bounce it back
          const msg = `Error (invalid_args): ${problem}`;
          onEvent({ type: 'tool-error', name, id, error: msg, kind: 'invalid_args', step });
          onEvent({ type: 'tool-result', name, id, result: msg, kind: 'invalid_args', step });
          convo.push({ role: 'tool', tool_call_id: id, content: msg });
          continue;
        }
        if (!verify) { // no gate wired → the explicit signal is accepted as-is
          onEvent({ type: 'tool-result', name, id, result: 'accepted', step });
          convo.push({ role: 'tool', tool_call_id: id, content: 'Task accepted (no verification gate configured).' });
          gateGreen = true;
          continue;
        }
        const { verdict, ran } = await runGate();
        if (verdict && verdict.ok) {
          onEvent({ type: 'verify-pass', verdict, step });
          convo.push({ role: 'tool', tool_call_id: id, content: 'Verification passed. Task complete.' });
          gateGreen = true;
        } else {
          verifyRounds++;
          onEvent({ type: 'verify-fail', verdict, round: verifyRounds, ran, step });
          convo.push({ role: 'tool', tool_call_id: id, content: gateFeedback(verdict, gateOutputCap) });
          if (verifyRounds >= maxVerifyRounds) {
            onEvent({ type: 'done', reason: 'unverified', step });
            return { messages: convo, steps: step + 1, stop: 'unverified', verified: false, text: lastText, verdict };
          }
        }
        continue;
      }

      const parsed = parseToolArguments(call);
      let resultText;
      if (!parsed.ok) {
        resultText = `Error: could not parse arguments as JSON: ${parsed.error}`;
        onEvent({ type: 'tool-error', name, id, error: parsed.error, kind: 'invalid_args', step });
        // The executed path emits tool-result after a throw; this path did not, so the record
        // held only the raw parse error and the transcript fold had to invent the wording the
        // model saw. Live 2026-09-11 on DeepSeek (a tool call cut off mid-JSON): every later
        // request read as unreconstructable. Record exactly what is sent.
        onEvent({ type: 'tool-result', name, id, result: resultText, kind: 'invalid_args', step });
      } else {
        onEvent({ type: 'tool-call', name, id, args: parsed.value, step });
        if (parallelOk(name)) {
          // F9: the run of consecutive parallel-class, parseable calls from here is the pool's
          // eligible span; members start in request order, at most maxParallel in flight, and
          // results are taken in request order — every event (tool-call, then tool-result) is
          // emitted in the same order and pairing the serial loop produced, so the record, its
          // folds and a replay against a serially recorded run are unchanged. The FIRST member
          // starts after its own tool-call event, exactly as a serial call does; only later members
          // are already running when their tool-call is emitted. An exclusive call is never started
          // while the pool is in flight: the pool drains before the loop reaches it.
          if (!started.has(i)) {
            // Not started ahead (first of its span, or a slot never freed for it): this member runs
            // INLINE on the serial path — its tool-call was just emitted and it always runs, and a
            // synchronous throw reports in the same tick, as a serial call does — while the members
            // behind it start beside it. A lone read is therefore byte-for-byte the serial loop.
            // Starts are in request order, so an unstarted member means nothing after it has
            // started either: the span begins here.
            poolStart = i; poolEnd = i;
            while (poolEnd < toolCalls.length && parallelOk(toolCalls[poolEnd].function?.name || '') && parseToolArguments(toolCalls[poolEnd]).ok) poolEnd++;
            started.add(i); active++;
            let pending, invoked = false;
            const failed = (e) => { resultText = `Error: ${String(e?.message || e)}`; onEvent({ type: 'tool-error', name, id, error: String(e?.message || e), kind: 'execution_error', step }); };
            // Invoked BEFORE the members behind it start, so starts stay in request order; a
            // synchronous throw is reported here, in this tick.
            try { pending = executeTool(name, parsed.value, call); invoked = true; } catch (e) { failed(e); }
            startNext();
            if (invoked) { try { resultText = await pending; } catch (e) { failed(e); } }
            active--; startNext();
          } else {
            const ran = await inFlight.get(i);
            inFlight.delete(i);
            resultText = ran.text;
            if (ran.error != null) onEvent({ type: 'tool-error', name, id, error: ran.error, kind: 'execution_error', step });
          }
        } else {
          // Exclusive: the serial path, untouched — a synchronous throw is reported in the same tick.
          try {
            resultText = await executeTool(name, parsed.value, call);
          } catch (e) {
            resultText = `Error: ${String(e?.message || e)}`;
            onEvent({ type: 'tool-error', name, id, error: String(e?.message || e), kind: 'execution_error', step });
          }
        }
        // B1: the kind rides the event; the text the model sees is untouched.
        const kind = classifyToolResult(name, resultText);
        onEvent({ type: 'tool-result', name, id, result: resultText, ...(kind ? { kind } : {}), step });
      }
      // F5: cap what enters the SURFACE; the record keeps what was produced. If the recorder
      // refuses the event, the elision has nowhere to point, so the original stays inline —
      // a storage failure must not turn a successful call into a lost result.
      let sentText = String(resultText ?? '');
      const spill = spillToolOutput(sentText, { name, cap: toolOutputCap });
      if (spill.spilled) {
        let stored = true;
        try { onEvent({ type: 'tool-spilled', name, id, step, chars: spill.chars, sent: spill.sent }); }
        catch { stored = false; }
        if (stored) sentText = spill.sent;
      }
      convo.push({ role: 'tool', tool_call_id: id, content: sentText });
      stepResults.push(sentText);
    }

    // Did this turn's calls all come back refused? A refusal is a guard speaking (the skills
    // fence, a grant, a hook block) or a hard error — repeating it cannot succeed, and the
    // nudge says so in stronger terms. `false` when the turn ran no tools at all: silence is
    // not a denial.
    repeatDenied = stepResults.length > 0 && stepResults.every((r) => DENIED_RE.test(r));

    // The nudge lands AFTER the tool results, so every assistant tool_call still has its
    // paired tool message immediately following it — inserting a user turn between them
    // breaks the provider contract on strict endpoints.
    if (pendingNudge) {
      const { times, signature, toolCalls: repeated } = pendingNudge;
      const note = { role: 'user', content: repeatNudge(times, repeated, { denied: repeatDenied }) };
      loopAuthored.add(note);
      convo.push(note);
      // The CONTENT rides on the event: the recorder stores the exact words that were sent,
      // so foldTranscript reproduces THIS run rather than this version's wording — and the
      // event fires at the push, so the record's order is the transcript's order (F1).
      onEvent({ type: 'repeat-nudge', step, times, signature, denied: repeatDenied, content: note.content });
      pendingNudge = null;
    }

    if (gateGreen) {
      onEvent({ type: 'done', reason: 'verified', step });
      return { messages: convo, steps: step + 1, stop: 'done', verified: true, text: lastText };
    }
  }

  onEvent({ type: 'max-steps', steps: maxSteps });
  return { messages: convo, steps: maxSteps, stop: 'max-steps', text: lastText };
}

// Bind the shell tool to a Forge shell instance: returns an executeTool(name,args)
// that runs `args.command` through the shell and returns its output. Unknown tool
// names return an error string (the model learns from it) rather than throwing.
export function makeShellExecutor(shell) {
  return async function executeTool(name, args) {
    if (name !== 'shell') return `Error: unknown tool "${name}"`;
    const command = typeof args?.command === 'string' ? args.command : '';
    // Name the parameter that works and the keys that were actually sent. The old text
    // ("requires a non-empty command") did not say WHERE the command goes, so a model that
    // had used the wrong key just sent the same wrong key again.
    if (!command.trim()) {
      const sent = args && typeof args === 'object' ? Object.keys(args) : [];
      const got = sent.length ? `received ${sent.map((k) => `"${k}"`).join(', ')}` : 'received no arguments';
      return `Error: the shell tool takes the command in a "command" parameter (a string); ${got}. `
        + 'Nothing was run. Retry as {"command": "<the command line>"}.';
    }
    const hint = interceptBashCommand(command);
    if (hint) return hint; // omp interceptor: redirect to a structured tool, don't run
    const res = await shell.feed(command);
    const out = res?.output ?? '';
    return out === '' ? NO_OUTPUT : String(out);
  };
}
