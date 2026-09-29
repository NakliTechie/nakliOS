// patch — minimal unified-diff apply + reverse for Rig fileops (C0).
//
// Hand-rolled (no vendored dep — smaller than the ~5KB the handoff budgets).
// Two guarantees the C0 checkpoint rests on:
//   1. Atomic: apply computes the whole new content in memory and reports a
//      typed failure naming the hunk; the caller writes nothing on failure.
//   2. Exactly reversible: fileops returns createPatch(result, original) as the
//      `revert` diff, which reproduces the original bytes whatever diff was applied.
//      reversePatch(diff) does the same for a diff that states its final newlines.
//
// Text is split on '\n' only, so '\r' stays attached to its line and CRLF is
// preserved byte-for-byte. Trailing-newline presence is tracked explicitly and
// honoured via the "\ No newline at end of file" marker.

export const EPATCH = 'EPATCH';

// Split into lines without terminators, remembering whether the final line
// carried a trailing newline. join is the exact inverse.
function splitLines(text) {
  const finalNewline = text.endsWith('\n');
  const body = finalNewline ? text.slice(0, -1) : text;
  const lines = body === '' && finalNewline
    ? [] // a single trailing '\n' means one empty line's worth handled below
    : body.split('\n');
  // text "" → [] ; text "\n" → [''] with finalNewline (one empty line + NL)
  if (text === '') return { lines: [], finalNewline: false };
  if (finalNewline && body === '') return { lines: [''], finalNewline: true };
  return { lines, finalNewline };
}

function joinLines(lines, finalNewline) {
  if (lines.length === 0) return '';
  return lines.join('\n') + (finalNewline ? '\n' : '');
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
// The lines `git diff` writes before a file's first hunk.
const GIT_HEADER_RE = /^(diff --git |index |new file mode |deleted file mode |old mode |new mode |similarity index |rename (from|to) )/;

/** Parse a unified diff into hunks. Returns {ok, hunks} or a typed error. */
export function parsePatch(diff) {
  const raw = String(diff).split('\n');
  // The newline that ends the last line is a terminator, not an empty context line. Every patch
  // `diff -u` and `git diff` write ends in one, and each used to fail "context mismatch".
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop();
  const hunks = [];
  let current = null;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    // While a hunk still expects lines by its header counts, `--- x` is the removal of `-- x`, not
    // a file header. Past the counts the hunk stays open for loose diffs with wrong counts.
    const open = current && (current.oldLeft > 0 || current.newLeft > 0);
    if (!open && (line.startsWith('--- ') || line.startsWith('+++ ') || GIT_HEADER_RE.test(line))) continue;
    const m = HUNK_RE.exec(line);
    if (m) {
      current = {
        oldStart: parseInt(m[1], 10),
        oldCount: m[2] === undefined ? 1 : parseInt(m[2], 10),
        newStart: parseInt(m[3], 10),
        lines: [],
      };
      current.oldLeft = current.oldCount;
      current.newLeft = m[4] === undefined ? 1 : parseInt(m[4], 10);
      hunks.push(current);
      continue;
    }
    if (!current) {
      // Ignore blank leading lines; anything else outside a hunk is malformed.
      if (line === '') continue;
      return { ok: false, code: EPATCH, message: `line outside any hunk: ${JSON.stringify(line)}` };
    }
    if (line === '\\ No newline at end of file') {
      current.lines.push({ op: '\\', text: '' });
      continue;
    }
    const op = line[0];
    if (op === ' ' || op === '+' || op === '-') {
      current.lines.push({ op, text: line.slice(1) });
      if (op !== '+') current.oldLeft--;
      if (op !== '-') current.newLeft--;
    } else if (line === '') {
      // A bare empty line inside a hunk is a context line for an empty line.
      current.lines.push({ op: ' ', text: '' });
      current.oldLeft--; current.newLeft--;
    } else {
      return { ok: false, code: EPATCH, message: `unrecognised diff line: ${JSON.stringify(line)}` };
    }
  }
  return { ok: true, hunks };
}

/**
 * Apply a unified diff to text.
 * @returns {{ok:true, result:string} | {ok:false, code:'EPATCH', message, hunk:number}}
 */
export function applyPatch(text, diff) {
  const parsed = parsePatch(diff);
  if (!parsed.ok) return parsed;

  const { lines: src, finalNewline: srcFinalNL } = splitLines(text);
  const out = [];
  let cursor = 0; // index into src (0-based)
  // An empty old file says nothing about newlines, so new lines end in one unless marked.
  let finalNewline = src.length ? srcFinalNL : true;
  // A diff with a "\ No newline" marker states the final newlines, as `diff` writes them: the
  // hunk that reaches the old file's end decides the new file's by whether its last new-side line
  // is marked. A diff without markers is silent, and keeps the old file's state (loose diffs).
  let sawMarker = false, eofNewline = null;

  for (let h = 0; h < parsed.hunks.length; h++) {
    const hunk = parsed.hunks[h];
    // 1-based → 0-based. A hunk with no old lines (`-N,0`) inserts AFTER line N.
    let pos = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (pos < 0) pos = 0;
    // Copy untouched lines between the previous hunk and this one.
    if (pos < cursor) {
      return { ok: false, code: EPATCH, message: `hunk #${h + 1} overlaps a previous hunk at line ${hunk.oldStart}`, hunk: h + 1 };
    }
    for (; cursor < pos; cursor++) out.push(src[cursor]);

    let prevOp = null; // the body op a following '\' marker refers to
    let hasNew = false, lastNewMarked = false;
    for (const l of hunk.lines) {
      if (l.op === '\\') {
        // "\ No newline at end of file" refers to the line just emitted. It
        // only speaks for the NEW file when that line is present in it (' '/'+').
        sawMarker = true;
        if (prevOp === ' ' || prevOp === '+') { finalNewline = false; lastNewMarked = true; }
        continue;
      }
      if (l.op === ' ' || l.op === '+') { hasNew = true; lastNewMarked = false; }
      if (l.op === ' ') {
        if (src[cursor] !== l.text) {
          return { ok: false, code: EPATCH, message: `hunk #${h + 1} context mismatch at line ${cursor + 1}`, hunk: h + 1 };
        }
        out.push(l.text);
        cursor++;
      } else if (l.op === '-') {
        if (src[cursor] !== l.text) {
          return { ok: false, code: EPATCH, message: `hunk #${h + 1} removal mismatch at line ${cursor + 1}`, hunk: h + 1 };
        }
        cursor++;
      } else if (l.op === '+') {
        out.push(l.text);
      }
      prevOp = l.op;
    }
    if (cursor === src.length) eofNewline = hasNew ? !lastNewMarked : true;
  }
  // Copy the tail after the last hunk.
  for (; cursor < src.length; cursor++) out.push(src[cursor]);
  if (sawMarker && eofNewline !== null) finalNewline = eofNewline;

  return { ok: true, result: joinLines(out, finalNewline) };
}

/**
 * Produce the diff that exactly undoes `diff`. Swaps hunk ranges and flips
 * '+' ↔ '-'; context and no-newline markers are preserved. Applying the result
 * to the patched text yields the original bytes.
 */
export function reversePatch(diff) {
  const raw = String(diff).split('\n');
  const out = [];
  for (const line of raw) {
    const m = HUNK_RE.exec(line);
    if (m) {
      const oldStart = m[1], oldCount = m[2], newStart = m[3], newCount = m[4];
      const tail = line.slice(m[0].length);
      const rev = `@@ -${newStart}${newCount !== undefined ? ',' + newCount : ''} `
        + `+${oldStart}${oldCount !== undefined ? ',' + oldCount : ''} @@${tail}`;
      out.push(rev);
      continue;
    }
    if (line.startsWith('--- ')) { out.push('+++ ' + line.slice(4)); continue; }
    if (line.startsWith('+++ ')) { out.push('--- ' + line.slice(4)); continue; }
    if (line.startsWith('+')) { out.push('-' + line.slice(1)); continue; }
    if (line.startsWith('-')) { out.push('+' + line.slice(1)); continue; }
    out.push(line); // ' ' context, '\' markers, blanks
  }
  return out.join('\n');
}

// ── createPatch — the inverse of applyPatch ─────────────────────────────────
// Myers' O(ND) line diff. The trace keeps only the live diagonals of each step, so memory is
// O(D²) for D edits; past MAX_EDITS the diff falls back to one hunk that replaces everything,
// which is still a correct patch, only a larger one.
const MAX_EDITS = 4000;

function editScript(a, b, eq) {
  const n = a.length, m = b.length, max = n + m, off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    if (d > MAX_EDITS) return null;
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && eq(x, y)) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  const ops = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1], at = (k) => prev[k + d - 1];
    const k = x - y;
    const pk = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const px = at(pk), py = px - pk;
    while (x > px && y > py) { x--; y--; ops.push([' ', x, y]); }
    if (x === px) { y--; ops.push(['+', x, y]); } else { x--; ops.push(['-', x, y]); }
  }
  while (x > 0 && y > 0) { x--; y--; ops.push([' ', x, y]); }
  return ops.reverse();
}

/**
 * A unified diff that turns `oldText` into `newText`; '' when they are equal.
 * applyPatch(oldText, createPatch(oldText, newText)).result === newText, bytes and final newline
 * included. `from`/`to` name the --- / +++ lines; `context` is the number of context lines.
 */
export function createPatch(oldText, newText, { from = 'a', to = 'b', context = 3 } = {}) {
  oldText = String(oldText); newText = String(newText);
  if (oldText === newText) return '';
  const A = splitLines(oldText), B = splitLines(newText);
  // The last line of a side without a final newline differs from the same text with one.
  const eolA = (i) => i === A.lines.length - 1 && !A.finalNewline;
  const eolB = (j) => j === B.lines.length - 1 && !B.finalNewline;
  let ops = editScript(A.lines, B.lines, (i, j) => A.lines[i] === B.lines[j] && eolA(i) === eolB(j));
  if (!ops) ops = [...A.lines.map((_, i) => ['-', i, 0]), ...B.lines.map((_, j) => ['+', A.lines.length, j])];
  // Within each run of changes, removals come before additions, as `diff` writes them.
  for (let i = 0; i < ops.length;) {
    if (ops[i][0] === ' ') { i++; continue; }
    let j = i; while (j < ops.length && ops[j][0] !== ' ') j++;
    const run = ops.slice(i, j);
    ops.splice(i, j - i, ...run.filter((o) => o[0] === '-'), ...run.filter((o) => o[0] === '+'));
    i = j;
  }

  // Group changes whose gap is at most 2×context into one hunk.
  const hunks = [];
  for (let i = 0; i < ops.length;) {
    if (ops[i][0] === ' ') { i++; continue; }
    let end = i + 1;
    for (let j = end; j < ops.length;) {
      if (ops[j][0] !== ' ') { end = ++j; continue; }
      let r = j; while (r < ops.length && ops[r][0] === ' ') r++;
      if (r < ops.length && r - j <= 2 * context) { j = r; continue; }
      break;
    }
    hunks.push([Math.max(0, i - context), Math.min(ops.length, end + context)]);
    i = Math.min(ops.length, end + context);
  }

  const out = [`--- ${from}`, `+++ ${to}`];
  const range = (start, count) => (count === 1 ? `${start}` : `${start},${count}`);
  for (const [s, e] of hunks) {
    const body = ops.slice(s, e);
    const oldCount = body.filter((o) => o[0] !== '+').length;
    const newCount = body.filter((o) => o[0] !== '-').length;
    // An empty side names the line it sits after (0 for the start of the file).
    const oldStart = oldCount ? body.find((o) => o[0] !== '+')[1] + 1 : body[0][1];
    const newStart = newCount ? body.find((o) => o[0] !== '-')[2] + 1 : body[0][2];
    out.push(`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`);
    for (const [op, i, j] of body) {
      out.push(op + (op === '+' ? B.lines[j] : A.lines[i]));
      if ((op !== '+' && eolA(i)) || (op === '+' && eolB(j))) out.push('\\ No newline at end of file');
    }
  }
  return out.join('\n') + '\n';
}
