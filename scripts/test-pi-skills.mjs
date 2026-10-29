// test-pi-skills.mjs — Pi reads the NakliOS skills library: the Skills section reaches the model and the
// `skill` tool loads a body on demand. The library is a stand-in for naklios.experimental_skills; the
// model is scripted. Needs `npm ci --prefix scripts/pi`.
import assert from 'node:assert/strict';
import { openPi } from './pi/src/pi-core.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';
import { buildRigRegistry } from '../sys/rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../sys/rig/agent/index.mjs';
import { createShell } from '../sys/rig/cli/shell.mjs';

const fs = createFileops({ backend: new MemoryBackend() });
const registry = buildRigRegistry({ fs });
const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });

const library = { shout: { name: 'shout', description: 'How to answer when the user asks for a shouted reply', status: 'active', body: 'Reply ONLY in capital letters.' } };
const reads = [];
const skills = {
  list: async () => Object.values(library).map(({ name, description, status }) => ({ name, description, status })),
  read: async (name) => { reads.push(name); return library[name] || null; },
};

const requests = [];
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const script = [
  { choices: [{ message: { content: '', tool_calls: [call('s1', 'skill', { name: 'nope' }), call('s2', 'skill', { name: 'shout' })] }, finish_reason: 'tool_calls' }] },
  { choices: [{ message: { content: 'HELLO THERE.' }, finish_reason: 'stop' }] },
];
const pi = await openPi({ fs, shell: createShell({ registry, face }), skills, storage: 'memory',
  callBroker: async (req) => { requests.push(req); return script[requests.length - 1]; } });
const { settled, answer } = await pi.ask('Shout hello at me.');
await pi.close();

const text = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
assert.equal(settled.status, 'done');
assert.equal(answer, 'HELLO THERE.');
assert.ok((requests[0].tools || []).some((t) => t.function?.name === 'skill'), 'Pi offers the skill tool');
const system = requests[0].messages.filter((m) => m.role === 'system' || m.role === 'developer').map(text).join('\n');
assert.match(system, /# Skills/, 'the Skills section reaches the model');
assert.match(system, /\*\*shout\*\*: How to answer when the user asks for a shouted reply/, 'with each usable skill\'s name and description');
assert.doesNotMatch(system, /Reply ONLY in capital letters/, 'but not its body (loaded on demand)');
assert.deepEqual(reads, ['nope', 'shout'], 'the skill tool read the library by name');
const results = requests[1].messages.filter((m) => m.role === 'tool').map(text).join('\n');
assert.match(results, /# Skill: shout[\s\S]*Reply ONLY in capital letters\./, 'the body reached the model as the tool result');
assert.match(results, /No usable skill named \\?"nope\\?"/, 'an unknown name is an error result, not a crash');

// No library: no section and no failure.
const bare = await openPi({ fs, shell: createShell({ registry, face }), storage: 'memory',
  skills: { list: async () => [], read: async () => null },
  callBroker: async (req) => { requests.push(req); return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }; } });
await bare.ask('hi');
await bare.close();
assert.doesNotMatch(requests.at(-1).messages.map(text).join('\n'), /# Skills/, 'an empty library adds no section');
console.log('pi-skills: the Skills section reaches the model, the skill tool loads bodies, unknown names are error results');
