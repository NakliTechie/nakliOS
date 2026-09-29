import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, seed, absent, decode, expect } from './u3-harness.mjs';
import { binary, tarFixture } from './u4a-archive-fixtures.mjs';

const okay = async (ctx, command) => { const result = await ctx.run(command); assert.equal(result.code, 0, `${command}: ${result.output}`); return result; };

test('tar creation retains repeated file names in positional -C operand order', async () => {
  const ctx = fresh(); await seed(ctx, { 'left/file': 'LEFT', 'right/file': 'RIGHT' }); await ctx.fs.mkdir('out');
  await okay(ctx, 'tar -cf archive -C left file -C ../right file');
  assert.equal(decode((await okay(ctx, 'tar -tf archive')).stdout), 'file\nfile\n');
  await okay(ctx, 'tar -xf archive -C out'); assert.equal(await ctx.read('out/file'), 'RIGHT');
});

test('tar creation traverses every repeated directory operand and preserves later overwrites', async () => {
  const ctx = fresh(); await seed(ctx, { 'left/file': 'LEFT', 'right/file': 'RIGHT', 'left/left-only': 'LEFT-ONLY', 'right/right-only': 'RIGHT-ONLY' });
  await ctx.fs.mkdir('out'); await okay(ctx, 'tar -cf archive -C left . -C ../right .');
  await okay(ctx, 'tar -xf archive -C out'); assert.equal(await ctx.read('out/file'), 'RIGHT');
  assert.equal(await ctx.read('out/left-only'), 'LEFT-ONLY'); assert.equal(await ctx.read('out/right-only'), 'RIGHT-ONLY');
});

// Explicit B09 contract extension: each extraction selector keeps its active -C.
// macOS bsdtar rejects interleaved extraction options; it is not this case's oracle.
test('tar extraction applies each selected operand to its active directory', async () => {
  const ctx = fresh(); await seed(ctx, { archive: tarFixture([{ name: 'a', data: 'A' }, { name: 'b', data: binary }]) });
  await ctx.fs.mkdir('left'); await ctx.fs.mkdir('right');
  await okay(ctx, 'tar -xf archive -C left a -C ../right b');
  assert.equal(await ctx.read('left/a'), 'A'); assert.deepEqual(await ctx.bytes('right/b'), Array.from(binary));
  await absent(ctx, 'left/b', 'right/a', 'a', 'b'); await expect(ctx, 'pwd', '/\n');
});

test('tar extraction keeps earlier selectors at original cwd despite a later -C', async () => {
  const ctx = fresh(); await seed(ctx, { archive: tarFixture([{ name: 'first', data: 'FIRST' }, { name: 'second', data: 'SECOND' }]) });
  await ctx.fs.mkdir('out'); await okay(ctx, 'tar -xf archive first -C out');
  assert.equal(await ctx.read('first'), 'FIRST'); await absent(ctx, 'out/first', 'second', 'out/second');
});

test('tar preflights every positional extraction directory before any selected member write', async () => {
  const ctx = fresh({ readOnlyPrefixes: ['protected'] });
  await seed(ctx, { archive: tarFixture([{ name: 'a', data: 'A' }, { name: 'b', data: 'B' }]), 'protected/b': 'KEEP' });
  await ctx.fs.mkdir('left');
  const result = await ctx.run('tar -xf archive -C left a -C ../protected b'); assert.notEqual(result.code, 0);
  await absent(ctx, 'left/a'); assert.equal(await ctx.read('protected/b'), 'KEEP'); assert.deepEqual(ctx.face.pendingProposals(), []);
});

for (const sources of ['src/file src/file', 'src src/file']) test(`zip retains native deduplication for overlapping source operands: ${sources}`, async () => {
  const ctx = fresh(); await seed(ctx, { 'src/file': binary }); await okay(ctx, `zip -rq archive.zip ${sources}`);
  await expect(ctx, 'unzip -p archive.zip src/file', binary);
  const listed = decode((await okay(ctx, 'unzip -l archive.zip')).stdout);
  assert.equal(listed.split('\n').filter((line) => /\bsrc\/file$/.test(line)).length, 1);
});
