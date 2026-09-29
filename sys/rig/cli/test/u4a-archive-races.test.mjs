import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, seed, decode } from './u3-harness.mjs';
import { binary, gzipSync, zipFixture } from './u4a-archive-fixtures.mjs';

for (const command of ['gzip source', 'gunzip source.gz']) test(`${command} rejects source replacement before removal approval`, async () => {
  const ctx = fresh(), decompress = command.startsWith('gunzip');
  const source = decompress ? 'source.gz' : 'source';
  const original = decompress ? gzipSync(new Uint8Array(768).fill(65)) : binary;
  const replacement = decompress ? gzipSync(new Uint8Array(768).fill(66)) : new Uint8Array(binary.length).fill(66);
  assert.equal(original.length, replacement.length, 'replacement retains size while changing bytes');
  await seed(ctx, { [source]: original });
  const prompt = await ctx.run(command); assert.ok(prompt.awaitingConfirm, 'source removal remains governed');
  await seed(ctx, { [source]: replacement });
  const result = await ctx.run('y'); assert.notEqual(result.code, 0, 'stale removal approval must not delete replacement bytes');
  assert.notEqual(decode(result.stderr), ''); assert.deepEqual(await ctx.bytes(source), Array.from(replacement));
  assert.deepEqual(ctx.face.pendingProposals(), []);
});

for (const command of ['zip -q archive.zip source', 'zip -dq archive.zip original']) test(`${command} rejects an archive replaced before staged overwrite approval`, async () => {
  const ctx = fresh({ stageWrites: true }), original = zipFixture([{ name: 'original', data: 'ORIGINAL' }]);
  const replacement = zipFixture([{ name: 'concurrent', data: 'CONCURRENT' }]);
  await seed(ctx, { 'archive.zip': original, source: binary });
  assert.ok((await ctx.run(command)).awaitingConfirm);
  await seed(ctx, { 'archive.zip': replacement });
  const result = await ctx.run('y'); assert.notEqual(result.code, 0, 'stale ZIP update must not overwrite a concurrent archive');
  assert.notEqual(decode(result.stderr), ''); assert.deepEqual(await ctx.bytes('archive.zip'), Array.from(replacement));
  assert.deepEqual(ctx.face.pendingProposals(), []);
});
