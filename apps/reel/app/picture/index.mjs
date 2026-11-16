/* Reel feature module: picture (spec rows V1 snapshot, V3 aspect and crop).
 * Contract: docs/build/reel-v1-contract.md. The renderer applies the view (engine area);
 * this module chooses the view, names it, and saves snapshots.
 * No DOM access at module top level, so Node can import COMMANDS for commands.json. */

const none = { type: 'object', properties: {}, required: [] };

/* Aspect presets: the value is display width divided by height, or 'auto'. */
export const ASPECTS = [
  { id: 'auto', value: 'auto' },
  { id: '16:9', value: 16 / 9 },
  { id: '4:3', value: 4 / 3 },
  { id: '2.35:1', value: 2.35 },
  { id: '1:1', value: 1 },
];

/* Crop presets, as fractions of a 16:9 frame removed from each edge.
 * pillarbox: a 4:3 picture inside a 16:9 frame fills 3/4 of the width, so 1/8 goes from each side.
 * letterbox: a 2.35:1 picture inside a 16:9 frame fills (16/9)/2.35 of the height. */
const LETTERBOX_EDGE = (1 - (16 / 9) / 2.35) / 2;
export const CROPS = [
  { id: 'none', value: 'none' },
  { id: 'pillarbox', value: { top: 0, right: 0.125, bottom: 0, left: 0.125 } },
  { id: 'letterbox', value: { top: LETTERBOX_EDGE, right: 0, bottom: LETTERBOX_EDGE, left: 0 } },
];

export const COMMANDS = [
  { name: 'view.snapshot', label: 'Snapshot', scope: 'write', readTwin: 'view.read',
    description: 'Save the current video frame as a PNG at the size the video is drawn; with save false, return it as a data URL instead.',
    input: { type: 'object', properties: {
      save: { type: 'boolean', description: 'false returns the PNG as a data URL and saves nothing; default true' } }, required: [] },
    shortcuts: [{ key: 'shift+s' }] },
  { name: 'view.aspect', label: 'Aspect ratio', scope: 'write', readTwin: 'view.read',
    description: 'Set the display aspect ratio (auto, 16:9, 4:3, 2.35:1 or 1:1); with no input it moves to the next one.',
    input: { type: 'object', properties: {
      mode: { type: 'string', enum: ASPECTS.map(a => a.id) } }, required: [] },
    shortcuts: [{ key: 'a' }] },
  { name: 'view.crop', label: 'Crop', scope: 'write', readTwin: 'view.read',
    description: 'Set the crop (none, pillarbox removes the side bars of 4:3 inside 16:9, letterbox removes the bars of 2.35:1 inside 16:9); with no input it moves to the next one.',
    input: { type: 'object', properties: {
      mode: { type: 'string', enum: CROPS.map(c => c.id) } }, required: [] },
    shortcuts: [{ key: 'c' }] },
  { name: 'view.zoom', label: 'Zoom', scope: 'write', readTwin: 'view.read',
    description: 'Zoom and pan the picture: set scale (1 to 8) and the view centre x, y (0 to 1 across the picture), step in or out, or reset to the whole picture.',
    input: { type: 'object', properties: {
      scale: { type: 'number', minimum: 1, maximum: 8 },
      x: { type: 'number', minimum: 0, maximum: 1, description: 'Centre of the view, 0 left to 1 right' },
      y: { type: 'number', minimum: 0, maximum: 1, description: 'Centre of the view, 0 top to 1 bottom' },
      step: { type: 'integer', enum: [-1, 1], description: '1 zooms in by 25%, -1 zooms out' },
      reset: { type: 'boolean', description: 'true shows the whole picture' } }, required: [] },
    shortcuts: [{ key: 'alt+z', input: { step: 1 } }, { key: 'alt+x', input: { step: -1 } }, { key: 'shift+z', input: { reset: true } }] },
  { name: 'view.adjust', label: 'Picture adjustments', scope: 'write', readTwin: 'view.read',
    description: 'Set brightness (-1 to 1, default 0), contrast (0 to 2, default 1), saturation (0 to 2, default 1) or gamma (0.2 to 5, default 1); reset true restores all four.',
    input: { type: 'object', properties: {
      brightness: { type: 'number', minimum: -1, maximum: 1 },
      contrast: { type: 'number', minimum: 0, maximum: 2 },
      saturation: { type: 'number', minimum: 0, maximum: 2 },
      gamma: { type: 'number', minimum: 0.2, maximum: 5 },
      reset: { type: 'boolean' } }, required: [] } },
  { name: 'view.deinterlace', label: 'Deinterlace', scope: 'write', readTwin: 'view.read',
    description: 'Set deinterlacing: off, blend (mixes the two fields) or bob (rebuilds the picture from one field); with no input it moves to the next one.',
    input: { type: 'object', properties: { mode: { type: 'string', enum: ['off', 'blend', 'bob'] } }, required: [] },
    shortcuts: [{ key: 'e' }] },
  { name: 'view.tonemap', label: 'HDR tone mapping', scope: 'write', readTwin: 'view.read',
    description: 'For HDR10 and HLG video: auto maps HDR to the screen (SDR, or HDR where the display and browser offer it); off clips at SDR white. With no input it toggles.',
    input: { type: 'object', properties: { mode: { type: 'string', enum: ['auto', 'off'] } }, required: [] } },
  { name: 'view.read', label: 'Picture state', scope: 'read', input: none,
    description: 'Read the aspect, crop, zoom, adjustments, deinterlacing and tone mapping chosen, the view the engine applies, the last snapshot, and the Picture-in-Picture state.' },
];

export const ADJUST_DEFAULTS = Object.freeze({ brightness: 0, contrast: 1, saturation: 1, gamma: 1 });
export const ADJUST_RANGES = Object.freeze({
  brightness: [-1, 1, 0.01], contrast: [0, 2, 0.01], saturation: [0, 2, 0.01], gamma: [0.2, 5, 0.01],
});
export const DEINTERLACE_MODES = ['off', 'blend', 'bob'];
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.25;

/* Zoom state after one command input. Pure, exported for tests. The centre stays where the
 * picture still fills the view: x and y lie within half a view width of the edges. */
export function nextZoom(current, { scale, x, y, step, reset } = {}) {
  if (reset) return { scale: 1, x: 0.5, y: 0.5 };
  let next = { ...current };
  if (Number.isFinite(scale)) next.scale = scale;
  if (step === 1) next.scale = current.scale * ZOOM_STEP;
  if (step === -1) next.scale = current.scale / ZOOM_STEP;
  next.scale = Math.min(ZOOM_MAX, Math.max(1, Math.round(next.scale * 1000) / 1000));
  if (Number.isFinite(x)) next.x = x;
  if (Number.isFinite(y)) next.y = y;
  const span = 0.5 / next.scale;
  next.x = Math.min(1 - span, Math.max(span, next.x));
  next.y = Math.min(1 - span, Math.max(span, next.y));
  return next;
}

export function nextAdjust(current, input = {}) {
  if (input.reset) return { ...ADJUST_DEFAULTS };
  const next = { ...current };
  for (const [key, [min, max]] of Object.entries(ADJUST_RANGES)) {
    if (Number.isFinite(input[key])) next[key] = Math.min(max, Math.max(min, input[key]));
  }
  return next;
}

/* Whether the engine marked the video track interlaced (from the container). */
export function trackInterlaced(track) {
  if (!track) return false;
  if (track.interlaced === true) return true;
  const order = String(track.fieldOrder || '').toLowerCase();
  return !!order && order !== 'progressive' && order !== 'unknown';
}

export const STRINGS = {
  'picture.button.snapshot': 'Save a snapshot of this frame',
  'picture.button.menu': 'Picture: aspect ratio and crop',
  'picture.panel.title': 'Picture',
  'picture.panel.aspect': 'Aspect ratio',
  'picture.panel.crop': 'Crop',
  'picture.panel.snapshot': 'Save snapshot (Shift+S)',
  'picture.aspect.auto': 'Auto',
  'picture.aspect.16:9': '16:9',
  'picture.aspect.4:3': '4:3',
  'picture.aspect.2.35:1': '2.35:1',
  'picture.aspect.1:1': '1:1',
  'picture.crop.none': 'No crop',
  'picture.crop.pillarbox': 'Remove side bars (4:3 in 16:9)',
  'picture.crop.letterbox': 'Remove top and bottom bars (2.35:1 in 16:9)',
  'picture.toast.aspect': 'Aspect ratio: {mode}',
  'picture.toast.crop': 'Crop: {mode}',
  'picture.toast.saved': 'Snapshot saved',
  'picture.err.noFrame': 'There is no video frame to save yet.',
  'picture.err.noView': 'This engine cannot change the aspect ratio or crop.',
  'picture.err.badMode': 'Unknown mode: {mode}',
  'picture.panel.zoom': 'Zoom',
  'picture.zoom.in': 'Zoom in (Alt+Z)',
  'picture.zoom.out': 'Zoom out (Alt+X)',
  'picture.zoom.reset': 'Whole picture (Shift+Z)',
  'picture.zoom.hint': 'Drag the picture to move around while zoomed.',
  'picture.toast.zoom': 'Zoom: {percent}%',
  'picture.panel.adjust': 'Adjustments',
  'picture.adjust.brightness': 'Brightness',
  'picture.adjust.contrast': 'Contrast',
  'picture.adjust.saturation': 'Saturation',
  'picture.adjust.gamma': 'Gamma',
  'picture.adjust.reset': 'Reset adjustments',
  'picture.panel.deinterlace': 'Deinterlace (E)',
  'picture.deinterlace.off': 'Off',
  'picture.deinterlace.blend': 'Blend',
  'picture.deinterlace.bob': 'Bob',
  'picture.toast.deinterlace': 'Deinterlace: {mode}',
  'picture.deinterlace.auto': 'This video is interlaced, so deinterlacing is on (blend).',
  'picture.panel.tonemap': 'HDR tone mapping',
  'picture.tonemap.auto': 'Auto',
  'picture.tonemap.off': 'Off (clip)',
  'picture.toast.tonemap': 'HDR tone mapping: {mode}',
  'picture.status.unsupported': 'This browser draws without WebGPU, so this setting has no effect.',
};

/* Pure helpers, exported for tests. */
export function snapshotName(videoName, positionS) {
  const base = String(videoName || 'Reel').replace(/\.[^./\\]+$/, '') || 'Reel';
  const total = Math.max(0, Math.floor(Number(positionS) || 0));
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${pad(Math.floor(total / 3600))}-${pad(Math.floor(total / 60) % 60)}-${pad(total % 60)}`;
  return `${base} ${stamp}.png`.replace(/[\\/:*?"<>|]/g, '_');
}

export function nextIndex(list, currentId, mode) {
  if (mode === undefined) return (list.findIndex(item => item.id === currentId) + 1) % list.length;
  const index = list.findIndex(item => item.id === mode);
  if (index < 0) throw Object.assign(new TypeError(`Unknown mode: ${mode}`), { code: 'ERR_COMMAND_INPUT' });
  return index;
}

function dataUrlBytes(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* PNG width and height sit in the IHDR chunk at bytes 16 to 23, big-endian. */
export function pngSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 24 || view.getUint32(0) !== 0x89504e47) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function install(ctx) {
  const { Engine, store, t, registry } = ctx;
  const state = store.ui.picture = {
    aspect: 'auto', crop: 'none', name: null, lastSnapshot: null,
    zoom: { scale: 1, x: 0.5, y: 0.5 }, adjust: { ...ADJUST_DEFAULTS }, deinterlace: 'off', tonemap: 'auto',
  };
  // Held once: during Document Picture-in-Picture the canvas lives in another document,
  // where ctx.canvas() (a lookup in this document) returns null.
  const videoCanvas = ctx.canvas();

  function applyView() {
    if (typeof Engine.setView !== 'function') {
      throw Object.assign(new Error(t('picture.err.noView')), { code: 'ERR_VIEW_UNSUPPORTED' });
    }
    Engine.setView({
      aspect: ASPECTS.find(a => a.id === state.aspect).value,
      crop: CROPS.find(c => c.id === state.crop).value,
      zoom: { ...state.zoom },
      adjust: { ...state.adjust },
      deinterlace: state.deinterlace,
      tonemap: state.tonemap,
    });
    render();
  }

  /* Engine.snapshot() returns a PNG data URL (Canvas2D) or a Promise of a PNG Blob or data URL (WebGPU). */
  async function takeSnapshot() {
    const canvas = videoCanvas;
    if (!store.media?.name || !canvas || canvas.width <= 1 || canvas.height <= 1) {
      throw Object.assign(new Error(t('picture.err.noFrame')), { code: 'ERR_NO_FRAME' });
    }
    const raw = await (typeof Engine.snapshot === 'function' ? Engine.snapshot() : canvas.toDataURL('image/png'));
    let dataUrl;
    let bytes;
    if (raw instanceof Blob) {
      bytes = new Uint8Array(await raw.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      dataUrl = `data:image/png;base64,${btoa(binary)}`;
    } else {
      dataUrl = String(raw);
      bytes = dataUrlBytes(dataUrl);
    }
    const size = pngSize(bytes) || { width: canvas.width, height: canvas.height };
    return { dataUrl, bytes, ...size };
  }

  async function saveBlob(blob, name) {
    if (typeof globalThis.showSaveFilePicker === 'function') {
      try {
        const handle = await globalThis.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return 'file-picker';
      } catch (error) {
        if (error?.name === 'AbortError') return 'cancelled';
        // SecurityError in a cross-origin iframe, or no user activation: fall back to a download.
      }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return 'download';
  }

  registry.handle('view.snapshot', async ({ save }) => {
    const shot = await takeSnapshot();
    const positionS = Engine.state().clock?.positionS ?? store.clock?.positionS ?? 0;
    const name = snapshotName(state.name || store.media?.name, positionS);
    const result = { name, width: shot.width, height: shot.height, positionS, burnedCaptions: false };
    if (save === false) {
      state.lastSnapshot = { ...result, saved: 'not-saved' };
      return { ...result, dataUrl: shot.dataUrl };
    }
    const saved = await saveBlob(new Blob([shot.bytes], { type: 'image/png' }), name);
    state.lastSnapshot = { ...result, saved };
    if (saved !== 'cancelled') ctx.toast(t('picture.toast.saved'), 'info', name);
    return { ...result, saved };
  });

  registry.handle('view.aspect', ({ mode }) => {
    state.aspect = ASPECTS[nextIndex(ASPECTS, state.aspect, mode)].id;
    applyView();
    ctx.toast(t('picture.toast.aspect', { mode: t(`picture.aspect.${state.aspect}`) }));
    return readState();
  });

  registry.handle('view.crop', ({ mode }) => {
    state.crop = CROPS[nextIndex(CROPS, state.crop, mode)].id;
    applyView();
    ctx.toast(t('picture.toast.crop', { mode: t(`picture.crop.${state.crop}`) }));
    return readState();
  });

  registry.handle('view.zoom', input => {
    const before = state.zoom.scale;
    state.zoom = nextZoom(state.zoom, input);
    applyView();
    if (state.zoom.scale !== before || input.reset) {
      ctx.toast(t('picture.toast.zoom', { percent: Math.round(state.zoom.scale * 100) }));
    }
    return readState();
  });

  registry.handle('view.adjust', input => {
    state.adjust = nextAdjust(state.adjust, input);
    applyView();
    return readState();
  });

  registry.handle('view.deinterlace', ({ mode }) => {
    if (mode !== undefined && !DEINTERLACE_MODES.includes(mode)) {
      throw Object.assign(new TypeError(t('picture.err.badMode', { mode })), { code: 'ERR_COMMAND_INPUT' });
    }
    state.deinterlace = mode ?? DEINTERLACE_MODES[(DEINTERLACE_MODES.indexOf(state.deinterlace) + 1) % DEINTERLACE_MODES.length];
    applyView();
    ctx.toast(t('picture.toast.deinterlace', { mode: t(`picture.deinterlace.${state.deinterlace}`) }));
    return readState();
  });

  registry.handle('view.tonemap', ({ mode }) => {
    if (mode !== undefined && mode !== 'auto' && mode !== 'off') {
      throw Object.assign(new TypeError(t('picture.err.badMode', { mode })), { code: 'ERR_COMMAND_INPUT' });
    }
    state.tonemap = mode ?? (state.tonemap === 'auto' ? 'off' : 'auto');
    applyView();
    ctx.toast(t('picture.toast.tonemap', { mode: t(`picture.tonemap.${state.tonemap}`) }));
    return readState();
  });

  function readState() {
    let engineView = null;
    try { engineView = Engine.state().view ?? null; } catch { engineView = null; }
    return {
      aspect: state.aspect,
      crop: state.crop,
      zoom: { ...state.zoom },
      adjust: { ...state.adjust },
      deinterlace: state.deinterlace,
      tonemap: state.tonemap,
      engineView,
      lastSnapshot: state.lastSnapshot,
      pip: store.ui.platform?.pip ?? null,
    };
  }
  registry.handle('view.read', () => readState());

  /* ---- UI: a snapshot button, a picture-menu button and a side panel listing both cycles. */
  ctx.addStyle(`
    .picture-panel fieldset{border:0;margin:0 0 14px;padding:0}
    .picture-panel legend{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin-bottom:6px}
    .picture-panel .picture-options{display:flex;flex-wrap:wrap;gap:6px}
    .picture-panel button{font:inherit;font-size:12px;color:var(--text);background:transparent;border:1px solid var(--line);border-radius:8px;padding:6px 10px;cursor:pointer}
    .picture-panel button[aria-pressed="true"]{border-color:var(--accent);color:var(--accent)}
    .picture-panel button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  `);

  const run = (name, input) => Promise.resolve(registry.run(name, input)).catch(error => ctx.surface('picture', error));

  const snapButton = document.createElement('button');
  snapButton.type = 'button';
  snapButton.textContent = '📷';
  snapButton.setAttribute('aria-label', t('picture.button.snapshot'));
  snapButton.title = t('picture.button.snapshot');
  snapButton.dataset.command = 'view.snapshot';
  snapButton.addEventListener('click', () => run('view.snapshot', {}));

  const menuButton = document.createElement('button');
  menuButton.type = 'button';
  menuButton.textContent = '▭';
  menuButton.setAttribute('aria-label', t('picture.button.menu'));
  menuButton.title = t('picture.button.menu');
  menuButton.setAttribute('aria-expanded', 'false');
  // Opening the panel shows the picture state, so the button maps to the read command.
  menuButton.dataset.command = 'view.read';
  menuButton.addEventListener('click', () => ctx.panels.toggle('picture'));
  ctx.mounts.controlsRight.append(snapButton, menuButton);

  const body = ctx.panels.register('picture', t('picture.panel.title'));
  body.classList.add('picture-panel');
  const optionButtons = { aspect: new Map(), crop: new Map() };
  function group(kind, legendKey, list, command) {
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = t(legendKey);
    const row = document.createElement('div');
    row.className = 'picture-options';
    for (const item of list) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = t(`picture.${kind}.${item.id}`);
      button.setAttribute('aria-pressed', 'false');
      button.dataset.command = command;
      button.addEventListener('click', () => run(command, { mode: item.id }));
      optionButtons[kind].set(item.id, button);
      row.append(button);
    }
    fieldset.append(legend, row);
    return fieldset;
  }
  const panelSnap = document.createElement('button');
  panelSnap.type = 'button';
  panelSnap.textContent = t('picture.panel.snapshot');
  panelSnap.dataset.command = 'view.snapshot';
  panelSnap.addEventListener('click', () => run('view.snapshot', {}));
  // Group helper for the v1.x mode rows (deinterlace, tone mapping), same shape as aspect and crop.
  optionButtons.deinterlace = new Map();
  optionButtons.tonemap = new Map();
  const modeList = ids => ids.map(id => ({ id }));

  function smallButton(labelKey, command, input) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = t(labelKey);
    button.dataset.command = command;
    button.addEventListener('click', () => run(command, input));
    return button;
  }

  // Zoom: in, out, whole picture, and the current scale.
  const zoomSet = document.createElement('fieldset');
  const zoomLegend = document.createElement('legend');
  zoomLegend.textContent = t('picture.panel.zoom');
  const zoomRow = document.createElement('div');
  zoomRow.className = 'picture-options';
  const zoomReadout = document.createElement('output');
  zoomReadout.className = 'picture-readout';
  zoomRow.append(smallButton('picture.zoom.out', 'view.zoom', { step: -1 }),
    smallButton('picture.zoom.in', 'view.zoom', { step: 1 }),
    smallButton('picture.zoom.reset', 'view.zoom', { reset: true }), zoomReadout);
  const zoomHint = document.createElement('p');
  zoomHint.className = 'picture-hint';
  zoomHint.textContent = t('picture.zoom.hint');
  zoomSet.append(zoomLegend, zoomRow, zoomHint);

  // Adjustments: one labelled slider each, and a reset.
  const adjustSet = document.createElement('fieldset');
  const adjustLegend = document.createElement('legend');
  adjustLegend.textContent = t('picture.panel.adjust');
  adjustSet.append(adjustLegend);
  const sliders = new Map();
  for (const [key, [min, max, step]] of Object.entries(ADJUST_RANGES)) {
    const label = document.createElement('label');
    label.className = 'picture-slider';
    const name = document.createElement('span');
    name.textContent = t(`picture.adjust.${key}`);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.dataset.command = 'view.adjust';
    const value = document.createElement('output');
    input.addEventListener('input', () => run('view.adjust', { [key]: Number(input.value) }));
    label.append(name, input, value);
    sliders.set(key, { input, value });
    adjustSet.append(label);
  }
  adjustSet.append(smallButton('picture.adjust.reset', 'view.adjust', { reset: true }));

  const status = document.createElement('p');
  status.className = 'picture-hint';
  status.hidden = true;

  body.append(group('aspect', 'picture.panel.aspect', ASPECTS, 'view.aspect'),
    group('crop', 'picture.panel.crop', CROPS, 'view.crop'), zoomSet, adjustSet,
    group('deinterlace', 'picture.panel.deinterlace', modeList(DEINTERLACE_MODES), 'view.deinterlace'),
    group('tonemap', 'picture.panel.tonemap', modeList(['auto', 'off']), 'view.tonemap'), status, panelSnap);

  ctx.addStyle(`
    .picture-panel .picture-readout{align-self:center;font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums;margin-left:4px}
    .picture-panel .picture-hint{font-size:11px;color:var(--faint);margin-top:6px}
    .picture-panel .picture-slider{display:grid;grid-template-columns:80px 1fr 38px;align-items:center;gap:8px;font-size:12px;margin-bottom:6px}
    .picture-panel .picture-slider input{accent-color:var(--accent);width:100%}
    .picture-panel .picture-slider output{font-variant-numeric:tabular-nums;color:var(--dim);text-align:right}
    .picture-panning, .picture-panning *{cursor:grabbing !important}
    .picture-zoomed .platform-hit{cursor:grab}
  `);

  function render() {
    for (const kind of ['aspect', 'crop', 'deinterlace', 'tonemap']) {
      for (const [id, button] of optionButtons[kind]) button.setAttribute('aria-pressed', String(id === state[kind]));
    }
    zoomReadout.textContent = `${Math.round(state.zoom.scale * 100)}%`;
    for (const [key, { input, value }] of sliders) {
      if (document.activeElement !== input) input.value = String(state.adjust[key]);
      value.textContent = state.adjust[key].toFixed(2);
    }
    stageBox?.classList.toggle('picture-zoomed', state.zoom.scale > 1);
    // Canvas2D fallback: the engine reports deinterlace and tone mapping as unsupported.
    let view = null;
    try { view = Engine.state().view; } catch { view = null; }
    status.hidden = !(view && (view.deinterlace === 'unsupported' || view.tonemap === 'unsupported'));
    status.textContent = t('picture.status.unsupported');
  }

  /* ---- drag to pan while zoomed. The platform module's transparent hit layer covers the picture;
   * a capture listener on the stage box sees the press first, and a drag of more than 4 px
   * pans and swallows the click, so a drag never also toggles play. */
  const stageBox = ctx.mounts.stage.parentElement;
  let drag = null;
  let swallowClick = false;
  function pictureBox() {
    const rect = videoCanvas.getBoundingClientRect();
    const fit = Math.min(rect.width / videoCanvas.width, rect.height / videoCanvas.height) || 1;
    return { width: videoCanvas.width * fit, height: videoCanvas.height * fit };
  }
  stageBox?.addEventListener('pointerdown', event => {
    if (state.zoom.scale <= 1 || event.button !== 0 || !event.target.classList?.contains('platform-hit')) return;
    drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, zoom: { ...state.zoom }, moved: false };
  }, true);
  stageBox?.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      stageBox.classList.add('picture-panning');
      try { event.target.setPointerCapture?.(event.pointerId); } catch { /* capture is optional */ }
    }
    const box = pictureBox();
    run('view.zoom', {
      x: drag.zoom.x - dx / (box.width * drag.zoom.scale),
      y: drag.zoom.y - dy / (box.height * drag.zoom.scale),
    });
  }, true);
  const endDrag = event => {
    if (!drag || event.pointerId !== drag.id) return;
    swallowClick = drag.moved;
    drag = null;
    stageBox.classList.remove('picture-panning');
  };
  stageBox?.addEventListener('pointerup', endDrag, true);
  stageBox?.addEventListener('pointercancel', endDrag, true);
  stageBox?.addEventListener('click', event => {
    if (!swallowClick) return;
    swallowClick = false;
    event.stopPropagation();
    event.preventDefault();
  }, true);

  render();

  ctx.on('ui:panel', ({ id }) => menuButton.setAttribute('aria-expanded', String(id === 'picture')));

  /* Persist nothing across files: every new file starts at Auto, no crop, no zoom, neutral
   * adjustments and tone mapping on. Deinterlacing starts on (blend) when the engine marks
   * the video track interlaced. */
  function reset(interlaced = false) {
    state.aspect = 'auto';
    state.crop = 'none';
    state.lastSnapshot = null;
    state.zoom = { scale: 1, x: 0.5, y: 0.5 };
    state.adjust = { ...ADJUST_DEFAULTS };
    state.deinterlace = interlaced ? 'blend' : 'off';
    state.tonemap = 'auto';
    if (typeof Engine.setView === 'function') {
      try { applyView(); } catch { /* nothing loaded, or an engine without the v1.x view fields */ }
    }
    render();
  }
  ctx.on('ui:media-loaded', ({ name }) => {
    state.name = name || null;
    let track = null;
    try { track = Engine.state().tracks?.video?.[0] ?? null; } catch { track = null; }
    const interlaced = trackInterlaced(track);
    reset(interlaced);
    if (interlaced) ctx.toast(t('picture.deinterlace.auto'));
  });
  ctx.on('ui:media-cleared', () => { state.name = null; reset(); });
  ctx.on('playback:view', () => render());
}
