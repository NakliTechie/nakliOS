// Conformance — .anvil/skills is READABLE and UNWRITABLE from every agent route.
//   node sys/ai/test/skills-fence.test.mjs
//
// A file under .anvil/skills decides what instructions bind, and skill_manage — which scans a
// skill through the sentinel before it can bind — is the one door. The app refused the
// structured file tools by matching the path, and NAF-01's second half was that the shell was
// not covered: `echo x > .anvil/skills/y/SKILL.md` landed on disk.
//
// A string match on the command line cannot close that. The shell resolves `..`, expands
// variables, honours `cd`, and accepts the registry's dotted verbs (`fs.write`, `fs.remove`),
// so the same write has many spellings. The boundary therefore lives in the GRANT, on the
// NORMALISED path, where every spelling has already collapsed to one string. This suite drives
// the REAL shell over a real granted face and proves it — including that reading still works,
// because a fence that blocks ordinary reading gets turned off.
import { createShell } from '../../rig/cli/shell.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../rig/agent/index.mjs';
import { SKILLS_DIR, explainSkillsRefusal } from '../skills.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

async function shell() {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });            // the ungranted edge — skill_manage's door
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({
    prefixes: [''],
    scopes: ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write'],
    readOnlyPrefixes: [SKILLS_DIR],
  });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'a' });
  const sh = createShell({ registry, face });
  const run = async (c) => { const r = await sh.feed(c); return { out: String(r.output || '').trim(), code: sh.lastCode }; };
  // a skill already on disk, written through the ungranted edge exactly as skill_manage does
  await fs.write(SKILLS_DIR + '/demo/SKILL.md', '---\nname: demo\ndescription: d\nstatus: staged\n---\nbody');
  await fs.write('notes.md', 'ORIGINAL\n');
  return { sh, run, fs };
}
const read = async (fs, p) => { const r = await fs.read(p, { encoding: 'utf-8' }); return r && r.ok ? r.data : null; };

await test('every shell spelling of a write into the skills dir is refused, and the file is unchanged', async () => {
  const { fs } = await shell();
  const before = await read(fs, SKILLS_DIR + '/demo/SKILL.md');
  const attempts = [
    'echo PWNED > .anvil/skills/demo/SKILL.md',
    'echo PWNED >> .anvil/skills/demo/SKILL.md',
    'echo PWNED > ./.anvil/skills/demo/SKILL.md',
    'echo PWNED > .anvil/skills/new/SKILL.md',
    // the routes a command-line matcher misses:
    'fs.write .anvil/skills/demo/SKILL.md --data PWNED', // the registry's dotted verb
    'echo PWNED > .anvil/hooks/../skills/demo/SKILL.md', // .. traversal back into the dir
    'D=.anvil/skills; echo PWNED > $D/demo/SKILL.md',    // the path arrives via a variable
    'cd .anvil && echo PWNED > skills/demo/SKILL.md',    // relative to another cwd
    'rm .anvil/skills/demo/SKILL.md',
    'rm -r .anvil/skills',
    'mv notes.md .anvil/skills/demo/SKILL.md',
    'cp notes.md .anvil/skills/demo/SKILL.md',   // copying IN is a write; copying OUT is not (below)
    'mkdir .anvil/skills/sneaky',
  ];
  // A FRESH shell per attempt: `cd` persists, and a shared shell would judge later
  // attempts from the wrong working directory (which is itself the reason the boundary
  // cannot live in a string match on the command line).
  for (const cmd of attempts) {
    const s = await shell();
    const r = await s.run(cmd);
    assert(r.code !== 0, `NOT refused (exit ${r.code}): ${cmd} → ${r.out}`);
    assert(/read-only under this grant/.test(r.out), `refused, but not by the fence — check the reason: ${cmd} → ${r.out}`);
    eq(await read(s.fs, SKILLS_DIR + '/demo/SKILL.md'), before, `the skill changed despite the refusal: ${cmd}`);
  }
  eq(await read(fs, SKILLS_DIR + '/new/SKILL.md'), null, 'no new skill was created');
  eq(await read(fs, 'notes.md'), 'ORIGINAL\n', 'the mv source was not consumed by a refused move');
});

await test('reading a skill from the shell still works — the fence blocks writes, not the directory', async () => {
  const { run } = await shell();
  const cat = await run('cat .anvil/skills/demo/SKILL.md');
  eq(cat.code, 0, `cat was refused: ${cat.out}`);
  assert(/name: demo/.test(cat.out), `cat returned nothing useful: ${cat.out}`);
  const ls = await run('ls .anvil/skills');
  eq(ls.code, 0, `ls was refused: ${ls.out}`);
  assert(/demo/.test(ls.out), `ls did not list the skill: ${ls.out}`);
  const grep = await run('grep description .anvil/skills/demo/SKILL.md');
  eq(grep.code, 0, `grep was refused: ${grep.out}`);
  assert(/description: d/.test(grep.out), `grep found nothing: ${grep.out}`);
});

await test('writes everywhere else are untouched — the fence is a region, not a mood', async () => {
  const { run, fs } = await shell();
  for (const cmd of ['echo NEW > notes.md', 'mkdir src', 'echo x > .anvil/hooks.json',
                     'echo x > .anvil/skills-backup/y.md', 'fs.write other.md --data hello']) {
    const r = await run(cmd);
    eq(r.code, 0, `wrongly refused: ${cmd} → ${r.out}`);
  }
  eq(await read(fs, 'notes.md'), 'NEW\n', 'an ordinary write still lands');
  assert(await read(fs, '.anvil/skills-backup/y.md'), 'an adjacent directory with a longer name is NOT inside the fence');
});

await test('skill_manage keeps its door: the UNGRANTED edge still writes the skill', async () => {
  const { fs } = await shell();
  const w = await fs.write(SKILLS_DIR + '/fresh/SKILL.md', 'planned by skill_manage');
  assert(w && w.ok, `the one door is closed too — skill_manage cannot write: ${JSON.stringify(w)}`);
  eq(await read(fs, SKILLS_DIR + '/fresh/SKILL.md'), 'planned by skill_manage', 'and the content lands');
});

await test('the model is told where to go instead — the explanation rides on the grant\'s refusal', async () => {
  // The string-matching pre-check this replaced was both leaky and over-eager (a cross-family
  // review found it refusing `echo "…"` that merely QUOTED the path, a `#` comment naming it,
  // and `cp` copying a skill OUT). The grant refuses; this only adds the sentence.
  const s = await shell();
  const r = await s.run('echo PWNED > .anvil/skills/demo/SKILL.md');
  assert(r.code !== 0, 'the grant refused it');
  const explained = explainSkillsRefusal(r.out);
  assert(/skill_manage/.test(explained), `the model is told the door: ${explained}`);
  assert(explained.startsWith(r.out), 'the grant\'s own words are kept');

  // and the cases the old matcher got WRONG all run now, unrefused and unannotated
  for (const cmd of [
    'echo "ok; touch .anvil/skills/demo/SKILL.md"',   // the path is inside a quoted string
    'echo ok # > .anvil/skills/demo/SKILL.md',        // ...inside a comment
    'cp .anvil/skills/demo/SKILL.md backup.md',       // copying a skill OUT is a read
    'echo x > .anvil/skills/../../notes.md',          // resolves OUTSIDE the fence
  ]) {
    const f = await shell();
    const out = await f.run(cmd);
    eq(out.code, 0, `a legitimate command was refused: ${cmd} → ${out.out}`);
    eq(explainSkillsRefusal(out.out), out.out, `a legitimate command was annotated as a refusal: ${cmd}`);
  }
});

await test('a move OUT is refused too — a move deletes what it takes (fs.copy declares its source, fs.move does not)', async () => {
  const s = await shell();
  const r = await s.run('mv .anvil/skills/demo/SKILL.md stolen.md');
  assert(r.code !== 0, `a skill was moved out of the fence: ${r.out}`);
  assert(/read-only under this grant/.test(r.out), `refused for the wrong reason: ${r.out}`);
  eq(await read(s.fs, SKILLS_DIR + '/demo/SKILL.md') !== null, true, 'the skill is still there');
  // the CONTROL: the same shape of command with cp succeeds, so the refusal is about the
  // DELETE, not about touching the directory at all
  const c = await shell();
  const ok = await c.run('cp .anvil/skills/demo/SKILL.md copy.md');
  eq(ok.code, 0, `copying a skill out was refused: ${ok.out}`);
  assert(await read(c.fs, 'copy.md'), 'and the copy landed');
});

await test('an ANCESTOR of the fence cannot be removed or moved either — a subtree goes with its parent', async () => {
  // Protecting `.anvil/skills` while allowing `rm -rf .anvil` protects nothing. Found by a
  // cross-family review of the first version of this fence, which checked descendants only.
  for (const cmd of ['rm -rf .anvil', 'mv .anvil moved', 'rm -rf .', 'mv . elsewhere']) {
    const s = await shell();
    const r = await s.run(cmd);
    assert(r.code !== 0, `an ancestor operation destroyed the fence: ${cmd} → ${r.out}`);
    assert(/read-only under this grant/.test(r.out), `refused for the wrong reason: ${cmd} → ${r.out}`);
    assert(await read(s.fs, SKILLS_DIR + '/demo/SKILL.md'), `the skill is gone after: ${cmd}`);
  }
  // the CONTROL: a sibling directory with no skills under it is still removable
  const s = await shell();
  await s.run('mkdir junk');
  await s.run('echo x > junk/a.txt');
  const ok = await s.run('rm -rf junk');
  eq(ok.code, 0, `an unrelated directory was wrongly protected: ${ok.out}`);
});

if (failures.length) {
  console.error(`skills-fence: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`skills-fence conformance: ${passed}/${passed} passed`);
