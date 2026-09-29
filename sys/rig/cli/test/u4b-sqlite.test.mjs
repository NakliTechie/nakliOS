import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataCommands } from '../cmds/data.mjs';
import { createIO } from '../io.mjs';
import { createKiln } from '../../../kiln/kiln.mjs';
import { fresh, seed, absent, decode, deferred, delay, expect } from './u3-harness.mjs';
import { hostPython } from './u4b-sqlite-host.mjs';

// Written before the B10 complete-build release. SQL expected values are literal,
// independent fixtures. Native comparisons and real Kiln evidence are separate.
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const sql = (db, query, flags = '') => `sqlite3 ${flags} ${quote(db)} ${quote(query)}`;
const success = (result) => { assert.equal(result.code, 0, decode(result.stderr || result.output || '')); return decode(result.stdout); };
const failure = (result) => { assert.notEqual(result.code, 0); assert.notEqual(decode(result.stderr || ''), '', 'failure has a diagnostic'); return decode(result.stderr); };
const limited = (result) => assert.match(failure(result), /limit|budget|exceed|large|bound|interrupt|full/i);
const create = 'CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO t VALUES(1,\'seed\');';
function bounded(ctx, kiln, { limits = {}, ...options } = {}) {
  const io = createIO({ invoke: (name, input) => ctx.face.invoke(name, input) });
  const commands = createDataCommands(io, { kiln, authorize: (name, input) => ctx.face.check(name, input), limits, ...options });
  return async (argv, stdin = '') => {
    try { return await commands.sqlite3(argv, stdin); }
    catch (error) { return { code: typeof error.code === 'number' ? error.code : 2, stdout: '', stderr: error.message }; }
  };
}

test('SQLite and DuckDB are discoverable and refuse absent runtimes honestly', async () => {
  const ctx = fresh();
  for (const name of ['sqlite3', 'duckdb']) assert.ok(ctx.shell.commands.includes(name), name);
  assert.match(failure(await ctx.run("sqlite3 :memory: 'SELECT 1'")), /Kiln|Python|Pyodide|runtime/i);
  assert.match(failure(await ctx.run("duckdb -c 'SELECT 1'")), /DuckDB.*(?:unavailable|runtime|not|missing)|(?:unavailable|runtime|not|missing).*DuckDB/i);
});

test('SQLite executes real SQL with joins, aggregates, CTEs, arithmetic and literal data', async (t) => {
  const kiln = hostPython(t), ctx = fresh({ kiln });
  const query = `CREATE TABLE a(id INTEGER, txt TEXT); INSERT INTO a VALUES(1,'a; b'),(2,'quote '' and \\ path');
    WITH n(v) AS (SELECT 10 UNION ALL SELECT 20) SELECT a.id, a.txt, sum(n.v), 7*6 FROM a CROSS JOIN n GROUP BY a.id ORDER BY a.id;`;
  assert.equal(success(await ctx.run(sql(':memory:', query))), "1|a; b|30|42\n2|quote ' and \\ path|30|42\n");
  assert.equal(kiln.calls.length, 1);
  assert.deepEqual(kiln.files(), [], 'in-memory SQLite leaves no host database files');
});

test('SQLite list headers, separators, null values and noheader are independent', async (t) => {
  const ctx = fresh({ kiln: hostPython(t) });
  const query = "SELECT 7 AS id, NULL AS missing, 'x|y' AS value";
  assert.equal(success(await ctx.run(sql(':memory:', query, '-header -separator :: -nullvalue NULL'))), 'id::missing::value\n7::NULL::x|y\n');
  assert.equal(success(await ctx.run(sql(':memory:', query, '-header -noheader'))), '7||x|y\n');
});

test('SQLite JSON preserves values and CSV quotes commas, quotes and newlines', async (t) => {
  const ctx = fresh({ kiln: hostPython(t) });
  const query = `SELECT 42 AS n, 1.5 AS r, NULL AS nil, 'x,"y"' AS txt`;
  assert.deepEqual(JSON.parse(success(await ctx.run(sql(':memory:', query, '-json')))), [{ n: 42, r: 1.5, nil: null, txt: 'x,"y"' }]);
  assert.equal(success(await ctx.run(sql(':memory:', query, '-csv -header'))).replaceAll('\r\n', '\n'), 'n,r,nil,txt\n42,1.5,,"x,""y"""\n');
  assert.equal(success(await ctx.run(sql(':memory:', "SELECT 'first'||char(10)||'second' AS txt", '-csv'))).replaceAll('\r\n', '\n'), '"first\nsecond"\n');
});

test('SQLite reads SQL through governed stdin and respects the shell cwd', async (t) => {
  const ctx = fresh({ kiln: hostPython(t) }); await seed(ctx, { 'work/query.sql': create + 'SELECT value FROM t;' });
  success(await ctx.run('cd work'));
  assert.equal(success(await ctx.run('sqlite3 data.db < query.sql')), 'seed\n');
  assert.equal(success(await ctx.run(sql('data.db', 'SELECT count(*) FROM t'))), '1\n');
  await absent(ctx, 'data.db');
  assert.equal(decode(Uint8Array.from((await ctx.bytes('work/data.db')).slice(0, 16))), 'SQLite format 3\0');
});

test('SQLite binary database round trips preserve BLOBs, Unicode and schema', async (t) => {
  const ctx = fresh({ kiln: hostPython(t) });
  success(await ctx.run(sql('data.db', "CREATE TABLE t(id INTEGER PRIMARY KEY, value BLOB, txt TEXT); INSERT INTO t VALUES(9,x'00017fff80','हिन्दी');")));
  const bytes = await ctx.bytes('data.db'); assert.ok(bytes.includes(0)); assert.ok(bytes.includes(255));
  await seed(ctx, { 'copy.db': Uint8Array.from(bytes) });
  assert.equal(success(await ctx.run(sql('copy.db', 'SELECT id,hex(value),txt FROM t'))), '9|00017FFF80|हिन्दी\n');
  assert.deepEqual(await ctx.bytes('data.db'), bytes);
});

test('SQLite committed, rolled back, savepoint and unfinished transactions preserve SQL semantics', async (t) => {
  const ctx = fresh({ kiln: hostPython(t) }); success(await ctx.run(sql('data.db', create)));
  success(await ctx.run(sql('data.db', "BEGIN; INSERT INTO t VALUES(2,'commit'); COMMIT; BEGIN; INSERT INTO t VALUES(3,'rollback'); ROLLBACK;")));
  success(await ctx.run(sql('data.db', "SAVEPOINT x; INSERT INTO t VALUES(4,'savepoint'); ROLLBACK TO x; RELEASE x;")));
  success(await ctx.run(sql('data.db', "BEGIN; INSERT INTO t VALUES(5,'unfinished');")));
  assert.equal(success(await ctx.run(sql('data.db', 'SELECT id,value FROM t ORDER BY id'))), '1|seed\n2|commit\n');
});

test('SQLite statement splitting preserves trigger bodies, comments and quoted semicolons', async (t) => {
  const ctx = fresh({ kiln: hostPython(t) });
  const query = `CREATE TABLE t(value TEXT); CREATE TABLE audit(value TEXT);
    CREATE TRIGGER copy_value AFTER INSERT ON t BEGIN INSERT INTO audit VALUES(new.value); INSERT INTO audit VALUES('trigger; literal'); END;
    -- a comment ; is not a statement
    INSERT INTO t VALUES('one;two'); /* ; */ SELECT value FROM audit ORDER BY rowid;`;
  assert.equal(success(await ctx.run(sql(':memory:', query))), 'one;two\ntrigger; literal\n');
});

test('SQLite errors reject returned mutations and leave existing database bytes unchanged', async (t) => {
  const ctx = fresh({ kiln: hostPython(t) }); success(await ctx.run(sql('data.db', create))); const before = await ctx.bytes('data.db');
  failure(await ctx.run(sql('data.db', "INSERT INTO t VALUES(2,'unpublished'); SELECT missing FROM t;")));
  assert.deepEqual(await ctx.bytes('data.db'), before);
  failure(await ctx.run(sql('new.db', 'CREATE TABLE q(x); THIS IS NOT SQL;'))); await absent(ctx, 'new.db');
  assert.equal(success(await ctx.run(sql('data.db', 'SELECT count(*) FROM t'))), '1\n');
});

test('SQLite readonly permits reads without file writes and rejects mutations and missing databases', async (t) => {
  const kiln = hostPython(t), ctx = fresh({ kiln }); success(await ctx.run(sql('data.db', create))); const before = await ctx.bytes('data.db');
  const writes = [], write = ctx.backend.write.bind(ctx.backend); ctx.backend.write = async (...args) => { writes.push(args[0]); return write(...args); };
  assert.equal(success(await ctx.run(sql('data.db', 'SELECT value FROM t', '-readonly'))), 'seed\n');
  failure(await ctx.run(sql('data.db', "UPDATE t SET value='bad'", '-readonly')));
  failure(await ctx.run(sql('absent.db', 'SELECT 1', '-readonly')));
  assert.deepEqual(writes, []); assert.deepEqual(await ctx.bytes('data.db'), before); await absent(ctx, 'absent.db');
});

for (const query of [
  "ATTACH DATABASE 'forbidden.db' AS outside", 'DETACH DATABASE main',
  "SELECT load_extension('forbidden.so')", "VACUUM INTO 'forbidden.db'",
  "SELECT readfile('forbidden.db')", "SELECT writefile('forbidden.db','payload')",
  "PRAGMA temp_store_directory='.'", "PRAGMA data_store_directory='.'",
]) test(`SQLite denies external filesystem SQL: ${query}`, async (t) => {
  const kiln = hostPython(t), ctx = fresh({ kiln });
  failure(await ctx.run(sql(':memory:', query))); assert.deepEqual(kiln.files(), []); assert.deepEqual(ctx.face.pendingProposals(), []);
});

for (const query of ['.shell echo bad', '.read query.sql', '.open other.db', '.load extension', '.output result', '.once result']) test(`SQLite refuses shell dot commands: ${query}`, async (t) => {
  const kiln = hostPython(t), ctx = fresh({ kiln }); failure(await ctx.run(sql(':memory:', query))); assert.deepEqual(kiln.files(), []);
});

test('SQLite literal SQL strings cannot become Python source or shell commands', async (t) => {
  const kiln = hostPython(t), ctx = fresh({ kiln });
  const value = `'); __import__("os").system("touch forbidden"); # $HOME $(touch forbidden) \\n`;
  assert.equal(success(await ctx.run(sql(':memory:', `SELECT '${value.replaceAll("'", "''")}'`))), value + '\n');
  assert.deepEqual(kiln.files(), []);
});

test('SQLite unknown flags and binary SQL fail without invoking the runtime', async (t) => {
  const kiln = hostPython(t), ctx = fresh({ kiln }), run = bounded(ctx, kiln);
  failure(await run(['--bad-flag', ':memory:', 'SELECT 1']));
  failure(await run([':memory:'], Uint8Array.from([0xff, 0x00, 0x41])));
  assert.equal(kiln.calls.length, 0);
});

test('SQLite preserves real Kiln consent denial without runtime loading', async () => {
  let loads = 0; const kiln = createKiln({ consent: () => false, loadRuntime: async () => { loads++; throw new Error('must not load'); } });
  const ctx = fresh({ kiln }); assert.match(failure(await ctx.run(sql(':memory:', 'SELECT 1'))), /consent|download|Kiln/i); assert.equal(loads, 0);
});

test('SQLite reports actual runtime availability and isolation errors', async () => {
  const kiln = createKiln({ consent: () => true, loadRuntime: async () => { throw new Error('crossOriginIsolated and SharedArrayBuffer required'); } });
  const ctx = fresh({ kiln }); assert.match(failure(await ctx.run(sql(':memory:', 'SELECT 1'))), /crossOriginIsolated|SharedArrayBuffer/i);
});

test('SQLite database grants reject inaccessible input before Python receives it', async (t) => {
  const kiln = hostPython(t), ctx = fresh({ kiln, prefixes: ['allowed'] }); await seed(ctx, { 'secret/data.db': 'private bytes' });
  failure(await ctx.run(sql('secret/data.db', 'SELECT 1'))); assert.equal(kiln.calls.length, 0); await absent(ctx, 'allowed/out.db');
});

test('SQLite readonly grants permit SELECT and deny database mutation', async (t) => {
  const source = fresh({ kiln: hostPython(t) }); success(await source.run(sql('data.db', create)));
  const ctx = fresh({ kiln: hostPython(t), scopes: ['fs:read'] }); await seed(ctx, { 'data.db': Uint8Array.from(await source.bytes('data.db')) }); const before = await ctx.bytes('data.db');
  assert.equal(success(await ctx.run(sql('data.db', 'SELECT value FROM t', '-readonly'))), 'seed\n');
  failure(await ctx.run(sql('data.db', "UPDATE t SET value='bad'"))); assert.deepEqual(await ctx.bytes('data.db'), before);
});

test('SQLite writes stage binary database bytes and obey refusal and approval', async (t) => {
  const ctx = fresh({ kiln: hostPython(t), stageWrites: true });
  assert.ok((await ctx.run(sql('data.db', create))).awaitingConfirm); await absent(ctx, 'data.db');
  failure(await ctx.run('n')); await absent(ctx, 'data.db'); assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.ok((await ctx.run(sql('data.db', create))).awaitingConfirm); await absent(ctx, 'data.db'); success(await ctx.run('y'));
  assert.equal(success(await ctx.run(sql('data.db', 'SELECT value FROM t', '-readonly'))), 'seed\n'); assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('SQLite Stop clears a pending database proposal without applying bytes', async (t) => {
  const ctx = fresh({ kiln: hostPython(t), stageWrites: true });
  assert.ok((await ctx.run(sql('data.db', create))).awaitingConfirm); await ctx.shell.cancel(); assert.equal(ctx.shell.lastCode, 130);
  await absent(ctx, 'data.db'); assert.deepEqual(ctx.face.pendingProposals(), []); await expect(ctx, 'echo recovered', 'recovered\n');
});

test('SQLite Stop awaits its running Python then prevents returned database writes', { timeout: 20000 }, async (t) => {
  const entered = deferred(), release = deferred();
  const kiln = hostPython(t, { after: async (result) => { entered.resolve(); await release.promise; return result; } });
  const ctx = fresh({ kiln }), active = ctx.run(sql('data.db', create)); await entered.promise;
  let stopped = false; const stopping = ctx.shell.cancel().then(() => { stopped = true; });
  await delay(15); assert.equal(stopped, false, 'Stop waits for the owned runtime'); release.resolve(); await Promise.all([active, stopping]);
  assert.equal(ctx.shell.lastCode, 130); await absent(ctx, 'data.db'); assert.deepEqual(ctx.face.pendingProposals(), []); await expect(ctx, 'echo recovered', 'recovered\n');
});

test('SQLite refuses scoped deadlines before unsupported Python execution', async (t) => {
  const kiln = hostPython(t), ctx = fresh({ kiln });
  assert.match(failure(await ctx.run("timeout 1 sqlite3 :memory: 'SELECT 1'")), /deadline|timeout|cancel|Python|Kiln/i); assert.equal(kiln.calls.length, 0);
});

for (const [name, limits, query] of [
  ['SQL bytes', { maxSqlBytes: 16 }, "SELECT 'this SQL exceeds its byte budget'"],
  ['input bytes', { maxInputBytes: 16 }, "SELECT 'this input exceeds its byte budget'"],
  ['output bytes', { maxOutputBytes: 8 }, "SELECT '01234567890123456789'"],
  ['row count', { maxRows: 2 }, 'SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3'],
  ['VM steps', { maxSqlSteps: 100 }, 'WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<100000) SELECT sum(v) FROM n'],
  ['database bytes', { maxDatabaseBytes: 4096 }, "CREATE TABLE huge(value); INSERT INTO huge VALUES(zeroblob(65536));"],
]) test(`SQLite ${name} bounds reject without publishing a database`, async (t) => {
  const kiln = hostPython(t), ctx = fresh({ kiln }), run = bounded(ctx, kiln, { limits });
  limited(await run(['out.db'], query)); await absent(ctx, 'out.db'); assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('SQLite rejects an oversized database before runtime import', async (t) => {
  const kiln = hostPython(t), ctx = fresh({ kiln }); await seed(ctx, { 'large.db': new Uint8Array(1025) });
  limited(await bounded(ctx, kiln, { limits: { maxDatabaseBytes: 1024 } })(['large.db', 'SELECT 1'])); assert.equal(kiln.calls.length, 0);
});

test('SQLite rejects invalid database bytes without overwriting the source', async (t) => {
  const ctx = fresh({ kiln: hostPython(t) }); await seed(ctx, { 'bad.db': Uint8Array.from([0, 255, 1, 2, 3]) }); const before = await ctx.bytes('bad.db');
  failure(await ctx.run(sql('bad.db', 'SELECT name FROM sqlite_master'))); assert.deepEqual(await ctx.bytes('bad.db'), before);
});

for (const [name, damage] of [
  ['truncated flag', (r) => ({ ...r, truncated: true })],
  ['truncated JSON', (r) => ({ ...r, stdout: r.stdout.slice(0, -9) })],
  ['extra stdout', (r) => ({ ...r, stdout: r.stdout + '\nunframed data' })],
  ['runtime failure', (r) => ({ ...r, status: 'error', stderr: 'forced runtime failure' })],
]) test(`SQLite ${name} rejects an otherwise real runtime response before writes`, async (t) => {
  const kiln = hostPython(t, { after: damage }), ctx = fresh({ kiln });
  failure(await ctx.run(sql('data.db', create))); await absent(ctx, 'data.db'); assert.deepEqual(ctx.face.pendingProposals(), []);
});

for (const [field, value] of [['database', '%%%invalid-base64%%%'], ['database', 3], ['output', {}], ['changed', 'yes'], ['ok', 'yes']]) {
  test(`SQLite validates the complete response field ${field}=${JSON.stringify(value)} before writes`, async (t) => {
    const kiln = hostPython(t, { after: (result) => ({ ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), [field]: value }) }) });
    const ctx = fresh({ kiln }); failure(await ctx.run(sql('data.db', create))); await absent(ctx, 'data.db'); assert.deepEqual(ctx.face.pendingProposals(), []);
  });
}

test('SQLite rejects valid base64 that is not database bytes before writing', async (t) => {
  const kiln = hostPython(t, { after: (result) => ({ ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), database: 'bm90IGEgc3FsaXRlIGRhdGFiYXNl' }) }) });
  const ctx = fresh({ kiln }); failure(await ctx.run(sql('data.db', create))); await absent(ctx, 'data.db');
});

test('SQLite validates response output bounds before publishing valid database bytes', async (t) => {
  const kiln = hostPython(t, { after: (result) => ({ ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), output: 'x'.repeat(65) }) }) });
  const ctx = fresh({ kiln }), run = bounded(ctx, kiln, { limits: { maxOutputBytes: 64 } });
  limited(await run(['data.db', create])); await absent(ctx, 'data.db');
});

test('SQLite preserves concurrent database changes while Python owns the old snapshot', async (t) => {
  const source = fresh({ kiln: hostPython(t) }); success(await source.run(sql('data.db', create))); const original = Uint8Array.from(await source.bytes('data.db'));
  success(await source.run(sql('data.db', "UPDATE t SET value='external'"))); const replacement = Uint8Array.from(await source.bytes('data.db'));
  const entered = deferred(), release = deferred(), kiln = hostPython(t, { after: async (result) => { entered.resolve(); await release.promise; return result; } });
  const ctx = fresh({ kiln }); await seed(ctx, { 'data.db': original });
  const active = ctx.run(sql('data.db', "UPDATE t SET value='stale'")); await entered.promise;
  await seed(ctx, { 'data.db': replacement }); release.resolve(); failure(await active);
  assert.deepEqual(await ctx.bytes('data.db'), Array.from(replacement));
});
