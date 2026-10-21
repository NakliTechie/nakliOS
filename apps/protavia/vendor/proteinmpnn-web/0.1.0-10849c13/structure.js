import { ALPHABET } from './types.js';
const AA3 = { ALA: 'A', CYS: 'C', ASP: 'D', GLU: 'E', PHE: 'F', GLY: 'G', HIS: 'H', ILE: 'I', LYS: 'K', LEU: 'L', MET: 'M', ASN: 'N', PRO: 'P', GLN: 'Q', ARG: 'R', SER: 'S', THR: 'T', VAL: 'V', TRP: 'W', TYR: 'Y', MSE: 'M', UNK: 'X' };
export function encodeSequence(sequence, length) {
    const s = sequence.replace(/[\s/]/g, '').toUpperCase();
    if (length !== undefined && s.length !== length)
        throw new Error(`Expected ${length} residues, got ${s.length}`);
    return Int32Array.from(s, aa => { const i = ALPHABET.indexOf(aa); if (i < 0)
        throw new Error(`Invalid amino acid: ${aa}`); return i; });
}
function integer(value, field) {
    if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)
        throw new Error(`${field} must be an int32`);
    return value;
}
export function fromCoordinates(input) {
    const atomMode = input.atomMode ?? 'backbone';
    if (atomMode !== 'ca' && atomMode !== 'backbone')
        throw new Error('Invalid atomMode');
    const stride = atomMode === 'ca' ? 3 : 12;
    const n = input.coordinates.length / stride;
    if (!Number.isInteger(n) || n < 1)
        throw new Error(`coordinates must contain a nonempty [N,${stride}] array`);
    for (const key of ['chainIds', 'residueNumbers', 'insertionCodes', 'residueIndices', 'mask']) {
        if (input[key] && input[key].length !== n)
            throw new Error(`${key} must have length ${n}`);
    }
    const sequence = input.sequence !== undefined ? Array.from(encodeSequence(input.sequence, n), i => ALPHABET[i]).join('') : 'X'.repeat(n);
    const coordinates = Float32Array.from(input.coordinates);
    const mask = new Float32Array(n).fill(1);
    const chainIds = input.chainIds ? [...input.chainIds] : Array(n).fill('A');
    const insertionCodes = input.insertionCodes ? [...input.insertionCodes] : Array(n).fill('');
    const residueNumbers = new Int32Array(n), residueIndices = new Int32Array(n), chainEncoding = new Int32Array(n);
    const chains = new Map();
    const counts = new Map();
    const seen = new Set();
    for (let i = 0; i < n; i++) {
        const chain = chainIds[i];
        if (typeof chain !== 'string' || !chain.length)
            throw new Error('chainIds must be nonempty strings');
        if (!chains.has(chain))
            chains.set(chain, chains.size + 1);
        const count = (counts.get(chain) ?? 0) + 1;
        counts.set(chain, count);
        chainEncoding[i] = chains.get(chain);
        residueNumbers[i] = integer(input.residueNumbers?.[i] ?? count, 'residueNumbers');
        residueIndices[i] = integer(input.residueIndices?.[i] ?? (count - 1), 'residueIndices');
        const key = JSON.stringify([chain, residueNumbers[i], insertionCodes[i]]);
        if (seen.has(key))
            throw new Error(`Duplicate residue identifier at index ${i}`);
        seen.add(key);
        if (input.mask) {
            if (input.mask[i] !== 0 && input.mask[i] !== 1)
                throw new Error('mask must contain only 0 or 1');
            mask[i] = input.mask[i];
        }
        for (let j = 0; j < stride; j++)
            if (!Number.isFinite(coordinates[i * stride + j]))
                mask[i] = 0;
        if (!mask[i])
            coordinates.fill(0, i * stride, (i + 1) * stride);
    }
    return { length: n, atomMode, coordinates, sequence, chainIds, residueNumbers, insertionCodes, residueIndices, chainEncoding, mask };
}
export function fromResidues(residues, options = {}) {
    const atomMode = options.atomMode ?? 'backbone';
    const atoms = atomMode === 'ca' ? ['CA'] : ['N', 'CA', 'C', 'O'];
    return fromCoordinates({ atomMode, coordinates: residues.flatMap(r => atoms.flatMap(a => [...(r.atoms[a] ?? [NaN, NaN, NaN])])),
        sequence: residues.map(r => r.aminoAcid ?? AA3[r.name ?? 'UNK'] ?? 'X').join(''), chainIds: residues.map(r => r.chain),
        residueNumbers: residues.map(r => r.number), insertionCodes: residues.map(r => r.insertionCode ?? '') });
}
export function parsePDB(pdb, options = {}) {
    const selectedModel = options.model ?? 1;
    if (!Number.isInteger(selectedModel) || selectedModel < 1)
        throw new Error('model must be a positive integer');
    if (options.altLoc !== undefined && options.altLoc.length > 1)
        throw new Error('altLoc must be one character');
    const maxResidues = options.maxResidues ?? 100000;
    if (!Number.isInteger(maxResidues) || maxResidues < 1)
        throw new Error('maxResidues must be positive');
    const entries = new Map();
    const chainOrder = [];
    let model = 1, sawModel = false;
    for (const line of pdb.split(/\r?\n/)) {
        const record = line.slice(0, 6).trim();
        if (record === 'MODEL') {
            model = sawModel ? model + 1 : 1;
            sawModel = true;
            continue;
        }
        if (record === 'ENDMDL' && model === selectedModel)
            break;
        if (model !== selectedModel || !['ATOM', 'HETATM'].includes(record))
            continue;
        const name = line.slice(17, 20).trim();
        if (record === 'HETATM' && name !== 'MSE')
            continue;
        const atom = line.slice(12, 16).trim();
        if (!['N', 'CA', 'C', 'O'].includes(atom))
            continue;
        const chain = line.slice(21, 22).trim() || '_';
        if (options.chains && !options.chains.includes(chain))
            continue;
        const number = Number(line.slice(22, 26).trim());
        if (!Number.isInteger(number))
            throw new Error('Invalid PDB residue number');
        const insertionCode = line.slice(26, 27).trim();
        const alt = line.slice(16, 17).trim();
        const key = JSON.stringify([chain, number, insertionCode]);
        let entry = entries.get(key);
        if (!entry) {
            if (entries.size >= maxResidues)
                throw new Error('PDB exceeds maxResidues');
            entry = { residue: { chain, number, insertionCode, name, atoms: {} }, variants: new Map() };
            entries.set(key, entry);
            if (!chainOrder.includes(chain))
                chainOrder.push(chain);
        }
        const xyz = [30, 38, 46].map(i => { const text = line.slice(i, i + 8).trim(); return text ? Number(text) : NaN; });
        const occupancy = Number(line.slice(54, 60).trim() || 0);
        if (!entry.variants.has(alt))
            entry.variants.set(alt, new Map());
        const variants = entry.variants.get(alt);
        const old = variants.get(atom);
        if (!old || occupancy > old.occupancy)
            variants.set(atom, { xyz, occupancy });
    }
    if (!entries.size)
        throw new Error('No backbone atoms found for requested PDB model/chains');
    if (options.chains)
        for (const chain of options.chains)
            if (!chainOrder.includes(chain))
                throw new Error(`PDB chain not found: ${chain}`);
    const residues = [];
    for (const chain of chainOrder) {
        const rows = [...entries.values()].filter(e => e.residue.chain === chain).sort((a, b) => a.residue.number - b.residue.number || (a.residue.insertionCode ?? '').localeCompare(b.residue.insertionCode ?? ''));
        let previous;
        for (const entry of rows) {
            const r = entry.residue;
            if (options.fillGaps !== false && previous !== undefined) {
                if (residues.length + Math.max(0, r.number - previous - 1) > maxResidues)
                    throw new Error('PDB residue gaps exceed maxResidues; use fillGaps:false');
                for (let number = previous + 1; number < r.number; number++)
                    residues.push({ chain, number, name: 'UNK', atoms: {} });
            }
            previous = r.number;
            const alternatives = [...entry.variants.keys()].filter(a => a !== '');
            const total = (a) => [...entry.variants.get(a).values()].reduce((sum, v) => sum + v.occupancy, 0);
            alternatives.sort((a, b) => total(b) - total(a) || a.localeCompare(b));
            const chosen = options.altLoc ?? alternatives[0];
            for (const atom of ['N', 'CA', 'C', 'O']) {
                const data = (chosen !== undefined ? entry.variants.get(chosen)?.get(atom) : undefined) ?? entry.variants.get('')?.get(atom);
                if (data)
                    r.atoms[atom] = data.xyz;
            }
            residues.push(r);
            if (residues.length > maxResidues)
                throw new Error('PDB exceeds maxResidues');
        }
    }
    return fromResidues(residues, options);
}
export function resolveResidue(structure, ref) {
    if (typeof ref === 'number') {
        if (!Number.isInteger(ref) || ref < 0 || ref >= structure.length)
            throw new Error(`Residue index out of range: ${ref}`);
        return ref;
    }
    for (let i = 0; i < structure.length; i++)
        if (structure.chainIds[i] === ref.chain && structure.residueNumbers[i] === ref.number && structure.insertionCodes[i] === (ref.insertionCode ?? ''))
            return i;
    throw new Error(`Residue not found: ${JSON.stringify(ref)}`);
}
export function splitChains(structure, sequence = structure.sequence) {
    const indices = encodeSequence(sequence, structure.length);
    const result = Object.create(null);
    for (let i = 0; i < structure.length; i++)
        result[structure.chainIds[i]] = (result[structure.chainIds[i]] ?? '') + ALPHABET[indices[i]];
    return result;
}
export function parseFASTA(text) {
    const result = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith(';'))
            continue;
        if (line.startsWith('>'))
            result.push({ name: line.slice(1).trim(), sequence: '' });
        else {
            if (!result.length)
                throw new Error('FASTA must begin with a > header');
            result.at(-1).sequence += line;
        }
    }
    for (const item of result) {
        if (!item.sequence)
            throw new Error('Empty FASTA record');
        encodeSequence(item.sequence);
    }
    return result;
}
//# sourceMappingURL=structure.js.map