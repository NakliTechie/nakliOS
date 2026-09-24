// G9 (2026-09-24): the JS gate runner, through a REAL worker — node's worker_threads with data: URLs,
// the same worker source Anvil runs in a module Worker with blob URLs.
//   node sys/kiln/test/js-runner.test.mjs
import { Worker } from 'node:worker_threads';
import { createJsRunner, findSpecifiers, resolveRelative } from '../js-runner.mjs';
import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../rig/agent/index.mjs';
import { createShell } from '../../rig/cli/shell.mjs';
import { makeShellVerifier } from '../../ai/agent-tools.mjs';

let passed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failures.push({ name, message: e.message }); } }
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

// The node host adapter: data: URLs, and a worker whose `self.postMessage` is the parent port.
export function nodeHost(files) {
  const makeModuleURL = (src) => 'data:text/javascript,' + encodeURIComponent(src);
  const spawn = (url) => {
    const boot = `import { parentPort } from 'node:worker_threads'; globalThis.self = globalThis; self.postMessage = (m) => parentPort.postMessage(m); await import(${JSON.stringify(url)});`;
    const w = new Worker(new URL(makeModuleURL(boot)));
    return { onMessage: (cb) => w.on('message', cb), onError: (cb) => w.on('error', cb), terminate: () => w.terminate() };
  };
  return { read: async (p) => (Object.hasOwn(files, p) ? files[p] : null), makeModuleURL, spawn };
}
const runner = (files, opts = {}) => createJsRunner({ ...nodeHost(files), ...opts });

await test('a passing test file exits 0 and shows its output', async () => {
  const r = await runner({ 't.mjs': "import assert from 'node:assert/strict'; import { add } from './src/add.mjs'; assert.equal(add(2, 3), 5); console.log('ok', add(1, 1));", 'src/add.mjs': 'export const add = (a, b) => a + b;' }).run({ entry: 't.mjs' });
  eq(r.code, 0, 'exit'); ok(/ok 2/.test(r.output), r.output);
});
await test('a failing assert exits 1 and says why', async () => {
  const r = await runner({ 't.mjs': "import assert from 'node:assert'; assert.deepStrictEqual({ a: 1 }, { a: 2 });" }).run({ entry: 't.mjs' });
  eq(r.code, 1, 'exit'); ok(/AssertionError|deep-equal/.test(r.output), r.output);
});
await test('relative imports resolve across folders, ../ included; export-from too', async () => {
  const r = await runner({ 'test/t.mjs': "import { v } from '../lib/index.mjs'; if (v !== 42) process.exit(9);", 'lib/index.mjs': "export { v } from './deep/v.mjs';", 'lib/deep/v.mjs': 'export const v = 42;' }).run({ entry: 'test/t.mjs' });
  eq(r.code, 0, r.output);
});
await test('node:test: tests run after load, report ✔/✖, and a failure fails the run', async () => {
  const r = await runner({ 't.mjs': "import test from 'node:test'; import assert from 'node:assert'; test('adds', () => assert.equal(1 + 1, 2)); test('breaks', async () => { await null; assert.equal(1, 2); }); test.skip('later', () => {});" }).run({ entry: 't.mjs' });
  eq(r.code, 1, 'exit'); ok(/✔ adds/.test(r.output) && /✖ breaks/.test(r.output) && /# SKIP/.test(r.output) && /pass 1 · fail 1/.test(r.output), r.output);
  const g = await runner({ 't.mjs': "import { describe, it } from 'node:test'; import assert from 'node:assert/strict'; describe('math', () => { it('mul', () => assert.equal(2 * 3, 6)); });" }).run({ entry: 't.mjs' });
  eq(g.code, 0, g.output); ok(/✔ math > mul/.test(g.output), g.output);
});
await test('process.exit(n) and process.exitCode are the exit code', async () => {
  eq((await runner({ 't.mjs': 'console.log("before"); process.exit(3); console.log("never");' }).run({ entry: 't.mjs' })).code, 3);
  const r = await runner({ 't.mjs': 'process.exitCode = 4; console.log("done");' }).run({ entry: 't.mjs' });
  eq(r.code, 4); ok(/done/.test(r.output));
});
await test('the network is refused inside the gate', async () => {
  const r = await runner({ 't.mjs': "try { await fetch('https://example.com'); console.log('REACHED'); } catch (e) { console.log('blocked:', e.message); }" }).run({ entry: 't.mjs' });
  eq(r.code, 0); ok(/blocked: fetch: network access is disabled in a gate/.test(r.output) && !/REACHED/.test(r.output), r.output);
});
await test('an uncaught error exits 1 with its message', async () => {
  const r = await runner({ 't.mjs': "throw new Error('boom at load');" }).run({ entry: 't.mjs' });
  eq(r.code, 1); ok(/boom at load/.test(r.output), r.output);
});
await test('only relative imports and the shims — a bare import is refused before anything runs', async () => {
  const r = await runner({ 't.mjs': "console.log('RAN'); import _ from 'lodash';" }).run({ entry: 't.mjs' });
  eq(r.code, 1); ok(/only relative imports and node:assert/.test(r.output) && !/RAN/.test(r.output), r.output);
  const f = await runner({ 't.mjs': "import fs from 'node:fs';" }).run({ entry: 't.mjs' });
  ok(/'node:fs'/.test(f.output) && f.code === 1, 'node:fs is refused by name');
});
await test('a circular import is refused; a missing module names the importer; climbing out is refused', async () => {
  ok(/circular import/.test((await runner({ 'a.mjs': "import './b.mjs';", 'b.mjs': "import './a.mjs';" }).run({ entry: 'a.mjs' })).output));
  ok(/cannot read gone\.mjs \(imported from t\.mjs\)/.test((await runner({ 't.mjs': "import './gone.mjs';" }).run({ entry: 't.mjs' })).output));
  ok(/climbs above the workspace/.test((await runner({ 't.mjs': "import '../../x.mjs';" }).run({ entry: 't.mjs' })).output));
});
await test('a run that never finishes is killed at the timeout (124)', async () => {
  const r = await runner({ 't.mjs': 'while (true) {}' }, { timeoutMs: 800 }).run({ entry: 't.mjs' });
  eq(r.code, 124); ok(/timed out/.test(r.output));
});
await test('argv, and node -e with an import relative to the cwd', async () => {
  eq((await runner({ 't.mjs': "console.log(JSON.stringify(process.argv.slice(2)))" }).run({ entry: 't.mjs', argv: ['a', 'b'] })).output.trim(), '["a","b"]');
  const r = await runner({ 'pkg/v.mjs': 'export default 7;' }).run({ source: "import v from './v.mjs'; console.log(v * 6);", cwd: 'pkg' });
  eq(r.code, 0, r.output); eq(r.output.trim(), '42');
});
await test('a test file whose strings mention imports still runs', async () => {
  const r = await runner({ 't.mjs': "import assert from 'node:assert';\nconst snippet = \"import x from './nope.mjs'\"; // import './gone.mjs'\nassert.ok(snippet.includes('nope'));\nconsole.log('fine');" }).run({ entry: 't.mjs' });
  eq(r.code, 0, r.output); ok(/fine/.test(r.output));
});
await test('specifier scanning and resolution', () => {
  const src = "import a from './a.mjs';\nimport { b } from \"./b.mjs\";\nexport * from './c.mjs';\nimport './d.mjs';\nconst e = await import('./e.mjs');\nconst s = 'import x from \"./not-a-real.mjs\"';";
  const specs = findSpecifiers(src).map((s) => s.spec);
  for (const x of ['./a.mjs', './b.mjs', './c.mjs', './d.mjs', './e.mjs']) ok(specs.includes(x), `${x} found: ${specs}`);
  ok(!specs.includes('./not-a-real.mjs'), 'an import inside a string is text, not an import');
  ok(!findSpecifiers("// import x from './c1.mjs'\n/* import './c2.mjs' */\nconst t = `import './c3.mjs'`;").length, 'nor inside a comment or a template');
  eq(resolveRelative('test/t.mjs', '../lib/x.mjs'), 'lib/x.mjs'); eq(resolveRelative('t.mjs', 'lodash'), null); eq(resolveRelative('t.mjs', '../x.mjs'), undefined);
});

await test('end to end: the agent\'s shell runs `node --test` as a GATE — red, then green after the fix', async () => {
  const fs = createFileops({ backend: new MemoryBackend() });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  const host = nodeHost({}); const js = { makeModuleURL: host.makeModuleURL, spawn: host.spawn };
  await fs.write('src/slug.mjs', "export const slug = (s) => s.toLowerCase();");
  await fs.write('test/slug.test.mjs', "import test from 'node:test'; import assert from 'node:assert/strict'; import { slug } from '../src/slug.mjs'; test('spaces become dashes', () => assert.equal(slug('Hello World'), 'hello-world'));");
  const verify = makeShellVerifier({ createShell: (o) => createShell({ ...o, js }), registry, face, command: 'node --test test/slug.test.mjs' });
  const red = await verify();
  eq(red.ok, false, 'the gate is red on the buggy implementation'); ok(/✖ spaces become dashes/.test(red.stdout || red.output || JSON.stringify(red)), JSON.stringify(red).slice(0, 300));
  await fs.write('src/slug.mjs', "export const slug = (s) => s.toLowerCase().replace(/\\s+/g, '-');");
  const green = await verify();
  eq(green.ok, true, 'and green once the code is fixed: ' + JSON.stringify(green).slice(0, 300));
  const shell = createShell({ registry, face, js });
  const v = await shell.feed('node --version'); ok(/no npm packages/.test(v.output), 'it says what it is not');
  const bad = await shell.feed('node --inspect x.mjs'); eq(shell.lastCode, 2, 'an unsupported flag is refused');
  const none = createShell({ registry, face }); await none.feed('node x.mjs'); eq(none.lastCode, 1, 'no runner → a clear refusal, not a 127');
});

if (failures.length) { console.error(`js-runner: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`); process.exit(1); }
console.log(`js-runner conformance: ${passed}/${passed} passed — a workspace ES module runs as a gate in a real worker: exit codes, node:test, relative imports, no network, no npm, a timeout`);
