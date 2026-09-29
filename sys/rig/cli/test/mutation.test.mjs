import test from 'node:test';
import assert from 'node:assert/strict';
import { createMutationCommands } from '../cmds/mutation.mjs';
import { createIO, IOFailure } from '../io.mjs';
import { ShellInterrupted, ShellRefused } from '../execution.mjs';
import { MemoryBackend } from '../../fileops/memory-backend.mjs';
import { createFileops } from '../../fileops/fileops.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createAgentFace, createGrant, createOpLog } from '../../agent/index.mjs';

const bytes = (text) => new TextEncoder().encode(text), decode = (value) => new TextDecoder().decode(value);
function fixture(options = {}) {
  const backend = new MemoryBackend(), fs = createFileops({ backend }), registry = buildRigRegistry({ fs });
  const io = createIO({ invoke: (name, input) => registry.invokeCommand(name, input), cwd: options.cwd || (() => '') });
  return { backend, fs, io, commands: createMutationCommands(io, { randomBytes: (count) => new Uint8Array(count), ...options }) };
}

test('mktemp retries atomic collisions without overwriting competing bytes', async () => {
  let draw = 0;
  const f = fixture({ randomBytes: (count) => new Uint8Array(count).fill(draw++) });
  const original = f.backend.createExclusive.bind(f.backend); let creates = 0;
  f.backend.createExclusive = async (path, options) => {
    creates++; if (creates === 1) await f.backend.write(path, bytes('competing sentinel'));
    return original(path, options);
  };
  const result = await f.commands.mktemp(['prefix.XXX']);
  assert.equal(result.code, 0); assert.equal(decode(result.text), 'prefix.bbb\n'); assert.equal(creates, 2);
  assert.deepEqual(await f.backend.readBinary('prefix.aaa'), bytes('competing sentinel'));
  assert.equal((await f.backend.stat('prefix.bbb')).size, 0);
});

test('mktemp bounds exhausted collisions and honors quiet creation failures', async () => {
  const f = fixture({ limits: { maxTempAttempts: 2 } }); await f.backend.write('aaa', bytes('keep'));
  let creates = 0; const original = f.io.create;
  f.io.create = (...args) => { creates++; return original(...args); };
  const result = await f.commands.mktemp(['-q', 'XXX']);
  assert.equal(result.code, 1); assert.equal(decode(result.text), ''); assert.equal(creates, 2);
  assert.deepEqual(await f.backend.readBinary('aaa'), bytes('keep'));
});

test('mktemp applies virtual TMPDIR and explicit parent ordering without host paths', async () => {
  const f = fixture({ environment: () => new Map([['TMPDIR', 'virtual']]) });
  for (const name of ['virtual', 'first', 'last']) await f.backend.mkdir(name);
  assert.equal(decode((await f.commands.mktemp([])).text), 'virtual/tmp.aaaaaaaaaa\n');
  assert.equal(decode((await f.commands.mktemp(['-p', 'first', '--tmpdir=last', 'X.XXX'])).text), 'last/X.aaa\n');
  assert.equal(decode((await f.commands.mktemp(['--tmpdir=first', '-p', 'last', 'Y.XXX'])).text), 'last/Y.aaa\n');
  assert.equal(decode((await f.commands.mktemp(['-t', '-p', 'first', 'Z.XXX'])).text), 'virtual/Z.aaa\n');
});

test('mktemp creates directories, preserves suffixes, and makes no dry-run object', async () => {
  const f = fixture();
  assert.equal((await f.commands.mktemp(['-d', 'dir.XXX'])).code, 0);
  assert.equal((await f.backend.stat('dir.aaa')).type, 'dir');
  assert.equal(decode((await f.commands.mktemp(['--suffix=.txt', 'file.XXX'])).text), 'file.aaa.txt\n');
  assert.equal(decode((await f.commands.mktemp(['-u', 'dry.XXX.log'])).text), 'dry.aaa.log\n');
  assert.equal(await f.backend.stat('dry.aaa.log'), null);
});

test('mktemp preflights output, path, retained memory, and file budgets before entropy or mutation', async () => {
  for (const limits of [{ maxOutputBytes: 3 }, { maxPathBytes: 2 }, { maxRetainedBytes: 1 }, { maxFiles: 0 }]) {
    let draws = 0, writes = 0;
    const commands = createMutationCommands({ async create() { writes++; } }, {
      limits, randomBytes: (count) => { draws++; return new Uint8Array(count); },
    });
    await assert.rejects(commands.mktemp(['XXX']), /limit/); assert.equal(draws, 0); assert.equal(writes, 0);
  }
});

test('mktemp rejects malformed and adversarial entropy without filesystem effects', async () => {
  for (const randomBytes of [(count) => new Uint8Array(count + 1), (count) => new Uint8Array(count).fill(255)]) {
    let writes = 0;
    const commands = createMutationCommands({ async create() { writes++; } }, { randomBytes, limits: { maxSteps: 8 } });
    await assert.rejects(commands.mktemp(['XXX']), /random provider|resource limit/); assert.equal(writes, 0);
  }
});

test('mktemp stops after pending entropy resolves into an aborted invocation', async () => {
  const controller = new AbortController(); let deliver, began;
  const started = new Promise((resolve) => { began = resolve; }); let writes = 0;
  const commands = createMutationCommands({ async create() { writes++; } }, {
    signal: () => controller.signal, randomBytes: (count) => { began(); return new Promise((resolve) => { deliver = () => resolve(new Uint8Array(count)); }); },
  });
  const pending = commands.mktemp(['XXX']); await started; controller.abort(); deliver();
  await assert.rejects(pending, ShellInterrupted); assert.equal(writes, 0);
});

test('mutation flag and size validation precedes all filesystem effects', async () => {
  let effects = 0;
  const commands = createMutationCommands({ async remove() { effects++; }, async create() { effects++; }, async truncate() { effects++; } });
  for (const [command, args] of [['rmdir', ['first', '--bad']], ['unlink', ['one', 'two']], ['mktemp', ['--suffix=a/b', 'XXX']],
    ['truncate', ['-s', '/0', 'one']], ['truncate', ['-s', '1e3', 'one']], ['truncate', ['-o', '-s', '1', 'one']]]) {
    await assert.rejects(commands[command](args));
  }
  assert.equal(effects, 0);
});

test('rmdir parent removal preserves nonempty branches and unrelated files', async () => {
  const f = fixture(); await f.backend.mkdir('a'); await f.backend.mkdir('a/b'); await f.backend.mkdir('a/b/c');
  const result = await f.commands.rmdir(['-pv', 'a/b/c']);
  assert.equal(result.code, 0); assert.equal(await f.backend.stat('a'), null);
  assert.equal(decode(result.text), "rmdir: removing directory, 'a/b/c'\nrmdir: removing directory, 'a/b'\nrmdir: removing directory, 'a'\n");
  await f.backend.write('full/child', bytes('keep'));
  assert.equal((await f.commands.rmdir(['--ignore-fail-on-non-empty', '-p', 'full'])).code, 0);
  assert.deepEqual(await f.backend.readBinary('full/child'), bytes('keep'));
  assert.equal((await f.commands.rmdir(['full', 'missing'])).code, 1);
});

test('unlink deletes a final symlink while refusing directory and slash operands', async () => {
  const f = fixture(); await f.backend.write('target', bytes('keep')); f.backend.symlink('alias', 'target'); await f.backend.mkdir('dir');
  assert.equal((await f.commands.unlink(['alias'])).code, 0);
  assert.equal(f.backend.symlinks.has('alias'), false); assert.deepEqual(await f.backend.readBinary('target'), bytes('keep'));
  assert.equal((await f.commands.unlink(['dir'])).code, 1);
  assert.equal((await f.commands.unlink(['target/'])).code, 1); assert.deepEqual(await f.backend.readBinary('target'), bytes('keep'));
});

test('truncate preserves binary prefixes and parses exact size modifiers and suffixes', async () => {
  const f = fixture(); await f.backend.write('file', Uint8Array.of(255, 0, 128, 1));
  for (const [size, expected] of [['2', 2], ['+3', 5], ['-2', 3], ['>6', 6], ['<5', 5], ['/3', 3], ['%2', 4]]) {
    assert.equal((await f.commands.truncate(['-s', size, 'file'])).code, 0);
    const data = await f.backend.readBinary('file'); assert.equal(data.length, expected); assert.equal(data[0], 255); assert.equal(data[1], 0);
  }
  assert.equal((await f.commands.truncate(['-s', '1KB', 'decimal'])).code, 0); assert.equal((await f.backend.stat('decimal')).size, 1000);
  assert.equal((await f.commands.truncate(['-s', 'K', 'binary'])).code, 0); assert.equal((await f.backend.stat('binary')).size, 1024);
});

test('truncate leaves no-create paths absent and honors reference size adjustments', async () => {
  const f = fixture(); await f.backend.write('reference', bytes('12345')); await f.backend.write('target', bytes('ab'));
  assert.equal((await f.commands.truncate(['-c', '-s', '3', 'absent'])).code, 0); assert.equal(await f.backend.stat('absent'), null);
  assert.equal((await f.commands.truncate(['-r', 'reference', '-s', '+2', 'target'])).code, 0);
  assert.deepEqual(await f.backend.readBinary('target'), Uint8Array.of(97, 98, 0, 0, 0, 0, 0));
});

test('truncate cumulative allocation bounds preserve later files when exhausted', async () => {
  const f = fixture({ limits: { maxMutationBytes: 5 } }); await f.backend.write('one', bytes('a')); await f.backend.write('two', bytes('keep'));
  const result = await f.commands.truncate(['-s', '3', 'one', 'two']);
  assert.equal(result.code, 1); assert.match(decode(result.text), /EFBIG/);
  assert.deepEqual(await f.backend.readBinary('one'), Uint8Array.of(97, 0, 0)); assert.deepEqual(await f.backend.readBinary('two'), bytes('keep'));
});

test('truncate reference metadata refuses alias-only grants without traversing the target', async () => {
  const backend = new MemoryBackend(), fs = createFileops({ backend }); await backend.write('private/source', bytes('secret'));
  await backend.write('allowed/target', bytes('keep')); backend.symlink('allowed/reference', '../private/source');
  const registry = buildRigRegistry({ fs }), face = createAgentFace({ registry,
    grant: createGrant({ prefixes: ['allowed'], scopes: ['fs:read', 'fs:write'] }),
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }) });
  const io = createIO({ invoke: (name, input) => face.invoke(name, input) }), commands = createMutationCommands(io);
  let touchedPrivate = false; const original = backend.stat.bind(backend);
  backend.stat = (path, options) => { if (path.startsWith('private')) touchedPrivate = true; return original(path, options); };
  const result = await commands.truncate(['-r', 'allowed/reference', 'allowed/target']);
  assert.equal(result.code, 1); assert.match(decode(result.text), /ENOTSUP/); assert.equal(touchedPrivate, false);
  assert.deepEqual(await backend.readBinary('allowed/target'), bytes('keep'));
});

test('Stop and staged refusal escape mutation loops without executing later paths', async () => {
  const controller = new AbortController(); let writes = 0;
  const commands = createMutationCommands({ async truncate() { writes++; controller.abort(); return { changed: true, size: 1 }; } }, { signal: () => controller.signal });
  await assert.rejects(commands.truncate(['-s', '1', 'one', 'two']), ShellInterrupted); assert.equal(writes, 1);
  const refused = new ShellRefused('remove'); let removes = 0;
  const deleting = createMutationCommands({ async remove() { removes++; throw refused; } });
  await assert.rejects(deleting.rmdir(['one', 'two']), (error) => error === refused); assert.equal(removes, 1);
});

test('dry-run temporary names reject alias ancestors without writes', async () => {
  let writes = 0;
  const commands = createMutationCommands({ async create() { writes++; }, async stat(path, options) {
    assert.equal(options.follow, false); assert.equal(options.rejectSymlinks, true);
    throw new IOFailure('fs.stat', { code: 'ENOTSUP', message: 'symlink traversal' });
  } }, { randomBytes: (count) => new Uint8Array(count) });
  const result = await commands.mktemp(['-u', 'alias/XXX']); assert.equal(result.code, 1); assert.equal(writes, 0);
});
