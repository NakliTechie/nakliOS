// worker.mjs — the Pi app's module Worker (bundled to apps/pi/pi-worker.js by scripts/build-pi.mjs).
//
// Pi runs here. The page owns the NakliOS SDK, so model calls go out as {type:'broker'} messages and
// come back as {type:'broker-reply'}. Files live in rig fileops over a memory backend for this spike;
// persistence through naklios.fs is the next step.

import { openPi } from './pi-core.mjs';
import { createFileops, MemoryBackend } from '../../../sys/rig/fileops/index.mjs';
import { buildRigRegistry } from '../../../sys/rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../../sys/rig/agent/index.mjs';
import { createShell } from '../../../sys/rig/cli/shell.mjs';

const fs = createFileops({ backend: new MemoryBackend() });
const registry = buildRigRegistry({ fs });
const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
const shell = createShell({ registry, face });

let nextId = 1;
const pending = new Map();
function callBroker(request, signal) {
  const id = nextId++;
  self.postMessage({ type: 'broker', id, request });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    signal?.addEventListener('abort', () => { pending.delete(id); reject(new Error('aborted')); }, { once: true });
  });
}

const ready = openPi({ fs, shell, callBroker });

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === 'broker-reply') {
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error)); else waiter.resolve(msg.completion);
    return;
  }
  if (msg.type === 'ask') {
    try {
      const pi = await ready;
      const { settled, answer } = await pi.ask(String(msg.text || ''));
      self.postMessage({ type: 'answer', id: msg.id, settled: JSON.parse(JSON.stringify(settled)), answer });
    } catch (e) {
      self.postMessage({ type: 'answer', id: msg.id, error: String(e?.stack || e?.message || e) });
    }
    return;
  }
  if (msg.type === 'read') {
    const r = await fs.read(String(msg.path || '').replace(/^\/+/, ''), { encoding: 'utf-8' });
    self.postMessage({ type: 'file', id: msg.id, result: r });
  }
};
ready.then(() => self.postMessage({ type: 'ready' }), (e) => self.postMessage({ type: 'fatal', error: String(e?.stack || e) }));
