// Agent loop — the pure orchestration that turns the inference tier into a
// coding agent (Forge C6 / LocalMind L0, the tool-using driver).
//
// The loop is deliberately I/O-free: the two things that touch the world —
// calling the model and running a tool — are injected. That keeps the control
// flow (send → tool_calls → execute → feed results → repeat) headlessly
// testable with mocks, exactly as an OpenCode/Codex loop is, before any live
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
          expect: { type: 'string', description: 'Optional prediction, graded against the result: "exit <n>", "contains <text>", or "absent <text>". A miss is recorded — predict when you are testing a belief.' },
        },
        required: ['command'],
      },
    },
  };
}

// The explicit-completion tool (Prime Agent's goal.complete()). The model calls
// it to assert the task is done; the loop's handler runs the verifier gate
// before accepting, and rejects with the gate's bounded output if it is red.
// Stronger than "the assistant stopped talking = done" — completion is an
// affirmative act the harness gets to veto.
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
          summary: { type: 'string', description: 'A one-line summary of what you did (optional).' },
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
    out = `${head.join('\n')}\n… (${lines.length - head.length - tail.length} lines elided) …\n${tail.join('\n')}`;
    truncated = true;
  }
  const cp = [...out];
  if (cp.length > maxBytes) {
    const tb = Math.min(tailBytes, Math.max(1, Math.floor(maxBytes / 2)));
    const headN = Math.max(1, maxBytes - tb);
    out = `${cp.slice(0, headN).join('')}\n… (${cp.length - headN - tb} chars elided) …\n${cp.slice(-tb).join('')}`;
    truncated = true;
  }
  return truncated ? out + `\n… (output truncated: ${lines.length} lines / ${s.length} bytes)` : out;
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

  // Gate memoization (Prime Agent): after a verifier failure, remember the
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
    for (let i = 0; i < toolCalls.length; i++) {
      if (aborted()) return abortReturn(step + 1);
      const call = toolCalls[i];
      const id = callId(call, step, i);
      const name = call.function?.name || '';

      if (name === 'task_done') {
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
        onEvent({ type: 'tool-error', name, id, error: parsed.error, step });
      } else {
        onEvent({ type: 'tool-call', name, id, args: parsed.value, step });
        try {
          resultText = await executeTool(name, parsed.value, call);
        } catch (e) {
          resultText = `Error: ${String(e?.message || e)}`;
          onEvent({ type: 'tool-error', name, id, error: String(e?.message || e), step });
        }
        onEvent({ type: 'tool-result', name, id, result: resultText, step });
      }
      convo.push({ role: 'tool', tool_call_id: id, content: String(resultText ?? '') });
      stepResults.push(String(resultText ?? ''));
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
    if (!command.trim()) return 'Error: shell tool requires a non-empty command';
    const hint = interceptBashCommand(command);
    if (hint) return hint; // omp interceptor: redirect to a structured tool, don't run
    const res = await shell.feed(command);
    const out = res?.output ?? '';
    return out === '' ? '(no output)' : String(out);
  };
}
