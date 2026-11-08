// Markdown notes rendered for reading: headings, lists, emphasis, code and links. Text is escaped first, so nothing in a
// note can run as HTML.
const escape = text => text.replace(/[&<>"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[char]);

const inline = text => escape(text)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\*([^*]+)\*/g, '<em>$1</em>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

export function renderMarkdown(source) {
  const out = [];
  let list = null, code = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of source.split('\n')) {
    if (code !== null) {
      if (/^```/.test(line)) { out.push(`<pre><code>${escape(code)}</code></pre>`); code = null; } else code += `${line}\n`;
      continue;
    }
    if (/^```/.test(line)) { closeList(); code = ''; continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (heading) { closeList(); out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); }
    else if (item) {
      const kind = /\d/.test(item[1]) ? 'ol' : 'ul';
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(item[2])}</li>`);
    } else if (!line.trim()) closeList();
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  if (code !== null) out.push(`<pre><code>${escape(code)}</code></pre>`);
  return out.join('');
}
