// NakliAmp library index — IndexedDB persistence.
// Headless by contract: no DOM, no engine import, no network.
//
// The index is a cache. The folder on disk is the truth, and playlists are
// `.m3u8` files in that folder. Nothing here is authoritative; a lost database
// costs a rescan, never a track.
//
// Records are versioned and validated on ingress, so a schema change is a
// migration rather than a field that silently disappears.

const DATABASE = 'nakliamp';
const VERSION = 3;

// Schema 2 (v1 parity build) adds rating, replayGain, dirArtKey and
// parserVersion. Older rows validate into it with defaults, so no data moves.
export const TRACK_SCHEMA = 2;

const STORE_TRACKS = 'tracks';
const STORE_ART = 'art';
const STORE_META = 'meta';
const STORE_PLAYLISTS = 'playlists';
const STORE_LOUDNESS = 'loudness';

/** Fields that define index identity. The hash covers these and nothing else. */
const IDENTITY_FIELDS = Object.freeze([
  'path', 'size', 'container', 'title', 'artist', 'album', 'albumArtist',
  'trackNo', 'trackTotal', 'discNo', 'discTotal', 'year', 'genre',
  'durationS', 'sampleRate', 'channels',
]);

/** Playback state, which changes as you listen and must not perturb the hash. */
const MUTABLE_FIELDS = Object.freeze([
  'resumePositionS', 'playCount', 'lastPlayedAt', 'bookmarked', 'addedAt', 'rating',
]);

// Delimiters for composite keys and index-hash rows. These are declared as
// escapes, never written literally: a raw control character is invisible in a
// diff, and `scripts/verify-source-hygiene.mjs` fails the build if one appears.
const KEY_SEPARATOR = '\u001f';
const FIELD_SEPARATOR = '\u001f';
const ROW_SEPARATOR = '\u001e';

let openPromise = null;

function request(operation) {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

function finish(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Library transaction aborted.'));
  });
}

export function openLibrary() {
  openPromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, VERSION);
    open.onupgradeneeded = () => {
      const database = open.result;
      if (!database.objectStoreNames.contains(STORE_TRACKS)) {
        const tracks = database.createObjectStore(STORE_TRACKS, { keyPath: 'id' });
        tracks.createIndex('albumKey', 'albumKey', { unique: false });
        tracks.createIndex('artistKey', 'artistKey', { unique: false });
        tracks.createIndex('path', 'path', { unique: true });
        tracks.createIndex('bookmarked', 'bookmarked', { unique: false });
        tracks.createIndex('lastPlayedAt', 'lastPlayedAt', { unique: false });
      }
      if (!database.objectStoreNames.contains(STORE_ART)) database.createObjectStore(STORE_ART, { keyPath: 'key' });
      if (!database.objectStoreNames.contains(STORE_META)) database.createObjectStore(STORE_META, { keyPath: 'key' });
      // Added in schema 2. Playlists are files in the folder; this table is a
      // cache of what the scan found, exactly like the track table.
      if (!database.objectStoreNames.contains(STORE_PLAYLISTS)) {
        database.createObjectStore(STORE_PLAYLISTS, { keyPath: 'path' });
      }
      // Added in database version 3. A cache of computed loudness, keyed by
      // path, size and lastModified so an edited file is measured again.
      // Out-of-line keys: the value is exactly the measurement.
      if (!database.objectStoreNames.contains(STORE_LOUDNESS)) database.createObjectStore(STORE_LOUDNESS);
      // Version 3 also adds a rating index on the track table. Adding an index
      // to an existing store keeps every row; the upgrade transaction is the
      // only place an index can be created.
      const tracks = open.transaction.objectStore(STORE_TRACKS);
      if (!tracks.indexNames.contains('rating')) tracks.createIndex('rating', 'rating', { unique: false });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('Another NakliAmp tab is holding the library open.'));
  });
  return openPromise;
}

/** Drop the cached handle so a deleted database is reopened cleanly. */
export function resetLibraryHandle() {
  openPromise = null;
}

// ------------------------------------------------------------ keys ----

/** Fold a display string into a stable grouping key. */
export function groupKey(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim() || 'unknown';
}

/** An album is identified by its album artist and title together. */
export function albumKeyOf(record) {
  return `${groupKey(record.albumArtist || record.artist)}${KEY_SEPARATOR}${groupKey(record.album)}`;
}

/**
 * A track's id is derived from its path, so rescanning the same folder
 * reproduces the same ids and the index hash is reproducible.
 */
export async function trackId(path) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(path)));
  return [...new Uint8Array(digest).subarray(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------ validation ----

export class LibraryValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'LibraryValidationError';
    this.code = 'ERR_NAKLIAMP_LIBRARY_INVALID';
    this.field = field;
  }
}

const isFiniteOrNull = value => value === null || (typeof value === 'number' && Number.isFinite(value));
const isStringOrNull = value => value === null || typeof value === 'string';

/** True for an integer star rating 0..5. */
export function isRating(value) {
  return Number.isInteger(value) && value >= 0 && value <= 5;
}

const REPLAY_GAIN_FIELDS = Object.freeze(['trackGainDb', 'trackPeak', 'albumGainDb', 'albumPeak']);

/**
 * Normalise a ReplayGain record: null, or an object whose four fields are
 * finite numbers or null. A record with all four null collapses to null, so
 * "no ReplayGain" has one shape. Unknown keys are refused by name.
 */
export function validateReplayGain(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new LibraryValidationError('Field replayGain is not an object.', 'replayGain');
  }
  const unknown = Object.keys(value).filter(key => !REPLAY_GAIN_FIELDS.includes(key));
  if (unknown.length) throw new LibraryValidationError(`Not a ReplayGain field: ${unknown.join(', ')}`, 'replayGain');
  const out = {};
  for (const field of REPLAY_GAIN_FIELDS) {
    const number = value[field] ?? null;
    if (!isFiniteOrNull(number)) throw new LibraryValidationError(`ReplayGain ${field} is not a number.`, 'replayGain');
    out[field] = number;
  }
  return REPLAY_GAIN_FIELDS.every(field => out[field] === null) ? null : out;
}

/**
 * Normalise a cue-sheet span (P12): null, or `{ parentPath, startS, endS,
 * cuePath }` with `startS` at or after 0, `endS` after `startS` or null (to
 * the end of the file), and `cuePath` the sheet's path or null when the sheet
 * was embedded in the parent's tags.
 */
export function validateVirtual(value) {
  if (!isPresent(value)) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new LibraryValidationError('Field virtual is not an object.', 'virtual');
  }
  const { parentPath, startS, endS = null, cuePath = null } = value;
  if (!isNonEmptyString(parentPath)) throw new LibraryValidationError('Virtual track has no parent path.', 'virtual');
  if (!isNonNegativeTime(startS)) throw new LibraryValidationError('Virtual track start is not a time.', 'virtual');
  if (endS !== null && !isEndAfter(endS, startS)) {
    throw new LibraryValidationError('Virtual track end is not after its start.', 'virtual');
  }
  if (!isStringOrNull(cuePath)) throw new LibraryValidationError('Virtual track cue path is not text.', 'virtual');
  return { parentPath, startS, endS, cuePath };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isEndAfter(endS, startS) {
  return typeof endS === 'number' && Number.isFinite(endS) && endS > startS;
}

const TRACK_TEXT_FIELDS = Object.freeze(['title', 'artist', 'album', 'albumArtist', 'genre', 'container', 'name']);
const TRACK_NUMBER_FIELDS = Object.freeze(['trackNo', 'trackTotal', 'discNo', 'discTotal', 'year', 'durationS', 'sampleRate', 'channels']);

function isPresent(value) {
  return value !== undefined && value !== null;
}

/** Throw on a missing id, path or size: the fields every record must carry. */
function checkTrackIdentity(input) {
  if (!input || typeof input !== 'object') throw new LibraryValidationError('Track record is not an object.', null);
  if (typeof input.id !== 'string' || !input.id) throw new LibraryValidationError('Track id is missing.', 'id');
  if (typeof input.path !== 'string' || !input.path) throw new LibraryValidationError('Track path is missing.', 'path');
  if (!Number.isFinite(input.size) || input.size < 0) throw new LibraryValidationError('Track size is not a byte count.', 'size');
}

/** Throw on a text or number field of the wrong type. */
function checkTypedFields(input) {
  for (const field of TRACK_TEXT_FIELDS) {
    if (!isStringOrNull(input[field] ?? null)) throw new LibraryValidationError(`Field ${field} is not text.`, field);
  }
  for (const field of TRACK_NUMBER_FIELDS) {
    if (!isFiniteOrNull(input[field] ?? null)) throw new LibraryValidationError(`Field ${field} is not a number.`, field);
  }
}

/** Throw on a text, number, rating or version field of the wrong type. */
function checkTrackFields(input) {
  checkTypedFields(input);
  if (isPresent(input.rating) && !isRating(input.rating)) {
    throw new LibraryValidationError('Field rating is not a whole number from 0 to 5.', 'rating');
  }
  if (!isStringOrNull(input.dirArtKey ?? null)) throw new LibraryValidationError('Field dirArtKey is not text.', 'dirArtKey');
  if (isPresent(input.parserVersion) && !(Number.isInteger(input.parserVersion) && input.parserVersion >= 0)) {
    throw new LibraryValidationError('Field parserVersion is not a whole number.', 'parserVersion');
  }
}

function orNull(value) {
  return value ?? null;
}

function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

/** Copy the tag-derived fields, each defaulting to null. */
function tagFields(input) {
  return {
    container: orNull(input.container),
    title: orNull(input.title),
    artist: orNull(input.artist),
    album: orNull(input.album),
    albumArtist: orNull(input.albumArtist),
    trackNo: orNull(input.trackNo),
    trackTotal: orNull(input.trackTotal),
    discNo: orNull(input.discNo),
    discTotal: orNull(input.discTotal),
    year: orNull(input.year),
    genre: orNull(input.genre),
    durationS: orNull(input.durationS),
    sampleRate: orNull(input.sampleRate),
    channels: orNull(input.channels),
  };
}

/** Copy the playback-side fields, each with its default. */
function playbackFields(input) {
  return {
    hasLyrics: Boolean(input.hasLyrics),
    artKey: orNull(input.artKey),
    // D4: the index carries a resume position from its first version.
    resumePositionS: finiteOrZero(input.resumePositionS),
    playCount: finiteOrZero(input.playCount),
    lastPlayedAt: finiteOrZero(input.lastPlayedAt),
    // IndexedDB cannot index a boolean, so the flag is stored as 0 or 1.
    bookmarked: input.bookmarked ? 1 : 0,
    addedAt: finiteOrZero(input.addedAt),
    // Schema 2. Rating is playback-side state: it never enters the hash.
    rating: input.rating ?? 0,
  };
}

/**
 * Ingress validation: every record entering the index is checked and normalised.
 * Returns a new normalised record; throws LibraryValidationError on a bad one.
 */
export function validateTrack(input) {
  checkTrackIdentity(input);
  checkTrackFields(input);
  const replayGain = validateReplayGain(input.replayGain);
  const virtual = validateVirtual(input.virtual);

  const record = {
    schema: TRACK_SCHEMA,
    id: input.id,
    path: input.path,
    name: orNull(input.name),
    size: input.size,
    lastModified: finiteOrZero(input.lastModified),
    ...tagFields(input),
    ...playbackFields(input),
    replayGain,
    dirArtKey: orNull(input.dirArtKey),
    // 0 means "read by a parser older than versioning", so a rescan re-reads it.
    parserVersion: input.parserVersion ?? 0,
    // P12: a cue-sheet track is a span of its parent file; the parent image
    // a sheet replaced is flagged hidden (0 or 1, so it can be indexed).
    virtual,
    hidden: input.hidden ? 1 : 0,
  };
  record.albumKey = albumKeyOf(record);
  record.artistKey = groupKey(record.artist || record.albumArtist);
  return record;
}

// --------------------------------------------------------- writing ----

export async function putTracks(records) {
  if (!records.length) return 0;
  const validated = records.map(validateTrack);
  const database = await openLibrary();
  const transaction = database.transaction(STORE_TRACKS, 'readwrite');
  const store = transaction.objectStore(STORE_TRACKS);
  for (const record of validated) store.put(record);
  await finish(transaction);
  return validated.length;
}

export async function deleteTracks(ids) {
  if (!ids.length) return 0;
  const database = await openLibrary();
  const transaction = database.transaction(STORE_TRACKS, 'readwrite');
  const store = transaction.objectStore(STORE_TRACKS);
  for (const id of ids) store.delete(id);
  await finish(transaction);
  return ids.length;
}

/**
 * Apply a partial update to one track's mutable playback fields.
 * Identity fields are refused here so playback can never perturb the index hash.
 */
export async function updateTrackState(id, patch) {
  const unknown = Object.keys(patch).filter(key => !MUTABLE_FIELDS.includes(key));
  if (unknown.length) throw new LibraryValidationError(`Not a mutable field: ${unknown.join(', ')}`, unknown[0]);
  const database = await openLibrary();
  const transaction = database.transaction(STORE_TRACKS, 'readwrite');
  const store = transaction.objectStore(STORE_TRACKS);
  const existing = await request(store.get(id));
  if (!existing) { transaction.abort(); return null; }
  const next = validateTrack({ ...existing, ...patch });
  store.put(next);
  await finish(transaction);
  return next;
}

/** Set a track's star rating, 0..5. Returns the updated record or null. */
export async function setRating(id, rating) {
  if (!isRating(rating)) throw new LibraryValidationError('A rating is a whole number from 0 to 5.', 'rating');
  return updateTrackState(id, { rating });
}

/** Mark or unmark a track as a favourite (stored as `bookmarked` 0 or 1). */
export async function setFavourite(id, favourite) {
  if (typeof favourite !== 'boolean') throw new LibraryValidationError('Favourite is true or false.', 'bookmarked');
  return updateTrackState(id, { bookmarked: favourite ? 1 : 0 });
}

export async function clearLibrary() {
  const database = await openLibrary();
  const stores = [STORE_TRACKS, STORE_ART, STORE_META, STORE_PLAYLISTS, STORE_LOUDNESS];
  const transaction = database.transaction(stores, 'readwrite');
  for (const store of stores) transaction.objectStore(store).clear();
  await finish(transaction);
}

// ------------------------------------------------------- playlists ----

export async function putPlaylists(playlists) {
  const database = await openLibrary();
  const transaction = database.transaction(STORE_PLAYLISTS, 'readwrite');
  const store = transaction.objectStore(STORE_PLAYLISTS);
  for (const playlist of playlists) store.put(playlist);
  await finish(transaction);
  return playlists.length;
}

export async function allPlaylists() {
  const database = await openLibrary();
  const rows = await request(
    database.transaction(STORE_PLAYLISTS, 'readonly').objectStore(STORE_PLAYLISTS).getAll(),
  );
  return rows.sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

export async function deletePlaylists(paths) {
  if (!paths.length) return 0;
  const database = await openLibrary();
  const transaction = database.transaction(STORE_PLAYLISTS, 'readwrite');
  const store = transaction.objectStore(STORE_PLAYLISTS);
  for (const path of paths) store.delete(path);
  await finish(transaction);
  return paths.length;
}

// --------------------------------------------------------- reading ----

export async function allTracks() {
  const database = await openLibrary();
  return request(database.transaction(STORE_TRACKS, 'readonly').objectStore(STORE_TRACKS).getAll());
}

export async function trackCount() {
  const database = await openLibrary();
  return request(database.transaction(STORE_TRACKS, 'readonly').objectStore(STORE_TRACKS).count());
}

export async function getTrack(id) {
  const database = await openLibrary();
  return (await request(database.transaction(STORE_TRACKS, 'readonly').objectStore(STORE_TRACKS).get(id))) ?? null;
}

export async function tracksByIndex(indexName, key) {
  const database = await openLibrary();
  const index = database.transaction(STORE_TRACKS, 'readonly').objectStore(STORE_TRACKS).index(indexName);
  return request(index.getAll(key));
}

/** Sort within an album: disc, then track number, then title. */
export function compareAlbumOrder(left, right) {
  return (left.discNo ?? 1) - (right.discNo ?? 1)
    || (left.trackNo ?? 1e9) - (right.trackNo ?? 1e9)
    || String(left.title ?? left.name ?? '').localeCompare(String(right.title ?? right.name ?? ''));
}

/** Fold the track table into album rows for the album view. */
export function groupAlbums(tracks) {
  const albums = new Map();
  for (const track of tracks) {
    let album = albums.get(track.albumKey);
    if (!album) {
      album = {
        key: track.albumKey,
        album: track.album,
        albumArtist: track.albumArtist || track.artist,
        year: track.year,
        artKey: track.artKey ?? track.dirArtKey ?? null,
        trackCount: 0,
        durationS: 0,
      };
      albums.set(track.albumKey, album);
    }
    album.trackCount += 1;
    album.durationS += track.durationS ?? 0;
    album.artKey ??= track.artKey ?? track.dirArtKey ?? null;
    album.year ??= track.year;
  }
  return [...albums.values()].sort((left, right) =>
    String(left.albumArtist ?? '').localeCompare(String(right.albumArtist ?? ''))
    || (left.year ?? 0) - (right.year ?? 0)
    || String(left.album ?? '').localeCompare(String(right.album ?? '')));
}

/** Fold the track table into artist rows for the artist view. */
export function groupArtists(tracks) {
  const artists = new Map();
  for (const track of tracks) {
    let artist = artists.get(track.artistKey);
    if (!artist) {
      artist = { key: track.artistKey, artist: track.artist || track.albumArtist, trackCount: 0, albums: new Set() };
      artists.set(track.artistKey, artist);
    }
    artist.trackCount += 1;
    artist.albums.add(track.albumKey);
  }
  return [...artists.values()]
    .map(artist => ({ ...artist, albumCount: artist.albums.size, albums: undefined }))
    .sort((left, right) => String(left.artist ?? '').localeCompare(String(right.artist ?? '')));
}

// ------------------------------------------------------------- art ----

/**
 * Store art under `key`. `stamp` is optional change-detection text (folder art
 * uses `size:lastModified`), so a rescan can skip re-reading an unchanged image.
 */
export async function putArt(key, blob, stamp = null) {
  const database = await openLibrary();
  const transaction = database.transaction(STORE_ART, 'readwrite');
  transaction.objectStore(STORE_ART).put(stamp === null ? { key, blob } : { key, blob, stamp });
  await finish(transaction);
  return key;
}

/** The stamp stored with `key`'s art, or null. */
export async function getArtStamp(key) {
  if (!key) return null;
  const database = await openLibrary();
  const record = await request(database.transaction(STORE_ART, 'readonly').objectStore(STORE_ART).get(key));
  return record?.stamp ?? null;
}

export async function getArt(key) {
  if (!key) return null;
  const database = await openLibrary();
  const record = await request(database.transaction(STORE_ART, 'readonly').objectStore(STORE_ART).get(key));
  return record?.blob ?? null;
}

/** Remove art no live track still points at. */
export async function pruneArt() {
  const tracks = await allTracks();
  // Folder art is shared by every track in its directory, so it is live while
  // any track still points at it.
  const live = new Set(tracks.flatMap(track => [track.artKey, track.dirArtKey]).filter(Boolean));
  const database = await openLibrary();
  const transaction = database.transaction(STORE_ART, 'readwrite');
  const store = transaction.objectStore(STORE_ART);
  const keys = await request(store.getAllKeys());
  let removed = 0;
  for (const key of keys) {
    if (!live.has(key)) { store.delete(key); removed += 1; }
  }
  await finish(transaction);
  return removed;
}

// ------------------------------------------------------------ meta ----

export async function setMeta(key, value) {
  const database = await openLibrary();
  const transaction = database.transaction(STORE_META, 'readwrite');
  transaction.objectStore(STORE_META).put({ key, value });
  await finish(transaction);
  return value;
}

export async function getMeta(key, fallback = null) {
  const database = await openLibrary();
  const record = await request(database.transaction(STORE_META, 'readonly').objectStore(STORE_META).get(key));
  return record === undefined ? fallback : record.value;
}

// -------------------------------------------------- smart playlists ----

const SMART_META_KEY = 'smartPlaylists';

/**
 * The smart-playlist rules the last scan found, as `{ path, rule }` rows.
 * Kept in the meta table rather than the playlists table, because everything
 * that reads the playlists table expects entries and writes M3U8 back.
 */
export async function allSmartPlaylists() {
  return (await getMeta(SMART_META_KEY, [])) ?? [];
}

export async function putSmartPlaylists(rows) {
  return setMeta(SMART_META_KEY, rows);
}

// -------------------------------------------------------- loudness ----

/** The loudness cache key: a changed file (size or time) is measured again. */
export function loudnessKey(track) {
  if (!track || typeof track.path !== 'string' || !track.path) {
    throw new LibraryValidationError('A loudness key needs a track path.', 'path');
  }
  return `${track.path}${KEY_SEPARATOR}${Number(track.size) || 0}${KEY_SEPARATOR}${Number(track.lastModified) || 0}`;
}

/** Validate a loudness measurement `{ integratedLufs, truePeak, gainDb, computedAt }`. */
export function validateLoudness(value) {
  if (!value || typeof value !== 'object') throw new LibraryValidationError('Loudness is not an object.', 'loudness');
  const fields = ['integratedLufs', 'truePeak', 'gainDb', 'computedAt'];
  const unknown = Object.keys(value).filter(key => !fields.includes(key));
  if (unknown.length) throw new LibraryValidationError(`Not a loudness field: ${unknown.join(', ')}`, 'loudness');
  for (const field of ['integratedLufs', 'truePeak', 'gainDb']) {
    if (!isFiniteOrNull(value[field] ?? null)) throw new LibraryValidationError(`Loudness ${field} is not a number.`, field);
  }
  return {
    integratedLufs: value.integratedLufs ?? null,
    truePeak: value.truePeak ?? null,
    gainDb: value.gainDb ?? null,
    computedAt: Number.isFinite(value.computedAt) ? value.computedAt : Date.now(),
  };
}

export async function getLoudness(key) {
  const database = await openLibrary();
  return (await request(database.transaction(STORE_LOUDNESS, 'readonly').objectStore(STORE_LOUDNESS).get(key))) ?? null;
}

export async function putLoudness(key, value) {
  if (typeof key !== 'string' || !key) throw new LibraryValidationError('Loudness key is missing.', 'key');
  const record = validateLoudness(value);
  const database = await openLibrary();
  const transaction = database.transaction(STORE_LOUDNESS, 'readwrite');
  transaction.objectStore(STORE_LOUDNESS).put(record, key);
  await finish(transaction);
  return record;
}

// ------------------------------------------------------ index hash ----

/**
 * A deterministic hash over the index's identity fields.
 * The M1 gate rescans the same folder and requires the same hash, which proves
 * scanning is reproducible and that playback state never leaks into identity.
 */
export async function indexHash(tracks) {
  const rows = [...tracks]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map(track => IDENTITY_FIELDS.map(field => {
      const value = track[field];
      return value === null || value === undefined ? '' : String(value);
    }).join(FIELD_SEPARATOR));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rows.join(ROW_SEPARATOR)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export { IDENTITY_FIELDS, MUTABLE_FIELDS };
