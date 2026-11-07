// A paper's source as arXiv wants it: only the files the paper uses, comments gone, and the .bbl alongside because arXiv
// does not run BibTeX. A comment is a note to co-authors, and arXiv publishes the source it receives.
const VERBATIM = /\\begin\{(verbatim|lstlisting|minted)\*?\}/;
const VERBATIM_END = /\\end\{(verbatim|lstlisting|minted)\*?\}/;
const GRAPHICS = ['', '.pdf', '.png', '.jpg', '.jpeg', '.eps'];

// A comment swallows its line end, so a trailing comment keeps its % and a whole-line comment goes.
export function stripComments(source) {
  const out = [];
  let inside = false, hidden = false, removed = 0;
  for (const line of source.split('\n')) {
    // A comment environment is a note too, so it goes with its markers.
    if (hidden) { if (/\\end\{comment\}/.test(line)) hidden = false; continue; }
    if (inside) { out.push(line); if (VERBATIM_END.test(line)) inside = false; continue; }
    if (/^\s*\\begin\{comment\}/.test(line)) { removed += 1; hidden = !/\\end\{comment\}/.test(line); continue; }
    if (VERBATIM.test(line) && !VERBATIM_END.test(line)) { inside = true; out.push(line); continue; }
    // A % inside a URL or \\verb is text; those are masked so only a real comment on the line is found.
    const masked = line.replace(/\\(?:url|href)\{[^}]*\}|\\verb\*?(.).*?\1/g, match => ' '.repeat(match.length));
    const at = masked.search(/(?<!\\)(?:\\\\)*%/);
    if (at < 0) { out.push(line); continue; }
    const percent = masked.indexOf('%', at);
    if (percent + 1 === line.length && line.trim() !== '%') { out.push(line); continue; }
    removed += 1;
    if (line.slice(0, percent).trim()) out.push(line.slice(0, percent + 1));
  }
  return { text:out.join('\n'), removed };
}

// `files` lists every project file, `texts` holds the text ones. Answers the paths the paper needs and what is missing.
export function usedFiles({ files, texts, main }) {
  const have = new Set(files), used = new Set(), missing = new Set(), pending = [main];
  const resolve = (name, tries, from) => {
    const folder = from.includes('/') ? from.replace(/[^/]*$/, '') : '';
    for (const base of [name, folder + name]) for (const extension of tries) if (have.has(base + extension)) return base + extension;
    return null;
  };
  while (pending.length) {
    const file = pending.pop();
    if (used.has(file)) continue;
    used.add(file);
    if (!/\.(tex|ltx|sty|cls)$/i.test(file)) continue;
    const source = texts[file] || '';
    for (const [, name] of source.matchAll(/\\(?:input|include|subfile)\{([^}]+)\}/g)) {
      const found = resolve(name, ['', '.tex'], file);
      if (found) pending.push(found); else missing.add(name);
    }
    for (const [, name] of source.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
      const found = resolve(name, GRAPHICS, file);
      if (found) used.add(found); else missing.add(name);
    }
    for (const [, list] of source.matchAll(/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
      for (const name of list.split(',')) { const found = resolve(name.trim(), ['.sty'], file); if (found) pending.push(found); }
    }
    for (const [, name] of source.matchAll(/\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/g)) { const found = resolve(name, ['.cls'], file); if (found) pending.push(found); }
    for (const [, name] of source.matchAll(/\\bibliographystyle\{([^}]+)\}/g)) { const found = resolve(name, ['.bst'], file); if (found) used.add(found); }
  }
  return { used:[...used].sort(), missing:[...missing].sort() };
}
