// Provider-neutral DSH blocks to the NakliOS agent broker's OpenAI contract.
export function toChatRequest(options) {
  const messages = [];
  if (options.system) messages.push({ role: 'system', content: options.system });
  for (const message of options.messages) {
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    const texts = [], calls = [];
    for (const block of blocks) {
      if (block.type === 'text') texts.push(block.text);
      else if (block.type === 'tool-call') calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } });
      else if (block.type === 'reasoning' || block.type === 'tool-addition' || block.type === 'tool-removal') continue;
      else throw new Error(`Dish's shared model adapter cannot send ${block.type} blocks`);
    }
    const row = { role: message.role, content: texts.join('\n') };
    if (calls.length) row.tool_calls = calls;
    if (message.role === 'tool') row.tool_call_id = message.source.callId;
    if (message.role === 'developer' && !row.content) continue;
    messages.push(row);
  }
  return { messages, agent: true, stream: false, max_tokens: options.maxTokens,
    ...(options.tools?.length ? { tools: options.tools.map(tool => ({ type: 'function', function: tool })) } : {}) };
}
export function* responseChunks(response) {
  const choice = response.choices?.[0];
  if (!choice?.message) throw new Error('NakliOS returned no completion message');
  let index = 0;
  const blocks = [];
  if (choice.message.reasoning_content) blocks.push({ type: 'reasoning', text: choice.message.reasoning_content });
  if (choice.message.content) blocks.push({ type: 'text', text: choice.message.content });
  for (const call of choice.message.tool_calls || []) blocks.push({ type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments });
  for (const block of blocks) {
    yield { type: 'block-start', index, blockType: block.type };
    if (block.type === 'tool-call') yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
    else yield { type: `${block.type}-delta`, index, text: block.text };
    yield { type: 'block-end', index, block };
    index++;
  }
  if (response.usage) {
    const usage = response.usage, cache = usage.prompt_tokens_details?.cached_tokens || 0;
    yield { type: 'usage', usage: { inputTokens: Math.max(0, usage.prompt_tokens - cache), outputTokens: usage.completion_tokens,
      ...(cache ? { cacheReadTokens: cache } : {}), ...(usage.total_tokens != null ? { totalTokens: usage.total_tokens } : {}) } };
  }
  yield { type: 'finish', reason: { kind: choice.finish_reason === 'tool_calls' ? 'tool-calls' : choice.finish_reason === 'length' ? 'max-tokens' : 'stop' } };
}
