import { ALPHABET } from './types.js';
import { fromCoordinates, parsePDB, encodeSequence, splitChains, resolveResidue } from './structure.js';
import { Random, seedValue, checkAbort, buildNeighborGraph, backwardMask, logSoftmax } from './math.js';
import { constraints, decodingGroups } from './constraints.js';
import { distribution } from './constraints.js';
import { OnnxBackend } from './onnx.js';
export class ProteinMPNN {
    backend;
    closed = false;
    constructor(backend) {
        this.backend = backend;
    }
    static async load(source, options = {}) { return new ProteinMPNN(await OnnxBackend.create(source, options)); }
    get manifest() { return this.backend.manifest; }
    assertOpen() { if (this.closed)
        throw new Error('Model is disposed'); }
    async prepare(input, options = {}) {
        this.assertOpen();
        checkAbort(options.signal);
        const maxLength = options.maxLength ?? 10000;
        if (!Number.isInteger(maxLength) || maxLength < 1)
            throw new Error('maxLength must be positive');
        if (input.length > maxLength)
            throw new Error(`Structure exceeds maxLength (${maxLength}); neighbor search is quadratic in length`);
        let coordinates = input.coordinates, atomMode = input.atomMode;
        if (this.manifest.atomMode === 'ca' && atomMode === 'backbone') {
            coordinates = new Float32Array(input.length * 3);
            for (let i = 0; i < input.length; i++)
                coordinates.set(input.coordinates.subarray(i * 12 + 3, i * 12 + 6), i * 3);
            atomMode = 'ca';
        }
        if (atomMode !== this.manifest.atomMode)
            throw new Error(`Model requires ${this.manifest.atomMode} coordinates`);
        if (atomMode === 'ca' && input.length < 3)
            throw new Error('CA-only models require at least three residues');
        const s = fromCoordinates({ coordinates, atomMode, sequence: input.sequence, chainIds: input.chainIds, residueNumbers: input.residueNumbers,
            insertionCodes: input.insertionCodes, residueIndices: input.residueIndices, mask: input.mask });
        if (!s.mask.some(v => v === 1))
            throw new Error('Structure has no residues with complete coordinates');
        const noise = options.backboneNoise ?? 0;
        if (!Number.isFinite(noise) || noise < 0)
            throw new Error('backboneNoise must be nonnegative');
        if (noise && options.graph)
            throw new Error('A precomputed graph cannot be combined with backboneNoise');
        if (noise) {
            const rng = new Random(seedValue(options.seed));
            for (let i = 0; i < s.coordinates.length; i++)
                s.coordinates[i] += noise * rng.normal();
        }
        const graph = options.graph ? { k: options.graph.k, indices: Int32Array.from(options.graph.indices), distances: Float32Array.from(options.graph.distances) } : await buildNeighborGraph(s, this.manifest.numEdges, options.signal);
        if (graph.k !== Math.min(s.length, this.manifest.numEdges) || graph.indices.length !== s.length * graph.k || graph.distances.length !== s.length * graph.k)
            throw new Error('Precomputed graph has incompatible dimensions');
        for (let i = 0; i < graph.indices.length; i++)
            if (graph.indices[i] < 0 || graph.indices[i] >= s.length || !Number.isFinite(graph.distances[i]) || graph.distances[i] < 0)
                throw new Error('Invalid graph entry');
        for (let i = 0; i < s.length; i++)
            if (new Set(graph.indices.subarray(i * graph.k, (i + 1) * graph.k)).size !== graph.k)
                throw new Error('Duplicate neighbors in graph row');
        const encoded = await this.backend.encode(s, graph);
        checkAbort(options.signal);
        return new PreparedProtein(this, s, encoded);
    }
    async preparePDB(pdb, options = {}) { return this.prepare(parsePDB(pdb, { ...options, atomMode: this.manifest.atomMode }), options); }
    async dispose() { if (this.closed)
        return; this.closed = true; await this.backend.dispose(); }
}
export class PreparedProtein {
    model;
    structure;
    encoded;
    constructor(model, structure, encoded) {
        this.model = model;
        this.structure = structure;
        this.encoded = encoded;
    }
    check(signal) { this.model.assertOpen(); checkAbort(signal); }
    async scoreWithOrder(sequence, design, order, signal) {
        this.check(signal);
        const s = this.structure;
        const logits = await this.model.backend.full(this.encoded, s.mask, sequence, backwardMask(order, this.encoded.graph));
        this.check(signal);
        const logProbabilities = logSoftmax(logits), perResidue = new Float32Array(s.length).fill(NaN);
        let sum = 0, count = 0, globalSum = 0, globalCount = 0;
        for (let i = 0; i < s.length; i++)
            if (s.mask[i]) {
                const value = -logProbabilities[i * 21 + sequence[i]];
                perResidue[i] = value;
                globalSum += value;
                globalCount++;
                if (design[i]) {
                    sum += value;
                    count++;
                }
            }
        return { sequence: Array.from(sequence, a => ALPHABET[a]).join(''), score: count ? sum / count : null, globalScore: globalCount ? globalSum / globalCount : null, logProbabilities, perResidue, decodingOrder: order };
    }
    async score(sequence = this.structure.sequence, options = {}) {
        this.check(options.signal);
        const c = constraints(this.structure, options), rng = new Random(seedValue(options.seed));
        const order = Int32Array.from(decodingGroups(this.structure, c, options, rng).flat());
        const result = await this.scoreWithOrder(encodeSequence(sequence, this.structure.length), c.design, order, options.signal);
        options.onProgress?.({ phase: 'score', completed: 1, total: 1 });
        return result;
    }
    async sample(options = {}) {
        this.check(options.signal);
        const temperature = options.temperature ?? 0.1;
        if (!Number.isFinite(temperature) || temperature <= 0)
            throw new Error('temperature must be finite and > 0');
        const s = this.structure, n = s.length, h = this.model.manifest.hiddenDim, d = this.model.manifest.decoderLayers, k = this.encoded.graph.k;
        const seed = seedValue(options.seed), rng = new Random(seed), c = constraints(s, options);
        const groups = decodingGroups(s, c, options, rng), order = Int32Array.from(groups.flat()), bw = backwardMask(order, this.encoded.graph);
        const sequence = encodeSequence(s.sequence), native = Int32Array.from(sequence);
        const hidden = new Float32Array((d + 1) * n * h);
        hidden.set(this.encoded.nodes);
        const embeddings = new Float32Array(n * h), probabilities = new Float32Array(n * 21);
        const weights = new Map();
        for (const g of c.groups)
            g.positions.forEach((i, j) => weights.set(i, g.weights[j]));
        const input = { batchSize: 1, k, center: new Float32Array(h), neighborHidden: new Float32Array(d * k * h), neighborSequence: new Float32Array(k * h), neighborEncoder: new Float32Array(k * h), edges: new Float32Array(k * h), backward: new Float32Array(k), mask: new Float32Array(1) };
        let completed = 0;
        for (const group of groups) {
            this.check(options.signal);
            const aggregate = new Float64Array(21);
            for (const t of group) {
                if (!s.mask[t])
                    continue;
                input.center.set(this.encoded.nodes.subarray(t * h, (t + 1) * h));
                input.edges.set(this.encoded.edges.subarray(t * k * h, (t + 1) * k * h));
                input.backward.set(bw.subarray(t * k, (t + 1) * k));
                input.mask[0] = s.mask[t];
                for (let j = 0; j < k; j++) {
                    const neighbor = this.encoded.graph.indices[t * k + j];
                    input.neighborSequence.set(embeddings.subarray(neighbor * h, (neighbor + 1) * h), j * h);
                    input.neighborEncoder.set(this.encoded.nodes.subarray(neighbor * h, (neighbor + 1) * h), j * h);
                    for (let layer = 0; layer < d; layer++)
                        input.neighborHidden.set(hidden.subarray((layer * n + neighbor) * h, (layer * n + neighbor + 1) * h), (layer * k + j) * h);
                }
                const output = await this.model.backend.step(input);
                this.check(options.signal);
                for (let layer = 0; layer < d; layer++)
                    hidden.set(output.hidden.subarray(layer * h, (layer + 1) * h), ((layer + 1) * n + t) * h);
                for (let a = 0; a < 21; a++)
                    aggregate[a] += (weights.get(t) ?? 1) * output.logits[a] / group.length;
            }
            const fixed = group.find(t => !c.design[t]);
            let chosen;
            let p;
            if (fixed !== undefined) {
                chosen = native[fixed];
                if (group.some(t => c.design[t])) {
                    p = new Float64Array(21);
                    p[chosen] = 1;
                }
            }
            else {
                p = distribution(aggregate, group, temperature, c);
                chosen = rng.categorical(p);
            }
            for (const t of group) {
                sequence[t] = chosen;
                embeddings.set(this.model.backend.embedding.subarray(chosen * h, (chosen + 1) * h), t * h);
                if (p && c.design[t])
                    probabilities.set(p, t * 21);
            }
            completed += group.length;
            options.onProgress?.({ phase: 'sample', completed, total: n });
            if (completed % 8 === 0)
                await new Promise(resolve => setTimeout(resolve, 0));
        }
        const score = await this.scoreWithOrder(sequence, c.design, order, options.signal);
        let recovered = 0, count = 0;
        for (let i = 0; i < n; i++)
            if (c.design[i]) {
                count++;
                if (sequence[i] === native[i])
                    recovered++;
            }
        return { ...score, chains: splitChains(s, score.sequence), probabilities, designMask: c.design, sequenceRecovery: count ? recovered / count : null, temperature, seed };
    }
    async sampleMany(options = {}) {
        const results = [];
        for await (const result of this.sampleStream(options))
            results.push(result);
        return results;
    }
    async *sampleStream(options = {}) {
        this.check(options.signal);
        const count = options.numSequences ?? 1, batchSize = options.batchSize ?? 1;
        if (!Number.isInteger(count) || count < 1 || !Number.isInteger(batchSize) || batchSize < 1)
            throw new Error('numSequences and batchSize must be positive integers');
        const temperatures = options.temperatures ?? [options.temperature ?? 0.1];
        if (!temperatures.length || temperatures.some(t => !Number.isFinite(t) || t <= 0))
            throw new Error('temperatures must be nonempty and positive');
        const rng = new Random(seedValue(options.seed));
        const jobs = temperatures.flatMap(temperature => Array.from({ length: count }, () => ({ temperature, seed: Math.floor(rng.uniform() * 4294967296) })));
        for (let i = 0; i < jobs.length; i += batchSize) {
            this.check(options.signal);
            const settled = await Promise.allSettled(jobs.slice(i, i + batchSize).map(job => this.sample({ ...options, ...job })));
            const failure = settled.find(r => r.status === 'rejected');
            if (failure?.status === 'rejected')
                throw failure.reason;
            for (const item of settled)
                if (item.status === 'fulfilled')
                    yield item.value;
        }
    }
    async unconditionalProbabilities(options = {}) {
        this.check(options.signal);
        const s = this.structure;
        const logits = await this.model.backend.full(this.encoded, s.mask, encodeSequence(s.sequence), new Float32Array(s.length * this.encoded.graph.k));
        this.check(options.signal);
        const logProbabilities = logSoftmax(logits);
        return { logProbabilities, probabilities: Float32Array.from(logProbabilities, Math.exp), positions: Int32Array.from({ length: s.length }, (_, i) => i) };
    }
    async conditionalProbabilities(sequence = this.structure.sequence, options = {}) {
        this.check(options.signal);
        const s = this.structure, encodedSequence = encodeSequence(sequence, s.length);
        const positions = options.positions ? Int32Array.from(options.positions, p => resolveResidue(s, p)) : Int32Array.from(Array.from(s.mask, (v, i) => v ? i : -1).filter(i => i >= 0));
        if (new Set(positions).size !== positions.length)
            throw new Error('Duplicate conditional positions');
        const logProbabilities = new Float32Array(s.length * 21).fill(NaN);
        if (options.backboneOnly) {
            const all = await this.unconditionalProbabilities(options);
            for (const i of positions)
                logProbabilities.set(all.logProbabilities.subarray(i * 21, (i + 1) * 21), i * 21);
        }
        else {
            const rng = new Random(seedValue(options.seed));
            if (options.orderNoise && (options.orderNoise.length !== s.length || Array.from(options.orderNoise).some(v => !Number.isFinite(v))))
                throw new Error('orderNoise must contain N finite values');
            const noise = Array.from({ length: s.length }, (_, i) => Math.abs(options.orderNoise?.[i] ?? rng.normal()));
            for (let p = 0; p < positions.length; p++) {
                this.check(options.signal);
                const target = positions[p];
                const order = Int32Array.from(Array.from({ length: s.length }, (_, i) => i).sort((a, b) => noise[a] * (a === target ? 1.0001 : 0.0001) - noise[b] * (b === target ? 1.0001 : 0.0001) || a - b));
                const logits = await this.model.backend.full(this.encoded, s.mask, encodedSequence, backwardMask(order, this.encoded.graph));
                this.check(options.signal);
                logProbabilities.set(logSoftmax(logits.subarray(target * 21, (target + 1) * 21)), target * 21);
                options.onProgress?.({ phase: 'conditional', completed: p + 1, total: positions.length });
            }
        }
        return { logProbabilities, probabilities: Float32Array.from(logProbabilities, Math.exp), positions };
    }
}
//# sourceMappingURL=model.js.map