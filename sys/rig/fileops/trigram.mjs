// trigram — regex → a boolean query over trigram sets.
//
// The candidate-generation half of indexed search (plan/anvil-indexed-search.md §2):
//
//   trigrams(text)           every overlapping 3-char hash in a string
//   requiredLiteral(source)  the longest substring EVERY match must contain, or null
//   planQuery(source)        a tree of AND / OR / TRI / ALL over trigram sets
//
// planQuery is what the index actually uses. requiredLiteral is the older,
// single-run form, kept because it is the clearest statement of the guarantee and
// the tests assert it directly.
//
// Why a tree and not one literal: /TODO|FIXME/ has NO substring common to every
// match, so a single-literal extractor must give up and scan everything. A tree
// says OR(TRI{TODO}, TRI{FIXME}) and touches two small candidate sets instead.
// Measured on realistic agent queries, single-literal covered 72%; the misses were
// every alternation, group, class and \w-style escape.
//
// The safety argument, which is the whole design:
//
//   - The index only ever decides which files to OPEN. The caller then runs the
//     real regex on them, unchanged. So the index can never invent a match.
//   - It can only wrongly EXCLUDE one. That is why requiredLiteral returns null
//     for everything it does not fully understand — a null means "fall back to
//     the full scan", which is always correct and never slower than today.
//   - Hash collisions are therefore harmless: a collision adds a candidate file
//     that the real regex then rejects. Collisions cost time, never correctness.
//
// Anything not enumerated below is treated as not-understood.

// FNV-1a over the three code units. 32-bit; collisions are safe (see above).
export function triHash(a, b, c) {
  let h = 0x811c9dc5;
  h = Math.imul(h ^ a, 0x01000193);
  h = Math.imul(h ^ b, 0x01000193);
  h = Math.imul(h ^ c, 0x01000193);
  return h >>> 0;
}

/**
 * Case-fold for indexing. PER CHARACTER, never whole-string: JS applies Unicode's
 * contextual final-sigma rule to a whole string, so 'AB\u03a3'.toLowerCase() ends in
 * \u03c2 while 'AB\u03a3X'.toLowerCase() ends in \u03c3 — a literal that WAS present
 * stopped matching its own file. Mapping each code point independently is a
 * homomorphism, so a substring stays a substring, which is the only property the
 * index needs.
 */
export function foldCase(text) {
  let out = '';
  // Upper THEN lower, per character. Plain toLowerCase is not the equivalence a
  // regex /i uses: /\u03c3/i matches \u03c2 and /s/iu matches \u017f, but neither
  // pair is equal under toLowerCase, so an -i query silently missed them. Going
  // through uppercase collapses both (\u03c2 -> \u03a3 -> \u03c3, \u017f -> S -> s).
  // Verified over 13,174 case-equivalent code-point pairs: no case where the
  // regex matches but the fold disagrees. Where the fold is BROADER than /i
  // (\u00df -> ss), it only over-matches, which the real regex then rejects.
  for (const ch of text) out += ch.toUpperCase().toLowerCase();
  return out;
}

/** Every overlapping trigram hash in `text`, deduplicated. */
export function trigrams(text) {
  const out = new Set();
  for (let i = 0; i + 2 < text.length; i++) {
    out.add(triHash(text.charCodeAt(i), text.charCodeAt(i + 1), text.charCodeAt(i + 2)));
  }
  return out;
}

// Quantifiers that make the atom before them optional, so it cannot be required.
function optionalQuantAt(chars, i) {
  const c = chars[i];
  if (c === '*' || c === '?') return true;
  if (c === '{') {
    const close = chars.indexOf('}', i);
    if (close === -1) return false;
    const body = chars.slice(i + 1, close).join('');
    if (!/^\d*(,\d*)?$/.test(body)) return false;
    return /^0*(,|$)/.test(body); // {0}, {0,}, {0,3} → optional
  }
  return false;
}

function quantLenAt(chars, i) {
  const c = chars[i];
  if (c === '*' || c === '?' || c === '+') return 1;
  if (c === '{') {
    const close = chars.indexOf('}', i);
    if (close !== -1 && /^\d*(,\d*)?$/.test(chars.slice(i + 1, close).join(''))) return close - i + 1;
  }
  return 0;
}

// Escapes that stand for one literal character.
const ESCAPED_LITERAL = new Set(['.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '^', '$', '\\', '/', '-']);

/**
 * The longest substring that every match of `source` must contain, or null when
 * no such run of >= `min` characters can be established.
 *
 * Returns null (→ caller falls back to a full scan) for: any alternation, any
 * group, any character class, any lookaround or backreference, and any pattern
 * whose longest certain run is shorter than `min`. That is a lot of patterns,
 * and that is correct — a wrong candidate set is a wrong search result.
 */
export function requiredLiteral(source, { min = 3 } = {}) {
  const src = String(source);
  // Alternation anywhere means no single literal is required by every branch.
  // Groups and classes could be optional or could hide an alternation; rather
  // than reason about nesting, refuse. Lookaround/backreference likewise.
  if (/[|([]/.test(src.replace(/\\./g, ''))) return null;

  // Iterate by CODE POINT, not code unit. An astral character is two units, and
  // treating them separately let /ab(emoji)?cd/u report 'ab\uD83D' as required — a
  // lone surrogate that "abcd", a real match, does not contain.
  const chars = [...src];
  let best = '';
  let run = '';
  // A run ends whenever something uncertain follows it. Bank it before clearing,
  // or a pattern like /alpha.be/ throws away the perfectly good 'alpha'.
  const endRun = () => { if (run.length > best.length) best = run; run = ''; };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    let lit = null;

    if (c === '\\') {
      const n = chars[i + 1];
      if (n === undefined) return null;
      // ONLY escapes standing for exactly one literal character are usable.
      // Everything else is refused outright rather than skipped: skipping consumed
      // two characters and folded the REST into the next run, so /\123abc/ (octal
      // for 'S') claimed '23abc' was required — and "Sabc" matches without it.
      // Classes, backreferences and \x / \u / \c / octal all land here.
      if (!ESCAPED_LITERAL.has(n)) return null;
      lit = n; i++;
    } else if (c === '.' || c === '^' || c === '$') {
      endRun();
      continue;
    } else if (c === ')' || c === ']' || c === '}') {
      return null; // unbalanced relative to the refusal above; do not guess
    } else if (c === '*' || c === '+' || c === '?' || c === '{') {
      // A quantifier with no atom before it is a malformed pattern to us.
      return null;
    } else {
      lit = c;
    }

    // Look at what follows this literal.
    const qLen = quantLenAt(chars, i + 1);
    if (qLen > 0) {
      if (optionalQuantAt(chars, i + 1)) {
        // This character may not appear. It cannot join the run, and it breaks it.
        endRun();
      } else {
        // '+' or {n,} with n>=1: the character IS required, but it may repeat,
        // so text after it is not contiguous with text before it.
        run += lit;
        endRun();
      }
      i += qLen;
      continue;
    }

    run += lit;
  }
  endRun();
  return best.length >= min ? best : null;
}


// ── query planning ──────────────────────────────────────────────────────────
// A node is one of:
//   { op:'ALL' }                 nothing can be excluded — scan everything
//   { op:'TRI', tris:Set<hash> }  files holding ALL of these trigrams
//   { op:'AND', subs:[...] }      files satisfying every sub
//   { op:'OR',  subs:[...] }      files satisfying any sub
//
// The invariant every branch below must preserve: if a string matches the regex,
// the file holding it satisfies the query. Over-matching is free (the real regex
// rejects it); under-matching is a silent false negative, so anything not fully
// understood becomes ALL rather than a guess.
export const ALL = Object.freeze({ op: 'ALL' });
const isAll = (q) => !q || q.op === 'ALL';

function andOf(subs) {
  const real = subs.filter((s) => !isAll(s));
  if (!real.length) return ALL;
  return real.length === 1 ? real[0] : { op: 'AND', subs: real };
}

// An OR is only as good as its WEAKEST branch: if any branch can match anything,
// the whole alternation can, so the union constrains nothing.
function orOf(subs) {
  if (!subs.length) return ALL;
  if (subs.some(isAll)) return ALL;
  return subs.length === 1 ? subs[0] : { op: 'OR', subs };
}

function triOf(literal) {
  const folded = foldCase(literal);
  if (folded.length < 3) return ALL;
  // Folded, to match the folded index. See foldCase.
  return { op: 'TRI', tris: trigrams(folded) };
}

// Split a pattern body on TOP-LEVEL '|' only — alternation inside a group belongs
// to that group.
function splitAlternatives(chars) {
  const out = []; let cur = []; let depth = 0; let inClass = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '\\') { cur.push(c, chars[i + 1] ?? ''); i++; continue; }
    if (inClass) { cur.push(c); if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; cur.push(c); continue; }
    if (c === '(') { depth++; cur.push(c); continue; }
    if (c === ')') { depth--; cur.push(c); continue; }
    if (c === '|' && depth === 0) { out.push(cur); cur = []; continue; }
    cur.push(c);
  }
  out.push(cur);
  return out;
}

// Consume one escape. ONLY escapes whose length and meaning are unambiguous are
// recognised; everything else refuses the whole pattern.
//
// Guessing a length was worth 20,862 false negatives in review. `\\k<word>`
// consumed two characters and left `<word>` looking like required text, so
// /(?<word>abc)\\k<word>/ excluded "abcabc". `\\x`, `\\u` and `\\c` consumed fixed
// widths without checking their syntax and swallowed the '(' after them. `\\p{L}`
// left `{L}` behind as a literal, so /\\p{Letter}abc/u excluded "Zabc".
//
// Returning REFUSE costs a full scan. Getting the length wrong costs a silent
// wrong answer, so the trade is not close.
const REFUSE = Symbol('refuse');
const CLASS_ESCAPES = new Set(['d', 'D', 'w', 'W', 's', 'S', 'b', 'B']);
const CONTROL_LITERALS = Object.freeze({ n: '\n', r: '\r', t: '\t', f: '\f', v: '\v' });

function readEscape(chars, i) {
  const n = chars[i + 1];
  if (n === undefined) return REFUSE;
  if (ESCAPED_LITERAL.has(n)) return { len: 2, literal: n };
  if (Object.prototype.hasOwnProperty.call(CONTROL_LITERALS, n)) return { len: 2, literal: CONTROL_LITERALS[n] };
  // Zero-width and character-class escapes: exactly two characters, nothing
  // structural after them, and they never contribute required text.
  if (CLASS_ESCAPES.has(n)) return { len: 2, literal: null };
  // \x \u \c \p \P \k, octal and backreferences: variable or context-dependent
  // width. Not worth parsing to be right about; refuse.
  return REFUSE;
}

// Find the ')' matching the '(' at `i`.
function matchParen(chars, i) {
  let depth = 0; let inClass = false;
  for (let j = i; j < chars.length; j++) {
    const c = chars[j];
    if (c === '\\') { j++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (!depth) return j; }
  }
  return -1;
}

function classEnd(chars, i) {
  for (let j = i + 1; j < chars.length; j++) {
    if (chars[j] === '\\') { j++; continue; }
    if (chars[j] === ']' && j > i + 1) return j;
  }
  return -1;
}

// One alternative: a sequence of atoms. Literal runs become TRI nodes; groups
// recurse; everything else contributes nothing but does not poison its siblings —
// which is the difference from the old extractor, where a single \w made the
// whole pattern unusable even though a neighbouring literal was still required.
function planSequence(chars) {
  const parts = [];
  let run = '';
  const flushRun = () => { if (run) { parts.push(triOf(run)); run = ''; } };

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    let atom = null;          // { literal } | { query } | null (opaque)
    let end = i;

    if (c === '\\') {
      const esc = readEscape(chars, i);
      if (esc === REFUSE || !esc) return ALL;
      end = i + esc.len - 1;
      atom = esc.literal !== null ? { literal: esc.literal } : null;
    } else if (c === '(') {
      const close = matchParen(chars, i);
      if (close < 0) return ALL;
      const head = chars.slice(i + 1, i + 4).join('');
      if (head.startsWith('?:')) {
        atom = { query: planAlternation(chars.slice(i + 3, close)) };
      } else if (head.startsWith('?')) {
        atom = null;          // lookaround, named group, flags — treat as opaque
      } else {
        atom = { query: planAlternation(chars.slice(i + 1, close)) };
      }
      end = close;
    } else if (c === '[') {
      const close = classEnd(chars, i);
      if (close < 0) return ALL;
      atom = null;
      end = close;
    } else if (c === '.' || c === '^' || c === '$') {
      atom = null;
    } else if (c === '*' || c === '+' || c === '?') {
      return ALL;             // a quantifier with no atom before it
    } else if (c === '{' && quantLenAt(chars, i) === 0) {
      atom = { literal: '{' }; // '{' that is not a valid quantifier is a literal
                               // brace, as JS reads it — /import {/ is a real query
    } else if (c === '{') {
      return ALL;             // a quantifier with no atom before it
    } else {
      atom = { literal: c };
    }

    // What follows decides whether this atom is required at all.
    const qLen = quantLenAt(chars, end + 1);
    const optional = qLen > 0 && optionalQuantAt(chars, end + 1);
    const repeats = qLen > 0 && !optional;
    if (qLen > 0) end += qLen;

    if (optional) { flushRun(); i = end; continue; }
    if (atom && atom.literal !== undefined && atom.literal !== null) {
      run += atom.literal;
      if (repeats) flushRun();  // it may repeat, so text either side is not contiguous
    } else {
      flushRun();
      if (atom && atom.query) parts.push(atom.query);
    }
    i = end;
  }
  flushRun();
  return andOf(parts);
}

function planAlternation(chars) {
  return orOf(splitAlternatives(chars).map(planSequence));
}

/**
 * A boolean trigram query for `source`, or ALL when nothing can be excluded.
 * Never under-matches: an unrecognised construct contributes ALL, which widens
 * the candidate set rather than narrowing it wrongly.
 */
export function planQuery(source) {
  try { return planAlternation([...String(source)]); }
  catch (_) { return ALL; }   // a malformed pattern is the caller's problem, not ours
}

/**
 * Evaluate a query against a postings map (triHash -> Set<path>).
 * Returns a Set of candidate paths, or null meaning "no constraint — scan all".
 */
export function evaluateQuery(node, postings) {
  if (isAll(node)) return null;
  if (node.op === 'TRI') {
    let acc = null;
    for (const h of node.tris) {
      const s = postings.get(h);
      if (!s) return new Set();                 // a trigram nothing holds ⇒ no file can match
      acc = acc === null ? new Set(s) : new Set([...acc].filter((x) => s.has(x)));
      if (!acc.size) return acc;
    }
    return acc === null ? null : acc;
  }
  if (node.op === 'AND') {
    let acc = null;
    for (const sub of node.subs) {
      const s = evaluateQuery(sub, postings);
      if (s === null) continue;                 // an unconstrained sub adds nothing
      acc = acc === null ? s : new Set([...acc].filter((x) => s.has(x)));
      if (!acc.size) return acc;
    }
    return acc;
  }
  if (node.op === 'OR') {
    const acc = new Set();
    for (const sub of node.subs) {
      const s = evaluateQuery(sub, postings);
      if (s === null) return null;              // one unconstrained branch ⇒ no constraint
      for (const x of s) acc.add(x);
    }
    return acc;
  }
  return null;
}
