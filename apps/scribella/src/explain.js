// A failed build in plain words: TeX's message read against a fixed table of the mistakes papers make most, offline
// and with no model. Messages the table does not know stay TeX's own. Derived from Lattice, see NOTICE.

// Only commands every LaTeX document has. A package's command is a good guess only if this paper already uses it.
const VOCABULARY = ['\\begin', '\\end', '\\section', '\\subsection', '\\subsubsection', '\\paragraph', '\\label', '\\ref', '\\cite', '\\caption', '\\centering', '\\usepackage', '\\documentclass', '\\title', '\\author', '\\date', '\\maketitle', '\\textbf', '\\textit', '\\emph', '\\texttt', '\\footnote', '\\item', '\\input', '\\include', '\\bibliography', '\\bibliographystyle', '\\newcommand', '\\renewcommand', '\\frac', '\\sqrt', '\\sum', '\\int', '\\alpha', '\\beta', '\\gamma', '\\delta', '\\lambda', '\\sigma', '\\mathbf', '\\mathcal', '\\mathrm', '\\left', '\\right', '\\hline', '\\tableofcontents', '\\appendix'];

// Edits between two command names, a swap of neighbours counting as one: \cietp is one edit from \citep.
export function editDistance(left, right) {
  const rows = Array.from({ length:left.length + 1 }, (_, i) => Array.from({ length:right.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) best = Math.min(best, rows[i - 2][j - 2] + 1);
      rows[i][j] = best;
    }
  }
  return rows[left.length][right.length];
}

// The closest command within two edits, one this paper already uses before one only LaTeX knows. None when nothing is
// close, when two candidates tie, or when the token is so short that two edits reach almost anything.
export function closestCommand(token, source) {
  const uses = new Map();
  for (const [name] of source.matchAll(/\\[A-Za-z@]+/g)) uses.set(name, (uses.get(name) ?? 0) + 1);
  uses.delete(token);
  const budget = Math.min(2, token.length - 3);
  if (budget < 1) return null;
  let best = null, tied = false;
  for (const name of new Set([...uses.keys(), ...VOCABULARY])) {
    if (name === token) continue;
    const edits = editDistance(token, name);
    if (edits > budget) continue;
    const rank = edits - Math.min(0.9, 0.5 + (uses.get(name) ?? -10) / 40);
    if (!best || rank < best.rank) { tied = false; best = { name, rank }; }
    else if (rank === best.rank) tied = true;
  }
  return best && !tied ? { name:best.name, uses:uses.get(best.name) ?? 0 } : null;
}

const ENTRIES = [
  [/^Undefined control sequence/, (_, { token, onLine, source }) => {
    if (!token) return null;
    const close = onLine ? closestCommand(token, source) : null;
    if (!close) return { headline:`Unknown command ${token}`, explanation:`LaTeX does not know ${token}. Check its spelling, or load the package that defines it.`, token };
    const times = close.uses > 1 ? `, which this paper uses ${close.uses} times` : '';
    return { headline:`Unknown command ${token}`, explanation:`LaTeX does not know ${token}. It looks like a typo for ${close.name}${times}.`, token, suggestion:close.name };
  }],
  [/Environment (\S+) undefined/, ([, name]) => ({ headline:`Unknown environment ${name}`, explanation:`LaTeX does not know the environment ${name}. Check its spelling in \\begin and \\end, or load the package that defines it.`, token:name })],
  [/\\begin\{([^}]+)\} on input line (\d+) ended by \\end\{([^}]+)\}/, ([, opened, line, closed]) => ({ headline:`\\begin{${opened}} is closed by \\end{${closed}}`, explanation:`Environments close in the reverse order they open. The ${opened} environment from line ${line} needs its \\end{${opened}} before this line.`, token:`\\end{${closed}}` })],
  [/^Missing \$ inserted/, () => ({ headline:'Math outside math mode', explanation:'This line uses a math-only command or character, such as _ or ^, outside $…$. Put the math in $…$, or write \\_ for a literal underscore.' })],
  [/^Extra \}, or forgotten \$/, () => ({ headline:'A } with no { before it', explanation:'This line closes a group that was never opened, or leaves math mode with a } before its $. Remove the extra }, or add the missing {.' })],
  [/^(?:Missing \} inserted|File ended while scanning use of (\\\S+?)\.?$)/, ([, command]) => ({ headline:'A { is never closed', explanation:command ? `The argument of ${command} runs to the end of the file. Add the } it is missing.` : 'A group opened before this point is still open. Add the } it is missing.', ...(command ? { token:command } : {}) })],
  [/^Paragraph ended before (\\\S+?) was complete/, ([, command]) => ({ headline:`${command} runs past a blank line`, explanation:`The argument of ${command} contains a blank line, which usually means a missing }. Close the argument before the blank line.`, token:command })],
  [/^Extra alignment tab has been changed/, () => ({ headline:'Too many & in a table row', explanation:'This row has more cells than the table has columns. Remove an &, or add a column to the column spec.', token:'&' })],
  [/^Misplaced alignment tab character &/, () => ({ headline:'An & outside a table', explanation:'& separates the cells of a table or an aligned equation. To print an ampersand, write \\&.', token:'&' })],
  [/^Double (sub|super)script/, ([, kind]) => ({ headline:kind === 'sub' ? 'Two subscripts in a row' : 'Two superscripts in a row', explanation:`Group a nested script in braces: write ${kind === 'sub' ? 'x_{i_j} rather than x_i_j' : 'x^{a^b} rather than x^a^b'}.` })],
  [/Missing \\begin\{document\}/, () => ({ headline:'Text before \\begin{document}', explanation:'Only definitions and \\usepackage belong in the preamble. Move this text after \\begin{document}, or check for a stray character.' })],
  [/Can be used only in preamble/, (_, { token }) => ({ headline:'A preamble command inside the document', explanation:'Commands such as \\usepackage only work before \\begin{document}. Move this line into the preamble.', ...(token ? { token } : {}) })],
  [/Option clash for package (\S+?)\.?$/, ([, name]) => ({ headline:`${name} is loaded twice with different options`, explanation:`Another package or the template already loads ${name}. Pass your options with \\PassOptionsToPackage before \\documentclass.` })],
  [/^Illegal unit of measure/, () => ({ headline:'A length without a unit', explanation:'Lengths need a unit: write 0.5\\linewidth, 2em or 10pt rather than a bare number.' })],
];

// The control sequence TeX stopped at, from the `l.<n> …` context it printed under this error.
export function stoppedAt(log, line) {
  if (!line) return undefined;
  const context = new RegExp(`^l\\.${line} (.*)$`, 'm').exec(log || '')?.[1] || '';
  return /(\\[A-Za-z@]+)\s*$/.exec(context)?.[1];
}

export function explain(diagnostic, { log = '', source = '' } = {}) {
  if (diagnostic.kind === 'missing-file') {
    return { headline:`Missing file ${diagnostic.name}`, explanation:diagnostic.message, token:diagnostic.name };
  }
  const token = stoppedAt(log, diagnostic.line);
  const failing = source.split('\n')[(diagnostic.line || 0) - 1] ?? '';
  for (const [pattern, describe] of ENTRIES) {
    const match = pattern.exec(diagnostic.message);
    const result = match && describe(match, { token, onLine:!!token && failing.includes(token), source });
    if (result) return result;
  }
  return { headline:diagnostic.message, explanation:'' };
}

const NOISE = /^(==>|Emergency stop\.|Shell escape feature is not enabled)/;

// Repeats, the lines TeX prints while giving up, and notes about the engine's fixed setup add nothing. Errors come first.
export function visibleDiagnostics(diagnostics) {
  const seen = new Set();
  const kept = diagnostics.filter(item => {
    if (NOISE.test(item.message)) return false;
    const key = `${item.severity}|${item.file}|${item.line}|${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...kept.filter(item => item.severity === 'error'), ...kept.filter(item => item.severity !== 'error')];
}
