// Typed removal (rmdir / unlink) on folder storage: FsaBackend for a folder Anvil picked, and
// CrateBackend over the NakliOS host for a hosted project. Before 2026-11-23 both refused it, so an
// agent could not remove an empty folder and fell back to `rm -r`. The browser handle is a mock with
// FileSystemHandle.remove() semantics: non-recursive removal refuses a non-empty directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FsaBackend } from '../fsa-backend.mjs';
import { CrateBackend } from '../crate-backend.mjs';
import { createFileops } from '../index.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';
import { createShell } from '../../cli/shell.mjs';
import { MemoryBackend } from '../memory-backend.mjs';
import { removeHandleTyped } from '../handle-remove.mjs';
import { makeToolExecutor } from '../../../ai/agent-tools.mjs';

const domError = (name, message = name) => Object.assign(new Error(message), { name });

class Entry {
  constructor(kind, name, parent) { this.kind = kind; this.name = name; this.parent = parent; this.children = new Map(); this.bytes = new Uint8Array(); }
  async remove({ recursive = false } = {}) {
    if (!this.parent || this.parent.children.get(this.name) !== this) throw domError('NotFoundError');
    if (this.kind === 'directory' && this.children.size && !recursive) throw domError('InvalidModificationError', 'not empty');
    this.parent.children.delete(this.name);
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    let child = this.children.get(name);
    if (!child && create) { child = new Entry('directory', name, this); this.children.set(name, child); }
    if (!child) throw domError('NotFoundError');
    if (child.kind !== 'directory') throw domError('TypeMismatchError');
    return child;
  }
  async getFileHandle(name, { create = false } = {}) {
    let child = this.children.get(name);
    if (!child && create) { child = new Entry('file', name, this); this.children.set(name, child); }
    if (!child) throw domError('NotFoundError');
    if (child.kind !== 'file') throw domError('TypeMismatchError');
    return child;
  }
  async removeEntry(name, { recursive = false } = {}) { const c = this.children.get(name); if (!c) throw domError('NotFoundError'); await c.remove({ recursive }); }
  entries() { const it = this.children.entries(); return { [Symbol.asyncIterator]() { return this; }, async next() { const n = it.next(); return n.done ? n : { done: false, value: n.value }; }, async return() { return { done: true }; } }; }
  async getFile() { const b = this.bytes; return { size: b.length, lastModified: 1, slice: (a, z) => new Blob([b.slice(a, z)]), async arrayBuffer() { return b.buffer.slice(0); } }; }
  async createWritable() { const self = this; return { async write(d) { self.bytes = new Uint8Array(d); }, async close() {}, async truncate() {} }; }
}
globalThis.FileSystemHandle = class { remove() {} };

// The agent's route: Anvil's shell tool over a granted face (no interactive confirm).
function shellOver(fs) {
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'test' });
  return makeToolExecutor({ shell: createShell({ registry, face }), face, mode: 'code' });
}
const run = async (execute, command) => {
  const text = String(await execute('shell', { command }));
  const m = /\[exit (\d+)\]\s*$/.exec(text);
  return { code: m ? Number(m[1]) : -1, text };
};

test('the helper removes an empty directory and a file, and refuses the wrong type and a non-empty directory', async () => {
  const root = new Entry('directory', '', null);
  const empty = await root.getDirectoryHandle('empty', { create: true });
  const full = await root.getDirectoryHandle('full', { create: true });
  await full.getFileHandle('keep.txt', { create: true });
  await root.getFileHandle('a.txt', { create: true });
  await assert.rejects(removeHandleTyped(root, 'a.txt', 'dir'), e => e.code === 'ENOTDIR');
  await assert.rejects(removeHandleTyped(root, 'empty', 'non-dir'), e => e.code === 'EISDIR');
  await assert.rejects(removeHandleTyped(root, 'full', 'dir'), e => e.code === 'ENOTEMPTY');
  assert.ok(full.children.has('keep.txt'), 'nothing inside a non-empty directory is removed');
  await assert.rejects(removeHandleTyped(root, 'none', 'dir'), e => e.code === 'ENOENT');
  await removeHandleTyped(root, 'empty', 'dir');
  await removeHandleTyped(root, 'a.txt', 'non-dir');
  assert.deepEqual([...root.children.keys()], ['full']);
  assert.ok(empty.parent.children.get('empty') === undefined);
});

test('a picked folder (FsaBackend): rmdir removes an empty folder, refuses a full one, and unlink removes a file', async () => {
  const root = new Entry('directory', '', null);
  const backend = new FsaBackend(root);
  assert.equal(backend.supportsTypedRemoval, true);
  const fs = createFileops({ backend });
  await fs.write('tmp/probe.txt', 'probe');
  await fs.write('src/keep.js', 'keep');
  const shell = shellOver(fs);
  assert.equal((await run(shell, 'unlink tmp/probe.txt')).code, 0);
  assert.equal((await run(shell, 'rmdir tmp')).code, 0);
  assert.equal(root.children.has('tmp'), false);
  const refused = await run(shell, 'rmdir src');
  assert.notEqual(refused.code, 0);
  assert.match(refused.text, /not empty/i);
  assert.equal((await fs.read('src/keep.js', { encoding: 'utf-8' })).data, 'keep');
});

test('a hosted project (CrateBackend): rmdir goes to the host as a typed delete, and a host without it still refuses', async () => {
  const calls = [];
  const files = new Map([['ws/p/tmp/', true]]);
  const host = {
    supportsTypedRemoval: true, supportsBoundedReads: false,
    async readBinary() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    async write() {}, async exists(p) { return [...files.keys()].some(k => k === p + '/' || k.startsWith(p + '/')); },
    async list(prefix) { return [...files.keys()].filter(k => k.startsWith(prefix + '/')); },
    async stat(p) { return files.has(p + '/') ? { type: 'dir', size: 0 } : null; },
    async delete(p, options) { calls.push({ p, kind: options?.kind }); files.delete(p + '/'); },
  };
  const fs = createFileops({ backend: new CrateBackend(host), root: 'ws/p' });
  const r = await fs.remove('tmp', { kind: 'dir', follow: false, metadataOnly: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(calls, [{ p: 'ws/p/tmp', kind: 'dir' }]);
  host.supportsTypedRemoval = false;
  files.set('ws/p/tmp/', true);
  const refused = await fs.remove('tmp', { kind: 'dir', follow: false, metadataOnly: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'ENOTSUP');
  assert.equal(calls.length, 1, 'no untyped delete happens instead');
});
