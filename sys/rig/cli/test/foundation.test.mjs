import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createShell } from '../shell.mjs';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { buildRigRegistry, createRegistry } from '../../registry/index.mjs';
import { createAgentFace, createGrant, createOpLog } from '../../agent/index.mjs';

function setup({ git, scopes = ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write'], transform } = {}) {
  const fs = createFileops({ backend: new MemoryBackend() });
  const base = buildRigRegistry({ fs, git });
  const registry = transform ? createRegistry(base.commands.map(transform)) : base;
  const face = createAgentFace({ registry, grant: createGrant({ prefixes: [''], scopes }),
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }) });
  return { fs, face, registry, shell: createShell({ registry, face }) };
}

test('bytes survive cat, pipes, tee, overwrite, append and input redirection', async () => {
  const { fs, shell } = setup();
  const bytes = Uint8Array.of(0, 255, 195, 40, 10, 128);
  await fs.write('binary', bytes);
  assert.equal((await shell.feed('cat binary')).output, '<6 bytes>');
  await shell.feed('cat binary | tee nested/copy > copy');
  for (const path of ['nested/copy', 'copy']) assert.deepEqual((await fs.read(path)).data, bytes);
  await shell.feed('cat < binary > redirected');
  assert.deepEqual((await fs.read('redirected')).data, bytes);
  await shell.feed("printf 'prefix' > appended; cat binary >> appended; printf 'suffix' >> appended");
  assert.deepEqual((await fs.read('appended')).data,
    Uint8Array.from([...new TextEncoder().encode('prefix'), ...bytes, ...new TextEncoder().encode('suffix')]));
  assert.equal((await shell.feed('cat binary | od -An -t x1')).output, ' 00 ff c3 28 0a 80');
  await shell.feed('fs.read binary | cat > dotted');
  assert.deepEqual((await fs.read('dotted')).data, bytes);
});

test('cat redirection preserves UTF-8, BOMs, and files without final newlines', async () => {
  const { fs, shell } = setup();
  const bytes = new TextEncoder().encode('\ufeffhello é');
  await fs.write('text', bytes);
  await shell.feed('cat text > copied');
  assert.deepEqual((await fs.read('copied')).data, bytes);
  await shell.feed('cat text text > twice');
  assert.deepEqual((await fs.read('twice')).data, Uint8Array.from([...bytes, ...bytes]));
});

test('text pipe producers keep their newline semantics through cat and tee', async () => {
  const { fs, shell } = setup();
  await fs.write('raw', 'abc');
  for (const [command, expected] of [
    ['cat raw', 'abc'], ['echo hi', 'hi\n'], ['printf hi', 'hi'],
  ]) {
    await shell.feed(`${command} | tee first > second`);
    for (const path of ['first', 'second']) assert.equal((await fs.read(path, { encoding: 'utf-8' })).data, expected);
    await shell.feed(`${command} | cat > through`);
    assert.equal((await fs.read('through', { encoding: 'utf-8' })).data, expected);
  }
});

test('a nested command resumes its pipeline and statement after confirmation', async () => {
  const { fs, shell, face } = setup();
  await fs.write('a', 'keep until accepted');
  const first = await shell.feed('echo a | xargs rm | echo PIPE; echo AFTER');
  assert.ok(first.awaitingConfirm);
  assert.ok((await fs.stat('a')).ok);
  assert.equal(first.output.includes('PIPE'), false);
  const next = await shell.feed('y');
  assert.equal(next.output, 'PIPE\nAFTER');
  assert.deepEqual(next.confirmation, { verb: 'fs.remove', accepted: true, ok: true });
  assert.equal((await fs.stat('a')).ok, false);
  assert.deepEqual(face.pendingProposals(), []);
});

test('refusing a nested removal stops the pipeline, preserves &&/||, and keeps files', async () => {
  const { fs, shell } = setup();
  await fs.write('a', 'keep');
  await shell.feed('echo a | xargs rm | echo WRONG && echo WRONG_TOO || echo RECOVERED; echo AFTER');
  const next = await shell.feed('n');
  assert.match(next.output, /cancelled:/);
  assert.match(next.output, /RECOVERED\nAFTER$/);
  assert.doesNotMatch(next.output, /WRONG/);
  assert.ok((await fs.stat('a')).ok);
});

test('one command can suspend twice without losing its internal continuation', async () => {
  const calls = [];
  const { fs, shell } = setup({
    git: { add: async ({ filepath }) => { calls.push(`add ${filepath}`); return { ok: true }; },
      remove: async ({ filepath }) => { calls.push(`remove ${filepath}`); return { ok: true }; } },
    transform: (command) => command.name === 'fs.move' ? { ...command, destructive: true } : command,
  });
  await fs.write('before', 'data');
  await shell.feed('git mv before after; echo DONE');
  assert.deepEqual(calls, []);
  assert.ok((await fs.stat('before')).ok);
  const second = await shell.feed('y');
  assert.ok(second.awaitingConfirm);
  assert.deepEqual(calls, ['add after']);
  assert.ok((await fs.stat('after')).ok);
  const last = await shell.feed('yes');
  assert.equal(last.output.endsWith('DONE'), true);
  assert.deepEqual(calls, ['add after', 'remove before']);
});

test('staged redirection resumes after accept and follows failure branches on refusal', async () => {
  const { fs, shell } = setup({ transform: (command) => command.name === 'fs.write'
    ? { ...command, destructive: true } : command });
  const first = await shell.feed('printf bytes > output && echo DONE');
  assert.ok(first.awaitingConfirm);
  assert.equal((await fs.stat('output')).ok, false);
  assert.equal((await shell.feed('y')).output, 'DONE');
  assert.equal((await fs.read('output', { encoding: 'utf-8' })).data, 'bytes');
  await shell.feed('echo no > refused && echo WRONG || echo REFUSED; echo AFTER');
  const refusal = await shell.feed('n');
  assert.match(refusal.output, /REFUSED\nAFTER$/);
  assert.doesNotMatch(refusal.output, /WRONG/);
  assert.equal((await fs.stat('refused')).ok, false);
});

test('xargs does not expand its input a second time', async () => {
  const { fs, shell } = setup();
  await fs.write('$NAME', 'literal');
  assert.equal((await shell.feed("printf '$NAME' | xargs cat")).output, 'literal');
});

test('help names exactly the dispatch table, including registry commands and aliases', async () => {
  const { shell, registry } = setup();
  const help = (await shell.feed('help')).output;
  assert.deepEqual(help.split('\n')[0].slice('commands: '.length).split(' '), shell.commands);
  for (const name of ['help', 'true', 'false', 'py', 'node', 'od', ...registry.commands.map((c) => c.name)]) {
    assert.ok(shell.commands.includes(name), name);
    assert.equal((await shell.feed(`which ${name}`)).output, name);
  }
  for (const name of ['made-up', 'constructor', '__proto__']) {
    assert.match((await shell.feed(name)).output, /command not found/);
    assert.equal(shell.lastCode, 127);
  }
});

test('registry commands use shared flag parsing and retain grant refusals', async () => {
  const { fs, shell } = setup();
  await fs.write('-file', 'content');
  assert.equal((await shell.feed('cat -- -file')).output, 'content');
  await shell.feed('rm -- -file');
  await shell.feed('y');
  assert.equal((await fs.stat('-file')).ok, false);
  await shell.feed('mkdir -p dir/nested');
  assert.ok((await fs.stat('dir/nested')).ok);
  await fs.write('source', 'x');
  await shell.feed('fs.copy --from=source --to=destination');
  assert.equal((await fs.read('destination', { encoding: 'utf-8' })).data, 'x');
  for (const command of ['rm --unknown source', 'cat --unknown source', 'tee --unknown output', 'fs.copy --from']) {
    assert.match((await shell.feed(command)).output, /supports/);
    assert.equal(shell.lastCode, 2);
    assert.equal(shell.awaitingConfirm, null);
  }
  assert.ok((await fs.stat('source')).ok);
  const readOnly = setup({ scopes: ['fs:read'] });
  await readOnly.fs.write('source', Uint8Array.of(0, 255));
  assert.match((await readOnly.shell.feed('cat source | tee out')).output, /not granted/);
  assert.equal(readOnly.shell.lastCode, 1);
  assert.equal((await readOnly.fs.stat('out')).ok, false);
});

test('an already-stopped signal permits diagnostic reads but no mutations or runtime code', async () => {
  const { fs, registry, face } = setup();
  const controller = new AbortController();
  controller.abort();
  let runtimeCalls = 0;
  const shell = createShell({ registry, face, signal: controller.signal,
    kiln: { exec: async () => { runtimeCalls++; return { status: 'ok' }; } } });
  await fs.write('kept', 'value');
  assert.equal((await shell.feed('cat kept')).output, 'value');
  for (const command of ['rm kept', 'echo no > added', 'python -c "print(1)"', 'node -e "1"']) {
    assert.match((await shell.feed(command)).output, /interrupted/);
    assert.equal(shell.lastCode, 130);
  }
  assert.equal(runtimeCalls, 0);
  assert.ok((await fs.stat('kept')).ok);
  assert.equal((await fs.stat('added')).ok, false);
  assert.deepEqual(face.pendingProposals(), []);
});

test('explicit cancel cuts sleep and releases the feed', { timeout: 2000 }, async () => {
  const { fs, shell } = setup();
  const run = shell.feed('sleep 30; echo bad > after');
  // Wait until the command enters sleep, then cancel without an external signal.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await shell.cancel();
  assert.match((await run).output, /interrupted/);
  assert.equal((await fs.stat('after')).ok, false);
  assert.equal((await shell.feed('echo next')).output, 'next');
});

test('Stop between feeds preserves the next command and reports the old interruption', async () => {
  const { fs, registry, face } = setup();
  let controller = new AbortController();
  const shell = createShell({ registry, face, signal: () => controller.signal });
  await fs.write('kept', 'value');
  await shell.feed('rm kept; echo WRONG');
  controller.abort();
  controller = new AbortController();
  const next = await shell.feed('echo NEXT');
  assert.match(next.output, /interrupted/);
  assert.match(next.output, /NEXT$/);
  assert.doesNotMatch(next.output, /WRONG/);
  assert.ok((await fs.stat('kept')).ok);
  assert.equal(shell.lastCode, 0);
  assert.equal((await shell.feed('echo SECOND')).output, 'SECOND');
});

test('a cancelled read completing after reset cannot change the new exit status', { timeout: 2000 }, async () => {
  const { fs, registry, face } = setup();
  let release, started;
  const wait = new Promise((resolve) => { release = resolve; });
  const entering = new Promise((resolve) => { started = resolve; });
  const shell = createShell({ registry, face: { ...face, invoke: async (name, input) => {
    if (name === 'fs.read') { started(); await wait; }
    return face.invoke(name, input);
  } } });
  await fs.write('wait', 'value');
  const read = shell.feed('cat wait');
  await entering;
  const cancellation = shell.cancel();
  shell.reset();
  release();
  await Promise.all([read, cancellation]);
  assert.equal(shell.lastCode, 0);
  assert.equal((await shell.feed('echo NEXT')).output, 'NEXT');
});
