// Independent additions to the frozen all-command B11 refusal suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, bytesOf, decode } from './u3-harness.mjs';

test('U5 type reports missing operands and refuses unsupported option forms', async () => {
  const ctx = fresh();
  for (const command of ['type', 'type --']) {
    const result = await ctx.run(command); assert.notEqual(result.code, 0);
    assert.deepEqual(bytesOf(result.stdout), []);
    assert.match(decode(result.stderr), /missing|operand|name|required|usage/i);
  }
  for (const option of ['-a', '-t', '--help', '--version', '--unknown']) {
    const result = await ctx.run(`type ${option} curl`); assert.equal(result.code, 2);
    assert.deepEqual(bytesOf(result.stdout), []);
    assert.match(decode(result.stderr), /unsupported|option|flag/i);
  }
  assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('U5 type honors the option terminator before ordinary and flag-shaped names', async () => {
  const ctx = fresh(), found = await ctx.run('type -- curl'); assert.equal(found.code, 0);
  assert.match(decode(found.stdout), /\bcurl\b/); assert.match(decode(found.stdout), /refus|unsupported|unavailable/i);
  assert.deepEqual(bytesOf(found.stderr), []);
  const absent = await ctx.run('type -- --help'); assert.notEqual(absent.code, 0);
  assert.deepEqual(bytesOf(absent.stdout), []); assert.match(decode(absent.stderr), /not found|unknown/i);
  assert.match(decode(absent.stderr), /--help/);
});

test('U5 type retains known stdout and unknown stderr in one mixed invocation', async () => {
  const ctx = fresh(), unknown = 'u5-type-missing-name';
  const result = await ctx.run(`type echo ${unknown} curl`); assert.notEqual(result.code, 0);
  const stdout = decode(result.stdout), stderr = decode(result.stderr);
  assert.match(stdout, /\becho\b/); assert.match(stdout, /\bcurl\b/);
  assert.match(stdout, /refus|unsupported|unavailable/i);
  assert.equal(stdout.includes(unknown), false); assert.ok(stderr.includes(unknown));
  assert.match(stderr, /not found|unknown/i);
  assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('U5 type identifies a function that shadows a refusal and reset restores discovery', async () => {
  const ctx = fresh();
  const definition = await ctx.run("curl() { printf '%s\\n' from-function; }"); assert.equal(definition.code, 0);
  const found = await ctx.run('type curl'); assert.equal(found.code, 0);
  assert.match(decode(found.stdout), /\bcurl\b/); assert.match(decode(found.stdout), /function/i);
  assert.doesNotMatch(decode(found.stdout), /refus|unsupported|unavailable/i);
  assert.deepEqual(bytesOf(found.stderr), []);
  const called = await ctx.run('curl'); assert.equal(called.code, 0);
  assert.deepEqual(bytesOf(called.stdout), bytesOf('from-function\n')); assert.deepEqual(bytesOf(called.stderr), []);
  ctx.shell.reset();
  const reset = await ctx.run('type curl'); assert.equal(reset.code, 0);
  assert.match(decode(reset.stdout), /refus|unsupported|unavailable/i);
  assert.deepEqual(bytesOf(reset.stderr), []); assert.deepEqual(ctx.face.pendingProposals(), []);
});
