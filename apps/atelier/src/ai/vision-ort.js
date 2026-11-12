// Runs the CLIP and face graphs (src/ai/models-pixels.js) through src/ai/pixels-ort.js. Image in, vectors
// or points out; the maths around them is in src/ai/clip.js and src/ai/faces.js.

import { runGraph, graphInputs, modelFile, pixelModelStatus } from './pixels-ort.js';
import { clipTokenizer, clipPixels, normalize, CONTEXT } from './clip.js';
import * as F from './faces.js';

export const status = pixelModelStatus;

const CLIP = 'clip-b32'; const VISION = 'onnx/vision_model_quantized.onnx'; const TEXT = 'onnx/text_model_quantized.onnx';
let tokP = null;
const tokenizer = () => (tokP ??= Promise.all([modelFile(CLIP, 'vocab.json'), modelFile(CLIP, 'merges.txt')]).then(([v, m]) => clipTokenizer(JSON.parse(new TextDecoder().decode(v)), new TextDecoder().decode(m))));

const pick = (out, ...names) => { for (const n of names) if (out[n]) return out[n]; return Object.values(out)[0]; };

// RGBA u8 → unit-length 512-d image embedding.
export async function embedImage(px, w, h) {
  const { inputs } = await graphInputs(CLIP, VISION);
  const out = await runGraph(CLIP, VISION, { [inputs[0]]: { data: clipPixels(px, w, h), dims: [1, 3, 224, 224] } });
  return normalize(pick(out, 'image_embeds').data);
}

// Text → unit-length 512-d text embedding.
export async function embedText(text) {
  const ids = (await tokenizer())(text);
  const { inputs } = await graphInputs(CLIP, TEXT);
  const feeds = { input_ids: { type: 'int64', data: BigInt64Array.from(ids, BigInt), dims: [1, CONTEXT] } };
  if (inputs.includes('attention_mask')) feeds.attention_mask = { type: 'int64', data: BigInt64Array.from(ids, () => 1n), dims: [1, CONTEXT] };
  const out = await runGraph(CLIP, TEXT, feeds);
  return normalize(pick(out, 'text_embeds').data);
}
export async function tokenize(text) { return Array.from((await tokenizer())(text)); }

// ---- faces -----------------------------------------------------------------------------------------

const FACE = 'mediapipe-face'; const DET = 'float/face_detector.onnx'; const MESH = 'face_landmarks_detector.onnx'; const BLEND = 'face_blendshapes.onnx';

// RGBA u8 → faces [{ box: [x0, y0, x1, y1], score, keypoints: [[x, y] × 6], mesh: [[x, y, z] × 478], meshScore,
// blink: { left, right } }] in image pixels. The detector sees the image letterboxed into 256 × 256; each face
// is then cropped square around its box (×1.5), rotated upright by its eye line, resized to 256 × 256 for Face
// Mesh V2, and cropped again from that mesh (MediaPipe's own re-crop), which tightens the eyes and mouth. A face
// is kept when the mesh's presence score is at least minMesh. The blink scores come from Blendshape V2.
export async function detectFaces(px, w, h, { minScore = 0.6, minMesh = 0.5 } = {}) {
  const { input, map } = F.letterbox(px, w, h, 256);
  const out = await runGraph(FACE, DET, { image: { data: input, dims: [1, 3, 256, 256] } });
  const coords = [out.box_coords_1.data, out.box_coords_2.data]; const scores = [out.box_scores_1.data, out.box_scores_2.data];
  const dets = F.decodeBlazeFace(coords, scores, { minScore }).map((d) => F.unletterbox(d, map));
  const { inputs, outputs } = await graphInputs(FACE, MESH); const S = 256;
  const meshOf = async (crop) => {
    const m = await runGraph(FACE, MESH, { [inputs[0]]: { data: F.warpCrop(px, w, h, crop, S, 'nhwc'), dims: [1, S, S, 3] } });
    return { mesh: F.meshToImage(m[outputs[0]].data, crop, S), score: F.prob(m[outputs[1]].data[0]) };
  };
  const b = await graphInputs(FACE, BLEND);
  const faces = [];
  for (const d of dets) {
    const c0 = F.faceCrop(d, 1.5);
    let r = await meshOf(c0);
    if (r.score < minMesh) r = await meshOf({ ...c0, angle: 0 });   // the detector's eye keypoints can mislead on a half-hidden face
    if (r.score < minMesh) continue;   // the mesh's own face-presence score drops non-faces
    r = await meshOf(F.meshCrop(r.mesh));
    const bs = (await runGraph(FACE, BLEND, { [b.inputs[0]]: { data: F.blendInput(r.mesh), dims: [1, F.BLEND_POINTS.length, 2] } }))[b.outputs[0]].data;
    faces.push({ ...d, mesh: r.mesh, meshScore: r.score, blink: { left: bs[F.BLINK.left], right: bs[F.BLINK.right] } });
  }
  return faces;
}

const SFACE = 'sface'; const SF = 'face_recognition_sface_2021dec.onnx';
// One face (its mesh) → unit-length 128-d identity embedding: the face aligned to the 112 × 112 template.
export async function embedFace(px, w, h, mesh) {
  const t = F.alignFace(px, w, h, mesh);
  const { inputs } = await graphInputs(SFACE, SF);
  const out = await runGraph(SFACE, SF, { [inputs[0]]: { data: t, dims: [1, 3, 112, 112] } });
  return normalize(Object.values(out)[0].data);
}

// ---- portrait: person parsing, colourize, style -----------------------------------------------------

const PARSE = 'mediapipe-multiclass'; const PARSE_G = 'onnx/model.onnx';
// RGBA u8 → { logits: Float32Array NHWC [S, S, 6], size: S } from the selfie multiclass model (stretched input).
export async function parsePerson(px, w, h) {
  const P = await import('./portrait.js');
  const { inputs, outputs } = await graphInputs(PARSE, PARSE_G);
  const out = await runGraph(PARSE, PARSE_G, { [inputs[0]]: { data: P.parsingInput(px, w, h), dims: [1, P.PARSE_SIZE, P.PARSE_SIZE, 3] } });
  const o = out[outputs[0]];
  return { logits: o.data, size: o.dims[1], classes: o.dims[3] };
}

const COLOUR = 'ddcolor-tiny'; const COLOUR_G = 'ddcolor-tiny-fp16.onnx';
// RGBA u8 → predicted CIELAB a, b planes CHW [2, 512, 512].
export async function colourize(px, w, h) {
  const P = await import('./portrait.js'); const S = P.COLOURIZE_SIZE;
  const { inputs, outputs } = await graphInputs(COLOUR, COLOUR_G);
  const out = await runGraph(COLOUR, COLOUR_G, { [inputs[0]]: { data: P.colourizeInput(px, w, h, S), dims: [1, 3, S, S] } });
  return { ab: out[outputs[0]].data, size: S };
}

// RGBA u8 (already at the working size) → HWC float 0..1, styled by a fast-neural-style model (fixed 224 × 224
// graph, so tiled with a wide overlap and blended).
export async function stylize(id, px, w, h, onTile) {
  const P = await import('./portrait.js'); const X = await import('./pixels.js');
  const m = (await import('./models-pixels.js')).pixelModel(id); const g = m.files[0].path;
  const { inputs, outputs } = await graphInputs(id, g);
  const T = 224;
  const r = await X.tileInfer(X.rgbaReader(px, w, h), { tile: T, overlap: 96, multiple: T, outC: 3, onTile,
    run: async (t, tw, th) => P.styleTileOut((await runGraph(id, g, { [inputs[0]]: { data: P.styleTileIn(t, tw, th), dims: [1, 3, th, tw] } }))[outputs[0]].data, tw, th) });
  return r.data;
}
