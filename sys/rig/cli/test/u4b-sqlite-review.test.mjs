import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createDataCommands } from '../cmds/data.mjs';
import { createIO } from '../io.mjs';
import { fresh, seed, decode } from './u3-harness.mjs';
import { hostPython } from './u4b-sqlite-host.mjs';

const payloadBytes = 4075520;
function realDatabase() {
  const program = `import sqlite3, sys\nc = sqlite3.connect(':memory:', isolation_level=None)\nc.execute('CREATE TABLE t(id INTEGER PRIMARY KEY, flag INTEGER, payload BLOB)')\nc.execute('INSERT INTO t VALUES(1,0,zeroblob(${payloadBytes}))')\nsys.stdout.buffer.write(c.serialize())\n`;
  const r = spawnSync(process.env.B10_SQLITE_PYTHON || 'python3', ['-I', '-c', program], { maxBuffer: 16 << 20 });
  assert.equal(r.status, 0, String(r.stderr)); return new Uint8Array(r.stdout);
}

test('SQLite updates a real near-3.9MiB database within default input and retention limits', async (t) => {
  const kiln = hostPython(t), ctx = fresh({ kiln }), original = realDatabase();
  assert.ok(original.byteLength > 3.8 * 1024 * 1024); assert.ok(original.byteLength < 4 * 1024 * 1024);
  await seed(ctx, { 'large.db': original });
  const result = await ctx.run("sqlite3 large.db 'UPDATE t SET flag=1; SELECT flag,length(payload) FROM t'");
  t.diagnostic(`databaseBytes=${original.byteLength}, code=${result.code}, stderr=${decode(result.stderr || '')}`);
  assert.equal(result.code, 0, decode(result.stderr)); assert.equal(decode(result.stdout), `1|${payloadBytes}\n`);
  const check = await ctx.run("sqlite3 -readonly large.db 'SELECT flag,length(payload),hex(substr(payload,1,4)),hex(substr(payload,-4)) FROM t'");
  assert.equal(check.code, 0, decode(check.stderr)); assert.equal(decode(check.stdout), `1|${payloadBytes}|00000000|00000000\n`);
});

test('SQLite tiny retention cap still refuses a real database before publication', async (t) => {
  const kiln = hostPython(t), ctx = fresh({ kiln }), original = realDatabase(); await seed(ctx, { 'large.db': original });
  const io = createIO({ invoke: (name, input) => ctx.face.invoke(name, input) });
  const commands = createDataCommands(io, { kiln, limits: { maxRetainedBytes: 1024 }, authorize: (name, input) => ctx.face.check(name, input) });
  let result; try { result = await commands.sqlite3(['large.db', 'UPDATE t SET flag=1']); }
  catch (error) { result = { code: 2, stderr: error.message }; }
  assert.notEqual(result.code, 0); assert.match(decode(result.stderr), /retained|limit|budget/i);
  assert.deepEqual(await ctx.bytes('large.db'), Array.from(original));
});

test('SQLite validates multi-megabyte base64 responses without regular-expression stack growth', async (t) => {
  const kiln = hostPython(t), ctx = fresh({ kiln }); await seed(ctx, { 'large.db': realDatabase() });
  const io = createIO({ invoke: (name, input) => ctx.face.invoke(name, input) });
  const commands = createDataCommands(io, { kiln, limits: { maxRetainedBytes: 64 << 20 }, authorize: (name, input) => ctx.face.check(name, input) });
  const result = await commands.sqlite3(['large.db', 'UPDATE t SET flag=1; SELECT flag FROM t']);
  assert.equal(result.code, 0); assert.equal(decode(result.stdout), '1\n');
});
