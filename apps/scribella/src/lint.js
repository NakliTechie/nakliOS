// Checks a source file as you type, before TeX runs: unclosed environments and math, duplicate labels, undefined
// references, missing citations and missing input files. Rules from Lattice, see NOTICE. Lines between `%novalidate`
// and `%validate` are skipped.

const VERBATIM = /^(verbatim|lstlisting|minted|comment)\*?$/;

// Comments become spaces so offsets stay true.
export function blankComments(source) {
  return source.replace(/(^|[^\\])(\\\\)*%.*$/gm, match => {
    const at = match.indexOf('%', match.search(/[^\\]?%/));
    return match.slice(0, at) + ' '.repeat(match.length - at);
  });
}

function skippedRanges(source) {
  const ranges = [];
  let from = null;
  for (const match of source.matchAll(/^\s*%\s*(no)?validate\b.*$/gm)) {
    if (match[1] && from === null) from = match.index;
    else if (!match[1] && from !== null) { ranges.push([from, match.index]); from = null; }
  }
  if (from !== null) ranges.push([from, source.length]);
  return ranges;
}

export function collectKeys(source) {
  const text = blankComments(source);
  const labels = [...text.matchAll(/\\label\{([^}]+)\}/g)].map(match => ({ key:match[1], from:match.index + 7, to:match.index + 7 + match[1].length }));
  const refs = [...text.matchAll(/\\(?:eq|auto|c|C|page|name)?ref\*?\{([^}]+)\}/g)].map(match => {
    const from = match.index + match[0].indexOf('{') + 1;
    return { key:match[1], from, to:from + match[1].length };
  });
  const cites = [];
  for (const match of text.matchAll(/\\[A-Za-z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}/g)) {
    let at = match.index + match[0].lastIndexOf('{') + 1;
    for (const part of match[1].split(',')) {
      const key = part.trim();
      if (key) cites.push({ key, from:at + part.indexOf(key), to:at + part.indexOf(key) + key.length });
      at += part.length + 1;
    }
  }
  const inputs = [...text.matchAll(/\\(?:input|include|subfile)\{([^}]+)\}/g)].map(match => ({ key:match[1], from:match.index + match[0].indexOf('{') + 1, to:match.index + match[0].length - 1 }));
  return { labels, refs, cites, inputs };
}

export function bibKeys(source) {
  return [...source.matchAll(/^\s*@(?!comment|string|preamble)[a-zA-Z]+\s*\{\s*([^,\s]+)\s*,/gmi)].map(match => match[1]);
}

// `project` is { labels:Set, bibKeys:Set, hasBib:boolean, files:Set } across the whole project, when known.
export function lintSource(source, project = null, path = '') {
  const found = [], text = blankComments(source), skipped = skippedRanges(source);
  const add = (from, to, severity, message) => {
    if (!skipped.some(([start, end]) => from >= start && from < end)) found.push({ from, to, severity, message });
  };
  const stack = [];
  for (const match of text.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
    const [, kind, name] = match;
    const inVerbatim = VERBATIM.test(stack.at(-1)?.name || '');
    if (kind === 'begin') { if (!inVerbatim) stack.push({ name, from:match.index, to:match.index + match[0].length }); continue; }
    if (inVerbatim && stack.at(-1).name !== name) continue;
    const open = stack.pop();
    if (!open) add(match.index, match.index + match[0].length, 'error', `\\end{${name}} has no \\begin{${name}}.`);
    else if (open.name !== name) {
      add(match.index, match.index + match[0].length, 'error', `\\end{${name}} closes \\begin{${open.name}}.`);
      stack.length = 0;
      break;
    }
  }
  for (const open of stack) add(open.from, open.to, 'error', `\\begin{${open.name}} is never closed.`);

  const { labels, refs, cites, inputs } = collectKeys(source);
  const seen = new Set();
  for (const label of labels) {
    if (seen.has(label.key)) add(label.from, label.to, 'warning', `The label ${label.key} is used more than once.`);
    seen.add(label.key);
  }
  if (project) {
    for (const ref of refs) if (!project.labels.has(ref.key)) add(ref.from, ref.to, 'warning', `No \\label{${ref.key}} in this project.`);
    if (project.hasBib) for (const cite of cites) if (!project.bibKeys.has(cite.key)) add(cite.from, cite.to, 'warning', `No entry ${cite.key} in the bibliography.`);
    const folder = path.includes('/') ? path.replace(/[^/]*$/, '') : '';
    for (const input of inputs) {
      const name = /\.[a-z]+$/i.test(input.key) ? input.key : `${input.key}.tex`;
      if (project.files.has(name) || project.files.has(folder + name)) continue;
      const wrongCase = [...project.files].find(file => file.toLowerCase() === name.toLowerCase());
      add(input.from, input.to, 'error', wrongCase ? `The letter case differs: the file is ${wrongCase}.` : `${name} is not in this project.`);
    }
  }
  return found;
}
