// Folded actions — a display-only grouping of one agent turn's tool calls (harness bench, 2026-11-22).
//
// Anvil drew every tool call as its own full-width row, so a one-line README edit showed four
// action rows above the answer and a three-subagent task filled more than a screen. This module
// decides, from the transcript rows alone, which rows a finished turn folds into ONE summary line
// drawn at the turn's end-of-run row ("agent done · N steps"), under the answer.
//
// Display only. It reads t.log and returns indices; it never writes a row, so the transcript
// store, the run record, the replay corpus and the event log are unchanged.
//
// What folds, and what never does:
//   · a turn is the rows after a `user` row (or the previous turn's end) up to its end-of-run row;
//     a turn still running has no end-of-run row, so nothing in it folds;
//   · a tool row folds only when it succeeded (no `error`, no failure `kind`);
//   · a subagent row folds only when its status is `done`; a running, failed or interrupted child
//     stays in place;
//   · change chips, turn-review rows and assistant text are never folded.
//
// Pure: no DOM.

const END_OF_RUN = /^agent .* · \S+ steps$/s;

/** Is this row the end-of-run line a finished turn ends on? */
export function isEndOfRun(e) {
  return !!e && e.k === 'system' && END_OF_RUN.test(String(e.text || ''));
}

function foldable(e) {
  if (!e) return false;
  if (e.k === 'tool') return e.error == null && !e.kind && e.result != null;
  if (e.k === 'subagent') return e.status === 'done';
  return false;
}
function failed(e) {
  if (!e) return false;
  if (e.k === 'tool') return e.error != null || !!e.kind;
  if (e.k === 'subagent') return e.status !== 'done' && e.status !== 'running';
  return false;
}

/**
 * Plan the folds for a transcript.
 * Returns { hidden: Set<rowIndex>, folds: Map<hostIndex, Fold> } where a Fold is
 * { members:[rowIndex], actions, subagents, failed, files:[{verb,file}] }.
 */
export function planFolds(log) {
  const rows = Array.isArray(log) ? log : [];
  const hidden = new Set();
  const folds = new Map();
  let start = 0;
  for (let i = 0; i < rows.length; i++) {
    const e = rows[i];
    if (e && e.k === 'user') { start = i + 1; continue; }
    if (!isEndOfRun(e)) continue;
    const members = []; let actions = 0, subagents = 0, nFailed = 0; const files = []; const seen = new Set();
    for (let j = start; j < i; j++) {
      const r = rows[j];
      if (foldable(r)) { members.push(j); if (r.k === 'tool') actions++; else subagents++; }
      else if (failed(r)) nFailed++;
      if (r && r.k === 'change' && r.file && !seen.has(r.file)) { seen.add(r.file); files.push({ verb: String(r.verb || 'wrote'), file: String(r.file) }); }
    }
    if (members.length) {
      for (const j of members) hidden.add(j);
      folds.set(i, { members, actions, subagents, failed: nFailed, files });
    }
    start = i + 1;
  }
  return { hidden, folds };
}

/** The summary line's text, e.g. "4 actions · wrote README.md" or "6 actions · 3 subagents · 1 failed". */
export function foldSummary(f) {
  const parts = [];
  if (f.actions) parts.push(f.actions + ' action' + (f.actions === 1 ? '' : 's'));
  if (f.subagents) parts.push(f.subagents + ' subagent' + (f.subagents === 1 ? '' : 's'));
  if (f.files.length) parts.push(f.files[0].verb + ' ' + f.files[0].file + (f.files.length > 1 ? ' +' + (f.files.length - 1) + ' more' : ''));
  if (f.failed) parts.push(f.failed + ' failed (shown above)');
  return parts.join(' · ');
}

/**
 * Display keys for the renderer's update plan: the row keys with the fold folded in, so a row that
 * becomes hidden, or a host whose fold opens or whose members change, is a changed key and repaints.
 * `isOpen(hostIndex)` says whether that fold is expanded.
 */
export function foldKeys(keys, plan, isOpen) {
  return keys.map((k, i) => {
    if (plan.hidden.has(i)) return k + ':folded';
    const f = plan.folds.get(i);
    if (!f) return k;
    return k + ':fold:' + (isOpen(i) ? 1 : 0) + ':' + f.members.map((j) => keys[j]).join('|');
  });
}
