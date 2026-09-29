import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, seed, absent, decode } from './u3-harness.mjs';
import { concat, binary, tarFixture, zipFixture } from './u4a-archive-fixtures.mjs';

function binaryPax(key, value) {
  const body = concat(key + '=', value, '\n'); let length = body.length + 2;
  while (concat(String(length), ' ', body).length !== length) length = concat(String(length), ' ', body).length;
  return concat(String(length), ' ', body);
}

test('native tar opaque PAX xattrs may contain invalid UTF-8 and NUL bytes', async () => {
  const ctx = fresh(); await seed(ctx, { archive: tarFixture([
    { name: 'PaxHeader', type: 'x', data: binaryPax('SCHILY.xattr.com.apple.provenance', Uint8Array.of(1, 2, 0, 0xff, 0xcb, 0x6f)) },
    { name: 'payload', data: binary },
  ]) }); await ctx.fs.mkdir('out');
  const result = await ctx.run('tar -xf archive -C out'); assert.equal(result.code, 0, result.output);
  assert.deepEqual(await ctx.bytes('out/payload'), Array.from(binary));
});

test('PAX controlling path values still reject invalid UTF-8 before any extraction write', async () => {
  const ctx = fresh(); await seed(ctx, { archive: tarFixture([
    { name: 'first', data: 'valid prefix' },
    { name: 'PaxHeader', type: 'x', data: binaryPax('path', Uint8Array.of(0xff)) },
    { name: 'payload', data: binary },
  ]) }); await ctx.fs.mkdir('out');
  const result = await ctx.run('tar -xf archive -C out'); assert.notEqual(result.code, 0); assert.match(decode(result.stderr), /UTF-8|path|PAX/i);
  await absent(ctx, 'out/first', 'out/payload'); assert.deepEqual(ctx.face.pendingProposals(), []);
});

for (const kind of ['tar', 'zip']) for (const changed of ['ancestor-file', 'final-directory']) {
  test(`${kind} staged extraction refuses a destination changed to ${changed}`, async () => {
    const ctx = fresh({ stageWrites: true }), entries = [{ name: 'dir/value', data: binary }];
    await seed(ctx, { archive: kind === 'tar' ? tarFixture(entries) : zipFixture(entries) });
    await ctx.fs.mkdir('out/dir', { createParents: true });
    const command = kind === 'tar' ? 'tar -xf archive -C out' : 'unzip -oq archive -d out';
    assert.ok((await ctx.run(command)).awaitingConfirm);
    if (changed === 'ancestor-file') {
      ctx.backend.dirs.delete('out/dir'); await ctx.backend.write('out/dir', new TextEncoder().encode('raced file'));
    } else await ctx.backend.mkdir('out/dir/value');
    const result = await ctx.run('y'); assert.notEqual(result.code, 0); assert.notEqual(decode(result.stderr), '');
    assert.equal(ctx.backend.files.has('out/dir/value'), false, 'no file bytes replace or descend through the raced destination');
    if (changed === 'ancestor-file') assert.equal(await ctx.read('out/dir'), 'raced file');
    else assert.equal((await ctx.fs.stat('out/dir/value')).stat.type, 'dir');
    assert.deepEqual(ctx.face.pendingProposals(), []);
  });
}
