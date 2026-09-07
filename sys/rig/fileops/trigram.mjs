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
function optionalQuantAt(src, i) {
  const c = src[i];
  if (c === '*' || c === '?') return true;
  if (c === '{') {
    const close = src.indexOf('}', i);
    if (close === -1) return false;
    const body = src.slice(i + 1, close);
    if (!/^\d*(,\d*)?$/.test(body)) return false;
    return /^0*(,|$)/.test(body); // {0}, {0,}, {0,3} → optional
  }
  return false;
}

function quantLenAt(src, i) {
  const c = src[i];
  if (c === '*' || c === '?' || c === '+') return 1;
  if (c === '{') {
    const close = src.indexOf('}', i);
    if (close !== -1 && /^\d*(,\d*)?$/.test(src.slice(i + 1, close))) return close - i + 1;
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

  let best = '';
  let run = '';
  // A run ends whenever something uncertain follows it. Bank it before clearing,
  // or a pattern like /alpha.be/ throws away the perfectly good 'alpha'.
  const endRun = () => { if (run.length > best.length) best = run; run = ''; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    let lit = null;

    if (c === '\\') {
      const n = src[i + 1];
      if (n === undefined) return null;
      if (ESCAPED_LITERAL.has(n)) { lit = n; i++; }
      else { i++; endRun(); continue; } // \d \w \s \b \n … → not a literal char
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
    const qLen = quantLenAt(src, i + 1);
    if (qLen > 0) {
      if (optionalQuantAt(src, i + 1)) {
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
