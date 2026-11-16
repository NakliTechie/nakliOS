/* Reel feature module: queue (spec rows O2 folder playlist, O3 queue panel, O4 NakliOS handoff).
 * Contract: docs/build/reel-v1-contract.md.
 * No DOM access at module top level, so Node can import COMMANDS for commands.json.
 *
 * Folder walking and folder-drop handling are adapted from NakliAmp app/library/scan-core.mjs (`walk`)
 * and app/library/scan.mjs (`requestFolder`, `directoryFromDrop`) at NakliAmp commit 5eb5937.
 * The NakliOS handoff follows Montella src/host.js `onFiles` (naklios.files.onOpen / read / release). */

import {
  MAX_DEPTH, MAX_ENTRIES, REPEAT_MODES,
  classify, siblingsFor, videosPerFolder, dirOf, stripRoot, isHiddenName, isSubtitleName,
  createOrder, currentIndex, setShuffle, setRepeat, cycleRepeat, jumpTo, next, previous,
} from './logic.mjs';

const none = { type: 'object', properties: {}, required: [] };

export const COMMANDS = [
  { name: 'queue.open-folder', label: 'Open folder', scope: 'write', input: none, readTwin: 'queue.read',
    description: 'Ask the person to pick a folder, queue its videos in natural sort order and play the first.' },
  { name: 'queue.play', label: 'Play queue item', scope: 'write', readTwin: 'queue.read',
    description: 'Play the queue item at an index (natural folder order, starting at 0).',
    input: { type: 'object', properties: { index: { type: 'integer', minimum: 0, description: 'Item index from queue.read' } }, required: ['index'] } },
  { name: 'queue.next', label: 'Next in queue', scope: 'write', input: none, readTwin: 'queue.read',
    description: 'Play the next queue item, following shuffle and repeat-all.', shortcuts: [{ key: 'n' }] },
  { name: 'queue.previous', label: 'Previous in queue', scope: 'write', input: none, readTwin: 'queue.read',
    description: 'Restart the current item if more than 3 seconds in, else play the previous queue item.',
    shortcuts: [{ key: 'shift+n' }] },
  { name: 'queue.repeat', label: 'Repeat', scope: 'write', readTwin: 'queue.read',
    description: 'Set repeat to off, all or one; with no input it cycles off, all, one.',
    input: { type: 'object', properties: { mode: { type: 'string', enum: [...REPEAT_MODES] } }, required: [] } },
  { name: 'queue.shuffle', label: 'Shuffle', scope: 'write', readTwin: 'queue.read',
    description: 'Turn shuffle on or off; with no input it toggles. The current item stays current.',
    input: { type: 'object', properties: { on: { type: 'boolean' } }, required: [] } },
  { name: 'queue.read', label: 'Queue', scope: 'read', input: none,
    description: 'Read the queue: items, current index, play order, repeat, shuffle, sibling subtitle names and whether the panel is open.' },
  { name: 'queue.panel', label: 'Queue panel', scope: 'write', readTwin: 'queue.read',
    description: 'Open or close the queue panel; with no input it toggles.',
    input: { type: 'object', properties: { open: { type: 'boolean' } }, required: [] }, shortcuts: [{ key: 'q' }] },
];

export const STRINGS = {
  'queue.open-folder': 'Open folder…',
  'queue.button': 'Queue',
  'queue.panel.title': 'Queue',
  'queue.panel.empty': 'The queue is empty. Open a folder, or drop several videos on the start screen.',
  'queue.position': '{current} of {count}',
  'queue.repeat.off': 'Repeat: off',
  'queue.repeat.all': 'Repeat: all',
  'queue.repeat.one': 'Repeat: one',
  'queue.shuffle': 'Shuffle',
  'queue.list': 'Queue items',
  'queue.item': 'Play {name}',
  'queue.item.current': '{name}, now playing',
  'queue.end': 'End of the queue',
  'queue.noVideos': 'No videos Reel can play in that folder',
  'queue.noVideos.detail': 'Reel plays {formats}.',
  'queue.truncated': 'Reel queued the first {count} files only',
  'queue.handoff.failed': 'NakliOS could not hand over a file',
};

function fileOf(record) {
  return record.file ? Promise.resolve(record.file) : record.handle.getFile();
}

/* Directory handle walk (NakliAmp scan-core `walk`): skips dot entries, caps depth and entry count. */
async function walkHandle(directory, keep, prefix = '', depth = 0, out = []) {
  if (depth > MAX_DEPTH) return out;
  for await (const [name, handle] of directory.entries()) {
    if (out.length >= MAX_ENTRIES) break;
    if (isHiddenName(name)) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') await walkHandle(handle, keep, path, depth + 1, out);
    else if (keep(name)) out.push({ name, path, handle });
  }
  return out;
}

function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const step = () => reader.readEntries(batch => {
      if (!batch.length) return resolve(all);
      all.push(...batch);
      step();
    }, reject);
    step();
  });
}

/* FileSystemEntry walk for drops (Chromium, Safari and Firefox all give webkitGetAsEntry). */
async function walkEntry(entry, keep, path, depth, out) {
  if (out.length >= MAX_ENTRIES || depth > MAX_DEPTH || isHiddenName(entry.name)) return out;
  if (entry.isDirectory) {
    for (const child of await readAllEntries(entry.createReader())) {
      await walkEntry(child, keep, path ? `${path}/${child.name}` : child.name, depth + 1, out);
    }
  } else if (keep(entry.name)) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ name: file.name, path: path || file.name, file });
  }
  return out;
}

export function install(ctx) {
  const { Engine, store, registry, t } = ctx;
  let items = [];       // natural order: { name, path, file? , handle?, external? }
  let subtitles = [];   // subtitle records from the same pick or drop
  let siblings = [];    // File objects for the current item
  let order = createOrder(0);
  let expected = null;  // the item the queue itself is opening
  let panelOpen = false;

  const playable = name => ctx.supportsPlayback({ name, type: '' });
  const keep = name => isSubtitleName(name) || playable(name);

  function snapshot() {
    return {
      count: items.length,
      current: currentIndex(order),
      currentName: items[currentIndex(order)]?.name ?? null,
      order: [...order.order],
      repeat: order.repeat,
      shuffle: order.shuffle,
      items: items.map((item, index) => ({ index, name: item.name, path: item.path })),
      siblings: siblings.map(file => file.name),
      panelOpen,
    };
  }

  function publish() {
    store.ui.queue = {
      items: items.map(({ name, path }) => ({ name, path })),
      current: currentIndex(order),
      order: [...order.order],
      repeat: order.repeat,
      shuffle: order.shuffle,
      siblings: [...siblings],
    };
    render();
  }

  /* ---------- opening items ---------- */

  async function openIndex(index, { play = true } = {}) {
    const item = items[index];
    if (!item) throw Object.assign(new RangeError(`No queue item ${index}.`), { code: 'ERR_COMMAND_INPUT' });
    order = jumpTo(order, index);
    if (item.external) {
      // Opened outside the queue: there is no file to reopen, so restart the loaded video.
      publish();
      await Engine.seek(0);
      if (play) await playQuietly();
      return;
    }
    const soleVideo = videosPerFolder(items).get(dirOf(item.path)) === 1;
    siblings = await Promise.all(siblingsFor(item.path, subtitles, { soleVideo }).map(fileOf));
    publish();
    ctx.Events.emit('queue:siblings', { videoName: item.name, files: [...siblings] });
    expected = item;
    try {
      await ctx.openFile(item.handle || item.file);
    } finally {
      if (expected === item) expected = null;
    }
    if (Engine.state().media?.name !== item.name) return; // superseded by another open
    // A resume point at the very end would end the item at once; a queue item starts over then.
    const { media, clock } = Engine.state();
    if (Number.isFinite(media.duration) && clock.positionS >= media.duration - 0.5) await Engine.seek(0);
    if (play) await playQuietly();
  }

  /* A refused play (for example audio needing a gesture) is reported, but the queue move stands. */
  async function playQuietly() {
    try { await Engine.play(); } catch (error) { ctx.surface('playback', error); }
  }

  async function restartCurrent() {
    await Engine.seek(0);
    await playQuietly();
  }

  async function advance({ auto = false } = {}) {
    if (!items.length) return snapshot();
    const before = currentIndex(order);
    const after = next(order, { auto });
    if (!after) {
      if (!auto) ctx.toast(t('queue.end'));
      return snapshot();
    }
    order = after;
    const index = currentIndex(order);
    if (index === before) {
      publish();
      await restartCurrent();
    } else {
      await openIndex(index);
    }
    return snapshot();
  }

  async function goBack() {
    if (!items.length) return snapshot();
    if ((Engine.state().clock?.positionS || 0) > 3) {
      await Engine.seek(0);
      return snapshot();
    }
    const before = currentIndex(order);
    const after = previous(order);
    if (!after || currentIndex(after) === before) {
      await Engine.seek(0);
      return snapshot();
    }
    order = after;
    await openIndex(currentIndex(order));
    return snapshot();
  }

  /* records: [{ name, path, file? | handle? }] from a folder pick, a drop, NakliOS or the dev hook. */
  async function loadRecords(records, { truncated = false } = {}) {
    const { videos, subtitles: subs } = classify(records, record => ctx.supportsPlayback(record.file || { name: record.name, type: '' }));
    if (!videos.length) {
      // Subtitles alone, while a video plays: offer them to the subtitles module for that video.
      if (subs.length && store.media?.name) {
        const files = await Promise.all(subs.map(fileOf));
        ctx.Events.emit('queue:siblings', { videoName: store.media.name, files });
        return snapshot();
      }
      ctx.toast(t('queue.noVideos'), 'err', t('queue.noVideos.detail', { formats: ctx.videoExtensions().join(' ') }));
      return snapshot();
    }
    if (truncated) ctx.toast(t('queue.truncated', { count: MAX_ENTRIES }));
    items = videos;
    subtitles = subs;
    order = createOrder(items.length, { repeat: order.repeat, shuffle: order.shuffle });
    await openIndex(currentIndex(order));
    return snapshot();
  }

  /* ---------- O2: folder picker ---------- */

  function pickWithInput() {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.webkitdirectory = true;
      input.hidden = true;
      const done = value => { input.remove(); resolve(value); };
      input.addEventListener('change', () => done([...input.files]), { once: true });
      input.addEventListener('cancel', () => done(null), { once: true });
      ctx.mounts.dialogs.append(input);
      input.click();
    });
  }

  /* Synchronous up to the picker call, so the click's user activation reaches it. */
  function openFolder() {
    if (typeof globalThis.showDirectoryPicker === 'function') {
      return globalThis.showDirectoryPicker({ id: 'reel-folder', mode: 'read' }).then(
        async handle => {
          const records = await walkHandle(handle, keep);
          return loadRecords(records, { truncated: records.length >= MAX_ENTRIES });
        },
        error => { if (error?.name === 'AbortError') return snapshot(); throw error; },
      );
    }
    return pickWithInput().then(files => {
      if (!files) return snapshot();
      const records = files
        .filter(file => keep(file.name))
        .slice(0, MAX_ENTRIES)
        .map(file => ({ name: file.name, path: stripRoot(file.webkitRelativePath || file.name), file }));
      return loadRecords(records, { truncated: records.length >= MAX_ENTRIES });
    });
  }

  /* ---------- O3: multi-file and folder drop on the start screen ---------- */

  function onDrop(event) {
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const fileItems = [...(transfer.items || [])].filter(item => item.kind === 'file');
    const entries = fileItems.map(item => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null));
    const hasDirectory = entries.some(entry => entry?.isDirectory);
    if (fileItems.length <= 1 && !hasDirectory) return; // index.html's single-file drop handles it
    event.preventDefault();
    event.stopPropagation();
    event.target?.closest?.('.dropzone')?.classList.remove('dragover');
    const files = [...(transfer.files || [])]; // read now: the DataTransfer empties after this task
    collectDrop(entries, files)
      .then(records => loadRecords(records, { truncated: records.length >= MAX_ENTRIES }))
      .catch(error => ctx.surface('file-open', error));
  }

  async function collectDrop(entries, files) {
    if (!entries.length || entries.some(entry => !entry)) {
      return files.filter(file => keep(file.name)).map(file => ({ name: file.name, path: file.name, file }));
    }
    const out = [];
    // One dropped folder is the root, as with the picker; several items keep their top-level names.
    const singleRoot = entries.length === 1 && entries[0].isDirectory;
    for (const entry of entries) {
      if (singleRoot) {
        for (const child of await readAllEntries(entry.createReader())) await walkEntry(child, keep, child.name, 1, out);
      } else {
        await walkEntry(entry, keep, entry.name, 0, out);
      }
    }
    return out;
  }

  /* ---------- O4: files NakliOS opens with Reel ---------- */

  function wireNakliOS() {
    const bridgePromise = ctx.nakliosBridge();
    let pending = [];
    let timer = 0;
    const flush = async () => {
      const batch = pending;
      pending = [];
      const results = await Promise.allSettled(batch);
      const failed = results.filter(result => result.status === 'rejected');
      if (failed.length) ctx.toast(t('queue.handoff.failed'), 'err', String(failed[0].reason?.message || failed[0].reason));
      const records = results.filter(result => result.status === 'fulfilled')
        .map(({ value: file }) => ({ name: file.name, path: file.name, file }));
      if (records.length) await loadRecords(records);
    };
    Promise.resolve(bridgePromise).then(bridge => {
      if (!bridge?.files?.onOpen) return;
      bridge.files.onOpen(grant => {
        pending.push(bridge.files.read(grant.token).then(file => {
          const bytes = file.bytes ?? file.data;
          return new File([bytes], file.name || grant.name || 'video', { type: file.type || grant.type || '' });
        }).finally(() => { try { bridge.files.release?.(grant.token); } catch (_) { /* host gone */ } }));
        // A "Send to Reel" of several files arrives as one grant each; gather them into one queue.
        clearTimeout(timer);
        timer = setTimeout(() => flush().catch(error => ctx.surface('file-open', error)), 400);
      });
    }).catch(() => { /* standalone or SDK failed to load: index.html already reports SDK errors */ });
  }

  /* ---------- UI ---------- */

  ctx.addStyle(`
    .queue-tools{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
    .queue-tools button[aria-pressed="true"]{border-color:var(--accent);color:var(--text)}
    .queue-status{color:var(--dim);font-size:12px;margin-bottom:8px}
    .queue-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
    .queue-list button{width:100%;text-align:left;padding:6px 8px;border-radius:6px;background:none;border:1px solid transparent;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .queue-list button:hover{color:var(--text);border-color:var(--line)}
    .queue-list button[aria-current="true"]{color:var(--text);border-color:var(--accent)}
    .queue-list button:focus-visible,.queue-tools button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
    .queue-list .queue-dir{opacity:.6;margin-right:4px}
  `);

  const run = (name, input) => Promise.resolve(registry.run(name, input)).catch(error => ctx.surface('playback', error));

  const emptyButton = document.createElement('button');
  emptyButton.type = 'button';
  emptyButton.dataset.queue = 'open-folder';
  emptyButton.dataset.command = 'queue.open-folder';
  emptyButton.addEventListener('click', () => run('queue.open-folder'));
  ctx.mounts.emptyActions.append(emptyButton);

  const controlButton = document.createElement('button');
  controlButton.type = 'button';
  controlButton.dataset.queue = 'toggle';
  controlButton.dataset.command = 'queue.panel';
  controlButton.textContent = '☰';
  controlButton.setAttribute('aria-pressed', 'false');
  controlButton.addEventListener('click', () => run('queue.panel'));
  ctx.mounts.controlsRight.append(controlButton);

  const body = ctx.panels.register('queue', t('queue.panel.title'));
  body.dataset.queue = 'panel';
  const tools = document.createElement('div');
  tools.className = 'queue-tools';
  const panelOpenButton = document.createElement('button');
  panelOpenButton.type = 'button';
  panelOpenButton.dataset.command = 'queue.open-folder';
  panelOpenButton.addEventListener('click', () => run('queue.open-folder'));
  const repeatButton = document.createElement('button');
  repeatButton.type = 'button';
  repeatButton.dataset.queue = 'repeat';
  repeatButton.dataset.command = 'queue.repeat';
  repeatButton.addEventListener('click', () => run('queue.repeat'));
  const shuffleButton = document.createElement('button');
  shuffleButton.type = 'button';
  shuffleButton.dataset.queue = 'shuffle';
  shuffleButton.dataset.command = 'queue.shuffle';
  shuffleButton.addEventListener('click', () => run('queue.shuffle'));
  tools.append(panelOpenButton, repeatButton, shuffleButton);
  const status = document.createElement('p');
  status.className = 'queue-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const list = document.createElement('ol');
  list.className = 'queue-list';
  body.append(tools, status, list);

  function render() {
    emptyButton.textContent = t('queue.open-folder');
    panelOpenButton.textContent = t('queue.open-folder');
    controlButton.setAttribute('aria-label', t('queue.button'));
    controlButton.title = t('queue.button');
    repeatButton.textContent = t(`queue.repeat.${order.repeat}`);
    shuffleButton.textContent = t('queue.shuffle');
    shuffleButton.setAttribute('aria-pressed', String(order.shuffle));
    list.setAttribute('aria-label', t('queue.list'));
    const current = currentIndex(order);
    status.textContent = items.length
      ? t('queue.position', { current: (current ?? 0) + 1, count: items.length })
      : t('queue.panel.empty');
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.index : null;
    list.replaceChildren(...items.map((item, index) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.index = String(index);
      button.dataset.command = 'queue.play';
      const dir = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
      if (dir) {
        const span = document.createElement('span');
        span.className = 'queue-dir';
        span.textContent = `${dir}/`;
        button.append(span);
      }
      button.append(document.createTextNode(item.name));
      button.title = item.path;
      if (index === current) button.setAttribute('aria-current', 'true');
      button.setAttribute('aria-label', t(index === current ? 'queue.item.current' : 'queue.item', { name: item.name }));
      button.addEventListener('click', () => run('queue.play', { index }));
      li.append(button);
      return li;
    }));
    if (focused !== null && focused !== undefined) list.querySelector(`button[data-index="${focused}"]`)?.focus({ preventScroll: true });
  }

  function setPanel(open) {
    if (open === (ctx.panels.current() === 'queue')) return;
    if (open) {
      ctx.panels.open('queue');
      const target = list.querySelector('button[aria-current="true"]') || panelOpenButton;
      target.focus({ preventScroll: true });
      target.scrollIntoView?.({ block: 'nearest' });
    } else {
      const hadFocus = body.contains(document.activeElement);
      ctx.panels.close();
      if (hadFocus) controlButton.focus({ preventScroll: true });
    }
  }

  ctx.on('ui:panel', ({ id }) => {
    panelOpen = id === 'queue';
    controlButton.setAttribute('aria-pressed', String(panelOpen));
  });

  // A file opened outside the queue (picker, single drop, Continue watching) resets the queue to it.
  ctx.on('ui:media-loaded', ({ name }) => {
    if (expected && expected.name === name) return;
    items = [{ name, path: name, external: true }];
    subtitles = [];
    siblings = [];
    order = createOrder(1, { repeat: order.repeat });
    publish();
  });

  ctx.on('playback:ended', () => {
    advance({ auto: true }).catch(error => ctx.surface('playback', error));
  });

  /* ---------- commands ---------- */

  registry.handle('queue.open-folder', () => openFolder());
  registry.handle('queue.play', async ({ index }) => {
    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
      throw Object.assign(new RangeError(`queue.play needs an index from 0 to ${items.length - 1}.`), { code: 'ERR_COMMAND_INPUT' });
    }
    if (index === currentIndex(order) && items[index].external) await restartCurrent();
    else await openIndex(index);
    return snapshot();
  });
  registry.handle('queue.next', () => advance());
  registry.handle('queue.previous', () => goBack());
  registry.handle('queue.repeat', ({ mode }) => {
    if (mode !== undefined && !REPEAT_MODES.includes(mode)) {
      throw Object.assign(new TypeError(`queue.repeat mode must be one of ${REPEAT_MODES.join(', ')}.`), { code: 'ERR_COMMAND_INPUT' });
    }
    order = setRepeat(order, mode ?? cycleRepeat(order.repeat));
    publish();
    return snapshot();
  });
  registry.handle('queue.shuffle', ({ on }) => {
    order = setShuffle(order, typeof on === 'boolean' ? on : !order.shuffle);
    publish();
    return snapshot();
  });
  registry.handle('queue.read', () => snapshot());
  registry.handle('queue.panel', ({ open }) => {
    setPanel(typeof open === 'boolean' ? open : ctx.panels.current() !== 'queue');
    panelOpen = ctx.panels.current() === 'queue';
    return snapshot();
  });

  const screen = ctx.mounts.emptyActions.closest('section') || ctx.mounts.emptyActions.parentElement;
  screen.addEventListener('drop', onDrop, true);

  wireNakliOS();

  // Debug hook for checks/queue.mjs: page.file() Files cannot pass through a JSON command input.
  if (new URLSearchParams(location.search).get('dev') === '1') {
    globalThis.__reelQueue = Object.freeze({
      /* files: File[] or [{ file, path }]; builds the queue and plays the first item. */
      loadFiles(files) {
        const records = [...files].map(entry => {
          const file = entry instanceof File ? entry : entry.file;
          const path = entry instanceof File ? (file.webkitRelativePath ? stripRoot(file.webkitRelativePath) : file.name) : entry.path;
          return { name: file.name, path, file };
        });
        return loadRecords(records);
      },
    });
  }

  publish();
}
