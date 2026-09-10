// The id that ACTUALLY answered must survive the whole path: broker → host → SDK → app → record.
//   node scripts/test-host-answered-model.mjs
//
// Commit 36920d1 gave the broker an ordered model ladder: a 5xx on the configured id falls
// through to the next, and `aiGenerateEndpoint` sets `request.answeredModel` to the id that
// replied. Commit 8e434be stamped provider+model on `run.started` — the CONFIGURED model,
// read off the capability broadcast. Between them sat a gap: a run that fell through mid-way
// had every later turn attributed to a model that never produced it, because nothing carried
// the broker's answer out to the chain.
//
// Same four seams as scripts/test-host-usage.mjs, and the same discipline: shapes, not
// variable names, so the anchors survive refactors around them.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runAgentLoop, shellTool } from '../sys/ai/agent-loop.mjs';
import { createRunRecorder, joined, foldModels, foldSubstitutions } from '../sys/history/run-record.mjs';

const host = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const sdk = await readFile(new URL('../sdk/naklios.js', import.meta.url), 'utf8');
const anvil = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');

// ── seam 1: the broker KNOWS who answered ──
assert.match(host, /const run = await \w+\.runModelLadder\(ladder, attemptOn\);\s*\n\s*response = run\.value;\s*\n\s*answeredWith = run\.model;/,
  'the ladder reports the id that replied, and the broker keeps it');
assert.match(host, /request\.answeredModel = answeredWith;/, 'the answering id is carried on the request');

// ── seam 2: the host FORWARDS it on the done event, distinct from the configured `model` ──
assert.match(host, /\.\.\.\(request\.answeredModel \? \{ answeredModel:request\.answeredModel \} : \{\}\)/,
  'the done event carries answeredModel when the runtime said who answered');
assert.match(host, /model:request\.model\?\.id \|\|/, 'every event still names the CONFIGURED entry as `model` — the two are not conflated at the host');

// ── seam 3: the SDK puts it where the OpenAI shape puts the responder ──
assert.match(sdk, /model: msg\.answeredModel \|\| msg\.model \|\| capabilities\.aiModel \|\| 'localmind',/,
  'the done chunk names the responder, falling back to the configured entry');
assert.match(sdk, /if \(chunk\.model\) model = chunk\.model;/, 'the assembled completion takes the last chunk\'s model');
assert.match(sdk, /model: model \|\| capabilities\.aiModel \|\| 'localmind',/, 'and reports it as the completion\'s `model`');

// ── seam 4: the app hands it to the recorder ──
assert.match(anvil, /model: \(r&&typeof r\.model==='string'&&r\.model\)\|\|null \}/,
  'inferViaHost returns the answering model on the reply');

// ── the recorder, end to end: a ladder fall-through mid-run lands on the chain ──
// Simulates exactly what the live stub check does: the configured id answers step 1, then
// 500s, and the ladder's fallback answers the rest. The record must say so.
const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const configured = { id: 'a:free', provider: 'endpoint', label: 'stub · a:free' };
const turns = [
  { content: '', toolCalls: [call('shell', { command: 'echo one' }, 'c0')], model: 'a:free' },
  { content: '', toolCalls: [call('shell', { command: 'echo two' }, 'c1')], model: 'b:free' },
  { content: 'done', toolCalls: [], model: 'b:free' },
];
let i = 0;
const rec = createRunRecorder({ app: 'anvil', principal: 'test' });
await rec.start({ messages: [{ role: 'user', content: 'go' }], tools: [shellTool()], model: configured });
const result = await runAgentLoop({
  messages: [{ role: 'user', content: 'go' }], tools: [shellTool()],
  infer: rec.wrapInfer(async () => turns[i++]), executeTool: async () => 'ok', onEvent: rec.onEvent, maxSteps: 6,
});
await rec.finish(result); await rec.settled();
assert.equal(result.stop, 'done');
assert.deepEqual(foldModels(rec.events(), rec.resolve), [configured], 'run.started still names the configured model');
assert.deepEqual(foldSubstitutions(rec.events(), rec.resolve), [
  { step: 1, configured: 'a:free', answered: 'b:free' },
  { step: 2, configured: 'a:free', answered: 'b:free' },
], 'every turn the fallback answered is named, with the id it stood in for');
const answered = joined(rec.events(), rec.resolve).filter((e) => e.tool === 'llm.responded').map((e) => e.output.model);
assert.deepEqual(answered, ['a:free', 'b:free', 'b:free'], 'each llm.responded names its own responder');

console.log('host-answered-model: the id that answered survives broker → host → SDK → app → chain, and substitutions fold distinctly from the configured model');
