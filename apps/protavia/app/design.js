// ProteinMPNN inference in the browser.
//
// The heavy lifting is proteinmpnn-web (vendored, built from a pinned upstream commit), which runs
// the ONNX bundles through ONNX Runtime Web. This file owns the policy around it: where the weights
// live, which backend to ask for, and how to score a design against the native sequence.
//
// Everything is served from this origin. No weights, structures or sequences leave the machine.

import { ProteinMPNN } from '../vendor/proteinmpnn-web/0.1.0-10849c13/index.js';
import { fromResidues } from '../vendor/proteinmpnn-web/0.1.0-10849c13/structure.js';

const MANIFEST = 'vendor/proteinmpnn/v_48_020/manifest.json';

// ONNX Runtime's WebAssembly binary is 25.93 MiB, over Cloudflare's 25 MiB per-file limit, so the
// NakliOS mirror of this app deliberately does not carry it and takes it from Protavia's own origin
// instead. Everywhere else — the standalone site and local development — it is same-origin and
// relative, so a local change is what gets tested.
//
// The test is the mirror's path, not its hostname. Keying on naklios.dev looked right and was
// wrong: the host is also served from 127.0.0.1 when it is checked locally, which would have sent
// that check to a relative path the mirror does not have.
const IN_MIRROR = location.pathname.includes('/apps/protavia/');
const ORT_ASSETS = IN_MIRROR
  ? 'https://protavia.naklitechie.com/vendor/onnxruntime-web/1.24.3/'
  : 'vendor/onnxruntime-web/1.24.3/';

/** Which checkpoint is loaded, for the interface to state plainly. */
export const MODEL_NAME = 'ProteinMPNN v_48_020';

let model = null;
let loading = null;
let backend = null;

/** 'webgpu' or 'wasm' once a model is loaded, else null. */
export function activeBackend() {
  return backend;
}

/**
 * Load the model once and keep it. About 9 MB of weights plus the runtime, so this is deliberately
 * deferred to the first redesign rather than paid on page load.
 *
 * @param {{preferred?: 'auto'|'wasm'|'webgpu', onProgress?: (text: string) => void}} options
 */
export function loadModel({ preferred = 'auto', onProgress } = {}) {
  if (model) return Promise.resolve(model);
  if (loading) return loading;

  const say = onProgress || (() => {});
  say(`Loading ${MODEL_NAME}…`);

  backend = preferred === 'auto' ? 'webgpu' : preferred;

  loading = ProteinMPNN.load(new URL(MANIFEST, document.baseURI).href, {
    backend: preferred,
    wasmPaths: new URL(ORT_ASSETS, document.baseURI).href,
    numThreads: 1,
    // The manifest carries SHA-256 for every weight file, so the runtime can confirm the bytes it
    // got are the bytes the conversion was published with.
    verifyIntegrity: true,
    onFallback: (reason) => {
      backend = 'wasm';
      say(`WebGPU unavailable, using WebAssembly: ${reason && reason.message ? reason.message : reason}`);
    },
  }).then((m) => {
    model = m;
    loading = null;
    return m;
  }).catch((e) => {
    loading = null;
    backend = null;
    throw e;
  });

  return loading;
}

/** Hand the loaded structure's backbone to the model. Returns a prepared protein. */
export async function prepare(residues) {
  if (!model) throw new Error('The model is not loaded.');
  return model.prepare(fromResidues(residues, { atomMode: 'backbone' }));
}

/**
 * Fraction of designed positions whose amino acid matches the native one. This is the standard
 * "sequence recovery" figure: the model is given only the backbone, so agreeing with the native
 * sequence is evidence it reads the fold, not evidence the design is good.
 *
 * Positions outside the designed chains are skipped, as are natives recorded as unknown (`X`).
 */
export function sequenceRecovery(native, designed, chainIds, designChains) {
  const only = designChains && designChains.length ? new Set(designChains) : null;
  let counted = 0;
  let same = 0;

  for (let i = 0; i < native.length && i < designed.length; i++) {
    if (only && !only.has(chainIds[i])) continue;
    if (native[i] === 'X') continue;
    counted++;
    if (native[i] === designed[i]) same++;
  }

  return counted === 0 ? null : { fraction: same / counted, matched: same, counted };
}

/**
 * Redesign one or more chains of a prepared protein.
 *
 * @param {object} protein from `prepare`
 * @param {{chains?: string[], temperature?: number, count?: number, seed?: number}} options
 * @returns {Promise<Array<{sequence: string, chainSequence: string, score: number|null,
 *                          recovery: {fraction: number, matched: number, counted: number}|null}>>}
 */
export async function redesign(protein, { chains, temperature = 0.1, count = 3, seed = 42 } = {}) {
  const designChains = chains && chains.length ? chains : undefined;

  const results = await protein.sampleMany({
    numSequences: count,
    temperatures: [temperature],
    seed,
    designChains,
  });

  const native = protein.structure.sequence;
  const chainIds = protein.structure.chainIds;

  return results.map((r) => ({
    sequence: r.sequence,
    // When one chain is designed, showing that chain alone is what the reader wants to compare.
    chainSequence: designChains && designChains.length === 1
      ? (r.chains[designChains[0]] || r.sequence)
      : r.sequence,
    score: r.score,
    recovery: sequenceRecovery(native, r.sequence, chainIds, designChains),
  }));
}

/** The native sequence of one chain, as the model sees it. */
export function nativeChainSequence(protein, chain) {
  const { sequence, chainIds } = protein.structure;
  let out = '';
  for (let i = 0; i < sequence.length; i++) {
    if (chainIds[i] === chain) out += sequence[i];
  }
  return out;
}

export async function dispose() {
  if (model) await model.dispose();
  model = null;
  backend = null;
}
