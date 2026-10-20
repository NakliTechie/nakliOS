// Formulas, rendered the way Anki shows them, as MathML from KaTeX (vendor/katex.mjs, MIT), before the card
// enters its script-free frame. MathML needs no fonts or stylesheet, so the frame's CSP stays as it is.
//
//   \( … \)  inline MathJax          \[ … \]  display MathJax
//   [$] … [/$]  inline LaTeX         [$$] … [/$$]  display LaTeX      [latex] … [/latex]  LaTeX block
// Anki renders the LaTeX forms to images when a note is added, with a real TeX install; KaTeX covers the
// maths in them, not full LaTeX documents. A formula KaTeX cannot parse shows as its source, marked.

const MARKERS = /\\\(|\\\[|\[\$\$?\]|\[latex\]/i;

/** @param {string} s */
export const hasMath = (s) => MARKERS.test(s);

/** TeX source from field HTML: line breaks kept, tags dropped, entities decoded. @param {string} html */
function texSource(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * @param {string} html
 * @param {{ renderToString: (tex: string, opts: object) => string } | null} katex  null leaves the source
 */
export function renderMath(html, katex) {
  if (!katex || !hasMath(html)) return html;
  /** @param {string} src @param {boolean} display */
  const tex = (src, display) => {
    const source = texSource(src);
    try {
      return katex.renderToString(source, { displayMode: display, output: 'mathml', throwOnError: true, strict: 'ignore' });
    } catch {
      const text = source.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      return `<code class="vc-math-error" title="Formula could not be rendered">${text}</code>`;
    }
  };
  return html
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, t) => tex(t, true))
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, t) => tex(t, false))
    .replace(/\[\$\$\]([\s\S]*?)\[\/\$\$\]/gi, (_, t) => tex(t, true))
    .replace(/\[\$\]([\s\S]*?)\[\/\$\]/gi, (_, t) => tex(t, false))
    .replace(/\[latex\]([\s\S]*?)\[\/latex\]/gi, (_, t) => tex(t, true));
}
