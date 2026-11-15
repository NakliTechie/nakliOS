/*!
 * ane-embed.js — sentence embeddings on the Apple Neural Engine through WebNN, with the app's own CPU path as fallback.
 *
 * Canonical copy: https://naklios.dev/sdk/ane-embed.js (repo NakliTechie/nakliOS, sdk/ane-embed.js). Apps import it
 * from inside their embedding worker by that absolute URL; when the import or any check fails, the app keeps its
 * existing CPU (or WebGPU) path, so this module is removable. A breaking API change gets a new file name.
 *
 * Why: on an M4 Pro the Neural Engine embeds a short text in about 1.9 ms against about 22 ms for WASM q8
 * (LocalMind, plan/2026-10-29-webnn-embed), with the CPU and GPU left free. The gain matters when an app indexes
 * many chunks; a single query gains about 20 ms.
 *
 * Constraints, all measured in LocalMind on 2026-10-29:
 * - Only fp16 runs on the Neural Engine (q8 through WebNN falls to the CPU, 12x slower), so the fp16 copy
 *   downloads (all-MiniLM-L6-v2: 45 MB; bge-small-en-v1.5: 67 MB).
 * - WebNN needs fixed shapes: each text is padded to the shortest of LENGTHS that holds it (512 is the models'
 *   limit, the same cut the Transformers.js pipeline makes). One session per length, made on first use.
 * - Precision (all-MiniLM-L6-v2, Chrome 157, 8 texts, 2026-11-15): the Neural Engine's fp16 vectors match fp32
 *   WASM at cosine 1.0000, at both padding lengths. The browser's WASM q8, which apps ship, sits at 0.988 to 0.994
 *   from fp32. So the Neural Engine is the more accurate path, and an index may mix the two kinds of vector.
 * - Chrome 156 ships WebNN off (chrome://flags/#web-machine-learning-neural-network). Without it, the app's CPU
 *   path runs as before.
 *
 * Safety: at load the module embeds CHECK_TEXT and compares it with an fp32 CPU reference vector. Below
 * MIN_COSINE it refuses, so a driver that returns wrong numbers without an error never writes into an index.
 * Models without a reference vector are refused for the same reason. Pooling is mean over real tokens, then L2
 * norm, which is what every caller uses today.
 *
 * Use, inside a module worker:
 *   const transformers = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/+esm');
 *   const { createEmbedder } = await import(aneUrl);            // aneUrl from the page; null means off
 *   const embedder = await createEmbedder(transformers, 'Xenova/all-MiniLM-L6-v2', {
 *     loadCpu: async () => async (texts) => { ...the app's existing path, returns Float32Array[]... },
 *     onBackend: (backend, note) => self.postMessage({ type: 'backend', backend, note }),
 *   });
 *   const vectors = await embedder.embed(['a chunk', 'another chunk']);   // Float32Array[]
 *   embedder.backend;   // 'webnn-npu' or 'cpu'
 *   embedder.note;      // why the CPU runs, when the Neural Engine was tried and failed; '' otherwise
 */

export const ANE_EMBED_VERSION = 1;
export const DEFAULT_ANE_EMBED_URL = 'https://naklios.dev/sdk/ane-embed.js';

// Transformers.js 4.2.0's WebNN path fails with "WebNN backend does not support data type: int64", and the failed
// session leaves the same worker's WASM path failing with that error too (Chrome 157, 2026-11-15). 4.3.2 works, so
// older versions are refused before WebNN is touched, which keeps the CPU fallback intact.
export const MIN_TRANSFORMERS_VERSION = '4.3.2';

export function versionAtLeast(version, min) {
  const a = String(version || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const b = String(min).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}

export const LENGTHS = [128, 512];
export const MIN_COSINE = 0.995;
export const CHECK_TEXT = 'A short sentence to check the embedding model.';

// fp32 CPU embedding of CHECK_TEXT (mean pooling, L2 norm, 4 decimals), Transformers.js 4.3.2 in Node, 2026-11-15.
export const REFERENCES = {
  'Xenova/all-MiniLM-L6-v2': [0.0185,-0.0363,0.0478,0.0138,0.0863,0.111,0.0263,-0.0255,0.0149,-0.0487,0.0908,-0.0293,0.0418,0.0043,-0.0955,0.0217,0.0647,0.0006,-0.0902,-0.0286,-0.0235,-0.0073,0.0246,-0.0458,-0.0073,-0.0248,-0.0067,0.0615,0.0568,-0.0312,0.0473,0.0107,0.0402,0.1045,0.0296,0.0513,0.007,-0.0292,-0.0064,0.0343,0.0127,-0.0414,0.0148,0.0715,0.05,-0.0492,-0.0429,-0.042,-0.0944,0.0132,-0.0524,-0.0385,-0.0665,-0.0237,-0.0515,-0.0274,-0.0579,-0.0791,0.0141,-0.0193,0.0338,-0.0368,-0.0319,0.0715,0.1117,0.0034,-0.0778,0.0245,-0.0606,0.0771,-0.0308,0.0151,-0.1043,0.0041,-0.0659,-0.0371,0.0653,-0.0743,0.1335,-0.0881,0.0022,-0.0694,-0.0529,-0.0155,0.0961,-0.0063,0.0403,-0.1026,-0.039,-0.0182,0.0242,-0.0564,-0.0149,0.0766,0.0351,0.0186,-0.0035,-0.0161,0.0115,0.1077,-0.0321,0.0304,0.0873,0.0159,-0.033,-0.1069,-0.0103,0.0576,-0.051,-0.0826,-0.0569,-0.0173,-0.0145,0.0583,0.0108,-0.085,0.0422,0.0106,-0.0071,-0.0037,0.0265,0.0869,-0.0056,0.038,-0.0328,-0.0957,-0.0317,0,0.038,0.003,0.0217,0.0647,0.0317,0.033,-0.0639,0.1151,-0.0972,0.0332,-0.0628,0.0214,-0.0294,0.1199,0.0328,0.0087,-0.0376,0.0406,-0.011,0.0095,0.0103,-0.0037,-0.0327,-0.0626,-0.0974,-0.0157,0.0263,-0.0696,-0.1031,0.0282,-0.1083,-0.0295,-0.0063,-0.038,0.0487,-0.0268,0.0726,0.0198,-0.0261,-0.0691,-0.0019,-0.0183,-0.0048,-0.0536,-0.0383,0.0303,0.061,0.0184,-0.0146,0.0162,0.0505,0.0212,0.0009,-0.0408,0.0443,0.0037,-0.0319,0.0786,0.0489,-0.0094,-0.0147,0.0241,-0.0045,-0.015,0.0183,0.0423,-0.0851,-0.0619,0.1552,0.0318,-0.0398,0.0291,-0.0273,0.033,-0.0342,0.0174,-0.0681,-0.0592,-0.0145,0.0428,-0.049,-0.0689,-0.0229,-0.0352,-0.1031,-0.1197,0.0368,-0.1241,0.0286,0.0563,-0.0135,0.0102,-0.0331,-0.0262,0.0987,0,-0.0042,-0.0032,-0.013,0.0637,0.0316,-0.035,-0.038,0.1013,-0.0394,0.0611,0.0278,-0.0372,0.0639,-0.0557,0.0184,0.0132,-0.011,-0.0874,0.0297,0.1086,-0.0016,0.0611,-0.029,0.0542,0.0336,0.1273,-0.0037,-0.0252,-0.0621,-0.0145,-0.0141,-0.0621,-0.0657,0.0429,-0.0589,0.0359,0.0676,0.0125,-0.0018,-0.0062,0.0735,0.0497,-0.118,0.0514,0.008,-0.054,-0.0187,0.0092,0.0906,-0.0233,-0.0538,0.0018,-0.0116,0.0191,-0.0185,-0.0045,-0.0375,-0.0867,0.0376,0.0018,-0.0334,-0.0504,-0.0328,-0.0549,0.0558,-0.0889,-0.0337,0.0688,0.0486,-0.0041,0.038,0.0289,-0.0238,0.0188,0.0412,-0.0319,0.0312,0.0165,0.026,-0.0712,0.0211,-0.091,0.0396,0.0023,0.0134,0.001,0.0412,-0.0353,-0.0263,0.0207,0.004,0.0363,-0.0188,0.1115,0.0011,0,-0.0356,-0.0319,0.0348,-0.0215,-0.0005,-0.0238,0.0272,-0.0221,-0.0259,0.0168,0.0339,0.0124,-0.0655,0.0429,0.0007,0.0034,-0.0349,0.0427,-0.0137,0.0702,0.0454,0.102,0.0316,0.0432,-0.0323,-0.0173,-0.0453,0.0172,0.0224,0.0238,0.0494,0.1478,-0.0464,-0.022,-0.0495,0.115,0.0601,-0.0701,-0.0105,-0.0124,0.0365,0.0108,-0.0777,-0.0178,0.1383,0.0393,0.0645,-0.0635,0.0006,0.0181,0.0139,-0.0784,-0.0222,0.0046,-0.0662,-0.0099,-0.0015,0.0452,-0.0034,-0.0238,-0.0146,0.06,0.0333,-0.0159],
  'Xenova/bge-small-en-v1.5': [-0.0768,-0.0055,0.0191,0.0098,0.0162,0.0494,-0.0003,-0.0178,0.022,-0.0239,0.0104,-0.1014,0.0331,0.045,0.0367,0.009,0.0211,0.0424,-0.0125,-0.0087,0.0445,-0.0539,-0.0136,-0.0569,0.0038,0.0501,0.0295,-0.0108,-0.0136,-0.2389,-0.032,-0.0605,0.1094,0.0357,0.053,-0.0023,-0.0498,-0.0158,-0.0008,0.0178,0.0042,0.0207,-0.0371,-0.0327,0.0134,-0.0371,-0.0323,0.0051,-0.091,-0.0233,0.0266,-0.0257,-0.0094,0.036,0.0456,0.0406,0.0698,0.024,-0.0041,0.0323,0.0024,0.0814,-0.0961,0.016,0.0261,0.048,-0.0051,-0.041,0.0072,0.0664,0.0591,-0.0028,-0.026,0.0166,0.0075,0.0378,0.066,0.0371,0.0094,-0.0194,-0.0146,0.0008,0.0631,-0.0176,-0.028,-0.0278,0.0023,0.011,-0.0304,-0.0043,-0.033,0.0196,-0.007,0.0375,-0.0314,-0.0112,0.0437,0.0168,0.0138,0.118,-0.0227,-0.0134,0.1054,-0.0219,-0.0024,-0.0659,-0.0071,-0.0183,-0.0318,-0.0642,-0.0654,0.0025,0.0214,-0.0441,0.0012,-0.0102,0.0897,0.0288,-0.0145,-0.0281,-0.0482,0.0147,0.0435,-0.0558,0.0351,-0.0028,0.076,0.0895,0.0557,0.0746,-0.0173,-0.0269,-0.0256,-0.0043,-0.0245,0.0406,0.0073,0.0573,0.0288,-0.0135,-0.0647,-0.0228,0.0014,-0.0634,-0.0945,0.145,-0.0521,-0.0257,-0.0234,-0.0534,0.0091,0.0726,-0.0093,-0.0741,0.0252,0.024,0.0029,-0.007,-0.0809,0.0428,0.0374,-0.0247,-0.05,0.1063,-0.0047,0.0101,-0.0136,-0.0375,0.0541,-0.0776,0.0659,0.0489,-0.0368,0.0597,-0.0132,-0.0137,-0.0913,-0.0033,-0.0006,0.0154,0.0217,-0.049,-0.0611,0.0856,0.012,-0.0341,-0.007,-0.0812,0.0259,-0.0099,-0.017,-0.0105,-0.0323,0.0431,-0.0659,-0.0462,0.0181,-0.0123,-0.0276,-0.0192,0.0149,0.0638,0.0234,0.0007,-0.0687,-0.0005,0.0163,0.016,0.0331,0.0593,-0.0441,-0.0302,-0.0229,-0.033,0.0629,0.0207,0.0182,-0.004,0.0226,0.0261,-0.0414,-0.0398,0.0331,-0.26,-0.0601,0.0177,0.0337,-0.0085,-0.0787,0.0406,0.0201,0.0622,-0.001,0.0001,-0.02,-0.0328,-0.0128,0.008,0.058,-0.0001,-0.0162,-0.0812,0.0305,-0.0608,0.045,0.0016,-0.037,0.0325,-0.0468,0.1952,0.0426,0.0246,-0.0452,-0.0052,-0.0011,-0.0597,-0.0948,0.1301,-0.002,-0.0239,0.0485,0.0027,-0.0101,-0.0283,-0.0075,0.0047,-0.1125,-0.0267,-0.0231,-0.0142,-0.0169,-0.07,0.0676,0.0317,-0.0546,0.0257,0.063,-0.0569,-0.022,-0.0689,-0.067,-0.058,0.0325,0.0629,-0.0492,-0.0085,-0.0934,0.0442,-0.0277,-0.0309,-0.0601,0.0283,-0.0128,-0.0126,0.0888,-0.0176,0.0045,0.0454,-0.0071,0.027,0.0063,-0.0422,0.0014,0.0691,0.0176,0.0345,-0.0081,0.0583,0.0142,0.0514,-0.0225,0.0388,-0.0069,-0.0193,-0.0328,-0.01,-0.0046,0.01,-0.0452,-0.2441,0.0159,0.0261,0.0786,-0.0351,-0.0139,0.0363,-0.0087,-0.0333,-0.0433,0.0378,0.0382,0.097,-0.0402,-0.0284,0.0287,0.0734,-0.0886,0.062,-0.0923,-0.0135,0.0229,0.1889,-0.0646,0.0553,-0.008,0.0053,-0.0695,0.0593,-0.0005,0.0312,0.0337,0.1082,-0.005,0.0325,0.0527,0.0112,0.0087,0.0771,-0.0492,0.0853,-0.0465,-0.0885,0.0131,0.0144,0.0361,0.0716,0.0863,-0.0529,0.0184,0.0272,0.0025,0.0156,0.0038,0.0583,0.0416,-0.0427,-0.0102,0.0144,-0.0437,-0.0166,-0.0672,0.0397,0.0145,-0.0063],
};

export function webnnPresent() {
  return typeof navigator !== 'undefined' && 'ml' in navigator;
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na * nb) || 1);
}

// Mean over the positions whose attention mask is 1, then L2 norm. hidden: flat [len * dim]; mask: flat [len].
export function meanPoolNormalize(hidden, mask, len, dim) {
  const v = new Float32Array(dim);
  let n = 0;
  for (let t = 0; t < len; t++) {
    if (!Number(mask[t])) continue;
    n++;
    const row = t * dim;
    for (let d = 0; d < dim; d++) v[d] += Number(hidden[row + d]);
  }
  let s = 0;
  for (let d = 0; d < dim; d++) { v[d] /= n || 1; s += v[d] * v[d]; }
  s = Math.sqrt(s) || 1;
  for (let d = 0; d < dim; d++) v[d] /= s;
  return v;
}

export function pickLength(tokens, lengths = LENGTHS) {
  return lengths.find((l) => tokens <= l) ?? lengths[lengths.length - 1];
}

// The Neural Engine embedder alone. Throws (with a reason a person can read) when it cannot run correctly.
export async function loadNeuralEngineEmbedder(transformers, model, { progress } = {}) {
  if (!webnnPresent()) {
    throw new Error('WebNN is not available in this browser (in Chrome, turn on chrome://flags/#web-machine-learning-neural-network)');
  }
  const version = transformers.env?.version;
  if (!versionAtLeast(version, MIN_TRANSFORMERS_VERSION)) {
    throw new Error('Transformers.js ' + (version || '(unknown version)') + ' is older than ' + MIN_TRANSFORMERS_VERSION + ', whose WebNN path is the first that works');
  }
  const reference = REFERENCES[model];
  if (!reference) throw new Error('there is no reference vector for ' + model);
  const { AutoTokenizer, AutoModel } = transformers;
  const tokenizer = await AutoTokenizer.from_pretrained(model, { progress_callback: progress });
  const maxLength = LENGTHS[LENGTHS.length - 1];
  const sessions = {};
  const session = (len) => {
    sessions[len] ||= AutoModel.from_pretrained(model, {
      device: 'webnn-npu',
      dtype: 'fp16',
      session_options: { freeDimensionOverrides: { batch_size: 1, sequence_length: len } },
      progress_callback: progress,
    });
    return sessions[len];
  };
  async function embedOne(text) {
    const tokens = tokenizer(text, { truncation: true, max_length: maxLength }).input_ids.dims[1];
    const len = pickLength(tokens);
    const enc = tokenizer(text, { padding: 'max_length', truncation: true, max_length: len });
    const h = (await (await session(len))(enc)).last_hidden_state;
    return meanPoolNormalize(h.data, enc.attention_mask.data, len, h.dims[2]);
  }
  const check = cosine(await embedOne(CHECK_TEXT), reference);
  if (!(check >= MIN_COSINE)) {
    throw new Error('its check vector disagrees with the CPU reference (cosine ' + check.toFixed(4) + ')');
  }
  return {
    check,
    embed: async (texts) => {
      const out = [];
      for (const t of texts) out.push(await embedOne(String(t ?? '')));
      return out;
    },
  };
}

const short = (err) => String(err?.message || err).slice(0, 160);

// The Neural Engine when it loads and passes its check, else the app's CPU path. A Neural Engine run that fails
// later switches the rest of the session to the CPU path; onBackend(backend, note) reports each change.
export async function createEmbedder(transformers, model, { loadCpu, onBackend, progress, neuralEngine = true } = {}) {
  if (typeof loadCpu !== 'function') throw new Error('createEmbedder needs loadCpu');
  let npu = null, cpu = null;
  const state = { backend: 'cpu', note: '' };
  if (neuralEngine) {
    try {
      npu = await loadNeuralEngineEmbedder(transformers, model, { progress });
      state.backend = 'webnn-npu';
    } catch (err) {
      state.note = 'the Neural Engine path did not load: ' + short(err) + '.';
    }
  }
  if (!npu) cpu = await loadCpu();
  onBackend?.(state.backend, state.note);
  return {
    get backend() { return state.backend; },
    get note() { return state.note; },
    embed: async (texts) => {
      if (npu) {
        try { return await npu.embed(texts); }
        catch (err) {
          npu = null;
          state.backend = 'cpu';
          state.note = 'a Neural Engine run failed: ' + short(err) + '.';
          onBackend?.(state.backend, state.note);
        }
      }
      cpu ||= await loadCpu();
      return cpu(texts);
    },
  };
}
