// Blocks of LaTeX the page writes for you: figures, booktabs tables from pasted data, and the symbol palette.
export const slug = text => text.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';

export function figureBlock({ path, caption = '', label = slug(path.replace(/^.*\//, '')) }) {
  return `\\begin{figure}[t]
  \\centering
  \\includegraphics[width=\\linewidth]{${path}}
  \\caption{${caption}}
  \\label{fig:${label}}
\\end{figure}
`;
}

// One quoted field may hold the separator. The separator is tab when any line has one, else comma.
export function parseTable(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim());
  const separator = lines.some(line => line.includes('\t')) ? '\t' : ',';
  return lines.map(line => {
    const cells = [];
    let cell = '', quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"' && quoted && line[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = !quoted;
      else if (char === separator && !quoted) { cells.push(cell.trim()); cell = ''; }
      else cell += char;
    }
    cells.push(cell.trim());
    return cells;
  });
}

const SPECIAL = { '\\':'\\textbackslash{}', '~':'\\textasciitilde{}', '^':'\\textasciicircum{}' };
export const escapeText = text => text.replace(/[\\~^&%$#_{}]/g, char => SPECIAL[char] ?? `\\${char}`);
const isNumber = cell => /^[-+]?\d[\d,]*(\.\d+)?%?$/.test(cell);

export function tableBlock(rows, { caption = '', label = 'table' } = {}) {
  const width = Math.max(...rows.map(row => row.length));
  const body = rows.slice(1);
  const columns = Array.from({ length:width }, (_, index) => (body.length && body.every(row => !row[index] || isNumber(row[index])) ? 'r' : 'l')).join('');
  const line = row => `    ${Array.from({ length:width }, (_, index) => escapeText(row[index] ?? '')).join(' & ')} \\\\`;
  return `\\begin{table}[t]
  \\centering
  \\caption{${escapeText(caption)}}
  \\label{tab:${label}}
  \\begin{tabular}{${columns}}
    \\toprule
${line(rows[0])}
    \\midrule
${body.map(line).join('\n')}
    \\bottomrule
  \\end{tabular}
\\end{table}
`;
}

export const needsBooktabs = source => !/\\usepackage(\[[^\]]*\])?\{[^}]*\bbooktabs\b/.test(source);

export const SYMBOLS = [
  ['Greek', 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega'],
  ['Relations', 'leq geq neq approx equiv sim simeq propto subset subseteq supset supseteq in notin ll gg'],
  ['Operators', 'sum prod int oint partial nabla times cdot div pm mp cup cap wedge vee oplus otimes'],
  ['Arrows', 'to gets leftrightarrow Rightarrow Leftarrow Leftrightarrow mapsto uparrow downarrow'],
  ['Other', 'infty forall exists emptyset ldots cdots mathbb{R} mathbb{N} mathbb{Z} mathcal{L} hat{x} bar{x} tilde{x} frac{a}{b} sqrt{x}'],
].map(([group, names]) => ({ group, names:names.split(' ') }));
