import test from 'node:test';
import assert from 'node:assert/strict';
import { createIO } from '../io.mjs';
import { createDataCommands } from '../cmds/data.mjs';
import { fresh, seed, expect, absent, deferred, delay, decode, bytesOf } from './u3-harness.mjs';

function bounded(ctx, limits = {}, { environment = new Map(), signal = () => null, cwd = () => '' } = {}) {
  const io = createIO({ invoke: (name, input) => ctx.face.invoke(name, input), cwd });
  const commands = createDataCommands(io, { limits, signal, cwd, environment: () => environment,
    authorize: (name, input) => ctx.face.check(name, input) });
  return async (name, argv, stdin = '') => {
    try { return await commands[name](argv, stdin); }
    catch (error) { return { code: typeof error.code === 'number' ? error.code : 2, stdout: '', stderr: error.message }; }
  };
}
function failed(result) {
  assert.notEqual(result.code, 0); assert.notEqual(decode(result.stderr), '', 'refusal needs a diagnostic');
}
function limited(result) {
  failed(result); assert.match(decode(result.stderr), /limit|budget|exceed|large|bound|depth/i); assert.deepEqual(bytesOf(result.stdout), []);
}

for (const command of ['jq . secret/input', 'yq . secret/input', 'envsubst < secret/input', "fd '' secret"]) {
  test(`data command denies source grants before backend access: ${command}`, async () => {
    const ctx = fresh({ prefixes: ['allowed'] }); await seed(ctx, { 'secret/input': '{"secret":1}', 'allowed/value': 'allowed' });
    const operations = [];
    for (const method of ['readBinary', 'list', 'stat']) {
      const original = ctx.backend[method].bind(ctx.backend);
      ctx.backend[method] = async (...args) => { operations.push([method, args[0]]); return original(...args); };
    }
    failed(await ctx.run(command)); assert.deepEqual(operations, []); assert.deepEqual(ctx.face.pendingProposals(), []);
  });
}

test('jq and yq null-input skip file reads even when the source grant is denied', async () => {
  const ctx = fresh({ prefixes: ['allowed'] }); await seed(ctx, { 'secret/input': 'invalid input' });
  const reads = [], original = ctx.backend.readBinary.bind(ctx.backend);
  ctx.backend.readBinary = async (...args) => { reads.push(args[0]); return original(...args); };
  await expect(ctx, 'jq -cn . secret/input', 'null\n');
  await expect(ctx, 'yq -jcn . secret/input', 'null\n');
  assert.deepEqual(reads, []);
});

test('data output redirects retain governed staging and refusal', async () => {
  const ctx = fresh({ stageWrites: true }); await seed(ctx, { input: '{"a":1}', output: 'keep' });
  const prompt = await ctx.run('jq -c . input > output'); assert.ok(prompt.awaitingConfirm);
  assert.equal(await ctx.read('output'), 'keep'); failed(await ctx.run('n')); assert.equal(await ctx.read('output'), 'keep');
  assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.ok((await ctx.run('jq -c . input > output')).awaitingConfirm); assert.equal((await ctx.run('y')).code, 0);
  assert.equal(await ctx.read('output'), '{"a":1}\n');
});

test('data output redirects refuse read-only destinations', async () => {
  const ctx = fresh({ readOnlyPrefixes: ['protected'] }); await seed(ctx, { input: '{"a":1}', 'protected/output': 'keep' });
  failed(await ctx.run('jq -c . input > protected/output'));
  assert.equal(await ctx.read('protected/output'), 'keep'); assert.deepEqual(ctx.face.pendingProposals(), []);
});

for (const command of ['jq -c . blocked; touch forbidden', 'yq -jc . blocked; touch forbidden', "fd '' tree; touch forbidden"]) {
  test(`Stop drains owned data I/O before refusing subsequent effects: ${command}`, { timeout: 4000 }, async () => {
    const entered = deferred(), release = deferred(); let waiting = false;
    const ctx = fresh({ beforeOperation: async (name, input) => {
      if (!waiting && (name === 'fs.read' && input.path === 'blocked' || name === 'fs.list' && input.path === 'tree')) {
        waiting = true; entered.resolve(); await release.promise;
      }
    } });
    await seed(ctx, { blocked: '{"a":1}', 'tree/value': '' });
    const active = ctx.run(command); await entered.promise;
    let finished = false; const stopping = ctx.shell.cancel().then(() => { finished = true; });
    await delay(10); assert.equal(finished, false); release.resolve(); await Promise.all([active, stopping]);
    assert.equal(ctx.shell.lastCode, 130); await absent(ctx, 'forbidden'); assert.deepEqual(ctx.face.pendingProposals(), []);
    await expect(ctx, 'echo recovered', 'recovered\n');
  });
}

test('Stop rejects a staged data result without carrying stale state into the next command', async () => {
  const ctx = fresh({ stageWrites: true }); await seed(ctx, { input: '[1,2]' });
  assert.ok((await ctx.run('jq -c . input > output')).awaitingConfirm);
  await ctx.shell.cancel(); assert.equal(ctx.shell.lastCode, 130); await absent(ctx, 'output');
  assert.deepEqual(ctx.face.pendingProposals(), []); await expect(ctx, 'jq -cn 9', '9\n');
});

test('fd skips symlink descendants without reading their targets', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/local': '', 'protected/secret': '' });
  ctx.backend.symlink('tree/link', '../protected'); ctx.backend.symlink('tree/broken', '../missing');
  const listed = [], original = ctx.backend.list.bind(ctx.backend);
  ctx.backend.list = async (...args) => { listed.push(args[0]); return original(...args); };
  const result = await ctx.run("fd '' tree -u"); assert.equal(result.code, 0, decode(result.stderr));
  assert.deepEqual(decode(result.stdout).split('\n').filter(Boolean).sort(), ['tree/broken', 'tree/link', 'tree/local']);
  assert.ok(listed.every((path) => path === 'tree')); assert.equal(decode(result.stdout).includes('secret'), false);
});

test('fd prunes ignored directories before their metadata traversal', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/.ignore': 'hidden/\n', 'tree/hidden/secret': '', 'tree/visible': '' });
  const listed = [], original = ctx.backend.list.bind(ctx.backend);
  ctx.backend.list = async (...args) => { listed.push(args[0]); return original(...args); };
  await expect(ctx, "fd '' tree -t f", 'tree/visible\n');
  assert.equal(listed.includes('tree/hidden'), false);
});

test('fd never follows an ignore-file symlink into a protected target', async () => {
  const ctx = fresh({ prefixes: ['tree'] }); await seed(ctx, { 'tree/visible': '', 'protected/rules': 'visible\n' });
  ctx.backend.symlink('tree/.ignore', '../protected/rules');
  const reads = [], original = ctx.backend.readBinary.bind(ctx.backend);
  ctx.backend.readBinary = async (...args) => { reads.push(args[0]); return original(...args); };
  const result = await ctx.run("fd '' tree -t f");
  assert.equal(reads.some((path) => path === 'protected/rules'), false);
  assert.equal(reads.includes('tree/.ignore'), false, 'ignore symlinks must be rejected before backend reading');
  if (result.code === 0) assert.equal(decode(result.stdout), 'tree/visible\n');
  else assert.notEqual(decode(result.stderr), '');
});

test('fd refuses an explicit parent ignore denial without exposing its contents', async () => {
  const ctx = fresh({ prefixes: ['allowed'] }); await seed(ctx, { '.ignore': 'allowed/value\n', 'allowed/value': '', 'secret/value': '' });
  const reads = [], original = ctx.backend.readBinary.bind(ctx.backend);
  ctx.backend.readBinary = async (...args) => { reads.push(args[0]); return original(...args); };
  const result = await ctx.run("fd '' allowed -t f");
  assert.equal(reads.includes('.ignore'), false); assert.equal(reads.some((path) => path.startsWith('secret/')), false);
  failed(result); assert.deepEqual(bytesOf(result.stdout), []);
});

for (const [name, limits, command, argv, stdin] of [
  ['JSON input bytes', { maxInputBytes: 8 }, 'jq', ['-c', '.'], '{"value":123}'],
  ['YAML input bytes', { maxInputBytes: 8 }, 'yq', ['-jc', '.'], 'value: 123456789\n'],
  ['filter bytes', { maxFilterBytes: 4 }, 'jq', ['.longname'], '{}'],
  ['parse depth', { maxDepth: 3 }, 'jq', ['.'], '[[[[[[1]]]]]]'],
  ['filter depth', { maxDepth: 3 }, 'jq', ['((((((.))))))'], '1'],
  ['value count', { maxValues: 3 }, 'jq', ['.'], '[1,2,3,4,5]'],
  ['generator result count', { maxResults: 2 }, 'jq', ['.[]'], '[1,2,3]'],
  ['serialized output bytes', { maxOutputBytes: 4 }, 'jq', ['-c', '.'], '"abcdefgh"'],
  ['retained bytes', { maxRetainedBytes: 8 }, 'jq', ['-s', '.'], '"abcdefghijk"'],
  ['evaluation steps', { maxSteps: 1 }, 'jq', ['[.[],.[]]'], '[1,2,3]'],
  ['substitution output bytes', { maxOutputBytes: 8 }, 'envsubst', [], '$LONG$LONG'],
  ['substitution input bytes', { maxInputBytes: 4 }, 'envsubst', [], '12345'],
]) test(`data commands enforce bounded ${name}`, async () => {
  const ctx = fresh(), run = bounded(ctx, limits, { environment: new Map([['LONG', '0123456789']]) });
  limited(await run(command, argv, stdin)); assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('jq and yq noinput bypass unused stdin byte budgets', async () => {
  const ctx = fresh(), run = bounded(ctx, { maxInputBytes: 1 });
  for (const name of ['jq', 'yq']) {
    const result = await run(name, name === 'yq' ? ['-jcn', '1'] : ['-cn', '1'], 'X'.repeat(1024));
    assert.equal(result.code, 0, decode(result.stderr)); assert.equal(decode(result.stdout), '1\n');
  }
});

test('envsubst variables mode bypasses unused stdin byte budgets', async () => {
  const result = await bounded(fresh(), { maxInputBytes: 1 })('envsubst', ['-v', '$A'], 'X'.repeat(1024));
  assert.equal(result.code, 0, decode(result.stderr)); assert.equal(decode(result.stdout), 'A\n');
});

test('envsubst output limits count replacement UTF-8 bytes', async () => {
  const result = await bounded(fresh(), { maxOutputBytes: 3 }, { environment: new Map([['A', 'éé']]) })('envsubst', [], '$A');
  limited(result);
});

test('YAML alias expansion consumes a retained value budget', async () => {
  const source = 'a: &a ["abcdefgh", "abcdefgh"]\nb: &b [*a, *a, *a, *a]\nc: [*b, *b, *b, *b]\n';
  const result = await bounded(fresh(), { maxRetainedBytes: 100, maxValues: 100 })('yq', ['-jc', '.'], source);
  limited(result);
});

for (const [name, limits, entries, argv] of [
  ['entry count', { maxFiles: 2 }, { 'tree/a': '', 'tree/b': '', 'tree/c': '' }, ['', 'tree', '-I']],
  ['path bytes', { maxPathBytes: 8 }, { 'tree/long-filename': '' }, ['', 'tree', '-I']],
  ['ignore bytes', { maxInputBytes: 8 }, { 'tree/.ignore': 'long-file-name-to-ignore\n', 'tree/value': '' }, ['', 'tree']],
  ['output bytes', { maxOutputBytes: 4 }, { 'tree/value': '' }, ['', 'tree', '-I']],
  ['steps', { maxSteps: 1 }, { 'tree/sub/value': '' }, ['', 'tree', '-I']],
]) test(`fd enforces its ${name} bound`, async () => {
  const ctx = fresh(); await seed(ctx, entries); limited(await bounded(ctx, limits)('fd', argv));
});

for (const limits of [{ maxInputBytes: -1 }, { maxOutputBytes: 1.5 }, { maxDepth: Infinity }, { maxSteps: NaN }]) {
  test(`data commands reject invalid limit configuration: ${JSON.stringify(limits)}`, async () => {
    let result;
    try { result = await bounded(fresh(), limits)('jq', ['-cn', '.']); }
    catch (error) { result = { code: 2, stdout: '', stderr: error.message }; }
    failed(result); assert.match(decode(result.stderr), /invalid|integer|limit/i);
  });
}

test('data commands observe an already-aborted invocation before producing output', async () => {
  const controller = new AbortController(); controller.abort(); const ctx = fresh();
  await seed(ctx, { 'tree/value': '' }); const run = bounded(ctx, {}, { signal: () => controller.signal });
  for (const [name, argv, stdin] of [['jq', ['-cn', '1'], ''], ['yq', ['-jcn', '1'], ''], ['envsubst', [], 'value'], ['fd', ['', 'tree'], '']]) {
    const result = await run(name, argv, stdin); assert.equal(result.code, 130, `${name}: ${decode(result.stderr)}`); assert.deepEqual(bytesOf(result.stdout), []);
  }
});

test('jq evaluation yields so asynchronous Stop can interrupt generated work', { timeout: 4000 }, async () => {
  const controller = new AbortController();
  const run = bounded(fresh(), { yieldEvery: 1, maxValues: 1000000, maxResults: 1000000 }, { signal: () => controller.signal });
  const active = run('jq', ['-c', '.[] | (., ., ., .)'], JSON.stringify(Array.from({ length: 20000 }, (_, i) => i)));
  setTimeout(() => controller.abort(), 0);
  const result = await active; assert.equal(result.code, 130, decode(result.stderr)); assert.deepEqual(bytesOf(result.stdout), []);
});

test('envsubst byte scanning yields so asynchronous Stop can interrupt it', { timeout: 4000 }, async () => {
  const controller = new AbortController();
  const run = bounded(fresh(), { yieldEvery: 1, maxSteps: 4000000 }, { signal: () => controller.signal });
  const active = run('envsubst', [], new Uint8Array(1024 * 1024).fill(65)); setTimeout(() => controller.abort(), 0);
  const result = await active; assert.equal(result.code, 130, decode(result.stderr)); assert.deepEqual(bytesOf(result.stdout), []);
});
