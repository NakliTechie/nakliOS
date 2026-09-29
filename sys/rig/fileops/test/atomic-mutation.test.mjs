import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend } from '../memory-backend.mjs';
import { FsaBackend } from '../fsa-backend.mjs';
import { OverlayBackend } from '../overlay-backend.mjs';
import { CrateBackend } from '../crate-backend.mjs';
import { createFileops } from '../fileops.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';
import { createExecution } from '../../cli/execution.mjs';
import { createIO } from '../../cli/io.mjs';

const bytes = (text) => new TextEncoder().encode(text);
const typed = (kind) => ({ kind, follow: false, metadataOnly: true });
const make = () => { const backend = new MemoryBackend(); return { backend, fs: createFileops({ backend }) }; };

test('exclusive creation preserves every existing object and refuses absent parents', async () => {
  const { backend, fs } = make();
  await backend.write('file', bytes('sentinel')); await backend.mkdir('dir');
  await backend.write('implicit/child', bytes('child')); backend.symlink('link', 'file');
  for (const path of ['file', 'dir', 'implicit', 'link', '']) {
    for (const directory of [false, true]) assert.equal((await fs.create(path, { directory })).code, 'EEXIST');
  }
  assert.equal((await fs.create('missing/child')).code, 'ENOENT');
  assert.deepEqual(await backend.readBinary('file'), bytes('sentinel'));
  assert.equal(backend.symlinks.get('link').target, 'file');
  assert.equal((await fs.create('empty')).ok, true);
  assert.equal((await fs.create('newdir', { directory: true })).ok, true);
  assert.equal((await backend.stat('empty')).size, 0); assert.equal((await backend.stat('newdir')).type, 'dir');
});

test('exclusive creation observes a competitor inserted after resolver preflight', async () => {
  const { backend, fs } = make(), original = backend.createExclusive.bind(backend);
  backend.createExclusive = async (path, options) => { await backend.write(path, bytes('raced sentinel')); return original(path, options); };
  assert.equal((await fs.create('candidate')).code, 'EEXIST');
  assert.deepEqual(await backend.readBinary('candidate'), bytes('raced sentinel'));
});

test('atomic typed removal rechecks replacement type and directory emptiness', async () => {
  const { backend, fs } = make(), original = backend.delete.bind(backend);
  await backend.write('file', bytes('old')); await backend.mkdir('dir'); await backend.mkdir('empty');
  backend.delete = async (path, options) => {
    if (path === 'file') { backend.files.delete(path); await backend.mkdir(path); }
    if (path === 'dir') { backend.dirs.delete(path); await backend.write(path, bytes('keep')); }
    if (path === 'empty') await backend.write('empty/arrived', bytes('keep child'));
    return original(path, options);
  };
  assert.equal((await fs.remove('file', typed('non-dir'))).code, 'EISDIR');
  assert.equal((await fs.remove('dir', typed('dir'))).code, 'ENOTDIR');
  assert.equal((await fs.remove('empty', typed('dir'))).code, 'ENOTEMPTY');
  assert.equal(backend.dirs.has('file'), true); assert.deepEqual(await backend.readBinary('dir'), bytes('keep'));
  assert.deepEqual(await backend.readBinary('empty/arrived'), bytes('keep child'));
});

test('mutation paths refuse symlink traversal while unlink retains final-link semantics', async () => {
  const { backend, fs } = make(); await backend.write('private/file', bytes('keep'));
  backend.symlink('alias', 'private'); backend.symlink('link', 'private/file');
  assert.equal((await fs.create('alias/new')).code, 'ENOTSUP');
  assert.equal((await fs.truncate('alias/file', { size: 0 })).code, 'ENOTSUP');
  assert.equal((await fs.truncate('link', { size: 0 })).code, 'ENOTSUP');
  assert.equal((await fs.remove('alias/file', typed('non-dir'))).code, 'ENOTSUP');
  assert.equal((await fs.remove('link', typed('non-dir'))).ok, true);
  assert.deepEqual(await backend.readBinary('private/file'), bytes('keep')); assert.equal(backend.symlinks.has('link'), false);
});

test('mutation ancestor checks reject raced links before touching their targets', async () => {
  for (const operation of ['create', 'truncate', 'remove']) {
    const { backend, fs } = make(); await backend.mkdir('parent'); await backend.write('parent/file', bytes('keep'));
    await backend.write('private/file', bytes('secret'));
    const method = operation === 'create' ? 'createExclusive' : operation === 'remove' ? 'delete' : 'truncate';
    const original = backend[method].bind(backend);
    backend[method] = async (...args) => {
      backend.dirs.delete('parent'); backend.symlink('parent', 'private'); return original(...args);
    };
    const result = operation === 'create' ? await fs.create('parent/new')
      : operation === 'truncate' ? await fs.truncate('parent/file', { size: 0 }) : await fs.remove('parent/file', typed('non-dir'));
    assert.equal(result.code, 'ENOTDIR'); assert.deepEqual(await backend.readBinary('private/file'), bytes('secret'));
    assert.deepEqual(await backend.readBinary('parent/file'), bytes('keep'));
  }
});

test('Memory truncation preserves arbitrary bytes and implements exact size modes', async () => {
  const { backend, fs } = make(); await backend.write('file', Uint8Array.of(255, 0, 128, 65));
  assert.equal((await fs.truncate('file', { size: 2 })).size, 2);
  assert.deepEqual(await backend.readBinary('file'), Uint8Array.of(255, 0));
  assert.equal((await fs.truncate('file', { size: 3, mode: 'add' })).size, 5);
  assert.deepEqual(await backend.readBinary('file'), Uint8Array.of(255, 0, 0, 0, 0));
  for (const [mode, size, expected] of [['subtract', 2, 3], ['max', 7, 7], ['min', 6, 6], ['roundDown', 4, 4], ['roundUp', 3, 6], ['subtract', 99, 0]]) {
    assert.equal((await fs.truncate('file', { size, mode })).size, expected);
  }
  assert.deepEqual(await fs.truncate('absent', { size: 5, create: false }), { ok: true, path: 'absent', changed: false, size: null });
  assert.equal(backend.files.has('absent'), false);
});

test('truncation bounds and invalid options preserve the existing authoritative bytes', async () => {
  const { backend, fs } = make(); await backend.write('file', bytes('sentinel'));
  for (const options of [{ size: 9, maxBytes: 8 }, { size: Number.MAX_SAFE_INTEGER, mode: 'add', maxBytes: 8 }]) {
    assert.equal((await fs.truncate('file', options)).code, 'EFBIG');
    assert.deepEqual(await backend.readBinary('file'), bytes('sentinel'));
  }
  for (const options of [{ size: -1 }, { size: 0, mode: 'roundUp' }, { size: 1, create: 'yes' }, { size: 1, maxBytes: -1 }]) {
    assert.equal((await fs.truncate('file', options)).code, 'EINVAL');
  }
  assert.deepEqual(await backend.readBinary('file'), bytes('sentinel'));
});

test('relative Memory truncation uses the entry present at mutation time', async () => {
  const { backend, fs } = make(); await backend.write('file', bytes('old'));
  const original = backend.truncate.bind(backend);
  backend.truncate = async (path, options) => { await backend.write(path, bytes('newer')); return original(path, options); };
  assert.equal((await fs.truncate('file', { size: 2, mode: 'add' })).size, 7);
  assert.deepEqual(await backend.readBinary('file'), Uint8Array.of(...bytes('newer'), 0, 0));
});

test('unsupported mutation capabilities refuse before metadata or whole-content fallback', async () => {
  let calls = 0;
  const unknown = { async stat() { calls++; }, async readBinary() { calls++; return bytes('secret'); },
    async write() { calls++; }, async delete() { calls++; }, async exists() { calls++; return true; }, async list() { calls++; return []; } };
  for (const backend of [unknown, new CrateBackend(unknown), new OverlayBackend(new MemoryBackend())]) {
    const fs = createFileops({ backend });
    assert.equal((await fs.create('file')).code, 'ENOTSUP');
    assert.equal((await fs.truncate('file', { size: 1 })).code, 'ENOTSUP');
    assert.equal((await fs.remove('file', typed('non-dir'))).code, 'ENOTSUP');
  }
  assert.equal(calls, 0);
});

test('logical mount roots permit direct children but reject nested missing parents', async () => {
  const backend = new MemoryBackend(), fs = createFileops({ backend, root: 'mount/root' });
  assert.equal((await fs.create('child')).ok, true);
  assert.equal((await fs.truncate('second', { size: 2 })).ok, true);
  assert.equal((await fs.create('absent/child')).code, 'ENOENT');
  assert.equal((await fs.remove('', typed('dir'))).code, 'EBUSY');
  assert.equal(backend.files.has('mount/root/child'), true);
});

test('governed mutation I/O preserves grants and rechecks staged replacement objects', async () => {
  const { backend, fs } = make(); await backend.write('allowed/file', bytes('old'));
  const registry = buildRigRegistry({ fs });
  const face = createAgentFace({ registry, grant: createGrant({ prefixes: ['allowed'], scopes: ['fs:read', 'fs:write', 'fs:remove'] }),
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }) });
  const execution = createExecution({ face }), io = createIO({ invoke: (name, input) => execution.invoke(name, input), cwd: () => 'allowed' });
  assert.equal((await io.create('new')).ok, true); assert.equal((await io.truncate('new', { size: 3, maxBytes: 3 })).size, 3);
  const pending = io.remove('file', typed('non-dir')); assert.ok((await execution.next()).awaitingConfirm);
  backend.files.delete('allowed/file'); await backend.mkdir('allowed/file'); execution.answer(true);
  await assert.rejects(pending, (error) => error.code === 'EISDIR'); assert.equal(backend.dirs.has('allowed/file'), true);
  for (const call of [() => io.create('/private'), () => io.truncate('/private', { size: 0 }), () => io.remove('/private', typed('non-dir'))]) {
    await assert.rejects(call(), (error) => error.code === 'EGRANT');
  }
});

// Provider mock: writes stay private until close, matching the FSA transaction.
function provider(initial = Uint8Array.of(255, 0, 128, 65)) {
  let current = initial.slice(), aborts = 0, writes = 0, reads = 0, closes = 0;
  const options = [], slices = [], handles = new Map();
  const file = { kind: 'file', async getFile() {
    const snapshot = current.slice();
    return { size: snapshot.length, lastModified: 1,
      async arrayBuffer() { throw new Error('whole file must not be read'); },
      slice(start, end) { slices.push([start, end]); return { size: end - start, async arrayBuffer() { reads++; return snapshot.slice(start, end).buffer; } }; } };
  }, async createWritable(opts) {
    options.push(opts); let staged = new Uint8Array(0);
    return { async write(value) { writes++; if (file.fail === 'write') throw new DOMException('denied', 'NotAllowedError'); staged = value.slice(); },
      async truncate(size) { if (file.fail === 'truncate') throw new DOMException('denied', 'NotAllowedError'); const next = new Uint8Array(size); next.set(staged.subarray(0, size)); staged = next; },
      async close() { if (file.fail === 'close') throw new DOMException('denied', 'NotAllowedError'); closes++; current = staged; },
      async abort() { aborts++; } };
  } };
  handles.set('file', file);
  const root = { async getFileHandle(name, opts) { assert.equal(opts?.create, false); const value = handles.get(name);
    if (!value) throw new DOMException('missing', 'NotFoundError');
    if (value.kind !== 'file') throw new DOMException('directory', 'TypeMismatchError'); return value; },
    async getDirectoryHandle(name, opts) { assert.equal(opts?.create, false); const value = handles.get(name);
      if (!value) throw new DOMException('missing', 'NotFoundError');
      if (value.kind !== 'directory') throw new DOMException('file', 'TypeMismatchError'); return value; },
    async removeEntry() { throw new Error('name-based fallback is forbidden'); } };
  return { root, file, handles, options, slices, data: () => current, counts: () => ({ aborts, writes, reads, closes }) };
}

test('FSA absolute truncation uses a bounded immutable slice and one committed transaction', async () => {
  const p = provider(), fs = createFileops({ backend: new FsaBackend(p.root) });
  assert.equal((await fs.truncate('file', { size: 2, maxBytes: 2 })).ok, true);
  assert.deepEqual(p.data(), Uint8Array.of(255, 0)); assert.deepEqual(p.slices, [[0, 2]]);
  assert.deepEqual(p.options, [{ keepExistingData: false }]);
  assert.equal((await fs.truncate('file', { size: 5, maxBytes: 5 })).ok, true);
  assert.deepEqual(p.data(), Uint8Array.of(255, 0, 0, 0, 0)); assert.equal(p.counts().closes, 2);
});

test('FSA transaction failures abort without changing existing bytes', async () => {
  for (const failure of ['write', 'truncate', 'close']) {
    const p = provider(); p.file.fail = failure;
    const fs = createFileops({ backend: new FsaBackend(p.root) });
    assert.equal((await fs.truncate('file', { size: 2 })).code, 'EACCES');
    assert.deepEqual(p.data(), Uint8Array.of(255, 0, 128, 65)); assert.equal(p.counts().aborts, 1);
  }
});

test('FSA refusals avoid content allocation and creation effects', async () => {
  const p = provider(), backend = new FsaBackend(p.root), fs = createFileops({ backend });
  assert.equal((await fs.create('new')).code, 'ENOTSUP');
  assert.equal((await fs.truncate('file', { size: 1, mode: 'add' })).code, 'ENOTSUP');
  assert.equal((await fs.truncate('file', { size: 5, maxBytes: 4 })).code, 'EFBIG');
  assert.equal((await fs.truncate('new', { size: 1 })).code, 'ENOTSUP');
  assert.equal((await fs.truncate('new', { size: 1, create: false })).changed, false);
  assert.equal((await fs.remove('file', typed('non-dir'))).code, 'ENOTSUP');
  assert.deepEqual(p.counts(), { aborts: 0, writes: 0, reads: 0, closes: 0 }); assert.equal(p.handles.has('new'), false);
});

test('FSA bounds the fresh snapshot slice even when earlier metadata changes', async () => {
  const p = provider(), backend = new FsaBackend(p.root); let snapshots = 0, allocated = 0;
  p.file.getFile = async () => {
    snapshots++; return { size: snapshots === 1 ? 1 : 1024 ** 4, lastModified: 1,
      slice(start, end) { assert.equal(start, 0); assert.equal(end, 2); return { size: 2, async arrayBuffer() { allocated += 2; return Uint8Array.of(7, 8).buffer; } }; },
      async arrayBuffer() { throw new Error('unbounded allocation'); } };
  };
  assert.equal((await createFileops({ backend }).truncate('file', { size: 2, maxBytes: 2 })).ok, true);
  assert.equal(allocated, 2); assert.deepEqual(p.data(), Uint8Array.of(7, 8));
});

test('FSA typed removal refuses before metadata even when handle.remove exists', async () => {
  const p = provider(); let accessed = 0;
  p.file.remove = async () => { accessed++; };
  p.root.getFileHandle = async () => { accessed++; return p.file; };
  p.root.getDirectoryHandle = async () => { accessed++; return p.root; };
  const fs = createFileops({ backend: new FsaBackend(p.root) });
  assert.equal((await fs.remove('file', typed('non-dir'))).code, 'ENOTSUP');
  assert.equal((await fs.remove('dir', typed('dir'))).code, 'ENOTSUP');
  assert.equal(accessed, 0); assert.deepEqual(p.data(), Uint8Array.of(255, 0, 128, 65));
});

test('rejectSymlinks refuses changed canonical paths while retaining final-link metadata', async () => {
  const { backend, fs } = make(); await backend.write('protected/file', bytes('secret')); await backend.mkdir('allowed');
  assert.equal((await fs.stat('allowed', { metadataOnly: true })).stat.type, 'dir');
  backend.dirs.delete('allowed'); backend.symlink('allowed', 'protected');
  let protectedReads = 0; const original = backend.readBinary.bind(backend);
  backend.readBinary = (...args) => { protectedReads++; return original(...args); };
  assert.equal((await fs.read('allowed/file', { maxBytes: 8, rejectSymlinks: true })).code, 'ENOTSUP');
  assert.equal((await fs.list('allowed', { metadataOnly: true, rejectSymlinks: true })).code, 'ENOTSUP');
  assert.equal((await fs.stat('allowed/file', { metadataOnly: true, follow: false, rejectSymlinks: true })).code, 'ENOTSUP');
  assert.deepEqual((await fs.stat('allowed', { metadataOnly: true, follow: false, rejectSymlinks: true })).stat,
    { type: 'symlink', size: 0, mtimeMs: backend.symlinks.get('allowed').mtimeMs, target: 'protected' });
  assert.equal(protectedReads, 0);
  assert.deepEqual((await fs.read('allowed/file')).data, bytes('secret'));
});

test('rejectSymlinks flags validate and recursive listing refuses before metadata', async () => {
  let metadata = 0;
  const fs = createFileops({ backend: { supportsMetadataOnly: true, async stat() { metadata++; return { type: 'dir' }; } } });
  for (const method of ['read', 'stat', 'list']) assert.equal((await fs[method]('path', { rejectSymlinks: 'yes' })).code, 'EINVAL');
  assert.equal((await fs.list('path', { rejectSymlinks: true, recursive: true })).code, 'ENOTSUP');
  assert.equal(metadata, 0);
});

test('governed I/O forwards rejectSymlinks without changing default calls', async () => {
  const calls = [], io = createIO({ cwd: () => 'allowed', invoke: async (name, input) => {
    calls.push([name, input]); return { ok: true, data: new Uint8Array(0), stat: { type: 'file', size: 0 }, entries: [] };
  } });
  await io.readBytes('file', { maxBytes: 0, rejectSymlinks: true });
  await io.stat('link', { follow: false, metadataOnly: true, rejectSymlinks: true });
  await io.list('.', { metadataOnly: true, rejectSymlinks: true });
  for (const [, input] of calls) assert.equal(input.rejectSymlinks, true);
  assert.equal(calls[0][1].maxBytes, 0); assert.equal(calls[1][1].follow, false);
  calls.length = 0; await io.readBytes('file'); await io.stat('file'); await io.list('.');
  for (const [, input] of calls) assert.equal(Object.hasOwn(input, 'rejectSymlinks'), false);
  const { fs } = make(), registry = buildRigRegistry({ fs });
  for (const name of ['fs.read', 'fs.stat', 'fs.list']) assert.equal((await registry.invokeCommand(name, { path: 'file', rejectSymlinks: 'yes' })).ok, false);
});
