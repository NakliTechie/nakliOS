import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fresh, seed, expect, absent, bytesOf, decode } from './u3-harness.mjs';

const nodeHost = () => {
  const makeModuleURL = (source) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const spawn = (url) => {
    const boot = `import { parentPort } from 'node:worker_threads'; globalThis.self={postMessage:m=>parentPort.postMessage(m)}; await import(${JSON.stringify(url)});`;
    const worker = new Worker(new URL(makeModuleURL(boot)));
    return { onMessage: (fn) => worker.on('message', fn), onError: (fn) => worker.on('error', fn), terminate: () => worker.terminate() };
  };
  return { makeModuleURL, spawn, timeoutMs: 2000 };
};

test('stdout and stderr preserve partial cat output separately', async () => {
  const ctx = fresh(); await seed(ctx, { first: 'first\n', last: 'last\n' });
  const result = await ctx.run('cat first missing last'); assert.notEqual(result.code, 0);
  assert.equal(decode(result.stdout), 'first\nlast\n'); assert.match(decode(result.stderr), /missing/);
  assert.match(result.output, /first/); assert.match(result.output, /missing/);
});

test('missing file diagnostics never enter an ordinary pipe', async () => {
  const ctx = fresh(); const result = await ctx.run('cat missing | wc -c');
  assert.equal(result.code, 0); assert.equal(decode(result.stdout).trim(), '0'); assert.match(decode(result.stderr), /missing/);
});

test('usage diagnostics stay on stderr while last pipeline status wins', async () => {
  const ctx = fresh(); const result = await ctx.run('grep --definitely-unsupported | wc -c');
  assert.equal(result.code, 0); assert.equal(decode(result.stdout).trim(), '0'); assert.match(decode(result.stderr), /unsupported|unknown|option/i);
  const direct = await ctx.run('grep --definitely-unsupported'); assert.equal(direct.code, 2); assert.equal(decode(direct.stdout), '');
});

test('explicit merging sends diagnostics into the downstream pipe', async () => {
  const ctx = fresh(); const result = await ctx.run('cat missing 2>&1 | cat');
  assert.equal(result.code, 0); assert.match(decode(result.stdout), /missing/); assert.equal(decode(result.stderr), '');
});

test('left-to-right redirects snapshot the current descriptor target', async () => {
  const ctx = fresh(); await seed(ctx, { good: 'ok\n' });
  const first = await ctx.run('cat good missing > first 2>&1'); assert.notEqual(first.code, 0);
  assert.equal(decode(first.stdout), ''); assert.equal(decode(first.stderr), '');
  assert.match(await ctx.read('first'), /ok\n/); assert.match(await ctx.read('first'), /missing/);
  const second = await ctx.run('cat good missing 2>&1 > second'); assert.notEqual(second.code, 0);
  assert.equal(await ctx.read('second'), 'ok\n'); assert.match(decode(second.stdout), /missing/); assert.equal(decode(second.stderr), '');
});

test('descriptor duplication and closing control only their assigned channel', async () => {
  const ctx = fresh();
  await expect(ctx, 'printf out 1>&2', '', 0, 'out');
  await expect(ctx, 'true 1>&-', '');
  assert.equal(decode((await ctx.run('printf hidden 1>&-')).stdout), '');
  const result = await ctx.run('cat missing 2>&-'); assert.notEqual(result.code, 0);
  assert.equal(decode(result.stdout), ''); assert.equal(decode(result.stderr), '');
  await absent(ctx, '&1', '&2', '&-');
});

test('combined redirects and append preserve both channel contents', async () => {
  const ctx = fresh(); await seed(ctx, { good: 'ok\n' });
  const result = await ctx.run('cat good missing &> both'); assert.notEqual(result.code, 0);
  assert.equal(decode(result.stdout), ''); assert.equal(decode(result.stderr), '');
  const first = await ctx.read('both'); assert.match(first, /ok\n/); assert.match(first, /missing/);
  await expect(ctx, 'printf tail &>> both', ''); assert.equal(await ctx.read('both'), first + 'tail');
});

test('per-command redirects work inside pipelines and compound groups', async () => {
  const ctx = fresh();
  await expect(ctx, 'printf left > file | wc -c', '0\n'); assert.equal(await ctx.read('file'), 'left');
  await expect(ctx, '{ printf first; printf second; } > grouped; cat grouped', 'firstsecond');
  await expect(ctx, 'if true; then printf branch; fi > branch; cat branch', 'branch');
  await expect(ctx, 'for x in a b; do echo "$x"; done > loop; cat loop', 'a\nb\n');
});

test('/dev/null remains a virtual source and sink with restricted grants', async () => {
  const ctx = fresh({ prefixes: ['allowed'] });
  await expect(ctx, 'printf hidden > /dev/null; cat < /dev/null', '');
  const failure = await ctx.run('cat missing 2> /dev/null'); assert.notEqual(failure.code, 0); assert.equal(decode(failure.stderr), '');
  await absent(ctx, 'dev', 'dev/null');
});

test('append and separate fd redirects preserve exact byte framing', async () => {
  const ctx = fresh();
  await expect(ctx, 'printf one 1> file; printf two >> file; cat file', 'onetwo');
  await expect(ctx, 'printf err 1>&2 2> errors', '', 0, 'err');
  assert.equal(await ctx.read('errors'), '');
});

test('binary bytes survive ordinary pipes, wrappers, files and summaries', async () => {
  const ctx = fresh(), data = Uint8Array.of(0, 255, 128, 65, 10, 13, 0); await seed(ctx, { binary: data });
  await expect(ctx, 'cat binary | env timeout 1 more > copied; cat copied', data);
  assert.deepEqual(await ctx.bytes('copied'), bytesOf(data));
  assert.match((await ctx.run('cat binary')).output, /7 bytes/);
});

for (const [name, data] of [['NUL', Uint8Array.of(65, 0, 66)], ['invalid UTF-8', Uint8Array.of(255, 128)], ['binary control', Uint8Array.of(1, 2)]]) {
  test(`command substitution explicitly rejects ${name}`, async () => {
    const ctx = fresh(); await seed(ctx, { binary: data });
    const result = await ctx.run('printf "%s" "$(cat binary)" > forbidden');
    assert.notEqual(result.code, 0); assert.match(decode(result.stderr), /binary|NUL|text/i); await absent(ctx, 'forbidden');
    await expect(ctx, 'echo recovery', 'recovery\n');
  });
}

test('data statuses remain visible without treating their output as a diagnostic', async () => {
  const ctx = fresh(); await seed(ctx, { a: 'a\n', b: 'b\n' });
  await expect(ctx, 'grep absent a', '', 1);
  const diff = await ctx.run('diff a b'); assert.equal(diff.code, 1); assert.notEqual(decode(diff.stdout), ''); assert.equal(decode(diff.stderr), '');
  const cmp = await ctx.run('cmp a b'); assert.equal(cmp.code, 1); assert.notEqual(decode(cmp.stdout), ''); assert.equal(decode(cmp.stderr), '');
  await expect(ctx, 'expr 0', '0\n', 1);
});

test('wrappers preserve separated child streams', async () => {
  const ctx = fresh(); await seed(ctx, { good: 'good\n' });
  for (const command of ['env cat good missing', 'timeout 1 cat good missing', 'printf good | xargs cat missing']) {
    const result = await ctx.run(command); assert.notEqual(result.code, 0, command);
    assert.equal(decode(result.stdout), 'good\n', command); assert.match(decode(result.stderr), /missing/, command);
  }
});

test('Python adapter preserves stdout and stderr despite a merged display result', async () => {
  let calls = 0;
  const ctx = fresh({ kiln: { exec: async () => { calls++; return { status: 'error', code: 7, stdout: 'python-out\n', stderr: 'python-err\n', output: 'python-out\npython-err\n' }; } } });
  await expect(ctx, 'python -c "pass"', 'python-out\n', 7, 'python-err\n');
  await expect(ctx, 'python -c "pass" | cat', 'python-out\n', 0, 'python-err\n');
  assert.equal(calls, 2);
});

test('actual JavaScript worker routes console and process streams through the shell', { timeout: 5000 }, async () => {
  const ctx = fresh({ js: nodeHost() });
  await expect(ctx, `node -e 'console.log("out"); console.error("err"); process.stdout.write("tail"); process.stderr.write("warning"); process.exitCode=7'`, 'out\ntail', 7, 'err\nwarning');
  await expect(ctx, `node -e 'console.log("out"); console.warn("warn")' | cat`, 'out\n', 0, 'warn\n');
});

const partialInputs = { first: 'match one\nmiss\n', last: 'match two\n' };
const partialCases = [
  ['grep', "grep '^match' first missing last", 'first:match one\nlast:match two\n', 2],
  ['head', 'head -n 1 first missing last', '==> first <==\nmatch one\n\n==> last <==\nmatch two\n', 1],
  ['wc', 'wc -l first missing last', '2 first\n1 last\n3 total\n', 1],
  ['find', 'find first missing last -type f -print', 'first\nlast\n', 1],
  ['sed', "sed 's/match/seen/' first missing last", 'seen one\nmiss\nseen two\n', 2],
  ['awk', "awk '{ print } END { print \"must-not-run\" }' first missing last", 'match one\nmiss\n', 2],
];
for (const [name, command, stdout, code] of partialCases) {
  test(`${name} preserves successful partial stdout with independent failure diagnostics`, async () => {
    const ctx = fresh(); await seed(ctx, partialInputs);
    const result = await ctx.run(command); assert.equal(result.code, code, result.output);
    assert.equal(decode(result.stdout), stdout); assert.match(decode(result.stderr), /missing/);
    assert.doesNotMatch(decode(result.stdout), /missing|ENOENT|must-not-run/);
    assert.doesNotMatch(decode(result.stderr), /match one|match two|seen one|seen two/);
    assert.equal(await ctx.read('first'), partialInputs.first); assert.equal(await ctx.read('last'), partialInputs.last);
    await expect(ctx, 'echo recovery', 'recovery\n');
  });
  test(`${name} partial streams survive environment and timeout wrappers`, async () => {
    const ctx = fresh(); await seed(ctx, partialInputs);
    const result = await ctx.run(`env timeout 1 ${command}`); assert.equal(result.code, code, result.output);
    assert.equal(decode(result.stdout), stdout); assert.match(decode(result.stderr), /missing/);
  });
  test(`${name} pipes only its successful partial stdout`, async () => {
    const ctx = fresh(); await seed(ctx, partialInputs);
    const result = await ctx.run(`${command} | cat`); assert.equal(result.code, 0, result.output);
    assert.equal(decode(result.stdout), stdout); assert.match(decode(result.stderr), /missing/);
  });
}

test('partial grep output and diagnostics route to separate governed files', async () => {
  const ctx = fresh(); await seed(ctx, partialInputs);
  await expect(ctx, "grep '^match' first missing last > matches 2> errors", '', 2);
  assert.equal(await ctx.read('matches'), 'first:match one\nlast:match two\n');
  assert.match(await ctx.read('errors'), /missing/); assert.doesNotMatch(await ctx.read('errors'), /match one|match two/);
});

test('find exec preserves child stdout while reporting a missing operand on stderr', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/input': 'retained\n' });
  const result = await ctx.run("find tree -type f -exec cat '{}' missing ';'");
  assert.equal(decode(result.stdout), 'retained\n'); assert.match(decode(result.stderr), /missing/);
  assert.doesNotMatch(decode(result.stdout), /missing|ENOENT/);
});

test('factor consumes piped stdin directly and through nested runtime wrappers', async () => {
  const ctx = fresh();
  await expect(ctx, String.raw`printf '15 49\n' | factor`, '15: 3 5\n49: 7 7\n');
  await expect(ctx, String.raw`printf '21\n25\n' | env timeout 1 factor`, '21: 3 7\n25: 5 5\n');
});
