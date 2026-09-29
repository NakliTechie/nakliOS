import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, seed, absent, decode } from './u3-harness.mjs';
import { tarFixture } from './u4a-archive-fixtures.mjs';

// GNU tar 1.35 gives each member to its first matching selector. A later
// selector that owns no member fails, even when its pattern matches that member.
// B09 reports this before extraction effects, consistent with its preflight rule.
const files = [{ name: 'a/file', data: 'A-FILE' }, { name: 'a/other', data: 'A-OTHER' }];
for (const [label, command, entries, missing] of [
  ['directory before exact', 'tar -xf archive -C left a -C ../right a/file', files, 'a/file'],
  ['duplicate in same directory', 'tar -xf archive a/file a/file', files, 'a/file'],
  ['duplicate in different directories', 'tar -xf archive -C left a/file -C ../right a/file', files, 'a/file'],
  ['exact before directory with no remaining member', 'tar -xf archive -C left a/file -C ../right a', [files[0]], 'a'],
  ['listing shadowed selector', 'tar -tf archive a a/file', files, 'a/file'],
  ['excluded members still count only for their first selector', "tar -xf archive --exclude='a/**' a a/file", files, 'a/file'],
]) test(`tar refuses a selector shadowed by earlier operands: ${label}`, async () => {
  const ctx = fresh(); await seed(ctx, { archive: tarFixture(entries) }); await ctx.fs.mkdir('left'); await ctx.fs.mkdir('right');
  const result = await ctx.run(command); assert.notEqual(result.code, 0, 'shadowed selector must not claim success');
  assert.match(decode(result.stderr), /not found|unmatched|shadow/i); assert.ok(decode(result.stderr).includes(missing), 'diagnostic identifies the unmatched operand');
  await absent(ctx, 'a', 'left/a', 'right/a'); assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('tar first-match selector ownership keeps exact-first overlapping destinations', async () => {
  const ctx = fresh(); await seed(ctx, { archive: tarFixture(files) }); await ctx.fs.mkdir('left'); await ctx.fs.mkdir('right');
  const result = await ctx.run('tar -xf archive -C left a/file -C ../right a'); assert.equal(result.code, 0, result.output);
  assert.equal(await ctx.read('left/a/file'), 'A-FILE'); assert.equal(await ctx.read('right/a/other'), 'A-OTHER');
  await absent(ctx, 'right/a/file', 'left/a/other');
});

test('tar directory headers satisfy a later selector without changing first-match file placement', async () => {
  const ctx = fresh(); await seed(ctx, { archive: tarFixture([{ name: 'a/', type: '5', data: '' }, files[0]]) });
  await ctx.fs.mkdir('left'); await ctx.fs.mkdir('right');
  const result = await ctx.run('tar -xf archive -C left a/file -C ../right a'); assert.equal(result.code, 0, result.output);
  assert.equal(await ctx.read('left/a/file'), 'A-FILE'); assert.equal((await ctx.fs.stat('right/a')).stat.type, 'dir'); await absent(ctx, 'right/a/file');
});

test('tar excluded members satisfy their owning selector before exclusion removes its output', async () => {
  const ctx = fresh(); await seed(ctx, { archive: tarFixture(files) }); await ctx.fs.mkdir('left'); await ctx.fs.mkdir('right');
  const result = await ctx.run("tar -xf archive --exclude='a/file' -C left a/file -C ../right a"); assert.equal(result.code, 0, result.output);
  await absent(ctx, 'left/a/file', 'right/a/file'); assert.equal(await ctx.read('right/a/other'), 'A-OTHER');
});
