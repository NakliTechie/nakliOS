// The build family of the hard tier: multi-step builds to a written spec, graded by a HIDDEN test
// module that the same js-runner as the agent's `node` runs over the finished workspace
// (gates.mjs hiddenTest). The agent can write and run its own tests (`node test/x.mjs`); the hidden
// cases are not in the workspace. Ports of the live-bed tasks (plan/bench-live-bed-2026-09-1{1,2}.md):
// mdlite (a Markdown subset renderer), T1 inventory (package + CLI with exit codes), T2 fix-red (a
// package with planted bugs and a red test) — in JS, because the node bed has no python. Plus six
// spec-heavy modules (router, expression evaluator, cron, glob, template, JSON Patch).
// Every expected value comes from the reference implementation below, run at load time.
import { all, onlyChanged, hiddenTest, testSource, write, say } from './gates.mjs';

const load = (src) => import('data:text/javascript,' + encodeURIComponent(src));

// ── mdlite ─────────────────────────────────────────────────────────────────────────────────────
const MDLITE_SPEC = `# mdlite

\`render(markdown)\` turns a small Markdown subset into HTML. "\\r\\n" counts as "\\n".

## Blocks

Read the input line by line. Blank lines (empty, or only spaces) separate blocks and produce nothing.

1. **Heading** — a line starting with 1 to 3 \`#\` characters and then one space becomes
   \`<h1>…</h1>\`, \`<h2>\` or \`<h3>\`, with the rest of the line as inline text. A heading is always a
   block of its own, even with no blank line around it. Four or more \`#\` is not a heading.
2. **Code block** — a line starting with three backticks opens it; every following line up to the next
   line starting with three backticks (or the end of the input) is its content, blank lines included.
   The fence lines are not content. Output: \`<pre><code>CONTENT</code></pre>\`, the content lines
   joined with "\\n" and HTML-escaped, with no inline rules applied.
3. **List** — a run of consecutive lines that each start with "- " becomes
   \`<ul><li>…</li><li>…</li></ul>\`, each item's text (after "- ") as inline text.
4. **Paragraph** — a run of consecutive lines that are none of the above becomes \`<p>…</p>\`: the lines
   joined with one space, as inline text.

The output is the blocks joined with "\\n", with no trailing newline.

## Inline text

1. Code spans first: text between a pair of backticks becomes \`<code>…</code>\`; its content is
   HTML-escaped and nothing else applies inside it.
2. Everywhere else, HTML-escape: \`&\` → \`&amp;\`, \`<\` → \`&lt;\`, \`>\` → \`&gt;\`.
3. Then \`**bold**\` → \`<strong>bold</strong>\`, then \`*em*\` → \`<em>em</em>\` (the text between the
   markers is at least one character and contains no \`*\`).
4. Then \`[text](url)\` → \`<a href="url">text</a>\` (the url has no spaces and no ")").
`;
const MDLITE_REF = String.raw`const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(t) {
  return t.split(/(` + '`[^`]*`' + String.raw`)/).map((p, i) => (i % 2
    ? '<code>' + esc(p.slice(1, -1)) + '</code>'
    : esc(p).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>'))).join('');
}
export function render(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const blank = (l) => l.trim() === '', head = (l) => /^#{1,3} /.test(l), fence = (l) => l.startsWith('` + '```' + String.raw`'), item = (l) => l.startsWith('- ');
  const out = []; let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (blank(l)) { i++; continue; }
    if (head(l)) { const n = l.indexOf(' '); out.push('<h' + n + '>' + inline(l.slice(n + 1)) + '</h' + n + '>'); i++; continue; }
    if (fence(l)) { const body = []; i++; while (i < lines.length && !fence(lines[i])) body.push(lines[i++]); i++; out.push('<pre><code>' + esc(body.join('\n')) + '</code></pre>'); continue; }
    if (item(l)) { const items = []; while (i < lines.length && item(lines[i])) items.push('<li>' + inline(lines[i++].slice(2)) + '</li>'); out.push('<ul>' + items.join('') + '</ul>'); continue; }
    const para = []; while (i < lines.length && !blank(lines[i]) && !head(lines[i]) && !fence(lines[i]) && !item(lines[i])) para.push(lines[i++]);
    out.push('<p>' + inline(para.join(' ')) + '</p>');
  }
  return out.join('\n');
}
`;
const FENCE = '```';
const MDLITE_INPUTS = [
  '# Title\n\nHello *world*.',
  '## A\ntext right after\n- a\n- b **c**\nmore',
  `${FENCE}\n<b>\n\nx & y\n${FENCE}\nafter`,
  'use `a*b*c` and **bold** and [link](http://x.io/?a=1&b=2)',
  '#### not heading\n# real',
  'a < b & c > d',
  'line1\r\nline2\r\n\r\npara2',
  `${FENCE}js\ncode\n`,
  '- only item',
  '',
  '   \n\n  ',
  'one\n\n\n\ntwo *x* `<i>`',
];

// ── inventory (T1) ─────────────────────────────────────────────────────────────────────────────
const INV_SPEC = `# inv — a small inventory package

Write two ES modules.

## inv/store.mjs

\`export function createStore()\` returns a store with:

- \`add(sku, qty)\` — sku must be a non-empty string of A–Z, 0–9 and "-"; qty must be a positive integer.
  Otherwise throw an Error whose message is exactly "invalid sku" or "invalid qty" (sku is checked
  first). Adds qty to the sku's count.
- \`remove(sku, qty)\` — the same validation. If the sku has fewer than qty items (or is unknown),
  throw Error("insufficient stock") and change nothing. A count that reaches 0 removes the sku.
- \`count(sku)\` — the current count; 0 for an unknown sku. No validation.
- \`list()\` — an array of [sku, count] pairs sorted by sku.

## inv/cli.mjs

\`export function run(argv, store)\` returns \`{ code, out }\`. It never throws and never prints.

- \`["add", SKU, N]\` and \`["remove", SKU, N]\` — N must be a string of digits only ("3", not "3.0" or
  "+3"), else it is a usage error. On success: code 0, out "ok". When the store throws: code 1,
  out "error: " followed by the error's message.
- \`["count", SKU]\` — code 0, out the count as a string.
- \`["list"]\` — code 0, out one "SKU COUNT" line per sku joined with "\\n" ("" when empty).
- Anything else (an unknown command, the wrong number of arguments): code 2, out
  "usage: inv add|remove SKU N | count SKU | list".
`;
const INV_STORE_REF = `export function createStore() {
  const m = new Map();
  const check = (sku, qty) => {
    if (typeof sku !== 'string' || !/^[A-Z0-9-]+$/.test(sku)) throw new Error('invalid sku');
    if (!Number.isInteger(qty) || qty <= 0) throw new Error('invalid qty');
  };
  return {
    add(sku, qty) { check(sku, qty); m.set(sku, (m.get(sku) || 0) + qty); },
    remove(sku, qty) { check(sku, qty); const c = m.get(sku) || 0; if (c < qty) throw new Error('insufficient stock'); if (c === qty) m.delete(sku); else m.set(sku, c - qty); },
    count(sku) { return m.get(sku) || 0; },
    list() { return [...m].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); },
  };
}
`;
const INV_CLI_REF = `const USAGE = 'usage: inv add|remove SKU N | count SKU | list';
export function run(argv, store) {
  const [cmd, ...a] = argv;
  try {
    if ((cmd === 'add' || cmd === 'remove') && a.length === 2) {
      if (!/^[0-9]+$/.test(a[1])) return { code: 2, out: USAGE };
      store[cmd](a[0], Number(a[1]));
      return { code: 0, out: 'ok' };
    }
    if (cmd === 'count' && a.length === 1) return { code: 0, out: String(store.count(a[0])) };
    if (cmd === 'list' && a.length === 0) return { code: 0, out: store.list().map(([s, c]) => s + ' ' + c).join('\\n') };
    return { code: 2, out: USAGE };
  } catch (e) { return { code: 1, out: 'error: ' + e.message }; }
}
`;
// Each case is one expression run against fresh modules; `S()` makes a store.
const INV_CASES = [
  "(() => { const s = createStore(); s.add('AB-1', 3); s.add('AB-1', 2); return s.count('AB-1'); })()",
  "(() => { const s = createStore(); s.add('B', 1); s.add('A', 2); return s.list(); })()",
  "(() => { const s = createStore(); s.add('X', 2); s.remove('X', 2); return [s.count('X'), s.list()]; })()",
  "(() => { const s = createStore(); s.add('X', 1); try { s.remove('X', 5); } catch (e) { return [e.message, s.count('X')]; } return 'no throw'; })()",
  "(() => { const s = createStore(); try { s.add('ab', 1); } catch (e) { return e.message; } return 'no throw'; })()",
  "(() => { const s = createStore(); try { s.add('', 0); } catch (e) { return e.message; } return 'no throw'; })()",
  "(() => { const s = createStore(); try { s.add('A', 1.5); } catch (e) { return e.message; } return 'no throw'; })()",
  "(() => { const s = createStore(); try { s.remove('NOPE', 1); } catch (e) { return e.message; } return 'no throw'; })()",
  "(() => { const s = createStore(); return [run(['add', 'W-9', '4'], s), run(['count', 'W-9'], s), run(['remove', 'W-9', '1'], s), run(['list'], s)]; })()",
  "(() => { const s = createStore(); return [run(['add', 'W', '3.0'], s), run(['add', 'W', '+3'], s), run(['add', 'W'], s), run(['frob'], s), run([], s)]; })()",
  "(() => { const s = createStore(); return [run(['remove', 'W', '1'], s), run(['add', 'w', '1'], s), run(['add', 'W', '0'], s)]; })()",
  "(() => { const s = createStore(); s.add('B', 1); s.add('A', 2); return run(['list'], s); })()",
  "(() => { const s = createStore(); return [run(['list'], s), run(['count', 'Q'], s), run(['list', 'x'], s)]; })()",
];

// ── ledger (T2 fix-red) ────────────────────────────────────────────────────────────────────────
const LEDGER_README = `# ledger

- \`sum(amounts)\` (ledger/money.mjs): amounts are strings with exactly 2 decimals and may use ","
  as a thousands separator ("1,234.50"). Returns the exact total as a string with 2 decimals.
- \`createLedger(entries?)\` (ledger/ledger.mjs): a ledger over its OWN array of { name, amount }
  entries (a copy of \`entries\` when given). Two ledgers never share entries.
  - \`add(entry)\` appends an entry.
  - \`total()\` is sum() over the amounts.
  - \`recent(n)\` returns the last n entries, oldest first (all of them when there are fewer than n).
- \`largest(entries, n)\` (ledger/report.mjs): the n entries with the largest amounts, largest
  first. It does not reorder \`entries\`.
`;
const LEDGER_MONEY = `// see README.md
export function sum(amounts) {
  return amounts.reduce((s, a) => s + parseFloat(a), 0).toFixed(2);
}
`;
const LEDGER_LEDGER = `import { sum } from './money.mjs';
// see README.md
const NONE = [];
export function createLedger(entries = NONE) {
  return {
    add(entry) { entries.push(entry); },
    total() { return sum(entries.map((e) => e.amount)); },
    recent(n) { return entries.slice(-n - 1); },
  };
}
`;
const LEDGER_REPORT = `// see README.md
export function largest(entries, n) {
  const toNum = (a) => Number(String(a).replace(/,/g, ''));
  return [...entries].sort((a, b) => toNum(a.amount) - toNum(b.amount)).slice(0, n);
}
`;
const LEDGER_TEST = `import assert from 'node:assert/strict';
import { createLedger } from '../ledger/ledger.mjs';
import { largest } from '../ledger/report.mjs';

const a = createLedger();
const b = createLedger();
a.add({ name: 'rent', amount: '1,200.00' });
assert.equal(b.recent(5).length, 0, 'two ledgers must not share entries');

const l = createLedger([{ name: 'x', amount: '1.00' }, { name: 'y', amount: '2.00' }, { name: 'z', amount: '3.00' }]);
assert.deepEqual(l.recent(2).map((e) => e.name), ['y', 'z'], 'recent(2) is the last two');

assert.deepEqual(largest([{ name: 'p', amount: '5.00' }, { name: 'q', amount: '50.00' }, { name: 'r', amount: '7.50' }], 2).map((e) => e.name), ['q', 'r'], 'largest first');
console.log('ledger tests passed');
`;
const LEDGER_MONEY_FIX = `// see README.md
export function sum(amounts) {
  const cents = amounts.reduce((s, a) => s + Math.round(Number(String(a).replace(/,/g, '')) * 100), 0);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return sign + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}
`;
const LEDGER_LEDGER_FIX = `import { sum } from './money.mjs';
// see README.md
export function createLedger(entries = []) {
  const own = [...entries];
  return {
    add(entry) { own.push(entry); },
    total() { return sum(own.map((e) => e.amount)); },
    recent(n) { return n > 0 ? own.slice(-n) : []; },
  };
}
`;
const LEDGER_REPORT_FIX = `// see README.md
export function largest(entries, n) {
  const toNum = (a) => Number(String(a).replace(/,/g, ''));
  return [...entries].sort((a, b) => toNum(b.amount) - toNum(a.amount)).slice(0, n);
}
`;
const LEDGER_CASES = [
  ["sum(['1,234.50', '0.10', '0.20'])", '1234.80'],
  ["sum(['0.10', '0.20', '0.30', '0.40', '0.10', '0.20', '0.30', '0.40', '0.10', '0.20'])", '2.20'],
  ["sum([])", '0.00'],
  ["(() => { const a = createLedger(); const b = createLedger(); a.add({ name: 'r', amount: '1.00' }); return [a.recent(9).length, b.recent(9).length]; })()", [1, 0]],
  ["(() => { const src = [{ name: 'x', amount: '1.00' }]; const l = createLedger(src); l.add({ name: 'y', amount: '2.00' }); return [src.length, l.total()]; })()", [1, '3.00']],
  ["createLedger([{ name: 'x', amount: '1.00' }, { name: 'y', amount: '2.00' }, { name: 'z', amount: '3.00' }]).recent(2).map((e) => e.name)", ['y', 'z']],
  ["createLedger([{ name: 'x', amount: '1.00' }]).recent(5).map((e) => e.name)", ['x']],
  ["createLedger([{ name: 'a', amount: '1,000.25' }, { name: 'b', amount: '2,000.50' }]).total()", '3000.75'],
  ["largest([{ name: 'p', amount: '5.00' }, { name: 'q', amount: '1,050.00' }, { name: 'r', amount: '7.50' }], 2).map((e) => e.name)", ['q', 'r']],
  ["(() => { const e = [{ name: 'p', amount: '5.00' }, { name: 'q', amount: '9.00' }]; largest(e, 1); return e.map((x) => x.name); })()", ['p', 'q']],
];

// ── router ─────────────────────────────────────────────────────────────────────────────────────
const ROUTER_STUB = `// match(routes, path): routes is an array of patterns, path a URL path like "/users/42".
// Split both on "/" and ignore empty segments, so "/users/42/" equals "/users/42" and "/" has none.
// A pattern segment is a literal ("users"), a parameter (":id" — matches any one segment), or "*"
// (only as the LAST segment — matches one or more remaining segments).
// Return { route, params } for the best matching pattern, or null when none matches. params maps each
// parameter name to its segment decoded with decodeURIComponent, and "*" (when present) to the
// remaining segments, each decoded, joined with "/".
// Best match: compare the matching patterns segment by segment from the left; at the first position
// where they differ in kind, a literal beats a parameter and a parameter beats "*". If still tied,
// the pattern that comes first in routes wins.
export function match(routes, path) {
  throw new Error('TODO');
}
`;
const ROUTER_REF = `export function match(routes, path) {
  const segs = path.split('/').filter(Boolean);
  let best = null;
  for (const route of routes) {
    const ps = route.split('/').filter(Boolean);
    const params = {}; const kinds = []; let ok = true;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p === '*' && i === ps.length - 1) { if (segs.length <= i) { ok = false; break; } params['*'] = segs.slice(i).map(decodeURIComponent).join('/'); kinds.push(2); break; }
      if (i >= segs.length) { ok = false; break; }
      if (p.startsWith(':')) { params[p.slice(1)] = decodeURIComponent(segs[i]); kinds.push(1); }
      else if (p === segs[i]) kinds.push(0);
      else { ok = false; break; }
    }
    if (ok && ps[ps.length - 1] !== '*' && ps.length !== segs.length) ok = false;
    if (!ok) continue;
    if (!best || better(kinds, best.kinds)) best = { route, params, kinds };
  }
  return best ? { route: best.route, params: best.params } : null;
}
function better(a, b) { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; }
`;
const R = "['/', '/about', '/users/:id', '/users/me', '/users/:id/posts/:post', '/files/*', '/files/:name', '/:page']";
const ROUTER_EXPRS = ['/', '/about', '/users/42', '/users/me', '/users/me/', '/users/7/posts/hello%20world', '/files/a.txt', '/files/a/b%2Fc', '/contact', '/nope/deep', '/files']
  .map((p) => `match(${R}, ${JSON.stringify(p)})`).concat(["match(['/x/:a', '/x/:b'], '/x/1')", "match([], '/')", "match(['/a/*', '/a/:x/:y'], '/a/b/c')"]);

// ── expression evaluator ───────────────────────────────────────────────────────────────────────
const EXPR_STUB = `// evaluate(src): the value of an arithmetic expression over numbers (digits with an optional decimal
// part: 3, 2.5 — not .5 or 1.), the operators + - * / ^ and parentheses, with spaces allowed between
// tokens. Precedence, lowest first: binary + and - (left-associative); * and / (left-associative);
// unary minus; ^ (right-associative). The exponent of ^ may itself begin with a unary minus.
// So -2^2 is -4, 2^3^2 is 512, 2*-3 is -6, 1-2-3 is -4, 2^-1 is 0.5. There is no unary plus.
// Throw Error("division by zero") when dividing by 0, and Error("syntax error") for anything that is
// not a valid expression (empty input, unbalanced parentheses, a dangling operator, "2 3", "1..2", "+2").
export function evaluate(src) {
  throw new Error('TODO');
}
`;
const EXPR_REF = String.raw`export function evaluate(src) {
  const toks = []; const re = /\s*(?:(\d+(?:\.\d+)?)|([-+*/^()]))/y; let i = 0; const s = String(src);
  while (i < s.length) {
    if (/^\s*$/.test(s.slice(i))) break;
    re.lastIndex = i; const m = re.exec(s);
    if (!m) throw new Error('syntax error');
    toks.push(m[1] !== undefined ? { n: Number(m[1]) } : { o: m[2] }); i = re.lastIndex;
    if (m[1] !== undefined && /^\.(?!\d)/.test(s.slice(i))) throw new Error('syntax error');
  }
  let k = 0;
  const peek = () => toks[k], is = (o) => toks[k] && toks[k].o === o;
  const expr = () => { let v = term(); while (is('+') || is('-')) { const o = toks[k++].o; const r = term(); v = o === '+' ? v + r : v - r; } return v; };
  const term = () => { let v = unary(); while (is('*') || is('/')) { const o = toks[k++].o; const r = unary(); if (o === '/' && r === 0) throw new Error('division by zero'); v = o === '*' ? v * r : v / r; } return v; };
  const unary = () => { if (is('-')) { k++; return -unary(); } return power(); };
  const power = () => { const b = primary(); if (is('^')) { k++; return b ** unary(); } return b; };
  const primary = () => {
    const t = peek(); if (!t) throw new Error('syntax error');
    if (t.n !== undefined) { k++; return t.n; }
    if (t.o === '(') { k++; const v = expr(); if (!is(')')) throw new Error('syntax error'); k++; return v; }
    throw new Error('syntax error');
  };
  const v = expr();
  if (k !== toks.length) throw new Error('syntax error');
  return v;
}
`;
const EXPR_OK = ['1 + 2 * 3', '(1 + 2) * 3', '-2^2', '2^3^2', '2*-3', '1-2-3', '2^-1', ' 10 / 4 ', '--3', '(((4)))', '3 - -2', '2.5 * 4', '-(2 + 3)^2'];
const EXPR_DIV = ['1/0', '5 / (2 - 2)'];
const EXPR_BAD = ['', '(1+2', '1+', '2 3', '1..2', '+2', '1.', '.5', '()', '2 ^', '3)'];

// ── cron ───────────────────────────────────────────────────────────────────────────────────────
const CRON_STUB = `// nextRun(expr, from): the first minute strictly after \`from\` (an ISO string in UTC such as
// "2026-10-01T10:15:00Z") that matches the 5-field cron expression "minute hour day-of-month month
// day-of-week", as "YYYY-MM-DDTHH:MM:00Z" (UTC). Seconds in \`from\` count: after 10:15:30 the first
// candidate is 10:16.
// A field is "*" or a comma-separated list of items; an item is a number, a range "a-b", or either of
// those (or "*") followed by "/step": "*/15" in the minute field is 0,15,30,45; "10-30/10" is 10,20,30.
// Ranges: minute 0-59, hour 0-23, day-of-month 1-31, month 1-12, day-of-week 0-6 with 0 = Sunday.
// Day rule: if BOTH day-of-month and day-of-week are restricted (neither is "*"), a day matches when
// EITHER matches; otherwise the restricted one (if any) must match.
// Search at most 4 years after \`from\`; return null when nothing matches ("0 0 31 2 *").
export function nextRun(expr, from) {
  throw new Error('TODO');
}
`;
const CRON_REF = `export function nextRun(expr, from) {
  const LIM = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const f = expr.trim().split(/\\s+/);
  const sets = f.map((field, k) => {
    const [lo, hi] = LIM[k]; const s = new Set();
    for (const item of field.split(',')) {
      const [rng, st] = item.split('/'); const step = st ? Number(st) : 1;
      let a, b;
      if (rng === '*') { a = lo; b = hi; } else if (rng.includes('-')) { [a, b] = rng.split('-').map(Number); } else { a = Number(rng); b = st ? hi : a; }
      for (let v = a; v <= b; v += step) s.add(v);
    }
    return s;
  });
  const domR = f[2] !== '*', dowR = f[4] !== '*';
  const dayOk = (d) => { const dm = sets[2].has(d.getUTCDate()), dw = sets[4].has(d.getUTCDay()); return domR && dowR ? dm || dw : (!domR || dm) && (!dowR || dw); };
  const start = new Date(from); start.setUTCSeconds(0, 0); let t = start.getTime() + 60000;
  const limit = new Date(from).getTime() + 4 * 366 * 86400000;
  while (t <= limit) {
    const d = new Date(t);
    if (!sets[3].has(d.getUTCMonth() + 1) || !dayOk(d)) { t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); continue; }
    if (!sets[1].has(d.getUTCHours())) { t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1); continue; }
    if (sets[0].has(d.getUTCMinutes())) return d.toISOString().slice(0, 16) + ':00Z';
    t += 60000;
  }
  return null;
}
`;
const CRON_ARGS = [
  ['*/15 * * * *', '2026-10-01T10:15:30Z'], ['0 9 * * 1-5', '2026-10-02T09:00:00Z'], ['30 2 1 * *', '2026-10-01T02:30:00Z'],
  ['0 0 13 * 5', '2026-10-01T00:00:00Z'], ['0 0 29 2 *', '2026-03-01T00:00:00Z'], ['0 0 31 2 *', '2026-01-01T00:00:00Z'],
  ['10-30/10 8 * * *', '2026-10-01T08:25:00Z'], ['0 12 * 1,6 0', '2026-10-01T00:00:00Z'], ['59 23 31 12 *', '2026-12-31T23:59:00Z'],
  ['5 4 * * 0', '2026-10-03T23:59:59Z'],
];

// ── glob ───────────────────────────────────────────────────────────────────────────────────────
const GLOB_STUB = String.raw`// globMatch(pattern, path): does the WHOLE path match the glob pattern? Paths use "/".
// - "?" matches one character other than "/".
// - "*" matches any run of characters (possibly empty) other than "/".
// - "**" as a whole path segment matches zero or more whole segments: "a/**/b" matches "a/b" and
//   "a/p/q/b"; "**/x" matches "x" and "p/q/x"; "a/**" matches "a", "a/b" and "a/b/c". Anywhere else
//   "**" behaves like "*".
// - "[abc]" matches one listed character, "[a-z]" one character in the range, "[!...]" one character
//   NOT listed or in the range. A class never matches "/". A "[" with no closing "]" is literal.
// - "\" makes the next character literal: "\*" matches only "*".
export function globMatch(pattern, path) {
  throw new Error('TODO');
}
`;
const GLOB_REF = String.raw`const lit = (c) => c.replace(/[.*+?^${'$'}{}()|[\]\\]/g, '\\$&');
export function globMatch(pattern, path) {
  const p = pattern; let re = '^'; let i = 0;
  const segStart = (k) => k === 0 || p[k - 1] === '/';
  while (i < p.length) {
    const ch = p[i];
    if (ch === '\\' && i + 1 < p.length) { re += lit(p[i + 1]); i += 2; continue; }
    if (ch === '*' && p[i + 1] === '*' && segStart(i) && (i + 2 === p.length || p[i + 2] === '/')) {
      if (i + 2 === p.length) { re = i === 0 ? re + '.*' : re.slice(0, -1) + '(?:/.*)?'; i += 2; continue; }
      re += '(?:.*/)?'; i += 3; continue;
    }
    if (ch === '*') { re += '[^/]*'; i += p[i + 1] === '*' ? 2 : 1; continue; }
    if (ch === '?') { re += '[^/]'; i++; continue; }
    if (ch === '[') {
      const j = p.indexOf(']', i + 2);
      if (j > 0) { let body = p.slice(i + 1, j); const neg = body[0] === '!'; if (neg) body = body.slice(1); body = body.replace(/[\\\]^]/g, '\\$&'); re += neg ? '[^/' + body + ']' : '(?!/)[' + body + ']'; i = j + 1; continue; }
    }
    re += lit(ch); i++;
  }
  return new RegExp(re + '$').test(path);
}
`;
const GLOB_ARGS = [
  ['*.js', 'a.js'], ['*.js', 'dir/a.js'], ['**/*.js', 'dir/sub/a.js'], ['**/*.js', 'a.js'], ['src/**/test/*.mjs', 'src/test/x.mjs'],
  ['src/**/test/*.mjs', 'src/a/b/test/x.mjs'], ['src/**', 'src'], ['src/**', 'src/a/b'], ['src/**', 'srcx'], ['?.txt', 'a.txt'],
  ['?.txt', 'ab.txt'], ['file[0-9].log', 'file7.log'], ['file[!0-9].log', 'file7.log'], ['file[!0-9].log', 'fileA.log'],
  ['a\\*b', 'a*b'], ['a\\*b', 'axb'], ['a*b', 'a/b'], ['a**b', 'axyb'], ['a**b', 'a/b'], ['[abc]/x', 'b/x'], ['a[b', 'a[b'], ['x.y', 'xzy'],
];

// ── template ───────────────────────────────────────────────────────────────────────────────────
const TPL_STUB = `// render(template, data):
// - {{name}} is replaced by the value of name, HTML-escaped (& < > " ' become &amp; &lt; &gt; &quot;
//   &#39;); {{{name}}} inserts it unescaped. A missing name, null or undefined renders as "".
//   Numbers and booleans render as String(value).
// - name may be a dotted path ("user.name"); "." is the current context itself.
// - {{#name}}…{{/name}}: if the value is a non-empty array, render the inside once per item with the
//   item as the context; if it is any other truthy value, render the inside once — with that value
//   as the context when it is an object, else with the current context; if it is falsy or an empty
//   array, render nothing.
// - {{^name}}…{{/name}}: render the inside (with the current context) only when the value is falsy or
//   an empty array.
// - Lookup: the first segment of a name is looked up in the current context, then in each enclosing
//   context outward; the remaining segments are read from that value.
// - Spaces inside the braces are ignored: {{ name }} is {{name}}.
export function render(template, data) {
  throw new Error('TODO');
}
`;
const TPL_REF = String.raw`const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function render(template, data) { return run(parse(template), [data]); }
function parse(t) {
  const root = []; const stack = [{ body: root }]; let i = 0; let m;
  const re = /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([#^/]?)\s*([^}]+?)\s*\}\}/g;
  while ((m = re.exec(t))) {
    const top = stack[stack.length - 1].body;
    if (m.index > i) top.push(t.slice(i, m.index));
    i = re.lastIndex;
    if (m[1] !== undefined) top.push({ t: 'raw', name: m[1] });
    else if (m[2] === '#' || m[2] === '^') { const node = { t: m[2], name: m[3], body: [] }; top.push(node); stack.push(node); }
    else if (m[2] === '/') stack.pop();
    else top.push({ t: 'var', name: m[3] });
  }
  if (i < t.length) stack[stack.length - 1].body.push(t.slice(i));
  return root;
}
function lookup(name, ctx) {
  if (name === '.') return ctx[ctx.length - 1];
  const [head, ...rest] = name.split('.');
  for (let k = ctx.length - 1; k >= 0; k--) {
    const c = ctx[k];
    if (c !== null && typeof c === 'object' && head in c) { let v = c[head]; for (const r of rest) v = v == null ? undefined : v[r]; return v; }
  }
  return undefined;
}
function run(nodes, ctx) {
  let out = '';
  for (const n of nodes) {
    if (typeof n === 'string') { out += n; continue; }
    const v = lookup(n.name, ctx);
    if (n.t === 'var' || n.t === 'raw') { const s = v == null ? '' : String(v); out += n.t === 'raw' ? s : s.replace(/[&<>"']/g, (c) => ESC[c]); }
    else if (n.t === '#') { if (Array.isArray(v)) { for (const item of v) out += run(n.body, [...ctx, item]); } else if (v) out += run(n.body, typeof v === 'object' ? [...ctx, v] : ctx); }
    else if (!v || (Array.isArray(v) && !v.length)) out += run(n.body, ctx);
  }
  return out;
}
`;
const TPL_ARGS = [
  ['Hi {{name}}!', { name: '<Ann>' }], ['{{{html}}}', { html: '<b>x</b>' }], ['{{user.name}} ({{user.age}})', { user: { name: 'Bo', age: 30 } }],
  ['{{#items}}<{{.}}>{{/items}}', { items: ['a', 'b'] }], ['{{#people}}{{name}} from {{city}};{{/people}}', { city: 'Pune', people: [{ name: 'A' }, { name: 'B', city: 'Goa' }] }],
  ['{{^items}}none{{/items}}', { items: [] }], ['{{#flag}}yes{{/flag}}{{^flag}}no{{/flag}}', { flag: false }], ['{{missing}}|{{ spaced }}', { spaced: 0 }],
  ['{{#user}}{{name}}{{/user}}', { user: { name: 'Cy' } }], ['{{q}}', { q: `"it's"` }], ['{{#n}}[{{n}}]{{/n}}', { n: 5 }],
  ['{{#a}}{{#b}}{{x}}{{/b}}{{/a}}', { x: 1, a: { b: [{ x: 2 }, {}] } }], ['{{#e}}x{{/e}}{{^e}}y{{/e}}{{t}}', { e: [], t: true }],
];

// ── JSON Patch ─────────────────────────────────────────────────────────────────────────────────
const PATCH_STUB = `// apply(doc, ops): apply JSON Patch operations (RFC 6902) to a COPY of doc and return the copy; doc
// itself is never modified. ops is an array of { op, path, value?, from? }, op one of add, remove,
// replace, move, copy, test. Paths are JSON Pointers: "" is the whole document; "/a/b" walks keys;
// in a key "~1" means "/" and "~0" means "~"; array indexes are decimal numbers; "-" (add only)
// means "after the last element".
// - add: on an object sets the key (replacing any value); on an array inserts BEFORE the index,
//   which may equal the length. A path of "" replaces the whole document.
// - remove / replace: the target must exist.
// - move: remove the value at \`from\`, then add it at \`path\`. copy: add a deep copy of \`from\`'s value.
// - test: the value at path must deep-equal \`value\`.
// Any failure (a missing parent or target, a bad index, a failed test, an unknown op) throws
// Error("patch failed").
export function apply(doc, ops) {
  throw new Error('TODO');
}
`;
const PATCH_REF = `const clone = (v) => JSON.parse(JSON.stringify(v));
const fail = () => { throw new Error('patch failed'); };
const parts = (p) => (p === '' ? [] : p.startsWith('/') ? p.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')) : fail());
const idx = (arr, k, allowEnd) => { if (allowEnd && k === '-') return arr.length; if (!/^(0|[1-9][0-9]*)$/.test(k)) fail(); const n = Number(k); if (n > arr.length || (!allowEnd && n === arr.length)) fail(); return n; };
function parentOf(root, ps) { let c = root; for (const k of ps.slice(0, -1)) { if (Array.isArray(c)) c = c[idx(c, k, false)]; else if (c && typeof c === 'object' && Object.hasOwn(c, k)) c = c[k]; else fail(); } if (!c || typeof c !== 'object') fail(); return c; }
function get(root, path) { const ps = parts(path); if (!ps.length) return root; const p = parentOf(root, ps); const k = ps[ps.length - 1]; if (Array.isArray(p)) return p[idx(p, k, false)]; if (!Object.hasOwn(p, k)) fail(); return p[k]; }
function add(root, path, value) { const ps = parts(path); if (!ps.length) return value; const p = parentOf(root, ps); const k = ps[ps.length - 1]; if (Array.isArray(p)) p.splice(idx(p, k, true), 0, value); else p[k] = value; return root; }
function remove(root, path) { const ps = parts(path); if (!ps.length) fail(); const p = parentOf(root, ps); const k = ps[ps.length - 1]; if (Array.isArray(p)) p.splice(idx(p, k, false), 1); else { if (!Object.hasOwn(p, k)) fail(); delete p[k]; } return root; }
const deq = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
export function apply(doc, ops) {
  let root = clone(doc);
  for (const o of ops) {
    if (o.op === 'add') root = add(root, o.path, clone(o.value));
    else if (o.op === 'remove') root = remove(root, o.path);
    else if (o.op === 'replace') { get(root, o.path); root = o.path === '' ? clone(o.value) : add(remove(root, o.path), o.path, clone(o.value)); }
    else if (o.op === 'move') { const v = get(root, o.from); root = add(remove(root, o.from), o.path, v); }
    else if (o.op === 'copy') root = add(root, o.path, clone(get(root, o.from)));
    else if (o.op === 'test') { if (!deq(get(root, o.path), o.value)) fail(); }
    else fail();
  }
  return root;
}
`;
const PATCH_ARGS = [
  [{ a: 1 }, [{ op: 'add', path: '/b', value: 2 }]],
  [{ l: [1, 3] }, [{ op: 'add', path: '/l/1', value: 2 }, { op: 'add', path: '/l/-', value: 4 }]],
  [{ a: { b: 1, c: 2 } }, [{ op: 'remove', path: '/a/b' }]],
  [{ a: 1 }, [{ op: 'replace', path: '/a', value: { x: [1] } }]],
  [{ a: { b: 1 }, c: {} }, [{ op: 'move', from: '/a/b', path: '/c/d' }]],
  [{ l: ['x', 'y', 'z'] }, [{ op: 'move', from: '/l/0', path: '/l/2' }]],
  [{ a: [1, 2] }, [{ op: 'copy', from: '/a', path: '/b' }, { op: 'add', path: '/b/-', value: 3 }]],
  [{ 'a/b': 1, 'c~d': 2 }, [{ op: 'replace', path: '/a~1b', value: 10 }, { op: 'remove', path: '/c~0d' }]],
  [{ a: 1 }, [{ op: 'test', path: '/a', value: 1 }, { op: 'add', path: '', value: [9] }]],
];
const PATCH_FAILS = [
  [{ a: 1 }, [{ op: 'remove', path: '/b' }]], [{ a: 1 }, [{ op: 'replace', path: '/b', value: 1 }]], [{ l: [1] }, [{ op: 'add', path: '/l/2', value: 0 }]],
  [{ l: [1] }, [{ op: 'remove', path: '/l/01' }]], [{ a: 1 }, [{ op: 'test', path: '/a', value: 2 }]], [{ a: 1 }, [{ op: 'add', path: '/x/y', value: 1 }]], [{ a: 1 }, [{ op: 'frob', path: '/a' }]],
];

// ── the tasks ──────────────────────────────────────────────────────────────────────────────────
const [mdlite, store, cli, ledgerMoney, ledgerLedger, ledgerReport, router, expr, cron, glob, tpl, patch] = await Promise.all(
  [MDLITE_REF, INV_STORE_REF, INV_CLI_REF, LEDGER_MONEY_FIX, LEDGER_LEDGER_FIX.replace("import { sum } from './money.mjs';\n", LEDGER_MONEY_FIX), LEDGER_REPORT_FIX, ROUTER_REF, EXPR_REF, CRON_REF, GLOB_REF, TPL_REF, PATCH_REF].map(load));
const lit = (v) => JSON.stringify(v);
// Evaluate a case expression against reference exports, in this realm, for its expected value.
const evalWith = (scope, expr) => new Function(...Object.keys(scope), `return (${expr});`)(...Object.values(scope));
const casesFrom = (scope, exprs) => exprs.map((e) => [e, evalWith(scope, e)]);

const throwsCase = (e, re) => [e, { throws: re }];
const buildTask = (t) => ({ tier: 'hard', family: 'hard-build', ...t });
export const BUILD_TASKS = Object.freeze([
  buildTask({ id: 'build-mdlite', split: 'test', gated: true, seed: { 'SPEC.md': MDLITE_SPEC },
    prompt: 'Build mdlite.mjs: an ES module that exports render(markdown), implementing SPEC.md exactly. You may put tests under test/.',
    gate: all(hiddenTest(testSource("import { render } from '../mdlite.mjs';", casesFrom({ render: mdlite.render }, MDLITE_INPUTS.map((s) => `render(${lit(s)})`)))), onlyChanged(['mdlite.mjs', 'test/'])),
    solve: [write('mdlite.mjs', MDLITE_REF), { tool: 'task_done', args: { summary: 'built mdlite' } }] }),
  buildTask({ id: 'build-inventory', split: 'train', gated: true, seed: { 'SPEC.md': INV_SPEC },
    prompt: 'Build the inv package described in SPEC.md (inv/store.mjs and inv/cli.mjs). You may put tests under test/.',
    gate: all(hiddenTest(testSource("import { createStore } from '../inv/store.mjs';\nimport { run } from '../inv/cli.mjs';", casesFrom({ createStore: store.createStore, run: cli.run }, INV_CASES))), onlyChanged(['inv/', 'test/'])),
    solve: [write('inv/store.mjs', INV_STORE_REF), write('inv/cli.mjs', INV_CLI_REF), { tool: 'task_done', args: { summary: 'built inv' } }] }),
  buildTask({ id: 'build-fix-ledger', split: 'dev', seed: { 'README.md': LEDGER_README, 'ledger/money.mjs': LEDGER_MONEY, 'ledger/ledger.mjs': LEDGER_LEDGER, 'ledger/report.mjs': LEDGER_REPORT, 'test/ledger.test.mjs': LEDGER_TEST },
    prompt: '`node test/ledger.test.mjs` fails. Fix the ledger package so the test passes and the package behaves as README.md describes. Do not change the test.',
    gate: all(hiddenTest(testSource("import { sum } from '../ledger/money.mjs';\nimport { createLedger } from '../ledger/ledger.mjs';\nimport { largest } from '../ledger/report.mjs';", casesFrom({ sum: ledgerMoney.sum, createLedger: ledgerLedger.createLedger, largest: ledgerReport.largest }, LEDGER_CASES.map((c) => c[0])))), onlyChanged(['ledger/money.mjs', 'ledger/ledger.mjs', 'ledger/report.mjs'])),
    solve: [write('ledger/money.mjs', LEDGER_MONEY_FIX), write('ledger/ledger.mjs', LEDGER_LEDGER_FIX), write('ledger/report.mjs', LEDGER_REPORT_FIX), say('Fixed 4 bugs.')] }),
  buildTask({ id: 'build-router', split: 'train', seed: { 'router.mjs': ROUTER_STUB },
    prompt: 'Implement match in router.mjs exactly as the comment at the top of the file specifies.',
    gate: all(hiddenTest(testSource("import { match } from '../router.mjs';", casesFrom({ match: router.match }, ROUTER_EXPRS))), onlyChanged(['router.mjs'])),
    solve: [write('router.mjs', ROUTER_REF), say('Implemented match.')] }),
  buildTask({ id: 'build-expr', split: 'dev', seed: { 'expr.mjs': EXPR_STUB },
    prompt: 'Implement evaluate in expr.mjs exactly as the comment at the top of the file specifies.',
    gate: all(hiddenTest(testSource("import { evaluate } from '../expr.mjs';", [
      ...casesFrom({ evaluate: expr.evaluate }, EXPR_OK.map((s) => `evaluate(${lit(s)})`)),
      ...EXPR_DIV.map((s) => throwsCase(`evaluate(${lit(s)})`, /^division by zero$/)), ...EXPR_BAD.map((s) => throwsCase(`evaluate(${lit(s)})`, /^syntax error$/)),
    ])), onlyChanged(['expr.mjs'])),
    solve: [write('expr.mjs', EXPR_REF), say('Implemented evaluate.')] }),
  buildTask({ id: 'build-cron', split: 'test', seed: { 'cron.mjs': CRON_STUB },
    prompt: 'Implement nextRun in cron.mjs exactly as the comment at the top of the file specifies.',
    gate: all(hiddenTest(testSource("import { nextRun } from '../cron.mjs';", casesFrom({ nextRun: cron.nextRun }, CRON_ARGS.map(([e, f]) => `nextRun(${lit(e)}, ${lit(f)})`)))), onlyChanged(['cron.mjs'])),
    solve: [write('cron.mjs', CRON_REF), say('Implemented nextRun.')] }),
  buildTask({ id: 'build-glob', split: 'test', seed: { 'glob.mjs': GLOB_STUB },
    prompt: 'Implement globMatch in glob.mjs exactly as the comment at the top of the file specifies.',
    gate: all(hiddenTest(testSource("import { globMatch } from '../glob.mjs';", casesFrom({ globMatch: glob.globMatch }, GLOB_ARGS.map(([p, s]) => `globMatch(${lit(p)}, ${lit(s)})`)))), onlyChanged(['glob.mjs'])),
    solve: [write('glob.mjs', GLOB_REF), say('Implemented globMatch.')] }),
  buildTask({ id: 'build-template', split: 'train', seed: { 'template.mjs': TPL_STUB },
    prompt: 'Implement render in template.mjs exactly as the comment at the top of the file specifies.',
    gate: all(hiddenTest(testSource("import { render } from '../template.mjs';", casesFrom({ render: tpl.render }, TPL_ARGS.map(([t, d]) => `render(${lit(t)}, ${lit(d)})`)))), onlyChanged(['template.mjs'])),
    solve: [write('template.mjs', TPL_REF), say('Implemented render.')] }),
  buildTask({ id: 'build-json-patch', split: 'dev', seed: { 'patch.mjs': PATCH_STUB },
    prompt: 'Implement apply in patch.mjs exactly as the comment at the top of the file specifies.',
    gate: all(hiddenTest(testSource("import { apply } from '../patch.mjs';", [
      ...casesFrom({ apply: patch.apply }, PATCH_ARGS.map(([d, o]) => `apply(${lit(d)}, ${lit(o)})`)),
      ["(() => { const d = { a: { b: [1] } }; apply(d, [{ op: 'add', path: '/a/b/-', value: 2 }, { op: 'add', path: '/a/c', value: 3 }]); return d; })()", { a: { b: [1] } }],
      ...PATCH_FAILS.map(([d, o]) => throwsCase(`apply(${lit(d)}, ${lit(o)})`, /^patch failed$/)),
    ])), onlyChanged(['patch.mjs'])),
    solve: [write('patch.mjs', PATCH_REF), say('Implemented apply.')] }),
]);
