// In-run compaction (the experiment behind plan/research/2026-11-10-compaction-plugin.md):
// the override parser, the checkpoint summariser, folding an earlier summary forward, and the
// agent loop compacting before a request — with the run record still rebuilding every request.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runAgentLoop, shellTool } from '../sys/ai/agent-loop.mjs';
import { compactConversation, SUMMARY_HEAD } from '../sys/ai/compaction.mjs';
import { parseCompactionOverride, makeSummarizer, serializeForSummary, CHECKPOINT_PROMPT } from '../sys/ai/compaction-summary.mjs';
import { createRunRecorder, joined } from '../sys/history/run-record.mjs';

// ── the override: off unless well formed ──
assert.equal(parseCompactionOverride(null), null);
assert.equal(parseCompactionOverride(''), null);
assert.equal(parseCompactionOverride('not json'), null);
assert.equal(parseCompactionOverride('{"mode":"off"}'), null);
assert.equal(parseCompactionOverride('{"mode":"threshold","total":10000,"threshold":12000}'), null, 'a target above the trigger is refused');
assert.equal(parseCompactionOverride('{"mode":"threshold","threshold":12000}'), null, 'threshold mode needs a trigger');
assert.deepEqual(parseCompactionOverride('{"mode":"threshold","total":24000,"threshold":18000,"keep":0}'),
  { mode: 'threshold', compactAbove: 24000, threshold: 18000, keepRecentTokens: 0, summarize: true });
assert.deepEqual(parseCompactionOverride({ mode: 'every-action', summarize: false }),
  { mode: 'every-action', compactAbove: 0, threshold: 0, keepRecentTokens: 0, summarize: false });

// ── the summariser: a transcript to summarise, never a conversation to continue ──
{
  const seen = [];
  const sum = makeSummarizer(async (req) => { seen.push(req); return { content: '  ## Goal\nship it  ' }; });
  const older = [
    { role: 'user', content: 'fix the parser' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"p.js"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(5000) },
  ];
  assert.equal(await sum(older), '## Goal\nship it');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].tools, [], 'the summary call offers no tools');
  assert.equal(seen[0].messages.length, 2);
  assert.ok(seen[0].messages[1].content.endsWith(CHECKPOINT_PROMPT));
  const text = serializeForSummary(older);
  assert.match(text, /\[assistant tool call\] read\(\{"path":"p.js"\}\)/);
  assert.match(text, /\[… 3000 more characters\]/, 'a long tool result is cut at 2,000 characters');
  await assert.rejects(makeSummarizer(async () => ({ content: '' }))(older), /empty summary/);
}

// ── a later compaction folds the earlier summary in, so summaries never stack ──
{
  const big = 'y'.repeat(4000);
  const msgs = [
    { role: 'user', content: `${SUMMARY_HEAD}\nfirst summary` },
    { role: 'user', content: 'step a ' + big },
    { role: 'assistant', content: 'did a ' + big },
    { role: 'user', content: 'step b' },
  ];
  let got = null;
  const r = await compactConversation(msgs, { threshold: 0, keepRecentTokens: 0, summarize: async (older) => { got = older; return 'second summary'; } });
  assert.equal(r.method, 'summarize');
  assert.equal(got[0].content, `${SUMMARY_HEAD}\nfirst summary`, 'the summariser sees the earlier summary first');
  const summaries = r.messages.filter((m) => String(m.content).startsWith(SUMMARY_HEAD));
  assert.equal(summaries.length, 1, 'one summary remains');
  assert.equal(summaries[0].content, `${SUMMARY_HEAD}\nsecond summary`);
  assert.equal(r.messages[0].role, 'user', 'the request still opens with a user turn');
  assert.equal(r.messages.at(-1).content, 'step b', 'the latest turn is kept verbatim');
}

// ── the loop: compact before a request above the threshold, and the record still rebuilds it ──
async function runWith({ compactAbove, usageInput = null }) {
  const big = 'z'.repeat(8000); // ~2,000 tokens per tool result
  let i = 0;
  const call = (n) => ({ content: '', toolCalls: [{ id: `c${n}`, name: 'shell', arguments: { command: `cat f${n}` } }], usage: usageInput ? { input_tokens: usageInput } : undefined });
  const turns = [call(1), call(2), call(3), { content: 'done' }];
  const sent = [];
  const compactCalls = [];
  const divergences = [];
  const sys = { role: 'system', content: 'you are a test agent' };
  const rec = createRunRecorder({ app: 'anvil', principal: 'test' });
  const messages = [sys, { role: 'user', content: 'go' }];
  await rec.start({ messages, tools: [shellTool()], model: 'test:model' });
  const infer = rec.wrapInfer(async (req) => { sent.push(req.messages.length); return turns[i++]; }, { onDivergence: (d) => divergences.push(d) });
  const compact = async (msgs, opts) => {
    compactCalls.push(opts && opts.reason);
    const r = await compactConversation(msgs.slice(1), { threshold: 0, keepRecentTokens: 0, summarize: async () => 'summary' });
    return r.compacted ? { method: r.method, messages: [msgs[0], ...r.messages] } : null;
  };
  const events = [];
  const result = await runAgentLoop({
    messages, tools: [shellTool()], infer, executeTool: async () => big,
    onEvent: (e) => { events.push(e); rec.onEvent(e); }, maxSteps: 8, compact, compactAbove,
  });
  await rec.finish(result); await rec.settled();
  return { result, sent, compactCalls, divergences, compacted: events.filter((e) => e.type === 'compacted') };
}

{
  const off = await runWith({ compactAbove: null });
  assert.equal(off.result.stop, 'done');
  assert.equal(off.compacted.length, 0, 'with no threshold the loop never compacts on its own');
  assert.ok(off.sent.every((n, k) => k === 0 || n > off.sent[k - 1]) && off.sent.at(-1) >= 8, `the transcript only grows: ${off.sent.join(', ')}`);

  const every = await runWith({ compactAbove: 0 });
  assert.equal(every.result.stop, 'done');
  assert.ok(every.compacted.length >= 3, `every-action compacts before each later request (got ${every.compacted.length})`);
  assert.ok(every.compacted.every((e) => e.reason === 'every-action' && e.method === 'summarize'));
  assert.ok(every.compactCalls.every((r) => r === 'threshold'), 'the loop tells the compactor why it was called');
  assert.ok(Math.max(...every.sent) <= 4, `requests stay small: ${every.sent.join(', ')}`);
  assert.deepEqual(every.divergences, [], 'the run record rebuilds every compacted request');

  // A trigger the transcript passes only after the second result: one compaction, then quiet,
  // because the usage anchor is dropped with the old transcript.
  const at = await runWith({ compactAbove: 3000 });
  assert.equal(at.result.stop, 'done');
  assert.ok(at.compacted.length >= 1 && at.compacted.length < 3, `threshold compacts only when passed (got ${at.compacted.length})`);
  assert.match(at.compacted[0].reason, /context above 3000 tokens/);
  assert.deepEqual(at.divergences, []);
}

// ── the summary call's cost reaches the run record ──
{
  const seen = [];
  const sum = makeSummarizer(async () => ({ content: 'S', usage: { prompt_tokens: 900, completion_tokens: 100 } }), { onUsage: (u) => seen.push(u) });
  await sum([{ role: 'user', content: 'x' }]);
  assert.equal(seen.length, 1, 'onUsage receives the summary call\'s usage');

  const rec = createRunRecorder({ app: 'anvil', principal: 'test' });
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }];
  await rec.start({ messages, tools: [shellTool()], model: 'm' });
  let i = 0;
  const turns = [{ content: '', toolCalls: [{ id: 'k1', name: 'shell', arguments: { command: 'ls' } }] }, { content: 'done' }];
  const compact = async (msgs) => {
    const r = await compactConversation(msgs.slice(1), { threshold: 0, keepRecentTokens: 0, summarize: async () => 'sum' });
    return r.compacted ? { method: r.method, messages: [msgs[0], ...r.messages], usage: { prompt_tokens: 900, completion_tokens: 100 } } : null;
  };
  const result = await runAgentLoop({ messages, tools: [shellTool()], infer: rec.wrapInfer(async () => turns[i++]), executeTool: async () => 'z'.repeat(4000),
    onEvent: rec.onEvent, maxSteps: 4, compact, compactAbove: 0 });
  await rec.finish(result); await rec.settled();
  const c = joined(rec.events(), rec.resolve).filter((e) => e.tool === 'run.compacted');
  assert.ok(c.length >= 1, 'the run compacted');
  assert.deepEqual(c[0].output.usage, { prompt: 900, completion: 100, total: 1000 }, 'the record keeps the summary call\'s usage, normalised');
}

// ── Anvil wires it: off by default, read from localStorage once per run ──
{
  const anvil = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');
  assert.match(anvil, /parseCompactionOverride\(localStorage\.getItem\('anvil-compaction'\)\)/);
  assert.match(anvil, /compactAbove: runCompaction \? runCompaction\.compactAbove : null/);
  assert.match(anvil, /rec, await carryLimitsNow\(\)\)/, 'the carry follows the same override');
  assert.match(anvil, /makeSummarizer\(inferViaHost, \{ signal, onUsage: \(u\)=>\{ usage = u; \} \}\)/, 'Anvil collects the summary call\'s usage');
  assert.match(anvil, /messages: \[\.\.\.head, \.\.\.r\.messages\], usage \}/, 'and hands it to the loop');
}

console.log('test-anvil-compaction: ok');
