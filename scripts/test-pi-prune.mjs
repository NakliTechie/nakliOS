// test-pi-prune.mjs — Pi's pruning extension (scripts/pi/src/prune-extension.mjs) on the real pi-durable harness.
//
// The stand-in model reads big.md, reads it again, then answers. The third request must carry the first read
// as the superseded notice, while Pi's own session keeps it whole. Needs `npm ci --prefix scripts/pi` first.
import assert from 'node:assert/strict';
import { openPi } from './pi/src/pi-core.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';
import { buildRigRegistry } from '../sys/rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../sys/rig/agent/index.mjs';
import { createShell } from '../sys/rig/cli/shell.mjs';
import { SUPERSEDED } from '../sys/ai/supersede-prune.mjs';

const fs = createFileops({ backend: new MemoryBackend() });
const registry = buildRigRegistry({ fs });
const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
const shell = createShell({ registry, face });
await fs.mkdir('workspace', { recursive: true });
await fs.write('workspace/big.md', Array.from({ length: 200 }, (_, i) => `line ${i} of a long file that the agent reads twice`).join('\n'));

const requests = [];
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const script = [
  { choices: [{ message: { content: '', tool_calls: [call('r1', 'read', { path: 'big.md' })] }, finish_reason: 'tool_calls' }] },
  { choices: [{ message: { content: '', tool_calls: [call('r2', 'read', { path: 'big.md' })] }, finish_reason: 'tool_calls' }] },
  { choices: [{ message: { content: 'Read it twice.' }, finish_reason: 'stop' }] },
];
const callBroker = async (request) => { requests.push(structuredClone(request)); return script[requests.length - 1]; };

const pi = await openPi({ fs, shell, callBroker, prune: { protectTokens: 100, minSavingsTokens: 100, keepLast: 1 } });
const { answer } = await pi.ask('Read big.md twice.');
await pi.close();
assert.equal(answer, 'Read it twice.');
assert.equal(requests.length, 3);
const toolMsgs = requests[2].messages.filter((m) => m.role === 'tool');
const text = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join(''));
assert.equal(toolMsgs.length, 2);
assert.equal(text(toolMsgs[0]), SUPERSEDED, 'the first read reaches the model as the notice');
assert.match(text(toolMsgs[1]), /line 199/, 'the newest read is sent whole');
const second = requests[1].messages.filter((m) => m.role === 'tool');
assert.match(text(second[0]), /line 0/, 'with one read there is nothing to supersede');
console.log('pi prune extension — superseded read pruned for the request only: PASS');
