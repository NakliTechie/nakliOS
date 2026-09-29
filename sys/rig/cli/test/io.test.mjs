// U0 command I/O: byte preservation, cwd resolution, and the governed face.
// Run: node sys/rig/cli/test/io.test.mjs
import assert from 'node:assert/strict';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';
import { createIO, IOFailure, toBytes, toText, autoData, concatData, renderData } from '../io.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (error) { failures.push({ name, message: error.message }); }
}

function fixture({ prefixes = [''], scopes = ['fs:read', 'fs:write', 'fs:remove'] } = {}) {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes, scopes });
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant, opLog });
  let cwd = '';
  const io = createIO({ invoke: face.invoke, cwd: () => cwd });
  return { fs, face, io, cd: (path) => { cwd = path; } };
}

await test('byte data survives mixed concatenation and invalid UTF-8 decoding', () => {
  const binary = new Uint8Array([0xff, 0xc3, 0x00]);
  const data = concatData(['é', binary, 'x']);
  assert.deepEqual([...data], [0xc3, 0xa9, 0xff, 0xc3, 0x00, 0x78]);
  assert.equal(renderData(data), '<6 bytes>');
  assert.equal(toText(binary), '\ufffd\ufffd\0');
  assert.deepEqual([...binary], [0xff, 0xc3, 0]);
  assert.equal(concatData(['a', '', 'b']), 'ab');
  assert.ok(concatData(['', new Uint8Array()]) instanceof Uint8Array);
});

await test('auto text retains multibyte Unicode and UTF-8 BOM bytes', () => {
  for (const text of ['hello\n', 'नमस्ते\t🌏', '\ufeffprefix', '\v\f\r', '']) {
    const bytes = toBytes(text);
    const decoded = autoData(bytes);
    assert.equal(decoded, text);
    assert.deepEqual(toBytes(decoded), bytes);
  }
  for (const bytes of [new Uint8Array([0xff]), new Uint8Array([0xc3]), new Uint8Array([0]), new Uint8Array([27])]) {
    assert.ok(autoData(bytes) instanceof Uint8Array);
    assert.deepEqual(autoData(bytes), bytes);
  }
  assert.deepEqual(autoData('a\0b'), new Uint8Array([97, 0, 98]));
});

await test('byte helpers honor subarray offsets', () => {
  const bytes = new Uint8Array([255, 65, 66, 255]).subarray(1, 3);
  assert.equal(autoData(bytes), 'AB');
  assert.equal(toText(bytes), 'AB');
  assert.equal(renderData(bytes), '<2 bytes>');
  assert.deepEqual(concatData([bytes, new Uint8Array([67])]), new Uint8Array([65, 66, 67]));
});

await test('I/O reads text automatically while preserving binary write/read bytes', async () => {
  const { io } = fixture();
  const bytes = new Uint8Array([0xff, 0, 0xc3, 0xa9]);
  await io.write('data.bin', bytes);
  await io.write('text.txt', 'é\n');
  assert.deepEqual(await io.readBytes('data.bin'), bytes);
  assert.deepEqual(await io.read('data.bin'), bytes);
  assert.equal(await io.read('text.txt'), 'é\n');
  assert.equal(await io.readText('data.bin'), '\ufffd\0é');
  await io.write('copy.bin', concatData([await io.read('data.bin'), await io.read('text.txt')]));
  assert.deepEqual(await io.readBytes('copy.bin'), new Uint8Array([255, 0, 195, 169, 195, 169, 10]));
});

await test('I/O resolves paths using current cwd and clamps parent traversal to root', async () => {
  const { io, cd } = fixture();
  await io.write('src/nested/file', 'nested', { createParents: true });
  cd('src');
  assert.equal(io.resolve('./nested/../file'), 'src/file');
  assert.equal(io.resolve('../../../outside'), 'outside');
  assert.equal(io.resolve('/absolute'), 'absolute');
  assert.equal(io.resolve('\u0001*.txt'), 'src/\u0001*.txt');
  assert.equal(await io.readText('nested/file'), 'nested');
  cd('src/nested');
  assert.equal(await io.readText('file'), 'nested');
  assert.equal((await io.stat('.')).type, 'dir');
  assert.deepEqual((await io.list()).map((entry) => entry.path), ['src/nested/file']);
});

await test('glob and recursive list return mount-relative paths', async () => {
  const { io, cd } = fixture();
  await io.write('src/a.txt', 'a', { createParents: true });
  await io.write('src/deep/b.txt', 'b', { createParents: true });
  await io.write('root.txt', 'r');
  cd('src');
  assert.deepEqual(await io.glob('*.txt'), ['src/a.txt']);
  assert.deepEqual(await io.glob('*.txt', { cwd: 'deep' }), ['src/deep/b.txt']);
  assert.deepEqual(await io.glob('/root.txt'), ['root.txt']);
  assert.deepEqual((await io.list('.', { recursive: true })).map((entry) => entry.path), [
    'src/a.txt', 'src/deep', 'src/deep/b.txt',
  ]);
});

await test('move and copy resolve both paths and preserve bytes', async () => {
  const { io, cd } = fixture();
  const bytes = new Uint8Array([0xff, 0, 1]);
  await io.write('dir/original', bytes, { createParents: true });
  cd('dir');
  await io.copy('original', 'copied');
  await io.move('copied', '/moved');
  assert.deepEqual(await io.readBytes('/moved'), bytes);
  assert.deepEqual(await io.readBytes('original'), bytes);
  await assert.rejects(io.stat('copied'), (error) => error instanceof IOFailure && error.code === 'ENOENT');
});

await test('typed failures retain operation and complete face result', async () => {
  const result = { ok: false, code: 'EGRANT', message: 'path outside grant: private', details: { scope: 'fs:read' } };
  const io = createIO({ invoke: async () => result });
  await assert.rejects(io.readBytes('private'), (error) => {
    assert.ok(error instanceof IOFailure);
    assert.equal(error.operation, 'fs.read');
    assert.equal(error.code, 'EGRANT');
    assert.equal(error.message, result.message);
    assert.equal(error.result, result);
    return true;
  });
});

await test('file access and mutations remain constrained by the face grant', async () => {
  const { fs, io } = fixture({ prefixes: ['allowed'], scopes: ['fs:read'] });
  await fs.write('allowed/readable', 'read', { createParents: true });
  await fs.write('private', 'secret');
  assert.equal(await io.readText('allowed/readable'), 'read');
  for (const operation of [
    () => io.readBytes('private'),
    () => io.write('allowed/readable', 'changed'),
    () => io.copy('allowed/readable', 'allowed/copy'),
    () => io.move('allowed/readable', 'allowed/moved'),
    () => io.remove('allowed/readable'),
  ]) {
    await assert.rejects(operation(), (error) => error.code === 'EGRANT');
  }
  assert.equal((await fs.read('allowed/readable', { encoding: 'utf-8' })).data, 'read');
});

await test('remove cannot accept a staged proposal on its own', async () => {
  const { io, face } = fixture();
  await io.write('keep', 'keep');
  await assert.rejects(io.remove('keep'), (error) => error.code === 'ESTAGED' && error.result.staged);
  assert.equal(await io.readText('keep'), 'keep');
  assert.equal(face.pendingProposals().length, 1);
});

await test('I/O waits for the supplied staged-operation wrapper before continuing', async () => {
  const { io: setup, face } = fixture();
  await setup.write('remove', 'remove');
  let answer;
  let stageReady;
  const staged = new Promise((resolve) => { stageReady = resolve; });
  const io = createIO({
    invoke: async (name, input) => {
      const result = await face.invoke(name, input);
      if (!result.staged) return result;
      stageReady(result.proposalId);
      return new Promise((resolve) => { answer = async () => resolve(await face.accept(result.proposalId)); });
    },
  });
  let completed = false;
  const deleting = io.remove('remove').then(() => { completed = true; });
  await staged;
  assert.equal(completed, false);
  assert.equal(await setup.readText('remove'), 'remove');
  await answer();
  await deleting;
  assert.equal(completed, true);
  await assert.rejects(setup.stat('remove'), (error) => error.code === 'ENOENT');
});

await test('nested commands receive literal argv and byte stdin without reparsing', async () => {
  const bytes = new Uint8Array([255, 0]);
  const result = { text: bytes, code: 7 };
  let received;
  const io = createIO({ invoke: async () => { throw new Error('unexpected filesystem call'); }, run: async (...args) => {
    received = args;
    return result;
  } });
  const argv = ['cat', 'space name', '; rm unsafe'];
  assert.equal(await io.run(argv, bytes), result);
  assert.deepEqual(received, [argv, bytes]);
  await assert.rejects(io.run('cat x'), TypeError);
  await assert.rejects(createIO({ invoke: async () => ({ ok: true }) }).run(['cat']), (error) => error.code === 'ENOSYS');
});

if (failures.length) {
  console.error(`command I/O: ${passed} passed, ${failures.length} FAILED`);
  for (const failure of failures) console.error(`  FAIL ${failure.name}: ${failure.message}`);
  process.exit(1);
}
console.log(`U0/command I/O conformance: ${passed}/${passed} passed`);
