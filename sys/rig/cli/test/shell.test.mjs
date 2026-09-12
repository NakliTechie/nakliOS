// C5 Layer-1 conformance — the bash-style shell core over the Rig registry.
//
//   node sys/rig/cli/test/shell.test.mjs
//
// Drives createShell over an in-memory Rig backend (fileops + agent face) and
// checks the shell mechanics: cwd/cd, bare fs verbs, coreutils builtins, pipes,
// redirects, path resolution, and destructive staging through the C4 face.
// xterm is not involved — this is the headless system under test.

import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { createGitCore } from '../../git/git-core.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';
import { createShell } from '../shell.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push({ name, message: e.message }); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function freshShell({ git: withGit = false } = {}) {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });
  const git = withGit ? createGitCore({ fs, dir: '/' }) : undefined;
  const registry = buildRigRegistry({ fs, git });
  const grant = createGrant({
    prefixes: [''],
    scopes: ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write'],
  });
  // Op-log on its own backend so its jsonl never pollutes a git working tree.
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent' });
  return { face, shell: createShell({ registry, face }) };
}
const run = async (shell, line) => (await shell.feed(line)).output;

await test('pwd starts at root and cd navigates', async () => {
  const { shell } = freshShell();
  eq(await run(shell, 'pwd'), '/', 'root pwd');
  await run(shell, 'mkdir -p src/lib');
  await run(shell, 'cd src');
  eq(await run(shell, 'pwd'), '/src', 'cd into src');
  eq(shell.cwd, 'src', 'cwd getter');
  await run(shell, 'cd lib');
  eq(await run(shell, 'pwd'), '/src/lib', 'nested cd');
  await run(shell, 'cd ..');
  eq(await run(shell, 'pwd'), '/src', 'cd ..');
  await run(shell, 'cd /');
  eq(await run(shell, 'pwd'), '/', 'cd /');
});

await test('echo, redirect (>), append (>>), and cat', async () => {
  const { shell } = freshShell();
  eq(await run(shell, 'echo hello world'), 'hello world', 'echo');
  await run(shell, 'echo line1 > notes.txt');
  eq(await run(shell, 'cat notes.txt'), 'line1', 'redirect wrote file');
  await run(shell, 'echo line2 >> notes.txt');
  eq(await run(shell, 'cat notes.txt'), 'line1\nline2', 'append keeps line separators');
});

await test('2>&1 and friends are no-ops, never a literal &1 file', async () => {
  const { shell } = freshShell();
  // `echo hi 2>&1` prints hi and writes NO `&1` file.
  eq(await run(shell, 'echo hi 2>&1'), 'hi', '2>&1 leaves output intact');
  const afterAmp1 = await run(shell, 'cat "&1"');
  assert(/error|not|ENOENT|failed/i.test(afterAmp1), `no &1 file created: ${afterAmp1}`);
  // The `2` fd is not leaked as an argument.
  eq(await run(shell, 'echo start 2>&1'), 'start', 'fd prefix stripped, not echoed');
  // Other merge forms are equally inert.
  eq(await run(shell, 'echo a 1>&2'), 'a', '1>&2 no-op');
  eq(await run(shell, 'echo b 2>&-'), 'b', '2>&- close-fd no-op');
});

await test('2>&1 pipes correctly into the next stage', async () => {
  const { shell } = freshShell();
  await run(shell, 'echo xylophone > w.txt');
  await run(shell, 'echo banana >> w.txt');
  eq(await run(shell, 'cat w.txt 2>&1 | grep x'), 'xylophone', '2>&1 before a pipe still pipes');
});

await test('real > and >> redirects survive the merge-idiom handling', async () => {
  const { shell } = freshShell();
  await run(shell, 'echo one > out.txt');
  eq(await run(shell, 'cat out.txt'), 'one', '> still writes');
  await run(shell, 'echo two >> out.txt');
  eq(await run(shell, 'cat out.txt'), 'one\ntwo', '>> still appends');
  // `2>file` collapses to a merged redirect (fd stripped, no `2` argument).
  await run(shell, 'echo merged 2> both.txt');
  eq(await run(shell, 'cat both.txt'), 'merged', '2>file writes the merged stream');
  // `&>file` redirects the combined stream too.
  await run(shell, 'echo combo &> c.txt');
  eq(await run(shell, 'cat c.txt'), 'combo', '&>file writes combined stream');
});

await test('ls lists names and respects cwd + relative paths', async () => {
  const { shell } = freshShell();
  await run(shell, 'mkdir -p proj');
  await run(shell, 'echo a > proj/a.txt');
  await run(shell, 'echo b > proj/b.txt');
  const ls = await run(shell, 'ls proj');
  assert(ls.includes('a.txt') && ls.includes('b.txt'), `ls proj: ${ls}`);
  await run(shell, 'cd proj');
  eq(await run(shell, 'cat a.txt'), 'a', 'relative cat resolves against cwd');
});

await test('pipes: cat | grep, wc, head, tail', async () => {
  const { shell } = freshShell();
  await run(shell, 'echo apple > f.txt');
  await run(shell, 'echo banana >> f.txt');
  await run(shell, 'echo cherry >> f.txt');
  eq(await run(shell, 'cat f.txt | grep e'), 'apple\ncherry', 'grep filters piped lines');
  eq(await run(shell, 'cat f.txt | wc'), '3 3 20', 'wc counts lines words chars');
  eq(await run(shell, 'cat f.txt | head -2'), 'apple\nbanana', 'head -2');
  eq(await run(shell, 'cat f.txt | tail -1'), 'cherry', 'tail -1');
});

await test('grep -n and grep over a named file', async () => {
  const { shell } = freshShell();
  await run(shell, 'echo one > log.txt');
  await run(shell, 'echo two >> log.txt');
  await run(shell, 'echo three >> log.txt');
  eq(await run(shell, 'grep t log.txt'), 'two\nthree', 'grep file');
  eq(await run(shell, 'cat log.txt | grep -n t'), '2:two\n3:three', 'grep -n line numbers');
});

await test('rm is destructive: stages, then removes on y', async () => {
  const { shell } = freshShell();
  await run(shell, 'echo x > gone.txt');
  const staged = await run(shell, 'rm gone.txt');
  assert(/destructive/.test(staged), `rm should stage: ${staged}`);
  assert(shell.awaitingConfirm, 'awaitingConfirm set');
  await run(shell, 'y');
  assert(!shell.awaitingConfirm, 'confirm cleared');
  const after = await run(shell, 'cat gone.txt');
  assert(/error|not|ENOENT|failed/i.test(after), `file should be gone: ${after}`);
});

await test('rm cancelled on n leaves the file', async () => {
  const { shell } = freshShell();
  await run(shell, 'echo keep > keep.txt');
  await run(shell, 'rm keep.txt');
  const cancelled = await run(shell, 'n');
  assert(/cancelled/.test(cancelled), `should cancel: ${cancelled}`);
  eq(await run(shell, 'cat keep.txt'), 'keep', 'file survives');
});

await test('&& short-circuits on failure', async () => {
  const { shell } = freshShell();
  const out = await run(shell, 'cat nope.txt && echo REACHED');
  assert(!out.includes('REACHED'), `&& should not reach after failure: ${out}`);
  const out2 = await run(shell, 'echo ok && echo REACHED');
  assert(out2.includes('REACHED'), `&& should reach after success: ${out2}`);
});

await test('unknown command is reported, not spawned', async () => {
  const { shell } = freshShell();
  const out = await run(shell, 'sudo rm -rf /');
  assert(/command not found/.test(out), `unknown: ${out}`);
});

await test('mv and cp move/copy through the registry', async () => {
  const { shell } = freshShell();
  await run(shell, 'echo data > a.txt');
  await run(shell, 'cp a.txt b.txt');
  eq(await run(shell, 'cat b.txt'), 'data', 'cp');
  await run(shell, 'mv b.txt c.txt');
  eq(await run(shell, 'cat c.txt'), 'data', 'mv target');
  const afterMv = await run(shell, 'cat b.txt');
  assert(/error|not|ENOENT/i.test(afterMv), 'mv removed source');
});

await test('git: init, add, commit (staged), status, log', async () => {
  const { shell } = freshShell({ git: true });
  eq(await run(shell, 'git init'), 'ok', 'git init');
  await run(shell, 'echo hello > a.txt');
  const untracked = await run(shell, 'git status');
  assert(/\?\?\s+a\.txt/.test(untracked), `untracked shown: ${untracked}`);
  eq(await run(shell, 'git add a.txt'), 'ok', 'git add');
  const staged = await run(shell, 'git status');
  assert(/A\s+a\.txt/.test(staged), `staged shown: ${staged}`);
  const commitPrompt = await run(shell, 'git commit -m "first"');
  assert(/destructive/.test(commitPrompt), `commit stages: ${commitPrompt}`);
  await run(shell, 'y');
  eq(await run(shell, 'git status'), '(clean)', 'clean after commit');
  const log = await run(shell, 'git log');
  assert(/first/.test(log), `log shows message: ${log}`);
});

await test('variables: assignment, $VAR, ${VAR}, export/env/unset', async () => {
  const { shell } = freshShell();
  await run(shell, 'NAME=world');
  eq(await run(shell, 'echo hello $NAME'), 'hello world', '$VAR expands');
  eq(await run(shell, 'echo ${NAME}!'), 'world!', '${VAR} braces');
  await run(shell, 'export FOO=bar');
  const env = await run(shell, 'env');
  assert(/FOO=bar/.test(env) && /HOME=\//.test(env) && /PWD=\//.test(env), `env lists vars: ${env}`);
  await run(shell, 'unset NAME');
  eq(await run(shell, 'echo [$NAME]'), '[]', 'unset clears');
});

await test('$? reflects the last exit code; $PWD tracks cwd', async () => {
  const { shell } = freshShell();
  eq(await run(shell, 'echo $?'), '0', 'zero after success');
  await run(shell, 'cat nope.txt');           // fails
  eq(await run(shell, 'echo $?'), '1', 'one after failure');
  await run(shell, 'mkdir -p src');
  await run(shell, 'cd src');
  eq(await run(shell, 'echo $PWD'), '/src', '$PWD tracks cwd');
});

await test('variables expand in redirects and cd targets', async () => {
  const { shell } = freshShell();
  await run(shell, 'F=out.txt');
  await run(shell, 'echo hi > $F');
  eq(await run(shell, 'cat out.txt'), 'hi', 'redirect target expanded');
  await run(shell, 'mkdir -p work');
  await run(shell, 'D=work');
  await run(shell, 'cd $D');
  eq(await run(shell, 'pwd'), '/work', 'cd target expanded');
});

await test('glob expansion: *.txt expands, no-match stays literal', async () => {
  const { shell } = freshShell();
  await run(shell, 'echo A > a.txt');
  await run(shell, 'echo B > b.txt');
  await run(shell, 'echo C > c.md');
  eq(await run(shell, 'echo *.txt'), 'a.txt b.txt', '*.txt expands to sorted matches');
  eq(await run(shell, 'cat *.txt'), 'A\nB', 'cat over a glob reads each match');
  eq(await run(shell, 'echo *.xyz'), '*.xyz', 'no match keeps the literal (nullglob off)');
  await run(shell, 'mkdir -p src');
  await run(shell, 'echo X > src/x.txt');
  await run(shell, 'cd src');
  eq(await run(shell, 'echo *.txt'), 'x.txt', 'glob is cwd-relative after cd');
});

await test('ls on a FILE prints the name (not ENOTDIR)', async () => {
  const { shell } = freshShell();
  await run(shell, 'mkdir -p notes');
  await run(shell, 'echo hi > notes/todo.txt');
  eq(await run(shell, 'ls notes/todo.txt'), 'notes/todo.txt', 'ls of a file → the file, not an error');
  const dir = await run(shell, 'ls notes');
  assert(dir.includes('todo.txt'), `ls of a dir still lists: ${dir}`);
});

await test('printf: %s/%d, backslash escapes, verbatim redirect (no forced newline)', async () => {
  const { shell } = freshShell();
  eq(await run(shell, 'printf %s hello'), 'hello', '%s');
  eq(await run(shell, 'printf "a\\nb\\n"'), 'a\nb', 'backslash-n makes real newlines');
  eq(await run(shell, 'printf "%s=%d" x 7'), 'x=7', '%s and %d');
  await run(shell, "printf 'buy milk\\ncall mom\\n' > t.txt");
  eq(await run(shell, 'cat t.txt'), 'buy milk\ncall mom', 'printf redirect writes exact bytes');
});

await test('test / [ ] condition primitive composes with && and ||', async () => {
  const { shell } = freshShell();
  await run(shell, 'mkdir -p d');
  await run(shell, 'echo x > d/f.txt');
  eq(await run(shell, '[ -d d ] && echo yes'), 'yes', '-d on a dir');
  eq(await run(shell, '[ -f d ] && echo a || echo b'), 'b', '-f on a dir is false → || branch');
  eq(await run(shell, '[ -f d/f.txt ] && echo file'), 'file', '-f on a file');
  eq(await run(shell, "test -z '' && echo empty"), 'empty', '-z empty string');
  eq(await run(shell, "test -n x && echo nonempty"), 'nonempty', '-n non-empty');
  eq(await run(shell, '[ 3 -gt 2 ] && echo big'), 'big', 'integer -gt');
  eq(await run(shell, '[ foo = foo ] && echo same'), 'same', 'string equality');
  eq(await run(shell, '[ foo = bar ] || echo diff'), 'diff', 'string inequality → ||');
});

await test('|| runs the next only on failure; && only on success', async () => {
  const { shell } = freshShell();
  eq(await run(shell, 'echo ok && echo reached'), 'ok\nreached', '&& after success');
  const out = await run(shell, 'cat nope.txt || echo recovered');
  assert(/recovered/.test(out), `|| runs after failure: ${out}`);
  const out2 = await run(shell, 'echo done || echo skipped');
  assert(out2.includes('done') && !out2.includes('skipped'), `|| skipped after success: ${out2}`);
});

await test('sed: s/// substitution and -n print', async () => {
  const { shell } = freshShell();
  await run(shell, 'echo hello > f.txt');
  eq(await run(shell, 'echo hi | sed s/hi/bye/'), 'bye', 's/// on stdin');
  await run(shell, 'echo aaa > g.txt');
  eq(await run(shell, 'cat g.txt | sed s/a/b/g'), 'bbb', 's///g global');
  await run(shell, 'echo one > multi.txt');
  await run(shell, 'echo two >> multi.txt');
  eq(await run(shell, 'cat multi.txt | sed -n /two/p'), 'two', '-n /re/p prints matches');
});

await test('rg: recursive content search with -l and line output', async () => {
  const { shell } = freshShell();
  await run(shell, 'mkdir -p src');
  await run(shell, "printf 'import os\\nprint(os)\\n' > src/a.py");
  await run(shell, "printf 'x=1\\nimport sys\\n' > src/b.py");
  eq(await run(shell, 'rg import src'), 'src/a.py:1:import os\nsrc/b.py:2:import sys', 'path:line:text');
  eq(await run(shell, 'rg -l import src'), 'src/a.py\nsrc/b.py', 'files-with-matches');
});

await test('awk: field print with default and -F separators', async () => {
  const { shell } = freshShell();
  eq(await run(shell, "echo 'a b c' | awk '{print $2}'"), 'b', 'whitespace field');
  eq(await run(shell, "printf 'root:0\\ndaemon:1\\n' | awk -F: '{print $1}'"), 'root\ndaemon', '-F: attached');
});

await test('cut, tr, tee, xargs, basename, dirname, diff', async () => {
  const { shell } = freshShell();
  eq(await run(shell, "echo 'a:b:c' | cut -d: -f2"), 'b', 'cut -d -f');
  eq(await run(shell, 'echo hello | tr l L'), 'heLLo', 'tr translate');
  eq(await run(shell, "echo 'a b' | tr -d ' '"), 'ab', 'tr -d delete');
  eq(await run(shell, 'basename /a/b/c.txt .txt'), 'c', 'basename with suffix');
  eq(await run(shell, 'dirname /a/b/c.txt'), '/a/b', 'dirname');
  eq(await run(shell, 'echo hi | tee out.txt'), 'hi', 'tee passthrough');
  eq(await run(shell, 'cat out.txt'), 'hi', 'tee wrote the file');
  eq(await run(shell, "echo 'x y' | xargs echo args:"), 'args: x y', 'xargs appends stdin');
  await run(shell, "printf 'l1\\nl2\\n' > a.txt");
  await run(shell, "printf 'l1\\nX\\n' > b.txt");
  eq(await run(shell, 'diff a.txt b.txt'), '- l2\n+ X', 'diff line change');
});

await test('python dispatch: -c code, <file>, and the unavailable message', async () => {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent' });
  const kiln = {
    exec: async (_id, code) => (code.includes('BROKEN')
      ? { status: 'unavailable', message: 'no kernel' }
      : { status: 'ok', stdout: 'RAN:' + code }),
  };
  const shell = createShell({ registry, face, kiln });
  eq((await run(shell, 'python -c "print(1)"')), 'RAN:print(1)', '-c passes the code string');
  await run(shell, 'echo import sys > s.py');
  eq((await run(shell, 'python s.py')), 'RAN:import sys', '<file> reads the file as code');
  eq((await run(shell, 'python -c "BROKEN"')), 'python: no kernel', 'unavailable surfaces the message');
  // sys.exit(n) rides through as the exit code — a gate ending `sys.exit(main())` must be green on 0.
  const exiting = createShell({ registry, face, kiln: { exec: async (_id, code) => (/exit3/.test(code) ? { status: 'error', code: 3, stdout: '', stderr: '' } : { status: 'ok', code: 0, stdout: 'fine\n', stderr: '' }) } });
  await run(exiting, 'python -c "exit0"'); eq(exiting.lastCode, 0, 'sys.exit(0) → exit 0');
  await run(exiting, 'python -c "exit3"'); eq(exiting.lastCode, 3, 'sys.exit(3) → exit 3, the number the program said');
  // No kiln → honest degrade.
  const { shell: bare } = freshShell();
  assert(/cross-origin isolation/.test(await run(bare, 'python -c "print(1)"')), 'no kiln → COI notice');
});

await test('reset(): a run starts at the root with no inherited cwd or vars', async () => {
  const { shell } = freshShell();
  await run(shell, 'mkdir -p sub/dir');
  await run(shell, 'cd sub/dir'); eq(shell.cwd, 'sub/dir', 'cd moved the cwd');
  await run(shell, 'X=leaked');  eq(await run(shell, 'echo $X'), 'leaked', 'a var is set');
  await run(shell, 'false');
  shell.reset();
  eq(shell.cwd, '', 'reset returns to the root');
  eq(await run(shell, 'echo [$X]'), '[]', 'and forgets the var');
  eq(shell.lastCode, 0, 'and the last exit code');
  await run(shell, 'echo hi > here.txt');
  eq(await run(shell, 'cat here.txt'), 'hi', 'a relative write after reset lands at the root, not in sub/dir');
  eq(await run(shell, 'cat sub/dir/here.txt'), 'cat: sub/dir/here.txt: ENOENT', 'not where the old cwd pointed');
});

await test('defect 7: the kernel is asked to run where the shell is — cd moves python, reset brings it back', async () => {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent' });
  const cwds = [];
  const kiln = { exec: async (_id, code, opts) => { cwds.push(opts && opts.cwd); return { status: 'ok', stdout: 'ran:' + code }; } };
  const shell = createShell({ registry, face, kiln });
  await fs.write('sub/x.py', 'print(1)');
  await run(shell, 'python -c "a"');            eq(cwds[0], '', 'at the root, cwd is the root');
  await run(shell, 'cd sub');
  eq(await run(shell, 'python x.py'), 'ran:print(1)', 'the script is read relative to the shell cwd');
  eq(cwds[1], 'sub', 'and the kernel is told to run there — the two agree');
  shell.reset();
  await run(shell, 'python -c "b"');            eq(cwds[2], '', 'a reset run is back at the root');
});

await test('python: the script gets its sys.argv, and the kernel\'s interleaved output is what the shell shows', async () => {
  const fs = createFileops({ backend: new MemoryBackend() });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent' });
  const argvs = [], stdins = [];
  const kiln = { exec: async (_id, _code, opts) => { argvs.push(opts && opts.argv); stdins.push(opts && opts.stdin); return { status: 'ok', stdout: 'out1\nout2\n', stderr: 'err1\n', output: 'out1\nerr1\nout2\n' }; } };
  const shell = createShell({ registry, face, kiln });
  await fs.write('t.py', 'print(1)');
  eq(await run(shell, 'python t.py a b'), 'out1\nerr1\nout2', 'the shell shows the streams in the order they were written, not stdout-then-stderr');
  eq(JSON.stringify(argvs[0]), '["t.py","a","b"]', 'a file run: argv is the file and its arguments, as CPython sets it');
  await run(shell, 'python -c "print(2)" x');
  eq(JSON.stringify(argvs[1]), '["-c","x"]', 'a -c run: argv starts with -c');
  await fs.write('in.md', '# T\n');
  await run(shell, 'python t.py < in.md');
  eq(stdins[2], '# T\n', '`< file` is the script\'s stdin');
  await run(shell, 'cat in.md | python t.py');
  eq(stdins[3], '# T\n', 'and so is a pipe');
  eq(stdins[0], '', 'nothing fed → empty, never undefined');
  // a runtime without `output` (an older kernel) still hands back both streams
  const old = { exec: async () => ({ status: 'ok', stdout: 'o\n', stderr: 'e\n' }) };
  const shell2 = createShell({ registry, face, kiln: old });
  eq(await run(shell2, 'python t.py'), 'o\ne', 'stdout then stderr when the kernel has no interleaved stream');
});

await test('rm *.glob fans out to every match, one confirm', async () => {
  const { shell } = freshShell();
  await run(shell, 'echo a > a.txt');
  await run(shell, 'echo b > b.txt');
  await run(shell, 'echo c > c.txt');
  await run(shell, 'echo keep > keep.md');
  const staged = await run(shell, 'rm *.txt');
  assert(/destructive/.test(staged), `rm *.txt should stage: ${staged}`);
  assert(shell.awaitingConfirm, 'one confirm for the whole glob');
  await run(shell, 'y');
  assert(!shell.awaitingConfirm, 'confirm cleared');
  for (const f of ['a.txt', 'b.txt', 'c.txt']) {
    assert(/error|not|ENOENT|failed/i.test(await run(shell, `cat ${f}`)), `${f} should be gone`);
  }
  eq(await run(shell, 'cat keep.md'), 'keep', 'non-matching file untouched');
});

await test('rm *.glob cancelled on n leaves every match', async () => {
  const { shell } = freshShell();
  await run(shell, 'echo a > a.txt');
  await run(shell, 'echo b > b.txt');
  await run(shell, 'rm *.txt');
  const cancelled = await run(shell, 'n');
  assert(/cancelled/.test(cancelled), `should cancel: ${cancelled}`);
  eq(await run(shell, 'cat a.txt'), 'a', 'a.txt survives');
  eq(await run(shell, 'cat b.txt'), 'b', 'b.txt survives');
});

await test('git add *.glob stages every match', async () => {
  const { shell } = freshShell({ git: true });
  await run(shell, 'git init');
  await run(shell, 'echo a > a.txt');
  await run(shell, 'echo b > b.txt');
  await run(shell, 'echo c > c.txt');
  eq(await run(shell, 'git add *.txt'), 'ok', 'git add *.txt returns ok');
  const status = await run(shell, 'git status');
  for (const f of ['a.txt', 'b.txt', 'c.txt']) {
    assert(new RegExp(`A\\s+${f}`).test(status), `${f} staged: ${status}`);
  }
});

if (failures.length) {
  console.error(`shell core: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`C5-L1/shell conformance: ${passed}/${passed} passed`);
