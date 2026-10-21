import { ALPHABET } from './types.js';
import { checkAbort } from './math.js';
export const MODEL_CATALOG = Object.freeze({
    proteinmpnn: Object.freeze(['v_48_002', 'v_48_010', 'v_48_020', 'v_48_030']),
    solublempnn: Object.freeze(['v_48_010', 'v_48_020']),
    ca: Object.freeze(['v_48_002', 'v_48_010', 'v_48_020']),
});
export const MODEL_HUB_REPOSITORY = 'MurrellLab/webports';
export const MODEL_HUB_REVISION = 'b02389db87d2b94709f980911294287fb87b8736';
export const MODEL_HUB_BASE_URL = `https://huggingface.co/${MODEL_HUB_REPOSITORY}/resolve/${MODEL_HUB_REVISION}/webProteinMPNN/models/`;
export function modelManifestURL(family, modelName) {
    const models = MODEL_CATALOG[family];
    if (!models)
        throw new Error(`Unknown ProteinMPNN model family: ${family}`);
    if (!models.includes(modelName))
        throw new Error(`Unknown ${family} model: ${modelName}`);
    return new URL(`${family}/${modelName}/manifest.json`, MODEL_HUB_BASE_URL).href;
}
export function validateManifest(value) {
    const m = value;
    if (!m || m.format !== 'proteinmpnn-onnx' || m.version !== 1 || m.alphabet !== ALPHABET)
        throw new Error('Incompatible ProteinMPNN model manifest');
    if (!['proteinmpnn', 'solublempnn', 'ca'].includes(m.family) || !['backbone', 'ca'].includes(m.atomMode) || (m.family === 'ca') !== (m.atomMode === 'ca'))
        throw new Error('Invalid model family/atom mode');
    for (const k of ['hiddenDim', 'decoderLayers', 'numEdges'])
        if (!Number.isInteger(m[k]) || m[k] < 1)
            throw new Error(`Invalid manifest ${k}`);
    for (const k of ['encoder', 'decoderStep', 'decoderFull', 'embedding'])
        if (typeof m.files?.[k] !== 'string' || !m.files[k])
            throw new Error(`Missing model file ${k}`);
    if (!m.sha256 || typeof m.sha256 !== 'object')
        throw new Error('Missing model integrity hashes');
}
async function verify(bytes, expected, file) {
    if (!expected || !/^[0-9a-f]{64}$/.test(expected))
        throw new Error(`Missing SHA-256 for ${file}`);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
    const actual = Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, '0')).join('');
    if (actual !== expected)
        throw new Error(`SHA-256 mismatch for ${file}`);
}
async function readAssets(source, options) {
    const fetcher = options.fetch ?? globalThis.fetch;
    const base = typeof location !== 'undefined' ? location.href : undefined;
    const manifestURL = new URL(source.toString(), base);
    checkAbort(options.signal);
    const response = await fetcher(manifestURL, { signal: options.signal });
    if (!response.ok)
        throw new Error(`Model manifest HTTP ${response.status}`);
    const manifest = await response.json();
    validateManifest(manifest);
    const keys = ['encoder', 'decoderStep', 'decoderFull', 'embedding'];
    const buffers = await Promise.all(keys.map(async (key) => {
        const url = new URL(manifest.files[key], manifestURL);
        const r = await fetcher(url, { signal: options.signal });
        if (!r.ok)
            throw new Error(`Model ${key} HTTP ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
    }));
    return { manifest, encoder: buffers[0], decoderStep: buffers[1], decoderFull: buffers[2], embedding: buffers[3] };
}
export class OnnxBackend {
    manifest;
    ort;
    sessions;
    provider;
    embedding;
    closed = false;
    tail = Promise.resolve();
    constructor(manifest, ort, sessions, embedding, provider) {
        this.manifest = manifest;
        this.ort = ort;
        this.sessions = sessions;
        this.provider = provider;
        this.embedding = new Float32Array(21 * manifest.hiddenDim);
        const view = new DataView(embedding.buffer, embedding.byteOffset, embedding.byteLength);
        for (let i = 0; i < this.embedding.length; i++) {
            const v = view.getFloat32(i * 4, true);
            if (!Number.isFinite(v))
                throw new Error('Nonfinite sequence embedding');
            this.embedding[i] = v;
        }
    }
    static async create(source, options = {}) {
        const assets = typeof source === 'string' || source instanceof URL ? await readAssets(source, options) : source;
        validateManifest(assets.manifest);
        const m = assets.manifest;
        if (assets.embedding.byteLength !== 21 * m.hiddenDim * 4)
            throw new Error('Invalid sequence embedding size');
        if (options.verifyIntegrity !== false)
            await Promise.all(['encoder', 'decoderStep', 'decoderFull', 'embedding'].map(k => verify(assets[k], m.sha256[m.files[k]], m.files[k])));
        const requested = options.backend ?? 'auto';
        if (!['auto', 'wasm', 'webgpu'].includes(requested))
            throw new Error('Invalid backend');
        const gpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
        let provider = requested === 'wasm' ? 'wasm' : requested === 'webgpu' || gpu ? 'webgpu' : 'wasm';
        const ort = provider === 'webgpu' ? await import('onnxruntime-web/webgpu') : await import('onnxruntime-web');
        if (options.numThreads !== undefined) {
            if (!Number.isInteger(options.numThreads) || options.numThreads < 1)
                throw new Error('numThreads must be positive');
            ort.env.wasm.numThreads = options.numThreads;
        }
        else if (!ort.env.wasm.numThreads)
            ort.env.wasm.numThreads = 1;
        if (options.wasmPaths !== undefined)
            ort.env.wasm.wasmPaths = options.wasmPaths;
        const create = async (ep) => {
            const created = [];
            try {
                for (const bytes of [assets.encoder, assets.decoderStep, assets.decoderFull]) {
                    checkAbort(options.signal);
                    created.push(await ort.InferenceSession.create(bytes, { ...options.sessionOptions, executionProviders: ep === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'] }));
                }
                checkAbort(options.signal);
                return { encoder: created[0], step: created[1], full: created[2] };
            }
            catch (error) {
                await Promise.allSettled(created.map(s => s.release()));
                throw error;
            }
        };
        let sessions;
        try {
            sessions = await create(provider);
        }
        catch (error) {
            checkAbort(options.signal);
            if (requested !== 'auto' || provider !== 'webgpu')
                throw error;
            options.onFallback?.(error);
            provider = 'wasm';
            sessions = await create('wasm');
        }
        try {
            return new OnnxBackend(m, ort, sessions, assets.embedding, provider);
        }
        catch (error) {
            await Promise.allSettled(Object.values(sessions).map(s => s.release()));
            throw error;
        }
    }
    f(data, dims) { return new this.ort.Tensor('float32', data, dims); }
    i(data, dims) { return new this.ort.Tensor('int64', BigInt64Array.from(data, v => BigInt(v)), dims); }
    async run(session, feeds) {
        if (this.closed) {
            Object.values(feeds).forEach(t => t.dispose());
            throw new Error('Model is disposed');
        }
        const task = this.tail.then(async () => {
            let output;
            try {
                output = await session.run(feeds);
                const result = {};
                for (const [key, tensor] of Object.entries(output)) {
                    const data = await tensor.getData();
                    if (!(data instanceof Float32Array))
                        throw new Error(`Unexpected output type for ${key}`);
                    result[key] = Float32Array.from(data);
                }
                return result;
            }
            finally {
                Object.values(feeds).forEach(t => t.dispose());
                if (output)
                    Object.values(output).forEach(t => t.dispose());
            }
        });
        this.tail = task.catch(() => { });
        return task;
    }
    async encode(s, graph) {
        const n = s.length, k = graph.k;
        const result = await this.run(this.sessions.encoder, {
            coordinates: this.f(s.coordinates, s.atomMode === 'ca' ? [1, n, 3] : [1, n, 4, 3]), mask: this.f(s.mask, [1, n]),
            residue_idx: this.i(s.residueIndices, [1, n]), chains: this.i(s.chainEncoding, [1, n]),
            neighbors: this.i(graph.indices, [1, n, k]), distances: this.f(graph.distances, [1, n, k]),
        });
        return { nodes: result.nodes, edges: result.edges, graph };
    }
    async step(input) {
        const b = input.batchSize, k = input.k, h = this.manifest.hiddenDim, d = this.manifest.decoderLayers;
        const r = await this.run(this.sessions.step, {
            center: this.f(input.center, [b, h]), neighbor_hidden: this.f(input.neighborHidden, [d, b, k, h]),
            neighbor_sequence: this.f(input.neighborSequence, [b, k, h]), neighbor_encoder: this.f(input.neighborEncoder, [b, k, h]),
            edges: this.f(input.edges, [b, k, h]), backward: this.f(input.backward, [b, k]), mask: this.f(input.mask, [b]),
        });
        return { logits: r.logits, hidden: r.hidden };
    }
    async full(e, mask, sequence, backward) {
        const n = mask.length, k = e.graph.k, h = this.manifest.hiddenDim;
        return (await this.run(this.sessions.full, {
            nodes: this.f(e.nodes, [n, h]), edges: this.f(e.edges, [n, k, h]), neighbors: this.i(e.graph.indices, [n, k]),
            mask: this.f(mask, [n]), sequence: this.i(sequence, [n]), backward: this.f(backward, [n, k]),
        })).logits;
    }
    async dispose() { if (this.closed)
        return; this.closed = true; await this.tail; await Promise.all(Object.values(this.sessions).map(s => s.release())); }
}
//# sourceMappingURL=onnx.js.map