// trigram — regex → required literal → trigram hashes.
//
// The candidate-generation half of indexed search (plan/anvil-indexed-search.md §2).
// Two functions, both pure, both deliberately conservative:
//
//   requiredLiteral(source)  the longest substring EVERY match must contain, or null
//   trigrams(text)           every overlapping 3-char hash in a string
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
