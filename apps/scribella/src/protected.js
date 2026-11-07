// The parts of LaTeX source a language edit must leave byte for byte: math, references, comments, command names,
// environment boundaries, verbatim code and paragraph breaks. Rules from Lattice, see NOTICE.
const MATH_ENV = 'align|alignat|displaymath|eqnarray|equation|flalign|gather|math|multline';
const VERBATIM_ENV = 'comment|listing|lstlisting|minted|verbatim|Verbatim';
const REFERENCE = 'autocite|autoref|bibliography|bibliographystyle|cite|citealp|citealt|citeauthor|citep|citet|citeyear|cref|Cref|eqref|footcite|fullcite|href|hyperref|include|includegraphics|input|label|nameref|nocite|pageref|parencite|ref|subref|textcite|url|vref';
const PATTERNS = [
  new RegExp(`\\\\begin\\{(${VERBATIM_ENV})\\*?\\}[\\s\\S]*?\\\\end\\{\\1\\*?\\}`, 'g'),
  new RegExp(`\\\\begin\\{(${MATH_ENV})\\*?\\}[\\s\\S]*?\\\\end\\{\\1\\*?\\}`, 'g'),
  /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<![\\$])\$(?:[^$\\]|\\.)+\$/g,
  /(?<!\\)%.*$/gm,
  new RegExp(`\\\\(?:${REFERENCE})\\*?(?:\\[[^\\]]*\\])*(?:\\{[^{}]*\\})+`, 'g'),
  /\\(?:begin|end)\{[^}]*\}(?:\[[^\]]*\])?/g,
  /\\[A-Za-z@]+\*?(?:\[[^\]]*\])?\{?|\\./g,
  /[{}]/g,
  /\n[ \t]*\n/g,
];

export function protectedSpans(text) {
  const spans = [];
  for (const pattern of PATTERNS) for (const match of text.matchAll(pattern)) spans.push({ from:match.index, to:match.index + match[0].length });
  spans.sort((a, b) => a.from - b.from || b.to - a.to);
  const merged = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.from < last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }
  return merged;
}

export const touchesProtected = (spans, from, to) => spans.some(span => from < span.to && to > span.from || (from === to && from > span.from && from < span.to));

const pieces = text => protectedSpans(text).map(span => text.slice(span.from, span.to));

// True when both texts hold the same protected pieces in the same order.
export const keepsProtected = (before, after) => JSON.stringify(pieces(before)) === JSON.stringify(pieces(after));
