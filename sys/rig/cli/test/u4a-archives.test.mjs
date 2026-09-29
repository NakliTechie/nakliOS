import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { fresh, seed, expect, absent, accept, bytesOf, decode } from './u3-harness.mjs';
import { binary, concat, tarFixture, tarHeader, repairTarChecksum, paxRecord, zipFixture, gzipSync, gzipWithMetadata, constants, view } from './u4a-archive-fixtures.mjs';

// Assertions were written before the completed-build verification release.
const okay = async (ctx, command) => { const result = await ctx.run(command); assert.equal(result.code, 0, `${command}: ${result.output}`); return result; };
const refused = async (ctx, command) => { const result = await ctx.run(command); assert.notEqual(result.code, 0, command); assert.notEqual(decode(result.stderr), '', `${command}: diagnostic`); return result; };
const names = (result) => decode(result.stdout).trim().split('\n').filter(Boolean).map((name) => name.replace(/^\.\//, '')).sort();

test('archive commands are discoverable through public shell dispatch', () => {
  const ctx = fresh(); for (const name of ['tar', 'gzip', 'gunzip', 'zcat', 'zip', 'unzip']) assert.ok(ctx.shell.commands.includes(name), name);
});

test('tar preserves binary files, empty files, directories and spaces through public create/list/extract', async () => {
  const ctx = fresh(); await seed(ctx, { 'source/a.bin': binary, 'source/empty': '', 'source/with space': 'text\n' }); await ctx.fs.mkdir('source/empty-dir');
  await okay(ctx, 'tar -cf bundle.tar source');
  const listed = names(await okay(ctx, 'tar -tf bundle.tar'));
  assert.deepEqual(listed, ['source/', 'source/a.bin', 'source/empty', 'source/empty-dir/', 'source/with space']);
  await ctx.fs.mkdir('out'); await okay(ctx, 'tar -xf bundle.tar -C out');
  assert.deepEqual(await ctx.bytes('out/source/a.bin'), Array.from(binary)); assert.deepEqual(await ctx.bytes('out/source/empty'), []);
  assert.equal(await ctx.read('out/source/with space'), 'text\n'); assert.equal((await ctx.fs.stat('out/source/empty-dir')).stat.type, 'dir');
});

test('tar traditional bundles, gzip transforms, pipes and redirects preserve bytes', async () => {
  const ctx = fresh(); await seed(ctx, { 'source/data': binary }); await ctx.fs.mkdir('out');
  await okay(ctx, 'tar czf - source | gunzip | gzip -c > bundle.tgz');
  assert.deepEqual(names(await okay(ctx, 'tar tzf bundle.tgz')), ['source/', 'source/data']);
  await okay(ctx, 'cat bundle.tgz | tar xzf - -C out'); assert.deepEqual(await ctx.bytes('out/source/data'), Array.from(binary));
});

test('tar -C applies in operand order and archive filenames remain relative to original cwd', async () => {
  const ctx = fresh(); await seed(ctx, { 'work/left/a': 'A', 'work/right/b': 'B' });
  await okay(ctx, 'cd work'); await okay(ctx, 'tar -cf bundle.tar -C left a -C ../right b');
  assert.deepEqual(names(await okay(ctx, 'tar -tf bundle.tar')), ['a', 'b']);
  await expect(ctx, 'pwd', '/work\n'); await absent(ctx, 'work/left/bundle.tar', 'work/right/bundle.tar');
  await ctx.fs.mkdir('work/out'); await okay(ctx, 'tar -xf bundle.tar -C out'); assert.equal(await ctx.read('work/out/a'), 'A'); assert.equal(await ctx.read('work/out/b'), 'B');
});

test('tar exclusion patterns, selected operands, strip-components and verbose listing compose', async () => {
  const ctx = fresh(); await seed(ctx, { 'src/keep/a': binary, 'src/keep/b.tmp': 'omit', 'src/other': 'other' });
  await okay(ctx, "tar -cvf a.tar --exclude='*.tmp' src");
  const listing = await okay(ctx, 'tar -tvf a.tar'); assert.match(decode(listing.stdout), /src\/keep\/a/); assert.doesNotMatch(decode(listing.stdout), /b\.tmp/);
  await ctx.fs.mkdir('out'); await okay(ctx, 'tar -xf a.tar -C out --strip-components=2 src/keep/a');
  assert.deepEqual(await ctx.bytes('out/a'), Array.from(binary)); await absent(ctx, 'out/other', 'out/src');
  await ctx.fs.mkdir('filtered'); await okay(ctx, "tar -xf a.tar -C filtered --exclude='src/keep*'");
  assert.equal(await ctx.read('filtered/src/other'), 'other'); await absent(ctx, 'filtered/src/keep');
});

test('tar reads independent ustar prefix, PAX path/size and GNU long-name metadata', async () => {
  const ctx = fresh(), longName = 'long/'.repeat(24) + 'payload.bin';
  const fixture = tarFixture([
    { name: 'leaf', prefix: 'prefix/branch', data: binary },
    { name: 'PaxHeader', type: 'x', data: paxRecord('path', longName) + paxRecord('size', '3') },
    { name: 'short', data: 'PAX' },
    { name: '././@LongLink', type: 'L', data: 'gnu/'.repeat(26) + 'value\0' },
    { name: 'short2', data: 'GNU' },
  ]);
  await seed(ctx, { 'foreign.tar': fixture }); await ctx.fs.mkdir('out'); await okay(ctx, 'tar -xf foreign.tar -C out');
  assert.deepEqual(await ctx.bytes('out/prefix/branch/leaf'), Array.from(binary)); assert.equal(await ctx.read('out/' + longName), 'PAX');
  assert.equal(await ctx.read('out/' + 'gnu/'.repeat(26) + 'value'), 'GNU');
});

for (const [name, make] of [
  ['checksum', () => { const bytes = tarFixture([{ name: 'first', data: 'first' }, { name: 'bad', data: 'bad' }]); bytes[1024] ^= 1; return bytes; }],
  ['truncated payload', () => tarFixture([{ name: 'first', data: 'first' }, { name: 'bad', data: binary }]).subarray(0, 1800)],
  ['invalid octal size', () => { const head = tarHeader({ name: 'bad', data: '' }); head[124] = 57; repairTarChecksum(head); return concat(tarFixture([{ name: 'first', data: 'first' }]).subarray(0, 1024), head, new Uint8Array(1024)); }],
  ['malformed PAX record', () => tarFixture([{ name: 'first', data: 'first' }, { name: 'pax', type: 'x', data: '99 path=bad\n' }, { name: 'bad', data: 'bad' }])],
  ['unsupported sparse metadata', () => tarFixture([{ name: 'first', data: 'first' }, { name: 'pax', type: 'x', data: paxRecord('GNU.sparse.map', '0,3') }, { name: 'bad', data: 'bad' }])],
]) test(`tar rejects ${name} before writing an earlier valid entry`, async () => {
  const ctx = fresh(); await seed(ctx, { 'bad.tar': make() }); await ctx.fs.mkdir('out');
  await refused(ctx, 'tar -xf bad.tar -C out'); await absent(ctx, 'out/first', 'out/bad');
});

for (const type of ['1', '2', '3', '4', '6', 'S']) test(`tar refuses special entry type ${type} before extraction`, async () => {
  const ctx = fresh(); await seed(ctx, { 'bad.tar': tarFixture([{ name: 'first', data: 'ok' }, { name: 'special', type, link: '../victim', data: '' }]), victim: 'keep' });
  await ctx.fs.mkdir('out'); await refused(ctx, 'tar -xf bad.tar -C out'); await absent(ctx, 'out/first', 'out/special'); assert.equal(await ctx.read('victim'), 'keep');
});

for (const path of ['../victim', '/victim', 'C:/victim', 'a\\..\\victim', '%2e%2e/victim', 'safe/../victim', 'bad\nname']) {
  for (const format of ['tar', 'zip']) test(`${format} rejects unsafe archive pathname ${JSON.stringify(path)} before effects`, async () => {
    const ctx = fresh(), entries = [{ name: 'first', data: 'ok' }, { name: path, data: 'attack' }];
    await seed(ctx, { archive: format === 'tar' ? tarFixture(entries) : zipFixture(entries), victim: 'keep' }); await ctx.fs.mkdir('out');
    await refused(ctx, format === 'tar' ? 'tar -xf archive -C out' : 'unzip -o archive -d out');
    await absent(ctx, 'out/first'); assert.equal(await ctx.read('victim'), 'keep');
  });
}

test('gzip/gunzip/zcat accept independent concatenated members with header metadata', async () => {
  const ctx = fresh(), input = concat(gzipSync(binary), gzipWithMetadata('tail'), gzipSync(''));
  await seed(ctx, { 'many.gz': input }); await expect(ctx, 'zcat many.gz', concat(binary, 'tail'));
  await expect(ctx, 'gzip -dc many.gz', concat(binary, 'tail')); await expect(ctx, 'gunzip -c < many.gz', concat(binary, 'tail'));
  await expect(ctx, 'gzip -t many.gz', ''); await expect(ctx, 'gunzip -t many.gz', '');
});

for (const options of [{ level: 0 }, { strategy: constants.Z_FIXED }, { level: 9 }]) test(`gzip decodes external RFC1951 framing ${JSON.stringify(options)}`, async () => {
  const ctx = fresh(); await seed(ctx, { 'input.gz': gzipSync(concat(binary, binary, binary), options) });
  await expect(ctx, 'zcat input.gz', concat(binary, binary, binary));
});

test('gzip binary stdin/stdout and empty input preserve bytes through shell pipelines', async () => {
  const ctx = fresh(); await seed(ctx, { source: binary, empty: '' });
  await okay(ctx, 'cat source | gzip | gunzip > out'); assert.deepEqual(await ctx.bytes('out'), Array.from(binary));
  const compressed = await okay(ctx, 'gzip -c source'); assert.deepEqual(Array.from(gunzipSync(Uint8Array.from(bytesOf(compressed.stdout)))), Array.from(binary));
  await okay(ctx, 'gzip -c empty > empty.gz'); await expect(ctx, 'zcat empty.gz', ''); assert.deepEqual(await ctx.bytes('source'), Array.from(binary));
});

test('gzip keep, force and decompression honor file overwrite rules', async () => {
  const ctx = fresh(); await seed(ctx, { source: binary }); await okay(ctx, 'gzip -k source');
  assert.deepEqual(await ctx.bytes('source'), Array.from(binary)); await seed(ctx, { source: 'existing destination' });
  await refused(ctx, 'gunzip -k source.gz'); assert.equal(await ctx.read('source'), 'existing destination');
  await okay(ctx, 'gunzip -fk source.gz'); assert.deepEqual(await ctx.bytes('source'), Array.from(binary));
  await seed(ctx, { 'source.gz': 'old compressed' }); await refused(ctx, 'gzip -k source'); assert.equal(await ctx.read('source.gz'), 'old compressed');
  await okay(ctx, 'gzip -fk source'); assert.deepEqual(Array.from(gunzipSync(Uint8Array.from(await ctx.bytes('source.gz')))), Array.from(binary));
});

test('gzip and gunzip file conversions remove sources only after governed confirmation', async () => {
  const ctx = fresh(); await seed(ctx, { source: binary });
  const prompt = await ctx.run('gzip source'); assert.ok(prompt.awaitingConfirm); assert.deepEqual(await ctx.bytes('source'), Array.from(binary));
  assert.deepEqual(Array.from(gunzipSync(Uint8Array.from(await ctx.bytes('source.gz')))), Array.from(binary));
  assert.equal((await ctx.run('y')).code, 0); await absent(ctx, 'source');
  assert.equal((await accept(ctx, 'gunzip source.gz')).code, 0); await absent(ctx, 'source.gz'); assert.deepEqual(await ctx.bytes('source'), Array.from(binary));
});

test('gzip quiet stdout is byte-only and verbose diagnostics stay on stderr', async () => {
  const ctx = fresh(); await seed(ctx, { source: binary });
  const quiet = await okay(ctx, 'gzip -qc source'); assert.equal(decode(quiet.stderr), '');
  const verbose = await okay(ctx, 'gzip -vc source'); assert.notEqual(decode(verbose.stderr), '');
  assert.deepEqual(Array.from(gunzipSync(Uint8Array.from(bytesOf(verbose.stdout)))), Array.from(binary));
});

for (const [name, make] of [
  ['CRC', () => { const bytes = new Uint8Array(gzipSync(binary)); bytes[bytes.length - 8] ^= 1; return bytes; }],
  ['ISIZE', () => { const bytes = new Uint8Array(gzipSync(binary)); bytes[bytes.length - 4] ^= 1; return bytes; }],
  ['trailer truncation', () => gzipSync(binary).subarray(0, -2)],
  ['deflate truncation', () => gzipSync(binary).subarray(0, 14)],
  ['reserved header flags', () => { const bytes = new Uint8Array(gzipSync(binary)); bytes[3] |= 0x20; return bytes; }],
  ['header CRC', () => { const bytes = gzipWithMetadata(binary); bytes[10] ^= 1; return bytes; }],
  ['corrupt second member', () => { const second = new Uint8Array(gzipSync('bad')); second[second.length - 8] ^= 1; return concat(gzipSync(binary), second); }],
]) test(`gzip refuses ${name} without replacing the output file`, async () => {
  const ctx = fresh(); await seed(ctx, { 'data.gz': make(), data: 'keep' }); await refused(ctx, 'gunzip -fk data.gz');
  assert.equal(await ctx.read('data'), 'keep'); assert.equal((await ctx.fs.stat('data.gz')).ok, true);
  const streamed = await refused(ctx, 'zcat data.gz'); assert.deepEqual(bytesOf(streamed.stdout), [], 'invalid transform leaks no prefix');
});

test('zip recursively creates and updates entries while preserving untouched members', async () => {
  const ctx = fresh(); await seed(ctx, { 'src/data': binary, 'src/empty': '', extra: 'first' }); await ctx.fs.mkdir('src/dir');
  await expect(ctx, 'zip -rq archive.zip src extra', ''); await seed(ctx, { extra: 'updated', another: 'new' });
  await okay(ctx, 'zip -q archive.zip extra another'); await okay(ctx, 'unzip -q archive.zip -d out');
  assert.deepEqual(await ctx.bytes('out/src/data'), Array.from(binary)); assert.deepEqual(await ctx.bytes('out/src/empty'), []);
  assert.equal((await ctx.fs.stat('out/src/dir')).stat.type, 'dir'); assert.equal(await ctx.read('out/extra'), 'updated'); assert.equal(await ctx.read('out/another'), 'new');
});

test('zip stored mode and entry deletion use zip-specific flags', async () => {
  const ctx = fresh(); await seed(ctx, { a: 'A', b: binary }); await okay(ctx, 'zip -0q archive.zip a b');
  const bytes = Uint8Array.from(await ctx.bytes('archive.zip')); assert.equal(view(bytes).getUint16(8, true), 0);
  await okay(ctx, 'zip -dq archive.zip a'); await expect(ctx, 'unzip -p archive.zip b', binary);
  await refused(ctx, 'unzip -p archive.zip a'); await absent(ctx, 'a/a');
});

for (const descriptor of [false, true, 'unsigned']) test(`unzip reads independent stored/deflated archives with descriptor=${descriptor}`, async () => {
  const ctx = fresh(); await seed(ctx, { 'foreign.zip': zipFixture([{ name: 'stored', data: binary }, { name: 'deflated', data: concat(binary, binary), method: 8, descriptor }, { name: 'dir/', data: '' }]) });
  await okay(ctx, 'unzip -q foreign.zip -d out'); assert.deepEqual(await ctx.bytes('out/stored'), Array.from(binary));
  assert.deepEqual(await ctx.bytes('out/deflated'), Array.from(concat(binary, binary))); assert.equal((await ctx.fs.stat('out/dir')).stat.type, 'dir');
  await expect(ctx, 'unzip -p foreign.zip stored deflated', concat(binary, binary, binary));
  const listed = await okay(ctx, 'unzip -l foreign.zip'); assert.match(decode(listed.stdout), /stored/); assert.match(decode(listed.stdout), /deflated/);
});

test('unzip selection, destination, quiet, overwrite and skip-existing flags preserve existing files', async () => {
  const ctx = fresh(); await seed(ctx, { 'archive.zip': zipFixture([{ name: 'first', data: 'new first' }, { name: 'collision', data: 'replacement' }]), 'out/collision': 'keep' });
  await refused(ctx, 'unzip -q archive.zip -d out'); await absent(ctx, 'out/first'); assert.equal(await ctx.read('out/collision'), 'keep');
  await okay(ctx, 'unzip -nq archive.zip -d out'); assert.equal(await ctx.read('out/first'), 'new first'); assert.equal(await ctx.read('out/collision'), 'keep');
  await okay(ctx, 'unzip -oq archive.zip collision -d out'); assert.equal(await ctx.read('out/collision'), 'replacement');
  await expect(ctx, 'unzip -p archive.zip collision', 'replacement');
});

for (const [name, entry, options = {}] of [
  ['CRC mismatch', { name: 'bad', data: 'data', crc: 0 }],
  ['size mismatch', { name: 'bad', data: 'data', size: 12 }],
  ['local/central filename contradiction', { name: 'bad', data: 'data', localPatch: (bytes) => { bytes[30] = 99; } }],
  ['local/central method contradiction', { name: 'bad', data: 'data', localPatch: (bytes) => view(bytes).setUint16(8, 8, true) }],
  ['local/central size contradiction', { name: 'bad', data: 'data', localPatch: (bytes) => view(bytes).setUint32(22, 999, true) }],
  ['descriptor contradiction', { name: 'bad', data: 'data', method: 8, descriptor: true, descriptorPatch: (bytes) => { bytes[4] ^= 1; } }],
  ['unsupported compression method', { name: 'bad', data: 'data', method: 99 }],
  ['encryption', { name: 'bad', data: 'data', flags: 1 }],
  ['symlink', { name: 'bad', data: '../victim', attributes: (0o120777 << 16) >>> 0 }],
  ['split archive', { name: 'bad', data: 'data' }, { disk: 1 }],
  ['ZIP64 sentinel', { name: 'bad', data: 'data', centralPatch: (bytes) => view(bytes).setUint32(24, 0xffffffff, true) }],
  ['overlapping payload', { name: 'bad', data: 'data', centralPatch: (bytes) => view(bytes).setUint32(42, 0, true) }],
]) test(`unzip refuses ${name} before extracting an earlier valid entry`, async () => {
  const ctx = fresh(); await seed(ctx, { 'bad.zip': zipFixture([{ name: 'first', data: 'ok' }, entry], options), victim: 'keep' });
  await refused(ctx, 'unzip -o bad.zip -d out'); await absent(ctx, 'out/first', 'out/bad'); assert.equal(await ctx.read('victim'), 'keep');
});

test('unzip rejects truncated central metadata before creating its destination', async () => {
  const ctx = fresh(); await seed(ctx, { 'bad.zip': zipFixture([{ name: 'first', data: binary }]).subarray(0, -10) });
  await refused(ctx, 'unzip bad.zip -d out'); await absent(ctx, 'out');
});

test('unzip refuses embedded NUL path bytes before earlier entries are written', async () => {
  const ctx = fresh(); await seed(ctx, { 'bad.zip': zipFixture([{ name: 'first', data: 'ok' }, { name: 'bad\0name', data: 'attack' }]) });
  await refused(ctx, 'unzip bad.zip -d out'); await absent(ctx, 'out/first', 'out/bad');
});

for (const command of ['tar --unknown -cf output source', 'tar -jcf output source', 'gzip -1 source', 'gzip -9 source', 'gunzip --unknown source', 'zcat --unknown source', 'zip -9 output source', 'zip -e output source', 'unzip -P secret source', 'unzip --unknown source']) {
  test(`unsupported archive form refuses explicitly without effects: ${command}`, async () => {
    const ctx = fresh(); await seed(ctx, { source: 'keep', output: 'keep output' }); await refused(ctx, command);
    assert.equal(await ctx.read('source'), 'keep'); assert.equal(await ctx.read('output'), 'keep output'); await absent(ctx, 'source.gz');
    assert.deepEqual(ctx.face.pendingProposals(), []);
  });
}
