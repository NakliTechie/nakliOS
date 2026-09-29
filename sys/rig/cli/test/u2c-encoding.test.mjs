import test from 'node:test';
import assert from 'node:assert/strict';
import { createEncodingCommands } from '../cmds/encodings.mjs';
import { fresh, seed, output, encode, decode, names, observeReads } from './u2c-fixture.mjs';

// Fixed RFC 4648 section 10 vectors; expectations never call production codecs.
const rfc = [
  ['', '', ''], ['f', 'Zg==', 'MY======'], ['fo', 'Zm8=', 'MZXQ===='],
  ['foo', 'Zm9v', 'MZXW6==='], ['foob', 'Zm9vYg==', 'MZXW6YQ='],
  ['fooba', 'Zm9vYmE=', 'MZXW6YTB'], ['foobar', 'Zm9vYmFy', 'MZXW6YTBOI======'],
];

test('all twelve B06 names resolve through the public shell and reject unknown flags before reading', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'unread' }); const reads = observeReads(ctx);
  for (const name of names) {
    assert.ok(ctx.shell.commands.includes(name), name);
    assert.equal((await ctx.run(`${name} --definitely-unsupported input`)).code, 2, name);
  }
  assert.deepEqual(reads, []);
});

test('base64 and base32 obey all published final-quantum vectors in both directions', async () => {
  const ctx = fresh();
  for (const [text, b64, b32] of rfc) for (const [command, encoded] of [['base64', b64], ['base32', b32]]) {
    await seed(ctx, { input: text, encoded });
    await output(ctx, `${command} input`, encoded ? `${encoded}\n` : '');
    await output(ctx, `${command} -w0 input`, encoded);
    await output(ctx, `${command} -d encoded`, text);
  }
});

test('every basenc alphabet has an independent exact vector', async () => {
  const ctx = fresh();
  const cases = [
    ['base64', encode('foobar'), 'Zm9vYmFy'], ['base64url', Uint8Array.of(251, 255), '-_8='],
    ['base32', encode('foobar'), 'MZXW6YTBOI======'], ['base32hex', encode('foobar'), 'CPNMUOJ1E8======'],
    ['base16', Uint8Array.of(0, 255, 128, 65), '00FF8041'],
    ['base2msbf', Uint8Array.of(1, 128, 65), '000000011000000001000001'],
    ['base2lsbf', Uint8Array.of(1, 128, 65), '100000000000000110000010'],
    // ZeroMQ Z85 specification's published test case.
    ['z85', Uint8Array.of(0x86, 0x4f, 0xd2, 0x6f, 0xb5, 0x59, 0xf7, 0x5b), 'HelloWorld'],
    // Bitcoin base58: a zero byte is one leading '1'; 0x3a is base 58's '21'.
    ['base58', Uint8Array.of(0, 0, 58), '1121'],
  ];
  for (const [format, input, encoded] of cases) {
    await seed(ctx, { input, encoded }); await output(ctx, `basenc --${format} -w0 input`, encoded);
    await output(ctx, `basenc --${format} -d encoded`, input);
  }
});

test('wrapping has exact default, zero, one, crossed-quantum, and final-boundary framing', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'a'.repeat(60), tiny: 'foo', boundary: 'a'.repeat(57), empty: '' });
  const base = 'YWFh'.repeat(20);
  await output(ctx, 'base64 input', `${base.slice(0, 76)}\n${base.slice(76)}\n`);
  await output(ctx, 'base64 -w0 input', base);
  await output(ctx, 'base64 -w1 tiny', 'Z\nm\n9\nv\n');
  await output(ctx, 'base64 -w3 tiny', 'Zm9\nv\n');
  await output(ctx, 'base64 boundary', `${'YWFh'.repeat(19)}\n`);
  await output(ctx, 'base32 -w1 empty', '');
});

test('binary bytes survive fixed base64 encoding, decoding, pipelines, and redirection', async () => {
  const ctx = fresh(); const binary = Uint8Array.from({ length: 256 }, (_, index) => index);
  await seed(ctx, { input: binary, special: Uint8Array.of(0xef, 0xbb, 0xbf, 0xff, 0x80, 0, 13, 10, 65) });
  await output(ctx, 'base64 -w0 special', '77u//4AADQpB');
  await output(ctx, 'base64 input | base64 -d', binary);
  await output(ctx, 'base32 input | base32 -d', binary);
  await output(ctx, 'basenc --base16 input | basenc --base16 -d', binary);
  const commands = createEncodingCommands(ctx.io);
  const backing = Uint8Array.of(99, 0xff, 0x80, 0, 99);
  assert.equal(decode((await commands.base64(['-w0'], backing.subarray(1, 4))).text), '/4AA');
});

test('decoder ignores LF but rejects garbage unless explicitly enabled', async () => {
  const ctx = fresh();
  await seed(ctx, { lines: 'Z\ng=\n=\n', garbage: Uint8Array.of(90, 0, 103, 255, 61, 61) });
  await output(ctx, 'base64 -d lines', 'f');
  assert.notEqual((await ctx.run('base64 -d garbage')).code, 0);
  await output(ctx, 'base64 -di garbage', 'f');
  await seed(ctx, { lower: 'my======' }); assert.notEqual((await ctx.run('base32 -d lower')).code, 0);
});

test('base16 decoding accepts GNU lowercase and mixed-case hexadecimal', async () => {
  const ctx = fresh();
  for (const value of ['00ff8041', '00fF8041']) {
    await seed(ctx, { input: value });
    await output(ctx, 'basenc --base16 -d input', Uint8Array.of(0, 255, 128, 65));
  }
});

test('malformed padding, unused bits, overflow, and incomplete quanta never become successful data', async () => {
  const ctx = fresh();
  const cases = [
    ['base64', ['Zg=', 'Zg===', '=Zg=', 'Zg==Zg==', 'Zh==', 'Zm9=', 'Z', 'Zg', 'Zm8']],
    ['base32', ['MY=====', 'MY=======', 'MZ======', 'MZXQ===', 'MZXQ====A', 'M']],
    ['basenc --base16', ['0', '0G']], ['basenc --base2msbf', ['1', '00000002']],
    ['basenc --base2lsbf', ['000', '00000002']], ['basenc --z85', ['HelloWorl', '#####']],
  ];
  for (const [command, badValues] of cases) for (const value of badValues) {
    await seed(ctx, { bad: value }); assert.notEqual((await ctx.run(`${command} -d bad`)).code, 0, `${command}: ${value}`);
  }
  await seed(ctx, { bad: 'Zh==' }); assert.notEqual((await ctx.run('base64 -di bad')).code, 0);
  await seed(ctx, { bad: 'Zm9vZh==' }); const result = await ctx.run('base64 -d bad');
  assert.notEqual(result.code, 0); assert.doesNotMatch(result.output, /foof/);
  await seed(ctx, { bad: 'abc' }); assert.notEqual((await ctx.run('basenc --z85 bad')).code, 0);
});

test('encoding preflight rejects invalid selectors, widths, missing values, and excess files before content access', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'abc' }); const reads = observeReads(ctx);
  for (const command of ['base64 -w', 'base32 --wrap', 'base64 -w-1 input', 'base64 -w1e3 input',
    'base64 -w999999999999999999999999999 input', 'base64 input input', 'basenc input',
    'basenc --base64 --base32 input', 'basenc --not-an-encoding input']) assert.equal((await ctx.run(command)).code, 2, command);
  assert.deepEqual(reads, []);
});

test('encoding expansion and wrapping charge exact output boundaries before allocation', async () => {
  const ctx = fresh();
  const exact = createEncodingCommands(ctx.io, { limits: { maxOutputBytes: 4 } });
  assert.equal(decode((await exact.base64(['-w0'], 'f')).text), 'Zg==');
  await assert.rejects(exact.base64([], 'f'), /limit|exceed/i);
  const base2 = createEncodingCommands(ctx.io, { limits: { maxOutputBytes: 7 } });
  await assert.rejects(base2.basenc(['--base2msbf', '-w0'], Uint8Array.of(0)), /limit|exceed/i);
  const work = createEncodingCommands(ctx.io, { limits: { maxSteps: 2 } });
  await assert.rejects(work.base64(['-di'], '!'.repeat(32768)), /limit|exceed/i);
  const retained = createEncodingCommands(ctx.io, { limits: { maxRetainedBytes: 100 } });
  await assert.rejects(retained.base64(['-w0'], new Uint8Array(256)), /retained|limit/i);
  assert.notEqual((await ctx.run(`printf abc | basenc --base58 --wrap=99999999999999999999999`)).code, 0);
  await seed(ctx, { huge58: new Uint8Array(8193) }); assert.notEqual((await ctx.run('basenc --base58 huge58')).code, 0);
});

test('encoding input grants and final-link replacement protect canonical content', async () => {
  for (const command of ['base64', 'base32', 'basenc --base16']) {
    let replaced = false;
    const ctx = fresh({ prefixes: ['allowed'], beforeOperation: async (name, input, { backend }) => {
      if (name === 'fs.read' && input.path === 'allowed/input' && !replaced) {
        replaced = true; await backend.delete('allowed/input'); backend.symlink('allowed/input', '../protected/secret');
      }
    } });
    await seed(ctx, { 'allowed/input': 'public', 'protected/secret': 'private' });
    ctx.backend.symlink('allowed/link', '../protected/secret'); const reads = observeReads(ctx);
    assert.notEqual((await ctx.run(`${command} protected/secret`)).code, 0);
    assert.notEqual((await ctx.run(`${command} allowed/link`)).code, 0);
    assert.deepEqual(reads, []);
    assert.notEqual((await ctx.run(`${command} allowed/input`)).code, 0); assert.equal(replaced, true);
    assert.deepEqual(reads, []);
  }
});

test('encoding bounded reads refuse false oversized metadata before backend content loads', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'tiny' }); const original = ctx.backend.stat.bind(ctx.backend);
  ctx.backend.stat = async (path, options) => { const value = await original(path, options); return path === 'input' && value ? { ...value, size: 65 * 1024 * 1024 } : value; };
  const reads = observeReads(ctx);
  for (const command of ['base64', 'base32', 'basenc --base58']) assert.notEqual((await ctx.run(`${command} input`)).code, 0);
  assert.deepEqual(reads, []);
});

test('encoding redirected writes obey grant denial, staged refusal, acceptance, and Stop', async () => {
  const ctx = fresh({ stageWrites: true, readOnlyPrefixes: ['protected'] }); await seed(ctx, { input: 'foo', target: 'keep', protected: 'keep' });
  assert.notEqual((await ctx.run('base64 input > protected')).code, 0); assert.equal(await ctx.read('protected'), 'keep');
  assert.ok((await ctx.run('base64 input > target')).awaitingConfirm); assert.equal(await ctx.read('target'), 'keep');
  await ctx.run('n'); assert.equal(await ctx.read('target'), 'keep');
  assert.ok((await ctx.run('base64 input > target')).awaitingConfirm); assert.equal((await ctx.run('y')).code, 0); assert.equal(await ctx.read('target'), 'Zm9v\n');
  assert.ok((await ctx.run('base32 input > target; touch after-stop')).awaitingConfirm);
  await ctx.shell.cancel(); assert.equal(ctx.shell.lastCode, 130); assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal(await ctx.read('target'), 'Zm9v\n'); assert.equal((await ctx.fs.stat('after-stop')).ok, false);
  assert.equal((await ctx.run('expr 2 + 3')).output, '5');
});

test('Stop during encoding read and CPU work suppresses later mutations and resets per invocation', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'foo' }); const original = ctx.backend.readBinary.bind(ctx.backend); let stopped = false;
  ctx.backend.readBinary = async (path, options) => { if (path === 'input' && !stopped) { stopped = true; void ctx.shell.cancel(); } return original(path, options); };
  assert.equal((await ctx.run('base64 input; touch after-stop')).code, 130); assert.equal((await ctx.fs.stat('after-stop')).ok, false);
  assert.equal((await ctx.run('base64 input')).code, 0);
  await seed(ctx, { large: new Uint8Array(1024 * 1024) });
  const pending = ctx.run('base64 large; touch after-cpu'); const timer = setTimeout(() => { void ctx.shell.cancel(); }, 0);
  try { assert.equal((await pending).code, 130); } finally { clearTimeout(timer); }
  assert.equal((await ctx.fs.stat('after-cpu')).ok, false); assert.equal((await ctx.run('expr 3 + 4')).output, '7');
});
