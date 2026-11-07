// Search and replace across the project's text files, and the TODO scan.
const LIMIT = 500;

export function matcher(query, { regex = false, matchCase = false } = {}) {
  if (!query) return null;
  const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(source, matchCase ? 'g' : 'gi');
}

export function findAll(texts, query, options = {}) {
  const pattern = matcher(query, options), found = [];
  if (!pattern) return found;
  for (const file of Object.keys(texts).sort()) {
    const lines = texts[file].split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      for (const match of lines[index].matchAll(pattern)) {
        if (!match[0]) continue;
        found.push({ file, line:index + 1, column:match.index, text:lines[index].trim().slice(0, 120), match:match[0] });
        if (found.length >= LIMIT) return found;
      }
    }
  }
  return found;
}

// Answers the new text and how many places changed. A regex replacement may use $1 and the like.
export function replaceAllIn(text, query, replacement, options = {}) {
  const pattern = matcher(query, options);
  if (!pattern) return { text, count:0 };
  let count = 0;
  const next = text.replace(pattern, (...args) => {
    count += 1;
    if (!options.regex) return replacement;
    const groups = args.slice(1, args.findIndex(item => typeof item === 'number'));
    return replacement.replace(/\$(\d)/g, (_, digit) => groups[digit - 1] ?? '');
  });
  return { text:next, count };
}

export function findTodos(texts) {
  return findAll(Object.fromEntries(Object.entries(texts).filter(([file]) => /\.(tex|ltx)$/i.test(file))), '(%.*\\b(TODO|FIXME|XXX)\\b|\\\\todo\\b)', { regex:true, matchCase:true });
}
