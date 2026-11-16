/* Reel feature module: platform (spec rows I1 Picture-in-Picture, I2 Media Session,
 * I3 Screen Wake Lock, I4 mouse on the video).
 * Contract: docs/build/reel-v1-contract.md. view.read (app/picture) reports the PiP state
 * this module keeps in store.ui.platform.
 * No DOM access at module top level, so Node can import COMMANDS for commands.json. */

export const COMMANDS = [
  { name: 'view.pip', label: 'Picture-in-Picture', scope: 'write', readTwin: 'view.read',
    description: 'Open or close Picture-in-Picture (a document window with the video and its controls where the browser offers one, else a video window); with no input it toggles.',
    input: { type: 'object', properties: { on: { type: 'boolean' } }, required: [] },
    shortcuts: [{ key: 'p' }] },
];

export const STRINGS = {
  'platform.pip.button': 'Picture-in-Picture',
  'platform.pip.placeholder': 'Playing in Picture-in-Picture.',
  'platform.pip.return': 'Bring the video back',
  'platform.pip.play': 'Play',
  'platform.pip.pause': 'Pause',
  'platform.pip.close': 'Close Picture-in-Picture',
  'platform.pip.back': 'Back 10 seconds',
  'platform.pip.forward': 'Forward 10 seconds',
  'platform.pip.seek': 'Position',
  'platform.pip.volume': 'Volume',
  'platform.pip.unsupported': 'This browser has no Picture-in-Picture.',
  'platform.pip.noVideo': 'Open a video before using Picture-in-Picture.',
  'platform.pip.iframe': 'Picture-in-Picture is blocked in this frame.',
  'platform.touch.back': '\u221210 s',
  'platform.touch.forward': '+10 s',
  'platform.touch.volume': 'Volume',
  'platform.pip.iframeHint': 'The page that embeds Reel must add allow="picture-in-picture" to its iframe.',
};

const IDLE_MS = 3000;
const CLICK_DELAY_MS = 200;
const TAP_SLOP_PX = 10;       // movement below this is a tap
const DOUBLE_TAP_MS = 300;    // window for the second tap
const TOUCH_SKIP_S = 10;
const TOUCH_SEEK_SPAN_S = 180; // a swipe across the full width moves this far (or the whole video if shorter)
const TOUCH_GHOST_MS = 600;    // the browser's synthesised mouse events after a touch are ignored for this long

/* Which PiP route the browser offers. Exported for the check and tests. */
export function pipRoute(win = globalThis) {
  if (win.documentPictureInPicture && typeof win.documentPictureInPicture.requestWindow === 'function') return 'document';
  const doc = win.document;
  const canvasProto = win.HTMLCanvasElement?.prototype;
  if (doc?.pictureInPictureEnabled && canvasProto && typeof canvasProto.captureStream === 'function') return 'video';
  return 'none';
}

/* The canvas the host put in place after a GPU loss (`ui:canvas-replaced` carries its id): looked up
 * in each document that may hold it, the PiP window's first. Exported for the check. */
export function findCanvas(id, docs) {
  for (const doc of docs) {
    const found = id && doc?.getElementById?.(id);
    if (found) return found;
  }
  return null;
}

/* The Document PiP window's controls (V63): seek range, back and forward 10 s, play, volume and
 * close, appended to `bar`. Each control runs a registry command through `run`. Exported so the
 * check can build them in a detached document, because a PiP window needs a real gesture. */
export function pipControls(doc, bar, { t, run }) {
  const button = (command, text, label, input) => {
    const node = doc.createElement('button');
    node.type = 'button';
    node.dataset.command = command;
    if (text) node.textContent = text;
    if (label) node.setAttribute('aria-label', t(label));
    node.addEventListener('click', () => run(command, input));
    return node;
  };
  const range = (command, className, label, attrs, toInput) => {
    const node = doc.createElement('input');
    node.type = 'range';
    node.className = className;
    node.dataset.command = command;
    for (const [key, value] of Object.entries(attrs)) node[key] = value;
    node.setAttribute('aria-label', t(label));
    node.addEventListener('input', () => run(command, toInput(Number(node.value))));
    return node;
  };
  const play = button('playback.toggle', '', '', undefined);
  const back = button('playback.skip', '−10', 'platform.pip.back', { seconds: -TOUCH_SKIP_S });
  const forward = button('playback.skip', '+10', 'platform.pip.forward', { seconds: TOUCH_SKIP_S });
  const seek = range('playback.seek', 'platform-pip-seek', 'platform.pip.seek', { min: '0', step: '0.1' }, positionS => ({ positionS }));
  const volume = range('audio.volume', 'platform-pip-volume', 'platform.pip.volume', { min: '0', max: '1', step: '0.05' }, value => ({ volume: value }));
  const close = button('view.pip', '✕', 'platform.pip.close', { on: false });
  bar.append(seek, back, play, forward, volume, close);
  return { play, back, forward, seek, volume, close };
}

export function install(ctx) {
  const { Engine, store, t, registry } = ctx;
  const state = store.ui.platform = {
    pip: { route: pipRoute(), active: false, mode: null, error: null },
    mediaSession: { supported: 'mediaSession' in navigator, title: null, handlers: [] },
    wakeLock: { supported: 'wakeLock' in navigator, active: false, requests: 0, outcome: null, error: null },
  };
  // Held, because during Document Picture-in-Picture the canvas lives in another document, where
  // ctx.canvas() (a lookup in this document) returns null. Re-pointed on ui:canvas-replaced.
  let videoCanvas = ctx.canvas();
  let recapture = null;      // captureStream route: re-captures the current canvas
  const run = (name, input) => Promise.resolve(registry.run(name, input)).catch(error => ctx.surface('platform', error));
  const stageMount = ctx.mounts.stage;
  const stageBox = stageMount.parentElement;

  ctx.addStyle(`
    .platform-hit{position:absolute;inset:0;pointer-events:auto;background:transparent;touch-action:none}
    .platform-touch-hide .player-capsule{opacity:0;pointer-events:none}
    .platform-ripple{position:absolute;top:0;bottom:0;width:34%;display:grid;place-items:center;pointer-events:none;
      background:radial-gradient(circle,rgba(255,255,255,.28) 0,rgba(255,255,255,.1) 55%,transparent 70%);
      color:#fff;font-size:15px;font-weight:600;opacity:0;animation:platform-ripple .6s ease-out forwards}
    .platform-ripple.left{left:0}
    .platform-ripple.right{right:0}
    @keyframes platform-ripple{0%{opacity:0;transform:scale(.85)}25%{opacity:1}100%{opacity:0;transform:scale(1.05)}}
    .platform-touch-preview{position:absolute;left:50%;top:18%;transform:translateX(-50%);padding:8px 14px;border-radius:12px;
      background:rgba(11,11,14,.82);color:#fff;font-size:18px;font-variant-numeric:tabular-nums;pointer-events:none;white-space:nowrap}
    .platform-touch-preview[hidden]{display:none}
    #player{padding-left:max(20px,env(safe-area-inset-left));padding-right:max(20px,env(safe-area-inset-right));padding-bottom:max(20px,env(safe-area-inset-bottom))}
    .mount-panels{padding-bottom:max(14px,env(safe-area-inset-bottom))}
    @media (max-width:600px){
      html,body{overflow-x:hidden}
      #player{padding:max(8px,env(safe-area-inset-top)) 0 max(8px,env(safe-area-inset-bottom));padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);overflow-x:hidden;max-width:100vw;gap:10px}
      #player .player-topbar{padding:0 12px}
      #player .player-topbar button{min-height:44px}
      #player .player-stage{display:flex;flex-direction:column;justify-content:flex-start;align-items:stretch;min-height:0;width:100%;border-radius:0;border-left:0;border-right:0}
      #player #engine-canvas{flex:0 0 auto;width:100%;height:auto;aspect-ratio:16/9;max-height:56vh}
      #player .player-capsule{position:relative;z-index:2;left:auto;right:auto;bottom:auto;margin:0;padding:8px 10px;border-radius:0 0 var(--capsule-radius) var(--capsule-radius);border-width:1px 0 0}
      #player .player-honesty{flex-wrap:wrap;gap:6px}
      #player #player-seek{height:44px}
      #player .player-controls{flex-wrap:wrap;gap:2px;row-gap:4px}
      #player .player-controls .spacer{flex:1 1 100%;height:0}
      #player .player-controls button,#player .player-controls select{min-width:44px;min-height:44px;height:44px;padding-left:4px;padding-right:4px}
      #player .player-controls .timecode{flex:1 1 auto;text-align:center}
      #player #player-volume{display:none}
      #player-details{display:none}
      #mount-panels{position:fixed;left:0;right:0;top:auto;bottom:0;width:auto;max-height:70vh;border-radius:16px 16px 0 0;border-width:1px 0 0;
        padding:14px 16px max(14px,env(safe-area-inset-bottom));z-index:20;box-shadow:0 -12px 32px rgba(0,0,0,.45)}
      .platform-touch-hide .player-capsule{visibility:hidden}
      .platform-touch-preview{top:12%}
    }
    @media (orientation:portrait) and (min-width:601px) and (max-width:900px){
      #player #engine-canvas{max-height:56vh}
      #mount-panels{position:fixed;left:0;right:0;top:auto;bottom:0;width:auto;max-height:60vh;border-radius:16px 16px 0 0;
        padding:14px 20px max(14px,env(safe-area-inset-bottom));z-index:20}
    }
    .platform-pip-placeholder{display:grid;place-content:center;justify-items:center;gap:10px;min-height:200px;color:var(--dim);font-size:13px;text-align:center;
      align-self:stretch;justify-self:stretch;box-sizing:border-box;padding:12px 12px calc(var(--reel-controls-inset,0px) + 12px)}
    .platform-pip-placeholder button{color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px 12px;background:transparent;font:inherit;cursor:pointer}
    .player-capsule{transition:opacity .25s}
    .platform-idle .player-capsule{opacity:0;pointer-events:none}
    .platform-idle, .platform-idle .platform-hit{cursor:none}
    html.platform-pip-doc, html.platform-pip-doc body{margin:0;height:100%;background:#000;overflow:hidden}
    .platform-pip-stage{position:relative;width:100vw;height:100vh;background:#000;display:grid;place-items:center}
    .platform-pip-stage #engine-canvas{width:100%;height:100%;max-height:none}
    .platform-pip-bar{position:absolute;left:8px;right:8px;bottom:8px;display:flex;gap:6px;justify-content:center;opacity:0;transition:opacity .2s}
    .platform-pip-stage:hover .platform-pip-bar, .platform-pip-bar:focus-within{opacity:1}
    .platform-pip-bar button{min-width:40px;height:34px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:rgba(11,11,14,.8);color:#fff;font:inherit;cursor:pointer}
    .platform-pip-bar button:focus-visible,.platform-pip-bar input:focus-visible{outline:2px solid #fff;outline-offset:2px}
    .platform-pip-bar{flex-wrap:wrap;align-items:center}
    .platform-pip-bar input[type=range]{accent-color:#fff;height:34px}
    .platform-pip-bar .platform-pip-seek{flex:1 1 100%;min-width:120px;margin:0}
    .platform-pip-bar .platform-pip-volume{width:80px}
  `);

  /* ---------------------------------------------------------- I1 Picture-in-Picture */
  const pipButton = document.createElement('button');
  pipButton.type = 'button';
  pipButton.textContent = '⧉';
  pipButton.setAttribute('aria-label', t('platform.pip.button'));
  pipButton.title = t('platform.pip.button');
  pipButton.setAttribute('aria-pressed', 'false');
  pipButton.dataset.command = 'view.pip';
  pipButton.hidden = state.pip.route === 'none';
  pipButton.addEventListener('click', () => run('view.pip', {}));
  ctx.mounts.controlsRight.append(pipButton);

  let pipWindow = null;      // Document PiP window
  let pipVideo = null;       // hidden <video> for the fallback route
  let placeholder = null;
  let pipPlayButton = null;
  let pipSeek = null;        // range inputs in the Document PiP window (V63)
  let pipVolume = null;

  function setActive(active, mode) {
    state.pip.active = active;
    state.pip.mode = active ? mode : null;
    pipButton.setAttribute('aria-pressed', String(active));
    // The bar stays shown during PiP, and the placeholder pads itself by the bar's height (defect 4).
    showControls();
  }

  function inIframe() {
    try { return window.self !== window.top; } catch { return true; }
  }

  function copyStyles(targetDoc) {
    for (const sheet of document.styleSheets) {
      try {
        const style = targetDoc.createElement('style');
        style.textContent = [...sheet.cssRules].map(rule => rule.cssText).join('\n');
        targetDoc.head.append(style);
      } catch {
        if (!sheet.href) continue;
        const link = targetDoc.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        targetDoc.head.append(link);
      }
    }
  }

  /* Seek and volume follow the player, except the range the person is dragging. */
  function updatePipRanges() {
    if (!pipSeek) return;
    const doc = pipSeek.ownerDocument;
    const duration = Number(store.media?.duration) || 0;
    pipSeek.max = String(duration);
    pipSeek.disabled = !(duration > 0);
    if (doc.activeElement !== pipSeek) pipSeek.value = String(store.clock?.positionS ?? 0);
    pipSeek.setAttribute('aria-valuetext', `${ctx.formatTime(Number(pipSeek.value))} / ${ctx.formatTime(duration)}`);
    if (doc.activeElement !== pipVolume) pipVolume.value = String(Math.min(1, Number(store.clock?.volume ?? 1)));
  }

  function updatePipPlayButton() {
    if (!pipPlayButton) return;
    const playing = !!store.clock?.playing;
    pipPlayButton.textContent = playing ? '❚❚' : '▶';
    pipPlayButton.setAttribute('aria-label', t(playing ? 'platform.pip.pause' : 'platform.pip.play'));
  }

  async function openDocumentPip() {
    const canvas = videoCanvas;
    const rect = canvas.getBoundingClientRect();
    const ratio = canvas.width > 1 && canvas.height > 1 ? canvas.width / canvas.height : 16 / 9;
    const width = Math.round(Math.min(640, Math.max(320, rect.width / 2)));
    const win = await window.documentPictureInPicture.requestWindow({ width, height: Math.round(width / ratio) });
    const doc = win.document;
    doc.documentElement.classList.add('platform-pip-doc');
    doc.documentElement.lang = document.documentElement.lang;
    doc.title = store.media?.name || document.title;
    copyStyles(doc);

    placeholder = document.createElement('div');
    placeholder.className = 'platform-pip-placeholder';
    const text = document.createElement('p');
    text.textContent = t('platform.pip.placeholder');
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = t('platform.pip.return');
    back.dataset.command = 'view.pip';
    back.addEventListener('click', () => run('view.pip', { on: false }));
    placeholder.append(text, back);
    canvas.before(placeholder);

    const box = doc.createElement('div');
    box.className = 'platform-pip-stage';
    const bar = doc.createElement('div');
    bar.className = 'platform-pip-bar';
    ({ play: pipPlayButton, seek: pipSeek, volume: pipVolume } = pipControls(doc, bar, { t, run }));
    box.append(canvas, stageMount, bar);
    doc.body.append(box);
    updatePipPlayButton();
    updatePipRanges();
    doc.addEventListener('keydown', event => {
      if (event.ctrlKey || event.metaKey || event.target.tagName === 'BUTTON') return;
      if (event.key === ' ') { event.preventDefault(); run('playback.toggle'); }
    });

    // The canvas may be replaced while the window is open, so restore whichever is current.
    // Only the window still current restores: a closed window's late pagehide must not pull the
    // canvas out of a newer PiP window.
    win.addEventListener('pagehide', () => { if (pipWindow === win) restoreFromDocumentPip(videoCanvas); }, { once: true });
    pipWindow = win;
    setActive(true, 'document');
  }

  function restoreFromDocumentPip(canvas) {
    if (placeholder?.isConnected) {
      placeholder.replaceWith(canvas);
      canvas.after(stageMount);
    } else if (!canvas.isConnected || canvas.ownerDocument !== document) {
      stageBox.prepend(canvas, stageMount);
    }
    placeholder = null;
    pipPlayButton = null;
    pipSeek = null;
    pipVolume = null;
    pipWindow = null;
    setActive(false);
  }

  async function openVideoPip() {
    let stream = videoCanvas.captureStream();
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('aria-hidden', 'true');
    // Kept rendered (not display:none) because Safari refuses PiP for an element it does not lay out.
    video.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;bottom:0;right:0';
    video.srcObject = stream;
    ctx.mounts.dialogs.append(video);
    pipVideo = video;
    recapture = () => {
      for (const track of stream.getTracks()) track.stop();
      stream = videoCanvas.captureStream();
      video.srcObject = stream;
      if (store.clock?.playing) video.play().catch(() => {});
    };
    const cleanup = () => {
      for (const track of stream.getTracks()) track.stop();
      video.remove();
      if (pipVideo === video) { pipVideo = null; recapture = null; }
      setActive(false);
    };
    video.addEventListener('leavepictureinpicture', cleanup, { once: true });
    // The PiP window's own play and pause buttons drive the engine; audio stays in the page.
    video.addEventListener('pause', () => { if (pipVideo === video && store.clock?.playing) run('playback.pause'); });
    video.addEventListener('play', () => { if (pipVideo === video && !store.clock?.playing) run('playback.play'); });
    try {
      await video.play();
      await video.requestPictureInPicture();
      if (!store.clock?.playing) video.pause();
      setActive(true, 'video');
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  async function closePip() {
    if (pipWindow) {
      pipWindow.close();
      // Restore now rather than waiting for the window's pagehide; restoring twice is harmless.
      restoreFromDocumentPip(videoCanvas);
    }
    if (pipVideo && document.pictureInPictureElement === pipVideo) await document.exitPictureInPicture();
  }

  /* After a GPU loss the host swaps in a fresh canvas (same id) and attaches the engine to it.
   * Document PiP keeps the fresh canvas in its window; the captureStream route captures it again. */
  ctx.on('ui:canvas-replaced', ({ id } = {}) => {
    const fresh = findCanvas(id || videoCanvas?.id, [pipWindow?.document, document]);
    if (!fresh || fresh === videoCanvas) return;
    videoCanvas = fresh;
    state.pip.canvasReplaced = (state.pip.canvasReplaced || 0) + 1;
    if (pipWindow && fresh.ownerDocument !== pipWindow.document) {
      pipWindow.document.querySelector('.platform-pip-stage')?.prepend(fresh);
    }
    recapture?.();
  });
  if (new URLSearchParams(location.search).get('dev') === '1') {
    globalThis.__reelPlatform = Object.freeze({ canvas: () => videoCanvas });
  }

  registry.handle('view.pip', async ({ on }) => {
    const want = typeof on === 'boolean' ? on : !state.pip.active;
    if (!want) {
      await closePip();
      return { route: state.pip.route, active: state.pip.active, mode: state.pip.mode };
    }
    if (state.pip.active) return { route: state.pip.route, active: true, mode: state.pip.mode };
    if (state.pip.route === 'none') {
      throw Object.assign(new Error(t('platform.pip.unsupported')), { code: 'ERR_PIP_UNSUPPORTED' });
    }
    if (!store.media?.name) {
      throw Object.assign(new Error(t('platform.pip.noVideo')), { code: 'ERR_PIP_NO_VIDEO' });
    }
    state.pip.error = null;
    try {
      if (state.pip.route === 'document') await openDocumentPip();
      else await openVideoPip();
    } catch (error) {
      state.pip.error = { name: error?.name, message: error?.message };
      if (error?.name === 'NotAllowedError' && inIframe()) {
        ctx.toast(t('platform.pip.iframe'), 'err', t('platform.pip.iframeHint'));
        return { route: state.pip.route, active: false, mode: null, error: state.pip.error };
      }
      throw error;
    }
    return { route: state.pip.route, active: state.pip.active, mode: state.pip.mode };
  });

  /* ---------------------------------------------------------- I2 Media Session */
  const session = navigator.mediaSession;
  let artworkPending = false;
  let lastPositionAt = 0;

  function setHandler(action, fn) {
    try {
      session.setActionHandler(action, fn);
      if (fn && !state.mediaSession.handlers.includes(action)) state.mediaSession.handlers.push(action);
      return true;
    } catch {
      return false; // the browser does not know this action
    }
  }
  function hasCommand(name) {
    return typeof registry.has === 'function' ? registry.has(name) : registry.list().some(def => def.name === name);
  }

  function setupMediaSession(name) {
    if (!session) return;
    const title = String(name || 'Reel');
    state.mediaSession.title = title;
    try { session.metadata = new MediaMetadata({ title, artist: 'Reel' }); } catch { /* MediaMetadata absent */ }
    state.mediaSession.handlers = [];
    setHandler('play', () => run('playback.play'));
    setHandler('pause', () => run('playback.pause'));
    setHandler('seekbackward', details => run('playback.skip', { seconds: -(details?.seekOffset || 10) }));
    setHandler('seekforward', details => run('playback.skip', { seconds: details?.seekOffset || 10 }));
    setHandler('seekto', details => {
      if (Number.isFinite(details?.seekTime)) run('playback.seek', { positionS: details.seekTime });
    });
    // Queue commands exist only when the queue module is installed.
    setHandler('previoustrack', hasCommand('queue.previous') ? () => run('queue.previous') : null);
    setHandler('nexttrack', hasCommand('queue.next') ? () => run('queue.next') : null);
    session.playbackState = 'paused';
    artworkPending = true;
    lastPositionAt = 0;
  }

  function clearMediaSession() {
    if (!session) return;
    session.metadata = null;
    for (const action of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack']) {
      setHandler(action, null);
    }
    try { session.setPositionState(); } catch { /* not supported */ }
    session.playbackState = 'none';
    state.mediaSession.title = null;
    state.mediaSession.handlers = [];
    artworkPending = false;
  }

  /* Artwork: one small JPEG from the first frame the canvas shows. */
  function captureArtwork(canvas) {
    const scale = Math.min(1, 256 / Math.max(canvas.width, canvas.height));
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(canvas.width * scale));
    small.height = Math.max(1, Math.round(canvas.height * scale));
    small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
    const src = small.toDataURL('image/jpeg', 0.7);
    session.metadata = new MediaMetadata({
      title: state.mediaSession.title, artist: 'Reel',
      artwork: [{ src, sizes: `${small.width}x${small.height}`, type: 'image/jpeg' }],
    });
  }

  ctx.onFrame(frameState => {
    updatePipRanges();
    if (!session || !state.mediaSession.title) return;
    const canvas = videoCanvas;
    if (artworkPending && canvas.width > 1 && canvas.height > 1 && (frameState.playback?.renderer?.renderedFrames ?? 1) > 0) {
      artworkPending = false;
      try { captureArtwork(canvas); } catch { /* artwork is optional */ }
    }
    const now = performance.now();
    if (now - lastPositionAt < 1000) return;
    lastPositionAt = now;
    const duration = frameState.media?.duration;
    const position = frameState.clock?.positionS;
    const rate = frameState.clock?.rate || 1;
    if (!(duration > 0) || !Number.isFinite(position)) return;
    try {
      session.setPositionState({ duration, playbackRate: rate, position: Math.min(Math.max(0, position), duration) });
    } catch { /* setPositionState absent or rejected */ }
  });

  /* ---------------------------------------------------------- I3 Screen Wake Lock */
  let sentinel = null;
  let acquiring = false;

  async function acquireWakeLock() {
    if (!state.wakeLock.supported || sentinel || acquiring) return;
    if (document.visibilityState !== 'visible') { state.wakeLock.outcome = 'skipped-hidden'; return; }
    acquiring = true;
    try {
      state.wakeLock.requests += 1;
      const lock = await navigator.wakeLock.request('screen');
      if (!store.clock?.playing) {
        // Playback stopped while the request was pending (a short file can end first).
        state.wakeLock.outcome = 'granted-after-stop';
        await lock.release();
        return;
      }
      sentinel = lock;
      state.wakeLock.active = true;
      state.wakeLock.outcome = 'held';
      state.wakeLock.error = null;
      lock.addEventListener('release', () => {
        if (sentinel === lock) { sentinel = null; state.wakeLock.active = false; }
      });
    } catch (error) {
      state.wakeLock.outcome = 'refused';
      state.wakeLock.error = { name: error?.name, message: error?.message };
    } finally {
      acquiring = false;
    }
  }
  function releaseWakeLock() {
    const lock = sentinel;
    sentinel = null;
    state.wakeLock.active = false;
    if (lock) lock.release().catch(() => {});
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (store.clock?.playing) acquireWakeLock();
    } else {
      releaseWakeLock();
    }
  });

  /* ---------------------------------------------------------- playback events */
  ctx.on('playback:play', () => {
    if (session && state.mediaSession.title) session.playbackState = 'playing';
    acquireWakeLock();
    updatePipPlayButton();
    if (pipVideo?.paused) pipVideo.play().catch(() => {});
    armIdle();
  });
  const onStop = () => {
    if (session && state.mediaSession.title) session.playbackState = 'paused';
    releaseWakeLock();
    updatePipPlayButton();
    if (pipVideo && !pipVideo.paused) pipVideo.pause();
    showControls();
  };
  ctx.on('playback:pause', onStop);
  ctx.on('playback:ended', onStop);
  ctx.on('ui:media-loaded', ({ name }) => setupMediaSession(name));
  ctx.on('ui:media-cleared', () => {
    clearMediaSession();
    releaseWakeLock();
    closePip().catch(() => {});
    showControls();
  });

  /* ---------------------------------------------------------- I4 mouse on the video */
  const hit = document.createElement('div');
  hit.className = 'platform-hit';
  hit.setAttribute('aria-hidden', 'true');
  stageMount.prepend(hit); // first child, so caption layers and settings stay above it

  let clickTimer = 0;
  let lastTouchEnd = -Infinity;
  hit.addEventListener('click', event => {
    if (event.target !== hit || event.button !== 0) return;
    if (event.pointerType === 'touch' || performance.now() - lastTouchEnd < TOUCH_GHOST_MS) return; // touch has its own handler
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = 0; return; } // second click of a double-click
    clickTimer = setTimeout(() => { clickTimer = 0; run('playback.toggle'); }, CLICK_DELAY_MS);
  });
  hit.addEventListener('dblclick', event => {
    if (event.target !== hit) return;
    if (performance.now() - lastTouchEnd < TOUCH_GHOST_MS) return;
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = 0; }
    if (hit.ownerDocument !== document) return; // inside the PiP window there is no page fullscreen
    run('view.fullscreen');
  });
  hit.addEventListener('wheel', event => {
    if (event.target !== hit || event.deltaY === 0) return;
    event.preventDefault();
    run('audio.volume', { delta: event.deltaY < 0 ? 0.05 : -0.05 });
  }, { passive: false });

  /* ---------------------------------------------------------- I5 touch on the video */
  const preview = document.createElement('div');
  preview.className = 'platform-touch-preview';
  preview.setAttribute('aria-hidden', 'true');
  preview.hidden = true;
  stageMount.append(preview);

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const touchZone = (event, rect) => {
    const x = (event.clientX - rect.left) / (rect.width || 1);
    return x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : 'center';
  };
  let gesture = null;
  let lastTap = { at: -Infinity, zone: '' };
  let singleTapTimer = 0;
  let previewTimer = 0;

  function showPreview(text, holdMs = 0) {
    clearTimeout(previewTimer);
    preview.textContent = text;
    preview.hidden = false;
    if (holdMs) previewTimer = setTimeout(() => { preview.hidden = true; }, holdMs);
  }
  function ripple(zone) {
    const el = document.createElement('div');
    el.className = `platform-ripple ${zone}`;
    el.setAttribute('aria-hidden', 'true');
    el.textContent = t(zone === 'left' ? 'platform.touch.back' : 'platform.touch.forward');
    stageMount.append(el);
    el.addEventListener('animationend', () => el.remove());
    setTimeout(() => el.remove(), 900); // reduced motion turns the animation off
  }
  let toggleTouchControls = () => {}; // set with the control bar visibility code below
  function endGesture() { gesture = null; }

  hit.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' || gesture) return;
    const rect = hit.getBoundingClientRect();
    gesture = {
      id: event.pointerId, x: event.clientX, y: event.clientY, rect, mode: '',
      position: store.clock?.positionS || 0, volume: store.clock?.volume ?? 1,
      duration: store.media?.duration || 0, target: null,
    };
    try { hit.setPointerCapture(event.pointerId); } catch { /* a synthetic pointer has no capture */ }
  });
  hit.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.mode) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < TAP_SLOP_PX) return;
      if (Math.abs(dx) >= Math.abs(dy)) gesture.mode = gesture.duration > 0 ? 'seek' : 'ignore';
      else gesture.mode = gesture.x - gesture.rect.left > gesture.rect.width / 2 ? 'volume' : 'ignore';
      clearTimeout(singleTapTimer);
      singleTapTimer = 0;
    }
    if (gesture.mode === 'seek') {
      const span = Math.min(gesture.duration, TOUCH_SEEK_SPAN_S);
      const target = clamp(gesture.position + (dx / (gesture.rect.width || 1)) * span, 0, gesture.duration);
      gesture.target = target;
      const delta = target - gesture.position;
      showPreview(`${ctx.formatTime(target)} (${delta < 0 ? '−' : '+'}${ctx.formatTime(Math.abs(delta))})`);
    } else if (gesture.mode === 'volume') {
      const volume = clamp(gesture.volume - dy / (gesture.rect.height || 1), 0, 2);
      showPreview(`${t('platform.touch.volume')} ${Math.round(volume * 100)}%`);
      run('audio.volume', { volume });
    }
  });
  hit.addEventListener('pointerup', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const g = gesture;
    endGesture();
    lastTouchEnd = performance.now();
    try { hit.releasePointerCapture(event.pointerId); } catch { /* not captured */ }
    if (g.mode === 'seek') {
      if (g.target != null) run('playback.seek', { positionS: g.target });
      preview.hidden = true;
      return;
    }
    if (g.mode === 'volume') { previewTimer = setTimeout(() => { preview.hidden = true; }, 700); return; }
    if (g.mode) return;
    // A tap.
    const zone = touchZone(event, g.rect);
    const now = performance.now();
    const second = now - lastTap.at < DOUBLE_TAP_MS;
    if (second && zone === 'center' && lastTap.zone === 'center') {
      clearTimeout(singleTapTimer);
      singleTapTimer = 0;
      lastTap = { at: -Infinity, zone: '' };
      run('playback.toggle');
    } else if (second && zone !== 'center' && zone === lastTap.zone) {
      clearTimeout(singleTapTimer);
      singleTapTimer = 0;
      lastTap = { at: now, zone }; // a third tap keeps skipping
      run('playback.skip', { seconds: zone === 'left' ? -TOUCH_SKIP_S : TOUCH_SKIP_S });
      ripple(zone);
    } else {
      lastTap = { at: now, zone };
      clearTimeout(singleTapTimer);
      singleTapTimer = setTimeout(() => { singleTapTimer = 0; toggleTouchControls(); }, DOUBLE_TAP_MS);
    }
  });
  hit.addEventListener('pointercancel', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    endGesture();
    preview.hidden = true;
  });
  ctx.on('ui:media-cleared', () => {
    stageBox.classList.remove('platform-touch-hide');
    preview.hidden = true;
    showControls();
  });

  /* ---------------------------------------------------------- control bar visibility
   * Batch 6 defect 1: one owner for hiding the bar. While playing, the bar hides after 3 s without
   * pointer movement, in a window and in fullscreen, wherever it lies over the picture. Pointer
   * movement, focus, any key and pause show it again. It stays while a panel or dialog is open, while
   * keyboard focus or the pointer is on it, and during Picture-in-Picture. Where the bar sits below
   * the picture (the phone layout) it hides only in fullscreen.
   * Contract with app/subtitles: `--reel-controls-inset` on #player is the height in px of the stage
   * the bar covers (0px while hidden; on the phone layout the bar's band, which stays out of the
   * picture), and `ui:controls` {visible, insetPx} is emitted whenever either changes. */
  const player = stageBox.closest('#player') || document.getElementById('player');
  const capsule = stageBox.querySelector('.player-capsule');
  const controls = state.controls = { visible: true, insetPx: 0 };
  let idleTimer = 0;
  let pointerOnBar = false;

  const barOverlaysPicture = () => !!capsule && getComputedStyle(capsule).position === 'absolute';
  function measureInset(visible) {
    if (!capsule) return 0;
    const stage = stageBox.getBoundingClientRect();
    const bar = capsule.getBoundingClientRect();
    if (!(stage.height > 0) || !(bar.height > 0)) return 0;
    const band = Math.max(0, Math.min(Math.round(stage.height), Math.round(stage.bottom - bar.top)));
    if (!barOverlaysPicture()) return band;
    return visible ? band : 0;
  }
  function publish() {
    const visible = !stageBox.classList.contains('platform-idle') && !stageBox.classList.contains('platform-touch-hide');
    const insetPx = measureInset(visible);
    player?.style.setProperty('--reel-controls-inset', `${insetPx}px`);
    if (visible === controls.visible && insetPx === controls.insetPx) return;
    controls.visible = visible;
    controls.insetPx = insetPx;
    ctx.Events.emit('ui:controls', { visible, insetPx });
  }
  function keyboardFocusInStage() {
    const active = document.activeElement;
    if (!active || !stageBox.contains(active)) return false;
    try { return active.matches(':focus-visible'); } catch { return true; }
  }
  function holdsControls() {
    return !!ctx.panels?.current?.()
      || !!document.querySelector('dialog[open]')
      || keyboardFocusInStage()
      || pointerOnBar
      || state.pip.active;
  }
  function mayHide() {
    return store.ui.screen === 'player' && !!store.clock?.playing
      && (!!document.fullscreenElement || barOverlaysPicture()) && !holdsControls();
  }
  function showControls() {
    clearTimeout(idleTimer);
    idleTimer = 0;
    stageBox.classList.remove('platform-idle');
    publish();
  }
  function armIdle() {
    showControls();
    if (!store.clock?.playing) return;
    idleTimer = setTimeout(() => {
      idleTimer = 0;
      if (mayHide()) stageBox.classList.add('platform-idle');
      publish();
    }, IDLE_MS);
  }
  toggleTouchControls = () => {
    if (controls.visible) {
      clearTimeout(idleTimer);
      idleTimer = 0;
      stageBox.classList.add('platform-touch-hide');
      publish();
    } else {
      stageBox.classList.remove('platform-touch-hide');
      armIdle();
    }
  };
  // A touch on the picture is a gesture (tap toggles the bar), so only touches on the bar re-arm it.
  const onPointer = event => {
    if (event.pointerType === 'touch' && !capsule?.contains(event.target)) return;
    armIdle();
  };
  document.addEventListener('pointermove', onPointer);
  document.addEventListener('pointerdown', onPointer);
  document.addEventListener('keydown', () => {
    stageBox.classList.remove('platform-touch-hide');
    armIdle();
  });
  document.addEventListener('focusin', () => {
    stageBox.classList.remove('platform-touch-hide');
    armIdle();
  });
  document.addEventListener('fullscreenchange', armIdle);
  capsule?.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') pointerOnBar = true; });
  capsule?.addEventListener('pointerleave', () => { pointerOnBar = false; armIdle(); });
  ctx.on('ui:panel', armIdle);
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => publish());
    observer.observe(stageBox);
    if (capsule) observer.observe(capsule);
  }
  publish();
  if (new URLSearchParams(location.search).get('dev') === '1') {
    globalThis.__reelControls = Object.freeze({ state: () => ({ ...controls }), idleMs: IDLE_MS });
  }
}
