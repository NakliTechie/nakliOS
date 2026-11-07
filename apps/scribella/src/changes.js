// The changes between two versions as LaTeX that TeX can typeset: added words underlined in blue, removed words struck
// through in red. Only plain prose is marked. Paragraphs holding environments, math or comments come through as the new
// text with no marks, because a mark placed inside them could stop the build.
const HARD = /\\begin|\\end|\$|%|\\\[|\\\]|\\section|\\subsection|\\paragraph|\\chapter/;
const PLAIN_WORD = /^[^\\{}$%&#_^~]+$/;
const PREAMBLE = `\\usepackage[normalem]{ulem}
\\usepackage{xcolor}
\\providecommand{\\DIFadd}[1]{{\\color{blue}\\uline{#1}}}
\\providecommand{\\DIFdel}[1]{{\\color{red}\\sout{#1}}}
`;

// Longest common subsequence as a list of edits: ['=', a, b] · ['-', a] · ['+', b].
export function diffLists(left, right) {
  const rows = left.length, columns = right.length;
  const table = Array.from({ length:rows + 1 }, () => new Uint32Array(columns + 1));
  for (let i = rows - 1; i >= 0; i -= 1) for (let j = columns - 1; j >= 0; j -= 1) {
    table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const edits = [];
  let i = 0, j = 0;
  while (i < rows && j < columns) {
    if (left[i] === right[j]) { edits.push(['=', left[i], right[j]]); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) edits.push(['-', left[i++]]);
    else edits.push(['+', right[j++]]);
  }
  while (i < rows) edits.push(['-', left[i++]]);
  while (j < columns) edits.push(['+', right[j++]]);
  return edits;
}

function markWords(before, after) {
  const out = [];
  let added = [], removed = [];
  const flush = () => {
    if (removed.length) out.push(`\\DIFdel{${removed.join(' ')}}`);
    if (added.length) out.push(`\\DIFadd{${added.join(' ')}}`);
    added = []; removed = [];
  };
  for (const [kind, word] of diffLists(before.split(/\s+/).filter(Boolean), after.split(/\s+/).filter(Boolean))) {
    if (kind === '=') { flush(); out.push(word); }
    else if (kind === '-') { if (PLAIN_WORD.test(word)) removed.push(word); }
    else if (PLAIN_WORD.test(word)) added.push(word);
    else { flush(); out.push(word); }
  }
  flush();
  return out.join(' ');
}

const paragraphs = text => text.split(/\n\s*\n/);

function similar(left, right) {
  const words = new Set(left.split(/\s+/)), others = right.split(/\s+/);
  return others.filter(word => words.has(word)).length / Math.max(others.length, words.size) >= 0.3;
}

export function markChanges(oldText, newText) {
  const split = text => {
    const at = text.indexOf('\\begin{document}');
    return at < 0 ? ['', text] : [text.slice(0, at), text.slice(at)];
  };
  const [head, body] = split(newText), [, oldBody] = split(oldText);
  const edits = diffLists(paragraphs(oldBody), paragraphs(body));
  const out = [];
  const removed = paragraph => { if (!HARD.test(paragraph)) out.push(markWords(paragraph, '')); };
  const added = paragraph => out.push(HARD.test(paragraph) ? paragraph : markWords('', paragraph));
  const paired = (before, after) => out.push(HARD.test(before) || HARD.test(after) ? after : markWords(before, after));
  for (let index = 0; index < edits.length;) {
    if (edits[index][0] === '=') { out.push(edits[index][1]); index += 1; continue; }
    const gone = [], come = [];
    for (; index < edits.length && edits[index][0] !== '='; index += 1) (edits[index][0] === '-' ? gone : come).push(edits[index][1]);
    // Within a changed run, a new paragraph pairs with the next old one that shares enough words.
    let next = 0;
    for (const paragraph of come) {
      const match = gone.findIndex((old, at) => at >= next && similar(old, paragraph));
      if (match < 0) { added(paragraph); continue; }
      gone.slice(next, match).forEach(removed);
      paired(gone[match], paragraph);
      next = match + 1;
    }
    gone.slice(next).forEach(removed);
  }
  return (head ? `${head}${PREAMBLE}` : '') + out.join('\n\n');
}
