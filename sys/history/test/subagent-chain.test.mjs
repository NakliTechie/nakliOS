// Conformance — a subagent's run is ON the parent's chain (crib #1).
//   node sys/history/test/subagent-chain.test.mjs
//
// Before this, `task` / `dispatch` / `review` called runAgentLoop with no recorder. A dispatch of
// two workers that each wrote a file left the parent chain holding two `llm.responded` (the
// supervisor's) and one `tool.called`, with the workers' four model calls and two writes ABSENT.
// Everything built on "a run is a fold over the ledger" — F1's request-reconstruction, F2's
// keyless replay, the tamper-evident chain — therefore covered the supervisor only, and stopped
// holding the moment Anvil fanned out. That is what this file exists to prevent recurring.
import { createRunRecorder, joined, foldSubagents, verifySubagents, foldTranscript, foldSurface,
         reconstructionCheck, loadRecord } from '../run-record.mjs';
import { verifyChain } from '../ledger.mjs';
import { runAgentLoop } from '../../ai/agent-loop.mjs';
import { makeToolExecutor, codingToolset } from '../../ai/agent-tools.mjs';
import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { OverlayBackend } from '../../rig/fileops/overlay-backend.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../rig/agent/index.mjs';
import { createShell } from '../../rig/cli/shell.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function deepEq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// ── a supervisor that dispatches two workers; each worker writes one file ──
function world() {
  const base = new MemoryBackend();
  const mk = (backend) => {
    const fs = createFileops({ backend });
    const registry = buildRigRegistry({ fs });
    const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
    const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'a' });
    return { fs, shell: createShell({ registry, face }), face };
  };
  return { base, mk };
}
async function infer({ messages }) {
  const sys = String(messages[0]?.content || '');
  if (/subagent working in an ISOLATED/i.test(sys)) {
    if (messages.filter((m) => m.role === 'tool').length === 0) {
      const which = /alpha/i.test(String(messages[1]?.content || '')) ? 'alpha' : 'beta';
      return { content: '', toolCalls: [{ id: 'w', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: `${which}.txt`, content: which }) } }] };
    }
    return { content: 'wrote it', toolCalls: [] };
  }
  if (messages.some((m) => m.role === 'tool')) return { content: 'done', toolCalls: [] };
  return { content: '', toolCalls: [{ id: 'd', type: 'function', function: { name: 'dispatch', arguments: JSON.stringify({ tasks: [
    { description: 'alpha', prompt: 'alpha: create alpha.txt' }, { description: 'beta', prompt: 'beta: create beta.txt' }] }) } }] };
}
async function dispatchRun({ record = true } = {}) {
  const { base, mk } = world();
  const top = mk(base);
  const spawnIsolated = async () => {
    const overlay = new OverlayBackend(base);
    const o = mk(overlay);
    return { executor: makeToolExecutor({ shell: o.shell, face: o.face, mode: 'code', infer, subagentDepth: 1 }),
             changes: () => overlay.changes(), commit: async () => {} };
  };
  const rec = createRunRecorder({ app: 'anvil', principal: 'test' });
  const exec = makeToolExecutor({ shell: top.shell, face: top.face, mode: 'code', infer, spawnIsolated,
    recordSubagent: record ? (sub) => rec.subagent(sub) : null });
  const messages = [{ role: 'system', content: 'supervisor' }, { role: 'user', content: 'fan out' }];
  const tools = codingToolset('code', { subagents: true, supervisor: true });
  await rec.start({ messages, tools });
  const r = await runAgentLoop({ messages, tools, infer: rec.wrapInfer(infer), executeTool: exec, onEvent: rec.onEvent, maxSteps: 6 });
  await rec.finish(r); await rec.settled();
  return { rec, r };
}

await test('the workers are ON the chain — their model calls and writes are recorded', async () => {
  const { rec } = await dispatchRun();
  const ev = joined(rec.events(), rec.resolve);
  eq(ev.filter((e) => e.tool === 'subagent.ran').length, 2, 'one event per subagent');

  const kids = foldSubagents(rec.events(), rec.resolve);
  deepEq(kids.map((k) => k.kind), ['dispatch', 'dispatch'], 'both recorded as dispatch');
  deepEq(kids.map((k) => k.label).sort(), ['alpha', 'beta'], 'each names its task');
  for (const k of kids) {
    assert(k.record, `${k.label}: a loadable child record`);
    const kev = joined(k.record.events(), k.record.resolve);
    // the exact evidence that was missing before: the worker's own model call and its write
    assert(kev.some((e) => e.tool === 'llm.responded'), `${k.label}: the worker's model turn is recorded`);
    const wrote = kev.filter((e) => e.tool === 'tool.called' && e.input?.name === 'write');
    eq(wrote.length, 1, `${k.label}: the worker's write is recorded`);
    eq(wrote[0].input.args.path, `${k.label}.txt`, `${k.label}: with the path it actually wrote`);
    eq(k.stop, 'done', `${k.label}: finished cleanly`);
  }

  // the CONTROL: the same run with no recordSubagent sink is blind, exactly as before
  const blind = await dispatchRun({ record: false });
  eq(joined(blind.rec.events(), blind.rec.resolve).filter((e) => e.tool === 'subagent.ran').length, 0,
    'without the sink the workers are invisible — which is the defect this closes');
});

await test('every child chain verifies, and its stop matches what the parent recorded', async () => {
  const { rec } = await dispatchRun();
  const v = await verifySubagents(rec.events(), rec.resolve);
  eq(v.checked, 2, 'both children checked');
  eq(v.ok, true, `all child chains verify: ${JSON.stringify(v.bad)}`);

  // a tampered child is caught — a child chain is exactly as serious as a parent one
  const kids = foldSubagents(rec.events(), rec.resolve);
  const dump = JSON.parse(JSON.stringify(kids[0].dump));
  const lines = dump.events.trim().split('\n').map((l) => JSON.parse(l));
  lines[3].tool = 'tool.failed';
  dump.events = lines.map((l) => JSON.stringify(l)).join('\n');
  eq((await verifyChain(loadRecord(dump).events())).ok, false, 'the tampered child chain does not verify');

  // and a parent that LIES about a child's stop is caught
  const liar = createRunRecorder({ app: 'anvil', principal: 'test' });
  await liar.start({ messages: [{ role: 'user', content: 'x' }] });
  await liar.subagent({ kind: 'task', label: 'l', dump: kids[0].dump, stop: 'error', steps: 1, text: '' });
  await liar.settled();
  const lv = await verifySubagents(liar.events(), liar.resolve);
  eq(lv.ok, false, 'a parent claiming a stop the child does not is caught');
  assert(/the child's own record says/.test(lv.bad[0].why), `and named: ${lv.bad[0].why}`);
});

await test('recording a subagent does NOT disturb the parent transcript (F1 still holds)', async () => {
  const { rec } = await dispatchRun();
  // subagent.ran is not a message the parent saw: it must not enter the transcript or the surface
  const t = foldTranscript(rec.events(), rec.resolve);
  const s = foldSurface(rec.events(), rec.resolve);
  deepEq(t.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant'], 'the parent transcript is unchanged in shape');
  deepEq(s, t, 'and the surface equals it (no compaction here)');
  // The precise claim: recording changes NOTHING the parent sees. The dispatch digest does name
  // the files — that is the tool result the supervisor legitimately received, and it was there
  // before this change too. So compare the recorded run against the blind one, byte for byte.
  const blind = await dispatchRun({ record: false });
  deepEq(t, foldTranscript(blind.rec.events(), blind.rec.resolve),
    'the parent transcript is byte-identical with and without subagent recording');
  // What the parent legitimately holds is ONE tool message — the dispatch digest, which by
  // design carries each worker's final report and the files it touched. What it must not hold is
  // the workers' event streams; those live in the child chains and are reached through
  // foldSubagents, not through the transcript.
  eq(t.filter((m) => m.role === 'tool').length, 1, 'the parent saw one tool result: the digest');
  const kids = foldSubagents(rec.events(), rec.resolve);
  const kidEvents = kids.reduce((n, k) => n + k.record.events().length, 0);
  assert(kidEvents >= 10, `the children hold real event streams of their own: ${kidEvents} events`);
  eq(joined(rec.events(), rec.resolve).filter((e) => e.tool === 'llm.responded').length, 2,
    "only the supervisor's two turns are llm.responded on the parent chain");

  // the F1 invariant itself, at the second request
  const ev = rec.events();
  const cut = ev.map((e, i) => (e.tool === 'llm.requested' ? i : -1)).filter((i) => i >= 0)[1];
  const want = foldSurface(ev.slice(0, cut), rec.resolve);
  eq(reconstructionCheck([{ role: 'system', content: 'supervisor' }, ...want], ev.slice(0, cut), rec.resolve).ok, true,
    'the request still equals a fold of the chain');
});

await test('a recorder that throws does not lose the subagent\'s work', async () => {
  const { base, mk } = world();
  const top = mk(base);
  const spawnIsolated = async () => {
    const overlay = new OverlayBackend(base);
    const o = mk(overlay);
    return { executor: makeToolExecutor({ shell: o.shell, face: o.face, mode: 'code', infer, subagentDepth: 1 }),
             changes: () => overlay.changes(), commit: async () => { for (const p of overlay.changes().written) { const r = await createFileops({ backend: overlay }).read(p, { encoding: 'utf-8' }); await createFileops({ backend: base }).write(p, r.data); } } };
  };
  const exec = makeToolExecutor({ shell: top.shell, face: top.face, mode: 'code', infer, spawnIsolated,
    recordSubagent: async () => { throw new Error('record store unavailable'); } });
  const messages = [{ role: 'system', content: 'supervisor' }, { role: 'user', content: 'fan out' }];
  const tools = codingToolset('code', { subagents: true, supervisor: true });
  const r = await runAgentLoop({ messages, tools, infer, executeTool: exec, maxSteps: 6 });
  eq(r.stop, 'done', `the run finished despite the recorder failing: ${r.stop}`);
  const fs = createFileops({ backend: base });
  assert((await fs.read('alpha.txt', { encoding: 'utf-8' })).ok, 'and the work landed — recording is best-effort, the work is not');
});

if (failures.length) {
  console.error(`subagent-chain: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`subagent-chain conformance: ${passed}/${passed} passed`);
