// Conformance — per-project memory & skills assembly (pure).
//
//   node sys/ai/test/project-context.test.mjs

import { buildProjectContext, appendMemory, countMemory, rememberTool,
  primeListTool, primeRememberTool, createPrimeReadEvidence, readPrimeSourceVersion }
  from '../project-context.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push({ name, message: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

await test('buildProjectContext: empty when neither file present', () => {
  eq(buildProjectContext({}), '', 'both absent');
  eq(buildProjectContext({ agents: '', memory: '   ' }), '', 'both blank');
  eq(buildProjectContext({ agents: null, memory: null }), '', 'both null');
});

await test('buildProjectContext: injects both files, labelled', () => {
  const out = buildProjectContext({ agents: 'Use tabs.', memory: '- prefer x' });
  assert(out.includes('AGENTS.md'), 'labels AGENTS.md');
  assert(out.includes('Use tabs.'), 'includes agents content');
  assert(out.includes('memory.md'), 'labels memory.md');
  assert(out.includes('- prefer x'), 'includes memory content');
  assert(out.includes('# Project context'), 'has the framing header');
});

await test('buildProjectContext: one present, one absent', () => {
  const a = buildProjectContext({ agents: 'Only agents.' });
  assert(a.includes('Only agents.') && !a.includes('memory.md'), 'agents only');
  const m = buildProjectContext({ memory: 'Only memory.' });
  assert(m.includes('Only memory.') && !m.includes('AGENTS.md'), 'memory only');
});

await test('buildProjectContext: respects the cap', () => {
  const big = 'x'.repeat(20000);
  const out = buildProjectContext({ agents: big, cap: 100 });
  assert(out.includes('…(truncated)'), 'marks truncation');
  assert(out.length < 1000, `capped small: ${out.length}`);
});

await test('appendMemory: creates body on missing/empty', () => {
  const first = appendMemory(null, 'the API lives in api/');
  assert(first.startsWith('# Project memory'), 'creates header');
  assert(first.includes('- the API lives in api/'), 'adds the bullet');
  eq(countMemory(first), 1, 'one note');
  const fromEmpty = appendMemory('   ', 'note');
  assert(fromEmpty.startsWith('# Project memory'), 'treats blank as empty');
});

await test('appendMemory: second call appends, never clobbers', () => {
  const one = appendMemory(null, 'first');
  const two = appendMemory(one, 'second');
  assert(two.includes('- first'), 'keeps first');
  assert(two.includes('- second'), 'adds second');
  eq(countMemory(two), 2, 'two notes');
  // exactly one header
  eq((two.match(/# Project memory/g) || []).length, 1, 'single header');
});

await test('appendMemory: blank note is a no-op', () => {
  const body = appendMemory(null, 'real');
  eq(appendMemory(body, '   '), body, 'blank leaves content unchanged');
  eq(appendMemory(null, ''), '', 'blank on empty stays empty');
});

await test('appendMemory: flattens multi-line notes to one bullet', () => {
  const out = appendMemory(null, 'line one\nline two');
  eq(countMemory(out), 1, 'still one bullet');
  assert(out.includes('- line one line two'), 'newlines flattened');
});

await test('rememberTool: well-formed OpenAI tool schema', () => {
  const t = rememberTool();
  eq(t.type, 'function', 'type');
  eq(t.function.name, 'remember', 'name');
  assert(t.function.parameters.properties.note, 'has note param');
  assert(t.function.parameters.required.includes('note'), 'note required');
});

await test('project priming exposes read-only discovery and cited hypotheses', () => {
  const list = primeListTool();
  const remember = primeRememberTool();
  eq(list.function.name, 'list', 'directory discovery has an explicit tool');
  eq(remember.function.name, 'remember', 'the fact sink remains remember');
  assert(remember.function.parameters.required.includes('sourcePaths'), 'priming requires source citations');
  eq(remember.function.parameters.properties.type.enum.join(','), 'project,reference', 'survey cannot create binding rules');
  assert(remember.function.parameters.properties.type.description.includes('Omit for project'), 'the optional default is explicit');
  eq(rememberTool().function.parameters.required.join(','), 'note', 'ordinary remember stays unchanged');
});

await test('project priming refuses facts without successful file reads', () => {
  const evidence = createPrimeReadEvidence();
  assert(!evidence.checkRemember({sourcePaths:['README.md']}).ok, 'no read means no fact');
  assert(!evidence.observeRead('missing.md', 'Error reading missing.md: ENOENT'), 'failed read is not evidence');
  assert(!evidence.observeRead('rejected.md', 'Error in read: access denied'), 'executor refusal is not evidence');
  assert(!evidence.observeRead('grant.md', 'EGRANT: read access not granted'), 'grant refusal is not evidence');
  assert(!evidence.observeRead('limited.md', 'Read not granted for this path'), 'plain grant refusal is not evidence');
  assert(!evidence.checkRemember({sourcePaths:['missing.md']}).ok, 'failed path remains unavailable');
  assert(!evidence.checkRemember({sourcePaths:['rejected.md']}).ok, 'executor refusal remains unavailable');
  assert(!evidence.checkRemember({sourcePaths:['grant.md']}).ok, 'grant refusal remains unavailable');
  assert(evidence.observeRead('policy.md', '    1  Permission is not granted by default.'),
    'ordinary source prose about a grant remains citable');
  assert(evidence.observeRead('errors.md', '    1  Error: the example says access denied.'),
    'numbered source lines remain citable even when they contain failure words');
  assert(evidence.observeRead('./README.md', '    1  # Workspace'), 'actual read is remembered');
  const cited=evidence.checkRemember({sourcePaths:['README.md']});
  eq(cited.paths[0], 'README.md', 'equivalent relative path resolves');
  eq(cited.snapshots[0].args.path, './README.md', 'recheck uses the same read path');
  eq(cited.snapshots[0].result, '    1  # Workspace', 'recheck retains displayed source text');
  assert(cited.snapshots[0].digest, 'saved citation carries a read digest');
  eq(cited.snapshots[0].version.status, 'unavailable', 'a missing full version stays explicit');
  assert(!evidence.checkRemember({sourcePaths:['other.md']}).ok, 'unread path is refused');
  assert(!evidence.checkRemember({sourcePaths:[]}).ok, 'empty citations are refused');
  assert(!evidence.checkRemember({sourcePaths:['README.md','a','b','c']}).ok, 'citation count is bounded');
  assert(!evidence.observeRead('.anvil/memory/guess.md', '    1  guess'), 'memory cannot ground itself');
  assert(!evidence.checkRemember({sourcePaths:['.anvil/memory/guess.md']}).ok, 'memory citation is refused');
  assert(!evidence.checkRemember({sourcePaths:['../README.md']}).ok, 'parent traversal is refused');
  for (const path of ['/README.md', 'docs\\README.md', 'docs\0README.md', 'docs/../README.md', 'docs/README\nforged.md', 'docs/README\u007fforged.md']) {
    assert(!evidence.observeRead(path, '    1  # Workspace'), `unsafe read path is refused: ${JSON.stringify(path)}`);
    assert(!evidence.checkRemember({sourcePaths:[path]}).ok, `unsafe citation is refused: ${JSON.stringify(path)}`);
  }
});

await test('project priming hashes bounded full bytes and retains unsupported state', async () => {
  const bytes=new TextEncoder().encode('visible line\nhidden later line');
  let options;
  const available=await readPrimeSourceVersion({read:async(_,o)=>{options=o; return {ok:true,data:bytes};}},'README.md',128);
  eq(options.maxBytes,128,'a byte cap reaches the backend');
  eq(available.status,'available','bounded source has a version');
  assert(/^sha256:[0-9a-f]{64}$/.test(available.digest),'full-file SHA-256 is recorded');
  eq(available.bytes,bytes.length,'byte count is recorded');
  const unavailable=await readPrimeSourceVersion({read:async()=>({ok:false,code:'ENOTSUP'})},'README.md');
  eq(unavailable.status,'unavailable','unsupported reads stay explicit');
  eq(unavailable.reason,'ENOTSUP','the reason remains visible');
  const oversized=await readPrimeSourceVersion({read:async()=>({ok:true,data:bytes})},'README.md',4);
  eq(oversized.status,'unavailable','a backend that violates the bound cannot produce a version');
});

if (failures.length) {
  console.error(`project-context: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`project-context conformance: ${passed}/${passed} passed`);
