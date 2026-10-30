// The autoharness bed: one battery task, run through what the app runs, graded after the fact.
//
// Same assembly as scripts/bench-procedural.mjs (sys/ai/run-assembly.mjs: prompt bytes, toolset,
// budgets, hooks, act-or-nudge, supervisor), over an in-memory workspace. Two things differ from
// that bench on purpose:
//   - the grade is a function over the FINISHED run (workspace diff, final answer, record metrics),
//     not only the in-loop gate. Only tasks marked `gated` also hand the gate to the loop.
//   - the live infer returns the provider's `usage`, so the record carries input tokens per call.
//
// This is a NODE bed: `node` runs (the app's js-runner); python runs only when AUTOHARNESS_PYODIDE names
// a Pyodide install (python.mjs: the app's main-thread Kiln, one interpreter per run); no host context
// message (project notes, memory and skills indexes), no recovery-note fold over a real prior record.
// Every number from it names this bed, and whether it had python, not the app (plan/bench-playbook.md §2).
import { makeToolExecutor } from '../../sys/ai/agent-tools.mjs';
import { buildRigRegistry } from '../../sys/rig/registry/index.mjs';
import { createFileops, MemoryBackend } from '../../sys/rig/fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../sys/rig/agent/index.mjs';
import { createShell } from '../../sys/rig/cli/shell.mjs';
import { createRunRecorder } from '../../sys/history/run-record.mjs';
import { metricsOf } from '../../sys/ai/ablate.mjs';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { systemMessage, gateNote, runToolset, driveRun, withHooks, withBedStubs, loadHooks, isSimpleAsk } from '../../sys/ai/run-assembly.mjs';
import { bedKiln, LIMIT_MS } from './python.mjs';
import { toAnthropicRequest, fromAnthropicMessage, replayKey } from '../../sys/ai/anthropic-protocol.mjs';
import { runCodemode } from '../../sys/ai/codemode-runtime.mjs';
import { codemodeCatalog, CODEMODE_TOOL_NAMES } from '../../sys/ai/codemode-record.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const decoder = new TextDecoder();

// What identifies the harness under test: the code-mode system prompt and the gated tool schemas.
// Two runs with the same fingerprint ran the same prompt bytes and the same tool descriptions.
export function harnessFingerprint() {
  const h = createHash('sha256');
  h.update(systemMessage({ mode: 'code' }).content);
  h.update(JSON.stringify(runToolset('code', { verify: true })));
  return h.digest('hex').slice(0, 16);
}

// The bed, in the words a summary carries. `python` is loadBedPython()'s result, null without python.
export function bedDescription(python = null) {
  const py = python ? `python via the app main-thread Kiln on Pyodide ${python.version} (one interpreter per run, kilnIsolate, ${LIMIT_MS / 1000} s limit)` : 'no Kiln/python';
  return `node bed (scripts/autoharness/bed.mjs): in-memory workspace, the app assembly via sys/ai/run-assembly.mjs, node via the app js-runner, ${py}, no host context message`;
}

// The shell's `node` (sys/kiln/js-runner.mjs, G9) on node's worker_threads. The app hands its agent
// shell the same runner (`js: jsHost`) over module Workers with blob URLs, so the bed's
// `node test.mjs` is the app's. Module URLs are SHORT file: URLs (content-addressed under the OS temp
// dir), as blob: URLs are in the app: with data: URLs every stack frame carried a whole URL-encoded
// module, one failing assert passed the 50 KB tool-output cap, and the executor spilled it to
// .forge/out-N.txt in the workspace — a write the app would never have made (calibration 2026-10-01).
const MODULE_DIR = join(tmpdir(), 'autoharness-js');
mkdirSync(MODULE_DIR, { recursive: true });
export const nodeJsHost = Object.freeze({
  makeModuleURL: (src) => {
    const file = join(MODULE_DIR, createHash('sha256').update(src).digest('hex').slice(0, 24) + '.mjs');
    if (!existsSync(file)) writeFileSync(file, src);
    return pathToFileURL(file).href;
  },
  spawn: (url) => {
    const boot = `import { parentPort } from 'node:worker_threads'; globalThis.self = globalThis; self.postMessage = (m) => parentPort.postMessage(m); await import(${JSON.stringify(url)});`;
    const w = new Worker(new URL(nodeJsHost.makeModuleURL(boot)));
    return { onMessage: (cb) => w.on('message', cb), onError: (cb) => w.on('error', cb), terminate: () => w.terminate() };
  },
});

export function freshWorkspace(seed = {}) {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  // The app hands its agent shell the kiln with kilnIsolate: every `python` starts from clean
  // builtins, the baseline sys.path and no workspace modules cached (apps/anvil/index.html).
  const kiln = bedKiln(fs);
  const shell = createShell({ registry, face, js: nodeJsHost, ...(kiln ? { kiln, kilnIsolate: true } : {}) });
  const ws = { backend, fs, shell, face, kiln, hooks: null };
  ws.ready = (async () => { for (const [p, c] of Object.entries(seed)) await fs.write(p, c); ws.hooks = await loadHooks(fs); })();
  return ws;
}

// Every file in the workspace, path → text. The grade diffs this against the seed, so a write by
// ANY route (write, edit, apply_patch, a shell redirect, sed -i, mv) is seen the same way.
export function snapshot(backend) {
  const out = new Map();
  for (const [path, entry] of backend.files) out.set(path, decoder.decode(entry.bytes));
  return out;
}

// Paths that differ between two snapshots: added, removed or changed.
export function changedPaths(before, after) {
  const out = [];
  for (const [p, t] of after) if (!before.has(p) || before.get(p) !== t) out.push(p);
  for (const p of before.keys()) if (!after.has(p)) out.push(p);
  return out.sort();
}

// One live OpenAI-compatible call, no retry (a bench that retries measures the retry). Returns the
// provider's `usage` so the recorder stores input tokens. `failures` counts calls that threw: a run
// with one is VOID — the provider did not answer, which is not a task failure.
export function liveInfer({ base, model, key, timeoutMs = 180000, log = () => {}, label = '', extraBody = {} }) {
  let n = 0;
  const infer = async ({ messages, tools }) => {
    const i = ++n;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = Date.now();
    let res, json;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', stream: false, temperature: 0, ...extraBody }),
        signal: ac.signal,
      });
      json = await res.json().catch(() => null);
    } catch (err) {
      clearTimeout(timer);
      infer.failures++;
      log(`${label} call ${i} FAILED after ${Math.round((Date.now() - t0) / 1000)}s: ${err.name === 'AbortError' ? `timeout >${timeoutMs / 1000}s` : err.message}`);
      throw err;
    }
    clearTimeout(timer);
    if (!res.ok) { infer.failures++; log(`${label} call ${i} http ${res.status}`); throw new Error(`http ${res.status}: ${String(json?.error?.message || '').slice(0, 160)}`); }
    const m = json?.choices?.[0]?.message || {};
    // OpenRouter reports what each call cost; summed per run, it is a measured cost, not an estimate.
    if (json?.usage && json.usage.cost !== undefined) { infer.cost += Number(json.usage.cost) || 0; infer.costSeen = true; }
    log(`${label} call ${i}: ${Math.round((Date.now() - t0) / 1000)}s, ${json?.usage?.prompt_tokens ?? '?'}+${json?.usage?.completion_tokens ?? '?'} tok, ${(m.tool_calls || []).length} tool call(s)`);
    return {
      content: m.content || '',
      toolCalls: (m.tool_calls || []).map((c) => ({ id: c.id, type: 'function', function: { name: c.function?.name, arguments: c.function?.arguments } })),
      finishReason: json?.choices?.[0]?.finish_reason,
      model: json?.model || model,
      usage: json?.usage || null,
    };
  };
  infer.failures = 0; infer.cost = 0; infer.costSeen = false;
  return infer;
}

// List prices in USD per million tokens, from the claude-api skill's cached table (2026-10-06; first-party API, prompts
// up to 100K tokens). Cache writes are priced at 1.25× input (the 5-minute write rate), an ASSUMPTION not re-checked here.
export const CLAUDE_PRICES = Object.freeze({
  'claude-opus-5-5': { in: 4, out: 20, read: 0.2, write: 5 },
  'claude-sonnet-5-5': { in: 2, out: 10, read: 0.2, write: 2.5 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, read: 0.01, write: 0.125 },
});

// A spending ceiling shared by every run of one command. `add` is called with each call's cost; once the total
// passes the ceiling, `exceeded()` is true, workers stop taking jobs, and any further call throws (its run is VOID).
export function createBudget(ceilingUsd) {
  const b = { ceilingUsd, spent: 0, calls: 0, tripped: false };
  b.add = (usd) => { b.spent += usd; b.calls++; if (b.spent >= b.ceilingUsd) b.tripped = true; };
  b.exceeded = () => b.tripped;
  return b;
}

// One live call to the native Anthropic Messages API (POST /v1/messages), through the app's own protocol module
// (sys/ai/anthropic-protocol.mjs) so the request carries the same `cache_control` and thinking-block replay the app sends.
// No retry (a bench that retries measures the retry). No temperature/top_p (the API rejects them). Effort is set
// explicitly, never left to a model default. Returns the OpenAI-shaped result liveInfer returns, plus cache counts and a
// cost computed from CLAUDE_PRICES. A refusal makes the call fail, so the run is VOID, never a task failure.
export function liveInferAnthropic({ base = 'https://api.anthropic.com', model, key, effort = 'medium', maxTokens = 16000, timeoutMs = 300000, budget = null, log = () => {}, label = '' }) {
  const price = CLAUDE_PRICES[model];
  if (!price) throw new Error(`no price for ${model}: add it to CLAUDE_PRICES before a paid run`);
  const replay = new Map();
  let n = 0;
  const infer = async ({ messages, tools }) => {
    const i = ++n;
    if (budget?.exceeded()) { infer.failures++; throw new Error('spending ceiling reached'); }
    const body = { model, ...toAnthropicRequest({ messages, maxTokens, tools, toolChoice: 'auto', replay }), output_config: { effort } };
    // Prefix check (Droid's "append-only" measure): the provider caches by prefix in the order tools, system, messages, so a request
    // is append-only when the previous request's tools and system are unchanged and its messages are an exact prefix of this one's.
    const cur = { tools: JSON.stringify(body.tools || null), system: JSON.stringify(body.system ?? null), messages: body.messages.map((m) => JSON.stringify(m)) };
    if (infer.prev) {
      let part = null;
      if (infer.prev.tools !== cur.tools) part = 'tools';
      else if (infer.prev.system !== cur.system) part = 'system';
      else { for (let k = 0; k < infer.prev.messages.length; k++) if (cur.messages[k] !== infer.prev.messages[k]) { part = `messages[${k}]`; break; } }
      infer.prefix.calls++;
      if (part === null) infer.prefix.appendOnly++; else infer.prefix.breaks.push({ call: i, part });
    }
    infer.prev = cur;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = Date.now();
    let res, json;
    try {
      res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body), signal: ac.signal,
      });
      json = await res.json().catch(() => null);
    } catch (err) {
      clearTimeout(timer); infer.failures++;
      log(`${label} call ${i} FAILED after ${Math.round((Date.now() - t0) / 1000)}s: ${err.name === 'AbortError' ? `timeout >${timeoutMs / 1000}s` : err.message}`);
      throw err;
    }
    clearTimeout(timer);
    if (!res.ok) { infer.failures++; log(`${label} call ${i} http ${res.status}`); throw new Error(`http ${res.status}: ${String(json?.error?.message || '').slice(0, 160)}`); }
    const m = fromAnthropicMessage(json);
    if (m.refusal) { infer.failures++; log(`${label} call ${i} refusal ${m.refusal}`); throw new Error(`refusal: ${m.refusal}`); }
    replay.set(replayKey({ content: m.text, toolCalls: m.toolCalls }), json.content);
    const u = json.usage || {};
    const read = u.cache_read_input_tokens || 0, write = u.cache_creation_input_tokens || 0, fresh = u.input_tokens || 0, out = u.output_tokens || 0;
    const usd = (fresh * price.in + read * price.read + write * price.write + out * price.out) / 1e6;
    if (infer.firstPrompt === null) infer.firstPrompt = fresh + read + write;
    infer.cost += usd; infer.costSeen = true; infer.cacheRead += read; infer.cacheWrite += write; infer.freshInput += fresh; infer.output += out;
    budget?.add(usd);
    log(`${label} call ${i}: ${Math.round((Date.now() - t0) / 1000)}s, in ${fresh}+${read}r+${write}w out ${out}, ${m.toolCalls.length} tool call(s), $${usd.toFixed(4)}`);
    return { content: m.text, toolCalls: m.toolCalls, finishReason: m.finishReason, model: json.model || model, usage: m.usage };
  };
  infer.failures = 0; infer.cost = 0; infer.costSeen = false; infer.cacheRead = 0; infer.cacheWrite = 0; infer.freshInput = 0; infer.output = 0;
  infer.prev = null; infer.prefix = { calls: 0, appendOnly: 0, breaks: [] }; infer.firstPrompt = null;
  return infer;
}

// A scripted model: one reply per step. A step is `{ tool, args }`, `{ calls: [{tool, args}, …] }`
// or `{ say: 'text' }` (a no-tool reply). Past the script it says nothing, which ends the loop.
export function scriptedInfer(steps) {
  let k = 0;
  const infer = async () => {
    const s = steps[k++];
    if (!s) return { content: '', toolCalls: [], finishReason: 'stop' };
    if (s.say !== undefined) return { content: s.say, toolCalls: [], finishReason: 'stop' };
    const calls = s.calls || [s];
    return { content: s.text || '', finishReason: 'tool_calls', toolCalls: calls.map((c, j) => ({ id: `s${k}_${j}`, type: 'function', function: { name: c.tool, arguments: JSON.stringify(c.args || {}) } })) };
  };
  infer.failures = 0;
  return infer;
}

// What the run produced that a grade can read. `answer` is the last non-empty assistant text.
function readOut(rec) {
  let answer = '', input = 0, output = 0, priced = 0, calls = 0;
  const toolNames = [];
  for (const e of rec.events()) {
    if (e.tool === 'llm.responded') {
      const o = rec.resolve(e).output || {};
      calls++;
      if (typeof o.content === 'string' && o.content.trim()) answer = o.content;
      if (o.usage) { priced++; input += Number(o.usage.prompt) || 0; output += Number(o.usage.completion) || 0; }
    }
    if (e.tool === 'tool.called') toolNames.push(rec.resolve(e).input?.name);
  }
  return { answer, usage: { calls, priced, input, output }, toolNames };
}

// Script mode (the app's `codemode` tool, opt-in per task in Anvil) in the node bed. The app runs the guest in a browser
// Worker; here a node worker_threads Worker runs the same module (sys/ai/codemode-worker.mjs) behind a small shim: it gives
// the module `self`, `postMessage` and `onmessage`, and a `fetch` that reads file: URLs (the guest loads its pinned
// QuickJS WASM that way and node's fetch refuses file: URLs). Nested tool calls run through the bed's own executor, one at a
// time, and are counted in `stats.nested`. The guest store is not carried between scripts (the app persists it on the run
// record; the bed does not), so a script cannot load() a value an earlier script stored.
function nodeWorkerFactory(url) {
  const boot = `import { parentPort } from 'node:worker_threads'; import { readFile } from 'node:fs/promises'; import { fileURLToPath } from 'node:url';
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => { const s = String(u); if (s.startsWith('file:')) { const b = await readFile(fileURLToPath(s)); return new Response(b, { headers: { 'content-type': s.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' } }); } return realFetch(u, o); };
globalThis.self = globalThis; globalThis.postMessage = (m) => parentPort.postMessage(m);
parentPort.on('message', (data) => { if (typeof globalThis.onmessage === 'function') globalThis.onmessage({ data }); });
await import(${JSON.stringify(String(url))});`;
  const w = new Worker(new URL('data:text/javascript,' + encodeURIComponent(boot)));
  return {
    postMessage: (m) => w.postMessage(m), terminate: () => w.terminate(),
    set onmessage(cb) { w.on('message', (data) => cb({ data })); },
    set onerror(cb) { w.on('error', (e) => cb({ message: e.message, preventDefault() {} })); },
  };
}

export function withScript(executeTool, { allowed, stats }) {
  let queue = Promise.resolve();
  return async (name, args, call) => {
    if (name !== 'codemode') return executeTool(name, args, call);
    stats.scripts++;
    const outcome = await runCodemode({
      code: args?.code, tools: allowed, store: {}, deadlineMs: 10000, workerFactory: nodeWorkerFactory,
      execute: (n, a) => { stats.nested++; const next = queue.then(() => executeTool(n, a, { id: `${call?.id || 'script'}:${stats.nested}` })); queue = next.catch(() => {}); return next; },
    });
    if (!outcome.ok) { stats.failed++; return 'Error: codemode ' + outcome.error + '\n' + outcome.output + '\nUnsettled nested calls: ' + outcome.pending.join(','); }
    return 'Codemode completed\n' + outcome.output + (outcome.pending.length ? '\nCancelled unawaited calls: ' + outcome.pending.join(',') : '');
  };
}

// Run ONE task once. `infer` is the model; `stamp` names it on run.started. Returns the grade, the
// record's metrics, token usage, and the record itself (exported) for the optimizer to read later.
export async function runTask(task, { infer, stamp = null, sysPrior = undefined, script = false, scriptHint = '', extraHint = '' }) {
  const ws = freshWorkspace(task.seed || {});
  await ws.ready;
  const seedSnap = snapshot(ws.backend);
  const rec = createRunRecorder({ app: 'autoharness', principal: 'autoharness' });
  const ctx = { task, ws, seedSnap };
  const gated = !!task.gated;
  // The in-loop gate sees the workspace only — the answer and the record are not final yet.
  const verify = gated ? async () => {
    const g = await task.gate(gradeContext(ctx, { answer: '', metrics: null, stop: null }));
    return { ok: !!g.ok, exit: g.ok ? 0 : 1, stdout: '', stderr: g.ok ? '' : String(g.why || 'gate failed') };
  } : null;
  const baseTools = runToolset('code', { verify: gated, simple: isSimpleAsk(task.prompt) });
  const scriptStats = { scripts: 0, nested: 0, failed: 0 };
  let exec = withHooks(withBedStubs(makeToolExecutor({ shell: ws.shell, face: ws.face, mode: 'code', infer })), { hooks: () => ws.hooks, shellFor: () => ws.shell });
  // Script mode needs the app's own gate: scripts are for code mode, never for a simple ask.
  const scriptOn = !!script && !isSimpleAsk(task.prompt);
  if (scriptOn) exec = withScript(exec, { allowed: baseTools.map((x) => x.function.name).filter((n) => CODEMODE_TOOL_NAMES.includes(n)), stats: scriptStats });
  const convo = [...(task.carry || []), { role: 'user', content: task.prompt }, ...(task.after || [])];
  const t0 = Date.now();
  let result = null, crash = null;
  try {
    result = await driveRun({
      mode: 'code', convo,
      sysMsg: (extra) => systemMessage({ mode: 'code', ...(sysPrior !== undefined ? { proceduralPrior: sysPrior } : {}), extra: [extra, extraHint, scriptOn && scriptHint].filter(Boolean).join('\n\n') }),
      tools: scriptOn ? codemodeCatalog(baseTools, { enabled: true, mode: 'code' }) : baseTools,
      infer: rec.wrapInfer(infer), executeTool: exec, rec, verify, onEvent: rec.onEvent,
      gateNote: gated ? gateNote('bench gate: ' + task.id) : '', model: () => stamp,
    });
  } catch (e) { crash = String(e && e.message || e); }
  await rec.settled();
  const wallMs = Date.now() - t0;
  const metrics = metricsOf(rec);
  const out = readOut(rec);
  const g = await task.gate(gradeContext(ctx, { answer: out.answer, metrics, stop: result?.stop ?? null }));
  const isVoid = infer.failures > 0 || (out.usage.calls > 0 && !out.answer && metrics.toolCalls === 0);
  return {
    id: task.id, pass: !!g.ok, why: g.ok ? '' : String(g.why || ''), void: isVoid, crash,
    stop: result?.stop ?? 'crash', steps: metrics.steps, toolCalls: metrics.toolCalls, label: metrics.label,
    script: script ? { on: scriptOn, hint: !!(scriptOn && scriptHint), ...scriptStats } : null,
    usage: out.usage, costReported: infer.costSeen ? infer.cost : null, cache: infer.cacheRead !== undefined ? { read: infer.cacheRead, write: infer.cacheWrite, fresh: infer.freshInput, output: infer.output } : null, prefix: infer.prefix ? { ...infer.prefix, firstPrompt: infer.firstPrompt } : null, tools: out.toolNames, answer: out.answer.slice(0, 2000), wallMs,
    python: ws.kiln ? { ...ws.kiln.stats } : null, // what python cost this run; null in a bed without it
    changed: changedPaths(seedSnap, snapshot(ws.backend)),
    record: rec.export(),
  };
}

// What a gate reads. `file(p)` is the final text or null; `changed` is every path that differs from
// the seed; `answer` the last assistant text; `metrics` the record's (null inside the loop).
function gradeContext({ ws, seedSnap }, { answer, metrics, stop }) {
  const files = snapshot(ws.backend);
  return {
    files, seed: seedSnap, answer: String(answer || ''), metrics, stop,
    file: (p) => (files.has(p) ? files.get(p) : null),
    changed: changedPaths(seedSnap, files),
  };
}
