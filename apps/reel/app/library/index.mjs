/* Reel feature module: library (spec row L4). Contract: docs/build/reel-v1-contract.md, batch 2.
 * A grid of the opened folder's videos: poster frames, durations, watched marks and resume badges.
 * No DOM access at module top level, so Node can import COMMANDS for commands.json.
 *
 * Posters come from Engine.thumbnail, which decodes the loaded file only, so a card gets its poster
 * once that video has been opened; until then it shows a placeholder and its duration (from
 * Engine.probe). Posters are cached in OPFS (`reel-posters/<fingerprint>.webp`); media bytes never are.
 * Hosted in NakliOS, the folder comes from NakliOS storage (app/hosted, through the queue), and each
 * card's fingerprint and probe read through the item's ranged reader: the head and the container index.
 * Without range reads (Crate) a card is not read at all, because reading its head would download the
 * whole file; it gets its fingerprint and poster when the person plays it.
 *
 * Stored data (V25): a small dialog lists what Reel keeps (watch history, bookmarks, posters, the
 * remembered folder) and deletes each through a destructive command. When the 100-entry resume index
 * is full, posters and bookmarks of files it no longer lists are pruned (logic.mjs pruneTargets). */

import { queueSource, onQueueSource, itemFile, hostStore } from '../queue/shared.mjs';
import {
  POSTER_DIR, posterName, posterTime, watchState, gridMove, pruneTargets, RESUME_LIMIT, BOOKMARK_PREFIX,
} from './logic.mjs';
import { keysWithPrefix, deleteKeys, posterNames, deletePosters } from './forget.mjs';

const none = { type: 'object', properties: {}, required: [] };

export const COMMANDS = [
  { name: 'library.open', label: 'Library', scope: 'write', readTwin: 'library.read',
    description: 'Open or close the library view of the opened folder; with no input it toggles.',
    input: { type: 'object', properties: { open: { type: 'boolean' } }, required: [] }, shortcuts: [{ key: 'y' }] },
  { name: 'library.read', label: 'Library contents', scope: 'read', input: none,
    description: 'Read the library: each video with its duration, fingerprint, poster state (cached, placeholder or pending) and watch state (new, partial or watched, from the resume history), and what Reel stores (history entries, files with bookmarks, posters, remembered folder). Cards are described only while the library is open.' },
  { name: 'library.stored-data', label: 'Stored data', scope: 'write', readTwin: 'library.read',
    description: 'Open or close the Stored data dialog, which lists what Reel keeps in this browser and deletes it; with no input it toggles.',
    input: { type: 'object', properties: { open: { type: 'boolean' } }, required: [] } },
  { name: 'library.clear-history', label: 'Clear watch history', scope: 'destructive', readTwin: 'library.read', input: none,
    description: 'Delete the watch history: every resume position and the Continue watching list, in this browser and in the Crate when Crate watch history is on. It cannot be undone. Returns how many entries it deleted.' },
  { name: 'library.clear-posters', label: 'Clear posters', scope: 'destructive', readTwin: 'library.read', input: none,
    description: 'Delete every library poster Reel saved in this browser (OPFS reel-posters). They are made again when each video plays. Returns how many it deleted.' },
];

export const STRINGS = {
  'library.button': 'Library',
  'library.title': 'Library',
  'library.close': 'Close library',
  'library.empty': 'Open a folder to see its videos here.',
  'library.count': '{count} videos',
  'library.grid': 'Videos in this folder',
  'library.watched': 'Watched',
  'library.left': '{time} left',
  'library.new': 'Not started',
  'library.durationUnknown': 'Length unknown',
  'library.card': '{name}, {duration}, {state}',
  'library.stored.button': 'Stored data…',
  'library.stored.title': 'Stored data',
  'library.stored.close': 'Close stored data',
  'library.stored.intro': 'Reel keeps these in this browser. Media files are never copied. Each button deletes one kind; press it twice to confirm.',
  'library.stored.history': 'Watch history: {count} entries (resume positions and Continue watching)',
  'library.stored.bookmarks': 'Bookmarks: {count} files',
  'library.stored.posters': 'Library posters: {count}',
  'library.stored.folder': 'Remembered folder: {name}',
  'library.stored.noFolder': 'Remembered folder: none',
  'library.stored.unknown': 'unknown',
  'library.stored.clear': 'Delete',
  'library.stored.confirm': 'Press again to delete',
  'library.stored.forget': 'Forget',
  'library.toast.history': 'Deleted {count} watch history entries',
  'library.toast.posters': 'Deleted {count} posters',
};

async function posterDirectory(create) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(POSTER_DIR, { create });
}

async function readPoster(fingerprint) {
  try {
    const directory = await posterDirectory(false);
    const handle = await directory.getFileHandle(posterName(fingerprint));
    return URL.createObjectURL(await handle.getFile());
  } catch (_) {
    return null; // no cache yet, or no OPFS in this browser
  }
}

async function writePoster(fingerprint, blob) {
  try {
    const directory = await posterDirectory(true);
    const handle = await directory.getFileHandle(posterName(fingerprint), { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (_) {
    return false; // the poster still shows for this visit from memory
  }
}

async function bitmapToBlob(bitmap) {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.8));
}

export function install(ctx) {
  const { Engine, store, registry, t } = ctx;
  let cards = [];        // { index, item, fingerprint, durationS, posterUrl, poster, status }
  let generation = -1;
  let resume = new Map(); // fingerprint -> resume entry
  let working = false;
  let opener = null;

  /* ---------- data ---------- */

  function rebuild(source = queueSource()) {
    if (source.generation === generation) return;
    for (const card of cards) if (card.posterUrl) URL.revokeObjectURL(card.posterUrl);
    generation = source.generation;
    cards = source.items.map((item, index) => ({
      index, item, fingerprint: null, durationS: null, posterUrl: null, poster: 'pending', status: 'queued',
    }));
  }

  async function refreshResume() {
    try {
      const entries = await ctx.MetadataSync.listResume();
      resume = new Map(entries.map(entry => [entry.fingerprint, entry]));
    } catch (error) {
      ctx.surface('storage', error);
    }
  }

  async function makePoster(card) {
    if (typeof Engine.thumbnail !== 'function') return false;
    const media = Engine.state().media;
    if (!card.fingerprint || media.fingerprint !== card.fingerprint) return false;
    let bitmap = null;
    try {
      bitmap = await Engine.thumbnail(posterTime(card.durationS ?? media.duration), { maxWidth: 320 });
      if (!bitmap) return false;
      const blob = await bitmapToBlob(bitmap);
      if (!blob) return false;
      await writePoster(card.fingerprint, blob);
      if (card.posterUrl) URL.revokeObjectURL(card.posterUrl);
      card.posterUrl = URL.createObjectURL(blob);
      card.poster = 'cached';
      return true;
    } catch (_) {
      return false; // a cancelled or failed thumbnail leaves the placeholder
    } finally {
      bitmap?.close?.();
    }
  }

  /* Fingerprint, cached poster and duration for one card. Media bytes are read only as far as the
   * fingerprint (first 64 KB) and the container probe need; for a hosted item, `file` is a ranged
   * reader (Blob-shaped slice for the fingerprint, accepted by Engine.probe). */
  async function describe(card) {
    // Without range reads the head of a hosted file is the whole file (up to 64 MB): skip it.
    const unread = card.item.hosted && !hostStore()?.rangeReads;
    const file = unread ? null : await itemFile(card.item);
    if (file) {
      card.fingerprint = await ctx.Storage.fingerprint(file);
      try {
        const probed = await Engine.probe(file);
        if (Number.isFinite(probed?.duration)) card.durationS = probed.duration;
      } catch (_) { /* an unreadable file keeps "length unknown" */ }
      // The open file's own length stands in when the probe found none.
      if (card.durationS == null && store.media?.fingerprint === card.fingerprint
        && Number.isFinite(store.media.duration) && store.media.duration > 0) {
        card.durationS = store.media.duration;
      }
    } else if (store.media?.name === card.item.name) {
      card.fingerprint = store.media.fingerprint;
      card.durationS = Number.isFinite(store.media.duration) ? store.media.duration : null;
    }
    if (!card.fingerprint) { card.poster = 'placeholder'; return; }
    card.posterUrl = await readPoster(card.fingerprint);
    if (card.posterUrl) { card.poster = 'cached'; return; }
    card.poster = (await makePoster(card)) ? 'cached' : 'placeholder';
  }

  /* One card at a time, in the background, only after the library was opened or read. */
  async function pump() {
    if (working) return;
    working = true;
    const startedFor = generation;
    try {
      for (;;) {
        if (generation !== startedFor) break;
        const card = cards.find(item => item.status === 'queued');
        if (!card) break;
        card.status = 'working';
        try { await describe(card); } catch (_) { card.poster = 'placeholder'; }
        card.status = 'done';
        if (generation === startedFor) renderCard(card);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally {
      working = false;
      if (generation !== startedFor) pump();
    }
  }

  /* What Reel stores, counted by name. Reads only. */
  async function storedCounts() {
    const count = async fn => { try { return await fn(); } catch { return null; } };
    const [history, bookmarks, posters, queue] = await Promise.all([
      count(async () => (await ctx.MetadataSync.listResume()).length),
      count(async () => (await keysWithPrefix(ctx.Storage, BOOKMARK_PREFIX)).length),
      count(async () => (await posterNames()).length),
      count(() => registry.run('queue.read')),
    ]);
    return { historyEntries: history, bookmarkFiles: bookmarks, posters, folder: queue?.lastFolder ?? null };
  }

  function snapshot(entries = resume) {
    return {
      open: dialog.open,
      storedOpen: storedDialog.open,
      folder: queueSource().folderName,
      count: cards.length,
      pending: cards.filter(card => card.status !== 'done').length,
      cards: cards.map(card => ({
        index: card.index,
        name: card.item.name,
        path: card.item.path,
        durationS: card.durationS,
        fingerprint: card.fingerprint,
        poster: card.status === 'done' ? card.poster : 'pending',
        watch: watchState(entries.get(card.fingerprint), card.durationS),
      })),
    };
  }

  /* ---------- UI ---------- */

  ctx.addStyle(`
    .library-dialog{width:min(1100px,94vw);max-height:90vh;padding:0;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface-2);color:var(--text)}
    .library-dialog::backdrop{background:rgba(0,0,0,.6)}
    .library-head{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line)}
    .library-head h2{font-size:15px;font-weight:600}
    .library-head .library-folder{color:var(--dim);font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .library-body{padding:14px 16px;overflow:auto;max-height:calc(90vh - 60px)}
    .library-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;list-style:none;margin:0;padding:0}
    .library-card{display:flex;flex-direction:column;gap:6px;width:100%;padding:6px;text-align:left;background:none;border:1px solid transparent;border-radius:8px;color:var(--text)}
    .library-card:hover{border-color:var(--line)}
    .library-card:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
    .library-poster{position:relative;aspect-ratio:16/9;border-radius:6px;overflow:hidden;background:rgba(255,255,255,.05);display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:22px}
    .library-poster img{width:100%;height:100%;object-fit:cover}
    .library-progress{position:absolute;left:0;bottom:0;height:3px;background:var(--accent)}
    .library-badge{position:absolute;top:6px;right:6px;padding:2px 6px;border-radius:4px;font-size:11px;background:rgba(0,0,0,.7);color:var(--text)}
    .library-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .library-meta{font-size:12px;color:var(--dim)}
    .library-stored{width:min(560px,94vw)}
    .library-stored-list{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
    .library-stored-list li{display:flex;align-items:center;gap:12px;font-size:13px}
    .library-stored-list li span{flex:1}
    .library-stored-list button,.library-head button{padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:none;color:var(--text);font:inherit;font-size:12px}
    .library-stored-list button[disabled]{opacity:.45}
    .library-dialog button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  `);

  const run = (name, input) => Promise.resolve(registry.run(name, input)).catch(error => ctx.surface('playback', error));

  const startButton = document.createElement('button');
  startButton.type = 'button';
  startButton.hidden = true;
  startButton.dataset.library = 'open';
  startButton.dataset.command = 'library.open';
  startButton.addEventListener('click', () => run('library.open', { open: true }));
  ctx.mounts.emptyActions.append(startButton);

  const dialog = document.createElement('dialog');
  dialog.className = 'library-dialog';
  dialog.dataset.library = 'dialog';
  dialog.setAttribute('aria-labelledby', 'library-title');
  const head = document.createElement('header');
  head.className = 'library-head';
  const title = document.createElement('h2');
  title.id = 'library-title';
  const folder = document.createElement('span');
  folder.className = 'library-folder';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.dataset.command = 'library.open';
  closeButton.textContent = '✕';
  closeButton.addEventListener('click', () => run('library.open', { open: false }));
  const storedHeadButton = document.createElement('button');
  storedHeadButton.type = 'button';
  storedHeadButton.dataset.command = 'library.stored-data';
  storedHeadButton.addEventListener('click', () => run('library.stored-data', { open: true }));
  head.append(title, folder, storedHeadButton, closeButton);
  const bodyEl = document.createElement('div');
  bodyEl.className = 'library-body';
  const status = document.createElement('p');
  status.className = 'library-meta';
  status.setAttribute('role', 'status');
  const grid = document.createElement('ul');
  grid.className = 'library-grid';
  bodyEl.append(status, grid);
  dialog.append(head, bodyEl);
  ctx.mounts.dialogs.append(dialog);

  /* Stored data dialog (V25). Each Delete button asks for a second press within 4 s. */
  const storedStart = document.createElement('button');
  storedStart.type = 'button';
  storedStart.dataset.library = 'stored-open';
  storedStart.dataset.command = 'library.stored-data';
  storedStart.addEventListener('click', () => run('library.stored-data', { open: true }));
  ctx.mounts.emptyActions.append(storedStart);

  const storedDialog = document.createElement('dialog');
  storedDialog.className = 'library-dialog library-stored';
  storedDialog.dataset.library = 'stored';
  storedDialog.setAttribute('aria-labelledby', 'library-stored-title');
  const storedHead = document.createElement('header');
  storedHead.className = 'library-head';
  const storedTitle = document.createElement('h2');
  storedTitle.id = 'library-stored-title';
  const storedClose = document.createElement('button');
  storedClose.type = 'button';
  storedClose.dataset.command = 'library.stored-data';
  storedClose.textContent = '✕';
  storedClose.addEventListener('click', () => run('library.stored-data', { open: false }));
  storedHead.append(storedTitle, storedClose);
  const storedIntro = document.createElement('p');
  storedIntro.className = 'library-meta';
  const storedList = document.createElement('ul');
  storedList.className = 'library-stored-list';
  const storedBody = document.createElement('div');
  storedBody.className = 'library-body';
  storedBody.append(storedIntro, storedList);
  storedDialog.append(storedHead, storedBody);
  ctx.mounts.dialogs.append(storedDialog);
  // Keys stay inside the dialog, so the player's shortcuts do not fire behind it.
  storedDialog.addEventListener('keydown', event => event.stopPropagation());
  let storedOpener = null;
  storedDialog.addEventListener('close', () => {
    if (storedOpener?.isConnected) storedOpener.focus({ preventScroll: true });
    storedOpener = null;
  });

  const STORED_ROWS = [
    { kind: 'history', command: 'library.clear-history', label: counts => t('library.stored.history', { count: counts.historyEntries ?? t('library.stored.unknown') }), empty: counts => counts.historyEntries === 0 },
    { kind: 'bookmarks', command: 'bookmark.clear-all', label: counts => t('library.stored.bookmarks', { count: counts.bookmarkFiles ?? t('library.stored.unknown') }), empty: counts => counts.bookmarkFiles === 0 },
    { kind: 'posters', command: 'library.clear-posters', label: counts => t('library.stored.posters', { count: counts.posters ?? t('library.stored.unknown') }), empty: counts => counts.posters === 0 },
    { kind: 'folder', command: 'queue.forget-folder', action: 'library.stored.forget', label: counts => counts.folder ? t('library.stored.folder', { name: counts.folder }) : t('library.stored.noFolder'), empty: counts => !counts.folder },
  ];

  async function renderStored() {
    storedTitle.textContent = t('library.stored.title');
    storedClose.setAttribute('aria-label', t('library.stored.close'));
    storedIntro.textContent = t('library.stored.intro');
    const counts = await storedCounts();
    storedList.replaceChildren(...STORED_ROWS.map(row => {
      const li = document.createElement('li');
      li.dataset.stored = row.kind;
      const text = document.createElement('span');
      text.textContent = row.label(counts);
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.command = row.command;
      const idle = t(row.action || 'library.stored.clear');
      button.textContent = idle;
      button.setAttribute('aria-label', `${idle}: ${text.textContent}`);
      button.disabled = row.empty(counts);
      let armed = null;
      button.addEventListener('click', async () => {
        if (!armed) {
          button.textContent = t('library.stored.confirm');
          armed = setTimeout(() => { armed = null; button.textContent = idle; }, 4000);
          return;
        }
        clearTimeout(armed);
        armed = null;
        await run(row.command, {});
        await renderStored();
        storedList.querySelector(`[data-stored="${row.kind}"] button`)?.focus({ preventScroll: true });
      });
      li.append(text, button);
      return li;
    }));
    return counts;
  }

  async function setStoredOpen(open) {
    if (open === storedDialog.open) return;
    if (!open) { storedDialog.close(); return; }
    storedOpener = document.activeElement;
    await renderStored();
    storedDialog.showModal();
    (storedList.querySelector('button:not([disabled])') || storedClose).focus();
  }

  function cardLabel(card, watch) {
    const duration = card.durationS != null ? ctx.formatTime(card.durationS) : t('library.durationUnknown');
    const state = watch.state === 'watched' ? t('library.watched')
      : watch.state === 'partial' ? t('library.left', { time: ctx.formatTime(watch.leftS) })
      : t('library.new');
    return t('library.card', { name: card.item.name, duration, state });
  }

  function renderCard(card) {
    const button = grid.querySelector(`button[data-index="${card.index}"]`);
    if (!button) return;
    const watch = watchState(resume.get(card.fingerprint), card.durationS);
    const poster = document.createElement('span');
    poster.className = 'library-poster';
    poster.dataset.poster = card.status === 'done' ? card.poster : 'pending';
    if (card.posterUrl) {
      const img = document.createElement('img');
      img.src = card.posterUrl;
      img.alt = '';
      poster.append(img);
    } else {
      poster.append(document.createTextNode('▶'));
    }
    if (watch.state !== 'new') {
      const badge = document.createElement('span');
      badge.className = 'library-badge';
      badge.dataset.watch = watch.state;
      badge.textContent = watch.state === 'watched' ? t('library.watched') : t('library.left', { time: ctx.formatTime(watch.leftS) });
      const bar = document.createElement('span');
      bar.className = 'library-progress';
      bar.style.width = `${Math.round(watch.fraction * 100)}%`;
      poster.append(badge, bar);
    }
    const name = document.createElement('span');
    name.className = 'library-name';
    name.textContent = card.item.name;
    const meta = document.createElement('span');
    meta.className = 'library-meta';
    meta.textContent = card.durationS != null ? ctx.formatTime(card.durationS) : '…';
    button.replaceChildren(poster, name, meta);
    button.dataset.watch = watch.state;
    button.title = card.item.path;
    button.setAttribute('aria-label', cardLabel(card, watch));
  }

  function render() {
    const source = queueSource();
    rebuild(source);
    startButton.textContent = t('library.button');
    storedStart.textContent = t('library.stored.button');
    storedHeadButton.textContent = t('library.stored.button');
    startButton.hidden = !source.items.some(item => item.file || item.handle || item.hosted);
    title.textContent = t('library.title');
    folder.textContent = source.folderName || '';
    closeButton.setAttribute('aria-label', t('library.close'));
    grid.setAttribute('aria-label', t('library.grid'));
    status.textContent = cards.length ? t('library.count', { count: cards.length }) : t('library.empty');
    const focused = grid.contains(document.activeElement) ? document.activeElement.dataset.index : null;
    grid.replaceChildren(...cards.map(card => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'library-card';
      button.dataset.index = String(card.index);
      button.dataset.command = 'queue.play';
      button.addEventListener('click', () => {
        setOpen(false);
        run('queue.play', { index: card.index });
      });
      li.append(button);
      return li;
    }));
    for (const card of cards) renderCard(card);
    if (focused != null) grid.querySelector(`button[data-index="${focused}"]`)?.focus({ preventScroll: true });
  }

  function columns() {
    const template = getComputedStyle(grid).gridTemplateColumns;
    return template && template !== 'none' ? template.split(' ').length : 1;
  }

  // Arrow keys move between cards; Enter (native button) plays. Keys other than the library's own
  // `y` stay inside the dialog, so the player's shortcuts do not fire behind it.
  dialog.addEventListener('keydown', event => {
    const button = event.target.closest?.('.library-card');
    if (button && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const target = gridMove(Number(button.dataset.index), event.key, cards.length, columns());
      if (target !== null) {
        event.preventDefault();
        grid.querySelector(`button[data-index="${target}"]`)?.focus();
      }
    }
    if (event.key.toLowerCase() !== 'y') event.stopPropagation();
  });
  dialog.addEventListener('close', () => {
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  });

  async function setOpen(open) {
    if (open === dialog.open) return;
    if (!open) { dialog.close(); return; }
    opener = document.activeElement;
    render();
    dialog.showModal();
    const currentName = store.media?.name;
    const current = cards.find(card => card.item.name === currentName) || cards[0];
    (current ? grid.querySelector(`button[data-index="${current.index}"]`) : closeButton)?.focus();
    await refreshResume();
    for (const card of cards) renderCard(card);
    pump();
  }

  onQueueSource(() => {
    render();
    if (dialog.open) pump();
  });

  // A new resume entry (a pause, a seek, Crate sync) refreshes the watch marks and may prune.
  ctx.MetadataSync.onChange?.(() => {
    refreshResume().then(() => { if (dialog.open) for (const card of cards) renderCard(card); });
    schedulePrune();
  });

  // Make the poster for a newly loaded video in the background, so the grid fills as you watch.
  ctx.on('ui:media-loaded', () => {
    setTimeout(async () => {
      const media = Engine.state().media;
      if (!media.fingerprint) return;
      const card = cards.find(item => item.fingerprint === media.fingerprint)
        || cards.find(item => !item.fingerprint && item.item.name === media.name);
      if (!card || card.poster === 'cached') return;
      card.fingerprint = media.fingerprint;
      if (await makePoster(card)) renderCard(card);
    }, 1500);
  });

  /* Pruning: once the resume index is full it has dropped entries, so delete the posters and
   * bookmarks of files it no longer lists (kept: the file open now and the library's cards). */
  let pruneTimer = null;
  function schedulePrune(delayMs = 30_000) {
    if (pruneTimer) return;
    pruneTimer = setTimeout(() => { pruneTimer = null; prune().catch(() => {}); }, delayMs);
  }
  async function prune() {
    if (ctx.MetadataSync.state?.().lastError) return { bookmarkKeys: 0, posters: 0 };
    const entries = await ctx.MetadataSync.listResume();
    if (entries.length < RESUME_LIMIT) return { bookmarkKeys: 0, posters: 0 };
    const keep = [Engine.state().media?.fingerprint, ...cards.map(card => card.fingerprint)];
    const targets = pruneTargets({
      entries, keep,
      bookmarkKeys: await keysWithPrefix(ctx.Storage, BOOKMARK_PREFIX),
      posters: await posterNames(),
    });
    return {
      bookmarkKeys: await deleteKeys(ctx.Storage, targets.bookmarkKeys),
      posters: await deletePosters(targets.posters),
    };
  }

  /* Deletes the watch history: the browser's resume index by name, and Crate's library.json
   * when Crate watch history is on. */
  async function clearHistory() {
    const sync = ctx.MetadataSync.state?.() || { mode: 'browser' };
    let removed = 0;
    const local = await ctx.Storage.get('resume:index');
    if (Array.isArray(local)) removed += local.length;
    await deleteKeys(ctx.Storage, ['resume:index']);
    if (sync.mode === 'crate' && sync.crateActive) {
      const bridge = await ctx.nakliosBridge();
      const crate = await ctx.MetadataSync.listResume();
      removed += crate.length;
      await bridge.fs.write('library.json', JSON.stringify({ version: 1, items: [] }, null, 2));
    } else {
      // useBrowser() with the browser already chosen changes nothing and tells listeners
      // (Continue watching on the start screen) to read the now empty index.
      await ctx.MetadataSync.useBrowser?.();
    }
    resume = new Map();
    if (dialog.open) for (const card of cards) renderCard(card);
    return removed;
  }

  async function clearPosters() {
    const removed = await deletePosters(await posterNames());
    for (const card of cards) {
      if (card.posterUrl) URL.revokeObjectURL(card.posterUrl);
      card.posterUrl = null;
      if (card.poster === 'cached') card.poster = 'placeholder';
      if (dialog.open) renderCard(card);
    }
    return removed;
  }

  registry.handle('library.open', async ({ open }) => {
    await setOpen(typeof open === 'boolean' ? open : !dialog.open);
    return snapshot();
  });
  // Pure read: it starts no card reads and changes no view; watch marks come from a fresh list.
  registry.handle('library.read', async () => {
    rebuild();
    let entries = resume;
    try { entries = new Map((await ctx.MetadataSync.listResume()).map(entry => [entry.fingerprint, entry])); } catch { /* cached marks */ }
    return { ...snapshot(entries), stored: await storedCounts() };
  });
  registry.handle('library.stored-data', async ({ open }) => {
    await setStoredOpen(typeof open === 'boolean' ? open : !storedDialog.open);
    return { ...snapshot(), stored: await storedCounts() };
  });
  registry.handle('library.clear-history', async () => {
    const removed = await clearHistory();
    ctx.toast(t('library.toast.history', { count: removed }));
    if (storedDialog.open) await renderStored();
    return { removed, stored: await storedCounts() };
  });
  registry.handle('library.clear-posters', async () => {
    const removed = await clearPosters();
    ctx.toast(t('library.toast.posters', { count: removed }));
    if (storedDialog.open) await renderStored();
    return { removed, stored: await storedCounts() };
  });

  if (new URLSearchParams(location.search).get('dev') === '1') {
    globalThis.__reelLibrary = Object.freeze({ prune: () => prune() });
  }

  render();
  schedulePrune(5_000);
}
