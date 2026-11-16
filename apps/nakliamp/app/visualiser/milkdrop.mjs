// Milkdrop presets through Butterchurn (parity row V3).
//
// Butterchurn 3 renders WebGL 2 into its own internal canvas and copies each
// frame into the output canvas through a 2D context. The output canvas is
// therefore the visualiser's existing 2D canvas: no second canvas, no context
// clash, no DOM change.
//
// Audio: Butterchurn's `connectAudio` connects the given node to its own delay
// and analysers. We hand it the engine's analyser. An AnalyserNode's output is
// its input unchanged, so this is a fan-out tap: nothing is inserted in series
// with the output, and disconnecting removes only Butterchurn's branch.
//
// Loading: the vendored module (about 240 KB) and the presets load only when
// Milkdrop first runs. The `new URL(..., import.meta.url)` form is one the
// single-file builder already follows, so the builder inlines both files and
// the loader instantiates them only on `import()`.
//
// Preset equations are compiled to WebAssembly (`onlyUseWASM`), never through
// `new Function`, so the page needs `'wasm-unsafe-eval'` and never
// `'unsafe-eval'`. Without it, `checkSupport` refuses by name.

const BUTTERCHURN_URL = new URL('../../vendor/butterchurn/butterchurn-3.0.0-beta.5.min.mjs', import.meta.url);
const PRESETS_URL = new URL('../../vendor/butterchurn/presets-3.0.0-beta.4.mjs', import.meta.url);

// The smallest valid WebAssembly module: magic number and version.
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

export const DEFAULT_INTERVAL_S = 20;
export const DEFAULT_BLEND_S = 2.7;
// Under reduced motion presets change less often, and the animation clock runs
// slowly (see the driver): slower, not stopped.
export const REDUCED_MOTION_INTERVAL_FACTOR = 3;

function defaultCreateCanvas() {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1);
  return globalThis.document?.createElement('canvas') ?? null;
}

/** True when a WebGL 2 context can be created; the probe context is released. */
function probeWebGl2(createCanvas) {
  let gl = null;
  try {
    gl = createCanvas()?.getContext?.('webgl2') ?? null;
  } catch {
    gl = null;
  }
  if (!gl) return false;
  // Release the probe context now; browsers cap live WebGL contexts.
  try { gl.getExtension?.('WEBGL_lose_context')?.loseContext(); } catch { /* best effort */ }
  return true;
}

/**
 * Can Milkdrop run here? Returns `{ ok: true }` or `{ ok: false, reason }`
 * with a sentence a person can act on. Both dependencies are injectable so the
 * refusal paths are testable without a GPU.
 */
export function checkSupport({ createCanvas = defaultCreateCanvas, wasm = globalThis.WebAssembly } = {}) {
  if (!probeWebGl2(createCanvas)) {
    return { ok: false, reason: 'Milkdrop needs WebGL 2, which this browser or device does not provide.' };
  }
  if (!wasm?.Module) {
    return { ok: false, reason: 'Milkdrop needs WebAssembly, which this browser does not provide.' };
  }
  try {
    // eslint-disable-next-line no-new
    new wasm.Module(EMPTY_WASM);
  } catch {
    return {
      ok: false,
      reason: "Milkdrop needs WebAssembly to run preset equations, and this page's security policy blocks it.",
    };
  }
  return { ok: true };
}

export function isSupported(env) {
  return checkSupport(env).ok;
}

/**
 * Preset rotation as pure state over an injected clock.
 * `intervalMs` is read on each check so reduced motion can change it live.
 */
export function createPresetCycler({ count, intervalMs, now }) {
  if (!Number.isInteger(count) || count < 0) throw new TypeError('count must be a non-negative integer');
  const interval = typeof intervalMs === 'function' ? intervalMs : () => intervalMs;
  let index = 0;
  let changedAt = now();
  return {
    get index() { return index; },
    get count() { return count; },
    /** True when the current preset has been shown for a full interval. */
    due() {
      return count > 1 && now() - changedAt >= interval();
    },
    /** Move by `step` (wrapping) and restart the interval. */
    advance(step = 1) {
      if (count > 0) index = (((index + step) % count) + count) % count;
      changedAt = now();
      return index;
    },
    /** Restart the interval without moving, e.g. after a preset loaded from disk. */
    hold() {
      changedAt = now();
    },
  };
}

/**
 * Check a preset JSON from disk before Butterchurn sees it, so a wrong file is
 * refused with a reason rather than a console warning and a frozen picture.
 */
export function parsePresetJson(text) {
  let preset;
  try {
    preset = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new Error('That file is not valid JSON, so it is not a Butterchurn preset.');
  }
  if (!preset || typeof preset !== 'object' || !preset.baseVals || !Array.isArray(preset.shapes) || !Array.isArray(preset.waves)) {
    throw new Error('That JSON file is not a Butterchurn preset (it has no baseVals, shapes and waves).');
  }
  if (!Object.prototype.hasOwnProperty.call(preset, 'init_eqs_eel')) {
    throw new Error('That preset is in the older Butterchurn 2 format. NakliAmp loads Butterchurn 3 presets, which carry *_eqs_eel fields.');
  }
  return preset;
}

async function defaultLoadButterchurn() {
  const module = await import(BUTTERCHURN_URL.href);
  return module.default;
}

async function defaultLoadPresets() {
  const module = await import(PRESETS_URL.href);
  return module.PRESETS;
}

/**
 * Create a Milkdrop renderer on `canvas`, fed from `sourceNode` on
 * `audioContext`. Throws synchronously with the support reason when it cannot
 * run. Everything after that is asynchronous: `ready` settles when the first
 * preset is showing, and `render` does nothing until then.
 */
export function createMilkdrop({
  canvas,
  audioContext,
  sourceNode,
  intervalS = DEFAULT_INTERVAL_S,
  blendS = DEFAULT_BLEND_S,
  reducedMotion = () => false,
  now = () => performance.now(),
  support = checkSupport,
  loadButterchurn = defaultLoadButterchurn,
  loadPresets = defaultLoadPresets,
}) {
  const verdict = support();
  if (!verdict.ok) throw new Error(verdict.reason);

  let visualizer = null;
  let presets = [];
  let cycler = null;
  let connected = null;
  let width = 0;
  let height = 0;
  let destroyed = false;
  let loading = null; // the preset load in flight, so changes never overlap
  let currentName = '';

  const intervalMs = () => intervalS * 1000 * (reducedMotion() ? REDUCED_MOTION_INTERVAL_FACTOR : 1);

  function connect(node) {
    if (!visualizer || node === connected) return;
    disconnect();
    if (!node) return;
    visualizer.connectAudio(node);
    connected = node;
  }

  function disconnect() {
    if (!visualizer || !connected) return;
    try { visualizer.disconnectAudio(connected); } catch { /* the node may already be gone */ }
    connected = null;
  }

  async function show(preset, name, blend) {
    // Wait out a load in flight: two overlapping WASM compiles would race to
    // install, and the loser's name would be shown over the winner's picture.
    if (loading) await loading.catch(() => {});
    if (destroyed) return;
    loading = visualizer.loadPreset(preset, blend);
    try {
      await loading;
      currentName = name;
    } finally {
      loading = null;
    }
  }

  async function showCurrent(blend) {
    // A preset that fails to compile is skipped, not fatal, unless every one fails.
    for (let tries = 0; tries < presets.length; tries += 1) {
      const entry = presets[cycler.index];
      try {
        await show(entry.preset, entry.name, blend);
        return;
      } catch (error) {
        if (tries === presets.length - 1) throw error;
        cycler.advance(1);
      }
    }
  }

  const ready = (async () => {
    const [Butterchurn, list] = await Promise.all([loadButterchurn(), loadPresets()]);
    if (destroyed) return;
    presets = list;
    width = Math.max(1, canvas.width | 0);
    height = Math.max(1, canvas.height | 0);
    visualizer = Butterchurn.createVisualizer(audioContext, canvas, {
      width,
      height,
      pixelRatio: 1, // the driver already sized the canvas for the display
      textureRatio: 1,
      onlyUseWASM: true,
    });
    cycler = createPresetCycler({ count: presets.length, intervalMs, now });
    connect(sourceNode);
    if (presets.length) await showCurrent(0);
  })();

  return {
    ready,
    audioContext,
    get loaded() { return Boolean(visualizer) && !destroyed; },
    presetName: () => currentName,
    presetNames: () => presets.map(entry => entry.name),

    /** Point Butterchurn at another analyser on the same context. */
    setSource(node) {
      if (node && node.context && node.context !== audioContext) return false;
      connect(node);
      return true;
    },

    /** Draw one frame. `elapsedS` is the animation time step. */
    render({ width: nextWidth, height: nextHeight, elapsedS } = {}) {
      if (!visualizer || destroyed) return false;
      if (nextWidth && nextHeight && (nextWidth !== width || nextHeight !== height)) {
        width = nextWidth;
        height = nextHeight;
        visualizer.setRendererSize(width, height, { pixelRatio: 1, textureRatio: 1 });
      }
      if (!loading && cycler?.due()) {
        cycler.advance(1);
        showCurrent(blendS).catch(() => {});
      }
      visualizer.render(elapsedS > 0 ? { elapsedTime: elapsedS } : undefined);
      return true;
    },

    async nextPreset(step = 1) {
      await ready;
      if (!presets.length) return currentName;
      cycler.advance(step);
      await showCurrent(blendS);
      return currentName;
    },

    /** Load a preset JSON from disk. Throws with a reason when it is not one. */
    async loadPresetJson(text, name = 'Preset from disk') {
      const preset = parsePresetJson(text);
      await ready;
      await show(preset, name, blendS);
      cycler?.hold();
      return currentName;
    },

    /** Stop listening without discarding the WebGL state. */
    pause() {
      disconnect();
    },

    destroy() {
      destroyed = true;
      disconnect();
      try { visualizer?.loseGLContext(); } catch { /* best effort */ }
      visualizer = null;
    },
  };
}
