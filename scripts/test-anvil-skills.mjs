// Guards the skill_manage seam in Anvil (C1): the agent can write its own skills only
// through a plan that enforces read-before-write and a Sentinel scan, every write is a
// P0 envelope, and a staged or quarantined skill never reaches the injected index.
// Grep-based, like the other app-contract tests. Pins the seam, not the shape.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSkillsIndex, parseSkill, skillsShellRefusal } from '../sys/ai/skills.mjs';

const anvil = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');

assert.match(anvil, /import \{[^}]*\bplanSkillWrite\b[^}]*\} from '\.\.\/\.\.\/sys\/ai\/skill-manage\.mjs'/, 'Anvil imports the skill-manage plan');
assert.match(anvil, /registerAppDiffTypes\(\['anvil'\]\)/, 'the anvil-skill diff type is registered in Anvil\'s realm');
assert.match(anvil, /const skillSession=createSkillSession\(\);/, 'one read-session per run');
assert.match(anvil, /skillSession\.noteRead\(name\)/, 'the skill tool records a read');
assert.match(anvil, /planSkillWrite\(ar\|\|\{\}, \{ existing, existingFiles, session: skillSession, now: new Date\(\)\.toISOString\(\) \}\)/, 'skill_manage plans with the session (read-before-write), the folder\'s support files, and a stamp');
assert.match(anvil, /makeEnvelope\(\{ app:'anvil', tool:'skill_manage', diff: plan\.diff/, 'every skill write is a P0 envelope');
assert.match(anvil, /if\(mode==='code'\) tools\.push\(skillManageTool\(\)\);/, 'skill_manage is offered in code mode');
assert.match(anvil, /nm==='skill_manage'\)\)\{/, 'skill_manage is refused outside code mode');
// shape, not signature: the push also carries the pinned/created/updated stamps the lifecycle reads
assert.match(anvil, /metas\.push\(\{ name, description: sk\.description, status: sk\.status/, 'the index push carries status (a staged skill must not bind)');
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
const shellGuard = anvil.indexOf('skillsShellRefusal(String(ar.command))');
const fileGuard = anvil.indexOf("['write','edit','apply_patch','edit_lines','remove','move'].includes(nm)");
const exec = anvil.indexOf('const res = await baseExec(nm, ar, callObj)');
assert.ok(shellGuard > 0, 'the shell path is fenced out of the skills dir');
assert.ok(fileGuard > 0, 'the file tools are fenced out of the skills dir');
assert.ok(exec > 0, 'the tool executor is where both guards must precede');
assert.ok(shellGuard < exec, 'the shell fence runs BEFORE the shell command reaches the executor');
assert.ok(fileGuard < exec, 'the file fence runs BEFORE the write reaches the executor');
assert.match(anvil, /import \{[^}]*skillsShellRefusal[^}]*\} from '\.\.\/\.\.\/sys\/ai\/skills\.mjs'/, 'the refusal comes from the module, not a copy of the rule in the app');
// and the module actually refuses the shape the app was open to
assert.ok(skillsShellRefusal('echo x > .anvil/skills/y/SKILL.md'), 'the exact bypass NAF-01 left open is now refused');
assert.equal(skillsShellRefusal('cat .anvil/skills/y/SKILL.md'), null, 'reading a skill from the shell still runs');

console.log('anvil-skills: skill writes are planned, scanned, staged through P0, and never injected until activated');
