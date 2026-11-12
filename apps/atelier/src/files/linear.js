// Linear float sources in files (L45 HDR merge): a float32 linear RGB buffer travels as a 32-bit float TIFF
// (SampleFormat 3, Deflate, src/files/tiff.js), so values above 1.0 survive save and reload. The colour facts
// tessella's createLinearSource needs (camToRec2020, camXyz, gains, scale) live in the document's buffer entry.
// Pure code: node and browser.

import { readTiff, writeTiff } from './tiff.js';
import { newDocument, makeLayer } from '../document.js';

export const encodeLinear = (data, width, height) => writeTiff([{ width, height, bits: 32, channels: 3, data, description: 'Atelier linear float source' }]);

export async function decodeLinear(bytes) {
  const p = (await readTiff(bytes, { float: true })).pages[0];
  if (!p.float) throw new Error('a linear source is a 32-bit float TIFF');
  const n = p.width * p.height; const data = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { data[i * 3] = p.data[i * 4]; data[i * 3 + 1] = p.data[i * 4 + 1]; data[i * 3 + 2] = p.data[i * 4 + 2]; }
  return { width: p.width, height: p.height, data };
}

// A one-layer Atelier document whose RAW-like layer develops a linear float source. Returns the document
// JSON bytes and the buffer file to write first (binaries before the JSON that names them, spec 002 §9.3).
// path: the .atelier path; colour: createLinearSource's colour facts; develop: the layer's develop settings.
export async function linearDocument({ path, title, width, height, data, colour, develop = {} }) {
  const doc = newDocument({ width, height, background: 'transparent', title });
  const bufferId = 'lin1';
  const layer = makeLayer('raw', { name: title, buffer: bufferId, develop });
  doc.layers.push(layer); doc.activeLayerId = layer.id;
  const file = `${path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''}${doc.id}/buffers/${bufferId}.tif`;
  const tif = await encodeLinear(data, width, height);
  const body = { format: 'atelier-document', version: 1, savedAt: new Date().toISOString(), document: doc, buffers: { [bufferId]: { kind: 'linear', width, height, file, colour } }, editList: [] };
  return { doc, files: [{ path: file, bytes: tif }], json: new TextEncoder().encode(`${JSON.stringify(body, null, 2)}\n`) };
}
