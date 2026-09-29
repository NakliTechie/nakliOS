import test from 'node:test';
import assert from 'node:assert/strict';
import { createShell } from '../shell.mjs';
import { createRuntimeCommands } from '../cmds/runtime.mjs';
import { fresh, seed, output, decode, observeReads } from './u2c-fixture.mjs';

// Authored against the B07 contract before release. Values do not use production formatting.
const fixed = 1709210096123; // 2024-02-29T12:34:56.123Z, Thursday, leap day.
const names = ['date', 'uname', 'whoami', 'id', 'nproc', 'arch', 'timeout', 'egrep', 'fgrep', 'more', 'dir', 'vdir'];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function clockCommands(ctx = fresh(), options = {}) {
  return createRuntimeCommands(ctx.io, { now: () => fixed, environment: () => new Map([['TZ', 'UTC']]), ...options });
}
async function date(argv, expected, options = {}) {
  const result = await clockCommands(fresh(), options).date(argv);
  assert.equal(result.code, 0, `${argv}: ${decode(result.text)}`);
  assert.equal(decode(result.text), expected + '\n', argv.join(' '));
}

test('B07 names share public discovery and unknown-option refusal', async () => {
  const ctx = fresh();
  for (const name of names) {
    assert.ok(ctx.shell.commands.includes(name), name);
    assert.equal((await ctx.run(`${name} --definitely-unsupported`)).code, 2, name);
  }
});

test('date uses an injected clock and fixed C-locale calendar conversions', async () => {
  await date([], 'Thu Feb 29 12:34:56 UTC 2024');
  await date(['+%Y-%m-%d %H:%M:%S.%N %a %A %b %B %j %w %u %s'],
    '2024-02-29 12:34:56.123000000 Thu Thursday Feb February 060 4 4 1709210096');
  await date(['+%F|%D|%R|%T|%r|%C|%y|%I|%p|%P'], '2024-02-29|02/29/24|12:34|12:34:56|12:34:56 PM|20|24|12|PM|pm');
  await date(['+%c|%x|%X|%z|%:z|%Z|%%'], 'Thu Feb 29 12:34:56 2024|02/29/24|12:34:56|+0000|+00:00|UTC|%');
  await date(['+%d|%e|%-d|%_5d|%05d|%n|%t'], '29|29|29|   29|00029|\n|\t');
});

test('date handles ISO week-years and Sunday/Monday week boundaries independently', async () => {
  for (const [input, expected] of [
    ['2016-01-01', '2016 2015 15 53 00 00 5'],
    ['2017-01-01', '2017 2016 16 52 01 00 7'],
    ['2019-12-30', '2019 2020 20 01 52 52 1'],
    ['2021-01-03', '2021 2020 20 53 01 00 7'],
    ['2024-02-29', '2024 2024 24 09 08 09 4'],
  ]) await date(['-u', '-d', input, '+%Y %G %g %V %U %W %u'], expected);
});

test('date parses explicit offsets and signed fractional Unix timestamps', async () => {
  await date(['-u', '-d', '2024-02-29T18:04:56.123+05:30', '+%F %T.%N'], '2024-02-29 12:34:56.123000000');
  await date(['-u', '--date=@-0.001', '+%F %T.%N %s'], '1969-12-31 23:59:59.999000000 -1');
  await date(['-u', '-d', '@0', '+%F %T %s'], '1970-01-01 00:00:00 0');
  await date(['-u', '-d', '@1.001', '+%s.%N'], '1.001000000');
  await date(['-u', '-d', '@1.001', '+%-N'], '001');
  await date(['-u', '-d', '@1.100', '+%-N'], '100');
  await date(['-u', '-d', '@1.100', '+%-6N'], '1');
  await date(['-u', '-d', '@0', '+%-N'], '000');
  await date(['-u', '-d', '2000-02-29T00:00:00Z', '+%F %j'], '2000-02-29 060');
  await date(['-u', '-d', '2024-03-01T00:15:00+01:00', '+%F %T'], '2024-02-29 23:15:00');
});

test('date emits ISO and RFC formats with explicit precision', async () => {
  for (const [arg, expected] of [
    ['-I', '2024-02-29'], ['--iso-8601=date', '2024-02-29'],
    ['--iso-8601=hours', '2024-02-29T12+00:00'],
    ['--iso-8601=minutes', '2024-02-29T12:34+00:00'],
    ['--iso-8601=seconds', '2024-02-29T12:34:56+00:00'],
    ['--iso-8601=ns', '2024-02-29T12:34:56,123000000+00:00'],
    ['--rfc-3339=date', '2024-02-29'], ['--rfc-3339=seconds', '2024-02-29 12:34:56+00:00'],
    ['--rfc-3339=ns', '2024-02-29 12:34:56.123000000+00:00'],
    ['-R', 'Thu, 29 Feb 2024 12:34:56 +0000'], ['--rfc-email', 'Thu, 29 Feb 2024 12:34:56 +0000'],
  ]) await date([arg], expected);
});

test('date rejects invalid calendars, excessive precision, unsupported formats, and host clock setting', async () => {
  const ctx = fresh();
  for (const command of [
    'date -u -d 2023-02-29', 'date -u -d 1900-02-29', 'date -u -d 2024-04-31',
    'date -u -d 2024-13-01', 'date -u -d 2024-00-01', 'date -u -d 2024-01-00',
    'date -u -d 2024-01-01T24:00:00Z', 'date -u -d 2024-01-01T12:60:00Z',
    'date -u -d 2024-01-01T12:00:60Z', 'date -u -d 2024-01-01T12:00:00.0001Z',
    'date -u -d @0.0001', 'date -u -d tomorrow', 'date --set=2024-01-01',
    'date 010112002024', 'date --rfc-3339=hours', 'date --iso-8601=fortnights',
    "date '+%Q'", "date '+%'", "date '+%F' '+%T'", 'date --date',
  ]) assert.equal((await ctx.run(command)).code, 2, command);
});

test('date honors virtual UTC spellings and refuses unsupported explicit timezone overrides', async () => {
  for (const tz of ['UTC', 'UTC0', 'GMT', 'GMT0']) {
    await date(['+%F %T %z'], '2024-02-29 12:34:56 +0000', { environment: () => new Map([['TZ', tz]]) });
  }
  const ctx = fresh();
  for (const command of ['env TZ=Asia/Kolkata date +%F', 'env TZ=America/New_York date +%F']) {
    assert.equal((await ctx.run(command)).code, 2, command);
  }
  await output(ctx, 'env TZ=UTC date -d @0 +%F', '1970-01-01\n');
  await output(ctx, 'date -u -d @0 +%F', '1970-01-01\n');
});

test('date reference uses canonical governed metadata without reading bytes', async () => {
  const ctx = fresh(); ctx.backend._now = () => fixed;
  await seed(ctx, { reference: 'not date data' }); ctx.backend.symlink('alias', 'reference');
  const reads = observeReads(ctx);
  const result = await ctx.run('date -u -r alias +%Y-%m-%dT%H:%M:%S.%N');
  assert.equal(result.code, 0, result.output); assert.equal(result.output, '2024-02-29T12:34:56.123000000');
  assert.deepEqual(reads, []);
});

test('date reference cannot cross granted prefixes through final or intermediate links', async () => {
  const ctx = fresh({ prefixes: ['allowed'] }); ctx.backend._now = () => fixed;
  await seed(ctx, { 'allowed/ok': 'ok', 'secret/reference': 'NEVER-EXPOSE' });
  ctx.backend.symlink('allowed/link', '../secret/reference'); ctx.backend.symlink('allowed/dir', '../secret');
  const reads = observeReads(ctx);
  for (const path of ['secret/reference', 'allowed/link', 'allowed/dir/reference']) {
    const result = await ctx.run(`date -u -r ${path} +%s`); assert.notEqual(result.code, 0, path);
    assert.doesNotMatch(result.output, /1709210096|NEVER-EXPOSE/);
  }
  assert.deepEqual(reads, []);
});

test('date refuses missing timestamp metadata and content-backed metadata capability', async () => {
  const ctx = fresh(); await seed(ctx, { reference: 'data' }); const reads = observeReads(ctx);
  const original = ctx.backend.stat.bind(ctx.backend);
  ctx.backend.stat = async (...args) => { const value = await original(...args); return value && { ...value, mtimeMs: undefined }; };
  assert.notEqual((await ctx.run('date -u -r reference +%s')).code, 0);
  ctx.backend.supportsMetadataOnly = false;
  assert.notEqual((await ctx.run('date -u -r reference +%s')).code, 0);
  assert.deepEqual(reads, []);
});

test('virtual identity and runtime facts never invent numeric users or host hardware', async () => {
  const ctx = fresh();
  for (const [command, expected] of [
    ['uname', 'nakliOS'], ['uname -s', 'nakliOS'], ['uname -n', 'workspace'], ['uname -r', 'virtual'],
    ['uname -v', 'JavaScript'], ['uname -m', 'javascript'], ['uname -p', 'unknown'], ['uname -i', 'unknown'], ['uname -o', 'nakliOS'],
    ['arch', 'javascript'], ['whoami', 'workspace'], ['id', 'user=workspace (virtual; POSIX uid/gid unavailable)'],
    ['id -un', 'workspace'], ['id --user --name', 'workspace'], ['nproc', '1'], ['nproc --all', '1'],
    ['nproc --ignore=0', '1'], ['nproc --ignore=5', '1'],
  ]) await output(ctx, command, expected + '\n');
  for (const command of ['id -u', 'id -g', 'id -G', 'id -gn', 'id -ru', 'id root', 'whoami root',
    'arch x', 'uname --processor-count', 'nproc --ignore=-1', 'nproc --ignore=1.5']) {
    assert.equal((await ctx.run(command)).code, 2, command);
  }
});

test('runtime formatting is bounded by argument, output, and work budgets', async () => {
  await assert.rejects(clockCommands(fresh(), { limits: { maxArgumentBytes: 4 } }).date(['+%Y%m%d']), /limit|budget/i);
  await assert.rejects(clockCommands(fresh(), { limits: { maxOutputBytes: 2 } }).date(['+%Y']), /limit|budget/i);
  await assert.rejects(clockCommands(fresh(), { limits: { maxSteps: 1 } }).date(['+%Y%Y%Y']), /limit|budget/i);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(clockCommands(fresh(), { signal: () => controller.signal }).date(['+%Y']), /interrupted/i);
});

test('grep aliases retain ERE and literal matching plus later explicit mode options', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'a+b\naaab\nfoo\nbar\n' });
  await output(ctx, "egrep 'a+b|foo' input", 'aaab\nfoo\n');
  await output(ctx, "fgrep 'a+b' input", 'a+b\n');
  await output(ctx, "egrep -F 'a+b' input", 'a+b\n');
  await output(ctx, "fgrep -E 'a+b|foo' input", 'aaab\nfoo\n');
});

test('more preserves arbitrary bytes through aliases and timeout pipelines', async () => {
  const ctx = fresh(); const bytes = Uint8Array.of(0, 255, 128, 65, 10, 13, 0);
  await seed(ctx, { input: bytes });
  await output(ctx, 'more input', bytes);
  await output(ctx, 'timeout 1 more input | more', bytes);
  await output(ctx, 'more input | timeout 1 cat', bytes);
});

test('dir and vdir delegate listing options through the public dispatch table', async () => {
  const ctx = fresh(); await seed(ctx, { 'folder/b': 'bb', 'folder/a': 'a', 'folder/.hidden': 'h' });
  assert.equal((await ctx.run('dir folder')).output, (await ctx.run('ls folder')).output);
  assert.equal((await ctx.run('dir -a folder')).output, (await ctx.run('ls -a folder')).output);
  assert.equal((await ctx.run('vdir folder')).output, (await ctx.run('ls -l folder')).output);
  assert.equal((await ctx.run('vdir -a folder')).output, (await ctx.run('ls -la folder')).output);
});

test('aliases preserve read grants without exposing denied content or listing names', async () => {
  const ctx = fresh({ prefixes: ['allowed'] }); await seed(ctx, { 'allowed/a': 'ok', 'secret/NEVER-LIST': 'NEVER-CONTENT' });
  const reads = observeReads(ctx);
  for (const command of ['more secret/NEVER-LIST', 'egrep . secret/NEVER-LIST', 'fgrep NEVER secret/NEVER-LIST', 'dir secret', 'vdir secret']) {
    const result = await ctx.run(command); assert.notEqual(result.code, 0, command); assert.doesNotMatch(result.output, /NEVER-CONTENT/);
  }
  assert.deepEqual(reads, []);
});

test('timeout returns normal command status, disables zero deadline, and preserves literal argv', async () => {
  const ctx = fresh();
  await output(ctx, "timeout 1 printf '%s' 'a; touch intruder'", 'a; touch intruder');
  assert.equal((await ctx.fs.stat('intruder')).code, 'ENOENT');
  assert.equal((await ctx.run('timeout 1 true')).code, 0);
  assert.equal((await ctx.run('timeout 1 false')).code, 1);
  assert.equal((await ctx.run('timeout 0 sleep 0.01')).code, 0);
  assert.equal((await ctx.run('timeout 1 missing-command')).code, 127);
});

test('timeout rejects unsupported host signals, invalid durations, and missing commands before work', async () => {
  const ctx = fresh();
  for (const command of ['timeout', 'timeout 1', 'timeout -1 touch forbidden', 'timeout NaN touch forbidden',
    'timeout Infinity touch forbidden', 'timeout 301 touch forbidden', 'timeout 1e2 touch forbidden',
    'timeout --signal=KILL 1 touch forbidden', 'timeout -s TERM 1 touch forbidden',
    'timeout --kill-after=1 1 touch forbidden', 'timeout --foreground 1 touch forbidden', 'timeout 1w touch forbidden']) {
    assert.equal((await ctx.run(command)).code, 2, command);
  }
  assert.equal((await ctx.fs.stat('forbidden')).code, 'ENOENT');
  for (const duration of ['0s', '0m', '0h', '0d', '0.001m']) assert.equal((await ctx.run(`timeout ${duration} true`)).code, 0);
});

test('timeout expiry has status124 and preserve-status has cooperative status130', { timeout: 3000 }, async () => {
  const ctx = fresh();
  assert.equal((await ctx.run('timeout 0.005 sleep 0.2')).code, 124);
  assert.equal((await ctx.run('timeout --preserve-status 0.005 sleep 0.2')).code, 130);
  const verbose = await ctx.run('timeout --verbose 0.005 sleep 0.2'); assert.equal(verbose.code, 124); assert.match(verbose.output, /timeout|timed out|deadline/i);
  assert.equal((await ctx.run('echo recovery')).output, 'recovery');
});

test('nested timeout scopes preserve the earlier deadline and restore parent execution', { timeout: 3000 }, async () => {
  const ctx = fresh();
  assert.equal((await ctx.run('timeout 0.01 timeout 1 sleep 0.2')).code, 124);
  assert.equal((await ctx.run('timeout 1 timeout 0.005 sleep 0.2')).code, 124);
  assert.equal((await ctx.run('timeout 1 timeout --preserve-status 0.005 sleep 0.2')).code, 130);
  const parent = await ctx.run('timeout 0.005 sleep 0.2; echo parent'); assert.equal(parent.code, 0); assert.match(parent.output, /parent$/);
  assert.equal((await ctx.run('echo recovery')).output, 'recovery');
});

test('timeout scope nesting refuses unbounded wrapper recursion', { timeout: 3000 }, async () => {
  const ctx = fresh(); const command = 'timeout 0 '.repeat(34) + 'touch forbidden';
  assert.equal((await ctx.run(command)).code, 2); assert.equal((await ctx.fs.stat('forbidden')).code, 'ENOENT');
  assert.equal((await ctx.run('echo recovery')).output, 'recovery');
});

test('timeout cancels CPU work at cooperative checkpoints', { timeout: 3000 }, async () => {
  const ctx = fresh(); const result = await ctx.run("timeout 0.005 awk 'BEGIN { while (1) { x++ } }'");
  assert.equal(result.code, 124); assert.equal((await ctx.run('echo recovery')).output, 'recovery');
});

test('timeout rejects an unanswered proposal and the next feed executes independently', { timeout: 3000 }, async () => {
  const ctx = fresh(); await seed(ctx, { keep: 'keep' });
  const prompted = await ctx.run('timeout 0.02 rm keep'); assert.ok(prompted.awaitingConfirm);
  await delay(60);
  assert.equal(ctx.shell.awaitingConfirm, null); assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal(ctx.shell.lastCode, 124); assert.equal(await ctx.read('keep'), 'keep');
  const next = await ctx.run('echo recovery'); assert.equal(next.code, 0); assert.match(next.output, /recovery$/);
  assert.equal((await ctx.run('echo final')).output, 'final');
});

test('timeout preserves staging for nested writes fed by a byte-preserving alias', { timeout: 3000 }, async () => {
  const ctx = fresh({ stageWrites: true }); await seed(ctx, { source: Uint8Array.of(255, 0, 128) });
  const prompted = await ctx.run('more source | timeout 0.02 tee target'); assert.ok(prompted.awaitingConfirm);
  await delay(60); assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal((await ctx.fs.stat('target')).code, 'ENOENT');
  assert.match((await ctx.run('echo recovery')).output, /recovery$/);
});

test('timeout awaits owned delayed reads before restoring scope and blocks stale pipeline mutation', { timeout: 3000 }, async () => {
  const started = deferred(), release = deferred();
  const ctx = fresh({ beforeOperation: async (name, input) => {
    if (name === 'fs.read' && input.path === 'blocked') { started.resolve(); await release.promise; }
  } });
  await seed(ctx, { blocked: 'stale data' });
  let settled = false;
  const active = ctx.run('timeout 0.01 cat blocked | touch forbidden').then((result) => { settled = true; return result; });
  await started.promise;
  try { await delay(35); assert.equal(settled, false, 'owned I/O must drain before a new invocation can start'); }
  finally { release.resolve(); }
  assert.equal((await active).code, 124); assert.equal((await ctx.fs.stat('forbidden')).code, 'ENOENT');
  assert.equal((await ctx.run('echo recovery')).output, 'recovery');
});

test('external Stop cancels active nested timeouts and leaves the next shell invocation usable', { timeout: 3000 }, async () => {
  const ctx = fresh(); const active = ctx.run('timeout 1 timeout 1 sleep 0.5');
  await delay(15); await ctx.shell.cancel(); await active;
  assert.equal(ctx.shell.lastCode, 130); assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal((await ctx.run('echo recovery')).output, 'recovery');
});

test('timeout during accepted mutation drains its completion and blocks the nested continuation', { timeout: 3000 }, async () => {
  const started = deferred(), release = deferred();
  const ctx = fresh({ beforeOperation: async (name, input) => {
    if (name === 'fs.remove' && input.path === 'victim') { started.resolve(); await release.promise; }
  } });
  await seed(ctx, { victim: 'victim' });
  const prompt = await ctx.run("timeout 0.02 find victim -exec rm '{}' ';' -exec touch forbidden ';'");
  assert.ok(prompt.awaitingConfirm);
  let settled = false;
  const accepting = ctx.run('y').then((result) => { settled = true; return result; });
  await started.promise;
  try { await delay(60); assert.equal(settled, false, 'accepted operation remains owned until it settles'); }
  finally { release.resolve(); }
  assert.equal((await accepting).code, 124); assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal((await ctx.fs.stat('forbidden')).code, 'ENOENT');
  assert.equal((await ctx.run('echo recovery')).output, 'recovery');
});

test('alias reads obey external Stop before a downstream mutation', { timeout: 3000 }, async () => {
  const started = deferred(), release = deferred();
  const ctx = fresh({ beforeOperation: async (name, input) => {
    if (name === 'fs.read' && input.path === 'blocked') { started.resolve(); await release.promise; }
  } });
  await seed(ctx, { blocked: Uint8Array.of(255, 0, 128) });
  const active = ctx.run('more blocked | touch forbidden'); await started.promise;
  const cancelling = ctx.shell.cancel(); release.resolve(); await Promise.all([active, cancelling]);
  assert.equal(ctx.shell.lastCode, 130); assert.equal((await ctx.fs.stat('forbidden')).code, 'ENOENT');
  assert.equal((await ctx.run('echo recovery')).output, 'recovery');
});


test('active deadlines refuse uncancellable Python before script reads or kernel execution', async () => {
  const ctx = fresh(); await seed(ctx, { 'script.py': 'print("must not run")' });
  const reads = observeReads(ctx); let calls = 0;
  const shell = createShell({ registry: ctx.registry, face: ctx.face,
    kiln: { exec: async () => { calls++; return { status: 'ok', output: 'mock-python\n' }; } } });
  for (const command of ['timeout 1 python script.py', 'timeout 1 py script.py', 'timeout 1 python3 script.py',
    'timeout 1 env python script.py', 'timeout 1 timeout 0 python script.py', 'timeout 0 timeout 1 python script.py']) {
    const result = await shell.feed(command); assert.equal(shell.lastCode, 2, command);
    assert.match(result.output, /timeout|deadline|cancel|unsupported/i);
  }
  assert.equal(calls, 0); assert.deepEqual(reads, []);
  assert.equal((await shell.feed("timeout 0 python -c 'print(1)' ")).output, 'mock-python');
  assert.equal(shell.lastCode, 0); assert.equal(calls, 1);
  assert.equal((await shell.feed('echo recovery')).output, 'recovery');
});

test('date case and padding flags match fixed GNU9.11 vectors', async () => {
  await date(['-u', '-d', '@0', '+%^p|%#p|%^P|%#P'], 'AM|am|am|am');
  await date(['-u', '-d', '@0', '+%7z|%07z|%_7z|%-7z'], '+000000|+000000|     +0|+0');
  await date(['-u', '-d', '@0', '+%20F|%020F|%_20F|%-20F'],
    '00000000001970-01-01|00000000001970-01-01|          1970-01-01|1970-01-01');
  await date(['-u', '-d', '@0', '+%3N|%_3N|%-3N'], '000|0  |0');
});

test('date formats both accepted epoch limits without overflowing calendar helpers', async () => {
  await date(['-u', '-d', '@-8640000000000', '+%F %j %G %V %u'], '-271821-04-20 110 -271821 16 2');
  await date(['-u', '-d', '@-8639999999999.999', '+%F %j %G %V %u'], '-271821-04-20 110 -271821 16 2');
  await date(['-u', '-d', '@8640000000000', '+%F %j %G %V %u'], '+275760-09-13 257 275760 37 6');
});

test('date BCE year fields preserve signed centuries and absolute year remainders', async () => {
  await date(['-u', '-d', '@-62198755200', '+%Y|%g|%y|%C|%05C|%D|%x'], '-001|02|01|-0|-0000|01/01/01|01/01/01');
  await date(['-u', '-d', '@-74758377600', '+%Y|%g|%y|%C|%05C|%D|%x'], '-399|99|99|-3|-0003|01/01/99|01/01/99');
  await date(['-u', '-d', '0000-01-01', '+%Y|%G|%g'], '0000|-001|01');
  await date(['-u', '-d', '@-65291443200', '+%Y|%G|%g'], '-100|-099|01');
});

test('timeout compares the exact decimal duration against the300-second cap before nested work', async () => {
  const calls = [], ctx = fresh();
  const commands = createRuntimeCommands(ctx.io, { runWithTimeout: async (...args) => {
    calls.push(args); return { timedOut: false, result: { text: '', code: 0, raw: true } };
  } });
  for (const duration of [
    '300.0000000000000001', '300.0000000000000001s', '000300.000000000000000000001s',
    '5.0000000000000001m', '0.0833333333333333333334h', '0.0034722222222222222223d',
  ]) {
    await assert.rejects(commands.timeout([duration, 'touch', 'forbidden']),
      (error) => error.code === 2 && /300|limit/.test(error.message), duration);
  }
  assert.deepEqual(calls, [], 'over-cap text must never invoke a nested command');
  for (const duration of [
    '300', '300.0000000000000000s', '299.9999999999999999', '5m', '4.9999999999999999m',
    '0.0833333333333333333333h', '0.0034722222222222222222d',
  ]) {
    const before = calls.length; assert.equal((await commands.timeout([duration, 'true'])).code, 0, duration);
    assert.equal(calls.length, before + 1, duration); assert.deepEqual(calls.at(-1), [300000, ['true'], ''], duration);
  }
});

test('timeout ceilings exact positive decimal milliseconds and disables only exact zero', async () => {
  const calls = [], ctx = fresh(), stdin = Uint8Array.of(0, 255, 128);
  const commands = createRuntimeCommands(ctx.io, { runWithTimeout: async (...args) => {
    calls.push(args); return { timedOut: false, result: { text: args[2], code: 0, raw: true } };
  } });
  for (const [duration, milliseconds] of [
    ['1.0000000000000000001s', 1001], ['0.0010000000000000001s', 2], ['0.0009999999999999999s', 1],
    ['0.000001m', 1], ['0.0000001h', 1], ['0.00000001d', 1],
    ['0.0002777777777777777777h', 1000], ['0.0002777777777777777778h', 1001],
    ['0.' + '0'.repeat(400) + '1s', 1], ['0.' + '0'.repeat(400) + '1d', 1],
    ['0', 0], ['.0s', 0], ['000.000000m', 0], ['0.0000h', 0], ['0.0000000000000000000d', 0],
  ]) {
    const before = calls.length;
    const result = await commands.timeout([duration, 'printf', '%s', 'literal ; | $x'], stdin);
    assert.equal(result.code, 0, duration); assert.equal(calls.length, before + 1, duration);
    assert.deepEqual(calls.at(-1), [milliseconds, ['printf', '%s', 'literal ; | $x'], stdin], duration);
    assert.equal(result.text, stdin, 'runner output remains byte-preserving');
  }
});
