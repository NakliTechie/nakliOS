// webamp-face.mjs — the optional classic skin face (parity row V5).
//
// The face loads a classic skin (.wsz) the person picks from disk and draws it with
// Webamp (MIT, vendored in vendor/webamp/, loaded only when a skin is chosen). Webamp
// never plays audio here: it takes a custom media class (`__customMediaClass`, see
// plan/v1-build/v5-webamp-spike.md) that forwards every transport call to NakliAmp's
// commands, so the decode ladder, gapless, ReplayGain and the EQ stay NakliAmp's.
//
// NakliAmp is the source of truth. The bridge projects the queue, the current entry,
// play state, volume, repeat and the EQ curve into Webamp's store; edits made in the
// face (playlist removals and reorders, EQ sliders, repeat, shuffle) go back as queue
// edits, settings and commands. Shuffle is NakliAmp's: the face's shuffle button
// cycles NakliAmp's shuffle mode and Webamp's own random pick stays off, so the next
// button follows the queue order. Webamp's preamp and balance sliders have no
// NakliAmp setting and do nothing.
//
// No skin ships with NakliAmp. Nothing here touches `document` at import time.

import { h, injectCss } from './dialog.mjs';
import { eqGains } from '../audio/eq-presets.mjs';

/** Webamp's ten slider frequencies, in order; NakliAmp's ten bands map index for index. */
export const WEBAMP_BANDS_HZ = Object.freeze([60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000]);
export const ENTRY_SCHEME = 'nakliamp-entry:';
export const TICK_MS = 250;
export const EQ_FLUSH_MS = 60;
export const VOLUME_HOLD_MS = 400;
export const MAX_SKIN_BYTES = 32 * 1024 * 1024;
export const WEBAMP_MODULE = '../../vendor/webamp/webamp-2.3.1.bundle.min.mjs';

const REORDER_ACTIONS = new Set(['DRAG_SELECTED', 'REVERSE_LIST', 'RANDOMIZE_LIST', 'SET_TRACK_ORDER']);
const SHUFFLE_CYCLE = ['off', 'tracks', 'albums'];

// ---------------------------------------------------------------- pure ----

/** The fake URL that names one queue entry. Webamp is given duration and tags, so it never fetches it. */
export const entryUrl = key => `${ENTRY_SCHEME}${encodeURIComponent(String(key))}`;

/** The queue entry key in an entry URL, as a string, or null for any other URL. */
export function keyFromUrl(url) {
  const text = String(url ?? '');
  if (!text.startsWith(ENTRY_SCHEME)) return null;
  try { return decodeURIComponent(text.slice(ENTRY_SCHEME.length)); } catch { return null; }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Webamp slider value (0..100, 50 = 0 dB, the ±12 dB scale its media class uses) to dB. */
export function webampToDb(value) {
  const v = clamp(Number(value) || 0, 0, 100);
  return Math.round(((v / 100) * 24 - 12) * 10) / 10;
}

/** dB (-12..12) to a Webamp slider value 0..100. */
export function dbToWebamp(db) {
  const d = clamp(Number(db) || 0, -12, 12);
  return Math.round(((d + 12) / 24) * 100);
}

/** The full EQ curve the settings describe, even while the EQ is off (the sliders still show it). */
export const curveOf = eq => eqGains({ ...eq, enabled: true });

const sortedJoin = list => list.toSorted().join('\u001f');

/**
 * Moves that turn `from` into `to` with splice semantics (`move(from, to)` removes at
 * `from` and inserts at `to`). Both lists hold the same keys; otherwise null.
 */
export function planMoves(from, to) {
  const work = from.map(String);
  const target = to.map(String);
  if (work.length !== target.length) return null;
  if (sortedJoin(work) !== sortedJoin(target)) return null;
  const moves = [];
  for (let i = 0; i < target.length; i += 1) {
    if (work[i] === target[i]) continue;
    const j = work.indexOf(target[i], i + 1);
    moves.push({ from: j, to: i });
    work.splice(i, 0, ...work.splice(j, 1));
  }
  return moves;
}

/** The Webamp track for one queue entry: tags and duration given, so Webamp reads nothing. */
export function webampTrack(key, track) {
  const title = track?.title || track?.name || 'Unknown track';
  return {
    url: entryUrl(key),
    duration: Number.isFinite(track?.durationS) ? track.durationS : 0,
    defaultName: title,
    metaData: { artist: track?.artist || '', title, album: track?.album || '' },
  };
}

const sameList = (a, b) => a.length === b.length && a.every((value, i) => String(value) === String(b[i]));

/** The extension check for a picked skin file. */
export function skinFileProblem(file) {
  if (!file) return 'No file was chosen.';
  if (!/\.(wsz|zip)$/i.test(file.name ?? '')) return 'Pick a classic skin file ending in .wsz.';
  if (file.size > MAX_SKIN_BYTES) return 'That file is larger than 32 MB, which is too big for a classic skin.';
  return null;
}

// The vendored Webamp bundle carries neutral fallback art drawn by
// scripts/patch-webamp-skin.mjs (Chirag, 2026-11-17), so a skin may leave out any
// sheet. It must still carry its own main window, or nothing of it would show.
export const REQUIRED_SKIN_PARTS = Object.freeze(['MAIN.BMP']);
const MAX_ZIP_ENTRIES = 4096;

/**
 * The file names in a zip, read from its central directory only (no decompression).
 * Throws an Error with a plain message when the bytes are not a readable zip.
 */
export function zipEntryNames(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is in the last 22 bytes plus up to 64 KB of comment.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error('This file is not a zip archive, so it is not a classic skin.');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count > MAX_ZIP_ENTRIES) throw new Error('This skin file lists too many files to be a classic skin.');
  const decoder = new TextDecoder();
  const names = [];
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new Error('The skin file\'s zip directory is damaged.');
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    if (at + 46 + nameLength > bytes.length) throw new Error('The skin file\'s zip directory is damaged.');
    names.push(decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/** The required skin parts missing from a list of zip entry names (case-insensitive, any folder). */
export function missingSkinParts(names) {
  const present = new Set((names ?? []).map(name => String(name).split(/[\\/]/).pop().toUpperCase()));
  return REQUIRED_SKIN_PARTS.filter(part => !present.has(part));
}

/** A refusal message for a skin's bytes, or null when the skin has every required part. */
export function skinContentProblem(buffer) {
  let names;
  try { names = zipEntryNames(buffer); } catch (error) { return error.message; }
  const missing = missingSkinParts(names);
  if (!missing.length) return null;
  return `This skin lacks ${missing.join(', ')}, so NakliAmp will not show it: a classic skin needs at least its own main window image.`;
}

/**
 * A stand-in for an AnalyserNode that reads whichever analyser the engine has now.
 * Webamp keeps the node it gets at render time, while NakliAmp's analyser changes
 * with the decode route, and Webamp sets its own fftSize, which must not resize
 * NakliAmp's visualiser tap.
 */
export function analyserProxy(engine) {
  let size = 2048;
  let scratch = null;
  const current = () => { try { return engine.analyser?.() ?? null; } catch { return null; } };
  return {
    context: null,
    get fftSize() { return size; },
    set fftSize(value) { if (Number.isInteger(value) && value >= 32) size = value; },
    get frequencyBinCount() { return size / 2; },
    getByteTimeDomainData(out) {
      const node = current();
      if (!node) { out.fill(128); return; }
      if (!scratch || scratch.length !== node.fftSize) scratch = new Uint8Array(node.fftSize);
      node.getByteTimeDomainData(scratch);
      const n = Math.min(out.length, scratch.length);
      out.set(scratch.subarray(0, n));
      if (n < out.length) out.fill(128, n);
    },
    getByteFrequencyData(out) {
      const node = current();
      if (!node) { out.fill(0); return; }
      const bins = new Uint8Array(node.frequencyBinCount);
      node.getByteFrequencyData(bins);
      const n = Math.min(out.length, bins.length);
      out.set(bins.subarray(0, n));
      if (n < out.length) out.fill(0, n);
    },
  };
}

// --------------------------------------------------------------- bridge ----

const currentKeyOf = snap => (snap.index >= 0 ? String(snap.keys[snap.index]) : null);

function projectStatus(store, playing) {
  const status = store.getState().media.status;
  if (playing && status !== 'PLAYING') store.dispatch({ type: 'IS_PLAYING' });
  else if (!playing && status === 'PLAYING') store.dispatch({ type: 'PAUSE' });
}

function projectModes(store, snap) {
  if ((snap.repeat !== 'off') !== Boolean(store.getState().media.repeat)) store.dispatch({ type: 'TOGGLE_REPEAT' });
  if (store.getState().media.shuffle) store.dispatch({ type: 'TOGGLE_SHUFFLE' });
}

/**
 * The two-way bridge between NakliAmp (`ctx`) and one Webamp instance.
 * Pass `MediaClass` as `__customMediaClass` and `middleware` in `__customMiddlewares`,
 * then call `attach(webamp)` once the instance exists.
 */
export function createWebampBridge(ctx, {
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = id => clearInterval(id),
  later = (fn, ms) => setTimeout(fn, ms),
  now = () => Date.now(),
  tickMs = TICK_MS,
} = {}) {
  const listeners = new Map();
  const idToKey = new Map();
  const keyToId = new Map();
  const foreign = new Set();
  const analyser = analyserProxy(ctx.engine);
  let webamp = null;
  let syncing = 0;
  let fromFace = 0;
  let timer = null;
  let unsubscribers = [];
  let eqPending = null;
  let volumeHeldUntil = 0;
  let lastLoaded = null;
  // Webamp's middleware pushes its default volume, balance and preamp into the media
  // object while the store is built; NakliAmp's values win, so ignore everything until attach.
  let attached = false;

  const quiet = () => syncing > 0 || !attached;
  const report = error => { try { ctx.toast?.(error?.message ?? String(error)); } catch { /* no toast */ } };
  const run = (name, input = {}) => Promise.resolve().then(() => ctx.run(name, input)).catch(report);
  const emit = type => { for (const fn of listeners.get(type) ?? []) { try { fn(); } catch { /* Webamp listener */ } } };
  const engineState = () => { try { return ctx.engine.state(); } catch { return null; } };

  function withSync(fn) {
    syncing += 1;
    try { return fn(); } finally { syncing -= 1; }
  }

  function withFace(fn) {
    fromFace += 1;
    try { return fn(); } catch (error) { report(error); return undefined; } finally { fromFace -= 1; }
  }

  function flushEq() {
    const pending = eqPending;
    eqPending = null;
    if (!pending) return;
    const custom = curveOf(ctx.settings.get().eq);
    for (const [index, db] of pending) custom[index] = db;
    try { ctx.settings.set({ eq: { preset: 'custom', custom } }); } catch (error) { report(error); }
  }

  class NakliAmpMedia {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    }

    timeElapsed() { return Number(engineState()?.clock?.positionS) || 0; }

    duration() {
      const d = engineState()?.media?.duration;
      return Number.isFinite(d) ? d : 0;
    }

    play() { return quiet() ? Promise.resolve() : run('player.play'); }

    pause() { if (!quiet()) run('player.pause'); }

    stop() {
      if (quiet()) return;
      run('player.pause').then(() => (engineState()?.path ? run('player.seek', { seconds: 0 }) : null));
    }

    seekToPercentComplete(percent) {
      if (quiet() || !Number.isFinite(percent)) return;
      run('player.seek', { percent: clamp(percent, 0, 100) });
    }

    setVolume(volume) {
      if (quiet() || !Number.isFinite(volume)) return;
      volumeHeldUntil = now() + VOLUME_HOLD_MS;
      run('player.volume', { level: clamp(volume, 0, 100) / 100 });
    }

    setBalance() { /* NakliAmp has no balance control. */ }

    setPreamp() { /* NakliAmp's EQ has no preamp; the ReplayGain preamp is a different control. */ }

    setEqBand(band, value) {
      if (quiet()) return;
      const index = WEBAMP_BANDS_HZ.indexOf(Number(band));
      if (index < 0) return;
      const first = !eqPending;
      eqPending ??= new Map();
      eqPending.set(index, webampToDb(value));
      if (first) later(flushEq, EQ_FLUSH_MS);
    }

    disableEq() { if (!quiet()) run('eq.enable', { enabled: false }); }

    enableEq() { if (!quiet()) run('eq.enable', { enabled: true }); }

    getAnalyser() { return analyser; }

    loadFromUrl(url, autoPlay) {
      if (quiet()) return Promise.resolve();
      const key = keyFromUrl(url);
      if (key === null) return Promise.resolve();
      const snap = ctx.queue.snapshot();
      const index = snap.keys.findIndex(k => String(k) === key);
      if (index < 0) return Promise.resolve();
      if (index === snap.index) return autoPlay ? run('player.play') : Promise.resolve();
      try { ctx.queue.jump(index); } catch (error) { report(error); return Promise.resolve(); }
      return autoPlay ? run('player.play') : Promise.resolve();
    }

    dispose() { /* The bridge owns the timers; detach() releases them. */ }
  }

  function faceKeys(state) {
    return state.playlist.trackOrder.map(id => idToKey.get(id) ?? null);
  }

  function queueIndicesFor(ids) {
    const keys = ctx.queue.snapshot().keys.map(String);
    return ids.map(id => keys.indexOf(idToKey.get(id))).filter(i => i >= 0).toSorted((a, b) => a - b);
  }

  // Face edits that NakliAmp applies. Each returns what the middleware returns.
  const faceEdits = {
    TOGGLE_SHUFFLE: (store, next, action) => {
      const mode = SHUFFLE_CYCLE[(SHUFFLE_CYCLE.indexOf(ctx.queue.snapshot().shuffle) + 1) % SHUFFLE_CYCLE.length];
      run('queue.shuffle', { mode });
      return action;
    },
    TOGGLE_REPEAT: (store, next, action) => {
      const result = next(action);
      run('queue.repeat', { mode: store.getState().media.repeat ? 'all' : 'off' });
      return result;
    },
    REMOVE_TRACKS: (store, next, action) => {
      const indices = queueIndicesFor(action.ids ?? []);
      const result = next(action);
      if (indices.length) withFace(() => ctx.queue.remove(indices));
      return result;
    },
    REMOVE_ALL_TRACKS: (store, next, action) => {
      const result = next(action);
      withFace(() => ctx.queue.clear());
      return result;
    },
  };

  function reorder(store, next, action) {
    const result = next(action);
    const moves = planMoves(ctx.queue.snapshot().keys, faceKeys(store.getState()));
    if (moves?.length) withFace(() => { for (const m of moves) ctx.queue.move(m.from, m.to); });
    project();
    return result;
  }

  function addTrack(next, action) {
    const key = keyFromUrl(action.url);
    if (key === null) {
      foreign.add(action.id);
      if (!quiet()) ctx.toast?.('This face plays the NakliAmp queue. Add music from the library.');
      return action;
    }
    idToKey.set(action.id, key);
    keyToId.set(key, action.id);
    return next(action);
  }

  /** Webamp custom middleware: records entry ids, refuses foreign files, sends face edits to NakliAmp. */
  const middleware = store => next => action => {
    if (action.type === 'ADD_TRACK_FROM_URL') return addTrack(next, action);
    if (action.id !== undefined && foreign.has(action.id)) return action;
    if (quiet()) return next(action);
    if (faceEdits[action.type]) return faceEdits[action.type](store, next, action);
    if (REORDER_ACTIONS.has(action.type)) return reorder(store, next, action);
    return next(action);
  };

  function rebuildPlaylist(snap) {
    const store = webamp.store;
    store.dispatch({ type: 'REMOVE_ALL_TRACKS' });
    idToKey.clear();
    keyToId.clear();
    if (!snap.keys.length) return;
    webamp.appendTracks(snap.keys.map((key, i) => webampTrack(key, ctx.library.getTrack(snap.ids[i]))));
  }

  function projectCurrent(store, snap, es) {
    const playing = Boolean(es?.clock?.playing);
    const currentKey = currentKeyOf(snap);
    const currentId = currentKey === null ? undefined : keyToId.get(currentKey);
    if (currentId === undefined) return;
    if (store.getState().playlist.currentTrack !== currentId) {
      store.dispatch({ type: playing ? 'PLAY_TRACK' : 'BUFFER_TRACK', id: currentId });
    }
    projectStatus(store, playing);
    const duration = es?.media?.duration;
    const loaded = Number.isFinite(duration) ? `${currentKey}|${duration}` : null;
    if (loaded && loaded !== lastLoaded) { lastLoaded = loaded; emit('fileLoaded'); }
  }

  function projectVolume(store, es) {
    if (now() < volumeHeldUntil || !Number.isFinite(es?.clock?.volume)) return;
    const volume = Math.round(clamp(es.clock.volume, 0, 1) * 100);
    if (store.getState().media.volume !== volume) store.dispatch({ type: 'SET_VOLUME', volume });
  }

  function projectEq(store) {
    if (eqPending) return;
    const eq = ctx.settings.get().eq ?? {};
    const curve = curveOf(eq);
    const sliders = store.getState().equalizer.sliders;
    WEBAMP_BANDS_HZ.forEach((hz, i) => {
      const value = dbToWebamp(curve[i]);
      if (sliders[hz] !== value) store.dispatch({ type: 'SET_BAND_VALUE', band: hz, value });
    });
    if (Boolean(eq.enabled) !== Boolean(store.getState().equalizer.on)) {
      store.dispatch({ type: eq.enabled ? 'SET_EQ_ON' : 'SET_EQ_OFF' });
    }
  }

  /** Make Webamp's store show NakliAmp's state. Cheap when nothing changed. */
  function project() {
    if (!webamp || fromFace > 0) return;
    withSync(() => {
      const store = webamp.store;
      const snap = ctx.queue.snapshot();
      if (!sameList(faceKeys(store.getState()), snap.keys)) rebuildPlaylist(snap);
      const es = engineState();
      projectCurrent(store, snap, es);
      projectVolume(store, es);
      projectModes(store, snap);
      projectEq(store);
    });
  }

  function tick() {
    if (!webamp) return;
    project();
    emit('timeupdate');
  }

  function attach(instance) {
    webamp = instance;
    attached = true;
    const sub = (source, fn) => {
      try { const off = source?.(fn); if (typeof off === 'function') unsubscribers.push(off); } catch { /* optional source */ }
    };
    sub(fn => ctx.queue.onChange(fn), () => project());
    sub(fn => ctx.settings.on?.(fn), () => project());
    for (const type of ['track:loaded', 'track-advanced', 'transport:play', 'transport:pause', 'transport:seek']) {
      sub(fn => ctx.engine.on?.(type, fn), () => tick());
    }
    project();
    timer = setTimer(tick, tickMs);
  }

  function detach() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    for (const off of unsubscribers) { try { off(); } catch { /* already gone */ } }
    unsubscribers = [];
    flushEq();
    webamp = null;
    attached = false;
  }

  return {
    MediaClass: NakliAmpMedia,
    middleware,
    attach,
    detach,
    project,
    tick,
    flushEq,
    keyForId: id => idToKey.get(id) ?? null,
    idForKey: key => keyToId.get(String(key)),
  };
}

// ------------------------------------------------------------------ CSS ----

const CSS = `
.nk-skinface { display: grid; gap: 10px; color: var(--ink); }
.nk-skinface p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.45; }
.nk-skinface-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.nk-skinface-bar button { font: inherit; color: var(--ink); background: var(--panel-2); border: 1px solid var(--line);
  border-radius: 6px; padding: 6px 12px; cursor: pointer; }
.nk-skinface-bar button:hover { border-color: var(--accent); }
.nk-skinface-status { font-size: 12px; color: var(--muted); min-height: 1.2em; }
.nk-skinface-stage { position: relative; min-height: 380px; background: var(--panel); border: 1px solid var(--line);
  border-radius: 8px; overflow: hidden; }
.nk-skinface-stage:empty::after { content: 'No skin loaded. Drop a .wsz file here, or choose one above.'; position: absolute; inset: 0; display: grid;
  place-items: center; color: var(--muted); font-size: 13px; }
`;

// ---------------------------------------------------------------- mount ----

/**
 * Mount the classic skin face into `root`. Nothing is loaded until the person picks
 * a .wsz file; then the vendored Webamp module loads and renders inside the stage.
 * `options.loadWebamp` replaces the dynamic import (tests).
 */
export function mountWebampFace(root, ctx, { loadWebamp = () => import(WEBAMP_MODULE).then(m => m.default) } = {}) {
  injectCss('webamp-face', CSS);
  const status = h('div', { className: 'nk-skinface-status', role: 'status', 'aria-live': 'polite' });
  const stage = h('div', { className: 'nk-skinface-stage' });
  const input = h('input', { type: 'file', accept: '.wsz,.zip', hidden: true });
  const pick = h('button', { type: 'button', onClick: () => input.click() }, 'Choose a skin file (.wsz)');
  const closeButton = h('button', { type: 'button', hidden: true, onClick: () => unload() }, 'Close the skin face');
  root.append(h('section', { className: 'nk-skinface', 'aria-label': 'Classic skin face' },
    h('p', {}, 'Play your queue through a classic skin (.wsz) from your own disk. NakliAmp ships no skins, and the sound still comes from NakliAmp: its decoder, gapless playback, ReplayGain and equaliser.'),
    h('p', {}, 'Classic skins are shared freely online, for example in the skin museum at skins.webamp.org. Save a .wsz file, then choose it here or drop it on the box below.'),
    h('div', { className: 'nk-skinface-bar' }, pick, closeButton, input),
    status,
    stage));

  // Dropping a .wsz on the stage loads it, like choosing it with the button.
  stage.addEventListener('dragover', event => { event.preventDefault(); });
  stage.addEventListener('drop', event => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) load(file);
  });

  let webamp = null;
  let bridge = null;
  let skinUrl = null;
  let busy = false;

  const say = text => { status.textContent = text; };
  const swapUrl = file => {
    const next = URL.createObjectURL(file);
    const old = skinUrl;
    skinUrl = next;
    return () => { if (old) URL.revokeObjectURL(old); };
  };

  async function load(file) {
    const problem = skinFileProblem(file);
    if (problem) { say(problem); return; }
    if (busy) return;
    busy = true;
    try {
      const contentProblem = skinContentProblem(await file.arrayBuffer());
      if (contentProblem) { say(contentProblem); return; }
      const release = swapUrl(file);
      if (webamp) {
        webamp.setSkinFromUrl(skinUrl);
        await webamp.skinIsLoaded();
        release();
        say(`Skin: ${file.name}`);
        return;
      }
      say('Loading the skin face…');
      const Webamp = await loadWebamp();
      if (!Webamp.browserIsSupported?.()) { say('This browser lacks a feature the skin face needs.'); release(); return; }
      bridge = createWebampBridge(ctx);
      webamp = new Webamp({
        initialSkin: { url: skinUrl },
        enableHotkeys: false,
        __customMediaClass: bridge.MediaClass,
        __customMiddlewares: [bridge.middleware],
      });
      bridge.attach(webamp);
      webamp.onClose(() => unload());
      await webamp.renderInto(stage);
      release();
      closeButton.hidden = false;
      pick.textContent = 'Choose another skin (.wsz)';
      say(`Skin: ${file.name}`);
    } catch (error) {
      say(`The skin face could not load: ${error?.message ?? error}`);
      unload({ keepStatus: true });
    } finally {
      busy = false;
    }
  }

  function unload({ keepStatus = false } = {}) {
    bridge?.detach();
    bridge = null;
    const instance = webamp;
    webamp = null;
    try { instance?.dispose(); } catch { /* Webamp's dispose is best effort by its own docs */ }
    stage.replaceChildren();
    if (skinUrl) { URL.revokeObjectURL(skinUrl); skinUrl = null; }
    closeButton.hidden = true;
    pick.textContent = 'Choose a skin file (.wsz)';
    if (!keepStatus) say('');
  }

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    load(file);
  });

  return {
    update() { bridge?.project(); },
    destroy() { unload(); root.replaceChildren(); },
    loadSkin: load,
  };
}
