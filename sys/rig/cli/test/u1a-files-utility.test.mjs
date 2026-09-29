import test from 'node:test';
import assert from 'node:assert/strict';
import { createShell } from '../shell.mjs';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';

function fresh({ scopes = ['fs:read', 'fs:write', 'fs:remove'], signal } = {}) {
  const backend = new MemoryBackend(), fs = createFileops({ backend });
  const registry = buildRigRegistry({ fs });
  const face = createAgentFace({ registry, grant: createGrant({ prefixes: [''], scopes }),
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'test' });
  const shell = createShell({ registry, face, signal });
  const run = async (command) => { const r = await shell.feed(command); return { ...r, code: shell.lastCode }; };
  const read = async (path) => (await fs.read(path, { encoding: 'utf-8' })).data;
  return { fs, backend, shell, run, read };
}

test('cat numbering, squeezing and visible characters preserve the intended bytes', async () => {
  const { fs, run, read } = fresh();
  await fs.write('input', 'a\n\n\n\tb\n');
  assert.equal((await run('cat -nbsET input > result')).code, 0);
  assert.equal(await read('result'), '     1\ta$\n$\n     2\t^Ib$\n');
  await fs.write('binary', Uint8Array.of(0, 255, 9, 10));
  assert.equal((await run('cat -A binary')).output, '^@M-^?^I$');
  await fs.write('crlf', 'a\r\nb\r');
  assert.equal((await run('cat -E crlf')).output, 'a^M$\nb\r');
  assert.equal((await run('cat --unsupported input')).code, 2);
});

test('tee appends bytes, keeps later operands after failure, and reports the failure', async () => {
  const { fs, run } = fresh();
  await fs.write('input', Uint8Array.of(0, 255, 10));
  await fs.write('out', Uint8Array.of(128));
  await fs.mkdir('dir');
  assert.equal((await run('cat input | tee -a out dir later > pipe')).code, 1);
  assert.deepEqual(Array.from((await fs.read('out')).data), [128, 0, 255, 10]);
  assert.deepEqual(Array.from((await fs.read('later')).data), [0, 255, 10]);
});

test('file flags never clobber when -n is requested and -t requires a directory', async () => {
  const { fs, run, read } = fresh();
  await fs.write('a', 'source'); await fs.write('b', 'keep'); await fs.mkdir('dir');
  assert.equal((await run('cp -n a b')).code, 0); assert.equal(await read('b'), 'keep');
  assert.equal((await run('mv -n a b')).code, 0); assert.equal(await read('a'), 'source');
  assert.equal((await run('cp -t dir a b')).code, 0);
  assert.equal(await read('dir/a'), 'source'); assert.equal(await read('dir/b'), 'keep');
  assert.equal((await run('mv -t b a')).code, 1); assert.equal(await read('a'), 'source');
  assert.equal((await run('cp dir copy')).code, 1);
  assert.equal((await run('cp -r dir copy')).code, 0); assert.equal(await read('copy/b'), 'keep');
});

test('touch -c, mkdir -v, and stat -c state their actual outcomes', async () => {
  const { fs, run } = fresh();
  assert.equal((await run('touch -c absent')).code, 0); assert.equal((await fs.stat('absent')).ok, false);
  assert.equal((await run('mkdir -pv a/b')).output, "mkdir: created directory 'a'\nmkdir: created directory 'a/b'");
  assert.equal((await run('mkdir -pv a/b')).output, '');
  await fs.write('a/b/f', 'abc');
  assert.equal((await run("stat -c '%n %s %F %%' a/b/f")).output, 'a/b/f 3 regular file %');
  assert.equal((await run("stat -c '%%a' a/b/f")).output, '%a');
  assert.equal((await run("stat -c '%' a/b/f")).code, 2);
  assert.equal((await run("stat -c '%a' a/b/f")).code, 2);
});

test('rm -d removes only empty directories and verbose output follows acceptance', async () => {
  const { fs, run, shell } = fresh();
  await fs.mkdir('empty'); await fs.mkdir('full'); await fs.write('full/kept', 'data');
  assert.equal((await run('rm empty')).code, 1); assert.equal(Boolean(shell.awaitingConfirm), false);
  assert.equal((await run('rm -d full')).code, 1); assert.equal(Boolean(shell.awaitingConfirm), false);
  const staged = await run('rm -dv empty'); assert.match(staged.output, /confirm/);
  assert.equal((await fs.stat('empty')).ok, true);
  assert.match((await run('y')).output, /removed 'empty'/); assert.equal((await fs.stat('empty')).ok, false);
  assert.equal((await run('rm -f missing')).code, 0); assert.equal((await run('rm -f')).code, 0);
  assert.equal((await fs.read('full/kept')).ok, true);
});

test('ls flags select, classify, and order without truncating pipe data', async () => {
  const { fs, backend, run } = fresh();
  await fs.write('a', '1234'); await fs.write('b', 'x'); await fs.write('.hidden', 'h'); await fs.mkdir('dir');
  const original = backend.stat.bind(backend);
  backend.stat = async (p) => { const st = await original(p); return st ? { ...st, mtimeMs: p === 'a' ? 10 : p === 'b' ? 20 : 0 } : st; };
  assert.equal((await run('ls -1SF')).output, 'a\nb\ndir/');
  assert.equal((await run('ls -1t a b')).output, 'b\na');
  assert.equal((await run('ls -1Sr a b')).output, 'b\na');
  assert.match((await run('ls -A')).output, /\.hidden/);
  assert.equal((await run('ls -dF dir')).output, 'dir/');
  assert.equal((await run('ls -lh a')).output, '- 4 a');
});

test('env isolates variables and cwd while forwarding exact binary stdin', async () => {
  const { fs, run, read } = fresh();
  await run('export KEEP=yes'); await fs.mkdir('dir');
  assert.equal((await run('env -i FOO=bar env')).output, 'FOO=bar');
  assert.equal((await run('env -i FOO=bar env -u FOO')).output, '');
  await run('env cd dir'); assert.equal((await run('pwd')).output, '/');
  assert.equal((await run('echo $KEEP')).output, 'yes'); assert.equal((await run('echo $FOO')).output, '');
  await fs.write('binary', Uint8Array.of(255, 0, 128));
  await run('cat binary | env -i cat > copy');
  assert.deepEqual(Array.from((await fs.read('copy')).data), [255, 0, 128]);
  await run('env -i printf hi > output'); assert.equal(await read('output'), 'hi');
  assert.equal((await run('env missing-command')).code, 127);
});

test('ls metadata flags do not turn a symlink into a recursive directory', async () => {
  const { fs, backend, run } = fresh();
  await fs.write('file', 'content'); backend.symlink('loop', '.');
  const list = backend.list.bind(backend);
  let calls = 0;
  backend.list = async (...args) => {
    assert.ok(++calls <= 4, 'listing must not follow the parent link repeatedly');
    return list(...args);
  };
  for (const command of ['ls -RhF', 'ls -RSF', 'ls -RtF']) {
    calls = 0;
    const result = await run(command);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /\nloop(?:\n|$)/);
    assert.doesNotMatch(result.output, /loop[:/]/);
  }
});

test('test expressions apply grouping and precedence, reject invalid integers, and compare timestamps', async () => {
  const { fs, backend, run } = fresh();
  await fs.write('older', 'a'); await fs.write('newer', 'b');
  const original = backend.stat.bind(backend);
  backend.stat = async (p) => { const st = await original(p); return st ? { ...st, mtimeMs: p === 'newer' ? 20 : 10 } : st; };
  for (const expression of ['test !', "[ '(' ]", "test ')'", "test ! ''", 'test 1 -eq 1 -o 2 -eq 3 -a 4 -eq 5', "[ '(' -f older -a -f newer ')' -a ! -d older ]", 'test newer -nt older', 'test older -ot newer', 'test newer -nt missing']) {
    assert.equal((await run(expression)).code, 0, expression);
  }
  assert.equal((await run('test 2 -eq 3 -a 1 -eq 1')).code, 1);
  assert.equal((await run('test nope -eq 0')).code, 2);
  assert.equal((await run("test '(' x")).code, 2);
});

test('xargs supports batches, quotes, NUL delimiters, replacement and line counts', async () => {
  const { run } = fresh();
  assert.equal((await run("printf 'a b c' | xargs -n2 echo")).output, 'a b\nc');
  assert.equal((await run('printf "a\\0b c\\0" | xargs -0 -n1 printf "[%s]\\n"')).output, '[a]\n[b c]');
  assert.equal((await run("printf 'a:b:c' | xargs -d: -n2 echo")).output, 'a b\nc');
  assert.equal((await run("printf 'one\\ntwo\\n' | xargs -I{} echo x{}y")).output, 'xoney\nxtwoy');
  assert.equal((await run("printf 'a  b\\n' | xargs -I{} printf '[%s]' '{}' ")).output, '[a  b]');
  assert.equal((await run("printf 'a b\\nc d\\ne\\n' | xargs -L2 echo")).output, 'a b c d\ne');
  assert.equal((await run("printf 'a \\nb\\n' | xargs -L1 echo")).output, 'a b');
  assert.equal((await run("printf 'a b\\nc d\\n' | xargs -n1 -L1 echo")).output, 'a b\nc d');
  assert.equal((await run("printf 'a b\\nc d\\n' | xargs -L1 -n1 echo")).output, 'a\nb\nc\nd');
  assert.equal((await run("printf 'a b\\n' | xargs -I{} -n1 echo '{}' ")).output, 'a b');
  assert.equal((await run("printf 'a b\\n' | xargs -I{} -n2 echo '{}' ")).output, '{} a b');
  assert.equal((await run("printf '\"a b\" c' | xargs -n1 echo")).output, 'a b\nc');
  assert.equal((await run("printf '' | xargs -r echo UNUSED")).output, '');
  assert.equal((await run('echo a | xargs -n0 echo')).code, 2);
  assert.equal((await run('echo a | xargs false')).code, 123);
});

test('name helpers and sleep suffixes retain refusals and interruption', async () => {
  const { run } = fresh();
  assert.equal((await run('basename -s .js src/a.js lib/b.js')).output, 'a\nb');
  assert.equal((await run('basename -a /a /b')).output, 'a\nb');
  assert.equal((await run('dirname / a/b/// c')).output, '/\na\n.');
  assert.equal((await run('which -a cat ls')).output, 'cat\nls');
  assert.equal((await run('sleep 0m 0h 0d')).code, 0);
  assert.equal((await run('sleep 1d')).code, 1);
  const controller = new AbortController(); const second = fresh({ signal: controller.signal });
  const pending = second.run('sleep 1m; echo SHOULD_NOT_RUN');
  controller.abort(); const stopped = await pending;
  assert.equal(stopped.code, 130); assert.doesNotMatch(stopped.output, /SHOULD_NOT_RUN/);
});

test('new write paths retain the grant boundary', async () => {
  const { fs, run } = fresh({ scopes: ['fs:read'] });
  await fs.write('src', 'data');
  for (const command of ['cat src | tee -a target', 'cp -t . src', 'touch missing', 'mkdir -p blocked', 'env cp src copy']) {
    assert.notEqual((await run(command)).code, 0, command);
  }
  assert.equal((await fs.stat('target')).ok, false); assert.equal((await fs.stat('copy')).ok, false);
});

test('Stop during later xargs batches preserves earlier output and cancels remaining writes', async () => {
  const { fs, run, shell } = fresh();
  await fs.write('first', 'one'); await fs.write('second', 'two');
  assert.match((await run("printf 'first\\nsecond\\n' | xargs -n1 rm -v; echo BAD > after-stop")).output, /confirm/);
  assert.match((await run('y')).output, /confirm/);
  const stopped = await shell.cancel();
  assert.equal(shell.lastCode, 130); assert.match(stopped.output, /removed 'first'/);
  assert.match(stopped.output, /interrupted/);
  assert.equal((await fs.stat('first')).ok, false); assert.equal((await fs.stat('second')).ok, true);
  assert.equal((await fs.stat('after-stop')).ok, false);
  assert.equal((await run('cat second')).output, 'two');
});

test('cp and mv preserve files when a trailing slash requires a directory', async () => {
  const { fs, run, read } = fresh();
  await fs.write('source', 'source bytes');
  await fs.write('destination', 'keep destination');
  for (const command of [
    'cp source destination/', 'mv source destination/',
    'cp source missing/', 'mv source missing/',
    'cp source/ copied', 'mv source/ copied',
    'cp -n source/ destination', 'mv -n source/ destination',
  ]) {
    const result = await run(command);
    assert.equal(result.code, 1, command);
    assert.match(result.output, /not a directory/, command);
    assert.equal(await read('source'), 'source bytes', command);
    assert.equal(await read('destination'), 'keep destination', command);
    assert.equal((await fs.stat('missing')).ok, false, command);
    assert.equal((await fs.stat('copied')).ok, false, command);
  }
  await fs.mkdir('directory');
  assert.equal((await run('cp source directory/')).code, 0, 'an actual directory with a trailing slash remains valid');
  assert.equal(await read('directory/source'), 'source bytes');
});

test('cp -r merges an existing destination tree and preserves empty directories and binary content', async () => {
  const { fs, run, read } = fresh();
  await fs.mkdir('source/empty/deep', { createParents: true });
  await fs.write('source/shared', 'replacement');
  await fs.write('source/nested/new', Uint8Array.of(0, 255, 128), { createParents: true });
  await fs.mkdir('destination/source/retained-empty', { createParents: true });
  await fs.write('destination/source/shared', 'old');
  await fs.write('destination/source/unrelated', 'keep');
  await fs.write('destination/source/nested/retained', 'also keep', { createParents: true });
  const copied = await run('cp -r source/ destination/');
  assert.equal(copied.code, 0, copied.output);
  assert.equal(await read('destination/source/shared'), 'replacement');
  assert.equal(await read('destination/source/unrelated'), 'keep');
  assert.equal(await read('destination/source/nested/retained'), 'also keep');
  assert.deepEqual(Array.from((await fs.read('destination/source/nested/new')).data), [0, 255, 128]);
  for (const path of ['destination/source/empty', 'destination/source/empty/deep', 'destination/source/retained-empty', 'source/empty/deep']) {
    assert.equal((await fs.stat(path)).stat.type, 'dir', path);
  }
});

test('cp -rn applies no-clobber to every file while still copying new siblings', async () => {
  const { fs, run, read } = fresh();
  for (const [path, data] of Object.entries({
    'source/shared': 'source version', 'source/new': 'new top-level',
    'source/nested/shared': 'nested source version', 'source/nested/new': 'new nested',
    'destination/source/shared': 'destination version',
    'destination/source/nested/shared': 'nested destination version',
    'destination/source/extra': 'unrelated',
  })) await fs.write(path, data, { createParents: true });
  await fs.mkdir('source/nested/empty');
  const copied = await run('cp -rn source destination');
  assert.equal(copied.code, 0, copied.output);
  assert.equal(await read('destination/source/shared'), 'destination version');
  assert.equal(await read('destination/source/nested/shared'), 'nested destination version');
  assert.equal(await read('destination/source/new'), 'new top-level');
  assert.equal(await read('destination/source/nested/new'), 'new nested');
  assert.equal(await read('destination/source/extra'), 'unrelated');
  assert.equal((await fs.stat('destination/source/nested/empty')).stat.type, 'dir');
});

test('recursive cp reports type conflicts without deleting destination data or dropping later siblings', async () => {
  const { fs, run, read } = fresh();
  await fs.mkdir('source/blocked', { createParents: true });
  await fs.write('source/blocked/child', 'source child');
  await fs.write('source/later', 'copied despite the earlier error');
  await fs.write('destination/source/blocked', 'keep file', { createParents: true });
  await fs.write('destination/source/retained', 'keep sibling');
  const copied = await run('cp -r source destination');
  assert.equal(copied.code, 1);
  assert.match(copied.output, /non-directory/);
  assert.equal(await read('destination/source/blocked'), 'keep file');
  assert.equal(await read('destination/source/retained'), 'keep sibling');
  assert.equal(await read('destination/source/later'), 'copied despite the earlier error');
  assert.equal(await read('source/blocked/child'), 'source child');
});

test('direct directory copy and shell mv retain empty subdirectories', async () => {
  const { fs, run, read } = fresh();
  await fs.mkdir('source/empty/deep', { createParents: true });
  await fs.mkdir('source/sibling');
  await fs.write('source/file', 'content');
  assert.equal((await fs.copy('source', 'copied')).ok, true);
  for (const path of ['copied/empty/deep', 'copied/sibling']) assert.equal((await fs.stat(path)).stat.type, 'dir', path);
  const moved = await run('mv source moved');
  assert.equal(moved.code, 0, moved.output);
  assert.equal((await fs.stat('source')).ok, false);
  assert.equal(await read('moved/file'), 'content');
  for (const path of ['moved/empty/deep', 'moved/sibling']) assert.equal((await fs.stat(path)).stat.type, 'dir', path);
});

test('recursive self-copy and mv onto a nonempty directory remain non-destructive refusals', async () => {
  const { fs, run, read } = fresh();
  await fs.write('source/kept', 'source content', { createParents: true });
  await fs.write('destination/source/kept', 'destination content', { createParents: true });
  assert.equal((await run('cp -r source source/child')).code, 1);
  assert.equal((await fs.stat('source/child')).ok, false);
  assert.equal((await run('mv source destination')).code, 1);
  assert.equal(await read('source/kept'), 'source content');
  assert.equal(await read('destination/source/kept'), 'destination content');
});
