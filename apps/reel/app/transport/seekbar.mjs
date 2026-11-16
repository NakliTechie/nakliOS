/* Reel transport, batch 2: seek-bar previews (P9), buffered and keyframe hints (P10) and the
 * volume boost read-out (P11). Installed from ./index.mjs. Every engine method is feature-detected,
 * so the seek bar still works when one is missing. */

import {
  thumbBucket, createLru, pointerFraction, mergeRanges, keyframeMode, keyframeDensity, volumePercent,
} from './logic.mjs';

export const SEEKBAR_STRINGS = {
  'transport.volume.boost': 'Volume boosted to {percent}%',
  'transport.volume.boostSub': 'Above 100% the sound can distort. Arrow keys step by 5%.',
  'transport.volume.readout': 'Volume {percent}%',
};

export const SEEKBAR_CSS = `
.transport-preview{position:absolute;bottom:calc(100% + 8px);left:0;z-index:4;pointer-events:none;display:grid;justify-items:center;gap:4px;padding:4px;background:rgba(11,11,14,.92);border:1px solid var(--line);border-radius:10px}
.transport-preview[hidden]{display:none}
.transport-preview canvas{display:block;width:160px;height:auto;border-radius:6px;background:#000}
.transport-preview canvas[hidden]{display:none}
.transport-preview-time{font-size:11px;font-variant-numeric:tabular-nums;color:var(--text)}
.transport-track{position:absolute;left:8px;right:8px;bottom:1px;height:3px;pointer-events:none}
.transport-track span{position:absolute;top:0;bottom:0;background:var(--text);opacity:.28;border-radius:2px}
.transport-keys{position:absolute;left:8px;right:8px;bottom:-3px;height:4px;pointer-events:none}
.transport-keys span{position:absolute;top:0;bottom:0;width:1px;background:var(--dim);opacity:.7}
.transport-keys[data-mode="band"]{opacity:.8;border-radius:2px}
.transport-volume{font-size:11px;font-variant-numeric:tabular-nums;color:var(--accent);min-width:4ch}
.transport-volume[hidden]{display:none}
`;

const THUMB_DEBOUNCE_MS = 90;
const BUFFERED_POLL_MS = 250;
const INSET_PX = 8;

export function installSeekbar(ctx, { el, duration }) {
  const { Engine, store, t, toast, formatTime } = ctx;
  const wrap = ctx.mounts.seek;
  const seekInput = wrap.querySelector('input[type="range"]');
  const fileKey = () => store.media.fingerprint || Engine.state()?.media?.fingerprint || store.media.name || 'file';

  /* ------------------------------------------------- P9 thumbnails -- */
  const thumbCanvas = el('canvas', { width: 160, height: 90, hidden: true });
  const thumbTime = el('span', { class: 'transport-preview-time' });
  const preview = el('div', { class: 'transport-preview', 'aria-hidden': 'true', hidden: true,
    'data-transport-preview': '', 'data-requests': '0' }, thumbCanvas, thumbTime);
  wrap.append(preview);

  const cache = createLru(120, bitmap => bitmap?.close?.());
  let wantedKey = null;
  let timer = 0;
  let requests = 0;
  let pointerInside = false;

  function drawThumb(bitmap, key) {
    if (!bitmap) {
      thumbCanvas.hidden = true;
      preview.dataset.loaded = '';
      return;
    }
    thumbCanvas.width = bitmap.width;
    thumbCanvas.height = bitmap.height;
    thumbCanvas.getContext('2d').drawImage(bitmap, 0, 0);
    thumbCanvas.hidden = false;
    preview.dataset.loaded = key;
  }

  async function requestThumb(bucket, key) {
    if (typeof Engine.thumbnail !== 'function') {
      preview.dataset.thumbs = 'unsupported';
      return;
    }
    requests += 1;
    preview.dataset.requests = String(requests);
    let bitmap = null;
    try {
      bitmap = await Engine.thumbnail(bucket.timeS, { maxWidth: 160 });
    } catch (error) {
      // A newer request cancels this one; that is expected and not an error for the person.
      if (error?.name !== 'AbortError') console.warn('[transport] thumbnail', error);
      return;
    }
    if (!key.startsWith(`${fileKey()}:`)) { bitmap?.close?.(); return; } // the file changed meanwhile
    cache.set(key, bitmap ?? null);
    if (wantedKey === key) drawThumb(bitmap ?? null, key);
  }

  function placePreview(fraction) {
    const width = wrap.clientWidth;
    const x = INSET_PX + fraction * Math.max(0, width - 2 * INSET_PX);
    const own = preview.offsetWidth || 170;
    preview.style.left = `${Math.max(0, Math.min(width - own, x - own / 2))}px`;
  }

  function showAt(timeS) {
    const d = duration();
    if (!(d > 0) || store.ui.screen !== 'player') return hidePreview();
    const clamped = Math.max(0, Math.min(d, timeS));
    preview.hidden = false;
    preview.dataset.timeS = clamped.toFixed(3);
    thumbTime.textContent = formatTime(clamped);
    placePreview(clamped / d);
    const bucket = thumbBucket(clamped, d);
    const key = `${fileKey()}:${bucket.key}`;
    wantedKey = key;
    clearTimeout(timer);
    if (cache.has(key)) {
      drawThumb(cache.get(key), key);
      return;
    }
    timer = setTimeout(() => requestThumb(bucket, key), THUMB_DEBOUNCE_MS);
  }

  function hidePreview() {
    clearTimeout(timer);
    wantedKey = null;
    preview.hidden = true;
  }

  if (seekInput) {
    seekInput.addEventListener('pointermove', event => {
      pointerInside = true;
      const rect = seekInput.getBoundingClientRect();
      showAt(pointerFraction(event.clientX, rect.left, rect.width, INSET_PX) * duration());
    });
    seekInput.addEventListener('pointerleave', () => {
      pointerInside = false;
      if (document.activeElement === seekInput && seekInput.matches(':focus-visible')) showAt(Number(seekInput.value));
      else hidePreview();
    });
    seekInput.addEventListener('focus', () => { if (!pointerInside) showAt(Number(seekInput.value)); });
    seekInput.addEventListener('input', () => { if (document.activeElement === seekInput) showAt(Number(seekInput.value)); });
    seekInput.addEventListener('blur', () => { if (!pointerInside) hidePreview(); });
  }

  /* --------------------------------------- P10 buffered and keyframes -- */
  const track = el('div', { class: 'transport-track', 'aria-hidden': 'true', 'data-transport-buffered': '' });
  const keys = el('div', { class: 'transport-keys', 'aria-hidden': 'true', 'data-transport-keyframes': '', 'data-mode': 'none' });
  wrap.prepend(track, keys); // under the range input, so the thumb stays on top

  let lastBufferedAt = 0;
  let lastBufferedSig = '';

  function renderBuffered() {
    if (typeof Engine.buffered !== 'function') { track.dataset.mode = 'unsupported'; return; }
    const d = duration();
    let ranges = [];
    try { ranges = mergeRanges(Engine.buffered(), d); } catch (error) { console.warn('[transport] buffered', error); }
    const sig = ranges.map(r => `${r.startS.toFixed(2)}-${r.endS.toFixed(2)}`).join(',');
    if (sig === lastBufferedSig) return;
    lastBufferedSig = sig;
    track.replaceChildren(...(d > 0 ? ranges : []).map(range => el('span', {
      style: `left:${((range.startS / d) * 100).toFixed(3)}%;width:${(((range.endS - range.startS) / d) * 100).toFixed(3)}%`,
      'data-start-s': range.startS.toFixed(3), 'data-end-s': range.endS.toFixed(3) })));
  }

  function renderKeyframes() {
    keys.replaceChildren();
    keys.style.background = '';
    if (typeof Engine.keyframes !== 'function') { keys.dataset.mode = 'unsupported'; return 0; }
    const d = duration();
    let times = [];
    try { times = (Engine.keyframes() || []).filter(time => Number.isFinite(time)); } catch (error) { console.warn('[transport] keyframes', error); }
    const mode = d > 0 ? keyframeMode(times.length) : 'none';
    keys.dataset.mode = mode;
    keys.dataset.count = String(times.length);
    if (mode === 'ticks') {
      keys.append(...times.map(time => el('span', { 'data-transport-keyframe': '',
        style: `left:${((Math.min(time, d) / d) * 100).toFixed(3)}%` })));
    } else if (mode === 'band') {
      const density = keyframeDensity(times, d);
      const stops = density.map((value, i) => {
        const alpha = (0.15 + 0.6 * value).toFixed(2);
        return `rgba(138,138,147,${alpha}) ${i}% ${i + 1}%`;
      });
      keys.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
    }
    return times.length;
  }

  /* ------------------------------------------------ P11 volume boost -- */
  const volume = el('span', { class: 'transport-volume', hidden: true, 'data-transport-volume': '' });
  ctx.mounts.controlsRight.prepend(volume); // first in the right mount, which follows the volume slider
  let boostToastShown = false;

  function renderVolume() {
    const value = Engine.state()?.clock?.volume ?? store.clock.volume;
    const percent = volumePercent(value);
    volume.hidden = percent <= 100;
    volume.textContent = `${percent}%`;
    volume.title = t('transport.volume.readout', { percent });
    if (percent > 100 && !boostToastShown && store.ui.screen === 'player') {
      boostToastShown = true;
      toast(t('transport.volume.boost', { percent }), 'info', t('transport.volume.boostSub'));
    }
  }

  /* ------------------------------------------------------- events -- */
  function resetForFile() {
    hidePreview();
    cache.clear();
    lastBufferedSig = '';
    track.replaceChildren();
    boostToastShown = false;
  }

  ctx.on('ui:media-loaded', () => {
    resetForFile();
    renderBuffered();
    // The container index can arrive just after load; read again once if it was empty.
    if (renderKeyframes() === 0 && typeof Engine.keyframes === 'function') setTimeout(renderKeyframes, 1000);
    renderVolume();
  });
  ctx.on('ui:media-cleared', () => {
    resetForFile();
    keys.replaceChildren();
    keys.style.background = '';
    keys.dataset.mode = 'none';
  });
  ctx.on('playback:loaded', () => renderKeyframes());
  ctx.on('playback:seek', () => { lastBufferedAt = 0; });
  ctx.on('playback:volume', () => renderVolume());

  ctx.onFrame(() => {
    const now = performance.now();
    if (now - lastBufferedAt < BUFFERED_POLL_MS) return;
    lastBufferedAt = now;
    renderBuffered();
  });

  renderVolume();
}
