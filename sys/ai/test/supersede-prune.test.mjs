// Conformance — superseded-read and uneventful-result pruning (sys/ai/supersede-prune.mjs).
//
//   node sys/ai/test/supersede-prune.test.mjs

import assert from 'node:assert/strict';
import { planPrune, pruneOpenAIMessages, prunePiMessages, readKey, isCompleteRead, isUneventful, SUPERSEDED, UNEVENTFUL } from '../supersede-prune.mjs';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok', name); };
const big = (tag, n = 4000) => `${tag}\n` + 'x'.repeat(n);   // ~1000 tokens
const tight = { protectTokens: 100, minSavingsTokens: 100, keepLast: 1 };

test('keys and completeness follow the read window', () => {
  assert.equal(readKey('read', { path: 'a.js' }), 'a.js');
  assert.equal(readKey('read', { path: 'a.js', offset: 10, limit: 5 }), 'a.js#10+5');
  assert.equal(readKey('shell', { command: 'cat a.js' }), null);
  assert.equal(isCompleteRead('read', { path: 'a.js' }, 'body'), true);
  assert.equal(isCompleteRead('read', { path: 'a.js' }, 'body\n(Showing lines 1–200 of 900. Use offset=201 to continue.)'), false);
  assert.equal(isCompleteRead('read', { path: 'a.js', offset: 1 }, 'body'), false);
  assert.equal(isUneventful('No matches found'), true);
  assert.equal(isUneventful('(no output)\n[exit 1]'), true);
  assert.equal(isUneventful('(no output)\n[exit 0]'), false, 'a command that succeeded quietly is an observation');
});

test('an older read is superseded only by a newer complete read of the same file', () => {
  const items = [
    { tool: 'read', args: { path: 'a.js' }, text: big('v1') },
    { tool: 'read', args: { path: 'b.js' }, text: big('b') },
    { tool: 'read', args: { path: 'a.js', offset: 1, limit: 50 }, text: big('window') },
    { tool: 'read', args: { path: 'a.js' }, text: big('v2') },
    { tool: 'shell', args: { command: 'ls' }, text: 'a.js b.js' },
  ];
  const plan = planPrune(items, tight);
  assert.deepEqual([...plan], [[0, SUPERSEDED], [2, SUPERSEDED]], 'both older views of a.js go; b.js and v2 stay');
  const partialLast = [items[0], { tool: 'read', args: { path: 'a.js' }, text: 'head\n(Showing lines 1–10 of 900.)' }, items[4]];
  assert.equal(planPrune(partialLast, tight).size, 0, 'a partial newer read supersedes nothing');
});

test('the newest results are protected, and a small saving prunes nothing', () => {
  const items = [{ tool: 'read', args: { path: 'a.js' }, text: big('v1') }, { tool: 'read', args: { path: 'a.js' }, text: big('v2') }];
  assert.equal(planPrune(items, { ...tight, keepLast: 0, protectTokens: 5000 }).size, 0, 'inside the protect window');
  assert.equal(planPrune(items, { ...tight, keepLast: 0, minSavingsTokens: 5000 }).size, 0, 'not worth a cache break');
  assert.equal(planPrune(items, { ...tight, keepLast: 0 }).get(0), SUPERSEDED);
  const nothing = [{ tool: 'grep', args: {}, text: 'No matches found' }];
  assert.equal(planPrune(nothing, { ...tight, minSavingsTokens: 0 }).size, 0, 'the latest result is never touched');
});

test('OpenAI messages: a copy is pruned, the original is not', () => {
  const messages = [
    { role: 'user', content: 'fix a.js' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a.js"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: big('v1') },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'grep', arguments: '{"pattern":"zzz"}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: 'No matches found' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c3', type: 'function', function: { name: 'read', arguments: '{"path":"a.js"}' } }] },
    { role: 'tool', tool_call_id: 'c3', content: big('v2') },
  ];
  const before = JSON.stringify(messages);
  const out = pruneOpenAIMessages(messages, tight);
  assert.equal(out.pruned, 2);
  assert.equal(out.messages[2].content, SUPERSEDED);
  assert.equal(out.messages[4].content, UNEVENTFUL);
  assert.equal(out.messages[6].content, messages[6].content);
  assert.ok(out.saved > 900);
  assert.equal(JSON.stringify(messages), before, 'the transcript itself is unchanged');
  assert.deepEqual(pruneOpenAIMessages(out.messages, tight).messages, out.messages, 'pruning is stable: the same history prunes the same way');
});

test('pi-ai messages: toolCall parts and text toolResults', () => {
  const tc = (id, path) => ({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: { path } }] });
  const tr = (id, text) => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text }], isError: false, timestamp: 0 });
  const messages = [tc('a', 'x.md'), tr('a', big('one')), tc('b', 'x.md'), tr('b', big('two')),
    { role: 'toolResult', toolCallId: 'img', toolName: 'read', content: [{ type: 'image', data: '', mimeType: 'image/png' }], isError: false, timestamp: 0 }];
  const out = prunePiMessages(messages, tight);
  assert.equal(out.pruned, 1);
  assert.deepEqual(out.messages[1].content, [{ type: 'text', text: SUPERSEDED }]);
  assert.equal(out.messages[1].toolCallId, 'a', 'every other field of the result is kept');
  assert.equal(messages[1].content[0].text.startsWith('one'), true);
});

console.log(`supersede-prune: ${passed} passed`);
