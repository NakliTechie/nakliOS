// Guards the on-device (Gemini Nano) tier split in the host:
//   - GP (non-agent) requests default to Nano when available;
//   - agent-tier requests NEVER resolve to Nano (they use the configured model).
// Grep-based, like the other host-contract tests — it pins the invariants that
// keep coding off the small on-device model.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const host = await readFile(new URL('../index.html', import.meta.url), 'utf8');

// The resolver exists and is tier-aware.
assert.match(host, /function aiResolveModel\(wantsAgent\)\s*\{/, 'aiResolveModel(wantsAgent) exists');

// Agent tier returns the user's selection UNCONDITIONALLY (never Nano). We assert
// the resolver short-circuits on wantsAgent before any Nano branch.
const resolver = host.match(/function aiResolveModel\(wantsAgent\)\s*\{[\s\S]*?\n\}/)[0];
assert.match(resolver, /if\s*\(wantsAgent\)\s*return\s+selected;/,
  'agent tier returns the selected model and never falls through to Nano');
// Within the resolver, the only aiNanoModel() use sits AFTER the wantsAgent guard.
const guardIdx = resolver.indexOf('if (wantsAgent)');
const nanoIdx = resolver.indexOf('aiNanoModel()');
assert.ok(guardIdx >= 0 && nanoIdx > guardIdx, 'aiNanoModel() is only reachable on the GP path');
// GP defaults to Nano whenever available (wired in by default), regardless of
// the agent-tier endpoint selection.
assert.match(resolver, /if\s*\(aiNano\.available\)\s*return\s+aiNanoModel\(\);/,
  'GP prefers on-device Nano whenever it is available');

// Submit path resolves by tier and the ondevice runtime is dispatched + gated.
assert.match(host, /const model = aiResolveModel\(wantsAgent\)/, 'aiHostSubmit routes by tier');
assert.match(host, /request\.model\.runtime === 'ondevice'\) return aiGenerateOnDevice/,
  'ondevice dispatches to the on-device generator');
assert.match(host, /if \(model\.runtime === 'ondevice'\) return aiNano\.available/,
  'ondevice availability is gated on the Nano probe');
assert.match(host, /Tool-calling requires an OpenAI-compatible endpoint model/,
  'agent tool-calling still requires an endpoint');

// The coding apps that consume the host agent tier are named and excluded from
// the GP-default display.
assert.match(host, /const AI_HOST_AGENT_APPS = new Set\(\['anvil', 'forge', 'dish'\]\)/,
  'anvil, forge and dish are the host agent-tier apps');
assert.match(host, /AI_HOST_AGENT_APPS\.has\(appId\) \? aiSelectedModel\(\) : aiResolveModel\(false\)/,
  'agent apps report their configured model; every other app reports the GP model');

console.log('nano-routing: all invariants hold');
