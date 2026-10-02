// Shared, storage-independent line map for Anvil and Editor review surfaces.
// The caller reads the committed and working bytes through its granted backend.
import { digest } from './change-preimages.mjs';

export const MAX_DIFF_CELLS = 3_000_000;
export const MAX_DIFF_ROWS = 50_000;
export const MAX_REVIEW_BYTES = 4 * 1024 * 1024;

export function reviewVersion(content, exists = true) {
  if (!exists) return 'missing';
  if (content instanceof Uint8Array) {
    let hash = 0x811c9dc5;
    for (const byte of content) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0; }
    return `bytes:${content.length}:${hash.toString(36)}`;
  }
  return `file:${digest(content)}`;
}

function linesOf(value) {
  const text = String(value);
  if (!text) return { lines: [], finalNewline: false };
  const finalNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (finalNewline) lines.pop();
  return { lines, finalNewline };
}

function groupHunks(rows, context) {
  const changed = [];
  for (let i = 0; i < rows.length; i++) if (rows[i].kind !== 'context') changed.push(i);
  if (!changed.length) return [];
  const hunks = [];
  for (const i of changed) {
    const start = Math.max(0, i - context), end = Math.min(rows.length, i + context + 1);
    const last = hunks.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else hunks.push({ start, end });
  }
  return hunks.map(({ start, end }) => ({
    beforeStart: rows.slice(start, end).find((row) => row.beforeLine != null)?.beforeLine ?? 0,
    afterStart: rows.slice(start, end).find((row) => row.afterLine != null)?.afterLine ?? 0,
    rows: rows.slice(start, end),
  }));
}

export function buildReviewDiff({ before = '', after = '', beforeExists = true, afterExists = true,
  beforePath = '', afterPath = beforePath, context = 3, maxCells = MAX_DIFF_CELLS } = {}) {
  const path = afterPath || beforePath;
  const kind = !beforeExists && !afterExists ? 'absent' : !beforeExists ? 'new' :
    !afterExists ? 'deleted' : beforePath !== afterPath ? 'renamed' : 'modified';
  const beforeVersion = reviewVersion(before, beforeExists);
  const afterVersion = reviewVersion(after, afterExists);
  if (typeof before !== 'string' || typeof after !== 'string' || before.includes('\0') || after.includes('\0')) {
    return { kind, path, beforePath, afterPath, state: 'binary', rows: [], hunks: [], beforeVersion, afterVersion };
  }
  const a = linesOf(beforeExists ? before : ''), b = linesOf(afterExists ? after : '');
  const base = { kind, path, beforePath, afterPath, beforeVersion, afterVersion,
    beforeFinalNewline: a.finalNewline, afterFinalNewline: b.finalNewline,
    beforeLineCount: a.lines.length, afterLineCount: b.lines.length };
  if (a.lines.length + b.lines.length > MAX_DIFF_ROWS || a.lines.length * b.lines.length > maxCells) {
    return { ...base, state: 'too-large', rows: [], hunks: [] };
  }
  const m = a.lines.length, n = b.lines.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) {
    dp[i][j] = a.lines[i] === b.lines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const rows = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a.lines[i] === b.lines[j]) {
      rows.push({ kind: 'context', text: a.lines[i], beforeLine: ++i, afterLine: ++j, anchorLine: j });
    } else if (i < m && (j === n || dp[i + 1][j] >= dp[i][j + 1])) {
      rows.push({ kind: 'delete', text: a.lines[i], beforeLine: ++i, afterLine: null, anchorLine: j + 1 });
    } else {
      rows.push({ kind: 'add', text: b.lines[j], beforeLine: null, afterLine: ++j, anchorLine: j });
    }
  }
  return { ...base, state: 'text', rows, hunks: groupHunks(rows, Math.max(0, Math.min(20, context | 0))) };
}

export function reviewPrompt(comments) {
  if (!Array.isArray(comments) || !comments.length) return '';
  return 'Apply these review comments as one bounded follow-up. Inspect the current files first. Each JSON line is one comment.\n\n' +
    comments.map((item) => JSON.stringify({ file:item.file, line:item.anchorLine,
      anchor:item.kind === 'delete' ? 'deleted line anchor' : 'working line', comment:item.text })).join('\n');
}

// Read the two sides through the caller's already-granted Rig interfaces.
// This function performs no mutation and never treats a failed read as an empty file.
export async function loadWorkingReview({ fs, git, filepath, beforePath = filepath,
  maxBytes = MAX_REVIEW_BYTES } = {}) {
  if (!fs || !git || !filepath) throw new Error('loadWorkingReview needs fs, git and filepath');
  const [base, work] = await Promise.all([
    git.readBlob({ filepath: beforePath, ref: 'HEAD' }),
    fs.read(filepath, { maxBytes }),
  ]);
  const side = (result, label) => {
    if (result?.ok === false && (result.code === 'ENOENT' || result.error === 'ENOENT')) return { exists: false, text: '' };
    if (!result?.ok) throw new Error(`${label}: ${result?.message || result?.code || 'read failed'}`);
    const bytes = result.data instanceof Uint8Array ? result.data : new TextEncoder().encode(String(result.data));
    if (bytes.length > maxBytes) throw new Error(`${label}: file exceeds the ${maxBytes}-byte review bound`);
    if (bytes.includes(0)) return { exists: true, text: bytes };
    try { return { exists: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; }
    catch { return { exists: true, text: bytes }; }
  };
  const before = side(base, 'HEAD'), after = side(work, 'working tree');
  return buildReviewDiff({ before: before.text, after: after.text, beforeExists: before.exists,
    afterExists: after.exists, beforePath, afterPath: filepath });
}
