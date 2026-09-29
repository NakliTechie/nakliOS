import test from 'node:test';
import assert from 'node:assert/strict';
import { createShell } from '../shell.mjs';
import { createIO } from '../io.mjs';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { CrateBackend } from '../../fileops/crate-backend.mjs';
import { OverlayBackend } from '../../fileops/overlay-backend.mjs';
import { FsaBackend } from '../../fileops/fsa-backend.mjs';
import { buildRigRegistry, createRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';
import { createInspectionCommands } from '../cmds/inspection.mjs';
import { createMutationCommands } from '../cmds/mutation.mjs';
import { createPathCommands } from '../cmds/paths.mjs';

const names = ['readlink', 'realpath', 'rmdir', 'mktemp', 'truncate', 'unlink', 'du', 'tree', 'file', 'strings', 'cmp', 'ln', 'link'];
const encode = (value) => new TextEncoder().encode(value);
function fresh({ backend = new MemoryBackend(), scopes = ['fs:read', 'fs:write', 'fs:remove'], prefixes = [''], readOnlyPrefixes = [], stageWrites = false, beforeOperation } = {}) {
  const fs = createFileops({ backend }), base = buildRigRegistry({ fs });
  const registry = stageWrites || beforeOperation ? createRegistry(base.commands.map((command) => ({
    ...command,
    ...(stageWrites && ['fs.write', 'fs.create', 'fs.truncate'].includes(command.name) ? { destructive: true } : {}),
    ...(beforeOperation ? { run: async (input, context) => {
      await beforeOperation(command.name, input, { backend, fs }); return command.run(input, context);
    } } : {}),
  }))) : base;
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant: createGrant({ scopes, prefixes, readOnlyPrefixes }), opLog, actor: 'u2b-contract' });
  const shell = createShell({ registry, face });
  const run = async (command) => ({ ...await shell.feed(command), code: shell.lastCode });
  const bytes = async (path) => { const result = await fs.read(path); assert.equal(result.ok, true, result.message); return Array.from(result.data); };
  const read = async (path) => { const result = await fs.read(path, { encoding: 'utf-8' }); assert.equal(result.ok, true, result.message); return result.data; };
  const io = createIO({ invoke: (name, input) => face.invoke(name, input) });
  return { backend, fs, registry, face, shell, opLog, run, bytes, read, io };
}
async function seed(ctx, entries) {
  for (const [path, data] of Object.entries(entries)) assert.equal((await ctx.fs.write(path, data, { createParents: true })).ok, true);
}
async function output(ctx, command, expected) {
  const result = await ctx.run(`${command} > /captured`); assert.equal(result.code, 0, result.output);
  assert.deepEqual(await ctx.bytes('captured'), Array.from(typeof expected === 'string' ? encode(expected) : expected));
}
async function accept(ctx, command) {
  let result = await ctx.run(command), proposals = 0;
  while (result.awaitingConfirm) { assert.ok(++proposals <= 32); result = await ctx.run('y'); }
  return result;
}

// Expectations are authored before B05 verification release. Native oracles run only after the entire batch is built.
test('all filesystem and inspection command names are discoverable through the public shell', () => {
  const ctx = fresh(); for (const name of names) assert.ok(ctx.shell.commands.includes(name), name);
});

test('readlink exposes literal final targets with exact newline and NUL framing', async () => {
  const ctx = fresh(); await seed(ctx, { 'target/file': 'x' }); await ctx.fs.mkdir('links');
  ctx.backend.symlink('links/one', '../target/file'); ctx.backend.symlink('links/dangling', '../missing');
  await output(ctx, 'readlink links/one', '../target/file\n');
  await output(ctx, 'readlink -n links/one', '../target/file');
  await output(ctx, 'readlink -z links/one links/dangling', '../target/file\0../missing\0');
  await output(ctx, 'readlink links/dangling', '../missing\n');
  assert.equal((await ctx.run('readlink target/file')).code, 1);
  await output(ctx, 'readlink -n links/one links/dangling', '../target/file\n../missing\n');
  const quiet = await ctx.run('readlink -q target/file'); assert.equal(quiet.code, 1); assert.equal(quiet.output, '');
  const verbose = await ctx.run('readlink -v target/file'); assert.equal(verbose.code, 1); assert.match(verbose.output, /symbolic link/);
});

test('canonical paths distinguish missing final components from existing and fully missing modes', async () => {
  const ctx = fresh(); await seed(ctx, { 'target/file': 'x' }); ctx.backend.symlink('alias', 'target');
  await output(ctx, 'realpath alias/file', '/target/file\n');
  await output(ctx, 'readlink -f alias/missing', '/target/missing\n');
  await output(ctx, 'realpath alias/missing', '/target/missing\n');
  await output(ctx, 'realpath -E alias/missing', '/target/missing\n');
  await output(ctx, 'realpath -m alias/new/missing', '/target/new/missing\n');
  await output(ctx, 'readlink -m alias/new/missing', '/target/new/missing\n');
  assert.notEqual((await ctx.run('realpath alias/new/missing')).code, 0);
  assert.notEqual((await ctx.run('realpath -e alias/missing')).code, 0);
  assert.notEqual((await ctx.run('readlink -e alias/missing')).code, 0);
  assert.notEqual((await ctx.run('realpath target/file/child')).code, 0);
});

test('final link target slashes allow a missing final component but require existing targets to be directories', async () => {
  const ctx = fresh(); await seed(ctx, { regular: 'x' }); await ctx.fs.mkdir('directory');
  for (const [name, target] of Object.entries({ missingLink: 'missing/', fileLink: 'regular/', dirLink: 'directory/',
    outerMissing: 'missingLink', outerFile: 'fileLink', outerDirectory: 'dirLink' })) ctx.backend.symlink(name, target);
  for (const [name, target] of [['missingLink', 'missing'], ['outerMissing', 'missing'], ['dirLink', 'directory'], ['outerDirectory', 'directory']]) {
    for (const command of ['realpath', 'realpath -L', 'readlink -f']) await output(ctx, `${command} ${name}`, `/${target}\n`);
    await output(ctx, `realpath -s ${name}`, `/${name}\n`);
  }
  for (const name of ['fileLink', 'outerFile']) {
    for (const command of ['realpath', 'realpath -L', 'realpath -s', 'readlink -f']) assert.equal((await ctx.run(`${command} ${name}`)).code, 1);
  }
});

test('realpath resolves physical dot-dot after links while logical and no-link modes retain lexical ancestry', async () => {
  const ctx = fresh(); await ctx.fs.mkdir('a'); await seed(ctx, { 'b/c/file': 'x' });
  ctx.backend.symlink('a/link', '../b/c');
  await output(ctx, 'realpath a/link/..', '/b\n');
  await output(ctx, 'realpath -P a/link/..', '/b\n');
  await output(ctx, 'realpath -L a/link/..', '/a\n');
  await output(ctx, 'realpath -s a/link/..', '/a\n');
  await output(ctx, 'realpath -s a/link/file', '/a/link/file\n');
  await output(ctx, 'realpath a//link/./file', '/b/c/file\n');
  await output(ctx, 'realpath -s -P a/link', '/b/c\n');
  await output(ctx, 'realpath -s -L a/link', '/b/c\n');
  await output(ctx, 'realpath -P -s a/link', '/a/link\n');
  await output(ctx, 'realpath -L -s a/link', '/a/link\n');
});

test('realpath reports root-relative and explicitly relative paths from the current directory', async () => {
  const ctx = fresh(); await seed(ctx, { 'a/b/file': 'x', 'a/other': 'y' });
  await output(ctx, 'realpath /', '/\n');
  await output(ctx, 'realpath --relative-to=a a/b/file', 'b/file\n');
  await output(ctx, 'realpath --relative-to=a/b a/other', '../other\n');
  await output(ctx, 'realpath --relative-to=a --relative-base=a a/b/file /', 'b/file\n/\n');
  assert.equal((await ctx.run('cd a/b')).code, 0);
  await output(ctx, 'realpath -z ./file', '/a/b/file\0');
});

test('existing-mode relative path bases must name directories', async () => {
  const ctx = fresh(); await seed(ctx, { regular: 'x', other: 'y' });
  assert.notEqual((await ctx.run('realpath -e --relative-to=regular other')).code, 0);
  assert.notEqual((await ctx.run('realpath -e --relative-base=regular other')).code, 0);
  await output(ctx, 'realpath --relative-to=regular other', '../other\n');
});

test('logical and no-link collapse still require removed components to be directories unless missing mode applies', async () => {
  const ctx = fresh(); await seed(ctx, { regular: 'x' }); ctx.backend.symlink('alias', 'regular');
  for (const flag of ['-L', '-s']) {
    for (const path of ['regular/..', 'missing/..', 'alias/..']) {
      assert.notEqual((await ctx.run(`realpath ${flag} ${path}`)).code, 0, `${flag} ${path}`);
      assert.notEqual((await ctx.run(`realpath -e ${flag} ${path}`)).code, 0, `-e ${flag} ${path}`);
      await output(ctx, `realpath -m ${flag} ${path}`, '/\n');
    }
  }
});

test('canonical resolution refuses cycles and escaping targets without reading file content', async () => {
  const ctx = fresh(); await seed(ctx, { 'd/file': 'private bytes' });
  ctx.backend.symlink('one', 'two'); ctx.backend.symlink('two', 'one'); ctx.backend.symlink('d/escape', '../../outside');
  let reads = 0; const original = ctx.backend.readBinary.bind(ctx.backend);
  ctx.backend.readBinary = async (...args) => { reads++; return original(...args); };
  assert.equal((await ctx.run('realpath d/file')).code, 0);
  assert.notEqual((await ctx.run('realpath one')).code, 0);
  assert.notEqual((await ctx.run('realpath -m d/escape')).code, 0);
  assert.notEqual((await ctx.run('realpath ../outside')).code, 0);
  assert.equal((await ctx.run('realpath d/file/')).code, 0);
  assert.notEqual((await ctx.run('realpath -e d/file/')).code, 0);
  assert.equal(reads, 0);
});

test('new path commands preserve inherited control-character and encoded-traversal refusals', async () => {
  const ctx = fresh();
  for (const command of ["realpath -sm 'bad\nname'", 'realpath -m %2e%2e/outside', 'readlink %2e%2e/outside']) {
    assert.notEqual((await ctx.run(command)).code, 0, command);
  }
});

test('absolute symlink targets stay inside the virtual mount and lexical missing mode needs no metadata', async () => {
  const ctx = fresh(); await seed(ctx, { target: 'x' }); await ctx.fs.mkdir('d'); ctx.backend.symlink('d/link', '/target');
  await output(ctx, 'realpath d/link', '/target\n');
  let stats = 0; const original = ctx.backend.stat.bind(ctx.backend);
  ctx.backend.stat = async (...args) => { stats++; return original(...args); };
  const result = await ctx.run('realpath -sm missing/../new/file'); assert.equal(result.code, 0, result.output); assert.equal(result.output, '/new/file');
  assert.equal(stats, 0);
});

test('rmdir removes empty directories and parent chains without deleting a populated ancestor', async () => {
  const ctx = fresh(); await ctx.fs.mkdir('empty'); await ctx.fs.mkdir('a/b/c', { createParents: true });
  await seed(ctx, { 'keep/file': 'safe' }); await ctx.fs.mkdir('keep/child');
  assert.equal((await accept(ctx, 'rmdir empty')).code, 0); assert.equal((await ctx.fs.stat('empty')).ok, false);
  assert.equal((await accept(ctx, 'rmdir -p a/b/c')).code, 0); assert.equal((await ctx.fs.stat('a')).ok, false);
  assert.notEqual((await accept(ctx, 'rmdir -p keep/child')).code, 0);
  assert.equal((await ctx.fs.stat('keep/child')).ok, false); assert.equal(await ctx.read('keep/file'), 'safe');
  assert.equal((await accept(ctx, 'rmdir --ignore-fail-on-non-empty keep')).code, 0);
  assert.notEqual((await accept(ctx, 'rmdir keep/file')).code, 0);
  assert.notEqual((await accept(ctx, 'rmdir /')).code, 0);
});

test('unlink removes final ordinary and dangling links while preserving their targets', async () => {
  const ctx = fresh({ readOnlyPrefixes: ['protected'] }); await seed(ctx, { protected: Uint8Array.of(0, 255, 128) });
  ctx.backend.symlink('ordinary', 'protected'); ctx.backend.symlink('dangling', 'missing'); await ctx.fs.mkdir('empty');
  assert.equal((await accept(ctx, 'unlink ordinary')).code, 0); assert.equal(await ctx.backend.stat('ordinary'), null);
  assert.equal((await accept(ctx, 'unlink dangling')).code, 0); assert.equal(await ctx.backend.stat('dangling'), null);
  assert.deepEqual(await ctx.bytes('protected'), [0, 255, 128]);
  assert.notEqual((await accept(ctx, 'unlink empty')).code, 0); assert.equal((await ctx.fs.stat('empty')).ok, true);
  assert.equal((await ctx.run('unlink one two')).code, 2);
});

test('rmdir refuses a final symlink instead of removing its target directory', async () => {
  const ctx = fresh(); await ctx.fs.mkdir('empty'); ctx.backend.symlink('alias', 'empty');
  assert.notEqual((await accept(ctx, 'rmdir alias')).code, 0);
  assert.equal((await ctx.fs.stat('empty')).ok, true); assert.equal((await ctx.backend.stat('alias')).type, 'symlink');
});

test('typed deletion rechecks final objects after staging before performing effects', async () => {
  const ctx = fresh(); await seed(ctx, { victim: 'file' });
  const proposal = await ctx.run('unlink victim'); assert.ok(proposal.awaitingConfirm);
  await ctx.backend.delete('victim'); await ctx.backend.mkdir('victim');
  const changed = await ctx.run('y'); assert.notEqual(changed.code, 0); assert.equal((await ctx.backend.stat('victim')).type, 'dir');
  await ctx.fs.mkdir('dir'); const second = await ctx.run('rmdir dir'); assert.ok(second.awaitingConfirm);
  await ctx.backend.delete('dir'); await ctx.backend.write('dir', encode('replacement'));
  const replaced = await ctx.run('y'); assert.notEqual(replaced.code, 0); assert.equal(await ctx.read('dir'), 'replacement');
});

test('deletion grants and staged refusal preserve later operands and existing bytes', async () => {
  const ctx = fresh({ readOnlyPrefixes: ['protected'] }); await seed(ctx, { protected: 'keep', victim: 'keep too' });
  assert.notEqual((await accept(ctx, 'unlink protected')).code, 0); assert.equal(await ctx.read('protected'), 'keep');
  const proposal = await ctx.run('unlink victim'); assert.ok(proposal.awaitingConfirm);
  const refusal = await ctx.run('n'); assert.equal(refusal.code, 1); assert.equal(await ctx.read('victim'), 'keep too');
  const receipts = await ctx.opLog.read(); assert.ok(receipts.some((entry) => entry.command === 'fs.remove' && entry.status === 'EGRANT'));
});

test('mktemp creates exclusive files and explicit directories from supported templates', async () => {
  const ctx = fresh(); await ctx.fs.mkdir('tmp');
  const file = await accept(ctx, 'mktemp -p tmp sample.XXXXXX'); assert.equal(file.code, 0, file.output);
  const filePath = file.output.trim().replace(/^\//, ''); assert.match(filePath, /^tmp\/sample\.[A-Za-z0-9]{6}$/);
  assert.deepEqual(await ctx.bytes(filePath), []);
  const directory = await accept(ctx, 'mktemp -d -p tmp directory.XXXXXX'); assert.equal(directory.code, 0, directory.output);
  const dirPath = directory.output.trim().replace(/^\//, ''); assert.equal((await ctx.fs.stat(dirPath)).stat.type, 'dir');
  const suffix = await accept(ctx, 'mktemp -p tmp --suffix=.txt sample.XXXXXX'); assert.equal(suffix.code, 0, suffix.output);
  assert.match(suffix.output.trim(), /sample\.[A-Za-z0-9]{6}\.txt$/);
  const dry = await accept(ctx, 'mktemp -u -p tmp name.XXXXXX'); assert.equal(dry.code, 0, dry.output);
  assert.equal((await ctx.fs.stat(dry.output.trim())).ok, false);
  assert.equal((await ctx.run('export TMPDIR=tmp')).code, 0);
  const virtualDefault = await accept(ctx, 'mktemp'); assert.equal(virtualDefault.code, 0, virtualDefault.output);
  assert.match(virtualDefault.output.trim(), /^tmp\/tmp\.[A-Za-z0-9]{10}$/);
});

test('mktemp atomic creation survives a competing insertion without overwriting it', async () => {
  const ctx = fresh(); const original = ctx.backend.createExclusive.bind(ctx.backend); let collided = null, attempts = 0;
  ctx.backend.createExclusive = async (path, options) => {
    attempts++;
    if (collided === null) { collided = path; await ctx.backend.write(path, encode('concurrent owner')); }
    return original(path, options);
  };
  const result = await accept(ctx, 'mktemp race.XXXXXX'); assert.equal(result.code, 0, result.output);
  assert.ok(attempts >= 2); assert.notEqual(result.output.trim().replace(/^\//, ''), collided);
  assert.equal(await ctx.read(collided), 'concurrent owner');
  assert.deepEqual(await ctx.bytes(result.output.trim()), []);
});

test('mktemp collision exhaustion preserves an existing name through the governed create API', async () => {
  const ctx = fresh(); const commands = createMutationCommands(ctx.io, { randomBytes: async (count) => new Uint8Array(count) });
  const first = await commands.mktemp(['fixed.XXXXXX'], ''); assert.equal(first.code, 0);
  const path = new TextDecoder().decode(first.text).trim(); await ctx.fs.write(path, 'sentinel');
  const second = await commands.mktemp(['fixed.XXXXXX'], ''); assert.notEqual(second.code, 0);
  assert.equal(await ctx.read(path), 'sentinel');
});

test('mktemp rejects invalid templates and unavailable exclusive creation before mutation', async () => {
  const ctx = fresh(); let writes = 0; const original = ctx.backend.write.bind(ctx.backend);
  ctx.backend.write = async (...args) => { writes++; return original(...args); };
  assert.notEqual((await ctx.run('mktemp too-short.XX')).code, 0);
  assert.notEqual((await ctx.run('mktemp -p absent name.XXXXXX')).code, 0);
  ctx.backend.supportsExclusiveCreate = false;
  assert.notEqual((await ctx.run('mktemp name.XXXXXX')).code, 0);
  assert.equal(writes, 0);
});

test('truncate shrinks raw bytes and extends using zero bytes through real governed mutation', async () => {
  const ctx = fresh(); await seed(ctx, { input: Uint8Array.of(0, 255, 128, 65, 66) });
  assert.equal((await accept(ctx, 'truncate -s3 input')).code, 0); assert.deepEqual(await ctx.bytes('input'), [0, 255, 128]);
  assert.equal((await accept(ctx, 'truncate -s6 input')).code, 0); assert.deepEqual(await ctx.bytes('input'), [0, 255, 128, 0, 0, 0]);
  assert.equal((await accept(ctx, 'truncate -s0 input')).code, 0); assert.deepEqual(await ctx.bytes('input'), []);
  assert.equal((await accept(ctx, 'truncate -s2 created')).code, 0); assert.deepEqual(await ctx.bytes('created'), [0, 0]);
  assert.equal((await accept(ctx, 'truncate -c -s2 missing')).code, 0); assert.equal((await ctx.fs.stat('missing')).ok, false);
});

test('truncate applies relative, minimum, maximum, rounding, reference, and unit sizes', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'abcde', reference: 'xy' });
  for (const [size, expected] of [['+2', 7], ['-3', 4], ['<3', 3], ['>8', 8], ['/3', 6], ['%4', 8]]) {
    assert.equal((await accept(ctx, `truncate -s '${size}' input`)).code, 0, size); assert.equal((await ctx.bytes('input')).length, expected);
  }
  assert.equal((await accept(ctx, 'truncate -r reference input')).code, 0); assert.deepEqual(await ctx.bytes('input'), [97, 98]);
  assert.equal((await accept(ctx, 'truncate -s1K input')).code, 0); assert.equal((await ctx.bytes('input')).length, 1024);
  assert.equal((await accept(ctx, 'truncate -s1KB input')).code, 0); assert.equal((await ctx.bytes('input')).length, 1000);
});

test('truncate rejects malformed or oversized sizes and preserves files after refusal', async () => {
  const ctx = fresh({ stageWrites: true }); await seed(ctx, { input: Uint8Array.of(255, 128, 0) });
  for (const command of ['truncate -snope input', 'truncate -s1E input', 'truncate -s/0 input', 'truncate -o -s1 input']) {
    assert.equal((await accept(ctx, command)).code, 2, command); assert.deepEqual(await ctx.bytes('input'), [255, 128, 0]);
  }
  const proposal = await ctx.run('truncate -s1 input'); assert.ok(proposal.awaitingConfirm);
  assert.equal((await ctx.run('n')).code, 1); assert.deepEqual(await ctx.bytes('input'), [255, 128, 0]);
});

test('truncate rejects symlink ancestors and final links instead of changing a different object', async () => {
  const ctx = fresh(); await seed(ctx, { 'target/input': 'keep' });
  ctx.backend.symlink('alias', 'target'); ctx.backend.symlink('link', 'target/input');
  assert.notEqual((await accept(ctx, 'truncate -s0 alias/input')).code, 0);
  assert.notEqual((await accept(ctx, 'truncate -s0 link')).code, 0);
  assert.equal(await ctx.read('target/input'), 'keep');
});

test('truncate mutation budgets refuse oversized growth before replacing an existing entry', async () => {
  const ctx = fresh(); await seed(ctx, { input: Uint8Array.of(255, 128, 0) });
  const commands = createMutationCommands(ctx.io, { limits: { maxMutationBytes: 4 } });
  await assert.rejects(commands.truncate(['-s5', 'input']), /limit|size/i);
  assert.deepEqual(await ctx.bytes('input'), [255, 128, 0]);
});

test('new mutation capabilities refuse on unsupported Crate and overlay providers without base effects', async () => {
  const memory = new MemoryBackend(); await memory.write('input', Uint8Array.of(255, 128, 0));
  let reads = 0, writes = 0; const originalRead = memory.readBinary.bind(memory), originalWrite = memory.write.bind(memory);
  const host = {
    readBinary: async (...args) => { reads++; return originalRead(...args); },
    write: async (...args) => { writes++; return originalWrite(...args); },
    exists: memory.exists.bind(memory), list: memory.list.bind(memory), delete: memory.delete.bind(memory),
  };
  for (const backend of [new CrateBackend(host), new OverlayBackend(memory)]) {
    const ctx = fresh({ backend });
    assert.notEqual((await accept(ctx, 'mktemp tmp.XXXXXX')).code, 0);
    assert.notEqual((await accept(ctx, 'truncate -s1 input')).code, 0);
    assert.notEqual((await accept(ctx, 'unlink input')).code, 0);
  }
  assert.equal(reads, 0); assert.equal(writes, 0); assert.deepEqual(Array.from(await originalRead('input')), [255, 128, 0]);
});

test('FSA refuses exclusive creation and typed deletion before consulting potentially changing handles', async () => {
  let accesses = 0;
  const backend = new FsaBackend({
    async getDirectoryHandle() { accesses++; throw new Error('unexpected directory lookup'); },
    async getFileHandle() { accesses++; throw new Error('unexpected file lookup'); },
    async remove() { accesses++; throw new Error('unexpected untyped removal'); },
  });
  const ctx = fresh({ backend });
  for (const command of ['mktemp name.XXXXXX', 'rmdir dir', 'unlink file']) assert.notEqual((await accept(ctx, command)).code, 0, command);
  assert.equal(accesses, 0);
});

test('mktemp and truncate retain real staged acceptance, refusal, and destination grants', async () => {
  const ctx = fresh({ stageWrites: true, readOnlyPrefixes: ['protected'] }); await seed(ctx, { protected: 'keep', input: 'abc' });
  const temp = await ctx.run('mktemp refused.XXXXXX'); assert.ok(temp.awaitingConfirm);
  assert.equal((await ctx.run('n')).code, 1);
  const listed = await ctx.fs.list(''); assert.equal(listed.ok, true); assert.ok(!listed.entries.some((entry) => entry.name.startsWith('refused.')));
  const resized = await ctx.run('truncate -s1 input'); assert.ok(resized.awaitingConfirm);
  assert.deepEqual(await ctx.bytes('input'), [97, 98, 99]); assert.equal((await ctx.run('y')).code, 0); assert.deepEqual(await ctx.bytes('input'), [97]);
  assert.notEqual((await accept(ctx, 'truncate -s0 protected')).code, 0); assert.equal(await ctx.read('protected'), 'keep');
});

test('Stop cancels a pending mutation proposal and preserves an independent command', async () => {
  const ctx = fresh({ stageWrites: true }); await seed(ctx, { input: 'abc' });
  const pending = await ctx.run('truncate -s0 input; printf changed > later'); assert.ok(pending.awaitingConfirm);
  await ctx.shell.cancel(); assert.equal(ctx.shell.lastCode, 130); assert.equal(await ctx.read('input'), 'abc');
  assert.equal((await ctx.fs.stat('later')).ok, false);
  const next = await ctx.run('cmp input input'); assert.equal(next.code, 0);
});

test('Stop during a governed inspection read prevents subsequent shell mutations', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'readable' });
  const original = ctx.backend.readBinary.bind(ctx.backend); let stopped = false;
  ctx.backend.readBinary = async (path, options) => {
    if (path === 'input' && !stopped) { stopped = true; void ctx.shell.cancel(); }
    return original(path, options);
  };
  const result = await ctx.run('strings input; printf changed > later'); assert.equal(result.code, 130);
  assert.equal((await ctx.fs.stat('later')).ok, false); assert.equal((await ctx.run('cmp input input')).code, 0);
});

test('large metadata traversals yield to Stop before a later mutation', async () => {
  const ctx = fresh();
  for (let index = 0; index < 2048; index++) await ctx.backend.write(`d/f${String(index).padStart(4, '0')}`, Uint8Array.of(120));
  const pending = ctx.run('tree --noreport d; printf changed > later');
  const timer = setTimeout(() => { void ctx.shell.cancel(); }, 0);
  try { assert.equal((await pending).code, 130); } finally { clearTimeout(timer); }
  assert.equal((await ctx.fs.stat('later')).ok, false); assert.equal((await ctx.run('realpath -sm fresh')).code, 0);
});

test('unknown flags refuse without creating or replacing mutation destinations', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'keep' });
  for (const name of names) assert.equal((await ctx.run(`${name} --definitely-unsupported input`)).code, 2, name);
  assert.equal(await ctx.read('input'), 'keep');
});

test('literal readlink needs only its own grant while canonical paths recheck the target grant', async () => {
  const ctx = fresh({ prefixes: ['allowed'] }); await seed(ctx, { protected: 'NEVER-REVEAL-TARGET' });
  await ctx.fs.mkdir('allowed'); ctx.backend.symlink('allowed/link', '../protected');
  const literal = await ctx.run('readlink allowed/link'); assert.equal(literal.code, 0, literal.output); assert.equal(literal.output, '../protected');
  const canonical = await ctx.run('realpath allowed/link'); assert.notEqual(canonical.code, 0); assert.doesNotMatch(canonical.output, /NEVER-REVEAL-TARGET/);
});

test('du reports virtual apparent file bytes and zero directory overhead', async () => {
  const ctx = fresh(); await seed(ctx, { 'd/a': Uint8Array.of(255, 0, 128), 'd/sub/b': 'xy' });
  assert.equal((await ctx.fs.mkdir('d/empty')).ok, true);
  await output(ctx, 'du -b -s d', '5\td\n');
  await output(ctx, 'du -k -s d', '1\td\n');
  await output(ctx, 'du -m -s d', '1\td\n');
  await output(ctx, 'du -b -s d/empty', '0\td/empty\n');
  await output(ctx, 'du -b -s -c d/a d/sub/b', '3\td/a\n2\td/sub/b\n5\ttotal\n');
  await output(ctx, 'du -b -s -0 d', '5\td\0');
});

test('du traverses each operand independently and bounds directory output depth', async () => {
  const ctx = fresh(); await seed(ctx, { 'd/a': 'abc', 'd/sub/b': 'xy' });
  await output(ctx, 'du -b -s d d', '5\td\n5\td\n');
  await output(ctx, 'du -b -d0 d', '5\td\n');
  await output(ctx, 'du -b --max-depth=1 d', '2\td/sub\n5\td\n');
  await output(ctx, 'du -b -a d', '3\td/a\n2\td/sub/b\n2\td/sub\n5\td\n');
});

test('du refuses unknown byte sizes and never follows a symbolic link for aggregation', async () => {
  const ctx = fresh(); await seed(ctx, { 'd/a': 'abc', protected: 'do not count this' });
  ctx.backend.symlink('d/link', '../protected');
  await output(ctx, 'du -b -s d', '3\td\n');
  const original = ctx.backend.stat.bind(ctx.backend);
  ctx.backend.stat = async (path, options) => { const stat = await original(path, options); return path === 'd/a' && stat ? { type: stat.type } : stat; };
  assert.notEqual((await ctx.run('du -b -s d')).code, 0);
  assert.equal((await ctx.run('du -L d')).code, 2);
});

test('tree lists explicit empty directories and deterministic hidden and depth selections', async () => {
  const ctx = fresh(); await seed(ctx, { 'd/a': 'a', 'd/.hidden': 'h', 'd/sub/b': 'b' });
  assert.equal((await ctx.fs.mkdir('d/empty')).ok, true);
  await output(ctx, 'tree -i -f --noreport d', 'd\nd/a\nd/empty\nd/sub\nd/sub/b\n');
  await output(ctx, 'tree -a -i -f --noreport d', 'd\nd/.hidden\nd/a\nd/empty\nd/sub\nd/sub/b\n');
  await output(ctx, 'tree -d -i -f --noreport d', 'd\nd/empty\nd/sub\n');
  await output(ctx, 'tree -L1 -i -f --noreport d', 'd\nd/a\nd/empty\nd/sub\n');
  await output(ctx, 'tree --charset=ascii --noreport d/empty', 'd/empty\n');
});

test('tree shows final links without visiting their targets or following cycles', async () => {
  const ctx = fresh(); await seed(ctx, { protected: 'private' }); await ctx.fs.mkdir('d');
  ctx.backend.symlink('d/outside', '../protected'); ctx.backend.symlink('d/cycle', '.');
  await output(ctx, 'tree -i -f --noreport d', 'd\nd/cycle -> .\nd/outside -> ../protected\n');
  assert.equal((await ctx.run('tree -l d')).code, 2);
});

test('du and tree obtain traversal metadata without reading file content', async () => {
  const ctx = fresh(); await seed(ctx, { 'd/a': 'abc', 'd/sub/b': 'de' });
  let reads = 0; const original = ctx.backend.readBinary.bind(ctx.backend);
  ctx.backend.readBinary = async (...args) => { reads++; return original(...args); };
  assert.equal((await ctx.run('du -b -s d')).code, 0);
  assert.equal((await ctx.run('tree -i --noreport d')).code, 0);
  assert.equal(reads, 0);
});

test('strings scans binary bytes and preserves final printable runs without UTF-8 replacement', async () => {
  const ctx = fresh(); await seed(ctx, { input: Uint8Array.of(0, 65, 66, 67, 68, 9, 90, 0, 120, 121, 0, 255, 128, 97, 98, 99, 100) });
  await output(ctx, 'strings input', 'ABCD\tZ\nabcd\n');
  await output(ctx, 'strings -n2 input', 'ABCD\tZ\nxy\nabcd\n');
  await output(ctx, 'strings -eS input', [65, 66, 67, 68, 9, 90, 10, 255, 128, 97, 98, 99, 100, 10]);
  await output(ctx, 'strings -n7 input', '');
});

test('strings reports original byte offsets and honors separators and whitespace selection', async () => {
  const ctx = fresh(); await seed(ctx, { input: '\0abcd\0\0\0\0\0efgh', multiline: 'ab\ncd\0' });
  await output(ctx, 'strings -td input', '      1 abcd\n     10 efgh\n');
  await output(ctx, 'strings -tx input', '      1 abcd\n      a efgh\n');
  await output(ctx, 'strings -o input', '      1 abcd\n     12 efgh\n');
  await output(ctx, 'strings -f -s: input', 'input: abcd:input: efgh:');
  await output(ctx, 'strings -w multiline', 'ab\ncd\n');
  assert.equal((await ctx.run('strings -n0 input')).code, 2);
  assert.equal((await ctx.run('strings -el input')).code, 2);
});

test('strings concatenates separate files and consumes repeated stdin once', async () => {
  const ctx = fresh(); await seed(ctx, { one: 'first\0', two: 'second\0', input: 'shared\0' });
  await output(ctx, 'strings one two', 'first\nsecond\n');
  await output(ctx, 'cat input | strings - -', 'shared\n');
});

test('cmp preserves equal and differing exit statuses for arbitrary bytes', async () => {
  const ctx = fresh(); await seed(ctx, { a: Uint8Array.of(0, 255, 10, 128), equal: Uint8Array.of(0, 255, 10, 128), changed: Uint8Array.of(0, 255, 10, 129), prefix: Uint8Array.of(0, 255) });
  const same = await ctx.run('cmp a equal'); assert.equal(same.code, 0); assert.equal(same.output, '');
  const different = await ctx.run('cmp a changed'); assert.equal(different.code, 1); assert.equal(different.output, 'a changed differ: char 4, line 2');
  assert.equal((await ctx.run('cmp a prefix')).code, 1);
  const silent = await ctx.run('cmp -s a changed'); assert.equal(silent.code, 1); assert.equal(silent.output, '');
  assert.equal((await ctx.run('cmp missing a')).code, 2);
  assert.equal((await ctx.run('cmp -s missing a')).code, 2);
});

test('cmp lists differing bytes using decimal positions and octal values', async () => {
  const ctx = fresh(); await seed(ctx, { left: Uint8Array.of(65, 255, 10, 0), right: Uint8Array.of(66, 128, 10, 1) });
  const result = await ctx.run('cmp -l left right > captured'); assert.equal(result.code, 1);
  const rows = (await ctx.read('captured')).trim().split('\n').map((line) => line.trim().split(/\s+/));
  assert.deepEqual(rows, [['1', '101', '102'], ['2', '377', '200'], ['4', '0', '1']]);
});

test('cmp applies independent skip counts and byte limits before comparison', async () => {
  const ctx = fresh(); await seed(ctx, { one: 'xxABCD', two: 'yABCE', input: 'ABCD' });
  assert.equal((await ctx.run('cmp -i2:1 -n3 one two')).code, 0);
  assert.equal((await ctx.run('cmp one two 2 1')).code, 1);
  assert.equal((await ctx.run('cmp -n0 one two')).code, 0);
  assert.equal((await ctx.run('cat input | cmp -i2:0 one')).code, 0);
  assert.equal((await ctx.run('cmp -n-1 one two')).code, 2);
  assert.equal((await ctx.run('cmp -i invalid one two')).code, 2);
});

test('cmp refuses repeated stdin without opening an ordinary input', async () => {
  const ctx = fresh(); let reads = 0;
  const original = ctx.backend.readBinary.bind(ctx.backend);
  ctx.backend.readBinary = async (...args) => { reads++; return original(...args); };
  const result = await ctx.run("printf 'data' | cmp - -"); assert.equal(result.code, 2);
  assert.match(result.output, /stdin|standard input/); assert.doesNotMatch(result.output, /limit exceeded/);
  assert.equal(reads, 0);
});

test('file reports finite signature classifications and honest MIME encodings', async () => {
  const ctx = fresh(); await seed(ctx, {
    empty: '', ascii: 'plain text\n', utf8: 'café\n', binary: Uint8Array.of(0, 255, 128),
    png: Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), pdf: '%PDF-1.7\n',
    zip: Uint8Array.of(80, 75, 3, 4, 0, 0), elf: Uint8Array.of(127, 69, 76, 70, 2, 1, 1),
  });
  for (const [path, label] of [['empty', 'empty'], ['ascii', 'ASCII text'], ['utf8', 'Unicode text, UTF-8 text'],
    ['binary', 'data'], ['png', 'PNG image data'], ['pdf', 'PDF document'], ['zip', 'Zip archive data'], ['elf', 'ELF data']]) {
    await output(ctx, `file -b ${path}`, label + '\n');
  }
  await output(ctx, 'file -bi ascii', 'text/plain; charset=us-ascii\n');
  await output(ctx, 'file -bi utf8', 'text/plain; charset=utf-8\n');
  await output(ctx, 'file -bi binary', 'application/octet-stream; charset=binary\n');
  await output(ctx, 'file -b --mime-type png', 'image/png\n');
  await output(ctx, 'file -b --mime-encoding png', 'binary\n');
});

test('file reads governed filename lists and does not classify a partial signature as a complete image', async () => {
  const ctx = fresh(); await seed(ctx, { ascii: 'text\n', empty: '', names: 'ascii\nempty\n', partial: Uint8Array.of(137, 80, 78) });
  await output(ctx, 'file -b -f names', 'ASCII text\nempty\n');
  await output(ctx, 'file -b partial', 'data\n');
  assert.notEqual((await ctx.run('file missing')).code, 0);
});

test('small inspection budgets stop record and output growth with modest input', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'abcd\0efgh\0ijkl\0', 'd/a': 'a', 'd/b': 'b' });
  const commands = createInspectionCommands(ctx.io, { limits: { maxOutputBytes: 3, maxEntries: 1 } });
  await assert.rejects(commands.strings(['input'], ''), /limit|budget/i);
  await assert.rejects(commands.tree(['d'], ''), /limit|budget/i);
  await assert.rejects(commands.du(['-b', 'd'], ''), /limit|budget/i);
});

test('inspection reads respect grants without exposing denied file content', async () => {
  const ctx = fresh({ prefixes: ['allowed'] }); await seed(ctx, { secret: 'NEVER-REVEAL-SECRET', 'allowed/a': 'public' });
  for (const command of ['du -b secret', 'tree secret', 'file secret', 'strings secret', 'cmp secret allowed/a']) {
    const result = await ctx.run(command); assert.notEqual(result.code, 0, command); assert.doesNotMatch(result.output, /NEVER-REVEAL-SECRET/);
  }
});

test('inspection commands recheck target grants across final and intermediate symbolic links', async () => {
  const ctx = fresh({ prefixes: ['allowed'] }); await seed(ctx, {
    'protected/secret': 'NEVER-REVEAL-LINK-TARGET', 'allowed/reference': 'public',
  });
  ctx.backend.symlink('allowed/link', '../protected/secret'); ctx.backend.symlink('allowed/dir', '../protected');
  let reads = 0; const original = ctx.backend.readBinary.bind(ctx.backend);
  ctx.backend.readBinary = async (path, options) => { if (path.startsWith('protected/')) reads++; return original(path, options); };
  for (const command of ['file -L allowed/link', 'strings allowed/link', 'cmp allowed/link allowed/reference',
    'du -b allowed/dir/secret', 'tree allowed/dir/secret']) {
    const result = await ctx.run(command); assert.notEqual(result.code, 0, command); assert.doesNotMatch(result.output, /NEVER-REVEAL-LINK-TARGET/);
  }
  assert.equal(reads, 0);
});

test('canonical content reads refuse final-link replacement after grant checks without reading denied bytes', async () => {
  for (const command of ['strings allowed/input', 'file -L allowed/input', 'cmp allowed/input allowed/reference']) {
    let replaced = false;
    const ctx = fresh({ prefixes: ['allowed'], beforeOperation: async (name, input, { backend }) => {
      if (name === 'fs.read' && input.path === 'allowed/input' && !replaced) {
        replaced = true; await backend.delete('allowed/input'); backend.symlink('allowed/input', '../protected/secret');
      }
    } });
    await seed(ctx, { 'allowed/input': 'public', 'allowed/reference': 'public', 'protected/secret': 'NEVER-REVEAL-RACE-CONTENT' });
    let protectedReads = 0; const original = ctx.backend.readBinary.bind(ctx.backend);
    ctx.backend.readBinary = async (path, options) => { if (path.startsWith('protected/')) protectedReads++; return original(path, options); };
    const result = await ctx.run(command); assert.equal(replaced, true, command); assert.notEqual(result.code, 0, command);
    assert.doesNotMatch(result.output, /NEVER-REVEAL-RACE-CONTENT/); assert.equal(protectedReads, 0, command);
  }
});

test('canonical directory listings refuse replacement links without enumerating denied children', async () => {
  for (const command of ['tree --noreport allowed/dir', 'du -b allowed/dir']) {
    let replaced = false;
    const ctx = fresh({ prefixes: ['allowed'], beforeOperation: async (name, input, { backend }) => {
      if (name === 'fs.list' && input.path === 'allowed/dir' && !replaced) {
        replaced = true; await backend.delete('allowed/dir'); backend.symlink('allowed/dir', '../protected');
      }
    } });
    await ctx.fs.mkdir('allowed/dir', { createParents: true }); await seed(ctx, { 'protected/NEVER-REVEAL-RACE-NAME': 'private' });
    let protectedLists = 0, protectedStats = 0;
    const originalList = ctx.backend.list.bind(ctx.backend), originalStat = ctx.backend.stat.bind(ctx.backend);
    ctx.backend.list = async (path, options) => { if (path === 'protected' || path.startsWith('protected/')) protectedLists++; return originalList(path, options); };
    ctx.backend.stat = async (path, options) => { if (path === 'protected' || path.startsWith('protected/')) protectedStats++; return originalStat(path, options); };
    const result = await ctx.run(command); assert.equal(replaced, true, command); assert.notEqual(result.code, 0, command);
    assert.doesNotMatch(result.output, /NEVER-REVEAL-RACE-NAME/); assert.equal(protectedLists, 0); assert.equal(protectedStats, 0);
  }
});

test('canonical metadata probes refuse an ancestor that becomes a link between component checks', async () => {
  let replaced = false;
  const ctx = fresh({ prefixes: ['allowed'], beforeOperation: async (name, input, { backend }) => {
    if (name === 'fs.stat' && input.path === 'allowed/dir/child' && !replaced) {
      replaced = true; await backend.delete('allowed/dir'); backend.symlink('allowed/dir', '../protected');
    }
  } });
  await seed(ctx, { 'allowed/dir/child': 'public', 'protected/child': 'NEVER-REVEAL-RACE-METADATA' });
  let protectedStats = 0; const original = ctx.backend.stat.bind(ctx.backend);
  ctx.backend.stat = async (path, options) => { if (path === 'protected' || path.startsWith('protected/')) protectedStats++; return original(path, options); };
  const result = await ctx.run('realpath -e allowed/dir/child'); assert.equal(replaced, true); assert.notEqual(result.code, 0);
  assert.equal(protectedStats, 0); assert.doesNotMatch(result.output, /NEVER-REVEAL-RACE-METADATA/);
});

test('canonical component limits include the retained prefix plus a relative link target', async () => {
  const ctx = fresh(); await ctx.fs.mkdir('a/b', { createParents: true }); ctx.backend.symlink('a/b/link', 'c/d/e/f/g');
  const commands = createPathCommands(ctx.io, { limits: { maxPathComponents: 6 } });
  await assert.rejects(commands.readlink(['-m', 'a/b/link']), /component|limit/i);
});

test('truncate cannot modify a denied target through an allowed symbolic-link spelling', async () => {
  const ctx = fresh({ readOnlyPrefixes: ['protected'] }); await seed(ctx, { 'protected/secret': Uint8Array.of(255, 128, 0) });
  await ctx.fs.mkdir('allowed'); ctx.backend.symlink('allowed/link', '../protected/secret');
  assert.notEqual((await accept(ctx, 'truncate -s0 allowed/link')).code, 0);
  assert.deepEqual(await ctx.bytes('protected/secret'), [255, 128, 0]);
});

test('bounded inspection reads reject oversized metadata before backend content loads', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'short', other: 'short' });
  const originalStat = ctx.backend.stat.bind(ctx.backend), originalRead = ctx.backend.readBinary.bind(ctx.backend); let reads = 0;
  ctx.backend.stat = async (path, options) => { const stat = await originalStat(path, options); return path === 'input' && stat ? { ...stat, size: 65 * 1024 * 1024 } : stat; };
  ctx.backend.readBinary = async (...args) => { reads++; return originalRead(...args); };
  for (const command of ['file input', 'strings input', 'cmp input other']) assert.notEqual((await ctx.run(command)).code, 0, command);
  assert.equal(reads, 0);
});

test('metadata capability refusal precedes providers that obtain stat by loading content', async () => {
  const ctx = fresh(); await seed(ctx, { input: 'data' }); let stats = 0, reads = 0;
  ctx.backend.supportsMetadataOnly = false;
  const originalStat = ctx.backend.stat.bind(ctx.backend), originalRead = ctx.backend.readBinary.bind(ctx.backend);
  ctx.backend.stat = async (...args) => { stats++; return originalStat(...args); };
  ctx.backend.readBinary = async (...args) => { reads++; return originalRead(...args); };
  for (const command of ['du input', 'tree input']) assert.notEqual((await ctx.run(command)).code, 0, command);
  assert.equal(stats, 0); assert.equal(reads, 0);
});

test('unsupported link creation refuses without copying data or replacing existing entries', async () => {
  const ctx = fresh(); await seed(ctx, { source: 'source bytes', dest: 'keep' });
  for (const command of ['ln source new', 'ln -s source new', 'link source new', 'ln -f source dest']) {
    const result = await ctx.run(command); assert.equal(result.code, 2, command); assert.match(result.output, /support|capability/i);
  }
  assert.equal((await ctx.fs.stat('new')).ok, false); assert.equal(await ctx.read('dest'), 'keep'); assert.equal(await ctx.read('source'), 'source bytes');
});
