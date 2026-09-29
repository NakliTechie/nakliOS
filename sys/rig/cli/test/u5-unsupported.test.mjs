// Independent B11/U5 verifier. Drafted from unix-B11-interface.md before release.
// This file is inert while it remains in plan/. Copy unchanged into cli/test only
// after the parent releases permanent wiring, then await complete-build execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createShell } from '../shell.mjs';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { buildRigRegistry, createRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';

// Independent expectations: never import the implementation's unsupported table.
// Each row describes the capability that the real utility would need.
const EXPECTED = [
  ['curl', 'governed egress policy', [/governed/i, /egress/i, /policy/i]],
  ['wget', 'governed egress policy', [/governed/i, /egress/i, /policy/i]],
  ['ssh', 'governed egress policy', [/governed/i, /egress/i, /policy/i]],
  ['chown', 'POSIX ownership', [/owner|uid/i]],
  ['chgrp', 'POSIX group ownership', [/group|gid/i, /owner|permission|POSIX/i]],
  ['mount', 'host mounts', [/mount/i]],
  ['findmnt', 'host mount table', [/mount/i]],
  ['df', 'filesystem capacity', [/capacity|free.space|disk.space|filesystem.usage|storage.usage/i]],
  ['mknod', 'device nodes', [/device/i]],
  ['mkfifo', 'named pipes', [/named.pipe|FIFO/i]],
  ['kill', 'host process signals', [/process|signal/i]],
  ['nice', 'process scheduling priority', [/schedul|priority|niceness/i]],
  ['nohup', 'detached processes and signal handling', [/process|signal|detach/i]],
  ['su', 'user identity switching', [/user|identity|privilege/i]],
  ['runas', 'user identity switching', [/user|identity|privilege/i]],
  ['stdbuf', 'native process stream buffering', [/buffer|stdio/i]],
  ['shred', 'secure storage erasure', [/secure|physical/i, /eras|delet|overwrit/i]],
  ['dd', 'raw device and block I/O', [/raw|block|device/i]],
  ['getent', 'host account and name-service databases', [/account|user|identity|NSS|name.service/i]],
  ['hostname', 'host network identity', [/host|network/i, /identity|name/i]],
  ['logname', 'login sessions', [/login|session/i]],
  ['dircolors', 'terminal color database', [/colo[u]?r|LS_COLORS/i]],
  ['pathchk', 'host filesystem naming limits', [/path|file.?name/i, /limit|rule|valid|portab/i]],
  ['getfacl', 'POSIX access control lists', [/ACL|access.control.list/i]],
  ['setfacl', 'POSIX access control lists', [/ACL|access.control.list/i]],
  ['chacl', 'POSIX access control lists', [/ACL|access.control.list/i]],
  ['attr', 'filesystem extended attributes', [/extended.attribute|xattr/i]],
  ['getfattr', 'filesystem extended attributes', [/extended.attribute|xattr/i]],
  ['setfattr', 'filesystem extended attributes', [/extended.attribute|xattr/i]],
  ['xfs_io', 'XFS-specific filesystem I/O', [/XFS/i]],
  ['chcon', 'SELinux security contexts', [/SELinux|security.context/i]],
  ['runcon', 'SELinux process security contexts', [/SELinux|security.context/i]],
  ['chroot', 'process filesystem root isolation', [/root|jail/i, /process|isolat|namespace/i]],
  ['groups', 'host group membership database', [/group/i]],
  ['hostid', 'host identity', [/host/i, /identity|identifier|\bID\b/i]],
  ['install', 'installation ownership and permission semantics', [/owner|permission|mode/i]],
  ['pinky', 'host user login database', [/user|login|session/i]],
  ['who', 'host login sessions', [/login|session/i]],
  ['users', 'host login sessions', [/login|session/i]],
  ['uptime', 'host uptime or load metrics', [/uptime|boot|load|host.clock/i]],
  ['stty', 'terminal device control', [/terminal|TTY/i]],
  ['sync', 'storage flush and durability', [/flush|durab|sync.*storage/i]],
  ['tty', 'terminal device identity', [/terminal|TTY/i]],
];
const names = EXPECTED.map(([name]) => name);
const bytes = (value) => Array.from(typeof value === 'string' ? new TextEncoder().encode(value) : value);
const text = (value) => typeof value === 'string' ? value : new TextDecoder().decode(value);
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const binary = Uint8Array.of(0, 255, 128, 13, 10, 27, 65, 0);
const secret = 'U5_PRIVATE_OPERAND_5e28e09c';
const literal = `$(touch intruder); node -e bad | python -c bad ${secret}`;

function backendSnapshot(backend) {
  return {
    files: [...backend.files].map(([path, value]) => [path, { bytes: [...value.bytes], mtimeMs: value.mtimeMs }]),
    dirs: [...backend.dirs], symlinks: [...backend.symlinks].map(([path, value]) => [path, { ...value }]),
  };
}

async function fresh({ scopes = ['fs:read', 'fs:write', 'fs:remove'], prefixes = [''], stageWrites = false } = {}) {
  const effects = [], backend = new MemoryBackend(), logBackend = new MemoryBackend();
  let armed = false, commandBoundary = null;
  const record = (kind, method, args = []) => { if (armed) effects.push([kind, method, ...args]); };
  function observe(target, kind, select = () => true) {
    return new Proxy(target, { get(object, key) {
      const value = Reflect.get(object, key);
      return typeof value === 'function' && select(key) ? (...args) => {
        record(kind, String(key), args); return Reflect.apply(value, object, args);
      } : value;
    } });
  }
  const fs = observe(createFileops({ backend: observe(backend, 'backend') }), 'fileops');
  assert.equal((await fs.write('existing', binary)).ok, true);
  assert.equal((await fs.write('private/input', secret, { createParents: true })).ok, true);
  assert.equal((await fs.mkdir('empty')).ok, true);
  backend.symlink('alias', 'existing');
  const base = buildRigRegistry({ fs });
  const registry = observe(createRegistry(base.commands.map((command) => ({ ...command,
    ...(stageWrites && command.name === 'fs.write' ? { destructive: true } : {}),
    run: (...args) => { record('registry-run', command.name); return command.run(...args); },
  }))), 'registry', (key) => key === 'invokeCommand');
  const rawGrant = createGrant({ scopes, prefixes });
  const grant = observe(rawGrant, 'grant');
  const opLog = observe(createOpLog({ fs: createFileops({ backend: observe(logBackend, 'oplog-backend') }) }), 'oplog');
  const rawFace = createAgentFace({ registry, grant, opLog, actor: 'u5-independent-verifier' });
  const face = observe(rawFace, 'face', (key) => ['invoke', 'check', 'accept', 'reject'].includes(key));
  const forbidden = (kind) => (...args) => {
    record('runtime', kind, args); throw new Error(`U5 unexpected ${kind}`);
  };
  const shell = createShell({ registry, face,
    kiln: { exec: forbidden('python.exec'), run: forbidden('python.run'),
      reset: forbidden('python.reset'), fs: new Proxy({}, { get: (_, key) => forbidden(`python.fs.${String(key)}`) }) },
    js: { makeModuleURL: forbidden('js.makeModuleURL'), spawn: forbidden('js.spawn'), revoke: forbidden('js.revoke') },
    beforeCommand(argv) { commandBoundary?.(argv); },
  });
  const snapshot = () => ({ filesystem: backendSnapshot(backend), audit: backendSnapshot(logBackend),
    grant: rawGrant.describe(), pending: rawFace.pendingProposals(), cwd: shell.cwd });
  let baseline;
  function begin() { effects.length = 0; baseline = snapshot(); armed = true; }
  function unchanged(label = 'plain refusal') {
    assert.deepEqual(effects, [], `${label}: no fileops, backend, registry, grant, audit, face or runtime operations`);
    assert.deepEqual(snapshot(), baseline, `${label}: storage, grant, proposals and cwd remain unchanged`);
    assert.equal(shell.awaitingConfirm, null, `${label}: no confirmation`);
  }
  function hostGuards() {
    const restores = [];
    function trap(object, key, kind) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor && !descriptor.configurable && !descriptor.writable) return;
      Object.defineProperty(object, key, { configurable: true, writable: true, value: function (...args) {
        record('host', kind, args); throw new Error(`U5 unexpected ${kind}`);
      } });
      restores.push(() => descriptor ? Object.defineProperty(object, key, descriptor) : Reflect.deleteProperty(object, key));
    }
    for (const key of ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'Worker', 'SharedWorker', 'WebTransport']) trap(globalThis, key, key);
    if (globalThis.navigator) trap(globalThis.navigator, 'sendBeacon', 'navigator.sendBeacon');
    for (const key of ['kill', 'chdir', 'setuid', 'setgid', 'seteuid', 'setegid', 'setgroups', 'initgroups']) {
      if (typeof process[key] === 'function') trap(process, key, `process.${key}`);
    }
    for (const key of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) trap(childProcess, key, `child_process.${key}`);
    return () => { for (const restore of restores.reverse()) restore(); };
  }
  const run = async (command) => {
    const restore = hostGuards();
    try { return { ...await shell.feed(command), code: shell.lastCode }; }
    finally { restore(); }
  };
  begin();
  return { shell, fs, backend, rawGrant, rawFace, effects, run, begin, unchanged, snapshot,
    atCommand(fn) { commandBoundary = fn; } };
}

function refusal(result, [name, capability, patterns]) {
  assert.ok(Number.isInteger(result.code) && result.code > 0 && result.code <= 255, `${name}: nonzero shell status`);
  assert.notEqual(result.code, 127, `${name}: recognized refusal, not an unknown command`);
  assert.deepEqual(bytes(result.stdout), [], `${name}: stdout stays empty`);
  const diagnostic = text(result.stderr);
  assert.ok(diagnostic.startsWith(`${name}: `), `${name}: diagnostic names the command`);
  assert.match(diagnostic, /^[^\r\n]+\n$/, `${name}: exactly one diagnostic line`);
  assert.match(diagnostic, /unavailable|unsupported|not.supported|not.available|cannot|requires|missing/i, `${name}: explicit refusal`);
  const reason = diagnostic.slice(name.length + 2);
  for (const pattern of patterns) assert.match(reason, pattern, `${name}: missing ${capability}`);
  assert.doesNotMatch(reason, /command not found|TypeError|ReferenceError|SyntaxError|unexpected/i);
  assert.equal(diagnostic.includes(secret), false, `${name}: operand stays private`);
  assert.equal(result.output.includes(secret), false, `${name}: rendered operand stays private`);
  assert.ok(!result.awaitingConfirm, `${name}: no proposal`);
  return { code: result.code, stderr: diagnostic };
}

function sameRefusal(result, expected, row) {
  refusal(result, row);
  assert.equal(result.code, expected.code, `${row[0]}: flags and input do not alter refusal status`);
  assert.deepEqual(bytes(result.stderr), bytes(expected.stderr), `${row[0]}: flags and input do not alter diagnostic bytes`);
}

test('U5 independently enumerates all 43 locked refusals', () => {
  assert.equal(EXPECTED.length, 43); assert.equal(new Set(names).size, 43);
});

for (const row of EXPECTED) test(`U5 ${row[0]}: capability refusal, flags, private operands and no effects`, async () => {
  const [name] = row, ctx = await fresh();
  const expected = refusal(await ctx.run(name), row); ctx.unchanged(name);
  for (const suffix of ['--help', '--version', '-h', `-- ${quote(secret)} ${quote(literal)} existing alias empty`,
    `${quote(`https://user:${secret}@example.invalid/private?token=${secret}`)} ${quote(`--token=${secret}`)}`,
    `${quote('../private/input')} ${quote('/etc/passwd')} ${quote('*')} ${quote('[')}`]) {
    sameRefusal(await ctx.run(`${name} ${suffix}`), expected, row); ctx.unchanged(`${name} ${suffix}`);
  }
});

for (const row of EXPECTED) test(`U5 ${row[0]}: binary stdin refusal has no command effects`, async () => {
  const [name] = row, ctx = await fresh();
  const expected = refusal(await ctx.run(name), row); ctx.unchanged();
  // cat completes its governed source read before this public command boundary.
  // Reset here to distinguish those permitted upstream reads from handler effects.
  let reached = 0;
  ctx.atCommand((argv) => { if (argv[0] === name) { reached++; ctx.begin(); } });
  sameRefusal(await ctx.run(`cat existing | ${name} ${quote(secret)}`), expected, row);
  assert.equal(reached, 1); ctx.unchanged(`${name}: after binary producer`);
});

test('U5 plain refusals require no granted scopes or active grant', async () => {
  const ctx = await fresh({ scopes: [], prefixes: [] });
  for (const row of EXPECTED) { refusal(await ctx.run(`${row[0]} existing`), row); ctx.unchanged(); }
  ctx.rawGrant.revoke(); ctx.begin();
  for (const row of EXPECTED) { refusal(await ctx.run(row[0]), row); ctx.unchanged(); }
});

test('U5 help, which and type discover every refusal truthfully without effects', async () => {
  const ctx = await fresh(), help = await ctx.run('help');
  assert.equal(help.code, 0); assert.deepEqual(bytes(help.stderr), []);
  const helpText = text(help.stdout), firstLine = helpText.split('\n')[0];
  const refusalLines = helpText.split('\n').filter((line) => /refus|unsupported|unavailable/i.test(line));
  for (const [name] of EXPECTED) {
    assert.ok(ctx.shell.commands.includes(name), `${name}: public discovery`);
    assert.match(firstLine, new RegExp(`(?:^|\\s)${name}(?:\\s|$)`), `${name}: help command list`);
    assert.ok(refusalLines.some((line) => new RegExp(`\\b${name}\\b`).test(line)), `${name}: help labels the refusal`);
    for (const prefix of ['which', 'which -a']) {
      const result = await ctx.run(`${prefix} ${name}`); assert.equal(result.code, 0);
      assert.deepEqual(bytes(result.stdout), bytes(`${name}\n`)); assert.deepEqual(bytes(result.stderr), []);
    }
    const result = await ctx.run(`type ${name}`); assert.equal(result.code, 0);
    assert.deepEqual(bytes(result.stderr), []); assert.match(text(result.stdout), new RegExp(`\\b${name}\\b`));
    assert.match(text(result.stdout), /refus|unsupported|unavailable/i, `${name}: type cannot advertise a working implementation`);
  }
  const all = await ctx.run(`which ${names.join(' ')}`); assert.equal(all.code, 0);
  assert.deepEqual(bytes(all.stdout), bytes(names.join('\n') + '\n')); assert.deepEqual(bytes(all.stderr), []);
  ctx.unchanged('discovery');
});

test('U5 unknown names retain127 while ordinary supported commands retain their output', async () => {
  const ctx = await fresh(), unknown = 'u5-command-that-does-not-exist';
  const result = await ctx.run(unknown); assert.equal(result.code, 127);
  assert.deepEqual(bytes(result.stdout), []); assert.deepEqual(bytes(result.stderr), bytes(`${unknown}: command not found\n`));
  for (const prefix of ['type', 'which']) {
    const result = await ctx.run(`${prefix} ${unknown}`); assert.notEqual(result.code, 0);
    assert.deepEqual(bytes(result.stdout), []); assert.match(text(result.stderr), /not found|unknown/i);
  }
  for (const [command, stdout, status] of [['echo supported', 'supported\n', 0], ['true', '', 0], ['false', '', 1], ['pwd', '/\n', 0]]) {
    const result = await ctx.run(command); assert.equal(result.code, status);
    assert.deepEqual(bytes(result.stdout), bytes(stdout)); assert.deepEqual(bytes(result.stderr), []);
  }
  ctx.unchanged();
});

for (const row of EXPECTED) test(`U5 ${row[0]}: compound failure and subsequent recovery`, async () => {
  const [name] = row, ctx = await fresh(), expected = refusal(await ctx.run(name), row);
  for (const command of [`${name} && echo WRONG || echo recovered`,
    `if ${name}; then echo WRONG; else echo recovered; fi`,
    `u5_wrapper() { ${name}; }; u5_wrapper || echo recovered`,
    `(${name}) || echo recovered`]) {
    const result = await ctx.run(command); assert.equal(result.code, 0);
    assert.deepEqual(bytes(result.stdout), bytes('recovered\n'));
    assert.deepEqual(bytes(result.stderr), bytes(expected.stderr)); ctx.unchanged(command);
  }
  const status = await ctx.run(`${name}; printf '%s\\n' "$?"`);
  assert.equal(status.code, 0); assert.deepEqual(bytes(status.stdout), bytes(`${expected.code}\n`));
  assert.deepEqual(bytes(status.stderr), bytes(expected.stderr)); ctx.unchanged();
  const next = await ctx.run('echo independent'); assert.equal(next.code, 0);
  assert.deepEqual(bytes(next.stdout), bytes('independent\n')); assert.deepEqual(bytes(next.stderr), []); ctx.unchanged();
});

test('U5 shell stdout and stderr redirections retain their pre-command semantics', async () => {
  const ctx = await fresh(), row = EXPECTED.find(([name]) => name === 'shred');
  const expected = refusal(await ctx.run('shred existing'), row);
  const redirected = await ctx.run('shred existing > existing'); sameRefusal(redirected, expected, row);
  assert.equal(ctx.backend.files.get('existing').bytes.length, 0, 'shell pre-command truncation still occurs');
  const err = await ctx.run('shred existing 2> error-file'); assert.equal(err.code, expected.code);
  assert.deepEqual(bytes(err.stdout), []); assert.deepEqual(bytes(err.stderr), []);
  assert.deepEqual([...ctx.backend.files.get('error-file').bytes], bytes(expected.stderr));
  assert.deepEqual(ctx.rawFace.pendingProposals(), []); assert.equal(ctx.shell.awaitingConfirm, null);
});

test('U5 denied redirects precede the refusal handler and preserve existing content', async () => {
  const ctx = await fresh({ scopes: [] }), before = backendSnapshot(ctx.backend), dispatched = [];
  ctx.atCommand((argv) => dispatched.push(argv[0]));
  const result = await ctx.run('shred existing > existing'); assert.notEqual(result.code, 0);
  assert.match(text(result.stderr), /grant|scope|denied/i); assert.deepEqual(bytes(result.stdout), []);
  assert.equal(dispatched.includes('shred'), false); assert.deepEqual(backendSnapshot(ctx.backend), before);
  assert.deepEqual(ctx.rawFace.pendingProposals(), []);
});

test('U5 redirects keep staging and refusal does not leave a pending proposal', async () => {
  const ctx = await fresh({ stageWrites: true }), original = [...ctx.backend.files.get('existing').bytes];
  const expected = refusal(await ctx.run('shred existing'), EXPECTED.find(([name]) => name === 'shred'));
  ctx.unchanged('plain shred before staged redirect');
  const staged = (result) => {
    assert.ok(result.awaitingConfirm);
    assert.equal(result.code, expected.code);
    assert.deepEqual(bytes(result.stdout), []);
    assert.deepEqual(bytes(result.stderr), bytes(expected.stderr));
    assert.deepEqual([...ctx.backend.files.get('existing').bytes], original);
  };
  staged(await ctx.run('shred existing > existing'));
  const refused = await ctx.run('n'); assert.notEqual(refused.code, 0);
  assert.deepEqual([...ctx.backend.files.get('existing').bytes], original);
  assert.deepEqual(ctx.rawFace.pendingProposals(), []); assert.equal(ctx.shell.awaitingConfirm, null);
  staged(await ctx.run('shred existing > existing'));
  const approved = await ctx.run('y'); assert.equal(approved.code, expected.code);
  assert.deepEqual(bytes(approved.stdout), []); assert.deepEqual(bytes(approved.stderr), []);
  assert.equal(ctx.backend.files.get('existing').bytes.length, 0);
  assert.deepEqual(ctx.rawFace.pendingProposals(), []); assert.equal(ctx.shell.awaitingConfirm, null);
});

test('U5 operand substitution retains its prior governed effects without leaking output', async () => {
  const ctx = await fresh(), row = EXPECTED.find(([name]) => name === 'curl');
  const expected = refusal(await ctx.run('curl'), row);
  sameRefusal(await ctx.run(`curl "$(printf ${secret} > substituted; cat substituted)"`), expected, row);
  assert.deepEqual([...ctx.backend.files.get('substituted').bytes], bytes(secret));
  assert.ok(ctx.effects.some(([kind, method]) => kind === 'fileops' && method === 'write'));
  assert.deepEqual(ctx.rawFace.pendingProposals(), []);
});

test('U5 effects instrumentation observes real supported operations and injected runtimes', async () => {
  const ctx = await fresh();
  const read = await ctx.run('cat existing'); assert.equal(read.code, 0);
  assert.deepEqual(bytes(read.stdout), [...binary]);
  for (const kind of ['face', 'grant', 'registry', 'registry-run', 'fileops', 'backend', 'oplog', 'oplog-backend']) {
    assert.ok(ctx.effects.some(([seen]) => seen === kind), `${kind}: observer is connected`);
  }
  ctx.begin(); await ctx.run("python -c 'print(1)'");
  assert.ok(ctx.effects.some(([kind, method]) => kind === 'runtime' && method === 'python.exec'));
  ctx.begin(); await ctx.run("node -e '1'");
  assert.ok(ctx.effects.some(([kind, method]) => kind === 'runtime' && method === 'js.makeModuleURL'));
});
