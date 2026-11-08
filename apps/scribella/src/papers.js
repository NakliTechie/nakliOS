// A paper's full text as Markdown, read from arXiv's HTML version, which answers browsers directly. Math keeps its TeX.
export function htmlToMarkdown(html, parse = text => new DOMParser().parseFromString(text, 'text/html')) {
  const doc = parse(html), article = doc.querySelector('article') || doc.body;
  const lines = [];
  const text = node => {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) out += child.textContent;
      else if (child.nodeType === 1) {
        if (child.tagName === 'MATH') out += `$${child.getAttribute('alttext') || child.textContent}$`;
        else if (/^(SCRIPT|STYLE|BUTTON)$/.test(child.tagName)) continue;
        else out += text(child);
      }
    }
    return out.replace(/\s+/g, ' ');
  };
  for (const node of article.querySelectorAll('h1, h2, h3, h4, p, li, figcaption, .ltx_equation')) {
    if (node.closest('nav, footer, .ltx_bibliography') && !/^H/.test(node.tagName)) continue;
    const body = text(node).trim();
    if (!body) continue;
    if (/^H\d/.test(node.tagName)) lines.push(`${'#'.repeat(Number(node.tagName[1]))} ${body}`);
    else if (node.tagName === 'LI') lines.push(`- ${body}`);
    else if (node.tagName === 'FIGCAPTION') lines.push(`*${body}*`);
    else lines.push(body);
  }
  return lines.join('\n\n');
}

export async function arxivMarkdown(id, load = fetch) {
  const reply = await load(`https://arxiv.org/html/${encodeURIComponent(id)}`);
  if (!reply.ok) throw new Error(`arXiv has no HTML version of ${id} (${reply.status}).`);
  return htmlToMarkdown(await reply.text());
}
