// Library scan pipeline.
//
// Walks a granted directory handle, parses tags, and writes the index. Kept
// separate from the worker adapter so the M1 scan gate can drive it directly
// with a synthetic directory handle: a handle carrying methods cannot be
// structured-cloned into a worker, so a worker-only pipeline is untestable.
//
// The pipeline writes to IndexedDB itself rather than returning records, so a
// caller only ever handles small progress messages.

import { readTags, titleFromName, PARSER_VERSION } from './metadata.mjs';
import {
  putTracks, deleteTracks, putArt, getArtStamp, trackId, allTracks, indexHash,
  putPlaylists, allPlaylists, deletePlaylists, putSmartPlaylists,
} from './store.mjs';
import { isPlaylistPath, parsePlaylist } from './playlist.mjs';
import { isSmartPath, parseSmart } from './smart.mjs';
import { isCuePath, decodeCueBytes, planCueRecords } from './cue.mjs';
import { libraryPath, inFolder } from './folders.mjs';

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

// Folder art (T3). The research found no naming standard, so these are the
// common names, in this order of preference, each with any of these types.
const ART_BASES = Object.freeze(['cover', 'folder', 'front', 'album']);
const ART_EXTENSIONS = Object.freeze(['jpg', 'jpeg', 'png', 'webp']);
const ART_MIME = Object.freeze({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });
// A folder image bigger than this is a scan or a poster, not a cover; skip it.
const MAX_FOLDER_ART_BYTES = 8 * 1024 * 1024;

/**
 * Pick the folder-art file among a directory's file names, or null.
 * Case-insensitive; preference follows ART_BASES then ART_EXTENSIONS.
 */
export function pickFolderArt(names) {
  let best = null;
  let bestRank = Infinity;
  for (const name of names) {
    const match = /^([^.]+)\.([a-z0-9]+)$/i.exec(String(name));
    if (!match) continue;
    const base = ART_BASES.indexOf(match[1].toLowerCase());
    const extension = ART_EXTENSIONS.indexOf(match[2].toLowerCase());
    if (base < 0 || extension < 0) continue;
    const rank = base * ART_EXTENSIONS.length + extension;
    if (rank < bestRank) { best = name; bestRank = rank; }
  }
  return best;
}

/** The MIME type for a folder-art file name. */
export function folderArtMime(name) {
  return ART_MIME[String(name).split('.').pop().toLowerCase()] ?? 'image/jpeg';
}

/**
 * Whether a previously indexed file must be parsed again: it changed on disk,
 * or it was read by an older parser than this one.
 */
export function needsReparse(previous, file, parserVersion = PARSER_VERSION) {
  if (!previous) return true;
  if (previous.size !== file.size || previous.lastModified !== file.lastModified) return true;
  return (previous.parserVersion ?? 0) < parserVersion;
}

const compareNames = ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0);
const joinPath = (prefix, name) => (prefix ? `${prefix}/${name}` : name);

/** The directory's cover image as `{ path, handle }`, or null. */
function folderArtOf(entries, prefix) {
  const artName = pickFolderArt(entries.filter(([, handle]) => handle.kind !== 'directory').map(([name]) => name));
  if (!artName) return null;
  return { path: joinPath(prefix, artName), handle: entries.find(([name]) => name === artName)[1] };
}

/**
 * Whether the walk yields a file. Smart playlists live in the primary folder's
 * root only (L13): one place for rules, so scanning a second folder never
 * replaces them.
 */
function isWalkTarget(name, primary, depth) {
  if (AUDIO.test(name) || isPlaylistPath(name) || isCuePath(name)) return true;
  return primary && depth === 0 && isSmartPath(name);
}

/**
 * Depth-first walk yielding [relativePath, fileHandle, folderArt] for audio
 * files and playlists. `folderArt` is `{ path, handle }` for the directory's
 * cover image, or null; the walk already lists every directory, so finding it
 * costs no extra reads.
 */
async function* walk(directoryHandle, isCancelled, prefix = '', depth = 0, primary = true) {
  if (depth > 12) return; // a symlink loop would otherwise never terminate
  const entries = [];
  for await (const [name, handle] of directoryHandle.entries()) entries.push([name, handle]);
  entries.sort(compareNames);
  const folderArt = folderArtOf(entries, prefix);

  for (const [name, handle] of entries) {
    if (isCancelled()) return;
    if (name.startsWith('.')) continue;
    const path = joinPath(prefix, name);
    if (handle.kind === 'directory') yield* walk(handle, isCancelled, path, depth + 1, primary);
    else if (isWalkTarget(name, primary, depth)) yield [path, handle, folderArt];
  }
}

/** Playback state carried from the previous row, so a rescan never forgets where you were. */
function carriedState(previous, tags) {
  return {
    ...carriedCounters(previous),
    addedAt: previous?.addedAt || Date.now(),
    // A rating set in NakliAmp wins; the file's own rating tag seeds it.
    rating: previous?.rating || tags.rating || 0,
  };
}

const CARRIED_COUNTERS = Object.freeze(['resumePositionS', 'playCount', 'lastPlayedAt', 'bookmarked']);

/** Resume position, play count, last play and bookmark, each defaulting to 0. */
function carriedCounters(previous) {
  return Object.fromEntries(CARRIED_COUNTERS.map(field => [field, previous?.[field] ?? 0]));
}

/** The fields read straight from the file's tags. */
function tagFields(tags, file) {
  return {
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
  };
}

/** An unchanged file keeps its row; only a moved folder-art key needs a write. */
function unchangedRecord(previous, id, dirArtKey) {
  if ((previous.dirArtKey ?? null) !== dirArtKey) return { record: { ...previous, dirArtKey }, id, unchanged: true, current: { ...previous, dirArtKey } };
  return { record: null, id, unchanged: true, current: previous };
}

/** Store the embedded picture, if any, and return its art key or null. */
async function storeEmbeddedArt(tags, id) {
  if (!tags.picture?.bytes?.length) return null;
  const artKey = `${id}:art`;
  await putArt(artKey, new Blob([tags.picture.bytes], { type: tags.picture.mime }));
  return artKey;
}

/** Build one index record from a file, reusing the previous row when unchanged. */
async function record(path, handle, previous, dirArtKey) {
  const file = await handle.getFile();
  const id = await trackId(path);

  // An unchanged file keeps its existing row, including its playback state.
  // This is what makes a rescan cheap and the index hash stable. Only its
  // folder art may move, which is a small row update and no tag read.
  if (!needsReparse(previous, file)) return unchangedRecord(previous, id, dirArtKey);

  const tags = await readTags(file);
  const artKey = await storeEmbeddedArt(tags, id);

  const fresh = {
    unchanged: false,
    id,
    // A cue sheet embedded in the file's tags (P12), when the reader exposes one.
    cuesheet: typeof tags.cuesheet === 'string' ? tags.cuesheet : null,
    record: {
      id,
      path,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      ...tagFields(tags, file),
      artKey,
      ...carriedState(previous, tags),
      replayGain: tags.replayGain,
      dirArtKey,
      parserVersion: PARSER_VERSION,
      // The cue pass below decides this each scan; carried until it runs.
      hidden: previous?.hidden ?? 0,
    },
  };
  fresh.current = fresh.record;
  return fresh;
}

const errorText = error => String(error?.message ?? error);

/** Count a failed file and report it by path. */
function fileFailed(scan, path, error) {
  scan.failed += 1;
  scan.post({ type: 'file-error', path, message: errorText(error) });
}

/**
 * Folder art is read once per directory per scan, and skipped when its size
 * and time match what is already stored.
 */
async function folderArtKey(scan, folderArt) {
  if (!folderArt) return null;
  if (scan.folderArtKeys.has(folderArt.path)) return scan.folderArtKeys.get(folderArt.path);
  let key = null;
  try {
    key = await storeFolderArt(scan, folderArt);
  } catch (error) {
    key = null;
    scan.post({ type: 'file-error', path: folderArt.path, message: errorText(error) });
  }
  scan.folderArtKeys.set(folderArt.path, key);
  return key;
}

async function storeFolderArt(scan, folderArt) {
  const image = await folderArt.handle.getFile();
  if (!(image.size > 0 && image.size <= MAX_FOLDER_ART_BYTES)) return null;
  const key = `${await trackId(`dir-art:${scan.toPath(folderArt.path)}`)}:dirart`;
  const stamp = `${image.size}:${image.lastModified}`;
  if (await getArtStamp(key) !== stamp) {
    await putArt(key, new Blob([await image.arrayBuffer()], { type: folderArtMime(folderArt.path) }), stamp);
  }
  return key;
}

async function flush(scan) {
  if (scan.pending.length) scan.updated += await putTracks(scan.pending.splice(0, scan.pending.length));
  if (scan.pendingPlaylists.length) await putPlaylists(scan.pendingPlaylists.splice(0, scan.pendingPlaylists.length));
}

/** A `.cue` file is read during the walk and applied after it (P12). */
async function scanCueFile(scan, path, handle) {
  try {
    const file = await handle.getFile();
    if (file.size <= 512 * 1024) scan.cues.push({ path, text: decodeCueBytes(new Uint8Array(await file.arrayBuffer())) });
    else scan.post({ type: 'file-error', path, message: 'The cue sheet is larger than 512 KB.' });
  } catch (error) {
    fileFailed(scan, path, error);
  }
}

async function scanSmartFile(scan, path, handle) {
  try {
    const file = await handle.getFile();
    scan.smart.push({ path, rule: parseSmart(await file.text()) });
  } catch (error) {
    fileFailed(scan, path, error);
  }
  scan.scanned += 1;
}

async function scanPlaylistFile(scan, path, relative, handle) {
  scan.seenPlaylists.add(path);
  try {
    const file = await handle.getFile();
    // Entries resolve against the folder's own root, then take its prefix.
    // Bytes, not text: a legacy .m3u in Windows-1252 decodes exactly and is written back in
    // its own code page; lastModified and size let a rewrite see an outside change (N10, N11).
    const parsed = parsePlaylist(new Uint8Array(await file.arrayBuffer()), relative, { lastModified: file.lastModified, size: file.size });
    scan.pendingPlaylists.push(scan.primary ? parsed : {
      ...parsed,
      path,
      entries: parsed.entries.map(entry => ({ ...entry, path: entry.path === null ? null : scan.toPath(entry.path) })),
    });
    scan.playlists += 1;
  } catch (error) {
    fileFailed(scan, path, error);
  }
  scan.scanned += 1;
}

function noteRecordResult(scan, path, result) {
  if (result.record) scan.pending.push(result.record);
  if (result.current) scan.current.set(path, result.current);
  if (result.unchanged) scan.unchangedParents.add(path);
  if (result.cuesheet) scan.embeddedCues.push({ parentPath: path, text: result.cuesheet });
}

async function scanAudioFile(scan, path, handle, folderArt) {
  scan.seen.add(path);
  try {
    const result = await record(path, handle, scan.existing.get(path), await folderArtKey(scan, folderArt));
    noteRecordResult(scan, path, result);
  } catch (error) {
    // One unreadable file must not end the scan. Name it and keep going.
    fileFailed(scan, path, error);
  }
  scan.scanned += 1;
  if (scan.pending.length >= BATCH) {
    await flush(scan);
    await reportProgress(scan);
  } else if (scan.scanned % 10 === 0) {
    await reportProgress(scan);
  }
}

async function reportProgress(scan) {
  scan.post({ type: 'progress', scanned: scan.scanned, updated: scan.updated, failed: scan.failed });
  await breathe();
}

/** Route one walked file to the reader for its kind. */
async function scanEntry(scan, relative, handle, folderArt) {
  const path = scan.toPath(relative);
  if (isCuePath(relative)) return scanCueFile(scan, path, handle);
  if (scan.primary && isSmartPath(relative)) return scanSmartFile(scan, path, handle);
  if (isPlaylistPath(path)) return scanPlaylistFile(scan, path, relative, handle);
  return scanAudioFile(scan, path, handle, folderArt);
}

/** Whether a stored virtual row already matches the planned one, field by field. */
function sameVirtual(old, virtual) {
  return Boolean(old) && Object.keys(virtual).every(key => JSON.stringify(old[key] ?? null) === JSON.stringify(virtual[key] ?? null));
}

/** P12: cue sheets become virtual tracks; their parents are flagged hidden. Returns the cue track count. */
async function applyCueSheets(scan) {
  const { existing, current, seen, pending } = scan;
  const previousVirtual = new Map([...existing].filter(([, track]) => track.virtual));
  const plan = planCueRecords({ cues: scan.cues, embedded: scan.embeddedCues, records: current, previous: previousVirtual, unchangedParents: scan.unchangedParents });
  for (const error of plan.errors) scan.post({ type: 'file-error', ...error });
  for (const virtual of plan.virtual) {
    seen.add(virtual.path);
    // A sheet re-read every scan rewrites nothing when its tracks match.
    if (!sameVirtual(existing.get(virtual.path), virtual)) pending.push({ ...virtual, id: await trackId(virtual.path) });
  }
  for (const path of plan.keep) seen.add(path);
  // Parents whose hidden flag changed get one small row update.
  for (const [path, track] of current) {
    const hidden = plan.hidden.has(path) ? 1 : 0;
    if ((track.hidden ?? 0) !== hidden) pending.push({ ...track, hidden });
  }
  await flush(scan);
  return plan.virtual.length + plan.keep.size;
}

/** Anything the walk did not see is gone from disk, so it leaves the index. Returns the count removed. */
async function removeMissing(scan) {
  const { existing, seen } = scan;
  const missing = [...existing.keys()].filter(path => !seen.has(path));
  const removed = await deleteTracks(missing.map(path => existing.get(path).id));
  await deletePlaylists([...scan.existingPlaylists].filter(path => !scan.seenPlaylists.has(path)));
  // Smart playlists are only replaced by a complete walk, so a cancel never
  // makes rules disappear.
  if (scan.primary) await putSmartPlaylists(scan.smart.sort((left, right) => (left.path < right.path ? -1 : 1)));
  return removed;
}

/** The per-scan state every step reads and updates. */
async function startScan(post, folderId) {
  // L13: a scan only sees, and only removes, records of its own folder.
  // `folderId` null is the primary folder, whose paths are unprefixed, so a
  // one-folder library scans exactly as before.
  const primary = folderId === null || folderId === undefined;
  const scope = primary ? null : folderId;
  const scoped = path => inFolder(path, scope);
  return {
    post,
    primary,
    toPath: relative => libraryPath(scope, relative),
    existing: new Map((await allTracks()).filter(track => scoped(track.path)).map(track => [track.path, track])),
    existingPlaylists: new Set((await allPlaylists()).map(playlist => playlist.path).filter(scoped)),
    seen: new Set(),
    seenPlaylists: new Set(),
    pending: [],
    pendingPlaylists: [],
    scanned: 0,
    updated: 0,
    failed: 0,
    playlists: 0,
    smart: [],
    // P12: cue sheets are read during the walk and applied after it, because a
    // sheet may sort before the image it describes.
    cues: [],
    embeddedCues: [],
    current: new Map(),
    unchangedParents: new Set(),
    folderArtKeys: new Map(),
  };
}

/**
 * Scan `rootHandle` into the index.
 * `post` receives progress, per-file errors, and the final summary.
 * `isCancelled` is polled between files so a cancel lands promptly.
 */
export async function scanFolder(rootHandle, { post = () => {}, isCancelled = () => false, folderId = null } = {}) {
  const started = Date.now();
  const scan = await startScan(post, folderId);

  for await (const [relative, handle, folderArt] of walk(rootHandle, isCancelled, '', 0, scan.primary)) {
    if (isCancelled()) break;
    await scanEntry(scan, relative, handle, folderArt);
  }
  await flush(scan);

  const cueTracks = isCancelled() ? 0 : await applyCueSheets(scan);
  const removed = isCancelled() ? 0 : await removeMissing(scan);

  const tracks = await allTracks();
  // The hash goes out in the summary, which is where callers read it. It used
  // to be written to a `lastScan` meta record as well, which nothing read.
  const hash = await indexHash(tracks);

  const summary = {
    type: 'done',
    cancelled: isCancelled(),
    scanned: scan.scanned,
    updated: scan.updated,
    removed,
    failed: scan.failed,
    playlists: scan.playlists,
    smartPlaylists: scan.smart.length,
    cueTracks,
    folderId: scan.primary ? null : folderId,
    tracks: tracks.length,
    hash,
    durationMs: Date.now() - started,
  };
  post(summary);
  return summary;
}
