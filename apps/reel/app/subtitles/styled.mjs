/* Styled ASS/SSA rendering through JASSUB 1.8.8 (vendor/jassub/), loaded only when an ASS
 * track is shown with the styled renderer. Reel has no <video> element, so JASSUB runs in
 * canvas mode and Reel's clock drives each render (the on-demand path that JASSUB normally
 * feeds from requestVideoFrameCallback). Online and local font lookup stay off: libass sees
 * the file's attached fonts plus the bundled Liberation Sans (SIL OFL 1.1) as the fallback.
 *
 * JASSUB 1.8.8 has no public manual-render call; this wrapper uses its documented
 * demand-render fields (_videoWidth, _videoHeight, busy, _demandRender), pinned by the
 * vendored version.
 *
 * Failure after start (review finding V19): an error listener stays on the JASSUB instance for
 * the worker's life, and a watchdog fails the renderer when a render stays busy for longer than
 * BUSY_TIMEOUT_MS. Either calls onFailure(message), so the caller shows plain text again.
 * libass caches are capped through libassMemoryLimit and libassGlyphLimit (MiB). */

const VENDOR = '../../vendor/jassub/';
const READY_TIMEOUT_MS = 20_000;
export const BUSY_TIMEOUT_MS = 8000;
export const LIBASS_LIMITS = Object.freeze({ libassMemoryLimit: 64, libassGlyphLimit: 32 });
export const FONT_LIMITS = Object.freeze({ files: 64, bytes: 64 * 1024 * 1024 });
const FONT_NAME = /\.(ttf|otf|ttc|woff2?)$/i;
const FONT_TYPE = /font|truetype|opentype|woff/i;

/* Picks the fonts to hand to libass from a file's attachments (review finding V17). Only font
 * attachments count; cover images and other files are ignored. At most limits.files fonts and
 * limits.bytes in all are kept, in file order. A font the engine left without data (it was over
 * the engine's size limit) counts as dropped. Returns views of the engine's bytes, never copies:
 * { fonts: Uint8Array[], dropped }. */
export function pickFonts(attachments, limits = FONT_LIMITS) {
  const fonts = [];
  let dropped = 0;
  let total = 0;
  for (const item of attachments || []) {
    if (!item || !(FONT_TYPE.test(item.mimeType || '') || FONT_NAME.test(item.name || ''))) continue;
    const data = item.data instanceof Uint8Array ? item.data : item.data instanceof ArrayBuffer ? new Uint8Array(item.data) : null;
    if (!data || !data.length || fonts.length >= limits.files || total + data.length > limits.bytes) { dropped += 1; continue; }
    total += data.length;
    fonts.push(data);
  }
  return { fonts, dropped };
}

function vendorUrl(name) {
  return new URL(`${VENDOR}${name}`, import.meta.url).href;
}

const defaultLoad = async () => (await import(`${VENDOR}jassub.es.js`)).default;
const defaultCanvas = () => document.createElement('canvas');

export function createStyledRenderer({
  layer,
  onLayout,
  onFailure = () => {},
  loadJassub = defaultLoad,
  createCanvas = defaultCanvas,
  now = () => performance.now(),
}) {
  let jassub = null;
  let busySince = null;
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
      const JASSUB = await loadJassub();
      if (mine !== token) return status;
      canvas = createCanvas();
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
        ...LIBASS_LIMITS,
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('JASSUB did not start within 20 s.')), READY_TIMEOUT_MS);
        jassub.addEventListener('ready', () => { clearTimeout(timer); resolve(); }, { once: true });
        jassub.addEventListener('error', event => { clearTimeout(timer); reject(event.error || new Error('JASSUB failed.')); }, { once: true });
      });
      if (mine !== token) return status;
      const instance = jassub;
      instance.addEventListener('error', event => {
        if (mine !== token || jassub !== instance) return;
        fail(event?.error?.message || event?.message || 'JASSUB failed.');
      });
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

  function fail(message) {
    stop();
    status = 'failed';
    error = message;
    onFailure(message);
  }

  /* Called once per animation frame with the subtitle time (clock minus delay). */
  function frame(timeS, { paused = true, rate = 1 } = {}) {
    if (status !== 'ready' || !jassub) return;
    if (jassub.busy) {
      busySince ??= now();
      if (now() - busySince > BUSY_TIMEOUT_MS) {
        fail(`JASSUB stopped answering (busy for more than ${BUSY_TIMEOUT_MS / 1000} s).`);
        return;
      }
    } else {
      busySince = null;
    }
    if (jassub._onDemandRender) {
      if (timeS === lastTime || jassub.busy) return;
      lastTime = timeS;
      jassub.busy = true;
      busySince = now();
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
    busySince = null;
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
