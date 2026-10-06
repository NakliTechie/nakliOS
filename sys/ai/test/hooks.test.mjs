// Conformance — per-project tool hooks (pure).
//   node sys/ai/test/hooks.test.mjs
import { parseHooks, globMatch, hookMatches, hookCommand, preToolDecision, postToolCommands, HOOKS_FILE }
  from '../hooks.mjs';

let passed = 0; const failures = [];
async function test(n, fn){ try { await fn(); passed++; } catch (e){ failures.push({ n, message: e.message }); } }
function assert(c, m){ if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m){ if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

await test('parseHooks: tolerant of junk/absent', () => {
  const empty = parseHooks('');
  assert(Array.isArray(empty.preTool) && Array.isArray(empty.postTool), 'shape on empty');
  eq(parseHooks('not json').postTool.length, 0, 'bad json never runs post hooks');
  eq(parseHooks(null).preTool.length, 0, 'null → empty');
  const p = parseHooks('{"postTool":[{"on":"write","run":"x"}], "preTool":[{"on":"shell","block":"no"}], "junk":1}');
  eq(p.postTool.length, 1, 'postTool parsed');
  eq(p.preTool.length, 1, 'preTool parsed');
});

await test('parseHooks: malformed entries block tools', () => {
  const p = parseHooks('{"postTool":[{"on":"write","run":"x"}, null, 5, "str"]}');
  eq(p.postTool.length, 0, 'invalid phase never runs');
  assert(preToolDecision(p,'write',{}).blocked,'invalid entry refuses tools');
});

await test('globMatch: segment, basename, **, ?', () => {
  assert(globMatch('*.py', 'src/app.py'), '*.py matches basename in subdir');
  assert(globMatch('*.py', 'app.py'), '*.py matches root file');
  assert(!globMatch('*.py', 'app.js'), 'wrong ext no match');
  assert(globMatch('src/**', 'src/a/b.py'), '** deep');
  assert(!globMatch('src/*', 'src/a/b.py'), 'single * is one segment');
  assert(globMatch('file?.txt', 'file1.txt'), '? one char');
  assert(globMatch('', 'anything'), 'empty pattern matches all');
});

await test('hookMatches: on / pathMatch / commandMatch', () => {
  const h = { on: 'write|edit', pathMatch: '*.py' };
  assert(hookMatches(h, 'write', { path: 'a.py' }), 'write .py matches');
  assert(hookMatches(h, 'edit', { file: 'b.py' }), 'edit uses file arg');
  assert(!hookMatches(h, 'shell', { path: 'a.py' }), 'wrong tool');
  assert(!hookMatches(h, 'write', { path: 'a.js' }), 'wrong path');
  const s = { on: 'shell', commandMatch: 'rm -rf' };
  assert(hookMatches(s, 'shell', { command: 'sudo rm -rf /tmp' }), 'command substring');
  assert(!hookMatches(s, 'shell', { command: 'ls' }), 'command no match');
  assert(hookMatches({ on: '' }, 'anytool', {}), 'empty on matches any tool');
});

await test('hookCommand: substitutes {file}/{path}/{command}, safely quoted', () => {
  eq(hookCommand({ run: 'black {file}' }, { path: 'x.py' }), "black 'x.py'", '{file}=path quoted');
  eq(hookCommand({ run: 'fmt {path}' }, { file: 'y.py' }), "fmt 'y.py'", '{path}=file quoted');
  eq(hookCommand({ run: 'echo {command}' }, { command: 'ls -la' }), "echo 'ls -la'", '{command} quoted');
  // injection via a crafted filename is neutralized (one quoted arg, no chaining)
  eq(hookCommand({ run: 'black {file}' }, { path: 'a.py; rm -rf .' }), "black 'a.py; rm -rf .'", 'metacharacters neutralized');
  eq(hookCommand({ run: 'fmt {file}' }, { path: "a'b.py" }), "fmt 'a'\\''b.py'", 'embedded quote escaped');
});

await test('preToolDecision: first matching block wins, else not blocked', () => {
  const hooks = parseHooks('{"preTool":[{"on":"shell","commandMatch":"rm -rf /","block":"Refusing dangerous rm."}]}');
  const d = preToolDecision(hooks, 'shell', { command: 'rm -rf /' });
  assert(d.blocked && /Refusing/.test(d.message), 'blocked with message');
  assert(!preToolDecision(hooks, 'shell', { command: 'ls' }).blocked, 'safe command not blocked');
  assert(!preToolDecision(hooks, 'write', { path: 'a.py' }).blocked, 'other tool not blocked');
  assert(!preToolDecision(parseHooks('{}'), 'shell', { command: 'rm -rf /' }).blocked, 'no hooks → never blocked');
});

await test('postToolCommands: matching hooks, substituted, in order', () => {
  const hooks = parseHooks('{"postTool":[{"on":"write|edit","pathMatch":"*.py","run":"black {file}"},{"on":"write","pathMatch":"*.js","run":"prettier {file}"}]}');
  eq(JSON.stringify(postToolCommands(hooks, 'write', { path: 'a.py' })), JSON.stringify(["black 'a.py'"]), 'py hook runs (quoted)');
  eq(postToolCommands(hooks, 'write', { path: 'a.js' })[0], "prettier 'a.js'", 'js hook runs (quoted)');
  eq(postToolCommands(hooks, 'shell', { command: 'ls' }).length, 0, 'no post hook for shell');
});

await test('HOOKS_FILE constant', () => { eq(HOOKS_FILE, '.anvil/hooks.json', 'path'); });

if (failures.length){
  console.error(`hooks: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`hooks conformance: ${passed}/${passed} passed`);
