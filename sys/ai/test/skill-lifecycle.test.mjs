// Conformance — skill usage as a fold + the curator's lifecycle (C4).
//   node sys/ai/test/skill-lifecycle.test.mjs
import { skillLifecycle, reviveOnUse, applySkillStatus, dedupeSkills, STALE_AFTER_DAYS, ARCHIVE_AFTER_DAYS } from '../skill-lifecycle.mjs';
import { parseSkill, buildSkillsIndex } from '../skills.mjs';
import { foldSkillUsage, createRunRecorder } from '../../history/run-record.mjs';
import { runAgentLoop } from '../agent-loop.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
const DAY = 86_400_000; const T0 = Date.parse('2026-09-06T00:00:00Z');
const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const S = (name, extra = {}) => ({ name, description: `${name} desc`, status: 'active', pinned: false, created: null, updated: null, body: 'b', ...extra });

// A recorded run whose scripted model loads the given skills (deliberate `skill` calls).
async function runLoading(names, at) {
  const rec = createRunRecorder({ app: 'anvil', principal: 'p', now: () => at });
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }];
  await rec.start({ messages: msgs, tools: [] });
  let i = 0;
  const infer = rec.wrapInfer(async () => (i < names.length ? { content: '', toolCalls: [call('skill', { name: names[i] }, 'k' + (i++))] } : { content: 'done', toolCalls: [] }));
  const result = await runAgentLoop({ messages: msgs, tools: [], infer, executeTool: async (n, a) => `Skill: ${a.name}`, onEvent: rec.onEvent });
  await rec.finish(result); await rec.settled();
  return rec;
}

await test('foldSkillUsage: deliberate `skill` loads per run — views, distinct runs, last/first used; injection never counts', async () => {
  const a = await runLoading(['deploy', 'deploy', 'test'], T0 - 5 * DAY);
  const b = await runLoading(['deploy'], T0 - 2 * DAY);
  const none = await runLoading([], T0); // its index may have injected every skill — no calls, no usage
  const u = foldSkillUsage([a, b, none, a]);
  const d = u.get('deploy'); eq(d.views, 3, 'three loads'); eq(d.runs, 2, 'two distinct runs (the duplicate record counts once)'); eq(d.lastUsed, T0 - 2 * DAY, 'last used'); eq(d.firstUsed, T0 - 5 * DAY, 'first used');
  eq(u.get('test').runs, 1, 'test in one run'); assert(!u.has('never'), 'an unloaded skill has no usage');
  eq(foldSkillUsage([none]).size, 0, 'a run with no skill calls contributes nothing');
});

await test('lifecycle: active → stale at 30 days unused → archived at 90; pinned exempt; staged/quarantined/archived untouched', async () => {
  const usage = foldSkillUsage([await runLoading(['fresh'], T0 - 1 * DAY), await runLoading(['aging'], T0 - 45 * DAY), await runLoading(['old'], T0 - 100 * DAY)]);
  const skills = [S('fresh'), S('aging'), S('old'), S('pinned-old', { pinned: true }), S('staged-old', { status: 'staged', created: '2026-01-01' }), S('q', { status: 'quarantined', created: '2026-01-01' }), S('gone', { status: 'archived', created: '2026-01-01' }),
    S('never-recent', { created: new Date(T0 - 10 * DAY).toISOString() }), S('never-old', { updated: new Date(T0 - 40 * DAY).toISOString() }), S('never-ancient', { created: new Date(T0 - 200 * DAY).toISOString() }), S('no-stamp')];
  const p = skillLifecycle(skills, usage, { now: T0 });
  const by = Object.fromEntries(p.map((x) => [x.name, x]));
  assert(!by.fresh, 'used yesterday stays active');
  eq(by.aging?.to, 'stale', 'unused 45 days → stale'); eq(by.aging.from, 'active', 'from active'); eq(by.aging.unusedDays, 45, 'days counted');
  eq(by.old?.to, 'archived', 'unused 100 days → archived');
  assert(!by['pinned-old'] && !by['staged-old'] && !by.q && !by.gone, 'pinned, staged, quarantined and archived are left alone');
  assert(!by['never-recent'], 'never used but written 10 days ago stays active');
  eq(by['never-old']?.to, 'stale', 'never used, written 40 days ago → stale (from the updated stamp)');
  eq(by['never-ancient']?.to, 'archived', 'never used, written 200 days ago → archived');
  assert(!by['no-stamp'], 'no stamp, no usage → grace: an unknown age is not an old age');
  eq(STALE_AFTER_DAYS, 30, 'stale'); eq(ARCHIVE_AFTER_DAYS, 90, 'archive');
  // a hand edit is a relevance signal: used 100 days ago but edited 5 days ago stays active
  eq(skillLifecycle([S('edited', { updated: new Date(T0 - 5 * DAY).toISOString() })], foldSkillUsage([await runLoading(['edited'], T0 - 100 * DAY)]), { now: T0 }).length, 0, 'the newer of use and edit anchors the age');
  let noClock = null; try { skillLifecycle(skills, usage, {}); } catch (e) { noClock = e; } assert(noClock && /needs a clock/.test(noClock.message), 'no clock → throw, never a silent no-op');
  // forward only: a stale skill is not re-activated by the curator (use revives it, below)
  eq(skillLifecycle([S('s', { status: 'stale' })], foldSkillUsage([await runLoading(['s'], T0)]), { now: T0 }).length, 0, 'the curator never moves stale back to active');
  eq(skillLifecycle([S('s', { status: 'stale', updated: new Date(T0 - 95 * DAY).toISOString() })], new Map(), { now: T0 })[0]?.to, 'archived', 'stale → archived when the clock runs out');
});

await test('applySkillStatus / reviveOnUse rewrite the file; an archived skill is NOT injected, a stale one is (tagged)', () => {
  const text = '---\nname: deploy\ndescription: how to deploy\n---\nRun make ship.';
  const stale = applySkillStatus(text, 'stale', { now: '2026-09-06T00:00:00.000Z' });
  eq(parseSkill(stale).status, 'stale', 'stale written'); eq(parseSkill(stale).updated, '2026-09-06T00:00:00.000Z', 'stamped');
  const archived = applySkillStatus(stale, 'archived'); eq(parseSkill(archived).status, 'archived', 'archived written'); assert(archived.includes('Run make ship.'), 'the body is kept — never deleted');
  const idx = buildSkillsIndex([parseSkill(stale), parseSkill(archived).name === 'deploy' ? { ...parseSkill(archived), name: 'deploy-archived' } : null, parseSkill(text)].filter(Boolean).map((s, i) => ({ ...s, name: s.name + (i === 0 ? '-stale' : '') })));
  assert(/\*\*deploy-stale\*\*.*_\(stale/.test(idx), 'a stale skill is injected, tagged'); assert(!/deploy-archived/.test(idx), 'an archived skill is not injected');
  const revived = reviveOnUse(stale, { now: '2026-09-07T00:00:00.000Z' }); eq(parseSkill(revived).status, 'active', 'a deliberate load revives a stale skill');
  eq(reviveOnUse(text), null, 'an active skill needs no revival'); eq(reviveOnUse(archived), null, 'an archived skill is not revived by use — a person restores it');
  let err = null; try { applySkillStatus(text, 'deleted'); } catch (e) { err = e; } assert(err && /unknown skill status/.test(err.message), 'an unknown status is refused, never written (parseSkill would coerce it to active)');
  eq(parseSkill(applySkillStatus(text, 'stale', { now: T0 })).updated, new Date(T0).toISOString(), 'a numeric clock is written as an ISO stamp');
  eq(parseSkill(applySkillStatus(text, 'stale', { now: 'garbage' })).updated, null, 'an unparseable clock writes no stamp');
});

await test('dedupeSkills: same normalised description → one keep (pinned wins, else the oldest), the rest proposed for archive; never a deletion', () => {
  const g = dedupeSkills([S('a', { description: 'Deploy the app!', created: '2026-03-01' }), S('b', { description: 'deploy the app', created: '2026-01-01' }), S('c', { description: 'DEPLOY, the app', created: '2026-05-01', pinned: true }), S('d', { description: 'run tests' }), S('e', { description: 'deploy the app', status: 'archived' })]);
  eq(g.length, 1, 'one group'); eq(g[0].keep, 'c', 'pinned wins'); eq(g[0].drop.sort().join(','), 'a,b', 'the others are proposals, not deletions');
  const g2 = dedupeSkills([S('a', { description: 'x y', created: '2026-03-01' }), S('b', { description: 'x  y.', created: '2026-01-01' })]); eq(g2[0].keep, 'b', 'else the oldest keeps');
  eq(dedupeSkills([S('a', { description: '' }), S('b', { description: '' })]).length, 0, 'empty descriptions do not group');
});

await test('NAF-18: an automatic transition does not reset the clock that drives aging', () => {
  const DAY = 86400000, t0 = Date.parse('2026-01-01T00:00:00Z');
  const file = (updated) => `---\nname: old\nstatus: active\ndescription: d\nupdated: ${new Date(updated).toISOString()}\n---\nbody`;
  // never used, written on day 0. At day 31 the curator proposes stale and APPLIES it.
  const staled = applySkillStatus(file(t0), 'stale', { now: t0 + 31 * DAY, automatic: true });
  // at day 91 it must archive — the automatic stale must not have bought it another 30 days
  eq(/status:\s*(\S+)/.exec(staled)?.[1], 'stale', 'the requested status is what got written');
  const parsed = { name: 'old', status: 'stale', updated: /updated:\s*(\S+)/.exec(staled)?.[1] || null, pinned: false };
  const props = skillLifecycle([parsed], new Map(), { now: t0 + 91 * DAY });
  const p = props.find((x) => x.name === 'old');
  assert(p && p.to === 'archived', `a never-used skill archives at 90 days, got ${JSON.stringify(props)}`);
  // an OWNER edit is still a relevance signal and does reset it
  const edited = applySkillStatus(file(t0), 'active', { now: t0 + 31 * DAY });
  assert(/2026-02-01/.test(edited), `a hand edit still stamps updated: ${edited.slice(0, 120)}`);
});

if (failures.length) { console.error(`skill-lifecycle: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`); process.exit(1); }
console.log(`skill-lifecycle conformance: ${passed}/${passed} passed — usage fold (deliberate loads only), 30/90-day aging, pinned exempt, never deletes, dedupe proposals`);
