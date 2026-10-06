// A failed train run as markdown for the optimizer: the instruction, the trajectory the record
// folds to (foldTranscript — what the model was actually sent and said), and the grader's report.
// AutoHarness's failures/<task_id>.md, with its 30k-character cap: head and tail kept, middle cut.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadRecord, foldTranscript } from '../../sys/history/run-record.mjs';

export const MAX_TRAJECTORY_CHARS = 30_000;

function fenced(text) {
  const t = String(text ?? '');
  const ticks = '`'.repeat(Math.max(3, ...[...t.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}\n${t}\n${ticks}`;
}

export function trajectoryOf(record) {
  const rec = loadRecord(record);
  const msgs = foldTranscript(rec.events(), rec.resolve);
  const names = new Map();
  const parts = [];
  for (const m of Array.isArray(msgs) ? msgs : []) {
    if (m.role === 'assistant') {
      parts.push(`### assistant\n${m.content ? m.content + '\n' : ''}`);
      for (const c of m.tool_calls || []) {
        names.set(c.id, c.function?.name);
        parts.push(`→ tool call \`${c.function?.name}\`\n${fenced(c.function?.arguments)}`);
      }
    } else if (m.role === 'tool') {
      parts.push(`### tool result (${names.get(m.tool_call_id) || '?'})\n${fenced(m.content)}`);
    } else {
      parts.push(`### ${m.role}${/^\[coordination\]/.test(String(m.content)) ? ' (harness coordination message)' : ''}\n${fenced(m.content)}`);
    }
  }
  let t = parts.join('\n\n');
  if (t.length > MAX_TRAJECTORY_CHARS) { const h = MAX_TRAJECTORY_CHARS / 2; t = t.slice(0, h) + '\n\n[... trajectory truncated ...]\n\n' + t.slice(-h); }
  return t;
}

export function failureMarkdown(run, { reps = 1, failed = 1 } = {}) {
  return [
    `# Task ${run.id} (${run.family}; failed ${failed} of ${reps} run(s))`,
    `## Instruction\n${fenced(run.prompt)}`,
    `## Trajectory (run ${run.rep})\nThe system prompt is the harness's own (sys/ai/run-assembly.mjs systemMessage, code mode) and is not repeated here.\n\n${trajectoryOf(run.record)}`,
    `## Evaluation report\n- gate: FAIL — ${run.why}\n- loop stop: ${run.stop}; ${run.steps} step(s), ${run.toolCalls} tool call(s), ${run.usage?.input ?? '?'} input tokens\n- files that differ from the seed at the end: ${run.changed?.length ? run.changed.join(', ') : '(none)'}\n- final answer: ${fenced(run.answer || '(empty)')}`,
  ].join('\n\n') + '\n';
}

// Every run in a run-split output dir (runs/<task>/<rep>.json), grouped by task.
export function readRuns(dir) {
  const root = join(dir, 'runs');
  if (!existsSync(root)) return new Map();
  const out = new Map();
  for (const id of readdirSync(root)) {
    const reps = readdirSync(join(root, id)).filter((f) => f.endsWith('.json')).sort()
      .map((f) => JSON.parse(readFileSync(join(root, id, f), 'utf8')));
    out.set(id, reps);
  }
  return out;
}
