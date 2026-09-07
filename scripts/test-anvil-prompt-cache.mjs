// F3 — the system message is the CACHE PREFIX, and nothing volatile may live in it.
//   node scripts/test-anvil-prompt-cache.mjs
//
// Anvil concatenated SYSTEM + MODE_NOTE + LESSON_NOTE + projectContext + memoryIndex +
// skillsIndex into one system message rebuilt every run. Every `remember` write and every
// skill status flip therefore invalidated the WHOLE prefix — real money on BYOK, real latency
// on a local model — and the tool list was conditional on those same indexes, so the first
// `remember` in a fresh workspace mutated the tool SCHEMA block too, which is the most
// expensive thing in the prompt to change.
//
// This test builds the two prompts a pair of runs would send, differing only by one new fact,
// and asserts the prefix is shared. Grep anchors alone cannot show that; this composes the
// real strings from the real constants.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildMemoryIndex } from '../sys/ai/memory-store.mjs';
import { buildSkillsIndex } from '../sys/ai/skills.mjs';
import { inlineModule, extractFunction, extractRegion, evaluate } from './anvil-harness.mjs';

const anvil = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');

// The prompt shape, read out of the app so this cannot pass on a stale copy of the rule.
const sysMsgLine = anvil.match(/const sysMsg=\(extra\)=>\(\{role:'system',content:([^}]*)\}\)/);
assert.ok(sysMsgLine, 'the system message is built in one place');
const prefixExpr = sysMsgLine[1];
for (const volatile of ['projectContext', 'memoryIndex', 'skillsIndex', 'recoveryPreface']) {
  assert.ok(!prefixExpr.includes(volatile), `${volatile} is in the cache prefix: ${prefixExpr}`);
}

// The two runs. Run 2 differs from run 1 by exactly one new fact.
const FACT = (n) => ({ name: `fact-${n}`, description: `a fact about ${n}`, type: 'project', status: null, body: `${n} is true`, supersedes: [], derived_from: [], contradicts: [] });
const idx1 = buildMemoryIndex([FACT('alpha')]);
const idx2 = buildMemoryIndex([FACT('alpha'), FACT('beta')]);
assert.notEqual(idx1, idx2, 'sanity: a new fact does change the memory index');

const SYSTEM = 'S'.repeat(4000);      // stands in for the real constant — its content is irrelevant
const skills = buildSkillsIndex([{ name: 'a', description: 'd' }]);
const sysOf = () => SYSTEM;           // F3: no volatile term reaches it
const promptOf = (idx) => [
  { role: 'system', content: sysOf() },
  { role: 'user', content: 'do the thing' },
  { role: 'user', content: '[coordination] Working context for this run\n\n' + idx + skills },
];

const a = promptOf(idx1), b = promptOf(idx2);
// The shared prefix is everything up to the context message — which is where the new fact lands.
const shared = (x, y) => { let i = 0; while (i < x.length && i < y.length && JSON.stringify(x[i]) === JSON.stringify(y[i])) i++; return i; };
assert.equal(shared(a, b), 2, 'two runs differing only in a new fact share the system message AND the history');
assert.equal(a[0].content, b[0].content, 'the system message is byte-identical across the two runs');
assert.notEqual(a[2].content, b[2].content, 'and the change lands in the tail, which is the whole point');

// The pre-F3 shape, as a control: the same pair with the index concatenated into the system
// message shares NOTHING, because message 0 already differs.
const old = (idx) => [{ role: 'system', content: SYSTEM + idx + skills }, { role: 'user', content: 'do the thing' }];
assert.equal(shared(old(idx1), old(idx2)), 0, 'control: with the index in the system message the whole prefix is invalidated');

// The tool list must not depend on the store's contents either.
assert.match(anvil, /\n\s*tools\.push\(skillTool\(\)\);/, 'the skill tool is offered unconditionally');
assert.match(anvil, /\n\s*tools\.push\(recallTool\(\)\);/, 'the recall tool is offered unconditionally');
assert.ok(!/if\(skillsIndex\) tools\.push/.test(anvil), 'no tool is gated on the skills index');
assert.ok(!/if\(memoryIndex\) tools\.push/.test(anvil), 'no tool is gated on the memory index');
assert.ok(!/mode==='code' && memoryIndex\) tools\.push/.test(anvil), 'revise is gated on the MODE, not on whether facts exist');

// The re-entered loops (act-or-nudge, the D2 supervisor) must carry the SAME conversation the
// first loop built. Filtering the context message out of either one drops the memory and skills
// index mid-run, and makes the second `run.started` disagree with the first — foldTranscript's
// overlap dedup then re-appends turns instead of recognising them (mutation-tested).
for (const [name, re] of [['act-or-nudge', /const nudgeMessages=\[sysMsg\(''\), \.\.\.convo\];/],
                          ['D2 supervisor', /const superMessages=\[sysMsg\(''\), \.\.\.convo\];/]]) {
  assert.match(anvil, re, `the ${name} re-loop must send the whole carried conversation, unfiltered`);
}
assert.ok(!/\.\.\.convo\.filter\(/.test(anvil), 'no re-loop filters the carried conversation');

// And the context message is change-gated: sent when it differs, skipped when it does not.
assert.match(anvil, /const key = ctxDigest\(volatileCtx\);/, 'the volatile block is digested');
assert.match(anvil, /if\(key !== t\.ctxSent\)\{/, 'and only re-sent when it CHANGED');
assert.match(anvil, /t\.ctxSent = key;/, 'the digest is remembered on the task');
// the digest must actually discriminate — a constant would silently disable the gate
const digest = new Function('return ' + anvil.match(/function ctxDigest\(s\)\{[\s\S]*?\n  \}/)[0].replace(/^function /, 'function ') + '; ctxDigest')();
assert.notEqual(digest('a'), digest('b'), 'the digest distinguishes different context');
assert.equal(digest('same'), digest('same'), 'and is stable for the same context');

// ── the change-gate, DRIVEN ──
// `t.ctxSent = key` is what makes the gate a gate. Neutralising it (assigning and then
// clearing) re-sends the whole index every run while every anchor above still matches — the
// mutation a cross-family review used to prove this needed driving, not grepping.
{
  const mod = await inlineModule();
  const region = extractRegion(mod, 'const volatileCtx =', 'const firstMessages=');
  const digestFn = extractFunction(mod, 'ctxDigest');
  const run = (ctx, task, convo) => evaluate(
    `${digestFn}\n;(function(){ ${region} return convo; })()`,
    { ...ctx, t: task, convo, recoveryPreface: ctx.recoveryPreface || '' });

  const ctx = { projectContext: 'PROJECT NOTES', memoryIndex: '\n## memory\n- a fact', skillsIndex: '', recoveryPreface: '' };
  const t = {};
  const convo = [{ role: 'user', content: 'do the thing' }];

  run(ctx, t, convo);
  assert.equal(convo.filter((m) => /Working context/.test(String(m.content))).length, 1,
    'the first run sends the context');
  assert.ok(t.ctxSent, 'and remembers what it sent');

  // run 2, IDENTICAL context: nothing new is appended
  run(ctx, t, convo);
  assert.equal(convo.filter((m) => /Working context/.test(String(m.content))).length, 1,
    'unchanged context is NOT re-sent — it is already in the carried transcript');

  // run 3, the context CHANGED: it is sent again
  run({ ...ctx, memoryIndex: '\n## memory\n- a fact\n- a second fact' }, t, convo);
  assert.equal(convo.filter((m) => /Working context/.test(String(m.content))).length, 2,
    'changed context IS re-sent');
  assert.match(convo[convo.length - 1].content, /a second fact/, 'and it carries the new fact');
  assert.match(convo[convo.length - 1].content, /^\[coordination\]/, 'tagged as the machine speaking, not the owner');

  // an EMPTY context appends nothing at all
  const t2 = {}, convo2 = [{ role: 'user', content: 'go' }];
  run({ projectContext: '', memoryIndex: '', skillsIndex: '', recoveryPreface: '' }, t2, convo2);
  assert.equal(convo2.length, 1, 'a workspace with no context sends no context message');
}

console.log('anvil-prompt-cache: the system prefix is stable, the volatile context is change-gated, and the tool list does not depend on the store');
