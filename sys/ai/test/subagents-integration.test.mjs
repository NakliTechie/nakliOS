// Integration — the supervisor `dispatch`/`review` tools driving REAL subagents
// over isolated OverlayBackend worktrees, merged back through a byte-accurate
// fileops applier that MIRRORS the production one in apps/anvil/index.html
// (fs.write(rel, bytes) + toRel root-stripping — NOT a byte-shortcut). A scripted
// infer stands in for the host AI (the C2 FakeTransport pattern).
//   node sys/ai/test/subagents-integration.test.mjs
import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { OverlayBackend } from '../../rig/fileops/overlay-backend.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../rig/agent/index.mjs';
import { createShell } from '../../rig/cli/shell.mjs';
import { makeToolExecutor } from '../agent-tools.mjs';

let passed = 0; const failures = [];
async function test(n, fn){ try { await fn(); passed++; } catch (e){ failures.push({ n, message: e.message + (e.stack ? '\n' + e.stack.split('\n')[1] : '') }); } }
function assert(c, m){ if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m){ if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
const dec = (u) => new TextDecoder().decode(u);

// A scripted host AI. `plan(prompt, ctx)` returns a directive:
//   { write:{file,content} } | { read:{file} } | { loop:{file,content} } | { done:text }
// `loop` re-issues the SAME write every turn → the loop detects no-progress (a
// non-clean stop). Absent a directive, the subagent finishes on turn ≥2.
function scriptedInfer(plan, reviewText) {
  return async ({ messages }) => {
    const sys = String(messages[0]?.content || '');
    if (/read-only access|reviewer/i.test(sys)) return { content: reviewText || 'No issues found.', toolCalls: [] };
    // The OWNER's prompt — skipping [coordination] lines the loop itself wrote (a repeat
    // nudge, a gate verdict). A host that scans back for "the last user message" without
    // this picks up the machine's own voice and answers the wrong question (F7).
    const user = [...messages].reverse().find(m => m.role === 'user' && !/^\[coordination\]/.test(String(m.content || '')));
    const prompt = String(user?.content || '');
    const priorTools = messages.filter(m => m.role === 'tool').length;
    // The last tool result (so a reader can report what it saw).
    const lastTool = [...messages].reverse().find(m => m.role === 'tool');
    const d = plan(prompt, { priorTools, lastTool }) || {};
    if (d.loop) return { content: '', toolCalls: [{ id: 'l', function: { name: 'write', arguments: JSON.stringify({ path: d.loop.file, content: d.loop.content }) } }] };
    if (priorTools === 0 && d.write) return { content: '', toolCalls: [{ id: 'w', function: { name: 'write', arguments: JSON.stringify({ path: d.write.file, content: d.write.content }) } }] };
    if (priorTools === 0 && d.read) return { content: '', toolCalls: [{ id: 'r', function: { name: 'read', arguments: JSON.stringify({ path: d.read.file }) } }] };
    if (d.read && lastTool) return { content: 'SIBLING-READ-RESULT: ' + String(lastTool.content).slice(0, 80), toolCalls: [] };
    return { content: d.done || 'Done.', toolCalls: [] };
  };
}

// Mirrors apps/anvil/index.html spawnIsolated: a fresh executor over a COW
// overlay of `base`, whose commit replays the overlay onto the real base via a
// byte-accurate fileops write (the SAME shape as production — proves F2 fixed).
function makeSpawnIsolated(base, infer, root = '') {
  const realFs = createFileops({ backend: base, root });
  const toRel = (p) => (root && p.startsWith(root + '/')) ? p.slice(root.length + 1) : p;
  return async () => {
    const overlay = new OverlayBackend(base);
    const ofs = createFileops({ backend: overlay, root });
    const registry = buildRigRegistry({ fs: ofs });
    const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
    const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
    const face = createAgentFace({ registry, grant, opLog, actor: 'agent' });
    const shell = createShell({ registry, face });
    const executor = makeToolExecutor({ shell, face, mode: 'code', infer, subagentDepth: 1 });
    return {
      executor,
      changes: () => overlay.changes(),
      commit: async () => overlay.commit({
        write: async (p, bytes) => { await realFs.write(toRel(p), bytes); }, // byte-accurate, like production
        remove: async (p) => { await realFs.remove(toRel(p)); },
      }),
    };
  };
}

function topExecutor(base, infer, root = '') {
  const fs = createFileops({ backend: base, root });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent' });
  const shell = createShell({ registry, face });
  return makeToolExecutor({ shell, face, mode: 'code', infer, subagentDepth: 0, spawnIsolated: makeSpawnIsolated(base, infer, root) });
}

await test('dispatch: two disjoint subagents run in parallel and both merge back', async () => {
  const base = new MemoryBackend();
  const infer = scriptedInfer((p) =>
    /alpha/i.test(p) ? { write: { file: 'alpha.txt', content: 'ALPHA' } } :
    /beta/i.test(p)  ? { write: { file: 'beta.txt',  content: 'BETA'  } } : { done: 'nothing' });
  const exec = topExecutor(base, infer);
  const out = await exec('dispatch', { tasks: [
    { description: 'make alpha', prompt: 'Create alpha.txt' },
    { description: 'make beta',  prompt: 'Create beta.txt' },
  ] });
  eq(dec(await base.readBinary('alpha.txt')), 'ALPHA', 'alpha merged to base');
  eq(dec(await base.readBinary('beta.txt')), 'BETA', 'beta merged to base');
  assert(out.includes('merged'), 'digest reports merged');
  assert(!/path conflict/.test(out), 'no conflict for disjoint work');
});

await test('dispatch: conflicting subagents (same path) merge NOTHING, base untouched', async () => {
  const base = new MemoryBackend();
  await base.write('shared.txt', new TextEncoder().encode('ORIGINAL'));
  const infer = scriptedInfer((p) =>
    /first/i.test(p) ? { write: { file: 'shared.txt', content: 'FROM-1' } } : { write: { file: 'shared.txt', content: 'FROM-2' } });
  const exec = topExecutor(base, infer);
  const out = await exec('dispatch', { tasks: [
    { description: 'w1', prompt: 'first: overwrite shared.txt' },
    { description: 'w2', prompt: 'second: overwrite shared.txt' },
  ] });
  eq(dec(await base.readBinary('shared.txt')), 'ORIGINAL', 'base NOT mutated on conflict');
  assert(/path conflict/.test(out), 'digest reports the conflict');
  assert(out.includes('shared.txt'), 'names the conflicting path');
});

await test('dispatch: a subagent that never finishes (no-progress) is HELD — its partial write is NOT committed (F1)', async () => {
  const base = new MemoryBackend();
  const infer = scriptedInfer((p) =>
    /stuck/i.test(p) ? { loop: { file: 'half.txt', content: 'PARTIAL' } } : { write: { file: 'good.txt', content: 'GOOD' } });
  const exec = topExecutor(base, infer);
  const out = await exec('dispatch', { tasks: [
    { description: 'stuck one', prompt: 'stuck: keep trying' },
    { description: 'good one',  prompt: 'do the good thing' },
  ] });
  eq(await base.exists('half.txt'), false, 'partial write from the stuck subagent was NOT merged');
  eq(dec(await base.readBinary('good.txt')), 'GOOD', 'the clean sibling still merged');
  assert(/did not finish cleanly/.test(out), 'stuck subagent honestly labeled held, not merged');
});

await test('dispatch: overlays are isolated — a subagent reading a sibling target sees BASE, not the sibling write', async () => {
  const base = new MemoryBackend();
  // 'writer' creates secret.txt; 'reader' tries to read secret.txt. If overlays
  // leaked, the reader would see WRITER-SECRET; isolated, it sees absence.
  const infer = scriptedInfer((p) =>
    /writer/i.test(p) ? { write: { file: 'secret.txt', content: 'WRITER-SECRET' } } : { read: { file: 'secret.txt' } });
  const exec = topExecutor(base, infer);
  const out = await exec('dispatch', { tasks: [
    { description: 'writer', prompt: 'writer: create secret.txt' },
    { description: 'reader', prompt: 'reader: read secret.txt and report' },
  ] });
  // The reader's own report is inside its subagent text → surfaced in the digest.
  assert(!/WRITER-SECRET/.test(out), 'reader never observed the sibling overlay write (isolation holds)');
  eq(dec(await base.readBinary('secret.txt')), 'WRITER-SECRET', 'writer still merged to base');
});

await test('review: reviewer subagent returns findings and writes NOTHING to base', async () => {
  const base = new MemoryBackend();
  await base.write('app.js', new TextEncoder().encode('function f(){ return 1 }'));
  const infer = scriptedInfer(() => ({ done: 'ok' }), 'app.js:1 — f always returns 1; looks intentional. No blocking issues.');
  const exec = topExecutor(base, infer);
  const before = (await base.list('')).length;
  const out = await exec('review', { prompt: 'Review app.js for correctness.' });
  assert(/no blocking issues/i.test(out), 'review findings returned');
  eq((await base.list('')).length, before, 'reviewer did not add files to base');
});

// ESS-1 (2026-09-11): a subagent is a child of the run. Stop stops it, and nothing merges after.
function supervisedExecutor(base, infer, { signal = null, subagentBudget = null } = {}) {
  const fs = createFileops({ backend: base });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent' });
  const shell = createShell({ registry, face });
  return makeToolExecutor({ shell, face, mode: 'code', infer, subagentDepth: 0, spawnIsolated: makeSpawnIsolated(base, infer), signal, subagentBudget });
}

await test('ESS-1: Stop mid-dispatch — the children stop, and a sibling that had already finished is NOT merged', async () => {
  const base = new MemoryBackend();
  const ac = new AbortController();
  const calls = { a: 0, b: 0 };
  // Child A finishes cleanly on its first turn (write, then done). Child B's first model call
  // presses Stop on the parent, then answers with a write it would do next.
  const infer = async ({ messages }) => {
    const user = [...messages].reverse().find(m => m.role === 'user');
    const prompt = String(user?.content || '');
    const priorTools = messages.filter(m => m.role === 'tool').length;
    if (/^A:/.test(prompt)) {
      calls.a++;
      if (priorTools === 0) return { content: '', toolCalls: [{ id: 'wa', function: { name: 'write', arguments: JSON.stringify({ path: 'a.txt', content: 'A was here' }) } }] };
      return { content: 'A done.', toolCalls: [] };
    }
    calls.b++;
    ac.abort();
    return { content: '', toolCalls: [{ id: 'wb', function: { name: 'write', arguments: JSON.stringify({ path: 'b.txt', content: 'B was here' }) } }] };
  };
  const exec = supervisedExecutor(base, infer, { signal: ac.signal });
  const out = await exec('dispatch', { tasks: [{ label: 'A', prompt: 'A: write a.txt' }, { label: 'B', prompt: 'B: write b.txt' }] }, { id: 'd1' });
  assert(/STOPPED — the owner ended the run/.test(out), `the digest says stopped: ${out.slice(0, 200)}`);
  assert(!/— merged$/m.test(out), 'no subagent line reads "— merged"');
  const realFs = createFileops({ backend: base });
  eq((await realFs.read('a.txt')).ok, false, "A finished cleanly BEFORE the stop and is still not merged — a stop means the workspace is as it was");
  eq((await realFs.read('b.txt')).ok, false, 'B never landed');
  eq(calls.b, 1, 'B made no further model calls after the stop');
});

await test('ESS-1: a child carries its own wall clock — a slow child stops on budget, not the parent\'s patience', async () => {
  const base = new MemoryBackend();
  let n = 0;
  const slow = async ({ messages }) => {
    n++; await new Promise(r => setTimeout(r, 30));
    // never finishes on its own: a different write every turn (no no-progress trip)
    return { content: '', toolCalls: [{ id: 'w' + n, function: { name: 'write', arguments: JSON.stringify({ path: `f${n}.txt`, content: 'x' }) } }] };
  };
  const exec = supervisedExecutor(base, slow, { subagentBudget: { wallClockMs: 70 } });
  const t0 = Date.now();
  const out = await exec('task', { prompt: 'keep writing' }, { id: 't1' });
  const took = Date.now() - t0;
  assert(/\(subagent finished: budget\)/.test(out), `stopped on the child budget: ${out}`);
  assert(took < 2000 && n <= 6, `the wall clock ended it early (took ${took}ms, ${n} calls)`);
});

await test('ESS-1: the executor writes the start claim BEFORE the child makes its first model call', async () => {
  const base = new MemoryBackend();
  const order = [];
  const fs = createFileops({ backend: base });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent' });
  const shell = createShell({ registry, face });
  const infer = async () => { order.push('infer'); return { content: 'done', toolCalls: [] }; };
  const exec = makeToolExecutor({ shell, face, mode: 'code', infer, subagentDepth: 0, spawnIsolated: makeSpawnIsolated(base, infer),
    recordSubagentStart: async (m) => { order.push('start:' + m.kind + ':' + m.label); },
    recordSubagent: async (m) => { order.push('ran:' + m.kind); } });
  await exec('dispatch', { tasks: [{ label: 'L', prompt: 'do' }] }, { id: 'd9' });
  assert(/^start:dispatch:/.test(order[0]), `the claim is first: ${order.join(' > ')}`);
  eq(order[1], 'infer', 'then the child runs');
  eq(order[order.length - 1], 'ran:dispatch', 'and reports back last');
});

await test('ESS-2: the parent sees each child\'s tool calls live, tagged and BEFORE the child reports back', async () => {
  const base = new MemoryBackend();
  const order = [];
  const fs = createFileops({ backend: base });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent' });
  const shell = createShell({ registry, face });
  const infer = scriptedInfer((prompt) => (/^A:/.test(prompt) ? { write: { file: 'a.txt', content: 'A' } } : { write: { file: 'b.txt', content: 'B' } }));
  const exec = makeToolExecutor({ shell, face, mode: 'code', infer, subagentDepth: 0, spawnIsolated: makeSpawnIsolated(base, infer),
    onSubagentEvent: (m) => { order.push(`${m.kind}:${m.label}:${m.event.type}${m.event.type === 'tool-call' ? ':' + m.event.name + ':' + (m.event.args && m.event.args.path) : ''}`); },
    recordSubagent: async (m) => { order.push('ran:' + m.label); } });
  await exec('dispatch', { tasks: [{ label: 'A', prompt: 'A: write a.txt' }, { label: 'B', prompt: 'B: write b.txt' }] }, { id: 'd2' });
  // the label a dispatch reports is the task's label or its prompt — match on the prefix
  const aCall = order.findIndex((x) => /^dispatch:A[^>]*:tool-call:write:a\.txt$/.test(x));
  const bCall = order.findIndex((x) => /^dispatch:B[^>]*:tool-call:write:b\.txt$/.test(x));
  const aRan = order.findIndex((x) => /^ran:A/.test(x)), bRan = order.findIndex((x) => /^ran:B/.test(x));
  assert(aCall >= 0 && bCall >= 0, `both children's writes were seen live, tagged by label: ${order.join(' > ')}`);
  assert(aRan >= 0 && aCall < aRan, 'A\'s call was seen before A reported back');
  assert(bRan >= 0 && bCall < bRan, 'B\'s call was seen before B reported back');
  assert(order.some((x) => /^dispatch:A[^>]*:turn-start$/.test(x)), 'turn starts are forwarded too');
});
await test('ESS-2: a throwing observer never breaks the child, and the feed works with no recorder at all', async () => {
  const base = new MemoryBackend();
  let seen = 0;
  const infer = scriptedInfer(() => ({ write: { file: 'c.txt', content: 'C' } }));
  const fs = createFileops({ backend: base });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent' });
  const shell = createShell({ registry, face });
  const exec = makeToolExecutor({ shell, face, mode: 'code', infer, subagentDepth: 0, spawnIsolated: makeSpawnIsolated(base, infer),
    onSubagentEvent: () => { seen++; throw new Error('observer exploded'); } });
  const out = await exec('dispatch', { tasks: [{ label: 'C', prompt: 'write c.txt' }] }, { id: 'd3' });
  assert(/— merged$/m.test(out), `the child finished and merged despite the observer: ${out.slice(0, 160)}`);
  eq(dec((await createFileops({ backend: base }).read('c.txt')).data), 'C', 'its write landed');
  assert(seen > 0, 'the observer was called (no recorder wired, so the tap alone carried it)');
});

await test('ESS-3: a per-call budget ends a child sooner than the default, and the digest says what was used', async () => {
  const base = new MemoryBackend();
  let n = 0;
  const endless = async () => { n++; return { content: '', toolCalls: [{ id: 'w' + n, function: { name: 'write', arguments: JSON.stringify({ path: `f${n}.txt`, content: 'x' }) } }] }; };
  const exec = supervisedExecutor(base, endless);
  const out = await exec('dispatch', { tasks: [{ label: 'E', prompt: 'keep writing' }], max_steps: 2 }, { id: 'd4' });
  assert(/budget per subagent: 2 steps, 240 s/.test(out), `the digest states the budget: ${out.split('\n')[0]}`);
  assert(/held — subagent did not finish cleanly \(max-steps\)/.test(out), `the child ended on the 2-step budget: ${out.slice(0, 240)}`);
  assert(n <= 3, `at most a couple of model calls, got ${n}`);
  n = 0;
  const slow = async () => { n++; await new Promise(r => setTimeout(r, 30)); return { content: '', toolCalls: [{ id: 's' + n, function: { name: 'write', arguments: JSON.stringify({ path: `g${n}.txt`, content: 'x' }) } }] }; };
  const exec2 = supervisedExecutor(base, slow);
  const t0 = Date.now();
  const out2 = await exec2('task', { prompt: 'keep writing', wall_clock_s: 1 }, { id: 't4' });
  // wall_clock_s floors at 5 s — so this proves the FLOOR, not a 1 s clock: the child runs out its 16 steps first (16 × 30 ms ≈ 0.5 s < 5 s)
  assert(/finished: max-steps/.test(out2) && Date.now() - t0 < 5000, `the floor held; the child hit its steps first: ${out2}`);
});
await test('ESS-3: an executor-level budget still applies when the call names none', async () => {
  const base = new MemoryBackend();
  let n = 0;
  const slow = async () => { n++; await new Promise(r => setTimeout(r, 30)); return { content: '', toolCalls: [{ id: 'q' + n, function: { name: 'write', arguments: JSON.stringify({ path: `h${n}.txt`, content: 'x' }) } }] }; };
  const exec = supervisedExecutor(base, slow, { subagentBudget: { wallClockMs: 70 } });
  const out = await exec('task', { prompt: 'keep writing' }, { id: 't5' });
  assert(/finished: budget/.test(out), `the configured wall clock ended it: ${out}`);
  // and through dispatch — where a clamped default of 240 s would silently override 70 ms
  n = 0;
  const out2 = await exec('dispatch', { tasks: [{ label: 'S', prompt: 'keep writing' }] }, { id: 'd5' });
  assert(/held — subagent did not finish cleanly \(budget\)/.test(out2), `dispatch honoured the executor's wall clock: ${out2.slice(0, 200)}`);
});

await test('ESS-1: a run already stopped does not start a child at all', async () => {
  const base = new MemoryBackend();
  const ac = new AbortController(); ac.abort();
  let n = 0;
  const exec = supervisedExecutor(base, async () => { n++; return { content: 'x', toolCalls: [] }; }, { signal: ac.signal });
  const out = await exec('task', { prompt: 'anything' }, { id: 't2' });
  assert(/stopped with the run/.test(out), out);
  eq(n, 0, 'zero model calls');
});

await test('supervisor tools refuse to nest (depth cap) — a subagent has no dispatch', async () => {
  const base = new MemoryBackend();
  const fs = createFileops({ backend: base });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent' });
  const shell = createShell({ registry, face });
  const child = makeToolExecutor({ shell, face, mode: 'code', infer: async () => ({ content: '', toolCalls: [] }), subagentDepth: 1 });
  const out = await child('dispatch', { tasks: [{ prompt: 'x' }] });
  assert(/not available/i.test(out), 'nested dispatch refused');
});

if (failures.length){
  console.error(`subagents-integration: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`subagents-integration conformance: ${passed}/${passed} passed`);
