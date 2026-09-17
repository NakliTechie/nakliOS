// N1 (2026-09-12): the run assembly is ONE module the app imports and the beds call. Two claims,
// each checked against something outside the module:
//   1. bytes — the prompt, tool list, budgets and re-loop texts the module builds equal what the
//      last inline app (e870f0b) sent, frozen in sys/ai/test/run-assembly-e870f0b.json. A
//      deliberate prompt change updates the fixture with a reason; an accidental one goes red.
//   2. wiring — the app's run actually goes through the module (systemMessage / runToolset /
//      driveRun with the recorder), and driveRun records every loop the way the app used to.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  systemPrompt, systemMessage, runToolset, gateNote, ACT_NUDGE, RUN_BUDGET, RELOOP_BUDGET,
  needsActNudge, needsSupervisor, reloopMessages, driveRun, withBedStubs, BED_UNWIRED, bedStub,
  withHooks, loadHooks, preHookReply, postHookNotes, EMPTY_HOOKS, contextMessage, SYSTEM_HEAD, SYSTEM_TAIL, MODE_NOTE, LESSON_NOTE,
  runReadiness,
} from '../sys/ai/run-assembly.mjs';
import { renderProcedural } from '../sys/ai/procedural.mjs';
import { LESSON_CONTRACT } from '../sys/ai/memory-store.mjs';
import { parseHooks } from '../sys/ai/hooks.mjs';
import { createRunRecorder } from '../sys/history/run-record.mjs';

const fixture = JSON.parse(await readFile(new URL('../sys/ai/test/run-assembly-e870f0b.json', import.meta.url), 'utf8'));
const anvil = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');
const runTask = anvil.slice(anvil.indexOf('async function runTask(t, text){'));
assert.ok(runTask.length > 1000, 'runTask found');
let n = 0;
const ok = (label) => { n++; };

// ── 1. bytes ──────────────────────────────────────────────────────────────────
for (const mode of ['code', 'plan', 'ask']) {
  assert.equal(systemMessage({ mode }).content, fixture.prompts[mode], `${mode}: the system message is byte-identical to the inline app's`);
  assert.equal(systemMessage({ mode }).role, 'system');
}
assert.equal(systemPrompt(), SYSTEM_HEAD + renderProcedural() + SYSTEM_TAIL, 'systemPrompt is head + prior + tail, and nothing else');
assert.equal(systemMessage({ mode: 'code', extra: ' X' }).content, fixture.prompts.code + ' X', 'extra goes at the very end');
assert.equal(LESSON_NOTE, ' Memory: ' + LESSON_CONTRACT, 'the lesson note is built from the contract, not a paraphrase');
assert.ok(!systemMessage({ mode: 'plan' }).content.includes(LESSON_CONTRACT), 'plan mode carries no lesson note (no remember tool)');
assert.ok(!systemMessage({ mode: 'ask' }).content.includes(LESSON_CONTRACT), 'ask mode carries no lesson note');
assert.equal(MODE_NOTE.code, '', 'code mode adds no mode note');
// seams: a lost or doubled space between the tool list and the prior is invisible to a human
{
  const assembled = systemPrompt();
  assert.match(assembled, /scripting\)\. Read a file before editing it\./, 'the head seam joins with exactly one space');
  assert.match(assembled, /one solver\. Work in small, verifiable steps/, 'the tail seam joins with exactly one space');
  assert.ok(!/ {2}/.test(assembled), 'no doubled space anywhere in the assembled prompt');
}
// a per-run prior reaches the prompt — the ablation beds depend on this seam
{
  const without = renderProcedural(undefined, { disable: ['shell-to-verify'] });
  assert.notEqual(without, renderProcedural(), 'sanity: the ablated prior differs');
  assert.equal(systemMessage({ mode: 'code', proceduralPrior: without }).content, SYSTEM_HEAD + without + SYSTEM_TAIL + LESSON_NOTE, 'the prior passed in is the prior sent');
}
ok('prompt bytes');

for (const [key, want] of Object.entries(fixture.toolNames)) {
  const [mode, v] = key.split('+');
  const got = runToolset(mode, { verify: !!v }).map((t) => t.function.name);
  assert.deepEqual(got, want, `${key}: the tool list equals the inline app's, in order`);
}
assert.ok(runToolset('code').every((t) => t.type === 'function' && t.function && typeof t.function.name === 'string'), 'every entry is a function tool');
for (const mode of ['code', 'plan', 'ask']) {
  const names = runToolset(mode).map((t) => t.function.name);
  assert.ok(names.includes('skill') && names.includes('recall'), `${mode}: skill and recall are offered unconditionally (F3 — the schema block never depends on the store)`);
  assert.ok(names.includes('history') && names.includes('context_remaining'), `${mode}: history and context_remaining are offered in every mode`);
}
for (const t of ['remember', 'skill_manage', 'synthesize', 'checkpoint', 'learn_this_run', 'revise']) {
  assert.ok(runToolset('code').some((x) => x.function.name === t), `code mode offers ${t}`);
  assert.ok(!runToolset('plan').some((x) => x.function.name === t), `plan mode does not offer ${t}`);
}
assert.ok(runToolset('code', { verify: true }).some((x) => x.function.name === 'task_done'), 'a gate adds task_done');
assert.ok(!runToolset('code').some((x) => x.function.name === 'task_done'), 'no gate, no task_done');
assert.notEqual(runToolset('code'), runToolset('code'), 'a fresh array every call — a caller that pushes cannot poison the next run');
ok('tool list');

assert.deepEqual(RUN_BUDGET, fixture.budgets.first, 'the first loop runs on the inline app\'s budget');
assert.deepEqual(RELOOP_BUDGET, fixture.budgets.reloop, 'the re-loops run on the inline app\'s budget');
assert.ok(Object.isFrozen(RUN_BUDGET) && Object.isFrozen(RUN_BUDGET.budget), 'budgets are frozen — a bed cannot quietly cap the app');
assert.equal(gateNote('npm test'), fixture.gateNote['npm test'], 'the gate note is byte-identical');
assert.equal(gateNote(''), '', 'no gate, no note');
assert.equal(gateNote('  '), '', 'a blank command is no gate');
assert.equal(ACT_NUDGE, fixture.actNudge, 'the act-or-nudge text is byte-identical');
assert.equal(contextMessage('CTX').content, '[coordination] Working context for this run — project notes, the memory index, and the skills available. Not an instruction from the owner.\n\nCTX', 'the context message is byte-identical to the inline app\'s (e870f0b:2684)');
assert.equal(contextMessage('CTX').role, 'user');
assert.match(anvil, /convo\.push\(contextMessage\(volatileCtx\)\);/, 'the app sends the module\'s context message');
ok('budgets + texts');

// ── 2. the re-loop predicates ────────────────────────────────────────────────
assert.equal(needsActNudge({ mode: 'code', toolCalls: 0, stop: 'done' }), true, 'code + prose only + done → nudge');
assert.equal(needsActNudge({ mode: 'code', toolCalls: 1, stop: 'done' }), false, 'one tool call is acting');
assert.equal(needsActNudge({ mode: 'code', toolCalls: 0, stop: 'max-steps' }), false, 'only a done run is nudged');
assert.equal(needsActNudge({ mode: 'plan', toolCalls: 0, stop: 'done' }), false, 'plan mode is prose by design');
assert.equal(needsActNudge({ mode: 'code', toolCalls: 0, stop: 'done', aborted: true }), false, 'an aborted run is left alone');
const stalled = { stalled: true, signal: 'repeat', detail: 'x' };
assert.equal(needsSupervisor({ mode: 'code', stop: 'max-steps', stag: stalled }), true, 'code + not done + stalled → redirect');
assert.equal(needsSupervisor({ mode: 'code', stop: 'done', stag: stalled }), false, 'never second-guesses a done run');
assert.equal(needsSupervisor({ mode: 'code', stop: 'max-steps', stag: { stalled: true, signal: 'no-tools' } }), false, 'no-tools belongs to the act-or-nudge');
assert.equal(needsSupervisor({ mode: 'code', stop: 'max-steps', stag: { stalled: false } }), false, 'not stalled, no redirect');
assert.equal(needsSupervisor({ mode: 'plan', stop: 'max-steps', stag: stalled }), false, 'plan/ask are not supervised');
assert.equal(needsSupervisor({ mode: 'code', stop: 'max-steps', stag: stalled, aborted: true }), false, 'an aborted run is left alone');
{
  const convo = [{ role: 'user', content: 'a' }, { role: 'user', content: '[coordination] ctx' }, { role: 'assistant', content: 'b' }];
  const msgs = reloopMessages((extra) => ({ role: 'system', content: 'S' + extra }), convo);
  assert.deepEqual(msgs, [{ role: 'system', content: 'S' }, ...convo], 'a re-loop sends the whole carried conversation, unfiltered, after the system message');
}
ok('predicates');

// ── 3. driveRun records every loop and re-loops exactly as the inline app did ──
function fakeRec() {
  const starts = [], finishes = [], ev = [];
  return {
    starts, finishes,
    start: async ({ messages, tools, model }) => { starts.push({ messages: messages.map((m) => ({ ...m })), tools: tools.length, model }); },
    finish: async (r) => { finishes.push(r.stop); },
    settled: async () => {},
    events: () => ev, resolve: () => null, ev,
  };
}
const sysMsg = (extra) => ({ role: 'system', content: 'SYS' + (extra || '') });
const tools = runToolset('code');
async function drive({ replies, stag = null, mode = 'code', verify = null, gate = '', signal = null }) {
  const rec = fakeRec();
  // the driver folds stagnation over the RECORD; stand in for foldStagnation through the events it reads
  if (stag) rec.events = () => { throw Object.assign(new Error('stag'), { stag }); };
  let i = 0;
  const infer = async () => replies[Math.min(i++, replies.length - 1)];
  const notes = [], systemTexts = [], events = [];
  const convo = [{ role: 'user', content: 'do the thing' }, contextMessage('CTX')];
  const result = await driveRun({
    mode, convo, sysMsg, tools, infer, executeTool: async (nm) => 'ran ' + nm, rec, verify, signal,
    onEvent: (e) => events.push(e.type), model: () => ({ id: 'm1' }), gateNote: gate,
    note: (t) => notes.push(t), onSystemText: (s) => systemTexts.push(s),
  });
  return { result, rec, notes, systemTexts, events, convo };
}
{ // prose only → one nudge, both loops recorded, the prose and the nudge carried into the second
  const d = await drive({ replies: [{ content: 'I would edit the file.', toolCalls: [] }, { content: 'ok', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] }, { content: 'done', toolCalls: [] }] });
  assert.equal(d.rec.starts.length, 2, 'two loops → two rec.start');
  assert.deepEqual(d.rec.finishes, ['done', 'done'], 'each loop is followed by rec.finish');
  assert.deepEqual(d.rec.starts.map((s) => s.model), [{ id: 'm1' }, { id: 'm1' }], 'every loop stamps who answered');
  assert.equal(d.rec.starts[0].tools, tools.length, 'rec.start carries the toolset');
  assert.equal(d.rec.starts[0].messages[0].content, 'SYS', 'the first loop opens with the system message');
  assert.equal(d.rec.starts[0].messages[1].content, 'do the thing');
  assert.equal(d.rec.starts[0].messages[2].content, contextMessage('CTX').content, 'the context message rides after the prompt');
  assert.deepEqual(d.notes, ['No tools were used — nudging the agent to make the change, not just describe it.'], 'the nudge is announced once');
  const second = d.rec.starts[1].messages;
  assert.equal(second[0].content, 'SYS', 'the re-loop uses the same system message with no extra');
  assert.deepEqual(second.slice(1).map((m) => m.content), ['do the thing', contextMessage('CTX').content, 'I would edit the file.', ACT_NUDGE], 'the context message, the prose and the nudge are carried, nothing filtered');
  assert.deepEqual(d.systemTexts, ['SYS', 'SYS'], 'the budget probe sees each loop\'s prompt');
  assert.ok(d.events.includes('tool-call'), 'the caller still sees every loop event');
  assert.equal(d.result.stop, 'done');
}
{ // a run that acted → no nudge, one loop
  const d = await drive({ replies: [{ content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] }, { content: 'done', toolCalls: [] }] });
  assert.equal(d.rec.starts.length, 1, 'one loop when the agent acted');
  assert.deepEqual(d.notes, []);
}
{ // the gate note rides on the FIRST loop only
  const d = await drive({ replies: [{ content: 'prose', toolCalls: [] }, { content: 'still prose', toolCalls: [] }], gate: ' GATE' });
  assert.equal(d.rec.starts[0].messages[0].content, 'SYS GATE', 'the first loop carries the gate note');
  assert.equal(d.rec.starts[1].messages[0].content, 'SYS', 'the re-loop does not repeat it');
}
{ // plan mode: prose is the product; never nudged
  const d = await drive({ replies: [{ content: 'the plan', toolCalls: [] }], mode: 'plan' });
  assert.equal(d.rec.starts.length, 1);
  assert.deepEqual(d.notes, []);
}
{ // an aborted run is neither nudged nor supervised
  const ac = new AbortController(); ac.abort();
  const d = await drive({ replies: [{ content: 'prose', toolCalls: [] }], signal: ac.signal });
  assert.equal(d.result.stop, 'aborted');
  assert.equal(d.rec.starts.length, 1, 'no re-loop after an abort');
}
{ // a done re-loop is never supervised, whatever the fold would say
  const d = await drive({ replies: [{ content: 'prose', toolCalls: [] }, { content: 'prose', toolCalls: [] }], stag: stalled });
  assert.equal(d.rec.starts.length, 2, 'nudge, then done — no supervisor loop');
}
{ // a NOT-done first loop whose stagnation fold throws: swallowed, the result still returned
  const spin = { content: '', toolCalls: [{ id: 'c', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] };
  const d = await drive({ replies: [spin], stag: stalled }); // rec.events throws (see drive) once the fold runs
  assert.equal(d.result.stop, 'max-steps', 'the first loop ran out on RUN_BUDGET');
  assert.equal(d.rec.starts.length, 1, 'the throwing fold is swallowed — no re-loop, no throw');
  assert.deepEqual(d.notes, [], 'and nothing was announced');
}
{ // supervisor, over the REAL record: A,B,A,B… spinning to max-steps is the stall the loop's own
  // consecutive-identical guard misses; the driver folds it and injects ONE redirect, recorded.
  const rec = createRunRecorder({ app: 'anvil', principal: 'test' });
  const call = (cmd, id) => ({ id, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: cmd }) } });
  const spin = []; for (let i = 0; i < 30; i++) spin.push({ content: '', toolCalls: [call(i % 2 ? 'ls' : 'npm test', 'c' + i)] });
  let i = 0;
  const infer = rec.wrapInfer(async () => spin[Math.min(i++, spin.length - 1)]);
  const notes = [];
  const convo = [{ role: 'user', content: 'fix it' }];
  const starts = []; const origStart = rec.start.bind(rec); rec.start = async (o) => { starts.push(o.messages.map((m) => m.content)); return origStart(o); };
  const result = await driveRun({ mode: 'code', convo, sysMsg, tools, infer, executeTool: async () => 'still failing', rec, onEvent: rec.onEvent, note: (t) => notes.push(t) });
  await rec.settled();
  assert.equal(starts.length, 2, 'first loop + one supervisor re-loop, both recorded');
  assert.equal(notes.length, 1); assert.match(notes[0], /^Supervisor: .* — redirecting\.$/, 'the redirect is announced once');
  assert.match(convo[convo.length - 1].content, /^\[coordination\]/, 'the redirect is a tagged coordination message');
  assert.equal(starts[1][starts[1].length - 1], convo[convo.length - 1].content, 'and it is the last message the re-loop sends');
  assert.equal(starts[1][0], 'SYS', 'the re-loop opens with the same system message');
  assert.equal(result.stop, 'max-steps', 'the re-loop ran on the reloop budget and ended the same way');
  assert.equal(i, RUN_BUDGET.maxSteps + RELOOP_BUDGET.maxSteps, 'exactly 24 + 16 model calls — the app\'s budgets, not a bed\'s');
}
ok('driveRun');

// ── 4. the bed helpers ─────────────────────────────────────────────────────────
{
  const exec = withBedStubs(async (nm) => 'base:' + nm);
  assert.equal(await exec('read', {}), 'base:read', 'a wired tool reaches the base executor');
  for (const t of BED_UNWIRED) assert.equal(await exec(t, {}), bedStub(t), `${t} answers with the bed stub`);
  assert.match(bedStub('recall'), /"recall" tool has no store behind it in this bed/, 'the stub names the tool and says nothing was recorded');
  assert.ok(BED_UNWIRED.every((t) => runToolset('code').some((x) => x.function.name === t)), 'every stubbed name is a tool the app really offers');
  const wired = new Set(['read', 'edit', 'write', 'apply_patch', 'todowrite', 'shell', 'clarify', 'task', 'dispatch', 'review', 'task_done']);
  assert.deepEqual(runToolset('code', { verify: true }).map((x) => x.function.name).filter((t) => !wired.has(t) && !BED_UNWIRED.includes(t)), [], 'no app tool is neither executor-wired nor stubbed');
}
{
  const cfg = parseHooks(JSON.stringify({ preTool: [{ on: 'write', pathMatch: 'secret*', block: 'no secrets' }], postTool: [{ on: 'write', run: 'ls' }] }));
  assert.equal(cfg.preTool.length, 1, 'sanity: the hook parsed');
  assert.match(preHookReply(cfg, 'write', { path: 'secret.txt', content: '' }) || '', /^\[blocked by a project hook\] /, 'a matching pre-hook blocks');
  assert.equal(preHookReply(cfg, 'read', { path: 'secret.txt' }), null, 'a non-matching tool passes');
  let built = 0;
  const shellFor = () => { built++; return { feed: async (cmd) => ({ output: 'out of ' + cmd }) }; };
  assert.equal(await postHookNotes(cfg, 'write', { path: 'a.txt' }, shellFor), '\n[hook] ls\nout of ls', 'a post-hook appends its bounded output');
  assert.equal(built, 1, 'the shell is built when a hook has a command');
  assert.equal(await postHookNotes(cfg, 'read', { path: 'a.txt' }, shellFor), '', 'no hook, no note — the result stays byte-identical');
  assert.equal(built, 1, 'and no shell is built when nothing matched (the app builds one per tool call otherwise)');
  const throwing = () => ({ feed: async () => { throw new Error('boom'); } });
  assert.equal(await postHookNotes(cfg, 'write', { path: 'a.txt' }, throwing), '\n[hook] ls — error: boom', 'a hook that throws is reported, not fatal');
  const exec = withHooks(async (nm) => 'wrote', { hooks: () => cfg, shellFor });
  assert.equal(await exec('write', { path: 'a.txt' }), 'wrote\n[hook] ls\nout of ls', 'withHooks: run then annotate');
  assert.match(await exec('write', { path: 'secret.txt' }), /^\[blocked by a project hook\]/, 'withHooks: guard first');
  assert.equal(await exec('read', { path: 'a.txt' }), 'wrote', 'withHooks: untouched when nothing matches');
  const fsNo = { read: async () => ({ ok: false }) };
  assert.equal(await loadHooks(fsNo), EMPTY_HOOKS, 'no hooks file → the empty config');
  assert.equal(await loadHooks(fsNo, cfg), cfg, 'no hooks file → the caller\'s fallback');
  const fsYes = { read: async () => ({ ok: true, data: JSON.stringify({ preTool: [], postTool: [{ on: 'edit', run: 'fmt' }] }) }) };
  assert.equal((await loadHooks(fsYes)).postTool.length, 1, 'a hooks file loads');
  const fsThrow = { read: async () => { throw new Error('nope'); } };
  assert.equal(await loadHooks(fsThrow), EMPTY_HOOKS, 'a throwing read is the empty config, not a crash');
}
ok('bed helpers');

// ── 5. the app is wired through the module ─────────────────────────────────────
assert.match(anvil, /import \{[^}]*\bsystemMessage\b[^}]*\brunToolset\b[^}]*\bdriveRun\b[^}]*\} from '\.\.\/\.\.\/sys\/ai\/run-assembly\.mjs'/, 'Anvil imports the assembly');
assert.match(anvil, /function systemPrompt\(\)\{ return assembledSystemPrompt\(proceduralPrior\); \}/, 'the app\'s systemPrompt hands the module ONLY the procedural prior');
assert.match(runTask, /const sysMsg=\(extra\)=>systemMessage\(\{ mode, proceduralPrior, extra \}\);/, 'the system message is the module\'s — stable text only, the volatile indexes ride in the context message');
for (const volatile of ['projectContext', 'memoryIndex', 'skillsIndex', 'recoveryPreface']) {
  assert.ok(!new RegExp(`proceduralPrior\\s*=\\s*[^;]*${volatile}`).test(anvil), `${volatile} must not reach the procedural prior`);
  assert.ok(!new RegExp(`systemMessage\\(\\{[^}]*${volatile}`).test(anvil), `${volatile} must not reach the system message`);
}
assert.match(runTask, /const tools = runToolset\(mode, \{ verify: !!verify, scopes: grant\.scopes \}\);/, 'the toolset is the module\'s — the beds get the same list');
assert.ok(!/tools\.push\(/.test(runTask.slice(0, runTask.indexOf('const sysMsg='))), 'nothing is pushed onto the toolset after the module built it');
assert.match(runTask, /const gateNote = assembledGateNote\(verifyCmd\);/, 'the gate note is the module\'s');
const call = runTask.match(/let result = await driveRun\(\{[\s\S]*?\n      \}\);/);
assert.ok(call, 'the run is ONE driveRun call');
for (const [re, why] of [[/\brec\b/, 'the recorder'], [/infer: recInfer/, 'the recording infer'], [/onEvent: recEvent/, 'the recording event tap'], [/model: runModel/, 'the model stamp'], [/\bverify\b/, 'the gate'], [/signal: abortController\.signal/, 'the Stop button'], [/\bgateNote\b/, 'the gate note'], [/onSystemText: \(s\)=>\{ liveSystemText = s; \}/, 'the budget probe\'s copy of the prompt']]) {
  assert.match(call[0], re, `driveRun is handed ${why}`);
}
assert.equal([...runTask.matchAll(/runAgentLoop\(\{/g)].length, 0, 'runTask no longer calls the loop itself — the driver does');
assert.ok(!/const nudgeMessages=|const superMessages=|foldStagnation\(rec\.events/.test(runTask), 'no inline copy of the re-loops survives in runTask');
assert.match(runTask, /hooksCfg = await loadHooks\(fs, hooksCfg\);/, 'hooks load through the module (a missing file keeps the previous config, as before)');
assert.match(anvil, /const hookReply = preHookReply\(hooksCfg, nm, ar\);\s*\n\s*if\(hookReply!=null\) return hookReply;/, 'the pre-tool guard is the module\'s');
assert.match(anvil, /const extra = await postHookNotes\(hooksCfg, nm, ar, \(\)=>createShell\(\{ registry, face, kiln: kilnRef \}\)\);/, 'the post-tool notes are the module\'s, over a shell built only when a hook runs');
assert.ok(!/const SYSTEM_HEAD = |const SYSTEM_TAIL = |const MODE_NOTE = |const LESSON_NOTE = |function synthesizeTool\(\)/.test(anvil), 'no second copy of the constants lives in the app');
ok('app wiring');

// A4: the readiness surface is the run's toolset, exactly — every exposed row is a tool the run
// offers and every offered tool is an exposed row; hidden/off/unavailable name the rest
for (const [mode, verify] of [['code', true], ['code', false], ['plan', false], ['ask', false]]) {
  const offered = runToolset(mode, { verify }).map((t) => t.function.name).sort().join(',');
  const rows = runReadiness(mode, { verify });
  const exposed = rows.filter((r) => r.state === 'exposed').map((r) => r.name).sort().join(',');
  assert.equal(exposed, offered, `${mode}/verify=${verify}: exposed == offered`);
  assert.ok(rows.every((r) => ['exposed', 'hidden', 'off', 'unavailable'].includes(r.state)), 'four states only');
  assert.equal(new Set(rows.map((r) => r.name)).size, rows.length, 'one row per tool');
  // a tool code mode offers and this mode does not is a HIDDEN row that names the mode — never silently absent
  const codeOnly = runToolset('code', { verify }).map((t) => t.function.name).filter((n) => !offered.split(',').includes(n));
  // (the mode filters first, so every code-only tool — opt-ins included — is hidden BY THE MODE here)
  for (const n of codeOnly) { const row = rows.find((r) => r.name === n); assert.ok(row && row.state === 'hidden' && row.why.includes(mode), `${mode}: ${n} is hidden by the mode, never absent or off (${row && row.state}: ${row && row.why})`); }
  if (mode !== 'code') assert.equal((rows.find((r) => r.name === 'remember') || {}).state, 'hidden', `${mode}: remember is hidden by the mode`);
}
assert.equal(runReadiness('code', { verify: true }, { unavailable: { synthesize: 'no AI' } }).find((r) => r.name === 'synthesize').state, 'unavailable', 'the app names a capability gap');
// A2 wiring: the last run's episode is its own per-run message, never inside the change-gated block
// (a per-run digest in the gated block re-sends the whole block every run — the 2026-09-07 regression)
assert.match(anvil, /if\(lastEpisode\) convo\.push\(\{role:'user', content:'\[coordination\] '\+lastEpisode\}\);/, 'A2: the episode rides as its own per-run [coordination] message');
assert.ok(!/episode:\s*newest/.test(anvil) && !/buildProjectContext\(\{[^}]*episode/.test(anvil), 'A2: and never inside the change-gated project context');
assert.match(anvil, /String\(newest\.task\)!==String\(t\.id\)/, 'A2: sent only when the last run was ANOTHER task — this task\'s own is in the carried transcript');
// the record is filed under the project captured at run START — a mid-run project switch cannot misfile
// the row the next run's salience and episode read (both checkers' red flag, 2026-09-13)
assert.match(anvil, /const runProject=String\(state\.activeProject\|\|'local'\);/, 'the run project is captured once at run start');
assert.match(anvil, /runsForProject\(runProject\)/, 'the rows are read for it');
assert.match(anvil, /saveRunRecord\(t, rec, \{ gated, project: runProject \}\)/, 'and the record is filed under it');
assert.match(anvil, /const rel='runs\/'\+project\+'\/'\+String\(t\.id\);/, 'the record path is under it too — not the live activeProject');
// CRIB-B B1: the child's turns and tool calls beat on the chain; the feed row's state is typed by the clock
assert.match(anvil, /if\(event&&\(event\.type==='turn-start'\|\|event\.type==='tool-call'\)&&runCtx&&runCtx\.rec\)\{ try\{ runCtx\.rec\.subagentBeat\(\{ kind, label, tool_call_id, child_step: event\.step, tool: event\.name\|\|'' \}\)/, 'B1: a heartbeat per child turn / tool call, on the parent chain');
// (the ticker, the stamp and the settle are DRIVEN in test-anvil-handlers; here only their call sites)
assert.match(anvil, /tool: event\.name\|\|'' \}\)\.catch\(\(\)=>\{\}\); \}catch\(_\)\{\} \}\n\s*armFleetTicker\(\);\n\s*renderLog\(\);/, 'B1: the ticker is armed on every child event');
assert.match(anvil, /\}finally\{[\s\S]{0,700}?settleFleetRows\(t\); \/\/ B1: no child outlives its run/, 'B1: every run settles its child rows at the end');
// B2: no straggler outlives its run — the run's signal is aborted in the same finally, so a child still in
// flight takes the hold path and nothing of it merges unrecorded (the checker's probe)
assert.match(anvil, /ownerStopped = !!\(abortController&&abortController\.signal\.aborted\);\n\s*if\(abortController&&!ownerStopped\)\{ try\{ abortController\.abort\(\); \}catch\(_\)\{\} \}/, 'B2: the run aborts its signal the moment its loops return, before the record is saved');
assert.match(anvil, /\}finally\{[\s\S]{0,900}?if\(abortController&&!abortController\.signal\.aborted\)\{ try\{ abortController\.abort\(\); \}catch\(_\)\{\} \}/, 'B2: and the finally is the backstop');
assert.match(anvil, /const wasAborted = ownerStopped!=null \? ownerStopped : /, 'B2: the owner-stopped reading is taken BEFORE the run aborts itself');
assert.match(anvil, /settleFleetRows\(t\); \/\/ B1: a child row still 'running' from before the reload is interrupted[^\n]*\n\s*if\(t\.status === 'running'\)\{/, 'B1: and boot settles them before the run-status demotion');
assert.match(anvil, /^  let runCtx = null;$/m, 'runCtx is module-scoped (the ticker reads it from outside runTask)');
assert.ok(!/^    let runCtx = null;$/m.test(anvil), 'and not shadowed inside runTask');
assert.match(anvil, /const lv = e\.status==='running' \? subagentLiveness\(e\)\.state : 'exited';/, 'B1: the row is rendered by its typed state');
// CRIB-B B2: one steer queue per run, shared by the executor and the loop
assert.match(anvil, /const steer=createSteerQueue\(\);\n\s*const baseExec = makeToolExecutor\(\{ shell, face, mode, infer: inferViaHost, spawnIsolated, steer,/, 'B2: the executor gets the run\'s steer queue');
assert.match(anvil, /await driveRun\(\{\n\s*steer,/, 'B2: and so does the loop, through driveRun');
assert.ok(!/async function saveRunRecord[\s\S]{0,400}runIndexRow\(\{ project:String\(state\.activeProject/.test(anvil), 'the row never reads the live activeProject at save time');
// B5: the grant projects the run's toolset — extras included — and the readiness says blocked, by scope
{
  const names = (tools) => tools.map((x) => x.function.name).sort().join(',');
  const fullNames = names(runToolset('code', { verify: false }));
  const ro = runToolset('code', { verify: false, scopes: ['fs:read'] });
  for (const n of ['write', 'edit', 'apply_patch', 'remember', 'skill_manage', 'synthesize', 'revise']) assert.ok(!ro.some((x) => x.function.name === n), `read-only grant drops ${n}`);
  for (const n of ['read', 'shell', 'history', 'skill', 'recall', 'checkpoint', 'context_remaining']) assert.ok(ro.some((x) => x.function.name === n), `read-only grant keeps ${n}`);
  assert.equal(names(runToolset('code', { verify: false, scopes: ['fs:read', 'fs:write', 'fs:remove'] })), fullNames, 'the app\'s full grant is the full set');
  assert.equal(names(runToolset('code', { verify: false, scopes: null })), fullNames, 'no grant → not projected');
  for (const [mode, scopes] of [['code', ['fs:read']], ['plan', ['fs:read']], ['code', []], ['ask', []]]) {
    const rows = runReadiness(mode, { verify: false, scopes });
    const exposed = rows.filter((r) => r.state === 'exposed').map((r) => r.name).sort().join(',');
    assert.equal(exposed, names(runToolset(mode, { verify: false, scopes })), `${mode}/${scopes.join('+') || 'none'}: exposed == offered`);
    assert.equal(new Set(rows.map((r) => r.name)).size, rows.length, 'one row per tool');
  }
  const rows = runReadiness('code', { verify: false, scopes: ['fs:read'] });
  assert.equal(rows.find((r) => r.name === 'remember').state, 'blocked'); assert.equal(rows.find((r) => r.name === 'remember').why, 'blocked by policy — the grant lacks fs:write');
  assert.equal(runReadiness('plan', { verify: false, scopes: ['fs:read'] }).find((r) => r.name === 'remember').state, 'hidden', 'the mode hides before the grant blocks, for the extras too');
  // the record's run.started tools equal what the grant allows (the chunk's test)
  const rec = createRunRecorder({ app: 'anvil', principal: 'test' });
  await driveRun({ mode: 'code', convo: [{ role: 'user', content: 'go' }], sysMsg: () => ({ role: 'system', content: 'sys' }), tools: ro, infer: async () => ({ content: 'done', toolCalls: [] }), executeTool: async () => '', rec });
  await rec.settled();
  const started = rec.resolve(rec.events().find((e) => e.tool === 'run.started')).input;
  assert.equal(started.tools.map((x) => x.function.name).sort().join(','), names(ro), 'run.started carries the projected list — a blocked tool is never presented');
}
assert.match(anvil, /const tools = runToolset\(mode, \{ verify: !!verify, scopes: grant\.scopes \}\);/, 'B5: the app projects the catalog by the run grant');
assert.match(anvil, /const readiness = runReadiness\(mode, \{ verify: !!verify, scopes: grant\.scopes \}\);/, 'B5: and the readiness');
assert.match(anvil, /makeToolExecutor\(\{ shell, face, mode, infer: inferViaHost, spawnIsolated, steer, scopes: grant\.scopes,/, 'B5: the children\'s catalogs are projected by the grant too');
assert.match(anvil, /tools=codingToolset\('code',\{ scopes: grant\.scopes \}\)\.concat\(emitTool\);/, 'B5: and the builder role');
// CRIB-D D2: the memory index is scoped to the task at injection; a run that did not finish leaves a task-scoped stall note
assert.match(anvil, /memoryIndex = buildMemoryIndex\(facts, \{ usage, scope: 'task:'\+String\(t\.id\) \}\);/, 'D2: the index is built for THIS task (its notes and the project\'s, never another task\'s)');
assert.match(anvil, /if\(\['max-steps','unverified','budget','no-progress','expect-misses'\]\.includes\(result\.stop\)\)\{\n\s*try\{ const ctxS=foldSessionContext\(recEvents, rec\.resolve\);[^\n]*recordFact\('Stalled last run — '\+stopLabel[^\n]*\{ scope:'task:'\+String\(t\.id\), slot:'stall-'\+String\(t\.id\) \}\);/, 'D2: a non-done stop writes one task-scoped, slot-held stall note');
assert.match(anvil, /result\.stop==='expect-misses' \? \('stopped — '\+\(result\.reason\|\|'predictions kept missing'\)\)/, 'D1: the expect-misses stop has its own label');
// CRIB-D D3: every state write and every refused stale write is a chained line, under the same lock
assert.match(anvil, /await nak\.fs\.write\('state\.json', text\);\n[^\n]*\n\s*try\{ await stateLog\.append\(\{ writer: TAB_ID, tool: 'state\.written', input: \{ rev: state\.rev, bytes: text\.length \} \}\); \}catch\(_\)\{\}/, 'D3: the write is logged after it lands');
assert.match(anvil, /try\{ await stateLog\.append\(\{ writer: TAB_ID, tool: 'state\.refused', input: \{ mine, diskRev \} \}\); \}catch\(_\)\{\}/, 'D3: and so is a refusal');
assert.ok(anvil.indexOf('const stateLog = createStateOplog({') < anvil.indexOf('async function writeRemoteState()'), 'D3: the log exists before the writer');
assert.match(anvil, /changes: \(\)=>\{ const c=overlay\.changes\(\); return \{ written:\(c\.written\|\|\[\]\)\.map\(toRel\), deleted:\(c\.deleted\|\|\[\]\)\.map\(toRel\) \}; \}/, 'B3: a child\'s changes are reported workspace-relative — a Crate mount root never reaches ownership or the merge clock');
// D1: the driver never re-loops a run that stopped on a prediction streak — that stop is the feature
assert.equal(needsSupervisor({ mode: 'code', stop: 'expect-misses', stag: { stalled: true, signal: 'repeat' } }), false, 'a prediction-streak stop is never re-looped');
assert.equal(needsSupervisor({ mode: 'code', stop: 'max-steps', stag: { stalled: true, signal: 'repeat' } }), true, 'a stalled max-steps still is');
assert.match(anvil, /else if\(e\.type==='expect-miss'\)\{ t\.log\.push\(\{k:'system',text:expectMissText\(e\)\}\)/, 'D1: a miss is a row as it happens (LV2: composed by expectMissText)');
console.log('run-assembly: A4 readiness == the toolset in every mode; A2 episode rides ungated; B5 the grant projects the catalog; D1 a miss-streak stop stays stopped');
// …and rides run.started only when the app supplies it: a bed that passes none records the old shape
{
  const mk = () => createRunRecorder({ app: 'anvil', principal: 'test' });
  const infer = async () => ({ content: 'done', toolCalls: [] });
  const sysMsg = () => ({ role: 'system', content: 'sys' });
  const tools = runToolset('code', { verify: false });
  const recA = mk();
  await driveRun({ mode: 'code', convo: [{ role: 'user', content: 'go' }], sysMsg, tools, infer, executeTool: async () => '', rec: recA, readiness: runReadiness('code', { verify: false }) });
  await recA.settled();
  const startedA = recA.events().find((e) => e.tool === 'run.started');
  const inA = recA.resolve(startedA).input;
  assert.ok(Array.isArray(inA.readiness) && inA.readiness.some((r) => r.name === 'shell' && r.state === 'exposed'), 'readiness rides run.started when given');
  const recB = mk();
  await driveRun({ mode: 'code', convo: [{ role: 'user', content: 'go' }], sysMsg, tools, infer, executeTool: async () => '', rec: recB });
  await recB.settled();
  const inB = recB.resolve(recB.events().find((e) => e.tool === 'run.started')).input;
  assert.equal('readiness' in inB, false, 'absent when not given — the record keeps its shape');
  console.log('run-assembly: A4 readiness rides run.started only when supplied');
// B2: driveRun hands the steer queue to the loop — a completion pushed while the model waits lands as run.steered on the record
{
  const { createSteerQueue } = await import('../sys/ai/steer.mjs');
  const q = createSteerQueue();
  let finish; q.track(new Promise((r) => { finish = r; }).then(() => q.push({ content: '[coordination] subagent [1] "x" finished — merged.' })));
  const rec = createRunRecorder({ app: 'anvil', principal: 'test' });
  let calls = 0;
  const infer = async ({ messages }) => { calls++; return calls === 1 ? { content: 'waiting', toolCalls: [] } : { content: 'saw ' + messages[messages.length - 1].content.slice(0, 14), toolCalls: [] }; };
  const p = driveRun({ mode: 'code', convo: [{ role: 'user', content: 'go' }], sysMsg: () => ({ role: 'system', content: 'sys' }), tools: runToolset('code', { verify: false }), infer, executeTool: async () => '', rec, steer: q, onEvent: (e) => rec.onEvent(e) });
  setTimeout(finish, 15);
  const res = await p; await rec.settled();
  assert.equal(res.stop, 'done'); assert.equal(res.text, 'saw [coordination]');
  assert.ok(rec.events().some((e) => e.tool === 'run.steered'), 'the steer is on the record');
  console.log('run-assembly: B2 the steer reaches the loop through driveRun and lands on the record');
}
}

console.log(`run-assembly: ${n} groups green — prompt bytes, tool list, budgets and texts equal e870f0b; driveRun records every loop; the app is wired through the module`);
