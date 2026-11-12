// RAW decode through libraw-wasm (LibRaw in a worker). Output: 16-bit linear camera RGB, white-balanced at
// the camera's as-shot gains (LibRaw applies them before demosaic), no camera matrix. The develop pass applies
// relative white-balance gains in camera space, then the camera matrix to linear Rec.2020.
// LibRaw stays a separate lazy module (LGPL-2.1 / CDDL-1.0), loaded only when the first RAW opens.

import { EngineError } from './gpu.js';
import { SRGB_TO_REC2020, matMul3, solveAsShot } from './model.js';

// LibRaw output settings for the engine's working space.
// outputColor 0 = camera RGB (raw colour, no matrix). gamm must be the full 6-element LibRaw array: the
// wrapper ignores a 2-element [1, 1] and then encodes BT.709 gamma (observed 2026-11-12: ratios between
// white-balanced and unbalanced decodes followed a ~0.55 power until gamm had 6 elements).
// noAutoBright keeps scene values unscaled; highlight 0 clips each channel at full scale after white balance.
export const CAMERA_LINEAR = Object.freeze({
  outputBps: 16,
  outputColor: 0,
  gamm: [1, 1, 0, 0, 0, 0],
  noAutoBright: true,
  useCameraWb: true,
  userQual: 3, // AHD demosaic
  highlight: 0, // clip; highlight reconstruction is a later engine stage
});

// Colour facts of a decode: as-shot gains (min-normalised), cam_xyz (XYZ → camera, D65 reference), and the
// camera → linear Rec.2020 matrix LibRaw itself uses for outputColor 8 (rec2020_rgb × rgb_cam).
export function colourInfo(meta) {
  const cd = meta?.color_data || {};
  const pick = (m) => (m ? Array.from(m, (r) => Array.from(r).slice(0, 3)) : null);
  const rgbCam = pick(cd.rgb_cam)?.slice(0, 3);
  const camXyz = pick(cd.cam_xyz)?.slice(0, 3) || null;
  if (!rgbCam || !rgbCam.every((r) => r.some((v) => v !== 0))) {
    throw new EngineError('decode_failed', 'RAW decode gave no camera matrix (rgb_cam).', 'This camera is not supported yet.');
  }
  const mul = Array.from(cd.cam_mul || []).slice(0, 3);
  const pre = Array.from(cd.pre_mul || []).slice(0, 3);
  const g = mul[0] > 0 && mul[1] > 0 && mul[2] > 0 ? mul : pre; // LibRaw falls back to daylight pre_mul
  const m = Math.min(...g);
  const gains = g.map((v) => v / m);
  const solved = camXyz ? solveAsShot(camXyz, gains) : null;
  return {
    camToRec2020: matMul3(SRGB_TO_REC2020, rgbCam),
    camXyz,
    asShot: { gains, temperature: solved ? solved.temperature : null, tint: solved ? solved.tint : null, residual: solved ? solved.residual : null },
  };
}

export async function decodeRaw(bytes, settings = {}) {
  const { default: LibRaw } = await import('../vendor/libraw-wasm/index.js');
  const lr = new LibRaw();
  const t0 = performance.now();
  try {
    await lr.open(bytes, { ...CAMERA_LINEAR, ...settings });
    const meta = await lr.metadata(true);
    const img = await lr.imageData();
    if (!img || !img.data) throw new Error('imageData returned nothing');
    if (img.colors !== 3 || img.bits !== 16) throw new Error(`unexpected output: ${img.colors} colours, ${img.bits} bits`);
    const data = img.data instanceof Uint16Array ? img.data
      : new Uint16Array(img.data.buffer, img.data.byteOffset, img.data.byteLength / 2);
    return { width: img.width, height: img.height, data, meta, decodeMs: performance.now() - t0 };
  } catch (e) {
    throw new EngineError('decode_failed', `RAW decode failed: ${e.message}`, 'Check the file is a supported RAW format.');
  } finally {
    lr.dispose();
  }
}
