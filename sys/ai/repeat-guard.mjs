// Repeat guard for streamed generation (2026-11-14).
//
// Small reasoning models often loop: the same sentence or block, again and again, until the
// output-token limit. On 2026-10-31 Anvil's after-run review looped twice on LFM2.5 24B-A2B
// and held the host's single-active AI queue for minutes. This module notices the loop while
// the tokens stream, so the host can stop the generation and say why ('repetition').
//
// The test: the tail of the text is one block of `period` characters repeated back to back,
// covering at least MIN_RUN_CHARS and at least MIN_REPEATS copies, character for character. A
// block shorter than MIN_PERIOD is ignored, because "----" or "    " repeats harmlessly in code
// and tables. Lines that differ only in a number (a data list, generated constants) are real
// output, so the match is exact: an earlier digit-blind version stopped a 60-line code fixture.
//
// Pure: no host, no clock. The host feeds deltas and reads `tripped`; `keepChars` is how much
// of the text to keep (everything up to the end of the first copy of the repeated block).

export const MIN_PERIOD = 12;
export const MAX_PERIOD = 600;
export const MIN_RUN_CHARS = 480;
export const MIN_REPEATS = 4;
const CHECK_EVERY = 48;      // characters of new text between checks
const WINDOW = MAX_PERIOD * MIN_REPEATS + MIN_RUN_CHARS; // never look further back than this

// The repeated tail of `text`, or null. Returns { period, start, keepChars } where `start` is
// where the repetition begins and `keepChars` keeps one copy of the block.
export function findRepeatedTail(text, { minPeriod = MIN_PERIOD, maxPeriod = MAX_PERIOD,
  minRunChars = MIN_RUN_CHARS, minRepeats = MIN_REPEATS } = {}) {
  const s = String(text || '');
  const n = s.length;
  for (let p = minPeriod; p <= maxPeriod && p * minRepeats <= n; p++) {
    // Cheap reject: the last character must match the one a period back.
    if (s[n - 1] !== s[n - 1 - p]) continue;
    let run = 0; // characters (counted from the end) that equal the character p earlier
    while (run < n - p && s[n - 1 - run] === s[n - 1 - run - p]) run++;
    const covered = run + p; // the repeated region, including the first copy
    if (covered >= minRunChars && covered >= p * minRepeats) {
      // A run of one or two characters (a rule line, padding) is periodic for every period; it is
      // not text the model is repeating. A looping sentence has many distinct characters.
      if (new Set(s.slice(n - p).replace(/\s/g, '')).size < 4) return null;
      const start = n - covered;
      return { period: p, start, keepChars: start + p };
    }
  }
  return null;
}

// A streaming guard: push deltas, read `tripped`. One guard per stream (reply or reasoning).
export function createRepeatGuard(opts = {}) {
  let text = '';      // only the last WINDOW characters are kept for the test
  let dropped = 0;    // characters trimmed off the front of `text`
  let sinceCheck = 0;
  let hit = null;
  return {
    push(delta) {
      if (hit) return true;
      const d = String(delta || '');
      if (!d) return false;
      text += d; sinceCheck += d.length;
      if (text.length > WINDOW * 2) { const cut = text.length - WINDOW; text = text.slice(cut); dropped += cut; }
      if (sinceCheck < CHECK_EVERY) return false;
      sinceCheck = 0;
      const found = findRepeatedTail(text, opts);
      if (found) hit = { period: found.period, keepChars: dropped + found.keepChars };
      return !!hit;
    },
    get tripped() { return !!hit; },
    // Where to cut the full text so it keeps one copy of the repeated block (null until tripped).
    get keepChars() { return hit ? hit.keepChars : null; },
    get period() { return hit ? hit.period : null; },
  };
}

// The finish reason a stopped loop carries, end to end (host → SDK → app → run record).
export const REPETITION = 'repetition';
