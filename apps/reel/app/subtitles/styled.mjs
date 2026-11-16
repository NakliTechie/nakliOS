/* Styled ASS/SSA rendering through JASSUB 1.8.8 (vendor/jassub/), loaded only when an ASS
 * track is shown with the styled renderer. Reel has no <video> element, so JASSUB runs in
 * canvas mode and Reel's clock drives each render (the on-demand path that JASSUB normally
 * feeds from requestVideoFrameCallback). Online and local font lookup stay off: libass sees
 * the file's attached fonts plus the bundled Liberation Sans (SIL OFL 1.1) as the fallback.
 *
 * JASSUB 1.8.8 has no public manual-render call; this wrapper uses its documented
 * demand-render fields (_videoWidth, _videoHeight, busy, _demandRender), pinned by the
 * vendored version. */

const VENDOR = '../../vendor/jassub/';
const READY_TIMEOUT_MS = 20_000;

function vendorUrl(name) {
  return new URL(`${VENDOR}${name}`, import.meta.url).href;
}

export function createStyledRenderer({ layer, onLayout }) {
  let jassub = null;
  let canvas = null;
  let status = 'idle';
  let error = null;
  let lastTime = NaN;
  let lastSize = '';
  let unsubscribe = null;
  let token = 0;

  function size(rect) {
    if (!jassub || !rect?.width || !rect?.height) return;
    const dpr = globalThis.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    const videoWidth = rect.pictureWidth || width;
    const videoHeight = rect.pictureHeight || height;
    const key = `${width}x${height}:${videoWidth}x${videoHeight}`;
    if (key === lastSize) return;
    lastSize = key;
    jassub._videoWidth = videoWidth;
    jassub._videoHeight = videoHeight;
    jassub.resize(width, height, 0, 0);
    lastTime = NaN;
  }

  async function start({ content, fonts = [] }) {
    stop();
    const mine = ++token;
    status = 'loading';
    error = null;
    try {
      const { default: JASSUB } = await import(`${VENDOR}jassub.es.js`);
      if (mine !== token) return status;
      canvas = document.createElement('canvas');
      canvas.className = 'reel-subs-styled';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
      layer.prepend(canvas);
      jassub = new JASSUB({
        canvas,
        subContent: content,
        workerUrl: vendorUrl('jassub-worker.js'),
        wasmUrl: vendorUrl('jassub-worker.wasm'),
        modernWasmUrl: vendorUrl('jassub-worker-modern.wasm'),
        legacyWasmUrl: vendorUrl('jassub-worker.wasm'),
        fonts,
        availableFonts: { 'liberation sans': vendorUrl('default.woff2') },
        fallbackFont: 'liberation sans',
        useLocalFonts: false,
        onDemandRender: true,
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('JASSUB did not start within 20 s.')), READY_TIMEOUT_MS);
        jassub.addEventListener('ready', () => { clearTimeout(timer); resolve(); }, { once: true });
        jassub.addEventListener('error', event => { clearTimeout(timer); reject(event.error || new Error('JASSUB failed.')); }, { once: true });
      });
      if (mine !== token) return status;
      status = 'ready';
      lastSize = '';
      unsubscribe = onLayout(size);
      return status;
    } catch (cause) {
      if (mine !== token) return status;
      stop();
      status = 'failed';
      error = cause?.message || String(cause);
      throw cause;
    }
  }

  /* Called once per animation frame with the subtitle time (clock minus delay). */
  function frame(timeS, { paused = true, rate = 1 } = {}) {
    if (status !== 'ready' || !jassub) return;
    if (jassub._onDemandRender) {
      if (timeS === lastTime || jassub.busy) return;
      lastTime = timeS;
      jassub.busy = true;
      jassub._demandRender({ mediaTime: timeS, width: jassub._videoWidth, height: jassub._videoHeight });
    } else if (timeS !== lastTime) {
      lastTime = timeS;
      jassub.setCurrentTime(paused, timeS, rate);
    }
  }

  function stop() {
    token += 1;
    unsubscribe?.();
    unsubscribe = null;
    try { jassub?.destroy(); } catch { /* already gone */ }
    jassub = null;
    canvas?.remove();
    canvas = null;
    lastTime = NaN;
    lastSize = '';
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
