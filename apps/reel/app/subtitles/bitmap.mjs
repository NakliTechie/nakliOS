/* PGS bitmap subtitles, loaded only when a PGS track or .sup file is shown.
 *
 * Decoding runs in a same-origin module worker (pgs-worker.mjs, using pgs-decode.mjs), so a
 * malformed or very large file cannot stall the page (review finding V8). Reel uses its own
 * decoder rather than libpgs-js, because every size and run length from the file must be
 * checked before use (V8, V14) and libpgs-js 0.9.0 trusts them. The page thread only draws the
 * finished pixel rectangles onto a canvas, which stays readable for the checks.
 *
 * A watchdog fails the renderer when the worker does not answer within WORKER_TIMEOUT_MS; a
 * failure after start calls onFailure(message), so the caller can tell the person.
 *
 * Control-bar clearance (defect 1): Reel draws each rectangle itself, so the bottom group of a
 * display set moves up by the part of the bar that reaches its lowest drawn row (liftRects), at
 * full size; top-anchored rectangles stay where the file put them. */

import { indexAtTime } from './pgs-decode.mjs';
import { liftBoxes } from './lift.mjs';
import { containedRect } from './captions.mjs';

/* The bar's top edge in PGS canvas pixels, for a canvas of canvasWidth x canvasHeight drawn with
 * object-fit: contain in a layer rect { width, height, clearY } (CSS pixels). */
export function canvasClearY(rect, canvasWidth, canvasHeight) {
  if (!(rect?.width > 0 && rect?.height > 0) || !(canvasHeight > 0)) return Infinity;
  const clearY = Number.isFinite(rect.clearY) ? rect.clearY : rect.height;
  if (clearY >= rect.height) return Infinity;
  const fit = containedRect(rect.width, rect.height, canvasWidth, canvasHeight);
  const scale = fit.height / canvasHeight;
  return scale > 0 ? (clearY - fit.top) / scale : Infinity;
}

/* Returns rects with the bottom group moved up so it ends above clearY (canvas pixels). */
export function liftRects(rects, height, clearY) {
  const list = rects || [];
  const { lift, moved } = liftBoxes(list.map(rect => ({ y: rect.y, h: rect.height })), height, clearY);
  if (!lift) return { lift: 0, rects: list };
  const whole = Math.ceil(lift);
  return { lift: whole, rects: list.map((rect, i) => (moved[i] ? { ...rect, y: rect.y - whole } : rect)) };
}

export const WORKER_TIMEOUT_MS = 8000;

const defaultWorker = () => new Worker(new URL('./pgs-worker.mjs', import.meta.url), { type: 'module' });
const defaultCanvas = () => document.createElement('canvas');

export function createBitmapRenderer({
  layer,
  onLayout = () => () => {},
  onFailure = () => {},
  createWorker = defaultWorker,
  createCanvas = defaultCanvas,
  now = () => performance.now(),
} = {}) {
  let worker = null;
  let canvas = null;
  let status = 'idle';
  let error = null;
  let token = 0;
  let times = [];
  let shown = -2; // display set on the canvas; -1 is cleared, -2 is nothing drawn yet
  let wanted = -2;
  let pending = null; // { index, since }
  let loading = null; // { since, reject }
  let rect = null; // the caption layer rect, with clearY
  let last = null; // the frame on the canvas, redrawn when the clearance changes
  let lastLift = 0;
  let unsubscribe = null;

  function fail(message) {
    stop();
    status = 'failed';
    error = message;
    onFailure(message);
  }

  function draw(data) {
    if (!canvas) return;
    const { width, height } = data;
    last = data;
    if (width > 0 && height > 0 && (canvas.width !== width || canvas.height !== height)) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    const placed = liftRects(data.rects, canvas.height, canvasClearY(rect, canvas.width, canvas.height));
    lastLift = placed.lift;
    for (const item of placed.rects) context.putImageData(new ImageData(item.rgba, item.width, item.height), item.x, item.y);
  }

  function relayout(next) {
    const before = rect ? `${rect.width},${rect.height},${rect.clearY}` : '';
    rect = next;
    if (last && canvas && before !== `${next?.width},${next?.height},${next?.clearY}`) draw(last);
  }

  function pump() {
    if (!worker || pending || wanted === shown) return;
    if (wanted < 0) {
      draw({ width: 0, height: 0, rects: [] });
      shown = wanted;
      return;
    }
    pending = { index: wanted, since: now() };
    worker.postMessage({ op: 'render', index: wanted });
  }

  async function start(bytes) {
    stop();
    const mine = ++token;
    status = 'loading';
    error = null;
    try {
      worker = createWorker();
      const loaded = await new Promise((resolve, reject) => {
        loading = { since: now(), reject };
        const timer = setTimeout(() => reject(new Error(`PGS decoding did not answer within ${WORKER_TIMEOUT_MS / 1000} s.`)), WORKER_TIMEOUT_MS);
        worker.onmessage = ({ data }) => {
          if (data?.op === 'loaded') { clearTimeout(timer); resolve(data); return; }
          if (data?.op === 'error') { clearTimeout(timer); reject(new Error(data.message)); }
        };
        worker.onerror = event => { clearTimeout(timer); event?.preventDefault?.(); reject(new Error(event?.message || 'The PGS worker failed.')); };
        // A copy goes to the worker, because the track keeps its bytes for the next start.
        const copy = bytes.slice();
        worker.postMessage({ op: 'load', buffer: copy.buffer }, [copy.buffer]);
      });
      loading = null;
      if (mine !== token) return status;
      times = loaded.times;
      worker.onmessage = ({ data }) => {
        if (mine !== token) return;
        if (data?.op === 'frame') {
          pending = null;
          draw(data);
          shown = data.index;
          pump();
        } else if (data?.op === 'error') {
          fail(data.message);
        }
      };
      worker.onerror = event => { event?.preventDefault?.(); if (mine === token) fail(event?.message || 'The PGS worker failed.'); };
      canvas = createCanvas();
      canvas.className = 'reel-subs-bitmap';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;object-fit:contain';
      layer.prepend(canvas);
      unsubscribe = onLayout(relayout);
      status = 'ready';
      return status;
    } catch (cause) {
      loading = null;
      if (mine !== token) return status;
      stop();
      status = 'failed';
      error = cause?.message || String(cause);
      throw cause;
    }
  }

  /* Called once per animation frame with the subtitle time (clock minus delay). */
  function frame(timeS) {
    if (status !== 'ready' || !worker) return;
    if (pending && now() - pending.since > WORKER_TIMEOUT_MS) {
      fail(`PGS decoding did not answer within ${WORKER_TIMEOUT_MS / 1000} s.`);
      return;
    }
    wanted = indexAtTime(times, timeS);
    pump();
  }

  function stop() {
    token += 1;
    loading?.reject(new Error('stopped'));
    loading = null;
    try { worker?.terminate(); } catch { /* already gone */ }
    worker = null;
    unsubscribe?.();
    unsubscribe = null;
    canvas?.remove();
    canvas = null;
    last = null;
    lastLift = 0;
    times = [];
    shown = -2;
    wanted = -2;
    pending = null;
    if (status !== 'failed') status = 'idle';
  }

  return {
    start,
    stop,
    frame,
    status: () => status,
    error: () => error,
    canvas: () => canvas,
    lift: () => lastLift,
    reset() { stop(); status = 'idle'; error = null; },
  };
}
