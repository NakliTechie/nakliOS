// Conformance — the post-run review fork (C2) + the auto-review scheduler (C5).
//   node sys/ai/test/learn.test.mjs
import { buildReviewPrompt, parseProposals, runLearnReview, shouldAutoReview, learnReviewTool, AUTO_REVIEW_IDLE_MS } from '../learn.mjs';
import { createRunRecorder, foldSessionContext, foldDecisions } from '../../history/run-record.mjs';
import { runAgentLoop, makeShellExecutor, shellTool } from '../agent-loop.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../rig/agent/index.mjs';
import { createShell } from '../../rig/cli/shell.mjs';
import { createProposalLedger, fingerprint } from '../proposal-fingerprint.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const scripted = (turns) => { let i = 0; return async () => turns[i++] || { content: 'done', toolCalls: [] }; };
function freshShell() {
  const fs = createFileops({ backend: new MemoryBackend() });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  return createShell({ registry, face });
}
// A recorded run: build a file, gate passes.
async function recordRun() {
  const shell = freshShell();
  const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'add a retry helper to net.js' }];
  await rec.start({ messages: msgs, tools: [shellTool()] });
  const r = await runAgentLoop({ messages: msgs, tools: [shellTool()],
    infer: rec.wrapInfer(scripted([{ content: '', toolCalls: [call('shell', { command: 'echo x > net.js', path: 'net.js' }, 'c0')] }, { content: 'done', toolCalls: [] }])),
    executeTool: makeShellExecutor(shell), onEvent: rec.onEvent, verify: async () => ({ ok: true, exit: 0 }) });
  await rec.finish(r); await rec.settled();
  return rec;
}

await test('foldSessionContext / foldDecisions: goal, files, outcome, and tool→gate pairing', async () => {
  const rec = await recordRun();
  const ctx = foldSessionContext(rec.events(), rec.resolve);
  assert(/retry helper/.test(ctx.goal), 'goal is the first owner input'); eq(ctx.outcome, 'success', 'gated pass → success');
  assert(ctx.filesTouched.includes('net.js'), 'files touched from tool args');
  const dec = foldDecisions(rec.events(), rec.resolve);
  assert(dec.length >= 1 && dec.some((d) => d.outcome === 'passed'), 'a decision is paired with the gate pass');
});

await test('buildReviewPrompt asks for JSON and names the outcome; parseProposals is tolerant', () => {
  const p = buildReviewPrompt({ events: () => [], resolve: () => ({}) });
  assert(/proposals/.test(p) && /JSON/.test(p), 'the prompt asks for a JSON proposals array');
  eq(parseProposals('no json here').length, 0, 'no JSON → none');
  eq(parseProposals('{"proposals":[]}').length, 0, 'empty → none');
  const two = parseProposals('sure: {"proposals":[{"kind":"skill","name":"a"},{"kind":"fact","name":"b"},{"bad":1}]} done');
  eq(two.length, 2, 'valid proposals extracted, junk dropped');
});

await test('runLearnReview: routes every proposal through the sink as STAGED, 0 active writes', async () => {
  const rec = await recordRun();
  const staged = [];
  const propose = async (p) => { staged.push(p); return { ok: true, staged: true }; };
  const infer = async () => ({ content: '{"proposals":[{"kind":"skill","name":"add-retry","description":"how to add a retry","content":"wrap in a loop","goal":"add retry","steps":["wrap loop"],"paths":["net.js"]},{"kind":"fact","name":"net-lives-here","note":"net.js holds the client","goal":"where net lives"}]}' });
  const rep = await runLearnReview({ record: rec, infer, propose });
  eq(rep.activeWrites, 0, 'NOTHING is written active'); eq(rep.proposalCount, 2, 'two proposals'); eq(rep.staged.length, 2, 'both staged via the sink');
  assert(staged.every((p) => p.fp && /^fp:v1:/.test(p.fp)), 'each staged proposal carries a fingerprint');
});

await test('runLearnReview: a poisoned fingerprint is dropped, not re-proposed', async () => {
  const rec = await recordRun();
  const led = createProposalLedger({ now: () => 1000 });
  const proposal = { goal: 'add retry', steps: ['wrap loop'], paths: ['net.js'] };
  const fp = await fingerprint(proposal);
  await led.reject({ fp, reason: 'we do not want a retry skill', cooloffDays: 30 }); await led.settled();
  const infer = async () => ({ content: '{"proposals":[{"kind":"skill","name":"add-retry","description":"d","content":"c","goal":"add retry","steps":["wrap loop"],"paths":["net.js"]}]}' });
  const staged = [];
  const rep = await runLearnReview({ record: rec, infer, ledger: led, propose: async (p) => { staged.push(p); return { ok: true }; }, now: 2000 });
  eq(rep.staged.length, 0, 'the poisoned proposal is not staged'); eq(rep.dropped.length, 1, 'it is dropped'); assert(/do not want/.test(rep.dropped[0].reason), 'with the rejection reason');
  eq(staged.length, 0, 'the sink never saw it');
});

await test('shouldAutoReview (C5): fires on a gated pass when idle; defers on a local model; skips aborted', () => {
  assert(shouldAutoReview({ outcome: 'success', stop: 'done', idleMs: 99999, isLocalModel: false }).review, 'a hosted pass reviews');
  assert(!shouldAutoReview({ outcome: 'success', stop: 'done', idleMs: 1000, isLocalModel: true }).review, 'a local model defers until idle');
  assert(shouldAutoReview({ outcome: 'success', stop: 'done', idleMs: AUTO_REVIEW_IDLE_MS, isLocalModel: true }).review, 'a local model reviews once idle');
  assert(!shouldAutoReview({ outcome: 'unknown', stop: 'aborted' }).review, 'an aborted run is skipped');
  assert(!shouldAutoReview({ outcome: 'unknown', stop: 'no-progress' }).review, 'no outcome signal → skip');
  eq(learnReviewTool().function.name, 'learn_this_run', 'the explicit tool');
});

await test('NAF-03: same-named proposals keep their OWN fingerprints and content', async () => {
  // Two proposals sharing name+kind. The first is poisoned. Pairing by name meant the second's
  // clean fingerprint carried the FIRST's rejected content straight past the poison check.
  const { createProposalLedger, fingerprint } = await import('../proposal-fingerprint.mjs');
  const bad  = { kind: 'skill', name: 'same', goal: 'delete data', steps: ['delete'], paths: [], content: 'REJECTED DESTRUCTIVE' };
  const good = { kind: 'skill', name: 'same', goal: 'keep data',   steps: ['backup'], paths: [], content: 'SAFE' };
  const ledger = createProposalLedger();
  await ledger.reject({ fp: await fingerprint(bad), reason: 'destructive' });
  const seen = []; const fps = [];
  const rep = await runLearnReview({
    record: { events: () => [], resolve: () => ({}) },
    infer: async () => ({ content: JSON.stringify({ proposals: [bad, good] }) }),
    ledger,
    propose: async (pr) => { seen.push(pr.content); fps.push(pr.fp); return { ok: true, staged: pr.name }; },
  });
  assert(!seen.includes('REJECTED DESTRUCTIVE'), `the rejected content was staged anyway: ${JSON.stringify(seen)}`);
  eq(rep.dropped.length, 1, 'the poisoned proposal was dropped');
  eq(seen.length, 1, 'exactly the clean proposal was staged');
  eq(seen[0], 'SAFE', `the surviving proposal must carry its OWN content, got: ${seen[0]}`);
  eq(fps[0], await fingerprint(good), 'and its OWN fingerprint reaches the proposer — the reviewer keys on it');
});

if (failures.length) { console.error(`learn: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`); process.exit(1); }
console.log(`learn conformance: ${passed}/${passed} passed — session context + decisions, review fork stages everything (0 active), poison drop, auto-review scheduler`);
