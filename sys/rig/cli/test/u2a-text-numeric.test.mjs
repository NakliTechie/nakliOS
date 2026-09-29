import test from 'node:test';
import assert from 'node:assert/strict';
import { createShell } from '../shell.mjs';
import { createIO } from '../io.mjs';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { buildRigRegistry, createRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';
import { createLayoutCommands } from '../cmds/layout.mjs';
import { createRecordCommands } from '../cmds/records.mjs';
import { createNumericCommands } from '../cmds/numeric.mjs';

const commands = ['tac', 'rev', 'nl', 'paste', 'join', 'comm', 'split', 'fold', 'fmt', 'expand', 'unexpand', 'column',
  'seq', 'shuf', 'tsort', 'expr', 'numfmt', 'printenv', 'yes', 'ptx', 'bc', 'factor'];
const encode = (s) => new TextEncoder().encode(s);
const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
function fresh({ scopes = ['fs:read', 'fs:write', 'fs:remove'], prefixes = [''], readOnlyPrefixes = [], stageWrites = false } = {}) {
  const backend = new MemoryBackend(), fs = createFileops({ backend }), base = buildRigRegistry({ fs });
  const registry = stageWrites ? createRegistry(base.commands.map((command) => command.name === 'fs.write'
    ? { ...command, destructive: true } : command)) : base;
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant: createGrant({ scopes, prefixes, readOnlyPrefixes }), opLog, actor: 'u2-contract' });
  const shell = createShell({ registry, face });
  const run = async (command) => ({ ...await shell.feed(command), code: shell.lastCode });
  const read = async (path) => { const result = await fs.read(path, { encoding: 'utf-8' }); assert.equal(result.ok, true, result.message); return result.data; };
  const bytes = async (path) => { const result = await fs.read(path); assert.equal(result.ok, true, result.message); return Array.from(result.data); };
  const io = createIO({ invoke: (name, input) => face.invoke(name, input) });
  return { backend, fs, face, shell, opLog, io, run, read, bytes };
}
async function seed(ctx, entries) {
  for (const [path, data] of Object.entries(entries)) {
    const result = await ctx.fs.write(path, data, { createParents: true }); assert.equal(result.ok, true, result.message);
  }
}
async function output(ctx, command, expected) {
  const result = await ctx.run(`${command} > captured`); assert.equal(result.code, 0, result.output);
  assert.deepEqual(await ctx.bytes('captured'), Array.from(typeof expected === 'string' ? encode(expected) : expected));
}

test('all twenty-two U2a command names are discoverable through the public shell', () => {
  const ctx = fresh(); for (const command of commands) assert.ok(ctx.shell.commands.includes(command), command);
});

test('tac reverses each file independently without inventing separators for an unterminated tail', async () => {
  const ctx = fresh(); await seed(ctx, { one: 'a\nb\n', two: 'c\nd' });
  await output(ctx, 'tac one two', 'b\na\ndc\n');
  await output(ctx, 'tac one one', 'b\na\nb\na\n');
  await output(ctx, "printf '' | tac", '');
});

test('tac supports separator placement and bounded BRE separators', async () => {
  const ctx = fresh(); await seed(ctx, { after: 'a::b::', before: '::a::b', regexp: 'a11b22' });
  await output(ctx, "tac -s '::' after", 'b::a::');
  await output(ctx, "tac -b -s '::' before", '::b::a');
  await output(ctx, "tac -r -s '[0-9][0-9]' regexp", 'b22a11');
  assert.equal((await ctx.run("tac -r -s '[' after")).code, 2);
});

test('rev reverses C-locale bytes while preserving LF framing through raw shell input', async () => {
  const ctx = fresh(); await seed(ctx, { bytes: Uint8Array.of(0, 255, 128, 10, 65, 66), other: 'xy\n' });
  await output(ctx, 'cat bytes | rev', [128, 255, 0, 10, 66, 65]);
  await output(ctx, 'rev other bytes', [121, 120, 10, 128, 255, 0, 10, 66, 65]);
});

test('nl applies explicit styles, counters, padding, and separators', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'a\n\nb\n', blanks: '\n\n\nx\n' });
  await output(ctx, 'nl -ba -v3 -i2 -w2 -nrz -s: input', '03:a\n05:\n07:b\n');
  await output(ctx, 'nl -ba -l2 -w1 -s: blanks', '  \n1:\n  \n2:x\n');
  await output(ctx, 'nl -bn -w1 -s: input', '  a\n  \n  b\n');
});

test('nl implements logical pages, reset suppression, and BRE-selected body lines', async () => {
  const ctx = fresh(); await seed(ctx, { pages: 'a\n\\:\\:\\:\nhead\n\\:\\:\nb\n', patterns: 'xray\nother\nx\n' });
  await output(ctx, 'nl -ba -ha -w1 -s: pages', '1:a\n\n1:head\n\n1:b\n');
  await output(ctx, 'nl -p -ba -ha -w1 -s: pages', '1:a\n\n2:head\n\n3:b\n');
  await output(ctx, "nl -b 'p^x' -w1 -s: patterns", '1:xray\n  other\n2:x\n');
  assert.equal((await ctx.run("nl -b 'p[' patterns")).code, 2);
});

test('paste handles exhausted columns, serial delimiters, and one shared stdin cursor', async () => {
  const ctx = fresh(); await seed(ctx, { left: 'a\nb\n', right: '1\n', input: 'a\nb\nc\nd\ne\n' });
  await output(ctx, 'paste left right', 'a\t1\nb\t\n');
  await output(ctx, "paste -s -d ',:' input", 'a,b:c,d:e\n');
  await output(ctx, 'cat input | paste - -', 'a\tb\nc\td\ne\t\n');
  await output(ctx, 'paste right right', '1\t1\n');
});

test('paste preserves NUL records and escaped empty delimiters', async () => {
  const ctx = fresh(); await seed(ctx, { a: Uint8Array.of(255, 0, 128, 0), b: Uint8Array.of(65, 0) });
  await output(ctx, 'paste -z a b', [255, 9, 65, 0, 128, 9, 0]);
  await output(ctx, "paste -z -d '\\0' a b", [255, 65, 0, 128, 0]);
});

test('paste serial mode emits one record per repeated stdin operand after sharing its cursor', async () => {
  const ctx = fresh();
  await output(ctx, "printf 'a\\nb\\n' | paste -s - -", 'a\tb\n\n');
  await output(ctx, "printf '' | paste -s - -", '\n\n');
});

test('join retains full duplicate-key Cartesian products and unmatched groups', async () => {
  const ctx = fresh(); await seed(ctx, { left: 'a L1\na L2\nb B\n', right: 'a R1\na R2\nc C\n' });
  await output(ctx, 'join left right', 'a L1 R1\na L1 R2\na L2 R1\na L2 R2\n');
  await output(ctx, 'join -a1 -a2 left right', 'a L1 R1\na L1 R2\na L2 R1\na L2 R2\nb B\nc C\n');
  await output(ctx, 'join -v1 -v2 left right', 'b B\nc C\n');
});

test('join selects keys, fields, replacements, and ASCII-insensitive comparisons', async () => {
  const ctx = fresh(); await seed(ctx, { left: 'L:A:x\nM:b:y\n', right: 'a:R\nc:S\n' });
  await output(ctx, "join -i -t: -1 2 -2 1 -a1 -a2 -e? -o '0,1.1,2.2' left right", 'A:L:R\nb:M:?\nc:?:S\n');
  const invalid = await ctx.run('join -1 0 left right'); assert.equal(invalid.code, 2);
});

test('join and comm reject unsorted inputs without silently sorting them', async () => {
  const ctx = fresh(); await seed(ctx, { bad: 'b\na\n', sorted: 'a\nb\n' });
  for (const command of ['join --check-order bad sorted', 'comm --check-order bad sorted']) {
    const result = await ctx.run(command); assert.notEqual(result.code, 0); assert.match(result.output, /order|sort/i);
  }
  for (const command of ['join - -', 'comm - -']) assert.equal((await ctx.run(command)).code, 2);
});

test('comm preserves duplicate multiplicity and column indentation', async () => {
  const ctx = fresh(); await seed(ctx, { left: 'a\na\nb\n', right: 'a\nc\n' });
  await output(ctx, 'comm left right', '\t\ta\na\nb\n\tc\n');
  await output(ctx, 'comm -12 left right', 'a\n');
  await output(ctx, 'comm -23 left right', 'a\nb\n');
  await output(ctx, 'comm -123 left right', '');
  await seed(ctx, { left: Uint8Array.of(128, 0, 255, 0), right: Uint8Array.of(255, 0) });
  await output(ctx, 'comm -z left right', [128, 0, 9, 9, 255, 0]);
});

test('split preserves complete source bytes in line, byte, and line-byte pieces', async () => {
  const ctx = fresh(); await seed(ctx, { input: Uint8Array.of(255, 10, 65, 66, 67, 68, 10, 128) });
  assert.equal((await ctx.run('split -b3 input part')).code, 0);
  assert.deepEqual(await ctx.bytes('partaa'), [255, 10, 65]); assert.deepEqual(await ctx.bytes('partab'), [66, 67, 68]);
  assert.deepEqual(await ctx.bytes('partac'), [10, 128]);
  assert.equal((await ctx.run('split -l1 input line')).code, 0);
  assert.deepEqual(await ctx.bytes('lineaa'), [255, 10]); assert.deepEqual(await ctx.bytes('lineab'), [65, 66, 67, 68, 10]);
  assert.deepEqual(await ctx.bytes('lineac'), [128]);
  assert.equal((await ctx.run('split -C3 input bounded')).code, 0);
  const pieces = [];
  for (const suffix of ['aa', 'ab', 'ac', 'ad', 'ae']) {
    if (!(await ctx.fs.stat('bounded' + suffix)).ok) break;
    const piece = await ctx.bytes('bounded' + suffix); assert.ok(piece.length <= 3); pieces.push(...piece);
  }
  assert.deepEqual(pieces, await ctx.bytes('input'));
});

test('split validates suffix capacity, malformed options, and input collisions before writes', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'x\n'.repeat(27), xa: 'sentinel', aa: 'original' });
  assert.equal((await ctx.run('split -a1 -l1 input x')).code, 2);
  assert.equal(await ctx.read('xa'), 'sentinel'); assert.equal((await ctx.fs.stat('xb')).ok, false);
  assert.equal((await ctx.run("split -b1 aa ''")).code, 2); assert.equal(await ctx.read('aa'), 'original');
  assert.equal((await ctx.run('split -b nope input p')).code, 2); assert.equal((await ctx.fs.stat('paa')).ok, false);
  await seed(ctx, { empty: '' }); assert.equal((await ctx.run('split empty empty-piece')).code, 0);
  assert.equal((await ctx.fs.stat('empty-pieceaa')).ok, false);
});

test('split supports numeric suffixes and additional suffixes', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'abcd' });
  assert.equal((await ctx.run('split -b2 -d -a3 --numeric-suffixes=7 --additional-suffix=.bin input chunk')).code, 0);
  assert.equal(await ctx.read('chunk007.bin'), 'ab'); assert.equal(await ctx.read('chunk008.bin'), 'cd');
});

test('split automatically extends alphabetic suffixes beyond two-character names without losing bytes', async () => {
  const ctx = fresh(), input = Uint8Array.from({ length: 700 }, (_, index) => index % 256);
  await seed(ctx, { input });
  const result = await ctx.run('split -b1 input part'); assert.equal(result.code, 0, result.output);
  const listed = await ctx.fs.list(''); assert.equal(listed.ok, true);
  const names = listed.entries.map((entry) => entry.name).filter((name) => name.startsWith('part')).sort();
  assert.equal(names.length, 700);
  assert.equal(names[649], 'partyz'); assert.equal(names[650], 'partzaaa');
  assert.equal(names[0], 'partaa'); assert.equal(names.at(-1), 'partzabx');
  const reconstructed = [];
  for (const name of names) { const piece = await ctx.bytes(name); assert.equal(piece.length, 1); reconstructed.push(...piece); }
  assert.deepEqual(reconstructed, Array.from(input));
});

test('split refuses symlinked input or output collisions before writing any destination', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'ab', sentinel: 'keep' });
  ctx.backend.symlink('partab', 'input');
  const outputAlias = await ctx.run('split -b1 input part'); assert.equal(outputAlias.code, 2);
  assert.equal((await ctx.fs.stat('partaa')).ok, false); assert.equal(await ctx.read('input'), 'ab');
  assert.equal((await ctx.backend.stat('partab')).type, 'symlink');
  ctx.backend.symlink('alias', 'input');
  const inputAlias = await ctx.run('split -b1 alias other'); assert.equal(inputAlias.code, 2);
  assert.equal((await ctx.fs.stat('otheraa')).ok, false); assert.equal(await ctx.read('sentinel'), 'keep');
});

test('split preserves earlier writes when a later destination fails its grant', async () => {
  const ctx = fresh({ readOnlyPrefixes: ['partab'] }); await seed(ctx, { input: 'abc', partab: 'protected' });
  const result = await ctx.run('split -b1 input part'); assert.notEqual(result.code, 0);
  assert.equal(await ctx.read('partaa'), 'a'); assert.equal(await ctx.read('partab'), 'protected');
  assert.equal((await ctx.fs.stat('partac')).ok, false);
  assert.deepEqual((await ctx.opLog.read()).filter((entry) => entry.command === 'fs.write').map((entry) => entry.status), ['ok', 'EGRANT']);
});

test('split suspends at real write proposals and refusal prevents later pieces', async () => {
  const ctx = fresh({ stageWrites: true }); await seed(ctx, { input: 'abc' });
  const first = await ctx.run('split -b1 input part'); assert.ok(first.awaitingConfirm);
  assert.equal((await ctx.fs.stat('partaa')).ok, false);
  const second = await ctx.run('y'); assert.ok(second.awaitingConfirm); assert.equal(await ctx.read('partaa'), 'a');
  const stopped = await ctx.run('n'); assert.equal(stopped.code, 1);
  assert.equal((await ctx.fs.stat('partab')).ok, false); assert.equal((await ctx.fs.stat('partac')).ok, false);
  assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('fold distinguishes byte width, display controls, spaces, and final delimiters', async () => {
  const ctx = fresh(); await seed(ctx, { words: 'one two three\n', bytes: Uint8Array.of(255, 128, 65, 66), tabs: 'a\tb\n', controls: 'ab\bc\rde\n' });
  await output(ctx, 'fold -s -w7 words', 'one \ntwo \nthree\n');
  await output(ctx, 'fold -b -w2 bytes', [255, 128, 10, 65, 66]);
  await output(ctx, 'fold -b -w3 tabs', 'a\tb\n');
  await output(ctx, 'fold -w8 tabs', 'a\t\nb\n');
  await output(ctx, 'fold -w3 controls', 'ab\bc\rde\n');
});

test('fmt joins paragraphs, keeps split-only lines, and normalizes requested spacing', async () => {
  const ctx = fresh(); await seed(ctx, { lines: 'alpha\nbeta\n\ngamma\n', spacing: 'One.  Two   words\n' });
  await output(ctx, 'fmt -w30 lines', 'alpha beta\n\ngamma\n');
  await output(ctx, 'fmt -s -w30 lines', 'alpha\nbeta\n\ngamma\n');
  await output(ctx, 'fmt -u -w40 spacing', 'One.  Two words\n');
  await output(ctx, "printf 'alpha beta gamma' | fmt -w7", 'alpha\nbeta\ngamma\n');
  assert.equal((await ctx.run('fmt -g20 -w10 lines')).code, 2);
});

test('fmt balances adjacent lines and avoids a lone final sentence word', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'one two three four five\nsix seven\n' });
  await output(ctx, 'fmt -s -w12 input', 'one two\nthree\nfour five\nsix seven\n');
});

test('fmt preserves space indentation until input tabs enable tab output and indents standalone tags', async () => {
  const ctx = fresh(); await seed(ctx, {
    spaces: '        one two three\n', tabs: '\tone two three\n', tagged: 'tag alpha beta gamma delta epsilon\n',
  });
  await output(ctx, 'fmt spaces', '        one two three\n');
  await output(ctx, 'fmt tabs', '\tone two three\n');
  await output(ctx, 'fmt -t -w16 tagged', 'tag alpha beta\n   gamma delta\n   epsilon\n');
});

test('fmt filters prefixes and preserves crown or tagged paragraph indentation', async () => {
  const ctx = fresh(); await seed(ctx, { comments: '// alpha\n// beta\ncode\n', crown: 'Title alpha beta\n  continuation words here\n', tagged: 'alpha\nbeta\n' });
  await output(ctx, "fmt -w40 -p '// ' comments", '// alpha beta\ncode\n');
  const result = await ctx.run('fmt -c -w18 crown'); assert.equal(result.code, 0, result.output);
  const lines = result.output.split('\n'); assert.ok(lines.length > 1);
  assert.match(lines[0], /^Title/); for (const line of lines.slice(1)) assert.match(line, /^  \S/);
  assert.equal(lines.join(' ').replace(/\s+/g, ' '), 'Title alpha beta continuation words here');
  await output(ctx, 'fmt -t -w40 tagged', 'alpha\nbeta\n');
});

test('expand converts tab stops and preserves other bytes with initial-only selection', async () => {
  const ctx = fresh(); await seed(ctx, { input: '\tA\tB\n', bytes: Uint8Array.of(128, 9, 255), controls: 'ab\b\tX\n' });
  await output(ctx, 'expand -t4 input', '    A   B\n');
  await output(ctx, 'expand -i -t4 input', '    A\tB\n');
  await output(ctx, 'expand -t2,5 bytes', [128, 32, 255]);
  await output(ctx, 'expand -t4 controls', 'ab\b   X\n');
  await output(ctx, 'expand -t2,,4 input', '  A B\n');
  for (const stops of ['0', '4,2', 'nope']) assert.equal((await ctx.run(`expand -t ${stops} input`)).code, 2);
});

test('unexpand preserves equivalent tab columns and first-only precedence', async () => {
  const ctx = fresh(); await seed(ctx, { input: '    A   B\n', tail: 'ab  c    d' });
  await output(ctx, 'unexpand -t4 input', '\tA\tB\n');
  await output(ctx, 'unexpand -t4 --first-only input', '\tA   B\n');
  await output(ctx, 'unexpand -a -t4 tail | expand -t4', 'ab  c    d');
  await output(ctx, 'unexpand -t4 --first-only -a input', '\tA   B\n');
});

test('column aligns explicit tables while retaining empty delimited cells and raw bytes', async () => {
  const ctx = fresh(); await seed(ctx, { table: 'a:1\nlong:2\nx::z\n', raw: Uint8Array.of(255, 58, 128, 10) });
  await output(ctx, "column -t -s: -o '|' table", 'a   |1\nlong|2\nx   | |z\n');
  await output(ctx, 'column -t -s: raw', [255, 32, 32, 128, 10]);
  assert.equal((await ctx.run('column -c nope table')).code, 2);
});

test('column uses explicit width before virtual COLUMNS and supports row-major layout', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'a\nb\nc\nd\n' });
  await output(ctx, 'column -c16 input', 'a\tc\nb\td\n');
  await output(ctx, 'column -x -c16 input', 'a\tb\nc\td\n');
  await output(ctx, 'env COLUMNS=8 column input', 'a\nb\nc\nd\n');
  await output(ctx, 'env COLUMNS=8 column -c16 input', 'a\tc\nb\td\n');
});

test('seq uses exact finite decimal stepping beyond binary64 integer precision', async () => {
  const ctx = fresh();
  await output(ctx, 'seq 3', '1\n2\n3\n');
  await output(ctx, 'seq 0.1 0.1 0.3', '0.1\n0.2\n0.3\n');
  await output(ctx, 'seq 9007199254740992 9007199254740994', '9007199254740992\n9007199254740993\n9007199254740994\n');
  await output(ctx, 'seq 1 -0.5 -1', '1.0\n0.5\n0.0\n-0.5\n-1.0\n');
  await output(ctx, 'seq 3 1', '');
  assert.equal((await ctx.run('seq 1 0 3')).code, 2);
});

test('seq formats separators, equal width, and one bounded numeric directive', async () => {
  const ctx = fresh();
  await output(ctx, "seq -s, -w 8 10", '08,09,10\n');
  await output(ctx, "seq -f '[%.2f]' 1 2", '[1.00]\n[2.00]\n');
  await output(ctx, 'seq -s -1 1 2', '1-12\n');
  await output(ctx, "seq -f '-1%.1f' 1 2", '-11.0\n-12.0\n');
  assert.equal((await ctx.run("seq -f '%f %f' 1 2")).code, 2);
  assert.equal((await ctx.run('seq nan 2')).code, 2);
});

test('shuf preserves permutations, duplicate multiplicities, and selected counts', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'a\na\nb\nc\n' });
  const full = await ctx.run('shuf input'); assert.equal(full.code, 0); assert.deepEqual(full.output.split('\n').sort(), ['a', 'a', 'b', 'c']);
  const choice = await ctx.run('shuf -n2 -e alpha beta gamma'); assert.equal(choice.code, 0);
  const words = choice.output.split('\n'); assert.equal(words.length, 2); assert.equal(new Set(words).size, 2);
  assert.ok(words.every((value) => ['alpha', 'beta', 'gamma'].includes(value)));
  await output(ctx, 'shuf -n0 input', '');
  const range = await ctx.run('shuf -i3-5 -n9'); assert.deepEqual(range.output.split('\n').sort(), ['3', '4', '5']);
});

test('shuf preserves NUL bytes, finite repeats, and input/output alias safety', async () => {
  const ctx = fresh(); await seed(ctx, { input: Uint8Array.of(255, 0, 128, 0) });
  const result = await ctx.run('shuf -z -o input input'); assert.equal(result.code, 0, result.output);
  const bytes = await ctx.bytes('input'); assert.ok(bytes.join(',') === '255,0,128,0' || bytes.join(',') === '128,0,255,0');
  await output(ctx, 'shuf -r -n3 -e only', 'only\nonly\nonly\n');
  assert.equal((await ctx.run('shuf -i5-3')).code, 2);
});

test('shuf output respects grants and staged refusal', async () => {
  const denied = fresh({ readOnlyPrefixes: ['out'] }); await seed(denied, { input: 'a\nb\n', out: 'keep' });
  assert.notEqual((await denied.run('shuf -o out input')).code, 0); assert.equal(await denied.read('out'), 'keep');
  const staged = fresh({ stageWrites: true }); await seed(staged, { input: 'a\nb\n', out: 'keep' });
  assert.ok((await staged.run('shuf -o out input')).awaitingConfirm); assert.equal(await staged.read('out'), 'keep');
  assert.equal((await staged.run('n')).code, 1); assert.equal(await staged.read('out'), 'keep');
  assert.deepEqual(staged.face.pendingProposals(), []);
});

test('tsort emits every graph vertex once in a valid topological ordering', async () => {
  const ctx = fresh(); await seed(ctx, { graph: 'a b\na c\nb d\nc d\na b\nz z\n' });
  const result = await ctx.run('tsort graph'); assert.equal(result.code, 0, result.output);
  const values = result.output.split('\n'); assert.deepEqual([...values].sort(), ['a', 'b', 'c', 'd', 'z']);
  for (const [before, after] of [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]) assert.ok(values.indexOf(before) < values.indexOf(after));
  assert.notEqual((await ctx.run("printf 'a b b a' | tsort")).code, 0);
  assert.equal((await ctx.run("printf 'a b c' | tsort")).code, 2);
});

test('expr uses exact integers and returns value-sensitive success statuses', async () => {
  const ctx = fresh();
  assert.equal((await ctx.run('expr 9007199254740993 + 2')).output, '9007199254740995');
  assert.equal((await ctx.run("expr '(' 2 + 3 ')' '*' 4")).output, '20');
  assert.equal((await ctx.run('expr -7 / 3')).output, '-2'); assert.equal((await ctx.run('expr -7 % 3')).output, '-1');
  const zero = await ctx.run('expr 1 - 1'); assert.equal(zero.output, '0'); assert.equal(zero.code, 1);
  const empty = await ctx.run("expr ''"); assert.equal(empty.output, ''); assert.equal(empty.code, 1);
  assert.equal((await ctx.run("expr keep '|' 1 / 0")).output, 'keep');
  assert.equal((await ctx.run("expr 0 '|' value")).output, 'value');
  assert.equal((await ctx.run("expr value '&' other")).output, 'value');
  assert.equal((await ctx.run("expr 2 '<' 3")).output, '1');
  assert.equal((await ctx.run('expr 1 stray')).code, 2);
});

test('expr supports anchored BRE captures and string operators without host evaluation', async () => {
  const ctx = fresh();
  assert.equal((await ctx.run("expr abc123 : '[a-z]*'")).output, '3');
  assert.equal((await ctx.run("expr abc123 : '.*\\([0-9][0-9][0-9]\\)'")).output, '123');
  assert.equal((await ctx.run('expr length abc')).output, '3');
  assert.equal((await ctx.run('expr index abcde dx')).output, '4');
  assert.equal((await ctx.run('expr substr abcdef 2 3')).output, 'bcd');
  assert.equal((await ctx.run("expr match abc '[ab]*'")).output, '2');
  assert.equal((await ctx.run("expr abc : '['")).code, 2);
});

test('numfmt scales exact SI/IEC values and preserves unselected fields', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'name value\nfirst 1.5K\nsecond 2K\n', fields: 'left:1024:right\n' });
  await output(ctx, 'cat input | numfmt --from=si --field=2 --header', 'name value\nfirst 1500\nsecond 2000\n');
  await output(ctx, 'cat fields | numfmt --to=iec-i --field=2 --delimiter=:', 'left:1.0Ki:right\n');
  await output(ctx, 'numfmt --from=auto 1Ki 1k 2M', '1024\n1000\n2000000\n');
  await output(ctx, 'numfmt --from-unit=512 --to-unit=1024 4', '2\n');
  await output(ctx, 'numfmt --from=none 9007199254740993', '9007199254740993\n');
});

test('numfmt validates formatting and explicit invalid-input policies', async () => {
  const ctx = fresh();
  await output(ctx, "numfmt --to=si --suffix=B --padding=8 1000", '   1.0kB\n');
  await output(ctx, 'numfmt --to=si -1000', '-1.0k\n');
  await output(ctx, "numfmt --to=si --format='X %f Z' 1000", 'X 1.0k Z\n');
  await output(ctx, "numfmt --format='%.0f' --round=down -- -1.1 1.1", '-2\n1\n');
  await output(ctx, "numfmt --format='%.0f' --round=up -- -1.1 1.1", '-1\n2\n');
  assert.notEqual((await ctx.run('numfmt --from=si bad')).code, 0);
  await output(ctx, 'numfmt --from=si --invalid=ignore bad 2K', 'bad\n2000\n');
  assert.equal((await ctx.run("numfmt --format='%f %f' 1")).code, 2);
});

test('ptx selects keyword occurrences from governed auxiliary files without overwriting -o', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'alfa beta gamma\n', only: 'beta\n', ignore: 'beta\n', breaks: ' \n' });
  await output(ctx, 'ptx -w20 -o only input', '      alfa   beta/\n');
  assert.equal(await ctx.read('only'), 'beta\n');
  await output(ctx, 'ptx -o only -i ignore input', '');
  await output(ctx, 'ptx -b breaks -o only -w20 input', '      alfa   beta/\n');
});

test('ptx rotates adjacent context with bounded truncation fields and exact terminal padding', async () => {
  const ctx = fresh(); await seed(ctx, {
    input: 'alfa beta gamma delta epsilon zeta eta theta iota kappa lambda mu\n', only: 'alfa\ngamma\nlambda\n',
  });
  await output(ctx, 'ptx -w40 -o only input',
    '   delta/              alfa beta gamma\n           alfa beta   gamma delta/\n          iota kappa   lambda mu     /theta\n');
  await output(ctx, 'ptx -O -w40 -o only input',
    '.xx "delta/" "" "alfa beta gamma" ""\n.xx "" "alfa beta" "gamma delta/" ""\n.xx "" "iota kappa" "lambda mu" "/theta"\n');
});

test('ptx retains whole keywords and stable gaps when width is narrower than a word or its padding', async () => {
  const ctx = fresh(); await seed(ctx, {
    input: 'alfa beta gamma\n', long: 'alfa extraordinarilylongword gamma\n', spaces: 'a' + ' '.repeat(100) + 'b\n',
  });
  await output(ctx, 'ptx -w1 input', '      alfa/\n   /   beta/\n   /   gamma\n');
  await output(ctx, 'ptx -w12 long', '         alfa/\n      /   extraordinarilylongword/\n      /   gamma\n');
  await output(ctx, 'ptx -w5 spaces', '      a/\n   /   b\n');
});

test('ptx emits every selected occurrence, ASCII-folds selection, and supports references and roff', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'ref beta Alfa beta\n', mixed: 'BETA beta\n', only: 'beta\n' });
  const plain = await ctx.run('ptx -r -o only -w40 input'); assert.equal(plain.code, 0, plain.output);
  assert.equal(plain.output.split('\n').length, 2); assert.ok(plain.output.split('\n').every((line) => line.includes('ref') && line.includes('beta')));
  const roff = await ctx.run('ptx -r -O -o only input'); assert.equal(roff.code, 0, roff.output);
  assert.ok(roff.output.split('\n').every((line) => /^\.xx "/.test(line) && /"ref"$/.test(line)));
  const folded = await ctx.run('ptx -f -o only mixed'); assert.equal(folded.code, 0, folded.output);
  assert.equal(folded.output.split('\n').length, 2);
  const sensitive = await ctx.run('ptx -o only mixed'); assert.equal(sensitive.output.split('\n').length, 1);
  assert.equal((await ctx.run('ptx --format=unknown input')).code, 2);
});

test('factor returns complete exact prime factors for nonnegative 64-bit integers', async () => {
  const ctx = fresh();
  await output(ctx, 'factor 0 1 12 97 4294967296', '0:\n1:\n12: 2 2 3\n97: 97\n4294967296: ' + Array(32).fill('2').join(' ') + '\n');
  await output(ctx, "printf '15 49\n' | factor", '15: 3 5\n49: 7 7\n');
  assert.equal((await ctx.run('factor 18446744073709551616')).code, 2);
  assert.equal((await ctx.run('factor -- -1')).code, 2);
  assert.equal((await ctx.run('factor 1.5')).code, 2);
});

test('printenv and yes are public commands with ordinary finite compositions', async () => {
  const ctx = fresh();
  await output(ctx, 'env U2_VALUE=present printenv U2_VALUE', 'present\n');
  await output(ctx, 'yes word | head -n2', 'word\nword\n');
});

test('new commands reject unknown options before any output-file mutation', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'a\n', output: 'keep' });
  for (const command of commands) {
    const result = await ctx.run(`${command} --u2-unsupported-flag`);
    assert.equal(result.code, 2, `${command}: ${result.output}`);
  }
  for (const command of ['split --u2-unsupported-flag input output', 'shuf --u2-unsupported-flag -o output input']) {
    assert.equal((await ctx.run(command)).code, 2); assert.equal(await ctx.read('output'), 'keep');
  }
});

test('ordinary and auxiliary reads preserve grant refusals without exposing input bytes', async () => {
  const ctx = fresh({ prefixes: ['allowed'] }); await seed(ctx, { 'allowed/input': 'public\n', secret: 'NEVER_PRINT_SECRET\n' });
  for (const command of ['tac secret', 'rev secret', 'fmt secret', 'column secret', 'ptx -i secret allowed/input', 'ptx -o secret allowed/input']) {
    const result = await ctx.run(command); assert.notEqual(result.code, 0, command);
    assert.doesNotMatch(result.output, /NEVER_PRINT_SECRET/); assert.match(result.output, /EGRANT|grant|denied/i);
  }
  assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('layout tools report missing operands while still processing later readable inputs', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'visible\n' });
  for (const command of ['fold', 'fmt', 'expand', 'unexpand', 'column', 'ptx']) {
    const result = await ctx.run(`${command} missing input`); assert.equal(result.code, 1, result.output);
    assert.match(result.output, /missing/); assert.match(result.output, /visible/);
  }
});

test('oversized ordinary and ptx auxiliary inputs fail before full backend reads', async () => {
  const ctx = fresh(); await seed(ctx, { huge: 'small placeholder', input: 'word\n' });
  const originalStat = ctx.backend.stat.bind(ctx.backend), originalRead = ctx.backend.readBinary.bind(ctx.backend); let reads = 0;
  ctx.backend.stat = async (path, options) => { const stat = await originalStat(path, options); return path === 'huge' && stat ? { ...stat, size: 65 * 1024 * 1024 } : stat; };
  ctx.backend.readBinary = async (...args) => { if (args[0] === 'huge') reads++; return originalRead(...args); };
  for (const command of ['rev huge', 'column huge', 'ptx -o huge input', 'split huge part']) {
    const result = await ctx.run(command); assert.equal(result.code, 2, result.output); assert.match(result.output, /limit|exceed|EFBIG/i);
  }
  assert.equal(reads, 0); assert.equal((await ctx.fs.stat('partaa')).ok, false);
});

test('injected small layout budgets reject padding and occurrence growth before oversized output', async () => {
  const ctx = fresh();
  const small = createLayoutCommands(ctx.io, { limits: { maxOutputBytes: 8, maxRecords: 8 } });
  await assert.rejects(small.expand(['-t100'], '\t'), /expand:.*limit|expand:.*exceed/i);
  await assert.rejects(small.column(['-t'], 'a b\nlong c\n'), /column:.*limit|column:.*exceed/i);
  await assert.rejects(small.ptx([], 'a b c d e f g h i'), /ptx:.*limit|ptx:.*exceed/i);
  const empty = createLayoutCommands(ctx.io, { limits: { maxOutputBytes: 0 } });
  assert.equal((await empty.fold([], '')).text.length, 0);
});

test('record output forks share budgets and preflight split destinations before writes', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'abc' });
  const records = createRecordCommands(ctx.io, { limits: { maxOutputBytes: 2 } });
  await assert.rejects(records.split(['-b1', 'input', 'part'], ''), /limit|exceed/i);
  assert.equal((await ctx.fs.stat('partaa')).ok, false); assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('numeric generators bound output and graph work with small explicit limits', async () => {
  const ctx = fresh();
  const numeric = createNumericCommands(ctx.io, { randomBytes: (count) => new Uint8Array(count), limits: { maxOutputBytes: 8, maxRecords: 3 } });
  await assert.rejects(numeric.seq(['1', '100'], ''), /seq:.*limit|seq:.*exceed/i);
  await assert.rejects(numeric.shuf(['-r', '-n100', '-e', 'value'], ''), /shuf:.*limit|shuf:.*exceed/i);
  await assert.rejects(numeric.tsort([], 'a b b c c d d e'), /tsort:.*limit|tsort:.*exceed/i);
});

test('Stop during staged split prevents later writes and leaves an independent command usable', async () => {
  const ctx = fresh({ stageWrites: true }); await seed(ctx, { input: 'abc' });
  assert.ok((await ctx.run('split -b1 input part')).awaitingConfirm);
  await ctx.shell.cancel(); assert.equal(ctx.shell.lastCode, 130);
  assert.deepEqual(ctx.face.pendingProposals(), []); assert.equal((await ctx.fs.stat('partaa')).ok, false);
  assert.equal((await ctx.run('expr 1 + 2')).output, '3');
});

test('layout CPU work yields to Stop before a later shell mutation', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'word '.repeat(12000) });
  const pending = ctx.run('fmt -w80 input; touch after-stop');
  setTimeout(() => ctx.shell.cancel(), 0);
  const result = await pending; assert.equal(result.code, 130);
  assert.equal((await ctx.fs.stat('after-stop')).ok, false); assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal((await ctx.run('expr 2 + 3')).output, '5');
});
