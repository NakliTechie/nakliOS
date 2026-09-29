import test from 'node:test';
import assert from 'node:assert/strict';
import { createIO } from '../io.mjs';
import { createArchiveCommands } from '../cmds/archives.mjs';
import { fresh, seed, absent, expect, deferred, delay, decode, bytesOf } from './u3-harness.mjs';
import { binary, concat, tarFixture, zipFixture, gzipSync } from './u4a-archive-fixtures.mjs';

// Public shell coverage carries grants, staging and Stop. The public factory seam
// supplies tiny deterministic resource limits without changing global shell caps.
function bounded(ctx, limits = {}, signal = () => null) {
  const io = createIO({ invoke: (name, input) => ctx.face.invoke(name, input) });
  const commands = createArchiveCommands(io, { signal, limits, authorize: (name, input) => ctx.face.check(name, input) });
  return async (name, argv, stdin = '') => {
    try { return await commands[name](argv, stdin); }
    catch (error) { return { code: typeof error.code === 'number' ? error.code : 2, stdout: '', stderr: error.message }; }
  };
}
function failed(result) { assert.notEqual(result.code, 0); assert.notEqual(decode(result.stderr), '', 'refusal must have a diagnostic'); }
function limited(result) { failed(result); assert.match(decode(result.stderr), /limit|budget|exceed|large|bound/i); }
const fixtures = {
  tar: (entries) => tarFixture(entries),
  zip: (entries) => zipFixture(entries.map((entry) => ({ ...entry, method: 8 }))),
};
const extract = (kind, archive = 'archive', directory = 'out') => kind === 'tar' ? `tar -xf ${archive} -C ${directory}` : `unzip -oq ${archive} -d ${directory}`;

for (const command of ['tar -tf secret/archive', 'gzip -c secret/source', 'gunzip -c secret/archive', 'zcat secret/archive', 'unzip -p secret/archive', 'zip -q allowed/out.zip secret/source']) {
  test(`archive commands respect denied source grants: ${command}`, async () => {
    const ctx = fresh({ prefixes: ['allowed'] }); await seed(ctx, { 'secret/source': 'secret payload', 'secret/archive': gzipSync('secret payload') });
    const reads = [], read = ctx.backend.readBinary.bind(ctx.backend); ctx.backend.readBinary = async (path, options) => { reads.push(path); return read(path, options); };
    failed(await ctx.run(command)); assert.deepEqual(reads, []); await absent(ctx, 'allowed/out.zip'); assert.deepEqual(ctx.face.pendingProposals(), []);
  });
}

for (const kind of ['tar', 'zip']) {
  test(`${kind} preflights every destination grant before its first extraction effect`, async () => {
    const ctx = fresh({ readOnlyPrefixes: ['out/denied'] });
    await seed(ctx, { archive: fixtures[kind]([{ name: 'first', data: 'new' }, { name: 'denied/value', data: 'attack' }]), 'out/denied/value': 'keep' });
    failed(await ctx.run(extract(kind))); await absent(ctx, 'out/first'); assert.equal(await ctx.read('out/denied/value'), 'keep');
    assert.deepEqual(ctx.face.pendingProposals(), []);
  });
  test(`${kind} refuses an extraction root outside granted prefixes`, async () => {
    const ctx = fresh({ prefixes: ['allowed'] }); await seed(ctx, { 'allowed/archive': fixtures[kind]([{ name: 'first', data: 'new' }]) });
    failed(await ctx.run(extract(kind, 'allowed/archive', 'outside/missing'))); await absent(ctx, 'outside');
  });
  test(`${kind} destination type conflicts fail before earlier entries are written`, async () => {
    const ctx = fresh(); await seed(ctx, { archive: fixtures[kind]([{ name: 'first', data: 'new' }, { name: 'conflict/child', data: 'new' }]), 'out/conflict': 'keep' });
    failed(await ctx.run(extract(kind))); await absent(ctx, 'out/first'); assert.equal(await ctx.read('out/conflict'), 'keep');
  });
  for (const location of ['root', 'ancestor', 'final']) test(`${kind} refuses ${location} destination links without touching their targets`, async () => {
    const ctx = fresh(); await seed(ctx, { archive: fixtures[kind]([{ name: 'dir/value', data: 'attack' }]), 'protected/dir/value': 'keep root', 'protected/value': 'keep leaf' });
    await ctx.fs.mkdir('out'); await ctx.fs.mkdir('out/dir');
    if (location === 'root') { ctx.backend.dirs.delete('out'); ctx.backend.dirs.delete('out/dir'); ctx.backend.symlink('out', 'protected'); }
    if (location === 'ancestor') { ctx.backend.dirs.delete('out/dir'); ctx.backend.symlink('out/dir', '../protected'); }
    if (location === 'final') ctx.backend.symlink('out/dir/value', '../../protected/value');
    failed(await ctx.run(extract(kind))); assert.equal(await ctx.read('protected/dir/value'), 'keep root'); assert.equal(await ctx.read('protected/value'), 'keep leaf');
    assert.deepEqual(ctx.face.pendingProposals(), []);
  });
  for (const location of ['ancestor', 'final']) test(`${kind} rechecks ${location} destination links after staged write approval`, async () => {
    const ctx = fresh({ stageWrites: true }); await seed(ctx, { archive: fixtures[kind]([{ name: 'dir/value', data: 'attack' }]), 'protected/value': 'keep' });
    await ctx.fs.mkdir('out/dir', { createParents: true }); const prompt = await ctx.run(extract(kind)); assert.ok(prompt.awaitingConfirm);
    await absent(ctx, 'out/dir/value');
    if (location === 'ancestor') { ctx.backend.dirs.delete('out/dir'); ctx.backend.symlink('out/dir', '../protected'); }
    else ctx.backend.symlink('out/dir/value', '../../protected/value');
    failed(await ctx.run('y')); assert.equal(await ctx.read('protected/value'), 'keep'); assert.deepEqual(ctx.face.pendingProposals(), []);
  });
  test(`${kind} stages binary extraction and refusal clears the continuation`, async () => {
    const ctx = fresh({ stageWrites: true }); await seed(ctx, { archive: fixtures[kind]([{ name: 'first', data: binary }, { name: 'second', data: 'second' }]) }); await ctx.fs.mkdir('out');
    const prompt = await ctx.run(extract(kind)); assert.ok(prompt.awaitingConfirm); await absent(ctx, 'out/first', 'out/second');
    failed(await ctx.run('n')); await absent(ctx, 'out/first', 'out/second'); assert.deepEqual(ctx.face.pendingProposals(), []);
    const retry = await ctx.run(extract(kind)); assert.ok(retry.awaitingConfirm); assert.ok((await ctx.run('y')).awaitingConfirm);
    assert.deepEqual(await ctx.bytes('out/first'), Array.from(binary)); assert.equal((await ctx.run('y')).code, 0); assert.equal(await ctx.read('out/second'), 'second');
  });
  test(`${kind} Stop rejects a pending extraction and preserves the next invocation`, async () => {
    const ctx = fresh({ stageWrites: true }); await seed(ctx, { archive: fixtures[kind]([{ name: 'first', data: binary }, { name: 'second', data: 'second' }]) }); await ctx.fs.mkdir('out');
    assert.ok((await ctx.run(extract(kind))).awaitingConfirm); await ctx.shell.cancel(); assert.equal(ctx.shell.lastCode, 130);
    await absent(ctx, 'out/first', 'out/second'); assert.deepEqual(ctx.face.pendingProposals(), []); await expect(ctx, 'echo recovered', 'recovered\n');
  });
}

for (const command of ['tar -cf out.tar source protected/file', 'zip -q out.zip source protected/file']) test(`archive creation validates all source grants before output: ${command}`, async () => {
  const ctx = fresh({ prefixes: ['source', 'out.tar', 'out.zip'] }); await seed(ctx, { source: binary, 'protected/file': 'secret' });
  failed(await ctx.run(command)); await absent(ctx, 'out.tar', 'out.zip'); assert.deepEqual(ctx.face.pendingProposals(), []);
});

for (const command of ['tar -cf protected/out.tar source', 'zip -q protected/out.zip source', 'gzip -k protected/source']) test(`archive creation honors read-only destinations: ${command}`, async () => {
  const ctx = fresh({ readOnlyPrefixes: ['protected'] }); await seed(ctx, { source: binary, 'protected/source': binary });
  failed(await ctx.run(command)); await absent(ctx, 'protected/out.tar', 'protected/out.zip', 'protected/source.gz');
});

for (const command of ['gzip source', 'gunzip source.gz']) for (const decision of ['refuse', 'stop']) test(`${command} preserves its source when governed removal is ${decision}`, async () => {
  const ctx = fresh(); await seed(ctx, command.startsWith('gunzip') ? { 'source.gz': gzipSync(binary) } : { source: binary });
  const originalPath = command.startsWith('gunzip') ? 'source.gz' : 'source', original = await ctx.bytes(originalPath);
  assert.ok((await ctx.run(command)).awaitingConfirm);
  if (decision === 'stop') { await ctx.shell.cancel(); assert.equal(ctx.shell.lastCode, 130); } else failed(await ctx.run('n'));
  assert.deepEqual(await ctx.bytes(originalPath), original); assert.deepEqual(ctx.face.pendingProposals(), []);
  await expect(ctx, 'echo recovered', 'recovered\n');
});

test('Stop waits for an owned archive read then prevents all extraction effects', { timeout: 4000 }, async () => {
  const entered = deferred(), release = deferred();
  const ctx = fresh({ beforeOperation: async (name, input) => { if (name === 'fs.read' && input.path === 'archive') { entered.resolve(); await release.promise; } } });
  await seed(ctx, { archive: tarFixture([{ name: 'first', data: binary }]) }); await ctx.fs.mkdir('out');
  const active = ctx.run('tar -xf archive -C out'); await entered.promise;
  let finished = false; const stopping = ctx.shell.cancel().then(() => { finished = true; });
  await delay(10); assert.equal(finished, false); release.resolve(); await Promise.all([active, stopping]);
  assert.equal(ctx.shell.lastCode, 130); await absent(ctx, 'out/first'); assert.deepEqual(ctx.face.pendingProposals(), []);
  await expect(ctx, 'echo recovered', 'recovered\n');
});

test('gzip concatenated members share one expanded-byte budget', async () => {
  const ctx = fresh(), run = bounded(ctx, { maxExpandedBytes: 64 });
  const member = gzipSync(new Uint8Array(48).fill(65));
  const single = await run('zcat', [], member); assert.equal(single.code, 0, decode(single.stderr)); assert.equal(bytesOf(single.stdout).length, 48);
  const result = await run('zcat', [], concat(member, member)); limited(result); assert.deepEqual(bytesOf(result.stdout), []);
});

test('ZIP entries share one expanded-byte budget before any destination write', async () => {
  const ctx = fresh(), run = bounded(ctx, { maxExpandedBytes: 64 });
  await seed(ctx, { archive: zipFixture([{ name: 'first', data: new Uint8Array(48), method: 8 }, { name: 'second', data: new Uint8Array(48), method: 8 }]) });
  limited(await run('unzip', ['-o', 'archive', '-d', 'out'])); await absent(ctx, 'out', 'out/first', 'out/second');
});

test('gzip-compressed tar expansion is charged once rather than again during tar parsing', async () => {
  const ctx = fresh(), bytes = tarFixture([{ name: 'file', data: binary }]), run = bounded(ctx, { maxExpandedBytes: bytes.length });
  await seed(ctx, { archive: gzipSync(bytes) }); await ctx.fs.mkdir('out');
  const result = await run('tar', ['-xzf', 'archive', '-C', 'out']); assert.equal(result.code, 0, decode(result.stderr)); assert.deepEqual(await ctx.bytes('out/file'), Array.from(binary));
});

for (const [name, limits, command, args, archive] of [
  ['input bytes', { maxInputBytes: 24 }, 'tar', ['-xf', 'archive', '-C', 'out'], tarFixture([{ name: 'first', data: binary }])],
  ['retained bytes', { maxRetainedBytes: 32 }, 'unzip', ['archive', '-d', 'out'], zipFixture([{ name: 'first', data: binary, method: 8 }])],
  ['entry count', { maxFiles: 1 }, 'tar', ['-xf', 'archive', '-C', 'out'], tarFixture([{ name: 'first', data: '' }, { name: 'second', data: '' }])],
  ['path bytes', { maxPathBytes: 4 }, 'unzip', ['archive', '-d', 'out'], zipFixture([{ name: 'too-long-name', data: '' }])],
  ['step count', { maxSteps: 1 }, 'tar', ['-xf', 'archive', '-C', 'out'], tarFixture([{ name: 'first', data: binary }])],
]) test(`archive ${name} bound rejects before extraction effects`, async () => {
  const ctx = fresh(), run = bounded(ctx, limits); await seed(ctx, { archive }); await ctx.fs.mkdir('out');
  limited(await run(command, args)); await absent(ctx, 'out/first', 'out/second', 'out/too-long-name'); assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('generated gzip output obeys output limits before creating a file', async () => {
  const ctx = fresh(), run = bounded(ctx, { maxOutputBytes: 12 }); await seed(ctx, { source: binary });
  limited(await run('gzip', ['-k', 'source'])); await absent(ctx, 'source.gz'); assert.deepEqual(await ctx.bytes('source'), Array.from(binary));
});

test('archive traversal and parsing yield to Stop with bounded work', { timeout: 4000 }, async () => {
  const ctx = fresh(), controller = new AbortController(), run = bounded(ctx, { yieldEvery: 1 }, () => controller.signal);
  await seed(ctx, { archive: gzipSync(new Uint8Array(1024 * 1024).fill(65)) });
  const active = run('gunzip', ['-kc', 'archive']); setTimeout(() => controller.abort(), 0);
  const result = await active; assert.equal(result.code, 130); assert.deepEqual(bytesOf(result.stdout), []); assert.deepEqual(ctx.face.pendingProposals(), []);
});

for (const limits of [{ maxExpandedBytes: -1 }, { maxFiles: 1.5 }, { maxInputBytes: Infinity }, { maxPathBytes: NaN }, { maxSteps: -1 }]) test(`invalid archive limits reject explicitly: ${JSON.stringify(limits)}`, async () => {
  const ctx = fresh(); let result;
  try { result = await bounded(ctx, limits)('zcat', [], gzipSync('hello')); }
  catch (error) { result = { code: 2, stderr: error.message }; }
  failed(result); assert.match(decode(result.stderr), /invalid|integer|limit/i);
});
