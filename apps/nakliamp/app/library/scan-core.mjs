// Library scan pipeline.
//
// Walks a granted directory handle, parses tags, and writes the index. Kept
// separate from the worker adapter so the M1 scan gate can drive it directly
// with a synthetic directory handle: a handle carrying methods cannot be
// structured-cloned into a worker, so a worker-only pipeline is untestable.
//
// The pipeline writes to IndexedDB itself rather than returning records, so a
// caller only ever handles small progress messages.

import { readTags, titleFromName } from './metadata.mjs';
import {
  putTracks, deleteTracks, putArt, trackId, allTracks, indexHash,
  putPlaylists, allPlaylists, deletePlaylists,
} from './store.mjs';
import { isPlaylistPath, parsePlaylist } from './playlist.mjs';

// Deliberately broad. The engine and the browser decide what actually plays;
// this only decides what is worth opening. A file the ladder refuses becomes a
// named refusal at play time, which is more useful than never being listed.
const AUDIO = /\.(mp3|mp2|mpga|flac|m4a|m4b|m4r|mp4|aac|adts|ogg|oga|opus|spx|wav|wave|aif|aiff|aifc|caf|mka|mkv|weba|webm|3gp|amr|wma|ape|wv|mpc|tta|dsf|dff|alac|ac3|dts|au|snd|voc|ra|tak|shn)$/i;

// Batch writes so a large library is not one enormous transaction, and so
// progress is visible while the scan runs.
const BATCH = 50;

/**
 * Yield to the event loop so the scan stays responsive to a cancel request.
 * Cheap, and it keeps any single task well inside the long-task budget.
 */
const breathe = () => new Promise(resolve => setTimeout(resolve, 0));

/** Depth-first walk yielding [relativePath, fileHandle] for audio files only. */
async function* walk(directoryHandle, isCancelled, prefix = '', depth = 0) {
  if (depth > 12) return; // a symlink loop would otherwise never terminate
  const entries = [];
  for await (const [name, handle] of directoryHandle.entries()) entries.push([name, handle]);
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  for (const [name, handle] of entries) {
    if (isCancelled()) return;
    if (name.startsWith('.')) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') yield* walk(handle, isCancelled, path, depth + 1);
    else if (AUDIO.test(name) || isPlaylistPath(name)) yield [path, handle];
  }
}

/** Build one index record from a file, reusing the previous row when unchanged. */
async function record(path, handle, previous) {
  const file = await handle.getFile();
  const id = await trackId(path);

  // An unchanged file keeps its existing row, including its playback state.
  // This is what makes a rescan cheap and the index hash stable.
  if (previous && previous.size === file.size && previous.lastModified === file.lastModified) {
    return { record: null, id, unchanged: true };
  }

  const tags = await readTags(file);
  let artKey = null;
  if (tags.picture?.bytes?.length) {
    artKey = `${id}:art`;
    await putArt(artKey, new Blob([tags.picture.bytes], { type: tags.picture.mime }));
  }

  return {
    unchanged: false,
    id,
    record: {
      id,
      path,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      container: tags.container,
      title: tags.title ?? titleFromName(file.name),
      artist: tags.artist,
      album: tags.album,
      albumArtist: tags.albumArtist,
      trackNo: tags.trackNo,
      trackTotal: tags.trackTotal,
      discNo: tags.discNo,
      discTotal: tags.discTotal,
      year: tags.year,
      genre: tags.genre,
      durationS: tags.durationS,
      sampleRate: tags.sampleRate,
      channels: tags.channels,
      hasLyrics: Boolean(tags.lyrics?.text),
      artKey,
      // Playback state is carried forward so a rescan never forgets where you were.
      resumePositionS: previous?.resumePositionS ?? 0,
      playCount: previous?.playCount ?? 0,
      lastPlayedAt: previous?.lastPlayedAt ?? 0,
      bookmarked: previous?.bookmarked ?? 0,
      addedAt: previous?.addedAt || Date.now(),
    },
  };
}

/**
 * Scan `rootHandle` into the index.
 * `post` receives progress, per-file errors, and the final summary.
 * `isCancelled` is polled between files so a cancel lands promptly.
 */
export async function scanFolder(rootHandle, { post = () => {}, isCancelled = () => false } = {}) {
  const started = Date.now();
  const existing = new Map((await allTracks()).map(track => [track.path, track]));
  const existingPlaylists = new Set((await allPlaylists()).map(playlist => playlist.path));
  const seen = new Set();
  const seenPlaylists = new Set();
  const pending = [];
  const pendingPlaylists = [];
  let scanned = 0;
  let updated = 0;
  let failed = 0;
  let playlists = 0;

  const flush = async () => {
    if (pending.length) updated += await putTracks(pending.splice(0, pending.length));
    if (pendingPlaylists.length) await putPlaylists(pendingPlaylists.splice(0, pendingPlaylists.length));
  };

  for await (const [path, handle] of walk(rootHandle, isCancelled)) {
    if (isCancelled()) break;
    if (isPlaylistPath(path)) {
      seenPlaylists.add(path);
      try {
        const file = await handle.getFile();
        pendingPlaylists.push(parsePlaylist(await file.text(), path));
        playlists += 1;
      } catch (error) {
        failed += 1;
        post({ type: 'file-error', path, message: String(error?.message ?? error) });
      }
      scanned += 1;
      continue;
    }
    seen.add(path);
    try {
      const result = await record(path, handle, existing.get(path));
      if (result.record) pending.push(result.record);
    } catch (error) {
      // One unreadable file must not end the scan. Name it and keep going.
      failed += 1;
      post({ type: 'file-error', path, message: String(error?.message ?? error) });
    }
    scanned += 1;
    if (pending.length >= BATCH) {
      await flush();
      post({ type: 'progress', scanned, updated, failed });
      await breathe();
    } else if (scanned % 10 === 0) {
      post({ type: 'progress', scanned, updated, failed });
      await breathe();
    }
  }
  await flush();

  // Anything the walk did not see is gone from disk, so it leaves the index.
  let removed = 0;
  if (!isCancelled()) {
    const missing = [...existing.keys()].filter(path => !seen.has(path));
    removed = await deleteTracks(missing.map(path => existing.get(path).id));
    await deletePlaylists([...existingPlaylists].filter(path => !seenPlaylists.has(path)));
  }

  const tracks = await allTracks();
  // The hash goes out in the summary, which is where callers read it. It used
  // to be written to a `lastScan` meta record as well, which nothing read.
  const hash = await indexHash(tracks);

  const summary = {
    type: 'done',
    cancelled: isCancelled(),
    scanned,
    updated,
    removed,
    failed,
    playlists,
    tracks: tracks.length,
    hash,
    durationMs: Date.now() - started,
  };
  post(summary);
  return summary;
}

