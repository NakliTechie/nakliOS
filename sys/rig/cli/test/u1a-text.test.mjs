// U1a contract tests. Expected values are hermetic; no host utility is invoked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTextCommands } from '../cmds/text.mjs';
import { createIO, toBytes, toText } from '../io.mjs';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createAgentFace, createGrant, createOpLog } from '../../agent/index.mjs';

function setup(scopes = ['fs:read', 'fs:write', 'fs:remove']) {
  const fs = createFileops({ backend: new MemoryBackend() });
  const registry = buildRigRegistry({ fs });
  const face = createAgentFace({ registry, grant: createGrant({ prefixes: [''], scopes }),
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }) });
  const io = createIO({ invoke: face.invoke });
  const commands = createTextCommands(io);
  const run = async (command, argv = [], stdin = '') => commands[command](argv, stdin);
  return { fs, commands, run };
}
const output = async (promise) => toText((await promise).text);
const refusal = (run, command, argv) => assert.rejects(() => run(command, argv), (error) => {
  assert.equal(error.code, 2);
  assert.match(error.message, new RegExp(`^${command}:`));
  return true;
});

test('sort keys, delimiters, character offsets and numeric modifiers choose the requested key', async () => {
  const { run } = setup();
  assert.equal(await output(run('sort', ['-t:', '-k2,2n'], 'a:10\nc:1\nb:2\n')), 'c:1\nb:2\na:10\n');
  assert.equal(await output(run('sort', ['-k1.2,1.3'], 'x20\ny10\n')), 'y10\nx20\n');
  assert.equal(await output(run('sort', ['-k2,2', '-k1,1r'], 'a same\nb same\nc first\n')), 'c first\nb same\na same\n');
  await refusal(run, 'sort', ['-k0']);
  await refusal(run, 'sort', ['-k2,1']);
  await refusal(run, 'sort', ['-t::']);
});

test('sort supports human, version and exponent order without lexical numeric mistakes', async () => {
  const { run } = setup();
  assert.equal(await output(run('sort', ['-h'], '1G\n900M\n2K\n100\n')), '100\n2K\n900M\n1G\n');
  assert.equal(await output(run('sort', ['-V'], 'v10\nv2\nv1\nv1~rc1\n')), 'v1~rc1\nv1\nv2\nv10\n');
  assert.equal(await output(run('sort', ['-g'], '1e2\n9\n-3e1\n')), '-3e1\n9\n1e2\n');
  assert.equal(await output(run('sort', ['-nr'], '2\n10\n-1\n')), '10\n2\n-1\n');
  await refusal(run, 'sort', ['-nh']);
});

test('sort stable, blank, dictionary, fold-case and unique options affect comparisons', async () => {
  const { run } = setup();
  assert.equal(await output(run('sort', ['-s', '-k2,2'], 'z 1\na 1\n')), 'z 1\na 1\n');
  assert.equal(await output(run('sort', ['-b'], ' z\na\n')), 'a\n z\n');
  assert.equal(await output(run('sort', ['-df'], 'b!\nA?\n')), 'A?\nb!\n');
  assert.equal(await output(run('sort', ['-nu'], '001\n1\n2\n')), '001\n2\n');
  assert.equal(await output(run('sort', ['-nu'], '9007199254740993\n9007199254740992\n')), '9007199254740992\n9007199254740993\n');
  assert.equal(await output(run('sort', ['-nu'], '0.10000000000000002\n0.10000000000000001\n')), '0.10000000000000001\n0.10000000000000002\n');
});

test('sort output may replace its input after reading; check mode never writes sorted data', async () => {
  const { fs, run } = setup();
  await fs.write('data', 'c\na\nb\n');
  assert.equal(await output(run('sort', ['-o', 'data', 'data'])), '');
  assert.equal((await fs.read('data', { encoding: 'utf-8' })).data, 'a\nb\nc\n');
  assert.equal((await run('sort', ['-c', 'data'])).code, 0);
  const disorder = await run('sort', ['-c'], 'z\na\n');
  assert.equal(disorder.code, 1); assert.match(disorder.text, /line 2/);
  assert.equal((await run('sort', ['-cu'], 'a\na\n')).code, 1);
  const missing = await run('sort', ['missing', 'data']);
  assert.equal(missing.code, 1); assert.equal(missing.text, 'sort: missing: ENOENT');
  await refusal(run, 'sort', ['-co', 'data']);
});

test('sort writes stay behind the grant boundary', async () => {
  const { run } = setup(['fs:read']);
  await assert.rejects(() => run('sort', ['-o', 'forbidden'], 'b\na\n'), /not granted|scope/i);
});

test('head and tail select bytes without UTF-8 replacement or final-newline changes', async () => {
  const { fs, run } = setup();
  const bytes = Uint8Array.of(0xff, 0x00, 0xc3, 0xa9, 0x0a);
  await fs.write('binary', bytes);
  assert.deepEqual(toBytes((await run('head', ['-c3', 'binary'])).text), bytes.slice(0, 3));
  assert.deepEqual(toBytes((await run('tail', ['-c+3', 'binary'])).text), bytes.slice(2));
  assert.deepEqual(toBytes((await run('tail', ['-c2'], bytes)).text), bytes.slice(-2));
  assert.equal(await output(run('head', ['-c0'], 'abc')), '');
  assert.equal(await output(run('head', ['-c-2'], 'abcdef')), 'abcd');
  assert.equal(await output(run('head', ['-n1'], 'unterminated')), 'unterminated');
});

test('head and tail keep numeric shorthand, signed line counts and headers per file', async () => {
  const { fs, run } = setup();
  await fs.write('a', '1\n2\n3\n'); await fs.write('b', 'x\ny\n');
  assert.equal(await output(run('head', ['-2', 'a'])), '1\n2\n');
  assert.equal(await output(run('head', ['-n+2', 'a'])), '1\n2\n');
  assert.equal(await output(run('head', ['-n-1', 'a'])), '1\n2\n');
  assert.equal(await output(run('tail', ['-n+2', 'a'])), '2\n3\n');
  assert.equal(await output(run('tail', ['-n0', 'a'])), '');
  assert.equal(await output(run('head', ['-n1', 'a', 'b'])), '==> a <==\n1\n\n==> b <==\nx\n');
  const missing = await run('tail', ['-n1', 'missing', 'b']);
  assert.equal(missing.code, 1); assert.match(toText(missing.text), /y\n$/);
  await refusal(run, 'head', ['-nwat']); await refusal(run, 'tail', ['-c1.5']);
});

test('wc counts original bytes including invalid UTF-8 and keeps historical line formatting', async () => {
  const { fs, run } = setup();
  await fs.write('binary', Uint8Array.of(255, 128, 0));
  await fs.write('a', '1\n2\n3\n'); await fs.write('b', 'x\ny\n');
  assert.equal(await output(run('wc', ['-c', 'binary'])), '3\n');
  assert.equal(await output(run('wc', ['-c'], Uint8Array.of(255))), '1\n');
  assert.equal(await output(run('wc', ['-cm'], 'é😀')), '2 6\n');
  assert.equal(await output(run('wc', ['-l'], 'last line')), '1\n');
  assert.equal(await output(run('wc', ['-w'], ' one\t two\nthree ')), '3\n');
  assert.equal(await output(run('wc', ['-l', 'a', 'b'])), '3 a\n2 b\n5 total\n');
  assert.equal(await output(run('wc', ['-lw', 'a'])), '3 3\n');
  assert.equal(await output(run('wc')), '0 0 0\n');
});

test('uniq compares runs using fields, characters, width and case', async () => {
  const { run } = setup();
  assert.equal(await output(run('uniq', ['-ic'], 'A\na\nb\n')), '      2 A\n      1 b\n');
  assert.equal(await output(run('uniq', ['-d'], 'a\na\nb\n')), 'a\n');
  assert.equal(await output(run('uniq', ['-u'], 'a\na\nb\n')), 'b\n');
  assert.equal(await output(run('uniq', ['-f1'], 'one shared\ntwo shared\nthree other\n')), 'one shared\nthree other\n');
  assert.equal(await output(run('uniq', ['-s1', '-w2'], 'xabc\nyabd\nzbc\n')), 'xabc\nzbc\n');
  assert.equal(await output(run('uniq', ['-du'], 'a\na\nb\n')), '');
  assert.equal(await output(run('uniq', ['-f999999999'], 'a\nb\n')), 'a\n');
  await refusal(run, 'uniq', ['-s-1']); await refusal(run, 'uniq', ['in', 'out']);
});

test('cut supports open ranges, deduplicated selections, complements and output delimiters', async () => {
  const { run } = setup();
  assert.equal(await output(run('cut', ['-d:', '-f1,3-'], 'a:b:c:d\n')), 'a:c:d\n');
  assert.equal(await output(run('cut', ['-d:', '-f-2,2'], 'a:b:c\n')), 'a:b\n');
  assert.equal(await output(run('cut', ['-d:', '-f2', '--complement', '--output-delimiter=|'], 'a:b:c\n')), 'a|c\n');
  assert.equal(await output(run('cut', ['-sf2', '-d:'], 'plain\na:b\n')), 'b\n');
  assert.equal(await output(run('cut', ['-f2', '-d:'], 'plain\na:b\n')), 'plain\nb\n');
  assert.equal(await output(run('cut', ['-c1,3', '--output-delimiter=:'], 'abcd\n')), 'a:c\n');
  await refusal(run, 'cut', ['-f0']); await refusal(run, 'cut', ['-f3-1']);
  await refusal(run, 'cut', ['-f1', '-c2']); await refusal(run, 'cut', ['-c1', '-d:']);
});

test('cut distinguishes Unicode characters from original bytes and continues after missing input', async () => {
  const { fs, run } = setup(); await fs.write('a', 'éx\n');
  assert.equal(await output(run('cut', ['-c1', 'a'])), 'é\n');
  assert.deepEqual(toBytes((await run('cut', ['-b1', 'a'])).text), Uint8Array.of(0xc3, 10));
  const result = await run('cut', ['-c2', 'missing', 'a']);
  assert.equal(result.code, 1); assert.equal(toText(result.text), 'cut: missing: ENOENT\nx\n');
  const middle = await run('cut', ['-c2', 'a', 'missing', 'a']);
  assert.equal(middle.code, 1); assert.equal(toText(middle.text), 'cut: missing: ENOENT\nx\nx\n');
});

test('tr expands C-locale character classes and ranges, then translates or deletes', async () => {
  const { run } = setup();
  assert.equal(await output(run('tr', ['[:lower:]', '[:upper:]'], 'aZ9\n')), 'AZ9\n');
  assert.equal(await output(run('tr', ['a-z', 'A-Z'], 'abc')), 'ABC');
  assert.equal(await output(run('tr', ['-d', '[:digit:]'], 'a1b2')), 'ab');
  assert.equal(await output(run('tr', ['-cd', '[:digit:]'], 'a1b2\n')), '12');
  assert.equal(await output(run('tr', ['-Cds', '[:digit:]', '0-9'], 'a11b22\n')), '12');
  await refusal(run, 'tr', ['[:unknown:]', 'x']); await refusal(run, 'tr', ['z-a', 'x']);
  await refusal(run, 'tr', ['a', '']); await refusal(run, 'tr', ['a', 'b', 'extra']);
});

test('tr squeeze runs after translation/deletion and preserves nontext bytes', async () => {
  const { run } = setup();
  assert.equal(await output(run('tr', ['-s', '[:space:]'], 'a   b\n\nc')), 'a b\nc');
  assert.equal(await output(run('tr', ['-cs', '[:alnum:]', '\\n'], 'one,  two!')), 'one\ntwo\n');
  assert.equal(await output(run('tr', ['-ds', 'x', 'a'], 'axxaaa')), 'a');
  const binary = await run('tr', ['\\377', '\\000'], Uint8Array.of(255, 128));
  assert.deepEqual(toBytes(binary.text), Uint8Array.of(0, 128));
});

test('echo supports -n, escapes, explicit escape disabling and stop escapes', async () => {
  const { run } = setup();
  assert.equal(await output(run('echo', ['hello', 'world'])), 'hello world\n');
  assert.equal(await output(run('echo', ['-n', 'hello'])), 'hello');
  assert.equal(await output(run('echo', ['-e', 'a\\tb\\nc'])), 'a\tb\nc\n');
  assert.equal(await output(run('echo', ['-eE', 'a\\n'])), 'a\\n\n');
  assert.equal(await output(run('echo', ['-e', 'a\\cb'])), 'a');
  assert.equal(await output(run('echo', ['text', '-n'])), 'text -n\n');
  assert.deepEqual(toBytes((await run('echo', ['-ne', '\\0377'])).text), Uint8Array.of(255));
});

test('printf formats strings, characters, bases, widths and precision with format reuse', async () => {
  const { run } = setup();
  assert.equal(await output(run('printf', ['%04x %o %.2f %.3s %c', '31', '9', '1.25', 'abcdef', 'XYZ'])), '001f 11 1.25 abc X');
  assert.equal(await output(run('printf', ['%+06d|%-5s|%#x|%#.0o', '12', 'x', '31', '0'])), '+00012|x    |0x1f|0');
  assert.equal(await output(run('printf', ['%*.*f', '8', '2', '3.5'])), '    3.50');
  assert.equal(await output(run('printf', ['%s-%s\n', 'a', 'b', 'c'])), 'a-b\nc-\n');
  assert.equal(await output(run('printf', ['%% %s\n', 'a', 'b'])), '% a\n% b\n');
  assert.equal(await output(run('printf', ['hello', 'unused'])), 'hello');
  assert.equal(await output(run('printf', ['%d|', '0x1f', "'A", '010', '-3', ''])), '31|65|8|-3|0|');
});

test('printf %b and literal numeric escapes produce exact bytes and \c stops further conversions', async () => {
  const { run } = setup();
  assert.equal(await output(run('printf', ['%b END %s', 'a\\n\\cb', 'unused'])), 'a\n');
  assert.deepEqual(toBytes((await run('printf', ['\\377%bx', '\\000'])).text), Uint8Array.of(255, 0, 120));
  assert.equal(await output(run('printf', ['%b', '\\u00e9'])), 'é');
  assert.equal(await output(run('printf', ['%.2e|%.3g', '100', '1.25'])), '1.00e+02|1.25');
  const invalid = await run('printf', ['%d\n', '12abc']);
  assert.equal(invalid.code, 1); assert.equal(toText(invalid.text), '12\nprintf: 12abc: invalid number');
  await refusal(run, 'printf', ['%q', 'x']); await refusal(run, 'printf', ['%100001s', 'x']);
});

test('od retains character, octal-byte and hex-byte layouts', async () => {
  const { run } = setup();
  assert.equal(await output(run('od', ['-c'], 'a\tb\r\n')), '0000000   a  \\t   b  \\r  \\n\n0000005\n');
  assert.equal(await output(run('od', ['-b'], 'a\tb\r\n')), '0000000 141 011 142 015 012\n0000005\n');
  assert.equal(await output(run('od', ['-An', '-tx1'], Uint8Array.of(0, 255, 195, 40))), ' 00 ff c3 28\n');
  await refusal(run, 'od', []); await refusal(run, 'od', ['-t', 'f3']);
});

test('od dumps little-endian words with requested address base, skips and limits', async () => {
  const { run } = setup(); const bytes = Uint8Array.of(1, 2, 3, 4, 5);
  assert.equal(await output(run('od', ['-An', '-x'], bytes)), ' 0201 0403 0005\n');
  assert.equal(await output(run('od', ['-An', '-o'], bytes)), ' 001001 002003 000005\n');
  assert.equal(await output(run('od', ['-An', '-d'], bytes)), '   513  1027     5\n');
  assert.equal(await output(run('od', ['-Ad', '-tx1', '-j1', '-N2'], bytes)), '0000001 02 03\n0000003\n');
  assert.equal(await output(run('od', ['-Ax', '-tx1', '-j2', '-N0'], bytes)), '0000002\n');
  assert.equal((await run('od', ['-b', '-j9'], bytes)).code, 1);
  await refusal(run, 'od', ['-c', '-Az']); await refusal(run, 'od', ['-c', '-Nwat']);
});

test('od concatenates every readable operand and reports missing files', async () => {
  const { fs, run } = setup(); await fs.write('a', 'x'); await fs.write('b', 'y');
  const result = await run('od', ['-c', 'a', 'missing', 'b']);
  assert.equal(result.code, 1);
  assert.equal(toText(result.text), 'od: missing: ENOENT\n0000000   x   y\n0000002\n');
});

test('every override refuses unsupported flags with exit 2 and a supported-flags list', async () => {
  const { run } = setup();
  for (const command of ['sort', 'head', 'tail', 'wc', 'uniq', 'cut', 'tr', 'echo', 'printf', 'od']) {
    await assert.rejects(() => run(command, ['--unsupported']), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.message, /unsupported flag --unsupported/);
      assert.match(error.message, /supports/);
      return true;
    });
  }
});
