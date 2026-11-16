// lyrics.mjs — the lyrics view for the playing track (T6 embedded, T7 .lrc sidecar).
//
// Embedded text comes from the file (readLyrics reads it with readLyricsText); a
// sidecar is the file with the same base name and `.lrc` in the track's folder,
// reached through the music folder handle. Synced lyrics highlight the current line
// and scroll to it while following the engine position; after you scroll by hand the
// view stops following for a few seconds. Reduced motion jumps instead of sliding.
// Plain lyrics scroll freely.

import { readLyrics, lineIndexAt, sidecarNameFor } from '../library/lyrics.mjs';
import { h, injectCss, reducedMotion } from './dialog.mjs';

export const FOLLOW_PAUSE_MS = 4000;
export const TICK_MS = 250;

// ---------------------------------------------------------------- pure ----

/** The line to highlight: -1 for plain lyrics, before the first line, or with no lyrics. */
export function activeLineIndex(lyrics, positionS) {
  if (!lyrics?.synced || !lyrics.lines?.length || !Number.isFinite(positionS)) return -1;
  return lineIndexAt(lyrics.lines, positionS);
}

/** The directory names and file name of a track path relative to the music folder. */
export function splitTrackPath(path) {
  const parts = String(path ?? '').split('/').filter(part => part && part !== '.');
  const name = parts.pop() ?? '';
  return { directories: parts, name };
}

export function sourceText(lyrics) {
  if (!lyrics) return '';
  const kind = lyrics.synced ? 'Synced lyrics' : 'Lyrics';
  return lyrics.source === 'lrc' ? `${kind} from the .lrc file beside the track` : `${kind} embedded in the file`;
}

/**
 * The sidecar File for a track, or null. Walks the folder handle along the track's
 * path; tries the exact `.lrc` name, then `.LRC`.
 */
export async function findSidecar(rootHandle, track) {
  if (!rootHandle || !track?.path) return null;
  const { directories, name } = splitTrackPath(track.path);
  try {
    let directory = rootHandle;
    for (const part of directories) directory = await directory.getDirectoryHandle(part);
    const base = sidecarNameFor(name || track.name);
    for (const candidate of [base, base.replace(/\.lrc$/, '.LRC')]) {
      try {
        const handle = await directory.getFileHandle(candidate);
        return await handle.getFile();
      } catch { /* try the next spelling */ }
    }
  } catch { /* the folder moved or permission lapsed: no sidecar */ }
  return null;
}

// ------------------------------------------------------------------ CSS ----

const CSS = `
.nk-lyr,.nk-lyr *{box-sizing:border-box}
.nk-lyr{--c-ink:var(--ink,var(--text));color:var(--c-ink);display:flex;flex-direction:column;min-height:0;max-height:100%;min-width:0}
.nk-lyr .src{font:10px var(--mono,monospace);letter-spacing:.06em;color:var(--muted);margin:0 0 8px}
.nk-lyr .scroller{position:relative;overflow:auto;max-height:min(60vh,520px);padding:8px 4px;border-radius:10px;scroll-padding:40% 0}
.nk-lyr ol{list-style:none;margin:0;padding:0}
.nk-lyr li{padding:4px 6px;border-radius:7px;line-height:1.5;font-size:16px;color:var(--muted);overflow-wrap:anywhere}
.nk-lyr.plain li{color:var(--c-ink)}
.nk-lyr li.blank{min-height:1em}
.nk-lyr li[aria-current="true"]{color:var(--c-ink);background:color-mix(in srgb,var(--accent) 16%,transparent);font-weight:650}
.nk-lyr.synced li{cursor:pointer}
.nk-lyr.synced li:hover{color:var(--c-ink)}
.nk-lyr .empty{color:var(--muted);margin:12px 0}
.nk-lyr .resume{align-self:flex-start;margin-top:8px}
.nk-lyr .resume[hidden]{display:none}
`;

// ------------------------------------------------------------------- UI ----

export function mountLyrics(root, ctx) {
  injectCss('lyrics', CSS);
  const source = h('p', { className: 'src' });
  const list = h('ol', { 'aria-label': 'Lyrics' });
  const scroller = h('div', { className: 'scroller', tabindex: '0', 'aria-label': 'Lyrics, scrollable' }, list);
  const resume = h('button', { type: 'button', className: 'nk-btn resume', hidden: true, textContent: 'Follow the song again' });
  const container = h('div', { className: 'nk-lyr' }, source, scroller, resume);
  root.append(container);

  let trackId = null;
  let lyrics = null;
  let items = [];
  let active = -1;
  let token = 0;
  let pausedUntil = 0;
  let programmatic = false;

  function pauseFollow() {
    if (programmatic || !lyrics?.synced) return;
    pausedUntil = Date.now() + FOLLOW_PAUSE_MS;
    resume.hidden = false;
  }
  scroller.addEventListener('wheel', pauseFollow, { passive: true });
  scroller.addEventListener('touchmove', pauseFollow, { passive: true });
  scroller.addEventListener('keydown', event => { if (/^(Arrow|Page|Home|End)/.test(event.key)) pauseFollow(); });
  resume.addEventListener('click', () => { pausedUntil = 0; resume.hidden = true; follow(true); });

  function setState(text) {
    list.replaceChildren();
    items = [];
    active = -1;
    source.textContent = '';
    container.classList.remove('synced', 'plain');
    if (text) list.replaceChildren(h('li', { className: 'empty', textContent: text }));
  }

  function render() {
    container.classList.toggle('synced', lyrics.synced);
    container.classList.toggle('plain', !lyrics.synced);
    source.textContent = sourceText(lyrics);
    items = lyrics.lines.map(line => {
      const li = h('li', { className: line.text ? '' : 'blank', textContent: line.text || '' });
      if (lyrics.synced && Number.isFinite(line.timeS)) {
        li.title = 'Play from this line';
        li.addEventListener('click', () => ctx.run?.('player.seek', { seconds: line.timeS })?.catch?.(() => {}));
      }
      return li;
    });
    list.replaceChildren(...items);
    active = -1;
    follow(true);
  }

  async function load(id) {
    const mine = ++token;
    trackId = id;
    lyrics = null;
    pausedUntil = 0;
    resume.hidden = true;
    const track = id ? ctx.library.getTrack(id) : null;
    if (!track) { setState('Nothing is playing.'); return; }
    setState('Reading lyrics...');
    let file = null;
    let sidecar = null;
    try { file = await ctx.library.fileFor(track); } catch { file = null; }
    try { sidecar = await findSidecar(await ctx.library.folderHandle?.(), track); } catch { sidecar = null; }
    const found = await readLyrics(file, sidecar);
    if (mine !== token) return;
    if (!found) { setState('No lyrics in this file, and no .lrc file beside it.'); return; }
    lyrics = found;
    render();
  }

  function enginePosition() {
    try { return ctx.engine?.state?.()?.clock?.positionS; } catch { return NaN; }
  }

  function scrollToItem(item) {
    resume.hidden = true;
    programmatic = true;
    const top = item.offsetTop - scroller.clientHeight / 2 + item.clientHeight / 2;
    scroller.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? 'auto' : 'smooth' });
    setTimeout(() => { programmatic = false; }, reducedMotion() ? 0 : 400);
  }

  function follow(force = false) {
    if (!lyrics?.synced) return;
    const next = activeLineIndex(lyrics, enginePosition());
    if (next === active && !force) return;
    items[active]?.removeAttribute('aria-current');
    active = next;
    const item = items[active];
    if (!item) return;
    item.setAttribute('aria-current', 'true');
    if (!force && Date.now() < pausedUntil) return;
    scrollToItem(item);
  }

  const timer = setInterval(() => {
    const current = ctx.queue?.current?.() ?? null;
    if (current !== trackId) load(current);
    else follow();
  }, TICK_MS);
  load(ctx.queue?.current?.() ?? null);

  return {
    update() {
      const id = ctx.queue?.current?.() ?? null;
      if (id !== trackId) load(id);
      else follow(true);
    },
    destroy() {
      clearInterval(timer);
      token += 1;
      container.remove();
    },
  };
}
