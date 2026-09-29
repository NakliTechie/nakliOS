// Conformance — the shell must never answer WRONGLY with exit 0.
//   node sys/rig/cli/test/false-friends.test.mjs
//
// A missing command exits 127 and the agent adapts. A wrong exit 0 is believed, and every step
// downstream inherits a corrupted premise. Thirteen behaviours were in that second category
// (plan/anvil-command-surface-delta.md, verified live): `grep -v` returned exactly the lines it
// was asked to exclude, `grep -i` reported no match, the text builtins ignored file arguments and
// returned "", `find -name` was ignored, single quotes did not protect `$VAR`.
//
// Every case below asserts BOTH that the old wrong answer is gone AND that a benign use still
// works — a widened check that fires on ordinary work gets turned off, which helps nobody.
import { createShell, SLEEP_MAX_S, LISTING_MAX_ENTRIES, truncateListing } from '../shell.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';
import { createGitCore } from '../../git/git-core.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

async function shell() {
  const fs = createFileops({ backend: new MemoryBackend() });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write', 'git:remote', 'git:push'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'a' });
  const sh = createShell({ registry, face });
  const run = async (c) => { const r = await sh.feed(c); return { out: String(r.output || '').trim(), code: sh.lastCode }; };
  await run("printf 'Apple\\nbanana\\nCherry\\nbanana\\n' > f.txt");
  return { sh, run };
}

// ── R2a — file arguments were silently ignored, so every one of these returned "" ─────────
await test('R2a: the text builtins read their file arguments', async () => {
  const { run } = await shell();
  eq((await run('head -2 f.txt')).out, 'Apple\nbanana', 'head reads the file');
  eq((await run('tail -1 f.txt')).out, 'banana', 'tail reads the file');
  eq((await run('wc -l f.txt')).out, '4', 'wc reads the file');
  eq((await run('sort f.txt')).out, 'Apple\nCherry\nbanana\nbanana', 'sort reads the file');
  eq((await run("sed 's/Apple/Pear/' f.txt")).out.split('\n')[0], 'Pear', 'sed reads the file');
  eq((await run("awk '{print $1}' f.txt")).out.split('\n')[0], 'Apple', 'awk reads the file');
  // stdin still works — the file path is an addition, not a replacement
  eq((await run('cat f.txt | head -1')).out, 'Apple', 'stdin still feeds head');
  // and a missing file is an ERROR, not an empty success
  const miss = await run('head -1 nope.txt');
  assert(miss.code !== 0, `a missing file must not exit 0: ${JSON.stringify(miss)}`);
});

// ── R2b — grep answered wrongly ───────────────────────────────────────────────────────────
await test('R2b: grep -v excludes, -i matches, -c counts, -r searches', async () => {
  const { run } = await shell();
  // the worst one: -v returned exactly the lines it was asked to suppress
  eq((await run('grep -v banana f.txt')).out, 'Apple\nCherry', '-v EXCLUDES');
  eq((await run('grep -i apple f.txt')).out, 'Apple', '-i is case-insensitive');
  eq((await run('grep -c banana f.txt')).out, '2', '-c counts');
  eq((await run('grep -n Cherry f.txt')).out, '3:Cherry', '-n still numbers');
  const r = await run('grep -r x f.txt');
  eq(r.code, 1, 'recursive search with no matches exits 1'); eq(r.out, '', 'a supported recursive search does not return a hint');
  // benign: a plain grep is unchanged, and a real miss still exits non-zero with no output
  eq((await run('grep banana f.txt')).out, 'banana\nbanana', 'a plain grep is unchanged');
  const none = await run('grep zebra f.txt');
  assert(none.out === '' && none.code !== 0, 'a genuine non-match is still an empty non-zero');
  const zc = await run('grep -c zebra f.txt');
  eq(zc.out, '0', '-c on no matches reports 0');
  assert(zc.code !== 0, '-c on no matches still exits non-zero');
});

// ── R2c — single quotes protected nothing ────────────────────────────────────────────────
await test('R2c: single quotes are literal; double quotes still expand', async () => {
  const { run } = await shell();
  eq((await run("X=world; echo 'literal $X'")).out, 'literal $X', 'single quotes protect $');
  eq((await run('X=world; echo "double $X"')).out, 'double world', 'double quotes still expand');
  eq((await run('X=world; echo $X')).out, 'world', 'a bare $VAR still expands');
  // a quoted glob is a PATTERN for the command, not a filename for the shell
  await run("printf 'a\\n' > one.txt"); await run("printf 'b\\n' > sub/two.txt");
  const found = (await run("find . -name '*.txt'")).out.split('\n').sort();
  assert(found.includes('./sub/two.txt'), `a quoted glob reaches the command: ${JSON.stringify(found)}`);
  // an UNquoted glob still expands as a filename
  const globbed = await run('cat one.txt');
  eq(globbed.out, 'a', 'sanity: the file holds exactly "a"');
  const star = await run('cat one*.txt');
  eq(star.code, 0, 'an unquoted glob expands to a real file, not an ENOENT');
  eq(star.out, 'a', 'and yields its CONTENT (an error message would also contain "a")');
});

// The quote fix works by marking literal characters internally. That marker is an implementation
// detail and must never escape — including through a stored variable, which `env` prints.
await test('R2c: the internal literal marker never reaches a command, a value, or the disk', async () => {
  const { run } = await shell();
  const MARK = String.fromCharCode(1);
  const hasMark = (s) => s.includes(MARK);
  for (const cmd of ["echo 'lit $X'", "echo '*.txt'", 'echo "*.txt"', "V='a*b'; echo $V",
                     "export Q='p$q'; env", "echo x > 'out.txt'", "cat 'out.txt'", 'ls']) {
    const r = await run(cmd);
    assert(!hasMark(r.out), `marker leaked from \`${cmd}\`: ${JSON.stringify(r.out)}`);
  }
});

// ── R2d — an unimplemented flag was ignored rather than refused ───────────────────────────
await test('R2d: an unsupported flag is refused, never silently ignored', async () => {
  const { run } = await shell();
  for (const [cmd, flag] of [['head -q f.txt', '-q'], ['sort -Z f.txt', '-Z'], ['wc -Q f.txt', '-Q'],
                             ['uniq -Y f.txt', '-Y'], ['grep -Z x f.txt', '-Z'],
                             ['sed --color s/a/b/ f.txt', '--color'], ['ls --color', '--color'],
                             ["awk --color '{print $1}' f.txt", '--color']]) {
    const r = await run(cmd);
    eq(r.code, 2, `${cmd} must exit 2`);
    assert(r.out.includes(flag), `${cmd} must name ${flag}, got: ${r.out}`);
  }
  // a value that looks like a flag is not silently swallowed into a default
  const badn = await run('head -n -Z f.txt');
  eq(badn.code, 2, '-n with a non-numeric value is refused'); assert(/-Z/.test(badn.out), badn.out);
  // benign: the flags each builtin DOES implement still work
  eq((await run('sort -r f.txt')).out.split('\n')[0], 'banana', 'sort -r works');
  eq((await run('sort -u f.txt')).out.split('\n').length, 3, 'sort -u works');
  const uc = (await run('sort f.txt | uniq -c')).out.split('\n').map((l) => l.trim());
  eq(uc.join('|'), '1 Apple|1 Cherry|2 banana', 'uniq -c reports the actual RUN COUNTS');
});

// ── R2e — the remaining silent wrongs ────────────────────────────────────────────────────
await test('R2e: find predicates, wc line counting, true/false, comments, ls exit, < redirect', async () => {
  const { run } = await shell();
  await run("printf 'x\\n' > keep.txt"); await run("printf 'y\\n' > drop.log");
  const named = (await run("find . -name '*.log'")).out;
  eq(named, './drop.log', `-name filters (it used to return everything): ${named}`);
  assert(!(await run("find . -name '*.log'")).out.includes('keep.txt'), '-name really excludes');
  await run("printf 'z\\n' > nested/deep.txt");
  const dirs = (await run('find . -type d')).out.split('\n').sort();
  eq(dirs.join('|'), '.|./nested', '-type d includes the starting directory and its child directories');
  const files = (await run('find . -type f')).out.split('\n').sort();
  assert(files.includes('./nested/deep.txt') && !files.includes('./nested') && !files.includes('.'), `-type f returns files and no directory: ${files}`);
  assert(files.length >= 3, `-type f is not empty — returning nothing must not pass: ${files}`);
  // -maxdepth had no assertion at all; a mutation disabling it survived
  const d1 = (await run('find . -maxdepth 1')).out.split('\n').sort();
  assert(!d1.includes('./nested/deep.txt'), `-maxdepth 1 excludes a deeper file: ${d1}`);
  assert(d1.includes('.') && d1.includes('./keep.txt'), `-maxdepth 1 keeps its root and a top-level file: ${d1}`);
  const newer = await run('find keep.txt -newer keep.txt');
  eq(newer.code, 0, '-newer is supported'); eq(newer.out, '', 'a file is not strictly newer than itself');
  eq((await run('find keep.txt -newer absent-reference')).code, 1, 'a missing -newer reference is an I/O error');
  for (const [cmd, why] of [['find . -type X', 'an invalid -type value'],
                            ['find . -maxdepth nope', 'a non-numeric -maxdepth']]) {
    eq((await run(cmd)).code, 2, `${why} is refused, not ignored`);
  }
  // wc counts LINES, so a pipeline no longer undercounts by one
  eq((await run('grep banana f.txt | wc -l')).out, '2', 'a pipeline count is right');
  eq((await run('true && echo yes')).out, 'yes', 'true exists');
  eq((await run('false || echo no')).out, 'no', 'false exists');
  eq((await run('# just a comment')).out, '', 'a comment is not a command-not-found');
  eq((await run('echo hi # trailing')).out, 'hi', 'a trailing comment is stripped');
  const missing = await run('ls nosuchdir');
  assert(missing.code !== 0, `ls on a missing path must not exit 0: ${JSON.stringify(missing)}`);
  eq((await run('ls nosuchdir || echo fallback')).out.includes('fallback'), true, 'so || takes the fallback');
  // < redirect fed nothing at all before
  eq((await run('tr a-z A-Z < keep.txt')).out, 'X', '< feeds stdin, and tr expands ranges');
  await run("printf 'a,b,c\\nd,e,f\\n' > t.csv");
  eq((await run('cut -d, -f2 < t.csv')).out, 'b\ne', 'cut reads a redirect too');
  eq((await run('cut -d, -f1-2 t.csv')).out, 'a,b\nd,e', 'cut handles a RANGE (it used to read one field)');
});

// A redirect that wrote nothing must not report success — this batch introduced that bug and
// the checker caught it, so it gets a test of its own.
await test('a FAILED redirect is a non-zero exit, and && does not fire', async () => {
  const fs = createFileops({ backend: new MemoryBackend() });
  const registry = buildRigRegistry({ fs });
  const readOnly = createGrant({ prefixes: [''], scopes: ['fs:read'] }); // every write is refused
  const face = createAgentFace({ registry, grant: readOnly, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'a' });
  const sh = createShell({ registry, face });
  const r = await sh.feed('echo ok > denied.txt && echo WRITTEN');
  const out = String(r.output || '');
  assert(!/WRITTEN/.test(out), `&& must not run after a failed write: ${JSON.stringify(out)}`);
  assert(sh.lastCode !== 0, `a failed redirect exits non-zero, got ${sh.lastCode}`);
  assert(/fs:write|write failed/.test(out), `and says why: ${JSON.stringify(out)}`);
});

// Battery 2026-09-24: a model reached for `git mv`, got "not a rig git command" and renamed with python.
await test('git mv renames, and stages both ends when a git core is wired; without one it renames and says nothing was staged', async () => {
  const { run } = await shell();
  await run("printf 'x\\n' > seed.txt");
  const bare = await run('git mv seed.txt seed2.txt');
  eq(bare.code, 0, 'git mv without a git core still renames: ' + bare.out);
  assert(/renamed seed\.txt -> seed2\.txt \(no git core wired: nothing staged\)/.test(bare.out), bare.out);
  assert(/seed2\.txt/.test((await run('ls')).out) && !/(^|\s)seed\.txt/.test((await run('ls')).out), 'the file moved');
  assert(/usage: git mv/.test((await run('git mv only-one')).out), 'one path is a usage error');
  const calls = [];
  const fakeGit = { add: async (i) => { calls.push(['add', i.filepath]); return { ok: true }; }, remove: async (i) => { calls.push(['remove', i.filepath]); return { ok: true }; } };
  const fs2 = createFileops({ backend: new MemoryBackend() });
  const reg2 = buildRigRegistry({ fs: fs2, git: fakeGit });
  const grant2 = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write'] });
  const face2 = createAgentFace({ registry: reg2, grant: grant2, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'a' });
  const sh2 = createShell({ registry: reg2, face: face2 });
  const feed = async (c) => { const r = await sh2.feed(c); if (sh2.awaitingConfirm) await sh2.feed('y'); return String(r.output || '').trim(); };
  await feed("printf 'x\\n' > a.txt");
  const first = await sh2.feed('git mv a.txt b.txt');
  assert(sh2.awaitingConfirm, 'dropping the old path from the index asks, like git rm: ' + JSON.stringify(first.output));
  await sh2.feed('y');
  assert(/b\.txt/.test(await feed('ls')) && !/a\.txt/.test(await feed('ls')), 'the rename happened');
  eq(JSON.stringify(calls), JSON.stringify([['add', 'b.txt'], ['remove', 'a.txt']]), 'the new path is added, the old one removed from the index');
});

// ── R3b — reachable at all ───────────────────────────────────────────────────────────────
await test('R3b: git clone/fetch/push actually DISPATCH, not just print usage', async () => {
  const { run } = await shell();
  // usage is the shallow half — the checker showed all three could be pointed at a bogus
  // registry command and the old test still passed, because it never called them with arguments.
  for (const [cmd, word] of [['git clone', 'clone'], ['git fetch', 'fetch'], ['git push', 'push']]) {
    const r = await run(cmd);
    assert(!/is not a rig git command/.test(r.out), `${cmd} is wired: ${r.out}`);
    assert(new RegExp(`usage: git ${word}`).test(r.out), `${cmd} states its usage: ${r.out}`);
  }
  assert(/clone\|fetch\|push/.test((await run('git')).out), 'the usage line advertises them');

  // and the real half: with a git core wired, the right registry command is invoked with the
  // right input. Without this the three cases above pass even if runGit points at a bogus name.
  const calls = [];
  const fakeGit = {
    clone: async (i) => { calls.push(['clone', i]); return { ok: true }; },
    fetch: async (i) => { calls.push(['fetch', i]); return { ok: true }; },
    push: async (i) => { calls.push(['push', i]); return { ok: true }; },
  };
  const fs2 = createFileops({ backend: new MemoryBackend() });
  const reg2 = buildRigRegistry({ fs: fs2, git: fakeGit });
  const grant2 = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write', 'git:remote', 'git:push'] });
  const face2 = createAgentFace({ registry: reg2, grant: grant2, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'a' });
  const sh2 = createShell({ registry: reg2, face: face2 });
  const feed = async (c) => { const r = await sh2.feed(c); if (sh2.awaitingConfirm) await sh2.feed('y'); return r; };
  await feed('git clone https://example.test/r.git main');
  await feed('git fetch https://example.test/r.git main');
  await feed('git push https://example.test/r.git refs/heads/main');
  const got = (n) => calls.find((c) => c[0] === n);
  assert(got('clone'), `git clone reached the git core, saw: ${JSON.stringify(calls.map((c) => c[0]))}`);
  assert(got('fetch'), `git fetch reached the git core, saw: ${JSON.stringify(calls.map((c) => c[0]))}`);
  assert(got('push'), `git push reached the git core, saw: ${JSON.stringify(calls.map((c) => c[0]))}`);
  eq(got('clone')[1].url, 'https://example.test/r.git', 'clone carries the url');
  eq(got('fetch')[1].ref, 'main', 'fetch carries the ref');
  eq(got('push')[1].ref, 'refs/heads/main', 'push carries the ref');
});

// ── R3a — the advertised surface matches the built one ───────────────────────────────────
// ── R2f — rg accepted ANY flag and quietly ignored it ────────────────────────
// Observed live: an agent asked "which .py files define solve" four different
// ways and got four empty answers with exit 0, then kept retrying. `--type py`
// parsed "py" as the search PATH. Every case below must either work or say why.
await test('R2f: rg implements its flags or refuses them, and never answers empty in silence', async () => {
  const { run } = await shell();
  await run("printf 'def solve(x):\n    return x\n' > a.py");
  await run('mkdir sub');
  await run("printf 'def solve(y):\n    return y\n' > sub/b.py");
  await run("printf 'function solve(){}\n' > c.js");

  const plain = await run('rg "def solve"');
  assert(plain.out.split('\n').length === 2, `bare rg finds both: ${plain.out}`);

  const typed = await run('rg "def solve" --type py');
  assert(typed.out.split('\n').length === 2, `--type py finds both .py files, got: ${typed.out}`);
  assert(!typed.out.includes('.js'), '--type py excludes the .js file');

  const jsOnly = await run('rg "solve" -t js');
  assert(jsOnly.out.includes('c.js') && !jsOnly.out.includes('.py'), `-t js selects only js: ${jsOnly.out}`);

  const globbed = await run('rg "solve" -g "*.py"');
  assert(globbed.out.split('\n').length === 2, `-g "*.py" finds both: ${globbed.out}`);

  const listed = await run('rg --files -t py');
  assert(listed.out.split('\n').length === 2, `--files -t py lists both: ${listed.out}`);

  // The three ways it used to lie: a bad path, an unknown type, an unknown flag.
  const badPath = await run('rg ".py$" --files');
  assert(/no such file/.test(badPath.out), `a non-existent path is reported: ${badPath.out}`);
  assert(badPath.code !== 0, 'and is a non-zero exit');

  const badType = await run('rg "solve" --type cobol');
  assert(/unknown type/.test(badType.out) && /py/.test(badType.out), `unknown type names the known ones: ${badType.out}`);
  assert(badType.code !== 0, 'and is a non-zero exit');

  const badFlag = await run('rg "solve" --unsupported');
  assert(/unsupported flag --unsupported/.test(badFlag.out), `an unimplemented flag is refused: ${badFlag.out}`);
  assert(badFlag.code !== 0, 'and is a non-zero exit');
});

// ── R2g — rg reimplemented the scan, so it never touched the trigram index ────
// The index lives under fs.grep. rg globbed and read files itself, which meant
// the ONE search path the agent is told to use was the one that never used it.
await test('R2g: rg delegates to fs.grep, so the agent path gets the index', async () => {
  const fs = createFileops({ backend: new MemoryBackend(), index: true, exclusive: true });
  for (let i = 0; i < 60; i++) await fs.write(`src/m${i}.mjs`, `const v = ${i};\n`, { createParents: true });
  await fs.write('src/needle.mjs', 'export const rareSymbolXYZ = 1;\n', { createParents: true });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'a' });
  const sh = createShell({ registry, face });
  await new Promise((r) => setTimeout(r, 4));
  await sh.feed('rg rareSymbolXYZ');            // builds the index
  await sh.feed('rg rareSymbolXYZ');            // settles it
  fs.searchStats({ reset: true });
  const out = await sh.feed('rg rareSymbolXYZ');
  assert(String(out.output || '').includes('needle.mjs'), 'still finds the symbol');
  const viaGrep = fs.searchStats().recent.find((r) => r.via === 'fs.grep');
  assert(viaGrep, 'rg went through fs.grep rather than scanning by itself');
  assert(viaGrep.indexUsed, 'and fs.grep used the index');
  assert(viaGrep.filesRead < 10, `and read few files, not all 61: read ${viaGrep.filesRead}`);
});

await test('R3a: help describes a curated subset and says flags are refused', async () => {
  const { run } = await shell();
  const h = (await run('help')).out;
  assert(/CURATED/.test(h), 'help says this is not coreutils');
  assert(/REFUSES an unsupported flag/.test(h), 'help states the unknown-flag policy');
  assert(/grep -r -R/.test(h) && /rg/.test(h), 'help names recursive grep and rg');
  assert(/single quotes are literal/.test(h), 'help states the quoting rule');
  assert(/No subshells, loops/.test(h), 'help names what the grammar lacks');
});


// ── a failing stage inside a PIPE was fed to the next stage as data ───────────────────────
// The worst false friend found so far, because it manufactures a plausible answer rather
// than an empty one. This shell has no stderr, so a refused stage's message went down the
// pipe: `rg --bogus x | wc -l` answered `1` with exit 0 — the "1" being the refusal line
// itself, counted. Live-found 2026-09-10 driving Anvil on qwen3:8b: a four-stage pipeline
// whose FIRST stage was refused reported exit 0, had its `expect: exit 0` graded MET, and
// the agent wrote the unexpanded command text into findings.md believing it had results.
await test('R-pipe: a stage that errors surfaces instead of feeding the next stage', async () => {
  const { run } = await shell();
  const counted = await run('rg --bogus-flag x | wc -l');
  assert(counted.code >= 2, `a refused stage must not report success: exit ${counted.code}`);
  assert(/unsupported flag --bogus-flag/.test(counted.out), `the refusal itself must surface: ${counted.out}`);
  assert(counted.out !== '1', 'the refusal line must never be counted as if it were output');

  const missing = await run('nosuchcommand | wc -l');
  eq(missing.code, 127, 'a missing command keeps its 127 through a pipe');
  assert(/command not found/.test(missing.out), `and says so: ${missing.out}`);

  // ...and the failure surfaces from any position, not just the first stage.
  const later = await run('cat f.txt | rg --bogus-flag x');
  assert(later.code >= 2, `a later stage's refusal also surfaces: exit ${later.code}`);
});

// The benign half: exit 1 is "no match", not an error, and must still flow through a pipe.
// Aborting on it would break the most ordinary counting idiom there is.
await test('R-pipe: "no match" (exit 1) still pipes, so counting zero keeps working', async () => {
  const { run } = await shell();
  const zero = await run('grep zzz f.txt | wc -l');
  eq(zero.out, '0', 'grep with no match still counts zero through the pipe');
  eq(zero.code, 0, 'and the pipeline succeeds — wc ran fine');
  eq((await run('rg -n zzz | wc -l')).out, '0', 'same for rg');
  eq((await run('cat f.txt | grep banana | wc -l')).out, '2', 'an ordinary matching pipeline is untouched');
  eq((await run('cat f.txt | sort | uniq | wc -l')).out, '3', 'a three-stage pipeline is untouched');
});

// `python --version` was RUN AS SOURCE — `NameError: name 'version' is not defined`, exit 1 —
// three times in one live run (2026-09-11) while the agent tried to learn what interpreter it
// had. A flag is not a program. The two version spellings answer; any other flag refuses with
// exit 2 the way every builtin does, and never reaches the kernel.
await test('python: --version answers, an unknown flag refuses, and neither is executed as source', async () => {
  const fs = createFileops({ backend: new MemoryBackend() });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'a' });
  const seen = [];
  const kiln = { exec: async (_owner, code) => { seen.push(code); return { status: 'ok', stdout: /sys\.version/.test(code) ? 'Python 3.12.1\n' : 'ran\n', stderr: '' }; } };
  const sh = createShell({ registry, face, kiln });
  const run = async (c) => { const r = await sh.feed(c); return { out: String(r.output || '').trim(), code: sh.lastCode }; };
  await fs.write('hello.py', 'print("hi")\n');

  const v = await run('python --version');
  eq(v.code, 0, '--version exits 0'); assert(/^Python 3\./.test(v.out), `--version prints the interpreter version, got ${JSON.stringify(v.out)}`);
  assert(seen.length === 1 && /sys\.version/.test(seen[0]) && !/--version/.test(seen[0]), 'the version is asked of the kernel, the flag is never executed');
  const V = await run('python -V'); eq(V.code, 0, '-V is the same question'); assert(/^Python 3\./.test(V.out), '-V prints the version');

  const before = seen.length;
  const x = await run('python -x');
  eq(x.code, 2, 'an unknown flag refuses with exit 2, never exit 1 from a NameError');
  assert(/unsupported option -x/.test(x.out), `and says which flag: ${JSON.stringify(x.out)}`);
  eq(seen.length, before, 'the kernel never saw it');

  const c = await run('python -c "print(1)"'); eq(c.code, 0, '-c still runs'); assert(/print\(1\)/.test(seen[seen.length - 1]), 'with its code');
  const f = await run('python hello.py'); eq(f.code, 0, 'a file still runs'); assert(/print\("hi"\)/.test(seen[seen.length - 1]), 'with the file body');
});

// `2>/dev/null` swallowed STDOUT and wrote it to a workspace file named dev/null — live
// 2026-09-11, `find / -name test_inv.py 2>/dev/null` answered nothing with exit 0 while the file
// existed, and the agent concluded the gate did not exist. This shell merges the streams, so the
// only reading that never loses output is: `2>/dev/null` is a no-op, `>/dev/null` discards, and
// neither ever creates a file.
await test('/dev/null: 2> is a no-op, > discards, and no dev/null file is ever created', async () => {
  const { run } = await shell();
  await run('echo x > .anvil/gate/x.py');
  const f = await run('find / -name x.py 2>/dev/null');
  eq(f.out, '/.anvil/gate/x.py', 'stdout survives a 2>/dev/null'); eq(f.code, 0, 'exit 0');
  const l = await run('ls f.txt 2>/dev/null'); eq(l.out, 'f.txt', 'ordinary output survives too');
  const d = await run('ls > /dev/null'); eq(d.out, '', '> /dev/null discards'); eq(d.code, 0, 'and succeeds');
  const d2 = await run('ls >/dev/null'); eq(d2.out, '', 'with or without the space');
  const a = await run('cat nope.txt 2>/dev/null; echo after'); assert(/after$/.test(a.out), 'the statement after still runs: ' + JSON.stringify(a.out));
  const dev = await run('ls dev'); assert(dev.code !== 0, 'no dev/ directory was ever created: ' + JSON.stringify(dev.out));
  const real = await run('ls > listing.txt; cat listing.txt'); assert(/f\.txt/.test(real.out), 'a real redirect still writes its file');
});

// `echo "exit: $?"` printed the literal `$?` while the unquoted form expanded — a quoted `?` is
// marked literal for the glob pass and the mark landed between `$` and `?`. An agent read a
// gate's exit code three ways and got `$?` back twice (live 2026-09-11).
await test('$? expands inside double quotes exactly as it does outside them', async () => {
  const { run } = await shell();
  const bare = await run('cat nope.txt; echo EXIT: $?');   assert(/EXIT: 1$/.test(bare.out), `unquoted: ${JSON.stringify(bare.out)}`);
  const quoted = await run('cat nope.txt; echo "EXIT: $?"'); assert(/EXIT: 1$/.test(quoted.out), `quoted: ${JSON.stringify(quoted.out)}`);
  const ok0 = await run('true; echo "code=$?"');             assert(/code=0$/.test(ok0.out), `after success: ${JSON.stringify(ok0.out)}`);
  const glob = await run('echo "a?b"');                      eq(glob.out, 'a?b', 'a quoted ? that is not $? is still a literal, not a glob');
  const lit = await run("echo '$?'");                        eq(lit.out, '$?', 'single quotes still protect it');
});

// ── sleep — a child asked to pace itself spent 20 steps hunting for one (live 2026-09-17) ────
await test('sleep: waits the interval, sums operands, and refuses invalid or excessive intervals', async () => {
  const { run } = await shell();
  const t0 = Date.now();
  const ok = await run('sleep 0.3');
  const dt = Date.now() - t0;
  eq(ok.code, 0, 'sleep 0.3 exits 0'); eq(ok.out, '', 'and prints nothing');
  assert(dt >= 280 && dt < 2000, `it actually waited ~300 ms: ${dt} ms`);
  eq((await run('sleep 0.1 && echo after')).out, 'after', 'a sleep chains like any other command');
  eq((await run('which sleep')).out, 'sleep', 'which knows it');
  assert(/\bsleep N\[s\|m\|h\|d\]/.test((await run('help')).out), 'help lists intervals and suffixes');
  eq((await run('sleep 0 0s')).code, 0, 'multiple intervals are supported');
  for (const [cmd, why] of [['sleep', 'no operand'], ['sleep abc', 'a word'], ['sleep -1', 'negative'], [`sleep ${SLEEP_MAX_S + 1}`, 'above the cap']]) {
    const r = await run(cmd);
    assert(r.code !== 0, `${why} must not exit 0: ${JSON.stringify(r)}`);
    assert(/^sleep: /.test(r.out), `${why} says who refused: ${r.out}`);
  }
  eq((await run(`sleep ${SLEEP_MAX_S + 1}`)).out, `sleep: interval exceeds the ${SLEEP_MAX_S} s cap`, 'the aggregate cap is named');
});

// ── B6 structured listings — `ls -R` flattened every name into one line; a big listing had no cap ──
await test('sleep: the run\'s Stop cuts it — `sleep: interrupted`, exit 130, at once; a signal getter serves a shell that outlives its runs', async () => {
  const fs = createFileops({ backend: new MemoryBackend() }); const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'a' });
  let ac = new AbortController();
  const sh = createShell({ registry, face, signal: () => ac.signal });
  const t0 = Date.now(); setTimeout(() => ac.abort(), 80);
  const r = await sh.feed('sleep 5 && echo never');
  assert(Date.now() - t0 < 2000, 'returned on the abort, not after 5 s');
  eq(String(r.output).trim(), 'sleep: interrupted'); eq(sh.lastCode, 130, 'exit 130 — the && did not run');
  const line = await sh.feed('sleep 5; printf x > ran.txt; echo done-semi'); eq(String(line.output).trim(), 'sleep: interrupted', 'a `;` continuation does not run after the Stop either'); eq(sh.lastCode, 130);
  eq((await sh.feed('sleep 5 || echo after-or')).output.trim(), 'sleep: interrupted', 'nor a `||` one');
  eq(String((await sh.feed('cat ran.txt')).output), 'cat: ran.txt: ENOENT', 'nothing after the interrupted sleep ran');
  eq(String((await sh.feed('sleep 1')).output).trim(), 'sleep: interrupted', 'an already-aborted run: no wait at all');
  ac = new AbortController(); // the next run: the getter sees the new signal
  const t1 = Date.now(); eq((await sh.feed('sleep 0.1 && echo ok')).output.trim(), 'ok'); assert(Date.now() - t1 >= 90, 'a live run waits');
});
await test('B6: ls -R prints directory blocks, one entry a line, so a name says which directory it is in', async () => {
  const { sh, run } = await shell();
  for (const p of ['src/app.js', 'src/util/a.js', 'docs/guide.md']) await run(`printf x > ${p}`);
  const r = await run('ls -R src');
  eq(r.out, 'src:\napp.js\nutil\n\nsrc/util:\na.js\nb.js'.replace('\nb.js', ''), 'blocks: the dir, its entries, a blank line between');
  eq((await run('ls -Rl src')).out, 'src:\n- app.js\nd util\n\nsrc/util:\n- a.js', '-l keeps the d/- marks inside the blocks');
  eq((await run('ls src')).out, 'app.js  util', 'a plain ls is unchanged (names on one line)');
  eq((await run('ls -R src | head -2')).out, 'src:\napp.js', 'one entry a line, so a pipe sees lines');
  const fed = await sh.feed('ls -R src'); eq(JSON.stringify(fed.listing), JSON.stringify({ tool: 'ls', entries: 3, shown: 3, truncated: false }), 'feed() names the listing it displayed');
  eq(sh.lastListing.entries, 3); eq((await sh.feed('echo hi')).listing, undefined, 'and only a listing');
  eq((await sh.feed('ls src/app.js')).listing.entries, 1, 'a file target is one entry');
  await run('printf x > other/z.js'); eq((await run('ls -R src other')).out, 'src:\napp.js\nutil\n\nsrc/util:\na.js\n\nother:\nz.js', 'two targets: a blank line between their blocks');
});
await test('B6: a listing over the cap is cut at the terminal with a trailer that counts — never inside a pipe', async () => {
  const { sh, run } = await shell();
  const N = LISTING_MAX_ENTRIES + 7;
  for (let i = 0; i < N; i++) await run(`printf x > many/f${String(i).padStart(4, '0')}.txt`);
  const r = await run('find many -type f');
  const lines = r.out.split('\n');
  eq(lines.length, LISTING_MAX_ENTRIES + 1, 'the cap, plus the trailer');
  eq(lines[lines.length - 1], `[listing truncated: ${LISTING_MAX_ENTRIES} of ${N} entries shown — narrow the path, add -name / -maxdepth, or pipe through grep]`);
  eq(sh.lastListing.truncated, true); eq(sh.lastListing.entries, N); eq(sh.lastListing.shown, LISTING_MAX_ENTRIES);
  eq((await run('find many -type f | wc -l')).out, String(N), 'piped: every entry reaches the consumer');
  eq((await run(`find many -name f0${N - 1}.txt`)).out, `many/f0${N - 1}.txt`, 'a narrowed find is whole');
  const ls = await run('ls -R many'); assert(ls.out.startsWith('many:\nf0000.txt'), ls.out.slice(0, 40));
  eq(ls.out.split('\n').length, LISTING_MAX_ENTRIES + 2, 'ls -R: the header, the cap, the trailer'); assert(/^\[listing truncated: 500 of 507 entries shown/.test(ls.out.split('\n').pop()));
  // the helper itself: headers and blanks are not entries; nothing under the cap is touched
  eq(truncateListing('a\nb', 2).truncated, false);
  const t = truncateListing('d:\na\nb\n\ne:\nc', 3, 2); eq(t.text, 'd:\na\nb\n[listing truncated: 2 of 3 entries shown — narrow the path, add -name / -maxdepth, or pipe through grep]'); eq(t.shown, 2);
});

// ── cd — moved to ANY path and exited 0 (live prod 2026-09-17: `cd w` twice → `w/w`, then three ENOENTs) ──
await test('cd: refuses a missing target and a file, stays put, exits 1 — and a `&&` behind it does not run', async () => {
  const { run } = await shell();
  await run('printf x > w/hello.txt');
  eq((await run('cd w && pwd')).out, '/w', 'a real directory: moved');
  const twice = await run('cd w && echo moved-again'); eq(twice.code, 1); eq(twice.out, 'cd: w: No such file or directory', 'from inside w, `cd w` is a miss — not a silent move to w/w');
  eq((await run('pwd')).out, '/w', 'still in w'); eq((await run('cat hello.txt')).out, 'x', 'and the file is still here');
  const file = await run('cd hello.txt'); eq(file.code, 1); eq(file.out, 'cd: hello.txt: Not a directory');
  eq((await run('cd')).code, 0); eq((await run('pwd')).out, '/', 'bare cd goes to the root');
  eq((await run('cd nope || echo fallback')).out, 'cd: nope: No such file or directory\nfallback', 'a missing dir takes the || branch');
});

// ── Operands — a command took its first operand and dropped the rest, with exit 0 ───────────
// Found 2026-09-29 recording the Forge promo: `touch t/a t/b t/c` made `t/a` alone. An audit of
// every builtin found the same shape in mkdir, stat, mv, cp, which, dirname, basename, printf,
// head, tail, wc, ls, diff, uniq, env, history, find, the dotted registry commands and git.
// Each now takes every operand, or refuses the form with exit 2.
await test('operands: touch, mkdir and stat take every operand; rm, cat and tee still do', async () => {
  const { sh, run } = await shell();
  await run('mkdir t; touch t/a t/b t/c');
  eq((await run('ls t')).out, 'a  b  c', 'the repro: touch makes all three');
  await run("printf 'keep' > t/a"); await run('touch t/a t/d');
  eq((await run('cat t/a')).out, 'keep', 'touch leaves an existing file as it is');
  eq((await run('ls t')).out, 'a  b  c  d');
  const bare = await run('touch'); eq(bare.code, 2); eq(bare.out, 'touch: missing file operand');
  const flag = await run('touch --unsupported x'); eq(flag.code, 2, 'an unsupported flag refuses');
  eq((await run('touch -c x')).code, 0, '-c succeeds without creating an absent file');
  assert(!/(^|\s)(?:-c|x)(\s|$)/.test((await run('ls')).out), 'no absent operand or flag file appears');
  await run('mkdir d1 d2 d3');
  eq((await run('ls')).out.split('  ').filter((n) => /^d\d$/.test(n)).join(' '), 'd1 d2 d3', 'mkdir makes all three');
  await run('mkdir -p p/q r/s');
  eq((await run('ls p r')).out, 'p:\nq\n\nr:\ns', 'mkdir -p makes every path');
  const st = await run('stat t/a nope d1'); eq(st.code, 1, 'one missing operand fails the command');
  eq(st.out, 't/a: file 4\nstat: ENOENT: no such path: nope\nd1: dir 0', 'and every other operand still answers');
  eq((await run('stat t/a')).out, 'file 4', 'one operand keeps the old shape');
  eq((await run('cat t/a t/a')).out, 'keepkeep', 'cat reads every operand');
  await run('echo hi | tee o1 o2 > /dev/null');
  eq((await run('cat o1 o2')).out, 'hi\nhi', 'tee writes every operand');
  await sh.feed('rm t/b t/c'); await sh.feed('y');
  eq((await run('ls t')).out, 'a  d', 'rm removes every operand under one confirmation');
});

await test('operands: mv and cp move several sources into a directory, and refuse a file target', async () => {
  const { run } = await shell();
  await run("printf 1 > a; printf 2 > b; printf 3 > c; mkdir d");
  const many = await run('mv a b d'); eq(many.code, 0, many.out);
  eq((await run('ls d')).out, 'a  b', 'both sources moved into d');
  eq((await run('cat d/a d/b')).out, '12', 'with their content');
  eq((await run('mv c d')).code, 0, 'one source into an existing directory');
  eq((await run('ls d')).out, 'a  b  c');
  await run('mkdir e'); await run('cp d/a d/b e');
  eq((await run('ls e')).out, 'a  b', 'cp copies every source');
  eq((await run('ls d')).out, 'a  b  c', 'and leaves them');
  eq((await run('cp -r d f && ls f')).out, 'a  b  c', 'cp -r copies a directory');
  eq((await run('mv d/a renamed && cat renamed')).out, '1', 'a plain rename is unchanged');
  const notDir = await run('mv d/b d/c renamed'); eq(notDir.code, 1);
  eq(notDir.out, "mv: target 'renamed' is not a directory");
  eq((await run('ls d')).out, 'b  c', 'and nothing moved');
  const one = await run('mv d/b'); eq(one.code, 2); assert(/missing destination operand/.test(one.out), one.out);
  eq((await run('mv -f d/b x')).code, 2, 'an unsupported flag refuses');
});

await test('operands: which, dirname, printf and history answer for all; basename, diff, uniq and env refuse extras', async () => {
  const { run } = await shell();
  const w = await run('which ls nope cat'); eq(w.code, 1, 'one unknown name fails which');
  eq(w.out, 'ls\nnope not found\ncat', 'every name answers');
  eq((await run('dirname a/b c/d /x y')).out, 'a\nc\n/\n.', 'dirname answers per operand');
  eq((await run("printf '%s\\n' a b c")).out, 'a\nb\nc', 'printf reuses its format');
  eq((await run("printf '%s-%s\\n' a b c")).out, 'a-b\nc-', 'a short last round pads with empty');
  eq((await run("printf 'hi\\n' a b")).out, 'hi', 'a format without a conversion runs once');
  await run('echo one'); await run('echo two');
  eq((await run('history 2')).out.split('\n').map((l) => l.replace(/^\d+\s+/, '')).join('|'), 'echo two|history 2', 'history N prints the last N');
  eq((await run('history x')).code, 2, 'a non-numeric count refuses');
  const b = await run('basename a/b c d'); eq(b.code, 2); assert(/extra operand 'd'/.test(b.out), b.out);
  eq((await run('basename dir/x.txt .txt')).out, 'x', 'basename NAME SUFFIX is unchanged');
  eq((await run('basename .txt .txt')).out, '.txt', 'a suffix equal to the name is kept, as coreutils does');
  await run("printf 'a\\n' > p; printf 'b\\n' > q");
  const d = await run('diff p q r'); eq(d.code, 2); assert(/extra operand 'r'/.test(d.out), d.out);
  const dq = await run('diff -q p q'); eq(dq.code, 1); eq(dq.out, 'Files p and q differ', 'diff -q answers briefly, not with a full diff');
  const dx = await run('diff --unsupported p q'); eq(dx.code, 2); assert(/unsupported flag --unsupported/.test(dx.out), 'an unsupported diff flag is refused, not filtered out: ' + dx.out);
  eq((await run('diff p q')).out, '- a\n+ b', 'diff of two files is unchanged');
  const u = await run('uniq p q'); eq(u.code, 2); assert(/OUTPUT operand/.test(u.out), u.out);
  eq((await run('cat q')).out, 'b', 'and the output operand is untouched');
  const e = await run('env FOO'); eq(e.code, 127); assert(!/HOME=/.test(e.out), 'env CMD attempts the named command rather than printing the environment: ' + e.out);
  assert(/HOME=\//.test((await run('env')).out), 'plain env still prints');
});

await test('operands: head, tail and wc report each file; ls heads each directory; grep -h / -H', async () => {
  const { run } = await shell();
  await run("printf '1\\n2\\n3\\n' > a; printf 'x\\ny\\n' > b; mkdir -p d1 d2; touch d1/m d2/n");
  eq((await run('head -n 1 a b')).out, '==> a <==\n1\n\n==> b <==\nx', 'head shows b too');
  eq((await run('tail -n 1 a b')).out, '==> a <==\n3\n\n==> b <==\ny', 'tail shows b too');
  const miss = await run('head -n 1 a nope b'); eq(miss.code, 1);
  assert(/==> b <==\nx$/.test(miss.out), 'a missing file does not stop the rest: ' + miss.out);
  eq((await run('head -n 1 a')).out, '1', 'one file keeps the old shape');
  eq((await run('wc -l a b')).out, '3 a\n2 b\n5 total', 'wc: a row per file and a total');
  eq((await run('wc a b')).out, '3 3 6 a\n2 2 4 b\n5 5 10 total');
  eq((await run('wc -lw a')).out, '3 3', 'wc -lw prints both columns');
  eq((await run('wc -l a')).out, '3', 'one file keeps the old shape');
  eq((await run("printf 'é' | wc -c")).out, '2', 'wc -c counts bytes');
  eq((await run("printf 'é' | wc -m")).out, '1', 'wc -m counts characters');
  eq((await run('ls d1 d2')).out, 'd1:\nm\n\nd2:\nn', 'ls: each directory under its name');
  eq((await run('ls a d1 b')).out, 'a\nb\n\nd1:\nm', 'files first, then directories, as coreutils prints');
  eq((await run('ls d1')).out, 'm', 'one directory keeps the old shape');
  eq((await run('grep -h 1 a b')).out, '1', 'grep -h drops the file prefix');
  eq((await run('grep -H 1 a')).out, 'a:1', 'grep -H forces it');
  eq((await run('grep 1 a b')).out, 'a:1', 'several files still prefix by default');
});

await test('operands: find searches every start path; registry commands refuse an operand they would drop', async () => {
  const { run } = await shell();
  await run('mkdir -p s t; touch s/a.js t/b.js t/c.txt');
  eq((await run("find s t -name '*.js'")).out, 's/a.js\nt/b.js', 'find searches t as well as s');
  const late = await run('find s -name x t'); eq(late.code, 2); assert(/paths must precede the expression: t/.test(late.out), late.out);
  const gone = await run('find nope s'); eq(gone.code, 1, 'a missing start path is an error, not an empty success');
  assert(/^find: 'nope': ENOENT:/.test(gone.out), gone.out);
  eq(gone.out.split('\n').slice(1).join('\n'), 's\ns/a.js', 'later roots still include their root and matching descendants');
  eq((await run('find t/c.txt')).out, 't/c.txt', 'a file start path lists itself');
  const rd = await run('fs.read s/a.js t/b.js'); eq(rd.code, 2); assert(/extra operand 't\/b\.js'/.test(rd.out), rd.out);
  const gl = await run("glob '*.js' s t"); eq(gl.code, 2); assert(/extra operand 't'/.test(gl.out), gl.out);
  eq((await run('fs.stat s/a.js')).out, 'file 0', 'one operand still runs');
});

// A shell with a real git core, answering every confirmation `y` as the agent executor does.
async function gitShell() {
  const fs = createFileops({ backend: new MemoryBackend() });
  const registry = buildRigRegistry({ fs, git: createGitCore({ fs }) });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'a' });
  const sh = createShell({ registry, face });
  const run = async (c) => {
    let r = await sh.feed(c); const out = [r.output];
    while (sh.awaitingConfirm) { r = await sh.feed('y'); out.push(r.output); }
    const text = out.join('\n').split('\n').filter((l) => !/is destructive\. confirm\?/.test(l)).join('\n');
    return { out: text.replace(/^\n+|\n+$/g, ''), code: sh.lastCode }; // porcelain rows can start with a space
  };
  return { fs, sh, run };
}

await test('git: `git init && git add -A && git commit -m first` commits the tree; add . and -u too', async () => {
  const { fs, run } = await gitShell();
  await run("printf 1 > a; printf 2 > b; mkdir sub; printf 3 > sub/c");
  const promo = await run('git init && git add -A && git commit -m first');
  eq(promo.code, 0, 'the promo line: ' + promo.out);
  assert(!/path must not be empty/.test(promo.out), promo.out);
  assert(/^ok\nok\n\[[0-9a-f]{7}\]$/.test(promo.out), promo.out);
  eq((await run('git status')).out, '(clean)', 'every file was committed');
  eq((await run('git log')).out.split(' ').slice(1).join(' '), 'first');
  const empty = await run('git commit -m again'); eq(empty.code, 1, 'nothing staged is not a commit');
  eq(empty.out, 'nothing to commit, working tree clean');
  await run("printf 4 > sub/d; printf 33 > sub/c; cd sub");
  eq((await run('git add .')).code, 0);
  await run('cd ..');
  eq((await run('git status')).out, 'M  sub/c\nA  sub/d', 'git add . staged the cwd subtree');
  await run('git commit -m second'); await run("printf 11 > a; rm b");
  eq((await run('git status')).out, ' M a\n D b');
  const unstaged = await run('git commit -m nope'); eq(unstaged.code, 1);
  eq(unstaged.out, 'no changes added to commit (use "git add" and/or "git commit -a")');
  eq((await run('git add -u')).code, 0);
  eq((await run('git status')).out, 'M  a\nD  b', 'add -u stages the edit and the deletion');
  await run('git commit -m third'); await run('printf new > n');
  await run("printf 111 > a");
  const am = await run('git commit -am fourth'); eq(am.code, 0, am.out);
  eq((await run('git status')).out, '?? n', 'commit -a took the edit and left the untracked file');
  const nope = await run('git add missing'); eq(nope.code, 1);
  eq(nope.out, "git add: pathspec 'missing' did not match any files");
  eq((await run('git add')).code, 0, 'bare git add says nothing was added, as git does');
  const p = await run('git add -p a'); eq(p.code, 2); assert(/unsupported flag -p/.test(p.out), p.out);
  eq((await fs.stat('n')).ok, true);
});

// Forge's first-run line, observed 2026-09-29 against the pre-005f6dc shell: every form below reached
// git.add as an empty path ("path must not be empty"), so `git init && git add -A && git commit`
// never reached the commit. Each form runs in a fresh workspace seeded as Forge's seedScratch seeds one.
await test('git: add -A, --all, . and <dir> stage the seeded tree, removals too; the promo line reaches the commit confirm', async () => {
  const seeded = async ({ init = true } = {}) => {
    const g = await gitShell();
    await g.fs.write('README.md', '# Forge workspace\n');
    await g.fs.write('src/main.py', 'print("hello from Forge")\n', { createParents: true });
    if (init) eq((await g.run('git init')).code, 0);
    return g;
  };
  for (const form of ['git add -A', 'git add --all', 'git add .', 'git add -A .']) {
    const { run } = await seeded();
    const r = await run(form);
    eq(r.code, 0, `${form}: ${r.out}`);
    assert(!/path must not be empty/.test(r.out), r.out);
    eq((await run('git status')).out, 'A  README.md\nA  src/main.py', `${form} stages every untracked file`);
  }
  {
    const { run } = await seeded();
    eq((await run('git add src')).code, 0);
    eq((await run('git status')).out, 'A  src/main.py\n?? README.md', 'git add <dir> stages that directory alone');
    eq((await run('git add src/')).code, 0, 'a trailing slash names the same directory');
  }
  // Fed raw, not auto-confirmed: both adds answer ok and the chain stops at the commit's confirmation.
  const { fs, sh, run } = await seeded({ init: false });
  const promo = await sh.feed('git init && git add -A && git commit -m first');
  eq(promo.output, 'ok\nok\ngit.commit is destructive. confirm? [y/N]', 'the chain reaches the commit');
  assert(sh.awaitingConfirm, 'the commit waits for the owner');
  const committed = await sh.feed('y');
  assert(/^\[[0-9a-f]{7}\]$/.test(committed.output), committed.output);
  eq(sh.lastCode, 0);
  eq((await run('git status')).out, '(clean)');
  // A directory pathspec stages a deletion under it, and leaves the rest of the tree alone.
  await fs.remove('src/main.py'); await fs.write('README.md', 'edited\n');
  eq((await run('git add src')).code, 0);
  eq((await run('git status')).out, ' M README.md\nD  src/main.py', 'git add <dir> staged the removal');
  await run('git commit -m second');
  // -A with no pathspec covers the whole tree from a subdirectory: the edit, a new file, a removal.
  await fs.write('src/lib/util.py', 'x = 1\n', { createParents: true }); await fs.remove('README.md');
  const sub = await run('cd src && git add -A && cd ..'); eq(sub.code, 0, sub.out);
  eq((await run('git status')).out, 'D  README.md\nA  src/lib/util.py', '-A staged the removal and the new file');
});

await test('git: add . in an empty workspace and add <empty dir> exit 0, as git does; a missing path still fails', async () => {
  const { fs, run } = await gitShell();
  await run('git init');
  const dot = await run('git add .'); eq(dot.code, 0, 'git add . with nothing to add: ' + dot.out);
  eq((await run('git add -A')).code, 0);
  await run('mkdir empty');
  eq((await run('git add empty')).code, 0, 'an empty directory matches its pathspec');
  const chain = await run('git add . && git commit -m first');
  eq(chain.code, 1); eq(chain.out, 'ok\nnothing to commit, working tree clean', 'the commit, not the add, stops the chain');
  await fs.write('.gitignore', '*.log\n'); await fs.write('logs/run.log', 'x', { createParents: true });
  eq((await run('git add logs')).code, 0, 'so does a directory holding only ignored files');
  eq((await run('git status')).out, '?? .gitignore', 'and nothing ignored was staged');
  const miss = await run('git add nope/'); eq(miss.code, 1);
  eq(miss.out, "git add: pathspec 'nope/' did not match any files");
});

await test('git: rm leaves the working tree unless --cached; branch, checkout -b, diff and status answer honestly', async () => {
  const { fs, run } = await gitShell();
  await run("printf 1 > a; printf 2 > b; mkdir sub; printf 3 > sub/c; printf 4 > sub/d");
  await run('git init && git add -A && git commit -m first');
  eq((await run('git rm a')).out, "rm 'a'");
  eq((await fs.stat('a')).ok, false, 'git rm removes the file from the working tree, as git does');
  eq((await run('git rm --cached b')).out, "rm 'b'");
  eq((await fs.stat('b')).ok, true, '--cached keeps it');
  eq((await run('git status')).out, 'D  a\nD  b\n?? b');
  const dir = await run('git rm sub'); eq(dir.code, 1); assert(/without -r/.test(dir.out), dir.out);
  eq((await run('git rm -r --cached sub')).out, "rm 'sub/c'\nrm 'sub/d'");
  eq((await run('git rm nope')).code, 1, 'an unknown path is an error');
  await run('git add -A && git commit -m second');
  eq((await run('git branch')).out, '* main', 'git branch lists, marking the checked-out one');
  eq((await run('git branch feat')).code, 0, 'git branch NAME creates');
  eq((await run('git branch')).out, '  feat\n* main');
  const del = await run('git branch -d feat'); eq(del.code, 2, 'a delete is refused, never read as a create: ' + del.out);
  eq((await run('git branch')).out, '  feat\n* main');
  eq((await run('git checkout -b feat2')).code, 0);
  eq((await run('git branch')).out, '  feat\n* feat2\n  main', 'checkout -b moved the mark');
  await run("printf changed > sub/c");
  eq((await run('git diff')).out, 'diff --git a/sub/c b/sub/c\n--- a/sub/c\n+++ b/sub/c\n@@ -1 +1 @@\n-3\n\\ No newline at end of file\n+changed\n\\ No newline at end of file', 'git diff prints the patch');
  eq((await run('git diff --name-status')).out, 'M\tsub/c');
  eq((await run('git diff --name-only -- sub')).out, 'sub/c');
  eq((await run('git diff --name-only -- other')).out, '', 'a path filter');
  eq((await run('git diff --quiet')).code, 1, '--quiet exits 1 on a change');
  await run('git add sub/c');
  eq((await run('git diff --quiet')).code, 0, 'the working tree now matches the index');
  eq((await run('git diff --cached --name-status')).out, 'M\tsub/c');
  eq((await run('git diff HEAD --name-only')).out, 'sub/c');
  await run('printf z > z');
  eq((await run('git status')).out, 'M  sub/c\n?? z');
  eq((await run('git status sub/c b')).out, 'M  sub/c', 'status reads every pathspec, and only those');
  eq((await run('git status z')).out, '?? z');
  eq((await run('git log -1')).out.split(' ').slice(1).join(' '), 'second');
  eq((await run('git checkout -- sub/c')).code, 2, 'restoring a file is refused, not read as a ref');
  eq((await run('git commit -m x sub/c')).code, 2, 'a commit pathspec is refused');
  eq((await run('git log -- a')).code, 2);
});

// ── Lenient successes and loud divergences found by the operand audit (2026-09-29) ─────────
await test('mkdir, touch, chmod and printf fail where coreutils fails, instead of exiting 0', async () => {
  const { run } = await shell();
  await run('mkdir d');
  const again = await run('mkdir d'); eq(again.code, 1, 'mkdir on an existing path fails without -p');
  eq(again.out, 'mkdir: EEXIST: already exists: d');
  eq((await run('mkdir d || echo fallback')).out.split('\n').pop(), 'fallback', 'so `mkdir d || …` takes its fallback');
  eq((await run('mkdir -p d')).code, 0, 'with -p an existing directory is fine');
  const deep = await run('mkdir x/y'); eq(deep.code, 1, 'a missing parent fails without -p');
  eq((await run('ls x')).code, 1, 'and x was not created');
  eq((await run('mkdir -p x/y && ls x')).out, 'y', '-p still makes parents');
  const t = await run('touch nodir/f'); eq(t.code, 1, 'touch into a missing directory fails');
  eq(t.out, 'touch: ENOENT: no such directory: nodir');
  eq((await run('ls nodir')).code, 1, 'and makes no directory');
  await run('touch d/f');
  eq((await run('touch d/f/g')).code, 1, 'a file as the parent fails');
  eq((await run('chmod +x d/f')).code, 0, 'chmod on a file that exists is a no-op success');
  const cm = await run('chmod 755 d/f nope'); eq(cm.code, 1); eq(cm.out, "chmod: cannot access 'nope': ENOENT");
  eq((await run('chmod zz d/f')).code, 1, 'an invalid mode fails');
  eq((await run('chmod -v 755 d/f')).code, 2, 'an unsupported flag refuses');
  eq((await run('chmod -x d/f')).code, 0, '-x is a mode, not a flag');
  const pf = await run("printf '%d\\n' 12abc"); eq(pf.code, 1, 'a non-number for %d fails');
  eq(pf.out, '12\nprintf: 12abc: invalid number');
  eq((await run("printf '%d|' 0x1f \"'A\" 010 -3 ''")).out, '31|65|8|-3|0|', 'hex, a character, octal, negative and empty are numbers');
});

await test('mv and cp replace a destination file; a directory into itself is refused, not deleted', async () => {
  const { run } = await shell();
  await run("printf 1 > a; printf 2 > b; mkdir d; printf keep > d/f");
  eq((await run('cp a b && cat b')).out, '1', 'cp replaces an existing file');
  await run('printf 3 > c');
  eq((await run('mv c b && cat b')).out, '3', 'mv replaces an existing file');
  eq((await run('ls')).out, 'a  b  d  f.txt', 'and the source is gone');
  const self = await run('mv d d'); eq(self.code, 1, 'mv d d is refused');
  eq(self.out, 'mv: EINVAL: cannot copy d into itself: d/d');
  const sub = await run('mv d d/sub'); eq(sub.code, 1, 'mv into its own subdirectory is refused');
  eq((await run('cat d/f')).out, 'keep', 'and d is intact (both used to delete it, exit 0)');
  eq((await run('cp -r d d/x')).code, 1);
  eq((await run('cp a a')).out, 'cp: EINVAL: source and destination are the same: a');
  eq((await run('cp d a')).code, 1, 'a directory never replaces a file');
  eq((await run('cat a')).out, '1');
});

await test('cat, cut, sed, grep and od go on past a missing file; sort stops; grep -c counts per file', async () => {
  const { run } = await shell();
  await run("printf 'a1\\nb2\\n' > a; printf 'c3\\n' > b; printf x > nonl");
  const c = await run('cat a nope b'); eq(c.code, 1);
  eq(c.out, 'a1\nb2\ncat: nope: ENOENT\nc3', 'cat prints b too, the error in its place');
  eq((await run('cat nonl nope')).out, 'x\ncat: nope: ENOENT', 'the error starts its own line');
  eq((await run('cat a b')).out, 'a1\nb2\nc3', 'every file present is unchanged');
  const cu = await run('cut -c1 a nope b'); eq(cu.code, 1); eq(cu.out, 'cut: nope: ENOENT\na\nb\nc');
  const se = await run("sed 's/[0-9]//' a nope b"); eq(se.code, 1); eq(se.out, 'sed: nope: ENOENT\na\nb\nc');
  const g = await run('grep 1 a nope b'); eq(g.code, 2, 'grep: an unreadable file is exit 2'); eq(g.out, 'a:a1\ngrep: nope: ENOENT', 'and the match in a survives');
  eq((await run('grep -c . a b')).out, 'a:2\nb:1', 'grep -c counts per file');
  eq((await run('grep -hc . a b')).out, '2\n1');
  eq((await run('grep -c . a')).out, '2', 'one file keeps the bare count');
  const od = await run('od -c nope nonl'); eq(od.code, 1); eq(od.out, 'od: nope: ENOENT\n0000000   x\n0000001', 'od still dumps the file it could read');
  const so = await run('sort a nope'); eq(so.code, 1, 'sort stops, as coreutils sort does'); eq(so.out, 'sort: nope: ENOENT');
});

await test('diff matches lines by a real diff; -u writes a patch that `fs.patch` applies', async () => {
  const { run } = await shell();
  await run("printf 'a\\nb\\nc\\n' > p; printf 'z\\na\\nb\\nc\\n' > q");
  eq((await run('diff p q')).out, '+ z', 'one inserted line is one change (it used to be every line)');
  const u = await run('diff -u p q'); eq(u.code, 1);
  eq(u.out, '--- p\n+++ q\n@@ -1,3 +1,4 @@\n+z\n a\n b\n c');
  await run('diff -u p q > p.diff');
  const diffText = (await run('cat p.diff')).out + '\n';
  const applied = await run(`fs.patch p --unifiedDiff='${diffText}'`);
  eq(applied.code, 0, 'the diff applies: ' + applied.out);
  eq((await run('diff p q')).code, 0, 'and p now equals q');
});

await test('git: diff prints patches from the index, HEAD or a ref; log reads HEAD~N; no repository is an error', async () => {
  const { fs, run } = await gitShell();
  const none = await run('git status'); eq(none.code, 1, 'no repository is an error, not a list of untracked files');
  assert(/not a git repository/.test(none.out), none.out);
  await run("printf 'a\\nb\\nc\\n' > f; printf 'x\\n' > g");
  await run('git init && git add -A && git commit -m one');
  await run("printf 'a\\nB\\nc\\n' > f; rm g; printf 'new\\n' > n; git add n");
  eq((await run('git diff')).out, [
    'diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c',
    'diff --git a/g b/g', 'deleted file mode 100644', '--- a/g', '+++ /dev/null', '@@ -1 +0,0 @@', '-x'].join('\n'), 'git diff: the working tree against the index');
  eq((await run('git diff --cached')).out, ['diff --git a/n b/n', 'new file mode 100644', '--- /dev/null', '+++ b/n', '@@ -0,0 +1 @@', '+new'].join('\n'), '--cached: the index against HEAD');
  eq((await run('git diff HEAD --name-status')).out, 'M\tf\nD\tg\nA\tn');
  await run('git add -A && git commit -m two');
  eq((await run('git log --oneline HEAD~1')).out.split(' ').slice(1).join(' '), 'one', 'git log HEAD~1');
  eq((await run('git diff HEAD~1 HEAD --name-only')).out, 'f\ng\nn');
  eq((await run('git diff HEAD^ -- f')).out, ['diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'].join('\n'), 'HEAD^ and a path filter');
  eq((await run('git log HEAD~5')).code, 1, 'past the root is an error');
  // the patch git diff prints is one fs.patch applies
  await run("printf 'a\\nB\\nC\\n' > f");
  const p = (await run('git diff -- f')).out + '\n';
  await run("printf 'a\\nB\\nc\\n' > f2");
  eq((await run(`fs.patch f2 --unifiedDiff='${p}'`)).code, 0, 'git diff output applies with fs.patch');
  eq((await run('cat f2')).out, 'a\nB\nC');
  await fs.write('bin', Uint8Array.of(0, 1, 2)); await run('git add bin && git commit -m bin'); await fs.write('bin', Uint8Array.of(0, 9));
  assert((await run('git diff')).out.startsWith('diff --git a/bin b/bin\nBinary files a/bin and b/bin differ\ndiff --git a/f b/f'), 'binary content is not printed');
});

if (failures.length) {
  console.error(`shell false-friends: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}\n        ${f.message}`);
  process.exit(1);
}
console.log(`shell false-friends: ${passed}/${passed} passed — no builtin answers wrongly with exit 0`);
