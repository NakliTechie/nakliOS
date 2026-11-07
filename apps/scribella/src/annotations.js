// Notes and highlights anchored to source text. An anchor keeps offsets and the quoted text with what surrounds it, so
// it survives edits elsewhere. There is no fuzzy match: a note either finds its exact words or says it lost them.
const CONTEXT = 32;
export const NOTES_PATH = '.scribella/annotations.json';
export const HIGHLIGHTS = [['check', 'To check'], ['keep', 'Keep'], ['cite', 'Needs a citation'], ['rewrite', 'Rewrite'], ['question', 'Question'], ['idea', 'Idea']];
export const INTENTS = [['', 'No intent'], ['rewrite', 'Rewrite'], ['shorten', 'Shorten'], ['clarify', 'Clarify'], ['cite', 'Add a citation'], ['fix', 'Fix']];

export function makeAnchor(text, from, to) {
  return { from, to, quote:text.slice(from, to), prefix:text.slice(Math.max(0, from - CONTEXT), from), suffix:text.slice(to, to + CONTEXT) };
}

function occurrences(text, needle) {
  const found = [];
  for (let at = text.indexOf(needle); at >= 0 && needle; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
}

export function locate(text, anchor) {
  const inPlace = text.slice(anchor.from, anchor.to) === anchor.quote
    && text.slice(Math.max(0, anchor.from - anchor.prefix.length), anchor.from) === anchor.prefix
    && text.slice(anchor.to, anchor.to + anchor.suffix.length) === anchor.suffix;
  if (inPlace) return { from:anchor.from, to:anchor.to };
  const full = occurrences(text, anchor.prefix + anchor.quote + anchor.suffix);
  if (full.length === 1) return { from:full[0] + anchor.prefix.length, to:full[0] + anchor.prefix.length + anchor.quote.length };
  const bare = occurrences(text, anchor.quote);
  return bare.length === 1 ? { from:bare[0], to:bare[0] + anchor.quote.length } : null;
}

export function parseNotes(json) {
  try {
    const data = JSON.parse(json);
    return { notes:Array.isArray(data.notes) ? data.notes : [], rounds:Number(data.rounds) || 0 };
  } catch (_) { return { notes:[], rounds:0 }; }
}
