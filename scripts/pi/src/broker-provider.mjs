// broker-provider.mjs — a pi-ai provider whose transport is the NakliOS host AI broker.
//
// pi-ai builds an OpenAI chat-completions request and parses the streamed reply; only the HTTP
// call changes. The injected `fetch` hands the request body to `callBroker` (in the app, a
// postMessage to the page, which calls naklios.ai.chat.completions.create with agent:true) and
// answers with the broker's whole reply re-encoded as OpenAI stream events. The broker serves
// agent turns buffered, so text arrives at the end of each turn, as it does for Dish.
//
// No credential exists here: pi-ai insists on an apiKey string, so a placeholder satisfies it and
// never leaves the Worker. The host holds the real key and the model choice.

import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export const PROVIDER_ID = 'naklios';
export const MODEL_ID = 'host';

export function completionToSse(completion) {
  const choice = completion?.choices?.[0] || {};
  const msg = choice.message || {};
  const base = { id: completion?.id || 'naklios', object: 'chat.completion.chunk', created: 0, model: completion?.model || MODEL_ID };
  const delta = { role: 'assistant' };
  if (typeof msg.content === 'string' && msg.content) delta.content = msg.content;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    delta.tool_calls = msg.tool_calls.map((c, index) => ({
      index, id: c.id, type: 'function',
      function: { name: c.function?.name || '', arguments: c.function?.arguments || '{}' },
    }));
  }
  const events = [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || (delta.tool_calls ? 'tool_calls' : 'stop') }] },
  ];
  if (completion?.usage) events.push({ ...base, choices: [], usage: completion.usage });
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
}

export function brokerFetch(callBroker) {
  return async (_url, init = {}) => {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body));
    const request = { messages: body.messages, tools: body.tools, tool_choice: body.tool_choice,
      max_tokens: body.max_tokens ?? body.max_completion_tokens };
    let completion;
    try { completion = await callBroker(request, init.signal); }
    catch (e) {
      return new Response(JSON.stringify({ error: { message: String(e?.message || e) } }),
        { status: 502, headers: { 'content-type': 'application/json' } });
    }
    return new Response(completionToSse(completion), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

export function createBrokerProvider(callBroker, { contextWindow = 128000, maxTokens = 16000 } = {}) {
  const inner = openAICompletionsApi();
  const fetch = brokerFetch(callBroker);
  const withTransport = (options) => ({ ...(options || {}), fetch, apiKey: 'naklios-host' });
  const api = {
    stream: (model, context, options) => inner.stream(model, context, withTransport(options)),
    streamSimple: (model, context, options) => inner.streamSimple(model, context, withTransport(options)),
  };
  const model = {
    id: MODEL_ID, name: 'NakliOS AI', api: 'openai-completions', provider: PROVIDER_ID,
    baseUrl: 'https://naklios.invalid/v1', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens,
  };
  return createProvider({
    id: PROVIDER_ID, name: 'NakliOS AI', baseUrl: model.baseUrl,
    auth: { apiKey: { name: 'NakliOS host', resolve: async () => ({ auth: { apiKey: 'naklios-host' } }) } },
    models: [model], api,
  });
}
