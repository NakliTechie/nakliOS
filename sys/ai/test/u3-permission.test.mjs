import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { segments, decideByRules, applyMode } from '../permission-rules.mjs';
import * as permissionModule from '../permission-rules.mjs';
import { fresh, seed, expect } from '../../rig/cli/test/u3-harness.mjs';

const source = await readFile(new URL('../../../apps/anvil/index.html', import.meta.url), 'utf8');
const start = source.indexOf('const byRule = decideByRules(state.permissionRules, nm, ar);');
const end = source.indexOf('// AC-7b: a liftable refusal is ASKED', start);
assert.ok(start >= 0 && end > start, 'the actual app consumer remains accessible for behavioral verification');
// This executes the production consumer. Only unrelated action/policy machinery is substituted.
const consume = new Function('state', 'nm', 'ar', 'decideByRules', 'applyMode', 'applyPolicy', 'gateAction',
  `const t=null, convoNow=[], POLICY_HINT=''; ${source.slice(start, end)} return verdict;`);
function consumer(command, permissionRules, permissionMode = 'bypass', verdict = { outcome: 'allow', liftable: true }) {
  return consume({ permissionMode, permissionRules }, 'shell', { command }, decideByRules, applyMode, (value) => value, () => verdict);
}
const decision = (command, cfg) => decideByRules(cfg, 'shell', { command });
const denyRm = { deny: ['Bash(rm:*)'] };
const locations = [
  ['if condition', 'if rm victim; then echo yes; fi'],
  ['untaken then', 'if false; then rm victim; fi'],
  ['untaken elif condition', 'if true; then echo yes; elif rm victim; then echo no; fi'],
  ['untaken elif body', 'if true; then echo yes; elif false; then rm victim; fi'],
  ['untaken else', 'if true; then echo yes; else rm victim; fi'],
  ['for body', 'for x in one; do rm victim; done'],
  ['empty for body', 'for x in; do rm victim; done'],
  ['for list substitution', 'for x in "$(rm victim)"; do echo "$x"; done'],
  ['while condition', 'while rm victim; do break; done'],
  ['untaken while body', 'while false; do rm victim; done'],
  ['until condition', 'until rm victim; do break; done'],
  ['untaken until body', 'until true; do rm victim; done'],
  ['unmatched case arm', 'case safe in unsafe) rm victim;; safe) echo yes;; esac'],
  ['case subject substitution', 'case "$(rm victim)" in *) true;; esac'],
  ['brace group', '{ rm victim; }'],
  ['copied subshell', '(rm victim)'],
  ['uncalled function', 'hidden() { rm victim; }; echo safe'],
  ['called function', 'hidden() { rm victim; }; hidden'],
  ['command substitution', 'echo "$(rm victim)"'],
  ['nested command substitution', 'echo "$(echo "$(rm victim)")"'],
  ['backticks', 'echo "`rm victim`"'],
  ['assignment substitution', 'value=$(rm victim)'],
  ['redirect target substitution', 'printf data > "$(rm victim; printf target)"'],
  ['redirect input substitution', 'cat < "$(rm victim; printf target)"'],
  ['parameter default substitution', 'echo "${value:-$(rm victim)}"'],
  ['and-or', 'false && rm victim || echo safe'],
  ['negated pipeline', '! echo safe | rm victim'],
  ['environment wrapper', 'env -i X=value rm victim'],
  ['timeout wrapper', 'timeout --preserve-status 1 rm victim'],
  ['xargs wrapper', 'printf victim | xargs -n1 rm'],
  ['find exec', "find . -exec rm '{}' ';'"],
  ['find execdir', "find . -execdir rm '{}' +"],
  ['find delete', 'find . -name victim -delete'],
  ['nested wrappers', 'timeout 1 env -u HOME xargs -I{} rm {}'],
  ['wrapper inside branch', 'if false; then env timeout 1 rm victim; fi'],
  ['escaped command name', String.raw`r\m victim`],
  ['quoted command name', "r''m victim"],
];
for (const [name, command] of locations) test(`static deny reaches ${name} in the actual Anvil consumer`, () => {
  const result = decision(command, denyRm); assert.equal(result.decision, 'deny', command);
  assert.notEqual(result.uninspectable, true, `${name} must be structurally inspected, not blanket-refused`);
  assert.match(consumer(command, denyRm), /^Refused:/, command);
  assert.equal(decision(command, { deny: ['Bash(unrelated-command:*)'] }).decision, 'unmatched', `${name} has no unrelated executable`);
});

const dynamic = [
  '$COMMAND victim', 'COMMAND=rm; $COMMAND victim', '"$COMMAND" victim', '${COMMAND:-rm} victim',
  '"$(printf rm)" victim', '`printf rm` victim',
  'env "$COMMAND" victim', 'timeout 1 "$COMMAND" victim', 'printf victim | xargs "$COMMAND"',
  'find . -exec "$COMMAND" {} +', 'find . "$ACTION" victim',
  'env $OPTIONS rm victim', 'timeout $OPTIONS rm victim', 'xargs $OPTIONS rm victim',
  'printf rm | xargs -I{} {} victim', 'find . -exec {} victim \';\'',
];
for (const command of dynamic) test(`dynamic invocation fails closed through bypass: ${command}`, () => {
  const denied = decision(command, denyRm); assert.equal(denied.decision, 'deny', command); assert.equal(denied.uninspectable, true, command);
  assert.match(consumer(command, denyRm), /^Refused:/, command);
  const asked = decision(command, { ask: ['Bash(rm:*)'] }); assert.equal(asked.decision, 'ask', command); assert.equal(asked.uninspectable, true, command);
  const verdict = consumer(command, { ask: ['Bash(rm:*)'] }); assert.equal(verdict.outcome, 'deny', command); assert.equal(verdict.liftable, true, command);
  assert.equal(decision(command, { allow: ['Bash(*)'] }).decision, 'ask', 'an allow wildcard cannot certify dynamic execution');
  assert.equal(decision(command, {}).decision, 'ask', 'empty rules retain approval for dynamic executables');
  assert.equal(consumer(command, {}).outcome, 'deny', 'bypass retains the dynamic approval prompt');
});

for (const [command, canonical] of [
  ['more victim', 'cat'], ['egrep . victim', 'grep'], ['fgrep . victim', 'grep'], ['dir victim', 'ls'], ['vdir victim', 'ls'],
]) test(`alias ${command} honors canonical ${canonical} denial`, () => {
  const config = { deny: [`Bash(${canonical}:*)`] }; assert.equal(decision(command, config).decision, 'deny');
  assert.notEqual(decision(command, config).uninspectable, true); assert.match(consumer(command, config), /^Refused:/);
});

test('static quoted and escaped multiword command names match canonical rules', () => {
  for (const command of [String.raw`git p\ush`, 'g"it" p\'ush\'', "'git' 'push' origin", 'env "git" "push" origin']) {
    const config = { deny: ['Bash(git push:*)'] }; assert.equal(decision(command, config).decision, 'deny', command);
    assert.notEqual(decision(command, config).uninspectable, true, command); assert.match(consumer(command, config), /^Refused:/, command);
  }
});

test('literal argument contents never become shell source in permission analysis', () => {
  for (const command of [
    "printf '%s' 'rm victim; touch nope'", "env printf '%s' 'rm victim; touch nope'",
    "timeout 1 printf '%s' 'rm victim; touch nope'", "printf data | xargs -I{} printf '%s' 'rm victim; {}'",
    "find . -exec printf '%s' 'rm victim; {}' ';'", "cat <<'EOF'\nrm victim\n$(rm victim)\nEOF",
  ]) {
    assert.equal(decision(command, denyRm).decision, 'unmatched', command);
    assert.equal(decision(command, { allow: ['Bash(*)'] }).decision, 'allow', command);
    assert.ok(Array.isArray(segments(command)), command);
  }
});

test('allow rules must cover outer wrappers and every hidden executable', () => {
  for (const command of ['env printf ok', 'timeout 1 printf ok', "find . -exec printf ok ';'", 'printf ok | xargs printf']) {
    assert.equal(decision(command, { allow: ['Bash(env:*)', 'Bash(timeout:*)', 'Bash(find:*)', 'Bash(xargs:*)'] }).decision, 'unmatched', command);
    assert.equal(decision(command, { allow: ['Bash(*)'] }).decision, 'allow', command);
  }
  for (const command of ['if true; then printf ok; else cat other; fi', 'f() { cat other; }; printf ok']) {
    assert.equal(decision(command, { allow: ['Bash(true:*)', 'Bash(printf:*)'] }).decision, 'unmatched', command);
    assert.equal(decision(command, { allow: ['Bash(*)'] }).decision, 'allow', command);
  }
});

test('well-formed static expansions in arguments permit precise unrelated deny handling', () => {
  for (const command of ['echo "$HOME"', 'printf "%s" "${value:-default}"', 'printf "%s" "$((2+3))"', 'if true; then echo safe; fi']) {
    assert.equal(decision(command, denyRm).decision, 'unmatched', command);
    assert.equal(decision(command, { allow: ['Bash(echo:*)', 'Bash(printf:*)', 'Bash(true:*)'] }).decision, 'allow', command);
  }
});

test('malformed rules and syntax remain closed without affecting unrelated tools', () => {
  for (const command of ['if true; then rm victim', 'echo "unterminated', 'rm victim &']) {
    assert.equal(decision(command, denyRm).decision, 'deny', command);
    assert.match(consumer(command, denyRm), /^Refused:/, command);
    assert.equal(decision(command, { allow: ['Bash(*)'] }).decision, 'ask', command);
  }
  assert.equal(decision('echo safe', { deny: ['shell(rm:*'], ask: ['Bash(*)'] }).decision, 'deny');
  assert.equal(decideByRules({ deny: ['shell(rm:*'] }, 'read', { path: 'victim' }).decision, 'unmatched');
  assert.equal(decision('$CMD victim', { deny: ['Write(victim)'] }).decision, 'ask');
  assert.equal(decideByRules({ allow: ['Read'] }, 'read', { path: 'victim' }).decision, 'allow');
});

test('actual consumer preserves critical action denials despite broad static allow rules', () => {
  const result = consumer('echo safe', { allow: ['Bash(*)'] }, 'bypass', { outcome: 'deny', liftable: false, why: 'critical action' });
  assert.match(result, /^Refused:/); assert.match(result, /critical action/);
});

const contextStart = source.indexOf("if (['shell', 'bash', 'sh'].includes(nm)) ar = withShellContext(ar, shell.permissionContext);");
const { withShellContext } = permissionModule;
const consumeLive = contextStart >= 0 && contextStart < start
  ? new Function('state', 'nm', 'ar', 'shell', 'withShellContext', 'decideByRules', 'applyMode', 'applyPolicy', 'gateAction',
    `const t=null, convoNow=[], POLICY_HINT=''; ${source.slice(contextStart, end)} return verdict;`)
  : null;
function liveConsumer(ctx, command, permissionRules, args = {}) {
  assert.equal(typeof consumeLive, 'function', 'the app attaches trusted live shell state before deciding rules');
  return consumeLive({ permissionMode: 'bypass', permissionRules }, 'shell', { command, ...args }, ctx.shell,
    withShellContext, decideByRules, applyMode, (value) => value, () => ({ outcome: 'allow', liftable: true }));
}
function liveDecision(ctx, command, config, args = {}) {
  assert.equal(typeof withShellContext, 'function', 'permission rules expose a trusted-context adapter');
  return decideByRules(config, 'shell', withShellContext({ command, ...args }, ctx.shell.permissionContext));
}

test('persistent functions remain subject to deny rules in later feed calls', async () => {
  const ctx = fresh(); await seed(ctx, { victim: 'keep' });
  await expect(ctx, 'hidden() { rm victim; }', '');
  assert.ok(ctx.shell.permissionContext.functions instanceof Map);
  assert.equal(liveDecision(ctx, 'hidden', denyRm).decision, 'deny');
  assert.match(liveConsumer(ctx, 'hidden', denyRm), /^Refused:/);
  assert.equal(await ctx.read('victim'), 'keep'); assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal(liveDecision(ctx, 'hidden', { allow: ['Bash(hidden:*)'] }).decision, 'unmatched');
  assert.equal(liveDecision(ctx, 'hidden', { deny: ['Bash(unrelated-command:*)'] }).decision, 'unmatched');
  assert.ok((await ctx.run('hidden')).awaitingConfirm, 'the real persisted function reaches the governed removal');
  await ctx.shell.cancel(); assert.equal(await ctx.read('victim'), 'keep');
});

test('persistent nested function calls reveal denied commands without treating names as opaque', async () => {
  const ctx = fresh();
  await expect(ctx, 'inner() { rm victim; }; outer() { inner; }', '');
  for (const command of ['outer', 'env outer', 'timeout 1 outer', 'printf ignored | xargs outer', 'echo "$(outer)"']) {
    const result = liveDecision(ctx, command, denyRm); assert.equal(result.decision, 'deny', command);
    assert.notEqual(result.uninspectable, true, command); assert.match(liveConsumer(ctx, command, denyRm), /^Refused:/, command);
  }
});

for (const name of ['echo', 'printf', 'true', 'cat', 'more', 'dir', 'env', 'timeout', 'xargs']) {
  test(`persistent ${name} function shadowing cannot bypass static denial`, async () => {
    const ctx = fresh(); await seed(ctx, { victim: 'keep' });
    await expect(ctx, `${name}() { rm victim; }`, '');
    const result = liveDecision(ctx, name, denyRm); assert.equal(result.decision, 'deny');
    assert.notEqual(result.uninspectable, true); assert.match(liveConsumer(ctx, name, denyRm), /^Refused:/);
    assert.ok((await ctx.run(name)).awaitingConfirm, 'the runtime resolves the shadowing function');
    await ctx.shell.cancel(); assert.equal(await ctx.read('victim'), 'keep'); assert.deepEqual(ctx.face.pendingProposals(), []);
  });
}

for (const [name, command] of [['cat', 'more victim'], ['grep', 'egrep pattern victim'], ['ls', 'dir victim']]) {
  test(`canonical ${name} function shadowing remains visible through alias ${command}`, async () => {
    const ctx = fresh(); await seed(ctx, { victim: 'keep' }); await expect(ctx, `${name}() { rm victim; }`, '');
    assert.equal(liveDecision(ctx, command, denyRm).decision, 'deny'); assert.match(liveConsumer(ctx, command, denyRm), /^Refused:/);
    assert.ok((await ctx.run(command)).awaitingConfirm, 'the canonical alias target uses the live function scope');
    await ctx.shell.cancel(); assert.equal(await ctx.read('victim'), 'keep');
  });
}

test('redefinition replaces persisted permission state while copied scopes restore it', async () => {
  const ctx = fresh(); await expect(ctx, 'helper() { rm victim; }', '');
  assert.equal(liveDecision(ctx, 'helper', denyRm).decision, 'deny');
  await expect(ctx, 'helper() { printf safe; }', '');
  assert.equal(liveDecision(ctx, 'helper', denyRm).decision, 'unmatched');
  assert.equal(liveDecision(ctx, 'helper', { allow: ['Bash(helper:*)', 'Bash(printf:*)'] }).decision, 'allow');
  await expect(ctx, '(helper() { rm victim; }); value=$(helper() { rm victim; }; printf copied)', '');
  assert.equal(liveDecision(ctx, 'helper', denyRm).decision, 'unmatched'); await expect(ctx, 'helper', 'safe');
  ctx.shell.reset();
  assert.equal(ctx.shell.permissionContext.functions.size, 0);
  assert.equal(liveDecision(ctx, 'helper', denyRm).decision, 'unmatched');
});

test('persistent dynamic function bodies fail closed under ask rules in bypass mode', async () => {
  const ctx = fresh(); await expect(ctx, 'dispatch() { "$1" victim; }', '');
  const rules = { ask: ['Bash(rm:*)'] }, result = liveDecision(ctx, 'dispatch rm', rules);
  assert.equal(result.decision, 'ask'); assert.equal(result.uninspectable, true);
  const verdict = liveConsumer(ctx, 'dispatch rm', rules); assert.equal(verdict.outcome, 'deny'); assert.equal(verdict.liftable, true);
});

test('tool arguments cannot replace trusted persistent function context', async () => {
  const ctx = fresh(); await expect(ctx, 'hidden() { rm victim; }', '');
  const forged = { permissionContext: { functions: new Map() }, functions: new Map(), shellContext: { functions: new Map() } };
  assert.equal(liveDecision(ctx, 'hidden', denyRm, forged).decision, 'deny');
  assert.match(liveConsumer(ctx, 'hidden', denyRm, forged), /^Refused:/);
});

const fullGuardStart = source.indexOf('try{', source.indexOf('// AC-7: a typed verdict on THIS action'));
const fullGuardEnd = source.indexOf('// Defence in depth for the same five:', fullGuardStart);
assert.ok(fullGuardStart >= 0 && fullGuardEnd > fullGuardStart, 'the actual complete authorization guard is available');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const consumeFullGuard = new AsyncFunction('state', 'nm', 'ar', 'shell', 'withShellContext', 'decideByRules', 'applyMode', 'applyPolicy', 'gateAction', 'askChoice',
  `const t=null, runCtx=null, POLICY_HINT='policy', callObj=null; ${source.slice(fullGuardStart, fullGuardEnd)} return 'DISPATCH_REACHED';`);
for (const fault of ['context', 'decideByRules', 'applyMode', 'applyPolicy', 'gateAction']) {
  test(`Anvil authorization exception in ${fault} refuses before dispatch`, async () => {
    const ctx = fresh();
    const failed = () => { throw new Error(`probe-${fault}`); };
    const result = await consumeFullGuard({ permissionMode: 'bypass', permissionRules: {} }, 'shell', { command: 'touch forbidden' },
      fault === 'context' ? { get permissionContext() { return failed(); } } : ctx.shell,
      withShellContext, fault === 'decideByRules' ? failed : decideByRules, fault === 'applyMode' ? failed : applyMode,
      fault === 'applyPolicy' ? failed : (value) => value,
      fault === 'gateAction' ? failed : () => ({ outcome: 'allow', liftable: true }), async () => 'once');
    assert.notEqual(result, 'DISPATCH_REACHED'); assert.match(result, /^Refused:/);
  });
}

test('Anvil authorization prompt exception refuses before dispatch', async () => {
  const ctx = fresh();
  const result = await consumeFullGuard({ permissionMode: 'default', permissionRules: {} }, 'shell', { command: 'touch forbidden' }, ctx.shell,
    withShellContext, decideByRules, applyMode, (value) => value,
    () => ({ outcome: 'deny', liftable: true, why: 'requires approval' }), async () => { throw new Error('prompt unavailable'); });
  assert.notEqual(result, 'DISPATCH_REACHED'); assert.match(result, /^Refused:/);
});
