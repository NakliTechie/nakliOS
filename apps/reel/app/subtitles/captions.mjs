/* Caption overlay: real text over the letterboxed picture, plus a polite live region so screen
 * readers announce each new cue. Created inside install(), never at module top level. */

import { plainText } from './parse.mjs';

export const DEFAULT_STYLE = Object.freeze({ size: 1, color: '#ffffff', backgroundOpacity: 0.6, position: 6 });
export const STYLE_LIMITS = Object.freeze({ size: [0.5, 2.5], backgroundOpacity: [0, 1], position: [0, 40] });

export function normaliseStyle(input = {}, base = DEFAULT_STYLE) {
  const out = { ...base };
  for (const key of ['size', 'backgroundOpacity', 'position']) {
    const value = Number(input[key]);
    if (input[key] !== undefined && Number.isFinite(value)) {
      const [lo, hi] = STYLE_LIMITS[key];
      out[key] = Math.min(hi, Math.max(lo, value));
    }
  }
  if (typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color)) out.color = input.color.toLowerCase();
  return out;
}

const CSS = `
.reel-subs{position:absolute;pointer-events:none;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.25;text-align:center}
.reel-subs-stack{position:absolute;left:5%;right:5%;display:flex;flex-direction:column;align-items:center;gap:.15em}
.reel-subs-top{top:4%}
.reel-subs-line{display:block;max-width:100%}
.reel-subs-text{padding:.05em .35em;border-radius:.15em;-webkit-box-decoration-break:clone;box-decoration-break:clone;white-space:pre-wrap;text-shadow:0 0 .12em rgba(0,0,0,.9),0 .04em .08em rgba(0,0,0,.9)}
.reel-subs-live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
`;

/* The rect of a contained picture (object-fit: contain) inside an element box. */
export function containedRect(boxWidth, boxHeight, pictureWidth, pictureHeight) {
  if (!(boxWidth > 0 && boxHeight > 0 && pictureWidth > 1 && pictureHeight > 1)) {
    return { left: 0, top: 0, width: boxWidth, height: boxHeight };
  }
  const scale = Math.min(boxWidth / pictureWidth, boxHeight / pictureHeight);
  const width = pictureWidth * scale;
  const height = pictureHeight * scale;
  return { left: (boxWidth - width) / 2, top: (boxHeight - height) / 2, width, height };
}

export function sameIndices(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function createCaptions(ctx) {
  ctx.addStyle(CSS);
  const stage = ctx.mounts.stage;
  const layer = document.createElement('div');
  layer.className = 'reel-subs';
  layer.setAttribute('aria-hidden', 'true');
  const bottom = document.createElement('div');
  bottom.className = 'reel-subs-stack reel-subs-bottom';
  const top = document.createElement('div');
  top.className = 'reel-subs-stack reel-subs-top';
  layer.append(top, bottom);
  const live = document.createElement('div');
  live.className = 'reel-subs-live';
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-label', ctx.t('subtitles.live.label'));
  stage.append(layer, live);

  let index = null;
  let secondary = null;
  let primaryHidden = false;
  let delayS = 0;
  let pictureRect = { width: 0, height: 0 };
  const canvasHooks = new Set();
  let style = { ...DEFAULT_STYLE };
  let shownFirst = [];
  let shownSecond = [];
  let shownAny = false;
  let shownText = '';
  let layoutKey = '';
  let fontPx = 16;

  function layout(force = false) {
    const canvas = ctx.canvas();
    if (!canvas) return;
    const canvasBox = canvas.getBoundingClientRect();
    const stageBox = stage.getBoundingClientRect();
    const key = [canvas.width, canvas.height, canvasBox.left, canvasBox.top, canvasBox.width, canvasBox.height,
      stageBox.left, stageBox.top, style.size, style.position].join(',');
    if (!force && key === layoutKey) return;
    layoutKey = key;
    const rect = containedRect(canvasBox.width, canvasBox.height, canvas.width, canvas.height);
    layer.style.left = `${canvasBox.left - stageBox.left + rect.left}px`;
    layer.style.top = `${canvasBox.top - stageBox.top + rect.top}px`;
    layer.style.width = `${rect.width}px`;
    layer.style.height = `${rect.height}px`;
    pictureRect = { width: rect.width, height: rect.height, pictureWidth: canvas.width, pictureHeight: canvas.height };
    for (const hook of canvasHooks) hook(pictureRect);
    fontPx = Math.max(11, rect.height * 0.05 * style.size);
    layer.style.fontSize = `${fontPx}px`;
    bottom.style.bottom = `${style.position}%`;
  }

  function paintColours() {
    layer.style.color = style.color;
    layer.style.setProperty('--reel-subs-bg', `rgba(0,0,0,${style.backgroundOpacity})`);
    for (const span of layer.querySelectorAll('.reel-subs-text')) span.style.background = `rgba(0,0,0,${style.backgroundOpacity})`;
  }

  function cueNode(cue) {
    const block = document.createElement('div');
    for (const line of cue.lines) {
      const row = document.createElement('div');
      row.className = 'reel-subs-line';
      row.dir = 'auto';
      const text = document.createElement('span');
      text.className = 'reel-subs-text';
      text.style.background = `rgba(0,0,0,${style.backgroundOpacity})`;
      for (const run of line) {
        const span = document.createElement('span');
        span.textContent = run.text;
        if (run.i) span.style.fontStyle = 'italic';
        if (run.b) span.style.fontWeight = '700';
        if (run.u) span.style.textDecoration = 'underline';
        text.append(span);
      }
      row.append(text);
      block.append(row);
    }
    return block;
  }

  /* active: indices into the primary index; second: indices into the secondary index.
   * The secondary track always sits at the top of the picture. */
  function render(active, second = [], force = false) {
    // Index arrays are compared directly, not joined into a string each frame (V13).
    if (!force && sameIndices(active, shownFirst) && sameIndices(second, shownSecond)) return;
    shownFirst = active;
    shownSecond = second;
    shownAny = active.length > 0 || second.length > 0;
    const cues = active.map(i => index.cues[i]);
    const extra = second.map(i => secondary.cues[i]);
    top.replaceChildren(...extra.map(cueNode), ...cues.filter(cue => cue.placement === 'top').map(cueNode));
    bottom.replaceChildren(...cues.filter(cue => cue.placement !== 'top').map(cueNode));
    shownText = [...cues, ...extra].map(plainText).join('\n');
    // Announce only new text; clearing the screen is silent.
    if (shownText) live.textContent = shownText;
  }

  function frame(state) {
    layout();
    const positionS = Number(state?.clock?.positionS) || 0;
    const t = positionS - delayS;
    const first = index && !primaryHidden ? index.activeAt(t) : [];
    const second = secondary ? secondary.activeAt(t) : [];
    if (!first.length && !second.length && !shownAny) return;
    render(first, second);
  }

  const relayout = () => layout(true);
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(relayout);
    observer.observe(stage);
    const canvas = ctx.canvas();
    if (canvas) observer.observe(canvas);
  }
  addEventListener('resize', relayout);
  document.addEventListener('fullscreenchange', relayout);
  document.addEventListener('webkitfullscreenchange', relayout);

  // Repaint now from the engine clock, so changes show without waiting for an animation
  // frame (background tabs throttle frames to a few per second).
  function refresh() {
    try { frame(ctx.Engine.state()); } catch { /* the next frame repaints */ }
  }

  return {
    setIndex(next) { index = next; render([], [], true); refresh(); },
    setSecondary(next) { secondary = next; render([], [], true); refresh(); },
    /* Hides the primary text while a canvas renderer (styled ASS, PGS) draws it instead. */
    setPrimaryHidden(hidden) { primaryHidden = !!hidden; refresh(); },
    /* Calls fn(rect) whenever the picture rect changes; returns an unsubscribe function. */
    onLayout(fn) { canvasHooks.add(fn); fn(pictureRect); return () => canvasHooks.delete(fn); },
    picture: () => ({ ...pictureRect }),
    delay: () => delayS,
    setDelay(next) { delayS = next; refresh(); },
    refresh,
    setStyle(next) { style = { ...next }; layout(true); paintColours(); },
    clear() { index = null; secondary = null; primaryHidden = false; render([], [], true); live.textContent = ''; },
    frame,
    text: () => shownText,
    layer,
  };
}
