// v1x-command-bar.mjs — one command from a sentence (Q4).
//
// interpret() turns the text into a plan: exact phrases by rules, anything else by the
// NakliOS model when one is offered (ctx.host.aiReady()), with the rules as the
// fallback. Destructive commands are never on the menu. executePlan() runs the plan
// through ctx.run. The panel then says what ran, which path answered, and offers Undo
// when the command can be reversed (queue changes through queue.undo; shuffle, repeat,
// volume, mute and play or pause by restoring the state from before).

import { interpret, executePlan, MAX_TEXT } from '../ai/command-bar.mjs';
import { commandByName } from '../commands/commands.mjs';
import { h, injectCss, nextId } from './dialog.mjs';
import { injectBaseCss, plainError } from './v1x-library-tools.mjs';
import { chatOf } from './v1x-ai-tools.mjs';

// ---------------------------------------------------------------- pure ----

export const PATH_WORDS = Object.freeze({
  rules: 'Answered by the built-in phrases.',
  model: 'Answered by the NakliOS model.',
  'model-failed-then-rules': 'The NakliOS model did not answer, so the built-in phrases did.',
});

export function pathText(path, error) {
  const base = PATH_WORDS[path] ?? '';
  return path === 'model-failed-then-rules' && error ? `${base} (${String(error).replace(/\.$/, '')})` : base;
}

const QUEUE_UNDOABLE = new Set(['queue.set', 'queue.add', 'queue.play_next', 'queue.move', 'queue.remove', 'queue.clear']);

/** State captured before a run, enough to reverse it: `{ shuffle, repeat, volume, muted, playing }`. */
export function captureBefore(ctx) {
  const shell = safe(() => ctx.state?.()) ?? {};
  const snap = shell.queue ?? safe(() => ctx.queue?.snapshot?.()) ?? {};
  const clock = safe(() => ctx.engine?.state?.()?.clock) ?? {};
  return {
    shuffle: snap.shuffle ?? null,
    repeat: snap.repeat ?? null,
    volume: Number.isFinite(clock.volume) ? clock.volume : null,
    muted: typeof clock.muted === 'boolean' ? clock.muted : null,
    playing: typeof shell.playing === 'boolean' ? shell.playing : (typeof clock.playing === 'boolean' ? clock.playing : null),
  };
}

function safe(fn) { try { return fn(); } catch { return null; } }

const RESTORE = {
  'queue.shuffle': before => (before.shuffle ? { name: 'queue.shuffle', input: { mode: before.shuffle } } : null),
  'queue.repeat': before => (before.repeat ? { name: 'queue.repeat', input: { mode: before.repeat } } : null),
  'player.volume': before => (before.volume !== null ? { name: 'player.volume', input: { level: before.volume } } : null),
  'player.mute': before => (before.muted !== null ? { name: 'player.mute', input: { muted: before.muted } } : null),
};
const PLAY_STATE = new Set(['player.play', 'player.pause', 'player.toggle']);

/**
 * The command that reverses the last step of a plan, or null. A search plan
 * (`followUp: 'queue.set'`) replaced the queue, so queue.undo reverses it.
 */
export function undoFor(plan, before) {
  if (!plan?.steps?.length) return null;
  if (plan.followUp === 'queue.set') return { name: 'queue.undo', input: {} };
  const step = plan.steps[plan.steps.length - 1];
  if (QUEUE_UNDOABLE.has(step.name)) return { name: 'queue.undo', input: {} };
  if (RESTORE[step.name]) return RESTORE[step.name](before ?? {});
  if (PLAY_STATE.has(step.name) && typeof before?.playing === 'boolean') {
    return { name: before.playing ? 'player.play' : 'player.pause', input: {} };
  }
  return null;
}

/** "Shuffle (queue.shuffle) with mode tracks". */
export function describeStep(step) {
  const label = commandByName.get(step.name)?.label ?? step.name;
  const args = Object.entries(step.input ?? {}).map(([k, v]) => `${k} ${Array.isArray(v) ? `${v.length} items` : JSON.stringify(v).replace(/^"|"$/g, '')}`);
  return `${label} (${step.name})${args.length ? ` with ${args.join(', ')}` : ''}`;
}

/** One line about a read command's result, or ''. */
export function resultText(result) {
  if (!result || typeof result !== 'object') return '';
  if (result.track && typeof result.track === 'object') {
    const t = result.track;
    return `${result.playing ? 'Playing' : 'Paused'}: ${t.title ?? 'Untitled'}${t.artist ? ` by ${t.artist}` : ''}.`;
  }
  const list = result.tracks ?? result.items ?? result.ids;
  if (Array.isArray(list)) return `${Number.isFinite(result.total) ? result.total : list.length} tracks.`;
  return '';
}

// ------------------------------------------------------------------ UI ----

const CSS = `
.nk-cmdbar form{display:flex;gap:8px;flex-wrap:wrap;align-items:end}
.nk-cmdbar form .f{flex:1 1 200px}
.nk-cmdbar .ran{font-weight:650}
.nk-cmdbar .path{font-size:11px;color:var(--muted)}
`;

export function mountCommandBar(root, ctx) {
  injectBaseCss();
  injectCss('v1x-command-bar', CSS);
  const id = nextId('cmdbar');
  const input = h('input', { type: 'text', id: `${id}-text`, maxlength: MAX_TEXT, autocomplete: 'off', placeholder: 'For example: shuffle by albums, play jazz, volume 40' });
  const go = h('button', { type: 'submit', className: 'btn primary', textContent: 'Run' });
  const form = h('form', { role: 'search', 'aria-label': 'Command bar' },
    h('div', { className: 'f' }, h('label', { htmlFor: `${id}-text`, textContent: 'What should NakliAmp do?' }), input), go);
  const ran = h('p', { className: 'ran' });
  const detail = h('p', { className: 'hint' });
  const path = h('p', { className: 'path' });
  const undo = h('button', { type: 'button', className: 'btn', textContent: 'Undo', hidden: true });
  const live = h('div', { role: 'status', 'aria-live': 'polite' }, ran, detail, path, h('div', { className: 'row' }, undo));
  const container = h('div', { className: 'nk-v1x nk-cmdbar' },
    h('section', {}, form, h('p', { className: 'hint', textContent: 'Runs one command that does not change files. Tag edits, deletions and renames keep their own buttons, which show the change first.' }), live));
  root.append(container);

  let pendingUndo = null;
  let controller = null;

  function show({ ranText = '', detailText = '', pathLine = '', error = false }) {
    ran.textContent = ranText;
    ran.classList.toggle('err', error);
    detail.textContent = detailText;
    path.textContent = pathLine;
    undo.hidden = !pendingUndo;
  }

  async function submit(event) {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) { show({ ranText: 'Type what to do, for example "next" or "play jazz".', error: true }); return; }
    controller?.abort();
    controller = new AbortController();
    go.disabled = true;
    pendingUndo = null;
    show({ ranText: 'Working…' });
    const chat = chatOf(ctx);
    try {
      const { plan, path: answeredBy, error } = await interpret({ text, chat, signal: controller.signal });
      const before = captureBefore(ctx);
      const result = await executePlan(plan, ctx.run);
      pendingUndo = undoFor(plan, before);
      const steps = plan.steps.map(describeStep);
      if (plan.followUp === 'queue.set') steps.push('then replaced the queue with what it found');
      show({ ranText: `Ran: ${steps.join(', ')}.`, detailText: resultText(result), pathLine: pathText(answeredBy, error) });
    } catch (error) {
      if (error?.name !== 'AbortError') show({ ranText: plainError(error), error: true });
    } finally { go.disabled = false; }
  }

  undo.addEventListener('click', async () => {
    const step = pendingUndo;
    pendingUndo = null;
    if (!step) return;
    try {
      await ctx.run(step.name, step.input);
      show({ ranText: `Undone with ${describeStep(step)}.` });
    } catch (error) { show({ ranText: plainError(error), error: true }); }
  });
  form.addEventListener('submit', submit);
  // Keys typed here belong to the field, not to the page's single-letter shortcuts.
  input.addEventListener('keydown', event => { if (event.key !== 'Escape') event.stopPropagation(); });

  return {
    update(state) { if (state?.text) input.value = String(state.text).slice(0, MAX_TEXT); if (state?.focus !== false) queueMicrotask(() => input.focus()); },
    destroy() { controller?.abort(); container.remove(); },
  };
}
