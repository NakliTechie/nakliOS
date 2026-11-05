// Conformance — Anvil's door onto the common rail (sys/ai/app-command-tool.mjs).
//
//   node sys/ai/test/app-command-tool.test.mjs

import assert from 'node:assert/strict';
import { appCommandTool, runAppCommand } from '../app-command-tool.mjs';
import { runToolset, BED_UNWIRED } from '../run-assembly.mjs';

assert.equal(appCommandTool().function.name, 'app_command');
assert.ok(runToolset('code').some((t) => t.function.name === 'app_command'), 'code mode offers it');
assert.ok(!runToolset('ask').some((t) => t.function.name === 'app_command'), 'ask mode changes nothing');
assert.ok(BED_UNWIRED.includes('app_command'), 'a bed answers it honestly');

assert.match(await runAppCommand({ query: 'x' }, undefined), /inside NakliOS/);

const seen = [];
const commands = {
  async search(query) { seen.push(['search', query]); return query === 'none' ? [] : [{ name: 'reckon.range.read', description: 'Read cells' }]; },
  async call(name, input) {
    seen.push(['call', name, input]);
    if (name === 'a.staged') return { staged: true, proposal_id: 'p1' };
    if (name === 'a.denied') return { ok: false, code: 'EDENIED', message: 'the person did not allow it' };
    if (name === 'a.throws') throw new Error('rail down');
    if (name === 'a.big') return { ok: true, result: 'x'.repeat(9000) };
    return { ok: true, result: { values: [[1]] } };
  },
};
assert.match(await runAppCommand({ query: 'sheet' }, commands), /reckon\.range\.read/);
assert.match(await runAppCommand({ query: 'none' }, commands), /No app command matches/);
assert.match(await runAppCommand({ name: 'reckon.range.read', input: { ref: 'A1' } }, commands), /"values"/);
assert.deepEqual(seen.at(-1), ['call', 'reckon.range.read', { ref: 'A1' }]);
assert.match(await runAppCommand({ name: 'a.staged' }, commands), /has not happened yet/);
assert.match(await runAppCommand({ name: 'a.denied' }, commands), /^Error: the person did not allow it/);
assert.match(await runAppCommand({ name: 'a.throws' }, commands), /^Error: rail down/);
assert.match(await runAppCommand({ name: 'a.big' }, commands), /truncated/);

console.log('app-command-tool: PASS');
