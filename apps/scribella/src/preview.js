// A quick reading view of the paragraph at the cursor: prose with its commands softened, math typeset by KaTeX.
const escape = text => text.replace(/[&<>"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[char]);

export function paragraphAt(text, pos) {
  const start = text.lastIndexOf('\n\n', pos - 1), end = text.indexOf('\n\n', pos);
  return text.slice(start < 0 ? 0 : start + 2, end < 0 ? text.length : end);
}

// `math(tex, display)` answers HTML; `labels` maps a label to { number }.
export function renderParagraph(source, { math = tex => escape(tex), labels = new Map() } = {}) {
  const parts = [];
  let last = 0;
  const body = source.replace(/(?<!\\)%.*$/gm, '');
  for (const match of body.matchAll(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\begin\{(equation|align|gather)\*?\}([\s\S]+?)\\end\{\3\*?\}|(?<![\\$])\$([^$]+?)\$/g)) {
    parts.push(prose(body.slice(last, match.index), labels));
    const display = match[5] === undefined;
    const tex = (match[1] ?? match[2] ?? match[4] ?? match[5]).replace(/\\label\{[^}]*\}/g, '');
    parts.push(math(match[3] === 'align' ? `\\begin{aligned}${tex}\\end{aligned}` : tex, display));
    last = match.index + match[0].length;
  }
  parts.push(prose(body.slice(last), labels));
  return parts.join('');
}

function prose(text, labels) {
  return escape(text)
    .replace(/\\(?:section|subsection|subsubsection|paragraph)\*?\{([^}]*)\}/g, '<strong>$1</strong>')
    .replace(/\\(?:emph|textit)\{([^}]*)\}/g, '<em>$1</em>')
    .replace(/\\textbf\{([^}]*)\}/g, '<strong>$1</strong>')
    .replace(/\\texttt\{([^}]*)\}/g, '<code>$1</code>')
    .replace(/\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}/g, '[$1]')
    .replace(/\\(?:eq|auto|c|C)?ref\{([^}]*)\}/g, (_, key) => escape(labels.get(key)?.number || '??'))
    .replace(/\\label\{[^}]*\}/g, '')
    .replace(/~/g, '&nbsp;')
    .replace(/\\\\/g, '<br>')
    .replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, '')
    .replace(/[{}]/g, '');
}
