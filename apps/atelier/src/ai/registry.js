// The on-device model registry (spec 002 §9.4). Every model is optional: off until the person downloads it
// (one clearly named download per model, through the person-only `download_model` tool or its UI button),
// and the app works fully without it. A model ships only under a permissive licence; each entry names the
// licence as SPDX, the page that states it, and the pinned Hugging Face commit the runtime loads.
//
// Entry shape (src/ai/models-pixels.js follows it too):
//   { id, label, task, repo, revision, licence, licenceUrl, bytes, dtype, device }
//   label   the one download name the person sees; bytes the approximate download size.
//   task    what the worker runs: 'semantic' | 'salient' | 'point-mask' | 'depth' | 'matting' (pixel models add theirs).
//   device  'webgpu' or 'wasm' (the worker falls back to wasm when WebGPU is absent).
//   file    the ONNX graph's path in the repo when it is not transformers.js's onnx/model<dtype suffix>.onnx.
// Licences checked on huggingface.co on 2026-11-12 (model card tag and the upstream card):
//   DETR panoptic: facebook/detr-resnet-50-panoptic, Apache-2.0; the Xenova ONNX export carries no tag of its
//     own and names the facebook model as its base, so the base licence applies.
//   SlimSAM: Xenova/slimsam-77-uniform, Apache-2.0.
//   Depth Anything V2 Small: depth-anything/Depth-Anything-V2-Small-hf, Apache-2.0; ONNX export
//     onnx-community/depth-anything-v2-small, Apache-2.0. (The Base and Large variants are CC-BY-NC: never used.)
//   IS-Net general use: weights from the authors' repo github.com/xuebinqin/DIS (Apache-2.0, LICENSE.md); ONNX
//     export x-Liola-x/isnet-general-use-onnx, tagged Apache-2.0, whose card names the official repo as the source.
//     (onnx-community/ISNet-ONNX repackages it under AGPL-3.0: never used.)
//   ViTMatte small: hustvl/vitmatte-small-composition-1k, Apache-2.0 (code MIT, github.com/hustvl/ViTMatte); ONNX
//     export Xenova/vitmatte-small-composition-1k, which names the hustvl model as its base.
// BiRefNet lite (MIT) was wired first and dropped on 2026-11-12: on this Mac's WebGPU adapter its graph needs
// 11 storage buffers per shader stage (the adapter allows 10), and on WebAssembly it runs out of memory. Subject
// and background come from IS-Net general use (2026-11-13), which runs on WebGPU here and also finds subjects
// that are not COCO classes (a lighthouse); people and sky stay with DETR.
// Not used, because their licences are restrictive: briaai RMBG (non-commercial), nvidia SegFormer (NVIDIA
// source code licence), onnx-community/ISNet-ONNX (AGPL-3.0).

import { PIXEL_MODELS } from './models-pixels.js';

export const PERMISSIVE_LICENCES = Object.freeze(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause']);

export const MASK_MODELS = Object.freeze([
  {
    // fp16 on WebGPU (one call about 2.5 s here); the q8 graph on WebAssembly took about 70 s per call.
    id: 'detr-panoptic', label: 'People and sky finder (DETR panoptic, 87 MB)', task: 'semantic',
    repo: 'Xenova/detr-resnet-50-panoptic', revision: 'ea24b2d4e0bfae31f0a1299ba3fb892a2df064de',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/facebook/detr-resnet-50-panoptic',
    bytes: 86_559_030, dtype: 'fp16', device: 'webgpu',
  },
  {
    id: 'isnet-general', label: 'Subject finder (IS-Net general use, 176 MB)', task: 'salient',
    repo: 'x-Liola-x/isnet-general-use-onnx', revision: '362ef325895d0d088b979de093494da7e6f17047',
    licence: 'Apache-2.0', licenceUrl: 'https://github.com/xuebinqin/DIS/blob/main/LICENSE.md',
    bytes: 176_213_804, dtype: 'fp32', device: 'webgpu', file: 'isnet-general-use.onnx', size: 1024,
  },
  {
    id: 'vitmatte-small', label: 'Hair and edge refiner (ViTMatte small, 28 MB)', task: 'matting',
    repo: 'Xenova/vitmatte-small-composition-1k', revision: '6bc1297f6140f055a227b6d2cfe8c093281f35d2',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/hustvl/vitmatte-small-composition-1k',
    bytes: 27_499_369, dtype: 'q8', device: 'wasm',
  },
  {
    id: 'slimsam', label: 'Object picker (SlimSAM, 14 MB)', task: 'point-mask',
    repo: 'Xenova/slimsam-77-uniform', revision: '5850ab45f587c112167512ffef949107115e26a0',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/Xenova/slimsam-77-uniform',
    bytes: 13_790_000, dtype: 'q8', device: 'wasm',
    // SAM ships two graphs (vision encoder, prompt encoder and mask decoder) and no onnx/model*.onnx; the
    // encoder is the file whose presence means downloaded (checked against the repo at this revision, 2026-11-13).
    file: 'onnx/vision_encoder_quantized.onnx',
  },
  {
    id: 'depth-anything-v2-small', label: 'Depth map (Depth Anything V2 Small, 50 MB)', task: 'depth',
    repo: 'onnx-community/depth-anything-v2-small', revision: '4472b7362082ad9968fee890ca0f1e5aca36b93d',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/depth-anything/Depth-Anything-V2-Small-hf',
    bytes: 49_644_000, dtype: 'fp16', device: 'webgpu',
  },
]);

export const MODELS = Object.freeze([...MASK_MODELS, ...PIXEL_MODELS]);

export const modelById = (id) => MODELS.find((m) => m.id === id) ?? null;

// The ONNX graph a model loads, as a path in its repo (transformers.js names it onnx/model<suffix>.onnx by dtype).
const SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4' };
export const graphFile = (m) => m.file ?? `onnx/model${SUFFIX[m.dtype] ?? ''}.onnx`;

// The refiner P20 (refine_edge) uses when the person has downloaded it; without it refine_edge is classical.
export const MATTING_MODEL = 'vitmatte-small';

// Which model answers each AI mask target (L34, P18) and the depth map (L33, L53).
export const MASK_TARGETS = Object.freeze({
  subject: 'isnet-general', background: 'isnet-general',
  people: 'detr-panoptic', sky: 'detr-panoptic',
  object: 'slimsam',
  depth: 'depth-anything-v2-small',
});
