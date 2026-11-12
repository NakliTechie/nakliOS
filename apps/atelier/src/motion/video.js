// Video layers (P58), browser only: a video file in the workspace decoded one frame at a time into a
// raster layer's pixels. The layer is a raster layer carrying
// video = { file, width, height, duration, offset }; its frame follows the timeline:
//   t = clamp((frame − offset) / fps + ½ / fps, 0, duration − ε)
// (the middle of the document frame's interval, so a pick never lands on a frame boundary).
// Adjustment layers, masks, blend modes and styles above or on the layer apply to every frame, because
// the engine composites the updated pixels like any raster layer, on screen and in export_animation.
//
// Two decoders:
// - WebM (VP8, VP9): Atelier's WebM reader (src/motion/webm.js) plus the WebCodecs VideoDecoder. It
//   works in a background tab, and a frame is exact: decode from the last key frame at or before t up
//   to the last block whose time is ≤ t.
// - Other containers (mp4, mov, m4v, ogv): an HTMLVideoElement seek. Chrome defers loading media in a
//   tab that has never been visible, so this path waits at most 15 s and then says so.

import { readWebm } from './webm.js';

const players = new Map();   // file → Promise<player>

export const VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'ogv'];
const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg' };
const CODECS = { V_VP8: 'vp8', V_VP9: 'vp09.00.10.08' };

async function webmPlayer(bytes, file) {
  if (typeof VideoDecoder === 'undefined') throw new Error('this browser has no WebCodecs VideoDecoder');
  const w = readWebm(bytes);
  const codec = CODECS[w.codec];
  if (!codec) throw new Error(`${file}: WebM video layers decode VP8 or VP9; this file is ${w.codec}`);
  if (!w.blocks.length) throw new Error(`${file} holds no video frames`);
  if (!(await VideoDecoder.isConfigSupported({ codec, codedWidth: w.width, codedHeight: w.height })).supported) throw new Error(`this browser cannot decode ${w.codec}`);
  const blocks = w.blocks.slice().sort((a, b) => a.t - b.t);
  const step = blocks.length > 1 ? (blocks.at(-1).t - blocks[0].t) / (blocks.length - 1) : 40;
  const duration = (blocks.at(-1).t + step) / 1000;
  return {
    width: w.width, height: w.height, duration,
    // RGBA of the last frame whose time ≤ t (seconds).
    async frame(t) {
      const ms = t * 1000;
      let i = 0; while (i + 1 < blocks.length && blocks[i + 1].t <= ms) i++;
      let k = i; while (k > 0 && !blocks[k].key) k--;
      let last = null; let err = null;
      const dec = new VideoDecoder({ output: (f) => { last?.close(); last = f; }, error: (e) => { err = e; } });
      dec.configure({ codec, codedWidth: w.width, codedHeight: w.height });
      for (let j = k; j <= i; j++) dec.decode(new EncodedVideoChunk({ type: j === k ? 'key' : 'delta', timestamp: Math.round(blocks[j].t * 1000), data: blocks[j].data }));
      await dec.flush(); dec.close();
      if (err || !last) throw new Error(`${file}: could not decode the frame at ${t.toFixed(3)} s (${err?.message || 'no output'})`);
      const oc = new OffscreenCanvas(w.width, w.height); const g = oc.getContext('2d', { willReadFrequently: true });
      g.drawImage(last, 0, 0, w.width, w.height); last.close();
      return g.getImageData(0, 0, w.width, w.height).data;
    },
    close() {},
  };
}

async function elementPlayer(bytes, file, ext) {
  const url = URL.createObjectURL(new Blob([bytes], { type: MIME[ext] || 'video/mp4' }));
  const video = document.createElement('video');
  video.muted = true; video.preload = 'auto'; video.playsInline = true; video.src = url;
  try {
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`${file} did not load in 15 s (Chrome loads media only once the tab has been visible; bring Atelier to the front, or use a WebM file)`)), 15000);
      video.onloadeddata = () => { clearTimeout(timer); res(); };
      video.onerror = () => { clearTimeout(timer); rej(new Error(`the browser cannot decode ${file} (${video.error?.message || 'unsupported codec'})`)); };
    });
  } catch (e) { URL.revokeObjectURL(url); throw e; }
  const W = video.videoWidth; const H = video.videoHeight;
  return {
    width: W, height: H, duration: video.duration,
    async frame(t) {
      if (Math.abs(video.currentTime - t) > 1e-4) {
        await new Promise((res, rej) => {
          const done = () => { video.removeEventListener('seeked', done); clearTimeout(timer); res(); };
          const timer = setTimeout(() => { video.removeEventListener('seeked', done); rej(new Error('video seek timed out')); }, 10000);
          video.addEventListener('seeked', done); video.currentTime = t;
        });
      }
      const oc = new OffscreenCanvas(W, H); const g = oc.getContext('2d', { willReadFrequently: true });
      g.drawImage(video, 0, 0, W, H);
      return g.getImageData(0, 0, W, H).data;
    },
    close() { URL.revokeObjectURL(url); },
  };
}

export function player(storage, file) {
  if (!players.has(file)) {
    const p = (async () => {
      const ext = file.split('.').pop().toLowerCase();
      const bytes = await storage.readBinary(file);
      return ext === 'webm' ? webmPlayer(bytes, file) : elementPlayer(bytes, file, ext);
    })();
    players.set(file, p);
    p.catch(() => players.delete(file));
  }
  return players.get(file);
}

export async function dropPlayer(file) { const p = players.get(file); if (!p) return; players.delete(file); (await p.catch(() => null))?.close(); }

export function videoTime(v, frame, fps) {
  const d = Number.isFinite(v.duration) ? v.duration : Infinity;
  return Math.min(Math.max(0, d - 1e-3), Math.max(0, (frame - (v.offset || 0)) / fps + 0.5 / fps));
}

// RGBA 8-bit pixels of the video at time t (seconds), at the video's own size.
export async function frameAt(storage, file, t) { return (await player(storage, file)).frame(t); }
