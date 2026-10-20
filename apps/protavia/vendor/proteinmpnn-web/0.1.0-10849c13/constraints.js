import { ALPHABET } from './types.js';
import { resolveResidue } from './structure.js';
import { normalize } from './math.js';
function aaIndex(aa) { const i = ALPHABET.indexOf(aa); if (aa.length !== 1 || i < 0)
    throw new Error(`Invalid amino acid: ${aa}`); return i; }
export function constraints(s, options) {
    const n = s.length, design = Float32Array.from(s.mask), bias = new Float64Array(n * 21), omit = new Uint8Array(n * 21), globalOmit = new Uint8Array(21);
    const chains = new Set(s.chainIds);
    if (options.designChains)
        for (const chain of options.designChains)
            if (!chains.has(chain))
                throw new Error(`Unknown design chain: ${chain}`);
    if (options.designChains)
        for (let i = 0; i < n; i++)
            if (!options.designChains.includes(s.chainIds[i]))
                design[i] = 0;
    if (options.designPositions) {
        const selected = new Set(options.designPositions.map(p => resolveResidue(s, p)));
        for (let i = 0; i < n; i++)
            if (!selected.has(i))
                design[i] = 0;
    }
    for (const p of options.fixedPositions ?? [])
        design[resolveResidue(s, p)] = 0;
    for (const aa of options.omitAminoAcids ?? 'X')
        globalOmit[aaIndex(aa)] = 1;
    for (const [aa, value] of Object.entries(options.biasAminoAcids ?? {})) {
        const a = aaIndex(aa);
        if (!Number.isFinite(value))
            throw new Error('Bias must be finite');
        for (let i = 0; i < n; i++)
            bias[i * 21 + a] = value;
    }
    for (const item of options.biasByResidue ?? []) {
        const i = resolveResidue(s, item.position);
        for (const [aa, value] of Object.entries(item.bias)) {
            if (!Number.isFinite(value))
                throw new Error('Bias must be finite');
            bias[i * 21 + aaIndex(aa)] += value;
        }
    }
    for (const item of options.omitByResidue ?? []) {
        const i = resolveResidue(s, item.position);
        for (const aa of item.aminoAcids)
            omit[i * 21 + aaIndex(aa)] = 1;
    }
    const seen = new Set(), groups = [];
    for (const raw of options.tiedPositions ?? []) {
        const group = 'positions' in raw ? raw : { positions: raw };
        const positions = group.positions.map(p => resolveResidue(s, p));
        if (positions.length < 2)
            throw new Error('Tied groups must have at least two positions');
        const weights = group.weights ? [...group.weights] : positions.map(() => 1);
        if (weights.length !== positions.length || weights.some(w => !Number.isFinite(w)))
            throw new Error('Tied weights must be finite and match positions');
        for (const i of positions) {
            if (seen.has(i))
                throw new Error('Tied groups overlap or contain duplicate positions');
            seen.add(i);
        }
        const fixed = positions.filter(i => !design[i]);
        if (fixed.length) {
            const native = s.sequence[fixed[0]];
            if (fixed.some(i => s.sequence[i] !== native))
                throw new Error('Tied fixed residues have conflicting native amino acids');
            if (positions.some(i => !s.mask[i]))
                throw new Error('Tied positions cannot contain missing coordinates');
            // A fixed member pins the whole group, without changing other fixed residues.
        }
        groups.push({ positions, weights });
    }
    const pssm = options.pssm;
    if (pssm) {
        const mix = pssm.mix ?? 0;
        if (!Number.isFinite(mix) || mix < 0 || mix > 1)
            throw new Error('pssm.mix must be in [0,1]');
        if (pssm.threshold !== undefined && Number.isNaN(pssm.threshold))
            throw new Error('PSSM threshold must not be NaN');
        for (const [name, width] of [['probabilities', 21], ['coefficients', 1], ['logOdds', 21]]) {
            const data = pssm[name];
            if (data && data.length !== n * width)
                throw new Error(`pssm.${name} must have length ${n * width}`);
            if (data)
                for (let j = 0; j < data.length; j++)
                    if (!Number.isFinite(data[j]))
                        throw new Error(`pssm.${name} must be finite`);
        }
        if (pssm.useBias && !pssm.probabilities)
            throw new Error('PSSM bias requires probabilities');
        if (pssm.useLogOdds && !pssm.logOdds)
            throw new Error('PSSM log-odds filtering requires logOdds');
        for (let i = 0; i < n; i++) {
            const c = pssm.coefficients?.[i] ?? 1;
            if (c < 0 || c > 1)
                throw new Error('PSSM coefficients must be in [0,1]');
            if (pssm.probabilities) {
                let sum = 0;
                for (let a = 0; a < 21; a++) {
                    const p = pssm.probabilities[i * 21 + a];
                    if (p < 0)
                        throw new Error('Negative PSSM probability');
                    sum += p;
                }
                if (Math.abs(sum - 1) > 1e-4)
                    throw new Error(`PSSM probability row ${i} must sum to 1`);
            }
        }
    }
    const mode = options.tiedConstraintMode ?? 'upstream';
    if (mode !== 'upstream' && mode !== 'intersection')
        throw new Error('Invalid tiedConstraintMode');
    if (mode === 'intersection' && pssm)
        for (const group of groups)
            for (const i of group.positions.slice(1))
                for (const key of ['probabilities', 'coefficients', 'logOdds']) {
                    const data = pssm[key];
                    if (!data)
                        continue;
                    const width = key === 'coefficients' ? 1 : 21;
                    for (let a = 0; a < width; a++)
                        if (data[i * width + a] !== data[group.positions[0] * width + a])
                            throw new Error('Intersection tied mode requires identical PSSMs for tied members');
                }
    return { design, bias, omit, globalOmit, groups, pssm, mode };
}
export function decodingGroups(s, c, options, rng) {
    let order;
    if (options.decodingOrder) {
        order = Array.from(options.decodingOrder);
        if (order.length !== s.length || new Set(order).size !== s.length || order.some(i => !Number.isInteger(i) || i < 0 || i >= s.length))
            throw new Error('decodingOrder must be a complete permutation');
    }
    else {
        if (options.orderNoise && (options.orderNoise.length !== s.length || Array.from(options.orderNoise).some(v => !Number.isFinite(v))))
            throw new Error('orderNoise must contain N finite values');
        const keys = Array.from(c.design, (m, i) => (m + 0.0001) * Math.abs(options.orderNoise?.[i] ?? rng.normal()));
        order = Array.from({ length: s.length }, (_, i) => i).sort((a, b) => keys[a] - keys[b] || a - b);
    }
    const map = new Map();
    for (const g of c.groups)
        for (const i of g.positions)
            map.set(i, g.positions);
    const used = new Set(), result = [];
    for (const i of order)
        if (!used.has(i)) {
            const group = map.get(i) ?? [i];
            result.push(group);
            group.forEach(j => used.add(j));
        }
    return result;
}
export function distribution(logits, positions, temperature, c) {
    const indices = c.mode === 'intersection' ? positions : [positions.at(-1)], row = positions.at(-1);
    if (c.globalOmit.every(v => v === 1) && !(c.pssm?.useBias && (c.pssm.mix ?? 0) * (c.pssm.coefficients?.[row] ?? 1) > 0))
        throw new Error(`No amino acid remains allowed at residue ${row}`);
    const values = new Float64Array(21);
    let max = -Infinity;
    for (let a = 0; a < 21; a++) {
        const bias = indices.reduce((sum, i) => sum + c.bias[i * 21 + a], 0) / indices.length;
        values[a] = (logits[a] + bias) / temperature - (c.globalOmit[a] ? 1e8 : 0);
        max = Math.max(max, values[a]);
    }
    for (let a = 0; a < 21; a++)
        values[a] = Math.exp(values[a] - max);
    normalize(values, `residue ${row}`);
    const p = c.pssm;
    if (p?.useBias) {
        const mix = (p.mix ?? 0) * (p.coefficients?.[row] ?? 1);
        for (let a = 0; a < 21; a++)
            values[a] = (1 - mix) * values[a] + mix * p.probabilities[row * 21 + a];
    }
    if (p?.useLogOdds)
        for (let a = 0; a < 21; a++)
            values[a] *= (p.logOdds[row * 21 + a] > (p.threshold ?? 0) ? 1 : 0) + 0.001;
    for (let a = 0; a < 21; a++)
        if (indices.some(i => c.omit[i * 21 + a]))
            values[a] = 0;
    // Preserve upstream's PSSM mixture semantics, including reintroduction of global omissions.
    return normalize(values, `residue ${row}`);
}
//# sourceMappingURL=constraints.js.map