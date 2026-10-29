// Anthropic Messages API shaping: agent transcript → request, final message →
// text, tool calls, finish reason and usage. Pure module, no network.
import assert from 'node:assert/strict';
import { toAnthropicRequest, fromAnthropicMessage, replayKey } from '../sys/ai/anthropic-protocol.mjs';
import { usageInputTokens } from '../sys/ai/usage.mjs';

const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
const call = { id: 'toolu_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.md"}' } };
const transcript = [
  { role: 'system', content: 'You are Anvil.' },
  { role: 'developer', content: 'Workspace: demo.' },
  { role: 'user', content: 'Read a.md' },
  { role: 'assistant', content: 'Reading.', tool_calls: [call] },
  { role: 'tool', tool_call_id: 'toolu_1', content: 'hello' },
  { role: 'user', content: 'Now summarise.' },
];

// Without saved replies: system joined, tool_use synthesised, tool_result and the
// next user text share one user turn, forced choice becomes auto, caching is on.
let body = toAnthropicRequest({ messages: transcript, maxTokens: 16000, tools, toolChoice: 'required' });
assert.equal(body.system, 'You are Anvil.\n\nWorkspace: demo.');
assert.deepEqual(body.cache_control, { type: 'ephemeral' });
assert.deepEqual(body.tool_choice, { type: 'auto' });
assert.deepEqual(body.tools, [{ name: 'read_file', description: 'Read a file', input_schema: tools[0].function.parameters }]);
assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
assert.deepEqual(body.messages[1].content, [
  { type: 'text', text: 'Reading.' },
  { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.md' } },
]);
assert.deepEqual(body.messages[2].content, [
  { type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello' },
  { type: 'text', text: 'Now summarise.' },
]);
assert.deepEqual(toAnthropicRequest({ messages: transcript, maxTokens: 10, tools, toolChoice: 'none' }).tool_choice, { type: 'none' });
assert.equal(toAnthropicRequest({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 }).tools, undefined);

// With a saved reply, its raw blocks (thinking included) go back unchanged.
const raw = [
  { type: 'thinking', thinking: '', signature: 'sig1' },
  { type: 'text', text: 'Reading.' },
  { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.md' } },
];
const replay = new Map([[replayKey({ content: 'Reading.', toolCalls: [call] }), raw]]);
body = toAnthropicRequest({ messages: transcript, maxTokens: 16000, tools, replay });
assert.deepEqual(body.messages[1].content, raw);
assert.notEqual(body.messages[1].content, raw, 'saved blocks are copied, not shared');

// A later turn with nothing saved drops the thinking BEFORE it (a leading run),
// never a gap in the middle.
const later = [...transcript,
  { role: 'assistant', content: 'Done.' },
  { role: 'user', content: 'Thanks' }];
body = toAnthropicRequest({ messages: later, maxTokens: 16000, tools, replay });
assert.deepEqual(body.messages[1].content.map((b) => b.type), ['text', 'tool_use']);

// Final message → OpenAI shapes.
let r = fromAnthropicMessage({
  stop_reason: 'tool_use',
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_9', name: 'read_file', input: { path: 'b.md' } }],
  usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 40 },
});
assert.equal(r.text, 'Reading.');
assert.equal(r.finishReason, 'tool_calls');
assert.deepEqual(r.toolCalls, [{ id: 'toolu_9', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.md"}' } }]);
assert.equal(r.usage.prompt_tokens, 1000);
assert.equal(r.usage.completion_tokens, 40);
assert.equal(r.usage.cache_read_input_tokens, 900);
// OpenAI-shaped clients (Dish) read cache hits here; it is a subset of prompt_tokens.
assert.equal(r.usage.prompt_tokens_details.cached_tokens, 900);
assert.equal(usageInputTokens(r.usage), 1000);
assert.equal(r.refusal, null);

r = fromAnthropicMessage({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [] });
assert.equal(r.finishReason, 'refusal');
assert.equal(r.refusal, 'cyber');
assert.equal(fromAnthropicMessage({ stop_reason: 'max_tokens', content: [] }).finishReason, 'length');
assert.equal(fromAnthropicMessage({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi' }] }).finishReason, 'stop');

console.log('Anthropic protocol: ok');
