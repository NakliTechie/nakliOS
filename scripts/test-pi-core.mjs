// test-pi-core.mjs — Pi (pi-durable 1.4.0) on NakliOS seams, driven by a scripted stand-in broker.
//
// Real: pi-durable's Harness and coding tools, pi-ai's OpenAI translation, rig fileops over a
// memory backend, and the rig shell. Stand-in: the model. The broker answers three turns —
// write a file, cat it back, finish — so the test proves the seams carry tool calls both ways,
// not that any model can drive Pi. Needs `npm ci --prefix scripts/pi` first.
import assert from 'node:assert/strict';
import { openPi } from './pi/src/pi-core.mjs';
import { completionToSse } from './pi/src/broker-provider.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';
import { buildRigRegistry } from '../sys/rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../sys/rig/agent/index.mjs';
import { createShell } from '../sys/rig/cli/shell.mjs';

const fs = createFileops({ backend: new MemoryBackend() });
const registry = buildRigRegistry({ fs });
const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
const shell = createShell({ registry, face });

const requests = [];
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const script = [
  { choices: [{ message: { content: '', tool_calls: [call('c1', 'write', { path: 'note.txt', content: 'PI_NAKLIOS_OK' })] }, finish_reason: 'tool_calls' }] },
  { choices: [{ message: { content: '', tool_calls: [call('c2', 'bash', { command: 'cat note.txt' })] }, finish_reason: 'tool_calls' }] },
  { choices: [{ message: { content: 'The file says PI_NAKLIOS_OK.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 12, total_tokens: 912 } },
];
const callBroker = async (request) => { requests.push(request); return script[requests.length - 1]; };

// The SSE re-encoding alone: one delta with the tool call, then the finish reason, then [DONE].
const sse = completionToSse(script[0]);
assert.match(sse, /"tool_calls":\[\{"index":0,"id":"c1"/);
assert.match(sse, /"finish_reason":"tool_calls"/);
assert.ok(sse.endsWith('data: [DONE]\n\n'));

const pi = await openPi({ fs, shell, callBroker });
const { settled, answer } = await pi.ask('Write PI_NAKLIOS_OK to note.txt, then cat it back.');
await pi.close();
assert.equal(answer, 'The file says PI_NAKLIOS_OK.', 'the answer text is read back from its transcript entry');

assert.equal(settled.status, 'done', `run settled ${settled.status}: ${JSON.stringify(settled).slice(0, 300)}`);
assert.equal(requests.length, 3, 'three model calls: write, bash, answer');
const offered = (requests[0].tools || []).map((t) => t.function?.name).sort();
assert.deepEqual(offered, ['bash', 'edit', 'read', 'write'], 'Pi offers its four coding tools through the broker');
const file = await fs.read('workspace/note.txt', { encoding: 'utf-8' });
assert.ok(file.ok, 'the write tool wrote through rig fileops');
assert.equal(file.data, 'PI_NAKLIOS_OK');
// The bash result went back to the model as a tool message carrying the cat output.
const toolMsgs = requests[2].messages.filter((m) => m.role === 'tool');
assert.ok(toolMsgs.some((m) => String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).includes('PI_NAKLIOS_OK')),
  'the rig shell output reached the model');
assert.ok(requests[0].messages.some((m) => /NakliOS/.test(typeof m.content === 'string' ? m.content : JSON.stringify(m.content))),
  'Pi is told it runs in NakliOS with the rig shell');
console.log('pi-core: Pi wrote and read a file through rig fileops and the rig shell, 3 broker calls');
