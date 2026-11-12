// Animation and timeline, video layers and animation export (P58). The maths is src/motion/timeline.js;
// encoders are src/motion/gif.js (GIF), src/motion/webp.js (animated WebP from the browser's still WebP
// encoder) and src/motion/webm.js (WebM from the browser's WebCodecs VideoEncoder).
//
// The canvas shows the current frame: once a document has a timeline, the renderer draws frameDoc(doc,
// frame) for it (the stored document keeps the base values; the timeline's keys override them per frame).
// The current frame is view state (ctx.motion), not saved.

import { fail, needDoc, needLayer, change, stageOrRun, layerRow } from './util.js';
import { newDocument, makeLayer } from '../document.js';
import { PROPS, EASES, newTimeline, setKey, frameDoc, layerStateAt, delayMs } from '../motion/timeline.js';
import { encodeGif } from '../motion/gif.js';
import { muxAnimatedWebp } from '../motion/webp.js';
import { muxWebm } from '../motion/webm.js';
import { describeWebp } from '../files/describe.js';
import { editedNote } from '../ai/scene.js';

const FORMATS = { gif: 'gif', webp: 'webp', webm: 'webm' };

// Timeline length for a video at 24 fps: frames = max(1, round(duration_s × 24)). A stream (MediaRecorder
// WebM) can report duration Infinity or NaN until it is read to the end; it then counts as one second.
export const videoFrames = (duration) => Math.max(1, Math.round((Number.isFinite(duration) && duration > 0 ? duration : 1) * 24));

export function register(bus, ctx) {
  const rd = () => ctx.renderer;
  ctx.motion = { docId: null, frame: 0, playing: false };
  const frameOf = (doc) => (ctx.motion.docId === doc.id ? ctx.motion.frame : 0);

  // The renderer draws the open document at its current frame (only documents with a timeline).
  const r0 = ctx.renderer;
  if (r0 && !r0.motionHooked) {
    const base = r0.sync;
    r0.sync = (d, ...rest) => base.call(r0, d && d === ctx.store.doc && d.timeline ? frameDoc(d, frameOf(d)) : d, ...rest);
    r0.motionHooked = true;
  }

  const storage = () => { const s = ctx.storage(); if (!s) fail('unsupported', 'no workspace storage; grant a folder or allow browser storage', 'use_ui_control', 'grant_folder'); return s; };
  const needTimeline = (doc, T) => { if (!doc.timeline) fail('invalid', 'the document has no timeline; set_timeline creates one', 'fix_argument', 'set_timeline'); return doc.timeline; };
  const checkFrame = (tl, f, T) => { if (!Number.isInteger(f) || f < 0 || f >= tl.frames) fail('invalid', `frame is 0 to ${tl.frames - 1}`, 'fix_argument', T); };

  // Video layers: write each one's frame into its pixels (display state, not an undo step).
  async function updateVideos(doc, frame) {
    const vids = doc.layers.filter((l) => l.video && l.kind === 'raster');
    if (!vids.length) return 0;
    const { frameAt, videoTime } = await import('../motion/video.js');
    const fps = doc.timeline?.fps ?? 12;
    for (const l of vids) {
      const px = await frameAt(storage(), l.video.file, videoTime(l.video, frame, fps));
      rd().bufferIO.write(l.buffer, px);
    }
    return vids.length;
  }
  async function show(doc, frame) {
    ctx.motion.docId = doc.id; ctx.motion.frame = frame;
    if (rd()) await updateVideos(doc, frame);
    await ctx.sync();
  }

  bus.register('motion.timeline', async (a) => {
    const doc = needDoc(ctx); const T = 'set_timeline';
    const tl = doc.timeline ?? newTimeline();
    const fps = a.fps ?? tl.fps; const frames = a.frames ?? tl.frames;
    await change(ctx, 'set timeline', (d) => {
      d.timeline = { ...(d.timeline ?? newTimeline()), fps, frames, loop: a.loop ?? tl.loop };
      if (a.clear) d.timeline.tracks = {};
    });
    if (frameOf(doc) >= frames) ctx.motion.frame = frames - 1;
    return { timeline: summary(ctx.store.doc) };
  });

  bus.register('motion.key', async (a) => {
    const doc = needDoc(ctx); const T = 'set_keyframe';
    const tl = needTimeline(doc, T); checkFrame(tl, a.frame, T);
    const l = needLayer(ctx, a.layerId, { unlocked: false });
    if (!PROPS.includes(a.property)) fail('invalid', `property is one of ${PROPS.join(', ')}`, 'fix_argument', T);
    let v = a.value;
    if (a.property === 'visible') { if (typeof v !== 'boolean') fail('invalid', 'visible takes true or false', 'fix_argument', T); }
    else if (!Number.isFinite(v)) fail('invalid', `${a.property} takes a number`, 'fix_argument', T);
    if (a.property === 'opacity') { if (v < 0 || v > 100) fail('invalid', 'opacity is 0 to 100', 'fix_argument', T); v /= 100; }
    if (a.property === 'scale' && v <= 0) fail('invalid', 'scale is above 0', 'fix_argument', T);
    if (l.quad && ['x', 'y', 'scale', 'rotation'].includes(a.property)) fail('unsupported', `${l.name} is distorted by corner points; animate its opacity or visibility instead`, 'change_target', 'list_layers');
    const e = a.ease ?? 'linear'; if (!EASES.includes(e)) fail('invalid', `ease is ${EASES.join(', ')}`, 'fix_argument', T);
    await change(ctx, 'set keyframe', (d) => {
      const tr = (d.timeline.tracks[l.id] ??= {});
      setKey((tr[a.property] ??= []), a.frame, v, a.property === 'visible' ? 'hold' : e);
    });
    return { layerId: l.id, property: a.property, keys: ctx.store.doc.timeline.tracks[l.id][a.property].length };
  });

  bus.register('motion.unkey', async (a) => {
    const doc = needDoc(ctx); const T = 'delete_keyframe';
    const tl = needTimeline(doc, T);
    const tr = tl.tracks[a.layerId];
    const props = a.property ? [a.property] : PROPS;
    const hits = props.filter((p) => tr?.[p]?.some((k) => k[0] === a.frame));
    if (!hits.length) fail('invalid', `no keyframe at frame ${a.frame} for ${a.layerId}${a.property ? ` ${a.property}` : ''}`, 'fix_argument', 'get_timeline');
    await change(ctx, 'delete keyframe', (d) => {
      const t = d.timeline.tracks[a.layerId];
      for (const p of hits) { t[p] = t[p].filter((k) => k[0] !== a.frame); if (!t[p].length) delete t[p]; }
      if (!Object.keys(t).length) delete d.timeline.tracks[a.layerId];
    });
    return { deleted: hits };
  });

  // Frame animation: every top-level layer's visibility and opacity become hold keys at this frame.
  // layers: optional { [layerId]: { visible?, opacity? (0–100) } } overrides recorded for this frame.
  bus.register('motion.capture', async (a) => {
    const doc = needDoc(ctx); const T = 'capture_frame';
    const tl = needTimeline(doc, T); checkFrame(tl, a.frame, T);
    for (const id of Object.keys(a.layers || {})) if (!doc.layers.some((l) => l.id === id)) fail('invalid', `no layer ${id}`, 'fix_argument', 'list_layers');
    const shown = frameDoc(doc, a.frame);
    await change(ctx, 'capture frame', (d) => {
      for (const l of shown.layers) {
        if (l.localOf || l.parentId) continue;
        const o = a.layers?.[l.id] || {};
        const tr = (d.timeline.tracks[l.id] ??= {});
        setKey((tr.visible ??= []), a.frame, o.visible ?? l.visible, 'hold');
        setKey((tr.opacity ??= []), a.frame, o.opacity !== undefined ? Math.min(100, Math.max(0, o.opacity)) / 100 : l.opacity, 'hold');
      }
    });
    return { frame: a.frame, layers: shown.layers.filter((l) => !l.localOf && !l.parentId).length };
  });

  bus.register('motion.go', async (a, { viewOnly }) => {
    viewOnly(); const doc = needDoc(ctx); const T = 'go_to_frame';
    const tl = needTimeline(doc, T); checkFrame(tl, a.frame, T);
    await show(doc, a.frame);
    return { frame: a.frame, time: +(a.frame / tl.fps).toFixed(4) };
  });

  // Playback in the canvas: frames advance at the timeline's fps (a frame waits for the previous render).
  bus.register('motion.play', async (a, { viewOnly }) => {
    viewOnly(); const doc = needDoc(ctx); const tl = needTimeline(doc, 'play_timeline');
    ctx.motion.playing = !!a.play;
    if (!a.play) return { playing: false, frame: frameOf(doc) };
    const id = (ctx.motion.run = (ctx.motion.run ?? 0) + 1);
    (async () => {
      let f = frameOf(doc);
      while (ctx.motion.playing && ctx.motion.run === id && ctx.store.doc === doc) {
        const t0 = performance.now();
        f = (f + 1) % tl.frames;
        try { await show(doc, f); } catch { ctx.motion.playing = false; break; }
        ctx.onFrame?.(f);
        await new Promise((r) => setTimeout(r, Math.max(0, 1000 / tl.fps - (performance.now() - t0))));
      }
    })();
    return { playing: true, fps: tl.fps, frames: tl.frames };
  });

  bus.register('motion.get', async () => {
    const doc = needDoc(ctx);
    if (!doc.timeline) return { timeline: null };
    const f = frameOf(doc);
    return { timeline: summary(doc), frame: f, playing: !!ctx.motion.playing,
      layers: doc.layers.filter((l) => doc.timeline.tracks[l.id]).map((l) => ({ id: l.id, name: l.name, state: display(layerStateAt(doc.timeline, l.id, f)), ...(l.video ? { video: l.video } : {}) })) };
  });

  // A video file as a raster layer whose pixels follow the timeline. Without a document, opens one at
  // the video's size with a timeline matching the video's length at 24 fps.
  bus.register('motion.video', async (a) => {
    const T = 'import_video'; const s = storage();
    const { VIDEO_EXT, player } = await import('../motion/video.js');
    if (!VIDEO_EXT.includes(a.path.split('.').pop().toLowerCase())) fail('unsupported', `video layers read ${VIDEO_EXT.join(', ')} files the browser can decode`, 'fix_argument', T);
    if (!(await s.exists(a.path))) fail('invalid', `no file ${a.path}`, 'fix_argument', 'list_folder');
    let p; try { p = await player(s, a.path); } catch (e) { fail('unsupported', e.message, 'fix_argument', T); }
    let doc = ctx.store.doc;
    const frames = videoFrames(p.duration);
    if (!doc) {
      doc = newDocument({ width: p.width, height: p.height, background: 'transparent', title: a.path.split('/').pop() });
      doc.timeline = newTimeline({ fps: 24, frames });
      ctx.store.replace(doc);
    }
    const buffer = rd().newPixels(p.width, p.height);
    const l = makeLayer('raster', { name: a.path.split('/').pop(), buffer, width: p.width, height: p.height, video: { file: a.path, width: p.width, height: p.height, duration: p.duration, offset: a.offset ?? 0 } });
    await change(ctx, 'import video', (d) => { d.layers.push(l); d.activeLayerId = l.id; d.timeline ??= newTimeline({ fps: 24, frames }); });
    await show(ctx.store.doc, frameOf(ctx.store.doc));
    return { layer: layerRow(l), video: l.video, timeline: summary(ctx.store.doc) };
  });

  // Export frames from..to as an animated GIF, animated WebP or WebM video.
  bus.register('motion.export', async (a, { door }) => {
    const doc = needDoc(ctx); const T = 'export_animation'; const s = storage();
    const tl = needTimeline(doc, T);
    const fmt = FORMATS[a.format]; if (!fmt) fail('invalid', 'format is gif, webp or webm', 'fix_argument', T);
    if (!a.path.toLowerCase().endsWith(`.${fmt}`)) fail('invalid', `path ends with .${fmt}`, 'fix_argument', T);
    const from = a.from ?? 0; const to = a.to ?? tl.frames - 1;
    checkFrame(tl, from, T); checkFrame(tl, to, T);
    if (to < from) fail('invalid', 'to is at or after from', 'fix_argument', T);
    if (fmt === 'webm' && typeof VideoEncoder === 'undefined') fail('unsupported', 'this browser has no WebCodecs VideoEncoder; export gif or webp', 'fix_argument', T);
    if (fmt === 'webm' && !(await VideoEncoder.isConfigSupported({ codec: 'vp8', width: 64, height: 64 })).supported) fail('unsupported', 'this browser cannot encode VP8 video; export gif or webp', 'fix_argument', T);
    const replaces = await s.exists(a.path);
    const n = to - from + 1;
    return stageOrRun(ctx, { door }, T, `${replaces ? `REPLACE existing ${a.path} with ` : ''}export ${n} frames of "${doc.title}" as ${fmt.toUpperCase()} at ${tl.fps} fps${replaces ? '' : ` to ${a.path}`}`, async () => {
      const d = needDoc(ctx); const keep = { docId: ctx.motion.docId, frame: ctx.motion.frame };
      ctx.busy = T;
      try {
        const bytes = await encode(d, tl, fmt, from, to, a);
        await s.write(a.path, bytes);
        return { path: a.path, format: fmt, frames: n, fps: tl.fps, width: lastSize.width, height: lastSize.height, bytes: bytes.length, replaced: replaces };
      } finally { ctx.busy = null; ctx.motion.docId = keep.docId; ctx.motion.frame = keep.frame; await show(d, frameOf(d)).catch(() => {}); }
    }, { force: replaces });
  });

  let lastSize = { width: 0, height: 0 };
  async function renderFrame(doc, f, maxEdge) {
    await updateVideos(doc, f);
    await rd().sync(frameDoc(doc, f));
    const lod = maxEdge ? rd().lodFor(doc, maxEdge) : 0;
    let im = await rd().image8(lod);
    if (maxEdge) im = await rd().resize(im, maxEdge);
    lastSize = { width: im.width, height: im.height };
    return im;
  }
  async function encode(doc, tl, fmt, from, to, a) {
    if (fmt === 'gif') {
      const frames = [];
      for (let f = from; f <= to; f++) { const im = await renderFrame(doc, f, a.maxEdge); frames.push({ width: im.width, height: im.height, data: im.data }); }
      return encodeGif(frames, { delayCs: Math.max(2, Math.round(100 / tl.fps)), loop: tl.loop ?? 0, comment: editedNote(doc) });
    }
    if (fmt === 'webp') {
      const stills = []; let size;
      for (let f = from; f <= to; f++) { const im = await renderFrame(doc, f, a.maxEdge); size = im; stills.push(await rd().encode(im, 'image/webp', (a.quality ?? 90) / 100)); }
      const out = muxAnimatedWebp(stills, { width: size.width, height: size.height, durationMs: delayMs(tl), loop: tl.loop ?? 0 });
      return editedNote(doc) ? describeWebp(out, editedNote(doc)) : out;   // the "edited" label for AI-edited layers
    }
    // WebM: VP8 needs even dimensions; frames composite over black (video has no alpha).
    const chunks = []; let err = null; let W = 0; let H = 0;
    const enc = new VideoEncoder({ output: (c) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); chunks.push({ data: b, timestampMs: c.timestamp / 1000, key: c.type === 'key' }); }, error: (e) => { err = e; } });
    for (let f = from; f <= to; f++) {
      const im = await renderFrame(doc, f, a.maxEdge);
      if (!W) { W = im.width & ~1 || 2; H = im.height & ~1 || 2; enc.configure({ codec: 'vp8', width: W, height: H, bitrate: a.bitrate ?? 8_000_000, framerate: tl.fps }); }
      const oc = new OffscreenCanvas(W, H); const g = oc.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
      const src = new OffscreenCanvas(im.width, im.height); src.getContext('2d').putImageData(new ImageData(im.data, im.width, im.height), 0, 0);
      g.drawImage(src, 0, 0);
      const vf = new VideoFrame(oc, { timestamp: Math.round(((f - from) * 1e6) / tl.fps), duration: Math.round(1e6 / tl.fps) });
      enc.encode(vf, { keyFrame: (f - from) % (tl.fps * 2) === 0 }); vf.close();
    }
    await enc.flush(); enc.close();
    if (err) throw err;
    lastSize = { width: W, height: H };
    return muxWebm(chunks, { width: W, height: H, codec: 'V_VP8', durationMs: ((to - from + 1) * 1000) / tl.fps });
  }
}

function display(st) { return 'opacity' in st ? { ...st, opacity: Math.round(st.opacity * 1000) / 10 } : st; }
function summary(doc) {
  const tl = doc.timeline;
  return { fps: tl.fps, frames: tl.frames, loop: tl.loop, durationSeconds: +(tl.frames / tl.fps).toFixed(3),
    tracks: Object.fromEntries(Object.entries(tl.tracks).map(([id, t]) => [id, Object.fromEntries(Object.entries(t).map(([p, k]) => [p, k.map(([f, v, e]) => [f, p === 'opacity' ? Math.round(v * 1000) / 10 : v, ...(e ? [e] : [])])]))])) };
}
