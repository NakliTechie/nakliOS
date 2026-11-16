/* Reel feature module: transport. Contract: docs/build/reel-v1-contract.md.
 * Rows: P5 frame step, P6 A-B loop, P7 chapters, P8 jump to time, A1 audio track menu, A2 audio delay.
 * No DOM access at module top level, so Node can import COMMANDS for commands.json.
 * Pure logic lives in ./logic.mjs (tested in Node by test/transport.test.mjs). */

import {
  parseTime, normaliseChapters, chapterIndexAt, nextChapterIndex, previousChapterIndex,
  LOOP_OFF, cycleLoop, setLoopPoints, clampAudioDelay, formatDelay, AUDIO_DELAY_STEP_S,
  nextTrackIndex, describeAudioTrack,
} from './logic.mjs';

const none = { type: 'object', properties: {}, required: [] };
const panelFlag = { type: 'boolean', description: 'true opens the panel, false closes it' };

export const COMMANDS = [
  { name: 'frame.step', label: 'Step one frame', scope: 'write', readTwin: 'state.read',
    description: 'Show the next (direction 1) or previous (direction -1) frame while paused; if playing, the first step pauses.',
    input: { type: 'object', properties: { direction: { type: 'integer', enum: [-1, 1] } }, required: ['direction'] },
    shortcuts: [{ key: '.', input: { direction: 1 } }, { key: ',', input: { direction: -1 } }] },
  { name: 'loop.set', label: 'A-B loop', scope: 'write', readTwin: 'loop.read',
    description: 'Set or clear the A-B loop. "cycle" sets A, then B, then clears, at the current position; "set" takes aS and bS; "a" and "b" set one point; "clear" removes the loop.',
    input: { type: 'object', properties: {
      action: { type: 'string', enum: ['cycle', 'a', 'b', 'set', 'clear'], description: 'Defaults to cycle' },
      aS: { type: 'number', minimum: 0, description: 'Loop start in seconds (set, a)' },
      bS: { type: 'number', minimum: 0, description: 'Loop end in seconds (set, b); must be after A' } }, required: [] },
    shortcuts: [{ key: 'l', input: { action: 'cycle' } }] },
  { name: 'loop.read', label: 'Loop state', scope: 'read', input: none,
    description: 'Read the A-B loop: phase (off, a, ab), aS and bS in seconds, and what the engine is looping.' },
  { name: 'chapter.next', label: 'Next chapter', scope: 'write', readTwin: 'chapter.list', input: none,
    description: 'Seek to the start of the next chapter.', shortcuts: [{ key: 'pagedown' }] },
  { name: 'chapter.previous', label: 'Previous chapter', scope: 'write', readTwin: 'chapter.list', input: none,
    description: 'Seek to the start of the current chapter when more than 3 s into it, otherwise to the previous chapter.',
    shortcuts: [{ key: 'pageup' }] },
  { name: 'chapter.go', label: 'Go to chapter', scope: 'write', readTwin: 'chapter.list',
    description: 'Seek to the start of the chapter at a zero-based index.',
    input: { type: 'object', properties: { index: { type: 'integer', minimum: 0 } }, required: ['index'] } },
  { name: 'chapter.list', label: 'Chapters', scope: 'read',
    description: 'List the chapters (title, startS, endS) and the current chapter index; panel opens or closes the chapters panel.',
    input: { type: 'object', properties: { panel: panelFlag }, required: [] } },
  { name: 'playback.jumpTo', label: 'Jump to time', scope: 'write', readTwin: 'state.read',
    description: 'Seek to a typed time such as "1:23:45", "83:20", "90" (seconds) or "45%"; with no time it opens the jump-to-time box.',
    input: { type: 'object', properties: {
      time: { type: ['string', 'number'], description: 'h:mm:ss, m:ss, seconds, or a percentage like "45%"' } }, required: [] },
    shortcuts: [{ key: 't' }] },
  { name: 'audio.track', label: 'Audio track', scope: 'write', readTwin: 'audio.read',
    description: 'Switch to the audio track at a zero-based index, or step through the tracks by delta; with no input it moves to the next track.',
    input: { type: 'object', properties: {
      index: { type: 'integer', minimum: 0 },
      delta: { type: 'integer', description: 'Tracks to move; negative goes back' } }, required: [] },
    shortcuts: [{ key: 'v' }] },
  { name: 'audio.delay', label: 'Audio delay', scope: 'write', readTwin: 'audio.read',
    description: 'Offset the audio against the video from -10 to 10 seconds (positive plays audio later): set delayS, step by deltaS, or reset to 0.',
    input: { type: 'object', properties: {
      delayS: { type: 'number', minimum: -10, maximum: 10 },
      deltaS: { type: 'number', description: 'Change from the current delay in seconds' },
      reset: { type: 'boolean' } }, required: [] },
    shortcuts: [{ key: 'j', input: { deltaS: -AUDIO_DELAY_STEP_S } }, { key: 'k', input: { deltaS: AUDIO_DELAY_STEP_S } }] },
  { name: 'audio.read', label: 'Audio tracks', scope: 'read',
    description: 'List the audio tracks (title, language, codec, channels), the selected index and the audio delay; panel opens or closes the audio panel.',
    input: { type: 'object', properties: { panel: panelFlag }, required: [] } },
];

export const STRINGS = {
  'transport.frame.back': 'Previous frame',
  'transport.frame.forward': 'Next frame',
  'transport.frame.paused': 'Paused for frame stepping',
  'transport.loop.button': 'A-B loop',
  'transport.loop.buttonA': 'A-B loop: A set at {time}, press again to set B',
  'transport.loop.buttonAB': 'A-B loop: {a} to {b}, press again to clear',
  'transport.loop.setA': 'Loop start set at {time}',
  'transport.loop.setB': 'Looping {a} to {b}',
  'transport.loop.cleared': 'Loop cleared',
  'transport.loop.reject': 'Loop end must come after the start',
  'transport.loop.rejectSub': 'The start is at {time}. Move later and press again.',
  'transport.loop.markA': 'Loop start',
  'transport.loop.markB': 'Loop end',
  'transport.chapter.button': 'Chapters',
  'transport.chapter.panel': 'Chapters',
  'transport.chapter.current': 'Current chapter: {title}',
  'transport.chapter.untitled': 'Chapter {n}',
  'transport.chapter.item': '{title}, at {time}',
  'transport.chapter.none': 'This video has no chapters.',
  'transport.jump.title': 'Jump to time',
  'transport.jump.label': 'Time',
  'transport.jump.hint': 'For example 1:23:45, 83:20, 90 (seconds) or 45%.',
  'transport.jump.go': 'Go',
  'transport.jump.cancel': 'Cancel',
  'transport.jump.empty': 'Type a time.',
  'transport.jump.format': 'Use h:mm:ss, m:ss, seconds or a percentage.',
  'transport.jump.range': 'That time is past the end of this video ({duration}).',
  'transport.audio.button': 'Audio tracks and delay',
  'transport.audio.panel': 'Audio',
  'transport.audio.tracks': 'Tracks',
  'transport.audio.switched': 'Audio: {title}',
  'transport.audio.delay': 'Audio delay',
  'transport.audio.delayValue': 'Audio delay {value}',
  'transport.audio.delayLater': 'Audio 50 ms later',
  'transport.audio.delayEarlier': 'Audio 50 ms earlier',
  'transport.audio.delayReset': 'Reset',
  'transport.audio.delayHint': 'Positive values play the audio later. Keys: j earlier, k later.',
  'transport.audio.none': 'This video has no audio track.',
  'transport.audio.mono': 'Mono',
  'transport.audio.stereo': 'Stereo',
  'transport.audio.channels': '{count} channels',
  'transport.audio.trackN': 'Track {n}',
};

const CSS = `
.transport-chapter{max-width:22ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dim);margin:0 4px}
.transport-chapter:empty{display:none}
.player-controls button.transport-on{color:var(--accent-ink);background:var(--accent)}
.player-controls button.transport-half{color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.transport-marks{position:absolute;inset:0;pointer-events:none}
.transport-marks span{position:absolute;top:3px;bottom:3px;transform:translateX(-50%)}
.transport-tick{width:3px;background:var(--text);opacity:.55;border-radius:2px;pointer-events:auto;cursor:pointer}
.transport-tick:hover{opacity:1}
.transport-loop-mark{width:2px;background:var(--accent)}
.transport-loop-mark::after{content:attr(data-label);position:absolute;top:-13px;left:50%;transform:translateX(-50%);font-size:9px;font-weight:600;color:var(--accent)}
.transport-loop-band{transform:none!important;background:var(--accent);opacity:.18;border-radius:3px}
.transport-list{list-style:none;display:grid;gap:4px}
.transport-list button{display:flex;justify-content:space-between;gap:10px;width:100%;text-align:left;padding:8px 10px;border-radius:9px;color:var(--text);font-size:13px}
.transport-list button:hover{background:rgba(255,255,255,.06)}
.transport-list button[aria-current="true"],.transport-list button[aria-pressed="true"]{background:rgba(255,255,255,.1);box-shadow:inset 3px 0 0 var(--accent)}
.transport-list small{color:var(--dim);font-variant-numeric:tabular-nums}
.transport-list .transport-sub{display:block;color:var(--dim);font-size:11px;margin-top:2px}
.transport-empty{color:var(--dim);font-size:12px}
.transport-section+.transport-section{margin-top:16px}
.transport-section h3{font-size:12px;font-weight:600;color:var(--dim);margin-bottom:8px}
.transport-delay{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.transport-delay output{min-width:8ch;font-variant-numeric:tabular-nums;font-size:13px}
.transport-delay button{padding:6px 10px;border-radius:8px;border:1px solid var(--line);color:var(--text);font-size:12px}
.transport-delay button:hover{background:rgba(255,255,255,.06)}
.transport-hint{color:var(--dim);font-size:11px;margin-top:8px;line-height:1.4}
dialog.transport-jump{margin:auto;width:min(360px,92vw);padding:18px;background:var(--surface-2);color:var(--text);border:1px solid var(--line);border-radius:var(--radius)}
dialog.transport-jump::backdrop{background:rgba(0,0,0,.55)}
.transport-jump h2{font-size:15px;font-weight:600;margin-bottom:12px}
.transport-jump label{display:block;font-size:12px;color:var(--dim);margin-bottom:6px}
.transport-jump input{width:100%;padding:9px 11px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit;font-variant-numeric:tabular-nums}
.transport-jump input[aria-invalid="true"]{border-color:var(--refused)}
.transport-jump .transport-hint{margin-top:6px}
.transport-jump .transport-error{color:var(--refused);font-size:12px;margin-top:8px}
.transport-jump .transport-error:empty{display:none}
.transport-jump .transport-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.transport-jump .transport-actions button{padding:8px 14px;border-radius:9px;border:1px solid var(--line);font-size:13px}
.transport-jump .transport-actions button[type="submit"]{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
`;

const CHAPTER_PANEL = 'transport.chapters';
const AUDIO_PANEL = 'transport.audio';

function inputError(message, reason) {
  return Object.assign(new TypeError(message), { code: 'ERR_COMMAND_INPUT', reason });
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key.startsWith('data-') || key.startsWith('aria-') || ['type', 'role', 'for', 'id', 'title', 'autocomplete', 'inputmode', 'spellcheck'].includes(key)) node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children);
  return node;
}

export function install(ctx) {
  const { Engine, store, registry, t, toast, formatTime } = ctx;
  const state = {
    loop: LOOP_OFF,
    chapters: [],
    chapterIndex: -1,
    audioDelayS: 0,
  };
  store.ui.transport = state;
  ctx.addStyle(CSS);

  const run = (name, input) => Promise.resolve(registry.run(name, input))
    .catch(error => ctx.surface('playback', error));
  const duration = () => {
    const value = Engine.state()?.media?.duration ?? store.media.duration;
    return Number.isFinite(value) ? value : 0;
  };
  const position = () => Engine.state()?.clock?.positionS ?? store.clock.positionS ?? 0;
  const fraction = seconds => {
    const d = duration();
    return d > 0 ? Math.max(0, Math.min(1, seconds / d)) : 0;
  };
  // The range thumb (about 16 px) insets the usable track, so markers follow the same inset.
  const markLeft = seconds => `calc(8px + (100% - 16px) * ${fraction(seconds).toFixed(5)})`;

  /* ------------------------------------------------------------- DOM -- */
  const chapterLabel = el('span', { class: 'transport-chapter', 'aria-live': 'off' });
  const frameBack = el('button', { type: 'button', 'data-command': 'frame.step', text: '|◂', 'aria-label': t('transport.frame.back'),
    title: `${t('transport.frame.back')} (,)`, onclick: () => run('frame.step', { direction: -1 }) });
  const frameForward = el('button', { type: 'button', 'data-command': 'frame.step', text: '▸|', 'aria-label': t('transport.frame.forward'),
    title: `${t('transport.frame.forward')} (.)`, onclick: () => run('frame.step', { direction: 1 }) });
  const loopButton = el('button', { type: 'button', 'data-command': 'loop.set', text: 'A-B', 'aria-label': t('transport.loop.button'),
    title: `${t('transport.loop.button')} (l)`, onclick: () => run('loop.set', { action: 'cycle' }) });
  const chapterButton = el('button', { type: 'button', 'data-command': 'chapter.list', text: '☰', hidden: true,
    'aria-label': t('transport.chapter.button'), 'aria-expanded': 'false',
    title: `${t('transport.chapter.button')} (PageUp, PageDown)`,
    onclick: () => run('chapter.list', { panel: ctx.panels.current() !== CHAPTER_PANEL }) });
  ctx.mounts.controlsLeft.append(chapterLabel, frameBack, frameForward, loopButton, chapterButton);

  const audioButton = el('button', { type: 'button', 'data-command': 'audio.read', text: '♪', hidden: true,
    'aria-label': t('transport.audio.button'), 'aria-expanded': 'false', title: `${t('transport.audio.button')} (v, j, k)`,
    onclick: () => run('audio.read', { panel: ctx.panels.current() !== AUDIO_PANEL }) });
  ctx.mounts.controlsRight.append(audioButton);

  const marks = el('div', { class: 'transport-marks' });
  ctx.mounts.seek.append(marks);

  const chapterBody = ctx.panels.register(CHAPTER_PANEL, t('transport.chapter.panel'));
  const audioBody = ctx.panels.register(AUDIO_PANEL, t('transport.audio.panel'));

  /* -------------------------------------------------------- jump box -- */
  const jumpError = el('p', { class: 'transport-error', id: 'transport-jump-error', role: 'alert' });
  const jumpInput = el('input', { id: 'transport-jump-input', type: 'text', autocomplete: 'off', inputmode: 'text',
    spellcheck: 'false', 'aria-describedby': 'transport-jump-hint transport-jump-error' });
  const jumpForm = el('form', { noValidate: true },
    el('h2', { id: 'transport-jump-title', text: t('transport.jump.title') }),
    el('label', { for: 'transport-jump-input', text: t('transport.jump.label') }),
    jumpInput,
    el('p', { class: 'transport-hint', id: 'transport-jump-hint', text: t('transport.jump.hint') }),
    jumpError,
    el('div', { class: 'transport-actions' },
      el('button', { type: 'button', text: t('transport.jump.cancel'), onclick: () => jumpDialog.close() }),
      el('button', { type: 'submit', 'data-command': 'playback.jumpTo', text: t('transport.jump.go') })));
  const jumpDialog = el('dialog', { class: 'transport-jump', 'aria-labelledby': 'transport-jump-title' }, jumpForm);
  ctx.mounts.dialogs.append(jumpDialog);
  let jumpReturnFocus = null;

  // Keys typed in the box belong to the box, never to the player shortcuts.
  jumpDialog.addEventListener('keydown', event => { if (event.key !== 'Escape') event.stopPropagation(); });
  jumpInput.addEventListener('input', () => { jumpError.textContent = ''; jumpInput.removeAttribute('aria-invalid'); });
  jumpForm.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await registry.run('playback.jumpTo', { time: jumpInput.value });
      jumpDialog.close();
    } catch (error) {
      jumpError.textContent = error.code === 'ERR_COMMAND_INPUT' ? error.message : t('transport.jump.format');
      jumpInput.setAttribute('aria-invalid', 'true');
      jumpInput.focus();
    }
  });
  jumpDialog.addEventListener('close', () => {
    const target = jumpReturnFocus;
    jumpReturnFocus = null;
    if (target && target.isConnected) target.focus({ preventScroll: true });
  });

  function openJumpBox() {
    if (jumpDialog.open) { jumpInput.focus(); return; }
    jumpReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    jumpInput.value = '';
    jumpInput.placeholder = formatTime(position());
    jumpError.textContent = '';
    jumpInput.removeAttribute('aria-invalid');
    jumpDialog.showModal();
    jumpInput.focus();
  }

  /* ------------------------------------------------------- rendering -- */
  function chapterTitle(index) {
    const chapter = state.chapters[index];
    return chapter?.title || t('transport.chapter.untitled', { n: index + 1 });
  }

  function renderMarks() {
    marks.replaceChildren();
    state.chapters.forEach((chapter, index) => {
      if (index === 0 && chapter.startS <= 0.001) return; // a tick at zero adds nothing
      const label = t('transport.chapter.item', { title: chapterTitle(index), time: formatTime(chapter.startS) });
      marks.append(el('span', { class: 'transport-tick', title: label, 'aria-hidden': 'true',
        'data-transport-tick': String(index), style: `left:${markLeft(chapter.startS)}`,
        'data-command': 'chapter.go', onclick: () => run('chapter.go', { index }) }));
    });
    const { phase, aS, bS } = state.loop;
    if (phase === 'ab') {
      const band = el('span', { class: 'transport-loop-band', 'aria-hidden': 'true' });
      band.style.left = markLeft(aS);
      band.style.width = `calc((100% - 16px) * ${(fraction(bS) - fraction(aS)).toFixed(5)})`;
      marks.append(band);
    }
    if (phase !== 'off') {
      marks.append(el('span', { class: 'transport-loop-mark', 'data-label': 'A', 'data-transport-loop': 'a',
        title: `${t('transport.loop.markA')} ${formatTime(aS)}`, 'aria-hidden': 'true', style: `left:${markLeft(aS)}` }));
    }
    if (phase === 'ab') {
      marks.append(el('span', { class: 'transport-loop-mark', 'data-label': 'B', 'data-transport-loop': 'b',
        title: `${t('transport.loop.markB')} ${formatTime(bS)}`, 'aria-hidden': 'true', style: `left:${markLeft(bS)}` }));
    }
  }

  function renderLoopButton() {
    const { phase, aS, bS } = state.loop;
    loopButton.classList.toggle('transport-half', phase === 'a');
    loopButton.classList.toggle('transport-on', phase === 'ab');
    loopButton.setAttribute('aria-pressed', phase === 'ab' ? 'true' : phase === 'a' ? 'mixed' : 'false');
    loopButton.setAttribute('aria-label', phase === 'a'
      ? t('transport.loop.buttonA', { time: formatTime(aS) })
      : phase === 'ab'
        ? t('transport.loop.buttonAB', { a: formatTime(aS), b: formatTime(bS) })
        : t('transport.loop.button'));
    loopButton.dataset.loopPhase = phase;
  }

  function renderChapterLabel() {
    const index = state.chapterIndex;
    chapterLabel.textContent = index >= 0 ? chapterTitle(index) : '';
    chapterLabel.title = index >= 0 ? t('transport.chapter.current', { title: chapterTitle(index) }) : '';
    for (const button of chapterBody.querySelectorAll('button[data-index]')) {
      button.setAttribute('aria-current', String(Number(button.dataset.index) === index));
    }
  }

  function renderChapterPanel() {
    chapterButton.hidden = state.chapters.length === 0;
    if (!state.chapters.length) {
      chapterBody.replaceChildren(el('p', { class: 'transport-empty', text: t('transport.chapter.none') }));
      return;
    }
    const list = el('ol', { class: 'transport-list' });
    state.chapters.forEach((chapter, index) => {
      list.append(el('li', {}, el('button', { type: 'button', 'data-command': 'chapter.go', 'data-index': String(index),
        'aria-current': String(index === state.chapterIndex),
        'aria-label': t('transport.chapter.item', { title: chapterTitle(index), time: formatTime(chapter.startS) }),
        onclick: () => run('chapter.go', { index }) },
      el('span', { text: chapterTitle(index) }), el('small', { text: formatTime(chapter.startS) }))));
    });
    chapterBody.replaceChildren(list);
  }

  function currentDelay() {
    const value = Engine.state()?.clock?.audioDelayS;
    return Number.isFinite(value) ? value : state.audioDelayS;
  }

  function audioTracks() {
    const selected = store.tracks.selected?.audio ?? 0;
    return store.tracks.audio.map((track, index) => ({
      index,
      ...describeAudioTrack(track, index, t),
      language: track.language ?? null,
      codec: track.codec ?? null,
      channels: Number.isFinite(track.channels) ? track.channels : null,
      selected: index === selected,
    }));
  }

  function renderAudioPanel() {
    const tracks = audioTracks();
    // One track has nothing to choose, but the panel also carries the delay control (A2),
    // so the button shows whenever the file has audio; the track list shows only for two or more.
    audioButton.hidden = tracks.length === 0;
    if (!tracks.length) {
      audioBody.replaceChildren(el('p', { class: 'transport-empty', text: t('transport.audio.none') }));
      return;
    }
    const sections = [];
    if (tracks.length > 1) {
      const list = el('ul', { class: 'transport-list' });
      for (const track of tracks) {
        list.append(el('li', {}, el('button', { type: 'button', 'data-command': 'audio.track', 'data-index': String(track.index),
          'aria-pressed': String(track.selected),
          onclick: () => run('audio.track', { index: track.index }) },
        el('span', {}, track.title, el('span', { class: 'transport-sub', text: track.detail })))));
      }
      sections.push(el('div', { class: 'transport-section' }, el('h3', { text: t('transport.audio.tracks') }), list));
    }
    const delay = currentDelay();
    sections.push(el('div', { class: 'transport-section' },
      el('h3', { id: 'transport-delay-heading', text: t('transport.audio.delay') }),
      el('div', { class: 'transport-delay', role: 'group', 'aria-labelledby': 'transport-delay-heading' },
        el('button', { type: 'button', 'data-command': 'audio.delay', text: '-50 ms', 'aria-label': t('transport.audio.delayEarlier'),
          onclick: () => run('audio.delay', { deltaS: -AUDIO_DELAY_STEP_S }) }),
        el('output', { 'data-transport-delay': '', 'aria-live': 'polite', text: formatDelay(delay) }),
        el('button', { type: 'button', 'data-command': 'audio.delay', text: '+50 ms', 'aria-label': t('transport.audio.delayLater'),
          onclick: () => run('audio.delay', { deltaS: AUDIO_DELAY_STEP_S }) }),
        el('button', { type: 'button', 'data-command': 'audio.delay', text: t('transport.audio.delayReset'), disabled: delay === 0,
          onclick: () => run('audio.delay', { reset: true }) })),
      el('p', { class: 'transport-hint', text: t('transport.audio.delayHint') })));
    const focusedIndex = audioBody.contains(document.activeElement) ? [...audioBody.querySelectorAll('button')].indexOf(document.activeElement) : -1;
    audioBody.replaceChildren(...sections);
    if (focusedIndex >= 0) audioBody.querySelectorAll('button')[focusedIndex]?.focus({ preventScroll: true });
  }

  function syncPanelButtons() {
    const open = ctx.panels.current();
    chapterButton.setAttribute('aria-expanded', String(open === CHAPTER_PANEL));
    audioButton.setAttribute('aria-expanded', String(open === AUDIO_PANEL));
  }

  function setPanel(id, show) {
    if (typeof show !== 'boolean') return;
    if (show) {
      ctx.panels.open(id);
      const body = id === CHAPTER_PANEL ? chapterBody : audioBody;
      const target = body.querySelector('button[aria-current="true"], button[aria-pressed="true"]') || body.querySelector('button');
      target?.focus({ preventScroll: true });
    } else if (ctx.panels.current() === id) {
      ctx.panels.close();
    }
  }

  /* --------------------------------------------------------- reading -- */
  function loopRead() {
    const engineLoop = Engine.state()?.clock?.loop ?? null;
    return { phase: state.loop.phase, aS: state.loop.aS, bS: state.loop.bS, engine: engineLoop };
  }

  function chapterRead() {
    return {
      chapters: state.chapters.map(({ startS, endS, title }) => ({ startS, endS, title })),
      currentIndex: chapterIndexAt(state.chapters, position()),
    };
  }

  function audioRead() {
    return { tracks: audioTracks(), selected: store.tracks.selected?.audio ?? 0, delayS: currentDelay() };
  }

  /* ------------------------------------------------------- handlers -- */
  registry.handle('frame.step', async ({ direction }) => {
    if (direction !== 1 && direction !== -1) throw inputError('frame.step takes direction 1 or -1.', 'direction');
    if (Engine.state()?.clock?.playing) {
      Engine.pause();
      return { stepped: false, paused: true, positionS: position() };
    }
    await Engine.stepFrame(direction);
    return { stepped: true, paused: true, positionS: position() };
  });

  function applyLoop(result) {
    const end = duration();
    if (result.effect === 'reject') {
      toast(t('transport.loop.reject'), 'err',
        state.loop.phase === 'a' ? t('transport.loop.rejectSub', { time: formatTime(state.loop.aS) }) : '');
      return { ...loopRead(), rejected: true };
    }
    const next = { ...result.state };
    if (end > 0) {
      if (Number.isFinite(next.aS)) next.aS = Math.min(next.aS, end);
      if (Number.isFinite(next.bS)) next.bS = Math.min(next.bS, end);
    }
    state.loop = next;
    if (result.effect === 'setB') {
      Engine.setLoop({ aS: next.aS, bS: next.bS });
      toast(t('transport.loop.setB', { a: formatTime(next.aS), b: formatTime(next.bS) }));
    } else {
      Engine.setLoop(null);
      toast(result.effect === 'setA' ? t('transport.loop.setA', { time: formatTime(next.aS) }) : t('transport.loop.cleared'));
    }
    renderLoopButton();
    renderMarks();
    return { ...loopRead(), rejected: false };
  }

  registry.handle('loop.set', ({ action = 'cycle', aS, bS }) => {
    const here = position();
    switch (action) {
      case 'cycle': return applyLoop(cycleLoop(state.loop, here));
      case 'a': return applyLoop({ state: { phase: 'a', aS: Number.isFinite(aS) ? aS : here, bS: null }, effect: 'setA' });
      case 'b': {
        if (state.loop.phase === 'off') return applyLoop({ state: state.loop, effect: 'reject' });
        return applyLoop(cycleLoop({ phase: 'a', aS: state.loop.aS, bS: null }, Number.isFinite(bS) ? bS : here));
      }
      case 'set': {
        if (!Number.isFinite(aS) || !Number.isFinite(bS)) throw inputError('loop.set with action "set" needs aS and bS.', 'points');
        return applyLoop(setLoopPoints(aS, bS));
      }
      case 'clear': return applyLoop({ state: LOOP_OFF, effect: 'clear' });
      default: throw inputError(`loop.set does not know action "${action}".`, 'action');
    }
  });
  registry.handle('loop.read', () => loopRead());

  async function goToChapter(index) {
    if (!Number.isInteger(index) || index < 0 || index >= state.chapters.length) {
      throw inputError(`chapter.go needs an index from 0 to ${state.chapters.length - 1}.`, 'index');
    }
    await Engine.seek(state.chapters[index].startS);
    state.chapterIndex = index;
    renderChapterLabel();
    return { ...chapterRead(), moved: true };
  }

  registry.handle('chapter.next', () => {
    const index = nextChapterIndex(state.chapters, position());
    return index < 0 ? { ...chapterRead(), moved: false } : goToChapter(index);
  });
  registry.handle('chapter.previous', () => {
    const index = previousChapterIndex(state.chapters, position());
    return index < 0 ? { ...chapterRead(), moved: false } : goToChapter(index);
  });
  registry.handle('chapter.go', ({ index }) => goToChapter(index));
  registry.handle('chapter.list', ({ panel }) => {
    setPanel(CHAPTER_PANEL, panel);
    return chapterRead();
  });

  registry.handle('playback.jumpTo', async ({ time }) => {
    if (time === undefined || time === null) {
      openJumpBox();
      return { dialog: true };
    }
    const end = duration();
    const parsed = typeof time === 'number'
      ? (Number.isFinite(time) && time >= 0 && (!end || time <= end) ? { ok: true, seconds: time } : { ok: false, reason: 'range' })
      : parseTime(time, end || Infinity);
    if (!parsed.ok) {
      const message = parsed.reason === 'range'
        ? t('transport.jump.range', { duration: formatTime(end) })
        : t(`transport.jump.${parsed.reason}`);
      throw inputError(message, parsed.reason);
    }
    await Engine.seek(Math.max(0, Math.min(end || parsed.seconds, parsed.seconds)));
    return { dialog: false, positionS: position() };
  });

  registry.handle('audio.track', async ({ index, delta }) => {
    const count = store.tracks.audio.length;
    if (!count) throw Object.assign(new Error(t('transport.audio.none')), { code: 'ERR_NO_AUDIO' });
    const selected = store.tracks.selected?.audio ?? 0;
    const target = Number.isInteger(index) ? index : nextTrackIndex(count, selected, Number.isInteger(delta) ? delta : 1);
    if (target < 0 || target >= count) throw inputError(`audio.track needs an index from 0 to ${count - 1}.`, 'index');
    if (target !== selected) {
      await Engine.selectAudioTrack(target);
      toast(t('transport.audio.switched', { title: describeAudioTrack(store.tracks.audio[target], target, t).title }));
    }
    renderAudioPanel();
    return audioRead();
  });

  registry.handle('audio.delay', ({ delayS, deltaS, reset }) => {
    const current = currentDelay();
    const requested = reset === true ? 0
      : Number.isFinite(delayS) ? delayS
        : current + (Number.isFinite(deltaS) ? deltaS : 0);
    const next = clampAudioDelay(requested);
    if (next !== current) {
      Engine.setAudioDelay(next);
      state.audioDelayS = next;
      toast(t('transport.audio.delayValue', { value: formatDelay(next) }));
    }
    renderAudioPanel();
    return audioRead();
  });
  registry.handle('audio.read', ({ panel }) => {
    setPanel(AUDIO_PANEL, panel);
    return audioRead();
  });

  /* --------------------------------------------------------- events -- */
  function resetForFile() {
    state.loop = LOOP_OFF;
    state.chapterIndex = -1;
    if (state.audioDelayS !== 0 || currentDelay() !== 0) {
      try { Engine.setAudioDelay(0); } catch (error) { console.warn('[transport] audio delay reset', error); }
    }
    state.audioDelayS = 0;
    if (Engine.state()?.clock?.loop) {
      try { Engine.setLoop(null); } catch (error) { console.warn('[transport] loop reset', error); }
    }
  }

  ctx.on('ui:media-loaded', ({ metadata } = {}) => {
    resetForFile();
    const source = typeof Engine.chapters === 'function' ? Engine.chapters() : metadata?.chapters;
    state.chapters = normaliseChapters(source, duration() || metadata?.duration);
    state.chapterIndex = chapterIndexAt(state.chapters, position());
    renderLoopButton();
    renderMarks();
    renderChapterPanel();
    renderChapterLabel();
    renderAudioPanel();
  });

  ctx.on('ui:media-cleared', () => {
    resetForFile();
    state.chapters = [];
    if ([CHAPTER_PANEL, AUDIO_PANEL].includes(ctx.panels.current())) ctx.panels.close();
    if (jumpDialog.open) jumpDialog.close();
    renderLoopButton();
    renderMarks();
    renderChapterPanel();
    renderChapterLabel();
    audioButton.hidden = true;
  });

  ctx.on('ui:panel', () => syncPanelButtons());
  ctx.on('playback:audio-track', () => renderAudioPanel());
  ctx.on('playback:audio-delay', () => {
    const value = Engine.state()?.clock?.audioDelayS;
    if (Number.isFinite(value)) state.audioDelayS = value;
    renderAudioPanel();
  });
  ctx.on('playback:loop', () => {
    // The engine may drop the loop on its own (a seek outside it, a new file): follow it.
    const engineLoop = Engine.state()?.clock?.loop ?? null;
    if (!engineLoop && state.loop.phase === 'ab') {
      state.loop = LOOP_OFF;
      renderLoopButton();
      renderMarks();
    }
  });
  ctx.on('playback:loaded', () => renderMarks());

  ctx.onFrame(frameState => {
    const index = chapterIndexAt(state.chapters, frameState?.clock?.positionS ?? 0);
    if (index !== state.chapterIndex) {
      state.chapterIndex = index;
      renderChapterLabel();
    }
  });

  renderLoopButton();
  renderChapterPanel();
  renderAudioPanel();
  audioButton.hidden = true;
}
