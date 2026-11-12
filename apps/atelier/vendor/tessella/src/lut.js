// .cube LUT parser (Adobe Cube LUT Specification 1.0, plus Resolve's LUT_1D/3D_INPUT_RANGE). Pure: no GPU.
// Returns { title, kind: '1d' | '3d', size, domainMin: [r,g,b], domainMax: [r,g,b], data: Float32Array }.
// data holds size (1D) or size³ (3D) RGB triplets in file order: red varies fastest.
// Errors carry code 'invalid' (malformed) or 'unsupported' (a 1D shaper and a 3D table in one file).

const fail = (code, message) => Object.assign(new Error(message), { code });

export function parseCube(text) {
  let title = ''; let size1 = 0; let size3 = 0;
  let dmin = [0, 0, 0]; let dmax = [1, 1, 1];
  const vals = [];
  const lines = String(text).split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].replace(/#.*$/, '').trim();
    if (!line) continue;
    const kw = line.split(/\s+/)[0];
    const args = line.slice(kw.length).trim();
    const nums = () => args.split(/\s+/).map(Number);
    if (/^[-+.\d]/.test(kw)) {
      const t = line.split(/\s+/).map(Number);
      if (t.length !== 3 || t.some((v) => !Number.isFinite(v))) throw fail('invalid', `line ${ln + 1}: expected three numbers`);
      vals.push(...t);
    } else if (kw === 'TITLE') title = args.replace(/^"|"$/g, '');
    else if (kw === 'LUT_1D_SIZE') size1 = Number(args);
    else if (kw === 'LUT_3D_SIZE') size3 = Number(args);
    else if (kw === 'DOMAIN_MIN') dmin = nums();
    else if (kw === 'DOMAIN_MAX') dmax = nums();
    else if (kw === 'LUT_1D_INPUT_RANGE' || kw === 'LUT_3D_INPUT_RANGE') { const [a, b] = nums(); dmin = [a, a, a]; dmax = [b, b, b]; }
    else throw fail('invalid', `line ${ln + 1}: unknown keyword ${kw}`);
  }
  if (size1 && size3) throw fail('unsupported', 'files with both a 1D and a 3D table are not supported');
  if (!size1 && !size3) throw fail('invalid', 'no LUT_1D_SIZE or LUT_3D_SIZE');
  if (size1 && !(Number.isInteger(size1) && size1 >= 2 && size1 <= 65536)) throw fail('invalid', `LUT_1D_SIZE ${size1} outside 2..65536`);
  if (size3 && !(Number.isInteger(size3) && size3 >= 2 && size3 <= 129)) throw fail('invalid', `LUT_3D_SIZE ${size3} outside 2..129`);
  if (dmin.length !== 3 || dmax.length !== 3 || [...dmin, ...dmax].some((v) => !Number.isFinite(v)) || dmin.some((v, i) => !(dmax[i] > v))) throw fail('invalid', 'DOMAIN_MIN must be below DOMAIN_MAX, three numbers each');
  const n = size1 || size3 ** 3;
  if (vals.length !== n * 3) throw fail('invalid', `expected ${n} rows, found ${vals.length / 3}`);
  return { title, kind: size1 ? '1d' : '3d', size: size1 || size3, domainMin: dmin, domainMax: dmax, data: new Float32Array(vals) };
}

// Writes a .cube file (used by tests and checks to make LUTs from a function f(r, g, b) → [r, g, b]).
export function writeCube({ title = '', kind = '3d', size, f }) {
  const out = [`TITLE "${title}"`, `${kind === '1d' ? 'LUT_1D_SIZE' : 'LUT_3D_SIZE'} ${size}`];
  const row = (v) => v.map((x) => x.toFixed(6)).join(' ');
  if (kind === '1d') for (let i = 0; i < size; i++) { const t = i / (size - 1); out.push(row(f(t, t, t))); }
  else for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) out.push(row(f(r / (size - 1), g / (size - 1), b / (size - 1))));
  return out.join('\n') + '\n';
}
