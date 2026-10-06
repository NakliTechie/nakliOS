// Staging — the REAL app diff types (handoff P0.4). `envelope.mjs` proved the
// registry with fixture normalizers; these are the production ones, written
// against the actual native diff shapes the apps produce:
//
//   reckon  'cell-range'        <- a setCells transaction + its precomputed
//                                 inverse (apps/reckon core/transaction.mjs:
//                                 applyTransaction returns {ops, inverse}).
//   draft   'prosemirror-steps' <- the staged hunk list the editor already
//                                 builds (apps/draft buildStageHunks:
//                                 {index, kind:'replace'|'delete'|'insert',
//                                 delText, insText}).
//   anvil   'anvil-skill'       <- a skill write planned by sys/ai/skill-manage.mjs
//                                 ({skill, op, path, before, after, status,
//                                 sentinel, lint}) — the first agent-produced diff.
//
// EVERY normalizer emits ONE renderer-agnostic shape:
//   { kind, summary, rows:[{ label, before, after, change }] }
// so the single reviewer never branches on the app. Adding an app means adding
// a normalizer here (or in the app's own bundle) — never a reviewer change.
// That is the whole point of the seam: the maker and the reviewer are decoupled.
//
// Pure — no DOM, no imports beyond the registry. Node-testable.

import { registerDiffType } from './envelope.mjs';

export const CHANGE = Object.freeze(['add', 'remove', 'edit']);

// Classify a before/after pair. Empty-to-value is an add, value-to-empty a
// remove; anything else is an edit. `''` and null/undefined are both "absent"
// (a cleared Reckon cell is null; a Draft insert has no delText).
function classify(before, after) {
  const had = before !== '' && before != null;
  const has = after !== '' && after != null;
  if (!had && has) return 'add';
  if (had && !has) return 'remove';
  return 'edit';
}

// ---------------------------------------------------------------- reckon ----

// Render one Reckon cell payload as the text a reviewer shows. The op vocabulary
// is {f: formula} | {v: value} | {fmt: id} | null (cleared). A formula is shown
// verbatim (it IS the content); a format-only touch has no content delta, so it
// reports the format id rather than pretending the value changed.
export function cellText(cell) {
  if (cell === null || cell === undefined) return '';
  if ('f' in cell) return String(cell.f);
  if ('v' in cell) return cell.v === null || cell.v === undefined ? '' : String(cell.v);
  if ('fmt' in cell) return cell.fmt === null ? '(format cleared)' : `(format ${cell.fmt})`;
  return '';
}

// A Reckon staged transaction -> review rows. The native diff is
// { sheet, sheetName?, ops:[], inverse:[] } — `ops` carries the AFTER state and
// `inverse` the BEFORE (Reckon precomputes it at stage time, so the reviewer
// needs no engine access and no snapshot of its own).
//
// Only setCells rows are itemised; other ops in the closed set (insertRows,
// sheetAdd, cfSet, ...) are structural, so they list as one row each naming the
// op rather than being silently dropped — an un-itemised op must still be VISIBLE.
export function normalizeCellRange(diff) {
  const ops = Array.isArray(diff && diff.ops) ? diff.ops : [];
  const inverse = Array.isArray(diff && diff.inverse) ? diff.inverse : [];

  // Fold every inverse setCells into one before-map keyed 'sheet!A1'. The inverse
  // is emitted undo-order (latest first); a later group holds the OLDER value.
  // Overwrite an earlier entry so a repeated cell edit shows its original value.
  const before = new Map();
  for (const op of inverse) {
    if (!op || op.op !== 'setCells' || !op.cells) continue;
    for (const [a1, cell] of Object.entries(op.cells)) {
      const key = `${op.sheet}!${a1}`;
      before.set(key, cellText(cell));
    }
  }

  const rows = [];
  const cellRows = new Map();
  let operationCount = 0;
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.op !== 'setCells' || !op.cells) {
      rows.push({ label: op.op ? `${op.op}` : '(unknown op)', before: '', after: JSON.stringify(op), change: 'edit' });
      operationCount++;
      continue;
    }
    for (const [a1, cell] of Object.entries(op.cells)) {
      const key = `${op.sheet}!${a1}`;
      if (!before.has(key)) throw new Error(`Reckon diff lacks an inverse for ${key}`);
      const b = before.get(key);
      const a = cellText(cell);
      const row = cellRows.get(key);
      if (row) {
        row.after = a;
        row.change = classify(row.before, a);
      } else {
        const next = { label: a1, before: b, after: a, change: classify(b, a) };
        cellRows.set(key, next);
        rows.push(next);
      }
    }
  }

  const sheet = (diff && (diff.sheetName || diff.sheet)) || '';
  const cells = cellRows.size;
  const counts = [];
  if (cells) counts.push(`${cells} cell${cells === 1 ? '' : 's'}`);
  if (operationCount) counts.push(`${operationCount} operation${operationCount === 1 ? '' : 's'}`);
  const summary = counts.join(', ') || '0 changes';
  return {
    kind: 'cells',
    summary: sheet ? `${sheet} — ${summary}` : summary,
    rows,
  };
}

// ----------------------------------------------------------------- draft ----

// Map Draft's hunk kind onto the shared change vocabulary. Draft's kinds are
// already before/after-shaped, so this is a rename, not a re-derivation.
const HUNK_CHANGE = { insert: 'add', delete: 'remove', replace: 'edit' };

// A Draft staged edit -> review rows. Native diff is
// { docId?, docName?, from, to, hunks:[{index, kind, delText, insText}] }.
export function normalizeProsemirrorSteps(diff) {
  const hunks = Array.isArray(diff && diff.hunks) ? diff.hunks : [];
  const rows = hunks.map((h, i) => {
    const before = String(h.delText ?? '');
    const after = String(h.insText ?? '');
    return {
      label: `hunk ${(h.index ?? i) + 1}`,
      before,
      after,
      change: HUNK_CHANGE[h.kind] || classify(before, after),
    };
  });
  const doc = (diff && (diff.docName || diff.docId)) || '';
  const n = rows.length;
  return {
    kind: 'steps',
    summary: doc ? `${doc} — ${n} hunk${n === 1 ? '' : 's'}` : `${n} hunk${n === 1 ? '' : 's'}`,
    rows,
  };
}

// KanZen's native card move keeps the board and column identities alongside
// the visible before/after location. The app rechecks its board revision at
// commit, so this preview never grants authority to mutate a changed board.
export function normalizeCardMove(diff) {
  if (diff?.kind === 'agent') return normalizeKanzenAgent(diff);
  const title = String(diff?.cardTitle || diff?.card || 'Card');
  const before = String(diff?.fromName || diff?.from || '');
  const after = String(diff?.toName || diff?.to || '');
  return {
    kind: 'card-move',
    summary: `${title} — move card`,
    rows: [{
      label: title,
      before: diff?.fromIndex == null ? before : `${before} · position ${Number(diff.fromIndex) + 1}`,
      after: diff?.toIndex == null ? after : `${after} · position ${Number(diff.toIndex) + 1}`,
      change: 'edit',
    }],
  };
}

// A KanZen agent proposal: an agent called a write tool through KanZen's agent face
// (WebMCP, window.kanzen or the cross-tab channel). KanZen sends its own one-line
// summary and, for a batch, one line per change; it re-validates on commit.
export function normalizeKanzenAgent(diff) {
  const summary = String(diff?.summary || diff?.tool || 'Agent change').slice(0, 300);
  const lines = Array.isArray(diff?.details) && diff.details.length ? diff.details : [summary];
  const who = [diff?.caller, diff?.door].filter(Boolean).map(String).join(' via ');
  const change = diff?.destructive ? 'remove' : 'edit';
  const rows = lines.slice(0, 100).map((line) => ({
    label: String(diff?.boardName || 'KanZen'), before: '', after: String(line).slice(0, 300), change,
  }));
  if (diff?.note) rows.push({ label: 'note', before: '', after: String(diff.note).slice(0, 300), change: 'edit' });
  return { kind: 'kanzen-agent', summary: who ? `${summary} — agent (${who})` : `${summary} — agent`, rows };
}

// ----------------------------------------------------------------- anvil ----

// An Anvil skill write -> review rows (C1). The native diff is what skill-manage
// plans: { skill, op, path, before, after, status, sentinel:[findings], lint:[warnings] }.
// One row for the file, one per Sentinel finding and lint warning — a reviewer
// must SEE why a skill landed quarantined, on the card, not in a log.
export function normalizeAnvilSkill(diff) {
  const d = diff && typeof diff === 'object' ? diff : {};
  const before = String(d.before ?? ''), after = String(d.after ?? '');
  const rows = [{ label: `${d.skill || '(skill)'}/${d.path || 'SKILL.md'}`, before, after, change: classify(before, after) }];
  for (const f of (Array.isArray(d.sentinel) ? d.sentinel : [])) rows.push({ label: `sentinel: ${f.check} [${f.severity}]`, before: '', after: `${f.where}: ${f.detail}`, change: 'edit' });
  for (const w of (Array.isArray(d.lint) ? d.lint : [])) rows.push({ label: 'lint', before: '', after: String(w), change: 'edit' });
  const status = d.status ? ` → ${d.status}` : '';
  return { kind: 'skill', summary: `${d.skill || '(skill)'} — ${d.op || 'write'} ${d.path || 'SKILL.md'}${status}`, rows };
}

// -------------------------------------------------------------- register ----

// The production registrations. Called once per realm that OWNS the reviewer —
// i.e. the NakliOS host shell, not each app: one reviewer over many apps means
// one registry in the reviewer's realm, and an iframed app is a different realm.
// An app ships the native diff over the host bridge; the normalizer lives here.
export const APP_DIFF_TYPES = Object.freeze([
  { app: 'reckon', key: 'cell-range', normalize: normalizeCellRange },
  { app: 'draft', key: 'prosemirror-steps', normalize: normalizeProsemirrorSteps },
  { app: 'kanzen', key: 'card-move', normalize: normalizeCardMove },
  { app: 'anvil', key: 'anvil-skill', normalize: normalizeAnvilSkill },
]);

export function registerAppDiffTypes(only = null) {
  const want = only ? new Set(only) : null;
  const done = [];
  for (const dt of APP_DIFF_TYPES) {
    if (want && !want.has(dt.app)) continue;
    registerDiffType(dt.app, { key: dt.key, normalize: dt.normalize });
    done.push(dt.app);
  }
  return done;
}
