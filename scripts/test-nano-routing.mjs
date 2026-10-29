// Guards the on-device (Gemini Nano) tier split in the host:
//   - GP (non-agent) requests default to Nano when available;
//   - agent-tier requests NEVER resolve to Nano (they use the configured model).
// Grep-based, like the other host-contract tests — it pins the invariants that
// keep coding off the small on-device model.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const host = await readFile(new URL('../index.html', import.meta.url), 'utf8');

// Execute the selected-model policy; source wiring pins below are supplemental.
const {extractFunction,instantiate}=await import('./anvil-harness.mjs');
const selected={id:'selected-endpoint'}, nano={id:'nano'};
for(const available of [true,false]) {
  const resolve=instantiate(extractFunction(host,'aiResolveModel'),'aiResolveModel',{
    aiSelectedModel:()=>selected,aiNano:{available},aiNanoModel:()=>nano,
  });
  assert.equal(resolve(true),selected,'agent requests retain the selected model');
  assert.equal(resolve(false),available?nano:selected,'general requests use available local Nano');
}

// Submit path resolves by tier and the ondevice runtime is dispatched + gated.
assert.match(host, /const model = aiResolveModel\(wantsAgent\)/, 'aiHostSubmit routes by tier');
assert.match(host, /request\.model\.runtime === 'ondevice'\) return aiGenerateOnDevice/,
  'ondevice dispatches to the on-device generator');
assert.match(host, /if \(model\.runtime === 'ondevice'\) return aiNano\.available/,
  'ondevice availability is gated on the Nano probe');
assert.match(host, /model\.runtime !== 'endpoint' && !AI_LOCAL_TOOL_MODELS\.has\(model\.key\)/,
  'agent tool-calling runs on an endpoint or a tool-capable in-browser model, never Nano');

// The coding apps that consume the host agent tier are named and excluded from
// the GP-default display.
assert.match(host, /const AI_HOST_AGENT_APPS = new Set\(\['anvil', 'forge', 'dish', 'pi'\]\)/,
  'anvil, forge and dish are the host agent-tier apps');
assert.match(host, /AI_HOST_AGENT_APPS\.has\(appId\) \? aiSelectedModel\(\) : aiResolveModel\(false\)/,
  'agent apps report their configured model; every other app reports the GP model');

console.log('nano-routing: all invariants hold');
