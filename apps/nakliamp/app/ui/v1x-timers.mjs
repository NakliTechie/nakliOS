// v1x-timers.mjs — stop after the current track and the sleep timer (P10).
//
// Acts through `player.stop_after_current` and `player.sleep_timer`; when a build has
// no handler for them it drives ctx.timers (createPlaybackTimers) directly. The
// remaining time is read from ctx.timers.status() and refreshed once a second while
// a minutes timer runs.

import { formatRemaining } from '../player/timers.mjs';
import { h, injectCss, nextId } from './dialog.mjs';
import { injectBaseCss, runOr, plainError } from './v1x-library-tools.mjs';

export const MINUTE_PRESETS = Object.freeze([15, 30, 45, 60, 90]);
export const SLEEP_CHOICES = Object.freeze([
  ['off', 'Off'],
  ['minutes', 'After a number of minutes'],
  ['end-of-track', 'At the end of this track'],
  ['end-of-queue', 'At the end of the queue'],
]);

// ---------------------------------------------------------------- pure ----

/** The `player.sleep_timer` input for a choice. Throws on minutes out of 1..1440. */
export function sleepInput(mode, minutes) {
  if (mode === 'off') return { mode: 'off' };
  if (mode === 'minutes') {
    const value = Number(minutes);
    if (!Number.isFinite(value) || value < 1 || value > 1440) throw new Error('Pick between 1 and 1440 minutes.');
    return { minutes: Math.round(value) };
  }
  return { mode };
}

/** Apply a sleep input to a timers object (the fallback when no command handler exists). */
export function applySleep(timers, input) {
  if (input.mode === 'off') { timers.cancelSleep(); return timers.status(); }
  return timers.setSleep(input);
}

/** Plain words for `timers.status()`. */
export function timerStatusText(status) {
  if (!status) return 'No timer is set.';
  const parts = [];
  if (status.stopAfterCurrent) parts.push('Playback stops when this track ends.');
  const sleep = status.sleep;
  if (sleep?.mode === 'minutes') parts.push(`Sleep in ${formatRemaining(sleep.remainingS)}; the sound fades over the last 10 seconds.`);
  else if (sleep?.mode === 'end-of-track') parts.push('Sleep at the end of this track.');
  else if (sleep?.mode === 'end-of-queue') parts.push('Sleep at the end of the queue.');
  return parts.length ? parts.join(' ') : 'No timer is set.';
}

/** The choice the controls show for a status. */
export function choiceFor(status) {
  return status?.sleep?.mode ?? 'off';
}

// ------------------------------------------------------------------ UI ----

const CSS = `
.nk-sleep .presets{display:flex;gap:6px;flex-wrap:wrap}
.nk-sleep .remaining{font:600 20px var(--mono,ui-monospace,monospace);color:var(--c-ink)}
.nk-sleep fieldset{border:0;margin:0;padding:0;display:grid;gap:6px}
`;

export function mountSleepTimer(root, ctx) {
  injectBaseCss();
  injectCss('v1x-timers', CSS);
  const id = nextId('sleep');
  const timers = ctx.timers ?? null;

  const stopAfter = h('input', { type: 'checkbox', id: `${id}-sac` });
  const radios = SLEEP_CHOICES.map(([value, text]) => {
    const input = h('input', { type: 'radio', name: `${id}-mode`, value, id: `${id}-m-${value}` });
    return { value, input, label: h('label', { className: 'switch', htmlFor: `${id}-m-${value}` }, input, text) };
  });
  const minutes = h('input', { type: 'number', id: `${id}-min`, min: 1, max: 1440, step: 1, value: 30, inputmode: 'numeric' });
  const presets = h('div', { className: 'presets', role: 'group', 'aria-label': 'Minute presets' },
    MINUTE_PRESETS.map(m => h('button', { type: 'button', className: 'btn', textContent: `${m} min`, 'aria-label': `Sleep in ${m} minutes`, onclick: () => { minutes.value = String(m); choose('minutes'); } })));
  const start = h('button', { type: 'button', className: 'btn primary', textContent: 'Start timer' });
  const remaining = h('p', { className: 'remaining', 'aria-hidden': 'true' });
  const status = h('p', { className: 'hint', role: 'status', 'aria-live': 'polite' });

  const container = h('div', { className: 'nk-v1x nk-sleep' },
    h('section', {}, h('h3', { textContent: 'Stop after this track' }),
      h('label', { className: 'switch', htmlFor: `${id}-sac` }, stopAfter, 'Stop when the playing track ends')),
    h('section', {},
      h('fieldset', {}, h('legend', { className: 'hint', textContent: 'Sleep timer' }), radios.map(r => r.label)),
      h('div', { className: 'row' }, h('div', { className: 'f' }, h('label', { htmlFor: `${id}-min`, textContent: 'Minutes' }), minutes)),
      presets, h('div', { className: 'row' }, start), remaining, status));
  root.append(container);

  const read = () => { try { return timers?.status?.() ?? null; } catch { return null; } };
  let ticker = 0;

  function render() {
    const s = read();
    stopAfter.checked = Boolean(s?.stopAfterCurrent);
    const mode = choiceFor(s);
    for (const r of radios) r.input.checked = r.value === mode;
    remaining.textContent = s?.sleep?.mode === 'minutes' ? formatRemaining(s.sleep.remainingS) : '';
    status.textContent = timers ? timerStatusText(s) : 'The sleep timer is not available in this build.';
    clearInterval(ticker);
    if (s?.sleep?.mode === 'minutes') ticker = setInterval(renderClock, 1000);
  }

  function renderClock() {
    const s = read();
    if (s?.sleep?.mode !== 'minutes') { render(); return; }
    remaining.textContent = formatRemaining(s.sleep.remainingS);
  }

  async function choose(mode) {
    let input;
    try { input = sleepInput(mode, minutes.value); } catch (error) { status.textContent = error.message; return; }
    try {
      await runOr(ctx, 'player.sleep_timer', input, () => applySleep(timers, input));
    } catch (error) { status.textContent = plainError(error); return; }
    render();
  }

  for (const r of radios) r.input.addEventListener('change', () => { if (r.input.checked && r.value !== 'minutes') choose(r.value); else if (r.input.checked) minutes.focus(); });
  start.addEventListener('click', () => choose('minutes'));
  minutes.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); choose('minutes'); } });
  stopAfter.addEventListener('change', async () => {
    const on = stopAfter.checked;
    try {
      await runOr(ctx, 'player.stop_after_current', { on }, () => timers.setStopAfterCurrent(on));
    } catch (error) { status.textContent = plainError(error); }
    render();
  });

  const off = timers?.onChange?.(() => render());
  render();
  return {
    update() { render(); },
    destroy() { clearInterval(ticker); if (typeof off === 'function') off(); container.remove(); },
  };
}
