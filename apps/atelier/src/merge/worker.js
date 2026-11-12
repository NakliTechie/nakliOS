// Module worker for the merge tools: runs mergeHdr, stitchPanorama or focusStack off the main thread so
// the page stays responsive during a merge of full-size frames. Message in: { op, frames, opts } with
// frames [{ width, height, data, lut: 'lin16' | 'srgb8' | null }] (data buffers transferred). Message out:
// { ok: true, result } (result.data transferred) or { ok: false, error }.

import { mergeHdr } from './hdr.js';
import { stitchPanorama } from './pano.js';
import { focusStack } from './focus.js';
import { LIN16_LUT, SRGB8_LUT } from './image.js';

const LUTS = { lin16: LIN16_LUT, srgb8: SRGB8_LUT };
const OPS = { hdr: mergeHdr, panorama: stitchPanorama, focus: focusStack };

self.onmessage = (e) => {
  const { op, frames, opts } = e.data;
  try {
    const result = OPS[op](frames.map((f) => ({ ...f, lut: f.lut ? LUTS[f.lut] : null })), opts);
    const transfer = [result.data.buffer, ...(result.coverage ? [result.coverage.buffer] : [])];
    self.postMessage({ ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ ok: false, error: err.message });
  }
};
