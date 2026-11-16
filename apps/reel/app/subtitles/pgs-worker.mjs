/* PGS decoding off the page thread (review finding V8). A same-origin module worker started
 * by bitmap.mjs. Messages in:  { op: 'load', buffer }  then  { op: 'render', index }.
 * Messages out: { op: 'loaded', times, dropped, truncated }, { op: 'frame', index, width,
 * height, rects } (pixel buffers transferred), or { op: 'error', message }. */

import { parseSup, renderDisplaySet } from './pgs-decode.mjs';

let sup = null;

self.onmessage = ({ data }) => {
  try {
    if (data?.op === 'load') {
      sup = parseSup(new Uint8Array(data.buffer));
      if (!sup.sets.length) throw new Error('No PGS display sets could be read from this file.');
      self.postMessage({ op: 'loaded', times: sup.times, dropped: sup.dropped, truncated: sup.truncated });
    } else if (data?.op === 'render') {
      if (!sup) throw new Error('No PGS file is loaded.');
      const frame = renderDisplaySet(sup, data.index);
      self.postMessage({ op: 'frame', index: data.index, ...frame }, frame.rects.map(rect => rect.rgba.buffer));
    }
  } catch (error) {
    self.postMessage({ op: 'error', message: error?.message || String(error) });
  }
};
