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
import { createSteerQueue } from '../steer.mjs';
import { formatDispatchDigest } from '../subagents.mjs';

let passed = 0; const failures = [];
async function test(n, fn){ try { await fn(); passed++; } catch (e){ failures.push({ n, message: e.message + (e.stack ? '\n' + e.stack.split('\n')[1] : '') }); } }
function assert(c, m){ if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m){ if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
const dec = (u) => new TextDecoder().decode(u);
const enc = (s) => new TextEncoder().encode(s);

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
      changes: () => { const c = overlay.changes(); return { written: (c.written || []).map(toRel), deleted: (c.deleted || []).map(toRel) }; }, // workspace-relative, as the app maps them
      moved: async () => { const m = await overlay.moved(); return { wrote: m.wrote.map(toRel), read: m.read.map(toRel) }; }, // #9: the fence, as the app maps it
      pinned: () => overlay.pinned().map(toRel),
      commit: async () => overlay.commit({
        write: async (p, bytes) => { await realFs.write(toRel(p), bytes); }, // byte-accurate, like production
        remove: async (p) => { await realFs.remove(toRel(p)); },
      }),
    };
  };
}

// B2: the same top executor, with a steer queue and a settle window
function topExecutorWith(base, infer, extra = {}) {
  const fs = createFileops({ backend: base, root: '' });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent' });
  const shell = createShell({ registry, face });
  return makeToolExecutor({ shell, face, mode: 'code', infer, subagentDepth: 0, spawnIsolated: makeSpawnIsolated(base, infer, ''), ...extra });
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
  assert(!/stale content/.test(out), 'nothing moved: no notice');
  // #9: a reviewer that read app.js while the owner rewrote it says so under its verdict
  const call = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });
  const moving = async ({ messages }) => { const sys = String(messages[0]?.content || ''); const tools = messages.filter((m) => m.role === 'tool'); if (!/read-only access|reviewer/i.test(sys)) return { content: '', toolCalls: [] }; if (tools.length === 0) return { content: '', toolCalls: [call('r', 'read', { path: 'app.js' })] }; await base.write('app.js', new TextEncoder().encode('function f(){ return 2 }')); return { content: 'app.js:1 — returns 1. Fine.', toolCalls: [] }; };
  const out2 = await topExecutor(base, moving)('review', { prompt: 'Review app.js again.' });
  assert(/Fine\.\n\n\[review read 1 file that changed under it since \(app\.js\) — its verdict may rest on stale content\]$/.test(out2), out2);
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

// ── CRIB-B B2: completion as a steer — a slow child no longer stalls the fan-out ──
const slowInfer = (plan, slowRe, ms) => async (a) => {
  const user = [...a.messages].reverse().find((m) => m.role === 'user' && !/^\[coordination\]/.test(String(m.content || '')));
  if (slowRe.test(String(user?.content || ''))) await new Promise((r) => setTimeout(r, ms));
  return plan(a);
};
await test('B2: the fast child is in the tool result at once; the slow one arrives as a steer and merges when it lands', async () => {
  const base = new MemoryBackend();
  const plan = scriptedInfer((p) => /fast/i.test(p) ? { write: { file: 'fast.txt', content: 'F' } } : { write: { file: 'slow.txt', content: 'S' } });
  const q = createSteerQueue();
  const exec = topExecutorWith(base, slowInfer(plan, /slow/i, 250), { steer: q, settleMs: 40 });
  const t0 = Date.now();
  const out = await exec('dispatch', { tasks: [{ description: 'fast', prompt: 'fast: create fast.txt' }, { description: 'slow', prompt: 'slow: create slow.txt' }] });
  assert(Date.now() - t0 < 200, 'the tool result did not wait for the slow child (' + (Date.now() - t0) + 'ms)');
  assert(/### \[1\] fast — merged/.test(out), out);
  assert(/### still in flight: "slow" — its completion will arrive as a \[coordination\] message/.test(out) && /do not re-dispatch it/.test(out), out);
  eq(dec(await base.readBinary('fast.txt')), 'F', 'the fast child merged at once');
  eq(await base.exists('slow.txt'), false, 'the slow one has not landed yet');
  eq(q.inFlight(), 1, 'tracked');
  await q.next(); // wakes on the steer
  const steers = q.take(); eq(steers.length, 1);
  assert(/^\[coordination\] subagent \[2\] "slow" finished — merged\. changes applied: wrote slow\.txt\./.test(steers[0].content), steers[0].content);
  eq(dec(await base.readBinary('slow.txt')), 'S', 'the slow child merged when it finished');
  await new Promise((r) => setTimeout(r, 0)); eq(q.inFlight(), 0);
});
// ── #9 snapshot-rooted overlays: the child's view is pinned; the fence at merge holds or says ──
// A child that reads shared.txt, reads it AGAIN after the base moved (the owner edited it), then writes.
// `outFile` decides the fence's verdict: writing elsewhere → merged with the read notice; writing
// shared.txt itself → held, the base keeps the owner's edit.
function movingBaseInfer(base, outFile) {
  const call = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });
  return async ({ messages }) => {
    const user = [...messages].reverse().find((m) => m.role === 'user' && !/^\[coordination\]/.test(String(m.content || '')));
    if (!/^child:/.test(String(user?.content || ''))) return { content: '', toolCalls: [] }; // the parent never speaks here
    const tools = messages.filter((m) => m.role === 'tool');
    if (tools.length === 0) return { content: '', toolCalls: [call('r1', 'read', { path: 'shared.txt' })] };
    if (tools.length === 1) { await base.write('shared.txt', enc('OWNER EDITED THIS')); return { content: '', toolCalls: [call('r2', 'read', { path: 'shared.txt' })] }; }
    if (tools.length === 2) return { content: '', toolCalls: [call('w', 'write', { path: outFile, content: 'derived from: ' + String(tools[1].content).replace(/\s+/g, ' ').slice(0, 40) })] };
    return { content: 'saw ' + String(tools[0].content).replace(/\s+/g, ' ').slice(0, 30) + ' then ' + String(tools[1].content).replace(/\s+/g, ' ').slice(0, 30), toolCalls: [] };
  };
}
await test('#9 the child\'s view is pinned: shared.txt reads the same before and after the owner edits it, and the digest says its result may be stale', async () => {
  const base = new MemoryBackend();
  await base.write('shared.txt', enc('ORIGINAL'));
  const exec = topExecutorWith(base, movingBaseInfer(base, 'out.txt'));
  const out = await exec('dispatch', { tasks: [{ description: 'reader', prompt: 'child: read shared.txt twice, write out.txt' }] });
  assert(/### \[1\] reader — merged · read 1 file that changed under it since \(shared\.txt\) — its result may rest on stale content/.test(out), out);
  assert(/saw\s+1 ORIGINAL then\s+1 ORIGINAL/.test(out) && !/OWNER EDITED/.test(out.split('changes applied')[1] || ''), 'the second read served the pinned bytes, not the moved base: ' + out);
  assert(/^derived from:\s+1 ORIGINAL$/.test(dec(await base.readBinary('out.txt'))), 'the derived write merged (it touched no moved path), from the pinned bytes');
  eq(dec(await base.readBinary('shared.txt')), 'OWNER EDITED THIS', 'the owner\'s edit stands');
});
await test('#9 the fence holds a child whose OUTPUT path moved under it — the owner\'s own edit, no sibling involved', async () => {
  const base = new MemoryBackend();
  await base.write('shared.txt', enc('ORIGINAL'));
  const exec = topExecutorWith(base, movingBaseInfer(base, 'shared.txt'));
  const out = await exec('dispatch', { tasks: [{ description: 'writer', prompt: 'child: read shared.txt twice, then rewrite it' }] });
  assert(/### \[1\] writer — held — path conflict — the workspace moved under it since it started \(shared\.txt changed in the base — your own edits, or another writer\); un-merging is not possible/.test(out), out);
  assert(/changes attempted \(NOT applied\): wrote shared\.txt/.test(out), out);
  eq(dec(await base.readBinary('shared.txt')), 'OWNER EDITED THIS', 'nothing landed on the moved base');
});
await test('#9 the same fence on the straggler path: the completion steer says the workspace moved under it', async () => {
  const base = new MemoryBackend();
  await base.write('shared.txt', enc('ORIGINAL'));
  const fast = scriptedInfer((p) => /fast/i.test(p) ? { write: { file: 'fast.txt', content: 'F' } } : null);
  const slow = movingBaseInfer(base, 'shared.txt');
  const infer = async (a) => { const user = [...a.messages].reverse().find((m) => m.role === 'user' && !/^\[coordination\]/.test(String(m.content || ''))); if (/^child:/.test(String(user?.content || ''))) { await new Promise((r) => setTimeout(r, 60)); return slow(a); } return fast(a); };
  const q = createSteerQueue();
  const exec = topExecutorWith(base, infer, { steer: q, settleMs: 40 });
  const out = await exec('dispatch', { tasks: [{ description: 'fast', prompt: 'fast: create fast.txt' }, { description: 'slow', prompt: 'child: rewrite shared.txt after reading it twice' }] });
  assert(/### \[1\] fast — merged/.test(out) && /still in flight: "slow"/.test(out), out);
  await q.next(); const steers = q.take(); eq(steers.length, 1);
  assert(/^\[coordination\] subagent \[2\] "slow" finished — held — the workspace moved under it since it started \(shared\.txt changed in the base — your own edits, or another writer\); un-merging is not possible\. changes attempted \(NOT applied\): wrote shared\.txt\./.test(steers[0].content), steers[0].content);
  eq(dec(await base.readBinary('shared.txt')), 'OWNER EDITED THIS', 'the straggler did not land on the moved base');
});
// #9 (checker): a READ-ONLY child gets the notice too — its report is what the parent acts on
function inspectorInfer(base) {
  const call = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });
  return async ({ messages }) => {
    const user = [...messages].reverse().find((m) => m.role === 'user' && !/^\[coordination\]/.test(String(m.content || '')));
    if (!/^inspect:/.test(String(user?.content || ''))) return { content: '', toolCalls: [] };
    const tools = messages.filter((m) => m.role === 'tool');
    if (tools.length === 0) return { content: '', toolCalls: [call('r1', 'read', { path: 'shared.txt' })] };
    await base.write('shared.txt', enc('OWNER EDITED THIS'));
    return { content: 'shared.txt says ' + String(tools[0].content).replace(/\s+/g, ' ').slice(0, 20), toolCalls: [] };
  };
}
await test('#9 a read-only child (no changes) still gets "read N files that changed under it" — batch and straggler paths', async () => {
  const base = new MemoryBackend(); await base.write('shared.txt', enc('ORIGINAL'));
  const out = await topExecutorWith(base, inspectorInfer(base))('dispatch', { tasks: [{ description: 'inspector', prompt: 'inspect: report shared.txt' }] });
  assert(/### \[1\] inspector — no file changes · read 1 file that changed under it since \(shared\.txt\) — its result may rest on stale content/.test(out), out);
  // straggler path
  const base2 = new MemoryBackend(); await base2.write('shared.txt', enc('ORIGINAL'));
  const fast = scriptedInfer((p) => /fast/i.test(p) ? { write: { file: 'fast.txt', content: 'F' } } : null);
  const insp = inspectorInfer(base2);
  const infer = async (a) => { const user = [...a.messages].reverse().find((m) => m.role === 'user' && !/^\[coordination\]/.test(String(m.content || ''))); if (/^inspect:/.test(String(user?.content || ''))) { await new Promise((r) => setTimeout(r, 60)); return insp(a); } return fast(a); };
  const q = createSteerQueue();
  const out2 = await topExecutorWith(base2, infer, { steer: q, settleMs: 40 })('dispatch', { tasks: [{ description: 'fast', prompt: 'fast: create fast.txt' }, { description: 'inspector', prompt: 'inspect: report shared.txt' }] });
  assert(/still in flight: "inspector"/.test(out2), out2);
  await q.next(); const st = q.take(); eq(st.length, 1);
  assert(/^\[coordination\] subagent \[2\] "inspector" finished — no file changes\. It read 1 file that changed under it since \(shared\.txt\) — its result may rest on stale content\. shared\.txt says/.test(st[0].content), st[0].content);
});
await test('#9 siblings that land together: B read x.txt, A merged x.txt in the same batch — B is told (no re-read, set intersection)', async () => {
  const base = new MemoryBackend(); await base.write('x.txt', enc('OLD'));
  const call = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });
  const infer = async ({ messages }) => {
    const user = [...messages].reverse().find((m) => m.role === 'user' && !/^\[coordination\]/.test(String(m.content || '')));
    const prompt = String(user?.content || ''); const tools = messages.filter((m) => m.role === 'tool');
    if (/^A:/.test(prompt)) return tools.length === 0 ? { content: '', toolCalls: [call('a', 'write', { path: 'x.txt', content: 'NEW' })] } : { content: 'A rewrote x', toolCalls: [] };
    if (/^B:/.test(prompt)) { if (tools.length === 0) return { content: '', toolCalls: [call('b1', 'read', { path: 'x.txt' })] }; if (tools.length === 1) return { content: '', toolCalls: [call('b2', 'write', { path: 'y.txt', content: 'from ' + String(tools[0].content).replace(/\s+/g, ' ').slice(0, 10) })] }; return { content: 'B done', toolCalls: [] }; }
    return { content: '', toolCalls: [] };
  };
  const out = await topExecutorWith(base, infer)('dispatch', { tasks: [{ description: 'A', prompt: 'A: rewrite x.txt' }, { description: 'B', prompt: 'B: read x.txt, write y.txt' }] });
  assert(/### \[1\] A — merged\n/.test(out), out);
  assert(/### \[2\] B — merged · read 1 file that changed under it since \(x\.txt\) — its result may rest on stale content/.test(out), out);
  eq(dec(await base.readBinary('x.txt')), 'NEW'); assert(/^from\s+1 OLD/.test(dec(await base.readBinary('y.txt'))), 'B\'s derived write landed, built on the OLD it read');
});
await test('a child has task_done: it reports through it alone and the digest shows the summary as its report, merged (live 2026-09-17: a DeepSeek child said it had no task_done)', async () => {
  const base = new MemoryBackend();
  const call = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });
  const infer = async ({ messages, tools }) => {
    const user = [...messages].reverse().find((m) => m.role === 'user' && !/^\[coordination\]/.test(String(m.content || '')));
    if (!/^child:/.test(String(user?.content || ''))) return { content: '', toolCalls: [] };
    const names = (tools || []).map((t) => t.function.name);
    if (!names.includes('task_done')) return { content: 'NO TASK_DONE IN MY TOOLSET', toolCalls: [] };
    const done = messages.filter((m) => m.role === 'tool').length;
    if (done === 0) return { content: '', toolCalls: [call('w', 'write', { path: 'out.txt', content: 'x' })] };
    return { content: '', toolCalls: [call('d', 'task_done', { summary: 'Wrote out.txt with x and read it back.' })] };
  };
  const out = await topExecutorWith(base, infer)('dispatch', { tasks: [{ description: 'worker', prompt: 'child: write out.txt then call task_done' }] });
  assert(/### \[1\] worker — merged\nchanges applied: wrote out\.txt\nWrote out\.txt with x and read it back\./.test(out), out);
  eq(dec(await base.readBinary('out.txt')), 'x');
});
await test('#9 a fence that cannot run is SAID on the digest line, never silently open', async () => {
  const base = new MemoryBackend();
  const plan = scriptedInfer((p) => /fast/i.test(p) ? { write: { file: 'fast.txt', content: 'F' } } : null);
  const inner = makeSpawnIsolated(base, plan);
  const spawnIsolated = async () => { const iso = await inner(); return { ...iso, moved: async () => { throw new Error('crypto.subtle missing'); } }; };
  const out = await topExecutorWith(base, plan, { spawnIsolated })('dispatch', { tasks: [{ description: 'fast', prompt: 'fast: create fast.txt' }] });
  assert(/### \[1\] fast — merged · \(fence unavailable: crypto\.subtle missing — merged unfenced; the base may have moved under it\)/.test(out), out);
  eq(dec(await base.readBinary('fast.txt')), 'F', 'it still merged (fail-open), with the word on the line');
});
await test('LV1: Stop while a straggler is still in flight — the digest counts the whole cohort and the straggler is on the same stopped line', async () => {
  const base = new MemoryBackend();
  const ac = new AbortController();
  const plan = scriptedInfer((p) => /fast/i.test(p) ? { write: { file: 'fast.txt', content: 'F' } } : { write: { file: 'slow.txt', content: 'S' } });
  // the slow child's first model call presses Stop and then never answers — it is in flight at the settle, and dead with the signal
  const infer = async (a) => { const user = [...a.messages].reverse().find((m) => m.role === 'user'); if (/slow/i.test(String(user?.content || ''))) { ac.abort(); await new Promise(() => {}); } return plan(a); };
  const q = createSteerQueue();
  const exec = topExecutorWith(base, infer, { steer: q, settleMs: 40, signal: ac.signal });
  const out = await exec('dispatch', { tasks: [{ description: 'fast', prompt: 'fast: create fast.txt' }, { description: 'slow', prompt: 'slow: create slow.txt' }] });
  assert(/^Dispatched 2 subagents in parallel\./.test(out), 'the head counts the cohort on the abort path too: ' + out.split('\n')[0]);
  assert(/### \[2\] slow — STOPPED — the owner ended the run/.test(out) && /\(stopped before it finished\)/.test(out), 'the straggler has its own stopped line: ' + out);
  assert(!/still in flight/.test(out), 'no "completion will arrive" promise on a stop — no message is coming');
  eq(await base.exists('fast.txt'), false, 'the finished sibling is still not merged on a stop');
});
await test('B2: first-come — a straggler touching a path an earlier sibling already merged is HELD, and the steer says so', async () => {
  const base = new MemoryBackend();
  const plan = scriptedInfer((p) => /fast/i.test(p) ? { write: { file: 'shared.txt', content: 'FAST' } } : { write: { file: 'shared.txt', content: 'SLOW' } });
  const q = createSteerQueue();
  const exec = topExecutorWith(base, slowInfer(plan, /slow/i, 200), { steer: q, settleMs: 30 });
  const out = await exec('dispatch', { tasks: [{ description: 'fast', prompt: 'fast: write shared.txt' }, { description: 'slow', prompt: 'slow: write shared.txt' }] });
  assert(/### \[1\] fast — merged/.test(out), out);
  eq(dec(await base.readBinary('shared.txt')), 'FAST');
  await q.next(); const s = q.take()[0].content;
  assert(/subagent \[2\] "slow" finished — held — conflicts with an earlier sibling that already merged \(shared\.txt\); un-merging is not possible/.test(s), s);
  eq(dec(await base.readBinary('shared.txt')), 'FAST', 'the straggler did not overwrite the merged sibling');
});
await test('B2: a cohort that completes together is byte-identical to the barrier digest; without a queue the barrier stands', async () => {
  const mk = () => { const base = new MemoryBackend(); const plan = scriptedInfer((p) => /alpha/i.test(p) ? { write: { file: 'alpha.txt', content: 'A' } } : { write: { file: 'beta.txt', content: 'B' } }); return { base, plan }; };
  const tasks = [{ description: 'alpha', prompt: 'Create alpha.txt' }, { description: 'beta', prompt: 'Create beta.txt' }];
  const a = mk(); const barrier = await topExecutor(a.base, a.plan)('dispatch', { tasks });
  const b = mk(); const q = createSteerQueue(); const streamed = await topExecutorWith(b.base, b.plan, { steer: q, settleMs: 500 })('dispatch', { tasks });
  eq(streamed, barrier, 'same digest, byte for byte');
  eq(q.inFlight(), 0, 'nothing left in flight'); eq(q.take().length, 0, 'no steers');
  const c = mk(); const slow = slowInfer(c.plan, /beta/i, 120);
  const t0 = Date.now(); const noQueue = await topExecutorWith(c.base, slow, { settleMs: 10 })('dispatch', { tasks });
  assert(Date.now() - t0 >= 100, 'no queue → the barrier: the result waited for the slow child');
  assert(!/still in flight/.test(noQueue) && /### \[2\] beta — merged/.test(noQueue), noQueue);
});
await test('B2 (B1): a re-dispatch of a label still in flight is refused; a disjoint label in the same call runs', async () => {
  const base = new MemoryBackend();
  const plan = scriptedInfer((p) => /slow/i.test(p) ? { write: { file: 'slow.txt', content: 'S' } } : { write: { file: 'other.txt', content: 'O' } });
  const q = createSteerQueue();
  const exec = topExecutorWith(base, slowInfer(plan, /slow/i, 200), { steer: q, settleMs: 0 });
  const first = await exec('dispatch', { tasks: [{ description: 'slow', prompt: 'slow: create slow.txt' }, { description: 'quick', prompt: 'quick: create other.txt' }] });
  assert(/still in flight: "slow"/.test(first), first);
  const again = await exec('dispatch', { tasks: [{ description: 'slow', prompt: 'slow: create slow.txt' }] });
  assert(/^Refused: "slow" is still in flight from an earlier dispatch — unverifiable authorizes nothing/.test(again), again);
  const mixed = await exec('dispatch', { tasks: [{ description: 'slow', prompt: 'slow: create slow.txt' }, { description: 'third', prompt: 'third: create other.txt' }] });
  assert(/### \[1\] third — merged/.test(mixed), 'the disjoint label ran: ' + mixed);
  assert(/### refused: "slow" is still in flight from an earlier dispatch — unverifiable authorizes nothing/.test(mixed), 'a partial refusal is in the digest, never silent: ' + mixed);
  await q.next(); q.take(); await new Promise((r) => setTimeout(r, 0));
  const after = await exec('dispatch', { tasks: [{ description: 'slow', prompt: 'slow: create slow.txt' }] });
  assert(!/^Refused/.test(after), 'once it reported back the label is free again: ' + after.slice(0, 80));
});

await test('B2: a straggler that touches a path a LATER dispatch merged is held — first-come across dispatches, not per call', async () => {
  const base = new MemoryBackend();
  const plan = scriptedInfer((p) => /slow/i.test(p) ? { write: { file: 'shared.txt', content: 'SLOW-FROM-DISPATCH-1' } } : /mid/i.test(p) ? { write: { file: 'shared.txt', content: 'MID' } } : { write: { file: 'fast.txt', content: 'F' } });
  const q = createSteerQueue();
  const exec = topExecutorWith(base, slowInfer(plan, /slow/i, 250), { steer: q, settleMs: 20 });
  const first = await exec('dispatch', { tasks: [{ description: 'fast', prompt: 'fast: write fast.txt' }, { description: 'slow', prompt: 'slow: write shared.txt' }] });
  assert(/still in flight: "slow"/.test(first), first);
  const second = await exec('dispatch', { tasks: [{ description: 'mid', prompt: 'mid: write shared.txt' }] });
  assert(/\[1\] mid — merged/.test(second), second);
  eq(dec(await base.readBinary('shared.txt')), 'MID');
  await q.next(); const s = q.take()[0].content;
  assert(/"slow" finished — held — conflicts with an earlier sibling that already merged \(shared\.txt\)/.test(s), 'the straggler is held against the later dispatch: ' + s);
  eq(dec(await base.readBinary('shared.txt')), 'MID', 'the later merge stands');
});

await test('B2: the batch path obeys the merge clock — a cohort launched before a straggler merged is held on that path, so the straggler\'s "merged" steer stays true', async () => {
  const base = new MemoryBackend();
  const plan = scriptedInfer((p) => /slow/i.test(p) ? { write: { file: 'shared.txt', content: 'SLOW' } } : /mid/i.test(p) ? { write: { file: 'shared.txt', content: 'MID' } } : { write: { file: 'fast.txt', content: 'F' } });
  const q = createSteerQueue();
  const infer = async (a) => { const u = [...a.messages].reverse().find((m) => m.role === 'user' && !/^\[coordination\]/.test(String(m.content || ''))); const p = String(u?.content || ''); if (/slow/i.test(p)) await new Promise((r) => setTimeout(r, 120)); if (/mid/i.test(p)) await new Promise((r) => setTimeout(r, 300)); return plan(a); };
  const exec = topExecutorWith(base, infer, { steer: q, settleMs: 20 });
  const first = await exec('dispatch', { tasks: [{ description: 'fast', prompt: 'fast: write fast.txt' }, { description: 'slow', prompt: 'slow: write shared.txt' }] });
  assert(/still in flight: "slow"/.test(first), first);
  const second = await exec('dispatch', { tasks: [{ description: 'mid', prompt: 'mid: write shared.txt' }] }); // launched before slow merges, finishes after
  const s = q.take()[0].content;
  assert(/"slow" finished — merged\. changes applied: wrote shared\.txt/.test(s), 'the straggler merged first: ' + s);
  assert(/\[1\] mid — held — path conflict — merged by an earlier sibling since this dispatch launched \(shared\.txt\)/.test(second), 'the later cohort is held on that path: ' + second);
  eq(dec(await base.readBinary('shared.txt')), 'SLOW', 'the steer on the chain is true');
});

await test('B2: check → commit is one critical section across the merge clock — a straggler committing while the next cohort checks cannot leave two "merged" claims on one path', async () => {
  const base = new MemoryBackend();
  const plan = scriptedInfer((p) => /slow/i.test(p) ? { write: { file: 'shared.txt', content: 'SLOW' } } : /mid/i.test(p) ? { write: { file: 'shared.txt', content: 'MID' } } : { write: { file: 'fast.txt', content: 'F' } });
  const infer = async (a) => { const u = [...a.messages].reverse().find((m) => m.role === 'user' && !/^\[coordination\]/.test(String(m.content || ''))); const p = String(u?.content || ''); if (/slow/i.test(p)) await new Promise((r) => setTimeout(r, 100)); if (/mid/i.test(p)) await new Promise((r) => setTimeout(r, 150)); return plan(a); };
  // each scripted child makes two model calls: slow completes at ~200 ms, mid at ~330 ms — inside slow's 250 ms commit
  // (only the shared.txt commits are slow: a slow fast.txt commit would hold the first dispatch's return and move the window)
  const inner = makeSpawnIsolated(base, infer, '');
  const slowCommit = async () => { const iso = await inner(); const c = iso.commit.bind(iso); iso.commit = async () => { if ((iso.changes().written || []).includes('shared.txt')) await new Promise((r) => setTimeout(r, 250)); return c(); }; return iso; };
  const q = createSteerQueue();
  const exec = topExecutorWith(base, infer, { steer: q, settleMs: 20, spawnIsolated: slowCommit });
  const first = await exec('dispatch', { tasks: [{ description: 'fast', prompt: 'fast: write fast.txt' }, { description: 'slow', prompt: 'slow: write shared.txt' }] });
  assert(/still in flight: "slow"/.test(first), first);
  const second = await exec('dispatch', { tasks: [{ description: 'mid', prompt: 'mid: write shared.txt' }] }); // completes while slow's 150 ms commit is in flight
  await q.next(); const s = q.take()[0].content;
  const slowMerged = /"slow" finished — merged/.test(s), midMerged = /\[1\] mid — merged/.test(second);
  assert(slowMerged !== midMerged, 'exactly one "merged" claim on shared.txt — slow: ' + s + ' | mid: ' + second);
  eq(dec(await base.readBinary('shared.txt')), slowMerged ? 'SLOW' : 'MID', 'the workspace holds the one that merged');
});

// ── CRIB-B B3: ownership declared at dispatch ──
await test('B3: two sub-tasks claiming one prefix are refused before any child runs; disjoint declared ownership merges as today', async () => {
  const base = new MemoryBackend();
  let infers = 0;
  const plan = scriptedInfer((p) => /alpha/i.test(p) ? { write: { file: 'src/alpha.txt', content: 'A' } } : { write: { file: 'docs/beta.txt', content: 'B' } });
  const infer = async (a) => { infers++; return plan(a); };
  const exec = topExecutor(base, infer);
  const out = await exec('dispatch', { tasks: [
    { description: 'alpha', prompt: 'Create src/alpha.txt', ownership: ['src/'] },
    { description: 'beta', prompt: 'Create docs/beta.txt', ownership: ['src/alpha.txt', 'docs/'] },
  ] });
  assert(/^Refused: sub-tasks \[1\] "alpha" and \[2\] "beta" claim overlapping ownership \(src\/\) — declare disjoint ownership, or run them sequentially with `task`\. Nothing was started\.$/.test(out), out);
  eq(infers, 0, 'no child ran'); eq(await base.exists('src/alpha.txt'), false);
  const ok = await exec('dispatch', { tasks: [
    { description: 'alpha', prompt: 'Create src/alpha.txt', ownership: ['src/'] },
    { description: 'beta', prompt: 'Create docs/beta.txt', ownership: ['docs/'] },
  ] });
  assert(/\[1\] alpha — merged/.test(ok) && /\[2\] beta — merged/.test(ok), ok);
  eq(dec(await base.readBinary('src/alpha.txt')), 'A'); eq(dec(await base.readBinary('docs/beta.txt')), 'B');
});
await test('B3: a child that writes outside its declared ownership is HELD — base untouched, the digest names the path; the child was briefed with the boundary', async () => {
  const base = new MemoryBackend();
  const briefs = [];
  const plan = scriptedInfer((p) => { briefs.push(p); return /stray/i.test(p) ? { write: { file: 'src/core/stray.txt', content: 'X' } } : { write: { file: 'src/api/ok.txt', content: 'OK' } }; });
  const exec = topExecutor(base, plan);
  const out = await exec('dispatch', { tasks: [
    { description: 'good', prompt: 'good: write src/api/ok.txt', ownership: ['src/api/'], target: 'src/api', acceptance: 'the file exists' },
    { description: 'stray', prompt: 'stray: write src/core/stray.txt', ownership: ['src/other/'] },
  ] });
  assert(/\[1\] good — merged/.test(out), out);
  assert(/\[2\] stray — held — wrote outside its declared ownership \(src\/core\/stray\.txt\)/.test(out), out);
  eq(dec(await base.readBinary('src/api/ok.txt')), 'OK'); eq(await base.exists('src/core/stray.txt'), false, 'held, never merged');
  assert(briefs.some((b) => /^Target: src\/api\nOwnership: you may write only under src\/api\/ — anything written elsewhere is held and never merged\.\nObservable acceptance: the file exists\n\ngood: write src\/api\/ok\.txt$/.test(b)), 'the child saw its spec: ' + JSON.stringify(briefs));
});
await test('B3 (B2): a second dispatch claiming a prefix still owned by an in-flight child is refused for that sub-task and named in the digest; the other runs; a straggler outside its ownership is held on completion', async () => {
  const base = new MemoryBackend();
  const plan = scriptedInfer((p) => /slow/i.test(p) ? { write: { file: 'src/core/late.txt', content: 'L' } } : /other/i.test(p) ? { write: { file: 'docs/o.txt', content: 'O' } } : { write: { file: 'src/api/x.txt', content: 'X' } });
  const q = createSteerQueue();
  const exec = topExecutorWith(base, slowInfer(plan, /slow/i, 200), { steer: q, settleMs: 0 });
  const first = await exec('dispatch', { tasks: [{ description: 'slow', prompt: 'slow: write src/core/late.txt', ownership: ['src/api/'] }, { description: 'quick', prompt: 'other: write docs/o.txt' }] });
  assert(/still in flight: "slow"/.test(first), first);
  const second = await exec('dispatch', { tasks: [
    { description: 'claim', prompt: 'claim: write src/api/x.txt', ownership: ['src/api/x.txt'] },
    { description: 'other2', prompt: 'other: write docs/o.txt', ownership: ['docs/'] },
  ] });
  assert(/\[1\] other2 — merged/.test(second), 'the disjoint sub-task ran and merged: ' + second);
  assert(/### refused: "claim" claims src\/api\/, still owned by "slow" \(in flight\) — unverifiable authorizes nothing/.test(second), 'the refusal is named: ' + second);
  eq(await base.exists('src/api/x.txt'), false, 'the claim on in-flight ownership did not run');
  const only = await exec('dispatch', { tasks: [{ description: 'claim2', prompt: 'claim: write src/api/x.txt', ownership: ['src/api/'] }] });
  assert(/^Refused: "claim2" claims src\/api\/, still owned by "slow" \(in flight\) — unverifiable authorizes nothing/.test(only), only);
  await q.next(); const s = q.take()[0].content;
  assert(/"slow" finished — held — wrote outside its declared ownership \(src\/core\/late\.txt\)/.test(s), s);
  eq(await base.exists('src/core/late.txt'), false, 'the straggler outside its ownership never merged');
  await new Promise((r) => setTimeout(r, 0));
  const freed = await exec('dispatch', { tasks: [{ description: 'claim3', prompt: 'claim: write src/api/x.txt', ownership: ['src/api/'] }] });
  assert(/\[1\] claim3 — merged/.test(freed), 'once the child reported back its ownership is free: ' + freed);
});

await test('B3: under a rooted mount (the Crate shape) ownership still compares workspace-relative — a clean child merges, not "outside"', async () => {
  const base = new MemoryBackend();
  const plan = scriptedInfer(() => ({ write: { file: 'src/api/x.txt', content: 'X' } }));
  const exec = topExecutor(base, plan, 'ws/p1');
  const out = await exec('dispatch', { tasks: [{ description: 'api', prompt: 'write src/api/x.txt', ownership: ['src/api/'] }] });
  assert(/\[1\] api — merged/.test(out), 'merged, not held as outside: ' + out);
  eq(dec(await base.readBinary('ws/p1/src/api/x.txt')), 'X', 'landed under the mount root');
});
await test('B3: a trespasser is held before the plan — the path\'s rightful owner still merges', async () => {
  const base = new MemoryBackend();
  const plan = scriptedInfer((p) => /owner/i.test(p) ? { write: { file: 'src/a.py', content: 'OWNER' } } : { write: { file: 'src/a.py', content: 'TRESPASS' } });
  const exec = topExecutor(base, plan);
  const out = await exec('dispatch', { tasks: [
    { description: 'owner', prompt: 'owner: write src/a.py', ownership: ['src/'] },
    { description: 'stray', prompt: 'stray: write src/a.py', ownership: ['docs/'] },
  ] });
  assert(/\[1\] owner — merged/.test(out), 'the owner merged: ' + out);
  assert(/\[2\] stray — held — wrote outside its declared ownership \(src\/a\.py\)/.test(out), 'the trespasser is held for what it is: ' + out);
  assert(!/path conflict/.test(out), 'and it is not a conflict');
  eq(dec(await base.readBinary('src/a.py')), 'OWNER');
});

await test('B5: a dispatched child under a read-only grant is never offered write — the catalog is the grant\'s projection down the tree', async () => {
  const base = new MemoryBackend();
  const seen = [];
  const plan = scriptedInfer(() => ({ write: { file: 'x.txt', content: 'X' } }));
  const infer = async (a) => { seen.push((a.tools || []).map((t) => t.function.name)); return plan(a); };
  const exec = topExecutorWith(base, infer, { scopes: ['fs:read'] });
  const out = await exec('dispatch', { tasks: [{ description: 'w', prompt: 'write x.txt' }] });
  assert(seen.length > 0 && seen.every((names) => !names.includes('write') && !names.includes('edit')), 'the child was never offered write/edit: ' + JSON.stringify(seen[0]));
  assert(seen[0].includes('read') && seen[0].includes('shell'), 'and was offered what fs:read allows: ' + JSON.stringify(seen[0]));
  // (the scripted child calls write anyway — a real model cannot call what it was not offered; whether the
  // CALL lands is the child grant's job, which this bed leaves at the full set, as the app does today)
  assert(/\[1\] w — /.test(out), out);
});

await test('D1: an intercepted command with an expect gets NO verdict line — it never ran, so there is nothing to grade', async () => {
  const base = new MemoryBackend();
  await base.write('x.txt', new TextEncoder().encode('a\n'));
  const exec = topExecutor(base, scriptedInfer(() => ({ done: 'x' })));
  const out = await exec('shell', { command: 'sed -i s/a/b/ x.txt', expect: 'contains done' });
  assert(!/\[expect\]/.test(out), 'no [expect] line on an intercepted command: ' + out.slice(0, 160));
  const ran = await exec('shell', { command: 'cat x.txt', expect: 'contains a' });
  assert(/\[expect\] MET \(contains a\)/.test(ran), 'a command that ran is graded: ' + ran.slice(0, 160));
});

if (failures.length){
  console.error(`subagents-integration: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`subagents-integration conformance: ${passed}/${passed} passed`);
