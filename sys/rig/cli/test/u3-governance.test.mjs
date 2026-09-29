import test from 'node:test';
import assert from 'node:assert/strict';
import { CrateBackend } from '../../fileops/crate-backend.mjs';
import { fresh, seed, expect, absent, delay, deferred, decode } from './u3-harness.mjs';

for (const command of [
  'if true; then cat secret/value; fi', 'for x in secret/value; do cat "$x"; done',
  'f() { cat "$1"; }; f secret/value', 'printf "%s" "$(cat secret/value)"',
  '(cat secret/value)', '{ cat secret/value; }', 'cat < secret/value',
]) test(`nested reads preserve grants: ${command}`, async () => {
  const ctx = fresh({ prefixes: ['allowed'] }); await seed(ctx, { 'secret/value': 'NEVER-EXPOSE', 'allowed/value': 'allowed' });
  const reads = [], original = ctx.backend.readBinary.bind(ctx.backend);
  ctx.backend.readBinary = async (path, options) => { reads.push(path); return original(path, options); };
  const result = await ctx.run(command); assert.doesNotMatch(result.output, /NEVER-EXPOSE/);
  assert.deepEqual(reads, [], 'denied file never reaches backend read'); assert.notEqual(decode(result.stderr), '', 'nested grant refusal has diagnostic');
});

for (const operator of ['>', '>>', '2>', '&>']) test(`redirect ${operator} refuses denied writes before claiming success`, async () => {
  const ctx = fresh({ prefixes: ['allowed'] }); await seed(ctx, { 'secret/value': 'original' });
  const result = await ctx.run(`printf changed ${operator} secret/value`); assert.notEqual(result.code, 0);
  assert.equal(await ctx.read('secret/value'), 'original'); assert.notEqual(decode(result.stderr), '');
});

test('redirects cannot cross read-only prefixes or final and intermediate symlinks', async () => {
  const ctx = fresh({ prefixes: ['allowed'], readOnlyPrefixes: ['allowed/readonly'] });
  await seed(ctx, { 'allowed/readonly/value': 'keep', 'secret/value': 'secret' });
  ctx.backend.symlink('allowed/link', '../secret/value'); ctx.backend.symlink('allowed/dir', '../secret');
  for (const path of ['allowed/readonly/value', 'allowed/link', 'allowed/dir/value']) {
    assert.notEqual((await ctx.run(`printf changed > ${path}`)).code, 0, path);
  }
  assert.equal(await ctx.read('allowed/readonly/value'), 'keep'); assert.equal(await ctx.read('secret/value'), 'secret');
});

test('nested function and loop retain every destructive confirmation', async () => {
  const ctx = fresh(); await seed(ctx, { a: 'A', b: 'B' });
  const prompt = await ctx.run('remove() { rm "$1"; }; for x in a b; do remove "$x"; done; echo finished');
  assert.ok(prompt.awaitingConfirm); assert.equal(await ctx.read('a'), 'A'); assert.equal(await ctx.read('b'), 'B');
  const next = await ctx.run('y'); assert.ok(next.awaitingConfirm); await absent(ctx, 'a'); assert.equal(await ctx.read('b'), 'B');
  const end = await ctx.run('n'); assert.equal(ctx.shell.awaitingConfirm, null); assert.equal(await ctx.read('b'), 'B');
  assert.match(end.output, /finished/); assert.deepEqual(ctx.face.pendingProposals(), []);
  await expect(ctx, 'echo recovery', 'recovery\n');
});

test('staged redirects inside substitution suspend before bytes change', async () => {
  const ctx = fresh({ stageWrites: true }); await seed(ctx, { target: 'original' });
  const result = await ctx.run('value=$(printf replacement > target; printf inner); printf "%s" "$value"');
  assert.ok(result.awaitingConfirm); assert.equal(await ctx.read('target'), 'original');
  const finished = await ctx.run('y'); assert.equal(finished.code, 0); assert.equal(decode(finished.stdout), 'inner');
  assert.equal(await ctx.read('target'), 'replacement'); assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('staged pipeline writes preserve binary data across function and timeout wrappers', async () => {
  const ctx = fresh({ stageWrites: true }); const data = Uint8Array.of(0, 255, 65); await seed(ctx, { source: data });
  const prompt = await ctx.run('copy() { cat source | timeout 1 tee target > /dev/null; }; copy');
  assert.ok(prompt.awaitingConfirm); await absent(ctx, 'target');
  assert.equal((await ctx.run('y')).code, 0); assert.deepEqual(await ctx.bytes('target'), Array.from(data));
  assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('Stop rejects nested pending work and prevents the remaining loop body', async () => {
  const ctx = fresh(); await seed(ctx, { keep: 'keep' });
  assert.ok((await ctx.run('f() { local x=private; rm keep; touch forbidden; }; x=global; for item in a b; do f; done')).awaitingConfirm);
  await ctx.shell.cancel(); assert.equal(ctx.shell.lastCode, 130); assert.equal(ctx.shell.awaitingConfirm, null);
  assert.equal(await ctx.read('keep'), 'keep'); await absent(ctx, 'forbidden'); assert.deepEqual(ctx.face.pendingProposals(), []);
  await expect(ctx, 'printf "%s|%s" "$x" "$#"', 'global|0');
  await expect(ctx, 'echo recovery', 'recovery\n');
});

test('CPU loops yield for Stop then restore function scope', { timeout: 3000 }, async () => {
  const ctx = fresh({ languageLimits: { maxLoopIterations: 1000000, maxSteps: 10000000, yieldEvery: 1 } });
  await expect(ctx, 'x=global; f() { local x=private; while true; do true; done; touch forbidden; }', '');
  const active = ctx.run('f secret'); await delay(15); await ctx.shell.cancel(); await active;
  assert.equal(ctx.shell.lastCode, 130); await absent(ctx, 'forbidden'); assert.deepEqual(ctx.face.pendingProposals(), []);
  await expect(ctx, 'printf "%s|%s" "$x" "$#"', 'global|0');
});

test('Stop drains owned I/O inside a substitution before later invocation', { timeout: 3000 }, async () => {
  const started = deferred(), release = deferred();
  const ctx = fresh({ beforeOperation: async (name, input) => { if (name === 'fs.read' && input.path === 'blocked') { started.resolve(); await release.promise; } } });
  await seed(ctx, { blocked: 'stale' });
  const active = ctx.run('x=$(cat blocked); printf "%s" "$x" > forbidden'); await started.promise;
  let settled = false; const cancelling = ctx.shell.cancel().then(() => { settled = true; });
  await delay(10); assert.equal(settled, false); release.resolve(); await Promise.all([active, cancelling]);
  assert.equal(ctx.shell.lastCode, 130); await absent(ctx, 'forbidden'); await expect(ctx, 'echo recovery', 'recovery\n');
});

test('timeout cancels a pending operation nested through a function and clears proposals', { timeout: 3000 }, async () => {
  const ctx = fresh(); await seed(ctx, { keep: 'keep' });
  const prompt = await ctx.run('f() { timeout 0.01 rm keep; }; f'); assert.ok(prompt.awaitingConfirm);
  await delay(50); assert.equal(ctx.shell.lastCode, 124); assert.equal(ctx.shell.awaitingConfirm, null);
  assert.deepEqual(ctx.face.pendingProposals(), []); assert.equal(await ctx.read('keep'), 'keep');
  assert.match((await ctx.run('echo recovery')).output, /recovery/);
});

const bounded = [
  ['source bytes', { maxSourceBytes: 16 }, 'touch forbidden; echo too-long'],
  ['tokens', { maxTokens: 6 }, 'touch forbidden; printf a b c d e f g'],
  ['nesting', { maxDepth: 2 }, 'if true; then if true; then if true; then touch forbidden; fi; fi; fi'],
  ['argument bytes', { maxArgumentBytes: 12 }, 'x=12345678; printf "%s" "$x$x" > forbidden'],
  ['captured output', { maxOutputBytes: 12 }, 'printf 123456789012345678901234567890'],
  ['loop iterations', { maxLoopIterations: 3 }, 'i=0; while true; do i=$((i+1)); done; touch forbidden'],
  ['function recursion', { maxFunctionDepth: 3 }, 'f() { f; }; f; touch forbidden'],
  ['runtime steps', { maxSteps: 30 }, 'while true; do true; done; touch forbidden'],
];
for (const [name, languageLimits, command] of bounded) test(`bounded ${name} refusal leaves no continuation or proposal`, { timeout: 3000 }, async () => {
  const ctx = fresh({ languageLimits }); const result = await ctx.run(command);
  assert.equal(result.code, 2, `${name}: ${result.output}`); assert.match(decode(result.stderr), /limit|budget|exceed|depth|large/i);
  await absent(ctx, 'forbidden'); assert.deepEqual(ctx.face.pendingProposals(), []);
  await expect(ctx, 'true', '');
});

test('nested substitutions share the invocation step budget', { timeout: 3000 }, async () => {
  const ctx = fresh({ languageLimits: { maxSteps: 100, maxLoopIterations: 1000 } });
  const result = await ctx.run('for a in 1 2 3 4 5 6 7 8 9 10; do v=$(for b in 1 2 3 4 5 6 7 8 9 10; do true; done); done; touch forbidden');
  assert.equal(result.code, 2, result.output); assert.match(decode(result.stderr), /limit|budget/i); await absent(ctx, 'forbidden');
});

test('arithmetic uses the shared work bound instead of host execution', async () => {
  const ctx = fresh({ languageLimits: { maxSteps: 20 } });
  const expression = Array.from({ length: 50 }, () => '1').join('+');
  const result = await ctx.run(`printf "%s" "$(( ${expression} ))"`);
  assert.equal(result.code, 2); assert.match(decode(result.stderr), /limit|budget/i);
});

for (const languageLimits of [
  { maxSteps: -1 }, { maxTokens: 1.5 }, { maxArgumentBytes: NaN }, { maxSourceBytes: Infinity },
  { maxOutputBytes: Number.MAX_SAFE_INTEGER + 1 }, { maxDepth: 0 }, { maxFunctionDepth: 0 }, { yieldEvery: 0 },
]) test(`invalid language limit refuses construction: ${JSON.stringify(languageLimits)}`, () => {
  assert.throws(() => fresh({ languageLimits }), /limit|integer|positive|safe|invalid/i);
});

test('redirect creates missing parents while preserving byte contents', async () => {
  const ctx = fresh();
  await expect(ctx, 'printf first > new/deep/output; printf second >> new/deep/output', '');
  assert.equal(await ctx.read('new/deep/output'), 'firstsecond');
  assert.equal((await ctx.fs.stat('new')).stat.type, 'dir');
  assert.equal((await ctx.fs.stat('new/deep')).stat.type, 'dir');
});

test('nondirectory redirect ancestors refuse before compound body effects', async () => {
  const ctx = fresh(); await seed(ctx, { ancestor: 'unchanged' });
  const result = await ctx.run('{ touch forbidden; printf replacement; } > ancestor/child/output');
  assert.notEqual(result.code, 0); assert.notEqual(decode(result.stderr), '');
  assert.equal(await ctx.read('ancestor'), 'unchanged'); await absent(ctx, 'forbidden', 'ancestor/child/output');
  await expect(ctx, 'echo recovery', 'recovery\n');
});

for (const target of ['protected/missing/output', 'scratch/../protected/missing/output']) {
  test(`lexical read-only redirect refuses missing parents before body effects: ${target}`, async () => {
    const ctx = fresh({ readOnlyPrefixes: ['protected'] });
    const result = await ctx.run(`{ touch forbidden; printf replacement; } > ${target}`);
    assert.notEqual(result.code, 0); assert.notEqual(decode(result.stderr), '');
    await absent(ctx, 'forbidden', 'protected', 'protected/missing/output'); assert.deepEqual(ctx.face.pendingProposals(), []);
    await expect(ctx, 'echo recovery', 'recovery\n');
  });
}

const repeatedRemovals = [
  ['xargs', String.raw`printf 'tree/a\ntree/b\n' | xargs -n1 rm | touch forbidden`],
  ['find', "find tree -type f -exec rm '{}' ';' | touch forbidden"],
];
for (const [name, command] of repeatedRemovals) test(`refusal through ${name} blocks remaining invocations and downstream mutations`, async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/a': 'A', 'tree/b': 'B' });
  assert.ok((await ctx.run(command)).awaitingConfirm);
  const result = await ctx.run('n'); assert.notEqual(result.code, 0); assert.equal(ctx.shell.awaitingConfirm, null);
  assert.equal(await ctx.read('tree/a'), 'A'); assert.equal(await ctx.read('tree/b'), 'B'); await absent(ctx, 'forbidden');
  assert.deepEqual(ctx.face.pendingProposals(), []); await expect(ctx, 'echo recovery', 'recovery\n');
});

const timedRemovals = [
  ['xargs', String.raw`printf 'tree/a\ntree/b\n' | xargs -n1 timeout 0.01 rm | touch forbidden`],
  ['find', "find tree -type f -exec timeout 0.01 rm '{}' ';' | touch forbidden"],
];
for (const [name, command] of timedRemovals) test(`timeout through ${name} blocks remaining invocations and downstream mutations`, { timeout: 3000 }, async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/a': 'A', 'tree/b': 'B' });
  assert.ok((await ctx.run(command)).awaitingConfirm); await delay(50);
  assert.equal(ctx.shell.lastCode, 124); assert.equal(ctx.shell.awaitingConfirm, null);
  assert.equal(await ctx.read('tree/a'), 'A'); assert.equal(await ctx.read('tree/b'), 'B'); await absent(ctx, 'forbidden');
  assert.deepEqual(ctx.face.pendingProposals(), []); assert.match((await ctx.run('echo recovery')).output, /recovery$/);
});

class LegacyCrateHost {
  constructor() { this.keys = new Map(); this.calls = []; }
  async readBinary(path) {
    this.calls.push({ method: 'readBinary', path });
    if (!this.keys.has(path)) throw new Error(`no such file: ${path}`);
    return this.keys.get(path).slice();
  }
  async write(path, data) { this.calls.push({ method: 'write', path }); this.keys.set(path, new Uint8Array(data).slice()); }
  async delete(path) { this.calls.push({ method: 'delete', path }); this.keys.delete(path); }
  async exists(path) {
    this.calls.push({ method: 'exists', path });
    return this.keys.has(path) || [...this.keys.keys()].some((key) => key.startsWith(path + '/'));
  }
  async list(prefix) {
    this.calls.push({ method: 'list', path: prefix });
    const base = prefix === '' ? '' : prefix + '/';
    return [...this.keys.keys()].filter((key) => base === '' || key.startsWith(base));
  }
}
const crateBytes = (value) => typeof value === 'string' ? new TextEncoder().encode(value) : value;
function legacyCrate(options = {}) {
  const host = new LegacyCrateHost(), backend = new CrateBackend(host);
  return { ...fresh({ backend, ...options }), host };
}

test('Crate metadata finds exact object keys before session markers and descendants without reading contents', async () => {
  const ctx = legacyCrate();
  await ctx.backend.mkdir('both');
  ctx.host.keys.set('both', crateBytes('file data'));
  ctx.host.keys.set('both/child', crateBytes('child data'));
  ctx.host.calls.length = 0;
  const result = await ctx.face.invoke('fs.stat', { path: 'both', metadataOnly: true, follow: false });
  assert.equal(result.ok, true); assert.equal(result.stat.type, 'file');
  assert.equal(Object.hasOwn(result.stat, 'size'), false); assert.equal(Object.hasOwn(result.stat, 'mtimeMs'), false);
  assert.equal(ctx.host.calls.some((call) => call.method === 'readBinary'), false);
});

test('Crate metadata traversal reports files directories and missing paths without content reads', async () => {
  const ctx = legacyCrate(); ctx.host.keys.set('parent/child', crateBytes('large data'));
  await ctx.backend.mkdir('empty'); ctx.host.calls.length = 0;
  for (const [path, type] of [['', 'dir'], ['parent', 'dir'], ['parent/child', 'file'], ['empty', 'dir']]) {
    const result = await ctx.face.invoke('fs.stat', { path, metadataOnly: true });
    assert.equal(result.ok, true, path); assert.equal(result.stat.type, type, path);
  }
  assert.equal((await ctx.face.invoke('fs.stat', { path: 'absent', metadataOnly: true })).code, 'ENOENT');
  const listing = await ctx.face.invoke('fs.list', { path: 'parent', metadataOnly: true });
  assert.equal(listing.ok, true); assert.deepEqual(listing.entries.map(({ name, type }) => ({ name, type })), [{ name: 'child', type: 'file' }]);
  assert.equal(ctx.host.calls.some((call) => call.method === 'readBinary'), false);
});

test('Crate bounded reads remain unsupported before backend calls and U2 never uses the redirect fallback', async () => {
  const ctx = legacyCrate(); ctx.host.keys.set('data', crateBytes('payload')); ctx.host.calls.length = 0;
  const result = await ctx.face.invoke('fs.read', { path: 'data', maxBytes: 2 });
  assert.equal(result.code, 'ENOTSUP'); assert.deepEqual(ctx.host.calls, []);
  assert.notEqual(ctx.backend.supportsBoundedReads, true);
  const encoded = await ctx.run('base64 data'); assert.notEqual(encoded.code, 0);
  assert.equal(ctx.host.calls.some((call) => call.method === 'readBinary'), false);
});

test('Crate echo printf append cat and group redirects retain exact bytes', async () => {
  const ctx = legacyCrate();
  await expect(ctx, 'echo first > nested/deep/output; printf second >> nested/deep/output', '');
  assert.equal(await ctx.read('nested/deep/output'), 'first\nsecond');
  await expect(ctx, 'cat nested/deep/output > copy; { printf prefix; cat copy; } > grouped', '');
  assert.equal(await ctx.read('copy'), 'first\nsecond'); assert.equal(await ctx.read('grouped'), 'prefixfirst\nsecond');
  await expect(ctx, 'printf replacement > nested/deep/output', ''); assert.equal(await ctx.read('nested/deep/output'), 'replacement');
});

test('Crate redirects preserve binary payloads through wrappers', async () => {
  const ctx = legacyCrate(), bytes = Uint8Array.of(0, 255, 128, 65, 10); ctx.host.keys.set('source', bytes);
  await expect(ctx, 'env timeout 1 cat source > copied; cat copied', bytes);
  assert.deepEqual(await ctx.bytes('copied'), Array.from(bytes));
});

test('Crate descriptor offsets preserve overlapping output destinations', async () => {
  const ctx = legacyCrate();
  await expect(ctx, '{ printf ABCDE; printf z >&2; } > shared 2> shared', '');
  assert.equal(await ctx.read('shared'), 'zBCDE');
});

test('Crate function shadows and assignment substitutions preserve existing redirect semantics', async () => {
  const ctx = legacyCrate();
  await expect(ctx, 'echo() { printf function; }; echo > shadowed', ''); assert.equal(await ctx.read('shadowed'), 'function');
  await expect(ctx, 'X=$(printf changed > assigned) printf result > assigned', ''); assert.equal(await ctx.read('assigned'), 'resultd');
});

test('Crate oversized append input refuses after legacy reading without altering its target', async () => {
  const ctx = legacyCrate({ languageLimits: { maxOutputBytes: 8 } });
  const original = 'original-too-large'; ctx.host.keys.set('target', crateBytes(original)); ctx.host.calls.length = 0;
  const result = await ctx.run('printf x >> target'); assert.notEqual(result.code, 0); assert.match(result.output, /limit|large|exceed/i);
  assert.ok(ctx.host.calls.some((call) => call.method === 'readBinary' && call.path === 'target'));
  assert.equal(decode(ctx.host.keys.get('target')), original);
  assert.equal(ctx.host.calls.some((call) => call.method === 'write' && call.path === 'target'), false);
});

test('Crate oversized input redirect refuses before a later output target opens', async () => {
  const ctx = legacyCrate({ languageLimits: { maxOutputBytes: 8 } });
  ctx.host.keys.set('source', crateBytes('source-too-large')); ctx.host.keys.set('target', crateBytes('keep')); ctx.host.calls.length = 0;
  const result = await ctx.run('cat < source > target'); assert.notEqual(result.code, 0); assert.match(result.output, /limit|large|exceed/i);
  assert.ok(ctx.host.calls.some((call) => call.method === 'readBinary' && call.path === 'source'));
  assert.equal(decode(ctx.host.keys.get('target')), 'keep');
  assert.equal(ctx.host.calls.some((call) => call.method === 'write' && call.path === 'target'), false);
});

test('redirect fallback never retries an EFBIG bounded refusal', async () => {
  const reads = [], ctx = fresh({ languageLimits: { maxOutputBytes: 8 }, beforeOperation: async (name, input) => {
    if (name === 'fs.read') reads.push({ ...input });
  } });
  await seed(ctx, { source: 'source-too-large', target: 'keep' });
  const result = await ctx.run('cat < source > target'); assert.notEqual(result.code, 0);
  assert.equal(reads.length, 1); assert.equal(reads[0].maxBytes, 8); assert.equal(await ctx.read('target'), 'keep');
});

test('redirect fallback never widens a read grant', async () => {
  const ctx = legacyCrate({ prefixes: ['allowed'] }); ctx.host.keys.set('secret', crateBytes('NEVER-EXPOSE'));
  const result = await ctx.run('cat < secret > allowed/output'); assert.notEqual(result.code, 0); assert.doesNotMatch(result.output, /NEVER-EXPOSE/);
  assert.equal(ctx.host.calls.some((call) => call.method === 'readBinary'), false); assert.equal(ctx.host.keys.has('allowed/output'), false);
});

test('redirect fallback never retries a symlink-specific ENOTSUP', async () => {
  const reads = [];
  const ctx = fresh({ beforeOperation: async (name, input) => {
    if (name === 'fs.read' && input.path === 'allowed/input') {
      reads.push({ ...input }); ctx.backend.files.delete('allowed/input'); ctx.backend.symlink('allowed/input', '../secret');
    }
  } });
  await seed(ctx, { 'allowed/input': 'initial', secret: 'NEVER-EXPOSE', target: 'keep' });
  const result = await ctx.run('cat < allowed/input > target'); assert.notEqual(result.code, 0); assert.doesNotMatch(result.output, /NEVER-EXPOSE/);
  assert.equal(reads.length, 1); assert.equal(reads[0].rejectSymlinks, true); assert.equal(await ctx.read('target'), 'keep');
});

test('redirect fallback never retries ENOTSUP caused by unreliable bounded size metadata', async () => {
  const reads = [], ctx = fresh({ beforeOperation: async (name, input) => { if (name === 'fs.read') reads.push({ ...input }); } });
  await seed(ctx, { source: 'data', target: 'keep' });
  const originalStat = ctx.backend.stat.bind(ctx.backend);
  ctx.backend.stat = async (path, options) => path === 'source' ? { type: 'file' } : originalStat(path, options);
  const result = await ctx.run('cat < source > target'); assert.notEqual(result.code, 0); assert.match(result.output, /size|bounded|metadata/i);
  assert.equal(reads.length, 1); assert.equal(reads[0].rejectSymlinks, true); assert.equal(await ctx.read('target'), 'keep');
});
