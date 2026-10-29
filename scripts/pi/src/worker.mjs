// worker.mjs — the Pi app's module Worker (bundled to apps/pi/pi-worker.js by scripts/build-pi.mjs).
//
// Pi runs here. The page owns the NakliOS SDK, so two things cross to it by message:
//   model calls  {type:'broker'}  → naklios.ai, answered by {type:'broker-reply'}
//   storage      {type:'fs'}      → the page's backend (Folder/Crate via naklios.fs, OPFS, or memory),
//                                    answered by {type:'fs-reply'}
// The page sends {type:'init', backend} first, naming the storage; Pi's files and its JSONL sessions
// both live there, so a reload brings back the workspace and the conversation.

import { openPi } from './pi-core.mjs';
import { createRemoteBackend } from '../../../sys/rig/fileops/remote-backend.mjs';
import { createFileops, MemoryBackend } from '../../../sys/rig/fileops/index.mjs';
import { buildRigRegistry } from '../../../sys/rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../../sys/rig/agent/index.mjs';
import { createShell } from '../../../sys/rig/cli/shell.mjs';

let nextId = 1;
const pending = new Map();
function request(msg, signal) {
  const id = nextId++;
  self.postMessage({ ...msg, id });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    signal?.addEventListener('abort', () => { pending.delete(id); reject(new Error('aborted')); }, { once: true });
  });
}
const callBroker = (req, signal) => request({ type: 'broker', request: req }, signal);
const callStorage = (method, args) => request({ type: 'fs', method, args });

let ready = null;
function start(backendDesc) {
  const fs = createFileops({ backend: createRemoteBackend(callStorage, backendDesc) });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  const shell = createShell({ registry, face });
  return openPi({ fs, shell, callBroker }).then((pi) => ({ pi, fs }));
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === 'broker-reply' || msg.type === 'fs-reply') {
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.type === 'broker-reply') { if (msg.error) waiter.reject(new Error(msg.error)); else waiter.resolve(msg.completion); }
    else waiter.resolve(msg.result);
    return;
  }
  if (msg.type === 'init') {
    ready = start(msg.backend || {});
    ready.then(() => self.postMessage({ type: 'ready' }), (e) => self.postMessage({ type: 'fatal', error: String(e?.stack || e) }));
    return;
  }
  if (!ready) { self.postMessage({ type: 'answer', id: msg.id, error: 'Pi is not initialised' }); return; }
  if (msg.type === 'ask') {
    try {
      const { pi } = await ready;
      const { settled, answer } = await pi.ask(String(msg.text || ''));
      self.postMessage({ type: 'answer', id: msg.id, settled: JSON.parse(JSON.stringify(settled)), answer });
    } catch (e) {
      self.postMessage({ type: 'answer', id: msg.id, error: String(e?.stack || e?.message || e) });
    }
    return;
  }
  if (msg.type === 'read') {
    const { fs } = await ready;
    const r = await fs.read(String(msg.path || '').replace(/^\/+/, ''), { encoding: 'utf-8' });
    self.postMessage({ type: 'file', id: msg.id, result: r });
  }
};
