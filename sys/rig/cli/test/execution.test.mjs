// U0 coroutine lifecycle: confirmations, Stop, reset, and sequential feed ownership.
// Run: node sys/rig/cli/test/execution.test.mjs
import assert from 'node:assert/strict';
import { createExecution, ShellInterrupted, ShellRefused } from '../execution.mjs';
import { createShell } from '../shell.mjs';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';

let passed = 0;
const failures = [];
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('lifecycle operation did not settle')), 2000); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function test(name, fn) {
  try { await bounded(fn()); passed++; }
  catch (error) { failures.push({ name, message: error.message }); }
}
function launch(execution, work) {
  return (async () => {
    try { return { result: await work() }; }
    catch (error) { execution.write(error.message); return { error }; }
    finally { execution.finish(); }
  })();
}
function governed({ signal = null, beforeInvoke = null } = {}) {
  const fs = createFileops({ backend: new MemoryBackend() });
  const registry = buildRigRegistry({ fs });
  const face = createAgentFace({
    registry,
    grant: createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] }),
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }),
  });
  const wrapped = beforeInvoke ? { ...face, invoke: async (name, input) => {
    await beforeInvoke(name, input);
    return face.invoke(name, input);
  } } : face;
  return { fs, face, shell: createShell({ registry, face: wrapped, signal }) };
}

await test('a confirmation suspends its caller until the answer arrives', async () => {
  const accepted = [], rejected = [];
  const execution = createExecution({ face: {
    invoke: async () => ({ ok: false, staged: true, proposalId: 'p1' }),
    accept: async (id) => { accepted.push(id); return { ok: true, path: 'file' }; },
    reject: (id) => rejected.push(id),
  } });
  let continued = false;
  const work = launch(execution, async () => {
    const result = await execution.invoke('fs.remove', { path: 'file' });
    continued = true;
    execution.write('after removal');
    return result;
  });
  assert.equal((await execution.next()).awaitingConfirm, 'p1');
  assert.equal(execution.pending, 'p1');
  assert.equal(continued, false);
  assert.deepEqual(accepted, []);
  execution.answer(true);
  const event = await execution.next();
  assert.equal(event.output, 'after removal');
  assert.deepEqual(event.confirmation, { verb: 'fs.remove', accepted: true, ok: true });
  assert.deepEqual((await work).result, { ok: true, path: 'file' });
  assert.deepEqual(accepted, ['p1']);
  assert.deepEqual(rejected, ['p1']);
  assert.equal(execution.pending, null);
});

await test('refusal rejects every proposal and never resumes the destructive continuation', async () => {
  const rejected = [];
  let accepts = 0, continued = false;
  const execution = createExecution({ face: {
    accept: async () => { accepts++; return { ok: true }; },
    reject: (id) => rejected.push(id),
  } });
  const work = launch(execution, async () => {
    await execution.confirm([{ proposalId: 'a' }, { proposalId: 'b' }], 'rm batch');
    continued = true;
  });
  await execution.next();
  execution.answer(false);
  const event = await execution.next();
  assert.equal(event.output, 'cancelled: rm batch');
  assert.deepEqual(event.confirmation, { verb: 'rm batch', accepted: false, ok: false });
  assert.ok((await work).error instanceof ShellRefused);
  assert.equal(accepts, 0);
  assert.equal(continued, false);
  assert.deepEqual(rejected, ['a', 'b']);
});

await test('successive prompts report the previous confirmation once', async () => {
  const execution = createExecution({ face: {
    accept: async () => ({ ok: true }), reject: () => {},
  } });
  const work = launch(execution, async () => {
    await execution.confirm([{ proposalId: 'a' }], 'first');
    execution.write('between');
    await execution.confirm([{ proposalId: 'b' }], 'second');
    execution.write('done');
  });
  assert.equal((await execution.next()).awaitingConfirm, 'a');
  execution.answer(true);
  const second = await execution.next();
  assert.equal(second.awaitingConfirm, 'b');
  assert.equal(second.output, 'between\nsecond is destructive. confirm? [y/N]');
  assert.equal(second.confirmation.verb, 'first');
  execution.answer(true);
  const final = await execution.next();
  assert.equal(final.output, 'done');
  assert.equal(final.confirmation.verb, 'second');
  await work;
  assert.deepEqual(await execution.next(), { output: '' });
  assert.deepEqual(await execution.next(), { output: '' });
});

await test('Stop while staged rejects proposals and abandons the continuation', async () => {
  const controller = new AbortController();
  const rejected = [];
  let continued = false;
  const execution = createExecution({ signal: controller.signal, face: {
    accept: async () => { throw new Error('must not accept'); },
    reject: (id) => rejected.push(id),
  } });
  const work = launch(execution, async () => {
    await execution.confirm([{ proposalId: 'a' }, { proposalId: 'b' }], 'remove');
    continued = true;
  });
  await execution.next();
  controller.abort();
  assert.equal(execution.pending, null);
  assert.equal((await execution.next()).output, 'shell: interrupted');
  assert.ok((await work).error instanceof ShellInterrupted);
  assert.equal(continued, false);
  assert.ok(rejected.includes('a') && rejected.includes('b'));
});

await test('Stop during invoke rejects a proposal returned after cancellation', async () => {
  const controller = new AbortController();
  const started = deferred(), release = deferred();
  const rejected = [];
  const execution = createExecution({ signal: controller.signal, face: {
    invoke: async () => { started.resolve(); await release.promise; return { staged: true, proposalId: 'late' }; },
    reject: (id) => rejected.push(id),
  } });
  const work = launch(execution, () => execution.invoke('fs.remove', { path: 'late' }));
  await started.promise;
  controller.abort();
  release.resolve();
  assert.equal((await execution.next()).output, 'shell: interrupted');
  assert.ok((await work).error instanceof ShellInterrupted);
  assert.deepEqual(rejected, ['late']);
  assert.equal(execution.pending, null);
});

await test('Stop during async accept prevents the command continuation after that accept', async () => {
  const controller = new AbortController();
  const started = deferred(), release = deferred();
  const accepted = [], rejected = [];
  let continued = false;
  const execution = createExecution({ signal: controller.signal, face: {
    accept: async (id) => { accepted.push(id); started.resolve(); await release.promise; return { ok: true }; },
    reject: (id) => rejected.push(id),
  } });
  const work = launch(execution, async () => {
    await execution.confirm([{ proposalId: 'in-flight' }], 'remove');
    continued = true;
  });
  await execution.next();
  execution.answer(true);
  await started.promise;
  controller.abort();
  release.resolve();
  const event = await execution.next();
  assert.equal(event.output, 'shell: interrupted');
  assert.ok((await work).error instanceof ShellInterrupted);
  assert.equal(continued, false);
  assert.deepEqual(accepted, ['in-flight']);
  assert.deepEqual(rejected, ['in-flight']);
});

await test('an already-aborted execution never invokes the face', async () => {
  const controller = new AbortController();
  controller.abort();
  let invoked = false;
  const execution = createExecution({ signal: controller.signal, face: {
    invoke: async () => { invoked = true; return { ok: true }; }, reject: () => {},
  } });
  await assert.rejects(execution.invoke('fs.write', {}), ShellInterrupted);
  assert.equal(invoked, false);
  execution.finish();
  assert.deepEqual(await execution.next(), { output: '' });
});

await test('a failed accept remains failed in confirmation metadata', async () => {
  const execution = createExecution({ face: {
    accept: async () => ({ ok: false, code: 'EGRANT', message: 'revoked' }), reject: () => {},
  } });
  const work = launch(execution, () => execution.confirm([{ proposalId: 'denied' }], 'remove'));
  await execution.next();
  execution.answer(true);
  assert.deepEqual((await execution.next()).confirmation, { verb: 'remove', accepted: true, ok: false });
  assert.equal((await work).result[0].code, 'EGRANT');
});

await test('cancel after completion is bounded and the next feed runs independently', async () => {
  const { shell } = governed();
  assert.equal((await shell.feed('echo done')).output, 'done');
  await shell.cancel();
  await shell.cancel();
  assert.equal((await shell.feed('echo next')).output, 'next');
  assert.equal(shell.lastCode, 0);
});

await test('cancel while staged rejects the command and its following statements', async () => {
  const { shell, fs, face } = governed();
  await fs.write('keep', 'keep');
  assert.ok((await shell.feed('rm keep; echo bad > after')).awaitingConfirm);
  assert.match((await shell.cancel()).output, /interrupted/);
  assert.equal(shell.lastCode, 130);
  assert.equal(shell.awaitingConfirm, null);
  assert.deepEqual(face.pendingProposals(), []);
  assert.equal((await fs.read('keep', { encoding: 'utf-8' })).data, 'keep');
  assert.equal((await fs.stat('after')).code, 'ENOENT');
  assert.equal((await shell.feed('echo next')).output, 'next');
});

await test('reset rejects a staged old line before the fresh session runs', async () => {
  const { shell, fs, face } = governed();
  await fs.write('keep', 'keep');
  await shell.feed('X=old; rm keep; echo bad > after');
  shell.reset();
  assert.equal((await shell.feed('echo fresh $X')).output, 'fresh ');
  assert.equal(shell.lastCode, 0);
  assert.deepEqual(face.pendingProposals(), []);
  assert.equal((await fs.stat('keep')).ok, true);
  assert.equal((await fs.stat('after')).code, 'ENOENT');
});

await test('concurrent cancel and feed both settle without losing the final event', async () => {
  const started = deferred(), release = deferred();
  const { shell, fs } = governed({ beforeInvoke: async (name, input) => {
    if (name === 'fs.read' && input.path === 'wait') { started.resolve(); await release.promise; }
  } });
  await fs.write('wait', 'wait');
  const feeding = shell.feed('cat wait; echo bad > after');
  await started.promise;
  const cancelling = shell.cancel();
  release.resolve();
  const results = await Promise.all([feeding, cancelling]);
  assert.ok(results.some((result) => /interrupted/.test(result.output)));
  assert.equal(shell.lastCode, 130);
  assert.equal((await fs.stat('after')).code, 'ENOENT');
  assert.equal((await shell.feed('echo next')).output, 'next');
});

await test('overlapping feeds refuse the second call without replacing the first waiter', async () => {
  const started = deferred(), release = deferred();
  const { shell, fs } = governed({ beforeInvoke: async (name, input) => {
    if (name === 'fs.read' && input.path === 'wait') { started.resolve(); await release.promise; }
  } });
  await fs.write('wait', 'first');
  const first = shell.feed('cat wait');
  await started.promise;
  await assert.rejects(shell.feed('echo second'), /feed already in progress/);
  release.resolve();
  assert.equal((await first).output, 'first');
  assert.equal((await shell.feed('echo third')).output, 'third');
});

await test('Stop during an active feed preserves the next command under a fresh signal', async () => {
  let controller = new AbortController();
  const started = deferred(), release = deferred();
  const { shell, fs } = governed({ signal: () => controller.signal, beforeInvoke: async (name, input) => {
    if (name === 'fs.read' && input.path === 'wait') { started.resolve(); await release.promise; }
  } });
  await fs.write('wait', 'wait');
  const active = shell.feed('cat wait; echo bad > after');
  await started.promise;
  controller.abort();
  release.resolve();
  assert.match((await active).output, /interrupted/);
  assert.equal(shell.lastCode, 130);
  controller = new AbortController();
  assert.equal((await shell.feed('echo next')).output, 'next');
  assert.equal((await fs.stat('after')).code, 'ENOENT');
});

await test('reset while a read is in flight leaves the reset session state intact', async () => {
  const started = deferred(), release = deferred();
  const { shell, fs } = governed({ beforeInvoke: async (name, input) => {
    if (name === 'fs.read' && input.path === 'wait') { started.resolve(); await release.promise; }
  } });
  await fs.write('wait', 'old');
  const active = shell.feed('X=old; cat wait | touch after');
  await started.promise;
  shell.reset();
  release.resolve();
  await active;
  assert.equal(shell.lastCode, 0);
  assert.equal((await fs.stat('after')).code, 'ENOENT');
  assert.equal((await shell.feed('echo fresh $X')).output, 'fresh ');
});

if (failures.length) {
  console.error(`execution lifecycle: ${passed} passed, ${failures.length} FAILED`);
  for (const failure of failures) console.error(`  FAIL ${failure.name}: ${failure.message}`);
  process.exit(1);
}
console.log(`U0/execution lifecycle conformance: ${passed}/${passed} passed`);
