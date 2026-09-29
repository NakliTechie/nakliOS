import test from 'node:test';
import assert from 'node:assert/strict';
import { createShell } from '../shell.mjs';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';

function fresh({ scopes = ['fs:read', 'fs:write', 'fs:remove'], prefixes = [''], readOnlyPrefixes = [], signal, cwd = '' } = {}) {
  const backend = new MemoryBackend(), fs = createFileops({ backend });
  const registry = buildRigRegistry({ fs });
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant: createGrant({ prefixes, scopes, readOnlyPrefixes }),
    opLog, actor: 'find-contract' });
  const shell = createShell({ registry, face, signal, cwd });
  const run = async (command) => ({ ...await shell.feed(command), code: shell.lastCode });
  const read = async (path) => {
    const result = await fs.read(path, { encoding: 'utf-8' });
    assert.equal(result.ok, true, `${path}: ${result.message || result.code}`); return result.data;
  };
  const bytes = async (path) => Array.from((await fs.read(path)).data);
  return { fs, backend, face, opLog, shell, run, read, bytes };
}
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
async function accepted(ctx, command) {
  let result = await ctx.run(command), count = 0;
  const output = [result.output];
  while (result.awaitingConfirm) {
    assert.ok(++count < 100, 'fixture has a bounded number of removal proposals');
    result = await ctx.run('y'); output.push(result.output);
  }
  return { ...result, output: output.filter(Boolean).join('\n'), confirmations: count };
}
async function seed(ctx, files) {
  for (const [path, content] of Object.entries(files)) {
    const result = await ctx.fs.write(path, content, { createParents: true });
    assert.equal(result.ok, true, `${path}: ${result.message || result.code}`);
  }
}

// These tests enter through the public shell and actual governed face. They do
// not import find's parser, predicates, traversal or action implementation.
test('find includes directory roots and empty directories while preserving supplied path spelling', async () => {
  const ctx = fresh();
  await seed(ctx, { 'tree/a': 'a', 'tree/sub/b': 'b' }); await ctx.fs.mkdir('tree/empty');
  assert.equal((await ctx.run('find tree')).output, 'tree\ntree/a\ntree/empty\ntree/sub\ntree/sub/b');
  assert.equal((await ctx.run('find ./tree -maxdepth 1')).output, './tree\n./tree/a\n./tree/empty\n./tree/sub');
  assert.equal((await ctx.run('find /tree -maxdepth 0')).output, '/tree');
  assert.equal((await ctx.run('find tree/ -maxdepth 0')).output, 'tree/');
  assert.equal((await ctx.run('find tree/a')).output, 'tree/a');
  assert.equal((await ctx.run('find -maxdepth 0')).output, '.');
  assert.equal((await ctx.run('find . -maxdepth 0 -name .')).output, '.');
  assert.equal((await ctx.run('find / -maxdepth 0')).output, '/');
});

test('find preserves multiple-root order and does not deduplicate overlapping roots', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/a': 'a', 'other/b': 'b' });
  assert.equal((await ctx.run('find other tree -type f')).output, 'other/b\ntree/a');
  assert.equal((await ctx.run('find tree tree/a -type f')).output, 'tree/a\ntree/a');
  const mixed = await ctx.run('find missing tree -type f');
  assert.equal(mixed.code, 1); assert.match(mixed.output, /missing/); assert.match(mixed.output, /tree\/a/);
});

test('find depth limits apply globally while mindepth suppresses only shallow expression evaluation', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/a': 'a', 'tree/sub/b': 'b', 'tree/sub/deep/c': 'c' });
  assert.equal((await ctx.run('find tree -mindepth 1 -maxdepth 1')).output, 'tree/a\ntree/sub');
  assert.equal((await ctx.run('find tree -mindepth 2 -type f')).output, 'tree/sub/b\ntree/sub/deep/c');
  assert.equal((await ctx.run("find tree -name impossible -o -maxdepth 0 -print")).output, 'tree');
});

test('find basename and path glob predicates include leading dots and preserve repeated predicates', async () => {
  const ctx = fresh();
  await seed(ctx, { 'tree/.hidden.txt': '', 'tree/Alpha.TXT': '', 'tree/a.txt': '', 'tree/b.txt': '', 'tree/sub/a.txt': '', 'tree/c.log': '' });
  assert.equal((await ctx.run("find tree -type f -name '*.txt'")).output, 'tree/.hidden.txt\ntree/a.txt\ntree/b.txt\ntree/sub/a.txt');
  assert.equal((await ctx.run("find tree -iname '*.txt' -name 'A*'")).output, 'tree/Alpha.TXT');
  assert.equal((await ctx.run("find tree -name '[ab].txt'")).output, 'tree/a.txt\ntree/b.txt\ntree/sub/a.txt');
  assert.equal((await ctx.run("find tree -name '[!a].txt'")).output, 'tree/b.txt');
  assert.equal((await ctx.run("find tree -name '[[.a.]].txt'")).output, 'tree/a.txt\ntree/sub/a.txt');
  assert.equal((await ctx.run("find tree -name '[[=a=]].txt'")).output, 'tree/a.txt\ntree/sub/a.txt');
  assert.equal((await ctx.run("find tree -path 'tree/*/a.?xt'")).output, 'tree/sub/a.txt');
  assert.equal((await ctx.run("find ./tree -path './tree/*a.txt'")).output, './tree/a.txt\n./tree/sub/a.txt');
  await ctx.fs.write('tree/[', '');
  assert.equal((await ctx.run("find tree -name '['")).output, 'tree/[', 'an unmatched bracket opener is a literal glob character');
  await seed(ctx, { 'tree/[]': '', 'tree/[!]': '', 'tree/[^]': '' });
  for (const name of ['[]', '[!]', '[^]']) {
    assert.equal((await ctx.run(`find tree -name ${quote(name)}`)).output, `tree/${name}`);
  }
});

test('find regex predicates use bounded POSIX ERE and match the entire displayed path', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/a.txt': '', 'tree/b.js': '', 'tree/sub/a.txt': '' });
  assert.equal((await ctx.run("find tree -regex 'tree/(a[.]txt|b[.]js)'")).output, 'tree/a.txt\ntree/b.js');
  assert.equal((await ctx.run("find tree -regex 'a[.]txt'")).output, '');
  const invalid = await ctx.run("find tree -delete -regex '['");
  assert.equal(invalid.code, 2); assert.equal(ctx.shell.awaitingConfirm, null);
  assert.equal((await ctx.fs.stat('tree/a.txt')).ok, true); assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('find boolean precedence, negation and grouping short-circuit actions', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/a': '', 'tree/b': '', 'tree/c': '' });
  assert.equal((await ctx.run('find tree -name a -o -name b -a -type f')).output, 'tree/a\ntree/b');
  assert.equal((await ctx.run("find tree '(' -name a -o -name b ')' '!' -name b")).output, 'tree/a');
  assert.equal((await ctx.run("find tree -type f -a '!' '(' -name a -o -name b ')'")).output, 'tree/c');
  const skipped = await ctx.run("find tree -name impossible -delete -o -print");
  assert.equal(skipped.code, 0); assert.equal(ctx.shell.awaitingConfirm, null);
  assert.match(skipped.output, /tree\/a/); assert.equal((await ctx.fs.stat('tree/a')).ok, true);
  assert.equal((await ctx.run('find tree -name impossible -print')).output, '', 'an explicit action suppresses default print globally');
});

test('find prune prevents listing a matched subtree and retains its implicit print behavior', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/keep/a': '', 'tree/skip/private': '' });
  const original = ctx.backend.list.bind(ctx.backend), listed = [];
  ctx.backend.list = async (path) => { listed.push(path); return original(path); };
  assert.equal((await ctx.run('find tree -name skip -prune -o -print')).output, 'tree\ntree/keep\ntree/keep/a');
  assert.equal(listed.includes('tree/skip'), false, 'pruned children never enter traversal');
  assert.equal((await ctx.run('find tree -name skip -prune')).output, 'tree/skip');
  const invalid = await ctx.run('find tree -prune -delete');
  assert.equal(invalid.code, 2); assert.equal(ctx.shell.awaitingConfirm, null);
  assert.equal((await ctx.fs.stat('tree/skip/private')).ok, true);
});

test('find empty distinguishes empty files, empty directories and nonempty directories', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/zero': '', 'tree/full': 'x', 'tree/dir/zero': '' });
  await ctx.fs.mkdir('tree/empty'); ctx.backend.symlink('tree/link', 'zero');
  assert.equal((await ctx.run('find tree -empty')).output, 'tree/dir/zero\ntree/empty\ntree/zero');
  assert.equal((await ctx.run('find tree -type d -empty')).output, 'tree/empty');
});

test('find size predicates round upward in the selected units and honor numeric comparisons', async () => {
  const ctx = fresh();
  await seed(ctx, { 'tree/zero': '', 'tree/one': 'x', 'tree/512': new Uint8Array(512), 'tree/513': new Uint8Array(513), 'tree/1025': new Uint8Array(1025) });
  assert.equal((await ctx.run('find tree -type f -size 1')).output, 'tree/512\ntree/one');
  assert.equal((await ctx.run('find tree -type f -size +1b')).output, 'tree/1025\ntree/513');
  assert.equal((await ctx.run('find tree -type f -size -1k')).output, 'tree/zero');
  assert.equal((await ctx.run('find tree -type f -size 513c')).output, 'tree/513');
  assert.equal((await ctx.run('find tree -type f -size 257w')).output, 'tree/513');
  assert.equal((await ctx.run('find tree -type f -size 1M')).output, 'tree/1025\ntree/512\ntree/513\ntree/one');
  assert.equal((await ctx.run('find tree -type f -size 1G')).output, 'tree/1025\ntree/512\ntree/513\ntree/one');
});

test('find time predicates use completed intervals and newer compares strictly', async () => {
  const ctx = fresh();
  await seed(ctx, { 'tree/recent': '', 'tree/minute': '', 'tree/two': '', 'days/half': '', 'days/one': '', 'days/two': '', reference: '' });
  const now = Date.now(), timestamps = new Map([
    ['tree/recent', now - 30000], ['tree/minute', now - 90000], ['tree/two', now - 150000],
    ['days/half', now - 12 * 3600000], ['days/one', now - 36 * 3600000], ['days/two', now - 60 * 3600000], ['reference', now - 90000],
  ]);
  const original = ctx.backend.stat.bind(ctx.backend);
  ctx.backend.stat = async (path) => { const stat = await original(path); return stat && timestamps.has(path) ? { ...stat, mtimeMs: timestamps.get(path) } : stat; };
  assert.equal((await ctx.run('find tree -type f -mmin 1')).output, 'tree/minute');
  assert.equal((await ctx.run('find tree -type f -mmin -1')).output, 'tree/recent');
  assert.equal((await ctx.run('find tree -type f -mmin +1')).output, 'tree/two');
  assert.equal((await ctx.run('find days -type f -mtime 1')).output, 'days/one');
  assert.equal((await ctx.run('find days -type f -mtime -1')).output, 'days/half');
  assert.equal((await ctx.run('find days -type f -mtime +1')).output, 'days/two');
  assert.equal((await ctx.run('find tree -type f -newer reference')).output, 'tree/recent');
});

test('find reports unavailable timestamps only when evaluated and validates newer references before removals', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/file': 'keep' });
  const unavailable = await ctx.run('find tree -maxdepth 0 -mtime 0');
  assert.equal(unavailable.code, 1); assert.match(unavailable.output, /time|metadata|unavailable/i);
  assert.equal((await ctx.run('find tree -type f -mtime 0')).code, 0, 'type short-circuit avoids unsupported directory timestamps');
  const missing = await ctx.run('find tree -delete -newer missing');
  assert.equal(missing.code, 1); assert.equal(ctx.shell.awaitingConfirm, null);
  assert.equal(await ctx.read('tree/file'), 'keep'); assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('find does not follow normal, dangling or looping terminal links', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/target': 'safe', 'tree/dir/child': 'child' });
  ctx.backend.symlink('tree/link', 'target'); ctx.backend.symlink('tree/alias', 'dir');
  ctx.backend.symlink('tree/dangling', 'missing'); ctx.backend.symlink('tree/loop', 'loop');
  const result = await ctx.run('find tree -type l');
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output, 'tree/alias\ntree/dangling\ntree/link\ntree/loop');
  assert.equal((await ctx.run('find tree -type f')).output, 'tree/dir/child\ntree/target');
  assert.equal((await ctx.run('find tree/link -type l')).output, 'tree/link');
});

test('find link deletion stages only the link and preserves a protected target', async () => {
  const ctx = fresh({ readOnlyPrefixes: ['target'] });
  await ctx.fs.write('target', 'protected'); ctx.backend.symlink('link', 'target');
  const pending = await ctx.run('find link -delete');
  assert.ok(pending.awaitingConfirm); assert.equal((await ctx.backend.stat('link')).type, 'symlink');
  assert.equal(await ctx.read('target'), 'protected');
  const result = await ctx.run('y'); assert.equal(result.code, 0, result.output);
  assert.equal(await ctx.backend.stat('link'), null); assert.equal(await ctx.read('target'), 'protected');
  assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('find exec rm stages final and dangling links while preserving protected targets on acceptance and refusal', async () => {
  const ctx = fresh({ readOnlyPrefixes: ['target'] });
  await seed(ctx, { target: 'protected', 'tree/ordinary': 'keep' });
  ctx.backend.symlink('tree/link', '../target'); ctx.backend.symlink('tree/dangling', '../missing');
  const pending = await ctx.run("find tree -type l -exec rm '{}' ';'");
  assert.ok(pending.awaitingConfirm, pending.output);
  assert.equal((await ctx.backend.stat('tree/dangling')).type, 'symlink');
  assert.equal((await ctx.backend.stat('tree/link')).type, 'symlink');
  assert.equal(await ctx.read('target'), 'protected');
  const refused = await ctx.run('n');
  assert.equal(refused.code, 1); assert.match(refused.output, /cancelled/);
  assert.equal((await ctx.backend.stat('tree/dangling')).type, 'symlink');
  assert.equal((await ctx.backend.stat('tree/link')).type, 'symlink');
  assert.equal(await ctx.read('target'), 'protected'); assert.deepEqual(ctx.face.pendingProposals(), []);
  const removed = await accepted(ctx, "find tree -type l -exec rm '{}' ';'");
  assert.equal(removed.code, 0, removed.output); assert.equal(removed.confirmations, 2);
  assert.equal(await ctx.backend.stat('tree/dangling'), null); assert.equal(await ctx.backend.stat('tree/link'), null);
  assert.equal(await ctx.read('target'), 'protected'); assert.equal(await ctx.read('tree/ordinary'), 'keep');
  assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('find escaping symlink ancestors retain containment errors', async () => {
  const ctx = fresh(); ctx.backend.symlink('escape', '../../outside');
  const result = await ctx.run('find escape/file');
  assert.equal(result.code, 1); assert.match(result.output, /escape|outside|EINVAL_PATH/i);
  assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('find requests metadata without loading file contents for predicates, traversal or deletion', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/a': 'keep until accepted', 'tree/zero': '' });
  await ctx.fs.mkdir('tree/empty');
  const originalStat = ctx.backend.stat.bind(ctx.backend), originalRead = ctx.backend.readBinary.bind(ctx.backend);
  let reads = 0;
  ctx.backend.readBinary = async (...args) => { reads++; return originalRead(...args); };
  // Model a provider whose ordinary stat computes content-derived metadata.
  ctx.backend.stat = async (path, options) => {
    const stat = await originalStat(path, options);
    if (stat?.type === 'file' && !options?.metadataOnly) await ctx.backend.readBinary(path);
    return stat;
  };
  assert.equal((await ctx.run('find tree -type f -size +0c')).output, 'tree/a');
  assert.equal((await ctx.run('find tree -empty')).output, 'tree/empty\ntree/zero');
  const removed = await accepted(ctx, 'find tree/a -delete');
  assert.equal(removed.code, 0, removed.output);
  assert.equal(reads, 0, 'find must not trigger a provider full-content fallback');
  ctx.backend.stat = originalStat; ctx.backend.readBinary = originalRead;
  assert.equal((await ctx.fs.stat('tree/a')).ok, false); assert.equal(await ctx.read('tree/zero'), '');
});

test('find reports unavailable size metadata instead of loading contents to synthesize it', async () => {
  const ctx = fresh(); await ctx.fs.write('file', 'content');
  const originalStat = ctx.backend.stat.bind(ctx.backend), originalRead = ctx.backend.readBinary.bind(ctx.backend);
  let reads = 0;
  ctx.backend.readBinary = async (...args) => { reads++; return originalRead(...args); };
  ctx.backend.stat = async (path, options) => {
    const stat = await originalStat(path, options);
    if (path !== 'file' || !stat) return stat;
    if (options?.metadataOnly) return { ...stat, size: undefined };
    await ctx.backend.readBinary(path); return stat;
  };
  assert.equal((await ctx.run('find file -type f')).output, 'file');
  const result = await ctx.run('find file -size 1c');
  assert.equal(result.code, 1); assert.match(result.output, /size.*unavailable|metadata|ENODATA/i);
  assert.equal(reads, 0);
});

test('find print0 emits complete UTF-8 path bytes and no line-listing truncation metadata', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/a b': '', 'tree/é': '', 'tree/line break': '' });
  const result = await ctx.run('find tree -type f -print0 > output'); assert.equal(result.code, 0, result.output);
  const expected = ['tree/a b', 'tree/line break', 'tree/é'].map((path) => `${path}\0`).join('');
  assert.deepEqual(await ctx.bytes('output'), Array.from(new TextEncoder().encode(expected)));
  assert.equal(ctx.shell.lastListing, null);
});

test('find delete uses postorder nonrecursive removals and preserves unselected children', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/dir/a': 'a', 'tree/dir/b': 'b' }); await ctx.fs.mkdir('tree/empty');
  const original = ctx.backend.delete.bind(ctx.backend), deleted = [];
  ctx.backend.delete = async (path) => { deleted.push(path); return original(path); };
  const result = await accepted(ctx, 'find tree -delete');
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(deleted, ['tree/dir/a', 'tree/dir/b', 'tree/dir', 'tree/empty', 'tree']);
  assert.equal((await ctx.fs.stat('tree')).ok, false); assert.deepEqual(ctx.face.pendingProposals(), []);
  await seed(ctx, { 'kept/dir/file': 'keep' });
  const selective = await accepted(ctx, 'find kept -type d -delete');
  assert.equal(selective.code, 1); assert.equal(await ctx.read('kept/dir/file'), 'keep');
});

test('declining a find deletion preserves files and clears all pending proposals', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/a': 'keep', 'tree/b': 'also keep' });
  const pending = await ctx.run('find tree -type f -delete'); assert.ok(pending.awaitingConfirm);
  const result = await ctx.run('n'); assert.equal(result.code, 1); assert.match(result.output, /cancelled/);
  assert.equal(await ctx.read('tree/a'), 'keep'); assert.equal(await ctx.read('tree/b'), 'also keep');
  assert.deepEqual(ctx.face.pendingProposals(), []); assert.equal(ctx.shell.awaitingConfirm, null);
});

test('find exec semicolon substitutes arguments literally and quoted or escaped terminators survive the shell', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/a': 'a', 'tree/b': 'b' });
  assert.equal((await ctx.run("find tree -type f -exec printf '[%s]\\n' '{}' ';'")).output, '[tree/a]\n[tree/b]');
  assert.equal((await ctx.run("find tree/a -exec printf '[%s]\\n' 'pre:{}:post' \\; ; echo AFTER")).output, '[pre:tree/a:post]\nAFTER');
  const names = ['$WORD', '*.txt', 'a b', 'a;touch ESCAPED'];
  for (const name of names) await ctx.fs.write(`weird/${name}`, '', { createParents: true });
  const command = "find weird -type f -exec printf '<%s>\\n' '{}' ';' > output";
  const result = await ctx.run(command); assert.equal(result.code, 0, result.output);
  assert.equal(await ctx.read('output'), names.sort().map((name) => `<weird/${name}>\n`).join(''));
  assert.equal((await ctx.fs.stat('ESCAPED')).ok, false);
});

test('find preserves the inherited newline-path refusal without executing a split filename', async () => {
  const ctx = fresh(), path = 'tree/line\nbreak';
  const rejected = await ctx.fs.write(path, 'keep', { createParents: true });
  assert.equal(rejected.ok, false); assert.equal(rejected.code, 'EINVAL_PATH');
  // A provider could already contain this unsupported name. Governed traversal
  // must still refuse it instead of treating either line as shell source.
  await ctx.backend.write(path, new TextEncoder().encode('keep'));
  const result = await ctx.run(`find ${quote(path)} -exec touch created ';'`);
  assert.equal(result.code, 1); assert.match(result.output, /control|EINVAL_PATH|invalid|EGRANT/i);
  assert.equal((await ctx.fs.stat('created')).ok, false);
  assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('find exec truth values distinguish per-entry failures from batched failures', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/a': '', 'tree/b': '' });
  const perEntry = await ctx.run("find tree/a -exec false '{}' ';'");
  assert.equal(perEntry.code, 0); assert.equal(perEntry.output, '');
  assert.equal((await ctx.run("find tree/a -exec false '{}' ';' -o -print")).output, 'tree/a');
  const batch = await ctx.run('find tree -type f -exec false {} + -print');
  assert.equal(batch.code, 1); assert.equal(batch.output, 'tree/a\ntree/b');
});

test('find preserves an accepted earlier batch when a later batch fails its grant', async () => {
  const ctx = fresh({ readOnlyPrefixes: ['tree/b'] });
  await seed(ctx, { 'tree/a/first': 'remove after approval', 'tree/b/later': 'protected' });
  // Different execdir directories force two batches with only two files.
  const result = await accepted(ctx, "find tree -type f -execdir rm '{}' +");
  assert.equal(result.code, 1, 'a failed later batch makes the aggregate status nonzero');
  assert.equal(result.confirmations, 1, 'only the permitted batch receives an approval proposal');
  assert.equal((await ctx.fs.stat('tree/a/first')).ok, false, 'the completed earlier mutation remains committed');
  assert.equal(await ctx.read('tree/b/later'), 'protected');
  assert.deepEqual(ctx.face.pendingProposals(), []);
  const receipts = (await ctx.opLog.read()).filter((entry) => entry.command === 'fs.remove');
  assert.deepEqual(receipts.map((entry) => entry.status), ['staged', 'ok', 'EGRANT']);
  assert.equal(receipts[0].argsDigest, receipts[1].argsDigest, 'the accepted receipt identifies the staged removal');
  assert.notEqual(receipts[1].argsDigest, receipts[2].argsDigest, 'the denied later batch identifies a different removal');
});

test('find exec preserves nested binary output and supplies empty stdin to each invocation', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/a': Uint8Array.of(0, 255), 'tree/b': Uint8Array.of(128, 10) });
  for (const terminator of ["';'", '+']) {
    const result = await ctx.run(`find tree -type f -exec cat '{}' ${terminator} > output`);
    assert.equal(result.code, 0, result.output); assert.deepEqual(await ctx.bytes('output'), [0, 255, 128, 10]);
  }
  const raw = await ctx.run("find tree -type f -exec printf '%s' x ';' > output");
  assert.equal(raw.code, 0, raw.output); assert.deepEqual(await ctx.bytes('output'), [120, 120], 'raw printf output gains no newline');
  const framed = await ctx.run("find tree -type f -exec pwd ';' > output");
  assert.equal(framed.code, 0, framed.output); assert.deepEqual(await ctx.bytes('output'), [47, 10, 47, 10], 'legacy pwd output retains native line framing');
  assert.equal((await ctx.run("printf BAD | find tree -type f -exec cat ';'")).output, '');
});

test('find exec batching retains every filename when argv limits require multiple invocations', { timeout: 15000 }, async () => {
  const ctx = fresh();
  for (let i = 0; i < 4100; i++) await ctx.fs.write(`many/f${String(i).padStart(4, '0')}`, '', { createParents: true });
  const result = await ctx.run("find many -type f -exec awk 'BEGIN {print ARGC-1}' {} +");
  assert.equal(result.code, 0, result.output);
  const counts = result.output.split('\n').map(Number);
  assert.ok(counts.length >= 2); assert.equal(counts.reduce((sum, count) => sum + count, 0), 4100);
  assert.ok(counts.every((count) => count > 0 && count <= 4096));
});

test('find exec and execdir restore cwd even when a nested command changes it', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/a': '', 'tree/sub/b': '' }); await ctx.fs.mkdir('other');
  const ordinary = await ctx.run("find tree -type f -exec cd other ';' -exec pwd ';'");
  assert.equal(ordinary.code, 0, ordinary.output); assert.equal(ordinary.output, '/\n/');
  assert.equal((await ctx.run('pwd')).output, '/');
  const nearby = await ctx.run("find tree -type f -execdir cd /other ';' -execdir pwd ';'");
  assert.equal(nearby.code, 0, nearby.output); assert.equal(nearby.output, '/tree\n/tree/sub');
  assert.equal((await ctx.run('pwd')).output, '/');
  // GNU documents './' before every execdir filename except the root '/'.
  assert.equal((await ctx.run("find . -maxdepth 0 -execdir printf '[%s]' '{}' ';'")).output, '[./.]');
});

test('find execdir substitutes safe local names and batches each containing directory separately', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/-odd': '', 'tree/a': '', 'tree/sub/b': '', 'tree/sub/c': '' });
  const program = 'BEGIN {for(i=1;i<ARGC;i++)printf "%s%s",(i==1?"[":","),ARGV[i];print "]"}';
  const result = await ctx.run(`find tree -type f -execdir awk ${quote(program)} {} +`);
  assert.equal(result.code, 0, result.output); assert.equal(result.output, '[./-odd,./a]\n[./b,./c]');
  assert.equal((await ctx.run('pwd')).output, '/');
});

test('find rejects malformed expressions and execution templates before any mutation', async () => {
  const ctx = fresh(); await ctx.fs.write('file', 'keep');
  const expressions = [
    '-type X', '-size nope', '-size 9007199254740992G', '-maxdepth -1', '-mindepth nope', '-mtime 1.5',
    '-name', '-unsupported', "'(' -name file", "-name file ')'", '-name file stray',
    '-delete -exec echo {}', '-delete -exec echo +', '-delete -exec echo x{} +',
    '-delete -exec echo {} {} +', '-delete -exec echo {} misplaced +', '-delete -execdir +',
  ];
  for (const expression of expressions) {
    const result = await ctx.run(`find file ${expression}`);
    assert.equal(result.code, 2, expression); assert.equal(ctx.shell.awaitingConfirm, null, expression);
    assert.equal(await ctx.read('file'), 'keep'); assert.deepEqual(ctx.face.pendingProposals(), []);
  }
  assert.equal((await ctx.run("find ''")).code, 2);
});

test('find traversal and deletion preserve grants, including mutations inside exec', async () => {
  const ctx = fresh({ scopes: ['fs:read'] }); await seed(ctx, { 'tree/a': 'keep', 'tree/b': 'also keep' });
  for (const command of ['find tree -type f -delete', 'find tree -type f -exec rm {} +']) {
    const result = await ctx.run(command); assert.equal(result.code, 1, command);
    assert.match(result.output, /EGRANT|not granted/, command); assert.equal(ctx.shell.awaitingConfirm, null);
    assert.equal(await ctx.read('tree/a'), 'keep'); assert.equal(await ctx.read('tree/b'), 'also keep');
    assert.deepEqual(ctx.face.pendingProposals(), []);
  }
  const restricted = fresh({ prefixes: ['allowed'] });
  await seed(restricted, { 'allowed/file': '', 'private/secret-name': '' });
  const listed = await restricted.run('find allowed private -type f');
  assert.equal(listed.code, 1); assert.match(listed.output, /allowed\/file/);
  assert.doesNotMatch(listed.output, /secret-name/);
});

test('Stop during nested execdir removal preserves later files and restores cwd for the next invocation', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/a': 'a', 'tree/b': 'b' });
  await ctx.fs.mkdir('caller'); await ctx.run('cd caller');
  const first = await ctx.run("find /tree -type f -execdir rm '{}' ';'; echo BAD > after-stop");
  assert.ok(first.awaitingConfirm); assert.equal(await ctx.read('tree/a'), 'a');
  const second = await ctx.run('y'); assert.ok(second.awaitingConfirm);
  assert.equal((await ctx.fs.stat('tree/a')).ok, false); assert.equal(await ctx.read('tree/b'), 'b');
  const stopped = await ctx.shell.cancel(); assert.equal(ctx.shell.lastCode, 130); assert.match(stopped.output, /interrupted/);
  assert.equal(await ctx.read('tree/b'), 'b'); assert.equal((await ctx.fs.stat('caller/after-stop')).ok, false);
  assert.deepEqual(ctx.face.pendingProposals(), []); assert.equal(ctx.shell.awaitingConfirm, null);
  assert.equal((await ctx.run('pwd')).output, '/caller'); assert.equal((await ctx.run('cat /tree/b')).output, 'b');
});

test('reset during execdir suspension retains configured initial cwd instead of an abandoned caller cwd', async () => {
  const ctx = fresh({ cwd: 'home' }); await ctx.fs.mkdir('home');
  await seed(ctx, { 'caller/tree/file': 'keep' });
  await ctx.run('cd /caller');
  const first = await ctx.run("find tree -type f -execdir rm '{}' ';'; echo BAD > after-reset");
  assert.ok(first.awaitingConfirm);
  ctx.shell.reset();
  assert.equal((await ctx.run('pwd')).output, '/home');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ctx.shell.cwd, 'home'); assert.equal(ctx.shell.awaitingConfirm, null);
  assert.equal(await ctx.read('caller/tree/file'), 'keep');
  assert.equal((await ctx.fs.stat('caller/after-reset')).ok, false);
  assert.equal((await ctx.fs.stat('home/after-reset')).ok, false);
  assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('find discards unstarted exec batches after Stop', async () => {
  const ctx = fresh(); await seed(ctx, { 'tree/a': 'a', 'tree/b': 'b' });
  const pending = await ctx.run("find tree -type f -exec rm {} + ; echo BAD > after-stop");
  assert.ok(pending.awaitingConfirm);
  await ctx.shell.cancel(); assert.equal(ctx.shell.lastCode, 130);
  assert.equal(await ctx.read('tree/a'), 'a'); assert.equal(await ctx.read('tree/b'), 'b');
  assert.equal((await ctx.fs.stat('after-stop')).ok, false); assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal((await ctx.run('pwd')).output, '/');
});

test('find rejects an oversized immediate listing before queuing or executing children', async () => {
  const ctx = fresh(); await ctx.fs.mkdir('tree');
  const originalList = ctx.backend.list.bind(ctx.backend), originalStat = ctx.backend.stat.bind(ctx.backend);
  let childStats = 0;
  ctx.backend.list = async (path) => path === 'tree' ? Array.from({ length: 100001 }, (_, i) => `tree/f${i}`) : originalList(path);
  ctx.backend.stat = async (path) => {
    if (path.startsWith('tree/f')) { childStats++; return { type: 'file', size: 0, mtimeMs: 1 }; }
    return originalStat(path);
  };
  const result = await ctx.run("find tree -mindepth 1 -exec touch created ';'");
  assert.equal(result.code, 2); assert.match(result.output, /limit|too (?:many|large)/i);
  assert.equal(childStats, 0); assert.equal((await ctx.fs.stat('created')).ok, false);
});

test('find bounds aggregate nested-command output before accepting every selected result', { timeout: 10000 }, async () => {
  const ctx = fresh();
  for (let i = 0; i < 257; i++) await ctx.fs.write(`tree/f${i}`, '', { createParents: true });
  const program = 'BEGIN {printf "%65536s","x"}';
  const result = await ctx.run(`find tree -type f -exec awk ${quote(program)} ';'`);
  assert.equal(result.code, 2, result.output); assert.match(result.output, /output.*limit|limit.*output/i);
  assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('find rejects excessive expression nesting before any action', async () => {
  const ctx = fresh(); await ctx.fs.write('file', 'keep');
  const expression = [...Array(2048).fill("'('"), '-delete', ...Array(2048).fill("')'")].join(' ');
  const result = await ctx.run(`find file ${expression}`);
  assert.equal(result.code, 2); assert.match(result.output, /nest|depth|limit/i);
  assert.doesNotMatch(result.output, /RangeError|call stack/i);
  assert.equal(await ctx.read('file'), 'keep'); assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('find bounds adversarial regex work while permitting a correct empty result', { timeout: 5000 }, async () => {
  const ctx = fresh(); await ctx.fs.write(`tree/${'a'.repeat(64)}`, '', { createParents: true });
  const result = await ctx.run("find tree -regex 'tree/(a|aa)*b'");
  if (result.code === 0) assert.equal(result.output, '');
  else { assert.equal(result.code, 2); assert.match(result.output, /limit|bound|too (?:many|large)/i); }
  assert.doesNotMatch(result.output, /RangeError|call stack/i);
});

test('find observes Stop during directory I/O before child actions and later shell writes', async () => {
  const controller = new AbortController(), ctx = fresh({ signal: controller.signal });
  await seed(ctx, { 'tree/a': 'a' });
  const original = ctx.backend.list.bind(ctx.backend);
  ctx.backend.list = async (path) => { const result = await original(path); if (path === 'tree') controller.abort(); return result; };
  const result = await ctx.run("find tree -mindepth 1 -exec touch created ';'; echo BAD > after-stop");
  assert.equal(result.code, 130, result.output); assert.match(result.output, /interrupted/);
  assert.equal((await ctx.fs.stat('created')).ok, false); assert.equal((await ctx.fs.stat('after-stop')).ok, false);
  assert.deepEqual(ctx.face.pendingProposals(), []);
});
