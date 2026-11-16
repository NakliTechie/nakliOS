/* PGS bitmap subtitles through libpgs-js 0.9.0 (vendor/libpgs/), loaded only when a PGS
 * track or .sup file is shown. Main-thread mode: PGS decoding is light, it needs no second
 * vendored worker file, and the canvas stays readable for the checks. */

export function createBitmapRenderer({ layer }) {
  let renderer = null;
  let canvas = null;
  let status = 'idle';
  let error = null;
  let lastTime = NaN;
  let token = 0;

  async function start(bytes) {
    stop();
    const mine = ++token;
    status = 'loading';
    error = null;
    try {
      const { PgsRenderer } = await import('../../vendor/libpgs/libpgs.js');
      if (mine !== token) return status;
      canvas = document.createElement('canvas');
      canvas.className = 'reel-subs-bitmap';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;object-fit:contain';
      layer.prepend(canvas);
      renderer = new PgsRenderer({ canvas, mode: 'mainThread', aspectRatio: 'contain' });
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      await renderer.loadFromBuffer(buffer);
      if (mine !== token) return status;
      // libpgs starts at display index 0 and skips a render whose index is unchanged, so a
      // first time inside the first image would never draw. Index -1 (before any image) resets it.
      renderer.renderAtTimestamp(-1);
      status = 'ready';
      return status;
    } catch (cause) {
      if (mine !== token) return status;
      stop();
      status = 'failed';
      error = cause?.message || String(cause);
      throw cause;
    }
  }

  function frame(timeS) {
    if (status !== 'ready' || !renderer || timeS === lastTime) return;
    lastTime = timeS;
    renderer.renderAtTimestamp(timeS);
  }

  function stop() {
    token += 1;
    try { renderer?.dispose(); } catch { /* already gone */ }
    renderer = null;
    canvas?.remove();
    canvas = null;
    lastTime = NaN;
    if (status !== 'failed') status = 'idle';
  }

  return {
    start,
    stop,
    frame,
    status: () => status,
    error: () => error,
    canvas: () => canvas,
    reset() { stop(); status = 'idle'; error = null; },
  };
}
