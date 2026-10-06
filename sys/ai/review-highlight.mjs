// Bounded, per-line syntax hints shared by Editor's reader and Anvil's diff.
// This does not parse code or change the source text; callers render textContent.
const KEYWORDS = new Set('async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield'.split(' '));

export function highlightLine(line, language = '') {
  const text = String(line);
  const lang = String(language).toLowerCase();
  const codeLike = /^(?:javascript|typescript|java|c\+\+|go|rust|swift|js|mjs|cjs|jsx|ts|tsx|c|cc|cpp|rs)$/.test(lang);
  const hashComments = /^(?:python|shell|ruby|toml|yaml|py|sh|bash|zsh|rb|yml)$/.test(lang);
  const markup = /^(?:html|xml|svg|vue|svelte|htm)$/.test(lang);
  const tokens = [];
  const pattern = /\/\/.*$|#.*$|<\/?[A-Za-z][^>]*>|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b/g;
  let at = 0, match;
  while ((match = pattern.exec(text))) {
    if (match.index > at) tokens.push({ text: text.slice(at, match.index), kind: 'plain' });
    const value = match[0];
    let kind = 'plain';
    if ((value.startsWith('//') && codeLike) || (value.startsWith('#') && hashComments)) kind = 'comment';
    else if (value.startsWith('<') && markup) kind = 'tag';
    else if (value[0] === '"' || value[0] === "'" || value[0] === '`') kind = 'string';
    else if (/^\d/.test(value)) kind = 'number';
    else if (KEYWORDS.has(value) && codeLike) kind = 'keyword';
    tokens.push({ text: value, kind });
    at = pattern.lastIndex;
  }
  if (at < text.length) tokens.push({ text: text.slice(at), kind: 'plain' });
  if (!tokens.length) tokens.push({ text: '', kind: 'plain' });
  return tokens;
}
