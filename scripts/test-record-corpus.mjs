#!/usr/bin/env node
// U2 (2026-09-13): a keyless dry run of the corpus recorder. An in-process stub that speaks the
// OpenAI shape plays the model for each 2026-09-12 cell; the recorder is spawned exactly as a
// human runs it (`OUT=… BASE=… MODEL=… KEY=… --only <cell>`), into a temp folder — NEVER into
// sys/history/corpus/. Then the written manifest is checked against the record it describes,
// and the record is replayed keyless to the stop the manifest names. What this catches before a
// live spend: a scenario handed the wrong kit (a `files` cell with no read/edit tool), a manifest
// field dropped, a record that does not replay to its own stop. The seven originals are not
// touched: the lane asserts the corpus folder is byte-identical before and after.
//
//   node scripts/test-record-corpus.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { replayEntry } from '../sys/history/replay-corpus.mjs';
import { loadRecord, joined } from '../sys/history/run-record.mjs';

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
// One script per cell, keyed on the prompt the recorder sends; each is what a compliant model would do.
const SCRIPTS = {
  clarify: [{ tool_calls: [call('c1', 'clarify', { question: 'Which file name do you want?' })] }],
  'failed-command': [{ tool_calls: [call('c1', 'shell', { command: 'cat missing.txt' })] }, { content: 'The command exited with code 1 (file not found).' }],
  'stale-edit': [
    { tool_calls: [call('c1', 'read', { path: 'cfg.txt' })] },
    { tool_calls: [call('c2', 'shell', { command: 'echo one=2 > cfg.txt' })] },
    { tool_calls: [call('c3', 'edit', { path: 'cfg.txt', old_string: 'one=1', new_string: 'one=3' })] },
    { tool_calls: [call('c4', 'read', { path: 'cfg.txt' })] },
    { tool_calls: [call('c5', 'edit', { path: 'cfg.txt', old_string: 'one=2', new_string: 'one=3' })] },
    { content: 'DONE' },
  ],
  'parallel-reads': [{ tool_calls: [call('c1', 'read', { path: 'a.txt' }), call('c2', 'read', { path: 'b.txt' }), call('c3', 'read', { path: 'c.txt' })] }, { content: 'apple banana cherry' }],
  // spins: the same two commands alternating to the step cap, then — after the supervisor's redirect — stops
  supervisor: [...Array.from({ length: 6 }, (_, i) => ({ tool_calls: [call('c' + i, 'shell', { command: i % 2 ? 'ls' : 'cat a.txt' })] })), { content: 'Understood — stopping here.' }],
};
const keyOf = (prompt) => /clarify tool/.test(prompt) ? 'clarify' : /missing\.txt/.test(prompt) ? 'failed-command' : /cfg\.txt/.test(prompt) ? 'stale-edit' : /SINGLE response/.test(prompt) ? 'parallel-reads' : 'supervisor';

function stub() {
  const counters = {};
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const prompt = body.messages.find((m) => m.role === 'user')?.content || '';
      const key = keyOf(prompt);
      const i = counters[key] = (counters[key] || 0);
      const script = SCRIPTS[key]; const step = script[Math.min(i, script.length - 1)]; counters[key]++;
      const msg = { role: 'assistant', content: step.content || null, ...(step.tool_calls ? { tool_calls: step.tool_calls } : {}) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: step.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: 'stub' }));
    });
  });
  return { server, reset: () => { for (const k of Object.keys(counters)) delete counters[k]; } };
}

// One recorder run, with a deadline: a stub that never answers must fail the lane, not hang it.
function record(cell, { out, base }) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL('./record-corpus.mjs', import.meta.url).pathname, '--only', cell],
      { env: { ...process.env, OUT: out, BASE: base, MODEL: 'stub', KEY: 'x' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
    const timer = setTimeout(() => { log += '\n[lane] the recorder did not finish within 60 s — killed'; p.kill('SIGKILL'); }, 60000);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, log }); });
  });
}

// The corpus folder, as content: name, size and sha256 of every file, plus git's view. (An `ls -la`
// snapshot carried `..`'s mtime, so unrelated churn beside the folder failed this assertion.)
const corpusDir = new URL('../sys/history/corpus/', import.meta.url).pathname;
const corpusState = () => readdirSync(corpusDir).sort().map((n) => { const p = join(corpusDir, n); const st = statSync(p); return st.isFile() ? `${n} ${st.size} ${createHash('sha256').update(readFileSync(p)).digest('hex')}` : n + '/'; }).join('\n')
  + '\n' + execSync('git status --short -- "' + corpusDir + '"', { encoding: 'utf8' });
const corpusBefore = corpusState();

const { server, reset } = stub();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const out = mkdtempSync(join(tmpdir(), 'corpus-dry-'));
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
try {
  const CELLS = { clarify: 'clarify', 'failed-command': 'done', 'stale-edit': 'done', 'parallel-reads': 'done', supervisor: 'done' };
  for (const [cell, stop] of Object.entries(CELLS)) {
    reset();
    const r = await record(cell, { out, base });
    ok(r.code === 0 && /recorded /.test(r.log), `${cell}: the recorder ran and wrote (${r.log.trim().split('\n').pop()})`);
    const manifest = JSON.parse(readFileSync(join(out, cell + '.manifest.json'), 'utf8'));
    const dump = JSON.parse(readFileSync(join(out, cell + '.json'), 'utf8'));
    const rec = loadRecord(dump); const ev = joined(rec.events(), rec.resolve);
    ok(manifest.cell === cell && manifest.kind === 'recorded', `${cell}: the manifest names itself`);
    ok(typeof manifest.description === 'string' && manifest.description.length > 20, `${cell}: carries its description`);
    ok(manifest.model === 'stub' && /^\d{4}-\d{2}-\d{2}$/.test(manifest.recordedAt), `${cell}: model and date are the run's`);
    ok(manifest.events === ev.length, `${cell}: events ${manifest.events} is the record's ${ev.length}`);
    ok(manifest.loops === ev.filter((e) => e.tool === 'run.started').length, `${cell}: loops is the record's`);
    ok(manifest.expect === stop, `${cell}: ends ${manifest.expect}`);
    const last = [...ev].reverse().find((e) => e.tool === 'run.stopped');
    ok(last && last.output.stop === manifest.expect, `${cell}: the record's last stop is the manifest's`);
    // the kit: a files cell has the file tools, a shell+clarify cell has clarify, the rest plain shell
    const tools = manifest.tools.slice().sort().join(' ');
    if (cell === 'stale-edit' || cell === 'parallel-reads') ok(tools === 'edit read shell', `${cell}: the files kit (${tools})`);
    else if (cell === 'clarify') ok(tools === 'clarify shell', `${cell}: the shell+clarify kit (${tools})`);
    else ok(tools === 'shell', `${cell}: the plain shell kit (${tools})`);
    ok(tools === (rec.resolve(ev.find((e) => e.tool === 'run.started'))?.input?.tools || []).map((t) => t.function.name).sort().join(' '), `${cell}: the manifest's tools are the record's`);
    // the kit USED, not only the kit offered (the checker's finding: an executor swapped under the same
    // tool list — every read/edit answering "unknown tool" — passed the offered-kit checks green)
    const called = ev.filter((e) => e.tool === 'tool.called').map((e) => e.input.name);
    const results = ev.filter((e) => e.tool === 'tool.responded').map((e) => String(e.output.result));
    ok(!results.some((r) => /^Error: unknown tool/.test(r)), `${cell}: every tool the model called is one the executor runs`);
    if (cell === 'stale-edit') ok(results.some((r) => /^Refused: cfg\.txt is stale/.test(r)) && results.some((r) => /^Edited cfg\.txt/.test(r)), 'stale-edit: F8 refused the stale edit and the re-read edit applied — the files kit ran');
    if (cell === 'parallel-reads') ok(called.filter((n) => n === 'read').length === 3 && results.filter((r) => /^\s*1\s/.test(r) || /apple|banana|cherry/.test(r)).length === 3, 'parallel-reads: three reads ran and returned the files');
    // clarify is the LOOP's own tool: intercepted, never executed — one tool.responded (the pause), no tool.called
    if (cell === 'clarify') ok(called.length === 0 && results.length === 1 && ev.some((e) => e.tool === 'run.stopped' && e.output.stop === 'clarify'), 'clarify: intercepted by the loop — no executor call, one reply, the run paused');
    if (cell === 'failed-command') ok(results.some((r) => /ENOENT|No such file/.test(r)), 'failed-command: the failing command\'s error text was fed back');
    if (cell === 'supervisor') ok(called.filter((n) => n === 'shell').length >= 6, 'supervisor: the spinning loop actually ran its shell calls');
    // opts ride beside a record only when the loop needs them, and never carry the stop
    const optsPath = join(out, cell + '.opts.json');
    if (cell === 'supervisor') ok(existsSync(optsPath) && JSON.parse(readFileSync(optsPath, 'utf8')).maxSteps === 6 && !('expect' in JSON.parse(readFileSync(optsPath, 'utf8'))), 'supervisor: opts carry the step cap and not the stop');
    else ok(!existsSync(optsPath), `${cell}: no opts file`);
    // and the record replays keyless to that stop
    const opts = existsSync(optsPath) ? JSON.parse(readFileSync(optsPath, 'utf8')) : {};
    const rp = await replayEntry(dump, { opts });
    ok(rp.ok && rp.consumed && rp.stop === manifest.expect, `${cell}: replays keyless to ${rp.stop} (${rp.why || 'consumed'})`);
  }
  ok(readdirSync(out).filter((f) => f.endsWith('.json')).length === 5 + 5 + 1, 'five records, five manifests, one opts file');
  // a second run of a recorded cell is refused — re-capture is a decision, said out loud
  reset();
  const again = await record('clarify', { out, base });
  ok(/SKIPPED clarify: already recorded/.test(again.log), 'a cell already recorded is not re-captured without --overwrite');
} finally {
  server.close();
  rmSync(out, { recursive: true, force: true });
}
const corpusAfter = corpusState();
assert.equal(corpusAfter, corpusBefore, 'sys/history/corpus/ is untouched by the dry run');
checks++;
console.log(`record-corpus dry run: ${checks} checks green — five cells recorded against a stub into a temp folder, every manifest is its record's, every record replays to its stop, the corpus folder untouched`);
