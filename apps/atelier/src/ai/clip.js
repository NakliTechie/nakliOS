// CLIP pieces for automatic keywording (L71) and find-similar (L64): the byte-level BPE tokenizer, image
// preprocessing, cosine ranking, zero-shot keyword scores and the embeddings file. Pure: node tests check
// each with small stand-ins; the model runs in src/ai/pixels-ort.js. Formulas are Atelier's own, following
// the published CLIP preprocessing (224 px, bicubic short-edge resize, centre crop, per-channel normalise).

// ---- tokenizer -------------------------------------------------------------------------------------

export const BOS = 49406; export const EOS = 49407; export const CONTEXT = 77;

// GPT-2 byte ↔ unicode table: printable bytes map to themselves, the rest to code points 256 and up.
export function byteEncoder() {
  const bs = []; for (let i = 33; i <= 126; i++) bs.push(i); for (let i = 161; i <= 172; i++) bs.push(i); for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = bs.slice(); let n = 0;
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n++); }
  const map = new Map(); bs.forEach((b, i) => map.set(b, String.fromCodePoint(cs[i])));
  return map;
}

const PAT = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/giu;

// vocab: { token: id } (vocab.json); merges: merges.txt text. Returns encode(text) → Int32 ids (BOS … EOS,
// padded with EOS to 77, the way the CLIP text model reads them: it pools at the first EOS).
export function clipTokenizer(vocab, mergesText) {
  const ranks = new Map();
  const lines = mergesText.split('\n').filter((l) => l && !l.startsWith('#version'));
  lines.forEach((l, i) => ranks.set(l, i));
  const be = byteEncoder(); const utf8 = new TextEncoder(); const cache = new Map();
  function bpe(token) {
    if (cache.has(token)) return cache.get(token);
    let word = [...token.slice(0, -1)].concat(`${[...token].at(-1)}</w>`);
    if (word.length === 1) { cache.set(token, word); return word; }
    for (;;) {
      let best = null; let bestRank = Infinity;
      for (let i = 0; i < word.length - 1; i++) { const r = ranks.get(`${word[i]} ${word[i + 1]}`); if (r !== undefined && r < bestRank) { bestRank = r; best = i; } }
      if (best === null) break;
      const [a, b] = [word[best], word[best + 1]]; const next = [];
      for (let i = 0; i < word.length;) {
        if (i < word.length - 1 && word[i] === a && word[i + 1] === b) { next.push(a + b); i += 2; } else { next.push(word[i]); i++; }
      }
      word = next; if (word.length === 1) break;
    }
    cache.set(token, word); return word;
  }
  return function encode(text) {
    const clean = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
    const ids = [BOS];
    for (const m of clean.matchAll(PAT)) {
      const t = [...utf8.encode(m[0])].map((b) => be.get(b)).join('');
      for (const piece of bpe(t)) { const id = vocab[piece]; if (id !== undefined) ids.push(id); }
    }
    ids.length = Math.min(ids.length, CONTEXT - 1); ids.push(EOS);
    const out = new Int32Array(CONTEXT).fill(EOS); out.set(ids);
    return out;
  };
}

// ---- image preprocessing ---------------------------------------------------------------------------

export const MEAN = [0.48145466, 0.4578275, 0.40821073]; export const STD = [0.26862954, 0.26130258, 0.27577711];

// RGBA u8 (w × h) → CHW float [3, 224, 224]: the short edge resized to 224 by bilinear sampling of an
// area-averaged (box) reduction, the centre 224 × 224 kept, each channel (v/255 − mean)/std. Transparent
// pixels count as their colour (the photo render is opaque).
export function clipPixels(px, w, h, S = 224) {
  const k = S / Math.min(w, h); const W = Math.max(S, Math.round(w * k)); const H = Math.max(S, Math.round(h * k));
  const x0 = Math.floor((W - S) / 2); const y0 = Math.floor((H - S) / 2);
  const out = new Float32Array(3 * S * S);
  const box = Math.max(1, Math.floor(1 / k));   // source pixels averaged per side when shrinking
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const sx = (i + x0 + 0.5) / k - 0.5; const sy = (j + y0 + 0.5) / k - 0.5;
    const cx = Math.min(w - 1, Math.max(0, Math.round(sx))); const cy = Math.min(h - 1, Math.max(0, Math.round(sy)));
    const s = [0, 0, 0]; let n = 0;
    const half = box >> 1;
    for (let dy = -half; dy < box - half; dy++) for (let dx = -half; dx < box - half; dx++) {
      const xx = Math.min(w - 1, Math.max(0, cx + dx)); const yy = Math.min(h - 1, Math.max(0, cy + dy));
      const q = (yy * w + xx) * 4; s[0] += px[q]; s[1] += px[q + 1]; s[2] += px[q + 2]; n++;
    }
    for (let c = 0; c < 3; c++) out[c * S * S + j * S + i] = (s[c] / n / 255 - MEAN[c]) / STD[c];
  }
  return out;
}

// ---- vectors ---------------------------------------------------------------------------------------

export function normalize(v) { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Float32Array.from(v, (x) => x / s); }
export function cosine(a, b) { let s = 0; let na = 0; let nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return s / (Math.sqrt(na * nb) || 1); }

// Ranks entries [{ path, v }] by cosine similarity to `query` (highest first), leaving out `exclude`.
export function rankSimilar(query, entries, { exclude = null, limit = 20 } = {}) {
  return entries.filter((e) => e.path !== exclude).map((e) => ({ path: e.path, score: cosine(query, e.v) })).sort((a, b) => b.score - a.score).slice(0, limit);
}

// Zero-shot keyword scores: p_k = softmax(100 · cos(image, text_k)) over the vocabulary (CLIP's learned
// logit scale is 100). A keyword is proposed when p_k ≥ minScore, best first, at most `count`.
export function zeroShot(image, texts, words, { count = 5, minScore = 0.05 } = {}) {
  const logits = texts.map((t) => 100 * cosine(image, t)); const mx = Math.max(...logits);
  const e = logits.map((l) => Math.exp(l - mx)); const z = e.reduce((a, b) => a + b, 0);
  return words.map((w, i) => ({ keyword: w, score: e[i] / z })).sort((a, b) => b.score - a.score).filter((x, i) => i < count && x.score >= minScore)
    .map((x) => ({ keyword: x.keyword, score: Math.round(x.score * 1000) / 1000 }));
}

// The keyword vocabulary (photography subjects and scenes) and the prompt each is scored with.
export const VOCABULARY = [
  'person', 'portrait', 'woman', 'man', 'child', 'baby', 'group of people', 'crowd', 'astronaut', 'cat', 'dog', 'bird', 'horse', 'cow', 'sheep', 'insect', 'butterfly', 'fish', 'wildlife',
  'flower', 'tree', 'forest', 'grass', 'leaves', 'garden', 'park', 'field', 'farm', 'mountain', 'hill', 'valley', 'desert', 'beach', 'sea', 'ocean', 'lake', 'river', 'waterfall', 'snow', 'ice', 'sky', 'clouds', 'sunset', 'sunrise', 'night', 'stars', 'moon', 'rain', 'fog',
  'city', 'street', 'building', 'architecture', 'house', 'interior', 'kitchen', 'bridge', 'road', 'car', 'motorcycle', 'bicycle', 'train', 'boat', 'aircraft', 'rocket', 'space', 'flag', 'sign',
  'food', 'coffee', 'drink', 'fruit', 'vegetables', 'dessert', 'restaurant', 'table', 'book', 'computer', 'phone', 'clock', 'toy', 'painting', 'sculpture', 'text',
  'sport', 'music', 'concert', 'wedding', 'festival', 'travel', 'smile', 'black and white', 'close-up', 'landscape', 'macro', 'abstract', 'pattern', 'texture', 'silhouette', 'reflection', 'shadow',
];
export const prompt = (w) => `a photo of ${/^(a|an|the)\b/.test(w) || /s$/.test(w) ? '' : /^[aeiou]/.test(w) ? 'an ' : 'a '}${w}`;

// ---- embeddings file -------------------------------------------------------------------------------

export const EMBED_FILE = 'library/embeddings-clip-b32.json';
const toB64 = (f) => { const u = new Uint8Array(f.buffer, f.byteOffset, f.byteLength); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (s) => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return new Float32Array(u.buffer); };

// { format, model, revision, photos: { path: { key, v: base64 float32 } } } ↔ text. key ties an entry to
// the photo's look (its sidecar's text hash); a changed key means the photo is embedded again.
export function readEmbeddings(text, model) {
  let j = null; try { j = JSON.parse(text); } catch { /* unreadable: start over */ }
  const out = new Map();
  if (j?.format === 'atelier-embeddings' && j.model === model.id && j.revision === model.revision) for (const [p, e] of Object.entries(j.photos || {})) out.set(p, { key: e.key, v: fromB64(e.v) });
  return out;
}
export function embeddingsText(map, model) {
  const photos = {}; for (const [p, e] of [...map].sort((a, b) => a[0].localeCompare(b[0]))) photos[p] = { key: e.key, v: toB64(e.v) };
  return `${JSON.stringify({ format: 'atelier-embeddings', model: model.id, revision: model.revision, note: 'CLIP image embeddings Atelier made on this device for keyword suggestions and find-similar; delete freely, they are rebuilt.', photos })}\n`;
}
// FNV-1a 32-bit of a string, as hex (the sidecar key).
export function hash32(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }
