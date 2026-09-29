import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createChecksumCommands } from '../cmds/checksums.mjs';
import { ShellInterrupted } from '../execution.mjs';
import { fresh, seed, output, encode, decode, observeReads } from './u2c-fixture.mjs';

// RFC 1321, RFC 6234, FIPS 180 examples, and RFC 7693 fixed vectors.
const vectors = {
  md5sum: ['d41d8cd98f00b204e9800998ecf8427e', '900150983cd24fb0d6963f7d28e17f72'],
  sha1sum: ['da39a3ee5e6b4b0d3255bfef95601890afd80709', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
  sha224sum: ['d14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f', '23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7'],
  sha256sum: ['e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  sha384sum: ['38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b', 'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7'],
  sha512sum: ['cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e', 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f'],
  b2sum: ['786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce', 'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923'],
};
const sha = vectors.sha256sum[1], emptySha = vectors.sha256sum[0];
const shortBlake = 'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319';
const tags = { md5sum: 'MD5', sha1sum: 'SHA1', sha224sum: 'SHA224', sha256sum: 'SHA256', sha384sum: 'SHA384', sha512sum: 'SHA512', b2sum: 'BLAKE2b' };

test('all seven digest commands produce fixed empty and abc vectors with exact text framing', async () => {
  const ctx = fresh(); await seed(ctx, { empty: '', input: 'abc' });
  for (const [command, [empty, abc]] of Object.entries(vectors)) {
    await output(ctx, `${command} empty input`, `${empty}  empty\n${abc}  input\n`);
    await output(ctx, `printf abc | ${command}`, `${abc}  -\n`);
  }
});

test('digest block boundaries and binary byte views match independent Node crypto', async () => {
  const ctx = fresh();
  for (const command of Object.keys(vectors)) {
    const algorithm = command === 'b2sum' ? 'blake2b512' : command.replace('sum', '');
    for (const count of [55, 56, 63, 64, 65, 111, 112, 127, 128, 129, 256, 1025]) {
      const bytes = Uint8Array.from({ length: count }, (_, index) => index & 255);
      const expected = createHash(algorithm).update(bytes).digest('hex');
      await seed(ctx, { input: bytes }); await output(ctx, `${command} input`, `${expected}  input\n`);
    }
  }
  const commands = createChecksumCommands(ctx.io), backing = Uint8Array.of(99, 0xff, 0x80, 0, 99);
  const expected = createHash('sha256').update(backing.subarray(1, 4)).digest('hex');
  assert.equal(decode((await commands.sha256sum([], backing.subarray(1, 4))).text), `${expected}  -\n`);
});

test('BLAKE2b shortened output uses digest-length initialization rather than full-digest truncation', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'abc', empty: '' });
  await output(ctx, 'b2sum -l256 input', `${shortBlake}  input\n`);
  await output(ctx, 'b2sum --length=256 empty', '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8  empty\n');
  assert.notEqual(shortBlake, vectors.b2sum[1].slice(0, 64));
  await output(ctx, 'b2sum -l0 input', `${vectors.b2sum[1]}  input\n`);
  await output(ctx, 'b2sum -l512 input', `${vectors.b2sum[1]}  input\n`);
  const reads = observeReads(ctx);
  for (const command of ['b2sum -l7 input', 'b2sum -l513 input', 'b2sum -l-8 input', 'b2sum -l1e2 input', 'b2sum --length', 'b2sum -l999999999999999999999 input']) assert.equal((await ctx.run(command)).code, 2, command);
  assert.deepEqual(reads, []);
});

test('digest binary markers, tags, NUL records, and literal names preserve exact framing', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'abc', 'with space': 'abc', '-leading': 'abc' });
  for (const [command, [, abc]] of Object.entries(vectors)) {
    await output(ctx, `${command} -b input`, `${abc} *input\n`);
    await output(ctx, `${command} -t input`, `${abc}  input\n`);
    await output(ctx, `${command} --tag input`, `${tags[command]} (input) = ${abc}\n`);
    await output(ctx, `${command} -z 'with space'`, `${abc}  with space\0`);
    await output(ctx, `${command} -- -leading`, `${abc}  -leading\n`);
  }
});

test('multiple checksum operands preserve order, failures, repeats, and the consumed stdin cursor', async () => {
  const ctx = fresh(); await seed(ctx, { a: 'abc', b: '' });
  await output(ctx, 'sha256sum a b a', `${sha}  a\n${emptySha}  b\n${sha}  a\n`);
  await output(ctx, 'printf abc | sha256sum - -', `${sha}  -\n${emptySha}  -\n`);
  const result = await ctx.run('sha256sum a missing b'); assert.notEqual(result.code, 0);
  assert.ok(result.output.indexOf(`${sha}  a`) < result.output.indexOf(`${emptySha}  b`)); assert.match(result.output, /missing/);
});

test('POSIX CRC folds input length and legacy sums use the correct algorithm and block sizes', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'abc', empty: '' });
  await output(ctx, 'cksum empty input', '4294967295 0 empty\n1219131554 3 input\n');
  await output(ctx, 'printf abc | cksum', '1219131554 3\n');
  await output(ctx, 'sum input', '16556     1 input\n');
  await output(ctx, 'sum -r input', '16556     1 input\n');
  await output(ctx, 'sum -s input', '294 1 input\n');
  for (const count of [0, 1, 511, 512, 513, 1023, 1024, 1025]) {
    await seed(ctx, { zeros: new Uint8Array(count) });
    await output(ctx, 'sum zeros', `00000 ${String(Math.ceil(count / 1024)).padStart(5)} zeros\n`);
    await output(ctx, 'sum --sysv zeros', `0 ${Math.ceil(count / 512)} zeros\n`);
  }
});

test('cksum exposes queued digest selectors and exact raw or base64 output', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'abc' });
  for (const [command, [, digest]] of Object.entries(vectors)) {
    const selector = command === 'b2sum' ? 'blake2b' : command.replace('sum', '');
    await output(ctx, `cksum -a ${selector} --untagged input`, `${digest}  input\n`);
    await output(ctx, `cksum -a ${selector} input`, `${tags[command]} (input) = ${digest}\n`);
  }
  await output(ctx, 'cksum -a sha256 --raw input', Uint8Array.from(sha.match(/../g), (byte) => parseInt(byte, 16)));
  await output(ctx, 'cksum -a sha256 --base64 --untagged input', 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=  input\n');
  await output(ctx, 'cksum -a crc32b input', '891568578 3 input\n');
  const reads = observeReads(ctx);
  for (const command of ['cksum -a sha3 input', 'cksum -a sm3 input', 'cksum -a sha512-256 input',
    'cksum -a crc -c input', 'cksum -a crc32b -c input', 'cksum -a bsd -c input', 'cksum -a sysv -c input',
    'cksum -a sha256 --raw --base64 input', 'sha256sum --quiet input', 'sha256sum -cz input']) {
    assert.equal((await ctx.run(command)).code, 2, command);
  }
  assert.deepEqual(reads, []);
});

test('fixed manifests verify every digest family and checksum selector without generated expectations', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'abc' });
  for (const [command, [, digest]] of Object.entries(vectors)) {
    await seed(ctx, { manifest: `${digest}  input\n` });
    await output(ctx, `${command} -c manifest`, 'input: OK\n');
    await seed(ctx, { manifest: `${tags[command]} (input) = ${digest}\n` });
    await output(ctx, `${command} -c manifest`, 'input: OK\n');
  }
  await seed(ctx, { manifest: `${sha}  input\n` }); await output(ctx, 'cksum -a sha256 -c manifest', 'input: OK\n');
  await seed(ctx, { manifest: `SHA256 (input) = ${sha}\n` }); await output(ctx, 'cksum -c manifest', 'input: OK\n');
  await seed(ctx, { manifest: 'SHA256 (input) = ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=\n' });
  await output(ctx, 'cksum -c manifest', 'input: OK\n');
  await seed(ctx, { manifest: `${shortBlake}  input\n` }); await output(ctx, 'b2sum -c manifest', 'input: OK\n');
  await output(ctx, 'b2sum -l256 -c manifest', 'input: OK\n');
  await output(ctx, 'b2sum -l512 -c manifest', 'input: OK\n');
});

test('manifest mismatch status survives quiet and status modes while successful checks stay silent', async () => {
  const ctx = fresh(); await seed(ctx, { good: 'abc', changed: 'abd', manifest: `${sha}  good\n${sha}  changed\n`, valid: `${sha}  good\n` });
  const standard = await ctx.run('sha256sum -c manifest'); assert.notEqual(standard.code, 0); assert.match(standard.output, /good: OK/); assert.match(standard.output, /changed: FAILED/);
  const quiet = await ctx.run('sha256sum --quiet -c manifest'); assert.notEqual(quiet.code, 0); assert.doesNotMatch(quiet.output, /good: OK/); assert.match(quiet.output, /changed: FAILED/);
  const status = await ctx.run('sha256sum --status -c manifest'); assert.notEqual(status.code, 0); assert.equal(status.output, '');
  for (const mode of ['--quiet', '--status']) { const result = await ctx.run(`sha256sum ${mode} -c valid`); assert.equal(result.code, 0); assert.equal(result.output, ''); }
});

test('manifest syntax validates widths, hex, tags, separators, escapes, CRLF, and final lines', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'abc' });
  for (const text of [`${sha.toUpperCase()} *input\r\n`, `${sha}  input`, `${sha} input\n`]) {
    await seed(ctx, { manifest: text }); await output(ctx, 'sha256sum -c manifest', 'input: OK\n');
  }
  for (const text of [`${sha.slice(1)}  input\n`, `${'g'.repeat(64)}  input\n`, `${sha}input\n`,
    `${sha}  \n`, `MD5 (input) = ${sha}\n`, `\\${sha}  bad\\qname\n`, `${sha}  input\0`]) {
    await seed(ctx, { manifest: text }); assert.notEqual((await ctx.run('sha256sum -c manifest')).code, 0, JSON.stringify(text));
  }
  await seed(ctx, { mixed: `malformed\n${sha}  input\n` });
  assert.equal((await ctx.run('sha256sum -c mixed')).code, 0);
  const warned = await ctx.run('sha256sum -wc mixed'); assert.equal(warned.code, 0); assert.match(warned.output, /improper|invalid|malformed/i);
  assert.notEqual((await ctx.run('sha256sum --strict -c mixed')).code, 0);
});

test('ignore-missing never converts all-missing or zero-valid manifests into successful verification', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'abc', some: `${sha}  missing\n${sha}  input\n`, all: `${sha}  missing\n`, blank: '', invalid: 'nonsense\n' });
  assert.notEqual((await ctx.run('sha256sum -c some')).code, 0);
  const some = await ctx.run('sha256sum --ignore-missing -c some'); assert.equal(some.code, 0); assert.match(some.output, /input: OK/);
  for (const path of ['all', 'blank', 'invalid']) assert.notEqual((await ctx.run(`sha256sum --ignore-missing -c ${path}`)).code, 0, path);
});

test('manifest paths resolve from command cwd and filenames remain literal data', async () => {
  const ctx = fresh(); const literal = 'data; touch sentinel';
  await seed(ctx, { 'work/input': 'abc', 'work/manifests/check': `${sha}  input\n`, [`work/${literal}`]: 'abc', 'work/literal': `${sha}  ${literal}\n`, 'work/-leading': 'abc', 'work/dash': `${sha}  -leading\n` });
  assert.equal((await ctx.run('cd work')).code, 0);
  await output(ctx, 'sha256sum -c manifests/check', 'input: OK\n');
  await output(ctx, 'sha256sum -c literal', `${literal}: OK\n`);
  await output(ctx, 'sha256sum -c dash', '-leading: OK\n');
  assert.equal((await ctx.fs.stat('work/sentinel')).ok, false); assert.equal((await ctx.fs.stat('sentinel')).ok, false);
});

test('a manifest from stdin cannot replay its consumed bytes as a target stdin', async () => {
  const ctx = fresh(); await seed(ctx, { manifest: `${emptySha}  -\n` });
  const result = await ctx.run('cat manifest | sha256sum -c');
  assert.notEqual(result.code, 0); assert.doesNotMatch(result.output, /-: OK/);
});

test('digest files, manifest files, and extracted targets enforce grants independently', async () => {
  const ctx = fresh({ prefixes: ['allowed'] });
  await seed(ctx, { 'allowed/input': 'abc', 'protected/secret': 'abc', 'protected/manifest': `${sha}  allowed/input\n`, 'allowed/manifest': `${sha}  protected/secret\n` });
  ctx.backend.symlink('allowed/link', '../protected/secret'); const reads = observeReads(ctx);
  for (const command of ['sha256sum protected/secret', 'md5sum allowed/link', 'sha256sum -c protected/manifest', 'sha256sum -c allowed/manifest']) {
    assert.notEqual((await ctx.run(command)).code, 0, command);
  }
  assert.deepEqual(reads, ['allowed/manifest']);
  const readonly = fresh({ scopes: ['fs:read'] }); await seed(readonly, { input: 'abc' });
  assert.equal((await readonly.run('sha256sum input')).code, 0);
});

test('checksum canonical reads refuse final-link replacement for ordinary files, manifests, and extracted targets', async () => {
  for (const [command, replacedPath] of [['md5sum allowed/input', 'allowed/input'], ['sha256sum -c allowed/manifest', 'allowed/manifest'], ['sha256sum -c allowed/manifest', 'allowed/input']]) {
    let replaced = false;
    const ctx = fresh({ prefixes: ['allowed'], beforeOperation: async (name, input, { backend }) => {
      if (name === 'fs.read' && input.path === replacedPath && !replaced) {
        replaced = true; await backend.delete(replacedPath); backend.symlink(replacedPath, '../protected/secret');
      }
    } });
    await seed(ctx, { 'allowed/input': 'abc', 'allowed/manifest': `${sha}  allowed/input\n`, 'protected/secret': 'abc' });
    const reads = observeReads(ctx), result = await ctx.run(command); assert.equal(replaced, true, command); assert.notEqual(result.code, 0, command);
    assert.ok(reads.every((path) => path !== replacedPath && !path.startsWith('protected/')), reads.join(','));
  }
});

test('checksum metadata probes reject an ancestor replaced between canonical component checks', async () => {
  let replaced = false;
  const ctx = fresh({ prefixes: ['allowed'], beforeOperation: async (name, input, { backend }) => {
    if (name === 'fs.stat' && input.path === 'allowed/dir/input' && !replaced) {
      replaced = true; await backend.delete('allowed/dir'); backend.symlink('allowed/dir', '../protected');
    }
  } });
  await seed(ctx, { 'allowed/dir/input': 'abc', 'protected/input': 'private' });
  const reads = observeReads(ctx), result = await ctx.run('sha256sum allowed/dir/input');
  assert.equal(replaced, true); assert.notEqual(result.code, 0); assert.deepEqual(reads, []);
});

test('checksum bounded reads reject oversized ordinary, manifest, and target metadata without content access', async () => {
  for (const oversized of ['allowed/input', 'allowed/manifest']) {
    const ctx = fresh(); await seed(ctx, { 'allowed/input': 'abc', 'allowed/manifest': `${sha}  allowed/input\n` });
    const original = ctx.backend.stat.bind(ctx.backend);
    ctx.backend.stat = async (path, options) => { const value = await original(path, options); return path === oversized && value ? { ...value, size: 65 * 1024 * 1024 } : value; };
    const reads = observeReads(ctx);
    if (oversized.endsWith('/input')) assert.notEqual((await ctx.run('sha256sum allowed/input')).code, 0);
    assert.notEqual((await ctx.run('sha256sum -c allowed/manifest')).code, 0);
    assert.ok(!reads.includes(oversized), reads.join(','));
  }
});

test('checksum manifests share aggregate byte, record, descriptor, output, retained, and work limits', async () => {
  const ctx = fresh(); await seed(ctx, { a: 'abc', b: 'abc', manifest: `${sha}  a\n${sha}  b\n` });
  const invoke = (limits, args, stdin = '') => createChecksumCommands(ctx.io, { limits }).sha256sum(args, stdin);
  await assert.rejects(invoke({ maxInputBytes: 5 }, ['a', 'b']), /limit|exceed/i);
  await assert.rejects(invoke({ maxRecords: 1 }, ['-c', 'manifest']), /limit|exceed/i);
  await assert.rejects(invoke({ maxInputFiles: 2 }, ['-c', 'manifest']), /limit|exceed/i);
  await assert.rejects(invoke({ maxOutputBytes: 10 }, ['a']), /limit|exceed/i);
  await assert.rejects(invoke({ maxRetainedBytes: 63 }, ['a']), /limit|exceed/i);
  await assert.rejects(createChecksumCommands(ctx.io, { limits: { maxSteps: 1 } }).md5sum([], new Uint8Array(8192)), /limit|exceed/i);
});

test('missing WebCrypto refuses honestly and delayed digest completion cannot return after Stop', async () => {
  const ctx = fresh(); const unavailable = createChecksumCommands(ctx.io, { subtle: null });
  await assert.rejects(unavailable.sha256sum([], 'abc'), /capability|available|support|crypto/i);
  const controller = new AbortController(); let resolveDigest, announce;
  const started = new Promise((resolve) => { announce = resolve; });
  const subtle = { digest: async () => { announce(); return new Promise((resolve) => { resolveDigest = resolve; }); } };
  const pending = createChecksumCommands(ctx.io, { subtle, signal: () => controller.signal }).sha256sum([], 'abc');
  const rejected = assert.rejects(pending, ShellInterrupted); await started; controller.abort(); resolveDigest(new Uint8Array(32).buffer); await rejected;
  assert.equal((await ctx.run('printf abc | sha256sum')).code, 0);
  assert.equal((await ctx.run('expr 4 + 5')).output, '9');
});

test('Stop during governed checksum reads, pure-JS hashing, and staged output prevents later writes', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'abc' }); let stopped = false; const original = ctx.backend.readBinary.bind(ctx.backend);
  ctx.backend.readBinary = async (path, options) => { if (path === 'input' && !stopped) { stopped = true; void ctx.shell.cancel(); } return original(path, options); };
  assert.equal((await ctx.run('sha256sum input; touch after-read')).code, 130); assert.equal((await ctx.fs.stat('after-read')).ok, false);
  assert.equal((await ctx.run('sha256sum input')).code, 0);
  await seed(ctx, { large: new Uint8Array(1024 * 1024) }); const pending = ctx.run('b2sum large; touch after-hash');
  const timer = setTimeout(() => { void ctx.shell.cancel(); }, 0); try { assert.equal((await pending).code, 130); } finally { clearTimeout(timer); }
  assert.equal((await ctx.fs.stat('after-hash')).ok, false);
  const staged = fresh({ stageWrites: true }); await seed(staged, { input: 'abc', output: 'keep' });
  assert.ok((await staged.run('sha256sum input > output; touch after-stage')).awaitingConfirm);
  await staged.shell.cancel(); assert.equal(staged.shell.lastCode, 130); assert.equal(await staged.read('output'), 'keep');
  assert.deepEqual(staged.face.pendingProposals(), []); assert.equal((await staged.fs.stat('after-stage')).ok, false);
  assert.equal((await staged.run('expr 5 + 6')).output, '11');
});
