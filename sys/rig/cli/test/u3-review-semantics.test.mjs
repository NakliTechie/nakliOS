import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, expect, absent, decode } from './u3-harness.mjs';

// Independent adjudication of B08 review findings3–5 only.
for (const [name, command] of [
  ['terminal', "seq 32 | xargs -I{} printf '%128s' '{}'; touch forbidden"],
  ['pipe', "seq 32 | xargs -I{} printf '%128s' '{}' | wc -c; touch forbidden"],
  ['substitution', "value=$(seq 32 | xargs -I{} printf '%128s' '{}'); touch forbidden"],
]) test(`nested xargs output shares the invocation limit before aggregation: ${name}`, async () => {
  let nestedPrints = 0;
  const ctx = fresh({ languageLimits: { maxOutputBytes: 1024 }, beforeCommand: async (argv) => {
    if (argv[0] === 'printf' && argv[1] === '%128s') nestedPrints++;
  } });
  const result = await ctx.run(command);
  assert.notEqual(result.code, 0, command);
  assert.match(decode(result.stderr), /output bytes exceed.*limit/i, command);
  assert.ok(nestedPrints > 0 && nestedPrints <= 9, `cap must stop aggregation early; observed ${nestedPrints} of32 nested calls`);
  assert.ok(new TextEncoder().encode(decode(result.stdout)).length <= 1024);
  await absent(ctx, 'forbidden');
  await expect(ctx, 'printf recovery', 'recovery');
});

test('xargs control produces all nested output when the shared byte limit permits it', async () => {
  let nestedPrints = 0;
  const ctx = fresh({ languageLimits: { maxOutputBytes: 16384 }, beforeCommand: async (argv) => {
    if (argv[0] === 'printf' && argv[1] === '%128s') nestedPrints++;
  } });
  const result = await ctx.run("seq 32 | xargs -I{} printf '%128s' '{}'");
  assert.equal(result.code, 0); assert.equal(decode(result.stdout).length, 4096); assert.equal(nestedPrints, 32);
});

for (const [command, expected] of [
  ['false | echo "$?"', '0\n'],
  ['false; true | echo "$?"', '1\n'],
  ['false; true | false | echo "$?"', '1\n'],
  ["true; false | printf '%s\\n' \"$?\"; printf 'after=%s\\n' \"$?\"", '0\nafter=0\n'],
  ['false | { printf "%s" "$?"; }', '0'],
]) test(`pipeline status expansion retains the pre-pipeline status: ${command}`, async () => {
  await expect(fresh(), command, expected);
});

test('function definition redirects execute on calls and reset truncating offsets on every invocation', async () => {
  const ctx = fresh(); await expect(ctx, 'f(){ printf "%s" "$1"; } > out', ''); await absent(ctx, 'out');
  await expect(ctx, 'f long-body', ''); assert.equal(await ctx.read('out'), 'long-body');
  await expect(ctx, 'f x', ''); assert.equal(await ctx.read('out'), 'x');
  await expect(ctx, 'printf terminal', 'terminal');
});

test('function definition redirects preserve append and call-time filename expansion', async () => {
  const ctx = fresh();
  await expect(ctx, 'target=first; f(){ printf "%s" "$1"; } >> "$target"', ''); await absent(ctx, 'first', 'second');
  await expect(ctx, 'f a; f b; target=second; f c', '');
  assert.equal(await ctx.read('first'), 'ab'); assert.equal(await ctx.read('second'), 'c');
});

test('function-body redirects retain separate output descriptors through copied pipeline scopes', async () => {
  const ctx = fresh();
  await expect(ctx, 'f(){ printf out; printf err >&2; } > output 2> errors; f | cat', '');
  assert.equal(await ctx.read('output'), 'out'); assert.equal(await ctx.read('errors'), 'err');
  await expect(ctx, 'f', ''); assert.equal(await ctx.read('output'), 'out'); assert.equal(await ctx.read('errors'), 'err');
});
