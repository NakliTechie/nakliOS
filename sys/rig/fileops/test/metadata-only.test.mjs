import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend } from '../memory-backend.mjs';
import { FsaBackend } from '../fsa-backend.mjs';
import { CrateBackend } from '../crate-backend.mjs';
import { OverlayBackend } from '../overlay-backend.mjs';
import { createFileops } from '../fileops.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';
import { createIO } from '../../cli/io.mjs';
import { createExecution } from '../../cli/execution.mjs';
import { createShell } from '../../cli/shell.mjs';

const bytes = (value) => new TextEncoder().encode(value);
const options = { metadataOnly: true };
test('bounded FSA listing stops enumeration and unsupported backends refuse', async () => {
  let yielded=0;
  const root={getDirectoryHandle:async()=>root,
    async *entries(){for(let i=0;i<100;i++){yielded++; yield ['file-'+i,{kind:'file'}];}}};
  const fs=createFileops({backend:new FsaBackend(root)});
  const listed=await fs.list('',{maxEntries:50});
  assert.equal(listed.ok,true);
  assert.equal(listed.entries.length,50);
  assert.equal(listed.truncated,true);
  assert.equal(listed.snapshotConsistent,false,'bounded FSA pages disclose live-directory semantics');
  assert.equal(yielded,50,'the provider iterator stops at the page bound');
  assert(listed.cursor,'the next page is reachable through an opaque cursor');
  const next=await fs.list('',{maxEntries:50,cursor:listed.cursor});
  assert.equal(next.entries.length,50);
  assert.notEqual(next.cursor,listed.cursor,'each page consumes and replaces the cursor');
  assert.equal((await fs.list('',{maxEntries:50,cursor:listed.cursor})).code,'EINVAL',
    'an old cursor cannot be replayed');
  assert.equal(yielded,100,'the second page resumes the same iterator');
  const end=await fs.list('',{maxEntries:50,cursor:next.cursor});
  assert.equal(end.entries.length,0);
  assert.equal(end.truncated,false);
  assert.equal(end.cursor,null);
  assert.equal(end.snapshotConsistent,false,'a final page does not certify a coherent snapshot');
  assert.equal(new Set([...listed.entries,...next.entries].map(e=>e.path)).size,100,
    'continuation reaches every entry without duplicates');
  const legacy=new MemoryBackend();legacy.supportsBoundedListing=false;
  const unsupported=await createFileops({backend:legacy}).list('',{maxEntries:50});
  assert.equal(unsupported.code,'ENOTSUP');
});

test('bounded FSA listing reports a provider refusal instead of an empty project', async () => {
  const root={async getDirectoryHandle(){throw providerError('NotAllowedError');},
    async getFileHandle(){throw providerError('NotFoundError');},async *entries(){}};
  const fs=createFileops({backend:new FsaBackend(root)});
  const result=await fs.list('private',{maxEntries:50});
  assert.equal(result.ok,false);
  assert.equal(result.code,'EACCES');
});

test('bounded FSA listing reports an iterator failure instead of a partial page', async () => {
  const root={async getDirectoryHandle(){return root;},
    async *entries(){yield ['visible',{kind:'file'}];throw providerError('NotReadableError');}};
  const fs=createFileops({backend:new FsaBackend(root)});
  const result=await fs.list('',{maxEntries:50});
  assert.equal(result.ok,false);
  assert.equal(result.code,'EIO');
});
function countContent(backend) {
  const original = backend.readBinary.bind(backend); let count = 0;
  backend.readBinary = (...args) => { count++; return original(...args); };
  return () => count;
}

test('Memory metadata-only operations inspect and remove without reading content', async () => {
  const backend = new MemoryBackend(), fs = createFileops({ backend });
  await backend.write('dir/file', bytes('contents'));
  const reads = countContent(backend), seen = [];
  const original = backend.stat.bind(backend);
  backend.stat = (path, opts) => { seen.push(opts); return original(path, opts); };
  assert.equal((await fs.stat('dir/file', options)).stat.size, 8);
  assert.deepEqual((await fs.list('dir', options)).entries.map((entry) => entry.name), ['file']);
  assert.equal((await fs.remove('dir/file', options)).ok, true);
  assert.ok(seen.length > 0); assert.ok(seen.every((opts) => opts?.metadataOnly === true));
  assert.equal(reads(), 0);
});

test('FSA metadata-only stat never calls the File snapshot arrayBuffer', async () => {
  let allocations = 0, snapshots = 0;
  const root = {
    async getDirectoryHandle() { throw new Error('not a directory'); },
    async getFileHandle(name) {
      assert.equal(name, 'file');
      return { async getFile() {
        snapshots++;
        return { size: 1024 ** 4, lastModified: 123,
          async arrayBuffer() { allocations++; throw new Error('content must not be read'); } };
      } };
    },
  };
  const fs = createFileops({ backend: new FsaBackend(root) });
  assert.deepEqual((await fs.stat('file', options)).stat, { type: 'file', size: 1024 ** 4, mtimeMs: 123 });
  assert.equal(snapshots, 2); assert.equal(allocations, 0);
});

test('metadata-only stat preserves absent fields without synthesizing zero metadata', async () => {
  const backend = { supportsMetadataOnly: true, async stat() { return { type: 'file' }; } };
  const fs = createFileops({ backend });
  assert.deepEqual((await fs.stat('file', options)).stat, { type: 'file' });
  assert.deepEqual((await fs.stat('file')).stat, { type: 'file', size: 0, mtimeMs: 0 });
});

test('nested Overlay metadata traversal forwards options without content pins', async () => {
  const base = new MemoryBackend(); await base.write('dir/file', bytes('contents'));
  const reads = countContent(base), seen = [], original = base.stat.bind(base);
  base.stat = (path, opts) => { seen.push(opts); return original(path, opts); };
  const first = new OverlayBackend(base), second = new OverlayBackend(first);
  const fs = createFileops({ backend: second });
  assert.equal((await fs.stat('dir/file', options)).stat.size, 8);
  assert.equal((await fs.list('dir', options)).entries[0].path, 'dir/file');
  assert.equal(reads(), 0); assert.equal(first.pins.size, 0); assert.equal(second.pins.size, 0);
  assert.equal(first.pinHeldBytes, 0); assert.equal(second.pinHeldBytes, 0);
  assert.ok(seen.every((opts) => opts?.metadataOnly === true));
});

test('metadata-only stat preserves existing Overlay held and hash pins', async () => {
  for (const pinMaxBytes of [0, 1024]) {
    const base = new MemoryBackend(); await base.write('file', bytes('contents'));
    const overlay = new OverlayBackend(base, { pinMaxBytes });
    await overlay.stat('file');
    const pin = overlay.pins.get('file'), reads = countContent(base);
    assert.equal((await overlay.stat('file', options)).size, 8);
    assert.equal(overlay.pins.get('file'), pin); assert.equal(reads(), 0);
  }
});

test('failed ordinary Overlay listings do not poison later metadata-only snapshots', async () => {
  const base = new MemoryBackend(); await base.write('file', bytes('contents'));
  const original = base.list.bind(base); let calls = 0;
  base.list = (...args) => {
    calls++;
    if (calls <= 2) throw Object.assign(new Error('listing failed'), { code: 'EIO' });
    return original(...args);
  };
  const overlay = new OverlayBackend(base);
  assert.deepEqual(await overlay.list(''), []);
  assert.equal(overlay.lists.has(''), false);
  await assert.rejects(overlay.list('', options), (error) => error.code === 'EIO');
  assert.equal(overlay.lists.has(''), false);
  assert.deepEqual(await overlay.list('', options), ['file']);
  await base.write('later', bytes('new'));
  assert.deepEqual(await overlay.list('', options), ['file']);
  assert.equal(calls, 3);
});

test('unknown backends reject metadata requests before stat, list, or deletion', async () => {
  const calls = [];
  const backend = {
    async stat() { calls.push('stat'); return { type: 'file', size: 1 }; },
    async readBinary() { calls.push('read'); return bytes('x'); },
    async list() { calls.push('list'); return []; },
    async delete() { calls.push('delete'); },
  };
  for (const candidate of [backend, new OverlayBackend(backend)]) {
    const fs = createFileops({ backend: candidate });
    for (const method of ['stat', 'list', 'remove']) {
      assert.equal((await fs[method]('dir/file', options)).code, 'ENOTSUP');
    }
  }
  assert.deepEqual(calls, []);
  assert.equal((await createFileops({ backend }).stat('file')).ok, true);
  assert.ok(calls.includes('stat'));
});

test('Crate content-based stat fallback cannot run for metadata-only requests', async () => {
  const calls = [];
  const host = {
    async readBinary() { calls.push('read'); return bytes('contents'); },
    async exists() { calls.push('exists'); return true; },
    async list() { calls.push('list'); return ['file']; },
    async write() {}, async delete() { calls.push('delete'); },
  };
  const fs = createFileops({ backend: new CrateBackend(host) });
  assert.deepEqual((await fs.stat('file', options)).stat, { type: 'file' });
  assert.equal((await fs.list('file', options)).code, 'ENOTDIR');
  assert.equal((await fs.remove('file', options)).ok, true);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call === 'list' || call === 'delete'));
  assert.equal(calls.includes('read'), false);
  assert.equal(calls.includes('exists'), false);
  assert.equal((await fs.stat('file')).stat.size, 8);
  assert.ok(calls.includes('read'));
});

test('metadata-only recursive combinations refuse before any storage traversal', async () => {
  let accesses = 0;
  const backend = { supportsMetadataOnly: true, async stat() { accesses++; }, async list() { accesses++; } };
  const fs = createFileops({ backend });
  for (const method of ['list', 'remove']) {
    assert.equal((await fs[method]('dir', { metadataOnly: true, recursive: true })).code, 'ENOTSUP');
  }
  for (const method of ['stat', 'list', 'remove']) {
    assert.equal((await fs[method]('dir', { metadataOnly: 'true' })).code, 'EINVAL');
  }
  assert.equal(accesses, 0);
});

test('Overlay metadata-only deletion refuses an unpinned file without weakening its fence', async () => {
  const base = new MemoryBackend(); await base.write('file', bytes('contents'));
  const reads = countContent(base), overlay = new OverlayBackend(base), fs = createFileops({ backend: overlay });
  assert.equal((await fs.stat('file', options)).stat.type, 'file');
  const result = await fs.remove('file', options);
  assert.equal(result.code, 'ENOTSUP'); assert.match(result.message, /existing content pin/);
  assert.equal(reads(), 0); assert.equal(overlay.pins.size, 0);
  assert.equal(overlay.tomb.has('file'), false); assert.equal(base.files.has('file'), true);
});

test('Overlay metadata-only deletion uses completed held or hash pins without another content read', async () => {
  for (const pinMaxBytes of [0, 1024]) {
    const base = new MemoryBackend(); await base.write('file', bytes('contents'));
    const overlay = new OverlayBackend(base, { pinMaxBytes }), fs = createFileops({ backend: overlay });
    await overlay.stat('file');
    const reads = countContent(base), pin = overlay.pins.get('file');
    assert.equal((await fs.remove('file', options)).ok, true);
    assert.equal(reads(), 0); assert.equal(overlay.pins.get('file'), pin);
    assert.equal(overlay.tomb.has('file'), true); assert.equal(base.files.has('file'), true);
    await base.write('file', bytes('changed!'));
    assert.deepEqual((await overlay.moved()).wrote, ['file']);
  }
});

test('metadata-only final-link deletion resolves ancestors without reading target contents', async () => {
  const base = new MemoryBackend(); await base.write('mnt/real/target', bytes('keep'));
  base.symlink('mnt/ancestor', 'real'); base.symlink('mnt/real/link', 'target');
  const reads = countContent(base), overlay = new OverlayBackend(base);
  const fs = createFileops({ backend: overlay, root: 'mnt' });
  assert.equal((await fs.stat('ancestor/link', { ...options, follow: false })).stat.type, 'symlink');
  assert.equal((await fs.remove('ancestor/link', { ...options, follow: false })).ok, true);
  assert.equal(reads(), 0); assert.equal(overlay.tomb.has('mnt/real/link'), true);
  assert.equal(overlay.pins.has('mnt/real/target'), false);
  assert.deepEqual(base.files.get('mnt/real/target').bytes, bytes('keep'));
  base.symlink('mnt/out', '../../outside');
  assert.equal((await fs.stat('out/file', options)).code, 'EINVAL_PATH');
});

test('metadata-only listing handles a directory replaced by a file without content pinning', async () => {
  const base = new MemoryBackend(); await base.write('dir/child', bytes('original'));
  const reads = countContent(base), overlay = new OverlayBackend(base), fs = createFileops({ backend: overlay });
  assert.equal((await fs.stat('dir', options)).stat.type, 'dir');
  await base.delete('dir/child'); await base.write('dir', bytes('replacement'));
  assert.equal((await fs.list('dir', options)).code, 'ENOTDIR');
  assert.equal((await fs.remove('dir', options)).code, 'ENOTSUP');
  assert.equal(reads(), 0); assert.equal(overlay.pins.size, 0);
});

test('metadata-only removal handles empty directories without file preimages', async () => {
  const base = new MemoryBackend(); await base.mkdir('empty'); await base.write('full/file', bytes('contents'));
  const reads = countContent(base), overlay = new OverlayBackend(base), fs = createFileops({ backend: overlay });
  await overlay.mkdir('empty');
  assert.equal((await fs.remove('empty', options)).ok, true);
  assert.equal((await fs.remove('full', options)).code, 'ENOTEMPTY');
  assert.equal(reads(), 0);
});

test('registry and staged I/O forward metadata-only options with ordinary grants', async () => {
  const backend = new MemoryBackend(); await backend.write('allowed/file', bytes('contents'));
  const fs = createFileops({ backend }), registry = buildRigRegistry({ fs });
  const face = createAgentFace({ registry, grant: createGrant({ prefixes: ['allowed'], scopes: ['fs:read', 'fs:remove'] }),
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }) });
  const execution = createExecution({ face });
  const io = createIO({ invoke: (name, input) => execution.invoke(name, input), cwd: () => 'allowed' });
  const reads = countContent(backend), seen = [], original = backend.stat.bind(backend);
  backend.stat = (path, opts) => { seen.push(opts); return original(path, opts); };
  assert.equal((await io.stat('file', options)).size, 8);
  assert.equal((await io.list('.', options))[0].name, 'file');
  const removal = io.remove('file', options);
  assert.ok((await execution.next()).awaitingConfirm);
  assert.equal(backend.files.has('allowed/file'), true);
  execution.answer(true); assert.equal((await removal).ok, true);
  assert.equal(reads(), 0); assert.ok(seen.every((opts) => opts?.metadataOnly === true));
  assert.equal(face.pendingProposals().length, 0);
  for (const name of ['fs.stat', 'fs.list', 'fs.remove']) {
    assert.equal((await registry.invokeCommand(name, { path: 'allowed', metadataOnly: 'true' })).ok, false);
  }
  const before = seen.length;
  for (const method of ['stat', 'list', 'remove']) {
    await assert.rejects(io[method]('/private', options), (error) => error.code === 'EGRANT');
  }
  assert.equal(seen.length, before);
});

test('I/O omits metadataOnly by default and forwards explicit false unchanged', async () => {
  const calls = [];
  const io = createIO({ cwd: () => '', invoke: async (name, input) => {
    calls.push({ name, input });
    return { ok: true, stat: { type: 'file', size: 0 }, entries: [] };
  } });
  for (const method of ['stat', 'list', 'remove']) await io[method]('file');
  assert.ok(calls.every(({ input }) => !Object.hasOwn(input, 'metadataOnly')));
  calls.length = 0;
  for (const method of ['stat', 'list', 'remove']) await io[method]('file', { metadataOnly: false });
  assert.ok(calls.every(({ input }) => input.metadataOnly === false));
});

const providerError = (name) => new DOMException(`provider ${name}`, name);

test('FSA metadata-only listing propagates handle failures and disappearance races', async () => {
  for (const [name, code] of [['NotAllowedError', 'EACCES'], ['NotFoundError', 'ENOENT'], ['UnknownError', 'EIO']]) {
    const backend = new FsaBackend({ async getDirectoryHandle() { throw providerError(name); } });
    await assert.rejects(backend.list('dir', options), (error) => error.code === code);
    assert.deepEqual(await backend.list('dir'), [], 'ordinary listing retains its previous best-effort behavior');
  }
});

test('FSA metadata-only listing reports iteration errors instead of partial success', async () => {
  const backend = new FsaBackend({
    async getDirectoryHandle() { throw providerError('NotFoundError'); },
    async *entries() { yield ['first', { kind: 'file' }]; throw providerError('NotReadableError'); },
  });
  await assert.rejects(backend.list('', options), (error) => error.code === 'EIO');
});

test('FSA metadata-only stat distinguishes absence from denied or unreadable metadata', async () => {
  for (const [name, code] of [['NotAllowedError', 'EACCES'], ['SecurityError', 'EACCES'], ['UnknownError', 'EIO']]) {
    const backend = new FsaBackend({
      async getDirectoryHandle() { throw providerError(name); },
      async getFileHandle() { throw providerError(name); },
    });
    await assert.rejects(backend.stat('parent/file', options), (error) => error.code === code);
    await assert.rejects(backend.stat('file', options), (error) => error.code === code);
    assert.equal(await backend.stat('parent/file'), null);
    assert.equal(await backend.stat('file'), null);
  }
  const absent = new FsaBackend({
    async getDirectoryHandle() { throw providerError('NotFoundError'); },
    async getFileHandle() { throw providerError('NotFoundError'); },
  });
  assert.equal(await absent.stat('file', options), null);
  assert.equal(await absent.stat('parent/file', options), null);
  assert.equal((await createFileops({ backend: absent }).stat('file', options)).code, 'ENOENT');
  const snapshotFailure = new FsaBackend({
    async getDirectoryHandle() { throw providerError('NotFoundError'); },
    async getFileHandle() { return { async getFile() { throw providerError('NotReadableError'); } }; },
  });
  await assert.rejects(snapshotFailure.stat('file', options), (error) => error.code === 'EIO');
  const directoryFailure = new FsaBackend({
    async getFileHandle() { throw providerError('TypeMismatchError'); },
    async getDirectoryHandle() { throw providerError('NotAllowedError'); },
  });
  await assert.rejects(directoryFailure.stat('dir', options), (error) => error.code === 'EACCES');
});

test('FSA metadata-only deletion propagates handle and removal failures without swallowing absence', async () => {
  for (const [name, code] of [['NotAllowedError', 'EACCES'], ['NotFoundError', 'ENOENT'], ['UnknownError', 'EIO']]) {
    const backend = new FsaBackend({
      async getDirectoryHandle() { throw providerError(name); },
      async removeEntry(_name, opts) { assert.equal(opts.recursive, false); throw providerError(name); },
    });
    await assert.rejects(backend.delete('parent/file', options), (error) => error.code === code);
    await assert.rejects(backend.delete('file', options), (error) => error.code === code);
    await backend.delete('parent/file');
  }
  let recursive;
  const ordinary = new FsaBackend({
    async getDirectoryHandle() { throw providerError('NotFoundError'); },
    async removeEntry(_name, opts) { recursive = opts.recursive; throw providerError('NotAllowedError'); },
  });
  await ordinary.delete('file');
  assert.equal(recursive, true, 'ordinary deletion keeps its existing provider contract');
});

test('metadata-only fileops directory deletion already propagates backend failures', async () => {
  const backend = { supportsMetadataOnly: true,
    async stat() { return { type: 'dir', size: 0 }; },
    async list() { return []; },
    async delete() { throw Object.assign(new Error('denied by provider'), { code: 'EACCES' }); },
  };
  const fs = createFileops({ backend });
  assert.equal((await fs.remove('dir', options)).code, 'EACCES');
  assert.equal((await fs.remove('dir')).ok, true, 'ordinary implicit-directory behavior remains unchanged');
});

test('FSA metadata-only deletion preserves a child created after the emptiness check', async () => {
  const children = new Map(); let removed = false, recursive;
  const dir = { async *entries() {} };
  const root = {
    async getDirectoryHandle(name) {
      if (name === 'dir') return dir;
      throw providerError('NotFoundError');
    },
    async getFileHandle() { throw providerError('TypeMismatchError'); },
    async removeEntry(name, opts) {
      assert.equal(name, 'dir'); recursive = opts.recursive;
      children.set('new-child', bytes('keep'));
      if (!opts.recursive && children.size) throw providerError('InvalidModificationError');
      children.clear(); removed = true;
    },
  };
  const fs = createFileops({ backend: new FsaBackend(root) });
  const result = await fs.remove('dir', options);
  assert.equal(result.code, 'ENOTEMPTY'); assert.equal(recursive, false); assert.equal(removed, false);
  assert.deepEqual(children.get('new-child'), bytes('keep'));
});

test('FSA metadata-only root deletion fails explicitly while ordinary root deletion stays a no-op', async () => {
  let removals = 0;
  const root = { async getDirectoryHandle() { throw providerError('NotFoundError'); },
    async *entries() {}, async removeEntry() { removals++; } };
  const backend = new FsaBackend(root), fs = createFileops({ backend });
  assert.equal((await fs.remove('', options)).code, 'EBUSY');
  assert.equal((await fs.remove('')).ok, true);
  assert.equal(removals, 0);
});

test('find empty and staged delete surface FSA provider failures without successful results', async () => {
  for (const failAt of ['list', 'delete']) {
    let removals = 0;
    const dir = { async *entries() {} };
    const backend = new FsaBackend({
      async getDirectoryHandle() {
        if (failAt === 'list') throw providerError('NotAllowedError');
        return dir;
      },
      async removeEntry() { removals++; throw providerError('NotAllowedError'); },
    });
    // A prior successful provider stat does not guarantee later access.
    backend.stat = async () => ({ type: 'dir', size: 0, mtimeMs: 0 });
    const fs = createFileops({ backend }), registry = buildRigRegistry({ fs });
    const face = createAgentFace({ registry, grant: createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:remove'] }),
      opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }) });
    const shell = createShell({ registry, face });
    if (failAt === 'list') {
      const result = await shell.feed('find dir -empty');
      assert.equal(shell.lastCode, 1); assert.match(result.output, /EACCES/);
      assert.equal(result.output.split('\n').includes('dir'), false);
      assert.equal(removals, 0);
    } else {
      const pending = await shell.feed('find dir -delete');
      assert.ok(pending.awaitingConfirm);
      const result = await shell.feed('y');
      assert.equal(shell.lastCode, 1); assert.match(result.output, /EACCES/);
      assert.equal(removals, 1); assert.equal(face.pendingProposals().length, 0);
    }
  }
});
