import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend } from '../memory-backend.mjs';
import { FsaBackend } from '../fsa-backend.mjs';
import { CrateBackend } from '../crate-backend.mjs';
import { OverlayBackend } from '../overlay-backend.mjs';
import { createFileops } from '../fileops.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';
import { createIO, IOFailure } from '../../cli/io.mjs';

const encoded = (text) => new TextEncoder().encode(text);
function observedBytes(text) {
  let copies = 0;
  class ObservedBytes extends Uint8Array {
    slice(...args) { copies++; return super.slice(...args); }
  }
  return { bytes: new ObservedBytes(encoded(text)), copies: () => copies };
}
function install(backend, path, bytes) { backend.files.set(path, { bytes, mtimeMs: 1 }); }
function mockFsa(snapshotAt) {
  let snapshots = 0, allocations = 0;
  const fileHandle = { async getFile() {
    const bytes = encoded(snapshotAt(snapshots++));
    return { size: bytes.byteLength, lastModified: 1, async arrayBuffer() {
      allocations++; return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } };
  } };
  const root = {
    async getFileHandle(name) { if (name !== 'file') throw new Error('missing'); return fileHandle; },
    async getDirectoryHandle() { throw new Error('missing'); },
  };
  return { backend: new FsaBackend(root), allocations: () => allocations, snapshots: () => snapshots };
}

test('bounded Memory reads reject before their defensive copy', async () => {
  const backend = new MemoryBackend(), observed = observedBytes('oversized');
  install(backend, 'file', observed.bytes);
  await assert.rejects(backend.readBinary('file', { maxBytes: 2 }), (error) => error.code === 'EFBIG');
  assert.equal(observed.copies(), 0);
  assert.equal((await createFileops({ backend }).read('file', { maxBytes: 2 })).code, 'EFBIG');
  assert.equal(observed.copies(), 0);
  assert.deepEqual(Array.from(await backend.readBinary('file')), Array.from(encoded('oversized')));
  assert.equal(observed.copies(), 1);
});

test('bounded Memory reads recheck current bytes after stale metadata', async () => {
  const backend = new MemoryBackend(), observed = observedBytes('new oversized contents');
  install(backend, 'file', observed.bytes);
  backend.stat = async () => ({ type: 'file', size: 1, mtimeMs: 1 });
  const result = await createFileops({ backend }).read('file', { maxBytes: 2 });
  assert.equal(result.code, 'EFBIG');
  assert.equal(observed.copies(), 0);
});

test('zero-byte budgets admit empty files and reject nonempty files', async () => {
  const backend = new MemoryBackend(), fs = createFileops({ backend });
  await fs.write('empty', ''); await fs.write('nonempty', 'x');
  assert.deepEqual((await fs.read('empty', { maxBytes: 0 })).data, new Uint8Array());
  assert.equal((await fs.read('nonempty', { maxBytes: 0 })).code, 'EFBIG');
});

test('bounded FSA reads reject oversized fresh snapshots before arrayBuffer', async () => {
  const direct = mockFsa(() => 'oversized');
  await assert.rejects(direct.backend.readBinary('file', { maxBytes: 2 }), (error) => error.code === 'EFBIG');
  assert.equal(direct.allocations(), 0);
  const raced = mockFsa((at) => at < 2 ? 'ok' : 'grown past the limit');
  assert.equal((await createFileops({ backend: raced.backend }).read('file', { maxBytes: 2 })).code, 'EFBIG');
  assert.equal(raced.snapshots(), 3);
  assert.equal(raced.allocations(), 0);
});

test('bounded FSA reads use the checked immutable File snapshot', async () => {
  const fsa = mockFsa((at) => at === 0 ? 'ok' : 'replacement that exceeds the limit');
  assert.deepEqual(await fsa.backend.readBinary('file', { maxBytes: 2 }), encoded('ok'));
  assert.equal(fsa.snapshots(), 1);
  assert.equal(fsa.allocations(), 1);
  await assert.rejects(fsa.backend.readBinary('file', { maxBytes: 2 }), (error) => error.code === 'EFBIG');
  assert.equal(fsa.allocations(), 1);
});

test('unbounded FSA callers preserve full reads', async () => {
  const fsa = mockFsa(() => 'ordinary existing caller');
  assert.deepEqual(await fsa.backend.readBinary('file'), encoded('ordinary existing caller'));
  assert.equal(fsa.allocations(), 1);
});

test('Overlay metadata traversal propagates bounds without pinning oversized bytes', async () => {
  const base = new MemoryBackend(), observed = observedBytes('oversized');
  install(base, 'dir/file', observed.bytes);
  const overlay = new OverlayBackend(base), nested = new OverlayBackend(overlay);
  const result = await createFileops({ backend: nested }).read('dir/file', { maxBytes: 2 });
  assert.equal(result.code, 'EFBIG');
  assert.equal(observed.copies(), 0);
  assert.equal(overlay.pins.has('dir/file'), false);
  assert.equal(nested.pins.has('dir/file'), false);
  assert.equal(overlay.pinHeldBytes, 0);
  assert.equal(nested.pinHeldBytes, 0);
});

test('Overlay pinning rejects growth after stale metadata without copying', async () => {
  const base = new MemoryBackend(), observed = observedBytes('oversized');
  install(base, 'file', observed.bytes);
  base.stat = async () => ({ type: 'file', size: 1, mtimeMs: 1 });
  const overlay = new OverlayBackend(base);
  assert.equal((await createFileops({ backend: overlay }).read('file', { maxBytes: 2 })).code, 'EFBIG');
  assert.equal(observed.copies(), 0);
  assert.equal(overlay.pins.has('file'), false);
});

test('Overlay held pins and writes check size before copying', async () => {
  const overlay = new OverlayBackend(new MemoryBackend());
  const held = observedBytes('held contents'), written = observedBytes('written contents');
  overlay.pins.set('held', { stat: { type: 'file', size: held.bytes.length }, bytes: held.bytes });
  overlay.writes.set('written', { bytes: written.bytes, mtimeMs: 1 });
  for (const path of ['held', 'written']) {
    await assert.rejects(overlay.readBinary(path, { maxBytes: 1 }), (error) => error.code === 'EFBIG');
  }
  assert.equal(held.copies(), 0); assert.equal(written.copies(), 0);
});

test('Overlay hash pins recheck live base bytes under the requested bound', async () => {
  const base = new MemoryBackend(); await base.write('file', encoded('ok'));
  const overlay = new OverlayBackend(base, { pinMaxBytes: 0 });
  await overlay.stat('file');
  assert.ok(overlay.pins.get('file').hash);
  const observed = observedBytes('grown past the limit'); install(base, 'file', observed.bytes);
  await assert.rejects(overlay.readBinary('file', { maxBytes: 2 }), (error) => error.code === 'EFBIG');
  assert.equal(observed.copies(), 0);
});

test('unsupported storage refuses bounded reads before any metadata or data call', async () => {
  const counts = { stat: 0, read: 0 };
  const backend = {
    async stat() { counts.stat++; return { type: 'file', size: 1 }; },
    async readBinary() { counts.read++; return encoded('x'); },
  };
  assert.equal((await createFileops({ backend }).read('file', { maxBytes: 1 })).code, 'ENOTSUP');
  assert.deepEqual(counts, { stat: 0, read: 0 });
  const overlay = new OverlayBackend(backend);
  assert.equal((await createFileops({ backend: overlay }).read('file', { maxBytes: 1 })).code, 'ENOTSUP');
  await assert.rejects(overlay.readBinary('file', { maxBytes: 1 }), (error) => error.code === 'ENOTSUP');
  assert.deepEqual(counts, { stat: 0, read: 0 });
  assert.equal((await createFileops({ backend }).read('file')).ok, true);
  assert.ok(counts.stat > 0); assert.equal(counts.read, 1);
});

test('Crate metadata fallback cannot read whole content during a bounded request', async () => {
  const calls = [];
  const host = {
    async readBinary() { calls.push('read'); return encoded('contents'); },
    async exists() { calls.push('exists'); return true; },
    async list() { calls.push('list'); return []; },
    async write() {}, async delete() {},
  };
  const fs = createFileops({ backend: new CrateBackend(host) });
  assert.equal((await fs.read('file', { maxBytes: 1 })).code, 'ENOTSUP');
  assert.deepEqual(calls, []);
  assert.deepEqual((await fs.read('file')).data, encoded('contents'));
  assert.ok(calls.includes('read'));
});

test('fileops rejects oversized responses from a backend violating its capability', async () => {
  const backend = { supportsBoundedReads: true,
    async stat() { return { type: 'file', size: 1 }; },
    async readBinary() { return encoded('too large'); },
  };
  assert.equal((await createFileops({ backend }).read('file', { maxBytes: 1 })).code, 'EFBIG');
});

test('invalid bounds fail before storage access and decoding respects byte limits', async () => {
  const backend = new MemoryBackend(), fs = createFileops({ backend });
  await fs.write('utf8', 'é');
  const original = backend.stat.bind(backend); let stats = 0;
  backend.stat = (...args) => { stats++; return original(...args); };
  for (const maxBytes of [-1, 0.5, NaN, Infinity, '2']) assert.equal((await fs.read('utf8', { maxBytes })).code, 'EINVAL');
  assert.equal(stats, 0);
  assert.equal((await fs.read('utf8', { maxBytes: 1, encoding: 'utf-8' })).code, 'EFBIG');
  const result = await fs.read('utf8', { maxBytes: 2, encoding: 'utf-8' });
  assert.equal(result.data, 'é'); assert.equal(result.bytes, 2);
});

test('bounded reads retain symlink resolution and mount escape rejection', async () => {
  const backend = new MemoryBackend(), fs = createFileops({ backend, root: 'mnt' });
  await fs.write('dir/file', 'ok');
  backend.symlink('mnt/alias', 'dir'); backend.symlink('mnt/out', '../../outside');
  assert.deepEqual((await fs.read('alias/file', { maxBytes: 2 })).data, encoded('ok'));
  assert.equal((await fs.read('alias/file', { maxBytes: 1 })).code, 'EFBIG');
  assert.equal((await fs.read('out', { maxBytes: 2 })).code, 'EINVAL_PATH');
  assert.equal((await fs.read('missing', { maxBytes: 2 })).code, 'ENOENT');
  assert.equal((await fs.read('dir', { maxBytes: 2 })).code, 'EISDIR');
});

test('registry and I/O forward bounds while grant denial precedes storage access', async () => {
  const backend = new MemoryBackend(), fs = createFileops({ backend });
  await fs.write('allowed/file', 'ok'); await fs.write('private', 'private');
  const registry = buildRigRegistry({ fs });
  const face = createAgentFace({ registry, grant: createGrant({ prefixes: ['allowed'], scopes: ['fs:read'] }),
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }) });
  const io = createIO({ invoke: face.invoke, cwd: () => 'allowed' });
  assert.deepEqual(await io.readBytes('file', { maxBytes: 2 }), encoded('ok'));
  await assert.rejects(io.readBytes('file', { maxBytes: 1 }), (error) => error instanceof IOFailure && error.code === 'EFBIG');
  let accesses = 0; const original = backend.stat.bind(backend);
  backend.stat = (...args) => { accesses++; return original(...args); };
  await assert.rejects(io.readBytes('/private', { maxBytes: 2 }), (error) => error.code === 'EGRANT');
  assert.equal(accesses, 0);
  assert.equal((await registry.invokeCommand('fs.read', { path: 'allowed/file', maxBytes: '2' })).ok, false);
  assert.deepEqual(await io.readBytes('file'), encoded('ok'));
});
