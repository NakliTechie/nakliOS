// The reasoning rail (2026-11-15, for Loquella): a model's reasoning reaches the app as
// delta.reasoning_content, apart from the reply, and experimental_thinking switches it.
//
// Before this rail the host read DeepSeek's reasoning_content and Anthropic's thinking
// only to feed the repeat guard, then dropped it, so no app could show it.
//
// This runs the real aiGenerateEndpoint from index.html against a fake OpenAI-format stream,
// the real SDK against fake host events, and the real normaliseAgentMessages.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { extractFunction, instantiate } from './anvil-harness.mjs';
import * as agentProto from '../sys/ai/agent-protocol.mjs';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const sdkSource = await readFile(new URL('sdk/naklios.js', root), 'utf8');

// ── host: an OpenAI-format endpoint stream ─────────────────────────────
function sse(frames) {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

async function runEndpoint({ thinking, reject400 = false }) {
  const emitted = [];
  const bodies = [];
  const ctx = {
    aiHost: {},
    AbortController,
    TextDecoder,
    aiAgentProto: async () => agentProto,
    aiEmit: (_req, event) => emitted.push(event),
    aiGuardDelta: () => {},
    aiEndpointChatUrl: () => 'https://api.deepseek.com/v1/chat/completions',
    aiEndpointHeaders: () => ({}),
    aiReadEndpointError: async (res) => `HTTP ${res.status}`,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (reject400 && body.thinking) return new Response('unknown field thinking', { status: 400 });
      return sse([
        { choices: [{ delta: { reasoning_content: 'Two plus ' } }] },
        { choices: [{ delta: { reasoning_content: 'two is four.' } }] },
        { choices: [{ delta: { content: '4' }, finish_reason: 'stop' }] },
      ]);
    },
  };
  const fn = instantiate(extractFunction(html, 'aiGenerateEndpoint'), 'aiGenerateEndpoint', ctx);
  const request = {
    model: { runtime: 'endpoint', protocol: 'openai', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1' },
    messages: [{ role: 'user', content: '2+2?' }],
    maxTokens: 64,
    agent: true,
    tools: undefined,
    thinking,
  };
  const finish = await fn(request);
  return { finish, emitted, bodies };
}

{
  const { finish, emitted, bodies } = await runEndpoint({ thinking: true });
  assert.equal(finish, 'stop');
  assert.deepEqual(bodies[0].thinking, { type: 'enabled' }, 'experimental_thinking:true sends DeepSeek\'s thinking switch');
  assert.deepEqual(emitted.filter((e) => e.event === 'reasoning').map((e) => e.token), ['Two plus ', 'two is four.'],
    'reasoning reaches the app as reasoning events');
  assert.deepEqual(emitted.filter((e) => e.event === 'token').map((e) => e.token), ['4'],
    'and the reply stays apart from it');
}
{
  const { bodies } = await runEndpoint({ thinking: false });
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
}
{
  const { bodies } = await runEndpoint({ thinking: undefined });
  assert.equal('thinking' in bodies[0], false, 'an omitted switch leaves the provider default');
}
{
  const { finish, bodies } = await runEndpoint({ thinking: true, reject400: true });
  assert.equal(finish, 'stop');
  assert.equal(bodies.length, 2, 'a server that rejects the field is asked again');
  assert.equal('thinking' in bodies[1], false, 'without the thinking field');
}

// The Anthropic path forwards its thinking stream the same way.
assert.match(html, /stream\.on\('thinking', \(delta\) => \{[\s\S]{0,120}aiEmit\(request, \{ event:'reasoning', token:delta \}\)/,
  'Anthropic thinking deltas are emitted as reasoning');
// The submit path carries the switch onto the queued request, and the capability is reported.
assert.match(html, /thinking:msg\.thinking === true \|\| msg\.thinking === false \? msg\.thinking : undefined/);
assert.match(html, /experimental_aiReasoning:aiModel\.runtime === 'endpoint'/);

// ── agent messages keep earlier reasoning (DeepSeek wants it back with tools) ──
{
  const out = agentProto.normaliseAgentMessages([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', reasoning_content: 'I should search.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'r' },
  ]);
  assert.equal(out[1].reasoning_content, 'I should search.');
  assert.equal('reasoning_content' in out[0], false, 'only assistant turns carry it');
}

// ── SDK: the switch goes out, reasoning chunks come in ────────────────
{
  const posted = [];
  const listeners = [];
  const parent = { postMessage: (msg) => posted.push(msg) };
  const win = {
    parent,
    location: { search: '', origin: 'https://naklios.dev', href: 'https://naklios.dev/apps/x/' },
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    removeEventListener: () => {},
    document: { referrer: 'https://naklios.dev/', addEventListener: () => {}, visibilityState: 'visible' },
  };
  win.window = win;
  win.self = win;
  const context = vm.createContext({ ...win, window: win, console, setTimeout, clearTimeout, Promise, URL, URLSearchParams, Map, Set });
  vm.runInContext(sdkSource, context, { filename: 'naklios.js' });
  const naklios = context.window.naklios || context.naklios;
  assert.ok(naklios, 'SDK installs window.naklios');
  const deliver = (data) => listeners.forEach((fn) => fn({ data, source: parent, origin: 'https://naklios.dev' }));
  deliver({ type: 'naklios:capabilities', hosted: true, ai: true, experimental_aiReasoning: true });
  assert.equal(naklios.capabilities.experimental_aiReasoning, true);

  const stream = await naklios.ai.chat.completions.create({
    messages: [{ role: 'user', content: '2+2?' }], stream: true, agent: true, experimental_thinking: true,
  });
  const sent = posted.find((m) => m.type === 'naklios:ai:chat');
  assert.ok(sent, 'the request reached the host');
  assert.equal(sent.thinking, true, 'experimental_thinking travels as thinking');
  deliver({ type: 'naklios:ai:event', requestId: sent.requestId, event: 'reasoning', token: 'hmm' });
  deliver({ type: 'naklios:ai:event', requestId: sent.requestId, event: 'token', token: '4' });
  deliver({ type: 'naklios:ai:event', requestId: sent.requestId, event: 'done', finishReason: 'stop' });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk.choices[0].delta);
  assert.equal(chunks[0].reasoning_content, 'hmm');
  assert.equal(chunks[0].content, '', 'a reasoning chunk adds nothing to the reply text');
  assert.equal(chunks[1].content, '4');

  // Omitted switch: nothing sent.
  await naklios.ai.chat.completions.create({ messages: [{ role: 'user', content: 'x' }], stream: true });
  const second = posted.filter((m) => m.type === 'naklios:ai:chat')[1];
  assert.equal('thinking' in second, false);
}

console.log('test-ai-reasoning: ok');
