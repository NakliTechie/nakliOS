// AC-7c — Tool(pattern) permission rules, and the modes.
//   node sys/ai/test/permission-rules.test.mjs
//
// A harness over a real shell needs a model to work out what a command really invokes, because
// in a real shell substitution and nested quoting make prefix-matching unsound. Anvil's curated shell
// REFUSES all of that (sys/rig/cli/shell.mjs:810), which is why these rules can be exact.
//
// The case that justifies the whole file is `ls && rm -rf /`: an allow rule for `ls` must not
// cover it, and a deny rule for `rm` must still catch it. Everything else here is scaffolding
// around keeping that true.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseRule, segments, ruleCovers, decideByRules, applyMode, MODES, MODE_LABEL, modeIsLoud }
  from '../permission-rules.mjs';

const anvil = await readFile(new URL('../../../apps/anvil/index.html', import.meta.url), 'utf8');
const CFG = { allow: ['Bash(ls:*)', 'Bash(npm test:*)', 'Read'], deny: ['Bash(rm:*)', 'Write(deploy/**)'], ask: ['Bash(git push:*)'] };
const d = (tool, args, cfg = CFG) => decideByRules(cfg, tool, args).decision;

// ── THE TRAP ──────────────────────────────────────────────────────────────
{
  assert.equal(d('shell', { command: 'ls -la' }), 'allow', 'a plain ls is allowed by its rule');
  assert.equal(d('shell', { command: 'ls && rm -rf /' }), 'deny',
    'an allow rule for the FIRST command must not cover the whole chain');
  assert.equal(d('shell', { command: 'ls; rm -rf /' }), 'deny', '; too');
  assert.equal(d('shell', { command: 'ls || rm -rf /' }), 'deny', '|| too');
  assert.equal(d('shell', { command: 'ls | rm -rf /' }), 'deny', 'a pipe too');
  assert.equal(d('shell', { command: 'rm -rf / && ls' }), 'deny', 'and whichever end it hides at');
  // Without the deny rule it is still not ALLOWED — every segment must be covered.
  assert.equal(d('shell', { command: 'ls && curl https://x' }, { allow: ['Bash(ls:*)'] }), 'unmatched',
    'an uncovered segment means the chain falls through to the gate, never to allow');
  assert.equal(d('shell', { command: 'ls && ls -la' }, { allow: ['Bash(ls:*)'] }), 'allow',
    'a chain where EVERY segment is covered is allowed');
}

// ── segmentation, including what it refuses to parse ──────────────────────
{
  assert.deepEqual(segments('ls && rm -rf /'), ['ls', 'rm -rf /']);
  assert.deepEqual(segments('a | b | c'), ['a', 'b', 'c']);
  assert.deepEqual(segments('  ls   '), ['ls']);
  assert.deepEqual(segments(''), []);
  // Quotes are tracked, so an && inside a string is not a separator.
  assert.deepEqual(segments('echo "a && b"'), ['echo "a && b"']);
  assert.deepEqual(segments("echo 'x; y'"), ["echo 'x; y'"]);
  // Anything we refuse to reason about returns null — and null must never read as "matches".
  for (const bad of ['ls $(rm -rf /)', 'ls `rm -rf /`', 'cat <<EOF', 'echo ${HOME}']) {
    assert.equal(segments(bad), null, `${bad} is not ours to parse`);
    assert.equal(d('shell', { command: bad }, { allow: ['Bash(ls:*)', 'Bash(cat:*)', 'Bash(echo:*)'] }), 'unmatched',
      `${bad} can never be ALLOWED by a prefix rule`);
  }
  // A deny rule cannot match one either — but the action gate still sees it, and that is the point
  // of falling through rather than pretending to have an answer.
  assert.equal(d('shell', { command: 'ls $(rm -rf /)' }, { deny: ['Bash(rm:*)'] }), 'unmatched');
}

// ── rule syntax ───────────────────────────────────────────────────────────
{
  assert.deepEqual(parseRule('Bash(git push:*)'), { tool: 'bash', spec: 'git push', prefix: true, source: 'Bash(git push:*)' });
  assert.deepEqual(parseRule('Read'), { tool: 'read', spec: null, prefix: false, source: 'Read' });
  assert.equal(parseRule('Bash(*)').prefix, true);
  assert.equal(parseRule('Bash(*)').spec, '');
  assert.equal(parseRule(''), null);
  assert.equal(parseRule('not a rule!'), null);
  // A prefix rule matches on a WORD boundary, not a substring — `npm test` must not cover `npm testx`.
  const npm = parseRule('Bash(npm test:*)');
  assert.equal(ruleCovers(npm, 'shell', { command: 'npm test' }), 'all');
  assert.equal(ruleCovers(npm, 'shell', { command: 'npm test -- --watch' }), 'all');
  assert.equal(ruleCovers(npm, 'shell', { command: 'npm testx' }), 'none', 'a prefix is not a substring');
  // An exact rule is exact.
  const exact = parseRule('Bash(ls)');
  assert.equal(ruleCovers(exact, 'shell', { command: 'ls' }), 'all');
  assert.equal(ruleCovers(exact, 'shell', { command: 'ls -la' }), 'none');
  // A shell rule never covers a non-shell tool, and vice versa.
  assert.equal(ruleCovers(parseRule('Bash(ls:*)'), 'read', { path: 'ls' }), 'none');
  assert.equal(ruleCovers(parseRule('Read'), 'shell', { command: 'ls' }), 'none');
}

// ── path globs ────────────────────────────────────────────────────────────
{
  assert.equal(d('write', { path: 'deploy/prod.sh' }), 'deny');
  assert.equal(d('write', { path: 'deploy/a/b/c.sh' }), 'deny', '** crosses segments');
  assert.equal(d('write', { path: 'src/a.js' }), 'unmatched');
  assert.equal(d('read', { path: 'anything.txt' }), 'allow', 'a bare tool rule covers every call');
  assert.equal(d('write', { path: 'src/a.js' }, { allow: ['Write(src/*.js)'] }), 'allow');
  assert.equal(d('write', { path: 'src/deep/a.js' }, { allow: ['Write(src/*.js)'] }), 'unmatched', '* does not cross a slash');
}

// ── precedence: deny > ask > allow ────────────────────────────────────────
{
  const cfg = { allow: ['Bash(git push:*)'], ask: ['Bash(git push:*)'], deny: ['Bash(git push:*)'] };
  assert.equal(d('shell', { command: 'git push' }, cfg), 'deny');
  assert.equal(d('shell', { command: 'git push' }, { allow: ['Bash(git push:*)'], ask: ['Bash(git push:*)'] }), 'ask',
    'ask beats allow — an explicit ask rule is a request to be asked');
  assert.equal(d('shell', { command: 'anything' }, {}), 'unmatched');
  assert.equal(d('shell', { command: 'x' }, null), 'unmatched', 'no config at all is not an error');
  assert.equal(d('shell', { command: 'x' }, { allow: ['garbage!!', 'Bash(x)'] }), 'allow', 'an unparseable rule is skipped, not fatal');
}

// ── modes ─────────────────────────────────────────────────────────────────
{
  assert.deepEqual(MODES, ['default', 'acceptEdits', 'bypass']);
  assert.equal(modeIsLoud('bypass'), true);
  assert.equal(modeIsLoud('default'), false);
  assert.ok(/dangerous/i.test(MODE_LABEL.bypass), 'the label says what it is');

  assert.equal(applyMode('default', 'shell', { command: 'x' }).decision, 'unmatched', 'default defers to the gate');
  assert.equal(applyMode('acceptEdits', 'write', { path: 'a' }).decision, 'allow');
  assert.equal(applyMode('acceptEdits', 'edit', { path: 'a' }).decision, 'allow');
  assert.equal(applyMode('acceptEdits', 'shell', { command: 'git push' }).decision, 'unmatched',
    'acceptEdits covers edits only — it is not a general bypass');

  // Bypass waives the prompt…
  assert.equal(applyMode('bypass', 'shell', { command: 'git push' },
    { gateVerdict: { outcome: 'deny', liftable: true } }).decision, 'allow');
  // …but NOT the tier that cannot be undone.
  const crit = applyMode('bypass', 'shell', { command: 'git push --force' },
    { gateVerdict: { outcome: 'deny', liftable: false, why: 'rewrites history' } });
  assert.equal(crit.decision, 'deny', 'bypass does not cover an action that cannot be undone');
  assert.match(crit.why, /bypass does not cover this/);
  assert.match(crit.why, /rewrites history/, 'and it says which one');
  // An unknown mode falls back to the safe one rather than throwing or waving through.
  assert.equal(applyMode('nonsense', 'shell', { command: 'x' }).decision, 'unmatched');
  assert.equal(applyMode(undefined, 'write', { path: 'a' }).decision, 'unmatched');
}

// ── the app: order of operations, and the loudness ────────────────────────
assert.match(anvil, /const byRule = decideByRules\(state\.permissionRules, nm, ar\)/, 'rules are consulted');
assert.match(anvil, /if\(byRule\.decision === 'deny'\)\{/, 'and a deny rule refuses');
// A deny rule must be checked BEFORE the mode, or bypass would ignore it.
assert.ok(anvil.indexOf("if(byRule.decision === 'deny')") < anvil.indexOf('const byMode = applyMode('),
  'a deny rule is checked before the mode — otherwise bypass would make deny rules worthless');
assert.match(anvil, /const byMode = applyMode\(state\.permissionMode, nm, ar, \{ gateVerdict: verdict \}\)/,
  'the mode sees the gate verdict, so bypass can still refuse the critical tier');
assert.match(anvil, /⚠ BYPASS — nothing is asked/, 'a bypassed session says so in the taskbar');
assert.match(anvil, /title:'Turn on bypass\?'/, 'and turning it on is confirmed, not a single click');
assert.match(anvil, /Only do this while you are watching/, 'with a warning that means something');
assert.match(anvil, /modeIsLoud\(mode\) \? 'BYPASS'/, 'and the ⋯ sheet shows it too');

console.log('permission-rules: `ls && rm -rf /` denies, substitution never allows, deny survives bypass, critical survives everything');
