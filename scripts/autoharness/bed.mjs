// The autoharness bed: one battery task, run through what the app runs, graded after the fact.
//
// Same assembly as scripts/bench-procedural.mjs (sys/ai/run-assembly.mjs: prompt bytes, toolset,
// budgets, hooks, act-or-nudge, supervisor), over an in-memory workspace. Two things differ from
// that bench on purpose:
//   - the grade is a function over the FINISHED run (workspace diff, final answer, record metrics),
//     not only the in-loop gate. Only tasks marked `gated` also hand the gate to the loop.
//   - the live infer returns the provider's `usage`, so the record carries input tokens per call.
//
// This is a NODE bed: no Kiln (python refuses), no host context message (project notes, memory and
// skills indexes), no recovery-note fold over a real prior record. Every number from it names this
// bed, not the app (plan/bench-playbook.md §2).
import { makeToolExecutor } from '../../sys/ai/agent-tools.mjs';
import { buildRigRegistry } from '../../sys/rig/registry/index.mjs';
import { createFileops, MemoryBackend } from '../../sys/rig/fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../sys/rig/agent/index.mjs';
import { createShell } from '../../sys/rig/cli/shell.mjs';
import { createRunRecorder } from '../../sys/history/run-record.mjs';
import { metricsOf } from '../../sys/ai/ablate.mjs';
import { createHash } from 'node:crypto';
import { systemMessage, gateNote, runToolset, driveRun, withHooks, withBedStubs, loadHooks, isSimpleAsk } from '../../sys/ai/run-assembly.mjs';

const decoder = new TextDecoder();

// What identifies the harness under test: the code-mode system prompt and the gated tool schemas.
// Two runs with the same fingerprint ran the same prompt bytes and the same tool descriptions.
export function harnessFingerprint() {
  const h = createHash('sha256');
  h.update(systemMessage({ mode: 'code' }).content);
  h.update(JSON.stringify(runToolset('code', { verify: true })));
  return h.digest('hex').slice(0, 16);
}

export function freshWorkspace(seed = {}) {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  const shell = createShell({ registry, face });
  const ws = { backend, fs, shell, face, hooks: null };
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
    log(`${label} call ${i}: ${Math.round((Date.now() - t0) / 1000)}s, ${json?.usage?.prompt_tokens ?? '?'}+${json?.usage?.completion_tokens ?? '?'} tok, ${(m.tool_calls || []).length} tool call(s)`);
    return {
      content: m.content || '',
      toolCalls: (m.tool_calls || []).map((c) => ({ id: c.id, type: 'function', function: { name: c.function?.name, arguments: c.function?.arguments } })),
      finishReason: json?.choices?.[0]?.finish_reason,
      model: json?.model || model,
      usage: json?.usage || null,
    };
  };
  infer.failures = 0;
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

// Run ONE task once. `infer` is the model; `stamp` names it on run.started. Returns the grade, the
// record's metrics, token usage, and the record itself (exported) for the optimizer to read later.
export async function runTask(task, { infer, stamp = null, sysPrior = undefined }) {
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
  const exec = withHooks(withBedStubs(makeToolExecutor({ shell: ws.shell, face: ws.face, mode: 'code', infer })), { hooks: () => ws.hooks, shellFor: () => ws.shell });
  const convo = [...(task.carry || []), { role: 'user', content: task.prompt }, ...(task.after || [])];
  const t0 = Date.now();
  let result = null, crash = null;
  try {
    result = await driveRun({
      mode: 'code', convo,
      sysMsg: (extra) => systemMessage({ mode: 'code', ...(sysPrior !== undefined ? { proceduralPrior: sysPrior } : {}), extra }),
      tools: runToolset('code', { verify: gated, simple: isSimpleAsk(task.prompt) }),
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
    usage: out.usage, tools: out.toolNames, answer: out.answer.slice(0, 2000), wallMs,
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
