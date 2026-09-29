import test from 'node:test';
import assert from 'node:assert/strict';
import { createIO } from '../io.mjs';
import { createDataCommands } from '../cmds/data.mjs';
import { fresh, seed, expect, bytesOf, decode } from './u3-harness.mjs';

// Independent expected values come from the B10 contract, jq's manual,
// GNU gettext's envsubst manual, js-yaml's README and fd's upstream manual.
// No implementation parser or evaluator is imported by this suite.
function factory({ environment = new Map(), ...options } = {}) {
  const ctx = fresh();
  const io = createIO({ invoke: (name, input) => ctx.face.invoke(name, input) });
  const commands = createDataCommands(io, { environment: () => environment,
    authorize: (name, input) => ctx.face.check(name, input), ...options });
  const run = async (name, argv, stdin = '') => {
    try { return await commands[name](argv, stdin); }
    catch (error) { return { code: typeof error.code === 'number' ? error.code : 2, stdout: '', stderr: error.message }; }
  };
  return { ...ctx, run };
}
async function output(name, argv, stdin, expected, code = 0, options = {}) {
  const result = await factory(options).run(name, argv, stdin);
  assert.equal(result.code, code, decode(result.stderr));
  assert.deepEqual(bytesOf(result.stdout), bytesOf(expected));
  assert.equal(decode(result.stderr), '');
  assert.equal(result.raw, true);
  return result;
}
async function error(name, argv, stdin, code) {
  const result = await factory().run(name, argv, stdin);
  assert.equal(result.code, code, decode(result.stderr));
  assert.notEqual(decode(result.stderr), '');
  assert.deepEqual(bytesOf(result.stdout), []);
}
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const lines = (result) => { assert.equal(result.code, 0, decode(result.stderr)); assert.equal(decode(result.stderr), ''); return decode(result.stdout).split('\n').filter(Boolean).sort(); };

test('jq preserves independent JSON inputs and default pretty output', async () => {
  await output('jq', ['.'], '{"a":1}\n[true,null]\n', '{\n  "a": 1\n}\n[\n  true,\n  null\n]\n');
  await output('jq', ['-c', '.'], '1 true null "é" {} []', '1\ntrue\nnull\n"é"\n{}\n[]\n');
});

test('jq paths distinguish missing members, null, arrays, and negative indices', async () => {
  await output('jq', ['-c', '.a.b, .missing, .a.missing, .array[0], .array[-1], .array[99]'],
    '{"a":{"b":false},"array":[10,20]}', 'false\nnull\nnull\n10\n20\nnull\n');
  await output('jq', ['-c', '.["a.b"]'], '{"a.b":3}', '3\n');
  await output('jq', ['-c', '.missing'], 'null', 'null\n');
});

test('jq pipes and comma generators preserve stream cardinality and input context', async () => {
  await output('jq', ['-c', '.[] | (.x, .y)'], '[{"x":1,"y":2},{"x":3,"y":4}]', '1\n2\n3\n4\n');
  await output('jq', ['-c', '.a, .b | .[]'], '{"a":[1,2],"b":[3]}', '1\n2\n3\n');
  await output('jq', ['-c', '[.[] | (.x, .y)]'], '[{"x":1,"y":2},{"x":3,"y":4}]', '[1,2,3,4]\n');
  await output('jq', ['-c', '.[]'], '{"a":1,"b":2}', '1\n2\n');
  await output('jq', ['-c', '.[]'], '[]', '');
});

test('jq object construction forms Cartesian products of generated values', async () => {
  await output('jq', ['-c', '{a: .a[], b: .b[]}'], '{"a":[1,2],"b":[3,4]}',
    '{"a":1,"b":3}\n{"a":1,"b":4}\n{"a":2,"b":3}\n{"a":2,"b":4}\n');
  await output('jq', ['-c', '{a: .a[], b: 1}'], '{"a":[]}', '');
  await output('jq', ['-c', '{name: .name, values: [.items[]]}'], '{"name":"n","items":[1,2]}', '{"name":"n","values":[1,2]}\n');
});

test('jq map flattens generated results and select uses jq truthiness', async () => {
  await output('jq', ['-c', 'map(., .)'], '[1,2]', '[1,1,2,2]\n');
  await output('jq', ['-c', 'map(select(. >= 2))'], '[1,3,2,0]', '[3,2]\n');
  await output('jq', ['-c', 'map(select(.))'], '[false,null,0,"",[],{},true]', '[0,"",[],{},true]\n');
  await output('jq', ['-c', 'select(true, false, true)'], '7', '7\n7\n');
});

test('jq keys, has and length preserve value types and Unicode codepoints', async () => {
  await output('jq', ['-c', 'keys'], '{"z":1,"a":2}', '["a","z"]\n');
  await output('jq', ['-c', 'keys'], '[null,false]', '[0,1]\n');
  await output('jq', ['-c', 'has("missing"), has("present")'], '{"present":null}', 'false\ntrue\n');
  await output('jq', ['-c', 'has(0), has(2)'], '[null,false]', 'true\nfalse\n');
  await output('jq', ['-c', '.[] | length'], '["A😀é",null,-3,[1,2],{"a":1}]', '3\n0\n3\n2\n1\n');
  await error('jq', ['length'], 'true', 5);
  await error('jq', ['has("0")'], '[1]', 5);
});

test('jq structural comparisons and cross-type ordering follow jq values', async () => {
  await output('jq', ['-cn', '[{"b":2,"a":1} == {"a":1,"b":2}, [1,2] == [1,2], [1] != [2], null < false, false < true, true < 0, 0 < "", "" < [], [] < {}]'], '',
    '[true,true,true,true,true,true,true,true,true]\n');
});

test('jq boolean generators short-circuit without dropping left-side results', async () => {
  await output('jq', ['-nc', '[false and empty, true or empty, (false,true) and (false,true)]'], '', '[false,true,false,false,true]\n');
});

test('jq slurp collects the input stream without treating empty input as null', async () => {
  await output('jq', ['-cs', '.'], '1\n2\n{"x":3}', '[1,2,{"x":3}]\n');
  await output('jq', ['-cs', '.'], '', '[]\n');
  await output('jq', ['-c', '.'], ' \n\t', '');
});

test('jq null input ignores invalid input and evaluates exactly once', async () => {
  await output('jq', ['-cn', '.'], 'not JSON', 'null\n');
  await output('jq', ['-cns', '.'], '{broken', 'null\n');
  const ctx = factory(); const result = await ctx.run('jq', ['-cn', '.', 'missing-file'], 'broken');
  assert.equal(result.code, 0, decode(result.stderr)); assert.equal(decode(result.stdout), 'null\n');
});

for (const [filter, input, expected, code] of [
  ['.', '', '', 4], ['.[]', '[]', '', 4], ['.', 'null', 'null\n', 1], ['.', 'false', 'false\n', 1],
  ['.', '0', '0\n', 0], ['.', '""', '""\n', 0], ['.', 'false true', 'false\ntrue\n', 0],
  ['.', 'true null', 'true\nnull\n', 1],
]) test(`jq exit-status follows final result: ${JSON.stringify([filter, input])}`, async () => {
  await output('jq', ['-ce', filter], input, expected, code);
});

test('jq raw output keeps embedded NUL and Unicode bytes', async () => {
  await output('jq', ['-r', '.[]'], '["A\\u0000B","é😀",false,3]', new TextEncoder().encode('A\0B\né😀\nfalse\n3\n'));
});

test('jq arguments distinguish strings from JSON and preserve literal program text', async () => {
  await output('jq', ['-cn', '--arg', 'name', '$(touch forbidden)', '--argjson', 'value', '{"a":[1,null]}', '{name:$name,value:$value}'], '',
    '{"name":"$(touch forbidden)","value":{"a":[1,null]}}\n');
  await error('jq', ['--argjson', 'value', 'bad', '$value'], '', 2);
  await error('jq', ['--arg', 'only-name'], '', 2);
  await error('jq', ['$unbound'], '', 3);
  await error('jq', ['.['], '', 3);
});

test('jq own keys never expose JavaScript object prototypes', async () => {
  await output('jq', ['-c', '.constructor, .toString, .__proto__, has("constructor"), has("__proto__")'], '{}', 'null\nnull\nnull\nfalse\nfalse\n');
  await output('jq', ['-c', '.'], '{"__proto__":{"polluted":true},"constructor":7}', '{"__proto__":{"polluted":true},"constructor":7}\n');
  await output('jq', ['-cn', '{"__proto__": 1, "constructor": 2}'], '', '{"__proto__":1,"constructor":2}\n');
  await output('jq', ['-cn', '--arg', '__proto__', 'own', '$__proto__'], '', '"own"\n');
  assert.equal({}.polluted, undefined);
});

for (const [argv, input, code] of [
  [['--invented', '.'], 'null', 2], [['.['], 'null', 3], [['unknown_function'], 'null', 3],
  [['$unbound'], 'null', 3], [['.'], '{"x":}', 4], [['.'], '[1,]', 4],
  [['.'], 'undefined'], [['.'], '{"a":NaN}'], [['.'], '01'],
  [['.[]'], '1', 5], [['.x'], '1', 5],
]) test(`jq rejects invalid usage, filters or input: ${JSON.stringify([argv, input])}`, async () => {
  await error('jq', argv, input, code ?? 4);
});

test('jq reads files in order and accepts a stdin operand through public dispatch', async () => {
  const ctx = fresh(); await seed(ctx, { first: '{"n":1}\n', second: '{"n":3}\n', middle: '{"n":2}\n' });
  await expect(ctx, "cat middle | jq -c '.n' first - second", '1\n2\n3\n');
  await expect(ctx, "jq -n --arg name shell '{name:$name}'", '{\n  "name": "shell"\n}\n');
});

test('yq loads multiple documents with the common jq evaluator', async () => {
  await output('yq', ['-jc', '.a[] | select(. >= 2)'], 'a: [1, 2]\n---\na: [3, 0]\n', '2\n3\n');
  await output('yq', ['-jcs', '.'], 'a: 1\n---\na: 2\n', '[{"a":1},{"a":2}]\n');
  await output('yq', ['-jc', '.'], '', '');
  await output('yq', ['-jcs', '.'], '', '[]\n');
  await output('yq', ['-jcn', '.'], '!custom invalid', 'null\n');
  await output('yq', ['-jce', '.'], 'false\n---\ntrue\n', 'false\ntrue\n', 0);
  await output('yq', ['-jce', '.'], 'null\n', 'null\n', 1);
  await output('yq', ['-jce', '.'], '', '', 4);
});

test('yq emits YAML by default and switches output modes explicitly', async () => {
  await output('yq', ['.'], 'a: 1\nb: true\n', 'a: 1\nb: true\n');
  await output('yq', ['--output-json', '-c', '.'], 'a: 1\n', '{"a":1}\n');
  await output('yq', ['--yaml-output', '.'], '{"a":1}', 'a: 1\n');
  await output('yq', ['-r', '.a'], 'a: hello\n', 'hello\n');
});

test('yq preserves JSON-compatible scalars and expands noncyclic aliases', async () => {
  await output('yq', ['-jc', '.'], 'yes_value: yes\non_value: on\ntruth: true\nempty: null\ndate: 2026-09-30\nquoted: "1"\nnumber: 1\n',
    '{"yes_value":"yes","on_value":"on","truth":true,"empty":null,"date":"2026-09-30","quoted":"1","number":1}\n');
  await output('yq', ['-jc', '.'], 'base: &base {x: 1}\ncopy: *base\n', '{"base":{"x":1},"copy":{"x":1}}\n');
  await output('yq', ['-jc', '.'], '__proto__: {polluted: true}\nconstructor: 2\n', '{"__proto__":{"polluted":true},"constructor":2}\n');
  assert.equal({}.polluted, undefined);
});

for (const input of ['x: !custom value\n', 'x: .inf\n', 'x: .nan\n', 'a: &loop [*loop]\n', 'a: [1,\n', 'a: 1\na: 2\n']) test(`yq rejects unsafe or invalid YAML: ${JSON.stringify(input)}`, async () => {
  const result = await factory().run('yq', ['-jc', '.'], input);
  assert.notEqual(result.code, 0); assert.notEqual(decode(result.stderr), ''); assert.deepEqual(bytesOf(result.stdout), []);
});

test('envsubst expands only valid shell variable forms from injected environment', async () => {
  await output('envsubst', [], '$NAME ${NAME} $MISSING ${NAME:-fallback} $(touch forbidden) `touch forbidden` $9 ${9} $',
    'value value  ${NAME:-fallback} $(touch forbidden) `touch forbidden` $9 ${9} $', 0, { environment: new Map([['NAME', 'value']]) });
  await output('envsubst', ['$A ${A}'], '$A/$B/${A}/${B}', 'one/$B/one/${B}', 0, { environment: new Map([['A', 'one'], ['B', 'two']]) });
  await output('envsubst', [''], '$A', '$A', 0, { environment: new Map([['A', 'one']]) });
  await output('envsubst', [], '$A', '$B', 0, { environment: new Map([['A', '$B'], ['B', 'recursive-expansion-is-wrong']]) });
  await output('envsubst', [], '${constructor}|${__proto__}', '|');
});

test('envsubst variables mode reports occurrences without reading input', async () => {
  await output('envsubst', ['-v', '${A} $B $A ${BAD:-x}'], Uint8Array.of(255, 0), 'A\nB\nA\n');
  await output('envsubst', ['--variables', 'literal'], '$NEVER', '');
  await error('envsubst', ['-v'], 'ignored', 1);
  await error('envsubst', ['--unknown'], 'ignored', 1);
});

test('envsubst preserves non-variable bytes including NUL and invalid UTF-8', async () => {
  const input = Uint8Array.of(255, 0, 36, 65, 128, 13, 10, 36, 123, 65, 125, 254);
  const expected = Uint8Array.of(255, 0, 120, 128, 13, 10, 120, 254);
  await output('envsubst', [], input, expected, 0, { environment: new Map([['A', 'x']]) });
});

test('envsubst uses public shell environment and preserves bytes through redirects', async () => {
  const ctx = fresh(); await seed(ctx, { template: Uint8Array.of(255, 0, 36, 65, 254) });
  await expect(ctx, 'A=local; envsubst < template > output', '');
  assert.deepEqual(await ctx.bytes('output'), [255, 0, ...new TextEncoder().encode('local'), 254]);
  await expect(ctx, "env -i envsubst '$HOME' < template", Uint8Array.of(255, 0, 36, 65, 254));
});

test('fd basename regex uses smart case with explicit overrides', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/Alpha.txt': '', 'tree/alpha.txt': '', 'tree/xalpha.log': '', 'tree/nested/other': '' });
  assert.deepEqual(lines(await ctx.run('fd alpha tree -t f')), ['tree/Alpha.txt', 'tree/alpha.txt', 'tree/xalpha.log']);
  assert.deepEqual(lines(await ctx.run('fd Alpha tree -t f')), ['tree/Alpha.txt']);
  assert.deepEqual(lines(await ctx.run('fd alpha tree -s -t f')), ['tree/alpha.txt', 'tree/xalpha.log']);
  assert.deepEqual(lines(await ctx.run('fd Alpha tree -i -t f')), ['tree/Alpha.txt', 'tree/alpha.txt', 'tree/xalpha.log']);
  assert.deepEqual(lines(await ctx.run("fd '^[ax].*[.]txt$' tree -t f")), ['tree/Alpha.txt', 'tree/alpha.txt']);
});

test('fd glob and fixed-string modes use distinct matching rules', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/a.txt': '', 'tree/a.txt.bak': '', 'tree/aXtxt': '', 'tree/sub/a.txt': '' });
  assert.deepEqual(lines(await ctx.run("fd -g '*.txt' tree -t f")), ['tree/a.txt', 'tree/sub/a.txt']);
  assert.deepEqual(lines(await ctx.run("fd -F 'a.txt' tree -t f")), ['tree/a.txt', 'tree/a.txt.bak', 'tree/sub/a.txt']);
  assert.deepEqual(lines(await ctx.run("fd -p 'sub/.*[.]txt$' tree -t f")), ['tree/sub/a.txt']);
  assert.deepEqual(lines(await ctx.run("fd 'sub/.*[.]txt$' tree -t f")), []);
});

test('fd depth, extension, excludes, types, absolute and NUL output compose', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/a.txt': '', 'tree/b.js': '', 'tree/sub/c.txt': '', 'tree/sub/deep/d.txt': '', 'other/z.txt': '' });
  await ctx.fs.mkdir('tree/empty'); ctx.backend.symlink('tree/link', 'sub');
  assert.deepEqual(lines(await ctx.run("fd '' tree -t f -e txt -d 1")), ['tree/a.txt']);
  assert.deepEqual(lines(await ctx.run("fd '' tree -t f -e txt -E sub")), ['tree/a.txt']);
  assert.deepEqual(lines(await ctx.run("fd '' tree -t d -d 1")), ['tree/empty/', 'tree/sub/']);
  assert.deepEqual(lines(await ctx.run("fd '' tree -t l")), ['tree/link']);
  assert.deepEqual(lines(await ctx.run("fd '' tree -d 0")), []);
  assert.deepEqual(lines(await ctx.run("fd '' tree other -t f -e txt -a -d 1")), ['/other/z.txt', '/tree/a.txt']);
  await expect(ctx, 'fd -0 -F a.txt tree -t f', 'tree/a.txt\0');
});

test('fd hidden and no-ignore controls remain independent', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/.ignore': 'skip.txt\n', 'tree/.hidden.txt': '', 'tree/.hidden/child.txt': '', 'tree/skip.txt': '', 'tree/keep.txt': '' });
  assert.deepEqual(lines(await ctx.run("fd '' tree -t f")), ['tree/keep.txt']);
  assert.deepEqual(lines(await ctx.run("fd '' tree -t f -H")), ['tree/.hidden.txt', 'tree/.hidden/child.txt', 'tree/.ignore', 'tree/keep.txt']);
  assert.deepEqual(lines(await ctx.run("fd '' tree -t f -I")), ['tree/keep.txt', 'tree/skip.txt']);
  assert.deepEqual(lines(await ctx.run("fd '' tree -t f -u")), ['tree/.hidden.txt', 'tree/.hidden/child.txt', 'tree/.ignore', 'tree/keep.txt', 'tree/skip.txt']);
});

test('fd applies ignore files relative to their directories with negations', async () => {
  const ctx = fresh(); await seed(ctx, {
    'tree/.ignore': '*.tmp\n!keep.tmp\n/root.txt\nskipdir/\n', 'tree/.fdignore': 'fd-only.txt\n',
    'tree/drop.tmp': '', 'tree/keep.tmp': '', 'tree/root.txt': '', 'tree/fd-only.txt': '',
    'tree/skipdir/hidden.txt': '', 'tree/sub/root.txt': '', 'tree/sub/drop.tmp': '', 'tree/sub/keep.tmp': '',
    'tree/sub/.ignore': 'local.txt\n', 'tree/sub/local.txt': '', 'tree/visible.txt': '',
  });
  assert.deepEqual(lines(await ctx.run("fd '' tree -t f")), ['tree/keep.tmp', 'tree/sub/keep.tmp', 'tree/sub/root.txt', 'tree/visible.txt']);
  assert.deepEqual(lines(await ctx.run("fd '' tree/sub -t f")), ['tree/sub/keep.tmp', 'tree/sub/root.txt']);
});

test('fd applies gitignore only within a repository', async () => {
  const ctx = fresh(); await seed(ctx, { 'repo/.gitignore': 'ignored.txt\n', 'repo/ignored.txt': '', 'repo/kept.txt': '', 'plain/.gitignore': 'ignored.txt\n', 'plain/ignored.txt': '' });
  await ctx.fs.mkdir('repo/.git');
  assert.deepEqual(lines(await ctx.run("fd '' repo -t f")), ['repo/kept.txt']);
  assert.deepEqual(lines(await ctx.run("fd '' plain -t f")), ['plain/ignored.txt']);
});

test('fd preserves space and Unicode filename bytes with NUL delimiters', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/space é😀.txt': '' });
  await expect(ctx, `fd -0 -F ${quote('space é😀')} tree`, 'tree/space é😀.txt\0');
});

for (const command of ['fd --exec touch forbidden', 'fd -x touch forbidden', 'fd --exec-batch touch forbidden', 'fd -X touch forbidden', 'fd -L', 'fd -t z', 'fd -d -1', "fd '['", "fd '(?=a)'", 'fd --unknown']) {
  test(`fd explicitly rejects unsupported or invalid options: ${command}`, async () => {
    const ctx = fresh(); const result = await ctx.run(command);
    assert.notEqual(result.code, 0); assert.notEqual(decode(result.stderr), '');
    assert.equal((await ctx.fs.stat('forbidden')).code, 'ENOENT'); assert.deepEqual(ctx.face.pendingProposals(), []);
  });
}
