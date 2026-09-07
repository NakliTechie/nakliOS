// agent-tools — the coding-agent tool set for Forge: dedicated surgical file
// tools (read / write / edit / apply_patch) alongside `shell`, backed by Rig
// fileops through the agent face.
//
// Why not just `shell`? Claude Code, OpenCode, and Kilo all give the model
// first-class file tools even though a shell exists — because models are trained
// on exactly these names/signatures, and structured tools add line numbers,
// truncation, uniqueness checks, and a diff surface a raw shell can't. A live run
// against gpt-5.6-sol confirmed it: the model reached for `apply_patch` unprompted.
//
// `edit` uses OpenCode's replacer chain (exact → line-trimmed → block-anchor) so a
// model that gets whitespace slightly wrong still lands the edit, plus Claude
// Code's read-before-edit + uniqueness gates so it never edits the wrong place.
//
//   import { codingToolset, makeToolExecutor } from './agent-tools.mjs';
//   const tools = codingToolset();                 // + shellTool()
//   const exec  = makeToolExecutor({ shell, face });
//   await runAgentLoop({ messages, tools, infer, executeTool: exec });

import { shellTool, makeShellExecutor, runAgentLoop, taskDoneTool, interceptBashCommand } from './agent-loop.mjs';
import { parseExpect, gradeExpect, expectLine } from './expect.mjs';
import {
  dispatchTool, reviewTool, normalizeTasks, planMerge, formatDispatchDigest,
  SUBAGENT_SYSTEM, REVIEW_SYSTEM, SUBAGENT_MAX_STEPS,
} from './subagents.mjs';
import { renderHashline, applyHashlineBlock, parseHashlineEdit } from './hashline.mjs';
import { createRunRecorder } from '../history/run-record.mjs';

const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 50_000;
const READ_MAX_LINE_CHARS = 2000;

// ── tool schemas (OpenAI function shape) ────────────────────────────────
export function readTool() {
  return { type: 'function', function: {
    name: 'read',
    description: 'Read a text file from the workspace, returned with line numbers. Use offset/limit for large files.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
      offset: { type: 'integer', description: '1-based first line to read (optional).' },
      limit: { type: 'integer', description: 'Max lines to read (optional).' },
    }, required: ['path'] },
  } };
}
export function writeTool() {
  return { type: 'function', function: {
    name: 'write',
    description: 'Create or overwrite a whole file with the given content. Parent directories are created.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' }, content: { type: 'string' },
    }, required: ['path', 'content'] },
  } };
}
export function editTool() {
  return { type: 'function', function: {
    name: 'edit',
    description: 'Replace an exact string in a file. old_string must match uniquely (include surrounding context) unless replace_all is set. Whitespace-tolerant.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'The existing text to replace (with enough context to be unique).' },
      new_string: { type: 'string', description: 'The replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
    }, required: ['path', 'old_string', 'new_string'] },
  } };
}
export function applyPatchTool() {
  return { type: 'function', function: {
    name: 'apply_patch',
    description: 'Apply a patch that can Add, Update, or Delete multiple files in one call. Envelope: "*** Begin Patch" / "*** Add File: p" (+lines) / "*** Update File: p" (@@ hunks with -/+ lines) / "*** Delete File: p" / "*** End Patch".',
    parameters: { type: 'object', properties: {
      patch: { type: 'string', description: 'The full patch text including the Begin/End Patch envelope.' },
    }, required: ['patch'] },
  } };
}

export function todoTool() {
  return { type: 'function', function: {
    name: 'todowrite',
    description: 'Replace your task checklist for a multi-step job. Exactly one item may be in_progress at a time. Update it as you finish steps — it keeps you on track.',
    parameters: { type: 'object', properties: {
      todos: { type: 'array', items: { type: 'object', properties: {
        content: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
      }, required: ['content', 'status'] } },
    }, required: ['todos'] },
  } };
}

// omp hashline edit mode (a second edit surface). `read_lines` returns a
// content-hash-anchored read; `edit_lines` applies line-ref ops whose header TAG
// must match the current file (a stale tag is rejected — no corrupting edit).
export function readLinesTool() {
  return { type: 'function', function: {
    name: 'read_lines',
    description: 'Read a file anchored for line edits: a header "[path#TAG]" plus 1-indexed "N: line" rows. Copy the TAG into an edit_lines block to edit by line number without retyping the old text.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
    }, required: ['path'] },
  } };
}
export function editLinesTool() {
  return { type: 'function', function: {
    name: 'edit_lines',
    description: 'Edit a file by line reference. Provide a block: first line "[path#TAG]" (TAG copied from the latest read_lines), then ops — PUT N.=M: (replace lines N..M with +body rows) / PUT <N: (insert before N) / PUT >N: (insert after N) / PUT >$: (append) / CUT N.=M (delete N..M). Body rows are "+text"; a bare "+" is a blank line. A stale TAG is rejected.',
    parameters: { type: 'object', properties: {
      edit: { type: 'string', description: 'The full edit block including the [path#TAG] header.' },
    }, required: ['edit'] },
  } };
}

export function taskTool() {
  return { type: 'function', function: {
    name: 'task',
    description: 'Delegate a self-contained sub-task to a subagent with a fresh context over the SAME workspace. It runs to completion and returns a short text result. Use it to isolate a large search or a bounded change without cluttering your own context.',
    parameters: { type: 'object', properties: {
      description: { type: 'string', description: 'A 3–5 word label.' },
      prompt: { type: 'string', description: 'The full, self-contained task for the subagent.' },
    }, required: ['prompt'] },
  } };
}

// Which tools each mode exposes (Kilo/Claude-Code-style gating). `code` = all;
// `plan` = read + think, no mutation; `ask` = read-only Q&A.
export const MODE_TOOLS = {
  code: null, // all
  plan: new Set(['read', 'todowrite']),
  ask: new Set(['read']),
  // harden (Rote handoff §4.6): author + hardens a .rote.js — read/surgical-edit,
  // fan-out to mine (dispatch) and critique (review), but NO shell (a script is
  // not debugged by hand-running it) and NO free write (path-guarded to
  // .rote/scripts/ by the app). The `rote_*` tools are added by Anvil when the
  // Rote runtime is wired; the base allowlist here is what agent-tools owns.
  harden: new Set(['read', 'edit', 'apply_patch', 'todowrite', 'dispatch', 'review']),
};

// The coding tool set for a mode. `shell` stays the escape hatch (code mode only).
// Opt-in extras keep the default surface minimal (pi's lesson): `subagents` adds
// `task`, `supervisor` adds `dispatch`/`review` (parallel isolated subagents),
// `hashline` adds read_lines/edit_lines, `completion` adds task_done.
export function codingToolset(mode = 'code', { subagents = false, supervisor = false, hashline = false, completion = false } = {}) {
  const all = [readTool(), editTool(), writeTool(), applyPatchTool(), todoTool(), shellTool()];
  if (subagents) all.push(taskTool());
  if (supervisor) all.push(dispatchTool(), reviewTool());
  if (hashline) all.push(readLinesTool(), editLinesTool());
  if (completion) all.push(taskDoneTool());
  const allow = MODE_TOOLS[mode];
  return allow ? all.filter((t) => allow.has(t.function.name)) : all;
}

// ── the edit replacer chain (pure) — OpenCode's 9 strategies ─────────────
// Each strategy is a generator that yields candidate SUBSTRINGS of `content`.
// The driver locates a candidate with indexOf, enforces GLOBAL uniqueness
// (indexOf === lastIndexOf) so a fuzzy strategy can never silently pick the
// wrong one of two matches, guards against a disproportionately large match, and
// applies the first unique candidate. Order matters: exact first, fuzziest last.
// Returns { ok, content, count, strategy } or { ok:false, error }.
export function applyEdit(content, oldStr, newStr, replaceAll = false) {
  if (typeof oldStr !== 'string' || oldStr === '') return { ok: false, error: 'old_string must be a non-empty string' };
  if (oldStr === newStr) return { ok: false, error: 'old_string and new_string are identical' };

  const strategies = [
    ['exact', repSimple], ['line-trimmed', repLineTrimmed], ['block-anchor', repBlockAnchor],
    ['whitespace-normalized', repWhitespaceNormalized], ['indentation-flexible', repIndentationFlexible],
    ['escape-normalized', repEscapeNormalized], ['trimmed-boundary', repTrimmedBoundary],
    ['context-aware', repContextAware], ['multi-occurrence', repMultiOccurrence],
  ];
  let anyFound = false;
  for (const [name, strat] of strategies) {
    for (const cand of strat(content, oldStr)) {
      if (typeof cand !== 'string' || cand === '') continue;
      const index = content.indexOf(cand);
      if (index === -1) continue;
      anyFound = true;
      if (disproportionate(cand, oldStr)) {
        return { ok: false, error: 'The matched region is disproportionately larger than old_string — re-read the file and provide the exact text to replace.' };
      }
      if (replaceAll) {
        const count = content.split(cand).length - 1;
        return { ok: true, content: content.split(cand).join(newStr), count, strategy: name };
      }
      if (index !== content.lastIndexOf(cand)) continue; // ambiguous → try the next candidate
      return { ok: true, content: content.slice(0, index) + newStr + content.slice(index + cand.length), count: 1, strategy: name };
    }
  }
  // Instructive errors — the model self-corrects off these exact strings.
  if (anyFound) return { ok: false, error: 'Found multiple matches for old_string. Provide more surrounding context to make the match unique.' };
  return { ok: false, error: 'Could not find old_string in the file. It must match exactly, including whitespace, indentation, and line endings.' };
}

// Refuse a match that ballooned relative to old_string (a fuzzy strategy latching
// onto far too much) — tell the model to re-read and supply the exact text.
function disproportionate(search, old) {
  const sl = search.split('\n').length, ol = old.split('\n').length;
  if (sl >= Math.max(ol + 3, ol * 2)) return true;
  if (ol > 1 && search.trim().length > Math.max(old.trim().length + 500, old.trim().length * 4)) return true;
  return false;
}

// find's lines with a trailing blank line dropped (old_string often ends with \n).
function findLines(find) {
  const fl = find.split('\n');
  if (fl.length && fl[fl.length - 1] === '') fl.pop();
  return fl;
}
// The exact substring of `content` spanning content-lines [i, i+n).
function lineSpan(content, cl, i, n) {
  let start = 0; for (let k = 0; k < i; k++) start += cl[k].length + 1;
  let end = start; for (let k = 0; k < n; k++) end += cl[i + k].length + (k < n - 1 ? 1 : 0);
  return content.slice(start, end);
}
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}
const similarity = (a, b) => { const m = Math.max(a.length, b.length); return m === 0 ? 1 : 1 - levenshtein(a, b) / m; };

// 1. exact
function* repSimple(content, find) { yield find; }

// 2. line-trimmed — each line equal after trimming both sides.
function* repLineTrimmed(content, find) {
  const cl = content.split('\n');
  const fl = findLines(find);
  if (!fl.length) return;
  const ft = fl.map((l) => l.trim());
  for (let i = 0; i + ft.length <= cl.length; i++) {
    let hit = true;
    for (let j = 0; j < ft.length; j++) if (cl[i + j].trim() !== ft[j]) { hit = false; break; }
    if (hit) yield lineSpan(content, cl, i, ft.length);
  }
}

// 3. block-anchor — first + last trimmed lines anchor; middle validated by
// averaged per-line Levenshtein similarity ≥ 0.65; size within 25%.
function* repBlockAnchor(content, find) {
  const cl = content.split('\n');
  const fl = findLines(find);
  if (fl.length < 3) return;
  const first = fl[0].trim(), last = fl[fl.length - 1].trim();
  const searchSize = fl.length;
  for (let i = 0; i < cl.length; i++) {
    if (cl[i].trim() !== first) continue;
    for (let j = i + 2; j < cl.length; j++) {
      if (cl[j].trim() !== last) continue;
      const actualSize = j - i + 1;
      if (Math.abs(actualSize - searchSize) > Math.max(1, Math.floor(searchSize * 0.25))) continue;
      let total = 0, cnt = 0;
      const mid = Math.min(searchSize, actualSize) - 2;
      for (let k = 1; k <= mid; k++) {
        const a = (fl[k] || '').trim(), b = (cl[i + k] || '').trim();
        if (a === '' && b === '') continue;
        total += similarity(a, b); cnt++;
      }
      const avg = cnt === 0 ? 1 : total / cnt;
      if (avg >= 0.65) { yield lineSpan(content, cl, i, actualSize); break; }
    }
  }
}

// 4. whitespace-normalized — collapse runs of whitespace.
function* repWhitespaceNormalized(content, find) {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const nf = norm(find);
  const cl = content.split('\n');
  for (const line of cl) if (line.trim() !== '' && norm(line) === nf) yield line;
  if (find.trim()) {
    try {
      const re = new RegExp(find.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
      const m = re.exec(content); if (m) yield m[0];
    } catch (_) {}
  }
  const fl = findLines(find);
  if (fl.length > 1) {
    for (let i = 0; i + fl.length <= cl.length; i++) {
      if (norm(cl.slice(i, i + fl.length).join('\n')) === nf) yield lineSpan(content, cl, i, fl.length);
    }
  }
}

// 5. indentation-flexible — strip the common minimum indent from both sides.
function* repIndentationFlexible(content, find) {
  const strip = (text) => {
    const lines = text.split('\n');
    const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length);
    const min = indents.length ? Math.min(...indents) : 0;
    return lines.map((l) => l.slice(min)).join('\n');
  };
  const fl = findLines(find);
  if (!fl.length) return;
  const sf = strip(fl.join('\n'));
  const cl = content.split('\n');
  for (let i = 0; i + fl.length <= cl.length; i++) {
    if (strip(cl.slice(i, i + fl.length).join('\n')) === sf) yield lineSpan(content, cl, i, fl.length);
  }
}

// 6. escape-normalized — unescape \n \t \r \' \" \` \\ \$ on both sides.
function* repEscapeNormalized(content, find) {
  const map = { n: '\n', t: '\t', r: '\r', "'": "'", '"': '"', '`': '`', '\\': '\\', '$': '$' };
  const unesc = (s) => s.replace(/\\(n|t|r|'|"|`|\\|\$)/g, (_, c) => map[c]).replace(/\\\n/g, '\n');
  const uf = unesc(find);
  if (content.includes(uf)) { yield uf; return; }
  const cl = content.split('\n');
  const fl = findLines(find);
  for (let i = 0; i + fl.length <= cl.length; i++) {
    if (unesc(cl.slice(i, i + fl.length).join('\n')) === unesc(fl.join('\n'))) yield lineSpan(content, cl, i, fl.length);
  }
}

// 7. trimmed-boundary — only when find has boundary whitespace.
function* repTrimmedBoundary(content, find) {
  if (find.trim() === find) return;
  const tf = find.trim();
  if (content.includes(tf)) yield tf;
  const cl = content.split('\n');
  const fl = findLines(find);
  for (let i = 0; i + fl.length <= cl.length; i++) {
    if (cl.slice(i, i + fl.length).join('\n').trim() === tf) yield lineSpan(content, cl, i, fl.length);
  }
}

// 8. context-aware — exact first/last, ≥50% of middle lines equal (trimmed).
function* repContextAware(content, find) {
  const cl = content.split('\n');
  const fl = findLines(find);
  if (fl.length < 3) return;
  const first = fl[0].trim(), last = fl[fl.length - 1].trim();
  for (let i = 0; i + fl.length <= cl.length; i++) {
    if (cl[i].trim() !== first || cl[i + fl.length - 1].trim() !== last) continue;
    let match = 0, total = 0;
    for (let k = 1; k < fl.length - 1; k++) {
      const a = fl[k].trim(), b = cl[i + k].trim();
      if (a === '' && b === '') continue;
      total++; if (a === b) match++;
    }
    if (total === 0 || match / total >= 0.5) { yield lineSpan(content, cl, i, fl.length); return; }
  }
}

// 9. multi-occurrence — yield find per exact occurrence (powers replace_all).
function* repMultiOccurrence(content, find) {
  let idx = content.indexOf(find);
  while (idx !== -1) { yield find; idx = content.indexOf(find, idx + find.length); }
}

// ── apply_patch parser (Add / Update / Delete) ──────────────────────────
// Minimal, robust subset of the OpenAI/Codex apply_patch envelope.
export function parseApplyPatch(patch) {
  const lines = String(patch).split('\n');
  let i = 0;
  const trim = (s) => s.replace(/\s+$/, '');
  while (i < lines.length && trim(lines[i]) !== '*** Begin Patch') i++;
  if (i >= lines.length) return { ok: false, error: 'missing "*** Begin Patch"' };
  i++;
  const ops = [];
  while (i < lines.length) {
    const line = trim(lines[i]);
    if (line === '*** End Patch') return { ok: true, ops };
    let m;
    if ((m = /^\*\*\* Add File: (.+)$/.exec(line))) {
      i++; const body = [];
      while (i < lines.length && !/^\*\*\* /.test(lines[i])) { body.push(lines[i].replace(/^\+/, '')); i++; }
      ops.push({ kind: 'add', path: m[1].trim(), content: body.join('\n') });
    } else if ((m = /^\*\*\* Delete File: (.+)$/.exec(line))) {
      ops.push({ kind: 'delete', path: m[1].trim() }); i++;
    } else if ((m = /^\*\*\* Update File: (.+)$/.exec(line))) {
      const updatePath = m[1].trim();   // capture before the Move-to check clobbers m
      i++; const hunks = [];
      // Optional "*** Move to: newpath"
      let moveTo = null;
      if (i < lines.length && (m = /^\*\*\* Move to: (.+)$/.exec(trim(lines[i])))) { moveTo = m[1].trim(); i++; }
      let before = [], after = [];
      const flush = () => { if (before.length || after.length) { hunks.push({ before: before.join('\n'), after: after.join('\n') }); before = []; after = []; } };
      while (i < lines.length && !/^\*\*\* /.test(lines[i])) {
        const l = lines[i];
        if (/^@@/.test(l)) { flush(); i++; continue; }
        if (l.startsWith('-')) { before.push(l.slice(1)); }
        else if (l.startsWith('+')) { after.push(l.slice(1)); }
        else { const ctx = l.startsWith(' ') ? l.slice(1) : l; before.push(ctx); after.push(ctx); }
        i++;
      }
      flush();
      ops.push({ kind: 'update', path: updatePath, moveTo, hunks });
    } else { i++; }
  }
  return { ok: false, error: 'missing "*** End Patch"' };
}

// ── the executor ────────────────────────────────────────────────────────
// `recordSubagent` is the seam that puts a subagent's whole run on the parent's chain (crib #1,
// 2026-09-07). Without it, `task` / `dispatch` / `review` ran a full agent loop that the
// substrate never saw: the parent chain held the supervisor's turns and a tool result, and the
// workers' model calls and file writes were absent — so F1's reconstruction, F2's keyless replay
// and the tamper-evident chain all covered the supervisor only. It is OPTIONAL: absent, the
// behaviour is exactly as before, because a subagent must still run where no recorder exists
// (the ablation harness, the conformance fixtures, a caller that only wants the text).
export function makeToolExecutor({ shell, face, mode = 'code', infer = null, subagentDepth = 0, spawnIsolated = null, recordSubagent = null }) {
  if (!face) throw new Error('makeToolExecutor requires a Rig agent face');
  const modeAllow = MODE_TOOLS[mode] || null; // null = all tools
  const subagentsOn = typeof infer === 'function' && subagentDepth < 1; // depth cap 1 (no recursion)

  // Run one subagent loop on its OWN chain and hand the dump to the parent. The child gets a
  // separate recorder rather than the parent's onEvent for two load-bearing reasons: interleaved
  // turns would enter the parent's foldTranscript — turns the parent never saw — and break F1;
  // and `dispatch` runs up to four workers concurrently, so interleaved appends would order
  // nondeterministically and break replay. Recording is best-effort: a recorder that throws must
  // not fail a subagent that did its work.
  async function runRecorded({ kind, label, tool_call_id, messages, tools, executeTool, maxSteps }) {
    if (!recordSubagent) return runAgentLoop({ messages, tools, infer, executeTool, maxSteps });
    let rec = null;
    try {
      rec = createRunRecorder({ app: 'anvil', principal: `subagent:${kind}` });
      await rec.start({ messages, tools });
    } catch (_) { rec = null; }
    const res = await runAgentLoop({
      messages, tools, maxSteps, executeTool,
      infer: rec ? rec.wrapInfer(infer) : infer,
      onEvent: rec ? rec.onEvent : undefined,
    });
    if (rec) {
      try {
        await rec.finish(res);
        await rec.settled();
        await recordSubagent({ kind, label, tool_call_id, dump: rec.export(), stop: res.stop, steps: res.steps, text: res.text || '' });
      } catch (_) { /* the work happened; failing to record it must not undo it */ }
    }
    return res;
  }
  // The supervisor tools (dispatch/review) need an isolation factory from the app
  // (a fresh executor over a copy-on-write overlay). Only at the top level — a
  // subagent can't itself fan out (depth cap 1).
  const supervisorOn = typeof spawnIsolated === 'function' && typeof infer === 'function' && subagentDepth < 1;
  const runShell = makeShellExecutor(shell);
  const cwd = () => (shell && typeof shell.cwd === 'string' ? shell.cwd : '');
  // Read-before-edit ledger (Claude Code): a file must be read (read tool, a
  // single-file cat, or just written) before `edit` will touch it — this stops
  // the model editing content it never saw. Paths are store-relative (resolved).
  const readLedger = new Set();
  const noteRead = (p) => { if (p) readLedger.add(p); };
  let todos = []; // the agent's task checklist (todowrite)

  function resolve(path) {
    const raw = String(path == null ? '' : path);
    const base = raw.startsWith('/') ? [] : cwd().split('/').filter(Boolean);
    for (const seg of raw.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (base.length) base.pop(); continue; }
      base.push(seg);
    }
    return base.join('/');
  }
  async function readFile(path) {
    const res = await face.invoke('fs.read', { path: resolve(path), encoding: 'utf-8' });
    if (!res.ok) return { ok: false, error: `${res.code || 'error'}: ${res.message || 'read failed'}` };
    const data = typeof res.data === 'string' ? res.data : '';
    return { ok: true, data };
  }
  async function writeFile(path, content) {
    const res = await face.invoke('fs.write', { path: resolve(path), data: String(content ?? ''), createParents: true });
    if (res.staged) { const a = await face.accept(res.proposalId); return a.ok ? { ok: true } : { ok: false, error: a.message || 'write rejected' }; }
    return res.ok ? { ok: true } : { ok: false, error: res.message || 'write failed' };
  }
  // Cap bulky output and spill the full text to a workspace artifact the model
  // can re-read with offset/limit — protects the context window (all 3 agents do
  // this). Returns the head + a pointer when it overflows.
  let spillCounter = 0;
  async function capOutput(text, label) {
    const s = String(text == null ? '' : text);
    const lines = s.split('\n');
    if (lines.length <= READ_MAX_LINES && s.length <= READ_MAX_BYTES) return s;
    const path = `.forge/out-${++spillCounter}.txt`;
    await writeFile(path, s);
    noteRead(resolve(path));
    const head = lines.slice(0, READ_MAX_LINES).join('\n').slice(0, READ_MAX_BYTES);
    return head + `\n… (${label} truncated: ${lines.length} lines / ${s.length} bytes. Full output saved to ${path} — read it with offset/limit.)`;
  }

  // `call` is the raw tool-call object the loop pairs results to — agent-loop.mjs passes it as a
  // third argument (`executeTool(name, parsed.value, call)`), and Anvil forwards it too. It is
  // taken here so a recorded subagent can name the tool call that spawned it.
  return async function executeTool(name, args, call = null) {
    try {
      // Mode gate (defense-in-depth even if the model calls a hidden tool).
      if (modeAllow && !modeAllow.has(name)) {
        return `Error: the "${name}" tool is not available in ${mode} mode (read-only). Switch to code mode to modify files.`;
      }
      if (name === 'shell') {
        const command = String(args?.command || '');
        // An intercepted command never reaches the shell, so `lastCode` would be
        // stale from some earlier call — only ever report a code we caused.
        const reachedShell = !interceptBashCommand(command);
        const out = await runShell(name, args);
        // YOLO: the agent auto-confirms a staged destructive op (rm, git commit)
        // rather than stalling on a [y/N] it can't answer. Git history + the
        // verifier are the safety net.
        let result = out;
        // Read the exit code BEFORE the auto-confirm — that fires a second
        // shell.feed('y') and overwrites lastCode with the confirmation's result.
        let code = reachedShell && shell ? shell.lastCode : null;
        if (shell && shell.awaitingConfirm) {
          const confirmed = await runShell('shell', { command: 'y' });
          result = (out ? out + '\n' : '') + confirmed;
          code = shell.lastCode; // the confirmed run is the real outcome
        }
        // A plain single-file display satisfies the read-before-edit ledger.
        const m = /^\s*(?:cat|less|more|head|tail)\s+(\S+)\s*$/.exec(command);
        if (m && !/[|>]/.test(command)) noteRead(resolve(m[1]));
        // Without this the model reads a failing build's stdout with no verdict.
        // Appended AFTER capping so truncation can never eat the exit code.
        const capped = await capOutput(result, 'shell output');
        const final = code == null ? capped : `${capped}\n[exit ${code}]`;
        // D3: an optional prediction, graded live so the agent gets immediate feedback; a shell
        // call without `expect` is unchanged. The record keeps the expect in the call args, so a
        // post-hoc fold can re-grade it (foldOutcome).
        const exp = parseExpect(args?.expect);
        return exp ? final + expectLine(exp, gradeExpect(exp, { exitCode: code, output: capped })) : final;
      }

      if (name === 'read') {
        const r = await readFile(args?.path);
        if (!r.ok) return `Error reading ${args?.path}: ${r.error}`;
        noteRead(resolve(args?.path));
        const allLines = r.data.split('\n');
        const total = allLines.length;
        const offset = Number.isInteger(args?.offset) ? Math.max(1, args.offset) : 1;
        const limit = Number.isInteger(args?.limit) ? args.limit : READ_MAX_LINES;
        const slice = allLines.slice(offset - 1, offset - 1 + limit)
          .map((l) => (l.length > READ_MAX_LINE_CHARS ? l.slice(0, READ_MAX_LINE_CHARS) + '… (line truncated)' : l));
        const end = offset - 1 + slice.length;
        let body = slice.map((l, k) => `${String(offset + k).padStart(5)}  ${l}`).join('\n');
        if (body.length > READ_MAX_BYTES) { body = body.slice(0, READ_MAX_BYTES) + '… (truncated)'; }
        const footer = end < total ? `\n(Showing lines ${offset}–${end} of ${total}. Use offset=${end + 1} to continue.)` : '';
        return (body || '(empty file)') + footer;
      }

      if (name === 'write') {
        const r = await writeFile(args?.path, args?.content);
        if (r.ok) noteRead(resolve(args?.path)); // writing establishes known state
        return r.ok ? `Wrote ${resolve(args?.path)} (${String(args?.content ?? '').length} bytes)` : `Error writing ${args?.path}: ${r.error}`;
      }

      if (name === 'edit') {
        const p = resolve(args?.path);
        const r = await readFile(args?.path);
        if (!r.ok) return `Error: cannot edit ${args?.path}: ${r.error}`;
        if (!readLedger.has(p)) {
          return `${args?.path} has not been read yet. Use the read tool on it first, then edit — this prevents editing content you have not seen.`;
        }
        const ed = applyEdit(r.data, args?.old_string, args?.new_string, args?.replace_all === true);
        if (!ed.ok) return `Error editing ${args?.path}: ${ed.error}`;
        const w = await writeFile(args?.path, ed.content);
        if (w.ok) noteRead(p); // the new state is now known
        return w.ok ? `Edited ${resolve(args?.path)} (${ed.count} replacement${ed.count === 1 ? '' : 's'}, ${ed.strategy} match)` : `Error writing ${args?.path}: ${w.error}`;
      }

      if (name === 'read_lines') {
        const r = await readFile(args?.path);
        if (!r.ok) return `Error reading ${args?.path}: ${r.error}`;
        noteRead(resolve(args?.path));
        return await capOutput(renderHashline(resolve(args?.path), r.data), 'read_lines output');
      }

      if (name === 'edit_lines') {
        const block = String(args?.edit ?? '');
        const parsed = parseHashlineEdit(block);
        if (!parsed.ok) return `Error: ${parsed.error}`;
        const p = resolve(parsed.path);
        const r = await readFile(parsed.path);
        if (!r.ok) return `Error: cannot edit ${parsed.path}: ${r.error}`;
        // The content-hash TAG is the freshness guarantee (stronger than the
        // read-before-edit ledger), so a stale file is rejected here structurally.
        const res = applyHashlineBlock(r.data, block);
        if (!res.ok) return `Error editing ${parsed.path}: ${res.error}`;
        const w = await writeFile(parsed.path, res.content);
        if (w.ok) noteRead(p);
        return w.ok ? `Edited ${p} by line ref (${res.applied} op${res.applied === 1 ? '' : 's'})` : `Error writing ${parsed.path}: ${w.error}`;
      }

      if (name === 'apply_patch') {
        const parsed = parseApplyPatch(args?.patch);
        if (!parsed.ok) return `Error: bad patch: ${parsed.error}`;
        const done = [];
        for (const op of parsed.ops) {
          if (op.kind === 'add') {
            const w = await writeFile(op.path, op.content);
            if (!w.ok) return `Error adding ${op.path}: ${w.error}`;
            done.push(`add ${op.path}`);
          } else if (op.kind === 'delete') {
            const res = await face.invoke('fs.remove', { path: resolve(op.path) });
            if (res.staged) await face.accept(res.proposalId);
            done.push(`delete ${op.path}`);
          } else if (op.kind === 'update') {
            const r = await readFile(op.path);
            if (!r.ok) return `Error updating ${op.path}: ${r.error}`;
            let content = r.data;
            for (const h of op.hunks) {
              if (h.before === h.after) continue;
              const ed = applyEdit(content, h.before, h.after, false);
              if (!ed.ok) return `Error updating ${op.path}: hunk did not apply (${ed.error})`;
              content = ed.content;
            }
            const target = op.moveTo || op.path;
            const w = await writeFile(target, content);
            if (!w.ok) return `Error writing ${target}: ${w.error}`;
            if (op.moveTo && op.moveTo !== op.path) {
              const res = await face.invoke('fs.remove', { path: resolve(op.path) });
              if (res.staged) await face.accept(res.proposalId);
            }
            done.push(`update ${op.path}${op.moveTo ? ' → ' + op.moveTo : ''}`);
          }
        }
        return `Applied patch: ${done.join(', ')}`;
      }

      if (name === 'task') {
        if (!subagentsOn) return 'Error: subagents are not available here.';
        const child = makeToolExecutor({ shell, face, mode: 'code', infer, subagentDepth: subagentDepth + 1 });
        const res = await runRecorded({
          kind: 'task',
          label: String(args?.description || args?.prompt || '').slice(0, 60),
          tool_call_id: call?.id ?? null,
          messages: [
            { role: 'system', content: 'You are a subagent with tools: read, write, edit, apply_patch, todowrite, shell. Do the task over the shared workspace, then return a concise result (what you found or changed).' },
            { role: 'user', content: String(args?.prompt ?? '') },
          ],
          tools: codingToolset('code'), // subagents don't nest (depth cap)
          executeTool: child,
          maxSteps: 16,
        });
        return res.text || `(subagent finished: ${res.stop})`;
      }

      if (name === 'dispatch') {
        if (!supervisorOn) return 'Error: dispatch (parallel subagents) is not available here.';
        const norm = normalizeTasks(args?.tasks);
        if (!norm.ok) return `Error: ${norm.error}`;
        // Launch every sub-task concurrently, each in its own isolated overlay.
        // `ok` is true ONLY when the subagent finished cleanly (stop 'done') — a
        // subagent that errored or ran out of steps is held, its partial writes
        // never committed to the real workspace.
        const runs = await Promise.all(norm.tasks.map(async (t) => {
          let iso;
          try { iso = await spawnIsolated(); }
          catch (e) { return { label: t.label, ok: false, stop: 'spawn-failed', text: `Failed to start subagent: ${String(e && e.message || e)}`, changes: { written: [], deleted: [] }, iso: null }; }
          try {
            const res = await runRecorded({
              kind: 'dispatch',
              label: t.label || t.prompt.slice(0, 60),
              tool_call_id: call?.id ?? null,
              messages: [
                { role: 'system', content: SUBAGENT_SYSTEM },
                { role: 'user', content: t.prompt },
              ],
              tools: codingToolset('code'), // full tools, isolated; no nesting (depth cap)
              executeTool: iso.executor,
              maxSteps: SUBAGENT_MAX_STEPS,
            });
            return { label: t.label, ok: res.stop === 'done', stop: res.stop, text: res.text || `(stopped: ${res.stop})`, changes: iso.changes(), iso };
          } catch (e) {
            return { label: t.label, ok: false, stop: 'error', text: `Subagent error: ${String(e && e.message || e)}`, changes: iso.changes ? iso.changes() : { written: [], deleted: [] }, iso };
          }
        }));
        // Merge plan: only cleanly-finished runs are eligible; a path clash holds
        // just the clashers (a disjoint clean sibling still merges).
        const plan = planMerge(runs);
        for (const i of plan.apply) {
          const r = runs[i];
          if (r.iso && typeof r.iso.commit === 'function') {
            try { await r.iso.commit(); }
            catch (e) { r.text += `\n(merge failed: ${String(e && e.message || e)})`; plan.status[i] = 'merge-failed'; }
          }
        }
        return formatDispatchDigest({ results: runs, status: plan.status, conflicts: plan.conflicts, dropped: norm.dropped });
      }

      if (name === 'review') {
        if (!supervisorOn) return 'Error: review (reviewer subagent) is not available here.';
        const prompt = String(args?.prompt ?? '').trim();
        if (!prompt) return 'Error: review needs a prompt naming what to review.';
        let iso;
        try { iso = await spawnIsolated(); }
        catch (e) { return `Failed to start reviewer: ${String(e && e.message || e)}`; }
        // Reviewer is inspect-only (read/read_lines/shell/todo). It runs in an
        // isolated overlay and its changeset is DISCARDED — a reviewer never writes.
        const res = await runRecorded({
          kind: 'review',
          label: prompt.slice(0, 60),
          tool_call_id: call?.id ?? null,
          messages: [
            { role: 'system', content: REVIEW_SYSTEM },
            { role: 'user', content: prompt },
          ],
          tools: [readTool(), readLinesTool(), shellTool(), todoTool()],
          executeTool: iso.executor,
          maxSteps: SUBAGENT_MAX_STEPS,
        });
        return res.text || `(review finished: ${res.stop})`;
      }

      if (name === 'todowrite') {
        const items = Array.isArray(args?.todos) ? args.todos : [];
        const inProgress = items.filter((t) => t?.status === 'in_progress').length;
        if (inProgress > 1) return 'Error: only one todo may be in_progress at a time.';
        todos = items.map((t) => ({ content: String(t?.content ?? ''), status: ['pending', 'in_progress', 'completed'].includes(t?.status) ? t.status : 'pending' }));
        const mark = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
        const done = todos.filter((t) => t.status === 'completed').length;
        return `Todo (${done}/${todos.length}):\n` + todos.map((t) => `${mark[t.status]} ${t.content}`).join('\n');
      }

      return `Error: unknown tool "${name}"`;
    } catch (e) {
      return `Error in ${name}: ${String(e && e.message || e)}`;
    }
  };
}

// A verifier for runAgentLoop's `verify` slot: runs an operator-fixed command in
// a FRESH shell over the same workspace and reports its exit code — the shell
// analogue of the K3 Python verifier. The command is captured at construction
// (immutable) and the fresh shell means the agent's session state (cwd, vars)
// can't bend the verdict. `createShell` is injected to avoid a hard dependency.
export function makeShellVerifier({ createShell, registry, face, command }) {
  if (typeof createShell !== 'function') throw new Error('makeShellVerifier requires createShell');
  if (!registry || !face) throw new Error('makeShellVerifier requires { registry, face }');
  if (typeof command !== 'string' || !command.trim()) throw new Error('makeShellVerifier requires a non-empty command');
  const cmd = command;
  return async function verify() {
    const shell = createShell({ registry, face }); // fresh session, same workspace
    const res = await shell.feed(cmd);
    const exit = shell.lastCode | 0;
    const output = (res && res.output) || '';
    return { ok: exit === 0, exit, stdout: output, stderr: exit === 0 ? '' : output };
  };
}
