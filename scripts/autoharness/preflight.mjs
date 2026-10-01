#!/usr/bin/env node
// Which bench endpoints can serve a run right now? A listed model is not an available one: each
// endpoint gets one real completion with a real tools array, and passes only if it returns a tool
// call (scripts/testbed-preflight.mjs's rule, for the autoharness endpoints).
//   node scripts/autoharness/preflight.mjs [name …]      exit 0 when every named endpoint passes
import { ENDPOINTS, resolveEndpoint } from './endpoints.mjs';

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ENDPOINTS);
const TOOLS = [{ type: 'function', function: { name: 'shell', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }];
let bad = 0;
for (const name of names) {
  const t0 = Date.now();
  let line;
  try {
    const ep = await resolveEndpoint({ endpoint: name });
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 90000);
    const res = await fetch(`${ep.base}/chat/completions`, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.key}` },
      body: JSON.stringify({ model: ep.model, temperature: 0, tool_choice: 'auto', tools: TOOLS, messages: [{ role: 'user', content: 'List the files in the current directory. Use the shell tool.' }] }) });
    clearTimeout(timer);
    const j = await res.json().catch(() => ({}));
    const call = j?.choices?.[0]?.message?.tool_calls?.[0];
    const ok = res.ok && call?.function?.name === 'shell';
    line = `${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(18)} ${ep.model.padEnd(28)} http ${res.status}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${ok ? `shell ${call.function.arguments}` : String(j?.error?.message || j?.error?.type || '').slice(0, 120)}${j?.usage?.prompt_tokens ? '' : '  (no usage reported)'}`;
    if (!ok) bad++;
  } catch (e) { bad++; line = `FAIL  ${name.padEnd(18)} ${String(e.message).slice(0, 140)}`; }
  console.log(line);
}
process.exit(bad ? 1 : 0);
