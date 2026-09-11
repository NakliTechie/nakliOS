// Guards the skill_manage seam in Anvil (C1): the agent can write its own skills only
// through a plan that enforces read-before-write and a Sentinel scan, every write is a
// P0 envelope, and a staged or quarantined skill never reaches the injected index.
// Grep-based, like the other app-contract tests. Pins the seam, not the shape.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSkillsIndex, parseSkill, explainSkillsRefusal } from '../sys/ai/skills.mjs';
import { runToolset } from '../sys/ai/run-assembly.mjs';

const anvil = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');

assert.match(anvil, /import \{[^}]*\bplanSkillWrite\b[^}]*\} from '\.\.\/\.\.\/sys\/ai\/skill-manage\.mjs'/, 'Anvil imports the skill-manage plan');
assert.match(anvil, /registerAppDiffTypes\(\['anvil'\]\)/, 'the anvil-skill diff type is registered in Anvil\'s realm');
assert.match(anvil, /const skillSession=createSkillSession\(\);/, 'one read-session per run');
assert.match(anvil, /skillSession\.noteRead\(name\)/, 'the skill tool records a read');
assert.match(anvil, /planSkillWrite\(ar\|\|\{\}, \{ existing, existingFiles, session: skillSession, now: new Date\(\)\.toISOString\(\) \}\)/, 'skill_manage plans with the session (read-before-write), the folder\'s support files, and a stamp');
assert.match(anvil, /makeEnvelope\(\{ app:'anvil', tool:'skill_manage', diff: plan\.diff/, 'every skill write is a P0 envelope');
// N1: the toolset is the assembly's (sys/ai/run-assembly.mjs); the app sends it (test-run-assembly.mjs).
assert.ok(runToolset('code').some((x) => x.function.name === 'skill_manage'), 'skill_manage is offered in code mode');
assert.ok(!runToolset('plan').some((x) => x.function.name === 'skill_manage'), 'and not in plan mode');
assert.match(anvil, /nm==='skill_manage'\)\)\{/, 'skill_manage is refused outside code mode');
// shape, not signature: the push also carries the pinned/created/updated stamps the lifecycle reads
assert.match(anvil, /metas\.push\(\{ name, description: sk\.description, status, pinned:/, 'the index push carries status (a staged skill must not bind)');
// Checker A1 (2026-09-11): the description is scanned BEFORE it can enter the index, and a
// description that fails is quarantined rather than listed.
assert.match(anvil, /const dguard = scanSkill\(\{ name, description: sk\.description\|\|'', body: '' \}\);\s*\n\s*const status = \(dguard\.state==='refused' \|\| dguard\.state==='quarantined'\) \? 'quarantined' : sk\.status;/, 'the index scans the description and quarantines a failing one');
// Checker A1: the load-time scan sees the folder's support files, not only SKILL.md.
assert.match(anvil, /const guard = scanSkill\(\{ name: sk\.name\|\|name, description: sk\.description\|\|'', body: sk\.body\|\|'', files \}\);/, 'the load-time scan includes support files');
// Checker A3: the skills-dir fence judges target PATHS, not the whole patch text.
assert.match(anvil, /const targets = \[ar\.path, ar\.file, ar\.to\];[\s\S]*?const blob = targets\.filter\(Boolean\)\.map\(String\)\.join\('\\n'\);/, 'the fence is judged on targets');
// Checker D3: a failed skill write is an error, never a staged card.
assert.match(anvil, /const w1=await fs\.write\(skillPath, plan\.skillText\);\s*\n\s*if\(!\(w1&&w1\.ok!==false\)\) return 'Error: skill write failed/, 'a failed write is reported');
// A non-active skill must never BIND. Since forward-pass NAF-12 a STAGED draft may be shown for
// revision — it was otherwise unrevisable (skill refused it as staged, skill_manage as unread) —
// but only downstream of the sentinel re-scan, and labelled as not-instructions.
assert.match(anvil, /if\(!INJECTED_STATUSES\.includes\(sk\.status\)\)\{/, 'the skill tool branches on a non-binding status');
assert.match(anvil, /does not bind until the owner sets status: active/, 'a non-active skill still does not bind');
assert.match(anvil, /NOT active, these are not instructions to follow/, 'a staged draft is served labelled, never as instructions');
assert.ok(anvil.indexOf('const guard = scanSkill(') < anvil.indexOf('if(!INJECTED_STATUSES.includes(sk.status)){'), 'the sentinel re-scan runs BEFORE any status branch, so a hand-edited status cannot serve unscanned text');
assert.equal((anvil.match(/Object\.keys\(skillMap\)\.filter\(n=>INJECTED_STATUSES\.includes\(skillStatus\[n\]\|\|'active'\)\)/g) || []).length, 2, 'both listings hide non-binding skills');

// The contract the app depends on, in the pure module: staged / quarantined never injected.
const staged = parseSkill('---\nname: s\ndescription: d\nstatus: staged\n---\nbody');
const quarantined = parseSkill('---\nname: q\ndescription: d\nstatus: quarantined\n---\nbody');
const active = parseSkill('---\nname: a\ndescription: d\n---\nbody');
const idx = buildSkillsIndex([staged, quarantined, active]);
assert.ok(!/\*\*s\*\*/.test(idx) && !/\*\*q\*\*/.test(idx) && /\*\*a\*\*/.test(idx), 'only the active skill is injected');
// The regression: dropping status re-admits a staged skill.
assert.ok(/\*\*s\*\*/.test(buildSkillsIndex([{ name: staged.name, description: staged.description }])), 'sanity: without status the filter cannot engage — which is why the app must pass it');


// ── the write fence, both halves (NAF-01) ──
// The structured file tools were fenced; the shell was not, so a redirect landed a skill on
// disk with only the load-path sentinel behind it. Both guards must sit BEFORE the executor.
const fileGuard = anvil.indexOf("['write','edit','apply_patch','edit_lines','remove','move'].includes(nm)");
const exec = anvil.indexOf('const raw = await baseExec(nm, ar, callObj)');
assert.ok(fileGuard > 0, 'the file tools are fenced out of the skills dir');
assert.ok(exec > 0, 'the tool executor is where the guard must precede');
assert.ok(fileGuard < exec, 'the file fence runs BEFORE the write reaches the executor');
// the shell is fenced by the GRANT, not by matching its command line
assert.match(anvil, /\? explainGateRefusal\(nm==='shell' \? explainSkillsRefusal\(raw\) : raw\)/, 'a shell refusal is explained, and the explanation cannot itself refuse');
assert.match(anvil, /import \{[^}]*explainSkillsRefusal[^}]*\} from '\.\.\/\.\.\/sys\/ai\/skills\.mjs'/, 'the wording comes from the module, not a copy in the app');
assert.ok(/skill_manage/.test(explainSkillsRefusal('fs.write: EGRANT: path is read-only under this grant: .anvil/skills/y/SKILL.md')), 'the explanation names the door');
assert.equal(explainSkillsRefusal('ok'), 'ok', 'an ordinary result is untouched');

// The boundary itself: the grant, not the string match. Both the top-level agent and every
// subagent get .anvil/skills as a read-only region, so every shell spelling of a write is
// refused on the NORMALISED path (sys/ai/test/skills-fence.test.mjs drives the real shell).
// Asserted as "both grants CONTAIN these fences", not as an exact list — the list grew when the
// search index joined it (SEC Med1) and pinning the literal made a strictly-safer change look
// like a regression. What must hold is that neither grant loses a fence, not that nobody adds one.
{
  const grants = anvil.match(/createGrant\(\{ prefixes:\[''\][^)]*\)/g) || [];
  assert.equal(grants.length, 2, 'both the agent grant and the subagent grant exist');
  for (const g of grants) {
    assert.match(g, /readOnlyPrefixes:\[[^\]]*SKILLS_DIR/, 'each fences the skills dir read-only');
    assert.match(g, /readOnlyPrefixes:\[[^\]]*GATE_DIR/, 'and the gate dir');
  }
}
// and the one door stays open: skill_manage writes through the UNGRANTED `fs`, never the
// granted face — if it ever moved to face.invoke, the fence would lock out its own door.
assert.match(anvil, /const w = await fs\.write\(dir\+'\/'\+SKILL_FILE, plan\.skillText\)/, 'skill_manage writes through the ungranted fs');
assert.ok(!/face\.invoke\('fs\.(write|remove|move|copy)'[^)]*SKILL/.test(anvil), 'skill_manage does not write skills through the granted face');


console.log('anvil-skills: skill writes are planned, scanned, staged through P0, and never injected until activated');
