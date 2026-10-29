// test-pi-persist.mjs — Pi's files and conversation survive a reopen, through the page/Worker backend proxy.
//
// One MemoryBackend stands in for the page's real storage (naklios.fs Folder/Crate or OPFS). Each
// "load" builds what the app builds: a remote backend over serveBackend, Rig fileops and shell on top,
// and Pi with JSONL sessions on the same env. Load 1 writes a file; load 2 is a fresh Harness on the
// same storage and must find the file and the earlier conversation. Needs `npm ci --prefix scripts/pi`.
import assert from 'node:assert/strict';
import { openPi } from './pi/src/pi-core.mjs';
import { createRemoteBackend, describeBackend, serveBackend } from '../sys/rig/fileops/remote-backend.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';
import { buildRigRegistry } from '../sys/rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../sys/rig/agent/index.mjs';
import { createShell } from '../sys/rig/cli/shell.mjs';

const pageBackend = new MemoryBackend();
const handle = serveBackend(pageBackend);
const desc = describeBackend(pageBackend);
let crossings = 0;

function load(callBroker) {
  // structuredClone stands in for postMessage: only cloneable data crosses.
  const call = async (method, args) => { crossings++; return structuredClone(await handle(method, structuredClone(args))); };
  const fs = createFileops({ backend: createRemoteBackend(call, desc) });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  return openPi({ fs, shell: createShell({ registry, face }), callBroker });
}

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const text = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

// Load 1: write a file, answer.
const first = [];
const script1 = [
  { choices: [{ message: { content: '', tool_calls: [call('c1', 'write', { path: 'keep.txt', content: 'PERSISTED_OK' })] }, finish_reason: 'tool_calls' }] },
  { choices: [{ message: { content: 'Saved keep.txt.' }, finish_reason: 'stop' }] },
];
const pi1 = await load(async (req) => { first.push(req); return script1[first.length - 1]; });
const r1 = await pi1.ask('Remember the word PELICAN and save PERSISTED_OK to keep.txt.');
await pi1.close();
assert.equal(r1.settled.status, 'done');
assert.equal(r1.answer, 'Saved keep.txt.');

// The proxy carried the work, and the page's storage holds both the file and the session log.
assert.ok(crossings > 0, 'storage calls crossed the page/Worker channel');
const files = createFileops({ backend: pageBackend });
assert.equal((await files.read('workspace/keep.txt', { encoding: 'utf-8' })).data, 'PERSISTED_OK');
const sessions = await files.list('.pi/sessions', { recursive: true });
assert.ok(sessions.ok && sessions.entries.some((e) => e.type === 'file'), 'Pi\'s JSONL session files are on the same storage');

// Load 2: a fresh Pi on the same storage sees the file and the earlier conversation.
const second = [];
const pi2 = await load(async (req) => { second.push(req); return { choices: [{ message: { content: 'The word was PELICAN.' }, finish_reason: 'stop' }] }; });
const r2 = await pi2.ask('What word did I ask you to remember?');
await pi2.close();
assert.equal(r2.settled.status, 'done');
assert.equal(r2.answer, 'The word was PELICAN.');
const history = second[0].messages.map(text).join('\n');
assert.match(history, /Remember the word PELICAN/, 'the reopened session sends the earlier user turn to the model');
assert.match(history, /Saved keep\.txt\./, 'and the earlier answer');
assert.equal((await files.read('workspace/keep.txt', { encoding: 'utf-8' })).data, 'PERSISTED_OK');

// Errors keep their code across the channel.
const remote = createRemoteBackend(async (m, a) => handle(m, a), desc);
await assert.rejects(remote.readBinary('workspace/missing.txt'), (e) => e.code !== undefined);
console.log(`pi-persist: files and conversation survive a reopen through the backend proxy (${crossings} storage calls)`);
