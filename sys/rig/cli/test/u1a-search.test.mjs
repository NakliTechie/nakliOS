import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { applyPatch } from '../../fileops/patch.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createAgentFace, createGrant, createOpLog } from '../../agent/index.mjs';
import { createIO } from '../io.mjs';
import { createSearchCommands } from '../cmds/search.mjs';

function fixture({ prefixes = [''], index = true, backend = new MemoryBackend() } = {}) {
  const fs = createFileops({ backend, index, exclusive: true });
  const registry = buildRigRegistry({ fs });
  const face = createAgentFace({ registry, grant: createGrant({ prefixes, scopes: ['fs:read'] }),
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }) });
  const calls = [];
  let cwd = '';
  const io = createIO({ cwd: () => cwd, invoke: async (name, input) => {
    calls.push({ name, input }); return face.invoke(name, input);
  } });
  return { fs, backend, registry, calls, commands: createSearchCommands(io), cd: (path) => { cwd = path; },
    write: (path, content) => fs.write(path, content, { createParents: true }) };
}

test('grep combines repeated patterns, pattern files, literals, whole words and whole lines', async () => {
  const { commands: c, write } = fixture();
  await write('words', 'cat\nscatter\ncat dog\ncat_cat\nCat\n.\n');
  await write('patterns', 'cat\ndog\n');
  assert.equal((await c.grep(['-iwo', '-f', 'patterns', 'words'])).text, 'cat\ncat\ndog\nCat\n');
  assert.equal((await c.grep(['-x', '-e', 'cat', '-e', 'dog', 'words'])).text, 'cat\n');
  assert.equal((await c.grep(['-F', '.', 'words'])).text, '.\n');
  assert.equal((await c.grep(['-ivx', 'cat', 'words'])).text, 'scatter\ncat dog\ncat_cat\n.\n');
  assert.equal((await c.grep(['-f', '-', 'words'], 'dog\n')).text, 'cat dog\n');
});

test('grep -o emits nonoverlapping occurrences and never prints empty matches', async () => {
  const { commands: c } = fixture();
  assert.equal((await c.grep(['-no', '-e', 'aa', '-e', 'aaa'], 'aaaa aa\n')).text, '1:aaa\n1:aa\n');
  const empty = await c.grep(['-o', '^'], 'a\n');
  assert.equal(empty.text, ''); assert.equal(empty.code, 0);
  const inverted = await c.grep(['-vo', 'yes'], 'no\n');
  assert.equal(inverted.text, ''); assert.equal(inverted.code, 0);
});

test('grep file modes, count limits and quiet status handle errors without dropping later files', async () => {
  const { commands: c, write } = fixture();
  await write('a', 'hit\nhit again\n'); await write('b', 'other\n');
  assert.equal((await c.grep(['-l', 'hit', 'a', 'b'])).text, 'a\n');
  const without = await c.grep(['-L', 'hit', 'a', 'b']);
  assert.equal(without.text, 'b\n'); assert.equal(without.code, 0);
  assert.equal((await c.grep(['-L', 'hit', 'b'])).code, 1);
  assert.equal((await c.grep(['-cm1', 'hit', 'a', 'b'])).text, 'a:1\nb:0\n');
  assert.equal((await c.grep(['-m0', 'hit', 'a'])).code, 1);
  const error = await c.grep(['-n', 'hit', 'missing', 'a']);
  assert.equal(error.code, 2); assert.match(error.stderr, /missing: ENOENT/); assert.match(error.text, /a:2:hit again/);
  assert.deepEqual(await c.grep(['-sq', 'hit', 'missing', 'a']), { text: '', stdout: '', stderr: '', code: 0, raw: true });
  assert.deepEqual(await c.grep(['-s', 'hit', 'missing']), { text: '', stdout: '', stderr: '', code: 2, raw: true });
  assert.deepEqual(await c.grep(['-sf', 'missing', 'a']), { text: '', stdout: '', stderr: '', code: 2, raw: true });
});

test('grep context merges adjacent ranges and keeps match versus context delimiters', async () => {
  const { commands: c, write } = fixture();
  await write('lines', 'zero\nhit\ntwo\nthree\nfour\nfive\nhit\nseven\n');
  assert.equal((await c.grep(['-n', '-B1', '-A1', 'hit', 'lines'])).text,
    '1-zero\n2:hit\n3-two\n--\n6-five\n7:hit\n8-seven\n');
  assert.equal((await c.grep(['-n', '-C2', '-A0', '-m1', 'hit', 'lines'])).text, '1-zero\n2:hit\n');
  assert.equal((await c.grep(['-nC1', 'hit'], 'hit\nhit\nx\n')).text, '1:hit\n2:hit\n3-x\n');
});

test('recursive grep delegates to indexed fs.grep, passes case flags and filters files', async () => {
  const { commands: c, fs, write, calls } = fixture();
  await write('src/a.js', 'RareSymbol\n'); await write('src/deep/b.js', 'raresymbol\n');
  await write('src/deep/drop.js', 'RareSymbol\n'); await write('src/c.txt', 'RareSymbol\n');
  for (let i = 0; i < 20; i++) await write(`src/fill${i}.js`, 'unrelated filler\n');
  const args = ['-rni', '--include=*.js', '--exclude=drop.js', 'raresymbol', 'src'];
  await c.grep(args); const found = await c.grep(args);
  assert.equal(found.text, 'src/a.js:1:RareSymbol\nsrc/deep/b.js:1:raresymbol\n');
  assert.equal(found.code, 0);
  const request = calls.find((call) => call.name === 'fs.grep');
  assert.equal(request.input.cwd, 'src'); assert.equal(request.input.flags, 'i');
  const sample = fs.searchStats().recent.filter((row) => row.via === 'fs.grep').at(-1);
  assert.equal(sample.indexUsed, true); assert.ok(sample.filesRead < 10);
  assert.equal((await c.grep(['-Rh', 'raresymbol', 'src/deep'])).text, 'raresymbol\n');
});

test('recursive grep excludes phantom trailing lines while counting real empty lines', async () => {
  const { commands: c, write } = fixture();
  await write('src/a', 'x\n'); await write('src/b', '\n'); await write('src/c', '');
  assert.equal((await c.grep(['-rnc', '^$', 'src'])).text, 'src/a:0\nsrc/b:1\nsrc/c:0\n');
  await write('empty-patterns', '');
  assert.equal((await c.grep(['-r', '-f', 'empty-patterns', 'src'])).code, 1);
  assert.equal((await c.grep(['-rvc', '-f', 'empty-patterns', 'src'])).text, 'src/a:1\nsrc/b:1\nsrc/c:0\n');
});

test('multiple backreference patterns remain correct through recursive inverted candidates', async () => {
  const { commands: c, write } = fixture();
  await write('src/a', 'aa\nbb\ncc\n');
  assert.equal((await c.grep(['-rv', '-e', '(a)\\1', '-e', '(b)\\1', 'src'])).text, 'src/a:cc\n');
});

test('file prefix overrides and include/exclude precedence follow occurrence order', async () => {
  const { commands: c, write } = fixture();
  await write('src/a.js', 'hit\n'); await write('src/b.txt', 'hit\n'); await write('src/c.md', 'hit\n');
  assert.equal((await c.grep(['-Hh', 'hit', 'src/a.js'])).text, 'hit\n');
  assert.equal((await c.grep(['-hH', 'hit', 'src/a.js'])).text, 'src/a.js:hit\n');
  assert.equal((await c.grep(['-rl', '--exclude=*.txt', '--include=*.txt', 'hit', 'src'])).text,
    'src/a.js\nsrc/b.txt\nsrc/c.md\n');
  assert.equal((await c.grep(['-rl', '--include=*.js', '--exclude=a.js', 'hit', 'src'])).text, '');
});

test('rg retains types, globs, filename modes, default line numbers and direct-file indexing', async () => {
  const { commands: c, write, calls, cd } = fixture();
  await write('src/a.py', 'Cat scatter cat.\nother\n');
  await write('src/deep/b.py', 'cat\n'); await write('src/drop.py', 'cat\n'); await write('src/a.js', 'cat\n');
  cd('src');
  assert.equal((await c.rg(['-iwo', '-tpy', '-g', '!drop.py', 'cat'])).text,
    'a.py:1:Cat\na.py:1:cat\ndeep/b.py:1:cat\n');
  assert.equal((await c.rg(['--files', '-t', 'js'])).text, 'a.js\n');
  assert.equal((await c.rg(['-c', '-F', 'cat.', 'a.py'])).text, 'a.py:1\n');
  assert.equal(calls.filter((call) => call.name === 'fs.grep').at(-1).input.glob, 'a.py');
  assert.equal((await c.rg(['-l', '-v', 'cat', 'deep'])).code, 1);
  const bad = await c.rg(['--files', 'missing']);
  assert.equal(bad.code, 2); assert.match(bad.stderr, /no such file/);
});

test('rg context and inverted fixed matching share the granted indexed route', async () => {
  const { commands: c, write } = fixture();
  await write('a', 'before\nneedle.\nafter\nlast\n');
  assert.equal((await c.rg(['-F', '-C1', 'needle.', 'a'])).text, 'a-1-before\na:2:needle.\na-3-after\n');
  assert.equal((await c.rg(['-Fv', 'needle.', 'a'])).text, 'a:1:before\na:3:after\na:4:last\n');
  assert.equal((await c.rg(['-A1', '-B0', 'needle', 'a'])).text, 'a:2:needle.\na-3-after\n');
});

test('search reports per-file backend failures and continues through readable files', async () => {
  class FailingBackend extends MemoryBackend {
    async readBinary(path) {
      if (path === 'src/broken') throw Object.assign(new Error('unreadable file'), { code: 'EACCES' });
      return super.readBinary(path);
    }
  }
  for (const index of [false, true]) {
    const { commands: c, write, fs } = fixture({ backend: new FailingBackend(), index });
    await write('src/broken', 'needle\n'); await write('src/good', 'needle\n');
    const result = await c.grep(['-r', 'needle', 'src']);
    assert.equal(result.code, 2); assert.match(result.stderr, /src\/broken: EACCES/); assert.match(result.text, /src\/good:needle/);
    const scan = await fs.grep('needle', { cwd: 'src' });
    assert.equal(scan.ok, true); assert.deepEqual(scan.errors.map((error) => error.path), ['src/broken']);
    const silent = await c.grep(['-rs', 'needle', 'src']);
    assert.equal(silent.code, 2); assert.equal(silent.text, 'src/good:needle\n');
  }
});

test('search honors directory grants and direct-file grants without exposing siblings', async () => {
  const allowed = fixture({ prefixes: ['allowed'] });
  await allowed.write('allowed/a', 'needle\n'); await allowed.write('private/a', 'secret needle\n');
  const denied = await allowed.commands.grep(['-r', 'needle', '/']);
  assert.equal(denied.code, 2); assert.match(denied.stderr, /EGRANT/); assert.doesNotMatch(denied.text, /secret/);
  assert.equal((await allowed.commands.grep(['-r', 'needle', 'allowed'])).text, 'allowed/a:needle\n');
  const fileOnly = fixture({ prefixes: ['allowed/a'] });
  await fileOnly.write('allowed/a', 'needle\n'); await fileOnly.write('allowed/private', 'secret needle\n');
  assert.equal((await fileOnly.commands.rg(['needle', 'allowed/a'])).text, 'allowed/a:1:needle\n');
  assert.equal((await fileOnly.commands.rg(['needle', 'allowed/private'])).code, 2);
});

test('grep counts direct binary matches while rg skips NUL binary files', async () => {
  const { commands: c, write } = fixture();
  await write('binary', 'hit\0byte\nhit\n');
  assert.equal((await c.grep(['hit', 'binary'])).text, 'Binary file binary matches\n');
  assert.equal((await c.grep(['-c', 'hit', 'binary'])).text, '2\n');
  assert.equal((await c.grep(['-l', 'hit', 'binary'])).text, 'binary\n');
  assert.equal((await c.rg(['hit', 'binary'])).code, 1);
});

test('all search commands reject unknown flags and malformed counts', async () => {
  const { commands: c } = fixture();
  for (const [name, argv] of [['grep', ['--unknown', 'x']], ['rg', ['--unknown', 'x']], ['diff', ['--unknown', 'a', 'b']],
    ['grep', ['-m-1', 'x']], ['rg', ['-A', 'bad', 'x']]]) {
    await assert.rejects(c[name](argv), (error) => error.code === 2);
  }
  assert.equal((await c.grep(['['])).code, 2);
  assert.equal((await c.rg(['-t', 'unknown', 'x'])).code, 2);
});

test('diff unified output applies cleanly and preserves missing final newlines', async () => {
  const { commands: c, write } = fixture();
  const before = 'one\nold\nthree\n', after = 'one\nnew\nthree';
  await write('a', before); await write('b', after);
  const unified = await c.diff(['-u', 'a', 'b']);
  assert.equal(unified.code, 1); assert.match(unified.text, /^--- a\n\+\+\+ b\n@@/);
  assert.match(unified.text, /No newline at end of file/);
  assert.deepEqual(applyPatch(before, unified.text), { ok: true, result: after });
  assert.equal((await c.diff(['-q', 'a', 'b'])).text, 'Files a and b differ\n');
  assert.equal((await c.diff(['a', 'a'])).code, 0);
});

test('diff ignores requested case and whitespace without replacing original hunk text', async () => {
  const { commands: c, write } = fixture();
  await write('a', 'Hello  world\nKeep Me\n'); await write('b', 'hello\tworld\nKeep Me\n');
  assert.equal((await c.diff(['-bi', 'a', 'b'])).code, 0);
  assert.equal((await c.diff(['-b', 'a', 'b'])).code, 1);
  await write('b', 'Helloworld\nKeep Me\n');
  assert.equal((await c.diff(['-w', 'a', 'b'])).code, 0);
  assert.equal((await c.diff(['-b', 'a', 'b'])).code, 1);
  await write('b', 'Hello world\nNew Text\n');
  const changed = await c.diff(['-ub', 'a', 'b']);
  assert.match(changed.text, / Hello  world\n-Keep Me\n\+New Text/);
});

test('diff -N creates and removes text with original whitespace preserved', async () => {
  const { commands: c, write } = fixture();
  await write('present', 'Hello  WORLD\n');
  const added = await c.diff(['-uNwi', 'absent', 'present']);
  assert.equal(added.code, 1); assert.match(added.text, /\+Hello  WORLD/); assert.doesNotMatch(added.text, /undefined/);
  assert.deepEqual(applyPatch('', added.text), { ok: true, result: 'Hello  WORLD\n' });
  const removed = await c.diff(['-uN', 'present', 'absent']);
  assert.deepEqual(applyPatch('Hello  WORLD\n', removed.text), { ok: true, result: '' });
  assert.equal((await c.diff(['present', 'absent'])).code, 2);
});

test('diff recursively compares directory unions and treats absent entries as empty with -N', async () => {
  const { commands: c, write } = fixture();
  await write('left/same', 'same\n'); await write('right/same', 'same\n');
  await write('left/sub/changed', 'old\n'); await write('right/sub/changed', 'new\n');
  await write('left/only', 'left\n'); await write('right/new/deep', 'new file\n');
  const shallow = await c.diff(['left', 'right']);
  assert.equal(shallow.code, 1); assert.match(shallow.text, /Common subdirectories: left\/sub and right\/sub/);
  const recursive = await c.diff(['-qr', 'left', 'right']);
  assert.equal(recursive.code, 1); assert.match(recursive.text, /Files left\/sub\/changed and right\/sub\/changed differ/);
  assert.match(recursive.text, /Only in left: only/); assert.match(recursive.text, /Only in right: new/);
  const missing = await c.diff(['-ruN', 'left', 'right']);
  assert.match(missing.text, /--- left\/new\/deep\n\+\+\+ right\/new\/deep/);
  assert.match(missing.text, /--- left\/only\n\+\+\+ right\/only/);
  assert.doesNotMatch(missing.text, /ENOENT/);
});

test('diff handles file-directory pairs, binary bytes and grant failures', async () => {
  const { commands: c, write } = fixture();
  await write('a', 'same\n'); await write('dir/a', 'same\n');
  assert.equal((await c.diff(['a', 'dir'])).code, 0);
  await write('a', Uint8Array.of(255, 0)); await write('b', Uint8Array.of(254, 0));
  assert.equal((await c.diff(['-u', 'a', 'b'])).text, 'Binary files a and b differ\n');
  const restricted = fixture({ prefixes: ['allowed'] });
  await restricted.write('allowed/a', 'a'); await restricted.write('private/a', 'private');
  const denied = await restricted.commands.diff(['allowed/a', 'private/a']);
  assert.equal(denied.code, 2); assert.match(denied.stderr, /EGRANT/); assert.doesNotMatch(denied.text, /\+ private/);
});

test('registry fs.grep exposes regex flags and returns case-insensitive matches', async () => {
  const { registry, commands: c, calls, write } = fixture();
  const command = registry.commands.find((entry) => entry.name === 'fs.grep');
  assert.equal(command.inputSchema.properties.flags.type, 'string');
  await write('a', 'UPPER\n');
  assert.equal((await command.run({ pattern: 'upper', flags: 'i' })).matches[0].text, 'UPPER');
  assert.equal((await c.rg(['-i', 'upper'])).text, 'a:1:UPPER\n');
  assert.equal(calls.find((call) => call.name === 'fs.grep').input.flags, 'i');
});
