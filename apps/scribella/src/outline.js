// The document's structure, following \input and \include from the main file, and an estimate of its word count.
import { blankComments } from './lint.js';

const LEVELS = { part:0, chapter:1, section:2, subsection:3, subsubsection:4, paragraph:5 };
const MAX_DEPTH = 8;

// `read(path)` answers the text of a project file, or null.
export function buildOutline(read, main) {
  const items = [], visited = new Set();
  const walk = (path, depth) => {
    if (depth > MAX_DEPTH || visited.has(path)) return;
    visited.add(path);
    const source = read(path);
    if (source == null) return;
    const text = blankComments(source);
    for (const match of text.matchAll(/\\(part|chapter|section|subsection|subsubsection|paragraph)\*?(?:\[[^\]]*\])?\{([^}]*)\}|\\(?:input|include)\{([^}]+)\}/g)) {
      if (match[3]) {
        walk(/\.tex$/.test(match[3]) ? match[3] : `${match[3]}.tex`, depth + 1);
        continue;
      }
      items.push({ level:LEVELS[match[1]], title:match[2], file:path, line:source.slice(0, match.index).split('\n').length });
    }
  };
  walk(main, 0);
  return items;
}

export function wordCount(source) {
  const start = source.indexOf('\\begin{document}');
  const body = blankComments(start >= 0 ? source.slice(start + 16) : source)
    .replace(/\\end\{document\}[\s\S]*$/, '')
    .replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, ' ')
    .replace(/\\(?:begin|end|label|ref|eqref|cite[a-z]*|includegraphics|input|include|bibliography[a-z]*)\*?(?:\[[^\]]*\])?\{[^}]*\}/g, ' ')
    .replace(/\\[A-Za-z@]+\*?/g, ' ')
    .replace(/[{}[\]&~^_]/g, ' ');
  return body.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
}
