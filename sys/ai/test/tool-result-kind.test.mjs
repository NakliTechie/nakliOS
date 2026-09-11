// B1 — the closed failure-kind set, classified from the exact text the model saw.
//   node sys/ai/test/tool-result-kind.test.mjs
import assert from 'node:assert/strict';
import { classifyToolResult, TOOL_FAILURE_KINDS } from '../tool-result-kind.mjs';

const cases = [
  ['shell', 'cat: nope.txt: ENOENT\n[exit 1]', 'not_found'],
  ['shell', "python: can't open file 'x.py': ENOENT", 'not_found'],
  ['read',  'Error reading a.txt: ENOENT', 'not_found'],
  ['skill', 'No skill named "x". Available: a, b.', 'not_found'],
  ['shell', 'inv: unknown command: bogus\n[exit 2]', 'not_found'],
  ['write', 'Refused: .anvil/skills/ is managed by `skill_manage`', 'rejected'],
  ['shell', 'path is read-only under this grant: .anvil/gate/x.py\n[exit 1]', 'rejected'],
  ['shell', 'rm (4 paths) is destructive. confirm? [y/N]', 'rejected'],
  ['shell', 'Error: could not parse arguments as JSON: Unterminated string', 'invalid_args'],
  ['task_done', 'Error (invalid_args): task_done needs a summary', 'invalid_args'],
  ['nosuch', 'Error: unknown tool "nosuch"', 'unavailable'],
  ['dispatch', 'Error: dispatch (parallel subagents) is not available here.', 'unavailable'],
  ['shell', 'python: the Kiln kernel is not available (needs cross-origin isolation — open Forge as a tab)', 'unavailable'],
  ['shell', 'Traceback (most recent call last):\n  File "<exec>", line 1\nValueError: boom\n[exit 1]', 'execution_error'],
  ['shell', '(no output)\n[exit 2]', 'execution_error'],
  ['shell', 'inv: OK\n[exit 0]', null],
  ['shell', 'inv: OK\n[exit 0] [expect] MET (contains inv: OK)', null],
  ['read',  '    1  import os\n    2  print(1)', null],
  ['write', 'Wrote a.py (12 bytes)', null],
  ['shell', '', null],
  ['shell', 'some output mentioning the word error in prose\n[exit 0]', null],
];
let n = 0;
for (const [name, text, kind] of cases) { assert.equal(classifyToolResult(name, text), kind, `${name}: ${JSON.stringify(text.slice(0, 50))} → ${kind}`); n++; }
assert.equal(classifyToolResult('shell', 'Refused: nope.txt is not found under this grant'), 'rejected', 'a refusal that names a path is a refusal'); n++;
assert.deepEqual([...TOOL_FAILURE_KINDS].sort(), ['execution_error', 'invalid_args', 'not_found', 'rejected', 'unavailable']); n++;
for (const [, text] of cases) { const k = classifyToolResult('x', text); assert.ok(k === null || TOOL_FAILURE_KINDS.includes(k), 'every kind is in the set'); } n++;
console.log(`tool-result-kind: ${n} checks passed — the closed set, from the text the model saw`);
