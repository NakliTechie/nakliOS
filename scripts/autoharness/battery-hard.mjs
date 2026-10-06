// The hard tier of the autoharness battery (Chirag 2026-10-01, option (a)): tasks the base battery
// lacked, so the optimizer has failures to read and dev can rank an edit by more than 1–2 tasks.
//
// Three families. hard-code: implement or fix a module to a precise spec, UNGATED (the bed has no
// node runner, so the model cannot execute its code; correctness comes from reading the spec).
// hard-data: exact-format data work with the curated shell (awk, sort, jq, uniq, grep). hard-repo:
// multi-file chores with a trap (a decoy that must not change, a heading inside a code fence).
// Every expected value is computed below from the seed, never typed by hand.
import { all, no, ok, onlyChanged, fileEq, absent, answerFile, jsonEq, jsGate, sh, read, write, edit, say } from './gates.mjs';

// A deterministic generator, so a seed never changes between runs.
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }

// ── hard-code ──────────────────────────────────────────────────────────────────────────────────
const SEMVER_STUB = `// compareSemver(a, b) returns -1 if a < b, 0 if equal, 1 if a > b, by semver 2.0.0 precedence:
// - MAJOR.MINOR.PATCH compare numerically ("1.10.0" > "1.9.0").
// - A pre-release version ("1.0.0-alpha") is lower than the same version without one ("1.0.0").
// - Pre-release identifiers (the part after the first "-", split on ".") compare left to right:
//   numeric ones numerically, others in ASCII order, and a numeric identifier is lower than a
//   non-numeric one. If every shared identifier is equal, the version with fewer identifiers is lower.
// - Build metadata (after "+") is ignored: "1.0.0+abc" equals "1.0.0".
export function compareSemver(a, b) {
  throw new Error('TODO');
}
`;
const SEMVER_REF = String.raw`export function compareSemver(a, b) {
  const parse = (v) => {
    const s = String(v).split('+')[0];
    const i = s.indexOf('-');
    return { core: (i < 0 ? s : s.slice(0, i)).split('.').map(Number), pre: i < 0 ? null : s.slice(i + 1).split('.') };
  };
  const id = (x, y) => {
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return Math.sign(Number(x) - Number(y));
    if (nx) return -1;
    if (ny) return 1;
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const A = parse(a), B = parse(b);
  for (let k = 0; k < 3; k++) if (A.core[k] !== B.core[k]) return A.core[k] < B.core[k] ? -1 : 1;
  if (!A.pre && !B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  for (let k = 0; k < Math.min(A.pre.length, B.pre.length); k++) { const r = id(A.pre[k], B.pre[k]); if (r) return r; }
  return Math.sign(A.pre.length - B.pre.length);
}
`;
const CSV_STUB = `// parseCsvLine(line) splits ONE line of CSV into an array of field strings:
// - fields are separated by commas;
// - a field that starts with a double quote is quoted: up to its closing quote, commas are literal
//   and two double quotes ("") stand for one double quote; the quotes themselves are not kept;
// - unquoted fields are kept exactly as written (no trimming);
// - an empty line is one empty field: [""].
export function parseCsvLine(line) {
  throw new Error('TODO');
}
`;
const CSV_REF = String.raw`export function parseCsvLine(line) {
  const out = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += ch;
    } else if (ch === '"' && cur === '') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
`;
// The same parser, for the expected values of the quoted-CSV data task below.
const parseCsvLine = new Function(CSV_REF.replace('export function', 'return function'))();

const INTERVALS_STUB = `// merge(intervals): intervals is an array of [start, end] pairs (inclusive, start <= end), in any
// order. Return a NEW array of non-overlapping intervals sorted by start, where intervals that
// overlap OR touch (one ends exactly where the next starts) are merged. Do not modify the input.
export function merge(intervals) {
  throw new Error('TODO');
}
`;
const INTERVALS_REF = `export function merge(intervals) {
  const s = intervals.map((x) => [x[0], x[1]]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}
`;
const ROMAN_STUB = `// toRoman(n): the canonical Roman numeral for an integer 1..3999 (subtractive forms IV, IX, XL,
// XC, CD, CM); anything else (0, negatives, 4000+, non-integers) returns null.
// fromRoman(s): the integer for a CANONICAL uppercase numeral, i.e. exactly the string toRoman
// would produce; anything else ("IIII", "VX", "IC", "iv", "") returns null.
export function toRoman(n) {
  throw new Error('TODO');
}
export function fromRoman(s) {
  throw new Error('TODO');
}
`;
const ROMAN_REF = `const ROMAN = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
export function toRoman(n) {
  if (!Number.isInteger(n) || n < 1 || n > 3999) return null;
  let s = '';
  for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; }
  return s;
}
export function fromRoman(s) {
  if (typeof s !== 'string' || !/^[MDCLXVI]+$/.test(s)) return null;
  const val = { M: 1000, D: 500, C: 100, L: 50, X: 10, V: 5, I: 1 };
  let n = 0;
  for (let i = 0; i < s.length; i++) { const v = val[s[i]], w = val[s[i + 1]] || 0; n += v < w ? -v : v; }
  return toRoman(n) === s ? n : null;
}
`;
const WRAP_STUB = `// wrap(text, width): split text into words on runs of whitespace and pack them greedily into lines
// of at most \`width\` characters: words on a line are joined by one space, lines by "\\n".
// A word longer than \`width\` ends the current line (if it holds any words) and is cut into pieces
// of \`width\` characters, each on its own line; its LAST piece (at most \`width\` characters) becomes
// the current line, so the next word may join it. Text with no words returns "".
export function wrap(text, width) {
  throw new Error('TODO');
}
`;
const WRAP_REF = String.raw`export function wrap(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) {
    if (w.length > width) {
      if (cur) lines.push(cur);
      let rest = w;
      while (rest.length > width) { lines.push(rest.slice(0, width)); rest = rest.slice(width); }
      cur = rest;
    } else if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}
`;
const DURATION_STUB = `// parseDuration(s): the number of seconds in a duration string made of one or more <integer><unit>
// parts with units d (days), h, m, s. Units must appear in that order (d before h before m before
// s), each at most once, with no spaces and lowercase only. Anything else returns null:
// "1h30m" is 5400, "90m" is 5400, "" / "1h1h" / "30m1h" / "1.5h" / "1h 30m" / "2D" / "10" are null.
export function parseDuration(s) {
  throw new Error('TODO');
}
`;
const DURATION_REF = String.raw`export function parseDuration(s) {
  if (typeof s !== 'string' || s === '') return null;
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (!m) return null;
  const [, d = 0, h = 0, mi = 0, se = 0] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(mi) * 60 + Number(se);
}
`;
const MERGE_STUB = `// deepMerge(a, b): a NEW object with every key of a and b. Where both values are plain objects
// (not arrays, not null) they are merged the same way, recursively. Otherwise b's value wins,
// except that a key whose value in b is undefined keeps a's value. Arrays are replaced, never
// merged; null in b overwrites. Neither input is modified, and the result shares no plain object
// with either input.
export function deepMerge(a, b) {
  throw new Error('TODO');
}
`;
const MERGE_REF = `const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export function deepMerge(a, b) {
  const out = {};
  for (const k of Object.keys(a)) out[k] = isObj(a[k]) ? deepMerge(a[k], {}) : a[k];
  for (const k of Object.keys(b)) {
    if (b[k] === undefined) continue;
    out[k] = isObj(out[k]) && isObj(b[k]) ? deepMerge(out[k], b[k]) : isObj(b[k]) ? deepMerge({}, b[k]) : b[k];
  }
  return out;
}
`;
const TOPO_STUB = `// order(deps): deps maps each name to the array of names it depends on. A name that appears only
// as a dependency is still a node. Return every node exactly once, each after all of its
// dependencies. Whenever several nodes are ready, take the alphabetically smallest first.
// If the dependencies contain a cycle, throw an Error whose message is "cycle".
export function order(deps) {
  throw new Error('TODO');
}
`;
const TOPO_REF = `export function order(deps) {
  const nodes = new Set(Object.keys(deps));
  for (const k of Object.keys(deps)) for (const d of deps[k]) nodes.add(d);
  const indeg = new Map([...nodes].map((n) => [n, 0]));
  const users = new Map([...nodes].map((n) => [n, []]));
  for (const k of Object.keys(deps)) for (const d of deps[k]) { indeg.set(k, indeg.get(k) + 1); users.get(d).push(k); }
  const ready = [...nodes].filter((n) => indeg.get(n) === 0);
  const out = [];
  while (ready.length) {
    ready.sort();
    const n = ready.shift();
    out.push(n);
    for (const u of users.get(n)) { indeg.set(u, indeg.get(u) - 1); if (indeg.get(u) === 0) ready.push(u); }
  }
  if (out.length !== nodes.size) throw new Error('cycle');
  return out;
}
`;
const LRU_STUB = `// LRU: a least-recently-used cache holding at most \`capacity\` entries.
//   get(key): the value, or -1 when absent. A hit makes the key the most recently used.
//   put(key, value): insert or update the key and make it the most recently used; when that pushes
//   the size above capacity, evict the least recently used key.
export class LRU {
  constructor(capacity) {}
  get(key) { throw new Error('TODO'); }
  put(key, value) { throw new Error('TODO'); }
}
`;
const LRU_REF = `export class LRU {
  constructor(capacity) { this.capacity = capacity; this.map = new Map(); }
  get(key) { if (!this.map.has(key)) return -1; const v = this.map.get(key); this.map.delete(key); this.map.set(key, v); return v; }
  put(key, value) { this.map.delete(key); this.map.set(key, value); if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value); }
}
`;
const BRACKETS_STUB = String.raw`// balanced(s): true when every (, [ and { in s is closed by the matching ), ] or } in the right
// nesting order. Characters inside a quoted string -- from a ' or " to the next unescaped copy of the
// same quote -- are ignored; inside a quoted string a backslash escapes the next character. A quote
// that is never closed makes the result false.
export function balanced(s) {
  throw new Error('TODO');
}
`;
const BRACKETS_REF = String.raw`export function balanced(s) {
  const stack = []; const pairs = { ')': '(', ']': '[', '}': '{' };
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (pairs[ch] && stack.pop() !== pairs[ch]) return false;
  }
  return quote === null && stack.length === 0;
}
`;
const CART_SEED = `// total(items, { discount = 0, taxPct = 0 } = {}): items are { price, qty }.
// 1. subtotal = the sum of price * qty over the items whose qty is greater than 0 (others are ignored);
// 2. subtract the fixed discount from the subtotal, never going below 0;
// 3. add taxPct percent tax to that discounted amount;
// 4. return a NUMBER rounded to 2 decimals with Math.round(x * 100) / 100.
export function total(items, { discount = 0, taxPct = 0 } = {}) {
  let subtotal = 0;
  for (const it of items) subtotal += it.price * it.qty;
  const taxed = subtotal * (1 + taxPct / 100);
  return (taxed - discount).toFixed(2);
}
`;
const CART_REF = `export function total(items, { discount = 0, taxPct = 0 } = {}) {
  let subtotal = 0;
  for (const it of items) if (it.qty > 0) subtotal += it.price * it.qty;
  const discounted = Math.max(0, subtotal - discount);
  return Math.round(discounted * (1 + taxPct / 100) * 100) / 100;
}
`;
const PAGE_SEED = `// paginate(items, page, size): pages are numbered from 1. Returns { items, page, totalPages, hasNext }:
// items is that page's slice, totalPages is Math.ceil(items.length / size) (0 for an empty list),
// and hasNext is true when a later page exists. A page below 1 or above totalPages returns
// items: [] and hasNext: false.
export function paginate(items, page, size) {
  const totalPages = Math.floor(items.length / size);
  const start = page * size;
  return { items: items.slice(start, start + size), page, totalPages, hasNext: page < totalPages };
}
`;
const PAGE_REF = `export function paginate(items, page, size) {
  const totalPages = Math.ceil(items.length / size);
  if (page < 1 || page > totalPages) return { items: [], page, totalPages, hasNext: false };
  const start = (page - 1) * size;
  return { items: items.slice(start, start + size), page, totalPages, hasNext: page < totalPages };
}
`;
const DAYS_SEED = `// daysBetween(a, b): a and b are "YYYY-MM-DD" calendar dates. Returns the whole number of days from
// a to b (negative when b is before a), counted on the calendar: time zones and daylight-saving
// changes never affect the answer.
export function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  const t1 = new Date(y1, m1, d1).getTime();
  const t2 = new Date(y2, m2, d2).getTime();
  return Math.floor((t2 - t1) / 86400000);
}
`;
const DAYS_REF = `export function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}
`;
const implement = (file, what) => `Implement ${what} in ${file} exactly as the comment at the top of the file specifies. Keep it an ES module.`;
const codeTask = (id, split, file, stub, ref, prompt, cases) => ({
  id, split, family: 'hard-code', seed: { [file]: stub }, prompt,
  gate: all(jsGate(file, cases), onlyChanged([file])), solve: [write(file, ref), say('Implemented.')],
});
const cartCase = (items, opts) => {
  const sub = items.filter((i) => i.qty > 0).reduce((s, i) => s + i.price * i.qty, 0);
  const o = opts || {};
  return ['total', opts === undefined ? [items] : [items, opts], Math.round(Math.max(0, sub - (o.discount || 0)) * (1 + (o.taxPct || 0) / 100) * 100) / 100];
};
const seq = (n) => Array.from({ length: n }, (_, i) => i + 1);
const hardCode = [
  codeTask('hard-semver', 'test', 'semver.js', SEMVER_STUB, SEMVER_REF, implement('semver.js', 'compareSemver'), [
    ['compareSemver', ['1.0.0', '1.0.0'], 0], ['compareSemver', ['1.10.0', '1.9.0'], 1], ['compareSemver', ['2.0.0', '10.0.0'], -1],
    ['compareSemver', ['1.0.0-alpha', '1.0.0'], -1], ['compareSemver', ['1.0.0', '1.0.0-0'], 1], ['compareSemver', ['1.0.0-alpha', '1.0.0-alpha.1'], -1],
    ['compareSemver', ['1.0.0-alpha.1', '1.0.0-alpha.beta'], -1], ['compareSemver', ['1.0.0-alpha.beta', '1.0.0-beta'], -1],
    ['compareSemver', ['1.0.0-beta.2', '1.0.0-beta.11'], -1], ['compareSemver', ['1.0.0-beta.11', '1.0.0-rc.1'], -1],
    ['compareSemver', ['1.0.0+build.5', '1.0.0'], 0], ['compareSemver', ['1.0.0-rc.1+x', '1.0.0-rc.1'], 0], ['compareSemver', ['1.2.3-rc.1', '1.2.3-rc.1.0'], -1],
  ]),
  codeTask('hard-csv-line', 'test', 'csv.js', CSV_STUB, CSV_REF, implement('csv.js', 'parseCsvLine'), [
    ['parseCsvLine', ['a,b,c'], ['a', 'b', 'c']], ['parseCsvLine', ['a,,c'], ['a', '', 'c']], ['parseCsvLine', ['"a,b",c'], ['a,b', 'c']],
    ['parseCsvLine', ['"say ""hi""",x'], ['say "hi"', 'x']], ['parseCsvLine', ['a,'], ['a', '']], ['parseCsvLine', [''], ['']],
    ['parseCsvLine', [' a , b'], [' a ', ' b']], ['parseCsvLine', ['"",""'], ['', '']], ['parseCsvLine', ['x,"1,2,3",y'], ['x', '1,2,3', 'y']],
  ]),
  codeTask('hard-merge-intervals', 'train', 'intervals.js', INTERVALS_STUB, INTERVALS_REF, implement('intervals.js', 'merge'), [
    ['merge', [[[1, 3], [2, 6], [8, 10], [15, 18]]], [[1, 6], [8, 10], [15, 18]]], ['merge', [[[5, 7], [1, 2], [2, 4]]], [[1, 4], [5, 7]]],
    ['merge', [[[1, 10], [2, 3]]], [[1, 10]]], ['merge', [[]], []], ['merge', [[[3, 3]]], [[3, 3]]],
    { expr: '(() => { const x = [[5, 7], [1, 2]]; merge(x); return x; })()', label: 'merge leaves its input unchanged', want: [[5, 7], [1, 2]] },
  ]),
  codeTask('hard-roman', 'dev', 'roman.js', ROMAN_STUB, ROMAN_REF, implement('roman.js', 'toRoman and fromRoman'), [
    ['toRoman', [1994], 'MCMXCIV'], ['toRoman', [4], 'IV'], ['toRoman', [3999], 'MMMCMXCIX'], ['toRoman', [0], null], ['toRoman', [4000], null], ['toRoman', [2.5], null],
    ['fromRoman', ['MCMXCIV'], 1994], ['fromRoman', ['XLII'], 42], ['fromRoman', ['IIII'], null], ['fromRoman', ['VX'], null],
    ['fromRoman', ['IC'], null], ['fromRoman', ['iv'], null], ['fromRoman', [''], null], ['fromRoman', ['MMMM'], null],
  ]),
  codeTask('hard-wrap', 'train', 'wrap.js', WRAP_STUB, WRAP_REF, implement('wrap.js', 'wrap'), [
    ['wrap', ['the quick brown fox', 10], 'the quick\nbrown fox'], ['wrap', ['a b c', 1], 'a\nb\nc'],
    ['wrap', ['abcdefghij xy', 4], 'abcd\nefgh\nij\nxy'], ['wrap', ['hi abcdefgh', 4], 'hi\nabcd\nefgh'],
    ['wrap', ['abcdefg hi', 5], 'abcde\nfg hi'], ['wrap', ['  ', 5], ''], ['wrap', ['one  two\nthree', 20], 'one two three'],
  ]),
  codeTask('hard-duration', 'dev', 'duration.js', DURATION_STUB, DURATION_REF, implement('duration.js', 'parseDuration'), [
    ['parseDuration', ['1h30m'], 5400], ['parseDuration', ['90m'], 5400], ['parseDuration', ['1d2s'], 86402], ['parseDuration', ['45s'], 45],
    ['parseDuration', ['0s'], 0], ['parseDuration', [''], null], ['parseDuration', ['1h1h'], null], ['parseDuration', ['30m1h'], null],
    ['parseDuration', ['1.5h'], null], ['parseDuration', ['1h 30m'], null], ['parseDuration', ['2D'], null], ['parseDuration', ['10'], null],
  ]),
  codeTask('hard-deep-merge', 'train', 'merge.js', MERGE_STUB, MERGE_REF, implement('merge.js', 'deepMerge'), [
    ['deepMerge', [{ x: 1, n: { a: 1, b: 2 } }, { n: { b: 3, c: 4 }, y: 2 }], { x: 1, n: { a: 1, b: 3, c: 4 }, y: 2 }],
    ['deepMerge', [{ l: [1, 2] }, { l: [3] }], { l: [3] }], ['deepMerge', [{ a: { b: 1 } }, { a: null }], { a: null }],
    ['deepMerge', [{ a: 1 }, { a: undefined }], { a: 1 }], ['deepMerge', [{ a: { b: { c: 1 } } }, { a: { b: { d: 2 } } }], { a: { b: { c: 1, d: 2 } } }],
    ['deepMerge', [{ a: 1 }, { a: { b: 2 } }], { a: { b: 2 } }],
    { expr: '(() => { const a = { n: { x: 1 } }, b = { n: { y: 2 }, m: { z: 1 } }; const r = deepMerge(a, b); r.n.w = 3; r.m.w = 3; return [a, b]; })()', label: 'deepMerge modifies or shares an input', want: [{ n: { x: 1 } }, { n: { y: 2 }, m: { z: 1 } }] },
  ]),
  codeTask('hard-topo', 'dev', 'topo.js', TOPO_STUB, TOPO_REF, implement('topo.js', 'order'), [
    ['order', [{ a: ['b', 'c'], b: ['c'], c: [] }], ['c', 'b', 'a']], ['order', [{ b: [], a: [] }], ['a', 'b']],
    ['order', [{ x: ['y'], z: [] }], ['y', 'x', 'z']], ['order', [{ d: ['a'], c: ['a'], b: ['a'], a: [] }], ['a', 'b', 'c', 'd']],
    ['order', [{ a: ['b'], b: ['a'] }], { throws: /^cycle$/ }], ['order', [{ m: ['k'], k: ['j'], j: ['m'], q: [] }], { throws: /^cycle$/ }],
  ]),
  codeTask('hard-lru', 'test', 'lru.js', LRU_STUB, LRU_REF, implement('lru.js', 'the LRU class'), [
    { expr: '(() => { const c = new LRU(2); const o = []; c.put(1, 1); c.put(2, 2); o.push(c.get(1)); c.put(3, 3); o.push(c.get(2)); c.put(4, 4); o.push(c.get(1), c.get(3), c.get(4)); return o; })()', label: 'LRU(2): put 1, put 2, get 1, put 3, get 2, put 4, get 1/3/4', want: [1, -1, -1, 3, 4] },
    { expr: "(() => { const c = new LRU(2); c.put('a', 1); c.put('b', 2); c.put('a', 10); c.put('c', 3); return [c.get('b'), c.get('a'), c.get('c')]; })()", label: 'LRU(2): an update makes the key recent', want: [-1, 10, 3] },
    { expr: '(() => { const c = new LRU(1); c.put(1, 1); c.put(2, 2); return [c.get(1), c.get(2)]; })()', label: 'LRU(1)', want: [-1, 2] },
  ]),
  codeTask('hard-brackets', 'train', 'brackets.js', BRACKETS_STUB, BRACKETS_REF, implement('brackets.js', 'balanced'), [
    ['balanced', ['([]{})'], true], ['balanced', ['([)]'], false], ['balanced', ['f("(")'], true], ['balanced', ["'['"], true],
    ['balanced', [String.raw`f("\")")`], true], ['balanced', ['('], false], ['balanced', ['"unterminated ('], false],
    ['balanced', [''], true], ['balanced', [')('], false], ['balanced', [`{'a': [1, "]"]}`], true],
  ]),
  { ...codeTask('hard-cart-bugs', 'dev', 'cart.js', CART_SEED, CART_REF, 'total() in cart.js does not follow the rules in its header comment. Fix it.', [
    cartCase([{ price: 10, qty: 2 }, { price: 5, qty: 0 }, { price: 3, qty: -1 }], {}), cartCase([{ price: 100, qty: 1 }], { discount: 10, taxPct: 10 }),
    cartCase([{ price: 19.99, qty: 3 }], { taxPct: 8.25 }), cartCase([{ price: 5, qty: 1 }], { discount: 10, taxPct: 20 }), cartCase([], undefined),
  ]) },
  { ...codeTask('hard-paginate', 'test', 'paginate.js', PAGE_SEED, PAGE_REF, 'paginate() in paginate.js does not do what its comment says. Fix it.', [
    ['paginate', [seq(7), 1, 3], { items: [1, 2, 3], page: 1, totalPages: 3, hasNext: true }], ['paginate', [seq(7), 3, 3], { items: [7], page: 3, totalPages: 3, hasNext: false }],
    ['paginate', [seq(7), 4, 3], { items: [], page: 4, totalPages: 3, hasNext: false }], ['paginate', [seq(7), 0, 3], { items: [], page: 0, totalPages: 3, hasNext: false }],
    ['paginate', [[], 1, 5], { items: [], page: 1, totalPages: 0, hasNext: false }], ['paginate', [seq(6), 2, 3], { items: [4, 5, 6], page: 2, totalPages: 2, hasNext: false }],
  ]) },
  { ...codeTask('hard-days-between', 'dev', 'dates.js', DAYS_SEED, DAYS_REF, 'daysBetween() in dates.js gives wrong answers. Fix it so it matches its comment.', [
    ['daysBetween', ['2024-02-28', '2024-03-01'], 2], ['daysBetween', ['2023-02-28', '2023-03-01'], 1], ['daysBetween', ['2024-01-31', '2024-01-01'], -30],
    ['daysBetween', ['2020-01-01', '2021-01-01'], 366], ['daysBetween', ['2024-03-31', '2024-04-01'], 1], ['daysBetween', ['2024-10-27', '2024-10-28'], 1],
  ]) },
];

// ── hard-data ──────────────────────────────────────────────────────────────────────────────────
const r1 = rng(7);
const REGIONS = ['north', 'south', 'east', 'west', 'central'];
const REPS = ['ana', 'raj', 'li', 'tom'];
const SALES_ROWS = Array.from({ length: 18 }, (_, i) => [REGIONS[i % 5 === 4 ? 4 : Math.floor(r1() * 4)], REPS[i % 4], (Math.floor(r1() * 40000) + 500) / 100]);
const SALES_CSV = 'region,rep,amount\n' + SALES_ROWS.map((r) => `${r[0]},${r[1]},${r[2].toFixed(2)}`).join('\n') + '\n';
const regionTotals = (() => { const m = new Map(); for (const [g, , a] of SALES_ROWS) m.set(g, (m.get(g) || 0) + a); return [...m].sort((x, y) => y[1] - x[1]); })();
const TOTALS_CSV = 'region,total\n' + regionTotals.map(([g, t]) => `${g},${t.toFixed(2)}`).join('\n') + '\n';

const CUSTOMERS_CSV = [
  'name,city,spend',
  '"Doe, Jane","New York, NY",120',
  'Sam Lee,Austin,80',
  '"Roe, Max","Portland, OR",45',
  'Ana Ruiz,"New York, NY",300',
  '"Kim, Jo","Portland, ME",60',
  'Lu Wei,"New York, NY",15',
  '"Smith, ""Ace""","New York",90',
  'Ivy Chen,"York, PA",30',
  '"Park, Min","New York, NY",210',
].join('\n') + '\n';
const NY_COUNT = CUSTOMERS_CSV.trim().split('\n').slice(1).map(parseCsvLine).filter((f) => f[1] === 'New York, NY').length;

const r2 = rng(11);
const IP_COUNTS = [['10.0.0.5', 9], ['10.0.0.12', 7], ['10.0.0.3', 7], ['10.0.0.40', 7], ['192.168.1.9', 6], ['10.0.0.7', 4], ['172.16.0.2', 3]];
const ACCESS_LOG = (() => {
  const lines = IP_COUNTS.flatMap(([ip, n]) => Array.from({ length: n }, () => ip));
  for (let i = lines.length - 1; i > 0; i--) { const j = Math.floor(r2() * (i + 1)); [lines[i], lines[j]] = [lines[j], lines[i]]; }
  const paths = ['/', '/login', '/api/items', '/static/app.js'];
  return lines.map((ip, i) => `${ip} - - [01/Oct/2026:10:${String(i % 60).padStart(2, '0')}:00 +0530] "GET ${paths[i % 4]} HTTP/1.1" ${i % 9 === 0 ? 404 : 200} ${100 + i * 7}`).join('\n') + '\n';
})();
const TOP3 = [...IP_COUNTS].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([ip, n]) => `${n} ${ip}`).join('\n');

const ORDERS = [
  { customer: 'zoe', items: [{ sku: 'a1', qty: 2, price: 3.5 }, { sku: 'b2', qty: 1, price: 10.25 }] },
  { customer: 'amir', items: [{ sku: 'c3', qty: 3, price: 1.2 }] },
  { customer: 'zoe', items: [{ sku: 'a1', qty: 1, price: 3.5 }] },
  { customer: 'mei', items: [{ sku: 'd4', qty: 4, price: 0.99 }, { sku: 'e5', qty: 1, price: 5 }] },
  { customer: 'amir', items: [{ sku: 'b2', qty: 2, price: 10.25 }] },
];
const ORDER_TOTALS = (() => { const m = {}; for (const o of ORDERS) for (const it of o.items) m[o.customer] = (m[o.customer] || 0) + it.qty * it.price; return Object.fromEntries(Object.keys(m).sort().map((k) => [k, Math.round(m[k] * 100) / 100])); })();

const A_LINES = ['pear', 'apple', 'fig', 'kiwi', 'apple', 'lime', 'date', 'plum', 'fig', 'grape', 'kiwi', 'mango', 'apple', 'cherry', 'lemon'];
const B_LINES = ['kiwi', 'plum', 'banana', 'fig', 'melon', 'date', 'peach', 'lime'];
const ONLY_A = A_LINES.filter((l) => !B_LINES.includes(l)).join('\n');

const BASE_ENV = '# base settings\nAPP_NAME=shop\n\nDATABASE_URL=postgres://u:p@db/shop?sslmode=require&pool=5\nPORT=3000\n# logging\nLOG_LEVEL=info\nCACHE_TTL=60\n';
const OVERRIDE_ENV = 'PORT=8080\n# staging only\nFEATURE_X=on\nLOG_LEVEL=debug\nSENTRY_DSN=https://k@sentry.example/1\n';
const MERGED_ENV = (() => {
  const parse = (t) => t.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]);
  const m = new Map(parse(BASE_ENV));
  for (const [k, v] of parse(OVERRIDE_ENV)) m.set(k, v);
  return [...m].map(([k, v]) => `${k}=${v}`).join('\n');
})();

const USERS_CSV = 'id,name\n3,carol\n1,alice\n7,gus\n2,bob\n5,erin\n4,dave\n8,hana\n6,frank\n';
const ORDERS_CSV = 'id,user_id,amount\n101,1,20.00\n102,3,15.50\n103,1,4.25\n104,2,100.00\n105,5,7.10\n106,3,2.40\n107,7,60.00\n108,1,0.75\n109,5,12.90\n110,8,33.33\n111,3,1.10\n112,2,0.01\n';
const REPORT_CSV = (() => {
  const users = USERS_CSV.trim().split('\n').slice(1).map((l) => l.split(','));
  const orders = ORDERS_CSV.trim().split('\n').slice(1).map((l) => l.split(','));
  const rows = users.map(([id, name]) => { const os = orders.filter((o) => o[1] === id); return [name, os.length, os.reduce((s, o) => s + Number(o[2]), 0)]; });
  rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return 'name,orders,total\n' + rows.map(([n, c, t]) => `${n},${c},${t.toFixed(2)}`).join('\n');
})();

const r3 = rng(23);
const RECORDS = Array.from({ length: 30 }, (_, i) => [1 + Math.floor(r3() * 12), `2026-09-${String(1 + Math.floor(r3() * 28)).padStart(2, '0')}T${String(Math.floor(r3() * 24)).padStart(2, '0')}:00:00Z`, `v${i}`])
  .filter((r, i, arr) => arr.findIndex((x) => x[0] === r[0] && x[1] === r[1]) === i);
const RECORDS_CSV = 'id,updated_at,value\n' + RECORDS.map((r) => r.join(',')).join('\n') + '\n';
const LATEST_CSV = (() => {
  const m = new Map();
  for (const r of RECORDS) if (!m.has(r[0]) || m.get(r[0])[1] < r[1]) m.set(r[0], r);
  return 'id,updated_at,value\n' + [...m.values()].sort((a, b) => a[0] - b[0]).map((r) => r.join(',')).join('\n');
})();

const BROKEN_JSON = `{
  // service config
  'name': 'gateway',
  "ports": [80, 443,],
  "limits": { "rps": 100, "burst": 20, },
  "tags": ['edge', "prod"],
}
`;
const MATRIX = [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12], [13, 14, 15, 16, 17, 18], [19, 20, 21, 22, 23, 24]];
const TEXT = "The cat sat. The dog sat too! A cat and a dog met; the cat ran, the dog didn't. Cats and dogs: a tale of a cat.\nThe end, said the cat.\n";
const TOP5 = (() => {
  const m = new Map();
  for (const w of TEXT.toLowerCase().match(/[a-z]+/g)) m.set(w, (m.get(w) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map(([w, n]) => `${w} ${n}`).join('\n');
})();

const dataTask = (id, split, seed, prompt, out, expected, extra = {}) => ({
  id, split, family: 'hard-data', seed, prompt,
  gate: all(extra.gate || fileEq(out, expected), onlyChanged([out])),
  solve: [write(out, (extra.solution ?? expected) + (extra.solution !== undefined ? '' : '\n')), say('Done.')],
});
const hardData = [
  dataTask('hard-group-sum', 'test', { 'sales.csv': SALES_CSV },
    'From sales.csv, write totals.csv: a header line "region,total", then one line per region with the sum of its amounts formatted with exactly 2 decimals, ordered by total from highest to lowest.',
    'totals.csv', TOTALS_CSV.trim()),
  dataTask('hard-csv-quoted', 'dev', { 'customers.csv': CUSTOMERS_CSV },
    'How many customers in customers.csv have the city exactly "New York, NY"? Write just the number into answer.txt.',
    'answer.txt', String(NY_COUNT), { gate: answerFile('answer.txt', String(NY_COUNT), 'the count') }),
  dataTask('hard-top-ips', 'dev', { 'access.log': ACCESS_LOG },
    'Write top3.txt: the 3 client IPs with the most requests in access.log, one per line as "<count> <ip>" (one space), most requests first; break ties by the IP in plain string order.',
    'top3.txt', TOP3),
  dataTask('hard-json-totals', 'train', { 'orders.json': JSON.stringify(ORDERS, null, 2) + '\n' },
    'From orders.json, write totals.json: one JSON object mapping each customer to the sum of qty * price over all their orders, rounded to 2 decimals, with the keys in alphabetical order.',
    'totals.json', JSON.stringify(ORDER_TOTALS, null, 2), { gate: jsonEq('totals.json', ORDER_TOTALS, { ordered: true }) }),
  dataTask('hard-only-in-a', 'train', { 'a.txt': A_LINES.join('\n') + '\n', 'b.txt': B_LINES.join('\n') + '\n' },
    'Write only-a.txt: every line of a.txt that does not appear anywhere in b.txt, in the order it appears in a.txt, keeping repeated lines.',
    'only-a.txt', ONLY_A),
  dataTask('hard-env-merge', 'test', { 'base.env': BASE_ENV, 'override.env': OVERRIDE_ENV },
    'Write merged.env from base.env and override.env: a variable set in override.env replaces the base value. Keep the base variables in their order, then add the variables only in override.env in their order. Drop comments and blank lines. Values may contain "=".',
    'merged.env', MERGED_ENV),
  dataTask('hard-join-report', 'test', { 'users.csv': USERS_CSV, 'orders.csv': ORDERS_CSV },
    'Write report.csv with the header "name,orders,total": one line per user in users.csv (including users with no orders), giving their number of orders in orders.csv and the sum of those amounts with exactly 2 decimals, sorted by name.',
    'report.csv', REPORT_CSV),
  dataTask('hard-latest-per-id', 'train', { 'records.csv': RECORDS_CSV },
    'Write latest.csv: the same header as records.csv, then for each id only its row with the latest updated_at, ordered by id as a number (1, 2, … 10, 11).',
    'latest.csv', LATEST_CSV),
  dataTask('hard-fix-json', 'dev', { 'broken.json': BROKEN_JSON },
    'broken.json is not valid JSON (comments, single quotes, trailing commas). Write fixed.json: valid JSON holding the same data. Leave broken.json alone.',
    'fixed.json', '', { gate: jsonEq('fixed.json', { name: 'gateway', ports: [80, 443], limits: { rps: 100, burst: 20 }, tags: ['edge', 'prod'] }), solution: JSON.stringify({ name: 'gateway', ports: [80, 443], limits: { rps: 100, burst: 20 }, tags: ['edge', 'prod'] }, null, 2) + '\n' }),
  dataTask('hard-transpose', 'test', { 'matrix.txt': MATRIX.map((r) => r.join(' ')).join('\n') + '\n' },
    'matrix.txt holds a grid of numbers separated by single spaces. Write transposed.txt: its transpose (row i of the output is column i of the input), in the same format.',
    'transposed.txt', MATRIX[0].map((_, j) => MATRIX.map((r) => r[j]).join(' ')).join('\n')),
  dataTask('hard-word-freq', 'train', { 'text.txt': TEXT },
    'Write top5.txt: the 5 most frequent words in text.txt as "<word> <count>" lines, most frequent first, ties in alphabetical order. A word is a run of letters a-z after lowercasing (so "didn\'t" is "didn" and "t").',
    'top5.txt', TOP5),
];

// ── hard-repo ──────────────────────────────────────────────────────────────────────────────────
const TOC_README = (() => {
  const body = '# Tool\n\nA small tool.\n\n<!-- toc -->\n<!-- /toc -->\n\n## Install & Setup\n\nRun the installer.\n\n### From npm\n\n```sh\nnpm i tool\n## not a heading, this is inside a code block\n```\n\n### From source (beta)\n\nClone it.\n\n## Usage\n\n### CLI flags: --verbose\n\nPrints more.\n\n## FAQ\n\nNone yet.\n';
  return body;
})();
const slug = (h) => h.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
const TOC_EXPECTED = (() => {
  let fence = false; const items = [];
  for (const line of TOC_README.split('\n')) {
    if (line.startsWith('```')) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^(##|###) (.+)$/.exec(line);
    if (m) items.push(`${m[1] === '##' ? '' : '  '}- [${m[2]}](#${slug(m[2])})`);
  }
  return TOC_README.replace('<!-- toc -->\n<!-- /toc -->', `<!-- toc -->\n${items.join('\n')}\n<!-- /toc -->`);
})();
const PHOTOS = Object.fromEntries([...seq(12).map((n) => [`photos/IMG_${String(n).padStart(4, '0')}.JPG`, `jpeg-bytes-${n}\n`]), ['photos/notes.txt', 'shot on the trip\n']]);
const PHOTO_TARGET = (n) => `photos/photo-${String(n).padStart(3, '0')}.jpg`;
const UNUSED_SEED = {
  'src/math.js': 'export function add(a, b) { return a + b; }\nexport function sub(a, b) { return a - b; }\nexport function mul(a, b) { return a * b; }\nexport function div(a, b) { return a / b; }\n',
  'src/str.js': 'export function upper(s) { return s.toUpperCase(); }\nexport function lower(s) { return s.toLowerCase(); }\nexport function title(s) { return s[0].toUpperCase() + s.slice(1); }\n',
  'src/app.js': "import { add, mul } from './math.js';\nimport { title } from './str.js';\nexport function main() { return title('total ' + mul(add(1, 2), 3)); }\n",
  'src/cli.js': "import { main } from './app.js';\nimport { sub } from './math.js';\nconsole.log(main(), sub(5, 3));\n",
  'src/legacy.js': "import { lower } from './str.js';\nexport function oldMain() { return lower('LEGACY'); }\n",
  'test/math.test.js': "import { div } from '../src/math.js';\nconsole.assert(div(6, 3) === 2);\n",
};
const ENV_SEED = {
  'src/a.js': 'const port = process.env.PORT || 3000;\n// process.env.OLD_PORT was removed in v2\nexport default port;\n',
  'src/b.js': "const url = process.env.DATABASE_URL;\nif (process.env.DEBUG) console.log('debug on');\nexport { url };\n",
  'src/lib/c.js': '/* process.env.LEGACY_TOKEN is no longer read\n   neither is process.env.OLD_SECRET */\nexport const key = process.env.API_KEY;\nexport const port2 = process.env.PORT;\n',
  'docs/config.md': 'Set process.env.DOC_ONLY in production.\n',
};
const VERSION_SEED = {
  'package.json': '{\n  "name": "tool",\n  "version": "2.3.1",\n  "dependencies": {\n    "left-pad": "2.3.1"\n  }\n}\n',
  'src/version.js': "export const VERSION = '2.3.1';\n",
  'README.md': '# tool\n\n![version](https://img.shields.io/badge/version-2.3.1-blue)\n\nRequires left-pad 2.3.1.\n',
  'CHANGELOG.md': '# Changelog\n\n## 2.3.1\n\n- Fix crash on empty input\n',
};
const VERSION_EXPECTED = {
  'package.json': VERSION_SEED['package.json'].replace('"version": "2.3.1"', '"version": "2.4.0"'),
  'src/version.js': "export const VERSION = '2.4.0';\n",
  'README.md': VERSION_SEED['README.md'].replace('version-2.3.1-blue', 'version-2.4.0-blue'),
  'CHANGELOG.md': '# Changelog\n\n## 2.4.0\n\n- Add export command\n\n## 2.3.1\n\n- Fix crash on empty input\n',
};
const LIMIT_NAMES = ['Search', 'Login', 'Signup', 'Uploads', 'UploadsLegacy', 'Downloads', 'Exports', 'Imports', 'Webhooks', 'Billing', 'Reports', 'Avatars', 'Comments', 'Likes', 'Follows', 'Messages', 'Invites', 'Teams', 'Projects', 'Tasks', 'Tags', 'Labels', 'Files', 'Folders', 'Shares', 'Links', 'Tokens', 'Sessions', 'Audits', 'Metrics', 'Alerts', 'Notes', 'Drafts', 'Themes', 'Plugins', 'Hooks', 'Feeds', 'Pages', 'Forms', 'Votes'];
const LIMITS_JS = '// Per-endpoint rate limits (requests per minute).\n' + LIMIT_NAMES.map((n, i) => `export function limitFor${n}() {\n  // requests per minute for ${n.toLowerCase()}\n  return ${[100, 60, 30, 100][i % 4]};\n}\n`).join('\n');
const LIMITS_EXPECTED = LIMITS_JS.replace('export function limitForUploads() {\n  // requests per minute for uploads\n  return 100;', 'export function limitForUploads() {\n  // requests per minute for uploads\n  return 250;');
const hardRepo = [
  { id: 'hard-toc', split: 'train', family: 'hard-repo', seed: { 'README.md': TOC_README },
    prompt: 'Fill the table of contents in README.md: between the <!-- toc --> and <!-- /toc --> lines, put one line per "##" and "###" heading, in order: "- [Heading](#slug)" for ##, and the same indented by two spaces for ###. The slug is the heading lowercased, with every character other than a-z, 0-9, space and hyphen deleted, then each space replaced by a hyphen. Ignore the "#" title and anything inside code blocks. Change nothing else.',
    gate: all(fileEq('README.md', TOC_EXPECTED, { trim: false }), onlyChanged(['README.md'])), solve: [write('README.md', TOC_EXPECTED), say('Filled the TOC.')] },
  { id: 'hard-rename-photos', split: 'train', family: 'hard-repo', seed: PHOTOS,
    prompt: 'Rename the photos in photos/ from IMG_0001.JPG … IMG_0012.JPG to photo-001.jpg … photo-012.jpg (three-digit number, lowercase extension). Leave every other file alone.',
    gate: all((c) => {
      for (const n of seq(12)) { if (c.file(`photos/IMG_${String(n).padStart(4, '0')}.JPG`) !== null) return no('an IMG_ file is still there'); if (c.file(PHOTO_TARGET(n)) !== `jpeg-bytes-${n}\n`) return no(`${PHOTO_TARGET(n)} is missing or has the wrong content`); }
      return c.file('photos/notes.txt') === 'shot on the trip\n' ? ok() : no('photos/notes.txt changed');
    }, onlyChanged([...Object.keys(PHOTOS).filter((p) => p !== 'photos/notes.txt'), ...seq(12).map(PHOTO_TARGET)])),
    solve: [sh(seq(12).map((n) => `mv photos/IMG_${String(n).padStart(4, '0')}.JPG ${PHOTO_TARGET(n)}`).join(' && ')), say('Renamed 12 photos.')] },
  { id: 'hard-unused-exports', split: 'dev', family: 'hard-repo', seed: UNUSED_SEED,
    prompt: 'Write unused.txt: the names of the functions exported from files in src/ that no OTHER file in src/ imports, sorted alphabetically, one per line. Imports from outside src/ do not count.',
    gate: all(fileEq('unused.txt', 'div\noldMain\nupper'), onlyChanged(['unused.txt'])), solve: [sh('grep -rn "export function\\|import" src'), write('unused.txt', 'div\noldMain\nupper\n'), say('div, oldMain, upper')] },
  { id: 'hard-env-vars', split: 'test', family: 'hard-repo', seed: ENV_SEED,
    prompt: 'Write env.txt: every environment variable the .js files under src/ read as process.env.NAME, ignoring anything inside // or /* */ comments. Unique names, sorted, one per line.',
    gate: all(fileEq('env.txt', 'API_KEY\nDATABASE_URL\nDEBUG\nPORT'), onlyChanged(['env.txt'])), solve: [sh('grep -rn "process.env" src'), write('env.txt', 'API_KEY\nDATABASE_URL\nDEBUG\nPORT\n'), say('4 variables.')] },
  { id: 'hard-version-bump', split: 'test', family: 'hard-repo', seed: VERSION_SEED,
    prompt: 'Release 2.4.0 of this tool: change its own version to 2.4.0 everywhere it appears (package.json, src/version.js, the README badge), and add a "## 2.4.0" section at the top of CHANGELOG.md with the bullet "- Add export command". Dependency versions must not change.',
    gate: all(...Object.entries(VERSION_EXPECTED).map(([p, t]) => fileEq(p, t)), onlyChanged(Object.keys(VERSION_EXPECTED))),
    solve: [...Object.entries(VERSION_EXPECTED).map(([p, t]) => write(p, t)), say('Released 2.4.0.')] },
  { id: 'hard-big-file-edit', split: 'dev', family: 'hard-repo', seed: { 'limits.js': LIMITS_JS },
    prompt: 'In limits.js, raise the uploads rate limit (limitForUploads) to 250 requests per minute. Nothing else may change.',
    gate: all(fileEq('limits.js', LIMITS_EXPECTED, { trim: false }), onlyChanged(['limits.js'])),
    solve: [sh('grep -n -A3 "limitForUploads()" limits.js'), edit('limits.js', 'export function limitForUploads() {\n  // requests per minute for uploads\n  return 100;', 'export function limitForUploads() {\n  // requests per minute for uploads\n  return 250;'), say('Raised to 250.')] },
];

export const HARD_TASKS = Object.freeze([...hardCode, ...hardData, ...hardRepo].map((t) => ({ tier: 'hard', ...t })));
