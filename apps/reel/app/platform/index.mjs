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
  'platform.pip.unsupported': 'This browser has no Picture-in-Picture.',
  'platform.pip.noVideo': 'Open a video before using Picture-in-Picture.',
  'platform.pip.iframe': 'Picture-in-Picture is blocked in this frame.',
  'platform.pip.iframeHint': 'The page that embeds Reel must add allow="picture-in-picture" to its iframe.',
};

const IDLE_MS = 3000;
const CLICK_DELAY_MS = 200;

/* Which PiP route the browser offers. Exported for the check and tests. */
export function pipRoute(win = globalThis) {
  if (win.documentPictureInPicture && typeof win.documentPictureInPicture.requestWindow === 'function') return 'document';
  const doc = win.document;
  const canvasProto = win.HTMLCanvasElement?.prototype;
  if (doc?.pictureInPictureEnabled && canvasProto && typeof canvasProto.captureStream === 'function') return 'video';
  return 'none';
}

export function install(ctx) {
  const { Engine, store, t, registry } = ctx;
  const state = store.ui.platform = {
    pip: { route: pipRoute(), active: false, mode: null, error: null },
    mediaSession: { supported: 'mediaSession' in navigator, title: null, handlers: [] },
    wakeLock: { supported: 'wakeLock' in navigator, active: false, requests: 0, outcome: null, error: null },
  };
  // Held once: during Document Picture-in-Picture the canvas lives in another document,
  // where ctx.canvas() (a lookup in this document) returns null.
  const videoCanvas = ctx.canvas();
  const run = (name, input) => Promise.resolve(registry.run(name, input)).catch(error => ctx.surface('platform', error));
  const stageMount = ctx.mounts.stage;
  const stageBox = stageMount.parentElement;

  ctx.addStyle(`
    .platform-hit{position:absolute;inset:0;pointer-events:auto;background:transparent}
    .platform-pip-placeholder{display:grid;place-items:center;gap:10px;min-height:200px;color:var(--dim);font-size:13px;text-align:center}
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
    .platform-pip-bar button:focus-visible{outline:2px solid #fff;outline-offset:2px}
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

  function setActive(active, mode) {
    state.pip.active = active;
    state.pip.mode = active ? mode : null;
    pipButton.setAttribute('aria-pressed', String(active));
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
    pipPlayButton = doc.createElement('button');
    pipPlayButton.type = 'button';
    pipPlayButton.dataset.command = 'playback.toggle';
    pipPlayButton.addEventListener('click', () => run('playback.toggle'));
    const close = doc.createElement('button');
    close.type = 'button';
    close.textContent = '✕';
    close.setAttribute('aria-label', t('platform.pip.close'));
    close.dataset.command = 'view.pip';
    close.addEventListener('click', () => run('view.pip', { on: false }));
    bar.append(pipPlayButton, close);
    box.append(canvas, stageMount, bar);
    doc.body.append(box);
    updatePipPlayButton();
    doc.addEventListener('keydown', event => {
      if (event.ctrlKey || event.metaKey || event.target.tagName === 'BUTTON') return;
      if (event.key === ' ') { event.preventDefault(); run('playback.toggle'); }
    });

    win.addEventListener('pagehide', () => restoreFromDocumentPip(canvas), { once: true });
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
    pipWindow = null;
    setActive(false);
  }

  async function openVideoPip() {
    const stream = videoCanvas.captureStream();
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('aria-hidden', 'true');
    // Kept rendered (not display:none) because Safari refuses PiP for an element it does not lay out.
    video.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;bottom:0;right:0';
    video.srcObject = stream;
    ctx.mounts.dialogs.append(video);
    pipVideo = video;
    const cleanup = () => {
      for (const track of stream.getTracks()) track.stop();
      video.remove();
      if (pipVideo === video) pipVideo = null;
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
  hit.addEventListener('click', event => {
    if (event.target !== hit || event.button !== 0) return;
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = 0; return; } // second click of a double-click
    clickTimer = setTimeout(() => { clickTimer = 0; run('playback.toggle'); }, CLICK_DELAY_MS);
  });
  hit.addEventListener('dblclick', event => {
    if (event.target !== hit) return;
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = 0; }
    if (hit.ownerDocument !== document) return; // inside the PiP window there is no page fullscreen
    run('view.fullscreen');
  });
  hit.addEventListener('wheel', event => {
    if (event.target !== hit || event.deltaY === 0) return;
    event.preventDefault();
    run('audio.volume', { delta: event.deltaY < 0 ? 0.05 : -0.05 });
  }, { passive: false });

  /* Controls hide after 3 s without pointer movement while playing in fullscreen. */
  let idleTimer = 0;
  function showControls() {
    clearTimeout(idleTimer);
    idleTimer = 0;
    stageBox.classList.remove('platform-idle');
  }
  function keyboardFocusInStage() {
    const active = document.activeElement;
    if (!active || !stageBox.contains(active)) return false;
    try { return active.matches(':focus-visible'); } catch { return true; }
  }
  function armIdle() {
    showControls();
    if (!document.fullscreenElement || !store.clock?.playing) return;
    idleTimer = setTimeout(() => {
      if (document.fullscreenElement && store.clock?.playing && !keyboardFocusInStage()) {
        stageBox.classList.add('platform-idle');
      }
    }, IDLE_MS);
  }
  document.addEventListener('pointermove', armIdle);
  document.addEventListener('pointerdown', armIdle);
  document.addEventListener('keydown', armIdle);
  document.addEventListener('focusin', showControls);
  document.addEventListener('fullscreenchange', armIdle);
}
