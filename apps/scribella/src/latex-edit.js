import { blankComments } from './lint.js';

// Small LaTeX editing moves on plain text: what Enter adds inside a list, wrapping a selection in an environment,
// renaming the environment around a position, and finding where a label, citation or input is defined.
export function enterAddition(lineText) {
  const item = /^(\s*)\\item\b\s*(.*)$/.exec(lineText);
  if (!item) return null;
  return item[2].trim() ? `\n${item[1]}\\item ` : '';
}

export const wrap = (text, name) => `\\begin{${name}}\n${text}\n\\end{${name}}`;

// The innermost environment holding `pos`, as positions of its two names.
export function environmentAt(source, pos) {
  const text = blankComments(source), stack = [];
  for (const match of text.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
    const nameFrom = match.index + match[0].indexOf('{') + 1, nameTo = nameFrom + match[2].length;
    if (match[1] === 'begin') { stack.push({ name:match[2], open:[nameFrom, nameTo], start:match.index }); continue; }
    const top = stack.pop();
    if (!top) continue;
    if (top.start <= pos && pos < match.index + match[0].length) return { name:top.name, open:top.open, close:[nameFrom, nameTo] };
  }
  return null;
}

// Answers { file, line } for the target of a \ref, \cite, \input or \usepackage under the cursor, or null.
export function definitionOf(token, texts) {
  if (!token) return null;
  if (token.kind === 'ref') {
    for (const [file, text] of Object.entries(texts)) {
      const at = text.indexOf(`\\label{${token.key}}`);
      if (at >= 0) return { file, line:text.slice(0, at).split('\n').length };
    }
  }
  if (token.kind === 'cite') {
    for (const [file, text] of Object.entries(texts)) {
      if (!/\.bib$/i.test(file)) continue;
      const match = new RegExp(`@\\w+\\s*\\{\\s*${token.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,`).exec(text);
      if (match) return { file, line:text.slice(0, match.index).split('\n').length };
    }
  }
  if (token.kind === 'input') {
    for (const name of [token.key, `${token.key}.tex`, `${token.key}.sty`]) if (name in texts) return { file:name, line:1 };
  }
  return null;
}

// Every place a label or citation key is used, across the project.
export function usesOf(key, texts) {
  const found = [], pattern = new RegExp(`\\\\(?:[a-zA-Z]*ref|[a-zA-Z]*cite[a-zA-Z]*)\\*?(?:\\[[^\\]]*\\])*\\{[^}]*\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^}]*\\}`, 'g');
  for (const [file, text] of Object.entries(texts)) {
    if (!/\.(tex|ltx)$/i.test(file)) continue;
    for (const match of text.matchAll(pattern)) found.push({ file, line:text.slice(0, match.index).split('\n').length, text:match[0] });
  }
  return found;
}

// The token at a position: \ref-like, \cite-like or \input-like, with the key under the cursor.
export function tokenAt(text, pos) {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1, lineEnd = text.indexOf('\n', pos);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  for (const match of line.matchAll(/\\([a-zA-Z]*ref|[a-zA-Z]*cite[a-zA-Z]*|input|include|usepackage|label)\*?(?:\[[^\]]*\])*\{([^}]*)\}/g)) {
    let at = lineStart + match.index + match[0].lastIndexOf('{') + 1;
    for (const part of match[2].split(',')) {
      if (pos >= at && pos <= at + part.length) {
        const kind = /ref$/.test(match[1]) ? 'ref' : /cite/.test(match[1]) ? 'cite' : match[1] === 'label' ? 'label' : 'input';
        return { kind, key:part.trim() };
      }
      at += part.length + 1;
    }
  }
  return null;
}

const VENUES = [['neurips', 'NeurIPS'], ['icml', 'ICML'], ['iclr', 'ICLR'], ['acl', 'ACL'], ['cvpr', 'CVPR'], ['aaai', 'AAAI'], ['IEEEtran', 'IEEE'], ['acmart', 'ACM'], ['beamer', 'Beamer slides'], ['llncs', 'Springer LNCS'], ['elsarticle', 'Elsevier']];

// Reads the venue from what the preamble loads, not from a setting.
export function detectVenue(source) {
  const preamble = source.split('\\begin{document}')[0];
  const loaded = [...preamble.matchAll(/\\(?:documentclass|usepackage)(?:\[[^\]]*\])?\{([^}]+)\}/g)].flatMap(match => match[1].split(',').map(name => name.trim()));
  const hit = VENUES.find(([prefix]) => loaded.some(name => name.toLowerCase().startsWith(prefix.toLowerCase())));
  return hit ? hit[1] : null;
}
