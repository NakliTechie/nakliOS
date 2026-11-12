// On-device image-to-image models (spec 002 §9.4, rule ④ removable AI). Each model is one named download
// the person consents to; nothing here loads until they do. Licences were read on each model card and on
// the upstream repository on 2026-11-12; only MIT, Apache-2.0 and BSD models are listed.
//
// Fields shared with the mask registry: id, label, task, repo, revision, licence, licenceUrl, bytes,
// dtype, device. Pixel models run raw ONNX through onnxruntime-web (src/ai/pixels.js), so they also
// carry runtime 'ort', the files to fetch, and the tensor contract (inputs, scale, multiple, tile).

export const PIXEL_MODELS = [
  {
    id: 'scunet-denoise',
    label: 'SCUNet denoiser (77 MB)',
    task: 'denoise',
    repo: 'Heliosoph/scunet-onnx',
    revision: '6d11417ee2fbcc73783c502a238ac115097754fe',
    licence: 'Apache-2.0',
    licenceUrl: 'https://github.com/cszn/SCUNet/blob/main/LICENSE',
    source: 'Kai Zhang et al., "Practical Blind Image Denoising via Swin-Conv-UNet and Data Synthesis" (2022); blind real-world PSNR checkpoint, ONNX export by Heliosoph',
    bytes: 76936854,
    dtype: 'fp32',
    device: 'webgpu',
    runtime: 'ort',
    files: [{ path: 'scunet_color_real_psnr.onnx', bytes: 3798678 }, { path: 'scunet_color_real_psnr.onnx.data', bytes: 73138176, externalData: true }],
    io: { inputs: ['image'], scale: 1, multiple: 64, tile: 256, overlap: 32 },
  },
  {
    id: 'swin2sr-x2',
    label: 'Swin2SR ×2 upscaler (54 MB)',
    task: 'upscale',
    repo: 'Xenova/swin2SR-classical-sr-x2-64',
    revision: '71e28a83cfb61f5dc95bafdeebf2815167914f2b',
    licence: 'Apache-2.0',
    licenceUrl: 'https://huggingface.co/caidas/swin2SR-classical-sr-x2-64',
    source: 'Conde et al., "Swin2SR" (2022), classical ×2 checkpoint (caidas), ONNX export by Xenova',
    bytes: 54428699,
    dtype: 'fp32',
    device: 'webgpu',
    runtime: 'ort',
    files: [{ path: 'onnx/model.onnx', bytes: 54428699 }],
    io: { inputs: ['pixel_values'], scale: 2, multiple: 8, tile: 128, overlap: 16 },
  },
  {
    id: 'lama-inpaint',
    label: 'LaMa inpainting (208 MB)',
    task: 'inpaint',
    repo: 'Carve/LaMa-ONNX',
    revision: 'c3c0c9e468934d62e79c329e35d82dd09ff8c444',
    licence: 'Apache-2.0',
    licenceUrl: 'https://github.com/advimman/lama/blob/main/LICENSE',
    source: 'Suvorov et al., "Resolution-robust Large Mask Inpainting with Fourier Convolutions" (big-lama), ONNX export by Carve (fixed 512 × 512)',
    bytes: 208044816,
    dtype: 'fp32',
    device: 'wasm',   // the graph uses DFT, which the WebGPU execution provider does not run
    runtime: 'ort',
    files: [{ path: 'lama_fp32.onnx', bytes: 208044816 }],
    io: { inputs: ['image', 'mask'], scale: 1, multiple: 512, tile: 512, overlap: 128 },
  },
  // Image-text embeddings for keywording (L71) and find-similar (L64). Int8 graphs: 154 MB instead of 606 MB.
  {
    id: 'clip-b32',
    label: 'CLIP image-text matcher (154 MB)',
    task: 'embed',
    repo: 'Xenova/clip-vit-base-patch32',
    revision: '6b7c523703ae26e39be4b03774966f8571c7f523',
    licence: 'MIT',
    licenceUrl: 'https://github.com/openai/CLIP/blob/main/LICENSE',
    source: 'Radford et al., "Learning Transferable Visual Models From Natural Language Supervision" (OpenAI CLIP ViT-B/32, MIT), ONNX export by Xenova (MIT)',
    bytes: 155008455,
    dtype: 'int8',
    device: 'wasm',
    runtime: 'ort',
    files: [{ path: 'onnx/vision_model_quantized.onnx', bytes: 89117001 }, { path: 'onnx/text_model_quantized.onnx', bytes: 64504507 }, { path: 'vocab.json', bytes: 862328 }, { path: 'merges.txt', bytes: 524619 }],
  },
  // Face detection (BlazeFace, 256 px) and the 478-point Face Mesh V2 with its blendshapes, for face parts
  // (L61), closed eyes (L63: the eyeBlink blendshapes) and the face crops face grouping (L64) embeds. One
  // download from two repos: the detector from Heliosoph's bundle, Face Mesh V2 and Blendshape V2 from t9749's
  // ONNX conversion of Google's face_landmarker.task. Google's model cards ("MediaPipe Face Mesh V2",
  // "Blendshape V2") state Apache-2.0. The first face mesh (v1, 468 points) was dropped on 2026-11-13: on CC0
  // photos its eye contour stayed open on closed eyes (eye aspect 0.23 closed vs 0.22 open), so it could not
  // flag them; V2's blink scores separate all eight CC0 test photos (closed 0.457 or more, open 0.189 or less).
  {
    id: 'mediapipe-face',
    label: 'Face finder (MediaPipe face detector, Face Mesh V2 and blendshapes, 7 MB)',
    task: 'face',
    repo: 'Heliosoph/mediapipe-face-onnx',
    revision: '40558a441d87663a533137cefb838e853ef491da',
    licence: 'Apache-2.0',
    licenceUrl: 'https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf',
    source: 'Google MediaPipe face detection (Apache-2.0; PyTorch port zmurez/MediaPipePyTorch, ONNX by Qualcomm AI Hub, bundled by Heliosoph) and MediaPipe Face Landmarker Face Mesh V2 and Blendshape V2 (Apache-2.0; ONNX by t9749, tf2onnx)',
    bytes: 7400192,
    dtype: 'fp32',
    device: 'wasm',
    runtime: 'ort',
    files: [{ path: 'float/face_detector.onnx', bytes: 78195 }, { path: 'float/face_detector.data', bytes: 517152, externalData: true },
      { path: 'face_landmarks_detector.onnx', bytes: 4921016, repo: 't9749/mediapipe-face-landmarker-onnx', revision: '5c3cc92b90fee044d05504404ed52983b3fd8eab' },
      { path: 'face_blendshapes.onnx', bytes: 1883829, repo: 't9749/mediapipe-face-landmarker-onnx', revision: '5c3cc92b90fee044d05504404ed52983b3fd8eab' }],
  },
  // Face identity embeddings (128-d) for grouping faces across photos (L64).
  {
    id: 'sface',
    label: 'Face matcher (SFace, 39 MB)',
    task: 'face-embed',
    repo: 'opencv/face_recognition_sface',
    revision: '3d7082438a6e4551e840c9b2bb60b71e8da4b524',
    licence: 'Apache-2.0',
    licenceUrl: 'https://huggingface.co/opencv/face_recognition_sface/blob/main/LICENSE',
    source: 'Zhong et al., "SFace: Sigmoid-Constrained Hypersphere Loss for Robust Face Recognition" (2021), MobileFaceNet, OpenCV Zoo (Apache-2.0)',
    bytes: 38696353,
    dtype: 'fp32',
    device: 'wasm',
    runtime: 'ort',
    files: [{ path: 'face_recognition_sface_2021dec.onnx', bytes: 38696353 }],
  },
  // Portrait parsing (L61 hair, body skin, clothes; P61 skin smoothing): six classes per pixel, background, hair,
  // body skin, face skin, clothes, others. Google's model card ("Model Card Multiclass Segmentation", 2023)
  // states Apache-2.0; the ONNX file is a tf2onnx conversion of Google's float32 TFLite with the weights unchanged.
  {
    id: 'mediapipe-multiclass',
    label: 'Hair, skin and clothes finder (MediaPipe selfie multiclass, 16 MB)',
    task: 'parse',
    repo: 'senty-au/selfie_multiclass_256x256-ONNX',
    revision: '6db8421a7150ac20558f2c24675078eb3a1a04d0',
    licence: 'Apache-2.0',
    licenceUrl: 'https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Multiclass%20Segmentation.pdf',
    source: 'Google MediaPipe selfie_multiclass_256x256 image segmenter (Apache-2.0, model card May 2023), converted from TFLite to ONNX by senty-au (tf2onnx, opset 17)',
    bytes: 16454560,
    dtype: 'fp32',
    device: 'wasm',
    runtime: 'ort',
    files: [{ path: 'onnx/model.onnx', bytes: 16454560 }],
  },
  // Colourize (P61): DDColor tiny predicts CIELAB a and b from the lightness; the photo's own L is kept.
  {
    id: 'ddcolor-tiny',
    label: 'Colourizer (DDColor tiny, 135 MB)',
    task: 'colourize',
    repo: 'edgetools/ddcolor',
    revision: '4755ae9f1f7a35a9e7693b96c2a88f3432cb6ab0',
    licence: 'Apache-2.0',
    licenceUrl: 'https://github.com/piddnad/DDColor/blob/master/LICENSE',
    source: 'Kang et al., "DDColor: Towards Photo-Realistic Image Colorization via Dual Decoders" (ICCV 2023), ddcolor_paper_tiny weights (Apache-2.0), fp16 ONNX export by edgetools (fixed 512 × 512)',
    bytes: 135444402,
    dtype: 'fp16',
    device: 'wasm',   // on WebGPU one decoder MatMul fails ("shared dimension does not match", 2026-11-13)
    runtime: 'ort',
    files: [{ path: 'ddcolor-tiny-fp16.onnx', bytes: 135444402 }],
  },
  // Style transfer (P61): one fast neural style network per style. Udnie is trained on Francis Picabia's
  // "Udnie" (1913, public domain); code and weights from pytorch/examples (BSD-3-Clause), ONNX model zoo export.
  {
    id: 'style-udnie',
    label: 'Style transfer: Udnie (fast neural style, 7 MB)',
    task: 'style',
    repo: 'onnxmodelzoo/udnie-9',
    revision: 'ab74109f694dc8117f5e39a8571ac53bf83618f6',
    licence: 'BSD-3-Clause',
    licenceUrl: 'https://github.com/pytorch/examples/blob/main/LICENSE',
    source: 'Johnson et al., "Perceptual Losses for Real-Time Style Transfer" with instance normalisation, pytorch/examples fast_neural_style (BSD-3-Clause), ONNX model zoo udnie-9',
    bytes: 6728029,
    dtype: 'fp32',
    device: 'webgpu',
    runtime: 'ort',
    files: [{ path: 'udnie-9.onnx', bytes: 6728029 }],
  },
];

export const pixelModel = (id) => PIXEL_MODELS.find((m) => m.id === id) || null;
// A file may come from another repo than the model's own (f.repo, f.revision), as the face finder's do.
export const fileUrl = (m, f) => `https://huggingface.co/${f.repo ?? m.repo}/resolve/${f.revision ?? m.revision}/${f.path}`;
