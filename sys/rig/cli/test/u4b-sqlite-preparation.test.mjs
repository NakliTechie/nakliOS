import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataCommands } from '../cmds/data.mjs';
import { createIO } from '../io.mjs';
import { fresh, absent, decode } from './u3-harness.mjs';
import { hostPython } from './u4b-sqlite-host.mjs';

// Additive regression requested before correction group two. The SQLite VM
// progress hook cannot bound Python's statement splitting and preparation work.
for (const [name, query] of [
  ['quoted semicolons', `SELECT substr('${';'.repeat(512)}',1,1)`],
  ['trigger body semicolons', `CREATE TABLE a(v); CREATE TABLE b(v); CREATE TRIGGER tr AFTER INSERT ON a BEGIN ${'INSERT INTO b SELECT 1 WHERE 0;'.repeat(32)} END; SELECT 1;`],
  ['plain scan bytes', ' '.repeat(3000) + 'SELECT 1'],
]) test(`SQLite preparation work bounds ${name} before publishing database bytes`, async (t) => {
  const kiln = hostPython(t), ctx = fresh({ kiln });
  const io = createIO({ invoke: (name, input) => ctx.face.invoke(name, input) });
  const commands = createDataCommands(io, { kiln, limits: { maxSqlSteps: 2048 }, authorize: (name, input) => ctx.face.check(name, input) });
  let result;
  try { result = await commands.sqlite3(['out.db', query]); }
  catch (error) { result = { code: typeof error.code === 'number' ? error.code : 2, stdout: '', stderr: error.message }; }
  assert.notEqual(result.code, 0, 'Python SQL preparation must consume the work budget');
  assert.match(decode(result.stderr), /work|step|prepar|limit|budget|exceed/i);
  assert.equal(kiln.calls.length, 1, 'the real generated Python executes');
  await absent(ctx, 'out.db'); assert.deepEqual(ctx.face.pendingProposals(), []);
});
