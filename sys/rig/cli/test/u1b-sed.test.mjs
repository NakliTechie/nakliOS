import test from 'node:test';
import assert from 'node:assert/strict';
import { createShell } from '../shell.mjs';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { buildRigRegistry, createRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';

// Exercise the public shell and real governed filesystem. Output files preserve
// delimiters that the terminal renderer intentionally hides.
function fresh({ scopes = ['fs:read', 'fs:write', 'fs:remove'], readOnlyPrefixes = [],
  prefixes = [''], stageWrites = false, signal } = {}) {
  const backend = new MemoryBackend(), fs = createFileops({ backend });
  const base = buildRigRegistry({ fs });
  const registry = stageWrites ? createRegistry(base.commands.map((command) =>
    command.name === 'fs.write' ? { ...command, destructive: true } : command)) : base;
  const face = createAgentFace({ registry,
    grant: createGrant({ prefixes, scopes, readOnlyPrefixes }),
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'sed-contract' });
  const shell = createShell({ registry, face, signal });
  const run = async (command) => ({ ...await shell.feed(command), code: shell.lastCode });
  const read = async (path) => {
    const result = await fs.read(path, { encoding: 'utf-8' });
    assert.equal(result.ok, true, `${path}: ${result.message || result.code}`);
    return result.data;
  };
  const bytes = async (path) => Array.from((await fs.read(path)).data);
  return { fs, backend, registry, face, shell, run, read, bytes };
}
const quote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
async function transform(ctx, script, { flags = '', files = 'input', output = 'output', code = 0 } = {}) {
  const result = await ctx.run(`sed ${flags} ${quote(script)} ${files} > ${output}`);
  assert.equal(result.code, code, result.output);
  assert.equal(Boolean(result.awaitingConfirm), false, 'ordinary writes complete through the default face');
  return ctx.read(output);
}

// The expectations below describe sed's cycle and buffer behavior independently
// of the engine. They deliberately do not import its parser or execution helpers.
test('sed applies numeric, last-line, regex, step, range and negated addresses', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'one\ntwo\nthree\nfour\nfive\nsix\n');
  for (const [script, expected] of [
    ['2p', 'two\n'], ['$p', 'six\n'], ['/^[tf]/p', 'two\nthree\nfour\nfive\n'],
    ['1~2p', 'one\nthree\nfive\n'], ['0~2p', 'two\nfour\nsix\n'],
    ['2,4p', 'two\nthree\nfour\n'], ['/two/,/four/p', 'two\nthree\nfour\n'],
    ['2,+2p', 'two\nthree\nfour\n'], ['2,~3p', 'two\nthree\n'],
    ['0,/one/p', 'one\n'], ['2,4!p', 'one\nfive\nsix\n'],
    ['2,4 { /three/! { s/^/hit:/; p; } }', 'hit:two\nhit:four\n'],
  ]) assert.equal(await transform(ctx, script, { flags: '-n' }), expected, script);
});

test('sed range endpoints start and finish according to cycles, including repeated ranges', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'start\nstart\nend\ngap\nstart\nend\n');
  assert.equal(await transform(ctx, '/start/,/end/p', { flags: '-n' }), 'start\nstart\nend\nstart\nend\n');
  assert.equal(await transform(ctx, '1,/start/p', { flags: '-n' }), 'start\nstart\n',
    'a regex second address does not end its range on the first matched line');
  assert.equal(await transform(ctx, '3,1p', { flags: '-n' }), 'end\n',
    'a numeric endpoint before the start still selects the start line');
});

test('sed substitutions support BRE, ERE, backreferences, delimiters, occurrence flags and print', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'abab aaaa /tmp/\n');
  assert.equal(await transform(ctx, 's/\\(ab\\)\\{2\\}/[\\1]/'), '[ab] aaaa /tmp/\n');
  for (const flags of ['-E', '-r']) {
    assert.equal(await transform(ctx, 's/(ab){2}/[\\1]/', { flags }), '[ab] aaaa /tmp/\n');
  }
  assert.equal(await transform(ctx, 's#/[a-z]*/#PATH#'), 'abab aaaa PATH\n');
  await ctx.fs.write('input', 'aaaa\n');
  assert.equal(await transform(ctx, 's/a/A/2g'), 'aAAA\n');
  assert.equal(await transform(ctx, 's/a/A/ 2g'), 'aAAA\n',
    'GNU substitution flag parsing skips blanks before its separately accepted number and g flags');
  assert.equal(await transform(ctx, 's/a/[&]/2'), 'a[a]aa\n');
  assert.equal(await transform(ctx, 's/a/\\&/g'), '&&&&\n');
  assert.equal(await transform(ctx, 's/a/A/p', { flags: '-n' }), 'Aaaa\n');
  await ctx.fs.write('input', 'Ab aB\n');
  assert.equal(await transform(ctx, 's/ab/X/gI'), 'X X\n');
  await ctx.fs.write('input', 'a\nb\n');
  assert.equal(await transform(ctx, '/a/{s//A/;p;}', { flags: '-n' }), 'A\n',
    'an empty substitution regex reuses the last address regex');
  await ctx.fs.write('input', 'ab\n');
  assert.equal(await transform(ctx, 's/x*/-/g'), '-a-b-\n', 'zero-width global matches terminate');
});

test('sed replacement escape pairs preserve a literal backslash followed by a digit without requiring a capture', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'a\n');
  // The sed replacement contains two backslashes and a digit. The first pair
  // means one literal backslash; the following digit is ordinary output text.
  for (const digit of ['1', '9']) {
    assert.equal(await transform(ctx, `s/a/\\\\${digit}/`), `\\${digit}\n`);
  }
});

test('sed delimiter quoting keeps an escaped alternate delimiter literal in a BRE', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'abc|def abcdef\n');
  assert.equal(await transform(ctx, 's|abc\\|def||g'), ' abcdef\n');
});

test('sed bracket classes can contain the substitution delimiter after a named character class', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'a/1\n');
  assert.equal(await transform(ctx, 's/[[:alpha:]/]/x/g'), 'xx1\n');
});

test('sed -e and -f preserve script ordering and resolve scripts against shell cwd', async () => {
  const ctx = fresh();
  await ctx.fs.write('work/input', 'alpha\nbeta\n', { createParents: true });
  await ctx.fs.write('work/program.sed', 's/beta/gamma/\n');
  assert.equal((await ctx.run('cd work')).code, 0);
  const result = await ctx.run("sed -e 's/alpha/beta/' -f program.sed -e 's/gamma/delta/' input > result");
  assert.equal(result.code, 0, result.output);
  assert.equal(await ctx.read('work/result'), 'delta\ndelta\n');
  await ctx.fs.write('work/comment.sed', '# comments are script syntax\n\ns/alpha/ALPHA/ # trailing comment\n');
  assert.equal((await ctx.run('sed -f comment.sed input > commented')).code, 0);
  assert.equal(await ctx.read('work/commented'), 'ALPHA\nbeta\n');
});

test('sed cycles implement delete, next, multiline append, first-line print and restart', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'a\nb\nc\nd\n');
  assert.equal(await transform(ctx, '2d'), 'a\nc\nd\n');
  assert.equal(await transform(ctx, 'n;p', { flags: '-n' }), 'b\nd\n');
  assert.equal(await transform(ctx, 'N;P;D', { flags: '-n' }), 'a\nb\nc\n');
  assert.equal(await transform(ctx, 'N;s/\\n/:/;p', { flags: '-n' }), 'a:b\nc:d\n');
  assert.equal(await transform(ctx, 'D;p', { flags: '-n' }), '', 'D without a newline starts the next cycle');
  assert.equal(await transform(ctx, 'n;s/./X/'), 'a\nX\nc\nX\n', 'n prints before replacing its pattern space');
});

test('sed append, insert, change, translate, line-number and list commands retain output order', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'a\nb\nc\nd\n');
  assert.equal(await transform(ctx, '1i\\\nbefore\n1a\\\nafter\n2,3c\\\nreplacement'),
    'before\na\nafter\nreplacement\nd\n');
  assert.equal(await transform(ctx, 'y/abcd/ABCD/'), 'A\nB\nC\nD\n');
  assert.equal(await transform(ctx, '2,3=', { flags: '-n' }), '2\n3\n');
  await ctx.fs.write('input', 'a\t\\\r\n');
  assert.equal(await transform(ctx, 'l', { flags: '-n' }), 'a\\t\\\\\\r$\n');
});

test('sed hold-space commands preserve the distinct overwrite, append and exchange semantics', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'a\nb\nc\n');
  assert.equal(await transform(ctx, '1h;2H;$ {g;p;}', { flags: '-n' }), 'a\nb\n');
  assert.equal(await transform(ctx, '1h;2 {x;p;x;G;p;}', { flags: '-n' }), 'a\nb\na\n');
  await ctx.fs.write('input', 'a\n');
  for (const [script, expected] of [['g;p', '\n'], ['H;g;p', '\na\n'], ['G;p', 'a\n\n'], ['x;p', '\n']]) {
    assert.equal(await transform(ctx, script, { flags: '-n' }), expected, script);
  }
});

test('sed branches implement labels, conditional success, conditional failure and reset substitution state', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'aaaa\n');
  assert.equal(await transform(ctx, ':again;s/aa/a/;t again'), 'a\n');
  assert.equal(await transform(ctx, 's/a/A/;b;s/A/B/'), 'Aaaa\n');
  await ctx.fs.write('input', 'x\na\n');
  assert.equal(await transform(ctx, 's/x/y/;T no;p;b end;:no;s/.*/NO/;p;:end', { flags: '-n' }), 'y\nNO\n');
  await ctx.fs.write('input', 'a\n');
  assert.equal(await transform(ctx, 's/a/A/;t changed;:changed;t wrong;p;b done;:wrong;s/.*/WRONG/;p;:done', { flags: '-n' }),
    'A\n', 'taking a t branch clears the substitution-success flag');
});

test('sed q prints its pattern space while Q does not, and both report their requested exit', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'a\nb\nc\n');
  assert.equal(await transform(ctx, '2q 7', { code: 7 }), 'a\nb\n');
  assert.equal(await transform(ctx, '2Q 7', { code: 7 }), 'a\n');
  assert.equal(await transform(ctx, '2q', { flags: '-n' }), '');
});

test('sed flushes a missing output delimiter for q and queued r, including empty reads', async () => {
  // GNU execute.c: q always dumps the append queue; that operation first
  // flushes a missing output delimiter even if the queue or read is empty.
  const ctx = fresh();
  await ctx.fs.write('input', 'a'); await ctx.fs.write('empty', '');
  assert.equal(await transform(ctx, 'q'), 'a\n');
  assert.equal(await transform(ctx, 'p;q', { flags: '-n' }), 'a\n');
  assert.equal(await transform(ctx, 'p;Q', { flags: '-n' }), 'a');
  assert.equal(await transform(ctx, 'r empty'), 'a\n');
  assert.equal(await transform(ctx, 'r missing'), 'a\n');
});

test('sed N at EOF prints its pattern before flushing queued reads', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'a\n'); await ctx.fs.write('extra', 'x');
  assert.equal(await transform(ctx, 'r extra\nN'), 'a\nx');
  assert.equal(await transform(ctx, 'r extra\nN', { flags: '-n' }), 'x');
});

test('sed q stops before opening a later missing input operand', async () => {
  const ctx = fresh();
  await ctx.fs.write('readable', 'first\nsecond\n');
  const originalStat = ctx.backend.stat.bind(ctx.backend);
  let missingAccesses = 0;
  ctx.backend.stat = async (path) => {
    if (path === 'missing') missingAccesses++;
    return originalStat(path);
  };
  const result = await ctx.run('sed q readable missing');
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output, 'first');
  assert.equal(missingAccesses, 0, 'q must not resolve or open a later file');
});

test('sed r defers added file contents and w writes only selected pattern spaces', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'a\nb\n');
  await ctx.fs.write('extra', 'x\ny\n');
  assert.equal(await transform(ctx, '1r extra\n1a\\\nmarker'), 'a\nx\ny\nmarker\nb\n');
  await ctx.fs.write('extra', 'x');
  assert.equal(await transform(ctx, '1r extra'), 'a\nxb\n', 'r appends raw bytes without adding a missing delimiter');
  assert.equal(await transform(ctx, '1w selected\ns/a/A/w replaced'), 'A\nb\n');
  assert.equal(await ctx.read('selected'), 'a\n');
  assert.equal(await ctx.read('replaced'), 'A\n');
  await ctx.fs.write('empty', 'old bytes');
  assert.equal(await transform(ctx, '99w empty', { flags: '-n' }), '');
  assert.equal(await ctx.read('empty'), '', 'w creates or truncates its destination even when no address matches');
});

test('sed defers r file reads until cycle-end after a later w command updates that file', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'a\n');
  await ctx.fs.write('target', 'old\n');
  assert.equal(await transform(ctx, 'r target\nw target'), 'a\na\n');
  assert.equal(await ctx.read('target'), 'a\n');
  await ctx.fs.write('input', 'a\nb\n');
  await ctx.fs.write('target', 'old\n');
  assert.equal(await transform(ctx, 'r target\nw target'), 'a\na\nb\na\nb\n');
  assert.equal(await ctx.read('target'), 'a\nb\n');
});

test('sed treats multiple files as one stream unless -s or in-place editing separates them', async () => {
  const ctx = fresh();
  await ctx.fs.write('one', 'a\nb\n'); await ctx.fs.write('two', 'c\nd\n');
  assert.equal(await transform(ctx, '1p;$p', { flags: '-n', files: 'one two' }), 'a\nd\n');
  assert.equal(await transform(ctx, '1p;$p', { flags: '-ns', files: 'one two' }), 'a\nb\nc\nd\n');
  const result = await ctx.run("sed -i '1d' one two");
  assert.equal(result.code, 0, result.output); assert.equal(result.output, '');
  assert.equal(await ctx.read('one'), 'b\n'); assert.equal(await ctx.read('two'), 'd\n');
});

test('sed -s clears hold text between files while preserving its GNU delimiter state', async () => {
  const ctx = fresh();
  await ctx.fs.write('one', 'a'); await ctx.fs.write('two', 'b\n');
  assert.equal(await transform(ctx, '1{x;p;x;h;}', { flags: '-ns', files: 'one two' }), '\n');
});

test('sed reports a missing operand while still processing later readable inputs', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'a\n');
  const result = await ctx.run("sed 's/a/changed/' missing input");
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /missing/);
  assert.match(result.output, /changed/);
  assert.equal(await ctx.read('input'), 'a\n');
});

test('sed in-place backups preserve original bytes and -n writes only explicitly printed lines', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'first\nsecond');
  const result = await ctx.run("sed -ni.bak '2 {s/second/changed/;p;}' input");
  assert.equal(result.code, 0, result.output);
  assert.equal(await ctx.read('input.bak'), 'first\nsecond');
  assert.equal(await ctx.read('input'), 'changed');
  assert.equal(result.output, '', 'in-place output does not also reach stdout');
});

test('sed repeated in-place input operands compose edits from the current file contents', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'a\n');
  const result = await ctx.run("sed -i 's/a/aa/g' input input");
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output, '');
  assert.equal(await ctx.read('input'), 'aaaa\n');
});

test('sed preserves empty input, missing final delimiters, BOMs and invalid UTF-8 bytes across pipelines', async () => {
  const ctx = fresh();
  for (const data of [new Uint8Array(), Uint8Array.of(255, 65, 0, 128, 10, 66),
    new TextEncoder().encode('\ufeffé\nlast')]) {
    await ctx.fs.write('input', data);
    const result = await ctx.run("cat input | sed '' | cat > output");
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(await ctx.bytes('output'), Array.from(data));
  }
  await ctx.fs.write('input', Uint8Array.of(255, 65, 0, 128, 10));
  assert.equal((await ctx.run("sed 's/A/Z/' input > output")).code, 0);
  assert.deepEqual(await ctx.bytes('output'), [255, 90, 0, 128, 10]);
});

test('sed -z uses NUL record delimiters without converting embedded newlines', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', new TextEncoder().encode('a\nb\0c\nd\0'));
  assert.equal((await ctx.run("sed -z 's/\\n/:/g' input > output")).code, 0);
  assert.deepEqual(await ctx.bytes('output'), Array.from(new TextEncoder().encode('a:b\0c:d\0')));
  assert.equal((await ctx.run("sed -zn '2p' input > output")).code, 0);
  assert.deepEqual(await ctx.bytes('output'), Array.from(new TextEncoder().encode('c\nd\0')));
  await ctx.fs.write('input', Uint8Array.of(65, 0, 66));
  assert.equal((await ctx.run("sed -z 's/B/Z/' input > output")).code, 0);
  assert.deepEqual(await ctx.bytes('output'), [65, 0, 90]);
});

test('sed validates complete scripts before edits, backups or w destinations change', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'original\n'); await ctx.fs.write('collateral', 'keep\n');
  for (const script of ['s/[broken/X/', '1{p', '}', 'b missing', 'y/ab/X/', 's/x/y/e', 'e echo BAD', 'w collateral\ns/[broken/X/']) {
    const result = await ctx.run(`sed -i.bak ${quote(script)} input`);
    assert.notEqual(result.code, 0, script);
    assert.match(result.output, /sed:/, script);
    assert.equal(await ctx.read('input'), 'original\n', script);
    assert.equal(await ctx.read('collateral'), 'keep\n', script);
    assert.equal((await ctx.fs.stat('input.bak')).ok, false, script);
    assert.equal(ctx.shell.awaitingConfirm, null, script);
  }
  for (const command of ['sed --unsupported p input', 'sed -e', 'sed -f', "sed -i 's/a/b/'", "sed -i 's/a/b/' -"]) {
    assert.notEqual((await ctx.run(command)).code, 0, command);
    assert.equal(await ctx.read('input'), 'original\n');
  }
});

test('sed preserves the read and write grant boundaries for scripts, input, r, w, edits and backups', async () => {
  const readOnly = fresh({ scopes: ['fs:read'] });
  await readOnly.fs.write('input', 'a\n');
  for (const command of ["sed -i 's/a/A/' input", "sed -i.bak 's/a/A/' input", "sed 'w blocked' input", "sed 's/a/A/w blocked' input"]) {
    const result = await readOnly.run(command);
    assert.notEqual(result.code, 0, command); assert.match(result.output, /EGRANT|not granted/, command);
    assert.equal(await readOnly.read('input'), 'a\n');
    assert.equal((await readOnly.fs.stat('blocked')).ok, false);
    assert.equal((await readOnly.fs.stat('input.bak')).ok, false);
  }
  const restricted = fresh({ prefixes: ['allowed'] });
  await restricted.fs.write('allowed/input', 'a\n', { createParents: true });
  await restricted.fs.write('private/script', 'p\n', { createParents: true });
  await restricted.fs.write('private/input', 'secret\n');
  for (const command of ['sed -f private/script allowed/input', "sed p private/input", "sed 'r private/input' allowed/input"]) {
    const result = await restricted.run(command);
    assert.notEqual(result.code, 0, command); assert.match(result.output, /EGRANT|not granted|outside/, command);
    assert.doesNotMatch(result.output, /secret/, 'denied input bytes never reach output');
  }
  const protectedBackup = fresh({ readOnlyPrefixes: ['input.bak'] });
  await protectedBackup.fs.write('input', 'a\n');
  const refused = await protectedBackup.run("sed -i.bak 's/a/A/' input");
  assert.notEqual(refused.code, 0); assert.equal(await protectedBackup.read('input'), 'a\n');
  assert.equal((await protectedBackup.fs.stat('input.bak')).ok, false);
});

test('sed resumes both governed backup and edit writes before executing the remaining statement', async () => {
  const ctx = fresh({ stageWrites: true });
  await ctx.fs.write('input', 'a\n');
  const first = await ctx.run("sed -i.bak 's/a/A/' input; echo FINISHED");
  assert.ok(first.awaitingConfirm); assert.equal(await ctx.read('input'), 'a\n');
  assert.equal((await ctx.fs.stat('input.bak')).ok, false);
  assert.doesNotMatch(first.output, /FINISHED/);
  const second = await ctx.run('y');
  assert.ok(second.awaitingConfirm); assert.doesNotMatch(second.output, /FINISHED/);
  const last = await ctx.run('y');
  assert.equal(last.code, 0, last.output); assert.match(last.output, /FINISHED$/);
  assert.equal(await ctx.read('input'), 'A\n'); assert.equal(await ctx.read('input.bak'), 'a\n');
  assert.deepEqual(ctx.face.pendingProposals(), []); assert.equal(ctx.shell.awaitingConfirm, null);
});

test('Stop cancels a suspended sed edit and its continuation without affecting a later invocation', async () => {
  const ctx = fresh({ stageWrites: true });
  await ctx.fs.write('input', 'a\n');
  const first = await ctx.run("sed -i 's/a/A/' input; echo BAD > after-stop");
  assert.ok(first.awaitingConfirm); assert.equal(await ctx.read('input'), 'a\n');
  const stopped = await ctx.shell.cancel();
  assert.equal(ctx.shell.lastCode, 130); assert.match(stopped.output, /interrupted/);
  assert.equal(await ctx.read('input'), 'a\n'); assert.equal((await ctx.fs.stat('after-stop')).ok, false);
  assert.deepEqual(ctx.face.pendingProposals(), []); assert.equal(ctx.shell.awaitingConfirm, null);
  assert.equal((await ctx.run("sed 's/a/Z/' input")).output, 'Z');
});

test('sed bounds branch loops and emitted output before an in-place write can corrupt the source', { timeout: 15000 }, async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'keep\n');
  for (const script of [':again;b again', ':again;p;b again', ':again;h;G;b again']) {
    const result = await ctx.run(`sed -i ${quote(script)} input`);
    assert.notEqual(result.code, 0, script);
    assert.match(result.output, /limit|bound|too (?:many|large)/i, script);
    assert.equal(await ctx.read('input'), 'keep\n', script);
    assert.deepEqual(ctx.face.pendingProposals(), []);
  }
});

test('sed bounds generated output independently of its instruction limit', { timeout: 5000 }, async () => {
  const ctx = fresh();
  const original = `${'x'.repeat(65536)}\n`;
  await ctx.fs.write('input', original);
  const result = await ctx.run("sed -i ':again;p;b again' input");
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /output.*limit/i);
  assert.equal(await ctx.read('input'), original);
  assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('sed refuses excessive regex nesting explicitly before creating an in-place backup', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'keep\n');
  const nested = `${'('.repeat(256)}keep${')'.repeat(256)}`;
  const result = await ctx.run(`sed -Ei.bak ${quote(`s/${nested}/CHANGED/`)} input`);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /sed:.*(?:nest|depth|limit)/i);
  assert.doesNotMatch(result.output, /RangeError|call stack/i);
  assert.equal(await ctx.read('input'), 'keep\n');
  assert.equal((await ctx.fs.stat('input.bak')).ok, false);
});

test('sed yields a CPU branch loop so a scheduled Stop interrupts before later writes', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const ctx = fresh({ signal: controller.signal });
  await ctx.fs.write('input', 'keep\n');
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    const result = await ctx.run("sed -i ':again;b again' input; echo BAD > after-stop");
    assert.equal(result.code, 130, result.output);
    assert.match(result.output, /interrupted/);
    assert.equal(await ctx.read('input'), 'keep\n');
    assert.equal((await ctx.fs.stat('after-stop')).ok, false);
    assert.deepEqual(ctx.face.pendingProposals(), []);
  } finally { clearTimeout(timer); }
});

test('sed notices an active Stop signal while reading input and never performs the following edit', async () => {
  const controller = new AbortController();
  const ctx = fresh({ signal: controller.signal });
  await ctx.fs.write('input', 'keep\n');
  const originalRead = ctx.backend.readBinary.bind(ctx.backend);
  ctx.backend.readBinary = async (...args) => {
    const result = await originalRead(...args);
    if (args[0] === 'input') controller.abort();
    return result;
  };
  const result = await ctx.run("sed -i 's/keep/CHANGED/' input; echo BAD > after-stop");
  assert.equal(result.code, 130, result.output); assert.match(result.output, /interrupted/);
  ctx.backend.readBinary = originalRead;
  assert.equal(await ctx.read('input'), 'keep\n'); assert.equal((await ctx.fs.stat('after-stop')).ok, false);
});
