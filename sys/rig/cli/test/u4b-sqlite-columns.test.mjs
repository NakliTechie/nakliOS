import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, decode } from './u3-harness.mjs';
import { hostPython } from './u4b-sqlite-host.mjs';

// Preserve native SQLite CLI JSON text semantics. JSON.parse would hide the
// duplicate-key data loss these assertions must detect.
export const columnCases = [
  { name:'duplicate aliases', sql:'SELECT 1 AS x,2 AS x', expected:'[{"x":1,"x":2}]\n' },
  { name:'duplicate join column names', sql:'SELECT * FROM (SELECT 1 AS id,\'left\' AS value) a CROSS JOIN (SELECT 2 AS id,\'right\' AS value) b', expected:'[{"id":1,"value":"left","id":2,"value":"right"}]\n' },
  { name:'escaped duplicate names and values', sql:'SELECT NULL AS "a""b",\'नमस्ते\' AS "a""b",\'line\' AS "a""b"', expected:'[{"a\\"b":null,"a\\"b":"नमस्ते","a\\"b":"line"}]\n' },
];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
for (const item of columnCases) test(`SQLite JSON preserves ${item.name}`, async t => {
  const ctx=fresh({kiln:hostPython(t)});
  const result=await ctx.run('sqlite3 -json :memory: '+quote(item.sql));
  assert.equal(result.code,0,decode(result.stderr));
  assert.equal(decode(result.stdout),item.expected);
});
