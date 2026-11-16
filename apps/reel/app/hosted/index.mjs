/* Reel feature module: hosted (batch 3). Contract: docs/build/reel-v1-contract.md, "Batch 3".
 * No DOM access at module top level, so Node can import COMMANDS for commands.json.
 *
 * When NakliOS hosts Reel with storage (`naklios.capabilities.fs`), media opens through `naklios.fs`
 * instead of a folder picker (a cross-origin iframe cannot call showDirectoryPicker). Videos play
 * through ranged readers over `naklios.fs.readBinary(path, { offset, maxBytes })`: aligned chunks of
 * 4 MiB (the host allows 16 MiB a call) and a shared cache of 8 chunks. Media bytes stay on the
 * device and are never copied into OPFS, IndexedDB or a Blob of the whole file. Without range
 * reads (Crate today), files up to 64 MB play from one bounded read and larger ones are refused by
 * name. The store this module builds is shared with the queue and library through
 * app/queue/shared.mjs, so "Open folder…" and the library read NakliOS storage too. */

import { classify, comparePaths, dirOf, isSubtitleName, extensionOf } from '../queue/logic.mjs';
import { setHostStore, hostStore, queueSource } from '../queue/shared.mjs';
import {
  WHOLE_READ_LIMIT, SUBTITLE_LIMIT, MAX_READ_BYTES,
  bytesOf, createChunkCache, createChunkReader, createBufferReader, walkListing, formatBytes,
} from './logic.mjs';

export const COMMANDS = [
  { name: 'hosted.list', label: 'NakliOS files', scope: 'read',
    description: 'Read the videos and subtitle files in Reel\'s NakliOS storage under `path` ("" or no path is the top): each with its path and kind, the folders that hold videos, the storage location, whether it streams by ranged reads, whether the list is open and the hosted path playing now. Standalone it reports available false.',
    input: { type: 'object', properties: { path: { type: 'string', description: 'Folder path in Reel\'s NakliOS storage' } }, required: [] } },
  { name: 'hosted.open', label: 'Open from NakliOS', scope: 'write', readTwin: 'hosted.list',
    description: 'Play the video at `path` in Reel\'s NakliOS storage, queueing the videos of its folder with their subtitle files. A subtitle path loads that file for the video playing now.',
    input: { type: 'object', properties: { path: { type: 'string', description: 'File path from hosted.list' } }, required: ['path'] } },
  { name: 'hosted.panel', label: 'NakliOS file list', scope: 'write', readTwin: 'hosted.list',
    description: 'Open or close the list of videos in Reel\'s NakliOS storage; with no input it toggles.',
    input: { type: 'object', properties: { open: { type: 'boolean' } }, required: [] } },
];

export const STRINGS = {
  'hosted.button': 'Open from NakliOS…',
  'hosted.title': 'Open from NakliOS',
  'hosted.close': 'Close the NakliOS file list',
  'hosted.loading': 'Reading NakliOS storage…',
  'hosted.empty': 'No videos Reel can play in this NakliOS storage. Reel plays {formats}.',
  'hosted.count': '{count} videos',
  'hosted.truncated': 'Reel listed the first {count} files only',
  'hosted.top': 'Top level',
  'hosted.playFolder': 'Play folder',
  'hosted.playFolder.label': 'Play every video in {folder}',
  'hosted.play': 'Play {name}',
  'hosted.subtitles': 'Subtitles: {names}',
  'hosted.list': 'Videos in NakliOS storage',
  'hosted.location': 'Location: {name}',
  'hosted.streaming': 'streams by ranged reads',
  'hosted.whole': 'plays files up to {limit} from one read',
  'hosted.unavailable': 'NakliOS storage is not available. Reel opens NakliOS files only when NakliOS hosts it with storage connected.',
  'hosted.tooLarge': '{backend} cannot stream video: {name} is {size}. Reel plays files up to {limit} from {backend}. Move it to a Folder location in NakliOS to play it.',
  'hosted.sizeUnknown': '{backend} gives no size for {name}, so Reel cannot read it safely.',
  'hosted.missing': 'No file at {path} in Reel\'s NakliOS storage',
  'hosted.notPlayable': 'Reel cannot play {name}. Reel plays {formats}.',
  'hosted.subtitleTooLarge': '{name} is {size}; Reel reads subtitle files up to {limit}.',
  'hosted.subtitleNoVideo': 'Open a video before loading the subtitle file {name}.',
};

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.ts': 'video/mp2t', '.srt': 'text/plain', '.vtt': 'text/vtt',
  '.ass': 'text/plain', '.ssa': 'text/plain',
};

const baseName = path => String(path).split('/').pop();
const coded = (message, code) => Object.assign(new Error(message), { code });

/* The NakliOS store over one bridge: walk, ranged readers for videos and bounded reads for subtitles. */
function createStore(ctx, bridge) {
  const { t } = ctx;
  const fs = bridge.fs;
  const caps = () => bridge.capabilities || {};
  const cache = createChunkCache();
  let whole = null; // { key, reader }: the last file read in one piece (no ranged reads)
  const keep = name => isSubtitleName(name) || ctx.supportsPlayback({ name, type: '' });

  function backendLabel() {
    const { fsBackend, fsBackends } = caps();
    const entry = Array.isArray(fsBackends) ? fsBackends.find(item => item?.id === fsBackend) : null;
    return entry?.label || (fsBackend === 'crate' ? 'Crate' : fsBackend === 'fsa' ? 'Folder' : 'NakliOS storage');
  }

  async function statFile(path) {
    const info = await fs.stat(path);
    if (!info || info.type === 'dir') throw coded(t('hosted.missing', { path }), 'ERR_HOSTED_MISSING');
    return info;
  }

  return {
    /* Drops cached chunks and the one-piece buffer (V58): called when the video closes. */
    release() { cache.clear(); whole = null; },
    get label() { return backendLabel(); },
    get rangeReads() { return caps().fsRangeReads === true; },
    walk(prefix = '') { return walkListing(dir => fs.list(dir), keep, { prefix }); },

    async reader(path) {
      const name = baseName(path);
      const type = MIME[extensionOf(name)] || '';
      const info = await statFile(path);
      const size = info.size;
      const stamp = String(info.mtimeMs ?? '');
      const backend = backendLabel();
      if (caps().fsRangeReads === true) {
        if (!Number.isSafeInteger(size)) throw coded(t('hosted.sizeUnknown', { backend, name }), 'ERR_HOSTED_SIZE');
        // Without a modification time the cache key cannot tell a rewritten file of the same size
        // from the old one, so a new reader drops that path's cached chunks (V59).
        if (!stamp) cache.dropPath(path);
        return createChunkReader({
          path, name, size, type, stamp, cache,
          readChunk: (offset, maxBytes) => fs.readBinary(path, { offset, maxBytes }),
        });
      }
      const limit = formatBytes(WHOLE_READ_LIMIT);
      const tooLarge = bytes => coded(t('hosted.tooLarge', { backend, name, size: formatBytes(bytes), limit }), 'ERR_HOSTED_TOO_LARGE');
      if (Number.isSafeInteger(size) && size > WHOLE_READ_LIMIT) throw tooLarge(size);
      const bounded = fs.supportsBoundedReads === true;
      if (!Number.isSafeInteger(size) && !bounded) throw coded(t('hosted.sizeUnknown', { backend, name }), 'ERR_HOSTED_SIZE');
      const key = `${path}\0${size}\0${stamp}`;
      if (stamp && whole?.key === key) return whole.reader;
      whole = null;
      const bytes = bytesOf(await fs.readBinary(path, bounded ? { maxBytes: WHOLE_READ_LIMIT + 1 } : undefined));
      if (bytes.byteLength > WHOLE_READ_LIMIT) throw tooLarge(bytes.byteLength);
      const reader = createBufferReader({ path, name, type, bytes });
      whole = { key, reader };
      return reader;
    },

    async file(path) {
      const name = baseName(path);
      const info = await statFile(path);
      const limit = formatBytes(SUBTITLE_LIMIT);
      if (Number.isSafeInteger(info.size) && info.size > SUBTITLE_LIMIT) {
        throw coded(t('hosted.subtitleTooLarge', { name, size: formatBytes(info.size), limit }), 'ERR_HOSTED_TOO_LARGE');
      }
      let options;
      if (caps().fsRangeReads === true && Number.isSafeInteger(info.size)) options = { offset: 0, maxBytes: Math.min(info.size, MAX_READ_BYTES) };
      else if (fs.supportsBoundedReads === true) options = { maxBytes: SUBTITLE_LIMIT + 1 };
      const bytes = bytesOf(await fs.readBinary(path, options));
      if (bytes.byteLength > SUBTITLE_LIMIT) {
        throw coded(t('hosted.subtitleTooLarge', { name, size: formatBytes(bytes.byteLength), limit }), 'ERR_HOSTED_TOO_LARGE');
      }
      return new File([bytes], name, { type: MIME[extensionOf(name)] || 'text/plain' });
    },
  };
}

let activeSetup = null;

/* Re-reads the NakliOS bridge: shows "Open from NakliOS…" and sets the store when `naklios.fs` is
 * available, else hides both. install() calls it; the ?dev=1 hook calls it again after a check
 * installs a fake `globalThis.naklios`. */
export function setup() {
  return activeSetup ? activeSetup() : Promise.resolve({ available: false });
}

export function install(ctx) {
  const { registry, store, t } = ctx;
  let bridge = null;
  let listing = null;      // { path, records, truncated } from the last panel or hosted.list read
  let listingError = null;
  let loading = false;
  const subscribed = new WeakSet();

  const run = (name, input) => Promise.resolve(registry.run(name, input)).catch(error => ctx.surface('file-open', error));
  const available = () => !!hostStore() && !!bridge;

  /* ---------- UI ---------- */

  ctx.addStyle(`
    .hosted-dialog{width:min(720px,94vw);max-height:88vh;padding:0;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface-2);color:var(--text)}
    .hosted-dialog::backdrop{background:rgba(0,0,0,.6)}
    .hosted-head{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line)}
    .hosted-head h2{font-size:15px;font-weight:600;flex:1}
    .hosted-body{padding:12px 16px;overflow:auto;max-height:calc(88vh - 60px)}
    .hosted-meta{color:var(--dim);font-size:12px;margin:0 0 10px}
    .hosted-folders{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}
    .hosted-folder-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
    .hosted-folder-head strong{font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .hosted-files{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
    .hosted-files button{width:100%;text-align:left;padding:6px 8px;border-radius:6px;background:none;border:1px solid transparent;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .hosted-files button:hover{color:var(--text);border-color:var(--line)}
    .hosted-dialog button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
    .hosted-subs{color:var(--dim);font-size:12px;margin:2px 8px 0}
  `);

  const startButton = document.createElement('button');
  startButton.type = 'button';
  startButton.hidden = true;
  startButton.dataset.hosted = 'open';
  startButton.dataset.command = 'hosted.panel';
  startButton.addEventListener('click', () => run('hosted.panel', { open: true }));
  ctx.mounts.emptyActions.append(startButton);

  const dialog = document.createElement('dialog');
  dialog.className = 'hosted-dialog';
  dialog.dataset.hosted = 'dialog';
  dialog.setAttribute('aria-labelledby', 'hosted-title');
  const head = document.createElement('header');
  head.className = 'hosted-head';
  const title = document.createElement('h2');
  title.id = 'hosted-title';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.dataset.command = 'hosted.panel';
  closeButton.textContent = '✕';
  closeButton.addEventListener('click', () => run('hosted.panel', { open: false }));
  head.append(title, closeButton);
  const body = document.createElement('div');
  body.className = 'hosted-body';
  const meta = document.createElement('p');
  meta.className = 'hosted-meta';
  const status = document.createElement('p');
  status.className = 'hosted-meta';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const folders = document.createElement('ul');
  folders.className = 'hosted-folders';
  body.append(meta, status, folders);
  dialog.append(head, body);
  ctx.mounts.dialogs.append(dialog);
  // Keys stay inside the list, so the player's shortcuts do not fire behind it (Escape closes it).
  dialog.addEventListener('keydown', event => event.stopPropagation());

  function groups() {
    const { videos, subtitles } = classify(listing?.records || [], record => ctx.supportsPlayback({ name: record.name, type: '' }));
    const byFolder = new Map();
    for (const video of videos) {
      const dir = dirOf(video.path);
      if (!byFolder.has(dir)) byFolder.set(dir, { dir, videos: [], subtitles: [] });
      byFolder.get(dir).videos.push(video);
    }
    for (const sub of subtitles) byFolder.get(dirOf(sub.path))?.subtitles.push(sub);
    return [...byFolder.values()].sort((a, b) => comparePaths(a.dir, b.dir));
  }

  function render() {
    startButton.hidden = !available();
    startButton.textContent = t('hosted.button');
    title.textContent = t('hosted.title');
    closeButton.setAttribute('aria-label', t('hosted.close'));
    folders.setAttribute('aria-label', t('hosted.list'));
    const host = hostStore();
    meta.textContent = host
      ? `${t('hosted.location', { name: host.label })} · ${host.rangeReads ? t('hosted.streaming') : t('hosted.whole', { limit: formatBytes(WHOLE_READ_LIMIT) })}`
      : t('hosted.unavailable');
    if (!dialog.open) return;
    const list = groups();
    const count = list.reduce((sum, group) => sum + group.videos.length, 0);
    status.textContent = loading ? t('hosted.loading')
      : listingError ? String(listingError.message || listingError)
        : count ? [t('hosted.count', { count }), listing?.truncated ? t('hosted.truncated', { count: listing.records.length }) : ''].filter(Boolean).join(' · ')
          : t('hosted.empty', { formats: ctx.videoExtensions().join(' ') });
    const focused = dialog.contains(document.activeElement) ? document.activeElement.dataset.path : null;
    folders.replaceChildren(...list.map(group => {
      const li = document.createElement('li');
      const folderHead = document.createElement('div');
      folderHead.className = 'hosted-folder-head';
      const label = document.createElement('strong');
      label.textContent = group.dir || t('hosted.top');
      const play = document.createElement('button');
      play.type = 'button';
      play.dataset.command = 'queue.open-folder';
      play.dataset.path = `${group.dir}/`;
      play.textContent = t('hosted.playFolder');
      play.setAttribute('aria-label', t('hosted.playFolder.label', { folder: group.dir || t('hosted.top') }));
      play.addEventListener('click', () => {
        setOpen(false);
        run('queue.open-folder', { path: group.dir });
      });
      folderHead.append(label, play);
      const files = document.createElement('ul');
      files.className = 'hosted-files';
      for (const video of group.videos) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.command = 'hosted.open';
        button.dataset.path = video.path;
        button.textContent = video.name;
        button.title = video.path;
        button.setAttribute('aria-label', t('hosted.play', { name: video.name }));
        button.addEventListener('click', () => {
          setOpen(false);
          run('hosted.open', { path: video.path });
        });
        item.append(button);
        files.append(item);
      }
      li.append(folderHead, files);
      if (group.subtitles.length) {
        const subs = document.createElement('p');
        subs.className = 'hosted-subs';
        subs.textContent = t('hosted.subtitles', { names: group.subtitles.map(sub => sub.name).join(', ') });
        li.append(subs);
      }
      return li;
    }));
    if (focused) [...dialog.querySelectorAll('button[data-path]')].find(button => button.dataset.path === focused)?.focus({ preventScroll: true });
  }

  /* ---------- data ---------- */

  function requireStore() {
    const host = hostStore();
    if (!host || !bridge) throw coded(t('hosted.unavailable'), 'ERR_HOSTED_UNAVAILABLE');
    return host;
  }

  async function refreshListing(path = '') {
    const host = requireStore();
    loading = true;
    listingError = null;
    render();
    try {
      const { records, truncated } = await host.walk(path);
      listing = { path, records, truncated };
    } catch (error) {
      listingError = error;
      throw error;
    } finally {
      loading = false;
      render();
    }
    return listing;
  }

  /* The hosted path playing now: the queue's current item when it came from NakliOS storage. */
  function currentPath() {
    const source = queueSource();
    const name = store.media?.name;
    const current = store.ui.queue?.current;
    const item = Number.isInteger(current) ? source.items[current] : null;
    return item?.hosted && item.name === name ? item.path : null;
  }

  function snapshot(view = listing) {
    const host = hostStore();
    const { videos, subtitles } = classify(view?.records || [], record => ctx.supportsPlayback({ name: record.name, type: '' }));
    return {
      available: available(),
      location: host?.label ?? null,
      rangeReads: host?.rangeReads ?? false,
      path: view?.path ?? null,
      entries: [
        ...videos.map(record => ({ path: record.path, name: record.name, kind: 'video' })),
        ...subtitles.map(record => ({ path: record.path, name: record.name, kind: 'subtitle' })),
      ],
      folders: [...new Set(videos.map(video => dirOf(video.path)))].sort(comparePaths),
      truncated: view?.truncated ?? false,
      panelOpen: dialog.open,
      current: currentPath(),
    };
  }

  async function setOpen(open) {
    if (open === dialog.open) return;
    if (!open) { dialog.close(); return; }
    requireStore();
    dialog.showModal();
    render();
    closeButton.focus({ preventScroll: true });
    try {
      await refreshListing('');
    } catch (error) {
      ctx.surface('file-open', error);
    }
    (dialog.querySelector('.hosted-files button') || closeButton).focus({ preventScroll: true });
  }

  async function openPath(path) {
    const host = requireStore();
    const clean = String(path).replace(/^\/+|\/+$/g, '');
    const name = baseName(clean);
    if (isSubtitleName(name)) {
      if (!store.media?.name) throw coded(t('hosted.subtitleNoVideo', { name }), 'ERR_COMMAND_INPUT');
      const file = await host.file(clean);
      ctx.Events.emit('queue:siblings', { videoName: store.media.name, files: [file] });
      return snapshot();
    }
    if (!ctx.supportsPlayback({ name, type: '' })) {
      throw coded(t('hosted.notPlayable', { name, formats: ctx.videoExtensions().join(' ') }), 'ERR_COMMAND_INPUT');
    }
    // Open the reader first, so a refusal (Crate and a large file) names the file before the queue changes.
    await host.reader(clean);
    await registry.run('queue.open-folder', { path: dirOf(clean), start: clean });
    return snapshot();
  }

  /* ---------- bridge ---------- */

  async function refreshBridge() {
    let next = null;
    try { next = await ctx.nakliosBridge(); } catch (_) { next = null; }
    bridge = next && next.fs && next.capabilities?.fs === true ? next : null;
    if (next && typeof next.onCapabilitiesChange === 'function' && !subscribed.has(next)) {
      subscribed.add(next);
      try { next.onCapabilitiesChange(() => { refreshBridge().catch(() => {}); }); } catch (_) { /* older SDK */ }
    }
    setHostStore(bridge ? createStore(ctx, bridge) : null);
    if (!bridge && dialog.open) dialog.close();
    listing = null;
    store.ui.hosted = { available: !!bridge };
    render();
    return { available: !!bridge };
  }

  activeSetup = refreshBridge;
  ctx.on('ui:media-cleared', () => hostStore()?.release?.());

  /* ---------- commands ---------- */

  // A read: it walks storage into its own result and leaves the open list as it is (V23).
  registry.handle('hosted.list', async ({ path } = {}) => {
    if (!available()) return snapshot();
    if (path !== undefined && typeof path !== 'string') throw coded('hosted.list path must be a string.', 'ERR_COMMAND_INPUT');
    const prefix = path || '';
    const { records, truncated } = await requireStore().walk(prefix);
    return snapshot({ path: prefix, records, truncated });
  });
  registry.handle('hosted.open', ({ path }) => {
    if (typeof path !== 'string' || !path.replace(/\//g, '')) throw coded('hosted.open needs a file path from hosted.list.', 'ERR_COMMAND_INPUT');
    return openPath(path);
  });
  registry.handle('hosted.panel', async ({ open } = {}) => {
    await setOpen(typeof open === 'boolean' ? open : !dialog.open);
    return snapshot();
  });

  if (new URLSearchParams(location.search).get('dev') === '1') {
    globalThis.__reelHosted = Object.freeze({ setup: () => setup() });
  }

  render();
  refreshBridge().catch(error => ctx.surface('file-open', error));
}
