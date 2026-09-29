import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, seed, absent, decode } from './u3-harness.mjs';
import { tarFixture } from './u4a-archive-fixtures.mjs';

// Native bsdtar 3.5.3 accepts all-excluded selections when the operand exists.
// GNU tar 1.35 list.c tests name_match before excluded_name.
for (const [pattern, operand] of [['src/**', 'src'], ['src/file', 'src/file'], ['src', 'src']]) {
  test(`tar exclusion accepts a present operand with no remaining members: ${pattern} ${operand}`, async () => {
    const ctx = fresh(); await seed(ctx, { archive: tarFixture([{ name: 'src/file', data: 'SOURCE' }]), keep: 'UNCHANGED' });
    const result = await ctx.run(`tar -xf archive --exclude='${pattern}' ${operand}`);
    assert.equal(result.code, 0, result.output); assert.equal(decode(result.stdout), ''); assert.equal(decode(result.stderr), '');
    await absent(ctx, 'src', 'src/file'); assert.equal(await ctx.read('keep'), 'UNCHANGED'); assert.deepEqual(ctx.face.pendingProposals(), []);
  });
}

test('tar exclusion still rejects a genuinely absent operand', async () => {
  const ctx = fresh(); await seed(ctx, { archive: tarFixture([{ name: 'src/file', data: 'SOURCE' }]) });
  const result = await ctx.run("tar -xf archive --exclude='src/**' missing");
  assert.notEqual(result.code, 0); assert.match(decode(result.stderr), /not found|missing/i);
  await absent(ctx, 'src', 'missing'); assert.deepEqual(ctx.face.pendingProposals(), []);
});
