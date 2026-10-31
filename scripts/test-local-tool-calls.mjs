// Tool calling on in-browser models: transcript → chat-template messages, and
// reply text → OpenAI tool calls. Pure module, no model needed.
import assert from 'node:assert/strict';
import { toLocalTemplateMessages, parseLocalToolCalls } from '../sys/ai/local-tool-calls.mjs';

const tools = [
  { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'integer' } } } } },
  { type: 'function', function: { name: 'write_file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, opts: { type: 'object' } } } } },
];

// Transcript conversion: arguments become objects, tool results stay `tool`, developer → system.
const transcript = [
  { role: 'developer', content: 'Be brief.' },
  { role: 'user', content: 'Read it.' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.md"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'hello' },
];
const shaped = toLocalTemplateMessages(transcript);
assert.equal(shaped[0].role, 'system');
assert.deepEqual(shaped[2].tool_calls[0].function.arguments, { path: 'a.md' });
assert.equal(shaped[2].content, '');
assert.deepEqual(shaped[3], { role: 'tool', tool_call_id: 'c1', content: 'hello' });
assert.equal(transcript[2].tool_calls[0].function.arguments, '{"path":"a.md"}', 'input is not mutated');
assert.deepEqual(toLocalTemplateMessages([{ role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'read_file', arguments: 'not json' } }] }])[0].tool_calls[0].function.arguments, {});

// LFM3's XML form, with text before it and typed parameters.
const xml = 'I will read it.\n<tool_call>\n<function=read_file>\n<parameter=path>\nsrc/a b.md\n</parameter>\n<parameter=limit>\n20\n</parameter>\n</function>\n</tool_call>';
let r = parseLocalToolCalls(xml, tools, { idPrefix: 'call_t' });
assert.equal(r.content, 'I will read it.');
assert.equal(r.toolCalls.length, 1);
assert.equal(r.toolCalls[0].id, 'call_t_0');
assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), { path: 'src/a b.md', limit: 20 });

// Multi-line string values keep inner newlines; object parameters parse as JSON.
r = parseLocalToolCalls('<tool_call>\n<function=write_file>\n<parameter=path>\nx.js\n</parameter>\n<parameter=content>\nline 1\nline 2\n</parameter>\n<parameter=opts>\n{"mode":"w"}\n</parameter>\n</function>\n</tool_call>', tools);
assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), { path: 'x.js', content: 'line 1\nline 2', opts: { mode: 'w' } });

// Two calls in one reply, order kept.
r = parseLocalToolCalls('<tool_call>\n<function=read_file>\n<parameter=path>\na\n</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=read_file>\n<parameter=path>\nb\n</parameter>\n</function>\n</tool_call>', tools);
assert.deepEqual(r.toolCalls.map((c) => JSON.parse(c.function.arguments).path), ['a', 'b']);
assert.equal(r.content, '');

// A reply cut off before its closing tags still yields the call.
r = parseLocalToolCalls('<tool_call>\n<function=read_file>\n<parameter=path>\nlate.md', tools);
assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), { path: 'late.md' });

// JSON form (Qwen/LFM2 style), and arguments given as a JSON string.
r = parseLocalToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"j.md"}}</tool_call>', tools);
assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), { path: 'j.md' });
r = parseLocalToolCalls('<tool_call>{"name":"read_file","arguments":"{\\"path\\":\\"s.md\\"}"}</tool_call>', tools);
assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), { path: 's.md' });

// A function block without the <tool_call> wrapper still counts.
r = parseLocalToolCalls('<function=read_file>\n<parameter=path>\nbare.md\n</parameter>\n</function>', tools);
assert.equal(r.toolCalls.length, 1);

// A changed case resolves to the one tool it matches, with that tool's types.
r = parseLocalToolCalls('<tool_call>\n<function=READ_FILE>\n<parameter=limit>\n5\n</parameter>\n</function>\n</tool_call>', tools);
assert.equal(r.toolCalls[0].function.name, 'read_file');
assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), { limit: 5 });

// Unknown tool names never become calls; plain text passes through untouched.
r = parseLocalToolCalls('<tool_call>\n<function=rm_rf>\n</function>\n</tool_call>', tools);
assert.deepEqual(r.toolCalls, []);
r = parseLocalToolCalls('Paris is the capital of France.', tools);
assert.deepEqual(r, { content: 'Paris is the capital of France.', toolCalls: [] });

// LFM2 / LFM2.5 Python-call form, as their chat template renders it: quoted strings with escapes,
// numbers, booleans, JSON objects, two calls in one list, text around the block kept.
r = parseLocalToolCalls("Let me look.<|tool_call_start|>[read_file(path='it\\'s a\\\\b.md', limit=20), write_file(path='x.js', content='line 1\\nline 2', opts={\"mode\":\"w\",\"note\":\"a)b\"})]<|tool_call_end|>", tools);
assert.equal(r.content, 'Let me look.');
assert.deepEqual(r.toolCalls.map((c) => c.function.name), ['read_file', 'write_file']);
assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), { path: "it's a\\b.md", limit: 20 });
assert.deepEqual(JSON.parse(r.toolCalls[1].function.arguments), { path: 'x.js', content: 'line 1\nline 2', opts: { mode: 'w', note: 'a)b' } });

// No arguments, booleans and None; a reply cut off before the end marker still yields the call.
r = parseLocalToolCalls('<|tool_call_start|>[read_file()]<|tool_call_end|>', tools);
assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), {});
r = parseLocalToolCalls("<|tool_call_start|>[write_file(path=\"d.md\", append=True, mode=None)]", tools);
assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), { path: 'd.md', append: true, mode: null });

// A malformed block is dropped whole, and unknown names never become calls.
r = parseLocalToolCalls("<|tool_call_start|>[read_file(path='open]<|tool_call_end|>", tools);
assert.deepEqual(r.toolCalls, []);
r = parseLocalToolCalls("<|tool_call_start|>[rm_rf(path='/')]<|tool_call_end|>", tools);
assert.deepEqual(r.toolCalls, []);

console.log('Local tool calls: ok');
