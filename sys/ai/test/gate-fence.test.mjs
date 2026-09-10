// Conformance — .anvil/gate is READABLE and UNWRITABLE from every agent route.
//   node sys/ai/test/gate-fence.test.mjs
//
// The verify gate is what turns a run from `unclaimed` into `done`. It is worth exactly nothing
// if the agent can edit the thing the gate command measures: the cheapest way to make
// `python .anvil/gate/test_fib.py` exit 0 is to weaken the assertion, and a gate that can be
// weakened only ever reports green. So the acceptance criterion is fenced.
//
// The fence is the GRANT, on the NORMALISED path — the shell resolves `..`, expands variables,
// honours `cd`, and offers the registry's dotted verbs, so one write has many spellings and a
// string match on the command line closes none of them. This suite drives the REAL shell and
// the REAL structured file tools over one granted face, because the point of fencing at the
// normalised path is that BOTH routes collapse to the same check.
import { createShell } from '../../rig/cli/shell.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../rig/agent/index.mjs';
import { makeToolExecutor, makeShellVerifier } from '../agent-tools.mjs';
import { SKILLS_DIR } from '../skills.mjs';
import { GATE_DIR, underGateDir, explainGateRefusal } from '../gate.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const GATE_FILE = GATE_DIR + '/check.sh';
const GATE_BODY = 'grep -c ANSWER=42 answer.txt\n';

async function bed() {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });            // the UNGRANTED edge — the owner's door
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({
    prefixes: [''],
    scopes: ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write'],
    readOnlyPrefixes: [SKILLS_DIR, GATE_DIR],       // exactly what apps/anvil/index.html passes
  });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'a' });
  const sh = createShell({ registry, face });
  const run = async (c) => { const r = await sh.feed(c); return { out: String(r.output || '').trim(), code: sh.lastCode }; };
  // the acceptance criterion, authored by the owner through the ungranted edge
  await fs.write(GATE_FILE, GATE_BODY);
  await fs.write('answer.txt', 'ANSWER=0\n');
  const exec = makeToolExecutor({ shell: sh, face, mode: 'code' });
  return { sh, run, fs, face, registry, exec };
}
const read = async (fs, p) => { const r = await fs.read(p, { encoding: 'utf-8' }); return r && r.ok ? r.data : null; };

await test('every SHELL spelling of a write into the gate dir is refused, and the criterion is unchanged', async () => {
  const attempts = [
    'echo PWNED > .anvil/gate/check.sh',
    'echo PWNED >> .anvil/gate/check.sh',
    'echo PWNED > ./.anvil/gate/check.sh',
    'echo "exit 0" > .anvil/gate/check.sh',            // the laundering write this fence exists for
    'echo PWNED > .anvil/gate/extra.sh',               // a NEW file in the fenced dir
    'fs.write .anvil/gate/check.sh --data PWNED',      // the registry's dotted verb
    'echo PWNED > .anvil/skills/../gate/check.sh',     // .. traversal back into the dir
    'D=.anvil/gate; echo PWNED > $D/check.sh',         // the path arrives via a variable
    'cd .anvil && echo PWNED > gate/check.sh',         // relative to another cwd
    'rm .anvil/gate/check.sh',
    'rm -r .anvil/gate',
    'mv answer.txt .anvil/gate/check.sh',
    'cp answer.txt .anvil/gate/check.sh',
    'mkdir .anvil/gate/sneaky',
  ];
  // A FRESH bed per attempt: `cd` persists, so a shared shell would judge later attempts from
  // the wrong working directory — which is itself why the boundary cannot be a string match.
  for (const cmd of attempts) {
    const b = await bed();
    const r = await b.run(cmd);
    assert(r.code !== 0, `NOT refused (exit ${r.code}): ${cmd} → ${r.out}`);
    assert(/read-only under this grant/.test(r.out), `refused, but not by the fence: ${cmd} → ${r.out}`);
    eq(await read(b.fs, GATE_FILE), GATE_BODY, `the criterion changed despite the refusal: ${cmd}`);
    eq(await read(b.fs, GATE_DIR + '/extra.sh'), null, `a new file landed in the fence: ${cmd}`);
  }
});

await test('the STRUCTURED file tools are refused too — same face, same normalised check', async () => {
  // write/edit/remove/move reach fileops through the granted face (agent-tools.mjs writeFile →
  // face.invoke('fs.write')), so the fence covers them without a second guard. Asserted here
  // because "one check covers every route" is the whole claim.
  const b = await bed();
  const w = await b.exec('write', { path: GATE_FILE, content: 'exit 0\n' });
  assert(/read-only under this grant/.test(String(w)), `the write tool was not refused by the fence: ${w}`);
  eq(await read(b.fs, GATE_FILE), GATE_BODY, 'the criterion is unchanged after the write tool');

  // edit requires a prior read — do it, which also proves reading is allowed for the tools
  const rd = await b.exec('read', { path: GATE_FILE });
  assert(/ANSWER=42/.test(String(rd)), `the read tool cannot see the criterion: ${rd}`);
  const e = await b.exec('edit', { path: GATE_FILE, old_string: 'grep -c ANSWER=42 answer.txt', new_string: 'true' });
  assert(/read-only under this grant/.test(String(e)), `the edit tool was not refused by the fence: ${e}`);
  eq(await read(b.fs, GATE_FILE), GATE_BODY, 'the criterion is unchanged after the edit tool');

  const nf = await b.exec('write', { path: GATE_DIR + '/extra.sh', content: 'exit 0\n' });
  assert(/read-only under this grant/.test(String(nf)), `a NEW gate file was not refused: ${nf}`);
});

await test('reading the criterion still works from the shell — the agent is aimed at it', async () => {
  const b = await bed();
  const cat = await b.run('cat .anvil/gate/check.sh');
  eq(cat.code, 0, `cat was refused: ${cat.out}`);
  assert(/ANSWER=42/.test(cat.out), `cat returned nothing useful: ${cat.out}`);
  const ls = await b.run('ls .anvil/gate');
  eq(ls.code, 0, `ls was refused: ${ls.out}`);
  assert(/check\.sh/.test(ls.out), `ls did not list the criterion: ${ls.out}`);
  const grep = await b.run('grep ANSWER .anvil/gate/check.sh');
  eq(grep.code, 0, `grep was refused: ${grep.out}`);
});

await test('writes everywhere else are untouched — including the path the gate MEASURES', async () => {
  const b = await bed();
  for (const cmd of ['echo ANSWER=42 > answer.txt', 'mkdir src', 'echo x > .anvil/hooks.json',
                     'echo x > .anvil/gate-notes/y.md', 'fs.write other.md --data hello']) {
    const r = await b.run(cmd);
    eq(r.code, 0, `wrongly refused: ${cmd} → ${r.out}`);
  }
  eq(await read(b.fs, 'answer.txt'), 'ANSWER=42\n', 'the agent can still change the code the gate judges');
  assert(await read(b.fs, '.anvil/gate-notes/y.md'), 'an adjacent directory with a longer name is NOT inside the fence');
});

await test('an ANCESTOR of the fence cannot be removed or moved either', async () => {
  for (const cmd of ['rm -rf .anvil', 'mv .anvil moved', 'rm -rf .', 'mv . elsewhere']) {
    const b = await bed();
    const r = await b.run(cmd);
    assert(r.code !== 0, `an ancestor operation destroyed the fence: ${cmd} → ${r.out}`);
    assert(/read-only under this grant/.test(r.out), `refused for the wrong reason: ${cmd} → ${r.out}`);
    eq(await read(b.fs, GATE_FILE), GATE_BODY, `the criterion is gone after: ${cmd}`);
  }
});

await test('the OWNER keeps the door: the ungranted edge still authors the criterion', async () => {
  // There is no skill_manage analogue here on purpose — the standard a run is judged by is the
  // owner's alone. Anvil's `fs` binding (and __anvil.test.fs, its programmatic form) is that door.
  const b = await bed();
  const w = await b.fs.write(GATE_FILE, 'grep -c ANSWER=43 answer.txt\n');
  assert(w && w.ok, `the owner's door is closed too: ${JSON.stringify(w)}`);
  eq(await read(b.fs, GATE_FILE), 'grep -c ANSWER=43 answer.txt\n', 'and the new criterion lands');
});

await test('the fence does not block the VERIFIER — a gate command reading .anvil/gate runs and grades', async () => {
  // The verifier runs a fresh shell over the SAME granted face, so a fence that blocked reading
  // would make every gate fail closed and get itself switched off.
  const b = await bed();
  const b2 = await bed();
  const canRead = await makeShellVerifier({ createShell, registry: b2.registry, face: b2.face, command: 'cat .anvil/gate/check.sh' })();
  eq(canRead.ok, true, `the verifier cannot read the fenced criterion: ${JSON.stringify(canRead)}`);
  assert(/ANSWER=42/.test(canRead.stdout), `the verifier read nothing useful: ${JSON.stringify(canRead)}`);
  // red -> green on the SAME command: the gate tracks the code, and the code is writable
  const gateCmd = (await b.fs.read(GATE_FILE, { encoding: 'utf-8' })).data.trim();
  const red = await makeShellVerifier({ createShell, registry: b.registry, face: b.face, command: gateCmd })();
  eq(red.ok, false, `the gate should be RED before the fix: ${JSON.stringify(red)}`);
  await b.run('echo ANSWER=42 > answer.txt');
  const green = await makeShellVerifier({ createShell, registry: b.registry, face: b.face, command: gateCmd })();
  eq(green.ok, true, `the gate should be GREEN after the fix: ${JSON.stringify(green)}`);
});

await test('the model is told why — the explanation rides on the grant\'s refusal and never causes one', async () => {
  const b = await bed();
  const r = await b.run('echo "exit 0" > .anvil/gate/check.sh');
  assert(r.code !== 0, 'the grant refused it');
  const explained = explainGateRefusal(r.out);
  assert(/editing the standard is not a way to pass it/.test(explained), `the model is told: ${explained}`);
  assert(explained.startsWith(r.out), 'the grant\'s own words are kept');
  // and it annotates NOTHING that is not a gate-dir refusal
  eq(explainGateRefusal('Wrote answer.txt (10 bytes)'), 'Wrote answer.txt (10 bytes)', 'a success is untouched');
  eq(explainGateRefusal('fs.write: EGRANT: path is read-only under this grant: .anvil/skills/x/SKILL.md'),
     'fs.write: EGRANT: path is read-only under this grant: .anvil/skills/x/SKILL.md', 'another fence\'s refusal is not claimed');
  for (const cmd of [
    'echo "ok; touch .anvil/gate/check.sh"',      // the path is inside a quoted string
    'echo ok # > .anvil/gate/check.sh',           // ...inside a comment
    'cp .anvil/gate/check.sh backup.sh',          // copying the criterion OUT is a read
    'echo x > .anvil/gate/../../notes.md',        // resolves OUTSIDE the fence
  ]) {
    const f = await bed();
    const out = await f.run(cmd);
    eq(out.code, 0, `a legitimate command was refused: ${cmd} → ${out.out}`);
    eq(explainGateRefusal(out.out), out.out, `a legitimate command was annotated as a refusal: ${cmd}`);
  }
});

await test('underGateDir is exact about the boundary', async () => {
  for (const p of ['.anvil/gate', '.anvil/gate/x.py', './.anvil/gate/x.py', '.anvil/gate/a/b.py', '.anvil\\gate\\x.py'])
    assert(underGateDir(p), `should be inside: ${p}`);
  for (const p of ['', '.anvil', '.anvil/gates/x.py', '.anvil/gate-notes/x.md', 'gate/x.py', '.anvil/skills/x/SKILL.md'])
    assert(!underGateDir(p), `should be outside: ${p}`);
});

// ── the APP actually wires it (a fence nothing passes to createGrant is a fence nowhere) ──
await test('Anvil passes GATE_DIR to BOTH grants and annotates every route\'s refusal', async () => {
  const { readFile } = await import('node:fs/promises');
  const anvil = await readFile(new URL('../../../apps/anvil/index.html', import.meta.url), 'utf8');
  const grants = anvil.match(/readOnlyPrefixes:\[SKILLS_DIR, GATE_DIR\]/g) || [];
  eq(grants.length, 2, 'the top-level agent grant AND the subagent overlay grant both fence the gate dir');
  assert(/import \{ GATE_DIR, explainGateRefusal \} from '\.\.\/\.\.\/sys\/ai\/gate\.mjs';/.test(anvil),
    'the constant and the wording come from the module, not a copy in the app');
  assert(/explainGateRefusal\(nm==='shell' \? explainSkillsRefusal\(raw\) : raw\)/.test(anvil),
    'the annotation rides on EVERY string tool result, not only the shell\'s');
  // the gate command examples the ✓ Must-pass prompt offers must be runnable in this shell
  const prompt = anvil.slice(anvil.indexOf("title:'Gate command'"), anvil.indexOf('t.verifyCmd=v.trim()'));
  assert(prompt.length > 100, 'found the gate prompt');
  assert(!/grep -q/.test(prompt), '`grep -q` is not a flag this shell\'s grep supports — the example would exit 2');
});

if (failures.length) {
  console.error(`gate-fence: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`gate-fence conformance: ${passed}/${passed} passed`);
