// Indents a LaTeX file by its environments. It changes only leading whitespace and trailing spaces, so what TeX reads
// stays the same; verbatim text is left exactly as it is.
const VERBATIM = /\\begin\{(comment|listing|lstlisting|minted|verbatim|Verbatim)(\*?)\}/;
const UNIT = '  ';

export function formatLatex(source) {
  let depth = 0, closing = null;
  const out = [];
  for (const raw of source.split('\n')) {
    if (closing) {
      out.push(raw);
      if (raw.includes(closing)) { closing = null; depth = Math.max(0, depth - 1); }
      continue;
    }
    const line = raw.trim();
    if (!line) { out.push(''); continue; }
    const opened = VERBATIM.exec(line);
    if (opened && !line.includes(`\\end{${opened[1]}${opened[2]}}`)) { out.push(UNIT.repeat(depth) + line); closing = `\\end{${opened[1]}${opened[2]}}`; depth += 1; continue; }
    const code = line.replace(/(?<!\\)%.*$/, '');
    const opens = (code.match(/\\begin\{(?!document\})/g) || []).length, closes = (code.match(/\\end\{(?!document\})/g) || []).length;
    const leading = /^\\end\{(?!document\})/.test(line) ? 1 : 0;
    out.push(UNIT.repeat(Math.max(0, depth - leading)) + line);
    depth = Math.max(0, depth + opens - closes);
  }
  return out.join('\n');
}
