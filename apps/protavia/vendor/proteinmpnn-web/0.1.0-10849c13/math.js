export function checkAbort(signal) { signal?.throwIfAborted(); }
export function seedValue(seed) {
    if (seed !== undefined) {
        if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
            throw new Error('seed must be a uint32');
        return seed;
    }
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    return value[0];
}
/** Local PRNG; never mutates global Math.random. seed=0 is deterministic. */
export class Random {
    state;
    constructor(seed) { this.state = seed >>> 0; }
    uniform() {
        let t = this.state = (this.state + 0x6D2B79F5) >>> 0;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    normal() { return Math.sqrt(-2 * Math.log(Math.max(this.uniform(), 1e-12))) * Math.cos(2 * Math.PI * this.uniform()); }
    categorical(p) { const r = this.uniform(); let total = 0, last = 0; for (let i = 0; i < p.length; i++) {
        total += p[i];
        if (p[i] > 0)
            last = i;
        if (r < total)
            return i;
    } return last; }
}
export function logSoftmax(logits) {
    const out = new Float32Array(logits.length);
    for (let offset = 0; offset < logits.length; offset += 21) {
        let max = -Infinity;
        for (let a = 0; a < 21; a++) {
            const v = logits[offset + a];
            if (!Number.isFinite(v))
                throw new Error('Model produced nonfinite logits');
            max = Math.max(max, v);
        }
        let sum = 0;
        for (let a = 0; a < 21; a++)
            sum += Math.exp(logits[offset + a] - max);
        const norm = max + Math.log(sum);
        for (let a = 0; a < 21; a++)
            out[offset + a] = logits[offset + a] - norm;
    }
    return out;
}
export function normalize(values, context) {
    let sum = 0;
    for (const v of values) {
        if (!Number.isFinite(v) || v < 0)
            throw new Error(`Invalid probability at ${context}`);
        sum += v;
    }
    if (!(sum > 0))
        throw new Error(`No amino acid remains allowed at ${context}`);
    for (let i = 0; i < values.length; i++)
        values[i] /= sum;
    return values;
}
/** Exact all-pairs CA search; O(N² log K) work, O(NK + N) memory, includes self.
 * Masked distances follow upstream D + (1-mask_i*mask_j)*D_max.
 * Ties use residue index; upstream torch.topk does not define a tie order.
 */
export async function buildNeighborGraph(s, numEdges, signal) {
    const n = s.length, k = Math.min(n, numEdges);
    if (!Number.isInteger(k) || k < 1)
        throw new Error('numEdges must be positive');
    const indices = new Int32Array(n * k), distances = new Float32Array(n * k);
    const stride = s.atomMode === 'ca' ? 3 : 12, ca = s.atomMode === 'ca' ? 0 : 3;
    const row = new Float32Array(n);
    const heap = [];
    const worse = (a, b) => row[a] > row[b] || (row[a] === row[b] && a > b);
    for (let i = 0; i < n; i++) {
        checkAbort(signal);
        const p = i * stride + ca;
        let max = 0;
        for (let j = 0; j < n; j++) {
            const q = j * stride + ca;
            const dx = Math.fround(s.coordinates[p] - s.coordinates[q]), dy = Math.fround(s.coordinates[p + 1] - s.coordinates[q + 1]), dz = Math.fround(s.coordinates[p + 2] - s.coordinates[q + 2]);
            const sq = Math.fround(Math.fround(Math.fround(dx * dx) + Math.fround(dy * dy)) + Math.fround(dz * dz));
            row[j] = s.mask[i] * s.mask[j] * Math.sqrt(Math.fround(sq + 1e-6));
            max = Math.max(max, row[j]);
        }
        heap.length = 0;
        for (let j = 0; j < n; j++) {
            row[j] += (1 - s.mask[i] * s.mask[j]) * max;
            if (heap.length < k) {
                heap.push(j);
                let x = heap.length - 1;
                while (x > 0) {
                    const parent = (x - 1) >> 1;
                    if (!worse(heap[x], heap[parent]))
                        break;
                    [heap[x], heap[parent]] = [heap[parent], heap[x]];
                    x = parent;
                }
            }
            else if (worse(heap[0], j)) {
                heap[0] = j;
                let x = 0;
                while (true) {
                    let child = x * 2 + 1;
                    if (child >= k)
                        break;
                    if (child + 1 < k && worse(heap[child + 1], heap[child]))
                        child++;
                    if (!worse(heap[child], heap[x]))
                        break;
                    [heap[child], heap[x]] = [heap[x], heap[child]];
                    x = child;
                }
            }
        }
        heap.sort((a, b) => row[a] - row[b] || a - b);
        for (let j = 0; j < k; j++) {
            indices[i * k + j] = heap[j];
            distances[i * k + j] = row[heap[j]];
        }
        if (i % 32 === 31)
            await new Promise(resolve => setTimeout(resolve, 0));
    }
    return { indices, distances, k };
}
export function backwardMask(order, graph) {
    const rank = new Int32Array(order.length);
    for (let i = 0; i < order.length; i++)
        rank[order[i]] = i;
    const result = new Float32Array(graph.indices.length);
    for (let i = 0; i < order.length; i++)
        for (let j = 0; j < graph.k; j++)
            result[i * graph.k + j] = Number(rank[graph.indices[i * graph.k + j]] < rank[i]);
    return result;
}
//# sourceMappingURL=math.js.map