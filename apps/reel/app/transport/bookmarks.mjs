/* Reel transport, batch 2: bookmarks (L5). Installed from ./index.mjs.
 * Stored per content fingerprint with ctx.Storage under "bookmarks:<fingerprint>", so a renamed or
 * moved file keeps its bookmarks. With no fingerprint they live in memory for this file only. */

import { keysWithPrefix, deleteKeys } from '../library/forget.mjs';
import { BOOKMARK_PREFIX } from '../library/logic.mjs';
import {
  normaliseBookmarks, addBookmark, renameBookmark, removeBookmark, findBookmark, BOOKMARK_NAME_MAX,
} from './logic.mjs';

const target = {
  id: { type: 'string', description: 'Bookmark id from bookmark.list' },
  index: { type: 'integer', minimum: 0, description: 'Zero-based position in bookmark.list' },
};

export const BOOKMARK_COMMANDS = [
  { name: 'bookmark.add', label: 'Add bookmark', scope: 'write', readTwin: 'bookmark.list',
    description: 'Add a bookmark at timeS (default: the current position) with an optional name; with an id, rename that bookmark instead.',
    input: { type: 'object', properties: {
      timeS: { type: 'number', minimum: 0 },
      name: { type: 'string', maxLength: BOOKMARK_NAME_MAX },
      id: { type: 'string', description: 'Rename this existing bookmark' } }, required: [] },
    shortcuts: [{ key: 'b' }] },
  { name: 'bookmark.list', label: 'Bookmarks', scope: 'read', input: { type: 'object', properties: {}, required: [] },
    description: 'List this file\'s bookmarks (id, timeS, name) sorted by time, whether they are stored, how many files have stored bookmarks, and whether the bookmarks panel is open.' },
  { name: 'bookmark.panel', label: 'Bookmarks panel', scope: 'write', readTwin: 'bookmark.list',
    description: 'Open or close the bookmarks panel; with no input it toggles.',
    input: { type: 'object', properties: { open: { type: 'boolean', description: 'true opens the panel, false closes it' } }, required: [] } },
  { name: 'bookmark.go', label: 'Go to bookmark', scope: 'write', readTwin: 'bookmark.list',
    description: 'Seek to a bookmark, chosen by id or by index.',
    input: { type: 'object', properties: target, required: [] } },
  { name: 'bookmark.remove', label: 'Remove bookmark', scope: 'destructive', readTwin: 'bookmark.list',
    description: 'Delete a stored bookmark, chosen by id or by index. It cannot be undone.',
    input: { type: 'object', properties: target, required: [] } },
  { name: 'bookmark.clear-all', label: 'Clear all bookmarks', scope: 'destructive', readTwin: 'bookmark.list',
    description: 'Delete the stored bookmarks of every file in this browser. It cannot be undone. Returns how many files had bookmarks.',
    input: { type: 'object', properties: {}, required: [] } },
];

export const BOOKMARK_STRINGS = {
  'transport.bookmark.button': 'Bookmarks',
  'transport.bookmark.panel': 'Bookmarks',
  'transport.bookmark.addHere': 'Add bookmark here',
  'transport.bookmark.added': 'Bookmark added at {time}',
  'transport.bookmark.removed': 'Bookmark removed',
  'transport.bookmark.cleared': 'Deleted the bookmarks of {count} files',
  'transport.bookmark.renamed': 'Bookmark renamed',
  'transport.bookmark.unnamed': 'Bookmark at {time}',
  'transport.bookmark.item': '{name}, at {time}',
  'transport.bookmark.rename': 'Rename',
  'transport.bookmark.renameLabel': 'Rename {name}',
  'transport.bookmark.remove': 'Remove',
  'transport.bookmark.removeLabel': 'Remove {name}',
  'transport.bookmark.save': 'Save',
  'transport.bookmark.cancel': 'Cancel',
  'transport.bookmark.nameLabel': 'Bookmark name',
  'transport.bookmark.none': 'No bookmarks yet. Press b to add one at the current position.',
  'transport.bookmark.memoryOnly': 'This file has no fingerprint, so its bookmarks last until you close it.',
  'transport.bookmark.saveFailed': 'Could not save bookmarks',
  'transport.bookmark.notFound': 'No bookmark with that id or index.',
};

export const BOOKMARK_CSS = `
.transport-bookmarks{position:absolute;inset:0;pointer-events:none}
.transport-bookmark-tick{position:absolute;top:2px;width:7px;height:7px;transform:translate(-50%,0) rotate(45deg);background:var(--hw);border-radius:1px;pointer-events:auto;cursor:pointer;opacity:.85}
.transport-bookmark-tick:hover{opacity:1}
.transport-bookmark-row{display:flex;align-items:center;gap:4px}
.transport-bookmark-row>button:first-child{flex:1}
.transport-bookmark-row .transport-mini{padding:6px 8px;border-radius:8px;border:1px solid var(--line);font-size:11px;color:var(--text)}
.transport-bookmark-row .transport-mini:hover{background:rgba(255,255,255,.06)}
.transport-bookmark-row form{display:flex;gap:4px;flex:1}
.transport-bookmark-row input{flex:1;min-width:0;padding:6px 8px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit;font-size:13px}
.transport-bookmark-add{width:100%;padding:8px 10px;margin-bottom:10px;border-radius:9px;border:1px dashed var(--line);color:var(--text);font-size:13px}
.transport-bookmark-add:hover{border-color:var(--accent)}
`;

const PANEL = 'transport.bookmarks';

function inputError(message, reason) {
  return Object.assign(new TypeError(message), { code: 'ERR_COMMAND_INPUT', reason });
}

export function installBookmarks(ctx, { el, run, duration, position, markLeft, setPanel }) {
  const { Engine, store, registry, t, toast, formatTime } = ctx;
  let list = [];
  let storageKey = null;
  let ready = Promise.resolve();
  let renamingId = null;
  let loadToken = 0;

  const button = el('button', { type: 'button', text: '⚑', 'data-command': 'bookmark.panel',
    'aria-label': t('transport.bookmark.button'), 'aria-expanded': 'false', title: `${t('transport.bookmark.button')} (b)`,
    onclick: () => run('bookmark.panel', {}) });
  ctx.mounts.controlsLeft.append(button);
  const ticks = el('div', { class: 'transport-bookmarks' });
  ctx.mounts.seek.append(ticks);
  const body = ctx.panels.register(PANEL, t('transport.bookmark.panel'));

  const label = item => item.name || t('transport.bookmark.unnamed', { time: formatTime(item.timeS) });

  function render() {
    ticks.replaceChildren(...(duration() > 0 ? list : []).map(item => el('span', {
      class: 'transport-bookmark-tick', 'aria-hidden': 'true', 'data-command': 'bookmark.go',
      'data-transport-bookmark': item.id, title: t('transport.bookmark.item', { name: label(item), time: formatTime(item.timeS) }),
      style: `left:${markLeft(item.timeS)}`, onclick: () => run('bookmark.go', { id: item.id }) })));

    const focusedId = body.contains(document.activeElement) ? document.activeElement.closest('[data-bookmark-id]')?.dataset.bookmarkId : null;
    const children = [el('button', { type: 'button', class: 'transport-bookmark-add', 'data-command': 'bookmark.add',
      text: t('transport.bookmark.addHere'), onclick: () => run('bookmark.add', {}) })];
    if (!storageKey) children.push(el('p', { class: 'transport-hint', text: t('transport.bookmark.memoryOnly') }));
    if (!list.length) {
      children.push(el('p', { class: 'transport-empty', text: t('transport.bookmark.none') }));
    } else {
      const ol = el('ol', { class: 'transport-list' });
      for (const item of list) ol.append(el('li', { 'data-bookmark-id': item.id }, row(item)));
      children.push(ol);
    }
    body.replaceChildren(...children);
    if (renamingId) body.querySelector('[data-bookmark-id] input')?.focus();
    else if (focusedId) body.querySelector(`[data-bookmark-id="${CSS.escape(focusedId)}"] button`)?.focus({ preventScroll: true });
  }

  function row(item) {
    if (renamingId === item.id) {
      const input = el('input', { type: 'text', value: item.name, maxLength: BOOKMARK_NAME_MAX,
        'aria-label': t('transport.bookmark.nameLabel'), autocomplete: 'off' });
      const form = el('form', { onsubmit: event => {
        event.preventDefault();
        renamingId = null;
        run('bookmark.add', { id: item.id, name: input.value });
      } }, input,
      el('button', { type: 'submit', class: 'transport-mini', 'data-command': 'bookmark.add', text: t('transport.bookmark.save') }),
      el('button', { type: 'button', class: 'transport-mini', text: t('transport.bookmark.cancel'), onclick: () => { renamingId = null; render(); } }));
      input.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); renamingId = null; render(); }
      });
      return el('div', { class: 'transport-bookmark-row' }, form);
    }
    return el('div', { class: 'transport-bookmark-row' },
      el('button', { type: 'button', 'data-command': 'bookmark.go',
        'aria-label': t('transport.bookmark.item', { name: label(item), time: formatTime(item.timeS) }),
        onclick: () => run('bookmark.go', { id: item.id }) },
      el('span', { text: label(item) }), el('small', { text: formatTime(item.timeS) })),
      el('button', { type: 'button', class: 'transport-mini', 'data-command': 'bookmark.add', text: t('transport.bookmark.rename'),
        'aria-label': t('transport.bookmark.renameLabel', { name: label(item) }),
        onclick: () => { renamingId = item.id; render(); } }),
      el('button', { type: 'button', class: 'transport-mini', 'data-command': 'bookmark.remove', text: t('transport.bookmark.remove'),
        'aria-label': t('transport.bookmark.removeLabel', { name: label(item) }),
        onclick: () => run('bookmark.remove', { id: item.id }) }));
  }

  async function save() {
    if (!storageKey) return;
    try {
      // An empty list deletes the record, so a file with no bookmarks leaves nothing stored.
      if (list.length) await ctx.Storage.set(storageKey, list);
      else await deleteKeys(ctx.Storage, [storageKey]);
    } catch (error) {
      toast(t('transport.bookmark.saveFailed'), 'err', error.message);
    }
  }

  function read() {
    return {
      bookmarks: list.map((item, index) => ({ index, id: item.id, timeS: item.timeS, name: item.name })),
      persisted: Boolean(storageKey),
      panelOpen: ctx.panels.current() === PANEL,
    };
  }

  async function storedFiles() {
    try { return (await keysWithPrefix(ctx.Storage, BOOKMARK_PREFIX)).length; } catch { return null; }
  }

  function pick(input) {
    const item = findBookmark(list, input);
    if (!item) throw inputError(t('transport.bookmark.notFound'), 'target');
    return item;
  }

  registry.handle('bookmark.add', async ({ timeS, name, id }) => {
    await ready;
    if (typeof id === 'string') {
      pick({ id });
      list = renameBookmark(list, id, name);
      toast(t('transport.bookmark.renamed'));
    } else {
      const d = duration();
      const at = Number.isFinite(timeS) ? timeS : position();
      const clamped = Math.max(0, d > 0 ? Math.min(d, at) : at);
      const newId = `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      list = addBookmark(list, { id: newId, timeS: clamped, name });
      toast(t('transport.bookmark.added', { time: formatTime(clamped) }));
      render(); // draw before the save await, so a read during the save matches the panel
      await save();
      return { ...read(), id: newId };
    }
    render();
    await save();
    return read();
  });

  registry.handle('bookmark.list', async () => {
    await ready;
    return { ...read(), storedFiles: await storedFiles() };
  });
  registry.handle('bookmark.panel', async ({ open }) => {
    await ready;
    setPanel(PANEL, typeof open === 'boolean' ? open : ctx.panels.current() !== PANEL);
    return read();
  });
  registry.handle('bookmark.clear-all', async () => {
    await ready;
    const keys = await keysWithPrefix(ctx.Storage, BOOKMARK_PREFIX);
    const removed = await deleteKeys(ctx.Storage, keys);
    list = [];
    renamingId = null;
    render();
    toast(t('transport.bookmark.cleared', { count: removed }));
    return { removedFiles: removed, ...read() };
  });

  registry.handle('bookmark.go', async input => {
    await ready;
    const item = pick(input);
    await Engine.seek(item.timeS);
    return { ...read(), id: item.id, positionS: position() };
  });

  registry.handle('bookmark.remove', async input => {
    await ready;
    const item = pick(input);
    list = removeBookmark(list, item.id);
    if (renamingId === item.id) renamingId = null;
    toast(t('transport.bookmark.removed'));
    render();
    await save();
    return read();
  });

  async function load(fingerprint, token) {
    let stored = [];
    if (fingerprint) {
      try { stored = await ctx.Storage.get(`bookmarks:${fingerprint}`); } catch (error) { console.warn('[transport] bookmarks load', error); }
    }
    if (token !== loadToken) return;
    list = normaliseBookmarks(stored);
    render();
  }

  ctx.on('ui:media-loaded', () => {
    const fingerprint = store.media.fingerprint || Engine.state()?.media?.fingerprint || null;
    storageKey = fingerprint ? `bookmarks:${fingerprint}` : null;
    renamingId = null;
    list = [];
    loadToken += 1;
    ready = load(fingerprint, loadToken);
  });
  ctx.on('ui:media-cleared', () => {
    loadToken += 1;
    list = [];
    storageKey = null;
    renamingId = null;
    ready = Promise.resolve();
    if (ctx.panels.current() === PANEL) ctx.panels.close();
    render();
  });
  ctx.on('ui:panel', ({ id } = {}) => button.setAttribute('aria-expanded', String(id === PANEL)));
  ctx.on('playback:loaded', () => render());

  render();
}
