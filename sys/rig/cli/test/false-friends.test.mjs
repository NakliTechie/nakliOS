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
import { createShell } from '../shell.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';

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
await test('R2b: grep -v excludes, -i matches, -c counts, -r refuses', async () => {
  const { run } = await shell();
  // the worst one: -v returned exactly the lines it was asked to suppress
  eq((await run('grep -v banana f.txt')).out, 'Apple\nCherry', '-v EXCLUDES');
  eq((await run('grep -i apple f.txt')).out, 'Apple', '-i is case-insensitive');
  eq((await run('grep -c banana f.txt')).out, '2', '-c counts');
  eq((await run('grep -n Cherry f.txt')).out, '3:Cherry', '-n still numbers');
  const r = await run('grep -r x f.txt');
  assert(r.code !== 0 && /rg/.test(r.out), `-r refuses and names the alternative: ${JSON.stringify(r)}`);
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
  assert(found.includes('sub/two.txt'), `a quoted glob reaches the command: ${JSON.stringify(found)}`);
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
  eq(named, 'drop.log', `-name filters (it used to return everything): ${named}`);
  assert(!(await run("find . -name '*.log'")).out.includes('keep.txt'), '-name really excludes');
  await run("printf 'z\\n' > nested/deep.txt");
  const dirs = (await run('find . -type d')).out.split('\n').sort();
  eq(dirs.join('|'), 'nested', '-type d returns exactly the directories');
  const files = (await run('find . -type f')).out.split('\n').sort();
  assert(files.includes('nested/deep.txt') && !files.includes('nested'), `-type f returns files and no directory: ${files}`);
  assert(files.length >= 3, `-type f is not empty — returning nothing must not pass: ${files}`);
  // -maxdepth had no assertion at all; a mutation disabling it survived
  const d1 = (await run('find . -maxdepth 1')).out.split('\n').sort();
  assert(!d1.includes('nested/deep.txt'), `-maxdepth 1 excludes a deeper file: ${d1}`);
  assert(d1.includes('keep.txt'), `-maxdepth 1 keeps a top-level file: ${d1}`);
  for (const [cmd, why] of [['find . -newer x', 'an unimplemented predicate'],
                            ['find . -type X', 'an invalid -type value'],
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

  const badFlag = await run('rg "solve" -A 3');
  assert(/unsupported flag -A/.test(badFlag.out), `an unimplemented flag is refused: ${badFlag.out}`);
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
  assert(/no -r/.test(h) && /rg/.test(h), 'help names grep -r and its alternative');
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
  eq(f.out, '.anvil/gate/x.py', 'stdout survives a 2>/dev/null'); eq(f.code, 0, 'exit 0');
  const l = await run('ls f.txt 2>/dev/null'); eq(l.out, 'f.txt', 'ordinary output survives too');
  const d = await run('ls > /dev/null'); eq(d.out, '', '> /dev/null discards'); eq(d.code, 0, 'and succeeds');
  const d2 = await run('ls >/dev/null'); eq(d2.out, '', 'with or without the space');
  const a = await run('cat nope.txt 2>/dev/null; echo after'); assert(/after$/.test(a.out), 'the statement after still runs: ' + JSON.stringify(a.out));
  const dev = await run('ls dev'); assert(dev.code !== 0, 'no dev/ directory was ever created: ' + JSON.stringify(dev.out));
  const real = await run('ls > listing.txt; cat listing.txt'); assert(/f\.txt/.test(real.out), 'a real redirect still writes its file');
});

if (failures.length) {
  console.error(`shell false-friends: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}\n        ${f.message}`);
  process.exit(1);
}
console.log(`shell false-friends: ${passed}/${passed} passed — no builtin answers wrongly with exit 0`);
