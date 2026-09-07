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
