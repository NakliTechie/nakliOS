// Conformance — the post-run review fork (C2) + the auto-review scheduler (C5).
//   node sys/ai/test/learn.test.mjs
import { buildReviewPrompt, parseProposals, validateProposals, runLearnReview, shouldAutoReview, learnReviewTool, AUTO_REVIEW_IDLE_MS } from '../learn.mjs';
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

// CRIB-B B4: the review's JSON comes out of prose, a bad reply costs one repair turn that names the
// error, a ladder hands over to the next rung, and the report carries the trail
await test('B4: parseProposals reads JSON out of prose, a code fence, or after another object; validateProposals names what is wrong', () => {
  eq(parseProposals('Sure: ```json\n{"proposals": [{"kind": "fact", "name": "n", "content": "c"}]}\n``` done').length, 1);
  eq(parseProposals('{"note": "x"} then {"proposals": [{"kind": "skill", "name": "s"}]}').length, 1, 'an earlier object without proposals is skipped');
  eq(parseProposals('{"proposals": [{"kind": "fact"}, {"name": "no kind"}, {"kind": "fact", "name": "ok"}]}').length, 1, 'the filter still drops what has no kind or name');
  eq(parseProposals('no json').length, 0);
  eq(validateProposals({ proposals: [{ kind: 'fact', name: 'a' }] }).length, 0);
  eq(validateProposals({}).join('|'), 'the JSON must be an object with a "proposals" array');
  eq(validateProposals({ proposals: [{ kind: 'note', name: 'x' }, { kind: 'fact' }, 3] }).join('|'), 'proposal 1 ("x") needs "kind": "skill" or "fact"|proposal 2 has no "name"|proposal 3 is not an object');
});
await test('B4: a prose-first reviewer is repaired once with the errors; the report carries the trail; a dead rung hands over to the next', async () => {
  const rec = await recordRun();
  const replies = ['Here are my thoughts: {"proposals": [{"kind": "note", "name": "x"}]}', '{"proposals": [{"kind": "fact", "name": "x", "content": "c"}]}'];
  let i = 0; const calls = [];
  const infer = async ({ messages }) => { calls.push(messages); return { content: replies[Math.min(i++, replies.length - 1)], toolCalls: [] }; };
  const staged = [];
  const rep = await runLearnReview({ record: rec, infer, propose: async (p) => { staged.push(p); return { ok: true }; } });
  eq(rep.answered, true); eq(rep.rung, 'default'); eq(rep.proposalCount, 1); eq(staged.length, 1);
  eq(rep.attempts.length, 1); assert(/needs "kind": "skill" or "fact"/.test(rep.attempts[0].error), rep.attempts[0].error);
  eq(calls.length, 2, 'one repair turn'); assert(/^Your reply was not the JSON that was asked for:\n- proposal 1 \("x"\) needs "kind"/.test(calls[1][calls[1].length - 1].content), 'the repair names the error');
  assert(/^answered by default after 1 failed attempt: default#1 — /.test(rep.attemptsLine), rep.attemptsLine);
  const dead = { name: 'local', infer: async () => { throw new Error('ECONNREFUSED'); } };
  const byok = { name: 'byok', infer: async () => ({ content: '{"proposals": []}', toolCalls: [] }) };
  const rep2 = await runLearnReview({ record: rec, ladder: [dead, byok], propose: async () => ({ ok: true }) });
  eq(rep2.answered, true); eq(rep2.rung, 'byok'); eq(rep2.proposalCount, 0); eq(rep2.attempts.map((a) => a.rung + '#' + a.try).join(','), 'local#1');
  const rep3 = await runLearnReview({ record: rec, infer: async () => ({ content: 'never json', toolCalls: [] }), propose: async () => ({ ok: true }) });
  eq(rep3.answered, false); eq(rep3.rung, null); eq(rep3.proposalCount, 0); eq(rep3.salvaged, false); eq(rep3.attempts.length, 2, 'one try and one repair, then the honest no'); assert(/^no rung answered after 2 attempts/.test(rep3.attemptsLine), rep3.attemptsLine);
  // a reply with one malformed proposal among good ones, twice: not answered, but the good ones are salvaged item by item, as the old parser did
  const mixed = '{"proposals": [{"kind": "fact", "name": "keep-me", "content": "c"}, {"kind": "note", "name": "junk"}]}';
  const staged4 = [];
  const rep4 = await runLearnReview({ record: rec, infer: async () => ({ content: mixed, toolCalls: [] }), propose: async (p) => { staged4.push(p); return { ok: true }; } });
  eq(rep4.answered, false); eq(rep4.salvaged, true); eq(rep4.salvagedFrom, 'default', 'the record can say whose reply was salvaged'); eq(rep4.proposalCount, 2, 'the lenient filter keeps kind+name items; the sink drops what it cannot stage'); eq(staged4.length, 2); eq(staged4[0].name, 'keep-me');
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
