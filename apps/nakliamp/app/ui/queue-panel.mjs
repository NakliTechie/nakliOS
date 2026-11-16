// queue-panel.mjs: the play queue panel (P5, P6, Y4, Y5).
//
// The queue list with the playing entry marked, drag to reorder (pointer events),
// Alt+Up and Alt+Down to move the focused entry from the keyboard, remove, clear,
// undo, shuffle and repeat, and save as playlist. Every edit goes through a
// `queue.*` command, so the agent face and the panel share one path.
//
// Pure helpers (`dropSlot`, `moveTarget`, `nextMode`, `queueRows`) are exported for
// tests; `mountQueuePanel` is the only DOM code.

import { virtualWindow, formatDuration } from './browse.mjs';
import { createSelection } from './select.mjs';

export const SHUFFLE_ORDER = Object.freeze(['off', 'tracks', 'albums']);
export const REPEAT_ORDER = Object.freeze(['off', 'all', 'one']);
const SHUFFLE_LABEL = Object.freeze({ off: 'Shuffle: off', tracks: 'Shuffle: tracks', albums: 'Shuffle: albums' });
const REPEAT_LABEL = Object.freeze({ off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: one' });

/** The mode after `mode` in `order`, wrapping. */
export function nextMode(order, mode) {
  const at = order.indexOf(mode);
  return order[(at + 1) % order.length];
}

/**
 * The insertion slot (0..count) for a pointer at content offset `y`: the gap
 * above the row the pointer is in when it is in the row's top half, else below.
 */
export function dropSlot({ y, rowHeight, count }) {
  if (count <= 0) return 0;
  const slot = Math.round(Math.max(0, y) / rowHeight);
  return Math.max(0, Math.min(count, slot));
}

/**
 * The `to` index for `queue.move` when the entry at `from` is dropped into
 * `slot`, or -1 when the drop leaves it where it is.
 */
export function moveTarget(from, slot) {
  const to = slot > from ? slot - 1 : slot;
  return to === from ? -1 : to;
}

/** Display rows for a queue snapshot. Missing tracks keep a row so positions stay true. */
export function queueRows(snapshot, getTrack) {
  const ids = snapshot?.ids ?? [];
  const keys = snapshot?.keys ?? ids.map((_, index) => index);
  return ids.map((id, index) => {
    let track = null;
    try { track = getTrack?.(id) ?? null; } catch { track = null; }
    return {
      key: String(keys[index]),
      id,
      index,
      current: index === snapshot.index,
      title: track ? (track.title ?? track.name ?? 'Untitled') : 'Missing track',
      subtitle: track ? [track.artist || track.albumArtist, track.album].filter(Boolean).join(' · ') : 'Not in the library any more',
      durationS: track?.durationS ?? null,
      missing: !track,
    };
  });
}

// ------------------------------------------------------------------- DOM ----

const CSS = `
.nq{display:flex;flex-direction:column;gap:10px;width:100%;max-width:1080px;margin:auto;min-width:0;color:var(--ink,var(--text))}
.nq-head{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.nq-head h2{margin:0 auto 0 0;font:600 18px var(--display,var(--body));letter-spacing:-.02em}
.nq button{font:inherit;color:inherit}
.nq-btn{min-height:34px;padding:5px 11px;border:1px solid var(--line);border-radius:9px;background:var(--panel-2);cursor:pointer;font:11px var(--mono)!important;white-space:nowrap}
.nq-btn:hover{border-color:var(--accent)}
.nq-btn[disabled]{opacity:.45;cursor:default}
.nq-btn[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}
.nq-save{display:flex;gap:6px;flex-wrap:wrap}
.nq-save[hidden]{display:none}
.nq-save input{flex:1 1 160px;min-width:0;min-height:36px;padding:6px 10px;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--ink,var(--text));font:12px var(--body)}
.nq-note{font-size:12px;color:var(--faint,var(--muted));margin:0}
.nq-scroll{position:relative;overflow-y:auto;overflow-x:hidden;height:var(--nakliamp-queue-height,max(300px,calc(100dvh - 300px)));border:1px solid var(--line);border-radius:var(--radius,14px);background:var(--panel);outline:none}
.nq-scroll:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.nq-spacer{position:relative;width:100%}
.nq-window{position:absolute;left:0;right:0;top:0}
.nq-row{display:flex;align-items:center;gap:8px;height:48px;padding:0 8px;border-bottom:1px solid var(--line);user-select:none;min-width:0}
.nq-row:hover{background:var(--panel-2)}
.nq-row[aria-selected=true]{background:color-mix(in srgb,var(--accent) 16%,transparent)}
.nq-row.cursor{box-shadow:inset 3px 0 0 var(--accent)}
.nq-row.current .nq-title{color:var(--accent)}
.nq-row.missing .nq-title{color:var(--muted);font-style:italic}
.nq-row.dragging{opacity:.4}
.nq-handle{width:22px;height:32px;flex:none;border:0;background:none;cursor:grab;color:var(--faint,var(--muted));touch-action:none;font-size:14px}
.nq-handle:active{cursor:grabbing}
.nq-pos{width:30px;flex:none;text-align:right;font:11px var(--mono);color:var(--faint,var(--muted))}
.nq-who{flex:1;min-width:0}
.nq-title{display:block;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nq-sub{display:block;font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nq-dur{font:11px var(--mono);color:var(--faint,var(--muted));flex:none}
.nq-x{width:26px;height:26px;flex:none;border:1px solid var(--line);border-radius:7px;background:var(--panel);cursor:pointer;color:var(--muted);padding:0}
.nq-x:hover{border-color:var(--accent);color:var(--accent)}
.nq-drop{position:absolute;left:6px;right:6px;height:2px;margin-top:-1px;background:var(--accent);pointer-events:none;border-radius:2px}
.nq-drop[hidden]{display:none}
.nq-empty{padding:28px 16px;text-align:center;color:var(--muted)}
@media(max-width:520px){.nq-dur,.nq-pos{display:none}}
`;

let instance = 0;

const isAbsent = value => value === null || value === undefined || value === false;

function setAttr(node, name, value) {
  if (name === 'class') node.className = value;
  else if (name === 'text') node.textContent = value;
  else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
  else node.setAttribute(name, value === true ? '' : String(value));
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (!isAbsent(value)) setAttr(node, name, value);
  }
  for (const child of children.flat()) if (!isAbsent(child)) node.append(child);
  return node;
}

const NAV_KEYS = ['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
const isModKey = event => event.metaKey || event.ctrlKey;
const stopKey = event => { event.preventDefault(); event.stopPropagation(); };

function navTargetFor(key, cursor, count, page) {
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const delta = { ArrowUp: -1, ArrowDown: 1, PageUp: -page, PageDown: page }[key];
  if (cursor < 0) return delta > 0 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, cursor + delta));
}

function injectCss(id, css) {
  if (typeof document === 'undefined' || document.getElementById(id)) return;
  document.head.append(el('style', { id, text: css }));
}

const errorText = error => String(error?.message ?? error ?? 'Something went wrong.');

/**
 * Mount the queue panel.
 * Returns `{ update(), destroy(), selectedIndices(), focusList() }`.
 */
export function mountQueuePanel(root, ctx) {
  injectCss('nakliamp-css-queue-panel', CSS);
  const uid = `nq${++instance}`;
  const ROW_HEIGHT = 48;
  const selection = createSelection();
  let snapshot = { ids: [], keys: [], index: -1, current: null, length: 0, shuffle: 'off', repeat: 'off', canUndo: false };
  let rows = [];
  let frame = 0;
  let drag = null;
  const cleanups = [];

  const shuffleButton = el('button', { type: 'button', class: 'nq-btn' });
  const repeatButton = el('button', { type: 'button', class: 'nq-btn' });
  const undoButton = el('button', { type: 'button', class: 'nq-btn', 'aria-label': 'Undo the last queue edit' }, 'Undo');
  const removeButton = el('button', { type: 'button', class: 'nq-btn' }, 'Remove selected');
  const clearButton = el('button', { type: 'button', class: 'nq-btn' }, 'Clear');
  const saveToggle = el('button', { type: 'button', class: 'nq-btn', 'aria-expanded': 'false', 'aria-controls': `${uid}-save` }, 'Save as playlist');
  const nameInput = el('input', { type: 'text', 'aria-label': 'Playlist name', placeholder: 'Playlist name', maxlength: '120', required: true });
  const saveForm = el('form', { class: 'nq-save', id: `${uid}-save`, hidden: true },
    nameInput,
    el('button', { type: 'submit', class: 'nq-btn' }, 'Save'),
    el('button', { type: 'button', class: 'nq-btn', 'data-cancel': '1' }, 'Cancel'));
  const note = el('p', { class: 'nq-note', 'aria-live': 'polite' });
  const head = el('div', { class: 'nq-head', role: 'toolbar', 'aria-label': 'Queue actions' },
    el('h2', { id: `${uid}-title`, text: 'Queue' }), shuffleButton, repeatButton, undoButton, removeButton, clearButton, saveToggle);
  const windowEl = el('div', { class: 'nq-window', role: 'presentation' });
  const dropLine = el('div', { class: 'nq-drop', hidden: true, role: 'presentation' });
  const spacer = el('div', { class: 'nq-spacer', role: 'presentation' }, windowEl, dropLine);
  const scroller = el('div', {
    class: 'nq-scroll', tabindex: '0', role: 'listbox', 'aria-multiselectable': 'true', 'aria-labelledby': `${uid}-title`,
  }, spacer);
  root.replaceChildren(el('section', { class: 'nq', 'aria-label': 'Play queue' }, head, saveForm, note, scroller));

  function read() {
    try { snapshot = ctx.queue?.snapshot?.() ?? snapshot; } catch { /* keep the last snapshot */ }
    rows = queueRows(snapshot, id => ctx.library?.getTrack?.(id));
    selection.setOrder(rows.map(row => row.key));
    paintChrome();
    render();
  }

  function paintChrome() {
    shuffleButton.textContent = SHUFFLE_LABEL[snapshot.shuffle] ?? 'Shuffle';
    shuffleButton.setAttribute('aria-pressed', String(snapshot.shuffle !== 'off'));
    shuffleButton.setAttribute('aria-label', `${SHUFFLE_LABEL[snapshot.shuffle]}. Press for ${nextMode(SHUFFLE_ORDER, snapshot.shuffle)}.`);
    repeatButton.textContent = REPEAT_LABEL[snapshot.repeat] ?? 'Repeat';
    repeatButton.setAttribute('aria-pressed', String(snapshot.repeat !== 'off'));
    repeatButton.setAttribute('aria-label', `${REPEAT_LABEL[snapshot.repeat]}. Press for ${nextMode(REPEAT_ORDER, snapshot.repeat)}.`);
    undoButton.disabled = !snapshot.canUndo;
    clearButton.disabled = !rows.length;
    saveToggle.disabled = !rows.length;
    removeButton.disabled = !selection.size;
    const total = rows.reduce((sum, row) => sum + (Number.isFinite(row.durationS) ? row.durationS : 0), 0);
    note.textContent = rows.length
      ? `${rows.length.toLocaleString()} track${rows.length === 1 ? '' : 's'}, ${formatDuration(total)}${snapshot.index >= 0 ? `; playing number ${snapshot.index + 1}` : ''}${selection.size ? `; ${selection.size} selected` : ''}`
      : '';
  }

  function rowNode(row) {
    const classes = ['nq-row'];
    if (row.current) classes.push('current');
    if (row.missing) classes.push('missing');
    if (row.index === selection.cursor) classes.push('cursor');
    if (drag && drag.from === row.index) classes.push('dragging');
    return el('div', {
      class: classes.join(' '), role: 'option', id: `${uid}-r${row.index}`, 'data-index': String(row.index),
      'aria-selected': String(selection.isSelected(row.index)), 'aria-current': row.current ? 'true' : null,
      'aria-posinset': String(row.index + 1), 'aria-setsize': String(rows.length),
      'aria-label': `${row.current ? 'Playing: ' : ''}${row.title}${row.subtitle ? `, ${row.subtitle}` : ''}`,
    },
    el('button', { type: 'button', tabindex: '-1', class: 'nq-handle', 'data-handle': '1', 'aria-label': `Drag to move ${row.title}. Alt and arrow keys also move it.` }, '☰'),
    el('span', { class: 'nq-pos', 'aria-hidden': 'true', text: row.current ? '▶' : String(row.index + 1) }),
    el('span', { class: 'nq-who' }, el('span', { class: 'nq-title', text: row.title }), el('span', { class: 'nq-sub', text: row.subtitle })),
    el('span', { class: 'nq-dur', text: formatDuration(row.durationS) }),
    el('button', { type: 'button', tabindex: '-1', class: 'nq-x', 'data-remove': '1', 'aria-label': `Remove ${row.title} from the queue` }, '×'));
  }

  function render() {
    frame = 0;
    if (!rows.length) {
      spacer.style.height = 'auto';
      windowEl.style.position = 'static';
      windowEl.style.transform = '';
      windowEl.replaceChildren(el('div', { class: 'nq-empty', text: 'The queue is empty. Play something from the library, or add tracks with Add to queue.' }));
      scroller.removeAttribute('aria-activedescendant');
      return;
    }
    windowEl.style.position = '';
    const span = virtualWindow({ scrollTop: scroller.scrollTop, viewportHeight: scroller.clientHeight || 500, rowHeight: ROW_HEIGHT, count: rows.length });
    spacer.style.height = `${span.total}px`;
    windowEl.style.transform = `translateY(${span.offset}px)`;
    windowEl.replaceChildren(...rows.slice(span.start, span.end).map(rowNode));
    const cursor = selection.cursor;
    if (cursor >= span.start && cursor < span.end) scroller.setAttribute('aria-activedescendant', `${uid}-r${cursor}`);
    else scroller.removeAttribute('aria-activedescendant');
  }

  const scheduleRender = () => { if (!frame) frame = requestAnimationFrame(render); };

  function reveal(index) {
    const top = index * ROW_HEIGHT;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + ROW_HEIGHT - scroller.clientHeight;
  }

  async function act(name, input, done) {
    try {
      const result = await ctx.run(name, input);
      if (done) ctx.toast?.(done);
      return result;
    } catch (error) {
      ctx.toast?.(errorText(error));
      return undefined;
    } finally {
      read();
    }
  }

  async function move(from, to) {
    if (to < 0 || to >= rows.length || from === to) return;
    const key = rows[from].key;
    await act('queue.move', { from, to });
    const at = rows.findIndex(row => row.key === key);
    if (at >= 0) { selection.moveTo(at); reveal(at); render(); }
  }

  function removeIndices(indices) {
    if (!indices.length) return;
    act('queue.remove', { indices }, indices.length === 1 ? 'Removed 1 track. Undo brings it back.' : `Removed ${indices.length} tracks. Undo brings them back.`);
  }

  async function playAt(index) {
    try {
      ctx.queue.jump(index);
      await ctx.run('player.play', {});
    } catch (error) {
      ctx.toast?.(errorText(error));
    }
    read();
  }

  // ---- toolbar ----
  shuffleButton.addEventListener('click', () => act('queue.shuffle', { mode: nextMode(SHUFFLE_ORDER, snapshot.shuffle) }));
  repeatButton.addEventListener('click', () => act('queue.repeat', { mode: nextMode(REPEAT_ORDER, snapshot.repeat) }));
  undoButton.addEventListener('click', () => act('queue.undo', {}));
  clearButton.addEventListener('click', () => act('queue.clear', {}, 'Queue cleared. Undo brings it back.'));
  removeButton.addEventListener('click', () => removeIndices(selection.selectedIndices()));
  saveToggle.addEventListener('click', () => {
    saveForm.hidden = !saveForm.hidden;
    saveToggle.setAttribute('aria-expanded', String(!saveForm.hidden));
    if (!saveForm.hidden) nameInput.focus();
  });
  saveForm.addEventListener('click', event => {
    if (!event.target.closest('[data-cancel]')) return;
    saveForm.hidden = true;
    saveToggle.setAttribute('aria-expanded', 'false');
    saveToggle.focus();
  });
  saveForm.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      saveForm.hidden = true;
      saveToggle.setAttribute('aria-expanded', 'false');
      saveToggle.focus();
    }
  });
  saveForm.addEventListener('submit', async event => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    const result = await act('queue.save_playlist', { name }, `Saved the queue as ${name}`);
    if (result !== undefined) {
      nameInput.value = '';
      saveForm.hidden = true;
      saveToggle.setAttribute('aria-expanded', 'false');
    }
  });

  // ---- list: click, double-click, keyboard ----
  scroller.addEventListener('scroll', scheduleRender, { passive: true });
  scroller.addEventListener('click', event => {
    const node = event.target.closest('[data-index]');
    if (!node) return;
    const index = Number(node.dataset.index);
    if (event.target.closest('[data-remove]')) { removeIndices([index]); return; }
    if (event.target.closest('[data-handle]')) return;
    selection.click(index, { range: event.shiftKey, toggle: event.metaKey || event.ctrlKey });
    scroller.focus({ preventScroll: true });
    paintChrome();
    render();
  });
  scroller.addEventListener('dblclick', event => {
    const node = event.target.closest('[data-index]');
    if (node && !event.target.closest('button')) playAt(Number(node.dataset.index));
  });
  function repaint() {
    paintChrome();
    render();
  }

  function onMoveKey(event, cursor) {
    stopKey(event);
    if (cursor >= 0) move(cursor, cursor + (event.key === 'ArrowUp' ? -1 : 1));
  }

  function onNavKey(event, cursor, count) {
    if (!count) return;
    stopKey(event);
    const page = Math.max(1, Math.floor((scroller.clientHeight || 480) / ROW_HEIGHT) - 1);
    const target = navTargetFor(event.key, cursor, count, page);
    if (isModKey(event) && !event.shiftKey) selection.focus(target);
    else selection.moveTo(target, { extend: event.shiftKey });
    reveal(target);
    repaint();
  }

  function onSpaceKey(event, cursor, count) {
    stopKey(event);
    if (cursor < 0 && count) selection.focus(0);
    selection.toggleCursor();
    repaint();
  }

  function onEnterKey(event, cursor) {
    stopKey(event);
    if (cursor >= 0) playAt(cursor);
  }

  function onDeleteKey(event, cursor) {
    stopKey(event);
    const fallback = cursor >= 0 ? [cursor] : [];
    removeIndices(selection.size ? selection.selectedIndices() : fallback);
  }

  function onSelectAllKey(event) {
    if (!isModKey(event)) return;
    stopKey(event);
    selection.selectAll();
    repaint();
  }

  function onEscapeKey(event) {
    if (!selection.size) return;
    stopKey(event);
    selection.clear();
    repaint();
  }

  const KEY_HANDLERS = new Map([
    [' ', onSpaceKey], ['Enter', onEnterKey], ['Delete', onDeleteKey], ['Backspace', onDeleteKey],
    ['a', onSelectAllKey], ['A', onSelectAllKey], ['Escape', onEscapeKey],
  ]);

  function keyHandlerFor(event) {
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) return onMoveKey;
    if (NAV_KEYS.includes(event.key)) return onNavKey;
    return KEY_HANDLERS.get(event.key) ?? null;
  }

  scroller.addEventListener('keydown', event => {
    const handler = keyHandlerFor(event);
    if (handler) handler(event, selection.cursor, rows.length);
  });

  // ---- drag to reorder (pointer events, so mouse, pen and touch share one path) ----
  function contentY(clientY) {
    return clientY - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }

  function autoScroll(clientY) {
    const box = scroller.getBoundingClientRect();
    const edge = 36;
    if (clientY < box.top + edge) scroller.scrollTop -= 12;
    else if (clientY > box.bottom - edge) scroller.scrollTop += 12;
  }

  scroller.addEventListener('pointerdown', event => {
    const handle = event.target.closest('[data-handle]');
    if (!handle || event.button !== 0) return;
    const index = Number(handle.closest('[data-index]').dataset.index);
    event.preventDefault();
    handle.setPointerCapture?.(event.pointerId);
    drag = { from: index, slot: index, pointerId: event.pointerId, handle };
    selection.moveTo(index);
    paintChrome();
    render();
  });
  scroller.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    autoScroll(event.clientY);
    drag.slot = dropSlot({ y: contentY(event.clientY), rowHeight: ROW_HEIGHT, count: rows.length });
    dropLine.hidden = moveTarget(drag.from, drag.slot) < 0;
    dropLine.style.top = `${drag.slot * ROW_HEIGHT}px`;
  });
  const endDrag = event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { from, slot } = drag;
    drag = null;
    dropLine.hidden = true;
    const to = event.type === 'pointerup' ? moveTarget(from, slot) : -1;
    if (to >= 0) move(from, to); else render();
  };
  scroller.addEventListener('pointerup', endDrag);
  scroller.addEventListener('pointercancel', endDrag);

  const offQueue = ctx.queue?.onChange?.(() => read());
  if (typeof offQueue === 'function') cleanups.push(offQueue);
  const offLibrary = ctx.library?.onChange?.(() => read());
  if (typeof offLibrary === 'function') cleanups.push(offLibrary);
  read();

  return {
    update() { read(); },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      for (const fn of cleanups) { try { fn(); } catch { /* already gone */ } }
      root.replaceChildren();
    },
    /** Queue positions the person selected, for keys like Delete that act on "the selection". */
    selectedIndices: () => selection.selectedIndices(),
    focusList() { scroller.focus(); },
  };
}
