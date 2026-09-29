// Independent B09 backend verifier. Native OS symlink behavior is outside this
// API-shaped suite; unknown Folder providers must refuse the strict contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createFileops } from '../fileops.mjs';
import { MemoryBackend } from '../memory-backend.mjs';
import { FsaBackend } from '../fsa-backend.mjs';
import { CrateBackend } from '../crate-backend.mjs';
import { OverlayBackend } from '../overlay-backend.mjs';
import { createOpfsBackend } from '../opfs.mjs';

const bytes = (text) => new TextEncoder().encode(text);
const removal = (expectedData) => ({ expectedData, kind: 'non-dir', follow: false, metadataOnly: true });
const mutate = (fs, operation, expectedData, path = 'allowed/file') => operation === 'write'
  ? fs.write(path, Uint8Array.of(255, 0, 128, 7), { expectedData })
  : fs.remove(path, removal(expectedData));

test('conditional Memory mutations replace and remove exact binary originals', async () => {
  const backend = new MemoryBackend(), fs = createFileops({ backend, root: 'mount' });
  const original = Uint8Array.of(0, 255, 128, 65), replacement = Uint8Array.of(128, 0, 255);
  await backend.write('mount/file', original);
  assert.equal((await fs.write('file', replacement, { expectedData: original })).ok, true);
  assert.deepEqual(await backend.readBinary('mount/file'), replacement);
  assert.equal((await fs.remove('file', removal(replacement))).ok, true);
  assert.equal(backend.files.has('mount/file'), false);
  assert.equal((await fs.write('empty', new Uint8Array(), { expectedData: null })).ok, true);
  assert.equal((await fs.remove('empty', removal(new Uint8Array()))).ok, true);
  assert.equal(backend.files.has('mount/empty'), false);
});

test('successful Memory writes own replacement Buffer bytes after the caller changes its buffer', async () => {
  for (const options of [{}, { rejectSymlinks: true }, { expectedData: bytes('old') }]) {
    const backend = new MemoryBackend(), fs = createFileops({ backend });
    await backend.write('file', bytes('old'));
    const replacement = Buffer.from([255, 0, 128, 7]), wanted = new Uint8Array(replacement);
    assert.equal((await fs.write('file', replacement, options)).ok, true);
    replacement.fill(33);
    assert.deepEqual(await backend.readBinary('file'), wanted);
  }
});

test('conditional absence rejects every existing final type without overwriting it', async () => {
  const backend = new MemoryBackend(), fs = createFileops({ backend });
  await backend.write('file', bytes('keep'));
  await backend.mkdir('dir');
  backend.symlink('link', 'file');
  for (const path of ['file', 'dir', 'link']) {
    assert.equal((await fs.write(path, bytes('replacement'), { expectedData: null })).code, 'ESTALE', path);
  }
  assert.deepEqual(await backend.readBinary('file'), bytes('keep'));
  assert.equal(backend.dirs.has('dir'), true);
  assert.equal(backend.symlinks.get('link').target, 'file');
});

for (const operation of ['write', 'delete']) {
  for (const change of ['same-size bytes', 'longer bytes', 'missing', 'directory', 'final link', 'ancestor link', 'ancestor file']) {
    test(`conditional ${operation} rejects ${change} inserted at backend entry`, async () => {
      const backend = new MemoryBackend(), fs = createFileops({ backend, root: 'mount' });
      await backend.mkdir('mount/allowed');
      await backend.write('mount/allowed/file', bytes('old'));
      await backend.write('outside/file', bytes('outside sentinel'));
      const method = operation === 'write' ? 'conditionalWrite' : 'conditionalDelete';
      const original = backend[method].bind(backend);
      const rawWrite = backend.write.bind(backend);
      let entered = 0;
      backend[method] = async (...args) => {
        entered++;
        if (change === 'same-size bytes') await rawWrite('mount/allowed/file', bytes('new'));
        if (change === 'longer bytes') await rawWrite('mount/allowed/file', bytes('newer'));
        if (change === 'missing') backend.files.delete('mount/allowed/file');
        if (change === 'directory') { backend.files.delete('mount/allowed/file'); backend.dirs.add('mount/allowed/file'); }
        if (change === 'final link') {
          backend.files.delete('mount/allowed/file'); backend.symlink('mount/allowed/file', '../../outside/file');
        }
        if (change === 'ancestor link') {
          backend.dirs.delete('mount/allowed'); backend.symlink('mount/allowed', '../../outside');
        }
        if (change === 'ancestor file') {
          backend.dirs.delete('mount/allowed'); await rawWrite('mount/allowed', bytes('replacement parent'));
        }
        return original(...args);
      };
      const result = await mutate(fs, operation, bytes('old'));
      assert.equal(entered, 1);
      assert.equal(result.code, change.startsWith('ancestor') ? 'ENOTDIR' : 'ESTALE');
      assert.deepEqual(await backend.readBinary('outside/file'), bytes('outside sentinel'));
      if (change.endsWith('bytes')) assert.deepEqual(await backend.readBinary('mount/allowed/file'), bytes(change === 'same-size bytes' ? 'new' : 'newer'));
      if (change === 'missing') assert.equal(backend.files.has('mount/allowed/file'), false);
      if (change === 'directory') assert.equal(backend.dirs.has('mount/allowed/file'), true);
      if (change === 'final link') assert.equal(backend.symlinks.get('mount/allowed/file').target, '../../outside/file');
      if (change.startsWith('ancestor')) assert.deepEqual(await backend.readBinary('mount/allowed/file'), bytes('old'));
    });
  }

  for (const inputType of ['Uint8Array', 'Buffer']) test(`conditional ${operation} snapshots caller ${inputType} comparison bytes before awaited metadata`, async () => {
    const backend = new MemoryBackend(), fs = createFileops({ backend });
    await backend.write('allowed/file', bytes('old'));
    // Use a nonzero-offset view to require preserving the supplied byte window.
    const holder = inputType === 'Buffer' ? Buffer.from('xoldx') : bytes('xoldx'), expected = holder.subarray(1, 4);
    const stat = backend.stat.bind(backend);
    let release, enter;
    const waiting = new Promise((resolve) => { enter = resolve; });
    const paused = new Promise((resolve) => { release = resolve; });
    let first = true;
    backend.stat = async (...args) => {
      if (first) { first = false; enter(); await paused; }
      return stat(...args);
    };
    const pending = mutate(fs, operation, expected);
    await waiting;
    expected.set(bytes('new'));
    await backend.write('allowed/file', bytes('new'));
    release();
    const result = await pending;
    assert.equal(result.code, 'ESTALE');
    assert.deepEqual(await backend.readBinary('allowed/file'), bytes('new'));
  });
}

test('conditional failure leaves missing ancestors absent even with createParents', async () => {
  const backend = new MemoryBackend(), fs = createFileops({ backend });
  const result = await fs.write('absent/child', bytes('replacement'), { expectedData: bytes('old'), createParents: true });
  assert.equal(result.code, 'ENOENT');
  assert.equal(backend.dirs.size, 0);
  assert.equal(backend.files.size, 0);
});

function accessSpy() {
  const calls = [];
  const host = { supportsMetadataOnly: true };
  for (const method of ['readBinary', 'write', 'delete', 'exists', 'list', 'stat', 'mkdir']) {
    host[method] = async (...args) => {
      calls.push({ method, args });
      return method === 'readBinary' ? bytes('old') : method === 'list' ? [] : method === 'exists' ? false : null;
    };
  }
  return { calls, host };
}

test('conditional capability refusal precedes metadata and effects on unknown, FSA, Crate, and Overlay adapters', async () => {
  for (const kind of ['unknown', 'FSA', 'Crate', 'Overlay']) {
    const { calls, host } = accessSpy();
    const backend = kind === 'FSA' ? new FsaBackend({ getDirectoryHandle: async () => null })
      : kind === 'Crate' ? new CrateBackend(host)
        : kind === 'Overlay' ? new OverlayBackend(new MemoryBackend()) : host;
    for (const method of ['readBinary', 'write', 'delete', 'exists', 'list', 'stat', 'mkdir']) backend[method] = host[method];
    const fs = createFileops({ backend });
    assert.equal((await fs.write('file', bytes('new'), { expectedData: bytes('old'), createParents: true })).code, 'ENOTSUP', kind);
    assert.equal((await fs.remove('file', removal(bytes('old')))).code, 'ENOTSUP', kind);
    assert.deepEqual(calls, [], `${kind} must refuse without touching the backend`);
  }
});

test('strict no-follow capability refusal precedes metadata and effects', async () => {
  for (const kind of ['unknown', 'FSA', 'Crate', 'Overlay-FSA']) {
    const { calls, host } = accessSpy();
    const folder = new FsaBackend({ getDirectoryHandle: async () => null });
    const backend = kind === 'FSA' ? folder : kind === 'Crate' ? new CrateBackend(host)
      : kind === 'Overlay-FSA' ? new OverlayBackend(folder) : host;
    for (const method of ['readBinary', 'write', 'delete', 'exists', 'list', 'stat', 'mkdir']) backend[method] = host[method];
    const fs = createFileops({ backend });
    assert.equal((await fs.write('file', bytes('new'), { rejectSymlinks: true, createParents: true })).code, 'ENOTSUP', kind);
    assert.equal((await fs.mkdir('dir', { rejectSymlinks: true, createParents: true })).code, 'ENOTSUP', kind);
    assert.deepEqual(calls, [], `${kind} must refuse without touching the backend`);
  }
});

for (const operation of ['write', 'mkdir']) {
  for (const change of ['ancestor link', 'ancestor file', 'final link', 'final conflicting type']) {
    test(`strict Memory ${operation} rejects ${change} inserted at backend entry`, async () => {
      const backend = new MemoryBackend(), fs = createFileops({ backend, root: 'mount' });
      await backend.mkdir('mount/allowed');
      await backend.write('outside/file', bytes('outside sentinel'));
      const original = backend[operation].bind(backend), rawWrite = backend.write.bind(backend);
      let entered = 0;
      backend[operation] = async (...args) => {
        entered++;
        if (change === 'ancestor link') {
          backend.dirs.delete('mount/allowed'); backend.symlink('mount/allowed', '../../outside');
        }
        if (change === 'ancestor file') {
          backend.dirs.delete('mount/allowed'); await rawWrite('mount/allowed', bytes('new parent'));
        }
        if (change === 'final link') backend.symlink('mount/allowed/file', '../../outside/file');
        if (change === 'final conflicting type') {
          if (operation === 'write') backend.dirs.add('mount/allowed/file');
          else await rawWrite('mount/allowed/file', bytes('new file'));
        }
        return original(...args);
      };
      const result = operation === 'write'
        ? await fs.write('allowed/file', bytes('new'), { rejectSymlinks: true })
        : await fs.mkdir('allowed/file', { rejectSymlinks: true });
      assert.equal(entered, 1);
      assert.equal(result.ok, false, 'the final backend check must reject a changed path');
      assert.deepEqual(await backend.readBinary('outside/file'), bytes('outside sentinel'));
      if (change.startsWith('ancestor') || change === 'final link') assert.equal(backend.files.has('mount/allowed/file'), false);
      if (change === 'final link') assert.equal(backend.symlinks.has('mount/allowed/file'), true);
      if (change === 'final conflicting type' && operation === 'write') assert.equal(backend.dirs.has('mount/allowed/file'), true);
      if (change === 'final conflicting type' && operation === 'mkdir') assert.deepEqual(await backend.readBinary('mount/allowed/file'), bytes('new file'));
    });
  }
}

// This models the browser API shape only. The factory call establishes which
// provenance flag the application supplies; it does not prove native OS rules.
class FileHandle {
  constructor() { this.kind = 'file'; this.bytes = new Uint8Array(); }
  async getFile() {
    const copy = this.bytes.slice();
    return { size: copy.length, lastModified: 1, async arrayBuffer() { return copy.buffer; } };
  }
  async createWritable() {
    let staged;
    return { write: async (data) => { staged = data.slice(); }, close: async () => { this.bytes = staged; } };
  }
}
class DirectoryHandle {
  constructor() { this.kind = 'directory'; this.entriesByName = new Map(); }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.entriesByName.has(name) && create) this.entriesByName.set(name, new DirectoryHandle());
    const value = this.entriesByName.get(name);
    if (!value) throw new DOMException('missing', 'NotFoundError');
    if (value.kind !== 'directory') throw new DOMException('not a directory', 'TypeMismatchError');
    return value;
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.entriesByName.has(name) && create) this.entriesByName.set(name, new FileHandle());
    const value = this.entriesByName.get(name);
    if (!value) throw new DOMException('missing', 'NotFoundError');
    if (value.kind !== 'file') throw new DOMException('not a file', 'TypeMismatchError');
    return value;
  }
  async *entries() { yield* this.entriesByName; }
}

test('OPFS factory supplies no-follow provenance while ordinary Folder handles refuse it', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), root = new DirectoryHandle();
  let rootRequests = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: {
    async getDirectory() { rootRequests++; return root; },
  } } });
  try {
    const folder = new FsaBackend(root);
    assert.equal(folder.supportsNoFollowMutation, false);
    assert.equal((await createFileops({ backend: folder }).write('denied', bytes('new'), { rejectSymlinks: true })).code, 'ENOTSUP');
    assert.equal(root.entriesByName.has('denied'), false);
    const backend = await createOpfsBackend({ path: 'review/workspace' });
    assert.equal(rootRequests, 1);
    assert.equal(backend.supportsNoFollowMutation, true);
    const fs = createFileops({ backend });
    assert.equal((await fs.mkdir('out', { rejectSymlinks: true })).ok, true);
    assert.equal((await fs.write('out/file', Uint8Array.of(255, 0, 128), { rejectSymlinks: true })).ok, true);
    assert.deepEqual(await backend.readBinary('out/file'), Uint8Array.of(255, 0, 128));
    const sameWorkspace = await createOpfsBackend({ path: 'review/workspace' });
    assert.deepEqual(await sameWorkspace.readBinary('out/file'), Uint8Array.of(255, 0, 128));
    assert.equal((await fs.write('out/file', bytes('new'), { expectedData: Uint8Array.of(255, 0, 128) })).code, 'ENOTSUP');
    assert.equal((await fs.remove('out/file', removal(Uint8Array.of(255, 0, 128)))).code, 'ENOTSUP');
    assert.equal(new OverlayBackend(backend).supportsNoFollowMutation, true);
    assert.equal(new OverlayBackend(folder).supportsNoFollowMutation, false);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
});
