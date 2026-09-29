import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { segments, decideByRules, applyMode } from '../permission-rules.mjs';

const aliases = [['more secret', 'cat'], ['egrep . secret', 'grep'], ['fgrep . secret', 'grep'], ['dir secret', 'ls'], ['vdir secret', 'ls']];
const wrappers = [
  'timeout 1 rm secret', 'timeout --preserve-status 1 rm secret', 'timeout --verbose 1 rm secret',
  'timeout 1 timeout 2 rm secret', 'timeout 0 env FOO=bar rm secret',
  "'timeout' 1 rm secret", 'time"out" 1 rm secret', 'T=1 timeout "$T" rm secret',
  'echo secret | timeout 1 xargs rm', 'timeout -- 1 rm secret', ...aliases.map(([command]) => command),
];

test('runtime wrappers and aliases take the fail-closed permission path until recursive analysis exists', () => {
  for (const command of wrappers) {
    assert.equal(segments(command), null, command);
    assert.equal(decideByRules({ deny: ['Bash(rm:*)'] }, 'shell', { command }).decision, 'deny', command);
    const ask = decideByRules({ ask: ['Bash(rm:*)'] }, 'shell', { command });
    assert.equal(ask.decision, 'ask', command); assert.equal(ask.uninspectable, true, command);
    assert.equal(decideByRules({ allow: ['Bash(timeout:*)', 'Bash(*)'] }, 'shell', { command }).decision, 'unmatched', command);
  }
});

test('timeout fail-closed handling respects unrelated tools and deny precedence', () => {
  const command = 'timeout 1 rm secret';
  assert.equal(decideByRules({ deny: ['Write(secret)'] }, 'shell', { command }).decision, 'unmatched');
  assert.equal(decideByRules({ deny: ['shell(rm:*'], ask: ['Bash(*)'] }, 'shell', { command }).decision, 'deny');
  assert.equal(decideByRules({}, 'shell', { command }).decision, 'unmatched');
  assert.deepEqual(segments('echo timeout rm'), ['echo timeout rm']);
});

test('the actual app consumer preserves wrapped deny and ask decisions in bypass mode', async () => {
  const source = await readFile(new URL('../../../apps/anvil/index.html', import.meta.url), 'utf8');
  const start = source.indexOf('const byRule = decideByRules(state.permissionRules, nm, ar);');
  const end = source.indexOf('// AC-7b: a liftable refusal is ASKED', start);
  assert.ok(start >= 0 && end > start, 'the app rule/mode consumer must remain executable under this behavioral seam');
  // Execute the actual consumer, replacing unrelated policy/action-gate calls with an allowed verdict.
  const consume = new Function('state', 'nm', 'ar', 'decideByRules', 'applyMode', 'applyPolicy', 'gateAction',
    `const t=null, convoNow=[], POLICY_HINT=''; ${source.slice(start, end)} return verdict;`);
  for (const command of wrappers) {
    const run = (permissionRules) => consume({ permissionMode: 'bypass', permissionRules }, 'shell', { command },
      decideByRules, applyMode, (value) => value, () => ({ outcome: 'allow', liftable: true }));
    assert.match(run({ deny: ['Bash(rm:*)'] }), /^Refused:/, command);
    const ask = run({ ask: ['Bash(rm:*)'] });
    assert.equal(ask.outcome, 'deny', command); assert.equal(ask.liftable, true, command);
  }
});

test('aliases cannot bypass permission rules for their canonical commands', () => {
  for (const [command, canonical] of aliases) {
    assert.equal(decideByRules({ deny: [`Bash(${canonical}:*)`] }, 'shell', { command }).decision, 'deny', command);
    const ask = decideByRules({ ask: [`Bash(${canonical}:*)`] }, 'shell', { command });
    assert.equal(ask.decision, 'ask', command); assert.equal(ask.uninspectable, true, command);
  }
});
