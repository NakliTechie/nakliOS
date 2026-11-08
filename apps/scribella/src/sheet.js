// A data sheet is a CSV or TSV file shown as a grid. It writes back in the format it came in, quoting what needs it.
export function parseDelimited(text, separator) {
  const rows = [];
  let row = [], cell = '', quoted = false, started = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === '') { quoted = true; started = true; }
    else if (char === separator) { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = ''; started = false;
    } else cell += char;
  }
  if (cell !== '' || row.length || started) { row.push(cell); rows.push(row); }
  return rows;
}

export function readSheet(text, path) {
  const separator = /\.tsv$/i.test(path) ? '\t' : ',';
  const rows = text.trim() ? parseDelimited(text, separator) : [['']];
  const width = Math.max(...rows.map(row => row.length));
  return { separator, rows:rows.map(row => [...row, ...Array(width - row.length).fill('')]) };
}

const quote = (cell, separator) => (cell.includes(separator) || /["\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

export const writeSheet = ({ rows, separator }) => `${rows.map(row => row.map(cell => quote(cell, separator)).join(separator)).join('\n')}\n`;
