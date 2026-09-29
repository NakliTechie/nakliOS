import test from 'node:test';
import assert from 'node:assert/strict';
import { createShell } from '../shell.mjs';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { buildRigRegistry, createRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';
import { createStreamingHead, createRepeatStream, collectByteStream, closeByteStream, ownByteStream } from '../cmds/streams.mjs';
import { createNumericCommands } from '../cmds/numeric.mjs';

function fresh({ scopes = ['fs:read', 'fs:write', 'fs:remove'], stageWrites = false } = {}) {
  const backend = new MemoryBackend(), fs = createFileops({ backend });
  const base = buildRigRegistry({ fs });
  const registry = stageWrites ? createRegistry(base.commands.map((command) =>
    command.name === 'fs.write' ? { ...command, destructive: true } : command)) : base;
  const face = createAgentFace({ registry, grant: createGrant({ prefixes: [''], scopes }),
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'u2-stream-contract' });
  const shell = createShell({ registry, face });
  const run = async (command) => ({ ...await shell.feed(command), code: shell.lastCode });
  const bytes = async (path) => {
    const result = await fs.read(path); assert.equal(result.ok, true, result.message); return Array.from(result.data);
  };
  return { backend, fs, face, shell, run, bytes };
}

function counted(chunks) {
  let reads = 0, returns = 0, at = 0;
  const stream = ownByteStream({
    [Symbol.asyncIterator]() { return this; },
    async next() { reads++; return at < chunks.length ? { done: false, value: chunks[at++] } : { done: true }; },
    async return() { returns++; return { done: true }; },
  });
  return { stream, reads: () => reads, returns: () => returns };
}
const fallback = async () => { throw new Error('unexpected materialized fallback'); };

test('yes terminates normally through direct head line and byte limits with exact framing', async () => {
  const ctx = fresh();
  assert.equal((await ctx.run('yes | head -n 3')).output, 'y\ny\ny');
  assert.equal(ctx.shell.lastCode, 0);
  assert.equal((await ctx.run("yes alpha beta | head -n 2 > lines")).code, 0);
  assert.deepEqual(await ctx.bytes('lines'), Array.from(new TextEncoder().encode('alpha beta\nalpha beta\n')));
  assert.equal((await ctx.run("yes 'é' | head -c 5 > bytes")).code, 0);
  assert.deepEqual(await ctx.bytes('bytes'), [195, 169, 10, 195, 169]);
  assert.equal((await ctx.run('yes | head -n 0')).output, '');
  assert.equal((await ctx.run('echo usable')).output, 'usable');
});

test('count-free repeated shuf stops through head and preserves NUL-framed bytes', async () => {
  const ctx = fresh();
  assert.equal((await ctx.run('shuf -r -e only | head -n3')).output, 'only\nonly\nonly');
  assert.equal(ctx.shell.lastCode, 0);
  assert.equal((await ctx.run("shuf -rz -e 'é' | head -c6 > repeated")).code, 0);
  assert.deepEqual(await ctx.bytes('repeated'), [195, 169, 0, 195, 169, 0]);
  assert.equal((await ctx.run('shuf -r -e only | head -n0')).output, '');
  assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('shuf validates entropy and bounds rejected draws while supporting async providers', async () => {
  const args = ['-e', 'a', 'b', 'c'];
  const invalid = createNumericCommands({}, { randomBytes: async () => Uint8Array.of(0) });
  await assert.rejects(invalid.shuf(args, ''), /invalid byte count/);
  const rejected = createNumericCommands({}, { randomBytes: () => new Uint8Array(4).fill(255), limits: { maxSteps: 8 } });
  await assert.rejects(rejected.shuf(args, ''), /steps.*limit/);
  const valid = createNumericCommands({}, { randomBytes: async () => new Uint8Array(4) });
  const result = await valid.shuf(args, '');
  assert.equal(new TextDecoder().decode(result.text), 'a\nb\nc\n');
  assert.equal(result.code, 0);
});

test('streaming head preserves arbitrary bytes and closes its source once after early completion', async () => {
  const source = counted([Uint8Array.of(0, 255, 10, 128, 65), Uint8Array.of(66)]);
  const head = createStreamingHead({ fallback });
  const result = await head(['-n', '1'], source.stream);
  assert.deepEqual(Array.from(result.text), [0, 255, 10]);
  assert.equal(source.reads(), 1); assert.equal(source.returns(), 1);
  await closeByteStream(source.stream); assert.equal(source.returns(), 1);
});

test('head zero and invalid options close without reading a producer', async () => {
  const head = createStreamingHead({ fallback });
  for (const args of [['-n', '0'], ['-c0'], ['-n+0'], ['--unknown'], ['-n1', '-', '-']]) {
    const source = counted([Uint8Array.of(120, 10)]);
    if (args[0] === '--unknown' || args.includes('-')) await assert.rejects(head(args, source.stream), /unsupported|unknown/);
    else assert.equal((await head(args, source.stream)).text.length, 0);
    assert.equal(source.reads(), 0); assert.equal(source.returns(), 1);
  }
});

test('file-only head operands close ignored producer input before ordinary file handling', async () => {
  const source = counted([Uint8Array.of(120, 10)]);
  const head = createStreamingHead({ fallback: async (argv, stdin) => {
    assert.deepEqual(argv, ['-n1', 'file']); assert.equal(stdin, '');
    assert.equal(source.returns(), 1); return { text: 'from file\n', code: 0, raw: true };
  } });
  assert.equal((await head(['-n1', 'file'], source.stream)).text, 'from file\n');
  assert.equal(source.reads(), 0); assert.equal(source.returns(), 1);
});

test('finite producer EOF preserves an unterminated final record', async () => {
  const source = counted([Uint8Array.of(65, 10), Uint8Array.of(66)]);
  const result = await createStreamingHead({ fallback })(['-n3'], source.stream);
  assert.deepEqual(Array.from(result.text), [65, 10, 66]);
  assert.equal(source.reads(), 3);
});

test('producer ceilings fail explicitly when a consumer requires completion', async () => {
  const stream = createRepeatStream(async (capacity) => new Uint8Array(capacity).fill(120),
    { command: 'fixture', limits: { maxOutputBytes: 7 } });
  await assert.rejects(collectByteStream(stream), /fixture: generated output exceeds the 7-byte limit/);
  const source = counted([Uint8Array.of(65, 66), Uint8Array.of(67, 68)]);
  await assert.rejects(collectByteStream(source.stream, { limits: { maxOutputBytes: 3 } }), /limit|exceed|output/i);
  assert.equal(source.returns(), 1);
});

test('invalid producer chunks fail without leaving an iterator open', async () => {
  for (const chunk of ['text', new Uint8Array(0), new Uint8Array(65537)]) {
    const source = counted([chunk]);
    await assert.rejects(collectByteStream(source.stream), /stream chunks/);
    assert.equal(source.returns(), 1);
  }
});

test('standalone or materialized infinite producers report resource failure and leave the shell usable', async () => {
  const ctx = fresh();
  for (const command of ['yes', 'yes | wc -l', 'yes | head -n -1', 'yes | head -n -0', 'yes | head -c -0', 'env yes | head -n 1']) {
    const result = await ctx.run(command);
    assert.equal(result.code, 2, command); assert.match(result.output, /limit|exceed|budget/i, command);
    assert.equal((await ctx.run('echo usable')).output, 'usable');
    assert.deepEqual(ctx.face.pendingProposals(), []);
  }
});

test('head refuses repeated stdin before consumption and retains all-but-zero count semantics', async () => {
  const ctx = fresh();
  for (const producer of ["printf 'a\\nb\\n'", 'yes']) {
    const result = await ctx.run(`${producer} | head -n1 - -`);
    assert.equal(result.code, 2); assert.match(result.output, /repeated standard-input operands/);
  }
  for (const flag of ['-n', '-c']) {
    assert.equal((await ctx.run(`printf 'a\\nb\\n' | head ${flag} -0 > all`)).code, 0);
    assert.deepEqual(await ctx.bytes('all'), [97, 10, 98, 10]);
  }
  assert.equal((await ctx.run('yes usable | head -n1')).output, 'usable');
  assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('unknown and refusing downstream commands leave no producer or proposal active', async () => {
  const ctx = fresh({ scopes: ['fs:read'] });
  const unknown = await ctx.run('yes | absent-command');
  assert.equal(unknown.code, 127); assert.match(unknown.output, /command not found/);
  const denied = await ctx.run('yes | head -n1 > protected');
  assert.equal(denied.code, 1); assert.equal((await ctx.fs.stat('protected')).ok, false);
  assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal((await ctx.run('echo usable')).output, 'usable');
});

test('accepted, refused, and cancelled writes after head retain the real staging boundary', async () => {
  const ctx = fresh({ stageWrites: true });
  const first = await ctx.run('yes | head -n2 > accepted'); assert.ok(first.awaitingConfirm);
  assert.equal((await ctx.fs.stat('accepted')).ok, false);
  await ctx.run('y'); assert.deepEqual(await ctx.bytes('accepted'), [121, 10, 121, 10]);
  const second = await ctx.run('yes | head -n1 > refused'); assert.ok(second.awaitingConfirm);
  await ctx.run('n'); assert.equal((await ctx.fs.stat('refused')).ok, false);
  const third = await ctx.run('yes | head -n1 > stopped'); assert.ok(third.awaitingConfirm);
  await ctx.shell.cancel(); assert.equal(ctx.shell.lastCode, 130);
  assert.equal((await ctx.fs.stat('stopped')).ok, false); assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal((await ctx.run('echo usable')).output, 'usable');
});

test('Stop interrupts active producer work and a subsequent invocation starts cleanly', async () => {
  const ctx = fresh();
  const pending = ctx.run('yes; echo BAD > after-stop');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await ctx.shell.cancel(); await pending;
  assert.equal(ctx.shell.lastCode, 130);
  assert.equal((await ctx.fs.stat('after-stop')).ok, false); assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal((await ctx.run('echo usable')).output, 'usable');
});

test('reset abandons a yielded producer without changing the new session or running later writes', async () => {
  const ctx = fresh();
  const pending = ctx.run('yes; echo BAD > after-reset');
  await new Promise((resolve) => setTimeout(resolve, 0));
  ctx.shell.reset();
  await pending;
  assert.equal(ctx.shell.lastCode, 0);
  assert.equal((await ctx.fs.stat('after-reset')).ok, false);
  assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal((await ctx.run('yes fresh | head -n1')).output, 'fresh');
  assert.equal(ctx.shell.lastCode, 0);
});

test('printenv uses the virtual environment and preserves named order, missing-name status, and NULs', async () => {
  const ctx = fresh();
  await ctx.run('export ALPHA=first BETA=second');
  assert.equal((await ctx.run('printenv BETA MISSING ALPHA')).output, 'second\nfirst');
  assert.equal(ctx.shell.lastCode, 1);
  assert.equal((await ctx.run('printenv -0 ALPHA BETA > vars')).code, 0);
  assert.deepEqual(await ctx.bytes('vars'), Array.from(new TextEncoder().encode('first\0second\0')));
  assert.equal((await ctx.run('env -i printenv')).output, '');
  assert.equal((await ctx.run('env -i ONLY=present printenv')).output, 'ONLY=present');
  assert.equal((await ctx.run('printenv PWD')).output, '/');
  const isolated = await ctx.run('env -i printenv PWD'); assert.equal(isolated.code, 1); assert.equal(isolated.output, '');
});
