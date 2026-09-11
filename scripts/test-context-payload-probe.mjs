// AC-2's instrument, proven against records that DO carry an index.
//   node scripts/test-context-payload-probe.mjs
//
// The probe's own answer today is "no data" — not one record in the repo carried a skills or
// memory index. An instrument that has never produced a table is not an instrument, so this
// builds records that do carry one and checks the numbers come out right.
//
// The prompts here are rendered by the REAL buildSkillsIndex / buildMemoryIndex. That is the
// point: the probe parses a prompt format with a regex, so the format is a dependency. Reword
// either builder and this test goes red, which is the only warning we will get before the probe
// starts silently reporting zero.
import assert from 'node:assert/strict';
import { createRunRecorder } from '../sys/history/run-record.mjs';
import { buildSkillsIndex } from '../sys/ai/skills.mjs';
import { buildMemoryIndex } from '../sys/ai/memory-store.mjs';
import { probe, summarise } from './probe-context-payload.mjs';
import { contextMessage } from '../sys/ai/run-assembly.mjs';

const SKILLS = [
  { name: 'deploy-worker', description: 'Ship a Cloudflare Worker', status: 'active' },
  { name: 'run-the-gate', description: 'Run the full test sweep', status: 'active' },
  { name: 'never-used', description: 'A skill nothing ever calls', status: 'active' },
];
const FACTS = [
  { name: 'build-cmd', type: 'project', description: 'make test runs the gate', status: 'verified' },
  { name: 'stale-note', type: 'project', description: 'Nothing calls this one', status: 'verified' },
];

async function run({ skills = SKILLS, facts = FACTS, callSkills = [], recallFacts = [], stop = 'done', verified = false, placement = 'system' }) {
  const index = buildSkillsIndex(skills) + buildMemoryIndex(facts);
  const rec = createRunRecorder({ app: 'anvil', principal: 'probe-test' });
  // 'system': the old bed shape. 'context': the app's shape (F3) — the index rides as the tagged
  // context message after the prompt; the system message carries none of it.
  const messages = placement === 'context'
    ? [{ role: 'system', content: 'You are a coding agent.' }, { role: 'user', content: 'go' }, contextMessage(index.trim())]
    : [{ role: 'system', content: 'You are a coding agent.' + index }, { role: 'user', content: 'go' }];
  await rec.start({
    messages,
    tools: [{ type: 'function', function: { name: 'shell' } }, { type: 'function', function: { name: 'skill' } }],
  });
  let n = 0;
  for (const s of callSkills) {
    const id = `s${n++}`;
    rec.onEvent({ type: 'tool-call', id, name: 'skill', args: { name: s }, step: n });
    rec.onEvent({ type: 'tool-result', id, name: 'skill', args: { name: s }, step: n, result: 'instructions…' });
  }
  if (recallFacts.length) {
    const id = `r${n++}`;
    rec.onEvent({ type: 'tool-call', id, name: 'recall', args: { query: 'x' }, step: n });
    rec.onEvent({ type: 'tool-result', id, name: 'recall', args: { query: 'x' }, step: n,
                  result: recallFacts.map((f) => `- **${f}** (project): …`).join('\n') });
  }
  if (verified) rec.onEvent({ type: 'verify-pass', step: n, verdict: 'ok' });
  await rec.finish({ stop, steps: n, verified });
  await rec.settled();
  return rec;
}

// ── 1. the index is seen at all, and the real format parses ────────────────
{
  const rec = await run({ callSkills: ['run-the-gate'], recallFacts: ['build-cmd'], verified: true });
  const r = probe([rec]);
  assert.equal(r.eligible, 1, 'a record carrying a real index is eligible');
  assert.equal(r.noIndex, 0);
  assert.deepEqual(r.unparsed, [], 'every block heading found had parseable entries');
  // N1: the app's placement — the index in the context message, not the prefix — is read too.
  const inCtx = await run({ callSkills: ['run-the-gate'], recallFacts: ['build-cmd'], verified: true, placement: 'context' });
  const rc = probe([inCtx]);
  assert.equal(rc.eligible, 1, 'a record with the index in the app\'s context message is eligible');
  assert.equal(rc.noIndex, 0, 'it is not counted as "no index"');
  assert.ok(rc.rows.length >= 4, 'the rows name the carried items');
  assert.deepEqual(rc.rows, r.rows, 'the same index parses to the same rows from either place');
  const bare = await run({ skills: [], facts: [], placement: 'context' });
  assert.equal(probe([bare]).noIndex, 1, 'an empty context message is still no index');

  const skills = r.rows.filter((x) => x.kind === 'skill');
  assert.equal(skills.length, 3, 'all three skills were seen in context');
  assert.deepEqual(skills.filter((x) => x.used).map((x) => x.name), ['run-the-gate'], 'exactly the called skill counts as fired');
  assert.deepEqual(skills.filter((x) => !x.used).map((x) => x.name).sort(), ['deploy-worker', 'never-used']);

  const facts = r.rows.filter((x) => x.kind === 'fact');
  assert.ok(facts.length >= 2, 'facts were seen in context');
  assert.equal(facts.find((x) => x.name === 'build-cmd').used, true, 'a fact named in a recall RESULT counts as used');
  assert.equal(facts.find((x) => x.name === 'stale-note').used, false);
}

// ── 2. rules are excluded from the arithmetic, not counted as dead ─────────
// A rule is injected whole and is never called. Counting it as "never fired" would be the most
// misleading number this probe could print — it would report the rule system as pure waste.
{
  const withRule = [...FACTS, { name: 'always-run-gate', type: 'rule', description: 'Run the gate before claiming done', status: 'verified' }];
  const rec = await run({ facts: withRule, callSkills: [], recallFacts: [] });
  const r = probe([rec]);
  const rules = r.rows.filter((x) => x.kind === 'rule');
  assert.ok(rules.length >= 1, 'the rule block was parsed');
  assert.ok(rules.every((x) => x.used === null), 'a rule is unattributable — null, not false');
  const s = summarise(r.rows);
  const counted = s.flatMap((g) => Object.values(g.byLabel)).reduce((a, v) => a + v.inContext, 0);
  assert.equal(counted, r.rows.filter((x) => x.used !== null).length, 'rules never enter the summary arithmetic');
}

// ── 3. the number AC-2 actually asks for ──────────────────────────────────
// Two runs in one class: one that used what it carried, one that carried the same index and used
// none of it. The dead-weight share must separate them, and it must split by outcome — because the
// claim under test is "carrying dead weight correlates with doing worse", not "dead weight exists".
{
  const good = await run({ callSkills: ['deploy-worker', 'run-the-gate'], recallFacts: ['build-cmd', 'stale-note'], verified: true });
  const bad1 = await run({ callSkills: [], recallFacts: [], stop: 'max-steps' });
  const bad2 = await run({ callSkills: [], recallFacts: [], stop: 'max-steps' });
  const r = probe([good, bad1, bad2]);
  assert.equal(r.eligible, 3);
  const [g] = summarise(r.rows);
  assert.ok(g.byLabel.success, 'the gated run is labelled success');
  assert.ok(g.byLabel.failure, 'the max-steps runs are labelled failure');
  // The good run carries 3 skills + 2 facts and fires 4 of them — `never-used` is in context and
  // never called, which is precisely the dead weight AC-2 is about. 1 - 4/5 = 0.2.
  assert.equal(g.byLabel.success.inContext, 5);
  assert.equal(g.byLabel.success.fired, 4);
  assert.equal(g.byLabel.success.deadShare, 0.2, 'one carried-but-unused item out of five');
  assert.equal(g.byLabel.failure.inContext, 10, 'two failing runs carried the same five items each');
  assert.equal(g.byLabel.failure.fired, 0);
  assert.equal(g.byLabel.failure.deadShare, 1, 'the failing runs used none of what they carried');
  assert.ok(g.byLabel.failure.deadShare > g.byLabel.success.deadShare,
    'this ordering IS the AC-2 question — the probe can express it, which is all this test claims');
}

// ── 4. a record with no index is reported, never silently skipped ──────────
{
  const rec = await run({ skills: [], facts: [] });
  const r = probe([rec]);
  assert.equal(r.eligible, 0);
  assert.equal(r.noIndex, 1, 'a run with an empty index is counted as no-index, and said so');
  assert.equal(r.rows.length, 0);
}

// ── 5. summarising nothing yields nothing, not a zero ─────────────────────
assert.deepEqual(summarise([]), [], 'no observations produces no rows — never a table over zero');

console.log('context-payload probe: real index format parses, rules excluded, dead-share splits by outcome');
