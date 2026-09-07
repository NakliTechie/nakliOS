// Conformance — progressive-disclosure skills (pure).
//   node sys/ai/test/skills.test.mjs
import { parseSkill, buildSkillsIndex, skillTool, SKILLS_DIR, explainSkillsRefusal, underSkillsDir } from '../skills.mjs';

let passed = 0;
const failures = [];
async function test(name, fn){ try { await fn(); passed++; } catch (e){ failures.push({ name, message: e.message }); } }
function assert(c, m){ if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m){ if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

await test('parseSkill: frontmatter + body', () => {
  const sk = parseSkill('---\nname: deploy\ndescription: Ship the app to prod\n---\nStep 1. do X\nStep 2. do Y');
  eq(sk.name, 'deploy', 'name');
  eq(sk.description, 'Ship the app to prod', 'description');
  assert(sk.body.includes('Step 1. do X') && sk.body.includes('Step 2. do Y'), 'body');
  assert(!sk.body.includes('name:'), 'body excludes frontmatter');
});

await test('parseSkill: quoted values + case-insensitive keys', () => {
  const sk = parseSkill('---\nName: "test-suite"\nDESCRIPTION: \'Run the tests\'\n---\nbody');
  eq(sk.name, 'test-suite', 'unquoted name');
  eq(sk.description, 'Run the tests', 'unquoted description');
});

await test('parseSkill: no frontmatter → whole text is body', () => {
  const sk = parseSkill('just instructions, no frontmatter');
  eq(sk.name, '', 'empty name');
  eq(sk.description, '', 'empty description');
  eq(sk.body, 'just instructions, no frontmatter', 'body is the text');
});

await test('parseSkill: empty/nullish is safe', () => {
  eq(parseSkill('').name, '', 'empty');
  eq(parseSkill(null).body, '', 'null body');
});

await test('buildSkillsIndex: empty when no named skills', () => {
  eq(buildSkillsIndex([]), '', 'empty array');
  eq(buildSkillsIndex([{ description: 'x' }]), '', 'no name → skipped');
  eq(buildSkillsIndex(null), '', 'null');
});

await test('buildSkillsIndex: lists names + descriptions, mentions the skill tool', () => {
  const out = buildSkillsIndex([
    { name: 'deploy', description: 'Ship to prod' },
    { name: 'review', description: 'Review a diff\nthoroughly' },
  ]);
  assert(out.includes('# Skills'), 'header');
  assert(out.includes('**deploy**: Ship to prod'), 'deploy line');
  assert(out.includes('**review**: Review a diff thoroughly'), 'review line, whitespace flattened');
  assert(/`skill` tool/.test(out), 'tells the agent to use the skill tool');
});

await test('buildSkillsIndex: skips unnamed, keeps named', () => {
  const out = buildSkillsIndex([{ name: 'a', description: '1' }, { description: 'orphan' }, { name: 'b', description: '2' }]);
  assert(out.includes('**a**') && out.includes('**b**'), 'named kept');
  assert(!out.includes('orphan'), 'unnamed dropped');
});

await test('skillTool: well-formed schema', () => {
  const t = skillTool();
  eq(t.type, 'function', 'type');
  eq(t.function.name, 'skill', 'name');
  assert(t.function.parameters.properties.name, 'name param');
  assert(t.function.parameters.required.includes('name'), 'name required');
});

await test('SKILLS_DIR is the workspace convention', () => {
  eq(SKILLS_DIR, '.anvil/skills', 'dir');
});

// ───────────────────────── the shell half of the skills fence (NAF-01) ──

await test('explainSkillsRefusal names the door on a skills-dir refusal, and touches nothing else', () => {
  const refusal = 'fs.write: EGRANT: path is read-only under this grant: .anvil/skills/y/SKILL.md';
  const out = explainSkillsRefusal(refusal);
  assert(out.startsWith(refusal), 'the original refusal is preserved verbatim');
  assert(/skill_manage/.test(out), `it names the door: ${out}`);
  assert(/status: active/.test(out), 'and says who may activate');
  // it ANNOTATES, never refuses: anything that is not that refusal comes back unchanged
  for (const other of [
    'ok',
    '',
    'fs.write: EGRANT: path outside grant: ../../etc/passwd',
    'fs.write: EGRANT: path is read-only under this grant: .anvil/skills-backup/y.md',
    'fs.write: EGRANT: path is read-only under this grant: vendor/lib.js',
    'grep: no matches',
  ]) {
    eq(explainSkillsRefusal(other), other, `wrongly annotated: ${JSON.stringify(other)}`);
  }
  eq(explainSkillsRefusal(null), '', 'a null result is a string, not a crash');
  // a SUCCESS that merely mentions the path is untouched — the trigger is the refusal wording
  const catOut = 'name: demo\ndescription: reads .anvil/skills/y/SKILL.md';
  eq(explainSkillsRefusal(catOut), catOut, 'reading a skill is not annotated as a refusal');
});

await test('underSkillsDir matches on path segments, not substrings', () => {
  assert(underSkillsDir('.anvil/skills/a/SKILL.md'), 'a file inside');
  assert(underSkillsDir('.anvil/skills'), 'the dir itself');
  assert(underSkillsDir('./.anvil/skills/a'), 'a leading ./');
  assert(underSkillsDir('/.anvil/skills/a'), 'a leading /');
  assert(!underSkillsDir('.anvil/skills-backup/a'), 'a sibling with a longer name is NOT inside');
  assert(!underSkillsDir('.anvil'), 'the parent is not inside');
  assert(!underSkillsDir('src/.anvil/skills/a'), 'a nested lookalike is not the project skills dir');
  assert(!underSkillsDir(''), 'empty');
});

if (failures.length){
  console.error(`skills: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`skills conformance: ${passed}/${passed} passed`);
