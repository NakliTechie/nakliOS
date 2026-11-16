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
  { name: 'view.read', label: 'Picture state', scope: 'read', input: none,
    description: 'Read the aspect and crop chosen, the view the engine applies, the last snapshot, and the Picture-in-Picture state.' },
];

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
  const state = store.ui.picture = { aspect: 'auto', crop: 'none', name: null, lastSnapshot: null };
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
    });
    render();
  }

  function takeSnapshot() {
    const canvas = videoCanvas;
    if (!store.media?.name || !canvas || canvas.width <= 1 || canvas.height <= 1) {
      throw Object.assign(new Error(t('picture.err.noFrame')), { code: 'ERR_NO_FRAME' });
    }
    const dataUrl = typeof Engine.snapshot === 'function' ? Engine.snapshot() : canvas.toDataURL('image/png');
    const bytes = dataUrlBytes(dataUrl);
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
    const shot = takeSnapshot();
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

  function readState() {
    let engineView = null;
    try { engineView = Engine.state().view ?? null; } catch { engineView = null; }
    return {
      aspect: state.aspect,
      crop: state.crop,
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
  body.append(group('aspect', 'picture.panel.aspect', ASPECTS, 'view.aspect'),
    group('crop', 'picture.panel.crop', CROPS, 'view.crop'), panelSnap);

  function render() {
    for (const [id, button] of optionButtons.aspect) button.setAttribute('aria-pressed', String(id === state.aspect));
    for (const [id, button] of optionButtons.crop) button.setAttribute('aria-pressed', String(id === state.crop));
  }
  render();

  ctx.on('ui:panel', ({ id }) => menuButton.setAttribute('aria-expanded', String(id === 'picture')));

  /* Persist nothing across files: every new file starts at Auto and no crop. */
  function reset() {
    state.aspect = 'auto';
    state.crop = 'none';
    state.lastSnapshot = null;
    if (typeof Engine.setView === 'function') {
      try { Engine.setView({ aspect: 'auto', crop: 'none' }); } catch { /* nothing loaded */ }
    }
    render();
  }
  ctx.on('ui:media-loaded', ({ name }) => { state.name = name || null; reset(); });
  ctx.on('ui:media-cleared', () => { state.name = null; reset(); });
}
