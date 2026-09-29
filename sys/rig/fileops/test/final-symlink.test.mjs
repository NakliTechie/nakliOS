import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileops } from '../fileops.mjs';
import { MemoryBackend } from '../memory-backend.mjs';
import { OverlayBackend } from '../overlay-backend.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';
import { createIO, IOFailure } from '../../cli/io.mjs';
import { createExecution, ShellInterrupted, ShellRefused } from '../../cli/execution.mjs';

const bytes = (value) => new TextEncoder().encode(value);
const contents = async (fs, path) => {
  const result = await fs.read(path, { encoding: 'utf-8' });
  assert.equal(result.ok, true, result.message);
  return result.data;
};
function governed({ prefixes = [''], scopes = ['fs:read', 'fs:write', 'fs:remove'], readOnlyPrefixes = [], cwd = '' } = {}) {
  const backend = new MemoryBackend(), fs = createFileops({ backend });
  const registry = buildRigRegistry({ fs });
  const face = createAgentFace({ registry, grant: createGrant({ prefixes, scopes, readOnlyPrefixes }),
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }) });
  const execution = createExecution({ face });
  return { backend, fs, registry, face, execution, io: createIO({ invoke: (name, input) => execution.invoke(name, input), cwd: () => cwd }) };
}

test('stat retains default following and explicitly exposes final-link metadata', async () => {
  const backend = new MemoryBackend(), fs = createFileops({ backend, root: 'mnt' });
  await fs.write('target', 'target bytes'); backend.symlink('mnt/link', 'target');
  assert.equal((await fs.stat('link')).stat.type, 'file');
  assert.equal((await fs.stat('link', { follow: true })).stat.type, 'file');
  const direct = await fs.stat('link', { follow: false });
  assert.equal(direct.stat.type, 'symlink'); assert.equal(direct.stat.target, 'target');
  assert.equal(await contents(fs, 'link'), 'target bytes');
});

test('final file-link deletion preserves its target while the default still follows', async () => {
  const backend = new MemoryBackend(), fs = createFileops({ backend });
  await fs.write('target', 'keep'); backend.symlink('link', 'target');
  assert.equal((await fs.remove('link', { follow: false })).ok, true);
  assert.equal((await fs.stat('link', { follow: false })).code, 'ENOENT');
  assert.equal(await contents(fs, 'target'), 'keep');
  backend.symlink('legacy', 'target');
  assert.equal((await fs.remove('legacy')).ok, true);
  assert.equal((await fs.stat('target')).code, 'ENOENT');
  assert.equal((await fs.stat('legacy', { follow: false })).stat.type, 'symlink');
});

test('final directory links are removed without traversing target descendants', async () => {
  for (const recursive of [false, true]) {
    const backend = new MemoryBackend(), fs = createFileops({ backend });
    await fs.write('target/deep/file', 'keep'); backend.symlink('link', 'target');
    assert.equal((await fs.remove('link', { follow: false, recursive })).ok, true);
    assert.equal(await contents(fs, 'target/deep/file'), 'keep');
    assert.equal((await fs.stat('link', { follow: false })).code, 'ENOENT');
  }
});

test('dangling, cyclic, and outward final links never inspect their targets', async () => {
  for (const target of ['missing', 'link', '../../outside']) {
    const backend = new MemoryBackend(), fs = createFileops({ backend, root: 'mnt' });
    backend.symlink('mnt/link', target);
    const paths = [], original = backend.stat.bind(backend);
    backend.stat = async (path, options) => { paths.push(path); return original(path, options); };
    assert.equal((await fs.stat('link', { follow: false })).stat.target, target);
    assert.equal((await fs.remove('link', { follow: false })).ok, true);
    assert.ok(paths.length > 0);
    assert.deepEqual([...new Set(paths)], ['mnt/link']);
  }
});

test('ancestor links resolve while the final link remains untouched by stat', async () => {
  const backend = new MemoryBackend(), fs = createFileops({ backend, root: 'mnt' });
  await fs.write('real/target', 'keep');
  backend.symlink('mnt/real/final', 'target'); backend.symlink('mnt/ancestor', 'real');
  assert.equal((await fs.stat('ancestor/final', { follow: false })).stat.type, 'symlink');
  assert.equal((await fs.remove('ancestor/final', { follow: false })).ok, true);
  assert.equal(await contents(fs, 'real/target'), 'keep');
  assert.equal((await fs.stat('real/final', { follow: false })).code, 'ENOENT');
  assert.equal((await fs.stat('ancestor', { follow: false })).stat.type, 'symlink');
});

test('escaping and cyclic ancestors retain their containment and hop-limit failures', async () => {
  const backend = new MemoryBackend(), fs = createFileops({ backend, root: 'mnt' });
  backend.symlink('mnt/out', '../../outside'); backend.symlink('mnt/loop', 'loop');
  for (const method of ['stat', 'remove']) {
    assert.equal((await fs[method]('out/file', { follow: false })).code, 'EINVAL_PATH');
    assert.equal((await fs[method]('loop/file', { follow: false })).code, 'ELOOP');
  }
  assert.equal((await backend.stat('mnt/out')).type, 'symlink');
  assert.equal((await backend.stat('mnt/loop')).type, 'symlink');
});

test('ordinary paths, non-empty directories, and empty roots retain their behavior', async () => {
  const fs = createFileops({ backend: new MemoryBackend() });
  await fs.write('dir/file', 'keep');
  assert.equal((await fs.stat('dir/file', { follow: false })).stat.type, 'file');
  assert.equal((await fs.stat('missing', { follow: false })).code, 'ENOENT');
  assert.equal((await fs.remove('dir', { follow: false })).code, 'ENOTEMPTY');
  assert.equal((await fs.remove('dir', { follow: false, recursive: true })).ok, true);
  assert.equal((await fs.stat('dir', { follow: false })).code, 'ENOENT');
  const empty = createFileops({ backend: { async stat() { return null; } } });
  assert.deepEqual((await empty.stat('', { follow: false })).stat, { type: 'dir', size: 0, mtimeMs: 0 });
});

test('bounded reads keep following links and enforce the existing byte budget', async () => {
  const backend = new MemoryBackend(), fs = createFileops({ backend });
  await fs.write('target', 'keep'); backend.symlink('link', 'target');
  assert.equal((await fs.stat('link', { follow: false })).stat.type, 'symlink');
  assert.equal((await fs.read('link', { maxBytes: 3 })).code, 'EFBIG');
  assert.deepEqual((await fs.read('link', { maxBytes: 4 })).data, bytes('keep'));
});

test('registry validates and forwards final-link options for stat and remove', async () => {
  const { backend, fs, registry } = governed();
  await fs.write('target', 'keep'); backend.symlink('link', 'target');
  assert.equal((await registry.invokeCommand('fs.stat', { path: 'link', follow: false })).stat.type, 'symlink');
  assert.equal((await registry.invokeCommand('fs.stat', { path: 'link', follow: 'false' })).ok, false);
  assert.equal((await registry.invokeCommand('fs.remove', { path: 'link', follow: 'false' })).ok, false);
  assert.equal((await registry.invokeCommand('fs.remove', { path: 'link', follow: false })).ok, true);
  assert.equal(await contents(fs, 'target'), 'keep');
});

test('I/O preserves cwd and waits for staged final-link removal approval', async () => {
  const { backend, fs, face, execution, io } = governed({ cwd: 'dir' });
  await fs.write('dir/target', 'keep'); backend.symlink('dir/link', 'target');
  assert.equal((await io.stat('link', { follow: false })).type, 'symlink');
  let completed = false;
  const removal = io.remove('link', { follow: false }).then((value) => { completed = true; return value; });
  const pending = await execution.next();
  assert.ok(pending.awaitingConfirm); assert.equal(completed, false);
  assert.equal((await fs.stat('dir/link', { follow: false })).stat.type, 'symlink');
  assert.equal(await contents(fs, 'dir/target'), 'keep');
  execution.answer(true); assert.equal((await removal).ok, true);
  assert.equal((await fs.stat('dir/link', { follow: false })).code, 'ENOENT');
  assert.equal(await contents(fs, 'dir/target'), 'keep');
  assert.equal(face.pendingProposals().length, 0);
});

test('staged refusal and Stop preserve both final link and target', async () => {
  for (const stop of [false, true]) {
    const { backend, fs, face, execution, io } = governed();
    await fs.write('target', 'keep'); backend.symlink('link', 'target');
    const removal = io.remove('link', { follow: false });
    const rejection = assert.rejects(removal, stop ? ShellInterrupted : ShellRefused);
    assert.ok((await execution.next()).awaitingConfirm);
    if (stop) execution.cancel(); else execution.answer(false);
    await rejection;
    assert.equal((await fs.stat('link', { follow: false })).stat.type, 'symlink');
    assert.equal(await contents(fs, 'target'), 'keep');
    assert.equal(face.pendingProposals().length, 0);
  }
});

test('nofollow reads and removals retain grants and read-only restrictions', async () => {
  const { backend, fs, io, face } = governed({ prefixes: ['allowed'], readOnlyPrefixes: ['allowed/readonly'] });
  await fs.write('target', 'keep');
  backend.symlink('private', 'target'); backend.symlink('allowed/readonly', '../target');
  await assert.rejects(io.stat('private', { follow: false }), (error) => error instanceof IOFailure && error.code === 'EGRANT');
  await assert.rejects(io.remove('private', { follow: false }), (error) => error.code === 'EGRANT');
  await assert.rejects(io.remove('allowed/readonly', { follow: false }), (error) => error.code === 'EGRANT');
  assert.equal(face.pendingProposals().length, 0);
  assert.equal(await contents(fs, 'target'), 'keep');
});

test('Overlay final-link deletion tombstones the link and preserves its base target', async () => {
  const base = new MemoryBackend(); await base.write('target', bytes('keep')); base.symlink('link', 'target');
  const overlay = new OverlayBackend(base), fs = createFileops({ backend: overlay });
  assert.equal((await fs.stat('link', { follow: false })).stat.type, 'symlink');
  assert.equal((await fs.remove('link', { follow: false })).ok, true);
  assert.equal((await fs.stat('link', { follow: false })).code, 'ENOENT');
  assert.equal(await contents(fs, 'target'), 'keep');
  assert.equal((await base.stat('link')).type, 'symlink');
  assert.deepEqual(await base.readBinary('target'), bytes('keep'));
});

test('unlink and recreate invalidate postings reached through an indirect alias', async () => {
  const backend = new MemoryBackend(), fs = createFileops({ backend, index: true, exclusive: true });
  await fs.write('z-target', 'alpha\n');
  backend.symlink('a-alias', 'b-link'); backend.symlink('b-link', 'z-target');
  assert.deepEqual((await fs.grep('alpha')).matches.map((match) => match.path), ['a-alias', 'b-link', 'z-target']);
  assert.equal((await fs.remove('b-link', { follow: false })).ok, true);
  await fs.write('b-link', 'omega\n');
  assert.deepEqual((await fs.grep('omega')).matches.map((match) => match.path), ['a-alias', 'b-link']);
  assert.deepEqual((await fs.grep('alpha')).matches.map((match) => match.path), ['z-target']);
  assert.equal(await contents(fs, 'z-target'), 'alpha\n');
});

test('an in-flight alias read cannot reinstall postings after final-link deletion', async () => {
  const backend = new MemoryBackend(), fs = createFileops({ backend, index: true, exclusive: true });
  await fs.write('z-target', 'alpha\n');
  backend.symlink('a-alias', 'b-link'); backend.symlink('b-link', 'z-target');
  let release, reached;
  const paused = new Promise((resolve) => { release = resolve; });
  const captured = new Promise((resolve) => { reached = resolve; });
  const original = backend.readBinary.bind(backend); let first = true;
  backend.readBinary = async (path, options) => {
    const data = await original(path, options);
    if (path === 'z-target' && first) { first = false; reached(); await paused; }
    return data;
  };
  const searching = fs.grep('alpha');
  await captured;
  await fs.remove('b-link', { follow: false }); await fs.write('b-link', 'omega\n');
  release(); await searching; backend.readBinary = original;
  assert.deepEqual((await fs.grep('omega')).matches.map((match) => match.path), ['a-alias', 'b-link']);
  assert.deepEqual((await fs.grep('alpha')).matches.map((match) => match.path), ['z-target']);
  assert.equal(await contents(fs, 'z-target'), 'alpha\n');
});
