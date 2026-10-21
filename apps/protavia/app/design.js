// ProteinMPNN inference in the browser.
//
// The heavy lifting is proteinmpnn-web (vendored, built from a pinned upstream commit), which runs
// the ONNX bundles through ONNX Runtime Web. This file owns the policy around it: which checkpoints
// exist, where their weights live, which backend to ask for, and how to score a design against the
// native sequence.
//
// Everything is served from this origin. No weights, structures or sequences leave the machine.

import { ProteinMPNN } from '../vendor/proteinmpnn-web/0.1.0-10849c13/index.js';
import { fromResidues } from '../vendor/proteinmpnn-web/0.1.0-10849c13/structure.js';

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

/**
 * The checkpoints this app can run, chosen so that comparing them teaches something rather than
 * just filling a table. All three are the same architecture trained differently, so a difference in
 * their answers is a difference in what they were taught, not in how they work.
 *
 * `short` is the name in the ranking table, where a 19rem panel has no room for the full label.
 * `note` is shown in the interface. Nine checkpoints exist in the bundle these came from; add one
 * here with its weights and hashes recorded in `vendor/README.md`.
 */
export const MODELS = [
  {
    id: 'v_48_020',
    label: 'ProteinMPNN v_48_020',
    short: 'MPNN 020',
    manifest: 'vendor/proteinmpnn/v_48_020/manifest.json',
    note: 'The default. Trained with 0.20 Å of noise added to the backbone, which makes it tolerant '
      + 'of imperfect or predicted structures.',
  },
  {
    id: 'v_48_002',
    label: 'ProteinMPNN v_48_002',
    short: 'MPNN 002',
    manifest: 'vendor/proteinmpnn/v_48_002/manifest.json',
    note: 'The same model trained with almost no backbone noise, 0.02 Å. Sharper on an accurate '
      + 'structure, less forgiving of a rough one.',
  },
  {
    id: 'soluble_v_48_020',
    label: 'solubleMPNN v_48_020',
    short: 'soluble 020',
    manifest: 'vendor/solublempnn/v_48_020/manifest.json',
    note: 'Same noise as the default, but trained without membrane proteins, so it avoids designing '
      + 'the greasy surfaces that make a protein aggregate.',
  },
];

export function modelById(id) {
  return MODELS.find((m) => m.id === id) || null;
}

/** Loaded models, and loads in flight, both keyed by checkpoint id. */
const loaded = new Map();
const loading = new Map();

let backend = null;

/** 'webgpu' or 'wasm' once anything is loaded, else null. */
export function activeBackend() {
  return backend;
}

export function isLoaded(id) {
  return loaded.has(id);
}

/**
 * Load one checkpoint and keep it. About 9 MB of weights each, plus the runtime once, so this is
 * deferred to the first run that needs it rather than paid on page load.
 *
 * @param {string} id a `MODELS` id
 * @param {{preferred?: 'auto'|'wasm'|'webgpu', onProgress?: (text: string) => void}} options
 */
export function loadModel(id, { preferred = 'auto', onProgress } = {}) {
  if (loaded.has(id)) return Promise.resolve(loaded.get(id));
  if (loading.has(id)) return loading.get(id);

  const spec = modelById(id);
  if (!spec) return Promise.reject(new Error(`No checkpoint called "${id}".`));

  const say = onProgress || (() => {});
  say(`Loading ${spec.label}…`);

  // The runtime picks its backend once, on the first load; later models join whatever it chose.
  if (backend === null) backend = preferred === 'auto' ? 'webgpu' : preferred;

  const task = ProteinMPNN.load(new URL(spec.manifest, document.baseURI).href, {
    backend: preferred,
    wasmPaths: new URL(ORT_ASSETS, document.baseURI).href,
    numThreads: 1,
    // Each manifest carries SHA-256 for its four weight files, so the runtime can confirm the bytes
    // it got are the bytes the conversion was published with.
    verifyIntegrity: true,
    onFallback: (reason) => {
      backend = 'wasm';
      say(`WebGPU unavailable, using WebAssembly: ${reason && reason.message ? reason.message : reason}`);
    },
  }).then((m) => {
    loaded.set(id, m);
    loading.delete(id);
    return m;
  }).catch((e) => {
    loading.delete(id);
    if (loaded.size === 0) backend = null;
    throw e;
  });

  loading.set(id, task);
  return task;
}

/**
 * Hand a backbone to one checkpoint. Each one encodes the structure itself, so a prepared protein
 * belongs to the model that prepared it and cannot be shared.
 */
export async function prepare(residues, id) {
  const model = loaded.get(id);
  if (!model) throw new Error(`${id} is not loaded.`);
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
  for (const model of loaded.values()) await model.dispose();
  loaded.clear();
  loading.clear();
  backend = null;
}
